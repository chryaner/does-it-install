/**
 * The stdio half of the harness: spawn a command, run the MCP handshake against
 * it and list its tools. Used by both the npm and the pypi probe — they differ
 * only in how they get to a runnable command line.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { HARNESS_VERSION, MAX_ERROR_EXCERPT, MAX_TOOL_NAMES, type ProbeStatus } from '../types.js';
import { buildExcerpt, phaseSince, type ProbeOutcome } from './outcome.js';
import {
  delay,
  describeError,
  isTimeoutError,
  killIfAlive,
  RollingText,
  TIMEOUT_GRACE_MS,
  withTimeout
} from './util.js';

/** Time budgets a stdio probe needs. */
export interface StdioTimeouts {
  spawn: number;
  handshake: number;
  listTools: number;
}

/** A stdio probe reports everything except which distribution it came from. */
export type StdioOutcome = Omit<ProbeOutcome, 'method'>;

/** Let the child's last stderr chunks land before we build the excerpt. */
const STDERR_FLUSH_MS = 50;
/** Transport-level errors are short; keep them from crowding out stderr. */
const MAX_TRANSPORT_DIAGNOSTICS = 500;

/**
 * Adapts an already-started `StdioClientTransport` for `Client.connect()`.
 *
 * The harness starts the transport itself so that process spawn is timed and
 * reported as its own phase; `Client.connect()` would otherwise call `start()`
 * a second time, which the transport rejects. This also taps `onerror`, because
 * `Protocol` installs its own handler and would otherwise swallow transport
 * failures such as a server writing non-JSON to stdout.
 */
class StartedTransport implements Transport {
  readonly #inner: StdioClientTransport;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(inner: StdioClientTransport, tap: (error: Error) => void) {
    this.#inner = inner;
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error: Error) => {
      tap(error);
      this.onerror?.(error);
    };
    inner.onmessage = (message: JSONRPCMessage) => this.onmessage?.(message);
  }

  async start(): Promise<void> {
    // Already started by probeStdio(); Protocol calls this unconditionally.
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    return this.#inner.send(message);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

type PhaseName = 'spawn' | 'handshake' | 'listTools';

interface SessionResult {
  status: ProbeStatus;
  detail?: string;
  phases: ProbeOutcome['phases'];
  toolCount?: number;
  toolNames?: string[];
  serverInfo?: { name?: string; version?: string };
}

/** Records the failed phase and picks between its status and `timeout`. */
function failedAt(
  phases: ProbeOutcome['phases'],
  name: PhaseName,
  startedAtMs: number,
  err: unknown,
  status: ProbeStatus
): SessionResult {
  const detail = describeError(err);
  phases[name] = phaseSince(startedAtMs, false, detail);
  return { status: isTimeoutError(err) ? 'timeout' : status, detail: `${name} failed: ${detail}`, phases };
}

/**
 * Runs an already-installed server: spawns `command args`, performs
 * `initialize` and `tools/list`, and always tears the child down again.
 * Never throws — every failure comes back as a status plus an error excerpt.
 */
export async function probeStdio(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeouts: StdioTimeouts,
  cwd?: string
): Promise<StdioOutcome> {
  const stderrText = new RollingText(MAX_ERROR_EXCERPT * 2);
  const diagnostics = new RollingText(MAX_TRANSPORT_DIAGNOSTICS);

  const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe', cwd });
  // Available before start(), so no early output is lost.
  const stderrStream = transport.stderr;
  stderrStream?.on('data', (chunk: Buffer | string) => stderrText.push(chunk.toString()));

  const client = new Client({ name: 'does-it-install', version: HARNESS_VERSION }, { capabilities: {} });
  // Captured as soon as the child exists: the SDK forgets the pid on close.
  const child: { pid: number | null } = { pid: null };

  const session = await runSession(transport, client, timeouts, child, error =>
    diagnostics.push(`${describeError(error)}\n`)
  );
  await closeQuietly(client, transport, child.pid);

  if (session.status === 'pass') {
    return {
      status: session.status,
      phases: session.phases,
      toolCount: session.toolCount,
      toolNames: session.toolNames,
      serverInfo: session.serverInfo
    };
  }

  await delay(STDERR_FLUSH_MS);
  const transportNotes = diagnostics.text.trim();
  const details: string[] = [];
  if (session.detail) details.push(session.detail);
  if (transportNotes) details.push(`transport: ${transportNotes}`);

  return {
    status: session.status,
    phases: session.phases,
    errorExcerpt: buildExcerpt(details.join('\n'), stderrText.text)
  };
}

async function runSession(
  transport: StdioClientTransport,
  client: Client,
  timeouts: StdioTimeouts,
  child: { pid: number | null },
  tap: (error: Error) => void
): Promise<SessionResult> {
  const phases: ProbeOutcome['phases'] = {};

  const spawnAt = Date.now();
  try {
    await withTimeout(transport.start(), timeouts.spawn, 'spawn');
  } catch (err) {
    child.pid = transport.pid;
    return failedAt(phases, 'spawn', spawnAt, err, 'spawn_failed');
  }
  child.pid = transport.pid;
  phases.spawn = phaseSince(spawnAt, true);

  const handshakeAt = Date.now();
  try {
    const connect = client.connect(new StartedTransport(transport, tap), { timeout: timeouts.handshake });
    await withTimeout(connect, timeouts.handshake + TIMEOUT_GRACE_MS, 'handshake');
  } catch (err) {
    return failedAt(phases, 'handshake', handshakeAt, err, 'handshake_failed');
  }
  phases.handshake = phaseSince(handshakeAt, true);

  const listAt = Date.now();
  try {
    const listing = await withTimeout(
      client.listTools(undefined, { timeout: timeouts.listTools }),
      timeouts.listTools + TIMEOUT_GRACE_MS,
      'listTools'
    );
    phases.listTools = phaseSince(listAt, true);
    const names = listing.tools.map(tool => tool.name);
    return {
      status: 'pass',
      phases,
      toolCount: names.length,
      toolNames: names.slice(0, MAX_TOOL_NAMES),
      serverInfo: serverInfoOf(client)
    };
  } catch (err) {
    return failedAt(phases, 'listTools', listAt, err, 'tools_failed');
  }
}

function serverInfoOf(client: Client): { name?: string; version?: string } | undefined {
  const info = client.getServerVersion();
  if (!info) return undefined;
  return { name: info.name, version: info.version };
}

/** Closes the client and transport, then makes sure the child is really gone. */
async function closeQuietly(client: Client, transport: StdioClientTransport, pid: number | null): Promise<void> {
  try {
    await client.close();
  } catch {
    // The transport is closed below regardless.
  }
  try {
    await transport.close();
  } catch {
    // Nothing left to do but kill the process.
  }
  // The SDK closes the child politely (SIGTERM, then SIGKILL); this catches
  // anything that survived, including process trees on Windows.
  killIfAlive(pid);
}
