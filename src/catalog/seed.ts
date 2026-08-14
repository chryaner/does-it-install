/**
 * Loader for `data/seed.json`, the hand-curated entries that are catalogued
 * whether or not the registry lists them.
 *
 * Unlike registry data, the seed file is ours: a typo in it is a repository
 * bug, so parsing is strict and throws with the exact JSON path at fault
 * instead of silently dropping entries.
 */

import { readFile } from 'node:fs/promises';
import type { EnvVarSpec, PackageSpec, RemoteSpec, ServerEntry } from '../types.js';
import { slugify } from '../types.js';
import { asArray, asBoolean, asString, isRecord } from './json.js';

export const DEFAULT_SEED_PATH = 'data/seed.json';

const PACKAGE_KINDS: readonly PackageSpec['kind'][] = ['npm', 'pypi', 'oci'];
const REMOTE_TYPES: readonly RemoteSpec['type'][] = ['streamable-http', 'sse'];

/** Read and parse the seed file. Rejects on a missing or invalid file. */
export async function loadSeed(seedPath: string = DEFAULT_SEED_PATH): Promise<ServerEntry[]> {
  let text: string;
  try {
    text = await readFile(seedPath, 'utf8');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : String(error);
    throw new Error(`cannot read seed file ${seedPath}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${seedPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return parseSeed(parsed, seedPath);
}

/**
 * Validate the parsed seed document and fill in the fields the file omits
 * (`slug`, `source`, and `rank` where absent).
 */
export function parseSeed(document: unknown, label = DEFAULT_SEED_PATH): ServerEntry[] {
  if (!isRecord(document) || !Array.isArray(document['servers'])) {
    throw new Error(`${label}: expected an object with a "servers" array`);
  }

  const entries: ServerEntry[] = [];
  const seenIds = new Set<string>();

  document['servers'].forEach((raw, index) => {
    const at = `servers[${index}]`;
    if (!isRecord(raw)) throw new Error(`${label}: ${at} must be an object`);

    const id = asString(raw['id']);
    if (!id) throw new Error(`${label}: ${at}.id must be a non-empty string`);
    if (seenIds.has(id)) throw new Error(`${label}: duplicate id "${id}" at ${at}`);
    seenIds.add(id);

    const rankValue = raw['rank'];
    if (rankValue !== undefined && !Number.isFinite(rankValue)) {
      throw new Error(`${label}: ${at}.rank must be a number`);
    }

    const entry: ServerEntry = {
      id,
      slug: slugify(id) || 'server',
      title: asString(raw['title']) ?? id,
      packages: asArray(raw['packages']).map((pkg, i) => parsePackage(pkg, `${at}.packages[${i}]`, label)),
      remotes: asArray(raw['remotes']).map((remote, i) => parseRemote(remote, `${at}.remotes[${i}]`, label)),
      source: 'seed',
      rank: typeof rankValue === 'number' ? rankValue : index + 1,
    };

    copyOptionalStrings(raw, entry, at, label);
    entries.push(entry);
  });

  return entries;
}

function copyOptionalStrings(raw: Record<string, unknown>, entry: ServerEntry, at: string, label: string): void {
  const fields = ['description', 'version', 'repoUrl', 'websiteUrl', 'updatedAt'] as const;
  for (const field of fields) {
    const value = raw[field];
    if (value === undefined) continue;
    const text = asString(value);
    if (!text) throw new Error(`${label}: ${at}.${field} must be a non-empty string`);
    entry[field] = text;
  }
}

function parsePackage(raw: unknown, at: string, label: string): PackageSpec {
  if (!isRecord(raw)) throw new Error(`${label}: ${at} must be an object`);

  const kind = asString(raw['kind']);
  if (!kind || !PACKAGE_KINDS.includes(kind as PackageSpec['kind'])) {
    throw new Error(`${label}: ${at}.kind must be one of ${PACKAGE_KINDS.join(', ')}`);
  }
  const identifier = asString(raw['identifier']);
  if (!identifier) throw new Error(`${label}: ${at}.identifier must be a non-empty string`);

  const pkg: PackageSpec = {
    kind: kind as PackageSpec['kind'],
    identifier,
    env: parseEnvVars(raw['env'], `${at}.env`, label),
  };

  const version = asString(raw['version']);
  if (version) pkg.version = version;
  const runtimeHint = asString(raw['runtimeHint']);
  if (runtimeHint) pkg.runtimeHint = runtimeHint;
  const transport = asString(raw['transport']);
  if (transport) pkg.transport = transport;

  const runtimeArguments = parseStringArray(raw['runtimeArguments'], `${at}.runtimeArguments`, label);
  if (runtimeArguments.length > 0) pkg.runtimeArguments = runtimeArguments;
  const packageArguments = parseStringArray(raw['packageArguments'], `${at}.packageArguments`, label);
  if (packageArguments.length > 0) pkg.packageArguments = packageArguments;

  return pkg;
}

function parseRemote(raw: unknown, at: string, label: string): RemoteSpec {
  if (!isRecord(raw)) throw new Error(`${label}: ${at} must be an object`);

  const type = asString(raw['type']);
  if (!type || !REMOTE_TYPES.includes(type as RemoteSpec['type'])) {
    throw new Error(`${label}: ${at}.type must be one of ${REMOTE_TYPES.join(', ')}`);
  }
  const url = asString(raw['url']);
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error(`${label}: ${at}.url must be an http(s) URL`);
  }

  return {
    type: type as RemoteSpec['type'],
    url,
    headers: parseEnvVars(raw['headers'], `${at}.headers`, label),
  };
}

function parseEnvVars(raw: unknown, at: string, label: string): EnvVarSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${label}: ${at} must be an array`);

  return raw.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${label}: ${at}[${index}] must be an object`);
    const name = asString(item['name']);
    if (!name) throw new Error(`${label}: ${at}[${index}].name must be a non-empty string`);

    const spec: EnvVarSpec = {
      name,
      required: asBoolean(item['required'], false),
      secret: asBoolean(item['secret'], false),
    };
    const description = asString(item['description']);
    if (description) spec.description = description;
    return spec;
  });
}

function parseStringArray(raw: unknown, at: string, label: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${label}: ${at} must be an array of strings`);

  return raw.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${label}: ${at}[${index}] must be a string`);
    return item;
  });
}
