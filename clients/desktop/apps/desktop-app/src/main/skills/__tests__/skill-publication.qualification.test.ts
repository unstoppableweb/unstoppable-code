// CAN-4484 golden: custom skill publication's local stores, qualified under
// their current owner, Electron main: the skills' share links and the
// cloud-copy consents. It drives the real skill service and consent store on
// a data root the suite owns; only GitHub, the feature flags and logging are
// replaced. Each case starts a fresh module, as a restart does.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from '../../lib/paths';
import type * as AtomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import type * as DamagedCopies from '@canopy/execution-engine/node/lib/damaged-copies';
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
let ownedRoot = '';
beforeAll(() => {
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
});

afterEach(() => {
  jest.dontMock('node:fs');
  jest.dontMock('@canopy/execution-engine/node/lib/damaged-copies');
  jest.dontMock('@canopy/execution-engine/node/lib/atomic-file');
  jest.dontMock('../../canopy-cloud/client');
  jest.dontMock('../canopy-server-client');
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
