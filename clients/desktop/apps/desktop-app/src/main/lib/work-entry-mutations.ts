import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type CoworkWorkEntryDeleteRequest,
  type CoworkWorkEntryDeleteResponse,
  type CoworkWorkEntryUpdateRequest,
} from '@canopy/desktop-shared/types';
import { destroyWorktreeSessions } from '../agents/session-manager';
import { assertWorktreeCanBeRemoved } from '../agents/background-work';
import {
  listWorkEntries,
  listWorkEntryChatSummaries,
  removeWorkEntryRow,
  updateWorkEntry,
} from './cowork-work-entries';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { isCoworkWorkspace } from './workspace-registry';
import { cleanupPersistedWorktreeData } from './worktree-data-cleanup';
import { validateId } from './validation';
import { broadcastArchivedContainersChanged } from './archived-containers';
import { resolveContainerRetentionDays } from './archived-container-retention';
import { captureWorkEntryArchivedContainer } from './archived-container-capture';
import { getChatStateService } from '../services/chat-state-service';
import { getChatQueueService } from '../services/chat-queue-service';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { notifyLedgerContainerArchived } from '../ledger/lifecycle';
import { workEntryLedgerIncarnation } from '../ledger/lifecycle-containers';
import { runAsLocalFenceHolder } from '../app-advisor/local-fence-holder';

/**
 * Tells the Ledger that a Cowork or App Advisor Work Entry was deleted, so its
 * scope becomes read-only when the deletion committed a retained archive
 * manifest, or retires when it did not. Call only after the entry row is
 * irreversibly removed. The participant returns at once, so no deletion lock
 * is held while it waits on Ledger storage.
 */
function notifyLedgerOfWorkEntryDeletion(
  workspaceId: string,
  entry: { readonly id: string; readonly createdAt: string },
  retained: boolean,
): void {
  try {
    notifyLedgerContainerArchived(
      workEntryLedgerIncarnation(workspaceId, entry),
      { retained },
    );
  } catch {
    // The participant never throws. A defect in it must not fail a deletion
    // past its commit point; startup reconciliation settles the scope.
  }
}

/** Resolve the workspace accepted by the legacy Work Entry IPC surface. */
export function assertWorkEntryWorkspace(projectId: string): string {
  validateId(projectId, 'projectId');
  // App Advisor is an app-managed Work Entry workspace. It deliberately does
  // not participate in workspaces/index.json, so it must bypass cowork
  // migration and indexed-workspace membership checks at this IPC boundary.
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return projectId;
  }
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  if (!isCoworkWorkspace(workspaceId)) {
    throw new Error(`Project ${workspaceId} is not a cowork project`);
  }
  return workspaceId;
}

async function waitForE2eWorkEntryDeletionFenceCheckpoint(): Promise<void> {
  if (!__CANOPY_E2E__) return;
  const rawDelay = process.env.CANOPY_E2E_WORK_ENTRY_DELETION_FENCE_DELAY_MS;
  if (!rawDelay) return;
  const delayMs = Number(rawDelay);
  if (!Number.isInteger(delayMs) || delayMs <= 0 || delayMs > 10_000) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function injectE2eProviderEventDuringWorkEntryTeardown(
  workspaceId: string,
  entryId: string,
): Promise<void> {
  if (!__CANOPY_E2E__) return;
  const chatId =
    process.env.CANOPY_E2E_WORK_ENTRY_DELETION_LATE_PROVIDER_CHAT_ID;
  if (!chatId) return;
  validateId(chatId, 'chatId');
  await getChatStateService().ingestProviderEvent({
    projectId: workspaceId,
    worktreeId: entryId,
    chatId,
    mutationId: `e2e-work-entry-delete-late-provider:${entryId}:${chatId}`,
    data: {
      type: 'claude_terminal_transcript_sync',
      messages: [
        {
          id: `${chatId}-late-provider-message`,
          role: 'assistant',
          blocks: [
            {
              type: 'text',
              text: 'Late provider output before deletion',
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
  });
}

/** Update a Work Entry using the existing main-process IPC lifecycle. */
export async function updateWorkEntryMutation(
  request: CoworkWorkEntryUpdateRequest,
): Promise<void> {
  const workspaceId = assertWorkEntryWorkspace(request.projectId);
  validateId(request.entryId, 'entryId');
  if (
    request.status !== undefined &&
    request.status !== 'active' &&
    request.status !== 'done'
  ) {
    throw new Error(`Invalid work entry status ${String(request.status)}`);
  }
  if (request.pinned !== undefined && typeof request.pinned !== 'boolean') {
    throw new Error('Invalid work entry pinned state');
  }
  await updateWorkEntry(workspaceId, request.entryId, {
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.status !== undefined ? { status: request.status } : {}),
    ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
  });

  if (workspaceId !== APP_ADVISOR_PROJECT_ID) {
    // Keep the large standalone-chat service graph off Electron startup;
    // work-entry handlers do not need it until cowork projection runs.
    const { emitStandaloneWorkEntrySummary } =
      await import('../services/standalone-chat-service');
    await emitStandaloneWorkEntrySummary(workspaceId, request.entryId);
  }

  // A rename or a mark-done is usually the LAST action on an entry, so no
  // subsequent turn will carry the new metadata to the server. Both feed the
  // Impact delivery track (linkage bonus from a ticket id in the title, done
  // bonus from the status), so push an envelope-only metadata refresh rather
  // than waiting for content that will never arrive. Fire-and-forget: the
  // registry write already succeeded and telemetry must not fail a local edit.
  // No-ops when telemetry sync is off.
  void getTelemetrySyncService()
    .refreshWorktreeMetadata(workspaceId, request.entryId)
    .catch(() => undefined);
  if (workspaceId === APP_ADVISOR_PROJECT_ID) {
    const { projectAppAdvisorChatSummaries } =
      await import('../services/chat-service');
    await projectAppAdvisorChatSummaries(request.entryId);
  }
}

/** Delete a Work Entry using the complete existing fenced IPC lifecycle. */
export async function deleteWorkEntryMutation(
  request: CoworkWorkEntryDeleteRequest,
): Promise<CoworkWorkEntryDeleteResponse> {
  const workspaceId = assertWorkEntryWorkspace(request.projectId);
  validateId(request.entryId, 'entryId');
  if (
    workspaceId === APP_ADVISOR_PROJECT_ID &&
    request.entryId === APP_ADVISOR_WORKTREE_ID
  ) {
    throw new Error('The legacy App Advisor global slot cannot be deleted');
  }
  const entries = await listWorkEntries(workspaceId);
  const entry = entries.find((candidate) => candidate.id === request.entryId);
  if (!entry) {
    throw new Error(`Unknown work entry ${request.entryId}`);
  }
  assertWorktreeCanBeRemoved(workspaceId, request.entryId);
  const retentionDays = await resolveContainerRetentionDays(workspaceId);
  let retained = false;
  let removedChatIds: string[] = [];
  let browserCleanupPending = false;
  const chatStateService = getChatStateService();
  const scope = {
    projectId: workspaceId,
    worktreeId: request.entryId,
  };
  // One fence holder, so another operation's release keeps this fence.
  const runDeletion = (operation: () => Promise<void>): Promise<void> =>
    runAsLocalFenceHolder(() =>
      chatStateService.runWithScopeDeletionLifecycle(scope, operation),
    );
  await runDeletion(async () => {
    const queueDeletion = getChatQueueService().beginWorktreeDeletion(
      workspaceId,
      request.entryId,
    );
    let queueDeletionCommitted = false;
    let sessionsDestroyed = false;
    let entryRowRemoved = false;
    // Defer the browser lifecycle module until deletion enters its fenced
    // transaction so ordinary work-entry IPC startup avoids Electron session work.
    const {
      prepareTaskBrowserRetirement,
      commitTaskBrowserRetirement,
      abortTaskBrowserRetirement,
    } = await import('../browser/browser-profile-lifecycle');
    let browserRetirement: string | null = null;
    try {
      browserRetirement = await prepareTaskBrowserRetirement(
        workspaceId,
        request.entryId,
      );
      await waitForE2eWorkEntryDeletionFenceCheckpoint();
      // Exercise the repository-write window used by provider teardown
      // callbacks: commands are fenced, but terminal event commits must still
      // land before session drain and archive capture.
      await injectE2eProviderEventDuringWorkEntryTeardown(
        workspaceId,
        request.entryId,
      );
      await destroyWorktreeSessions(workspaceId, request.entryId);
      sessionsDestroyed = true;
      await chatStateService.runWithScopeDeletion(scope, async () => {
        if (workspaceId !== APP_ADVISOR_PROJECT_ID) {
          const summaries = await listWorkEntryChatSummaries(workspaceId);
          removedChatIds =
            summaries
              .find((candidate) => candidate.entryId === request.entryId)
              ?.chats.map((chat) => chat.id) ?? [];
        }
        // Deletion retention is always on: every removal lands in the archive,
        // either as a "Deleted" item the sweep purges after `retentionDays` or
        // — when the caller asked to archive — as a locked "Archived" item
        // kept until the user deletes it.
        await captureWorkEntryArchivedContainer({
          workspaceId,
          entryId: request.entryId,
          entryTitle: entry.title,
          entryCreatedAt: entry.createdAt,
          retentionDays,
          ...(request.lockAfterArchive === true
            ? { lockAfterArchive: true }
            : {}),
        });
        retained = true;
        // Drain and drop this entry's telemetry queue, mirroring what code
        // worktrees do via `worktree-live-cleanup`. Newly load-bearing: a
        // `metaDirty` envelope has no collection items, so nothing else would
        // ever retire it — a mark-done followed by a delete would otherwise
        // leave an immortal queue entry that keeps uploading metadata for a
        // Work Entry that no longer exists locally.
        await getTelemetrySyncService()
          .drainWorktreeForDeletion(workspaceId, request.entryId)
          .catch(() => undefined);
        await cleanupPersistedWorktreeData(workspaceId, request.entryId, {
          chatSearchDisposition: retained ? 'container-archived' : 'delete',
          deferLocalWatcherCancellationCommit: true,
        });
        await removeWorkEntryRow(workspaceId, request.entryId);
        entryRowRemoved = true;
        notifyLedgerOfWorkEntryDeletion(workspaceId, entry, retained);
        schedulePortalStructuralSync();
        browserCleanupPending = await commitTaskBrowserRetirement(
          workspaceId,
          request.entryId,
        );
        // Defer the scheduler-backed service until this deletion reaches its
        // irreversible row-removal commit point.
        const { getAppAdvisorWatcherService } =
          await import('../app-advisor/watchers');
        await getAppAdvisorWatcherService().commitLocalScopeCancellation(
          workspaceId,
          request.entryId,
        );
      });
      queueDeletion.commit();
      queueDeletionCommitted = true;
    } catch (error) {
      // Defer the scheduler-backed service until rollback is necessary; the
      // work-entry IPC module otherwise has no watcher dependency.
      const { getAppAdvisorWatcherService } =
        await import('../app-advisor/watchers');
      if (!entryRowRemoved) {
        await abortTaskBrowserRetirement(browserRetirement);
        await getAppAdvisorWatcherService().releaseLocalScopeFence(
          workspaceId,
          request.entryId,
        );
      }
      throw error;
    } finally {
      if (!queueDeletionCommitted) {
        queueDeletion.rollback({ sessionsDestroyed });
      }
    }
  });
  if (workspaceId !== APP_ADVISOR_PROJECT_ID) {
    // Keep the large standalone-chat service graph off Electron startup;
    // work-entry handlers do not need it until cowork removal runs.
    const { emitStandaloneChatRemovals } =
      await import('../services/standalone-chat-service');
    emitStandaloneChatRemovals(workspaceId, removedChatIds);
  }
  if (retained) broadcastArchivedContainersChanged(workspaceId);
  return { browserCleanupPending };
}
