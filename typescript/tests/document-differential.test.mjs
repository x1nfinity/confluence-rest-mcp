import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { parseDocument, clearDocumentCache } from '../dist/document.js';
import { sectionChunk, findText, validateSection, validateFind, structureChunk } from '../dist/targeting.js';

const fixtures = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/document.json.gz', import.meta.url))).toString('utf8'));
const functions = { section_chunk: sectionChunk, find_text: findText, validate_section: validateSection, validate_find: validateFind };
function invoke(fixture) {
  const args = fixture.args ?? [], options = { ...fixture.options };
  const sectionFields = ['section_ordinal', 'section_title', 'section_anchor', 'offset', 'max_chars'];
  const findFields = ['start', 'limit', 'context_chars', 'case_sensitive'];
  const fields = fixture.operation === 'structure_chunk' ? ['kind', 'offset', 'max_chars', 'expected_content_hash'] : fixture.operation.includes('section') ? sectionFields : findFields;
  const skip = fixture.operation === 'structure_chunk' ? 1 : fixture.operation.endsWith('_chunk') || fixture.operation === 'find_text' ? 2 : fixture.operation === 'validate_find' ? 1 : 0;
  args.slice(skip).forEach((value, index) => { options[fields[index]] = value; });
  for (const key of sectionFields.slice(0, 3)) if (options[key] === null) delete options[key];
  switch (fixture.operation) {
    case 'structure_chunk': return structureChunk(args[0], options);
    case 'section_chunk': {
      const text = args[0] ?? options.text, sections = args[1] ?? options.sections;
      delete options.text; delete options.sections;
      return sectionChunk(text, sections, options);
    }
    case 'find_text': {
      const text = args[0] ?? options.text, keyword = args[1] ?? options.keyword;
      delete options.text; delete options.keyword;
      return findText(text, keyword, options);
    }
    case 'validate_find': {
      const keyword = args[0] ?? options.keyword; delete options.keyword;
      return validateFind(keyword, options);
    }
    default: return functions[fixture.operation](options);
  }
}

test('original Python document and targeting fixtures compare full semantic outputs', () => {
  clearDocumentCache();
  let parsed = 0, targeted = 0, rejected = 0;
  for (const fixture of fixtures) {
    if (fixture.operation === 'parse') {
      const result = parseDocument(fixture.html, fixture.base, fixture.id, fixture.representation);
      const { macros, ...actual } = result;
      const expected = fixture.expected;
      if (fixture.html.includes('https://user:secret@example.com/private')) {
        // M1 rejects credentials in URLs; Python's legacy text renderer included them.
        assert.equal(actual.text, expected.text.replace('https://user:secret@example.com/private', '').trim());
        assert.ok(!JSON.stringify(actual).includes('secret'));
        const { text: legacyText, sectionRanges: legacyRanges, ...legacyStructure } = expected;
        const { text: safeText, sectionRanges: safeRanges, ...actualStructure } = actual;
        assert.deepEqual(actualStructure, legacyStructure);
        assert.deepEqual(safeRanges, legacyRanges.map(range => ({ ...range, text_end: [...safeText].length })));
      } else assert.deepEqual(actual, expected, `HTML fixture ${parsed}`);
      assert.deepEqual(macros, expected.unresolved_macros); parsed++;
    } else if (fixture.error) {
      assert.throws(() => invoke(fixture), error => error.code === fixture.error,
        `${fixture.operation}: ${JSON.stringify(fixture.options)}`); rejected++;
    } else {
      let actual;
      try { actual = invoke(fixture); } catch (error) { error.message += JSON.stringify(fixture); throw error; }
      if (fixture.operation.startsWith('validate_')) assert.equal(actual, undefined);
      else assert.deepEqual(actual, fixture.expected, fixture.operation);
      targeted++;
    }
  }
  assert.ok(parsed >= 30 && targeted >= 50 && rejected >= 40, JSON.stringify({ parsed, targeted, rejected }));
});
