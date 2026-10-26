import { describe, expect, it } from 'vitest';
import { RangeDataSources, memorySource, type DataSourceFactory } from '../src';

describe('RangeDataSources', () => {
  it('makes byte sources by name, with the player headers', async () => {
    const seen: Array<[string, Record<string, string> | undefined]> = [];
    RangeDataSources.register('test', (uri, init) => {
      seen.push([uri, init?.headers]);
      return memorySource(new Uint8Array([1, 2, 3]));
    });
    const source = RangeDataSources.get('test')!('https://cdn.example.com/a.webm', { headers: { 'x-token': 't' } });
    expect(await source.read(1, 2)).toEqual(new Uint8Array([2, 3]));
    expect(seen).toEqual([['https://cdn.example.com/a.webm', { 'x-token': 't' }]]);
    RangeDataSources.unregister('test');
    expect(RangeDataSources.get('test')).toBeUndefined();
  });

  it('shares the registry on its global symbol, for libraries that register without importing it', () => {
    const factory: DataSourceFactory = () => memorySource(new Uint8Array(1));
    const shared = (globalThis as Record<symbol, Map<string, DataSourceFactory>>)[Symbol.for('range-source.dataSources')];
    RangeDataSources.register('shared', factory);
    expect((globalThis as Record<symbol, Map<string, DataSourceFactory>>)[Symbol.for('range-source.dataSources')].get('shared')).toBe(factory);
    expect(shared === undefined || shared.get('shared') === factory).toBe(true);
    RangeDataSources.unregister('shared');
  });
});
