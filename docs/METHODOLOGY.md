# Methodology

This is the long version of what a green check on this site means, and — more
importantly — what it does not mean.

The project answers one narrow question per server: **on a clean machine, does
this thing install, start, and speak MCP today?** It does not judge whether a
server is useful, safe, actively maintained, or correct beyond the point where
it returns a tool list.

Everything below is implemented in this repository; the on-disk shapes it
refers to (`ProbeStatus`, `HistoryEntry`, `ShieldsBadge`, …) are defined in
`src/types.ts`.

## 1. Where the catalog comes from

Two sources, merged into one list of `ServerEntry` records:

1. **The official MCP registry** —
   `https://registry.modelcontextprotocol.io/v0/servers?version=latest`, read
   with cursor pagination (`metadata.nextCursor`), 100 items per page, a 15 s
   budget per page and a hard stop at 100 pages so a bad cursor cannot loop
   forever. Only the `version=latest` view is read: we probe the version a new
   user would get, not the whole version history.
2. **`data/seed.json`** — a small curated file of servers we always probe,
   including the official reference servers. Seed entries win on id collision,
   so a broken or unexpressive registry record can be corrected by hand.

Entries are deduplicated by `id`, given unique slugs (`io.github.owner/name` →
`io.github.owner__name`), and normalized from the registry's 2025-12-11 schema
(`packages[].registryType/identifier/version/runtimeHint/runtimeArguments/
packageArguments/environmentVariables`, `remotes[]`) into the shape the harness
consumes.

A registry fetch failure never produces a quietly truncated catalog: the
catalog stage fails loudly, and building from the seed alone requires asking
for it with `--offline`.

## 2. Ranking, top-N and sharding

`rank` is assigned by the catalog builder: seed entries first, in the order the
seed file gives them, then registry entries in registry order. **This is source
order, not a popularity ranking** — the registry does not yet expose a usage
signal we would trust.

The sweep selects entries in this order:

1. `--only <id-or-slug>` (repeatable) filters to specific servers.
2. `--top N` keeps the N lowest ranks. The weekly sweep uses `top=300`.
3. `--shard i/N` keeps entry `k` of the resulting list when `k % N == i`.

Sharding is therefore deterministic: while the ranking is stable, a server
stays on the same shard from week to week, and the shards of one sweep cover
the selection exactly once between them.

## 3. What a probe does

Each server gets exactly one probe, against the first distribution the harness
knows how to run:

| Order | Distribution | How it is probed |
| --- | --- | --- |
| 1 | npm package | `npm install --prefix <fresh temp dir>` with a private cache, locate the package `bin`, spawn it over stdio |
| 2 | PyPI package | `uv tool run --from <pkg>[==<version>] <console-script>` into uv's own ephemeral environment |
| 3 | Remote endpoint | connect over streamable HTTP; legacy SSE if that is all the server declares |
| — | OCI image | `skipped` — not implemented in v1 |
| — | Nothing runnable | `skipped` |

Nothing is installed globally, no state is shared between probes, temp
directories are removed and child process trees are killed whether the probe
succeeded or not. Probes run in a worker pool (default concurrency 4), each one
fully isolated: a server that crashes, hangs, or writes garbage to stdout
produces a result row and nothing more.

### Phases and their time budgets

| Phase | Budget | Applies to | Status if it fails |
| --- | --- | --- | --- |
| `install` | 300 s | npm, PyPI | `install_failed` |
| `spawn` | 30 s | npm, PyPI | `spawn_failed` |
| `connect` | 20 s | remote | `connect_failed` |
| `handshake` (MCP `initialize`) | 30 s | all | `handshake_failed` |
| `listTools` (`tools/list`) | 15 s | all | `tools_failed` |

Exceeding a budget yields status `timeout`, with the phase that ran out of time
recorded in `phases`. A probe that clears every phase is `pass`, and its tool
count and first 50 tool names are recorded.

One deliberate exception: `uv tool run` starts instantly and *then* downloads
the package, so the download lands inside the handshake window. PyPI probes get
`install + handshake` (330 s) for the handshake phase rather than 30 s, so a
slow download is not misreported as a broken server.

stderr is captured continuously while the child runs. On failure the newest
4000 characters (`MAX_ERROR_EXCERPT`) are kept and published verbatim on the
server page — the actual error text is the most useful thing this project has
to offer.

If `uv` is not on the runner's PATH, PyPI servers are recorded `skipped`, never
failed. The sweep workflow installs uv with `continue-on-error`, so an outage
in that action degrades PyPI coverage for a week instead of taking the sweep
down.

## 4. Environment variables

The harness has no credentials and does not want any.

- Variables a server declares as **required** are set to the literal
  `DOES_IT_INSTALL_PLACEHOLDER` and listed in the result's `requiresEnv`, which
  the server page shows as a caveat.
- Variables declared **optional** are left unset.
- Variables declared **secret** are never forwarded from the runner's
  environment. The harness executes third-party code; handing it real tokens
  would be indefensible.

The consequence is honest but worth stating plainly: a server that validates an
API key during startup will fail here even though it works fine for someone
holding a real key. That is why `requiresEnv` exists and why those results are
caveated rather than presented as a plain verdict.

## 5. Remote endpoints and authentication

No authentication headers are ever sent, including headers the registry entry
declares. Results are classified as:

- **401 / 403** → `handshake_failed`, with the HTTP detail and the note that
  the endpoint is reachable but requires credentials the harness does not send.
  "Reachable but needs auth" is real signal about a server, and it is a
  different fact from "the host is gone".
- **Other HTTP errors, DNS failures, TLS failures, refused connections** →
  `connect_failed` with the underlying detail.
- **No answer inside 20 s** → `timeout`.

## 6. Platforms, runners, cadence

| | |
| --- | --- |
| Platforms | `linux` (ubuntu-latest), `darwin` (macos-latest), `win32` (windows-latest) |
| Runtime | Node 22, GitHub-hosted runners |
| PyPI runtime | `uv`, installed by `astral-sh/setup-uv` and treated as optional |
| Layout | 3 shards × 3 operating systems = 9 probe jobs, `fail-fast: false`, 120 min per job |
| Schedule | Mondays 03:00 UTC, plus manual dispatch with `top` and `shard_total` inputs |

Probe jobs are expected to come back with red rows; that is the data. Only a
failed catalog job stops the sweep from publishing.

## 7. History

Every sweep writes `data/runs/<runId>-<platform>.json` per shard, which the
merge stage folds into `data/history/<slug>.json`, keyed by platform, newest
first, capped at `HISTORY_LIMIT` (30) entries per platform — roughly 30 weeks
of green/red strip at the current cadence.

Merging is idempotent: re-merging the same `runId` never duplicates an entry.
History files for servers that have left the catalog are kept, because a server
that disappeared from the registry after it broke is exactly the kind of rot
this project exists to record.

## 8. Badge semantics

Badges are [shields.io endpoint](https://shields.io/badges/endpoint-badge)
files, label `does it install`, `cacheSeconds: 3600`. Each server gets an
overall badge (`badge/<slug>.json`) and one per platform with data
(`badge/<slug>-<platform>.json`), all derived from the *latest* history entry
for that platform.

| Status | Message | Color |
| --- | --- | --- |
| `pass` | `passing` | brightgreen |
| `install_failed` | `install fails` | red |
| `spawn_failed` | `won't start` | red |
| `connect_failed` | `unreachable` | red |
| `handshake_failed` | `handshake fails` | red |
| `tools_failed` | `tools/list fails` | red |
| `timeout` | `times out` | red |
| `skipped`, or never probed | `untested` | lightgrey |
| passing somewhere, failing elsewhere | `failing on n/m platforms` | orange |

The message names the phase that broke on purpose: "failing" alone tells a
maintainer nothing, while `install fails` and `handshake fails` are different
bugs with different owners.

The overall badge is worst-wins over the latest per-platform statuses, ordered
by how early the probe died (`install_failed` worst, then `spawn_failed`,
`connect_failed`, `timeout`, `handshake_failed`, `tools_failed`, `skipped`,
`pass`). `skipped` deliberately outranks `pass`: a platform we could not test
is not evidence of health. The mixed case gets its own orange badge rather than
a red one, so a server that works everywhere except Windows is not painted as
entirely broken.

## 9. Known limitations

- **No OCI/Docker probes.** Servers distributed only as container images are
  `skipped` in v1.
- **The PyPI console script is guessed** as the last segment of the package
  identifier. A package whose entry point is named differently will show
  `spawn_failed` or `handshake_failed` even though the right command works.
  These are worth reporting — a seed entry can override them.
- **Placeholder credentials cause false negatives** for servers that validate
  keys at startup (see section 4). Check `requiresEnv` on the server page
  before believing a red badge.
- **Weekly granularity.** A result can be up to seven days old; the "last
  checked" timestamp on each page is authoritative, not the badge color.
- **One version per server** — whatever `version=latest` resolves to, or the
  version pinned in the catalog entry. Older releases are not probed.
- **Ranking is source order, not popularity**, so `--top 300` means "the first
  300 the sources listed", not "the 300 most used".
- **One network vantage point.** Remote endpoints are reached from
  GitHub-hosted runners; a server that geo-blocks or rate-limits CI address
  ranges will look worse here than it is for a normal user.
- **Coverage is bounded.** The published index is the top slice of the registry
  plus the seed, not every MCP server in existence.
