import fs from 'node:fs/promises';
import syncFs, {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  type Stats,
} from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep, win32 } from 'node:path';
import * as platform from '@canopy/core-platform/host-platform';
import canopy from '../../../../../../brands/canopy/brand.json';
import unstoppableCode from '../../../../../../brands/unstoppable-code/brand.json';
import {
  migrateInternalRoot,
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootInventory,
  type InternalRootJournal,
  type InternalRootMigrationWorker,
  type InternalRootRepairContext,
  type InternalRootRepairs,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  gitBacklinkText,
  isWithin,
  movedOwnedPath,
  prepareRelocationGit,
  qualifyRelocationGit,
  relocationTransition,
  repairRelocationGit,
  type RelocationGitPlan,
} from '@canopy/core-runtime/node/relocation';
import { createInternalRootMigrationWorker } from '..';
import { createFreshInternalRoot } from '../fresh-start';
import { createInternalRootRepairs } from '@canopy/core-runtime/node/internal-root-repairs';
import {
  buildInternalRoot,
  flush,
  internalRootIdentity,
  internalRootStaging,
  isWithinInternalRoot,
  isPrunedInternalRootCheckout,
  preserveUnpublishedInternalRoot,
  publishInternalRoot,
  validateExternalRootFiles,
  validateInternalRootStaging,
} from '../filesystem';
import {
  createPrivateMigrationDirectory,
  internalRootFilesystemHost,
  migrationNodeIdentity,
  ownedMigrationNode,
  observeMigrationNode,
  qualifyMigrationGroup,
  type InternalRootFilesystemHost,
} from '../filesystem-host';
import * as progress from '../progress';

jest.setTimeout(30_000);
const execute = promisify(execFile);
const windows = process.platform === 'win32';
const linux = process.platform === 'linux';
const windowsTest = windows ? test : test.skip;
const linuxTest = linux ? test : test.skip;
const linuxGroups = linux ? (process.getgroups?.() ?? []) : [];
const supplementaryGroup = linuxGroups.find(
  (gid) => gid !== process.getegid?.(),
);
const linuxSecondGroupTest =
  linux && supplementaryGroup !== undefined ? test : test.skip;
const posixTest = windows ? test.skip : test;
const copyTest = windows || linux ? test : test.skip;
const darwinTest = process.platform === 'darwin' ? test : test.skip;
let ownedChildPath =
  windows || linux
    ? resolve(
        '.cache/native-owned-child',
        `${process.platform}-${process.arch}`,
        'core-owned-child.node',
      )
    : undefined;
let nativeBuild: string | undefined;
beforeAll(() => {
  if (!linux) return;
  nativeBuild = mkdtempSync(join(tmpdir(), 'migration-native-'));
  ownedChildPath = join(nativeBuild, 'core-owned-child.node');
  execFileSync(
    process.execPath,
    [resolve('scripts/build-owned-child.mjs'), '--out', ownedChildPath],
    { stdio: 'pipe' },
  );
}, 60_000);
afterAll(() => {
  if (nativeBuild) rmSync(nativeBuild, { recursive: true, force: true });
});
let home: string;
let environment: { HOME: string | undefined; USERPROFILE: string | undefined };
let identity: InternalRootIdentity;
let host: InternalRootFilesystemHost;
let worker: InternalRootMigrationWorker;
const apply = { apply: true, declareInternal: true };
const repairs: InternalRootRepairs = {
  prepare: () => Promise.resolve({ kind: 'ready', externalFiles: [] }),
  repair: () => Promise.resolve({ kind: 'ok' }),
  verify: () => Promise.resolve({ kind: 'ok' }),
  qualifyPublished: () => Promise.resolve({ kind: 'ok' }),
};
const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (
    await execute('git', ['--no-optional-locks', ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_AUTHOR_NAME: 'Migration fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Migration fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    })
  ).stdout;

beforeEach(async () => {
  home = await fs.realpath(
    await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'migration-')),
  );
  environment = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = process.env.USERPROFILE = home;
  host = internalRootFilesystemHost(ownedChildPath);
  identity = internalRootIdentity(home, canopy);
  await createPrivateMigrationDirectory(identity.source, host);
  await fs.writeFile(
    join(identity.source, 'opaque data α'),
    Buffer.from([0, 255, 3, 0]),
    { mode: 0o600 },
  );
  await fs.writeFile(join(identity.source, 'empty'), '', { mode: 0o600 });
  // Explicit host/test seams do not enable the installed bootstrap or W5 recovery.
  worker = createInternalRootMigrationWorker({
    ownedChildPath,
    recoverW5: () => Promise.resolve(),
    proveCold: () => Promise.resolve(),
  });
});
const originalUmask = process.umask();
afterEach(async () => {
  process.umask(originalUmask);
  jest.restoreAllMocks();
  const clonePidFile = join(home, 'clone.pid');
  if (await fs.lstat(clonePidFile).catch(() => null)) {
    const pid = Number(await fs.readFile(clonePidFile, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Invalid clone fixture PID');
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ESRCH'
      )
        throw error;
    }
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true });
});
const run = (
  effects: InternalRootMigrationWorker = worker,
  port = repairs,
): ReturnType<typeof migrateInternalRoot> =>
  migrateInternalRoot(effects, identity, apply, port);

async function journal(): Promise<InternalRootJournal> {
  const value = await worker.readJournal(identity);
  if (!value) throw new Error('Expected a durable transaction');
  return value;
}
async function assertSource(): Promise<void> {
  expect(await fs.readFile(join(identity.source, 'opaque data α'))).toEqual(
    Buffer.from([0, 255, 3, 0]),
  );
  expect(await fs.readFile(join(identity.source, 'empty'), 'utf8')).toBe('');
}

// The pre-CAN-6386 walk is the compatibility oracle for persisted seals.
async function legacyManifest(
  root: string,
  durable = false,
  omitted: (relative: string) => boolean = () => false,
  group: (relative: string, stat: Stats) => Promise<number> = (
    _relative,
    stat,
  ) => Promise.resolve(stat.gid),
): Promise<Pick<InternalRootInventory, 'fingerprint' | 'files' | 'bytes'>> {
  const rootDevice = (await fs.lstat(root)).dev;
  const hash = createHash('sha256');
  const row = (value: unknown): void => {
    hash.update(JSON.stringify(value));
    hash.update('\n');
  };
  let files = 0;
  let bytes = 0;
  async function visit(relative: string): Promise<void> {
    if (omitted(relative)) return;
    const path = join(root, relative);
    const stat = await fs.lstat(path);
    if (stat.dev !== rootDevice || !ownedMigrationNode(stat))
      throw new Error(`Unsupported parity fixture: ${path}`);
    qualifyMigrationGroup(path, stat);
    const windows = await observeMigrationNode(path, stat, host);
    const mode = stat.mode & 0o7777;
    const gid = await group(relative, stat);
    const metadata = [
      relative,
      mode,
      stat.uid,
      gid,
      stat.size,
      Math.floor(stat.mtimeMs),
    ];
    if (windows)
      row(['windows', relative, windows.attributes, windows.security]);
    if (stat.isSymbolicLink())
      row(['link', ...metadata, await fs.readlink(path)]);
    else if (stat.isDirectory()) {
      row([
        'directory',
        relative,
        mode,
        stat.uid,
        gid,
        Math.floor(stat.mtimeMs),
      ]);
      for (const child of (await fs.readdir(path)).sort())
        await visit(join(relative, child));
      if (durable) await flush(path);
    } else if (stat.isFile()) {
      const critical =
        relative.startsWith(`w5${sep}`) && stat.size <= 16 * 1024 * 1024;
      let digest: string | null = null;
      if (critical && host.windows)
        digest = createHash('sha256')
          .update(host.windows.read(path))
          .digest('hex');
      else if (critical) {
        const content = createHash('sha256');
        for await (const chunk of createReadStream(path)) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Expected file bytes');
          content.update(chunk);
        }
        digest = content.digest('hex');
      }
      row(['file', ...metadata, digest]);
      files += 1;
      bytes += stat.size;
      if (durable) await flush(path);
    } else if (!(stat.isSocket() && relative.startsWith(`runtime${sep}`)))
      throw new Error(`Unsupported parity fixture: ${path}`);
  }
  await visit('');
  return { fingerprint: hash.digest('hex'), files, bytes };
}

async function runtimeSocket(root: string): Promise<void> {
  const runtime = join(root, 'runtime');
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  // Bind relative to cwd to stay within the Unix socket path limit on macOS.
  await execute(
    process.execPath,
    [
      '-e',
      "require('node:net').createServer().listen('s', () => process.exit(0))",
    ],
    { cwd: runtime },
  );
}

posixTest.each(['empty', 'populated'])(
  'keeps legacy manifest fingerprints, counts and durable seals for a %s tree',
  async (fixture) => {
    if (fixture === 'empty') {
      await fs.unlink(join(identity.source, 'empty'));
      await fs.unlink(join(identity.source, 'opaque data α'));
    } else {
      await fs.mkdir(join(identity.source, 'nested', 'empty'), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(join(identity.source, 'nested', 'z'), 'nested bytes');
      await fs.symlink('nested/z', join(identity.source, 'a-link'));
      await fs.mkdir(join(identity.source, 'w5'), { mode: 0o700 });
      await fs.writeFile(
        join(identity.source, 'w5', 'critical'),
        Buffer.from([0, 255, 10]),
      );
      await fs.writeFile(join(identity.source, 'w5', 'empty'), '');
      for (const size of [16 * 1024 * 1024, 16 * 1024 * 1024 + 1]) {
        const handle = await fs.open(
          join(identity.source, 'w5', String(size)),
          'wx',
          0o600,
        );
        try {
          await handle.truncate(size);
        } finally {
          await handle.close();
        }
      }
      await fs.utimes(
        join(identity.source, 'w5', 'critical'),
        1.234567,
        1.234567,
      );
      await runtimeSocket(identity.source);
    }
    expect(await worker.inventory(identity)).toMatchObject(
      await legacyManifest(identity.source),
    );

    let sealed = { fingerprint: '', files: 0, bytes: 0 };
    await expect(
      run({
        ...worker,
        seal: async (saved, publicationIdentity) => {
          const staging = internalRootStaging(identity);
          if (fixture === 'populated') await runtimeSocket(staging);
          sealed = await legacyManifest(staging, true);
          const fingerprint = await worker.seal(saved, publicationIdentity);
          expect(fingerprint).toBe(sealed.fingerprint);
          return fingerprint;
        },
      }),
    ).resolves.toMatchObject({ kind: 'complete' });
    expect(sealed.fingerprint).not.toBe('');
    expect(await worker.inventory(identity, true)).toMatchObject(sealed);
    expect((await journal()).publicationFingerprint).toBe(sealed.fingerprint);
  },
);

test.each(['file', 'nested-file', 'directory', 'overlapping'])(
  'keeps both legacy fingerprints in a single source walk with %s omissions',
  async (kind) => {
    const omittedDirectory = join(identity.source, 'omitted');
    await fs.mkdir(join(omittedDirectory, 'nested'), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      join(omittedDirectory, 'nested', 'payload'),
      'retained only in source',
    );
    await fs.mkdir(join(identity.source, 'w5'), { mode: 0o700 });
    await fs.writeFile(
      join(identity.source, 'w5', 'critical'),
      'byte-hashed evidence',
    );
    if (!windows) await fs.symlink('empty', join(identity.source, 'link'));
    await expect(
      run({
        ...worker,
        build: () => Promise.reject(new Error('before build')),
      }),
    ).rejects.toThrow('before build');
    const saved = await journal();
    const abandonedPaths =
      kind === 'file'
        ? [join(identity.source, 'empty')]
        : kind === 'nested-file'
          ? [join(omittedDirectory, 'nested', 'payload')]
          : kind === 'directory'
            ? [omittedDirectory]
            : [
                omittedDirectory,
                join(omittedDirectory, 'nested'),
                join(home, 'outside-source'),
              ];
    const value: InternalRootJournal = {
      ...saved,
      repairPlan: {
        transition: relocationTransition({
          version: 1,
          installationId: saved.transactionId,
          brandId: identity.brandId,
          from: {
            authorityId: 'a'.repeat(64),
            canonicalDataRoot: identity.source,
          },
          to: {
            authorityId: 'b'.repeat(64),
            canonicalDataRoot: identity.destination,
          },
        }),
        gitPlan: await prepareRelocationGit(git, []),
        ownedPaths: [],
        workspaces: [],
        abandonedPaths,
      },
    };
    const before = await legacyManifest(identity.source);
    const result = await worker.build(value);
    expect(result.sourceInventory).toMatchObject(before);
    expect(result.sourceInventory.fingerprint).toBe(saved.settledFingerprint);
    const staging = join(identity.coordination, 'staging');
    const omitted = (relative: string): boolean =>
      abandonedPaths.some(
        (path) =>
          isWithin(identity.source, path) &&
          isWithin(path, join(identity.source, relative)),
      );
    const expected = await legacyManifest(
      identity.source,
      false,
      omitted,
      async (relative, stat) =>
        stat.isSocket()
          ? stat.gid
          : (await fs.lstat(join(staging, relative))).gid,
    );
    expect(await legacyManifest(staging)).toEqual(expected);
    expect(expected.fingerprint).not.toBe(before.fingerprint);
    expect(await legacyManifest(identity.source)).toEqual(before);
    expect(await migrationNodeIdentity(staging, await fs.lstat(staging))).toBe(
      result.publicationIdentity,
    );
  },
);

posixTest.each(['omitted-special', 'owner-record'])(
  'checks the projected copy before post-clone %s refusals',
  async (fault) => {
    const omitted = join(identity.source, 'omitted');
    await fs.mkdir(omitted, { mode: 0o700 });
    await expect(
      run({
        ...worker,
        build: () => Promise.reject(new Error('before build')),
      }),
    ).rejects.toThrow('before build');
    const saved = await journal();
    if (fault === 'omitted-special')
      await execute('mkfifo', [join(omitted, 'special')]);
    else
      await fs.writeFile(
        join(identity.source, 'build-storage-owner.json'),
        '{}',
      );
    const value: InternalRootJournal = {
      ...saved,
      repairPlan: {
        transition: relocationTransition({
          version: 1,
          installationId: saved.transactionId,
          brandId: identity.brandId,
          from: {
            authorityId: 'a'.repeat(64),
            canonicalDataRoot: identity.source,
          },
          to: {
            authorityId: 'b'.repeat(64),
            canonicalDataRoot: identity.destination,
          },
        }),
        gitPlan: await prepareRelocationGit(git, []),
        ownedPaths: [],
        workspaces: [],
        abandonedPaths: [omitted],
      },
    };
    for (const corrupt of [true, false]) {
      await expect(
        buildInternalRoot(
          value,
          async (from, to): Promise<void> => {
            await fs.cp(from, to, {
              recursive: true,
              preserveTimestamps: true,
            });
            const metadata = await fs.lstat(from);
            await fs.utimes(
              to,
              metadata.atimeMs / 1000,
              (Math.floor(metadata.mtimeMs) + 0.5) / 1000,
            );
            if (corrupt && from === join(identity.source, 'empty'))
              await fs.writeFile(to, 'copy differs from source');
          },
          host,
        ),
      ).rejects.toMatchObject({
        reason: corrupt ? 'source-changed' : 'unsupported-layout',
      });
    }
    expect(await fs.readFile(join(identity.source, 'empty'), 'utf8')).toBe('');
    expect(await fs.lstat(identity.destination).catch(() => null)).toBeNull();
  },
);

posixTest('keeps the event loop live during manifest inventory', async () => {
  for (let index = 0; index < 510; index += 1)
    await fs.writeFile(join(identity.source, String(index)), '');
  let inspected = 0;
  const samples: number[] = [];
  const sample = (): void => {
    samples.push(inspected);
    if (samples.length < 2) setImmediate(sample);
  };
  jest
    .spyOn(progress, 'internalRootMigrationProgress')
    .mockImplementation((detail) => {
      if (detail !== 'inspected manifest entry') return;
      inspected += 1;
      if (inspected === 1) setImmediate(sample);
    });
  await expect(worker.inventory(identity)).resolves.toMatchObject({
    files: 512,
    bytes: 4,
  });
  expect(samples).toEqual([256, 512]);
  expect(inspected).toBe(513);
});

test('refuses insufficient destination space before creating a transaction or staging', async () => {
  const volume = await fs.statfs(home);
  jest.spyOn(fs, 'statfs').mockResolvedValue({
    ...volume,
    bavail: 0,
  });
  const attempt = run();
  await expect(attempt).rejects.toMatchObject({ reason: 'insufficient-space' });
  await expect(attempt).rejects.toThrow(
    /required \d+ bytes, available 0 bytes/,
  );
  await expect(attempt).rejects.toThrow(JSON.stringify(identity.destination));
  expect(await worker.readJournal(identity)).toBeNull();
  await expect(
    fs.lstat(join(identity.coordination, 'staging')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  await assertSource();
});

test.each([
  'prepared',
  'source-settled',
  'building',
  'restart',
  'rebuild',
] as const)(
  'refuses low-space %s before changing the retained transaction',
  async (phase) => {
    if (phase === 'rebuild') await run();
    else {
      const effect =
        phase === 'prepared'
          ? 'recoverW5'
          : phase === 'source-settled'
            ? 'captureExternal'
            : 'build';
      await expect(
        run({
          ...worker,
          [effect]: () => Promise.reject(new Error('before construction')),
        }),
      ).rejects.toThrow('before construction');
    }
    const saved = await fs.readFile(
      join(identity.coordination, 'journal.json'),
    );
    const build = jest.fn(worker.build.bind(worker));
    await expect(
      migrateInternalRoot(
        {
          ...worker,
          space: () => Promise.resolve({ requiredBytes: 4, availableBytes: 0 }),
          build,
        },
        identity,
        {
          ...apply,
          restart: phase === 'restart',
          rebuild: phase === 'rebuild',
        },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'insufficient-space' });
    expect(build).not.toHaveBeenCalled();
    expect(
      await fs.readFile(join(identity.coordination, 'journal.json')),
    ).toEqual(saved);
    expect(
      (await fs.readdir(identity.coordination)).some((name) =>
        name.startsWith('restarted-'),
      ),
    ).toBe(false);
    await assertSource();
  },
);

test.each(['private', 'sibling', 'rebuild', 'discarding'])(
  'credits space reclaimed from %s before full-copy construction',
  async (cut) => {
    await fs.writeFile(join(identity.source, 'payload'), Buffer.alloc(16384));
    if (cut === 'rebuild' || cut === 'discarding') {
      await run();
      if (cut === 'discarding') {
        const old = await journal();
        await worker.saveJournal({
          ...old,
          phase: 'rebuilding',
          secureRelocation: 'pending',
        });
        await fs.rename(
          identity.destination,
          join(identity.coordination, 'discarding'),
        );
      }
    } else {
      await expect(
        run({
          ...worker,
          exposeStaging: async (saved) => {
            if (cut === 'sibling') await worker.exposeStaging(saved);
            throw new Error('stopped with staging');
          },
        }),
      ).rejects.toThrow('stopped with staging');
    }
    const originalSpace = worker.space.bind(worker);
    const volume = await fs.statfs(home);
    const query = jest.spyOn(fs, 'statfs').mockImplementation(async () => {
      const leftovers = await Promise.all(
        [
          identity.destination,
          internalRootStaging(identity),
          join(identity.coordination, 'staging'),
          join(identity.coordination, 'discarding'),
        ].map((path) =>
          fs.lstat(path).then(
            () => true,
            () => false,
          ),
        ),
      );
      return {
        ...volume,
        bsize: 1,
        bavail: leftovers.some(Boolean) ? 8192 : 32768,
      };
    });
    const effects: InternalRootMigrationWorker = {
      ...worker,
      space: async (...args) => {
        const os = jest
          .spyOn(platform, 'hostOperatingSystem')
          .mockReturnValue(windows ? 'win32' : 'linux');
        try {
          return await originalSpace(...args);
        } finally {
          os.mockRestore();
        }
      },
      build: async (saved) => {
        // The destination has been discarded; only staging can still occupy space.
        query.mockRestore();
        return worker.build(saved);
      },
    };
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const report = progress.internalRootMigrationProgress;
    const allocations = jest
      .spyOn(progress, 'internalRootMigrationProgress')
      .mockImplementation((detail) => {
        if (detail === 'inspected staging allocation')
          expect(progress.internalRootMigrationAbortSignal()).toBeDefined();
        report(detail);
      });
    await expect(
      migrateInternalRoot(
        progress.monitorInternalRootMigrationWorker(effects),
        identity,
        {
          ...apply,
          rebuild: cut === 'rebuild',
        },
        repairs,
      ),
    ).resolves.toMatchObject({ kind: 'complete' });
    expect(allocations).toHaveBeenCalledWith('inspected staging allocation');
    expect(stderr.mock.calls.flat().join('')).not.toContain(
      'Migration: Checking destination space\n',
    );
    await assertSource();
  },
);

test('reclaim estimate refuses a replaced private staging tree before crediting it', async () => {
  await expect(
    run({
      ...worker,
      exposeStaging: () => Promise.reject(new Error('stopped with staging')),
    }),
  ).rejects.toThrow('stopped with staging');
  const old = await journal();
  const staging = join(identity.coordination, 'staging');
  const retained = join(identity.coordination, 'original-staging');
  await fs.rename(staging, retained);
  await createPrivateMigrationDirectory(staging, host);
  await fs.writeFile(join(staging, 'unrelated'), Buffer.alloc(16384));
  const volume = await fs.statfs(home);
  jest.spyOn(fs, 'statfs').mockResolvedValue({ ...volume, bavail: 0 });
  jest
    .spyOn(platform, 'hostOperatingSystem')
    .mockReturnValue(windows ? 'win32' : 'linux');
  await expect(worker.space(identity, 32768, old)).rejects.toThrow(
    'Private staging was replaced',
  );
  expect(await fs.readFile(join(staging, 'unrelated'))).toEqual(
    Buffer.alloc(16384),
  );
  expect(await fs.readFile(join(retained, 'opaque data α'))).toEqual(
    Buffer.from([0, 255, 3, 0]),
  );
});

posixTest.each(['same', 'other'])(
  'reclaim estimate counts only disposable blocks on the destination device (%s device payload)',
  async (device) => {
    await expect(
      run({
        ...worker,
        exposeStaging: () => Promise.reject(new Error('stopped with staging')),
      }),
    ).rejects.toThrow('stopped with staging');
    const old = await journal();
    const staging = join(identity.coordination, 'staging');
    const unique = join(staging, 'unique');
    await fs.writeFile(unique, Buffer.alloc(16384));
    const outside = join(home, 'retained-payload');
    await fs.writeFile(outside, Buffer.alloc(32768));
    await fs.link(outside, join(staging, 'shared'));
    await fs.symlink(outside, join(staging, 'alias'));
    const sparse = await fs.open(join(staging, 'sparse'), 'wx');
    try {
      await sparse.truncate(1024 * 1024 * 1024);
    } finally {
      await sparse.close();
    }
    for (const root of [
      identity.destination,
      join(identity.coordination, `restarted-${randomUUID()}`),
    ]) {
      await createPrivateMigrationDirectory(root, host);
      await fs.writeFile(join(root, 'retained'), Buffer.alloc(32768));
    }
    let expected = 0;
    for (const name of ['opaque data α', 'empty', 'unique', 'sparse']) {
      if (name === 'unique' && device === 'other') continue;
      expected += (await fs.lstat(join(staging, name))).blocks * 512;
    }
    const lstat = fs.lstat.bind(fs);
    if (device === 'other')
      jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (args[0] === unique)
          stat.dev =
            typeof stat.dev === 'bigint' ? stat.dev + 1n : stat.dev + 1;
        return stat;
      });
    const volume = await fs.statfs(home);
    jest.spyOn(fs, 'statfs').mockResolvedValue({ ...volume, bavail: 0 });
    jest.spyOn(platform, 'hostOperatingSystem').mockReturnValue('linux');
    await expect(
      worker.space(identity, 1024 * 1024 * 1024, old),
    ).resolves.toEqual({
      requiredBytes: 1024 * 1024 * 1024,
      availableBytes: expected,
    });
    expect(await fs.readFile(outside)).toEqual(Buffer.alloc(32768));
  },
);

test('restart reaches fresh preparation after Git prunes a frozen admin directory', async () => {
  const common = join(home, 'external-repository');
  await createPrivateMigrationDirectory(common, host);
  await git(common, ['init']);
  await git(common, ['commit', '--allow-empty', '-m', 'fixture']);
  const checkout = join(identity.source, 'pruned-checkout');
  await git(common, ['worktree', 'add', '-b', 'pruned', checkout]);
  const admin = (
    await git(checkout, ['rev-parse', '--absolute-git-dir'])
  ).trim();
  const plan = await prepareRelocationGit(git, [common, checkout]);
  const port: InternalRootRepairs = {
    ...repairs,
    settleSourceFirst: true,
    prepare: (context) =>
      Promise.resolve({
        kind: 'ready',
        externalFiles: plan.backlinks
          .map((image) => image.path)
          .filter((path) => !isWithin(identity.source, path)),
        repairPlan: {
          transition: relocationTransition({
            version: 1,
            installationId: context.transactionId,
            brandId: identity.brandId,
            from: {
              authorityId: 'a'.repeat(64),
              canonicalDataRoot: identity.source,
            },
            to: {
              authorityId: 'b'.repeat(64),
              canonicalDataRoot: identity.destination,
            },
          }),
          gitPlan: plan,
          ownedPaths: [],
          workspaces: [],
        },
      }),
    repair: () => Promise.reject(new Error('before repair')),
  };
  await expect(run(worker, port)).rejects.toThrow('before repair');
  const old = await journal();
  await fs.rm(admin, { recursive: true });
  await fs.writeFile(join(identity.source, 'continued-work'), 'keep');
  await expect(
    migrateInternalRoot(
      {
        ...worker,
        recoverW5: (fresh) => {
          expect(fresh.phase).toBe('prepared');
          expect(fresh.transactionId).not.toBe(old.transactionId);
          return Promise.reject(new Error('fresh preparation reached'));
        },
      },
      identity,
      { ...apply, restart: true },
      port,
    ),
  ).rejects.toThrow('fresh preparation reached');
  await expect(fs.lstat(admin)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    await fs.readFile(join(identity.source, 'continued-work'), 'utf8'),
  ).toBe('keep');
  await expect(
    fs.lstat(
      join(
        identity.coordination,
        `restarted-${old.transactionId}`,
        'journal.json',
      ),
    ),
  ).resolves.toBeDefined();
});

test('Windows recovery projects a surviving backlink with a pruned target without relaxing normal repair', async () => {
  const stat = await fs.lstat(identity.source);
  const source = 'C:\\owner\\old';
  const destination = 'C:\\owner\\new';
  const checkout = win32.join(source, 'checkout');
  const common = 'C:\\repo\\.git';
  const target = win32.join(checkout, '.git');
  const backlink = win32.join(common, 'worktrees', 'removed', 'gitdir');
  const missing = Object.assign(new Error('pruned'), { code: 'ENOENT' });
  jest.doMock('node:path', () => win32);
  jest.doMock('node:fs/promises', () => ({
    ...jest.requireActual<typeof fs>('node:fs/promises'),
    lstat: (path: string): Promise<typeof stat> =>
      path === target ? Promise.reject(missing) : Promise.resolve(stat),
    realpath: (path: string): Promise<string> =>
      path === target ? Promise.reject(missing) : Promise.resolve(path),
  }));
  try {
    await jest.isolateModulesAsync(async () => {
      const { projectRelocationBacklinks: project } =
        await import('@canopy/core-runtime/node/relocation/git');
      const transition = {
        version: 1,
        installationId: 'fixture',
        brandId: 'canopy',
        from: { authorityId: 'a'.repeat(64), canonicalDataRoot: source },
        to: { authorityId: 'b'.repeat(64), canonicalDataRoot: destination },
      } as const;
      const plan: RelocationGitPlan = {
        checkouts: [
          {
            path: checkout,
            commonDirectory: common,
            head: 'HEAD',
            branch: 'main',
            status: '',
          },
        ],
        backlinks: [
          { path: backlink, contents: `${target.replace(/\\/g, '/')}\n` },
        ],
      };
      await expect(project(transition, plan)).rejects.toMatchObject({
        reason: 'symlink-git-directory',
      });
      await expect(project(transition, plan, true)).resolves.toEqual([
        {
          path: backlink,
          contents: `${win32.join(destination, 'checkout', '.git').replace(/\\/g, '/')}\n`,
        },
      ]);
      missing.code = 'EACCES';
      await expect(project(transition, plan, true)).rejects.toMatchObject({
        code: 'EACCES',
      });
      missing.code = 'ENOENT';
      jest.spyOn(stat, 'isSymbolicLink').mockReturnValue(true);
      await expect(project(transition, plan, true)).rejects.toMatchObject({
        reason: 'symlink-git-directory',
      });
    });
  } finally {
    jest.dontMock('node:path');
    jest.dontMock('node:fs/promises');
  }
});

test('restart does not credit retained staging and explains the extra space', async () => {
  await expect(
    run({
      ...worker,
      exposeStaging: () => Promise.reject(new Error('stopped with staging')),
    }),
  ).rejects.toThrow('stopped with staging');
  const old = await journal();
  const space = jest.fn(() =>
    Promise.resolve({ requiredBytes: 50, availableBytes: 30 }),
  );
  const attempt = migrateInternalRoot(
    {
      ...worker,
      space,
    },
    identity,
    { ...apply, restart: true },
    repairs,
  );
  await expect(attempt).rejects.toMatchObject({ reason: 'insufficient-space' });
  await expect(attempt).rejects.toThrow(/restart retains.*staging/i);
  expect(space).toHaveBeenCalledWith(identity, old.inventory.bytes);
  expect((await journal()).transactionId).toBe(old.transactionId);
  await expect(
    fs.lstat(join(identity.coordination, 'staging')),
  ).resolves.toBeDefined();
});

test.each(['darwin', 'linux', 'win32'] as const)(
  'estimates copy space from the destination volume on %s',
  async (os) => {
    const volume = await fs.statfs(home);
    const query = jest.spyOn(fs, 'statfs').mockResolvedValue({
      ...volume,
      type: 26,
      bsize: 4096,
      bfree: 100,
      bavail: 7,
    });
    jest.spyOn(platform, 'hostOperatingSystem').mockReturnValue(os);
    for (const bytes of [0, 128 * 1024 * 1024]) {
      await expect(worker.space(identity, bytes)).resolves.toEqual({
        requiredBytes: os === 'darwin' ? 64 * 1024 * 1024 : bytes,
        availableBytes: 7 * 4096,
      });
    }
    expect(query).toHaveBeenCalledWith(dirname(identity.destination));
  },
);

test.each(['before-journal', 'after-preservation'])(
  'retained W5 commit evidence permits recovery %s',
  async (cut) => {
    await createPrivateMigrationDirectory(identity.coordination, host);
    const evidencePath = join(
      identity.coordination,
      `abandoned-w5-commits-${randomUUID()}.json`,
    );
    const evidence = 'retained commit rows; never replay';
    if (cut === 'after-preservation') {
      await expect(
        run({
          ...worker,
          build: () => Promise.reject(new Error('before clone')),
        }),
      ).rejects.toThrow('before clone');
      await fs.writeFile(evidencePath, evidence, { mode: 0o600 });
      await preserveUnpublishedInternalRoot(await journal(), host);
    } else await fs.writeFile(evidencePath, evidence, { mode: 0o600 });
    await expect(worker.readJournal(identity)).resolves.toBeNull();
    await expect(
      createFreshInternalRoot({ identity, worker, ownedChildPath }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    await expect(
      run({
        ...worker,
        recoverW5: () => Promise.reject(new Error('fresh preparation reached')),
      }),
    ).rejects.toThrow('fresh preparation reached');
    expect(await fs.readFile(evidencePath, 'utf8')).toBe(evidence);
  },
);

posixTest.each(['symlink', 'public', 'unknown-name'])(
  'journal-free recovery refuses unsafe W5 commit evidence: %s',
  async (fault) => {
    await createPrivateMigrationDirectory(identity.coordination, host);
    const evidencePath = join(
      identity.coordination,
      `abandoned-w5-commits-${fault === 'unknown-name' ? 'unknown' : randomUUID()}.json`,
    );
    if (fault === 'symlink')
      await fs.symlink(join(identity.source, 'empty'), evidencePath);
    else {
      await fs.writeFile(evidencePath, 'retained rows', { mode: 0o600 });
      if (fault === 'public') await fs.chmod(evidencePath, 0o644);
    }
    await expect(worker.readJournal(identity)).rejects.toThrow();
    expect(await fs.lstat(evidencePath)).toBeDefined();
  },
);

darwinTest.each(['private', 'saved', 'sibling'])(
  'restart handles interrupted re-cloned building staging (%s)',
  async (location) => {
    await expect(
      run({
        ...worker,
        exposeStaging: () => Promise.reject(new Error('before exposure')),
      }),
    ).rejects.toThrow('before exposure');
    const old = await journal();
    expect(old.phase).toBe('building');
    expect(old.stagingIdentity).toBeDefined();
    await expect(
      run({
        ...worker,
        build: (value) =>
          buildInternalRoot(value, async (source, staging) => {
            await fs.cp(source, staging, {
              recursive: true,
              preserveTimestamps: true,
            });
            throw new Error('interrupted re-clone');
          }),
      }),
    ).rejects.toThrow('interrupted re-clone');
    expect((await journal()).stagingIdentity).toBe(old.stagingIdentity);
    const savedJournal = await fs.readFile(
      join(identity.coordination, 'journal.json'),
    );
    const staging = join(identity.coordination, 'staging');
    expect(
      await migrationNodeIdentity(staging, await fs.lstat(staging)),
    ).not.toBe(old.stagingIdentity);
    const retained = join(
      identity.coordination,
      `restarted-${old.transactionId}`,
    );
    if (location === 'saved') {
      await createPrivateMigrationDirectory(retained, host);
      await fs.rename(staging, join(retained, 'staging'));
    } else if (location === 'sibling') {
      await fs.rename(staging, internalRootStaging(identity));
      await expect(
        preserveUnpublishedInternalRoot(await journal(), host, true),
      ).rejects.toMatchObject({ reason: 'source-changed' });
    }
    await fs.writeFile(join(identity.source, 'continued-work'), 'keep');
    const attempt = migrateInternalRoot(
      {
        ...worker,
        recoverW5: () => Promise.reject(new Error('fresh prepared reached')),
      },
      identity,
      { ...apply, restart: true },
      repairs,
    );
    if (location === 'sibling') {
      await expect(attempt).rejects.toMatchObject({
        reason: 'destination-exists',
      });
      expect((await journal()).transactionId).toBe(old.transactionId);
      expect(
        await fs.readFile(join(identity.coordination, 'journal.json')),
      ).toEqual(savedJournal);
      return;
    }
    await expect(attempt).rejects.toThrow('fresh prepared reached');
    expect(
      await fs.readFile(join(retained, 'staging', 'opaque data α')),
    ).toEqual(Buffer.from([0, 255, 3, 0]));
    expect(await fs.readFile(join(retained, 'journal.json'))).toEqual(
      savedJournal,
    );
    expect((await journal()).transactionId).not.toBe(old.transactionId);
  },
);

darwinTest(
  'uses source bytes rather than a clone margin on non-APFS volumes',
  async () => {
    const volume = await fs.statfs(home);
    jest.spyOn(fs, 'statfs').mockResolvedValue({ ...volume, type: 17 });
    await expect(
      worker.space(identity, 128 * 1024 * 1024),
    ).resolves.toMatchObject({
      requiredBytes: 128 * 1024 * 1024,
    });
  },
);

test('inventory reports required and available space even when space is short', async () => {
  const volume = await fs.statfs(home);
  jest.spyOn(fs, 'statfs').mockResolvedValue({ ...volume, bavail: 0 });
  const result = await migrateInternalRoot(
    worker,
    identity,
    { ...apply, apply: false },
    repairs,
  );
  expect(result).toMatchObject({
    kind: 'inventory',
    space: {
      requiredBytes: process.platform === 'darwin' ? 64 * 1024 * 1024 : 4,
      availableBytes: 0,
    },
    preflight: { kind: 'refused' },
  });
  if (result.kind !== 'inventory') throw new Error('Expected inventory');
  expect(result.preflight.blockers.join('\n')).toMatch(
    /required \d+ bytes, available 0 bytes/,
  );
  expect(await worker.readJournal(identity)).toBeNull();
});

test('allows exactly the required space', async () => {
  const volume = await fs.statfs(home);
  const required = process.platform === 'darwin' ? 64 * 1024 * 1024 : 4;
  jest
    .spyOn(fs, 'statfs')
    .mockResolvedValue({ ...volume, bsize: 1, bavail: required });
  await expect(run()).resolves.toMatchObject({ kind: 'complete' });
  await assertSource();
});

test('rechecks available space immediately before building', async () => {
  const volume = await fs.statfs(home);
  const query = jest.spyOn(fs, 'statfs').mockResolvedValue(volume);
  const build = jest.fn(worker.build.bind(worker));
  await expect(
    run({
      ...worker,
      recoverW5: () => {
        query.mockResolvedValue({ ...volume, bavail: 0 });
        return Promise.resolve();
      },
      build,
    }),
  ).rejects.toMatchObject({ reason: 'insufficient-space' });
  expect(build).not.toHaveBeenCalled();
  expect((await journal()).phase).toBe('source-settled');
  await assertSource();
});

test('uses the settled source size for the final space check', async () => {
  const space = jest.fn(worker.space.bind(worker));
  await expect(
    run({
      ...worker,
      space,
      recoverW5: () =>
        fs.writeFile(join(identity.source, 'settled'), 'settled bytes'),
    }),
  ).resolves.toMatchObject({ kind: 'complete' });
  expect(space).toHaveBeenNthCalledWith(1, identity, 4);
  expect(space).toHaveBeenLastCalledWith(
    identity,
    4 + Buffer.byteLength('settled bytes'),
  );
});

test('does not build when destination free space cannot be inspected', async () => {
  jest
    .spyOn(fs, 'statfs')
    .mockRejectedValue(
      Object.assign(new Error('space query denied'), { code: 'EACCES' }),
    );
  await expect(run()).rejects.toThrow('space query denied');
  expect(await worker.readJournal(identity)).toBeNull();
  await assertSource();
});

test('does not require another copy worth of space to resume publication', async () => {
  await expect(
    run({
      ...worker,
      publish: () => Promise.reject(new Error('before publish')),
    }),
  ).rejects.toThrow('before publish');
  const volume = await fs.statfs(home);
  jest.spyOn(fs, 'statfs').mockResolvedValue({ ...volume, bavail: 0 });
  await expect(run()).resolves.toMatchObject({ kind: 'complete' });
  await assertSource();
});

test('resumes a sealed publication without querying copy capacity again', async () => {
  await expect(
    run({
      ...worker,
      publish: () => Promise.reject(new Error('before publish')),
    }),
  ).rejects.toThrow('before publish');
  const space = jest.fn(() => Promise.reject(new Error('space query denied')));
  await expect(run({ ...worker, space })).resolves.toMatchObject({
    kind: 'complete',
  });
  expect(space).not.toHaveBeenCalled();
  await assertSource();
});

test.each([canopy, unstoppableCode])(
  'constructs and publishes the %s root without linking or removing the predecessor',
  async (brand) => {
    if (brand.id !== canopy.id) {
      await fs.rm(identity.source, { recursive: true });
      identity = internalRootIdentity(home, brand);
      await createPrivateMigrationDirectory(identity.source, host);
      await fs.writeFile(
        join(identity.source, 'opaque data α'),
        Buffer.from([0, 255, 3, 0]),
        { mode: 0o600 },
      );
      await fs.writeFile(join(identity.source, 'empty'), '', { mode: 0o600 });
    }
    const before = await worker.inventory(identity);
    expect((await run()).kind).toBe('complete');
    await assertSource();
    expect(await worker.inventory(identity)).toMatchObject({
      sourceIdentity: before.sourceIdentity,
      fingerprint: before.fingerprint,
    });
    expect(await worker.inventory(identity, true)).toMatchObject({
      fingerprint: before.fingerprint,
    });
    const from = await fs.lstat(join(identity.source, 'opaque data α'));
    const to = await fs.lstat(join(identity.destination, 'opaque data α'));
    expect(to.ino).not.toBe(from.ino);
    expect(to.nlink).toBe(1);
    expect(await journal()).toMatchObject({
      version: 7,
      phase: 'complete',
      secureRelocation: 'complete',
      publicationIdentity: await migrationNodeIdentity(
        identity.destination,
        await fs.lstat(identity.destination),
      ),
    });
    await expect(fs.lstat(internalRootStaging(identity))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect((await fs.readdir(home)).sort()).toEqual(
      [
        `.${brand.id}`,
        `.${brand.id}-internal`,
        `.${brand.id}-internal-migration`,
      ].sort(),
    );
  },
);

test('constructs an empty root without inventing application state', async () => {
  await fs.rm(join(identity.source, 'opaque data α'));
  await fs.rm(join(identity.source, 'empty'));
  expect((await run()).kind).toBe('complete');
  expect(await fs.readdir(identity.destination)).toEqual([]);
});

test('bounds large checkout evidence and preserves legacy plan sidecar fingerprints', async () => {
  await run();
  const saved = await journal();
  const status = ` D ${'x'.repeat(75)}\0`.repeat(30_000);
  const paths = Array.from({ length: 12 }, (_, index) =>
    join(home, `checkout-${index}`),
  );
  for (const path of paths)
    await fs.mkdir(join(path, '.git'), { recursive: true });
  let observedStatus = status;
  const probe = (cwd: string, args: readonly string[]): Promise<string> => {
    if (args[0] === 'status') return Promise.resolve(observedStatus);
    if (args[0] === 'rev-parse')
      return Promise.resolve(`${join(cwd, '.git')}\n`);
    return Promise.resolve(
      `worktree ${cwd}\0HEAD ${'0'.repeat(40)}\0branch refs/heads/main\0\0`,
    );
  };
  const gitPlan = await prepareRelocationGit(probe, paths);
  const transition = relocationTransition({
    version: 1,
    installationId: saved.transactionId,
    brandId: identity.brandId,
    from: { authorityId: 'a'.repeat(64), canonicalDataRoot: identity.source },
    to: {
      authorityId: 'b'.repeat(64),
      canonicalDataRoot: identity.destination,
    },
  });
  const frozen: InternalRootJournal = {
    ...saved,
    repairPlan: {
      transition,
      gitPlan,
      ownedPaths: [],
      workspaces: [],
      lifecycleJournals: [],
    },
  };
  await worker.saveJournal(frozen);
  expect(
    (await fs.stat(join(identity.coordination, 'journal.json'))).size,
  ).toBeLessThan(16 * 1024 * 1024);
  expect(await journal()).toEqual(frozen);
  await qualifyRelocationGit(probe, transition, gitPlan);
  observedStatus = status.replace('x', 'y');
  await expect(
    qualifyRelocationGit(probe, transition, gitPlan),
  ).rejects.toMatchObject({ reason: 'published-git-state-changed' });
  observedStatus = status;

  const legacy = {
    ...gitPlan,
    checkouts: gitPlan.checkouts.slice(0, 1).map((row) => ({ ...row, status })),
  };
  const legacyJournal = {
    ...frozen,
    repairPlan: {
      transition,
      gitPlan: legacy,
      ownedPaths: [],
      workspaces: [],
      lifecycleJournals: [],
    },
  };
  await worker.saveJournal(legacyJournal);
  const evidenceNames = (await fs.readdir(identity.coordination)).sort();
  const reopened = await journal();
  expect(reopened).toEqual(legacyJournal);
  await qualifyRelocationGit(probe, transition, legacy);
  await worker.saveJournal(reopened);
  expect((await fs.readdir(identity.coordination)).sort()).toEqual(
    evidenceNames,
  );
  expect(await journal()).toEqual(legacyJournal);
});

test.each([process.platform === 'win32' ? 'open' : 'write', 'sync', 'rename'])(
  'watchdog during external backlink %s cleans temp and rerun qualifies',
  async (stage) => {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'backlink-watchdog-')),
    );
    let pid: number | undefined;
    try {
      const from = join(root, 'source');
      const to = join(root, 'destination');
      const staging = join(root, 'staging');
      const common = join(from, 'repo');
      const external = join(root, 'external');
      await fs.mkdir(common, { recursive: true });
      await git(common, ['init']);
      await fs.writeFile(join(common, 'tracked'), 'base\n');
      await git(common, ['add', 'tracked']);
      await git(common, ['commit', '-m', 'fixture']);
      await git(common, ['worktree', 'add', '-b', 'external', external]);
      await fs.writeFile(join(external, 'dirty'), 'keep untracked');
      const unrelated = '..git.relocation-unrelated.tmp';
      await fs.writeFile(join(external, unrelated), 'not transaction owned');
      const transition = relocationTransition({
        version: 1,
        installationId: randomUUID(),
        brandId: 'canopy',
        from: { authorityId: 'a'.repeat(64), canonicalDataRoot: from },
        to: { authorityId: 'b'.repeat(64), canonicalDataRoot: to },
      });
      const plan = await prepareRelocationGit(git, [common, external]);
      const before = await fs.readFile(join(external, '.git'), 'utf8');
      if (process.platform !== 'win32')
        await fs.chmod(join(external, '.git'), 0o444);
      await fs.cp(from, staging, { recursive: true });
      const script = `
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const stage = process.argv[1];
      const external = process.argv[2];
      const matches = p => path.dirname(String(p)) === external && String(p).endsWith('.tmp');
      const stall = () => { require('node:fs').writeFileSync(path.join(external, '..', 'stalled'), stage); return new Promise(() => {}); };
      if (process.platform !== 'win32' && stage !== 'rename') {
        const callbacks = require('node:fs');
        const descriptors = new Set();
        const openSync = callbacks.openSync;
        callbacks.openSync = (p, ...args) => {
          const fd = openSync(p, ...args);
          if (matches(p)) descriptors.add(fd);
          return fd;
        };
        const method = stage === 'write' ? 'writeFile' : 'fsync';
        const original = callbacks[method];
        callbacks[method] = (...args) => {
          const callback = args.pop();
          original(...args, error => {
            if (error || !descriptors.has(args[0])) callback(error);
            else void stall();
          });
        };
      }
      const open = fs.open;
      fs.open = async (p, ...args) => {
        const handle = await open(p, ...args);
        if (matches(p)) {
          if (stage === 'open') await stall();
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { await sync(); if (stage === 'sync') await stall(); };
        }
        return handle;
      };
      const rename = fs.rename;
      fs.rename = async (from, to) => { await rename(from, to); if (matches(from) && stage === 'rename') await stall(); };
      const { repairRelocationGit } = require('./packages/core-runtime/src/node/relocation/git.ts');
      const { runInternalRootMigrationPhase } = require('./packages/desktop-shared/src/node/internal-root-migration/progress.ts');
      runInternalRootMigrationPhase('Repairing Git backlinks', () => repairRelocationGit(JSON.parse(process.argv[3]), JSON.parse(process.argv[4]), process.argv[5]), {heartbeatMs: 100, stallMs: 2_000}).catch(error => { console.error(error); process.exit(2); });
    `;
      const child = execute(
        process.execPath,
        [
          '--require',
          'tsx/cjs',
          '-e',
          script,
          stage,
          external,
          JSON.stringify(transition),
          JSON.stringify(plan),
          staging,
        ],
        { cwd: resolve('.'), timeout: 10_000 },
      );
      pid = child.child.pid;
      const failure: unknown = await child.catch((error: unknown) => error);
      const stalledReason: unknown = expect.stringContaining(
        '"reason":"migration-stalled"',
      );
      expect(failure).toMatchObject({
        code: 1,
        stderr: stalledReason,
      });
      expect(await fs.readFile(join(root, 'stalled'), 'utf8')).toBe(stage);
      expect(
        (await fs.readdir(external)).filter((name) =>
          name.includes('.relocation-'),
        ),
      ).toEqual([unrelated]);
      expect(await fs.readFile(join(external, unrelated), 'utf8')).toBe(
        'not transaction owned',
      );
      if (stage !== 'rename')
        expect(await fs.readFile(join(external, '.git'), 'utf8')).toBe(before);
      const exitListeners = process.listenerCount('exit');
      await repairRelocationGit(transition, plan, staging);
      expect(process.listenerCount('exit')).toBe(exitListeners);
      if (process.platform !== 'win32')
        expect((await fs.stat(join(external, '.git'))).mode & 0o777).toBe(
          0o444,
        );
      await fs.rename(staging, to);
      await qualifyRelocationGit(git, transition, plan);
    } finally {
      const terminateChild = (childPid: number): void => {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch (error) {
          if (
            !(
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'ESRCH'
            )
          )
            throw error;
        }
      };
      if (pid) terminateChild(pid);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  'before',
  'after',
  'journal',
  'first-journal',
  'space',
  'restart',
  'restart-first-journal',
  ...(process.platform === 'darwin' ? ['clone'] : []),
])('a stalled %s step refuses and a fresh run resumes', async (stage) => {
  const restarting = stage.startsWith('restart');
  if (restarting)
    await expect(
      run({
        ...worker,
        exposeStaging: () => Promise.reject(new Error('before exposure')),
      }),
    ).rejects.toThrow('before exposure');
  const script = `
      if (['first-journal', 'restart-first-journal'].includes(process.argv[2])) {
        const fs = require('node:fs/promises');
        const open = fs.open;
        fs.open = async (path, ...args) => {
          const handle = await open(path, ...args);
          if (String(path).includes('journal.json.')) {
            const writeFile = handle.writeFile.bind(handle);
            handle.writeFile = async bytes => {
              await writeFile(bytes.slice(0, 32));
              await new Promise(() => {});
            };
          }
          return handle;
        };
      }
      if (process.argv[2] === 'clone') {
        const cp = require('node:child_process');
        const spawn = cp.spawn;
        cp.spawn = (file, args, options) => {
          if (file !== '/bin/cp') return spawn(file, args, options);
          const fs = require('node:fs');
          fs.mkdirSync(args.at(-1), { mode: 0o700 });
          fs.writeFileSync(require('node:path').join(args.at(-1), 'partial'), 'unfinished');
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          require('node:fs').writeFileSync(process.argv[4], String(child.pid));
          return child;
        };
      }
      const { migrateInternalRoot } = require('./packages/core-runtime/src/node/internal-root-migration.ts');
      const { createInternalRootMigrationWorker } = require('./packages/desktop-shared/src/node/internal-root-migration/index.ts');
      const { monitorInternalRootMigrationWorker } = require('./packages/desktop-shared/src/node/internal-root-migration/progress.ts');
      void (async () => {
      const identity = JSON.parse(process.argv[1]);
      const worker = createInternalRootMigrationWorker({ recoverW5: async () => {}, proveCold: async () => {}, ownedChildPath: process.argv[3] || undefined });
      const repairs = {
        prepare: async () => ({ kind: 'ready', externalFiles: [] }),
        repair: async () => ({ kind: 'ok' }),
        verify: async () => ({ kind: 'ok' }),
        qualifyPublished: async () => ({ kind: 'ok' }),
      };
      const monitored = monitorInternalRootMigrationWorker({
        ...worker,
        space: async (...args) => {
          if (process.argv[2] === 'space') await new Promise(() => {});
          return worker.space(...args);
        },
        preserveUnpublished: async (...args) => {
          await worker.preserveUnpublished(...args);
          if (process.argv[2] === 'restart' && !args[1]) await new Promise(() => {});
        },
        publish: async journal => {
          if (process.argv[2] !== 'before') await worker.publish(journal);
          if (['before', 'after'].includes(process.argv[2])) await new Promise(() => {});
        },
        saveJournal: async journal => {
          if (process.argv[2] === 'journal' && journal.phase === 'complete') await new Promise(() => {});
          await worker.saveJournal(journal);
        },
      }, { heartbeatMs: 100, stallMs: 2_000 });
      await migrateInternalRoot(monitored, identity, { apply: true, declareInternal: true, restart: process.argv[2].startsWith('restart') }, repairs);
      })();
    `;
  const failure: unknown = await execute(
    process.execPath,
    [
      '--require',
      'tsx/cjs',
      '-e',
      script,
      JSON.stringify(identity),
      stage,
      ownedChildPath ?? '',
      join(home, 'clone.pid'),
    ],
    { timeout: 15_000 },
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 1 });
  if (typeof failure !== 'object' || failure === null || !('stderr' in failure))
    throw new Error('Expected subprocess diagnostics');
  expect(failure.stderr).toMatch(
    /Migration: [\s\S]*elapsed [\s\S]*"reason":"migration-stalled"[\s\S]*safe to re-run[\s\S]*resume/,
  );
  const phase = stage.endsWith('first-journal')
    ? 'prepared: saving journal'
    : stage === 'space'
      ? 'Checking destination space'
      : stage === 'restart'
        ? 'Preserving unpublished transaction'
        : stage === 'journal'
          ? 'complete: saving journal'
          : stage === 'clone'
            ? 'Building destination'
            : 'Publishing destination';
  expect(failure.stderr).toContain(`No progress in phase ${phase} for 2s.`);
  if (stage.endsWith('first-journal')) {
    expect(await worker.readJournal(identity)).toBeNull();
    expect(await fs.readdir(identity.coordination)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^journal\.json\..*\.tmp$/),
      ]),
    );
  } else if (stage === 'space' || stage === 'restart')
    expect(await worker.readJournal(identity)).toBeNull();
  else
    expect((await journal()).phase).toBe(
      stage === 'clone' ? 'building' : 'publishing',
    );
  if (stage === 'clone') {
    const pid = Number(await fs.readFile(join(home, 'clone.pid'), 'utf8'));
    let gone: unknown;
    try {
      process.kill(pid, 0);
    } catch (error) {
      gone = error;
    }
    expect(gone).toMatchObject({ code: 'ESRCH' });
  }
  expect((await run()).kind).toBe('complete');
  expect(await fs.readdir(identity.destination)).not.toContain('partial');
  await assertSource();
});

test('the uncomposed worker never admits apply', async () => {
  const installed = createInternalRootMigrationWorker({
    recoverW5: () => {
      throw new Error('must not recover');
    },
  });
  await expect(
    migrateInternalRoot(installed, identity, apply),
  ).rejects.toBeDefined();
  expect(await fs.readdir(home)).toEqual([`.${canopy.id}`]);
  await assertSource();
});

test.each([
  'exposure',
  'before-publication',
  'after-publication',
  'completion',
])(
  'resumes interruption at %s without repeating published repair',
  async (stage) => {
    let stopped = false;
    const fault: InternalRootMigrationWorker = {
      ...worker,
      exposeStaging: async (value) => {
        await worker.exposeStaging(value);
        if (stage === 'exposure' && !stopped) {
          stopped = true;
          throw new Error('interrupted');
        }
      },
      publish: async (value) => {
        if (stage === 'before-publication' && !stopped) {
          stopped = true;
          throw new Error('interrupted');
        }
        await worker.publish(value);
        if (stage === 'after-publication' && !stopped) {
          stopped = true;
          throw new Error('interrupted');
        }
      },
      saveJournal: async (value) => {
        if (value.phase === 'complete' && stage === 'completion' && !stopped) {
          stopped = true;
          throw new Error('interrupted');
        }
        await worker.saveJournal(value);
      },
    };
    await expect(run(fault)).rejects.toThrow('interrupted');
    expect((await journal()).phase).toBe(
      stage === 'exposure' ? 'building' : 'publishing',
    );
    const repair = jest.fn((value: InternalRootRepairContext) =>
      repairs.repair(value),
    );
    const qualifyPublished = jest.fn((value: InternalRootRepairContext) =>
      repairs.qualifyPublished(value),
    );
    expect(
      (await run(worker, { ...repairs, repair, qualifyPublished })).kind,
    ).toBe('complete');
    expect(repair).toHaveBeenCalledTimes(stage === 'exposure' ? 1 : 0);
    expect(qualifyPublished).toHaveBeenCalledTimes(1);
    await assertSource();
  },
);

copyTest(
  'journals private construction before copying and resumes a partial copy',
  async () => {
    let stopped = false;
    const originalCopy = fs.copyFile;
    const faultHost: InternalRootFilesystemHost = host.windows
      ? {
          windows: {
            ...host.windows,
            copy: (from, to) => {
              host.windows?.copy(from, to);
              if (!stopped) {
                stopped = true;
                throw new Error('copy interrupted');
              }
            },
          },
        }
      : host;
    if (linux)
      jest.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
        await originalCopy(...args);
        if (!stopped) {
          stopped = true;
          throw new Error('copy interrupted');
        }
      });
    await expect(
      run({
        ...worker,
        build: (value) => buildInternalRoot(value, undefined, faultHost),
      }),
    ).rejects.toThrow('copy interrupted');
    const prior = await journal();
    expect(prior.phase).toBe('building');
    const stat = await fs.lstat(join(identity.coordination, 'staging'));
    expect(prior.stagingIdentity).toBe(
      await migrationNodeIdentity(join(identity.coordination, 'staging'), stat),
    );
    jest.restoreAllMocks();
    expect((await run()).kind).toBe('complete');
    await assertSource();
  },
);

test.each([4, 5, 8, 999])(
  'refuses journal version %s without touching either root',
  async (version) => {
    await run();
    const path = join(identity.coordination, 'journal.json');
    await fs.writeFile(path, JSON.stringify({ ...(await journal()), version }));
    await expect(worker.readJournal(identity)).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
    await assertSource();
    expect(await fs.readFile(join(identity.destination, 'empty'), 'utf8')).toBe(
      '',
    );
  },
);

test('reads v6 secure-pending completion and upgrades it to v7 without republishing', async () => {
  await run();
  const completed = await journal();
  await worker.saveJournal({
    ...completed,
    version: 6,
    secureRelocation: 'pending',
  });
  expect(await journal()).toMatchObject({
    version: 6,
    phase: 'complete',
    secureRelocation: 'pending',
    publicationIdentity: completed.publicationIdentity,
  });
  const publish = jest.fn((...args: Parameters<typeof worker.publish>) =>
    worker.publish(...args),
  );
  expect(await run({ ...worker, publish })).toMatchObject({
    kind: 'complete',
    journal: {
      version: 7,
      phase: 'complete',
      secureRelocation: 'complete',
      publicationIdentity: completed.publicationIdentity,
    },
  });
  expect(publish).not.toHaveBeenCalled();
  expect(await journal()).toMatchObject({
    version: 7,
    secureRelocation: 'complete',
    publicationIdentity: completed.publicationIdentity,
  });
  await assertSource();
});

test.each([
  { version: 6, phase: 'complete' },
  { version: 6, phase: 'building' },
  { version: 7, phase: 'building' },
])(
  'refuses secure completion in journal v$version phase $phase without touching either root',
  async ({ version, phase }) => {
    await run();
    const completed = await journal();
    await fs.writeFile(
      join(identity.coordination, 'journal.json'),
      JSON.stringify({ ...completed, version, phase }),
    );
    await expect(worker.readJournal(identity)).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
    await assertSource();
    expect(await fs.readFile(join(identity.destination, 'empty'), 'utf8')).toBe(
      '',
    );
  },
);

test.each(['staging', 'destination'])(
  'refuses a replaced %s tree rather than discarding it',
  async (target) => {
    await expect(
      run({
        ...worker,
        publish: async (value) => {
          if (target === 'destination') await worker.publish(value);
          throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    const path =
      target === 'destination'
        ? identity.destination
        : internalRootStaging(identity);
    await fs.rename(path, join(home, 'retained-original'));
    await createPrivateMigrationDirectory(path, host);
    await fs.writeFile(join(path, 'independent'), 'retain', { mode: 0o600 });
    await expect(run()).rejects.toMatchObject({ reason: 'destination-exists' });
    expect(await fs.readFile(join(path, 'independent'), 'utf8')).toBe('retain');
    await assertSource();
  },
);

test('persists lossless high-sequence identities and refuses a rounded-alias staging replacement', async () => {
  await run();
  const staging = internalRootStaging(identity);
  await createPrivateMigrationDirectory(staging, host);
  const numeric = await fs.lstat(staging);
  const exact = await fs.lstat(staging, { bigint: true });
  const replaced = await fs.lstat(staging, { bigint: true });
  const first = 1n << 54n;
  const replacement = first + 1n;
  expect(Number(first)).toBe(Number(replacement));
  numeric.ino = Number(first);
  exact.ino = first;
  replaced.ino = replacement;
  const recorded: InternalRootJournal = {
    ...(await journal()),
    phase: 'building',
    secureRelocation: 'pending',
    stagingIdentity: `${exact.dev}:${first}`,
  };
  await worker.saveJournal(recorded);
  expect((await journal()).stagingIdentity).toBe(`${exact.dev}:${first}`);
  // Inject the NTFS sequence-number boundary even on a fresh native volume.
  jest.spyOn(platform, 'hostOperatingSystem').mockReturnValue('win32');
  const stats = jest.spyOn(fs, 'lstat');
  stats.mockResolvedValueOnce(exact);
  expect(await migrationNodeIdentity(staging, numeric)).toBe(
    `${exact.dev}:${first}`,
  );
  stats.mockResolvedValueOnce(replaced);
  expect(await migrationNodeIdentity(staging, numeric)).toBe(
    `${exact.dev}:${replacement}`,
  );
  stats.mockResolvedValueOnce(numeric);
  stats.mockResolvedValueOnce(replaced);
  await expect(
    validateInternalRootStaging(identity, recorded, host),
  ).rejects.toMatchObject({
    reason: 'destination-exists',
  });
});

test('classification and external journal validation use the same component membership', async () => {
  const internal = join(identity.source, 'empty');
  const outside = `${identity.source}-other`;
  await fs.writeFile(outside, 'gitdir: example\r\n', { mode: 0o600 });
  // Windows external metadata must itself inherit a private ACL, not the home ACL.
  if (windows) {
    await fs.rm(outside);
    await createPrivateMigrationDirectory(outside, host);
    await fs.writeFile(join(outside, 'gitdir'), 'gitdir: example\r\n');
  }
  const external = windows ? join(outside, 'gitdir') : outside;
  expect(isWithinInternalRoot(identity.source, internal)).toBe(
    isWithin(identity.source, internal),
  );
  expect(isWithinInternalRoot(identity.source, internal)).toBe(true);
  expect(isWithinInternalRoot(identity.source, external)).toBe(false);
  await expect(
    validateExternalRootFiles(identity, [internal], host),
  ).rejects.toMatchObject({ reason: 'unsupported-layout' });
  await expect(
    validateExternalRootFiles(identity, [external], host),
  ).resolves.toBeUndefined();
  await run();
  const completed = await journal();
  for (const path of [internal, external]) {
    await worker.saveJournal({
      ...completed,
      externalFiles: [path],
      externalSnapshots: [
        {
          path,
          mode: 0o600,
          preimage: '0'.repeat(64),
          postimage: '1'.repeat(64),
        },
      ],
    });
    if (path === internal)
      await expect(worker.readJournal(identity)).rejects.toMatchObject({
        reason: 'journal-unsupported',
      });
    else
      expect((await worker.readJournal(identity))?.externalFiles).toEqual([
        external,
      ]);
  }
});

posixTest(
  'copies symbolic link text and read-only file metadata without following or chmodding the source',
  async () => {
    await fs.chmod(join(identity.source, 'opaque data α'), 0o400);
    await fs.symlink('../outside-unread', join(identity.source, 'link'));
    await run();
    expect(await fs.readlink(join(identity.destination, 'link'))).toBe(
      '../outside-unread',
    );
    expect(
      (await fs.lstat(join(identity.source, 'opaque data α'))).mode & 0o777,
    ).toBe(0o400);
    expect(
      (await fs.lstat(join(identity.destination, 'opaque data α'))).mode &
        0o777,
    ).toBe(0o400);
  },
);

posixTest.each(['fresh', 'building-refusal', 'building-copy', 'rebuild'])(
  'preserves owner-read-only capability directories through %s migration',
  async (cut) => {
    const relative = join('codex-capabilities', 'v1', 'roots', 'readonly');
    const directory = join(identity.source, relative);
    const external = join(home, 'outside-capabilities');
    await fs.mkdir(external, { mode: 0o700 });
    await fs.writeFile(join(external, 'payload'), 'outside data');
    await fs.chmod(external, 0o500);
    const externalBefore = await fs.lstat(external);
    await fs.mkdir(join(directory, 'nested'), { recursive: true, mode: 0o700 });
    const copiedSibling = join(dirname(directory), '000-copied-before-refusal');
    await fs.writeFile(copiedSibling, 'copied sibling', { mode: 0o600 });
    await fs.writeFile(join(directory, 'nested', 'payload'), 'retain me', {
      mode: 0o400,
    });
    await fs.symlink(external, join(directory, 'external-link'));
    await fs.mkdir(join(directory, 'empty'), { mode: 0o500 });
    await fs.chmod(join(directory, 'nested'), 0o500);
    await fs.chmod(directory, 0o500);
    const before = await worker.inventory(identity);
    const children = ['', 'nested', 'empty'];
    const sourceBefore = await Promise.all(
      children.map(async (child) => ({
        child,
        stat: await fs.lstat(join(directory, child)),
      })),
    );
    const recoverW5 = jest.spyOn(worker, 'recoverW5');
    try {
      if (cut === 'building-refusal' || cut === 'building-copy') {
        await expect(
          run({
            ...worker,
            build: async (saved) => {
              if (cut === 'building-copy') await worker.build(saved);
              else if (linux) {
                const partial = join(
                  identity.coordination,
                  'staging',
                  'codex-capabilities',
                  'v1',
                  'roots',
                  '000-copied-before-refusal',
                );
                const report = progress.internalRootMigrationProgress;
                // Old guard's exact cut: sibling copied, 0500 entry inspected,
                // but its destination directory has not yet been created.
                const oldGuard = jest
                  .spyOn(progress, 'internalRootMigrationProgress')
                  .mockImplementation((message) => {
                    report(message);
                    if (
                      message === 'inspected copy source entry' &&
                      syncFs.existsSync(partial)
                    )
                      throw new InternalRootMigrationRefused(
                        'unsupported-layout',
                        'Read-only or inaccessible source directory',
                      );
                  });
                try {
                  await worker.build(saved);
                } finally {
                  oldGuard.mockRestore();
                }
                throw new Error('Expected the old Linux copy guard to refuse');
              } else {
                const staging = join(identity.coordination, 'staging');
                await createPrivateMigrationDirectory(staging, host);
                await worker.saveJournal({
                  ...saved,
                  stagingIdentity: await migrationNodeIdentity(
                    staging,
                    await fs.lstat(staging),
                  ),
                });
                await fs.writeFile(join(staging, 'partial'), 'partial copy');
              }
              throw new InternalRootMigrationRefused(
                'unsupported-layout',
                'Read-only or inaccessible source directory',
              );
            },
          }),
        ).rejects.toMatchObject({ reason: 'unsupported-layout' });
        expect(await journal()).toMatchObject({
          version: 7,
          phase: 'building',
          secureRelocation: 'pending',
        });
        await expect(fs.lstat(identity.destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        if (cut === 'building-refusal' && linux) {
          const staging = join(identity.coordination, 'staging');
          expect(
            await fs.readFile(
              join(
                staging,
                'codex-capabilities',
                'v1',
                'roots',
                '000-copied-before-refusal',
              ),
              'utf8',
            ),
          ).toBe('copied sibling');
          await expect(fs.lstat(join(staging, relative))).rejects.toMatchObject(
            {
              code: 'ENOENT',
            },
          );
        }
      }
      const transactionId = cut.startsWith('building')
        ? (await journal()).transactionId
        : null;
      expect(await run()).toMatchObject({
        kind: 'complete',
        journal: { phase: 'complete', secureRelocation: 'complete' },
      });
      if (transactionId)
        expect((await journal()).transactionId).toBe(transactionId);
      expect(recoverW5).toHaveBeenCalledTimes(1);
      if (cut === 'rebuild')
        expect(
          await migrateInternalRoot(
            worker,
            identity,
            { ...apply, rebuild: true },
            repairs,
          ),
        ).toMatchObject({ kind: 'complete' });
      for (const root of [identity.source, identity.destination]) {
        for (const child of children)
          expect(
            (await fs.lstat(join(root, relative, child))).mode & 0o777,
          ).toBe(0o500);
        expect(
          await fs.readFile(join(root, relative, 'nested', 'payload'), 'utf8'),
        ).toBe('retain me');
        expect(await fs.readdir(join(root, relative, 'empty'))).toEqual([]);
        expect(await fs.readlink(join(root, relative, 'external-link'))).toBe(
          external,
        );
      }
      expect(await fs.readFile(join(external, 'payload'), 'utf8')).toBe(
        'outside data',
      );
      expect((await worker.inventory(identity)).fingerprint).toBe(
        before.fingerprint,
      );
      expect(await fs.lstat(external)).toMatchObject({
        mode: externalBefore.mode,
        mtimeMs: externalBefore.mtimeMs,
        ctimeMs: externalBefore.ctimeMs,
      });
      for (const { child, stat } of sourceBefore) {
        expect(await fs.lstat(join(directory, child))).toMatchObject({
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        });
      }
      await assertSource();
    } finally {
      // Teardown only; migration must leave the source modes unchanged.
      for (const root of [
        identity.source,
        identity.destination,
        join(identity.coordination, 'staging'),
        join(identity.coordination, 'discarding'),
      ]) {
        for (const child of children)
          await fs.chmod(join(root, relative, child), 0o700).catch(() => {});
      }
      await fs.chmod(external, 0o700);
    }
  },
);

windowsTest(
  'refuses junctions and long paths without following them',
  async () => {
    const external = join(home, 'external');
    await createPrivateMigrationDirectory(external, host);
    await fs.writeFile(join(external, 'retain'), 'outside');
    const link = join(identity.source, 'junction');
    await fs.symlink(external, link, 'junction');
    await expect(worker.inventory(identity)).rejects.toBeDefined();
    await fs.rm(link);
    const long = join(identity.source, 'x'.repeat(235));
    await fs.mkdir(long);
    await expect(worker.inventory(identity)).rejects.toBeDefined();
    expect(await fs.readFile(join(external, 'retain'), 'utf8')).toBe('outside');
  },
);

windowsTest.each(['empty', join('nested', '.git')])(
  'preserves readonly %s on both roots and refuses active write holders without source changes',
  async (relative) => {
    const path = join(identity.source, relative);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, '');
    await fs.chmod(path, 0o400);
    try {
      const native = host.windows;
      if (!native) throw new Error('Missing Windows filesystem');
      const original = native.inspect(path);
      expect(original.attributes & 1).toBe(1);
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(native.inspect(path)).toEqual(original);
      expect(
        native.inspect(join(identity.destination, relative)).attributes,
      ).toBe(original.attributes);
      expect(await fs.readFile(path)).toEqual(
        await fs.readFile(join(identity.destination, relative)),
      );
    } finally {
      await fs.chmod(path, 0o600);
    }
    const held = await fs.open(path, 'r+');
    try {
      await expect(worker.inventory(identity)).rejects.toBeDefined();
    } finally {
      await held.close();
    }
    await assertSource();
  },
);

windowsTest.each(['mtime', 'size', 'security', 'identity'])(
  'readonly seal refuses a copy-flush receipt invalidated by %s',
  async (change) => {
    const file = join(identity.source, 'readonly');
    await fs.writeFile(file, 'immutable fixture');
    await fs.chmod(file, 0o400);
    const port: InternalRootRepairs = {
      ...repairs,
      repair: async (context) => {
        const target = join(context.workingRoot, 'readonly');
        if (change === 'mtime') await fs.utimes(target, 0, 1);
        if (change === 'size') {
          await fs.chmod(target, 0o600);
          await fs.writeFile(target, 'changed-size');
          await fs.chmod(target, 0o400);
        }
        if (change === 'security')
          await execute('icacls.exe', [target, '/grant', '*S-1-5-18:R']);
        if (change === 'identity') {
          await fs.rename(target, `${target}.retained`);
          await fs.copyFile(file, target);
          await fs.chmod(target, 0o400);
        }
        return { kind: 'ok' };
      },
    };
    await expect(run(worker, port)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect((await journal()).phase).toBe('building');
    expect(await fs.readFile(file, 'utf8')).toBe('immutable fixture');
    expect((host.windows?.inspect(file).attributes ?? 0) & 1).toBe(1);
    // A retry discards only journaled staging, mints new receipts and seals.
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
  },
);

windowsTest(
  'fresh process refuses readonly sealing without receipts, retries by rebuilding, and resumes an already durable publication seal',
  async () => {
    const file = join(identity.source, 'readonly');
    await fs.writeFile(file, 'retained source');
    await fs.chmod(file, 0o400);
    const seal = worker.seal.bind(worker);
    worker.seal = (): ReturnType<InternalRootMigrationWorker['seal']> =>
      Promise.reject(new Error('before seal interruption'));
    await expect(run()).rejects.toThrow('before seal interruption');
    const current = await journal();
    const script = `
    const fs = require('node:fs');
    const { createWindowsMigrationFilesystem } = require(${JSON.stringify(resolve('packages/core-platform/src/internal-migration-filesystem.ts'))});
    const { sealInternalRoot } = require(${JSON.stringify(resolve('packages/desktop-shared/src/node/internal-root-migration/filesystem.ts'))});
    const journal = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    sealInternalRoot(journal, journal.stagingIdentity, { windows: createWindowsMigrationFilesystem(process.argv[2]) }).then(
      () => { console.error('unexpected readonly seal'); process.exitCode = 3; },
      error => { if (error.reason !== 'recovery-required' || !error.message.includes('copy-flush receipt')) { console.error(error); process.exitCode = 4; } else console.log(error.reason); }
    );
  `;
    const result = await execute(process.execPath, [
      '--require',
      'tsx/cjs',
      '-e',
      script,
      join(identity.coordination, 'journal.json'),
      ownedChildPath ?? '',
    ]);
    expect(result.stdout.trim()).toBe('recovery-required');
    expect((await journal()).stagingIdentity).toBe(current.stagingIdentity);
    worker.seal = seal;
    const publish = worker.publish.bind(worker);
    worker.publish = async (value): Promise<void> => {
      await publish(value);
      throw new Error('after durable seal interruption');
    };
    await expect(run()).rejects.toThrow('after durable seal interruption');
    expect((await journal()).phase).toBe('publishing');
    const restarted = createInternalRootMigrationWorker({
      ownedChildPath,
      recoverW5: () => Promise.resolve(),
      proveCold: () => Promise.resolve(),
    });
    restarted.seal = (): ReturnType<InternalRootMigrationWorker['seal']> =>
      Promise.reject(new Error('must reuse durable seal'));
    await expect(run(restarted)).resolves.toMatchObject({ kind: 'complete' });
    expect((host.windows?.inspect(file).attributes ?? 0) & 1).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe('retained source');
  },
);

windowsTest.each(['replaced-root', 'junction'])(
  'recorded readonly cleanup refuses %s without clearing source or external attributes',
  async (change) => {
    const native = host.windows;
    if (!native) throw new Error('Missing Windows filesystem');
    const staging = join(home, 'recorded-construction');
    await createPrivateMigrationDirectory(staging, host);
    const recorded = await migrationNodeIdentity(
      staging,
      await fs.lstat(staging),
    );
    const source = join(identity.source, 'readonly');
    await fs.writeFile(source, 'source');
    await fs.chmod(source, 0o400);
    if (change === 'replaced-root') {
      await fs.rename(staging, `${staging}.retained`);
      await createPrivateMigrationDirectory(staging, host);
      native.copy(source, join(staging, 'readonly'));
    } else {
      await fs.symlink(identity.source, join(staging, 'junction'), 'junction');
    }
    expect(() => native.removeRecordedTree(staging, recorded)).toThrow(
      change === 'replaced-root'
        ? 'remove-recorded-identity'
        : 'attributes-or-case',
    );
    expect(native.inspect(source).attributes & 1).toBe(1);
    expect(await fs.readFile(source, 'utf8')).toBe('source');
    if (change === 'replaced-root')
      expect(native.inspect(join(staging, 'readonly')).attributes & 1).toBe(1);
  },
);

windowsTest.each(
  ['file', 'directory', 'root directory'].flatMap((kind) =>
    [false, true].map((existingJournal) => ({ kind, existingJournal })),
  ),
)(
  'refuses named data streams on a $kind before construction (existing journal: $existingJournal)',
  async ({ kind, existingJournal }) => {
    const path =
      kind === 'root directory'
        ? identity.source
        : join(identity.source, kind === 'file' ? 'empty' : 'stream-directory');
    if (kind === 'directory') await createPrivateMigrationDirectory(path, host);
    if (existingJournal)
      await expect(
        run({
          ...worker,
          build: () => Promise.reject(new Error('before construction')),
        }),
      ).rejects.toThrow('before construction');
    const journalPath = join(identity.coordination, 'journal.json');
    const savedJournal = existingJournal
      ? await fs.readFile(journalPath)
      : null;
    const stream = `${path}:ads`;
    await fs.writeFile(stream, 'retain stream');
    const before = await fs.lstat(path, { bigint: true });
    const homeBefore = (await fs.readdir(home)).sort();
    const sourceBefore = (await fs.readdir(identity.source)).sort();
    const build = jest.fn((journal: InternalRootJournal) =>
      worker.build(journal),
    );
    const stage = kind === 'file' ? 'file-streams' : 'directory-streams';
    const inventory = worker.inventory(identity);
    await expect(inventory).rejects.toBeInstanceOf(
      InternalRootMigrationRefused,
    );
    await expect(inventory).rejects.toMatchObject({
      reason: 'unsupported-layout',
    });
    await expect(inventory).rejects.toHaveProperty(
      'recovery',
      expect.stringContaining(stage),
    );
    const migration = run({ ...worker, build });
    await expect(migration).rejects.toMatchObject({
      reason: 'unsupported-layout',
    });
    await expect(migration).rejects.toHaveProperty(
      'recovery',
      expect.stringContaining(stage),
    );
    expect(build).not.toHaveBeenCalled();
    expect(await fs.readFile(stream, 'utf8')).toBe('retain stream');
    expect(await fs.lstat(path, { bigint: true })).toMatchObject({
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
    expect((await fs.readdir(home)).sort()).toEqual(homeBefore);
    expect((await fs.readdir(identity.source)).sort()).toEqual(sourceBefore);
    await assertSource();
    if (savedJournal)
      expect(await fs.readFile(journalPath)).toEqual(savedJournal);
    else
      await expect(fs.lstat(journalPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    for (const absent of [
      identity.destination,
      internalRootStaging(identity),
      join(identity.coordination, 'staging'),
    ])
      await expect(fs.lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

windowsTest(
  'refuses foreign ACL grants and proves new coordination privacy through the platform verifier',
  async () => {
    const release = await worker.coordinate(identity);
    await release();
    const { createPlatformEndpointServices, hostPlatformServices } =
      await import('@canopy/core-platform');
    expect(
      (
        await hostPlatformServices(
          createPlatformEndpointServices('win32'),
        ).secureFiles.permissions({
          path: identity.coordination,
          kind: 'directory',
          mode: 'owner-only',
          action: 'verify',
        })
      ).state,
    ).toBe('private');
    const file = join(identity.source, 'empty');
    await execute('icacls.exe', [file, '/grant', '*S-1-1-0:R']);
    try {
      await expect(worker.inventory(identity)).rejects.toBeDefined();
    } finally {
      await execute('icacls.exe', [file, '/remove:g', '*S-1-1-0']);
    }
  },
);

windowsTest(
  'publishes a private hidden/readonly backlink copy without changing the preimage attributes',
  async () => {
    const native = host.windows;
    if (!native) throw new Error('Missing Windows filesystem host');
    const path = join(identity.source, '.git-backlink');
    const temp = join(identity.source, '.replacement');
    await fs.writeFile(path, 'long preimage\n', { mode: 0o600 });
    await execute('attrib.exe', ['+R', '+H', path]);
    const before = native.inspect(path);
    native.copy(path, temp);
    await fs.chmod(temp, 0o600);
    const file = await fs.open(temp, 'r+');
    try {
      await file.writeFile('new\n');
      await file.truncate(4);
      await file.sync();
    } finally {
      await file.close();
    }
    native.finish(path, temp);
    expect(native.inspect(path)).toEqual(before);
    expect(native.hasReadonlyCopyFlush(temp)).toBe(true);
    native.replace(temp, path);
    const after = native.inspect(path);
    expect(after.attributes).toBe(before.attributes);
    expect(after.security).toBe(before.security);
    expect(after.ino).not.toBe(before.ino);
    expect(native.hasReadonlyCopyFlush(path)).toBe(true);
    expect(native.read(path).toString('utf8')).toBe('new\n');
    await expect(fs.lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

windowsTest(
  'uses Git slash spelling and preserves cross-drive relative-target semantics',
  () => {
    const text = gitBacklinkText(
      'C:\\Users\\owner\\.brand-internal\\checkout',
      'D:\\repositories\\common.git',
      false,
    );
    expect(text).toBe('D:/repositories/common.git');
    expect(
      win32.resolve('C:\\Users\\owner\\.brand-internal\\checkout', text),
    ).toBe('D:\\repositories\\common.git');
    expect(
      isWithinInternalRoot(
        'C:\\Users\\Owner\\.brand',
        'c:/users/owner/.brand/checkout/.git',
      ),
    ).toBe(true);
    expect(
      isWithinInternalRoot(
        'C:\\Users\\Owner\\.brand',
        'C:\\Users\\Owner\\.brand-other',
      ),
    ).toBe(false);
  },
);

test('moves real linked Git checkouts using final identities and restores exact external preimages on rebuild', async () => {
  const common = join(home, 'external repository α');
  await createPrivateMigrationDirectory(common, host);
  await git(common, ['init']);
  if (windows) await git(common, ['config', 'core.autocrlf', 'true']);
  await fs.writeFile(join(common, 'tracked'), 'base\n');
  await git(common, ['add', 'tracked']);
  await git(common, ['commit', '-m', 'fixture']);
  const managed = join(identity.source, 'managed checkout');
  await git(common, ['worktree', 'add', '-b', 'managed', managed]);
  const secondManaged = join(identity.source, 'managed second');
  await git(common, ['worktree', 'add', '-b', 'second', secondManaged]);
  if (windows) {
    const native = host.windows;
    if (!native) throw new Error('Missing Windows filesystem host');
    for (const checkout of [managed, secondManaged]) {
      // Git's hidden bit is not FILE_ATTRIBUTE_READONLY; do not chmod it away.
      const { attributes } = native.inspect(join(checkout, '.git'));
      expect(attributes & 1).toBe(0);
      expect(attributes & 2).toBe(2);
    }
    await expect(worker.inventory(identity)).resolves.toBeDefined();
  }
  await fs.writeFile(join(managed, 'tracked'), 'dirty\n');
  await fs.writeFile(join(managed, 'untracked α'), 'untracked\n');
  const transition = relocationTransition({
    version: 1,
    installationId: randomUUID(),
    brandId: identity.brandId,
    from: { authorityId: 'a'.repeat(64), canonicalDataRoot: identity.source },
    to: {
      authorityId: 'b'.repeat(64),
      canonicalDataRoot: identity.destination,
    },
  });
  const plan = await prepareRelocationGit(
    git,
    [common, managed, secondManaged],
    { portableFilesystem: process.platform !== 'darwin' },
  );
  // CRLF/absolute and relative backlink images remain exact recovery preimages.
  for (const image of plan.backlinks) {
    const value = await fs.readFile(image.path, 'utf8');
    const file = await fs.open(image.path, 'r+');
    try {
      const bytes = Buffer.from(value.replace(/\r?\n$/, '\r\n'));
      await file.writeFile(bytes);
      await file.truncate(bytes.length);
    } finally {
      await file.close();
    }
  }
  let frozen: RelocationGitPlan = await prepareRelocationGit(
    git,
    [common, managed, secondManaged],
    { portableFilesystem: process.platform !== 'darwin' },
  );
  const externalFiles = frozen.backlinks
    .map((row) => row.path)
    .filter((path) => !isWithinInternalRoot(identity.source, path));
  const preimages = await Promise.all(
    externalFiles.map((path) => fs.readFile(path)),
  );
  const native = host.windows;
  const externalMetadata = native
    ? externalFiles.map((path) => {
        const { attributes, security } = native.inspect(path);
        return { attributes, security };
      })
    : [];
  const port: InternalRootRepairs = {
    prepare: async (context) => {
      frozen = await prepareRelocationGit(
        git,
        [common, managed, secondManaged],
        { portableFilesystem: process.platform !== 'darwin' },
      );
      const unexpected = (): Promise<never> =>
        Promise.reject(new Error('Preparation must be read only'));
      const prepared = await createInternalRootRepairs({
        freeze: () =>
          Promise.resolve({
            transition: {
              ...transition,
              installationId: context.transactionId,
            },
            gitPlan: frozen,
            ownedPaths: [],
            workspaces: [],
          }),
        admit: unexpected,
        recordAuthority: unexpected,
        repairMetadata: unexpected,
        verify: unexpected,
      }).prepare(context);
      expect(prepared).toMatchObject({ kind: 'ready', externalFiles });
      return prepared;
    },
    repair: async (context) => {
      await repairRelocationGit(transition, frozen, context.workingRoot);
      return { kind: 'ok' };
    },
    verify: async (context) => {
      await repairRelocationGit(transition, frozen, context.workingRoot);
      return { kind: 'ok' };
    },
    qualifyPublished: async () => {
      const actual = await prepareRelocationGit(
        git,
        [
          common,
          movedOwnedPath(transition, managed),
          movedOwnedPath(transition, secondManaged),
        ],
        { portableFilesystem: process.platform !== 'darwin' },
      );
      expect(
        actual.checkouts.map(({ head, branch, status }) => ({
          head,
          branch,
          status,
        })),
      ).toEqual(
        frozen.checkouts.map(({ head, branch, status }) => ({
          head,
          branch,
          status,
        })),
      );
      for (const image of actual.backlinks)
        expect(image.contents).not.toContain('.migration-staging');
      if (windows && host.windows)
        for (const checkout of actual.checkouts.filter(
          (row) => row.path !== common,
        ))
          expect(
            host.windows.inspect(join(checkout.path, '.git')).attributes & 2,
          ).toBe(2);
      return { kind: 'ok' };
    },
  };
  expect((await run(worker, port)).kind).toBe('complete');
  await assertSource();
  if (native)
    expect(
      externalFiles.map((path) => {
        const { attributes, security } = native.inspect(path);
        return { attributes, security };
      }),
    ).toEqual(externalMetadata);
  const postimages = await Promise.all(
    externalFiles.map((path) => fs.readFile(path)),
  );
  const changed = externalFiles
    .map((_, index) => index)
    .filter(
      (index) =>
        !preimages[index]?.equals(postimages[index] ?? Buffer.alloc(0)),
    );
  const first = changed[0];
  const second = changed[1];
  if (first === undefined || second === undefined)
    throw new Error('Expected two changed external backlinks');
  const firstPath = externalFiles[first];
  const firstPreimage = preimages[first];
  if (!firstPath || !firstPreimage)
    throw new Error('Missing external preimage');
  const fault: InternalRootMigrationWorker = {
    ...worker,
    restoreExternal: async () => {
      const file = await fs.open(firstPath, 'r+');
      try {
        await file.writeFile(firstPreimage);
        await file.truncate(firstPreimage.length);
      } finally {
        await file.close();
      }
      throw new Error('restore interrupted');
    },
  };
  await expect(
    migrateInternalRoot(fault, identity, { ...apply, rebuild: true }, port),
  ).rejects.toThrow('restore interrupted');
  expect(await fs.readFile(firstPath)).toEqual(firstPreimage);
  const secondPath = externalFiles[second];
  if (!secondPath) throw new Error('Missing second backlink');
  expect(await fs.readFile(secondPath)).toEqual(postimages[second]);
  expect((await journal()).phase).toBe('restoring-external');
  expect(
    (
      await migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        port,
      )
    ).kind,
  ).toBe('complete');
});

test('copies source hardlinks independently without changing either source link', async () => {
  const directory = join(
    identity.source,
    'workspaces/fixture/worktrees/feature/node_modules/esbuild/bin',
  );
  await fs.mkdir(directory, { recursive: true });
  const original = join(directory, 'esbuild');
  const alias = join(directory, 'alias');
  const bytes = Buffer.from([0, 127, 255]);
  await fs.writeFile(original, bytes, { mode: 0o755 });
  await fs.link(original, alias);
  const before = await fs.lstat(original, { bigint: true });
  await expect(
    migrateInternalRoot(
      worker,
      identity,
      { apply: false, declareInternal: false },
      repairs,
    ),
  ).resolves.toMatchObject({ kind: 'inventory' });
  await expect(run()).resolves.toMatchObject({ kind: 'complete' });
  const copy = join(
    identity.destination,
    'workspaces/fixture/worktrees/feature/node_modules/esbuild/bin/esbuild',
  );
  const copiedAlias = join(dirname(copy), 'alias');
  const first = await fs.lstat(copy, { bigint: true });
  const second = await fs.lstat(copiedAlias, { bigint: true });
  expect(first.ino).not.toBe(before.ino);
  expect(second.ino).not.toBe(first.ino);
  expect(first.nlink).toBe(1n);
  expect(second.nlink).toBe(1n);
  expect(await fs.readFile(copy)).toEqual(bytes);
  await fs.writeFile(copy, 'destination-only');
  expect(await fs.readFile(copiedAlias)).toEqual(bytes);
  for (const path of [original, alias]) {
    expect(await fs.readFile(path)).toEqual(bytes);
    const after = await fs.lstat(path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(2n);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).toBe(before.ctimeNs);
  }
});

copyTest(
  'refuses unknown and replaced private construction roots',
  async () => {
    await expect(
      run({
        ...worker,
        build: async () => {
          await createPrivateMigrationDirectory(
            join(identity.coordination, 'staging'),
            host,
          );
          throw new Error('before construction identity');
        },
      }),
    ).rejects.toThrow('before construction identity');
    const privateRoot = join(identity.coordination, 'staging');
    await fs.writeFile(join(privateRoot, 'independent'), 'retain', {
      mode: 0o600,
    });
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await fs.readFile(join(privateRoot, 'independent'), 'utf8')).toBe(
      'retain',
    );
    const value = await journal();
    const stat = await fs.lstat(privateRoot);
    await worker.saveJournal({
      ...value,
      stagingIdentity: await migrationNodeIdentity(privateRoot, stat),
    });
    await fs.rename(privateRoot, join(identity.coordination, 'retained'));
    await createPrivateMigrationDirectory(privateRoot, host);
    await fs.writeFile(join(privateRoot, 'replacement'), 'retain', {
      mode: 0o600,
    });
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await fs.readFile(join(privateRoot, 'replacement'), 'utf8')).toBe(
      'retain',
    );
  },
);

test.each([
  'core.worktree',
  'extensions.worktreeConfig',
  'submodules',
  'alternates',
  'separate-git-dir',
])(
  'portable preparation explicitly refuses unsupported %s layout',
  async (layout) => {
    const checkout = join(home, 'layout');
    await createPrivateMigrationDirectory(checkout, host);
    if (layout === 'separate-git-dir')
      await git(checkout, [
        'init',
        '--separate-git-dir',
        join(home, 'separate'),
      ]);
    else await git(checkout, ['init']);
    await fs.writeFile(join(checkout, 'tracked'), 'base');
    await git(checkout, ['add', 'tracked']);
    await git(checkout, ['commit', '-m', 'fixture']);
    if (layout === 'core.worktree')
      await git(checkout, ['config', 'core.worktree', checkout]);
    if (layout === 'extensions.worktreeConfig')
      await git(checkout, ['config', 'extensions.worktreeConfig', 'true']);
    if (layout === 'submodules')
      await fs.writeFile(join(checkout, '.gitmodules'), '');
    if (layout === 'alternates')
      await fs.writeFile(
        join(checkout, '.git', 'objects', 'info', 'alternates'),
        join(checkout, '.git', 'objects') + '\n',
      );
    await expect(
      prepareRelocationGit(git, [checkout], { portableFilesystem: true }),
    ).rejects.toMatchObject({ name: 'RelocationRefusedError' });
  },
);

darwinTest(
  'retains Darwin refusal of noncanonical Git listing evidence',
  async () => {
    const checkout = join(home, 'repository');
    await fs.mkdir(checkout);
    await git(checkout, ['init']);
    await fs.writeFile(join(checkout, 'tracked'), 'base');
    await git(checkout, ['add', 'tracked']);
    await git(checkout, ['commit', '-m', 'fixture']);
    const aliasListing = async (
      cwd: string,
      args: readonly string[],
    ): Promise<string> => {
      const result = await git(cwd, args);
      return args[0] === 'worktree'
        ? result.replace(
            `worktree ${checkout}\0`,
            `worktree ${home}/./repository\0`,
          )
        : result;
    };
    await expect(
      prepareRelocationGit(aliasListing, [checkout]),
    ).rejects.toMatchObject({
      reason: 'unreadable-git-checkout',
    });
  },
);

windowsTest(
  'refuses drive-relative, rooted-only and device-namespace Git backlink evidence',
  async () => {
    const staging = internalRootStaging(identity);
    await createPrivateMigrationDirectory(staging, host);
    const transition = relocationTransition({
      version: 1,
      installationId: randomUUID(),
      brandId: identity.brandId,
      from: { authorityId: 'a'.repeat(64), canonicalDataRoot: identity.source },
      to: {
        authorityId: 'b'.repeat(64),
        canonicalDataRoot: identity.destination,
      },
    });
    for (const text of ['C:relative', '\\rooted', '\\\\?\\C:\\device']) {
      await expect(
        repairRelocationGit(
          transition,
          {
            checkouts: [],
            backlinks: [
              {
                path: join(identity.source, 'gitdir'),
                contents: text + '\r\n',
              },
            ],
          },
          staging,
        ),
      ).rejects.toMatchObject({ reason: 'noncanonical-git-backlink' });
    }
  },
);

linuxSecondGroupTest(
  'preserves root/child/symlink GIDs and child special modes without following links (requires Linux with a second group)',
  async () => {
    if (supplementaryGroup === undefined) return;
    const external = join(home, 'external');
    await fs.writeFile(external, 'unchanged', { mode: 0o600 });
    const externalBefore = await fs.lstat(external);
    const link = join(identity.source, 'link');
    await fs.symlink(external, link);
    const directory = join(identity.source, 'setgid');
    await fs.mkdir(directory, { mode: 0o700 });
    expect((await fs.lstat(home)).gid).not.toBe(supplementaryGroup);
    const names = ['', 'setgid', 'opaque data α', 'empty', 'link'];
    for (const name of names)
      await fs.lchown(join(identity.source, name), -1, supplementaryGroup);
    await fs.chmod(identity.source, 0o700);
    await fs.chmod(directory, 0o2700);
    await fs.chmod(join(identity.source, 'opaque data α'), 0o6700);
    expect((await fs.lstat(identity.source)).mode & 0o7777).toBe(0o700);
    expect((await fs.lstat(directory)).mode & 0o7777).toBe(0o2700);
    expect(
      (await fs.lstat(join(identity.source, 'opaque data α'))).mode & 0o7777,
    ).toBe(0o6700);
    const before = await worker.inventory(identity);
    expect((await run()).kind).toBe('complete');
    for (const name of names) {
      const from = await fs.lstat(join(identity.source, name));
      const to = await fs.lstat(join(identity.destination, name));
      expect(to).toMatchObject({
        uid: from.uid,
        gid: supplementaryGroup,
        mode: from.mode,
      });
    }
    for (const [name, mode] of [
      ['', 0o700],
      ['setgid', 0o2700],
      ['opaque data α', 0o6700],
    ] satisfies [string, number][])
      expect(
        (await fs.lstat(join(identity.destination, name))).mode & 0o7777,
      ).toBe(mode);
    expect(await fs.readlink(join(identity.destination, 'link'))).toBe(
      external,
    );
    expect(await fs.lstat(external)).toMatchObject({
      gid: externalBefore.gid,
      uid: externalBefore.uid,
      ctimeMs: externalBefore.ctimeMs,
    });
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    expect((await worker.inventory(identity, true)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
  },
);

linuxSecondGroupTest(
  'preserves setgid inheritance different from staging (requires Linux with a second group)',
  async () => {
    if (supplementaryGroup === undefined) return;
    const directory = join(identity.source, 'setgid');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.chown(directory, -1, supplementaryGroup);
    await fs.chmod(directory, 0o2700);
    await fs.writeFile(join(directory, 'child'), '', { mode: 0o600 });
    const defaultGroup = (await fs.lstat(home)).gid;
    expect(defaultGroup).not.toBe(supplementaryGroup);
    expect((await fs.lstat(join(directory, 'child'))).gid).toBe(
      supplementaryGroup,
    );
    const before = await worker.inventory(identity);
    expect((await run()).kind).toBe('complete');
    expect(await fs.lstat(join(identity.destination, 'setgid'))).toMatchObject({
      gid: supplementaryGroup,
      mode: (await fs.lstat(directory)).mode,
    });
    expect(
      (await fs.lstat(join(identity.destination, 'setgid'))).mode & 0o7777,
    ).toBe(0o2700);
    expect(
      (await fs.lstat(join(identity.destination, 'setgid', 'child'))).gid,
    ).toBe(supplementaryGroup);
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    expect((await worker.inventory(identity, true)).fingerprint).toBe(
      before.fingerprint,
    );
  },
);

linuxSecondGroupTest.each([false, true])(
  'refuses lost membership before construction (existing journal: %s; requires Linux with a second group)',
  async (existingJournal) => {
    if (supplementaryGroup === undefined) return;
    // A non-root fixture cannot assign a foreign GID; simulate membership revocation.
    if (process.geteuid?.() === 0)
      throw new Error('Run Linux group qualification as a non-root user');
    await fs.chown(join(identity.source, 'empty'), -1, supplementaryGroup);
    const before = await worker.inventory(identity);
    const build = jest.fn(() =>
      Promise.reject(new Error('before construction')),
    );
    if (existingJournal)
      await expect(run({ ...worker, build })).rejects.toThrow(
        'before construction',
      );
    const journalPath = join(identity.coordination, 'journal.json');
    const savedJournal = existingJournal
      ? await fs.readFile(journalPath)
      : null;
    const homeBefore = (await fs.readdir(home)).sort();
    build.mockClear();
    jest
      .spyOn(process, 'getgroups')
      .mockReturnValue(linuxGroups.filter((gid) => gid !== supplementaryGroup));
    for (const apply of [false, true])
      await expect(
        migrateInternalRoot(
          { ...worker, build },
          identity,
          { apply, declareInternal: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(build).not.toHaveBeenCalled();
    expect((await fs.readdir(home)).sort()).toEqual(homeBefore);
    if (savedJournal)
      expect(await fs.readFile(journalPath)).toEqual(savedJournal);
    await expect(fs.lstat(identity.destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.lstat(join(identity.coordination, 'staging')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    jest.restoreAllMocks();
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
  },
);

linuxTest(
  'admits the effective GID even when it is absent from supplementary groups',
  async () => {
    const effectiveGroup = process.getegid?.();
    if (effectiveGroup === undefined) throw new Error('Effective GID required');
    await fs.symlink('empty', join(identity.source, 'link'));
    for (const name of ['', 'opaque data α', 'empty', 'link'])
      await fs.lchown(join(identity.source, name), -1, effectiveGroup);
    const before = await worker.inventory(identity);
    jest.spyOn(process, 'getgroups').mockReturnValue([]);
    expect((await run()).kind).toBe('complete');
    for (const name of ['', 'opaque data α', 'empty', 'link'])
      expect((await fs.lstat(join(identity.destination, name))).gid).toBe(
        effectiveGroup,
      );
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    expect((await worker.inventory(identity, true)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
  },
);

linuxTest.each(['directory', 'nested directory', 'file', 'symlink'])(
  'retains recoverable construction on %s group assignment EPERM',
  async (kind) => {
    await fs.symlink('empty', join(identity.source, 'link'));
    if (kind === 'nested directory') {
      await fs.mkdir(join(identity.source, 'nested'), { mode: 0o700 });
      await fs.writeFile(join(identity.source, 'nested', 'child'), 'retain');
    }
    const before = await worker.inventory(identity);
    const denied = Object.assign(new Error('group assignment denied'), {
      code: 'EPERM',
    });
    const assign = jest.fn(() => Promise.reject(denied));
    if (kind === 'symlink') jest.spyOn(fs, 'lchown').mockImplementation(assign);
    else {
      const original = fs.open;
      jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await original(...args);
        const stat = await handle.stat();
        if (
          kind === 'directory' || kind === 'nested directory'
            ? stat.isDirectory()
            : stat.isFile()
        )
          jest.spyOn(handle, 'chown').mockImplementation(assign);
        return handle;
      });
    }
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    if (kind === 'symlink')
      expect(assign).toHaveBeenCalledWith(
        expect.stringContaining('/proc/self/fd/'),
        -1,
        expect.any(Number),
      );
    else expect(assign).toHaveBeenCalledWith(-1, expect.any(Number));
    const pending = await journal();
    expect(pending.phase).toBe('building');
    const staging = join(identity.coordination, 'staging');
    expect(await migrationNodeIdentity(staging, await fs.lstat(staging))).toBe(
      pending.stagingIdentity,
    );
    await expect(fs.lstat(identity.destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    jest.restoreAllMocks();
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
    expect((await run()).kind).toBe('complete');
  },
);

linuxTest.each(['exposure', 'publication'])(
  'refuses Linux %s without the native addon, preserving both trees and the journal',
  async (stage) => {
    const stop = (): Promise<void> =>
      Promise.reject(new Error('before-directory-move'));
    await expect(
      run({
        ...worker,
        exposeStaging: (value) =>
          stage === 'exposure' ? stop() : worker.exposeStaging(value),
        publish: (value) =>
          stage === 'publication' ? stop() : worker.publish(value),
      }),
    ).rejects.toThrow('before-directory-move');
    const pending = await journal();
    expect(pending.phase).toBe(
      stage === 'exposure' ? 'building' : 'publishing',
    );
    const journalPath = join(identity.coordination, 'journal.json');
    const savedJournal = await fs.readFile(journalPath);
    const staging =
      stage === 'exposure'
        ? join(identity.coordination, 'staging')
        : internalRootStaging(identity);
    const stagedIdentity = await fs.lstat(staging);
    const sourceInventory = await worker.inventory(identity);
    const withoutNative = createInternalRootMigrationWorker({
      recoverW5: () => Promise.resolve(),
      proveCold: () => Promise.resolve(),
    });
    await expect(
      stage === 'exposure'
        ? withoutNative.exposeStaging(pending)
        : withoutNative.publish(pending),
    ).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await fs.readFile(journalPath)).toEqual(savedJournal);
    expect(await fs.lstat(staging)).toMatchObject({
      dev: stagedIdentity.dev,
      ino: stagedIdentity.ino,
    });
    for (const name of ['opaque data α', 'empty'])
      expect(await fs.readFile(join(staging, name))).toEqual(
        await fs.readFile(join(identity.source, name)),
      );
    await assertSource();
    expect(await worker.inventory(identity)).toMatchObject({
      sourceIdentity: sourceInventory.sourceIdentity,
      fingerprint: sourceInventory.fingerprint,
    });
    await expect(fs.lstat(identity.destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await run()).kind).toBe('complete');
  },
);

(linux ? test : test.skip)(
  'never replaces an independent empty destination created at the publication syscall',
  async () => {
    let competed = false;
    const renameNoReplace = host.renameNoReplace;
    if (!renameNoReplace)
      throw new Error('Native no-replace publisher required');
    const raceHost: InternalRootFilesystemHost = {
      renameNoReplace: (from, to, expected) => {
        if (to === identity.destination) {
          mkdirSync(to, { mode: 0o700 });
          competed = true;
        }
        renameNoReplace(from, to, expected);
      },
    };
    await expect(
      run({
        ...worker,
        publish: (value) => publishInternalRoot(value, raceHost),
      }),
    ).rejects.toMatchObject({ reason: 'destination-exists' });
    expect(competed).toBe(true);
    const independent = await fs.lstat(identity.destination);
    expect(await fs.readdir(identity.destination)).toEqual([]);
    expect((await journal()).phase).toBe('publishing');
    await expect(run()).rejects.toMatchObject({ reason: 'destination-exists' });
    expect((await fs.lstat(identity.destination)).ino).toBe(independent.ino);
    expect((await fs.lstat(internalRootStaging(identity))).isDirectory()).toBe(
      true,
    );
    await assertSource();
  },
);

(linux ? test : test.skip)(
  'anchors Linux destination writes when the construction pathname becomes a source symlink',
  async () => {
    const original = fs.copyFile;
    let swapped = false;
    const before = await worker.inventory(identity);
    jest.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
      await original(...args);
      if (!swapped) {
        swapped = true;
        const path = join(identity.coordination, 'staging');
        await fs.rename(
          path,
          join(identity.coordination, 'retained-construction'),
        );
        await fs.symlink(identity.source, path);
      }
    });
    await expect(run()).rejects.toBeDefined();
    jest.restoreAllMocks();
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
    expect(await fs.readlink(join(identity.coordination, 'staging'))).toBe(
      identity.source,
    );
  },
);

darwinTest.each([
  { changed: false, inheritedGroup: false },
  { changed: true, inheritedGroup: false },
  { changed: false, inheritedGroup: true },
])(
  'compares unassignable source groups without ignoring other clone changes ($changed, inherited: $inheritedGroup)',
  async ({ changed, inheritedGroup }) => {
    const original = fs.lstat;
    const originalSync = syncFs.lstatSync;
    const foreignGroup = 987654;
    jest.spyOn(process, 'getgroups').mockReturnValue([]);
    const projectedGroup = (path: unknown): number | undefined => {
      if (
        ['empty', 'opaque data α'].some(
          (name) => path === join(identity.source, name),
        )
      )
        return foreignGroup;
      if (
        inheritedGroup &&
        ['empty', 'opaque data α'].some((name) =>
          String(path).endsWith(`/${name}`),
        )
      )
        // A setgid parent can supply a group outside the account's memberships.
        return foreignGroup - 1;
      return undefined;
    };
    // The manifest is synchronous; group projection still reads the copy asynchronously.
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const stat = await original(...args);
      const gid = projectedGroup(args[0]);
      if (gid !== undefined) Object.defineProperty(stat, 'gid', { value: gid });
      return stat;
    });
    jest.spyOn(syncFs, 'lstatSync').mockImplementation((...args) => {
      const stat = originalSync(...args);
      const gid = projectedGroup(args[0]);
      if (gid !== undefined) Object.defineProperty(stat, 'gid', { value: gid });
      return stat;
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cloneTree = async (from: string, to: string): Promise<void> => {
      await execute('/bin/cp', ['-c', '-R', '-p', from, to]);
      if (changed) await fs.chmod(join(to, 'empty'), 0o644);
    };
    const effects = createInternalRootMigrationWorker({
      cloneTree,
      recoverW5: () => Promise.resolve(),
      proveCold: () => Promise.resolve(),
    });
    if (changed)
      await expect(run(effects)).rejects.toMatchObject({
        reason: 'source-changed',
      });
    else {
      await expect(
        run({
          ...effects,
          build: async (value) => {
            const result = await effects.build(value);
            expect(result.sourceInventory).toMatchObject(
              await legacyManifest(identity.source),
            );
            const staging = join(identity.coordination, 'staging');
            expect(await legacyManifest(staging)).toEqual(
              await legacyManifest(
                identity.source,
                false,
                () => false,
                async (relative) =>
                  (await fs.lstat(join(staging, relative))).gid,
              ),
            );
            return result;
          },
        }),
      ).resolves.toMatchObject({ kind: 'complete' });
      for (const name of ['empty', 'opaque data α'])
        expect(stderr.mock.calls.flat().join('')).toContain(
          JSON.stringify(join(identity.source, name)),
        );
      expect(stderr.mock.calls.flat().join('')).toContain(
        `group ${foreignGroup}`,
      );
      expect(stderr.mock.calls.flat().join('')).toContain(
        `group ${(await fs.lstat(join(identity.destination, 'empty'))).gid}`,
      );
    }
  },
);

test.each(['private', 'exposed'])(
  'explicit restart preserves a changed pre-publication transaction (%s staging)',
  async (stage) => {
    const fault = {
      ...worker,
      exposeStaging: async (value: InternalRootJournal): Promise<void> => {
        if (stage === 'exposed') await worker.exposeStaging(value);
        throw new Error('before repairs');
      },
    };
    await expect(run(fault)).rejects.toThrow('before repairs');
    const old = await journal();
    const before = await fs.readFile(
      join(identity.coordination, 'journal.json'),
    );
    await fs.writeFile(join(identity.source, 'new-work'), 'keep new source');
    const changedSource = run();
    await expect(changedSource).rejects.toMatchObject({
      reason: 'source-changed',
    });
    await expect(changedSource).rejects.toThrow('--apply --restart');
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, restart: true },
        repairs,
      ),
    ).resolves.toMatchObject({ kind: 'complete' });
    const retained = join(
      identity.coordination,
      `restarted-${old.transactionId}`,
    );
    expect(await fs.readFile(join(retained, 'journal.json'))).toEqual(before);
    expect(
      await fs.readFile(join(retained, 'staging', 'opaque data α')),
    ).toEqual(Buffer.from([0, 255, 3, 0]));
    expect((await journal()).transactionId).not.toBe(old.transactionId);
    expect(
      await fs.readFile(join(identity.destination, 'new-work'), 'utf8'),
    ).toBe('keep new source');
    await assertSource();
  },
);

test('restart refuses changed external preimages and preserves the active transaction', async () => {
  const external = join(home, 'backlink');
  await fs.writeFile(external, 'before', { mode: 0o600 });
  const port: InternalRootRepairs = {
    ...repairs,
    prepare: () =>
      Promise.resolve({ kind: 'ready', externalFiles: [external] }),
  };
  await expect(
    run(
      {
        ...worker,
        build: () => Promise.reject(new Error('before clone')),
      },
      port,
    ),
  ).rejects.toThrow('before clone');
  const saved = await fs.readFile(join(identity.coordination, 'journal.json'));
  await fs.writeFile(external, 'changed');
  await expect(
    migrateInternalRoot(worker, identity, { ...apply, restart: true }, port),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(
    await fs.readFile(join(identity.coordination, 'journal.json')),
  ).toEqual(saved);
  expect(await fs.readFile(external, 'utf8')).toBe('changed');
  expect(
    (await fs.readdir(identity.coordination)).some((name) =>
      name.startsWith('restarted-'),
    ),
  ).toBe(false);
});

test('restart refuses a replaced source directory without moving its journal', async () => {
  await expect(
    run({
      ...worker,
      build: () => Promise.reject(new Error('before clone')),
    }),
  ).rejects.toThrow('before clone');
  const saved = await fs.readFile(join(identity.coordination, 'journal.json'));
  await fs.rename(identity.source, join(home, 'retained-source'));
  await createPrivateMigrationDirectory(identity.source, host);
  await expect(
    migrateInternalRoot(worker, identity, { ...apply, restart: true }, repairs),
  ).rejects.toMatchObject({ reason: 'source-changed' });
  expect(
    await fs.readFile(join(identity.coordination, 'journal.json')),
  ).toEqual(saved);
  expect(
    (await fs.readdir(identity.coordination)).some((name) =>
      name.startsWith('restarted-'),
    ),
  ).toBe(false);
});

test('restart never moves a changed publishing tree', async () => {
  await expect(
    run({
      ...worker,
      publish: () => Promise.reject(new Error('before publish')),
    }),
  ).rejects.toThrow('before publish');
  const saved = await fs.readFile(join(identity.coordination, 'journal.json'));
  await fs.writeFile(join(identity.source, 'new-work'), 'changed');
  await fs.writeFile(join(internalRootStaging(identity), 'used'), 'changed');
  await expect(
    migrateInternalRoot(worker, identity, { ...apply, restart: true }, repairs),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(
    await fs.readFile(join(identity.coordination, 'journal.json')),
  ).toEqual(saved);
  expect(
    (await fs.readdir(identity.coordination)).some((name) =>
      name.startsWith('restarted-'),
    ),
  ).toBe(false);
});

test.each(['after-staging', 'after-journal'])(
  'resumes preservation interrupted %s without deleting the previous attempt',
  async (cut) => {
    await expect(
      run({
        ...worker,
        exposeStaging: () => Promise.reject(new Error('before exposure')),
      }),
    ).rejects.toThrow('before exposure');
    const old = await journal();
    const saved = await fs.readFile(
      join(identity.coordination, 'journal.json'),
    );
    const retained = join(
      identity.coordination,
      `restarted-${old.transactionId}`,
    );
    await createPrivateMigrationDirectory(retained, host);
    await fs.rename(
      join(identity.coordination, 'staging'),
      join(retained, 'staging'),
    );
    if (cut === 'after-journal')
      await fs.rename(
        join(identity.coordination, 'journal.json'),
        join(retained, 'journal.json'),
      );
    await fs.writeFile(join(identity.source, 'new-work'), 'changed');
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, restart: true },
        repairs,
      ),
    ).resolves.toMatchObject({ kind: 'complete' });
    expect(await fs.readFile(join(retained, 'journal.json'))).toEqual(saved);
    expect(
      await fs.readFile(join(retained, 'staging', 'opaque data α')),
    ).toEqual(Buffer.from([0, 255, 3, 0]));
    expect((await journal()).transactionId).not.toBe(old.transactionId);
  },
);

darwinTest(
  'still refuses a copied group mismatch when the source group is assignable',
  async () => {
    const original = syncFs.lstatSync;
    jest.spyOn(syncFs, 'lstatSync').mockImplementation((...args) => {
      const stat = original(...args);
      if (args[0] === join(identity.coordination, 'staging', 'empty'))
        Object.defineProperty(stat, 'gid', { value: 987654 });
      return stat;
    });
    await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
    await assertSource();
  },
);

test('restart refuses an independent destination before moving staging or journal', async () => {
  await expect(
    run({
      ...worker,
      exposeStaging: () => Promise.reject(new Error('before exposure')),
    }),
  ).rejects.toThrow('before exposure');
  const saved = await fs.readFile(join(identity.coordination, 'journal.json'));
  await createPrivateMigrationDirectory(identity.destination, host);
  await fs.writeFile(join(identity.destination, 'independent'), 'retain');
  await expect(
    migrateInternalRoot(worker, identity, { ...apply, restart: true }, repairs),
  ).rejects.toMatchObject({ reason: 'source-changed' });
  expect(
    await fs.readFile(join(identity.coordination, 'journal.json')),
  ).toEqual(saved);
  expect(
    await fs.readFile(join(identity.destination, 'independent'), 'utf8'),
  ).toBe('retain');
  expect(
    (await fs.lstat(join(identity.coordination, 'staging'))).isDirectory(),
  ).toBe(true);
});

test.each(['recoverW5', 'captureExternal', 'build'] as const)(
  'explicit restart preserves a transaction stopped at %s without staging',
  async (effect) => {
    const stop = (): Promise<never> =>
      Promise.reject(new Error('before staging'));
    await expect(run({ ...worker, [effect]: stop })).rejects.toThrow(
      'before staging',
    );
    const old = await journal();
    const saved = await fs.readFile(
      join(identity.coordination, 'journal.json'),
    );
    await fs.writeFile(join(identity.source, 'new-work'), 'current source');
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, restart: true },
        repairs,
      ),
    ).resolves.toMatchObject({ kind: 'complete' });
    expect(
      await fs.readFile(
        join(
          identity.coordination,
          `restarted-${old.transactionId}`,
          'journal.json',
        ),
      ),
    ).toEqual(saved);
    expect(
      await fs.readFile(join(identity.destination, 'new-work'), 'utf8'),
    ).toBe('current source');
  },
);

test.each([
  'publishing-sibling',
  'publishing-destination',
  'complete-pending',
  'restoring-external',
  'rebuilding',
  'discarding',
  'discarding-partial',
])(
  'restart preserves an untouched sealed tree at %s and reads the retained journal',
  async (phase) => {
    await expect(
      run({
        ...worker,
        relocateSecure: () => Promise.reject(new Error('secure pending')),
      }),
    ).rejects.toThrow('secure pending');
    let old = await journal();
    if (phase !== 'complete-pending') {
      old = {
        ...old,
        phase:
          phase === 'publishing-sibling' || phase === 'publishing-destination'
            ? 'publishing'
            : phase === 'restoring-external'
              ? 'restoring-external'
              : 'rebuilding',
      };
      await worker.saveJournal(old);
    }
    if (phase === 'publishing-sibling')
      await fs.rename(identity.destination, internalRootStaging(identity));
    if (phase === 'discarding' || phase === 'discarding-partial') {
      await fs.rename(
        identity.destination,
        join(identity.coordination, 'discarding'),
      );
      if (phase === 'discarding-partial')
        await fs.unlink(join(identity.coordination, 'discarding', 'empty'));
    }
    await fs.writeFile(join(identity.source, 'continued-work'), 'retain');
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, restart: true },
        repairs,
      ),
    ).resolves.toMatchObject({ kind: 'complete' });
    const retained = join(
      identity.coordination,
      `restarted-${old.transactionId}`,
    );
    expect(
      JSON.parse(await fs.readFile(join(retained, 'journal.json'), 'utf8')),
    ).toMatchObject({ phase: old.phase });
    expect(
      await fs.readFile(join(identity.destination, 'continued-work'), 'utf8'),
    ).toBe('retain');
    expect((await journal()).transactionId).not.toBe(old.transactionId);
    await assertSource();
  },
);

test.each(['pending', 'complete'] as const)(
  'restart refuses a used destination or relocated secure state (%s) naming both roots',
  async (secureRelocation) => {
    await run();
    await worker.saveJournal({ ...(await journal()), secureRelocation });
    if (secureRelocation === 'pending')
      await fs.writeFile(join(identity.destination, 'used'), 'new work');
    const saved = await fs.readFile(
      join(identity.coordination, 'journal.json'),
    );
    const attempt = migrateInternalRoot(
      worker,
      identity,
      { ...apply, restart: true },
      repairs,
    );
    await expect(attempt).rejects.toThrow(identity.source);
    await expect(attempt).rejects.toThrow(identity.destination);
    expect(
      await fs.readFile(join(identity.coordination, 'journal.json')),
    ).toEqual(saved);
    expect(await fs.lstat(identity.destination)).toBeDefined();
    if (secureRelocation === 'pending')
      expect(
        await fs.readFile(join(identity.destination, 'used'), 'utf8'),
      ).toBe('new work');
  },
);

test.each(['publishing', 'complete'] as const)(
  'restart refuses a used tree in discarding without a rebuilding intent (%s)',
  async (phase) => {
    await expect(
      run({
        ...worker,
        relocateSecure: () => Promise.reject(new Error('secure pending')),
      }),
    ).rejects.toThrow('secure pending');
    const old = { ...(await journal()), phase };
    await worker.saveJournal(old);
    const discarded = join(identity.coordination, 'discarding');
    await fs.rename(identity.destination, discarded);
    await fs.writeFile(join(discarded, 'new-work'), 'destination-only work');
    const attempt = migrateInternalRoot(
      worker,
      identity,
      { ...apply, restart: true },
      repairs,
    );
    await expect(attempt).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    await expect(attempt).rejects.toThrow(identity.source);
    await expect(attempt).rejects.toThrow(identity.destination);
    expect((await journal()).transactionId).toBe(old.transactionId);
    expect(await fs.readFile(join(discarded, 'new-work'), 'utf8')).toBe(
      'destination-only work',
    );
  },
);

test('inventory blocks split non-empty secure stores before publication', async () => {
  await fs.mkdir(join(identity.source, 'secure-storage'));
  await fs.writeFile(
    join(identity.source, 'secure-storage', 'opaque'),
    'do not inspect',
  );
  await createPrivateMigrationDirectory(identity.historicalSecure, host);
  const result = await migrateInternalRoot(
    worker,
    identity,
    { apply: false, declareInternal: true },
    repairs,
  );
  expect(result).toMatchObject({
    kind: 'inventory',
    preflight: { kind: 'refused' },
  });
  if (result.kind !== 'inventory') throw new Error('expected inventory');
  expect(result.preflight.blockers.join(' ')).toContain('secure');
  await expect(run()).rejects.toThrow('secure');
  await expect(fs.lstat(identity.destination)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

posixTest.each([
  'partial',
  'all',
  'pruned-live',
  'removed',
  'third-image',
  'pruned-third-image',
  'pruned-unreadable',
  'after-evidence',
  'umask-captured',
  'umask-legacy',
  'umask-legacy-third-image',
  'umask-other',
])(
  'restart restores unsealed Git repair (%s) before a fresh prepared transaction',
  async (cut) => {
    const common = join(home, 'external-repository');
    await createPrivateMigrationDirectory(common, host);
    await git(common, ['init']);
    await git(common, ['commit', '--allow-empty', '-m', 'fixture']);
    const checkouts = [
      join(identity.source, 'one\u00a0'),
      join(identity.source, 'two'),
    ];
    for (const [index, path] of checkouts.entries())
      await git(common, ['worktree', 'add', '-b', `branch-${index}`, path]);
    for (const path of checkouts)
      expect(await isPrunedInternalRootCheckout(path)).toBe(false);
    const plan = await prepareRelocationGit(git, [common, ...checkouts]);
    if (cut.startsWith('umask-')) {
      process.umask(0o022);
      for (const image of plan.backlinks) await fs.chmod(image.path, 0o664);
    }
    const port: InternalRootRepairs = {
      ...repairs,
      settleSourceFirst: true,
      prepare: (context) =>
        Promise.resolve({
          kind: 'ready',
          externalFiles: plan.backlinks
            .map((row) => row.path)
            .filter((path) => !isWithin(identity.source, path)),
          repairPlan: {
            transition: relocationTransition({
              version: 1,
              installationId: context.transactionId,
              brandId: identity.brandId,
              from: {
                authorityId: 'a'.repeat(64),
                canonicalDataRoot: identity.source,
              },
              to: {
                authorityId: 'b'.repeat(64),
                canonicalDataRoot: identity.destination,
              },
            }),
            gitPlan: plan,
            ownedPaths: [],
            workspaces: [],
          },
        }),
      repair: async (context) => {
        if (!context.repairPlan) throw new Error('missing repair plan');
        await repairRelocationGit(
          context.repairPlan.transition,
          plan,
          context.workingRoot,
        );
        throw new Error('after unsealed repairs');
      },
    };
    await expect(run(worker, port)).rejects.toThrow('after unsealed repairs');
    const old = await journal();
    if (cut === 'after-evidence') {
      const retained = join(
        identity.coordination,
        `restarted-${old.transactionId}`,
      );
      await createPrivateMigrationDirectory(retained, host);
      const name = (await fs.readdir(identity.coordination)).find((name) =>
        name.startsWith('external-'),
      );
      if (!name) throw new Error('missing preimage');
      await fs.rename(join(identity.coordination, name), join(retained, name));
    }
    const externals = plan.backlinks.filter((row) =>
      old.externalFiles.includes(row.path),
    );
    if (cut === 'umask-captured')
      for (const image of externals)
        expect((await fs.lstat(image.path)).mode & 0o777).toBe(0o664);
    if (cut.startsWith('umask-legacy') || cut === 'umask-other')
      for (const image of cut.startsWith('umask-legacy')
        ? externals
        : externals.slice(-1))
        await fs.chmod(
          image.path,
          cut.startsWith('umask-legacy') ? 0o644 : 0o660,
        );
    if (cut === 'partial') {
      const entry = externals[externals.length - 1];
      if (!entry) throw new Error('missing external');
      await fs.writeFile(entry.path, entry.contents);
    }
    let absent: string | undefined;
    if (cut.startsWith('pruned-') || cut === 'removed') {
      const checkout = checkouts[0];
      if (!checkout) throw new Error('missing checkout');
      absent = (
        await git(checkout, ['rev-parse', '--absolute-git-dir'])
      ).replace(/\r?\n$/, '');
      await fs.rm(absent, { recursive: true });
      if (cut === 'removed') await fs.rm(checkout, { recursive: true });
    }
    const changed = externals[externals.length - 1];
    const first = externals.find(
      (image) =>
        image.path !== changed?.path &&
        (!absent || !isWithin(absent, image.path)),
    );
    if (!first) throw new Error('missing first external');
    const conflict =
      cut === 'third-image' ||
      cut === 'pruned-third-image' ||
      cut === 'umask-legacy-third-image' ||
      cut === 'umask-other';
    const firstRepaired =
      conflict || cut === 'pruned-unreadable'
        ? await fs.readFile(first.path)
        : null;
    if (!changed) throw new Error('missing external');
    if (conflict && cut !== 'umask-other')
      await fs.writeFile(changed.path, 'unexpected repair');
    const open = fs.open.bind(fs);
    if (cut === 'pruned-unreadable')
      jest.spyOn(fs, 'open').mockImplementation((...args) => {
        if (args[0] === changed.path)
          return Promise.reject(
            Object.assign(new Error('backlink read denied'), {
              code: 'EACCES',
            }),
          );
        return open(...args);
      });
    await fs.writeFile(join(identity.source, 'continued-work'), 'keep');
    const attempt = migrateInternalRoot(
      {
        ...worker,
        recoverW5: async (fresh) => {
          expect(fresh.phase).toBe('prepared');
          expect(fresh.transactionId).not.toBe(old.transactionId);
          for (const image of externals) {
            if (absent && isWithin(absent, image.path)) continue;
            expect(await fs.readFile(image.path, 'utf8')).toBe(image.contents);
            if (cut.startsWith('umask-'))
              expect((await fs.lstat(image.path)).mode & 0o777).toBe(0o664);
          }
          throw new Error('fresh prepared reached');
        },
      },
      identity,
      { ...apply, restart: true },
      port,
    );
    if (conflict) {
      await expect(attempt).rejects.toThrow(JSON.stringify(changed.path));
      expect((await journal()).transactionId).toBe(old.transactionId);
      if (cut !== 'umask-other')
        expect(await fs.readFile(changed.path, 'utf8')).toBe(
          'unexpected repair',
        );
      else expect((await fs.lstat(changed.path)).mode & 0o777).toBe(0o660);
      expect(await fs.readFile(first.path)).toEqual(firstRepaired);
    } else if (cut === 'pruned-unreadable') {
      await expect(attempt).rejects.toMatchObject({ code: 'EACCES' });
      expect((await journal()).transactionId).toBe(old.transactionId);
      expect(await fs.readFile(first.path)).toEqual(firstRepaired);
    } else {
      await expect(attempt).rejects.toThrow('fresh prepared reached');
      expect(
        await fs.readFile(
          join(
            identity.coordination,
            `restarted-${old.transactionId}`,
            'journal.json',
          ),
          'utf8',
        ),
      ).toContain(old.transactionId);
    }
  },
);

test.each(['empty-nested', 'nested-only'])(
  'does not invent a secure split conflict for %s',
  async (shape) => {
    await createPrivateMigrationDirectory(
      join(identity.source, 'secure-storage'),
      host,
    );
    if (shape === 'empty-nested')
      await createPrivateMigrationDirectory(identity.historicalSecure, host);
    else
      await fs.writeFile(
        join(identity.source, 'secure-storage', 'opaque'),
        'keep',
      );
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
  },
);

test('completed secure relocation source-changed refusal does not suggest restart', async () => {
  await run();
  await fs.writeFile(join(identity.source, 'continued-work'), 'keep');
  const attempt = migrateInternalRoot(
    worker,
    identity,
    { ...apply, rebuild: true },
    repairs,
  );
  await expect(attempt).rejects.toMatchObject({ reason: 'source-changed' });
  await expect(attempt).rejects.not.toThrow('--apply --restart');
});

darwinTest.each(
  [
    'exposure',
    'before-publication',
    'after-publication',
    'secure-pending',
  ].flatMap((stage) => [false, true].map((restart) => ({ stage, restart }))),
)(
  'resumes $stage (restart=$restart) after a device renumber without accepting a different inode',
  async ({ stage, restart }) => {
    await expect(
      run({
        ...worker,
        exposeStaging: async (value) => {
          await worker.exposeStaging(value);
          if (stage === 'exposure') throw new Error('renumber interruption');
        },
        publish: async (value) => {
          if (stage === 'before-publication')
            throw new Error('renumber interruption');
          await worker.publish(value);
          if (stage === 'after-publication')
            throw new Error('renumber interruption');
        },
        relocateSecure: () =>
          Promise.reject(new Error('renumber interruption')),
      }),
    ).rejects.toThrow('renumber interruption');
    const pending = await journal();
    const renumber = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined;
      const [dev, ino] = value.split(':');
      return `${BigInt(dev) + 1n}:${ino}`;
    };
    const updated = {
      ...pending,
      inventory: {
        ...pending.inventory,
        sourceIdentity: renumber(pending.inventory.sourceIdentity) ?? null,
      },
      stagingIdentity: renumber(pending.stagingIdentity),
      publicationIdentity: renumber(pending.publicationIdentity),
    };
    if (stage === 'before-publication') {
      await expect(
        worker.seal(pending, updated.publicationIdentity ?? ''),
      ).rejects.toMatchObject({ reason: 'destination-exists' });
    }
    await worker.saveJournal(updated);
    const resume = (): ReturnType<typeof migrateInternalRoot> =>
      migrateInternalRoot(worker, identity, { ...apply, restart }, repairs);
    if (restart) {
      const source = await fs.lstat(identity.source);
      await worker.saveJournal({
        ...updated,
        inventory: {
          ...updated.inventory,
          sourceIdentity: `${source.dev + 1}:${source.ino + 1}`,
        },
      });
      await expect(resume()).rejects.toMatchObject({
        reason: 'source-changed',
      });
      await worker.saveJournal(updated);
    }
    const target =
      stage === 'exposure' || stage === 'before-publication'
        ? internalRootStaging(identity)
        : identity.destination;
    const actual = await fs.lstat(target);
    const different = `${actual.dev + 1}:${actual.ino + 1}`;
    await worker.saveJournal({
      ...updated,
      stagingIdentity: different,
      ...(updated.publicationIdentity
        ? { publicationIdentity: different }
        : {}),
    });
    await expect(resume()).rejects.toMatchObject({
      reason:
        stage === 'secure-pending' || (restart && stage === 'after-publication')
          ? 'recovery-required'
          : 'destination-exists',
    });
    await worker.saveJournal(updated);
    expect((await resume()).kind).toBe('complete');
    if (restart) {
      const retained = join(
        identity.coordination,
        `restarted-${pending.transactionId}`,
      );
      expect(
        JSON.parse(await fs.readFile(join(retained, 'journal.json'), 'utf8')),
      ).toEqual(updated);
      expect(
        await fs.readFile(join(retained, 'staging', 'opaque data α')),
      ).toEqual(Buffer.from([0, 255, 3, 0]));
      expect((await journal()).transactionId).not.toBe(pending.transactionId);
    }
    await assertSource();
  },
);

darwinTest.each(['private', 'saved-staging', 'saved-discarding'])(
  'restarts %s after a device renumber without losing retained evidence',
  async (location) => {
    await expect(
      run({
        ...worker,
        exposeStaging: async (value) => {
          if (location === 'private') throw new Error('renumber interruption');
          await worker.exposeStaging(value);
        },
        publish: () => Promise.reject(new Error('renumber interruption')),
      }),
    ).rejects.toThrow('renumber interruption');
    const pending = await journal();
    const renumber = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined;
      const [dev, ino] = value.split(':');
      return `${BigInt(dev) + 1n}:${ino}`;
    };
    const updated: InternalRootJournal = {
      ...pending,
      phase: location === 'saved-discarding' ? 'rebuilding' : pending.phase,
      inventory: {
        ...pending.inventory,
        sourceIdentity: renumber(pending.inventory.sourceIdentity) ?? null,
      },
      stagingIdentity: renumber(pending.stagingIdentity),
      publicationIdentity: renumber(pending.publicationIdentity),
    };
    await worker.saveJournal(updated);
    const retained = join(
      identity.coordination,
      `restarted-${pending.transactionId}`,
    );
    const name = location === 'saved-discarding' ? 'discarding' : 'staging';
    if (location !== 'private') {
      await createPrivateMigrationDirectory(retained, host);
      await fs.rename(internalRootStaging(identity), join(retained, name));
      const stat = await fs.lstat(join(retained, name));
      const different = `${stat.dev + 1}:${stat.ino + 1}`;
      await worker.saveJournal({
        ...updated,
        stagingIdentity: different,
        publicationIdentity: different,
      });
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, restart: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect((await journal()).transactionId).toBe(pending.transactionId);
      await worker.saveJournal(updated);
    }
    await fs.writeFile(join(identity.source, 'continued-work'), 'retain');
    const resume = run();
    await expect(resume).rejects.toMatchObject({ reason: 'source-changed' });
    await expect(resume).rejects.toThrow('--apply --restart');
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, restart: true },
        repairs,
      ),
    ).resolves.toMatchObject({ kind: 'complete' });
    expect(
      JSON.parse(await fs.readFile(join(retained, 'journal.json'), 'utf8')),
    ).toEqual(updated);
    expect(await fs.readFile(join(retained, name, 'opaque data α'))).toEqual(
      Buffer.from([0, 255, 3, 0]),
    );
    expect((await journal()).transactionId).not.toBe(pending.transactionId);
    expect(
      await fs.readFile(join(identity.destination, 'continued-work'), 'utf8'),
    ).toBe('retain');
    await assertSource();
  },
);
