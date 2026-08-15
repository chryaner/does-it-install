/**
 * `npm run sweep`: probe catalogued servers and write one run file.
 *
 * Servers that fail are the product, not an error: the process exits 0 with a
 * run file full of red. Exit 1 is reserved for the harness itself failing:
 * bad flags, unreadable catalog, unwritable output.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Catalog } from '../types.js';
import { isMethodFilter, type MethodFilter, type ProbeTimeouts } from './options.js';
import { runSweep, summarize, type Shard, type SweepOptions } from './runner.js';
import { describeError } from './util.js';

const USAGE = `Usage: npm run sweep -- [options]

  --catalog <path>          catalog to read (default: data/catalog.json)
  --out <path>              run file to write
                            (default: data/runs/<runId>-<platform>.json)
  --top <n>                 probe only the n highest-ranked servers
  --shard <i>/<n>           probe shard i of n (i is zero-based)
  --only <id-or-slug>       probe only this server (repeatable)
  --methods <list>          comma-separated: npm,pypi,remote (default: all)
  --concurrency <n>         parallel probes (default: 4)
  --timeout-install <sec>   install budget per server (default: 600)
  --timeout-connect <sec>   remote connect budget per server (default: 20)
  --deadline <min>          stop starting new probes after this many minutes
                            and write whatever was probed (default: none)
  -h, --help                show this help`;

/** Bad input from the operator: report it with the usage text, exit 1. */
class UsageError extends Error {}

export async function main(argv: readonly string[]): Promise<number> {
  let options: SweepCliOptions;
  try {
    options = parseSweepArgs(argv);
  } catch (err) {
    process.stderr.write(`${describeError(err)}\n\n${USAGE}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let catalog: Catalog;
  try {
    catalog = await readCatalog(options.catalogPath);
  } catch (err) {
    process.stderr.write(`${describeError(err)}\n`);
    return 1;
  }

  try {
    const run = await runSweep(catalog, options.sweep);
    const outPath = options.outPath ?? path.join('data', 'runs', `${run.runId}-${run.platform}.json`);
    await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

    const counts = summarize(run.results);
    const summary = Object.entries(counts)
      .map(([status, count]) => `${status}=${count}`)
      .join(' ');
    process.stderr.write(`${run.results.length} probed (${summary || 'nothing selected'}) -> ${outPath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`sweep failed: ${describeError(err)}\n`);
    return 1;
  }
}

interface SweepCliOptions {
  help: boolean;
  catalogPath: string;
  outPath?: string;
  sweep: SweepOptions;
}

export function parseSweepArgs(argv: readonly string[]): SweepCliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        catalog: { type: 'string' },
        out: { type: 'string' },
        top: { type: 'string' },
        shard: { type: 'string' },
        only: { type: 'string', multiple: true },
        methods: { type: 'string' },
        concurrency: { type: 'string' },
        'timeout-install': { type: 'string' },
        'timeout-connect': { type: 'string' },
        deadline: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    });
  } catch (err) {
    throw new UsageError(describeError(err));
  }

  const values = parsed.values;
  const timeouts: Partial<ProbeTimeouts> = {};
  const installSeconds = optionalSeconds('--timeout-install', values['timeout-install']);
  if (installSeconds !== undefined) timeouts.install = installSeconds;
  const connectSeconds = optionalSeconds('--timeout-connect', values['timeout-connect']);
  if (connectSeconds !== undefined) timeouts.remoteConnect = connectSeconds;

  const sweep: SweepOptions = { timeouts };
  const top = values.top;
  if (top !== undefined) sweep.top = positiveInteger('--top', top);
  const concurrency = values.concurrency;
  if (concurrency !== undefined) sweep.concurrency = positiveInteger('--concurrency', concurrency);
  const shard = values.shard;
  if (shard !== undefined) sweep.shard = parseShard(shard);
  const methods = values.methods;
  if (methods !== undefined) sweep.methods = parseMethods(methods);
  const only = values.only;
  if (only !== undefined && only.length > 0) sweep.only = only;
  const deadline = values.deadline;
  if (deadline !== undefined) {
    sweep.deadline = Date.now() + positiveInteger('--deadline', deadline) * 60_000;
  }

  return {
    help: values.help === true,
    catalogPath: values.catalog ?? path.join('data', 'catalog.json'),
    outPath: values.out,
    sweep
  };
}

export function parseShard(value: string): Shard {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    throw new UsageError(`--shard must look like i/N (i is zero-based), got "${value}"`);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1) throw new UsageError(`--shard total must be at least 1, got "${value}"`);
  if (index >= total) throw new UsageError(`--shard index must be between 0 and ${total - 1}, got "${value}"`);
  return { index, total };
}

export function parseMethods(value: string): MethodFilter[] {
  const names = value
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0);
  if (names.length === 0) throw new UsageError('--methods needs at least one of: npm, pypi, remote');
  for (const name of names) {
    if (!isMethodFilter(name)) throw new UsageError(`unknown method "${name}", expected npm, pypi or remote`);
  }
  return names.filter(isMethodFilter);
}

function positiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function optionalSeconds(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`${flag} must be a positive number of seconds, got "${value}"`);
  }
  return Math.round(seconds * 1000);
}

async function readCatalog(catalogPath: string): Promise<Catalog> {
  let raw: string;
  try {
    raw = await fs.readFile(catalogPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read catalog ${catalogPath}: ${describeError(err)} (run "npm run catalog" first?)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`catalog ${catalogPath} is not valid JSON: ${describeError(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Catalog).servers)) {
    throw new Error(`catalog ${catalogPath} has no "servers" array`);
  }
  return parsed as Catalog;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  // Exit explicitly: a probed server may have left handles behind.
  process.exit(code);
}
