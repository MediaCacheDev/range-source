import { afterEach, describe, expect, it } from 'vitest';
import { httpSource, HttpSourceError, SourceChangedError } from '../src';
import { parseContentRange } from '../src/http-source';
// @ts-expect-error plain JS test server
import { startRangeServer } from './range-server.mjs';
import { expectSlice, pattern } from './helpers';

type Server = Awaited<ReturnType<typeof startRangeServer>>;

const data = pattern(3 * 1024 * 1024 + 123);
let server: Server | null = null;

async function serve(options: Record<string, unknown> = {}): Promise<Server> {
  server = await startRangeServer({ files: { '/clip.bin': Buffer.from(data) }, ...options });
  return server!;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('httpSource with range support', () => {
  it('opens with one request and reads sequentially on the same connection', async () => {
    const s = await serve();
    const source = httpSource(`${s.url}/clip.bin`);
    const info = await source.open();
    expect(info.size).toBe(data.byteLength);
    expect(info.etag).toBeTruthy();
    for (let offset = 0; offset < 2 * 1024 * 1024; offset += 256 * 1024) {
      expectSlice(await source.read(offset, 256 * 1024), data, offset, 256 * 1024);
    }
    expect(s.requests.length).toBe(1);
    expect(s.requests[0].range).toBe('bytes=0-');
    source.close?.();
  });

  it('skips a short gap on the open connection, and reconnects for a far or backward read', async () => {
    const s = await serve();
    const source = httpSource(`${s.url}/clip.bin`, { reconnectGap: 100_000 });
    await source.open();
    expectSlice(await source.read(50_000, 1000), data, 50_000, 1000);
    expect(s.requests.length).toBe(1);
    expectSlice(await source.read(2_000_000, 1000), data, 2_000_000, 1000);
    expect(s.requests.length).toBe(2);
    expect(s.requests[1].range).toBe('bytes=2000000-');
    expectSlice(await source.read(10, 1000), data, 10, 1000);
    expect(s.requests[2].range).toBe('bytes=10-');
    source.close?.();
  });

  it('returns fewer bytes only at the end', async () => {
    await serve();
    const source = httpSource(`${server!.url}/clip.bin`);
    await source.open();
    expectSlice(await source.read(data.byteLength - 10, 100), data, data.byteLength - 10, 100);
    expect((await source.read(data.byteLength, 100)).byteLength).toBe(0);
    source.close?.();
  });

  it('takes the size from Content-Length when Content-Range is not exposed', async () => {
    const s = await serve({ cors: false });
    const fetchHidingRange: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const headers = new Headers(response.headers);
      headers.delete('content-range');
      headers.delete('etag');
      return new Response(response.body, { status: response.status, headers });
    };
    const source = httpSource(`${s.url}/clip.bin`, { fetch: fetchHidingRange });
    const info = await source.open();
    expect(info.size).toBe(data.byteLength);
    expect(info.etag).toBeUndefined();
    expect(info.lastModified).toBeTruthy();
    expectSlice(await source.read(3_000_000, 5000), data, 3_000_000, 5000);
    source.close?.();
  });

  it('sends the given headers', async () => {
    const s = await serve({ requireHeader: ['Authorization', 'Bearer t'] });
    await expect(httpSource(`${s.url}/clip.bin`).open()).rejects.toBeInstanceOf(HttpSourceError);
    const source = httpSource(`${s.url}/clip.bin`, { headers: { Authorization: 'Bearer t' } });
    expect((await source.open()).size).toBe(data.byteLength);
    source.close?.();
  });

  it('fails with the status for a missing file', async () => {
    const s = await serve();
    const error = await httpSource(`${s.url}/missing.bin`).open().catch((e) => e);
    expect(error).toBeInstanceOf(HttpSourceError);
    expect(error.status).toBe(404);
  });

  it('notices the file changing between requests', async () => {
    const s = await serve();
    const source = httpSource(`${s.url}/clip.bin`);
    await source.open();
    s.setFile('/clip.bin', Buffer.from(pattern(data.byteLength, 1)));
    await expect(source.read(2_500_000, 100)).rejects.toBeInstanceOf(SourceChangedError);
    source.close?.();
  });

  it('aborts a read', async () => {
    const s = await serve({ chunkSize: 16 * 1024, chunkDelayMs: 20 });
    const source = httpSource(`${s.url}/clip.bin`);
    await source.open();
    const controller = new AbortController();
    const read = source.read(0, data.byteLength, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expectSlice(await source.read(100, 100), data, 100, 100);
    source.close?.();
  });
});

describe('httpSource without range support', () => {
  it('reads progressively from the start, restarting for a backward read', async () => {
    const s = await serve({ range: false });
    const source = httpSource(`${s.url}/clip.bin`);
    expect((await source.open()).size).toBe(data.byteLength);
    expectSlice(await source.read(1_000_000, 1000), data, 1_000_000, 1000);
    expectSlice(await source.read(2_000_000, 1000), data, 2_000_000, 1000);
    expect(s.requests.length).toBe(1);
    expectSlice(await source.read(500, 1000), data, 500, 1000);
    expect(s.requests.length).toBe(2);
    source.close?.();
  });

  it('reads a body of unknown length whole', async () => {
    const s = await serve({ range: false, chunked: true });
    const source = httpSource(`${s.url}/clip.bin`);
    expect((await source.open()).size).toBe(data.byteLength);
    expectSlice(await source.read(3_000_000, 10_000), data, 3_000_000, 10_000);
    expectSlice(await source.read(0, 10), data, 0, 10);
    expect(s.requests.length).toBe(1);
  });
});

describe('parseContentRange', () => {
  it('parses ranges with and without a total', () => {
    expect(parseContentRange('bytes 0-99/1000')).toEqual({ start: 0, end: 99, total: 1000 });
    expect(parseContentRange('bytes 5-9/*')).toEqual({ start: 5, end: 9, total: undefined });
    expect(parseContentRange('bytes */1000')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });
});
