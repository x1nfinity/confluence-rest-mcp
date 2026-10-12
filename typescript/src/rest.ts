import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Credentials, validCredentials } from './auth.js';
import { normalizeBase } from './config.js';
import { ReadError } from './errors.js';

const JSON_LIMIT = 2 * 1024 * 1024, BINARY_LIMIT = 4 * 1024 * 1024;
export type RequestOptions = { method?: 'GET' | 'POST' | 'PUT'; payload?: Record<string, unknown> };
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
      GET: /^(?:content(?:\/search|\/[0-9]+(?:\/(?:child\/(?:attachment|page|comment)|descendant\/comment))?)?|user\/current)$/u,
      POST: /^content$/u, PUT: /^content\/[0-9]+$/u,
    };
    if (binary || rawPath.includes('%') || !rawPath.startsWith(prefix) || !patterns[method]?.test(rawPath.slice(prefix.length))
      || (method !== 'GET' && url.search)) throw 0;
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
function payloadBytes(method: string, url: URL, payload: Record<string, unknown>) {
  const permitted = method === 'POST' ? ['type', 'title', 'body', 'status', 'space', 'ancestors']
    : ['id', 'type', 'title', 'body', 'status', 'version'];
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join(',') === expected.sort().join(',');
  if (!plain(payload) || payload.type !== 'page' || Object.keys(payload).some(k => !permitted.includes(k))
    || typeof payload.title !== 'string' || !payload.title.trim() || [...payload.title].length > 255 || payload.title.includes('\0')
    || (payload.status !== undefined && payload.status !== 'current') || !plain(payload.body) || !keys(payload.body, ['storage'])
    || !plain(payload.body.storage) || !keys(payload.body.storage, ['value', 'representation'])
    || payload.body.storage.representation !== 'storage' || typeof payload.body.storage.value !== 'string'
    || !payload.body.storage.value.trim() || /\x00|\p{Surrogate}/u.test(payload.body.storage.value + payload.title)
    || Buffer.byteLength(payload.body.storage.value) > 1048576) throw new ReadError('INVALID_PAYLOAD');
  if (method === 'POST') {
    if (!plain(payload.space) || !keys(payload.space, ['key']) || typeof payload.space.key !== 'string'
      || !payload.space.key.trim() || [...payload.space.key].length > 255 || /\x00|\p{Surrogate}/u.test(payload.space.key)) throw new ReadError('INVALID_PAYLOAD');
    if (payload.ancestors !== undefined && (!Array.isArray(payload.ancestors) || payload.ancestors.length > 1
      || payload.ancestors.some(p => !plain(p) || !keys(p, ['id']) || typeof p.id !== 'string' || !/^[1-9][0-9]*$/u.test(p.id)))) throw new ReadError('INVALID_PAYLOAD');
  } else if (payload.id !== url.pathname.split('/').at(-1) || !plain(payload.version) || !keys(payload.version, ['number'])
    || !Number.isSafeInteger(payload.version.number) || Number(payload.version.number) < 2) throw new ReadError('INVALID_PAYLOAD');
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > 8 * 1048576) throw new ReadError('INVALID_PAYLOAD');
  return bytes;
}
function requestBytes(url: URL, input: Credentials, timeout: number, options: RequestOptions = {}, binary = false): Promise<Buffer> {
  const credential = validCredentials(input), method = options.method ?? 'GET', write = method !== 'GET';
  const data = write ? payloadBytes(method, url, options.payload ?? {}) : undefined;
  if (!write && options.payload !== undefined) throw new ReadError('INVALID_PAYLOAD');
  return new Promise((resolve, reject) => {
    let finished = false;
    const req = https.request(url, { method, agent: false, headers: {
      Accept: binary ? 'application/octet-stream' : 'application/json',
      Authorization: 'Basic ' + Buffer.from(credential.username + ':' + credential.password).toString('base64'),
      ...(write ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    } });
    const timer = setTimeout(() => req.destroy(new ReadError(write ? 'WRITE_UNCERTAIN' : 'NETWORK_FAILED')), timeout * 1000);
    const fail = (error: ReadError) => { if (finished) return; finished = true; clearTimeout(timer); req.destroy(); reject(error); };
    req.on('error', error => {
      const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/u.test((error as NodeJS.ErrnoException).code ?? '');
      fail(error instanceof ReadError ? error : new ReadError(write ? 'WRITE_UNCERTAIN' : 'NETWORK_FAILED', undefined, undefined, write || tls ? false : undefined));
    });
    req.on('response', response => {
      if (!(response.statusCode === 200 || (write && [201, 202].includes(response.statusCode ?? 0)))) {
        response.destroy(); fail(httpError(response.statusCode ?? 0, response.headers['retry-after'], write)); return;
      }
      if (!binary && !response.headers['content-type']?.toLowerCase().includes('application/json')) {
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
  async write(method: 'POST' | 'PUT', path: string, payload: Record<string, unknown>) {
    const url = allowedRoute(this.base, this.base + '/rest/api/' + path, method);
    payloadBytes(method, url, payload);
    const start = performance.now(), input = await this.load(AbortSignal.timeout(Math.ceil(this.timeout * 1000)));
    const remaining = this.timeout - (performance.now() - start) / 1000;
    if (remaining <= 0) throw new ReadError('NETWORK_FAILED');
    try { return await this.sender(url, validCredentials(input), remaining, { method, payload }); }
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
