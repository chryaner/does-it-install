import { describe, expect, it } from 'vitest';
import type { PackageSpec } from '../types.js';
import { DEFAULT_TIMEOUTS } from './options.js';
import { buildUvArgs, probePypi } from './pypi.js';

const spec = (overrides: Partial<PackageSpec> = {}): PackageSpec => ({
  kind: 'pypi',
  identifier: 'mcp-server-git',
  env: [],
  ...overrides
});

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
});
