/** What the page and the range-source Service Worker agree on. */

/** Bumped when the messages or URLs change incompatibly. */
export const PROTOCOL_VERSION = 1;

/**
 * Elements load files at `<scope>__range-source/<name>?…`, where only the worker answers. The
 * path is always on the page's own origin: Firefox doesn't pass a media element's cross-origin
 * requests to a Service Worker, and the server never sees these URLs.
 */
export const WORKER_PATH = '__range-source/';

const PARAM = {
  namespace: 'namespace',
  storage: 'storage',
  maxBytes: 'max',
  key: 'key',
  /** The file's URL; absent for a source the page holds. */
  url: 'url',
  /** The page holds headers (for a URL) or the source itself under this id. */
  client: 'client',
} as const;

export const MESSAGE = {
  /** Page to worker: are you a range-source worker? Answered with { version }. */
  hello: 'range-source:hello',
  /** Page to worker: claim me (after a hard reload, which leaves the page uncontrolled). */
  claim: 'range-source:claim',
  /** Worker to page: headers, info or bytes for an id the page registered. */
  ask: 'range-source:ask',
} as const;

export type AskRequest =
  | { type: typeof MESSAGE.ask; id: string; op: 'headers' }
  | { type: typeof MESSAGE.ask; id: string; op: 'open' }
  | { type: typeof MESSAGE.ask; id: string; op: 'read'; offset: number; length: number };

export type AskReply =
  | { unknown: true }
  | { error: string }
  | { headers: Array<[string, string]> }
  | { info: { size: number; etag?: string; lastModified?: string; contentType?: string } }
  | { bytes: ArrayBuffer };

export interface Marks {
  namespace: string;
  storage: string;
  maxBytes?: number;
  key?: string;
  /** The file's URL, or undefined when the page holds the source. */
  url?: string;
  client?: string;
}

/** The URL an element loads to have the worker answer with marks. */
export function workerUrl(scope: string, marks: Marks): string {
  const params = new URLSearchParams({ [PARAM.namespace]: marks.namespace });
  if (marks.storage !== 'auto') params.set(PARAM.storage, marks.storage);
  if (marks.maxBytes !== undefined) params.set(PARAM.maxBytes, String(marks.maxBytes));
  if (marks.key !== undefined) params.set(PARAM.key, marks.key);
  if (marks.url !== undefined) params.set(PARAM.url, marks.url);
  if (marks.client !== undefined) params.set(PARAM.client, marks.client);
  // The file's name, for anyone reading the URL in the network panel
  const name = marks.url !== undefined ? fileName(marks.url) : 'source';
  return `${scope}${WORKER_PATH}${encodeURIComponent(name)}?${params}`;
}

/** The marks on a request for the worker's path, or null for any other request. */
export function readMarks(requestUrl: string, scope: string): Marks | null {
  if (!requestUrl.startsWith(scope + WORKER_PATH)) return null;
  let params: URLSearchParams;
  try {
    params = new URL(requestUrl).searchParams;
  } catch {
    return null;
  }
  const namespace = params.get(PARAM.namespace);
  if (!namespace) return null;
  const maxBytes = params.has(PARAM.maxBytes) ? Number(params.get(PARAM.maxBytes)) : undefined;
  return {
    namespace,
    storage: params.get(PARAM.storage) ?? 'auto',
    maxBytes: maxBytes !== undefined && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : undefined,
    key: params.get(PARAM.key) ?? undefined,
    url: params.get(PARAM.url) ?? undefined,
    client: params.get(PARAM.client) ?? undefined,
  };
}

function fileName(url: string): string {
  const path = url.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf('/') + 1) || 'file';
}
