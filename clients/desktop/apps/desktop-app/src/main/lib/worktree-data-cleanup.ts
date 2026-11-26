import {
  beginDirectoryDeletion,
  directoryRemovalOutcome,
  drainDirectoryEffects,
} from './directory-effect-admission';
import { destructiveStep } from './w5-destructive-recovery';
import { rm } from 'node:fs/promises';
import { assertCodeReviewStorageWriter } from './code-review-storage-admission';
import { join } from 'node:path';
import { removeEntryCost } from '../cost-index/lifecycle';
import { getCodeGraphWorktreeService } from '@canopy/desktop-shared/node/code-graph/service';
import { cancelBuild } from '../code-graph/build-runner';
import {
  cancelCodeGraphReads,
  fenceCodeGraphReads,
} from '../code-graph/read-runner';
import { cancelCodeGraphFingerprint } from '../code-graph/fingerprint-runner';
import { cancelCodeGraphBuilds } from './code-graph-scheduler';
import { purgePersistedWorktreeObservabilityData } from '../observability/worktree-cleanup';
import { clearRemoteControlPrTracking } from '../services/pr-creation-progress';
import { clearPrMergeTracking } from '../services/pr-merge-progress';
import { cleanupWorktreeChatPluginDirs } from '../plugins/plugin-cleanup';
import { getBrowserService } from '../browser/browser-service-registry';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import { terminalPersistenceStore } from '../terminal/persistence';
import {
  BrowserRetirementTimeoutError,
  withBrowserRetirementDeadline,
} from './browser-retirement-deadline';
import { logMainProcessWarn } from './main-process-logging';
import { deleteHookRunLogsForWorktree } from './hook-log-store';
import {
  getWorktreeBrowserStateFilePath,
  getWorktreeAttachmentsDir,
  getWorktreeDataRootDir,
  getWorktreeSummaryFilePath,
} from './paths';
import { deleteDetectedPlansForWorktree } from './detected-plan-persistence';
import {
  deleteTrackedPlansForWorktree,
  listTrackedPlans,
} from './plan-persistence';
import { deleteScriptRunLogsForWorktree } from './script-log-store';
import { deleteSplitPrMapForWorktree } from './split-pr-persistence';
import { getChatSearchService } from '../chat-search/service';
import { validateId } from './validation';
import { getWorktreeItemStore } from './worktree-item-store';
import { getChatStateService } from '../services/chat-state-service';
import { releaseCodeReviewTasks } from './code-review-deletion-fence';
import { runAsLocalFenceHolder } from '../app-advisor/local-fence-holder';

interface CleanupTask {
  label: string;
  /** Resolves with any non-fatal warnings the task wants surfaced. */
  run: () => Promise<void | string[]>;
}

export interface CleanupPersistedWorktreeDataOptions {
  observabilityMode?: 'persisted-only' | 'live-service';
  chatSearchDisposition?: 'delete' | 'container-archived';
  deferLocalWatcherCancellationCommit?: boolean;
  /** The parent workspace activates its captured retirement after W5 commits. */
  deferTerminalRecordRetirement?: boolean;
  purgeObservabilityData?: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
}

interface NormalizedCleanupPersistedWorktreeDataOptions {
  observabilityMode: 'persisted-only' | 'live-service';
  chatSearchDisposition: 'delete' | 'container-archived';
  deferTerminalRecordRetirement: boolean;
  purgeObservabilityData?: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
}

async function waitForE2eDeletionFenceCheckpoint(): Promise<void> {
  if (!__CANOPY_E2E__) return;
  const rawDelay = process.env.CANOPY_E2E_WORKTREE_CLEANUP_FENCE_DELAY_MS;
  if (!rawDelay) return;
  const delayMs = Number(rawDelay);
  if (!Number.isInteger(delayMs) || delayMs <= 0 || delayMs > 10_000) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && code.trim().length > 0 ? code : null;
}

function sanitizeCleanupErrorMessage(message: string): string {
  return message
    .trim()
    .replace(/'\/[^'\n]+'/g, "'<path>'")
    .replace(/"\/[^"\n]+"/g, '"<path>"');
}

function buildCleanupWarning(label: string, error: unknown): string {
  const code = getErrorCode(error);
  let detail = 'unknown error';

  switch (code) {
    case 'EACCES':
      detail = 'permission denied';
      break;
    case 'EBUSY':
      detail = 'resource busy or locked';
      break;
    case 'ENOENT':
      detail = 'path not found';
      break;
    case 'EPERM':
      detail = 'operation not permitted';
      break;
    case 'EROFS':
      detail = 'read-only file system';
      break;
    case 'EXDEV':
      detail = 'cross-device operation not permitted';
      break;
    case 'ENOTEMPTY':
      detail = 'directory not empty';
      break;
    case 'ETXTBSY':
      detail = 'file is busy because it is being executed';
      break;
    default:
      if (error instanceof Error && error.message.trim().length > 0) {
        detail = sanitizeCleanupErrorMessage(error.message);
      } else if (typeof error === 'string' && error.trim().length > 0) {
        detail = sanitizeCleanupErrorMessage(error);
      }
      break;
  }

  return `Failed to remove ${label} for this worktree: ${detail}`;
}

function buildCleanupTasks(
  projectId: string,
  worktreeId: string,
  options: NormalizedCleanupPersistedWorktreeDataOptions,
): CleanupTask[] {
  return [
    {
      label: 'chat state',
      run: (): Promise<void> =>
        getChatStateService().deleteScope({ projectId, worktreeId }),
    },
    {
      label: 'chat search index',
      run: (): Promise<void> => {
        if (options.chatSearchDisposition === 'container-archived') {
          return getChatSearchService().worktreeContainerArchived(
            projectId,
            worktreeId,
          );
        } else {
          return getChatSearchService().deleteWorktreeDocs(
            projectId,
            worktreeId,
          );
        }
      },
    },
    {
      label: 'worktree summary',
      run: (): Promise<void> =>
        rm(getWorktreeSummaryFilePath(projectId, worktreeId), {
          force: true,
        }),
    },
    {
      label: 'entry cost',
      run: (): Promise<void> => removeEntryCost(projectId, worktreeId),
    },
    {
      label: 'attachments',
      run: (): Promise<void> =>
        rm(getWorktreeAttachmentsDir(projectId, worktreeId), {
          recursive: true,
          force: true,
        }),
    },
    {
      label: 'browser tab state',
      run: async (): Promise<void> => {
        // Keep browser lifecycle/session initialization out of ordinary cleanup
        // planning; load it only when this destructive task actually executes.
        const { retireRemovedBrowserTask } =
          await import('../browser/browser-profile-lifecycle');
        // Profile metadata that fails or never answers must not keep live
        // views or tab state for a removed worktree; startup reconciliation
        // retires the profile later. An archive runs this under its project
        // lock, so an unbounded wait here would hold every later archive.
        const retirement = await withBrowserRetirementDeadline(() =>
          retireRemovedBrowserTask(projectId, worktreeId),
        ).then(
          () => null,
          (error: unknown) => ({ error }),
        );
        await getBrowserService()?.destroyWorktree(projectId, worktreeId, {
          clearStorage: false,
          deletingTarget: true,
        });
        await rm(getWorktreeBrowserStateFilePath(projectId, worktreeId), {
          force: true,
        });
        if (!retirement) return;
        // A timeout is not a failed removal: tab state is gone, the abandoned
        // retirement still finishes once metadata answers, an archive reports
        // its own retirement, and startup reconciliation retries the rest.
        if (retirement.error instanceof BrowserRetirementTimeoutError) {
          logMainProcessWarn(
            'Worktree cleanup deferred browser profile retirement',
            { operation: 'worktree_data_cleanup', code: retirement.error.code },
          );
          return;
        }
        throw retirement.error instanceof Error
          ? retirement.error
          : new Error(String(retirement.error));
      },
    },
    {
      // Must run before the 'worktree metadata' recursive rm below: a live
      // DatabaseSync for this worktree's code-graph db holds open file
      // descriptors, and closing it here first avoids racing that removal
      // (mirrors the 'browser state and storage' task's close-before-rm
      // placement). Canceling the off-main worker build must run BEFORE
      // that close, in turn: a live build worker (see
      // `code-graph/build-runner.ts`) holds its OWN DatabaseSync connection
      // to this same graph.db and may be mid-write, so closing (or removing)
      // around a still-running worker would race a write in progress from a
      // different process.
      label: 'code graph engine',
      run: async (): Promise<void> => {
        // Cancel any pending/in-flight scheduled build FIRST. Without this a
        // debounced build queued at worktree creation (5s window) can fire
        // after cleanup has closed the engine and rm -rf'd worktree-data,
        // resurrecting graph.db for the just-deleted worktree via the cached
        // open engine. Cancelling clears the timer and suppresses any
        // in-flight build's refire before we close.
        cancelCodeGraphBuilds(projectId, worktreeId);
        // Kills this worktree's read workers, busy or idle, and awaits their
        // exit, including one already shutting down after its idle timeout.
        await cancelCodeGraphReads(`${projectId}/${worktreeId}`);
        await cancelCodeGraphFingerprint(`${projectId}/${worktreeId}`);
        // Directly cancel AND AWAIT the off-main worker build for this
        // worktree. `cancelCodeGraphBuilds` above already fires this same
        // worker cancel unconditionally (its composition covers tool-routed
        // builds too — the runner key is shared), but that path is a
        // synchronous fire-and-forget that discards the exit wait. This
        // direct call is what actually waits (bounded) for the killed worker
        // process to EXIT — for a key the earlier cancel already settled,
        // the runner hands back the still-pending exit wait rather than
        // resolving vacuously — so the worker's own DatabaseSync fds on
        // graph.db are released before the close and the worktree-metadata
        // rm below. It also keeps this ordering testable here with the
        // scheduler module mocked away. Keys with no live worker and no
        // pending exit resolve immediately.
        await cancelBuild(`${projectId}/${worktreeId}`);
        // And the builds this app sent to the daemon (CAN-5089), which write
        // the same graph under the same lease. Deferred: the route pulls in
        // the daemon connection.
        const { drainDaemonCodeGraphWorktree } =
          await import('../code-graph/daemon-code-graph-route');
        await drainDaemonCodeGraphWorktree(projectId, worktreeId);
        await getCodeGraphWorktreeService().closeWorktree(
          projectId,
          worktreeId,
        );
      },
    },
    {
      label: 'legacy review chats',
      run: async (): Promise<string[]> => {
        // Deferred to keep cleanup module evaluation from starting the review
        // scheduler; packaged build coverage verifies this main-process chunk.
        const { drainCodeReviewForDeletion } =
          await import('./code-review-scheduler');
        await drainCodeReviewForDeletion(projectId, worktreeId);
        if (options.chatSearchDisposition === 'container-archived') return [];
        // Deferred with the scheduler import above so merely importing the
        // cleanup registry does not initialize review-chat services.
        const { removeCodeReviewChatsForWorktree } =
          await import('./code-review-cleanup');
        return removeCodeReviewChatsForWorktree(projectId, worktreeId);
      },
    },
    {
      label: 'tracked plans',
      run: async (): Promise<string[]> => {
        // Deferred on purpose: the explore cleanup pulls in the live session
        // and terminal teardown services; importing the cleanup helpers alone
        // must not initialize them.
        const {
          releasePlanFileSyncForWorktree,
          removePlanExploreChatsForWorktree,
        } = await import('./plan-explore-cleanup');
        if (options.chatSearchDisposition === 'container-archived') {
          // The archive keeps the legacy plan chats, like its review chats:
          // purging the archive reclaims them from its captured plan ids.
          releasePlanFileSyncForWorktree(projectId, worktreeId);
          await deleteTrackedPlansForWorktree(projectId, worktreeId);
          return [];
        }
        // Plan-explore chat scopes are keyed by tracked plan id, so read the
        // ids BEFORE the plans file that lists them is removed. Scopes whose
        // plans file cannot be resolved (cowork sentinels) still get the
        // registry sweep; the rm below reports the unresolvable path.
        let planIds: string[] = [];
        try {
          planIds = (await listTrackedPlans(projectId, worktreeId)).map(
            (plan) => plan.id,
          );
        } catch {
          planIds = [];
        }
        const warnings = await removePlanExploreChatsForWorktree(
          projectId,
          worktreeId,
          planIds,
        );
        await deleteTrackedPlansForWorktree(projectId, worktreeId);
        return warnings;
      },
    },
    {
      label: 'detected plans',
      run: (): Promise<void> =>
        deleteDetectedPlansForWorktree(projectId, worktreeId),
    },
    {
      label: 'script run logs',
      run: (): Promise<void> =>
        deleteScriptRunLogsForWorktree(projectId, worktreeId),
    },
    {
      label: 'split map',
      run: (): Promise<void> =>
        deleteSplitPrMapForWorktree(projectId, worktreeId),
    },
    {
      label: 'hook run logs',
      run: (): Promise<void> =>
        deleteHookRunLogsForWorktree(projectId, worktreeId),
    },
    {
      label: 'worktree metadata',
      run: async (): Promise<void> => {
        assertCodeReviewStorageWriter(
          'code_review_state',
          'main/lib/worktree-data-cleanup',
        );
        // Cancel a layout save still in its debounce window right before the
        // removal: its timer would otherwise recreate panel-layout.json under
        // the removed tree. Earlier cleanup tasks can run for seconds, so an
        // earlier cancel would miss saves that arrive while they run. Only the
        // timer is cancelled; the retrying tree removal deletes the file.
        if (!options.deferTerminalRecordRetirement)
          await terminalPersistenceStore.retireTerminalRecord({
            projectId,
            worktreeId,
          });
        panelLayoutPersistenceStore.cancelPendingWrite(projectId, worktreeId);
        await drainDirectoryEffects(
          join(getWorktreeDataRootDir(projectId), worktreeId),
        );
        return getWorktreeItemStore().purge({
          scope: 'worktree',
          workspaceId: projectId,
          worktreeId,
        });
      },
    },
    {
      label: 'chat plugin state',
      run: (): Promise<void> =>
        Promise.resolve(cleanupWorktreeChatPluginDirs(projectId, worktreeId)),
    },
    {
      label: 'agent observability records',
      run: async (): Promise<void> => {
        // This task covers all worktree-scoped observability artifacts:
        // audit entries, transcript sidecars, and session diagnostics.
        // Global app diagnostics are intentionally excluded because they never
        // store worktree identifiers and are retention-only.
        if (options.observabilityMode === 'live-service') {
          const purgeObservabilityData = options.purgeObservabilityData;
          if (!purgeObservabilityData) {
            throw new Error(
              'live-service observability cleanup requires a purge implementation',
            );
          }

          await purgeObservabilityData(projectId, worktreeId);
          return;
        }

        // A running service's unwritten session diagnostics, such as the
        // record of this cleanup's scope cancellation, go with the purge.
        // Peek rather than get: this purge never brings the service up.
        const { peekObservabilityService } = await import('../observability');
        const liveService = peekObservabilityService();
        if (liveService) {
          await liveService.purgePersistedWorktreeData(projectId, worktreeId);
          return;
        }
        await purgePersistedWorktreeObservabilityData(projectId, worktreeId);
      },
    },
  ];
}

export async function cleanupPersistedWorktreeData(
  projectId: string,
  worktreeId: string,
  options?: CleanupPersistedWorktreeDataOptions,
): Promise<string[]> {
  validateId(worktreeId, 'worktreeId');
  const path = join(getWorktreeDataRootDir(projectId), worktreeId);
  const directory = beginDirectoryDeletion(path);
  try {
    // Parent workspace deletion retains its wider exclusion until commit classification.
    if (options?.deferLocalWatcherCancellationCommit)
      return await cleanupPersistedWorktreeDataAsHolder(
        projectId,
        worktreeId,
        options,
      );
    return await runAsLocalFenceHolder(() =>
      cleanupPersistedWorktreeDataAsHolder(projectId, worktreeId, options),
    );
  } finally {
    directory.settle(
      options?.deferTerminalRecordRetirement
        ? 'abandoned'
        : await directoryRemovalOutcome(path),
    );
  }
}

async function cleanupPersistedWorktreeDataAsHolder(
  projectId: string,
  worktreeId: string,
  options?: CleanupPersistedWorktreeDataOptions,
): Promise<string[]> {
  validateId(worktreeId, 'worktreeId');
  // Defer the scheduler-backed service until destructive cleanup begins;
  // importing cleanup helpers alone must not initialize watcher processes.
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  const watcherService = getAppAdvisorWatcherService();
  const scope = { projectId, worktreeId };
  let worktreeDataRemoved = false;
  // From here until the worktree's data is gone, no request may start a
  // code-graph reader for it: the 'code graph engine' task awaits the readers
  // that exist, and the fence keeps a new one from opening graph.db behind
  // that wait and racing the metadata removal.
  const releaseCodeGraphReadFence = fenceCodeGraphReads(
    `${projectId}/${worktreeId}`,
  );
  try {
    await watcherService.cancelLocalScope(projectId, worktreeId);
    const warnings = await getChatStateService().runWithScopeDeletion(
      scope,
      async () => {
        // Synchronous map cleanup: drop the worktree's main-side portal PR
        // tracking (creation feed + last projected payload) so deleted worktrees
        // do not pin entries for the process lifetime (CAN-1528 L2).
        clearRemoteControlPrTracking(projectId, worktreeId);
        clearPrMergeTracking(projectId, worktreeId);
        const normalizedOptions: NormalizedCleanupPersistedWorktreeDataOptions =
          {
            observabilityMode: options?.observabilityMode ?? 'persisted-only',
            chatSearchDisposition: options?.chatSearchDisposition ?? 'delete',
            deferTerminalRecordRetirement:
              options?.deferTerminalRecordRetirement ?? false,
            purgeObservabilityData: options?.purgeObservabilityData,
          };
        const tasks = buildCleanupTasks(
          projectId,
          worktreeId,
          normalizedOptions,
        );
        const metadataTaskIndex = tasks.findIndex(
          (task) => task.label === 'worktree metadata',
        );
        const beforeMetadataTasks =
          metadataTaskIndex === -1
            ? tasks
            : tasks.filter((_, index) => index !== metadataTaskIndex);
        const metadataTasks =
          metadataTaskIndex === -1 ? [] : [tasks[metadataTaskIndex]];

        const cleanupWarnings: string[] = [];
        cleanupWarnings.push(...(await runCleanupTasks(beforeMetadataTasks)));
        // UI automation uses this checkpoint after the live chat sidecars have
        // been removed but while the outer scope-deletion fence is still held.
        // That makes a late renderer flush deterministic without changing any
        // production build: `__CANOPY_E2E__` is compile-time false outside E2E.
        await waitForE2eDeletionFenceCheckpoint();
        cleanupWarnings.push(...(await runCleanupTasks(metadataTasks)));

        return cleanupWarnings;
      },
    );
    worktreeDataRemoved = true;
    if (!options?.deferLocalWatcherCancellationCommit) {
      await watcherService.commitLocalScopeCancellation(projectId, worktreeId);
    }
    return warnings;
  } catch (error) {
    if (!worktreeDataRemoved) {
      await watcherService.releaseLocalScopeFence(projectId, worktreeId);
    }
    throw error;
  } finally {
    releaseCodeGraphReadFence();
    releaseCodeReviewTasks(projectId, worktreeId);
  }
}

async function runCleanupTasks(tasks: CleanupTask[]): Promise<string[]> {
  const results = await Promise.allSettled(
    tasks.map(async (task) => ({
      label: task.label,
      result: await destructiveStep(`sidecar:${task.label}`, task.run, {
        bestEffort: true,
      }),
    })),
  );

  const warnings: string[] = [];
  results.forEach((result, index) => {
    if (result.status !== 'rejected') {
      if (Array.isArray(result.value.result)) {
        warnings.push(...result.value.result);
      }
      return;
    }

    const task = tasks[index];
    warnings.push(buildCleanupWarning(task.label, result.reason));
  });

  return warnings;
}
