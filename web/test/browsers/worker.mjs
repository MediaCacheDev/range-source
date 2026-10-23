// Plays a clip in <video> through the range-source Service Worker in Chromium, Firefox and WebKit,
// and checks what reached the server and what the store holds: a first play stores the file, a
// replay makes no requests, even offline; seeks, a page reader and the worker on one key, headers,
// a source the page holds, servers without ranges or CORS, eviction across contexts, a hard
// reload, and a cross-origin isolated page.
//
//   npm run build && npm run test:browsers [-- chromium firefox webkit]
//
// Makes the clips with ffmpeg on first run, in test/browsers/build.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const WEB = fileURLToPath(new URL('../..', import.meta.url));
const BUILD = join(WEB, 'test/browsers/build');
const BLOCK = 256 * 1024;
const TYPES = {
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

/** A 10 s clip with noise, so it doesn't compress to nothing: VP9 WebM, and H.264 MP4 for browsers without VP9. */
function makeClip(name, codec) {
  const file = join(BUILD, name);
  if (existsSync(file)) return file;
  mkdirSync(BUILD, { recursive: true });
  const video = codec === 'vp9'
    ? ['-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=30:d=10,noise=alls=12:allf=t',
    '-g', '30', ...video, file,
  ]);
  return file;
}
const CLIPS = { webm: makeClip('clip.webm', 'vp9'), mp4: makeClip('clip.mp4', 'h264') };

/**
 * A server for one origin. Paths: the page and dist (main origin only), /range-source-sw.js,
 * /media/<clip> with ranges, /plain/<clip> without, /auth/<clip> needing `x-token: secret`.
 * Requests for clips are logged with their `t` query parameter, which tags each case.
 */
function serve({ cors, main }) {
  const log = [];
  const state = { offline: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    const headers = { 'Cache-Control': 'no-store' };
    if (cors) {
      Object.assign(headers, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Last-Modified',
      });
    }
    if (url.searchParams.has('isolated')) {
      Object.assign(headers, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    }
    if (req.method === 'OPTIONS') return res.writeHead(204, headers).end();

    const clip = /^\/(media|plain|auth)\/clip\.(webm|mp4)$/.exec(path);
    let file;
    if (clip) file = CLIPS[clip[2]];
    else if (main && path === '/range-source-sw.js') file = join(WEB, 'dist/range-source-sw.js');
    else if (main && path === '/') file = join(WEB, 'test/browsers/page.html');
    else if (main && (path.startsWith('/dist/') || path.startsWith('/test/browsers/'))) file = join(WEB, normalize(path));
    if (!file || !existsSync(file)) return res.writeHead(404, headers).end();

    if (clip) {
      log.push({ t: url.searchParams.get('t'), kind: clip[1], range: req.headers.range ?? null, token: req.headers['x-token'] ?? null });
      if (state.offline) return res.writeHead(503, headers).end();
      if (clip[1] === 'auth' && req.headers['x-token'] !== 'secret') return res.writeHead(401, headers).end();
    }
    const size = statSync(file).size;
    headers['Content-Type'] = TYPES[extname(file)] ?? 'application/octet-stream';
    if (clip) {
      headers.ETag = `"${size.toString(16)}"`;
      headers['Last-Modified'] = new Date(Date.UTC(2026, 0, 1)).toUTCString();
    }
    const ranged = clip && clip[1] !== 'plain' && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (ranged) {
      headers['Accept-Ranges'] = 'bytes';
      const start = ranged[1] === '' ? Math.max(0, size - Number(ranged[2])) : Number(ranged[1]);
      const end = ranged[1] === '' || ranged[2] === '' ? size - 1 : Math.min(Number(ranged[2]), size - 1);
      if (start >= size) return res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return pipe(createReadStream(file, { start, end, highWaterMark: 64 * 1024 }), res, url.searchParams.has('slow'));
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    pipe(createReadStream(file, { highWaterMark: 64 * 1024 }), res, url.searchParams.has('slow'));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://${main ? 'localhost' : '127.0.0.1'}:${server.address().port}`;
      resolve({ server, log, state, origin, requests: (t) => log.filter((r) => r.t === t) });
    }),
  );
}

/** Sends the file, at about 1.5 MB/s when slow, so a browser can't have read all of it by the time it seeks. */
function pipe(stream, res, slow) {
  res.on('close', () => stream.destroy());
  if (!slow) return stream.pipe(res);
  stream.on('data', (chunk) => {
    stream.pause();
    res.write(chunk);
    setTimeout(() => stream.resume(), 40);
  });
  stream.on('end', () => res.end());
}

const startOf = (r) => (r.range ? Number(/bytes=(\d*)/.exec(r.range)[1] || 0) : 0);

const main = await serve({ cors: false, main: true });
const corsOrigin = await serve({ cors: true, main: false });
const opaqueOrigin = await serve({ cors: false, main: false });

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
let failures = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
  if (wanted.length && !wanted.includes(name)) continue;
  const browser = await type.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${name}] ${m.type()}: ${m.text()}`);
  });
  await page.goto(`${main.origin}/`);
  await page.waitForFunction(() => window.ready);
  const vp9 = await page.evaluate(() => document.createElement('video').canPlayType('video/webm; codecs="vp09.00.10.08"') !== '');
  const ext = vp9 ? 'webm' : 'mp4';
  const size = statSync(CLIPS[ext]).size;
  const blocks = Math.ceil(size / BLOCK);
  console.log(`\n${name} ${browser.version()}: clip.${ext}, ${size} bytes`);

  const reg = await page.evaluate(() => window.register());
  report(reg.controlled && reg.worker, 'the worker controls the page once registered', `${reg.ms} ms`);
  if (!reg.controlled) {
    await browser.close();
    continue;
  }

  const url = (kind, t, origin = main.origin) => `${origin}/${kind}/clip.${ext}?t=${name}-${t}`;
  const play = (options) => page.evaluate((o) => window.play(o), options);
  const lookup = (key, namespace = 'test') => page.evaluate(([n, k]) => window.lookup(n, k), [namespace, key]);

  // First play: streamed by range through the worker, and stored whole
  {
    const src = url('media', 'first');
    const r = await play({ src, toEnd: true });
    await sleep(500);
    const held = await lookup(src);
    const requests = main.requests(`${name}-first`);
    report(
      r.ok && r.ended && held?.blocks === blocks,
      'first play streams by range and stores the file',
      r.error ?? `${requests.length} requests from ${requests.map(startOf).join(', ')}; ${held?.blocks}/${blocks} blocks in ${held?.kind}, ${held?.contentType}`,
    );

    // Replay: no requests at all
    const again = await play({ src, toEnd: true });
    const more = main.requests(`${name}-first`).length - requests.length;
    report(again.ok && again.ended && more === 0, 'replay comes from the store', again.error ?? `${more} requests`);

    // Offline: the server answers 503 to everything, and it still plays
    main.state.offline = true;
    const offline = await play({ src, seek: 0.5, toEnd: true });
    main.state.offline = false;
    const offlineRequests = main.requests(`${name}-first`).length - requests.length - more;
    report(offline.ok && offline.ended, 'plays offline from the store', offline.error ?? `${offlineRequests} requests`);
  }

  // A seek past what was read ahead fetches from there
  {
    const r = await play({ src: `${url('media', 'seek')}&slow=1`, seek: 0.9 });
    const starts = main.requests(`${name}-seek`).map(startOf);
    // WebKit reads a WebM from the start without Range, with or without the worker, so a seek waits for the bytes
    const far = name === 'webkit' || starts.some((s) => s >= size / 2);
    report(r.ok && far, 'a far seek fetches from near the end', r.error ?? `requests from ${starts.join(', ')}`);
  }

  // The page reads the head, then <video> plays it: block 0 comes from the store
  {
    const src = url('media', 'shared');
    await page.evaluate(([u]) => window.readHead('test', u), [src]);
    const r = await play({ src, toEnd: true });
    const starts = main.requests(`${name}-shared`).map(startOf);
    const fromZero = starts.filter((s) => s === 0).length;
    report(r.ok && fromZero === 1, "the worker reads the page's stored block", r.error ?? `requests from ${starts.join(', ')}`);
  }

  // Headers: the worker asks the page for them
  {
    const src = url('auth', 'auth');
    const r = await play({ src, headers: { 'x-token': 'secret' }, toEnd: true });
    const tokens = main.requests(`${name}-auth`).map((q) => q.token);
    report(r.ok && tokens.length > 0 && tokens.every((t) => t === 'secret'), 'sends the headers the page gave', r.error ?? `${tokens.length} requests`);
  }

  // A source the page holds: bytes in memory, served to <video> by the worker
  {
    const r = await play({ bytesFrom: url('media', 'bytes-fetch'), type: `video/${ext}`, toEnd: true });
    report(r.ok && r.ended, 'plays bytes the page holds', r.error ?? r.url);
  }

  // A URL with a store the page holds: the page reads it, and the worker passes the bytes on
  {
    const src = url('media', 'page-store');
    const r = await play({ src, pageStore: 'memory', toEnd: true });
    const held = await page.evaluate(([u]) => window.lookup('test', u, 'memory'), [src]);
    report(r.ok && r.ended && held?.blocks === blocks, "plays a URL through the page's store", r.error ?? `${main.requests(`${name}-page-store`).length} requests, ${held?.blocks}/${blocks} blocks`);
  }

  // A server without ranges
  {
    const src = url('plain', 'plain');
    const r = await play({ src, seek: 0.5, toEnd: true });
    await sleep(500);
    const held = await lookup(src);
    report(r.ok && r.ended && held?.blocks > 0, 'a server without ranges', r.error ?? `${main.requests(`${name}-plain`).length} requests, ${held?.blocks}/${blocks} blocks`);
  }

  // Another origin with CORS: stored; without: passed through, unstored
  {
    const src = url('media', 'cors', corsOrigin.origin);
    const r = await play({ src, toEnd: true });
    await sleep(500);
    const held = await lookup(src);
    report(r.ok && held?.blocks === blocks, 'another origin with CORS is stored', r.error ?? `${held?.blocks}/${blocks} blocks`);

    const opaque = url('media', 'opaque', opaqueOrigin.origin);
    const o = await play({ src: opaque, toEnd: true });
    await sleep(300);
    const none = await lookup(opaque);
    report(o.ok && o.ended && !none, 'another origin without CORS plays, unstored', o.error ?? `${opaqueOrigin.requests(`${name}-opaque`).length} requests`);
  }

  // Eviction skips a key another page has open, and takes it once it's closed
  {
    const cap = Math.floor(size * 1.5);
    const a = url('media', 'evict-a');
    await play({ src: a, namespace: 'evict', maxBytes: cap, toEnd: true });
    await sleep(500);
    const other = await context.newPage();
    await other.goto(`${main.origin}/`);
    await other.waitForFunction(() => window.ready);
    await other.evaluate(([u]) => window.hold('evict', u), [a]);
    await play({ src: url('media', 'evict-b'), namespace: 'evict', maxBytes: cap, toEnd: true });
    await sleep(500);
    const kept = await lookup(a, 'evict');
    await other.evaluate(() => window.release());
    await sleep(100);
    await play({ src: url('media', 'evict-c'), namespace: 'evict', maxBytes: cap, toEnd: true });
    await sleep(500);
    const gone = await lookup(a, 'evict');
    report(kept?.blocks === blocks && !gone, 'eviction skips a key open in another page', `while open: ${kept?.blocks}/${blocks} blocks, after: ${gone ? `${gone.blocks} blocks` : 'evicted'}`);
    await other.close();
  }

  // The browser stops the worker mid-stream, as it may on a long video: <video> asks again and plays on
  if (name === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    const playing = play({ src: `${url('media', 'stopped')}&slow=1`, toEnd: true });
    await sleep(1000);
    await cdp.send('ServiceWorker.stopAllWorkers');
    const r = await playing;
    const starts = main.requests(`${name}-stopped`).map(startOf);
    report(r.ok && r.ended, 'plays on when the browser stops the worker', r.error ?? `requests from ${starts.join(', ')}`);
    await cdp.detach();
  }

  // A hard reload leaves the page uncontrolled; registering again claims it
  if (name === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.reload', { ignoreCache: true });
    await page.waitForFunction(() => window.ready);
    const before = await page.evaluate(() => window.controlled());
    const after = await page.evaluate(() => window.register());
    report(!before && after.controlled && after.ms < 1500, 'a hard reload is claimed again', `controlled before: ${before}, after ${after.ms} ms`);
  }

  // Cross-origin isolated (COOP and COEP): the worker's answers for another origin are accepted
  {
    await page.goto(`${main.origin}/?isolated=1`);
    await page.waitForFunction(() => window.ready);
    const isolated = await page.evaluate(() => crossOriginIsolated);
    await page.evaluate(() => window.register());
    const r = await play({ src: url('media', 'isolated', corsOrigin.origin), toEnd: true });
    report(isolated && r.ok && r.ended, 'plays another origin under COEP require-corp', r.error ?? `isolated: ${isolated}`);
  }

  await browser.close();

  // Firefox stops a worker with a request open after idle_extended_timeout (5 minutes by default)
  if (name === 'firefox') {
    const short = await firefox.launch({ firefoxUserPrefs: { 'dom.serviceWorkers.idle_timeout': 500, 'dom.serviceWorkers.idle_extended_timeout': 1000 } });
    const p = await short.newPage();
    await p.goto(`${main.origin}/`);
    await p.waitForFunction(() => window.ready);
    await p.evaluate(() => window.register());
    const r = await p.evaluate((o) => window.play(o), { src: `${url('media', 'stopped')}&slow=1`, toEnd: true });
    const starts = main.requests(`${name}-stopped`).map(startOf);
    report(r.ok && r.ended && starts.length > 1, 'plays on when the browser stops the worker', r.error ?? `requests from ${starts.join(', ')}`);
    await short.close();
  }
}

for (const s of [main, corsOrigin, opaqueOrigin]) s.server.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
