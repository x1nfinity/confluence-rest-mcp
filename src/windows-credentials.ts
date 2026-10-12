import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { ReadError } from './errors.js';
import type { CredentialStore } from './auth.js';

export const ACCOUNT = 'confluence-credentials';
type Action = 'read' | 'write' | 'delete';
type Request = { action: Action; service: string; record?: string };
type Runner = (request: Request, signal?: AbortSignal) => Promise<unknown>;

// Only code is encoded in argv. Credential JSON travels through private stdin as UTF-16LE base64.
export const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
public static class ConfluenceWinCred {
  const string Account = "confluence-credentials";
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool Read(string target, uint type, uint flags, out IntPtr value);
  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool Write(ref Credential value, uint flags);
  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool Delete(string target, uint type, uint flags);
  [DllImport("Advapi32.dll", EntryPoint = "CredFree", ExactSpelling = true)]
  static extern void Free(IntPtr value);
  sealed class Stored {
    public string UserName;
    public byte[] Blob;
    public ulong Written;
    public uint Size;
    public string Fingerprint;
  }
  static Stored ReadTarget(string target, bool includeBlob) {
    IntPtr pointer;
    if (!Read(target, 1, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return null;
      throw new Win32Exception(error);
    }
    try {
      Credential value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (value.Type != 1 || !String.Equals(value.TargetName, target, StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException();
      Stored stored = new Stored { UserName = value.UserName, Size = value.CredentialBlobSize,
        Written = ((ulong)(uint)value.LastWritten.dwHighDateTime << 32) | (uint)value.LastWritten.dwLowDateTime };
      if (value.UserName != Account) return stored;
      if (value.CredentialBlobSize > 2560) throw new InvalidOperationException();
      // The blob belongs to CredRead's allocation, so copy it before CredFree.
      byte[] bytes = new byte[value.CredentialBlobSize];
      if (bytes.Length != 0) Marshal.Copy(value.CredentialBlob, bytes, 0, bytes.Length);
      try {
        // LastWritten and size are not unique versions; compare the owned secret as well.
        using (System.Security.Cryptography.SHA256 hash = System.Security.Cryptography.SHA256.Create())
          stored.Fingerprint = Convert.ToBase64String(hash.ComputeHash(bytes));
        if (includeBlob) stored.Blob = bytes;
        return stored;
      } finally { if (!includeBlob) Array.Clear(bytes, 0, bytes.Length); }
    } finally { Free(pointer); }
  }
  static bool Owned(Stored value) { return value != null && value.UserName == Account; }
  static bool Unchanged(Stored before, Stored current) {
    return before == null ? current == null : current != null && before.UserName == current.UserName
      && before.Written == current.Written && before.Size == current.Size && before.Fingerprint == current.Fingerprint;
  }
  static string CurrentSid() {
    using (System.Security.Principal.WindowsIdentity identity = System.Security.Principal.WindowsIdentity.GetCurrent())
      return identity.User.Value;
  }
  static string Record(Stored value) {
    byte[] bytes = value.Blob;
    try {
      string text;
      try { text = new UnicodeEncoding(bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF, false, true).GetString(bytes); }
      catch (DecoderFallbackException) { text = new UTF8Encoding(false, true).GetString(bytes); }
      if (text.Length > 0 && text[0] == '\uFEFF') text = text.Substring(1);
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(text));
    } finally { Array.Clear(bytes, 0, bytes.Length); }
  }
  public static object Run(string action, string service, string record) {
    if (!Regex.IsMatch(service ?? "", "\\Aconfluence-mcp:[0-9a-f]{64}\\z")
        || (action != "read" && action != "write" && action != "delete")) throw new InvalidOperationException();
    byte[] bytes = action == "write" ? Convert.FromBase64String(record ?? "") : null;
    if (bytes != null && (bytes.Length == 0 || bytes.Length > 2560 || bytes.Length % 2 != 0))
      throw new InvalidOperationException();
    using (Mutex mutex = new Mutex(false, "Global\\ConfluenceMCP-" + CurrentSid() + "-" + service.Substring(15))) {
      bool locked = false;
      try {
        try { locked = mutex.WaitOne(30000); } catch (AbandonedMutexException) { locked = true; }
        if (!locked) throw new InvalidOperationException();
        Stored primary = ReadTarget(service, action == "read");
        string compound = Account + "@" + service;
        if (action == "read" && Owned(primary)) return Record(primary);
        Stored fallback = ReadTarget(compound, action == "read");
        if (action == "read") return Owned(fallback) ? Record(fallback) : null;
        if (action == "write") {
          // Keep foreign records and update an existing collision slot without moving old secrets.
          string target = primary != null && !Owned(primary) ? compound
            : primary == null && Owned(fallback) ? compound : service;
          if (target == compound && fallback != null && !Owned(fallback)) throw new InvalidOperationException();
          if (!Unchanged(primary, ReadTarget(service, false)) || !Unchanged(fallback, ReadTarget(compound, false)))
            throw new InvalidOperationException();
          IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
          try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            Credential value = new Credential { Type = 1, TargetName = target, UserName = Account,
              Comment = "Stored using python-keyring", CredentialBlob = blob,
              CredentialBlobSize = (uint)bytes.Length, Persist = 3 };
            // One replacement call; no empty placeholder, delete-before-save or failure rollback.
            if (!Write(ref value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
          } finally {
            for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
            Marshal.FreeHGlobal(blob);
          }
          return "saved";
        }
        // Remove the stale fallback first: a later primary failure leaves the active identity intact.
        foreach (string target in new string[] { compound, service }) {
          Stored value = target == service ? primary : fallback;
          if (!Owned(value)) continue;
          Stored current = ReadTarget(target, false);
          if (current == null) continue;
          if (!Unchanged(value, current)) throw new InvalidOperationException();
          // shortcut: WinCred has no conditional delete; coordinate external Python/UI changes.
          if (!Delete(target, 1, 0)) {
            int error = Marshal.GetLastWin32Error();
            if (error != 1168) throw new Win32Exception(error);
          }
        }
        if (Owned(ReadTarget(service, false)) || Owned(ReadTarget(compound, false)))
          throw new InvalidOperationException();
        return Owned(primary) || Owned(fallback);
      } finally {
        if (locked) mutex.ReleaseMutex();
        if (bytes != null) Array.Clear(bytes, 0, bytes.Length);
      }
    }
  }
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = [ConfluenceWinCred]::Run([string]$request.action, [string]$request.service, [string]$request.record)
[Console]::Out.Write((ConvertTo-Json -InputObject @{ value = $result } -Compress))
exit 0
} catch { exit 1 }
`;

export function windowsRequest(request: Request, signal?: AbortSignal, launch = spawn): Promise<unknown> {
  const root = process.env.SystemRoot;
  if (process.platform !== 'win32' || !root || !/^[a-z]:\\/iu.test(root))
    return Promise.reject(new ReadError('CREDENTIAL_BACKEND_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const child = launch(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 45000, killSignal: 'SIGKILL', signal });
    let output = '', failed = false;
    const fail = () => { if (!failed) { failed = true; reject(new ReadError('CREDENTIAL_FAILED')); child.kill('SIGKILL'); } };
    child.once('error', fail); child.stdin.once('error', fail);
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (Buffer.byteLength(output) > 8192) fail(); });
    child.once('close', status => {
      if (failed) return;
      if (status !== 0) { fail(); return; }
      try {
        const parsed = JSON.parse(output);
        if (!parsed || Object.keys(parsed).join(',') !== 'value') throw new Error();
        resolve(parsed.value);
      } catch { fail(); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function windowsStore(service: string, run: Runner = windowsRequest): CredentialStore {
  if (!/^confluence-mcp:[0-9a-f]{64}$/u.test(service)) throw new ReadError('CREDENTIAL_FAILED');
  return {
    async getPassword(signal) {
      const value = await run({ action: 'read', service }, signal);
      if (value === null) return null;
      if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
        throw new ReadError('CREDENTIAL_FAILED');
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64'));
    },
    async setPassword(record) {
      if (typeof record !== 'string' || Buffer.byteLength(record, 'utf16le') > 2560 || !record)
        throw new ReadError('CREDENTIAL_INVALID');
      if (await run({ action: 'write', service, record: Buffer.from(record, 'utf16le').toString('base64') }) !== 'saved')
        throw new ReadError('CREDENTIAL_FAILED');
    },
    async deletePassword() {
      const value = await run({ action: 'delete', service });
      if (typeof value !== 'boolean') throw new ReadError('CREDENTIAL_FAILED');
      return value;
    },
  };
}
