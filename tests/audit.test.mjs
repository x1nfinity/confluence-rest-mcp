import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer, VERSION } from '../dist/server.js';
import { tools } from '../dist/confluence.js';
import { configuration } from '../dist/config.js';
import { ReadError } from '../dist/errors.js';

async function session(api, enabled, run) {
  const server = createServer(api, enabled), [client, transport] = InMemoryTransport.createLinkedPair();
  const pending = new Map(); let id = 0;
  client.onmessage = response => { const resolve = pending.get(response.id); if (resolve) { pending.delete(response.id); resolve(response.result); } };
  const call = async (method, params = {}) => {
    const requestId = ++id, result = new Promise(resolve => pending.set(requestId, resolve));
    await client.send({ jsonrpc: '2.0', id: requestId, method, params }); return result;
  };
  try {
    await server.connect(transport); await client.start();
    await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'audit-fixture', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await run(call);
  } finally { await server.close(); await client.close(); }
}
const invoke = (call, name, args = {}) => call('tools/call', { name, arguments: args });
const secret = 'synthetic-private-marker';

test('audit defaults off and configuration/doctor expose only the explicit switch', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'confluence-audit-config-'));
  try {
    const env = { CONFLUENCE_BASE_URL: 'https://example.invalid/confluence' };
    assert.equal(configuration(env, home).auditEnabled, false);
    for (const value of ['false', 'true']) assert.equal(configuration({ ...env, CONFLUENCE_AUDIT: value }, home).auditEnabled, value === 'true');
    for (const value of ['', '1', 'yes', 'TRUE', secret])
      assert.throws(() => configuration({ ...env, CONFLUENCE_AUDIT: value }, home), { code: 'AUTH_CONFIG_INVALID' });
    const report = spawnSync(process.execPath, ['dist/cli.js', 'doctor', '--check', '--json'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, ...env, HOME: home, LOCALAPPDATA: home,
        CONFLUENCE_AUTH_MODE: 'basic', CONFLUENCE_CREDENTIAL_SOURCE: 'keyring', CONFLUENCE_AUDIT: 'true' },
    });
    assert.equal(report.status, 0); assert.equal(report.stderr, '');
    assert.equal(JSON.parse(report.stdout).audit_enabled, true);
    assert.equal(JSON.parse(report.stdout).authentication, 'pending');
    assert.deepEqual(fs.readdirSync(home), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SDK audits read, default preview, successful write and rejected/uncertain writes once without arguments or results', async t => {
  const logs = [];
  t.mock.method(fs, 'writeSync', (fd, line) => { assert.equal(fd, 2); logs.push(line); return Buffer.byteLength(line); });
  const api = { tools, async call(name, args) {
    if (name === 'remove_label') throw new ReadError('WRITE_DISABLED');
    if (name === 'move_page') throw new Error(secret);
    return { text: secret, title: secret, pageId: secret, payload: { body_storage: secret }, executed: args.dry_run === false };
  } };
  await session(api, true, async call => {
    await call('tools/list'); await call('ping'); assert.equal(logs.length, 0);
    for (const [name, args] of [['get_page', { pageId: secret }], ['add_comment', { body_storage: secret }],
      ['upload_attachment', { file_path: secret, dry_run: false }], ['remove_label', { label: secret, dry_run: false }],
      ['move_page', { parent_id: secret, dry_run: false }]]) await invoke(call, name, args);
  });
  assert.equal(logs.length, 5);
  const entries = logs.map(line => { assert.ok(line.endsWith('\n')); return JSON.parse(line); });
  assert.deepEqual(entries.map(entry => [entry.tool, entry.mode, entry.result_code]), [
    ['get_page', 'read', 'OK'], ['add_comment', 'preview', 'OK'], ['upload_attachment', 'write', 'OK'],
    ['remove_label', 'write', 'WRITE_DISABLED'], ['move_page', 'write', 'WRITE_UNCERTAIN'],
  ]);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['duration_ms', 'mode', 'result_code', 'timestamp', 'tool', 'version']);
    assert.equal(entry.version, VERSION); assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.ok(Number.isSafeInteger(entry.duration_ms) && entry.duration_ms >= 0);
  }
  assert.ok(!logs.join('').includes(secret));
});

test('unknown names and unrecognized error codes never become audit content', async t => {
  const logs = [];
  t.mock.method(fs, 'writeSync', (_fd, line) => { logs.push(line); return Buffer.byteLength(line); });
  await session({ tools, async call() { throw new ReadError('SYNTHETIC_PRIVATE_CODE'); } }, true, async call => {
    await invoke(call, secret + '\nforged-entry', { password: secret, cookie: secret });
  });
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).tool, 'unknown'); assert.equal(JSON.parse(logs[0]).result_code, 'UNKNOWN_ERROR');
  assert.ok(!logs[0].includes(secret)); assert.ok(!logs[0].includes('SYNTHETIC_PRIVATE_CODE'));
});

test('disabled audit and broken stderr preserve the original result and never repeat a write', async t => {
  let calls = 0, writes = 0;
  t.mock.method(fs, 'writeSync', () => { writes++; throw new Error(secret); });
  const api = { tools, async call() { calls++; return { dry_run: false, executed: true }; } };
  await session(api, false, async call => {
    const result = await invoke(call, 'add_comment', { dry_run: false });
    assert.equal(JSON.parse(result.content[0].text).executed, true);
  });
  assert.equal(writes, 0); assert.equal(calls, 1);
  await session(api, true, async call => {
    const result = await invoke(call, 'add_comment', { dry_run: false });
    assert.equal(result.isError, undefined); assert.equal(JSON.parse(result.content[0].text).executed, true);
  });
  assert.equal(writes, 1); assert.equal(calls, 2);
});

test('CLI opt-in audit stays on stderr while actual stdio remains JSON-RPC', { timeout: 5000 }, async () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'confluence-audit-stdio-'));
  const child = spawn(process.execPath, ['dist/cli.js'], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, LOCALAPPDATA: home, CONFLUENCE_BASE_URL: 'https://example.invalid/confluence',
      CONFLUENCE_AUTH_MODE: 'basic', CONFLUENCE_CREDENTIAL_SOURCE: 'env', CONFLUENCE_AUDIT: 'true' } });
  const stdout = createInterface({ input: child.stdout }), stderr = createInterface({ input: child.stderr });
  const pending = new Map(); let id = 0;
  stdout.on('line', line => { const response = JSON.parse(line); assert.equal(response.jsonrpc, '2.0');
    const resolve = pending.get(response.id); if (resolve) { pending.delete(response.id); resolve(response); } });
  const audited = new Promise(resolve => stderr.once('line', line => resolve(JSON.parse(line))));
  const call = (method, params) => new Promise(resolve => { const requestId = ++id; pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n'); });
  try {
    await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const rejected = await call('tools/call', { name: 'get_page', arguments: { pageId: secret, offset: true } });
    assert.equal(rejected.result._meta.error.code, 'INVALID_ARGUMENT');
    const entry = await audited;
    assert.equal(entry.tool, 'get_page'); assert.equal(entry.result_code, 'INVALID_ARGUMENT');
    assert.ok(!JSON.stringify(entry).includes(secret)); assert.deepEqual(fs.readdirSync(home), []);
  } finally { child.kill(); stdout.close(); stderr.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
