/**
 * Shared data contract for does-it-install.
 *
 * Every module (catalog, harness, history, badges, site) reads and writes
 * these shapes. Changes here are breaking changes for the whole pipeline:
 * the on-disk JSON files in data/ follow these interfaces exactly.
 *
 * Pipeline:
 *   catalog  : registry + seed  -> data/catalog.json            (Catalog)
 *   sweep    : catalog          -> data/runs/<runId>-<platform>.json (RunFile)
 *   merge    : runs + history   -> data/history/<slug>.json     (ServerHistory)
 *   badges   : history          -> public/badge/<slug>.json     (ShieldsBadge)
 *   site     : catalog+history  -> public/**                    (static HTML)
 */

/** process.platform values we run probes on. */
export type Platform = 'linux' | 'darwin' | 'win32';

/** How a server was probed. */
export type ProbeMethod =
  | 'npm' // installed from npm into a clean prefix, spawned over stdio
  | 'pypi' // installed with `uv tool run` from PyPI, spawned over stdio
  | 'remote-http' // connected to a hosted endpoint over streamable HTTP
  | 'remote-sse' // connected to a hosted endpoint over legacy SSE
  | 'oci' // docker image (not yet implemented -> skipped)
  | 'none'; // no supported distribution -> skipped

/**
 * Outcome of a probe. Ordered roughly by how far the probe got:
 *   install -> spawn/connect -> handshake -> listTools -> pass
 */
export type ProbeStatus =
  | 'pass' // handshake + tools/list succeeded
  | 'install_failed' // package manager could not install it
  | 'spawn_failed' // installed, but the process would not start
  | 'connect_failed' // remote endpoint unreachable / bad HTTP response
  | 'handshake_failed' // process/endpoint up, MCP initialize failed
  | 'tools_failed' // initialized, but tools/list failed
  | 'timeout' // a phase exceeded its time budget
  | 'skipped'; // no supported distribution or intentionally excluded

/** Environment variable declared by a server's package spec. */
export interface EnvVarSpec {
  name: string;
  required: boolean;
  secret: boolean;
  description?: string;
}

/** A package-based distribution of a server (npm / pypi / oci). */
export interface PackageSpec {
  kind: 'npm' | 'pypi' | 'oci';
  /** Package identifier, e.g. "@modelcontextprotocol/server-everything". */
  identifier: string;
  version?: string;
  /** e.g. "npx", "uvx", "docker" when the registry provides one. */
  runtimeHint?: string;
  /** Args passed to the runtime before the package (rarely used). */
  runtimeArguments?: string[];
  /** Args passed to the server binary itself. */
  packageArguments?: string[];
  /** Declared transport type, e.g. "stdio". */
  transport?: string;
  env: EnvVarSpec[];
}

/** A hosted distribution of a server. */
export interface RemoteSpec {
  type: 'streamable-http' | 'sse';
  url: string;
  /** Headers the endpoint declares (often auth). Names only matter here. */
  headers: EnvVarSpec[];
}

/** One MCP server in the catalog, normalized from whatever source listed it. */
export interface ServerEntry {
  /** Canonical id, e.g. "io.github.owner/name" (registry) or seed id. */
  id: string;
  /** Filesystem/URL-safe form of id. See slugify(). */
  slug: string;
  /** Display name. */
  title: string;
  description?: string;
  version?: string;
  repoUrl?: string;
  websiteUrl?: string;
  packages: PackageSpec[];
  remotes: RemoteSpec[];
  source: 'registry' | 'seed';
  /** Lower rank = probed first when the sweep is capped with --top. */
  rank: number;
  /** ISO timestamp the source last updated this entry, if known. */
  updatedAt?: string;
}

export interface Catalog {
  generatedAt: string; // ISO
  servers: ServerEntry[];
}

export interface PhaseResult {
  ok: boolean;
  durationMs: number;
  /** Short human-readable detail (error message, exit code, ...). */
  detail?: string;
}

/** Result of probing one server on one platform. */
export interface ProbeResult {
  serverId: string;
  slug: string;
  platform: Platform;
  method: ProbeMethod;
  status: ProbeStatus;
  phases: {
    install?: PhaseResult;
    spawn?: PhaseResult;
    connect?: PhaseResult;
    handshake?: PhaseResult;
    listTools?: PhaseResult;
  };
  toolCount?: number;
  /** First MAX_TOOL_NAMES tool names, for the server page. */
  toolNames?: string[];
  serverInfo?: { name?: string; version?: string };
  /**
   * Trimmed stderr / exception text on failure, newest lines preferred,
   * hard-capped at MAX_ERROR_EXCERPT chars. Empty on success.
   */
  errorExcerpt?: string;
  /** Names of required env vars the probe filled with placeholders. */
  requiresEnv?: string[];
  startedAt: string; // ISO
  durationMs: number;
}

/** Everything one sweep run produced on one platform. */
export interface RunFile {
  /** Unique per sweep invocation, e.g. "2026-08-14T03-00-00Z-a1b2c3". */
  runId: string;
  platform: Platform;
  harnessVersion: string;
  startedAt: string; // ISO
  nodeVersion: string;
  osVersion: string;
  results: ProbeResult[];
}

/** One point on a server's green/red strip. */
export interface HistoryEntry {
  runId: string;
  date: string; // ISO
  status: ProbeStatus;
  method: ProbeMethod;
  toolCount?: number;
  /** First MAX_TOOL_NAMES tool names from a passing probe. */
  toolNames?: string[];
  errorExcerpt?: string;
}

/** Persisted per-server record; newest entries first, HISTORY_LIMIT max. */
export interface ServerHistory {
  serverId: string;
  slug: string;
  platforms: Partial<Record<Platform, HistoryEntry[]>>;
}

/** https://shields.io/badges/endpoint-badge response shape. */
export interface ShieldsBadge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  isError?: boolean;
  cacheSeconds?: number;
}

export const HISTORY_LIMIT = 30;
export const MAX_ERROR_EXCERPT = 4000;
export const MAX_TOOL_NAMES = 50;
export const HARNESS_VERSION = '0.1.0';

/** Value the harness substitutes for required env vars it cannot know. */
export const ENV_PLACEHOLDER = 'DOES_IT_INSTALL_PLACEHOLDER';

/**
 * Turn a server id into a string safe for file names and URL path segments.
 * "io.github.owner/name" -> "io.github.owner__name".
 * Collisions after normalization are resolved by the catalog builder
 * (it must guarantee slugs are unique within one catalog).
 */
export function slugify(id: string): string {
  return id
    .toLowerCase()
    .replace(/\//g, '__')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/** Map process.platform to our Platform union (throws on anything else). */
export function currentPlatform(): Platform {
  const p = process.platform;
  if (p === 'linux' || p === 'darwin' || p === 'win32') return p;
  throw new Error(`unsupported platform: ${p}`);
}
