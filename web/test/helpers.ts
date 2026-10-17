import type { ByteSource, SourceInfo } from '../src/types';

/** Bytes where byte i is a function of i, so any slice can be checked. */
export function pattern(size: number, seed = 0): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + (i >>> 8) * 7 + seed) & 0xff;
  return data;
}

export function expectSlice(actual: Uint8Array, source: Uint8Array, offset: number, length: number): void {
  const expected = source.subarray(offset, Math.min(offset + length, source.byteLength));
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`expected ${expected.byteLength} bytes at ${offset}, got ${actual.byteLength}`);
  }
  for (let i = 0; i < expected.byteLength; i++) {
    if (actual[i] !== expected[i]) throw new Error(`byte ${offset + i}: expected ${expected[i]}, got ${actual[i]}`);
  }
}

/** A memory source that records its calls and can be slowed down or changed. */
export class CountingSource implements ByteSource {
  opens = 0;
  reads: Array<{ offset: number; length: number }> = [];
  delayMs = 0;
  info: SourceInfo;

  constructor(public data: Uint8Array, info: Partial<SourceInfo> = {}) {
    this.info = { size: data.byteLength, etag: '"v1"', ...info };
  }

  async open(): Promise<SourceInfo> {
    this.opens++;
    return { ...this.info };
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.reads.push({ offset, length });
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    signal?.throwIfAborted();
    return this.data.slice(offset, Math.min(offset + length, this.data.byteLength));
  }
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
