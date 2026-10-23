# Changelog

The native packages built from this repository share one version: `react-native-range-source` on npm, `dev.mediacache:range-source` and `dev.mediacache:range-source-media3` on Maven Central, and the `range-source` Swift package (product `RangeSource`) and pod. `range-source-web` has its own changelog, [web/CHANGELOG.md](https://github.com/MediaCacheDev/range-source/blob/main/web/CHANGELOG.md), shipped in its package.

`react-native-range-source` is for Android and iOS. On react-native-web there's nothing to install: the players' web packages depend on `range-source-web`, and this package's JavaScript is an empty module there.

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
- **Web:** `range-source-web` 1.0.0, released at the same time ([web/CHANGELOG.md](https://github.com/MediaCacheDev/range-source/blob/main/web/CHANGELOG.md)).
- **Tests** for every platform from the repository's root: `npm test` (C++ and web), `npm run test:ios`, `npm run test:android` and `npm run test:all`.
