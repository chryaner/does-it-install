/**
 * Folding sweep runs into per-server history.
 *
 * The merge stage is re-run on every sweep and on re-uploaded artifacts, so it
 * has to be idempotent: a `runId` already recorded for a platform is never
 * added twice. Servers that no run mentions keep their existing history byte
 * for byte — rot data is the product, and a server dropping out of the catalog
 * must not erase what we already know about it.
 */

import {
  HISTORY_LIMIT,
  type HistoryEntry,
  type ProbeResult,
  type RunFile,
  type ServerHistory,
} from '../types.js';
import { PLATFORMS } from './platforms.js';

/**
 * Merge every result in `runFiles` into `existing`, keyed by slug.
 *
 * Returns a new map; neither `existing` nor its arrays are mutated (individual
 * `HistoryEntry` objects are shared and treated as immutable). Platform arrays
 * that gained an entry are re-sorted newest-first and capped at
 * `HISTORY_LIMIT`; arrays nothing was added to are left exactly as they were.
 */
export function mergeRuns(
  runFiles: readonly RunFile[],
  existing: ReadonlyMap<string, ServerHistory>,
): Map<string, ServerHistory> {
  const merged = new Map<string, ServerHistory>();
  for (const [slug, history] of existing) merged.set(slug, cloneHistory(history));

  const touched = new Set<HistoryEntry[]>();

  for (const run of runFiles) {
    for (const result of run.results) {
      let history = merged.get(result.slug);
      if (!history) {
        history = { serverId: result.serverId, slug: result.slug, platforms: {} };
        merged.set(result.slug, history);
      }

      let entries = history.platforms[result.platform];
      if (!entries) {
        entries = [];
        history.platforms[result.platform] = entries;
      }

      // Idempotency: one entry per runId per platform, first result wins.
      if (entries.some((entry) => entry.runId === run.runId)) continue;

      entries.push(toEntry(run, result));
      touched.add(entries);
    }
  }

  for (const entries of touched) {
    entries.sort(newestFirst);
    if (entries.length > HISTORY_LIMIT) entries.length = HISTORY_LIMIT;
  }

  return merged;
}

/**
 * The history entry a result contributes. `date` and `runId` come from the run
 * file rather than the individual result so every entry of one sweep sorts
 * together, whatever order the probes finished in.
 */
function toEntry(run: RunFile, result: ProbeResult): HistoryEntry {
  const entry: HistoryEntry = {
    runId: run.runId,
    date: run.startedAt,
    status: result.status,
    method: result.method,
  };
  if (typeof result.toolCount === 'number') entry.toolCount = result.toolCount;
  if (result.errorExcerpt) entry.errorExcerpt = result.errorExcerpt;
  return entry;
}

/** Newest first by date, breaking ties on runId descending so sorts are stable. */
function newestFirst(a: HistoryEntry, b: HistoryEntry): number {
  const at = timestamp(a.date);
  const bt = timestamp(b.date);
  if (at !== bt) return bt - at;
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? 1 : -1;
}

/** Unparseable dates sort last rather than poisoning the comparison with NaN. */
function timestamp(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function cloneHistory(history: ServerHistory): ServerHistory {
  const platforms: ServerHistory['platforms'] = {};
  for (const platform of PLATFORMS) {
    const entries = history.platforms[platform];
    if (entries) platforms[platform] = [...entries];
  }
  return { serverId: history.serverId, slug: history.slug, platforms };
}
