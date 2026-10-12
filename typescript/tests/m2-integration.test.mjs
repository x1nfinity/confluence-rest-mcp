import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configuration, policy } from '../dist/config.js';
import { Confluence, tools } from '../dist/confluence.js';
import { RestClient, allowedRoute, httpError } from '../dist/rest.js';
import { unifiedDiff } from '../dist/history.js';
import { createServer } from '../dist/server.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { ReadError } from '../dist/errors.js';
const base = 'https://example.com/confluence', load = async () => ({ username: 'fixture', password: 'synthetic' });
const code = expected => e => e.code === expected;
const page = html => ({ id: '123', type: 'page', status: 'current', title: 'Fixture', space: { key: 'DEMO' }, version: { number: 2 }, body: { view: { value: html }, storage: { value: html } } });

test('policy validates all fields; discovery and direct calls use the same startup snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-policy-'));
  try {
    const env = { CONFLUENCE_BASE_URL: base, CONFLUENCE_READ_ONLY: 'false' };
    assert.equal(configuration(env, directory).allow_write, false);
    for (const bad of [{ unknown: [] }, { enabled_tools: ['missing'] }, { enabled_tools: ['get_page', 'get_page'] },
      { write_spaces: ['*'] }, { write_spaces: [1] }, { enabled_tools: null }, { write_spaces: ['DEMO', 'DEMO'] }]) {
      writeFileSync(join(directory, 'policy.json'), JSON.stringify(bad)); assert.throws(() => policy(directory), code('POLICY_INVALID'));
    }
    writeFileSync(join(directory, 'policy.json'), JSON.stringify({ enabled_tools: [], write_spaces: [] }));
    let sent = 0; const api = new Confluence(new RestClient(base, 1, load, async () => { sent++; return {}; }), configuration(env, directory));
    assert.equal(api.tools.length, 0);
    await assert.rejects(api.call('get_page', { pageId: '123' }), code('TOOL_DISABLED')); assert.equal(sent, 0);
    writeFileSync(join(directory, 'policy.json'), JSON.stringify({ enabled_tools: ['get_page'], write_spaces: ['DEMO'] }));
    assert.equal(api.tools.length, 0);
    assert.deepEqual(new Confluence(new RestClient(base, 1, load), configuration(env, directory)).tools.map(t => t.name), ['get_page']);
    assert.equal(tools.length, 12);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('expanded REST routes remain method and download scoped', () => {
  for (const path of ['content', 'content/123/child/page', 'content/123/child/comment', 'content/123/descendant/comment']) assert.ok(allowedRoute(base, base + '/rest/api/' + path));
  assert.ok(allowedRoute(base, base + '/rest/api/content', 'POST'));
  assert.ok(allowedRoute(base, base + '/rest/api/content/123', 'PUT'));
  assert.ok(allowedRoute(base, base + '/download/attachments/123/a%20b.txt?version=2', 'GET', true));
  for (const path of ['a%2Fb.txt', '%252e%252e', 'a%255cb.txt', '%00.txt', '..'])
    assert.throws(() => allowedRoute(base, base + '/download/attachments/123/' + path, 'GET', true), code('INVALID_ROUTE'));
  for (const [path, method] of [['content/123', 'POST'], ['content', 'PUT'], ['content/123?x=1', 'PUT'], ['content/123/child/page', 'DELETE']])
    assert.throws(() => allowedRoute(base, base + '/rest/api/' + path, method), code('INVALID_ROUTE'));
});

test('full read tools pin fresh responses and return structure/sections/source positions', async () => {
  let calls = 0, current = page('<h1 id="first">😀Plan</h1><p>Rule</p><h2>Child</h2><table><tr><td colspan="2">A</td></tr></table><h1>End</h1>');
  const api = new Confluence(new RestClient(base, 1, load, async () => { calls++; return current; }));
  const p = await api.call('get_page', { pageId: '123', include_structure: true });
  assert.equal(p.structure.tables.length, 1); assert.equal(p.content.coverage.scope, 'provided_html_only');
  const s = await api.call('get_page_section', { pageId: '123', section_anchor: 'first', expected_version: 2, expected_content_hash: p.content.content_hash });
  assert.ok(s.text.includes('Child')); assert.ok(!s.text.includes('End')); assert.equal(s.content.is_full_document, false);
  const found = await api.call('find_page_text', { pageId: '123', keyword: 'Rule' });
  const m = found.matches[0]; assert.equal([...p.text].slice(m.text_start, m.text_end).join(''), 'Rule');
  const structure = await api.call('get_page_structure', { pageId: '123', kind: 'tables' });
  assert.deepEqual(JSON.parse(structure.text), p.structure.tables);
  current = page('<h1>Changed</h1>');
  await assert.rejects(api.call('get_page_structure', { pageId: '123', expected_content_hash: structure.content.content_hash }), code('PAGE_VERSION_CHANGED'));
  assert.equal(calls, 5);
});

test('separate comments discard identity metadata and preserve discussion scope', async () => {
  let request;
  const api = new Confluence(new RestClient(base, 1, load, async url => { request = url; return { results: [{ id: '456', type: 'comment', version: { number: 3, when: 'date', by: { username: 'synthetic-hidden-user' } }, body: { view: { value: '<p>Discussion</p>' } }, extensions: { resolution: { status: 'resolved', by: 'synthetic-hidden-user' } } }] }; }));
  const result = await api.call('get_comments', { pageId: '123', include_replies: true });
  assert.equal(result.scope, 'comment_descendants'); assert.equal(result.content_scope, 'discussion');
  assert.equal(result.results[0].text, 'Discussion'); assert.ok(request.pathname.endsWith('/descendant/comment'));
  assert.ok(!JSON.stringify(result).includes('synthetic-hidden-user'));
});

test('unified diff matches Python contexts, repeated lines and unterminated Unicode lines', () => {
  const pairs = [['', 'one'], ['one', 'one\n'], ['a\r\n', 'a\n'], ['😀\nx\n', '😀\ny\n'],
    ['a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'x\nb\nc\nd\ne\nf\ng\nh\ni\nz\n'],
    ['same\n'.repeat(220), 'new\n' + 'same\n'.repeat(220)], ['a\vB\u2028C', 'a\vX\u2028C']];
  let seed = 17; const rand = () => { seed = (seed * 48271) % 2147483647; return seed; };
  for (let i = 0; i < 50; i++) pairs.push([Array.from({ length: rand() % 25 }, () => String(rand() % 5) + '\n').join(''), Array.from({ length: rand() % 25 }, () => String(rand() % 5) + '\n').join('')]);
  const p = spawnSync('python3', ['-B', '-c', "import sys,json,difflib; pairs=json.load(sys.stdin); print(json.dumps([''.join(line if line.endswith('\\n') else line+'\\n\\\\ No newline at end of file\\n' for line in difflib.unified_diff(a.splitlines(keepends=True),b.splitlines(keepends=True),fromfile='before',tofile='after')) for a,b in pairs]))"], { input: JSON.stringify(pairs), encoding: 'utf8' });
  assert.equal(p.status, 0); const expected = JSON.parse(p.stdout);
  pairs.forEach(([a, b], i) => assert.equal(unifiedDiff(a, b, 'before', 'after'), expected[i], 'fixture ' + i));
});

test('write transport sends a single request and never retries uncertainty or conflicts', async () => {
  const payload = { id: '123', type: 'page', title: 'Fixture', body: { storage: { value: '<p>New</p>', representation: 'storage' } }, version: { number: 3 } };
  for (const error of [new ReadError('WRITE_UNCERTAIN'), new ReadError('VERSION_CONFLICT', 409)]) {
    let sent = 0; const rest = new RestClient(base, 1, load, async (_url, _c, _t, options) => { sent++; assert.equal(options.method, 'PUT'); throw error; });
    await assert.rejects(rest.write('PUT', 'content/123', payload), code(error.code)); assert.equal(sent, 1);
  }
  assert.equal(httpError(503, undefined, true).code, 'WRITE_UNCERTAIN'); assert.equal(httpError(503, undefined, true).details().retryable, false);
  let sent = 0; const rest = new RestClient(base, 1, load, async () => { sent++; return {}; });
  await assert.rejects(rest.write('PUT', 'content/123', { ...payload, space: { key: 'FAKE' } }), code('INVALID_PAYLOAD')); assert.equal(sent, 0);
});

test('attachment ownership is checked before binary transport; image block passes actual SDK handler', { timeout: 3000 }, async () => {
  let downloads = 0;
  const a = { id: '5', type: 'attachment', title: 'fixture.png', version: { number: 2 }, container: { id: '123' }, _links: { download: '/confluence/download/attachments/123/fixture.png' } };
  const rest = new RestClient(base, 1, load, async () => a, async () => { downloads++; return Buffer.from([137,80,78,71,13,10,26,10]); });
  const api = new Confluence(rest); const server = createServer(api), [client, transport] = InMemoryTransport.createLinkedPair();
  const pending = new Map(); let id = 0; client.onmessage = r => pending.get(r.id)?.(r);
  const call = async (method, params) => { const n = ++id; const result = new Promise(resolve => pending.set(n, resolve)); await client.send({ jsonrpc: '2.0', id: n, method, params }); return result; };
  await server.connect(transport); await client.start();
  try {
    await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const r = await call('tools/call', { name: 'get_attachments', arguments: { pageId: '123', attachmentId: '5', read_content: true, expected_version: 2 } });
    assert.equal(r.result.content[1].type, 'image'); assert.equal(r.result.content[1].mimeType, 'image/png');
    assert.equal(JSON.parse(r.result.content[0].text).content_read, true); assert.ok(!r.result.content[0].text.includes('_content'));
    a.container.id = '456'; await assert.rejects(api.call('get_attachments', { pageId: '123', attachmentId: '5', read_content: true }), code('CONTENT_INCOMPLETE'));
    assert.equal(downloads, 1);
  } finally { await server.close(); await client.close(); }
});

test('attachment download binds exact filename and version; invalid paging and comment continuation fail closed', async () => {
  let sent = 0, downloads = 0, target;
  const a = { id: '5', type: 'attachment', title: 'expected.txt', version: { number: 2 }, container: { id: '123' }, _links: { download: '/confluence/download/attachments/123/different.txt' } };
  const api = new Confluence(new RestClient(base, 1, load, async () => { sent++; return a; }, async url => { downloads++; target = url; return Buffer.from('test'); }));
  for (const args of [{ text_offset: 0 }, { max_text_chars: 12000 }]) await assert.rejects(api.call('get_attachments', { pageId: '123', ...args }), code('INVALID_ARGUMENT'));
  assert.equal(sent, 0);
  await assert.rejects(api.call('get_attachments', { pageId: '123', attachmentId: '5', read_content: true }), code('INVALID_ROUTE')); assert.equal(downloads, 0);
  a._links.download = '/confluence/download/attachments/123/expected.txt?version=1&version=3';
  const result = await api.call('get_attachments', { pageId: '123', attachmentId: '5', read_content: true });
  assert.deepEqual(target.searchParams.getAll('version'), ['2']); assert.equal(result.text, 'test');
  const badComments = new Confluence(new RestClient(base, 1, load, async () => ({ results: [], _links: { next: null } })));
  await assert.rejects(badComments.call('get_comments', { pageId: '123' }), code('CONTENT_INCOMPLETE'));
});
