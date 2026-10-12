import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeBase } from './config.js';
import { ReadError } from './errors.js';
import { patchStorage, validUtf8, MAX_BODY_BYTES } from './page-patch.js';
import { unifiedDiff } from './history.js';

type ObjectValue = Record<string, unknown>;
export type WriteRest = {
  base: string;
  get(path: string, params?: Record<string, string | number>): Promise<ObjectValue>;
  write(method: 'POST' | 'PUT', path: string, payload: ObjectValue): Promise<ObjectValue>;
};
export type WriteGate = { allow_write: boolean; readOnly: boolean; writeSpaces?: string[] };
const names = ['create_page', 'update_page', 'patch_page'];
const record = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReadError('CONTENT_INCOMPLETE');
  return value as ObjectValue;
};
function keyOrder(a: string, b: string) {
  const left = Array.from(a, s => s.codePointAt(0)!), right = Array.from(b, s => s.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return left.length - right.length;
}
// Python sort_keys orders Unicode code points, including astral object keys.
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!validUtf8(value)) throw 0;
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw 0;
    let encoded = JSON.stringify(value);
    if (!Number.isInteger(value) && value !== 0 && Math.abs(value) < 0.0001) encoded = value.toExponential();
    return encoded.replace(/e([+-]?)(\d)$/u, 'e$10$2');
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw 0;
  ancestors.add(value);
  let encoded: string;
  if (Array.isArray(value)) encoded = '[' + Array.from(value, v => canonical(v, ancestors)).join(',') + ']';
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
      || Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw 0;
    encoded = '{' + Object.keys(value).sort(keyOrder).map(key => canonical(key) + ':' + canonical((value as ObjectValue)[key], ancestors)).join(',') + '}';
  }
  ancestors.delete(value);
  return encoded;
}
export function previewHash(base: string, method: string, path: string, payload: unknown) {
  try {
    normalizeBase(base);
    if (!validUtf8(base) || !((method === 'POST' && path === 'content')
      || method === 'PUT' && /^content\/[0-9]+$/u.test(path))) throw 0;
    record(payload);
    return createHash('sha256').update(canonical({ base_url: base, method, path, payload })).digest('hex');
  } catch { throw new ReadError('INVALID_ARGUMENT'); }
}
export function verifyPreview(expected: unknown, base: string, method: string, path: string, payload: ObjectValue) {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(expected)) throw new ReadError('INVALID_ARGUMENT');
  if (!timingSafeEqual(Buffer.from(expected.toLowerCase()), Buffer.from(previewHash(base, method, path, payload))))
    throw new ReadError('PREVIEW_MISMATCH');
}

function argumentsFor(name: string, input: unknown) {
  if (!names.includes(name)) throw new ReadError('NOT_SUPPORTED');
  const required = name === 'create_page' ? ['space_key', 'title', 'body_storage']
    : name === 'update_page' ? ['pageId', 'title', 'body_storage', 'expected_version']
      : ['pageId', 'operation', 'body_storage', 'expected_version'];
  const allowed = [...required, 'dry_run', 'preview_hash', ...(name === 'create_page' ? ['parent_id'] : name === 'patch_page' ? ['old_fragment'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReadError('INVALID_ARGUMENT');
  const args = input as ObjectValue;
  if (Object.keys(args).some(key => !allowed.includes(key)) || required.some(key => !(key in args)))
    throw new ReadError('INVALID_ARGUMENT');
  for (const key of ['pageId', 'space_key', 'title', 'body_storage', 'old_fragment']) if (key in args) {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !validUtf8(value)
      || ['space_key', 'title'].includes(key) && [...value].length > 255
      || ['body_storage', 'old_fragment'].includes(key) && Buffer.byteLength(value) > MAX_BODY_BYTES)
      throw new ReadError('INVALID_ARGUMENT');
  }
  if ('dry_run' in args && typeof args.dry_run !== 'boolean'
    || 'preview_hash' in args && (typeof args.preview_hash !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(args.preview_hash))
    || 'expected_version' in args && (!Number.isSafeInteger(args.expected_version) || Number(args.expected_version) < 1)
    || args.parent_id != null && (typeof args.parent_id !== 'string' || args.parent_id.length > 255 || !/^[1-9][0-9]*$/u.test(args.parent_id))
    || name === 'patch_page' && (!['append', 'replace'].includes(String(args.operation))
      || args.operation === 'append' && 'old_fragment' in args
      || args.operation === 'replace' && !('old_fragment' in args))) throw new ReadError('INVALID_ARGUMENT');
  return args;
}

export class WriteService {
  constructor(private rest: WriteRest, private gate: WriteGate, private resolve: (reference: string) => Promise<string>) {}
  private requireWrite() {
    if (this.gate.allow_write !== true || this.gate.readOnly !== false) throw new ReadError('WRITE_DISABLED');
    if (!this.gate.writeSpaces?.length) throw new ReadError('WRITE_SCOPE_REQUIRED');
  }
  private space(key: unknown): string {
    if (typeof key !== 'string' || !key) throw new ReadError('CONTENT_INCOMPLETE');
    if (this.gate.writeSpaces !== undefined && !this.gate.writeSpaces.includes(key)) throw new ReadError('SPACE_NOT_ALLOWED');
    return key;
  }
  private async page(id: string) {
    let page: ObjectValue;
    try { page = record(await this.rest.get('content/' + id, { expand: 'body.storage,version,space' })); }
    catch { throw new ReadError('READ_FAILED'); }
    if (String(page.id) !== id || page.type !== 'page' || page.status !== 'current') throw new ReadError('READ_FAILED');
    if (!page.space || typeof page.space !== 'object' || Array.isArray(page.space)
      || typeof (page.space as ObjectValue).key !== 'string' || !(page.space as ObjectValue).key)
      throw new ReadError('READ_FAILED');
    this.space((page.space as ObjectValue).key);
    return page;
  }
  private current(page: ObjectValue, version: unknown, incompleteCode = 'READ_FAILED') {
    const current = page.version && typeof page.version === 'object' && !Array.isArray(page.version)
      ? (page.version as ObjectValue).number : undefined;
    if (!Number.isSafeInteger(current) || Number(current) < 1 || current !== version || Number(current) >= Number.MAX_SAFE_INTEGER)
      throw new ReadError('VERSION_CONFLICT');
    let body: unknown;
    try { body = record(record(page.body).storage).value; } catch { throw new ReadError(incompleteCode); }
    if (typeof body !== 'string' || typeof page.title !== 'string') throw new ReadError(incompleteCode);
    return { title: page.title, body, version: Number(current), space: this.space(record(page.space).key) };
  }
  private async submit(method: 'POST' | 'PUT', path: string, payload: ObjectValue, expected: unknown) {
    this.requireWrite(); verifyPreview(expected, this.rest.base, method, path, payload);
    let page: ObjectValue;
    try { page = record(await this.rest.write(method, path, payload)); }
    catch (error) {
      const safe = error instanceof ReadError ? error : new ReadError('WRITE_UNCERTAIN');
      throw new ReadError(safe.code === 'HTTP_409' ? 'VERSION_CONFLICT' : safe.code === 'CONTENT_INCOMPLETE' ? 'WRITE_UNCERTAIN' : safe.code,
        safe.httpStatus, safe.retryAfter, false);
    }
    let version: unknown;
    try { version = record(page.version).number; }
    catch { throw new ReadError('WRITE_UNCERTAIN'); }
    if (typeof page.id !== 'string' || !/^[0-9]+$/u.test(page.id) || page.type !== 'page' || page.status !== 'current'
      || page.title !== payload.title || !Number.isSafeInteger(version) || Number(version) < 1
      || method === 'POST' && (!page.space || typeof page.space !== 'object' || Array.isArray(page.space)
        || (page.space as ObjectValue).key !== record(payload.space).key)
      || method === 'PUT' && (page.id !== payload.id || version !== record(payload.version).number)) throw new ReadError('WRITE_UNCERTAIN');
    return { dry_run: false, executed: true, page: { id: page.id, type: page.type, status: page.status, title: page.title,
      url: this.rest.base + '/pages/viewpage.action?pageId=' + page.id, version: { number: version } } };
  }
  async call(name: string, input: unknown): Promise<ObjectValue> {
    const args = argumentsFor(name, input), dry = args.dry_run !== false;
    if (!dry) this.requireWrite();
    if (name === 'create_page') {
      const space = this.space(args.space_key), parentId = args.parent_id ?? null;
      const payload: ObjectValue = { type: 'page', status: 'current', title: args.title, space: { key: space },
        body: { storage: { value: args.body_storage, representation: 'storage' } } };
      let parent: ObjectValue | undefined;
      if (parentId !== null) {
        parent = await this.page(parentId as string);
        if (record(parent.space).key !== space) throw new ReadError('READ_FAILED');
        payload.ancestors = [{ id: parentId }];
      }
      let duplicate: ObjectValue;
      try { duplicate = record(await this.rest.get('content/search', {
        cql: 'type = page AND space = ' + JSON.stringify(space) + ' AND title = ' + JSON.stringify(args.title), limit: 1, start: 0,
      })); } catch { throw new ReadError('READ_FAILED'); }
      if (!Array.isArray(duplicate.results) || duplicate.results.length) throw new ReadError('READ_FAILED');
      if (!dry) return this.submit('POST', 'content', payload, args.preview_hash);
      return { dry_run: true, executed: false, message: '仅预览，尚未执行创建。',
        target: { base_url: this.rest.base, space_key: space, parent_id: parentId, ...(parent ? { parent_title: parent.title } : {}) },
        method: 'POST', url: this.rest.base + '/rest/api/content', payload,
        preview_hash: previewHash(this.rest.base, 'POST', 'content', payload),
        ...(!this.gate.writeSpaces?.length ? { write_scope_configured: false } : {}) };
    }
    const patch = name === 'patch_page';
    const id = await this.resolve(args.pageId as string), page = await this.page(id);
    const old = this.current(page, args.expected_version, patch ? 'CONTENT_INCOMPLETE' : 'READ_FAILED');
    const title = patch ? old.title : args.title, body = patch
      ? patchStorage(old.body, args.operation as string, args.body_storage as string, args.old_fragment as string | undefined)
      : args.body_storage as string;
    if (patch) {
      const checked = this.current(await this.page(id), args.expected_version);
      if (checked.body !== old.body || checked.title !== old.title || checked.space !== old.space) throw new ReadError('VERSION_CONFLICT');
    }
    const payload = { id, type: 'page', status: 'current', title,
      body: { storage: { value: body, representation: 'storage' } }, version: { number: old.version + 1 } };
    const path = 'content/' + id;
    if (!dry) return this.submit('PUT', path, payload, args.preview_hash);
    const diff = patch ? unifiedDiff(old.body, body, 'before-storage', 'after-storage', false) : '';
    return { dry_run: true, executed: false, message: '仅预览，尚未执行更新。',
      target: { base_url: this.rest.base, pageId: id, space_key: old.space }, before: { title: old.title, body_storage: old.body },
      after: { title, body_storage: body }, current_version: old.version, proposed_version: old.version + 1,
      method: 'PUT', url: this.rest.base + '/rest/api/' + path, payload,
      preview_hash: previewHash(this.rest.base, 'PUT', path, payload),
      ...(!this.gate.writeSpaces?.length ? { write_scope_configured: false } : {}),
      ...(patch ? { operation: args.operation, diff: Array.from(diff).slice(0, 12000).join(''), diff_truncated: [...diff].length > 12000 } : {}) };
  }
}
