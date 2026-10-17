import type { ByteStore, SourceInfo, StoredEntry, StoredResource } from '../types';
import { sameVersion } from '../version';
import { blockCountOf } from '../block-reader';

/** What a backend keeps per key, besides the blocks. */
export interface EntryRecord {
  key: string;
  info: SourceInfo;
  blockSize: number;
  blocks: number[];
  bytes: number;
  lastUsed: number;
}

/** Where a store's blocks and entries live. Every method may throw; the store treats that as "not stored". */
export interface StoreBackend {
  readonly kind: string;
  /** Prepares the backend and returns every entry it holds. Throws if the backend can't be used here. */
  init(): Promise<EntryRecord[]>;
  saveEntry(entry: EntryRecord): Promise<void>;
  /** Removes the entry and its blocks. */
  deleteEntry(entry: EntryRecord): Promise<void>;
  readBlock(key: string, index: number): Promise<Uint8Array | null>;
  writeBlock(key: string, index: number, data: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

interface Entry {
  record: EntryRecord;
  blocks: Set<number>;
  openCount: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
}

const SAVE_DELAY_MS = 250;

/**
 * A ByteStore over the first backend that works, capped at maxBytes across all its keys.
 * When a block doesn't fit, the least recently used keys that aren't open are removed.
 */
export class BlockStore implements ByteStore {
  private backend: StoreBackend | null = null;
  private ready: Promise<void> | null = null;
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly backends: Array<() => StoreBackend>, public maxBytes: number) {}

  get kind(): string {
    return this.backend?.kind ?? 'pending';
  }

  /** Bytes held across every key. */
  async usage(): Promise<number> {
    await this.init();
    return this.totalBytes;
  }

  async lookup(key: string): Promise<StoredEntry | null> {
    await this.init();
    const entry = this.entries.get(key);
    if (!entry) return null;
    return { info: { ...entry.record.info }, blockSize: entry.record.blockSize, blocks: [...entry.blocks] };
  }

  async open(key: string, info: SourceInfo, blockSize: number): Promise<StoredResource> {
    await this.init();
    let entry = this.entries.get(key);
    if (entry && (!sameVersion(entry.record.info, info) || entry.record.blockSize !== blockSize)) {
      await this.remove(entry);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        record: { key, info: { ...info }, blockSize, blocks: [], bytes: 0, lastUsed: Date.now() },
        blocks: new Set(),
        openCount: 0,
        saveTimer: null,
      };
      this.entries.set(key, entry);
    }
    entry.openCount++;
    entry.record.lastUsed = Date.now();
    this.scheduleSave(entry);
    return this.resourceFor(entry);
  }

  async delete(key: string): Promise<void> {
    await this.init();
    const entry = this.entries.get(key);
    if (entry) await this.remove(entry);
  }

  async clear(): Promise<void> {
    await this.init();
    for (const entry of this.entries.values()) {
      if (entry.saveTimer) clearTimeout(entry.saveTimer);
    }
    this.entries.clear();
    this.totalBytes = 0;
    await this.backend!.clear().catch(() => {});
  }

  private init(): Promise<void> {
    if (!this.ready) this.ready = this.start();
    return this.ready;
  }

  private async start(): Promise<void> {
    for (const create of this.backends) {
      let backend: StoreBackend;
      try {
        backend = create();
        const records = await backend.init();
        this.backend = backend;
        for (const record of records) {
          const blocks = new Set(record.blocks);
          this.entries.set(record.key, { record, blocks, openCount: 0, saveTimer: null });
          this.totalBytes += record.bytes;
        }
        return;
      } catch {
        continue;
      }
    }
    throw new Error('no storage backend is available');
  }

  private resourceFor(entry: Entry): StoredResource {
    const blockCount = blockCountOf(entry.record.info.size, entry.record.blockSize);
    let closed = false;
    const live = () => !closed && this.entries.get(entry.record.key) === entry;
    return {
      has: (index) => entry.blocks.has(index),
      get complete() {
        return entry.blocks.size === blockCount;
      },
      read: async (index) => {
        if (!entry.blocks.has(index)) return null;
        const data = await this.backend!.readBlock(entry.record.key, index).catch(() => null);
        if (!data && live()) this.forget(entry, index);
        return data;
      },
      write: (index, data) => {
        if (!live() || entry.blocks.has(index)) return Promise.resolve();
        return this.queueWrite(entry, index, data);
      },
      close: () => {
        if (closed) return;
        closed = true;
        entry.openCount--;
        this.flushSave(entry);
      },
    };
  }

  private queueWrite(entry: Entry, index: number, data: Uint8Array): Promise<void> {
    const write = this.writes.then(() => this.write(entry, index, data));
    this.writes = write.catch(() => {});
    return write;
  }

  private async write(entry: Entry, index: number, data: Uint8Array): Promise<void> {
    if (this.entries.get(entry.record.key) !== entry || entry.blocks.has(index)) return;
    if (!(await this.makeRoom(data.byteLength))) return;
    this.totalBytes += data.byteLength;
    try {
      await this.backend!.writeBlock(entry.record.key, index, data);
    } catch (error) {
      this.totalBytes -= data.byteLength;
      throw error;
    }
    if (this.entries.get(entry.record.key) !== entry) {
      this.totalBytes -= data.byteLength;
      if (!this.entries.has(entry.record.key)) await this.backend!.deleteEntry(snapshot(entry)).catch(() => {});
      return;
    }
    entry.blocks.add(index);
    entry.record.bytes += data.byteLength;
    this.scheduleSave(entry);
  }

  /** Removes least recently used keys that aren't open until bytes fit; false if they can't. */
  private async makeRoom(bytes: number): Promise<boolean> {
    if (this.totalBytes + bytes <= this.maxBytes) return true;
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.openCount === 0)
      .sort((a, b) => a.record.lastUsed - b.record.lastUsed);
    for (const entry of candidates) {
      await this.remove(entry);
      if (this.totalBytes + bytes <= this.maxBytes) return true;
    }
    return false;
  }

  private forget(entry: Entry, index: number): void {
    if (!entry.blocks.delete(index)) return;
    const length = Math.min(entry.record.blockSize, entry.record.info.size - index * entry.record.blockSize);
    entry.record.bytes -= length;
    this.totalBytes -= length;
    this.scheduleSave(entry);
  }

  private async remove(entry: Entry): Promise<void> {
    if (this.entries.get(entry.record.key) !== entry) return;
    this.entries.delete(entry.record.key);
    if (entry.saveTimer) clearTimeout(entry.saveTimer);
    entry.saveTimer = null;
    this.totalBytes -= entry.record.bytes;
    await this.backend!.deleteEntry(snapshot(entry)).catch(() => {});
  }

  private scheduleSave(entry: Entry): void {
    if (entry.saveTimer) return;
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null;
      this.save(entry);
    }, SAVE_DELAY_MS);
  }

  private flushSave(entry: Entry): void {
    if (!entry.saveTimer) return;
    clearTimeout(entry.saveTimer);
    entry.saveTimer = null;
    this.save(entry);
  }

  private save(entry: Entry): void {
    this.writes = this.writes
      .then(() => (this.entries.get(entry.record.key) === entry ? this.backend!.saveEntry(snapshot(entry)) : undefined))
      .catch(() => {});
  }
}

function snapshot(entry: Entry): EntryRecord {
  return { ...entry.record, info: { ...entry.record.info }, blocks: [...entry.blocks].sort((a, b) => a - b) };
}
