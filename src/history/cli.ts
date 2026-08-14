/**
 * `npm run merge -- [--runs data/runs] [--history data/history]`
 *
 * Folds every readable run artifact into the per-server history files. The
 * files are the product; the summary goes to stderr.
 */

import { pathToFileURL } from 'node:url';
import {
  DEFAULT_HISTORY_DIR,
  DEFAULT_RUNS_DIR,
  loadHistoryDir,
  loadRunsDir,
  saveHistoryDir,
  serializeHistory,
} from './io.js';
import { mergeRuns } from './merge.js';

const USAGE = `Usage: npm run merge -- [options]

Merge sweep run artifacts into per-server history files.

Options:
  --runs <dir>     Directory of run artifacts (default: ${DEFAULT_RUNS_DIR})
  --history <dir>  History directory to read and update (default: ${DEFAULT_HISTORY_DIR})
  -h, --help       Show this help`;

export interface MergeCliOptions {
  runs: string;
  history: string;
  help: boolean;
}

/** Parse argv (without node/script). Throws on unknown or malformed flags. */
export function parseArgs(argv: readonly string[]): MergeCliOptions {
  const options: MergeCliOptions = {
    runs: DEFAULT_RUNS_DIR,
    history: DEFAULT_HISTORY_DIR,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    const takeValue = (): string => {
      if (inlineValue !== undefined && inlineValue.length > 0) return inlineValue;
      const next = inlineValue === undefined ? argv[++i] : undefined;
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      return next;
    };

    switch (flag) {
      case '--runs':
        options.runs = takeValue();
        break;
      case '--history':
        options.history = takeValue();
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }

  return options;
}

export async function run(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const runs = await loadRunsDir(options.runs);
  if (runs.length === 0) {
    throw new Error(
      `no readable run files in ${options.runs} (expected <runId>-<platform>.json artifacts from the sweep)`,
    );
  }

  const { histories, skipped } = await loadHistoryDir(options.history);
  const merged = mergeRuns(runs, histories);

  let updated = 0;
  for (const [slug, history] of merged) {
    if (skipped.has(slug)) continue;
    const before = histories.get(slug);
    if (!before || serializeHistory(before) !== serializeHistory(history)) updated++;
  }

  const { written, preserved } = await saveHistoryDir(merged, options.history, { skip: skipped });
  if (preserved.length > 0) {
    process.stderr.write(
      `warning: left ${preserved.length} unreadable history file(s) untouched: ${preserved.join(', ')}\n`,
    );
  }

  process.stderr.write(
    `merge: ${runs.length} runs, ${updated} servers updated ` +
      `(${written} files written to ${options.history})\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
