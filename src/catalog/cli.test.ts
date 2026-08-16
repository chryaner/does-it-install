import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../types.js';
import { DEFAULT_OUT_PATH, parseArgs, run } from './cli.js';
import type { FetchLike } from './registry.js';
import { loadSeed } from './seed.js';
import type { StarsFetchLike } from './stars.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Answers a star query from an `owner/name` table, 5 stars for anything else
 * (the seed file's own repositories, for one). Never touches the network.
 */
function starsFetch(counts: Record<string, number> = {}) {
  return vi.fn<StarsFetchLike>(async (_url, init) => {
    const { query } = JSON.parse(init.body) as { query: string };
    const data: Record<string, unknown> = {};
    for (const match of query.matchAll(/(r\d+): repository\(owner: "([^"]*)", name: "([^"]*)"\)/g)) {
      const [, alias, owner, name] = match;
      if (alias === undefined || owner === undefined || name === undefined) continue;
      data[alias] = { stargazerCount: counts[`${owner}/${name}`] ?? 5 };
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
}

/** Collect stderr for the duration of `body`, restoring the spy afterwards. */
async function captureStderr(body: () => Promise<void>): Promise<string> {
  const logged: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  });

  try {
    await body();
  } finally {
    stderr.mockRestore();
  }
  return logged.join('');
}

describe('parseArgs', () => {
  it('defaults to an online build into data/catalog.json', () => {
    expect(parseArgs([])).toEqual({ out: DEFAULT_OUT_PATH, offline: false, help: false });
  });

  it('accepts space- and equals-separated values', () => {
    expect(parseArgs(['--out', 'tmp/c.json', '--limit', '25', '--offline'])).toEqual({
      out: 'tmp/c.json',
      limit: 25,
      offline: true,
      help: false,
    });
    expect(parseArgs(['--out=tmp/c.json', '--limit=25'])).toMatchObject({
      out: 'tmp/c.json',
      limit: 25,
    });
  });

  it('recognizes both help flags', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it.each([
    [['--nope'], /unknown argument "--nope"/],
    [['--out'], /--out requires a value/],
    [['--out', '--offline'], /--out requires a value/],
    [['--limit', 'many'], /--limit must be a positive integer, got "many"/],
    [['--limit', '0'], /--limit must be a positive integer/],
    [['--limit', '2.5'], /--limit must be a positive integer/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('catalog cli', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'dii-catalog-cli-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const runCli = (args: string[]) =>
    execFileAsync('npx', ['tsx', 'src/catalog/cli.ts', ...args], { cwd: repoRoot });

  it('builds a seed-only catalog with --offline and summarizes to stderr', async () => {
    const out = join(workDir, 'nested', 'catalog.json');

    const { stderr } = await runCli(['--offline', '--out', out]);

    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    expect(catalog.servers.length).toBeGreaterThan(0);
    expect(catalog.servers.every((server) => server.source === 'seed')).toBe(true);
    expect(Number.isNaN(Date.parse(catalog.generatedAt))).toBe(false);
    expect(stderr).toMatch(new RegExp(`catalog: ${catalog.servers.length} servers`));
    expect(stderr).toContain(`registry 0`);
  });

  it('honours --limit', async () => {
    const out = join(workDir, 'limited.json');

    await runCli(['--offline', '--out', out, '--limit', '1']);

    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.servers[0]?.rank).toBe(1);
  });

  it('exits non-zero with a usable message on a bad flag', async () => {
    await expect(runCli(['--bogus'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('error: unknown argument "--bogus"'),
    });
  });

  it('prints usage for --help', async () => {
    const { stdout } = await runCli(['--help']);
    expect(stdout).toContain('Usage: npm run catalog');
    expect(stdout).toContain('--offline');
  });

  it('merges registry pages with the seed file on the online path', async () => {
    const out = join(workDir, 'online.json');
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes('cursor=')
        ? new Response(JSON.stringify({ servers: [{ server: { name: 'reg/two' } }], metadata: {} }))
        : new Response(
            JSON.stringify({
              servers: [{ server: { name: 'reg/one' } }],
              metadata: { nextCursor: 'next' },
            }),
          ),
    );

    const logged = await captureStderr(async () => {
      await run(['--out', out], { fetchImpl, starsFetchImpl: starsFetch(), token: 'test-token' });
    });

    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    const registryIds = catalog.servers.filter((s) => s.source === 'registry').map((s) => s.id);
    expect(registryIds).toEqual(['reg/one', 'reg/two']);
    expect(catalog.servers.some((s) => s.source === 'seed')).toBe(true);
    expect(logged).toMatch(/catalog: \d+ servers .*2 pages/);
  });

  it('ranks the whole registry by stars before --limit cuts it', async () => {
    const out = join(workDir, 'ranked.json');
    // Two pages: the popular server is only on the second one, so a --limit
    // that capped pagination would never see it.
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes('cursor=')
        ? new Response(
            JSON.stringify({
              servers: [
                {
                  server: {
                    name: 'reg/popular',
                    repository: { url: 'https://github.com/acme/popular' },
                  },
                },
              ],
              metadata: {},
            }),
          )
        : new Response(
            JSON.stringify({
              servers: [
                {
                  server: { name: 'reg/quiet', repository: { url: 'https://github.com/acme/quiet' } },
                },
              ],
              metadata: { nextCursor: 'next' },
            }),
          ),
    );
    const starsFetchImpl = starsFetch({ 'acme/popular': 4321, 'acme/quiet': 3 });

    // One over the seed file's own entries, which always rank ahead of the
    // registry, so exactly one registry entry survives the cut.
    const seedCount = (await loadSeed()).length;
    const logged = await captureStderr(async () => {
      await run(['--out', out, '--limit', String(seedCount + 1)], {
        fetchImpl,
        starsFetchImpl,
        token: 'test-token',
      });
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2); // --limit no longer stops pagination
    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    const registryEntries = catalog.servers.filter((s) => s.source === 'registry');
    expect(registryEntries.map((s) => s.id)).toEqual(['reg/popular']);
    expect(registryEntries[0]?.popularity).toEqual({ stars: 4321 });
    expect(logged).toMatch(/stars for (\d+)\/\1 repos/); // every repo answered
  });

  it('warns once and builds anyway when there is no token', async () => {
    const out = join(workDir, 'tokenless.json');
    const fetchImpl = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify({ servers: [{ server: { name: 'reg/one' } }], metadata: {} })),
    );
    const starsFetchImpl = starsFetch();

    const logged = await captureStderr(async () => {
      await run(['--out', out], { fetchImpl, starsFetchImpl, token: '' });
    });

    expect(starsFetchImpl).not.toHaveBeenCalled();
    expect(logged).toContain(
      'warning: GITHUB_TOKEN is unset, so popularity is unavailable and ranking falls back to registry order',
    );
    expect(logged).not.toContain('stars for');
    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    expect(catalog.servers.some((s) => s.id === 'reg/one')).toBe(true);
  });

  it('still writes a catalog when the star lookup fails outright', async () => {
    const out = join(workDir, 'stars-down.json');
    const fetchImpl = vi.fn<FetchLike>(
      async () =>
        new Response(
          JSON.stringify({
            servers: [
              { server: { name: 'reg/one', repository: { url: 'https://github.com/acme/one' } } },
            ],
            metadata: {},
          }),
        ),
    );
    const starsFetchImpl = vi.fn<StarsFetchLike>(() => {
      throw new TypeError('fetch failed');
    });

    const logged = await captureStderr(async () => {
      await run(['--out', out], { fetchImpl, starsFetchImpl, token: 'test-token' });
    });

    expect(logged).toMatch(/stars for 0\/\d+ repos/);
    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    expect(catalog.servers.some((s) => s.id === 'reg/one')).toBe(true);
    expect(catalog.servers.every((s) => s.popularity === undefined)).toBe(true);
  });

  it('fails loudly instead of writing a seed-only catalog when the registry is down', async () => {
    const out = join(workDir, 'never-written.json');
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(run(['--out', out], { fetchImpl })).rejects.toThrow(
      /registry fetch failed: registry page 1 failed after one retry: fetch failed.*--offline/s,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one retry, then give up
    await expect(readFile(out, 'utf8')).rejects.toThrow(/ENOENT/);
  });
});

describe('catalog cli when the registry is unreachable', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'dii-catalog-outage-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const failingFetch = () =>
    vi.fn<FetchLike>(async () => {
      throw new TypeError('fetch failed');
    });

  /** A catalog on disk, written the way a previous run would have left it. */
  async function writeExisting(name: string, catalog: unknown): Promise<string> {
    const out = join(workDir, name);
    await writeFile(out, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    return out;
  }

  it('keeps last week’s catalog and exits zero so the sweep still runs', async () => {
    const out = await writeExisting('kept.json', {
      generatedAt: '2026-08-09T03:00:00.000Z',
      servers: [{ id: 'reg/one', slug: 'reg__one', title: 'One', packages: [], remotes: [] }],
    });

    const logged = await captureStderr(async () => {
      await run(['--out', out], { fetchImpl: failingFetch() });
    });

    expect(logged).toContain('registry unreachable');
    expect(logged).toContain('fetch failed');
    expect(logged).toContain('keeping the existing catalog from 2026-08-09T03:00:00.000Z');
  });

  it('leaves the existing file byte for byte as it was', async () => {
    const out = await writeExisting('untouched.json', {
      generatedAt: '2026-08-09T03:00:00.000Z',
      servers: [{ id: 'reg/one', slug: 'reg__one', title: 'One', packages: [], remotes: [] }],
    });
    const before = await readFile(out);

    await captureStderr(async () => {
      await run(['--out', out], { fetchImpl: failingFetch() });
    });

    // Not rewritten, not reformatted, not rebuilt from the seed file: the sweep
    // has to read exactly the catalog the last good build published.
    expect(await readFile(out)).toEqual(before);
  });

  it('never reaches the star lookup, since there is nothing to rank', async () => {
    const out = await writeExisting('no-stars.json', {
      generatedAt: '2026-08-09T03:00:00.000Z',
      servers: [{ id: 'reg/one', slug: 'reg__one', title: 'One', packages: [], remotes: [] }],
    });
    const starsFetchImpl = starsFetch();

    await captureStderr(async () => {
      await run(['--out', out], { fetchImpl: failingFetch(), starsFetchImpl, token: 'test-token' });
    });

    expect(starsFetchImpl).not.toHaveBeenCalled();
  });

  it('still fails when there is no catalog to fall back on', async () => {
    const out = join(workDir, 'missing.json');

    await expect(run(['--out', out], { fetchImpl: failingFetch() })).rejects.toThrow(
      /registry fetch failed:.*--offline/s,
    );
    await expect(readFile(out, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('still fails when the file on disk is not a catalog', async () => {
    const corrupt = join(workDir, 'corrupt.json');
    await writeFile(corrupt, '{ "servers": [', 'utf8');
    const empty = await writeExisting('empty-servers.json', {
      generatedAt: '2026-08-09T03:00:00.000Z',
      servers: [],
    });
    const blank = join(workDir, 'blank.json');
    await writeFile(blank, '', 'utf8');
    const notAnObject = await writeExisting('array.json', [{ id: 'reg/one' }]);

    for (const out of [corrupt, empty, blank, notAnObject]) {
      // A half-written or empty catalog is not last week's data, and starting a
      // sweep off it would report the whole index as untested.
      await expect(run(['--out', out], { fetchImpl: failingFetch() })).rejects.toThrow(
        /registry fetch failed:.*--offline/s,
      );
    }

    expect(await readFile(corrupt, 'utf8')).toBe('{ "servers": [');
  });

  it('names an undated catalog rather than refusing to keep it', async () => {
    const out = await writeExisting('undated.json', {
      servers: [{ id: 'reg/one', slug: 'reg__one', title: 'One', packages: [], remotes: [] }],
    });

    const logged = await captureStderr(async () => {
      await run(['--out', out], { fetchImpl: failingFetch() });
    });

    expect(logged).toContain('keeping the existing catalog from an unknown date');
  });

  it('does not swallow a registry outage on an --offline build, which never fetches', async () => {
    const out = await writeExisting('offline.json', {
      generatedAt: '2026-08-09T03:00:00.000Z',
      servers: [{ id: 'stale/one', slug: 'stale__one', title: 'One', packages: [], remotes: [] }],
    });
    const fetchImpl = failingFetch();

    await captureStderr(async () => {
      await run(['--offline', '--out', out], { fetchImpl });
    });

    // --offline is a deliberate seed-only build, so it overwrites as always.
    expect(fetchImpl).not.toHaveBeenCalled();
    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    expect(catalog.servers.every((server) => server.source === 'seed')).toBe(true);
  });
});
