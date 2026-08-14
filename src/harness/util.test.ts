import { describe, expect, it } from 'vitest';
import { describeError, PhaseTimeoutError, RollingText, withTimeout } from './util.js';

describe('RollingText', () => {
  it('keeps only the newest characters', () => {
    const buffer = new RollingText(10);
    buffer.push('0123456789');
    buffer.push('abcde');
    expect(buffer.text).toBe('56789abcde');
    expect(buffer.text).toHaveLength(10);
  });

  it('rejects a non-positive limit', () => {
    expect(() => new RollingText(0)).toThrow(/positive/);
  });
});

describe('withTimeout', () => {
  it('returns the value when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'spawn')).resolves.toBe('ok');
  });

  it('rejects with the phase name when the budget runs out', async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 20, 'handshake')).rejects.toBeInstanceOf(PhaseTimeoutError);
  });

  it('passes through the original rejection', async () => {
    const boom = Promise.reject(new Error('boom'));
    await expect(withTimeout(boom, 1_000, 'listTools')).rejects.toThrow('boom');
  });
});

describe('describeError', () => {
  it('adds the error code when the message omits it', () => {
    const err = Object.assign(new Error('spawn uv failed'), { code: 'ENOENT' });
    expect(describeError(err)).toBe('spawn uv failed (ENOENT)');
  });

  it('does not repeat a code already in the message', () => {
    const err = Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' });
    expect(describeError(err)).toBe('spawn uv ENOENT');
  });

  it('unwraps the cause that fetch hides', () => {
    const err = new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') });
    expect(describeError(err)).toBe('fetch failed caused by: connect ECONNREFUSED 127.0.0.1:1');
  });

  it('stringifies non-errors', () => {
    expect(describeError('just a string')).toBe('just a string');
  });
});
