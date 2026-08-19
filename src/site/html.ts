/**
 * HTML primitives shared by every generated page.
 *
 * Two rules the rest of the site module depends on:
 *  - every value that reaches the output goes through `escapeHtml` first
 *    (server titles, descriptions and stderr excerpts are third-party input),
 *  - every link goes through `href`, so the `--base` prefix is applied in one
 *    place and GitHub Pages project sites work without post-processing.
 *
 * The stylesheet is inlined: the site must render with no network access, no
 * fonts, no JavaScript. It carries four status tones, used by dots, history
 * squares, verdict pills and the summary cards alike: green `pass`, red `fail`,
 * amber `auth` (alive, but asking for credentials or configuration the probe
 * cannot supply) and grey `none` (nothing was learned). `auth` is named for the
 * commoner case and covers both: `needs_auth` and `needs_config` share it.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for use in element content or a quoted attribute value. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Normalize a site base so it can be concatenated with a relative path:
 * `''` and `'/'` stay `'/'`, `'does-it-install'` becomes `'/does-it-install/'`.
 * An absolute base (`https://host/x`) only gains its trailing slash.
 */
export function normalizeBase(base: string): string {
  const trimmed = base.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const withTrailing = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(withTrailing)) return withTrailing;
  return withTrailing.startsWith('/') ? withTrailing : `/${withTrailing}`;
}

/** Escaped `href` value for a site-relative path such as `s/slug.html`. */
export function href(base: string, path: string): string {
  return escapeHtml(`${normalizeBase(base)}${path.replace(/^\/+/, '')}`);
}

/**
 * A third-party URL we are willing to link to, or undefined. Catalog entries
 * carry whatever the registry published, so anything that is not plain
 * http(s) is dropped rather than rendered (`javascript:` above all).
 */
export function safeUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return /^https?:\/\//i.test(value) ? value : undefined;
}

/** `<a>` to an external URL, or plain escaped text when the URL is unusable. */
export function externalLink(raw: string | undefined, text: string): string {
  const url = safeUrl(raw);
  if (url === undefined) return escapeHtml(text);
  return `<a href="${escapeHtml(url)}" rel="noopener nofollow">${escapeHtml(text)}</a>`;
}

const STYLES = `
:root{color-scheme:light;--bg:#fff;--panel:#f6f8fa;--fg:#1f2328;--muted:#59636e;
--line:#d8dee4;--link:#0969da;--pass:#2da44e;--fail:#cf222e;--none:#8c959f;--auth:#bf8700;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-size:16px;line-height:1.55;
font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
h1{font-size:28px;line-height:1.25;margin:0 0 8px}
h2{font-size:18px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:15px;margin:0 0 6px}
p{margin:0 0 12px}
.masthead{background:var(--panel);border-bottom:1px solid var(--line)}
.masthead .wrap{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;
justify-content:space-between;padding-top:14px;padding-bottom:14px}
.brand{font-family:var(--mono);font-weight:600;font-size:15px;color:var(--fg)}
.brand .q{color:var(--pass)}
.masthead nav{display:flex;gap:18px;font-size:14px}
main.wrap{padding-top:28px;padding-bottom:48px}
.pitch{font-size:17px;color:var(--muted);max-width:64ch}
.crumb{font-size:13px;margin-bottom:16px}
.muted{color:var(--muted)}
.mono{font-family:var(--mono)}
.counts{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0 8px}
.count{flex:1 1 150px;border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--panel)}
.count b{display:block;font-family:var(--mono);font-size:24px;line-height:1.2}
.count span{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.count.pass b{color:var(--pass)}
.count.fail b{color:var(--fail)}
.count.auth b{color:var(--auth)}
.count.none b{color:var(--none)}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:14px}
th{text-align:left;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);
background:var(--panel);padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--panel)}
td.num{font-family:var(--mono);text-align:right;white-space:nowrap}
td.when{font-family:var(--mono);font-size:13px;color:var(--muted);white-space:nowrap}
td.dots{white-space:nowrap}
.name{font-weight:600}
.id{display:block;font-family:var(--mono);font-size:12px;color:var(--muted);word-break:break-all}
.legend{font-size:12px;color:var(--muted);margin:10px 0 0}
.dot{display:inline-block;width:10px;height:10px;margin-right:5px;border-radius:50%;background:var(--none)}
.dot.pass{background:var(--pass)}
.dot.fail{background:var(--fail)}
.dot.auth{background:var(--auth)}
.strip{display:flex;flex-wrap:wrap;gap:3px;margin:10px 0}
.sq{width:12px;height:12px;border-radius:2px;background:var(--none)}
.sq.pass{background:var(--pass)}
.sq.fail{background:var(--fail)}
.sq.auth{background:var(--auth)}
.verdict{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid var(--none);color:var(--muted)}
.verdict.pass{color:var(--pass);border-color:#2da44e;background:#eaf6ed}
.verdict.fail{color:var(--fail);border-color:#cf222e;background:#fbeaec}
.verdict.auth{color:var(--auth);border-color:#d4a72c;background:#fff8c5}
.platform{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0}
.platform header{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:4px}
.platform h3{margin:0}
code{font-family:var(--mono);font-size:13px;background:var(--panel);border:1px solid var(--line);
border-radius:4px;padding:1px 5px;word-break:break-all}
pre{margin:0}
pre.cmd{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto}
pre.cmd code{background:none;border:0;padding:0;word-break:normal;white-space:pre}
pre.err{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--fail);
border-radius:6px;padding:12px 14px;max-height:320px;overflow:auto;font-family:var(--mono);
font-size:12.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
pre.err.auth{border-left-color:var(--auth)}
.note{background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:10px 12px;font-size:14px}
.tools{font-size:14px;margin:8px 0 0}
.prose h2{margin-top:30px}
.prose p,.prose li{max-width:74ch}
.prose ul{margin:0 0 12px;padding-left:20px}
.prose li{margin-bottom:6px}
.foot{background:var(--panel);border-top:1px solid var(--line);margin-top:40px}
.foot .wrap{display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between;
padding-top:16px;padding-bottom:16px;font-size:13px;color:var(--muted)}
@media (max-width:600px){h1{font-size:23px}.count{flex-basis:110px}}
`.trim();

/**
 * Full HTML5 document: masthead, `body` as the main content, footer.
 * `description` feeds the meta description and OpenGraph tags, so search
 * results and link previews show something better than a bare URL.
 * `canonical` is the page's absolute URL, and is what stops a crawler treating
 * the same page reached two ways as duplicates. Pages without a stable public
 * URL (404) pass none, and then neither tag is emitted.
 */
export function layout(
  title: string,
  body: string,
  base: string,
  description: string,
  canonical?: string,
): string {
  const root = escapeHtml(normalizeBase(base));
  const summary = escapeHtml(description);
  const canonicalLink =
    canonical === undefined ? '' : `\n<link rel="canonical" href="${escapeHtml(canonical)}">`;
  const canonicalMeta =
    canonical === undefined ? '' : `\n<meta property="og:url" content="${escapeHtml(canonical)}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${summary}">${canonicalLink}
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${summary}">
<meta property="og:type" content="website">${canonicalMeta}
<style>${STYLES}</style>
</head>
<body>
<header class="masthead"><div class="wrap">
<a class="brand" href="${root}">does-it-install<span class="q">?</span></a>
<nav><a href="${root}">Servers</a><a href="${root}methodology.html">Methodology</a></nav>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="foot"><div class="wrap">
<span>Automated results from a scheduled sweep. Not affiliated with any listed project.</span>
<a href="${root}methodology.html">How this is tested</a>
</div></footer>
</body>
</html>
`;
}
