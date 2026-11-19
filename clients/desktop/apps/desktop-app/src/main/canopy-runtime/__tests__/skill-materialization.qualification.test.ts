import { loadMarketplacesCacheOnly } from '../../plugins/plugin-service';
import { readPluginCacheIndex } from '@canopy/execution-engine/node/plugins/catalog-read-health';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogSelectionUnavailableError } from '@canopy/core-runtime/node/catalog';
import { skillEntryId } from '@canopy/protocol/canopy-core';
import { INHERITED_PLUGIN_DEFAULTS_VERSION } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import type {
  ChatTabPluginSelections,
  ChatTabsFile,
  PreferencesData,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';

let mockDataDir = '';
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getDataDir: (): string => mockDataDir,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import {
  cursorSkillSourceDir,
  resolveSelectedSkillDirectory,
} from '../../plugins/plugin-resolver';
import { getSkillDir } from '../../skills/paths';
import {
  createDesktopMaterializationResolver,
  createDesktopWorkerCatalogHost,
  type DesktopMaterializationDeps,
} from '../catalog-materialization-host';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const origin = { kind: 'client', sourceId: 'test' } as const;
const owner = { kind: 'system', id: 'test' } as const;
const skill = (name: string): { sourceId: string; skillName: string } => ({
  sourceId: 'custom:app',
  skillName: name,
});

const selections = (
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections => ({
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
  ...overrides,
});

interface Fakes {
  stores: { preferences: string; workspace: string; tabs: string };
  deps: DesktopMaterializationDeps;
}

function fakes(): Fakes {
  const preferences: PreferencesData = {
    ...DEFAULT_PREFERENCES,
    globalPluginSelections: selections({
      skillRefs: [skill('a'), skill('b'), skill('c')],
    }),
  };
  const workspace: WorkspaceConfigFile = {
    version: 1,
    type: 'single-repo',
    repos: [],
  };
  const tabs: ChatTabsFile = {
    version: 1,
    activeTabId: 'chat',
    tabs: [
      {
        id: 'chat',
        title: 'Chat',
        messages: [],
        createdAt: '2026-11-05T00:00:00.000Z',
        inheritedPluginDefaultsVersion: INHERITED_PLUGIN_DEFAULTS_VERSION,
      },
    ],
  };
  const state = {
    stores: {
      preferences: JSON.stringify(preferences),
      workspace: JSON.stringify(workspace),
      tabs: JSON.stringify(tabs),
    },
  };
  const deps: DesktopMaterializationDeps = {
    readPreferences: () =>
      Promise.resolve({
        preferences: JSON.parse(state.stores.preferences) as PreferencesData,
        authority: 'ok',
      }),
    readWorkspaceConfig: () =>
      Promise.resolve({
        config: JSON.parse(state.stores.workspace) as WorkspaceConfigFile,
        authority: 'ok',
      }),
    readWorkspaceRevision: () => Promise.resolve(3),
    readChatTabs: () =>
      Promise.resolve(JSON.parse(state.stores.tabs) as ChatTabsFile),
    normalizeAccountSelections: (value) => Promise.resolve(value),
    normalizeAccountTombstones: (value) => Promise.resolve(value),
    loadMarketplacesCacheOnly: () =>
      Promise.resolve({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-11-05T00:00:00.000Z',
          marketplaces: [],
        },
      }),
    // What the real resolver returns when the installed-item policy disables b.
    resolveEffectiveRefs: (_value, warnings) =>
      Promise.resolve({
        disabledRefs: [{ kind: 'skill', ...skill('b') }],
        skillRefs: [skill('a'), skill('c')],
        pluginRefs: [],
        mcpServerRefs: [],
        warnings,
      }),
    resolvePluginRoot: () => Promise.resolve(null),
    realpath: (path) => Promise.resolve(path),
    readLockSnapshot: () =>
      Promise.resolve({ state: 'ok', entries: new Map() }),
    readSkillFile: (path) => readFile(path),
    skillExists: (path) => existsSync(path),
    resolveSkillDirectory: (ref, warnings) =>
      Promise.resolve(resolveSelectedSkillDirectory(ref, warnings)),
    canonicalSkillDirectory: (ref) =>
      Promise.resolve(cursorSkillSourceDir(ref)),
    describeMcpServer: () => Promise.resolve(null),
  };
  return Object.assign(state, { deps });
}

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher | null;

function start(
  f: Fakes,
  worker: Partial<DesktopMaterializationDeps> = {},
  resolver: Partial<DesktopMaterializationDeps> = {},
): DesktopCanopyDispatcher {
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
    workerCatalogHost: createDesktopWorkerCatalogHost({
      ...f.deps,
      ...worker,
    }),
    catalogMaterializationResolver: createDesktopMaterializationResolver({
      ...f.deps,
      ...resolver,
    }),
  });
  return runtime;
}

function writeSkill(name: string, body: string): string {
  const dir = getSkillDir('custom:app', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4124-'));
  mockDataDir = join(root, 'data');
  mkdirSync(join(mockDataDir, 'skills'), { recursive: true });
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = null;
});
afterEach(async () => {
  await runtime?.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('desktop skill materialization (CAN-4124)', () => {
  it.each([
    { state: 'damaged', content: '{' },
    { state: 'unsupported', content: '{"version":99}' },
  ])(
    'standalone skill materializes with a $state plugin index',
    async ({ state, content }) => {
      const indexPath = join(mockDataDir, 'plugin-cache-index.json');
      writeFileSync(indexPath, content);
      expect(readPluginCacheIndex(indexPath)).toMatchObject({
        state: 'valid',
        recovered: state,
      });
      expect((await loadMarketplacesCacheOnly()).success).toBe(true);
      const dir = writeSkill('a', '---\nname: a\n---\n');
      const f = fakes();
      f.deps.loadMarketplacesCacheOnly = jest.fn(loadMarketplacesCacheOnly);
      const desktop = start(f);
      const outcome = await desktop.catalogMaterializations.materialize({
        scope,
        origin,
        owner,
      });
      expect(outcome.state).toBe('ready');
      expect(outcome.effectiveItems).toEqual([
        { entryId: 'skill:custom:app/a', kind: 'skill' },
      ]);
      expect(
        desktop.catalogMaterializationReader.resolve(outcome.materializationId)
          ?.skills[0]?.sourceDir,
      ).toBe(dir);
      expect(f.deps.loadMarketplacesCacheOnly).not.toHaveBeenCalled();
      expect(await readFile(indexPath, 'utf8')).toBe(content);
    },
  );

  it('materializes only approved skills', async () => {
    const dir = writeSkill('a', '---\nname: a\n---\n');
    const desktop = start(fakes());
    const outcome = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.state).toBe('ready');
    expect(outcome.effectiveItems).toEqual([
      { entryId: 'skill:custom:app/a', kind: 'skill' },
    ]);
    expect(outcome.unavailable).toEqual(
      expect.arrayContaining([
        { entryId: skillEntryId(skill('b')), reason: 'disabled' },
        { entryId: skillEntryId(skill('c')), reason: 'missing' },
      ]),
    );
    expect(
      desktop.catalogMaterializationReader.resolve(outcome.materializationId)
        ?.skills[0]?.sourceDir,
    ).toBe(dir);
  });

  it('a refused skill context admits nothing', async () => {
    writeSkill('a', '---\nname: a\n---\n');
    const desktop = start(
      fakes(),
      {},
      {
        resolveEffectiveRefs: () =>
          Promise.reject(new Error('Skill unavailable (access-removed)')),
      },
    );
    await expect(
      desktop.catalogMaterializations.materialize({ scope, origin, owner }),
    ).rejects.toBeInstanceOf(CatalogSelectionUnavailableError);
    const ledger = await operations.service.ready();
    expect(
      ledger.list({ kinds: ['core.catalog.materialization'], limit: 10 }).items,
    ).toEqual([]);
  });

  it('an edited skill gets a new identity', async () => {
    writeSkill('a', '---\nname: a\n---\nfirst\n');
    const desktop = start(fakes());
    const first = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });
    writeSkill('a', '---\nname: a\n---\nsecond\n');
    const second = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });
    expect(second.materializationId).not.toBe(first.materializationId);
  });

  it('a skill edited between resolution and materialization fails closed', async () => {
    writeSkill('a', '---\nname: a\n---\n');
    const f = fakes();
    const before = { ...f.stores };
    const outcome = await start(f, {
      readSkillFile: () => Promise.resolve(Buffer.from('other bytes')),
    }).catalogMaterializations.materialize({ scope, origin, owner });

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatchObject({
      code: 'worker.catalog.revisionConflict',
    });
    expect(f.stores).toEqual(before);
  });

  it('an unreadable lock does not stop materialization', async () => {
    writeSkill('a', '---\nname: a\n---\n');
    const unreadable = (): Promise<{ state: 'unreadable' }> =>
      Promise.resolve({ state: 'unreadable' });
    const outcome = await start(
      fakes(),
      { readLockSnapshot: unreadable },
      { readLockSnapshot: unreadable },
    ).catalogMaterializations.materialize({ scope, origin, owner });

    expect(outcome.state).toBe('ready');
    expect(outcome.effectiveItems).toEqual([
      { entryId: 'skill:custom:app/a', kind: 'skill' },
    ]);
  });
});
