import { describe, expect, it } from 'vitest';
import type { Catalog, ServerHistory } from '../types.js';
import { buildPages } from './pages.js';

const catalog: Catalog = {
  generatedAt: '2026-08-15T00:00:00.000Z',
  servers: [
    {
      id: 'seed/gated',
      slug: 'seed__gated',
      title: 'Gated',
      packages: [
        {
          kind: 'npm',
          identifier: 'gated-server',
          transport: 'stdio',
          env: [{ name: 'GATED_KEY', required: true, secret: true }],
        },
      ],
      remotes: [],
      source: 'seed',
      rank: 1,
    },
  ],
};

const options = { base: '/', siteUrl: 'https://doesitinstall.com', generatedAt: '2026-08-15T00:00:00.000Z' };

describe('going green guidance', () => {
  const pages = buildPages(catalog, new Map<string, ServerHistory>(), options);
  const byPath = new Map(pages.map((page) => [page.path, page.html]));

  it('the methodology page carries the maintainer section under a stable anchor', () => {
    const methodology = byPath.get('methodology.html') ?? '';
    expect(methodology).toContain('id="going-green"');
    expect(methodology).toContain('validate credentials lazily');
    expect(methodology).toContain('We do not accept test credentials');
  });

  it('the credentials note on a server page links to it', () => {
    const page = byPath.get('s/seed__gated.html') ?? '';
    expect(page).toContain('/methodology.html#going-green');
  });
});
