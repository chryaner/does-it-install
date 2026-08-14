/**
 * probeServer: pick one distribution per catalogued server and probe it.
 *
 * Order is npm, then pypi, then remote (streamable HTTP before legacy SSE) —
 * the first one we know how to run wins. Everything else is `skipped`. This
 * function never throws: a probe that blows up is still a data point.
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
  | { kind: 'remote'; remote: RemoteSpec }
  | { kind: 'oci' }
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
  if (allowed.has('remote')) {
    // Streamable HTTP is the current transport; SSE is the legacy fallback.
    const remote = remotes.find(candidate => candidate.type === 'streamable-http') ?? remotes[0];
    if (remote) return { kind: 'remote', remote };
  }

  const probable = packages.some(pkg => pkg.kind === 'npm' || pkg.kind === 'pypi') || remotes.length > 0;
  if (!probable && packages.some(pkg => pkg.kind === 'oci')) return { kind: 'oci' };
  return { kind: 'none' };
}

/**
 * Builds the environment a server is spawned with.
 *
 * Required variables we cannot know get `ENV_PLACEHOLDER` and are reported in
 * `requiresEnv`, so pages can caveat the result. Values declared `secret` are
 * never forwarded from the runner's environment — the harness runs third-party
 * code and has no business handing it real credentials. Optional variables are
 * left unset.
 */
export function resolveEnv(
  specs: readonly EnvVarSpec[],
  source: NodeJS.ProcessEnv = process.env
): { env: Record<string, string>; requiresEnv: string[] } {
  const env: Record<string, string> = {};
  const requiresEnv: string[] = [];

  for (const spec of specs) {
    if (!spec?.name) continue;
    const known = spec.secret ? undefined : source[spec.name];
    if (known !== undefined && known !== '') {
      env[spec.name] = known;
      continue;
    }
    if (!spec.required) continue;
    env[spec.name] = ENV_PLACEHOLDER;
    if (!requiresEnv.includes(spec.name)) requiresEnv.push(spec.name);
  }
  return { env, requiresEnv };
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
      case 'pypi': {
        const resolved = resolveEnv(distribution.pkg.env ?? []);
        requiresEnv = resolved.requiresEnv;
        const ctx: ProbeContext = { workDir: opts.workDir, timeouts: opts.timeouts, env: resolved.env };
        outcome =
          distribution.kind === 'npm' ? await probeNpm(distribution.pkg, ctx) : await probePypi(distribution.pkg, ctx);
        break;
      }
      case 'remote': {
        // We send none of the declared headers, so every one of them is a
        // caveat on the result.
        requiresEnv = (distribution.remote.headers ?? []).map(header => header.name).filter(Boolean);
        outcome = await probeRemote(distribution.remote, opts.timeouts);
        break;
      }
      case 'oci':
        outcome = skippedOutcome('oci', 'container (oci) distributions are not probed in v1');
        break;
      default:
        outcome = skippedOutcome('none', 'no npm, pypi or remote distribution to probe');
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
