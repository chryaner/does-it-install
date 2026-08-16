import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeRegistryItem, registryRepoUrl } from './normalize.js';

/** One real `/v0/servers` page, trimmed, plus one hand-added malformed item. */
const page = JSON.parse(
  readFileSync(new URL('./fixtures/registry-page.json', import.meta.url), 'utf8'),
) as { servers: unknown[] };

function itemNamed(name: string): unknown {
  const found = page.servers.find(
    (item) => (item as { server?: { name?: string } }).server?.name === name,
  );
  if (!found) throw new Error(`fixture is missing ${name}`);
  return found;
}

function normalizeNamed(name: string) {
  const entry = normalizeRegistryItem(itemNamed(name));
  if (!entry) throw new Error(`${name} unexpectedly normalized to null`);
  return entry;
}

describe('normalizeRegistryItem', () => {
  it('normalizes an npm package entry with environment variables', () => {
    const entry = normalizeNamed('ai.agenttrust/mcp-server');

    expect(entry).toMatchObject({
      id: 'ai.agenttrust/mcp-server',
      slug: 'ai.agenttrust__mcp-server',
      // Escaped, not typed: the title is third-party text copied from the fixture.
      title: 'AgentTrust \u2014 Identity & Trust for A2A Agents',
      version: '1.1.1',
      repoUrl: 'https://github.com/agenttrust/mcp-server',
      websiteUrl: 'https://agenttrust.ai',
      source: 'registry',
      rank: 0,
      updatedAt: '2026-03-06T11:23:10.721165Z',
      remotes: [],
    });
    expect(entry.packages).toEqual([
      {
        kind: 'npm',
        identifier: '@agenttrust/mcp-server',
        version: '1.1.1',
        transport: 'stdio',
        env: [
          {
            name: 'AGENTTRUST_API_KEY',
            required: true,
            secret: true,
            description: 'Your AgentTrust API key from https://agenttrust.ai',
          },
        ],
      },
    ]);
  });

  it('defaults required/secret to false when the registry omits them', () => {
    const entry = normalizeNamed('ai.aliengiraffe/spotdb');

    expect(entry.packages[0]?.kind).toBe('oci');
    expect(entry.packages[0]?.env).toEqual([
      {
        name: 'X-API-Key',
        required: false,
        secret: true,
        description: 'Optional API key for request authentication',
      },
    ]);
  });

  it('falls back to the registry name when there is no title', () => {
    const entry = normalizeNamed('ac.inference.sh/mcp');
    expect(entry.title).toBe('inference.sh');

    const untitled = normalizeNamed('ai.agentrapay/agentra');
    expect(untitled.title).toBe('ai.agentrapay/agentra');
    expect(untitled.repoUrl).toBeUndefined(); // fixture has `repository: {}`
  });

  it('keeps remote-only entries with their headers', () => {
    const entry = normalizeNamed('ai.adadvisor/mcp-server');

    expect(entry.packages).toEqual([]);
    expect(entry.remotes).toEqual([
      {
        type: 'streamable-http',
        url: 'https://api.adadvisor.ai/mcp',
        headers: [
          {
            name: 'Authorization',
            required: true,
            secret: true,
            description: expect.stringContaining('Bearer token'),
          },
        ],
      },
    ]);
  });

  it('keeps legacy sse remotes', () => {
    expect(normalizeNamed('ai.agentrapay/agentra').remotes).toEqual([
      { type: 'sse', url: 'https://api.agentrapay.ai/mcp', headers: [] },
    ]);
  });

  it('flattens positional runtime arguments in order', () => {
    const entry = normalizeNamed('ai.circulara/plugin');

    expect(entry.packages[0]?.runtimeHint).toBe('npx');
    expect(entry.packages[0]?.runtimeArguments).toEqual(['-y', '-p', '@circulara/plugin', 'circulara-mcp']);
    expect(entry.packages[0]?.packageArguments).toBeUndefined();
    expect(entry.packages[0]?.env.map((v) => v.name)).toEqual([
      'CIRCULARA_BACKEND_URL',
      'CIRCULARA_TENANT_ID',
      'CIRCULARA_TOKEN',
      'CIRCULARA_SEAT_ID',
      'CIRCULARA_USER_ID',
    ]);
  });

  it('flattens a named argument to its flag followed by its value', () => {
    expect(normalizeNamed('ai.clize/clize').packages[0]?.runtimeArguments).toEqual([
      '--package',
      '@clize/clize',
      'clize-mcp',
    ]);
  });

  it('skips a named argument the registry pinned no value on, flag and all', () => {
    const entry = normalizeRegistryItem({
      server: {
        name: 'test/named-args',
        packages: [
          {
            registryType: 'npm',
            identifier: 'ok-pkg',
            runtimeArguments: [
              // A bare `--directory` would break the invocation: the end user
              // was meant to supply the path.
              { type: 'named', name: '--directory', valueHint: 'path', isRequired: true },
              { type: 'named', name: '--package', value: 'ok-pkg' },
            ],
            packageArguments: [{ type: 'named', name: '--verbose' }],
          },
        ],
      },
    });

    expect(entry?.packages[0]?.runtimeArguments).toEqual(['--package', 'ok-pkg']);
    expect(entry?.packages[0]?.packageArguments).toBeUndefined();
    expect(entry?.packages[0]?.droppedArguments).toBe(true);
  });

  it('skips arguments whose value the end user is meant to supply', () => {
    const entry = normalizeNamed('ai.codenib/codenib');

    expect(entry.packages[0]?.runtimeArguments).toEqual(['--with', 'codenib[mcp]==0.2.0']);
    // packageArguments is [{positional "mcp"}, {positional with only a valueHint}].
    expect(entry.packages[0]?.packageArguments).toEqual(['mcp']);
    // The dropped one is what the harness needs to tell "broken" from
    // "we never had the checkout path it wanted".
    expect(entry.packages[0]?.droppedArguments).toBe(true);
  });

  it('reports a dropped argument from either argument list', () => {
    const dropping = (pkg: Record<string, unknown>) =>
      normalizeRegistryItem({
        server: { name: 'test/dropped', packages: [{ registryType: 'npm', identifier: 'ok-pkg', ...pkg }] },
      })?.packages[0]?.droppedArguments;

    expect(dropping({ runtimeArguments: [{ type: 'positional', valueHint: 'path' }] })).toBe(true);
    expect(dropping({ packageArguments: [{ type: 'positional', valueHint: 'path' }] })).toBe(true);
    // A named argument we cannot place is a drop too: no name, no argv.
    expect(dropping({ packageArguments: [{ type: 'named', value: 'x' }] })).toBe(true);
  });

  it('leaves the flag off a package whose arguments all came through', () => {
    const entry = normalizeRegistryItem({
      server: {
        name: 'test/complete-args',
        packages: [
          {
            registryType: 'npm',
            identifier: 'ok-pkg',
            runtimeArguments: [{ type: 'named', name: '--package', value: 'ok-pkg' }],
            packageArguments: [{ type: 'positional', value: 'serve' }],
          },
        ],
      },
    });

    // Absent, not false: types.ts keeps the field optional so a catalog only
    // carries the flag for the servers it actually applies to.
    expect(entry?.packages[0]).toEqual({
      kind: 'npm',
      identifier: 'ok-pkg',
      runtimeArguments: ['--package', 'ok-pkg'],
      packageArguments: ['serve'],
      env: [],
    });
    expect(entry?.packages[0] && 'droppedArguments' in entry.packages[0]).toBe(false);
  });

  it('leaves the flag off a package that declared no arguments at all', () => {
    const entry = normalizeNamed('ai.agenttrust/mcp-server');
    expect(entry.packages[0] && 'droppedArguments' in entry.packages[0]).toBe(false);
  });

  it('keeps every supported package of a multi-package entry, in order', () => {
    const entry = normalizeNamed('ai.bourdon/bourdon');

    expect(entry.packages.map((pkg) => [pkg.kind, pkg.identifier])).toEqual([
      ['pypi', 'bourdon'],
      ['npm', '@getbourdon/mcp-server'],
    ]);
    expect(entry.packages[0]?.packageArguments).toEqual(['serve']);
    expect(entry.packages[1]?.env).toEqual([]);
  });

  it('drops packages whose registryType we cannot probe', () => {
    const entry = normalizeNamed('ai.featureboard/featureboard'); // only an "mcpb" package
    expect(entry.packages).toEqual([]);
    expect(entry.remotes).toEqual([]);
  });

  it('returns null for the malformed fixture item instead of throwing', () => {
    const malformed = page.servers.find(
      (item) => (item as { server?: { name?: string } }).server?.name === undefined,
    );
    expect(malformed).toBeDefined();
    expect(normalizeRegistryItem(malformed)).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['an empty object', {}],
    ['a server without a name', { server: { title: 'no name' } }],
    ['a blank name', { server: { name: '   ' } }],
    ['a non-object server', { server: 'nope' }],
  ])('returns null for %s', (_label, item) => {
    expect(normalizeRegistryItem(item)).toBeNull();
  });

  it('drops remotes with an unsupported type or a non-http url', () => {
    const entry = normalizeRegistryItem({
      server: {
        name: 'test/remotes',
        remotes: [
          { type: 'websocket', url: 'https://example.com/mcp' },
          { type: 'streamable-http', url: 'javascript:alert(1)' },
          { type: 'streamable-http', url: 'not a url' },
          { type: 'sse' },
          { type: 'streamable-http', url: 'https://example.com/ok' },
        ],
      },
    });

    expect(entry?.remotes).toEqual([
      { type: 'streamable-http', url: 'https://example.com/ok', headers: [] },
    ]);
  });

  it('drops repository and website urls that are not http(s)', () => {
    const entry = normalizeRegistryItem({
      server: {
        name: 'test/urls',
        repository: { url: 'javascript:alert(1)' },
        websiteUrl: 'ftp://example.com',
      },
    });

    expect(entry?.repoUrl).toBeUndefined();
    expect(entry?.websiteUrl).toBeUndefined();
  });

  it('ignores junk inside packages, env vars and arguments', () => {
    const entry = normalizeRegistryItem({
      server: {
        name: 'test/junk',
        packages: [
          'not-an-object',
          { registryType: 'npm' }, // no identifier
          {
            registryType: 'npm',
            identifier: 'ok-pkg',
            environmentVariables: [null, { description: 'nameless' }, { name: 'KEEP' }],
            packageArguments: [{ type: 'named' }, { type: 'weird', value: 'x' }, 42],
            transport: 'stdio-as-a-string',
          },
        ],
      },
    });

    expect(entry?.packages).toEqual([
      {
        kind: 'npm',
        identifier: 'ok-pkg',
        env: [{ name: 'KEEP', required: false, secret: false }],
        // `{type: "named"}` was an argument object we could not place, so the
        // invocation is not the declared one; `42` is not an argument at all.
        droppedArguments: true,
      },
    ]);
  });

  it('falls back to a usable slug when the id normalizes to nothing', () => {
    expect(normalizeRegistryItem({ server: { name: '!!!' } })?.slug).toBe('server');
  });
});

describe('registryRepoUrl', () => {
  it('reads the same url normalization assigns, so star lookups key on it', () => {
    const item = itemNamed('ai.agenttrust/mcp-server');
    expect(registryRepoUrl(item)).toBe(normalizeRegistryItem(item)?.repoUrl);
    expect(registryRepoUrl(item)).toMatch(/^https:\/\//);
  });

  it('reads a repository url without normalizing the rest of the item', () => {
    expect(registryRepoUrl({ server: { repository: { url: 'https://github.com/a/b' } } })).toBe(
      'https://github.com/a/b',
    );
  });

  it.each([
    [{ server: { name: 'a/b' } }],
    [{ server: { repository: { url: 'javascript:alert(1)' } } }],
    [{ server: { repository: 'https://github.com/a/b' } }],
    [{ repository: { url: 'https://github.com/a/b' } }],
    [null],
    ['junk'],
  ])('has nothing to read in %j', (item) => {
    expect(registryRepoUrl(item)).toBeUndefined();
  });
});
