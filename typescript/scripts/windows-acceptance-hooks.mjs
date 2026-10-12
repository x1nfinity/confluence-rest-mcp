import { WINDOWS_SCRIPT } from '../dist/windows-credentials.js';

// Deterministic faults around real WinCred calls; the production Run lifecycle stays intact.
const hooks = String.raw`
  public static string TestService, Fault, Trigger, RaceTarget, RaceUser, RaceRecord;
  public static int HookHits;
  [DllImport("kernel32.dll", EntryPoint = "SetLastError", ExactSpelling = true, SetLastError = true)]
  static extern void SetError(uint error);
  static void Gate(string target) {
    if (target != TestService && target != Account + "@" + TestService) throw new InvalidOperationException();
  }
  static void Change(string operation, string target) {
    if (operation != Fault || target != Trigger) return;
    Fault = null; HookHits++; Gate(RaceTarget);
    byte[] bytes = Convert.FromBase64String(RaceRecord);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      Credential value = new Credential { Type = 1, TargetName = RaceTarget, UserName = RaceUser,
        CredentialBlob = blob, CredentialBlobSize = (uint)bytes.Length, Persist = 3 };
      if (!NativeWrite(ref value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0); Marshal.FreeHGlobal(blob); Array.Clear(bytes, 0, bytes.Length); }
  }
  static bool Read(string target, uint type, uint flags, out IntPtr value) {
    Gate(target); bool result = NativeRead(target, type, flags, out value);
    if (result) {
      try { Change("race-read", target); }
      catch { Free(value); value = IntPtr.Zero; throw; }
    }
    return result;
  }
  static bool Write(ref Credential value, uint flags) {
    Gate(value.TargetName);
    if (Fault == "fail-write" && value.TargetName == Trigger) { HookHits++; SetError(5); return false; }
    return NativeWrite(ref value, flags);
  }
  static bool Delete(string target, uint type, uint flags) {
    Gate(target);
    if (Fault == "fail-delete" && target == Trigger) { HookHits++; SetError(5); return false; }
    bool result = NativeDelete(target, type, flags);
    if (result) Change("race-delete", target);
    return result;
  }
`;

export function hookScript() {
  let script = WINDOWS_SCRIPT;
  for (const name of ['Read', 'Write', 'Delete']) {
    const marker = 'static extern bool ' + name + '(';
    if (script.split(marker).length !== 2) throw new Error('HOOK_SOURCE_CHANGED');
    script = script.replace(marker, 'static extern bool Native' + name + '(');
  }
  if (script.split('  sealed class Stored {').length !== 2) throw new Error('HOOK_SOURCE_CHANGED');
  script = script.replace('  sealed class Stored {', hooks + '\n  sealed class Stored {');
  return script.slice(0, script.indexOf('$request =')) + String.raw`
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
[ConfluenceWinCred]::TestService = [string]$request.service
[ConfluenceWinCred]::Fault = [string]$request.fault
[ConfluenceWinCred]::Trigger = [string]$request.trigger
[ConfluenceWinCred]::RaceTarget = [string]$request.race_target
[ConfluenceWinCred]::RaceUser = [string]$request.race_user
[ConfluenceWinCred]::RaceRecord = [string]$request.race_record
try {
  $result = [ConfluenceWinCred]::Run([string]$request.action, [string]$request.service, [string]$request.record)
  [Console]::Out.Write((ConvertTo-Json -InputObject @{ ok = $true; value = $result; hits = [ConfluenceWinCred]::HookHits } -Compress))
} catch {
  [Console]::Out.Write((ConvertTo-Json -InputObject @{ ok = $false; hits = [ConfluenceWinCred]::HookHits } -Compress))
}
exit 0
} catch { exit 1 }
`;
}

export const LOCK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  if ([string]$request.service -notmatch '^confluence-mcp:[0-9a-f]{64}$') { exit 1 }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try { $name = 'Global\ConfluenceMCP-' + $identity.User.Value + '-' + $request.service.Substring(15) }
  finally { $identity.Dispose() }
  $mutex = New-Object Threading.Mutex($false, $name)
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { exit 1 }
    [Console]::Out.WriteLine('{"locked":true}')
    [Console]::Out.Flush()
    [void][Console]::In.ReadLine()
  } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
  exit 0
} catch { exit 1 }
`;
