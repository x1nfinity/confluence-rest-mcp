import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeBase, type Environment } from './config.js';
import { ReadError } from './errors.js';
import { ACCOUNT, windowsStore } from './windows-credentials.js';

export type Credentials = { username: string; password: string };
export type CredentialStore = {
  getPassword(signal?: AbortSignal): string | null | Promise<string | null>;
  setPassword(record: string): void | Promise<void>;
  deletePassword(): boolean | Promise<boolean>;
};
export { ACCOUNT };
export function service(base: string) {
  return 'confluence-mcp:' + createHash('sha256').update(normalizeBase(base)).digest('hex');
}
export function validCredentials(value: unknown): Credentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReadError('CREDENTIAL_INVALID');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'password,username'
    || [record.username, record.password].some(v => typeof v !== 'string' || !v || /[\x00-\x1f\x7f]/u.test(v)
      || /\p{Surrogate}/u.test(v)) || String(record.username).includes(':'))
    throw new ReadError('CREDENTIAL_INVALID');
  return record as Credentials;
}
export async function systemStore(base: string, platform = process.platform): Promise<CredentialStore> {
  if (platform !== 'darwin' && platform !== 'win32') throw new ReadError('CREDENTIAL_BACKEND_UNAVAILABLE');
  if (platform === 'win32') return windowsStore(service(base));
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = () => new AsyncEntry(service(base), ACCOUNT);
    return { getPassword: signal => readSystemRecord(service(base), signal),
      setPassword: record => entry().setPassword(record), deletePassword: () => entry().deletePassword() };
  } catch { throw new ReadError('CREDENTIAL_BACKEND_UNAVAILABLE'); }
}
export function readSystemRecord(serviceName: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./keyring-read.js', import.meta.url)), [serviceName],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
        timeout: 45000, killSignal: 'SIGKILL', signal, execArgv: [] });
    let finished = false;
    const fail = () => { if (!finished) { finished = true; reject(new ReadError('CREDENTIAL_FAILED')); } };
    child.once('error', fail); child.once('exit', fail);
    child.once('message', message => {
      const value = message as { record?: unknown };
      if (value && (value.record === null || (typeof value.record === 'string' && Buffer.byteLength(value.record) <= 65536))) {
        finished = true; resolve(value.record); child.kill('SIGKILL');
      } else { fail(); child.kill('SIGKILL'); }
    });
  });
}
export async function credentials(base: string, source: string, env: Environment = process.env,
  storeFactory = systemStore, signal?: AbortSignal): Promise<Credentials> {
  if (source === 'env') return validCredentials({ username: env.CONFLUENCE_USERNAME, password: env.CONFLUENCE_PASSWORD });
  if (source !== 'keyring') throw new ReadError('AUTH_CONFIG_INVALID');
  try {
    const raw = await (await storeFactory(base)).getPassword(signal);
    if (raw === null) throw new ReadError('LOGIN_REQUIRED');
    return validCredentials(JSON.parse(raw));
  } catch (error) { if (error instanceof ReadError) throw error; throw new ReadError('CREDENTIAL_FAILED'); }
}
export async function login(base: string, input: Credentials,
  verify: (credentials: Credentials) => Promise<void>, storeFactory = systemStore) {
  base = normalizeBase(base);
  input = validCredentials(input);
  const store = await storeFactory(base);
  await verify(input);
  try { await store.setPassword(JSON.stringify(input)); }
  catch { throw new ReadError('CREDENTIAL_FAILED'); }
  return { authenticated: true, credentials_saved: true };
}
export async function logout(base: string, source: string, storeFactory = systemStore) {
  if (source === 'env') return { credentials_saved: false, action: 'remove_environment_credentials' };
  if (source !== 'keyring') throw new ReadError('AUTH_CONFIG_INVALID');
  try { await (await storeFactory(base)).deletePassword(); }
  catch (error) { if (error instanceof ReadError) throw error; throw new ReadError('CREDENTIAL_FAILED'); }
  return { credentials_saved: false };
}
