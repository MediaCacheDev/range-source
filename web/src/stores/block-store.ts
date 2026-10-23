import type { ByteStore, SourceInfo, StoredEntry, StoredResource } from '../types';
import { sameVersion } from '../version';
import { blockCountOf } from '../block-reader';
import { hashKey } from './opfs';

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
  /** Releases the shared lock other contexts check before evicting the key. */
  unlock: (() => void) | null;
}

/** What one context tells the others sharing a store. */
type PeerMessage =
  | { type: 'block'; key: string; info: SourceInfo; blockSize: number; index: number; length: number; lastUsed: number }
  | { type: 'deleted'; key: string }
  | { type: 'cleared' };

const SAVE_DELAY_MS = 250;

/**
 * A ByteStore over the first backend that works, capped at maxBytes across all its keys.
 * When a block doesn't fit, the least recently used keys that aren't open are removed.
 *
 * With `shareAs`, the store keeps its index in step with stores of the same name in the origin's
 * other contexts (tabs, workers, a Service Worker) on the same backend: each one announces the
 * blocks it writes and the keys it removes, and none evicts a key another has open.
 */
export class BlockStore implements ByteStore {
  private backend: StoreBackend | null = null;
  private ready: Promise<void> | null = null;
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private writes: Promise<void> = Promise.resolve();
  private channel: BroadcastChannel | null = null;
  private lockPrefix = '';

  constructor(
    private readonly backends: Array<() => StoreBackend>,
    public maxBytes: number,
    private readonly shareAs?: string,
  ) {}

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
        unlock: null,
      };
      this.entries.set(key, entry);
    } else if (info.contentType && !entry.record.info.contentType) {
      entry.record.info.contentType = info.contentType;
    }
    if (entry.openCount++ === 0) this.holdOpen(entry);
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
    for (const entry of this.entries.values()) this.forgetEntry(entry);
    this.entries.clear();
    this.totalBytes = 0;
    await this.backend!.clear().catch(() => {});
    this.announce({ type: 'cleared' });
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
          this.entries.set(record.key, { record, blocks, openCount: 0, saveTimer: null, unlock: null });
          this.totalBytes += record.bytes;
        }
        this.share(backend.kind);
        return;
      } catch {
        continue;
      }
    }
    throw new Error('no storage backend is available');
  }

  /** Joins the other contexts' stores of the same name. Memory belongs to one context, so isn't shared. */
  private share(kind: string): void {
    if (!this.shareAs || kind === 'memory') return;
    const name = `range-source:${kind}:${this.shareAs}`;
    this.lockPrefix = name;
    if (typeof BroadcastChannel !== 'function') return;
    const channel = new BroadcastChannel(name);
    channel.onmessage = (event: MessageEvent<PeerMessage>) => this.onPeer(event.data);
    // Node keeps a process alive while a channel listens
    (channel as unknown as { unref?: () => void }).unref?.();
    this.channel = channel;
  }

  private announce(message: PeerMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // Best-effort: a context that misses it reads the backend's index when it next starts
    }
  }

  /** Another context wrote a block or removed keys: the backend already reflects it. */
  private onPeer(message: PeerMessage): void {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'block': {
        let entry = this.entries.get(message.key);
        if (entry && (!sameVersion(entry.record.info, message.info) || entry.record.blockSize !== message.blockSize)) {
          this.dropEntry(entry);
          entry = undefined;
        }
        if (!entry) {
          entry = {
            record: { key: message.key, info: { ...message.info }, blockSize: message.blockSize, blocks: [], bytes: 0, lastUsed: message.lastUsed },
            blocks: new Set(),
            openCount: 0,
            saveTimer: null,
            unlock: null,
          };
          this.entries.set(message.key, entry);
        }
        if (!entry.blocks.has(message.index)) {
          entry.blocks.add(message.index);
          entry.record.bytes += message.length;
          this.totalBytes += message.length;
        }
        entry.record.lastUsed = Math.max(entry.record.lastUsed, message.lastUsed);
        if (message.info.contentType && !entry.record.info.contentType) entry.record.info.contentType = message.info.contentType;
        return;
      }
      case 'deleted': {
        const entry = this.entries.get(message.key);
        if (entry) this.dropEntry(entry);
        return;
      }
      case 'cleared':
        for (const entry of [...this.entries.values()]) this.dropEntry(entry);
        return;
    }
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
        if (--entry.openCount === 0) this.releaseOpen(entry);
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
    if (entry.blocks.has(index)) {
      // Another context stored it meanwhile, and its announcement already counted it
      this.totalBytes -= data.byteLength;
      return;
    }
    entry.blocks.add(index);
    entry.record.bytes += data.byteLength;
    this.scheduleSave(entry);
    const { key, info, blockSize, lastUsed } = entry.record;
    this.announce({ type: 'block', key, info, blockSize, index, length: data.byteLength, lastUsed });
  }

  /** Removes least recently used keys that aren't open, here or elsewhere, until bytes fit; false if they can't. */
  private async makeRoom(bytes: number): Promise<boolean> {
    if (this.totalBytes + bytes <= this.maxBytes) return true;
    return this.withLock(this.lockPrefix, 'exclusive', false, async () => {
      while (this.totalBytes + bytes > this.maxBytes) {
        const candidates = [...this.entries.values()]
          .filter((entry) => entry.openCount === 0)
          .sort((a, b) => a.record.lastUsed - b.record.lastUsed);
        let evicted = false;
        for (const entry of candidates) {
          if (await this.evict(entry)) {
            evicted = true;
            break;
          }
        }
        if (!evicted) return false;
      }
      return true;
    });
  }

  /** Removes the entry unless another context has it open. */
  private evict(entry: Entry): Promise<boolean> {
    return this.withLock(this.keyLock(entry.record.key), 'exclusive', true, async (granted) => {
      if (!granted || this.entries.get(entry.record.key) !== entry || entry.openCount > 0) return false;
      await this.remove(entry);
      return true;
    });
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
    this.dropEntry(entry);
    await this.backend!.deleteEntry(snapshot(entry)).catch(() => {});
    this.announce({ type: 'deleted', key: entry.record.key });
  }

  /** Takes the entry out of the index, leaving the backend as it is. */
  private dropEntry(entry: Entry): void {
    if (this.entries.get(entry.record.key) !== entry) return;
    this.entries.delete(entry.record.key);
    this.totalBytes -= entry.record.bytes;
    this.forgetEntry(entry);
  }

  private forgetEntry(entry: Entry): void {
    if (entry.saveTimer) clearTimeout(entry.saveTimer);
    entry.saveTimer = null;
    this.releaseOpen(entry);
  }

  private holdOpen(entry: Entry): void {
    const locks = webLocks();
    if (!locks || !this.lockPrefix) return;
    const held = new Promise<void>((resolve) => (entry.unlock = resolve));
    locks.request(this.keyLock(entry.record.key), { mode: 'shared' }, () => held).catch(() => {});
  }

  private releaseOpen(entry: Entry): void {
    entry.unlock?.();
    entry.unlock = null;
  }

  private keyLock(key: string): string {
    return `${this.lockPrefix}:${hashKey(key)}`;
  }

  /** Runs work under a Web Lock when the store is shared and the context has them, else straight away. */
  private async withLock<T>(
    name: string,
    mode: 'shared' | 'exclusive',
    ifAvailable: boolean,
    work: (granted: boolean) => Promise<T>,
  ): Promise<T> {
    const locks = webLocks();
    if (!locks || !this.lockPrefix) return work(true);
    return locks.request(name, { mode, ifAvailable }, (lock) => work(lock !== null)) as Promise<T>;
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

function webLocks(): LockManager | null {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  return locks && typeof locks.request === 'function' ? locks : null;
}
