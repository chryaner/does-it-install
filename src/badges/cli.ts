/**
 * `npm run badges -- [--history data/history] [--out public/badge]`
 *
 * Writes one shields.io endpoint file per server (`<slug>.json`) plus one per
 * platform we have data for (`<slug>-<platform>.json`). Embed them with
 * https://img.shields.io/endpoint?url=<pages-url>/badge/<slug>.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_HISTORY_DIR, bySlug, loadHistoryDir } from '../history/io.js';
import type { ShieldsBadge } from '../types.js';
import { badgeForHistory, platformsWithData } from './badge.js';

export const DEFAULT_BADGE_DIR = 'public/badge';

const USAGE = `Usage: npm run badges -- [options]

Generate shields.io endpoint JSON from the merged history.

Options:
  --history <dir>  History directory to read (default: ${DEFAULT_HISTORY_DIR})
  --out <dir>      Directory to write badge JSON into (default: ${DEFAULT_BADGE_DIR})
  -h, --help       Show this help`;

export interface BadgesCliOptions {
  history: string;
  out: string;
  help: boolean;
}

/** Parse argv (without node/script). Throws on unknown or malformed flags. */
export function parseArgs(argv: readonly string[]): BadgesCliOptions {
  const options: BadgesCliOptions = {
    history: DEFAULT_HISTORY_DIR,
    out: DEFAULT_BADGE_DIR,
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
      case '--history':
        options.history = takeValue();
        break;
      case '--out':
        options.out = takeValue();
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

  const { histories } = await loadHistoryDir(options.history);
  if (histories.size === 0) {
    throw new Error(`no readable history files in ${options.history} (run the merge stage first)`);
  }

  await mkdir(options.out, { recursive: true });

  let files = 0;
  for (const [slug, history] of bySlug(histories)) {
    const { overall, perPlatform } = badgeForHistory(history);

    await writeBadge(join(options.out, `${slug}.json`), overall);
    files++;
    for (const platform of platformsWithData(history)) {
      await writeBadge(join(options.out, `${slug}-${platform}.json`), perPlatform[platform]);
      files++;
    }
  }

  process.stderr.write(`badges: ${histories.size} servers, ${files} files -> ${options.out}\n`);
}

async function writeBadge(path: string, badge: ShieldsBadge): Promise<void> {
  await writeFile(path, `${JSON.stringify(badge, null, 2)}\n`, 'utf8');
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
