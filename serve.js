// Development server for dist/web.
//
// A handoff is only useful if the phone can actually load the receiver, so
// this binds to every interface and prints the LAN address — plus a QR of it,
// because typing an IP into a phone is exactly the friction PassIt exists to
// remove.

import { networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './tools/static-server.mjs';
import { terminalQr } from './tools/terminal-qr.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'dist', 'web');
const PORT = Number(process.env.PORT || 8787);

function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('dist/web is missing — run `npm run build` first.');
  process.exit(1);
}

let port;
try {
  ({ port } = await startServer(ROOT, { port: PORT }));
} catch (error) {
  const hint =
    error.code === 'EADDRINUSE'
      ? `port ${PORT} is already in use — try PORT=8788 npm run serve`
      : error.message;
  console.error(`Could not start the server: ${hint}`);
  process.exit(1);
}

const lan = lanAddress();
const lanUrl = lan ? `http://${lan}:${port}/` : null;

console.log('\nPassIt receiver is up.\n');
console.log(`  this machine   http://localhost:${port}/`);
if (lanUrl) {
  console.log(`  other devices  ${lanUrl}`);
  console.log('\n  Put that address in the extension settings (⚙), then scan:\n');
  console.log(terminalQr(lanUrl));
} else {
  console.log('\n  No LAN address found — other devices will not be able to reach this.');
}
console.log('');
