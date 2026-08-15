# Methodology

This is the long version of what a green check on this site means, and, more
importantly, what it does not mean.

The project answers one narrow question per server: **on a clean machine, does
this thing install, start, and speak MCP today?** It does not judge whether a
server is useful, safe, actively maintained, or correct beyond the point where
it returns a tool list.

Everything below is implemented in this repository; the on-disk shapes it
refers to (`ProbeStatus`, `HistoryEntry`, `ShieldsBadge`, …) are defined in
`src/types.ts`.

## 1. Where the catalog comes from

Two sources, merged into one list of `ServerEntry` records:

1. **The official MCP registry**:
   `https://registry.modelcontextprotocol.io/v0/servers?version=latest`, read
   with cursor pagination (`metadata.nextCursor`), 100 items per page, a 15 s
   budget per page and a hard stop at 400 pages so a bad cursor cannot loop
   forever. Every page is read on every build, because a ranking cannot pick
   the most popular servers out of a prefix of the list. Only the
   `version=latest` view is read: we probe the version a new user would get,
   not the whole version history.
2. **`data/seed.json`**: a small curated file of servers we always probe,
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

The weekly sweep does not publish the whole registry. It passes `--limit 1000`,
which keeps the 1000 highest ranked entries of the merged list: headroom over
the 300 servers it probes, and small enough that `data/catalog.json` is a sane
thing to commit every week and to render as one page per server. The cut
happens after ranking, never during pagination, so `--limit` decides how much
is published and not how much is read. Running `npm run catalog` without
`--limit` keeps all 20,000+ entries, which is fine locally and is not what CI
wants.

## 2. Ranking, top-N and sharding

`rank` is assigned by the catalog builder, in three tiers:

1. **Seed entries first**, in the order the seed file gives them. Curation
   beats popularity here: the reference servers are the ones we most want
   probed every week, whatever the rest of the world has starred.
2. **Registry entries by GitHub stars**, most stars first. The count is fetched
   at catalog build time from GitHub's GraphQL API, 100 repositories per query,
   for the `repoUrl` each registry record carries.
3. **Entries with no star count last**, in registry order. Ties in tier 2 keep
   registry order as well, so ranks stay stable from one week to the next
   (sharding depends on that; see below).

`rank` decides what gets probed, in what order, and on which shard. It does not
decide what the site shows first. The index page is sorted by stars alone, most
first, with entries that have no count last and ties broken by `rank` so the
page is stable between builds. The seed entries get whatever position their
stars earn them: curation is a good reason to probe our own picks every week,
and not a reason to pin them above servers with a hundred times the stars on a
page that presents itself as a neutral index.

The counts are published rather than hidden: the index has a `Stars` column and
each server page repeats the number next to the version, so an ordering that
looks wrong can be checked against the source.

Fetching stars needs a GitHub token in `GITHUB_TOKEN` (the sweep workflow
passes the Actions token). Without one, and for a lookup that fails, the
catalog still builds: the affected entries simply have no count and the
ranking degrades toward registry order.

What this ranking is not:

- **A star is a vote for a repository, not for a server.** A monorepo holding
  forty servers gives all forty the same count, and a server that ships inside
  a popular project inherits attention its own code never earned.
- **Unstarred and repo-less servers rank last**, whatever they are worth. No
  repository url, a repository hosted somewhere other than GitHub, and a
  repository that has been renamed or deleted all land in the same bucket as a
  genuinely ignored project.

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
| 3 | OCI image | `docker pull <image>`, then `docker run -i --rm --pull=never` over stdio, with the container removed afterwards |
| 4 | Remote endpoint | connect over streamable HTTP; legacy SSE if that is all the server declares |
| n/a | Nothing runnable | `skipped` |

A container sits ahead of a hosted endpoint on purpose: it is a copy of the
server we run ourselves, while a remote is somebody else's deployment of it.

Nothing is installed globally, no state is shared between probes, temp
directories are removed and child process trees are killed whether the probe
succeeded or not. Probes run in a worker pool (default concurrency 4), each one
fully isolated: a server that crashes, hangs, or writes garbage to stdout
produces a result row and nothing more.

### Phases and their time budgets

| Phase | Budget | Applies to | Status if it fails |
| --- | --- | --- | --- |
| `install` | 600 s | npm, PyPI, OCI | `install_failed` |
| `spawn` | 30 s | npm, PyPI, OCI | `spawn_failed` |
| `connect` | 20 s | remote | `connect_failed` |
| `handshake` (MCP `initialize`) | 30 s | all | `handshake_failed` |
| `listTools` (`tools/list`) | 15 s | all | `tools_failed` |

Exceeding a budget yields status `timeout`, with the phase that ran out of time
recorded in `phases`. A probe that clears every phase is `pass`, and its tool
count and first 50 tool names are recorded.

`spawn_failed` and `handshake_failed` are the two statuses that can be
reclassified afterwards, to `needs_auth`, when the server declared credentials
we withheld. Sections 4 and 5 give the exact rule.

One deliberate exception: `uv tool run` starts instantly and *then* downloads
the package, so the download lands inside the handshake window. PyPI probes get
`install + handshake` (330 s) for the handshake phase rather than 30 s, so a
slow download is not misreported as a broken server.

stderr is captured continuously while the child runs. On failure the newest
4000 characters (`MAX_ERROR_EXCERPT`) are kept and published verbatim on the
server page: the actual error text is the most useful thing this project has
to offer.

If `uv` is not on the runner's PATH, PyPI servers are recorded `skipped`, never
failed. The sweep workflow installs uv with `continue-on-error`, so an outage
in that action degrades PyPI coverage for a week instead of taking the sweep
down.

### Containers are a Linux-only probe

Container images are probed where the runner can actually run them, which in
practice means the Linux runner. The harness asks `docker version` once per
process and requires three things of the answer: the CLI exists, a daemon
replies, and that daemon is running **Linux** containers. The macOS runner has
no daemon at all, and the Windows runner has one in Windows-container mode,
where every Linux MCP image fails its pull with "no matching manifest"; calling
that an install failure would paint a healthy server red over a platform we
cannot test it on. Both record `skipped` with "docker not available on this
runner" instead. That is not a verdict on the server, so it never counts against
it: the overall badge judges only the platforms that produced a result
(section 8).

The image reference is used exactly as the catalog gives it, tag or digest
included; a package `version` is not appended, because an image reference
already carries its own and inventing one would fail a pull for a server that
works. Required environment variables are passed as `-e NAME=value` placeholder
pairs, so the container is gated by credentials exactly as a local install is.
The container is named `dii-<uuid>` and force-removed after the probe: killing
the docker client does not stop the container it started, and `--rm` alone only
covers a container that exits by itself.

### Install timeouts get a second, uncontended chance

Four probes run at once on four-core runners, so a package that compiles native
code during `npm install` competes for CPU with three neighbours and can exceed
the 600 s budget while fitting inside it comfortably on its own. Contention is
the one failure the harness itself causes, so it is the one failure the harness
retries.

When the worker pool has finished, every result that is `timeout` *and* has a
failed `install` phase is probed again, once each, strictly serially, with
nothing else running on the machine. The retry gets **twice the install budget**
(1200 s); every other phase budget is unchanged. It exists to answer one
question, "was it just slow?", it runs alone so the extra time is bounded to a
handful of entries, and a package that cannot install in twenty uncontended
minutes is broken in practice.

The retry result replaces the original whatever it says, a second timeout
included: the uncontended measurement is the truer one. Retries respect the
sweep deadline (`--deadline`), so entries it does not reach keep their original
result. **`timed out` on this site therefore means the server exceeded its
budget with the runner to itself**, not that it lost a race against its
neighbours.

### Slow installs that still pass

Every history entry records the install phase duration as `installMs`, whether
the install succeeded or failed. A server that passes after spending more than
a minute installing says so under its result on the server page ("Install took
9m 12s on this platform."); below that threshold the page shows nothing,
because the number is noise. A pass is still a pass, but ten minutes of `npm
install` is part of what using the server is like, and a green pill on its own
hides it. `index.json` carries the raw `installMs` for every platform that has
one, so a consumer can pick its own threshold.

## 4. Environment variables

The harness has no credentials and does not want any.

- Variables a server declares as **required** are set to the literal
  `DOES_IT_INSTALL_PLACEHOLDER` and listed in the result's `requiresEnv`, which
  the server page shows as a caveat.
- Variables declared **optional** are left unset.
- Variables declared **secret** are never forwarded from the runner's
  environment. The harness executes third-party code; handing it real tokens
  would be indefensible.

The consequence is worth stating plainly: a server that validates an API key
during startup will not come up here even though it works fine for someone
holding a real key. That is not a bug in the server, so it does not get a red
result:

- A stdio server that we started with placeholders in place of its declared
  required variables, and that then records `spawn_failed` or
  `handshake_failed`, is recorded **`needs_auth`** instead. Its phases, detail
  and stderr excerpt are kept exactly as captured; only the status changes.
  The excerpt is usually the evidence, since these servers tend to say "invalid
  API key" on the way out.
- The rule is deliberately narrow. `install_failed` happened before any
  placeholder was used, `tools_failed` means the handshake already succeeded
  with them, and `timeout` is a hang we have no reason to blame on credentials.
  None of the three is ever reclassified.
- A server that declares no required variables is never reclassified either:
  there is nothing it asked us for.

`needs_auth` is neither evidence of breakage nor evidence of health. The site
renders it amber, between green and red, and the badge reads
`needs credentials` in yellow.

## 5. Remote endpoints and authentication

No authentication headers are ever sent, including headers the registry entry
declares. Results are classified as:

- **401 / 403** → `needs_auth`, with the HTTP detail and the note that the
  endpoint is reachable but requires credentials the harness does not send.
  "Reachable but needs auth" is real signal about a server, and it is a
  different fact from both "the host is gone" and "the handshake is broken".
- **An endpoint that answered and then refused the `initialize`, while
  declaring headers it requires** → `needs_auth` as well. Some endpoints reject
  an unauthenticated handshake with a protocol error rather than an HTTP
  status; the declared required headers are what tell us which is which.
- **Other HTTP errors, DNS failures, TLS failures, refused connections** →
  `connect_failed` with the underlying detail.
- **No answer inside 20 s** → `timeout`. A failure that never reached the
  endpoint, or ran out of time, is never reclassified as `needs_auth`: it is
  not a verdict from the server.

## 5b. Going green (for maintainers)

The amber state resolves without anyone sharing a secret, and the fix is
ordinary good server design: validate credentials lazily. Start, complete the
`initialize` handshake, answer `tools/list`, and return a clear error from the
tool call itself when the key is missing or wrong. A server built that way
turns green here on its own, and real users get a visible tool list plus an
error in context instead of a silent connection failure. Hosted servers can do
the same over HTTP: allow anonymous `initialize` and `tools/list`, gate the
tool calls. If your tools genuinely cannot be listed without a tenant, the
standard OAuth challenge (a 401 with `WWW-Authenticate`) is correct, and amber
is your accurate steady state: alive, gated, working as designed.

We do not accept test credentials, from anyone. The harness executes
third-party code weekly, so holding real secrets would make every probe a
liability, and probing with no accounts anywhere is what keeps the results
comparable.

## 6. Platforms, runners, cadence

| | |
| --- | --- |
| Platforms | `linux` (ubuntu-latest), `darwin` (macos-latest), `win32` (windows-latest) |
| Runtime | Node 22, GitHub-hosted runners |
| PyPI runtime | `uv`, installed by `astral-sh/setup-uv` and treated as optional |
| OCI runtime | Docker in Linux-container mode, which only the Linux runner has; treated as optional everywhere |
| Layout | 3 shards × 3 operating systems = 9 probe jobs, `fail-fast: false`, 120 min per job |
| Schedule | Mondays 03:00 UTC, plus manual dispatch with `top` and `shard_total` inputs |

Probe jobs are expected to come back with red rows; that is the data. Only a
failed catalog job stops the sweep from publishing.

## 7. History

Every sweep writes `data/runs/<runId>-<platform>.json` per shard, which the
merge stage folds into `data/history/<slug>.json`, keyed by platform, newest
first, capped at `HISTORY_LIMIT` (30) entries per platform, which is roughly 30
weeks of green/red strip at the current cadence.

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
| `needs_auth` | `needs credentials` | yellow |
| `tools_failed` | `tools/list fails` | red |
| `timeout` | `times out` | red |
| `skipped`, or never probed | `untested` | lightgrey |
| passing somewhere, failing elsewhere | `failing on n/m platforms` | orange |

The message names the phase that broke on purpose: "failing" alone tells a
maintainer nothing, while `install fails` and `handshake fails` are different
bugs with different owners.

The overall badge judges only the platforms that produced a result. Platforms
whose latest status is `skipped` are dropped first, denominator included: a skip
means "we did not test here", never "it might be broken here", and containers
are probeable on Linux alone. So `pass` + `skipped` is `passing`, `needs_auth` +
`skipped` is `needs credentials`, and a failure plus a skip is that failure. When
every platform with data is `skipped`, or there is no data at all, there is
nothing to judge and the badge reads `untested`.

What is left is worst-wins over those statuses, ordered by how early the probe
died (`install_failed` worst, then `spawn_failed`, `connect_failed`, `timeout`,
`handshake_failed`, `tools_failed`, `needs_auth`, `pass`), except that a single
`pass` with no failure anywhere wins outright: it is proof the server works, and
`needs_auth` elsewhere is the expected result of probing a credentialed server
without credentials. The mixed case gets its own orange badge rather than a red
one, so a server that works everywhere except Windows is not painted as entirely
broken.

Two statuses are not failures and are counted as such nowhere: `skipped` and
`needs_auth`. A server that passes on one platform and asks for credentials on
another is `passing`, on its badge and on the index alike; only a real failure
somewhere turns it red. The site draws the same three-way split: green for a
pass, red for a real failure, amber for `needs_auth`, grey for what we never
learned.

## 9. Known limitations

- **Containers are tested on one platform.** An OCI image is probed on the
  Linux runner only, so a container-only server has one green square where an
  npm one has three, and nothing here says whether it runs under Docker Desktop
  on macOS or Windows.
- **The PyPI console script is guessed** as the last segment of the package
  identifier. A package whose entry point is named differently will show
  `spawn_failed` or `handshake_failed` even though the right command works.
  These are worth reporting, since a seed entry can override them.
- **Placeholder credentials still cost coverage.** A server that validates keys
  at startup is recorded `needs_auth` rather than red (see section 4), which is
  honest but is not a test: we never learn whether it would have worked with a
  real key. And the reclassification leans on what the entry declares, so a
  server that requires a key it never declared can still show red for a
  credentials problem. Check `requiresEnv` and the error excerpt on the server
  page before believing a red badge.
- **Weekly granularity.** A result can be up to seven days old; the "last
  checked" timestamp on each page is authoritative, not the badge color.
- **One version per server**: whatever `version=latest` resolves to, or the
  version pinned in the catalog entry. Older releases are not probed.
- **Ranking is repository stars, not server usage**, so `--top 300` means "the
  300 whose repositories are most starred", not "the 300 most used". Stars
  measure the repo a server lives in, and servers with no star count (no repo,
  not on GitHub, or no token when the catalog was built) rank last regardless
  of quality.
- **One network vantage point.** Remote endpoints are reached from
  GitHub-hosted runners; a server that geo-blocks or rate-limits CI address
  ranges will look worse here than it is for a normal user.
- **Coverage is bounded.** The weekly catalog is capped at 1000 entries (the
  seed, then the most starred of the registry), and only the top 300 of those
  are probed. That is not every MCP server in existence.
