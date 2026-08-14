/**
 * pypi probe: `uv tool run` (a.k.a. uvx) resolves, downloads and runs the
 * package's console script in one shot, into its own ephemeral environment.
 * If the runner has no `uv`, the server is skipped, never failed.
 */
import { spawnSync } from 'node:child_process';
import type { PackageSpec } from '../types.js';
import type { ProbeContext } from './options.js';
import { skippedOutcome, type ProbeOutcome } from './outcome.js';
import { probeStdio } from './stdio.js';

/**
 * PEP 503-ish distribution names. PyPI has no namespaces, and `/` would let an
 * identifier read as a local path to `uv tool run --from`, so it is refused.
 */
const PYPI_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Versions are pinned with `==`, so keep them to version characters. */
const PYPI_VERSION = /^[\w.\-+!*]+$/;

let uvChecked: boolean | undefined;

/** Whether `uv` is on PATH. Checked once per process, since it never changes. */
export function isUvAvailable(): boolean {
  if (uvChecked === undefined) {
    const result = spawnSync('uv', ['--version'], { stdio: 'ignore', windowsHide: true });
    uvChecked = result.error === undefined && result.status === 0;
  }
  return uvChecked;
}

export function buildUvArgs(pkg: PackageSpec): string[] {
  const from = pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier;
  // Best guess at the console script: the distribution name itself.
  return ['tool', 'run', '--from', from, pkg.identifier, ...(pkg.packageArguments ?? [])];
}

export async function probePypi(
  pkg: PackageSpec,
  ctx: ProbeContext,
  uvAvailable: () => boolean = isUvAvailable
): Promise<ProbeOutcome> {
  if (!PYPI_IDENTIFIER.test(pkg.identifier)) {
    return skippedOutcome('pypi', `refusing to install malformed pypi identifier: ${JSON.stringify(pkg.identifier)}`);
  }
  if (pkg.version !== undefined && !PYPI_VERSION.test(pkg.version)) {
    return skippedOutcome('pypi', `refusing to install malformed pypi version: ${JSON.stringify(pkg.version)}`);
  }
  if (!uvAvailable()) {
    return {
      method: 'pypi',
      status: 'skipped',
      phases: { install: { ok: false, durationMs: 0, detail: 'uv not available' } },
      errorExcerpt: 'uv not available on PATH, install uv to probe PyPI servers'
    };
  }

  const stdio = await probeStdio(
    'uv',
    buildUvArgs(pkg),
    ctx.env,
    {
      spawn: ctx.timeouts.spawn,
      // uv starts immediately and then downloads the package before the server
      // speaks, so the download lands inside the handshake window: it gets the
      // install budget on top of its own.
      handshake: ctx.timeouts.install + ctx.timeouts.handshake,
      listTools: ctx.timeouts.listTools
    }
  );
  return { method: 'pypi', ...stdio };
}
