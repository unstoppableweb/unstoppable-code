import syncFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { observeStoragePathSync } from '../storage-path-observation';
import { isFullyQualified } from '../paths';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { createPlatformEndpointServices } from '../endpoints';
import { hostPlatformOperatingSystem } from '../platform-services';
import { relocateSecureStorage } from '../secure-storage-relocation';
import {
  assertSecureStorageDaemonStopped,
  assertHostBuildStorageStartup,
  readInternalRootStartup,
  assertOwnedStorageDirectory,
  canonicalStoragePath,
  storagePathPresent,
} from '../build-storage-startup';
import {
  assertBuildStorageStartup,
  assertDaemonSecureStorageReady,
} from '@canopy/core-runtime/node/build-storage-startup';
import {
  historicalSecureDataDir,
  resolveBuildStoragePaths,
} from '@canopy/core-runtime/node/secure-data-dir';
import { openVaultStore } from '../../../core-runtime/src/node/vault/repository/store';
import {
  recordingSecureFiles,
  writeTestHeader,
  putIntent,
} from '../../../core-runtime/src/node/vault/repository/__tests__/store-fixtures';
import canopy from '../../../../brands/canopy/brand.json';
import unstoppable from '../../../../brands/unstoppable-code/brand.json';

let home: string;
let priorEnvironment: {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
};
beforeEach(async () => {
  const temporary = await realpath(tmpdir());
  const parent =
    process.platform === 'win32' ||
    Buffer.byteLength(
      join(temporary, 'secure-move-XXXXXX', 'runtime', '.000000000000'),
    ) <= 103
      ? temporary
      : await realpath('/tmp');
  home = await realpath(await mkdtemp(join(parent, 'secure-move-')));
  if (!home.startsWith(join(parent, 'secure-move-')))
    throw new Error('Unsafe test HOME');
  priorEnvironment = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = process.env.USERPROFILE = home;
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});
const cold = (): Promise<void> => Promise.resolve();

for (const brand of [canopy, unstoppable]) {
  it.each(['stable', 'internal', 'rc', 'dev'] as const)(
    `${brand.id} %s moves only its own bytes and all SQLite members`,
    async (build) => {
      const paths = resolveBuildStoragePaths({
        home,
        brand,
        identity: { brandId: brand.id, build },
      });
      const historical = historicalSecureDataDir(
        home,
        brand.storage.secureDataDirNames,
        build,
      );
      await mkdir(join(historical, 'vault'), { recursive: true, mode: 0o700 });
      const members = [
        'github-pat.enc',
        'vault/vault.sqlite',
        'vault/vault.sqlite-wal',
        'vault/vault.sqlite-shm',
        'vault/vault.sqlite-journal',
        'vault/migration-progress.json',
      ];
      const bytes = members.map(() => randomBytes(64));
      for (const [index, name] of members.entries())
        await writeFile(join(historical, name), bytes[index], { mode: 0o600 });
      const before = await Promise.all(
        members.map((name) => stat(join(historical, name))),
      );
      const other = join(home, '.other-build-secure');
      await mkdir(other);
      await writeFile(join(other, 'keep'), 'foreign');
      expect(
        await relocateSecureStorage({
          historical,
          dataRoot: paths.dataRoot,
          assertCold: cold,
        }),
      ).toBe('moved');
      for (const [index, name] of members.entries()) {
        expect(await readFile(join(paths.secureDataRoot, name))).toEqual(
          bytes[index],
        );
        const after = await stat(join(paths.secureDataRoot, name));
        expect(after.mode).toBe(before[index].mode);
        expect(after.ino).toBe(before[index].ino);
      }
      expect(await readFile(join(other, 'keep'), 'utf8')).toBe('foreign');
      expect(
        await relocateSecureStorage({
          historical,
          dataRoot: paths.dataRoot,
          assertCold: cold,
        }),
      ).toBe('current');
      await expect(stat(historical)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
}

it('preserves a cold real vault header, schema and pending intent', async () => {
  const historical = join(home, '.canopy-rc-secure');
  await mkdir(historical, { mode: 0o700 });
  const platform = {
    os: 'darwin' as const,
    secureFiles: recordingSecureFiles(),
  };
  const opened = await openVaultStore({
    folder: join(historical, 'vault'),
    platform,
  });
  if (opened.kind !== 'opened') throw new Error(opened.kind);
  writeTestHeader(opened.store);
  const intent = opened.store.recordIntent(putIntent('migration-progress'));
  expect(intent.kind).toBe('written');
  const header = opened.store.header;
  const intents = opened.store.listIntents();
  const durability = opened.store.durability();
  opened.store.close();
  const snapshot = await readFile(join(historical, 'vault', 'vault.sqlite'));
  const dataRoot = join(home, '.canopy-rc');
  await relocateSecureStorage({ historical, dataRoot, assertCold: cold });
  const folder = join(dataRoot, 'secure-storage', 'vault');
  expect(await readFile(join(folder, 'vault.sqlite'))).toEqual(snapshot);
  const reopened = await openVaultStore({ folder, platform });
  if (reopened.kind !== 'opened') throw new Error(reopened.kind);
  try {
    expect(reopened.store.header).toEqual(header);
    expect(reopened.store.listIntents()).toEqual(intents);
    expect(reopened.store.durability()).toEqual(durability);
  } finally {
    reopened.store.close();
  }
});

it('never merges populated destinations or re-adopts a recreated source', async () => {
  const historical = join(home, '.canopy-secure-dev');
  const dataRoot = join(home, '.canopy-dev');
  await mkdir(historical);
  await writeFile(join(historical, 'own'), 'old');
  await relocateSecureStorage({ historical, dataRoot, assertCold: cold });
  await mkdir(historical);
  await writeFile(join(historical, 'other'), 'recreated');
  await expect(
    relocateSecureStorage({ historical, dataRoot, assertCold: cold }),
  ).rejects.toMatchObject({ reason: 'secure-relocation-conflict' });
  expect(await readdir(join(dataRoot, 'secure-storage'))).toEqual(['own']);
  expect(await readFile(join(historical, 'other'), 'utf8')).toBe('recreated');
});

it('allows an empty destination, and missing history leaves valid state unchanged', async () => {
  const dataRoot = join(home, '.canopy-dev');
  const historical = join(home, '.canopy-secure-dev');
  expect(
    await relocateSecureStorage({ historical, dataRoot, assertCold: cold }),
  ).toBe('absent');
  await expect(stat(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(join(dataRoot, 'secure-storage'), { recursive: true });
  await mkdir(historical);
  await writeFile(join(historical, 'own'), 'generated');
  expect(
    await relocateSecureStorage({ historical, dataRoot, assertCold: cold }),
  ).toBe('moved');
  const before = await stat(join(dataRoot, 'secure-storage', 'own'));
  expect(
    await relocateSecureStorage({ historical, dataRoot, assertCold: cold }),
  ).toBe('current');
  expect((await stat(join(dataRoot, 'secure-storage', 'own'))).ino).toBe(
    before.ino,
  );
});

it('refuses an unqualified cold proof before creating the destination root', async () => {
  const historical = join(home, '.canopy-secure-dev');
  const dataRoot = join(home, '.canopy-dev');
  await mkdir(historical);
  const assertCold = (): Promise<void> =>
    Promise.reject(new Error('writer active'));
  await expect(
    relocateSecureStorage({ historical, dataRoot, assertCold }),
  ).rejects.toThrow('writer active');
  await expect(stat(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(historical)).isDirectory()).toBe(true);
});

it.each(['source', 'destination', 'root'] as const)(
  'refuses an aliased %s without modifying the target',
  async (which) => {
    const target = join(home, 'target');
    const historical = join(home, '.canopy-secure-dev');
    const dataRoot = join(home, '.canopy-dev');
    await mkdir(target);
    await writeFile(join(target, 'keep'), 'generated');
    if (which === 'source') await symlink(target, historical, 'junction');
    else {
      await mkdir(historical);
      if (which === 'root') await symlink(target, dataRoot, 'junction');
      else {
        await mkdir(dataRoot);
        await symlink(target, join(dataRoot, 'secure-storage'), 'junction');
      }
    }
    await expect(
      relocateSecureStorage({ historical, dataRoot, assertCold: cold }),
    ).rejects.toMatchObject({ reason: 'secure-relocation-unsafe' });
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('generated');
  },
);

it('refuses an accepting endpoint, and accepts an absent endpoint', async () => {
  const address = createPlatformEndpointServices(
    hostPlatformOperatingSystem(),
  ).address({ dataRoot: home, endpointName: 'core' }).path;
  await assertSecureStorageDaemonStopped(address);
  await mkdir(join(home, 'runtime'), { mode: 0o700 });
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  try {
    await expect(
      assertSecureStorageDaemonStopped(address),
    ).rejects.toMatchObject({ reason: 'secure-relocation-unsafe' });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each(['required', 'incomplete', 'unsupported'] as const)(
  'refuses %s internal evidence before writes',
  (internalState) => {
    expect(() =>
      assertBuildStorageStartup({
        build: 'internal',
        internalState,
        migrationCommand: 'maintenance --apply',
      }),
    ).toThrow('maintenance --apply');
  },
);
it.each(['fresh', 'complete'] as const)(
  'admits %s internal evidence independently of retained source history',
  (internalState) => {
    expect(() =>
      assertBuildStorageStartup({
        build: 'internal',
        internalState,
        migrationCommand: 'maintenance --apply',
      }),
    ).not.toThrow();
  },
);
it.each(['required', 'stable-owned', 'incomplete', 'unsupported'] as const)(
  'installed %s evidence returns its structured refusal reason',
  (internalState) => {
    const startup = (): void =>
      assertBuildStorageStartup({ build: 'internal', internalState });
    expect.assertions(1);
    try {
      startup();
    } catch (error) {
      expect(error).toMatchObject({
        reason: `internal-migration-${internalState}`,
      });
    }
  },
);
it('keeps journal parsing B-owned and refuses predecessor history without it', async () => {
  await mkdir(join(home, '.canopy'));
  await writeFile(join(home, '.canopy', 'history'), 'retained history');
  expect(() =>
    assertHostBuildStorageStartup({
      home,
      identity: { brandId: 'canopy', build: 'internal' },
    }),
  ).toThrow('--brand=canopy --apply');
});
it.each([false, true])(
  'daemon refuses pending secure relocation (nested=%s)',
  (nestedPresent) => {
    expect(() =>
      assertDaemonSecureStorageReady({
        historicalPresent: true,
        nestedPresent,
      }),
    ).toThrow();
    expect(() =>
      assertDaemonSecureStorageReady({
        historicalPresent: false,
        nestedPresent,
      }),
    ).not.toThrow();
  },
);

it('refuses EXDEV without copying or losing the historical files', async () => {
  const historical = join(home, '.canopy-rc-secure');
  const dataRoot = join(home, '.canopy-rc');
  await mkdir(historical);
  await writeFile(join(historical, 'keep'), 'generated');
  jest
    .spyOn(fsPromises, 'rename')
    .mockRejectedValueOnce(
      Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
    );
  await expect(
    relocateSecureStorage({ historical, dataRoot, assertCold: cold }),
  ).rejects.toMatchObject({ reason: 'secure-relocation-unsafe' });
  expect(await readFile(join(historical, 'keep'), 'utf8')).toBe('generated');
  await expect(stat(join(dataRoot, 'secure-storage'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('refuses a nested alias without moving its target', async () => {
  const historical = join(home, '.canopy-rc-secure');
  await mkdir(historical);
  const target = join(home, 'foreign');
  await mkdir(target);
  await symlink(target, join(historical, 'vault'), 'junction');
  await expect(
    relocateSecureStorage({
      historical,
      dataRoot: join(home, '.canopy-rc'),
      assertCold: cold,
    }),
  ).rejects.toMatchObject({ reason: 'secure-relocation-unsafe' });
  expect((await stat(target)).isDirectory()).toBe(true);
});

it.each(['root', 'source'] as const)(
  'refuses a %s exchanged while proving cold',
  async (which) => {
    const historical = join(home, '.canopy-rc-secure');
    const dataRoot = join(home, '.canopy-rc');
    const target = join(home, 'foreign');
    await mkdir(historical);
    await mkdir(dataRoot);
    await mkdir(target);
    await writeFile(join(historical, 'keep'), 'own-generated-bytes');
    await expect(
      relocateSecureStorage({
        historical,
        dataRoot,
        assertCold: async () => {
          if (which === 'root') {
            await rm(dataRoot, { recursive: true });
            await symlink(target, dataRoot, 'junction');
          } else {
            await rename(historical, join(home, 'retained'));
            await mkdir(historical);
            await writeFile(join(historical, 'foreign'), 'do-not-adopt');
          }
        },
      }),
    ).rejects.toMatchObject({ reason: 'secure-relocation-unsafe' });
    const retained = which === 'root' ? historical : join(home, 'retained');
    expect(await readFile(join(retained, 'keep'), 'utf8')).toBe(
      'own-generated-bytes',
    );
    await expect(stat(join(dataRoot, 'secure-storage'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    if (which === 'source')
      expect(await readFile(join(historical, 'foreign'), 'utf8')).toBe(
        'do-not-adopt',
      );
  },
);

it.each([canopy, unstoppable])(
  '$id validates every internal startup outcome through B journal evidence and cleanup report staging',
  async (brand) => {
    const source = join(home, `.${brand.id}`);
    const destination = join(home, `.${brand.id}-internal`);
    const coordination = join(home, `.${brand.id}-internal-migration`);
    const identity = { brandId: brand.id, build: 'internal' as const };
    const startup = (): void =>
      assertHostBuildStorageStartup({ home, identity });
    const stableStartup = (): void =>
      assertHostBuildStorageStartup({
        home,
        identity: { ...identity, build: 'stable' },
      });
    expect(startup).not.toThrow(); // Neither root: secure-only history is independent.
    await mkdir(join(home, `.${brand.id}-internal-secure`), { mode: 0o700 });
    expect(startup).not.toThrow();
    await mkdir(source, { mode: 0o700 });
    const emptySource = await lstat(source);
    expect(startup).not.toThrow();
    expect(await readdir(source)).toEqual([]);
    expect((await lstat(source)).ino).toBe(emptySource.ino);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    const choice = join(home, `.${brand.id}-internal-startup.json`);
    await writeFile(choice, '{}', { mode: 0o600 });
    expect(startup).toThrow('unsupported');
    await rm(choice);
    const orphan = `${destination}.migration-staging`;
    await mkdir(orphan, { mode: 0o700 });
    expect(startup).toThrow('unsupported');
    await rm(orphan, { recursive: true });
    // Even a hidden entry is predecessor history, not an empty installation.
    await writeFile(join(source, '.history'), 'retained history');
    expect(startup).toThrow('--apply');
    if (brand.id === 'unstoppable-code')
      expect(startup).toThrow('--declare-internal');
    await mkdir(destination, { mode: 0o700 });
    await writeFile(join(destination, 'independent'), 'never merge');
    expect(startup).toThrow('required');
    expect(await readFile(join(destination, 'independent'), 'utf8')).toBe(
      'never merge',
    );
    await mkdir(coordination, { mode: 0o700 });
    if (process.platform === 'win32') {
      const system = process.env.SystemRoot;
      if (!system) throw new Error('Missing trusted Windows system directory');
      const sid = execFileSync(
        join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      for (const path of [coordination, destination]) {
        execFileSync(
          join(system, 'System32', 'icacls.exe'),
          [path, '/setowner', `*${sid}`],
          { windowsHide: true },
        );
        execFileSync(
          join(system, 'System32', 'icacls.exe'),
          [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
          { windowsHide: true },
        );
      }
    }
    expect(stableStartup).not.toThrow();
    for (const name of ['coordination.sqlite', 'coordination.sqlite-journal']) {
      const path = join(coordination, name);
      await writeFile(path, 'lock-only evidence', { mode: 0o600 });
      expect(stableStartup).not.toThrow();
      expect(startup).toThrow('required');
      expect(await readFile(path, 'utf8')).toBe('lock-only evidence');
    }
    const staging = join(
      coordination,
      'cleanup-candidates.json.12345678-1234-4234-8234-123456789abc.tmp',
    );
    await writeFile(staging, '{"version":', { mode: 0o600 });
    expect(stableStartup).not.toThrow();
    expect(startup).toThrow('required');
    if (process.platform !== 'win32') {
      expect(
        readInternalRootStartup({
          home,
          identity,
          observation: {
            os: hostPlatformOperatingSystem(),
            // Directory ownership passes; the staging file's owner must also match.
            getuid: jest
              .fn<number | undefined, []>()
              .mockReturnValueOnce(process.getuid?.())
              .mockReturnValue((process.getuid?.() ?? 0) + 1),
            readWindowsAcl: () => {
              throw new Error('Not a Windows node');
            },
          },
        }),
      ).toBe('unsupported');
      await fsPromises.chmod(staging, 0o644);
      expect(stableStartup).toThrow('unsupported');
      await fsPromises.chmod(staging, 0o600);
    }
    const alias = join(home, 'staging-hardlink');
    await fsPromises.link(staging, alias);
    expect(stableStartup).toThrow('unsupported');
    await rm(alias);
    await fsPromises.truncate(staging, 16 * 1024 * 1024 + 1);
    expect(stableStartup).toThrow('unsupported');
    await fsPromises.truncate(staging, 16 * 1024 * 1024);
    expect(stableStartup).not.toThrow();
    expect(startup).toThrow('required');
    await fsPromises.truncate(staging, 0);
    expect(stableStartup).not.toThrow();
    const invalidStaging = `${staging}.other`;
    await rename(staging, invalidStaging);
    expect(stableStartup).toThrow('unsupported');
    await rm(invalidStaging);
    const unexpected = join(coordination, 'unexpected');
    await writeFile(unexpected, 'preserve unknown evidence', { mode: 0o600 });
    expect(startup).toThrow('unsupported');
    expect(stableStartup).toThrow('unsupported');
    expect(await readFile(unexpected, 'utf8')).toBe(
      'preserve unknown evidence',
    );
    await rm(unexpected);
    await mkdir(join(source, 'secure-storage'), { mode: 0o700 });
    expect(stableStartup).not.toThrow();
    if (brand.id === 'unstoppable-code')
      expect(startup).toThrow('--skip-migration');
    const root = await lstat(destination, { bigint: true });
    const inode = `${root.dev}:${root.ino}`;
    const journal = {
      version: 7,
      transactionId: randomUUID(),
      identity: {
        brandId: brand.id,
        brandDisplayName: brand.displayName,
        build: 'internal',
        source,
        destination,
        coordination,
        historicalSecure: join(home, `.${brand.id}-internal-secure`),
      },
      phase: 'complete',
      internalDeclaration: true,
      inventory: {
        sourceIdentity: '1:2',
        destinationIdentity: null,
        fingerprint: 'a'.repeat(64),
        files: 1,
        bytes: 1,
        historicalSecure: true,
        nestedSecure: false,
        stableOwned: false,
      },
      externalFiles: [],
      externalSnapshots: [],
      stagingRoot: `${destination}.migration-staging`,
      stagingIdentity: inode,
      publicationIdentity: inode,
      publicationFingerprint: 'b'.repeat(64),
      settledFingerprint: 'c'.repeat(64),
      secureRelocation: 'complete',
    };
    const save = (value: unknown): Promise<void> =>
      writeFile(join(coordination, 'journal.json'), JSON.stringify(value), {
        mode: 0o600,
      });
    const windowsAcl = jest.fn((path: string): string =>
      JSON.stringify({
        user: 'S-1-5-21-1',
        owner: 'S-1-5-21-1',
        reparse: false,
        directory: path !== join(coordination, 'journal.json'),
        dacl: true,
        aces: [{ type: 0, sid: 'S-1-5-21-1' }],
      }),
    );
    const getuid = jest.fn(() => undefined);
    const windowsStartup = (): string =>
      readInternalRootStartup({
        home,
        identity,
        observation: { os: 'win32', getuid, readWindowsAcl: windowsAcl },
      });
    await save(journal);
    expect(startup).not.toThrow();
    expect(windowsStartup()).toBe('complete');
    expect(getuid).not.toHaveBeenCalled();
    const posixStartup = (os: 'darwin' | 'linux'): string =>
      readInternalRootStartup({
        home,
        identity,
        observation: {
          os,
          getuid: () => process.getuid?.(),
          readWindowsAcl: windowsAcl,
        },
      });
    const renumbered = `${root.dev + 1n}:${root.ino}`;
    await save({
      ...journal,
      stagingIdentity: renumbered,
      publicationIdentity: renumbered,
    });
    if (process.platform !== 'win32')
      expect(posixStartup('darwin')).toBe('complete');
    if (process.platform !== 'win32')
      expect(posixStartup('linux')).toBe('incomplete');
    expect(windowsStartup()).toBe('incomplete');
    const replaced = `${root.dev + 1n}:${root.ino + 1n}`;
    await save({
      ...journal,
      stagingIdentity: replaced,
      publicationIdentity: replaced,
    });
    if (process.platform !== 'win32')
      expect(posixStartup('darwin')).toBe('incomplete');
    await save(journal);
    for (const failure of [
      { owner: 'S-1-5-21-2' },
      { aces: [{ type: 0, sid: 'S-1-1-0' }] },
      { dacl: false },
      { reparse: true },
    ]) {
      windowsAcl.mockImplementationOnce(() =>
        JSON.stringify({
          user: 'S-1-5-21-1',
          owner: 'S-1-5-21-1',
          reparse: false,
          directory: true,
          dacl: true,
          aces: [],
          ...failure,
        }),
      );
      expect(windowsStartup()).toBe('unsupported');
    }
    windowsAcl.mockImplementationOnce(() => {
      throw new Error('ACL observation unavailable');
    });
    expect(windowsStartup()).toBe('unsupported');
    for (const phase of [
      'prepared',
      'source-settled',
      'building',
      'publishing',
      'restoring-external',
      'rebuilding',
    ]) {
      await save({ ...journal, phase, secureRelocation: 'pending' });
      expect(startup).toThrow('incomplete');
      expect(windowsStartup()).toBe('incomplete');
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { ...identity, build: 'stable' },
        }),
      ).toThrow('incomplete');
    }
    for (const version of [6, 7]) {
      await save({ ...journal, version, secureRelocation: 'pending' });
      expect(startup).toThrow('incomplete');
      expect(windowsStartup()).toBe('incomplete');
    }
    for (const raw of [
      { ...journal, version: 8 },
      { ...journal, version: 6 },
      { ...journal, unknown: true },
      { ...journal, externalFiles: ['duplicate', 'duplicate'] },
      null,
      [],
      { ...journal, transactionId: 'not-a-uuid' },
      { ...journal, inventory: { ...journal.inventory, files: 1.5 } },
      { ...journal, identity: { ...journal.identity, unknown: true } },
      {
        ...journal,
        externalSnapshots: [
          { path: '/outside', preimage: 'a'.repeat(64), mode: 0o1000 },
        ],
      },
      {
        ...journal,
        repairPlan: {
          transition: null,
          gitPlan: {},
          ownedPaths: [],
          workspaces: [],
        },
      },
    ]) {
      await save(raw);
      expect(startup).toThrow('unsupported');
      expect(stableStartup).toThrow('unsupported');
      expect(windowsStartup()).toBe('unsupported');
      expect(
        JSON.parse(await readFile(join(coordination, 'journal.json'), 'utf8')),
      ).toEqual(raw);
    }
    await save(journal);
    expect(startup).not.toThrow();
    expect(stableStartup).not.toThrow();
    await rm(source, { recursive: true });
    expect(startup).not.toThrow();
    await mkdir(source, { mode: 0o700 });
    await mkdir(join(source, 'secure-storage'), { mode: 0o700 });
    await writeFile(
      join(source, 'build-storage-owner.json'),
      JSON.stringify({ version: 1, brandId: brand.id, build: 'stable' }),
    );
    expect(windowsStartup()).toBe('complete');
    expect(startup).not.toThrow(); // Never re-adopt a recreated or changed source.
    await rename(destination, `${destination}.preserved`);
    await mkdir(destination, { mode: 0o700 });
    expect(windowsStartup()).toBe('incomplete');
    expect(startup).toThrow('incomplete'); // A substituted destination is not the publication.
  },
  180_000,
);

it.each([false, true])(
  'internal refuses stable-first secure adoption with accurate recovery, independent destination=%s',
  async (withDestination) => {
    const brandId = unstoppable.id;
    const source = join(home, `.${brandId}`);
    const historical = join(home, `.${brandId}-secure`);
    const destination = join(home, `.${brandId}-internal`);
    await mkdir(historical, { mode: 0o700 });
    const bytes = randomBytes(64);
    await writeFile(join(historical, 'generated.enc'), bytes, { mode: 0o600 });
    expect(() =>
      assertHostBuildStorageStartup({
        home,
        identity: { brandId, build: 'stable' },
      }),
    ).not.toThrow();
    await relocateSecureStorage({
      historical,
      dataRoot: source,
      assertCold: cold,
    });
    const secureFile = join(source, 'secure-storage', 'generated.enc');
    const before = await stat(secureFile);
    if (withDestination) {
      await mkdir(destination, { mode: 0o700 });
      await writeFile(join(destination, 'independent'), 'never merge');
    }
    const identity = { brandId, build: 'internal' as const };
    expect(readInternalRootStartup({ home, identity })).toBe('stable-owned');
    const startup = (): void =>
      assertHostBuildStorageStartup({ home, identity });
    let refusal: unknown;
    try {
      startup();
    } catch (error: unknown) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      reason: 'internal-migration-stable-owned',
    });
    expect(startup).toThrow("Couldn't start the internal build");
    expect(startup).toThrow('assisted');
    expect(startup).toThrow('--skip-migration');
    expect(startup).not.toThrow('--apply');
    expect(await readFile(secureFile)).toEqual(bytes);
    expect((await stat(secureFile)).ino).toBe(before.ino);
    if (withDestination)
      expect(await readdir(destination)).toEqual(['independent']);
    else
      await expect(lstat(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    await expect(
      lstat(join(home, `.${brandId}-internal-migration`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it.each([canopy, unstoppable])(
  '$id refuses orphan staging without a predecessor or readable journal',
  async (brand) => {
    const destination = join(home, `.${brand.id}-internal`);
    const staging = `${destination}.migration-staging`;
    const coordination = join(home, `.${brand.id}-internal-migration`);
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, 'keep'), 'unrecognized migration payload');
    for (const withCoordination of [false, true]) {
      if (withCoordination) {
        await mkdir(coordination, { mode: 0o700 });
        await writeFile(join(coordination, 'coordination.sqlite'), '', {
          mode: 0o600,
        });
      }
      const before = await readdir(home);
      for (const build of ['internal', 'stable'] as const) {
        const startup = (): void =>
          assertHostBuildStorageStartup({
            home,
            identity: { brandId: brand.id, build },
          });
        expect(startup).toThrow('unsupported');
        expect(startup).toThrow(
          `--brand=${brand.id} --apply${brand.id === 'unstoppable-code' ? ' --declare-internal' : ''}`,
        );
      }
      expect(await readdir(home)).toEqual(before);
      expect(await readFile(join(staging, 'keep'), 'utf8')).toBe(
        'unrecognized migration payload',
      );
      await expect(lstat(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  },
);

it('canonicalizes HOME aliases and nearest existing ancestors without adopting storage aliases', async () => {
  const alias = join(home, 'home-alias');
  await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(canonicalStoragePath(alias)).toBe(home);
  expect(canonicalStoragePath(join(alias, 'missing', 'nested'))).toBe(
    join(home, 'missing', 'nested'),
  );
  const upper = join(dirname(home), basename(home).toUpperCase());
  expect(canonicalStoragePath(upper)).toBe(
    storagePathPresent(upper) ? home : upper,
  );
  const historical = join(alias, '.canopy-secure-dev');
  await mkdir(historical);
  await expect(
    relocateSecureStorage({
      historical,
      dataRoot: join(alias, '.canopy-dev'),
      assertCold: cold,
    }),
  ).rejects.toMatchObject({ reason: 'secure-relocation-unsafe' });
  expect((await lstat(historical)).isDirectory()).toBe(true);
});

it('does not disguise filesystem errors as missing-root override paths', async () => {
  const file = join(home, 'not-a-directory');
  await writeFile(file, 'generated');
  expect(() => canonicalStoragePath(join(file, 'child'))).toThrow();
  const loop = join(home, 'loop');
  await symlink(loop, loop, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => canonicalStoragePath(loop)).toThrow();
});

describe('shared storage path observation matrix', () => {
  it.each([
    { name: 'directory', suffix: [], expected: 'directory' },
    { name: 'missing root', suffix: ['missing'], expected: 'missing' },
    {
      name: 'missing nested suffix',
      suffix: ['missing', 'nested'],
      expected: 'missing',
    },
    { name: 'file leaf', suffix: ['file'], expected: 'file' },
    { name: 'file at parent', suffix: ['file', 'child'], expected: 'refused' },
    {
      name: 'file at distant ancestor',
      suffix: ['file', 'child', 'nested'],
      expected: 'refused',
    },
  ])('$name', async ({ suffix, expected }) => {
    await writeFile(join(home, 'file'), 'generated');
    const path = join(home, ...suffix);
    if (expected === 'refused') {
      expect(() => observeStoragePathSync(path)).toThrow();
      expect(() => canonicalStoragePath(path)).toThrow();
      expect(() => storagePathPresent(path)).toThrow();
      return;
    }
    const observation = observeStoragePathSync(path);
    expect(observation).toMatchObject({
      requestedPath: path,
      canonicalPath: path,
      kind: expected,
      missingComponents: expected === 'missing' ? suffix : [],
      symbolicLinkComponents: [],
      existingAncestor: expected === 'missing' ? home : path,
    });
    expect(observation.stat === undefined).toBe(expected === 'missing');
    expect(storagePathPresent(path)).toBe(expected !== 'missing');
    expect(canonicalStoragePath(path)).toBe(path);
    if (expected === 'file')
      expect(() => assertOwnedStorageDirectory(path)).toThrow();
  });

  it('refuses file traversal even with Windows-shaped ENOENT from realpath', async () => {
    const file = join(home, 'file');
    await writeFile(file, 'generated');
    const native = syncFs.realpathSync.native;
    jest.spyOn(syncFs.realpathSync, 'native').mockImplementation((path) => {
      if (
        String(path).startsWith(
          file + (process.platform === 'win32' ? '\\' : '/'),
        )
      )
        throw Object.assign(new Error('Windows missing'), { code: 'ENOENT' });
      return native(path);
    });
    expect(() => observeStoragePathSync(join(file, 'child'))).toThrow();
    expect(() => canonicalStoragePath(join(file, 'child'))).toThrow();
  });

  it.each([
    '.canopy-dev',
    '.canopy-secure-dev',
    '.canopy-internal-migration',
    '.canopy-dev/secure-storage',
  ])(
    'preserves alias evidence at %s, even under missing suffixes',
    async (name) => {
      const target = join(home, 'target');
      const alias = join(home, name);
      await mkdir(target);
      await mkdir(dirname(alias), { recursive: true });
      await symlink(
        target,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      for (const suffix of [[], ['missing', 'nested']]) {
        const observation = observeStoragePathSync(join(alias, ...suffix));
        expect(observation.canonicalPath).toBe(join(target, ...suffix));
        expect(observation.symbolicLinkComponents).toEqual([alias]);
        expect(() =>
          assertOwnedStorageDirectory(join(alias, ...suffix)),
        ).toThrow();
      }
      // Trust applies to HOME only, before deriving owned paths.
      expect(
        assertOwnedStorageDirectory(join(canonicalStoragePath(alias), 'fresh'))
          .kind,
      ).toBe('missing');
    },
  );

  it.each(['dangling', 'cycle'])(
    '%s links are not missing roots',
    async (name) => {
      const alias = join(home, name);
      await symlink(
        name === 'cycle' ? alias : join(home, 'absent'),
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      for (const path of [alias, join(alias, 'nested')])
        expect(() => observeStoragePathSync(path)).toThrow();
    },
  );

  it.each(['EACCES', 'EIO'])(
    '%s observations throw instead of projecting a missing suffix',
    (code) => {
      const original = syncFs.lstatSync;
      const path = join(home, 'blocked');
      jest.spyOn(syncFs, 'lstatSync').mockImplementation((input) => {
        if (String(input) === path)
          throw Object.assign(new Error('unreadable'), { code });
        return original(input);
      });
      expect(() => observeStoragePathSync(path)).toThrow('unreadable');
      expect(syncFs.lstatSync).toHaveBeenCalledWith(path);
    },
  );

  it('uses native observed case identity, preserving genuinely missing suffix spelling', async () => {
    const path = join(home, 'MixedCase');
    const variant = join(home, 'MIXEDCASE');
    await mkdir(path);
    const observed = observeStoragePathSync(variant);
    const present = syncFs.existsSync(variant);
    expect(observed.kind).toBe(present ? 'directory' : 'missing');
    expect(observed.canonicalPath).toBe(
      present ? canonicalStoragePath(path) : variant,
    );
    expect(
      observeStoragePathSync(join(variant, 'NotCreated')).canonicalPath,
    ).toBe(join(observed.canonicalPath, 'NotCreated'));
  });

  it('uses an available Windows short spelling without inventing an alias identity', async () => {
    if (process.platform !== 'win32') return;
    const longPath = join(home, 'LongStorageDirectory');
    const shortPath = join(home, 'LONGST~1');
    await mkdir(longPath);
    const observation = observeStoragePathSync(shortPath);
    if (syncFs.existsSync(shortPath)) {
      expect(observation.canonicalPath).toBe(canonicalStoragePath(longPath));
      expect(observation.kind).toBe('directory');
      expect(observation.symbolicLinkComponents).toEqual([]);
    } else {
      // Volumes with 8.3 generation disabled must retain this as a missing name.
      expect(observation.kind).toBe('missing');
      expect(observation.canonicalPath).toBe(shortPath);
    }
  });

  it('rejects unqualified or device paths before filesystem observation', () => {
    const invalid = ['', '.', 'relative/path', 'invalid\0path'];
    if (process.platform === 'win32')
      invalid.push(
        'C:relative',
        '\\rooted',
        '\\\\?\\C:\\device',
        '\\\\.\\pipe\\device',
      );
    for (const path of invalid) {
      expect(isFullyQualified(hostPlatformOperatingSystem(), path)).toBe(false);
      expect(() => observeStoragePathSync(path)).toThrow();
    }
  });

  it.each(['darwin', 'linux'] as const)(
    '%s endpoint limits select aliases using socket and bind-sibling bytes',
    (os) => {
      const services = createPlatformEndpointServices(os, {
        getuid: () => 501,
      });
      const withoutOwner = createPlatformEndpointServices(os, {
        getuid: () => undefined,
      });
      const limit = os === 'darwin' ? 103 : 107;
      for (const unit of ['a', 'é']) {
        for (let length = 20; length < 110; length++) {
          const root = '/' + unit.repeat(length);
          const bytes = Math.max(
            Buffer.byteLength(root + '/runtime/core.sock'),
            Buffer.byteLength(root + '/runtime/.000000000000'),
          );
          const request = { dataRoot: root, endpointName: 'core' };
          const address = services.address(request);
          expect(address.kind).toBe('unix-socket');
          if (address.kind !== 'unix-socket')
            throw new Error('Expected socket');
          expect(Buffer.byteLength(address.path)).toBeLessThanOrEqual(limit);
          expect(
            Buffer.byteLength(
              posix.join(posix.dirname(address.path), '.000000000000'),
            ),
          ).toBeLessThanOrEqual(limit);
          if (bytes > limit) {
            expect(address.alias).toBeDefined();
            if (!address.alias) throw new Error('Expected socket alias');
            expect(address.alias.runtimeDirectory).toBe(root + '/runtime');
            expect(address.path).toBe(
              posix.join(address.alias.link, 'core.sock'),
            );
            expect(() => withoutOwner.address(request)).toThrow(
              'Socket path too long',
            );
          } else {
            expect(address.alias).toBeUndefined();
            expect(address.path).toBe(root + '/runtime/core.sock');
            expect(withoutOwner.address(request)).toEqual(address);
          }
        }
      }
    },
  );
});

(process.platform === 'win32' ? it.skip : it)(
  'keeps an empty-internal choice across Darwin device renumbering, not root replacement',
  async () => {
    const destination = join(home, '.canopy-internal');
    await mkdir(destination, { mode: 0o700 });
    await mkdir(join(home, '.canopy'), { mode: 0o700 });
    const root = await lstat(destination, { bigint: true });
    const path = join(home, '.canopy-internal-startup.json');
    const record = {
      version: 1,
      choice: 'empty-internal',
      brandId: 'canopy',
      destination,
      principal: String(process.getuid?.()),
      publicationIdentity: `${root.dev + 1n}:${root.ino}`,
    };
    const read = (os: 'darwin' | 'linux'): string =>
      readInternalRootStartup({
        home,
        identity: { brandId: 'canopy', build: 'internal' },
        observation: {
          os,
          getuid: () => process.getuid?.(),
          readWindowsAcl: () => {
            throw new Error('not Windows');
          },
        },
      });
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    expect(read('darwin')).toBe('fresh');
    expect(read('linux')).toBe('unsupported');
    for (const publicationIdentity of [
      null,
      '',
      'not-an-identity',
      `${root.dev + 1n}:${root.ino}\n`,
      `device:${root.ino}`,
      `${root.dev}:0`,
    ]) {
      await writeFile(path, JSON.stringify({ ...record, publicationIdentity }));
      expect(read('darwin')).toBe('unsupported');
    }
    await writeFile(
      path,
      JSON.stringify({
        ...record,
        publicationIdentity: `${root.dev + 1n}:${root.ino + 1n}`,
      }),
    );
    expect(read('darwin')).toBe('unsupported');
  },
);
