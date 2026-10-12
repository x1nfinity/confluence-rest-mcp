import { createHash } from 'node:crypto';
import { type Tool } from '@modelcontextprotocol/server';
import contracts from './contracts.json' with { type: 'json' };
import { ReadError } from './errors.js';
import { RestClient } from './rest.js';
import { parseDocument, boundedItems } from './document.js';
import { sectionChunk, findText, structureChunk, validateSection, validateFind, validateStructure } from './targeting.js';
import { readAttachment } from './attachments.js';
import { WriteService } from './writes.js';
import { unifiedDiff } from './history.js';
import type { Policy } from './config.js';

export const tools = contracts.tools as unknown as Tool[];
// Schema string limits use Unicode code points, matching the frozen Python contract.
function valid(schema: Record<string, any>, value: unknown): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some(type => type === 'null' ? value === null : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === 'string' && ((schema.minLength !== undefined && [...value].length < schema.minLength)
    || (schema.maxLength !== undefined && [...value].length > schema.maxLength)
    || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)))) return false;
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (Array.isArray(value) && ((schema.minItems !== undefined && value.length < schema.minItems)
    || value.some(v => !valid(schema.items, v)))) return false;
  if (schema.type === 'object') {
    const input = value as Record<string, unknown>;
    if ((schema.required ?? []).some((k: string) => !(k in input))
      || Object.keys(input).some(k => !(k in schema.properties) || !valid(schema.properties[k], input[k]))) return false;
    if (schema.oneOf && schema.oneOf.filter((s: { required: string[] }) => s.required.every(k => k in input)).length !== 1) return false;
  }
  return true;
}
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReadError('CONTENT_INCOMPLETE');
  return value as Record<string, unknown>;
};
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ReadError('CONTENT_INCOMPLETE');
  return value;
}
function textArgument(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /\p{Surrogate}/u.test(value))
    throw new ReadError('INVALID_ARGUMENT');
}
function validDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
    || value.startsWith('0000') || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value) throw new ReadError('INVALID_ARGUMENT');
}

export class Confluence {
  private writes: WriteService;
  readonly tools: Tool[];
  constructor(public rest: RestClient, config: { allow_write?: boolean; readOnly?: boolean; policy?: Policy } = {}) {
    this.tools = tools.filter(t => config.policy?.enabled_tools === undefined || config.policy.enabled_tools.includes(t.name));
    this.writes = new WriteService(rest, { allow_write: config.allow_write === true,
      readOnly: config.readOnly ?? true, writeSpaces: config.policy?.write_spaces }, reference => this.resolve(reference));
  }
  absolute(value: unknown): string | null {
    if (!value) return null;
    if (typeof value !== 'string') throw new ReadError('CONTENT_INCOMPLETE');
    try {
      const context = new URL(this.rest.base).pathname;
      const url = new URL(value === context || value.startsWith(context + '/') ? value
        : value.startsWith('/') && !value.startsWith('//') ? value.slice(1) : value,
      this.rest.base + '/');
      if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw 0;
      return url.href;
    } catch { throw new ReadError('CONTENT_INCOMPLETE'); }
  }
  summary(value: unknown) {
    const page = object(value), result: Record<string, unknown> = {};
    for (const key of ['id', 'type', 'status', 'title']) if (key in page) result[key] = page[key];
    for (const [key, fields] of [['space', ['key', 'name']], ['version', ['number', 'when']]] as const) {
      if (page[key]) {
        const field = object(page[key]); result[key] = Object.fromEntries(fields.filter(k => k in field).map(k => [k, field[k]]));
      }
    }
    result.url = this.absolute(page._links ? object(page._links).webui : null)
      ?? (page.id ? this.rest.base + '/pages/viewpage.action?pageId=' + page.id : null);
    return result;
  }
  pagination(data: Record<string, unknown>, start: number, limit: number) {
    const rows = list(data.results), links = data._links ? object(data._links) : {};
    const next = this.absolute(links.next), current = data.start ?? start;
    if (!Number.isSafeInteger(current) || Number(current) < 0) throw new ReadError('CONTENT_INCOMPLETE');
    return { start: current, limit: data.limit ?? limit, size: data.size ?? rows.length,
      next, next_start: next ? Number(current) + rows.length : null };
  }
  async resolve(reference: string): Promise<string> {
    if (/^[0-9]+$/u.test(reference)) return reference;
    try {
      const u = new URL(reference), site = new URL(this.rest.base);
      if (u.origin !== site.origin || u.username || u.password || !u.pathname.startsWith(site.pathname.replace(/\/$/u, '') + '/')) throw 0;
      const ids = u.searchParams.getAll('pageId');
      if (ids.length === 1 && /^[0-9]+$/u.test(ids[0])) return ids[0];
      const path = u.pathname.slice(site.pathname.replace(/\/$/u, '').length);
      const match = /^\/display\/([^/]+)\/(.+)$/u.exec(path);
      if (match) {
        const [space, title] = match.slice(1).map(s => decodeURIComponent(s.replace(/\+/gu, ' ')));
        const data = await this.search({ cql: 'type = page AND space = ' + JSON.stringify(space) + ' AND title = ' + JSON.stringify(title), limit: 2 });
        if (data.results.length !== 1) throw new ReadError('TARGET_AMBIGUOUS');
        const id = data.results[0].id;
        if (typeof id === 'string' && /^[0-9]+$/u.test(id)) return id;
        throw new ReadError('CONTENT_INCOMPLETE');
      }
    } catch (error) { if (error instanceof ReadError) throw error; }
    throw new ReadError('INVALID_ARGUMENT');
  }
  async call(name: string, input: unknown): Promise<Record<string, any>> {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new ReadError('NOT_SUPPORTED');
    if (!valid(tool.inputSchema, input)) throw new ReadError('INVALID_ARGUMENT');
    if (!this.tools.some(t => t.name === name)) throw new ReadError('TOOL_DISABLED');
    const args = object(input);
    for (const key of ['pageId', 'keyword', 'cql', 'space_key']) if (key in args) textArgument(args[key]);
    if (name === 'search_pages') return this.search(args);
    if (name === 'get_page') return this.page(args);
    if (name === 'get_attachments') return this.attachments(args);
    if (name === 'get_children') return this.children(args);
    if (name === 'get_comments') return this.comments(args);
    if (name === 'compare_page_versions') return this.compare(args);
    if (name === 'get_page_structure') {
      validateStructure(args);
      const { page, parsed } = await this.readPage(args, false);
      return { ...this.summary(page), ...structureChunk(parsed, args), coverage: parsed.coverage, warnings: parsed.warnings };
    }
    if (name === 'get_page_section' || name === 'find_page_text') {
      if (name === 'get_page_section') validateSection(args); else validateFind(String(args.keyword), args);
      const { page, parsed, hash } = await this.readPage(args);
      const result = name === 'get_page_section' ? sectionChunk(parsed.text, parsed.sectionRanges, args) : findText(parsed.text, String(args.keyword), args);
      return { ...this.summary(page), ...result, content: { ...result.content, content_hash: hash }, coverage: parsed.coverage, warnings: parsed.warnings };
    }
    return this.writes.call(name, args);
  }
  async search(args: Record<string, unknown>) {
    const { cql, keyword, space_key, labels, updated_after, updated_before, order_by } = args;
    if ((cql === undefined) === (keyword === undefined)) throw new ReadError('INVALID_ARGUMENT');
    if (cql !== undefined && (args.title_only === true || [space_key, labels, updated_after, updated_before, order_by].some(v => v !== undefined)))
      throw new ReadError('INVALID_ARGUMENT');
    for (const date of [updated_after, updated_before]) if (date !== undefined) validDate(date);
    if (updated_after !== undefined && updated_before !== undefined && String(updated_after) > String(updated_before)) throw new ReadError('INVALID_ARGUMENT');
    const clauses = ['type = page', (args.title_only ? 'title' : 'text') + ' ~ ' + JSON.stringify(keyword)];
    if (space_key !== undefined) clauses.push('space = ' + JSON.stringify(space_key));
    for (const label of (labels ?? []) as unknown[]) { textArgument(label); clauses.push('label = ' + JSON.stringify(label)); }
    if (updated_after !== undefined) clauses.push('lastmodified >= ' + JSON.stringify(updated_after));
    if (updated_before !== undefined) clauses.push('lastmodified <= ' + JSON.stringify(updated_before));
    let query = cql !== undefined ? String(cql) : clauses.join(' AND ');
    if (order_by !== undefined) query += ' ORDER BY ' + (order_by === 'title_asc' ? 'title asc' : 'lastmodified desc');
    const limit = Number(args.limit ?? 25), start = Number(args.start ?? 0);
    const data = await this.rest.get('content/search', { cql: query, limit, start, expand: 'space,version' });
    return { results: list(data.results).map(p => this.summary(p)), pagination: this.pagination(data, start, limit) };
  }
  async readPage(args: Record<string, unknown>, checkTextHash = true) {
    const id = await this.resolve(String(args.pageId));
    let page = await this.rest.get('content/' + id, { expand: 'body.view,version,space,ancestors,metadata.labels' + (args.include_html ? ',body.storage' : '') });
    const version = object(page.version).number;
    if (String(page.id) !== id || page.type !== 'page' || !Number.isSafeInteger(version) || Number(version) < 1) throw new ReadError('CONTENT_INCOMPLETE');
    if (args.expected_version !== undefined && version !== args.expected_version) throw new ReadError('PAGE_VERSION_CHANGED');
    let body = object(page.body), view = body.view ? object(body.view).value : undefined;
    let representation = 'view';
    if (view === undefined || view === null) {
      const fallback = await this.rest.get('content/' + id, { expand: 'body.storage,version' });
      if (object(fallback.version).number !== version) throw new ReadError('PAGE_VERSION_CHANGED');
      if (String(fallback.id) !== id || fallback.type !== page.type) throw new ReadError('CONTENT_INCOMPLETE');
      body = object(fallback.body); page = { ...page, body };
      view = body.storage ? object(body.storage).value : undefined; representation = 'storage';
    }
    if (typeof view !== 'string') throw new ReadError('CONTENT_INCOMPLETE');
    const parsed = parseDocument(view, this.rest.base, id, representation);
    const hash = createHash('sha256').update(parsed.text).digest('hex');
    if (checkTextHash && args.expected_content_hash !== undefined && String(args.expected_content_hash).toLowerCase() !== hash) throw new ReadError('PAGE_VERSION_CHANGED');
    return { page, parsed, hash, representation };
  }
  async page(args: Record<string, unknown>) {
    const { page, parsed, hash, representation } = await this.readPage(args);
    const points = [...parsed.text], offset = Number(args.offset ?? 0), max = Number(args.max_chars ?? 12000);
    if (offset > points.length) throw new ReadError('INVALID_ARGUMENT');
    let end = Math.min(points.length, offset + max);
    if (end < points.length) {
      const boundary = points.slice(offset, end).lastIndexOf('\n') + offset;
      if (boundary > offset + Math.floor(max / 2)) end = boundary + 1;
    }
    const macros = boundedItems('unresolved_macros', parsed.macros, 2000);
    const metadata = page.metadata ? object(page.metadata) : {}, labels = metadata.labels ? object(metadata.labels).results : [];
    return { ...this.summary(page), ancestors: list(page.ancestors ?? []).map(p => this.summary(p)),
      labels: list(labels ?? []).map(label => object(label).name), text: points.slice(offset, end).join(''),
      content: { offset, returned_chars: end - offset, total_chars: points.length,
        next_offset: end < points.length ? end : null, is_full_document: offset === 0 && end === points.length,
        content_hash: hash, representation, warnings: parsed.warnings, references_inspected: false,
        unresolved_macros: macros.unresolved_macros, macros_truncated: macros.truncated, coverage: parsed.coverage },
      outline: boundedItems('sections', parsed.sections, 12000),
      ...(args.include_structure ? { structure: boundedStructure(parsed, max) } : {}), ...(args.include_html ? { body: page.body } : {}) };
  }
  async attachments(args: Record<string, unknown>) {
    if (args.read_content && args.attachmentId === undefined
      || !args.read_content && ('text_offset' in args || 'max_text_chars' in args)) throw new ReadError('INVALID_ARGUMENT');
    if (args.expected_version !== undefined && args.attachmentId === undefined) throw new ReadError('INVALID_ARGUMENT');
    const id = await this.resolve(String(args.pageId));
    const summary = (value: unknown) => {
      const a = object(value), metadata = a.metadata ? object(a.metadata) : {}, extensions = a.extensions ? object(a.extensions) : {};
      return { id: a.id, name: a.title, media_type: metadata.mediaType ?? extensions.mediaType ?? null,
        size: extensions.fileSize ?? null, version: a.version ?? null,
        download_url: this.absolute(a._links ? object(a._links).download : null) };
    };
    if (args.attachmentId !== undefined) {
      const a = await this.rest.get('content/' + args.attachmentId, { expand: 'version,container' });
      if (String(a.id) !== args.attachmentId || a.type !== 'attachment' || String(object(a.container).id) !== id) throw new ReadError('CONTENT_INCOMPLETE');
      if (args.expected_version !== undefined && object(a.version).number !== args.expected_version) throw new ReadError('PAGE_VERSION_CHANGED');
      const metadata = summary(a);
      if (args.read_content === true) {
        if (!Number.isSafeInteger(object(a.version).number) || Number(object(a.version).number) < 1 || !metadata.download_url) throw new ReadError('CONTENT_INCOMPLETE');
        const download = new URL(metadata.download_url), prefix = new URL(this.rest.base).pathname.replace(/\/$/u, '') + '/download/attachments/' + id + '/';
        if (!download.pathname.startsWith(prefix) || decodeURIComponent(download.pathname.slice(prefix.length)) !== metadata.name) throw new ReadError('INVALID_ROUTE');
        download.searchParams.set('version', String(object(a.version).number));
        metadata.download_url = download.href;
        return { ...metadata, ...await readAttachment(await this.rest.download(metadata.download_url), metadata, args) };
      }
      return metadata;
    }
    const limit = Number(args.limit ?? 100), start = Number(args.start ?? 0);
    const data = await this.rest.get('content/' + id + '/child/attachment', { limit, start, expand: 'version' });
    return { results: list(data.results).map(summary), pagination: this.pagination(data, start, limit) };
  }

  async children(args: Record<string, unknown>) {
    const id = await this.resolve(String(args.pageId)), limit = Number(args.limit ?? 25), start = Number(args.start ?? 0);
    const data = await this.rest.get('content/' + id + '/child/page', { limit, start, expand: 'space,version' });
    return { parent_id: id, results: list(data.results).map(p => this.summary(p)), pagination: this.pagination(data, start, limit) };
  }
  async comments(args: Record<string, unknown>) {
    const id = await this.resolve(String(args.pageId)), limit = Number(args.limit ?? 25), start = Number(args.start ?? 0);
    const data = await this.rest.get(`content/${id}/${args.include_replies ? 'descendant' : 'child'}/comment`,
      { limit, start, expand: 'body.view,version,extensions.inlineProperties,extensions.resolution' });
    const results = list(data.results).map(value => {
      const c = object(value), version = object(c.version);
      if (c.type !== 'comment' || typeof c.id !== 'string' || !/^[0-9]+$/u.test(c.id) || !Number.isSafeInteger(version.number) || Number(version.number) < 1) throw new ReadError('CONTENT_INCOMPLETE');
      const html = object(object(c.body).view).value;
      if (typeof html !== 'string') throw new ReadError('CONTENT_INCOMPLETE');
      const safe = Object.fromEntries(['id', 'type', 'status', 'title'].filter(k => typeof c[k] === 'string').map(k => [k, c[k]]));
      const result: Record<string, unknown> = { ...this.summary({ ...safe, version: { number: version.number, ...(typeof version.when === 'string' ? { when: version.when } : {}) } }),
        url: this.rest.base + '/pages/viewpage.action?pageId=' + id, text: parseDocument(html, this.rest.base, id, 'view').text };
      const ext = c.extensions && typeof c.extensions === 'object' && !Array.isArray(c.extensions) ? c.extensions as Record<string, unknown> : {};
      for (const [name, fields] of [['inlineProperties', ['inline-marker-ref', 'inline-original-selection']], ['resolution', ['status', 'lastModifiedDate']]] as const) {
        const value = ext[name];
        if (value && typeof value === 'object' && !Array.isArray(value)) result[name] = Object.fromEntries(fields.filter(k => typeof (value as Record<string, unknown>)[k] === 'string').map(k => [k, (value as Record<string, unknown>)[k]]));
      }
      return result;
    });
    for (const [key, minimum] of [['start', 0], ['limit', 1], ['size', 0]] as const)
      if (data[key] !== undefined && (!Number.isSafeInteger(data[key]) || Number(data[key]) < minimum)) throw new ReadError('CONTENT_INCOMPLETE');
    const links = data._links === undefined ? {} : object(data._links);
    if ('next' in links && typeof links.next !== 'string') throw new ReadError('CONTENT_INCOMPLETE');
    return { page_id: id, content_scope: 'discussion', scope: args.include_replies ? 'comment_descendants' : 'direct_comments', results, pagination: this.pagination(data, start, limit) };
  }
  async compare(args: Record<string, unknown>) {
    const id = await this.resolve(String(args.pageId)), storage: string[] = [];
    for (const version of [Number(args.from_version), Number(args.to_version)]) {
      const page = await this.rest.get('content/' + id, { version, expand: 'body.storage,version,space' });
      if (page.id !== id || page.type !== 'page') throw new ReadError('CONTENT_INCOMPLETE');
      if (!page.version || typeof page.version !== 'object' || Array.isArray(page.version)
        || (page.version as Record<string, unknown>).number !== version) throw new ReadError('PAGE_VERSION_CHANGED');
      const value = object(object(page.body).storage).value;
      if (typeof value !== 'string') throw new ReadError('CONTENT_INCOMPLETE');
      storage.push(value);
    }
    const diff = unifiedDiff(storage[0], storage[1], 'version-' + args.from_version, 'version-' + args.to_version), points = [...diff], max = Number(args.max_chars ?? 12000);
    return { page_id: id, url: this.rest.base + '/pages/viewpage.action?pageId=' + id, from_version: args.from_version, to_version: args.to_version,
      changed: storage[0] !== storage[1], diff: points.slice(0, max).join(''), diff_scope: 'storage', truncated: points.length > max, returned_chars: Math.min(points.length, max), total_chars: points.length };
  }
}

function boundedStructure(parsed: ReturnType<typeof parseDocument>, budget: number) {
  const result: Record<string, any> = { representation: parsed.representation, truncated: false, total_items: {}, returned_items: {} };
  for (const key of ['sections', 'tables', 'references', 'unresolved_macros', 'warnings'] as const) { result[key] = []; result.total_items[key] = parsed[key].length; result.returned_items[key] = 0; }
  for (const key of ['sections', 'tables', 'references', 'unresolved_macros', 'warnings'] as const) for (const item of parsed[key]) {
    result[key].push(item); result.returned_items[key]++;
    if ([...JSON.stringify(result)].length > budget) { result[key].pop(); result.returned_items[key]--; result.truncated = true; break; }
  }
  return result;
}
