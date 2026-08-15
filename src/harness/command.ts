/**
 * Running a helper program (npm, docker) to completion under a hard timeout.
 *
 * Shared by the package probes: they all need captured output, a bounded
 * runtime, and a process tree that cannot outlive the phase that started it.
 */
import { spawn } from 'node:child_process';
import { MAX_ERROR_EXCERPT } from '../types.js';
import { killIfAlive, RollingText } from './util.js';

export interface CommandResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

export interface CommandOptions {
  /** Working directory; the parent's own when omitted. */
  cwd?: string;
  timeoutMs: number;
}

/**
 * Runs a command to completion, capturing output and enforcing a hard timeout.
 *
 * On Windows npm is a batch file, and since Node 18.20 spawning `.cmd` without
 * a shell throws EINVAL, so there we go through the shell and quote arguments
 * ourselves. Elsewhere the command leads its own process group, so a timeout
 * can take out whatever it spawned along with it.
 */
export async function runCommand(
  command: string,
  args: string[],
  opts: CommandOptions
): Promise<CommandResult> {
  const useShell = process.platform === 'win32';
  return new Promise<CommandResult>(resolve => {
    const stdout = new RollingText(MAX_ERROR_EXCERPT * 2);
    const stderr = new RollingText(MAX_ERROR_EXCERPT * 2);
    let timedOut = false;
    let settled = false;

    const child = spawn(command, useShell ? args.map(quoteForShell) : args, {
      cwd: opts.cwd,
      shell: useShell,
      windowsHide: true,
      detached: !useShell,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, useShell);
    }, opts.timeoutMs);

    const finish = (result: Omit<CommandResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: stdout.text, stderr: stderr.text, timedOut });
    };
    child.on('error', (error: Error) => finish({ code: null, spawnError: error }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

/**
 * Kills a timed-out command and everything it started. On POSIX the child is
 * its own group leader (`detached`), so the negative pid reaches the whole
 * group; on Windows `killIfAlive` shells out to `taskkill /T`.
 */
function killGroup(pid: number | undefined, useShell: boolean): void {
  if (pid === undefined) return;
  if (useShell) {
    killIfAlive(pid);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    killIfAlive(pid);
  }
}

/** Quotes an argument for `cmd.exe`, which is the shell Node uses on Windows. */
function quoteForShell(arg: string): string {
  return /[\s"^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
