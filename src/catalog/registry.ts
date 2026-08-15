/**
 * Paginated reader for the official MCP registry.
 *
 * Returns raw items; {@link normalizeRegistryItem} turns them into catalog
 * entries. Everything time- and network-related is injectable so the unit
 * tests never touch the network.
 */

import { asArray, asString, isRecord, prop } from './json.js';

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers?version=latest';

/**
 * Items per page. The registry defaults to 30 and the published catalog is
 * bounded by `maxPages * pageSize`, so asking for the maximum page size buys
 * three times the coverage for the same number of round trips.
 */
export const REGISTRY_PAGE_SIZE = 100;

const DEFAULT_BASE_URL = `${REGISTRY_URL}&limit=${REGISTRY_PAGE_SIZE}`;

/** Per-page request budget. */
export const DEFAULT_PAGE_TIMEOUT_MS = 15_000;

/**
 * Hard stop, in case a bad cursor makes pagination cycle forever. The registry
 * currently holds 20k+ entries at 100 per page, and ranking by popularity has
 * to see the whole list before it can pick the top of it, so this cap sits
 * above the full read rather than at a page budget.
 */
export const DEFAULT_MAX_PAGES = 400;

/** Minimal `fetch` surface this module needs; `globalThis.fetch` satisfies it. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface FetchRegistryOptions {
  /** Base URL including any query string. A `cursor` param is appended per page. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxPages?: number;
  /** Stop early once this many items have been collected (0/undefined = all). */
  maxItems?: number;
}

export interface RegistryFetchResult {
  /** Raw `servers[]` entries, in registry order across all pages. */
  items: unknown[];
  pagesFetched: number;
  /** True when pagination stopped at `maxPages` with a cursor still pending. */
  hitPageCap: boolean;
}

/** A non-2xx response. Client errors are not retried. */
export class RegistryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    statusText: string,
  ) {
    super(`registry responded ${status} ${statusText} for ${url}`);
    this.name = 'RegistryHttpError';
  }
}

/**
 * Fetch every page of the registry, following `metadata.nextCursor`.
 *
 * Each page gets one retry on a network error or timeout. Any failure that
 * survives the retry rejects: a partial registry read must never be mistaken
 * for a complete catalog.
 */
export async function fetchAllServers(options: FetchRegistryOptions = {}): Promise<RegistryFetchResult> {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
    maxPages = DEFAULT_MAX_PAGES,
    maxItems,
  } = options;

  const items: unknown[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const url = pageUrl(baseUrl, cursor);
    const page = await fetchPageWithRetry(url, fetchImpl, timeoutMs, pagesFetched + 1);
    pagesFetched++;
    items.push(...page.servers);

    if (maxItems !== undefined && maxItems > 0 && items.length >= maxItems) {
      return { items, pagesFetched, hitPageCap: false };
    }
    if (!page.nextCursor) return { items, pagesFetched, hitPageCap: false };
    cursor = page.nextCursor;
  }

  return { items, pagesFetched, hitPageCap: true };
}

function pageUrl(baseUrl: string, cursor: string | undefined): string {
  if (!cursor) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}cursor=${encodeURIComponent(cursor)}`;
}

interface RegistryPage {
  servers: unknown[];
  nextCursor?: string;
}

async function fetchPageWithRetry(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  pageNumber: number,
): Promise<RegistryPage> {
  try {
    return await fetchPage(url, fetchImpl, timeoutMs);
  } catch (error) {
    if (error instanceof RegistryHttpError && error.status < 500) {
      throw error;
    }
    try {
      return await fetchPage(url, fetchImpl, timeoutMs);
    } catch (retryError) {
      throw new Error(
        `registry page ${pageNumber} failed after one retry: ${describe(retryError)}`,
        { cause: retryError },
      );
    }
  }
}

async function fetchPage(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<RegistryPage> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new RegistryHttpError(response.status, url, response.statusText);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`registry returned invalid JSON for ${url}: ${describe(error)}`);
  }

  if (!isRecord(body) || !Array.isArray(body['servers'])) {
    throw new Error(`registry response for ${url} has no servers array`);
  }

  const page: RegistryPage = { servers: asArray(body['servers']) };
  const nextCursor = asString(prop(body['metadata'], 'nextCursor'));
  if (nextCursor) page.nextCursor = nextCursor;
  return page;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? `request timed out (${error.message})` : error.message;
  }
  return String(error);
}
