import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { assertWorktreeCanBeRemoved } from '../agents/background-work';
import {
  buildSessionKey,
  destroyWorktreeSessions,
  getActiveSessionInfos,
  markSessionTeardownCause,
} from '../agents/session-manager';
import { notifyLedgerContainerArchived } from '../ledger/lifecycle';
import { workEntryLedgerIncarnation } from '../ledger/lifecycle-containers';
import { getChatQueueService } from '../services/chat-queue-service';
import { getChatStateService } from '../services/chat-state-service';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { captureWorkEntryArchivedContainer } from './archived-container-capture';
import { resolveContainerRetentionDays } from './archived-container-retention';
import {
  broadcastArchivedContainersChanged,
  withArchivedWorkspaceOperationLock,
} from './archived-containers';
import { listWorkEntries, removeWorkEntryRow } from './cowork-work-entries';
import { cleanupPersistedWorktreeData } from './worktree-data-cleanup';
import { validateId } from './validation';
import { WorkspaceTargetAutoArchiveExcludedError } from './workspace-target-exclusion';
import { scheduleDesktopStructureChanged } from '../services/desktop-structure-signal';
import { runWithWorkspaceTargetActivityDeletion } from './workspace-activity';
import { runAsLocalFenceHolder } from '../app-advisor/local-fence-holder';

export interface ArchiveWorkEntryOptions {
  workspaceId: string;
  entryId: string;
  /** Fail before any destructive cleanup if retention cannot be prepared. */
  requireArchivedContainer?: boolean;
  lockAfterArchive?: boolean;
  expectedCreatedAt?: string;
  expectedLastTouchedAt?: string;
  revalidateAutoArchivePolicy?: () => Promise<{
    deleteBranch?: boolean;
  }>;
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

/**
 * Tells the Ledger that a Bot or Cowork Work Entry was archived with
 * retention or permanently deleted, so its scope becomes read-only or retires.
 * Call only after the entry row is irreversibly removed. The participant
 * returns at once, so no deletion lock is held while it waits on storage.
 */
function notifyLedgerOfWorkEntryArchive(
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

async function archiveWorkEntryWithoutOperationLock({
  workspaceId,
  entryId,
  requireArchivedContainer = false,
  lockAfterArchive,
  expectedCreatedAt,
  expectedLastTouchedAt,
  revalidateAutoArchivePolicy,
}: ArchiveWorkEntryOptions): Promise<{
  retained: boolean;
  warnings: string[];
}> {
  validateId(workspaceId, 'workspaceId');
  validateId(entryId, 'entryId');
  if (
    // Default Bot only: protect its legacy global work-entry slot.
    workspaceId === APP_ADVISOR_PROJECT_ID &&
    entryId === APP_ADVISOR_WORKTREE_ID
  ) {
    throw new Error('The legacy App Advisor global slot cannot be deleted');
  }

  const entries = await listWorkEntries(workspaceId);
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    throw new Error(`Unknown work entry ${entryId}`);
  }
  if (
    expectedCreatedAt !== undefined &&
    entry.createdAt !== expectedCreatedAt
  ) {
    throw new WorkspaceTargetAutoArchiveExcludedError(
      'The work entry identity changed before deletion',
    );
  }
  // Active agent/workflow work keeps its Work Entry until it has stopped.
  assertWorktreeCanBeRemoved(workspaceId, entryId);
  if (
    (expectedLastTouchedAt !== undefined || revalidateAutoArchivePolicy) &&
    entry.lastTouchedAt !== expectedLastTouchedAt
  ) {
    throw new WorkspaceTargetAutoArchiveExcludedError(
      'Auto Delete eligibility changed before deletion',
    );
  }
  await revalidateAutoArchivePolicy?.();
  const retentionDays = await resolveContainerRetentionDays(workspaceId);
  if (requireArchivedContainer && retentionDays === null) {
    throw new Error(
      'Cannot delete this Work Entry because deletion retention is unavailable.',
    );
  }

  let retained = false;
  const warnings: string[] = [];
  const chatStateService = getChatStateService();
  const scope = { projectId: workspaceId, worktreeId: entryId };
  await chatStateService.runWithScopeDeletionLifecycle(scope, async () => {
    const queueDeletion = getChatQueueService().beginWorktreeDeletion(
      workspaceId,
      entryId,
    );
    let queueDeletionCommitted = false;
    let sessionsDestroyed = false;
    let entryRowRemoved = false;
    try {
      await waitForE2eWorkEntryDeletionFenceCheckpoint();
      await injectE2eProviderEventDuringWorkEntryTeardown(workspaceId, entryId);
      // Quiesce the runtime first so the capture observes the final persisted
      // transcript and telemetry state. A capture failure still leaves the live
      // row and all persisted entry data intact; only ephemeral sessions stop.
      try {
        for (const session of getActiveSessionInfos(workspaceId, entryId)) {
          try {
            markSessionTeardownCause(
              buildSessionKey(workspaceId, entryId, session.chatId),
              'archive',
            );
          } catch {
            // Cause bookkeeping is best-effort and cannot block archival.
          }
        }
      } catch {
        // Cause bookkeeping is best-effort and cannot block archival.
      }
      await destroyWorktreeSessions(workspaceId, entryId);
      sessionsDestroyed = true;
      await chatStateService.runWithScopeDeletion(scope, async () => {
        await getTelemetrySyncService()
          .drainWorktreeForDeletion(workspaceId, entryId)
          .catch(() => undefined);
        if (retentionDays !== null) {
          await captureWorkEntryArchivedContainer({
            workspaceId,
            entryId,
            entryTitle: entry.title,
            entryCreatedAt: entry.createdAt,
            retentionDays,
            lockAfterArchive,
          });
          retained = true;
        }
        const cleanup = await cleanupPersistedWorktreeData(
          workspaceId,
          entryId,
          {
            chatSearchDisposition: retained ? 'container-archived' : 'delete',
            deferLocalWatcherCancellationCommit: true,
          },
        );
        warnings.push(...(cleanup ?? []));
        await removeWorkEntryRow(workspaceId, entryId);
        entryRowRemoved = true;
        notifyLedgerOfWorkEntryArchive(workspaceId, entry, retained);
        // Commit scheduler-backed watcher cancellation only after deletion
        // reaches its irreversible row-removal point.
        const { getAppAdvisorWatcherService } =
          await import('../app-advisor/watchers');
        await getAppAdvisorWatcherService().commitLocalScopeCancellation(
          workspaceId,
          entryId,
        );
        scheduleDesktopStructureChanged('structural.work-entry-archive');
      });
      queueDeletion.commit();
      queueDeletionCommitted = true;
    } catch (error) {
      const { getAppAdvisorWatcherService } =
        await import('../app-advisor/watchers');
      if (!entryRowRemoved) {
        await getAppAdvisorWatcherService().releaseLocalScopeFence(
          workspaceId,
          entryId,
        );
      }
      throw error;
    } finally {
      if (!queueDeletionCommitted) {
        queueDeletion.rollback({ sessionsDestroyed });
      }
    }
  });
  if (!isBotProjectId(workspaceId)) {
    // Keep the large standalone-chat service graph off Electron startup;
    // work-entry archival does not need it until cowork removal runs.
    const { emitStandaloneChatRemovals } =
      await import('../services/standalone-chat-service');
    emitStandaloneChatRemovals();
  }
  if (retained) broadcastArchivedContainersChanged(workspaceId);
  return { retained, warnings };
}

/** Automatic Work Entry archive operation. */
export async function archiveWorkEntry(
  options: ArchiveWorkEntryOptions,
): Promise<{ retained: boolean; warnings: string[] }> {
  return getChatStateService().runWithScopeDeletionLifecycle(
    { projectId: options.workspaceId, worktreeId: options.entryId },
    () =>
      runWithWorkspaceTargetActivityDeletion(
        options.workspaceId,
        options.entryId,
        () =>
          withArchivedWorkspaceOperationLock(options.workspaceId, () =>
            runAsLocalFenceHolder(() =>
              archiveWorkEntryWithoutOperationLock(options),
            ),
          ),
      ),
  );
}
