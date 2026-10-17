import type { EntryRecord, StoreBackend } from './block-store';

/** Never fetched: the Cache API only needs http(s) URLs to file blocks under. */
const BASE = 'https://alpha-video-source.invalid/';

/**
 * Blocks in the Cache API, in the cache `alpha-video-source-<namespace>`, each as its own
 * synthetic 200 response (Cache.put refuses 206 responses, so range responses can't be stored as is).
 */
export function cacheApiBackend(namespace: string): StoreBackend {
  const name = `alpha-video-source-${namespace}`;
  let cache: Cache | null = null;

  const url = (key: string, part: string) => `${BASE}${encodeURIComponent(key)}/${part}`;
  const binary = (data: Uint8Array) =>
    new Response(data as unknown as BodyInit, { headers: { 'Content-Type': 'application/octet-stream' } });

  return {
    kind: 'cache',
    async init() {
      if (typeof caches === 'undefined') throw new Error('the Cache API is not available');
      cache = await caches.open(name);
      const records: EntryRecord[] = [];
      for (const request of await cache.keys()) {
        if (!request.url.endsWith('/meta')) continue;
        const response = await cache.match(request);
        const record = response ? ((await response.json().catch(() => null)) as EntryRecord | null) : null;
        if (record && typeof record.key === 'string' && Array.isArray(record.blocks)) records.push(record);
        else await cache.delete(request);
      }
      return records;
    },
    async saveEntry(record) {
      await cache!.put(url(record.key, 'meta'), Response.json ? Response.json(record) : new Response(JSON.stringify(record)));
    },
    async deleteEntry(record) {
      await cache!.delete(url(record.key, 'meta'));
      const prefix = `${BASE}${encodeURIComponent(record.key)}/`;
      for (const request of await cache!.keys()) {
        if (request.url.startsWith(prefix)) await cache!.delete(request);
      }
    },
    async readBlock(key, index) {
      const response = await cache!.match(url(key, String(index)));
      return response ? new Uint8Array(await response.arrayBuffer()) : null;
    },
    async writeBlock(key, index, data) {
      await cache!.put(url(key, String(index)), binary(data));
    },
    async clear() {
      await caches.delete(name);
      cache = await caches.open(name);
    },
  };
}
