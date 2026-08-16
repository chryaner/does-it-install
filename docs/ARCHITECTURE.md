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
- Deduplicates by id, guarantees unique slugs, assigns `rank`: seed entries
  first in seed order, then registry entries by GitHub stars descending, with
  entries that have no count last in registry order (ties keep registry order,
  so ranks are stable between builds and sharding does not reshuffle).
- Stars come from the GraphQL API (`src/catalog/stars.ts`), 100 repos per
  query, keyed on `repoUrl`, and land in `ServerEntry.popularity`. They need
  `GITHUB_TOKEN`; without it, or for a batch that fails twice, the entry keeps
  no count and the build carries on. Popularity is never fatal.
- `--limit` cuts the ranked list at the end; pagination is never capped with
  it, because ranking a prefix would rank an alphabetical sample.
- `--offline` builds from the seed file only, with no registry and no star
  lookup. Registry fetch failures must never produce a truncated catalog
  silently: fail loudly, or fall back with a clear warning.
- Registry outage fallback: when the registry is unreachable and a previous
  catalog file exists at the output path, the build keeps that catalog and warns
  loudly instead of failing, so the sweep probes last week's list rather than
  skipping the week. With no previous file to fall back to, the build still
  fails: a stale catalog is data, an empty one is not.
- CLI: `npm run catalog -- [--out data/catalog.json] [--offline] [--limit N]`

### sweep (`src/harness/`)
For each catalog entry, pick the first supported distribution (npm, then pypi,
then oci, then remote) and probe it:

- **npm**: install into a fresh temp prefix (`npm install --prefix <tmp>
  <pkg>` with a clean cache), locate the package `bin`, spawn over stdio with
  the SDK client, `initialize`, `tools/list`. No global state.
- **pypi**: `uv tool run` (uvx) equivalent, spawned the same way. If `uv` is
  missing on the runner the probe records `skipped`, never a failure. The
  console script is guessed from the package identifier; when uv rejects the
  guess and names the executable the package really installs, the probe re-runs
  once with that name and records the second result. One retry, only for the
  "no such executable" error, only when uv named a replacement.
- **oci**: `docker pull <image>`, then `docker run -i --rm --pull=never --name
  dii-<uuid> --memory 2g --pids-limit 512` with the declared env vars as `-e`
  pairs, spawned over stdio like the others. The limits are containment, not
  benchmarking: third-party images share a runner with three other probes, and
  one that exhausts memory or forks without bound must not take them down. The
  container is force-removed afterwards, whatever happened: killing the docker
  client does not stop the container. A runner without a daemon running Linux
  containers (`docker version --format {{.Server.Os}}`) records `skipped`, never
  a failure: macOS has no daemon and Windows runs Windows containers, so this is
  a Linux-only probe in practice.
- **remote-http / remote-sse**: connect with StreamableHTTP/SSE transports,
  `initialize`, `tools/list`. Endpoints that 401/403 without auth headers, and
  endpoints that reject an unauthenticated `initialize` while declaring headers
  they require, are recorded as `needs_auth` with the HTTP detail. "Reachable
  but needs auth" is real signal, it is not a failure, and the site renders it
  amber rather than red.
- Required env vars are filled with `ENV_PLACEHOLDER` and recorded in
  `requiresEnv` so pages can caveat the result. A stdio server that then will
  not start or will not finish the handshake is recorded `needs_auth` instead of
  `spawn_failed`/`handshake_failed`: it asked for credentials we withheld.
- Arguments the registry declared as placeholders are dropped by the catalog
  rather than invented, and the package carries `droppedArguments`. A stdio
  server with dropped arguments that will not start or will not handshake is
  recorded `needs_config` for the same reason. `needs_auth` wins when both
  applied, since a missing key is the commoner cause. Neither is a failure, and
  `install_failed`, `tools_failed` and `timeout` are never reclassified either
  way.
- Per-phase timeouts (install 600s, which also covers `docker pull`, spawn 30s,
  handshake 30s, tools 15s, remote connect 20s). A phase timeout yields status
  `timeout` with the phase recorded in `phases`.
- stderr is captured continuously; on failure the excerpt keeps the newest
  `MAX_ERROR_EXCERPT` chars. The child process tree is always killed and temp
  dirs removed, success or failure.
- Concurrency-limited worker pool (default 4). One server crashing, hanging,
  or writing garbage to stdout must never take down the sweep: every probe is
  fully isolated in try/catch and its result recorded.
- CLI: `npm run sweep -- [--catalog p] [--out p] [--top N] [--shard i/N]
  [--only <id-or-slug>] [--methods npm,pypi,oci,remote]`
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
Emits shields endpoint JSON per server: overall (`badge/<slug>.json`) and
per-platform (`badge/<slug>-<platform>.json`). Green `passing`, red `failing`
with the failing phase, yellow `needs credentials` (`needs_auth`) and
`needs configuration` (`needs_config`), grey `unknown`/`skipped`.
The overall badge is the worst recent status across the platforms that produced
a result: `skipped` platforms are dropped before anything is counted, so a
container skipped on macOS cannot grey out what Linux proved, and only a server
with no result anywhere reads `untested`. `cacheSeconds` ≥ 3600.
Embed URL: `https://img.shields.io/endpoint?url=<pages>/badge/<slug>.json`.

### site (`src/site/`)
Static generator, no framework, inline CSS, output to `public/`:
- `index.html`: status table (title, badge state per platform, star count,
  tool count, last checked), ordered by GitHub stars descending with entries
  that have no count last and ties broken by `rank`; summary counts of passing,
  failing, needs setup (the amber bucket: `needs_auth` plus `needs_config`) and
  untested. Display order is stars alone: `rank`
  puts the seed entries first for probing and sharding, and giving them the top
  of a neutral index on top of that would read as self-promotion.
- `s/<slug>.html`: per-server page with the install command, a green/red
  history strip per platform, latest error excerpt in a `<pre>` (HTML-escaped),
  tool names, badge markdown snippet, links to repo/site.
- `methodology.html` from `docs/METHODOLOGY.md` content (hand-written HTML is
  fine; no markdown pipeline dependency).
- `sitemap.xml` and `robots.txt`: index, methodology and every server page,
  with `lastmod` from the newest probe a server has.
- `index.json`: the whole dataset (server identity, page URL, install method,
  star count when known, latest result per platform) for consumers who should
  not have to scrape HTML.
- Everything self-contained: no external JS/CSS/fonts. Escape ALL
  interpolated strings, because server descriptions and stderr are untrusted
  input.
- Base path configurable: `--base /` for the custom domain,
  `--base /does-it-install/` for a GitHub Pages project site.

## CI (`.github/workflows/`)
- `ci.yml` runs on PR/push: `npm ci`, typecheck, unit tests. Smoke job
  (linux): probes the three seed servers end-to-end and builds the site.
- `sweep.yml` runs on a weekly cron plus manual dispatch with
  `top`/`shard_total` inputs: catalog job (with `github.token` in the
  environment, so the ranking gets star counts), then probe matrix (`ubuntu-latest`,
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
Container probes on macOS and Windows runners, Windows-specific install quirks
pages, popularity signals beyond GitHub stars (npm downloads, registry usage),
per-host-app compatibility (Claude Desktop / Codex / Cline versions).
