/**
 * Small helpers shared by the probe implementations: rolling output capture,
 * phase timeouts, process cleanup and human-readable error text.
 */
import { spawnSync } from 'node:child_process';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/** Extra slack on top of the SDK's own request timeout before we give up. */
export const TIMEOUT_GRACE_MS = 2_000;

/** Keeps only the newest `limit` characters written to it. */
export class RollingText {
  #text = '';
  readonly #limit: number;

  constructor(limit: number) {
    if (limit <= 0) throw new Error(`RollingText limit must be positive, got ${limit}`);
    this.#limit = limit;
  }

  push(chunk: string): void {
    this.#text += chunk;
    if (this.#text.length > this.#limit) {
      this.#text = this.#text.slice(this.#text.length - this.#limit);
    }
  }

  get text(): string {
    return this.#text;
  }
}

/** Thrown by {@link withTimeout} when a phase exceeds its budget. */
export class PhaseTimeoutError extends Error {
  readonly phase: string;
  readonly timeoutMs: number;

  constructor(phase: string, timeoutMs: number) {
    super(`${phase} timed out after ${timeoutMs}ms`);
    this.name = 'PhaseTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Races `work` against a timer. `Promise.race` subscribes to `work`, so a late
 * rejection after the timeout stays handled and never becomes an unhandled
 * rejection. The underlying operation does keep running, so callers must still
 * tear down whatever they started.
 */
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PhaseTimeoutError(phase, timeoutMs)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** True when a rejection means "the budget ran out", from either timer. */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof PhaseTimeoutError || (err instanceof McpError && err.code === ErrorCode.RequestTimeout);
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Kills a process (and on Windows its children) if it is still running.
 *
 * Probing means running third-party code: a server that ignores SIGTERM, or one
 * that spawned helpers, must never outlive its probe.
 */
export function killIfAlive(pid: number | null | undefined): void {
  if (pid === null || pid === undefined) return;
  try {
    process.kill(pid, 0);
  } catch {
    return; // already gone
  }
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Best effort: it died between the liveness check and the signal.
  }
}

/**
 * Best-effort one-line description of anything that was thrown. Node errors
 * carry the useful part in `code` (ENOENT) or `cause` (`fetch failed`), and
 * both are routinely missing from `message`.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [err.message.trim() || err.name];
  const code: unknown = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0 && !err.message.includes(code)) {
    parts.push(`(${code})`);
  }
  const cause: unknown = err.cause;
  if (cause instanceof Error && cause.message && !err.message.includes(cause.message)) {
    parts.push(`caused by: ${describeError(cause)}`);
  }
  return parts.join(' ');
}
