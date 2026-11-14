import type {
  PlatformOperatingSystem,
  PlatformProcessGroup,
  PlatformProcessGroupMember,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';
import type { SupervisionOperations } from './shared';

const unverifiable = (reason: string): PlatformProcessGroup => ({
  state: 'unverifiable',
  reason,
});

/** USER_HZ: procfs reports start times in these ticks on every Linux ABI. */
const LINUX_TICKS_PER_SECOND = 100;

/** The most environment text read for one member; anything longer reads unreadable. */
const ENVIRONMENT_READ_LIMIT = 1024 * 1024;

type RunMarker = NonNullable<PlatformProcessGroupMember['runMarker']>;

/** `/proc/stat`'s `btime`: when the system booted, in epoch seconds. */
function linuxBootSeconds(stat: string): number | null {
  const match = /^btime (\d{1,12})$/m.exec(stat);
  return match ? Number(match[1]) : null;
}

/** `/proc/PID/status`: the real user ID, the first field of `Uid:`. */
function linuxUid(status: string): number | null {
  const match = /^Uid:\s+(\d{1,10})\s/m.exec(status);
  return match ? Number(match[1]) : null;
}

/**
 * Lists one process group's live members for a user's confirmed group Force
 * stop (CAN-6601). Each row the process table reports in the group is proven
 * with `identifyProcess`: a member that left the group or exited is left out,
 * and one that can't be read makes the whole list unverifiable, so nothing is
 * offered. Its start time comes from its start identity, read in UTC.
 *
 * With a run marker, each member's own environment is read, only when the
 * process belongs to this user, to see whether it carries the marker as one
 * whole entry: a NUL-separated entry on Linux; on macOS, a whitespace-
 * delimited token of the environment `ps -E` prints after the command line,
 * which is read separately and must be its exact prefix, so an argument never
 * counts. The text is read to a bound, searched for that one entry and
 * dropped; nothing else from it is kept, reported or logged.
 */
export function createProcessGroupLister(
  os: PlatformOperatingSystem,
  ops: Pick<SupervisionOperations, 'readText' | 'run' | 'selfUid'>,
  readTable: PlatformSupervisionServices['readProcessTable'],
  identify: NonNullable<PlatformSupervisionServices['identifyProcess']>,
): PlatformSupervisionServices['listProcessGroup'] {
  if (os === 'win32') return undefined;
  const startedAtMs = async (
    startIdentity: string,
    signal: AbortSignal | undefined,
  ): Promise<number | null> => {
    const darwin = /^darwin:v1:\d+:(\d{1,12})$/.exec(startIdentity);
    if (darwin) return Number(darwin[1]) * 1000;
    const linux = /^linux:v1:\d+:[\da-f-]+:(\d{1,20})$/.exec(startIdentity);
    if (!linux) return null;
    const boot = linuxBootSeconds(await ops.readText('/proc/stat', signal));
    if (boot === null) return null;
    return Math.floor(
      boot * 1000 + (Number(linux[1]) * 1000) / LINUX_TICKS_PER_SECOND,
    );
  };
  const env = { LC_ALL: 'C' };
  const sameUser = async (
    pid: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> => {
    if (ops.selfUid === undefined) return false;
    const uid =
      os === 'linux'
        ? linuxUid(await ops.readText(`/proc/${pid}/status`, signal))
        : Number(
            (
              await ops.run(
                '/bin/ps',
                ['-o', 'uid=', '-p', String(pid)],
                signal,
                env,
              )
            ).trim(),
          );
    return uid !== null && Number.isSafeInteger(uid) && uid === ops.selfUid;
  };
  /** Whether the member's environment holds `entry` whole; its text never leaves here. */
  const carries = async (
    pid: number,
    entry: string,
    signal: AbortSignal | undefined,
  ): Promise<RunMarker> => {
    try {
      if (!(await sameUser(pid, signal))) return 'unreadable';
      if (os === 'linux') {
        const text = await ops.readText(`/proc/${pid}/environ`, signal);
        if (text.length > ENVIRONMENT_READ_LIMIT) return 'unreadable';
        return text.split('\0').includes(entry) ? 'match' : 'absent';
      }
      // `ps -E` prints the command line, then the environment. The command
      // line, read on its own, must be its exact prefix; only the rest is
      // searched, so an argument never counts as the marker. ps joins
      // environment entries with spaces, so a value could only hold the
      // marker if the same user put this run's random id in it on purpose.
      const read = (args: string[]): Promise<string> =>
        ops.run(
          '/bin/ps',
          [...args, '-ww', '-o', 'command=', '-p', String(pid)],
          signal,
          env,
        );
      const command = (await read([])).replace(/\n$/, '');
      const text = (await read(['-E'])).replace(/\n$/, '');
      if (text.length > ENVIRONMENT_READ_LIMIT) return 'unreadable';
      if (command.length === 0 || !text.startsWith(command))
        return 'unreadable';
      const environment = text.slice(command.length);
      if (environment.length > 0 && !environment.startsWith(' '))
        return 'unreadable';
      return environment.split(' ').includes(entry) ? 'match' : 'absent';
    } catch {
      return 'unreadable';
    }
  };
  return async ({ processGroupId, runMarker, signal }) => {
    if (!Number.isSafeInteger(processGroupId) || processGroupId < 2)
      throw new Error('Invalid process group');
    const entry = runMarker && `${runMarker.name}=${runMarker.value}`;
    const table = await readTable({ signal });
    if (table.kind !== 'sampled') return unverifiable(table.reason);
    const members: PlatformProcessGroupMember[] = [];
    for (const row of table.rows.values()) {
      if (row.pgid !== processGroupId) continue;
      const found = await identify({ pid: row.pid, signal });
      if (found.state === 'absent') continue;
      if (found.state !== 'running') return unverifiable(found.reason);
      if (found.processGroupId !== processGroupId) continue;
      const started = await startedAtMs(found.startIdentity, signal).catch(
        () => null,
      );
      if (started === null)
        return unverifiable('a member’s start time is unreadable');
      let marker: RunMarker | undefined;
      if (entry !== undefined) {
        marker = await carries(row.pid, entry, signal);
        // The PID must still be the member that was read.
        const again = await identify({ pid: row.pid, signal });
        if (
          again.state !== 'running' ||
          again.startIdentity !== found.startIdentity
        )
          marker = 'unreadable';
      }
      members.push({
        pid: row.pid,
        startIdentity: found.startIdentity,
        startedAtMs: started,
        command: row.command,
        ...(marker !== undefined && { runMarker: marker }),
      });
    }
    return {
      state: 'listed',
      members: members.sort((a, b) => a.pid - b.pid),
    };
  };
}
