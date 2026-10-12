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

// Raw WinCred operations seed/check disposable records independently of the production lifecycle.
export function referenceScript() {
  const declarations = WINDOWS_SCRIPT.slice(0, WINDOWS_SCRIPT.indexOf('  sealed class Stored {'))
    .replace('public static class ConfluenceWinCred', 'public static class AcceptanceWinCred');
  return declarations + String.raw`
  public static string Service;
  public static string[] Users, Records;
  static string Target(int slot) {
    if (slot != 0 && slot != 1) throw new InvalidOperationException();
    return slot == 0 ? Service : Account + "@" + Service;
  }
  public static string[] Check(int slot) {
    IntPtr pointer;
    if (!Read(Target(slot), 1, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return null;
      throw new Win32Exception(error);
    }
    try {
      Credential value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (value.Type != 1 || value.TargetName != Target(slot) || value.CredentialBlobSize > 2560)
        throw new InvalidOperationException("SCOPE_OCCUPIED");
      byte[] bytes = new byte[value.CredentialBlobSize];
      try {
        Marshal.Copy(value.CredentialBlob, bytes, 0, bytes.Length);
        string encoded = Convert.ToBase64String(bytes);
        if (Array.IndexOf(Users, value.UserName) < 0 || Array.IndexOf(Records, encoded) < 0)
          throw new InvalidOperationException("SCOPE_OCCUPIED");
        return new string[] { value.UserName, encoded };
      } finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { Free(pointer); }
  }
  public static void Seed(int slot, string user, string record) {
    Check(0); Check(1);
    if (Array.IndexOf(Users, user) < 0 || Array.IndexOf(Records, record) < 0) throw new InvalidOperationException();
    WriteBlob(slot, user, record);
  }
  static void WriteBlob(int slot, string user, string record) {
    byte[] bytes = Convert.FromBase64String(record);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      Credential value = new Credential { Type = 1, TargetName = Target(slot), UserName = user,
        CredentialBlob = blob, CredentialBlobSize = (uint)bytes.Length, Persist = 3 };
      if (!Write(ref value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
      Marshal.FreeHGlobal(blob); Array.Clear(bytes, 0, bytes.Length);
    }
  }
  public static void Cleanup(int slot) {
    if (Check(slot) != null && !Delete(Target(slot), 1, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (Check(slot) != null) throw new InvalidOperationException("CLEANUP_INCOMPLETE");
  }
  public static bool NativeFailure() {
    string[] before = Check(0);
    if (before == null || before[0] != Account) throw new InvalidOperationException("MISSING_FIXTURE");
    bool failed = false;
    try { WriteBlob(0, Account, Convert.ToBase64String(Encoding.Unicode.GetBytes(new string('x', 3000)))); }
    catch (Win32Exception) { failed = true; }
    string[] after = Check(0);
    if (after == null || after[0] != before[0] || after[1] != before[1])
      throw new InvalidOperationException("FAILED_SAVE_CHANGED_RECORD");
    if (!failed) throw new InvalidOperationException("INVALID_WRITE_SUCCEEDED");
    return true;
  }
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ([string]$request.service -cnotmatch '^confluence-mcp:[0-9a-f]{64}$') { throw 'INVALID_SCOPE' }
[AcceptanceWinCred]::Service = [string]$request.service
[AcceptanceWinCred]::Users = [string[]]$request.users
[AcceptanceWinCred]::Records = [string[]]$request.records
$a = [AcceptanceWinCred]::Check(0)
$b = [AcceptanceWinCred]::Check(1)
switch ([string]$request.mode) {
  'empty' { if ($null -ne $a -or $null -ne $b) { throw 'SCOPE_OCCUPIED' } }
  'seed' { [AcceptanceWinCred]::Seed([int]$request.slot, [string]$request.user, [string]$request.record) }
  'slot' {
    $actual = [AcceptanceWinCred]::Check([int]$request.slot)
    if ($null -eq $request.record) { if ($null -ne $actual) { throw 'SLOT_NOT_EMPTY' } }
    elseif ($null -eq $actual -or $actual[0] -cne $request.user -or $actual[1] -cne $request.record) { throw 'SLOT_MISMATCH' }
  }
  'native_failure' { [void][AcceptanceWinCred]::NativeFailure() }
  'cleanup' { [AcceptanceWinCred]::Cleanup(0); [AcceptanceWinCred]::Cleanup(1) }
  default { throw 'INVALID_MODE' }
}
[Console]::Out.Write('{"ok":true}')
exit 0
} catch {
  $message = $_.Exception.GetBaseException().Message
  $code = if ($message -cin @('SCOPE_OCCUPIED', 'SLOT_NOT_EMPTY', 'SLOT_MISMATCH', 'INVALID_SCOPE', 'INVALID_MODE')) { $message } else { 'REFERENCE_FAILED' }
  [Console]::Out.Write((ConvertTo-Json -InputObject @{ok = $false; code = $code} -Compress))
  exit 1
}
`;
}
