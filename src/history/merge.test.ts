import { describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  type HistoryEntry,
  type Platform,
  type ProbeResult,
  type RunFile,
  type ServerHistory,
} from '../types.js';
import { mergeRuns } from './merge.js';

function makeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    serverId: 'io.github.acme/thing',
    slug: 'io.github.acme__thing',
    platform: 'linux',
    method: 'npm',
    status: 'pass',
    phases: {},
    startedAt: '2026-08-01T00:00:00.000Z',
    durationMs: 1234,
    ...overrides,
  };
}

function makeRun(runId: string, startedAt: string, results: ProbeResult[], platform: Platform = 'linux'): RunFile {
  return {
    runId,
    platform,
    harnessVersion: '0.1.0',
    startedAt,
    nodeVersion: 'v22.0.0',
    osVersion: 'linux 6.0',
    results,
  };
}

function entries(map: Map<string, ServerHistory>, slug: string, platform: Platform): HistoryEntry[] {
  return map.get(slug)?.platforms[platform] ?? [];
}

describe('mergeRuns', () => {
  it('creates a history for a server it has never seen', () => {
    const run = makeRun('run-1', '2026-08-01T03:00:00.000Z', [
      makeResult({ status: 'pass', toolCount: 7 }),
    ]);

    const merged = mergeRuns([run], new Map());

    expect(merged.get('io.github.acme__thing')).toEqual({
      serverId: 'io.github.acme/thing',
      slug: 'io.github.acme__thing',
      platforms: {
        linux: [
          {
            runId: 'run-1',
            date: '2026-08-01T03:00:00.000Z',
            status: 'pass',
            method: 'npm',
            toolCount: 7,
          },
        ],
      },
    });
  });

  it('carries the error excerpt and omits absent optional fields', () => {
    const run = makeRun('run-1', '2026-08-01T03:00:00.000Z', [
      makeResult({ status: 'install_failed', errorExcerpt: 'E404 not found' }),
    ]);

    const [entry] = entries(mergeRuns([run], new Map()), 'io.github.acme__thing', 'linux');

    expect(entry).toEqual({
      runId: 'run-1',
      date: '2026-08-01T03:00:00.000Z',
      status: 'install_failed',
      method: 'npm',
      errorExcerpt: 'E404 not found',
    });
    expect(entry && 'toolCount' in entry).toBe(false);
  });

  it('is idempotent: merging the same run twice matches merging it once', () => {
    const run = makeRun('run-1', '2026-08-01T03:00:00.000Z', [makeResult()]);

    const once = mergeRuns([run], new Map());
    const twice = mergeRuns([run], once);
    const again = mergeRuns([run, run], new Map());

    expect(twice).toEqual(once);
    expect(again).toEqual(once);
    expect(entries(twice, 'io.github.acme__thing', 'linux')).toHaveLength(1);
  });

  it('keeps one entry per runId per platform when a run repeats a server', () => {
    const run = makeRun('run-1', '2026-08-01T03:00:00.000Z', [
      makeResult({ status: 'pass' }),
      makeResult({ status: 'timeout' }),
    ]);

    const merged = mergeRuns([run], new Map());

    expect(entries(merged, 'io.github.acme__thing', 'linux')).toEqual([
      { runId: 'run-1', date: '2026-08-01T03:00:00.000Z', status: 'pass', method: 'npm' },
    ]);
  });

  it('caps each platform at HISTORY_LIMIT, keeping the newest entries', () => {
    const dayAfterStart = (index: number): string =>
      new Date(Date.UTC(2026, 5, 1) + index * 86_400_000).toISOString();
    const runs = Array.from({ length: HISTORY_LIMIT + 5 }, (_unused, index) =>
      makeRun(`run-${String(index).padStart(3, '0')}`, dayAfterStart(index), [makeResult()]),
    );

    const linux = entries(mergeRuns(runs, new Map()), 'io.github.acme__thing', 'linux');

    expect(linux).toHaveLength(HISTORY_LIMIT);
    expect(linux[0]?.runId).toBe('run-034');
    expect(linux.at(-1)?.runId).toBe('run-005');
  });

  it('orders entries newest-first even when the runs arrive out of order', () => {
    const runs = [
      makeRun('run-b', '2026-07-02T00:00:00.000Z', [makeResult()]),
      makeRun('run-a', '2026-08-01T00:00:00.000Z', [makeResult()]),
      makeRun('run-c', '2026-07-01T00:00:00.000Z', [makeResult()]),
    ];

    const linux = entries(mergeRuns(runs, new Map()), 'io.github.acme__thing', 'linux');

    expect(linux.map((entry) => entry.runId)).toEqual(['run-a', 'run-b', 'run-c']);
  });

  it('breaks date ties on runId, descending', () => {
    const sameDate = '2026-07-02T00:00:00.000Z';
    const runs = [
      makeRun('run-a', sameDate, [makeResult()]),
      makeRun('run-c', sameDate, [makeResult()]),
      makeRun('run-b', sameDate, [makeResult()]),
    ];

    const linux = entries(mergeRuns(runs, new Map()), 'io.github.acme__thing', 'linux');

    expect(linux.map((entry) => entry.runId)).toEqual(['run-c', 'run-b', 'run-a']);
  });

  it('accumulates platforms independently, including the same runId on each', () => {
    const runs = [
      makeRun('run-1', '2026-08-01T03:00:00.000Z', [makeResult({ platform: 'linux' })], 'linux'),
      makeRun(
        'run-1',
        '2026-08-01T03:00:00.000Z',
        [makeResult({ platform: 'win32', status: 'install_failed' })],
        'win32',
      ),
      makeRun('run-2', '2026-08-08T03:00:00.000Z', [makeResult({ platform: 'darwin', status: 'timeout' })], 'darwin'),
    ];

    const merged = mergeRuns(runs, new Map());
    const history = merged.get('io.github.acme__thing');

    expect(Object.keys(history?.platforms ?? {}).sort()).toEqual(['darwin', 'linux', 'win32']);
    expect(entries(merged, 'io.github.acme__thing', 'linux')[0]?.status).toBe('pass');
    expect(entries(merged, 'io.github.acme__thing', 'win32')[0]?.status).toBe('install_failed');
    expect(entries(merged, 'io.github.acme__thing', 'darwin')[0]?.status).toBe('timeout');
  });

  it('preserves servers the runs do not mention and never mutates the input', () => {
    const goneEntries: HistoryEntry[] = [
      { runId: 'run-0', date: '2026-05-01T00:00:00.000Z', status: 'pass', method: 'pypi', toolCount: 3 },
      { runId: 'run-00', date: '2026-04-01T00:00:00.000Z', status: 'pass', method: 'pypi' },
    ];
    const existing = new Map<string, ServerHistory>([
      [
        'io.github.acme__gone',
        { serverId: 'io.github.acme/gone', slug: 'io.github.acme__gone', platforms: { darwin: goneEntries } },
      ],
      [
        'io.github.acme__thing',
        {
          serverId: 'io.github.acme/thing',
          slug: 'io.github.acme__thing',
          platforms: {
            linux: [{ runId: 'run-0', date: '2026-05-01T00:00:00.000Z', status: 'pass', method: 'npm' }],
          },
        },
      ],
    ]);
    const snapshot = structuredClone(existing);

    const merged = mergeRuns([makeRun('run-1', '2026-08-01T03:00:00.000Z', [makeResult()])], existing);

    expect(merged.get('io.github.acme__gone')).toEqual(existing.get('io.github.acme__gone'));
    expect(entries(merged, 'io.github.acme__thing', 'linux').map((entry) => entry.runId)).toEqual([
      'run-1',
      'run-0',
    ]);
    expect(existing).toEqual(snapshot);
    expect(goneEntries).toHaveLength(2);
  });
});
