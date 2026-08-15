/**
 * Sweep runner: choose which catalogued servers to probe, run them through a
 * bounded worker pool, give install timeouts one uncontended retry, and
 * assemble the run file. One server hanging, crashing or exploding must never
 * take the sweep down.
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
  /**
   * Epoch ms after which workers stop picking new entries. Probes already in
   * flight finish and are recorded; entries never started are simply absent
   * from the run file. This exists so a slow platform degrades to partial
   * data instead of hitting the CI job timeout and losing the whole shard.
   */
  deadline?: number;
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

  const pastDeadline = (): boolean => options.deadline !== undefined && Date.now() >= options.deadline;

  const probeOnce = async (entry: ServerEntry, withOptions: ProbeOptions): Promise<ProbeResult> => {
    const probeStartedAt = new Date();
    const probeStartedMs = Date.now();
    try {
      return await probe(entry, withOptions);
    } catch (err) {
      // probeServer is written never to throw; if it ever does, the sweep
      // still finishes and says what happened.
      return {
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
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (pastDeadline()) return;
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (!entry) return;

      const result = await probeOnce(entry, probeOptions);
      results[index] = result;
      completed += 1;
      log(`[${completed}/${entries.length}] ${entry.id} ... ${result.status} (${seconds(result.durationMs)}s)`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));

  // Second chance: the pool runs `concurrency` probes at once on runners with
  // about that many cores, so a package that compiles native code during
  // install can lose the race for CPU and blow its budget while it would have
  // fit comfortably on its own. That is the one failure the sweep itself
  // causes, so those entries get re-probed alone before the result stands.
  const retries = installTimeouts(entries, results);
  if (retries.length > 0 && !pastDeadline()) {
    log(`second chance: ${retries.length} install timeout${retries.length === 1 ? '' : 's'}, retrying serially`);

    // Double the install budget for the retry: it exists to answer "was it
    // just slow?", it runs alone so the extra time is bounded to these few
    // entries, and a package that cannot install in twenty uncontended
    // minutes is broken in practice.
    const retryOptions: ProbeOptions = {
      ...probeOptions,
      timeouts: { ...probeOptions.timeouts, install: probeOptions.timeouts.install * 2 }
    };

    let retried = 0;
    for (const [index, entry] of retries) {
      // A retry that would start after the deadline is not started at all;
      // that entry keeps its contended result.
      if (pastDeadline()) break;
      const result = await probeOnce(entry, retryOptions);
      // Whatever it says, the uncontended measurement is the truer one.
      results[index] = result;
      retried += 1;
      log(`second chance [${retried}/${retries.length}] ${entry.id} ... ${result.status} (${seconds(result.durationMs)}s)`);
    }
  }

  // Preallocated slots for entries the deadline cut off stay empty.
  const probed = results.filter((result): result is ProbeResult => result !== undefined);
  if (probed.length < entries.length) {
    log(`deadline reached: ${probed.length}/${entries.length} probed, ${entries.length - probed.length} left for the next sweep`);
  }

  return {
    runId: newRunId(startedAt),
    platform: probeOptions.platform,
    harnessVersion: HARNESS_VERSION,
    startedAt: startedAt.toISOString(),
    nodeVersion: process.version,
    osVersion: os.release(),
    results: probed
  };
}

/**
 * Entries whose probe timed out while installing, paired with their slot in
 * `results` and kept in the original order. An install-phase timeout is the
 * only outcome CPU contention between workers plausibly explains: everything
 * later either talks to a process that already started or to a remote host.
 */
function installTimeouts(
  entries: readonly ServerEntry[],
  results: readonly (ProbeResult | undefined)[]
): [number, ServerEntry][] {
  const retryable: [number, ServerEntry][] = [];
  for (const [index, result] of results.entries()) {
    const entry = entries[index];
    if (entry === undefined || result === undefined) continue;
    if (result.status === 'timeout' && result.phases.install?.ok === false) {
      retryable.push([index, entry]);
    }
  }
  return retryable;
}

/** Probe duration the way every progress line reports it: `1.2` seconds. */
function seconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(1);
}

/** Counts of each status in a run, for the CLI summary. */
export function summarize(results: readonly ProbeResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return counts;
}
