import { HttpSourceError, SourceChangedError, type ByteSource, type SourceInfo } from './types';

export interface HttpSourceOptions {
  /** Sent with every request, e.g. Authorization. */
  headers?: HeadersInit;
  /** Other fetch options (credentials, mode, cache, referrerPolicy...). Method, headers and signal are set here. */
  init?: Omit<RequestInit, 'method' | 'headers' | 'signal' | 'body'>;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
  /** How far ahead of an open connection a read may start and still use it, rather than reconnecting. */
  reconnectGap?: number;
  /** Where open() asks the file from, for a reader that will start reading there rather than at 0. */
  openAt?: number;
}

const DEFAULT_RECONNECT_GAP = 512 * 1024;

interface Connection {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Offset of the next byte the connection yields. */
  pos: number;
  /** Bytes received past the last read's end. */
  leftover: Uint8Array | null;
}

/**
 * A source over a URL, read with HTTP range requests.
 *
 * Sequential reads share one open-ended `Range: bytes=N-` connection; a read elsewhere opens a
 * new one. A server that ignores Range (200) is read progressively from the start, restarting
 * for reads behind the current position. A body with no known length is read whole into memory.
 *
 * Content-Range and ETag are only readable cross-origin when the server exposes them
 * (Access-Control-Expose-Headers); without them the size comes from Content-Length, and the
 * version from Last-Modified.
 */
export function httpSource(url: string, options: HttpSourceOptions = {}): ByteSource {
  return new HttpSource(url, options);
}

class HttpSource implements ByteSource {
  private readonly fetchFn: typeof fetch;
  private readonly reconnectGap: number;
  private info: SourceInfo | null = null;
  private rangeSupported = true;
  private whole: Uint8Array | null = null;
  private connection: Connection | null = null;
  private openAt: number;

  constructor(private readonly url: string, private readonly options: HttpSourceOptions) {
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
    this.reconnectGap = options.reconnectGap ?? DEFAULT_RECONNECT_GAP;
    this.openAt = Math.max(0, Math.floor(options.openAt ?? 0));
  }

  async open(signal?: AbortSignal): Promise<SourceInfo> {
    if (this.info) return this.info;
    let start = this.openAt;
    const controller = new AbortController();
    let response: Response;
    try {
      response = await this.request(start, controller, signal);
    } catch (error) {
      // Past the end of the file
      if (!(start > 0 && error instanceof HttpSourceError && error.status === 416)) throw error;
      start = 0;
      response = await this.request(start, controller, signal);
    }
    const version = versionOf(response);

    if (response.status === 206) {
      const range = parseContentRange(response.headers.get('content-range'));
      const length = contentLength(response);
      // Without Content-Range, a response from 0 still has the size in Content-Length
      const size = range?.total ?? (start === 0 ? length : undefined);
      if (range && range.start !== start) throw new Error(`${this.url} answered bytes=${start}- with bytes ${range.start}-`);
      if (size === undefined) {
        if (start > 0) {
          // The size is only known from the start: open there instead
          controller.abort();
          this.openAt = 0;
          return this.open(signal);
        }
        this.whole = await readAll(response);
        this.info = { size: this.whole.byteLength, ...version };
        return this.info;
      }
      this.info = { size, ...version };
      this.connection = connectionOf(response, controller, start);
      return this.info;
    } else {
      this.rangeSupported = false;
      const length = contentLength(response);
      if (length === undefined || isEncoded(response)) {
        this.whole = await readAll(response);
        this.info = { size: this.whole.byteLength, ...version };
        return this.info;
      }
      this.info = { size: length, ...version };
    }
    this.connection = connectionOf(response, controller, 0);
    return this.info;
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    const info = this.info ?? (await this.open(signal));
    const end = Math.min(offset + length, info.size);
    if (offset >= end) return new Uint8Array(0);
    if (this.whole) return this.whole.subarray(offset, end);

    const out = new Uint8Array(end - offset);
    let filled = 0;
    let retried = false;
    while (filled < out.byteLength) {
      const at = offset + filled;
      const connection = await this.connectionAt(at, signal);
      const got = await this.drain(connection, at, out, filled, signal);
      if (got === 0) {
        this.closeConnection();
        if (retried) throw new Error(`${this.url} ended at ${at} of ${info.size} bytes`);
        retried = true;
        continue;
      }
      filled += got;
    }
    return out;
  }

  close(): void {
    this.closeConnection();
  }

  /** A connection whose next byte is at or a little before offset. */
  private async connectionAt(offset: number, signal?: AbortSignal): Promise<Connection> {
    const current = this.connection;
    if (current && current.pos <= offset && (offset - current.pos <= this.reconnectGap || !this.rangeSupported)) {
      return current;
    }
    this.closeConnection();
    const start = this.rangeSupported ? offset : 0;
    const controller = new AbortController();
    const response = await this.request(start, controller, signal);
    this.checkVersion(response, start);
    this.connection = connectionOf(response, controller, start);
    return this.connection;
  }

  /** Copies the connection's bytes at offset into out from index `into`; returns how many, 0 if it ended. */
  private async drain(
    connection: Connection,
    offset: number,
    out: Uint8Array,
    into: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const abort = () => {
      connection.controller.abort();
      if (this.connection === connection) this.connection = null;
    };
    signal?.addEventListener('abort', abort);
    try {
      let copied = 0;
      while (into + copied < out.byteLength) {
        signal?.throwIfAborted?.();
        let chunk = connection.leftover;
        connection.leftover = null;
        if (!chunk) {
          const { value, done } = await connection.reader.read();
          if (done || !value) return copied;
          chunk = value;
        }
        const chunkStart = connection.pos;
        connection.pos += chunk.byteLength;
        const want = offset + copied;
        if (connection.pos <= want) continue;
        const from = want - chunkStart;
        const take = Math.min(chunk.byteLength - from, out.byteLength - into - copied);
        out.set(chunk.subarray(from, from + take), into + copied);
        copied += take;
        if (from + take < chunk.byteLength) {
          connection.leftover = chunk.subarray(from + take);
          connection.pos -= connection.leftover.byteLength;
        }
      }
      return copied;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private async request(start: number, controller: AbortController, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(this.options.headers);
    if (this.rangeSupported) headers.set('Range', `bytes=${start}-`);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort);
    try {
      const response = await this.fetchFn(this.url, {
        ...this.options.init,
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (response.status !== 200 && response.status !== 206) {
        throw new HttpSourceError(response.status, this.url);
      }
      return response;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private checkVersion(response: Response, start: number): void {
    const info = this.info!;
    if (this.rangeSupported && response.status !== 206) {
      throw new SourceChangedError(`${this.url} stopped answering range requests`);
    }
    const version = versionOf(response);
    if (version.etag && info.etag && version.etag !== info.etag) {
      throw new SourceChangedError(`${this.url} changed (ETag ${info.etag} → ${version.etag})`);
    }
    if (version.lastModified && info.lastModified && version.lastModified !== info.lastModified) {
      throw new SourceChangedError(`${this.url} changed (Last-Modified ${info.lastModified} → ${version.lastModified})`);
    }
    const range = parseContentRange(response.headers.get('content-range'));
    const length = contentLength(response);
    const size = range?.total ?? (length !== undefined ? (this.rangeSupported ? start + length : length) : undefined);
    if (size !== undefined && size !== info.size) {
      throw new SourceChangedError(`${this.url} changed size (${info.size} → ${size} bytes)`);
    }
    if (range && range.start !== start) {
      throw new Error(`${this.url} answered bytes=${start}- with bytes ${range.start}-`);
    }
  }

  private closeConnection(): void {
    this.connection?.controller.abort();
    this.connection = null;
  }
}

function connectionOf(response: Response, controller: AbortController, pos: number): Connection {
  const reader = response.body ? response.body.getReader() : bufferedReader(response);
  return { controller, reader, pos, leftover: null };
}

/** A reader that yields the whole body once, for responses without a stream body. */
function bufferedReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  let done = false;
  return {
    async read() {
      if (done) return { done: true, value: undefined };
      done = true;
      return { done: false, value: new Uint8Array(await response.arrayBuffer()) };
    },
    releaseLock() {},
    cancel: async () => {},
    closed: Promise.resolve(undefined),
  } as ReadableStreamDefaultReader<Uint8Array>;
}

async function readAll(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value);
}

/** Content-Encoding makes Content-Length the encoded size, not the size fetch hands back. */
function isEncoded(response: Response): boolean {
  const encoding = response.headers.get('content-encoding');
  return encoding !== null && encoding.trim().toLowerCase() !== 'identity';
}

function versionOf(response: Response): Pick<SourceInfo, 'etag' | 'lastModified' | 'contentType'> {
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  const contentType = response.headers.get('content-type');
  return {
    etag: etag ? etag.replace(/^W\//, '') : undefined,
    lastModified: lastModified ?? undefined,
    contentType: contentType ?? undefined,
  };
}

export function parseContentRange(value: string | null): { start: number; end: number; total?: number } | null {
  if (!value) return null;
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(value);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? undefined : Number(match[3]),
  };
}
