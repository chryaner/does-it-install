/**
 * probeServer: pick one distribution per catalogued server and probe it.
 *
 * Order is npm, then pypi, then oci, then remote (streamable HTTP before legacy
 * SSE). The first one we know how to run wins. Everything else is `skipped`.
 * This function never throws: a probe that blows up is still a data point.
 */
import {
  ENV_PLACEHOLDER,
  type EnvVarSpec,
  type PackageSpec,
  type ProbeResult,
  type RemoteSpec,
  type ServerEntry
} from '../types.js';
import { probeNpm } from './npm.js';
import { probeOci } from './oci.js';
import {
  ALL_METHODS,
  resolveProbeOptions,
  type MethodFilter,
  type ProbeContext,
  type ProbeOptions
} from './options.js';
import { skippedOutcome, type ProbeOutcome } from './outcome.js';
import { probePypi } from './pypi.js';
import { probeRemote } from './remote.js';
import { describeError } from './util.js';

/** The distribution `probeServer` decided to run. */
export type Distribution =
  | { kind: 'npm'; pkg: PackageSpec }
  | { kind: 'pypi'; pkg: PackageSpec }
  | { kind: 'oci'; pkg: PackageSpec }
  | { kind: 'remote'; remote: RemoteSpec }
  | { kind: 'none' };

export function selectDistribution(
  entry: ServerEntry,
  methods: readonly MethodFilter[] = ALL_METHODS
): Distribution {
  const packages = entry.packages ?? [];
  const remotes = entry.remotes ?? [];
  const allowed = new Set(methods);

  if (allowed.has('npm')) {
    const pkg = packages.find(candidate => candidate.kind === 'npm');
    if (pkg) return { kind: 'npm', pkg };
  }
  if (allowed.has('pypi')) {
    const pkg = packages.find(candidate => candidate.kind === 'pypi');
    if (pkg) return { kind: 'pypi', pkg };
  }
  if (allowed.has('oci')) {
    // After the package managers, before the remote: a container is a copy of
    // the server we can run ourselves, and a hosted endpoint is somebody
    // else's deployment of it.
    const pkg = packages.find(candidate => candidate.kind === 'oci');
    if (pkg) return { kind: 'oci', pkg };
  }
  if (allowed.has('remote')) {
    // Streamable HTTP is the current transport; SSE is the legacy fallback.
    const remote = remotes.find(candidate => candidate.type === 'streamable-http') ?? remotes[0];
    if (remote) return { kind: 'remote', remote };
  }

  return { kind: 'none' };
}

/**
 * Builds the environment a server is spawned with.
 *
 * This never reads the runner's environment. A registry entry chooses the
 * variable names, so anything we forwarded by name would be an exfiltration
 * primitive: an entry could declare `GITHUB_TOKEN` and have the harness hand
 * that value to third-party code that can phone home. Required variables,
 * secret or not, get `ENV_PLACEHOLDER` and are reported in `requiresEnv` so
 * pages can caveat the result; optional variables are left unset. The SDK's
 * stdio transport merges its own safe defaults (PATH, HOME, ...) underneath,
 * so servers still start.
 */
export function resolveEnv(specs: readonly EnvVarSpec[]): { env: Record<string, string>; requiresEnv: string[] } {
  const env: Record<string, string> = {};
  const requiresEnv: string[] = [];

  for (const spec of specs) {
    if (!spec?.name) continue;
    if (!spec.required) continue;
    env[spec.name] = ENV_PLACEHOLDER;
    if (!requiresEnv.includes(spec.name)) requiresEnv.push(spec.name);
  }
  return { env, requiresEnv };
}

/**
 * types.ts policy: a stdio server we started with `ENV_PLACEHOLDER` in place of
 * credentials it declared as required is gated, not broken, when it refuses to
 * start or to finish the handshake. Its stderr usually says so outright ("invalid
 * API key"), which is exactly the evidence we keep: phases, detail and excerpt
 * are left as captured and only the status changes.
 *
 * Deliberately narrow. `install_failed` happened before any placeholder was
 * used, `tools_failed` means the handshake already succeeded with them, and
 * `timeout` is a hang we have no reason to blame on credentials.
 */
export function reclassifyGatedByCredentials(
  outcome: ProbeOutcome,
  requiresEnv: readonly string[]
): ProbeOutcome {
  if (requiresEnv.length === 0) return outcome;
  if (outcome.status !== 'spawn_failed' && outcome.status !== 'handshake_failed') return outcome;
  return { ...outcome, status: 'needs_auth' };
}

export async function probeServer(entry: ServerEntry, options: ProbeOptions = {}): Promise<ProbeResult> {
  const opts = resolveProbeOptions(options);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  let distribution: Distribution = { kind: 'none' };
  let outcome: ProbeOutcome;
  let requiresEnv: string[] = [];

  try {
    distribution = selectDistribution(entry, opts.methods);
    switch (distribution.kind) {
      case 'npm':
      case 'pypi':
      case 'oci': {
        // A container is handed its declared credentials the same way a local
        // install is (as `-e` placeholders), so the same gating rule applies.
        const resolved = resolveEnv(distribution.pkg.env ?? []);
        requiresEnv = resolved.requiresEnv;
        const ctx: ProbeContext = { workDir: opts.workDir, timeouts: opts.timeouts, env: resolved.env };
        outcome = reclassifyGatedByCredentials(await probePackage(distribution, ctx), requiresEnv);
        break;
      }
      case 'remote': {
        // We send none of the declared headers, so every one of them is a
        // caveat on the result.
        requiresEnv = (distribution.remote.headers ?? []).map(header => header.name).filter(Boolean);
        outcome = await probeRemote(distribution.remote, opts.timeouts);
        break;
      }
      default:
        outcome = skippedOutcome('none', 'no npm, pypi, oci or remote distribution to probe');
    }
  } catch (err) {
    outcome = harnessFailure(distribution, err);
  }

  return {
    serverId: entry.id,
    slug: entry.slug,
    platform: opts.platform,
    method: outcome.method,
    status: outcome.status,
    phases: outcome.phases,
    toolCount: outcome.toolCount,
    toolNames: outcome.toolNames,
    serverInfo: outcome.serverInfo,
    errorExcerpt: outcome.errorExcerpt,
    requiresEnv: requiresEnv.length > 0 ? requiresEnv : undefined,
    startedAt,
    durationMs: Date.now() - startedAtMs
  };
}

/** Runs the probe that matches a package distribution. */
function probePackage(
  distribution: Extract<Distribution, { pkg: PackageSpec }>,
  ctx: ProbeContext
): Promise<ProbeOutcome> {
  switch (distribution.kind) {
    case 'npm':
      return probeNpm(distribution.pkg, ctx);
    case 'pypi':
      return probePypi(distribution.pkg, ctx);
    default:
      return probeOci(distribution.pkg, ctx);
  }
}

/**
 * A probe implementation threw, which is a bug in the harness rather than a
 * verdict on the server. Record it at the earliest phase of the chosen method
 * so it reads as "we never got anywhere", with the exception in the excerpt.
 */
function harnessFailure(distribution: Distribution, err: unknown): ProbeOutcome {
  const errorExcerpt = `harness error: ${describeError(err)}`;
  switch (distribution.kind) {
    case 'npm':
    case 'pypi':
    case 'oci':
      return { method: distribution.kind, status: 'install_failed', phases: {}, errorExcerpt };
    case 'remote':
      return {
        method: distribution.remote.type === 'sse' ? 'remote-sse' : 'remote-http',
        status: 'connect_failed',
        phases: {},
        errorExcerpt
      };
    default:
      return { method: 'none', status: 'skipped', phases: {}, errorExcerpt };
  }
}
