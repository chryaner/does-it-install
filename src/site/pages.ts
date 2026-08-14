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
  /** Absolute site root, used for badge snippets people paste elsewhere. */
  siteUrl: string;
  /** ISO timestamp of this build. */
  generatedAt: string;
}

/** One output file, path relative to the output directory, `/`-separated. */
export interface Page {
  path: string;
  html: string;
}

/** How a server reads on the index: any failure wins, then any pass. */
type Verdict = 'passing' | 'failing' | 'untested';

/** Colour bucket for dots, squares and pills. */
type Tone = 'pass' | 'fail' | 'none';

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
  tools_failed: 'tools/list failed',
  timeout: 'timed out',
  skipped: 'not tested',
};

interface Install {
  /** Distribution the sweep would pick: npm, then pypi, then remote. */
  label: 'npm' | 'pypi' | 'remote' | 'none';
  /** `npx <pkg>`, `uvx <pkg>`, or the endpoint URL. */
  command?: string;
  /** True when `command` is an endpoint rather than a shell command. */
  hosted: boolean;
  /** Required env vars / headers the probe can only fill with placeholders. */
  requiresEnv: string[];
}

interface ServerView {
  entry: ServerEntry;
  /** Newest entry per platform, only for platforms with recorded runs. */
  latest: Map<Platform, HistoryEntry>;
  history: ServerHistory | undefined;
  verdict: Verdict;
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

/** Build every page of the site. Catalog order (by rank) is preserved. */
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
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => viewOf(entry, histories.get(entry.slug)));

  return [
    { path: 'index.html', html: indexPage(catalog, views, resolved) },
    ...views.map((view) => ({
      path: `s/${view.entry.slug}.html`,
      html: serverPage(view, resolved),
    })),
    { path: 'methodology.html', html: methodologyPage(resolved) },
    { path: '404.html', html: notFoundPage(resolved) },
  ];
}

// ---------------------------------------------------------------- index page

function indexPage(catalog: Catalog, views: readonly ServerView[], options: ResolvedOptions): string {
  const counts = { passing: 0, failing: 0, untested: 0 };
  for (const view of views) counts[view.verdict]++;

  const rows =
    views.length === 0
      ? '<tr><td colspan="5" class="muted">No servers in the catalog yet.</td></tr>'
      : views.map((view) => indexRow(view, options)).join('\n');

  const body = `<h1>Does it install?</h1>
<p class="pitch">${escapeHtml(PITCH)}</p>
<div class="counts">
${countCard(counts.passing, 'passing', 'pass')}
${countCard(counts.failing, 'failing', 'fail')}
${countCard(counts.untested, 'untested', 'none')}
${countCard(views.length, 'servers')}
</div>
<div class="scroll"><table>
<thead><tr><th>Status</th><th>Server</th><th>Install</th><th>Tools</th><th>Last checked</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<p class="legend">Status dots are ${PLATFORMS.map((platform) => escapeHtml(PLATFORM_LABELS[platform])).join(' &middot; ')}, in that order. Hover one for its result. A server counts as failing when its latest probe failed on any platform we tested.</p>
<p class="legend">Site built ${escapeHtml(formatDateTime(options.generatedAt))}${catalog.generatedAt === '' ? '' : ` &middot; catalog generated ${escapeHtml(formatDateTime(catalog.generatedAt))}`}.</p>`;

  return layout('does it install? · MCP server status', body, options.base);
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
<td class="num">${view.toolCount === undefined ? '<span class="muted">n/a</span>' : String(view.toolCount)}</td>
<td class="when">${view.lastChecked === undefined ? 'never' : escapeHtml(formatDate(view.lastChecked))}</td>
</tr>`;
}

// --------------------------------------------------------------- server page

function serverPage(view: ServerView, options: ResolvedOptions): string {
  const { entry, install } = view;
  const badge = `[![does it install](https://img.shields.io/endpoint?url=${options.siteUrl}/badge/${entry.slug}.json)](${options.siteUrl}/s/${entry.slug}.html)`;

  const sections = [
    `<p class="crumb"><a href="${href(options.base, '')}">&larr; All servers</a></p>`,
    `<h1>${escapeHtml(entry.title)}</h1>`,
    entry.description === undefined ? '' : `<p class="pitch">${escapeHtml(entry.description)}</p>`,
    `<p class="muted"><code>${escapeHtml(entry.id)}</code>${metaLinks(entry)}</p>`,

    '<h2>Install</h2>',
    installBlock(install),

    '<h2>Results by platform</h2>',
    PLATFORMS.map((platform) => platformBlock(view, platform)).join('\n'),

    '<h2>Badge</h2>',
    '<p>Paste this into the project README to show the current result:</p>',
    `<pre class="cmd"><code>${escapeHtml(badge)}</code></pre>`,
  ];

  return layout(`${entry.title} · does it install?`, sections.filter(Boolean).join('\n'), options.base);
}

/** Trailing " · Repository · Website · version 1.2.3 · listed from registry". */
function metaLinks(entry: ServerEntry): string {
  const links = [
    entry.repoUrl === undefined ? '' : externalLink(entry.repoUrl, 'Repository'),
    entry.websiteUrl === undefined ? '' : externalLink(entry.websiteUrl, 'Website'),
    entry.version === undefined ? '' : `version ${escapeHtml(entry.version)}`,
    `listed from ${escapeHtml(entry.source)}`,
  ].filter((part) => part !== '');
  return ` &middot; ${links.join(' &middot; ')}`;
}

function installBlock(install: Install): string {
  if (install.command === undefined) {
    return install.hosted
      ? '<p class="note">The listed endpoint is not a usable http(s) URL, so there is nothing for the sweep to connect to.</p>'
      : '<p class="note">No npm, PyPI or hosted distribution is listed for this server, so there is nothing for the sweep to install.</p>';
  }

  const caption = install.hosted
    ? 'Hosted endpoint, so there is nothing to install. The probe connects straight to it:'
    : 'The sweep installs into a clean prefix, but this is the command a user would run:';

  const credentials =
    install.requiresEnv.length === 0
      ? ''
      : `\n<p class="note">Needs credentials: ${install.requiresEnv
          .map((name) => `<code>${escapeHtml(name)}</code>`)
          .join(', ')}. The probe used placeholder values, so a red result here can simply mean “no valid credentials”.</p>`;

  return `<p class="muted">${escapeHtml(caption)}</p>
<pre class="cmd"><code>${escapeHtml(install.command)}</code></pre>${credentials}`;
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

  const parts = [
    `<header><h3>${escapeHtml(label)}</h3><span class="verdict ${toneOf(latest.status)}">${escapeHtml(statusPhrase(latest.status))}</span><span class="muted">${when}</span></header>`,
    historyStrip(entries),
    toolsBlock(latest),
    latest.status !== 'pass' && latest.errorExcerpt !== undefined
      ? `<pre class="err">${escapeHtml(latest.errorExcerpt)}</pre>`
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
<p class="pitch">How a green or red square on this site is produced, and what it does not tell you.</p>

<h2>What one probe does</h2>
<p>Every server in the catalog is probed independently, in a disposable CI runner, with no shared state between servers. The sweep picks the first distribution it supports (npm, then PyPI, then a hosted endpoint) and walks these phases:</p>
<ul>
<li><b>install</b>: <code>npm install</code> into a fresh temporary prefix with a clean cache, or <code>uv tool run</code> for PyPI. Nothing is installed globally.</li>
<li><b>spawn / connect</b>: the server binary is started over stdio, or the hosted endpoint is opened with the streamable-HTTP or legacy SSE transport.</li>
<li><b>handshake</b>: an MCP <code>initialize</code> round trip with the official SDK client.</li>
<li><b>tools/list</b>: the tool list is requested; the count on each page comes from this response.</li>
</ul>
<p>A server only shows green when every phase succeeded. Otherwise the status names the phase that broke, and the newest stderr output is kept and shown verbatim on the server page.</p>

<h2>Time budgets</h2>
<p>Each phase has its own budget: 300s to install, 30s to spawn, 30s for the handshake, 15s for <code>tools/list</code>, and 20s to reach a hosted endpoint. Exceeding one records <em>timed out</em> against that phase rather than a generic failure.</p>

<h2>Credentials</h2>
<p>We probe with no accounts anywhere. Environment variables a server declares as required are filled with the literal placeholder <code>${escapeHtml(ENV_PLACEHOLDER)}</code>, and every affected server page says so above its results. A server that needs a real API key can therefore install perfectly and still fail the handshake here.</p>

<h2>Platforms and cadence</h2>
<p>Probes run on ${PLATFORMS.map((platform) => escapeHtml(PLATFORM_LABELS[platform])).join(', ')} runners, weekly, plus manual re-runs. Each server keeps its last ${String(HISTORY_LIMIT)} results per platform, which is what the history strip shows. Servers that disappear from the registry keep their pages: knowing when something stopped working is the point.</p>

<h2>Caveats</h2>
<ul>
<li><b>Red does not always mean broken.</b> It can mean the server needs credentials we do not have, needs a runtime the runner lacks, or was published for one platform only.</li>
<li><b>Hosted endpoints that answer 401 or 403</b> are recorded as a failed handshake with the HTTP detail. They are reachable, but they require auth we do not send.</li>
<li><b>Grey means untested</b>, never "bad": no supported distribution, an OCI-only server (not probed yet), or a runner missing <code>uv</code>.</li>
<li><b>We test installation and the handshake, not behaviour.</b> A green square says the server starts and lists its tools; it says nothing about whether those tools work well.</li>
<li><b>Results are a snapshot.</b> Registries, package versions and hosted endpoints all move between sweeps.</li>
</ul>

<h2>Corrections</h2>
<p>Every result is reproducible from the command shown on the server page. If a result looks wrong, the error excerpt is the whole evidence we have, so file an issue on the project repository with it.</p>
</div>`;

  return layout('Methodology · does it install?', body, options.base);
}

function notFoundPage(options: ResolvedOptions): string {
  const body = `<h1>404</h1>
<p class="pitch">No page here. The server you are looking for may never have been catalogued.</p>
<p><a href="${href(options.base, '')}">Back to all servers</a></p>`;

  return layout('404 · does it install?', body, options.base);
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
      : 'untested';

  const view: ServerView = {
    entry,
    latest,
    history,
    verdict,
    toolCount: toolCountOf(latest),
    lastChecked: lastCheckedOf(latest),
    install: installOf(entry),
  };
  return view;
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

/** Mirrors the sweep's preference order: npm, then PyPI, then a remote. */
function installOf(entry: ServerEntry): Install {
  const npm = entry.packages.find((pkg) => pkg.kind === 'npm');
  if (npm !== undefined) {
    return {
      label: 'npm',
      command: `npx ${npm.identifier}`,
      hosted: false,
      requiresEnv: requiredNames(npm.env),
    };
  }

  const pypi = entry.packages.find((pkg) => pkg.kind === 'pypi');
  if (pypi !== undefined) {
    return {
      label: 'pypi',
      command: `uvx ${pypi.identifier}`,
      hosted: false,
      requiresEnv: requiredNames(pypi.env),
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
    };
  }

  return { label: 'none', hosted: false, requiresEnv: [] };
}

function requiredNames(specs: readonly { name: string; required: boolean }[]): string[] {
  return specs.filter((spec) => spec.required).map((spec) => spec.name);
}

// -------------------------------------------------------------------- format

function statusPhrase(status: ProbeStatus | undefined): string {
  return status === undefined ? 'never probed' : STATUS_PHRASES[status];
}

/** `skipped` is grey, not red: we never learned whether it works. */
function toneOf(status: ProbeStatus | undefined): Tone {
  if (status === undefined || status === 'skipped') return 'none';
  return status === 'pass' ? 'pass' : 'fail';
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
