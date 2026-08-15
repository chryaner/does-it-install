/**
 * `npm run catalog -- [--out data/catalog.json] [--offline] [--limit N]`
 *
 * Writes the catalog JSON; everything else goes to stderr.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerEntry } from '../types.js';
import { buildCatalog } from './build.js';
import { registryRepoUrl } from './normalize.js';
import { fetchAllServers, type FetchLike } from './registry.js';
import { DEFAULT_SEED_PATH, loadSeed } from './seed.js';
import { fetchStars, type StarsFetchLike } from './stars.js';

export const DEFAULT_OUT_PATH = 'data/catalog.json';

const USAGE = `Usage: npm run catalog -- [options]

Build data/catalog.json from the MCP registry plus ${DEFAULT_SEED_PATH}.

Servers are ranked by GitHub stars (seed entries first, in seed order), which
needs GITHUB_TOKEN in the environment; without it the ranking falls back to
registry order.

Options:
  --out <path>   Where to write the catalog (default: ${DEFAULT_OUT_PATH})
  --offline      Build from the seed file only, without contacting the registry
  --limit <n>    Keep only the n highest ranked servers
  -h, --help     Show this help`;

export interface CatalogCliOptions {
  out: string;
  offline: boolean;
  limit?: number;
  help: boolean;
}

/** Parse argv (without node/script). Throws on unknown or malformed flags. */
export function parseArgs(argv: readonly string[]): CatalogCliOptions {
  const options: CatalogCliOptions = { out: DEFAULT_OUT_PATH, offline: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return next;
    };

    switch (flag) {
      case '--out':
        options.out = takeValue();
        break;
      case '--limit': {
        const raw = takeValue();
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new Error(`--limit must be a positive integer, got "${raw}"`);
        }
        options.limit = limit;
        break;
      }
      case '--offline':
        options.offline = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }

  return options;
}

export interface CatalogRunOverrides {
  fetchImpl?: FetchLike;
  starsFetchImpl?: StarsFetchLike;
  /** GitHub token for the star lookup; defaults to `GITHUB_TOKEN`. */
  token?: string;
}

/**
 * Run the CLI. The two `fetchImpl`s are injectable so tests can exercise the
 * online path (including its failure modes) without a network.
 *
 * `--limit` cuts the ranked list at the end. The whole registry is always
 * read, because ranking a page-limited prefix would rank an alphabetical
 * sample rather than the most popular servers.
 */
export async function run(
  argv: readonly string[],
  overrides: CatalogRunOverrides = {},
): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const seedEntries = await loadSeed(DEFAULT_SEED_PATH);

  let registryItems: unknown[] = [];
  let pagesFetched = 0;
  if (!options.offline) {
    try {
      const result = await fetchAllServers({ fetchImpl: overrides.fetchImpl });
      registryItems = result.items;
      pagesFetched = result.pagesFetched;
      if (result.hitPageCap) {
        process.stderr.write(
          `warning: stopped after ${result.pagesFetched} registry pages; the catalog may be incomplete\n`,
        );
      }
    } catch (error) {
      throw new Error(
        `registry fetch failed: ${error instanceof Error ? error.message : String(error)} ` +
          '(re-run with --offline to build a seed-only catalog on purpose)',
        { cause: error },
      );
    }
  }

  const { stars, summary: starsSummary } = await lookupStars(
    registryItems,
    seedEntries,
    options,
    overrides,
  );

  const { catalog, skipped, duplicates } = buildCatalog(registryItems, seedEntries, {
    limit: options.limit,
    stars,
  });

  const outDir = dirname(options.out);
  if (outDir && outDir !== '.') await mkdir(outDir, { recursive: true });
  await writeFile(options.out, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  const bySource = { seed: 0, registry: 0 };
  for (const server of catalog.servers) bySource[server.source]++;
  process.stderr.write(
    `catalog: ${catalog.servers.length} servers -> ${options.out} ` +
      `(seed ${bySource.seed}, registry ${bySource.registry}; ` +
      `${pagesFetched} pages${starsSummary}, ${skipped} malformed, ${duplicates} duplicates)\n`,
  );
}

/**
 * Star counts for everything about to be catalogued, and the fragment of the
 * summary line that reports them (empty when no lookup was attempted).
 *
 * Popularity is optional by design: offline builds skip it, a missing token
 * warns once, and a failed lookup costs ranking quality rather than the build.
 */
async function lookupStars(
  registryItems: readonly unknown[],
  seedEntries: readonly ServerEntry[],
  options: CatalogCliOptions,
  overrides: CatalogRunOverrides,
): Promise<{ stars: Map<string, number>; summary: string }> {
  const none = { stars: new Map<string, number>(), summary: '' };
  if (options.offline) return none;

  const token = overrides.token ?? process.env['GITHUB_TOKEN'] ?? '';
  if (token === '') {
    process.stderr.write(
      'warning: GITHUB_TOKEN is unset, so popularity is unavailable and ranking falls back to registry order\n',
    );
    return none;
  }

  try {
    const result = await fetchStars(repoUrlsOf(registryItems, seedEntries), {
      token,
      fetchImpl: overrides.starsFetchImpl,
    });
    return { stars: result.stars, summary: `, stars for ${result.resolved}/${result.repos} repos` };
  } catch (error) {
    // fetchStars already absorbs failed batches, so this is the last line of
    // defense: nothing about popularity may ever fail a catalog build.
    process.stderr.write(
      `warning: star lookup failed (${error instanceof Error ? error.message : String(error)}); ` +
        'ranking falls back to registry order\n',
    );
    return none;
  }
}

/** Every distinct repo url the catalog will carry, seed entries first. */
function repoUrlsOf(
  registryItems: readonly unknown[],
  seedEntries: readonly ServerEntry[],
): string[] {
  const urls = new Set<string>();
  for (const entry of seedEntries) {
    if (entry.repoUrl !== undefined) urls.add(entry.repoUrl);
  }
  for (const item of registryItems) {
    const url = registryRepoUrl(item);
    if (url !== undefined) urls.add(url);
  }
  return [...urls];
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
