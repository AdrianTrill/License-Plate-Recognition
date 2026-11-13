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
    const { size } = statSync(file);
    const headers = {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    };
    // Safari plays a video only from a server that can send it in ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end) {
        response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    response.writeHead(headers['content-range'] ? 206 : 200, { ...headers, 'content-length': end - start + 1 });
    if (request.method === 'HEAD' || size === 0) {
      response.end();
      return;
    }
    createReadStream(file, { start, end }).pipe(response);
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
