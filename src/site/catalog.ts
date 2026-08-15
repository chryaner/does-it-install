/**
 * Reading `data/catalog.json` for the site build.
 *
 * The catalog is committed to git and assembled from a public registry, so it
 * is parsed defensively rather than cast: unknown package kinds and remote
 * transports are dropped, and anything that would break a page (missing id, a
 * slug that is not a usable URL segment) fails the build loudly instead of
 * producing half a site.
 */

import { readFile } from 'node:fs/promises';
import { asArray, asBoolean, asString, isRecord } from '../catalog/json.js';
import type {
  Catalog,
  EnvVarSpec,
  PackageSpec,
  Popularity,
  RemoteSpec,
  ServerEntry,
} from '../types.js';

/** Slugs become both a file name and a URL segment under `s/`. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

const PACKAGE_KINDS: readonly PackageSpec['kind'][] = ['npm', 'pypi', 'oci'];
const REMOTE_TYPES: readonly RemoteSpec['type'][] = ['streamable-http', 'sse'];

/** Read and validate a catalog file. Throws with the path on any problem. */
export async function loadCatalog(path: string): Promise<Catalog> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read catalog ${path}: ${message(error)} (run the catalog stage first)`,
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`catalog ${path} is not valid JSON: ${message(error)}`);
  }

  try {
    return parseCatalog(document);
  } catch (error) {
    throw new Error(`catalog ${path}: ${message(error)}`);
  }
}

/** Validate an already-parsed catalog document. */
export function parseCatalog(document: unknown): Catalog {
  if (!isRecord(document)) throw new Error('must be an object');
  const servers = document['servers'];
  if (!Array.isArray(servers)) throw new Error('servers must be an array');

  return {
    generatedAt: asString(document['generatedAt']) ?? '',
    servers: servers.map((entry, index) => {
      try {
        return parseEntry(entry);
      } catch (error) {
        throw new Error(`servers[${index}]: ${message(error)}`);
      }
    }),
  };
}

function parseEntry(value: unknown): ServerEntry {
  if (!isRecord(value)) throw new Error('must be an object');

  const id = asString(value['id']);
  if (id === undefined) throw new Error('id must be a non-empty string');

  const slug = asString(value['slug']);
  if (slug === undefined) throw new Error('slug must be a non-empty string');
  if (!SLUG_PATTERN.test(slug)) throw new Error(`slug "${slug}" is not a usable URL segment`);

  const entry: ServerEntry = {
    id,
    slug,
    title: asString(value['title']) ?? id,
    packages: asArray(value['packages']).flatMap(parsePackage),
    remotes: asArray(value['remotes']).flatMap(parseRemote),
    source: value['source'] === 'seed' ? 'seed' : 'registry',
    rank: asRank(value['rank']),
  };

  assign(entry, 'description', asString(value['description']));
  assign(entry, 'version', asString(value['version']));
  assign(entry, 'repoUrl', asString(value['repoUrl']));
  assign(entry, 'websiteUrl', asString(value['websiteUrl']));
  assign(entry, 'updatedAt', asString(value['updatedAt']));
  assign(entry, 'popularity', parsePopularity(value['popularity']));

  return entry;
}

/**
 * Popularity is optional everywhere. A count that is not a plain non-negative
 * number is dropped rather than rendered, the same way an unknown package kind
 * is dropped.
 */
function parsePopularity(value: unknown): Popularity | undefined {
  if (!isRecord(value)) return undefined;
  const stars = value['stars'];
  if (typeof stars !== 'number' || !Number.isFinite(stars) || stars < 0) return undefined;
  return { stars: Math.round(stars) };
}

/** Returns a one-element array, or [] for a distribution we cannot render. */
function parsePackage(value: unknown): PackageSpec[] {
  if (!isRecord(value)) return [];
  const kind = PACKAGE_KINDS.find((candidate) => candidate === value['kind']);
  const identifier = asString(value['identifier']);
  if (kind === undefined || identifier === undefined) return [];

  const spec: PackageSpec = { kind, identifier, env: asArray(value['env']).flatMap(parseEnvVar) };
  assign(spec, 'version', asString(value['version']));
  assign(spec, 'runtimeHint', asString(value['runtimeHint']));
  assign(spec, 'transport', asString(value['transport']));
  const runtimeArguments = asStringArray(value['runtimeArguments']);
  if (runtimeArguments.length > 0) spec.runtimeArguments = runtimeArguments;
  const packageArguments = asStringArray(value['packageArguments']);
  if (packageArguments.length > 0) spec.packageArguments = packageArguments;

  return [spec];
}

function parseRemote(value: unknown): RemoteSpec[] {
  if (!isRecord(value)) return [];
  const type = REMOTE_TYPES.find((candidate) => candidate === value['type']);
  const url = asString(value['url']);
  if (type === undefined || url === undefined) return [];
  return [{ type, url, headers: asArray(value['headers']).flatMap(parseEnvVar) }];
}

function parseEnvVar(value: unknown): EnvVarSpec[] {
  if (!isRecord(value)) return [];
  const name = asString(value['name']);
  if (name === undefined) return [];

  const spec: EnvVarSpec = {
    name,
    required: asBoolean(value['required'], false),
    secret: asBoolean(value['secret'], false),
  };
  assign(spec, 'description', asString(value['description']));
  return [spec];
}

function asStringArray(value: unknown): string[] {
  return asArray(value).flatMap((item) => {
    const text = asString(item);
    return text === undefined ? [] : [text];
  });
}

/** Rank drives page order; an entry without one sorts last rather than first. */
function asRank(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function assign<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
