import { readChatArchiveMetadata } from '../lib/chat-archives';
import { migrateLegacyChatScope } from '../lib/legacy-chat-migration';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  getStandaloneHistoryStorage,
  readArchiveListing,
} from '../lib/standalone-history';
import { readChatTranscript } from '../lib/chat-tabs-reader';
import { type IpcMainInvokeEvent } from 'electron';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readChatArchivesFile,
  writeChatArchivesFile,
} from '../lib/chat-archives';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  COWORK_HOME_WORKTREE_ID,
  DEFAULT_CHAT_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_NAME,
  IPC_CHANNELS,
  type ChatProjectData,
  type ChatTabPluginSelections,
  type CoworkWorkspaceSettings,
  type PersistedChatTab,
  type StandaloneArchiveReadRequest,
  type StandaloneArchiveReadResponse,
  type StandaloneArchiveResumeRequest,
  type StandaloneArchiveResumeResponse,
  type StandaloneChatListResponse,
  type StandaloneChatMeta,
  type StandaloneChatMetaFile,
  type StandaloneChatReadSummaryRequest,
  type StandaloneChatReadSummaryResponse,
  type StandaloneProjectExportRequest,
  type StandaloneProjectExportResponse,
  type StandaloneProjectFile,
  type StandaloneProjectImportRequest,
  type StandaloneProjectImportResponse,
  type StandaloneWorkspaceSnapshotRequest,
  type StandaloneWorkspaceSnapshotResponse,
  type AgentModelConfig,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { getWorkspaceType } from '../lib/workspace-registry';
import { enqueueWorkspaceLocalMemoryImportBatch } from '../memory/local/import/import-job';

function legacyArchiveWorktreeId(projectId: string): string {
  return projectId === APP_ADVISOR_PROJECT_ID
    ? APP_ADVISOR_WORKTREE_ID
    : COWORK_HOME_WORKTREE_ID;
}
import { generateChatSummary, type SummaryResult } from '../agents/utils';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { ensureCoworkHomeScaffold } from '../lib/chat-project-utils';
import { isPathInside } from '../lib/path-safety';
import {
  getWorkspaceChatHistoryMetaFilePath,
  getWorkspaceChatHistoryRootDir,
  getWorkspaceDir,
  getWorkspaceHomeDir,
  getWorkspaceWorkEntriesFilePath,
  getCoworkWorkspaceRootDir,
} from '../lib/paths';
import {
  listWorkEntryIds,
  parseWorkEntriesFile,
  readWorkEntryChatCatalog,
} from '../lib/cowork-work-entries';
import { migrateWorkspaceChatsToWorkEntries } from '../lib/cowork-work-entry-migration';
import {
  getCoworkArtifactsIndexFilePath,
  getCoworkManagedSubdir,
} from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { getChatStateService } from '../services/chat-state-service';
import {
  createCoworkWorkspace,
  listCoworkWorkspacesAsChatProjects,
} from '../lib/cowork-workspace-crud';
import { readWorkspaceIndexEntry } from '../lib/sidebar-items';
import { recordCoworkWorkspaceMetadata } from '../lib/cowork-workspace-records';
import { serializeChatProjectOperation } from '../lib/chat-project-operation-queue';
import {
  normalizeCoworkSettings,
  readWorkspaceConfig,
} from '../lib/workspace-persistence';
import {
  readArchiveSnapshot,
  readArchiveSummary,
} from '../lib/standalone-history';
import {
  listHistoryChatIds,
  loadHistoryIndex,
  rebuildHistoryIndex,
} from '../lib/standalone-history-index';
import {
  buildDefaultStandaloneProjectFile,
  readStandaloneProjectFile,
} from '../lib/standalone-project-state';
import { readStandaloneProjectMetadataFields } from '../lib/standalone-project-metadata';
import { validateId } from '../lib/validation';
import { chooseDirectoryForEvent } from '../lib/dialog-window';
import { registerIpcHandler } from './register';
import { isRecord } from '../lib/type-guards';
import { slugify } from '../lib/string-utils';
import {
  recordStandaloneFeatureTelemetry,
  recordStandaloneProjectCrudTelemetry,
} from '../lib/desktop-telemetry';
import {
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

function parseImportedStandaloneProjectFile(
  raw: string,
): StandaloneProjectFile | null {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.id !== 'string' ||
    typeof parsed.name !== 'string' ||
    typeof parsed.createdAt !== 'string'
  ) {
    return null;
  }

  const settings = isRecord(parsed.settings) ? parsed.settings : undefined;
  return {
    version: 1,
    id: parsed.id,
    name: parsed.name,
    createdAt: parsed.createdAt,
    ...readStandaloneProjectMetadataFields(parsed),
    ...(Array.isArray(parsed.presets) ? { presets: parsed.presets } : {}),
    ...(settings
      ? {
          settings: {
            ...(settings.archiveRetentionDays === null ||
            (typeof settings.archiveRetentionDays === 'number' &&
              Number.isInteger(settings.archiveRetentionDays) &&
              settings.archiveRetentionDays >= 0 &&
              settings.archiveRetentionDays <= MAX_ARCHIVE_RETENTION_DAYS)
              ? { archiveRetentionDays: settings.archiveRetentionDays }
              : {}),
          },
        }
      : {}),
  };
}

function resolveChatProjectId(projectId?: string): string {
  return projectId ?? DEFAULT_CHAT_PROJECT_ID;
}

function defaultProjectData(projectId: string): ChatProjectData {
  return {
    id: projectId,
    name:
      projectId === DEFAULT_CHAT_PROJECT_ID
        ? DEFAULT_CHAT_PROJECT_NAME
        : 'Untitled Project',
    createdAt:
      projectId === DEFAULT_CHAT_PROJECT_ID
        ? '2025-01-01T00:00:00.000Z'
        : new Date().toISOString(),
    archiveRetentionDays: 7,
  };
}

/**
 * Upper bound on chat scopes a single init may admit for retention. Admission
 * loads (and, for legacy scopes, migrates) the whole scope, so a workspace
 * with many expirable Work Entries is drained across successive inits rather
 * than all at once on one startup.
 */
const MAX_ARCHIVE_RETENTION_ADMISSIONS_PER_INIT = 32;

async function applyArchiveRetention(projectId: string): Promise<void> {
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  const workspaceConfig = await readWorkspaceConfig(workspaceId);
  const retentionDays = workspaceConfig.cowork?.archiveRetentionDays;
  if (typeof retentionDays !== 'number' || retentionDays <= 0) {
    return;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const historyDir = getWorkspaceChatHistoryRootDir(workspaceId);
  const entries = await listHistoryChatIds(projectId);

  let changed = false;
  for (const chatId of entries) {
    // Read-only listing: learning `archivedAt` must not migrate the archive.
    const listing = await readArchiveListing(projectId, chatId).catch(
      () => null,
    );
    const archivedAt = listing?.archivedAt;
    if (!archivedAt) continue;
    if (new Date(archivedAt).getTime() < cutoff) {
      await rm(join(historyDir, chatId), { recursive: true, force: true });
      changed = true;
    }
  }

  if (changed) {
    await rebuildHistoryIndex(projectId);
  }

  // Unified archives: new cowork archives live per work entry in the
  // worktree ArchivedChatsFile (chat-archives/{entryId}.json), plus the
  // legacy pre-entry chat-archives/home.json. Apply the same window to all.
  // Catalog reads are not scope admission: gate on the metadata-only
  // catalog first and admit (load/migrate) only scopes that actually hold an
  // expirable archive, one at a time and bounded per init.
  const archiveWorktreeIds = [
    ...(await listWorkEntryIds(workspaceId)),
    COWORK_HOME_WORKTREE_ID,
  ];
  let admissions = 0;
  for (const worktreeId of archiveWorktreeIds) {
    if (admissions >= MAX_ARCHIVE_RETENTION_ADMISSIONS_PER_INIT) break;
    const catalog = await readWorkEntryChatCatalog(
      workspaceId,
      worktreeId,
    ).catch(() => null);
    const expirable = catalog?.archives.some(
      (archive) => new Date(archive.archivedAt).getTime() < cutoff,
    );
    if (!expirable) continue;
    admissions += 1;
    const archivesFile = await readChatArchivesFile(workspaceId, worktreeId);
    const retained = archivesFile.archived.filter(
      (entry) => new Date(entry.archivedAt).getTime() >= cutoff,
    );
    if (retained.length !== archivesFile.archived.length) {
      await writeChatArchivesFile(workspaceId, worktreeId, {
        ...archivesFile,
        archived: retained,
      });
    }
  }
}

/**
 * Ensures a cowork workspace is ready for standalone-chat use: its managed
 * `home/`/`derived/` scaffold exists, deletion retention has been applied, and
 * the derived history index is fresh. Cowork workspaces are already
 * self-scaffolded by their CRUD create paths
 * (`cowork-workspace-crud.ts`/`ensureCoworkHomeScaffold`), so this only needs
 * to be idempotent, not a first-time seed. It intentionally does NOT touch
 * the legacy `standalone-chat/` tree — that tree is deleted by the one-time
 * cowork migration at startup, and re-creating any file under it here would
 * resurrect data the migration (and any subsequent workspace delete) already
 * removed.
 */
async function initStandaloneDir(projectId?: string): Promise<void> {
  const resolvedProjectId = resolveChatProjectId(projectId);
  const workspaceId = resolveCoworkWorkspaceId(resolvedProjectId);

  await ensureCoworkHomeScaffold(workspaceId);
  await applyArchiveRetention(workspaceId);
  await rebuildHistoryIndex(workspaceId);
}

/** The window's standalone-chat init, also run before App Advisor's Cowork history reads. */
export async function initStandaloneChat(projectId?: string): Promise<void> {
  const resolvedProjectId = resolveChatProjectId(projectId);
  validateId(resolvedProjectId, 'projectId');
  await initStandaloneDir(resolvedProjectId);
  // Every init of a cowork workspace (first open, each workspace switch,
  // App Advisor history actions) queues the workspace-scope local memory
  // import, the counterpart of the readiness audit that queues it for
  // code workspaces, which cowork never renders. The job's 24-hour
  // per-source interval keeps repeats cheap. The id is translated the
  // same way initStandaloneDir translates it, so a legacy chat-project id
  // reaches the real workspace, and the gate is keyed on the registry so
  // App Advisor and unknown ids never queue an import.
  const coworkWorkspaceId = resolveCoworkWorkspaceId(resolvedProjectId);
  if (getWorkspaceType(coworkWorkspaceId) === 'cowork') {
    trackDetachedWork(() =>
      enqueueWorkspaceLocalMemoryImportBatch(coworkWorkspaceId).catch(
        () => undefined,
      ),
    );
  }
}

export async function listChats(
  projectId?: string,
  options: { readOnly?: boolean } = {},
): Promise<StandaloneChatListResponse> {
  const resolvedProjectId = resolveChatProjectId(projectId);
  const entries = await listHistoryChatIds(resolvedProjectId);

  const chats: StandaloneChatMeta[] = [];
  for (const chatId of entries) {
    try {
      const raw = await readFile(
        getWorkspaceChatHistoryMetaFilePath(
          resolveCoworkWorkspaceId(resolvedProjectId),
          chatId,
        ),
        'utf8',
      );
      const meta = JSON.parse(raw) as StandaloneChatMetaFile;
      chats.push({
        id: meta.id,
        ...(meta.title ? { title: meta.title } : {}),
        ...(meta.customTitle !== undefined
          ? { customTitle: meta.customTitle }
          : {}),
        description: meta.description,
        createdAt: meta.createdAt,
        ...(meta.messageCount !== undefined
          ? { messageCount: meta.messageCount }
          : {}),
        ...(meta.lastMessageAt ? { lastMessageAt: meta.lastMessageAt } : {}),
        ...(meta.pluginSelections
          ? { pluginSelections: meta.pluginSelections }
          : {}),
        ...(meta.providerType ? { providerType: meta.providerType } : {}),
        ...(meta.archived ? { archived: meta.archived } : {}),
        ...(meta.archivedAt ? { archivedAt: meta.archivedAt } : {}),
        ...(meta.sharedRun ? { sharedRun: meta.sharedRun } : {}),
      });
    } catch {
      // Skip invalid meta files.
    }
  }

  const unifiedArchives = await (
    options.readOnly ? readChatArchiveMetadata : readChatArchivesFile
  )(
    resolveCoworkWorkspaceId(resolvedProjectId),
    legacyArchiveWorktreeId(resolvedProjectId),
  );
  const existingIds = new Set(chats.map((chat) => chat.id));
  for (const entry of unifiedArchives.archived) {
    if (existingIds.has(entry.tab.id)) continue;
    const lastMessageAt = entry.tab.transcript
      ? entry.tab.transcript.lastMessageAt
      : entry.tab.messages[entry.tab.messages.length - 1]?.timestamp;
    chats.push({
      id: entry.tab.id,
      title: entry.tab.title,
      ...(entry.tab.customTitle !== undefined
        ? { customTitle: entry.tab.customTitle }
        : {}),
      description: entry.tab.description ?? entry.tab.title,
      createdAt: entry.tab.createdAt,
      messageCount:
        entry.tab.transcript?.messageCount ??
        entry.tab.transcript?.committedMessageCount ??
        entry.tab.messages.length,
      ...(lastMessageAt !== undefined
        ? { lastMessageAt: new Date(lastMessageAt).toISOString() }
        : {}),
      ...(entry.tab.pluginSelections
        ? { pluginSelections: entry.tab.pluginSelections }
        : {}),
      ...(entry.tab.providerType
        ? { providerType: entry.tab.providerType }
        : {}),
      archived: true,
      archivedAt: entry.archivedAt,
      ...(entry.tab.sharedRun ? { sharedRun: entry.tab.sharedRun } : {}),
    });
  }

  chats.sort((a, b) => {
    const left = a.archivedAt ?? a.lastMessageAt ?? a.createdAt;
    const right = b.archivedAt ?? b.lastMessageAt ?? b.createdAt;
    return new Date(right).getTime() - new Date(left).getTime();
  });
  return { chats };
}

const metaQueues = new Map<string, Promise<void>>();

export async function updateChatMeta(
  chatId: string,
  updates: Partial<
    Pick<
      StandaloneChatMetaFile,
      | 'title'
      | 'description'
      | 'pluginSelections'
      | 'providerType'
      | 'messageCount'
      | 'lastMessageAt'
      | 'archived'
      | 'archivedAt'
      | 'sharedRun'
    >
  >,
  projectId?: string,
): Promise<void> {
  const resolvedProjectId = resolveChatProjectId(projectId);
  const queueKey = `${resolvedProjectId}/${chatId}`;
  const prev = metaQueues.get(queueKey) ?? Promise.resolve();
  const next = prev.then(async () => {
    const metaPath = getWorkspaceChatHistoryMetaFilePath(
      resolveCoworkWorkspaceId(resolvedProjectId),
      chatId,
    );
    const existing = await readFile(metaPath, 'utf8')
      .then((raw) => JSON.parse(raw) as StandaloneChatMetaFile)
      .catch(
        () =>
          ({
            version: 1,
            id: chatId,
            title: `New ${CHAT_UNIT_LABEL}`,
            description: 'New chat',
            createdAt: new Date().toISOString(),
          }) satisfies StandaloneChatMetaFile,
      );

    const updated: StandaloneChatMetaFile = {
      ...existing,
      ...updates,
      version: 1,
      id: chatId,
      description: updates.description ?? existing.description ?? 'New chat',
      createdAt: existing.createdAt,
    };
    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(metaPath, JSON.stringify(updated, null, 2), 'utf8');
  });
  metaQueues.set(
    queueKey,
    next.finally(() => {
      if (metaQueues.get(queueKey) === next) {
        metaQueues.delete(queueKey);
      }
    }),
  );
  await next;
}

export async function generateChatSummaryForProject(
  userMessage: string,
  options?: {
    projectId?: string;
    model?: string;
    thinkingLevel?: ThinkingLevel;
    modelConfig?: AgentModelConfig;
    cwd?: string;
    workOwner?: WorkOwner | null;
    observabilityTaskKey?: string;
  },
): Promise<SummaryResult> {
  const resolvedProjectId = resolveChatProjectId(options?.projectId);
  const cwd =
    options?.cwd ??
    getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(resolvedProjectId));
  return generateChatSummary(userMessage, {
    purpose: 'chat-title',
    model: options?.model,
    thinkingLevel: options?.thinkingLevel,
    modelConfig: options?.modelConfig,
    cwd,
    workspaceId: resolvedProjectId,
    ...(options && Object.prototype.hasOwnProperty.call(options, 'workOwner')
      ? { workOwner: options.workOwner }
      : {}),
    observabilityTaskKey: options?.observabilityTaskKey,
  });
}

async function readSummary(
  chatId: string,
  projectId?: string,
): Promise<string> {
  return readArchiveSummary(resolveChatProjectId(projectId), chatId);
}

function sanitizeResumedTab(
  snapshotTab: PersistedChatTab,
  mode: StandaloneArchiveResumeRequest['mode'],
): PersistedChatTab {
  const title =
    mode === 'duplicate' ? `${snapshotTab.title} Copy` : snapshotTab.title;
  return {
    ...snapshotTab,
    id: randomUUID(),
    title,
    createdAt: new Date().toISOString(),
    sdkSessionId: undefined,
    claudeForkSessionOnNextSend: undefined,
    pendingPlanExit: undefined,
    trackedPlanId: undefined,
    trackedPlanSource: undefined,
    trackedPlanReviewStatus: undefined,
    hasOutstandingProposal: undefined,
    latestRevisionNumber: undefined,
    readOnly: undefined,
    staleSessionDetected: undefined,
  };
}

/**
 * Returns `primary` when defined, otherwise `fallback`. Used to prefer the
 * cowork workspace's own settings over the legacy compat fallback field by
 * field, without collapsing an explicit `null`/`false`/`0` to the fallback.
 */
function firstDefined<T>(
  primary: T | undefined,
  fallback: T | undefined,
): T | undefined {
  return primary !== undefined ? primary : fallback;
}

/**
 * Builds the `StandaloneProjectFile` shape the standalone-chat workspace
 * snapshot exposes, sourced primarily from the cowork workspace itself:
 * `name`/`color` come from the workspace's sidebar index entry
 * (`workspaces/index.json`, via `readWorkspaceIndexEntry`), and every other
 * field comes from the workspace's `workspace.json` `cowork` settings block
 * (via `readWorkspaceConfig`). `id` is the resolved cowork workspace id, not
 * necessarily the (possibly legacy) `projectId` the caller passed in.
 *
 * The legacy `standalone-chat/{project}/project.json` file is consulted only
 * as a last-resort fallback for fields the `cowork` block itself doesn't
 * carry (e.g. an external-folder cowork workspace with no `cowork` block at
 * all yet). In the common case — a migrated or natively-created cowork
 * workspace — that legacy file no longer exists (the cowork migration
 * deletes it once a legacy project is migrated, and a freshly-created cowork
 * workspace never had one), so `readStandaloneProjectFile` returns `null` and
 * every field resolves from the cowork workspace instead. Scaffolds via
 * `ensureCoworkHomeScaffold` (not `ensureChatProjectDir`) so this read path
 * never resurrects the legacy `project.json` file as a side effect.
 */
async function getWorkspaceProjectFile(
  projectId: string,
): Promise<StandaloneProjectFile> {
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  await ensureCoworkHomeScaffold(workspaceId);

  const [indexEntry, workspaceConfig, legacy] = await settleAll([
    readWorkspaceIndexEntry(workspaceId),
    readWorkspaceConfig(workspaceId),
    readStandaloneProjectFile(projectId),
  ]);
  const cowork = workspaceConfig.cowork;
  const fallback =
    legacy ?? buildDefaultStandaloneProjectFile(defaultProjectData(projectId));

  const name = indexEntry?.name ?? fallback.name;
  const color = firstDefined(indexEntry?.color, fallback.color);
  const createdAt =
    firstDefined(cowork?.createdAt, fallback.createdAt) ?? fallback.createdAt;
  const description = firstDefined(cowork?.description, fallback.description);
  const defaultModel = firstDefined(
    cowork?.defaultModel,
    fallback.defaultModel,
  );
  const defaultPresetId = firstDefined(
    cowork?.defaultPresetId,
    fallback.defaultPresetId,
  );
  const presets = firstDefined(cowork?.presets, fallback.presets);
  const archiveRetentionDays = firstDefined(
    cowork?.archiveRetentionDays,
    fallback.settings?.archiveRetentionDays,
  );

  return {
    version: 1,
    id: workspaceId,
    name,
    createdAt,
    ...(color !== undefined ? { color } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(defaultPresetId !== undefined ? { defaultPresetId } : {}),
    ...(presets !== undefined ? { presets } : {}),
    ...(archiveRetentionDays !== undefined
      ? { settings: { archiveRetentionDays } }
      : {}),
  };
}

export async function readArchive(
  req: StandaloneArchiveReadRequest,
): Promise<StandaloneArchiveReadResponse> {
  const snapshot = await readArchiveSnapshot(req.projectId, req.chatId, {
    chatIds: [req.chatId],
    pageOnly: true,
  });
  if (snapshot) {
    return {
      snapshot,
      transcriptScope: {
        projectId: req.projectId,
        worktreeId: legacyArchiveWorktreeId(req.projectId),
        chatId: req.chatId,
        standaloneHistory: true,
      },
      summary: await readArchiveSummary(req.projectId, req.chatId),
      legacySummaryOnly: false,
    };
  }
  const unifiedArchives = await readChatArchivesFile(
    resolveCoworkWorkspaceId(req.projectId),
    legacyArchiveWorktreeId(req.projectId),
    { chatIds: [req.chatId], pageOnly: true },
  );
  const entry = unifiedArchives.archived.find(
    (candidate) => candidate.tab.id === req.chatId,
  );
  return {
    transcriptScope: {
      projectId: resolveCoworkWorkspaceId(req.projectId),
      worktreeId: legacyArchiveWorktreeId(req.projectId),
      chatId: req.chatId,
    },
    snapshot: entry
      ? {
          version: 1,
          projectId: req.projectId,
          chatId: req.chatId,
          archivedAt: entry.archivedAt,
          tab: entry.tab,
        }
      : null,
    summary:
      entry?.tab.description ??
      (await readArchiveSummary(req.projectId, req.chatId)),
    legacySummaryOnly: entry === undefined,
  };
}

async function resumeArchive(
  req: StandaloneArchiveResumeRequest,
): Promise<StandaloneArchiveResumeResponse> {
  const historySnapshot = await readArchiveSnapshot(req.projectId, req.chatId);
  const unifiedArchives = historySnapshot
    ? null
    : await readChatArchivesFile(
        resolveCoworkWorkspaceId(req.projectId),
        legacyArchiveWorktreeId(req.projectId),
      );
  const snapshotTab =
    historySnapshot?.tab ??
    unifiedArchives?.archived.find(
      (candidate) => candidate.tab.id === req.chatId,
    )?.tab;
  if (!snapshotTab) {
    throw new Error('Archive snapshot not found');
  }
  let messages = snapshotTab.transcript ? [] : snapshotTab.messages;
  if (snapshotTab.transcript) {
    // The resumed chat is a copy without the archive's delegate logs: its
    // delegated tasks carry their children as rows.
    if (historySnapshot) {
      const store = await getStandaloneHistoryStorage(
        req.projectId,
        req.chatId,
      );
      if (!store) throw new Error('Archive disappeared');
      messages = await new ChatStateV2Backend(store).consumeTranscript(
        req.chatId,
        true,
        async (rows) => {
          const result = [];
          for await (const message of rows) result.push(message);
          return result;
        },
        { inlineDelegationChildren: true },
      );
    } else
      messages = await readChatTranscript(
        resolveCoworkWorkspaceId(req.projectId),
        legacyArchiveWorktreeId(req.projectId),
        req.chatId,
        true,
        { inlineDelegationChildren: true },
      );
  }
  const tab = sanitizeResumedTab(
    {
      ...snapshotTab,
      messages,
      transcript: undefined,
      transcriptWindow: undefined,
      transcriptLoaded: undefined,
    },
    req.mode,
  );
  if (req.destinationEntryId) {
    // Install the resumed tab into the destination work entry's canonical
    // scope. Durable chat state is main-owned: the renderer only displays the
    // response and must never persist the snapshot itself.
    validateId(req.destinationEntryId, 'destinationEntryId');
    const scope = {
      projectId: resolveCoworkWorkspaceId(req.projectId),
      worktreeId: req.destinationEntryId,
    };
    const service = getChatStateService();
    const current = await service.getCompatibilityTabs(scope);
    if (!current.tabs.some((candidate) => candidate.id === tab.id)) {
      const activeTab = current.tabs.find(
        (candidate) => candidate.id === current.activeTabId,
      );
      const replaceEmptyStarter =
        activeTab !== undefined &&
        (activeTab.kind ?? 'chat') === 'chat' &&
        (activeTab.transcript?.messageCount ?? activeTab.messages.length) === 0;
      const tabs = replaceEmptyStarter
        ? current.tabs.map((candidate) =>
            candidate.id === activeTab.id ? tab : candidate,
          )
        : [...current.tabs, tab];
      await service.replaceCompatibilityTabs(
        scope,
        { ...current, version: 1, tabs, activeTabId: tab.id },
        {
          changedTabIds: [tab.id],
          removedTabIds: replaceEmptyStarter ? [activeTab.id] : [],
          activeTabId: tab.id,
        },
      );
    }
  }
  return { tab };
}

export async function loadWorkspace(
  req: StandaloneWorkspaceSnapshotRequest,
): Promise<StandaloneWorkspaceSnapshotResponse> {
  const [project, archives] = await settleAll([
    getWorkspaceProjectFile(req.projectId),
    loadHistoryIndex(req.projectId),
  ]);
  return {
    project,
    archives,
  };
}

// ---------------------------------------------------------------------------
// Export/import-project: portable cowork-workspace bundles
// ---------------------------------------------------------------------------
//
// A bundle directory holds:
//   - `cowork-workspace.json` — manifest: { version: 1, name, color?, cowork? }
//   - `home/`                 — the workspace's managed (or external) home folder
//   - `chats/home.json`       — the live `chats/home.json` chat-tabs file, if any
//   - `chat-history/`         — archived chat history dirs, if any
//
// Import also accepts the OLD pre-cowork bundle shape (a `project.json` file
// plus the legacy `standalone-chat/{project}` layout: `chat-tabs.json`,
// `history/{chatId}/`, `workspace/{notes,prompts,attachments,artifacts}`,
// `artifacts-index.json`) so exports taken before the cowork migration can
// still be restored. That compat path is best-effort: absolute paths embedded
// inside legacy `meta.json`/`conversation.json`/pinned-context entries that
// pointed at the *original* legacy project directory are not rewritten to the
// new home, mirroring a known limitation of the old export/import flow rather
// than fixing it as part of this reshape.

/** On-disk manifest shape for the new-format portable export bundle. */
interface CoworkWorkspaceExportManifest {
  version: 1 | 2;
  name: string;
  color?: string;
  cowork?: CoworkWorkspaceSettings;
  defaultPluginSelections?: ChatTabPluginSelections;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function parseCoworkWorkspaceExportManifest(
  raw: string,
): CoworkWorkspaceExportManifest | null {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    typeof parsed.name !== 'string'
  ) {
    return null;
  }
  const cowork = normalizeCoworkSettings(parsed.cowork);
  const defaultPluginSelections =
    parsed.defaultPluginSelections === undefined
      ? undefined
      : normalizePluginSelections(parsed.defaultPluginSelections);
  return {
    version: parsed.version,
    name: parsed.name,
    ...(typeof parsed.color === 'string' ? { color: parsed.color } : {}),
    ...(cowork !== undefined ? { cowork } : {}),
    ...(defaultPluginSelections !== undefined
      ? { defaultPluginSelections }
      : {}),
  };
}

async function readCoworkWorkspaceExportManifest(
  sourcePath: string,
): Promise<CoworkWorkspaceExportManifest | null> {
  return readFile(join(sourcePath, 'cowork-workspace.json'), 'utf8')
    .then((raw) => parseCoworkWorkspaceExportManifest(raw))
    .catch(() => null);
}

async function exportProject(
  event: IpcMainInvokeEvent | undefined,
  req: StandaloneProjectExportRequest,
): Promise<StandaloneProjectExportResponse> {
  const workspaceId = resolveCoworkWorkspaceId(req.projectId);
  const [indexEntry, workspaceConfig] = await settleAll([
    readWorkspaceIndexEntry(workspaceId),
    readWorkspaceConfig(workspaceId),
  ]);
  const name = indexEntry?.name ?? workspaceId;

  // A commit is durable in the journal before the idle checkpoint writes the
  // portable snapshot files. Export copies snapshots, so establish an
  // explicit checkpoint boundary for every scope before walking the tree.
  const chatScopeIds = new Set([
    COWORK_HOME_WORKTREE_ID,
    ...(await listWorkEntryIds(workspaceId)),
  ]);
  for (const family of [
    'chats',
    'chat-archives',
    'chat-journals',
    'chat-storage-manifests',
  ]) {
    const directory = join(getWorkspaceDir(workspaceId), family);
    if (!(await pathIsDirectory(directory))) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const suffix = family === 'chat-journals' ? '.jsonl' : '.json';
      if (
        !entry.isFile() ||
        !entry.name.endsWith(suffix) ||
        entry.name.includes('.conflict-')
      )
        continue;
      const id = entry.name.slice(0, -suffix.length);
      validateId(id, 'scopeId');
      chatScopeIds.add(id);
    }
  }
  await settleAll(
    Array.from(chatScopeIds, (worktreeId) =>
      getChatStateService().flushScope(workspaceId, worktreeId),
    ),
  );

  const destinationRoot =
    req.destinationPath ??
    (await chooseDirectoryForEvent(event, 'Export standalone project'));
  if (!destinationRoot) {
    throw new Error('Export canceled');
  }
  if (!isAbsolute(destinationRoot)) {
    throw new Error('Destination path must be absolute');
  }

  const folderName = `${slugify(name) || workspaceId}-export`;
  let targetPath = join(destinationRoot, folderName);
  let counter = 2;
  while (true) {
    try {
      await readdir(targetPath);
      targetPath = join(destinationRoot, `${folderName}-${counter++}`);
    } catch {
      break;
    }
  }

  await mkdir(targetPath, { recursive: true });

  const manifest: CoworkWorkspaceExportManifest = {
    version: 2,
    name,
    ...(indexEntry?.color !== undefined ? { color: indexEntry.color } : {}),
    ...(workspaceConfig.cowork !== undefined
      ? { cowork: workspaceConfig.cowork }
      : {}),
    ...(workspaceConfig.defaultPluginSelections !== undefined
      ? { defaultPluginSelections: workspaceConfig.defaultPluginSelections }
      : {}),
  };
  await writeFile(
    join(targetPath, 'cowork-workspace.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const homeSource =
    workspaceConfig.externalPath ?? getWorkspaceHomeDir(workspaceId);
  if (await pathIsDirectory(homeSource)) {
    await cp(homeSource, join(targetPath, 'home'), { recursive: true });
  }

  for (const worktreeId of Array.from(chatScopeIds)) {
    await getChatStateService().captureStorageScope(
      { projectId: workspaceId, worktreeId },
      new ChatStorageV2(targetPath, worktreeId),
    );
  }
  const workEntriesSource = getWorkspaceWorkEntriesFilePath(workspaceId);
  if (await pathExists(workEntriesSource)) {
    await cp(workEntriesSource, join(targetPath, 'work-entries.json'));
  }
  for (const chatId of await listHistoryChatIds(req.projectId))
    await getStandaloneHistoryStorage(workspaceId, chatId);
  const chatHistorySource = getWorkspaceChatHistoryRootDir(workspaceId);
  if (await pathIsDirectory(chatHistorySource)) {
    await cp(chatHistorySource, join(targetPath, 'chat-history'), {
      recursive: true,
    });
  }

  return { exportedPath: targetPath };
}

function assertInsideWorkspaceDir(workspaceId: string, target: string): void {
  if (!isPathInside(getWorkspaceDir(workspaceId), target)) {
    throw new Error('Invalid import destination path');
  }
}

async function assertImportTreeHasNoSymlinks(source: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    throw new Error('Imported project bundles cannot contain symlinks');
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error('Imported project bundles cannot contain symlinks');
    }
    if (entry.isDirectory()) {
      await assertImportTreeHasNoSymlinks(join(source, entry.name));
    }
  }
}

interface CoworkWorkspaceImportSources {
  transcriptRoot?: string;
  homeSource?: string;
  /** Whole per-entry chats/ dir from a new-shape bundle. */
  chatTabsDirSource?: string;
  /** Work-entry registry from a new-shape bundle. */
  workEntriesSource?: string;
  /** Per-entry chat-archives/ dir from a new-shape bundle. */
  chatArchivesDirSource?: string;
  /** Single flat tab file from a legacy bundle (restored to home.json). */
  chatTabsSource?: string;
  chatHistorySource?: string;
}

async function preflightCoworkWorkspaceContents(
  sources: CoworkWorkspaceImportSources,
): Promise<void> {
  for (const source of [
    ...(sources.transcriptRoot
      ? [
          join(sources.transcriptRoot, 'chat-storage-v2'),
          join(sources.transcriptRoot, 'chat-storage-manifests'),
        ]
      : []),
    sources.chatTabsDirSource,
    sources.workEntriesSource,
    sources.chatArchivesDirSource,
    sources.chatTabsSource,
    sources.chatHistorySource,
  ]) {
    if (source && (await pathExists(source))) {
      await assertImportTreeHasNoSymlinks(source);
    }
  }
  // Refuse storage this build cannot open before the import creates anything.
  const root = sources.transcriptRoot;
  if (root && (await pathIsDirectory(join(root, 'chat-storage-manifests')))) {
    const manifests = await readdir(join(root, 'chat-storage-manifests'), {
      withFileTypes: true,
    });
    for (const entry of manifests)
      if (
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        !entry.name.includes('.backup')
      )
        await new ChatStorageV2(root, entry.name.slice(0, -5)).format();
  }
  if (
    sources.workEntriesSource &&
    (await pathExists(sources.workEntriesSource))
  ) {
    parseWorkEntriesFile(await readFile(sources.workEntriesSource, 'utf8'));
  }
}

async function stripImportedApprovalStateFromHistoryDirectory(
  workspaceId: string,
  historyRootDir: string,
): Promise<void> {
  for (const directoryEntry of await readdir(historyRootDir, {
    withFileTypes: true,
  })) {
    if (!directoryEntry.isDirectory()) continue;
    const chatId = directoryEntry.name;
    validateId(chatId, 'chatId');
    const store = await getStandaloneHistoryStorage(
      workspaceId,
      chatId,
      historyRootDir,
    );
    if (!store) continue;
    const backend = new ChatStateV2Backend(store);
    const state = await backend.state();
    const entry = state.archivesFile.archived.find(
      (entry) => entry.tab.id === chatId,
    );
    if (
      entry &&
      (entry.tab.approvalMode !== undefined ||
        entry.tab.sessionApprovalRules !== undefined)
    )
      await backend.transact(
        () => [
          {
            type: 'archive.upserted',
            entry: {
              ...entry,
              tab: {
                ...entry.tab,
                approvalMode: undefined,
                sessionApprovalRules: undefined,
              },
            },
          },
        ],
        { source: 'import' },
      );
  }
}

/** Copies bundle content into a newly created cowork workspace. */
async function restoreCoworkWorkspaceContents(
  workspaceId: string,
  sources: CoworkWorkspaceImportSources,
): Promise<void> {
  await preflightCoworkWorkspaceContents(sources);
  const staging = join(
    getWorkspaceDir(workspaceId),
    `chat-import-${randomUUID()}`,
  );
  await mkdir(staging, { recursive: true });
  const home = getWorkspaceHomeDir(workspaceId);
  assertInsideWorkspaceDir(workspaceId, home);
  if (sources.homeSource && (await pathIsDirectory(sources.homeSource))) {
    await cp(sources.homeSource, home, { recursive: true });
  }

  if (
    sources.chatTabsDirSource &&
    (await pathIsDirectory(sources.chatTabsDirSource))
  ) {
    const chatTabsDir = join(staging, 'chats');
    assertInsideWorkspaceDir(workspaceId, chatTabsDir);
    await cp(sources.chatTabsDirSource, chatTabsDir, { recursive: true });
  }

  if (
    sources.workEntriesSource &&
    (await pathExists(sources.workEntriesSource))
  ) {
    const workEntriesDestination = getWorkspaceWorkEntriesFilePath(workspaceId);
    assertInsideWorkspaceDir(workspaceId, workEntriesDestination);
    await cp(sources.workEntriesSource, workEntriesDestination);
  }

  if (
    sources.chatArchivesDirSource &&
    (await pathIsDirectory(sources.chatArchivesDirSource))
  ) {
    const chatArchivesDir = join(staging, 'chat-archives');
    assertInsideWorkspaceDir(workspaceId, chatArchivesDir);
    await cp(sources.chatArchivesDirSource, chatArchivesDir, {
      recursive: true,
    });
  }

  if (sources.chatTabsSource && (await pathExists(sources.chatTabsSource))) {
    const chatTabsDestination = join(
      staging,
      'chats',
      `${COWORK_HOME_WORKTREE_ID}.json`,
    );
    assertInsideWorkspaceDir(workspaceId, chatTabsDestination);
    await mkdir(dirname(chatTabsDestination), { recursive: true });
    await cp(sources.chatTabsSource, chatTabsDestination);
  }

  if (
    sources.chatHistorySource &&
    (await pathIsDirectory(sources.chatHistorySource))
  ) {
    const stagedChatHistory = join(staging, 'chat-history');
    const chatHistoryDestination = getWorkspaceChatHistoryRootDir(workspaceId);
    assertInsideWorkspaceDir(workspaceId, stagedChatHistory);
    assertInsideWorkspaceDir(workspaceId, chatHistoryDestination);
    try {
      await cp(sources.chatHistorySource, stagedChatHistory, {
        recursive: true,
      });
      await stripImportedApprovalStateFromHistoryDirectory(
        workspaceId,
        stagedChatHistory,
      );
      await cp(stagedChatHistory, chatHistoryDestination, { recursive: true });
    } finally {
      await rm(stagedChatHistory, { recursive: true, force: true });
    }
  }

  if (sources.transcriptRoot) {
    for (const family of ['chat-storage-v2', 'chat-storage-manifests']) {
      const source = join(sources.transcriptRoot, family);
      if (!(await pathIsDirectory(source)))
        throw new Error('Transcript bundle is missing its storage closure');
      await cp(source, join(staging, family), { recursive: true });
    }
  }
  const scopeIds = new Set<string>();
  for (const family of ['chats', 'chat-archives', 'chat-storage-manifests']) {
    const directory = join(staging, family);
    if (!(await pathIsDirectory(directory))) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith('.json') ||
        entry.name.includes('.backup')
      )
        continue;
      const id = entry.name.slice(0, -5);
      validateId(id, 'scopeId');
      scopeIds.add(id);
    }
  }
  for (const scopeId of Array.from(scopeIds)) {
    const store = new ChatStorageV2(staging, scopeId);
    await migrateLegacyChatScope(store, {
      tabs: join(staging, 'chats', `${scopeId}.json`),
      archives: join(staging, 'chat-archives', `${scopeId}.json`),
      journal: join(staging, 'chat-journals', `${scopeId}.jsonl`),
    });
    const state = await new ChatStateV2Backend(store).state();
    const sanitize = (tab: PersistedChatTab): PersistedChatTab => ({
      ...tab,
      approvalMode: undefined,
      sessionApprovalRules: undefined,
    });
    await getChatStateService().importStorageScope(
      { projectId: workspaceId, worktreeId: scopeId },
      store,
      { ...state.tabsFile, tabs: state.tabsFile.tabs.map(sanitize) },
      {
        ...state.archivesFile,
        archived: state.archivesFile.archived.map((entry) => ({
          ...entry,
          tab: sanitize(entry.tab),
        })),
      },
    );
  }
  await rm(staging, { recursive: true });

  // Any restored flat home.json (a pre-entry export, or a new-shape bundle
  // whose source workspace never migrated) splits into work entries here —
  // the global startup marker is already set on this install, so the import
  // is the only chance to convert it.
  await migrateWorkspaceChatsToWorkEntries(workspaceId);
}

/** Overwrites the newly created workspace's index color / cowork settings block from an imported manifest. */
async function applyImportedCoworkSettings(
  workspaceId: string,
  manifest: Pick<
    CoworkWorkspaceExportManifest,
    'color' | 'cowork' | 'defaultPluginSelections'
  >,
): Promise<void> {
  if (
    manifest.color === undefined &&
    manifest.cowork === undefined &&
    manifest.defaultPluginSelections === undefined
  ) {
    return;
  }
  await recordCoworkWorkspaceMetadata({
    source: 'bundle_import',
    workspaceId,
    change: { kind: 'import', ...manifest },
  });
}

async function findImportedChatProject(
  workspaceId: string,
): Promise<ChatProjectData> {
  const projects = await listCoworkWorkspacesAsChatProjects();
  const project = projects.find((entry) => entry.id === workspaceId);
  if (!project) {
    throw new Error('Imported project not found after creation');
  }
  return project;
}

async function importCoworkWorkspaceBundle(
  manifest: CoworkWorkspaceExportManifest,
  sources: CoworkWorkspaceImportSources,
): Promise<StandaloneProjectImportResponse> {
  const created = await createCoworkWorkspace(
    manifest.name,
    manifest.cowork?.createdAt ?? new Date().toISOString(),
  );
  await applyImportedCoworkSettings(created.id, manifest);
  await restoreCoworkWorkspaceContents(created.id, sources);
  await rebuildHistoryIndex(created.id);

  return { project: await findImportedChatProject(created.id) };
}

/** Legacy-bundle-root entries that `restoreLegacyWorkspaceHome` handles explicitly; anything else at the bundle root is copied through to `home/` verbatim. */
const LEGACY_BUNDLE_ROOT_ENTRIES = new Set([
  'project.json',
  'chat-tabs.json',
  'history',
  'workspace',
  'artifacts-index.json',
  '.git',
  '.gitignore',
  'derived',
]);

async function copyLegacyManagedSubdirIfPresent(
  source: string,
  destination: string,
): Promise<void> {
  if (await pathIsDirectory(source)) {
    await cp(source, destination, { recursive: true });
  }
}

/** Restructures a legacy `standalone-chat/{project}` bundle root into the new workspace's `home/`, mirroring `cowork-migration.ts`'s one-time restructure (best-effort; see the module-level comment above). */
async function restoreLegacyWorkspaceHome(
  workspaceId: string,
  sourcePath: string,
): Promise<void> {
  const home = getWorkspaceHomeDir(workspaceId);
  assertInsideWorkspaceDir(workspaceId, home);
  const legacyWorkspaceDir = join(sourcePath, 'workspace');

  await copyLegacyManagedSubdirIfPresent(
    join(legacyWorkspaceDir, 'notes'),
    getCoworkManagedSubdir(home, 'notes'),
  );
  await copyLegacyManagedSubdirIfPresent(
    join(legacyWorkspaceDir, 'prompts'),
    getCoworkManagedSubdir(home, 'prompts'),
  );
  await copyLegacyManagedSubdirIfPresent(
    join(legacyWorkspaceDir, 'attachments'),
    getCoworkManagedSubdir(home, 'attachments'),
  );

  const legacyArtifactsDir = join(legacyWorkspaceDir, 'artifacts');
  if (await pathIsDirectory(legacyArtifactsDir)) {
    await cp(legacyArtifactsDir, home, { recursive: true });
  }

  const legacyArtifactsIndex = join(sourcePath, 'artifacts-index.json');
  if (await pathExists(legacyArtifactsIndex)) {
    await cp(legacyArtifactsIndex, getCoworkArtifactsIndexFilePath(home));
  }

  const rootEntries = await readdir(sourcePath, {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of rootEntries) {
    if (LEGACY_BUNDLE_ROOT_ENTRIES.has(entry.name)) {
      continue;
    }
    await cp(join(sourcePath, entry.name), join(home, entry.name), {
      recursive: true,
    });
  }
}

async function importLegacyProjectBundle(
  sourcePath: string,
  sources: CoworkWorkspaceImportSources,
): Promise<StandaloneProjectImportResponse> {
  const legacyProjectFile = await readFile(
    join(sourcePath, 'project.json'),
    'utf8',
  )
    .then((raw) => parseImportedStandaloneProjectFile(raw))
    .catch(() => null);

  const name = legacyProjectFile?.name.trim() || basename(sourcePath);
  const created = await createCoworkWorkspace(
    name,
    legacyProjectFile?.createdAt ?? new Date().toISOString(),
  );

  if (legacyProjectFile) {
    const cowork: CoworkWorkspaceSettings = {
      createdAt: legacyProjectFile.createdAt,
      description: legacyProjectFile.description,
      defaultModel: legacyProjectFile.defaultModel,
      defaultPresetId: legacyProjectFile.defaultPresetId,
      presets: legacyProjectFile.presets,
      archiveRetentionDays: legacyProjectFile.settings?.archiveRetentionDays,
    };
    await applyImportedCoworkSettings(created.id, {
      ...(legacyProjectFile.color !== undefined
        ? { color: legacyProjectFile.color }
        : {}),
      cowork,
    });
  }

  await restoreLegacyWorkspaceHome(created.id, sourcePath);
  await restoreCoworkWorkspaceContents(created.id, sources);
  await rebuildHistoryIndex(created.id);

  return { project: await findImportedChatProject(created.id) };
}

async function importProject(
  event: IpcMainInvokeEvent | undefined,
  req: StandaloneProjectImportRequest,
): Promise<StandaloneProjectImportResponse> {
  const sourcePath =
    req.sourcePath ??
    (await chooseDirectoryForEvent(event, 'Import standalone project'));
  if (!sourcePath) {
    throw new Error('Import canceled');
  }
  if (!isAbsolute(sourcePath)) {
    throw new Error('Source path must be absolute');
  }
  if (!(await pathIsDirectory(sourcePath))) {
    throw new Error('Import source must be an existing directory');
  }

  const manifest = await readCoworkWorkspaceExportManifest(sourcePath);
  if (manifest) {
    const sources: CoworkWorkspaceImportSources = {
      transcriptRoot: manifest.version === 2 ? sourcePath : undefined,
      homeSource: join(sourcePath, 'home'),
      chatTabsDirSource: join(sourcePath, 'chats'),
      workEntriesSource: join(sourcePath, 'work-entries.json'),
      chatArchivesDirSource: join(sourcePath, 'chat-archives'),
      chatHistorySource: join(sourcePath, 'chat-history'),
    };
    await preflightCoworkWorkspaceContents(sources);
    return serializeChatProjectOperation(() =>
      importCoworkWorkspaceBundle(manifest, sources),
    );
  }
  const sources: CoworkWorkspaceImportSources = {
    chatTabsSource: join(sourcePath, 'chat-tabs.json'),
    chatHistorySource: join(sourcePath, 'history'),
  };
  await preflightCoworkWorkspaceContents(sources);
  return serializeChatProjectOperation(() =>
    importLegacyProjectBundle(sourcePath, sources),
  );
}

export function registerStandaloneChatHandlers(): void {
  registerIpcHandler<[string?], void>(
    IPC_CHANNELS.standaloneChatInit,
    async (_event, projectId) => initStandaloneChat(projectId),
  );

  registerIpcHandler<[string?], StandaloneChatListResponse>(
    IPC_CHANNELS.standaloneChatList,
    async (_event, projectId) => {
      const resolvedProjectId = resolveChatProjectId(projectId);
      validateId(resolvedProjectId, 'projectId');
      return listChats(resolvedProjectId);
    },
  );

  registerIpcHandler<
    [StandaloneChatReadSummaryRequest],
    StandaloneChatReadSummaryResponse
  >(IPC_CHANNELS.standaloneChatReadSummary, async (_event, req) => {
    const resolvedProjectId = resolveChatProjectId(req.projectId);
    validateId(req.chatId, 'chatId');
    validateId(resolvedProjectId, 'projectId');
    return {
      summary: await readSummary(req.chatId, resolvedProjectId),
    };
  });

  registerIpcHandler<
    [StandaloneArchiveReadRequest],
    StandaloneArchiveReadResponse
  >(IPC_CHANNELS.standaloneChatReadArchive, async (_event, req) => {
    validateId(req.projectId, 'projectId');
    validateId(req.chatId, 'chatId');
    return readArchive(req);
  });

  registerIpcHandler<
    [StandaloneArchiveResumeRequest],
    StandaloneArchiveResumeResponse
  >(IPC_CHANNELS.standaloneChatResumeArchive, async (_event, req) => {
    validateId(req.projectId, 'projectId');
    validateId(req.chatId, 'chatId');
    const response = await resumeArchive(req);
    recordStandaloneFeatureTelemetry({
      action: 'resume_archive',
      projectId: req.projectId,
      itemKind: 'chat',
    });
    return response;
  });

  registerIpcHandler<
    [StandaloneWorkspaceSnapshotRequest],
    StandaloneWorkspaceSnapshotResponse
  >(IPC_CHANNELS.standaloneChatLoadWorkspace, async (_event, req) => {
    validateId(req.projectId, 'projectId');
    return loadWorkspace(req);
  });

  registerIpcHandler<
    [StandaloneProjectExportRequest],
    StandaloneProjectExportResponse
  >(IPC_CHANNELS.standaloneChatExportProject, async (event, req) => {
    validateId(req.projectId, 'projectId');
    const response = await exportProject(event, req);
    recordStandaloneFeatureTelemetry({
      action: 'export_project',
      projectId: req.projectId,
      itemKind: 'project',
    });
    recordStandaloneProjectCrudTelemetry({
      action: 'export',
      projectId: req.projectId,
    });
    return response;
  });

  registerIpcHandler<
    [StandaloneProjectImportRequest],
    StandaloneProjectImportResponse
  >(IPC_CHANNELS.standaloneChatImportProject, async (event, req) => {
    const response = await importProject(event, req);
    recordStandaloneProjectCrudTelemetry({
      action: 'import',
      projectId: response.project.id,
    });
    return response;
  });
}
