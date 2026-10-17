import { SourceChangedError, type ByteSource, type ByteStore, type SourceInfo, type StoredResource } from './types';
import { openSource } from './sources';
import { sameVersion } from './version';

export interface ReaderOptions {
  /** Where to keep blocks between plays. Null or omitted keeps them only in memory, up to memoryBytes. */
  store?: ByteStore | null;
  /** The store key; defaults to the source's URL for players, required with a store. */
  key?: string;
  /** Block size in bytes. A stored entry keeps the block size it was written with. */
  blockSize?: number;
  /** Bytes of blocks kept in memory. */
  memoryBytes?: number;
  /** After each read, fetch this many bytes past it in the background. 0 turns read-ahead off. */
  readAheadBytes?: number;
  /** Largest single source read; bigger runs are split, which keeps memory and abort latency bounded. */
  maxRequestBytes?: number;
  signal?: AbortSignal;
}

/** Reads a source by offset, through a memory buffer and an optional store. */
export interface ByteReader {
  readonly info: SourceInfo;
  readonly size: number;
  /** `length` bytes from `offset`, fewer only where the source ends. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Starts fetching a range in the background, if it isn't held already. */
  prefetch(offset: number, length: number): void;
  close(): void;
}

export const DEFAULT_BLOCK_SIZE = 256 * 1024;
const DEFAULT_MEMORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_READ_AHEAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Opens a reader over source. A source fully held in the store under key is read without
 * opening the source at all, so it plays offline.
 */
export async function openReader(source: ByteSource, options: ReaderOptions = {}): Promise<ByteReader> {
  const store = options.store ?? null;
  const key = options.key;
  if (store && !key) throw new Error('openReader: a store needs a key');

  let blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  if (!store || !key) {
    const info = await openSource(source, options.signal);
    return new BlockReader(source, info, blockSize, null, null, undefined, options, true);
  }

  const entry = await safely(() => store.lookup(key), null);
  if (entry && entry.blocks.length === blockCountOf(entry.info.size, entry.blockSize)) {
    const resource = await safely(() => store.open(key, entry.info, entry.blockSize), null);
    if (resource) {
      return new BlockReader(source, entry.info, entry.blockSize, resource, store, key, options, false);
    }
  }
  const info = await openSource(source, options.signal);
  if (entry && sameVersion(entry.info, info)) blockSize = entry.blockSize;
  const resource = await safely(() => store.open(key, info, blockSize), null);
  return new BlockReader(source, info, blockSize, resource, store, key, options, true);
}

interface FetchTask {
  start: number;
  length: number;
  first: number;
  count: number;
  background: boolean;
  controller: AbortController;
}

interface Pending {
  promise: Promise<Uint8Array>;
  resolve(data: Uint8Array): void;
  reject(error: unknown): void;
}

class BlockReader implements ByteReader {
  readonly size: number;
  private readonly blockCount: number;
  private readonly memoryBytes: number;
  private readonly readAheadBytes: number;
  private readonly maxRequestBytes: number;
  private readonly memory = new Map<number, Uint8Array>();
  private memoryUsed = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: FetchTask[] = [];
  private running: FetchTask | null = null;
  private readonly closer = new AbortController();
  private closed = false;

  constructor(
    private readonly source: ByteSource,
    readonly info: SourceInfo,
    private readonly blockSize: number,
    private readonly resource: StoredResource | null,
    private readonly store: ByteStore | null,
    private readonly key: string | undefined,
    options: ReaderOptions,
    private sourceOpen: boolean,
  ) {
    this.size = info.size;
    this.blockCount = blockCountOf(info.size, blockSize);
    this.memoryBytes = Math.max(options.memoryBytes ?? DEFAULT_MEMORY_BYTES, blockSize);
    this.readAheadBytes = Math.min(options.readAheadBytes ?? DEFAULT_READ_AHEAD_BYTES, this.memoryBytes / 2);
    const maxRequest = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.maxRequestBytes = Math.max(blockSize, Math.floor(maxRequest / blockSize) * blockSize);
    options.signal?.addEventListener('abort', () => this.close());
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.throwIfClosed();
    const end = Math.min(offset + length, this.size);
    if (offset >= end || length <= 0) return new Uint8Array(0);
    const first = Math.floor(offset / this.blockSize);
    const last = Math.floor((end - 1) / this.blockSize);

    this.ensure(first, last, false, signal);
    if (first === last) {
      const block = await this.awaitBlock(first, signal);
      this.readAhead(end);
      const from = offset - first * this.blockSize;
      return block.subarray(from, from + (end - offset));
    }

    const out = new Uint8Array(end - offset);
    for (let index = first; index <= last; index++) {
      const block = await this.awaitBlock(index, signal);
      const blockStart = index * this.blockSize;
      const from = Math.max(offset, blockStart) - blockStart;
      const to = Math.min(end, blockStart + block.byteLength) - blockStart;
      out.set(block.subarray(from, to), blockStart + from - offset);
    }
    this.readAhead(end);
    return out;
  }

  prefetch(offset: number, length: number): void {
    if (this.closed) return;
    const end = Math.min(offset + length, this.size);
    if (offset >= end) return;
    this.ensure(Math.floor(offset / this.blockSize), Math.floor((end - 1) / this.blockSize), true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closer.abort();
    for (const task of this.queue) task.controller.abort();
    this.running?.controller.abort();
    this.queue.length = 0;
    for (const pending of this.pending.values()) pending.reject(abortError());
    this.pending.clear();
    this.memory.clear();
    this.memoryUsed = 0;
    this.resource?.close();
    this.source.close?.();
  }

  /** Starts loading every block in first..last that isn't in memory or already on its way. */
  private ensure(first: number, last: number, background: boolean, signal?: AbortSignal): void {
    if (!background) this.promote(first, last);
    let runStart = -1;
    const flush = (runEnd: number) => {
      if (runStart < 0) return;
      this.queueFetch(runStart, runEnd, background, signal);
      runStart = -1;
    };
    for (let index = first; index <= last; index++) {
      if (this.memory.has(index) || this.pending.has(index)) {
        flush(index - 1);
        continue;
      }
      if (this.resource?.has(index)) {
        flush(index - 1);
        this.loadStored(index);
        continue;
      }
      if (runStart < 0) runStart = index;
    }
    flush(last);
  }

  private loadStored(index: number): void {
    const pending = this.track(index);
    this.resource!
      .read(index)
      .catch(() => null)
      .then((data) => {
        if (this.pending.get(index) !== pending) return;
        if (data && data.byteLength === this.blockLength(index)) {
          this.pending.delete(index);
          this.remember(index, data);
          pending.resolve(data);
          return;
        }
        this.pending.delete(index);
        this.queueFetch(index, index, false);
        this.pending.get(index)!.promise.then(pending.resolve, pending.reject);
      });
  }

  /** Queues source reads for blocks first..last, split at maxRequestBytes. */
  private queueFetch(first: number, last: number, background: boolean, signal?: AbortSignal): void {
    if (!background) this.abortBackground();
    const blocksPerRequest = this.maxRequestBytes / this.blockSize;
    for (let start = first; start <= last; start += blocksPerRequest) {
      const count = Math.min(blocksPerRequest, last - start + 1);
      const task: FetchTask = {
        start: start * this.blockSize,
        length: Math.min(count * this.blockSize, this.size - start * this.blockSize),
        first: start,
        count,
        background,
        controller: new AbortController(),
      };
      if (signal) {
        if (signal.aborted) task.controller.abort();
        else signal.addEventListener('abort', () => task.controller.abort(), { once: true });
      }
      for (let index = start; index < start + count; index++) this.track(index);
      this.queue.push(task);
    }
    this.pump();
  }

  private pump(): void {
    if (this.running || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    this.running = task;
    this.runTask(task).finally(() => {
      if (this.running === task) this.running = null;
      this.pump();
    });
  }

  private async runTask(task: FetchTask): Promise<void> {
    try {
      if (task.controller.signal.aborted) throw abortError();
      await this.openSource(task.controller.signal);
      const data = await this.source.read(task.start, task.length, task.controller.signal);
      if (data.byteLength < task.length) {
        throw new Error(`source returned ${data.byteLength} of ${task.length} bytes at ${task.start}`);
      }
      for (let i = 0; i < task.count; i++) {
        const index = task.first + i;
        const from = i * this.blockSize;
        const block = data.slice(from, from + this.blockLength(index));
        this.remember(index, block);
        if (this.resource && !this.closed) this.resource.write(index, block).catch(() => {});
        this.settle(index, (pending) => pending.resolve(block));
      }
    } catch (error) {
      if (error instanceof SourceChangedError && this.store && this.key) {
        this.store.delete(this.key).catch(() => {});
      }
      for (let i = 0; i < task.count; i++) this.settle(task.first + i, (pending) => pending.reject(error));
    }
  }

  /** Opens the source when blocks are needed that the store was expected to hold. */
  private async openSource(signal: AbortSignal): Promise<void> {
    if (this.sourceOpen) return;
    const info = await openSource(this.source, signal);
    if (!sameVersion(info, this.info)) {
      throw new SourceChangedError('the source differs from the copy held in the store');
    }
    this.sourceOpen = true;
  }

  /** Waits for a block, refetching it if the fetch it was waiting on was aborted by someone else. */
  private async awaitBlock(index: number, signal?: AbortSignal): Promise<Uint8Array> {
    for (;;) {
      this.throwIfClosed();
      signal?.throwIfAborted?.();
      const held = this.memory.get(index);
      if (held) {
        this.memory.delete(index);
        this.memory.set(index, held);
        return held;
      }
      const pending = this.pending.get(index);
      if (!pending) {
        this.ensure(index, index, false, signal);
        continue;
      }
      try {
        return await raceAbort(pending.promise, signal);
      } catch (error) {
        if (!isAbort(error) || signal?.aborted || this.closed) throw error;
      }
    }
  }

  /** Fetches past `end` in the background, unless background reads are already going. */
  private readAhead(end: number): void {
    if (this.readAheadBytes <= 0 || this.closed || end >= this.size) return;
    if (this.running?.background || this.queue.some((task) => task.background)) return;
    const first = Math.floor(end / this.blockSize);
    const last = Math.floor((Math.min(this.size, end + this.readAheadBytes) - 1) / this.blockSize);
    let runStart = -1;
    for (let index = first; index <= last; index++) {
      const held = this.memory.has(index) || this.pending.has(index) || this.resource?.has(index);
      if (!held && runStart < 0) runStart = index;
      if (held && runStart >= 0) {
        this.queueFetch(runStart, index - 1, true);
        return;
      }
    }
    if (runStart >= 0) this.queueFetch(runStart, last, true);
  }

  /** Background fetches of blocks a read now waits for become foreground ones, so they aren't aborted. */
  private promote(first: number, last: number): void {
    const overlaps = (task: FetchTask) => task.first <= last && task.first + task.count - 1 >= first;
    if (this.running?.background && overlaps(this.running)) this.running.background = false;
    for (const task of this.queue) {
      if (task.background && overlaps(task)) task.background = false;
    }
  }

  private abortBackground(): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const task = this.queue[i];
      if (!task.background) continue;
      this.queue.splice(i, 1);
      task.controller.abort();
      for (let j = 0; j < task.count; j++) this.settle(task.first + j, (pending) => pending.reject(abortError()));
    }
    if (this.running?.background) this.running.controller.abort();
  }

  private track(index: number): Pending {
    let resolve!: (data: Uint8Array) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Uint8Array>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    const pending = { promise, resolve, reject };
    this.pending.set(index, pending);
    return pending;
  }

  private settle(index: number, action: (pending: Pending) => void): void {
    const pending = this.pending.get(index);
    if (!pending) return;
    this.pending.delete(index);
    action(pending);
  }

  private remember(index: number, block: Uint8Array): void {
    if (this.closed) return;
    const previous = this.memory.get(index);
    if (previous) {
      this.memoryUsed -= previous.byteLength;
      this.memory.delete(index);
    }
    this.memory.set(index, block);
    this.memoryUsed += block.byteLength;
    for (const [oldest, data] of this.memory) {
      if (this.memoryUsed <= this.memoryBytes) break;
      this.memory.delete(oldest);
      this.memoryUsed -= data.byteLength;
    }
  }

  private blockLength(index: number): number {
    return Math.min(this.blockSize, this.size - index * this.blockSize);
  }

  private throwIfClosed(): void {
    if (this.closed) throw abortError();
  }
}

export function blockCountOf(size: number, blockSize: number): number {
  return Math.ceil(size / blockSize);
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The read was aborted', 'AbortError');
  const error = new Error('The read was aborted');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function safely<T>(action: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await action();
  } catch {
    return fallback;
  }
}
