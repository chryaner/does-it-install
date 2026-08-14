/**
 * Runtime companion to the `Platform` union in types.ts.
 *
 * types.ts owns the type but never enumerates its members at runtime, and the
 * merge and badge stages both need to walk every platform. Keep this list in
 * sync with the union.
 */

import type { Platform } from '../types.js';

/** Every platform, in the order badges and pages list them. */
export const PLATFORMS: readonly Platform[] = ['linux', 'darwin', 'win32'];

const PLATFORM_SET = new Set<string>(PLATFORMS);

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && PLATFORM_SET.has(value);
}
