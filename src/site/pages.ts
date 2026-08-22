/**
 * Pure page construction: (catalog, histories, options) -> [{path, html}].
 *
 * Nothing here touches the filesystem, so the whole site is testable as
 * strings. `cli.ts` owns reading inputs and writing the pages out.
 *
 * The history files this reads are stored newest-first (see types.ts); the
 * history strips render them oldest-first so they read left to right like
 * every other status page.
 */

import { PLATFORMS } from '../history/platforms.js';
import { ENV_PLACEHOLDER, HISTORY_LIMIT } from '../types.js';
import type {
  Catalog,
  HistoryEntry,
  Platform,
  ProbeStatus,
  ServerEntry,
  ServerHistory,
} from '../types.js';
import { escapeHtml, externalLink, href, layout, normalizeBase, safeUrl } from './html.js';

export interface SiteOptions {
  /** URL prefix every link is built from, e.g. `/` or `/does-it-install/`. */
  base: string;
  /** Absolute site root: badge snippets, the sitemap and the JSON feed. */
  siteUrl: string;
  /** ISO timestamp of this build. */
  generatedAt: string;
}

/** One output file, path relative to the output directory, `/`-separated. */
export interface Page {
  path: string;
  /** File content. Named for the common case; sitemap.xml and friends ride along. */
  html: string;
}

/**
 * How a server reads on the index. Any real failure wins, then any pass, then
 * "it answered and asked for something we cannot supply". `needs_auth`,
 * `needs_config` and `skipped` are not failures (see the ProbeStatus doc in
 * types.ts), so a server that passes on one platform and asks for credentials
 * on another still reads as passing.
 */
type Verdict = 'passing' | 'failing' | 'needsSetup' | 'untested';

/** Colour bucket for dots, squares and pills. */
type Tone = 'pass' | 'fail' | 'auth' | 'none';

const PITCH =
  'Every MCP server we can find, installed from scratch and put through a real MCP handshake ' +
  'on Linux, macOS and Windows, with the actual error text when it breaks.';

const PLATFORM_LABELS: Record<Platform, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
};

const STATUS_PHRASES: Record<ProbeStatus, string> = {
  pass: 'installs and connects',
  install_failed: 'install failed',
  spawn_failed: 'installed, but would not start',
  connect_failed: 'endpoint unreachable',
  handshake_failed: 'MCP handshake failed',
  needs_auth: 'needs credentials',
  needs_config: 'needs configuration',
  tools_failed: 'tools/list failed',
  timeout: 'timed out',
  skipped: 'not tested',
};

/**
 * How slow an install has to be before a passing platform block mentions it.
 * Under a minute the number is noise; past it, "it works, but you will wait"
 * is a fact about the server that a green pill alone hides.
 */
const SLOW_INSTALL_MS = 60_000;

interface Install {
  /** Distribution the sweep would pick: npm, then pypi, then oci, then remote. */
  label: 'npm' | 'pypi' | 'oci' | 'remote' | 'none';
  /** `npx <pkg>`, `uvx <pkg>`, `docker run <image>`, or the endpoint URL. */
  command?: string;
  /** True when `command` is an endpoint rather than a shell command. */
  hosted: boolean;
  /** Required env vars / headers the probe can only fill with placeholders. */
  requiresEnv: string[];
  /**
   * True when the distribution above declared arguments with no concrete value,
   * which the catalog dropped rather than invent, so the probe ran the server
   * without them. Always false for a hosted endpoint: there is nothing to pass.
   */
  needsArguments: boolean;
}

interface ServerView {
  entry: ServerEntry;
  /** Newest entry per platform, only for platforms with recorded runs. */
  latest: Map<Platform, HistoryEntry>;
  history: ServerHistory | undefined;
  verdict: Verdict;
  /** Stargazer count from the catalog, when one was fetched. */
  stars: number | undefined;
  toolCount: number | undefined;
  /** ISO date of the newest probe across platforms. */
  lastChecked: string | undefined;
  install: Install;
}

interface ResolvedOptions {
  base: string;
  siteUrl: string;
  generatedAt: string;
}

/** Build every page of the site, in display order (see `byStars`). */
export function buildPages(
  catalog: Catalog,
  histories: ReadonlyMap<string, ServerHistory>,
  options: SiteOptions,
): Page[] {
  const resolved: ResolvedOptions = {
    base: normalizeBase(options.base),
    siteUrl: options.siteUrl.trim().replace(/\/+$/, ''),
    generatedAt: options.generatedAt,
  };

  const views = [...catalog.servers]
    .sort(byStars)
    .map((entry) => viewOf(entry, histories.get(entry.slug)));

  return [
    { path: 'index.html', html: indexPage(catalog, views, resolved) },
    ...views.map((view) => ({
      path: `s/${view.entry.slug}.html`,
      html: serverPage(view, resolved),
    })),
    { path: 'methodology.html', html: methodologyPage(resolved) },
    { path: '404.html', html: notFoundPage(resolved) },
    { path: 'sitemap.xml', html: sitemapFile(views, resolved) },
    { path: 'robots.txt', html: robotsFile(resolved) },
    { path: 'index.json', html: feedFile(views, resolved) },
  ];
}

// ---------------------------------------------------------------- index page

function indexPage(catalog: Catalog, views: readonly ServerView[], options: ResolvedOptions): string {
  const counts = { passing: 0, failing: 0, needsSetup: 0, untested: 0 };
  for (const view of views) counts[view.verdict]++;

  const rows =
    views.length === 0
      ? '<tr><td colspan="6" class="muted">No servers in the catalog yet.</td></tr>'
      : views.map((view) => indexRow(view, options)).join('\n');

  const body = `<h1>Does it install?</h1>
<p class="pitch">${escapeHtml(PITCH)}</p>
<div class="counts">
${countCard(counts.passing, 'passing', 'pass')}
${countCard(counts.failing, 'failing', 'fail')}
${countCard(counts.needsSetup, 'needs setup', 'auth')}
${countCard(counts.untested, 'untested', 'none')}
${countCard(views.length, 'servers')}
</div>
<div class="scroll"><table>
<thead><tr><th>Status</th><th>Server</th><th>Install</th><th>Stars</th><th>Tools</th><th>Last checked</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<p class="legend">Status dots are ${PLATFORMS.map((platform) => escapeHtml(PLATFORM_LABELS[platform])).join(' &middot; ')}, in that order. Hover one for its result. A server counts as failing when its latest probe failed on any platform we tested. Amber means the server is alive but needs credentials or configuration the probe cannot supply, which is neither a pass nor a failure. Grey means we did not test that platform, so it is left out of the verdict rather than counted against the server.</p>
<p class="legend">Rows are ordered by GitHub stars of the server's repository, most stars first, with servers we have no count for last. Stars measure the repository, not the server itself, and nothing here is ordered by who curated it.</p>
<p class="legend">Site built ${escapeHtml(formatDateTime(options.generatedAt))}${catalog.generatedAt === '' ? '' : ` &middot; catalog generated ${escapeHtml(formatDateTime(catalog.generatedAt))}`}.</p>`;

  return layout(
    'does it install? · MCP server status',
    body,
    options.base,
    PITCH,
    `${options.siteUrl}/`,
  );
}

function countCard(value: number, label: string, tone?: Tone): string {
  const className = tone === undefined ? 'count' : `count ${tone}`;
  return `<div class="${className}"><b>${String(value)}</b><span>${escapeHtml(label)}</span></div>`;
}

function indexRow(view: ServerView, options: ResolvedOptions): string {
  const dots = PLATFORMS.map((platform) => {
    const entry = view.latest.get(platform);
    const label = PLATFORM_LABELS[platform];
    const title =
      entry === undefined
        ? `${label}: never probed`
        : `${label}: ${statusPhrase(entry.status)} (${formatDate(entry.date)})`;
    return `<span class="dot ${toneOf(entry?.status)}" title="${escapeHtml(title)}"></span>`;
  }).join('');

  const { entry } = view;
  return `<tr>
<td class="dots">${dots}</td>
<td><a class="name" href="${href(options.base, `s/${entry.slug}.html`)}">${escapeHtml(entry.title)}</a><span class="id">${escapeHtml(entry.id)}</span></td>
<td>${escapeHtml(view.install.label)}</td>
<td class="num">${view.stars === undefined ? '<span class="muted">n/a</span>' : formatStars(view.stars)}</td>
<td class="num">${view.toolCount === undefined ? '<span class="muted">n/a</span>' : String(view.toolCount)}</td>
<td class="when">${view.lastChecked === undefined ? 'never' : escapeHtml(formatDate(view.lastChecked))}</td>
</tr>`;
}

// --------------------------------------------------------------- server page

function serverPage(view: ServerView, options: ResolvedOptions): string {
  const { entry, install } = view;
  const badge = `[![does it install](https://img.shields.io/endpoint?url=${options.siteUrl}/badge/${entry.slug}.json)](${pageUrl(entry, options)})`;

  const sections = [
    `<p class="crumb"><a href="${href(options.base, '')}">&larr; All servers</a></p>`,
    `<h1>${escapeHtml(entry.title)}</h1>`,
    entry.description === undefined ? '' : `<p class="pitch">${escapeHtml(entry.description)}</p>`,
    `<p class="muted"><code>${escapeHtml(entry.id)}</code>${metaLinks(entry, view.stars)}</p>`,

    '<h2>Install</h2>',
    installBlock(install, options),

    '<h2>Results by platform</h2>',
    PLATFORMS.map((platform) => platformBlock(view, platform)).join('\n'),

    '<h2>Badge</h2>',
    '<p>Paste this into the project README to show the current result:</p>',
    `<pre class="cmd"><code>${escapeHtml(badge)}</code></pre>`,
  ];

  return layout(
    `${entry.title} · does it install?`,
    sections.filter(Boolean).join('\n'),
    options.base,
    `Install and MCP handshake test results for ${entry.title} on Linux, macOS and Windows, refreshed weekly with the actual error output.`,
    pageUrl(entry, options),
  );
}

/** Trailing " · Repository · Website · version 1.2.3 · 1.2k stars · listed from registry". */
function metaLinks(entry: ServerEntry, stars: number | undefined): string {
  const links = [
    entry.repoUrl === undefined ? '' : externalLink(entry.repoUrl, 'Repository'),
    entry.websiteUrl === undefined ? '' : externalLink(entry.websiteUrl, 'Website'),
    entry.version === undefined ? '' : `version ${escapeHtml(entry.version)}`,
    stars === undefined ? '' : `${formatStars(stars)} star${stars === 1 ? '' : 's'}`,
    `listed from ${escapeHtml(entry.source)}`,
  ].filter((part) => part !== '');
  return ` &middot; ${links.join(' &middot; ')}`;
}

function installBlock(install: Install, options: ResolvedOptions): string {
  if (install.command === undefined) {
    return install.hosted
      ? '<p class="note">The listed endpoint is not a usable http(s) URL, so there is nothing for the sweep to connect to.</p>'
      : '<p class="note">No npm, PyPI, container or hosted distribution is listed for this server, so there is nothing for the sweep to install.</p>';
  }

  const caption = install.hosted
    ? 'Hosted endpoint, so there is nothing to install. The probe connects straight to it:'
    : install.label === 'oci'
      ? 'The sweep pulls the image and runs it in a throwaway container, but this is the command a user would run:'
      : 'The sweep installs into a clean prefix, but this is the command a user would run:';

  const goingGreen = `<a href="${href(options.base, 'methodology.html')}#going-green">how to go green</a>`;

  const credentials =
    install.requiresEnv.length === 0
      ? ''
      : `\n<p class="note">Needs credentials: ${install.requiresEnv
          .map((name) => `<code>${escapeHtml(name)}</code>`)
          .join(', ')}. The probe used placeholder values, so an amber <b>needs credentials</b> result below means the server asked for the real ones, not that it is broken. Maintainers: ${goingGreen}.</p>`;

  // The other half of the amber story: arguments the registry entry left as
  // placeholders are dropped rather than invented, so a server that will not
  // start without them is asking for something, not failing.
  const args = install.needsArguments
    ? `\n<p class="note">Needs arguments: the registry entry declares arguments only a user can fill, so the probe ran without them. An amber <b>needs configuration</b> result below means the server asked for them, not that it is broken. Maintainers: ${goingGreen}.</p>`
    : '';

  return `<p class="muted">${escapeHtml(caption)}</p>
<pre class="cmd"><code>${escapeHtml(install.command)}</code></pre>${credentials}${args}`;
}

function platformBlock(view: ServerView, platform: Platform): string {
  const entries = view.history?.platforms[platform] ?? [];
  const latest = view.latest.get(platform);
  const label = PLATFORM_LABELS[platform];

  if (latest === undefined) {
    return `<section class="platform">
<header><h3>${escapeHtml(label)}</h3><span class="verdict none">${escapeHtml(statusPhrase(undefined))}</span></header>
<p class="muted">No probe recorded on this platform yet.</p>
</section>`;
  }

  // A skipped run never reached a transport, so naming the method would imply
  // more than happened.
  const when =
    latest.status === 'skipped'
      ? escapeHtml(formatDate(latest.date))
      : `${escapeHtml(formatDate(latest.date))} &middot; probed over ${escapeHtml(latest.method)}`;

  // The excerpt is the evidence for every non-passing status, the amber ones
  // included: "invalid API key", "HTTP 401" or "missing --workspace" is exactly
  // what makes an amber verdict checkable. Its rule follows the verdict's tone
  // so the two agree.
  const excerptClass = toneOf(latest.status) === 'auth' ? 'err auth' : 'err';

  const parts = [
    `<header><h3>${escapeHtml(label)}</h3><span class="verdict ${toneOf(latest.status)}">${escapeHtml(statusPhrase(latest.status))}</span><span class="muted">${when}</span></header>`,
    historyStrip(entries),
    toolsBlock(latest),
    slowInstallBlock(latest),
    latest.status !== 'pass' && latest.errorExcerpt !== undefined
      ? `<pre class="${excerptClass}">${escapeHtml(latest.errorExcerpt)}</pre>`
      : '',
  ];

  return `<section class="platform">
${parts.filter(Boolean).join('\n')}
</section>`;
}

/**
 * What `tools/list` returned, for a passing probe only: the count, plus the
 * names when the run recorded them (older history files have none). Tool names
 * are chosen by the server, so every one is escaped.
 */
function toolsBlock(latest: HistoryEntry): string {
  if (latest.status !== 'pass' || latest.toolCount === undefined) return '';

  const count = `<p class="tools"><code>tools/list</code> returned ${String(latest.toolCount)} tool${latest.toolCount === 1 ? '' : 's'}.</p>`;
  const names = latest.toolNames ?? [];
  if (names.length === 0) return count;

  return `${count}
<p class="tools">${names.map((name) => `<code>${escapeHtml(name)}</code>`).join(' ')}</p>`;
}

/**
 * How long the install took, for a passing probe that took long enough to be
 * worth saying so. A pass after ten minutes of `npm install` is a different
 * experience from a pass after twenty seconds, and the green pill reads the
 * same either way. Nothing is shown below the threshold, and nothing is shown
 * for a failure: there the excerpt is the story.
 */
function slowInstallBlock(latest: HistoryEntry): string {
  const installMs = latest.installMs;
  if (latest.status !== 'pass' || installMs === undefined || installMs <= SLOW_INSTALL_MS) return '';

  return `<p class="muted">Install took ${escapeHtml(formatDuration(installMs))} on this platform.</p>`;
}

/** Oldest run first, so the strip reads left to right like a calendar. */
function historyStrip(entries: readonly HistoryEntry[]): string {
  const squares = [...entries]
    .reverse()
    .map(
      (entry) =>
        `<span class="sq ${toneOf(entry.status)}" title="${escapeHtml(`${formatDate(entry.date)}: ${entry.status}`)}"></span>`,
    )
    .join('');

  return `<div class="strip">${squares}</div>
<p class="legend">${String(entries.length)} recorded run${entries.length === 1 ? '' : 's'}, oldest first.</p>`;
}

// ---------------------------------------------------------- static-ish pages

function methodologyPage(options: ResolvedOptions): string {
  const body = `<div class="prose">
<h1>Methodology</h1>
<p class="pitch">How a green, amber or red square on this site is produced, and what it does not tell you.</p>

<h2>What one probe does</h2>
<p>Every server in the catalog is probed independently, in a disposable CI runner, with no shared state between servers. The sweep picks the first distribution it supports (npm, then PyPI, then a container image, then a hosted endpoint) and walks these phases:</p>
<ul>
<li><b>install</b>: <code>npm install</code> into a fresh temporary prefix with a clean cache, <code>uv tool run</code> for PyPI, or <code>docker pull</code> for a container image. Nothing is installed globally.</li>
<li><b>spawn / connect</b>: the server binary is started over stdio, a container is run with <code>docker run -i --rm</code>, capped at 2 GB of memory and 512 processes so one image cannot starve its neighbours, and removed afterwards, or the hosted endpoint is opened with the streamable-HTTP or legacy SSE transport.</li>
<li><b>handshake</b>: an MCP <code>initialize</code> round trip with the official SDK client.</li>
<li><b>tools/list</b>: the tool list is requested; the count on each page comes from this response.</li>
</ul>
<p>A server only shows green when every phase succeeded. Otherwise the status names the phase that broke, or says the server asked for something we do not have, and the newest stderr output is kept and shown verbatim on the server page either way.</p>
<p>When an installed npm package declares <code>engines.bun</code>, the probe checks for Bun before spawning it. If Bun is not on the runner, the successful install is preserved but the result is grey and untested instead of a red handshake failure. Packages without that declaration keep the normal Node launch path.</p>
<p>A PyPI package rarely names the console script it installs, so the probe guesses it from the package name. When that guess is wrong, <code>uv</code> normally names the executable it did find, and the probe re-runs once with that name: an entry point named differently from its package now passes instead of showing a red handshake failure. The guess only survives as a limitation when uv gives no hint at all.</p>

<h2>Time budgets</h2>
<p>Each phase has its own budget: 600s to install, 30s to spawn, 30s for the handshake, 15s for <code>tools/list</code>, and 20s to reach a hosted endpoint. Exceeding one records <em>timed out</em> against that phase rather than a generic failure.</p>
<p>Probes run four at a time, so an install that ran out of time is probed once more on its own, with double the install budget, before the result stands. <em>Timed out</em> here therefore means the server exceeded its budget with the runner to itself. When a server passes but took more than a minute to install, its platform block says how long that took: a pass after ten minutes of installing is a different experience from a pass after twenty seconds.</p>

<h2>Credentials and configuration</h2>
<p>We probe with no accounts anywhere. Environment variables a server declares as required are filled with the literal placeholder <code>${escapeHtml(ENV_PLACEHOLDER)}</code>, and every affected server page says so above its results. A server that needs a real API key can therefore install perfectly and still refuse to start or to finish the handshake here. That outcome is recorded as <b>needs credentials</b>, in amber, rather than as a failure: the server declared what it wanted, and we did not bring it.</p>
<p>Arguments work the same way. A registry entry sometimes declares arguments with no concrete value, a workspace path or an account id only the user knows, and the catalog drops those rather than invent them. A server that installs and then will not start or will not finish its handshake without them is recorded <b>needs configuration</b>, also in amber. When an entry declared both placeholder variables and placeholder arguments, the result reads <b>needs credentials</b>: a missing key is the commoner cause, and one phrase per platform is enough.</p>

<h2 id="going-green">Going green (for maintainers)</h2>
<p>The amber state resolves without anyone sharing a secret, and the fix is ordinary good server design: <b>validate credentials lazily</b>. Start, complete the <code>initialize</code> handshake, answer <code>tools/list</code>, and return a clear error from the tool call itself when the key is missing or wrong. A server built that way turns green here on its own, and real users get a visible tool list plus an error in context instead of a silent connection failure. Hosted servers can do the same over HTTP: allow anonymous <code>initialize</code> and <code>tools/list</code>, gate the tool calls. If your tools genuinely cannot be listed without a tenant, the standard OAuth challenge (a 401 with <code>WWW-Authenticate</code>) is correct, and amber is your accurate steady state: alive, gated, working as designed.</p>
<p>The registry entry does half the work. Declaring the environment variables and the arguments a server actually requires is what lets a probe tell "it asked us for something" from "it broke", so an accurate entry is the difference between an amber result and a red one. A server that silently requires a key or a flag it never declared gets no benefit of the doubt, because there is nothing to give it.</p>
<p>We do not accept test credentials, from anyone. The harness executes third-party code weekly, so holding real secrets would make every probe a liability, and probing with no accounts anywhere is what keeps the results comparable.</p>

<h2>Platforms and cadence</h2>
<p>Probes run on ${PLATFORMS.map((platform) => escapeHtml(PLATFORM_LABELS[platform])).join(', ')} runners, weekly, plus manual re-runs. Container images are probed on Linux only, because the macOS and Windows runners cannot run Linux containers; on those platforms the result is <em>not tested</em>, and a platform we did not test is left out of the overall badge instead of counting against the server. Each server keeps its last ${String(HISTORY_LIMIT)} results per platform, which is what the history strip shows. Servers that disappear from the registry keep their pages: knowing when something stopped working is the point.</p>

<h2>Caveats</h2>
<ul>
<li><b>Amber means the server is alive and wants credentials</b> we do not send, or arguments we cannot invent. Red is kept for a real failure: the probe filled every declared required variable with a placeholder, and the server broke for a reason that has nothing to do with them or with the arguments the entry declared.</li>
<li><b>Red still does not always mean broken for you.</b> It can mean the server needs a runtime the runner lacks, or was published for one platform only.</li>
<li><b>Hosted endpoints that answer 401 or 403</b> are recorded as needs credentials with the HTTP detail, not as a failed handshake. They are reachable; they simply require auth we do not send.</li>
<li><b>Grey means untested</b>, never "bad": no supported distribution, a container image on a runner that cannot run one, or a runner missing a declared runtime such as <code>uv</code> or Bun.</li>
<li><b>We test installation and the handshake, not behaviour.</b> A green square says the server starts and lists its tools; it says nothing about whether those tools work well.</li>
<li><b>Results are a snapshot.</b> Registries, package versions and hosted endpoints all move between sweeps.</li>
</ul>

<h2>Corrections</h2>
<p>Every result is reproducible from the command shown on the server page. If a result looks wrong, the error excerpt is the whole evidence we have, so file an issue on the project repository with it.</p>
</div>`;

  return layout(
    'Methodology · does it install?',
    body,
    options.base,
    'How every MCP server is tested: probe phases, time budgets, the credential policy, and what each status does and does not mean.',
    `${options.siteUrl}/methodology.html`,
  );
}

function notFoundPage(options: ResolvedOptions): string {
  const body = `<h1>404</h1>
<p class="pitch">No page here. The server you are looking for may never have been catalogued.</p>
<p><a href="${href(options.base, '')}">Back to all servers</a></p>`;

  return layout('404 · does it install?', body, options.base, 'Page not found.');
}

// ------------------------------------------------------- sitemap, robots, feed

/**
 * Sitemap over the pages worth crawling: the index, the methodology and every
 * server page. 404.html is left out on purpose. A server page carries the date
 * of its newest probe as `lastmod`, so a crawler can tell a page that moved
 * this week from one that has not changed in months; a server with no history
 * has no such date and gets no `lastmod` at all.
 */
function sitemapFile(views: readonly ServerView[], options: ResolvedOptions): string {
  const urls = [
    sitemapUrl(`${options.siteUrl}/`),
    sitemapUrl(`${options.siteUrl}/methodology.html`),
    ...views.map((view) => sitemapUrl(pageUrl(view.entry, options), view.lastChecked)),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

/** `escapeHtml`'s entities are all valid XML, so URLs use the one escape path. */
function sitemapUrl(loc: string, lastmod?: string): string {
  const modified =
    lastmod === undefined ? '' : `<lastmod>${escapeHtml(formatDate(lastmod))}</lastmod>`;
  return `  <url><loc>${escapeHtml(loc)}</loc>${modified}</url>`;
}

/** Nothing here is private, so the only useful line is where the sitemap is. */
function robotsFile(options: ResolvedOptions): string {
  return `User-agent: *
Allow: /

Sitemap: ${options.siteUrl}/sitemap.xml
`;
}

/** One platform's latest result, as the feed exposes it. */
interface FeedPlatform {
  status: ProbeStatus;
  /** ISO timestamp of the probe, exactly as history recorded it. */
  date: string;
  toolCount?: number;
  /** Install phase duration in ms, when the probe installed a package. */
  installMs?: number;
}

interface FeedServer {
  id: string;
  slug: string;
  title: string;
  page: string;
  repoUrl?: string;
  /** Stargazer count of `repoUrl`, absent when none was fetched. */
  stars?: number;
  install: Install['label'];
  platforms: Partial<Record<Platform, FeedPlatform>>;
}

interface Feed {
  generatedAt: string;
  site: string;
  servers: FeedServer[];
}

/**
 * The whole dataset as JSON, for anyone who wants the results without scraping
 * the HTML. Same order as the index, most starred first. Statuses are carried
 * through verbatim, `needs_auth` and `needs_config` included, so a consumer can
 * bucket them its own way. Platforms we never probed are absent rather than null, so
 * `platforms` is empty for an untested server.
 */
function feedFile(views: readonly ServerView[], options: ResolvedOptions): string {
  const feed: Feed = {
    generatedAt: options.generatedAt,
    site: options.siteUrl,
    servers: views.map((view) => feedServer(view, options)),
  };

  return `${JSON.stringify(feed, null, 2)}\n`;
}

function feedServer(view: ServerView, options: ResolvedOptions): FeedServer {
  const { entry } = view;
  const platforms: Partial<Record<Platform, FeedPlatform>> = {};

  for (const platform of PLATFORMS) {
    const latest = view.latest.get(platform);
    if (latest === undefined) continue;
    platforms[platform] = {
      status: latest.status,
      date: latest.date,
      ...(latest.toolCount === undefined ? {} : { toolCount: latest.toolCount }),
      // Unlike the page, the feed carries every duration it has: a consumer
      // can pick its own threshold for "slow".
      ...(latest.installMs === undefined ? {} : { installMs: latest.installMs }),
    };
  }

  return {
    id: entry.id,
    slug: entry.slug,
    title: entry.title,
    page: pageUrl(entry, options),
    ...(entry.repoUrl === undefined ? {} : { repoUrl: entry.repoUrl }),
    ...(view.stars === undefined ? {} : { stars: view.stars }),
    install: view.install.label,
    platforms,
  };
}

/** Absolute URL of a server page, for consumers outside the site. */
function pageUrl(entry: ServerEntry, options: ResolvedOptions): string {
  return `${options.siteUrl}/s/${entry.slug}.html`;
}

// -------------------------------------------------------------------- derive

function viewOf(entry: ServerEntry, history: ServerHistory | undefined): ServerView {
  const latest = new Map<Platform, HistoryEntry>();
  for (const platform of PLATFORMS) {
    const newest = history?.platforms[platform]?.[0];
    if (newest !== undefined) latest.set(platform, newest);
  }

  const statuses = [...latest.values()].map((item) => item.status);
  const verdict: Verdict = statuses.some((status) => toneOf(status) === 'fail')
    ? 'failing'
    : statuses.includes('pass')
      ? 'passing'
      : statuses.some((status) => status === 'needs_auth' || status === 'needs_config')
        ? 'needsSetup'
        : 'untested';

  const view: ServerView = {
    entry,
    latest,
    history,
    verdict,
    stars: starsOf(entry),
    toolCount: toolCountOf(latest),
    lastChecked: lastCheckedOf(latest),
    install: installOf(entry),
  };
  return view;
}

/**
 * Display order: most stars first, entries with no count last, ties broken by
 * catalog rank so the order is stable from one build to the next.
 *
 * `rank` still decides what the sweep probes and how it shards, and it puts the
 * curated seed entries first for that purpose. It deliberately does not decide
 * what the index shows first: pinning our own seed entries above servers with a
 * hundred times the stars would read as self-promotion on a page whose whole
 * value is being a neutral index.
 */
function byStars(a: ServerEntry, b: ServerEntry): number {
  const left = starsOf(a);
  const right = starsOf(b);
  if (left !== right) {
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return right - left;
  }
  return a.rank - b.rank;
}

/**
 * Star count worth rendering. The catalog is generated, but it is also
 * committed and hand-editable, so a nonsense count reads as "unknown" rather
 * than reaching a page.
 */
function starsOf(entry: ServerEntry): number | undefined {
  const stars = entry.popularity?.stars;
  if (typeof stars !== 'number' || !Number.isFinite(stars) || stars < 0) return undefined;
  return Math.round(stars);
}

/** Tool count from the first platform that passed, in platform order. */
function toolCountOf(latest: ReadonlyMap<Platform, HistoryEntry>): number | undefined {
  for (const platform of PLATFORMS) {
    const entry = latest.get(platform);
    if (entry?.status === 'pass' && entry.toolCount !== undefined) return entry.toolCount;
  }
  return undefined;
}

function lastCheckedOf(latest: ReadonlyMap<Platform, HistoryEntry>): string | undefined {
  let newest: string | undefined;
  let newestTime = Number.NEGATIVE_INFINITY;

  for (const entry of latest.values()) {
    const time = Date.parse(entry.date);
    if (Number.isNaN(time)) {
      newest ??= entry.date;
      continue;
    }
    if (time > newestTime) {
      newestTime = time;
      newest = entry.date;
    }
  }
  return newest;
}

/** Mirrors the sweep's preference order: npm, PyPI, container, then remote. */
function installOf(entry: ServerEntry): Install {
  const npm = entry.packages.find((pkg) => pkg.kind === 'npm');
  if (npm !== undefined) {
    return {
      label: 'npm',
      command: `npx ${npm.identifier}`,
      hosted: false,
      requiresEnv: requiredNames(npm.env),
      needsArguments: npm.droppedArguments === true,
    };
  }

  const pypi = entry.packages.find((pkg) => pkg.kind === 'pypi');
  if (pypi !== undefined) {
    return {
      label: 'pypi',
      command: `uvx ${pypi.identifier}`,
      hosted: false,
      requiresEnv: requiredNames(pypi.env),
      needsArguments: pypi.droppedArguments === true,
    };
  }

  const oci = entry.packages.find((pkg) => pkg.kind === 'oci');
  if (oci !== undefined) {
    return {
      label: 'oci',
      command: `docker run -i --rm ${oci.identifier}`,
      hosted: false,
      requiresEnv: requiredNames(oci.env),
      needsArguments: oci.droppedArguments === true,
    };
  }

  // Same choice the probe makes: streamable HTTP first, legacy SSE as fallback.
  const remote =
    entry.remotes.find((candidate) => candidate.type === 'streamable-http') ?? entry.remotes[0];
  if (remote !== undefined) {
    const url = safeUrl(remote.url);
    return {
      label: 'remote',
      ...(url === undefined ? {} : { command: url }),
      hosted: true,
      requiresEnv: requiredNames(remote.headers),
      needsArguments: false,
    };
  }

  return { label: 'none', hosted: false, requiresEnv: [], needsArguments: false };
}

function requiredNames(specs: readonly { name: string; required: boolean }[]): string[] {
  return specs.filter((spec) => spec.required).map((spec) => spec.name);
}

// -------------------------------------------------------------------- format

function statusPhrase(status: ProbeStatus | undefined): string {
  return status === undefined ? 'never probed' : STATUS_PHRASES[status];
}

/**
 * `skipped` is grey, not red: we never learned whether it works. `needs_auth`
 * and `needs_config` are amber for the opposite reason: we learned the server
 * is alive and that it wants credentials or arguments we cannot supply, which
 * is neither a pass nor a break.
 */
function toneOf(status: ProbeStatus | undefined): Tone {
  if (status === undefined || status === 'skipped') return 'none';
  if (status === 'pass') return 'pass';
  return status === 'needs_auth' || status === 'needs_config' ? 'auth' : 'fail';
}

/**
 * Compact star counts for a narrow column: `987`, `1.2k`, `34k`. Exact below
 * 1000, one decimal up to 10k, whole thousands above it, where the decimal
 * would be noise.
 */
function formatStars(stars: number): string {
  if (stars < 1000) return String(stars);
  const thousands = stars / 1000;
  const rounded = thousands < 10 ? Math.round(thousands * 10) / 10 : Math.round(thousands);
  return `${String(rounded)}k`;
}

/**
 * A duration past one minute as `9m 12s`. Seconds are truncated rather than
 * rounded, so nothing ever renders as `9m 60s`.
 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60))}m ${String(total % 60)}s`;
}

/** ISO date as `YYYY-MM-DD`; unparsable input is passed through untouched. */
function formatDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toISOString().slice(0, 10);
}

function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
