/**
 * End-to-end container probe. Run with `npm run test:smoke`.
 *
 * Only the official reference image is pulled here, for the same reason the npm
 * smoke test installs only `@modelcontextprotocol` packages: a smoke test must
 * never execute arbitrary third-party code on a developer's machine. It needs a
 * network and a reachable daemon, so the suite skips itself when
 * `docker version` fails, which is the normal answer on macOS and Windows.
 */
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { slugify, type ServerEntry } from '../types.js';
import { isDockerAvailable } from './oci.js';
import { probeServer } from './probe.js';

const IMAGE = 'mcp/everything';

const entry = (): ServerEntry => ({
  id: 'smoke/everything-container',
  slug: slugify('smoke/everything-container'),
  title: IMAGE,
  packages: [{ kind: 'oci', identifier: IMAGE, transport: 'stdio', env: [] }],
  remotes: [],
  source: 'seed',
  rank: 1
});

describe.skipIf(!isDockerAvailable())('probeServer against a container image', () => {
  afterAll(() => {
    spawnSync('docker', ['rmi', '-f', IMAGE], { stdio: 'ignore' });
  });

  it('pulls, runs, handshakes and lists the tools of the reference image', async () => {
    const result = await probeServer(entry());

    expect(result.errorExcerpt).toBeUndefined();
    expect(result.method).toBe('oci');
    expect(result.status).toBe('pass');
    expect(result.phases.install?.ok).toBe(true);
    expect(result.phases.handshake?.ok).toBe(true);
    expect(result.toolCount ?? 0).toBeGreaterThan(0);
    expect(result.serverInfo?.name).toBeTruthy();
  });

  it('leaves no container behind', () => {
    const ps = spawnSync('docker', ['ps', '-aq', '--filter', 'name=dii-'], { encoding: 'utf8' });
    expect(ps.stdout.trim()).toBe('');
  });
});
