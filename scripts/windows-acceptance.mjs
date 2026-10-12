#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { login, service, systemStore } from '../dist/auth.js';
import { WINDOWS_SCRIPT } from '../dist/windows-credentials.js';
import { hookScript, referenceScript, LOCK_SCRIPT } from './windows-acceptance-hooks.mjs';

export const CASES = ['interop', 'failure', 'collision', 'conflict', 'delete', 'races', 'concurrent', 'lock'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const self = fileURLToPath(import.meta.url);
export function scope(runId, id) {
  if (!UUID.test(runId) || !CASES.includes(id)) throw new Error('INVALID_SCOPE');
  const base = 'https://windows-credential-check.example.invalid/' + runId + '/' + id;
  return { base, service: service(base) };
}
export function fixture(runId, variant) {
  if (!UUID.test(runId) || !['A', 'B', 'foreign-a', 'foreign-b'].includes(variant)) throw new Error('INVALID_FIXTURE');
  return { username: 'acceptance-' + runId + '-' + variant,
    password: 'synthetic-' + runId + '-' + variant + '-中文😀\\"' };
}
function safeCode(error) {
  return /^[A-Z][A-Z_]{2,60}$/u.test(error?.message ?? '') ? error.message : 'ACCEPTANCE_FAILED';
}
function command(executable, args, input, timeout = 60000, allowRejected = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout });
    let output = '', failed = false;
    const fail = () => { if (!failed) { failed = true; child.kill(); reject(new Error('CHILD_FAILED')); } };
    child.once('error', fail); child.stdin.once('error', fail);
    child.stdout.on('data', data => { output += data.toString('utf8'); if (Buffer.byteLength(output) > 16384) fail(); });
    child.once('close', status => {
      if (failed) return;
      try {
        const value = JSON.parse(output);
        if (status !== 0 || (value.ok === false && !allowRejected)) throw new Error(safeCode({ message: value.code }));
        resolveResult(value);
      } catch (error) { reject(new Error(safeCode(error))); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
function psArgs(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  if (encoded.length > 30000) throw new Error('POWERSHELL_COMMAND_TOO_LONG');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
}
function powershell() {
  if (!process.env.SystemRoot || !/^[a-z]:\\/iu.test(process.env.SystemRoot)) throw new Error('SYSTEM_ROOT_REQUIRED');
  return win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
async function rejected(action) {
  let failed = false;
  try { await action(); } catch { failed = true; }
  assert.ok(failed);
}
export async function runSuite(runId, ops, notify = () => {}) {
  const results = [], cleanup = [];
  const claimed = new Set();
  let nativeFailure = false;
  const test = async (id, layer, action) => {
    notify({ event: 'running', id });
    const start = performance.now();
    try { await action(); results.push({ id, layer, status: 'passed', elapsed_ms: Math.round(performance.now() - start) }); }
    catch (error) { results.push({ id, layer, status: 'failed', code: safeCode(error) }); }
    notify(results.at(-1));
  };
  try {
    await ops.probe();
    for (const id of CASES) { await ops.reference(id, 'empty'); claimed.add(id); }
    const raw = v => JSON.stringify(fixture(runId, v));
    const read = async (id, v) => assert.deepEqual(await ops.read(id), v === null ? null : fixture(runId, v));
    await test('interop', 'real_wincred_raw_api_ts', async () => {
      await ops.reference('interop', 'save', { variant: 'A' }); await read('interop', 'A');
      await ops.write('interop', raw('B')); await ops.reference('interop', 'read', { variant: 'B' });
      await ops.reference('interop', 'save', { variant: 'A' }); await read('interop', 'A');
      await ops.reference('interop', 'delete'); await read('interop', null);
    });
    await test('failure', 'real_store_and_controlled_fault', async () => {
      await ops.reference('failure', 'save', { variant: 'A' });
      await rejected(() => ops.identityRejected('failure', fixture(runId, 'B'))); await read('failure', 'A');
      await rejected(() => ops.write('failure', JSON.stringify({ ...fixture(runId, 'B'), password: 'x'.repeat(3000) })));
      await read('failure', 'A');
      nativeFailure = (await ops.reference('failure', 'native_failure')).native_api_failure === true;
      await read('failure', 'A');
      const result = await ops.hook('failure', { action: 'write', fault: 'fail-write', trigger_slot: 0, variant: 'B' });
      assert.equal(result.ok, false); assert.equal(result.hits, 1); await read('failure', 'A');
    });
    await test('collision', 'real_wincred', async () => {
      await ops.reference('collision', 'seed', { slot: 0, account: 'foreign-a', variant: 'foreign-a' });
      await ops.reference('collision', 'seed', { slot: 1, account: 'own', variant: 'A' });
      await read('collision', 'A'); await ops.write('collision', raw('B'));
      await ops.reference('collision', 'slot', { slot: 0, account: 'foreign-a', variant: 'foreign-a' });
      await ops.reference('collision', 'slot', { slot: 1, account: 'own', variant: 'B' });
      await ops.delete('collision'); await read('collision', null);
      await ops.reference('collision', 'slot', { slot: 0, account: 'foreign-a', variant: 'foreign-a' });
    });
    await test('conflict', 'real_wincred', async () => {
      for (const [slot, variant] of [[0, 'foreign-a'], [1, 'foreign-b']]) await ops.reference('conflict', 'seed', { slot, account: variant, variant });
      await rejected(() => ops.write('conflict', raw('A'))); assert.equal(await ops.delete('conflict'), false);
      for (const [slot, variant] of [[0, 'foreign-a'], [1, 'foreign-b']]) await ops.reference('conflict', 'slot', { slot, account: variant, variant });
    });
    await test('delete', 'real_store_and_controlled_fault', async () => {
      await ops.reference('delete', 'seed', { slot: 0, account: 'own', variant: 'B' });
      await ops.reference('delete', 'seed', { slot: 1, account: 'own', variant: 'A' });
      for (const slot of [1, 0]) {
        const result = await ops.hook('delete', { action: 'delete', fault: 'fail-delete', trigger_slot: slot });
        assert.equal(result.ok, false); assert.equal(result.hits, 1); await read('delete', 'B');
        await ops.reference('delete', 'slot', { slot: 1, account: 'own', variant: slot === 1 ? 'A' : null });
      }
      await ops.delete('delete'); await read('delete', null); assert.equal(await ops.delete('delete'), false);
    });
    await test('races', 'real_store_and_controlled_race', async () => {
      await ops.reference('races', 'save', { variant: 'A' });
      let result = await ops.hook('races', { action: 'write', variant: 'A', fault: 'race-read', trigger_slot: 0,
        race_slot: 0, race_account: 'own', race_variant: 'B' });
      assert.equal(result.ok, false); assert.equal(result.hits, 1); await read('races', 'B');
      await ops.reference('races', 'seed', { slot: 1, account: 'own', variant: 'A' });
      result = await ops.hook('races', { action: 'delete', fault: 'race-delete', trigger_slot: 1,
        race_slot: 0, race_account: 'foreign-a', race_variant: 'foreign-a' });
      assert.equal(result.ok, false); assert.equal(result.hits, 1);
      await ops.reference('races', 'slot', { slot: 0, account: 'foreign-a', variant: 'foreign-a' });
      await ops.reference('races', 'cleanup'); await ops.reference('races', 'save', { variant: 'A' });
      result = await ops.hook('races', { action: 'delete', fault: 'race-delete', trigger_slot: 0,
        race_slot: 1, race_account: 'own', race_variant: 'B' });
      assert.equal(result.ok, false); assert.equal(result.hits, 1); await read('races', 'B');
    });
    await test('concurrent', 'real_wincred_multiple_processes', () => ops.concurrent('concurrent'));
    await test('lock', 'real_global_mutex_same_session', () => ops.lock('lock'));
  } catch (error) { results.push({ id: 'preflight', status: 'failed', code: safeCode(error) }); }
  finally {
    // Workers must be stopped before cleanup; the live concurrent adapter awaits every worker.
    for (const id of CASES) {
      if (!claimed.has(id)) { cleanup.push({ id, status: 'not_claimed' }); continue; }
      try { await ops.reference(id, 'cleanup'); cleanup.push({ id, status: 'passed' }); }
      catch (error) { cleanup.push({ id, status: 'failed', code: safeCode(error) }); }
    }
  }
  const pending = ['cross_windows_sessions', 'different_windows_users_acl', 'enterprise_policy', 'interactive_login_and_host_reload'];
  if (!nativeFailure) pending.push('native_api_failure_not_confirmed');
  return { schema: 1, run_id: runId, platform: process.platform, node: process.version, arch: process.arch,
    status: results.some(r => r.status === 'failed') || cleanup.some(r => r.status === 'failed') ? 'failed' : 'passed_with_pending',
    results, cleanup, pending };
}

async function locker(runId) {
  const child = spawn(powershell(), psArgs(LOCK_SCRIPT), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 45000 });
  child.stdin.on('error', () => {});
  const exited = new Promise(resolveExit => child.once('close', resolveExit));
  const lines = createInterface({ input: child.stdout });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('LOCK_READY_TIMEOUT')); }, 15000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('LOCK_FAILED')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('LOCK_FAILED')); });
    lines.once('line', line => { clearTimeout(timer); if (line === '{"locked":true}') resolveReady(); else reject(new Error('LOCK_FAILED')); });
    child.stdin.write(JSON.stringify({ service: scope(runId, 'lock').service }) + '\n');
  });
  return { async release(abandon = false) {
    if (abandon) child.kill(); else child.stdin.end('release\n');
    const status = await exited; lines.close();
    if (!abandon && status !== 0) throw new Error('LOCK_RELEASE_FAILED');
  } };
}

async function lockProbe(runId, action) {
  const script = WINDOWS_SCRIPT.replace('$result = [ConfluenceWinCred]::Run',
    '[Console]::Out.WriteLine(\'{"ready":true}\'); [Console]::Out.Flush()\n$result = [ConfluenceWinCred]::Run');
  const child = spawn(powershell(), psArgs(script), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 45000 });
  const lines = createInterface({ input: child.stdout });
  let reply, started;
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('PROBE_READY_TIMEOUT')); }, 15000);
    const fail = () => { clearTimeout(timer); reject(new Error('PROBE_FAILED')); };
    child.once('error', fail); child.once('exit', fail); child.stdin.once('error', fail);
    lines.on('line', line => {
      if (line === '{"ready":true}') { clearTimeout(timer); started = performance.now(); resolveReady(); }
      else { try { reply = JSON.parse(line); } catch { child.kill(); } }
    });
  });
  const done = new Promise((resolveDone, reject) => {
    child.once('error', () => reject(new Error('PROBE_FAILED')));
    child.once('close', status => {
      lines.close();
      if (status !== 0 || !reply || !Object.hasOwn(reply, 'value')) reject(new Error('PROBE_FAILED'));
      else resolveDone({ elapsed_ms: Math.round(performance.now() - started) });
    });
  });
  // Keep a handler attached while awaiting readiness, including early compilation failures.
  done.catch(() => {});
  child.stdin.end(JSON.stringify({ action, service: scope(runId, 'lock').service,
    record: action === 'write' ? Buffer.from(JSON.stringify(fixture(runId, 'A')), 'utf16le').toString('base64') : '' }));
  await ready;
  return { done };
}

export function liveOps(runId, runCommand = command, executable = powershell()) {
  const reference = async (id, mode, extra = {}) => {
    const { service: svc } = scope(runId, id);
    const variants = ['A', 'B', 'foreign-a', 'foreign-b'];
    const encode = variant => Buffer.from(JSON.stringify(fixture(runId, variant)), 'utf16le').toString('base64');
    const users = { own: 'confluence-credentials', 'foreign-a': 'acceptance-foreign-' + runId + '-a',
      'foreign-b': 'acceptance-foreign-' + runId + '-b' };
    if (mode === 'save') { mode = 'seed'; extra = { ...extra, slot: 0, account: 'own' }; }
    if (mode === 'read') {
      mode = 'slot'; extra = { ...extra, slot: 0, account: 'own' };
    }
    if (mode === 'delete') mode = 'cleanup';
    if (extra.slot !== undefined && ![0, 1].includes(extra.slot)) throw new Error('INVALID_SCOPE');
    if (extra.account !== undefined && !Object.hasOwn(users, extra.account)) throw new Error('INVALID_SCOPE');
    const result = await runCommand(executable, psArgs(referenceScript()), {
      service: svc, mode, users: Object.values(users), records: variants.map(encode), slot: extra.slot,
      user: users[extra.account], record: extra.variant == null ? null : encode(extra.variant) });
    return mode === 'native_failure' ? { ...result, native_api_failure: true } : result;
  };
  const store = id => systemStore(scope(runId, id).base);
  return {
    probe: () => reference('lock', 'empty'), reference,
    async read(id) { const raw = await (await store(id)).getPassword(); return raw === null ? null : JSON.parse(raw); },
    async write(id, raw) { await (await store(id)).setPassword(raw); },
    async delete(id) { return (await store(id)).deletePassword(); },
    identityRejected: (id, value) => login(scope(runId, id).base, value, async () => { throw new Error('SYNTHETIC_IDENTITY_REJECTED'); }),
    async hook(id, options) {
      const svc = scope(runId, id).service, targets = [svc, 'confluence-credentials@' + svc];
      const input = { service: svc, action: options.action, fault: options.fault,
        trigger: targets[options.trigger_slot], record: options.variant ? Buffer.from(JSON.stringify(fixture(runId, options.variant)), 'utf16le').toString('base64') : '' };
      if (options.race_slot !== undefined) Object.assign(input, { race_target: targets[options.race_slot],
        race_user: options.race_account === 'own' ? 'confluence-credentials' : 'acceptance-foreign-' + runId + '-a',
        race_record: Buffer.from(JSON.stringify(fixture(runId, options.race_variant)), 'utf16le').toString('base64') });
      return command(powershell(), psArgs(hookScript()), input, 60000, true);
    },
    async concurrent(id) {
      // Each worker awaits the bridge's bounded calls; killing a worker could orphan its PowerShell child.
      const tasks = ['A', 'B'].map(variant => command(process.execPath, [self, '--worker'], { run_id: runId, case: id, variant }, 0));
      const settled = await Promise.allSettled(tasks);
      if (settled.some(r => r.status === 'rejected')) throw new Error('CONCURRENT_FAILED');
    },
    async lock() {
      for (const abandon of [false, true]) {
        const holder = await locker(runId);
        let complete = false, error, writing;
        try {
          const probe = await lockProbe(runId, 'write');
          writing = probe.done.catch(e => { error = e; }).finally(() => { complete = true; });
          await new Promise(r => setTimeout(r, 1200)); assert.equal(complete, false);
        } finally {
          try { await holder.release(abandon); } finally { if (writing) await writing; }
        }
        if (error) throw error;
      }
    },
  };
}

export function options(argv) {
  const value = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--worker' || key === '--help') value[key.slice(2)] = true;
    else if (['--report', '--cleanup', '--hold-lock', '--probe-lock'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) value[key.slice(2)] = argv[++i];
    else throw new Error('INVALID_ARGUMENT');
  }
  if ([value.cleanup, value['hold-lock'], value['probe-lock'], value.worker].filter(Boolean).length > 1) throw new Error('INVALID_ARGUMENT');
  return value;
}
export async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (args.help) { process.stdout.write('node scripts/windows-acceptance.mjs [--report NEW_JSON]\n--cleanup RUN_UUID; --hold-lock RUN_UUID; --probe-lock RUN_UUID\n'); return; }
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 12) throw new Error('NODE_VERSION_REQUIRED');
  if (args.worker) {
    let input = ''; for await (const data of process.stdin) input += data; const request = JSON.parse(input);
    if (request.case !== 'concurrent') throw new Error('INVALID_SCOPE');
    const { base } = scope(request.run_id, request.case), store = await systemStore(base);
    for (let i = 0; i < 3; i++) {
      await store.setPassword(JSON.stringify(fixture(request.run_id, request.variant)));
      const raw = await store.getPassword();
      if (raw !== null) assert.ok(['A', 'B'].some(v => JSON.stringify(fixture(request.run_id, v)) === raw));
      await store.deletePassword();
    }
    process.stdout.write('{"ok":true}'); return;
  }
  const runId = args.cleanup || args['hold-lock'] || args['probe-lock'] || randomUUID();
  scope(runId, 'lock');
  if (args['hold-lock']) {
    const holder = await locker(runId);
    process.stdout.write(JSON.stringify({ event: 'locked', run_id: runId, auto_release_seconds: 20 }) + '\n');
    await new Promise(r => setTimeout(r, 20000)); await holder.release(); return;
  }
  if (args['probe-lock']) {
    const result = await (await lockProbe(runId, 'read')).done;
    process.stdout.write(JSON.stringify({ mode: 'lock_probe', run_id: runId, elapsed_ms: result.elapsed_ms,
      status: 'requires_two_session_comparison' }) + '\n'); return;
  }
  let report;
  if (args.cleanup) {
    const cleanup = [];
    for (const id of CASES) {
      try { await liveOps(runId).reference(id, 'cleanup'); cleanup.push({ id, status: 'passed' }); }
      catch (error) { cleanup.push({ id, status: 'failed', code: safeCode(error) }); }
    }
    report = { schema: 1, run_id: runId, mode: 'cleanup', cleanup,
      status: cleanup.some(r => r.status === 'failed') ? 'failed' : 'passed' };
  } else {
    process.stdout.write(JSON.stringify({ event: 'started', run_id: runId }) + '\n');
    report = await runSuite(runId, liveOps(runId), result => process.stdout.write(JSON.stringify(result) + '\n'));
  }
  if (args.report) writeFileSync(resolve(args.report), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + '\n');
  if (report.status === 'failed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(JSON.stringify({ status: 'failed', code: safeCode(error) }) + '\n'); process.exitCode = 1; });
}
