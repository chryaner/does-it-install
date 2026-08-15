/**
 * Options and per-phase time budgets for the probe harness.
 */
import os from 'node:os';
import path from 'node:path';
import { currentPlatform, type Platform } from '../types.js';

/** Per-phase time budgets in milliseconds. */
export interface ProbeTimeouts {
  /**
   * `npm install`, `docker pull`, and for pypi the `uv` download that happens
   * on first run.
   */
  install: number;
  /** Getting the child process to start. */
  spawn: number;
  /** MCP `initialize` round trip. */
  handshake: number;
  /** `tools/list` round trip. */
  listTools: number;
  /** Reaching a hosted endpoint and initializing against it. */
  remoteConnect: number;
}

export const DEFAULT_TIMEOUTS: ProbeTimeouts = {
  // 600s: Windows runners build optional native deps and scan every write,
  // so a package that installs in 20s on Linux can legitimately need minutes.
  install: 600_000,
  spawn: 30_000,
  handshake: 30_000,
  listTools: 15_000,
  remoteConnect: 20_000
};

/** Distribution families the sweep is allowed to probe (`--methods`). */
export type MethodFilter = 'npm' | 'pypi' | 'oci' | 'remote';

export const ALL_METHODS: readonly MethodFilter[] = ['npm', 'pypi', 'oci', 'remote'];

export function isMethodFilter(value: string): value is MethodFilter {
  return (ALL_METHODS as readonly string[]).includes(value);
}

/** Caller-supplied options; everything has a default. */
export interface ProbeOptions {
  /** Root directory temp install prefixes are created under. */
  workDir?: string;
  timeouts?: Partial<ProbeTimeouts>;
  methods?: readonly MethodFilter[];
  platform?: Platform;
}

export interface ResolvedProbeOptions {
  workDir: string;
  timeouts: ProbeTimeouts;
  methods: readonly MethodFilter[];
  platform: Platform;
}

export function resolveProbeOptions(options: ProbeOptions = {}): ResolvedProbeOptions {
  return {
    workDir: options.workDir ?? path.join(os.tmpdir(), 'does-it-install'),
    timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts },
    methods: options.methods ?? ALL_METHODS,
    platform: options.platform ?? currentPlatform()
  };
}

/** What a package probe needs to install and spawn one server. */
export interface ProbeContext {
  workDir: string;
  timeouts: ProbeTimeouts;
  /** Declared environment variables, already filled with placeholders. */
  env: Record<string, string>;
}
