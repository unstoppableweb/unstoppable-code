import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { types } from 'node:util';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type CreateTrackedPlanRequest,
  type DeleteTrackedPlanRequest,
  type DetectedPlanEntry,
  type DetectedPlanUpdateRequest,
  type DetectedPlansListRequest,
  type DetectedPlansScanRequest,
  type DetectedPlansScanResponse,
  type TrackedPlanData,
  type TrackedPlanGetRequest,
  type TrackedPlanListRequest,
  type TrackedPlanListWithSkippedResult,
  type UpdateTrackedPlanRequest,
  type UsageInitiationSource,
} from '@canopy/desktop-shared/types';
import {
  DetectedPlanSchema,
  PLAN_ERROR_CODES,
} from '@canopy/protocol/canopy-core';
import {
  createTrackedPlan,
  deleteTrackedPlan,
  getTrackedPlan,
  listTrackedPlansWithSkipped,
  updateTrackedPlan,
} from '../lib/plan-persistence';
import {
  appendDetectedPlans,
  readDetectedPlans,
  updateDetectedPlan,
} from '../lib/detected-plan-persistence';
import { matchCandidatePaths } from '../lib/detected-plan-matcher';
import { getWorkspaceWorktreeDir } from '../lib/paths';
import { resolveWorktreePlanDetectionRules } from '../lib/plan-detection-config';
import { READ_ONLY_SCOPE_ERROR, isWritableScope } from '../lib/read-only-scope';
import { isErrnoException } from '../lib/type-guards';
import {
  resolveDetectedPlansFilePath,
  resolveTrackedPlansFilePath,
} from '../lib/resolve-worktree';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { listViewerPlans } from '../lib/shared-container-viewer-plans';
import { validateId } from '../lib/validation';
import { isCoworkWorkspace } from '../lib/workspace-registry';

/*
 * The tracked-plan lifecycle as desktop serves it (CAN-4165): scope policy,
 * and the plan engine behind plan-persistence. `core.plan.*` on the desktop dispatcher runs these, and so
 * do the in-process callers that have not moved onto the dispatcher yet.
 * Detected plans (PR 5b) run over the detected-plans writer, which still
 * writes in place (CAN-4494).
 */

export type UpdateTrackedPlanInput = UpdateTrackedPlanRequest & {
  /** With it, a write against another revision is refused. */
  expectedRevision?: number;
  /** With it, a write against a plan from another source is refused. */
  expectedSource?: TrackedPlanData['source'];
};

export interface ImportTrackedPlanInput {
  projectId: string;
  worktreeId: string;
  repoId: string;
  /** Relative to the repository's checkout in the worktree. */
  filePath: string;
  initiationSource?: UsageInitiationSource;
}

export interface DesktopPlanOperations {
  list(
    request: TrackedPlanListRequest,
  ): Promise<TrackedPlanListWithSkippedResult>;
  get(request: TrackedPlanGetRequest): Promise<TrackedPlanData | null>;
  create(request: CreateTrackedPlanRequest): Promise<TrackedPlanData>;
  update(request: UpdateTrackedPlanInput): Promise<TrackedPlanData | null>;
  /** False when the worktree did not have the plan. */
  delete(request: DeleteTrackedPlanRequest): Promise<boolean>;
  /** A new plan from a plan document in the worktree, every time. */
  import(request: ImportTrackedPlanInput): Promise<TrackedPlanData>;
  /** A scope with no detected plans, or a file that can't be read, has none. */
  detectedList(request: DetectedPlansListRequest): Promise<DetectedPlanEntry[]>;
  detectedScan(
    request: DetectedPlansScanRequest,
  ): Promise<DetectedPlansScanResponse>;
  /** An entry the scope does not have changes nothing. */
  detectedUpdate(
    request: DetectedPlanUpdateRequest,
  ): Promise<DetectedPlanEntry[]>;
  /** The plan diagrams are generated for, under the write scope rules. */
  diagramPlan(request: TrackedPlanGetRequest): Promise<TrackedPlanData | null>;
}

function validateScope(request: TrackedPlanListRequest): void {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
}

/** Shared-container recipient scopes stay read-only for every caller. */
function assertWritable(projectId: string): void {
  if (isWritableScope(projectId)) return;
  const cause = new Error(READ_ONLY_SCOPE_ERROR);
  throw new CanopyOperationError(
    {
      kind: 'permission_denied',
      code: PLAN_ERROR_CODES.READ_ONLY_SCOPE,
      message: READ_ONLY_SCOPE_ERROR,
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** Cowork, plan-explore, code-review and standalone chat scopes have no plans. */
function assertPlanScope(
  request: TrackedPlanListRequest,
  resolvePlansFile: typeof resolveTrackedPlansFilePath = resolveTrackedPlansFilePath,
): void {
  try {
    resolvePlansFile(request.projectId, request.worktreeId);
  } catch (cause) {
    throw new CanopyOperationError(
      {
        kind: 'failed_precondition',
        code: PLAN_ERROR_CODES.UNSUPPORTED_SCOPE,
        message:
          cause instanceof Error
            ? cause.message
            : 'This scope does not have tracked plans.',
        retry: { kind: 'never' },
      },
      cause,
    );
  }
}

/**
 * plan-import refuses a path it won't read with a plain Error; an errno or
 * typed failure is the store's and passes as it is. The refusal names no
 * host path; its cause keeps plan-import's message for the IPC projection.
 */
function importPathError(cause: unknown): unknown {
  if (
    cause instanceof CanopyOperationError ||
    !types.isNativeError(cause) ||
    'code' in cause
  )
    return cause;
  return new CanopyOperationError(
    {
      kind: 'invalid_argument',
      code: PLAN_ERROR_CODES.IMPORT_PATH,
      message: 'The file is not a readable plan document in the worktree.',
      details: { reason: 'IMPORT_PATH' },
      retry: { kind: 'never' },
    },
    cause,
  );
}

/**
 * Whether an errno failure was the writer's read: read the file once more. A
 * file that reads, even one that won't decode, failed on its save.
 */
async function unreadableFile(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return false;
  } catch (error) {
    return isErrnoException(error) && error.code !== 'ENOENT';
  }
}

/**
 * The detected-plans writer refuses a file it can't decode with a plain Error
 * (CAN-5833), and fails with an errno one on a file it can't read; it leaves
 * either as it is. Any other errno or typed failure, a save's among them,
 * passes as it is. The refusal names none of the file; its cause keeps the
 * writer's error for the IPC projection.
 */
async function detectedDamagedError(
  cause: unknown,
  file: string,
): Promise<unknown> {
  if (cause instanceof CanopyOperationError || !types.isNativeError(cause))
    return cause;
  if (
    'code' in cause &&
    (cause.code === 'ENOENT' || !(await unreadableFile(file)))
  )
    return cause;
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: PLAN_ERROR_CODES.DAMAGED_STATE,
      message:
        "This worktree's detected plans could not be read, so they were left unchanged.",
      details: { reason: 'DAMAGED_STATE' },
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** Wraps only the writer's calls: a rule or match failure isn't the file's. */
async function detectedWrite<T>(
  scope: { projectId: string; worktreeId: string },
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (cause) {
    throw await detectedDamagedError(
      cause,
      resolveDetectedPlansFilePath(scope.projectId, scope.worktreeId),
    );
  }
}

/** The detection rules matched against the paths a turn touched. */
async function scanDetectedPlans(
  request: DetectedPlansScanRequest,
): Promise<DetectedPlansScanResponse> {
  const rules = await resolveWorktreePlanDetectionRules(
    request.projectId,
    request.worktreeId,
  );
  const existing = await readDetectedPlans(
    request.projectId,
    request.worktreeId,
  );
  if (rules.includes.length === 0) {
    return { entries: existing, newlyDetected: [] };
  }
  const worktreePath = getWorkspaceWorktreeDir(
    request.projectId,
    request.worktreeId,
  );
  const repoEntries = await listWorkspaceWorktreeRepoEntries(
    request.projectId,
    worktreePath,
  ).catch(() => []);
  const repos =
    repoEntries.length > 0
      ? repoEntries.map((repo) => ({
          repoId: repo.repoId,
          repoPath: repo.repoPath,
        }))
      : [{ repoId: WORKSPACE_ROOT_REPO_ID, repoPath: worktreePath }];
  const matches = matchCandidatePaths({
    candidatePaths: request.candidatePaths,
    repos,
    rules,
  });
  const existingKeys = new Set(
    existing.map((entry) => `${entry.sourceRepoId}::${entry.sourceFilePath}`),
  );
  const now = new Date().toISOString();
  const fresh = matches
    .filter(
      (match) =>
        !existingKeys.has(`${match.sourceRepoId}::${match.sourceFilePath}`),
    )
    .map(
      (match): DetectedPlanEntry => ({
        id: randomUUID(),
        sourceRepoId: match.sourceRepoId,
        sourceFilePath: match.sourceFilePath,
        status: 'detected',
        bannerSeen: false,
        detectedInChatId: request.chatId,
        detectedAt: now,
      }),
    )
    // A core record can't name every file a POSIX name can, such as
    // `C:notes/plan.md` or `Q1\Review.md`, so those aren't detected.
    .filter((entry) => DetectedPlanSchema.safeParse(entry).success);
  if (fresh.length === 0) return { entries: existing, newlyDetected: [] };
  const entries = await detectedWrite(request, () =>
    appendDetectedPlans(request.projectId, request.worktreeId, fresh),
  );
  // A concurrent scan may have stored the same file first.
  const stored = new Set(entries.map((entry) => entry.id));
  return {
    entries,
    newlyDetected: fresh.filter((entry) => stored.has(entry.id)),
  };
}

/**
 * Delete the plan row, then reclaim its plan-explore state on behalf of the
 * owning worktree: the scoped plan file, and, only when the takeover registry
 * row is absent or owned by this worktree, the sentinel chat scope. The
 * explore cleanup never blocks the deletion: on failure the registry row stays
 * behind so the owning worktree's cleanup sweep reclaims it later.
 */
async function deleteTrackedPlanWithExploreChat(
  request: DeleteTrackedPlanRequest,
): Promise<boolean> {
  const deleted = await deleteTrackedPlan(
    request.projectId,
    request.worktreeId,
    request.planId,
  );
  // Deferred on purpose: the explore cleanup pulls in the chat-state, search,
  // and live session teardown services, which importing this module alone
  // must not initialize.
  const { removePlanExploreChat } = await import('../lib/plan-explore-cleanup');
  await removePlanExploreChat(request.planId, {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  }).catch(() => undefined);
  return deleted;
}

export const desktopPlanOperations: DesktopPlanOperations = {
  async list(request) {
    validateScope(request);
    if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
      return { plans: await listViewerPlans(request) };
    if (isCoworkWorkspace(request.projectId)) return { plans: [] };
    assertPlanScope(request);
    return listTrackedPlansWithSkipped(request.projectId, request.worktreeId);
  },

  async get(request) {
    validateScope(request);
    validateId(request.planId, 'planId');
    if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
      return (
        (await listViewerPlans(request)).find(
          (plan) => plan.id === request.planId,
        ) ?? null
      );
    assertPlanScope(request);
    const plan = await getTrackedPlan(
      request.projectId,
      request.worktreeId,
      request.planId,
    );
    return plan;
  },

  async create(request) {
    validateScope(request);
    assertWritable(request.projectId);
    assertPlanScope(request);
    const plan = await createTrackedPlan(request);
    return plan;
  },

  async update(request) {
    validateScope(request);
    assertWritable(request.projectId);
    validateId(request.planId, 'planId');
    assertPlanScope(request);
    const plan = await updateTrackedPlan(request);
    return plan;
  },

  async delete(request) {
    validateScope(request);
    assertWritable(request.projectId);
    validateId(request.planId, 'planId');
    assertPlanScope(request);
    const deleted = await deleteTrackedPlanWithExploreChat(request);
    return deleted;
  },

  async import(request) {
    validateScope(request);
    // Before the file is read: a scope that refuses the write never reads it.
    assertWritable(request.projectId);
    assertPlanScope(request);
    // Deferred: plan-import reaches this module through plans-service.
    const { importTrackedPlanFromPath } = await import('../lib/plan-import');
    try {
      return (await importTrackedPlanFromPath(request)).plan;
    } catch (cause) {
      throw importPathError(cause);
    }
  },

  async detectedList(request) {
    validateScope(request);
    return readDetectedPlans(request.projectId, request.worktreeId);
  },

  async detectedScan(request) {
    validateScope(request);
    validateId(request.chatId, 'chatId');
    // Before the rules or the detected plans are read.
    assertWritable(request.projectId);
    assertPlanScope(request, resolveDetectedPlansFilePath);
    return scanDetectedPlans(request);
  },

  async detectedUpdate(request) {
    validateScope(request);
    validateId(request.entryId, 'entryId');
    if (request.importedPlanId !== undefined)
      validateId(request.importedPlanId, 'importedPlanId');
    assertWritable(request.projectId);
    assertPlanScope(request, resolveDetectedPlansFilePath);
    return detectedWrite(request, () =>
      updateDetectedPlan(
        request.projectId,
        request.worktreeId,
        request.entryId,
        {
          ...(request.status ? { status: request.status } : {}),
          ...(request.bannerSeen !== undefined
            ? { bannerSeen: request.bannerSeen }
            : {}),
          ...(request.importedPlanId
            ? { importedPlanId: request.importedPlanId }
            : {}),
        },
      ),
    );
  },

  async diagramPlan(request) {
    validateScope(request);
    assertWritable(request.projectId);
    validateId(request.planId, 'planId');
    assertPlanScope(request);
    return getTrackedPlan(
      request.projectId,
      request.worktreeId,
      request.planId,
    );
  },
};
