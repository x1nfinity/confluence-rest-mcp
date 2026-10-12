import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve as resolveUrl } from 'node:url';
import { Tokenizer } from 'htmlparser2';
import { ReadError } from './errors.js';

export type Section = { level: number; title: string; ordinal: number; anchor?: string };
export type SectionRange = Section & { text_start: number; text_end: number };
type Reference = Record<string, unknown>;
type Cell = { text: string; rowspan: number; colspan: number; header: boolean };
type Table = { rows: Cell[][]; parent_table?: number };
type TableState = { table: Table; index: number; row: Cell[] | null; cell: Cell | null; parts: string[] };
const whitespace = /[\s\u001c-\u001f]+/gu;
const compact = (value: string) => value.replace(whitespace, ' ');
const strip = (value: string) => value.replace(/^[\s\u001c-\u001f]+|[\s\u001c-\u001f]+$/gu, '');
const length = (value: string) => [...value].length;
const attachmentName = (value: string) => encodeURIComponent(value).replace(/[!'()*]/gu, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const cache = new Map<string, { expires: number; size: number; value: ParsedDocument }>();
const CACHE_BYTES = 8 * 1024 * 1024;
export function clearDocumentCache() { cache.clear(); }

function extract(html: string, base: string, id: string, representation: string) {
  const parts: string[] = [], links: string[] = [], lists: { tag: string; count: number }[] = [];
  const decorations: { tag: string; struck: boolean }[] = [], sections: Section[] = [];
  const tables: Table[] = [], references: Reference[] = [], macros: Record<string, string>[] = [];
  const tableStack: TableState[] = [], anchors: { reference: Reference; parts: string[] }[] = [];
  const attachments: Reference[] = [], structureLists: { tag: string; count: number }[] = [];
  const structureDecorations: { tag: string; struck: boolean }[] = [];
  const sectionBoundaries: number[] = [];
  let hidden = 0, pre = 0, parameters = 0, images = 0;
  let heading: { section: Section; parts: string[] } | undefined;
  const safeLink = (value: string) => {
    if (!value) return '';
    try { const u = new URL(value, base + '/'); return ['http:', 'https:', 'mailto:'].includes(u.protocol)
      && !u.username && !u.password ? (/^[a-z][a-z0-9+.-]*:/iu.test(value) ? value : value.startsWith('//') ? new URL(base).protocol + value : resolveUrl(base + '/', value)) : ''; } catch { return ''; }
  };
  const emit = (text: string) => {
    heading?.parts.push(text);
    for (const table of tableStack) if (table.cell) table.parts.push(text);
    for (const anchor of anchors) {
      anchor.parts.push(text); anchor.reference.title = strip(compact(anchor.parts.join('')));
    }
  };
  const finishCell = (table: TableState) => {
    if (table.cell) table.cell.text = strip(table.parts.join('').replace(/\n[ \t]*\n+/gu, '\n'));
  };
  const reference = (kind: string, source: string, url = '', fields: Reference = {}) => {
    const value: Reference = { kind, source, content_read: false, ...fields };
    if (url) {
      value.url = url;
      value.scope = new URL(url).origin === new URL(base).origin ? 'same_site' : 'external';
    }
    const table = tableStack.at(-1);
    if (table?.cell) Object.assign(value, { table: table.index, row: table.table.rows.length - 1, cell: table.row!.length - 1 });
    references.push(value); return value;
  };
  const span = (value: string | undefined, zero = false) => value && /^[0-9]{1,6}$/u.test(value)
    && (Number(value) > 0 || zero) ? Number(value) : 1;
  const struck = (tag: string, attrs: Record<string, string>) => tag !== 'span'
    || /(?:^|;)\s*text-decoration(?:-line)?\s*:[^;]*\bline-through\b/iu.test(attrs.style ?? '');
  const open = (tag: string, attrs: Record<string, string>) => {
    if (tag === 'script' || tag === 'style') hidden++;
    if (hidden) return;
    if (['s', 'strike', 'del', 'span'].includes(tag)) {
      const value = struck(tag, attrs); decorations.push({ tag, struck: value });
      if (value) parts.push('[删除线: ');
    }
    if (['p', 'div', 'tr', 'blockquote', 'pre'].includes(tag) || /^h[1-6]$/u.test(tag)) parts.push('\n');
    const headingBoundary = parts.length;
    if (tag === 'pre') pre++;
    if (tag === 'br') parts.push('\n');
    if (tag === 'ul' || tag === 'ol') lists.push({ tag, count: 0 });
    if (tag === 'li') {
      const list = lists.at(-1); if (list) list.count++;
      parts.push('\n' + '  '.repeat(Math.max(0, lists.length - 1)) + (list?.tag === 'ol' ? list.count + '.' : '-') + ' ');
    }
    if (tag === 'td' || tag === 'th') parts.push('\t');
    if (tag === 'a') links.push(safeLink(attrs.href ?? ''));
    if (tag === 'img') parts.push('[图片: ' + (attrs.alt ?? '') + '] ' + safeLink(attrs.src ?? ''));
    if (tag === 'ri:attachment') parts.push('[附件: ' + (attrs['ri:filename'] ?? '') + '] ' + base + '/download/attachments/' + id + '/' + attachmentName(attrs['ri:filename'] ?? ''));
    if (tag === 'ri:page') parts.push('[页面: ' + (attrs['ri:content-title'] ?? '') + ']');

    if (tag === 'ac:parameter') parameters++;
    if (parameters) return;
    if (tag === 'ac:macro' || tag === 'ac:structured-macro') macros.push({ name: attrs['ac:name'] ?? '',
      status: 'not_expanded', source: tag, ...(attrs['ac:macro-id'] ? { id: attrs['ac:macro-id'] } : {}) });
    if (/^h[1-6]$/u.test(tag)) {
      const section: Section = { level: Number(tag[1]), title: '', ordinal: sections.length + 1,
        ...(attrs.id ? { anchor: attrs.id } : {}) };
      sections.push(section); sectionBoundaries.push(headingBoundary); heading = { section, parts: [] };
    }
    if (['s', 'strike', 'del', 'span'].includes(tag)) {
      const value = struck(tag, attrs); structureDecorations.push({ tag, struck: value });
      if (value) emit('[删除线: ');
    }
    if (tag === 'table') {
      emit('\n');
      const parent = tableStack.at(-1), table: Table = { rows: [], ...(parent ? { parent_table: parent.index } : {}) };
      const index = tables.length; tables.push(table);
      tableStack.push({ table, index, row: null, cell: null, parts: [] });
    }
    const table = tableStack.at(-1);
    if (tag === 'tr' && table) {
      finishCell(table); table.row = []; table.table.rows.push(table.row); table.cell = null;
    }
    if ((tag === 'td' || tag === 'th') && table) {
      finishCell(table);
      if (!table.row) { table.row = []; table.table.rows.push(table.row); }
      table.cell = { text: '', rowspan: span(attrs.rowspan, true), colspan: span(attrs.colspan), header: tag === 'th' };
      table.parts = []; table.row.push(table.cell);
    }
    if (['p', 'div', 'blockquote', 'pre', 'br'].includes(tag)) emit('\n');
    if (tag === 'ul' || tag === 'ol') structureLists.push({ tag, count: 0 });
    if (tag === 'li') {
      const list = structureLists.at(-1); if (list) list.count++;
      emit('\n' + '  '.repeat(Math.max(0, structureLists.length - 1)) + (list?.tag === 'ol' ? list.count + '.' : '-') + ' ');
    }
    if (tag === 'a') {
      if (heading && !heading.section.anchor && (attrs.id || attrs.name)) heading.section.anchor = attrs.id || attrs.name;
      const raw = attrs.href ?? '', url = safeLink(raw), resource = attrs['data-linked-resource-type'];
      const kind = resource === 'attachment' || url.includes('/download/attachments/') ? 'attachment'
        : resource === 'page' || url.includes('/pages/viewpage.action') || url.includes('/display/') ? 'page' : 'link';
      const value = raw ? reference(kind, 'a', url, { title: '' }) : {};
      if (raw && !url) value.status = 'unsupported_url';
      anchors.push({ reference: value, parts: [] });
    }
    if (tag === 'img') { const value = reference('image', 'img', safeLink(attrs.src ?? ''), { title: attrs.alt ?? '' }); emit('[图片: ' + value.title + ']'); }
    if (tag === 'ac:image') images++;
    if (tag === 'ri:attachment') {
      const name = attrs['ri:filename'] ?? '';
      attachments.push(reference(images ? 'image' : 'attachment', tag,
        safeLink(base + '/download/attachments/' + id + '/' + attachmentName(name)), { name }));
      emit('[附件: ' + name + ']');
    }
    if (tag === 'ri:page') {
      const fields: Reference = { title: attrs['ri:content-title'] ?? '',
        ...(attrs['ri:space-key'] ? { space_key: attrs['ri:space-key'] } : {}),
        ...(attrs['ri:content-id'] ? { id: attrs['ri:content-id'] } : {}) };
      const attachment = attachments.at(-1);
      if (attachment) {
        attachment.target_page = { ...fields }; delete attachment.url; delete attachment.scope;
        if (/^[0-9]+$/u.test(String(fields.id ?? ''))) {
          attachment.url = base + '/download/attachments/' + fields.id + '/' + attachmentName(String(attachment.name));
          attachment.scope = 'same_site';
        } else attachment.status = 'target_page_unresolved';
      }
      reference('page', tag, '', fields); emit('[页面: ' + fields.title + ']');
    }
    if (tag === 'ri:url') reference(images ? 'image' : 'link', tag, safeLink(attrs['ri:value'] ?? ''));
  };
  const close = (tag: string) => {
    if (tag === 'script' || tag === 'style') { hidden = Math.max(0, hidden - 1); return; }
    if (hidden) return;
    if (decorations.at(-1)?.tag === tag && decorations.pop()?.struck) parts.push(']');
    if (tag === 'a') { const link = links.pop(); if (link) parts.push(' (' + link + ')'); }
    if (tag === 'ul' || tag === 'ol') lists.pop();
    if (tag === 'pre') pre = Math.max(0, pre - 1);
    if (['p', 'div', 'tr', 'li', 'ul', 'ol', 'pre', 'table'].includes(tag) || /^h[1-6]$/u.test(tag)) parts.push('\n');
    if (tag === 'ac:parameter') { parameters = Math.max(0, parameters - 1); return; }
    if (parameters) return;
    if (structureDecorations.at(-1)?.tag === tag && structureDecorations.pop()?.struck) emit(']');
    if (/^h[1-6]$/u.test(tag) && heading) { heading.section.title = strip(compact(heading.parts.join(''))); heading = undefined; }
    if (tag === 'a') anchors.pop();
    if (tag === 'ac:image') images = Math.max(0, images - 1);
    if (tag === 'ri:attachment') attachments.pop();
    const table = tableStack.at(-1);
    if (['td', 'th', 'tr'].includes(tag) && table) {
      finishCell(table); table.cell = null; emit('\n'); if (tag === 'tr') table.row = null;
    }
    if (tag === 'table' && table) { finishCell(table); tableStack.pop(); emit('\n'); }
    if (tag === 'ul' || tag === 'ol') structureLists.pop();
    if (['p', 'div', 'li', 'ul', 'ol', 'pre', 'blockquote'].includes(tag)) emit('\n');
  };
  let tag = '', attrs: Record<string, string> = {}, attribute = '', attributeValue = '', pendingText = '';
  const flushText = () => {
    if (pendingText && !hidden) { parts.push(pre ? pendingText : compact(pendingText)); if (!parameters) emit(compact(pendingText)); }
    pendingText = '';
  };
  // Tokenizer preserves literal source closures, including malformed cross-cell links.
  const tokenizer = new Tokenizer({ decodeEntities: true, recognizeSelfClosing: true }, {
    onopentagname(start, end) { flushText(); tag = html.slice(start, end).toLowerCase(); attrs = {}; },
    onattribname(start, end) { attribute = html.slice(start, end).toLowerCase(); attributeValue = ''; },
    onattribdata(start, end) { attributeValue += html.slice(start, end); },
    onattribentity(codepoint) { attributeValue += String.fromCodePoint(codepoint); },
    onattribend() { attrs[attribute] = attributeValue; },
    onopentagend() { open(tag, attrs); },
    onselfclosingtag() { open(tag, attrs); close(tag); },
    onclosetag(start, end) { flushText(); close(html.slice(start, end).toLowerCase()); },
    ontext(start, end) { pendingText += html.slice(start, end); },
    ontextentity(codepoint) { pendingText += String.fromCodePoint(codepoint); },
    oncomment() { flushText(); }, oncdata() { flushText(); }, ondeclaration() { flushText(); },
    onprocessinginstruction() { flushText(); }, onend() { flushText(); },
  });
  tokenizer.write(html); tokenizer.end();
  for (const table of tableStack) finishCell(table);
  if (heading) heading.section.title = strip(compact(heading.parts.join('')));
  const raw = parts.join(''), cleaned = raw.replace(/\n[ \t]*\n+/gu, '\n\n'), text = strip(cleaned);
  const boundaries = new Set(sectionBoundaries), rawOffsets = new Map<number, number>();
  let rawOffset = 0;
  for (let index = 0; index <= parts.length; index++) {
    if (boundaries.has(index)) rawOffsets.set(index, rawOffset);
    if (index < parts.length) rawOffset += parts[index].length;
  }
  const leading = cleaned.length - cleaned.replace(/^[\s\u001c-\u001f]+/u, '').length;
  const collapses = [...raw.matchAll(/\n[ \t]*\n+/gu)];
  let collapseIndex = 0, removed = 0, textUnits = 0, textPoints = 0;
  const totalTextPoints = length(text);
  const mapped = new Map<number, number>();
  for (const boundary of [...boundaries].sort((a, b) => a - b)) {
    const point = rawOffsets.get(boundary)!;
    while (collapseIndex < collapses.length && collapses[collapseIndex].index! + collapses[collapseIndex][0].length <= point) {
      removed += collapses[collapseIndex++][0].length - 2;
    }
    const match = collapses[collapseIndex];
    const target = match && match.index! < point && point < match.index! + match[0].length ? match.index! - removed + 2 : point - removed;
    const targetUnits = Math.min(text.length, Math.max(0, target - leading));
    while (textUnits < targetUnits) { textUnits += text.codePointAt(textUnits)! > 0xffff ? 2 : 1; textPoints++; }
    mapped.set(boundary, textPoints);
  }
  const sectionRanges: SectionRange[] = sections.map((section, index) => ({ ...section, text_start: mapped.get(sectionBoundaries[index])!, text_end: totalTextPoints }));
  const pending: SectionRange[] = [];
  for (const section of sectionRanges) {
    while (pending.length && pending.at(-1)!.level >= section.level) pending.pop()!.text_end = section.text_start;
    pending.push(section);
  }
  const warnings = representation === 'storage' ? [{ code: 'storage_not_rendered', message: 'Storage source was parsed; macro output has not been rendered.' }] : [];
  return { text, representation, sections, sectionRanges, tables, references, macros, unresolved_macros: macros, warnings,
    coverage: { scope: 'provided_html_only', reference_targets_read: false, attachments_read: false,
      macro_expansion_verified: false, excluded_content: ['script', 'style', 'ac:parameter'],
      message: 'Structure covers the provided HTML only. References are metadata; attachment contents and macro expansion have not been verified.' } };
}
export type ParsedDocument = ReturnType<typeof extract>;
export function parseDocument(html: string, base: string, id: string, representation: string): ParsedDocument {
  if (typeof html !== 'string') throw new ReadError('CONTENT_INCOMPLETE');
  const now = performance.now();
  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  const key = JSON.stringify([base, id, representation, createHash('sha256').update(html).digest('hex')]);
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return structuredClone(cached.value); }
  const value = extract(html, base, id, representation), size = Buffer.byteLength(JSON.stringify(value));
  if (size <= CACHE_BYTES) {
    cache.set(key, { expires: now + 120_000, size, value });
    let total = [...cache.values()].reduce((sum, entry) => sum + entry.size, 0);
    while (cache.size > 8 || total > CACHE_BYTES) {
      const oldest = cache.keys().next().value!; total -= cache.get(oldest)!.size; cache.delete(oldest);
    }
  }
  return structuredClone(value);
}

export function boundedItems(key: string, items: unknown[], budget: number) {
  const kept: unknown[] = [];
  const result = { [key]: kept, truncated: false,
    total_items: { [key]: items.length }, returned_items: { [key]: 0 } };
  for (const item of items) {
    kept.push(item); result.returned_items[key]++;
    if ([...JSON.stringify(result)].length > budget) {
      kept.pop(); result.returned_items[key]--; result.truncated = true; break;
    }
  }
  return result;
}
