// The page side of worker.mjs: registers the worker, plays URLs through it in <video>, and
// looks in the store.
import { createStore, httpSource, openReader, rangeSourceWorker, registerRangeSourceWorker, serviceWorkerUrl } from '/dist/index.mjs';

const once = (target, type) => new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
const timeout = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms));

window.register = async () => {
  const start = performance.now();
  await registerRangeSourceWorker('/range-source-sw.js', { scope: '/' });
  return { controlled: !!navigator.serviceWorker.controller, worker: await rangeSourceWorker(), ms: Math.round(performance.now() - start) };
};

window.controlled = () => !!navigator.serviceWorker.controller;

/** Plays src in a <video> through the worker: loads it, optionally seeks, optionally plays to the end. */
window.play = async ({ src, bytesFrom, type, namespace = 'test', storage, pageStore, key, headers, maxBytes, seek, toEnd }) => {
  let source = src;
  if (bytesFrom) source = new Uint8Array(await (await fetch(bytesFrom)).arrayBuffer());
  if (pageStore) storage = createStore(pageStore, { namespace });
  const handle = await serviceWorkerUrl(source, { namespace, storage, key, headers, maxBytes, contentType: bytesFrom ? type : undefined });
  if (!handle) return { error: 'no range-source worker controls the page' };
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  document.body.append(video);
  try {
    const loaded = new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error(`video error ${video.error?.code}: ${video.error?.message ?? ''}`));
    });
    video.src = handle.url;
    await Promise.race([loaded, timeout(15000, 'loadeddata')]);
    if (seek !== undefined) {
      const seeked = once(video, 'seeked');
      video.currentTime = seek * video.duration;
      await Promise.race([seeked, timeout(15000, 'seeked')]);
    }
    if (toEnd) {
      video.playbackRate = 8;
      const ended = once(video, 'ended');
      await video.play();
      await Promise.race([ended, timeout(30000, 'ended')]);
    }
    return { ok: true, duration: video.duration, ended: video.ended, url: handle.url };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  } finally {
    video.onerror = null;
    video.removeAttribute('src');
    video.load();
    video.remove();
    handle.release();
  }
};

/** What the store holds under key. */
window.lookup = async (namespace, key, kind = 'auto') => {
  const store = createStore(kind, { namespace });
  const entry = await store.lookup(key);
  if (!entry) return null;
  return {
    kind: store.kind,
    blocks: entry.blocks.length,
    blockCount: Math.ceil(entry.info.size / entry.blockSize),
    contentType: entry.info.contentType ?? null,
  };
};

/** Reads the first 64 KB through a reader on the page, storing block 0. */
window.readHead = async (namespace, url) => {
  const store = createStore('auto', { namespace });
  const reader = await openReader(httpSource(url), { store, key: url, readAheadBytes: 0 });
  await reader.read(0, 64 * 1024);
  await reader.stored();
  reader.close();
};

/** Keeps key open in this page's store until release(), as a player reading it would. */
window.hold = async (namespace, url) => {
  const store = createStore('auto', { namespace });
  window.held = await openReader(httpSource(url), { store, key: url });
  await window.held.read(0, 1);
};
window.release = () => window.held?.close();

window.ready = true;
