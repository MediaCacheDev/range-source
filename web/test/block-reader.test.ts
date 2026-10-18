import { describe, expect, it } from 'vitest';
import { BlockStore, memoryBackend, openReader, SourceChangedError } from '../src';
import { CountingSource, expectSlice, pattern, tick } from './helpers';

const KB = 1024;
let namespaceCounter = 0;
const freshStore = (maxBytes = 64 * 1024 * KB) => new BlockStore([() => memoryBackend(`reader-${namespaceCounter++}`)], maxBytes);

describe('openReader without a store', () => {
  it('reads across blocks, fetching each run of missing blocks with one source read', async () => {
    const data = pattern(1000 * KB);
    const source = new CountingSource(data);
    const reader = await openReader(source, { blockSize: 64 * KB, readAheadBytes: 0 });
    expect(reader.size).toBe(data.byteLength);
    expectSlice(await reader.read(10 * KB, 200 * KB), data, 10 * KB, 200 * KB);
    expect(source.reads).toEqual([{ offset: 0, length: 256 * KB }]);
    expectSlice(await reader.read(100 * KB, 10 * KB), data, 100 * KB, 10 * KB);
    expect(source.reads.length).toBe(1);
    expectSlice(await reader.read(990 * KB, 100 * KB), data, 990 * KB, 100 * KB);
    expect(source.reads[1]).toEqual({ offset: 960 * KB, length: 40 * KB });
    reader.close();
  });

  it('peeks at bytes held in memory, up to the end of their block, without waiting', async () => {
    const data = pattern(300 * KB);
    const source = new CountingSource(data);
    const reader = await openReader(source, { blockSize: 64 * KB, readAheadBytes: 0 });
    expect(reader.peek(10, 100)).toBeNull();
    expect(source.reads.length).toBe(0);
    await reader.read(10, 1);
    expectSlice(reader.peek(10, 100)!, data, 10, 100);
    expectSlice(reader.peek(60 * KB, 10 * KB)!, data, 60 * KB, 4 * KB);
    expect(reader.peek(64 * KB, 1)).toBeNull();
    expect(reader.peek(300 * KB, 10)!.byteLength).toBe(0);
    expect(source.reads.length).toBe(1);
    reader.close();
    expect(() => reader.peek(10, 1)).toThrow();
  });

  it('reads ahead from a peek', async () => {
    const data = pattern(1000 * KB);
    const source = new CountingSource(data);
    const reader = await openReader(source, { blockSize: 64 * KB, readAheadBytes: 128 * KB });
    await reader.read(0, 1);
    await tick(5);
    expect(source.reads).toEqual([
      { offset: 0, length: 64 * KB },
      { offset: 64 * KB, length: 128 * KB },
    ]);
    expect(reader.peek(64 * KB, 1)).not.toBeNull();
    await tick(5);
    expect(source.reads[2]).toEqual({ offset: 192 * KB, length: 64 * KB });
    reader.close();
  });

  it('splits big runs at maxRequestBytes', async () => {
    const data = pattern(1000 * KB);
    const source = new CountingSource(data);
    const reader = await openReader(source, { blockSize: 64 * KB, maxRequestBytes: 256 * KB, readAheadBytes: 0 });
    expectSlice(await reader.read(0, 1000 * KB), data, 0, 1000 * KB);
    expect(source.reads.map((r) => r.offset)).toEqual([0, 256 * KB, 512 * KB, 768 * KB]);
    reader.close();
  });

  it('reads ahead in the background, and a read that needs those blocks waits for them', async () => {
    const data = pattern(2000 * KB);
    const source = new CountingSource(data);
    source.delayMs = 20;
    const reader = await openReader(source, { blockSize: 64 * KB, readAheadBytes: 256 * KB });
    await reader.read(0, 64 * KB);
    expect(source.reads).toEqual([
      { offset: 0, length: 64 * KB },
      { offset: 64 * KB, length: 256 * KB },
    ]);
    expectSlice(await reader.read(64 * KB, 256 * KB), data, 64 * KB, 256 * KB);
    expect(source.reads.length).toBe(3);
    expect(source.reads[2]).toEqual({ offset: 320 * KB, length: 256 * KB });
    reader.close();
  });

  it('abandons read-ahead for a read elsewhere', async () => {
    const data = pattern(4000 * KB);
    const source = new CountingSource(data);
    source.delayMs = 30;
    const reader = await openReader(source, { blockSize: 64 * KB, readAheadBytes: 1024 * KB });
    await reader.read(0, 64 * KB);
    await tick(5);
    expectSlice(await reader.read(3000 * KB, 64 * KB), data, 3000 * KB, 64 * KB);
    expectSlice(await reader.read(64 * KB, 64 * KB), data, 64 * KB, 64 * KB);
    reader.close();
  });

  it('keeps at most memoryBytes of blocks', async () => {
    const data = pattern(1024 * KB);
    const source = new CountingSource(data);
    const reader = await openReader(source, { blockSize: 64 * KB, memoryBytes: 128 * KB, readAheadBytes: 0 });
    await reader.read(0, 64 * KB);
    await reader.read(64 * KB, 64 * KB);
    await reader.read(128 * KB, 64 * KB);
    await reader.read(0, 64 * KB);
    expect(source.reads.length).toBe(4);
    reader.close();
  });

  it('reads a source that has only a size and read()', async () => {
    const data = pattern(100 * KB);
    const reader = await openReader({ size: data.byteLength, read: async (o, l) => data.slice(o, o + l) }, { blockSize: 64 * KB });
    expectSlice(await reader.read(60 * KB, 10 * KB), data, 60 * KB, 10 * KB);
    reader.close();
  });

  it('fails reads after close', async () => {
    const reader = await openReader(new CountingSource(pattern(100)), {});
    reader.close();
    await expect(reader.read(0, 10)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts a read', async () => {
    const source = new CountingSource(pattern(1000 * KB));
    source.delayMs = 50;
    const reader = await openReader(source, { blockSize: 64 * KB, readAheadBytes: 0 });
    const controller = new AbortController();
    const read = reader.read(0, 500 * KB, controller.signal);
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expectSlice(await reader.read(0, 10), source.data, 0, 10);
    reader.close();
  });
});

describe('openReader with a store', () => {
  it('stores blocks, and plays a complete copy without opening the source', async () => {
    const data = pattern(300 * KB);
    const store = freshStore();
    const first = new CountingSource(data);
    const reader = await openReader(first, { store, key: 'clip', blockSize: 64 * KB, readAheadBytes: 0 });
    await reader.read(0, data.byteLength);
    await tick(10);
    reader.close();
    expect((await store.lookup('clip'))!.blocks).toEqual([0, 1, 2, 3, 4]);

    const second = new CountingSource(data);
    const again = await openReader(second, { store, key: 'clip', blockSize: 64 * KB });
    expectSlice(await again.read(0, data.byteLength), data, 0, data.byteLength);
    expect(second.opens).toBe(0);
    expect(second.reads.length).toBe(0);
    again.close();
  });

  it('fills in the blocks a partial copy is missing', async () => {
    const data = pattern(300 * KB);
    const store = freshStore();
    const reader = await openReader(new CountingSource(data), { store, key: 'clip', blockSize: 64 * KB, readAheadBytes: 0 });
    await reader.read(0, 100 * KB);
    await tick(10);
    reader.close();

    const source = new CountingSource(data);
    const again = await openReader(source, { store, key: 'clip', blockSize: 64 * KB, readAheadBytes: 0 });
    expectSlice(await again.read(0, data.byteLength), data, 0, data.byteLength);
    expect(source.opens).toBe(1);
    expect(source.reads).toEqual([{ offset: 128 * KB, length: 172 * KB }]);
    again.close();
  });

  it('drops a copy of a different version', async () => {
    const store = freshStore();
    const reader = await openReader(new CountingSource(pattern(100 * KB), { etag: '"v1"' }), {
      store,
      key: 'clip',
      blockSize: 64 * KB,
      readAheadBytes: 0,
    });
    await reader.read(0, 10 * KB);
    await tick(10);
    reader.close();

    const changed = pattern(100 * KB, 9);
    const source = new CountingSource(changed, { etag: '"v2"' });
    const again = await openReader(source, { store, key: 'clip', blockSize: 64 * KB, readAheadBytes: 0 });
    expectSlice(await again.read(0, 10 * KB), changed, 0, 10 * KB);
    expect(source.reads.length).toBe(1);
    again.close();
  });

  describe('when a block of a complete copy has gone missing', () => {
    const storeMissingBlock1 = async (data: Uint8Array) => {
      const namespace = `missing-${namespaceCounter++}`;
      let dropBlock1 = false;
      const backend = () => {
        const inner = memoryBackend(namespace);
        return { ...inner, readBlock: (key: string, index: number) => (dropBlock1 && index === 1 ? Promise.resolve(null) : inner.readBlock(key, index)) };
      };
      const store = new BlockStore([backend], 64 * 1024 * KB);
      const reader = await openReader(new CountingSource(data), { store, key: 'clip', blockSize: 64 * KB });
      await reader.read(0, data.byteLength);
      await tick(10);
      reader.close();
      dropBlock1 = true;
      return store;
    };

    it('opens the source and fetches just that block', async () => {
      const data = pattern(192 * KB);
      const store = await storeMissingBlock1(data);
      const source = new CountingSource(data);
      const reader = await openReader(source, { store, key: 'clip', blockSize: 64 * KB, readAheadBytes: 0 });
      expect(source.opens).toBe(0);
      expectSlice(await reader.read(0, data.byteLength), data, 0, data.byteLength);
      expect(source.opens).toBe(1);
      expect(source.reads).toEqual([{ offset: 64 * KB, length: 64 * KB }]);
      reader.close();
    });

    it('refuses a source that has changed since', async () => {
      const store = await storeMissingBlock1(pattern(192 * KB));
      const source = new CountingSource(pattern(192 * KB, 3), { etag: '"v2"' });
      const reader = await openReader(source, { store, key: 'clip', blockSize: 64 * KB, readAheadBytes: 0 });
      await expect(reader.read(0, 192 * KB)).rejects.toBeInstanceOf(SourceChangedError);
      reader.close();
    });
  });

  it('reports SourceChangedError from the source and forgets the stored copy', async () => {
    const store = freshStore();
    const data = pattern(256 * KB);
    const source = new CountingSource(data);
    const reader = await openReader(source, { store, key: 'clip', blockSize: 64 * KB, readAheadBytes: 0 });
    await reader.read(0, 64 * KB);
    await tick(10);
    source.read = async () => {
      throw new SourceChangedError('changed');
    };
    await expect(reader.read(128 * KB, 10)).rejects.toBeInstanceOf(SourceChangedError);
    await tick(10);
    expect(await store.lookup('clip')).toBeNull();
    reader.close();
  });
});
