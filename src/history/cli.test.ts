import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProbeStatus, RunFile } from '../types.js';
import { parseArgs, run } from './cli.js';
import { DEFAULT_HISTORY_DIR, DEFAULT_RUNS_DIR } from './io.js';

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<{ runsDir: string; historyDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dii-merge-cli-'));
  tempDirs.push(root);
  const runsDir = join(root, 'runs');
  await mkdir(runsDir, { recursive: true });
  return { runsDir, historyDir: join(root, 'history') };
}

function makeRun(runId: string, startedAt: string, status: ProbeStatus): RunFile {
  return {
    runId,
    platform: 'linux',
    harnessVersion: '0.1.0',
    startedAt,
    nodeVersion: 'v22.0.0',
    osVersion: 'linux 6.0',
    results: [
      {
        serverId: 'io.github.acme/thing',
        slug: 'io.github.acme__thing',
        platform: 'linux',
        method: 'npm',
        status,
        phases: {},
        startedAt,
        durationMs: 100,
      },
    ],
  };
}

function captureStderr(): () => string {
  const written: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return () => written.join('');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseArgs', () => {
  it('defaults to the pipeline directories', () => {
    expect(parseArgs([])).toEqual({
      runs: DEFAULT_RUNS_DIR,
      history: DEFAULT_HISTORY_DIR,
      help: false,
    });
  });

  it('accepts space- and equals-separated values', () => {
    expect(parseArgs(['--runs', 'a', '--history', 'b'])).toMatchObject({ runs: 'a', history: 'b' });
    expect(parseArgs(['--runs=a', '--history=b'])).toMatchObject({ runs: 'a', history: 'b' });
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('unknown argument "--bogus"');
    expect(() => parseArgs(['--runs'])).toThrow('--runs requires a value');
    expect(() => parseArgs(['--runs', '--history'])).toThrow('--runs requires a value');
  });
});

describe('run', () => {
  it('merges runs into history files and reports the summary on stderr', async () => {
    const { runsDir, historyDir } = await makeWorkspace();
    await writeFile(
      join(runsDir, 'r1-linux.json'),
      JSON.stringify(makeRun('run-1', '2026-08-01T00:00:00.000Z', 'pass')),
      'utf8',
    );
    await writeFile(
      join(runsDir, 'r2-linux.json'),
      JSON.stringify(makeRun('run-2', '2026-08-08T00:00:00.000Z', 'install_failed')),
      'utf8',
    );
    const stderr = captureStderr();

    await run(['--runs', runsDir, '--history', historyDir]);

    const text = await readFile(join(historyDir, 'io.github.acme__thing.json'), 'utf8');
    expect(JSON.parse(text)).toEqual({
      platforms: {
        linux: [
          { date: '2026-08-08T00:00:00.000Z', method: 'npm', runId: 'run-2', status: 'install_failed' },
          { date: '2026-08-01T00:00:00.000Z', method: 'npm', runId: 'run-1', status: 'pass' },
        ],
      },
      serverId: 'io.github.acme/thing',
      slug: 'io.github.acme__thing',
    });
    expect(stderr()).toMatch(/merge: 2 runs, 1 servers updated/);
  });

  it('is a no-op on a second run: same bytes, nothing reported as updated', async () => {
    const { runsDir, historyDir } = await makeWorkspace();
    await writeFile(
      join(runsDir, 'r1-linux.json'),
      JSON.stringify(makeRun('run-1', '2026-08-01T00:00:00.000Z', 'pass')),
      'utf8',
    );
    captureStderr();
    await run(['--runs', runsDir, '--history', historyDir]);
    const first = await readFile(join(historyDir, 'io.github.acme__thing.json'), 'utf8');

    const stderr = captureStderr();
    await run(['--runs', runsDir, '--history', historyDir]);

    expect(await readFile(join(historyDir, 'io.github.acme__thing.json'), 'utf8')).toBe(first);
    expect(stderr()).toMatch(/merge: 1 runs, 0 servers updated/);
  });

  it('fails when the runs directory has no readable run files', async () => {
    const { runsDir, historyDir } = await makeWorkspace();
    await writeFile(join(runsDir, 'junk.json'), 'not json', 'utf8');
    captureStderr();

    await expect(run(['--runs', runsDir, '--history', historyDir])).rejects.toThrow(
      /no readable run files in/,
    );
  });

  it('warns about unreadable history files instead of overwriting them', async () => {
    const { runsDir, historyDir } = await makeWorkspace();
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, 'io.github.acme__thing.json'), 'corrupted', 'utf8');
    await writeFile(
      join(runsDir, 'r1-linux.json'),
      JSON.stringify(makeRun('run-1', '2026-08-01T00:00:00.000Z', 'pass')),
      'utf8',
    );
    const stderr = captureStderr();

    await run(['--runs', runsDir, '--history', historyDir]);

    expect(await readFile(join(historyDir, 'io.github.acme__thing.json'), 'utf8')).toBe('corrupted');
    expect(stderr()).toMatch(/left 1 unreadable history file\(s\) untouched: io\.github\.acme__thing/);
    expect(stderr()).toMatch(/merge: 1 runs, 0 servers updated/);
  });

  it('prints usage for --help without touching the filesystem', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await run(['--help']);

    expect(String(stdout.mock.calls[0]?.[0])).toMatch(/Usage: npm run merge/);
  });
});
