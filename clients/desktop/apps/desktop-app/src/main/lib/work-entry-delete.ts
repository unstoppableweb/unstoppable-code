import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { destroyWorktreeSessions } from '../agents/session-manager';
import {
  listWorkEntries,
  listWorkEntryChatSummaries,
  removeWorkEntryRow,
  workEntryRegistryExists,
} from './cowork-work-entries';
import { assertWorktreeCanBeRemoved } from '../agents/background-work';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { cleanupPersistedWorktreeData } from './worktree-data-cleanup';
import { validateId } from './validation';
import {
  broadcastArchivedContainersChanged,
  isArchivedWorkspaceOperationLockHeld,
  withArchivedWorkspaceOperationLock,
} from './archived-containers';
import { resolveContainerRetentionDays } from './archived-container-retention';
import { captureWorkEntryArchivedContainer } from './archived-container-capture';
import { getChatStateService } from '../services/chat-state-service';
import { getChatQueueService } from '../services/chat-queue-service';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { notifyLedgerContainerArchived } from '../ledger/lifecycle';
import { workEntryLedgerIncarnation } from '../ledger/lifecycle-containers';
import { runAsLocalFenceHolder } from '../app-advisor/local-fence-holder';
import { KeyedAsyncLock } from './keyed-async-lock';
import { logMainProcessError } from './main-process-logging';

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
  } catch (error) {
    // Startup reconciliation can settle a failed Ledger notification.
    logMainProcessError('Could not notify Ledger of Work Entry removal', error);
  }
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

interface WorkEntryDeletionRequest {
  workspaceId: string;
  entryId: string;
  lockAfterArchive?: boolean;
}

async function preflightWorkEntryDeletion({
  workspaceId,
  entryId,
}: WorkEntryDeletionRequest): Promise<{
  workspaceId: string;
  entryId: string;
  entry: Awaited<ReturnType<typeof listWorkEntries>>[number];
  retentionDays: number;
}> {
  validateId(workspaceId, 'workspaceId');
  validateId(entryId, 'entryId');
  if (
    workspaceId === APP_ADVISOR_PROJECT_ID &&
    entryId === APP_ADVISOR_WORKTREE_ID
  ) {
    throw new Error('The legacy App Advisor global slot cannot be deleted');
  }
  const entries = await listWorkEntries(workspaceId, { strictRead: true });
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    throw new Error(`Unknown work entry ${entryId}`);
  }
  assertWorktreeCanBeRemoved(workspaceId, entryId);
  const retentionDays = await resolveContainerRetentionDays(workspaceId);
  return { workspaceId, entryId, entry, retentionDays };
}

type DeletionPreflight = Awaited<ReturnType<typeof preflightWorkEntryDeletion>>;
export type WorkEntryDeletionRetirement = DeletionPreflight;
interface RetirementState {
  consumed: boolean;
  rowRemoved: boolean;
  operationId: string | null;
}
const deletionPreparations = new KeyedAsyncLock();
const preparedDeletions = new WeakMap<
  WorkEntryDeletionRetirement,
  RetirementState
>();

/**
 * Both manual callers enter here before any archive lock. Serialize ownership
 * through settlement so sibling Portal requests can re-resolve an archived row
 * without adopting (or aborting) the first caller's pending retirement.
 */
export async function withWorkEntryDeletionRetirement<T>(
  request: WorkEntryDeletionRequest,
  operation: (
    retirement: WorkEntryDeletionRetirement | undefined,
  ) => Promise<T>,
  revalidate?: () => Promise<boolean>,
  /** Runs right before the entry's live browser views are disposed; a throw
   * aborts the prepared retirement. Remote callers recheck authorization. */
  beforeDispose?: () => void,
): Promise<T> {
  if (isArchivedWorkspaceOperationLockHeld(request.workspaceId))
    throw new Error(
      'Work Entry retirement must be prepared before the archive lock.',
    );
  return deletionPreparations.run(
    JSON.stringify([request.workspaceId, request.entryId]),
    async () => {
      if (revalidate && !(await revalidate())) return operation(undefined);
      const context = await preflightWorkEntryDeletion(request);
      return withWorkEntryDeletionLifecycle(
        request.workspaceId,
        request.entryId,
        async () => {
          const state: RetirementState = {
            consumed: false,
            rowRemoved: false,
            operationId: null,
          };
          const {
            prepareTaskBrowserRetirement,
            abortTaskBrowserRetirement,
            commitTaskBrowserRetirement,
          } = await import('../browser/browser-profile-lifecycle');
          let operationId: string | null = null;
          let prepared = false;
          try {
            // Preflight/lifecycle can await. Portal must still authorize the
            // captured target immediately before browser disposal.
            if (revalidate && !(await revalidate()))
              return await operation(undefined);
            operationId = await (beforeDispose
              ? prepareTaskBrowserRetirement(
                  request.workspaceId,
                  request.entryId,
                  context.entry.createdAt,
                  beforeDispose,
                )
              : prepareTaskBrowserRetirement(
                  request.workspaceId,
                  request.entryId,
                  context.entry.createdAt,
                ));
            state.operationId = operationId;
            prepared = true;
            preparedDeletions.set(context, state);
            const result = await operation(context);
            return result;
          } finally {
            preparedDeletions.delete(context);
            if (!state.rowRemoved) {
              let releaseScopeFence = !prepared;
              try {
                if (prepared) {
                  await withArchivedWorkspaceOperationLock(
                    request.workspaceId,
                    async () => {
                      // A missing registry reads as empty, which would look
                      // like removal. It proves neither a live owner nor
                      // removal, so neither commit nor abort: keep the
                      // retirement and its fence pending for recovery.
                      if (!(await workEntryRegistryExists(request.workspaceId)))
                        return;
                      const current = (
                        await listWorkEntries(request.workspaceId, {
                          strictRead: true,
                        })
                      ).find((entry) => entry.id === request.entryId);
                      if (current?.createdAt === context.entry.createdAt) {
                        releaseScopeFence = true;
                        // Abort only our exclusive operation; repository incarnation
                        // validation prevents touching a replacement's task slot.
                        if (operationId)
                          await abortTaskBrowserRetirement(operationId);
                      } else {
                        state.rowRemoved = true;
                        // The captured incarnation is gone, including on an
                        // already-archived no-op or a replacement. Settle only
                        // its operation; never reopen the removed scope.
                        await commitTaskBrowserRetirement(
                          request.workspaceId,
                          request.entryId,
                          'owner_removed',
                          operationId,
                        ).catch((error: unknown) =>
                          logMainProcessError(
                            'Work Entry browser retirement remains pending',
                            error,
                          ),
                        );
                      }
                    },
                  );
                }
              } finally {
                const { getAppAdvisorWatcherService } =
                  await import('../app-advisor/watchers');
                // An unreadable registry proves neither a live owner nor
                // removal. Keep retirement and its fence for recovery.
                if (releaseScopeFence && !state.rowRemoved)
                  await getAppAdvisorWatcherService().releaseLocalScopeFence(
                    request.workspaceId,
                    request.entryId,
                  );
              }
            }
          }
        },
      );
    },
  );
}

/** Existing single-writer archive/delete boundary shared by IPC and Portal. */
export async function deleteWorkEntry({
  workspaceId,
  entryId,
  lockAfterArchive,
  retirement,
  beforeTeardown,
  confirmBeforeCommit,
}: WorkEntryDeletionRequest & {
  retirement?: WorkEntryDeletionRetirement;
  /**
   * Async confirmation right before the archive commit (capture, then the
   * telemetry drain, live-data deletion and row removal). Remote callers
   * confirm their pairing with the server here. A throw aborts before
   * anything is written, so there is nothing to roll back.
   */
  confirmBeforeCommit?: () => Promise<void>;
  /**
   * Runs after the archive lock wait and the last registry read, before any
   * teardown, and again after the session drain and chat summary read, right
   * before the archive capture that starts the commit sequence; a throw
   * aborts there. Remote callers recheck authorization here. When this call
   * prepares its own retirement, it also runs right before the entry's
   * browser views are disposed.
   */
  beforeTeardown?: () => void;
}): Promise<{ browserCleanupPending: boolean }> {
  if (!retirement) {
    return withWorkEntryDeletionRetirement(
      { workspaceId, entryId },
      async (prepared) => {
        if (!prepared)
          throw new Error(
            'Work Entry deletion requires retirement preparation.',
          );
        return deleteWorkEntry({
          workspaceId,
          entryId,
          lockAfterArchive,
          retirement: prepared,
          ...(beforeTeardown ? { beforeTeardown } : {}),
          ...(confirmBeforeCommit ? { confirmBeforeCommit } : {}),
        });
      },
      undefined,
      beforeTeardown,
    );
  }
  const retirementState = preparedDeletions.get(retirement);
  if (
    !retirementState ||
    retirementState.consumed ||
    retirement.workspaceId !== workspaceId ||
    retirement.entryId !== entryId
  )
    throw new Error('Invalid or already consumed Work Entry retirement.');
  retirementState.consumed = true;
  const { entry, retentionDays } = retirement;
  let retained = false;
  let removedChatIds: string[] = [];
  const chatStateService = getChatStateService();
  const scope = {
    projectId: workspaceId,
    worktreeId: entryId,
  };
  // One fence holder, so another operation's release keeps this fence.
  return withArchivedWorkspaceOperationLock(workspaceId, async () => {
    const current = (
      await listWorkEntries(workspaceId, { strictRead: true })
    ).find((candidate) => candidate.id === entryId);
    if (!current || current.createdAt !== entry.createdAt) {
      throw new Error('The Work Entry changed before deletion.');
    }
    beforeTeardown?.();
    // Close-blocking work can start while this waits for the archive lock;
    // refuse it here, before teardown would interrupt it.
    assertWorktreeCanBeRemoved(workspaceId, entryId);
    const queueDeletion = getChatQueueService().beginWorktreeDeletion(
      workspaceId,
      entryId,
    );
    let sessionsDestroyed = false;
    try {
      await waitForE2eWorkEntryDeletionFenceCheckpoint();
      // Exercise the repository-write window used by provider teardown
      // callbacks: commands are fenced, but terminal event commits must
      // still land before session drain and archive capture.
      await injectE2eProviderEventDuringWorkEntryTeardown(workspaceId, entryId);
      // Session teardown stops running turns but destroys no persisted data:
      // transcripts stay and chats resume. So the next recheck runs after the
      // whole drain, before the first data step, rather than per session.
      await destroyWorktreeSessions(workspaceId, entryId);
      sessionsDestroyed = true;
      await chatStateService.runWithScopeDeletion(scope, async () => {
        if (workspaceId !== APP_ADVISOR_PROJECT_ID) {
          const summaries = await listWorkEntryChatSummaries(workspaceId);
          removedChatIds =
            summaries
              .find((candidate) => candidate.entryId === entryId)
              ?.chats.map((chat) => chat.id) ?? [];
        }
        // Last checks, after the drain and summary read and right before the
        // archive commit: the server confirms the pairing, then the local
        // check runs again. Archive capture, telemetry drain, live-data
        // deletion and row removal then run as one commit sequence, so a
        // refusal never leaves an archive copy to undo.
        if (confirmBeforeCommit) await confirmBeforeCommit();
        beforeTeardown?.();
        // Deletion retention is always on: every removal lands in the
        // archive, either as a "Deleted" item the sweep purges after
        // `retentionDays` or — when the caller asked to archive — as a
        // locked "Archived" item kept until the user deletes it.
        await captureWorkEntryArchivedContainer({
          workspaceId,
          entryId: entryId,
          entryTitle: entry.title,
          entryCreatedAt: entry.createdAt,
          retentionDays,
          ...(lockAfterArchive === true ? { lockAfterArchive: true } : {}),
        });
        retained = true;
        // From here the live data is deleted, so the archive is kept even if
        // a later step fails: it is then the only copy, and a retry resumes.
        // Drain and drop this entry's telemetry queue, mirroring what code
        // worktrees do via `worktree-live-cleanup`. Newly load-bearing: a
        // `metaDirty` envelope has no collection items, so nothing else would
        // ever retire it — a mark-done followed by a delete would otherwise leave
        // an immortal queue entry that keeps uploading metadata for a Work Entry
        // that no longer exists locally.
        await getTelemetrySyncService()
          .drainWorktreeForDeletion(workspaceId, entryId)
          .catch(() => undefined);
        await cleanupPersistedWorktreeData(workspaceId, entryId, {
          chatSearchDisposition: retained ? 'container-archived' : 'delete',
          deferLocalWatcherCancellationCommit: true,
        });
        await removeWorkEntryRow(workspaceId, entryId);
        retirementState.rowRemoved = true;
      });
    } catch (error) {
      if (!retirementState.rowRemoved) throw error;
      logMainProcessError(
        'Work Entry scope cleanup failed after removal',
        error,
      );
    } finally {
      if (!retirementState.rowRemoved)
        queueDeletion.rollback({ sessionsDestroyed });
    }

    // The registry removal is the commit point. Settle the queue and publish
    // the committed removal before the independent cleanup participants run.
    try {
      queueDeletion.commit();
    } catch (error) {
      logMainProcessError(
        'Could not settle the removed Work Entry queue',
        error,
      );
    }
    notifyLedgerOfWorkEntryDeletion(workspaceId, entry, retained);
    try {
      schedulePortalStructuralSync();
    } catch (error) {
      logMainProcessError(
        'Could not schedule the Work Entry removal sync',
        error,
      );
    }
    if (workspaceId !== APP_ADVISOR_PROJECT_ID) {
      try {
        // Load the standalone-chat service only for Cowork removal.
        const { emitStandaloneChatRemovals } =
          await import('../services/standalone-chat-service');
        emitStandaloneChatRemovals(workspaceId, removedChatIds);
      } catch (error) {
        logMainProcessError('Could not publish standalone chat removal', error);
      }
    }
    if (retained) {
      try {
        broadcastArchivedContainersChanged(workspaceId);
      } catch (error) {
        logMainProcessError('Could not publish Archived list changes', error);
      }
    }

    let browserCleanupPending = true;
    try {
      const { commitTaskBrowserRetirement } =
        await import('../browser/browser-profile-lifecycle');
      browserCleanupPending = await commitTaskBrowserRetirement(
        workspaceId,
        entryId,
        'owner_removed',
        retirementState.operationId,
      );
    } catch (error) {
      logMainProcessError(
        'Work Entry browser retirement remains pending',
        error,
      );
    }
    try {
      const { getAppAdvisorWatcherService } =
        await import('../app-advisor/watchers');
      await getAppAdvisorWatcherService().commitLocalScopeCancellation(
        workspaceId,
        entryId,
      );
    } catch (error) {
      logMainProcessError(
        'Could not finish Work Entry watcher cancellation',
        error,
      );
    }
    return { browserCleanupPending };
  });
}

/** Close and drain chat activity before taking an archive/restore lock. */
export function withWorkEntryDeletionLifecycle<T>(
  workspaceId: string,
  entryId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return runAsLocalFenceHolder(() =>
    getChatStateService().runWithScopeDeletionLifecycle(
      { projectId: workspaceId, worktreeId: entryId },
      operation,
    ),
  );
}
