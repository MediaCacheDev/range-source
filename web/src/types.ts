/** A source's length, and what identifies this version of its content. */
export interface SourceInfo {
  /** Total length in bytes. */
  size: number;
  /** ETag, or any string that changes when the content does. */
  etag?: string;
  /** Last-Modified, for sources without an ETag. */
  lastModified?: string;
}

/**
 * Bytes by offset, from anywhere: a URL, a Blob, memory, or an app's own cache or fetcher.
 * Readers call open() once before reading, and read() one call at a time. The smallest source
 * is `{ size, read }`.
 */
export interface ByteSource {
  /** Resolves the source's length and version; without it, size is used. */
  open?(signal?: AbortSignal): Promise<SourceInfo>;
  /** The length, for a source without open(). */
  readonly size?: number;
  /** `length` bytes from `offset`, fewer only where the source ends. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Releases connections or handles. */
  close?(): void;
}

/** What a store holds for a key. */
export interface StoredEntry {
  info: SourceInfo;
  blockSize: number;
  /** Indices of the blocks held. */
  blocks: number[];
}

/**
 * Keeps sources' bytes between plays, in fixed-size blocks, under a byte cap shared by every
 * key in it. Stores are best-effort: a block that has gone missing is fetched again.
 */
export interface ByteStore {
  /** Shown in logs: 'opfs', 'indexeddb', 'cache', 'memory', or a custom store's name. */
  readonly kind: string;
  /** What's held under key, or null. */
  lookup(key: string): Promise<StoredEntry | null>;
  /** Opens key for this version of the source, dropping a different version held under it. */
  open(key: string, info: SourceInfo, blockSize: number): Promise<StoredResource>;
  /** Removes key. */
  delete(key: string): Promise<void>;
  /** Removes every key. */
  clear(): Promise<void>;
}

/** One key in a store, open for reading and writing its blocks. */
export interface StoredResource {
  has(index: number): boolean;
  /** Whether every block of the source is held. */
  readonly complete: boolean;
  /** The block, or null if it has gone missing. */
  read(index: number): Promise<Uint8Array | null>;
  write(index: number, data: Uint8Array): Promise<void>;
  close(): void;
}

export type StorageKind = 'auto' | 'opfs' | 'indexeddb' | 'cache' | 'memory' | 'none';

/** The source's content changed while it was being read, or differs from what's stored. */
export class SourceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceChangedError';
  }
}

/** An HTTP request for the source failed. */
export class HttpSourceError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpSourceError';
  }
}
