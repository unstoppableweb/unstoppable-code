import { assertCoworkChatRootPresent } from './cowork-folder-guard';
import { chatLastMessageRole } from './chat-last-message-role';
import {
  publishSidebarItemGroupsChanged,
  type SidebarGroupRegistryReconciliation,
} from './sidebar-item-groups';
import { ChatStorageV2 } from './chat-storage-v2';
/**
 * Work Entry registry — the worktree-like multi-chat containers a Work Entry
 * workspace's left-nav lists. Each entry occupies the `worktreeId`
 * slot in every per-worktree store (`chats/{entryId}.json`,
 * `chat-archives/{entryId}.json`, `summaries/{entryId}.json`,
 * `worktree-data/{entryId}/`) while sharing the workspace's backing
 * directory (the agent cwd is always the workspace root — entries are
 * application-layer isolation only). This is shared by cowork workspaces and
 * App Advisor; path and cwd routing distinguish those workspace kinds.
 *
 * The registry persists only identity (`id`, optional rename override,
 * `createdAt`); display metadata is derived per list call from each entry's
 * chat-tabs file, matching how the old flat chat list derived its rows. The
 * registry array is also the user-controlled sidebar order.
 */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { LegacyChatInput } from './legacy-chat-input';
import { loadLegacyChatMigrationSource } from './legacy-chat-migration';
import { renameWithRetry } from './atomic-file';
import { dirname, join } from 'node:path';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type {
  CoworkWorkEntriesFile,
  CoworkWorkEntryData,
  CoworkWorkEntryChatSummary,
  CoworkWorkEntryMeta,
  CoworkWorkEntrySummary,
  ChatTabsFile,
  PersistedChatTab,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { DeltaJournalCheckpointRotation } from '../services/chat-state-v2-backend';
import { readWorkspaceDefaultLayoutMode } from '@canopy/desktop-shared/node/lib/panel-layout-mode';
import {
  getWorkspaceChatTabsFilePath,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceChatJournalFilePath,
  getWorkspaceWorkEntriesFilePath,
} from './paths';
import {
  EMPTY_WORK_ENTRIES_FILE,
  isWorkEntryData,
  parseWorkEntryCount,
  parseWorkEntrySidebarSummary,
  parseWorkEntriesFile,
  readWorkEntryCount,
  readWorkEntrySidebarSummary,
  readWorkEntriesFile,
} from './cowork-work-entries-file';
import { deriveWorktreeChatBadgesSummary } from './chat-badge-sync';
import { readChatTabsFile, readChatTabsFileForIndex } from './chat-tabs-reader';
import { readChatArchivesFile } from './chat-archives';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { isErrnoException } from './type-guards';
import { validateId } from './validation';
import { logMainProcessWarn } from './main-process-logging';
import { isWorkEntryWorkspace } from './workspace-registry';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import { panelLayoutModePersistenceStore } from '../panels/layout-mode-persistence';

// The registry reader/parser lives in a leaf module so the telemetry sync
// service can read work-entries.json without dragging this module's
// (types-barrel + brand runtime) import graph in behind it. Re-exported here so
// existing callers keep their import path.
export {
  isWorkEntryData,
  parseWorkEntryCount,
  parseWorkEntrySidebarSummary,
  parseWorkEntriesFile,
  readWorkEntryCount,
  readWorkEntrySidebarSummary,
  readWorkEntriesFile,
};

const EMPTY_FILE = EMPTY_WORK_ENTRIES_FILE;

/** Serializes registry mutations per workspace. */
const mutationQueues = new Map<string, Promise<unknown>>();
// Membership failure cannot hide a registry change that already committed.
const failedRegistryWriteInvalidations = new Set<string>();

export interface WorkEntryRegistryWriteOptions {
  groupMutation?: boolean;
  requireAuthoritativeRead?: boolean;
  sidebarItemGroupId?: string;
  newItemId?: string;
  assertCanCommit?: () => void;
  afterWrite?: () => Promise<void>;
}

type WorkEntryRegistryReconciler = (
  workspaceId: string,
  entries: CoworkWorkEntryData[],
  options?: WorkEntryRegistryWriteOptions,
) => Promise<SidebarGroupRegistryReconciliation<CoworkWorkEntryData>>;

let workEntryRegistryReconciler: WorkEntryRegistryReconciler | undefined;

export function setWorkEntryRegistryReconciler(
  reconciler: WorkEntryRegistryReconciler,
): void {
  workEntryRegistryReconciler = reconciler;
}
const summaryBackfills = new Map<string, Promise<CoworkWorkEntriesFile>>();
const liveSummaries = new Map<string, CoworkWorkEntrySummary>();
const deletedWorkEntryWorkspaces = new Set<string>();
const LARGE_SUMMARY_BACKFILL_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SUMMARY_BACKFILL_FILE_BYTES = 256 * 1024 * 1024;

/** Called with the resolved workspace id after an entry-list write lands. */
export type WorkEntryListChangeListener = (workspaceId: string) => void;

const workEntryListChangeListeners = new Set<WorkEntryListChangeListener>();

/**
 * Observe structural changes to a workspace's Work Entry list — an entry
 * added, removed or moved — which shift every sibling's registry index. The
 * registry cannot import the Portal projection (import cycle), so the
 * projection registers here instead. Returns the unsubscribe function.
 */
export function onWorkEntryListChanged(
  listener: WorkEntryListChangeListener,
): () => void {
  workEntryListChangeListeners.add(listener);
  return (): void => {
    workEntryListChangeListeners.delete(listener);
  };
}

/** Fired after the registry lock settles; a listener can never fail a write. */
function notifyWorkEntryListChanged(workspaceId: string): void {
  workEntryListChangeListeners.forEach((listener) => {
    try {
      listener(workspaceId);
    } catch {
      // Observers are best-effort mirrors of the durable registry write.
    }
  });
}

function summaryCacheKey(workspaceId: string, entryId: string): string {
  return `${workspaceId}/${entryId}`;
}

function resolveWorkEntryWorkspaceId(projectId: string): string {
  return projectId === APP_ADVISOR_PROJECT_ID
    ? projectId
    : resolveCoworkWorkspaceId(projectId);
}

function withRegistryLock<T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (deletedWorkEntryWorkspaces.has(workspaceId)) {
    return Promise.reject(
      new Error(`Work Entry project has been deleted: ${workspaceId}`),
    );
  }
  const prev = mutationQueues.get(workspaceId) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (
      failedRegistryWriteInvalidations.delete(workspaceId) &&
      !deletedWorkEntryWorkspaces.has(workspaceId)
    ) {
      notifyWorkEntryListChanged(workspaceId);
    }
  });
  const settled = next
    .catch(() => undefined)
    .finally(() => {
      if (mutationQueues.get(workspaceId) === settled) {
        mutationQueues.delete(workspaceId);
      }
    });
  mutationQueues.set(workspaceId, settled);
  return next;
}

/**
 * Strict reader for registry mutation paths and lock-free projections. A
 * missing registry represents a fresh workspace, but any other read or
 * validation failure must abort before an authoritative file can be
 * overwritten with incomplete data, or a projection can read it as empty.
 */
export async function readWorkEntriesFileStrict(
  workspaceId: string,
): Promise<CoworkWorkEntriesFile> {
  const filePath = getWorkspaceWorkEntriesFilePath(workspaceId);
  try {
    return parseWorkEntriesFile(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return EMPTY_FILE;
    }
    throw error;
  }
}

async function writeWorkEntriesFile(
  workspaceId: string,
  data: CoworkWorkEntriesFile,
  options?: WorkEntryRegistryWriteOptions,
): Promise<void> {
  const assertAdmitted = (): void => {
    if (deletedWorkEntryWorkspaces.has(workspaceId))
      throw new Error(`Work Entry project has been deleted: ${workspaceId}`);
  };
  assertAdmitted();
  if (options?.sidebarItemGroupId && !workEntryRegistryReconciler)
    throw new Error('Sidebar item group service is not initialized');
  const reconciliation = workEntryRegistryReconciler
    ? await workEntryRegistryReconciler(workspaceId, data.entries, options)
    : undefined;
  if (reconciliation) data = { ...data, entries: reconciliation.rows };
  const filePath = getWorkspaceWorkEntriesFilePath(workspaceId);
  const tempPath = join(dirname(filePath), `.work-entries-${randomUUID()}.tmp`);
  let installed = false;
  let prepared = false;
  try {
    await reconciliation?.beforeWrite?.();
    prepared = true;
    assertAdmitted();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    const assertCanInstall = (): void => {
      assertAdmitted();
      options?.assertCanCommit?.();
    };
    assertCanInstall();
    await renameWithRetry(tempPath, filePath, {
      beforeRetry: assertCanInstall,
    });
    installed = true;
    assertAdmitted();
  } catch (error) {
    if (prepared && reconciliation?.rollback) {
      try {
        await reconciliation.rollback();
      } catch (rollbackError) {
        throw Object.assign(
          new Error('Registry write and group rollback failed'),
          { errors: [error, rollbackError] },
        );
      }
    }
    throw error;
  } finally {
    if (!installed) await unlink(tempPath).catch(() => undefined);
  }
  try {
    await reconciliation?.afterWrite?.();
    assertAdmitted();
    publishSidebarItemGroupsChanged(workspaceId);
  } catch (error) {
    failedRegistryWriteInvalidations.add(workspaceId);
    throw error;
  }
}

function isChatKindTab(tab: PersistedChatTab): boolean {
  return tab.kind !== 'file';
}

function lastMessageIso(tab: PersistedChatTab): string | undefined {
  const timestamp = tab.transcript
    ? tab.transcript.lastMessageAt
    : tab.messages[tab.messages.length - 1]?.timestamp;
  if (timestamp === undefined) return undefined;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function normalizeLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase() === 'new chat' ? undefined : trimmed;
}

function deriveEntryDisplay(tabs: PersistedChatTab[]): CoworkWorkEntrySummary {
  const chatTabs = tabs.filter(isChatKindTab);
  // Primary chat = most recent activity (last message, else creation), the
  // same recency notion the flat chat list sorted by.
  const activityMs = (tab: PersistedChatTab): number => {
    const last = lastMessageIso(tab);
    const iso = last ?? tab.createdAt;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : 0;
  };
  const byRecency = chatTabs
    .slice()
    .sort((a, b) => activityMs(b) - activityMs(a));
  const primary = byRecency[0];

  let lastMessageAt: string | undefined;
  for (const tab of chatTabs) {
    const iso = lastMessageIso(tab);
    if (iso && (!lastMessageAt || iso > lastMessageAt)) {
      lastMessageAt = iso;
    }
  }

  const sharedTab = byRecency.find((tab) => tab.sharedRun !== undefined);

  return {
    version: 1,
    title:
      normalizeLabel(primary?.customTitle) ??
      normalizeLabel(primary?.description) ??
      normalizeLabel(primary?.title) ??
      `New ${CHAT_UNIT_LABEL}`,
    ...(lastMessageAt ? { lastMessageAt } : {}),
    ...(primary?.providerType ? { providerType: primary.providerType } : {}),
    chatCount: chatTabs.length,
    ...(sharedTab?.sharedRun ? { sharedRun: sharedTab.sharedRun } : {}),
    chats: chatTabs.map((tab) => ({
      id: tab.id,
      title: tab.title || tab.description || `New ${CHAT_UNIT_LABEL}`,
      ...(tab.customTitle !== undefined
        ? { customTitle: tab.customTitle }
        : {}),
      ...(tab.description ? { description: tab.description } : {}),
      createdAt: tab.createdAt,
      lastMessageAt: lastMessageIso(tab) ?? tab.createdAt,
      lastMessageRole: chatLastMessageRole(tab),
      ...(tab.providerType ? { providerType: tab.providerType } : {}),
      ...(tab.executionHarness
        ? { executionHarness: tab.executionHarness }
        : {}),
      ...(tab.model ? { model: tab.model } : {}),
      ...(tab.unread === true ? { unread: true } : {}),
      pluginSelections: normalizePluginSelections(tab.pluginSelections),
    })),
  };
}

/** Compact projection persisted beside each Work Entry registry row. */
export function deriveWorkEntrySummary(
  data: ChatTabsFile,
  sourceMtimeNs?: string,
): CoworkWorkEntrySummary {
  const display = deriveEntryDisplay(data.tabs);
  const { unreadChats } = deriveWorktreeChatBadgesSummary(data);
  return {
    ...display,
    ...(sourceMtimeNs ? { sourceMtimeNs } : {}),
    ...(unreadChats.length > 0 ? { unreadChats } : {}),
  };
}

function summariesEquivalent(
  left: CoworkWorkEntrySummary | undefined,
  right: CoworkWorkEntrySummary,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function summaryForEntry(
  workspaceId: string,
  entry: CoworkWorkEntryData,
): CoworkWorkEntrySummary | undefined {
  return (
    liveSummaries.get(summaryCacheKey(workspaceId, entry.id)) ?? entry.summary
  );
}

function entryMetaFromSummary(
  workspaceId: string,
  entry: CoworkWorkEntryData,
  summary: CoworkWorkEntrySummary,
  options?: ListWorkEntriesOptions,
): CoworkWorkEntryMeta {
  const hasActiveChat =
    (options?.getActiveChatIds?.(workspaceId, entry.id).length ?? 0) > 0;
  return {
    id: entry.id,
    ...(entry.hasUserChanges === true ||
    normalizeLabel(entry.title) ||
    entry.pinned === true ||
    entry.status === 'done'
      ? { hasUserChanges: true }
      : {}),
    ...(entry.pinned === true ? { pinned: true } : {}),
    title: normalizeLabel(entry.title) ?? summary.title,
    createdAt: entry.createdAt,
    ...(entry.lastTouchedAt ? { lastTouchedAt: entry.lastTouchedAt } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    ...(summary.lastMessageAt ? { lastMessageAt: summary.lastMessageAt } : {}),
    ...(summary.providerType ? { providerType: summary.providerType } : {}),
    chatCount: summary.chatCount,
    ...(summary.sharedRun ? { sharedRun: summary.sharedRun } : {}),
    ...(summary.unreadChats && summary.unreadChats.length > 0
      ? { unreadChats: summary.unreadChats }
      : {}),
    ...(hasActiveChat ? { hasActiveChat: true } : {}),
  };
}

/**
 * The file whose modification time fingerprints a Work Entry's summary
 * source: the legacy tabs file, the version 2 live index, or a delta-journal
 * scope's journal.
 */
export async function summarySourcePath(
  workspaceId: string,
  entryId: string,
): Promise<string> {
  return (await summarySource(workspaceId, entryId)).path;
}

async function summarySource(
  workspaceId: string,
  entryId: string,
): Promise<{ path: string; indexed: boolean }> {
  const legacy = getWorkspaceChatTabsFilePath(workspaceId, entryId);
  const store = new ChatStorageV2(dirname(dirname(legacy)), entryId);
  const format = await store.format();
  // A delta-journal scope's live index is only its last checkpoint. Its
  // journal changes on every commit and is replaced by every checkpoint, so
  // its modification time tracks the committed state; a checkpoint carries a
  // current summary's stamp to the replacement (refreshWorkEntrySummaryStamp).
  const journalFile =
    format === 'v3' || format === 'v4' ? await store.journalFile() : undefined;
  return journalFile
    ? { path: join(store.directory, journalFile), indexed: true }
    : format !== 'v1'
      ? { path: join(store.directory, 'live-index.json'), indexed: true }
      : { path: legacy, indexed: false };
}

/**
 * Fill the chat selections a summary from an older build lacks, from the
 * scope's committed metadata indexes; no transcript is read. Returns
 * undefined when the indexes no longer list every summarized chat.
 */
async function withIndexedPluginSelections(
  workspaceId: string,
  entryId: string,
  summary: CoworkWorkEntrySummary,
): Promise<CoworkWorkEntrySummary | undefined> {
  const legacy = getWorkspaceChatTabsFilePath(workspaceId, entryId);
  const { live } = await new ChatStorageV2(
    dirname(dirname(legacy)),
    entryId,
  ).indexes();
  const chats: CoworkWorkEntryChatSummary[] = [];
  for (const chat of summary.chats) {
    const tab = live.tabs.find((candidate) => candidate.id === chat.id);
    if (!tab) return undefined;
    chats.push({
      ...chat,
      lastMessageRole: tab.transcript.lastMessageRole,
      pluginSelections: normalizePluginSelections(tab.pluginSelections),
    });
  }
  return { ...summary, chats };
}

/** Catalog recovery is read-only: it must never admit/migrate an unopened
 * scope while the workspace registry lock is held. Retain only the last
 * timestamp and unread preview; the full source stays in private scratch. */
async function readLegacyCatalog(
  workspaceId: string,
  entryId: string,
  sourceMtimeNs: string,
): Promise<{ summary: CoworkWorkEntrySummary; hasArchives: boolean }> {
  const scratch = await mkdtemp(join(tmpdir(), 'canopy-chat-summary-'));
  let input: LegacyChatInput | undefined;
  try {
    input = await LegacyChatInput.create(scratch);
    const source = await loadLegacyChatMigrationSource(input, {
      tabs: getWorkspaceChatTabsFilePath(workspaceId, entryId),
      archives: getWorkspaceChatArchivesFilePath(workspaceId, entryId),
      journal: getWorkspaceChatJournalFilePath(workspaceId, entryId),
    });
    const tabs: PersistedChatTab[] = [];
    const roles = new Map<string, 'user' | 'assistant'>();
    let hasArchives = false;
    for await (const chat of source.chats) {
      if (chat.archive) {
        hasArchives = true;
        continue;
      }
      const projected: PersistedChatTab = { ...chat.metadata, messages: [] };
      delete projected.transcript;
      let last: PersistedChatMessage | undefined;
      let lastAssistant: PersistedChatMessage | undefined;
      let conversationalRole: 'user' | 'assistant' | undefined;
      for await (const message of chat.messages) {
        last = {
          id: message.id,
          role: message.role,
          timestamp: message.timestamp,
          blocks: [],
        };
        if (message.role === 'user' || message.role === 'assistant')
          conversationalRole = message.role;
        if (projected.unread && message.role === 'assistant') {
          const preview = deriveWorktreeChatBadgesSummary({
            version: 1,
            activeTabId: projected.id,
            tabs: [{ ...projected, messages: [message] }],
          }).unreadChats[0]?.preview;
          if (preview)
            lastAssistant = {
              ...last,
              blocks: [{ type: 'text', text: preview }],
            };
        }
      }
      if (lastAssistant) projected.messages.push(lastAssistant);
      if (last && last.id !== lastAssistant?.id) projected.messages.push(last);
      if (conversationalRole) roles.set(projected.id, conversationalRole);
      tabs.push(projected);
    }
    await source.assertUnchanged?.();
    // A concurrent native cutover invalidates this legacy catalog projection,
    // even during the interval before its original files are cleaned up.
    const legacy = getWorkspaceChatTabsFilePath(workspaceId, entryId);
    if (
      (await new ChatStorageV2(
        dirname(dirname(legacy)),
        entryId,
      ).authority()) !== 'v1'
    )
      throw new Error('Chat storage changed during summary recovery');
    const summary = deriveWorkEntrySummary(
      { version: 1, activeTabId: source.index.activeTabId ?? '', tabs },
      sourceMtimeNs,
    );
    return {
      summary: {
        ...summary,
        chats: summary.chats.map((chat) => ({
          ...chat,
          lastMessageRole: roles.get(chat.id),
        })),
      },
      hasArchives,
    };
  } finally {
    await input?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Metadata-only projection of one Work Entry's chats for bulk callers. */
export interface WorkEntryChatCatalog {
  /** Live chat-kind tab ids (file tabs excluded). */
  liveChatIds: string[];
  archives: Array<{ chatId: string; archivedAt: string }>;
}

/**
 * Catalog read for bulk callers (telemetry counts, archive-retention gating,
 * startup sweeps). It is NOT scope admission: a v2 scope answers from its
 * on-disk indexes and a legacy scope is recovered read-only through the same
 * spill-to-scratch loader `readLegacyCatalog` uses, so no manifest is written
 * and no repository scope is loaded. Callers that need to mutate the scope
 * admit it explicitly afterwards through the chat state service.
 */
export async function readWorkEntryChatCatalog(
  projectId: string,
  entryId: string,
): Promise<WorkEntryChatCatalog> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  const legacy = getWorkspaceChatTabsFilePath(workspaceId, entryId);
  const store = new ChatStorageV2(dirname(dirname(legacy)), entryId);
  if ((await store.authority()) === 'v2') {
    const { live, archive } = await store.indexes();
    return {
      liveChatIds: live.tabs
        .filter((tab) => (tab.kind ?? 'chat') === 'chat')
        .map((tab) => tab.id),
      archives: archive.archived.map((entry) => ({
        chatId: entry.tab.id,
        archivedAt: entry.archivedAt,
      })),
    };
  }
  const scratch = await mkdtemp(join(tmpdir(), 'canopy-chat-catalog-'));
  let input: LegacyChatInput | undefined;
  try {
    input = await LegacyChatInput.create(scratch);
    const source = await loadLegacyChatMigrationSource(input, {
      tabs: legacy,
      archives: getWorkspaceChatArchivesFilePath(workspaceId, entryId),
      journal: getWorkspaceChatJournalFilePath(workspaceId, entryId),
    });
    const catalog: WorkEntryChatCatalog = { liveChatIds: [], archives: [] };
    for await (const chat of source.chats) {
      if (chat.archive) {
        catalog.archives.push({
          chatId: chat.metadata.id,
          archivedAt: chat.archive.archivedAt,
        });
      } else if ((chat.metadata.kind ?? 'chat') === 'chat') {
        catalog.liveChatIds.push(chat.metadata.id);
      }
    }
    await source.assertUnchanged?.();
    return catalog;
  } finally {
    await input?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function deriveLegacySummary(
  workspaceId: string,
  entryId: string,
): Promise<CoworkWorkEntrySummary | undefined> {
  const filePath = await summarySourcePath(workspaceId, entryId);
  let fileBytes = 0;
  let sourceMtimeNs = '';
  try {
    const fileStats = await stat(filePath, { bigint: true });
    fileBytes = Number(fileStats.size);
    sourceMtimeNs = fileStats.mtimeNs.toString();
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return deriveWorkEntrySummary(
        { version: 1, tabs: [], activeTabId: '' },
        'missing',
      );
    }
    logMainProcessWarn('Failed to stat cowork transcript summary backfill', {
      workspaceId,
      entryId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (fileBytes >= LARGE_SUMMARY_BACKFILL_FILE_BYTES) {
    logMainProcessWarn('Large cowork transcript summary backfill', {
      workspaceId,
      entryId,
      fileBytes,
      heapUsed: process.memoryUsage().heapUsed,
    });
  }
  if (fileBytes > MAX_SUMMARY_BACKFILL_FILE_BYTES) {
    logMainProcessWarn('Skipped oversized cowork transcript summary backfill', {
      workspaceId,
      entryId,
      fileBytes,
      maxBytes: MAX_SUMMARY_BACKFILL_FILE_BYTES,
    });
    return undefined;
  }
  try {
    const legacy = getWorkspaceChatTabsFilePath(workspaceId, entryId);
    const store = new ChatStorageV2(dirname(dirname(legacy)), entryId);
    if ((await store.authority()) === 'v1')
      return (await readLegacyCatalog(workspaceId, entryId, sourceMtimeNs))
        .summary;
    return deriveWorkEntrySummary(
      await readChatTabsFileForIndex(workspaceId, entryId),
      sourceMtimeNs,
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return deriveWorkEntrySummary(
        { version: 1, tabs: [], activeTabId: '' },
        'missing',
      );
    }
    logMainProcessWarn(
      'Skipped unreadable cowork transcript summary backfill',
      {
        workspaceId,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
}

/**
 * `missing_selections`: the summary matches its source but predates chat
 * selections, which the scope's indexes can supply. A version 1 file embeds
 * transcripts, so its selections stay unknown until the scope is opened.
 */
async function summarySourceState(
  workspaceId: string,
  entryId: string,
  summary: CoworkWorkEntrySummary,
): Promise<'current' | 'stale' | 'missing_selections'> {
  if (!summary.sourceMtimeNs) return 'stale';
  try {
    const source = await summarySource(workspaceId, entryId);
    const fileStats = await stat(source.path, { bigint: true });
    if (summary.sourceMtimeNs !== fileStats.mtimeNs.toString()) return 'stale';
    return source.indexed &&
      summary.chats.some((chat) => chat.pluginSelections === undefined)
      ? 'missing_selections'
      : 'current';
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return summary.sourceMtimeNs === 'missing' ? 'current' : 'stale';
    }
    // Preserve the last known-good summary through transient stat failures.
    return 'current';
  }
}

/** An entry's current summary: kept, completed from its indexes, or rebuilt. */
async function hydratedSummary(
  workspaceId: string,
  entry: CoworkWorkEntryData,
): Promise<CoworkWorkEntrySummary | undefined> {
  const summary = summaryForEntry(workspaceId, entry);
  const state = summary
    ? await summarySourceState(workspaceId, entry.id, summary)
    : 'stale';
  if (summary && state === 'current') return summary;
  const completed =
    summary && state === 'missing_selections'
      ? await withIndexedPluginSelections(workspaceId, entry.id, summary).catch(
          () => undefined,
        )
      : undefined;
  return completed ?? (await deriveLegacySummary(workspaceId, entry.id));
}

async function hydrateMissingSummaries(
  workspaceId: string,
  file: CoworkWorkEntriesFile,
): Promise<{ file: CoworkWorkEntriesFile; changed: boolean }> {
  let changed = false;
  const entries: CoworkWorkEntryData[] = [];
  // Deliberately sequential: legacy summary recovery is a one-time backfill
  // and must never hold every transcript string in V8 at once.
  for (const entry of file.entries) {
    const summary = await hydratedSummary(workspaceId, entry);
    changed = changed || entry.summary !== summary;
    if (summary) {
      entries.push(entry.summary === summary ? entry : { ...entry, summary });
    } else {
      const entryWithoutSummary: CoworkWorkEntryData = { ...entry };
      delete entryWithoutSummary.summary;
      entries.push(entryWithoutSummary);
    }
  }
  return {
    file: changed ? { version: 1, entries } : file,
    changed,
  };
}

async function backfillMissingSummaries(
  workspaceId: string,
): Promise<CoworkWorkEntriesFile> {
  if (deletedWorkEntryWorkspaces.has(workspaceId)) return EMPTY_FILE;
  const existing = summaryBackfills.get(workspaceId);
  if (existing) return existing;
  const backfill = withRegistryLock(workspaceId, async () => {
    const current = await readWorkEntriesFileStrict(workspaceId);
    const hydrated = await hydrateMissingSummaries(workspaceId, current);
    if (hydrated.changed) {
      await writeWorkEntriesFile(workspaceId, hydrated.file);
    }
    return hydrated.file;
  });
  summaryBackfills.set(workspaceId, backfill);
  try {
    return await backfill;
  } finally {
    if (summaryBackfills.get(workspaceId) === backfill) {
      summaryBackfills.delete(workspaceId);
    }
  }
}

async function entriesNeedSummaryHydration(
  workspaceId: string,
  file: CoworkWorkEntriesFile,
): Promise<boolean> {
  for (const entry of file.entries) {
    const summary = summaryForEntry(workspaceId, entry);
    if (
      !summary ||
      (await summarySourceState(workspaceId, entry.id, summary)) !== 'current'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * UI-automation-only stand-in for registry lock contention: when the E2E build
 * names an owned directory in `CANOPY_E2E_WORK_ENTRY_SUMMARY_GATE_DIR`, a
 * summary write holds the registry lock while `hold` exists there, after
 * writing `entered`, and writes `left` once it lets go (release or timeout).
 * Release builds compile `__CANOPY_E2E__` to `false`.
 */
async function waitForE2eWorkEntrySummaryGate(): Promise<void> {
  if (typeof __CANOPY_E2E__ === 'undefined' || !__CANOPY_E2E__) return;
  const directory = process.env.CANOPY_E2E_WORK_ENTRY_SUMMARY_GATE_DIR;
  if (!directory) return;
  const hold = join(directory, 'hold');
  const deadline = Date.now() + 120_000;
  let observed = false;
  try {
    for (;;) {
      try {
        await stat(hold);
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') return;
        throw error;
      }
      if (!observed) {
        await writeFile(join(directory, 'entered'), '1', 'utf8');
        observed = true;
      }
      if (Date.now() >= deadline)
        throw new Error('Work Entry summary test gate timed out');
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    if (observed)
      await writeFile(join(directory, 'left'), '1', 'utf8').catch(
        () => undefined,
      );
  }
}

/**
 * Update the in-memory projection and persist it under the registry lock.
 * The caller retries failures after the already-durable chat commit.
 */
export async function syncWorkEntrySummaryFromWrite(
  projectId: string,
  entryId: string,
  data: ChatTabsFile,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isWorkEntryWorkspace(projectId)) return;
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  if (deletedWorkEntryWorkspaces.has(workspaceId)) return;
  let sourceMtimeNs: string;
  try {
    const fileStats = await stat(
      await summarySourcePath(workspaceId, entryId),
      { bigint: true },
    );
    sourceMtimeNs = fileStats.mtimeNs.toString();
  } catch (error) {
    // Canonical chat-state commits are durable in the journal before the
    // compatibility snapshot is checkpointed. Project their in-memory state
    // immediately instead of briefly publishing an empty Work Entry; once
    // the snapshot appears, summarySourceState will naturally trigger
    // a one-time mtime refresh.
    if (isErrnoException(error) && error.code === 'ENOENT') {
      sourceMtimeNs = 'missing';
    } else {
      logMainProcessWarn('Failed to inspect cowork Work Entry summary source', {
        workspaceId,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  if (!isCurrent()) return;
  const summary = deriveWorkEntrySummary(data, sourceMtimeNs);
  const cacheKey = summaryCacheKey(workspaceId, entryId);
  liveSummaries.set(cacheKey, summary);
  try {
    await withRegistryLock(workspaceId, async () => {
      await waitForE2eWorkEntrySummaryGate();
      if (!isCurrent()) return;
      const file = await readWorkEntriesFileStrict(workspaceId);
      if (!isCurrent()) return;
      const index = file.entries.findIndex((entry) => entry.id === entryId);
      if (
        index < 0 ||
        summariesEquivalent(file.entries[index]?.summary, summary)
      ) {
        return;
      }
      const entries = file.entries.slice();
      entries[index] = { ...entries[index], summary };
      const superseded = new Error('Work Entry summary superseded');
      try {
        // Rechecked before each rename attempt: a newer revision can publish
        // mid-write or during a sharing-violation backoff.
        await writeWorkEntriesFile(
          workspaceId,
          { version: 1, entries },
          {
            assertCanCommit: () => {
              if (!isCurrent()) throw superseded;
            },
          },
        );
      } catch (error) {
        if (error !== superseded) throw error;
      }
    });
    if (liveSummaries.get(cacheKey) === summary) {
      liveSummaries.delete(cacheKey);
    }
  } catch (error) {
    logMainProcessWarn('Failed to persist cowork Work Entry summary', {
      workspaceId,
      entryId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * A delta-journal checkpoint replaces the journal file without changing the
 * committed chats, so a summary stamped with the replaced file's modification
 * time is still current: carry it to the new file instead of backfilling.
 */
export async function refreshWorkEntrySummaryStamp(
  projectId: string,
  entryId: string,
  rotation: DeltaJournalCheckpointRotation,
): Promise<void> {
  if (!isWorkEntryWorkspace(projectId)) return;
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  if (deletedWorkEntryWorkspaces.has(workspaceId)) return;
  try {
    await withRegistryLock(workspaceId, async () => {
      const file = await readWorkEntriesFileStrict(workspaceId);
      const index = file.entries.findIndex((entry) => entry.id === entryId);
      const entry = file.entries[index];
      if (entry?.summary?.sourceMtimeNs !== rotation.previousMtimeNs) return;
      const entries = file.entries.slice();
      entries[index] = {
        ...entry,
        summary: { ...entry.summary, sourceMtimeNs: rotation.mtimeNs },
      };
      await writeWorkEntriesFile(workspaceId, { version: 1, entries });
    });
  } catch (error) {
    logMainProcessWarn('Failed to refresh cowork Work Entry summary stamp', {
      workspaceId,
      entryId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Tombstones a removed workspace, cancels future registry writes, and waits
 * for every mutation already queued before its directory is removed.
 */
export async function clearWorkEntrySummariesForWorkspace(
  projectId: string,
): Promise<void> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  deletedWorkEntryWorkspaces.add(workspaceId);
  const prefix = `${workspaceId}/`;
  liveSummaries.forEach((_summary, key) => {
    if (key.startsWith(prefix)) {
      liveSummaries.delete(key);
    }
  });
  const pendingMutation = mutationQueues.get(workspaceId);
  if (pendingMutation) {
    await pendingMutation;
  }
  const pendingBackfill = summaryBackfills.get(workspaceId);
  if (pendingBackfill) {
    await pendingBackfill.catch(() => undefined);
  }
}

/** Allows a deliberately re-created workspace id to own a fresh registry. */
export function activateWorkEntryWorkspace(projectId: string): void {
  deletedWorkEntryWorkspaces.delete(resolveWorkEntryWorkspaceId(projectId));
}

/**
 * Live-session lookups injected by the IPC layer. Kept out of this module's
 * static imports so the pure-fs registry stays loadable without the agent
 * session-manager's Electron-adjacent dependency graph (tests, CLI-safe
 * contexts).
 */
export interface ListWorkEntriesOptions {
  /**
   * Returns the chat ids in `${workspaceId}/${entryId}` with an in-flight
   * agent turn (or a queued message awaiting one). Omitted = no live
   * sessions, so `hasActiveChat` stays unset.
   */
  getActiveChatIds?: (workspaceId: string, entryId: string) => string[];
}

async function deriveEntryMeta(
  workspaceId: string,
  entry: CoworkWorkEntryData,
  options?: ListWorkEntriesOptions,
): Promise<CoworkWorkEntryMeta> {
  const summary =
    summaryForEntry(workspaceId, entry) ??
    (await deriveLegacySummary(workspaceId, entry.id));
  return entryMetaFromSummary(
    workspaceId,
    entry,
    summary ?? {
      version: 1,
      title: `New ${CHAT_UNIT_LABEL}`,
      chatCount: 0,
      chats: [],
    },
    options,
  );
}

function entryRecencyMs(meta: CoworkWorkEntryMeta): number {
  const iso = meta.lastMessageAt ?? meta.createdAt;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Derived work-entry list for the sidebar/pickers in persisted manual order. */
export async function listWorkEntries(
  projectId: string,
  options?: ListWorkEntriesOptions & {
    /**
     * Reject an unreadable registry instead of reading it as empty, for
     * retried projections. A missing registry still reads as empty.
     */
    strictRead?: boolean;
  },
): Promise<CoworkWorkEntryMeta[]> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  let file = await readWorkEntriesFile(workspaceId, {
    strict: options?.strictRead === true,
  });
  if (await entriesNeedSummaryHydration(workspaceId, file)) {
    file = await backfillMissingSummaries(workspaceId);
  }
  return file.entries.map((entry) =>
    entryMetaFromSummary(
      workspaceId,
      entry,
      summaryForEntry(workspaceId, entry) ?? {
        version: 1,
        title: `New ${CHAT_UNIT_LABEL}`,
        chatCount: 0,
        chats: [],
      },
      options,
    ),
  );
}

/**
 * One Work Entry's compact shell projection: identity, the ordering facts the
 * desktop sidebar sorts by (`orderWorkEntryRows`), and its live chats.
 */
export interface WorkEntryChatSummaryListItem {
  entryId: string;
  title: string;
  /** Registry index — the persisted manual order (0 = top). */
  order: number;
  /** Present only when pinned. */
  pinned?: true;
  /** Present only when done; absent means active. */
  status?: 'done';
  createdAt: string;
  /** Latest message across the entry's chats; absent before any message. */
  lastMessageAt?: string;
  /** Durable activity watermark; absent on legacy rows. */
  lastTouchedAt?: string;
  chats: CoworkWorkEntryChatSummary[];
}

/** Compact live-chat metadata for desktop/Portal shell snapshots. */
export async function listWorkEntryChatSummaries(
  projectId: string,
  options?: {
    /** Reject an unreadable registry or any entry without a summary. */
    strict?: boolean;
    /** Reject only an unreadable registry, for retried projections. */
    strictRead?: boolean;
  },
): Promise<WorkEntryChatSummaryListItem[]> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  let file = await readWorkEntriesFile(workspaceId, {
    strict: options?.strict === true || options?.strictRead === true,
  });
  if (await entriesNeedSummaryHydration(workspaceId, file)) {
    file = await backfillMissingSummaries(workspaceId);
  }
  return file.entries.map((entry, order): WorkEntryChatSummaryListItem => {
    const summary = summaryForEntry(workspaceId, entry);
    if (options?.strict && !summary)
      throw new Error('Incomplete Work Entry chat inventory');
    return {
      entryId: entry.id,
      title:
        normalizeLabel(entry.title) ??
        summary?.title ??
        `New ${CHAT_UNIT_LABEL}`,
      order,
      ...(entry.pinned === true ? { pinned: true } : {}),
      ...(entry.status === 'done' ? { status: 'done' } : {}),
      createdAt: entry.createdAt,
      ...(summary?.lastMessageAt
        ? { lastMessageAt: summary.lastMessageAt }
        : {}),
      ...(entry.lastTouchedAt ? { lastTouchedAt: entry.lastTouchedAt } : {}),
      chats: summary?.chats ?? [],
    };
  });
}

/**
 * Creates a new work entry, or reuses an untouched empty entry. Sidebar
 * customization and panel changes preserve an entry even before any message. Providing an explicit `title` (or `id`) always creates.
 */
export async function createWorkEntry(
  projectId: string,
  options?: {
    title?: string;
    sidebarItemGroupId?: string;
    id?: string;
    createdAt?: string;
    /** Defaults to true. Archive restore explicitly suppresses mode seeding. */
    seedPanelLayoutMode?: boolean;
    assertCanCommit?: () => void;
  },
): Promise<{ entry: CoworkWorkEntryMeta; reusedExistingEmpty: boolean }> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  await assertCoworkChatRootPresent(workspaceId, options?.id ?? 'home');
  const result = await withRegistryLock(workspaceId, async () => {
    options?.assertCanCommit?.();
    let file = await readWorkEntriesFileStrict(workspaceId);

    if (!options?.title && !options?.id) {
      const hydrated = await hydrateMissingSummaries(workspaceId, file);
      file = hydrated.file;
      const emptyCandidates = file.entries
        .flatMap((entry) => {
          const summary = summaryForEntry(workspaceId, entry);
          if (
            !summary ||
            summary.chatCount > 1 ||
            entry.hasUserChanges === true ||
            normalizeLabel(entry.title) ||
            entry.pinned === true ||
            entry.status === 'done'
          )
            return [];
          return [entryMetaFromSummary(workspaceId, entry, summary)];
        })
        .sort((a, b) => entryRecencyMs(b) - entryRecencyMs(a))
        .filter(
          (meta) =>
            meta.lastMessageAt === undefined &&
            (!options?.sidebarItemGroupId || meta.pinned !== true),
        );
      for (const candidate of emptyCandidates) {
        const layout = panelLayoutPersistenceStore.loadWorktreeLayout(
          workspaceId,
          candidate.id,
        );
        if (
          layout !== null &&
          (typeof layout !== 'object' ||
            !('hasUserChanges' in layout) ||
            layout.hasUserChanges !== false)
        ) {
          const row = file.entries.find((entry) => entry.id === candidate.id);
          if (row) row.hasUserChanges = true;
          continue;
        }
        // Reuse checks inspect unopened history too. A legacy archive read via
        // the repository would migrate every rejected candidate under this lock.
        const legacyPath = getWorkspaceChatTabsFilePath(
          workspaceId,
          candidate.id,
        );
        const store = new ChatStorageV2(
          dirname(dirname(legacyPath)),
          candidate.id,
        );
        let empty: boolean;
        if ((await store.authority()) === 'v1') {
          const recovered = await readLegacyCatalog(
            workspaceId,
            candidate.id,
            '',
          );
          empty =
            !recovered.hasArchives &&
            recovered.summary.lastMessageAt === undefined;
        } else {
          const archives = await readChatArchivesFile(
            workspaceId,
            candidate.id,
          );
          empty = archives.archived.length === 0;
        }
        if (empty) {
          const reused = file.entries.find(
            (entry) => entry.id === candidate.id,
          );
          if (!reused) continue;
          // Reuse only avoids stacking empty duplicates; to the user this is
          // a new chat. It leads the manual order like a prepended entry,
          // reopens as active, and its activity watermark makes it the most
          // recent. createdAt stays: archive capture fences on it.
          const row: CoworkWorkEntryData = {
            ...reused,
            lastTouchedAt: laterIso(reused.lastTouchedAt, new Date()),
          };
          delete row.status;
          await writeWorkEntriesFile(
            workspaceId,
            {
              version: 1,
              entries: [
                row,
                ...file.entries.filter((entry) => entry.id !== row.id),
              ],
            },
            {
              sidebarItemGroupId: options?.sidebarItemGroupId,
              newItemId: row.id,
              assertCanCommit: options?.assertCanCommit,
            },
          );
          const summary = summaryForEntry(workspaceId, row);
          return {
            entry: summary
              ? entryMetaFromSummary(workspaceId, row, summary)
              : candidate,
            reusedExistingEmpty: true,
            listChanged: true,
          };
        }
      }
    }

    const id = options?.id ?? randomUUID();
    validateId(id, 'work entry id');
    if (file.entries.some((entry) => entry.id === id)) {
      const row = file.entries.find((entry) => entry.id === id) ?? {
        id,
        createdAt: new Date().toISOString(),
      };
      const existing = await deriveEntryMeta(workspaceId, row);
      options?.assertCanCommit?.();
      return { entry: existing, reusedExistingEmpty: true, listChanged: false };
    }

    const title = options?.title?.trim();
    const createdAt = options?.createdAt ?? new Date().toISOString();
    const row: CoworkWorkEntryData = {
      id,
      ...(title ? { title } : {}),
      createdAt,
      lastTouchedAt: createdAt,
    };
    const emptySummary: CoworkWorkEntrySummary = {
      version: 1,
      title: `New ${CHAT_UNIT_LABEL}`,
      chatCount: 0,
      chats: [],
    };
    let installed = false;
    try {
      await writeWorkEntriesFile(
        workspaceId,
        {
          version: 1,
          entries: [row, ...file.entries],
        },
        {
          sidebarItemGroupId: options?.sidebarItemGroupId,
          newItemId: id,
          assertCanCommit: options?.assertCanCommit,
        },
      );
      installed = true;
      options?.assertCanCommit?.();
      if (
        projectId !== APP_ADVISOR_PROJECT_ID &&
        options?.seedPanelLayoutMode !== false
      ) {
        try {
          const mode = await readWorkspaceDefaultLayoutMode();
          await panelLayoutModePersistenceStore.initialize(
            workspaceId,
            id,
            mode,
          );
        } catch (error) {
          logMainProcessWarn(
            'Failed to seed cowork Work Entry panel layout mode',
            {
              workspaceId,
              entryId: id,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      options?.assertCanCommit?.();
    } catch (error) {
      if (installed) await writeWorkEntriesFile(workspaceId, file);
      throw error;
    }
    return {
      entry: entryMetaFromSummary(workspaceId, row, emptySummary),
      reusedExistingEmpty: false,
      listChanged: true,
    };
  });
  // Prepending or moving a row to the top shifts every sibling's index.
  if (result.listChanged) notifyWorkEntryListChanged(workspaceId);
  return {
    entry: result.entry,
    reusedExistingEmpty: result.reusedExistingEmpty,
  };
}

/** The later of an existing ISO watermark and `now`, as an ISO string. */
function laterIso(current: string | undefined, now: Date): string {
  const currentMs = current === undefined ? Number.NaN : Date.parse(current);
  return new Date(
    Number.isFinite(currentMs) ? Math.max(currentMs, now.getTime()) : now,
  ).toISOString();
}

/**
 * Registry mutation for one entry's user-controlled fields. Every field is
 * optional and `undefined` means "leave unchanged", so a rename and a
 * mark-done/mark-active are the same single-writer path (one registry lock, one
 * atomic rewrite) rather than two racing ones.
 */
export interface UpdateWorkEntryPatch {
  /** Internal customization marker; never cleared by automatic saves. */
  hasUserChanges?: true;
  /** New title, or null to clear the rename override. */
  title?: string | null;
  /** New completion state; `'active'` clears the persisted flag. */
  status?: 'active' | 'done';
  /** User pin within the owning workspace section. False clears the marker. */
  pinned?: boolean;
  /** Durable activity watermark; callers must provide a valid ISO timestamp. */
  lastTouchedAt?: string;
}

/** Applies UI edits and their activity watermark under the deletion fence. */
export async function updateWorkEntry(
  projectId: string,
  entryId: string,
  patch: UpdateWorkEntryPatch,
): Promise<boolean> {
  if (patch.title === undefined && patch.status === undefined) {
    return updateWorkEntryWithoutActivity(projectId, entryId, patch);
  }
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  const { withWorkspaceTargetRuntimeStartReservation } =
    await import('./workspace-target-exclusion');
  return withWorkspaceTargetRuntimeStartReservation(
    workspaceId,
    entryId,
    async () => {
      const { withArchivedWorkspaceOperationLock } =
        await import('./archived-containers');
      return withArchivedWorkspaceOperationLock(workspaceId, () =>
        updateWorkEntryWithoutActivity(workspaceId, entryId, {
          ...patch,
          lastTouchedAt: new Date().toISOString(),
        }),
      );
    },
  );
}

async function updateWorkEntryWithoutActivity(
  projectId: string,
  entryId: string,
  patch: UpdateWorkEntryPatch,
): Promise<boolean> {
  if (
    patch.title === undefined &&
    patch.status === undefined &&
    patch.pinned === undefined &&
    patch.lastTouchedAt === undefined &&
    patch.hasUserChanges === undefined
  ) {
    return false;
  }
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  return withRegistryLock(workspaceId, async () => {
    const file = await readWorkEntriesFileStrict(workspaceId);
    let updated = false;
    const entries = file.entries.map((entry) => {
      if (entry.id !== entryId) return entry;
      if (
        patch.hasUserChanges === true &&
        entry.hasUserChanges === true &&
        patch.title === undefined &&
        patch.status === undefined &&
        patch.pinned === undefined &&
        patch.lastTouchedAt === undefined
      ) {
        return entry;
      }
      updated = true;
      const next: CoworkWorkEntryData = { ...entry };
      if (
        patch.hasUserChanges === true ||
        patch.title !== undefined ||
        patch.status !== undefined ||
        patch.pinned !== undefined
      ) {
        next.hasUserChanges = true;
      }
      if (patch.title !== undefined) {
        const trimmed = patch.title?.trim();
        if (trimmed) {
          next.title = trimmed;
        } else {
          delete next.title;
        }
      }
      if (patch.status !== undefined) {
        // `active` is the default, so persist only the non-default `done`
        // marker and let the absent key mean active (matching how the derived
        // meta and the sync path read it).
        if (patch.status === 'done') {
          next.status = 'done';
        } else {
          delete next.status;
        }
      }
      if (patch.pinned === true) {
        next.pinned = true;
      } else if (patch.pinned === false) {
        delete next.pinned;
      }
      if (patch.lastTouchedAt !== undefined) {
        const timestamp = Date.parse(patch.lastTouchedAt);
        if (!Number.isFinite(timestamp)) {
          throw new Error('Invalid work entry lastTouchedAt');
        }
        const current = Date.parse(entry.lastTouchedAt ?? entry.createdAt);
        next.lastTouchedAt = new Date(
          Number.isFinite(current) ? Math.max(current, timestamp) : timestamp,
        ).toISOString();
      }
      return next;
    });
    if (!updated) return false;
    await writeWorkEntriesFile(workspaceId, { version: 1, entries });
    return true;
  });
}

/** Persists one Work Entry's Auto Delete activity watermark. */
export async function touchWorkEntry(
  projectId: string,
  entryId: string,
  touchedAt = new Date().toISOString(),
): Promise<void> {
  await updateWorkEntry(projectId, entryId, { lastTouchedAt: touchedAt });
}

/** Seeds every live Work Entry when Auto Delete is enabled for a workspace. */
export async function touchAllWorkEntries(
  projectId: string,
  touchedAt = new Date().toISOString(),
): Promise<void> {
  const timestamp = Date.parse(touchedAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error('Invalid work entry lastTouchedAt');
  }
  const normalized = new Date(timestamp).toISOString();
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  await withRegistryLock(workspaceId, async () => {
    const file = await readWorkEntriesFileStrict(workspaceId);
    await writeWorkEntriesFile(workspaceId, {
      version: 1,
      entries: file.entries.map((entry) => ({
        ...entry,
        lastTouchedAt: normalized,
      })),
    });
  });
}

/** Sets or clears (null) an entry's rename override. */
export async function updateWorkEntryTitle(
  projectId: string,
  entryId: string,
  title: string | null,
): Promise<void> {
  await updateWorkEntry(projectId, entryId, { title });
}

/**
 * Persists the visible entry order. The request must name every row exactly
 * once so a stale renderer cannot accidentally drop newly created entries.
 */
export async function reorderWorkEntries(
  projectId: string,
  entryIds: string[],
): Promise<void> {
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  await withRegistryLock(workspaceId, async () => {
    const file = await readWorkEntriesFileStrict(workspaceId);
    const entriesById = new Map(file.entries.map((entry) => [entry.id, entry]));
    if (
      entryIds.length !== file.entries.length ||
      new Set(entryIds).size !== entryIds.length ||
      entryIds.some((entryId) => !entriesById.has(entryId))
    ) {
      throw new Error('Work entry reorder does not match entries');
    }

    const entries = entryIds.map((entryId) => {
      const entry = entriesById.get(entryId);
      if (!entry) {
        throw new Error('Work entry reorder does not match entries');
      }
      return entry;
    });
    await writeWorkEntriesFile(workspaceId, { version: 1, entries });
  });
  notifyWorkEntryListChanged(workspaceId);
}

/** Group operations share the existing registry queue and canonical writer. */
export async function updateWorkEntryRegistry(
  projectId: string,
  updater: (entries: CoworkWorkEntryData[]) => Promise<CoworkWorkEntryData[]>,
  options?: WorkEntryRegistryWriteOptions,
): Promise<void> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  let changed = false;
  await withRegistryLock(workspaceId, async () => {
    if (deletedWorkEntryWorkspaces.has(workspaceId))
      throw new Error(`Work Entry project has been deleted: ${workspaceId}`);
    const file = await readWorkEntriesFileStrict(workspaceId);
    const entries = await updater(file.entries);
    if (deletedWorkEntryWorkspaces.has(workspaceId))
      throw new Error(`Work Entry project has been deleted: ${workspaceId}`);
    if (entries !== file.entries) {
      await writeWorkEntriesFile(workspaceId, { version: 1, entries }, options);
      changed = true;
    }
    try {
      await options?.afterWrite?.();
    } catch (error) {
      if (changed) failedRegistryWriteInvalidations.add(workspaceId);
      throw error;
    }
    if (deletedWorkEntryWorkspaces.has(workspaceId))
      throw new Error(`Work Entry project has been deleted: ${workspaceId}`);
    publishSidebarItemGroupsChanged(workspaceId);
  });
  if (changed) notifyWorkEntryListChanged(workspaceId);
}

/**
 * Removes a work entry's registry row. Per-worktree data removal
 * (`cleanupPersistedWorktreeData`) and session teardown are the caller's
 * responsibility — this only edits the registry.
 */
export async function removeWorkEntryRow(
  projectId: string,
  entryId: string,
): Promise<void> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  await withRegistryLock(workspaceId, async () => {
    const file = await readWorkEntriesFileStrict(workspaceId);
    await writeWorkEntriesFile(workspaceId, {
      version: 1,
      entries: file.entries.filter((entry) => entry.id !== entryId),
    });
  });
  liveSummaries.delete(summaryCacheKey(workspaceId, entryId));
  // Removal shifts the registry index of every later sibling.
  notifyWorkEntryListChanged(workspaceId);
}

/** Registry-only append used by the migration (no reuse semantics). */
export async function appendWorkEntryRows(
  projectId: string,
  rows: CoworkWorkEntryData[],
): Promise<void> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  const appended = await withRegistryLock(workspaceId, async () => {
    const file = await readWorkEntriesFileStrict(workspaceId);
    const known = new Set(file.entries.map((entry) => entry.id));
    const additions = rows.filter((row) => {
      if (known.has(row.id)) return false;
      known.add(row.id);
      return true;
    });
    if (additions.length === 0) return false;
    await writeWorkEntriesFile(workspaceId, {
      version: 1,
      entries: [...file.entries, ...additions],
    });
    return true;
  });
  if (appended) notifyWorkEntryListChanged(workspaceId);
}

/** All registry entry ids (unsorted), for cleanup/export/retention loops. */
export async function listWorkEntryIds(projectId: string): Promise<string[]> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  const file = await readWorkEntriesFile(workspaceId);
  return file.entries.map((entry) => entry.id);
}

/**
 * Resolves which work entry a chat belongs to: first the entry whose live
 * tabs contain it, then the entry whose unified archive contains it. Legacy
 * callers hold only `(workspaceId, chatId)` (audit link targets, watcher
 * targets, App Advisor actions) — migrated entries reuse their founding
 * chat's id, so this is O(1) for them and a scan for post-migration chats.
 */
export async function resolveWorkEntryForChat(
  projectId: string,
  chatId: string,
): Promise<{ entryId: string | null; archivedInEntryId: string | null }> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  const file = await readWorkEntriesFile(workspaceId);

  // Work Entry rows carry a compact live-chat index. Prefer it before
  // opening any per-entry transcript file: portal hydration commonly starts
  // with a chat id, and scanning every (potentially very large) history just
  // to discover its owner defeats active-chat-first loading. The index is
  // refreshed on tab writes; if an older/stale registry has no match, retain
  // the file scan below as the correctness fallback.
  const summarized = file.entries.find((entry) =>
    summaryForEntry(workspaceId, entry)?.chats.some(
      (chat) => chat.id === chatId,
    ),
  );
  const summarizedProjection = summarized
    ? summaryForEntry(workspaceId, summarized)
    : undefined;
  if (
    summarized &&
    summarizedProjection &&
    (await summarySourceState(
      workspaceId,
      summarized.id,
      summarizedProjection,
    )) !== 'stale'
  ) {
    return { entryId: summarized.id, archivedInEntryId: null };
  }

  // Fast path: migrated entries share their founding chat's id.
  const direct = file.entries.find((entry) => entry.id === chatId);
  const ordered = direct
    ? [direct, ...file.entries.filter((entry) => entry.id !== chatId)]
    : file.entries;

  for (const entry of ordered) {
    const tabs = await readChatTabsFile(workspaceId, entry.id);
    if (tabs.tabs.some((tab) => tab.id === chatId)) {
      return { entryId: entry.id, archivedInEntryId: null };
    }
  }
  for (const entry of ordered) {
    const archives = await readChatArchivesFile(workspaceId, entry.id);
    if (archives.archived.some((archived) => archived.tab.id === chatId)) {
      return { entryId: null, archivedInEntryId: entry.id };
    }
  }
  return { entryId: null, archivedInEntryId: null };
}

/** Rollback only this incarnation, and only while no concurrent chat survives. */
export async function removeUnstartedWorkEntry(
  projectId: string,
  entryId: string,
  createdAt: string,
): Promise<void> {
  const workspaceId = resolveWorkEntryWorkspaceId(projectId);
  await withRegistryLock(workspaceId, async () => {
    const file = await readWorkEntriesFileStrict(workspaceId);
    const row = file.entries.find((entry) => entry.id === entryId);
    if (!row || row.createdAt !== createdAt) return;
    const [tabs, archives] = await Promise.all([
      readChatTabsFile(workspaceId, entryId),
      readChatArchivesFile(workspaceId, entryId),
    ]);
    if (tabs.tabs.length || archives.archived.length) return;
    await writeWorkEntriesFile(workspaceId, {
      ...file,
      entries: file.entries.filter((entry) => entry !== row),
    });
    liveSummaries.delete(summaryCacheKey(workspaceId, entryId));
    notifyWorkEntryListChanged(workspaceId);
  });
}
