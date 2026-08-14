/**
 * `npm run site -- [--catalog data/catalog.json] [--history data/history]
 *                  [--out public] [--base /] [--site-url https://...]`
 *
 * Renders the static site: `index.html`, one page per catalogued server under
 * `s/`, `methodology.html`, `404.html` and a `.nojekyll` marker so GitHub
 * Pages serves the directory as-is.
 *
 * Existing files in the output directory are left alone, because the badge
 * stage writes `public/badge/` and must survive a site rebuild.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_HISTORY_DIR, loadHistoryDir } from '../history/io.js';
import { loadCatalog } from './catalog.js';
import { buildPages } from './pages.js';

export const DEFAULT_CATALOG_PATH = 'data/catalog.json';
export const DEFAULT_OUT_DIR = 'public';
export const DEFAULT_BASE = '/';
export const DEFAULT_SITE_URL = 'https://chryaner.github.io/does-it-install';

const USAGE = `Usage: npm run site -- [options]

Generate the static site from the catalog and the merged history.

Options:
  --catalog <path>  Catalog to read (default: ${DEFAULT_CATALOG_PATH})
  --history <dir>   History directory to read (default: ${DEFAULT_HISTORY_DIR})
  --out <dir>       Directory to write pages into (default: ${DEFAULT_OUT_DIR})
  --base <path>     URL prefix for every link (default: ${DEFAULT_BASE})
  --site-url <url>  Absolute site root, used in badge snippets
                    (default: ${DEFAULT_SITE_URL})
  -h, --help        Show this help`;

export interface SiteCliOptions {
  catalog: string;
  history: string;
  out: string;
  base: string;
  siteUrl: string;
  help: boolean;
}

/** Parse argv (without node/script). Throws on unknown or malformed flags. */
export function parseArgs(argv: readonly string[]): SiteCliOptions {
  const options: SiteCliOptions = {
    catalog: DEFAULT_CATALOG_PATH,
    history: DEFAULT_HISTORY_DIR,
    out: DEFAULT_OUT_DIR,
    base: DEFAULT_BASE,
    siteUrl: DEFAULT_SITE_URL,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    const takeValue = (): string => {
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) throw new Error(`${flag} requires a value`);
        return inlineValue;
      }
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      return next;
    };

    switch (flag) {
      case '--catalog':
        options.catalog = takeValue();
        break;
      case '--history':
        options.history = takeValue();
        break;
      case '--out':
        options.out = takeValue();
        break;
      case '--base':
        options.base = takeValue();
        break;
      case '--site-url':
        options.siteUrl = takeValue();
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

  const catalog = await loadCatalog(options.catalog);
  // A missing history directory is normal before the first sweep: every
  // server then renders as untested rather than failing the build.
  const { histories } = await loadHistoryDir(options.history);

  const pages = buildPages(catalog, histories, {
    base: options.base,
    siteUrl: options.siteUrl,
    generatedAt: new Date().toISOString(),
  });

  await mkdir(options.out, { recursive: true });
  for (const page of pages) {
    const target = join(options.out, ...page.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, page.html, 'utf8');
  }
  await writeFile(join(options.out, '.nojekyll'), '', 'utf8');

  process.stderr.write(
    `site: ${catalog.servers.length} servers, ${histories.size} with history, ` +
      `${pages.length} pages -> ${options.out}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
