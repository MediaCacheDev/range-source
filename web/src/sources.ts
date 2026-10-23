import type { ByteSource, SourceInfo } from './types';

/** A source over bytes already in memory. Reads are views, not copies. */
export function memorySource(data: ArrayBuffer | Uint8Array): ByteSource {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return {
    async open() {
      return { size: bytes.byteLength };
    },
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(offset + length, bytes.byteLength));
    },
  };
}

/** A source over a Blob or File, read a slice at a time. */
export function blobSource(blob: Blob): ByteSource {
  return {
    async open(): Promise<SourceInfo> {
      const file = blob as Partial<File>;
      return {
        size: blob.size,
        lastModified: file.lastModified !== undefined ? String(file.lastModified) : undefined,
        contentType: blob.type || undefined,
      };
    },
    async read(offset, length) {
      const slice = blob.slice(offset, Math.min(offset + length, blob.size));
      return new Uint8Array(await slice.arrayBuffer());
    },
  };
}

/** Whether value looks like a ByteSource. */
export function isByteSource(value: unknown): value is ByteSource {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as ByteSource;
  return typeof source.read === 'function' && (typeof source.open === 'function' || typeof source.size === 'number');
}

/** The source's info, from open() or its size. */
export async function openSource(source: ByteSource, signal?: AbortSignal): Promise<SourceInfo> {
  if (source.open) return source.open(signal);
  if (typeof source.size !== 'number') throw new TypeError('a ByteSource needs open() or a size');
  return { size: source.size };
}
