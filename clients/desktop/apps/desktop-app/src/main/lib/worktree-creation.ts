import { assertSharedMultiRepoWorkReady } from './org-shared-multi-repo-readiness';
import { z } from 'zod';
import { withW5Commit } from './w5-commit-log-file-store';
import { w5RecordReadPaths } from './paths';
import { runKeyedW5Operation } from './w5-keyed-operation';
import type {
  CreateWorkspaceWorktreeResponse,
  CreateWorktreeResponse,
  WorkspaceWorktreeRepairIssue,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { isWritableScope, READ_ONLY_SCOPE_ERROR } from './read-only-scope';
import { validateId, IdentifierValidationError } from './validation';
import {
  projectWorktreeCreationSelection,
  refuseWorktreeCreation,
  WorktreeCreationRefusedError,
  resolveWorktreeCreationSelection,
  type WorktreeBaseSelection,
  type WorktreeBranchSelection,
  type WorktreeCreationWorkspaceKind,
  type WorktreeSelectionFields,
} from './worktree-creation-selection';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
  type CreateWorktreeServiceOptions,
} from './worktree-service';

/**
 * The host lifecycle a creation runs with: deferred Git setup, post-create
 * setup scripts, readiness callbacks, repair handling and sidebar grouping.
 * These stay in the existing host and worker seam.
 */
export type WorktreeCreationLifecycle = Omit<
  CreateWorktreeServiceOptions,
  keyof WorktreeSelectionFields | 'workspaceId' | 'w5KeyedCreation'
>;

/** The trusted host callers that record keyed worktree creation receipts. */
export type WorktreeCreationCallerSource =
  | 'worktree-selection'
  | 'pipeline-host'
  | 'agent-chat'
  | 'app-advisor';

export interface WorktreeCreationRequest<
  Kind extends WorktreeCreationWorkspaceKind = WorktreeCreationWorkspaceKind,
> extends WorktreeCreationLifecycle {
  workspaceId: string;
  idempotencyKey?: string;
  /**
   * The trusted host caller a keyed receipt is recorded under, as
   * `desktop-host:<source>`. Defaults to `worktree-selection`. Never part of
   * the service request or the fingerprint.
   */
  callerSource?: WorktreeCreationCallerSource;
  /**
   * A keyed wire call's receipt caller (W7b-3), derived from its principal;
   * replaces `desktop-host:<callerSource>`. Never part of the fingerprint.
   */
  receiptCaller?: string;
  /**
   * Called when a keyed create returns its saved outcome instead of creating.
   * Never part of the service request or the fingerprint.
   */
  onKeyedReplay?: () => void;
  /** The workspace kind the caller resolved; a mismatch is refused. */
  workspaceKind: Kind;
  branch: WorktreeBranchSelection;
  base: WorktreeBaseSelection;
}

/**
 * The persisted fields a creation owns, as typed values: the row the create
 * commits, read back the same way.
 */
export interface WorktreeCreationRecord {
  worktreeId: string;
  branchName: string;
  createdAt: string;
  /** `git-pending` while deferred Git setup runs; an absent phase is ready. */
  setupPhase: 'git-pending' | 'git-ready';
  trackedBaseBranch: string | null;
  trackedRepoBaseBranches: Record<string, string>;
  /** Null means every repository of a multi-repository workspace. */
  includedRepoIds: string[] | null;
}

export interface SingleRepoWorktreeCreationOutcome {
  status: 'created';
  workspaceKind: 'single-repo';
  record: WorktreeCreationRecord;
  /** The compatibility response the IPC and Portal adapters return. */
  response: CreateWorktreeResponse;
}

export type MultiRepoWorktreeCreationOutcome =
  | {
      status: 'created';
      workspaceKind: 'multi-repo';
      record: WorktreeCreationRecord;
      response: CreateWorkspaceWorktreeResponse;
    }
  | {
      /**
       * A synchronous creation found the workspace root needs repair and
       * retained its reservation for explicit recovery.
       */
      status: 'needs-repair';
      workspaceKind: 'multi-repo';
      worktreeId: string;
      branchName: string;
      repairIssues: WorkspaceWorktreeRepairIssue[];
      response: CreateWorkspaceWorktreeResponse;
    };

export type WorktreeCreationOutcome =
  | SingleRepoWorktreeCreationOutcome
  | MultiRepoWorktreeCreationOutcome;

/** The typed creation record of a persisted worktree row. */
export function projectWorktreeCreationRecord(
  worktree: WorktreeData,
): WorktreeCreationRecord {
  return {
    worktreeId: worktree.id,
    branchName: worktree.branchName,
    createdAt: worktree.createdAt,
    setupPhase: worktree.setupPhase ?? 'git-ready',
    trackedBaseBranch: worktree.trackedBaseBranch ?? null,
    trackedRepoBaseBranches: { ...worktree.trackedRepoBaseBranches },
    includedRepoIds: worktree.includedRepoIds
      ? [...worktree.includedRepoIds]
      : null,
  };
}

const createdReceiptSchema = z.object({
  status: z.literal('created'),
  workspaceKind: z.enum(['single-repo', 'multi-repo']),
  record: z.object({
    worktreeId: z.string(),
    branchName: z.string(),
    createdAt: z.string(),
    setupPhase: z.enum(['git-pending', 'git-ready']),
    trackedBaseBranch: z.string().nullable(),
    trackedRepoBaseBranches: z.record(z.string(), z.string()),
    includedRepoIds: z.array(z.string()).nullable(),
  }),
  response: z.object({
    id: z.string(),
    branchName: z.string(),
    createdAt: z.string(),
    setupPhase: z.enum(['git-pending', 'git-ready']).optional(),
    trackedBaseBranch: z.string().nullable().optional(),
    trackedRepoBaseBranches: z.record(z.string(), z.string()).optional(),
  }),
});

const repairIssuesSchema = z.array(
  z.object({
    code: z.enum([
      'missing-gitignore',
      'invalid-gitignore',
      'missing-canopy-json',
      'invalid-canopy-json',
      'missing-claude-md',
      'invalid-agents-md',
    ]),
    message: z.string(),
    blocking: z.boolean(),
  }),
);
const worktreeReceiptSchema = z.union([
  createdReceiptSchema,
  z.object({
    status: z.literal('needs-repair'),
    workspaceKind: z.literal('multi-repo'),
    worktreeId: z.string(),
    branchName: z.string(),
    repairIssues: repairIssuesSchema,
    response: z.object({
      id: z.string(),
      branchName: z.string(),
      existingBranch: z.string().optional(),
      trackedRepoBaseBranches: z.record(z.string(), z.string()).optional(),
      needsRepair: z.literal(true),
      repairIssues: repairIssuesSchema,
    }),
  }),
]);

function admitCreation(
  request: WorktreeCreationRequest,
): CreateWorktreeServiceOptions {
  const { workspaceId, workspaceKind, branch, base, ...lifecycle } = request;
  // Keyed-boundary controls: never service options or fingerprint parameters.
  delete lifecycle.idempotencyKey;
  delete lifecycle.callerSource;
  delete lifecycle.receiptCaller;
  delete lifecycle.onKeyedReplay;
  validateId(workspaceId, 'workspaceId');
  if (!isWritableScope(workspaceId)) {
    refuseWorktreeCreation('read-only-scope', READ_ONLY_SCOPE_ERROR);
  }
  if (workspaceKind === 'single-repo' && lifecycle.includedRepoIds) {
    refuseWorktreeCreation(
      'invalid-repository-selection',
      'includedRepoIds is only supported for multi-repository projects',
    );
  }
  // Re-resolving the projected selection refuses a variant the workspace
  // kind cannot honor and normalizes the branch names.
  const selection = resolveWorktreeCreationSelection(
    projectWorktreeCreationSelection({ branch, base }),
    workspaceKind,
  );
  return {
    ...lifecycle,
    workspaceId,
    ...projectWorktreeCreationSelection(selection),
  };
}

/**
 * The typed in-process worktree creation boundary (CAN-3810). The renderer's
 * single- and multi-repository creates go through it, and the service entry
 * points it calls run the same selection admission for every other caller.
 * Admission (ids, the read-only shared-container scope, the branch and base
 * selection for the workspace kind) runs before anything is read or
 * reserved. The service then reserves the id and commits a leading
 * `git-pending` row. Git setup, post-create setup and cleanup run in the
 * existing host and worker seam. The reservation commit checks an optional
 * worktrees collection revision. Keyed calls keep their durable reservation
 * through synchronous setup. The final response is saved after setup, or with
 * the needs-repair row removal. Deferred calls save their returned pending
 * outcome; later readiness and
 * repair remain lifecycle effects, and replay never restarts them (CAN-3814).
 */
export async function createWorktreeFromSelection(
  request: WorktreeCreationRequest<'single-repo'>,
): Promise<SingleRepoWorktreeCreationOutcome>;
export async function createWorktreeFromSelection(
  request: WorktreeCreationRequest<'multi-repo'>,
): Promise<MultiRepoWorktreeCreationOutcome>;
export async function createWorktreeFromSelection(
  request: WorktreeCreationRequest,
): Promise<WorktreeCreationOutcome>;
export async function createWorktreeFromSelection(
  request: WorktreeCreationRequest,
): Promise<WorktreeCreationOutcome> {
  const options = admitCreation(request);
  if (request.workspaceKind === 'multi-repo')
    await assertSharedMultiRepoWorkReady(request.workspaceId);
  if (request.idempotencyKey !== undefined) {
    const parameters = {
      workspaceId: options.workspaceId,
      workspaceKind: request.workspaceKind,
      branchName: options.branchName,
      existingBranch: options.existingBranch,
      existingBranchRepoPaths: options.existingBranchRepoPaths,
      suggestedBranch: options.suggestedBranch,
      baseBranch: options.baseBranch,
      baseBranchIsQualified: options.baseBranchIsQualified,
      baseWorktreeId: options.baseWorktreeId,
      baseBranchesByRepo: options.baseBranchesByRepo,
      includedRepoIds: options.includedRepoIds,
      sidebarItemGroupId: options.sidebarItemGroupId,
      allowBaseBranchNetwork: options.allowBaseBranchNetwork,
      repairWorkspaceRoot: options.repairWorkspaceRoot,
      restoreClaudeMd: options.restoreClaudeMd,
      startPostCreateSetup: options.startPostCreateSetup,
      seedPanelLayoutMode: options.seedPanelLayoutMode,
      surfaceNeedsRepairInResponse: options.surfaceNeedsRepairInResponse,
      deferGitSetup: options.deferGitSetup,
      // Undefined parameters are omitted from the fingerprint, so receipts
      // of callers that keep the timestamped default are unchanged.
      defaultBranchNaming: options.defaultBranchNaming,
    };
    return runKeyedW5Operation(
      {
        caller:
          request.receiptCaller ??
          `desktop-host:${request.callerSource ?? 'worktree-selection'}`,
        operation: 'core.worktree.create',
        idempotencyKey: request.idempotencyKey,
        parameters,
        isPreEffectRefusal: (error) =>
          error instanceof WorktreeCreationRefusedError ||
          error instanceof IdentifierValidationError,
        onReplay: request.onKeyedReplay,
      },
      (outcome) => worktreeReceiptSchema.parse(outcome),
      async (binding, attempt) => {
        const keyedOptions: CreateWorktreeServiceOptions = {
          ...options,
          w5KeyedCreation: {
            attempt,
            operationId: binding.reservationId,
            commitRepairOutcome: (response, record) =>
              withW5Commit(
                {
                  ...binding,
                  locks: [
                    {
                      kind: 'list',
                      path: w5RecordReadPaths.worktrees(options.workspaceId),
                    },
                  ],
                  outcome: worktreeReceiptSchema.parse(
                    projectMultiRepoOutcome(response, options),
                  ),
                },
                record,
              ),
          },
        };
        const outcome = worktreeReceiptSchema.parse(
          await createAdmittedWorktree(keyedOptions, request.workspaceKind),
        );
        // Repair retains its recovery row and records the outcome in one decision.
        // Success is decided only after the service has built its final response;
        // no canonical write remains, so finish with a receipt-only decision.
        if (outcome.status === 'created')
          await withW5Commit({ ...binding, outcome }, async () => {});
        return outcome;
      },
    );
  }
  return createAdmittedWorktree(options, request.workspaceKind);
}

async function createAdmittedWorktree(
  options: CreateWorktreeServiceOptions,
  workspaceKind: WorktreeCreationWorkspaceKind,
): Promise<WorktreeCreationOutcome> {
  if (workspaceKind === 'single-repo') {
    const response = await createSingleRepoWorktree(options);
    return {
      status: 'created',
      workspaceKind: 'single-repo',
      record: {
        worktreeId: response.id,
        branchName: response.branchName,
        createdAt: response.createdAt,
        setupPhase: response.setupPhase ?? 'git-ready',
        trackedBaseBranch: response.trackedBaseBranch ?? null,
        trackedRepoBaseBranches: {},
        includedRepoIds: null,
      },
      response,
    };
  }

  return projectMultiRepoOutcome(
    await createMultiRepoWorktree(options),
    options,
  );
}

function projectMultiRepoOutcome(
  response: CreateWorkspaceWorktreeResponse,
  options: CreateWorktreeServiceOptions,
): MultiRepoWorktreeCreationOutcome {
  if (response.needsRepair === true) {
    return {
      status: 'needs-repair',
      workspaceKind: 'multi-repo',
      worktreeId: response.id,
      branchName: response.branchName,
      repairIssues: response.repairIssues,
      response,
    };
  }
  return {
    status: 'created',
    workspaceKind: 'multi-repo',
    record: {
      worktreeId: response.id,
      branchName: response.branchName,
      createdAt: response.createdAt,
      setupPhase: response.setupPhase ?? 'git-ready',
      trackedBaseBranch: null,
      trackedRepoBaseBranches: { ...response.trackedRepoBaseBranches },
      includedRepoIds: options.includedRepoIds
        ? [...options.includedRepoIds]
        : null,
    },
    response,
  };
}
