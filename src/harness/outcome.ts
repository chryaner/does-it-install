/**
 * Shaping helpers for probe results: phase timing, error excerpts and the
 * partial result each per-distribution probe returns to `probeServer`.
 */
import { MAX_ERROR_EXCERPT, type PhaseResult, type ProbeMethod, type ProbeResult, type ProbeStatus } from '../types.js';

/**
 * What one distribution probe (npm / pypi / remote) reports back. `probeServer`
 * turns it into a full `ProbeResult` by adding identity and timing.
 */
export interface ProbeOutcome {
  method: ProbeMethod;
  status: ProbeStatus;
  phases: ProbeResult['phases'];
  toolCount?: number;
  toolNames?: string[];
  serverInfo?: { name?: string; version?: string };
  errorExcerpt?: string;
}

/** A `PhaseResult` measured from `startedAtMs` to now. */
export function phaseSince(startedAtMs: number, ok: boolean, detail?: string): PhaseResult {
  return { ok, durationMs: Date.now() - startedAtMs, ...(detail !== undefined ? { detail } : {}) };
}

/** Newest `limit` characters of `text`, marking the cut with an ellipsis. */
export function tailChars(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  return `…${text.slice(text.length - (limit - 1))}`;
}

const STDERR_LABEL = '--- stderr (tail) ---';

/**
 * Combines the failure detail with the captured child output into an excerpt of
 * at most `MAX_ERROR_EXCERPT` characters. The detail is kept whole (it names the
 * failure); the output is trimmed to the newest lines that still fit.
 */
export function buildExcerpt(detail: string | undefined, output: string): string | undefined {
  const head = (detail ?? '').trim();
  const tail = output.trim();
  if (!head && !tail) return undefined;
  if (!tail) return tailChars(head, MAX_ERROR_EXCERPT);

  const budget = MAX_ERROR_EXCERPT - head.length - STDERR_LABEL.length - 2;
  if (budget <= 0) return tailChars(head, MAX_ERROR_EXCERPT);
  const prefix = head ? `${head}\n` : '';
  return `${prefix}${STDERR_LABEL}\n${tailChars(tail, budget)}`;
}

/** An outcome for a distribution we deliberately do not probe. */
export function skippedOutcome(method: ProbeMethod, reason: string): ProbeOutcome {
  return { method, status: 'skipped', phases: {}, errorExcerpt: reason };
}
