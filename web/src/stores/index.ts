import type { ByteStore, StorageKind } from '../types';
import { BlockStore, type StoreBackend } from './block-store';
import { cacheApiBackend } from './cache-api';
import { indexedDbBackend } from './indexeddb';
import { memoryBackend } from './memory';
import { opfsBackend } from './opfs';

export interface StoreOptions {
  /** Keeps one player's (or app's) storage apart from another's. */
  namespace: string;
  /** Cap across every key in the namespace. Default 512 MiB. */
  maxBytes?: number;
}

export const DEFAULT_MAX_STORAGE_BYTES = 512 * 1024 * 1024;

const stores = new Map<string, BlockStore>();

/**
 * The store for a storage kind, or null for 'none'. A ByteStore is passed through.
 *
 * Backends that aren't available fall back: 'auto' and 'opfs' to IndexedDB, then memory;
 * 'cache' to IndexedDB, then memory; 'indexeddb' to memory. Stores are shared per kind and
 * namespace within a page, so every player in it counts against the same cap.
 */
export function createStore(kind: StorageKind | ByteStore, options: StoreOptions): ByteStore | null {
  if (typeof kind === 'object') return kind;
  if (kind === 'none') return null;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_STORAGE_BYTES;
  const id = `${kind}:${options.namespace}`;
  let store = stores.get(id);
  if (!store) {
    store = new BlockStore(backendsFor(kind, options.namespace), maxBytes);
    stores.set(id, store);
  }
  store.maxBytes = maxBytes;
  return store;
}

function backendsFor(kind: Exclude<StorageKind, 'none'>, namespace: string): Array<() => StoreBackend> {
  const memory = () => memoryBackend(namespace);
  const indexedDb = () => indexedDbBackend(namespace);
  switch (kind) {
    case 'memory':
      return [memory];
    case 'indexeddb':
      return [indexedDb, memory];
    case 'cache':
      return [() => cacheApiBackend(namespace), indexedDb, memory];
    case 'opfs':
    case 'auto':
      return [() => opfsBackend(namespace), indexedDb, memory];
  }
}

export { BlockStore } from './block-store';
export type { EntryRecord, StoreBackend } from './block-store';
export { memoryBackend } from './memory';
export { indexedDbBackend } from './indexeddb';
export { opfsBackend, opfsSupported } from './opfs';
export { cacheApiBackend } from './cache-api';
