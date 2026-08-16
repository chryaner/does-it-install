import { describe, expect, it } from 'vitest';
import type { PackageSpec } from '../types.js';
import type { CommandResult } from './command.js';
import { buildRunArgs, containerName, probeOci, type OciRuntime } from './oci.js';
import { DEFAULT_TIMEOUTS } from './options.js';
import type { StdioOutcome } from './stdio.js';

const spec = (overrides: Partial<PackageSpec> = {}): PackageSpec => ({
  kind: 'oci',
  identifier: 'ghcr.io/acme/server:1.2.3',
  env: [],
  ...overrides
});

const context = { workDir: '/does/not/matter', timeouts: DEFAULT_TIMEOUTS, env: {} };

const commandResult = (overrides: Partial<CommandResult> = {}): CommandResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...overrides
});

const passing: StdioOutcome = {
  status: 'pass',
  phases: { spawn: { ok: true, durationMs: 5 }, handshake: { ok: true, durationMs: 6 }, listTools: { ok: true, durationMs: 7 } },
  toolCount: 1,
  toolNames: ['ping']
};

/** Stands in for the docker CLI: records every call, answers what it is told to. */
class FakeDocker implements OciRuntime {
  available = true;
  pullResult: CommandResult = commandResult();
  outcome: StdioOutcome = passing;
  sessionError: Error | undefined;

  readonly calls: string[][] = [];
  sessionArgs: string[] | undefined;
  sessionEnv: Record<string, string> | undefined;

  dockerAvailable(): boolean {
    return this.available;
  }

  run(args: string[], _timeoutMs: number): Promise<CommandResult> {
    this.calls.push(args);
    return Promise.resolve(args[0] === 'pull' ? this.pullResult : commandResult());
  }

  session(args: string[], env: Record<string, string>): Promise<StdioOutcome> {
    this.sessionArgs = args;
    this.sessionEnv = env;
    if (this.sessionError) return Promise.reject(this.sessionError);
    return Promise.resolve(this.outcome);
  }
}

/** The `--name` the probe gave the container it just ran. */
function nameOf(docker: FakeDocker): string | undefined {
  const args = docker.sessionArgs ?? [];
  return args[args.indexOf('--name') + 1];
}

describe('image reference validation', () => {
  it.each([
    'alpine',
    'mcp/server',
    'acme/server:1.2.3',
    'ghcr.io/acme/mcp-server:v1.2.3-beta.1',
    'registry.example.com:5000/acme/nested/server',
    `docker.io/acme/server@sha256:${'a'.repeat(64)}`,
    'ghcr.io/acme/server:1.0@sha256:' + 'f'.repeat(64)
  ])('accepts %s', async image => {
    const docker = new FakeDocker();
    const outcome = await probeOci(spec({ identifier: image }), context, docker);

    expect(outcome.status).toBe('pass');
    expect(docker.calls[0]).toEqual(['pull', image]);
  });

  it.each([
    'Acme/Server', // uppercase path segments are not a valid reference
    'acme/ server',
    'evil; rm -rf /',
    '--privileged',
    '-i',
    'acme/server:bad tag',
    'acme/server@md5:0123456789abcdef',
    'acme/server@sha256:nothex',
    'localhost:5000/acme/server', // no dot: reads as a path segment, not a host
    ''
  ])('refuses %s before anything reaches docker', async image => {
    const docker = new FakeDocker();
    const outcome = await probeOci(spec({ identifier: image }), context, docker);

    expect(outcome.method).toBe('oci');
    expect(outcome.status).toBe('skipped');
    expect(outcome.errorExcerpt).toContain('malformed oci image reference');
    expect(docker.calls).toEqual([]);
    expect(docker.sessionArgs).toBeUndefined();
  });
});

describe('probeOci', () => {
  it('skips, never fails, when the runner has no docker', async () => {
    const docker = new FakeDocker();
    docker.available = false;

    const outcome = await probeOci(spec(), context, docker);

    expect(outcome.method).toBe('oci');
    expect(outcome.status).toBe('skipped');
    expect(outcome.phases.install?.detail).toBe('docker not available on this runner');
    expect(outcome.errorExcerpt).toContain('docker not available on this runner');
    expect(docker.calls).toEqual([]);
  });

  it('records a failed pull as install_failed, with the docker output', async () => {
    const docker = new FakeDocker();
    docker.pullResult = commandResult({ code: 1, stderr: 'Error response from daemon: manifest unknown' });

    const outcome = await probeOci(spec(), context, docker);

    expect(outcome.status).toBe('install_failed');
    expect(outcome.phases.install?.ok).toBe(false);
    expect(outcome.phases.install?.detail).toBe('docker pull ghcr.io/acme/server:1.2.3 exited with code 1');
    expect(outcome.errorExcerpt).toContain('manifest unknown');
    expect(docker.sessionArgs).toBeUndefined();
  });

  it('records a pull that ran out of budget as timeout', async () => {
    const docker = new FakeDocker();
    docker.pullResult = commandResult({ code: null, timedOut: true });

    const outcome = await probeOci(spec(), context, docker);

    expect(outcome.status).toBe('timeout');
    expect(outcome.phases.install?.detail).toContain('timed out after 600s');
  });

  it('reports a docker CLI that will not run at all as install_failed', async () => {
    const docker = new FakeDocker();
    docker.pullResult = commandResult({ code: null, spawnError: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) });

    const outcome = await probeOci(spec(), context, docker);

    expect(outcome.status).toBe('install_failed');
    expect(outcome.errorExcerpt).toContain('cannot run docker');
  });

  it('runs the pulled image with a unique name and no second pull', async () => {
    const docker = new FakeDocker();
    await probeOci(spec({ packageArguments: ['--repository', '/data'] }), context, docker);

    const name = nameOf(docker);
    expect(name).toMatch(/^dii-/);
    expect(docker.sessionArgs).toEqual([
      'run',
      '-i',
      '--rm',
      '--pull=never',
      '--memory',
      '2g',
      '--pids-limit',
      '512',
      '--name',
      name,
      'ghcr.io/acme/server:1.2.3',
      '--repository',
      '/data'
    ]);
  });

  it('passes declared environment variables into the container as -e pairs', async () => {
    const docker = new FakeDocker();
    const env = { ACME_TOKEN: 'PLACEHOLDER', ACME_REGION: 'eu' };

    await probeOci(spec(), { ...context, env }, docker);

    const args = docker.sessionArgs ?? [];
    expect(args.slice(args.indexOf('-e'), args.indexOf('ghcr.io/acme/server:1.2.3'))).toEqual([
      '-e',
      'ACME_TOKEN=PLACEHOLDER',
      '-e',
      'ACME_REGION=eu'
    ]);
    // The docker client's own environment is not the container's: the
    // placeholders travel by flag, never by inheritance.
    expect(docker.sessionEnv).not.toHaveProperty('ACME_TOKEN');
  });

  it('keeps the install phase alongside the phases the session recorded', async () => {
    const docker = new FakeDocker();
    const outcome = await probeOci(spec(), context, docker);

    expect(outcome.method).toBe('oci');
    expect(outcome.status).toBe('pass');
    expect(outcome.phases.install?.ok).toBe(true);
    expect(outcome.phases.handshake?.ok).toBe(true);
    expect(outcome.toolNames).toEqual(['ping']);
  });

  it('force-removes the container after a passing probe', async () => {
    const docker = new FakeDocker();
    await probeOci(spec(), context, docker);

    expect(docker.calls).toEqual([['pull', 'ghcr.io/acme/server:1.2.3'], ['rm', '-f', nameOf(docker)]]);
  });

  it('force-removes the container after a failed probe too', async () => {
    const docker = new FakeDocker();
    docker.outcome = { status: 'handshake_failed', phases: { spawn: { ok: true, durationMs: 4 } }, errorExcerpt: 'no' };

    const outcome = await probeOci(spec(), context, docker);

    expect(outcome.status).toBe('handshake_failed');
    expect(docker.calls.at(-1)).toEqual(['rm', '-f', nameOf(docker)]);
  });

  it('force-removes the container even when the session throws', async () => {
    const docker = new FakeDocker();
    docker.sessionError = new Error('transport exploded');

    await expect(probeOci(spec(), context, docker)).rejects.toThrow('transport exploded');
    expect(docker.calls.at(-1)).toEqual(['rm', '-f', nameOf(docker)]);
  });

  it('lets a failed teardown pass, since it is not a verdict on the server', async () => {
    const docker = new FakeDocker();
    docker.run = (args: string[]) => {
      docker.calls.push(args);
      return args[0] === 'rm' ? Promise.reject(new Error('daemon gone')) : Promise.resolve(commandResult());
    };

    const outcome = await probeOci(spec(), context, docker);

    expect(outcome.status).toBe('pass');
    expect(docker.calls.at(-1)).toEqual(['rm', '-f', nameOf(docker)]);
  });
});

describe('buildRunArgs', () => {
  it('keeps stdin open, cleans up and never pulls again', () => {
    expect(buildRunArgs('alpine', 'dii-1', {})).toEqual([
      'run',
      '-i',
      '--rm',
      '--pull=never',
      '--memory',
      '2g',
      '--pids-limit',
      '512',
      '--name',
      'dii-1',
      'alpine'
    ]);
  });

  it('puts every flag before the image and every server argument after it', () => {
    expect(buildRunArgs('alpine', 'dii-1', { A: '1' }, ['--verbose'])).toEqual([
      'run',
      '-i',
      '--rm',
      '--pull=never',
      '--memory',
      '2g',
      '--pids-limit',
      '512',
      '--name',
      'dii-1',
      '-e',
      'A=1',
      'alpine',
      '--verbose'
    ]);
  });

  it('caps memory and process count, so one bad image cannot take the runner down', () => {
    const args = buildRunArgs('alpine', 'dii-1', { A: '1' }, ['--verbose']);
    const image = args.indexOf('alpine');

    // Both limits are `docker run` flags, so both have to sit before the image.
    expect(args[args.indexOf('--memory') + 1]).toBe('2g');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('512');
    expect(args.indexOf('--memory')).toBeLessThan(image);
    expect(args.indexOf('--pids-limit')).toBeLessThan(image);
  });
});

describe('containerName', () => {
  it('is unique and safe for docker', () => {
    const first = containerName();
    expect(first).not.toBe(containerName());
    expect(first).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });
});
