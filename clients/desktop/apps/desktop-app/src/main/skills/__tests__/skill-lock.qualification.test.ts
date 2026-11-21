// CAN-4483 golden: the skills lock, its v1 directory and source-metadata
// migration and the installed skill directories, qualified under their
// current owner, Electron main. It drives the real lock and skill service on
// a data root the suite owns; only GitHub, the feature flags and logging are
// replaced. Each case starts a fresh module, as a restart does; a case that
// seeds a partly migrated tree reproduces what an exit leaves on disk.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from '../../lib/paths';
import type * as FsPromises from 'node:fs/promises';
import type * as AtomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import type * as LockFile from '../lock-file';

const mockHttpsGetBuffer = jest.fn(
  (): Promise<Buffer> => Promise.reject(new Error('offline')),
);
const mockDiscovered = ['x'];
const mockBeforeTree = jest.fn();
jest.mock('../skill-discovery', () => ({
  getGitHubToken: (): Promise<null> => Promise.resolve(null),
  fetchGitHubTree: (): Promise<unknown> =>
    Promise.resolve(mockBeforeTree()).then(() => ({
      tree: mockDiscovered.map((name) => ({
        path: `skills/${name}/SKILL.md`,
        type: 'blob',
        sha: `b-${name}`,
      })),
      resolvedBranch: 'main',
      treeSha: 'root',
    })),
  discoverSkillsFromGitHub: (): Promise<unknown> =>
    Promise.resolve({
      skills: mockDiscovered.map((name) => ({
        name,
        description: `${name} skill`,
        sourcePath: `skills/${name}`,
      })),
      resolvedBranch: 'main',
      hasMarketplace: false,
    }),
}));
jest.mock('../../lib/http', () => ({
  httpsGetBuffer: (): Promise<Buffer> => mockHttpsGetBuffer(),
  httpsGet: (): Promise<string> => Promise.reject(new Error('offline')),
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => false,
  }),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
  logMainProcessInfo: jest.fn(),
}));

type LockModule = typeof LockFile;

const SOURCE = 'github:o:r';
const skillsDir = (): string => join(getDataDir(), 'skills');
const lockPath = (): string => join(skillsDir(), 'skills-lock.json');

function entry(
  name: string,
  source = 'o/r',
): {
  source: string;
  sourceType: 'github';
  sourceUrl: string;
  skillPath: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
} {
  return {
    source,
    sourceType: 'github' as const,
    sourceUrl: `https://github.com/${source}`,
    skillPath: `skills/${name}`,
    skillFolderHash: `hash-${name}`,
    installedAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function storedLock(): { version: unknown; skills: object } {
  const parsed: unknown = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('skills' in parsed) ||
    typeof parsed.skills !== 'object' ||
    parsed.skills === null
  )
    throw new Error('The lock has no skills');
  return {
    version: 'version' in parsed ? parsed.version : undefined,
    skills: parsed.skills,
  };
}

function thrownCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof Error && 'code' in error ? error.code : 'no code';
  }
  return 'did not throw';
}

function writeLock(value: unknown): string {
  fs.mkdirSync(skillsDir(), { recursive: true });
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  fs.writeFileSync(lockPath(), text);
  return text;
}

function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`,
  );
}

const flatDir = (name: string): string => join(skillsDir(), name);
async function nestedDir(name: string): Promise<string> {
  const { getSkillDir } = await import('../paths');
  return getSkillDir(SOURCE, name);
}

function seedV1(names: string[]): string {
  for (const name of names) writeSkill(flatDir(name), name);
  return writeLock({
    version: 1,
    skills: Object.fromEntries(names.map((name) => [name, entry(name)])),
  });
}

function setAside(kind: string): string[] {
  return fs
    .readdirSync(skillsDir())
    .filter((name) => name.startsWith(`skills-lock.json.${kind}`));
}

async function loadLock(): Promise<LockModule> {
  jest.resetModules();
  return import('../lock-file');
}

// Cases given a 30 s timeout load the skill service afresh after
// jest.resetModules(): 0.5 to 5 s locally, several times that on a loaded CI
// runner, past Jest's 5 s default.

// Own the data roots: never seed or delete files in an inherited directory.
const inheritedDirs = {
  CANOPY_DATA_DIR: process.env.CANOPY_DATA_DIR,
  CANOPY_SECURE_DATA_DIR: process.env.CANOPY_SECURE_DATA_DIR,
};
let ownedRoot = '';
beforeAll(() => {
  ownedRoot = fs.mkdtempSync(join(tmpdir(), 'can-4483-'));
  process.env.CANOPY_DATA_DIR = join(ownedRoot, 'data');
  process.env.CANOPY_SECURE_DATA_DIR = join(ownedRoot, 'secure');
});
afterAll(() => {
  for (const [name, value] of Object.entries(inheritedDirs)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(ownedRoot, { recursive: true, force: true });
});

beforeEach(() => {
  expect(getDataDir()).toBe(join(ownedRoot, 'data'));
  fs.rmSync(skillsDir(), { recursive: true, force: true });
  mockHttpsGetBuffer.mockReset();
  mockHttpsGetBuffer.mockImplementation(() =>
    Promise.reject(new Error('offline')),
  );
  mockDiscovered.splice(0, mockDiscovered.length, 'x');
  mockBeforeTree.mockReset();
  jest.restoreAllMocks();
});

describe('skills lock persistence', () => {
  test('a damaged lock is copied aside before the next write and the install continues', async () => {
    const damaged = writeLock('{ not json');
    const lock = await loadLock();

    expect(lock.readLockFile().skills).toEqual({});
    lock.addLockEntry(SOURCE, 'x', { ...entry('x'), sourceId: SOURCE });
    const [copy] = setAside('damaged-');
    expect(fs.readFileSync(join(skillsDir(), copy ?? ''), 'utf8')).toBe(
      damaged,
    );
    expect(Object.keys(lock.readLockFile().skills)).toEqual([`${SOURCE}/x`]);
  });

  test('a newer lock refuses writes with a typed error and is never written over', async () => {
    const newer = writeLock({ version: 3, skills: { future: {} } });
    const lock = await loadLock();

    expect(lock.readLockFile().skills).toEqual({});
    expect(() =>
      lock.addLockEntry(SOURCE, 'x', { ...entry('x'), sourceId: SOURCE }),
    ).toThrow(lock.SkillLockFileError);
    expect(thrownCode(() => lock.removeLockEntry(SOURCE, 'x'))).toBe('newer');
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(newer);
  });

  test('a newer lock with another payload shape is refused, not set aside', async () => {
    const newer = writeLock({ version: 3, skills: [] });
    const lock = await loadLock();

    expect(
      thrownCode(() =>
        lock.addLockEntry(SOURCE, 'x', { ...entry('x'), sourceId: SOURCE }),
      ),
    ).toBe('newer');
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(newer);
    expect(setAside('damaged')).toEqual([]);
  });

  test('lock writes are durable', async () => {
    const lock = await loadLock();
    const durable = jest.spyOn(
      await import('@canopy/execution-engine/node/lib/atomic-file'),
      'writeFileAtomicallySync',
    );
    lock.addLockEntry(SOURCE, 'x', { ...entry('x'), sourceId: SOURCE });

    expect(durable).toHaveBeenCalledWith(
      lockPath(),
      expect.any(String),
      expect.objectContaining({ durable: true }),
    );
  });

  test('one unreadable entry is skipped on read and carried through writes', async () => {
    writeSkill(await nestedDir('x'), 'x');
    writeLock({
      version: 2,
      skills: {
        bad: null,
        [`${SOURCE}/x`]: { ...entry('x'), sourceId: SOURCE },
      },
    });
    jest.resetModules();
    const { loadSkills } = await import('../skill-service');
    const listed = loadSkills();
    expect(listed.data?.map((skill) => skill.name)).toEqual(['x']);

    const lock = await import('../lock-file');
    lock.addLockEntry(SOURCE, 'y', { ...entry('y'), sourceId: SOURCE });
    expect(storedLock().skills).toHaveProperty('bad', null);
  }, 30_000);

  test('a failed update keeps the installed skill and its lock entry', async () => {
    const dir = await nestedDir('x');
    writeSkill(dir, 'x');
    writeLock({
      version: 2,
      skills: { [`${SOURCE}/x`]: { ...entry('x'), sourceId: SOURCE } },
    });
    jest.resetModules();
    const { updateSkill, loadSkills } = await import('../skill-service');

    const result = await updateSkill(SOURCE, 'x');
    expect(result.success).toBe(false);
    expect(fs.existsSync(join(dir, 'SKILL.md'))).toBe(true);
    const listed = loadSkills();
    expect(listed.data?.map((skill) => skill.name)).toEqual(['x']);
  }, 30_000);

  test('a lock entry whose folder is missing is offered again by discovery', async () => {
    writeLock({
      version: 2,
      skills: { [`${SOURCE}/x`]: { ...entry('x'), sourceId: SOURCE } },
    });
    jest.resetModules();
    const { fetchAvailable } = await import('../skill-service');

    const result = await fetchAvailable('o/r');
    expect(result.data?.skills.map((s) => s.name)).toEqual(['x']);
  }, 30_000);
});

describe('lock writes from user actions only', () => {
  const skillFile = (name: string): Promise<Buffer> =>
    Promise.resolve(
      Buffer.from(`---\nname: ${name}\ndescription: ${name} skill\n---\n`),
    );

  test('installing several skills writes each entry durably right after its own publish', async () => {
    mockDiscovered.splice(0, mockDiscovered.length, 'x', 'y');
    mockHttpsGetBuffer.mockImplementation(() => skillFile('s'));
    jest.resetModules();
    const atomic =
      await import('@canopy/execution-engine/node/lib/atomic-file');
    const writes = jest.spyOn(atomic, 'writeFileAtomicallySync');
    const { installSkills } = await import('../skill-service');

    const result = await installSkills('o/r', ['x', 'y']);
    expect(result.success).toBe(true);
    const lockWrites = writes.mock.calls.filter(
      ([path]) => path === lockPath(),
    );
    expect(lockWrites).toHaveLength(2);
    for (const [, , options] of lockWrites)
      expect(options).toMatchObject({ durable: true });
    expect(Object.keys(storedLock().skills).sort()).toEqual([
      `${SOURCE}/x`,
      `${SOURCE}/y`,
    ]);
  }, 30_000);

  test('listing and discovery read the lock without writing it', async () => {
    writeSkill(await nestedDir('x'), 'x');
    writeLock({
      version: 2,
      skills: { [`${SOURCE}/x`]: { ...entry('x'), sourceId: SOURCE } },
    });
    jest.resetModules();
    const atomic =
      await import('@canopy/execution-engine/node/lib/atomic-file');
    const writes = jest.spyOn(atomic, 'writeFileAtomicallySync');
    const { loadSkills, fetchAvailable } = await import('../skill-service');

    loadSkills();
    await fetchAvailable('o/r');
    expect(writes).not.toHaveBeenCalled();
  }, 30_000);

  test('an install sweeps day-old download staging and keeps one that holds a previous copy', async () => {
    const { getSourceDir } = await import('../paths');
    const sourceDir = getSourceDir(SOURCE);
    const stale = join(sourceDir, '.install-stale');
    const kept = join(sourceDir, '.install-kept');
    fs.mkdirSync(join(stale, 'next'), { recursive: true });
    writeSkill(join(kept, 'previous'), 'old');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(kept, old, old);
    mockHttpsGetBuffer.mockImplementation(() => skillFile('x'));
    jest.resetModules();
    const { installSkills } = await import('../skill-service');

    expect((await installSkills('o/r', ['x'])).success).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(join(kept, 'previous', 'SKILL.md'))).toBe(true);
  }, 30_000);

  test('an install keeps day-old staging whose previous copy cannot be checked', async () => {
    const { getSourceDir } = await import('../paths');
    const kept = join(getSourceDir(SOURCE), '.install-kept');
    writeSkill(join(kept, 'previous'), 'old');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(kept, old, old);
    mockHttpsGetBuffer.mockImplementation(() => skillFile('x'));
    jest.resetModules();
    const previous = join(kept, 'previous');
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        lstat: (...args: Parameters<typeof actual.lstat>): Promise<unknown> =>
          args[0] === previous
            ? Promise.reject(
                Object.assign(new Error('denied'), { code: 'EACCES' }),
              )
            : actual.lstat(...args),
      };
    });
    try {
      const { installSkills } = await import('../skill-service');

      expect((await installSkills('o/r', ['x'])).success).toBe(true);
      expect(fs.existsSync(join(previous, 'SKILL.md'))).toBe(true);
    } finally {
      jest.dontMock('node:fs/promises');
    }
  }, 30_000);

  test('an install over a version 1 lock migrates it before publishing the skill', async () => {
    seedV1(['x']);
    mockHttpsGetBuffer.mockImplementation(() => skillFile('s'));
    jest.resetModules();
    const { installSkills } = await import('../skill-service');

    expect((await installSkills('o/r', ['x'])).success).toBe(true);
    await (await import('../lock-file')).skillLockMigrationSettled();
    expect(storedLock().version).toBe(2);
    expect(Object.keys(storedLock().skills)).toEqual([`${SOURCE}/x`]);
    expect(fs.existsSync(flatDir('x'))).toBe(false);
  }, 30_000);

  test('a batch install records each skill before the next download starts', async () => {
    mockDiscovered.splice(0, mockDiscovered.length, 'x', 'y');
    let release: (file: Buffer) => void = () => undefined;
    let secondStarted: () => void = () => undefined;
    const second = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let downloads = 0;
    mockHttpsGetBuffer.mockImplementation(() => {
      downloads += 1;
      if (downloads === 1) return skillFile('x');
      secondStarted();
      return new Promise<Buffer>((resolve) => {
        release = resolve;
      });
    });
    jest.resetModules();
    const { installSkills } = await import('../skill-service');

    const installing = installSkills('o/r', ['x', 'y']);
    await second;
    // An exit during this download would leave x published and recorded.
    expect(Object.keys(storedLock().skills)).toEqual([`${SOURCE}/x`]);
    release(Buffer.from('---\nname: y\ndescription: y skill\n---\n'));
    expect((await installing).success).toBe(true);
  }, 30_000);

  test('a batch install that fails part way clears the update flag of the skills it reinstalled', async () => {
    mockDiscovered.splice(0, mockDiscovered.length, 'x', 'y');
    const statusPath = join(skillsDir(), 'update-status.json');
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify({ [`${SOURCE}/x`]: true }));
    let downloads = 0;
    // The first skill downloads; the second fails.
    mockHttpsGetBuffer.mockImplementation(() => {
      downloads += 1;
      return downloads === 1
        ? skillFile('x')
        : Promise.reject(new Error('offline'));
    });
    jest.resetModules();
    const { installSkills } = await import('../skill-service');

    expect((await installSkills('o/r', ['x', 'y'])).success).toBe(false);
    expect(Object.keys(storedLock().skills)).toEqual([`${SOURCE}/x`]);
    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
      [`${SOURCE}/x`]: false,
    });
  }, 30_000);

  test('an update against a lock refused meanwhile leaves the old files and the lock', async () => {
    writeSkill(await nestedDir('x'), 'x');
    writeLock({ version: 2, skills: { [`${SOURCE}/x`]: entry('x') } });
    let newer = '';
    // Another build writes a newer lock while this update fetches the tree.
    mockBeforeTree.mockImplementation(() => {
      newer = writeLock({ version: 3, skills: {} });
    });
    mockHttpsGetBuffer.mockImplementation(() => skillFile('s'));
    jest.resetModules();
    const { updateSkill } = await import('../skill-service');

    expect((await updateSkill(SOURCE, 'x')).success).toBe(false);
    expect(
      fs.readFileSync(join(await nestedDir('x'), 'SKILL.md'), 'utf8'),
    ).toContain('name: x');
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(newer);
  }, 30_000);

  test('an uninstall against a refused lock keeps the skill folder and the lock', async () => {
    const newer = writeLock({ version: 3, skills: {} });
    writeSkill(await nestedDir('x'), 'x');
    jest.resetModules();
    const { removeSkill } = await import('../skill-service');

    expect(removeSkill(SOURCE, 'x').success).toBe(false);
    expect(fs.existsSync(join(await nestedDir('x'), 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(newer);
  }, 30_000);

  test('an installed plugin still counts when the lock is uncertain', async () => {
    writeLock('{ not json');
    jest.resetModules();
    jest.doMock('../../plugins/plugin-service', () => ({
      loadMarketplacesCacheOnly: (): Promise<unknown> =>
        Promise.resolve({
          success: true,
          data: {
            marketplaces: [
              {
                plugins: [
                  { globalInstallStatus: { claude: { installed: true } } },
                ],
              },
            ],
          },
        }),
    }));
    try {
      const { hasInstalledCapability } =
        await import('../../notifications/campaigns/installed-capability');
      await expect(hasInstalledCapability()).resolves.toBe(true);
    } finally {
      jest.dontMock('../../plugins/plugin-service');
    }
  });

  test('the capability probe does not count a version 1 migration that never committed', async () => {
    seedV1(['a']);
    jest.resetModules();
    jest.doMock(
      '@canopy/execution-engine/node/lib/atomic-file',
      (): typeof AtomicFile => ({
        ...jest.requireActual<typeof AtomicFile>(
          '@canopy/execution-engine/node/lib/atomic-file',
        ),
        writeFileAtomically: (): Promise<void> =>
          Promise.reject(new Error('disk full')),
      }),
    );
    try {
      const { hasInstalledCapability } =
        await import('../../notifications/campaigns/installed-capability');
      await expect(hasInstalledCapability()).rejects.toThrow(
        'Installed skills could not be read.',
      );
    } finally {
      await (await import('../lock-file')).skillLockMigrationSettled();
      jest.dontMock('@canopy/execution-engine/node/lib/atomic-file');
    }
  }, 30_000);

  test('a damaged lock counts as uncertain for capability campaigns', async () => {
    writeLock('{ not json');
    jest.resetModules();
    const { hasInstalledCapability } =
      await import('../../notifications/campaigns/installed-capability');

    await expect(hasInstalledCapability()).rejects.toThrow(
      'Installed skills could not be read.',
    );
  }, 30_000);
});

describe('v1 directory and source-metadata migration', () => {
  test('moves every directory, writes source metadata, commits v2 and removes its backup', async () => {
    seedV1(['a', 'b']);
    const lock = await loadLock();

    expect(Object.keys(lock.readLockFile().skills).sort()).toEqual([
      `${SOURCE}/a`,
      `${SOURCE}/b`,
    ]);
    expect(fs.existsSync(join(await nestedDir('a'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(flatDir('a'))).toBe(false);
    await lock.skillLockMigrationSettled();
    const { getSourceMetadataPath } = await import('../paths');
    expect(
      JSON.parse(fs.readFileSync(getSourceMetadataPath(SOURCE), 'utf8')),
    ).toMatchObject({ type: 'github', owner: 'o', repo: 'r' });
    expect(storedLock().version).toBe(2);
    expect(setAside('v1')).toEqual([]);
  });

  test.each([0, 1, 2])(
    'an exit after %i of 3 moves resumes to the same v2 lock',
    async (moved) => {
      const names = ['a', 'b', 'c'];
      const v1 = seedV1(names);
      fs.copyFileSync(lockPath(), `${lockPath()}.v1`);
      for (const name of names.slice(0, moved)) {
        const target = await nestedDir(name);
        fs.mkdirSync(join(target, '..'), { recursive: true });
        fs.renameSync(flatDir(name), target);
      }
      expect(fs.readFileSync(lockPath(), 'utf8')).toBe(v1);
      const lock = await loadLock();

      expect(Object.keys(lock.readLockFile().skills).sort()).toEqual(
        names.map((name) => `${SOURCE}/${name}`),
      );
      for (const name of names)
        expect(fs.existsSync(join(await nestedDir(name), 'SKILL.md'))).toBe(
          true,
        );
      await lock.skillLockMigrationSettled();
      expect(setAside('v1')).toEqual([]);
    },
    30_000,
  );

  test('a version 1 entry whose folder is gone still migrates', async () => {
    writeLock({ version: 1, skills: { gone: entry('gone') } });
    const lock = await loadLock();

    expect(Object.keys(lock.readLockFile().skills)).toEqual([`${SOURCE}/gone`]);
    await lock.skillLockMigrationSettled();
    expect(storedLock().version).toBe(2);
  });

  test('an unconfirmed flush during migration keeps the version 1 backup', async () => {
    seedV1(['a']);
    jest.resetModules();
    const atomic =
      await import('@canopy/execution-engine/node/lib/atomic-file');
    const { StorageOutcomeUnknownError } =
      await import('@canopy/core-runtime/storage');
    const actual = atomic.writeFileAtomically;
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(
        async (...args: Parameters<typeof actual>): Promise<void> => {
          await actual(...args);
          if (String(args[0]).endsWith('source.json'))
            throw new StorageOutcomeUnknownError(
              'directory_flush',
              new Error('injected'),
            );
        },
      );
    const lock = await import('../lock-file');

    expect(Object.keys(lock.readLockFile().skills)).toEqual([`${SOURCE}/a`]);
    await lock.skillLockMigrationSettled();
    expect(storedLock().version).toBe(2);
    expect(setAside('v1')).toHaveLength(1);
  });

  test('an exit after a partial source metadata write rewrites it on resume', async () => {
    seedV1(['a']);
    const target = await nestedDir('a');
    fs.mkdirSync(join(target, '..'), { recursive: true });
    fs.renameSync(flatDir('a'), target);
    const { getSourceMetadataPath } = await import('../paths');
    fs.writeFileSync(getSourceMetadataPath(SOURCE), '{"ty');
    const lock = await loadLock();

    expect(Object.keys(lock.readLockFile().skills)).toEqual([`${SOURCE}/a`]);
    await lock.skillLockMigrationSettled();
    expect(
      JSON.parse(fs.readFileSync(getSourceMetadataPath(SOURCE), 'utf8')),
    ).toMatchObject({ type: 'github', sourceId: SOURCE });
  });

  test('a destination that already exists refuses the migration, keeps v1 and moves nothing', async () => {
    const v1 = seedV1(['a', 'b']);
    writeSkill(await nestedDir('b'), 'b-other');
    const lock = await loadLock();

    expect(lock.readLockFile().skills).toEqual({});
    expect(
      thrownCode(() =>
        lock.addLockEntry(SOURCE, 'z', { ...entry('z'), sourceId: SOURCE }),
      ),
    ).toBe('migration-conflict');
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(v1);
    expect(fs.existsSync(join(flatDir('a'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(join(flatDir('b'), 'SKILL.md'))).toBe(true);
  });

  test('a migration that fails part way keeps v1, refuses writes, then resumes', async () => {
    writeSkill(flatDir('a'), 'a');
    writeSkill(flatDir('b'), 'b');
    const v1 = writeLock({
      version: 1,
      skills: { a: entry('a'), b: entry('b', 'p/q') },
    });
    jest.resetModules();
    // The second skill's move keeps failing; the first one has moved.
    jest.doMock('fs', (): typeof fs => {
      const actual = jest.requireActual<typeof fs>('fs');
      return {
        ...actual,
        renameSync: (...args: Parameters<typeof fs.renameSync>): void => {
          if (args[0] === flatDir('b'))
            throw new Error('injected move failure');
          actual.renameSync(...args);
        },
      };
    });
    try {
      const lock = await import('../lock-file');
      expect(lock.readLockFile().skills).toEqual({});
      expect(
        thrownCode(() =>
          lock.addLockEntry(SOURCE, 'z', { ...entry('z'), sourceId: SOURCE }),
        ),
      ).toBe('migration-failed');
    } finally {
      jest.dontMock('fs');
    }
    const { getSkillDir } = await import('../paths');
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(v1);
    expect(fs.existsSync(join(getSkillDir(SOURCE, 'a'), 'SKILL.md'))).toBe(
      true,
    );
    expect(fs.existsSync(join(flatDir('b'), 'SKILL.md'))).toBe(true);

    const restarted = await loadLock();
    expect(Object.keys(restarted.readLockFile().skills).sort()).toEqual([
      `${SOURCE}/a`,
      'github:p:q/b',
    ]);
    await restarted.skillLockMigrationSettled();
    expect(setAside('v1')).toEqual([]);
  }, 30_000);

  test('a competing install during an interrupted migration keeps every v1 entry', async () => {
    seedV1(['a', 'b']);
    const target = await nestedDir('a');
    fs.mkdirSync(join(target, '..'), { recursive: true });
    fs.renameSync(flatDir('a'), target);
    const lock = await loadLock();

    try {
      lock.addLockEntry(SOURCE, 'z', { ...entry('z'), sourceId: SOURCE });
      expect(Object.keys(lock.readLockFile().skills).sort()).toEqual([
        `${SOURCE}/a`,
        `${SOURCE}/b`,
        `${SOURCE}/z`,
      ]);
    } finally {
      await lock.skillLockMigrationSettled();
    }
  });

  test('the startup read that finds a version 1 lock makes no synchronous durable write', async () => {
    seedV1(['a', 'b']);
    jest.resetModules();
    const atomic =
      await import('@canopy/execution-engine/node/lib/atomic-file');
    const syncWrite = jest.spyOn(atomic, 'writeFileAtomicallySync');
    const lock = await import('../lock-file');

    expect(Object.keys(lock.readLockFile().skills).sort()).toEqual([
      `${SOURCE}/a`,
      `${SOURCE}/b`,
    ]);
    expect(syncWrite).not.toHaveBeenCalled();
    await lock.skillLockMigrationSettled();
    expect(storedLock().version).toBe(2);
    expect(setAside('v1')).toEqual([]);
  });

  test('a read while the migration writes sees every migrated skill, never part of them', async () => {
    const names = ['a', 'b', 'c'];
    const v1 = seedV1(names);
    const lock = await loadLock();
    const migrated = names.map((name) => `${SOURCE}/${name}`);

    expect(Object.keys(lock.readLockFile().skills).sort()).toEqual(migrated);
    // The durable writes are still running: v1 is the record on disk.
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(v1);
    expect(Object.keys(lock.readLockFile().skills).sort()).toEqual(migrated);
    for (const name of names) {
      expect(fs.existsSync(join(await nestedDir(name), 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(flatDir(name))).toBe(false);
    }
    await lock.skillLockMigrationSettled();
    expect(Object.keys(storedLock().skills).sort()).toEqual(migrated);
  });

  test('a lock write while the migration writes finishes it first and keeps its own entry', async () => {
    seedV1(['a', 'b']);
    const lock = await loadLock();
    lock.readLockFile();

    lock.addLockEntry(SOURCE, 'z', { ...entry('z'), sourceId: SOURCE });
    const all = [`${SOURCE}/a`, `${SOURCE}/b`, `${SOURCE}/z`];
    expect(Object.keys(storedLock().skills).sort()).toEqual(all);
    await lock.skillLockMigrationSettled();
    expect(storedLock().version).toBe(2);
    expect(Object.keys(storedLock().skills).sort()).toEqual(all);
    expect(setAside('v1')).toEqual([]);
  });

  describe('a migration interrupted at each durable write', () => {
    function seedTwoSources(): string {
      writeSkill(flatDir('a'), 'a');
      writeSkill(flatDir('b'), 'b');
      return writeLock({
        version: 1,
        skills: { a: entry('a'), b: entry('b', 'p/q') },
      });
    }

    function tree(): Record<string, string> {
      const files: Record<string, string> = {};
      const walk = (dir: string): void => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, item.name);
          if (item.isDirectory()) walk(full);
          else
            files[full.slice(skillsDir().length)] = fs.readFileSync(
              full,
              'utf8',
            );
        }
      };
      walk(skillsDir());
      return files;
    }

    async function uninterrupted(): Promise<Record<string, string>> {
      seedTwoSources();
      const lock = await loadLock();
      lock.readLockFile();
      await lock.skillLockMigrationSettled();
      const result = tree();
      fs.rmSync(skillsDir(), { recursive: true, force: true });
      return result;
    }

    const crashed = (): Error => new Error('the process exited');

    test.each([
      ['after the folder moves, before any durable write', 'every'],
      ['part way through the batch', 'second-source'],
      ['after the batch, before the version 2 lock', 'lock'],
    ])(
      'an exit %s resumes from v1 to the same final state',
      async (_point, crashAt) => {
        const expected = await uninterrupted();
        const v1 = seedTwoSources();
        jest.resetModules();
        const atomic =
          await import('@canopy/execution-engine/node/lib/atomic-file');
        const actual = atomic.writeFileAtomically;
        const actualSync = atomic.writeFileAtomicallySync;
        const { getSourceMetadataPath } = await import('../paths');
        const secondSource = getSourceMetadataPath('github:p:q');
        let faults = 0;
        jest
          .spyOn(atomic, 'writeFileAtomically')
          .mockImplementation(
            async (...args: Parameters<typeof actual>): Promise<void> => {
              const target = String(args[0]);
              if (
                crashAt === 'every' ||
                (crashAt === 'second-source' && target === secondSource)
              ) {
                faults += 1;
                throw crashed();
              }
              await actual(...args);
            },
          );
        jest
          .spyOn(atomic, 'writeFileAtomicallySync')
          .mockImplementation(
            (...args: Parameters<typeof actualSync>): void => {
              if (crashAt === 'lock' && String(args[0]) === lockPath()) {
                faults += 1;
                throw crashed();
              }
              actualSync(...args);
            },
          );
        const lock = await import('../lock-file');
        lock.readLockFile();
        await lock.skillLockMigrationSettled();

        expect(faults).toBeGreaterThan(0);
        // The version 1 lock is still the record wherever the exit came.
        expect(fs.readFileSync(lockPath(), 'utf8')).toBe(v1);
        jest.restoreAllMocks();
        const restarted = await loadLock();
        expect(Object.keys(restarted.readLockFile().skills).sort()).toEqual([
          `${SOURCE}/a`,
          'github:p:q/b',
        ]);
        await restarted.skillLockMigrationSettled();
        expect(tree()).toEqual(expected);
      },
      30_000,
    );
  });

  test('names that would leave the skills folder are not migrated', async () => {
    seedV1(['a']);
    const raw = storedLock();
    Object.assign(raw.skills, { '..': entry('..') });
    writeLock(raw);
    const lock = await loadLock();

    try {
      expect(Object.keys(lock.readLockFile().skills)).toEqual([`${SOURCE}/a`]);
    } finally {
      await lock.skillLockMigrationSettled();
    }
  });

  test('a version 1 skill named like the source metadata file is kept aside and the rest migrate', async () => {
    seedV1(['a', 'source.json']);
    const lock = await loadLock();

    expect(Object.keys(lock.readLockFile().skills)).toEqual([`${SOURCE}/a`]);
    await lock.skillLockMigrationSettled();
    expect(storedLock().version).toBe(2);
    expect(fs.existsSync(join(flatDir('source.json'), 'SKILL.md'))).toBe(true);
    const { getSourceMetadataPath } = await import('../paths');
    expect(
      JSON.parse(fs.readFileSync(getSourceMetadataPath(SOURCE), 'utf8')),
    ).toMatchObject({ type: 'github', sourceId: SOURCE });
    // The skipped skill's source and revision stay recorded in the v1 backup.
    const backup: unknown = JSON.parse(
      fs.readFileSync(`${lockPath()}.v1`, 'utf8'),
    );
    expect(backup).toMatchObject({
      skills: {
        'source.json': { source: 'o/r', skillFolderHash: 'hash-source.json' },
      },
    });
  });

  test('a backup left by an earlier version 1 lock is replaced by the lock being migrated', async () => {
    seedV1(['a', 'source.json']);
    fs.writeFileSync(`${lockPath()}.v1`, '{"version":1,"skills":{}}');
    const lock = await loadLock();
    lock.readLockFile();
    await lock.skillLockMigrationSettled();

    const backup: unknown = JSON.parse(
      fs.readFileSync(`${lockPath()}.v1`, 'utf8'),
    );
    expect(backup).toMatchObject({
      skills: { 'source.json': { source: 'o/r' } },
    });
  });

  test('a source.json skill an earlier attempt moved onto the metadata path goes back and the rest migrate', async () => {
    seedV1(['a', 'source.json']);
    const reserved = await nestedDir('source.json');
    fs.mkdirSync(join(reserved, '..'), { recursive: true });
    fs.renameSync(flatDir('source.json'), reserved);
    const lock = await loadLock();

    expect(Object.keys(lock.readLockFile().skills)).toEqual([`${SOURCE}/a`]);
    await lock.skillLockMigrationSettled();
    expect(storedLock().version).toBe(2);
    expect(fs.existsSync(join(flatDir('source.json'), 'SKILL.md'))).toBe(true);
    const { getSourceMetadataPath } = await import('../paths');
    expect(
      JSON.parse(fs.readFileSync(getSourceMetadataPath(SOURCE), 'utf8')),
    ).toMatchObject({ type: 'github', sourceId: SOURCE });
  });

  test('a source.json skill still flat beside metadata an earlier attempt wrote migrates the rest', async () => {
    seedV1(['a', 'source.json']);
    const { getSourceDir, getSourceMetadataPath } = await import('../paths');
    fs.mkdirSync(getSourceDir(SOURCE), { recursive: true });
    fs.writeFileSync(getSourceMetadataPath(SOURCE), '{"type":"github"}');
    const lock = await loadLock();

    expect(Object.keys(lock.readLockFile().skills)).toEqual([`${SOURCE}/a`]);
    await lock.skillLockMigrationSettled();
    expect(storedLock().version).toBe(2);
    expect(fs.existsSync(join(flatDir('source.json'), 'SKILL.md'))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(getSourceMetadataPath(SOURCE), 'utf8')),
    ).toMatchObject({ type: 'github', sourceId: SOURCE });
  });

  test('a source.json skill in both places refuses the migration and changes nothing', async () => {
    const v1 = seedV1(['a', 'source.json']);
    writeSkill(await nestedDir('source.json'), 'other');
    const lock = await loadLock();

    expect(lock.readLockFile().skills).toEqual({});
    expect(
      thrownCode(() =>
        lock.addLockEntry(SOURCE, 'z', { ...entry('z'), sourceId: SOURCE }),
      ),
    ).toBe('migration-conflict');
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(v1);
    expect(fs.existsSync(join(flatDir('a'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(join(flatDir('source.json'), 'SKILL.md'))).toBe(true);
  });

  test('a backup that cannot be removed after a write finished the migration still settles it', async () => {
    seedV1(['a']);
    jest.resetModules();
    jest.doMock('fs/promises', (): typeof FsPromises => ({
      ...jest.requireActual<typeof FsPromises>('fs/promises'),
      rm: (): Promise<void> =>
        Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })),
    }));
    try {
      const lock = await import('../lock-file');
      lock.readLockFile();
      lock.addLockEntry(SOURCE, 'z', { ...entry('z'), sourceId: SOURCE });

      await expect(lock.skillLockMigrationSettled()).resolves.toBeUndefined();
      const { readSkillLockSnapshot } = await import('../skill-lock-snapshot');
      expect((await readSkillLockSnapshot()).state).toBe('ok');
    } finally {
      jest.dontMock('fs/promises');
    }
  });

  test('a write whose first lock read fails briefly keeps its entry after the migration commits', async () => {
    seedV1(['a']);
    jest.resetModules();
    let busy = true;
    // The first migration attempt fails to move a folder; the next succeeds.
    jest.doMock('fs', (): typeof fs => {
      const actual = jest.requireActual<typeof fs>('fs');
      return {
        ...actual,
        renameSync: (...args: Parameters<typeof fs.renameSync>): void => {
          if (busy && args[0] === flatDir('a')) {
            busy = false;
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          }
          actual.renameSync(...args);
        },
      };
    });
    try {
      const lock = await import('../lock-file');
      lock.addLockEntry(SOURCE, 'z', { ...entry('z'), sourceId: SOURCE });
      await lock.skillLockMigrationSettled();

      const both = [`${SOURCE}/a`, `${SOURCE}/z`];
      expect(Object.keys(storedLock().skills).sort()).toEqual(both);
      expect(Object.keys(lock.readLockFile().skills).sort()).toEqual(both);
    } finally {
      jest.dontMock('fs');
    }
  });

  test('a lock another process writes during the migration flush survives the commit', async () => {
    seedV1(['a']);
    const lock = await loadLock();
    lock.readLockFile();

    const replacement = { [`${SOURCE}/other`]: entry('other') };
    writeLock({ version: 2, skills: replacement });
    await lock.skillLockMigrationSettled();
    expect(storedLock().skills).toEqual(replacement);
    expect(setAside('v1')).toHaveLength(1);
  });

  test('a newer lock another process writes during the migration flush is never downgraded', async () => {
    seedV1(['a']);
    const lock = await loadLock();
    lock.readLockFile();

    const newer = writeLock({ version: 3, skills: {} });
    expect(
      thrownCode(() =>
        lock.addLockEntry(SOURCE, 'z', { ...entry('z'), sourceId: SOURCE }),
      ),
    ).toBe('newer');
    await lock.skillLockMigrationSettled();
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(newer);
    expect(setAside('v1')).toHaveLength(1);
  });

  test('a revision snapshot during the migration waits for the migrated lock', async () => {
    seedV1(['a']);
    const lock = await loadLock();
    lock.readLockFile();
    const { readSkillLockSnapshot } = await import('../skill-lock-snapshot');

    const snapshot = await readSkillLockSnapshot();
    expect(snapshot.state === 'ok' && [...snapshot.entries.keys()]).toEqual([
      `${SOURCE}/a`,
    ]);
  });
});
