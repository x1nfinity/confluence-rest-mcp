import assert from 'node:assert/strict';
import test from 'node:test';
import { Tokenizer } from 'htmlparser2';
import { performance } from 'node:perf_hooks';
import { parseDocument, clearDocumentCache, boundedItems } from '../dist/document.js';
import { findText, sectionChunk, structureChunk, validateFind } from '../dist/targeting.js';

const base = 'https://example.com/confluence';
const parse = html => parseDocument(html, base, '123', 'view');
const code = expected => error => error.code === expected;

test('emoji, combining marks and long merged tables preserve code-point structure and section pagination', () => {
  const parsed = parse('<p>🙂e\u0301序言</p><h1 id="root">🙂章</h1><table><tr><th rowspan="0" colspan="2">合并</th></tr><tr><td>'
    + '中🙂e\u0301'.repeat(1000) + '</td></tr></table><h2>下级</h2><p>范围</p><h1>终章</h1>');
  const points = [...parsed.text], selected = parsed.sectionRanges[0];
  let offset = 0, joined = '';
  do {
    const chunk = sectionChunk(parsed.text, parsed.sectionRanges, { section_anchor: 'root', offset, max_chars: 500 });
    assert.equal(chunk.text, points.slice(chunk.content.source_start, chunk.content.source_end).join(''));
    assert.equal([...chunk.text].length, chunk.content.returned_chars);
    joined += chunk.text; offset = chunk.content.next_offset;
  } while (offset !== null);
  assert.equal(joined, points.slice(selected.text_start, selected.text_end).join(''));
  assert.deepEqual(parsed.tables[0].rows[0][0], { text: '合并', rowspan: 0, colspan: 2, header: true });
  let next = 0, json = '', hash;
  do {
    const chunk = structureChunk(parsed, { kind: 'tables', offset: next, max_chars: 500, ...(hash ? { expected_content_hash: hash } : {}) });
    hash = chunk.content.content_hash; json += chunk.text; next = chunk.content.next_offset;
    assert.equal([...chunk.text].length, chunk.content.returned_chars);
  } while (next !== null);
  assert.deepEqual(JSON.parse(json), parsed.tables);
  assert.throws(() => structureChunk({ tables: [] }, { offset: 500, expected_content_hash: hash }), code('PAGE_VERSION_CHANGED'));
  assert.equal(boundedItems('tables', parsed.tables, 500).truncated, true);
  assert.equal(parsed.coverage.scope, 'provided_html_only');
  assert.equal(parsed.coverage.reference_targets_read, false);
});

test('literal Unicode matching retains positions and rejects malformed UTF-8 phrases', () => {
  const text = '🙂İiIı e\u0301 ßẞ Σσς .* ababa 🙂';
  const found = findText(text, 'i', { limit: 50, context_chars: 0 });
  assert.equal(found.pagination.total, 4);
  for (const hit of found.matches) assert.equal(hit.text, [...text].slice(hit.text_start, hit.text_end).join(''));
  assert.equal(findText(text, 'ss').pagination.total, 0);
  assert.equal(findText(text, 'ß').pagination.total, 2);
  assert.equal(findText(text, 'Σ').pagination.total, 3);
  assert.equal(findText(text, '.*').pagination.total, 1);
  assert.equal(findText(text, 'aba').pagination.total, 1);
  assert.equal(findText('a'.repeat(1048576), 'a'.repeat(999) + 'b').pagination.total, 0);
  validateFind('🙂'.repeat(1000));
  for (const value of ['🙂'.repeat(1001), '\ud800', '\udfff', 'ok\0']) assert.throws(() => validateFind(value), code('INVALID_ARGUMENT'));
});

test('parse cache expires at 120 seconds, keeps eight entries, uses LRU and isolates callers', t => {
  clearDocumentCache();
  let now = 1;
  t.mock.method(performance, 'now', () => now);
  const write = t.mock.method(Tokenizer.prototype, 'write');
  const first = parse('<h1>A</h1>');
  first.sections[0].title = 'mutated'; first.tables.push({ rows: [] });
  assert.equal(parse('<h1>A</h1>').sections[0].title, 'A');
  assert.deepEqual(parse('<h1>A</h1>').tables, []);
  assert.equal(write.mock.callCount(), 1);
  now += 119_999; parse('<h1>A</h1>'); assert.equal(write.mock.callCount(), 1);
  now++; parse('<h1>A</h1>'); assert.equal(write.mock.callCount(), 2);
  clearDocumentCache();
  for (let id = 0; id < 8; id++) parseDocument('<p>same</p>', base, String(id), 'view');
  const before = write.mock.callCount();
  parseDocument('<p>same</p>', base, '0', 'view');
  parseDocument('<p>same</p>', base, '8', 'view');
  parseDocument('<p>same</p>', base, '0', 'view');
  assert.equal(write.mock.callCount(), before + 1);
  parseDocument('<p>same</p>', base, '1', 'view'); assert.equal(write.mock.callCount(), before + 2);
  parseDocument('<p>same</p>', base, '1', 'storage'); assert.equal(write.mock.callCount(), before + 3);
  parseDocument('<p>changed</p>', base, '1', 'storage'); assert.equal(write.mock.callCount(), before + 4);
});

test('parse cache enforces total eight MiB budget and never caches oversized structures', t => {
  clearDocumentCache();
  const write = t.mock.method(Tokenizer.prototype, 'write');
  const html = '<p>' + 'x'.repeat(3 * 1024 * 1024) + '</p>';
  for (let id = 0; id < 3; id++) parseDocument(html, base, String(id), 'view');
  const before = write.mock.callCount();
  parseDocument(html, base, '1', 'view'); assert.equal(write.mock.callCount(), before);
  parseDocument(html, base, '0', 'view'); assert.equal(write.mock.callCount(), before + 1);
  const oversized = '<table><tr><td>' + 'x'.repeat(5 * 1024 * 1024) + '</td></tr></table>';
  parse(oversized); parse(oversized); assert.equal(write.mock.callCount(), before + 3);
});

test('structure streaming rejects cycles, invalid scalars and lone surrogates', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [null, [], {}, { tables: [null] }, { tables: ['cell'] }, { tables: [{ text: '\ud800' }] },
    { tables: [{ x: NaN }] }, { tables: [{ x: Infinity }] }, { tables: [{ x: undefined }] }, { tables: [cyclic] }]) {
    assert.throws(() => structureChunk(value), code('CONTENT_INCOMPLETE'));
  }
});
