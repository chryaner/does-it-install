/**
 * npm probe: install the package into a throwaway prefix with a private cache,
 * find its `bin` script, and run it over stdio. Nothing is installed globally
 * and the prefix is removed whatever happens.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PackageSpec } from '../types.js';
import { runCommand, type CommandResult } from './command.js';
import type { ProbeContext } from './options.js';
import { buildExcerpt, phaseSince, skippedOutcome, type ProbeOutcome } from './outcome.js';
import { probeStdio } from './stdio.js';
import { describeError } from './util.js';

/** `npm` is a shell script on POSIX and a batch file on Windows. */
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** `name` or `@scope/name`. Anything else we refuse to hand to npm. */
const NPM_IDENTIFIER = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
/** Version ranges are passed on the command line; keep them boring. */
const NPM_VERSION = /^[\w.\-+~^><=*|\s]+$/;

export async function probeNpm(pkg: PackageSpec, ctx: ProbeContext): Promise<ProbeOutcome> {
  if (!NPM_IDENTIFIER.test(pkg.identifier)) {
    return skippedOutcome('npm', `refusing to install malformed npm identifier: ${JSON.stringify(pkg.identifier)}`);
  }
  if (pkg.version !== undefined && !NPM_VERSION.test(pkg.version)) {
    return skippedOutcome('npm', `refusing to install malformed npm version: ${JSON.stringify(pkg.version)}`);
  }

  let prefix: string;
  try {
    await fs.mkdir(ctx.workDir, { recursive: true });
    prefix = await fs.mkdtemp(path.join(ctx.workDir, 'dii-npm-'));
  } catch (err) {
    const detail = `cannot create an install prefix under ${ctx.workDir}: ${describeError(err)}`;
    return {
      method: 'npm',
      status: 'install_failed',
      phases: { install: { ok: false, durationMs: 0, detail } },
      errorExcerpt: detail
    };
  }

  try {
    return await probeInPrefix(pkg, ctx, prefix);
  } finally {
    // Windows can hold locks on files a just-killed child had open.
    await fs.rm(prefix, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function probeInPrefix(pkg: PackageSpec, ctx: ProbeContext, prefix: string): Promise<ProbeOutcome> {
  const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
  const phases: ProbeOutcome['phases'] = {};

  const installAt = Date.now();
  const install = await runCommand(
    NPM_COMMAND,
    [
      'install',
      '--prefix',
      prefix,
      '--no-fund',
      '--no-audit',
      '--loglevel=error',
      '--cache',
      path.join(prefix, '.npm-cache'),
      spec
    ],
    { cwd: prefix, timeoutMs: ctx.timeouts.install }
  );

  if (install.spawnError || install.timedOut || install.code !== 0) {
    const detail = installFailureDetail(install, spec, ctx.timeouts.install);
    phases.install = phaseSince(installAt, false, detail);
    return {
      method: 'npm',
      status: install.timedOut ? 'timeout' : 'install_failed',
      phases,
      errorExcerpt: buildExcerpt(detail, install.stderr || install.stdout)
    };
  }
  phases.install = phaseSince(installAt, true);

  const spawnAt = Date.now();
  const resolved = await resolveBinScript(prefix, pkg.identifier);
  if ('error' in resolved) {
    phases.spawn = phaseSince(spawnAt, false, resolved.error);
    return { method: 'npm', status: 'spawn_failed', phases, errorExcerpt: resolved.error };
  }

  // Run the script with our own node rather than the installed shim: no
  // dependency on shebangs, symlinks or executable bits.
  const stdio = await probeStdio(
    process.execPath,
    [resolved.script, ...(pkg.packageArguments ?? [])],
    ctx.env,
    { spawn: ctx.timeouts.spawn, handshake: ctx.timeouts.handshake, listTools: ctx.timeouts.listTools },
    prefix
  );
  return { method: 'npm', ...stdio, phases: { ...phases, ...stdio.phases } };
}

/** Why an install did not produce a package, in one line. */
function installFailureDetail(result: CommandResult, spec: string, timeoutMs: number): string {
  if (result.spawnError) return `cannot run ${NPM_COMMAND}: ${describeError(result.spawnError)}`;
  if (result.timedOut) return `npm install ${spec} timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (result.code === null) return `npm install ${spec} was killed by ${result.signal ?? 'an unknown signal'}`;
  return `npm install ${spec} exited with code ${result.code}`;
}

/** Last path segment of a package name: `@scope/server-x` -> `server-x`. */
export function unscopedName(identifier: string): string {
  const segments = identifier.split('/');
  return segments[segments.length - 1] ?? identifier;
}

/**
 * Picks the executable a package declares. `bin` is either a path or a map of
 * command name to path; the entry named after the package wins, otherwise the
 * first one declared.
 */
export function selectBinEntry(identifier: string, bin: unknown): string | undefined {
  if (typeof bin === 'string') return bin;
  if (typeof bin !== 'object' || bin === null) return undefined;

  const entries = Object.entries(bin).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  const preferred = entries.find(([name]) => name === unscopedName(identifier));
  return (preferred ?? entries[0])?.[1];
}

type BinResolution = { script: string } | { error: string };

async function resolveBinScript(prefix: string, identifier: string): Promise<BinResolution> {
  const packageDir = path.join(prefix, 'node_modules', ...identifier.split('/'));
  const manifestPath = path.join(packageDir, 'package.json');

  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    return { error: `cannot read ${manifestPath} after install: ${describeError(err)}` };
  }
  if (typeof manifest !== 'object' || manifest === null) {
    return { error: `${manifestPath} is not a JSON object` };
  }

  const relative = selectBinEntry(identifier, (manifest as { bin?: unknown }).bin);
  if (relative === undefined) {
    return { error: `${identifier} declares no runnable "bin" entry, so there is nothing to spawn` };
  }

  const script = path.resolve(packageDir, relative);
  try {
    await fs.access(script);
  } catch {
    return { error: `${identifier} declares bin "${relative}" but ${script} does not exist` };
  }
  return { script };
}

