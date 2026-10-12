import { AsyncEntry } from '@napi-rs/keyring';
import { ACCOUNT } from './auth.js';

// Native credential access may wait for OS authorization; the parent bounds this read-only worker.
if (!process.send || !/^confluence-mcp:[0-9a-f]{64}$/u.test(process.argv[2] ?? '')
  || process.platform !== 'darwin') process.exit(1);
try {
  const record = await new AsyncEntry(process.argv[2], ACCOUNT).getPassword();
  process.send({ record }, () => process.exit(0));
} catch { process.send({ failed: true }, () => process.exit(1)); }
