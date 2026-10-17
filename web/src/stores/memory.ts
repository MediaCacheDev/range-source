import type { EntryRecord, StoreBackend } from './block-store';

interface Held {
  record: EntryRecord;
  blocks: Map<number, Uint8Array>;
}

const namespaces = new Map<string, Map<string, Held>>();

/** Blocks in this page's memory, gone on reload. Stores with the same namespace share them. */
export function memoryBackend(namespace: string): StoreBackend {
  let held = namespaces.get(namespace);
  if (!held) {
    held = new Map();
    namespaces.set(namespace, held);
  }
  const entries = held;
  const entryFor = (key: string) => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { record: { key, info: { size: 0 }, blockSize: 0, blocks: [], bytes: 0, lastUsed: 0 }, blocks: new Map() };
      entries.set(key, entry);
    }
    return entry;
  };
  return {
    kind: 'memory',
    async init() {
      return [...entries.values()].filter((entry) => entry.record.blockSize > 0).map((entry) => ({ ...entry.record }));
    },
    async saveEntry(record) {
      entryFor(record.key).record = { ...record };
    },
    async deleteEntry(record) {
      entries.delete(record.key);
    },
    async readBlock(key, index) {
      return entries.get(key)?.blocks.get(index) ?? null;
    },
    async writeBlock(key, index, data) {
      entryFor(key).blocks.set(index, data);
    },
    async clear() {
      entries.clear();
    },
  };
}
