# alpha-video-source

Byte sources and storage for the alpha-video players on the web. A player reads a file by offset: from a URL with HTTP range requests, a `Blob`, memory, or a source of your own. The reads go through a small memory buffer, and can be kept between plays in OPFS, IndexedDB, the Cache API or memory, under a size cap.

`alpha-video-gpu-web` (the KTX2 player) uses it. Apps only need it directly to write their own source or store; the players re-export what's needed for that.

```bash
npm install alpha-video-source
```

## Sources

A source reads bytes by offset:

```ts
interface ByteSource {
  /** Length and version. Without it, size is used. */
  open?(signal?: AbortSignal): Promise<{ size: number; etag?: string; lastModified?: string }>;
  readonly size?: number;
  /** `length` bytes from `offset`, fewer only where the source ends. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close?(): void;
}
```

The smallest source is `{ size, read }`. Readers call `open()` once before reading, and `read()` one call at a time. This is how an app plays from its own fetcher, cache or decryption, or from a MediaCache:

```ts
const source = {
  size: 5_069_344,
  read: (offset, length, signal) => myCache.read(fileId, offset, length, signal),
};
player.setSource(source);
```

Built in:

- **`httpSource(url, options)`** makes range requests.
  - `open()` sends `Range: bytes=0-` and keeps that response open, so playing from the start is a single request.
  - Reads that follow on, or skip ahead by up to `reconnectGap` (512 KB by default), reuse it. A read elsewhere, such as a seek, starts a new request at its offset.
  - A server that answers `200` instead of `206` is read progressively: seeks ahead wait for the download, and a seek back starts it again from 0. A response without a length, or a compressed one (`Content-Encoding`), is read into memory whole.
  - Each new request checks the version (`ETag`, else `Last-Modified`, and the length), and fails with `SourceChangedError` if the file changed.
  - Options: `headers` (sent with every request, for example `Authorization`), `init` (other `fetch` options, such as `credentials`), `fetch` (one to use instead of the global), and `reconnectGap`.
  - Cross-origin servers need CORS that allows `GET`. The `Range` header is a safelisted request header. To check versions, expose `ETag` (or `Last-Modified`) and `Content-Range` with `Access-Control-Expose-Headers`. Without them, the length is taken from `Content-Length`, and versions aren't checked.
  - Requests go through `fetch`, so a Service Worker controlling the page can answer them from its own cache, with no code here.
- **`blobSource(blob)`** reads a `Blob` or `File` with `slice`.
- **`memorySource(bytes)`** reads an `ArrayBuffer` or `Uint8Array`.

Failed requests throw `HttpSourceError`, with its `status` and `url`.

## Reading

`openReader(source, options)` returns a reader with `read(offset, length, signal)`, `prefetch(offset, length)` and `close()`. It reads the source in 256 KB blocks:

- It keeps up to 16 MB of blocks in memory (`memoryBytes`), evicting the least recently used. So a clip of up to 16 MB loops without fetching again, even with no store.
- After each read, it fetches 1 MB further in the background (`readAheadBytes`, 0 to turn it off). A read that needs a block already being fetched waits for it; other background fetches are aborted, so a seek isn't stuck behind read-ahead.
- No single source read is longer than 4 MB (`maxRequestBytes`).
- With a `store` and a `key`, it writes each block to the store as it arrives, and reads blocks from the store before going to the source.
  - A clip held whole plays without opening the source at all, so it plays offline. It isn't revalidated; store a changed file under a new key, or `delete` the old one.
  - A clip held in part opens the source first, and drops the stored copy if the version differs.

## Stores

```ts
const store = createStore('auto', { namespace: 'my-app', maxBytes: 512 * 1024 * 1024 });
```

| Kind | Where | Notes |
|---|---|---|
| `'auto'`, `'opfs'` | The origin private file system: a folder per key, a file per block | Falls back to IndexedDB, then memory |
| `'indexeddb'` | An IndexedDB database per namespace, with a record per block | Falls back to memory |
| `'cache'` | The Cache API, as synthetic responses per block | `Cache.put` doesn't take `206` responses, so blocks are stored as their own `200`s. Falls back to IndexedDB, then memory |
| `'memory'` | Memory, shared by every reader on the page | Lost on reload |
| `'none'` | Nothing; `createStore` returns `null` | |

- **The namespace** keeps one player's storage apart from another's. Each namespace has its own cap and files.
- **`maxBytes`** caps the store across every key in it. It defaults to 512 MB (`DEFAULT_MAX_STORAGE_BYTES`). Past the cap, the least recently used keys are evicted, except those open in a reader.
- **Stores are best-effort.** A failed write is skipped, and a block the browser evicted is fetched again. Asking for persistent storage (`navigator.storage.persist()`) is up to the app.
- **`createStore` returns one store per kind and namespace,** so players on a page share an index and a cap. The cap is the one passed last.

A store of your own implements `ByteStore` (`lookup`, `open`, `delete`, `clear`), or a `StoreBackend` (`init`, `saveEntry`, `deleteEntry`, `readBlock`, `writeBlock`, `clear`) passed to `new BlockStore([backend], maxBytes)`, which adds the index and eviction.

## Testing

`npm test` runs the unit tests: the sources and reader in memory, the stores (IndexedDB through `fake-indexeddb`), and `httpSource` against a local server with and without range support, including chunked responses, hidden `Content-Range`, required headers, aborts, and a file that changes between requests.

`npm run serve -- <dir> --port 8766` serves a folder for browser tests, answering range requests. `--no-range` makes it answer `200` with the whole file, and `--chunked` leaves out `Content-Length`. Tests can also start it in process with `startRangeServer()` from `test/range-server.mjs`.

## License

MIT.
