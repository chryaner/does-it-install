import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ServerEntry } from '../types.js';
import { slugify } from '../types.js';
import { buildCatalog } from './build.js';

function seedEntry(id: string, rank: number, overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    id,
    slug: slugify(id),
    title: id,
    packages: [],
    remotes: [],
    source: 'seed',
    rank,
    ...overrides,
  };
}

function registryItem(name: string, repoUrl?: string): unknown {
  return repoUrl === undefined
    ? { server: { name } }
    : { server: { name, repository: { url: repoUrl } } };
}

/** `https://github.com/acme/<name>`, the shape a registry record carries. */
function repo(name: string): string {
  return `https://github.com/acme/${name}`;
}

describe('buildCatalog', () => {
  it('puts seed entries first in their given rank order, then the registry in registry order', () => {
    const { catalog } = buildCatalog(
      [registryItem('reg/one'), registryItem('reg/two')],
      [seedEntry('seed/late', 10), seedEntry('seed/early', 2)],
    );

    expect(catalog.servers.map((s) => [s.id, s.rank, s.source])).toEqual([
      ['seed/early', 2, 'seed'],
      ['seed/late', 10, 'seed'],
      ['reg/one', 11, 'registry'],
      ['reg/two', 12, 'registry'],
    ]);
  });

  it('ranks registry entries from 1 when there are no seed entries', () => {
    const { catalog } = buildCatalog([registryItem('reg/one'), registryItem('reg/two')], []);
    expect(catalog.servers.map((s) => s.rank)).toEqual([1, 2]);
  });

  it('lets a seed entry win over the same id in the registry', () => {
    const seed = seedEntry('io.github.acme/server', 1, { title: 'Curated title' });
    const result = buildCatalog(
      [
        { server: { name: 'io.github.acme/server', title: 'Registry title', version: '9.9.9' } },
        registryItem('io.github.other/server'),
      ],
      [seed],
    );

    expect(result.catalog.servers).toHaveLength(2);
    expect(result.catalog.servers[0]).toMatchObject({
      id: 'io.github.acme/server',
      title: 'Curated title',
      source: 'seed',
    });
    expect(result.catalog.servers[0]?.version).toBeUndefined();
    expect(result.duplicates).toBe(1);
  });

  it('drops repeated ids inside the registry itself, keeping the first', () => {
    const result = buildCatalog(
      [
        { server: { name: 'dup/id', title: 'first' } },
        { server: { name: 'dup/id', title: 'second' } },
      ],
      [],
    );

    expect(result.catalog.servers).toHaveLength(1);
    expect(result.catalog.servers[0]?.title).toBe('first');
    expect(result.duplicates).toBe(1);
  });

  it('counts malformed registry items as skipped without dropping the build', () => {
    const result = buildCatalog([registryItem('ok/one'), null, { server: {} }, 'junk'], []);

    expect(result.catalog.servers.map((s) => s.id)).toEqual(['ok/one']);
    expect(result.skipped).toBe(3);
  });

  it('suffixes colliding slugs in rank order', () => {
    // All four ids slugify to "acme__server".
    const { catalog } = buildCatalog(
      [registryItem('acme/server'), registryItem('ACME/server'), registryItem('acme__server')],
      [seedEntry('acme/SERVER', 1)],
    );

    expect(catalog.servers.map((s) => s.slug)).toEqual([
      'acme__server',
      'acme__server-2',
      'acme__server-3',
      'acme__server-4',
    ]);
    expect(new Set(catalog.servers.map((s) => s.slug)).size).toBe(4);
  });

  it('skips a suffix that another entry already owns', () => {
    const { catalog } = buildCatalog(
      [registryItem('acme/server'), registryItem('acme/server-2'), registryItem('acme__server')],
      [],
    );

    expect(catalog.servers.map((s) => s.slug)).toEqual([
      'acme__server',
      'acme__server-2',
      'acme__server-3',
    ]);
  });

  it('caps the catalog at --limit, keeping the lowest ranks', () => {
    const { catalog } = buildCatalog(
      [registryItem('reg/one'), registryItem('reg/two'), registryItem('reg/three')],
      [seedEntry('seed/a', 1), seedEntry('seed/b', 2)],
      { limit: 3 },
    );

    expect(catalog.servers.map((s) => s.id)).toEqual(['seed/a', 'seed/b', 'reg/one']);
  });

  it('does not let an entry cut by --limit reserve a slug', () => {
    const { catalog } = buildCatalog([registryItem('acme/server'), registryItem('ACME/server')], [], {
      limit: 1,
    });

    expect(catalog.servers.map((s) => s.slug)).toEqual(['acme__server']);
  });

  it('ignores a limit that is not a positive integer', () => {
    for (const limit of [0, -3, Number.NaN]) {
      const { catalog } = buildCatalog([registryItem('reg/one')], [seedEntry('seed/a', 1)], { limit });
      expect(catalog.servers).toHaveLength(2);
    }
  });

  it('orders registry entries by stars, most first', () => {
    const { catalog } = buildCatalog(
      [
        registryItem('reg/small', repo('small')),
        registryItem('reg/huge', repo('huge')),
        registryItem('reg/mid', repo('mid')),
      ],
      [],
      { stars: new Map([[repo('small'), 12], [repo('huge'), 9000], [repo('mid'), 400]]) },
    );

    expect(catalog.servers.map((s) => [s.id, s.rank])).toEqual([
      ['reg/huge', 1],
      ['reg/mid', 2],
      ['reg/small', 3],
    ]);
  });

  it('records the fetched count as popularity, and nothing when there is none', () => {
    const { catalog } = buildCatalog(
      [registryItem('reg/starred', repo('starred')), registryItem('reg/plain', repo('plain'))],
      [seedEntry('seed/a', 1, { repoUrl: repo('seeded') })],
      { stars: new Map([[repo('starred'), 1234], [repo('seeded'), 88]]) },
    );

    const byId = new Map(catalog.servers.map((s) => [s.id, s]));
    expect(byId.get('reg/starred')?.popularity).toEqual({ stars: 1234 });
    expect(byId.get('seed/a')?.popularity).toEqual({ stars: 88 });
    expect(byId.get('reg/plain')?.popularity).toBeUndefined();
  });

  it('keeps unstarred registry entries after starred ones, in registry order', () => {
    const { catalog } = buildCatalog(
      [
        registryItem('reg/no-repo'),
        registryItem('reg/unknown', 'https://gitlab.example/acme/unknown'),
        registryItem('reg/starred', repo('starred')),
      ],
      [],
      { stars: new Map([[repo('starred'), 5]]) },
    );

    expect(catalog.servers.map((s) => s.id)).toEqual(['reg/starred', 'reg/no-repo', 'reg/unknown']);
  });

  it('breaks ties on registry order, so ranks are stable between builds', () => {
    const { catalog } = buildCatalog(
      [
        registryItem('reg/first', repo('first')),
        registryItem('reg/second', repo('second')),
        registryItem('reg/third', repo('third')),
      ],
      [],
      { stars: new Map([[repo('first'), 10], [repo('second'), 10], [repo('third'), 10]]) },
    );

    expect(catalog.servers.map((s) => s.id)).toEqual(['reg/first', 'reg/second', 'reg/third']);
  });

  it('keeps seed entries first however many stars the registry has', () => {
    const { catalog } = buildCatalog(
      [registryItem('reg/famous', repo('famous'))],
      [seedEntry('seed/late', 10), seedEntry('seed/early', 2)],
      { stars: new Map([[repo('famous'), 50_000]]) },
    );

    expect(catalog.servers.map((s) => [s.id, s.rank])).toEqual([
      ['seed/early', 2],
      ['seed/late', 10],
      ['reg/famous', 11],
    ]);
  });

  it('applies --limit to the ranked list, not to registry order', () => {
    const { catalog } = buildCatalog(
      [
        registryItem('reg/first-listed', repo('first-listed')),
        registryItem('reg/second-listed', repo('second-listed')),
      ],
      [],
      { limit: 1, stars: new Map([[repo('second-listed'), 700]]) },
    );

    expect(catalog.servers.map((s) => s.id)).toEqual(['reg/second-listed']);
  });

  it('does not mutate the entries it was handed', () => {
    const seed = seedEntry('acme/server', 5);
    buildCatalog([registryItem('acme/server-clash')], [seed]);

    expect(seed).toEqual(seedEntry('acme/server', 5));
  });

  it('builds a catalog from a captured registry page', () => {
    const page = JSON.parse(
      readFileSync(new URL('./fixtures/registry-page.json', import.meta.url), 'utf8'),
    ) as { servers: unknown[] };

    const { catalog, skipped, duplicates } = buildCatalog(page.servers, [seedEntry('seed/a', 1)]);

    expect(catalog.servers).toHaveLength(page.servers.length); // 10 registry + 1 seed, 1 malformed
    expect(skipped).toBe(1);
    expect(duplicates).toBe(0);
    expect(catalog.servers.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(catalog.servers.map((s) => s.slug)).size).toBe(catalog.servers.length);
  });

  it('stamps generatedAt with an ISO timestamp', () => {
    const before = Date.now();
    const { catalog } = buildCatalog([], []);
    const generated = Date.parse(catalog.generatedAt);

    expect(catalog.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(generated).toBeGreaterThanOrEqual(before - 1000);
    expect(catalog.servers).toEqual([]);
  });
});
