# does-it-install

A continuously tested index of public MCP servers: does each one still install
and connect today?

The directories list servers. Nobody tests them. An entry can sit in a registry
for a year after its package stopped resolving, its entry point got renamed, or
its hosted endpoint went away, and you find out by pasting the config into
your client and watching it fail.

This project installs each catalogued server from scratch on Linux, macOS and
Windows, performs a real MCP handshake, asks for its tool list, and publishes
what happened, including the actual error text when it breaks, as a static
site with per-server pages, green/red history strips, and shields.io badges
maintainers can embed.

Scope: the index covers the first few hundred servers the official MCP registry
lists (registry order, which is roughly alphabetical, not a popularity
ranking), plus a curated seed file, refreshed weekly. It is not every MCP
server ever published, and a green badge means "installed and answered
`tools/list` last Monday", not "good", "safe" or "maintained".
[docs/METHODOLOGY.md](docs/METHODOLOGY.md) is precise about what each result
does and does not claim.

## Badges

Every server gets a shields.io endpoint badge, plus one per platform. Embed the
overall badge in your own README:

```markdown
[![does it install](https://img.shields.io/endpoint?url=https://chryaner.github.io/does-it-install/badge/io.github.owner__name.json)](https://chryaner.github.io/does-it-install/s/io.github.owner__name.html)
```

Replace `io.github.owner__name` with your server's slug: its id lowercased
with `/` replaced by `__`. The exact URL is printed on your server's page. For
a single platform, use `badge/<slug>-linux.json`, `-darwin` or `-win32`.

| Badge reads | Meaning |
| --- | --- |
| `passing` | installed, handshook, returned a tool list |
| `install fails` / `won't start` / `handshake fails` / `tools/list fails` | it broke, and the page shows where and why |
| `unreachable` / `times out` | remote endpoint did not answer in budget |
| `failing on 1/3 platforms` | works somewhere, broken elsewhere |
| `untested` | no supported distribution yet (e.g. Docker-only), or never probed |

## How the probe works

Five phases per server, each with its own budget:

| Phase | Budget | What it means |
| --- | --- | --- |
| install | 300 s | `npm install` into a fresh temp prefix, or `uv tool run` from PyPI |
| spawn | 30 s | the installed binary actually starts |
| connect | 20 s | remote endpoints only: reaching the hosted URL |
| handshake | 30 s | MCP `initialize` round trip |
| tools/list | 15 s | the server enumerates its tools |

Nothing is installed globally, temp dirs and process trees are always cleaned
up, required environment variables are filled with a placeholder (never real
credentials) and reported on the page, and remote endpoints that answer
401/403 are recorded as "reachable but needs auth" rather than as dead.

Full details (catalog sources, ranking, sharding, the env and remote-auth
policies, badge semantics, and the limitations that matter when you read a red
badge) are in [docs/METHODOLOGY.md](docs/METHODOLOGY.md). The design is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Safety

**The harness installs and executes third-party code. That is the whole point
of it, and it is why sweeps belong in disposable environments only**:
throwaway CI runners, containers or VMs you can delete. Do not run a full sweep
on a machine you care about.

The local commands below are the safe subset: they build the catalog offline
and probe only the official reference servers listed in `data/seed.json`. The
harness never forwards environment variables a server declares as secret, so
your real tokens are not handed to anything it runs.

## Running it locally

Requires Node 22. `uv` is optional, and without it PyPI servers are recorded
`skipped` rather than failed.

```sh
npm ci
npm run typecheck
npm test
```

Then walk the pipeline. Each stage is an independent CLI that writes files and
logs to stderr; `--help` documents the rest of the flags.

```sh
npm run catalog -- --offline                    # data/catalog.json from data/seed.json only
npm run sweep -- --only seed/server-everything  # data/runs/<runId>-<platform>.json
npm run merge                                   # data/history/<slug>.json
npm run badges                                  # public/badge/<slug>.json
npm run site                                    # public/index.html, public/s/<slug>.html
```

Open `public/index.html` in a browser to see the result.

To work against the real registry, drop `--offline` and cap the sweep instead
of running the whole catalog, in a disposable environment, per the section
above:

```sh
npm run catalog
npm run sweep -- --top 25 --methods npm --concurrency 4
```

`npm run test:smoke` runs the real end-to-end probes against the seed servers
(this does install packages from npm).

## Adding or fixing a server

- **Missing?** Publish it to the [official MCP
  registry](https://registry.modelcontextprotocol.io). The weekly sweep reads
  `version=latest` and picks new entries up automatically.
- **In the registry but its record is wrong or unprobeable?** Open a PR adding
  an entry to `data/seed.json`. Seed entries win on id collision, so they are
  the way to correct a bad package identifier, pin a version, or supply the
  arguments a server needs to start. The shape is `ServerEntry` in
  `src/types.ts` minus the fields the builder fills in (`slug`, `source`).
- **Badge wrong?** Open an issue with a link to the server page and the error
  excerpt it shows. Known causes of false negatives (placeholder credentials
  and guessed PyPI console scripts) are listed under "Known limitations" in
  the methodology.

Results are never edited by hand. If a server is red and should not be, the fix
is in the catalog entry or in the harness, not in `data/history/`.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/types.ts` | the data contract: every on-disk shape, nothing else defines them |
| `src/catalog/` | registry + `data/seed.json` → `data/catalog.json` |
| `src/harness/` | the probe: install, spawn, handshake, `tools/list`, per-OS sharding |
| `src/history/` | run artifacts → `data/history/<slug>.json` (idempotent merge) |
| `src/badges/` | history → `public/badge/<slug>.json` |
| `src/site/` | catalog + history → `public/` (static HTML, no framework, no external assets) |
| `data/seed.json` | curated servers, always probed, always win on id collision |
| `data/history/` | the committed record: green/red per platform, 30 entries deep |
| `docs/ARCHITECTURE.md` | how the pipeline fits together |
| `docs/METHODOLOGY.md` | exactly what a probe does and what each status means |
| `.github/workflows/ci.yml` | typecheck, unit tests, smoke probes on every PR |
| `.github/workflows/sweep.yml` | weekly sweep, history commit, Pages deploy |

`public/` and `data/runs/` are build outputs and are not committed.

## Contributing

Unit tests are colocated (`*.test.ts`) and must pass without network access;
smoke tests (`*.smoke.test.ts`) are the ones allowed to install real packages.
Run `npm run typecheck && npm test` before opening a PR. CI runs the same
commands, plus the smoke job.

Licensed under the [MIT License](LICENSE). That covers the code and the
published test results alike: use the data, cite the pages, embed the badges.
