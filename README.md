# range-source

Range reading and storage for players and other code that reads a file by offset: from a URL (with HTTP range requests), a local file or an app's own data source, through a small buffer, keeping what was read between plays under a size cap. The alpha-video players ([alpha-video](https://github.com/MediaCacheDev/alpha-video) and [alpha-video-gpu](https://github.com/MediaCacheDev/alpha-video-gpu)) read through it on every platform.

| | Package | Holds |
|---|---|---|
| Web | `range-source-web` (npm), in [`web/`](web) | sources for URLs, `Blob`s and memory, a block reader, stores in OPFS, IndexedDB, the Cache API or memory, and a Service Worker that serves `<video>` and `<audio>` from them |
| Android | `dev.mediacache:range-source` (Maven) | the reader and stores (`librangesource.so`), the Java API, and `RangeDataSource` for app data sources |
| Android, Media3 | `dev.mediacache:range-source-media3` (Maven), opt-in | `Media3RangeDataSource`, any Media3 `DataSource.Factory` as a `RangeDataSource` |
| iOS | Swift package `range-source`, product `RangeSource`; pod `range-source` | the reader and stores, the Objective-C and Swift API, and `RangeDataSource` |
| React Native | `react-native-range-source` (npm) | the Android library and the iOS sources, autolinked |

The Android and iOS packages share one C++17 core, [`native/`](native).

## With the alpha-video players

Natively, range-source is an add-on the players find at runtime. It gives them:
- range requests, with one request kept open while playing on, and one more for a far seek;
- read-ahead and retries;
- `storage` on disk or in memory, under `maxStorageBytes`, named by `cacheKey`, so a clip played through plays again offline;
- app data sources, registered by name.

**It's included by default,** except in React Native, which needs it in the install line:

| | Included | To leave it out |
|---|---|---|
| Android | a dependency of `dev.mediacache:alpha-video` and `dev.mediacache:alpha-video-gpu` | `exclude group: 'dev.mediacache', module: 'range-source'` on the player |
| iOS, CocoaPods | the players' `Source` subspec, in their default subspecs | name the subspecs, e.g. `pod 'alpha-video', :subspecs => ['VPX', 'AV1']` or `pod 'alpha-video-gpu', :subspecs => ['Core']` |
| iOS, Swift Package Manager | alpha-video's `AlphaVideoSource` product, added beside the codec products; alpha-video-gpu's `AlphaVideoGPU` product (players 1.0.1 or later; with 1.0.0, add this package's `RangeSource` product) | don't add `AlphaVideoSource`; take `AlphaVideoGPUCore` instead of `AlphaVideoGPU` |
| React Native | `npm i react-native-range-source` beside the player | leave it out of the install |
| Web | `range-source-web`, a dependency of `alpha-video-web` and `alpha-video-gpu-web` | not removable: it's 10 KB gzipped |

**Without it,** the players use a basic input. Local files, assets and `content://` play as before. A URL is downloaded whole into a temporary file, with one request from the start, and plays as it arrives. A seek past what has arrived waits for it, and nothing is kept between plays. `storage`, `maxStorageBytes` and `cacheKey` have no effect, and the player logs a warning once. A data source reports `onError` with the code `NO_SOURCE_MODULE`.

One copy serves both players, and there's nothing to call. On Android, the add-on is about 320 KB per architecture, its own C++ runtime included.

### Data sources

An app that fetches, caches or decrypts the bytes itself registers a data source under a name, and gives a player that name (`source={{ uri, dataSource: 'name' }}` in React Native, `setDataSource("name")` on Android, `dataSource = "name"` on iOS). The player then reads through it: by range as it plays, with the same read-ahead, retries and store. A data source registered once serves both players.

**Android:** implement `dev.mediacache.rangesource.RangeDataSource`. `open(uri, position, headers)` starts a read at `position` and returns the file's size and version (`new Info(size, etag, lastModified)`). `read` and `close` follow, and `cancel` (optional) stops a read blocked on the network from another thread. Register a factory, which makes a source per reader:

```kotlin
RangeDataSources.register("mine") { MyDataSource() }
```

To read through a Media3 `DataSource.Factory` (OkHttp, Cronet, a `CacheDataSource`), add the adapter. It compiles against `androidx.media3:media3-datasource` 1.8.0 and uses the app's own Media3:

```gradle
implementation 'dev.mediacache:range-source-media3:1.0.0'
```

```kotlin
RangeDataSources.register("media3", Media3RangeDataSource.factory(dataSourceFactory))
```

The built-in fetcher, `RangeHttpDataSource`, is public too, to register with other timeouts or a user agent: `RangeHttpDataSource.Factory().setConnectTimeoutMs(…).setReadTimeoutMs(…).setUserAgent(…)`.

**iOS:** conform to `RangeDataSource`, the role of `AVAssetResourceLoaderDelegate` without the AVFoundation types. Each call reads a window of a few megabytes: call `response` once with the file's size and version, then `data` with the bytes in order, then `completion`. One instance serves every reader, so a read mustn't depend on the one before:

```swift
import RangeSource

final class MyDataSource: NSObject, RangeDataSource {
    func read(url: URL, offset: Int64, length: Int64, headers: [String: String],
              response: @escaping (RangeDataInfo) -> Void,
              data: @escaping (Data) -> Void,
              completion: @escaping (Error?) -> Void) -> RangeCancellable {
        // response(RangeDataInfo(size: total, etag: etag, lastModified: nil)), data(…), completion(nil)
    }
}

RangeDataSources.register(MyDataSource(), name: "mine")
```

**React Native:** the registration is native code, as above: in `MainApplication` on Android, and in `AppDelegate` on iOS (`import RangeSource`). On react-native-web, names are registered with range-source-web ([web/README.md](web/README.md)).

**MediaCache** is a ready-made data source on Android, iOS, React Native and the web: `cache.registerRangeDataSource()` registers it as `mediacache`, and the players' files then stream through the cache, under its eviction, TTL and offline replay ([MediaCache's README](https://github.com/MediaCacheDev/media-cache#transparent-video-alpha-video-and-alpha-video-gpu)). It plugs in here, so an app using MediaCache with the players keeps range-source: MediaCache fetches and stores the bytes, and range-source passes the players' reads to it.

## On its own

Anything that reads a file by offset can read through it: a demuxer, a decoder, an image or archive parser, a game engine's asset loader.

**It isn't a cache for ExoPlayer or AVPlayer.** They read through their own stacks, and already have one: Media3's `CacheDataSource`, and [MediaCache](https://github.com/MediaCacheDev/media-cache) for both. range-source is for code that reads files itself.

**Android:**

```kotlin
val store = RangeSourceStore.disk(File(context.cacheDir, "my-player"), 512L shl 20)  // or RangeSourceStore.memory("my-player", cap)
RangeSource.open("https://example.com/clip.bin", store).use { reader ->
    val header = ByteArray(64 * 1024)
    val n = reader.read(0, header, 0, header.size)  // waits for the bytes: fewer at a block's end, -1 at the end
    val stream = reader.inputStream(n.toLong())       // or read on as a stream
}
```

`RangeSource.open(uri, dataSource, store)` reads through a `RangeDataSource` instead. `RangeSourceReader.open(source, uri, store, key, options)` takes a key for the store, and options: headers, block size, memory, read-ahead and retries. `tryRead` never waits, for render loops: it returns `RangeSourceReader.PENDING` and asks for the bytes. `fetchAll()` reads the rest of the file, so that the store holds it. Calls block on the network, so not on the main thread.

**iOS:**

```swift
import RangeSource

let store = try RangeSourceStore.disk(path: cachesFolder + "/my-player", maxBytes: 512 << 20)
let reader = try RangeSource.open(url: url, store: store)
let header = try reader.readData(at: 0, length: 64 * 1024)  // empty at the end of the file
```

`RangeSourceReader.open(url:dataSource:store:key:options:)` reads through a `RangeDataSource` and takes a key and options. `tryRead(at:into:length:)` never waits, returning `RangeSourcePending` while the bytes are on their way, and `fetchAll()` reads the rest. Not on the main queue.

## Native

- `Upstream` (`Upstream.h`) is where the bytes come from: `open(position)` gives the file's size and version (ETag or Last-Modified), then `read` returns bytes from there until the end, and `cancel` stops a blocked read from another thread. The players implement it over their HTTP stacks and the app's data sources.
- `Store` keeps clips between plays in 256 KB blocks, under one byte cap, least recently used out: `Store::disk(dir, maxBytes)` (per clip, a sparse data file and a meta file of its size, version and blocks held, named by a hash of the key) or `Store::memory(name, maxBytes)`. There is one store per folder or name in the process. A different version of a clip drops its copy, and a block that has gone missing is fetched again.
- `RangeReader` reads by offset, blocking until the bytes are there, through blocks in memory and the store. One fetch thread keeps one read open on the upstream and reconnects only for a read far from it, so playing from the start is one request and a seek one more. It reads 2 MB ahead of the last read, retries a failed read 3 times, and `fetchAll()` reads the whole file. `tryRead()` never waits, for render loops: it returns `kPending` and asks for the bytes, so a later call finds them. A clip the store holds whole is read without opening the upstream, so it plays offline. Thread-safe.

These are C++ classes in the namespace `rangesource`. [`include/range_source.h`](native/include/range_source.h) is the same as a C interface: a versioned table of functions (`range_source_plugin()`), with the upstream as a struct of function pointers. Code built separately, such as a player in another `.so` with its own C++ runtime, uses the reader through it. With `RANGE_SOURCE_CLIENT_NAMESPACE` defined, the header adds a C++ wrapper over the table with the classes' methods, in a namespace the includer names.

The Android and iOS packages compile `native/src` and hand the table to the players: `RangeSource.plugin()` in Java, `RangeSource.plugin` in Objective-C, which the players find by class name. The players carry only `native/include`. A new version of the table keeps `RANGE_SOURCE_ABI` and adds functions at the end (`structSize` says which are there), so the add-on updates without the players.

[`include/range_source_download.h`](native/include/range_source_download.h) is the basic input, for a player running without the add-on: `DownloadReader`, header-only, downloads the file from one open at 0 into a temporary file (unlinked at once, so nothing stays behind) and reads it as it arrives, resuming a dropped connection where it stopped. It keeps nothing between plays. Both it and the add-on's reader are a `Reader`, so a player holds either.

### Using it in your own code

Anything that reads a file by offset can read through it: a video or audio player's demuxer, an image or archive parser. Add the library, write an `Upstream` over your HTTP client, open a reader with a store, and read by offset.

```cmake
add_subdirectory(third_party/range-source/native)   # a copy or submodule of this repository
target_link_libraries(my_player PRIVATE range_source)
```

The upstream is the only part you write; in outline, it opens a read at a position and reads on from there, and the reader decides when to open one:

```cpp
#include "RangeReader.h"

class HttpUpstream : public rangesource::Upstream {
public:
    explicit HttpUpstream(std::string url) : url_(std::move(url)) {}

    bool open(int64_t position, rangesource::SourceInfo& info, std::string& error) override {
        // With your HTTP client: GET url_ with "Range: bytes=<position>-", and keep the body open.
        // Fill info.size (the total, from Content-Range, or Content-Length on a 200), info.etag and
        // info.lastModified. A server that ignores Range answers 200 from 0: skip `position` bytes.
        // On failure, set error and return false.
    }
    int64_t read(uint8_t* out, int64_t size, std::string& error) override {
        // Up to `size` bytes of the open body: how many, 0 at its end, or -1 with error set
    }
    void close() override { /* end the request */ }
    void cancel() override { /* abort a blocked open or read, from another thread */ }

private:
    std::string url_;
};
```

Then one store for the app, and a reader per file:

```cpp
// One per folder in the process, shared by every reader; or Store::memory("my-player", cap)
auto store = rangesource::Store::disk(cacheDir + "/my-player", 512LL * 1024 * 1024);

std::string error;
auto reader = rangesource::RangeReader::open(std::make_unique<HttpUpstream>(url), store,
                                             trackId,   // what the copy is kept under
                                             rangesource::ReaderOptions(), error);
if (!reader) return fail(error);   // opening reads at 0, for the size and version, unless stored whole

std::vector<uint8_t> header(64 * 1024);
int64_t n = reader->read(0, header.data(), header.size());   // waits for the bytes: fewer at a block's end, 0 at the end, -1 on error
```

- **Where to call `read`:** on your demuxer's or decoder's thread. It blocks until the bytes arrive, and the reader's own thread does the fetching. Reading in order is one HTTP request, with 2 MB read ahead. A read far from the open request, such as a seek, opens another at that offset.
- **A thread that mustn't block,** such as a render loop, calls `tryRead` instead. It returns `RangeReader::kPending` and asks for the bytes, so a later call finds them.
- **Stopping:** `close()` fails reads in progress and later ones. To stop one read, such as a seek that's been replaced, pass a pointer to an `std::atomic<bool>` as `read`'s last argument, and set it.
- **Storage:** with a store, every block that arrives is kept under the key. A file played through opens without the network next time, offline too. Pass `nullptr` for no store: 16 MB of blocks are still kept in memory. `fetchAll()` downloads the rest of a file, for playing it offline later.
- **FFmpeg** reads through an `AVIOContext`, which needs a read and a seek callback:

  ```cpp
  struct Input { std::shared_ptr<rangesource::RangeReader> reader; int64_t pos = 0; };

  static int readPacket(void* opaque, uint8_t* buf, int size) {
      auto* in = static_cast<Input*>(opaque);
      int64_t n = in->reader->read(in->pos, buf, size);
      if (n == 0) return AVERROR_EOF;
      if (n < 0) return AVERROR(EIO);
      in->pos += n;
      return static_cast<int>(n);
  }

  static int64_t seekTo(void* opaque, int64_t offset, int whence) {
      auto* in = static_cast<Input*>(opaque);
      const int64_t size = in->reader->size();
      if (whence & AVSEEK_SIZE) return size;
      switch (whence & ~AVSEEK_FORCE) {
          case SEEK_SET: in->pos = offset; break;
          case SEEK_CUR: in->pos += offset; break;
          case SEEK_END: if (size < 0) return -1; in->pos = size + offset; break;
          default: return -1;
      }
      return in->pos;
  }

  Input input{reader};
  auto* buffer = static_cast<unsigned char*>(av_malloc(64 * 1024));
  AVIOContext* avio = avio_alloc_context(buffer, 64 * 1024, 0, &input, readPacket, nullptr, seekTo);
  AVFormatContext* format = avformat_alloc_context();
  format->pb = avio;
  avformat_open_input(&format, nullptr, nullptr, nullptr);
  ```

- **Code built separately** (another `.so` with its own C++ runtime, or a plugin) uses the same reader through the C table in `range_source.h`, above, with the same steps: `RANGE_SOURCE_CLIENT_NAMESPACE` gives it the C++ wrapper's `Store::disk`, `RangeReader::open`, `read` and `tryRead`.

The host build runs the tests twice, on the classes and through the table ([Tests](#tests)).

## Tests

Each platform has its own tests, with an npm script in the repository's root to run them. `npm test` runs the two that need no device, C++ and the web; `npm run test:all` runs all four.

| Platform | Command | Needs | What it runs |
|---|---|---|---|
| C++ | `npm run test:native` | CMake and Ninja (`brew install cmake ninja`) | `native/test` twice, on the C++ classes and through the C table in `range_source.h`: the reader, both stores, eviction, versions, retries, cancelling and offline reads |
| Web | `npm run test:web` | Node 18+, and `npm ci` in `web/` once | Vitest in Node: the sources and reader, the stores (IndexedDB through `fake-indexeddb`), and `httpSource` against a local range server ([web/README.md](web/README.md#testing)) |
| Web, in browsers | `npm run test:web:browsers` | As above, plus Playwright's browsers (`npx playwright install` in `web/`) and ffmpeg | The Service Worker in Chromium, Firefox and WebKit: `<video>` streaming and storing through it, offline, seeks, headers, sources the page holds, CORS, eviction across pages, a hard reload, cross-origin isolation |
| iOS | `npm run test:ios` | Xcode 16 and an iPhone simulator | `ios/Tests/RangeSourceTests` through SwiftPM: the Objective-C API, stores, and app data sources registered with `RangeDataSources` |
| Android | `npm run test:android` | The Android SDK and NDK (`ANDROID_HOME` or `android/local.properties`), and a device or emulator in `adb devices` | `android/src/androidTest` on the device: the Java API over the native reader and stores, with a data source in memory. It also builds `range-source-media3` |

The commands behind them, to run one directly:

```bash
# C++
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build native/build && ctest --test-dir native/build --output-on-failure

# Web
cd web && npm ci && npm test
npm run test:browsers

# iOS: IOS_SIMULATOR picks the simulator, otherwise a booted iPhone or the first one available
IOS_SIMULATOR="iPhone 16 Pro" scripts/test-ios.sh
# which runs
xcodebuild test -scheme range-source -destination 'platform=iOS Simulator,name=iPhone 16 Pro'

# Android, on the device adb sees
cd android && ./gradlew connectedDebugAndroidTest
```

The alpha-video players test range-source too, as they use it: streaming with it and without it in their own repositories ([alpha-video](https://github.com/MediaCacheDev/alpha-video), [alpha-video-gpu](https://github.com/MediaCacheDev/alpha-video-gpu)).

## License

MIT.
