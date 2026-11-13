import { promisify } from 'node:util';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LinuxColdInspectionError,
  observeLinuxColdProcess,
  observeLinuxColdProcesses,
  type LinuxColdIO,
  type LinuxColdRefusal,
} from '../internal-root-cold/linux';
import type { NativeColdProcess } from '../internal-root-cold/types';
import {
  observeWindowsColdProcess,
  observeWindowsColdProcesses,
  parseWindowsColdObservation,
} from '../internal-root-cold/windows';

const helper = resolve(
  __dirname,
  '../../../..',
  '.cache/bin/win32-x64/canopy-process-identity.exe',
);
const boot = '01234567-0123-0123-0123-0123456789ab';
const stat = (pid: number, start = '9007199254740993'): string =>
  `${pid} (name with ) parens) S 1 ${Array(17).fill('0').join(' ')} ${start} 0\n`;
function fixture(): LinuxColdIO {
  return {
    pin: () => Promise.resolve({ dev: 2049n, ino: 1n, mountId: '10' }),
    entry: () =>
      Promise.resolve({
        dev: 2049n,
        ino: 2n,
        mode: 0o040700n,
        ctimeNs: 0n,
        mtimeNs: 0n,
      }),
    identity: () => Promise.resolve({ dev: 2049n, ino: 1n }),
    text: (file) =>
      Promise.resolve().then(() => {
        if (file === '/proc/self/mountinfo')
          return '10 0 8:1 / / rw - ext4 /dev/sda1 rw\n1 10 0:1 / /proc rw - proc proc rw\n';
        if (file === '/proc/sys/kernel/random/boot_id') return `${boot}\n`;
        const pid = /\/proc\/(\d+)/.exec(file)?.[1];
        if (file.endsWith('/stat')) return stat(Number(pid));
        if (file.endsWith('/status')) return 'Uid:\t1000\t1000\t1000\t1000\n';
        if (file.endsWith('/maps'))
          return '1000-2000 r--p 00000000 08:01 1 /some file with spaces\n3000-4000 rw-p 00000000 00:00 0 [anon: [v8] heap]\n';
        throw new Error(`Unexpected text ${file}`);
      }),
    list: (file) =>
      Promise.resolve().then(() => {
        if (file === '/proc') return [String(process.pid), '7', 'sys'];
        if (file.endsWith('/task')) return [file.split('/')[2] ?? ''];
        if (file.endsWith('/fd')) return ['0', '1'];
        throw new Error(`Unexpected list ${file}`);
      }),
    link: (file) =>
      Promise.resolve().then(() => {
        if (/\/ns\/(mnt|user|pid)$/.test(file))
          return `${file.slice(file.lastIndexOf('/') + 1)}:[123]`;
        if (file.endsWith('/root')) return '/';
        if (file.endsWith('/exe')) return '/usr/bin/node';
        if (file.endsWith('/cwd')) return '/unrelated';
        if (file.endsWith('/fd/0')) return '/affected/file';
        if (file.endsWith('/fd/1')) return 'socket:[123]';
        throw new Error(`Unexpected link ${file}`);
      }),
  };
}

async function expectLinuxRefusal(
  observation: Promise<readonly NativeColdProcess[]>,
  expected: Partial<LinuxColdRefusal>,
): Promise<void> {
  try {
    await observation;
  } catch (error) {
    if (!(error instanceof LinuxColdInspectionError)) throw error;
    expect(error.name).toBe('LinuxColdInspectionError');
    expect(error.code).toBe('inspection-incomplete');
    expect(
      error.refusals.find((row) => row.pid === expected.pid),
    ).toMatchObject(expected);
    return;
  }
  throw new Error('Expected incomplete Linux cold inspection');
}

it('observes a complete same-user snapshot without argv and preserves lossless Linux identity', async () => {
  const io = fixture();
  let mountReads = 0;
  const rows = await observeLinuxColdProcesses({
    uid: 1000,
    io: {
      ...io,
      text: async (file) => {
        if (file === '/proc/self/mountinfo') mountReads++;
        return io.text(file);
      },
    },
  });
  expect(mountReads).toBe(2);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.pid === 7)).toMatchObject({
    parentPid: 1,
    startIdentity: `linux:v1:7:${boot}:9007199254740993`,
    executable: '/usr/bin/node',
  });
  expect(rows.find((row) => row.pid === 7)?.paths).toEqual(
    expect.arrayContaining(['/affected/file', '/some file with spaces']),
  );
});
it('admits only a corroborated Linux user-manager/PAM pair in a complete snapshot', async () => {
  for (const parent of [10, 1]) {
    const io = fixture();
    const observation = observeLinuxColdProcesses({
      uid: 1000,
      io: {
        ...io,
        list: async (file) =>
          file === '/proc' ? [String(process.pid), '10', '11'] : io.list(file),
        text: async (file) => {
          if (file === '/proc/10/stat')
            return stat(10).replace('(name with ) parens)', '(systemd)');
          if (file === '/proc/11/stat')
            return stat(11)
              .replace('(name with ) parens)', '((sd-pam))')
              .replace(' S 1 ', ` S ${parent} `);
          if (file.endsWith('/cgroup'))
            return '0::/user.slice/user-1000.slice/user@1000.service/init.scope\n';
          return io.text(file);
        },
        link: async (file) => {
          if (/^\/proc\/(10|11)\/task\/\d+\/ns\/mnt$/.test(file))
            throw Object.assign(new Error('denied'), {
              code: 'EACCES',
              path: file,
            });
          return io.link(file);
        },
      },
    });
    if (parent === 10)
      await expect(observation).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pid: 10,
            scope: 'linux-user-manager',
            executable: 'systemd',
          }),
          expect.objectContaining({
            pid: 11,
            scope: 'linux-user-manager',
            executable: '(sd-pam)',
            parentPid: 10,
          }),
        ]),
      );
    else await expectLinuxRefusal(observation, { pid: 11, comm: '(sd-pam)' });
  }
});
it('refuses incomplete Linux observations rather than dropping rows', async () => {
  for (const failure of [
    'hidepid',
    'missing-self',
    'permission',
    'malformed',
    'reuse',
    'fd-race',
    'thread-race',
    'namespace',
    'user-namespace',
    'pid-namespace',
    'namespace-race',
    'root-race',
    'principal-race',
    'new-process',
  ]) {
    const io = fixture();
    let stats = 0,
      statuses = 0,
      lists = 0,
      threads = 0,
      namespaces = 0,
      roots = 0;
    const altered: LinuxColdIO = {
      ...io,
      text: async (file) => {
        if (failure === 'hidepid' && file.endsWith('/mountinfo'))
          return '1 0 0:1 / /proc rw - proc proc rw,hidepid=2\n';
        if (file === '/proc/7/status' && failure === 'permission')
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        if (file === '/proc/7/stat') {
          stats++;
          if (failure === 'malformed') return 'bad stat';
          if (failure === 'reuse' && stats > 1)
            return stat(7, '9007199254740994');
        }
        if (
          file === '/proc/7/status' &&
          failure === 'principal-race' &&
          ++statuses > 2
        )
          return 'Uid:\t1001\t1001\t1001\t1001\n';
        return io.text(file);
      },
      link: async (file) => {
        if (failure === 'fd-race' && file.endsWith('/fd/0'))
          throw Object.assign(new Error('closed'), { code: 'ENOENT' });
        if (
          file === '/proc/7/task/7/ns/mnt' &&
          (failure === 'namespace' ||
            (failure === 'namespace-race' && ++namespaces > 1))
        )
          return 'mnt:[other]';
        if (
          (failure === 'user-namespace' && file === '/proc/7/task/7/ns/user') ||
          (failure === 'pid-namespace' && file === '/proc/7/task/7/ns/pid')
        )
          return 'namespace:[other]';
        if (
          failure === 'root-race' &&
          file === '/proc/7/task/7/root' &&
          ++roots > 1
        )
          return '/different-root';
        return io.link(file);
      },
      list: async (file) => {
        if (file === '/proc') {
          if (failure === 'missing-self') return ['7'];
          if (failure === 'new-process' && ++lists > 1)
            return [String(process.pid), '7', '8'];
        }
        if (
          file === '/proc/7/task' &&
          failure === 'thread-race' &&
          ++threads > 1
        )
          return ['7', '8'];
        return io.list(file);
      },
    };
    const observation = observeLinuxColdProcesses({ io: altered, uid: 1000 });
    if (
      [
        'namespace',
        'user-namespace',
        'pid-namespace',
        'namespace-race',
      ].includes(failure)
    ) {
      const namespace =
        failure === 'user-namespace'
          ? 'user'
          : failure === 'pid-namespace'
            ? 'pid'
            : 'mnt';
      await expectLinuxRefusal(observation, {
        pid: 7,
        reason: 'Process namespace cannot be inspected in host scope',
        differingNamespaces: [namespace],
      });
    } else if (failure === 'root-race') {
      await expectLinuxRefusal(observation, {
        pid: 7,
        reason: 'Process root cannot be inspected in host scope',
      });
    } else await expect(observation).rejects.toThrow();
  }
});

function assertProcessMappingReference(file: string): void {
  if (file.includes('/map_files/') && !/^\/proc\/\d+\/map_files\//.test(file))
    throw Object.assign(new Error(`ENOENT: open '${file}'`), {
      code: 'ENOENT',
      path: file,
    });
}
function privateMountFixture(scenario: string, affected: boolean): LinuxColdIO {
  const io = fixture();
  const baseMounts =
    '10 0 8:1 / / rw - ext4 /dev/sda1 rw\n1 10 0:1 / /proc rw - proc proc rw\n';
  const aliasSource = affected ? '/target' : '/elsewhere';
  const mounted = `${baseMounts}20 10 8:1 ${aliasSource} /alias rw - ext4 /dev/sda1 rw\n`;
  const file =
    scenario === 'identity-only'
      ? '/hardlink'
      : scenario === 'deleted'
        ? '/alias/gone (deleted)'
        : '/alias/database';
  const inode = scenario === 'deleted' ? 500n : affected ? 200n : 300n;
  return {
    ...io,
    pin: (name) => {
      assertProcessMappingReference(name);
      if (scenario === 'memfd-fd' && name.endsWith('/fd/0'))
        return Promise.resolve({ dev: 1n, ino: 500n, mountId: '0' });
      if (name.includes('/map_files/'))
        return Promise.resolve({ dev: 2049n, ino: 500n, mountId: '20' });
      const selected =
        scenario === 'cwd' ? '/cwd' : scenario === 'exe' ? '/exe' : '/fd/0';
      const usesAlias =
        ['fd', 'deleted', 'identity-only', 'cwd', 'exe'].includes(scenario) &&
        name.endsWith(selected);
      return Promise.resolve({
        dev: 2049n,
        ino: usesAlias ? inode : 1n,
        mountId: usesAlias && scenario !== 'identity-only' ? '20' : '10',
      });
    },
    entry: (file) =>
      Promise.resolve({
        dev: 2049n,
        ino: file === '/target' ? 100n : 200n,
        mode: file === '/target' ? 0o040700n : 0o100600n,
        ctimeNs: 0n,
        mtimeNs: 0n,
      }),
    list: async (file) => (file === '/target' ? ['database'] : io.list(file)),
    text: async (name) => {
      if (name.endsWith('/mountinfo'))
        return name === '/proc/self/mountinfo' ? baseMounts : mounted;
      if (name.endsWith('/maps')) {
        if (scenario === 'maps' || scenario === 'deleted-maps')
          return `1000-2000 r--p 00000000 08:01 ${scenario === 'deleted-maps' ? 500n : inode} /alias/${scenario === 'deleted-maps' ? 'gone (deleted)' : 'database'}\n`;
        if (scenario === 'anonymous')
          return '1000-2000 rw-p 00000000 00:00 0\n2000-3000 rw-p 00000000 00:00 0 [anon: [v8] heap]\n';
        if (scenario === 'named-shmem')
          return `1000-2000 rw-s 00000000 08:01 ${inode} [anon_shmem:fixture]\n`;
        if (scenario === 'memfd')
          return '1000-2000 rw-s 00000000 00:01 500 /memfd:fixture (deleted)\n';
        return '';
      }
      return io.text(name);
    },
    link: async (name) => {
      if (name === '/proc/7/task/7/ns/mnt') return 'mnt:[456]';
      if (scenario === 'memfd-fd' && name.endsWith('/fd/0'))
        return '/memfd:fixture (deleted)';
      if (name.endsWith('/fd/0'))
        return ['fd', 'deleted', 'identity-only'].includes(scenario)
          ? file
          : '/outside';
      if (name.endsWith('/cwd') && scenario === 'cwd') return file;
      if (name.endsWith('/exe') && scenario === 'exe') return file;
      return io.link(name);
    },
    identity: async (name) => {
      const selected =
        scenario === 'cwd' ? '/cwd' : scenario === 'exe' ? '/exe' : '/fd/0';
      if (
        (['fd', 'deleted', 'identity-only', 'cwd', 'exe'].includes(scenario) &&
          name.endsWith(selected)) ||
        name.endsWith(`/root${file.replace(/ \(deleted\)$/, '')}`)
      )
        return { dev: 2049n, ino: inode };
      return io.identity(name);
    },
  };
}
it.each([
  'cwd',
  'exe',
  'fd',
  'identity-only',
  'deleted',
  'maps',
  'deleted-maps',
  'named-shmem',
])(
  'inspects private mount %s references against complete target membership (fixture only)',
  async (scenario) => {
    for (const affected of [false, true]) {
      const observed = await observeLinuxColdProcess(
        7,
        privateMountFixture(scenario, affected),
        ['/target'],
      );
      expect(observed.linuxPrivateMountUse).toEqual({
        roots: ['/target'],
        affected,
      });
      expect(observed.paths).toEqual([]);
    }
  },
);
it.each(['anonymous', 'memfd', 'memfd-fd'])(
  'admits unrelated private mount %s mappings without privileged map_files access (fixture only)',
  async (scenario) => {
    const observed = await observeLinuxColdProcess(
      7,
      privateMountFixture(scenario, false),
      ['/target'],
    );
    expect(observed.linuxPrivateMountUse?.affected).toBe(false);
  },
);
function btrfsMappingFixture(
  file: string,
  affected: boolean,
  inode = 200n,
): LinuxColdIO {
  const io = privateMountFixture('anonymous', false);
  const mounts =
    '10 0 8:1 /@ / rw - btrfs /dev/sda1 rw\n' +
    '1 10 0:1 / /proc rw - proc proc rw\n' +
    '20 10 8:1 /@home /target rw - btrfs /dev/sda1 rw\n';
  const dev = affected ? 42n : 43n;
  return {
    ...io,
    text: (name) =>
      name.endsWith('/mountinfo')
        ? Promise.resolve(mounts)
        : name.endsWith('/maps')
          ? Promise.resolve(`1000-2000 r--p 00000000 08:01 ${inode} ${file}\n`)
          : io.text(name),
    entry: async (name) => ({ ...(await io.entry(name)), dev: 42n }),
    identity: async (name) =>
      file.startsWith('/') && name.endsWith(`/root${file}`)
        ? { dev, ino: inode }
        : { ...(await io.identity(name)), dev: 43n },
    pin: async (name) => {
      assertProcessMappingReference(name);
      if (!name.includes('/map_files/'))
        return { ...(await io.pin(name)), dev: 43n };
      return {
        dev,
        ino: inode,
        mountId: file.startsWith('/target/') ? '20' : '10',
      };
    },
  };
}
it.each(
  ['deleted-ext4', 'deleted-btrfs', 'collision-btrfs'].flatMap((scenario) =>
    [
      { raw: '00400000-00452000', canonical: '400000-452000' },
      { raw: '00001000-00002000', canonical: '1000-2000' },
      { raw: '00000000-00001000', canonical: '0-1000' },
      {
        raw: '7fffffff0000-7fffffff1000',
        canonical: '7fffffff0000-7fffffff1000',
      },
    ].map((address) => ({ scenario, ...address })),
  ),
)(
  'pins padded low mappings by the kernel map_files name ($scenario, $raw, fixture only)',
  async ({ scenario, raw, canonical }) => {
    const io =
      scenario === 'deleted-ext4'
        ? privateMountFixture('deleted-maps', false)
        : btrfsMappingFixture(
            `/usr/lib/unrelated.so${scenario === 'deleted-btrfs' ? ' (deleted)' : ''}`,
            false,
          );
    const pins: string[] = [];
    const observed = await observeLinuxColdProcess(
      7,
      {
        ...io,
        text: async (file) => {
          const text = await io.text(file);
          return file.endsWith('/maps') ? text.replace('1000-2000', raw) : text;
        },
        pin: (file) => {
          if (file.includes('/map_files/')) {
            pins.push(file);
            if (file !== `/proc/7/map_files/${canonical}`)
              return Promise.reject(
                Object.assign(new Error('noncanonical map_files address'), {
                  code: 'ENOENT',
                  path: file,
                }),
              );
          }
          return io.pin(file);
        },
      },
      ['/target'],
    );
    expect(observed.linuxPrivateMountUse).toEqual({
      roots: ['/target'],
      affected: false,
    });
    expect(pins).toEqual([
      `/proc/7/map_files/${canonical}`,
      `/proc/7/map_files/${canonical}`,
    ]);
  },
);
it.each(
  ['deleted-ext4', 'deleted-btrfs', 'collision-btrfs'].flatMap((scenario) =>
    [7, 8].flatMap((tid) =>
      [
        { access: 'readable', code: null, failAt: 0 },
        ...['EPERM', 'ENOENT', 'ESRCH'].flatMap((code) =>
          [1, 2].map((failAt) => ({
            access: `${code} at pin ${failAt}`,
            code,
            failAt,
          })),
        ),
      ].map((failure) => ({ scenario, tid, ...failure })),
    ),
  ),
)(
  'uses process-level map_files for $scenario on thread $tid with $access access (fixture only)',
  async ({ scenario, tid, code, failAt }) => {
    const io =
      scenario === 'deleted-ext4'
        ? privateMountFixture('deleted-maps', false)
        : btrfsMappingFixture(
            `/usr/lib/unrelated.so${scenario === 'deleted-btrfs' ? ' (deleted)' : ''}`,
            false,
          );
    const pins: string[] = [];
    const reference = '/proc/7/map_files/1000-2000';
    let mappingThread = 7;
    let selectedThreadPins = 0;
    let enumerations = 0;
    const observation = observeLinuxColdProcesses({
      uid: 1000,
      roots: ['/target'],
      io: {
        ...io,
        list: (file) => {
          if (file === '/proc') enumerations++;
          return file === '/proc/7/task'
            ? Promise.resolve(tid === 7 ? ['7'] : ['7', '8'])
            : io.list(file);
        },
        text: (file) => {
          if (file === '/proc/7/task/8/stat') return Promise.resolve(stat(8));
          // Threads share mappings; fail only while inspecting the selected thread.
          if (file === '/proc/7/task/7/maps') mappingThread = 7;
          if (file === '/proc/7/task/8/maps') mappingThread = 8;
          return io.text(file);
        },
        link: (file) => io.link(file.replace('/task/8/', '/task/7/')),
        pin: (file) => {
          assertProcessMappingReference(file);
          if (file.includes('/map_files/')) {
            pins.push(file);
            if (
              mappingThread === tid &&
              ++selectedThreadPins === failAt &&
              code !== null
            )
              return Promise.reject(
                Object.assign(new Error(`${code}: open '${file}'`), {
                  code,
                  path: file,
                }),
              );
          }
          return io.pin(file);
        },
      },
    });
    if (code !== null)
      await expectLinuxRefusal(observation, {
        pid: 7,
        reason: `${code}: open '${reference}'`,
      });
    else
      expect((await observation).find((row) => row.pid === 7)).toMatchObject({
        linuxPrivateMountUse: { roots: ['/target'], affected: false },
      });
    const pinCount = (tid === 8 ? 2 : 0) + (code === null ? 2 : failAt);
    expect(pins).toEqual(Array.from({ length: pinCount }, () => reference));
    expect(enumerations).toBe(2);
  },
);
it.each(['shared', 'private'])(
  'disambiguates cross-subvolume btrfs mapping inode collisions in %s roots-bound inspection (fixture only)',
  async (namespace) => {
    for (const [file, affected] of [
      ['/usr/lib/unrelated.so', false],
      ['/target/database', true],
      ['/hardlink', true],
      ['/usr/lib/unrelated.so (deleted)', false],
      ['/target/database (deleted)', true],
      ['/hardlink (deleted)', true],
      ['', true],
      ['[anon_shmem:fixture]', true],
    ] satisfies readonly (readonly [string, boolean])[]) {
      const io = btrfsMappingFixture(file, affected);
      const observed = await observeLinuxColdProcess(
        7,
        {
          ...io,
          link: (name) =>
            namespace === 'shared' && name === '/proc/7/task/7/ns/mnt'
              ? Promise.resolve('mnt:[123]')
              : io.link(name),
        },
        ['/target'],
      );
      // Pathless collisions remain ambiguous and must conservatively refuse.
      expect({ file, use: observed.linuxPrivateMountUse }).toEqual({
        file,
        use: { roots: ['/target'], affected },
      });
    }
  },
);
it.each([200n, 201n])(
  'requires readable map_files only for a btrfs inode collision (inode=%s, fixture only)',
  async (inode) => {
    const io = btrfsMappingFixture('/usr/lib/unrelated.so', false, inode);
    const observation = observeLinuxColdProcesses({
      uid: 1000,
      roots: ['/target'],
      io: {
        ...io,
        pin: (name) =>
          name.includes('/map_files/')
            ? Promise.reject(
                Object.assign(new Error('map_files collision pin denied'), {
                  code: 'EPERM',
                  path: name,
                }),
              )
            : io.pin(name),
      },
    });
    if (inode === 200n)
      await expectLinuxRefusal(observation, {
        pid: 7,
        reason: 'map_files collision pin denied',
      });
    else
      expect((await observation).find((row) => row.pid === 7)).toMatchObject({
        linuxPrivateMountUse: { roots: ['/target'], affected: false },
      });
  },
);
it('detects an affected btrfs hardlink mapping hidden by a colliding subvolume pathname (fixture only)', async () => {
  const io = btrfsMappingFixture('/usr/lib/unrelated.so', false);
  const observed = await observeLinuxColdProcess(
    7,
    {
      ...io,
      pin: async (name) => ({
        ...(await io.pin(name)),
        ...(name.includes('/map_files/') ? { dev: 42n } : {}),
      }),
    },
    ['/target'],
  );
  expect(observed.linuxPrivateMountUse).toEqual({
    roots: ['/target'],
    affected: true,
  });
});
it.each(
  ['live', 'deleted'].flatMap((kind) =>
    ['device', 'inode', 'mount', 'unreadable'].map((change) => ({
      kind,
      change,
    })),
  ),
)(
  'refuses a $kind btrfs map_files pin with a changed $change even when maps bytes are stable (fixture only)',
  async ({ kind, change }) => {
    const io = btrfsMappingFixture(
      `/usr/lib/unrelated.so${kind === 'deleted' ? ' (deleted)' : ''}`,
      false,
    );
    let pins = 0;
    await expect(
      observeLinuxColdProcess(
        7,
        {
          ...io,
          pin: async (name) => {
            const identity = await io.pin(name);
            if (!name.includes('/map_files/') || ++pins === 1) return identity;
            if (change === 'unreadable')
              throw Object.assign(new Error('map_files recheck denied'), {
                code: 'EPERM',
                path: name,
              });
            return {
              ...identity,
              ...(change === 'device' ? { dev: 42n } : {}),
              ...(change === 'inode' ? { ino: 201n } : {}),
              ...(change === 'mount' ? { mountId: '20' } : {}),
            };
          },
        },
        ['/target'],
      ),
    ).rejects.toMatchObject({
      code: 'inspection-incomplete',
      pid: 7,
      refusals: [
        expect.objectContaining({
          pid: 7,
          reason:
            change === 'unreadable'
              ? 'map_files recheck denied'
              : 'Proc mapping reference changed',
        }),
      ],
    });
  },
);
it.each(
  ['live', 'deleted'].flatMap((kind) =>
    ['denied', 'inode-race', 'mount-race', 'detached-mount'].map((failure) => ({
      kind,
      failure,
    })),
  ),
)(
  'refuses a $failure $kind btrfs mapping despite a disjoint pathname (fixture only)',
  async ({ kind, failure }) => {
    const io = btrfsMappingFixture(
      `/usr/lib/unrelated.so${kind === 'deleted' ? ' (deleted)' : ''}`,
      false,
    );
    await expect(
      observeLinuxColdProcess(
        7,
        {
          ...io,
          pin: async (name) => {
            if (!name.includes('/map_files/')) return io.pin(name);
            if (failure === 'denied')
              throw Object.assign(new Error('map_files denied'), {
                code: 'EPERM',
                path: name,
              });
            return {
              ...(await io.pin(name)),
              ...(failure === 'inode-race'
                ? { ino: 201n }
                : { mountId: failure === 'detached-mount' ? '999' : '1' }),
            };
          },
        },
        ['/target'],
      ),
    ).rejects.toMatchObject({ code: 'inspection-incomplete', pid: 7 });
  },
);
it.each(['shared', 'private'])(
  'admits disjoint memfd descriptors and mappings in a %s mount namespace',
  async (namespace) => {
    for (const mountId of ['0', '999']) {
      const io = privateMountFixture('memfd-fd', false);
      const observed = await observeLinuxColdProcess(
        7,
        {
          ...io,
          link: (file) =>
            file.endsWith('/fd/0')
              ? Promise.resolve('/memfd:fixture\nname (deleted)')
              : namespace === 'shared' && file === '/proc/7/task/7/ns/mnt'
                ? Promise.resolve('mnt:[123]')
                : io.link(file),
          pin: async (file) => ({
            ...(await io.pin(file)),
            ...(file.endsWith('/fd/0') ? { mountId } : {}),
          }),
          text: (file) =>
            file.endsWith('/maps')
              ? Promise.resolve(
                  '1000-2000 rw-s 00000000 00:01 500 /memfd:fixture (deleted)\n',
                )
              : io.text(file),
          identity: (file) =>
            file.includes('/root/memfd:')
              ? Promise.reject(
                  new Error('Kernel shmem has no filesystem projection'),
                )
              : io.identity(file),
        },
        ['/target'],
      );
      expect(observed.linuxPrivateMountUse).toEqual({
        roots: ['/target'],
        affected: false,
      });
    }
  },
);
it.each(['0', '10'])(
  'does not exempt a deleted filesystem file named like memfd (mount=%s)',
  async (mountId) => {
    const io = privateMountFixture('memfd-fd', false);
    const observation = observeLinuxColdProcess(
      7,
      {
        ...io,
        pin: (file) =>
          file.endsWith('/fd/0')
            ? Promise.resolve({ dev: 2049n, ino: 200n, mountId })
            : io.pin(file),
      },
      ['/target'],
    );
    if (mountId === '0')
      await expect(observation).rejects.toMatchObject({
        code: 'inspection-incomplete',
        pid: 7,
      });
    else expect((await observation).linuxPrivateMountUse?.affected).toBe(true);
  },
);
it.each(
  ['shared', 'private'].flatMap((namespace) =>
    ['denied', 'unresolved'].flatMap((reference) =>
      ['00:01', '00:37', '08:02'].map((device) => ({
        namespace,
        reference,
        device,
      })),
    ),
  ),
)(
  'admits disjoint deleted and pathless mappings on $device in a $namespace mount namespace with $reference map_files',
  async ({ namespace, reference, device }) => {
    const io = privateMountFixture('anonymous', false);
    const mappingPins: string[] = [];
    const observed = await observeLinuxColdProcess(
      7,
      {
        ...io,
        link: (file) =>
          namespace === 'shared' && file === '/proc/7/task/7/ns/mnt'
            ? Promise.resolve('mnt:[123]')
            : io.link(file),
        text: (file) =>
          file.endsWith('/maps')
            ? Promise.resolve(
                [
                  '/dev/zero (deleted)',
                  '/memfd:fixture (deleted)',
                  '/SYSV00000000 (deleted)',
                  '/target/removed (deleted)',
                  '[anon_shmem:fixture]',
                  '',
                ]
                  .map(
                    (name, index) =>
                      `${index + 1}000-${index + 2}000 rw-s 00000000 ${device} 200${name ? ` ${name}` : ''}\n`,
                  )
                  .join(''),
              )
            : io.text(file),
        pin: (file) => {
          if (!file.includes('/map_files/')) return io.pin(file);
          mappingPins.push(file);
          if (reference === 'denied')
            return Promise.reject(new Error('map_files denied'));
          return Promise.resolve({
            dev: device === '08:02' ? 2050n : device === '00:37' ? 55n : 1n,
            ino: 200n,
            mountId: '0',
          });
        },
      },
      ['/target'],
    );
    expect(observed.linuxPrivateMountUse).toEqual({
      roots: ['/target'],
      affected: false,
    });
    expect(mappingPins).toEqual([]);
  },
);
it.each(
  ['shared', 'private'].flatMap((namespace) =>
    ['ambiguous-shmem', 'disk-file', 'device-inode'].map((kind) => ({
      namespace,
      kind,
    })),
  ),
)(
  'does not exempt $kind named /dev/zero in a $namespace mount namespace',
  async ({ namespace, kind }) => {
    const io = privateMountFixture('anonymous', false);
    const device =
      kind === 'disk-file' ? '8:2' : kind === 'device-inode' ? '0:6' : '0:1';
    const dev =
      kind === 'disk-file' ? 2050n : kind === 'device-inode' ? 6n : 1n;
    const observation = observeLinuxColdProcess(
      7,
      {
        ...io,
        link: (file) =>
          namespace === 'shared' && file === '/proc/7/task/7/ns/mnt'
            ? Promise.resolve('mnt:[123]')
            : io.link(file),
        entry: async (file) => ({
          ...(await io.entry(file)),
          dev,
        }),
        text: async (file) => {
          if (file.endsWith('/maps'))
            return `1000-2000 rw-s 00000000 ${kind === 'disk-file' ? '08:02' : kind === 'device-inode' ? '00:06' : '00:01'} 500 /dev/zero (deleted)\n`;
          if (file.endsWith('/mountinfo'))
            return (
              (await io.text(file)).replace(
                '1 10 0:1 / /proc',
                '1 10 0:2 / /proc',
              ) +
              `30 10 ${device} / /target rw - ${kind === 'disk-file' ? 'ext4 /dev/sdb1' : 'tmpfs tmpfs'} rw\n`
            );
          return io.text(file);
        },
        pin: (file) =>
          file.includes('/map_files/')
            ? Promise.reject(new Error('map_files denied'))
            : io.pin(file),
      },
      ['/target'],
    );
    await expect(observation).rejects.toMatchObject({
      code: 'inspection-incomplete',
      pid: 7,
      refusals: [expect.objectContaining({ reason: 'map_files denied' })],
    });
  },
);
it('records mixed-UID helpers with a foreign fsuid as named root-principal residuals', async () => {
  const io = privateMountFixture('fd', true);
  const rows = await observeLinuxColdProcesses({
    uid: 1000,
    roots: ['/target'],
    io: {
      ...io,
      text: (file) => {
        if (file === '/proc/7/status')
          return Promise.resolve('Uid:\t1000\t0\t0\t0\n');
        if (file === '/proc/7/stat')
          return Promise.resolve(
            stat(7).replace('name with ) parens', 'fusermount3'),
          );
        return io.text(file);
      },
      link: (file) =>
        file.startsWith('/proc/7/')
          ? Promise.reject(
              Object.assign(new Error('denied'), {
                code: 'EACCES',
                path: file,
              }),
            )
          : io.link(file),
    },
  });
  expect(rows.find((row) => row.pid === 7)).toMatchObject({
    pid: 7,
    scope: 'linux-root-principal',
    comm: 'fusermount3',
    executable: null,
    paths: [],
  });
});
it('keeps user-fsuid helpers in scope despite a foreign effective UID and preserves denied-read diagnostics', async () => {
  const io = privateMountFixture('fd', true);
  await expectLinuxRefusal(
    observeLinuxColdProcesses({
      uid: 1000,
      roots: ['/target'],
      io: {
        ...io,
        text: (file) =>
          file.startsWith('/proc/7/') && file.endsWith('/status')
            ? Promise.resolve('Uid:\t1000\t0\t0\t1000\n')
            : io.text(file),
        link: (file) => {
          if (!file.startsWith('/proc/7/')) return io.link(file);
          const error = Object.assign(new Error(`EPERM: readlink '${file}'`), {
            code: 'EPERM',
            path: file,
          });
          Object.setPrototypeOf(error, null);
          return Promise.reject(error);
        },
      },
    }),
    {
      pid: 7,
      executable: null,
      uids: [1000, 0, 0, 1000],
      reason: "EPERM: readlink '/proc/7/task/7/ns/mnt'",
      executableReadFailure: "EPERM: readlink '/proc/7/exe'",
    },
  );
});
it('keeps the observer descriptor exemption with roots-bound inspection', async () => {
  const io = privateMountFixture('fd', false);
  const rows = await observeLinuxColdProcesses({
    uid: 1000,
    roots: ['/target'],
    io: {
      ...io,
      list: (file) =>
        file === `/proc/${process.pid}/task/${process.pid}/fd`
          ? Promise.reject(
              new Error('Self coordination descriptors are exempt'),
            )
          : io.list(file),
      text: (file) =>
        file === `/proc/${process.pid}/task/${process.pid}/maps`
          ? Promise.reject(new Error('Self mappings are exempt'))
          : io.text(file),
    },
  });
  expect(rows.find((row) => row.pid === process.pid)).toMatchObject({
    scope: 'same-user',
  });
});
it.each([false, true])(
  'inspects a descriptor inherited from a host mount missing in the private namespace (affected=%s)',
  async (affected) => {
    const io = privateMountFixture('fd', false);
    const file = affected ? '/target/gone (deleted)' : '/outside';
    const rows = await observeLinuxColdProcess(
      7,
      {
        ...io,
        text: async (name) => {
          const text = await io.text(name);
          if (name.startsWith('/proc/7/') && name.endsWith('/mountinfo'))
            return text.replace('10 0 ', '110 0 ').replaceAll(' 10 ', ' 110 ');
          return text;
        },
        link: (name) =>
          name.endsWith('/fd/0') ? Promise.resolve(file) : io.link(name),
        pin: (name) =>
          name.endsWith('/fd/0')
            ? Promise.resolve({ dev: 2049n, ino: 500n, mountId: '10' })
            : io.pin(name),
        identity: (name) =>
          name === '/outside'
            ? Promise.resolve({ dev: 2049n, ino: 500n })
            : io.identity(name),
      },
      ['/target'],
    );
    expect(rows.linuxPrivateMountUse).toEqual({ roots: ['/target'], affected });
  },
);
it.each([
  { foreign: 'exited', holderChurn: 'none' },
  { foreign: 'live', holderChurn: 'none' },
  { foreign: 'live', holderChurn: 'status' },
  { foreign: 'live', holderChurn: 'namespace-change' },
  { foreign: 'live', holderChurn: 'namespace-missing' },
])(
  'refuses the live descriptor holder when an inherited foreign proc path races (foreign=$foreign, holder churn=$holderChurn)',
  async ({ foreign, holderChurn }) => {
    const io = privateMountFixture('fd', true);
    const other = process.pid === 999 ? 998 : 999;
    const target = `/proc/${other}/status`;
    let pathReads = 0;
    let statusReadsAfterRace = 0;
    let namespaceReadsAfterRace = 0;
    const gone = (file: string): Error =>
      Object.assign(new Error('foreign proc entry gone'), {
        code: 'ENOENT',
        path: file,
      });
    await expectLinuxRefusal(
      observeLinuxColdProcesses({
        uid: 1000,
        roots: ['/target'],
        io: {
          ...io,
          list: (file) =>
            file === '/proc'
              ? Promise.resolve([
                  String(process.pid),
                  '7',
                  ...(foreign === 'exited' && pathReads ? [] : [String(other)]),
                ])
              : io.list(file),
          text: async (file) => {
            if (
              file === '/proc/7/status' &&
              pathReads &&
              holderChurn === 'status' &&
              ++statusReadsAfterRace > 1
            )
              throw Object.assign(new Error('holder status entry gone'), {
                code: 'ENOENT',
                path: file,
              });
            if (file === target) {
              if (foreign === 'exited' && pathReads) throw gone(file);
              return 'Uid:\t2000\t2000\t2000\t2000\n';
            }
            const text = await io.text(file);
            return file.startsWith('/proc/7/') && file.endsWith('/mountinfo')
              ? text.replace('\n1 10 ', '\n101 10 ')
              : text;
          },
          link: (file) => {
            if (
              file === '/proc/7/task/7/ns/mnt' &&
              pathReads &&
              ++namespaceReadsAfterRace === 1
            ) {
              if (holderChurn === 'namespace-change')
                return Promise.resolve('mnt:[789]');
              if (holderChurn === 'namespace-missing')
                return Promise.reject(gone(file));
            }
            return file === '/proc/7/task/7/fd/0'
              ? Promise.resolve(target)
              : file === '/proc/7/task/7/fd/1'
                ? Promise.resolve('/alias/database')
                : io.link(file);
          },
          pin: (file) =>
            file === '/proc/7/task/7/fd/0'
              ? Promise.resolve({ dev: 1n, ino: 900n, mountId: '1' })
              : file === '/proc/7/task/7/fd/1'
                ? Promise.resolve({ dev: 2049n, ino: 200n, mountId: '20' })
                : io.pin(file),
          identity: (file) => {
            if (file === target) {
              if (++pathReads === 1 || foreign === 'exited')
                return Promise.reject(gone(file));
              return Promise.resolve({ dev: 1n, ino: 900n });
            }
            return file === `/proc/${other}` && foreign === 'exited'
              ? Promise.reject(gone(file))
              : io.identity(file);
          },
        },
      }),
      {
        pid: 7,
        comm: 'name with ) parens',
        executable: '/usr/bin/node',
        reason: 'foreign proc entry gone',
      },
    );
    expect(pathReads).toBe(1);
    if (holderChurn === 'status')
      expect(statusReadsAfterRace).toBeGreaterThan(1);
    if (holderChurn.startsWith('namespace-'))
      expect(namespaceReadsAfterRace).toBe(1);
  },
);
it.each(
  ['process-root', 'thread-root'].flatMap((projection) =>
    ['ENOENT', 'ESRCH'].map((code) => ({ projection, code })),
  ),
)(
  'refuses a missing projected-root path without retrying the live holder ($projection, $code)',
  async ({ projection, code }) => {
    const io = privateMountFixture('fd', false);
    const target = '/proc/999/status';
    const projected =
      projection === 'process-root'
        ? `/proc/7/root${target}`
        : `/proc/7/task/7/root${target}`;
    let reads = 0;
    await expectLinuxRefusal(
      observeLinuxColdProcesses({
        uid: 1000,
        roots: ['/target'],
        io: {
          ...io,
          link: (file) =>
            file === '/proc/7/task/7/fd/0'
              ? Promise.resolve(target)
              : io.link(file),
          pin: (file) =>
            file === '/proc/7/task/7/fd/0'
              ? Promise.resolve({ dev: 1n, ino: 900n, mountId: '1' })
              : io.pin(file),
          identity: (file) => {
            if (file === `/proc/7/task/7/root${target}`) {
              if (++reads === 1)
                return Promise.reject(
                  Object.assign(new Error('projected path gone'), {
                    code,
                    path: projected,
                  }),
                );
              return Promise.resolve({ dev: 1n, ino: 900n });
            }
            return io.identity(file);
          },
        },
      }),
      {
        pid: 7,
        comm: 'name with ) parens',
        reason: 'projected path gone',
      },
    );
    expect(reads).toBe(1);
  },
);
it.each(['live', 'pid-denied', 'stat-malformed', 'task-denied'])(
  'never reclassifies refused evidence after a later PID exit (initial recheck=%s)',
  async (recheck) => {
    const io = privateMountFixture('fd', false);
    let failed = false;
    let exited = false;
    let rechecks = 0;
    const missing = (file: string): Error =>
      Object.assign(new Error('projected evidence missing'), {
        code: 'ENOENT',
        path: file,
      });
    await expectLinuxRefusal(
      observeLinuxColdProcesses({
        uid: 1000,
        roots: ['/target'],
        io: {
          ...io,
          identity: async (file) => {
            if (file === '/proc/7/task/7/root/alias/database' && !failed) {
              failed = true;
              throw missing(file);
            }
            if (file === '/proc/7' && failed) {
              if (exited || ++rechecks > 1) throw missing(file);
              if (recheck === 'pid-denied')
                throw Object.assign(new Error('PID recheck denied'), {
                  code: 'EACCES',
                });
            }
            if (
              failed &&
              file === '/proc/7/task/7' &&
              recheck === 'task-denied'
            )
              throw Object.assign(new Error('Task recheck denied'), {
                code: 'EACCES',
              });
            return io.identity(file);
          },
          link: async (file) => {
            if (failed && file === '/proc/7/task/7/ns/mnt') exited = true;
            return io.link(file);
          },
          text: (file) =>
            failed && file === '/proc/7/stat' && recheck === 'stat-malformed'
              ? Promise.resolve('malformed')
              : io.text(file),
          list: (file) =>
            file === '/proc' && exited
              ? Promise.resolve([String(process.pid)])
              : io.list(file),
        },
      }),
      { pid: 7, reason: 'projected evidence missing' },
    );
    expect(failed).toBe(true);
    expect(exited).toBe(true);
  },
);
it.each(
  ['status', 'stat', 'thread-stat', 'namespace', 'fd', 'map-files'].flatMap(
    (entry) => ['ENOENT', 'ESRCH'].map((code) => ({ entry, code })),
  ),
)(
  'refuses missing $entry evidence while the PID and task remain live ($code)',
  async ({ entry, code }) => {
    const io = privateMountFixture('deleted-maps', false);
    const failedPath =
      entry === 'status' || entry === 'stat'
        ? `/proc/7/${entry}`
        : entry === 'map-files'
          ? '/proc/7/map_files/1000-2000'
          : `/proc/7/task/7/${
              entry === 'thread-stat'
                ? 'stat'
                : entry === 'namespace'
                  ? 'ns/mnt'
                  : 'fd/0'
            }`;
    let failed = false;
    let enumerations = 0;
    const check = (file: string): void => {
      if (file === failedPath && !failed) {
        failed = true;
        throw Object.assign(new Error(`missing ${entry} evidence`), {
          code,
          path: file,
        });
      }
    };
    await expectLinuxRefusal(
      observeLinuxColdProcesses({
        uid: 1000,
        roots: ['/target'],
        io: {
          ...io,
          list: (file) => {
            if (file === '/proc') enumerations++;
            return io.list(file);
          },
          text: async (file) => {
            check(file);
            return io.text(file);
          },
          link: async (file) => {
            check(file);
            return io.link(file);
          },
          pin: async (file) => {
            check(file);
            return io.pin(file);
          },
        },
      }),
      { pid: 7, reason: `missing ${entry} evidence` },
    );
    expect(failed).toBe(true);
    expect(enumerations).toBe(2);
  },
);
it.each([
  'pid-denied',
  'stat-missing',
  'stat-malformed',
  'task-denied',
  'task-esrch',
])(
  'refuses missing evidence when its direct churn recheck is %s',
  async (recheck) => {
    const io = privateMountFixture('fd', false);
    let failed = false;
    let enumerations = 0;
    await expectLinuxRefusal(
      observeLinuxColdProcesses({
        uid: 1000,
        roots: ['/target'],
        io: {
          ...io,
          list: (file) => {
            if (file === '/proc') enumerations++;
            return io.list(file);
          },
          link: async (file) => {
            if (file === '/proc/7/task/7/ns/mnt' && !failed) {
              failed = true;
              throw Object.assign(new Error('missing namespace evidence'), {
                code: 'ENOENT',
                path: file,
              });
            }
            return io.link(file);
          },
          text: async (file) => {
            if (file === '/proc/7/stat' && failed) {
              if (recheck === 'stat-malformed') return 'malformed';
              if (recheck === 'stat-missing')
                throw Object.assign(new Error('stat recheck missing'), {
                  code: 'ENOENT',
                  path: file,
                });
            }
            return io.text(file);
          },
          identity: async (file) => {
            if (
              failed &&
              ((file === '/proc/7' && recheck === 'pid-denied') ||
                (file === '/proc/7/task/7' && recheck.startsWith('task-')))
            )
              throw Object.assign(new Error('recheck denied'), {
                code: recheck === 'task-esrch' ? 'ESRCH' : 'EACCES',
                path: file,
              });
            return io.identity(file);
          },
        },
      }),
      { pid: 7, reason: 'missing namespace evidence' },
    );
    expect(enumerations).toBe(2);
  },
);
it.each(['ENOENT', 'ESRCH'])(
  'retries missing evidence only after directly proving PID replacement (%s)',
  async (code) => {
    const io = privateMountFixture('fd', true);
    let replaced = false;
    const rows = await observeLinuxColdProcesses({
      uid: 1000,
      roots: ['/target'],
      io: {
        ...io,
        text: (file) =>
          file === '/proc/7/stat'
            ? Promise.resolve(stat(7, replaced ? '200' : '100'))
            : io.text(file),
        link: async (file) => {
          if (file === '/proc/7/task/7/ns/mnt' && !replaced) {
            replaced = true;
            throw Object.assign(new Error('instance changed'), {
              code,
              path: file,
            });
          }
          return io.link(file);
        },
      },
    });
    expect(rows.find((row) => row.pid === 7)).toMatchObject({
      scope: 'same-user',
      startIdentity: `linux:v1:7:${boot}:200`,
      linuxPrivateMountUse: { affected: true, roots: ['/target'] },
    });
  },
);
it('preserves a live refusal even when that PID is later proven gone', async () => {
  const io = privateMountFixture('fd', false);
  let failed = false;
  let exited = false;
  let statuses = 0;
  const missing = (file: string): Error =>
    Object.assign(new Error('missing evidence'), {
      code: 'ENOENT',
      path: file,
    });
  await expectLinuxRefusal(
    observeLinuxColdProcesses({
      uid: 1000,
      roots: ['/target'],
      io: {
        ...io,
        list: (file) =>
          file === '/proc' && exited
            ? Promise.resolve([String(process.pid)])
            : io.list(file),
        text: async (file) => {
          if (file === '/proc/7/status' && failed && ++statuses > 1) {
            exited = true;
            throw missing(file);
          }
          return io.text(file);
        },
        link: async (file) => {
          if (file === '/proc/7/task/7/fd/0' && !failed) {
            failed = true;
            throw missing(file);
          }
          return io.link(file);
        },
        identity: async (file) => {
          if (file === '/proc/7' && exited) throw missing(file);
          return io.identity(file);
        },
      },
    }),
    { pid: 7, reason: 'missing evidence' },
  );
  expect(exited).toBe(true);
});
it('records a proven-absent process as exited, not a partial live observation', async () => {
  const io = privateMountFixture('fd', false);
  let enumerations = 0;
  const rows = await observeLinuxColdProcesses({
    uid: 1000,
    roots: ['/target'],
    io: {
      ...io,
      text: (file) =>
        file === '/proc/7/status'
          ? Promise.reject(
              Object.assign(new Error('gone'), { code: 'ENOENT', path: file }),
            )
          : io.text(file),
      identity: (file) =>
        file === '/proc/7'
          ? Promise.reject(
              Object.assign(new Error('gone'), { code: 'ENOENT', path: file }),
            )
          : io.identity(file),
      list: (file) =>
        file === '/proc' && ++enumerations > 1
          ? Promise.resolve([String(process.pid)])
          : io.list(file),
    },
  });
  expect(rows.find((row) => row.pid === 7)).toMatchObject({
    scope: 'exited',
    executable: null,
    paths: [],
  });
});
it.each(['task-gone', 'process-gone', 'task-live'])(
  'rechecks a roots-bound crash helper using direct task lifecycle evidence (%s)',
  async (lifecycle) => {
    const io = privateMountFixture('anonymous', false);
    const helper = 'chrome_crashpad_handler';
    const image = `/archive/app/${helper}`;
    const thread = '/proc/7/task/8';
    let failed = false;
    let listings = 0;
    let enumerations = 0;
    const missing = (file: string): Error =>
      Object.assign(new Error('crash helper directory missing'), {
        code: 'ENOENT',
        path: file,
      });
    const observation = observeLinuxColdProcesses({
      uid: 1000,
      roots: ['/target'],
      io: {
        ...io,
        text: (file) =>
          file === `${thread}/stat` ? Promise.resolve(stat(8)) : io.text(file),
        link: (file) =>
          /^\/proc\/7\/(?:task\/\d+\/)?exe$/.test(file)
            ? Promise.resolve(image)
            : io.link(file),
        identity: async (file) => {
          if (
            failed &&
            ((file === thread && lifecycle === 'task-gone') ||
              (file === '/proc/7' && lifecycle === 'process-gone'))
          )
            throw missing(file);
          return io.identity(file);
        },
        list: async (file) => {
          if (file === '/proc') {
            enumerations++;
            if (failed && lifecycle === 'process-gone')
              return [String(process.pid)];
          }
          if (file === '/proc/7/task')
            return failed && lifecycle === 'task-gone' ? ['7'] : ['7', '8'];
          if (file === `${thread}/root/archive/app` && ++listings === 3) {
            failed = true;
            throw missing(file);
          }
          if (/^\/proc\/7\/task\/\d+\/root\/archive\/app$/.test(file))
            return [helper, 'other-app'];
          return io.list(file);
        },
      },
    });
    if (lifecycle === 'task-live') {
      await expectLinuxRefusal(observation, {
        pid: 7,
        reason: 'crash helper directory missing',
      });
      expect(enumerations).toBe(2);
    } else {
      const row = (await observation).find((candidate) => candidate.pid === 7);
      expect(row).toMatchObject({
        scope: lifecycle === 'process-gone' ? 'exited' : 'same-user',
      });
      if (lifecycle === 'task-gone') {
        expect(row?.linuxExecutableRoot).toBe('/proc/7/task/7/root');
        expect(row?.executableDirectoryEntries).toEqual([helper, 'other-app']);
      }
      expect(enumerations).toBe(lifecycle === 'task-gone' ? 4 : 2);
    }
    expect(failed).toBe(true);
  },
);
it.each([false, true])(
  'fresh whole-user snapshots bound a vanished live thread (persistent=%s)',
  async (persistent) => {
    const io = privateMountFixture('fd', false);
    let reads = 0;
    let vanished = false;
    const observation = observeLinuxColdProcesses({
      uid: 1000,
      roots: ['/target'],
      io: {
        ...io,
        identity: (file) =>
          file === '/proc/7/task/7' && vanished
            ? Promise.reject(
                Object.assign(new Error('task directory gone'), {
                  code: 'ENOENT',
                  path: file,
                }),
              )
            : io.identity(file),
        link: (file) => {
          if (file === '/proc/7/task/7/ns/mnt') {
            vanished = ++reads === 1 || persistent;
            if (vanished)
              return Promise.reject(
                Object.assign(new Error('thread gone'), {
                  code: 'ENOENT',
                  path: file,
                }),
              );
          }
          return io.link(file);
        },
      },
    });
    if (persistent) {
      await expect(observation).rejects.toMatchObject({
        code: 'inspection-incomplete',
        pid: 7,
      });
      expect(reads).toBe(3);
    } else {
      expect(
        (await observation).some(
          (row) => row.pid === 7 && row.scope === 'same-user',
        ),
      ).toBe(true);
      expect(reads).toBeGreaterThan(1);
    }
  },
);
it.each([false, true])(
  'never retries away target-tree mutation mixed with process churn (same PID=%s)',
  async (samePid) => {
    const io = privateMountFixture('fd', false);
    const pid = samePid ? process.pid : 7;
    let namespaceReads = 0;
    let targetReads = 0;
    await expect(
      observeLinuxColdProcesses({
        uid: 1000,
        roots: ['/target'],
        io: {
          ...io,
          link: (file) => {
            if (
              file === `/proc/${pid}/task/${pid}/ns/mnt` &&
              ++namespaceReads === 1
            )
              return Promise.reject(
                Object.assign(new Error('thread gone'), {
                  code: 'ENOENT',
                  path: file,
                }),
              );
            return io.link(file);
          },
          identity: (file) =>
            file === `/proc/${pid}/task/${pid}` && namespaceReads > 0
              ? Promise.reject(
                  Object.assign(new Error('task directory gone'), {
                    code: 'ENOENT',
                    path: file,
                  }),
                )
              : io.identity(file),
          entry: async (file) => {
            const entry = await io.entry(file);
            return file === '/target/database' && ++targetReads === 2
              ? { ...entry, ctimeNs: 1n }
              : entry;
          },
        },
      }),
    ).rejects.toThrow('Linux target changed');
    expect(targetReads).toBe(2);
    expect(namespaceReads).toBe(1);
  },
);
it('fresh snapshots inspect a reused PID instead of dropping its affected replacement', async () => {
  const io = privateMountFixture('fd', true);
  let reads = 0;
  const rows = await observeLinuxColdProcesses({
    uid: 1000,
    roots: ['/target'],
    io: {
      ...io,
      text: (file) =>
        file === '/proc/7/stat'
          ? Promise.resolve(stat(7, ++reads === 1 ? '100' : '200'))
          : io.text(file),
    },
  });
  expect(rows.find((row) => row.pid === 7)).toMatchObject({
    scope: 'same-user',
    startIdentity: `linux:v1:7:${boot}:200`,
    linuxPrivateMountUse: { affected: true, roots: ['/target'] },
  });
});
it.each([
  'permission',
  'missing-fd',
  'fd-identity-race',
  'pinned-path-identity',
  'namespace-race',
  'root-identity-race',
  'mount-race',
  'maps-race',
  'tree-race',
  'tree-unreadable',
  'tree-list-race',
  'user-namespace',
  'pid-namespace',
  'path-identity',
])(
  'refuses private mount %s with a named process (fixture only)',
  async (failure) => {
    const io = privateMountFixture('fd', false);
    let reads = 0;
    const altered: LinuxColdIO = {
      ...io,
      text: async (file) => {
        if (
          (failure === 'mount-race' && file === '/proc/7/task/7/mountinfo') ||
          (failure === 'maps-race' && file === '/proc/7/task/7/maps')
        ) {
          const value = await io.text(file);
          return ++reads > 1 ? `${value}\n` : value;
        }
        return io.text(file);
      },
      pin: async (file) => {
        if (failure === 'permission' && file.endsWith('/fd/0'))
          throw Object.assign(new Error('denied'), {
            code: 'EACCES',
            path: file,
          });
        const identity = await io.pin(file);
        if (failure === 'pinned-path-identity' && file.endsWith('/fd/0'))
          return { ...identity, ino: 999n };
        if (
          failure === 'fd-identity-race' &&
          file.endsWith('/fd/0') &&
          ++reads > 1
        )
          return { ...identity, ino: 999n };
        return identity;
      },
      identity: async (file) => {
        if (failure === 'permission' && file.endsWith('/fd/0'))
          throw Object.assign(new Error('denied'), {
            code: 'EACCES',
            path: file,
          });
        if (
          failure === 'path-identity' &&
          file.endsWith('/root/alias/database')
        )
          return { dev: 2049n, ino: 1234n };
        if (
          failure === 'root-identity-race' &&
          file === '/proc/7/task/7/root' &&
          ++reads > 1
        )
          return { dev: 2049n, ino: 999n };
        return io.identity(file);
      },
      entry: async (file) => {
        if (failure === 'tree-unreadable' && file === '/target/database')
          throw new Error('Target metadata unreadable');
        const entry = await io.entry(file);
        return failure === 'tree-race' &&
          file === '/target/database' &&
          ++reads > 1
          ? { ...entry, ino: 999n }
          : entry;
      },
      list: async (file) =>
        failure === 'tree-list-race' && file === '/target' && ++reads > 1
          ? []
          : io.list(file),
      link: async (file) => {
        if (failure === 'missing-fd' && file.endsWith('/fd/0'))
          throw Object.assign(new Error('closed'), {
            code: 'ENOENT',
            path: file,
          });
        if (
          failure === 'namespace-race' &&
          file === '/proc/7/task/7/ns/mnt' &&
          ++reads > 1
        )
          return 'mnt:[789]';
        if (
          (failure === 'user-namespace' &&
            file.endsWith('/ns/user') &&
            !file.startsWith('/proc/self/')) ||
          (failure === 'pid-namespace' &&
            file.endsWith('/ns/pid') &&
            !file.startsWith('/proc/self/'))
        )
          return 'namespace:[other]';
        return io.link(file);
      },
    };
    await expect(
      observeLinuxColdProcess(7, altered, ['/target']),
    ).rejects.toMatchObject({ code: 'inspection-incomplete', pid: 7 });
  },
);
it('censuses nested descendants rather than comparing only root inodes', async () => {
  const io = privateMountFixture('identity-only', true);
  const observed = await observeLinuxColdProcess(
    7,
    {
      ...io,
      list: async (file) =>
        file === '/target'
          ? ['nested']
          : file === '/target/nested'
            ? ['database']
            : io.list(file),
      entry: async (file) => ({
        ...(await io.entry(file)),
        mode: file.endsWith('/database') ? 0o100600n : 0o040700n,
        ino:
          file === '/target' ? 100n : file === '/target/nested' ? 101n : 200n,
      }),
    },
    ['/target'],
  );
  expect(observed.linuxPrivateMountUse?.affected).toBe(true);
});
it.each(['empty', 'absent', 'appeared', 'ancestor-race'])(
  'private mount census handles %s roots without inventing membership',
  async (scenario) => {
    const io = privateMountFixture('fd', false);
    let roots = 0,
      parents = 0;
    const root = '/parent/target';
    const altered: LinuxColdIO = {
      ...io,
      list: async (file) => (file === root ? [] : io.list(file)),
      entry: async (file) => {
        if (
          file === root &&
          scenario !== 'empty' &&
          (++roots === 1 || scenario !== 'appeared')
        )
          throw Object.assign(new Error('missing target'), { code: 'ENOENT' });
        return {
          ...(await io.entry('/target')),
          ctimeNs:
            file === '/parent' && scenario === 'ancestor-race' && ++parents > 1
              ? 1n
              : 0n,
        };
      },
    };
    const observation = observeLinuxColdProcess(7, altered, [root]);
    if (scenario === 'appeared' || scenario === 'ancestor-race')
      await expect(observation).rejects.toMatchObject({
        code: 'inspection-incomplete',
        pid: 7,
      });
    else
      await expect(observation).resolves.toMatchObject({
        linuxPrivateMountUse: { roots: [root], affected: false },
      });
  },
);
it.each(['detached-fd', 'denied-map', 'changed-mount-id'])(
  'refuses %s instead of guessing deleted or detached mount membership',
  async (failure) => {
    const io = privateMountFixture(
      failure === 'denied-map' ? 'deleted-maps' : 'deleted',
      false,
    );
    let pins = 0;
    await expect(
      observeLinuxColdProcess(
        7,
        {
          ...io,
          pin: async (file) => {
            if (file.includes('/map_files/'))
              throw Object.assign(new Error('map_files denied'), {
                code: 'EPERM',
                path: file,
              });
            const pinned = await io.pin(file);
            return file.endsWith('/fd/0') &&
              (failure === 'detached-fd' || ++pins > 1)
              ? { ...pinned, mountId: '999' }
              : pinned;
          },
        },
        ['/target'],
      ),
    ).rejects.toMatchObject({ code: 'inspection-incomplete', pid: 7 });
  },
);

it('binds private mount receipts to the exact roots and supports a complete whole-host snapshot (fixture only)', async () => {
  const io = privateMountFixture('fd', false);
  const rows = await observeLinuxColdProcesses({
    io,
    uid: 1000,
    roots: ['/target'],
  });
  expect(rows.find((row) => row.pid === 7)?.linuxPrivateMountUse).toEqual({
    roots: ['/target'],
    affected: false,
  });
  expect(rows.find((row) => row.pid === process.pid)?.scope).toBe('same-user');
});

it.each([false, true])(
  'inspects the stock snapd-desktop-integration private mount layout (affected=%s, fixture only)',
  async (affected) => {
    const io = privateMountFixture('anonymous', false);
    const image =
      '/snap/snapd-desktop-integration/315/usr/bin/snapd-desktop-integration';
    const descriptorPath = affected
      ? '/var/lib/snapd/hostfs/target/database'
      : '/tmp/session';
    const descriptorIdentity = affected
      ? { dev: 2049n, ino: 200n, mountId: '33' }
      : { dev: 42n, ino: 502n, mountId: '32' };
    // Ubuntu snap layout: squashfs image, private tmpfs, hostfs bind and nsfs handle.
    const mounts =
      (await io.text('/proc/self/mountinfo')) +
      '31 10 7:9 / /snap/snapd-desktop-integration/315 ro - squashfs /dev/loop9 ro\n' +
      '32 10 0:42 / /tmp rw - tmpfs tmpfs rw\n' +
      '33 10 8:1 / /var/lib/snapd/hostfs rw - ext4 /dev/sda1 rw\n' +
      '2296 10 0:5 mnt:[4026532783] /run/snapd/ns/snapd-desktop-integration.mnt rw - nsfs nsfs rw\n';
    const snap: LinuxColdIO = {
      ...io,
      text: async (file) => {
        if (file.startsWith('/proc/7/')) {
          if (file.endsWith('/stat'))
            return stat(7).replace('name with ) parens', 'user-session-he');
          if (file.endsWith('/mountinfo')) return mounts;
          if (file.endsWith('/maps'))
            return `1000-2000 r-xp 00000000 07:09 501 ${image}\n2000-3000 rw-p 00000000 00:00 0 [anon: [v8] heap]\n`;
        }
        return io.text(file);
      },
      link: async (file) => {
        if (file === '/proc/7/task/7/exe' || file === '/proc/7/exe')
          return image;
        if (file === '/proc/7/task/7/fd/0') return descriptorPath;
        if (file === '/proc/7/task/7/fd/1') return 'mnt:[4026532783]';
        return io.link(file);
      },
      pin: async (file) => {
        if (file === '/proc/7/task/7/exe')
          return { dev: 1801n, ino: 501n, mountId: '31' };
        if (file === '/proc/7/task/7/fd/0') return descriptorIdentity;
        return io.pin(file);
      },
      identity: async (file) => {
        if (
          file === '/proc/7/task/7/exe' ||
          file === `/proc/7/task/7/root${image}`
        )
          return { dev: 1801n, ino: 501n };
        if (
          file === '/proc/7/task/7/fd/0' ||
          file === `/proc/7/task/7/root${descriptorPath}`
        )
          return descriptorIdentity;
        if (file === image || file === descriptorPath)
          throw new Error(
            'Private snap paths must resolve through the process root',
          );
        return io.identity(file);
      },
    };
    const rows = await observeLinuxColdProcesses({
      io: snap,
      uid: 1000,
      roots: ['/target'],
    });
    expect(rows.find((row) => row.pid === 7)).toMatchObject({
      comm: 'user-session-he',
      executable: image,
      linuxExecutableRoot: '/proc/7/task/7/root',
      linuxPrivateMountUse: { roots: ['/target'], affected },
    });
  },
);

if (process.platform === 'linux' || process.platform === 'win32') {
  const observe =
    process.platform === 'win32'
      ? (pid: number): Promise<NativeColdProcess> =>
          observeWindowsColdProcess(helper, pid)
      : observeLinuxColdProcess;
  it('executes native image, cwd, open-file and exited-process observations against a real child', async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'cold-native-')),
    );
    const file = join(
      directory,
      process.platform === 'win32'
        ? 'open file with spaces (deleted)'
        : 'open file with spaces',
    );
    let child: ChildProcess | undefined;
    try {
      await writeFile(file, 'opaque fixture');
      child = spawn(
        process.execPath,
        [
          '-e',
          `require('fs').openSync(${JSON.stringify(file)},'r');process.send('ready');process.on('message',()=>process.exit(0))`,
        ],
        { cwd: directory, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
      );
      await once(child, 'message', { signal: AbortSignal.timeout(5000) });
      const pid = child.pid;
      if (!pid) throw new Error('No child PID');
      async function diagnosedObserve(): Promise<NativeColdProcess> {
        try {
          return await observe(pid ?? 0);
        } catch (original) {
          if (process.platform !== 'win32') throw original;
          try {
            const raw = await promisify(execFile)(
              helper,
              ['--cold-process', String(pid)],
              {
                env: {},
                windowsHide: true,
                timeout: 35_000,
                maxBuffer: 64 << 20,
              },
            );
            throw new Error(
              `Adapter refused but diagnostic run succeeded: ${raw.stdout.slice(-200)}, stderr=${raw.stderr}`,
            );
          } catch (diagnostic) {
            if (diagnostic instanceof Error && 'stderr' in diagnostic)
              throw new Error(
                `Native helper failure: ${String(diagnostic.stderr)}`,
              );
            throw diagnostic;
          }
        }
      }
      const first = await diagnosedObserve();
      const second = await diagnosedObserve();
      expect(first.startIdentity).toBe(second.startIdentity);
      expect(first.executable?.toLowerCase()).toBe(
        process.execPath.toLowerCase(),
      );
      const normal = (value: string): string =>
        value
          .replace(/^\\\\\?\\/, '')
          .replace(/[\\/]+$/, '')
          .toLowerCase();
      expect(first.paths.map(normal)).toEqual(
        expect.arrayContaining([normal(directory), normal(file)]),
      );
      const closed = once(child, 'close');
      child.send('exit');
      await closed;
      child = undefined;
      await expect(observe(pid)).rejects.toThrow();
    } finally {
      if (child) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
  it('native inaccessible inspection refuses', async () => {
    if (process.platform === 'linux' && process.getuid?.() === 0)
      throw new Error('Qualify with a non-root user');
    await expect(
      observe(process.platform === 'win32' ? 4 : 1),
    ).rejects.toThrow();
  });
}
if (process.platform === 'linux') {
  it('a real non-dumpable same-user ssh-agent is not exempted as a service manager', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cold-agent-'));
    const child = spawn(
      '/usr/bin/ssh-agent',
      ['-D', '-a', join(directory, 'agent.sock')],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    try {
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
      if (!child.pid) throw new Error('No ssh-agent fixture PID');
      await expect(observeLinuxColdProcess(child.pid)).rejects.toMatchObject({
        name: 'LinuxColdInspectionError',
        code: 'inspection-incomplete',
        pid: child.pid,
        comm: 'ssh-agent',
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
if (process.platform === 'win32') {
  it('observes an x86 WOW64 child cwd through its 32-bit PEB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cold-wow64-'));
    const cmd = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'SysWOW64',
      'cmd.exe',
    );
    const child = spawn(cmd, ['/d', '/q', '/k', 'echo cold-ready'], {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
      if (!child.pid) throw new Error('No WOW64 child PID');
      const { stdout, stderr } = await promisify(execFile)(
        helper,
        ['--cold-process', String(child.pid)],
        { env: {}, windowsHide: true, timeout: 35_000, maxBuffer: 64 << 20 },
      );
      expect(stderr).toBe('');
      const observed = parseWindowsColdObservation(stdout)[0];
      const normal = (file: string): string =>
        file
          .replace(/^\\\\\?\\/, '')
          .replace(/[\\/]+$/, '')
          .toLowerCase();
      expect(normal(observed?.executable ?? '')).toBe(normal(cmd));
      expect(observed?.paths.map(normal)).toContain(
        normal(await realpath(directory)),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);
  it('does not replace a missing native helper', async () => {
    await expect(
      observeWindowsColdProcesses(
        join('C:\\missing', 'canopy-process-identity.exe'),
      ),
    ).rejects.toThrow();
  });
}
