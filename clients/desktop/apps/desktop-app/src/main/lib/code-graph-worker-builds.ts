import { CodeGraphPreparingGenerations } from '@canopy/code-graph/host/worktree-build-service';
import {
  codeGraphBuildFailedError,
  codeGraphBuildRefusal,
  codeGraphScopeNotFoundError,
  codeGraphUnavailableError,
  codeGraphWorktreeBuildResult,
  codeGraphWorktreeGenerationStart,
} from '@canopy/core-runtime/node/code-graph';
import type {
  WorkerCodeGraphBuildParams,
  WorkerCodeGraphBuildResult,
} from '@canopy/protocol/canopy-core';
import { CODE_GRAPH_UNAVAILABLE_MESSAGE } from './code-graph-availability';
import {
  maintainCodeGraphBasesForWorkspace,
  requestCodeGraphBaseSummaryRepair,
  syncCodeGraphBaseRepositories,
  type CodeGraphBaseMaintenanceOutcome,
} from './code-graph-base-manager';
import { runWorktreeCodeGraphBuild } from './code-graph-build-service';
import {
  resolveRegisteredChatWorktree,
  resolveWorktreeCwd,
} from './resolve-worktree';
import { readAllSidebarItems } from './sidebar-items';
import { validateId } from './validation';
import { getSidebarItemsPreserveWorkspaceIds } from './sidebar-items-preservation';

/*
 * `worker.codeGraph.build` on Electron main (CAN-4149): a worktree build
 * through the build service, or a refresh, the periodic maintenance (CAN-5619)
 * or one repository's summary repair (CAN-5621) of the workspace base graphs
 * through the base manager. Both run through the build
 * scheduler's queue; failures become the operation's typed refusals. A
 * background worktree build (CAN-5617) keeps the scheduler's trigger and
 * observed fingerprint, so it is queued exactly as it was when the scheduler
 * called the build service itself.
 */

const TIMED_OUT = /timeout|timed out|exceeded .* ms/i;

type SidebarSnapshot = Awaited<ReturnType<typeof readAllSidebarItems>>;

/**
 * Refuses an invalid ID, or a workspace or worktree the host does not record,
 * before any build work, as the build channels do before they dispatch.
 */
async function resolveScope(
  workspaceId: string,
  worktreeId: string | null,
): Promise<SidebarSnapshot> {
  let target: { projectId: string; worktreeId: string | null };
  try {
    validateId(workspaceId, 'project id');
    if (worktreeId !== null) validateId(worktreeId, 'worktree id');
    // Plan-explore and code-review chats build under their own chat scope,
    // which borrows a real worktree through a registry; the sidebar records
    // the borrowed worktree. An unregistered chat scope throws.
    target =
      worktreeId === null
        ? { projectId: workspaceId, worktreeId: null }
        : resolveRegisteredChatWorktree(workspaceId, worktreeId);
  } catch {
    throw codeGraphScopeNotFoundError();
  }
  const snapshot = await readAllSidebarItems();
  const item = snapshot.items.find(
    (candidate) => candidate.id === target.projectId,
  );
  if (
    item === undefined ||
    item.type === 'cowork' ||
    (target.worktreeId !== null &&
      !item.worktrees.some((worktree) => worktree.id === target.worktreeId))
  ) {
    throw codeGraphScopeNotFoundError();
  }
  return snapshot;
}

const preparing = new CodeGraphPreparingGenerations();

/**
 * Stops the worktree's `worker.codeGraph.build` generations, including one
 * still resolving its scope or preparing seeds, so none queues a build
 * afterwards. Returns how many had not queued their build yet.
 */
export function abortPreparingCodeGraphBuilds(
  workspaceId: string,
  worktreeId: string,
): number {
  return preparing.abort(workspaceId, worktreeId);
}

function buildWorktree(
  scope: Extract<
    WorkerCodeGraphBuildParams['graphScope'],
    { kind: 'worktree' }
  >,
): Promise<WorkerCodeGraphBuildResult> {
  // Registered before anything else, so a cancel never misses it.
  return preparing.run(
    scope.workspaceId,
    scope.worktreeId,
    async (signal, queued) => {
      await resolveScope(scope.workspaceId, scope.worktreeId);
      let response: Awaited<ReturnType<typeof runWorktreeCodeGraphBuild>>;
      try {
        response = await runWorktreeCodeGraphBuild({
          projectId: scope.workspaceId,
          worktreeId: scope.worktreeId,
          ...codeGraphWorktreeGenerationStart(scope),
          signal,
          onQueued: queued,
        });
      } catch (error) {
        throw codeGraphBuildRefusal(error);
      }
      // The host's message stays here; the generation's local diagnostic
      // records its class and errno.
      if (!response.ok) {
        throw response.message === CODE_GRAPH_UNAVAILABLE_MESSAGE
          ? codeGraphUnavailableError()
          : codeGraphBuildFailedError('build_error');
      }
      return codeGraphWorktreeBuildResult(
        response.result,
        worktreeRoot(scope.workspaceId, scope.worktreeId),
      );
    },
  );
}

function worktreeRoot(workspaceId: string, worktreeId: string): string | null {
  try {
    return resolveWorktreeCwd(workspaceId, worktreeId);
  } catch {
    return null;
  }
}

function baseOutcome(
  outcome: CodeGraphBaseMaintenanceOutcome,
): 'built' | 'failed' | 'timed_out' | 'unavailable' {
  if (outcome.ok) return 'built';
  if (outcome.message === CODE_GRAPH_UNAVAILABLE_MESSAGE) return 'unavailable';
  if (outcome.message !== undefined && TIMED_OUT.test(outcome.message))
    return 'timed_out';
  return 'failed';
}

async function buildWorkspaceBases(
  scope: Extract<
    WorkerCodeGraphBuildParams['graphScope'],
    { kind: 'workspace_base' }
  >,
): Promise<WorkerCodeGraphBuildResult> {
  const { workspaceId } = scope;
  // Maintenance and summary repair work over the workspaces and
  // repositories the base manager already holds, which include ones the
  // last sidebar load preserved; a refresh checks and syncs the sidebar.
  if (scope.background === undefined) {
    const sidebarItems = await resolveScope(workspaceId, null);
    try {
      syncCodeGraphBaseRepositories(
        sidebarItems.items,
        new Set(getSidebarItemsPreserveWorkspaceIds(sidebarItems)),
      );
    } catch (error) {
      throw codeGraphBuildRefusal(error);
    }
  } else {
    try {
      validateId(workspaceId, 'project id');
    } catch {
      throw codeGraphScopeNotFoundError();
    }
  }
  const { background } = scope;
  let outcomes: CodeGraphBaseMaintenanceOutcome[];
  try {
    outcomes =
      background?.trigger === 'summary-repair'
        ? [
            await requestCodeGraphBaseSummaryRepair(
              workspaceId,
              background.repoId,
            ),
          ]
        : await maintainCodeGraphBasesForWorkspace(
            workspaceId,
            background === undefined
              ? { forceRefresh: true }
              : { maintenance: true },
          );
  } catch (error) {
    throw codeGraphBuildRefusal(error);
  }
  return {
    kind: 'workspace_base',
    repositories: outcomes.map((outcome) => ({
      repositoryId: outcome.repoId,
      outcome: baseOutcome(outcome),
    })),
  };
}

export function buildCodeGraph(
  graphScope: WorkerCodeGraphBuildParams['graphScope'],
): Promise<WorkerCodeGraphBuildResult> {
  return graphScope.kind === 'worktree'
    ? buildWorktree(graphScope)
    : buildWorkspaceBases(graphScope);
}
