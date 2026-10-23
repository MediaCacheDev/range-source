# Changelog

`range-source-web` on npm. The native packages built from the same repository (`react-native-range-source`, `dev.mediacache:range-source`, the `range-source` Swift package and pod) have their own changelog, [CHANGELOG.md](https://github.com/MediaCacheDev/range-source/blob/main/CHANGELOG.md) in the repository's root.

## 1.1.0 - 2026-10-23

- **A Service Worker for media elements.** `<video>` and `<audio>` make their own requests, so what they played skipped the reader and the store. The worker answers them: from the store first, fetching what's missing by range and storing it, so a file played through plays again with no requests, offline too.
  - The page registers it before rendering with `registerRangeSourceWorker('/range-source-sw.js')`, which resolves once the worker controls the page (claiming it again after a hard reload), and gives elements `serviceWorkerUrl(src, { namespace, key, storage, maxBytes, headers })`, a URL on the page's origin that the worker answers. `rangeSourceWorker()` tells whether one controls the page.
  - It sends the page's `headers` for the element, and plays a `Blob`, bytes or a `ByteSource` the page holds, whose ranges the page reads and passes on. A file on another origin without CORS is passed through, unstored.
  - The package ships the worker as `dist/range-source-sw.js` (export `range-source-web/range-source-sw.js`). An app with its own worker adds the handler from `range-source-web/sw` (`installRangeSourceWorker`, `handleRangeSourceFetch`) or `importScripts` the script.
- **Stores are shared between pages, tabs and the worker:** blocks written and keys deleted are announced on a `BroadcastChannel`, and a key open in any of them isn't evicted (Web Locks).
- `SourceInfo.contentType`, from the response's `Content-Type` or the `Blob`'s type.
- `httpSource`'s `openAt` option: the first request starts there rather than at 0.
- `ByteReader.stored()`: resolves once the blocks read so far are in the store.
- `npm run test:browsers`: the worker in Chromium, Firefox and WebKit through Playwright.
- The package includes this changelog.

## 1.0.0 - 2026-10-22

First public release: range reading and storage on the web, for code that reads a file by offset, such as a demuxer. Before 1.0.0 it was part of `alpha-video-source`, copied into each alpha-video player; `alpha-video-web` and `alpha-video-gpu-web` now depend on it instead. ES module and CommonJS builds with types, about 7 KB minified and gzipped.

- **Sources:** `httpSource(url, { headers, init, fetch, reconnectGap })`, `blobSource` for a `Blob` or `File`, `memorySource`, and any object with `size` and `read(offset, length, signal)`.
  - `httpSource` keeps one response open for reads that follow on or skip ahead by up to 512 KB. A server that answers `200` is read progressively. A changed file fails with `SourceChangedError`, and a failed request throws `HttpSourceError` with its `status`.
- **Reading:** `openReader(source, { store, key, … })`, with `read`, `peek` (for code that can't await, such as a WebAssembly demuxer), `prefetch` and `close`. It reads 1 MB ahead in 256 KB blocks, keeps 16 MB of them in memory, and aborts read-ahead for a seek.
- **Stores:** `createStore('auto' | 'opfs' | 'indexeddb' | 'cache' | 'memory' | 'none', { namespace, maxBytes })`. `'auto'` is OPFS, else IndexedDB, else memory. One cap per namespace, 512 MB by default, evicting the least recently used keys except open ones. A store of your own implements `ByteStore`, or a `StoreBackend` for `BlockStore` to add the index and eviction.
