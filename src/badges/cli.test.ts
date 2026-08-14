import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HISTORY_DIR } from '../history/io.js';
import type { ServerHistory, ShieldsBadge } from '../types.js';
import { DEFAULT_BADGE_DIR, parseArgs, run } from './cli.js';

const tempDirs: string[] = [];

const HISTORY: ServerHistory = {
  serverId: 'io.github.acme/thing',
  slug: 'io.github.acme__thing',
  platforms: {
    linux: [{ runId: 'run-2', date: '2026-08-08T00:00:00.000Z', status: 'pass', method: 'npm' }],
    win32: [
      {
        runId: 'run-2',
        date: '2026-08-08T00:00:00.000Z',
        status: 'install_failed',
        method: 'npm',
        errorExcerpt: 'EBADPLATFORM',
      },
    ],
  },
};

async function makeWorkspace(histories: ServerHistory[]): Promise<{ historyDir: string; outDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dii-badges-cli-'));
  tempDirs.push(root);
  const historyDir = join(root, 'history');
  await mkdir(historyDir, { recursive: true });
  for (const history of histories) {
    await writeFile(join(historyDir, `${history.slug}.json`), JSON.stringify(history), 'utf8');
  }
  return { historyDir, outDir: join(root, 'badge') };
}

function captureStderr(): () => string {
  const written: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return () => written.join('');
}

async function readBadge(dir: string, name: string): Promise<ShieldsBadge> {
  return JSON.parse(await readFile(join(dir, name), 'utf8')) as ShieldsBadge;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseArgs', () => {
  it('defaults to the pipeline directories', () => {
    expect(parseArgs([])).toEqual({
      history: DEFAULT_HISTORY_DIR,
      out: DEFAULT_BADGE_DIR,
      help: false,
    });
  });

  it('accepts space- and equals-separated values and rejects junk', () => {
    expect(parseArgs(['--history', 'h', '--out', 'o'])).toMatchObject({ history: 'h', out: 'o' });
    expect(parseArgs(['--history=h', '--out=o'])).toMatchObject({ history: 'h', out: 'o' });
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument "--nope"');
    expect(() => parseArgs(['--out'])).toThrow('--out requires a value');
  });
});

describe('run', () => {
  it('writes an overall badge plus one per platform with data', async () => {
    const { historyDir, outDir } = await makeWorkspace([HISTORY]);
    const stderr = captureStderr();

    await run(['--history', historyDir, '--out', outDir]);

    expect((await readdir(outDir)).sort()).toEqual([
      'io.github.acme__thing-linux.json',
      'io.github.acme__thing-win32.json',
      'io.github.acme__thing.json',
    ]);
    expect(await readBadge(outDir, 'io.github.acme__thing.json')).toEqual({
      schemaVersion: 1,
      label: 'does it install',
      message: 'failing on 1/2 platforms',
      color: 'orange',
      cacheSeconds: 3600,
    });
    expect(await readBadge(outDir, 'io.github.acme__thing-linux.json')).toMatchObject({
      message: 'passing',
      color: 'brightgreen',
    });
    expect(await readBadge(outDir, 'io.github.acme__thing-win32.json')).toMatchObject({
      message: 'install fails',
      color: 'red',
    });
    expect(stderr()).toMatch(/badges: 1 servers, 3 files/);
  });

  it('creates the output directory and skips histories it could not read', async () => {
    const { historyDir, outDir } = await makeWorkspace([HISTORY]);
    await writeFile(join(historyDir, 'broken.json'), '{oops', 'utf8');
    captureStderr();

    await run(['--history', historyDir, '--out', join(outDir, 'nested')]);

    expect((await readdir(join(outDir, 'nested'))).some((name) => name.startsWith('broken'))).toBe(false);
  });

  it('fails when there is no history to badge', async () => {
    const { historyDir, outDir } = await makeWorkspace([]);

    await expect(run(['--history', historyDir, '--out', outDir])).rejects.toThrow(
      /no readable history files in/,
    );
  });

  it('prints usage for --help', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await run(['--help']);

    expect(String(stdout.mock.calls[0]?.[0])).toMatch(/Usage: npm run badges/);
  });
});
