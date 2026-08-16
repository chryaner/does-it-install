/**
 * Normalize one item of the MCP registry's `/v0/servers` response (server
 * schema 2025-12-11) into a {@link ServerEntry}.
 *
 * Registry data is public, unvalidated and versioned independently of us, so
 * normalization is total: anything unrecognized is dropped and an item we
 * cannot make sense of yields `null` rather than an exception.
 */

import type { EnvVarSpec, PackageSpec, RemoteSpec, ServerEntry } from '../types.js';
import { slugify } from '../types.js';
import { asArray, asBoolean, asString, isRecord, prop } from './json.js';

/** `_meta` key carrying the registry's own bookkeeping for an entry. */
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

const PACKAGE_KINDS: Record<string, PackageSpec['kind']> = {
  npm: 'npm',
  pypi: 'pypi',
  oci: 'oci',
};

const REMOTE_TYPES: Record<string, RemoteSpec['type']> = {
  'streamable-http': 'streamable-http',
  sse: 'sse',
};

/**
 * Convert a registry item into a catalog entry.
 *
 * Returns `null` when the item has no usable identity (no `server.name`) or is
 * so malformed that nothing can be read from it. Callers count those skips.
 *
 * `rank` is set to 0 here; the catalog builder assigns final ranks once seed
 * and registry entries have been merged.
 */
export function normalizeRegistryItem(item: unknown): ServerEntry | null {
  try {
    const server = prop(item, 'server');
    if (!isRecord(server)) return null;

    const id = asString(server['name']);
    if (!id) return null;

    const entry: ServerEntry = {
      id,
      slug: slugify(id) || 'server',
      title: asString(server['title']) ?? id,
      packages: normalizePackages(server['packages']),
      remotes: normalizeRemotes(server['remotes']),
      source: 'registry',
      rank: 0,
    };

    const description = asString(server['description']);
    if (description) entry.description = description;

    const version = asString(server['version']);
    if (version) entry.version = version;

    const repoUrl = httpUrl(prop(server['repository'], 'url'));
    if (repoUrl) entry.repoUrl = repoUrl;

    const websiteUrl = httpUrl(server['websiteUrl']);
    if (websiteUrl) entry.websiteUrl = websiteUrl;

    const official = prop(prop(item, '_meta'), OFFICIAL_META);
    const updatedAt = asString(prop(official, 'updatedAt'));
    if (updatedAt) entry.updatedAt = updatedAt;

    return entry;
  } catch {
    // Defensive: normalization must never take down a whole catalog build.
    return null;
  }
}

/**
 * The repository url of a raw registry item, read on its own.
 *
 * The catalog stage needs these before it builds anything, to look up star
 * counts for the ranking, and normalizing 20k entries twice to get them would
 * be silly. Must stay in step with the `repoUrl` {@link normalizeRegistryItem}
 * assigns, since the lookup is keyed by that exact string.
 */
export function registryRepoUrl(item: unknown): string | undefined {
  return httpUrl(prop(prop(prop(item, 'server'), 'repository'), 'url'));
}

function normalizePackages(raw: unknown): PackageSpec[] {
  const packages: PackageSpec[] = [];
  for (const candidate of asArray(raw)) {
    if (!isRecord(candidate)) continue;

    // Anything outside npm/pypi/oci (e.g. "mcpb") is a distribution we cannot
    // probe, so the package is dropped rather than recorded as unknown.
    const kind = PACKAGE_KINDS[asString(candidate['registryType']) ?? ''];
    const identifier = asString(candidate['identifier']);
    if (!kind || !identifier) continue;

    const pkg: PackageSpec = { kind, identifier, env: toEnvVars(candidate['environmentVariables']) };

    const version = asString(candidate['version']);
    if (version) pkg.version = version;

    const runtimeHint = asString(candidate['runtimeHint']);
    if (runtimeHint) pkg.runtimeHint = runtimeHint;

    const runtimeArguments = flattenArguments(candidate['runtimeArguments']);
    if (runtimeArguments.args.length > 0) pkg.runtimeArguments = runtimeArguments.args;

    const packageArguments = flattenArguments(candidate['packageArguments']);
    if (packageArguments.args.length > 0) pkg.packageArguments = packageArguments.args;

    // Only set when something really was dropped: absent means "the invocation
    // is what the registry declared", which is what the harness reads it as.
    if (runtimeArguments.dropped || packageArguments.dropped) pkg.droppedArguments = true;

    const transport = asString(prop(candidate['transport'], 'type'));
    if (transport) pkg.transport = transport;

    packages.push(pkg);
  }
  return packages;
}

function normalizeRemotes(raw: unknown): RemoteSpec[] {
  const remotes: RemoteSpec[] = [];
  for (const candidate of asArray(raw)) {
    if (!isRecord(candidate)) continue;

    const type = REMOTE_TYPES[asString(candidate['type']) ?? ''];
    const url = httpUrl(candidate['url']);
    if (!type || !url) continue;

    remotes.push({ type, url, headers: toEnvVars(candidate['headers']) });
  }
  return remotes;
}

/**
 * `environmentVariables[]` and a remote's `headers[]` share one shape in the
 * registry schema, and one shape in ours.
 */
function toEnvVars(raw: unknown): EnvVarSpec[] {
  const vars: EnvVarSpec[] = [];
  for (const candidate of asArray(raw)) {
    if (!isRecord(candidate)) continue;

    const name = asString(candidate['name']);
    if (!name) continue;

    const spec: EnvVarSpec = {
      name,
      required: asBoolean(candidate['isRequired'], false),
      secret: asBoolean(candidate['isSecret'], false),
    };
    const description = asString(candidate['description']);
    if (description) spec.description = description;

    vars.push(spec);
  }
  return vars;
}

/** An argv slice, plus whether any declared argument did not make it in. */
interface FlattenedArguments {
  args: string[];
  dropped: boolean;
}

/**
 * Flatten registry argument objects into a plain argv slice.
 *
 * Only arguments the registry pinned a concrete value on are emitted: a named
 * argument contributes its flag name followed by that value, a positional one
 * contributes just the value. Arguments with nothing concrete to contribute
 * (placeholders the end user is meant to fill in, described by `valueHint` or
 * `format` alone) are skipped entirely, flag included; the harness
 * runs unattended and has no value to put there, and a bare flag missing its
 * value usually breaks the invocation outright.
 *
 * `dropped` reports whether that happened, because the difference matters
 * downstream: a server we launched with an incomplete command line and could
 * not start is `needs_config`, not broken. Junk that is not an argument object
 * at all does not count, but every argument object we could not turn into argv
 * does, whatever the reason: what the flag says about the server is the same
 * either way, that we did not run it as declared.
 */
function flattenArguments(raw: unknown): FlattenedArguments {
  const args: string[] = [];
  let dropped = false;

  for (const candidate of asArray(raw)) {
    if (!isRecord(candidate)) continue;

    const type = asString(candidate['type']);
    const value = asString(candidate['value']);
    const name = asString(candidate['name']);

    if (value && type === 'named' && name) {
      args.push(name, value);
    } else if (value && type === 'positional') {
      args.push(value);
    } else {
      dropped = true;
    }
  }
  return { args, dropped };
}

/** A syntactically valid http(s) URL, or undefined. Keeps `javascript:` and
 * friends out of the catalog, since the site renders these as links. */
function httpUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}
