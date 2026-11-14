import { decodeW5WorktreeBranchRenameOutcome } from '@canopy/core-runtime/node/w5/worktree-outcome';
import {
  checkW5ExpectedRevision,
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  withW5Commit,
  W5RevisionConflictError,
} from './w5-commit-log-file-store';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { isBranchNameAvailable, validateBranchName } from './git';
import { w5RecordReadPaths, getWorkspaceWorktreeRepoDir } from './paths';
import { isWritableScope, READ_ONLY_SCOPE_ERROR } from './read-only-scope';
import { resolveWorktreeCwd } from './resolve-worktree';
import { validateId } from './validation';
import { WORKTREE_LIST_STORAGE, withStorageAdmission } from './w5-storage';
import { applyWorktreeBranchRenameDecision } from './worktree-branch-rename-decision-port';
import { w5LifecycleReceiptCaller, type W5WireCall } from './w5-wire-call';
import type { WorktreeBranchRenameDecision } from './worktree-record-decisions';

/**
 * The caller of a branch rename: the desktop renderer's branch dialogs today.
 * A closed set, so the later receipt (CAN-3805) can name it.
 */
export type WorktreeBranchRenameSource = 'desktop';

export interface WorktreeBranchRenameRequest extends W5BoundaryOptions {
  source: WorktreeBranchRenameSource;
  workspaceId: string;
  worktreeId: string;
  /**
   * The member repository whose branch is renamed, or the source-backed root;
   * absent for a single-repository worktree.
   */
  repoId?: string;
  newBranchName: string;
  /** A registered wire call's receipt scope and admission (W7b-4). */
  wireCall?: W5WireCall;
}

/**
 * The rename's one Git effect, injected so the command never runs Git
 * itself: `worker.git.branch.rename` on the desktop dispatcher today, and
 * the binding W5's daemon composition supplies later. It renames the current
 * branch of the checkout the ids name; a started rename is never aborted.
 */
export interface WorktreeBranchRenameGit {
  /** Publication after Git and metadata settle, before saving the keyed outcome. */
  onRenamed?: () => void;
  renameCheckoutBranch(
    this: void,
    target: { workspaceId: string; worktreeId: string; repoId?: string },
    newBranchName: string,
  ): Promise<void>;
}

export interface WorktreeBranchRenameOutcome {
  branchName: string;
  /** The persisted row after the rename. */
  worktree: WorktreeData | null;
}

export type WorktreeBranchRenameRefusal =
  | 'read-only-scope'
  | 'invalid-branch-name'
  | 'branch-unavailable'
  | 'not-found';

/**
 * The rename was refused. The name stays `Error`, so the message a renderer
 * sees is unchanged. A `not-found` refusal comes after the Git rename: the
 * branch was renamed, but the worktree has no row to record it on.
 */
export class WorktreeBranchRenameRefusedError extends Error {
  constructor(
    readonly reason: WorktreeBranchRenameRefusal,
    message: string,
  ) {
    super(message);
  }
}

function refuse(reason: WorktreeBranchRenameRefusal, message: string): never {
  throw new WorktreeBranchRenameRefusedError(reason, message);
}

function resolveRenameCheckout(request: WorktreeBranchRenameRequest): string {
  if (request.repoId && request.repoId !== WORKSPACE_ROOT_REPO_ID) {
    return getWorkspaceWorktreeRepoDir(
      request.workspaceId,
      request.worktreeId,
      request.repoId,
    );
  }
  return resolveWorktreeCwd(request.workspaceId, request.worktreeId);
}

/**
 * `core.worktree.branch.rename` (CAN-3820), the typed in-process command
 * behind `worktree:rename-branch`. Admission (ids, the read-only
 * shared-container scope, the repository id) runs before any Git work; the
 * branch name is checked through the existing Git helpers, unchanged, and the
 * checkout's branch renamed through the injected `git` port
 * (`worker.git.branch.rename`, CAN-5516); then the row is recorded under the
 * worktree list lock in one write, as a `worktree.branch.rename` decision
 * through the record decision port (W6f1): a root or single-repository rename
 * stores the sidebar `branchName`, and any rename clears the PR status, which
 * belonged to the old name. Optional keyed attempts reserve before Git and
 * save only the final outcome; repository locks cover metadata publication.
 * A failure after Git, including a missing row, keeps the rename and leaves a
 * keyed attempt recovery-required.
 */
export async function renameWorktreeBranch(
  request: WorktreeBranchRenameRequest,
  git: WorktreeBranchRenameGit,
): Promise<WorktreeBranchRenameOutcome> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], async () => {
    const { workspaceId, worktreeId, repoId, newBranchName } = request;
    validateId(workspaceId, 'workspaceId');
    if (!isWritableScope(workspaceId)) {
      refuse('read-only-scope', READ_ONLY_SCOPE_ERROR);
    }
    validateId(worktreeId, 'worktreeId');
    if (repoId !== undefined && repoId !== WORKSPACE_ROOT_REPO_ID) {
      validateId(repoId, 'repoId');
    }

    const { expectedRevision, idempotencyKey, wireCall, ...parameters } =
      request;
    return runW5BoundaryOperation(
      {
        operation: 'core.worktree.branch.rename',
        caller: w5LifecycleReceiptCaller(request.source, wireCall),
        idempotencyKey,
        parameters,
        admit: wireCall?.admit,
        isPreEffectRefusal: (error) =>
          error instanceof WorktreeBranchRenameRefusedError ||
          error instanceof W5RevisionConflictError,
      },
      decodeW5WorktreeBranchRenameOutcome,
      async (options, attempt) => {
        await checkW5ExpectedRevision(
          { kind: 'worktree', workspaceId, worktreeId },
          expectedRevision,
        );
        const checkout = resolveRenameCheckout(request);
        if (!(await validateBranchName(checkout, newBranchName))) {
          refuse(
            'invalid-branch-name',
            `Invalid branch name: "${newBranchName}"`,
          );
        }
        if (!(await isBranchNameAvailable(checkout, newBranchName))) {
          refuse(
            'branch-unavailable',
            `Branch name "${newBranchName}" is already in use`,
          );
        }
        attempt?.beforeEffects();
        await git.renameCheckoutBranch(
          {
            workspaceId,
            worktreeId,
            ...(repoId === undefined ? {} : { repoId }),
          },
          newBranchName,
        );
        async function stageRenamedWorktree(): Promise<WorktreeBranchRenameOutcome> {
          const decision: WorktreeBranchRenameDecision = {
            kind: 'worktree.branch.rename',
            branchName: newBranchName,
            updatesSidebarBranch:
              repoId === undefined || repoId === WORKSPACE_ROOT_REPO_ID,
          };
          const recorded = await applyWorktreeBranchRenameDecision(
            { workspaceId, worktreeId },
            decision,
          );
          if (recorded.status === 'not-found') {
            refuse(
              'not-found',
              `Worktree metadata not found for ${workspaceId}/${worktreeId}`,
            );
          }
          return { branchName: newBranchName, worktree: recorded.worktree };
        }
        try {
          const outcome = await withW5Commit(
            {
              ...options,
              locks: [
                {
                  kind: 'list',
                  path: w5RecordReadPaths.worktrees(workspaceId),
                },
              ],
              expectedRevisions: w5ExpectedRevision(
                { kind: 'worktree', workspaceId, worktreeId },
                expectedRevision,
              ),
            },
            stageRenamedWorktree,
          );
          git.onRenamed?.();
          return outcome;
        } catch (error) {
          // Git succeeded even if the row disappeared before publication.
          if (
            error instanceof WorktreeBranchRenameRefusedError &&
            error.reason === 'not-found'
          )
            git.onRenamed?.();
          throw error;
        }
      },
    );
  });
}
