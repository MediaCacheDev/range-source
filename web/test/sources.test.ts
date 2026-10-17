import { describe, expect, it } from 'vitest';
import { blobSource, isByteSource, memorySource } from '../src';
import { expectSlice, pattern } from './helpers';

describe('memorySource', () => {
  it('reads slices and stops at the end', async () => {
    const data = pattern(1000);
    const source = memorySource(data);
    expect(await source.open()).toEqual({ size: 1000 });
    expectSlice(await source.read(10, 100), data, 10, 100);
    expect((await source.read(950, 100)).byteLength).toBe(50);
    expect((await source.read(1000, 10)).byteLength).toBe(0);
  });
});

describe('blobSource', () => {
  it('reads slices of a Blob', async () => {
    const data = pattern(5000);
    const source = blobSource(new Blob([data]));
    expect((await source.open()).size).toBe(5000);
    expectSlice(await source.read(4000, 2000), data, 4000, 2000);
  });
});

describe('isByteSource', () => {
  it('recognises sources and nothing else', () => {
    expect(isByteSource(memorySource(new Uint8Array(1)))).toBe(true);
    expect(isByteSource({ size: 10, read: async () => new Uint8Array(0) })).toBe(true);
    expect(isByteSource({ read: async () => new Uint8Array(0) })).toBe(false);
    expect(isByteSource('https://example.com/a.ktx2')).toBe(false);
    expect(isByteSource(new Blob([]))).toBe(false);
    expect(isByteSource(null)).toBe(false);
  });
});
