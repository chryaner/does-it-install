import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STARS_TIMEOUT_MS,
  GITHUB_GRAPHQL_URL,
  STARS_BATCH_SIZE,
  fetchStars,
  parseGitHubRepo,
  type StarsFetchLike,
} from './stars.js';

const ENDPOINT = 'https://graphql.example/graphql';
const TOKEN = 'test-token';

/** Options every test shares: a fake endpoint and a token, never the network. */
function options(fetchImpl: StarsFetchLike, extra: Record<string, unknown> = {}) {
  return { endpoint: ENDPOINT, token: TOKEN, fetchImpl, ...extra };
}

function repoUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}`;
}

/** `alias -> "owner/name"` for every repository a posted query asks about. */
function askedFor(body: string): Record<string, string> {
  const { query } = JSON.parse(body) as { query: string };
  const asked: Record<string, string> = {};
  for (const match of query.matchAll(/(r\d+): repository\(owner: "([^"]*)", name: "([^"]*)"\)/g)) {
    const [, alias, owner, name] = match;
    if (alias !== undefined && owner !== undefined && name !== undefined) {
      asked[alias] = `${owner}/${name}`;
    }
  }
  return asked;
}

/**
 * A GitHub answer for the query in `body`: `stars("owner/name")` returns the
 * count, or null for an alias GitHub could not resolve.
 */
function answer(body: string, stars: (repo: string) => number | null): Response {
  const data: Record<string, unknown> = {};
  const nulls: string[] = [];
  for (const [alias, repo] of Object.entries(askedFor(body))) {
    const count = stars(repo);
    data[alias] = count === null ? null : { stargazerCount: count };
    if (count === null) nulls.push(repo);
  }

  const errors = nulls.map((repo) => ({
    type: 'NOT_FOUND',
    message: `Could not resolve to a Repository with the name '${repo}'.`,
  }));
  const document = nulls.length === 0 ? { data } : { data, errors };
  return new Response(JSON.stringify(document), { status: 200 });
}

/** Answers every alias with a fixed count, however many batches arrive. */
function countingFetch(stars: (repo: string) => number | null) {
  return vi.fn<StarsFetchLike>(async (_url, init) => answer(init.body, stars));
}

/** Queue of responses/errors, one per call, in order. */
function scriptedFetch(...steps: (Response | Error)[]) {
  let call = 0;
  return vi.fn<StarsFetchLike>(async (_url, init) => {
    const step = steps[call++];
    if (step === undefined) throw new Error(`unexpected fetch call #${String(call)}`);
    if (step instanceof Error) throw step;
    // A queued response is a template: it still has to answer this query.
    if (step.status !== 200) return step;
    return answer(init.body, () => 7);
  });
}

describe('parseGitHubRepo', () => {
  it.each([
    ['https://github.com/acme/thing', 'acme', 'thing'],
    ['https://github.com/acme/thing.git', 'acme', 'thing'],
    ['https://github.com/acme/thing/', 'acme', 'thing'],
    ['https://github.com/acme/thing/tree/main/src/server', 'acme', 'thing'],
    ['http://github.com/acme/thing', 'acme', 'thing'],
    ['https://www.github.com/acme/thing', 'acme', 'thing'],
    ['https://GitHub.com/Acme/Thing.GIT', 'Acme', 'Thing'],
    ['https://github.com/acme/thing.js', 'acme', 'thing.js'],
  ])('reads %s', (url, owner, name) => {
    expect(parseGitHubRepo(url)).toEqual({ owner, name });
  });

  it.each([
    ['https://gitlab.com/acme/thing'], // another forge
    ['https://example.test/acme/thing'],
    ['https://notgithub.com/acme/thing'],
    ['https://github.com/acme'], // owner only
    ['https://github.com/'],
    ['git@github.com:acme/thing.git'], // ssh remote, not a url
    ['javascript:alert(1)'],
    ['not a url at all'],
    [''],
    ['https://github.com/acme/thing%20two'], // not a legal repo name
  ])('refuses %s', (url) => {
    expect(parseGitHubRepo(url)).toBeUndefined();
  });
});

describe('fetchStars', () => {
  it('asks for every repo in one aliased query and maps counts back to urls', async () => {
    const fetchImpl = countingFetch((repo) => (repo === 'acme/thing' ? 1234 : 7));

    const result = await fetchStars(
      [repoUrl('acme', 'thing'), 'https://github.com/other/server.git'],
      options(fetchImpl),
    );

    expect(result.stars).toEqual(
      new Map([
        ['https://github.com/acme/thing', 1234],
        ['https://github.com/other/server.git', 7],
      ]),
    );
    expect(result).toMatchObject({ batches: 1, repos: 2, resolved: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('posts an authorized json query with a timeout signal', async () => {
    const fetchImpl = countingFetch(() => 5);

    await fetchStars([repoUrl('acme', 'thing')], options(fetchImpl));

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(init?.headers['authorization']).toBe(`bearer ${TOKEN}`);
    expect(init?.headers['content-type']).toBe('application/json');
    expect(init?.headers['user-agent']).toContain('does-it-install');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init?.body ?? '{}')).toEqual({
      query: 'query {\n  r0: repository(owner: "acme", name: "thing") { stargazerCount }\n}',
    });
  });

  it('defaults to the github endpoint and a 15s budget', () => {
    expect(GITHUB_GRAPHQL_URL).toBe('https://api.github.com/graphql');
    expect(DEFAULT_STARS_TIMEOUT_MS).toBe(15_000);
  });

  it('splits repositories into batches of 100', async () => {
    const urls = Array.from({ length: 250 }, (_, index) => repoUrl('acme', `thing-${String(index)}`));
    const fetchImpl = countingFetch(() => 1);

    const result = await fetchStars(urls, options(fetchImpl));

    expect(STARS_BATCH_SIZE).toBe(100);
    expect(result).toMatchObject({ batches: 3, repos: 250, resolved: 250 });
    expect(result.stars.size).toBe(250);

    const sizes = fetchImpl.mock.calls.map((call) => Object.keys(askedFor(call[1].body)).length);
    expect(sizes).toEqual([100, 100, 50]);
    // Aliases restart at r0 in every batch.
    expect(askedFor(fetchImpl.mock.calls[2]?.[1].body ?? '')['r0']).toBe('acme/thing-200');
  });

  it('ignores urls that are not github repositories', async () => {
    const fetchImpl = countingFetch(() => 3);

    const result = await fetchStars(
      ['https://gitlab.com/acme/thing', 'nonsense', repoUrl('acme', 'thing')],
      options(fetchImpl),
    );

    expect(result).toMatchObject({ repos: 1, resolved: 1 });
    expect(result.stars).toEqual(new Map([['https://github.com/acme/thing', 3]]));
  });

  it('asks once for repositories two urls agree on, and answers both', async () => {
    const fetchImpl = countingFetch(() => 42);

    const result = await fetchStars(
      ['https://github.com/acme/thing', 'https://github.com/Acme/Thing.git'],
      options(fetchImpl),
    );

    expect(Object.keys(askedFor(fetchImpl.mock.calls[0]?.[1].body ?? ''))).toEqual(['r0']);
    expect(result).toMatchObject({ batches: 1, repos: 1, resolved: 1 });
    expect(result.stars.get('https://github.com/acme/thing')).toBe(42);
    expect(result.stars.get('https://github.com/Acme/Thing.git')).toBe(42);
  });

  it('returns nothing without a token, and never calls fetch', async () => {
    const fetchImpl = countingFetch(() => 9);

    const result = await fetchStars([repoUrl('acme', 'thing')], options(fetchImpl, { token: '' }));

    expect(result.stars.size).toBe(0);
    expect(result).toMatchObject({ batches: 0, repos: 1, resolved: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes no request for an empty list', async () => {
    const fetchImpl = countingFetch(() => 9);

    const result = await fetchStars([], options(fetchImpl));

    expect(result).toMatchObject({ batches: 0, repos: 0, resolved: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the counts a partially failed query did return', async () => {
    // A repo that was renamed, deleted or made private answers null plus an
    // entry in `errors`; the rest of the batch is still good data.
    const fetchImpl = countingFetch((repo) => (repo === 'acme/gone' ? null : 11));

    const result = await fetchStars(
      [repoUrl('acme', 'gone'), repoUrl('acme', 'here')],
      options(fetchImpl),
    );

    expect(result.stars).toEqual(new Map([['https://github.com/acme/here', 11]]));
    expect(result).toMatchObject({ batches: 1, repos: 2, resolved: 1 });
  });

  it('retries a batch once after a 500 and keeps the retry result', async () => {
    const fetchImpl = scriptedFetch(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
      new Response(null, { status: 200 }),
    );

    const result = await fetchStars([repoUrl('acme', 'thing')], options(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.stars).toEqual(new Map([['https://github.com/acme/thing', 7]]));
    expect(result.batches).toBe(1); // a retry is not a second batch
  });

  it('retries a batch once after a network error', async () => {
    const fetchImpl = scriptedFetch(new TypeError('fetch failed'), new Response(null, { status: 200 }));

    const result = await fetchStars([repoUrl('acme', 'thing')], options(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.resolved).toBe(1);
  });

  it('drops a batch that fails twice without failing the build', async () => {
    const fetchImpl = scriptedFetch(
      new TypeError('fetch failed'),
      new TypeError('socket hang up'),
      new Response(null, { status: 200 }),
    );

    const result = await fetchStars(
      [repoUrl('acme', 'one'), repoUrl('acme', 'two')],
      options(fetchImpl, { batchSize: 1 }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3); // two failures, then the second batch
    expect(result).toMatchObject({ batches: 2, repos: 2, resolved: 1 });
    expect(result.stars).toEqual(new Map([['https://github.com/acme/two', 7]]));
  });

  it('does not retry a client error such as a rejected token', async () => {
    const fetchImpl = scriptedFetch(new Response(null, { status: 401, statusText: 'Unauthorized' }));

    const result = await fetchStars([repoUrl('acme', 'thing')], options(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ batches: 1, resolved: 0 });
    expect(result.stars.size).toBe(0);
  });

  it('tolerates a response that is not the shape we asked for', async () => {
    const fetchImpl = vi.fn<StarsFetchLike>(async () => new Response('<html>gateway</html>', { status: 200 }));

    const result = await fetchStars([repoUrl('acme', 'thing')], options(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(2); // unreadable body is retried once
    expect(result.stars.size).toBe(0);
  });

  it('ignores a count that is not a plain number', async () => {
    const fetchImpl = vi.fn<StarsFetchLike>(
      async () =>
        new Response(JSON.stringify({ data: { r0: { stargazerCount: 'many' }, r1: {} } }), {
          status: 200,
        }),
    );

    const result = await fetchStars(
      [repoUrl('acme', 'one'), repoUrl('acme', 'two')],
      options(fetchImpl),
    );

    expect(result.stars.size).toBe(0);
    expect(result.resolved).toBe(0);
  });
});
