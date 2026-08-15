/**
 * remote probe: connect to a hosted endpoint over streamable HTTP (or legacy
 * SSE), initialize and list tools. We never send the headers a server declares,
 * because we have no credentials, so "reachable but needs auth" is an expected
 * and useful outcome, recorded as `needs_auth` with the HTTP detail.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { HARNESS_VERSION, MAX_TOOL_NAMES, type ProbeMethod, type ProbeStatus, type RemoteSpec } from '../types.js';
import type { ProbeTimeouts } from './options.js';
import { buildExcerpt, phaseSince, type ProbeOutcome } from './outcome.js';
import { describeError, isTimeoutError, TIMEOUT_GRACE_MS, withTimeout } from './util.js';

/** Which phase a remote failure belongs to, and what to call it. */
export interface RemoteFailure {
  phase: 'connect' | 'handshake';
  status: ProbeStatus;
  detail: string;
}

/** HTTP status carried by an SDK transport error, if it carries one. */
function httpStatusOf(err: unknown): number | undefined {
  const code: unknown = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'number' && code >= 100 && code <= 599) return code;
  if (err instanceof Error) {
    const match = /\bHTTP (\d{3})\b/.exec(err.message);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

/**
 * Sorts a connect() rejection into "never reached the endpoint" (connect_failed)
 * versus "endpoint answered but MCP did not come up" (handshake_failed).
 * 401/403 mean the endpoint is alive and simply wants credentials, which is
 * signal about the server, not about the network: types.ts calls that
 * `needs_auth`, still in the handshake phase because the endpoint answered.
 */
export function classifyRemoteError(err: unknown): RemoteFailure {
  const detail = describeError(err);
  if (isTimeoutError(err)) {
    return { phase: 'connect', status: 'timeout', detail };
  }

  const status = httpStatusOf(err);
  if (status !== undefined) {
    const described = detail.includes(String(status)) ? detail : `HTTP ${status}: ${detail}`;
    if (status === 401 || status === 403) {
      return {
        phase: 'handshake',
        status: 'needs_auth',
        detail: `${described} (endpoint reachable but requires credentials the harness does not send)`
      };
    }
    return { phase: 'connect', status: 'connect_failed', detail: described };
  }

  if (err instanceof McpError) {
    return { phase: 'handshake', status: 'handshake_failed', detail };
  }
  return { phase: 'connect', status: 'connect_failed', detail };
}

/**
 * types.ts policy: an endpoint that answered but would not finish the MCP
 * handshake, while declaring headers it requires and we never send, is gated
 * rather than broken. `classifyRemoteError` already reports 401/403 that way;
 * this also covers endpoints that reject an unauthenticated `initialize` with a
 * protocol error instead of an HTTP status. Failures that never reached the
 * endpoint (connect_failed) or ran out of time (timeout) are left alone,
 * because they are not a verdict from the server.
 */
function isGatedByHeaders(failure: RemoteFailure, remote: RemoteSpec): boolean {
  if (failure.phase !== 'handshake' || failure.status === 'timeout') return false;
  return (remote.headers ?? []).some(header => header?.required === true);
}

export async function probeRemote(remote: RemoteSpec, timeouts: ProbeTimeouts): Promise<ProbeOutcome> {
  const method: ProbeMethod = remote.type === 'sse' ? 'remote-sse' : 'remote-http';
  const phases: ProbeOutcome['phases'] = {};

  let url: URL;
  try {
    url = new URL(remote.url);
  } catch {
    const detail = `not a valid URL: ${JSON.stringify(remote.url)}`;
    phases.connect = { ok: false, durationMs: 0, detail };
    return { method, status: 'connect_failed', phases, errorExcerpt: detail };
  }

  const client = new Client({ name: 'does-it-install', version: HARNESS_VERSION }, { capabilities: {} });
  const transport: Transport =
    remote.type === 'sse' ? new SSEClientTransport(url) : new StreamableHTTPClientTransport(url);

  try {
    // Both HTTP transports fuse "reach the endpoint" and "initialize" into
    // connect(), so connect and handshake share one measurement and the
    // classifier decides which of them a failure belongs to.
    const connectAt = Date.now();
    try {
      await withTimeout(
        client.connect(transport, { timeout: timeouts.remoteConnect }),
        timeouts.remoteConnect + TIMEOUT_GRACE_MS,
        'connect'
      );
    } catch (err) {
      const failure = classifyRemoteError(err);
      const reached = failure.phase === 'handshake';
      phases.connect = phaseSince(connectAt, reached, reached ? undefined : failure.detail);
      if (reached) phases.handshake = phaseSince(connectAt, false, failure.detail);
      return {
        method,
        status: isGatedByHeaders(failure, remote) ? 'needs_auth' : failure.status,
        phases,
        errorExcerpt: buildExcerpt(`${failure.phase} failed: ${failure.detail}`, '')
      };
    }
    phases.connect = phaseSince(connectAt, true);
    phases.handshake = phaseSince(connectAt, true);

    const listAt = Date.now();
    try {
      const listing = await withTimeout(
        client.listTools(undefined, { timeout: timeouts.listTools }),
        timeouts.listTools + TIMEOUT_GRACE_MS,
        'listTools'
      );
      phases.listTools = phaseSince(listAt, true);
      const names = listing.tools.map(tool => tool.name);
      const info = client.getServerVersion();
      return {
        method,
        status: 'pass',
        phases,
        toolCount: names.length,
        toolNames: names.slice(0, MAX_TOOL_NAMES),
        serverInfo: info ? { name: info.name, version: info.version } : undefined
      };
    } catch (err) {
      const detail = describeError(err);
      phases.listTools = phaseSince(listAt, false, detail);
      return {
        method,
        status: isTimeoutError(err) ? 'timeout' : 'tools_failed',
        phases,
        errorExcerpt: buildExcerpt(`listTools failed: ${detail}`, '')
      };
    }
  } finally {
    try {
      await client.close();
    } catch {
      // Nothing to clean up but the socket the SDK owns.
    }
    try {
      await transport.close();
    } catch {
      // Already closed by the client.
    }
  }
}
