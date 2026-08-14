import { describe, expect, it } from 'vitest';
import type { HistoryEntry, Platform, ProbeStatus, ServerHistory } from '../types.js';
import { BADGE_CACHE_SECONDS, BADGE_LABEL, badgeForHistory, platformsWithData } from './badge.js';

function entry(status: ProbeStatus, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    runId: 'run-2',
    date: '2026-08-08T00:00:00.000Z',
    status,
    method: 'npm',
    ...overrides,
  };
}

function history(platforms: Partial<Record<Platform, HistoryEntry[]>>): ServerHistory {
  return { serverId: 'io.github.acme/thing', slug: 'io.github.acme__thing', platforms };
}

const EXPECTED: Record<ProbeStatus, { message: string; color: string }> = {
  pass: { message: 'passing', color: 'brightgreen' },
  install_failed: { message: 'install fails', color: 'red' },
  spawn_failed: { message: "won't start", color: 'red' },
  connect_failed: { message: 'unreachable', color: 'red' },
  handshake_failed: { message: 'handshake fails', color: 'red' },
  tools_failed: { message: 'tools/list fails', color: 'red' },
  timeout: { message: 'times out', color: 'red' },
  skipped: { message: 'untested', color: 'lightgrey' },
};

describe('badgeForHistory', () => {
  it.each(Object.entries(EXPECTED))('maps %s to its message and color', (status, expected) => {
    const { overall, perPlatform } = badgeForHistory(history({ linux: [entry(status as ProbeStatus)] }));

    expect(overall).toEqual({
      schemaVersion: 1,
      label: BADGE_LABEL,
      message: expected.message,
      color: expected.color,
      cacheSeconds: BADGE_CACHE_SECONDS,
    });
    expect(perPlatform.linux).toEqual(overall);
  });

  it('reports untested for a server with no history at all', () => {
    const { overall, perPlatform } = badgeForHistory(undefined);

    expect(overall).toMatchObject({ message: 'untested', color: 'lightgrey' });
    expect(perPlatform.linux).toEqual(overall);
    expect(perPlatform.darwin).toEqual(overall);
    expect(perPlatform.win32).toEqual(overall);
  });

  it('treats an empty platform array as no data', () => {
    const { overall, perPlatform } = badgeForHistory(history({ linux: [] }));

    expect(overall).toMatchObject({ message: 'untested', color: 'lightgrey' });
    expect(perPlatform.linux).toMatchObject({ message: 'untested' });
    expect(platformsWithData(history({ linux: [] }))).toEqual([]);
  });

  it('uses the latest entry, not the older ones', () => {
    const { overall } = badgeForHistory(
      history({
        linux: [
          entry('install_failed', { runId: 'run-3', date: '2026-08-15T00:00:00.000Z' }),
          entry('pass', { runId: 'run-2' }),
        ],
      }),
    );

    expect(overall).toMatchObject({ message: 'install fails', color: 'red' });
  });

  it('leaves platforms without data untested while still badging the ones with data', () => {
    const { perPlatform } = badgeForHistory(history({ linux: [entry('pass')] }));

    expect(perPlatform.linux).toMatchObject({ message: 'passing', color: 'brightgreen' });
    expect(perPlatform.darwin).toMatchObject({ message: 'untested', color: 'lightgrey' });
    expect(perPlatform.win32).toMatchObject({ message: 'untested', color: 'lightgrey' });
  });

  it('goes orange when some platforms pass and others fail', () => {
    const { overall } = badgeForHistory(
      history({
        linux: [entry('pass')],
        darwin: [entry('pass')],
        win32: [entry('install_failed')],
      }),
    );

    expect(overall).toMatchObject({ message: 'failing on 1/3 platforms', color: 'orange' });
  });

  it('counts skipped platforms in the denominator but not as failures', () => {
    const { overall } = badgeForHistory(
      history({
        linux: [entry('pass')],
        darwin: [entry('skipped')],
        win32: [entry('timeout')],
      }),
    );

    expect(overall).toMatchObject({ message: 'failing on 1/3 platforms', color: 'orange' });
  });

  it('reports the worst failure when every platform fails', () => {
    const { overall } = badgeForHistory(
      history({
        linux: [entry('tools_failed')],
        darwin: [entry('install_failed')],
        win32: [entry('timeout')],
      }),
    );

    expect(overall).toMatchObject({ message: 'install fails', color: 'red' });
  });

  it('ranks timeout between handshake_failed and spawn_failed', () => {
    const worse = badgeForHistory(
      history({ linux: [entry('timeout')], darwin: [entry('handshake_failed')] }),
    );
    const worseStill = badgeForHistory(
      history({ linux: [entry('timeout')], darwin: [entry('spawn_failed')] }),
    );

    expect(worse.overall).toMatchObject({ message: 'times out' });
    expect(worseStill.overall).toMatchObject({ message: "won't start" });
  });

  it('stays passing when every platform with data passes', () => {
    const { overall } = badgeForHistory(
      history({ linux: [entry('pass')], win32: [entry('pass')] }),
    );

    expect(overall).toMatchObject({ message: 'passing', color: 'brightgreen' });
  });

  it('reports untested when a passing platform is paired with a skipped one', () => {
    const { overall } = badgeForHistory(
      history({ linux: [entry('pass')], win32: [entry('skipped')] }),
    );

    // Worst-wins: a platform we could not test is not evidence the server works there.
    expect(overall).toMatchObject({ message: 'untested', color: 'lightgrey' });
  });
});

describe('platformsWithData', () => {
  it('lists platforms in reporting order', () => {
    expect(platformsWithData(history({ win32: [entry('pass')], linux: [entry('pass')] }))).toEqual([
      'linux',
      'win32',
    ]);
    expect(platformsWithData(undefined)).toEqual([]);
  });
});
