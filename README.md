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

The host build runs the tests twice, on the classes and through the table:

```bash
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo && cmake --build native/build && ctest --test-dir native/build
```

## License

MIT.
