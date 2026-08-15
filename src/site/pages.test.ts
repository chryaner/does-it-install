import { describe, expect, it } from 'vitest';
import type { Catalog, HistoryEntry, ServerEntry, ServerHistory } from '../types.js';
import { buildPages, type Page, type SiteOptions } from './pages.js';

const XSS = '<script>alert(1)</script>';
/** A tool name a server could publish; names reach the page verbatim otherwise. */
const TOOL_XSS = '<img src=x onerror=alert(1)>';

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
  popularity: { stars: 1234 },
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
  popularity: { stars: 987 },
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
          entry({
            date: '2026-08-14T03:00:00.000Z',
            status: 'pass',
            toolCount: 12,
            toolNames: ['echo', TOOL_XSS],
          }),
          entry({ date: '2026-08-07T03:00:00.000Z', status: 'pass', toolCount: 12 }),
          entry({ date: '2026-07-31T03:00:00.000Z', status: 'install_failed' }),
        ],
        // No names recorded: older runs predate them.
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

/** What a consumer of index.json gets, described independently of pages.ts. */
interface FeedServer {
  id: string;
  slug: string;
  title: string;
  page: string;
  repoUrl?: string;
  stars?: number;
  install: string;
  platforms: Record<string, { status: string; date: string; toolCount?: number }>;
}

interface Feed {
  generatedAt: string;
  site: string;
  servers: FeedServer[];
}

function feedOf(pages: Map<string, string>): Feed {
  return JSON.parse(pageOf(pages, 'index.json')) as Feed;
}

function serverOf(pages: Map<string, string>, slug: string): FeedServer {
  const server = feedOf(pages).servers.find((candidate) => candidate.slug === slug);
  if (server === undefined) throw new Error(`missing feed server ${slug}`);
  return server;
}

describe('buildPages', () => {
  it('emits an index, a page per server, methodology, 404 and the machine files', () => {
    expect([...build().keys()]).toEqual([
      'index.html',
      's/seed__everything.html',
      's/io.github.acme__hostile.html',
      's/io.github.acme__hosted.html',
      'methodology.html',
      '404.html',
      'sitemap.xml',
      'robots.txt',
      'index.json',
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

  it('has a stars column between install and tools', () => {
    expect(index).toContain(
      '<thead><tr><th>Status</th><th>Server</th><th>Install</th><th>Stars</th><th>Tools</th><th>Last checked</th></tr></thead>',
    );
    // PASSING: npm, 1234 stars, 12 tools.
    expect(index).toContain('<td>npm</td>\n<td class="num">1.2k</td>\n<td class="num">12</td>');
  });

  it.each([
    [0, '0'],
    [7, '7'],
    [987, '987'],
    [1000, '1k'],
    [1234, '1.2k'],
    [9949, '9.9k'],
    [34_000, '34k'],
    [34_567, '35k'],
  ])('formats %d stars as %s', (stars, expected) => {
    const server: ServerEntry = { ...REMOTE, slug: 'counted', popularity: { stars } };
    const page = pageOf(build({ generatedAt: '', servers: [server] }), 'index.html');

    expect(page).toContain(`<td class="num">${expected}</td>`);
  });

  it('says n/a for a server with no star count, like the tools column', () => {
    // REMOTE carries no popularity at all: no repo, nothing fetched.
    const page = pageOf(build({ generatedAt: '', servers: [REMOTE] }), 'index.html');

    expect(countOf(page, '<td class="num"><span class="muted">n/a</span></td>')).toBe(2);
  });

  it('explains the row order in the legend', () => {
    expect(index).toContain('Rows are ordered by GitHub stars');
    expect(index).toContain('seed servers first');
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

  it('puts the star count in the meta line, only when there is one', () => {
    expect(passing).toContain('&middot; 1.2k stars &middot; listed from seed');
    expect(hosted).toContain('listed from registry');
    expect(hosted).not.toContain('stars');
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

  it('lists the tool names of the latest passing probe, escaped', () => {
    const linux = passing.slice(passing.indexOf('<h3>Linux</h3>'), passing.indexOf('<h3>macOS</h3>'));
    const darwin = passing.slice(passing.indexOf('<h3>macOS</h3>'), passing.indexOf('<h3>Windows</h3>'));

    expect(linux).toContain(
      '<p class="tools"><code>echo</code> <code>&lt;img src=x onerror=alert(1)&gt;</code></p>',
    );
    expect(passing).not.toContain(TOOL_XSS);
    // Older entries recorded no names, so only the count is shown.
    expect(darwin).toContain('<code>tools/list</code> returned 12 tools.');
    expect(darwin).not.toContain('<code>echo</code>');
    // A platform that did not pass says nothing about tools at all.
    expect(hostile).not.toContain('returned');
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

  it('shows the endpoint the probe would pick, not simply the first listed', () => {
    const dual: ServerEntry = {
      ...REMOTE,
      slug: 'dual',
      remotes: [
        { type: 'sse', url: 'https://mcp.example.test/sse', headers: [] },
        {
          type: 'streamable-http',
          url: 'https://mcp.example.test/http',
          headers: [{ name: 'ACME_TOKEN', required: true, secret: true }],
        },
      ],
    };

    const page = pageOf(build({ generatedAt: '', servers: [dual] }), 's/dual.html');

    expect(page).toContain('<pre class="cmd"><code>https://mcp.example.test/http</code></pre>');
    expect(page).not.toContain('https://mcp.example.test/sse');
    expect(page).toContain('Needs credentials: <code>ACME_TOKEN</code>');
  });

  it('falls back to the first remote when none is streamable http', () => {
    const sseOnly: ServerEntry = {
      ...REMOTE,
      slug: 'sse-only',
      remotes: [{ type: 'sse', url: 'https://mcp.example.test/sse', headers: [] }],
    };

    const page = pageOf(build({ generatedAt: '', servers: [sseOnly] }), 's/sse-only.html');

    expect(page).toContain('<pre class="cmd"><code>https://mcp.example.test/sse</code></pre>');
  });

  it('says so when there is nothing to install', () => {
    const orphan: ServerEntry = { ...REMOTE, slug: 'orphan', remotes: [], rank: 4 };
    const pagesWithOrphan = build({ generatedAt: '', servers: [orphan] });
    const page = pageOf(pagesWithOrphan, 's/orphan.html');
    expect(page).toContain('nothing for the sweep to install');
    expect(pageOf(pagesWithOrphan, 'index.html')).toContain('<td>none</td>');
  });
});

describe('methodology and 404 pages', () => {
  const pages = build();

  it('documents the probe, the placeholders and the caveats', () => {
    const methodology = pageOf(pages, 'methodology.html');
    expect(methodology).toContain('<code>DOES_IT_INSTALL_PLACEHOLDER</code>');
    expect(methodology).toContain('600s to install');
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

describe('sitemap.xml', () => {
  const sitemap = pageOf(build(), 'sitemap.xml');

  it('lists the index, the methodology and every server page', () => {
    expect(sitemap).toContain('<loc>https://example.test/dii/</loc>');
    expect(sitemap).toContain('<loc>https://example.test/dii/methodology.html</loc>');
    expect(sitemap).toContain('<loc>https://example.test/dii/s/seed__everything.html</loc>');
    expect(countOf(sitemap, '<url>')).toBe(5); // index + methodology + 3 servers
  });

  it('leaves 404 and the machine files out', () => {
    expect(sitemap).not.toContain('404.html');
    expect(sitemap).not.toContain('robots.txt');
    expect(sitemap).not.toContain('index.json');
  });

  it('dates a server page only when it has history', () => {
    expect(sitemap).toContain(
      '<url><loc>https://example.test/dii/s/seed__everything.html</loc><lastmod>2026-08-14</lastmod></url>',
    );
    expect(sitemap).toContain(
      '<url><loc>https://example.test/dii/s/io.github.acme__hosted.html</loc></url>',
    );
  });

  it('opens with the xml declaration and the sitemap namespace', () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap).not.toContain('<priority>');
    expect(sitemap).not.toContain('<changefreq>');
  });
});

describe('robots.txt', () => {
  const robots = pageOf(build(), 'robots.txt');

  it('allows everything and points at the sitemap', () => {
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://example.test/dii/sitemap.xml');
    expect(robots).not.toContain('Disallow');
  });
});

describe('index.json', () => {
  const pages = build();

  it('is pretty-printed json with a trailing newline', () => {
    const raw = pageOf(pages, 'index.json');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n  "servers": [');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('records the build time, the site root and every server in rank order', () => {
    const feed = feedOf(pages);
    expect(feed.generatedAt).toBe(OPTIONS.generatedAt);
    expect(feed.site).toBe('https://example.test/dii');
    expect(feed.servers.map((server) => server.slug)).toEqual([
      PASSING.slug,
      HOSTILE.slug,
      REMOTE.slug,
    ]);
  });

  it('identifies a server by id, slug, title, page url and install method', () => {
    const passing = serverOf(pages, PASSING.slug);
    expect(passing.id).toBe(PASSING.id);
    expect(passing.title).toBe(PASSING.title);
    expect(passing.page).toBe('https://example.test/dii/s/seed__everything.html');
    expect(passing.repoUrl).toBe(PASSING.repoUrl);
    expect(passing.install).toBe('npm');
    // JSON is data, not markup: hostile titles are carried verbatim.
    expect(serverOf(pages, HOSTILE.slug).title).toBe(HOSTILE.title);
  });

  it('reports the latest entry for probed platforms only', () => {
    expect(serverOf(pages, PASSING.slug).platforms).toEqual({
      linux: { status: 'pass', date: '2026-08-14T03:00:00.000Z', toolCount: 12 },
      darwin: { status: 'pass', date: '2026-08-14T03:00:00.000Z', toolCount: 12 },
    });
    expect(serverOf(pages, HOSTILE.slug).platforms).toEqual({
      linux: { status: 'install_failed', date: '2026-08-14T03:00:00.000Z' },
      win32: { status: 'skipped', date: '2026-08-14T03:00:00.000Z' },
    });
  });

  it('carries the star count as a number, for servers that have one', () => {
    expect(serverOf(pages, PASSING.slug).stars).toBe(1234);
    expect(serverOf(pages, HOSTILE.slug).stars).toBe(987);
  });

  it('omits repoUrl, stars and platforms when there is nothing to report', () => {
    const remote = serverOf(pages, REMOTE.slug);
    expect('repoUrl' in remote).toBe(false);
    expect('stars' in remote).toBe(false);
    expect(remote.install).toBe('remote');
    expect(remote.platforms).toEqual({});
  });
});
