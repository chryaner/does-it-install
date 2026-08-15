/**
 * Merge seed and registry entries into the catalog the rest of the pipeline
 * reads.
 *
 * Ordering rules: seed entries first, in the rank order the seed file gives
 * them (curation beats popularity), then registry entries by GitHub stars,
 * most first, with entries we have no star count for after them in registry
 * order. Ids are unique (seed wins), and so are slugs (they name files and
 * URLs downstream).
 */

import type { Catalog, ServerEntry } from '../types.js';
import { normalizeRegistryItem } from './normalize.js';

export interface BuildCatalogOptions {
  /** Cap the catalog at this many servers, keeping the lowest ranks. */
  limit?: number;
  /**
   * Stargazer count per `repoUrl`, from the stars stage. Absent counts are
   * normal (no repo, not on GitHub, lookup unavailable) and only cost an entry
   * its position in the ranking.
   */
  stars?: ReadonlyMap<string, number>;
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
  const stars = options.stars ?? new Map<string, number>();
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
    servers.push(withPopularity(entry, stars));
    nextRegistryRank = Math.max(nextRegistryRank, Math.floor(entry.rank) + 1);
  }

  const registryEntries: ServerEntry[] = [];
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
    registryEntries.push(withPopularity(entry, stars));
  }

  // Ranks are assigned after the sort, so rank order is the published order.
  for (const entry of byStars(registryEntries)) {
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
 * Copy an entry, recording the star count fetched for its repository. Entries
 * with no count keep no `popularity` at all, so "we did not look" and "the
 * repo has zero stars" stay different facts on disk.
 */
function withPopularity(entry: ServerEntry, stars: ReadonlyMap<string, number>): ServerEntry {
  const copy: ServerEntry = { ...entry };
  const count = entry.repoUrl === undefined ? undefined : stars.get(entry.repoUrl);
  if (count !== undefined) copy.popularity = { ...copy.popularity, stars: count };
  return copy;
}

/**
 * Most stars first; entries with no count follow in registry order, and ties
 * keep registry order too. Stability matters downstream: sharding is derived
 * from rank, so an entry that gains no stars should not move between sweeps.
 */
function byStars(entries: readonly ServerEntry[]): ServerEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, stars: entry.popularity?.stars }))
    .sort((a, b) => {
      if (a.stars === b.stars) return a.index - b.index;
      if (a.stars === undefined) return 1;
      if (b.stars === undefined) return -1;
      return b.stars - a.stars;
    })
    .map((ranked) => ranked.entry);
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
