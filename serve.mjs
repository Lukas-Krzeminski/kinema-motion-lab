#!/usr/bin/env node
/**
 * Zero-dependency static server for KINEMA Motion Lab.
 *
 * Exists instead of `npx serve` for two reasons:
 *   1. .wasm must be served as application/wasm or streaming instantiation fails
 *   2. getUserMedia needs a secure context -- localhost qualifies, so binding
 *      to 127.0.0.1 keeps the camera working with no HTTPS setup
 *
 *   node serve.mjs [port]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2]) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.m4a':  'audio/mp4',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const server = createServer(async (req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  // Contain every request inside ROOT.
  const filePath = join(ROOT, normalize(urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw Object.assign(new Error('dir'), { code: 'ENOENT' });

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Content-Length': info.size };

    // Models and wasm are large and genuinely immutable, so cache them hard --
    // a reload during tuning stays instant.
    //
    // Everything else is source under active edit and must NEVER be cached.
    // 'no-cache' only means "revalidate first", and with no ETag or
    // Last-Modified there is nothing to revalidate against -- browsers hold
    // onto ES module graphs and silently keep serving the old app, which looks
    // exactly like the edits never happened. 'no-store' forbids storing at all.
    const immutable = /\.(wasm|task|tflite)$/.test(filePath);
    headers['Cache-Control'] = immutable
      ? 'public, max-age=604800, immutable'
      : 'no-store, no-cache, must-revalidate, max-age=0';
    if (!immutable) {
      headers.Pragma = 'no-cache';
      headers.Expires = '0';
      // A validator as well, so conditional requests have something to compare.
      headers['Last-Modified'] = info.mtime.toUTCString();
    }

    // Range support so <audio> can seek in track.mp3.
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
      const start = Number(startRaw) || 0;
      const end = endRaw ? Number(endRaw) : info.size - 1;
      if (start >= info.size || end >= info.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    headers['Accept-Ranges'] = 'bytes';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  KINEMA Motion Lab

    http://localhost:${PORT}

  Camera requires a secure context; localhost counts, so this works as-is.
  Ctrl+C to stop.
`);
});
