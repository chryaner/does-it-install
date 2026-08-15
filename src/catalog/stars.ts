/**
 * Stargazer counts for the repositories behind catalog entries.
 *
 * The catalog is ranked by popularity, and the only popularity signal the MCP
 * ecosystem actually publishes is the star count of the repository a server
 * lists. GitHub's REST API costs one request per repository, so this asks the
 * GraphQL API for {@link STARS_BATCH_SIZE} repositories at a time using
 * aliases.
 *
 * Popularity is a nice-to-have: no token, a rate limit, a dead batch or a repo
 * that has been deleted all degrade the ranking, never the build. Everything
 * network-related is injectable so the unit tests never touch the network.
 */

import { prop } from './json.js';

export const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

/**
 * Repositories per query. GraphQL costs one node per alias, and 100 is both
 * the largest batch GitHub's rate limiter treats as one cheap request and a
 * query small enough to stay well inside the response size limit.
 */
export const STARS_BATCH_SIZE = 100;

/** Per-request budget, matching the registry reader. */
export const DEFAULT_STARS_TIMEOUT_MS = 15_000;

const USER_AGENT = 'does-it-install (+https://doesitinstall.com)';

/** Hosts whose `owner/name` path the GraphQL API can answer for. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

/** Character set GitHub allows in an owner or repository name. */
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Minimal `fetch` surface this module needs; `globalThis.fetch` satisfies it. */
export type StarsFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

export interface FetchStarsOptions {
  /**
   * GitHub API token. The GraphQL API rejects unauthenticated requests
   * outright, so an empty token means "do not even ask".
   */
  token?: string;
  fetchImpl?: StarsFetchLike;
  endpoint?: string;
  timeoutMs?: number;
  batchSize?: number;
}

export interface FetchStarsResult {
  /** Stargazer count per input repo url, only for repos GitHub answered for. */
  stars: Map<string, number>;
  /** Queries sent, one per batch; retries are not counted again. */
  batches: number;
  /** Distinct GitHub repositories found in the input. */
  repos: number;
  /** Distinct GitHub repositories GitHub returned a count for. */
  resolved: number;
}

/** One repository to ask about, plus every input url that points at it. */
interface RepoTarget {
  owner: string;
  name: string;
  urls: string[];
}

/** A non-2xx GraphQL response. Client errors are not retried. */
class StarsHttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`github graphql responded ${status} ${statusText}`);
    this.name = 'StarsHttpError';
  }
}

/**
 * Look up stargazer counts for `repoUrls`.
 *
 * Urls that are not GitHub repositories are ignored, repeated urls are asked
 * about once, and a batch that fails after its retry simply contributes no
 * counts: the caller ranks with whatever came back.
 */
export async function fetchStars(
  repoUrls: Iterable<string>,
  options: FetchStarsOptions = {},
): Promise<FetchStarsResult> {
  const {
    token = process.env['GITHUB_TOKEN'] ?? '',
    fetchImpl = globalThis.fetch,
    endpoint = GITHUB_GRAPHQL_URL,
    timeoutMs = DEFAULT_STARS_TIMEOUT_MS,
    batchSize = STARS_BATCH_SIZE,
  } = options;

  const targets = groupByRepo(repoUrls);
  const result: FetchStarsResult = {
    stars: new Map<string, number>(),
    batches: 0,
    repos: targets.length,
    resolved: 0,
  };
  if (token === '' || targets.length === 0) return result;

  const size = Math.max(1, Math.floor(batchSize));
  for (let start = 0; start < targets.length; start += size) {
    const batch = targets.slice(start, start + size);
    result.batches++;

    const counts = await queryWithRetry(batch, { endpoint, token, fetchImpl, timeoutMs });
    for (const [index, stars] of counts) {
      const target = batch[index];
      if (target === undefined) continue;
      result.resolved++;
      for (const url of target.urls) result.stars.set(url, stars);
    }
  }

  return result;
}

/**
 * `https://github.com/owner/repo` -> `{owner, repo}`, tolerating a `.git`
 * suffix and trailing path segments (`/tree/main/src`). Anything hosted
 * elsewhere, or with a segment outside GitHub's own character set, has no
 * stargazer count to fetch and yields undefined.
 */
export function parseGitHubRepo(repoUrl: string): { owner: string; name: string } | undefined {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return undefined;

  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const owner = segments[0];
  const rawName = segments[1];
  if (owner === undefined || rawName === undefined) return undefined;

  const name = rawName.replace(/\.git$/i, '');
  // Both end up inside the GraphQL query, so anything unexpected is refused
  // rather than escaped.
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) return undefined;

  return { owner, name };
}

/** Distinct repositories, each remembering the urls that led to it. */
function groupByRepo(repoUrls: Iterable<string>): RepoTarget[] {
  const targets = new Map<string, RepoTarget>();

  for (const url of repoUrls) {
    const repo = parseGitHubRepo(url);
    if (repo === undefined) continue;

    // Two entries can spell the same repository differently (case, `.git`),
    // and one request answers for both.
    const key = `${repo.owner}/${repo.name}`.toLowerCase();
    const existing = targets.get(key);
    if (existing === undefined) {
      targets.set(key, { owner: repo.owner, name: repo.name, urls: [url] });
    } else if (!existing.urls.includes(url)) {
      existing.urls.push(url);
    }
  }

  return [...targets.values()];
}

interface QueryContext {
  endpoint: string;
  token: string;
  fetchImpl: StarsFetchLike;
  timeoutMs: number;
}

/**
 * One batch, with a single retry on a network error, a timeout or a 5xx. A
 * batch that still fails contributes nothing: a missing star count costs an
 * entry its position in the ranking, which is not worth failing a build over.
 */
async function queryWithRetry(
  batch: readonly RepoTarget[],
  context: QueryContext,
): Promise<Map<number, number>> {
  try {
    return await queryBatch(batch, context);
  } catch (error) {
    // A 4xx is a bad token or a bad query; the same request would fail again.
    if (error instanceof StarsHttpError && error.status < 500) return new Map();
    try {
      return await queryBatch(batch, context);
    } catch {
      return new Map();
    }
  }
}

/** Alias index -> stargazer count, for the aliases GitHub answered. */
async function queryBatch(
  batch: readonly RepoTarget[],
  context: QueryContext,
): Promise<Map<number, number>> {
  const response = await context.fetchImpl(context.endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `bearer ${context.token}`,
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({ query: buildQuery(batch) }),
    signal: AbortSignal.timeout(context.timeoutMs),
  });

  if (!response.ok) throw new StarsHttpError(response.status, response.statusText);

  const body = (await response.json()) as unknown;
  const data = prop(body, 'data');

  // Repos that were renamed, deleted or made private come back as a null alias
  // plus an entry in `errors`. That is the normal case for a stale registry
  // record, so partial data is read as far as it goes.
  const counts = new Map<number, number>();
  batch.forEach((_, index) => {
    const stars = prop(prop(data, alias(index)), 'stargazerCount');
    if (typeof stars === 'number' && Number.isFinite(stars) && stars >= 0) {
      counts.set(index, Math.trunc(stars));
    }
  });
  return counts;
}

function buildQuery(batch: readonly RepoTarget[]): string {
  const fields = batch.map(
    (target, index) =>
      `  ${alias(index)}: repository(owner: ${quote(target.owner)}, name: ${quote(target.name)}) { stargazerCount }`,
  );
  return `query {\n${fields.join('\n')}\n}`;
}

function alias(index: number): string {
  return `r${String(index)}`;
}

/** GraphQL string literals are JSON string literals for our character set. */
function quote(value: string): string {
  return JSON.stringify(value);
}
