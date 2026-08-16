/**
 * pypi probe: `uv tool run` (a.k.a. uvx) resolves, downloads and runs the
 * package's console script in one shot, into its own ephemeral environment.
 * If the runner has no `uv`, the server is skipped, never failed.
 */
import { spawnSync } from 'node:child_process';
import type { PackageSpec } from '../types.js';
import type { ProbeContext } from './options.js';
import { skippedOutcome, type ProbeOutcome } from './outcome.js';
import { probeStdio, type StdioOutcome, type StdioTimeouts } from './stdio.js';

/**
 * PEP 503-ish distribution names. PyPI has no namespaces, and `/` would let an
 * identifier read as a local path to `uv tool run --from`, so it is refused.
 */
const PYPI_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Versions are pinned with `==`, so keep them to version characters. */
const PYPI_VERSION = /^[\w.\-+!*]+$/;

/**
 * A console script name we are willing to hand back to `uv`. Same shape as an
 * identifier on purpose: the characters are safe, and the leading alphanumeric
 * is what keeps a name uv happens to print from reading as a uv flag.
 */
const UV_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The line uv prints just before it lists the scripts a package does provide. */
const UV_EXECUTABLE_LIST = 'The following executables are available:';

/** The stdio seam, so tests can drive the retry without running uv. */
export type StdioProbe = (
  command: string,
  args: string[],
  env: Record<string, string>,
  timeouts: StdioTimeouts
) => Promise<StdioOutcome>;

let uvChecked: boolean | undefined;

/** Whether `uv` is on PATH. Checked once per process, since it never changes. */
export function isUvAvailable(): boolean {
  if (uvChecked === undefined) {
    const result = spawnSync('uv', ['--version'], { stdio: 'ignore', windowsHide: true });
    uvChecked = result.error === undefined && result.status === 0;
  }
  return uvChecked;
}

/** The command line for one `uv tool run`, optionally with a corrected script. */
export function buildUvArgs(pkg: PackageSpec, executable: string = pkg.identifier): string[] {
  const from = pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier;
  // Best guess at the console script: the distribution name itself.
  return ['tool', 'run', '--from', from, executable, ...(pkg.packageArguments ?? [])];
}

/**
 * The console script uv suggests when our guess was wrong.
 *
 * uv answers a bad script name with, verbatim (`uv 0.8`, on stderr):
 *
 *   An executable named `python-dotenv` is not provided by package `python-dotenv`.
 *   The following executables are available:
 *   - dotenv
 *
 * The list header is what we anchor on rather than the first line: excerpts keep
 * the newest output, so a busy server's stderr can push the first line out while
 * the list survives. Everything after the header is untrusted text from a
 * third-party package, so only a name matching {@link UV_EXECUTABLE} is
 * accepted, and scanning stops at the first line that is not a list item.
 *
 * Returns undefined when there is no hint, when it was truncated before a usable
 * name, or when nothing listed is safe to pass back to uv.
 */
export function parseUvExecutableHint(stderr: string | undefined): string | undefined {
  if (!stderr) return undefined;
  const lines = stderr.split(/\r?\n/);
  const header = lines.findIndex(line => line.includes(UV_EXECUTABLE_LIST));
  if (header === -1) return undefined;

  for (const line of lines.slice(header + 1)) {
    const item = /^\s*-\s+(\S.*?)\s*$/.exec(line);
    if (!item) {
      // A blank line or ordinary prose ends the list; anything further down is
      // unrelated output that happens to start with a dash.
      if (line.trim() === '') continue;
      return undefined;
    }
    const name = item[1];
    if (name !== undefined && UV_EXECUTABLE.test(name)) return name;
  }
  return undefined;
}

export async function probePypi(
  pkg: PackageSpec,
  ctx: ProbeContext,
  uvAvailable: () => boolean = isUvAvailable,
  runStdio: StdioProbe = probeStdio
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

  const timeouts: StdioTimeouts = {
    spawn: ctx.timeouts.spawn,
    // uv starts immediately and then downloads the package before the server
    // speaks, so the download lands inside the handshake window: it gets the
    // install budget on top of its own.
    handshake: ctx.timeouts.install + ctx.timeouts.handshake,
    listTools: ctx.timeouts.listTools
  };

  const first = await runStdio('uv', buildUvArgs(pkg), ctx.env, timeouts);
  if (first.status !== 'spawn_failed' && first.status !== 'handshake_failed') {
    return { method: 'pypi', ...first };
  }

  // Plenty of distributions ship a console script under a different name than
  // the package itself, which our guess gets wrong and uv answers by naming the
  // real one. Worth one more run: the alternative is recording a healthy server
  // as broken. Only one, and only on a hint, so a server that is genuinely
  // broken still costs a single probe.
  const executable = parseUvExecutableHint(first.errorExcerpt);
  if (executable === undefined || executable === pkg.identifier) {
    return { method: 'pypi', ...first };
  }

  const retry = await runStdio('uv', buildUvArgs(pkg, executable), ctx.env, timeouts);
  return { method: 'pypi', ...preferRetry(first, retry) };
}

/**
 * The retry ran the package's real entry point, so its verdict is the one that
 * counts even when it failed too. The first attempt is only worth keeping for
 * an excerpt the retry did not produce one of.
 */
function preferRetry(first: StdioOutcome, retry: StdioOutcome): StdioOutcome {
  if (retry.status === 'pass' || retry.errorExcerpt) return retry;
  return { ...retry, ...(first.errorExcerpt !== undefined ? { errorExcerpt: first.errorExcerpt } : {}) };
}
