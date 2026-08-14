import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SEED_PATH, loadSeed, parseSeed } from './seed.js';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dii-seed-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeSeed(name: string, document: unknown): Promise<string> {
  const file = join(workDir, name);
  await writeFile(file, JSON.stringify(document), 'utf8');
  return file;
}

describe('parseSeed', () => {
  it('fills in slug, source and rank defaults', () => {
    const entries = parseSeed({
      servers: [
        { id: 'seed/one', title: 'One' },
        { id: 'seed/two' },
      ],
    });

    expect(entries).toEqual([
      {
        id: 'seed/one',
        slug: 'seed__one',
        title: 'One',
        packages: [],
        remotes: [],
        source: 'seed',
        rank: 1,
      },
      {
        id: 'seed/two',
        slug: 'seed__two',
        title: 'seed/two',
        packages: [],
        remotes: [],
        source: 'seed',
        rank: 2,
      },
    ]);
  });

  it('keeps explicit ranks and optional metadata', () => {
    const [entry] = parseSeed({
      servers: [
        {
          id: 'seed/one',
          rank: 42,
          description: 'A server',
          version: '1.2.3',
          repoUrl: 'https://github.com/acme/one',
          websiteUrl: 'https://acme.example',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    expect(entry).toMatchObject({
      rank: 42,
      description: 'A server',
      version: '1.2.3',
      repoUrl: 'https://github.com/acme/one',
      websiteUrl: 'https://acme.example',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('normalizes packages and remotes', () => {
    const [entry] = parseSeed({
      servers: [
        {
          id: 'seed/one',
          packages: [
            {
              kind: 'npm',
              identifier: '@acme/server',
              version: '1.0.0',
              runtimeHint: 'npx',
              transport: 'stdio',
              runtimeArguments: ['-y'],
              packageArguments: ['.'],
              env: [{ name: 'TOKEN', required: true, secret: true, description: 'API token' }],
            },
            { kind: 'pypi', identifier: 'acme-server' },
          ],
          remotes: [{ type: 'sse', url: 'https://acme.example/mcp', headers: [{ name: 'Authorization' }] }],
        },
      ],
    });

    expect(entry?.packages).toEqual([
      {
        kind: 'npm',
        identifier: '@acme/server',
        version: '1.0.0',
        runtimeHint: 'npx',
        transport: 'stdio',
        runtimeArguments: ['-y'],
        packageArguments: ['.'],
        env: [{ name: 'TOKEN', required: true, secret: true, description: 'API token' }],
      },
      { kind: 'pypi', identifier: 'acme-server', env: [] },
    ]);
    expect(entry?.remotes).toEqual([
      {
        type: 'sse',
        url: 'https://acme.example/mcp',
        headers: [{ name: 'Authorization', required: false, secret: false }],
      },
    ]);
  });

  it.each([
    ['a document without servers', {}, /expected an object with a "servers" array/],
    ['a non-object entry', { servers: ['nope'] }, /servers\[0\] must be an object/],
    ['a missing id', { servers: [{ title: 'no id' }] }, /servers\[0\]\.id must be a non-empty string/],
    [
      'a duplicate id',
      { servers: [{ id: 'a' }, { id: 'a' }] },
      /duplicate id "a" at servers\[1\]/,
    ],
    ['a non-numeric rank', { servers: [{ id: 'a', rank: 'first' }] }, /servers\[0\]\.rank must be a number/],
    [
      'an unknown package kind',
      { servers: [{ id: 'a', packages: [{ kind: 'cargo', identifier: 'x' }] }] },
      /servers\[0\]\.packages\[0\]\.kind must be one of npm, pypi, oci/,
    ],
    [
      'a package without an identifier',
      { servers: [{ id: 'a', packages: [{ kind: 'npm' }] }] },
      /servers\[0\]\.packages\[0\]\.identifier/,
    ],
    [
      'a non-string package argument',
      { servers: [{ id: 'a', packages: [{ kind: 'npm', identifier: 'x', packageArguments: [7] }] }] },
      /servers\[0\]\.packages\[0\]\.packageArguments\[0\] must be a string/,
    ],
    [
      'a bad remote url',
      { servers: [{ id: 'a', remotes: [{ type: 'sse', url: 'ftp://acme.example' }] }] },
      /servers\[0\]\.remotes\[0\]\.url must be an http\(s\) URL/,
    ],
    [
      'an unknown remote type',
      { servers: [{ id: 'a', remotes: [{ type: 'ws', url: 'https://acme.example' }] }] },
      /servers\[0\]\.remotes\[0\]\.type must be one of/,
    ],
    [
      'a nameless env var',
      { servers: [{ id: 'a', packages: [{ kind: 'npm', identifier: 'x', env: [{}] }] }] },
      /servers\[0\]\.packages\[0\]\.env\[0\]\.name/,
    ],
    [
      'an empty optional string',
      { servers: [{ id: 'a', description: '' }] },
      /servers\[0\]\.description must be a non-empty string/,
    ],
  ])('rejects %s', (_label, document, message) => {
    expect(() => parseSeed(document, 'seed.json')).toThrow(message);
  });
});

describe('loadSeed', () => {
  it('reads and parses a seed file', async () => {
    const file = await writeSeed('good.json', { servers: [{ id: 'seed/one', rank: 3 }] });

    await expect(loadSeed(file)).resolves.toEqual([
      {
        id: 'seed/one',
        slug: 'seed__one',
        title: 'seed/one',
        packages: [],
        remotes: [],
        source: 'seed',
        rank: 3,
      },
    ]);
  });

  it('reports a missing file by path', async () => {
    await expect(loadSeed(join(workDir, 'nope.json'))).rejects.toThrow(/cannot read seed file .*nope\.json: file not found/);
  });

  it('reports invalid JSON by path', async () => {
    const file = join(workDir, 'broken.json');
    await writeFile(file, '{ "servers": [', 'utf8');

    await expect(loadSeed(file)).rejects.toThrow(/broken\.json is not valid JSON/);
  });

  it('parses the seed file checked into the repository', async () => {
    const entries = await loadSeed(DEFAULT_SEED_PATH);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.source).toBe('seed');
      expect(entry.slug).toMatch(/^[a-z0-9._-]+$/);
      expect(entry.packages.length + entry.remotes.length).toBeGreaterThan(0);
    }
  });
});
