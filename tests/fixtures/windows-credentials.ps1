# Executes the production C# against an in-memory ABI library, with synthetic records only.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class FakeCred {
  [DllImport("Advapi32.dll", EntryPoint="FakeReset")] public static extern void Reset();
  [DllImport("Advapi32.dll", EntryPoint="FakeSeed", CharSet=CharSet.Unicode)]
  public static extern void Seed(string target, string user, byte[] blob, uint size);
  [DllImport("Advapi32.dll", EntryPoint="FakeFail", CharSet=CharSet.Unicode)]
  public static extern void Fail(int action, string target, int code);
  [DllImport("Advapi32.dll", EntryPoint="FakeRace", CharSet=CharSet.Unicode)]
  public static extern void Race(int action, string trigger, string target, string user, byte[] blob, uint size);
  [DllImport("Advapi32.dll", EntryPoint="FakeRaceAfter")] public static extern void RaceAfter(int ordinal);
  [DllImport("Advapi32.dll", EntryPoint="FakeSameStamp")] public static extern void SameStamp();
  public static void RemoveRace(string target, int ordinal) {
    Race((int)'r', target, target, null, new byte[0], 0);
    RaceAfter(ordinal);
  }
  [DllImport("Advapi32.dll", EntryPoint="FakeWrites")] public static extern int Writes();
  [DllImport("Advapi32.dll", EntryPoint="FakeReads")] public static extern int Reads();
  [DllImport("Advapi32.dll", EntryPoint="FakeDeletes")] public static extern int Deletes();
  [DllImport("Advapi32.dll", EntryPoint="FakeAllocations")] public static extern int Allocations();
  [DllImport("Advapi32.dll", EntryPoint="FakeSize", CharSet=CharSet.Unicode)] public static extern int Size(string target);
  [DllImport("Advapi32.dll", EntryPoint="FakeBlob", CharSet=CharSet.Unicode)] public static extern void Blob(string target, byte[] output);
  public static string Dump(string target) {
    byte[] bytes = new byte[Size(target)]; Blob(target, bytes); return Convert.ToBase64String(bytes);
  }
  public static void Bind(System.Reflection.Assembly assembly, string library) {
    IntPtr handle = NativeLibrary.Load(library);
    NativeLibrary.SetDllImportResolver(assembly, (name, source, path) => handle);
  }
  public static void Probe(Type api, string service, string record, string heldName, bool blocked) {
    using (Mutex held = new Mutex(false, heldName))
    using (ManualResetEvent started = new ManualResetEvent(false))
    using (ManualResetEvent done = new ManualResetEvent(false)) {
      Exception error = null;
      held.WaitOne();
      Thread worker = new Thread(() => {
        started.Set();
        try { api.GetMethod("Run").Invoke(null, new object[] { "write", service, record }); }
        catch (Exception e) { error = e; }
        finally { done.Set(); }
      });
      worker.IsBackground = true;
      worker.Start();
      bool correct;
      try {
        if (!started.WaitOne(5000)) throw new Exception("worker start deadline");
        correct = blocked ? !done.WaitOne(150) && Reads() == 0 && Writes() == 0 : done.WaitOne(5000);
      } finally { held.ReleaseMutex(); }
      if (!done.WaitOne(5000) || !correct || error != null) throw new Exception("mutex probe failed");
      worker.Join();
    }
  }
  public static Mutex Abandon(string name) {
    Mutex held = null;
    Thread owner = new Thread(() => { held = new Mutex(false, name); held.WaitOne(); });
    owner.Start(); owner.Join();
    return held;
  }
}
'@
[FakeCred]::Bind([ConfluenceWinCred].Assembly, $env:CONFLUENCE_TEST_NATIVE)
[FakeCred]::Bind([FakeCred].Assembly, $env:CONFLUENCE_TEST_NATIVE)
$site = 'confluence-mcp:' + ('a' * 64)
$compound = 'confluence-credentials@' + $site
$account = 'confluence-credentials'
$raw = '{"username":"测试😀","password":"合成\\\"😀"}'
$updated = '{"username":"测试😀","password":"更新合成😀"}'
function Check($condition, $label) { if (-not $condition) { throw "failed: $label" } }
function Seed($target, $user, $record, $encoding = [Text.Encoding]::Unicode) {
  $bytes = $encoding.GetBytes($record)
  [FakeCred]::Seed($target, $user, $bytes, $bytes.Length)
}
function Read-Record {
  $result = [ConfluenceWinCred]::Run('read', $site, '')
  if ($null -eq $result) { return $null }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($result))
}
function Write-Record($record = $updated) {
  return [ConfluenceWinCred]::Run('write', $site, [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($record)))
}
function Fails($block, $label) {
  $failed = $false
  try { & $block | Out-Null } catch { $failed = $true }
  Check $failed $label
}
function Race($action, $trigger, $target, $user, $record) {
  $bytes = [Text.Encoding]::Unicode.GetBytes($record)
  [FakeCred]::Race([int][char]$action, $trigger, $target, $user, $bytes, $bytes.Length)
}

[FakeCred]::Reset()
Seed $site $account $raw
Race 'r' $site $site 'foreign' 'synthetic-concurrent-foreign'
Fails { Write-Record } 'changed primary owner must stop save'
Check ([FakeCred]::Writes() -eq 0) 'no overwrite of concurrent foreign primary'

[FakeCred]::Reset()
Seed $site 'foreign' 'synthetic-foreign'
Seed $compound $account $raw
Race 'r' $compound $site $account $updated
Fails { Write-Record } 'primary change must stop collision save'
Check ([FakeCred]::Writes() -eq 0) 'collision save observes both snapshots'

[FakeCred]::Reset()
Seed $site $account $raw
Race 'r' $site $site $account $updated
Fails { Write-Record } 'same-account concurrent update must stop save'
Check ((Read-Record) -ceq $updated) 'new same-account record survives rejected save'

[FakeCred]::Reset()
Seed $site $account $raw
[FakeCred]::SameStamp()
$sameSizeRaw = $raw.Replace('合成', '更新')
Race 'r' $site $site $account $sameSizeRaw
Fails { Write-Record } 'same timestamp and size must still stop save'
Check ((Read-Record) -ceq $sameSizeRaw) 'new equal-metadata secret preserved'

[FakeCred]::Reset()
Seed $site $account $raw
Seed $compound $account $raw
[FakeCred]::SameStamp()
Race 'd' $compound $site $account $sameSizeRaw
Fails { [ConfluenceWinCred]::Run('delete', $site, '') } 'same timestamp and size must still stop deletion'
Check ((Read-Record) -ceq $sameSizeRaw) 'equal-metadata replacement survives delete'

[FakeCred]::Reset()
Seed $site $account $raw
Seed $compound $account $raw
Race 'd' $compound $site 'foreign' 'synthetic-concurrent-foreign'
Fails { [ConfluenceWinCred]::Run('delete', $site, '') } 'changed primary owner must stop deletion'
Check ([FakeCred]::Deletes() -eq 1) 'foreign primary not deleted'

[FakeCred]::Reset()
Seed $site $account $raw
Seed $compound $account $raw
Race 'd' $compound $site $account $updated
Fails { [ConfluenceWinCred]::Run('delete', $site, '') } 'same-account replacement survives deletion'
Check ([FakeCred]::Deletes() -eq 1) 'new primary not deleted'
Check ((Read-Record) -ceq $updated) 'new primary identity preserved'

[FakeCred]::Reset()
Seed $site $account $raw
Race 'd' $site $compound $account $updated
Fails { [ConfluenceWinCred]::Run('delete', $site, '') } 'concurrent new fallback prevents false logout success'
Check ((Read-Record) -ceq $updated) 'new fallback survives logout'

[FakeCred]::Reset()
Seed $site $account $raw
[FakeCred]::RemoveRace($site, 1)
Check ([ConfluenceWinCred]::Run('delete', $site, '')) 'missing after snapshot is safe'
Check ([FakeCred]::Deletes() -eq 0) 'skip already missing record'
[FakeCred]::Reset()
Seed $site $account $raw
[FakeCred]::RemoveRace($site, 2)
Check ([ConfluenceWinCred]::Run('delete', $site, '')) 'not-found during delete is safe'
Check ([FakeCred]::Deletes() -eq 1) 'not-found delete is not retried'
Check ($null -eq (Read-Record)) 'not-found final state checked'

[FakeCred]::Reset()
Seed $site $account $raw
Seed $compound 'foreign' 'synthetic-foreign'
Check ([ConfluenceWinCred]::Run('delete', $site, '')) 'foreign fallback remains intact'
Check ([FakeCred]::Deletes() -eq 1) 'only own primary deleted'
Check ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([FakeCred]::Dump($compound))) -ceq 'synthetic-foreign') 'foreign fallback blob unchanged'

[FakeCred]::Reset()
Seed $compound $account $raw
[FakeCred]::Fail([int][char]'w', $compound, 5)
Fails { Write-Record } 'collision save denial'
Check ((Read-Record) -ceq $raw) 'failed collision save preserves old record'
Check ([FakeCred]::Writes() -eq 1) 'collision save zero retries'
Check ([FakeCred]::Deletes() -eq 0) 'collision save does not delete'

$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($raw))
$mutexName = 'Global\ConfluenceMCP-S-1-5-21-123-123-123-1001-' + $site.Substring(15)
[FakeCred]::Reset()
[FakeCred]::Probe([ConfluenceWinCred], $site, $encoded, $mutexName, $true)
Check ((Read-Record) -ceq $raw) 'writer continues after same-user site lock released'
[FakeCred]::Reset()
[FakeCred]::Probe([ConfluenceWinCred], $site, $encoded, $mutexName.Replace('1001-', '1002-'), $false)
Check ((Read-Record) -ceq $raw) 'different user lock does not block writer'
[FakeCred]::Reset()
[FakeCred]::Probe([ConfluenceWinCred], $site, $encoded, $mutexName.Replace(('a' * 64), ('b' * 64)), $false)
Check ((Read-Record) -ceq $raw) 'different site lock does not block writer'
[FakeCred]::Reset()
$abandoned = [FakeCred]::Abandon($mutexName)
try {
  Check ((Write-Record) -eq 'saved') 'abandoned owner recovers from fresh records'
  Check ((Read-Record) -ceq $updated) 'abandoned mutex released by new operation'
} finally { $abandoned.Dispose() }

[FakeCred]::Reset()
Check ($null -eq (Read-Record)) 'missing record'
Check (-not [ConfluenceWinCred]::Run('delete', $site, '')) 'idempotent missing delete'
Seed $site $account $raw
Check ((Read-Record) -ceq $raw) 'Python UTF16 primary'
Seed $compound $account '{"username":"fixture","password":"stale"}'
Check ((Read-Record) -ceq $raw) 'primary precedence'
[FakeCred]::Fail([int][char]'w', $site, 5)
Fails { Write-Record } 'write denial'
Check ((Read-Record) -ceq $raw) 'failed write retains primary'
Check ([FakeCred]::Writes() -eq 1) 'single write attempt'
Check ([FakeCred]::Deletes() -eq 0) 'no delete before save'
[FakeCred]::Fail(0, '', 0)
Check ((Write-Record) -eq 'saved') 'atomic replacement'
Check ((Read-Record) -ceq $updated) 'updated record read'
[FakeCred]::Fail([int][char]'d', $compound, 5)
Fails { [ConfluenceWinCred]::Run('delete', $site, '') } 'fallback delete denial'
Check ((Read-Record) -ceq $updated) 'failed fallback delete leaves active'
[FakeCred]::Fail([int][char]'d', $site, 5)
Fails { [ConfluenceWinCred]::Run('delete', $site, '') } 'primary delete denial'
Check ((Read-Record) -ceq $updated) 'partial delete leaves active'
[FakeCred]::Fail(0, '', 0)
Check ([ConfluenceWinCred]::Run('delete', $site, '')) 'owned records deleted'
Check ($null -eq (Read-Record)) 'no stale fallback'
Check (-not [ConfluenceWinCred]::Run('delete', $site, '')) 'repeated delete'

[FakeCred]::Reset()
Seed $compound $account $raw
Check ((Read-Record) -ceq $raw) 'compound-only Python record'
Check ((Write-Record) -eq 'saved') 'compound-only update'
Check ((Read-Record) -ceq $updated) 'updated compound'
[FakeCred]::Fail([int][char]'r', $site, 5)
Fails { Read-Record } 'read access denial is not missing'
Fails { Write-Record } 'read failure prevents save'
Fails { [ConfluenceWinCred]::Run('delete', $site, '') } 'read failure prevents delete'
[FakeCred]::Fail(0, '', 0)
Seed $site 'foreign' 'synthetic-foreign'
Check ((Read-Record) -ceq $updated) 'foreign primary fallback'
Check ((Write-Record) -eq 'saved') 'collision update'
[FakeCred]::Fail([int][char]'w', $site, 5)
Check ((Write-Record $raw) -eq 'saved') 'foreign primary never written'
Check ([ConfluenceWinCred]::Run('delete', $site, '')) 'only own collision deleted'
Check ($null -eq (Read-Record)) 'foreign identity not returned'
Seed $compound 'foreign-two' 'synthetic-foreign-two'
$before = [FakeCred]::Writes()
Fails { Write-Record } 'both slots occupied'
Check ([FakeCred]::Writes() -eq $before) 'conflicting account zero writes'
Check (-not [ConfluenceWinCred]::Run('delete', $site, '')) 'foreign accounts not deleted'

[FakeCred]::Reset()
$utf8Raw = $raw
if ([Text.Encoding]::UTF8.GetByteCount($utf8Raw) % 2 -eq 0) { $utf8Raw += ' ' }
Seed $site $account $utf8Raw ([Text.Encoding]::UTF8)
Check ((Read-Record) -ceq $utf8Raw) 'Python UTF8 decode fallback'
Seed $site $account ([string][char]0xFEFF + $raw)
Check ((Read-Record) -ceq $raw) 'Python BOM record'
Seed $site $account ([string][char]0xFEFF + $raw) ([Text.Encoding]::BigEndianUnicode)
Check ((Read-Record) -ceq $raw) 'Python big-endian BOM record'
Fails { Write-Record ('x' * 1281) } 'oversize blob rejected'
Check ([FakeCred]::Writes() -eq 0) 'oversize zero writes'
Fails { [ConfluenceWinCred]::Run('delete', 'arbitrary-target', '') } 'namespace restriction'
Check ([FakeCred]::Allocations() -eq 0) 'CredRead memory freed'
[FakeCred]::Reset()
Write-Record $raw | Out-Null
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ passed = 'WinCred ABI fixture passed'; blob = [FakeCred]::Dump($site) } -Compress))
[FakeCred]::Reset()
exit 0
