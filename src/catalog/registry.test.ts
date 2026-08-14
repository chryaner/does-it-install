import { describe, expect, it, vi } from 'vitest';
import {
  REGISTRY_PAGE_SIZE,
  REGISTRY_URL,
  RegistryHttpError,
  fetchAllServers,
  type FetchLike,
} from './registry.js';

const BASE = 'https://registry.example/v0/servers?version=latest';

function pageResponse(names: string[], nextCursor?: string): Response {
  const body = {
    servers: names.map((name) => ({ server: { name } })),
    metadata: nextCursor ? { nextCursor, count: names.length } : { count: names.length },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

function names(items: unknown[]): unknown[] {
  return items.map((item) => (item as { server: { name: string } }).server.name);
}

/** Queue of responses/errors, one per call, in order. */
function scriptedFetch(...steps: (Response | Error)[]): ReturnType<typeof vi.fn<FetchLike>> {
  let call = 0;
  return vi.fn<FetchLike>(async () => {
    const step = steps[call++];
    if (step === undefined) throw new Error(`unexpected fetch call #${call}`);
    if (step instanceof Error) throw step;
    return step;
  });
}

describe('fetchAllServers', () => {
  it('follows nextCursor across pages and concatenates the results', async () => {
    const fetchImpl = scriptedFetch(
      pageResponse(['a', 'b'], 'cursor one'),
      pageResponse(['c'], 'cursor/two'),
      pageResponse(['d']),
    );

    const result = await fetchAllServers({ baseUrl: BASE, fetchImpl });

    expect(names(result.items)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.pagesFetched).toBe(3);
    expect(result.hitPageCap).toBe(false);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      BASE,
      `${BASE}&cursor=cursor%20one`,
      `${BASE}&cursor=cursor%2Ftwo`,
    ]);
  });

  it('passes an abort signal on every request', async () => {
    const fetchImpl = scriptedFetch(pageResponse(['a']));

    await fetchAllServers({ baseUrl: BASE, fetchImpl, timeoutMs: 1234 });

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('stops at the page cap when the cursor never runs out', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => pageResponse(['x'], 'same-cursor-forever'));

    const result = await fetchAllServers({ baseUrl: BASE, fetchImpl, maxPages: 5 });

    expect(result.pagesFetched).toBe(5);
    expect(result.hitPageCap).toBe(true);
    expect(result.items).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('stops early once maxItems have been collected', async () => {
    const fetchImpl = scriptedFetch(pageResponse(['a', 'b'], 'c1'), pageResponse(['c', 'd'], 'c2'));

    const result = await fetchAllServers({ baseUrl: BASE, fetchImpl, maxItems: 3 });

    expect(names(result.items)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.pagesFetched).toBe(2);
    expect(result.hitPageCap).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a page once after a network error', async () => {
    const fetchImpl = scriptedFetch(
      new TypeError('fetch failed'),
      pageResponse(['a'], 'c1'),
      pageResponse(['b']),
    );

    const result = await fetchAllServers({ baseUrl: BASE, fetchImpl });

    expect(names(result.items)).toEqual(['a', 'b']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after the second failure and names the page', async () => {
    const fetchImpl = scriptedFetch(
      pageResponse(['a'], 'c1'),
      new TypeError('fetch failed'),
      new TypeError('socket hang up'),
    );

    await expect(fetchAllServers({ baseUrl: BASE, fetchImpl })).rejects.toThrow(
      /registry page 2 failed after one retry: socket hang up/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries server errors but not client errors', async () => {
    const serverError = scriptedFetch(
      new Response(null, { status: 503, statusText: 'Service Unavailable' }),
      pageResponse(['a']),
    );
    await expect(fetchAllServers({ baseUrl: BASE, fetchImpl: serverError })).resolves.toMatchObject({
      pagesFetched: 1,
    });
    expect(serverError).toHaveBeenCalledTimes(2);

    const clientError = scriptedFetch(new Response(null, { status: 404, statusText: 'Not Found' }));
    await expect(fetchAllServers({ baseUrl: BASE, fetchImpl: clientError })).rejects.toThrow(
      RegistryHttpError,
    );
    expect(clientError).toHaveBeenCalledTimes(1);
  });

  it('rejects when a page is not JSON', async () => {
    const fetchImpl = scriptedFetch(
      new Response('<html>gateway</html>', { status: 200 }),
      new Response('<html>gateway</html>', { status: 200 }),
    );

    await expect(fetchAllServers({ baseUrl: BASE, fetchImpl })).rejects.toThrow(/invalid JSON/);
  });

  it('rejects when a page has no servers array', async () => {
    const fetchImpl = scriptedFetch(
      new Response(JSON.stringify({ metadata: {} }), { status: 200 }),
      new Response(JSON.stringify({ metadata: {} }), { status: 200 }),
    );

    await expect(fetchAllServers({ baseUrl: BASE, fetchImpl })).rejects.toThrow(/no servers array/);
  });

  it('defaults to the official registry url with the largest page size', async () => {
    const fetchImpl = scriptedFetch(pageResponse(['a']));

    await fetchAllServers({ fetchImpl });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${REGISTRY_URL}&limit=${REGISTRY_PAGE_SIZE}`);
    expect(REGISTRY_URL).toBe('https://registry.modelcontextprotocol.io/v0/servers?version=latest');
  });

  it('appends the cursor with a ? when the base url has no query string', async () => {
    const fetchImpl = scriptedFetch(pageResponse(['a'], 'c1'), pageResponse(['b']));

    await fetchAllServers({ baseUrl: 'https://registry.example/v0/servers', fetchImpl });

    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://registry.example/v0/servers?cursor=c1');
  });
});
