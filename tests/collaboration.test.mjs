import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import { Confluence, tools } from '../dist/confluence.js';
import { RestClient, allowedRoute, sendJson } from '../dist/rest.js';
import { ReadError } from '../dist/errors.js';
import { createServer } from '../dist/server.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const base = 'https://example.com/confluence';
const credential = { username: 'fixture', password: 'synthetic' };
const page = id => ({ id, type: 'page', status: 'current', title: 'Source', space: { key: 'DOC' },
  version: { number: 7 }, ancestors: [], body: { storage: { value: '<p>Original</p>' } } });
const cases = [
  ['add_labels', { labels: ['release', '需求'] }], ['remove_label', { label: 'release/a' }],
  ['add_comment', { body_storage: '<p>Review question</p>' }], ['copy_page', { space_key: 'DOC', title: 'Copy', parent_id: '456' }],
  ['move_page', { parent_id: '456' }],
];
function setup(config = { allow_write: true, readOnly: false, policy: { write_spaces: ['DOC'] } }, change = () => {}) {
  const requests = [];
  const rest = new RestClient(base, 1, async () => credential, async (url, _c, _timeout, options = {}) => {
    const method = options.method ?? 'GET', path = url.pathname.slice('/confluence/rest/api/'.length);
    requests.push({ method, path, query: url.searchParams, ...options });
    let result;
    if (method === 'GET') {
      if (path === 'content/search' || path.endsWith('/child/attachment')) result = { results: [] };
      else if (path.endsWith('/label')) result = { results: [{ id: '9', name: 'release', prefix: 'global', private: 'discard' }], _links: { next: '/rest/api/content/123/label?start=1' } };
      else result = page(path.split('/')[1]);
    } else if (method === 'DELETE') result = {};
    else if (path.endsWith('/label')) result = { results: options.payload };
    else if (path.endsWith('/child/attachment')) result = { results: [{ id: '999', type: 'attachment', title: options.payload.filename, version: { number: 1 }, container: { id: '123' } }] };
    else if (options.payload.type === 'comment') result = { id: '888', type: 'comment', status: 'current', container: { id: '123' } };
    else result = { ...page(method === 'POST' ? '789' : '123'), ...options.payload };
    change(result, requests.at(-1), requests);
    return result;
  });
  return { api: new Confluence(rest, config), rest, requests };
}
test('label reads paginate, discard extra metadata and reject wrong page versions', async () => {
  const { api, requests } = setup();
  const result = await api.call('get_labels', { pageId: '123', expected_version: 7 });
  assert.deepEqual(result.results, [{ id: '9', name: 'release', prefix: 'global' }]);
  assert.equal(result.pagination.next_start, 1); assert.equal(result.scope, 'global_labels');
  assert.ok(result.warnings.includes('page_version_does_not_pin_label_changes'));
  await assert.rejects(api.call('get_labels', { pageId: '123', expected_version: 8 }), { code: 'PAGE_VERSION_CHANGED' });
  assert.equal(requests.length, 3);
});
test('all collaboration previews issue only GET, retain exact content and bind changed requests', async () => {
  for (const [name, extra] of cases) {
    const { api, requests } = setup();
    const args = { pageId: '123', expected_version: 7, ...extra };
    const preview = await api.call(name, args);
    assert.equal(preview.dry_run, true); assert.equal(preview.executed, false);
    assert.match(preview.preview_hash, /^[a-f0-9]{64}$/); assert.ok(requests.every(r => r.method === 'GET'));
    if (name === 'copy_page') assert.equal(preview.payload.body.storage.value, '<p>Original</p>');
    if (name === 'move_page') {
      assert.deepEqual(preview.payload.ancestors, [{ id: '456' }]); assert.equal(preview.payload.body, undefined);
      assert.equal(preview.after.body_storage, '<p>Original</p>');
    }
    if (name === 'remove_label') assert.equal(new URL(preview.url).searchParams.get('name'), 'release/a');
    const result = await api.call(name, { ...args, dry_run: false, preview_hash: preview.preview_hash });
    assert.equal(result.executed, true); assert.equal(requests.filter(r => r.method !== 'GET').length, 1);
    await assert.rejects(api.call(name, { ...args, dry_run: false, preview_hash: '0'.repeat(64) }), { code: 'PREVIEW_MISMATCH' });
    assert.equal(requests.filter(r => r.method !== 'GET').length, 1);
  }
});
test('new writes obey read-only, scope and enabled-tool gates before mutation', async () => {
  for (const [name, extra] of [...cases, ['upload_attachment', { file_path: '/not-read.txt' }]]) {
    const args = { pageId: '123', expected_version: 7, ...extra };
    const closed = setup({ allow_write: false, readOnly: true });
    await assert.rejects(closed.api.call(name, { ...args, dry_run: false }), { code: 'WRITE_DISABLED' }); assert.equal(closed.requests.length, 0);
    const scoped = setup({ allow_write: true, readOnly: false, policy: { write_spaces: ['OTHER'] } });
    await assert.rejects(scoped.api.call(name, args), { code: 'SPACE_NOT_ALLOWED' }); assert.ok(scoped.requests.every(r => r.method === 'GET'));
    const disabled = setup({ policy: { enabled_tools: ['get_page'] } });
    await assert.rejects(disabled.api.call(name, args), { code: 'TOOL_DISABLED' }); assert.equal(disabled.requests.length, 0);
  }
});
test('collaboration inputs reject duplicates, invalid labels and non-absolute files before credentials', async () => {
  const { api, requests } = setup();
  for (const [name, extra] of [['add_labels', { labels: ['x', 'x'] }], ['add_labels', { labels: Array.from({ length: 21 }, (_, i) => 'l' + i) }],
    ['remove_label', { label: 'a\r\nb' }], ['add_comment', { body_storage: ' ' }], ['move_page', { parent_id: '0' }],
    ['upload_attachment', { file_path: 'relative.txt' }]])
    await assert.rejects(api.call(name, { pageId: '123', expected_version: 7, ...extra }), { code: 'INVALID_ARGUMENT' });
  assert.equal(requests.length, 0);
});
test('move rejects cycles, cross-space parents and version/space changes during preflight', async () => {
  const args = { pageId: '123', parent_id: '456', expected_version: 7, dry_run: false };
  for (const mutate of [
    (result, req) => { if (req.path === 'content/456') result.ancestors = [{ id: '123' }]; },
    (result, req) => { if (req.path === 'content/456') result.space.key = 'OTHER'; },
    (result, req, requests) => { if (req.path === 'content/123' && requests.length > 1) result.version.number = 8; },
  ]) {
    const { api, requests } = setup(undefined, mutate);
    await assert.rejects(api.call('move_page', args)); assert.ok(requests.every(r => r.method === 'GET'));
  }
  const { api, requests } = setup();
  await assert.rejects(api.call('move_page', { ...args, parent_id: '123' }), { code: 'INVALID_ARGUMENT' });
  assert.ok(requests.every(r => r.method === 'GET'));
});
test('new write response mismatch, 5xx and lost acknowledgement never retry or leak raw errors', async () => {
  for (const [name, extra] of cases) {
    for (const mode of ['malformed', 'network']) {
      const { api, requests } = setup(undefined, (result, req) => {
        if (req.method !== 'GET') {
          if (mode === 'network') throw new Error('synthetic-private-response');
          if (name === 'remove_label') throw new ReadError('WRITE_UNCERTAIN', 503);
          else if (name === 'add_labels') result.results = [];
          else result.id = 'wrong';
        }
      });
      await assert.rejects(api.call(name, { pageId: '123', expected_version: 7, ...extra, dry_run: false }), error => {
        assert.equal(error.code, 'WRITE_UNCERTAIN'); assert.equal(error.details().retryable, false);
        assert.ok(!JSON.stringify(error.details()).includes('synthetic-private-response')); return true;
      });
      assert.equal(requests.filter(r => r.method !== 'GET').length, 1);
    }
  }
});
test('comment confirmation failure after creation is uncertain; move omits body even for empty pages', async () => {
  const comment = setup(undefined, (result, req) => {
    if (req.method === 'POST') delete result.container;
    if (req.path === 'content/888' && req.method === 'GET') throw new ReadError('ACCESS_DENIED', 403);
  });
  await assert.rejects(comment.api.call('add_comment', { pageId: '123', expected_version: 7, body_storage: '<p>Question</p>', dry_run: false }), { code: 'WRITE_UNCERTAIN' });
  assert.equal(comment.requests.filter(r => r.method === 'POST').length, 1);
  const empty = setup(undefined, (result, req) => { if (req.method === 'GET' && result.body) result.body.storage.value = ''; });
  const moved = await empty.api.call('move_page', { pageId: '123', expected_version: 7, parent_id: '456', dry_run: false });
  assert.equal(moved.executed, true); assert.equal(empty.requests.at(-1).payload.body, undefined);
});
test('upload previews bind local bytes, refuse duplicates and bound files without exposing paths or data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'confluence-upload-'));
  try {
    const file = join(directory, '图表 file.bin'), bytes = Buffer.from([0, 255, 13, 10]); writeFileSync(file, bytes);
    const args = { pageId: '123', expected_version: 7, file_path: file };
    const { api, requests } = setup(); const preview = await api.call('upload_attachment', args);
    assert.equal(preview.payload.size, bytes.length); assert.equal(preview.payload.filename, '图表 file.bin');
    assert.ok(!JSON.stringify(preview).includes(directory)); assert.ok(!JSON.stringify(preview).includes(bytes.toString('base64')));
    assert.ok(requests.every(r => r.method === 'GET'));
    const result = await api.call('upload_attachment', { ...args, dry_run: false, preview_hash: preview.preview_hash });
    assert.equal(result.executed, true); assert.deepEqual(requests.at(-1).file, bytes);
    assert.equal(requests.at(-1).query.get('allowDuplicated'), 'false');
    assert.equal(requests.at(-1).query.get('expand'), 'container,version');
    writeFileSync(file, Buffer.from([0, 254, 13, 10]));
    await assert.rejects(api.call('upload_attachment', { ...args, dry_run: false, preview_hash: preview.preview_hash }), { code: 'PREVIEW_MISMATCH' });
    assert.equal(requests.filter(r => r.method !== 'GET').length, 1);
    const duplicate = setup(undefined, (result, req) => { if (req.path.endsWith('/child/attachment') && req.method === 'GET') result.results = [{ id: '77' }]; });
    await assert.rejects(duplicate.api.call('upload_attachment', args), { code: 'TARGET_EXISTS' });
    for (const mode of ['container', 'version', 'network']) {
      const failed = setup(undefined, (result, req) => {
        if (req.method === 'POST') {
          if (mode === 'network') throw new Error('synthetic-private-upload-error');
          if (mode === 'container') result.results[0].container.id = '456';
          if (mode === 'version') result.results[0].version.number = 2;
        }
      });
      await assert.rejects(failed.api.call('upload_attachment', { ...args, dry_run: false }), { code: 'WRITE_UNCERTAIN' });
      assert.equal(failed.requests.filter(r => r.method === 'POST').length, 1);
    }
    await assert.rejects(api.call('upload_attachment', { ...args, file_path: directory }), { code: 'FILE_INVALID' });
    truncateSync(file, 4 * 1048576 + 1);
    await assert.rejects(api.call('upload_attachment', args), { code: 'FILE_TOO_LARGE' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('route and payload checks confine DELETE to one named label and multipart to attachment creation', async () => {
  assert.ok(allowedRoute(base, base + '/rest/api/content/123/label?name=a%2Fb', 'DELETE'));
  for (const [path, method] of [['content/123', 'DELETE'], ['space/DOC', 'DELETE'], ['content/123/label', 'DELETE'],
    ['content/123/label?name=a&name=b', 'DELETE'], ['content/123/label?name=a&x=b', 'DELETE'], ['content/123/child/attachment/5/data', 'POST'],
    ['content/123/child/attachment', 'POST'], ['content/123/child/attachment?allowDuplicated=true&expand=container,version', 'POST']])
    assert.throws(() => allowedRoute(base, base + '/rest/api/' + path, method), { code: 'INVALID_ROUTE' });
  let loads = 0;
  const rest = new RestClient(base, 1, async () => { loads++; return credential; });
  await assert.rejects(rest.write('POST', 'content/123/label', [{ name: 'x', prefix: 'team' }]), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(rest.write('DELETE', 'content/123/label?name=x', { delete_all: true }), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(rest.write('POST', 'content', null), { code: 'INVALID_PAYLOAD' });
  await assert.rejects(rest.write('PUT', 'content/123', { id: '123', type: 'page', title: 'Keep', version: { number: 8 }, ancestors: [] }), { code: 'INVALID_PAYLOAD' });
  assert.equal(loads, 0);
});
test('actual native transport sends bounded multipart bytes and handles bodyless label deletion', async t => {
  let observed;
  t.mock.method(https, 'request', (url, options) => {
    const request = new EventEmitter(); request.destroy = () => request;
    request.end = data => queueMicrotask(() => {
      observed = { url, options, data };
      const response = new PassThrough(); response.statusCode = options.method === 'DELETE' ? 204 : 200;
      response.headers = options.method === 'DELETE' ? {} : { 'content-type': 'application/json' };
      request.emit('response', response); response.end(options.method === 'DELETE' ? undefined : '{}');
    });
    return request;
  });
  const directory = mkdtempSync(join(tmpdir(), 'confluence-multipart-'));
  try {
    const file = join(directory, 'binary.bin'), bytes = Buffer.from([0, 255, 10, 13]); writeFileSync(file, bytes);
    const { api } = setup(); const preview = await api.call('upload_attachment', { pageId: '123', expected_version: 7, file_path: file });
    await sendJson(new URL(preview.url), credential, 1, { method: 'POST', payload: preview.payload, file: bytes });
    assert.ok(observed.data.includes(bytes)); assert.equal(Number(observed.options.headers['Content-Length']), observed.data.length);
    assert.equal(observed.options.headers['X-Atlassian-Token'], 'nocheck'); assert.match(observed.options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    assert.deepEqual(await sendJson(new URL(base + '/rest/api/content/123/label?name=x'), credential, 1, { method: 'DELETE', payload: {} }), {});
    assert.equal(observed.data, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('SDK discovers added tools and honors enabled-tool policy on actual calls', async () => {
  const { api } = setup({ policy: { enabled_tools: ['get_labels', 'add_comment'] } });
  const server = createServer(api), [client, transport] = InMemoryTransport.createLinkedPair();
  let id = 0;
  const call = (method, params) => new Promise(resolve => { const requestId = ++id; client.onmessage = message => { if (message.id === requestId) resolve(message.result); }; client.send({ jsonrpc: '2.0', id: requestId, method, params }); });
  try {
    await client.start(); await server.connect(transport);
    assert.deepEqual((await call('tools/list', {})).tools.map(t => t.name), ['get_labels', 'add_comment']);
    const result = await call('tools/call', { name: 'add_comment', arguments: { pageId: '123', expected_version: 7, body_storage: '<p>Question</p>' } });
    assert.equal(JSON.parse(result.content[0].text).executed, false);
    assert.equal(tools.length, 19);
  } finally { await server.close(); await client.close(); }
});
