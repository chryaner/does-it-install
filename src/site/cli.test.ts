import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HISTORY_DIR } from '../history/io.js';
import type { Catalog, ServerHistory } from '../types.js';
import {
  DEFAULT_BASE,
  DEFAULT_CATALOG_PATH,
  DEFAULT_OUT_DIR,
  DEFAULT_SITE_URL,
  parseArgs,
  run,
} from './cli.js';

const tempDirs: string[] = [];

const CATALOG: Catalog = {
  generatedAt: '2026-08-14T02:00:00.000Z',
  servers: [
    {
      id: 'seed/everything',
      slug: 'seed__everything',
      title: 'Everything',
      packages: [{ kind: 'npm', identifier: '@modelcontextprotocol/server-everything', env: [] }],
      remotes: [],
      source: 'seed',
      rank: 1,
    },
  ],
};

const HISTORY: ServerHistory = {
  serverId: 'seed/everything',
  slug: 'seed__everything',
  platforms: {
    linux: [
      { runId: 'run-1', date: '2026-08-14T03:00:00.000Z', status: 'pass', method: 'npm', toolCount: 9 },
    ],
  },
};

interface Workspace {
  catalogPath: string;
  historyDir: string;
  outDir: string;
}

async function makeWorkspace(options: { history?: ServerHistory[] } = {}): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'dii-site-cli-'));
  tempDirs.push(root);

  const catalogPath = join(root, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify(CATALOG), 'utf8');

  const historyDir = join(root, 'history');
  if (options.history) {
    await mkdir(historyDir, { recursive: true });
    for (const history of options.history) {
      await writeFile(join(historyDir, `${history.slug}.json`), JSON.stringify(history), 'utf8');
    }
  }

  return { catalogPath, historyDir, outDir: join(root, 'public') };
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
  it('defaults to the pipeline paths', () => {
    expect(parseArgs([])).toEqual({
      catalog: DEFAULT_CATALOG_PATH,
      history: DEFAULT_HISTORY_DIR,
      out: DEFAULT_OUT_DIR,
      base: DEFAULT_BASE,
      siteUrl: DEFAULT_SITE_URL,
      help: false,
    });
  });

  it('accepts space- and equals-separated values', () => {
    const expected = {
      catalog: 'c.json',
      history: 'h',
      out: 'o',
      base: '/does-it-install/',
      siteUrl: 'https://example.test',
      help: false,
    };
    expect(
      parseArgs([
        '--catalog',
        'c.json',
        '--history',
        'h',
        '--out',
        'o',
        '--base',
        '/does-it-install/',
        '--site-url',
        'https://example.test',
      ]),
    ).toEqual(expected);
    expect(
      parseArgs([
        '--catalog=c.json',
        '--history=h',
        '--out=o',
        '--base=/does-it-install/',
        '--site-url=https://example.test',
      ]),
    ).toEqual(expected);
  });

  it('recognizes both help flags', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it.each([
    [['--nope'], /unknown argument "--nope"/],
    [['--out'], /--out requires a value/],
    [['--base='], /--base requires a value/],
    [['--catalog', '--out'], /--catalog requires a value/],
  ])('rejects %j', (argv, expected) => {
    expect(() => parseArgs(argv)).toThrow(expected);
  });
});

describe('run', () => {
  it('writes every page plus .nojekyll, with the base prefix applied', async () => {
    const { catalogPath, historyDir, outDir } = await makeWorkspace({ history: [HISTORY] });
    const stderr = captureStderr();

    await run([
      '--catalog',
      catalogPath,
      '--history',
      historyDir,
      '--out',
      outDir,
      '--base',
      '/does-it-install/',
      '--site-url',
      'https://acme.github.io/does-it-install',
    ]);

    expect((await readdir(outDir)).sort()).toEqual([
      '.nojekyll',
      '404.html',
      'index.html',
      'methodology.html',
      's',
    ]);
    expect(await readdir(join(outDir, 's'))).toEqual(['seed__everything.html']);
    expect(await readFile(join(outDir, '.nojekyll'), 'utf8')).toBe('');

    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(index).toContain('href="/does-it-install/s/seed__everything.html"');
    expect(index).toContain('<div class="count pass"><b>1</b><span>passing</span></div>');

    const server = await readFile(join(outDir, 's', 'seed__everything.html'), 'utf8');
    expect(server).toContain(
      'https://img.shields.io/endpoint?url=https://acme.github.io/does-it-install/badge/seed__everything.json',
    );
    expect(stderr()).toContain('site: 1 servers, 1 with history, 4 pages');
  });

  it('treats a missing history directory as "everything untested"', async () => {
    const { catalogPath, historyDir, outDir } = await makeWorkspace();
    captureStderr();

    await run(['--catalog', catalogPath, '--history', historyDir, '--out', outDir]);

    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(index).toContain('<div class="count none"><b>1</b><span>untested</span></div>');
    expect(index).toContain('<td class="when">never</td>');
  });

  it('leaves other files in the output directory alone', async () => {
    const { catalogPath, historyDir, outDir } = await makeWorkspace();
    captureStderr();
    await mkdir(join(outDir, 'badge'), { recursive: true });
    await writeFile(join(outDir, 'badge', 'seed__everything.json'), '{}', 'utf8');

    await run(['--catalog', catalogPath, '--history', historyDir, '--out', outDir]);

    expect(await readFile(join(outDir, 'badge', 'seed__everything.json'), 'utf8')).toBe('{}');
  });

  it('fails with a useful message when the catalog is missing', async () => {
    const { historyDir, outDir } = await makeWorkspace();
    captureStderr();

    await expect(
      run(['--catalog', join(outDir, 'nope.json'), '--history', historyDir, '--out', outDir]),
    ).rejects.toThrow(/cannot read catalog .*nope\.json/);
  });

  it('prints usage for --help without writing anything', async () => {
    const { outDir } = await makeWorkspace();
    const printed: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    });

    await run(['--help', '--out', outDir]);

    expect(printed.join('')).toContain('Usage: npm run site');
    await expect(readdir(outDir)).rejects.toThrow(/ENOENT/);
  });
});
