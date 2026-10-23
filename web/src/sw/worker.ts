import { openReader, type ByteReader } from '../block-reader';
import { httpSource } from '../http-source';
import { createStore } from '../stores';
import { HttpSourceError, type SourceInfo, type StorageKind } from '../types';
import { MESSAGE, PROTOCOL_VERSION, readMarks, type AskReply, type AskRequest, type Marks } from './protocol';

/** The parts of a Service Worker's FetchEvent the handler uses. */
export interface RangeSourceFetchEvent {
  readonly request: Request;
  readonly clientId: string;
  respondWith(response: Response | Promise<Response>): void;
}

interface WorkerClient {
  readonly id: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/** The parts of a Service Worker's global scope the handler uses. */
export interface RangeSourceWorkerScope {
  readonly registration: { readonly scope: string };
  readonly clients: {
    get(id: string): Promise<WorkerClient | undefined>;
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<readonly WorkerClient[]>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export interface RangeSourceWorkerOptions {
  /** Bytes of blocks each response keeps in memory. Default 4 MB. */
  memoryBytes?: number;
}

export interface InstallOptions extends RangeSourceWorkerOptions {
  /** Add a `fetch` listener. False for a worker that calls handleRangeSourceFetch from its own. Default true. */
  fetch?: boolean;
  /** Activate a new version of the worker straight away, and claim open pages. Default true. */
  claim?: boolean;
}

const DEFAULT_MEMORY_BYTES = 4 * 1024 * 1024;
/** Each pull of a response body reads at most this much, up to the next block boundary. */
const CHUNK_BYTES = 256 * 1024;
const ASK_TIMEOUT_MS = 15_000;

/** Origins whose files can't be read with CORS: their requests go to the network as they are. */
const opaqueOrigins = new Set<string>();
/** Headers the page gave for a client id, kept while the worker runs. */
const clientHeaders = new Map<string, Promise<Array<[string, string]>>>();

/**
 * Answers a request the page marked for range-source, from the store and the network, and
 * returns true; returns false for any other request, leaving it to the browser or the next handler.
 */
export function handleRangeSourceFetch(
  event: RangeSourceFetchEvent,
  options: RangeSourceWorkerOptions = {},
  scope: RangeSourceWorkerScope = self as unknown as RangeSourceWorkerScope,
): boolean {
  const request = event.request;
  if (request.method !== 'GET') return false;
  const marks = readMarks(request.url, scope.registration.scope);
  if (!marks) return false;
  event.respondWith(respond(event, marks, options, scope));
  return true;
}

/**
 * Sets up a Service Worker for range-source: answers marked requests, says hello to the page,
 * and (unless `claim` is false) activates at once and claims the pages, so the first requests
 * already go through it.
 */
export function installRangeSourceWorker(scope: RangeSourceWorkerScope, options: InstallOptions = {}): void {
  const claim = options.claim !== false;
  if (claim) {
    scope.addEventListener('install', (event) => event.waitUntil(scope.skipWaiting()));
    scope.addEventListener('activate', (event) => event.waitUntil(scope.clients.claim()));
  }
  scope.addEventListener('message', (event) => {
    const type = event.data?.type;
    if (type === MESSAGE.hello) event.ports?.[0]?.postMessage({ version: PROTOCOL_VERSION });
    else if (type === MESSAGE.claim && claim) event.waitUntil(scope.clients.claim());
  });
  if (options.fetch !== false) {
    scope.addEventListener('fetch', (event) => {
      handleRangeSourceFetch(event, options, scope);
    });
  }
}

async function respond(
  event: RangeSourceFetchEvent,
  marks: Marks,
  options: RangeSourceWorkerOptions,
  scope: RangeSourceWorkerScope,
): Promise<Response> {
  const range = parseRange(event.request.headers.get('range'));
  if (range === 'invalid') return new Response(null, { status: 416 });
  const url = marks.url;
  if (url !== undefined && opaqueOrigins.has(originOf(url))) return opaque(url, event.request);

  let reader: ByteReader;
  try {
    reader = url === undefined ? await pageReader(event, marks, scope) : await networkReader(event, url, marks, options, range, scope);
  } catch (error) {
    if (error instanceof HttpSourceError) return new Response(null, { status: error.status, statusText: error.message });
    if (url !== undefined && error instanceof TypeError && originOf(url) !== originOf(scope.registration.scope)) {
      // Not readable with CORS (or offline): fetched as an element without the worker would
      const response = await opaque(url, event.request);
      opaqueOrigins.add(originOf(url));
      return response;
    }
    return Response.error();
  }
  return rangeResponse(reader, range, url ?? '');
}

/**
 * The file as an opaque response, for a server without CORS. A script can't send Range in
 * no-cors mode, so it's the whole file, which media elements play from the start.
 */
function opaque(url: string, request: Request): Promise<Response> {
  return fetch(url, { mode: 'no-cors', credentials: request.credentials });
}

function networkReader(
  event: RangeSourceFetchEvent,
  url: string,
  marks: Marks,
  options: RangeSourceWorkerOptions,
  range: Range | null,
  scope: RangeSourceWorkerScope,
): Promise<ByteReader> {
  const store = createStore(marks.storage as StorageKind, { namespace: marks.namespace, maxBytes: marks.maxBytes });
  const key = store ? (marks.key ?? url) : undefined;
  const headers = marks.client ? headersFor(event, marks.client, scope) : Promise.resolve(undefined);
  return Promise.all([headers, store && key ? store.lookup(key).catch(() => null) : null]).then(([headerList, held]) => {
    // Connect where the first missing block is, not where the request starts, when the store holds what's before it
    let openAt = range && 'start' in range ? range.start : 0;
    if (held) {
      const blocks = new Set(held.blocks);
      let index = Math.floor(openAt / held.blockSize);
      while (blocks.has(index)) index++;
      openAt = index * held.blockSize;
    }
    const source = httpSource(url, { headers: headerList, openAt });
    return openReader(source, { store, key, memoryBytes: options.memoryBytes ?? DEFAULT_MEMORY_BYTES });
  });
}

/** A source the page holds: the page reads it, through its own store, and hands the bytes over. */
async function pageReader(event: RangeSourceFetchEvent, marks: Marks, scope: RangeSourceWorkerScope): Promise<ByteReader> {
  const id = marks.client;
  if (!id) throw new Error('a page source needs a client id');
  const client = await clientFor(event, id, scope);
  const reply = await ask(client, { type: MESSAGE.ask, id, op: 'open' });
  if (!('info' in reply)) throw new Error('error' in reply ? reply.error : `the page has no source ${id}`);
  const info: SourceInfo = reply.info;
  let closed = false;
  return {
    info,
    size: info.size,
    async read(offset, length) {
      if (closed) throw new DOMException('The read was aborted', 'AbortError');
      const answer = await ask(client, { type: MESSAGE.ask, id, op: 'read', offset, length });
      if ('bytes' in answer) return new Uint8Array(answer.bytes);
      throw new Error('error' in answer ? answer.error : `the page dropped source ${id}`);
    },
    peek: () => null,
    prefetch: () => {},
    close: () => {
      closed = true;
    },
  };
}

function headersFor(event: RangeSourceFetchEvent, id: string, scope: RangeSourceWorkerScope): Promise<Array<[string, string]>> {
  let headers = clientHeaders.get(id);
  if (!headers) {
    headers = clientFor(event, id, scope)
      .then((client) => ask(client, { type: MESSAGE.ask, id, op: 'headers' }))
      .then((reply) => {
        if ('headers' in reply) return reply.headers;
        throw new Error('error' in reply ? reply.error : `the page has no headers for ${id}`);
      });
    headers.catch(() => clientHeaders.delete(id));
    clientHeaders.set(id, headers);
  }
  return headers;
}

/** The page that registered id: the one that made the request, else whichever window knows it. */
async function clientFor(event: RangeSourceFetchEvent, id: string, scope: RangeSourceWorkerScope): Promise<WorkerClient> {
  const own = event.clientId ? await scope.clients.get(event.clientId) : undefined;
  if (own) return own;
  for (const client of await scope.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    const reply = await ask(client, { type: MESSAGE.ask, id, op: 'headers' }).catch(() => null);
    if (reply && !('unknown' in reply)) return client;
  }
  throw new Error(`no page holds ${id}`);
}

function ask(client: WorkerClient, request: AskRequest): Promise<AskReply> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error(`the page didn't answer ${request.op} for ${request.id}`));
    }, ASK_TIMEOUT_MS);
    channel.port1.onmessage = (message) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(message.data as AskReply);
    };
    client.postMessage(request, [channel.port2]);
  });
}

type Range = { start: number; end?: number } | { suffix: number };

/** A single `bytes=` range; null without one, 'invalid' for one this can't serve. */
function parseRange(header: string | null): Range | null | 'invalid' {
  if (!header) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  if (match[1] === '') return { suffix: Number(match[2]) };
  const start = Number(match[1]);
  const end = match[2] === '' ? undefined : Number(match[2]);
  if (end !== undefined && end < start) return 'invalid';
  return { start, end };
}

/** A 200 or 206 whose body pulls the bytes from the reader as the browser reads it. */
function rangeResponse(reader: ByteReader, range: Range | null, url: string): Response {
  const size = reader.size;
  let start = 0;
  let end = size - 1;
  if (range && 'suffix' in range) start = Math.max(0, size - range.suffix);
  else if (range) {
    start = range.start;
    if (range.end !== undefined) end = Math.min(range.end, size - 1);
  }
  const headers = new Headers({
    'Content-Type': reader.info.contentType || typeFromExtension(url),
    'Accept-Ranges': 'bytes',
  });
  if (reader.info.etag) headers.set('ETag', reader.info.etag);
  if (reader.info.lastModified) headers.set('Last-Modified', reader.info.lastModified);
  if (range && (start >= size || start > end)) {
    reader.close();
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Length', String(Math.max(0, end - start + 1)));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);

  const abort = new AbortController();
  let position = start;
  const done = () => {
    abort.abort();
    reader.close();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (position > end) {
        controller.close();
        done();
        return;
      }
      try {
        const length = Math.min(end + 1 - position, CHUNK_BYTES - (position % CHUNK_BYTES));
        const bytes = await reader.read(position, length, abort.signal);
        if (bytes.byteLength === 0) throw new Error(`no bytes at ${position} of ${size}`);
        position += bytes.byteLength;
        // A copy: the reader's blocks stay in its memory, and a body chunk may be detached
        controller.enqueue(bytes.slice());
        if (position > end) {
          controller.close();
          done();
        }
      } catch (error) {
        // A cancelled body's read is aborted: that isn't an error
        if (!abort.signal.aborted) controller.error(error);
        done();
      }
    },
    cancel: done,
  });
  return new Response(size === 0 ? null : body, { status: range ? 206 : 200, headers });
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

const TYPES: Record<string, string> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ktx2: 'image/ktx2',
  png: 'image/png',
  apng: 'image/apng',
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

function typeFromExtension(url: string): string {
  const path = url.split(/[?#]/)[0];
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[extension] ?? 'application/octet-stream';
}
