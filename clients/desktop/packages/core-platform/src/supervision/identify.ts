import type {
  PlatformOperatingSystem,
  PlatformProcessIdentity,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';
import {
  errorCode,
  processPresent,
  validatePid,
  type SupervisionOperations,
} from './shared';

type Details = { readonly group: number; readonly executable: string };

const unverifiable = (reason: string): PlatformProcessIdentity => ({
  state: 'unverifiable',
  reason,
});

function validGroup(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9]\d{0,9}$/.test(value.trim())) return null;
  const group = Number(value.trim());
  return Number.isSafeInteger(group) ? group : null;
}

/** `/proc/PID/stat`: comm ends at the last ')'; pgrp is the third field after it. */
function linuxGroup(stat: string, pid: number): number | null {
  const close = stat.lastIndexOf(')');
  if (!stat.startsWith(`${pid} (`) || close < 0) return null;
  return validGroup(stat.slice(close + 2).split(' ')[2]);
}

/** `lsof -Fn` lists names as `n<path>`; a process's first text file is its executable. */
function darwinExecutable(lsof: string): string | null {
  const name = lsof
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1);
  return name !== undefined && name.startsWith('/') ? name : null;
}

/**
 * Reads a process's start identity, process group and executable path for a
 * reap that must prove the process is the one it recorded (CAN-6482). The
 * start identity is read before and after the rest, so a PID reused between
 * the reads is never reported as one process. Windows reports unverifiable
 * until its observer reports the image path, so nothing is reaped there.
 */
export function createProcessIdentifier(
  os: PlatformOperatingSystem,
  ops: SupervisionOperations,
  inspect: PlatformSupervisionServices['inspectProcess'],
): NonNullable<PlatformSupervisionServices['identifyProcess']> {
  const details = async (
    pid: number,
    signal: AbortSignal | undefined,
  ): Promise<Details | string> => {
    if (os === 'linux') {
      const group = linuxGroup(
        await ops.readText(`/proc/${pid}/stat`, signal),
        pid,
      );
      if (group === null) return 'process group is unreadable';
      if (!ops.readLink) return 'executable path is unreadable';
      const executable = await ops.readLink(`/proc/${pid}/exe`);
      return executable.startsWith('/')
        ? { group, executable }
        : 'executable path is unreadable';
    }
    if (os === 'darwin') {
      const env = { LC_ALL: 'C' };
      const group = validGroup(
        await ops.run(
          '/bin/ps',
          ['-o', 'pgid=', '-p', String(pid)],
          signal,
          env,
        ),
      );
      if (group === null) return 'process group is unreadable';
      const executable = darwinExecutable(
        await ops.run(
          '/usr/sbin/lsof',
          ['-a', '-w', '-p', String(pid), '-d', 'txt', '-Fn'],
          signal,
          env,
        ),
      );
      return executable === null
        ? 'executable path is unreadable'
        : { group, executable };
    }
    return 'executable path is unavailable on this platform';
  };

  return async ({ pid, signal }) => {
    validatePid(pid);
    const before = await inspect({ pid, signal });
    if (before.state !== 'running') return before;
    let found: Details | string;
    try {
      found = await details(pid, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return processPresent(pid, ops)
        ? unverifiable(
            `process query failed (${errorCode(error) ?? 'unknown'})`,
          )
        : { state: 'absent' };
    }
    if (typeof found === 'string') return unverifiable(found);
    const after = await inspect({ pid, signal });
    if (after.state !== 'running') return after;
    if (after.startIdentity !== before.startIdentity)
      return unverifiable('the process changed while it was read');
    return {
      state: 'running',
      startIdentity: before.startIdentity,
      processGroupId: found.group,
      executablePath: found.executable,
    };
  };
}
