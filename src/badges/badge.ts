/**
 * Shields.io endpoint badges derived from a server's history.
 *
 * One badge per platform plus an overall badge, all built from the *latest*
 * entry of each platform (histories are stored newest-first, see types.ts).
 * The message names the phase that broke, because "failing" alone tells a
 * maintainer nothing: `install fails` and `handshake fails` are different bugs.
 */

import { PLATFORMS } from '../history/platforms.js';
import type { Platform, ProbeStatus, ServerHistory, ShieldsBadge } from '../types.js';

export const BADGE_LABEL = 'does it install';
export const BADGE_CACHE_SECONDS = 3600;

interface BadgeFace {
  message: string;
  color: string;
}

const UNTESTED: BadgeFace = { message: 'untested', color: 'lightgrey' };

const STATUS_FACES: Record<ProbeStatus, BadgeFace> = {
  pass: { message: 'passing', color: 'brightgreen' },
  install_failed: { message: 'install fails', color: 'red' },
  spawn_failed: { message: "won't start", color: 'red' },
  connect_failed: { message: 'unreachable', color: 'red' },
  handshake_failed: { message: 'handshake fails', color: 'red' },
  needs_auth: { message: 'needs credentials', color: 'yellow' },
  needs_config: { message: 'needs configuration', color: 'yellow' },
  tools_failed: { message: 'tools/list fails', color: 'red' },
  timeout: { message: 'times out', color: 'red' },
  skipped: UNTESTED,
};

/**
 * Worst-wins ranking for the overall badge, ordered by how early the probe
 * died: the earlier it broke, the more broken the server is. `needs_auth` and
 * `needs_config` outrank `pass` on purpose, since neither is evidence of health;
 * they sit next to each other because they are the same kind of answer, "it
 * wanted something only a user can give it". `timeout` sits with the phase it
 * most often hides (a spawn that never finishes handshaking). `skipped` keeps a
 * slot so the table stays total, but never reaches the reduce: `overallBadge`
 * drops untested platforms first.
 */
const SEVERITY: Record<ProbeStatus, number> = {
  pass: 0,
  needs_auth: 1,
  needs_config: 2,
  skipped: 3,
  tools_failed: 4,
  handshake_failed: 5,
  timeout: 6,
  connect_failed: 7,
  spawn_failed: 8,
  install_failed: 9,
};

export interface BadgeSet {
  overall: ShieldsBadge;
  perPlatform: Record<Platform, ShieldsBadge>;
}

/** Platforms this server has at least one recorded probe for. */
export function platformsWithData(history: ServerHistory | undefined): Platform[] {
  if (!history) return [];
  return PLATFORMS.filter((platform) => (history.platforms[platform]?.length ?? 0) > 0);
}

/** The badge for one status; `undefined` (never probed) reads as untested. */
export function badgeForStatus(status: ProbeStatus | undefined): ShieldsBadge {
  return toBadge(status === undefined ? UNTESTED : STATUS_FACES[status]);
}

/**
 * Overall + per-platform badges. Platforms with no data, and platforms whose
 * latest probe was `skipped`, are rendered untested and ignored by the overall
 * verdict; a server that passes somewhere and fails somewhere else gets an
 * orange "failing on n/m platforms" badge rather than a red one that would hide
 * the working platforms.
 */
export function badgeForHistory(history: ServerHistory | undefined): BadgeSet {
  const latest = new Map<Platform, ProbeStatus>();
  for (const platform of platformsWithData(history)) {
    const status = history?.platforms[platform]?.[0]?.status;
    if (status !== undefined) latest.set(platform, status);
  }

  const perPlatform: Record<Platform, ShieldsBadge> = {
    linux: badgeForStatus(latest.get('linux')),
    darwin: badgeForStatus(latest.get('darwin')),
    win32: badgeForStatus(latest.get('win32')),
  };

  return { overall: overallBadge([...latest.values()]), perPlatform };
}

/**
 * The verdict over the platforms that actually have a result.
 *
 * `skipped` platforms are dropped before anything is counted, denominator
 * included: a skip says "we did not test here", never "it might be broken
 * here". Containers are probeable only where the runner can run Linux images,
 * and a runner without `uv` skips PyPI, so treating a skip as a veto would let
 * a macOS runner grey out what Linux proved. Every platform skipped, or none
 * recorded at all, leaves nothing to judge and the badge reads untested.
 */
function overallBadge(statuses: readonly ProbeStatus[]): ShieldsBadge {
  const judged = statuses.filter((status) => status !== 'skipped');
  if (judged.length === 0) return badgeForStatus(undefined);

  const failing = judged.filter(isFailure).length;
  const passing = judged.filter((status) => status === 'pass').length;
  if (failing > 0 && passing > 0) {
    return toBadge({
      message: `failing on ${failing}/${judged.length} platforms`,
      color: 'orange',
    });
  }

  // A platform that passed proves the server works, and `needs_auth` or
  // `needs_config` elsewhere is the expected result of probing a server without
  // the credentials or arguments only its user has, so the pass wins outright
  // instead of losing to either in the worst-wins reduce below.
  if (passing > 0 && failing === 0) return badgeForStatus('pass');

  const worst = judged.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
  return badgeForStatus(worst);
}

/**
 * None of `skipped`, `needs_auth` and `needs_config` is a failure: in the first
 * case we never got far enough to know, in the other two the server was gated on
 * credentials or arguments the harness does not have rather than broken (see the
 * ProbeStatus doc in types.ts).
 */
function isFailure(status: ProbeStatus): boolean {
  return (
    status !== 'pass' && status !== 'skipped' && status !== 'needs_auth' && status !== 'needs_config'
  );
}

function toBadge(face: BadgeFace): ShieldsBadge {
  return {
    schemaVersion: 1,
    label: BADGE_LABEL,
    message: face.message,
    color: face.color,
    cacheSeconds: BADGE_CACHE_SECONDS,
  };
}
