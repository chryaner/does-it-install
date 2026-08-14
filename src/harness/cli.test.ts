import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMethods, parseShard, parseSweepArgs } from './cli.js';

describe('parseSweepArgs', () => {
  it('defaults to the catalog the catalog stage writes', () => {
    const options = parseSweepArgs([]);
    expect(options.catalogPath).toBe(path.join('data', 'catalog.json'));
    expect(options.outPath).toBeUndefined();
    expect(options.help).toBe(false);
    expect(options.sweep).toEqual({ timeouts: {} });
  });

  it('reads every selection flag', () => {
    const options = parseSweepArgs([
      '--catalog',
      'tmp/catalog.json',
      '--out',
      'tmp/run.json',
      '--top',
      '25',
      '--shard',
      '1/4',
      '--only',
      'io.github.acme/one',
      '--only',
      'acme__two',
      '--methods',
      'npm, remote',
      '--concurrency',
      '8'
    ]);

    expect(options.catalogPath).toBe('tmp/catalog.json');
    expect(options.outPath).toBe('tmp/run.json');
    expect(options.sweep).toMatchObject({
      top: 25,
      shard: { index: 1, total: 4 },
      only: ['io.github.acme/one', 'acme__two'],
      methods: ['npm', 'remote'],
      concurrency: 8
    });
  });

  it('takes timeout overrides in seconds and stores milliseconds', () => {
    const options = parseSweepArgs(['--timeout-install', '90', '--timeout-connect', '5']);
    expect(options.sweep.timeouts).toEqual({ install: 90_000, remoteConnect: 5_000 });
  });

  it('supports --flag=value and -h', () => {
    expect(parseSweepArgs(['--top=3']).sweep.top).toBe(3);
    expect(parseSweepArgs(['-h']).help).toBe(true);
  });

  it('rejects unusable values', () => {
    expect(() => parseSweepArgs(['--top', '0'])).toThrow(/--top must be a positive integer/);
    expect(() => parseSweepArgs(['--concurrency', 'lots'])).toThrow(/--concurrency must be a positive integer/);
    expect(() => parseSweepArgs(['--timeout-install=0'])).toThrow(/positive number of seconds/);
    expect(() => parseSweepArgs(['--nonsense'])).toThrow(/Unknown option/);
  });
});

describe('parseShard', () => {
  it('reads i/N as a zero-based index', () => {
    expect(parseShard('0/3')).toEqual({ index: 0, total: 3 });
    expect(parseShard(' 2 / 3 ')).toEqual({ index: 2, total: 3 });
  });

  it('rejects shards that cannot exist', () => {
    expect(() => parseShard('3/3')).toThrow(/between 0 and 2/);
    expect(() => parseShard('1/0')).toThrow(/at least 1/);
    expect(() => parseShard('half')).toThrow(/must look like i\/N/);
  });
});

describe('parseMethods', () => {
  it('accepts a trimmed comma-separated list', () => {
    expect(parseMethods('npm,pypi , remote')).toEqual(['npm', 'pypi', 'remote']);
  });

  it('rejects unknown or empty method lists', () => {
    expect(() => parseMethods('docker')).toThrow(/unknown method "docker"/);
    expect(() => parseMethods(' , ')).toThrow(/at least one of/);
  });
});
