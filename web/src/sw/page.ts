import { openReader, type ByteReader } from '../block-reader';
import { httpSource } from '../http-source';
import { blobSource, isByteSource, memorySource } from '../sources';
import { createStore } from '../stores';
import type { ByteSource, ByteStore, StorageKind } from '../types';
import { MESSAGE, PROTOCOL_VERSION, workerUrl, type AskReply, type AskRequest } from './protocol';

export interface RegisterWorkerOptions {
  /** The registration's scope. Default: the script's folder. */
  scope?: string;
  /** 'module' for a worker script that is an ES module. Default 'classic'. */
  type?: WorkerType;
  /** How long to wait for the worker to control the page before carrying on without it. Default 2000 ms. */
  timeoutMs?: number;
}

/** What `serviceWorkerUrl` plays: a URL, or a source the page holds. */
export type WorkerSource = string | ByteSource | Blob | ArrayBuffer | Uint8Array;

export interface WorkerUrlOptions {
  /** The store's namespace, as in createStore. */
  namespace: string;
  /**
   * Where the bytes are kept. Default 'auto' for a URL, 'none' for a source the page holds. The
   * worker opens a kind's store itself; with a store of the page's own, the page reads the file
   * through it and passes the bytes on, a URL included.
   */
  storage?: StorageKind | ByteStore;
  /** The store's cap. */
  maxBytes?: number;
  /** What the bytes are stored under. Default: the URL. A source the page holds needs one to be stored. */
  key?: string;
  /** Headers for a URL's requests, such as Authorization. The worker asks the page for them. */
  headers?: HeadersInit;
  /** The media type to answer with, for a source that doesn't say. */
  contentType?: string;
}

/** A URL an element can load through the worker, and what to call once the element is done with it. */
export interface WorkerUrl {
  readonly url: string;
  /** Forgets the headers or source the page keeps for the worker. */
  release(): void;
}

interface PageEntry {
  headers: Array<[string, string]>;
  contentType?: string;
  reader?: () => Promise<ByteReader>;
  close?: () => void;
}

const entries = new Map<string, PageEntry>();
let listening = false;
let hello: { worker: ServiceWorker; answer: Promise<boolean> } | null = null;

/**
 * Registers the range-source Service Worker and waits until it controls the page, so that every
 * request the page then makes goes through it, the first included. Call it before rendering the
 * players. Resolves null where Service Workers aren't available (insecure origins, some private
 * modes), and with the registration once the worker controls the page or `timeoutMs` passed.
 */
export async function registerRangeSourceWorker(
  scriptUrl: string | URL,
  options: RegisterWorkerOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  const container = serviceWorkers();
  if (!container) return null;
  listen(container);
  const registration = await container.register(scriptUrl, { scope: options.scope, type: options.type ?? 'classic' });
  await untilControlled(container, registration, options.timeoutMs ?? 2000);
  return registration;
}

/** Whether a range-source worker controls the page. Asked once per controlling worker. */
export function rangeSourceWorker(): Promise<boolean> {
  const container = serviceWorkers();
  const worker = container?.controller;
  if (!container || !worker) return Promise.resolve(false);
  if (hello?.worker !== worker) {
    listen(container);
    const answer = new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        resolve(false);
      }, 500);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(typeof event.data?.version === 'number' && event.data.version >= PROTOCOL_VERSION);
      };
      worker.postMessage({ type: MESSAGE.hello }, [channel.port2]);
    });
    hello = { worker, answer };
  }
  return hello.answer;
}

/**
 * A URL for `src` that the range-source worker answers: a media element given it streams by
 * range, from the store first, and every block it fetches is stored. Null when no range-source
 * worker controls the page.
 *
 * The URL is on the page's own origin, in the worker's scope, whatever origin the file is on. A
 * file on another origin must be readable with CORS to be streamed and stored; one that isn't is
 * fetched whole, unstored. Release the result once the element no longer uses it.
 */
export async function serviceWorkerUrl(src: WorkerSource, options: WorkerUrlOptions): Promise<WorkerUrl | null> {
  if (!(await rangeSourceWorker())) return null;
  const scope = (await serviceWorkers()!.ready).scope;
  const id = newId();

  const { storage } = options;
  if (typeof src === 'string' && typeof storage !== 'object') {
    const url = new URL(src, baseUrl()).href;
    const headers = [...new Headers(options.headers).entries()];
    if (headers.length) entries.set(id, { headers });
    const marked = workerUrl(scope, {
      namespace: options.namespace,
      storage: storage ?? 'auto',
      maxBytes: options.maxBytes,
      key: options.key !== undefined && options.key !== url ? options.key : undefined,
      url,
      client: headers.length ? id : undefined,
    });
    return { url: marked, release: () => entries.delete(id) };
  }

  const href = typeof src === 'string' ? new URL(src, baseUrl()).href : undefined;
  const source = href ? httpSource(href, { headers: options.headers }) : toSource(src as Exclude<WorkerSource, string>);
  const key = options.key ?? href;
  const store = !key ? null : typeof storage === 'object' ? storage : createStore(storage ?? 'none', { namespace: options.namespace, maxBytes: options.maxBytes });
  let opened: Promise<ByteReader> | null = null;
  const entry: PageEntry = {
    headers: [],
    contentType: options.contentType ?? (typeof Blob !== 'undefined' && src instanceof Blob ? src.type || undefined : undefined),
    reader: () => (opened ??= openReader(source, { store, key: store ? key : undefined })),
    close: () => {
      opened?.then((reader) => reader.close(), () => {});
    },
  };
  entries.set(id, entry);
  const url = workerUrl(scope, { namespace: options.namespace, storage: 'none', client: id });
  return {
    url,
    release: () => {
      if (entries.get(id) !== entry) return;
      entries.delete(id);
      entry.close?.();
    },
  };
}

function toSource(src: Exclude<WorkerSource, string>): ByteSource {
  if (src instanceof ArrayBuffer || src instanceof Uint8Array) return memorySource(src);
  if (typeof Blob !== 'undefined' && src instanceof Blob) return blobSource(src);
  if (isByteSource(src)) return src;
  throw new TypeError('serviceWorkerUrl takes a URL, a Blob, an ArrayBuffer, a Uint8Array or a ByteSource');
}

function listen(container: ServiceWorkerContainer): void {
  if (listening) return;
  listening = true;
  container.addEventListener('message', (event) => {
    const request = event.data as AskRequest | undefined;
    const port = event.ports?.[0];
    if (request?.type !== MESSAGE.ask || !port) return;
    answer(request).then(
      ([reply, transfer]) => port.postMessage(reply, transfer),
      (error) => port.postMessage({ error: String((error as Error)?.message ?? error) } satisfies AskReply),
    );
  });
  container.startMessages?.();
}

async function answer(request: AskRequest): Promise<[AskReply, Transferable[]]> {
  const entry = entries.get(request.id);
  if (!entry) return [{ unknown: true }, []];
  switch (request.op) {
    case 'headers':
      return [{ headers: entry.headers }, []];
    case 'open': {
      if (!entry.reader) return [{ error: `${request.id} is a URL, not a source` }, []];
      const { size, etag, lastModified, contentType } = (await entry.reader()).info;
      return [{ info: { size, etag, lastModified, contentType: entry.contentType ?? contentType } }, []];
    }
    case 'read': {
      if (!entry.reader) return [{ error: `${request.id} is a URL, not a source` }, []];
      const bytes = (await (await entry.reader()).read(request.offset, request.length)).slice();
      return [{ bytes: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]];
    }
  }
}

/** Waits for the worker to control the page, asking it to claim the page after a hard reload. */
function untilControlled(container: ServiceWorkerContainer, registration: ServiceWorkerRegistration, timeoutMs: number): Promise<void> {
  if (container.controller) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      container.removeEventListener('controllerchange', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    container.addEventListener('controllerchange', done);
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (worker?.state === 'activated') {
      // A hard reload leaves the page uncontrolled, and the worker is already active
      worker.postMessage({ type: MESSAGE.claim });
    } else {
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'activated' && container.controller) done();
      });
    }
  });
}

function serviceWorkers(): ServiceWorkerContainer | null {
  return typeof navigator !== 'undefined' && navigator.serviceWorker ? navigator.serviceWorker : null;
}

function baseUrl(): string {
  return typeof document !== 'undefined' ? document.baseURI : String(globalThis.location?.href ?? '');
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
