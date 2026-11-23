import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directory, privateDirectory } from './socket.mjs';

const id = process.argv[2];
const firefox = id === '--firefox';
if (process.platform !== 'darwin' || process.argv.length !== 3 || (!firefox && !/^[a-p]{32}$/.test(id))) {
  console.error('Usage on macOS: node install.mjs CHROME_EXTENSION_ID | node install.mjs --firefox');
  process.exit(1);
}
const launcher = join(directory, 'host');
const nativeDir = join(homedir(), 'Library/Application Support', firefox ? 'Mozilla' : 'Google/Chrome', 'NativeMessagingHosts');
const manifest = join(nativeDir, 'local.pi_chrome.json');
const shellQuote = (path) => "'" + path.replaceAll("'", "'\\''") + "'";
const entry = fileURLToPath(new URL('./native.mjs', import.meta.url));

privateDirectory(true);
mkdirSync(nativeDir, { mode: 0o700, recursive: true });
writeFileSync(launcher, '#!/bin/sh\nexec ' + shellQuote(realpathSync(process.execPath)) + ' ' + shellQuote(entry) + '\n', { mode: 0o700 });
chmodSync(launcher, 0o700);
writeFileSync(manifest, JSON.stringify({
  name: 'local.pi_chrome',
  description: 'VACU local bridge',
  path: launcher,
  type: 'stdio',
  ...(firefox ? { allowed_extensions: ['vacu@local.invalid'] } : { allowed_origins: ['chrome-extension://' + id + '/'] }),
}, null, 2) + '\n', { mode: 0o600 });
console.log('Registered ' + manifest);
