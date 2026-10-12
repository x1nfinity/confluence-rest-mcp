import { createHash } from 'node:crypto';
import { ReadError } from './errors.js';
import type { SectionRange } from './document.js';

export type SectionOptions = { section_ordinal?: number; section_title?: string; section_anchor?: string; offset?: number; max_chars?: number };
export type FindOptions = { start?: number; limit?: number; context_chars?: number; case_sensitive?: boolean };
const validInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const validPhrase = (value: unknown) => typeof value === 'string' && !!value.trim() && [...value].length <= 1000 && !value.includes('\0') && ![...value].some(c => c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff);

export function validateSection(options: SectionOptions = {}) {
  const { section_ordinal, section_title, section_anchor, offset = 0, max_chars = 12000 } = options;
  if ([section_ordinal, section_title, section_anchor].filter(v => v !== undefined).length !== 1
    || section_ordinal !== undefined && !validInteger(section_ordinal, 1)
    || section_title !== undefined && !validPhrase(section_title)
    || section_anchor !== undefined && !validPhrase(section_anchor)
    || !validInteger(offset, 0) || !validInteger(max_chars, 500, 30000)) throw new ReadError('INVALID_ARGUMENT');
}
export function validateFind(keyword: string, options: FindOptions = {}) {
  const { start = 0, limit = 20, context_chars = 200, case_sensitive = false } = options;
  if (!validPhrase(keyword) || !validInteger(start, 0) || !validInteger(limit, 1, 50)
    || !validInteger(context_chars, 0, 1000) || typeof case_sensitive !== 'boolean') throw new ReadError('INVALID_ARGUMENT');
}
export function sectionChunk(text: string, sections: SectionRange[], options: SectionOptions = {}) {
  validateSection(options);
  if (typeof text !== 'string' || !Array.isArray(sections)) throw new ReadError('CONTENT_INCOMPLETE');
  const points = [...text];
  let lastStart = 0;
  for (const [index, section] of sections.entries()) {
    if (!section || !validInteger(section.ordinal, 1) || section.ordinal !== index + 1
      || !validInteger(section.level, 1, 6) || typeof section.title !== 'string'
      || section.anchor !== undefined && typeof section.anchor !== 'string'
      || !validInteger(section.text_start, lastStart, points.length)
      || !validInteger(section.text_end, section.text_start, points.length)) throw new ReadError('CONTENT_INCOMPLETE');
    lastStart = section.text_start;
  }
  const { section_ordinal, section_title, section_anchor, offset = 0, max_chars = 12000 } = options;
  const selected = sections.filter(section => section_ordinal !== undefined ? section.ordinal === section_ordinal
    : section_title !== undefined ? section.title === section_title : section.anchor === section_anchor);
  if (!selected.length) throw new ReadError('SECTION_NOT_FOUND');
  if (selected.length !== 1) throw new ReadError('SECTION_AMBIGUOUS');
  const section = selected[0], total = section.text_end - section.text_start;
  if (offset > total) throw new ReadError('INVALID_ARGUMENT');
  const end = Math.min(total, offset + max_chars), source_start = section.text_start + offset, source_end = section.text_start + end;
  const metadata: Record<string, unknown> = { ...section };
  for (const field of ['title', 'anchor'] as const) {
    const value = [...(section[field] ?? '')];
    if (value.length > 1000) { metadata[field] = value.slice(0, 1000).join(''); metadata[field + '_truncated'] = true; }
  }
  return { section: metadata, text: points.slice(source_start, source_end).join(''), content: {
    scope: 'selected_section', offset, returned_chars: end - offset, total_chars: total,
    next_offset: end < total ? end : null, source_start, source_end, source_total_chars: points.length,
    offset_unit: 'unicode_code_points', is_full_section: offset === 0 && end === total, is_full_document: false } };
}

// Python IGNORECASE aliases are single code points, preserving every source offset.
const aliases: Record<string, string> = { 'µ': 'μ', 'İ': 'i', 'ı': 'i', 'ſ': 's', 'ͅ': 'ι', 'ς': 'σ',
  'ϐ': 'β', 'ϑ': 'θ', 'ϕ': 'φ', 'ϖ': 'π', 'ϰ': 'κ', 'ϱ': 'ρ', 'ϵ': 'ε',
  'ẛ': 'ṡ', 'ι': 'ι', 'ΐ': 'ΐ', 'ΰ': 'ΰ', 'ﬆ': 'ﬅ' };
function simpleFold(value: string) {
  if (/^[\x00-\x7f]*$/u.test(value)) return value.toLowerCase();
  return [...value].map(char => aliases[char] ?? char.toLowerCase()).join('');
}
export function findText(text: string, keyword: string, options: FindOptions = {}) {
  validateFind(keyword, options);
  if (typeof text !== 'string') throw new ReadError('CONTENT_INCOMPLETE');
  const { start = 0, limit = 20, context_chars = 200, case_sensitive = false } = options;
  const points = [...text], haystack = case_sensitive ? text : simpleFold(text), needle = case_sensitive ? keyword : simpleFold(keyword);
  const matches: { ordinal: number; text: string; text_start: number; text_end: number; context: { text: string; text_start: number; text_end: number } }[] = [];
  let total = 0, cursor = 0, pointCursor = 0, position = haystack.indexOf(needle);
  const keywordLength = [...keyword].length;
  while (position !== -1) {
    pointCursor += [...haystack.slice(cursor, position)].length;
    const end = pointCursor + keywordLength;
    total++;
    if (start <= total - 1 && total - 1 < start + limit) {
      const left = Math.max(0, pointCursor - context_chars), right = Math.min(points.length, end + context_chars);
      matches.push({ ordinal: total, text: points.slice(pointCursor, end).join(''), text_start: pointCursor, text_end: end,
        context: { text: points.slice(left, right).join(''), text_start: left, text_end: right } });
    }
    cursor = position + needle.length; pointCursor = end; position = haystack.indexOf(needle, cursor);
  }
  if (start > total) throw new ReadError('INVALID_ARGUMENT');
  const next = start + matches.length;
  return { matches, pagination: { start, limit, returned: matches.length, total, next_start: next < total ? next : null },
    content: { scope: 'keyword_matches_with_context', total_chars: points.length, offset_unit: 'unicode_code_points', is_full_document: false } };
}

export type StructureOptions = { kind?: string; offset?: number; max_chars?: number; expected_content_hash?: string };
export function validateStructure(options: StructureOptions = {}) {
  const { kind = 'tables', offset = 0, max_chars = 12000, expected_content_hash } = options;
  if (!['tables', 'sections', 'references', 'unresolved_macros'].includes(kind)
    || !validInteger(offset, 0) || !validInteger(max_chars, 500, 30000)
    || expected_content_hash !== undefined && (typeof expected_content_hash !== 'string' || !/^[0-9a-f]{64}$/iu.test(expected_content_hash))) throw new ReadError('INVALID_ARGUMENT');
}
export function structureChunk(structure: Record<string, unknown>, options: StructureOptions = {}) {
  validateStructure(options);
  const { kind = 'tables', offset = 0, max_chars = 12000, expected_content_hash } = options;
  const items = structure?.[kind];
  if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new ReadError('CONTENT_INCOMPLETE');
  let text: string;
  try {
    text = JSON.stringify(items, (key, value: unknown) => {
      if ([...key].some(c => c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff) || typeof value === 'number' && !Number.isFinite(value) || value === undefined || typeof value === 'function'
        || typeof value === 'symbol' || typeof value === 'string' && [...value].some(c => c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff)) throw new Error();
      return value;
    });
  } catch { throw new ReadError('CONTENT_INCOMPLETE'); }
  const content_hash = createHash('sha256').update(text).digest('hex');
  if (expected_content_hash !== undefined && content_hash !== expected_content_hash.toLowerCase()) throw new ReadError('PAGE_VERSION_CHANGED');
  const points = [...text];
  if (offset > points.length) throw new ReadError('INVALID_ARGUMENT');
  const end = Math.min(points.length, offset + max_chars);
  return { text: points.slice(offset, end).join(''), content: {
    offset, returned_chars: end - offset, total_chars: points.length, next_offset: end < points.length ? end : null,
    is_full_document: offset === 0 && end === points.length, format: 'json', kind, item_count: items.length, join_before_parse: true, content_hash } };
}
