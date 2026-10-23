import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { BlockStore, createStore, indexedDbBackend, memoryBackend, opfsBackend } from '../src';
import { tick } from './helpers';

const KB = 1024;
const info = (size: number, etag = '"v1"') => ({ size, etag });
const block = (size: number, fill: number) => new Uint8Array(size).fill(fill);
let counter = 0;

describe.each([
  ['memory', (ns: string) => memoryBackend(ns)],
  ['indexeddb', (ns: string) => indexedDbBackend(ns)],
])('BlockStore over %s', (_name, backend) => {
  const fresh = (maxBytes = 1024 * KB) => {
    const namespace = `store-${counter++}`;
    return { namespace, store: new BlockStore([() => backend(namespace)], maxBytes) };
  };

  it('writes, reads and looks up blocks', async () => {
    const { store } = fresh();
    const resource = await store.open('a', info(100 * KB), 64 * KB);
    expect(resource.complete).toBe(false);
    await resource.write(0, block(64 * KB, 1));
    await resource.write(1, block(36 * KB, 2));
    expect(resource.has(1)).toBe(true);
    expect(resource.complete).toBe(true);
    expect((await resource.read(1))![0]).toBe(2);
    expect(await store.lookup('a')).toEqual({ info: info(100 * KB), blockSize: 64 * KB, blocks: [0, 1] });
    expect(await store.usage()).toBe(100 * KB);
    resource.close();
  });

  it('keeps entries across store instances once saved', async () => {
    const { store, namespace } = fresh();
    const resource = await store.open('a', info(64 * KB), 64 * KB);
    await resource.write(0, block(64 * KB, 7));
    resource.close();
    await tick(20);

    const reopened = new BlockStore([() => backend(namespace)], 1024 * KB);
    expect((await reopened.lookup('a'))?.blocks).toEqual([0]);
    const again = await reopened.open('a', info(64 * KB), 64 * KB);
    expect((await again.read(0))![10]).toBe(7);
    again.close();
  });

  it('drops a key when it is opened for a different version or block size', async () => {
    const { store } = fresh();
    const resource = await store.open('a', info(64 * KB), 64 * KB);
    await resource.write(0, block(64 * KB, 1));
    resource.close();
    (await store.open('a', info(64 * KB, '"v2"'), 64 * KB)).close();
    expect((await store.lookup('a'))?.blocks).toEqual([]);
    expect(await store.usage()).toBe(0);
  });

  it('evicts least recently used keys that are not open, and skips writes that cannot fit', async () => {
    const { store } = fresh(192 * KB);
    for (const key of ['a', 'b', 'c']) {
      const resource = await store.open(key, info(64 * KB), 64 * KB);
      await resource.write(0, block(64 * KB, 1));
      resource.close();
      await tick(2);
    }
    const reused = await store.open('a', info(64 * KB), 64 * KB);
    reused.close();
    await tick(2);

    const d = await store.open('d', info(128 * KB), 64 * KB);
    await d.write(0, block(64 * KB, 4));
    expect(await store.lookup('b')).toBeNull();
    expect(await store.lookup('a')).not.toBeNull();
    await d.write(1, block(64 * KB, 4));
    expect(await store.lookup('c')).toBeNull();
    expect(await store.usage()).toBe(192 * KB);

    const e = await store.open('e', info(64 * KB), 64 * KB);
    await store.delete('a');
    await e.write(0, block(64 * KB, 5));
    expect(e.has(0)).toBe(true);
    const f = await store.open('f', info(64 * KB), 64 * KB);
    await f.write(0, block(64 * KB, 6));
    expect(f.has(0)).toBe(false);
    d.close();
    e.close();
    f.close();
  });

  it('clears everything', async () => {
    const { store } = fresh();
    const resource = await store.open('a', info(64 * KB), 64 * KB);
    await resource.write(0, block(64 * KB, 1));
    resource.close();
    await store.clear();
    expect(await store.lookup('a')).toBeNull();
    expect(await store.usage()).toBe(0);
  });
});

describe('BlockStores shared between contexts', () => {
  // Two stores with the same name stand in for a page and its Service Worker
  const pair = (maxBytes = 1024 * KB) => {
    const namespace = `shared-${counter++}`;
    const make = () => new BlockStore([() => indexedDbBackend(namespace)], maxBytes, namespace);
    return [make(), make()] as const;
  };

  it('see the blocks each other writes, and the keys each other removes', async () => {
    const [page, worker] = pair();
    await worker.lookup('nothing');
    const resource = await page.open('a', { ...info(100 * KB), contentType: 'video/webm' }, 64 * KB);
    await resource.write(0, block(64 * KB, 3));
    await tick(20);
    expect(await worker.lookup('a')).toEqual({ info: { ...info(100 * KB), contentType: 'video/webm' }, blockSize: 64 * KB, blocks: [0] });
    expect(await worker.usage()).toBe(64 * KB);

    const theirs = await worker.open('a', info(100 * KB), 64 * KB);
    expect((await theirs.read(0))![5]).toBe(3);
    await theirs.write(1, block(36 * KB, 4));
    await tick(20);
    expect(resource.complete).toBe(true);
    expect(await page.usage()).toBe(100 * KB);
    resource.close();
    theirs.close();

    await worker.delete('a');
    await tick(20);
    expect(await page.lookup('a')).toBeNull();
    expect(await page.usage()).toBe(0);
  });

  it('replace a key opened elsewhere for another version', async () => {
    const [page, worker] = pair();
    const resource = await page.open('a', info(64 * KB), 64 * KB);
    await resource.write(0, block(64 * KB, 1));
    resource.close();
    await tick(20);
    const newer = await worker.open('a', info(64 * KB, '"v2"'), 64 * KB);
    await newer.write(0, block(64 * KB, 2));
    newer.close();
    await tick(20);
    expect((await page.lookup('a'))?.info.etag).toBe('"v2"');
    expect(await page.usage()).toBe(64 * KB);
  });
});

describe('createStore', () => {
  it("returns null for 'none' and passes a custom store through", () => {
    expect(createStore('none', { namespace: 'x' })).toBeNull();
    const custom = new BlockStore([() => memoryBackend('custom')], 1);
    expect(createStore(custom, { namespace: 'x' })).toBe(custom);
  });

  it('shares one store per kind and namespace, with the latest cap', () => {
    const a = createStore('memory', { namespace: 'shared', maxBytes: 10 }) as BlockStore;
    const b = createStore('memory', { namespace: 'shared', maxBytes: 20 }) as BlockStore;
    expect(a).toBe(b);
    expect(a.maxBytes).toBe(20);
  });

  it("falls back from OPFS to IndexedDB where OPFS isn't available", async () => {
    const store = createStore('auto', { namespace: `auto-${counter++}` })!;
    await store.lookup('nothing');
    expect(store.kind).toBe('indexeddb');
  });

  it('refuses OPFS when it is missing', async () => {
    await expect(opfsBackend('x').init()).rejects.toThrow(/OPFS/);
  });
});
