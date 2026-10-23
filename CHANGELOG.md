# Changelog

The packages built from this repository share one version: `range-source-web` and `react-native-range-source` on npm, `dev.mediacache:range-source` and `dev.mediacache:range-source-media3` on Maven Central, and the `range-source` Swift package (product `RangeSource`) and pod.

## Unreleased

`range-source-web` only; the native packages are unchanged.

- **A Service Worker for media elements.** `<video>` and `<audio>` make their own requests, so what they played skipped the reader and the store. The worker answers them: from the store first, fetching what's missing by range and storing it, so a file played through plays again with no requests, offline too.
  - The page registers it before rendering with `registerRangeSourceWorker('/range-source-sw.js')`, which resolves once the worker controls the page (claiming it again after a hard reload), and gives elements `serviceWorkerUrl(src, { namespace, key, storage, maxBytes, headers })`, a URL on the page's origin that the worker answers. `rangeSourceWorker()` tells whether one controls the page.
  - It sends the page's `headers` for the element, and plays a `Blob`, bytes or a `ByteSource` the page holds, whose ranges the page reads and passes on. A file on another origin without CORS is passed through, unstored.
  - The package ships the worker as `dist/range-source-sw.js` (export `range-source-web/range-source-sw.js`). An app with its own worker adds the handler from `range-source-web/sw` (`installRangeSourceWorker`, `handleRangeSourceFetch`) or `importScripts` the script.
- **Stores are shared between pages, tabs and the worker:** blocks written and keys deleted are announced on a `BroadcastChannel`, and a key open in any of them isn't evicted (Web Locks).
- `SourceInfo.contentType`, from the response's `Content-Type` or the `Blob`'s type.
- `httpSource`'s `openAt` option: the first request starts there rather than at 0.
- `ByteReader.stored()`: resolves once the blocks read so far are in the store.
- `npm run test:browsers` in `web/`: the worker in Chromium, Firefox and WebKit through Playwright.

## 1.0.0 - 2026-10-22

First public release. Range reading and storage for code that reads a file by offset, such as a demuxer or decoder: from a URL with HTTP range requests, a local file or an app's own data source, through a small buffer, keeping what was read between plays under one size cap. Before 1.0.0 it was `alpha-video-source`, copied into each alpha-video player; the players now depend on it instead.

- **Reading** (Android, iOS and React Native, one C++17 core):
  - Playing from the start is one request, kept open and read on. A read far from it, such as a seek, opens one more at its offset.
  - Reads 2 MB ahead of the last read, in 256 KB blocks, keeping 16 MB of them in memory. A dropped connection is reopened where it stopped, and a read fails after 3 retries.
  - `read` waits for its bytes, and returns them as they arrive. `tryRead` never waits, for render loops: it asks for the bytes and returns "pending", so a later call finds them. `fetchAll` reads the whole file, for playing it offline later.
- **Storage** on disk or in memory, one store per folder or name shared by every reader in the process:
  - One byte cap across every file in a store, evicting the least recently used; a file open in a reader isn't evicted.
  - A file stored whole plays without the network, offline too. A file stored in part fetches only what's missing.
  - A file whose version changes (`ETag`, else `Last-Modified`, and the length) drops its stored copy; a change while it's being read fails the read. A block that has gone missing from disk is fetched again.
- **Data sources:** an app that fetches, caches or decrypts the bytes itself implements `RangeDataSource` and registers it under a name with `RangeDataSources`. Players read through it by range, with the same read-ahead, retries and storage.
- **Android:** `dev.mediacache:range-source`, minSdk 24.
  - The Java API: `RangeSource.open`, and `RangeSourceReader` with `read`, `tryRead`, `inputStream`, direct `ByteBuffer`s, `fetchAll` and `stats`. `RangeSourceStore.disk` and `.memory`, with `holds`, `bytesUsed` and `remove`.
  - `RangeHttpDataSource`, the built-in fetcher over `HttpURLConnection`, with a public factory for timeouts and the user agent.
  - `librangesource.so` carries its own C++ runtime, so it doesn't clash with an app's or a player's. It is linked for 16 KB pages, and adds about 320 KB per architecture.
- **Android, Media3:** `dev.mediacache:range-source-media3`, opt-in. `Media3RangeDataSource.factory(dataSourceFactory)` reads through any Media3 `DataSource.Factory` (OkHttp, Cronet, a `CacheDataSource`). It compiles against `androidx.media3:media3-datasource` 1.8.0 and uses the app's own Media3.
- **iOS:** the Swift package's product `RangeSource` and the pod `range-source`, iOS 13 and later.
  - The Objective-C and Swift API: `RangeSource.open(url:store:)`, `RangeSourceReader` with `readData(at:length:)`, `tryRead` and `fetchAll`, and `RangeSourceStore.disk(path:maxBytes:)` and `.memory`.
  - `RangeDataSource` is the role of `AVAssetResourceLoaderDelegate` without the AVFoundation types: each call reads a window, reporting the file's size and version, then the bytes, then completion. URLs without a data source go through `URLSession`.
  - The pod defines a module, so Swift apps `import RangeSource` without `use_frameworks!`.
- **React Native:** `react-native-range-source` builds the Android library and the iOS sources into the app through autolinking. There's nothing to call; data sources are registered in native code.
- **With the alpha-video players** (alpha-video, alpha-video-gpu), range-source is an add-on they find at runtime and never link. One copy serves both.
  - Included by default on Android (a dependency of both players), in CocoaPods (their `Source` subspec) and in Swift packages (their default trait `Source`); React Native apps install `react-native-range-source` beside the player.
  - An app can leave it out. The players then download a URL whole for each play, and a data source reports `NO_SOURCE_MODULE`.
- **The C interface** `range_source.h`: a versioned table of functions (`RANGE_SOURCE_ABI` 1, with `structSize` for later additions), so code built separately, such as a player in another `.so` with its own C++ runtime, uses the same reader. `RANGE_SOURCE_CLIENT_NAMESPACE` adds a C++ wrapper over it. `range_source_download.h` is the basic input players use without the add-on: a header-only download into a temporary file, read as it arrives.
- **Web:** `range-source-web`, ES module and CommonJS builds with types, about 7 KB minified and gzipped.
  - Sources: `httpSource(url, { headers, init, fetch, reconnectGap })`, `blobSource` for a `Blob` or `File`, `memorySource`, and any object with `size` and `read(offset, length, signal)`.
  - `httpSource` keeps one response open for reads that follow on or skip ahead by up to 512 KB. A server that answers `200` is read progressively. A changed file fails with `SourceChangedError`, and a failed request throws `HttpSourceError` with its `status`.
  - `openReader(source, { store, key, … })`, with `read`, `peek` (for code that can't await, such as a WebAssembly demuxer), `prefetch` and `close`. It reads 1 MB ahead in 256 KB blocks, keeps 16 MB of them in memory, and aborts read-ahead for a seek.
  - Stores: `createStore('auto' | 'opfs' | 'indexeddb' | 'cache' | 'memory' | 'none', { namespace, maxBytes })`. `'auto'` is OPFS, else IndexedDB, else memory. One cap per namespace, 512 MB by default, evicting the least recently used keys except open ones. A store of your own implements `ByteStore`, or a `StoreBackend` for `BlockStore` to add the index and eviction.
- **Tests** for every platform from the repository's root: `npm test` (C++ and web), `npm run test:ios`, `npm run test:android` and `npm run test:all`.
