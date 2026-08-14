import { describe, expect, it } from 'vitest';
import { MAX_ERROR_EXCERPT } from '../types.js';
import { buildExcerpt, phaseSince, skippedOutcome, tailChars } from './outcome.js';

describe('tailChars', () => {
  it('keeps short text untouched', () => {
    expect(tailChars('hello', 10)).toBe('hello');
  });

  it('keeps the newest characters and marks the cut', () => {
    expect(tailChars('abcdefgh', 4)).toBe('…fgh');
    expect(tailChars('abcdefgh', 4)).toHaveLength(4);
  });
});

describe('buildExcerpt', () => {
  it('is undefined when there is nothing to report', () => {
    expect(buildExcerpt(undefined, '')).toBeUndefined();
    expect(buildExcerpt('   ', '\n\n')).toBeUndefined();
  });

  it('keeps the detail and labels the captured output', () => {
    const excerpt = buildExcerpt('handshake failed: connection closed', 'server: boom\n');
    expect(excerpt).toContain('handshake failed: connection closed');
    expect(excerpt).toContain('--- stderr (tail) ---');
    expect(excerpt).toContain('server: boom');
  });

  it('caps at MAX_ERROR_EXCERPT, keeping the detail and the newest output', () => {
    const noisy = `${'x'.repeat(50_000)}THE-LAST-LINE`;
    const excerpt = buildExcerpt('install failed: exited with code 1', noisy);

    expect(excerpt).toBeDefined();
    expect(excerpt?.length).toBeLessThanOrEqual(MAX_ERROR_EXCERPT);
    expect(excerpt).toContain('install failed: exited with code 1');
    expect(excerpt).toContain('THE-LAST-LINE');
  });

  it('falls back to the detail alone when the detail fills the budget', () => {
    const excerpt = buildExcerpt('d'.repeat(MAX_ERROR_EXCERPT + 100), 'ignored stderr');
    expect(excerpt?.length).toBe(MAX_ERROR_EXCERPT);
    expect(excerpt).not.toContain('ignored stderr');
  });
});

describe('phaseSince', () => {
  it('measures from the given start and only records a detail when given one', () => {
    const ok = phaseSince(Date.now() - 25, true);
    expect(ok.ok).toBe(true);
    expect(ok.durationMs).toBeGreaterThanOrEqual(25);
    expect(ok).not.toHaveProperty('detail');

    expect(phaseSince(Date.now(), false, 'nope').detail).toBe('nope');
  });
});

describe('skippedOutcome', () => {
  it('records the reason without pretending a phase ran', () => {
    expect(skippedOutcome('oci', 'not implemented')).toEqual({
      method: 'oci',
      status: 'skipped',
      phases: {},
      errorExcerpt: 'not implemented'
    });
  });
});
