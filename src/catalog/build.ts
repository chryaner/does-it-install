/**
 * Merge seed and registry entries into the catalog the rest of the pipeline
 * reads.
 *
 * Ordering rules: seed entries first, in the rank order the seed file gives
 * them, then registry entries in registry order. Ids are unique (seed wins),
 * and so are slugs (they name files and URLs downstream).
 */

import type { Catalog, ServerEntry } from '../types.js';
import { normalizeRegistryItem } from './normalize.js';

export interface BuildCatalogOptions {
  /** Cap the catalog at this many servers, keeping the lowest ranks. */
  limit?: number;
}

export interface BuildCatalogResult {
  catalog: Catalog;
  /** Registry items that could not be normalized at all. */
  skipped: number;
  /** Entries dropped because their id was already taken. */
  duplicates: number;
}

export function buildCatalog(
  registryItems: readonly unknown[],
  seedEntries: readonly ServerEntry[],
  options: BuildCatalogOptions = {},
): BuildCatalogResult {
  const servers: ServerEntry[] = [];
  const claimedIds = new Set<string>();
  let skipped = 0;
  let duplicates = 0;

  // Seed entries come first and keep the ranks the seed file assigned them.
  let nextRegistryRank = 1;
  for (const entry of [...seedEntries].sort((a, b) => a.rank - b.rank)) {
    if (claimedIds.has(entry.id)) {
      duplicates++;
      continue;
    }
    claimedIds.add(entry.id);
    servers.push({ ...entry });
    nextRegistryRank = Math.max(nextRegistryRank, Math.floor(entry.rank) + 1);
  }

  for (const item of registryItems) {
    const entry = normalizeRegistryItem(item);
    if (!entry) {
      skipped++;
      continue;
    }
    if (claimedIds.has(entry.id)) {
      duplicates++;
      continue;
    }
    claimedIds.add(entry.id);
    servers.push({ ...entry, rank: nextRegistryRank++ });
  }

  const limited =
    options.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? servers.slice(0, Math.floor(options.limit))
      : servers;

  assignUniqueSlugs(limited);

  return {
    catalog: { generatedAt: new Date().toISOString(), servers: limited },
    skipped,
    duplicates,
  };
}

/**
 * Slugs address files (`data/history/<slug>.json`) and pages (`s/<slug>.html`),
 * so two entries may never share one. The first entry in rank order keeps the
 * bare slug; later collisions get `-2`, `-3`, ...
 */
function assignUniqueSlugs(servers: ServerEntry[]): void {
  const taken = new Set<string>();
  for (const entry of servers) {
    const base = entry.slug;
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${suffix++}`;
    }
    taken.add(candidate);
    entry.slug = candidate;
  }
}
