# Architecture

**does-it-install** answers one question the MCP directories don't: does this
server still install and connect *today*? A scheduled sweep installs each
catalogued server clean, performs a real MCP handshake, lists its tools, and
publishes the result, including the actual error text when it breaks, as a
static site with per-server pages, green/red history strips, and shields.io
badges maintainers can embed.

## Pipeline

Five stages, each an independent CLI so CI can run and shard them separately:

```
catalog   registry + data/seed.json      -> data/catalog.json
sweep     catalog (sharded, per-OS)      -> data/runs/<runId>-<platform>.json
merge     runs + existing history        -> data/history/<slug>.json
badges    history                        -> public/badge/<slug>.json
site      catalog + history              -> public/**  (static HTML)
```

All on-disk shapes are defined in `src/types.ts`. That file is the contract;
nothing else defines data shapes.

## Stages

### catalog (`src/catalog/`)
- Fetches `https://registry.modelcontextprotocol.io/v0/servers?version=latest`
  with cursor pagination (`metadata.nextCursor`), normalizing the 2025-12-11
  server schema (`packages[].registryType/identifier/version/runtimeHint/
  runtimeArguments/packageArguments/environmentVariables`, `remotes[]`) into
  `ServerEntry`.
- Merges `data/seed.json` (seed entries win on id collision).
- Deduplicates by id, guarantees unique slugs, assigns `rank` (seed entries
  first, then registry order). Registry popularity signals can refine this
  later.
- `--offline` builds from the seed file only. Registry fetch failures must not
  produce a truncated catalog silently: fail loudly, or fall back to seed with
  a clear warning.
- CLI: `npm run catalog -- [--out data/catalog.json] [--offline] [--limit N]`

### sweep (`src/harness/`)
For each catalog entry, pick the first supported distribution (npm, then pypi,
then remote) and probe it:

- **npm**: install into a fresh temp prefix (`npm install --prefix <tmp>
  <pkg>` with a clean cache), locate the package `bin`, spawn over stdio with
  the SDK client, `initialize`, `tools/list`. No global state.
- **pypi**: `uv tool run` (uvx) equivalent, spawned the same way. If `uv` is
  missing on the runner the probe records `skipped`, never a failure.
- **remote-http / remote-sse**: connect with StreamableHTTP/SSE transports,
  `initialize`, `tools/list`. Endpoints that 401/403 without auth headers are
  recorded as `handshake_failed` with the HTTP detail. "Reachable but needs
  auth" is real signal, and the page will say so via `requiresEnv`.
- **oci**: `skipped` in v1.
- Required env vars are filled with `ENV_PLACEHOLDER` and recorded in
  `requiresEnv` so pages can caveat the result.
- Per-phase timeouts (install 300s, spawn 30s, handshake 30s, tools 15s,
  remote connect 20s). A phase timeout yields status `timeout` with the phase
  recorded in `phases`.
- stderr is captured continuously; on failure the excerpt keeps the newest
  `MAX_ERROR_EXCERPT` chars. The child process tree is always killed and temp
  dirs removed, success or failure.
- Concurrency-limited worker pool (default 4). One server crashing, hanging,
  or writing garbage to stdout must never take down the sweep: every probe is
  fully isolated in try/catch and its result recorded.
- CLI: `npm run sweep -- [--catalog p] [--out p] [--top N] [--shard i/N]
  [--only <id-or-slug>] [--methods npm,pypi,remote]`
- Sharding is deterministic: entry k of the ranked top-N goes to shard
  `k % shardTotal`.

**Safety**: probing means executing third-party code. The sweep is designed to
run in disposable CI runners. Local smoke tests restrict installs to the
official packages in `data/seed.json`.

### merge (`src/history/`)
Reads every run file in `data/runs/`, appends to per-server history keyed by
platform, newest first, capped at `HISTORY_LIMIT`. Idempotent: re-merging the
same `runId` must not duplicate entries. History files for servers no longer
in the catalog are kept (rot data is the product).

### badges (`src/badges/`)
Emits shields endpoint JSON per server: overall (`badge/<slug>.json`, worst
recent status across platforms) and per-platform
(`badge/<slug>-<platform>.json`). Green `passing`, red `failing` with the
failing phase, grey `unknown`/`skipped`. `cacheSeconds` ≥ 3600.
Embed URL: `https://img.shields.io/endpoint?url=<pages>/badge/<slug>.json`.

### site (`src/site/`)
Static generator, no framework, inline CSS, output to `public/`:
- `index.html`: status table (title, badge state per platform, tool count,
  last checked), sorted working-first by rank; summary counts.
- `s/<slug>.html`: per-server page with the install command, a green/red
  history strip per platform, latest error excerpt in a `<pre>` (HTML-escaped),
  tool names, badge markdown snippet, links to repo/site.
- `methodology.html` from `docs/METHODOLOGY.md` content (hand-written HTML is
  fine; no markdown pipeline dependency).
- `sitemap.xml` and `robots.txt`: index, methodology and every server page,
  with `lastmod` from the newest probe a server has.
- `index.json`: the whole dataset (server identity, page URL, install method,
  latest result per platform) for consumers who should not have to scrape HTML.
- Everything self-contained: no external JS/CSS/fonts. Escape ALL
  interpolated strings, because server descriptions and stderr are untrusted
  input.
- Base path configurable: `--base /` for the custom domain,
  `--base /does-it-install/` for a GitHub Pages project site.

## CI (`.github/workflows/`)
- `ci.yml` runs on PR/push: `npm ci`, typecheck, unit tests. Smoke job
  (linux): probes the three seed servers end-to-end and builds the site.
- `sweep.yml` runs on a weekly cron plus manual dispatch with
  `top`/`shard_total` inputs: catalog job, then probe matrix (`ubuntu-latest`,
  `macos-latest`, `windows-latest` × shards) uploading run artifacts, then a
  merge job that downloads artifacts, merges history, commits `data/` back to
  the default branch, builds, and deploys `public/` to GitHub Pages.
- Probe jobs must tolerate individual failures (`fail-fast: false`; a red
  server is data, not a CI failure).

## Testing
- Unit tests colocated (`*.test.ts`): catalog normalization against captured
  registry fixtures, sharding/ranking, merge idempotency + cap, badge
  colors/messages, site HTML escaping and structure. No network.
- Smoke tests (`*.smoke.test.ts`, `npm run test:smoke`): real installs of the
  seed servers, full probe, assert `pass` with tools found.

## v2 (explicitly out of scope now)
Docker/OCI probes, Windows-specific install quirks pages, registry popularity
ranking, per-host-app compatibility (Claude Desktop / Codex / Cline versions).
