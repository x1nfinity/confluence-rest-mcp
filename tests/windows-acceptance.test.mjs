import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, scope, fixture, options, runSuite, liveOps, main } from '../scripts/windows-acceptance.mjs';
import { hookScript, referenceScript, LOCK_SCRIPT } from '../scripts/windows-acceptance-hooks.mjs';
import { WINDOWS_SCRIPT } from '../dist/windows-credentials.js';

const runId = '12345678-1234-4234-8234-123456789abc';
function model() {
  const slots = new Map(CASES.map(id => [id, [null, null]])), calls = [];
  const own = record => record?.account === 'own';
  const read = id => { const [a, b] = slots.get(id); return own(a) ? a.value : own(b) ? b.value : null; };
  const write = (id, raw) => {
    if (Buffer.byteLength(raw, 'utf16le') > 2560) throw new Error('OVERSIZE');
    const pair = slots.get(id), slot = pair[0] && !own(pair[0]) ? 1 : !pair[0] && own(pair[1]) ? 1 : 0;
    if (pair[slot] && !own(pair[slot])) throw new Error('CONFLICT');
    pair[slot] = { account: 'own', value: JSON.parse(raw) };
  };
  const del = id => { const pair = slots.get(id); let deleted = false;
    for (const slot of [1, 0]) if (own(pair[slot])) { pair[slot] = null; deleted = true; } return deleted; };
  return { slots, calls, ops: {
    async probe() {}, async read(id) { return read(id); }, async write(id, raw) { write(id, raw); },
    async delete(id) { return del(id); }, async identityRejected() { throw new Error('IDENTITY_REJECTED'); },
    async reference(id, mode, extra) {
      calls.push([id, mode]); const pair = slots.get(id);
      if (mode === 'empty') assert.deepEqual(pair, [null, null]);
      else if (mode === 'save') pair[0] = { account: 'own', value: fixture(runId, extra.variant) };
      else if (mode === 'seed') pair[extra.slot] = { account: extra.account, value: fixture(runId, extra.variant) };
      else if (mode === 'slot') assert.deepEqual(pair[extra.slot], extra.variant === null ? null : { account: extra.account, value: fixture(runId, extra.variant) });
      else if (mode === 'read') assert.deepEqual(read(id), fixture(runId, extra.variant));
      else if (mode === 'delete') del(id);
      else if (mode === 'cleanup') pair.fill(null);
      else if (mode === 'native_failure') return { ok: true, native_api_failure: true };
      else throw new Error('UNEXPECTED_MODE');
      return { ok: true };
    },
    async hook(id, o) {
      const pair = slots.get(id);
      if (o.fault === 'fail-delete' && o.trigger_slot === 0 && own(pair[1])) pair[1] = null;
      if (o.fault === 'race-delete') pair[o.trigger_slot] = null;
      if (o.fault.startsWith('race-')) pair[o.race_slot] = { account: o.race_account, value: fixture(runId, o.race_variant) };
      return { ok: false, hits: 1 };
    },
    async concurrent(id) { write(id, JSON.stringify(fixture(runId, 'B'))); }, async lock() {},
  } };
}

test('Windows acceptance runs the complete matrix and cleans every claimed scope', async () => {
  const m = model(), report = await runSuite(runId, m.ops);
  assert.equal(report.status, 'passed_with_pending'); assert.equal(report.results.length, CASES.length);
  assert.ok(report.cleanup.every(r => r.status === 'passed'));
  assert.ok([...m.slots.values()].every(pair => pair.every(v => v === null)));
  assert.ok(report.pending.includes('cross_windows_sessions'));
  assert.ok(!JSON.stringify(report).includes('synthetic-' + runId));
});

test('preflight refuses occupied scopes and never cleans an unclaimed record', async () => {
  const m = model(); m.slots.get('failure')[0] = { account: 'personal', value: 'untouched-fixture-marker' };
  const report = await runSuite(runId, m.ops);
  assert.equal(report.status, 'failed'); assert.equal(report.results[0].id, 'preflight');
  assert.equal(m.slots.get('failure')[0].value, 'untouched-fixture-marker');
  assert.deepEqual(m.calls.filter(c => c[1] === 'cleanup'), [['interop', 'cleanup']]);
});

test('cleanup failure and unconfirmed native API failure remain visible', async () => {
  const m = model(), reference = m.ops.reference;
  m.ops.reference = async (id, mode, extra) => {
    if (id === 'lock' && mode === 'cleanup') throw new Error('CLEANUP_INCOMPLETE');
    if (mode === 'native_failure') return { ok: true, native_api_failure: false };
    return reference(id, mode, extra);
  };
  const report = await runSuite(runId, m.ops);
  assert.equal(report.status, 'failed'); assert.ok(report.pending.includes('native_api_failure_not_confirmed'));
  assert.equal(report.cleanup.at(-1).code, 'CLEANUP_INCOMPLETE');
});

test('scope and flags reject personal sites and legacy Python options', () => {
  for (const value of ['', '../personal', '12345678-1234-1234-8234-123456789abc']) assert.throws(() => scope(value, 'interop'));
  assert.throws(() => scope(runId, 'personal')); assert.throws(() => options(['--base-url', 'https://example.com']));
  assert.throws(() => options(['--cleanup', runId, '--hold-lock', runId]));
  assert.throws(() => options(['--python', 'python.exe']));
  assert.equal(options(['--report', 'C:\\测试 folder\\report.json']).report, 'C:\\测试 folder\\report.json');
});

test('Windows version gate accepts Node 22.12 and newer before validating the disposable scope', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const version = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    for (const node of ['20.19.0', '21.7.3', '22.0.0', '22.11.0', '22.12.0', '22.22.1', '24.21.0', '26.0.0']) {
      Object.defineProperty(process.versions, 'node', { value: node, configurable: true });
      await assert.rejects(main(['--cleanup', 'invalid-run-id']), {
        message: ['20.19.0', '21.7.3', '22.0.0', '22.11.0'].includes(node) ? 'NODE_VERSION_REQUIRED' : 'INVALID_SCOPE',
      });
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process.versions, 'node', version);
  }
});

test('raw reference adapter binds only disposable scopes, known accounts and complete UTF16 records', async () => {
  const calls = [], run = async (executable, args, input) => { calls.push({ executable, args, input }); return { ok: true }; };
  const ops = liveOps(runId, run, 'powershell.exe');
  await ops.reference('interop', 'save', { variant: 'A' });
  await ops.reference('collision', 'seed', { slot: 1, account: 'foreign-a', variant: 'foreign-a' });
  await ops.reference('interop', 'slot', { slot: 1, variant: null });
  assert.equal((await ops.reference('failure', 'native_failure')).native_api_failure, true);
  for (const call of calls) {
    assert.equal(call.executable, 'powershell.exe');
    assert.ok(call.input.service.startsWith('confluence-mcp:'));
    assert.equal(call.input.records.length, 4);
    assert.equal(call.input.users.length, 3);
    assert.ok(!call.args.join(' ').includes('synthetic-'));
    assert.ok(!call.args.join(' ').includes(runId));
  }
  assert.equal(calls[0].input.mode, 'seed'); assert.equal(calls[0].input.slot, 0);
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].input.record, 'base64').toString('utf16le')), fixture(runId, 'A'));
  assert.equal(calls[1].input.user, 'acceptance-foreign-' + runId + '-a');
  assert.equal(calls[2].input.record, null);
  const count = calls.length;
  await assert.rejects(ops.reference('personal', 'cleanup'));
  await assert.rejects(ops.reference('interop', 'seed', { slot: 2, account: 'own', variant: 'A' }));
  await assert.rejects(ops.reference('interop', 'seed', { slot: 0, account: 'personal', variant: 'A' }));
  await assert.rejects(ops.reference('interop', 'save', { variant: 'personal' }));
  assert.equal(calls.length, count);
});

test('Windows script exits before any platform operation on other hosts', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/windows-acceptance.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /WINDOWS_REQUIRED/u);
});

test('live fault hooks compile and execute over the isolated WinCred ABI fixture',
  { skip: !process.env.CONFLUENCE_TEST_PWSH || process.platform !== 'darwin' }, () => {
    assert.ok(Buffer.from(hookScript(), 'utf16le').toString('base64').length < 30000);
    const dir = mkdtempSync(join(tmpdir(), 'confluence-acceptance-hooks-'));
    try {
      const lib = join(dir, 'wincred.dylib');
      const built = spawnSync('/usr/bin/clang', ['-shared', '-o', lib, fileURLToPath(new URL('./fixtures/windows-wincred.c', import.meta.url))], { encoding: 'utf8' });
      assert.equal(built.status, 0, built.stderr);
      const existing = readFileSync(new URL('./fixtures/windows-credentials.ps1', import.meta.url), 'utf8');
      const bootstrap = existing.slice(0, existing.indexOf('$site ='));
      let code = hookScript().replace('CurrentSid() +', '"S-1-5-21-123-123-123-1001" +');
      code = code.replace('$request =', bootstrap + '\n$request =');
      code = code.replace('[ConfluenceWinCred]::TestService = [string]$request.service', String.raw`
[ConfluenceWinCred]::TestService = [string]$request.service
$old = [Convert]::FromBase64String($request.old)
[FakeCred]::Seed($request.service, 'confluence-credentials', $old, $old.Length)
`);
      code = code.replace('exit 0\n} catch { exit 1 }', String.raw`
if ([FakeCred]::Dump($request.service) -ne $request.expected) { exit 2 }
exit 0
} catch { exit 1 }
`);
      // The ABI stub handles both Advapi32 and the fault-only kernel32 SetLastError entry.
      const svc = scope(runId, 'failure').service;
      const rawReference = referenceScript().replace('$request =', bootstrap.replaceAll('ConfluenceWinCred', 'AcceptanceWinCred') + '\n$request =');
      const invokeReference = input => spawnSync(process.env.CONFLUENCE_TEST_PWSH,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(rawReference, 'utf16le').toString('base64')],
        { encoding: 'utf8', input: JSON.stringify(input), env: { ...process.env, CONFLUENCE_TEST_NATIVE: lib } });
      const serviceName = scope(runId, 'interop').service;
      const record = Buffer.from(JSON.stringify(fixture(runId, 'A')), 'utf16le').toString('base64');
      const request = { service: serviceName, mode: 'seed', slot: 0, user: 'confluence-credentials', record,
        users: ['confluence-credentials'], records: [record] };
      let rawResult = invokeReference(request);
      assert.equal(rawResult.status, 0, rawResult.stderr); assert.deepEqual(JSON.parse(rawResult.stdout), { ok: true });
      const known = rawReference.replace('$request =', '[FakeCred]::Seed("' + serviceName + '", "confluence-credentials", [Convert]::FromBase64String("' + record + '"), ' + Buffer.from(record, 'base64').length + ')\n$request =');
      for (const mode of ['slot', 'native_failure', 'cleanup', 'empty']) {
        const script = known.replace("[Console]::Out.Write('{\"ok\":true}')",
          mode === 'cleanup' ? 'if ([FakeCred]::Deletes() -ne 1) { throw "DELETE_NOT_EXECUTED" }\n[Console]::Out.Write(\'{"ok":true}\')'
            : "[Console]::Out.Write('{\"ok\":true}')");
        rawResult = spawnSync(process.env.CONFLUENCE_TEST_PWSH,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { encoding: 'utf8', input: JSON.stringify({ ...request, mode }), env: { ...process.env, CONFLUENCE_TEST_NATIVE: lib } });
        assert.equal(rawResult.status, mode === 'empty' ? 1 : 0, rawResult.stderr);
        assert.deepEqual(JSON.parse(rawResult.stdout), mode === 'empty' ? { ok: false, code: 'SCOPE_OCCUPIED' } : { ok: true });
      }
      // The fake store resets for each process; bootstrap a recognized or foreign record to test guards.
      const seeded = rawReference.replace('$request =', '[FakeCred]::Seed("' + serviceName + '", "foreign", [byte[]]@(1, 2), 2)\n$request =');
      rawResult = spawnSync(process.env.CONFLUENCE_TEST_PWSH,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(seeded, 'utf16le').toString('base64')],
        { encoding: 'utf8', input: JSON.stringify({ ...request, mode: 'cleanup' }), env: { ...process.env, CONFLUENCE_TEST_NATIVE: lib } });
      assert.equal(rawResult.status, 1); assert.equal(JSON.parse(rawResult.stdout).code, 'SCOPE_OCCUPIED');
      const old = Buffer.from(JSON.stringify(fixture(runId, 'A')), 'utf16le').toString('base64');
      const next = Buffer.from(JSON.stringify(fixture(runId, 'B')), 'utf16le').toString('base64');
      for (const fault of ['fail-write', 'fail-delete', 'race-read']) {
        const request = { service: svc, action: fault === 'fail-delete' ? 'delete' : 'write', fault, trigger: svc,
          record: next, old, expected: fault === 'race-read' ? next : old,
          race_target: svc, race_user: 'confluence-credentials', race_record: next };
        const run = spawnSync(process.env.CONFLUENCE_TEST_PWSH,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
          { input: JSON.stringify(request), encoding: 'utf8', timeout: 45000, env: { ...process.env, CONFLUENCE_TEST_NATIVE: lib } });
        assert.equal(run.status, 0, run.stderr); assert.deepEqual(JSON.parse(run.stdout), { ok: false, hits: 1 });
      }
      const parser = '$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){exit 1}';
      const parsed = spawnSync(process.env.CONFLUENCE_TEST_PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parser], { input: LOCK_SCRIPT, encoding: 'utf8' });
      assert.equal(parsed.status, 0, parsed.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
