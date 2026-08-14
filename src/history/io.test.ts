import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunFile, ServerHistory } from '../types.js';
import {
  loadHistoryDir,
  loadRunsDir,
  parseServerHistory,
  saveHistoryDir,
  serializeHistory,
} from './io.js';
import { mergeRuns } from './merge.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dii-history-'));
  tempDirs.push(dir);
  return dir;
}

function silenceStderr(): { lines: () => string[] } {
  const written: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return { lines: () => written };
}

const HISTORY: ServerHistory = {
  serverId: 'io.github.acme/thing',
  slug: 'io.github.acme__thing',
  platforms: {
    linux: [
      {
        runId: 'run-2',
        date: '2026-08-08T00:00:00.000Z',
        status: 'pass',
        method: 'npm',
        toolCount: 4,
        toolNames: ['echo', 'add', 'printEnv', 'longRunningOperation'],
      },
      { runId: 'run-1', date: '2026-08-01T00:00:00.000Z', status: 'timeout', method: 'npm' },
    ],
  },
};

const RUN: RunFile = {
  runId: 'run-3',
  platform: 'linux',
  harnessVersion: '0.1.0',
  startedAt: '2026-08-15T00:00:00.000Z',
  nodeVersion: 'v22.0.0',
  osVersion: 'linux 6.0',
  results: [
    {
      serverId: 'io.github.acme/thing',
      slug: 'io.github.acme__thing',
      platform: 'linux',
      method: 'npm',
      status: 'pass',
      phases: { install: { ok: true, durationMs: 900 }, handshake: { ok: true, durationMs: 20 } },
      toolCount: 4,
      toolNames: ['a', 'b'],
      serverInfo: { name: 'thing', version: '1.0.0' },
      startedAt: '2026-08-15T00:00:01.000Z',
      durationMs: 1500,
    },
  ],
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadHistoryDir', () => {
  it('returns an empty result for a directory that does not exist', async () => {
    const loaded = await loadHistoryDir(join(await makeTempDir(), 'nope'));

    expect(loaded.histories.size).toBe(0);
    expect(loaded.skipped.size).toBe(0);
  });

  it('reads history files and ignores non-JSON files', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, `${HISTORY.slug}.json`), serializeHistory(HISTORY), 'utf8');
    await writeFile(join(dir, 'README.md'), 'not history', 'utf8');

    const { histories, skipped } = await loadHistoryDir(dir);

    expect([...histories.keys()]).toEqual([HISTORY.slug]);
    expect(histories.get(HISTORY.slug)).toEqual(HISTORY);
    expect(skipped.size).toBe(0);
  });

  it('warns about a corrupt file, skips it, and reports its slug', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'broken.json'), '{"serverId": "x", "slug"', 'utf8');
    const stderr = silenceStderr();

    const { histories, skipped } = await loadHistoryDir(dir);

    expect(histories.size).toBe(0);
    expect([...skipped]).toEqual(['broken']);
    expect(stderr.lines().join('')).toMatch(/skipping history file .*broken\.json: invalid JSON/);
  });

  it.each([
    ['a slug that disagrees with the file name', { serverId: 'x', slug: 'other', platforms: {} }],
    ['a missing serverId', { slug: 'broken', platforms: {} }],
    ['an unknown platform key', { serverId: 'x', slug: 'broken', platforms: { solaris: [] } }],
    [
      'an unknown status',
      {
        serverId: 'x',
        slug: 'broken',
        platforms: { linux: [{ runId: 'r', date: 'd', status: 'exploded', method: 'npm' }] },
      },
    ],
  ])('treats %s as corrupt', async (_label, document) => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'broken.json'), JSON.stringify(document), 'utf8');
    silenceStderr();

    const { histories, skipped } = await loadHistoryDir(dir);

    expect(histories.size).toBe(0);
    expect([...skipped]).toEqual(['broken']);
  });
});

describe('saveHistoryDir', () => {
  it('writes pretty, key-sorted JSON that round-trips', async () => {
    const dir = await makeTempDir();

    const result = await saveHistoryDir(new Map([[HISTORY.slug, HISTORY]]), dir);
    const text = await readFile(join(dir, `${HISTORY.slug}.json`), 'utf8');

    expect(result).toEqual({ written: 1, preserved: [] });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')[1]).toBe('  "platforms": {');
    const { histories } = await loadHistoryDir(dir);
    expect(histories.get(HISTORY.slug)).toEqual(HISTORY);
  });

  it('is byte-identical whatever order the map was built in', async () => {
    const other: ServerHistory = { serverId: 'io.github.acme/two', slug: 'two', platforms: {} };
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();

    await saveHistoryDir(
      new Map([
        [HISTORY.slug, HISTORY],
        [other.slug, other],
      ]),
      dirA,
    );
    await saveHistoryDir(
      new Map([
        [other.slug, other],
        [HISTORY.slug, HISTORY],
      ]),
      dirB,
    );

    for (const name of [`${HISTORY.slug}.json`, `${other.slug}.json`]) {
      expect(await readFile(join(dirA, name), 'utf8')).toBe(await readFile(join(dirB, name), 'utf8'));
    }
  });

  it('leaves skipped slugs on disk untouched, even when a run produced new data', async () => {
    const dir = await makeTempDir();
    const corrupt = '{ this is not json';
    await writeFile(join(dir, `${HISTORY.slug}.json`), corrupt, 'utf8');
    silenceStderr();

    const { histories, skipped } = await loadHistoryDir(dir);
    const merged = mergeRuns([RUN], histories);
    const result = await saveHistoryDir(merged, dir, { skip: skipped });

    expect(result).toEqual({ written: 0, preserved: [HISTORY.slug] });
    expect(await readFile(join(dir, `${HISTORY.slug}.json`), 'utf8')).toBe(corrupt);
  });

  it('creates the output directory when it is missing', async () => {
    const dir = join(await makeTempDir(), 'nested', 'history');

    await saveHistoryDir(new Map([[HISTORY.slug, HISTORY]]), dir);

    expect((await loadHistoryDir(dir)).histories.size).toBe(1);
  });
});

describe('loadRunsDir', () => {
  it('reads run artifacts in file-name order and keeps their result fields', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'b-run.json'), JSON.stringify({ ...RUN, runId: 'run-b' }), 'utf8');
    await writeFile(join(dir, 'a-run.json'), JSON.stringify({ ...RUN, runId: 'run-a' }), 'utf8');

    const runs = await loadRunsDir(dir);

    expect(runs.map((run) => run.runId)).toEqual(['run-a', 'run-b']);
    expect(runs[0]?.results[0]).toEqual(RUN.results[0]);
  });

  it('returns an empty list for a missing directory', async () => {
    expect(await loadRunsDir(join(await makeTempDir(), 'nope'))).toEqual([]);
  });

  it('skips unparseable run files with a warning and keeps the good ones', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'bad.json'), '[]', 'utf8');
    await writeFile(join(dir, 'no-results.json'), JSON.stringify({ ...RUN, results: undefined }), 'utf8');
    await writeFile(join(dir, 'ok.json'), JSON.stringify(RUN), 'utf8');
    const stderr = silenceStderr();

    const runs = await loadRunsDir(dir);

    expect(runs.map((run) => run.runId)).toEqual(['run-3']);
    expect(stderr.lines().join('')).toMatch(/skipping run file .*bad\.json: run must be an object/);
    expect(stderr.lines().join('')).toMatch(/no-results\.json: results must be an array/);
  });

  it('rejects a result whose slug could escape the history directory', async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, 'traversal.json'),
      JSON.stringify({
        ...RUN,
        results: [{ ...RUN.results[0], slug: '../../etc/passwd' }],
      }),
      'utf8',
    );
    const stderr = silenceStderr();

    expect(await loadRunsDir(dir)).toEqual([]);
    expect(stderr.lines().join('')).toMatch(
      /slug "\.\.\/\.\.\/etc\/passwd" is not usable as a file name/,
    );
  });

  it('defaults descriptive metadata but rejects a result with no identity', async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, 'sparse.json'),
      JSON.stringify({ runId: 'run-9', platform: 'darwin', startedAt: 'now', results: [] }),
      'utf8',
    );
    await writeFile(
      join(dir, 'broken-result.json'),
      JSON.stringify({ ...RUN, results: [{ slug: 'x', platform: 'linux', method: 'npm', status: 'pass' }] }),
      'utf8',
    );
    const stderr = silenceStderr();

    const runs = await loadRunsDir(dir);

    expect(runs).toEqual([
      {
        runId: 'run-9',
        platform: 'darwin',
        startedAt: 'now',
        harnessVersion: 'unknown',
        nodeVersion: 'unknown',
        osVersion: 'unknown',
        results: [],
      },
    ]);
    expect(stderr.lines().join('')).toMatch(/results\[0\]: serverId must be a non-empty string/);
  });
});

describe('parseServerHistory', () => {
  it('rejects a document that is not an object', () => {
    expect(() => parseServerHistory('nope', 'slug')).toThrow(/history must be an object/);
  });

  it('round-trips the tool names of an entry', () => {
    const parsed = parseServerHistory(JSON.parse(serializeHistory(HISTORY)), HISTORY.slug);

    expect(parsed.platforms.linux?.[0]?.toolNames).toEqual([
      'echo',
      'add',
      'printEnv',
      'longRunningOperation',
    ]);
    expect(parsed.platforms.linux?.[1] && 'toolNames' in parsed.platforms.linux[1]).toBe(false);
  });

  it('treats a tool name that is not a string as corrupt', () => {
    const document = {
      serverId: 'x',
      slug: 'broken',
      platforms: { linux: [{ runId: 'r', date: 'd', status: 'pass', method: 'npm', toolNames: [7] }] },
    };

    expect(() => parseServerHistory(document, 'broken')).toThrow(
      /toolNames\[0\] must be a non-empty string/,
    );
  });
});
