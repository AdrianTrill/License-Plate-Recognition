// Serves the built site for local use, as GitHub Pages would:
//
//   node web/serve.mjs build-wasm/site [port]
//
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// A server for a directory; resolves with its URL once listening.
export function serve(directory, port = 0) {
  const root = resolve(directory);
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((ready) => {
    server.listen(port, '127.0.0.1', () => ready({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [directory, port] = process.argv.slice(2);
  if (!directory) {
    console.error('usage: node web/serve.mjs SITE_DIR [port]');
    process.exit(2);
  }
  const { url } = await serve(directory, Number(port ?? 8080));
  console.log(`Serving ${resolve(directory)} at ${url}`);
}
