import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalog, parseCatalog } from './catalog.js';

const tempDirs: string[] = [];

async function catalogFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dii-site-catalog-'));
  tempDirs.push(dir);
  const path = join(dir, 'catalog.json');
  await writeFile(path, contents, 'utf8');
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const VALID = {
  generatedAt: '2026-08-14T00:00:00.000Z',
  servers: [
    {
      id: 'io.github.acme/thing',
      slug: 'io.github.acme__thing',
      title: 'Thing',
      description: 'Does things.',
      repoUrl: 'https://example.test/repo',
      packages: [
        {
          kind: 'npm',
          identifier: '@acme/thing',
          version: '1.2.3',
          packageArguments: ['--flag'],
          env: [{ name: 'ACME_KEY', required: true, secret: true }],
        },
        { kind: 'brew', identifier: 'thing' },
        { kind: 'npm' },
      ],
      remotes: [
        { type: 'streamable-http', url: 'https://mcp.example.test', headers: [] },
        { type: 'carrier-pigeon', url: 'https://nope.example.test' },
      ],
      source: 'seed',
      rank: 4,
    },
  ],
};

describe('parseCatalog', () => {
  it('keeps the fields pages need and drops unknown distributions', () => {
    const catalog = parseCatalog(VALID);
    expect(catalog.generatedAt).toBe('2026-08-14T00:00:00.000Z');
    expect(catalog.servers).toHaveLength(1);

    const server = catalog.servers[0];
    expect(server).toMatchObject({
      id: 'io.github.acme/thing',
      slug: 'io.github.acme__thing',
      title: 'Thing',
      description: 'Does things.',
      repoUrl: 'https://example.test/repo',
      source: 'seed',
      rank: 4,
    });
    expect(server?.packages).toEqual([
      {
        kind: 'npm',
        identifier: '@acme/thing',
        version: '1.2.3',
        packageArguments: ['--flag'],
        env: [{ name: 'ACME_KEY', required: true, secret: true }],
      },
    ]);
    expect(server?.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.example.test', headers: [] },
    ]);
  });

  it('fills in defaults for optional metadata', () => {
    const catalog = parseCatalog({
      servers: [{ id: 'x/y', slug: 'x__y', packages: 'nonsense' }],
    });
    expect(catalog.generatedAt).toBe('');
    expect(catalog.servers[0]).toEqual({
      id: 'x/y',
      slug: 'x__y',
      title: 'x/y',
      packages: [],
      remotes: [],
      source: 'registry',
      rank: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each([
    [42, /must be an object/],
    [{}, /servers must be an array/],
    [{ servers: [{ slug: 'a' }] }, /servers\[0\]: id must be a non-empty string/],
    [{ servers: [{ id: 'a' }] }, /servers\[0\]: slug must be a non-empty string/],
    [
      { servers: [{ id: 'a', slug: '../escape' }] },
      /servers\[0\]: slug "\.\.\/escape" is not a usable URL segment/,
    ],
    [{ servers: ['nope'] }, /servers\[0\]: must be an object/],
  ])('rejects %j', (document, expected) => {
    expect(() => parseCatalog(document)).toThrow(expected);
  });
});

describe('loadCatalog', () => {
  it('reads and validates a file', async () => {
    const path = await catalogFile(JSON.stringify(VALID));
    await expect(loadCatalog(path)).resolves.toMatchObject({ servers: [{ slug: 'io.github.acme__thing' }] });
  });

  it('explains a missing file', async () => {
    await expect(loadCatalog('does/not/exist.json')).rejects.toThrow(
      /cannot read catalog does\/not\/exist\.json:.*run the catalog stage first/s,
    );
  });

  it('explains invalid JSON', async () => {
    const path = await catalogFile('{ not json');
    await expect(loadCatalog(path)).rejects.toThrow(/is not valid JSON/);
  });

  it('names the file when an entry is malformed', async () => {
    const path = await catalogFile(JSON.stringify({ servers: [{ id: 'a' }] }));
    await expect(loadCatalog(path)).rejects.toThrow(
      /catalog .*catalog\.json: servers\[0\]: slug must be a non-empty string/,
    );
  });
});
