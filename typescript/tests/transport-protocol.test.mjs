import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { allowedRoute, RestClient, sendJson, httpError } from '../dist/rest.js';
import { ReadError } from '../dist/errors.js';
import { Confluence, tools } from '../dist/confluence.js';
import { createServer, VERSION } from '../dist/server.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const base = 'https://example.com/confluence';
const credential = { username: 'test-user', password: 'synthetic-password' };
const code = expected => error => error.code === expected;
test('GET route guard rejects cross-site, port, traversal, credentials, encodings and non-M1 endpoints', () => {
  assert.equal(allowedRoute(base, base + '/rest/api/content/123?expand=body.view').pathname, '/confluence/rest/api/content/123');
  for (const value of ['https://other.example/confluence/rest/api/content/123', 'https://example.com:444/confluence/rest/api/content/123',
    base + '/rest/api/content/../user/current', base + '/rest/api/content/%31', base + '/rest/api/content/123#x',
    'https://a:b@example.com/confluence/rest/api/content/123', 'https://example.com/rest/api/content/123',
    base + '/rest/api/space']) assert.throws(() => allowedRoute(base, value), code('INVALID_ROUTE'));
});
test('GET retries exactly once inside timeout; auth, permissions and TLS failures do not retry', async () => {
  let attempts = 0, loads = 0;
  const load = async () => { loads++; return credential; };
  const api = new RestClient(base, 1, load, async () => { attempts++; if (attempts === 1) throw new ReadError('SERVER_UNAVAILABLE', 503, 0); return { ok: true }; });
  assert.deepEqual(await api.get('content/123'), { ok: true }); assert.equal(attempts, 2); assert.equal(loads, 2);
  for (const error of [new ReadError('ACCESS_DENIED', 403), new ReadError('LOGIN_REQUIRED', 401),
    new ReadError('NETWORK_FAILED', undefined, undefined, false), httpError(429, 'invalid'), new ReadError('SERVER_UNAVAILABLE', 503, 10)]) {
    attempts = 0; const client = new RestClient(base, 0.05, load, async () => { attempts++; throw error; });
    await assert.rejects(client.get('content/123')); assert.equal(attempts, 1);
  }
  attempts = 0;
  await assert.rejects(api.get('space')); assert.equal(attempts, 0);
});
test('identity verification uses explicit credentials only on user/current', async () => {
  let loadCount = 0;
  const api = new RestClient(base, 1, async () => { loadCount++; return credential; }, async (url, c) => {
    assert.equal(url.pathname, '/confluence/rest/api/user/current'); assert.deepEqual(c, credential);
    return { type: 'known', username: c.username };
  });
  assert.deepEqual(await api.verify(credential), { authenticated: true }); assert.equal(loadCount, 0);
  await assert.rejects(api.get('content/123', {}, credential), code('INVALID_REQUEST'));
});
test('credential load time is included in the request deadline', async () => {
  let sent = 0;
  const client = new RestClient(base, 0.005, async () => {
    await new Promise(resolve => setTimeout(resolve, 20)); return credential;
  }, async () => { sent++; return {}; });
  await assert.rejects(client.get('content/123'), code('NETWORK_FAILED')); assert.equal(sent, 0);
  await assert.rejects(client.verify(), code('NETWORK_FAILED')); assert.equal(sent, 0);
});

function mockResponse(t, { status = 200, mime = 'application/json', body = Buffer.from('{"ok":true}'), retryAfter, failure } = {}) {
  let calls = 0;
  t.mock.method(https, 'request', (_url, options) => {
    calls++;
    assert.equal(options.method, 'GET'); assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, undefined);
    const request = new EventEmitter();
    request.destroy = error => { if (error) queueMicrotask(() => request.emit('error', error)); return request; };
    request.end = () => queueMicrotask(() => {
      if (failure) { request.emit('error', failure); return; }
      const response = new PassThrough();
      response.statusCode = status; response.headers = { 'content-type': mime, ...(retryAfter ? { 'retry-after': retryAfter } : {}) };
      request.emit('response', response);
      if (!response.destroyed) response.end(body);
    });
    return request;
  });
  return () => calls;
}
test('native HTTPS transport parses only bounded JSON and never follows redirects', async t => {
  mockResponse(t);
  assert.deepEqual(await sendJson(new URL(base + '/rest/api/content/123'), credential, 1), { ok: true });
});
for (const [name, options, expected] of [
  ['redirect', { status: 302 }, 'REDIRECT_DENIED'],
  ['HTML login', { mime: 'text/html' }, 'LOGIN_REQUIRED'],
  ['malformed JSON', { body: Buffer.from('{bad') }, 'CONTENT_INCOMPLETE'],
  ['wrong UTF-8', { body: Buffer.from([255]) }, 'CONTENT_INCOMPLETE'],
  ['array JSON', { body: Buffer.from('[]') }, 'CONTENT_INCOMPLETE'],
  ['oversized JSON', { body: Buffer.alloc(2 * 1024 * 1024 + 1, 32) }, 'RESPONSE_TOO_LARGE'],
]) test('native HTTPS transport rejects ' + name, async t => {
  const count = mockResponse(t, options);
  await assert.rejects(sendJson(new URL(base + '/rest/api/content/123'), credential, 1), code(expected)); assert.equal(count(), 1);
});
test('TLS errors are sanitized and non-retryable', async t => {
  mockResponse(t, { failure: Object.assign(new Error('synthetic-server-private-error'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) });
  await assert.rejects(sendJson(new URL(base + '/rest/api/content/123'), credential, 1), error => {
    assert.equal(error.code, 'NETWORK_FAILED'); assert.equal(error.details().retryable, false);
    assert.ok(!JSON.stringify(error.details()).includes('synthetic-server-private-error')); return true;
  });
});

for (const protocolVersion of ['2024-11-05', '2025-03-26']) test('actual stdio SDK negotiation and calls: ' + protocolVersion, { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['dist/cli.js'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, CONFLUENCE_BASE_URL: base, CONFLUENCE_AUTH_MODE: 'basic', CONFLUENCE_CREDENTIAL_SOURCE: 'env' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map(); let id = 0;
  lines.on('line', line => { const response = JSON.parse(line); const request = pending.get(response.id);
    if (request) { pending.delete(response.id); request(response); } });
  const call = (method, params = {}) => new Promise(resolve => { const requestId = ++id; pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n'); });
  try {
    const initialized = await call('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'legacy-fixture', version: '1' } });
    assert.equal(initialized.result.protocolVersion, protocolVersion);
    assert.equal(initialized.result.serverInfo.name, 'confluence');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    assert.deepEqual((await call('ping')).result, {});
    assert.deepEqual((await call('tools/list')).result.tools, tools);
    const rejected = (await call('tools/call', { name: 'get_page', arguments: { pageId: '123', offset: true } })).result;
    assert.equal(rejected.isError, true); assert.equal(rejected._meta.error.code, 'INVALID_ARGUMENT');
    const later = (await call('tools/call', { name: 'get_attachments', arguments: { pageId: '123', attachmentId: '5', read_content: true } })).result;
    assert.equal(later._meta.error.code, 'CREDENTIAL_INVALID');
    assert.equal(errors, '');
  } finally { child.kill(); lines.close(); }
});
test('CLI version/help, precheck and non-TTY login never require saved credentials', () => {
  const env = { ...process.env, CONFLUENCE_BASE_URL: base, CONFLUENCE_AUTH_MODE: 'basic', CONFLUENCE_CREDENTIAL_SOURCE: 'keyring' };
  const invoke = args => spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
  assert.equal(invoke(['version']).stdout.trim(), VERSION);
  assert.equal(invoke(['--help']).status, 0);
  const report = invoke(['doctor', '--check', '--json']);
  assert.equal(report.status, 0); assert.equal(JSON.parse(report.stdout).authentication, 'pending');
  const login = invoke(['login']); assert.equal(login.status, 1); assert.ok(login.stderr.includes('TTY_REQUIRED'));
  const secret = invoke(['login', '--password', 'synthetic-secret-must-not-appear']);
  assert.equal(secret.status, 1); assert.ok(!secret.stderr.includes('synthetic-secret-must-not-appear'));
});
test('npm-style symlink bin runs the CLI rather than silently importing it', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-bin-'));
  try {
    const path = join(directory, 'confluence-mcp');
    symlinkSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), path);
    const result = spawnSync(process.execPath, [path, 'version'], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stdout.trim(), VERSION);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('SDK tools/call returns basic text through the actual server handler', { timeout: 3000 }, async () => {
  const api = new Confluence(new RestClient(base, 1, async () => credential, async () => ({
    id: '123', type: 'page', status: 'current', title: 'Synthetic', version: { number: 1 },
    body: { view: { value: '<p>Unicode😀</p>' } }, _links: {}, ancestors: [],
  })));
  const server = createServer(api);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const pending = new Map(); let id = 0;
  client.onmessage = response => { const resolve = pending.get(response.id); if (resolve) { pending.delete(response.id); resolve(response); } };
  const call = async (method, params) => {
    const requestId = ++id;
    const result = new Promise(resolve => pending.set(requestId, resolve));
    await client.send({ jsonrpc: '2.0', id: requestId, method, params }); return result;
  };
  await server.connect(transport); await client.start();
  try {
    await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const response = await call('tools/call', { name: 'get_page', arguments: { pageId: '123' } });
    assert.equal(response.result.isError, undefined);
    const result = JSON.parse(response.result.content[0].text);
    assert.equal(result.text, 'Unicode😀'); assert.equal(result.content.returned_chars, 8);
  } finally { await server.close(); await client.close(); }
});
