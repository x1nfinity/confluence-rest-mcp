import test from 'node:test';
import assert from 'node:assert/strict';
import { Confluence } from '../dist/confluence.js';
import { RestClient, allowedRoute } from '../dist/rest.js';
import { isTextAttachment, readTextAttachment } from '../dist/attachments.js';

const base = 'https://example.com/confluence';
const load = async () => ({ username: 'fixture', password: 'synthetic' });
const page = { id: '123', type: 'page', status: 'current', title: 'Before', space: { key: 'DOC' },
  version: { number: 7 }, body: { storage: { value: '<p>Before</p>' } } };

test('invalid patch selectors are rejected before credentials, resolution or transport', async () => {
  let loads = 0, sends = 0;
  const api = new Confluence(new RestClient(base, 1, async () => { loads++; return load(); }, async () => { sends++; return page; }));
  const common = { pageId: base + '/display/DOC/Before', body_storage: '<p>After</p>', expected_version: 7 };
  for (const args of [{ ...common, operation: 'append', old_fragment: '<p>Before</p>' }, { ...common, operation: 'replace' }])
    await assert.rejects(api.call('patch_page', args), { code: 'INVALID_ARGUMENT' });
  assert.equal(loads, 0); assert.equal(sends, 0);
});

test('explicit empty write spaces deny previews while absent scope keeps legacy previews', async () => {
  let writes = 0;
  const rest = new RestClient(base, 1, load, async (_u, _c, _t, options) => {
    if (options?.method) writes++;
    return _u.pathname.endsWith('/search') ? { results: [] } : page;
  });
  const common = { body_storage: '<p>After</p>', expected_version: 7 };
  const cases = [['create_page', { space_key: 'DOC', title: 'New', body_storage: common.body_storage }],
    ['update_page', { ...common, pageId: '123', title: 'After' }],
    ['patch_page', { ...common, pageId: '123', operation: 'append' }]];
  const empty = new Confluence(rest, { policy: { write_spaces: [] } });
  for (const [name, args] of cases) await assert.rejects(empty.call(name, args), { code: 'SPACE_NOT_ALLOWED' });
  const absent = new Confluence(rest);
  for (const [name, args] of cases) assert.equal((await absent.call(name, args)).dry_run, true);
  assert.equal(writes, 0);
});

test('attachment MIME lookup only accepts owned whitelist entries', () => {
  for (const mime of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(isTextAttachment('unknown.bin', mime), false);
    assert.throws(() => readTextAttachment(Buffer.from('plain data'), 'unknown.bin', mime), { code: 'NOT_SUPPORTED' });
  }
  assert.equal(readTextAttachment(Buffer.from('plain data'), 'notes.txt', 'constructor').media_type, 'text/plain');
});

test('download routes accept literal percent filenames while rejecting encoded traversal and invalid UTF-8', async () => {
  for (const name of ['100%.txt', 'notes%done.txt', '%ZZ.txt', 'literal%25.txt'])
    assert.equal(allowedRoute(base, base + '/download/attachments/123/' + encodeURIComponent(name), 'GET', true).pathname,
      '/confluence/download/attachments/123/' + encodeURIComponent(name));
  for (const path of ['%252f.txt', '%255c.txt', '%252e%252e', '%FF.txt'])
    assert.throws(() => allowedRoute(base, base + '/download/attachments/123/' + path, 'GET', true), { code: 'INVALID_ROUTE' });
  let downloaded;
  const a = { id: '5', type: 'attachment', title: '100%.txt', version: { number: 2 }, container: { id: '123' },
    _links: { download: '/confluence/download/attachments/123/100%25.txt' } };
  const api = new Confluence(new RestClient(base, 1, load, async () => a, async u => { downloaded = u; return Buffer.from('plain data'); }));
  assert.equal((await api.call('get_attachments', { pageId: '123', attachmentId: '5', read_content: true })).text, 'plain data');
  assert.equal(downloaded.searchParams.get('version'), '2');
});

test('malformed historic version objects preserve Python PAGE_VERSION_CHANGED error', async () => {
  for (const version of [[], 'invalid', {}, { number: true }, { number: '1' }]) {
    const api = new Confluence(new RestClient(base, 1, load, async () => ({ id: '123', type: 'page', version, body: { storage: { value: 'text' } } })));
    await assert.rejects(api.call('compare_page_versions', { pageId: '123', from_version: 1, to_version: 2 }), { code: 'PAGE_VERSION_CHANGED' });
  }
});
