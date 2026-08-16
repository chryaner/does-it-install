/**
 * oci probe: `docker pull` the image, then run it as a throwaway container and
 * speak MCP over the container's stdio.
 *
 * A container needs a daemon that can run Linux images, which in practice means
 * the Linux runner: the macOS runner has no daemon and the Windows one runs
 * Windows containers. There the probe records `skipped` rather than a failure,
 * the same way a missing `uv` skips PyPI.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PackageSpec } from '../types.js';
import { runCommand, type CommandResult } from './command.js';
import type { ProbeContext } from './options.js';
import { buildExcerpt, phaseSince, skippedOutcome, type ProbeOutcome } from './outcome.js';
import { probeStdio, type StdioOutcome, type StdioTimeouts } from './stdio.js';
import { describeError } from './util.js';

const DOCKER_COMMAND = 'docker';

/** `docker version` talks to the daemon, so a wedged daemon must not hang us. */
const DOCKER_VERSION_TIMEOUT_MS = 5_000;
/** Removing a container is a local call: it answers quickly or it is stuck. */
const TEARDOWN_TIMEOUT_MS = 15_000;

/** A pathological image must not exhaust the runner; blast radius stays one probe. */
const MEMORY_LIMIT = '2g';
const PIDS_LIMIT = '512';

/** Reported when the runner has no docker that can run our images. */
const DOCKER_MISSING = 'docker not available on this runner';

/**
 * A registry host is told apart from a first path segment by carrying a dot
 * (docker's own rule), plus an optional port.
 */
const OCI_HOST = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?::\d{1,5})?`;
/** Path segments are lowercase and must start with a letter or digit, so no
 * part of a reference can ever read as a docker flag. */
const OCI_PATH = String.raw`[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*`;
const OCI_TAG = String.raw`[A-Za-z0-9._-]+`;
const OCI_DIGEST = String.raw`sha256:[a-f0-9]{64}`;

/** `[host[:port]/]path[:tag][@sha256:digest]`. Anything else we refuse. */
const OCI_IMAGE = new RegExp(`^(?:${OCI_HOST}/)?${OCI_PATH}(?::${OCI_TAG})?(?:@${OCI_DIGEST})?$`);

/**
 * Variables the docker client needs to find its daemon.
 *
 * `StdioClientTransport` merges a sudo-style safe default environment (PATH,
 * HOME, ...) and nothing else, so a runner pointing at a rootless or remote
 * daemon through `DOCKER_HOST` would fail to run the image it just pulled.
 * These name the harness's own daemon, they are chosen here rather than by a
 * catalog entry, and they reach the docker client only: the container's
 * environment is exactly the `-e` flags built below.
 */
const DOCKER_CLIENT_ENV = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY'
];

let dockerChecked: boolean | undefined;

/**
 * Whether this runner can really run the images we probe: the CLI has to
 * exist, a daemon has to answer (which is what `docker version`, unlike
 * `docker --version`, requires), and that daemon has to be running Linux
 * containers.
 *
 * The last condition is not pedantry. The Windows runner ships a working
 * Docker in Windows-container mode, where every Linux MCP image fails its pull
 * with "no matching manifest"; calling that an `install_failed` would paint a
 * healthy server red on a platform we simply cannot test it on. Checked once
 * per process, since none of it changes.
 */
export function isDockerAvailable(): boolean {
  if (dockerChecked === undefined) {
    const result = spawnSync(DOCKER_COMMAND, ['version', '--format', '{{.Server.Os}}'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: DOCKER_VERSION_TIMEOUT_MS
    });
    dockerChecked = result.error === undefined && result.status === 0 && result.stdout.trim() === 'linux';
  }
  return dockerChecked;
}

/** Container name for one probe: unique, and greppable in `docker ps`. */
export function containerName(): string {
  return `dii-${randomUUID()}`;
}

/**
 * The `docker run` command line for one probe.
 *
 * `-i` keeps stdin open for the MCP transport, `--rm` clears up after a
 * container that exits on its own, `--pull=never` keeps this phase off the
 * network (the image is already local; a pull here would land inside the
 * handshake budget), and `--name` is what lets the teardown find a container
 * that did not exit on its own.
 */
export function buildRunArgs(
  image: string,
  name: string,
  env: Record<string, string>,
  packageArguments: readonly string[] = []
): string[] {
  const envFlags = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return [
    'run',
    '-i',
    '--rm',
    '--pull=never',
    // A pathological image must not exhaust the runner: blast radius stays one probe.
    '--memory',
    MEMORY_LIMIT,
    '--pids-limit',
    PIDS_LIMIT,
    '--name',
    name,
    ...envFlags,
    image,
    ...packageArguments
  ];
}

/** The docker calls a probe makes, as one seam the tests can replace. */
export interface OciRuntime {
  dockerAvailable(): boolean;
  run(args: string[], timeoutMs: number): Promise<CommandResult>;
  session(args: string[], env: Record<string, string>, timeouts: StdioTimeouts): Promise<StdioOutcome>;
}

export const DOCKER_RUNTIME: OciRuntime = {
  dockerAvailable: isDockerAvailable,
  run: (args, timeoutMs) => runCommand(DOCKER_COMMAND, args, { timeoutMs }),
  session: (args, env, timeouts) => probeStdio(DOCKER_COMMAND, args, env, timeouts)
};

/**
 * Pull the image, run it, speak MCP to it, and take the container away again.
 *
 * `pkg.version` is deliberately ignored: an image reference already carries its
 * own tag or digest, registry entries put it in the identifier, and appending a
 * server version as a tag would invent a reference that need not exist, turning
 * a working server red.
 */
export async function probeOci(
  pkg: PackageSpec,
  ctx: ProbeContext,
  runtime: OciRuntime = DOCKER_RUNTIME
): Promise<ProbeOutcome> {
  const image = pkg.identifier;
  if (!OCI_IMAGE.test(image)) {
    return skippedOutcome('oci', `refusing to run malformed oci image reference: ${JSON.stringify(image)}`);
  }
  if (!runtime.dockerAvailable()) {
    return {
      method: 'oci',
      status: 'skipped',
      phases: { install: { ok: false, durationMs: 0, detail: DOCKER_MISSING } },
      errorExcerpt: `${DOCKER_MISSING}, so container distributions are probed on Linux only`
    };
  }

  const phases: ProbeOutcome['phases'] = {};
  const pullAt = Date.now();
  const pull = await runtime.run(['pull', image], ctx.timeouts.install);
  if (pull.spawnError || pull.timedOut || pull.code !== 0) {
    const detail = pullFailureDetail(pull, image, ctx.timeouts.install);
    phases.install = phaseSince(pullAt, false, detail);
    return {
      method: 'oci',
      status: pull.timedOut ? 'timeout' : 'install_failed',
      phases,
      errorExcerpt: buildExcerpt(detail, pull.stderr || pull.stdout)
    };
  }
  phases.install = phaseSince(pullAt, true);

  const name = containerName();
  let stdio: StdioOutcome;
  try {
    stdio = await runtime.session(buildRunArgs(image, name, ctx.env, pkg.packageArguments), dockerClientEnv(), {
      spawn: ctx.timeouts.spawn,
      handshake: ctx.timeouts.handshake,
      listTools: ctx.timeouts.listTools
    });
  } finally {
    // Killing the docker client does not stop the container it started, and
    // `--rm` only covers containers that exit by themselves, so a hung or
    // timed-out server would otherwise outlive its probe.
    await removeContainer(runtime, name);
  }
  return { method: 'oci', ...stdio, phases: { ...phases, ...stdio.phases } };
}

/** Why a pull produced no image, in one line. */
function pullFailureDetail(result: CommandResult, image: string, timeoutMs: number): string {
  if (result.spawnError) return `cannot run ${DOCKER_COMMAND}: ${describeError(result.spawnError)}`;
  if (result.timedOut) return `docker pull ${image} timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (result.code === null) return `docker pull ${image} was killed by ${result.signal ?? 'an unknown signal'}`;
  return `docker pull ${image} exited with code ${result.code}`;
}

/**
 * Best effort: a teardown that fails must never change the verdict. It is
 * retried, though: under CPU contention a starved daemon can outlast one
 * removal attempt, and a swallowed timeout would leak a running container.
 * Observed in practice when the smoke suites run concurrently.
 */
async function removeContainer(runtime: OciRuntime, name: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await runtime.run(['rm', '-f', name], TEARDOWN_TIMEOUT_MS);
      // Exit 0 removed it; a nonzero exit mentioning "No such container"
      // means it already exited and auto-removed, which is just as good.
      if (!result.timedOut && (result.code === 0 || /no such container/i.test(result.stderr))) return;
    } catch {
      // Fall through to the retry.
    }
  }
}

function dockerClientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of DOCKER_CLIENT_ENV) {
    const value = process.env[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return env;
}
