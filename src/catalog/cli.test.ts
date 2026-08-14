import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../types.js';
import { DEFAULT_OUT_PATH, parseArgs, run } from './cli.js';
import type { FetchLike } from './registry.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('parseArgs', () => {
  it('defaults to an online build into data/catalog.json', () => {
    expect(parseArgs([])).toEqual({ out: DEFAULT_OUT_PATH, offline: false, help: false });
  });

  it('accepts space- and equals-separated values', () => {
    expect(parseArgs(['--out', 'tmp/c.json', '--limit', '25', '--offline'])).toEqual({
      out: 'tmp/c.json',
      limit: 25,
      offline: true,
      help: false,
    });
    expect(parseArgs(['--out=tmp/c.json', '--limit=25'])).toMatchObject({
      out: 'tmp/c.json',
      limit: 25,
    });
  });

  it('recognizes both help flags', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it.each([
    [['--nope'], /unknown argument "--nope"/],
    [['--out'], /--out requires a value/],
    [['--out', '--offline'], /--out requires a value/],
    [['--limit', 'many'], /--limit must be a positive integer, got "many"/],
    [['--limit', '0'], /--limit must be a positive integer/],
    [['--limit', '2.5'], /--limit must be a positive integer/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('catalog cli', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'dii-catalog-cli-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const runCli = (args: string[]) =>
    execFileAsync('npx', ['tsx', 'src/catalog/cli.ts', ...args], { cwd: repoRoot });

  it('builds a seed-only catalog with --offline and summarizes to stderr', async () => {
    const out = join(workDir, 'nested', 'catalog.json');

    const { stderr } = await runCli(['--offline', '--out', out]);

    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    expect(catalog.servers.length).toBeGreaterThan(0);
    expect(catalog.servers.every((server) => server.source === 'seed')).toBe(true);
    expect(Number.isNaN(Date.parse(catalog.generatedAt))).toBe(false);
    expect(stderr).toMatch(new RegExp(`catalog: ${catalog.servers.length} servers`));
    expect(stderr).toContain(`registry 0`);
  });

  it('honours --limit', async () => {
    const out = join(workDir, 'limited.json');

    await runCli(['--offline', '--out', out, '--limit', '1']);

    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.servers[0]?.rank).toBe(1);
  });

  it('exits non-zero with a usable message on a bad flag', async () => {
    await expect(runCli(['--bogus'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('error: unknown argument "--bogus"'),
    });
  });

  it('prints usage for --help', async () => {
    const { stdout } = await runCli(['--help']);
    expect(stdout).toContain('Usage: npm run catalog');
    expect(stdout).toContain('--offline');
  });

  it('merges registry pages with the seed file on the online path', async () => {
    const out = join(workDir, 'online.json');
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes('cursor=')
        ? new Response(JSON.stringify({ servers: [{ server: { name: 'reg/two' } }], metadata: {} }))
        : new Response(
            JSON.stringify({
              servers: [{ server: { name: 'reg/one' } }],
              metadata: { nextCursor: 'next' },
            }),
          ),
    );
    const logged: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });

    try {
      await run(['--out', out], { fetchImpl });
    } finally {
      stderr.mockRestore();
    }

    const catalog = JSON.parse(await readFile(out, 'utf8')) as Catalog;
    const registryIds = catalog.servers.filter((s) => s.source === 'registry').map((s) => s.id);
    expect(registryIds).toEqual(['reg/one', 'reg/two']);
    expect(catalog.servers.some((s) => s.source === 'seed')).toBe(true);
    expect(logged.join('')).toMatch(/catalog: \d+ servers .*2 pages/);
  });

  it('fails loudly instead of writing a seed-only catalog when the registry is down', async () => {
    const out = join(workDir, 'never-written.json');
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(run(['--out', out], { fetchImpl })).rejects.toThrow(
      /registry fetch failed: registry page 1 failed after one retry: fetch failed.*--offline/s,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one retry, then give up
    await expect(readFile(out, 'utf8')).rejects.toThrow(/ENOENT/);
  });
});
