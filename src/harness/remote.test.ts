import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ProbeTimeouts } from './options.js';
import { classifyRemoteError, probeRemote } from './remote.js';
import { PhaseTimeoutError } from './util.js';

const TIMEOUTS: ProbeTimeouts = {
  install: 1_000,
  spawn: 1_000,
  handshake: 1_000,
  listTools: 1_000,
  remoteConnect: 3_000
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const AUTH_HEADER = { name: 'Authorization', required: true, secret: true };

describe('classifyRemoteError', () => {
  it('treats 401 and 403 as a reachable endpoint that wants credentials', () => {
    for (const status of [401, 403]) {
      const failure = classifyRemoteError(new StreamableHTTPError(status, 'Error POSTing to endpoint: nope'));
      expect(failure.phase).toBe('handshake');
      expect(failure.status).toBe('needs_auth');
      expect(failure.detail).toContain(`HTTP ${status}`);
      expect(failure.detail).toContain('requires credentials');
    }
  });

  it('treats other HTTP failures as never having connected', () => {
    const failure = classifyRemoteError(new StreamableHTTPError(404, 'Error POSTing to endpoint: no such route'));
    expect(failure).toMatchObject({ phase: 'connect', status: 'connect_failed' });
    expect(failure.detail).toContain('HTTP 404');
  });

  it('reads the status out of an SSE-style message when there is no code', () => {
    const failure = classifyRemoteError(new Error('Error POSTing to endpoint (HTTP 502): bad gateway'));
    expect(failure).toMatchObject({ phase: 'connect', status: 'connect_failed' });
    expect(failure.detail).toContain('502');
  });

  it('treats transport failures as connect failures', () => {
    const failure = classifyRemoteError(new Error('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND x') }));
    expect(failure).toMatchObject({ phase: 'connect', status: 'connect_failed' });
    expect(failure.detail).toContain('ENOTFOUND');
  });

  it('treats protocol errors as handshake failures', () => {
    const failure = classifyRemoteError(new McpError(ErrorCode.InvalidRequest, 'bad initialize'));
    expect(failure).toMatchObject({ phase: 'handshake', status: 'handshake_failed' });
  });

  it('reports either timer running out as a timeout', () => {
    expect(classifyRemoteError(new PhaseTimeoutError('connect', 20)).status).toBe('timeout');
    expect(classifyRemoteError(new McpError(ErrorCode.RequestTimeout, 'Request timed out')).status).toBe('timeout');
  });
});

describe('probeRemote', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/mcp') {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('missing bearer token');
        return;
      }
      if (req.url === '/rejects') {
        // Answers the POST, then refuses `initialize` at the protocol level
        // rather than with an HTTP status: a handshake failure with no 401.
        readBody(req)
          .then(body => {
            const id = (JSON.parse(body) as { id?: unknown }).id ?? null;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: -32600, message: 'this workspace is not authorized' }
              })
            );
          })
          .catch(() => {
            res.writeHead(400);
            res.end();
          });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such endpoint');
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  });

  it('records an endpoint that demands auth as reachable but unauthenticated', async () => {
    const outcome = await probeRemote({ type: 'streamable-http', url: `${origin}/mcp`, headers: [] }, TIMEOUTS);

    expect(outcome.method).toBe('remote-http');
    expect(outcome.status).toBe('needs_auth');
    expect(outcome.phases.connect?.ok).toBe(true);
    expect(outcome.phases.handshake?.ok).toBe(false);
    expect(outcome.errorExcerpt).toContain('HTTP 401');
    expect(outcome.errorExcerpt).toContain('missing bearer token');
  });

  it('treats a rejected handshake as needs_auth when the remote declares a required header', async () => {
    const outcome = await probeRemote(
      { type: 'streamable-http', url: `${origin}/rejects`, headers: [AUTH_HEADER] },
      TIMEOUTS
    );

    expect(outcome.status).toBe('needs_auth');
    expect(outcome.phases.connect?.ok).toBe(true);
    expect(outcome.phases.handshake?.ok).toBe(false);
    expect(outcome.errorExcerpt).toContain('handshake failed');
    expect(outcome.errorExcerpt).toContain('not authorized');
  });

  it('leaves a rejected handshake alone when no header is required', async () => {
    const outcome = await probeRemote(
      {
        type: 'streamable-http',
        url: `${origin}/rejects`,
        headers: [{ name: 'X-Trace-Id', required: false, secret: false }]
      },
      TIMEOUTS
    );

    expect(outcome.status).toBe('handshake_failed');
    expect(outcome.phases.handshake?.ok).toBe(false);
  });

  it('does not let a required header rescue an endpoint it never reached', async () => {
    const outcome = await probeRemote(
      { type: 'streamable-http', url: `${origin}/nope`, headers: [AUTH_HEADER] },
      TIMEOUTS
    );

    expect(outcome.status).toBe('connect_failed');
    expect(outcome.phases.handshake).toBeUndefined();
  });

  it('records a wrong endpoint as connect_failed', async () => {
    const outcome = await probeRemote({ type: 'streamable-http', url: `${origin}/nope`, headers: [] }, TIMEOUTS);

    expect(outcome.status).toBe('connect_failed');
    expect(outcome.phases.connect?.ok).toBe(false);
    expect(outcome.phases.handshake).toBeUndefined();
    expect(outcome.errorExcerpt).toContain('HTTP 404');
  });

  it('records an unparseable url without touching the network', async () => {
    const outcome = await probeRemote({ type: 'sse', url: 'not-a-url', headers: [] }, TIMEOUTS);

    expect(outcome.method).toBe('remote-sse');
    expect(outcome.status).toBe('connect_failed');
    expect(outcome.errorExcerpt).toContain('not a valid URL');
  });
});
