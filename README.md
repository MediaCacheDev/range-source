# alpha-video-source

Range reading and storage shared by the alpha-video players: reading a file by offset from a URL (with HTTP range requests), a local file or an app's own data source, through a small buffer, and keeping what was read between plays under a size cap.

- [`web/`](web): the `alpha-video-source` npm package, used by `alpha-video-web` and `alpha-video-gpu-web`. Sources for URLs, `Blob`s and memory, a block reader, and stores in OPFS, IndexedDB, the Cache API or memory.
- [`native/`](native): the same reader and stores in C++17, compiled into the Android and iOS players, which vendor `native/src`.

The players own range streaming and storage, and depend on nothing else. Other caches plug in through the players' data-source hooks: a byte source on the web (or a Service Worker answering the players' `fetch` requests), an `AlphaVideoDataSource` on Android (or a Media3 `DataSource.Factory`, through `alpha-video-media3`) and on iOS.

## Native

- `Upstream` (`Upstream.h`) is where the bytes come from: `open(position)` gives the file's size and version (ETag or Last-Modified), then `read` returns bytes from there until the end, and `cancel` stops a blocked read from another thread. The players implement it over their HTTP stacks and the app's data sources.
- `Store` keeps clips between plays in 256 KB blocks, under one byte cap, least recently used out: `Store::disk(dir, maxBytes)` (per clip, a sparse data file and a meta file of its size, version and blocks held, named by a hash of the key) or `Store::memory(name, maxBytes)`. There is one store per folder or name in the process. A different version of a clip drops its copy, and a block that has gone missing is fetched again.
- `RangeReader` reads by offset, blocking until the bytes are there, through blocks in memory and the store. One fetch thread keeps one read open on the upstream and reconnects only for a read far from it, so playing from the start is one request and a seek one more. It reads 2 MB ahead of the last read, retries a failed read 3 times, and `fetchAll()` reads the whole file. A clip the store holds whole is read without opening the upstream, so it plays offline. Thread-safe.

The host build runs the tests:

```bash
cmake -S native -B native/build -G Ninja && cmake --build native/build && native/build/source_tests
```

## License

MIT.
