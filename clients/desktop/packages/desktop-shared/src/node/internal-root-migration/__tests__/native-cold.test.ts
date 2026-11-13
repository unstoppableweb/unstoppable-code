import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  realpath,
} from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as CorePlatform from '@canopy/core-platform';
import {
  createPlatformEndpointServices,
  observeLinuxColdProcess,
  parseWindowsColdObservation,
  type NativeColdProcess,
} from '@canopy/core-platform';
import canopy from '../../../../../../brands/canopy/brand.json';
import unstoppable from '../../../../../../brands/unstoppable-code/brand.json';
import { InternalRootMigrationRefused } from '@canopy/core-runtime/node/internal-root-migration';
import {
  assertInternalRootNativeCold,
  assertInternalRootNativeDaemonStopped,
  internalRootColdHost,
  readInternalRootManagedPids,
} from '../native-cold';

// Linux policy fixtures use POSIX paths even when this golden runs on Windows.
let mockLinuxPolicy = false;
let mockLinuxCanonicalPaths: readonly string[] = [];
let mockWindowsPolicy:
  | {
      readonly denied: string;
      readonly calls: string[];
      readonly blockedAncestors?: readonly string[];
      readonly errorCode?: string;
      readonly scriptPath?: string;
    }
  | undefined;
let mockIncompleteWindowsHelper = false;
jest.mock('@canopy/core-platform', () => {
  const platform = jest.requireActual<typeof CorePlatform>(
    '@canopy/core-platform',
  );
  return {
    ...platform,
    observeWindowsColdProcesses: (
      ...args: Parameters<typeof platform.observeWindowsColdProcesses>
    ): ReturnType<typeof platform.observeWindowsColdProcesses> =>
      mockIncompleteWindowsHelper
        ? Promise.reject(
            new Error('Fixture helper ended without a complete receipt'),
          )
        : platform.observeWindowsColdProcesses(...args),
  };
});
jest.mock('node:fs/promises', () => {
  const fs = jest.requireActual<typeof FileSystem>('node:fs/promises');
  return {
    ...fs,
    realpath: async (file: string): Promise<string> => {
      if (mockLinuxCanonicalPaths.includes(file)) return file;
      if (mockWindowsPolicy) {
        mockWindowsPolicy.calls.push(file);
        if (
          file === mockWindowsPolicy.denied ||
          mockWindowsPolicy.blockedAncestors?.includes(file)
        )
          throw Object.assign(new Error('fixture realpath denied'), {
            code: mockWindowsPolicy.errorCode ?? 'EPERM',
          });
        return file === process.argv[1]
          ? (mockWindowsPolicy.scriptPath ?? 'C:\\maintenance\\policy-fixture')
          : file;
      }
      if (process.platform === 'win32') {
        if (file.startsWith('/')) return file;
        if (mockLinuxPolicy && file === process.argv[1])
          return '/maintenance/policy-fixture';
      }
      return fs.realpath(file);
    },
  };
});
const brands = [canopy, unstoppable];
const mounts = '10 0 8:1 / / rw - ext4 /dev/sda1 rw\n';
const row = (executable: string, pid = 42): NativeColdProcess => ({
  pid,
  scope: 'same-user',
  parentPid: 1,
  startIdentity: `linux:v1:${pid}:boot:123`,
  executable,
  paths: [],
  comm: 'fixture',
  linuxMountInfo: mounts,
});
const self = row('/usr/bin/node', 99);
const prove = (
  rows: readonly NativeColdProcess[],
  roots: readonly string[],
  managedPids: ReadonlySet<number> = new Set(),
): Promise<void> => {
  mockLinuxPolicy = true;
  return assertInternalRootNativeCold({
    os: 'linux',
    rows: [
      { ...self, linuxMountInfo: rows[0]?.linuxMountInfo ?? mounts },
      ...rows,
    ],
    roots,
    brands,
    managedPids,
    selfPid: 99,
  }).finally(() => {
    mockLinuxPolicy = false;
  });
};
it('refuses an inaccessible Windows path that cannot be excluded from an affected root', async () => {
  for (const { file, root, blockedAncestors } of [
    {
      file: 'C:\\affected\\FontCache.dat',
      root: 'C:\\affected',
      blockedAncestors: [],
    },
    {
      file: 'C:\\AFFECTED\\other\\FontCache.dat',
      root: 'c:\\affected\\data',
      blockedAncestors: ['C:\\AFFECTED\\other'],
    },
    {
      file: 'C:\\unrelated\\FontCache.dat',
      root: 'C:\\affected',
      blockedAncestors: ['C:\\unrelated'],
    },
  ]) {
    const calls: string[] = [];
    mockWindowsPolicy = { denied: file, calls, blockedAncestors };
    try {
      const proof = assertInternalRootNativeCold({
        os: 'win32',
        rows: [
          { ...self, executable: 'C:\\runtime\\node.exe' },
          { ...row('C:\\runtime\\git.exe'), paths: [file] },
        ],
        roots: [root],
        brands,
        managedPids: new Set(),
        selfPid: 99,
      });
      await expect(proof).rejects.toMatchObject({
        reason: 'cold-proof-unavailable',
      });
      await expect(proof).rejects.toThrow(
        `pid=42 path=${JSON.stringify(file)}`,
      );
      expect(calls).toContain(file);
    } finally {
      mockWindowsPolicy = undefined;
    }
  }
});
it.each([false, true])(
  'private mount membership decides file use without host pathname guesses (affected=%s)',
  async (affected) => {
    const observed = {
      ...row('/target/private-executable'),
      linuxExecutableRoot: '/proc/42/task/42/root',
      linuxPrivateMountUse: { roots: ['/target'], affected },
    };
    if (affected)
      await expect(prove([observed], ['/target'])).rejects.toMatchObject({
        reason: 'writer-active',
      });
    else await expect(prove([observed], ['/target'])).resolves.toBeUndefined();
  },
);
it('private mount evidence cannot be reused for different target roots', async () => {
  await expect(
    prove(
      [
        {
          ...row('/usr/bin/node'),
          linuxPrivateMountUse: { roots: ['/other'], affected: false },
        },
      ],
      ['/target'],
    ),
  ).rejects.toMatchObject({ reason: 'cold-proof-unavailable' });
});
it('private mount observations still refuse product images and managed PIDs', async () => {
  const observed = {
    ...row('/snap/canopy-desktop'),
    linuxExecutableRoot: '/proc/42/task/42/root',
    linuxPrivateMountUse: { roots: ['/target'], affected: false },
  };
  await expect(prove([observed], ['/target'])).rejects.toMatchObject({
    reason: 'writer-active',
  });
  await expect(
    prove(
      [{ ...observed, executable: '/usr/bin/node' }],
      ['/target'],
      new Set([42]),
    ),
  ).rejects.toMatchObject({ reason: 'writer-active' });
});

it('admits proven-absent Linux rows without ignoring live managed PIDs', async () => {
  await expect(
    prove(
      [
        {
          ...row('/usr/bin/node'),
          scope: 'exited',
          executable: null,
          paths: [],
        },
      ],
      ['/target'],
      new Set([42]),
    ),
  ).resolves.toBeUndefined();
  await expect(
    prove([{ ...row('/usr/bin/node'), scope: 'exited' }], ['/target']),
  ).rejects.toThrow('Unexpected exited process scope');
});

it.each([null, '/usr/bin/node'])(
  'rejects Windows-only post-T scope on Linux (image=%s)',
  async (executable) => {
    await expect(
      prove(
        [{ ...row('/usr/bin/node'), scope: 'post-t', executable }],
        ['/target'],
      ),
    ).rejects.toThrow('Unexpected Windows process scope');
  },
);
it('rejects Linux proven-absent rows with leftover file-use evidence', async () => {
  await expect(
    prove(
      [
        {
          ...row('/usr/bin/node'),
          scope: 'exited',
          executable: null,
          paths: ['/target/database'],
        },
      ],
      ['/target'],
    ),
  ).rejects.toThrow('Unexpected exited process scope');
});

function observeBtrfsMappings(
  linuxMountInfo: string,
  files: readonly string[],
): Promise<NativeColdProcess> {
  return observeLinuxColdProcess(42, {
    pin: () => Promise.reject(new Error('Unexpected private mount inspection')),
    entry: () => Promise.reject(new Error('Unexpected target census')),
    identity: (file) =>
      Promise.resolve({
        dev: file === '/other/database' ? 43n : 42n,
        ino: 256n,
      }),
    text: (file) =>
      Promise.resolve().then(() => {
        if (file.endsWith('/mountinfo')) return linuxMountInfo;
        if (file.endsWith('/boot_id'))
          return '01234567-0123-0123-0123-0123456789ab\n';
        if (file.endsWith('/stat'))
          return `42 (node) S 1 ${Array(17).fill('0').join(' ')} 123 0\n`;
        if (file.endsWith('/status')) return 'Uid:\t1000\t1000\t1000\t1000\n';
        if (file.endsWith('/maps'))
          return files
            .map(
              (mapped, index) =>
                `${index + 1}000-${index + 2}000 r--p 00000000 08:01 256 ${mapped}\n`,
            )
            .join('');
        throw new Error(`Unexpected text ${file}`);
      }),
    list: (file) =>
      Promise.resolve().then(() => {
        if (file.endsWith('/task')) return ['42'];
        if (file.endsWith('/fd')) return [];
        throw new Error(`Unexpected list ${file}`);
      }),
    link: (file) =>
      Promise.resolve().then(() => {
        if (/\/ns\/(mnt|user|pid)$/.test(file))
          return `${file.slice(file.lastIndexOf('/') + 1)}:[123]`;
        if (file.endsWith('/root')) return '/';
        if (file.endsWith('/exe')) return '/usr/bin/node';
        if (file.endsWith('/cwd')) return '/unrelated';
        throw new Error(`Unexpected link ${file}`);
      }),
  });
}
it('attributes bind aliases and nested-device writers without lexical-prefix false positives (fixture only)', async () => {
  {
    for (const [root, file, source, point] of [
      ['/affected', '/alias/database', '/affected', '/alias'],
      ['/affected', '/alias/affected/database', '/', '/alias'],
      ['/alias', '/affected/database', '/affected', '/alias'],
      ['/alias/subtree', '/affected/subtree/database', '/affected', '/alias'],
      ['/affected', '/alias', '/affected/database', '/alias'],
    ]) {
      const linuxMountInfo = `${mounts}20 10 8:1 ${source} ${point} rw - ext4 /dev/sda1 rw\n`;
      await expect(
        prove(
          [{ ...row('/usr/bin/node'), linuxMountInfo, paths: [file] }],
          [root],
        ),
      ).rejects.toMatchObject({ reason: 'writer-active' });
    }
  }
  {
    for (const file of ['/affected/nested/database', '/external/database']) {
      const linuxMountInfo = `${mounts}20 10 8:2 / /affected/nested rw - ext4 /dev/sdb1 rw\n21 10 8:2 / /external rw - ext4 /dev/sdb1 rw\n`;
      await expect(
        prove(
          [{ ...row('/usr/bin/node'), linuxMountInfo, paths: [file] }],
          ['/affected'],
        ),
      ).rejects.toMatchObject({ reason: 'writer-active' });
    }
  }
  {
    const linuxMountInfo = `${mounts}20 10 8:2 / /affected/nested rw - ext4 /dev/sdb1 rw\n30 10 8:3 / /affected rw - ext4 /dev/sdc1 rw\n31 10 8:3 / /external rw - ext4 /dev/sdc1 rw\n32 10 8:2 / /hidden-alias rw - ext4 /dev/sdb1 rw\n33 10 8:4 / /unrelated rw - ext4 /dev/sdd1 rw\n`;
    for (const file of ['/hidden-alias/database', '/unrelated/database'])
      await expect(
        prove(
          [{ ...row('/usr/bin/node'), linuxMountInfo, paths: [file] }],
          ['/affected'],
        ),
      ).resolves.toBeUndefined();
    await expect(
      prove(
        [
          {
            ...row('/usr/bin/node'),
            linuxMountInfo,
            paths: ['/external/nested/database'],
          },
        ],
        ['/affected/nested'],
      ),
    ).rejects.toMatchObject({ reason: 'writer-active' });
  }
  {
    const linuxMountInfo = `${mounts}20 21 8:2 / /affected/nested rw - ext4 /dev/sdb1 rw\n21 20 8:3 / /affected/nested rw - ext4 /dev/sdc1 rw\n`;
    await expect(
      prove([{ ...row('/usr/bin/node'), linuxMountInfo }], ['/affected']),
    ).rejects.toMatchObject({ reason: 'cold-proof-unavailable' });
    await expect(
      prove([{ ...row('/usr/bin/node'), linuxMountInfo }], ['/affected']),
    ).rejects.toThrow('path="/affected/nested"');
  }
  {
    const linuxMountInfo = `${mounts}20 10 8:1 /affected /alias rw - ext4 /dev/sda1 rw\n21 20 8:2 / /alias/nested rw - ext4 /dev/sdb1 rw\n`;
    for (const file of ['/alias-sibling/database', '/alias/nested/database'])
      await expect(
        prove(
          [{ ...row('/usr/bin/node'), linuxMountInfo, paths: [file] }],
          ['/affected'],
        ),
      ).resolves.toBeUndefined();
  }
  {
    for (const [file, linuxMountInfo] of [
      ['/missing/database', '20 0 8:1 / /usr rw - ext4 /dev/sda1 rw\n'],
      ['/alias/database', 'malformed\n'],
      ['/alias/database (deleted)', mounts],
      ['/alias/escaped\\012name', mounts],
      ['/alias/database', ''],
      [
        '/alias/database',
        `${mounts}20 10 8:1 /bad\\777root /alias rw - ext4 /dev/sda1 rw\n`,
      ],
    ]) {
      await expect(
        prove(
          [{ ...row('/usr/bin/node'), linuxMountInfo, paths: [file] }],
          ['/affected'],
        ),
      ).rejects.toMatchObject({ reason: 'cold-proof-unavailable' });
    }
  }
  {
    await expect(
      prove(
        [{ ...row('/usr/bin/node'), paths: ['/alias/database (deleted)'] }],
        ['/affected'],
      ),
    ).rejects.toThrow('pid=42 comm="fixture" path="/alias/database (deleted)"');
  }
  {
    for (const linuxMountInfo of [
      undefined,
      `${mounts}20 10 8:1 /affected /alias rw - ext4 /dev/sda1 rw\n`,
    ])
      await expect(
        assertInternalRootNativeCold({
          os: 'linux',
          rows: [self, { ...row('/usr/bin/node'), linuxMountInfo }],
          roots: ['/affected'],
          brands,
          managedPids: new Set(),
          selfPid: 99,
        }),
      ).rejects.toMatchObject({ reason: 'cold-proof-unavailable' });
  }
});
it('attributes all btrfs candidates before admitting unrelated mappings (fixture only)', async () => {
  {
    const linuxMountInfo =
      '10 0 8:1 /@ / rw - btrfs /dev/sda1 rw\n' +
      '20 10 8:1 /@/affected /alias rw - btrfs /dev/sda1 rw\n' +
      '21 10 8:1 /@other /other rw - btrfs /dev/sda1 rw\n';
    const observed = await observeBtrfsMappings(linuxMountInfo, [
      '/alias/database',
      '/other/database',
    ]);
    expect(observed.paths).toEqual([
      '/unrelated',
      '/alias/database',
      '/other/database',
    ]);
    await expect(
      prove([observed], ['/unrelated-root']),
    ).resolves.toBeUndefined();
    for (const root of ['/affected', '/alias', '/other'])
      await expect(prove([observed], [root])).rejects.toMatchObject({
        reason: 'writer-active',
      });
  }
  {
    for (const layout of [
      'stacked',
      'sibling',
      'ancestor',
      'root',
      'hidden-child',
      'hidden-child-reversed',
      'covered-parent',
    ]) {
      const hiddenChild = layout.startsWith('hidden-child');
      const hiddenMounts = [
        '20 10 8:1 /@/affected /alias/nested rw - btrfs /dev/sda1 rw',
        '21 10 8:1 /@other /alias rw - btrfs /dev/sda1 rw',
      ];
      if (layout === 'hidden-child-reversed') hiddenMounts.reverse();
      const attachments = hiddenChild
        ? hiddenMounts.join('\n') + '\n'
        : layout === 'covered-parent'
          ? '21 10 8:1 /@other /alias rw - btrfs /dev/sda1 rw\n'
          : '20 10 8:1 /@/affected /alias rw - btrfs /dev/sda1 rw\n' +
            `21 ${layout === 'sibling' ? '10' : '20'} 8:1 /@other /alias rw - btrfs /dev/sda1 rw\n` +
            (layout === 'ancestor'
              ? '30 21 8:1 /@third /alias/nested rw - btrfs /dev/sda1 rw\n'
              : '');
      const linuxMountInfo =
        (layout === 'root'
          ? '10 0 8:1 /@/affected / rw - btrfs /dev/sda1 rw\n21 10 8:1 /@other / rw - btrfs /dev/sda1 rw\n'
          : '10 0 8:1 /@ / rw - btrfs /dev/sda1 rw\n' + attachments) +
        `50 ${layout === 'root' ? '21' : '10'} 8:1 ${layout === 'covered-parent' ? '/@/alias' : '/@/affected'} /affected rw - btrfs /dev/sda1 rw\n`;
      const file =
        hiddenChild || layout === 'ancestor'
          ? '/alias/nested/database'
          : '/alias/database';
      const observed = await observeBtrfsMappings(linuxMountInfo, [file]);
      await expect(prove([observed], ['/affected'])).rejects.toMatchObject({
        reason: 'writer-active',
      });
      await expect(prove([observed], ['/unused'])).resolves.toBeUndefined();
    }
  }
  {
    const linuxMountInfo =
      '10 0 8:1 /root / rw - btrfs /dev/sda1 rw\n' +
      '20 10 8:1 /home /home rw - btrfs /dev/sda1 rw\n';
    const observed = await observeBtrfsMappings(linuxMountInfo, [
      '/home/mike/.local/lib/module.so',
    ]);
    expect(observed.linuxMappingCandidates).toEqual([
      { device: '8:1', path: '/home/mike/.local/lib/module.so' },
      { device: '8:1', path: '/root/home/mike/.local/lib/module.so' },
    ]);
    mockLinuxCanonicalPaths = ['/home/mike/.canopy', '/home/mike/.local'];
    try {
      await expect(
        prove([observed], ['/home/mike/.canopy']),
      ).resolves.toBeUndefined();
      await expect(
        prove([observed], ['/home/mike/.local']),
      ).rejects.toMatchObject({ reason: 'writer-active' });
    } finally {
      mockLinuxCanonicalPaths = [];
    }
  }
});
it('refuses Linux app, CLI, daemon and helper images', async () => {
  for (const executable of [
    'canopy-desktop',
    'unstoppable-code-desktop',
    'canopy',
    'unstoppable-code',
    'canopyd',
    'unstoppable-coded',
    'Canopy Helper (Renderer)',
    'Unstoppable Code Helper',
    'canopy-file-broker',
    'canopy-process-identity',
  ]) {
    await expect(
      prove([row(`/bin/${executable}`)], ['/not-an-installation']),
    ).rejects.toMatchObject({ reason: 'writer-active' });
  }
});
if (process.platform === 'win32') {
  it('refuses Windows product images in live, excluded, foreign and exited rows', async () => {
    {
      for (const executable of [
        'Canopy.exe',
        'UNSTOPPABLE-CODE.EXE',
        'canopyd.exe',
        'unstoppable-coded.exe',
        'Canopy Helper (Renderer).exe',
      ]) {
        await expect(
          assertInternalRootNativeCold({
            os: 'win32',
            rows: [
              { ...self, executable: 'C:\\Node\\node.exe' },
              row(`C:\\app\\${executable}`),
            ],
            roots: ['C:\\unused'],
            brands,
            managedPids: new Set(),
            selfPid: 99,
          }),
        ).rejects.toMatchObject({ reason: 'writer-active' });
      }
    }
    {
      for (const image of ['Canopy.exe', 'canopy-file-broker.exe']) {
        const calls: string[] = [];
        mockWindowsPolicy = { denied: 'C:\\unrelated\\FontCache.dat', calls };
        try {
          await expect(
            assertInternalRootNativeCold({
              os: 'win32',
              rows: [
                { ...self, executable: 'C:\\runtime\\node.exe' },
                {
                  ...row('C:\\runtime\\git.exe'),
                  paths: ['C:\\unrelated\\FontCache.dat'],
                },
                { ...row(`C:\\product\\${image}`, 43), scope: 'foreign' },
              ],
              roots: ['C:\\affected'],
              brands,
              managedPids: new Set(),
              selfPid: 99,
            }),
          ).rejects.toMatchObject({ reason: 'writer-active' });
          expect(calls).toEqual([]);
        } finally {
          mockWindowsPolicy = undefined;
        }
      }
    }
    {
      for (const scope of ['foreign', 'exited'] as const) {
        const denied =
          'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\FontCache.dat';
        const calls: string[] = [];
        mockWindowsPolicy = { denied, calls };
        try {
          await expect(
            assertInternalRootNativeCold({
              os: 'win32',
              rows: [
                { ...self, executable: 'C:\\runtime\\node.exe' },
                { ...row('C:\\Windows\\service.exe'), scope, paths: [denied] },
              ],
              roots: ['C:\\affected'],
              brands,
              managedPids: new Set(),
              selfPid: 99,
            }),
          ).resolves.toBeUndefined();
          expect(calls).not.toContain(denied);
          expect(calls).not.toContain('C:\\Windows\\service.exe');
        } finally {
          mockWindowsPolicy = undefined;
        }
      }
    }
    {
      for (const [image, file, outcome] of [
        ['probe.exe', undefined, undefined],
        ['C:\\outside\\probe.exe', 'C:\\blocked\\file', 'EPERM'],
        ['probe.exe', 'C:\\blocked\\file', 'EIO'],
        ['probe.exe', 'C:\\affected\\file', 'writer-active'],
        ['Canopy.exe', undefined, 'writer-active'],
        ['canopy.exe', undefined, 'writer-active'],
        ['canopyd.exe', undefined, 'writer-active'],
        ['Canopy Helper (Renderer).exe', undefined, 'writer-active'],
        ['canopy-process-identity.exe', undefined, 'writer-active'],
        ['canopy-file-broker.exe', undefined, 'writer-active'],
        ['canopy-dictate.exe', undefined, 'writer-active'],
        ['crashpad_handler.exe', undefined, 'ambiguous-image'],
      ] as const) {
        const denied =
          outcome === 'writer-active'
            ? 'C:\\never-denied'
            : (file ?? 'C:\\blocked\\file');
        mockWindowsPolicy = {
          denied,
          calls: [],
          errorCode: outcome === 'EIO' ? 'EIO' : 'EPERM',
        };
        try {
          const encode = (value: string): string =>
            Array.from(value, (char) =>
              char.charCodeAt(0).toString(16).padStart(4, '0'),
            ).join('');
          const late = parseWindowsColdObservation(
            `canopy-cold-v1\nowner-is-user\na 42\ne ${encode(image)}\n${file ? `f ${encode(file)}\n` : ''}end\ncomplete 1\n`,
          );
          const result = assertInternalRootNativeCold({
            os: 'win32',
            rows: [{ ...self, executable: 'C:\\runtime\\node.exe' }, ...late],
            roots: ['C:\\affected'],
            brands,
            managedPids: new Set(),
            selfPid: 99,
          });
          if (outcome === 'writer-active') {
            // Observable affected use remains conservative evidence, not an optional failure.
            await expect(result).rejects.toMatchObject({
              reason: 'writer-active',
            });
          } else if (outcome === 'ambiguous-image')
            await expect(result).rejects.toThrow('installation identity');
          else await expect(result).resolves.toBeUndefined();
        } finally {
          mockWindowsPolicy = undefined;
        }
      }
    }
    {
      for (const name of ['probe.exe', 'Canopy.exe']) {
        const encoded = `\\Device\\HarddiskVolume3\\${name}`
          .split('')
          .map((character) =>
            character.charCodeAt(0).toString(16).padStart(4, '0'),
          )
          .join('');
        const rows = parseWindowsColdObservation(
          `canopy-cold-v1\nowner-is-user\nexited 42 ${encoded}\ncomplete 1\n`,
        );
        const proof = assertInternalRootNativeCold({
          os: 'win32',
          rows: [{ ...self, executable: process.execPath }, ...rows],
          roots: ['C:\\unused'],
          brands,
          managedPids: new Set([42]),
          selfPid: 99,
        });
        if (name === 'Canopy.exe')
          await expect(proof).rejects.toMatchObject({
            reason: 'writer-active',
          });
        else await expect(proof).resolves.toBeUndefined();
      }
    }
    {
      const image = 'C:\\protected\\Canopy.exe';
      const encoded = image
        .split('')
        .map((character) =>
          character.charCodeAt(0).toString(16).padStart(4, '0'),
        )
        .join('');
      const rows = parseWindowsColdObservation(
        `canopy-cold-v1\nowner-is-user\nx 42 owner-rights-denied\ne ${encoded}\nend\ncomplete 1\n`,
      );
      await expect(
        assertInternalRootNativeCold({
          os: 'win32',
          rows: [{ ...self, executable: process.execPath }, ...rows],
          roots: ['C:\\not-an-installation'],
          brands,
          managedPids: new Set(),
          selfPid: 99,
        }),
      ).rejects.toMatchObject({ reason: 'writer-active' });
    }
    {
      await expect(
        assertInternalRootNativeCold({
          os: 'win32',
          rows: [
            { ...self, executable: process.execPath },
            { ...row('chrome_crashpad_handler.exe'), scope: 'foreign' },
          ],
          roots: ['C:\\not-an-installation'],
          brands,
          managedPids: new Set(),
          selfPid: 99,
        }),
      ).rejects.toThrow('Crash helper installation identity is incomplete');
    }
  });
}
it('attributes Crashpad installation identity before admission', async () => {
  {
    for (const product of ['Canopy', 'Canopy (Internal)', 'Canopy (RC)']) {
      await expect(
        prove(
          [row(`/opt/${product}/chrome_crashpad_handler`)],
          ['/not-an-installation'],
        ),
      ).rejects.toMatchObject({ reason: 'writer-active' });
    }
  }
  {
    for (const helper of ['chrome_crashpad_handler', 'crashpad_handler']) {
      for (const product of [
        'canopy-desktop',
        'unstoppable-code-desktop',
        'canopy',
        'canopyd',
        'unstoppable-code',
        'unstoppable-coded',
        'Canopy (Internal)',
      ]) {
        await expect(
          prove(
            [
              {
                ...row(
                  `/home/user/Downloads/${product}-1.0.0-x64/app/${helper}`,
                ),
                executableDirectoryEntries: [helper, product, 'unrelated-app'],
              },
            ],
            ['/not-an-installation'],
          ),
        ).rejects.toMatchObject({ reason: 'writer-active' });
      }
      await expect(
        prove(
          [
            {
              ...row(`/opt/unrelated-app/${helper}`),
              executableDirectoryEntries: [helper, 'unrelated-app'],
            },
          ],
          ['/not-an-installation'],
        ),
      ).resolves.toBeUndefined();
      await expect(
        prove([row(`/unknown/${helper}`)], ['/not-an-installation']),
      ).rejects.toThrow('Crash helper installation identity is incomplete');
      await expect(
        prove(
          [
            {
              ...row(`/opt/unrelated-app/${helper} (deleted)`),
              executableDirectoryEntries: [helper, 'unrelated-app'],
            },
          ],
          ['/not-an-installation'],
        ),
      ).rejects.toThrow();
    }
  }
});
if (process.platform === 'linux') {
  it.each(['chrome_crashpad_handler', 'crashpad_handler'])(
    'classifies a standalone native %s by its actual installation',
    async (helper) => {
      const root = await mkdtemp(join(tmpdir(), 'cold-archive-'));
      const directory = join(root, 'canopy-desktop-1.0.0-x64', 'app');
      try {
        await mkdir(directory, { recursive: true });
        await copyFile(process.execPath, join(directory, 'canopy-desktop'));
        const executable = join(directory, helper);
        await copyFile(process.execPath, executable);
        await copyFile(process.execPath, join(directory, 'unrelated-app'));
        const child = spawn(
          executable,
          [
            '-e',
            "process.on('message',()=>process.exit(0));process.send('ready')",
          ],
          { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
        );
        try {
          await once(child, 'message', { signal: AbortSignal.timeout(5000) });
          const pid = child.pid;
          if (!pid) throw new Error('No archive helper PID');
          const observed = await observeLinuxColdProcess(pid);
          expect(observed.executable).toBe(await realpath(executable));
          await expect(
            prove([observed], [join(root, 'unaffected')]),
          ).rejects.toMatchObject({ reason: 'writer-active' });
          await rm(join(directory, 'canopy-desktop'));
          await expect(
            prove(
              [await observeLinuxColdProcess(pid)],
              [join(root, 'unaffected')],
            ),
          ).resolves.toBeUndefined();
          await rm(executable);
          await expect(observeLinuxColdProcess(pid)).rejects.toMatchObject({
            code: 'inspection-incomplete',
            pid,
          });
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            const closed = once(child, 'close');
            child.kill();
            await closed;
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
it('admits Linux root-principal residuals but still refuses managed process hints', async () => {
  const residual: NativeColdProcess = {
    ...row('/usr/bin/fusermount3'),
    scope: 'linux-root-principal',
    comm: 'fusermount3',
    executable: null,
  };
  await expect(prove([residual], ['/target'])).resolves.toBeUndefined();
  await expect(
    prove([residual], ['/target'], new Set([residual.pid])),
  ).rejects.toMatchObject({ reason: 'writer-active' });
  await expect(
    assertInternalRootNativeCold({
      os: 'win32',
      rows: [self, residual],
      roots: ['/target'],
      brands,
      managedPids: new Set(),
      selfPid: self.pid,
    }),
  ).rejects.toThrow('Unexpected Linux process scope');
});
it('admits unrelated executables but refuses orphan hints including reused PIDs', async () => {
  await expect(
    prove(
      [{ ...row('/bin/canopy-desktop'), scope: 'linux-user-manager' }],
      ['/not-an-installation'],
    ),
  ).rejects.toMatchObject({ reason: 'writer-active' });
  await expect(
    prove([row('/usr/bin/git')], ['/not-an-installation']),
  ).resolves.toBeUndefined();
  await expect(
    prove([row('/usr/bin/node')], ['/not-an-installation'], new Set([42])),
  ).rejects.toMatchObject({ reason: 'writer-active' });
  await expect(
    prove([row('/usr/bin/node')], ['/not-an-installation'], new Set([1])),
  ).resolves.toBeUndefined();
});
it('refuses an empty/missing-self snapshot or missing executable identities', async () => {
  for (const rows of [[], [row('/usr/bin/node')]])
    await expect(
      assertInternalRootNativeCold({
        os: 'linux',
        rows,
        roots: ['/root'],
        brands,
        managedPids: new Set(),
        selfPid: 99,
      }),
    ).rejects.toThrow('Incomplete trusted cold evidence');
  await expect(
    assertInternalRootNativeCold({
      os: 'win32',
      rows: [
        self,
        { ...row('/usr/bin/node'), scope: 'post-t', executable: null },
      ],
      roots: ['C:\\unused'],
      brands,
      managedPids: new Set(),
      selfPid: 99,
    }),
  ).rejects.toThrow('Unexpected Windows process scope');
  await expect(
    assertInternalRootNativeCold({
      os: 'linux',
      rows: [self],
      roots: ['/root'],
      brands: [],
      managedPids: new Set(),
      selfPid: 99,
    }),
  ).rejects.toThrow('Incomplete trusted cold evidence');
});
it('strictly reads managed-child hints without calling ordinary reapers or reading provider payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cold-record-'));
  try {
    expect(await readInternalRootManagedPids([root])).toEqual(new Set());
    const registry = join(root, 'claude-process-pids.json');
    await writeFile(
      registry,
      JSON.stringify({
        version: 1,
        processes: [{ pid: 42, executable: 'fixture', startedAtMs: 1 }],
      }),
    );
    await writeFile(
      join(root, 'codex-app-server-pids.json'),
      JSON.stringify({ version: 1, pids: [43] }),
    );
    expect(await readInternalRootManagedPids([root])).toEqual(
      new Set([42, 43]),
    );
    for (const malformed of [
      '{',
      '{"version":2,"processes":[]}',
      '{"version":1,"processes":[{"pid":"42"}]}',
    ]) {
      await writeFile(registry, malformed);
      await expect(readInternalRootManagedPids([root])).rejects.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('returns typed unavailable when the Windows host cannot obtain a complete helper receipt', async () => {
  const host = internalRootColdHost('win32', {
    kind: 'repository',
    root: String.raw`C:\missing-cold-helper-fixture`,
  });
  for (const incomplete of [false, true]) {
    mockIncompleteWindowsHelper = incomplete;
    try {
      const error: unknown = await host
        .observe()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InternalRootMigrationRefused);
      expect(error).toHaveProperty('reason', 'cold-proof-unavailable');
      expect(error).toHaveProperty('cause', expect.any(Error));
      if (!(error instanceof Error)) throw new Error('Missing host refusal');
      expect(error.message).toContain(
        'Windows process inspection is incomplete:',
      );
      if (incomplete)
        expect(error.cause).toMatchObject({
          message: 'Fixture helper ended without a complete receipt',
        });
    } finally {
      mockIncompleteWindowsHelper = false;
    }
  }
});
it('selects the one helper for repository, packaged app and standalone CLI without enabling migration', () => {
  expect(
    internalRootColdHost('win32', { kind: 'repository', root: 'C:\\repo' })
      .windowsProcessPath,
  ).toBe('C:\\repo\\.cache\\bin\\win32-x64\\canopy-process-identity.exe');
  expect(
    internalRootColdHost('win32', {
      kind: 'desktop',
      resources: 'C:\\app\\resources',
    }).windowsProcessPath,
  ).toBe('C:\\app\\resources\\bin\\canopy-process-identity.exe');
  expect(
    internalRootColdHost('win32', {
      kind: 'cli',
      executable: 'C:\\cli\\canopy.exe',
    }).windowsProcessPath,
  ).toBe('C:\\cli\\canopy-process-identity.exe');
  expect(
    internalRootColdHost('linux', { kind: 'repository', root: '/repo' })
      .windowsProcessPath,
  ).toBeUndefined();
});
if (process.platform === 'linux' || process.platform === 'win32') {
  const os = process.platform;
  it('probes the native socket/pipe directly without a descriptor and refuses an accepting daemon', async () => {
    const root = await mkdtemp(
      join(os === 'linux' ? '/tmp' : await realpath(tmpdir()), 'cold-ep-'),
    );
    const endpoints = createPlatformEndpointServices(os);
    const address = endpoints.address({ dataRoot: root, endpointName: 'core' });
    const server = createServer((socket) => socket.destroy());
    try {
      if (os === 'linux')
        await import('node:fs/promises').then((fs) =>
          fs.mkdir(join(root, 'runtime')),
        );
      await expect(
        assertInternalRootNativeDaemonStopped(root, os),
      ).resolves.toBeUndefined();
      server.listen(address.path);
      await once(server, 'listening');
      await expect(
        assertInternalRootNativeDaemonStopped(root, os),
      ).rejects.toMatchObject({ reason: 'writer-active' });
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await rm(root, { recursive: true, force: true });
    }
  });
  it('canonical affected file/cwd evidence includes process locks and external Git metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-use-'));
    try {
      const data = join(root, 'data');
      const locks = join(data, 'runtime', 'locks');
      const externalGit = join(root, 'external git metadata');
      await mkdir(locks, { recursive: true });
      await mkdir(externalGit);
      const lock = join(locks, 'process.db');
      const head = join(externalGit, 'HEAD');
      await writeFile(lock, 'opaque lock database');
      await writeFile(head, 'ref: refs/heads/fixture');
      const nativeSelf = { ...self, executable: process.execPath };
      for (const file of [data, lock, head, externalGit]) {
        await expect(
          assertInternalRootNativeCold({
            os,
            rows: [nativeSelf, { ...row(process.execPath), paths: [file] }],
            roots: [data, externalGit],
            brands,
            managedPids: new Set(),
            selfPid: 99,
          }),
        ).rejects.toMatchObject({ reason: 'writer-active' });
      }
      await expect(
        assertInternalRootNativeCold({
          os,
          rows: [
            nativeSelf,
            { ...row(process.execPath), paths: [join(root, 'unrelated')] },
          ],
          roots: [data, externalGit],
          brands,
          managedPids: new Set(),
          selfPid: 99,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
