import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeRegistryItem } from './normalize.js';

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
      title: 'AgentTrust — Identity & Trust for A2A Agents',
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

  it('skips arguments whose value the end user is meant to supply', () => {
    const entry = normalizeNamed('ai.codenib/codenib');

    expect(entry.packages[0]?.runtimeArguments).toEqual(['--with', 'codenib[mcp]==0.2.0']);
    // packageArguments is [{positional "mcp"}, {positional with only a valueHint}].
    expect(entry.packages[0]?.packageArguments).toEqual(['mcp']);
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
      },
    ]);
  });

  it('falls back to a usable slug when the id normalizes to nothing', () => {
    expect(normalizeRegistryItem({ server: { name: '!!!' } })?.slug).toBe('server');
  });
});
