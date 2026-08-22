import { describe, expect, it } from 'vitest';
import type { PackageSpec } from '../types.js';
import { DEFAULT_TIMEOUTS } from './options.js';
import {
  declaredBunRequirement,
  missingBunRuntimeDetail,
  probeNpm,
  selectBinEntry,
  unscopedName
} from './npm.js';

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

describe('declaredBunRequirement', () => {
  it('returns a non-empty Bun engine range', () => {
    expect(declaredBunRequirement({ engines: { bun: '>=1.3.14' } })).toBe('>=1.3.14');
  });

  it('ignores missing, non-string and blank declarations', () => {
    expect(declaredBunRequirement({})).toBeUndefined();
    expect(declaredBunRequirement({ engines: { bun: 1 } })).toBeUndefined();
    expect(declaredBunRequirement({ engines: { bun: '   ' } })).toBeUndefined();
    expect(declaredBunRequirement(null)).toBeUndefined();
  });
});

describe('missingBunRuntimeDetail', () => {
  const manifest = { engines: { bun: '>=1.3.14' } };

  it('explains why a declared Bun package cannot be probed', () => {
    expect(missingBunRuntimeDetail('@acme/server', manifest, false)).toBe(
      '@acme/server declares Bun >=1.3.14, but Bun is not available on this runner; install Bun to probe it'
    );
  });

  it('does not skip packages when Bun is present or not declared', () => {
    expect(missingBunRuntimeDetail('@acme/server', manifest, true)).toBeUndefined();
    expect(missingBunRuntimeDetail('@acme/server', {}, false)).toBeUndefined();
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
