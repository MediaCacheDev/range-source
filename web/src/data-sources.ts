import type { ByteSource } from './types';

/** Makes the byte source for a URL, given the headers the player was asked to send. */
export type DataSourceFactory = (uri: string, init?: { headers?: Record<string, string> }) => ByteSource;

const REGISTRY = Symbol.for('range-source.dataSources');

/**
 * The registry, on a global symbol: a library such as MediaCache registers without importing
 * range-source-web, and two copies of range-source-web in one app share it.
 */
function registry(): Map<string, DataSourceFactory> {
  const scope = globalThis as { [REGISTRY]?: Map<string, DataSourceFactory> };
  return (scope[REGISTRY] ??= new Map());
}

/**
 * Data sources by name, as on Android and iOS: a player given a name with its URL, such as
 * `source={{ uri, dataSource: 'mediacache' }}` in React Native, reads through the byte source
 * the name's factory makes for that URL.
 */
export const RangeDataSources = {
  register(name: string, factory: DataSourceFactory): void {
    registry().set(name, factory);
  },
  unregister(name: string): void {
    registry().delete(name);
  },
  get(name: string): DataSourceFactory | undefined {
    return registry().get(name);
  },
};
