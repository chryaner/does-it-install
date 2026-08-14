import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { probeStdio } from './stdio.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Short budgets: these tests are about failure modes, not patience. */
const TIMEOUTS = { spawn: 5_000, handshake: 2_000, listTools: 2_000 };

const runFixture = (name: string, args: string[] = []) =>
  probeStdio(process.execPath, [fixture(name), ...args], {}, TIMEOUTS);

describe('probeStdio', () => {
  it('passes a well-behaved server and reports its tools', async () => {
    const result = await runFixture('ok-server.mjs');

    expect(result.status).toBe('pass');
    expect(result.toolCount).toBe(1);
    expect(result.toolNames).toEqual(['ping']);
    expect(result.serverInfo).toEqual({ name: 'ok-server', version: '1.2.3' });
    expect(result.phases.spawn?.ok).toBe(true);
    expect(result.phases.handshake?.ok).toBe(true);
    expect(result.phases.listTools?.ok).toBe(true);
    expect(result.errorExcerpt).toBeUndefined();
  });

  it('reports a server that writes garbage to stdout as handshake_failed', async () => {
    const result = await runFixture('garbage-server.mjs');

    expect(result.status).toBe('handshake_failed');
    expect(result.phases.spawn?.ok).toBe(true);
    expect(result.phases.handshake?.ok).toBe(false);
    expect(result.phases.listTools).toBeUndefined();
    // The excerpt must explain *why*: the parse error and the server's stderr.
    expect(result.errorExcerpt).toContain('is not valid JSON');
    expect(result.errorExcerpt).toContain('printed a banner on stdout');
  });

  it('keeps the stderr of a server that dies during startup', async () => {
    const result = await runFixture('stderr-server.mjs');

    expect(result.status).toBe('handshake_failed');
    expect(result.errorExcerpt).toContain('cannot find module "definitely-not-installed"');
    expect(result.errorExcerpt).toContain('giving up');
  });

  it('times out a server that never answers, inside the budget', async () => {
    const startedAt = Date.now();
    const result = await runFixture('hang-server.mjs');
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe('timeout');
    expect(result.phases.handshake?.ok).toBe(false);
    expect(result.phases.handshake?.durationMs).toBeGreaterThanOrEqual(TIMEOUTS.handshake - 100);
    // handshake budget plus teardown, nowhere near the default 30s.
    expect(elapsed).toBeLessThan(12_000);
  });

  it('reports a command that does not exist as spawn_failed', async () => {
    const result = await probeStdio('does-it-install-no-such-command', [], {}, TIMEOUTS);

    expect(result.status).toBe('spawn_failed');
    expect(result.phases.spawn?.ok).toBe(false);
    expect(result.phases.handshake).toBeUndefined();
    expect(result.errorExcerpt).toContain('ENOENT');
  });
});
