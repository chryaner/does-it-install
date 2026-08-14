/**
 * Sweep runner: choose which catalogued servers to probe, run them through a
 * bounded worker pool, and assemble the run file. One server hanging, crashing
 * or exploding must never take the sweep down.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { HARNESS_VERSION, type Catalog, type ProbeResult, type RunFile, type ServerEntry } from '../types.js';
import { resolveProbeOptions, type ProbeOptions } from './options.js';
import { probeServer } from './probe.js';
import { describeError } from './util.js';

export const DEFAULT_CONCURRENCY = 4;

/** `--shard i/N`: zero-based shard `index` out of `total`. */
export interface Shard {
  index: number;
  total: number;
}

export interface EntrySelection {
  /** Cap the ranked list before sharding (`--top`). */
  top?: number;
  shard?: Shard;
  /** Server ids or slugs; probe only these (`--only`, repeatable). */
  only?: readonly string[];
}

export interface SweepOptions extends ProbeOptions, EntrySelection {
  concurrency?: number;
  /** Progress sink. Defaults to one line per finished probe on stderr. */
  log?: (line: string) => void;
  /** Probe implementation. Injectable so tests can exercise the pool. */
  probe?: (entry: ServerEntry, options: ProbeOptions) => Promise<ProbeResult>;
}

/** `2026-08-14T03-00-00Z-a1b2c3`: sortable, unique per invocation. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/**
 * Applies `--only`, `--top` and `--shard` to the rank-ordered catalog.
 * Sharding is deterministic: entry `k` of the resulting list goes to shard
 * `k % total`, so every shard of a run covers the catalog exactly once.
 * Throws on selections that cannot be satisfied, since those are operator errors.
 */
export function selectEntries(catalog: Catalog, selection: EntrySelection = {}): ServerEntry[] {
  let entries = [...(catalog.servers ?? [])].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  const only = selection.only;
  if (only && only.length > 0) {
    const wanted = new Set(only);
    const missing = only.filter(name => !entries.some(entry => entry.id === name || entry.slug === name));
    if (missing.length > 0) {
      throw new Error(`--only matched no catalog entry: ${missing.join(', ')}`);
    }
    entries = entries.filter(entry => wanted.has(entry.id) || wanted.has(entry.slug));
  }

  const top = selection.top;
  if (top !== undefined) {
    if (!Number.isInteger(top) || top <= 0) throw new Error(`--top must be a positive integer, got ${top}`);
    entries = entries.slice(0, top);
  }

  const shard = selection.shard;
  if (shard) {
    if (!Number.isInteger(shard.total) || shard.total <= 0) {
      throw new Error(`--shard total must be a positive integer, got ${shard.total}`);
    }
    if (!Number.isInteger(shard.index) || shard.index < 0 || shard.index >= shard.total) {
      throw new Error(`--shard index must be between 0 and ${shard.total - 1}, got ${shard.index}`);
    }
    entries = entries.filter((_entry, k) => k % shard.total === shard.index);
  }

  return entries;
}

export async function runSweep(catalog: Catalog, options: SweepOptions = {}): Promise<RunFile> {
  const probeOptions = resolveProbeOptions(options);
  const entries = selectEntries(catalog, options);
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY));
  const log =
    options.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const probe = options.probe ?? probeServer;

  const startedAt = new Date();
  const results: ProbeResult[] = new Array<ProbeResult>(entries.length);
  let nextIndex = 0;
  let completed = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (!entry) return;

      const probeStartedAt = new Date();
      const probeStartedMs = Date.now();
      let result: ProbeResult;
      try {
        result = await probe(entry, probeOptions);
      } catch (err) {
        // probeServer is written never to throw; if it ever does, the sweep
        // still finishes and says what happened.
        result = {
          serverId: entry.id,
          slug: entry.slug,
          platform: probeOptions.platform,
          method: 'none',
          status: 'skipped',
          phases: {},
          errorExcerpt: `harness error: ${describeError(err)}`,
          startedAt: probeStartedAt.toISOString(),
          durationMs: Date.now() - probeStartedMs
        };
      }
      results[index] = result;
      completed += 1;
      const seconds = (result.durationMs / 1000).toFixed(1);
      log(`[${completed}/${entries.length}] ${entry.id} ... ${result.status} (${seconds}s)`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));

  return {
    runId: newRunId(startedAt),
    platform: probeOptions.platform,
    harnessVersion: HARNESS_VERSION,
    startedAt: startedAt.toISOString(),
    nodeVersion: process.version,
    osVersion: os.release(),
    results
  };
}

/** Counts of each status in a run, for the CLI summary. */
export function summarize(results: readonly ProbeResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return counts;
}
