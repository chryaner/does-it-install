/**
 * Reading and writing the two directories the merge stage touches:
 * `data/runs/<runId>-<platform>.json` (input, produced by the sweep) and
 * `data/history/<slug>.json` (input and output).
 *
 * Both are parsed defensively, because run artifacts arrive from CI machines
 * and history files are committed to git where they can be hand-edited or land
 * in a bad merge. A file we cannot parse is reported on stderr and skipped, never
 * repaired, deleted, or silently overwritten: `loadHistoryDir` hands back the
 * slugs it skipped so `saveHistoryDir` can leave those files untouched for a
 * human to look at.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HistoryEntry,
  PhaseResult,
  Platform,
  ProbeMethod,
  ProbeResult,
  ProbeStatus,
  RunFile,
  ServerHistory,
} from '../types.js';
import { isPlatform } from './platforms.js';

export const DEFAULT_RUNS_DIR = 'data/runs';
export const DEFAULT_HISTORY_DIR = 'data/history';

export interface LoadedHistories {
  /** Parsed histories, keyed by slug. */
  histories: Map<string, ServerHistory>;
  /** Slugs whose file could not be parsed; `saveHistoryDir` must not write these. */
  skipped: Set<string>;
}

export interface SaveHistoryOptions {
  /** Slugs to leave on disk exactly as they are (typically `LoadedHistories.skipped`). */
  skip?: ReadonlySet<string>;
}

export interface SaveHistoryResult {
  /** Number of history files written. */
  written: number;
  /** Slugs that were in the map but preserved on disk instead of written. */
  preserved: string[];
}

/**
 * Load every `<slug>.json` in `dir`. A missing directory is not an error (the
 * first sweep has no history yet); unreadable or malformed files are warned
 * about and skipped.
 */
export async function loadHistoryDir(dir: string): Promise<LoadedHistories> {
  const histories = new Map<string, ServerHistory>();
  const skipped = new Set<string>();

  for (const fileName of await listJsonFiles(dir)) {
    const path = join(dir, fileName);
    const slug = fileName.slice(0, -'.json'.length);
    try {
      const history = parseServerHistory(await readJson(path), slug);
      histories.set(history.slug, history);
    } catch (error) {
      warn(`skipping history file ${path}: ${message(error)} (left untouched)`);
      skipped.add(slug);
    }
  }

  return { histories, skipped };
}

/**
 * Load every run artifact in `dir`, sorted by file name so merges are
 * deterministic. A missing directory yields an empty list; the caller decides
 * whether that is fatal.
 */
export async function loadRunsDir(dir: string): Promise<RunFile[]> {
  const runs: RunFile[] = [];

  for (const fileName of await listJsonFiles(dir)) {
    const path = join(dir, fileName);
    try {
      runs.push(parseRunFile(await readJson(path)));
    } catch (error) {
      warn(`skipping run file ${path}: ${message(error)}`);
    }
  }

  return runs;
}

/**
 * Write one pretty-printed file per history, creating `dir` if needed. Object
 * keys are sorted so a re-merge that changes nothing produces no diff.
 */
export async function saveHistoryDir(
  histories: ReadonlyMap<string, ServerHistory>,
  dir: string,
  options: SaveHistoryOptions = {},
): Promise<SaveHistoryResult> {
  await mkdir(dir, { recursive: true });

  const skip = options.skip ?? new Set<string>();
  const preserved: string[] = [];
  let written = 0;

  for (const [slug, history] of bySlug(histories)) {
    if (skip.has(slug)) {
      preserved.push(slug);
      continue;
    }
    await writeFile(join(dir, `${slug}.json`), serializeHistory(history), 'utf8');
    written++;
  }

  return { written, preserved };
}

/** Map entries in slug order, so output and logs do not depend on insertion order. */
export function bySlug(
  histories: ReadonlyMap<string, ServerHistory>,
): [string, ServerHistory][] {
  return [...histories].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Canonical on-disk form of a history: 2-space JSON with every object key
 * sorted and a trailing newline. Also used to detect whether a merge actually
 * changed a server.
 */
export function serializeHistory(history: ServerHistory): string {
  return `${JSON.stringify(sortKeysDeep(history), null, 2)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

/** Sorted `*.json` file names in `dir`; [] when the directory does not exist. */
async function listJsonFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`cannot read directory ${dir}: ${message(error)}`);
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON: ${message(error)}`);
  }
}

/**
 * Validate a parsed history document. `expectedSlug` comes from the file name:
 * a mismatch means writing this record back would leave a stale second file,
 * so it counts as corruption.
 */
export function parseServerHistory(document: unknown, expectedSlug: string): ServerHistory {
  const record = requireRecord(document, 'history');
  const slug = requireSlug(record['slug'], 'slug');
  if (slug !== expectedSlug) {
    throw new Error(`slug "${slug}" does not match file name "${expectedSlug}.json"`);
  }

  const platformsRecord = requireRecord(record['platforms'], 'platforms');
  const platforms: ServerHistory['platforms'] = {};
  for (const [key, value] of Object.entries(platformsRecord)) {
    if (!isPlatform(key)) throw new Error(`platforms."${key}" is not a known platform`);
    if (!Array.isArray(value)) throw new Error(`platforms.${key} must be an array`);
    platforms[key] = value.map((entry, index) => {
      try {
        return parseHistoryEntry(entry);
      } catch (error) {
        throw new Error(`platforms.${key}[${index}]: ${message(error)}`);
      }
    });
  }

  return { serverId: requireString(record['serverId'], 'serverId'), slug, platforms };
}

function parseHistoryEntry(value: unknown): HistoryEntry {
  const record = requireRecord(value, 'entry');
  const entry: HistoryEntry = {
    runId: requireString(record['runId'], 'runId'),
    date: requireString(record['date'], 'date'),
    status: requireStatus(record['status']),
    method: requireMethod(record['method']),
  };
  const toolCount = optionalNumber(record['toolCount'], 'toolCount');
  if (toolCount !== undefined) entry.toolCount = toolCount;
  const toolNames = optionalStringArray(record['toolNames'], 'toolNames');
  if (toolNames) entry.toolNames = toolNames;
  const errorExcerpt = optionalString(record['errorExcerpt'], 'errorExcerpt');
  if (errorExcerpt) entry.errorExcerpt = errorExcerpt;
  return entry;
}

/**
 * Validate a parsed run artifact. Identity and results are required, because
 * merging without them would corrupt history. Descriptive metadata
 * (harness/node/os versions, per-result timings) falls back to a default so a
 * run from a slightly different harness build is still usable.
 */
export function parseRunFile(document: unknown): RunFile {
  const record = requireRecord(document, 'run');
  const rawResults = record['results'];
  if (!Array.isArray(rawResults)) throw new Error('results must be an array');

  return {
    runId: requireString(record['runId'], 'runId'),
    platform: requirePlatform(record['platform'], 'platform'),
    startedAt: requireString(record['startedAt'], 'startedAt'),
    harnessVersion: optionalString(record['harnessVersion'], 'harnessVersion') ?? 'unknown',
    nodeVersion: optionalString(record['nodeVersion'], 'nodeVersion') ?? 'unknown',
    osVersion: optionalString(record['osVersion'], 'osVersion') ?? 'unknown',
    results: rawResults.map((raw, index) => {
      try {
        return parseProbeResult(raw);
      } catch (error) {
        throw new Error(`results[${index}]: ${message(error)}`);
      }
    }),
  };
}

function parseProbeResult(value: unknown): ProbeResult {
  const record = requireRecord(value, 'result');
  const result: ProbeResult = {
    serverId: requireString(record['serverId'], 'serverId'),
    slug: requireSlug(record['slug'], 'slug'),
    platform: requirePlatform(record['platform'], 'platform'),
    method: requireMethod(record['method']),
    status: requireStatus(record['status']),
    phases: parsePhases(record['phases']),
    startedAt: optionalString(record['startedAt'], 'startedAt') ?? '',
    durationMs: optionalNumber(record['durationMs'], 'durationMs') ?? 0,
  };

  const toolCount = optionalNumber(record['toolCount'], 'toolCount');
  if (toolCount !== undefined) result.toolCount = toolCount;
  const toolNames = optionalStringArray(record['toolNames'], 'toolNames');
  if (toolNames) result.toolNames = toolNames;
  const errorExcerpt = optionalString(record['errorExcerpt'], 'errorExcerpt');
  if (errorExcerpt) result.errorExcerpt = errorExcerpt;
  const requiresEnv = optionalStringArray(record['requiresEnv'], 'requiresEnv');
  if (requiresEnv) result.requiresEnv = requiresEnv;
  const serverInfo = parseServerInfo(record['serverInfo']);
  if (serverInfo) result.serverInfo = serverInfo;

  return result;
}

const PHASE_NAMES: readonly (keyof ProbeResult['phases'])[] = [
  'install',
  'spawn',
  'connect',
  'handshake',
  'listTools',
];

function parsePhases(value: unknown): ProbeResult['phases'] {
  if (value === undefined) return {};
  const record = requireRecord(value, 'phases');
  const phases: ProbeResult['phases'] = {};
  for (const name of PHASE_NAMES) {
    const raw = record[name];
    if (raw === undefined) continue;
    const phase = requireRecord(raw, `phases.${name}`);
    const result: PhaseResult = {
      ok: typeof phase['ok'] === 'boolean' ? phase['ok'] : false,
      durationMs: optionalNumber(phase['durationMs'], `phases.${name}.durationMs`) ?? 0,
    };
    const detail = optionalString(phase['detail'], `phases.${name}.detail`);
    if (detail !== undefined) result.detail = detail;
    phases[name] = result;
  }
  return phases;
}

function parseServerInfo(value: unknown): ProbeResult['serverInfo'] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'serverInfo');
  const info: NonNullable<ProbeResult['serverInfo']> = {};
  const name = optionalString(record['name'], 'serverInfo.name');
  if (name !== undefined) info.name = name;
  const version = optionalString(record['version'], 'serverInfo.version');
  if (version !== undefined) info.version = version;
  return info;
}

const PROBE_STATUSES: Record<ProbeStatus, true> = {
  pass: true,
  install_failed: true,
  spawn_failed: true,
  connect_failed: true,
  handshake_failed: true,
  tools_failed: true,
  timeout: true,
  skipped: true,
};

const PROBE_METHODS: Record<ProbeMethod, true> = {
  npm: true,
  pypi: true,
  'remote-http': true,
  'remote-sse': true,
  oci: true,
  none: true,
};

function requireStatus(value: unknown): ProbeStatus {
  if (typeof value === 'string' && Object.hasOwn(PROBE_STATUSES, value)) {
    return value as ProbeStatus;
  }
  throw new Error(`status "${String(value)}" is not a known ProbeStatus`);
}

function requireMethod(value: unknown): ProbeMethod {
  if (typeof value === 'string' && Object.hasOwn(PROBE_METHODS, value)) {
    return value as ProbeMethod;
  }
  throw new Error(`method "${String(value)}" is not a known ProbeMethod`);
}

function requirePlatform(value: unknown, at: string): Platform {
  if (isPlatform(value)) return value;
  throw new Error(`${at} "${String(value)}" is not a known Platform`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} must be an object`);
  return value;
}

function requireString(value: unknown, at: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`${at} must be a non-empty string`);
}

/**
 * Slugs become file names under the history directory, and run artifacts are
 * downloaded from CI, so a slug that could escape that directory is rejected
 * rather than trusted.
 */
function requireSlug(value: unknown, at: string): string {
  const slug = requireString(value, at);
  if (slug === '.' || slug === '..' || /[/\\]/.test(slug)) {
    throw new Error(`${at} "${slug}" is not usable as a file name`);
  }
  return slug;
}

function optionalString(value: unknown, at: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${at} must be a string`);
  return value;
}

function optionalNumber(value: unknown, at: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${at} must be a finite number`);
  }
  return value;
}

function optionalStringArray(value: unknown, at: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${at} must be an array of strings`);
  return value.map((item, index) => requireString(item, `${at}[${index}]`));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(text: string): void {
  process.stderr.write(`warning: ${text}\n`);
}
