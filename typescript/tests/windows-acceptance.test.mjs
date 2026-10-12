import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, scope, fixture, options, runSuite } from '../scripts/windows-acceptance.mjs';
import { hookScript, LOCK_SCRIPT } from '../scripts/windows-acceptance-hooks.mjs';
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
    async py(id, mode, extra) {
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
  const m = model(), py = m.ops.py;
  m.ops.py = async (id, mode, extra) => {
    if (id === 'lock' && mode === 'cleanup') throw new Error('CLEANUP_INCOMPLETE');
    if (mode === 'native_failure') return { ok: true, native_api_failure: false };
    return py(id, mode, extra);
  };
  const report = await runSuite(runId, m.ops);
  assert.equal(report.status, 'failed'); assert.ok(report.pending.includes('native_api_failure_not_confirmed'));
  assert.equal(report.cleanup.at(-1).code, 'CLEANUP_INCOMPLETE');
});

test('scope, flags and Python helper agree without accepting a personal base URL', () => {
  for (const value of ['', '../personal', '12345678-1234-1234-8234-123456789abc']) assert.throws(() => scope(value, 'interop'));
  assert.throws(() => scope(runId, 'personal')); assert.throws(() => options(['--base-url', 'https://example.com']));
  assert.throws(() => options(['--cleanup', runId, '--hold-lock', runId]));
  assert.equal(options(['--python', 'C:\\测试 folder\\python.exe']).python, 'C:\\测试 folder\\python.exe');
  const python = spawnSync('python3', ['-B', '-c',
    'import runpy,json,sys; m=runpy.run_path(sys.argv[1]); r=json.load(sys.stdin); print(json.dumps({"scope":m["scope"](r),"fixture":m["fixture"](r["run_id"],"A"),"cases":m["CASES"]}))',
    fileURLToPath(new URL('../scripts/windows-acceptance-python.py', import.meta.url))],
    { input: JSON.stringify({ run_id: runId, case: 'interop' }), encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr); const actual = JSON.parse(python.stdout);
  assert.deepEqual(actual.scope, [runId, scope(runId, 'interop').base, scope(runId, 'interop').service]);
  assert.deepEqual(actual.fixture, fixture(runId, 'A')); assert.deepEqual(actual.cases, CASES);
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
