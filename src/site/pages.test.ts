import { describe, expect, it } from 'vitest';
import type { Catalog, HistoryEntry, ServerEntry, ServerHistory } from '../types.js';
import { buildPages, type Page, type SiteOptions } from './pages.js';

const XSS = '<script>alert(1)</script>';

const OPTIONS: SiteOptions = {
  base: '/dii/',
  siteUrl: 'https://example.test/dii/',
  generatedAt: '2026-08-14T03:00:00.000Z',
};

const PASSING: ServerEntry = {
  id: 'seed/everything',
  slug: 'seed__everything',
  title: 'Everything (reference server)',
  description: 'Official MCP reference server.',
  repoUrl: 'https://github.com/modelcontextprotocol/servers',
  packages: [
    {
      kind: 'npm',
      identifier: '@modelcontextprotocol/server-everything',
      transport: 'stdio',
      env: [],
    },
  ],
  remotes: [],
  source: 'seed',
  rank: 1,
};

const HOSTILE: ServerEntry = {
  id: 'io.github.acme/hostile',
  slug: 'io.github.acme__hostile',
  title: `Hostile ${XSS}`,
  description: `Describes itself as ${XSS}`,
  repoUrl: 'javascript:alert(1)',
  packages: [{ kind: 'npm', identifier: '@acme/hostile', env: [] }],
  remotes: [],
  source: 'registry',
  rank: 2,
};

const REMOTE: ServerEntry = {
  id: 'io.github.acme/hosted',
  slug: 'io.github.acme__hosted',
  title: 'Hosted thing',
  packages: [],
  remotes: [
    {
      type: 'streamable-http',
      url: 'https://mcp.example.test/v1',
      headers: [
        { name: 'ACME_TOKEN', required: true, secret: true },
        { name: 'ACME_DEBUG', required: false, secret: false },
      ],
    },
  ],
  source: 'registry',
  rank: 3,
};

const CATALOG: Catalog = {
  generatedAt: '2026-08-14T02:00:00.000Z',
  servers: [REMOTE, HOSTILE, PASSING], // deliberately out of rank order
};

function entry(overrides: Partial<HistoryEntry> & Pick<HistoryEntry, 'date' | 'status'>): HistoryEntry {
  return { runId: `run-${overrides.date}`, method: 'npm', ...overrides };
}

const HISTORIES = new Map<string, ServerHistory>([
  [
    PASSING.slug,
    {
      serverId: PASSING.id,
      slug: PASSING.slug,
      platforms: {
        // newest first, as merge writes them
        linux: [
          entry({ date: '2026-08-14T03:00:00.000Z', status: 'pass', toolCount: 12 }),
          entry({ date: '2026-08-07T03:00:00.000Z', status: 'pass', toolCount: 12 }),
          entry({ date: '2026-07-31T03:00:00.000Z', status: 'install_failed' }),
        ],
        darwin: [entry({ date: '2026-08-14T03:00:00.000Z', status: 'pass', toolCount: 12 })],
      },
    },
  ],
  [
    HOSTILE.slug,
    {
      serverId: HOSTILE.id,
      slug: HOSTILE.slug,
      platforms: {
        linux: [
          entry({
            date: '2026-08-14T03:00:00.000Z',
            status: 'install_failed',
            errorExcerpt: `npm ERR! ${XSS} "quoted" & 'single'`,
          }),
        ],
        win32: [entry({ date: '2026-08-14T03:00:00.000Z', status: 'skipped', method: 'none' })],
      },
    },
  ],
]);

function build(catalog: Catalog = CATALOG, options: SiteOptions = OPTIONS): Map<string, string> {
  return new Map(buildPages(catalog, HISTORIES, options).map((page: Page) => [page.path, page.html]));
}

function pageOf(pages: Map<string, string>, path: string): string {
  const html = pages.get(path);
  if (html === undefined) throw new Error(`missing page ${path}`);
  return html;
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('buildPages', () => {
  it('emits an index, a page per server, methodology and 404', () => {
    expect([...build().keys()]).toEqual([
      'index.html',
      's/seed__everything.html',
      's/io.github.acme__hostile.html',
      's/io.github.acme__hosted.html',
      'methodology.html',
      '404.html',
    ]);
  });
});

describe('index page', () => {
  const index = pageOf(build(), 'index.html');

  it('has one linked row per catalogued server', () => {
    expect(countOf(index, '<tr>\n<td class="dots">')).toBe(3);
    for (const server of [PASSING, HOSTILE, REMOTE]) {
      expect(index).toContain(`href="/dii/s/${server.slug}.html"`);
    }
  });

  it('orders rows by rank, not catalog array order', () => {
    const positions = [PASSING, HOSTILE, REMOTE].map((server) =>
      index.indexOf(`s/${server.slug}.html`),
    );
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('summarizes passing, failing, untested and total', () => {
    expect(index).toContain('<div class="count pass"><b>1</b><span>passing</span></div>');
    expect(index).toContain('<div class="count fail"><b>1</b><span>failing</span></div>');
    expect(index).toContain('<div class="count none"><b>1</b><span>untested</span></div>');
    expect(index).toContain('<div class="count"><b>3</b><span>servers</span></div>');
  });

  it('shows a status dot per platform with a tooltip', () => {
    expect(index).toContain(
      '<span class="dot pass" title="Linux: installs and connects (2026-08-14)"></span>',
    );
    expect(index).toContain(
      '<span class="dot none" title="Windows: never probed"></span>',
    );
    expect(index).toContain(
      '<span class="dot fail" title="Linux: install failed (2026-08-14)"></span>',
    );
  });

  it('reports install method, tool count and last checked date', () => {
    expect(index).toContain('<td class="num">12</td>');
    expect(index).toContain('<td class="when">2026-08-14</td>');
    expect(index).toContain('<td class="when">never</td>');
    expect(index).toContain('<td>remote</td>');
    expect(countOf(index, '<td>npm</td>')).toBe(2);
  });

  it('escapes hostile server titles and ids', () => {
    expect(index).not.toContain(XSS);
    expect(index).toContain('Hostile &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('handles an empty catalog', () => {
    const empty = pageOf(build({ generatedAt: '', servers: [] }), 'index.html');
    expect(empty).toContain('No servers in the catalog yet.');
    expect(empty).toContain('<div class="count"><b>0</b><span>servers</span></div>');
  });
});

describe('server page', () => {
  const pages = build();
  const passing = pageOf(pages, 's/seed__everything.html');
  const hostile = pageOf(pages, 's/io.github.acme__hostile.html');
  const hosted = pageOf(pages, 's/io.github.acme__hosted.html');

  it('shows the install command for each distribution kind', () => {
    expect(passing).toContain(
      '<pre class="cmd"><code>npx @modelcontextprotocol/server-everything</code></pre>',
    );
    expect(hosted).toContain('<pre class="cmd"><code>https://mcp.example.test/v1</code></pre>');
  });

  it('links repo and website only when the url is safe', () => {
    expect(passing).toContain(
      '<a href="https://github.com/modelcontextprotocol/servers" rel="noopener nofollow">Repository</a>',
    );
    expect(hostile).not.toContain('javascript:alert(1)');
    expect(hostile).toContain('Repository');
  });

  it('escapes untrusted descriptions and error excerpts', () => {
    expect(hostile).not.toContain(XSS);
    expect(hostile).toContain('Describes itself as &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(hostile).toContain(
      '<pre class="err">npm ERR! &lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; &#39;single&#39;</pre>',
    );
  });

  it('renders one strip square per history entry, oldest first', () => {
    expect(countOf(passing, '<span class="sq ')).toBe(4); // 3 linux + 1 darwin
    const linux = passing.slice(passing.indexOf('<h3>Linux</h3>'), passing.indexOf('<h3>macOS</h3>'));
    expect(linux).toContain(
      '<span class="sq fail" title="2026-07-31: install_failed"></span>' +
        '<span class="sq pass" title="2026-08-07: pass"></span>' +
        '<span class="sq pass" title="2026-08-14: pass"></span>',
    );
    expect(linux).toContain('3 recorded runs, oldest first.');
  });

  it('states the latest result per platform, including untested ones', () => {
    expect(passing).toContain('<span class="verdict pass">installs and connects</span>');
    expect(passing).toContain('2026-08-14 &middot; probed over npm');
    expect(passing).toContain('<span class="verdict none">never probed</span>');
    expect(passing).toContain('No probe recorded on this platform yet.');
    expect(passing).toContain('<code>tools/list</code> returned 12 tools.');
  });

  it('greys out skipped platforms instead of failing them', () => {
    expect(hostile).toContain('<span class="verdict none">not tested</span>');
    expect(hostile).toContain('<span class="sq none" title="2026-08-14: skipped"></span>');
  });

  it('caveats servers that need credentials', () => {
    expect(hosted).toContain('Needs credentials: <code>ACME_TOKEN</code>');
    expect(hosted).not.toContain('ACME_DEBUG');
    expect(passing).not.toContain('Needs credentials');
  });

  it('offers a badge snippet pointing at the absolute site url', () => {
    expect(passing).toContain(
      '[![does it install](https://img.shields.io/endpoint?url=https://example.test/dii/badge/seed__everything.json)](https://example.test/dii/s/seed__everything.html)',
    );
  });

  it('applies the base prefix to internal links', () => {
    expect(passing).toContain('href="/dii/"');
    expect(passing).toContain('href="/dii/methodology.html"');
    expect(passing).not.toContain('href="/s/');
  });

  it('defaults the base to the site root', () => {
    const rootPages = build(CATALOG, { ...OPTIONS, base: '/' });
    expect(pageOf(rootPages, 'index.html')).toContain('href="/s/seed__everything.html"');
  });

  it('says so when there is nothing to install', () => {
    const orphan: ServerEntry = { ...REMOTE, slug: 'orphan', remotes: [], rank: 4 };
    const pagesWithOrphan = build({ generatedAt: '', servers: [orphan] });
    const page = pageOf(pagesWithOrphan, 's/orphan.html');
    expect(page).toContain('nothing for the sweep to install');
    expect(pageOf(pagesWithOrphan, 'index.html')).toContain('<td>—</td>');
  });
});

describe('methodology and 404 pages', () => {
  const pages = build();

  it('documents the probe, the placeholders and the caveats', () => {
    const methodology = pageOf(pages, 'methodology.html');
    expect(methodology).toContain('<code>DOES_IT_INSTALL_PLACEHOLDER</code>');
    expect(methodology).toContain('300s to install');
    expect(methodology).toContain('last 30 results per platform');
    expect(methodology).toContain('401 or 403');
    expect(methodology).toContain('Linux, macOS, Windows');
  });

  it('keeps 404 minimal but navigable', () => {
    const notFound = pageOf(pages, '404.html');
    expect(notFound).toContain('<h1>404</h1>');
    expect(notFound).toContain('href="/dii/"');
  });
});
