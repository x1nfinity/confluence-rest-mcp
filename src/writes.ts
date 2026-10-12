import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeBase } from './config.js';
import { ReadError } from './errors.js';
import { patchStorage, validUtf8, MAX_BODY_BYTES } from './page-patch.js';
import { unifiedDiff } from './history.js';
import { allowedRoute, validLabel, type WritePayload } from './rest.js';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

type ObjectValue = Record<string, unknown>;
export type WriteRest = {
  base: string;
  get(path: string, params?: Record<string, string | number>): Promise<ObjectValue>;
  write(method: 'POST' | 'PUT' | 'DELETE', path: string, payload: WritePayload, file?: Buffer): Promise<ObjectValue>;
};
export type WriteGate = { allow_write: boolean; readOnly: boolean; writeSpaces?: string[] };
export const writeNames = ['create_page', 'update_page', 'patch_page', 'add_labels', 'remove_label', 'add_comment', 'copy_page', 'move_page', 'upload_attachment'];
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
    const site = normalizeBase(base);
    if (!validUtf8(base) || !['POST', 'PUT', 'DELETE'].includes(method)) throw 0;
    allowedRoute(site, site + '/rest/api/' + path, method);
    if (!Array.isArray(payload)) record(payload);
    return createHash('sha256').update(canonical({ base_url: base, method, path, payload })).digest('hex');
  } catch { throw new ReadError('INVALID_ARGUMENT'); }
}
export function verifyPreview(expected: unknown, base: string, method: string, path: string, payload: WritePayload) {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(expected)) throw new ReadError('INVALID_ARGUMENT');
  if (!timingSafeEqual(Buffer.from(expected.toLowerCase()), Buffer.from(previewHash(base, method, path, payload))))
    throw new ReadError('PREVIEW_MISMATCH');
}

function argumentsFor(name: string, input: unknown) {
  if (!writeNames.includes(name)) throw new ReadError('NOT_SUPPORTED');
  const required = name === 'create_page' ? ['space_key', 'title', 'body_storage']
    : name === 'update_page' ? ['pageId', 'title', 'body_storage', 'expected_version']
      : name === 'patch_page' ? ['pageId', 'operation', 'body_storage', 'expected_version']
        : ['pageId', 'expected_version', ...(name === 'add_labels' ? ['labels'] : name === 'remove_label' ? ['label']
          : name === 'add_comment' ? ['body_storage'] : name === 'copy_page' ? ['space_key', 'title']
            : name === 'move_page' ? ['parent_id'] : ['file_path'])];
  const allowed = [...required, 'dry_run', 'preview_hash', ...(['create_page', 'copy_page'].includes(name) ? ['parent_id'] : name === 'patch_page' ? ['old_fragment'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReadError('INVALID_ARGUMENT');
  const args = input as ObjectValue;
  if (Object.keys(args).some(key => !allowed.includes(key)) || required.some(key => !(key in args)))
    throw new ReadError('INVALID_ARGUMENT');
  for (const key of ['pageId', 'space_key', 'title', 'body_storage', 'old_fragment', 'file_path']) if (key in args) {
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
    || name === 'move_page' && args.parent_id == null
    || name === 'upload_attachment' && (!isAbsolute(args.file_path as string) || [...String(args.file_path)].length > 4096)
    || name === 'remove_label' && !validLabel(args.label)
    || name === 'add_labels' && (!Array.isArray(args.labels) || !args.labels.length || args.labels.length > 20
      || args.labels.some(v => !validLabel(v)) || new Set(args.labels).size !== args.labels.length)
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
    try { page = record(await this.rest.get('content/' + id, { expand: 'body.storage,version,space,ancestors' })); }
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
  private async submit(method: 'POST' | 'PUT', path: string, payload: ObjectValue, expected: unknown, movedSpace?: string) {
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
    if (movedSpace !== undefined) {
      try {
        if (record(page.space).key !== movedSpace || !Array.isArray(page.ancestors)
          || String(record(page.ancestors.at(-1)).id) !== String(record((payload.ancestors as unknown[])[0]).id)) throw 0;
      } catch { throw new ReadError('WRITE_UNCERTAIN'); }
    }
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
    if (name === 'copy_page') {
      const id = await this.resolve(args.pageId as string), page = await this.page(id), old = this.current(page, args.expected_version);
      if (!dry) {
        const checked = this.current(await this.page(id), args.expected_version);
        if (checked.body !== old.body || checked.title !== old.title || checked.space !== old.space) throw new ReadError('VERSION_CONFLICT');
      }
      const result = await this.call('create_page', { space_key: args.space_key, title: args.title, body_storage: old.body,
        ...(args.parent_id != null ? { parent_id: args.parent_id } : {}), dry_run: dry,
        ...(args.preview_hash !== undefined ? { preview_hash: args.preview_hash } : {}) });
      return { ...result, source_page: { id, version: old.version }, scope: 'single_page_storage',
        warnings: ['copy_excludes_children_attachments_comments_labels_permissions', 'storage_references_preserved'] };
    }
    if (['add_labels', 'remove_label', 'add_comment', 'upload_attachment'].includes(name)) return this.collaborate(name, args, dry);
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
    const patch = name === 'patch_page', moving = name === 'move_page';
    const id = await this.resolve(args.pageId as string), page = await this.page(id);
    const old = this.current(page, args.expected_version, patch ? 'CONTENT_INCOMPLETE' : 'READ_FAILED');
    const title = patch || moving ? old.title : args.title, body = moving ? old.body : patch
      ? patchStorage(old.body, args.operation as string, args.body_storage as string, args.old_fragment as string | undefined)
      : args.body_storage as string;
    if (patch) {
      const checked = this.current(await this.page(id), args.expected_version);
      if (checked.body !== old.body || checked.title !== old.title || checked.space !== old.space) throw new ReadError('VERSION_CONFLICT');
    }
    const payload = { id, type: 'page', status: 'current', title,
      ...(!moving ? { body: { storage: { value: body, representation: 'storage' } } } : {}), version: { number: old.version + 1 },
      ...(moving ? { ancestors: [{ id: args.parent_id }] } : {}) };
    if (moving) {
      await this.moveParent(id, args.parent_id as string, old.space);
      if (!dry) {
        const checked = this.current(await this.page(id), args.expected_version);
        if (checked.body !== old.body || checked.title !== old.title || checked.space !== old.space) throw new ReadError('VERSION_CONFLICT');
        await this.moveParent(id, args.parent_id as string, old.space);
      }
    }
    const path = 'content/' + id;
    if (!dry) return this.submit('PUT', path, payload, args.preview_hash, moving ? old.space : undefined);
    const diff = patch ? unifiedDiff(old.body, body, 'before-storage', 'after-storage', false) : '';
    return { dry_run: true, executed: false, message: '仅预览，尚未执行更新。',
      target: { base_url: this.rest.base, pageId: id, space_key: old.space }, before: { title: old.title, body_storage: old.body },
      after: { title, body_storage: body }, current_version: old.version, proposed_version: old.version + 1,
      method: 'PUT', url: this.rest.base + '/rest/api/' + path, payload,
      preview_hash: previewHash(this.rest.base, 'PUT', path, payload),
      ...(!this.gate.writeSpaces?.length ? { write_scope_configured: false } : {}),
      ...(patch ? { operation: args.operation, diff: Array.from(diff).slice(0, 12000).join(''), diff_truncated: [...diff].length > 12000 } : {}) };
  }
  private async moveParent(id: string, parentId: string, space: string) {
    if (id === parentId) throw new ReadError('INVALID_ARGUMENT');
    const parent = await this.page(parentId);
    if (record(parent.space).key !== space) throw new ReadError('INVALID_ARGUMENT');
    if (!Array.isArray(parent.ancestors)) throw new ReadError('CONTENT_INCOMPLETE');
    if (parent.ancestors.some(p => !/^[1-9][0-9]*$/u.test(String(record(p).id)))) throw new ReadError('CONTENT_INCOMPLETE');
    if (parent.ancestors.some(p => String(record(p).id) === id)) throw new ReadError('INVALID_ARGUMENT');
  }
  private file(path: string) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new ReadError('FILE_INVALID');
      if (stat.size > 4 * 1048576) throw new ReadError('FILE_TOO_LARGE');
      const buffer = Buffer.alloc(4 * 1048576 + 1); let size = 0, count: number;
      while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
      if (size > 4 * 1048576) throw new ReadError('FILE_TOO_LARGE');
      const filename = basename(path);
      if (!filename || Buffer.byteLength(filename) > 255 || /["/\\\x00-\x1f\x7f\p{Surrogate}]/u.test(filename)) throw new ReadError('FILE_INVALID');
      const data = buffer.subarray(0, size);
      return { data, payload: { filename, size, sha256: createHash('sha256').update(data).digest('hex') } };
    } catch (error) { throw error instanceof ReadError ? error : new ReadError('FILE_INVALID'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  private async collaborate(name: string, args: ObjectValue, dry: boolean): Promise<ObjectValue> {
    const id = await this.resolve(args.pageId as string), page = await this.page(id), old = this.current(page, args.expected_version);
    const file = name === 'upload_attachment' ? this.file(args.file_path as string) : undefined;
    const method = name === 'remove_label' ? 'DELETE' : 'POST';
    const path = name === 'add_comment' ? 'content' : 'content/' + id + (file ? '/child/attachment' : '/label')
      + (name === 'remove_label' ? '?' + new URLSearchParams({ name: args.label as string })
        : file ? '?' + new URLSearchParams({ allowDuplicated: 'false', expand: 'container,version' }) : '');
    const payload: WritePayload = name === 'add_labels' ? (args.labels as string[]).map(label => ({ prefix: 'global', name: label }))
      : name === 'remove_label' ? {} : file ? file.payload
        : { type: 'comment', container: { id, type: 'page' }, body: { storage: { value: args.body_storage, representation: 'storage' } } };
    const reviewed = { page_version: old.version, request: payload };
    if (file) await this.attachmentAbsent(id, file.payload.filename);
    if (dry) return { dry_run: true, executed: false, target: { base_url: this.rest.base, pageId: id, space_key: old.space },
      current_version: old.version, method, url: this.rest.base + '/rest/api/' + path, payload,
      preview_hash: previewHash(this.rest.base, method, path, reviewed),
      ...(!this.gate.writeSpaces?.length ? { write_scope_configured: false } : {}),
      warnings: ['page_precheck_not_atomic_with_collaboration_write'] };
    this.requireWrite(); verifyPreview(args.preview_hash, this.rest.base, method, path, reviewed);
    const checked = this.current(await this.page(id), args.expected_version);
    if (checked.space !== old.space || checked.body !== old.body || checked.title !== old.title) throw new ReadError('VERSION_CONFLICT');
    if (file) await this.attachmentAbsent(id, file.payload.filename);
    try {
      const response = record(await this.rest.write(method, path, payload, file?.data));
      let result: ObjectValue;
      if (name === 'add_comment') {
        if (typeof response.id !== 'string' || !/^[1-9][0-9]*$/u.test(response.id) || response.type !== 'comment'
          || response.status !== 'current') throw 0;
        let comment = response;
        if (!response.container) {
          try { comment = record(await this.rest.get('content/' + response.id, { expand: 'container,version' })); }
          catch { throw new ReadError('WRITE_UNCERTAIN'); }
        }
        if (comment.id !== response.id || comment.type !== 'comment' || comment.status !== 'current' || String(record(comment.container).id) !== id) throw 0;
        result = { comment: { id: response.id, type: 'comment', pageId: id } };
      } else if (file) {
        if (!Array.isArray(response.results) || response.results.length !== 1) throw 0;
        const item = record(response.results[0]);
        if (typeof item.id !== 'string' || !/^[1-9][0-9]*$/u.test(item.id) || item.type !== 'attachment'
          || item.title !== file.payload.filename || record(item.version).number !== 1
          || String(record(item.container).id) !== id) throw 0;
        result = { attachment: { id: item.id, title: item.title, version: { number: 1 } }, file: file.payload };
      } else if (name === 'add_labels') {
        const labels = response.results;
        if (!Array.isArray(labels) || (args.labels as string[]).some(label => !labels.some(v => {
          const item = record(v); return item.prefix === 'global' && item.name === label;
        }))) throw 0;
        result = { labels: args.labels };
      } else result = { removed_label: args.label };
      return { dry_run: false, executed: true, pageId: id, ...result };
    } catch (error) {
      const safe = error instanceof ReadError ? error : new ReadError('WRITE_UNCERTAIN');
      throw new ReadError(safe.code === 'CONTENT_INCOMPLETE' ? 'WRITE_UNCERTAIN' : safe.code, safe.httpStatus, safe.retryAfter, false);
    }
  }
  private async attachmentAbsent(id: string, filename: string) {
    const found = await this.rest.get('content/' + id + '/child/attachment', { filename, limit: 1, start: 0 });
    if (!Array.isArray(found.results)) throw new ReadError('CONTENT_INCOMPLETE');
    if (found.results.length) throw new ReadError('TARGET_EXISTS');
  }
}
