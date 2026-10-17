import type { EntryRecord, StoreBackend } from './block-store';

const ROOT = 'alpha-video-source';
const META = 'meta.json';

/**
 * Blocks in the origin private file system, at `alpha-video-source/<namespace>/<hash of key>/`,
 * one file per block plus meta.json. One file per block because createWritable() writes a whole
 * file to a swap copy on every close, which makes appending to one big file slow.
 */
export function opfsBackend(namespace: string): StoreBackend {
  let root: FileSystemDirectoryHandle | null = null;
  let dir: FileSystemDirectoryHandle | null = null;

  const entryDir = (key: string, create: boolean) => dir!.getDirectoryHandle(hashKey(key), { create });

  return {
    kind: 'opfs',
    async init() {
      if (!opfsSupported()) throw new Error('OPFS with createWritable is not available');
      root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
      dir = await root.getDirectoryHandle(namespace, { create: true });
      const records: EntryRecord[] = [];
      for await (const [name, handle] of directoryEntries(dir)) {
        if (handle.kind !== 'directory') continue;
        const record = await readMeta(handle as FileSystemDirectoryHandle);
        if (record && hashKey(record.key) === name) records.push(record);
        else await dir.removeEntry(name, { recursive: true }).catch(() => {});
      }
      return records;
    },
    async saveEntry(record) {
      await writeFile(await entryDir(record.key, true), META, new TextEncoder().encode(JSON.stringify(record)));
    },
    async deleteEntry(record) {
      await dir!.removeEntry(hashKey(record.key), { recursive: true }).catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'NotFoundError') throw error;
      });
    },
    async readBlock(key, index) {
      try {
        const file = await (await (await entryDir(key, false)).getFileHandle(String(index))).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        return null;
      }
    },
    async writeBlock(key, index, data) {
      await writeFile(await entryDir(key, true), String(index), data);
    },
    async clear() {
      await root!.removeEntry(namespace, { recursive: true }).catch(() => {});
      dir = await root!.getDirectoryHandle(namespace, { create: true });
    },
  };
}

/** Whether OPFS can be written from this thread with createWritable. */
export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable === 'function'
  );
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  try {
    await writable.write(data as unknown as BufferSource);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function readMeta(dir: FileSystemDirectoryHandle): Promise<EntryRecord | null> {
  try {
    const file = await (await dir.getFileHandle(META)).getFile();
    const record = JSON.parse(await file.text()) as EntryRecord;
    return typeof record.key === 'string' && Array.isArray(record.blocks) ? record : null;
  } catch {
    return null;
  }
}

function directoryEntries(dir: FileSystemDirectoryHandle): AsyncIterable<[string, FileSystemHandle]> {
  return (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
}

/** A file-name-safe 106-bit hash of the key (two 53-bit cyrb53 hashes). */
export function hashKey(key: string): string {
  return cyrb53(key, 0).toString(36) + '-' + cyrb53(key, 0x9e3779b9).toString(36);
}

function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
