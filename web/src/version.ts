import type { SourceInfo } from './types';

/** Whether two infos describe the same content: same size, and no ETag or Last-Modified that differs. */
export function sameVersion(a: SourceInfo, b: SourceInfo): boolean {
  if (a.size !== b.size) return false;
  if (a.etag && b.etag) return a.etag === b.etag;
  if (a.lastModified && b.lastModified) return a.lastModified === b.lastModified;
  return true;
}
