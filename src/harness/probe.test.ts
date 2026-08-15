import { describe, expect, it } from 'vitest';
import {
  ENV_PLACEHOLDER,
  type EnvVarSpec,
  type PackageSpec,
  type ProbeStatus,
  type RemoteSpec,
  type ServerEntry
} from '../types.js';
import type { ProbeOutcome } from './outcome.js';
import { probeServer, reclassifyGatedByCredentials, resolveEnv, selectDistribution } from './probe.js';

const entry = (overrides: Partial<ServerEntry> = {}): ServerEntry => ({
  id: 'io.github.acme/server',
  slug: 'io.github.acme__server',
  title: 'Acme server',
  packages: [],
  remotes: [],
  source: 'registry',
  rank: 1,
  ...overrides
});

const pkg = (kind: PackageSpec['kind'], identifier: string): PackageSpec => ({ kind, identifier, env: [] });
const remote = (type: RemoteSpec['type'], url: string): RemoteSpec => ({ type, url, headers: [] });

describe('selectDistribution', () => {
  it('prefers npm over pypi and remotes', () => {
    const selected = selectDistribution(
      entry({
        packages: [pkg('pypi', 'mcp-server-git'), pkg('npm', '@acme/server')],
        remotes: [remote('streamable-http', 'https://acme.test/mcp')]
      })
    );
    expect(selected).toEqual({ kind: 'npm', pkg: pkg('npm', '@acme/server') });
  });

  it('falls back to pypi when there is no npm package', () => {
    const selected = selectDistribution(
      entry({ packages: [pkg('oci', 'ghcr.io/acme/server'), pkg('pypi', 'mcp-server-git')] })
    );
    expect(selected).toEqual({ kind: 'pypi', pkg: pkg('pypi', 'mcp-server-git') });
  });

  it('falls back to a container when there is no npm or pypi package', () => {
    const selected = selectDistribution(
      entry({
        packages: [pkg('oci', 'ghcr.io/acme/server')],
        remotes: [remote('streamable-http', 'https://acme.test/mcp')]
      })
    );
    // A container is a copy of the server we run ourselves; a remote is
    // somebody else's deployment of it, so the container is the better probe.
    expect(selected).toEqual({ kind: 'oci', pkg: pkg('oci', 'ghcr.io/acme/server') });
  });

  it('prefers streamable-http over legacy sse regardless of order', () => {
    const selected = selectDistribution(
      entry({
        remotes: [remote('sse', 'https://acme.test/sse'), remote('streamable-http', 'https://acme.test/mcp')]
      })
    );
    expect(selected).toEqual({ kind: 'remote', remote: remote('streamable-http', 'https://acme.test/mcp') });
  });

  it('uses sse when it is the only remote', () => {
    const selected = selectDistribution(entry({ remotes: [remote('sse', 'https://acme.test/sse')] }));
    expect(selected).toEqual({ kind: 'remote', remote: remote('sse', 'https://acme.test/sse') });
  });

  it('honours the method filter', () => {
    const candidate = entry({
      packages: [pkg('npm', '@acme/server'), pkg('oci', 'ghcr.io/acme/server')],
      remotes: [remote('streamable-http', 'https://acme.test/mcp')]
    });
    expect(selectDistribution(candidate, ['remote']).kind).toBe('remote');
    expect(selectDistribution(candidate, ['oci']).kind).toBe('oci');
    expect(selectDistribution(candidate, ['pypi']).kind).toBe('none');
  });

  it('probes the whole order in turn', () => {
    const packages = [pkg('oci', 'ghcr.io/acme/server'), pkg('pypi', 'mcp-server-git'), pkg('npm', '@acme/server')];
    const candidate = entry({ packages, remotes: [remote('streamable-http', 'https://acme.test/mcp')] });

    expect(selectDistribution(candidate).kind).toBe('npm');
    expect(selectDistribution(candidate, ['pypi', 'oci', 'remote']).kind).toBe('pypi');
    expect(selectDistribution(candidate, ['oci', 'remote']).kind).toBe('oci');
    expect(selectDistribution(candidate, ['remote']).kind).toBe('remote');
  });

  it('reports servers with no distribution at all as none', () => {
    expect(selectDistribution(entry())).toEqual({ kind: 'none' });
  });
});

describe('resolveEnv', () => {
  const spec = (overrides: Partial<EnvVarSpec> & { name: string }): EnvVarSpec => ({
    required: false,
    secret: false,
    ...overrides
  });

  it('fills required variables with the placeholder', () => {
    const { env, requiresEnv } = resolveEnv([spec({ name: 'ACME_TOKEN', required: true, secret: true })]);
    expect(env).toEqual({ ACME_TOKEN: ENV_PLACEHOLDER });
    expect(requiresEnv).toEqual(['ACME_TOKEN']);
  });

  it('never forwards a runner variable, secret or not', () => {
    process.env.ACME_REGION = 'eu';
    process.env.ACME_TOKEN = 'real-credential';
    try {
      const { env, requiresEnv } = resolveEnv([
        spec({ name: 'ACME_REGION', required: true }),
        spec({ name: 'ACME_TOKEN', required: true, secret: true })
      ]);
      expect(env).toEqual({ ACME_REGION: ENV_PLACEHOLDER, ACME_TOKEN: ENV_PLACEHOLDER });
      expect(requiresEnv).toEqual(['ACME_REGION', 'ACME_TOKEN']);
    } finally {
      delete process.env.ACME_REGION;
      delete process.env.ACME_TOKEN;
    }
  });

  it('leaves optional variables unset even when the runner has them', () => {
    process.env.ACME_DEBUG = '1';
    try {
      const { env, requiresEnv } = resolveEnv([spec({ name: 'ACME_DEBUG' })]);
      expect(env).toEqual({});
      expect(requiresEnv).toEqual([]);
    } finally {
      delete process.env.ACME_DEBUG;
    }
  });
});

describe('reclassifyGatedByCredentials', () => {
  const outcome = (status: ProbeStatus): ProbeOutcome => ({
    method: 'npm',
    status,
    phases: {
      install: { ok: true, durationMs: 900 },
      spawn: { ok: false, durationMs: 30, detail: 'exited with code 1' }
    },
    errorExcerpt: 'spawn failed: exited with code 1\n--- stderr (tail) ---\nError: invalid ACME_TOKEN'
  });

  it('reads a refusal to start as a missing credential when placeholders were injected', () => {
    expect(reclassifyGatedByCredentials(outcome('spawn_failed'), ['ACME_TOKEN']).status).toBe('needs_auth');
  });

  it('reads a refused handshake the same way', () => {
    expect(reclassifyGatedByCredentials(outcome('handshake_failed'), ['ACME_TOKEN']).status).toBe('needs_auth');
  });

  it('keeps the phases, detail and excerpt that are the evidence', () => {
    const before = outcome('spawn_failed');
    const after = reclassifyGatedByCredentials(before, ['ACME_TOKEN']);

    expect(after).toEqual({ ...before, status: 'needs_auth' });
    expect(after.phases.spawn?.detail).toBe('exited with code 1');
    expect(after.errorExcerpt).toContain('invalid ACME_TOKEN');
  });

  it('leaves a server that declared no required variables alone', () => {
    expect(reclassifyGatedByCredentials(outcome('spawn_failed'), [])).toEqual(outcome('spawn_failed'));
    expect(reclassifyGatedByCredentials(outcome('handshake_failed'), []).status).toBe('handshake_failed');
  });

  it.each<ProbeStatus>(['install_failed', 'tools_failed', 'timeout', 'pass', 'skipped'])(
    'leaves %s alone even with placeholders in play',
    status => {
      expect(reclassifyGatedByCredentials(outcome(status), ['ACME_TOKEN']).status).toBe(status);
    }
  );
});

describe('probeServer', () => {
  it('skips servers with nothing probeable and still fills the result', async () => {
    const result = await probeServer(entry(), { platform: 'linux' });

    expect(result).toMatchObject({
      serverId: 'io.github.acme/server',
      slug: 'io.github.acme__server',
      platform: 'linux',
      method: 'none',
      status: 'skipped',
      phases: {}
    });
    expect(Date.parse(result.startedAt)).not.toBeNaN();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // A malformed reference is refused before anything reaches docker, so these
  // two prove the routing without a daemon on the machine running the tests.
  it('routes container-only servers through the oci probe', async () => {
    const result = await probeServer(entry({ packages: [pkg('oci', 'Not An Image')] }), { platform: 'linux' });

    expect(result.method).toBe('oci');
    expect(result.status).toBe('skipped');
    expect(result.errorExcerpt).toContain('malformed oci image reference');
  });

  it('fills a container probe with placeholder credentials like any other package', async () => {
    const result = await probeServer(
      entry({
        packages: [
          {
            kind: 'oci',
            identifier: 'Not An Image',
            env: [{ name: 'ACME_TOKEN', required: true, secret: true }]
          }
        ]
      }),
      { platform: 'linux' }
    );

    expect(result.method).toBe('oci');
    expect(result.requiresEnv).toEqual(['ACME_TOKEN']);
  });

  it('installs nothing when the method filter excludes the distribution', async () => {
    const result = await probeServer(entry({ packages: [pkg('npm', '@acme/server')] }), {
      platform: 'linux',
      methods: ['remote']
    });
    expect(result.status).toBe('skipped');
    expect(result.method).toBe('none');
  });

  it('records declared remote headers as requiresEnv', async () => {
    const result = await probeServer(
      entry({
        remotes: [
          {
            type: 'streamable-http',
            url: 'not-a-url',
            headers: [{ name: 'Authorization', required: true, secret: true }]
          }
        ]
      }),
      { platform: 'linux' }
    );

    expect(result.method).toBe('remote-http');
    expect(result.status).toBe('connect_failed');
    expect(result.requiresEnv).toEqual(['Authorization']);
    expect(result.errorExcerpt).toContain('not a valid URL');
  });
});
