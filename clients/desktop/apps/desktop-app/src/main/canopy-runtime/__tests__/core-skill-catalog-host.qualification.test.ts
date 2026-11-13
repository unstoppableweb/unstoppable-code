import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  CATALOG_CUSTOM_SKILL_SOURCE_ID,
  CatalogMutationRuns,
  createCoreSkillCatalogHandlers,
} from '@canopy/core-runtime/node/catalog';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
  skillEntryId,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';

let mockDataDir = '';
let mockBundledDir = '';
const mockTree: { path: string; type: 'blob' | 'tree'; sha: string }[] = [];
const mockFiles = new Map<string, string>();
const mockHttpsGetBuffer = jest.fn((url: string): Promise<Buffer> => {
  for (const [path, text] of mockFiles)
    if (url.endsWith(`/${path}`)) return Promise.resolve(Buffer.from(text));
  return Promise.reject(new Error(`no fixture for ${url}`));
});
let mockAudit: (() => Promise<string>) | null = null;
const mockFetchGitHubTree = jest.fn(() =>
  Promise.resolve({ tree: mockTree, resolvedBranch: 'main', treeSha: 'root' }),
);

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getDataDir: (): string => mockDataDir,
}));
jest.mock('../../pipelines/config-paths', () => ({
  ...jest.requireActual<object>('../../pipelines/config-paths'),
  getBundledSkillsDir: (): string => mockBundledDir,
  getBundledSkillDir: (name: string): string => join(mockBundledDir, name),
}));
jest.mock('../../skills/skill-discovery', () => ({
  getGitHubToken: (): Promise<null> => Promise.resolve(null),
  fetchGitHubTree: (): unknown => mockFetchGitHubTree(),
  discoverSkillsFromGitHub: (): Promise<unknown> =>
    Promise.resolve({
      skills: [{ name: 'x', description: 'X skill', sourcePath: 'skills/x' }],
      resolvedBranch: 'main',
      hasMarketplace: false,
    }),
}));
jest.mock('../../lib/http', () => ({
  httpsGetBuffer: (url: string): Promise<Buffer> => mockHttpsGetBuffer(url),
  httpsGet: (): Promise<string> =>
    mockAudit ? mockAudit() : Promise.reject(new Error('offline')),
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

import { CUSTOM_SOURCE_ID, getSkillDir } from '../../skills/paths';
import * as skillService from '../../skills/skill-service';
import { removeSkill, saveCustomSkill } from '../../skills/skill-service';
import { runSkillMutation } from '../../skills/skill-mutations';
import * as skillContext from '../../skills/skill-install-context';
import { readSkillLockSnapshot } from '../../skills/skill-lock-snapshot';
import { createDesktopSkillCatalogHost } from '../core-skill-catalog-host';
import type { InstalledSkillInfo } from '@canopy/protocol/skills';

const caller = (
  grant: CanopyCallerDescriptor['grants'][number],
): CanopyCallerDescriptor => ({
  principalId: 'p',
  clientInstanceId: 'c',
  authorityId: 'a',
  interfaceKind: 'desktop',
  grants: [grant],
});
const reader = caller('core.catalog.read');
const writer = caller('core.catalog.write');
const keyed = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});

let root: string;
let operations: OperationService;
let refreshInventory: jest.Mock;

const skillsDir = (): string => join(mockDataDir, 'skills');
const lockPath = (): string => join(skillsDir(), 'skills-lock.json');

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the dispatcher type is inferred from its definitions
function compose(
  overrides: Parameters<typeof createDesktopSkillCatalogHost>[0] = {},
) {
  const runs = new CatalogMutationRuns({ operations });
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
      instructions: CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      ...createCoreSkillCatalogHandlers({
        host: createDesktopSkillCatalogHost({ refreshInventory, ...overrides }),
        runs,
      }),
      streams: {},
    },
  });
}

async function saveCustom(name: string): Promise<void> {
  const result = await saveCustomSkill({
    name,
    description: `${name} skill`,
    body: 'Body',
  });
  expect(result.success).toBe(true);
}

function writeInstalled(): void {
  const dir = getSkillDir('github:o:r', 'x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: X\n---\n');
  writeFileSync(
    lockPath(),
    JSON.stringify({
      version: 2,
      skills: {
        'github:o:r/x': {
          sourceId: 'github:o:r',
          source: 'o/r',
          sourceType: 'github',
          sourceUrl: 'https://github.com/o/r',
          skillPath: 'skills/x',
          skillFolderHash: 'abc',
          installedAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      },
    }),
  );
}

function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const stat = statSync(child);
      out.push(`${child}:${stat.size}:${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(child);
    }
  };
  walk(dir);
  return out;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4124-'));
  mockDataDir = join(root, 'data');
  mockBundledDir = join(root, 'bundled');
  mkdirSync(join(mockBundledDir, 'b'), { recursive: true });
  writeFileSync(
    join(mockBundledDir, 'b', 'SKILL.md'),
    '---\nname: b\ndescription: Built-in\n---\nBuilt-in body\n',
  );
  mkdirSync(skillsDir(), { recursive: true });
  mockTree.length = 0;
  mockFiles.clear();
  mockAudit = null;
  mockHttpsGetBuffer.mockClear();
  mockFetchGitHubTree.mockClear();
  refreshInventory = jest.fn();
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('desktop skill catalog host (CAN-4124)', () => {
  it('lists built-in, custom and installed skills with their lock version', async () => {
    await saveCustom('c');
    writeInstalled();
    const { skills } = await compose().query(
      'core.catalog.skill.list',
      {},
      { caller: reader },
    );
    const byName = new Map(skills.map((row) => [row.skillName, row]));
    expect(byName.get('b')).toMatchObject({
      origin: 'builtin',
      entryId: skillEntryId({ sourceId: 'builtin:app', skillName: 'b' }),
      version: null,
    });
    expect(byName.get('c')).toMatchObject({
      origin: 'custom',
      entryId: skillEntryId({ sourceId: 'custom:app', skillName: 'c' }),
      version: null,
    });
    expect(byName.get('x')).toMatchObject({
      origin: 'installed',
      entryId: skillEntryId({ sourceId: 'github:o:r', skillName: 'x' }),
      version: { skillFolderHash: 'abc', skillPath: 'skills/x' },
    });
  });

  it('links a skill to its cloud copy by ids and hashes, preferring the author share (CAN-6176)', async () => {
    await saveCustom('c');
    await saveCustom('d');
    const sha = (text: string): string =>
      createHash('sha256').update(text, 'utf8').digest('hex');
    const custom = sha(await skillService.readRawSkill('custom:app/c'));
    const received = sha(await skillService.readRawSkill('custom:app/d'));
    const loadSkills: typeof skillService.loadSkills = () => {
      const loaded = skillService.loadSkills();
      if (!loaded.success || loaded.data === undefined) return loaded;
      return {
        success: true,
        data: loaded.data.map(
          (row): InstalledSkillInfo =>
            row.name === 'c'
              ? {
                  ...row,
                  remote: {
                    remoteId: 'author-share',
                    contentHash: custom,
                    shareScope: 'private',
                    sharedAt: '2026-11-10T00:00:00.000Z',
                    publicLink: 'https://example.com/s/secret-link',
                  },
                  installedFromShare: {
                    remoteId: 'ignored',
                    contentHash: custom,
                  },
                }
              : row,
        ),
      };
    };
    // The recipient link comes only from the install receipts the host reads.
    const annotateSharedSkillInstalls: typeof skillContext.annotateSharedSkillInstalls =
      (rows) =>
        Promise.resolve(
          rows.map((row) =>
            row.name === 'd'
              ? { ...row, installedFromShare: { remoteId: 'recipient-share' } }
              : row,
          ),
        );
    const { skills } = await compose({
      service: { ...skillService, loadSkills },
      context: { ...skillContext, annotateSharedSkillInstalls },
    }).query('core.catalog.skill.list', {}, { caller: reader });
    const byName = new Map(skills.map((row) => [row.skillName, row]));
    expect(byName.get('c')?.cloudShare).toEqual({
      role: 'author',
      remoteId: 'author-share',
      linkedContentHash: custom,
      localContentHash: custom,
    });
    expect(byName.get('d')?.cloudShare).toEqual({
      role: 'recipient',
      remoteId: 'recipient-share',
      linkedContentHash: null,
      localContentHash: received,
    });
    expect(byName.get('b')?.cloudShare).toBeUndefined();
  });

  it('still lists skills when the install receipts cannot be read, without recipient links (CAN-6176)', async () => {
    await saveCustom('d');
    const unreadable = await compose({
      context: {
        ...skillContext,
        annotateSharedSkillInstalls: () =>
          Promise.reject(new Error('receipts unreadable')),
      },
    }).query('core.catalog.skill.list', {}, { caller: reader });
    const listed = new Map(
      unreadable.skills.map((row) => [row.skillName, row]),
    );
    expect(listed.get('d')?.origin).toBe('custom');
    expect(listed.get('d')?.cloudShare).toBeUndefined();
  });

  it('reads frontmatter past the old bound and leaves out only values past the wire bound (CAN-5873)', async () => {
    const dir = getSkillDir(CATALOG_CUSTOM_SKILL_SOURCE_ID, 'big');
    mkdirSync(dir, { recursive: true });
    const notes = 'n'.repeat(40_000);
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: big\ndescription: Big\nnotes: ${notes}\nhuge: ${'h'.repeat(300_000)}\n---\nBody\n`,
    );
    const read = await compose().query(
      'core.catalog.skill.read',
      { skill: { sourceId: CATALOG_CUSTOM_SKILL_SOURCE_ID, skillName: 'big' } },
      { caller: reader },
    );
    expect(read.frontmatter).toEqual({
      name: 'big',
      description: 'Big',
      notes,
    });
    expect(read.body).toBe('Body\n');
    expect(read.truncated).toBe(true);
  });

  it('refuses traversal and symlinked skill directories on every read', async () => {
    const dispatcher = compose();
    const traversal = { sourceId: '..', skillName: 'x' };
    const pathInvalid = {
      payload: {
        kind: 'invalid_argument',
        code: 'core.catalog.skillPathInvalid',
      },
    };
    await expect(
      dispatcher.query(
        'core.catalog.skill.read',
        { skill: traversal },
        { caller: reader },
      ),
    ).rejects.toMatchObject(pathInvalid);
    await expect(
      dispatcher.query(
        'core.catalog.skill.files.list',
        { skill: traversal },
        { caller: reader },
      ),
    ).rejects.toMatchObject(pathInvalid);
    await expect(
      dispatcher.query(
        'core.catalog.skill.file.read',
        { skill: traversal, filePath: 'SKILL.md' },
        { caller: reader },
      ),
    ).rejects.toMatchObject(pathInvalid);

    await saveCustom('c');
    const custom = { sourceId: 'custom:app', skillName: 'c' };
    await expect(
      dispatcher.query(
        'core.catalog.skill.file.read',
        { skill: custom, filePath: '../../skills-lock.json' },
        { caller: reader },
      ),
    ).rejects.toMatchObject(pathInvalid);

    if (process.platform === 'win32') return;
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'SKILL.md'), 'secret');
    const customDir = getSkillDir('custom:app', 'c');
    rmSync(customDir, { recursive: true, force: true });
    symlinkSync(outside, customDir);
    await expect(
      dispatcher.query(
        'core.catalog.skill.files.list',
        { skill: custom },
        { caller: reader },
      ),
    ).rejects.toMatchObject(pathInvalid);
    const read = await rejection(
      dispatcher.query(
        'core.catalog.skill.file.read',
        { skill: custom, filePath: 'SKILL.md' },
        { caller: reader },
      ),
    );
    expect(read).toMatchObject(pathInvalid);
    expect(JSON.stringify(read)).not.toContain('secret');
  });

  it('refuses to update a built-in skill and touches no file', async () => {
    const before = listing(mockDataDir);
    await expect(
      compose().instruction(
        'core.catalog.skill.update',
        {
          skill: { sourceId: 'builtin:app', skillName: 'b' },
          _meta: keyed('k'),
        },
        { caller: writer, metadata: keyed('k') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.catalog.skillReadOnly',
      },
    });
    expect(listing(mockDataDir)).toEqual(before);
    expect(mockFetchGitHubTree).not.toHaveBeenCalled();
  });

  it('saves a custom skill through the skill mutation lock', async () => {
    expect(CATALOG_CUSTOM_SKILL_SOURCE_ID).toBe(CUSTOM_SOURCE_ID);
    let release: () => void = () => undefined;
    const held = runSkillMutation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const save = compose().instruction(
      'core.catalog.skill.custom.save',
      {
        name: 'n',
        originalName: null,
        description: 'N skill',
        body: 'Body',
        extraMetadata: null,
        preservedMetadata: null,
        files: null,
        _meta: keyed('k'),
      },
      { caller: writer, metadata: keyed('k') },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const skillMd = join(getSkillDir('custom:app', 'n'), 'SKILL.md');
    expect(() => statSync(skillMd)).toThrow();
    expect(removeSkill('custom:app', 'other')).toEqual({
      success: false,
      error:
        'Skill unavailable (local-conflict). Another skill change is in progress. Try again.',
    });
    release();
    await held;
    await expect(save).resolves.toEqual({
      entryId: 'skill:custom:app/n',
      skillName: 'n',
    });
    expect(readFileSync(skillMd, 'utf8')).toContain('description: N skill');
  });

  it('removes a custom skill once per key', async () => {
    await saveCustom('c');
    const dispatcher = compose();
    const remove = (): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.skill.remove',
        {
          skill: { sourceId: 'custom:app', skillName: 'c' },
          _meta: keyed('k'),
        },
        { caller: writer, metadata: keyed('k') },
      );
    const first = await remove();
    await expect(remove()).resolves.toEqual(first);
    expect(() => statSync(getSkillDir('custom:app', 'c'))).toThrow();
    expect(refreshInventory).toHaveBeenCalledTimes(1);
    expect(refreshInventory).toHaveBeenCalledWith('skills:remove');
  });

  it('installs from GitHub once per key and records the tree SHA as the lock version', async () => {
    mockTree.push(
      { path: 'skills/x', type: 'tree', sha: 't1' },
      { path: 'skills/x/SKILL.md', type: 'blob', sha: 's1' },
      { path: 'skills/x/run.sh', type: 'blob', sha: 's2' },
    );
    mockFiles.set('skills/x/SKILL.md', '---\nname: x\ndescription: X\n---\n');
    mockFiles.set('skills/x/run.sh', 'echo x\n');
    const dispatcher = compose();
    const install = (): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.skill.install',
        { source: 'o/r', skillNames: ['x'], _meta: keyed('k') },
        { caller: writer, metadata: keyed('k') },
      );
    const expected = {
      sourceId: 'github:o:r',
      entryIds: ['skill:github:o:r/x'],
      installedCount: 1,
    };
    await expect(install()).resolves.toEqual(expected);
    await expect(install()).resolves.toEqual(expected);
    expect(mockHttpsGetBuffer).toHaveBeenCalledTimes(2);
    const lock = await readSkillLockSnapshot();
    expect(lock.state).toBe('ok');
    expect(
      lock.state === 'ok' ? lock.entries.get('github:o:r/x') : null,
    ).toMatchObject({ skillFolderHash: 't1' });

    await expect(
      dispatcher.instruction(
        'core.catalog.skill.updates.check',
        { _meta: keyed('check') },
        { caller: writer, metadata: keyed('check') },
      ),
    ).resolves.toEqual({ updates: [], checkedCount: 1, updateCount: 0 });
  });

  it('discovery returns the audit result and an audit failure stays non-blocking', async () => {
    const dispatcher = compose();
    mockAudit = (): Promise<string> =>
      Promise.resolve(JSON.stringify({ x: { socket: { alerts: 2 } } }));
    const audited = await dispatcher.query(
      'core.catalog.skill.discover',
      { source: 'o/r' },
      { caller: reader },
    );
    expect(audited.riskInfo.x).toEqual({ level: 'high', socketAlerts: 2 });

    mockAudit = (): Promise<string> => Promise.reject(new Error('audit down'));
    const unaudited = await dispatcher.query(
      'core.catalog.skill.discover',
      { source: 'o/r' },
      { caller: reader },
    );
    expect(unaudited.riskInfo).toEqual({});
    expect(unaudited.skills.map((skill) => skill.name)).toEqual(['x']);
  });

  it('keeps a guard refusal as the thrown cause', async () => {
    await saveCustom('c');
    const refusal = new Error('Skill unavailable (access-removed)');
    const error = await rejection(
      compose({
        context: {
          ...skillContext,
          assertStoredSkillContext: () => Promise.reject(refusal),
        },
      }).instruction(
        'core.catalog.skill.remove',
        {
          skill: { sourceId: 'custom:app', skillName: 'c' },
          _meta: keyed('k'),
        },
        { caller: writer, metadata: keyed('k') },
      ),
    );
    expect(error).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.catalog.skillContextRefused',
      },
    });
    expect(error).toHaveProperty('runtimeCause', refusal);
    expect(statSync(getSkillDir('custom:app', 'c')).isDirectory()).toBe(true);
  });

  it('the lock snapshot never writes', async () => {
    const v1 = JSON.stringify({ version: 1, skills: {} });
    writeFileSync(lockPath(), v1);
    await expect(readSkillLockSnapshot()).resolves.toEqual({
      state: 'unreadable',
    });
    expect(readFileSync(lockPath(), 'utf8')).toBe(v1);

    writeFileSync(lockPath(), '{ not json');
    await expect(readSkillLockSnapshot()).resolves.toEqual({
      state: 'unreadable',
    });
    expect(readFileSync(lockPath(), 'utf8')).toBe('{ not json');

    rmSync(lockPath());
    const absent = await readSkillLockSnapshot();
    expect(absent.state).toBe('ok');
    expect(absent.state === 'ok' ? absent.entries.size : -1).toBe(0);
    expect(() => statSync(lockPath())).toThrow();
  });
});
