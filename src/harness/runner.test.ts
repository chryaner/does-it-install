import { describe, expect, it } from 'vitest';
import { HARNESS_VERSION, type Catalog, type ProbeResult, type ServerEntry } from '../types.js';
import { DEFAULT_TIMEOUTS } from './options.js';
import { newRunId, runSweep, selectEntries, summarize } from './runner.js';

const server = (rank: number): ServerEntry => ({
  id: `io.github.acme/server-${rank}`,
  slug: `io.github.acme__server-${rank}`,
  title: `Server ${rank}`,
  packages: [],
  remotes: [],
  source: 'registry',
  rank
});

const catalog = (count: number): Catalog => ({
  generatedAt: '2026-08-14T00:00:00.000Z',
  servers: Array.from({ length: count }, (_unused, index) => server(index + 1))
});

const ids = (entries: ServerEntry[]): number[] => entries.map(entry => entry.rank);

const fakeResult = (entry: ServerEntry): ProbeResult => ({
  serverId: entry.id,
  slug: entry.slug,
  platform: 'linux',
  method: 'npm',
  status: 'pass',
  phases: {},
  startedAt: '2026-08-14T00:00:00.000Z',
  durationMs: 1_234
});

/** What the pool records when a probe runs out of time while installing. */
const installTimeout = (entry: ServerEntry): ProbeResult => ({
  ...fakeResult(entry),
  status: 'timeout',
  phases: { install: { ok: false, durationMs: 600_000 } }
});

/** Attempt number for this entry, so a probe can answer differently on a retry. */
const attempt = (attempts: Map<string, number>, entry: ServerEntry): number => {
  const count = (attempts.get(entry.id) ?? 0) + 1;
  attempts.set(entry.id, count);
  return count;
};

describe('selectEntries', () => {
  it('orders by rank before anything else', () => {
    const unordered: Catalog = { generatedAt: '', servers: [server(3), server(1), server(2)] };
    expect(ids(selectEntries(unordered))).toEqual([1, 2, 3]);
  });

  it('caps the ranked list with top', () => {
    expect(ids(selectEntries(catalog(10), { top: 3 }))).toEqual([1, 2, 3]);
  });

  it('gives ranked entry k to shard k % total', () => {
    const shards = [0, 1, 2].map(index => ids(selectEntries(catalog(10), { shard: { index, total: 3 } })));
    expect(shards[0]).toEqual([1, 4, 7, 10]);
    expect(shards[1]).toEqual([2, 5, 8]);
    expect(shards[2]).toEqual([3, 6, 9]);
    // Every entry lands in exactly one shard.
    expect(shards.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('shards the capped list, not the whole catalog', () => {
    expect(ids(selectEntries(catalog(10), { top: 4, shard: { index: 1, total: 2 } }))).toEqual([2, 4]);
  });

  it('matches --only by id or slug', () => {
    const selected = selectEntries(catalog(5), {
      only: ['io.github.acme/server-2', 'io.github.acme__server-4']
    });
    expect(ids(selected)).toEqual([2, 4]);
  });

  it('refuses an --only that matches nothing', () => {
    expect(() => selectEntries(catalog(3), { only: ['nope'] })).toThrow(/--only matched no catalog entry: nope/);
  });

  it('rejects impossible shards and tops', () => {
    expect(() => selectEntries(catalog(3), { shard: { index: 2, total: 2 } })).toThrow(/between 0 and 1/);
    expect(() => selectEntries(catalog(3), { shard: { index: 0, total: 0 } })).toThrow(/positive integer/);
    expect(() => selectEntries(catalog(3), { top: 0 })).toThrow(/positive integer/);
  });
});

describe('newRunId', () => {
  it('is a sortable basic-ISO stamp with a random suffix', () => {
    const runId = newRunId(new Date('2026-08-14T03:00:00.000Z'));
    expect(runId).toMatch(/^2026-08-14T03-00-00Z-[0-9a-f]{6}$/);
    expect(newRunId(new Date('2026-08-14T03:00:00.000Z'))).not.toBe(runId);
  });
});

describe('runSweep', () => {
  it('assembles a run file describing this platform and harness', async () => {
    const run = await runSweep(catalog(3), {
      platform: 'linux',
      log: () => {},
      probe: async entry => fakeResult(entry)
    });

    expect(run.runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{6}$/);
    expect(run.platform).toBe('linux');
    expect(run.harnessVersion).toBe(HARNESS_VERSION);
    expect(run.nodeVersion).toBe(process.version);
    expect(run.osVersion).not.toBe('');
    expect(run.results.map(result => result.serverId)).toEqual([
      'io.github.acme/server-1',
      'io.github.acme/server-2',
      'io.github.acme/server-3'
    ]);
  });

  it('runs no more than `concurrency` probes at once and still covers everything', async () => {
    let inFlight = 0;
    let peak = 0;

    const run = await runSweep(catalog(9), {
      platform: 'linux',
      concurrency: 3,
      log: () => {},
      probe: async entry => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight -= 1;
        return fakeResult(entry);
      }
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(run.results).toHaveLength(9);
  });

  it('records a probe that throws instead of losing the sweep', async () => {
    const lines: string[] = [];
    const run = await runSweep(catalog(2), {
      platform: 'linux',
      concurrency: 1,
      log: line => lines.push(line),
      probe: async entry => {
        if (entry.rank === 1) throw new Error('probe exploded');
        return fakeResult(entry);
      }
    });

    expect(run.results).toHaveLength(2);
    expect(run.results[0]?.status).toBe('skipped');
    expect(run.results[0]?.errorExcerpt).toContain('harness error: probe exploded');
    expect(run.results[1]?.status).toBe('pass');
    expect(lines).toEqual([
      '[1/2] io.github.acme/server-1 ... skipped (0.0s)',
      '[2/2] io.github.acme/server-2 ... pass (1.2s)'
    ]);
  });

  it('produces an empty run rather than failing when nothing is selected', async () => {
    const run = await runSweep(catalog(0), { platform: 'linux', log: () => {} });
    expect(run.results).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts results by status', () => {
    const results = [
      { ...fakeResult(server(1)), status: 'pass' as const },
      { ...fakeResult(server(2)), status: 'pass' as const },
      { ...fakeResult(server(3)), status: 'install_failed' as const }
    ];
    expect(summarize(results)).toEqual({ pass: 2, install_failed: 1 });
  });
});

describe('runSweep deadline', () => {
  it('an already-passed deadline probes nothing and says so', async () => {
    const lines: string[] = [];
    const run = await runSweep(catalog(5), {
      deadline: Date.now() - 1,
      log: line => lines.push(line),
      probe: async entry => fakeResult(entry)
    });
    expect(run.results).toEqual([]);
    expect(lines.some(line => line.includes('deadline reached: 0/5'))).toBe(true);
  });

  it('a future deadline changes nothing', async () => {
    const lines: string[] = [];
    const run = await runSweep(catalog(5), {
      deadline: Date.now() + 60_000,
      log: line => lines.push(line),
      probe: async entry => fakeResult(entry)
    });
    expect(run.results).toHaveLength(5);
    expect(lines.some(line => line.includes('deadline reached'))).toBe(false);
  });
});

describe('runSweep second chance', () => {
  it('re-probes install timeouts in their original order and keeps the retry result', async () => {
    const attempts = new Map<string, number>();
    const lines: string[] = [];

    const run = await runSweep(catalog(4), {
      platform: 'linux',
      concurrency: 4,
      log: line => lines.push(line),
      probe: async entry => {
        // The even ranks lose the race for CPU the first time round.
        const count = attempt(attempts, entry);
        return count === 1 && entry.rank % 2 === 0 ? installTimeout(entry) : fakeResult(entry);
      }
    });

    expect(run.results.map(result => result.serverId)).toEqual([
      'io.github.acme/server-1',
      'io.github.acme/server-2',
      'io.github.acme/server-3',
      'io.github.acme/server-4'
    ]);
    expect(run.results.map(result => result.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(attempts.get('io.github.acme/server-2')).toBe(2);
    expect(attempts.get('io.github.acme/server-1')).toBe(1);
    // Pool lines finish in whatever order the probes did; the retries come last.
    expect(lines.slice(-3)).toEqual([
      'second chance: 2 install timeouts, retrying serially',
      'second chance [1/2] io.github.acme/server-2 ... pass (1.2s)',
      'second chance [2/2] io.github.acme/server-4 ... pass (1.2s)'
    ]);
  });

  it('runs the retries one at a time, whatever the pool concurrency was', async () => {
    const attempts = new Map<string, number>();
    let inFlight = 0;
    let retryPeak = 0;

    await runSweep(catalog(4), {
      platform: 'linux',
      concurrency: 4,
      log: () => {},
      probe: async entry => {
        const count = attempt(attempts, entry);
        inFlight += 1;
        if (count === 2) retryPeak = Math.max(retryPeak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight -= 1;
        return count === 1 ? installTimeout(entry) : fakeResult(entry);
      }
    });

    expect(retryPeak).toBe(1);
  });

  it('gives the retry twice the install budget and leaves the other phases alone', async () => {
    const install: (number | undefined)[] = [];
    const handshake: (number | undefined)[] = [];

    await runSweep(catalog(1), {
      platform: 'linux',
      timeouts: { install: 600_000 },
      log: () => {},
      probe: async (entry, probeOptions) => {
        install.push(probeOptions.timeouts?.install);
        handshake.push(probeOptions.timeouts?.handshake);
        return install.length === 1 ? installTimeout(entry) : fakeResult(entry);
      }
    });

    expect(install).toEqual([600_000, 1_200_000]);
    expect(handshake).toEqual([DEFAULT_TIMEOUTS.handshake, DEFAULT_TIMEOUTS.handshake]);
  });

  it('does not retry a timeout that was not an install timeout', async () => {
    const attempts = new Map<string, number>();
    const lines: string[] = [];

    const run = await runSweep(catalog(2), {
      platform: 'linux',
      log: line => lines.push(line),
      probe: async entry => {
        attempt(attempts, entry);
        // Rank 1 installed fine and then hung on the handshake; rank 2 never
        // got far enough to record a phase at all.
        return entry.rank === 1
          ? {
              ...fakeResult(entry),
              status: 'timeout',
              phases: {
                install: { ok: true, durationMs: 900 },
                handshake: { ok: false, durationMs: 30_000 }
              }
            }
          : { ...fakeResult(entry), status: 'timeout', phases: {} };
      }
    });

    expect(run.results.map(result => result.status)).toEqual(['timeout', 'timeout']);
    expect(attempts.get('io.github.acme/server-1')).toBe(1);
    expect(attempts.get('io.github.acme/server-2')).toBe(1);
    expect(lines.some(line => line.startsWith('second chance'))).toBe(false);
  });

  it('keeps the retry result even when the retry is no better', async () => {
    const attempts = new Map<string, number>();

    const run = await runSweep(catalog(1), {
      platform: 'linux',
      log: () => {},
      probe: async entry =>
        attempt(attempts, entry) === 1
          ? installTimeout(entry)
          : {
              ...fakeResult(entry),
              status: 'install_failed',
              phases: { install: { ok: false, durationMs: 3_000 } },
              errorExcerpt: 'npm ERR! E404 not found'
            }
    });

    expect(run.results[0]?.status).toBe('install_failed');
    expect(run.results[0]?.errorExcerpt).toBe('npm ERR! E404 not found');
  });

  it('skips the second chance entirely when the deadline has already passed', async () => {
    const attempts = new Map<string, number>();
    const lines: string[] = [];

    const run = await runSweep(catalog(1), {
      platform: 'linux',
      deadline: Date.now() + 20,
      log: line => lines.push(line),
      probe: async entry => {
        attempt(attempts, entry);
        await new Promise(resolve => setTimeout(resolve, 40));
        return installTimeout(entry);
      }
    });

    expect(run.results[0]?.status).toBe('timeout');
    expect(attempts.get('io.github.acme/server-1')).toBe(1);
    expect(lines.some(line => line.startsWith('second chance'))).toBe(false);
  });

  it('stops retrying at the deadline and keeps the originals it did not reach', async () => {
    const attempts = new Map<string, number>();
    const lines: string[] = [];

    const run = await runSweep(catalog(2), {
      platform: 'linux',
      deadline: Date.now() + 150,
      log: line => lines.push(line),
      probe: async entry => {
        if (attempt(attempts, entry) === 1) return installTimeout(entry);
        // One retry is enough to run the clock out.
        await new Promise(resolve => setTimeout(resolve, 200));
        return fakeResult(entry);
      }
    });

    expect(run.results.map(result => result.status)).toEqual(['pass', 'timeout']);
    expect(attempts.get('io.github.acme/server-2')).toBe(1);
    expect(lines).toContain('second chance: 2 install timeouts, retrying serially');
    expect(lines.filter(line => line.startsWith('second chance [')).length).toBe(1);
    // Every entry was probed, so the sweep does not report a partial run.
    expect(lines.some(line => line.includes('deadline reached'))).toBe(false);
  });
});
