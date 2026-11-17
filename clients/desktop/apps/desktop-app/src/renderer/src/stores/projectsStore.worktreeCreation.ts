import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError, type AppError } from '@canopy/protocol/app-errors';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { formatWorktreePrepareFailure } from '@canopy/ui-shared';
import { usePipelineRunsStore } from './pipelineRunsStore';
import type {
  ProjectsState,
  finalizeCreatedWorktree as FinalizeCreatedWorktree,
  drainPendingTaskBranchNaming as DrainPendingTaskBranchNaming,
  removeTemporaryWorkspaceFromUi as RemoveTemporaryWorkspaceFromUi,
} from './projectsStore';
import type { RefreshableWorktreeRef } from './projectsStore.diffStats';

/**
 * A rejected create keeps recognized and structured errors; an unclassified
 * one gets the authored next step. The rejection transport carries text only,
 * so no source reason is parsed from it here; setup events carry that reason.
 */
function createFailure(appError: AppError): InlineFailure {
  const failure = inlineFailure(
    appError,
    formatWorktreePrepareFailure({ hasDetails: true }),
  );
  return typeof failure.error === 'string' && failure.details === undefined
    ? { error: formatWorktreePrepareFailure({ hasDetails: false }) }
    : failure;
}

/** Presentation state only: execution and durable writes keep their existing host routes. */
export function createWorktreeCreationActions({
  get,
  set,
  finalizeCreatedWorktree,
  drainPendingTaskBranchNaming,
  removeTemporaryWorkspaceFromUi,
  refreshDiffStatsForWorktrees,
}: {
  get: () => ProjectsState;
  set: (state: Partial<ProjectsState>) => void;
  finalizeCreatedWorktree: typeof FinalizeCreatedWorktree;
  drainPendingTaskBranchNaming: typeof DrainPendingTaskBranchNaming;
  removeTemporaryWorkspaceFromUi: typeof RemoveTemporaryWorkspaceFromUi;
  refreshDiffStatsForWorktrees: (
    worktrees: RefreshableWorktreeRef[],
    options?: { skipFetch?: boolean },
  ) => Promise<boolean>;
}): Pick<
  ProjectsState,
  | 'createWorktree'
  | 'repairPendingWorkspaceWorktree'
  | 'combineWorktreeWithWorkspace'
  | 'combineWorktreeWithExistingWorktree'
> {
  const latestAttempts = new Map<string, symbol>();
  const beginAttempt = (key: string): { key: string; id: symbol } => {
    const attempt = Symbol();
    latestAttempts.set(key, attempt);
    set({ worktreeError: null });
    return { key, id: attempt };
  };
  const isCurrentAttempt = (attempt: { key: string; id: symbol }): boolean =>
    latestAttempts.get(attempt.key) === attempt.id;
  const finishAttempt = (attempt: { key: string; id: symbol }): void => {
    if (isCurrentAttempt(attempt)) latestAttempts.delete(attempt.key);
  };
  return {
    createWorktree: async (projectId, options) => {
      const item = get().projects.find((p) => p.id === projectId);
      if (!item || item.type === 'cowork') return undefined;
      const attempt = beginAttempt(JSON.stringify(['create', projectId]));

      // Immediately uncollapse and show loading placeholder
      const expanding = get().projects.map((p) => {
        if (p.id !== projectId) return p;
        return { ...p, collapsed: false };
      });
      const nextCreating = new Set(get().creatingWorktreeForProject);
      nextCreating.add(projectId);
      set({
        projects: expanding,
        creatingWorktreeForProject: nextCreating,
        worktreeError: null,
      });

      try {
        if (item.type === 'multi-repo') {
          const created = await window.api.createWorkspaceWorktree({
            workspaceId: projectId,
            existingWorktreeIds: item.worktrees.map((wt) => wt.id),
            ...(options?.worktreeId === undefined
              ? {}
              : { worktreeId: options.worktreeId }),
            sidebarItemGroupId: options?.sidebarItemGroupId,
            baseWorktreeId: options?.baseWorktreeId,
            baseBranch: options?.baseBranch,
            existingBranch: options?.existingBranch,
            branchName: options?.branchName,
            suggestedBranch: options?.suggestedBranch,
          });
          const doneCreating = new Set(get().creatingWorktreeForProject);
          doneCreating.delete(projectId);

          if (created.needsRepair) {
            set({
              creatingWorktreeForProject: doneCreating,
              pendingWorkspaceRepair: {
                workspaceId: projectId,
                workspaceName: item.name,
                id: created.id,
                branchName: created.branchName,
                repairIssues: created.repairIssues,
                existingBranch: created.existingBranch,
                trackedRepoBaseBranches: created.trackedRepoBaseBranches,
              },
            });
            return undefined;
          }

          set({
            creatingWorktreeForProject: doneCreating,
          });
          if (options?.sidebarItemGroupId) {
            const { useSidebarItemGroupsStore } =
              await import('./sidebarItemGroupsStore');
            useSidebarItemGroupsStore
              .getState()
              .confirmCreatedItem(
                { workspaceLocalId: projectId },
                options.sidebarItemGroupId,
                created.id,
              );
          }
          const finalized = await finalizeCreatedWorktree(
            projectId,
            created,
            get,
            set,
            {
              select: options?.select,
              onRegistered: options?.onRegistered,
              suppressStartPage: options?.suppressStartPage,
              eagerChat: !options?.existingBranch,
            },
          );
          return finalized
            ? {
                id: finalized.id,
                ...(finalized.setupPhase
                  ? { setupPhase: finalized.setupPhase }
                  : {}),
              }
            : undefined;
        }

        const created = await window.api.createWorktree({
          projectId,
          repoPath: item.repoPath,
          existingWorktreeIds: item.worktrees.map((wt) => wt.id),
          ...(options?.worktreeId === undefined
            ? {}
            : { worktreeId: options.worktreeId }),
          sidebarItemGroupId: options?.sidebarItemGroupId,
          baseWorktreeId: options?.baseWorktreeId,
          baseBranch: options?.baseBranch,
          existingBranch: options?.existingBranch,
          branchName: options?.branchName,
          suggestedBranch: options?.suggestedBranch,
        });
        const doneCreating = new Set(get().creatingWorktreeForProject);
        doneCreating.delete(projectId);
        set({
          creatingWorktreeForProject: doneCreating,
        });
        if (options?.sidebarItemGroupId) {
          const { useSidebarItemGroupsStore } =
            await import('./sidebarItemGroupsStore');
          useSidebarItemGroupsStore
            .getState()
            .confirmCreatedItem(
              { workspaceLocalId: projectId },
              options.sidebarItemGroupId,
              created.id,
            );
        }
        const finalized = await finalizeCreatedWorktree(
          projectId,
          created,
          get,
          set,
          {
            select: options?.select,
            onRegistered: options?.onRegistered,
            suppressStartPage: options?.suppressStartPage,
            eagerChat: !options?.existingBranch,
          },
        );
        return finalized
          ? {
              id: finalized.id,
              ...(finalized.setupPhase
                ? { setupPhase: finalized.setupPhase }
                : {}),
            }
          : undefined;
      } catch (error) {
        const doneCreating = new Set(get().creatingWorktreeForProject);
        doneCreating.delete(projectId);
        const appError = toAppError(resolveClientAppError(error));
        set({
          creatingWorktreeForProject: doneCreating,
          ...(isCurrentAttempt(attempt)
            ? {
                worktreeError: appError ? createFailure(appError) : null,
              }
            : {}),
        });
        return undefined;
      } finally {
        finishAttempt(attempt);
      }
    },
    repairPendingWorkspaceWorktree: async (restoreClaudeMd) => {
      const pending = get().pendingWorkspaceRepair;
      if (!pending) {
        return;
      }

      const attempt = beginAttempt(
        JSON.stringify(['repair', pending.workspaceId, pending.id]),
      );
      set({
        workspaceRepairPending: true,
        worktreeError: null,
      });

      try {
        const repaired = await window.api.repairWorkspaceWorktree({
          workspaceId: pending.workspaceId,
          worktreeId: pending.id,
          branchName: pending.branchName,
          ...(pending.existingBranch
            ? { existingBranch: pending.existingBranch }
            : {}),
          restoreClaudeMd,
          trackedRepoBaseBranches: pending.trackedRepoBaseBranches,
        });
        set({
          pendingWorkspaceRepair: null,
        });
        await finalizeCreatedWorktree(pending.workspaceId, repaired, get, set);
        // A deferred-creation needs-repair detour keeps the chat state for
        // this worktree id alive through the repair; main releases a turn it
        // held for the setup. Completing a retained creation also emits
        // `worktree:git-ready`; a repair without one does not, so kick the
        // pipeline flush here too. It is idempotent once drained.
        drainPendingTaskBranchNaming(pending.workspaceId, pending.id, get);
        void usePipelineRunsStore
          .getState()
          .flushPendingForWorktree(pending.workspaceId, pending.id);
      } catch (error) {
        const appError = toAppError(resolveClientAppError(error));
        if (appError && isCurrentAttempt(attempt))
          set({
            worktreeError: inlineFailure(
              appError,
              "Couldn't repair the project.",
            ),
          });
      } finally {
        finishAttempt(attempt);
        set({ workspaceRepairPending: false });
      }
    },
    combineWorktreeWithWorkspace: async (request) => {
      const attempt = beginAttempt(
        JSON.stringify([
          'join',
          request.sourceWorkspaceId,
          request.sourceWorktreeId,
        ]),
      );
      try {
        const response = await window.api.combineWorktreeWithWorkspace(request);
        // Refresh the sidebar so the renderer sees the destination workspace
        // (and the source worktree's removal, when `removedSourceWorktree`).
        await get().loadProjects({ silent: true });
        removeTemporaryWorkspaceFromUi(
          response.removedTemporaryWorkspaceId,
          get,
          set,
        );
        globalThis.setTimeout(() => {
          void refreshDiffStatsForWorktrees([
            {
              projectId: response.destinationWorkspaceId,
              worktreeId: response.destinationWorktreeId,
            },
          ]);
        }, 0);
        if (isCurrentAttempt(attempt)) set({ worktreeError: null });
        return response;
      } catch (error) {
        const appError = toAppError(resolveClientAppError(error));
        if (appError && isCurrentAttempt(attempt))
          set({
            worktreeError: inlineFailure(
              appError,
              "Couldn't combine projects.",
            ),
          });
        return undefined;
      } finally {
        finishAttempt(attempt);
      }
    },
    combineWorktreeWithExistingWorktree: async (request) => {
      const attempt = beginAttempt(
        JSON.stringify([
          'join',
          request.sourceWorkspaceId,
          request.sourceWorktreeId,
        ]),
      );
      try {
        const response =
          await window.api.combineWorktreeWithExistingWorktree(request);
        // Refresh the sidebar so the renderer sees the destination workspace
        // and both consumed worktrees' removal.
        await get().loadProjects({ silent: true });
        removeTemporaryWorkspaceFromUi(
          response.removedTemporaryWorkspaceId,
          get,
          set,
        );
        removeTemporaryWorkspaceFromUi(
          response.joinedWorktree.removedTemporaryWorkspaceId,
          get,
          set,
        );
        globalThis.setTimeout(() => {
          void refreshDiffStatsForWorktrees([
            {
              projectId: response.destinationWorkspaceId,
              worktreeId: response.destinationWorktreeId,
            },
          ]);
        }, 0);
        if (isCurrentAttempt(attempt)) set({ worktreeError: null });
        return response;
      } catch (error) {
        const appError = toAppError(resolveClientAppError(error));
        if (appError && isCurrentAttempt(attempt))
          set({
            worktreeError: inlineFailure(
              appError,
              "Couldn't join the worktree.",
            ),
          });
        return undefined;
      } finally {
        finishAttempt(attempt);
      }
    },
  };
}
