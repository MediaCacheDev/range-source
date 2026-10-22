import type { EntryRecord, StoreBackend } from './block-store';

const ENTRIES = 'entries';
const BLOCKS = 'blocks';

/** Blocks in IndexedDB, in the database `range-source-<namespace>`. */
export function indexedDbBackend(namespace: string): StoreBackend {
  const name = `range-source-${namespace}`;
  let db: IDBDatabase | null = null;

  const transaction = <T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => IDBRequest<T> | void,
  ): Promise<T | undefined> =>
    new Promise((resolve, reject) => {
      const tx = db!.transaction(stores, mode);
      const request = work(tx);
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });

  return {
    kind: 'indexeddb',
    async init() {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
      db = await openDatabase(name);
      db.onversionchange = () => db?.close();
      const records = await transaction<EntryRecord[]>([ENTRIES], 'readonly', (tx) => tx.objectStore(ENTRIES).getAll());
      return records ?? [];
    },
    async saveEntry(record) {
      await transaction([ENTRIES], 'readwrite', (tx) => {
        tx.objectStore(ENTRIES).put(record);
      });
    },
    async deleteEntry(record) {
      await transaction([ENTRIES, BLOCKS], 'readwrite', (tx) => {
        tx.objectStore(ENTRIES).delete(record.key);
        tx.objectStore(BLOCKS).delete(IDBKeyRange.bound([record.key, 0], [record.key, Infinity]));
      });
    },
    async readBlock(key, index) {
      const row = await transaction<{ data: ArrayBuffer } | undefined>([BLOCKS], 'readonly', (tx) =>
        tx.objectStore(BLOCKS).get([key, index]),
      );
      return row ? new Uint8Array(row.data) : null;
    },
    async writeBlock(key, index, data) {
      const buffer = ownBuffer(data);
      await transaction([BLOCKS], 'readwrite', (tx) => {
        tx.objectStore(BLOCKS).put({ key, index, data: buffer });
      });
    },
    async clear() {
      await transaction([ENTRIES, BLOCKS], 'readwrite', (tx) => {
        tx.objectStore(ENTRIES).clear();
        tx.objectStore(BLOCKS).clear();
      });
    },
  };
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(BLOCKS)) db.createObjectStore(BLOCKS, { keyPath: ['key', 'index'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked by another tab`));
  });
}

/** The block as its own ArrayBuffer; storing a view would store the whole buffer behind it. */
function ownBuffer(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer) {
    return data.buffer;
  }
  return data.slice().buffer as ArrayBuffer;
}
