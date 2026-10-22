# range-source

Range reading and storage for players and other code that reads a file by offset: from a URL (with HTTP range requests), a local file or an app's own data source, through a small buffer, keeping what was read between plays under a size cap. The alpha-video players use it on every platform.

- [`web/`](web): the `range-source-web` npm package, a dependency of `alpha-video-web` and `alpha-video-gpu-web`. Sources for URLs, `Blob`s and memory, a block reader, and stores in OPFS, IndexedDB, the Cache API or memory.
- [`native/`](native): the same reader and stores in C++17, compiled into the Android and iOS players, which vendor `native/src`.

The players own range streaming and storage, and depend on nothing else. Other caches plug in through the players' data-source hooks: a byte source on the web (or a Service Worker answering the players' `fetch` requests), an `AlphaVideoDataSource` on Android (or a Media3 `DataSource.Factory`, through `alpha-video-media3`) and on iOS.

## Native

- `Upstream` (`Upstream.h`) is where the bytes come from: `open(position)` gives the file's size and version (ETag or Last-Modified), then `read` returns bytes from there until the end, and `cancel` stops a blocked read from another thread. The players implement it over their HTTP stacks and the app's data sources.
- `Store` keeps clips between plays in 256 KB blocks, under one byte cap, least recently used out: `Store::disk(dir, maxBytes)` (per clip, a sparse data file and a meta file of its size, version and blocks held, named by a hash of the key) or `Store::memory(name, maxBytes)`. There is one store per folder or name in the process. A different version of a clip drops its copy, and a block that has gone missing is fetched again.
- `RangeReader` reads by offset, blocking until the bytes are there, through blocks in memory and the store. One fetch thread keeps one read open on the upstream and reconnects only for a read far from it, so playing from the start is one request and a seek one more. It reads 2 MB ahead of the last read, retries a failed read 3 times, and `fetchAll()` reads the whole file. `tryRead()` never waits, for render loops: it returns `kPending` and asks for the bytes, so a later call finds them. A clip the store holds whole is read without opening the upstream, so it plays offline. Thread-safe.

These are C++ classes in the namespace `rangesource`. [`include/range_source.h`](native/include/range_source.h) is the same as a C interface: a versioned table of functions (`range_source_plugin()`), with the upstream as a struct of function pointers. Code built separately, such as a player in another `.so` with its own C++ runtime, uses the reader through it. With `RANGE_SOURCE_CLIENT_NAMESPACE` defined, the header adds a C++ wrapper over the table with the classes' methods, in a namespace the includer names.

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

The host build runs the tests twice, on the classes and through the table:

```bash
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo && cmake --build native/build && ctest --test-dir native/build
```

## License

MIT.
