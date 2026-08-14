/**
 * `npm run catalog -- [--out data/catalog.json] [--offline] [--limit N]`
 *
 * Writes the catalog JSON; everything else goes to stderr.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCatalog } from './build.js';
import { fetchAllServers, type FetchLike } from './registry.js';
import { DEFAULT_SEED_PATH, loadSeed } from './seed.js';

export const DEFAULT_OUT_PATH = 'data/catalog.json';

const USAGE = `Usage: npm run catalog -- [options]

Build data/catalog.json from the MCP registry plus ${DEFAULT_SEED_PATH}.

Options:
  --out <path>   Where to write the catalog (default: ${DEFAULT_OUT_PATH})
  --offline      Build from the seed file only, without contacting the registry
  --limit <n>    Cap the catalog at n servers, keeping the lowest ranks
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

/**
 * Run the CLI. `fetchImpl` is injectable so tests can exercise the online path
 * (including its failure mode) without a network.
 */
export async function run(
  argv: readonly string[],
  overrides: { fetchImpl?: FetchLike } = {},
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
      const result = await fetchAllServers({ maxItems: options.limit, fetchImpl: overrides.fetchImpl });
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

  const { catalog, skipped, duplicates } = buildCatalog(registryItems, seedEntries, { limit: options.limit });

  const outDir = dirname(options.out);
  if (outDir && outDir !== '.') await mkdir(outDir, { recursive: true });
  await writeFile(options.out, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  const bySource = { seed: 0, registry: 0 };
  for (const server of catalog.servers) bySource[server.source]++;
  process.stderr.write(
    `catalog: ${catalog.servers.length} servers -> ${options.out} ` +
      `(seed ${bySource.seed}, registry ${bySource.registry}; ` +
      `${pagesFetched} pages, ${skipped} malformed, ${duplicates} duplicates)\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
