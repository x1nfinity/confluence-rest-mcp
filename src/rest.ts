import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Credentials, validCredentials } from './auth.js';
import { normalizeBase } from './config.js';
import { ReadError } from './errors.js';

const JSON_LIMIT = 2 * 1024 * 1024, BINARY_LIMIT = 4 * 1024 * 1024;
export type WritePayload = Record<string, unknown> | Record<string, unknown>[];
export type RequestOptions = { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; payload?: WritePayload; file?: Buffer };
export type Sender = (url: URL, credentials: Credentials, timeout: number, options?: RequestOptions) => Promise<Record<string, unknown>>;
export type BinarySender = (url: URL, credentials: Credentials, timeout: number) => Promise<Buffer>;
export function allowedRoute(base: string, value: string, method = 'GET', binary = false): URL {
  base = normalizeBase(base);
  try {
    if (/[\s\x00-\x1f\\#]/u.test(value)) throw 0;
    const url = new URL(value), site = new URL(base);
    const rawPath = value.replace(/^https:\/\/[^/]+/u, '').split('?')[0];
    const context = site.pathname.replace(/\/$/u, ''), prefix = context + '/rest/api/';
    if (url.protocol !== 'https:' || url.origin !== site.origin || url.username || url.password || url.hash
      || rawPath.split('/').some(p => p === '.' || p === '..')) throw 0;
    if (method === 'GET' && binary) {
      const download = context + '/download/attachments/';
      if (!rawPath.startsWith(download) || !/^[0-9]+\/[^/]+$/u.test(rawPath.slice(download.length))) throw 0;
      let filename = rawPath.slice(rawPath.lastIndexOf('/') + 1);
      for (let i = 0; i < 8; i++) {
        // Python unquote preserves literal %, but invalid encoded UTF-8 must still fail.
        const decoded = decodeURIComponent(filename.replace(/%(?![0-9a-f]{2})/giu, '%25'));
        if (decoded === filename) break;
        filename = decoded;
      }
      if (filename === '.' || filename === '..' || /[/\\\x00-\x1f\x7f]|%[0-9a-f]{2}/iu.test(filename)) throw 0;
      return url;
    }
    const patterns: Record<string, RegExp> = {
      GET: /^(?:content(?:\/search|\/[0-9]+(?:\/(?:label|child\/(?:attachment|page|comment)|descendant\/comment))?)?|user\/current)$/u,
      POST: /^content(?:\/[0-9]+\/(?:label|child\/attachment))?$/u, PUT: /^content\/[0-9]+$/u,
      DELETE: /^content\/[0-9]+\/label$/u,
    };
    const upload = method === 'POST' && /^content\/[0-9]+\/child\/attachment$/u.test(rawPath.slice(prefix.length));
    if (binary || rawPath.includes('%') || !rawPath.startsWith(prefix) || !patterns[method]?.test(rawPath.slice(prefix.length))
      || (method !== 'GET' && method !== 'DELETE' && !upload && url.search)) throw 0;
    if (upload && (Array.from(url.searchParams.keys()).sort().join(',') !== 'allowDuplicated,expand'
      || url.searchParams.get('allowDuplicated') !== 'false' || url.searchParams.get('expand') !== 'container,version')) throw 0;
    if (method === 'DELETE' && (Array.from(url.searchParams.keys()).join(',') !== 'name'
      || !validLabel(url.searchParams.get('name')))) throw 0;
    return url;
  } catch { throw new ReadError('INVALID_ROUTE'); }
}
export function httpError(status: number, retryHeader?: string, write = false) {
  const code = write && status >= 500 ? 'WRITE_UNCERTAIN' : status === 401 ? 'LOGIN_REQUIRED' : status === 403 ? 'ACCESS_DENIED'
    : status === 404 ? 'NOT_FOUND_OR_DENIED' : status === 409 ? 'VERSION_CONFLICT'
    : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'SERVER_UNAVAILABLE'
    : status >= 300 && status < 400 ? 'REDIRECT_DENIED' : 'HTTP_FAILED';
  let delay: number | undefined;
  if (retryHeader !== undefined && retryHeader.length <= 128) {
    delay = /^\d{1,6}$/u.test(retryHeader.trim()) ? Number(retryHeader)
      : Math.max(0, Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000));
    if (!Number.isFinite(delay) || delay > 86400) delay = undefined;
  }
  return new ReadError(code, status, delay, write || (retryHeader !== undefined && delay === undefined) ? false : undefined);
}
export function validLabel(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s\x00-\x1f\x7f<>\p{Surrogate}]{1,255}$/u.test(value);
}
function payloadBytes(method: string, url: URL, input: WritePayload) {
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join(',') === expected.sort().join(',');
  if (method === 'DELETE') {
    if (!plain(input) || Object.keys(input).length) throw new ReadError('INVALID_PAYLOAD');
    return undefined;
  }
  if (/\/content\/[0-9]+\/label$/u.test(url.pathname)) {
    if (method !== 'POST' || !Array.isArray(input) || !input.length || input.length > 20
      || input.some(v => !v || Object.keys(v).sort().join(',') !== 'name,prefix' || v.prefix !== 'global' || !validLabel(v.name))
      || new Set(input.map(v => v.name)).size !== input.length) throw new ReadError('INVALID_PAYLOAD');
    return Buffer.from(JSON.stringify(input));
  }
  if (!plain(input)) throw new ReadError('INVALID_PAYLOAD');
  const payload = input;
  const permitted = method === 'POST' ? ['type', 'title', 'body', 'status', 'space', 'ancestors']
    : ['id', 'type', 'title', 'body', 'status', 'version', 'ancestors'];
  if (method === 'POST' && payload.type === 'comment') {
    if (Object.keys(payload).sort().join(',') !== 'body,container,type' || !plain(payload.container)
      || !keys(payload.container, ['id', 'type']) || payload.container.type !== 'page'
      || typeof payload.container.id !== 'string' || !/^[1-9][0-9]*$/u.test(payload.container.id)
      || !plain(payload.body) || !keys(payload.body, ['storage']) || !plain(payload.body.storage)
      || !keys(payload.body.storage, ['value', 'representation']) || payload.body.storage.representation !== 'storage'
      || typeof payload.body.storage.value !== 'string' || !payload.body.storage.value.trim()
      || /\x00|\p{Surrogate}/u.test(payload.body.storage.value) || Buffer.byteLength(payload.body.storage.value) > 1048576)
      throw new ReadError('INVALID_PAYLOAD');
    return Buffer.from(JSON.stringify(payload));
  }
  const moving = method === 'PUT' && payload.ancestors !== undefined && payload.body === undefined;
  if (payload.type !== 'page' || Object.keys(payload).some(k => !permitted.includes(k))
    || typeof payload.title !== 'string' || !payload.title.trim() || [...payload.title].length > 255 || payload.title.includes('\0')
    || /\p{Surrogate}/u.test(payload.title) || (payload.status !== undefined && payload.status !== 'current')
    || !moving && (!plain(payload.body) || !keys(payload.body, ['storage'])
    || !plain(payload.body.storage) || !keys(payload.body.storage, ['value', 'representation'])
    || payload.body.storage.representation !== 'storage' || typeof payload.body.storage.value !== 'string'
    || !payload.body.storage.value.trim() || /\x00|\p{Surrogate}/u.test(payload.body.storage.value + payload.title)
    || Buffer.byteLength(payload.body.storage.value) > 1048576)) throw new ReadError('INVALID_PAYLOAD');
  if (method === 'POST') {
    if (!plain(payload.space) || !keys(payload.space, ['key']) || typeof payload.space.key !== 'string'
      || !payload.space.key.trim() || [...payload.space.key].length > 255 || /\x00|\p{Surrogate}/u.test(payload.space.key)) throw new ReadError('INVALID_PAYLOAD');
  } else if (payload.id !== url.pathname.split('/').at(-1) || !plain(payload.version) || !keys(payload.version, ['number'])
    || !Number.isSafeInteger(payload.version.number) || Number(payload.version.number) < 2) throw new ReadError('INVALID_PAYLOAD');
  if (payload.ancestors !== undefined && (!Array.isArray(payload.ancestors) || payload.ancestors.length > 1
    || method === 'PUT' && payload.ancestors.length !== 1
    || payload.ancestors.some(p => !plain(p) || !keys(p, ['id']) || typeof p.id !== 'string' || !/^[1-9][0-9]*$/u.test(p.id)))) throw new ReadError('INVALID_PAYLOAD');
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > 8 * 1048576) throw new ReadError('INVALID_PAYLOAD');
  return bytes;
}
function requestBody(method: string, url: URL, options: RequestOptions) {
  if (/\/content\/[0-9]+\/child\/attachment$/u.test(url.pathname) && method === 'POST') {
    const meta = options.payload;
    if (!meta || Array.isArray(meta) || Object.keys(meta).sort().join(',') !== 'filename,sha256,size'
      || typeof meta.filename !== 'string' || !meta.filename || Buffer.byteLength(meta.filename) > 255
      || /["/\\\x00-\x1f\x7f\p{Surrogate}]/u.test(meta.filename) || ['.', '..'].includes(meta.filename)
      || !Buffer.isBuffer(options.file) || options.file.length > BINARY_LIMIT || meta.size !== options.file.length
      || meta.sha256 !== createHash('sha256').update(options.file).digest('hex')) throw new ReadError('INVALID_PAYLOAD');
    const boundary = 'confluence-' + randomBytes(24).toString('hex');
    const data = Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="'
      + meta.filename + '"\r\nContent-Type: application/octet-stream\r\n\r\n'), options.file, Buffer.from('\r\n--' + boundary + '--\r\n')]);
    return { data, headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'X-Atlassian-Token': 'nocheck' } };
  }
  if (options.file !== undefined) throw new ReadError('INVALID_PAYLOAD');
  return { data: payloadBytes(method, url, options.payload ?? {}), headers: method === 'DELETE' ? {} : { 'Content-Type': 'application/json; charset=utf-8' } };
}
function requestBytes(url: URL, input: Credentials, timeout: number, options: RequestOptions = {}, binary = false): Promise<Buffer> {
  const credential = validCredentials(input), method = options.method ?? 'GET', write = method !== 'GET';
  const body = write ? requestBody(method, url, options) : undefined, data = body?.data;
  if (!write && (options.payload !== undefined || options.file !== undefined)) throw new ReadError('INVALID_PAYLOAD');
  return new Promise((resolve, reject) => {
    let finished = false;
    const req = https.request(url, { method, agent: false, headers: {
      Accept: binary ? 'application/octet-stream' : 'application/json',
      Authorization: 'Basic ' + Buffer.from(credential.username + ':' + credential.password).toString('base64'),
      ...body?.headers, ...(data ? { 'Content-Length': String(data.length) } : {}),
    } });
    const timer = setTimeout(() => req.destroy(new ReadError(write ? 'WRITE_UNCERTAIN' : 'NETWORK_FAILED')), timeout * 1000);
    const fail = (error: ReadError) => { if (finished) return; finished = true; clearTimeout(timer); req.destroy(); reject(error); };
    req.on('error', error => {
      const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/u.test((error as NodeJS.ErrnoException).code ?? '');
      fail(error instanceof ReadError ? error : new ReadError(write ? 'WRITE_UNCERTAIN' : 'NETWORK_FAILED', undefined, undefined, write || tls ? false : undefined));
    });
    req.on('response', response => {
      const emptyDelete = method === 'DELETE' && response.statusCode === 204;
      if (!(response.statusCode === 200 || (write && [201, 202].includes(response.statusCode ?? 0)) || emptyDelete)) {
        response.destroy(); fail(httpError(response.statusCode ?? 0, response.headers['retry-after'], write)); return;
      }
      if (!binary && !emptyDelete && !response.headers['content-type']?.toLowerCase().includes('application/json')) {
        response.destroy(); fail(new ReadError(write ? 'WRITE_UNCERTAIN' : 'LOGIN_REQUIRED')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length;
        if (size > (binary ? BINARY_LIMIT : JSON_LIMIT)) { response.destroy(); fail(new ReadError(write ? 'WRITE_UNCERTAIN' : 'RESPONSE_TOO_LARGE')); }
        else if (!finished) chunks.push(chunk);
      });
      response.on('aborted', () => fail(new ReadError(write ? 'WRITE_UNCERTAIN' : 'NETWORK_FAILED')));
      response.on('error', () => fail(new ReadError(write ? 'WRITE_UNCERTAIN' : 'NETWORK_FAILED')));
      response.on('end', () => { if (!finished) { finished = true; clearTimeout(timer); resolve(Buffer.concat(chunks)); } });
    });
    req.end(data);
  });
}
export const sendJson: Sender = async (url, input, timeout, options = {}) => {
  const bytes = await requestBytes(url, input, timeout, options);
  if (options.method === 'DELETE' && !bytes.length) return {};
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value as Record<string, unknown>;
  } catch { throw new ReadError(options.method && options.method !== 'GET' ? 'WRITE_UNCERTAIN' : 'CONTENT_INCOMPLETE'); }
};
export const sendBinary: BinarySender = (url, input, timeout) => requestBytes(url, input, timeout, {}, true);
export class RestClient {
  constructor(public base: string, public timeout: number,
    private load: (signal?: AbortSignal) => Promise<Credentials>, private sender: Sender = sendJson,
    private binarySender: BinarySender = sendBinary) {
    this.base = normalizeBase(base);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120) throw new ReadError('INVALID_REQUEST');
  }
  private async read<T>(url: URL, sender: (url: URL, credentials: Credentials, timeout: number) => Promise<T>, explicit?: Credentials, budget = this.timeout): Promise<T> {
    const started = performance.now();
    for (let attempt = 0; ; attempt++) {
      const remaining = budget - (performance.now() - started) / 1000;
      if (remaining <= 0) throw new ReadError('NETWORK_FAILED');
      try {
        const input = validCredentials(explicit ?? await this.load(AbortSignal.timeout(Math.max(1, Math.ceil(remaining * 1000)))));
        const remainingBudget = budget - (performance.now() - started) / 1000;
        if (remainingBudget <= 0) throw new ReadError('NETWORK_FAILED');
        return await sender(url, input, remainingBudget);
      } catch (error) {
        if (!(error instanceof ReadError) || attempt || !error.details().retryable
          || !['NETWORK_FAILED', 'SERVER_UNAVAILABLE', 'RATE_LIMITED'].includes(error.code)) throw error;
        const delay = error.retryAfter ?? 0.2;
        if (budget - (performance.now() - started) / 1000 <= delay) throw error;
        await sleep(delay * 1000);
      }
    }
  }
  async get(path: string, params: Record<string, string | number> = {}, explicit?: Credentials, budget = this.timeout) {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    const url = allowedRoute(this.base, this.base + '/rest/api/' + path + (query.size ? '?' + query : ''));
    if (explicit && path !== 'user/current') throw new ReadError('INVALID_REQUEST');
    return this.read(url, this.sender, explicit, budget);
  }
  async download(value: string): Promise<Buffer> { return this.read(allowedRoute(this.base, value, 'GET', true), this.binarySender); }
  async write(method: 'POST' | 'PUT' | 'DELETE', path: string, payload: WritePayload, file?: Buffer) {
    const url = allowedRoute(this.base, this.base + '/rest/api/' + path, method);
    const options = { method, payload, ...(file ? { file } : {}) };
    requestBody(method, url, options);
    const start = performance.now(), input = await this.load(AbortSignal.timeout(Math.ceil(this.timeout * 1000)));
    const remaining = this.timeout - (performance.now() - start) / 1000;
    if (remaining <= 0) throw new ReadError('NETWORK_FAILED');
    try { return await this.sender(url, validCredentials(input), remaining, options); }
    catch (e) { if (e instanceof ReadError) throw e; throw new ReadError('WRITE_UNCERTAIN'); }
  }
  async verify(explicit?: Credentials) {
    const started = performance.now();
    const expected = explicit ?? await this.load(AbortSignal.timeout(Math.ceil(this.timeout * 1000)));
    const remaining = this.timeout - (performance.now() - started) / 1000;
    if (remaining <= 0) throw new ReadError('NETWORK_FAILED');
    const user = await this.get('user/current', {}, expected, remaining);
    if (user.type !== 'known' || user.username !== expected.username) throw new ReadError('LOGIN_FAILED');
    return { authenticated: true };
  }
}
