# range-source-web

Range reading and storage on the web, for players and other code that reads a file by offset: from a URL with HTTP range requests, a `Blob`, memory, or a source of your own. The reads go through a small memory buffer, and can be kept between plays in OPFS, IndexedDB, the Cache API or memory, under a size cap. A Service Worker does the same for `<video>` and `<audio>`, which make their own requests.

The alpha-video players (`alpha-video-web` and `alpha-video-gpu-web`) depend on it and re-export what an app needs to write its own source or store, so their users don't install it themselves.

```bash
npm install range-source-web
```

## Using it in your own code

Anything that reads a file by offset can read through it: a video or audio player's demuxer, a parser for images, fonts, archives or map tiles. Make a source, choose a store, open a reader, and read by offset:

```ts
import { createStore, httpSource, openReader } from 'range-source-web';

// One store per app or player, shared by every reader; null for 'none'
const store = createStore('auto', { namespace: 'my-player', maxBytes: 256 * 1024 * 1024 });

const reader = await openReader(httpSource(url, { headers: { Authorization: `Bearer ${token}` } }), {
  store,
  key: trackId, // what the copy is kept under: the URL, or an id that outlives presigned URLs
});

reader.size; // the file's length, from the first response
const head = await reader.read(0, 64 * 1024); // one request, kept open and read on
const tail = await reader.read(reader.size - 16 * 1024, 16 * 1024); // a seek: a second request
reader.close();
```

- **Reading in order** from the start is one HTTP request. Each `read` resolves once its bytes are in, and the reader fetches 1 MB ahead of the last read, so a demuxer reading on rarely waits.
- **A seek** is a `read` somewhere else. The reader opens a request at that offset, and aborts its own read-ahead so the seek isn't stuck behind it. If you know where the player will go next, `prefetch(offset, length)` starts fetching it without waiting.
- **Storage:** with a store, every block that arrives is kept under `key`. A file played through plays again with no requests, offline too, and a file held in part fetches only what's missing. Leave out `store` for none: the reader still keeps 16 MB of blocks in memory, so a short clip loops without fetching again.
- **Code that can't await,** such as a WebAssembly demuxer called synchronously, uses `peek(offset, length)`. It returns the bytes in memory at once, or null. On null, return "not yet" to your caller, `await reader.read(offset, length)`, and call again:

  ```ts
  function bytesFor(offset: number, length: number): Uint8Array | null {
    const bytes = reader.peek(offset, length);
    if (!bytes) void reader.read(offset, length).then(retryDemux);
    return bytes;
  }
  ```

- **Cancelling:** pass an `AbortSignal` to `openReader` or to a `read`, for example when the user changes track. `close()` aborts everything the reader has in flight.
- **Other sources:** `blobSource(file)` for a `File` the user picked, `memorySource(bytes)`, or an object of your own with `size` and `read` (below), for a fetcher, cache or decryption of your own. They all work with the same reader and stores.

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
  - Requests go through `fetch`, so a Service Worker of the app's own controlling the page can answer them from its own cache. range-source's worker is for media elements, which don't read through a reader ([Service Worker](#service-worker)).
- **`blobSource(blob)`** reads a `Blob` or `File` with `slice`.
- **`memorySource(bytes)`** reads an `ArrayBuffer` or `Uint8Array`.

Failed requests throw `HttpSourceError`, with its `status` and `url`.

## Reading

`openReader(source, options)` returns a reader with `read(offset, length, signal)`, `peek(offset, length)`, `prefetch(offset, length)` and `close()`. `peek` is for code that can't await, such as a WebAssembly demuxer: it returns the bytes already in memory at once, up to the end of their block, or null if they aren't there yet, and then you `read` them and peek again. It reads ahead like `read`. The reader reads the source in 256 KB blocks:

- It keeps up to 16 MB of blocks in memory (`memoryBytes`), evicting the least recently used. So a clip of up to 16 MB loops without fetching again, even with no store.
- After each read, it fetches 1 MB further in the background (`readAheadBytes`, 0 to turn it off). A read that needs a block already being fetched waits for it; other background fetches are aborted, so a seek isn't stuck behind read-ahead.
- No single source read is longer than 4 MB (`maxRequestBytes`).
- With a `store` and a `key`, it writes each block to the store as it arrives, and reads blocks from the store before going to the source. `stored()` resolves once the blocks read so far are written, for handing the file to another reader of the store, such as the Service Worker.
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
- **Pages, tabs and the Service Worker share a store** of the same kind and namespace. Each announces the blocks it writes and the keys it deletes on a `BroadcastChannel`, and the others merge them into their index. A key open in a reader in any of them holds a shared Web Lock, and eviction skips keys whose lock it can't take. Memory stores aren't shared. Without `BroadcastChannel` or Web Locks (Safari before 15.4), each context keeps its own index, and a block that went missing is fetched again.

A store of your own implements `ByteStore` (`lookup`, `open`, `delete`, `clear`), or a `StoreBackend` (`init`, `saveEntry`, `deleteEntry`, `readBlock`, `writeBlock`, `clear`) passed to `new BlockStore([backend], maxBytes)`, which adds the index and eviction.

## Service Worker

A media element (`<video>`, `<audio>`) makes its own requests, which the page can't see, so what it plays skips the reader and the store. range-source's Service Worker answers those requests instead: from the store first, fetching what's missing by range and storing it as it goes, so a file the element played through plays again with no requests, offline too.

1. **Serve the worker script** at your site's root, by copying `node_modules/range-source-web/dist/range-source-sw.js` in your build (it's also the export `range-source-web/range-source-sw.js`). The folder it's served from is the part of the site it controls.
2. **Register it before rendering anything that plays,** and wait for it, so the first request goes through it too:

   ```ts
   import { registerRangeSourceWorker } from 'range-source-web';

   await registerRangeSourceWorker('/range-source-sw.js');
   ```

   It resolves once the worker controls the page: about 50–100 ms on a first visit, at once on later ones. A page that a hard reload (Shift-reload) left uncontrolled is claimed again. It gives up after `timeoutMs` (2 s), and resolves null where Service Workers aren't available (insecure origins, some private modes). `scope` and `type` are those of `navigator.serviceWorker.register`.
3. **Give the element a URL the worker answers:**

   ```ts
   import { serviceWorkerUrl } from 'range-source-web';

   const handle = await serviceWorkerUrl(url, { namespace: 'my-player', key: trackId, headers: { Authorization: `Bearer ${token}` } });
   video.src = handle?.url ?? url;

   // Once the element is done with it
   video.removeAttribute('src');
   video.load();
   handle?.release();
   ```

   It returns null when no range-source worker controls the page (`rangeSourceWorker()` asks the worker, once per worker). The URL is on the page's origin, in the worker's scope (`__range-source/<file name>?…`), and says which file, store and key; the server sees the file's own URL.

What the worker does:

- **Storage:** `storage` (a kind, default `'auto'`), `maxBytes` and `key` are those of `createStore` and `openReader`. The worker opens that store itself, shared with the page's (above). With a store object of the page's own instead of a kind, the page reads the file through it and the worker passes the bytes on.
- **Headers:** an element can't send them, so the worker asks the page that gave them, over `postMessage`, and keeps them in memory.
- **Sources the page holds,** a `Blob`, bytes or a `ByteSource`: the worker forwards each range the element asks for to the page, which reads it through a reader (and a store, with `storage` and `key`) and sends the bytes back. `contentType` gives the media type for a source that doesn't have one.
- **Cross-origin files** need CORS for the worker to read them, as for `httpSource`. Without it, the worker fetches the file in `no-cors` mode and passes it through whole and unstored, and remembers that origin while it runs. The responses come from the page's own origin, so a cross-origin isolated page (COEP `require-corp`) accepts them.
- **Responses** are `206` for `Range: bytes=a-b`, `a-` and `-n`, and `200` without a `Range`, with `Content-Type` (from the server, else the file extension), `Content-Length`, `Content-Range`, `ETag` and `Last-Modified`. The body is read from a reader 256 KB at a time as the element takes it, keeping at most 4 MB in memory per response, and stops when the element drops the request, as it does on a seek.
- **A server without range support** is read from the start, as by `httpSource`, and the element still gets `206`s.
- **Long responses:** a browser may stop a worker in the middle of one (Firefox after 5 minutes). The element then asks again from where it had got to, and the worker carries on, since everything it needs is in the URL and the store. Tested by stopping the worker mid-stream in Chromium and Firefox.

Browser notes, from the tests: Chromium and Firefox keep the store in OPFS, WebKit in IndexedDB. Firefox only sends an element's requests to a worker when they're on the page's origin, which is why the URLs are. Playwright's WebKit reads a WebM from the start without `Range`, worker or not, so a seek far ahead waits for the bytes before it. Firefox logs "A ServiceWorker intercepted the request and encountered an unexpected error" when an element drops a response the worker is streaming; playback isn't affected.

**An app with a Service Worker of its own** adds range-source's handler to it. A classic worker can `importScripts('/range-source-sw.js')`; its `fetch` listener answers only the URLs `serviceWorkerUrl` made. A bundled one imports the worker entry:

```ts
import { handleRangeSourceFetch, installRangeSourceWorker } from 'range-source-web/sw';

installRangeSourceWorker(self, { fetch: false }); // hello, activation and claiming the pages
self.addEventListener('fetch', (event) => {
  if (handleRangeSourceFetch(event)) return;
  // the app's own handling
});
```

`claim: false` leaves activation to the app; the page then waits for its worker to take control of it, up to `timeoutMs`.

## Testing

`npm test` runs the unit tests: the sources and reader in memory, the stores (IndexedDB through `fake-indexeddb`), and `httpSource` against a local server with and without range support, including chunked responses, hidden `Content-Range`, required headers, aborts, and a file that changes between requests.

`npm run test:browsers` runs the Service Worker in Chromium, Firefox and WebKit through Playwright (`npx playwright install` once; ffmpeg makes the test clips): `<video>` streaming and storing through it, replay with no requests, offline, seeks, a head the page stored, headers, bytes the page holds, a store of the page's own, a server without ranges, cross-origin with and without CORS, eviction across pages, a hard reload, cross-origin isolation, and the browser stopping the worker mid-stream. `-- chromium` picks browsers.

`npm run serve -- <dir> --port 8766` serves a folder for browser tests, answering range requests. `--no-range` makes it answer `200` with the whole file, and `--chunked` leaves out `Content-Length`. Tests can also start it in process with `startRangeServer()` from `test/range-server.mjs`.

## License

MIT.
