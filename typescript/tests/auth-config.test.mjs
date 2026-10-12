import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configuration, normalizeBase, stateDirectory, settings } from '../dist/config.js';
import { credentials, validCredentials, login, logout, service, systemStore, readSystemRecord } from '../dist/auth.js';
import { hiddenInput } from '../dist/cli.js';
import { failure } from '../dist/errors.js';

const base = 'https://example.com/confluence';
const good = { username: 'test-user', password: 'synthetic-password' };
const code = expected => error => error.code === expected;

test('HTTPS site normalization preserves deployment and rejects unsafe paths', () => {
  assert.equal(normalizeBase('https://EXAMPLE.com:443/confluence/'), base);
  assert.equal(normalizeBase('https://例子.测试/confluence'), 'https://xn--fsqu00a.xn--0zwm56d/confluence');
  for (const value of ['http://example.com', 'https://u:p@example.com', 'https://example.com/a/../confluence',
    'https://example.com/%2e', 'https://example.com:0', 'https://example.com//a', 'https://example.com?x=1',
    'https://example.com#x', 'https://@example.com', 'short.example/x', ' https://example.com']) assert.throws(() => normalizeBase(value), code('INVALID_BASE'));
});
test('stable configuration is read-only, validates state and explicit sources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-config-'));
  try {
    assert.equal(configuration({ CONFLUENCE_BASE_URL: base }, directory).source, 'keyring');
    assert.equal(configuration({ CONFLUENCE_BASE_URL: base, CONFLUENCE_READ_ONLY: 'false' }, directory).readOnly, true);
    for (const env of [{ CONFLUENCE_CREDENTIAL_SOURCE: 'auto' }, { CONFLUENCE_AUTH_MODE: 'browser' },
      { CONFLUENCE_READ_ONLY: 'yes' }, { CONFLUENCE_TIMEOUT_SECONDS: 'Infinity' }])
      assert.throws(() => configuration({ CONFLUENCE_BASE_URL: base, ...env }, directory));
    writeFileSync(join(directory, 'auth.json'), JSON.stringify({ mode: 'basic', allow_write: true }));
    assert.equal(configuration({ CONFLUENCE_BASE_URL: base }, directory).readOnly, false);
    assert.equal(configuration({ CONFLUENCE_BASE_URL: base, CONFLUENCE_READ_ONLY: 'true' }, directory).readOnly, true);
    writeFileSync(join(directory, 'auth.json'), '{"unexpected":true}');
    assert.throws(() => configuration({ CONFLUENCE_BASE_URL: base }, directory), code('AUTH_CONFIG_INVALID'));
    rmSync(join(directory, 'auth.json'));
    if (process.platform !== 'win32') {
      writeFileSync(join(directory, 'real.json'), '{}'); symlinkSync(join(directory, 'real.json'), join(directory, 'auth.json'));
      assert.throws(() => settings(join(directory, 'auth.json'), []), code('AUTH_CONFIG_INVALID'));
    }
    assert.equal(stateDirectory('darwin', {}, '/tmp/member'), '/tmp/member/.confluence-mcp/.local');
    assert.equal(stateDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\Member\\AppData\\Local' }), 'C:\\Users\\Member\\AppData\\Local\\ConfluenceMCP\\.local');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('env credentials are paired, validated and never combined with keyring', async () => {
  const forbidden = async () => { throw new Error('store must not be called'); };
  assert.deepEqual(await credentials(base, 'env', { CONFLUENCE_USERNAME: good.username, CONFLUENCE_PASSWORD: good.password }, forbidden), good);
  await assert.rejects(credentials(base, 'env', { CONFLUENCE_USERNAME: good.username }, forbidden), code('CREDENTIAL_INVALID'));
  for (const value of [{ ...good, username: 'a:b' }, { ...good, password: 'a\nb' }, { ...good, password: '' },
    { ...good, username: '\ud800' }, { ...good, extra: 'x' }]) assert.throws(() => validCredentials(value), code('CREDENTIAL_INVALID'));
});
test('keyring loads latest complete record and never falls back to env', async () => {
  let raw = JSON.stringify(good);
  const factory = async () => ({ getPassword: () => raw });
  assert.deepEqual(await credentials(base, 'keyring', {}, factory), good);
  raw = JSON.stringify({ ...good, password: 'updated-synthetic-password' });
  assert.equal((await credentials(base, 'keyring', {}, factory)).password, 'updated-synthetic-password');
  raw = null;
  await assert.rejects(credentials(base, 'keyring', { CONFLUENCE_USERNAME: 'other', CONFLUENCE_PASSWORD: 'other' }, factory), code('LOGIN_REQUIRED'));
  raw = 'bad json'; await assert.rejects(credentials(base, 'keyring', {}, factory), code('CREDENTIAL_FAILED'));
  await assert.rejects(systemStore(base, 'linux'), code('CREDENTIAL_BACKEND_UNAVAILABLE'));
});
test('login verifies before save; rejection and failed update retain prior record', async () => {
  let raw = JSON.stringify(good), saves = 0;
  const factory = async () => ({ getPassword: () => raw, setPassword: value => { saves++; raw = value; } });
  await assert.rejects(login(base, good, async () => { throw new Error('rejected'); }, factory));
  assert.equal(saves, 0); assert.equal(raw, JSON.stringify(good));
  await login(base, { ...good, password: 'new-synthetic-password' }, async () => {}, factory);
  assert.equal(saves, 1);
  const before = raw;
  await assert.rejects(login(base, good, async () => {}, async () => ({ setPassword: () => { throw new Error('failed'); } })), code('CREDENTIAL_FAILED'));
  assert.equal(raw, before);
});
test('logout isolates env source and service normalization matches legacy', async () => {
  let deleted = 0;
  const factory = async () => ({ deletePassword: () => { deleted++; return true; } });
  await logout(base, 'env', factory); assert.equal(deleted, 0);
  await logout(base, 'keyring', factory); assert.equal(deleted, 1);
  assert.equal(service(base + '/'), service(base));
});
test('hidden input never echoes values and restores raw mode on accept/cancel', async () => {
  class Input extends EventEmitter { isTTY = true; isRaw = false;
    setRawMode(value) { this.isRaw = value; } pause() {} resume() {} }
  const input = new Input(), written = [];
  const output = { isTTY: true, write: value => written.push(value) };
  let pending = hiddenInput('Password: ', input, output);
  input.emit('data', Buffer.from('hidden-value\r'));
  assert.equal(await pending, 'hidden-value'); assert.equal(input.isRaw, false);
  assert.equal(written.join(''), 'Password: \n');
  pending = hiddenInput('Password: ', input, output); input.emit('data', Buffer.from('\x03'));
  await assert.rejects(pending, code('TTY_REQUIRED')); assert.equal(input.isRaw, false);
  pending = hiddenInput('Password: ', input, output);
  const unicode = Buffer.from('中文😀'); input.emit('data', unicode.subarray(0, 2));
  input.emit('data', unicode.subarray(2)); input.emit('data', Buffer.from('\r'));
  assert.equal(await pending, '中文😀');
  assert.throws(() => hiddenInput('', { isTTY: false }, output), code('TTY_REQUIRED'));
});
test('untrusted errors and backend secrets cannot appear in error payload', () => {
  assert.ok(!JSON.stringify(failure(new Error(good.password))).includes(good.password));
});
test('credential worker requires private IPC and respects cancelled reads', async () => {
  const direct = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/keyring-read.js', import.meta.url)), service(base)], { encoding: 'utf8' });
  assert.equal(direct.status, 1); assert.equal(direct.stdout, '');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readSystemRecord(service(base), controller.signal), code('CREDENTIAL_FAILED'));
});
