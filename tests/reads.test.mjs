import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDocument } from '../dist/document.js';
import { Confluence, tools } from '../dist/confluence.js';
import { RestClient } from '../dist/rest.js';
import { ReadError } from '../dist/errors.js';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/reads.json', import.meta.url)));
const base = 'https://example.com/confluence';
const credential = async () => ({ username: 'test-user', password: 'synthetic-password' });
const code = expected => error => error.code === expected;
function page(html, version = 7) { return { id: '123', type: 'page', status: 'current', title: 'Synthetic PRD',
  version: { number: version, when: '2026-10-12T00:00:00Z' }, space: { key: 'DEMO', name: 'Demo' },
  body: { view: { value: html } }, ancestors: [], metadata: { labels: { results: [] } }, _links: {} }; }
for (const fixture of baseline.fixtures) test('Python text and headings parity: ' + fixture.name, () => {
  const parsed = parseDocument(fixture.html, base, '123', 'view');
  assert.equal(parsed.text, fixture.text); assert.deepEqual(parsed.sections, fixture.sections);
});
test('full catalog preserves twelve original schemas and annotations', () => {
  const contract = ({ description, ...tool }) => tool;
  assert.deepEqual(tools.slice(0, baseline.tools.length).map(contract), baseline.tools.map(contract));
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
});
test('invalid requests across full catalog are rejected before network access', async () => {
  let sent = 0; const api = new Confluence(new RestClient(base, 1, credential, async () => { sent++; return {}; }));
  for (const [name, args] of [['get_page', { pageId: '123', offset: true }], ['get_page', { pageId: '123', extra: 1 }],
    ['search_pages', {}], ['search_pages', { keyword: 'x', cql: 'type=page' }],
    ['search_pages', { keyword: 'x', updated_after: '2026-02-30' }], ['search_pages', { cql: 'x', labels: ['x'] }],
    ['get_attachments', { pageId: '123', expected_version: 1 }], ['update_page', { pageId: '123' }],
    ['get_page_section', { pageId: '123', section_title: 'x', section_ordinal: 1 }],
    ['get_attachments', { pageId: '123', read_content: true }]]) await assert.rejects(api.call(name, args), code('INVALID_ARGUMENT'));
  assert.equal(sent, 0);
});
test('Unicode pagination pins whole-document hash and checks fresh permissions every chunk', async () => {
  const fixture = baseline.fixtures.find(f => f.name === 'long_unicode');
  let sent = 0, current = page(fixture.html);
  const api = new Confluence(new RestClient(base, 1, credential, async () => { sent++; if (current instanceof Error) throw current; return current; }));
  let first = await api.call('get_page', { pageId: '123', max_chars: 500 });
  const chunks = [first.text]; let next = first.content.next_offset;
  while (next !== null) {
    const result = await api.call('get_page', { pageId: '123', max_chars: 500, offset: next,
      expected_version: 7, expected_content_hash: first.content.content_hash });
    assert.equal(result.content.returned_chars, [...result.text].length);
    chunks.push(result.text); next = result.content.next_offset;
  }
  assert.equal(chunks.join(''), fixture.text); assert.ok(sent > 1);
  current = page('<p>changed</p>');
  await assert.rejects(api.call('get_page', { pageId: '123', expected_content_hash: first.content.content_hash }), code('PAGE_VERSION_CHANGED'));
  current = page(fixture.html, 8);
  await assert.rejects(api.call('get_page', { pageId: '123', expected_version: 7 }), code('PAGE_VERSION_CHANGED'));
  current = new ReadError('ACCESS_DENIED'); await assert.rejects(api.call('get_page', { pageId: '123' }), code('ACCESS_DENIED'));
});
test('storage fallback rejects changed version and wrong identity rather than empty success', async () => {
  const first = { ...page(''), body: {} };
  let second = { ...page(''), body: { storage: { value: '<p>source</p>' } } };
  const api = new Confluence(new RestClient(base, 1, credential, async url => url.searchParams.get('expand').includes('body.view') ? first : second));
  const result = await api.call('get_page', { pageId: '123' });
  assert.equal(result.text, 'source'); assert.equal(result.content.representation, 'storage');
  second = { ...second, id: '456' }; await assert.rejects(api.call('get_page', { pageId: '123' }), code('CONTENT_INCOMPLETE'));
  second = { ...second, id: '123', version: { number: 8 } }; await assert.rejects(api.call('get_page', { pageId: '123' }), code('PAGE_VERSION_CHANGED'));
});
test('keyword filters preserve CQL escaping and pagination', async () => {
  let request;
  const api = new Confluence(new RestClient(base, 1, credential, async url => { request = url;
    return { results: [page('')], start: 10, limit: 2, size: 1, _links: { next: '/confluence/rest/api/content/search?start=11' } }; }));
  const result = await api.call('search_pages', { keyword: 'quote"中文', space_key: 'DEMO', labels: ['a', 'b'],
    title_only: true, updated_after: '2026-10-01', order_by: 'lastmodified_desc', start: 10, limit: 2 });
  assert.equal(request.searchParams.get('cql'), 'type = page AND title ~ "quote\\\"中文" AND space = "DEMO" AND label = "a" AND label = "b" AND lastmodified >= "2026-10-01" ORDER BY lastmodified desc');
  assert.equal(result.pagination.next_start, 11);
});
test('same-site display links resolve uniquely; cross-site links never request', async () => {
  let requests = 0;
  const api = new Confluence(new RestClient(base, 1, credential, async () => { requests++; return { results: [page('')], _links: {} }; }));
  assert.equal(await api.resolve(base + '/display/DEMO/Plan'), '123');
  const before = requests; await assert.rejects(api.resolve('https://other.example/confluence/pages/viewpage.action?pageId=123'), code('INVALID_ARGUMENT'));
  assert.equal(requests, before);
});
test('attachment list and single metadata pin container and version', async () => {
  const attachment = { id: '5', type: 'attachment', title: 'synthetic.txt', container: { id: '123' },
    version: { number: 2 }, extensions: { fileSize: 10, mediaType: 'text/plain' },
    _links: { download: '/download/attachments/123/synthetic.txt' } };
  const api = new Confluence(new RestClient(base, 1, credential, async url => url.pathname.endsWith('/child/attachment')
    ? { results: [attachment], _links: {} } : attachment));
  const result = await api.call('get_attachments', { pageId: '123' });
  assert.equal(result.results[0].download_url, base + '/download/attachments/123/synthetic.txt');
  assert.equal((await api.call('get_attachments', { pageId: '123', attachmentId: '5', expected_version: 2 })).name, 'synthetic.txt');
  attachment.container.id = '456';
  await assert.rejects(api.call('get_attachments', { pageId: '123', attachmentId: '5' }), code('CONTENT_INCOMPLETE'));
});
