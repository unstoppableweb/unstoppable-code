import { ChatStorageV2 } from './chat-storage-v2';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  WORKSPACE_ROOT_REPO_ID,
  type ArchivedChatEntry,
  type ArchivedChatsFile,
  type ChatTabsFile,
  type PersistedChatTab,
  type PersistedPendingQuestion,
  type TrackedPlanData,
  type WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  listExecutionSummaries,
  loadExecutionState,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { relocateExecutionCheckout } from '../pipelines/execution-checkout-location';
import { readChatTabsFile, readChatTabsFileForIndex } from './chat-tabs-reader';
import { writeChatTabsFile } from './chat-tabs';
import {
  readChatArchivesFileForIndex,
  removeChatArchive,
  writeChatArchivesFile,
} from './chat-archives';
import {
  deleteTrackedPlan,
  deleteTrackedPlansForWorktree,
  installRestoredTrackedPlans,
  readTrackedPlansFileForIndex,
} from './plan-persistence';
import {
  getWorkspaceDir,
  getWorkspaceWorktreeRepoDir,
  getWorktreeAttachmentsDir,
} from './paths';
import { deleteExecutionArtifacts } from '../pipelines/worktree-cleanup';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

/**
 * Item ownership analysis for a temporary multi-repo worktree being split.
 * Chats, pipeline executions, and tracked plans are attributed to the child
 * repo whose working directory they belong to; everything else — including
 * worktree attachments, which are stored flat per worktree — belongs to the
 * workspace root.
 */
export interface SplitWorktreeRepoItems {
  /** Live chat tabs (`kind` chat) — shown in the modal's chat counter. */
  chatTabs: PersistedChatTab[];
  /**
   * Open file tabs (`kind: 'file'`), attributed by their file path. They
   * migrate with their repo like chats do, but are intentionally NOT shown
   * in the modal counters — they are editor state, not conversations.
   */
  fileTabs: PersistedChatTab[];
  /** Archived chats — shown in the chat counter marked as archived. */
  archivedChats: ArchivedChatEntry[];
  executions: ExecutionSummary[];
  plans: TrackedPlanData[];
  /** Flat attachment files referenced by chats in this ownership bucket. */
  attachmentNames?: string[];
}

export interface SplitWorktreeItemsAnalysis {
  perRepo: Map<string, SplitWorktreeRepoItems>;
  root: SplitWorktreeRepoItems;
}

/** Whether a partition bucket contains anything that needs disposition. */
export function hasSplitWorktreeItems(
  items: SplitWorktreeRepoItems & { attachmentNames?: string[] },
): boolean {
  return (
    items.chatTabs.length > 0 ||
    items.fileTabs.length > 0 ||
    items.archivedChats.length > 0 ||
    items.executions.length > 0 ||
    items.plans.length > 0 ||
    (items.attachmentNames?.length ?? 0) > 0
  );
}

function emptyRepoItems(): SplitWorktreeRepoItems {
  return {
    chatTabs: [],
    fileTabs: [],
    archivedChats: [],
    executions: [],
    plans: [],
    attachmentNames: [],
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function readOptionalSplitStore<T>(
  read: () => Promise<T>,
  empty: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isMissingFileError(error)) {
      return empty;
    }
    throw error;
  }
}

async function readSplitChatTabs(
  workspaceId: string,
  worktreeId: string,
): Promise<ChatTabsFile> {
  return readOptionalSplitStore(
    () => readChatTabsFileForIndex(workspaceId, worktreeId),
    { version: 1, tabs: [], activeTabId: '' },
  );
}

async function readSplitChatArchives(
  workspaceId: string,
  worktreeId: string,
): Promise<ArchivedChatsFile> {
  return readOptionalSplitStore(
    () => readChatArchivesFileForIndex(workspaceId, worktreeId),
    { version: 1, archived: [] },
  );
}

async function readSplitTrackedPlans(
  workspaceId: string,
  worktreeId: string,
): Promise<TrackedPlanData[]> {
  const file = await readOptionalSplitStore(
    () => readTrackedPlansFileForIndex(workspaceId, worktreeId),
    { version: 1, plans: [] },
  );
  return file.plans;
}

async function flushSplitChatState(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  // Defer the heavy canonical state service until a split actually needs to
  // flush chat state; index-only attribution paths must stay lightweight.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  await getChatStateService().flushScope(workspaceId, worktreeId);
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * Pure attribution core (exported for unit tests): assigns each chat tab,
 * file tab, archived chat, execution, and plan to a child repo or the
 * workspace root.
 *
 * - Chat tabs use `selectedRepoId` (`undefined`/`WORKSPACE_ROOT_REPO_ID` →
 *   root).
 * - File tabs use their `filePath`: inside a child repo checkout → that repo.
 * - Archived chats follow the same rules via their embedded tab.
 * - Executions use their `cwd`: inside a child repo checkout → that repo.
 * - Plans use `sourceRepoId` when present; agent/pipeline plans (no
 *   `sourceRepoId`) fall back to the repo of their first attributable linked
 *   execution — the execution a chat's plan run produced — else root.
 */
export function partitionSplitWorktreeItems(input: {
  repoIds: string[];
  repoCheckoutPathById: Map<string, string>;
  chatTabs: PersistedChatTab[];
  archivedChats: ArchivedChatEntry[];
  executions: ExecutionSummary[];
  plans: TrackedPlanData[];
  attachmentNames?: string[];
  attachmentsDir?: string;
  attachmentPathsByChatId?: ReadonlyMap<string, string[]>;
}): {
  perRepo: Map<string, SplitWorktreeRepoItems>;
  root: SplitWorktreeRepoItems;
} {
  const repoIdSet = new Set(input.repoIds);
  const perRepo = new Map<string, SplitWorktreeRepoItems>();
  for (const repoId of input.repoIds) {
    perRepo.set(repoId, emptyRepoItems());
  }
  const root = emptyRepoItems();
  const repoCheckoutEntries = Array.from(input.repoCheckoutPathById.entries());

  const tabOwner = (tab: PersistedChatTab): string | undefined => {
    if (tab.kind === 'file') {
      if (!tab.filePath) {
        return undefined;
      }
      for (const [repoId, checkoutPath] of repoCheckoutEntries) {
        if (isPathInsideOrEqual(tab.filePath, checkoutPath)) {
          return repoId;
        }
      }
      return undefined;
    }
    const repoId = tab.selectedRepoId;
    return repoId && repoId !== WORKSPACE_ROOT_REPO_ID && repoIdSet.has(repoId)
      ? repoId
      : undefined;
  };

  for (const tab of input.chatTabs) {
    const owner = tabOwner(tab);
    const bucket = owner ? (perRepo.get(owner) ?? root) : root;
    if (tab.kind === 'file') {
      bucket.fileTabs.push(tab);
    } else {
      bucket.chatTabs.push(tab);
    }
  }

  for (const entry of input.archivedChats) {
    const owner = tabOwner(entry.tab);
    const bucket = owner ? (perRepo.get(owner) ?? root) : root;
    bucket.archivedChats.push(entry);
  }

  const executionRepoById = new Map<string, string>();
  for (const execution of input.executions) {
    let owner: string | undefined;
    for (const [repoId, checkoutPath] of repoCheckoutEntries) {
      if (execution.cwd && isPathInsideOrEqual(execution.cwd, checkoutPath)) {
        owner = repoId;
        break;
      }
    }
    if (owner) {
      executionRepoById.set(execution.id, owner);
      perRepo.get(owner)?.executions.push(execution);
    } else {
      root.executions.push(execution);
    }
  }

  for (const plan of input.plans) {
    let owner: string | undefined;
    if (
      plan.sourceRepoId &&
      plan.sourceRepoId !== WORKSPACE_ROOT_REPO_ID &&
      repoIdSet.has(plan.sourceRepoId)
    ) {
      owner = plan.sourceRepoId;
    } else if (plan.sourceRepoId === undefined) {
      for (const executionId of plan.linkedExecutionIds) {
        const executionOwner = executionRepoById.get(executionId);
        if (executionOwner) {
          owner = executionOwner;
          break;
        }
      }
    }
    if (owner) {
      perRepo.get(owner)?.plans.push(plan);
    } else {
      root.plans.push(plan);
    }
  }

  if (input.attachmentsDir) {
    const buckets = [root, ...Array.from(perRepo.values())];
    const referencedPathsByBucket = new Map(
      buckets.map((bucket) => [
        bucket,
        new Set(
          [
            ...bucket.chatTabs,
            ...bucket.archivedChats.map((entry) => entry.tab),
          ].flatMap(
            (tab) =>
              input.attachmentPathsByChatId?.get(tab.id) ??
              chatAttachmentPaths(tab),
          ),
        ),
      ]),
    );
    for (const name of input.attachmentNames ?? []) {
      const sourcePath = join(input.attachmentsDir, name);
      const owners = buckets.filter((bucket) =>
        referencedPathsByBucket.get(bucket)?.has(sourcePath),
      );
      if (owners.length === 0) {
        root.attachmentNames?.push(name);
        continue;
      }
      for (const owner of owners) {
        owner.attachmentNames?.push(name);
      }
    }
  } else {
    root.attachmentNames?.push(...(input.attachmentNames ?? []));
  }

  return { perRepo, root };
}

function chatAttachmentPaths(tab: PersistedChatTab): string[] {
  const paths: string[] = [];
  if (tab.pendingRevertAttachmentPath) {
    paths.push(tab.pendingRevertAttachmentPath);
  }
  for (const message of tab.messages) {
    paths.push(...(message.attachmentPaths ?? []));
    for (const context of message.attachmentPromptContexts ?? []) {
      paths.push(context.attachmentPath);
    }
    for (const block of message.blocks) {
      if (block.type === 'revert_info' && block.attachmentPath) {
        paths.push(block.attachmentPath);
      }
    }
  }
  return paths;
}

/** Read all split-relevant stores for a worktree and attribute ownership. */
export async function analyzeSplitWorktreeItems(
  workspaceId: string,
  worktreeId: string,
  repos: WorkspaceRepoData[],
): Promise<SplitWorktreeItemsAnalysis> {
  await flushSplitChatState(workspaceId, worktreeId);
  const repoIds = repos.map((repo) => repo.id);
  const repoCheckoutPathById = new Map(
    repoIds.map((repoId) => [
      repoId,
      getWorkspaceWorktreeRepoDir(workspaceId, worktreeId, repoId),
    ]),
  );

  const [chatsFile, archivesFile, plans, executions, attachmentNames] =
    await settleAll([
      readSplitChatTabs(workspaceId, worktreeId),
      readSplitChatArchives(workspaceId, worktreeId),
      readSplitTrackedPlans(workspaceId, worktreeId),
      listWorktreeExecutionSummaries(workspaceId, worktreeId),
      listWorktreeAttachmentNames(workspaceId, worktreeId),
    ]);

  const attachmentPathsByChatId = new Map<string, string[]>();
  // Defer the heavy state service until canonical transcripts need scanning.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  for (const tab of [
    ...chatsFile.tabs,
    ...archivesFile.archived.map((entry) => entry.tab),
  ]) {
    if (!tab.transcript) continue;
    const paths = tab.pendingRevertAttachmentPath
      ? [tab.pendingRevertAttachmentPath]
      : [];
    if (tab.kind !== 'file')
      await getChatStateService().consumeTranscript(
        { projectId: workspaceId, worktreeId },
        tab.id,
        false,
        async (messages) => {
          for await (const message of messages)
            paths.push(...chatAttachmentPaths({ ...tab, messages: [message] }));
        },
      );
    attachmentPathsByChatId.set(tab.id, paths);
  }

  const { perRepo, root } = partitionSplitWorktreeItems({
    repoIds,
    repoCheckoutPathById,
    attachmentPathsByChatId,
    chatTabs: chatsFile.tabs,
    archivedChats: archivesFile.archived,
    executions,
    plans,
    attachmentNames,
    attachmentsDir: getWorktreeAttachmentsDir(workspaceId, worktreeId),
  });
  return { perRepo, root };
}

/** Whether a worktree still owns any persisted user or execution data. */
export async function hasSplitWorktreeStoredItems(
  workspaceId: string,
  worktreeId: string,
): Promise<boolean> {
  await flushSplitChatState(workspaceId, worktreeId);
  const [chatsFile, archivesFile, plans, executions, attachmentNames] =
    await settleAll([
      readSplitChatTabs(workspaceId, worktreeId),
      readSplitChatArchives(workspaceId, worktreeId),
      readSplitTrackedPlans(workspaceId, worktreeId),
      listWorktreeExecutionSummaries(workspaceId, worktreeId),
      listWorktreeAttachmentNames(workspaceId, worktreeId),
    ]);
  return (
    chatsFile.tabs.length > 0 ||
    (chatsFile.pendingQuestions?.length ?? 0) > 0 ||
    archivesFile.archived.length > 0 ||
    plans.length > 0 ||
    executions.length > 0 ||
    attachmentNames.length > 0
  );
}

async function listWorktreeExecutionSummaries(
  workspaceId: string,
  worktreeId: string,
): Promise<ExecutionSummary[]> {
  const executionsDir = createElectronExecutionRuntime().executionsDir;
  const summaries = await listExecutionSummaries(executionsDir);
  return summaries.filter(
    (summary) =>
      summary.project_id === workspaceId && summary.worktree_id === worktreeId,
  );
}

async function listWorktreeAttachmentNames(
  workspaceId: string,
  worktreeId: string,
): Promise<string[]> {
  try {
    const entries = await readdir(
      getWorktreeAttachmentsDir(workspaceId, worktreeId),
      { withFileTypes: true },
    );
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

/** One destination a repo's items migrate to during the split. */
export interface SplitItemsMigrationTarget {
  repoId: string;
  destinationWorkspaceId: string;
  destinationWorktreeId: string;
  /** The repo's checkout inside the source worktree. */
  oldCheckoutPath: string;
  /** The destination single-repo worktree checkout path. */
  newCheckoutPath: string;
}

export interface SplitItemsMigrationUndo {
  workspaceId: string;
  worktreeId: string;
  sourceChatsFile: ChatTabsFile;
  sourceArchivesFile: ArchivedChatsFile;
  sourcePlans: TrackedPlanData[];
  sourceStorageBackupRoot?: string;
  writtenChatFiles: Array<{
    workspaceId: string;
    worktreeId: string;
    migratedIds: string[];
    /** Rewritten destination snapshots used to detect later user edits. */
    migratedTabs?: PersistedChatTab[];
    migratedPendingQuestions?: PersistedPendingQuestion[];
  }>;
  writtenArchiveFiles: Array<{
    workspaceId: string;
    worktreeId: string;
    migratedIds: string[];
  }>;
  writtenPlanFiles: Array<{
    workspaceId: string;
    worktreeId: string;
    migratedIds: string[];
  }>;
  writtenAttachmentFiles?: Array<{
    workspaceId: string;
    worktreeId: string;
    sourcePath: string;
    destinationPath: string;
  }>;
  sourceAttachmentMoves?: Array<{ sourcePath: string; backupPath: string }>;
  sourceAttachmentBackupDir?: string;
}

type WrittenSplitChatFile = SplitItemsMigrationUndo['writtenChatFiles'][number];

function destinationItemKey(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}\0${worktreeId}`;
}

function pruneUnchangedMigratedChats(
  current: ChatTabsFile,
  written: WrittenSplitChatFile,
): { file: ChatTabsFile; hasDivergence: boolean } {
  const migratedIds = new Set(written.migratedIds);
  if (written.migratedTabs === undefined) {
    const tabs = current.tabs.filter((tab) => !migratedIds.has(tab.id));
    return {
      file: {
        ...current,
        tabs,
        activeTabId: tabs.some((tab) => tab.id === current.activeTabId)
          ? current.activeTabId
          : (tabs[0]?.id ?? ''),
        ...(current.pendingQuestions !== undefined
          ? {
              pendingQuestions: current.pendingQuestions.filter(
                (question) => !migratedIds.has(question.chatId),
              ),
            }
          : {}),
      },
      hasDivergence: false,
    };
  }

  const baselineTabs = new Map(
    written.migratedTabs.map((tab) => [tab.id, tab]),
  );
  const currentTabs = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const baselineQuestions = written.migratedPendingQuestions ?? [];
  const currentQuestions = current.pendingQuestions ?? [];
  const removableIds = new Set<string>();
  let hasDivergence = false;

  for (const chatId of written.migratedIds) {
    const currentTab = currentTabs.get(chatId);
    const baselineTab = baselineTabs.get(chatId);
    const tabUnchanged =
      currentTab === undefined ||
      (baselineTab !== undefined && isDeepStrictEqual(currentTab, baselineTab));
    const questionsUnchanged = isDeepStrictEqual(
      currentQuestions.filter((question) => question.chatId === chatId),
      baselineQuestions.filter((question) => question.chatId === chatId),
    );
    if (tabUnchanged && questionsUnchanged) {
      removableIds.add(chatId);
    } else {
      hasDivergence = true;
    }
  }

  const tabs = current.tabs.filter((tab) => !removableIds.has(tab.id));
  return {
    file: {
      ...current,
      tabs,
      activeTabId: tabs.some((tab) => tab.id === current.activeTabId)
        ? current.activeTabId
        : (tabs[0]?.id ?? ''),
      ...(current.pendingQuestions !== undefined
        ? {
            pendingQuestions: current.pendingQuestions.filter(
              (question) => !removableIds.has(question.chatId),
            ),
          }
        : {}),
    },
    hasDivergence,
  };
}

export class SplitItemsMigrationRollbackError extends Error {
  readonly migrationError: unknown;
  readonly rollbackError: unknown;

  constructor(migrationError: unknown, rollbackError: unknown) {
    const migrationMessage =
      migrationError instanceof Error
        ? migrationError.message
        : String(migrationError);
    const rollbackMessage =
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
    super(
      `Split item migration failed (${migrationMessage}) and rollback could not restore the source data (${rollbackMessage}). Destination data was retained for recovery.`,
    );
    this.name = 'SplitItemsMigrationRollbackError';
    this.migrationError = migrationError;
    this.rollbackError = rollbackError;
  }
}

export class SplitExecutionMigrationRollbackError extends Error {
  readonly migrationError: unknown;
  readonly rollbackError: unknown;

  constructor(migrationError: unknown, rollbackError: unknown) {
    const migrationMessage =
      migrationError instanceof Error
        ? migrationError.message
        : String(migrationError);
    const rollbackMessage =
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
    super(
      `Split execution migration failed (${migrationMessage}) and rollback could not restore every execution (${rollbackMessage}). Destination state was retained for recovery.`,
    );
    this.name = 'SplitExecutionMigrationRollbackError';
    this.migrationError = migrationError;
    this.rollbackError = rollbackError;
  }
}

function rewriteTabForDestination(
  tab: PersistedChatTab,
  target: SplitItemsMigrationTarget,
  attachmentNames: ReadonlySet<string>,
  sourceAttachmentsDir: string,
  destinationAttachmentsDir: string,
): PersistedChatTab {
  const next: PersistedChatTab = { ...tab };
  // Single-repo destinations have no repo selection — the checkout root IS
  // the repo.
  delete next.selectedRepoId;
  if (
    next.kind === 'file' &&
    next.filePath &&
    isPathInsideOrEqual(next.filePath, target.oldCheckoutPath)
  ) {
    next.filePath = `${target.newCheckoutPath}${next.filePath.slice(
      target.oldCheckoutPath.length,
    )}`;
  }
  const rewriteAttachmentPath = (path: string): string => {
    const name = basename(path);
    return attachmentNames.has(name) &&
      path === join(sourceAttachmentsDir, name)
      ? join(destinationAttachmentsDir, name)
      : path;
  };
  next.messages = (tab.transcript ? [] : tab.messages).map((message) => ({
    ...message,
    ...(message.attachmentPaths
      ? {
          attachmentPaths: message.attachmentPaths.map(rewriteAttachmentPath),
        }
      : {}),
    ...(message.attachmentPromptContexts
      ? {
          attachmentPromptContexts: message.attachmentPromptContexts.map(
            (context) => ({
              ...context,
              attachmentPath: rewriteAttachmentPath(context.attachmentPath),
            }),
          ),
        }
      : {}),
    blocks: message.blocks.map((block) =>
      block.type === 'revert_info' && block.attachmentPath
        ? {
            ...block,
            attachmentPath: rewriteAttachmentPath(block.attachmentPath),
          }
        : block,
    ),
  }));
  if (tab.pendingRevertAttachmentPath) {
    next.pendingRevertAttachmentPath = rewriteAttachmentPath(
      tab.pendingRevertAttachmentPath,
    );
  }
  return next;
}

async function restoreSplitChatBackup(
  undo: SplitItemsMigrationUndo,
  chatIds?: ReadonlySet<string>,
  archiveIds?: ReadonlySet<string>,
): Promise<void> {
  if (!undo.sourceStorageBackupRoot) return;
  // Lazy import breaks the workspace split/state migration cycle.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  const service = getChatStateService();
  const scope = { projectId: undo.workspaceId, worktreeId: undo.worktreeId };
  const current = await service.getCompatibilityTabs(scope);
  const archives = await service.getCompatibilityArchives(scope);
  const existing = new Set(
    [...current.tabs, ...archives.archived.map((entry) => entry.tab)].map(
      (tab) => tab.id,
    ),
  );
  const tabs = undo.sourceChatsFile.tabs.filter(
    (tab) => !existing.has(tab.id) && (!chatIds || chatIds.has(tab.id)),
  );
  const archived = undo.sourceArchivesFile.archived.filter(
    (entry) =>
      !existing.has(entry.tab.id) &&
      (!archiveIds || archiveIds.has(entry.tab.id)),
  );
  if (!tabs.length && !archived.length) return;
  const restoredIds = new Set(tabs.map((tab) => tab.id));
  await service.importStorageScope(
    scope,
    new ChatStorageV2(undo.sourceStorageBackupRoot, 'source'),
    {
      version: 1,
      tabs,
      activeTabId: current.activeTabId || tabs[0]?.id || '',
      pendingQuestions: undo.sourceChatsFile.pendingQuestions?.filter(
        (question) => restoredIds.has(question.chatId),
      ),
    },
    { version: 1, archived },
    { merge: true },
  );
}

/**
 * Move repo-owned chats and tracked plans from the source worktree's stores
 * into each destination worktree's stores. Runs during the split's fast phase
 * (pure JSON work) so migrated chats are already on disk when the renderer
 * selects a destination. Returns an undo payload for background-phase
 * rollback.
 */
export async function migrateSplitChatsAndPlans(params: {
  workspaceId: string;
  worktreeId: string;
  analysis: SplitWorktreeItemsAnalysis;
  targets: SplitItemsMigrationTarget[];
  hardDeleteRepoIds?: ReadonlySet<string>;
}): Promise<SplitItemsMigrationUndo> {
  const {
    workspaceId,
    worktreeId,
    analysis,
    targets,
    hardDeleteRepoIds = new Set<string>(),
  } = params;
  await flushSplitChatState(workspaceId, worktreeId);
  const [sourceChatsFile, sourceArchivesFile, sourcePlans] = await settleAll([
    readSplitChatTabs(workspaceId, worktreeId),
    readSplitChatArchives(workspaceId, worktreeId),
    readSplitTrackedPlans(workspaceId, worktreeId),
  ]);
  const undo: SplitItemsMigrationUndo = {
    workspaceId,
    worktreeId,
    sourceChatsFile,
    sourceArchivesFile,
    sourcePlans,
    writtenChatFiles: [],
    writtenArchiveFiles: [],
    writtenPlanFiles: [],
    writtenAttachmentFiles: [],
    sourceAttachmentMoves: [],
  };
  const canonical = [
    ...sourceChatsFile.tabs,
    ...sourceArchivesFile.archived.map((entry) => entry.tab),
  ].some((tab) => tab.transcript !== undefined);
  if (canonical) {
    const backupParent = join(getWorkspaceDir(workspaceId), 'split-recovery');
    await mkdir(backupParent, { recursive: true });
    undo.sourceStorageBackupRoot = await mkdtemp(
      join(backupParent, 'transcripts-'),
    );
    // Lazy import breaks the workspace split/state migration cycle.
    const { getChatStateService } =
      await import('../services/chat-state-service');
    await getChatStateService().captureStorageScope(
      { projectId: workspaceId, worktreeId },
      new ChatStorageV2(undo.sourceStorageBackupRoot, 'source'),
    );
  }
  const sourceAttachmentsDir = getWorktreeAttachmentsDir(
    workspaceId,
    worktreeId,
  );

  const movedTabIds = new Set<string>();
  const movedArchivedIds = new Set<string>();
  const movedPlanIds = new Set<string>();
  try {
    for (const target of targets) {
      const items = analysis.perRepo.get(target.repoId);
      if (!items) {
        continue;
      }
      const attachmentNames = new Set(items.attachmentNames ?? []);
      const destinationAttachmentsDir = getWorktreeAttachmentsDir(
        target.destinationWorkspaceId,
        target.destinationWorktreeId,
      );
      if (attachmentNames.size > 0) {
        await mkdir(destinationAttachmentsDir, { recursive: true });
        for (const name of Array.from(attachmentNames)) {
          const sourcePath = join(sourceAttachmentsDir, name);
          const destinationPath = join(destinationAttachmentsDir, name);
          await copyFile(sourcePath, destinationPath);
          undo.writtenAttachmentFiles?.push({
            workspaceId: target.destinationWorkspaceId,
            worktreeId: target.destinationWorktreeId,
            sourcePath,
            destinationPath,
          });
        }
      }
      // Live chat tabs move with the repo; open file tabs whose file lives in
      // the repo's checkout ride along (path-rewritten) but never surface in
      // the modal counters.
      const movingTabs = [...items.chatTabs, ...items.fileTabs];
      if (movingTabs.length > 0) {
        const movingTabIds = new Set(movingTabs.map((tab) => tab.id));
        const tabs = movingTabs.map((tab) =>
          rewriteTabForDestination(
            tab,
            target,
            attachmentNames,
            sourceAttachmentsDir,
            destinationAttachmentsDir,
          ),
        );
        const pendingQuestions = (
          sourceChatsFile.pendingQuestions ?? []
        ).filter((question) => movingTabIds.has(question.chatId));
        const destinationFile: ChatTabsFile = {
          version: 1,
          tabs,
          activeTabId:
            tabs.find((tab) => tab.kind !== 'file')?.id ?? tabs[0]?.id ?? '',
          ...(pendingQuestions.length > 0 ? { pendingQuestions } : {}),
        };
        if (canonical) {
          // Lazy import breaks the workspace split/state migration cycle.
          const { getChatStateService } =
            await import('../services/chat-state-service');
          await getChatStateService().copyStorageChats(
            { projectId: workspaceId, worktreeId },
            {
              projectId: target.destinationWorkspaceId,
              worktreeId: target.destinationWorktreeId,
            },
            destinationFile,
            undefined,
            undefined,
            (message) =>
              rewriteTabForDestination(
                {
                  ...movingTabs[0],
                  transcript: undefined,
                  messages: [message],
                },
                target,
                attachmentNames,
                sourceAttachmentsDir,
                destinationAttachmentsDir,
              ).messages[0],
          );
        } else {
          await writeChatTabsFile(
            target.destinationWorkspaceId,
            target.destinationWorktreeId,
            destinationFile,
            {
              changedTabIds: tabs.map((tab) => tab.id),
              removedTabIds: [],
              authoritative: true,
            },
          );
        }
        undo.writtenChatFiles.push({
          workspaceId: target.destinationWorkspaceId,
          worktreeId: target.destinationWorktreeId,
          migratedIds: movingTabs.map((tab) => tab.id),
          migratedTabs: canonical
            ? (
                await readSplitChatTabs(
                  target.destinationWorkspaceId,
                  target.destinationWorktreeId,
                )
              ).tabs.filter((tab) => movingTabIds.has(tab.id))
            : tabs,
          migratedPendingQuestions: pendingQuestions,
        });
        for (const tab of movingTabs) {
          movedTabIds.add(tab.id);
        }
      }
      if (items.archivedChats.length > 0) {
        const destinationArchives: ArchivedChatsFile = {
          version: 1,
          archived: items.archivedChats.map((entry) => ({
            ...entry,
            tab: rewriteTabForDestination(
              entry.tab,
              target,
              attachmentNames,
              sourceAttachmentsDir,
              destinationAttachmentsDir,
            ),
          })),
        };
        if (canonical) {
          // Lazy import breaks the workspace split/state migration cycle.
          const { getChatStateService } =
            await import('../services/chat-state-service');
          const current = await readSplitChatTabs(
            target.destinationWorkspaceId,
            target.destinationWorktreeId,
          );
          await getChatStateService().copyStorageChats(
            { projectId: workspaceId, worktreeId },
            {
              projectId: target.destinationWorkspaceId,
              worktreeId: target.destinationWorktreeId,
            },
            { version: 1, tabs: [], activeTabId: current.activeTabId },
            destinationArchives,
            undefined,
            (message) =>
              rewriteTabForDestination(
                {
                  ...items.archivedChats[0].tab,
                  transcript: undefined,
                  messages: [message],
                },
                target,
                attachmentNames,
                sourceAttachmentsDir,
                destinationAttachmentsDir,
              ).messages[0],
          );
        } else {
          await writeChatArchivesFile(
            target.destinationWorkspaceId,
            target.destinationWorktreeId,
            destinationArchives,
          );
        }
        undo.writtenArchiveFiles.push({
          workspaceId: target.destinationWorkspaceId,
          worktreeId: target.destinationWorktreeId,
          migratedIds: items.archivedChats.map((entry) => entry.tab.id),
        });
        for (const entry of items.archivedChats) {
          movedArchivedIds.add(entry.tab.id);
        }
      }
      if (items.plans.length > 0) {
        await installRestoredTrackedPlans(
          target.destinationWorkspaceId,
          target.destinationWorktreeId,
          items.plans.map((plan) => ({
            ...plan,
            sourceRepoId:
              plan.sourceRepoId === undefined
                ? undefined
                : WORKSPACE_ROOT_REPO_ID,
          })),
        );
        undo.writtenPlanFiles.push({
          workspaceId: target.destinationWorkspaceId,
          worktreeId: target.destinationWorktreeId,
          migratedIds: items.plans.map((plan) => plan.id),
        });
        for (const plan of items.plans) {
          movedPlanIds.add(plan.id);
        }
      }
    }

    // Hard-delete records participate in the same reversible source rewrite
    // as migrated records. If checkout moves fail, the undo snapshot restores
    // them; once moves succeed, they cannot leak into a retained root archive.
    for (const repoId of Array.from(hardDeleteRepoIds)) {
      const items = analysis.perRepo.get(repoId);
      if (!items) {
        continue;
      }
      for (const tab of [...items.chatTabs, ...items.fileTabs]) {
        movedTabIds.add(tab.id);
      }
      for (const entry of items.archivedChats) {
        movedArchivedIds.add(entry.tab.id);
      }
      for (const plan of items.plans) {
        movedPlanIds.add(plan.id);
      }
    }

    if (movedTabIds.size > 0) {
      const remainingTabs = sourceChatsFile.tabs.filter(
        (tab) => !movedTabIds.has(tab.id),
      );
      const remainingSource: ChatTabsFile = {
        ...sourceChatsFile,
        tabs: remainingTabs,
        activeTabId: remainingTabs.some(
          (tab) => tab.id === sourceChatsFile.activeTabId,
        )
          ? sourceChatsFile.activeTabId
          : (remainingTabs[0]?.id ?? ''),
        ...(sourceChatsFile.pendingQuestions !== undefined
          ? {
              pendingQuestions: sourceChatsFile.pendingQuestions.filter(
                (question) => !movedTabIds.has(question.chatId),
              ),
            }
          : {}),
      };
      await writeChatTabsFile(workspaceId, worktreeId, remainingSource, {
        changedTabIds: [],
        removedTabIds: Array.from(movedTabIds),
      });
    }
    if (movedArchivedIds.size > 0) {
      await settleAll(
        Array.from(movedArchivedIds).map((chatId) =>
          removeChatArchive(workspaceId, worktreeId, chatId),
        ),
      );
    }
    if (movedPlanIds.size > 0) {
      const remainingPlans = sourcePlans.filter(
        (plan) => !movedPlanIds.has(plan.id),
      );
      if (remainingPlans.length > 0) {
        await installRestoredTrackedPlans(
          workspaceId,
          worktreeId,
          remainingPlans,
        );
      } else {
        await deleteTrackedPlansForWorktree(workspaceId, worktreeId);
      }
    }
    const rootAttachmentNames = new Set(analysis.root.attachmentNames ?? []);
    const repoOnlyAttachmentNames = new Set(
      Array.from(analysis.perRepo.values())
        .flatMap((items) => items.attachmentNames ?? [])
        .filter((name) => !rootAttachmentNames.has(name)),
    );
    if (repoOnlyAttachmentNames.size > 0) {
      const backupDir = await mkdtemp(
        join(
          dirname(sourceAttachmentsDir),
          `${basename(sourceAttachmentsDir)}-split-`,
        ),
      );
      undo.sourceAttachmentBackupDir = backupDir;
      for (const name of Array.from(repoOnlyAttachmentNames)) {
        const sourcePath = join(sourceAttachmentsDir, name);
        const backupPath = join(backupDir, name);
        await rename(sourcePath, backupPath);
        undo.sourceAttachmentMoves?.push({ sourcePath, backupPath });
      }
    }
    return undo;
  } catch (error) {
    try {
      await undoSplitChatsAndPlansMigration(undo);
    } catch (rollbackError) {
      throw new SplitItemsMigrationRollbackError(error, rollbackError);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Drop the reversible source-attachment backup after checkout moves succeed. */
export async function finalizeSplitChatsAndPlansMigration(
  undo: SplitItemsMigrationUndo,
): Promise<void> {
  if (undo.sourceStorageBackupRoot) {
    await rm(undo.sourceStorageBackupRoot, { recursive: true, force: true });
    undo.sourceStorageBackupRoot = undefined;
  }
  if (!undo.sourceAttachmentBackupDir) return;
  await rm(undo.sourceAttachmentBackupDir, { recursive: true, force: true });
  undo.sourceAttachmentMoves = [];
  undo.sourceAttachmentBackupDir = undefined;
}

/** Restore source stores and remove only the records migrated to destinations. */
export async function undoSplitChatsAndPlansMigration(
  undo: SplitItemsMigrationUndo,
): Promise<void> {
  // Restore and verify the source first. If any source write fails, destination
  // copies remain intact and the error propagates so the data stays recoverable.
  if ((undo.sourceAttachmentMoves?.length ?? 0) > 0) {
    await mkdir(dirname(undo.sourceAttachmentMoves?.[0]?.sourcePath ?? ''), {
      recursive: true,
    });
    for (const moved of undo.sourceAttachmentMoves ?? []) {
      await rename(moved.backupPath, moved.sourcePath);
    }
    if (undo.sourceAttachmentBackupDir) {
      await rm(undo.sourceAttachmentBackupDir, {
        recursive: true,
        force: true,
      });
    }
  }
  if (undo.sourceStorageBackupRoot) {
    await restoreSplitChatBackup(undo);
  } else {
    await writeChatTabsFile(
      undo.workspaceId,
      undo.worktreeId,
      undo.sourceChatsFile,
      {
        changedTabIds: undo.sourceChatsFile.tabs.map((tab) => tab.id),
        removedTabIds: [],
        authoritative: true,
      },
    );
    await writeChatArchivesFile(
      undo.workspaceId,
      undo.worktreeId,
      undo.sourceArchivesFile,
      { authoritative: true },
    );
  }
  if (undo.sourcePlans.length > 0) {
    await installRestoredTrackedPlans(
      undo.workspaceId,
      undo.worktreeId,
      undo.sourcePlans,
    );
  }

  const preservedDestinations = new Set<string>();
  for (const written of undo.writtenChatFiles) {
    const current = await readChatTabsFile(
      written.workspaceId,
      written.worktreeId,
    );
    const pruned = pruneUnchangedMigratedChats(current, written);
    if (pruned.hasDivergence) {
      preservedDestinations.add(
        destinationItemKey(written.workspaceId, written.worktreeId),
      );
    }
    await writeChatTabsFile(
      written.workspaceId,
      written.worktreeId,
      pruned.file,
    );
  }
  for (const written of undo.writtenAttachmentFiles ?? []) {
    if (
      preservedDestinations.has(
        destinationItemKey(written.workspaceId, written.worktreeId),
      )
    ) {
      continue;
    }
    await rm(written.destinationPath, { force: true });
  }
  for (const written of undo.writtenArchiveFiles) {
    if (
      preservedDestinations.has(
        destinationItemKey(written.workspaceId, written.worktreeId),
      )
    ) {
      continue;
    }
    for (const chatId of written.migratedIds) {
      await removeChatArchive(written.workspaceId, written.worktreeId, chatId);
    }
  }
  for (const written of undo.writtenPlanFiles) {
    if (
      preservedDestinations.has(
        destinationItemKey(written.workspaceId, written.worktreeId),
      )
    ) {
      continue;
    }
    for (const planId of written.migratedIds) {
      await deleteTrackedPlan(written.workspaceId, written.worktreeId, planId);
    }
  }
}

/**
 * Roll back one destination while leaving migrations for other repos intact.
 * This is used when an archive-only destination cannot accept its checkout:
 * the source worktree remains live, so only that repo's records return to it.
 */
export async function undoSplitChatsAndPlansTargetMigration(
  undo: SplitItemsMigrationUndo,
  target: SplitItemsMigrationTarget,
): Promise<void> {
  const matchesTarget = (entry: {
    workspaceId: string;
    worktreeId: string;
  }): boolean =>
    entry.workspaceId === target.destinationWorkspaceId &&
    entry.worktreeId === target.destinationWorktreeId;
  const chatIds = new Set(
    undo.writtenChatFiles
      .filter(matchesTarget)
      .flatMap((entry) => entry.migratedIds),
  );
  const archiveIds = new Set(
    undo.writtenArchiveFiles
      .filter(matchesTarget)
      .flatMap((entry) => entry.migratedIds),
  );
  const planIds = new Set(
    undo.writtenPlanFiles
      .filter(matchesTarget)
      .flatMap((entry) => entry.migratedIds),
  );
  const attachmentFiles = (undo.writtenAttachmentFiles ?? []).filter(
    matchesTarget,
  );

  for (const attachment of attachmentFiles) {
    await mkdir(dirname(attachment.sourcePath), { recursive: true });
    await copyFile(attachment.destinationPath, attachment.sourcePath);
  }

  if (undo.sourceStorageBackupRoot) {
    await restoreSplitChatBackup(undo, chatIds, archiveIds);
  } else {
    const restoredTabs = undo.sourceChatsFile.tabs.filter((tab) =>
      chatIds.has(tab.id),
    );
    const restoredPendingQuestions = (
      undo.sourceChatsFile.pendingQuestions ?? []
    ).filter((question) => chatIds.has(question.chatId));
    if (restoredTabs.length > 0 || restoredPendingQuestions.length > 0) {
      const sourceChats = await readChatTabsFile(
        undo.workspaceId,
        undo.worktreeId,
      );
      const currentTabIds = new Set(sourceChats.tabs.map((tab) => tab.id));
      const tabs = [
        ...sourceChats.tabs,
        ...restoredTabs.filter((tab) => !currentTabIds.has(tab.id)),
      ];
      const currentQuestionIds = new Set(
        (sourceChats.pendingQuestions ?? []).map(
          (question) => question.requestId,
        ),
      );
      const pendingQuestions = [
        ...(sourceChats.pendingQuestions ?? []),
        ...restoredPendingQuestions.filter(
          (question) => !currentQuestionIds.has(question.requestId),
        ),
      ];
      await writeChatTabsFile(
        undo.workspaceId,
        undo.worktreeId,
        {
          ...sourceChats,
          tabs,
          activeTabId: tabs.some((tab) => tab.id === sourceChats.activeTabId)
            ? sourceChats.activeTabId
            : (restoredTabs[0]?.id ?? tabs[0]?.id ?? ''),
          ...(pendingQuestions.length > 0 ? { pendingQuestions } : {}),
        },
        {
          changedTabIds: restoredTabs.map((tab) => tab.id),
          removedTabIds: [],
          authoritative: true,
        },
      );
    }

    const archivesToRestore = undo.sourceArchivesFile.archived.filter((entry) =>
      archiveIds.has(entry.tab.id),
    );
    if (archivesToRestore.length > 0) {
      const sourceArchives = await readChatArchivesFileForIndex(
        undo.workspaceId,
        undo.worktreeId,
      );
      const currentArchiveIds = new Set(
        sourceArchives.archived.map((entry) => entry.tab.id),
      );
      const restoredArchives = archivesToRestore.filter(
        (entry) => !currentArchiveIds.has(entry.tab.id),
      );
      if (restoredArchives.length > 0) {
        await writeChatArchivesFile(
          undo.workspaceId,
          undo.worktreeId,
          {
            ...sourceArchives,
            archived: [...sourceArchives.archived, ...restoredArchives],
          },
          { authoritative: true },
        );
      }
    }
  }
  const restoredPlans = undo.sourcePlans.filter((plan) => planIds.has(plan.id));
  if (restoredPlans.length > 0) {
    const currentPlans = await readSplitTrackedPlans(
      undo.workspaceId,
      undo.worktreeId,
    );
    const currentPlanIds = new Set(currentPlans.map((plan) => plan.id));
    await installRestoredTrackedPlans(undo.workspaceId, undo.worktreeId, [
      ...currentPlans,
      ...restoredPlans.filter((plan) => !currentPlanIds.has(plan.id)),
    ]);
  }

  // Only after every source record is durable do we remove the destination
  // copies. Strict reads ensure a transient/parse failure cannot become an
  // authoritative empty file that erases post-split chats.
  let preserveDestination = false;
  for (const written of undo.writtenChatFiles.filter(matchesTarget)) {
    const current = await readChatTabsFile(
      written.workspaceId,
      written.worktreeId,
    );
    const pruned = pruneUnchangedMigratedChats(current, written);
    preserveDestination ||= pruned.hasDivergence;
    await writeChatTabsFile(
      written.workspaceId,
      written.worktreeId,
      pruned.file,
    );
  }
  if (!preserveDestination) {
    for (const written of undo.writtenArchiveFiles.filter(matchesTarget)) {
      for (const chatId of written.migratedIds) {
        await removeChatArchive(
          written.workspaceId,
          written.worktreeId,
          chatId,
        );
      }
    }
    for (const written of undo.writtenPlanFiles.filter(matchesTarget)) {
      for (const planId of written.migratedIds) {
        await deleteTrackedPlan(
          written.workspaceId,
          written.worktreeId,
          planId,
        );
      }
    }
    for (const attachment of attachmentFiles) {
      await rm(attachment.destinationPath, { force: true });
    }
  }
}

/** Delete exact execution artifacts owned by repositories selected for removal. */
export async function deleteSplitPipelineExecutions(
  executions: ExecutionSummary[],
): Promise<void> {
  const executionsDir = createElectronExecutionRuntime().executionsDir;
  await settleAll(
    executions.map((execution) =>
      deleteExecutionArtifacts(execution.id, executionsDir),
    ),
  );
}

/**
 * Re-home repo-owned pipeline executions onto their destination worktrees,
 * rewriting each execution's cwd from the source child checkout to the new
 * single-repo checkout. Any partial migration is restored before an error is
 * rethrown to the caller.
 */
export async function migrateSplitPipelineExecutions(params: {
  workspaceId: string;
  worktreeId: string;
  targets: SplitItemsMigrationTarget[];
}): Promise<Map<string, ExecutionState>> {
  const executionsDir = createElectronExecutionRuntime().executionsDir;
  const snapshots = new Map<string, ExecutionState>();
  const summaries = await listWorktreeExecutionSummaries(
    params.workspaceId,
    params.worktreeId,
  );
  const rewrites = params.targets.map((target) => ({
    fromRoot: target.oldCheckoutPath,
    toRoot: target.newCheckoutPath,
  }));
  try {
    for (const summary of summaries) {
      const target = [...params.targets]
        .sort((a, b) => b.oldCheckoutPath.length - a.oldCheckoutPath.length)
        .find(
          (candidate) =>
            summary.cwd &&
            isPathInsideOrEqual(summary.cwd, candidate.oldCheckoutPath),
        );
      if (!target) {
        continue;
      }
      const state = await loadExecutionState(summary.id, executionsDir);
      if (!state) {
        continue;
      }
      snapshots.set(summary.id, state);
      const relocated = relocateExecutionCheckout(state, {
        sourceWorkspaceId: params.workspaceId,
        sourceWorktreeId: params.worktreeId,
        destinationWorkspaceId: target.destinationWorkspaceId,
        destinationWorktreeId: target.destinationWorktreeId,
        rewrites,
      });
      await saveExecutionState(
        {
          ...relocated,
          project_id: target.destinationWorkspaceId,
          worktree_id: target.destinationWorktreeId,
        },
        executionsDir,
      );
    }
  } catch (error) {
    try {
      await restoreSplitExecutionSnapshots(snapshots);
    } catch (rollbackError) {
      throw new SplitExecutionMigrationRollbackError(error, rollbackError);
    }
    throw error;
  }
  return snapshots;
}

export async function restoreSplitExecutionSnapshots(
  snapshots: Map<string, ExecutionState>,
): Promise<void> {
  const executionsDir = createElectronExecutionRuntime().executionsDir;
  for (const state of Array.from(snapshots.values())) {
    await saveExecutionState(state, executionsDir);
  }
}

export async function restoreSplitExecutionSnapshotsForTarget(
  snapshots: Map<string, ExecutionState>,
  target: SplitItemsMigrationTarget,
): Promise<void> {
  const targetSnapshots = new Map<string, ExecutionState>();
  for (const [executionId, state] of Array.from(snapshots.entries())) {
    if (isPathInsideOrEqual(state.cwd, target.oldCheckoutPath)) {
      targetSnapshots.set(executionId, state);
    }
  }
  await restoreSplitExecutionSnapshots(targetSnapshots);
}
