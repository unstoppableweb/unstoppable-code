// CAN-4484 golden: custom skill publication's local stores, qualified under
// their current owner, Electron main: the skills' share links, the
// cloud-copy consents and the custom skill save swap. It drives the real
// skill service and consent store on a data root the suite owns; only
// GitHub, the feature flags and logging are replaced. Each case starts a
// fresh module, as a restart does; a case that seeds a half-finished save
// reproduces what an exit leaves on disk.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { getDataDir, getPipelinePackagesDir } from '../../lib/paths';
import { computePipelinePackageDigestSync } from '@canopy/execution-engine/node/pipelines/package-contract';
import type {
  PipelinePackageManifestV1,
  PipelinePackageRef,
} from '@canopy/protocol/pipelines';
import type { CollectionConfig } from '@canopy/protocol/collections';
import type { SharedSkillDetail } from '@canopy/protocol/skills';
import type * as AtomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import type * as DamagedCopies from '@canopy/execution-engine/node/lib/damaged-copies';
import type * as FsPromises from 'node:fs/promises';
import type * as SkillMutations from '../skill-mutations';
import type * as NodeFs from 'node:fs';
import type * as InstallReceipts from '../../lib/resource-install-receipts';
import type * as LocalAtomicFile from '../../lib/atomic-file';
import type { PathLike as FsPathLike } from 'node:fs';
import type * as CloudClient from '../../canopy-cloud/client';
import type { ShareRemoteMetadata } from '@canopy/protocol/sharing';
import type {
  CloudCopyConsent,
  CloudCopyConsentStore,
} from '../cloud-copy-consents';

jest.mock('../skill-discovery', () => ({
  getGitHubToken: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../lib/http', () => ({
  httpsGetBuffer: (): Promise<Buffer> => Promise.reject(new Error('offline')),
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

const skillsDir = (): string => join(getDataDir(), 'skills');
const linksPath = (): string => join(skillsDir(), '.share-links.json');
const consentsPath = (): string =>
  join(skillsDir(), '.cloud-copy-consents.json');

const remote = (remoteId: string): ShareRemoteMetadata => ({
  accountId: 'acct',
  remoteId,
  contentHash: `hash-${remoteId}`,
  shareScope: 'private',
  sharedAt: '2026-11-01T00:00:00.000Z',
});

const consent = (remoteId: string): CloudCopyConsent => ({
  accountId: 'acct',
  remoteId,
  keepInStep: true,
  consentedAt: '2026-11-01T00:00:00.000Z',
  selectedOptionalResourceIds: [],
  files: [],
  withheld: [],
});

/** Not valid UTF-8, so only a byte-for-byte copy keeps it. */
const DAMAGED_BYTES = Buffer.from([0x7b, 0xff, 0xfe, 0x00, 0x22, 0xc3]);

/** Valid JSON whose `field` string holds a byte that isn't valid UTF-8. */
function withInvalidByte(json: string, marker: string): Buffer {
  const [before, after] = json.split(marker);
  return Buffer.concat([
    Buffer.from(before ?? ''),
    Buffer.from([0xff]),
    Buffer.from(after ?? ''),
  ]);
}

function storedLinks(): unknown {
  return JSON.parse(fs.readFileSync(linksPath(), 'utf8'));
}

function storedLinkIds(): string[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(linksPath(), 'utf8'));
  return typeof parsed === 'object' && parsed !== null
    ? Object.keys(parsed)
    : [];
}

function setAside(file: string): string[] {
  return fs
    .readdirSync(skillsDir())
    .filter((name) => name.startsWith(`${file}.damaged-`));
}

async function customDir(): Promise<string> {
  const { getSourceDir, CUSTOM_SOURCE_ID } = await import('../paths');
  return getSourceDir(CUSTOM_SOURCE_ID);
}

async function customId(name: string): Promise<string> {
  const { CUSTOM_SOURCE_ID } = await import('../paths');
  return `${CUSTOM_SOURCE_ID}/${name}`;
}

async function seedCustomSkill(name: string, body = 'Body'): Promise<string> {
  const dir = join(await customDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
  );
  return dir;
}

/** The id part of a folder a save generates, as `randomUUID()` names it. */
const SEEDED_ID = '00000000-0000-4000-8000-000000000000';

/** What an exit between a save's two renames leaves: the old copy aside. */
async function seedMovedAside(
  oldName: string,
  committed = false,
): Promise<string> {
  const holder = join(await customDir(), `.canopy-skill-swap-${SEEDED_ID}`);
  fs.mkdirSync(holder, { recursive: true });
  if (committed) fs.mkdirSync(join(holder, '.committed'));
  const old = join(holder, oldName);
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(
    join(old, 'SKILL.md'),
    `---\nname: ${oldName}\ndescription: ${oldName} skill\n---\n\nOld\n`,
  );
  return holder;
}

async function listedNames(): Promise<string[]> {
  const { loadSkills } = await import('../skill-service');
  const listed = loadSkills();
  if (!listed.success || !listed.data) throw new Error(listed.error);
  return listed.data.map((skill) => skill.name).sort();
}

const save = async (
  name: string,
  originalName?: string,
): Promise<{ success: boolean }> => {
  const { saveCustomSkill } = await import('../skill-service');
  return saveCustomSkill({
    name,
    description: `${name} skill`,
    body: 'New',
    ...(originalName ? { originalName } : {}),
  });
};

/**
 * Turns resource contexts on and binds `from` to a cloud install receipt,
 * as an installed shared skill has. Returns the receipts file and its bytes.
 */
function seedInstallReceipt(from: string): {
  receipts: string;
  before: object;
} {
  const receipts = join(getDataDir(), 'resource-install-receipts.json');
  const before = {
    version: 1,
    byAccount: {
      acct: [
        {
          localResourceIds: [from, 'custom:app/gone'],
          uninstalledLocalResourceIds: ['custom:app/gone'],
          localResourceRoles: { [from]: 'primary' },
          family: 'skills',
          remoteId: 'rs',
          shareScope: 'private',
          ownerContext: { kind: 'personal' },
          hash: 'h',
          authorizedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    },
  };
  fs.writeFileSync(receipts, JSON.stringify(before));
  jest.doMock('../resource-lanes', (): object => ({
    ...jest.requireActual<object>('../resource-lanes'),
    skillResourceContextEnabled: (): boolean => true,
    assertSkillContext: (): Promise<void> => Promise.resolve(),
  }));
  jest.doMock('../../lib/canopy-cloud-account-store', (): object => ({
    ...jest.requireActual<object>('../../lib/canopy-cloud-account-store'),
    readCanopyCloudAccountWithStatus: (): Promise<object> =>
      Promise.resolve({ status: 'ok', entry: { account: { id: 'acct' } } }),
  }));
  jest.doMock('../canopy-server-client', (): object => ({
    ...jest.requireActual<object>('../canopy-server-client'),
    getSharedSkill: (): Promise<object> =>
      Promise.resolve({ owner: { type: 'user', id: 'u', name: null } }),
  }));
  return { receipts, before };
}

/**
 * Runs recovery once with the process exiting on a move into `destination`
 * after `moved` entries got there, as a restore cut short after its claim
 * leaves things.
 */
async function interruptRestoreAt(
  destination: string,
  moved = 0,
): Promise<void> {
  let exited = false;
  let moves = 0;
  jest.doMock('node:fs/promises', (): object => {
    const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const alive = (): void => {
      if (exited) throw new Error('the process exited');
    };
    return {
      ...actual,
      mkdir: async (
        ...args: Parameters<typeof actual.mkdir>
      ): Promise<string | undefined> => {
        alive();
        return actual.mkdir(...args);
      },
      rmdir: async (
        ...args: Parameters<typeof actual.rmdir>
      ): Promise<void> => {
        alive();
        await actual.rmdir(...args);
      },
      rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
        alive();
        if (dirname(String(to)) === destination && moves++ === moved) {
          exited = true;
          throw new Error('the process exited');
        }
        await actual.rename(from, to);
      },
    };
  });
  await listedNames();
  const { runSkillMutation } = await import('../skill-mutations');
  await runSkillMutation(() => Promise.resolve());
  expect(exited).toBe(true);
  jest.dontMock('node:fs/promises');
  jest.resetModules();
}

/** Runs the recovery a listing queues, and waits for it. */
async function recoverNow(): Promise<void> {
  await listedNames();
  const { runSkillMutation } = await import('../skill-mutations');
  await runSkillMutation(() => Promise.resolve());
}

/** The share link the production listing attaches to each skill. */
async function listedRemotes(): Promise<Record<string, unknown>> {
  const { loadSkills } = await import('../skill-service');
  const listed = loadSkills();
  if (!listed.success || !listed.data) throw new Error(listed.error);
  return Object.fromEntries(
    listed.data.map((skill) => [skill.name, skill.remote ?? null]),
  );
}

/** Records the durable option of every atomic write to a matching path. */
function recordDurableWrites(matches: (path: string) => boolean): boolean[] {
  const durable: boolean[] = [];
  jest.doMock(
    '@canopy/execution-engine/node/lib/atomic-file',
    (): typeof AtomicFile => {
      const actual = jest.requireActual<typeof AtomicFile>(
        '@canopy/execution-engine/node/lib/atomic-file',
      );
      return {
        ...actual,
        writeFileAtomicallySync: (
          ...args: Parameters<typeof actual.writeFileAtomicallySync>
        ): void => {
          if (matches(String(args[0]))) durable.push(args[2]?.durable === true);
          actual.writeFileAtomicallySync(...args);
        },
      };
    },
  );
  return durable;
}

/** The store's next read of `target` fails with EIO; later reads succeed. */
function failNextRead(target: () => string): void {
  let failed = false;
  jest.doMock('node:fs', (): object => {
    const actual = jest.requireActual<typeof fs>('node:fs');
    const readFileSync = (
      ...args: Parameters<typeof actual.readFileSync>
    ): string | Buffer => {
      if (!failed && String(args[0]) === target()) {
        failed = true;
        throw Object.assign(new Error('i/o error'), { code: 'EIO' });
      }
      return actual.readFileSync(...args);
    };
    return { ...actual, readFileSync };
  });
}

/** Rewrites `target` just before its damaged copy is named. */
function changeBeforeCopy(target: () => string, bytes: Buffer): void {
  jest.doMock(
    '@canopy/execution-engine/node/lib/damaged-copies',
    (): typeof DamagedCopies => {
      const actual = jest.requireActual<typeof DamagedCopies>(
        '@canopy/execution-engine/node/lib/damaged-copies',
      );
      return {
        ...actual,
        damagedCopyPath: (...args): string => {
          if (args[0] === target()) fs.writeFileSync(target(), bytes);
          return actual.damagedCopyPath(...args);
        },
      };
    },
  );
}

// Own the data roots: never seed or delete files in an inherited directory.
const inheritedDirs = {
  CANOPY_DATA_DIR: process.env.CANOPY_DATA_DIR,
  CANOPY_SECURE_DATA_DIR: process.env.CANOPY_SECURE_DATA_DIR,
};
// Shared across reloads to cut per-case load time; no case mocks inside them.
const sharedBarrels = [
  '@canopy/core-runtime',
  '@canopy/core-platform',
  '@canopy/protocol/canopy-core',
];
const sharedCopies = new Map<string, object>();
let ownedRoot = '';
beforeAll(() => {
  for (const name of sharedBarrels)
    sharedCopies.set(name, jest.requireActual<object>(name));
  ownedRoot = fs.mkdtempSync(join(tmpdir(), 'can-4484-'));
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
  jest.resetModules();
  for (const name of sharedBarrels)
    jest.doMock(name, () => sharedCopies.get(name));
});

afterEach(() => {
  jest.dontMock('node:fs');
  jest.dontMock('@canopy/execution-engine/node/lib/damaged-copies');
  jest.dontMock('@canopy/execution-engine/node/lib/atomic-file');
  jest.dontMock('../../canopy-cloud/client');
  jest.dontMock('../canopy-server-client');
  jest.dontMock('../resource-lanes');
  jest.dontMock('../../lib/canopy-cloud-account-store');
  jest.dontMock('node:fs/promises');
  jest.dontMock('../../pipelines/canopy-server-client');
  jest.dontMock('../../lib/resource-install-receipts');
  jest.dontMock('../../lib/atomic-file');
  jest.dontMock('fs');
  jest.dontMock('../../collections/canopy-server-client');
  jest.dontMock('../skill-mutations');
});

describe('skill share links', () => {
  test('a damaged share-link store lists every skill with no share state', async () => {
    await seedCustomSkill('a');
    fs.writeFileSync(
      linksPath(),
      JSON.stringify({ [await customId('a')]: remote('r1') }),
    );
    expect(await listedRemotes()).toEqual({ a: remote('r1') });

    fs.writeFileSync(linksPath(), '{ not json');

    expect(await listedRemotes()).toEqual({ a: null });
  });

  test('a link written over a damaged store keeps a durable, exact copy and writes a fresh store', async () => {
    await seedCustomSkill('a');
    fs.writeFileSync(linksPath(), DAMAGED_BYTES);
    const copies = recordDurableWrites((path) =>
      path.startsWith(`${linksPath()}.damaged-`),
    );
    const { writeSkillRemoteMetadata } = await import('../skill-service');

    writeSkillRemoteMetadata(await customId('a'), remote('r1'));

    const [copy] = setAside('.share-links.json');
    expect(fs.readFileSync(join(skillsDir(), copy ?? ''))).toEqual(
      DAMAGED_BYTES,
    );
    expect(copies).toEqual([true]);
    expect(storedLinks()).toEqual({ [await customId('a')]: remote('r1') });
    expect(await listedRemotes()).toEqual({ a: remote('r1') });
  });

  test('an uninstall whose share-link store cannot be read keeps the skill folder', async () => {
    const dir = await seedCustomSkill('a');
    fs.mkdirSync(linksPath());
    const { removeSkill } = await import('../skill-service');
    const { CUSTOM_SOURCE_ID } = await import('../paths');

    expect(removeSkill(CUSTOM_SOURCE_ID, 'a').success).toBe(false);
    expect(fs.existsSync(join(dir, 'SKILL.md'))).toBe(true);
  });

  test('an uninstall whose link cannot be cleared keeps the skill folder and its link', async () => {
    const dir = await seedCustomSkill('a');
    const links = JSON.stringify({ [await customId('a')]: remote('r1') });
    fs.writeFileSync(linksPath(), links);
    jest.doMock(
      '@canopy/execution-engine/node/lib/atomic-file',
      (): typeof AtomicFile => {
        const actual = jest.requireActual<typeof AtomicFile>(
          '@canopy/execution-engine/node/lib/atomic-file',
        );
        return {
          ...actual,
          writeFileAtomicallySync: (
            ...args: Parameters<typeof actual.writeFileAtomicallySync>
          ): void => {
            if (String(args[0]) === linksPath())
              throw Object.assign(new Error('read-only'), { code: 'EROFS' });
            actual.writeFileAtomicallySync(...args);
          },
        };
      },
    );
    const { removeSkill } = await import('../skill-service');
    const { CUSTOM_SOURCE_ID } = await import('../paths');

    expect(removeSkill(CUSTOM_SOURCE_ID, 'a').success).toBe(false);
    expect(fs.existsSync(join(dir, 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(linksPath(), 'utf8')).toBe(links);
  });

  test('an uninstall clears the skill link and removes the folder', async () => {
    const dir = await seedCustomSkill('a');
    fs.writeFileSync(
      linksPath(),
      JSON.stringify({
        [await customId('a')]: remote('r1'),
        [await customId('b')]: remote('r2'),
      }),
    );
    const { removeSkill } = await import('../skill-service');
    const { CUSTOM_SOURCE_ID } = await import('../paths');

    expect(removeSkill(CUSTOM_SOURCE_ID, 'a').success).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(storedLinkIds()).toEqual([await customId('b')]);
    // The uninstall queues a shared-item flush; settle it before teardown.
    const { flushSharedItemSubscriptions } =
      await import('../../canopy-cloud/shared-item-subscriptions');
    await flushSharedItemSubscriptions();
  });

  test('a rename over a malformed store commits, moves no link and leaves the damaged file as it is', async () => {
    await seedCustomSkill('a');
    fs.writeFileSync(linksPath(), DAMAGED_BYTES);
    const { saveCustomSkill } = await import('../skill-service');

    const saved = await saveCustomSkill({
      name: 'b',
      description: 'b skill',
      body: 'Renamed',
      originalName: 'a',
    });

    expect(saved.success).toBe(true);
    expect(await listedRemotes()).toEqual({ b: null });
    expect(fs.readFileSync(linksPath())).toEqual(DAMAGED_BYTES);
    expect(setAside('.share-links.json')).toEqual([]);
  });

  test('a rename whose share-link store cannot be read is refused', async () => {
    const dir = await seedCustomSkill('a');
    fs.mkdirSync(linksPath());
    const { saveCustomSkill } = await import('../skill-service');

    const saved = await saveCustomSkill({
      name: 'b',
      description: 'b skill',
      body: 'Renamed',
      originalName: 'a',
    });

    expect(saved.success).toBe(false);
    expect(fs.existsSync(join(dir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(join(await customDir(), 'b'))).toBe(false);
  });

  test('the damaged share-link copy holds the bytes that were judged damaged', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(linksPath(), DAMAGED_BYTES);
    changeBeforeCopy(linksPath, Buffer.from('{}'));
    const { writeSkillRemoteMetadata } = await import('../skill-service');

    writeSkillRemoteMetadata(await customId('a'), remote('r1'));

    const [copy] = setAside('.share-links.json');
    expect(fs.readFileSync(join(skillsDir(), copy ?? ''))).toEqual(
      DAMAGED_BYTES,
    );
  });

  test('a store with invalid UTF-8 inside a string reads as damaged and is copied byte for byte', async () => {
    await seedCustomSkill('a');
    const bytes = withInvalidByte(
      JSON.stringify({
        [await customId('a')]: { ...remote('r1'), ownerName: 'MARK' },
      }),
      'MARK',
    );
    fs.writeFileSync(linksPath(), bytes);
    expect(await listedRemotes()).toEqual({ a: null });
    const { writeSkillRemoteMetadata } = await import('../skill-service');

    writeSkillRemoteMetadata(await customId('a'), remote('r2'));

    const [copy] = setAside('.share-links.json');
    expect(fs.readFileSync(join(skillsDir(), copy ?? ''))).toEqual(bytes);
  });

  test('share-link writes are durable', async () => {
    const durable = recordDurableWrites((path) => path === linksPath());
    const { writeSkillRemoteMetadata, clearSkillRemoteMetadataByRemoteId } =
      await import('../skill-service');

    writeSkillRemoteMetadata(await customId('a'), {
      remoteId: 'r1',
      contentHash: 'h',
      shareScope: 'private',
      sharedAt: '2026-11-01T00:00:00.000Z',
    });
    clearSkillRemoteMetadataByRemoteId('r1');

    expect(durable).toEqual([true, true]);
  });
});

describe('cloud-copy consents', () => {
  async function store(): Promise<CloudCopyConsentStore> {
    const { CloudCopyConsentStore } = await import('../cloud-copy-consents');
    return CloudCopyConsentStore.inSkillsRoot(skillsDir());
  }

  test('a damaged consents file reads as no consent', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(consentsPath(), '{ not json');

    expect((await store()).get('custom:app/a')).toBeNull();
  });

  test('a consent written over a damaged file keeps a durable, exact copy', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(consentsPath(), DAMAGED_BYTES);
    const copies = recordDurableWrites((path) =>
      path.startsWith(`${consentsPath()}.damaged-`),
    );
    const consents = await store();

    consents.set('custom:app/a', consent('r1'));

    const [copy] = setAside('.cloud-copy-consents.json');
    expect(fs.readFileSync(join(skillsDir(), copy ?? ''))).toEqual(
      DAMAGED_BYTES,
    );
    expect(copies).toEqual([true]);
    expect(consents.get('custom:app/a')).toEqual(consent('r1'));
  });

  test('an entry this version cannot read is carried through writes and never counts as consent', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    const unknown = { remoteId: 'r9', future: true };
    fs.writeFileSync(
      consentsPath(),
      JSON.stringify({ version: 1, entries: { 'custom:app/b': unknown } }),
    );
    const consents = await store();

    expect(consents.get('custom:app/b')).toBeNull();
    consents.set('custom:app/a', consent('r1'));
    consents.clearByRemoteId('r1');

    const stored: unknown = JSON.parse(fs.readFileSync(consentsPath(), 'utf8'));
    expect(stored).toEqual({
      version: 1,
      entries: { 'custom:app/b': unknown },
    });
  });

  test('removing a cloud copy also drops an entry for it this version cannot read', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    const other = { remoteId: 'r2', future: true };
    fs.writeFileSync(
      consentsPath(),
      JSON.stringify({
        version: 1,
        entries: {
          'custom:app/a': { remoteId: 'r1', future: true },
          'custom:app/b': other,
        },
      }),
    );

    (await store()).clearByRemoteId('r1');

    const stored: unknown = JSON.parse(fs.readFileSync(consentsPath(), 'utf8'));
    expect(stored).toEqual({ version: 1, entries: { 'custom:app/b': other } });
  });

  test('removing a cloud copy leaves a newer consents file as it is', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    const newer = JSON.stringify({
      version: 2,
      entries: { x: { remoteId: 'r1' } },
    });
    fs.writeFileSync(consentsPath(), newer);
    const consents = await store();

    expect(() => consents.clearByRemoteId('r1')).not.toThrow();
    expect(fs.readFileSync(consentsPath(), 'utf8')).toBe(newer);
    expect(() => consents.set('custom:app/a', consent('r1'))).toThrow();
  });

  test('a consent save over a file that could not be read is refused and changes nothing', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    const intact = Buffer.from(
      JSON.stringify({
        version: 1,
        entries: { 'custom:app/b': consent('r2') },
      }),
    );
    fs.writeFileSync(consentsPath(), intact);
    failNextRead(consentsPath);
    const consents = await store();

    expect(() => consents.set('custom:app/a', consent('r1'))).toThrow(
      "can't be read",
    );
    expect(fs.readFileSync(consentsPath())).toEqual(intact);
    expect(setAside('.cloud-copy-consents.json')).toEqual([]);
    expect(consents.get('custom:app/b')).toEqual(consent('r2'));
  });

  test('clearing consents over a file that could not be read is refused and changes nothing', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    const intact = Buffer.from(
      JSON.stringify({
        version: 1,
        entries: { 'custom:app/a': consent('r1') },
      }),
    );
    fs.writeFileSync(consentsPath(), intact);
    failNextRead(consentsPath);
    const consents = await store();

    expect(() => consents.clearByRemoteId('r1')).toThrow("can't be read");
    expect(fs.readFileSync(consentsPath())).toEqual(intact);
    expect(setAside('.cloud-copy-consents.json')).toEqual([]);
  });

  test('the damaged copy holds the bytes that were judged damaged, even if the file changed since', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(consentsPath(), DAMAGED_BYTES);
    changeBeforeCopy(consentsPath, Buffer.from('{"version":2,"entries":{}}'));
    const consents = await store();

    consents.set('custom:app/a', consent('r1'));

    const [copy] = setAside('.cloud-copy-consents.json');
    expect(fs.readFileSync(join(skillsDir(), copy ?? ''))).toEqual(
      DAMAGED_BYTES,
    );
  });

  test('a consents file with invalid UTF-8 inside a string reads as damaged and is copied byte for byte', async () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    const bytes = withInvalidByte(
      JSON.stringify({
        version: 1,
        entries: { 'custom:app/a': { ...consent('r1'), consentedAt: 'MARK' } },
      }),
      'MARK',
    );
    fs.writeFileSync(consentsPath(), bytes);
    const consents = await store();
    expect(consents.get('custom:app/a')).toBeNull();

    consents.set('custom:app/b', consent('r2'));

    const [copy] = setAside('.cloud-copy-consents.json');
    expect(fs.readFileSync(join(skillsDir(), copy ?? ''))).toEqual(bytes);
  });

  test('consent writes are durable', async () => {
    const durable = recordDurableWrites((path) => path === consentsPath());
    const consents = await store();

    consents.set('custom:app/a', consent('r1'));
    consents.clearByRemoteId('r1');

    expect(durable).toEqual([true, true]);
  });
});

describe('unpublish', () => {
  test('a consent write that fails keeps the link, and a retry clears both', async () => {
    await seedCustomSkill('a');
    fs.writeFileSync(
      linksPath(),
      JSON.stringify({ [await customId('a')]: remote('r1') }),
    );
    // An entry this version can't parse still goes with its cloud copy.
    fs.writeFileSync(
      consentsPath(),
      JSON.stringify({
        version: 1,
        entries: { [await customId('a')]: { remoteId: 'r1' } },
      }),
    );
    let consentWriteFails = true;
    jest.doMock(
      '@canopy/execution-engine/node/lib/atomic-file',
      (): typeof AtomicFile => {
        const actual = jest.requireActual<typeof AtomicFile>(
          '@canopy/execution-engine/node/lib/atomic-file',
        );
        return {
          ...actual,
          writeFileAtomicallySync: (
            ...args: Parameters<typeof actual.writeFileAtomicallySync>
          ): void => {
            if (consentWriteFails && String(args[0]) === consentsPath())
              throw Object.assign(new Error('read-only'), { code: 'EROFS' });
            actual.writeFileAtomicallySync(...args);
          },
        };
      },
    );
    // Only the account and the cloud are replaced; the copy is already gone.
    jest.doMock('../../canopy-cloud/client', (): object => ({
      ...jest.requireActual<object>('../../canopy-cloud/client'),
      resolveCanopyCloudCredentialContext: (): Promise<object> =>
        Promise.resolve({
          baseUrl: 'http://127.0.0.1:9',
          apiKey: 'test',
          account: { id: 'acct' },
        }),
    }));
    jest.doMock('../canopy-server-client', (): object => {
      const { CanopyCloudClientError } = jest.requireActual<typeof CloudClient>(
        '../../canopy-cloud/client',
      );
      return {
        ...jest.requireActual<object>('../canopy-server-client'),
        getSharedSkill: (): Promise<never> =>
          Promise.reject(new CanopyCloudClientError('http-error', 'gone', 404)),
      };
    });
    const { unpublishSkillFromCloud } =
      await import('../publish-skill-to-cloud');

    await expect(unpublishSkillFromCloud('r1', null)).rejects.toThrow(
      'read-only',
    );
    expect(storedLinkIds()).toEqual([await customId('a')]);

    consentWriteFails = false;
    await expect(unpublishSkillFromCloud('r1', null)).resolves.toBeUndefined();
    expect(storedLinkIds()).toEqual([]);
    expect(fs.readFileSync(consentsPath(), 'utf8')).not.toContain('r1');
  });
});

describe('custom skill save', () => {
  test('a save flushes the new copy and its folder before it reports success', async () => {
    await seedCustomSkill('a');
    const synced: string[] = [];
    jest.doMock(
      '@canopy/execution-engine/node/lib/atomic-file',
      (): typeof AtomicFile => {
        const actual = jest.requireActual<typeof AtomicFile>(
          '@canopy/execution-engine/node/lib/atomic-file',
        );
        return {
          ...actual,
          syncDirectory: async (dir: string): Promise<void> => {
            synced.push(dir);
            await actual.syncDirectory(dir);
          },
          syncTreeDurably: async (root: string): Promise<void> => {
            synced.push(`tree:${root}`);
            await actual.syncTreeDurably(root);
          },
        };
      },
    );

    expect((await save('a', 'a')).success).toBe(true);
    expect(synced.some((entry) => entry.startsWith('tree:'))).toBe(true);
    expect(synced).toContain(await customDir());
  });

  test('a save interrupted after the old copy moved aside is restored by the next save', async () => {
    const holder = await seedMovedAside('a');

    expect((await save('b')).success).toBe(true);
    expect(await listedNames()).toEqual(['a', 'b']);
    expect(
      fs.readFileSync(join(await customDir(), 'a', 'SKILL.md'), 'utf8'),
    ).toContain('Old');
    expect(fs.existsSync(holder)).toBe(false);
  });

  test('a rename interrupted after the old copy moved aside restores the old name', async () => {
    await seedMovedAside('a');

    expect((await save('b')).success).toBe(true);
    expect(await listedNames()).toEqual(['a', 'b']);
  });

  test('a committed save interrupted before its cleanup drops the old copy', async () => {
    await seedCustomSkill('renamed', 'New');
    const holder = await seedMovedAside('a', true);

    expect((await save('b')).success).toBe(true);
    expect(await listedNames()).toEqual(['b', 'renamed']);
    expect(fs.existsSync(holder)).toBe(false);
  });

  test('a save interrupted after the new copy moved in but before it committed restores the old copy and deletes nothing', async () => {
    // The saved copy at the new name, complete as the swap moved it in.
    const saved = await seedCustomSkill('renamed', 'Saved');
    fs.mkdirSync(join(saved, 'references'));
    fs.writeFileSync(join(saved, 'references', 'notes.md'), 'saved notes');
    const savedSkill = fs.readFileSync(join(saved, 'SKILL.md'), 'utf8');
    await seedMovedAside('a');

    expect((await save('b')).success).toBe(true);
    expect(await listedNames()).toEqual(['a', 'b', 'renamed']);
    expect(fs.readFileSync(join(saved, 'SKILL.md'), 'utf8')).toBe(savedSkill);
    expect(fs.readFileSync(join(saved, 'references', 'notes.md'), 'utf8')).toBe(
      'saved notes',
    );
    expect(
      fs.readFileSync(join(await customDir(), 'a', 'SKILL.md'), 'utf8'),
    ).toContain('Old');
  });

  test('recovery never deletes a skill another writer saved at the interrupted target name', async () => {
    await seedMovedAside('a');
    await seedCustomSkill('b', 'Claimed later');

    await listedNames();
    const { runSkillMutation } = await import('../skill-mutations');
    await runSkillMutation(() => Promise.resolve());

    expect(await listedNames()).toEqual(['a', 'b']);
    expect(
      fs.readFileSync(join(await customDir(), 'b', 'SKILL.md'), 'utf8'),
    ).toContain('Claimed later');
  });

  test('an uncommitted swap whose old name is taken is kept aside and both copies stay', async () => {
    await seedCustomSkill('a', 'New');
    await seedMovedAside('a');

    expect((await save('b')).success).toBe(true);
    expect(await listedNames()).toEqual(['a', 'b']);
    const kept = fs
      .readdirSync(await customDir())
      .filter((name) => name.startsWith('.canopy-skill-kept-'));
    expect(kept).toHaveLength(1);
    expect(
      fs.readFileSync(
        join(await customDir(), kept[0] ?? '', 'a', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Old');
  });

  // Every name a package install refuses is one Windows can't create as a
  // single folder, so this case runs where the filesystem allows it.
  const refusedNameTest = process.platform === 'win32' ? test.skip : test;
  refusedNameTest(
    'recovery never restores a folder under a name a package install would refuse',
    async () => {
      await seedMovedAside('bad\\name');

      expect((await save('b')).success).toBe(true);
      expect(fs.existsSync(join(await customDir(), 'bad\\name'))).toBe(false);
      expect(await listedNames()).toEqual(['b']);
    },
  );

  test('recovery restores an installed skill whose name a custom save would refuse', async () => {
    await seedMovedAside('Build_Helper');

    expect((await save('b')).success).toBe(true);
    expect(await listedNames()).toEqual(['Build_Helper', 'b']);
    expect(
      fs.readFileSync(
        join(await customDir(), 'Build_Helper', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Old');
  });

  test('a committed swap left part deleted never brings the old name back', async () => {
    await seedCustomSkill('renamed', 'New');
    const trash = join(await customDir(), `.canopy-skill-trash-${SEEDED_ID}`);
    fs.mkdirSync(join(trash, 'a'), { recursive: true });
    fs.writeFileSync(join(trash, 'a', 'SKILL.md'), 'half deleted');

    expect((await save('b')).success).toBe(true);
    expect(await listedNames()).toEqual(['b', 'renamed']);
    expect(fs.existsSync(trash)).toBe(false);
  });

  test('a first save whose folder flush fails leaves no skill, and a retry saves it', async () => {
    const custom = await customDir();
    let fail = true;
    jest.doMock(
      '@canopy/execution-engine/node/lib/atomic-file',
      (): typeof AtomicFile => {
        const actual = jest.requireActual<typeof AtomicFile>(
          '@canopy/execution-engine/node/lib/atomic-file',
        );
        return {
          ...actual,
          syncDirectory: async (dir: string): Promise<void> => {
            if (fail && dir === custom)
              throw Object.assign(new Error('flush failed'), { code: 'EIO' });
            await actual.syncDirectory(dir);
          },
        };
      },
    );

    expect((await save('n')).success).toBe(false);
    expect(fs.existsSync(join(custom, 'n'))).toBe(false);
    fail = false;
    expect((await save('n')).success).toBe(true);
    expect(await listedNames()).toEqual(['n']);
  });

  test('listing restores a moved-aside copy without waiting for a save', async () => {
    await seedMovedAside('a');
    const { runSkillMutation } = await import('../skill-mutations');

    await listedNames();
    await runSkillMutation(() => Promise.resolve());

    expect(await listedNames()).toEqual(['a']);
  });

  test('staging an exit left behind is removed by the next save', async () => {
    const stage = join(await customDir(), `.canopy-skill-stage-${SEEDED_ID}`);
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(join(stage, 'SKILL.md'), 'partial');

    expect((await save('b')).success).toBe(true);
    expect(fs.existsSync(stage)).toBe(false);
  });

  test.each(['.canopy-skill-swap-x', '.canopy-skill-kept-x', '.hidden'])(
    'a package install refuses the reserved skill folder name %s before writing anything',
    async (reserved) => {
      const { installSkillCapabilityPackage } =
        await import('../skill-package-install');

      await expect(
        installSkillCapabilityPackage({
          remoteId: 'r1',
          skillName: reserved,
          primaryRootName: 'x',
          packageRef: { version: 1, digest: 'sha256:0' },
        }),
      ).rejects.toThrow('Invalid skillName');
      expect(fs.existsSync(join(await customDir(), reserved))).toBe(false);
    },
  );

  test('an interrupted earlier install in a dot-prefixed folder is still cleaned up', async () => {
    const folder = join(await customDir(), '.earlier-install');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(join(folder, 'SKILL.md'), 'packaged');
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update('packaged').digest('hex');
    const { removeMaterializedSkillFolder } =
      await import('../skill-package-install');

    await expect(
      removeMaterializedSkillFolder('.earlier-install', [
        { path: 'SKILL.md', sha256 },
      ]),
    ).resolves.toBe('removed');
    expect(fs.existsSync(folder)).toBe(false);
  });

  test('a backup in the earlier layout is kept for a person to recover', async () => {
    const legacy = join(await customDir(), '.canopy-skill-backup-legacy');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(join(legacy, 'SKILL.md'), 'old copy');

    expect((await save('b')).success).toBe(true);
    expect(fs.readFileSync(join(legacy, 'SKILL.md'), 'utf8')).toBe('old copy');
  });
  test('a rename whose commit marker fails gives the install receipt back', async () => {
    await seedCustomSkill('a', 'Old');
    const from = await customId('a');
    const to = await customId('b');
    const { receipts, before } = seedInstallReceipt(from);
    let markerFaults = 0;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          if (String(args[0]).endsWith('.committed')) {
            markerFaults++;
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          }
          return actual.mkdir(...args);
        },
      };
    });

    expect((await save('b', 'a')).success).toBe(false);
    expect(markerFaults).toBe(1);
    expect(await listedNames()).toEqual(['a']);
    const after: unknown = JSON.parse(fs.readFileSync(receipts, 'utf8'));
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(to);
  });

  test('a rename whose commit marker fails puts the original back in place, whole', async () => {
    const original = await seedCustomSkill('a', 'Old');
    fs.writeFileSync(join(original, 'notes.md'), 'old notes');
    const skill = fs.readFileSync(join(original, 'SKILL.md'), 'utf8');
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          if (String(args[0]).endsWith('.committed'))
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          return actual.mkdir(...args);
        },
      };
    });

    expect((await save('b', 'a')).success).toBe(false);
    // Restored by the save itself, not left for recovery.
    expect(
      fs
        .readdirSync(await customDir())
        .filter((entry) => entry.startsWith('.canopy-skill-')),
    ).toEqual([]);
    expect(fs.readFileSync(join(original, 'SKILL.md'), 'utf8')).toBe(skill);
    expect(fs.readFileSync(join(original, 'notes.md'), 'utf8')).toBe(
      'old notes',
    );
  });

  test('a rename whose commit marker fails puts back an original holding a symlink', async () => {
    const original = await seedCustomSkill('a', 'Old');
    const target = join(ownedRoot, 'shared-ref.md');
    fs.writeFileSync(target, 'shared');
    fs.symlinkSync(target, join(original, 'ref.md'));
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          if (String(args[0]).endsWith('.committed'))
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          return actual.mkdir(...args);
        },
      };
    });

    expect((await save('b', 'a')).success).toBe(false);
    jest.dontMock('node:fs/promises');
    expect(await listedNames()).toEqual(['a']);
    const { runSkillMutation } = await import('../skill-mutations');
    await runSkillMutation(() => Promise.resolve());
    expect(fs.readlinkSync(join(original, 'ref.md'))).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe('shared');
    expect(
      fs
        .readdirSync(await customDir())
        .filter((entry) => entry.startsWith('.canopy-skill-')),
    ).toEqual([]);
  });

  test('a restore moves the main file last whatever its case', async () => {
    const holder = await seedMovedAside('a');
    const moved = join(holder, 'a');
    fs.rmSync(join(moved, 'SKILL.md'));
    fs.writeFileSync(join(moved, 'skill.md'), 'main');
    fs.writeFileSync(join(moved, 'zz-notes.md'), 'notes');
    const order: string[] = [];
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
          if (String(from).startsWith(`${moved}${sep}`))
            order.push(basename(String(from)));
          await actual.rename(from, to);
        },
      };
    });

    await recoverNow();
    expect(order).toEqual(['zz-notes.md', 'skill.md']);
  });

  test('an install that reserves the original name during a failed commit rollback never takes the original', async () => {
    const original = await seedCustomSkill('a', 'Old');
    fs.writeFileSync(join(original, 'notes.md'), 'old notes');
    const skill = fs.readFileSync(join(original, 'SKILL.md'), 'utf8');
    // A package install reserves with a plain mkdir and, on failure, removes
    // what it reserved.
    let installerOwns = false;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          if (String(args[0]).endsWith('.committed'))
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          return actual.mkdir(...args);
        },
        rename: async (
          ...args: Parameters<typeof actual.rename>
        ): Promise<void> => {
          await actual.rename(...args);
          // The failed copy has just left: the original name is free.
          if (String(args[1]).includes('.canopy-skill-trash-')) {
            fs.mkdirSync(original);
            installerOwns = true;
          }
        },
      };
    });

    expect((await save('b', 'a')).success).toBe(false);
    expect(installerOwns).toBe(true);
    // The install fails and rolls back what it reserved.
    fs.rmSync(original, { recursive: true, force: true });
    jest.dontMock('node:fs/promises');
    await listedNames();
    const { runSkillMutation } = await import('../skill-mutations');
    await runSkillMutation(() => Promise.resolve());
    expect(fs.readFileSync(join(original, 'SKILL.md'), 'utf8')).toBe(skill);
    expect(fs.readFileSync(join(original, 'notes.md'), 'utf8')).toBe(
      'old notes',
    );
  });

  test('recovery never follows a symlink out of the skills folder', async () => {
    const outside = join(ownedRoot, 'outside');
    const linkedSwap = join(outside, 'swap');
    fs.mkdirSync(join(linkedSwap, 'a'), { recursive: true });
    fs.writeFileSync(join(linkedSwap, 'a', 'SKILL.md'), 'outside');
    const linkedSource = join(outside, 'source');
    fs.mkdirSync(join(linkedSource, `.canopy-skill-trash-${SEEDED_ID}`), {
      recursive: true,
    });
    const custom = await customDir();
    fs.mkdirSync(custom, { recursive: true });
    fs.symlinkSync(linkedSwap, join(custom, `.canopy-skill-swap-${SEEDED_ID}`));

    // A swap entry that links out is left alone.
    await listedNames();
    const { runSkillMutation } = await import('../skill-mutations');
    await runSkillMutation(() => Promise.resolve());
    expect(fs.readFileSync(join(linkedSwap, 'a', 'SKILL.md'), 'utf8')).toBe(
      'outside',
    );
    expect(fs.existsSync(join(custom, 'a'))).toBe(false);

    // So is a custom source folder that is itself a link.
    fs.rmSync(custom, { recursive: true, force: true });
    fs.symlinkSync(linkedSource, custom);
    await listedNames();
    await runSkillMutation(() => Promise.resolve());
    expect(
      fs.existsSync(join(linkedSource, `.canopy-skill-trash-${SEEDED_ID}`)),
    ).toBe(true);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('an install that reserves the old name while recovery restores it never gets the restored copy', async () => {
    await seedMovedAside('a');
    const destination = join(await customDir(), 'a');
    // A package install reserves with a plain mkdir and, on failure, removes
    // what it reserved.
    let installerOwns = false;
    let raced = false;
    const install = (): void => {
      if (raced) return;
      raced = true;
      try {
        fs.mkdirSync(destination);
        installerOwns = true;
      } catch {
        installerOwns = false;
      }
    };
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        lstat: async (
          ...args: Parameters<typeof actual.lstat>
        ): Promise<unknown> => {
          try {
            return await actual.lstat(...args);
          } finally {
            if (String(args[0]) === destination) install();
          }
        },
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          try {
            return await actual.mkdir(...args);
          } finally {
            if (String(args[0]) === destination) install();
          }
        },
      };
    });

    expect((await save('b')).success).toBe(true);
    expect(raced).toBe(true);
    // The install fails and rolls back what it reserved.
    if (installerOwns) fs.rmSync(destination, { recursive: true, force: true });
    jest.dontMock('node:fs/promises');
    const custom = await customDir();
    const copies = fs
      .readdirSync(custom, { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith('SKILL.md'))
      .map((entry) => fs.readFileSync(join(custom, entry), 'utf8'));
    expect(copies.some((text) => text.includes('Old'))).toBe(true);
  });

  test('a restore whose move fails part way deletes nothing and finishes on the next run', async () => {
    const holder = await seedMovedAside('a');
    fs.writeFileSync(join(holder, 'a', 'notes.md'), 'old notes');
    const skill = fs.readFileSync(join(holder, 'a', 'SKILL.md'), 'utf8');
    const destination = join(await customDir(), 'a');
    let moved = 0;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
          // One entry moves; the second fails.
          if (dirname(String(to)) === destination && ++moved === 2)
            throw Object.assign(new Error('i/o error'), { code: 'EIO' });
          await actual.rename(from, to);
        },
      };
    });

    expect((await save('b')).success).toBe(true);
    expect(moved).toBe(2);
    jest.dontMock('node:fs/promises');
    jest.resetModules();
    // One entry is at the old name and one still waits in the swap.
    expect(fs.readdirSync(destination)).toHaveLength(1);

    expect((await save('c')).success).toBe(true);
    expect(await listedNames()).toEqual(['a', 'b', 'c']);
    expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(skill);
    expect(fs.readFileSync(join(destination, 'notes.md'), 'utf8')).toBe(
      'old notes',
    );
    expect(fs.existsSync(holder)).toBe(false);
  }, 30_000);

  test('recovery leaves a folder it did not create, even one named like its staging', async () => {
    const custom = await customDir();
    const userFolders = [
      '.canopy-skill-stage-report',
      '.canopy-skill-trash-notes',
    ];
    for (const name of userFolders) {
      fs.mkdirSync(join(custom, name), { recursive: true });
      fs.writeFileSync(join(custom, name, 'SKILL.md'), 'user files');
    }

    expect((await save('b')).success).toBe(true);
    for (const name of userFolders)
      expect(fs.readFileSync(join(custom, name, 'SKILL.md'), 'utf8')).toBe(
        'user files',
      );
  });

  test('a failed rename never restores a link cleared while it ran', async () => {
    await seedCustomSkill('a', 'Old');
    fs.writeFileSync(
      linksPath(),
      JSON.stringify({ [await customId('a')]: remote('ra') }),
    );
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          if (String(args[0]).endsWith('.committed')) {
            // The cloud copy is deleted meanwhile, which clears its link.
            const service = await import('../skill-service');
            service.clearSkillRemoteMetadataByRemoteId('ra');
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          }
          return actual.mkdir(...args);
        },
      };
    });

    expect((await save('b', 'a')).success).toBe(false);
    expect(storedLinks()).toEqual({});
    expect(await listedNames()).toEqual(['a']);
  });

  test('a failed rename keeps a share update written to the source while it ran', async () => {
    await seedCustomSkill('a', 'Old');
    const from = await customId('a');
    fs.writeFileSync(linksPath(), JSON.stringify({ [from]: remote('ra') }));
    const newer = { ...remote('ra'), contentHash: 'newer' };
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          if (String(args[0]).endsWith('.committed')) {
            // A share update lands for the source meanwhile.
            const service = await import('../skill-service');
            service.writeSkillRemoteMetadata(from, newer);
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          }
          return actual.mkdir(...args);
        },
      };
    });

    expect((await save('b', 'a')).success).toBe(false);
    expect(storedLinks()).toEqual({ [from]: newer });
  });

  test.each([
    'an entry move',
    'the swap listing',
    'the skills folder listing',
    'the swap path check',
    'the restore path check',
  ])(
    'a save of a skill whose interrupted restore is still unresolved is refused, and its files come back (%s fails)',
    async (fault) => {
      const holder = await seedMovedAside('a');
      const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
      fs.writeFileSync(join(holder, 'a', 'logo.png'), logo);
      const moved = join(holder, 'a');
      const skill = fs.readFileSync(join(moved, 'SKILL.md'), 'utf8');
      // A rollback restore that stopped part way: the claim is recorded and
      // still missing its entries.
      const claim = join(await customDir(), 'a');
      fs.mkdirSync(claim);
      const { dev, ino } = fs.lstatSync(claim, { bigint: true });
      fs.writeFileSync(join(holder, '.claimed'), `${dev}:${ino}`);
      let faults = 0;
      let rootChecks = 0;
      const eio = (): Error =>
        Object.assign(new Error('i/o error'), { code: 'EIO' });
      jest.doMock('node:fs/promises', (): object => {
        const actual =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        return {
          ...actual,
          // A skills root that can't be resolved, once: at recovery's swap
          // check (the 1st time) or its restore's check (the 2nd). It clears
          // before the save runs.
          realpath: async (
            ...args: Parameters<typeof actual.realpath>
          ): Promise<unknown> => {
            if (String(args[0]) === skillsDir()) {
              rootChecks++;
              if (
                (fault === 'the swap path check' && rootChecks === 1) ||
                (fault === 'the restore path check' && rootChecks === 2)
              ) {
                faults++;
                throw eio();
              }
            }
            return actual.realpath(...args);
          },
          // An unreadable swap, or skills folder, names no skill, so every
          // save is refused.
          readdir: async (
            ...args: Parameters<typeof actual.readdir>
          ): Promise<unknown> => {
            const listed = String(args[0]);
            if (
              (fault === 'the swap listing' && listed === holder) ||
              (fault === 'the skills folder listing' &&
                listed === dirname(claim) &&
                faults === 0)
            ) {
              faults++;
              throw eio();
            }
            return actual.readdir(...args);
          },
          rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
            if (
              fault === 'an entry move' &&
              String(from).startsWith(`${moved}${sep}`)
            ) {
              faults++;
              throw eio();
            }
            await actual.rename(from, to);
          },
        };
      });

      // An editor that loaded the skill earlier saves it again.
      const saved = await save('a', 'a');
      expect(faults).toBeGreaterThan(0);
      expect(saved.success).toBe(false);
      jest.dontMock('node:fs/promises');
      jest.resetModules();

      await recoverNow();
      expect(fs.readFileSync(join(claim, 'logo.png'))).toEqual(logo);
      expect(fs.readFileSync(join(claim, 'SKILL.md'), 'utf8')).toBe(skill);
    },
    30_000,
  );

  test('a save spelled in another case than an unresolved restore is refused too', async () => {
    const holder = await seedMovedAside('Helper');
    const claim = join(await customDir(), 'Helper');
    fs.mkdirSync(claim);
    const { dev, ino } = fs.lstatSync(claim, { bigint: true });
    fs.writeFileSync(join(holder, '.claimed'), `${dev}:${ino}`);
    const moved = join(holder, 'Helper');
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
          if (String(from).startsWith(`${moved}${sep}`))
            throw Object.assign(new Error('i/o error'), { code: 'EIO' });
          await actual.rename(from, to);
        },
      };
    });

    const saved = await save('helper', 'helper');
    // On a case-insensitive volume, `helper` is the partial `Helper` folder.
    if (fs.existsSync(join(await customDir(), 'helper')))
      expect(saved).toEqual({
        success: false,
        error:
          "Couldn't save this skill while an interrupted save is being recovered. Try again.",
      });
    else expect(saved.success).toBe(false);
  });

  // POSIX only: Windows keeps no folder mode beyond a read-only flag.
  (process.platform === 'win32' ? test.skip : test)(
    'a rename whose commit marker fails puts the original back with its folder mode',
    async () => {
      const original = await seedCustomSkill('a', 'Old');
      fs.chmodSync(original, 0o700);
      jest.doMock('node:fs/promises', (): object => {
        const actual =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        return {
          ...actual,
          mkdir: async (
            ...args: Parameters<typeof actual.mkdir>
          ): Promise<string | undefined> => {
            if (String(args[0]).endsWith('.committed'))
              throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
            return actual.mkdir(...args);
          },
        };
      });

      expect((await save('b', 'a')).success).toBe(false);
      expect(fs.statSync(original).mode & 0o777).toBe(0o700);
    },
  );

  test('a package whose root name starts with a dot still installs into its local folder', async () => {
    const requested = (): Promise<never> =>
      Promise.reject(new Error('package requested'));
    jest.doMock('../../pipelines/canopy-server-client', (): object => ({
      getSkillPackage: requested,
      getSkillPackageBlob: requested,
      getPublicSkillPackage: requested,
      getPublicSkillPackageBlob: requested,
    }));
    const { installSkillCapabilityPackage } =
      await import('../skill-package-install');

    // The root name is the package's lookup key, not a folder; the guard
    // reaches only the local folder name, so the install goes on to fetch.
    await expect(
      installSkillCapabilityPackage({
        remoteId: 'r',
        skillName: 'helper',
        primaryRootName: '.helper',
        packageRef: { version: 1, digest: 'sha256:abc' },
      }),
    ).rejects.toThrow('package requested');
    await expect(
      installSkillCapabilityPackage({
        remoteId: 'r',
        skillName: '.helper',
        primaryRootName: 'helper',
        packageRef: { version: 1, digest: 'sha256:abc' },
      }),
    ).rejects.toThrow('Invalid skillName');
  });

  test('a restore never renames onto an existing folder, which Windows refuses', async () => {
    await seedMovedAside('a');
    const destination = join(await customDir(), 'a');
    // Windows can't rename a folder onto any existing folder, empty or not.
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
          if (fs.existsSync(String(to)))
            throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
          await actual.rename(from, to);
        },
      };
    });
    expect((await save('b')).success).toBe(true);
    jest.dontMock('node:fs/promises');

    expect(await listedNames()).toEqual(['a', 'b']);
    expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toContain(
      'Old',
    );
  });

  test('a restore an exit cut short after its claim resumes on the next run', async () => {
    await seedMovedAside('a');
    const destination = join(await customDir(), 'a');
    let exited = false;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      const alive = (): void => {
        if (exited) throw new Error('the process exited');
      };
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          alive();
          return actual.mkdir(...args);
        },
        rmdir: async (
          ...args: Parameters<typeof actual.rmdir>
        ): Promise<void> => {
          alive();
          await actual.rmdir(...args);
        },
        rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
          alive();
          // The first move into the old name is where the process exits.
          if (String(to).startsWith(destination)) {
            exited = true;
            throw new Error('the process exited');
          }
          await actual.rename(from, to);
        },
      };
    });
    await listedNames();
    const { runSkillMutation } = await import('../skill-mutations');
    await runSkillMutation(() => Promise.resolve());
    expect(exited).toBe(true);
    jest.dontMock('node:fs/promises');
    jest.resetModules();

    expect((await save('b')).success).toBe(true);
    expect(await listedNames()).toEqual(['a', 'b']);
    expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toContain(
      'Old',
    );
  }, 30_000);

  test('an exit during a failed save’s rollback never leaves the skill unlisted', async () => {
    await seedCustomSkill('a', 'Old');
    const live = join(await customDir(), 'a');
    let exited = false;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      const alive = (): void => {
        if (exited) throw new Error('the process exited');
      };
      let markerFailed = false;
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          alive();
          if (String(args[0]).endsWith('.committed')) {
            markerFailed = true;
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          }
          return actual.mkdir(...args);
        },
        // The rollback's first touch of the failed copy at the live path is
        // where the process exits: a delete gets part way first.
        rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
          alive();
          if (markerFailed && String(args[0]) === live) {
            fs.rmSync(join(live, 'SKILL.md'));
            exited = true;
            throw new Error('the process exited');
          }
          await actual.rm(...args);
        },
        rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
          alive();
          if (markerFailed && String(from) === live) {
            exited = true;
            throw new Error('the process exited');
          }
          await actual.rename(from, to);
        },
      };
    });
    await save('a', 'a');
    expect(exited).toBe(true);
    jest.dontMock('node:fs/promises');
    jest.resetModules();

    await listedNames();
    const { runSkillMutation } = await import('../skill-mutations');
    await runSkillMutation(() => Promise.resolve());
    expect(await listedNames()).toEqual(['a']);
  }, 30_000);

  test('a rename rollback keeps the install receipt until the renamed copy is gone', async () => {
    await seedCustomSkill('a', 'Old');
    const from = await customId('a');
    const to = await customId('b');
    const renamed = join(await customDir(), 'b');
    const { receipts } = seedInstallReceipt(from);
    let exited = false;
    let renamedLiveWhenReceiptUndone: boolean | undefined;
    jest.doMock('../../lib/resource-install-receipts', (): object => {
      const actual = jest.requireActual<typeof InstallReceipts>(
        '../../lib/resource-install-receipts',
      );
      return {
        ...actual,
        createResourceInstallReceiptsStore: (
          ...args: Parameters<typeof actual.createResourceInstallReceiptsStore>
        ): object => {
          const store = actual.createResourceInstallReceiptsStore(...args);
          return {
            ...store,
            rollbackInstall: async (
              ...rollback: Parameters<typeof store.rollbackInstall>
            ): Promise<void> => {
              await store.rollbackInstall(...rollback);
              renamedLiveWhenReceiptUndone = fs.existsSync(renamed);
              // The process exits right after the receipt is undone.
              exited = true;
            },
          };
        },
      };
    });
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      const alive = (): void => {
        if (exited) throw new Error('the process exited');
      };
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          alive();
          if (String(args[0]).endsWith('.committed'))
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          return actual.mkdir(...args);
        },
        rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
          alive();
          await actual.rm(...args);
        },
        rename: async (src: FsPathLike, dest: FsPathLike): Promise<void> => {
          alive();
          await actual.rename(src, dest);
        },
      };
    });

    expect((await save('b', 'a')).success).toBe(false);
    expect(renamedLiveWhenReceiptUndone).toBe(false);
    expect(fs.readFileSync(receipts, 'utf8')).not.toContain(to);
  });

  test('a resume never writes into a folder that replaced its claim', async () => {
    await seedMovedAside('a');
    const destination = join(await customDir(), 'a');
    await interruptRestoreAt(destination);
    // Another writer replaces the empty claim with its own skill.
    fs.rmSync(destination, { recursive: true, force: true });
    await seedCustomSkill('a', 'Replacement');
    const replacement = fs.readFileSync(join(destination, 'SKILL.md'), 'utf8');

    await recoverNow();
    expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(
      replacement,
    );
    expect(fs.readdirSync(destination)).toEqual(['SKILL.md']);
    const custom = await customDir();
    const kept = fs
      .readdirSync(custom)
      .filter((name) => name.startsWith('.canopy-skill-kept-'));
    expect(kept).toHaveLength(1);
    expect(
      fs.readFileSync(join(custom, kept[0], 'a', 'SKILL.md'), 'utf8'),
    ).toContain('Old');
  }, 30_000);

  test('a resume never follows a claim replaced by a symlink', async () => {
    await seedMovedAside('a');
    const destination = join(await customDir(), 'a');
    await interruptRestoreAt(destination);
    const outside = join(ownedRoot, 'outside-claim');
    fs.mkdirSync(outside, { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.symlinkSync(outside, destination);

    await recoverNow();
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.rmSync(outside, { recursive: true, force: true });
  }, 30_000);

  test('a restore refuses an old copy holding a symlink', async () => {
    const holder = await seedMovedAside('a');
    const outside = join(ownedRoot, 'outside-target');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(join(outside, 'secret.txt'), 'outside');
    fs.symlinkSync(join(outside, 'secret.txt'), join(holder, 'a', 'link.txt'));

    await recoverNow();
    // The copy is kept aside, never made live with a link out.
    expect(fs.existsSync(join(await customDir(), 'a'))).toBe(false);
    expect(fs.readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe(
      'outside',
    );
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('a restore whose claim fails with an i/o error retries on the next run', async () => {
    await seedMovedAside('a');
    const destination = join(await customDir(), 'a');
    let failed = 0;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          if (String(args[0]) === destination && failed++ === 0)
            throw Object.assign(new Error('i/o error'), { code: 'EIO' });
          return actual.mkdir(...args);
        },
      };
    });
    await recoverNow();
    expect(failed).toBe(1);
    jest.dontMock('node:fs/promises');
    jest.resetModules();

    await recoverNow();
    expect(await listedNames()).toEqual(['a']);
    expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toContain(
      'Old',
    );
  }, 30_000);

  test('a resume whose claim record cannot be read retries on the next run', async () => {
    const holder = await seedMovedAside('a');
    fs.writeFileSync(join(holder, 'a', 'notes.md'), 'old notes');
    const skill = fs.readFileSync(join(holder, 'a', 'SKILL.md'), 'utf8');
    const destination = join(await customDir(), 'a');
    await interruptRestoreAt(destination, 1);
    expect(fs.readdirSync(destination)).toHaveLength(1);
    let failed = 0;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        readFile: async (
          ...args: Parameters<typeof actual.readFile>
        ): Promise<string | Buffer> => {
          const [file] = args;
          if (
            typeof file === 'string' &&
            file.endsWith('.claimed') &&
            failed++ === 0
          )
            throw Object.assign(new Error('i/o error'), { code: 'EIO' });
          return actual.readFile(...args);
        },
      };
    });
    await recoverNow();
    expect(failed).toBe(1);
    jest.dontMock('node:fs/promises');
    jest.resetModules();

    await recoverNow();
    expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(skill);
    expect(fs.readFileSync(join(destination, 'notes.md'), 'utf8')).toBe(
      'old notes',
    );
    expect(fs.existsSync(holder)).toBe(false);
    expect(
      fs
        .readdirSync(await customDir())
        .filter((name) => name.startsWith('.canopy-skill-kept-')),
    ).toEqual([]);
  }, 30_000);

  // Case variants too: macOS and Windows volumes resolve them as the marker.
  test.each(['.committed', '.claimed', '.CLAIMED', '.Committed'])(
    'a rename of a skill named %s is refused and its copy stays in place',
    async (name) => {
      const original = join(await seedCustomSkill(name, 'Legacy'), 'SKILL.md');
      const skill = fs.readFileSync(original, 'utf8');
      let exited = false;
      let asideMoved = false;
      jest.doMock('node:fs/promises', (): object => {
        const actual =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        const alive = (): void => {
          if (exited) throw new Error('the process exited');
        };
        return {
          ...actual,
          mkdir: async (
            ...args: Parameters<typeof actual.mkdir>
          ): Promise<string | undefined> => {
            alive();
            return actual.mkdir(...args);
          },
          rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
            alive();
            await actual.rm(...args);
          },
          rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
            alive();
            // The process exits once the old copy is in the swap.
            if (asideMoved) {
              exited = true;
              throw new Error('the process exited');
            }
            await actual.rename(from, to);
            if (String(to).includes('.canopy-skill-swap-')) asideMoved = true;
          },
        };
      });
      // Refused before anything moves: the copy stays where it was, and no
      // swap holds it.
      expect((await save('renamed', name)).success).toBe(false);
      jest.dontMock('node:fs/promises');
      jest.resetModules();

      await recoverNow();
      expect(fs.readFileSync(original, 'utf8')).toBe(skill);
      expect(
        fs
          .readdirSync(await customDir())
          .filter((entry) => entry.startsWith('.canopy-skill-')),
      ).toEqual([]);
    },
    30_000,
  );

  test('an interrupted save of a dot-named skill never discards its old copy', async () => {
    await seedMovedAside('.helper');
    await recoverNow();
    const custom = await customDir();
    const copies = [
      join(custom, '.helper'),
      ...fs
        .readdirSync(custom)
        .filter((name) => name.startsWith('.canopy-skill-kept-'))
        .map((name) => join(custom, name, '.helper')),
    ].filter((dir) => fs.existsSync(join(dir, 'SKILL.md')));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(join(copies[0], 'SKILL.md'), 'utf8')).toContain(
      'Old',
    );
  });

  test('a resume never replaces a file another writer put in its claim', async () => {
    const holder = await seedMovedAside('a');
    fs.writeFileSync(join(holder, 'a', 'notes.md'), 'old notes');
    const destination = join(await customDir(), 'a');
    await interruptRestoreAt(destination, 1);
    const [waiting] = fs.readdirSync(join(holder, 'a'));
    // A Collections install, which takes no lock, adds the same file.
    fs.writeFileSync(join(destination, waiting), 'install bytes');

    await recoverNow();
    expect(fs.readFileSync(join(destination, waiting), 'utf8')).toBe(
      'install bytes',
    );
    const custom = await customDir();
    const kept = fs
      .readdirSync(custom)
      .filter((name) => name.startsWith('.canopy-skill-kept-'));
    expect(kept).toHaveLength(1);
    expect(fs.existsSync(join(custom, kept[0], 'a', waiting))).toBe(true);
  }, 30_000);

  test.each([
    ['flushes the copy’s move before it undoes the receipt', false],
    ['whose flush fails keeps the receipt', true],
  ])('a rename rollback %s', async (_label, flushFails) => {
    await seedCustomSkill('a', 'Old');
    const to = await customId('b');
    const { receipts } = seedInstallReceipt(await customId('a'));
    const events: string[] = [];
    jest.doMock('../../lib/atomic-file', (): object => {
      const actual = jest.requireActual<typeof LocalAtomicFile>(
        '../../lib/atomic-file',
      );
      return {
        ...actual,
        syncDirectory: async (dir: string): Promise<void> => {
          if (!events.includes('marker failed'))
            return actual.syncDirectory(dir);
          events.push('flush');
          if (flushFails)
            throw Object.assign(new Error('i/o error'), { code: 'EIO' });
          await actual.syncDirectory(dir);
        },
      };
    });
    jest.doMock('../../lib/resource-install-receipts', (): object => {
      const actual = jest.requireActual<typeof InstallReceipts>(
        '../../lib/resource-install-receipts',
      );
      return {
        ...actual,
        createResourceInstallReceiptsStore: (
          ...args: Parameters<typeof actual.createResourceInstallReceiptsStore>
        ): object => {
          const store = actual.createResourceInstallReceiptsStore(...args);
          return {
            ...store,
            rollbackInstall: (
              ...rollback: Parameters<typeof store.rollbackInstall>
            ): Promise<void> => {
              events.push('receipt undone');
              return store.rollbackInstall(...rollback);
            },
          };
        },
      };
    });
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          if (String(args[0]).endsWith('.committed')) {
            events.push('marker failed');
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          }
          return actual.mkdir(...args);
        },
      };
    });

    expect((await save('b', 'a')).success).toBe(false);
    if (flushFails) {
      expect(events).toEqual(['marker failed', 'flush']);
      expect(fs.readFileSync(receipts, 'utf8')).toContain(to);
    } else {
      // The restored folder's claim, then the skills folder.
      expect(events).toEqual([
        'marker failed',
        'flush',
        'flush',
        'receipt undone',
      ]);
      expect(fs.readFileSync(receipts, 'utf8')).not.toContain(to);
    }
  });

  /** An old copy with two supporting files beside its SKILL.md. */
  async function seedSupportedAside(): Promise<string> {
    const holder = await seedMovedAside('a');
    fs.writeFileSync(join(holder, 'a', 'notes.md'), 'old notes');
    fs.writeFileSync(join(holder, 'a', 'extra.md'), 'old extra');
    return holder;
  }

  test('a part-restored skill is not listed until its restore finishes', async () => {
    await seedSupportedAside();
    const destination = join(await customDir(), 'a');
    // Both supporting files are back; the process exits before the last move.
    await interruptRestoreAt(destination, 2);
    expect(fs.readdirSync(destination)).toHaveLength(2);
    const { loadSkills } = await import('../skill-service');
    const listed = loadSkills();
    expect(listed.data?.map((skill) => skill.name)).toEqual([]);

    await recoverNow();
    expect(await listedNames()).toEqual(['a']);
    expect((await save('a', 'a')).success).toBe(true);
    expect(fs.readFileSync(join(destination, 'notes.md'), 'utf8')).toBe(
      'old notes',
    );
    expect(fs.readFileSync(join(destination, 'extra.md'), 'utf8')).toBe(
      'old extra',
    );
  }, 30_000);

  test.each([
    ['an empty claim', 0],
    ['a part-filled claim', 2],
  ])(
    'a raw import during an interrupted restore into %s takes the next name',
    async (_label, moved) => {
      const holder = await seedSupportedAside();
      const skill = fs.readFileSync(join(holder, 'a', 'SKILL.md'), 'utf8');
      const destination = join(await customDir(), 'a');
      await interruptRestoreAt(destination, moved);
      const { writeRawSkill } = await import('../skill-service');
      const imported = writeRawSkill({
        skillName: 'a',
        rawSkill: '---\nname: a\ndescription: imported\n---\n\nImported\n',
      });
      expect(imported.skillName).toBe('a-2');

      await recoverNow();
      expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(
        skill,
      );
      expect(fs.readdirSync(destination).sort()).toEqual([
        'SKILL.md',
        'extra.md',
        'notes.md',
      ]);
      expect(
        fs.readFileSync(join(await customDir(), 'a-2', 'SKILL.md'), 'utf8'),
      ).toContain('Imported');
      expect(fs.existsSync(holder)).toBe(false);
    },
    30_000,
  );

  test('a restore whose half-filled claim was deleted keeps the rest aside', async () => {
    const holder = await seedSupportedAside();
    const destination = join(await customDir(), 'a');
    await interruptRestoreAt(destination, 1);
    const waiting = fs.readdirSync(join(holder, 'a')).sort();
    // Something outside recovery removes the unlisted, half-filled claim.
    fs.rmSync(destination, { recursive: true, force: true });

    await recoverNow();
    expect(fs.existsSync(destination)).toBe(false);
    expect(await listedNames()).toEqual([]);
    const custom = await customDir();
    const kept = fs
      .readdirSync(custom)
      .filter((name) => name.startsWith('.canopy-skill-kept-'));
    expect(kept).toHaveLength(1);
    expect(fs.readdirSync(join(custom, kept[0], 'a')).sort()).toEqual(waiting);
  }, 30_000);

  test('a stray temp file beside the old copy never sends the swap aside', async () => {
    const holder = await seedMovedAside('a');
    // What an interrupted atomic write of the record leaves behind.
    fs.writeFileSync(
      join(holder, `.claimed.4242.${SEEDED_ID}.tmp`),
      'torn record',
    );

    await recoverNow();
    expect(await listedNames()).toEqual(['a']);
    expect(
      fs.readFileSync(join(await customDir(), 'a', 'SKILL.md'), 'utf8'),
    ).toContain('Old');
    expect(fs.existsSync(holder)).toBe(false);
  });

  test('a restore whose claim record write fails retries on the next run', async () => {
    const holder = await seedSupportedAside();
    const skill = fs.readFileSync(join(holder, 'a', 'SKILL.md'), 'utf8');
    const destination = join(await customDir(), 'a');
    let failed = 0;
    jest.doMock('../../lib/atomic-file', (): object => {
      const actual = jest.requireActual<typeof LocalAtomicFile>(
        '../../lib/atomic-file',
      );
      return {
        ...actual,
        writeFileAtomically: async (
          ...args: Parameters<typeof actual.writeFileAtomically>
        ): Promise<void> => {
          if (String(args[0]).endsWith('.claimed') && failed++ === 0)
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          await actual.writeFileAtomically(...args);
        },
      };
    });
    await recoverNow();
    expect(failed).toBe(1);
    jest.dontMock('../../lib/atomic-file');
    jest.resetModules();

    await recoverNow();
    expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(skill);
    expect(fs.readdirSync(destination).sort()).toEqual([
      'SKILL.md',
      'extra.md',
      'notes.md',
    ]);
    expect(fs.existsSync(holder)).toBe(false);
    expect(
      fs
        .readdirSync(await customDir())
        .filter((name) => name.startsWith('.canopy-skill-kept-')),
    ).toEqual([]);
  }, 30_000);

  test('a restore whose new claim cannot be identified retries on the next run', async () => {
    const holder = await seedSupportedAside();
    const skill = fs.readFileSync(join(holder, 'a', 'SKILL.md'), 'utf8');
    const destination = join(await customDir(), 'a');
    let failed = 0;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        lstat: async (
          ...args: Parameters<typeof actual.lstat>
        ): Promise<unknown> => {
          const [target, options] = args;
          // The lookup right after the claim mkdir fails once.
          if (
            target === destination &&
            options?.bigint === true &&
            failed++ === 0
          )
            throw Object.assign(new Error('i/o error'), { code: 'EIO' });
          return actual.lstat(...args);
        },
      };
    });
    await recoverNow();
    expect(failed).toBeGreaterThan(0);
    jest.dontMock('node:fs/promises');
    jest.resetModules();

    await recoverNow();
    expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(skill);
    expect(fs.readdirSync(destination).sort()).toEqual([
      'SKILL.md',
      'extra.md',
      'notes.md',
    ]);
    expect(
      fs
        .readdirSync(await customDir())
        .filter((name) => name.startsWith('.canopy-skill-kept-')),
    ).toEqual([]);
  }, 30_000);

  test('a raw import whose SKILL.md write fails leaves no folder, so a retry keeps its name', async () => {
    const rawSkill = '---\nname: a\ndescription: imported\n---\n\nImported\n';
    const skillMd = join(await customDir(), 'a', 'SKILL.md');
    let failed = 0;
    jest.doMock('fs', (): object => {
      const actual = jest.requireActual<typeof NodeFs>('fs');
      // The open succeeds; the write to its descriptor fails, once.
      let opened: number | null = null;
      return {
        ...actual,
        openSync: (...args: Parameters<typeof actual.openSync>): number => {
          const fd = actual.openSync(...args);
          if (args[0] === skillMd) opened = fd;
          return fd;
        },
        writeFileSync: (
          ...args: Parameters<typeof actual.writeFileSync>
        ): void => {
          if (opened !== null && args[0] === opened && failed++ === 0)
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          actual.writeFileSync(...args);
        },
      };
    });
    const { writeRawSkill } = await import('../skill-service');
    expect(() => writeRawSkill({ skillName: 'a', rawSkill })).toThrow(
      'no space',
    );
    expect(failed).toBe(1);
    expect(fs.existsSync(join(await customDir(), 'a'))).toBe(false);
    jest.dontMock('fs');
    jest.resetModules();

    const retried = await import('../skill-service');
    expect(retried.writeRawSkill({ skillName: 'a', rawSkill }).skillName).toBe(
      'a',
    );
    expect(fs.readFileSync(skillMd, 'utf8')).toContain('Imported');
  }, 30_000);

  test.each([
    ['flushes the moved entries before it discards the swap', false],
    ['whose flush fails keeps the swap for the next run', true],
  ])(
    'a restore %s',
    async (_label, flushFails) => {
      const holder = await seedSupportedAside();
      const skill = fs.readFileSync(join(holder, 'a', 'SKILL.md'), 'utf8');
      const custom = await customDir();
      const destination = join(custom, 'a');
      const events: string[] = [];
      jest.doMock('../../lib/atomic-file', (): object => {
        const actual = jest.requireActual<typeof LocalAtomicFile>(
          '../../lib/atomic-file',
        );
        return {
          ...actual,
          syncDirectory: async (dir: string): Promise<void> => {
            if (events.includes('move')) {
              events.push(
                `flush ${dir === destination ? 'claim' : dir === custom ? 'source' : dir}`,
              );
              if (flushFails)
                throw Object.assign(new Error('i/o error'), { code: 'EIO' });
            }
            await actual.syncDirectory(dir);
          },
        };
      });
      jest.doMock('node:fs/promises', (): object => {
        const actual =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        return {
          ...actual,
          rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
            if (dirname(String(to)) === destination) {
              if (events.at(-1) !== 'move') events.push('move');
            } else if (String(from) === holder) events.push('discard');
            await actual.rename(from, to);
          },
          rmdir: async (
            ...args: Parameters<typeof actual.rmdir>
          ): Promise<void> => {
            if (String(args[0]) === join(holder, 'a'))
              events.push('source removed');
            await actual.rmdir(...args);
          },
        };
      });
      await recoverNow();
      jest.dontMock('node:fs/promises');
      jest.dontMock('../../lib/atomic-file');
      jest.resetModules();

      if (flushFails) {
        expect(events).toEqual(['move', 'flush claim']);
        expect(fs.existsSync(join(holder, '.claimed'))).toBe(true);
        await recoverNow();
      } else {
        expect(events).toEqual([
          'move',
          'flush claim',
          'flush source',
          'source removed',
          'discard',
        ]);
      }
      expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(
        skill,
      );
      expect(fs.readdirSync(destination).sort()).toEqual([
        'SKILL.md',
        'extra.md',
        'notes.md',
      ]);
      expect(fs.existsSync(holder)).toBe(false);
    },
    30_000,
  );

  test('a resume whose claim identity cannot be read retries on the next run', async () => {
    const holder = await seedMovedAside('a');
    fs.writeFileSync(join(holder, 'a', 'notes.md'), 'old notes');
    const skill = fs.readFileSync(join(holder, 'a', 'SKILL.md'), 'utf8');
    const destination = join(await customDir(), 'a');
    await interruptRestoreAt(destination, 1);
    let failed = 0;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        lstat: async (
          ...args: Parameters<typeof actual.lstat>
        ): Promise<unknown> => {
          const [target, options] = args;
          if (
            target === destination &&
            options?.bigint === true &&
            failed++ === 0
          )
            throw Object.assign(new Error('i/o error'), { code: 'EIO' });
          return actual.lstat(...args);
        },
      };
    });
    await recoverNow();
    expect(failed).toBe(1);
    jest.dontMock('node:fs/promises');
    jest.resetModules();

    await recoverNow();
    expect(fs.readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(skill);
    expect(fs.readFileSync(join(destination, 'notes.md'), 'utf8')).toBe(
      'old notes',
    );
    expect(fs.existsSync(holder)).toBe(false);
    expect(
      fs
        .readdirSync(await customDir())
        .filter((name) => name.startsWith('.canopy-skill-kept-')),
    ).toEqual([]);
  }, 30_000);

  test('a rename rollback restores the link even when the receipt undo fails', async () => {
    await seedCustomSkill('a', 'Old');
    fs.writeFileSync(
      linksPath(),
      JSON.stringify({ [await customId('a')]: remote('ra') }),
    );
    seedInstallReceipt(await customId('a'));
    jest.doMock('../../lib/resource-install-receipts', (): object => {
      const actual = jest.requireActual<typeof InstallReceipts>(
        '../../lib/resource-install-receipts',
      );
      return {
        ...actual,
        createResourceInstallReceiptsStore: (
          ...args: Parameters<typeof actual.createResourceInstallReceiptsStore>
        ): object => ({
          ...actual.createResourceInstallReceiptsStore(...args),
          rollbackInstall: (): Promise<void> =>
            Promise.reject(new Error('receipt store unavailable')),
        }),
      };
    });
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          if (String(args[0]).endsWith('.committed'))
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          return actual.mkdir(...args);
        },
      };
    });

    expect((await save('b', 'a')).success).toBe(false);
    expect(storedLinks()).toEqual({ [await customId('a')]: remote('ra') });
  });

  describe('a save interrupted at each step keeps the old copy, the new copy or both', () => {
    type Mode = 'throws' | 'exits';
    const STEPS = [
      'stage written',
      'stage flushed',
      'old moved aside',
      'new moved in',
      'folder flushed',
      'link moved',
      'committed written',
      'committed flushed',
      'cleanup',
    ] as const;
    type Step = (typeof STEPS)[number];

    /**
     * Faults one step; after an exit nothing else reaches the disk. Returns
     * how many times the fault fired.
     */
    async function installFault(step: Step, mode: Mode): Promise<() => number> {
      const custom = await customDir();
      let exited = false;
      let movedIn = false;
      let committed = false;
      let fired = 0;
      const fault = (): never => {
        fired++;
        if (mode === 'exits') exited = true;
        throw Object.assign(new Error(`fault at ${step}`), { code: 'EIO' });
      };
      const alive = (): void => {
        if (exited) throw new Error('the process exited');
      };
      // Typed as object: fs/promises' overloads can't be restated per mock.
      jest.doMock('node:fs/promises', (): object => {
        const actual =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        return {
          ...actual,
          writeFile: async (
            ...args: Parameters<typeof actual.writeFile>
          ): Promise<void> => {
            alive();
            if (
              step === 'stage written' &&
              typeof args[0] === 'string' &&
              args[0].includes('.canopy-skill-stage-')
            )
              fault();
            await actual.writeFile(...args);
          },
          cp: async (...args: Parameters<typeof actual.cp>): Promise<void> => {
            alive();
            await actual.cp(...args);
          },
          rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
            alive();
            const source = String(from);
            const target = String(to);
            if (
              step === 'old moved aside' &&
              target.includes('.canopy-skill-swap-')
            )
              fault();
            if (
              step === 'new moved in' &&
              source.includes('.canopy-skill-stage-')
            )
              fault();
            if (step === 'cleanup' && target.includes('.canopy-skill-trash-'))
              fault();
            await actual.rename(from, to);
            if (source.includes('.canopy-skill-stage-')) movedIn = true;
            // A rollback moved the new copy out again.
            if (String(to).includes('.canopy-skill-trash-')) movedIn = false;
          },
          mkdir: async (
            ...args: Parameters<typeof actual.mkdir>
          ): Promise<string | undefined> => {
            alive();
            const target = String(args[0]);
            if (step === 'committed written' && target.endsWith('.committed'))
              fault();
            const made = await actual.mkdir(...args);
            if (target.endsWith('.committed')) committed = true;
            return made;
          },
          rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
            alive();
            await actual.rm(...args);
          },
        };
      });
      jest.doMock(
        '@canopy/execution-engine/node/lib/atomic-file',
        (): typeof AtomicFile => {
          const actual = jest.requireActual<typeof AtomicFile>(
            '@canopy/execution-engine/node/lib/atomic-file',
          );
          return {
            ...actual,
            syncTreeDurably: async (root: string): Promise<void> => {
              alive();
              if (step === 'stage flushed') fault();
              await actual.syncTreeDurably(root);
            },
            syncDirectory: async (dir: string): Promise<void> => {
              alive();
              if (
                step === 'folder flushed' &&
                movedIn &&
                !committed &&
                dir === custom
              )
                fault();
              if (step === 'committed flushed' && committed && dir !== custom)
                fault();
              await actual.syncDirectory(dir);
            },
            writeFileAtomicallySync: (
              ...args: Parameters<typeof actual.writeFileAtomicallySync>
            ): void => {
              alive();
              if (step === 'link moved' && String(args[0]) === linksPath())
                fault();
              actual.writeFileAtomicallySync(...args);
            },
          };
        },
      );
      return () => fired;
    }

    /** Steps after the commit point: the save stands. */
    const COMMITTED_STEPS: readonly Step[] = ['committed flushed', 'cleanup'];
    /** Steps by which a rename's link move is on disk and not undone. */
    const linkMoved = (step: Step, mode: Mode): boolean =>
      COMMITTED_STEPS.includes(step) ||
      (mode === 'exits' && step === 'committed written');

    async function recoveredNames(): Promise<string[]> {
      jest.dontMock('node:fs/promises');
      jest.dontMock('@canopy/execution-engine/node/lib/atomic-file');
      jest.resetModules();
      await listedNames();
      const { runSkillMutation } = await import('../skill-mutations');
      await runSkillMutation(() => Promise.resolve());
      return listedNames();
    }

    const cases = STEPS.flatMap((step) =>
      (['edit', 'rename'] as const)
        .filter((kind) => step !== 'link moved' || kind === 'rename')
        .flatMap((kind) =>
          (['throws', 'exits'] as const).map(
            (mode) => [step, kind, mode] as const,
          ),
        ),
    );

    test.each(cases)(
      'a fault at %s during an %s that %s',
      async (step, kind, mode) => {
        await seedCustomSkill('a', 'Old');
        await seedCustomSkill('z', 'Unrelated');
        fs.writeFileSync(
          linksPath(),
          JSON.stringify({
            [await customId('a')]: remote('ra'),
            [await customId('z')]: remote('rz'),
          }),
        );
        const target = kind === 'edit' ? 'a' : 'b';
        const fired = await installFault(step, mode);
        const saved = await save(target, 'a');
        expect(fired()).toBe(1);
        expect(saved.success).toBe(COMMITTED_STEPS.includes(step));

        const names = await recoveredNames();
        const dir = await customDir();
        const copies = names
          .filter((name) => name === 'a' || name === target)
          .map((name) => fs.readFileSync(join(dir, name, 'SKILL.md'), 'utf8'));
        // The old copy, the new copy or both: never neither.
        expect(copies.some((text) => /Old|New/.test(text))).toBe(true);
        // No live skill folder is deleted.
        expect(names).toContain('z');
        // Both seeded links survive, each naming a folder that exists.
        const linked =
          kind === 'rename' && linkMoved(step, mode) ? target : 'a';
        expect(storedLinks()).toEqual({
          [await customId(linked)]: remote('ra'),
          [await customId('z')]: remote('rz'),
        });
        expect(names).toContain(linked);
      },
      30_000,
    );
  });
});

describe('Collections installs and custom saves', () => {
  type Caller = 'shared update' | 'package install';
  const CALLERS: readonly Caller[] = ['shared update', 'package install'];
  const REMOTE = 'collection-remote';
  const STAMP_25 = '2026-11-25T00:00:00.000Z';

  interface PackagedSkill {
    id: string;
    rootName: string;
    body: string;
    provider?: 'claude' | 'codex';
    /** The SKILL.md frontmatter name; the root name by default. */
    skillName?: string;
    /** One supporting file beside SKILL.md. */
    notes?: string;
  }

  /** A package of standalone skills, all bound to its subject. */
  function packageOf(skills: readonly PackagedSkill[]): {
    download: { digest: string; manifest: PipelinePackageManifestV1 };
    blobs: Map<string, Uint8Array>;
  } {
    const blobs = new Map<string, Uint8Array>();
    const resources = skills.map(
      (skill): PipelinePackageManifestV1['resources'][number] => {
        const entry = (
          path: string,
          text: string,
        ): PipelinePackageManifestV1['resources'][number]['trees'][number]['entries'][number] => {
          const bytes = new TextEncoder().encode(text);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          blobs.set(sha256, bytes);
          return { path, sha256, size: bytes.byteLength, mode: 'read' };
        };
        const entries = [
          entry(
            'SKILL.md',
            `---\nname: ${skill.skillName ?? skill.rootName}\ndescription: packaged\n---\n${skill.body}\n`,
          ),
          ...(skill.notes === undefined
            ? []
            : [entry('notes.md', skill.notes)]),
        ];
        return {
          id: skill.id,
          kind: 'standalone_skill',
          displayName: skill.rootName,
          sourceLabel: 'Custom',
          sourceVisibility: 'private',
          invocationKeys: [skill.rootName],
          dependencyResourceIds: [],
          trees: [
            {
              provider: skill.provider ?? 'claude',
              runtimeKind: 'standalone_skill',
              rootName: skill.rootName,
              entries,
            },
          ],
        };
      },
    );
    const manifest: PipelinePackageManifestV1 = {
      version: 1,
      pipelineContentHash: 'c'.repeat(64),
      resources,
      bindings: [
        { target: 'subject', resourceIds: skills.map((skill) => skill.id) },
      ],
      environmentRequirements: [],
      totalFiles: resources.reduce(
        (total, resource) => total + (resource.trees[0]?.entries.length ?? 0),
        0,
      ),
      totalBytes: resources.reduce(
        (total, resource) =>
          total +
          (resource.trees[0]?.entries ?? []).reduce(
            (sum, entry) => sum + entry.size,
            0,
          ),
        0,
      ),
    };
    return {
      download: {
        digest: computePipelinePackageDigestSync(manifest),
        manifest,
      },
      blobs,
    };
  }

  /**
   * Serves a Collections package from a fake package client: `rootName`
   * and any `more` skills. Blob fetches are logged; everything else in the
   * client stays real.
   */
  function serveCollectionPackage(
    rootName: string,
    events: string[],
    more: readonly Omit<PackagedSkill, 'id'>[] = [],
  ): { ref: PipelinePackageRef; contentHash: string } {
    // Every case fetches its blob: none finds an earlier case's cached package.
    fs.rmSync(getPipelinePackagesDir(), { recursive: true, force: true });
    const { download, blobs } = packageOf([
      { id: 'skill-packaged', rootName, body: 'Packaged' },
      ...more.map((skill, index) => ({ ...skill, id: `skill-more-${index}` })),
    ]);
    const fetchDownload = (): Promise<object> => Promise.resolve(download);
    const blob = (
      _remoteId: string,
      _digest: string,
      sha256: string,
    ): Promise<Uint8Array> => {
      events.push('blob fetched');
      const bytes = blobs.get(sha256);
      return bytes
        ? Promise.resolve(bytes)
        : Promise.reject(new Error('Unknown blob'));
    };
    jest.doMock('../../collections/canopy-server-client', (): object => ({
      ...jest.requireActual<object>('../../collections/canopy-server-client'),
      getCollectionPackage: fetchDownload,
      getPublicCollectionPackage: fetchDownload,
      getCollectionPackageBlob: blob,
      getPublicCollectionPackageBlob: blob,
    }));
    // The shared update captures a skill context; resource contexts are off.
    jest.doMock('../resource-lanes', (): object => ({
      ...jest.requireActual<object>('../resource-lanes'),
      skillContextSnapshot: (): Promise<string> => Promise.resolve('context'),
      assertSkillContextSnapshot: (): Promise<void> => Promise.resolve(),
    }));
    return {
      ref: { version: 1, digest: download.digest },
      contentHash: download.manifest.pipelineContentHash,
    };
  }

  async function installCollection(
    caller: Caller,
    served: { ref: PipelinePackageRef; contentHash: string },
    assertCurrent = (): Promise<void> => Promise.resolve(),
  ): Promise<void> {
    const sharedSource = { remoteId: REMOTE, fetchedAt: STAMP_25 };
    if (caller === 'package install') {
      const { installCollectionPackageForCaller } =
        await import('../../collections/collection-handlers');
      const subscriptions =
        await import('../../canopy-cloud/shared-item-subscriptions');
      try {
        await installCollectionPackageForCaller({
          collectionId: REMOTE,
          packageRef: served.ref,
          createCollection: { name: 'Team kit', description: '', sharedSource },
        });
      } finally {
        // Wait for the subscription upload the install starts: its ledger
        // write, then its flush.
        await subscriptions.readSharedItemSubscriptionLedger();
        await subscriptions.flushSharedItemSubscriptions();
      }
      return;
    }
    const { collectionMutationPorts } =
      await import('../../collections/collection-mutation-ports');
    const initial: CollectionConfig = {
      id: 'local-collection',
      name: 'Team kit',
      description: '',
      skills: [],
      plugins: [],
      mcpServers: [],
      updatedAt: STAMP_25,
      sharedSource,
    };
    await collectionMutationPorts.installPackage(
      {
        contentHash: served.contentHash,
        collection: {
          version: 1,
          name: 'Team kit',
          description: '',
          items: [],
        },
        customSkills: [],
        package: served.ref,
      },
      initial,
      assertCurrent,
    );
  }

  /** A promise and the function that settles it. */
  function gate(): { opened: Promise<void>; open: () => void } {
    let open = (): void => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  /** Waits until `done()` holds; fails if it hasn't within `ms`. */
  async function waitUntil(
    done: () => boolean,
    ms: number,
    what: string,
  ): Promise<void> {
    const until = Date.now() + ms;
    while (!done()) {
      if (Date.now() > until) throw new Error(`Timed out waiting: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Counts the writers waiting for the skill mutation lock. */
  function watchSkillLock(): { waiting: () => number } {
    let requested = 0;
    let entered = 0;
    jest.doMock('../skill-mutations', (): object => {
      const actual =
        jest.requireActual<typeof SkillMutations>('../skill-mutations');
      return {
        ...actual,
        runSkillMutation: <T>(work: () => Promise<T>): Promise<T> => {
          requested += 1;
          return actual.runSkillMutation(() => {
            entered += 1;
            return work();
          });
        },
      };
    });
    return { waiting: () => requested - entered };
  }

  /**
   * Logs the save's swap steps and the install's folder reservations. The
   * save parks once with its old copy moved aside, until `release` opens.
   */
  async function logSkillWrites(
    events: string[],
    release: Promise<void>,
  ): Promise<{ parked: Promise<void> }> {
    const custom = await customDir();
    const parked = gate();
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        mkdir: async (
          ...args: Parameters<typeof actual.mkdir>
        ): Promise<string | undefined> => {
          const target = String(args[0]);
          const made = await actual.mkdir(...args);
          if (target.endsWith('.committed')) events.push('save committed');
          else if (
            dirname(target) === custom &&
            !basename(target).startsWith('.')
          )
            events.push(`reserved ${basename(target)}`);
          return made;
        },
        rename: async (from: FsPathLike, to: FsPathLike): Promise<void> => {
          await actual.rename(from, to);
          if (
            String(from) === join(custom, 'helper') &&
            String(to).includes('.canopy-skill-swap-')
          ) {
            events.push('old moved aside');
            parked.open();
            await release;
          }
        },
      };
    });
    return { parked: parked.opened };
  }

  test.each(CALLERS)(
    'a Collections %s of a name a save is swapping waits for the save',
    async (caller) => {
      await seedCustomSkill('helper', 'Old');
      const events: string[] = [];
      const release = gate();
      const { parked } = await logSkillWrites(events, release.opened);
      const lock = watchSkillLock();
      const served = serveCollectionPackage('helper', events);

      const saving = save('helper', 'helper');
      await parked;
      const installing = installCollection(caller, served);
      // The install queues behind the parked save before it reserves anything.
      await waitUntil(
        () => lock.waiting() === 1,
        10_000,
        'the install to queue behind the save',
      );
      expect(events.some((event) => event.startsWith('reserved'))).toBe(false);
      release.open();
      expect((await saving).success).toBe(true);
      await installing;

      const reserved = events.findIndex((event) =>
        event.startsWith('reserved'),
      );
      expect(reserved).toBeGreaterThan(events.indexOf('save committed'));
      const dir = await customDir();
      expect(
        fs.readFileSync(join(dir, 'helper', 'SKILL.md'), 'utf8'),
      ).toContain('New');
      expect(
        fs.readFileSync(join(dir, 'helper-2', 'SKILL.md'), 'utf8'),
      ).toContain('Packaged');
    },
    30_000,
  );

  test.each(CALLERS)(
    'a Collections %s fetches its blobs without the skill lock',
    async (caller) => {
      await seedCustomSkill('helper', 'Old');
      const events: string[] = [];
      const release = gate();
      const { parked } = await logSkillWrites(events, release.opened);
      const served = serveCollectionPackage('helper', events);

      const saving = save('helper', 'helper');
      await parked;
      const installing = installCollection(caller, served);
      // The save still holds the lock while the install fetches.
      await waitUntil(
        () => events.includes('blob fetched'),
        10_000,
        'the install to fetch its blob',
      );
      expect(events).toEqual(['old moved aside', 'blob fetched']);
      release.open();
      expect((await saving).success).toBe(true);
      await installing;
    },
    30_000,
  );

  test.each(CALLERS)(
    'a failed Collections %s rolls back before a queued save of the same name runs',
    async (caller) => {
      const custom = await customDir();
      const events: string[] = [];
      const release = gate();
      const reserved = gate();
      jest.doMock('node:fs/promises', (): object => {
        const actual =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        return {
          ...actual,
          mkdir: async (
            ...args: Parameters<typeof actual.mkdir>
          ): Promise<string | undefined> => {
            const made = await actual.mkdir(...args);
            if (String(args[0]) === join(custom, 'helper') && !events.length) {
              events.push('reserved helper');
              reserved.open();
              await release.opened;
            }
            return made;
          },
          writeFile: async (
            ...args: Parameters<typeof actual.writeFile>
          ): Promise<void> => {
            if (args[0] === join(custom, 'helper', 'SKILL.md'))
              if (events.length === 1) {
                events.push('install write failed');
                throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
              }
            await actual.writeFile(...args);
          },
        };
      });
      const lock = watchSkillLock();
      const served = serveCollectionPackage('helper', []);

      const installing = installCollection(caller, served).then(
        () => 'installed',
        (error: unknown) => String(error),
      );
      await reserved.opened;
      const saving = save('helper');
      // The save waits behind the install's reservation and writes nothing.
      await waitUntil(
        () => lock.waiting() === 1,
        10_000,
        'the save to queue behind the install',
      );
      expect(fs.readdirSync(join(custom, 'helper'))).toEqual([]);
      release.open();

      expect(await installing).toContain('no space');
      expect((await saving).success).toBe(true);
      expect(await listedNames()).toEqual(['helper']);
      expect(
        fs.readFileSync(join(custom, 'helper', 'SKILL.md'), 'utf8'),
      ).toContain('New');
    },
    30_000,
  );

  /** Holds the install's check-budget timer, so a case can run it out. */
  async function holdCheckBudget(): Promise<{
    started: () => boolean;
    expire: () => void;
  }> {
    const { MATERIALIZATION_CHECK_BUDGET_MS } =
      await import('../skill-package-install');
    const realSetTimeout = globalThis.setTimeout;
    let held: (() => void) | undefined;
    jest
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback: () => void, ms?: number) => {
        if (ms !== MATERIALIZATION_CHECK_BUDGET_MS)
          return realSetTimeout(callback, ms);
        held = callback;
        return realSetTimeout(() => {}, 0);
      });
    return { started: () => held !== undefined, expire: () => held?.() };
  }

  /**
   * Turns resource contexts on and binds `helper`, and any `more` names,
   * to one install receipt, so the install looks its share up through
   * `lookup`.
   */
  async function bindHelperReceipt(
    lookup: () => Promise<object>,
    more: readonly string[] = [],
  ): Promise<void> {
    fs.mkdirSync(getDataDir(), { recursive: true });
    const { receipts, before } = seedInstallReceipt(await customId('helper'));
    const bound = [await customId('helper')];
    for (const name of more) bound.push(await customId(name));
    fs.writeFileSync(
      receipts,
      JSON.stringify(before).replace(
        JSON.stringify(bound[0]),
        bound.map((id) => JSON.stringify(id)).join(','),
      ),
    );
    jest.doMock('../resource-lanes', (): object => ({
      ...jest.requireActual<object>('../resource-lanes'),
      skillResourceContextEnabled: (): boolean => true,
      assertSkillContext: (): Promise<void> => Promise.resolve(),
      skillContextSnapshot: (): Promise<string> => Promise.resolve('context'),
      assertSkillContextSnapshot: (): Promise<void> => Promise.resolve(),
    }));
    jest.doMock('../canopy-server-client', (): object => ({
      ...jest.requireActual<object>('../canopy-server-client'),
      getSharedSkill: lookup,
    }));
  }

  /** The skill folders in the custom source, hidden ones left out. */
  async function customFolders(): Promise<string[]> {
    const custom = await customDir();
    if (!fs.existsSync(custom)) return [];
    return fs
      .readdirSync(custom, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(['re-check', 'receipt lookup'])(
    'a shared update whose %s outlasts the check budget writes nothing and frees the lock',
    async (slow) => {
      const events: string[] = [];
      const served = serveCollectionPackage('helper', events);
      const hang = (): Promise<never> => new Promise(() => {});
      const reached = gate();
      if (slow === 'receipt lookup')
        await bindHelperReceipt(() => {
          reached.open();
          return hang();
        });
      // Only the re-check after the blob fetch, inside the lock, is slow.
      const assertCurrent = (): Promise<void> => {
        if (slow !== 're-check' || !events.includes('blob fetched'))
          return Promise.resolve();
        reached.open();
        return hang();
      };
      const budget = await holdCheckBudget();

      const installing = installCollection(
        'shared update',
        served,
        assertCurrent,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      await reached.opened;
      await waitUntil(budget.started, 10_000, 'the check budget to start');
      expect(await customFolders()).toEqual([]);
      budget.expire();

      const failure = await installing;
      expect(failure).toHaveProperty('code', 'conflict');
      expect(failure instanceof Error && failure.message).toContain(
        'Try again',
      );
      expect(await customFolders()).toEqual([]);
      expect((await save('other')).success).toBe(true);
      expect(await customFolders()).toEqual(['other']);
    },
    30_000,
  );

  test('a shared update of a receipt-bound name makes every cloud read before its first write', async () => {
    const events: string[] = [];
    await logSkillWrites(events, Promise.resolve());
    const served = serveCollectionPackage('helper', events);
    await bindHelperReceipt(() => {
      events.push('receipt lookup');
      return Promise.resolve({ owner: { type: 'user', id: 'u', name: null } });
    });
    const assertCurrent = (): Promise<void> => {
      events.push('re-check');
      return Promise.resolve();
    };

    await installCollection('shared update', served, assertCurrent);

    expect(
      fs.readFileSync(join(await customDir(), 'helper', 'SKILL.md'), 'utf8'),
    ).toContain('Packaged');
    const firstWrite = events.indexOf('reserved helper');
    expect(firstWrite).toBeGreaterThan(events.lastIndexOf('receipt lookup'));
    expect(firstWrite).toBeGreaterThan(events.lastIndexOf('re-check'));
    expect(events.indexOf('receipt lookup')).toBeGreaterThan(
      events.indexOf('blob fetched'),
    );
    // The in-lock re-check comes after the lookups, right before the write.
    expect(events.lastIndexOf('re-check')).toBeGreaterThan(
      events.lastIndexOf('receipt lookup'),
    );
  }, 30_000);

  test.each(CALLERS)(
    'a Collections %s refuses a planned name another writer takes first',
    async (caller) => {
      const custom = await customDir();
      jest.doMock('node:fs/promises', (): object => {
        const actual =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        let taken = false;
        return {
          ...actual,
          mkdir: async (
            ...args: Parameters<typeof actual.mkdir>
          ): Promise<string | undefined> => {
            if (args[0] === join(custom, 'helper') && !taken) {
              // An installer that takes no skill lock gets there first.
              taken = true;
              await actual.mkdir(join(custom, 'helper'), { recursive: true });
              await actual.writeFile(join(custom, 'helper', 'theirs'), 'x');
            }
            return actual.mkdir(...args);
          },
        };
      });
      const served = serveCollectionPackage('helper', []);

      await expect(installCollection(caller, served)).rejects.toThrow(
        `Couldn't reserve the folder name "helper": another skill change took it. Try again.`,
      );
      expect(await customFolders()).toEqual(['helper']);
      expect(fs.readdirSync(join(custom, 'helper'))).toEqual(['theirs']);
    },
    30_000,
  );

  test.each(['with', 'without'])(
    'a scoped import %s the skill lock installs a dependency and its provider twin into one folder',
    async (lock) => {
      await bindHelperReceipt(() =>
        Promise.resolve({ owner: { type: 'user', id: 'u', name: null } }),
      );
      const { download, blobs } = packageOf([
        { id: 'dep-claude', rootName: 'dep', body: 'Dep', provider: 'claude' },
        { id: 'dep-codex', rootName: 'dep', body: 'Dep', provider: 'codex' },
      ]);
      const detail: SharedSkillDetail = {
        id: 'rs',
        name: 'primary',
        description: '',
        contentHash: 'h',
        shareScope: 'private',
        owner: { type: 'user', id: 'u', name: null },
        createdBy: { id: 'u', name: null, email: null },
        createdAt: STAMP_25,
        updatedAt: STAMP_25,
        canUpdate: false,
        canDelete: false,
        publicShare: null,
        rawSkill: 'x',
      };
      const { installSubjectCapabilityPackage } =
        await import('../skill-package-install');
      const { runSkillMutation } = await import('../skill-mutations');

      await installSubjectCapabilityPackage({
        owner: { kind: 'skill', localId: 'primary' },
        originExternalId: 'rs',
        packageRef: { version: 1, digest: download.digest },
        download,
        fetchBlob: (sha256) => {
          const bytes = blobs.get(sha256);
          return bytes
            ? Promise.resolve(bytes)
            : Promise.reject(new Error('Unknown blob'));
        },
        skillContext: { snapshot: 'context', detail, reusableIds: new Set() },
        // With the lock, the serialized planner picks the names.
        ...(lock === 'with'
          ? { serializeMaterialization: runSkillMutation }
          : {}),
      });

      expect(await customFolders()).toEqual(['dep']);
    },
    30_000,
  );

  test.each(CALLERS)(
    'a Collections %s installs skills whose names differ only by case',
    async (caller) => {
      const served = serveCollectionPackage(
        'Helper',
        [],
        [{ rootName: 'helper', body: 'Other' }],
      );

      await installCollection(caller, served);

      // Two folders that stay distinct on a volume that ignores case, each
      // holding its own skill.
      const folders = await customFolders();
      expect(new Set(folders.map((name) => name.toLowerCase())).size).toBe(2);
      const custom = await customDir();
      const bodies = folders.map((name) =>
        fs.readFileSync(join(custom, name, 'SKILL.md'), 'utf8').trim(),
      );
      expect(bodies.map((body) => body.split('\n').pop()).sort()).toEqual([
        'Other',
        'Packaged',
      ]);
    },
    30_000,
  );

  test('a shared update whose check budget ran out starts no further receipt lookup', async () => {
    const served = serveCollectionPackage(
      'helper',
      [],
      [{ rootName: 'other', body: 'Other' }],
    );
    let lookups = 0;
    const answer = gate();
    await bindHelperReceipt(async () => {
      lookups += 1;
      await answer.opened;
      return { owner: { type: 'user', id: 'u', name: null } };
    }, ['other']);
    const budget = await holdCheckBudget();

    const installing = installCollection('shared update', served).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitUntil(
      () => lookups === 1 && budget.started(),
      10_000,
      'the first receipt lookup inside the budget',
    );
    budget.expire();
    expect(await installing).toBeInstanceOf(Error);
    answer.open();
    // The abandoned pass would start the next lookup right after this one.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(lookups).toBe(1);
    expect(await customFolders()).toEqual([]);
  }, 30_000);

  test('a shared update whose check budget runs out during a receipt read starts no lookup', async () => {
    const served = serveCollectionPackage('helper', []);
    let lookups = 0;
    await bindHelperReceipt(() => {
      lookups += 1;
      return Promise.resolve({ owner: { type: 'user', id: 'u', name: null } });
    });
    // The first account read inside the budget, before the receipt's lookup.
    // Mocked before holdCheckBudget loads the installer and its imports.
    const read = gate();
    let paused = false;
    let budgetStarted = (): boolean => false;
    jest.doMock('../../lib/canopy-cloud-account-store', (): object => ({
      ...jest.requireActual<object>('../../lib/canopy-cloud-account-store'),
      readCanopyCloudAccountWithStatus: async (): Promise<object> => {
        if (budgetStarted() && !paused) {
          paused = true;
          await read.opened;
        }
        return { status: 'ok', entry: { account: { id: 'acct' } } };
      },
    }));
    const budget = await holdCheckBudget();
    budgetStarted = (): boolean => budget.started();

    const installing = installCollection('shared update', served).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitUntil(() => paused, 10_000, 'the receipt read inside the budget');
    budget.expire();
    expect(await installing).toBeInstanceOf(Error);
    read.open();
    // The abandoned pass would start the lookup right after the read.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(lookups).toBe(0);
    expect(await customFolders()).toEqual([]);
  }, 30_000);

  test('a shared update whose check budget runs out during its revision read starts no live read', async () => {
    const served = serveCollectionPackage('helper', []);
    const budget = await holdCheckBudget();
    const { collectionMutationPorts } =
      await import('../../collections/collection-mutation-ports');
    const { applyCollectionUpdate } =
      await import('../../collections/collection-mutations');
    const config: CollectionConfig = {
      id: 'c011ec7e-0000-4000-8000-000000000001',
      name: 'Team kit',
      description: '',
      skills: [],
      plugins: [],
      mcpServers: [],
      createdAt: STAMP_25,
      updatedAt: STAMP_25,
      revision: 'r1',
      sharedSource: { remoteId: REMOTE, fetchedAt: STAMP_25 },
    };
    let liveReads = 0;
    // The first revision read inside the budget: the end-of-pass-1 re-check's.
    const read = gate();
    let paused = false;
    const updating = applyCollectionUpdate(
      { collectionId: config.id, expectedRevision: 'r1' },
      {
        ...collectionMutationPorts,
        captureContext: () => Promise.resolve('context'),
        assertContext: () => Promise.resolve(),
        read: async () => {
          if (budget.started() && !paused) {
            paused = true;
            await read.opened;
          }
          return config;
        },
        live: () => {
          liveReads += 1;
          return Promise.resolve({
            contentHash: served.contentHash,
            collection: {
              version: 1,
              name: 'Team kit',
              description: '',
              items: [],
            },
            customSkills: [],
            package: served.ref,
          });
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitUntil(
      () => paused,
      10_000,
      'the revision read inside the budget',
    );
    const before = liveReads;
    budget.expire();
    expect(await updating).toBeInstanceOf(Error);
    read.open();
    // The abandoned re-check would start its live read right after the read.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(liveReads).toBe(before);
    expect(await customFolders()).toEqual([]);
  }, 30_000);

  test.each(CALLERS)(
    'a Collections %s installs case-variant roots with the same SKILL.md into their own folders',
    async (caller) => {
      const served = serveCollectionPackage(
        'Helper',
        [],
        [
          {
            rootName: 'helper',
            skillName: 'Helper',
            body: 'Packaged',
            notes: 'two',
          },
        ],
      );

      await installCollection(caller, served);

      const folders = await customFolders();
      expect(new Set(folders.map((name) => name.toLowerCase())).size).toBe(2);
      const custom = await customDir();
      const notes = folders.map((name) =>
        fs.existsSync(join(custom, name, 'notes.md'))
          ? fs.readFileSync(join(custom, name, 'notes.md'), 'utf8')
          : 'none',
      );
      expect(notes.sort()).toEqual(['none', 'two']);
    },
    30_000,
  );

  test('an unlocked install keeps the files a save swaps into its reused folder', async () => {
    const custom = await customDir();
    // An existing `dep` with the package's exact SKILL.md, so it's reused.
    fs.mkdirSync(join(custom, 'dep'), { recursive: true });
    fs.writeFileSync(
      join(custom, 'dep', 'SKILL.md'),
      '---\nname: dep\ndescription: packaged\n---\nDep\n',
    );
    let swapped = false;
    jest.doMock('node:fs/promises', (): object => {
      const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        writeFile: async (
          ...args: Parameters<typeof actual.writeFile>
        ): Promise<void> => {
          await actual.writeFile(...args);
          // Right after the first provider tree adds its notes, a custom save
          // swaps the user's edited `dep` into place.
          if (args[0] === join(custom, 'dep', 'notes.md') && !swapped) {
            swapped = true;
            await actual.rename(join(custom, 'dep'), join(custom, '.old-dep'));
            await actual.mkdir(join(custom, 'dep'));
            await actual.writeFile(
              join(custom, 'dep', 'SKILL.md'),
              '---\nname: dep\ndescription: edited\n---\nEdited\n',
            );
            await actual.writeFile(join(custom, 'dep', 'notes.md'), 'mine');
          }
        },
      };
    });
    const { download, blobs } = packageOf([
      {
        id: 'dep-claude',
        rootName: 'dep',
        body: 'Dep',
        notes: 'package',
        provider: 'claude',
      },
      {
        id: 'dep-codex',
        rootName: 'dep',
        body: 'Dep',
        notes: 'package',
        provider: 'codex',
      },
    ]);
    const { installSubjectCapabilityPackage } =
      await import('../skill-package-install');

    const installed = await installSubjectCapabilityPackage({
      owner: { kind: 'skill', localId: 'primary' },
      packageRef: { version: 1, digest: download.digest },
      download,
      fetchBlob: (sha256) => {
        const bytes = blobs.get(sha256);
        return bytes
          ? Promise.resolve(bytes)
          : Promise.reject(new Error('Unknown blob'));
      },
    });

    expect(swapped).toBe(true);
    // The twin no longer matches the edited `dep`, so it takes `dep-2`.
    expect(
      installed.installedSkills.map((skill) => skill.localName).sort(),
    ).toEqual(['dep', 'dep-2']);
    expect((await customFolders()).sort()).toEqual(['dep', 'dep-2']);
    expect(fs.readFileSync(join(custom, 'dep', 'notes.md'), 'utf8')).toBe(
      'mine',
    );
    expect(fs.readFileSync(join(custom, 'dep', 'SKILL.md'), 'utf8')).toContain(
      'Edited',
    );
  }, 30_000);

  test('a shared update refuses a reused folder another writer changed during its checks', async () => {
    const custom = await customDir();
    // An existing `helper` with the package's exact SKILL.md, so it's planned for reuse.
    fs.mkdirSync(join(custom, 'helper'), { recursive: true });
    fs.writeFileSync(
      join(custom, 'helper', 'SKILL.md'),
      '---\nname: helper\ndescription: packaged\n---\nPackaged\n',
    );
    const events: string[] = [];
    await logSkillWrites(events, Promise.resolve());
    // The installer copies the bound resources last first, so `other` is
    // created before `helper` is re-checked and the refusal has one to undo.
    const served = serveCollectionPackage('helper', events, [
      { rootName: 'other', body: 'Other' },
    ]);
    // During the in-lock re-check, a writer without the lock edits `helper`.
    // Each blob fetch re-checks first, so only the call after both blobs is it.
    const assertCurrent = (): Promise<void> => {
      if (events.filter((event) => event === 'blob fetched').length === 2)
        fs.writeFileSync(
          join(custom, 'helper', 'SKILL.md'),
          '---\nname: helper\ndescription: edited\n---\nEdited\n',
        );
      return Promise.resolve();
    };

    await expect(
      installCollection('shared update', served, assertCurrent),
    ).rejects.toThrow(
      `Couldn't reserve the folder name "helper": another skill change took it. Try again.`,
    );
    // `other` was created, then rolled back; the edit is untouched.
    expect(events).toContain('reserved other');
    expect(await customFolders()).toEqual(['helper']);
    expect(fs.readdirSync(join(custom, 'helper'))).toEqual(['SKILL.md']);
    expect(
      fs.readFileSync(join(custom, 'helper', 'SKILL.md'), 'utf8'),
    ).toContain('Edited');
  }, 30_000);
});
