import { describe, expect, it } from 'vitest';
import type { PackageSpec } from '../types.js';
import { DEFAULT_TIMEOUTS } from './options.js';
import { probeNpm, selectBinEntry, unscopedName } from './npm.js';

describe('unscopedName', () => {
  it('drops the scope', () => {
    expect(unscopedName('@modelcontextprotocol/server-everything')).toBe('server-everything');
    expect(unscopedName('mcp-server')).toBe('mcp-server');
  });
});

describe('selectBinEntry', () => {
  it('accepts a plain string bin', () => {
    expect(selectBinEntry('@acme/server', './dist/index.js')).toBe('./dist/index.js');
  });

  it('prefers the entry named after the package', () => {
    const bin = { 'acme-helper': './helper.js', server: './dist/server.js' };
    expect(selectBinEntry('@acme/server', bin)).toBe('./dist/server.js');
  });

  it('falls back to the first entry when no name matches', () => {
    const bin = { 'acme-cli': './cli.js', 'acme-helper': './helper.js' };
    expect(selectBinEntry('@acme/server', bin)).toBe('./cli.js');
  });

  it('ignores non-string values and missing bins', () => {
    expect(selectBinEntry('@acme/server', { broken: 42, good: './good.js' })).toBe('./good.js');
    expect(selectBinEntry('@acme/server', undefined)).toBeUndefined();
    expect(selectBinEntry('@acme/server', null)).toBeUndefined();
    expect(selectBinEntry('@acme/server', {})).toBeUndefined();
  });
});

describe('probeNpm', () => {
  const context = { workDir: '/does/not/matter', timeouts: DEFAULT_TIMEOUTS, env: {} };
  const spec = (overrides: Partial<PackageSpec>): PackageSpec => ({
    kind: 'npm',
    identifier: '@acme/server',
    env: [],
    ...overrides
  });

  it('refuses to hand a malformed identifier to npm', async () => {
    const outcome = await probeNpm(spec({ identifier: 'evil; rm -rf /' }), context);
    expect(outcome).toEqual({
      method: 'npm',
      status: 'skipped',
      phases: {},
      errorExcerpt: 'refusing to install malformed npm identifier: "evil; rm -rf /"'
    });
  });

  it('refuses a malformed version', async () => {
    const outcome = await probeNpm(spec({ version: '1.0.0 && curl evil.test' }), context);
    expect(outcome.status).toBe('skipped');
    expect(outcome.errorExcerpt).toContain('malformed npm version');
  });
});
