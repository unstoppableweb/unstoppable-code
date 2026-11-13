import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/** Host-only test seams; production composition uses NODE_SUPERVISION. */
export interface SupervisionOperations {
  readonly run: (
    file: string,
    args: readonly string[],
    signal?: AbortSignal,
    env?: Readonly<Record<string, string>>,
  ) => Promise<string>;
  readonly kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => void;
  readonly readText: (file: string, signal?: AbortSignal) => Promise<string>;
  readonly systemRoot: () => string;
  readonly selfPid: number;
  readonly windowsProcess?: (
    pid: number,
    signal?: AbortSignal,
  ) => Promise<string>;
}

export const NODE_SUPERVISION: SupervisionOperations = {
  run: async (file, args, signal, env): Promise<string> => {
    const { stdout } = await promisify(execFile)(file, [...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024,
      timeout: 4000,
      signal,
      env,
    });
    return stdout;
  },
  kill: (pid, signal): void => {
    process.kill(pid, signal);
  },
  readText: (file, signal): Promise<string> =>
    readFile(file, { encoding: 'utf8', signal }),
  systemRoot: (): string =>
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
  selfPid: process.pid,
};

export function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  return typeof error.code === 'string' || typeof error.code === 'number'
    ? error.code
    : undefined;
}

export function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error('Invalid supervised PID');
}

export function processPresent(
  pid: number,
  ops: SupervisionOperations,
): boolean {
  try {
    ops.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    if (errorCode(error) === 'EPERM') return true;
    throw error;
  }
}

export function windowsExecutable(root: string, name: string): string {
  const hasControl = Array.from(root).some((char) => char.charCodeAt(0) < 32);
  if (!/^[A-Za-z]:\\/.test(root) || hasControl)
    throw new Error('SystemRoot is not absolute');
  return path.win32.join(root, 'System32', name);
}

/**
 * libuv v1.51 `src/win/process.c` `required_vars`: a Windows child whose
 * block lacks one of these gets the host's value, so callers that hand over
 * a complete environment add each missing one empty.
 */
export const LIBUV_REQUIRED_KEYS = [
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const;
