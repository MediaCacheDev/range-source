// A static file server for tests, with switchable HTTP range support.
//
//   node test/range-server.mjs <dir> [--port 8080] [--no-range] [--chunked] [--cors]
//
// Or from tests: startRangeServer({ files: { '/a.bin': buffer }, range: true }).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.ktx2': 'image/ktx2',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

/**
 * options:
 *   files: { [path]: Buffer }  served from memory, or
 *   root: directory            served from disk
 *   range: answer Range with 206 (default true)
 *   chunked: omit Content-Length on 200 responses
 *   cors: send CORS headers, exposing Content-Range and ETag (default true)
 *   requireHeader: [name, value] a request must carry, else 401
 *   etag: (path) => string, default from the content length and a version counter
 *   chunkSize, chunkDelayMs: write the body in chunks, pausing between them
 * Returns { url, port, requests, setFile(path, buffer), close() }.
 */
export async function startRangeServer(options = {}) {
  const files = new Map(Object.entries(options.files ?? {}));
  const versions = new Map();
  const requests = [];
  const settings = { range: true, cors: true, chunked: false, chunkSize: 64 * 1024, chunkDelayMs: 0, ...options };

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push({ path, method: req.method, range: req.headers.range ?? null, headers: req.headers });
    if (settings.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag, Last-Modified');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (settings.requireHeader) {
      const [name, value] = settings.requireHeader;
      if (req.headers[name.toLowerCase()] !== value) return res.writeHead(401).end();
    }

    const body = await load(path);
    if (!body) return res.writeHead(404).end();
    const version = versions.get(path) ?? 0;
    const etag = settings.etag ? settings.etag(path, version) : `"${body.length.toString(16)}-${version}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(Date.UTC(2026, 0, 1 + version)).toUTCString());
    res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');

    const match = settings.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (match) {
      res.setHeader('Accept-Ranges', 'bytes');
      const start = match[1] === '' ? Math.max(0, body.length - Number(match[2])) : Number(match[1]);
      const end = match[1] === '' || match[2] === '' ? body.length - 1 : Math.min(Number(match[2]), body.length - 1);
      if (start >= body.length || start > end) {
        res.setHeader('Content-Range', `bytes */${body.length}`);
        return res.writeHead(416).end();
      }
      res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
      res.setHeader('Content-Length', end - start + 1);
      res.writeHead(206);
      return send(res, body.subarray(start, end + 1));
    }
    if (!settings.chunked) res.setHeader('Content-Length', body.length);
    res.writeHead(200);
    return send(res, body);
  });

  async function load(path) {
    if (files.has(path)) return files.get(path);
    if (!settings.root) return null;
    const file = normalize(join(settings.root, path === '/' ? '/index.html' : path));
    if (!file.startsWith(normalize(settings.root))) return null;
    try {
      if (!(await stat(file)).isFile()) return null;
      return await readFile(file);
    } catch {
      return null;
    }
  }

  async function send(res, data) {
    let closed = false;
    let wake = null;
    res.on('close', () => {
      closed = true;
      wake?.();
    });
    res.on('drain', () => wake?.());
    for (let at = 0; at < data.length && !closed; at += settings.chunkSize) {
      const chunk = data.subarray(at, at + settings.chunkSize);
      if (!res.write(chunk)) await new Promise((resolve) => (wake = resolve));
      wake = null;
      if (settings.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, settings.chunkDelayMs));
    }
    res.end();
  }

  await new Promise((resolve) => server.listen(settings.port ?? 0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    settings,
    setFile(path, buffer) {
      files.set(path, buffer);
      versions.set(path, (versions.get(path) ?? 0) + 1);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const root = args.find((arg, i) => !arg.startsWith('--') && !(i > 0 && args[i - 1] === '--port')) ?? '.';
  const server = await startRangeServer({
    root,
    port: Number(value('--port', 8080)),
    range: !flag('--no-range'),
    chunked: flag('--chunked'),
    cors: true,
  });
  console.log(`serving ${root} at ${server.url} (range ${server.settings.range ? 'on' : 'off'})`);
}
