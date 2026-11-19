import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type StandaloneArchiveSnapshotFile,
} from '@canopy/desktop-shared/types';
import { undoSplitChatsAndPlansMigration } from '../lib/split-temporary-workspace-items';
import { removePlanExploreChat } from '../lib/plan-explore-cleanup';
import * as liveCleanup from '../lib/worktree-live-cleanup';
import { ChatSearchService } from '../chat-search/service';
import {
  resolveChatTabsFilePath,
  resolveChatArchivesFilePath,
  resolveChatJournalFilePath,
} from '../lib/resolve-worktree';
import { resetResolvedCanopyDataDirForTests } from '@canopy/execution-engine/canopy-paths';
import { registerIpcHandler } from '../ipc/register';
import { registerStandaloneChatHandlers } from '../ipc/standalone-chat';
import {
  flushMarketplaceSelectionPruneForTests,
  removeMarketplace,
} from '../plugins/plugin-service';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStorageNewerFormatError } from '../lib/chat-delta-journal/format';
import {
  ChatDeltaJournalWriter,
  demoteFromDeltaJournal,
  promoteToDeltaJournal,
  removeStrayDeltaJournal,
} from '../lib/chat-delta-journal/writer';
import { readChatStorageDiscoveryIndex } from '../lib/chat-storage-discovery';
import { scanInterruptedWork } from '../lib/interrupted-work-scan-worker';
import { normalizeWorkspaceChatsForInheritedPluginDefaults } from '../lib/inherited-plugin-defaults-normalization';
import {
  rewriteMcpServerRefs,
  MCP_SERVER_REF_REWRITE_INCOMPLETE,
} from '../mcp/server-ref-rewrite';
import {
  hasEverSentChatMessage,
  resetChatHistoryScanForTests,
} from '../lib/chat-history-scan';
import {
  readArchiveListing,
  writeArchiveSnapshot,
} from '../lib/standalone-history';
import {
  listWorkEntryIds,
  readWorkEntryChatCatalog,
  summarySourcePath,
} from '../lib/cowork-work-entries';
import {
  getWorkspaceChatHistoryRootDir,
  getWorkspaceDir,
  getWorkspaceWorkEntriesFilePath,
  getWorkspacesRootDir,
} from '../lib/paths';
import { listHistoryChatIds } from '../lib/standalone-history-index';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import {
  ChatStateRepositoryLoadError,
  type ChatScopeKey,
  type ScopePaths,
} from '../services/chat-state-contracts';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type * as StandaloneHistoryIndexModule from '../lib/standalone-history-index';
import { format4Scope } from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import { drainOpenRepositories } from './helpers/chat-delta-journal-scope';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): never[] => [] },
  dialog: { showOpenDialog: jest.fn() },
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/chat-project-utils', () => ({
  ensureChatProjectDir: jest.fn().mockResolvedValue(undefined),
  ensureCoworkHomeScaffold: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/standalone-history-index', () => {
  const actual = jest.requireActual<typeof StandaloneHistoryIndexModule>(
    '../lib/standalone-history-index',
  );
  return {
    ...actual,
    rebuildHistoryIndex: jest.fn().mockResolvedValue([]),
  };
});
jest.mock('../agents/claude-process-host-runner', () => ({
  runClaudeCliProcessOffMain: jest
    .fn()
    .mockRejectedValue(new Error('marketplace not found')),
}));
jest.mock('../plugins/codex-marketplace-service', () => ({
  addCodexMarketplace: jest.fn(),
  codexMarketplaceManifestPath: jest.fn(),
  installCodexPlugin: jest.fn(),
  isStructuralCodexMarketplaceFailure: jest.fn(),
  listCodexPlugins: jest.fn(),
  readCodexMarketplaceInstallMetadata: jest.fn(),
  removeCodexMarketplace: jest
    .fn()
    .mockResolvedValue({ accepted: true, alreadySatisfied: true }),
  resolveCodexPluginInstallRoots: jest.fn(),
  upgradeCodexMarketplace: jest.fn(),
}));

const PROJECT_ID = 'manifest-v4-workspace';
const SCOPE_ID = 'scope-v4';
const ENTRY_ID = 'entry-v4';
const ARCHIVE_ID = 'archive-v4';
const ENTRY_ARCHIVE_ID = 'expired-entry-archive';
const EXPIRED_AT = '2000-01-01T00:00:00.000Z';
const CURRENT_AT = '2026-10-01T00:00:00.000Z';

interface FileSnapshot {
  relativePath: string;
  size: number;
  sha256: string;
  mtimeMs: number;
}

interface Fixture {
  dataDir: string;
  workspaceRoot: string;
  historyScopeRoot: string;
  scope: ChatScopeKey;
  entryScope: ChatScopeKey;
  resolvePaths: (scope: ChatScopeKey) => ScopePaths;
}

let fixture: Fixture | undefined;
let activeService: ChatStateService | undefined;
let previousDataDir: string | undefined;
let capturedPreviousDataDir = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function snapshotFiles(
  root: string,
  ignoredDirectory?: string,
): Promise<FileSnapshot[]> {
  const files: FileSnapshot[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (directory === root && entry.name === ignoredDirectory) continue;
        await visit(absolute);
      } else if (entry.isFile()) {
        const [bytes, info] = await Promise.all([
          readFile(absolute),
          stat(absolute),
        ]);
        files.push({
          relativePath: absolute.slice(root.length + 1),
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mtimeMs: info.mtimeMs,
        });
      }
    }
  };
  await visit(root);
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function expectNoStorageChanges(
  root: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  // Diagnostics flushed late by an earlier step in the same test are not
  // storage; every other file under the root must stay byte-identical. Prune
  // them before traversal: a flush can rename its temp file after readdir.
  const storageFiles = (): Promise<FileSnapshot[]> =>
    snapshotFiles(root, 'agent-observability');
  const before = await storageFiles();
  await operation();
  const after = await storageFiles();
  const beforePaths = new Set(before.map((file) => file.relativePath));
  expect(after.filter((file) => !beforePaths.has(file.relativePath))).toEqual(
    [],
  );
  expect(after).toEqual(before);
}

function scopePaths(root: string, scopeId: string): ScopePaths {
  return {
    tabs: join(root, 'chats', `${scopeId}.json`),
    archives: join(root, 'chat-archives', `${scopeId}.json`),
    journal: join(root, 'chat-journals', `${scopeId}.jsonl`),
  };
}

function makeRepository(target: Fixture): ChatStateV2Repository {
  return new ChatStateV2Repository({
    deltaJournalIdleCheckpointMs: 3_600_000,
    resolvePaths: target.resolvePaths,
  });
}

function installFreshService(target: Fixture): ChatStateV2Repository {
  const repository = makeRepository(target);
  activeService = new ChatStateService({ repository });
  resetChatStateServiceForTests(activeService);
  return repository;
}

async function seedManifestVersion(
  root: string,
  scopeId: string,
  version: 4 | 5,
): Promise<void> {
  const manifestPath = join(root, 'chat-storage-manifests', `${scopeId}.json`);
  const original = await readFile(manifestPath, 'utf8');
  const parsedOriginal: unknown = JSON.parse(original);
  if (!isRecord(parsedOriginal))
    throw new Error('Expected a chat-storage manifest');
  expect([2, 3]).toContain(parsedOriginal.version);
  const changed = original.replace(
    /("version"\s*:\s*)[23](?=\s*[,}])/,
    (_match, prefix: string): string => `${prefix}${String(version)}`,
  );
  expect(changed).not.toBe(original);
  expect(
    changed.replace(
      new RegExp(`("version"\\s*:\\s*)${String(version)}(?=\\s*[,}])`),
      (_match, prefix: string): string =>
        `${prefix}${String(parsedOriginal.version)}`,
    ),
  ).toBe(original);
  const parsed: unknown = JSON.parse(changed);
  if (!isRecord(parsed)) throw new Error('Expected a chat-storage manifest');
  expect(parsed.version).toBe(version);
  await writeFile(manifestPath, changed, 'utf8');
}

async function prepareFixture(
  options: { newerManifest?: boolean; manifestVersion?: 4 | 5 } = {},
): Promise<Fixture> {
  if (!capturedPreviousDataDir) {
    previousDataDir = process.env.CANOPY_DATA_DIR;
    capturedPreviousDataDir = true;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'chat-storage-manifest-v4-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  resetResolvedCanopyDataDirForTests();
  resetChatStateServiceForTests();
  resetChatHistoryScanForTests();

  const workspaceRoot = getWorkspaceDir(PROJECT_ID);
  const historyRoot = getWorkspaceChatHistoryRootDir(PROJECT_ID);
  const historyScopeRoot = join(historyRoot, ARCHIVE_ID);
  const scope: ChatScopeKey = { projectId: PROJECT_ID, worktreeId: SCOPE_ID };
  const entryScope: ChatScopeKey = {
    projectId: PROJECT_ID,
    worktreeId: ENTRY_ID,
  };
  const resolvePaths = (value: ChatScopeKey): ScopePaths => {
    return scopePaths(workspaceRoot, value.worktreeId);
  };
  const result: Fixture = {
    dataDir,
    workspaceRoot,
    historyScopeRoot,
    scope,
    entryScope,
    resolvePaths,
  };
  const repository = makeRepository(result);
  for (const value of [scope, entryScope]) {
    const chatId = `${value.worktreeId}-chat`;
    await repository.replaceCompatibilityTabs(
      value,
      {
        version: 1,
        activeTabId: chatId,
        tabs: [
          {
            id: chatId,
            title: 'Manifest fixture',
            createdAt: CURRENT_AT,
            providerType: 'claude',
            messages: [
              message(`${chatId}-reader`, 'format-four lane payload', 'user'),
            ],
          },
        ],
      },
      { authoritative: true },
    );
  }
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    join(workspaceRoot, 'workspace.json'),
    JSON.stringify(
      {
        version: 1,
        type: 'cowork',
        repos: [],
        cowork: { archiveRetentionDays: 1 },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(
    getWorkspaceWorkEntriesFilePath(PROJECT_ID),
    JSON.stringify(
      {
        version: 1,
        entries: [{ id: ENTRY_ID, createdAt: CURRENT_AT }],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // Seed a real expired standalone archive through its production writer. The
  // writer migrates the legacy conversation into the history scope's archive
  // index before the manifest is changed below.
  await mkdir(historyScopeRoot, { recursive: true });
  const standaloneSnapshot: StandaloneArchiveSnapshotFile = {
    version: 1,
    projectId: PROJECT_ID,
    chatId: ARCHIVE_ID,
    archivedAt: EXPIRED_AT,
    tab: {
      id: ARCHIVE_ID,
      title: 'Expired archive',
      createdAt: CURRENT_AT,
      messages: [],
    },
  };
  await writeFile(
    join(historyScopeRoot, 'conversation.json'),
    JSON.stringify(standaloneSnapshot, null, 2) + '\n',
    'utf8',
  );
  await writeArchiveSnapshot(PROJECT_ID, ARCHIVE_ID, standaloneSnapshot);
  await writeFile(
    join(historyScopeRoot, 'meta.json'),
    JSON.stringify(
      {
        version: 1,
        id: ARCHIVE_ID,
        title: 'Expired archive',
        createdAt: CURRENT_AT,
        archived: true,
        archivedAt: EXPIRED_AT,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  const archiveTab = {
    id: ENTRY_ARCHIVE_ID,
    title: 'Expired Work Entry archive',
    createdAt: CURRENT_AT,
    messages: [],
  };
  await repository.transact(
    entryScope,
    [
      {
        type: 'archive.upserted',
        entry: {
          tab: archiveTab,
          archivedAt: EXPIRED_AT,
          turnCount: 1,
        },
      },
    ],
    { source: 'import', mutationId: 'seed-expired-entry-archive' },
  );
  await repository.drainAll();

  for (const [root, scopeId] of [
    [workspaceRoot, SCOPE_ID],
    [workspaceRoot, ENTRY_ID],
    [historyScopeRoot, ARCHIVE_ID],
  ]) {
    const manifest: unknown = JSON.parse(
      await readFile(
        join(root, 'chat-storage-manifests', `${scopeId}.json`),
        'utf8',
      ),
    );
    if (!isRecord(manifest))
      throw new Error('Fixture manifest was not an object');
    expect([2, 3]).toContain(manifest.version);
  }

  // Legacy family sentinels prove an unknown manifest cannot resume migration
  // cleanup. They are added before changing the manifest version.
  for (const [root, scopeId] of [[workspaceRoot, SCOPE_ID]]) {
    for (const relativePath of [
      join('chats', `${scopeId}.json`),
      join('chat-archives', `${scopeId}.json`),
      join('chat-journals', `${scopeId}.jsonl`),
    ]) {
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `legacy sentinel: ${relativePath}\n`, 'utf8');
    }
  }

  if (options.newerManifest !== false) {
    const version = options.manifestVersion ?? 5;
    if (version === 4) {
      for (const [root, scopeId] of [
        [workspaceRoot, SCOPE_ID, `${SCOPE_ID}-chat`],
        [workspaceRoot, ENTRY_ID, `${ENTRY_ID}-chat`],
        [historyScopeRoot, ARCHIVE_ID, ARCHIVE_ID],
      ]) {
        const backend = new ChatStateV2Backend(
          new ChatStorageV2(root, scopeId),
          {
            deltaJournal: {},
            enableFormat4: true,
          },
        );
        await backend.promoteToDeltaJournal();
        await backend.promoteToFormat4();
        // Promotion owns an open journal writer. Flush the prepared fixture
        // and release it before readers below reopen the scope.
        await backend.flush();
        backend.releaseJournal();
      }
    } else {
      await seedManifestVersion(workspaceRoot, SCOPE_ID, version);
      await seedManifestVersion(workspaceRoot, ENTRY_ID, version);
      await seedManifestVersion(historyScopeRoot, ARCHIVE_ID, version);
    }
  }
  fixture = result;
  return result;
}

function registeredHandler(
  channel: string,
): (...args: unknown[]) => Promise<unknown> {
  const call = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  const handler = call[1];
  if (typeof handler !== 'function')
    throw new Error('Invalid registered handler');
  return async (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, args));
}

async function cleanupFixture(): Promise<void> {
  await activeService?.drain().catch(() => undefined);
  await drainOpenRepositories();
  activeService = undefined;
  resetChatStateServiceForTests();
  resetChatHistoryScanForTests();
  // Background snapshot writers can still be finishing inside the data
  // directory, so let removal retry instead of failing on ENOTEMPTY.
  if (fixture)
    await rm(fixture.dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  fixture = undefined;
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  previousDataDir = undefined;
  capturedPreviousDataDir = false;
  resetResolvedCanopyDataDirForTests();
}

describe('version-5 chat-storage authority manifest characterization', () => {
  jest.setTimeout(60_000);

  beforeEach(async () => {
    jest.clearAllMocks();
    fixture = await prepareFixture();
  });

  afterEach(cleanupFixture);

  it('repository load rejects, becomes recovery_error, and keeps the same cached error', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    const repository = makeRepository(target);
    const before = await snapshotFiles(target.workspaceRoot);
    let firstError: unknown;
    await repository.getState(target.scope).catch((error: unknown) => {
      firstError = error;
    });

    expect(firstError).toBeInstanceOf(ChatStateRepositoryLoadError);
    expect(firstError instanceof Error && firstError.cause).toBeInstanceOf(
      ChatStorageNewerFormatError,
    );
    expect(firstError instanceof Error ? firstError.message : '').toContain(
      'newer version of the app',
    );
    expect(repository.getLifecycle(target.scope)).toBe('recovery_error');
    const secondError = await repository
      .getState(target.scope)
      .catch((error: unknown) => error);
    expect(secondError).toBe(firstError);
    expect(
      repository
        .getStorageDiagnostics(target.scope)
        .some((diagnostic) => diagnostic.kind === 'delta_journal_newer_format'),
    ).toBe(true);
    const after = await snapshotFiles(target.workspaceRoot);
    expect(
      after.filter(
        (file) =>
          !before.some((entry) => entry.relativePath === file.relativePath),
      ),
    ).toEqual([]);
    expect(after).toEqual(before);
  });

  it('readChatStorageDiscoveryIndex rejects the unknown authority without changing files', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      await expect(
        readChatStorageDiscoveryIndex(target.workspaceRoot, SCOPE_ID),
      ).rejects.toThrow(ChatStorageNewerFormatError);
    });
  });

  it('interrupted-work scanning records the error and keeps the scope as a recovery candidate', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      const result = await scanInterruptedWork(
        [getWorkspacesRootDir()],
        join(target.dataDir, 'executions'),
      );
      expect(result.chatScopes).toEqual(
        expect.arrayContaining([target.scope, target.entryScope]),
      );
      expect(result.errors).toHaveLength(2);
      expect(result.errors.join('\n')).toContain('newer version of the app');
    });
  });

  it('inherited-default normalization attempts admission and reports the failed scope count', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    const repository = installFreshService(target);
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      await expect(
        normalizeWorkspaceChatsForInheritedPluginDefaults(
          PROJECT_ID,
          undefined,
        ),
      ).rejects.toThrow(
        `Could not normalize 2 chat scopes of workspace ${PROJECT_ID}`,
      );
      expect(repository.getLifecycle(target.scope)).toBe('recovery_error');
    });
  });

  it('MCP rewrite falls back to full-scope admission and returns its aggregate failure', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    const repository = installFreshService(target);
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      await expect(
        rewriteMcpServerRefs({
          from: [{ serverId: 'old-server' }],
          to: { serverId: 'custom:new', configId: 'default' },
        }),
      ).rejects.toThrow(MCP_SERVER_REF_REWRITE_INCOMPLETE);
      expect(repository.getLifecycle(target.scope)).toBe('recovery_error');
    });
  });

  it('marketplace pruning treats discovery failure as best-effort and never admits or writes the scope', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    const repository = installFreshService(target);
    await writeFile(
      join(target.dataDir, 'plugins-cache.json'),
      JSON.stringify(
        {
          version: 2,
          lastRefreshed: CURRENT_AT,
          marketplaces: [
            {
              id: 'acme/plugins',
              name: 'Acme',
              sourceType: 'github',
              sourceUrl: 'https://github.com/acme/plugins',
              installLocation: '/mock/acme',
              pluginCount: 1,
              plugins: [
                {
                  name: 'shared',
                  sourcePath: 'plugins/shared',
                  marketplaceId: 'acme/plugins',
                  providerSupport: { claude: 'native', codex: 'native' },
                  facets: {
                    claude: {
                      provider: 'claude',
                      mode: 'native',
                      name: 'shared',
                      installLocation: '/mock/claude/shared',
                      sourcePath: 'plugins/shared',
                    },
                    codex: {
                      provider: 'codex',
                      mode: 'native',
                      name: 'shared',
                      installLocation: '/mock/codex/shared',
                      sourcePath: '/mock/codex/shared',
                    },
                  },
                },
              ],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: CURRENT_AT,
                  marketplaceName: 'acme',
                  installLocation: '/mock/claude/acme',
                },
                codex: {
                  provider: 'codex',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: CURRENT_AT,
                  marketplaceName: 'acme',
                  installLocation: '/mock/codex/acme',
                },
              },
              validProviders: ['claude', 'codex'],
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      const removed = await removeMarketplace('acme/plugins');
      expect(removed.success).toBe(true);
      await flushMarketplaceSelectionPruneForTests();
      expect(repository.getLifecycle(target.scope)).toBe('unloaded');
    });
  });

  it('chat-history scanning skips invalid canonical scopes and returns false without fallback writes', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    resetChatHistoryScanForTests();
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      await expect(hasEverSentChatMessage()).resolves.toBe(false);
    });
  });

  it('standalone archive listing refuses the unknown manifest without changing the archive scope', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    await expectNoStorageChanges(target.historyScopeRoot, async () => {
      await expect(readArchiveListing(PROJECT_ID, ARCHIVE_ID)).rejects.toThrow(
        ChatStorageNewerFormatError,
      );
    });
  });

  it('Work Entry catalog reads reject the unknown authority without fallback migration', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      await expect(
        readWorkEntryChatCatalog(PROJECT_ID, ENTRY_ID),
      ).rejects.toThrow(ChatStorageNewerFormatError);
    });
  });

  it('Work Entry summary-source lookup rejects the unknown authority without changing files', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      await expect(summarySourcePath(PROJECT_ID, ENTRY_ID)).rejects.toThrow(
        ChatStorageNewerFormatError,
      );
    });
  });

  it('archive retention leaves real expired standalone and Work Entry archives untouched when catalogs refuse version 5', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    expect(
      (await readWorkspaceConfig(PROJECT_ID)).cowork?.archiveRetentionDays,
    ).toBe(1);
    expect(await listHistoryChatIds(PROJECT_ID)).toContain(ARCHIVE_ID);
    expect(await listWorkEntryIds(PROJECT_ID)).toContain(ENTRY_ID);
    await expect(readArchiveListing(PROJECT_ID, ARCHIVE_ID)).rejects.toThrow(
      ChatStorageNewerFormatError,
    );
    await expect(
      readWorkEntryChatCatalog(PROJECT_ID, ENTRY_ID),
    ).rejects.toThrow(ChatStorageNewerFormatError);
    jest.mocked(registerIpcHandler).mockClear();
    registerStandaloneChatHandlers();
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      await registeredHandler(IPC_CHANNELS.standaloneChatInit)(
        undefined,
        PROJECT_ID,
      );
    });
    await expect(stat(target.historyScopeRoot)).resolves.toBeDefined();
    const historyArchiveIndex = await readFile(
      join(
        target.historyScopeRoot,
        'chat-storage-v2',
        ARCHIVE_ID,
        'archive-index.json',
      ),
      'utf8',
    );
    expect(historyArchiveIndex).toContain(ARCHIVE_ID);
    expect(historyArchiveIndex).toContain(EXPIRED_AT);
    const workEntryArchiveIndex = await readFile(
      join(
        target.workspaceRoot,
        'chat-storage-v2',
        ENTRY_ID,
        'archive-index.json',
      ),
      'utf8',
    );
    expect(workEntryArchiveIndex).toContain(ENTRY_ARCHIVE_ID);
    expect(workEntryArchiveIndex).toContain(EXPIRED_AT);
  });

  it('migration refuses version 5 before deleting legacy families or rewriting its manifest', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    const store = new ChatStorageV2(target.workspaceRoot, SCOPE_ID);
    await expectNoStorageChanges(target.workspaceRoot, async () => {
      await expect(
        store.migrate(() =>
          Promise.reject(new Error('The migration source must not be opened')),
        ),
      ).rejects.toThrow(ChatStorageNewerFormatError);
      for (const relativePath of [
        join('chats', `${SCOPE_ID}.json`),
        join('chat-archives', `${SCOPE_ID}.json`),
        join('chat-journals', `${SCOPE_ID}.jsonl`),
      ]) {
        await expect(
          readFile(join(target.workspaceRoot, relativePath), 'utf8'),
        ).resolves.toContain('legacy sentinel');
      }
    });
  });

  it.each([
    [
      'open',
      (store: ChatStorageV2): Promise<ChatDeltaJournalWriter> =>
        ChatDeltaJournalWriter.open(store),
    ],
    ['promotion', promoteToDeltaJournal],
    ['demotion', demoteFromDeltaJournal],
    ['stray cleanup', removeStrayDeltaJournal],
  ])(
    '%s refuses a newer authority without changing files',
    async (_name, run): Promise<void> => {
      const target = fixture;
      if (!target) throw new Error('Fixture missing');
      const store = new ChatStorageV2(target.workspaceRoot, SCOPE_ID);
      await expectNoStorageChanges(target.workspaceRoot, async () => {
        await expect(run(store)).rejects.toThrow(ChatStorageNewerFormatError);
      });
    },
  );
});

describe('format-4 production reader lanes', () => {
  jest.setTimeout(60_000);

  beforeEach(async () => {
    jest.clearAllMocks();
    fixture = await prepareFixture({ manifestVersion: 4 });
  });

  afterEach(cleanupFixture);

  it('repository opens the selected format-4 scope and reads its tab', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    const state = await makeRepository(target).getState(target.scope);
    expect(state.tabsFile.tabs.map((tab) => tab.id)).toContain(
      `${SCOPE_ID}-chat`,
    );
  });

  it('discovery reads format-4 metadata from a real scope', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    const index = await readChatStorageDiscoveryIndex(
      target.workspaceRoot,
      SCOPE_ID,
    );
    expect(index.tabs.map((tab) => tab.id)).toContain(`${SCOPE_ID}-chat`);
  });

  it('interrupted-work scanning admits format-4 scopes without a newer-format error', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    for (const selected of [target.scope, target.entryScope]) {
      const backend = new ChatStateV2Backend(
        new ChatStorageV2(target.workspaceRoot, selected.worktreeId),
        { deltaJournal: {} },
      );
      await backend.transact(
        () => [
          {
            type: 'runtime.patched',
            chatId: `${selected.worktreeId}-chat`,
            runtime: { status: 'streaming', queuedMessageIds: ['queued'] },
          },
        ],
        { source: 'provider' },
      );
      await backend.flush();
      backend.releaseJournal();
    }
    const result = await scanInterruptedWork(
      [getWorkspacesRootDir()],
      join(target.dataDir, 'executions'),
    );
    expect(result.chatScopes).toEqual(
      expect.arrayContaining([target.scope, target.entryScope]),
    );
    expect(result.errors.join('\n')).not.toContain('newer version of the app');
  });

  it('chat-history scanning sees a user message in the format-4 scope', async () => {
    resetChatHistoryScanForTests();
    await expect(hasEverSentChatMessage()).resolves.toBe(true);
  });

  it('standalone archive listing reads an actual format-4 archive index', async () => {
    const listing = await readArchiveListing(PROJECT_ID, ARCHIVE_ID);
    expect(listing).toMatchObject({
      archivedAt: EXPIRED_AT,
      title: 'Expired archive',
      messageCount: 0,
    });
  });

  it('Work Entry catalog reads live and archived ids from format 4', async () => {
    const catalog = await readWorkEntryChatCatalog(PROJECT_ID, ENTRY_ID);
    expect(catalog.liveChatIds).toContain(`${ENTRY_ID}-chat`);
    expect(catalog.archives).toEqual(
      expect.arrayContaining([
        { chatId: ENTRY_ARCHIVE_ID, archivedAt: EXPIRED_AT },
      ]),
    );
  });

  it('Work Entry summary-source lookup resolves a real format-4 index or journal', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    const source = await summarySourcePath(PROJECT_ID, ENTRY_ID);
    await expect(stat(source)).resolves.toBeDefined();
    expect(source).toContain(join('chat-storage-v2', ENTRY_ID));
  });

  it('inherited-default normalization admits format-4 scopes', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');
    await expect(
      normalizeWorkspaceChatsForInheritedPluginDefaults(PROJECT_ID, undefined),
    ).resolves.toBeUndefined();
    expect(makeRepository(target).getLifecycle(target.scope)).not.toBe(
      'recovery_error',
    );
  });

  it('mcp-servers:rewrite-refs can read format-4 scopes without an aggregate refusal', async () => {
    const result = await rewriteMcpServerRefs({
      from: [{ serverId: 'unused-server' }],
      to: { serverId: 'custom:new', configId: 'default' },
    });
    expect(result).not.toBeNull();
    expect(result).not.toMatchObject({
      error: MCP_SERVER_REF_REWRITE_INCOMPLETE,
    });
  });
});

describe('split backup and plan cleanup reader lanes', () => {
  beforeEach(async () => {
    fixture = await prepareFixture({ manifestVersion: 4 });
  });
  afterEach(cleanupFixture);

  it('restores a real format-4 split backup and refuses a format-5 backup without writes', async () => {
    const f = fixture;
    if (!f) throw new Error('Fixture missing');
    installFreshService(f);
    const service = activeService;
    if (!service) throw new Error('Fixture service missing');
    for (const version of [4, 5]) {
      const backupRoot = join(f.dataDir, `split-backup-${version}`);
      const chatId = `split-restored-${version}`;
      const { store, backend } = await format4Scope(
        backupRoot,
        'source',
        scopeSource([
          {
            id: chatId,
            messages: [message('split-body', 'exact split backup body')],
          },
        ]),
      );
      const metadata = await backend.state();
      await backend.demoteFromDeltaJournal();
      backend.releaseJournal();
      const undo: Parameters<typeof undoSplitChatsAndPlansMigration>[0] = {
        workspaceId: PROJECT_ID,
        worktreeId: SCOPE_ID,
        sourceStorageBackupRoot: backupRoot,
        sourceChatsFile: metadata.tabsFile,
        sourceArchivesFile: metadata.archivesFile,
        sourcePlans: [],
        writtenChatFiles: [],
        writtenArchiveFiles: [],
        writtenPlanFiles: [],
      };
      if (version === 4) {
        await undoSplitChatsAndPlansMigration(undo);
        expect(
          (await service.getTranscriptPage({ ...f.scope, chatId })).messages,
        ).toMatchObject([
          {
            id: 'split-body',
            blocks: [{ type: 'text', text: 'exact split backup body' }],
          },
        ]);
      } else {
        const manifest: unknown = JSON.parse(
          await readFile(store.manifestPath, 'utf8'),
        );
        if (!isRecord(manifest)) throw new Error('Missing backup manifest');
        await writeFile(
          store.manifestPath,
          JSON.stringify({ ...manifest, version: 5 }),
        );
        // Finish any destination load/recovery before the refusal snapshot.
        await service.getCompatibilityTabs(f.scope);
        await service.getCompatibilityArchives(f.scope);
        await expectNoStorageChanges(f.dataDir, async () => {
          await expect(undoSplitChatsAndPlansMigration(undo)).rejects.toThrow(
            ChatStorageNewerFormatError,
          );
        });
      }
    }
  });

  it('plan cleanup reads format 4 and retains a typed format-5 refusal without canonical writes', async () => {
    const f = fixture;
    if (!f) throw new Error('Fixture missing');
    await activeService?.drain();
    activeService = new ChatStateService({ recordDiagnostic: jest.fn() });
    resetChatStateServiceForTests(activeService);
    jest
      .spyOn(liveCleanup, 'cleanupLiveWorktreeState')
      .mockResolvedValue(undefined);
    jest
      .spyOn(ChatSearchService.prototype, 'deleteWorktreeDocs')
      .mockResolvedValue(undefined);
    const deletion = jest.spyOn(activeService, 'deleteScope');
    for (const version of [4, 5]) {
      const planId = `reader-plan-${version}`;
      const projectId = PLAN_EXPLORE_CHAT_PROJECT_ID;
      const store = ChatStorageV2.fromLegacyPaths({
        tabs: resolveChatTabsFilePath(projectId, planId),
        archives: resolveChatArchivesFilePath(projectId, planId),
        journal: resolveChatJournalFilePath(projectId, planId),
      });
      const descriptor = store.descriptor();
      const { backend } = await format4Scope(
        descriptor.workspaceRoot,
        descriptor.scopeId,
        scopeSource([
          {
            id: 'plan-chat',
            messages: [message('plan-body', 'read before cleanup')],
          },
        ]),
      );
      await backend.demoteFromDeltaJournal();
      backend.releaseJournal();
      if (version === 4) {
        expect(await removePlanExploreChat(planId, f.scope)).toEqual([]);
        await expect(stat(store.manifestPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        const manifest: unknown = JSON.parse(
          await readFile(store.manifestPath, 'utf8'),
        );
        if (!isRecord(manifest)) throw new Error('Missing plan manifest');
        await writeFile(
          store.manifestPath,
          JSON.stringify({ ...manifest, version: 5 }),
        );
        await expectNoStorageChanges(f.dataDir, async () => {
          const warnings = await removePlanExploreChat(planId, f.scope);
          expect(warnings).toEqual([
            expect.stringContaining('newer version of the app'),
          ]);
          // Cleanup intentionally converts failures to warnings; inspect the
          // real service promise to pin the typed cause, not just its copy.
          const result =
            deletion.mock.results[deletion.mock.results.length - 1];
          if (!result || result.type !== 'return')
            throw new Error('Missing deletion attempt');
          const error: unknown = await result.value.then(
            () => undefined,
            (reason: unknown) => reason,
          );
          expect(error instanceof Error && error.cause).toBeInstanceOf(
            ChatStorageNewerFormatError,
          );
        });
      }
    }
  });
});

describe('known-manifest retention control', () => {
  jest.setTimeout(60_000);

  beforeEach(async () => {
    jest.clearAllMocks();
    fixture = await prepareFixture({ newerManifest: false });
  });

  afterEach(cleanupFixture);

  it('standaloneChatInit prunes real expired archives', async () => {
    const target = fixture;
    if (!target) throw new Error('Fixture missing');

    const standaloneListing = await readArchiveListing(PROJECT_ID, ARCHIVE_ID);
    expect(standaloneListing?.archivedAt).toBe(EXPIRED_AT);
    const entryCatalog = await readWorkEntryChatCatalog(PROJECT_ID, ENTRY_ID);
    expect(entryCatalog.archives).toEqual(
      expect.arrayContaining([
        { chatId: ENTRY_ARCHIVE_ID, archivedAt: EXPIRED_AT },
      ]),
    );

    jest.mocked(registerIpcHandler).mockClear();
    registerStandaloneChatHandlers();
    await registeredHandler(IPC_CHANNELS.standaloneChatInit)(
      undefined,
      PROJECT_ID,
    );

    await expect(stat(target.historyScopeRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const retainedEntryCatalog = await readWorkEntryChatCatalog(
      PROJECT_ID,
      ENTRY_ID,
    );
    expect(retainedEntryCatalog.archives).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId: ENTRY_ARCHIVE_ID }),
      ]),
    );
  });
});
