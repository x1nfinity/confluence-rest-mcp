import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { readFileSync, lstatSync } from 'node:fs';
import { ReadError } from './errors.js';
import contracts from './contracts.json' with { type: 'json' };

export type Environment = Record<string, string | undefined>;
export function normalizeBase(value: unknown): string {
  try {
    if (typeof value !== 'string' || !value || /[\s\x00-\x1f\\?#]/u.test(value)) throw 0;
    const url = new URL(value);
    const rawPath = value.replace(/^https:\/\/[^/]+/u, '');
    const authority = /^https:\/\/([^/]+)/u.exec(value)?.[1];
    if (!authority || authority.includes('@') || url.protocol !== 'https:' || !url.hostname
      || url.username || url.password || url.port === '0' || rawPath.includes('%')
      || rawPath.includes('//') || rawPath.split('/').some(p => p === '.' || p === '..')) throw 0;
    url.hostname = url.hostname.replace(/\.$/u, '');
    return url.origin + url.pathname.replace(/\/+$/u, '');
  } catch { throw new ReadError('INVALID_BASE'); }
}

export function stateDirectory(platform = process.platform, env: Environment = process.env,
  home = homedir()) {
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) throw new ReadError('AUTH_CONFIG_INVALID');
    return win32.join(env.LOCALAPPDATA, 'ConfluenceMCP', '.local');
  }
  return posix.join(home, '.confluence-mcp', '.local');
}

export function settings(file: string, keys: readonly string[], errorCode = 'AUTH_CONFIG_INVALID'): Record<string, unknown> {
  try {
    let stat;
    try { stat = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw 0;
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !keys.includes(key))) throw 0;
    return data as Record<string, unknown>;
  } catch { throw new ReadError(errorCode); }
}

export type Policy = { enabled_tools?: string[]; write_spaces?: string[] };
export function policy(directory: string): Policy {
  const data = settings(join(directory, 'policy.json'), ['enabled_tools', 'write_spaces'], 'POLICY_INVALID');
  for (const key of ['enabled_tools', 'write_spaces']) {
    const value = data[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim() || /[\x00-\x1f\x7f]|\p{Surrogate}/u.test(v))
      || new Set(value).size !== value.length) throw new ReadError('POLICY_INVALID');
    if (key === 'enabled_tools' && value.some(v => !contracts.tools.some(t => t.name === v))) throw new ReadError('POLICY_INVALID');
    if (key === 'write_spaces' && value.some(v => v.includes('*') || [...v].length > 255)) throw new ReadError('POLICY_INVALID');
  }
  return data as Policy;
}

export function configuration(env: Environment = process.env, directory = stateDirectory()) {
  const auth = settings(join(directory, 'auth.json'), ['mode', 'allow_write']);
  const site = settings(join(directory, 'settings.json'), ['base_url', 'extension_origin', 'transport']);
  if (auth.mode !== undefined && (typeof auth.mode !== 'string' || !['basic', 'browser'].includes(auth.mode)))
    throw new ReadError('AUTH_CONFIG_INVALID');
  if (auth.allow_write !== undefined && typeof auth.allow_write !== 'boolean')
    throw new ReadError('AUTH_CONFIG_INVALID');
  if ((env.CONFLUENCE_AUTH_MODE ?? auth.mode ?? 'basic') !== 'basic')
    throw new ReadError('AUTH_CONFIG_INVALID');
  const source = env.CONFLUENCE_CREDENTIAL_SOURCE ?? 'keyring';
  if (source !== 'keyring' && source !== 'env') throw new ReadError('AUTH_CONFIG_INVALID');
  if (env.CONFLUENCE_READ_ONLY !== undefined && !['true', 'false'].includes(env.CONFLUENCE_READ_ONLY))
    throw new ReadError('AUTH_CONFIG_INVALID');
  const timeout = Number(env.CONFLUENCE_TIMEOUT_SECONDS ?? '45');
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120) throw new ReadError('INVALID_REQUEST');
  return { base: normalizeBase(env.CONFLUENCE_BASE_URL ?? site.base_url), source,
    timeout, readOnly: env.CONFLUENCE_READ_ONLY === 'true' || auth.allow_write !== true, allow_write: auth.allow_write === true,
    policy: policy(directory), directory };
}
