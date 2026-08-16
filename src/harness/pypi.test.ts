import { describe, expect, it, vi } from 'vitest';
import type { PackageSpec } from '../types.js';
import { DEFAULT_TIMEOUTS } from './options.js';
import { buildUvArgs, parseUvExecutableHint, probePypi, type StdioProbe } from './pypi.js';
import type { StdioOutcome } from './stdio.js';

const spec = (overrides: Partial<PackageSpec> = {}): PackageSpec => ({
  kind: 'pypi',
  identifier: 'mcp-server-git',
  env: [],
  ...overrides
});

/**
 * Verbatim stderr of `uv tool run --from python-dotenv python-dotenv`, which is
 * exactly the shape of the invocation the probe guesses wrong: a distribution
 * whose console script goes by another name.
 */
const REAL_UV_HINT = [
  'Installed 1 package in 2ms',
  'An executable named `python-dotenv` is not provided by package `python-dotenv`.',
  'The following executables are available:',
  '- dotenv',
  '',
  'Use `uv tool run --from python-dotenv dotenv` instead.',
  ''
].join('\n');

const failed = (status: 'spawn_failed' | 'handshake_failed', errorExcerpt: string): StdioOutcome => ({
  status,
  phases: { spawn: { ok: true, durationMs: 12 }, handshake: { ok: false, durationMs: 30, detail: 'exited' } },
  errorExcerpt
});

const passed: StdioOutcome = {
  status: 'pass',
  phases: { spawn: { ok: true, durationMs: 5 }, handshake: { ok: true, durationMs: 6 }, listTools: { ok: true, durationMs: 7 } },
  toolCount: 2,
  toolNames: ['a', 'b']
};

/** A stdio seam that answers each call from a queue and records its argv. */
function stdioQueue(...outcomes: StdioOutcome[]) {
  const calls: string[][] = [];
  const probe = vi.fn<StdioProbe>((_command, args) => {
    calls.push(args);
    return Promise.resolve(outcomes[calls.length - 1] ?? outcomes[outcomes.length - 1] ?? passed);
  });
  return { probe, calls };
}

describe('buildUvArgs', () => {
  it('runs the console script out of an ephemeral environment', () => {
    expect(buildUvArgs(spec())).toEqual(['tool', 'run', '--from', 'mcp-server-git', 'mcp-server-git']);
  });

  it('pins the version and passes package arguments through', () => {
    expect(buildUvArgs(spec({ version: '0.6.2', packageArguments: ['--repository', '.'] }))).toEqual([
      'tool',
      'run',
      '--from',
      'mcp-server-git==0.6.2',
      'mcp-server-git',
      '--repository',
      '.'
    ]);
  });

  it('keeps --from on the distribution while swapping in a corrected script', () => {
    expect(buildUvArgs(spec({ identifier: 'codeweaver-mcp', version: '1.0' }), 'codeweaver')).toEqual([
      'tool',
      'run',
      '--from',
      'codeweaver-mcp==1.0',
      'codeweaver'
    ]);
  });
});

describe('parseUvExecutableHint', () => {
  it('reads the executable out of the real uv error message', () => {
    expect(parseUvExecutableHint(REAL_UV_HINT)).toBe('dotenv');
  });

  it('takes the first of several listed executables', () => {
    const hint = 'The following executables are available:\n- git-mcp\n- git-mcp-admin\n';
    expect(parseUvExecutableHint(hint)).toBe('git-mcp');
  });

  it('survives the excerpt label and stderr the harness wraps around the hint', () => {
    const excerpt = [
      'handshake failed: connection closed',
      '--- stderr (tail) ---',
      'An executable named `x` is not provided by package `y`.',
      'The following executables are available:',
      '  - y-server  '
    ].join('\n');

    expect(parseUvExecutableHint(excerpt)).toBe('y-server');
  });

  it('gives up when the excerpt cap truncated the hint away', () => {
    // buildExcerpt keeps the newest characters, so a long-running server pushes
    // the header out of the excerpt before the list goes.
    const truncated = '…he following executables are available:\n- dotenv\n';
    expect(parseUvExecutableHint(truncated)).toBeUndefined();

    // Truncated the other way: the header survived, the list did not.
    expect(parseUvExecutableHint('The following executables are available:')).toBeUndefined();
    expect(parseUvExecutableHint('The following executables are available:\n')).toBeUndefined();
  });

  it.each([
    ['nothing at all', undefined],
    ['an empty string', ''],
    ['ordinary stderr', 'Traceback (most recent call last):\n  File "x.py"\nValueError: boom'],
    ['a package that simply crashed', 'error: Failed to spawn: `mcp-server-git`\n- not a list\n']
  ])('reports no hint in %s', (_label, stderr) => {
    expect(parseUvExecutableHint(stderr)).toBeUndefined();
  });

  it.each([
    ['a shell fragment', '- ; rm -rf /'],
    ['a path escape', '- ../../../bin/sh'],
    ['a uv flag', '- --python'],
    ['a name with a space', '- dotenv mcp']
  ])('refuses %s that would not be a plain script name', (_label, item) => {
    expect(parseUvExecutableHint(`The following executables are available:\n${item}\n`)).toBeUndefined();
  });

  it('skips an unusable entry and takes the next safe one', () => {
    const hint = 'The following executables are available:\n- --python\n- dotenv\n';
    expect(parseUvExecutableHint(hint)).toBe('dotenv');
  });

  it('stops at the end of the list instead of scanning the rest of stderr', () => {
    const hint = 'The following executables are available:\nhint: run `uv tool list`\n- dotenv\n';
    expect(parseUvExecutableHint(hint)).toBeUndefined();
  });
});

describe('probePypi', () => {
  const context = { workDir: '/does/not/matter', timeouts: DEFAULT_TIMEOUTS, env: {} };

  it('skips, never fails, when the runner has no uv', async () => {
    const outcome = await probePypi(spec(), context, () => false);

    expect(outcome.method).toBe('pypi');
    expect(outcome.status).toBe('skipped');
    expect(outcome.phases.install?.detail).toBe('uv not available');
    expect(outcome.errorExcerpt).toContain('uv not available on PATH');
  });

  it('refuses a malformed identifier before running uv', async () => {
    const outcome = await probePypi(spec({ identifier: 'evil package' }), context, () => true);
    expect(outcome.status).toBe('skipped');
    expect(outcome.errorExcerpt).toContain('malformed pypi identifier');
  });

  it('refuses an identifier containing a path separator', async () => {
    // `--from acme/mcp-server-git` would be read as a local path, not a name.
    const outcome = await probePypi(spec({ identifier: 'acme/mcp-server-git' }), context, () => true);
    expect(outcome.status).toBe('skipped');
    expect(outcome.errorExcerpt).toContain('malformed pypi identifier');
  });

  it('runs uv once and reports the result when the guessed script exists', async () => {
    const { probe, calls } = stdioQueue(passed);

    const outcome = await probePypi(spec(), context, () => true, probe);

    expect(outcome).toMatchObject({ method: 'pypi', status: 'pass', toolCount: 2 });
    expect(calls).toEqual([['tool', 'run', '--from', 'mcp-server-git', 'mcp-server-git']]);
  });

  it('retries with the executable uv named, and keeps the retry verdict', async () => {
    const { probe, calls } = stdioQueue(failed('handshake_failed', REAL_UV_HINT), passed);

    const outcome = await probePypi(
      spec({ identifier: 'python-dotenv', version: '0.3.0', packageArguments: ['--stdio'] }),
      context,
      () => true,
      probe
    );

    expect(outcome).toMatchObject({ method: 'pypi', status: 'pass', toolCount: 2 });
    expect(calls).toEqual([
      ['tool', 'run', '--from', 'python-dotenv==0.3.0', 'python-dotenv', '--stdio'],
      // Same distribution, corrected script, arguments intact.
      ['tool', 'run', '--from', 'python-dotenv==0.3.0', 'dotenv', '--stdio']
    ]);
  });

  it('retries a spawn failure the same way as a handshake failure', async () => {
    const hint = 'An executable named `x` is not provided by package `x`.\nThe following executables are available:\n- x-server\n';
    const { probe, calls } = stdioQueue(failed('spawn_failed', hint), passed);

    const outcome = await probePypi(spec({ identifier: 'x' }), context, () => true, probe);

    expect(outcome.status).toBe('pass');
    expect(calls[1]).toEqual(['tool', 'run', '--from', 'x', 'x-server']);
  });

  it('reports the retry when it fails too, since its stderr is the real one', async () => {
    const { probe, calls } = stdioQueue(
      failed('handshake_failed', REAL_UV_HINT),
      failed('handshake_failed', 'ValueError: DOTENV_TOKEN is required')
    );

    const outcome = await probePypi(spec({ identifier: 'python-dotenv' }), context, () => true, probe);

    expect(outcome.status).toBe('handshake_failed');
    expect(outcome.errorExcerpt).toContain('DOTENV_TOKEN is required');
    expect(outcome.errorExcerpt).not.toContain('is not provided by package');
    expect(calls).toHaveLength(2);
  });

  it('falls back to the first excerpt when the retry recorded none', async () => {
    const { probe } = stdioQueue(failed('handshake_failed', REAL_UV_HINT), {
      status: 'handshake_failed',
      phases: {}
    });

    const outcome = await probePypi(spec({ identifier: 'python-dotenv' }), context, () => true, probe);

    expect(outcome.status).toBe('handshake_failed');
    expect(outcome.errorExcerpt).toContain('is not provided by package');
  });

  it('does not retry when the failure carries no executable hint', async () => {
    const { probe, calls } = stdioQueue(failed('handshake_failed', 'ModuleNotFoundError: no module named mcp'));

    const outcome = await probePypi(spec(), context, () => true, probe);

    expect(outcome.status).toBe('handshake_failed');
    expect(calls).toHaveLength(1);
  });

  it('does not retry the command it already ran', async () => {
    // A hint naming the script we guessed would buy a second identical run.
    const hint = 'The following executables are available:\n- mcp-server-git\n';
    const { probe, calls } = stdioQueue(failed('spawn_failed', hint));

    await probePypi(spec(), context, () => true, probe);

    expect(calls).toHaveLength(1);
  });

  it.each<StdioOutcome['status']>(['install_failed', 'tools_failed', 'timeout'])(
    'does not retry a %s, whatever the stderr says',
    async status => {
      const { probe, calls } = stdioQueue({ status, phases: {}, errorExcerpt: REAL_UV_HINT });

      const outcome = await probePypi(spec(), context, () => true, probe);

      expect(outcome.status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  );

  it('gives the download the install budget on top of the handshake budget', async () => {
    const probe = vi.fn<StdioProbe>(() => Promise.resolve(passed));

    await probePypi(spec(), context, () => true, probe);

    expect(probe).toHaveBeenCalledWith('uv', expect.any(Array), {}, {
      spawn: DEFAULT_TIMEOUTS.spawn,
      handshake: DEFAULT_TIMEOUTS.install + DEFAULT_TIMEOUTS.handshake,
      listTools: DEFAULT_TIMEOUTS.listTools
    });
  });
});
