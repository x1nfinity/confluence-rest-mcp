#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { realpathSync } from 'node:fs';
import { configuration } from './config.js';
import { credentials, login, logout } from './auth.js';
import { RestClient } from './rest.js';
import { Confluence } from './confluence.js';
import { failure, ReadError } from './errors.js';
import { serve, VERSION } from './server.js';

export function hiddenInput(prompt: string, input = process.stdin, output = process.stderr): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new ReadError('TTY_REQUIRED');
  return new Promise((resolve, reject) => {
    const raw = input.isRaw;
    const decoder = new StringDecoder('utf8');
    let value = '';
    const cleanup = () => { input.removeListener('data', receive); input.removeListener('end', cancel);
      input.setRawMode(raw); input.pause(); output.write('\n'); };
    const cancel = () => { cleanup(); reject(new ReadError('TTY_REQUIRED')); };
    const receive = (buffer: Buffer) => {
      for (const ch of decoder.write(buffer)) {
        if (ch === '\x03' || ch === '\x04') { cancel(); return; }
        if (ch === '\r' || ch === '\n') { cleanup(); resolve(value); return; }
        if (ch === '\x7f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch >= ' ' && ch !== '\x7f') value += ch;
      }
    };
    output.write(prompt); input.setRawMode(true);
    input.on('data', receive); input.once('end', cancel); input.resume();
  });
}

export async function main(argv = process.argv.slice(2)) {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    'base-url': { type: 'string' }, page: { type: 'string' }, json: { type: 'boolean' },
    check: { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } }); } catch { throw new ReadError('INVALID_ARGUMENT'); }
  const { values, positionals } = args;
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1 || !['serve', 'login', 'whoami', 'logout', 'doctor', 'version'].includes(command)) throw new ReadError('INVALID_ARGUMENT');
  if (values.help) {
    process.stdout.write('Confluence MCP: serve (default), login, whoami, logout, doctor, version\n'
      + '--base-url HTTPS_URL; doctor: --page ID_OR_URL --json --check\n'
      + 'Credentials are entered by the user in a hidden interactive terminal, never as command arguments.\n'); return;
  }
  if (values.version || command === 'version') { process.stdout.write(VERSION + '\n'); return; }
  if (command !== 'doctor' && (values.page || values.json || values.check)) throw new ReadError('INVALID_ARGUMENT');
  const env = { ...process.env, ...(values['base-url'] ? { CONFLUENCE_BASE_URL: String(values['base-url']) } : {}) };
  const config = configuration(env);
  const rest = new RestClient(config.base, config.timeout, signal => credentials(config.base, config.source, env, undefined, signal));
  const api = new Confluence(rest, config);
  if (command === 'serve') { await serve(api); return; }
  let result: unknown;
  if (command === 'login') {
    if (config.source !== 'keyring') throw new ReadError('AUTH_CONFIG_INVALID');
    const input = { username: await hiddenInput('Confluence username (hidden): '), password: await hiddenInput('Confluence password (hidden): ') };
    result = await login(config.base, input, async c => { await rest.verify(c); });
  } else if (command === 'whoami') result = await rest.verify();
  else if (command === 'logout') result = await logout(config.base, config.source);
  else {
    const checks: Record<string, unknown> = { version: VERSION, stage: 'M2-M3', configuration: 'passed',
      credential_source: config.source,
      read_only: config.readOnly || !config.allow_write || !config.policy.write_spaces?.length,
      enabled_tools: api.tools.map(t => t.name), write_scope_configured: !!config.policy.write_spaces?.length,
      authentication: 'pending',
      page_read: 'pending', host_reload: 'pending', windows_acceptance: 'pending' };
    if (!values.check) {
      try {
        await rest.verify(); checks.authentication = 'passed';
        if (values.page) { await api.call('get_page', { pageId: values.page }); checks.page_read = 'passed'; }
      } catch (error) { checks.error = (error instanceof ReadError ? error : new ReadError()).details(); process.exitCode = 1; }
    }
    result = checks;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(JSON.stringify(failure(error)) + '\n'); process.exitCode = 1; });
}
