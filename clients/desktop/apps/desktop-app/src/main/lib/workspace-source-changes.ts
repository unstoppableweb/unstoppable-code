import type { SourceChangeGit } from '../canopy-runtime/worker-git-worktree-adapter';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { runW5BoundaryOperation } from './w5-boundary-operation';
import {
  checkW5CompositionRevisions,
  decodeW5CompositionOutcome,
  type W5CompositionOptions,
} from './w5-composition-operation';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from './w5-commit-log-file-store';
import { currentW5CommitScope, type W5CommitOptions } from './w5-commit-scope';
import {
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
  withStorageAdmission,
} from './w5-storage';
import { WorkspaceSourceChangesRefusedError } from './workspace-source-change-refusal';
import type {
  ProjectApplySourceChangesRequest,
  ProjectApplySourceChangesResponse,
  ProjectSourceChangesAppliedEvent,
  WorkspaceApplySourceChangesRequest,
  WorkspaceApplySourceChangesResponse,
  WorkspaceSourceChangesAppliedEvent,
} from '@canopy/desktop-shared/types';
import { applyProjectSourceChangesToWorktree } from './project-source-change-apply';
import { validateId } from './validation';
import { applyWorkspaceSourceChangesToWorktree } from './workspace-source-change-apply';
import { w5LifecycleReceiptCaller, type W5WireCall } from './w5-wire-call';

export {
  WorkspaceSourceChangesRefusedError,
  type WorkspaceSourceChangesRefusal,
} from './workspace-source-change-refusal';

/** Host hooks of a source change: the window for setup progress. */
interface SourceChangesHost<Event> {
  getWindow: () => BrowserWindow | null;
  git: SourceChangeGit;
  /** Called once `canopy.json` (and the instructions file) is written. */
  onApplied?: (event: Event) => void;
}

/**
 * `core.workspace.sourceChanges.apply` (CAN-3819): source-controlled settings
 * written to `canopy.json` in a worktree, an existing one or one created for
 * the change. A multi-repo workspace's change is applied in its root
 * worktree and can add or remove repositories; a single-repo project's in
 * its only checkout.
 */
export type WorkspaceSourceChangesRequest = W5CompositionOptions & {
  /** A registered wire call's receipt scope and admission (W7b-4). */
  wireCall?: W5WireCall;
} & (
    | ({
        kind: 'workspace';
        /** `workspace:apply-source-changes`. */
        source: 'workspace_settings';
        request: WorkspaceApplySourceChangesRequest;
      } & SourceChangesHost<WorkspaceSourceChangesAppliedEvent>)
    | ({
        kind: 'project';
        /** `project:apply-source-changes`. */
        source: 'project_settings';
        request: ProjectApplySourceChangesRequest;
      } & SourceChangesHost<ProjectSourceChangesAppliedEvent>)
  );

/** Foreground lifecycle only; background work never receives the receipt binding. */
export interface SourceChangesTransition<Result> {
  commit: W5CommitOptions;
  beforeEffects?: () => void;
  complete: (result: Result) => Promise<Result>;
}

const projectOutcomeSchema = z.object({
  worktreeId: z.string(),
  branchName: z.string(),
  createdWorktree: z.boolean(),
  referenceRepoPath: z.string().optional(),
});
const workspaceOutcomeSchema = projectOutcomeSchema.extend({
  localRepoBindingsUpdated: z.boolean(),
});

/**
 * The typed in-process `core.workspace.sourceChanges.apply` boundary
 * (CAN-3819). The caller keeps its own gates (the start page feature flag and,
 * for a workspace, the organization's repository sync around the apply).
 *
 * A target worktree created for the change is recorded by appending its row
 * to the list read under the list lock, so rows written while it was checked
 * out keep their state; a failed apply removes the checkout and the row, as
 * before. Repository bindings that follow the applied `canopy.json` are
 * written to the queued manifest before the invocation completes.
 * Refusals are {@link WorkspaceSourceChangesRefusedError}s with the existing
 * messages. Optional standalone revisions and retry keys record foreground
 * acceptance including binding publication, not completion of background
 * repository setup.
 * The operation stays unregistered.
 */
export function applySourceChanges(
  request: Extract<WorkspaceSourceChangesRequest, { kind: 'workspace' }>,
): Promise<WorkspaceApplySourceChangesResponse>;
export function applySourceChanges(
  request: Extract<WorkspaceSourceChangesRequest, { kind: 'project' }>,
): Promise<ProjectApplySourceChangesResponse>;
export async function applySourceChanges(
  request: WorkspaceSourceChangesRequest,
): Promise<
  WorkspaceApplySourceChangesResponse | ProjectApplySourceChangesResponse
> {
  const workspaceId =
    request.kind === 'workspace'
      ? request.request.workspaceId
      : request.request.projectId;
  validateId(
    workspaceId,
    request.kind === 'workspace' ? 'workspaceId' : 'projectId',
  );
  if (request.request.target.mode === 'existing')
    validateId(request.request.target.worktreeId, 'worktreeId');
  if (
    request.idempotencyKey === undefined &&
    request.expectedRevisions === undefined
  )
    return applySourceChangesAdmitted(request);
  if (currentW5CommitScope())
    throw new WorkspaceSourceChangesRefusedError(
      'invalid-request',
      'Standalone source-change revision or retry options cannot join a parent commit',
    );
  return runW5BoundaryOperation<
    WorkspaceApplySourceChangesResponse | ProjectApplySourceChangesResponse
  >(
    {
      operation: 'core.workspace.sourceChanges.apply',
      caller: w5LifecycleReceiptCaller(
        'workspace-source-changes',
        request.wireCall,
      ),
      idempotencyKey: request.idempotencyKey,
      admit: request.wireCall?.admit,
      // Admission may ask the organization over the network, so the storage
      // hold starts at the reservation: an ownership change never waits on it.
      hold: (run) =>
        withStorageAdmission(
          [WORKSPACE_MANIFEST_STORAGE, WORKTREE_LIST_STORAGE],
          run,
        ),
      parameters: {
        kind: request.kind,
        source: request.source,
        request: request.request,
      },
      recheckAtOutcome: true,
      isPreEffectRefusal: (error) =>
        error instanceof WorkspaceSourceChangesRefusedError ||
        error instanceof W5RevisionConflictError ||
        error instanceof W5FileWriteRefusedError,
    },
    (outcome) =>
      decodeW5CompositionOutcome(
        request.kind === 'workspace'
          ? workspaceOutcomeSchema
          : projectOutcomeSchema,
        outcome,
      ),
    async (commit, attempt, complete) => {
      commit.expectedRevisions = request.expectedRevisions;
      await checkW5CompositionRevisions(commit);
      return applySourceChangesAdmitted(request, {
        commit,
        beforeEffects: attempt?.beforeEffects,
        complete,
      });
    },
  );
}

async function applySourceChangesAdmitted(
  request: WorkspaceSourceChangesRequest,
  transition?: SourceChangesTransition<
    WorkspaceApplySourceChangesResponse | ProjectApplySourceChangesResponse
  >,
): Promise<
  WorkspaceApplySourceChangesResponse | ProjectApplySourceChangesResponse
> {
  if (request.kind === 'workspace') {
    const change = request.request;
    if (!transition)
      return applyWorkspaceSourceChangesToWorktree(
        change,
        request.getWindow,
        request.git,
        request.onApplied,
      );
    return applyWorkspaceSourceChangesToWorktree(
      change,
      request.getWindow,
      request.git,
      request.onApplied,
      {
        ...transition,
        complete: async (
          result,
        ): Promise<WorkspaceApplySourceChangesResponse> => {
          const saved = await transition.complete(result);
          return decodeW5CompositionOutcome(workspaceOutcomeSchema, saved);
        },
      },
    );
  }
  const change = request.request;
  if (!transition)
    return applyProjectSourceChangesToWorktree(
      change,
      request.getWindow,
      request.git,
      request.onApplied,
    );
  return applyProjectSourceChangesToWorktree(
    change,
    request.getWindow,
    request.git,
    request.onApplied,
    transition,
  );
}
