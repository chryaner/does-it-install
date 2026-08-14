/**
 * Tiny guarded accessors for untrusted JSON.
 *
 * The registry response and data/seed.json are both parsed from JSON we do not
 * control, so every field read goes through one of these instead of a cast.
 */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or undefined for anything else (including ""). */
export function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A boolean, or `fallback` for anything else. */
export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** An array, or [] for anything else. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read a property off a value that may not be an object at all. */
export function prop(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
