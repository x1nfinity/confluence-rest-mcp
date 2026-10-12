import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WriteService, previewHash, verifyPreview } from '../dist/writes.js';
import { ReadError } from '../dist/errors.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/writes.json', import.meta.url)));
const BASE = 'https://example.com/confluence';
const PAGE = { id: '123', type: 'page', status: 'current', title: 'Before', space: { key: 'DOC' },
  version: { number: 7 }, body: { storage: { value: '<p>Before</p>' } } };
const CREATE = { space_key: 'DOC', title: 'After', body_storage: '<p>After</p>' };
const UPDATE = { pageId: '123', title: 'After', body_storage: '<p>After</p>', expected_version: 7 };
const PATCH = { pageId: '123', operation: 'replace', old_fragment: '<p>Before</p>', body_storage: '<p>After</p>', expected_version: 7 };
function setup(gate = { allow_write: true, readOnly: false, writeSpaces: ['DOC'] }, responses) {
  const requests = [];
  const rest = { base: BASE,
    async get(path, params) {
      requests.push({ method: 'GET', path, params });
      if (responses) { const value = responses.shift(); if (value instanceof Error) throw value; return structuredClone(value); }
      return path === 'content/search' ? { results: [] } : structuredClone(PAGE);
    },
    async write(method, path, payload) {
      requests.push({ method, path, payload });
      if (responses) { const value = responses.shift(); if (value instanceof Error) throw value; return structuredClone(value); }
      return { ...structuredClone(PAGE), id: method === 'POST' ? '456' : '123', title: payload.title,
        version: method === 'POST' ? { number: 1 } : payload.version };
    } };
  return { service: new WriteService(rest, gate, async id => id), requests };
}
test('preview hashes match fixed Python Unicode/key ordering/escaping vectors', () => {
  for (const vector of fixture.hashes) {
    const { base, method, path, payload, hash } = vector;
    assert.equal(previewHash(base, method, path, payload), hash);
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    assert.equal(previewHash(base, method, path, reordered), hash);
    verifyPreview(hash.toUpperCase(), base, method, path, payload);
    verifyPreview(undefined, base, method, path, payload);
    assert.throws(() => verifyPreview(hash, base + '/', method, path, payload), { code: 'PREVIEW_MISMATCH' });
    assert.throws(() => verifyPreview(hash, base, method, path, { ...payload, title: 'Changed' }), { code: 'PREVIEW_MISMATCH' });
  }
  for (const value of [NaN, Infinity, -Infinity, '\ud800', new Set(), undefined])
    assert.throws(() => previewHash(BASE, 'POST', 'content', { nested: [value] }), { code: 'INVALID_ARGUMENT' });
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => previewHash(BASE, 'POST', 'content', cycle), { code: 'INVALID_ARGUMENT' });
  for (const [method, path] of [['GET', 'content'], ['POST', '/content'], ['PUT', 'content/１２３'], ['POST', 'content?x=1']])
    assert.throws(() => previewHash(BASE, method, path, {}), { code: 'INVALID_ARGUMENT' });
  for (const value of ['', 'f'.repeat(63), 'f'.repeat(65), 'g'.repeat(64), false, [], {}])
    assert.throws(() => verifyPreview(value, BASE, 'POST', 'content', {}), { code: 'INVALID_ARGUMENT' });
});
test('complete create/update/patch preview objects match fixed native results', async () => {
  for (const vector of fixture.previews) {
    const responses = vector.name === 'create_page'
      ? vector.args.parent_id ? [vector.page, { results: [] }] : [{ results: [] }]
      : vector.name === 'patch_page' ? [vector.page, vector.page] : [vector.page];
    const { service, requests } = setup(undefined, responses);
    assert.deepEqual(await service.call(vector.name, vector.args), vector.result);
    assert.ok(requests.every(request => request.method === 'GET'));
  }
});
test('all three tools default to preview and issue only native-compatible GET/payloads', async () => {
  const { service, requests } = setup({ allow_write: false, readOnly: true });
  const create = await service.call('create_page', { ...CREATE, parent_id: '123' });
  assert.equal(create.write_scope_configured, false);
  assert.deepEqual(create.target, { base_url: BASE, space_key: 'DOC', parent_id: '123', parent_title: 'Before' });
  assert.deepEqual(create.payload, { type: 'page', status: 'current', title: 'After', space: { key: 'DOC' },
    body: { storage: { value: '<p>After</p>', representation: 'storage' } }, ancestors: [{ id: '123' }] });
  const update = await service.call('update_page', UPDATE);
  assert.equal(update.write_scope_configured, false);
  assert.deepEqual(update.before, { title: 'Before', body_storage: '<p>Before</p>' });
  assert.deepEqual(update.after, { title: 'After', body_storage: '<p>After</p>' });
  assert.equal(update.current_version, 7); assert.equal(update.proposed_version, 8);
  assert.deepEqual(Object.keys(update.payload).sort(), ['id', 'type', 'status', 'title', 'body', 'version'].sort());
  const patch = await service.call('patch_page', PATCH);
  assert.equal(patch.write_scope_configured, false);
  assert.equal(patch.payload.title, 'Before'); assert.equal(patch.operation, 'replace');
  assert.equal(patch.after.body_storage, '<p>After</p>');
  assert.ok(patch.diff.startsWith('--- before-storage\n+++ after-storage\n'));
  assert.equal(patch.diff_truncated, false);
  assert.deepEqual(requests.map(v => v.method), ['GET', 'GET', 'GET', 'GET', 'GET']);
  const escaped = { ...CREATE, space_key: 'D"\\OC', title: 'a"\\b' };
  await service.call('create_page', escaped);
  assert.equal(requests.at(-1).params.cql, 'type = page AND space = ' + JSON.stringify(escaped.space_key) + ' AND title = ' + JSON.stringify(escaped.title));
});
test('closed write and empty scope gates fail before any read or submission', async () => {
  for (const [gate, code] of [[{ allow_write: false, readOnly: false, writeSpaces: ['DOC'] }, 'WRITE_DISABLED'],
    [{ allow_write: true, readOnly: true, writeSpaces: ['DOC'] }, 'WRITE_DISABLED'],
    [{ allow_write: true, readOnly: false }, 'WRITE_SCOPE_REQUIRED'],
    [{ allow_write: true, readOnly: false, writeSpaces: [] }, 'WRITE_SCOPE_REQUIRED']]) {
    const { service, requests } = setup(gate);
    for (const [name, args] of [['create_page', CREATE], ['update_page', UPDATE], ['patch_page', PATCH]])
      await assert.rejects(service.call(name, { ...args, dry_run: false }), { code });
    assert.deepEqual(requests, []);
  }
});
test('scope applies to previews and actual pages, including second-read moves', async () => {
  const gate = { allow_write: true, readOnly: false, writeSpaces: ['OTHER'] };
  const { service, requests } = setup(gate);
  for (const [name, args] of [['create_page', CREATE], ['update_page', UPDATE], ['patch_page', PATCH]])
    await assert.rejects(service.call(name, args), { code: 'SPACE_NOT_ALLOWED' });
  assert.equal(requests.length, 2);
  const moved = { ...PAGE, space: { key: 'OTHER' } };
  const next = setup(undefined, [PAGE, moved]);
  await assert.rejects(next.service.call('patch_page', { ...PATCH, dry_run: false }), { code: 'SPACE_NOT_ALLOWED' });
  assert.deepEqual(next.requests.map(v => v.method), ['GET', 'GET']);
});
test('create/update/patch commit once with their reviewed exact payload', async () => {
  for (const [name, args, methods] of [['create_page', CREATE, ['GET', 'POST']],
    ['update_page', UPDATE, ['GET', 'PUT']], ['patch_page', PATCH, ['GET', 'GET', 'PUT']]]) {
    const { service, requests } = setup();
    const preview = await service.call(name, args); requests.length = 0;
    const result = await service.call(name, { ...args, dry_run: false, preview_hash: preview.preview_hash });
    assert.equal(result.executed, true); assert.equal(result.dry_run, false);
    assert.deepEqual(requests.map(v => v.method), methods); assert.deepEqual(requests.at(-1).payload, preview.payload);
    assert.equal(result.page.version.number, name === 'create_page' ? 1 : 8);
    requests.length = 0;
    await assert.rejects(service.call(name, { ...args, body_storage: '<p>Changed</p>', dry_run: false,
      preview_hash: preview.preview_hash }), { code: 'PREVIEW_MISMATCH' });
    assert.ok(requests.every(v => v.method === 'GET'));
  }
});
test('published-page identity, parent space, duplicate, version and missing storage preflights are fail closed', async () => {
  for (const bad of [{ ...PAGE, type: 'blogpost' }, { ...PAGE, status: 'draft' }, { ...PAGE, status: 'trashed' }, { ...PAGE, id: '999' }]) {
    const { service, requests } = setup(undefined, [bad]);
    await assert.rejects(service.call('update_page', UPDATE), { code: 'READ_FAILED' });
    assert.ok(requests.every(v => v.method === 'GET'));
  }
  for (const [name, args, responses, code] of [
    ['create_page', { ...CREATE, parent_id: '123' }, [{ ...PAGE, space: { key: 'OTHER' } }], 'SPACE_NOT_ALLOWED'],
    ['create_page', CREATE, [{ results: [PAGE] }], 'READ_FAILED'],
    ['create_page', CREATE, [{}], 'READ_FAILED'],
    ['update_page', UPDATE, [{ ...PAGE, version: { number: 6 } }], 'VERSION_CONFLICT'],
    ['update_page', UPDATE, [{ ...PAGE, version: { number: true } }], 'VERSION_CONFLICT'],
    ['update_page', UPDATE, [{ ...PAGE, version: {} }], 'VERSION_CONFLICT'],
    ['update_page', UPDATE, [{ ...PAGE, body: {} }], 'READ_FAILED'],
    ['update_page', UPDATE, [{ ...PAGE, space: {} }], 'READ_FAILED'],
    ['patch_page', PATCH, [{ ...PAGE, body: {} }], 'CONTENT_INCOMPLETE'],
    ['patch_page', PATCH, [PAGE, { ...PAGE, body: { storage: { value: 'Changed at same version' } } }], 'VERSION_CONFLICT'],
    ['patch_page', PATCH, [PAGE, { ...PAGE, title: 'Changed at same version' }], 'VERSION_CONFLICT'],
  ]) {
    const { service, requests } = setup(undefined, responses);
    await assert.rejects(service.call(name, { ...args, dry_run: false }), { code });
    assert.ok(requests.every(v => v.method === 'GET'));
  }
});
test('invalid runtime inputs never reach transport', async () => {
  const invalidCreate = [null, [], {}, { ...CREATE, other: true }, { ...CREATE, restrictions: {} },
    ...['', ' ', 7, 'x'.repeat(256), '\ud800'].map(title => ({ ...CREATE, title })),
    ...['', {}, '\0', '\ud800', 'x'.repeat(1048577), '中'.repeat(349526)].map(body_storage => ({ ...CREATE, body_storage })),
    ...[0, 'false', null].map(dry_run => ({ ...CREATE, dry_run })),
    ...[123, true, '0', '1'.repeat(256), '../1'].map(parent_id => ({ ...CREATE, parent_id }))];
  const { service, requests } = setup();
  for (const args of invalidCreate) await assert.rejects(service.call('create_page', args), { code: 'INVALID_ARGUMENT' });
  for (const expected_version of [true, false, 0, -1, 7.5, '7', null])
    await assert.rejects(service.call('update_page', { ...UPDATE, expected_version }), { code: 'INVALID_ARGUMENT' });
  for (const args of [{ ...UPDATE, ancestors: [] }, { ...UPDATE, space_key: 'OTHER' }, { ...PATCH, operation: 'delete' }])
    await assert.rejects(service.call(args.operation ? 'patch_page' : 'update_page', args), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(requests, []);
});
test('preview accepts native Unicode title/body limits and bounds patch diff in code points', async () => {
  const { service } = setup();
  const title = '😀'.repeat(255), body_storage = 'x'.repeat(1048576);
  const create = await service.call('create_page', { ...CREATE, title, body_storage });
  assert.equal(create.payload.title, title); assert.equal(create.payload.body.storage.value, body_storage);
  const old = '<p>' + '😀'.repeat(7000) + '</p>', body = '<p>' + '界'.repeat(7000) + '</p>';
  const page = { ...PAGE, body: { storage: { value: old } } };
  const next = setup(undefined, [page, page]);
  const result = await next.service.call('patch_page', { ...PATCH, old_fragment: old, body_storage: body });
  assert.equal(result.diff_truncated, true); assert.equal([...result.diff].length, 12000);
  assert.ok(!/\p{Surrogate}/u.test(result.diff));
  assert.deepEqual(next.requests.map(v => v.method), ['GET', 'GET']);
});
test('uncertain/error/malformed responses are never retried and never leak raw errors', async () => {
  const good = { ...PAGE, title: 'After', version: { number: 8 } };
  for (const response of [null, [], 'secret-response', {}, { ...good, id: '999' },
    ...[null, [], 'secret-response', true, '8'].map(version => ({ ...good, version })),
    new ReadError('WRITE_UNCERTAIN'), new Error('password=secret')]) {
    const { service, requests } = setup(undefined, [PAGE, response]);
    await assert.rejects(service.call('update_page', { ...UPDATE, dry_run: false }), error => {
      assert.equal(error.code, 'WRITE_UNCERTAIN'); assert.equal(error.details().retryable, false);
      assert.ok(!error.message.includes('secret')); return true;
    });
    assert.deepEqual(requests.map(v => v.method), ['GET', 'PUT']);
  }
  const conflict = setup(undefined, [PAGE, new ReadError('VERSION_CONFLICT', 409)]);
  await assert.rejects(conflict.service.call('update_page', { ...UPDATE, dry_run: false }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(conflict.requests.map(v => v.method), ['GET', 'PUT']);
  for (const space of [null, [], 'secret-response', {}]) {
    const next = setup(undefined, [{ results: [] }, { ...good, id: '456', space }]);
    await assert.rejects(next.service.call('create_page', { ...CREATE, dry_run: false }), { code: 'WRITE_UNCERTAIN' });
    assert.deepEqual(next.requests.map(v => v.method), ['GET', 'POST']);
  }
});
