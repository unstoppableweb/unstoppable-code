// CAN-6601: an orphaned run's group members, each checked for the run's own
// marker. Only a whole entry counts, only the same user's process is read,
// and nothing from an environment ever leaves the lister.
import type {
  PlatformProcessIdentity,
  PlatformProcessTable,
} from '@canopy/core-runtime';
import { createProcessGroupLister } from '../supervision/process-group-members';

const GROUP = 700;
const MARKER = { name: 'CANOPY_SCRIPT_RUN_ID', value: 'run-1' };
const SECRET = 'sk-live-do-not-leak';

function lister(
  os: 'linux' | 'darwin',
  environments: Record<number, string>,
  uids: Record<number, number> = {},
): NonNullable<ReturnType<typeof createProcessGroupLister>> {
  const pids = Object.keys(environments).map(Number);
  const table: PlatformProcessTable = {
    kind: 'sampled',
    rows: new Map(
      pids.map((pid) => [
        pid,
        {
          pid,
          ppid: 1,
          pgid: GROUP,
          cpuPercent: 0,
          memoryRssBytes: 0,
          command: 'sleep',
        },
      ]),
    ),
  };
  const identify = ({
    pid,
  }: {
    pid: number;
  }): Promise<PlatformProcessIdentity> =>
    Promise.resolve({
      state: 'running',
      startIdentity:
        os === 'darwin'
          ? `darwin:v1:${pid}:1700000000`
          : `linux:v1:${pid}:0b1d:100`,
      processGroupId: GROUP,
      executablePath: '/bin/sleep',
    });
  const listed = createProcessGroupLister(
    os,
    {
      selfUid: 501,
      readText: (file) => {
        if (file === '/proc/stat')
          return Promise.resolve('cpu 1\nbtime 1700000000\n');
        const pid = Number(file.split('/')[2]);
        if (file.endsWith('/status'))
          return Promise.resolve(
            `Name:\tsleep\nUid:\t${uids[pid] ?? 501}\t501\t501\t501\n`,
          );
        return Promise.resolve(environments[pid] ?? '');
      },
      run: (_file, args) => {
        const pid = Number(args[args.length - 1]);
        if (args.includes('uid='))
          return Promise.resolve(` ${uids[pid] ?? 501}\n`);
        // macOS: the command line, then a tab, then the environment ps -E
        // adds after it.
        const [command = '', environment = ''] = (
          environments[pid] ?? ''
        ).split('\t');
        return Promise.resolve(
          args.includes('-E')
            ? `${command}${environment ? ` ${environment}` : ''}\n`
            : `${command}\n`,
        );
      },
    },
    () => Promise.resolve(table),
    identify,
  );
  if (!listed) throw new Error('No lister.');
  return listed;
}

it('matches only the whole marker entry in a Linux environ, and never returns the environment', async () => {
  const list = lister(
    'linux',
    {
      11: `PATH=/bin\0CANOPY_SCRIPT_RUN_ID=run-1\0TOKEN=${SECRET}\0`,
      12: `PATH=/bin\0CANOPY_SCRIPT_RUN_ID=run-10\0`,
      13: `X=CANOPY_SCRIPT_RUN_ID=run-1\0`,
      14: `PATH=/bin\0CANOPY_SCRIPT_RUN_ID=run-1\0`,
    },
    { 14: 0 },
  );
  const result = await list({ processGroupId: GROUP, runMarker: MARKER });
  expect(
    result.state === 'listed' &&
      result.members.map((m) => [m.pid, m.runMarker]),
  ).toEqual([
    [11, 'match'],
    [12, 'absent'],
    [13, 'absent'],
    // Another user's process: its environment is never read.
    [14, 'unreadable'],
  ]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(JSON.stringify(result)).not.toContain('PATH=');
});

it('matches only a whole token of the environment ps -E prints after the command line on macOS, never an argument', async () => {
  const list = lister('darwin', {
    21: `/usr/local/bin/node server.js\tPATH=/bin CANOPY_SCRIPT_RUN_ID=run-1 TOKEN=${SECRET}`,
    // An argument that is exactly the marker, with no such environment entry.
    22: '/usr/local/bin/node CANOPY_SCRIPT_RUN_ID=run-1\tPATH=/bin',
    23: '/bin/sh -c echo--CANOPY_SCRIPT_RUN_ID=run-1\tPATH=/bin',
    // No environment shown, as for Apple's own programs.
    24: '/bin/sleep 300\t',
  });
  const result = await list({ processGroupId: GROUP, runMarker: MARKER });
  expect(
    result.state === 'listed' &&
      result.members.map((m) => [m.pid, m.runMarker]),
  ).toEqual([
    [21, 'match'],
    [22, 'absent'],
    [23, 'absent'],
    [24, 'absent'],
  ]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

it('reads no environment without a marker request', async () => {
  const list = lister('linux', { 31: `TOKEN=${SECRET}\0` });
  const result = await list({ processGroupId: GROUP });
  expect(result.state === 'listed' && result.members[0]).not.toHaveProperty(
    'runMarker',
  );
});
