import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { windowsStore, windowsRequest, WINDOWS_SCRIPT } from '../dist/windows-credentials.js';
import { service, credentials, login, logout, systemStore } from '../dist/auth.js';

const base = 'https://example.com/confluence';
const name = service(base), fixture = { username: '测试😀', password: '合成\\"😀-only' };
const raw = JSON.stringify(fixture);

test('Windows record transport preserves Python-compatible Unicode JSON and source isolation', async () => {
  let stored = Buffer.from(raw, 'utf16le'), calls = [];
  const store = windowsStore(name, async request => {
    calls.push(request);
    assert.equal(request.service, name);
    if (request.action === 'read') return stored === null ? null : Buffer.from(stored.toString('utf16le')).toString('base64');
    if (request.action === 'write') { stored = Buffer.from(request.record, 'base64'); return 'saved'; }
    stored = null; return true;
  });
  const factory = async () => store;
  assert.deepEqual(await credentials(base, 'keyring', {}, factory), fixture);
  await assert.rejects(login(base, fixture, async () => { throw new Error('rejected'); }, factory));
  assert.deepEqual(calls.map(r => r.action), ['read']);
  const updated = { ...fixture, password: '更新合成😀' };
  await login(base, updated, async candidate => { assert.deepEqual(candidate, updated); }, factory);
  assert.deepEqual(await credentials(base, 'keyring', {}, factory), updated);
  await logout(base, 'env', factory); assert.equal(calls.at(-1).action, 'read');
  await logout(base, 'keyring', factory);
  await assert.rejects(credentials(base, 'keyring', {}, factory), { code: 'LOGIN_REQUIRED' });
});

test('Windows backend rejects malformed replies and oversize blobs without saving', async () => {
  assert.throws(() => windowsStore('arbitrary-target'), { code: 'CREDENTIAL_FAILED' });
  for (const value of [undefined, 12, 'not base64!', '/w=='])
    await assert.rejects(windowsStore(name, async () => value).getPassword());
  await assert.rejects(windowsStore(name, async () => true).setPassword(raw), { code: 'CREDENTIAL_FAILED' });
  await assert.rejects(windowsStore(name, async () => 'false').deletePassword(), { code: 'CREDENTIAL_FAILED' });
  let calls = 0;
  await assert.rejects(windowsStore(name, async () => { calls++; }).setPassword('x'.repeat(1281)), { code: 'CREDENTIAL_INVALID' });
  assert.equal(calls, 0);
  if (process.platform !== 'win32')
    await assert.rejects((await systemStore(base, 'win32')).setPassword(raw), { code: 'CREDENTIAL_BACKEND_UNAVAILABLE' });
});

test('a saved Windows record survives a lost acknowledgement without rollback or retry', async () => {
  let record = raw, writes = 0, deletes = 0;
  const store = windowsStore(name, async request => {
    if (request.action === 'read') return Buffer.from(record).toString('base64');
    if (request.action === 'write') {
      writes++; record = Buffer.from(request.record, 'base64').toString('utf16le');
      throw new Error('synthetic lost acknowledgement');
    }
    deletes++; return true;
  });
  const updated = { ...fixture, password: 'new-synthetic-only' }, factory = async () => store;
  await assert.rejects(login(base, updated, async () => {}, factory), { code: 'CREDENTIAL_FAILED' });
  assert.equal(writes, 1); assert.equal(deletes, 0);
  assert.deepEqual(await credentials(base, 'keyring', {}, factory), updated);
});

test('Windows launcher sends secrets only on private stdin and sanitizes failures', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform'), root = process.env.SystemRoot;
  const launch = (reply, status = 0, error = false) => (command, args, options) => {
    assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), WINDOWS_SCRIPT);
    assert.ok(!JSON.stringify(args).includes(Buffer.from(raw, 'utf16le').toString('base64')));
    assert.ok(args.at(-1).length < 30000); assert.equal(options.shell, undefined);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']); assert.equal(options.windowsHide, true);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    let input = ''; child.stdin.on('data', data => { input += data; });
    child.stdin.on('finish', () => {
      assert.equal(Buffer.from(JSON.parse(input).record, 'base64').toString('utf16le'), raw);
      if (error) child.emit('error', new Error('synthetic-secret-error'));
      else { child.stdout.write(reply); child.emit('close', status); }
    });
    return child;
  };
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); process.env.SystemRoot = 'C:\\Windows';
    const request = { action: 'write', service: name, record: Buffer.from(raw, 'utf16le').toString('base64') };
    assert.equal(await windowsRequest(request, undefined, launch('{"value":"saved"}')), 'saved');
    for (const [reply, status, error] of [['invalid', 0], ['{"value":true,"extra":1}', 0], ['x'.repeat(8193), 0], ['', 1], ['', 0, true]])
      await assert.rejects(windowsRequest(request, undefined, launch(reply, status, error)), { code: 'CREDENTIAL_FAILED' });
  } finally {
    Object.defineProperty(process, 'platform', original);
    if (root === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = root;
  }
});

test('Windows CLI login reaches hidden-input boundary and never reads a keyring non-interactively', async () => {
  const { main } = await import('../dist/cli.js');
  const original = Object.getOwnPropertyDescriptor(process, 'platform'), oldEnv = { ...process.env };
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.LOCALAPPDATA = 'C:\\confluence-test-nonexistent'; process.env.CONFLUENCE_BASE_URL = base;
    process.env.CONFLUENCE_AUTH_MODE = 'basic'; process.env.CONFLUENCE_CREDENTIAL_SOURCE = 'keyring';
    await assert.rejects(main(['login']), { code: 'TTY_REQUIRED' });
  } finally {
    Object.defineProperty(process, 'platform', original);
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv);
  }
});

test('actual pinned Python auth and WinVault backend exchange UTF16 JSON using an in-memory API',
  { skip: !process.env.CONFLUENCE_TEST_PYTHON }, () => {
    const updated = { ...fixture, password: '更新合成😀' };
    for (const records of [[{ target: name, account: 'confluence-credentials', blob: Buffer.from(raw, 'utf16le').toString('base64') }],
      [{ target: name, account: 'foreign', blob: Buffer.from('synthetic-foreign', 'utf16le').toString('base64') },
        { target: 'confluence-credentials@' + name, account: 'confluence-credentials', blob: Buffer.from(raw, 'utf16le').toString('base64') }]]) {
      const result = spawnSync(process.env.CONFLUENCE_TEST_PYTHON, ['-B',
        fileURLToPath(new URL('../scripts/windows-keyring-reference.py', import.meta.url))],
      { encoding: 'utf8', input: JSON.stringify({ base, service: name, records, expected: fixture, updated }),
        env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../../native/src', import.meta.url)) } });
      assert.equal(result.status, 0, result.stderr);
      const returned = JSON.parse(result.stdout);
      assert.deepEqual(JSON.parse(Buffer.from(returned.record, 'base64').toString('utf16le')), updated);
      assert.equal(returned.deleted, true);
    }
  });

test('Windows OS disposable-target roundtrip',
  { skip: process.platform !== 'win32' || process.env.CONFLUENCE_TEST_WINDOWS !== '1' }, async () => {
    const isolatedBase = 'https://windows-credential-check.example.invalid/' + randomUUID();
    const store = await systemStore(isolatedBase);
    try {
      assert.equal(await store.getPassword(), null);
      await store.setPassword(raw); assert.equal(await store.getPassword(), raw);
      const updated = JSON.stringify({ ...fixture, password: 'updated-synthetic-only' });
      await store.setPassword(updated); assert.equal(await store.getPassword(), updated);
      assert.equal(await store.deletePassword(), true); assert.equal(await store.getPassword(), null);
      assert.equal(await store.deletePassword(), false);
    } finally { await store.deletePassword(); }
  });

test('production WinCred bridge compiles and runs against an isolated native ABI fixture',
  { skip: !process.env.CONFLUENCE_TEST_PWSH || process.platform !== 'darwin' }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'confluence-wincred-abi-'));
    try {
      const library = join(directory, 'wincred.dylib');
      const compiled = spawnSync('/usr/bin/clang', ['-shared', '-o', library,
        fileURLToPath(new URL('./fixtures/windows-wincred.c', import.meta.url))], { encoding: 'utf8' });
      assert.equal(compiled.status, 0, compiled.stderr);
      const cases = readFileSync(new URL('./fixtures/windows-credentials.ps1', import.meta.url), 'utf8');
      // Compile the real SID getter, but substitute its invocation for this non-Windows ABI fixture.
      assert.equal(WINDOWS_SCRIPT.match(/CurrentSid\(\) \+/gu)?.length, 1);
      assert.ok(WINDOWS_SCRIPT.includes('"Global\\\\ConfluenceMCP-"'));
      const simulated = WINDOWS_SCRIPT.replace('CurrentSid() +', '"S-1-5-21-123-123-123-1001" +');
      const script = simulated.slice(0, simulated.indexOf('$request =')) + cases
        + '\n} catch { [Console]::Error.WriteLine($_); [Console]::Error.WriteLine($_.ScriptStackTrace); exit 1 }';
      const result = spawnSync(process.env.CONFLUENCE_TEST_PWSH,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 45000, env: { ...process.env, CONFLUENCE_TEST_NATIVE: library } });
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /WinCred ABI fixture passed/);
      const actualBlob = JSON.parse(result.stdout).blob;
      const actual = JSON.parse(Buffer.from(actualBlob, 'base64').toString('utf16le'));
      assert.deepEqual(actual, { username: '测试😀', password: '合成\\"😀' });
      if (process.env.CONFLUENCE_TEST_PYTHON) {
        const compared = spawnSync(process.env.CONFLUENCE_TEST_PYTHON, ['-B',
          fileURLToPath(new URL('../scripts/windows-keyring-reference.py', import.meta.url))],
        { encoding: 'utf8', input: JSON.stringify({ base, service: name,
          records: [{ target: name, account: 'confluence-credentials', blob: actualBlob }],
          expected: actual, updated: fixture }),
          env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../../native/src', import.meta.url)) } });
        assert.equal(compared.status, 0, compared.stderr);
        assert.deepEqual(JSON.parse(Buffer.from(JSON.parse(compared.stdout).record, 'base64').toString('utf16le')), fixture);
      }
      // Exercise the complete production stdin/JSON/stdout wrapper with the same ABI fixture.
      const bootstrap = cases.slice(0, cases.indexOf('$site ='));
      const wrapped = simulated.replace('$request =', bootstrap + '\n$request =');
      const wrappedResult = spawnSync(process.env.CONFLUENCE_TEST_PWSH,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 45000, input: JSON.stringify({ action: 'write', service: name,
          record: Buffer.from(raw, 'utf16le').toString('base64') }),
          env: { ...process.env, CONFLUENCE_TEST_NATIVE: library } });
      assert.equal(wrappedResult.status, 0, wrappedResult.stderr);
      assert.deepEqual(JSON.parse(wrappedResult.stdout), { value: 'saved' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
