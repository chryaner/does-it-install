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
  tools_failed: { message: 'tools/list fails', color: 'red' },
  timeout: { message: 'times out', color: 'red' },
  skipped: UNTESTED,
};

/**
 * Worst-wins ranking for the overall badge, ordered by how early the probe
 * died: the earlier it broke, the more broken the server is. `skipped` outranks
 * `pass` on purpose — a platform we could not test is not evidence of health.
 * `timeout` sits with the phase it most often hides (a spawn that never
 * finishes handshaking).
 */
const SEVERITY: Record<ProbeStatus, number> = {
  pass: 0,
  skipped: 1,
  tools_failed: 2,
  handshake_failed: 3,
  timeout: 4,
  connect_failed: 5,
  spawn_failed: 6,
  install_failed: 7,
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
 * Overall + per-platform badges. Platforms with no data are rendered untested
 * and are ignored by the overall verdict; a server that passes somewhere and
 * fails somewhere else gets an orange "failing on n/m platforms" badge rather
 * than a red one that would hide the working platforms.
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

function overallBadge(statuses: readonly ProbeStatus[]): ShieldsBadge {
  if (statuses.length === 0) return badgeForStatus(undefined);

  const failing = statuses.filter(isFailure).length;
  const passing = statuses.filter((status) => status === 'pass').length;
  if (failing > 0 && passing > 0) {
    return toBadge({
      message: `failing on ${failing}/${statuses.length} platforms`,
      color: 'orange',
    });
  }

  const worst = statuses.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
  return badgeForStatus(worst);
}

/** `skipped` is not a failure — we never got far enough to know. */
function isFailure(status: ProbeStatus): boolean {
  return status !== 'pass' && status !== 'skipped';
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
