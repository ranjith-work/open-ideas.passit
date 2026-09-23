// Small static file server shared by `npm start` and the browser tests.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/**
 * @param {string} root directory to serve
 * @param {{port?: number, host?: string}} [options] port 0 picks a free one
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export function startServer(root, { port = 0, host = '0.0.0.0' } = {}) {
  const base = resolve(root);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // `normalize` resolves `..` before the join, and the prefix check below
    // catches anything that still tries to climb out of the served directory.
    const file = join(base, normalize(path));
    if (!file.startsWith(base)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'permissions-policy': 'camera=(self)',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });

  return new Promise((fulfil, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      fulfil({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
