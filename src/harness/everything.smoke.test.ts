/**
 * End-to-end probes that really install from npm. Run with `npm run test:smoke`.
 *
 * Only the official @modelcontextprotocol packages from data/seed.json are
 * installed here, because a smoke test must never execute arbitrary
 * third-party code on a developer's machine.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { slugify, type ServerEntry } from '../types.js';
import { probeServer } from './probe.js';

const workDir = path.join(os.tmpdir(), 'does-it-install-smoke');

const seedEntry = (identifier: string, packageArguments?: string[]): ServerEntry => {
  const id = `seed/${identifier.split('/').pop() ?? identifier}`;
  return {
    id,
    slug: slugify(id),
    title: identifier,
    packages: [
      { kind: 'npm', identifier, transport: 'stdio', env: [], ...(packageArguments ? { packageArguments } : {}) }
    ],
    remotes: [],
    source: 'seed',
    rank: 1
  };
};

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('probeServer against the official reference servers', () => {
  it('installs, initializes and lists the tools of server-everything', async () => {
    const result = await probeServer(seedEntry('@modelcontextprotocol/server-everything'), { workDir });

    expect(result.errorExcerpt).toBeUndefined();
    expect(result.status).toBe('pass');
    expect(result.method).toBe('npm');
    expect(result.phases.install?.ok).toBe(true);
    expect(result.phases.handshake?.ok).toBe(true);
    expect(result.toolCount ?? 0).toBeGreaterThan(0);
    expect(result.toolNames?.length ?? 0).toBeGreaterThan(0);
    expect(result.serverInfo?.name).toBeTruthy();
  });

  it('passes package arguments through to server-filesystem', async () => {
    const result = await probeServer(seedEntry('@modelcontextprotocol/server-filesystem', ['.']), { workDir });

    expect(result.errorExcerpt).toBeUndefined();
    expect(result.status).toBe('pass');
    expect(result.toolCount ?? 0).toBeGreaterThan(0);
  });
});
