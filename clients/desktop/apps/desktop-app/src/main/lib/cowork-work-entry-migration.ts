/**
 * Shared flat-chat splitter plus the one-time cowork startup migration. Each
 * flat pre-entry chat list becomes Work Entries — one entry per chat, the
 * entry reusing its founding chat's id (so legacy `(workspaceId, chatId)`
 * references resolve to their entry for free).
 *
 * Per workspace, idempotent and resumable:
 * 1. For each chat-kind tab in the legacy flat chat file, write a single-tab
 *    `chats/{tab.id}.json` (skipped when it already exists — an existing
 *    destination is complete because writes are atomic).
 * 2. Best-effort move `chat-plugins/{ws}/home/{chatId}/` →
 *    `chat-plugins/{ws}/{chatId}/{chatId}/` so installed chat capability assets
 *    follow their chat into its entry.
 * 3. Append the registry rows (deduped by id), THEN delete the legacy file
 *    — a crash between the two leaves the source in place so the rerun
 *    re-covers every tab.
 *
 * Deliberately left in place: the legacy slot's unified archives, summaries,
 * worktree data, and attachments. They remain read-only/inert legacy stores.
 * File-kind tabs are not migrated — they are file viewers, not chats.
 *
 * The `cowork_work_entries` marker is written only after every cowork
 * workspace migrates; a failed workspace is left untouched and retried on
 * the next launch (same posture as `cowork_workspaces`).
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  COWORK_HOME_WORKTREE_ID,
  type ChatTabsFile,
  type CoworkWorkEntryData,
} from '@canopy/desktop-shared/types';
import { hasMigrationRun, markMigrationRun } from './migrations';
import { reportStartupStepFailure } from './startup-step';
import { readWorkspaceIndexEntries } from './sidebar-items';
import { readChatTabsFileForIndex } from './chat-tabs-reader';
import { appendWorkEntryRows } from './cowork-work-entries';
import { getChatPluginsRootDir, getWorkspaceChatTabsFilePath } from './paths';
import { pathExists } from './fs-utils';
import { ChatStorageV2 } from './chat-storage-v2';
import { validateId } from './validation';

export const COWORK_WORK_ENTRIES_MIGRATION_KEY = 'cowork_work_entries';

function migratedLegacySlotEntryId(
  workspaceId: string,
  legacySlotId: string,
): string {
  const workspaceHash = createHash('sha256')
    .update(`${workspaceId}\n${legacySlotId}`)
    .digest('hex')
    .slice(0, 24);
  return `migrated-${legacySlotId}-${workspaceHash}`;
}

async function moveEntryChatPlugins(
  workspaceId: string,
  chatId: string,
  entryId: string,
  legacySlotId: string,
  renamePath: typeof rename = rename,
): Promise<void> {
  const source = join(
    getChatPluginsRootDir(),
    workspaceId,
    legacySlotId,
    chatId,
  );
  const destination = join(
    getChatPluginsRootDir(),
    workspaceId,
    entryId,
    chatId,
  );
  try {
    if (!(await pathExists(source)) || (await pathExists(destination))) {
      return;
    }
    await mkdir(dirname(destination), { recursive: true });
    await renamePath(source, destination);
  } catch {
    // Best-effort: chat capability assets re-resolve on next use when the move
    // fails; never fail the migration over them.
  }
}

/**
 * Splits one workspace's flat legacy chat file into per-entry tab files.
 * Exported for the cowork bundle import path: an old-shape bundle restored
 * after the global marker is set still needs its chats split.
 */
export async function splitFlatChatTabsIntoEntries(
  workspaceId: string,
  legacySlotId: string,
  options?: {
    renamePath?: typeof rename;
    removeLegacySource?: typeof rm;
  },
): Promise<void> {
  const homeTabsPath = getWorkspaceChatTabsFilePath(workspaceId, legacySlotId);
  if (
    !(await pathExists(homeTabsPath)) &&
    (await new ChatStorageV2(
      dirname(dirname(homeTabsPath)),
      legacySlotId,
    ).authority()) !== 'v2'
  ) {
    // Nothing to split — fresh workspace or already migrated.
    return;
  }

  const homeTabs = await readChatTabsFileForIndex(workspaceId, legacySlotId);
  const rows: CoworkWorkEntryData[] = [];

  for (const tab of homeTabs.tabs) {
    if (tab.kind === 'file') continue;
    // Guard the pathological id collision with the legacy slot itself.
    const entryId =
      tab.id === legacySlotId
        ? migratedLegacySlotEntryId(workspaceId, legacySlotId)
        : tab.id;
    validateId(entryId, 'legacy chat id');
    // Lazy import breaks the legacy migration/state initialization cycle.
    const { getChatStateService } =
      await import('../services/chat-state-service');
    const file: ChatTabsFile = { version: 1, tabs: [tab], activeTabId: tab.id };
    await getChatStateService().copyStorageChats(
      { projectId: workspaceId, worktreeId: legacySlotId },
      { projectId: workspaceId, worktreeId: entryId },
      file,
    );
    rows.push({ id: entryId, createdAt: tab.createdAt });
    await moveEntryChatPlugins(
      workspaceId,
      tab.id,
      entryId,
      legacySlotId,
      options?.renamePath,
    );
  }

  // Registry rows land before the legacy file is deleted: a crash in between
  // just reruns the (idempotent) split on next launch.
  await appendWorkEntryRows(workspaceId, rows);
  await (options?.removeLegacySource ?? rm)(homeTabsPath, { force: true });
  // Lazy import breaks the legacy migration/state initialization cycle.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  await getChatStateService().replaceCompatibilityTabs(
    { projectId: workspaceId, worktreeId: legacySlotId },
    { ...homeTabs, tabs: [], activeTabId: '' },
    { changedTabIds: [], removedTabIds: homeTabs.tabs.map((tab) => tab.id) },
  );
}

/**
 * Splits one cowork workspace's flat `chats/home.json` into per-entry tab
 * files. Exported for the cowork bundle import path: an old-shape bundle
 * restored after the global marker is set still needs its chats split.
 */
export async function migrateWorkspaceChatsToWorkEntries(
  workspaceId: string,
): Promise<void> {
  await splitFlatChatTabsIntoEntries(workspaceId, COWORK_HOME_WORKTREE_ID);
}

export async function migrateCoworkChatsToWorkEntries(): Promise<void> {
  if (await hasMigrationRun(COWORK_WORK_ENTRIES_MIGRATION_KEY)) {
    return;
  }

  // The index alone: this runs before the first window, and a full sidebar
  // projection can wait on remote git calls for source-backed projects.
  const coworkIds = (await readWorkspaceIndexEntries())
    .filter((entry) => entry.type === 'cowork')
    .map((entry) => entry.id);

  let allSucceeded = true;
  for (const workspaceId of coworkIds) {
    try {
      await migrateWorkspaceChatsToWorkEntries(workspaceId);
    } catch (error) {
      allSucceeded = false;
      // eslint-disable-next-line no-console
      console.error(
        `Failed to migrate cowork project ${workspaceId} to work entries:`,
        error,
      );
      // The fixed source carries no workspace id.
      reportStartupStepFailure('migration.cowork_work_entries', error);
    }
  }

  if (allSucceeded) {
    await markMigrationRun(COWORK_WORK_ENTRIES_MIGRATION_KEY);
  }
}
