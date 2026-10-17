# alpha-video-source

Range reading and storage shared by the alpha-video players: reading a file by offset from a URL (with HTTP range requests), a local file or an app's own data source, through a small buffer, and keeping what was read between plays under a size cap.

- [`web/`](web): the `alpha-video-source` npm package, used by `alpha-video-gpu-web`. Sources for URLs, `Blob`s and memory, a block reader, and stores in OPFS, IndexedDB, the Cache API or memory.
- Native (planned): a C++ range reader and disk store, compiled into the Android and iOS players.

The players own range streaming and storage, and depend on nothing else. Other caches plug in through the players' data-source hooks: a byte source on the web (or a Service Worker answering the players' `fetch` requests), a Media3 `DataSource` on Android, and `AlphaVideoDataSource` on iOS.

## License

MIT.
