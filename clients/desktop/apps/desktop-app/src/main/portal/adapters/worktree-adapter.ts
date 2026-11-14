import { setTimeout as delay } from 'node:timers/promises';
import {
  PORTAL_CATALOG_RESULT_MAX_BYTES,
  decodeWorktreeBaseBranch,
  isExplicitWorktreeBaseBranch,
  PORTAL_WORKTREE_BASE_BRANCH_ENCODING,
  type PortalWorktreeBranchesListResult,
} from '@canopy/protocol/portal';
import { fitListResult, resultByteLength } from './result-budget';
import { getActiveDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { validateBranchName } from '../../lib/git';
import { assertMutuallyExclusiveWorktreeBaseSources } from '../../ipc/worktree-create-validation';
import { readDefaultBranchHint } from '../../lib/git-default-branch';
import { worktreeRemovalIntent } from '@canopy/protocol/portal/worktree-recovery';
import { WorktreeRecoveryRequestSchema } from '@canopy/protocol/portal/worktree-discard-schemas';
import type {
  PortalTaskFirstChat,
  PortalTaskFirstChatResult,
  PortalTaskSidebarItemGroupName,
  PortalWorktreeCreatePayload,
  PortalWorktreeCreateResult,
  PortalWorktreeCreateRefusal,
  PortalWorktreeCreateRefusalReason,
  PortalRepositoryIdentity,
} from '@canopy/protocol/portal';
import { parsePortalRepositoryIdentity } from '@canopy/protocol/portal';
import {
  isSidebarItemGroupId,
  isSidebarItemGroupColor,
} from '@canopy/protocol/sidebar';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  CORE_PULL_REQUEST_GRANTS,
  WORKER_GIT_GRANTS,
  type WorkerGitBranchListResult,
} from '@canopy/protocol/canopy-core';
import { mintPullRequestId } from '@canopy/core-runtime/node/github';
import { getDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import { readRepositoryRemoteUrl } from '../../canopy-runtime/worker-git-dispatch';
import {
  runInGitHubProjection,
  type PullRequestResolveCapture,
} from '../../github/projection-capture';
import {
  bindPullRequestReference,
  parsePullRequestReferenceForResolver,
} from '../../lib/github-pr-resolver';
import { parseGitHubRemote } from '../../lib/github-pr';
import { recordedRepositoryPath } from '../../lib/workspace-recorded-repo';
import { createPortalCaller } from '../portal-caller';
import { sidebarItemGroupsService } from '../../services/sidebar-item-groups-service';
import { createTaskFirstChat, parseTaskFirstChat } from './task-first-chat';
import {
  IPC_CHANNELS,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
  type WorktreeData,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
  type CreateWorktreeServiceOptions,
} from '../../lib/worktree-service';
import {
  WorktreeCreationRefusedError,
  type WorktreeCreationRefusal,
} from '../../lib/worktree-creation-selection';
import { findManagedCheckoutWorktreeId } from './worktree-checkout-owner';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from '../../lib/workspace-persistence';
import {
  moveWorktree,
  updateWorktree,
  WorktreeUpdateRefusedError,
  type WorktreeMetadataPatch,
  type WorktreeUpdateRefusal,
} from '../../lib/worktree-update';
import { recordWorktreeCrudTelemetry } from '../../lib/desktop-telemetry';
import { validateId } from '../../lib/validation';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import {
  archiveWorktree,
  WorktreeArchiveRefusedError,
} from '../../lib/worktree-archive';
import {
  describeWorktreeDiscard,
  withTypedArchiveRefusal,
} from '../../lib/worktree-discard';
import { discardWorktreeFromInterface } from '../../lib/worktree-discard-interface';
import { sendToWindow } from '../../lib/window-send';
import type { PortalAdapterContext, PortalAdapterFailureCode } from './types';
import { failServiceError, isRecord } from './validation';
import { forkOpenWorktreeTabs } from '../../lib/worktree-open-tabs-fork';
import { createPortalEvent } from '../portal-event-bus';
import { isWorkspaceTargetRemovalPending } from '../../lib/workspace-target-exclusion';
import {
  getWorkspacePortalWorktreeEntity,
  getWorkspacePortalWorktreeRuntimeStatus,
} from '../../services/workspace-portal-service';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';

const GENERIC_WORKTREE_CREATE_FAILURE =
  'Failed to create the task worktree. Check the repository state, then try again.';

type WorktreeCreateRefusalPresentation = {
  code: PortalWorktreeCreateRefusalReason;
  message: string;
};

type CreateRefusal =
  | WorktreeCreationRefusal
  | 'pr_not_found'
  | 'pr_not_in_repository';

type CreatePullRequestResolution =
  | { kind: 'resolved'; headBranch: string; isCrossRepo: boolean }
  | { kind: 'not_found' }
  | { kind: 'not_in_repository' };

const PORTAL_WORKTREE_CREATE_REFUSAL: Record<
  CreateRefusal,
  WorktreeCreateRefusalPresentation
> = {
  pr_not_found: {
    code: 'pr_not_found',
    message: 'The pull request was not found.',
  },
  pr_not_in_repository: {
    code: 'pr_not_in_repository',
    message: "The pull request is not on this project's repository.",
  },
  'branch-not-found': {
    code: 'branch_not_found',
    message: 'The branch was not found.',
  },
  'branch-checked-out': {
    code: 'branch_checked_out',
    message: 'The branch is already checked out.',
  },
  'base-not-found': {
    code: 'base_not_found',
    message: 'The base branch was not found.',
  },
  'branch-reserved': {
    code: 'branch_name_in_use',
    message: 'The branch name is already in use. Try again.',
  },
  'checkout-reserved': {
    code: 'checkout_in_use',
    message: 'Another task is being created in this location. Try again.',
  },
  'invalid-branch-name': {
    code: 'invalid_branch_name',
    message: 'The branch name is not valid.',
  },
  'invalid-selection': {
    code: 'invalid_selection',
    message: 'This create request does not suit the project.',
  },
  'invalid-repository-selection': {
    code: 'invalid_repository_selection',
    message: 'The repository selection does not suit the project.',
  },
  'unsupported-workspace': {
    code: 'unsupported_project',
    message: 'This project cannot create worktree tasks.',
  },
  'read-only-scope': {
    code: 'read_only_project',
    message: 'This project is read-only on this host.',
  },
  'base-task-detached': {
    code: 'base_task_detached',
    message: 'The base task has no branch.',
  },
};

function isStringOrNullRecord(
  value: unknown,
): value is Record<string, string | null> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) => entry === null || typeof entry === 'string',
    )
  );
}

function failWorktreeCreateRefusal(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  reason: CreateRefusal,
  existingWorktreeId?: string,
): void {
  const presentation = PORTAL_WORKTREE_CREATE_REFUSAL[reason];
  const refusal: PortalWorktreeCreateRefusal = {
    reason: presentation.code,
    ...(existingWorktreeId ? { existingWorktreeId } : {}),
  };
  context.fail(command, presentation.code, presentation.message, false, {
    refusal,
  });
}

/** Reuse Home's core PR read and projection, retaining fork metadata for typed refusals. */
async function resolveCreatePullRequest(
  workspaceId: string,
  config: WorkspaceConfigFile,
  number: number,
  context: PortalAdapterContext,
  repository?: PortalRepositoryIdentity,
): Promise<CreatePullRequestResolution> {
  const repoPath = recordedRepositoryPath(config);
  if (!repoPath) {
    if (repository) return { kind: 'not_in_repository' };
    throw new Error('This project has no repository for pull requests.');
  }
  if (!context.sessionId) {
    if (repository) return { kind: 'not_in_repository' };
    throw new Error('Portal session is not active.');
  }
  let runtime: ReturnType<typeof getDesktopCanopyRuntime>;
  let caller: ReturnType<typeof createPortalCaller>;
  let remoteUrl: string | null;
  try {
    runtime = getDesktopCanopyRuntime();
    caller = createPortalCaller({ sessionId: context.sessionId }, []);
    ({ remoteUrl } = await readRepositoryRemoteUrl(runtime, caller, repoPath));
  } catch (error) {
    if (repository) return { kind: 'not_in_repository' };
    throw error;
  }
  if (repository) {
    const rootIdentity =
      remoteUrl === null
        ? undefined
        : parsePortalRepositoryIdentity(parseGitHubRemote(remoteUrl));
    if (
      !rootIdentity ||
      rootIdentity.owner !== repository.owner ||
      rootIdentity.repo !== repository.repo
    )
      return { kind: 'not_in_repository' };
  }
  const ref = bindPullRequestReference(
    parsePullRequestReferenceForResolver(String(number)),
    remoteUrl,
  );
  const pullRequestId = mintPullRequestId({
    repository: { workspaceId },
    github: { owner: ref.owner, repo: ref.repo },
    number,
  });
  if (!pullRequestId) throw new Error('The pull request cannot be identified.');
  const capture: PullRequestResolveCapture = { kind: 'resolve', repoPath };
  try {
    await runInGitHubProjection(capture, () =>
      runtime.query(
        'core.pullRequest.get',
        { pullRequestId, refresh: false },
        { caller: { ...caller, grants: [CORE_PULL_REQUEST_GRANTS.read] } },
      ),
    );
  } catch (error) {
    // The legacy projection can capture a usable view even when the canonical
    // detail is unavailable. Home's resolver deliberately keeps that answer.
    if (!capture.view) {
      if (
        isRecord(error) &&
        isRecord(error.payload) &&
        error.payload.code === 'core.pullRequest.notFound'
      )
        return { kind: 'not_found' };
      throw error;
    }
  }
  if (!capture.view)
    throw new Error('Pull request resolution was not captured.');
  const headRepository = capture.view.headRepository;
  return {
    kind: 'resolved',
    headBranch: capture.view.headBranch,
    isCrossRepo:
      headRepository === null ||
      headRepository.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase(),
  };
}

function parseCreateAdditions(payload: Record<string, unknown>): Pick<
  PortalWorktreeCreatePayload,
  'existingBranch' | 'baseBranch' | 'pullRequest'
> & {
  firstChat?: PortalTaskFirstChat;
  sidebarItemGroupName?: PortalTaskSidebarItemGroupName;
} {
  const nonblank = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;
  for (const field of ['existingBranch', 'baseBranch']) {
    if (payload[field] !== undefined && !nonblank(payload[field]))
      throw new Error('Invalid branch selection.');
  }
  const count = ['existingBranch', 'baseBranch', 'pullRequest'].filter(
    (field) => payload[field] !== undefined,
  ).length;
  if (count > 1 || (count > 0 && payload.baseWorktreeId !== undefined))
    throw new Error('Conflicting branch selections.');
  let pullRequest: PortalWorktreeCreatePayload['pullRequest'];
  if (payload.pullRequest !== undefined) {
    const pr = payload.pullRequest;
    if (
      !isRecord(pr) ||
      typeof pr.number !== 'number' ||
      !Number.isSafeInteger(pr.number) ||
      pr.number <= 0 ||
      (pr.as !== 'checkout' && pr.as !== 'base')
    )
      throw new Error('Invalid pull request selection.');
    const hasRepository = Object.prototype.hasOwnProperty.call(
      pr,
      'repository',
    );
    const repository = hasRepository
      ? parsePortalRepositoryIdentity(pr.repository)
      : undefined;
    if (hasRepository && repository === undefined)
      throw new Error('Invalid pull request selection.');
    pullRequest = {
      number: pr.number,
      as: pr.as,
      ...(repository === undefined ? {} : { repository }),
    };
  }
  let sidebarItemGroupName: PortalTaskSidebarItemGroupName | undefined;
  if (payload.sidebarItemGroupName !== undefined) {
    const group = payload.sidebarItemGroupName;
    if (
      !isRecord(group) ||
      !nonblank(group.name) ||
      (group.color !== undefined && !isSidebarItemGroupColor(group.color))
    )
      throw new Error('Invalid group selection.');
    sidebarItemGroupName = {
      name: group.name,
      ...(isSidebarItemGroupColor(group.color) ? { color: group.color } : {}),
    };
  }
  return {
    ...(nonblank(payload.existingBranch)
      ? { existingBranch: payload.existingBranch }
      : {}),
    ...(nonblank(payload.baseBranch) ? { baseBranch: payload.baseBranch } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(sidebarItemGroupName ? { sidebarItemGroupName } : {}),
    ...(payload.firstChat !== undefined
      ? { firstChat: parseTaskFirstChat(payload.firstChat) }
      : {}),
  };
}

/** Push the authoritative post-setup row without issuing another portal command. */
async function publishPortalWorktreeSetupStatus(
  context: PortalAdapterContext,
  workspaceId: string,
  worktreeId: string,
  setupError?: string,
): Promise<void> {
  try {
    // Archiving cancels in-flight setup. A row missing because it is being
    // removed, or was while this read ran, is not a failed setup to report.
    const removalPendingBeforeRead = isWorkspaceTargetRemovalPending(
      workspaceId,
      worktreeId,
    );
    const runtimeStatus = await getWorkspacePortalWorktreeRuntimeStatus(
      workspaceId,
      worktreeId,
    );
    const entity = await getWorkspacePortalWorktreeEntity(
      workspaceId,
      worktreeId,
      runtimeStatus,
    );
    const removalPending =
      removalPendingBeforeRead ||
      isWorkspaceTargetRemovalPending(workspaceId, worktreeId);
    context.enqueueEvent(
      createPortalEvent('portal.state.delta', {
        scope: 'worktree',
        target: {
          workspaceLocalId: workspaceId,
          worktreeLocalId: worktreeId,
        },
        ...(entity
          ? { entities: [entity] }
          : {
              removed: [
                {
                  entityType: 'worktree',
                  localId: worktreeId,
                  parentLocalId: workspaceId,
                },
              ],
            }),
        ...(setupError && !entity && !removalPending
          ? {
              worktreeSetupFailure: {
                workspaceLocalId: workspaceId,
                worktreeLocalId: worktreeId,
                error: setupError,
              },
            }
          : {}),
        generatedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Persistence also schedules an overview snapshot. This direct status
    // delta is the low-latency path, so a projection failure remains best-effort.
  }
}

/**
 * Notify the desktop renderer that a portal-initiated mutation changed a
 * workspace's persisted worktree list. The renderer never initiated the write,
 * so without this the sidebar goes stale until an unrelated full reload
 * (CAN-1304). Broadcasts the authoritative full post-mutation list — the shape
 * `applyWorkspaceWorktreeUpdatedEvent` uses to ADD and REMOVE rows — and falls
 * back to a workspace-id-only event (renderer does a debounced silent reload)
 * if the list cannot be re-read.
 */
async function broadcastWorktreeListToRenderer(
  context: PortalAdapterContext,
  workspaceId: string,
): Promise<void> {
  let worktrees: WorktreeData[] | undefined;
  try {
    // Note: readWorkspaceWorktrees may prune stale rows and re-write
    // worktrees.json (self-heal), which resets the portal-sync debounce in
    // portal-structural-sync. Harmless — the extra fire is the same
    // idempotent overview push — but it means this read can schedule a push.
    worktrees = await readWorkspaceWorktrees(workspaceId);
  } catch {
    worktrees = undefined;
  }
  sendToWindow(
    context.getWindow?.() ?? null,
    IPC_CHANNELS.workspaceWorktreesUpdated,
    Array.isArray(worktrees) ? { workspaceId, worktrees } : { workspaceId },
  );
}

/** Update a worktree label and/or hidden state. */
export async function handlePortalWorktreeUpdate(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.worktreeId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree update payload: workspaceId and worktreeId are required.',
    );
    return;
  }
  const hasLabel = Object.prototype.hasOwnProperty.call(payload, 'label');
  const hasHidden = Object.prototype.hasOwnProperty.call(payload, 'hidden');
  const hasTrackedBaseBranch = Object.prototype.hasOwnProperty.call(
    payload,
    'trackedBaseBranch',
  );
  const hasTrackedRepoBaseBranches = Object.prototype.hasOwnProperty.call(
    payload,
    'trackedRepoBaseBranches',
  );
  if (
    (!hasLabel &&
      !hasHidden &&
      !hasTrackedBaseBranch &&
      !hasTrackedRepoBaseBranches) ||
    (hasLabel && payload.label !== null && typeof payload.label !== 'string') ||
    (hasHidden && typeof payload.hidden !== 'boolean') ||
    (hasTrackedBaseBranch &&
      payload.trackedBaseBranch !== null &&
      typeof payload.trackedBaseBranch !== 'string') ||
    (hasTrackedRepoBaseBranches &&
      !isStringOrNullRecord(payload.trackedRepoBaseBranches))
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Worktree update requires a string/null label and/or a boolean hidden value.',
    );
    return;
  }

  try {
    validateId(payload.workspaceId, 'workspaceId');
    validateId(payload.worktreeId, 'worktreeId');
    const workspaceId = payload.workspaceId;
    const patch: WorktreeMetadataPatch = {};
    // `updateWorktree` trims the label and clears a blank or null one.
    if (
      hasLabel &&
      (payload.label === null || typeof payload.label === 'string')
    )
      patch.label = payload.label;
    if (hasHidden && typeof payload.hidden === 'boolean')
      patch.hidden = payload.hidden;
    if (
      hasTrackedBaseBranch &&
      (payload.trackedBaseBranch === null ||
        typeof payload.trackedBaseBranch === 'string')
    ) {
      patch.trackedBaseBranch = payload.trackedBaseBranch;
    }
    if (
      hasTrackedRepoBaseBranches &&
      isStringOrNullRecord(payload.trackedRepoBaseBranches)
    ) {
      patch.trackedRepoBaseBranches = payload.trackedRepoBaseBranches;
    }
    const { worktree } = await updateWorktree({
      workspaceId,
      worktreeId: payload.worktreeId,
      patch,
    });
    sendToWindow(
      context.getWindow?.() ?? null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId, worktree },
    );
    context.complete(command, { success: true });
  } catch (error) {
    failWorktreeMetadataError(
      command,
      context,
      error,
      'Worktree to update was not found.',
    );
  }
}

/** The Portal's closed failure code for each metadata boundary refusal. */
const PORTAL_CODE_BY_WORKTREE_REFUSAL: Record<
  WorktreeUpdateRefusal,
  PortalAdapterFailureCode
> = {
  'not-found': 'not_found',
  'read-only-scope': 'forbidden',
  'invalid-patch': 'invalid_payload',
  'worktrees-unavailable': 'execution_failed',
};

/**
 * Projects an `updateWorktree`/`moveWorktree` refusal onto the Portal's closed
 * failure codes, keeping the Portal's own not-found copy.
 */
function failWorktreeMetadataError(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  error: unknown,
  notFoundMessage: string,
): void {
  if (!(error instanceof WorktreeUpdateRefusedError)) {
    failServiceError(command, context, error);
  } else if (error.reason === 'not-found') {
    context.fail(command, 'not_found', notFoundMessage);
  } else {
    context.fail(
      command,
      PORTAL_CODE_BY_WORKTREE_REFUSAL[error.reason],
      error.message,
      false,
    );
  }
}

/** Persist a visible-worktree drag move while preserving hidden row slots. */
export async function handlePortalWorktreeReorder(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.activeWorktreeId !== 'string' ||
    typeof payload.overWorktreeId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree reorder payload: workspaceId, activeWorktreeId, and overWorktreeId are required.',
    );
    return;
  }

  try {
    validateId(payload.workspaceId, 'workspaceId');
    validateId(payload.activeWorktreeId, 'activeWorktreeId');
    validateId(payload.overWorktreeId, 'overWorktreeId');
    const config = await readWorkspaceConfig(payload.workspaceId);
    if (config.type === 'cowork') {
      context.fail(command, 'not_found', 'Project to reorder was not found.');
      return;
    }
    await moveWorktree({
      workspaceId: payload.workspaceId,
      activeWorktreeId: payload.activeWorktreeId,
      overWorktreeId: payload.overWorktreeId,
    });
    // `moveWorktree` returns no list, so the broadcast re-reads it.
    await broadcastWorktreeListToRenderer(context, payload.workspaceId);
    context.complete(command, {
      workspaceId: payload.workspaceId,
      activeWorktreeId: payload.activeWorktreeId,
      overWorktreeId: payload.overWorktreeId,
    });
  } catch (error) {
    failWorktreeMetadataError(
      command,
      context,
      error,
      'Worktree to reorder was not found.',
    );
  }
}

/** Read branch bases through the existing worker Git projection. */
async function readPortalBranchCatalogue(
  workspaceId: string,
  sessionId: string,
  repoPath: string | null | undefined,
  signal: AbortSignal,
): Promise<WorkerGitBranchListResult> {
  // Give the optional freshness lookup a short budget before using cached refs.
  const hintTimer = new AbortController();
  const hintSignal = AbortSignal.any([signal, hintTimer.signal]);
  const hint = repoPath
    ? await Promise.race([
        readDefaultBranchHint(repoPath, {}, hintSignal).catch(() => null),
        delay(250, null, {
          signal: hintSignal,
        }),
      ]).finally(() => hintTimer.abort())
    : null;
  signal.throwIfAborted();
  return getActiveDesktopRuntime().query(
    'worker.git.branch.list',
    {
      scope: { workspaceId },
      repository: { kind: 'reference' },
      allowRemoteLookup: false,
      ...(hint && {
        defaultBranchHint: {
          defaultBranch: hint.defaultBranch,
          resolvedAt: new Date(hint.resolvedAt).toISOString(),
        },
      }),
    },
    {
      signal,
      caller: createPortalCaller({ sessionId }, [WORKER_GIT_GRANTS.read]),
    },
  );
}

export async function handlePortalWorktreeBranchesList(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    payload.baseBranchEncoding !== PORTAL_WORKTREE_BASE_BRANCH_ENCODING
  ) {
    context.fail(command, 'invalid_payload', 'A workspaceId is required.');
    return;
  }
  try {
    validateId(payload.workspaceId, 'workspaceId');
  } catch {
    context.fail(command, 'invalid_payload', 'Invalid workspaceId.');
    return;
  }
  try {
    const config = await readWorkspaceConfig(payload.workspaceId);
    if (config.type !== 'single-repo') {
      context.complete(command, {
        supported: false,
        branches: [],
        defaultBranch: null,
      });
      return;
    }
    if (!context.sessionId) throw new Error('Portal session is unavailable.');
    const deadline = new AbortController();
    const result = await Promise.race([
      readPortalBranchCatalogue(
        payload.workspaceId,
        context.sessionId,
        config.repoPath,
        deadline.signal,
      ),
      delay(5_000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error('Branch catalogue deadline exceeded.');
      }),
    ]).finally(() => deadline.abort());
    const bounded = fitListResult(
      result.branches,
      (branches, truncated): PortalWorktreeBranchesListResult => ({
        supported: true,
        branches,
        defaultBranch: result.defaultBranch,
        ...(truncated ? { truncated: true } : {}),
      }),
    );
    if (resultByteLength(bounded) > PORTAL_CATALOG_RESULT_MAX_BYTES) {
      throw new Error('Branch catalog metadata exceeds the result budget.');
    }
    context.complete(command, bounded);
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.code === 'worker.git.branch.repositoryUnavailable'
    ) {
      context.complete(command, {
        supported: false,
        branches: [],
        defaultBranch: null,
      });
      return;
    }
    context.fail(
      command,
      'execution_failed',
      'Failed to list branch bases. Try again.',
    );
  }
}

/**
 * Handle `portal.worktree.create` — create a new worktree ("task") in a
 * workspace from the browser Remote Control sidebar (the workspace add "+" /
 * "Create Task"). Reuses the exact desktop services the renderer uses
 * (`createSingleRepoWorktree` / `createMultiRepoWorktree`), dispatching on the
 * authoritative persisted workspace type and rejecting `cowork` workspaces
 * (which have no worktrees), same as the renderer IPC path.
 *
 * Git setup is deferred through the existing two-phase worktree lifecycle, so
 * this command acknowledges the persisted `git-pending` reservation without
 * holding the portal's serial command lane through fetch/worktree creation.
 * Ready/failure callbacks notify both the desktop renderer and the portal with
 * the authoritative post-setup row. Auto-running post-create setup scripts
 * remains a tracked follow-up (`startPostCreateSetup: false`); the user can run
 * Setup from the Scripts panel after Git is ready.
 */
export async function handlePortalWorktreeCreate(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.worktree.create']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  // The payload is browser-supplied and only shape/size-validated in transit,
  // so re-validate the fields here (read through `unknown` so the guards are
  // real runtime checks, not type-narrowed no-ops).
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    (payload.baseBranch !== undefined &&
      (typeof payload.baseBranch !== 'string' ||
        (payload.baseBranchEncoding === undefined
          ? isExplicitWorktreeBaseBranch(payload.baseBranch)
          : payload.baseBranchEncoding !==
            PORTAL_WORKTREE_BASE_BRANCH_ENCODING))) ||
    (payload.sidebarItemGroupId !== undefined &&
      !isSidebarItemGroupId(payload.sidebarItemGroupId))
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree create payload: workspaceId is required.',
    );
    return;
  }
  let additions: ReturnType<typeof parseCreateAdditions>;
  try {
    additions = parseCreateAdditions(payload);
  } catch {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree create options.',
      false,
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  const filteredExistingIds = Array.isArray(payload.existingWorktreeIds)
    ? payload.existingWorktreeIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : undefined;
  // Coalesce an empty array to `undefined` so the create service falls back to
  // reading the persisted worktree list for default-branch uniqueness.
  const existingWorktreeIds =
    filteredExistingIds && filteredExistingIds.length > 0
      ? filteredExistingIds
      : undefined;
  const baseWorktreeId =
    typeof payload.baseWorktreeId === 'string'
      ? payload.baseWorktreeId
      : undefined;

  let explicitBaseBranch: string | undefined;
  try {
    assertMutuallyExclusiveWorktreeBaseSources({
      baseWorktreeId,
      ...(typeof payload.baseBranch === 'string'
        ? { baseBranch: payload.baseBranch }
        : {}),
    });
    // worktree_create_from_v1 sends generic Git bases without a marker.
    // Only negotiated v2 selections carry exact local/origin identity.
    if (payload.baseBranchEncoding === PORTAL_WORKTREE_BASE_BRANCH_ENCODING) {
      if (
        typeof payload.baseBranch !== 'string' ||
        decodeWorktreeBaseBranch(payload.baseBranch) === null
      ) {
        throw new Error('Invalid exact branch base.');
      }
      explicitBaseBranch = payload.baseBranch;
    }
  } catch {
    context.fail(
      command,
      'invalid_payload',
      'Choose a valid branch base or a worktree base, then try again.',
    );
    return;
  }
  try {
    validateId(workspaceId, 'workspaceId');
    if (baseWorktreeId) {
      validateId(baseWorktreeId, 'baseWorktreeId');
    }
  } catch {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree create payload: workspaceId and baseWorktreeId must use lowercase letters, numbers, and hyphens.',
      false,
    );
    return;
  }

  try {
    // Dispatch on the authoritative persisted workspace type (not the in-memory
    // sidebar registry) so a stale/unpopulated registry can't misroute, and
    // reject cowork workspaces explicitly — matching the renderer IPC path.
    const config = await readWorkspaceConfig(workspaceId);
    if (config.type === 'cowork') {
      failWorktreeCreateRefusal(command, context, 'unsupported-workspace');
      return;
    }
    if (
      explicitBaseBranch !== undefined &&
      (config.type !== 'single-repo' ||
        !config.repoPath ||
        !(await validateBranchName(
          config.repoPath,
          decodeWorktreeBaseBranch(explicitBaseBranch)?.branchName ?? '',
        )))
    ) {
      context.fail(
        command,
        'invalid_payload',
        'A valid branch base requires a single-repository project.',
      );
      return;
    }
    let { existingBranch } = additions;
    let baseBranch = explicitBaseBranch ?? additions.baseBranch;
    if (additions.pullRequest) {
      const pr = await resolveCreatePullRequest(
        workspaceId,
        config,
        additions.pullRequest.number,
        context,
        additions.pullRequest.repository,
      );
      if (pr.kind === 'not_in_repository') {
        failWorktreeCreateRefusal(command, context, 'pr_not_in_repository');
        return;
      }
      if (pr.kind === 'not_found') {
        failWorktreeCreateRefusal(command, context, 'pr_not_found');
        return;
      }
      if (pr.isCrossRepo) {
        failWorktreeCreateRefusal(command, context, 'pr_not_in_repository');
        return;
      }
      if (additions.pullRequest.as === 'checkout')
        existingBranch = pr.headBranch;
      else baseBranch = pr.headBranch;
    }
    let tabsFork: Promise<void> | undefined;
    const forkTabsBeforeReady = (worktreeId: string): Promise<void> => {
      if (payload.forkOpenTabs !== true || !baseWorktreeId)
        return Promise.resolve();
      // A first chat must be installed after inherited tabs, not overwritten
      // by the Git-ready callback. Start this same best-effort step at reserve
      // time for first-chat creates; it never waits for Git.
      tabsFork ??= forkOpenWorktreeTabs({
        projectId: workspaceId,
        sourceWorktreeId: baseWorktreeId,
        destinationWorktreeId: worktreeId,
      })
        .then(() => undefined)
        .catch(() => undefined);
      return tabsFork;
    };
    const options: CreateWorktreeServiceOptions = {
      workspaceId,
      ...(existingBranch !== undefined ? { existingBranch } : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      // The existing composer marker distinguishes the catalogue's full ref
      // from legacy base names on other Portal create requests and PR heads.
      ...(config.type === 'single-repo' &&
      payload.creditRecoveryIntent === 'new-task' &&
      explicitBaseBranch === undefined &&
      additions.baseBranch !== undefined
        ? { baseBranchIsQualified: true }
        : {}),
      ...(!additions.sidebarItemGroupName &&
      isSidebarItemGroupId(payload.sidebarItemGroupId)
        ? { sidebarItemGroupId: payload.sidebarItemGroupId }
        : {}),
      existingWorktreeIds,
      baseWorktreeId,
      ...(explicitBaseBranch === undefined
        ? {}
        : { baseBranchResolution: 'exact-branch' }),
      startPostCreateSetup: false,
      deferGitSetup: true,
      beforeGitReady: (event): Promise<void> =>
        forkTabsBeforeReady(event.worktreeId),
      onGitReady: (event): void => {
        sendToWindow(
          context.getWindow?.() ?? null,
          IPC_CHANNELS.worktreeGitReady,
          event,
        );
        trackDetachedWork(() =>
          publishPortalWorktreeSetupStatus(
            context,
            event.projectId,
            event.worktreeId,
          ),
        );
      },
      onGitFailed: (event): void => {
        sendToWindow(
          context.getWindow?.() ?? null,
          IPC_CHANNELS.worktreeGitFailed,
          event,
        );
        trackDetachedWork(() =>
          publishPortalWorktreeSetupStatus(
            context,
            event.projectId,
            event.worktreeId,
            event.error,
          ),
        );
      },
    };
    const result =
      config.type === 'multi-repo'
        ? await createMultiRepoWorktree(options)
        : await createSingleRepoWorktree(options);
    if (additions.firstChat) await forkTabsBeforeReady(result.id);
    let groupError: string | undefined;
    if (additions.sidebarItemGroupName) {
      try {
        await sidebarItemGroupsService.assignItemToNamedGroup({
          scope: { workspaceLocalId: workspaceId },
          itemId: result.id,
          ...additions.sidebarItemGroupName,
        });
      } catch {
        groupError =
          'The task was created, but could not be added to the group.';
      }
    }
    let chat: PortalTaskFirstChatResult | undefined;
    let chatError: string | undefined;
    if (additions.firstChat) {
      try {
        chat = await createTaskFirstChat({
          commandId: command.id,
          workspaceId,
          worktreeId: result.id,
          firstChat: additions.firstChat,
          context,
        });
      } catch (error) {
        logMainProcessWarn(
          'Portal task first chat failed after worktree creation',
          {
            error,
          },
        );
        chatError =
          'The task was created, but its first chat message could not be sent.';
      }
    }
    const response: PortalWorktreeCreateResult = {
      ...result,
      ...(chat ? { chat } : {}),
      ...(groupError ? { groupError } : {}),
      ...(chatError ? { chatError } : {}),
    };
    recordWorktreeCrudTelemetry({
      action: 'create',
      workspaceId,
      source: 'portal',
    });
    await broadcastWorktreeListToRenderer(context, workspaceId);
    context.complete(command, response);
    await broadcastWorkspaceWorktrees(context, workspaceId);
  } catch (error) {
    if (error instanceof WorktreeCreationRefusedError) {
      const existingWorktreeId =
        error.reason === 'branch-checked-out' && error.checkoutPath
          ? await findManagedCheckoutWorktreeId(workspaceId, error.checkoutPath)
          : undefined;
      failWorktreeCreateRefusal(
        command,
        context,
        error.reason,
        existingWorktreeId,
      );
      return;
    }
    context.fail(
      command,
      'execution_failed',
      GENERIC_WORKTREE_CREATE_FAILURE,
      false,
    );
  }
}

/**
 * Best-effort renderer refresh after a committed mutation. Runs OUTSIDE the
 * command's try/catch and after `context.complete` on purpose: the mutation
 * has already succeeded, so a failed follow-up read must not misreport the
 * command as failed (the renderer converges on its next full load instead).
 */
async function broadcastWorkspaceWorktrees(
  context: PortalAdapterContext,
  workspaceId: string,
): Promise<void> {
  try {
    const worktrees = await readWorkspaceWorktrees(workspaceId);
    sendToWindow(
      context.getWindow?.() ?? null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId, worktrees },
    );
  } catch {
    // Swallowed by design — see doc comment above; `no-console` bars logging.
  }
}

/**
 * Handle `portal.worktree.archive` — remove an active worktree from the
 * browser Remote Control sidebar and retain a restorable archive according to
 * the requested mode. The browser gates it behind the
 * `canopy-portal-destructive-actions` flag and a confirmation dialog, and this
 * adapter preserves the desktop-side safety the renderer IPC path applies:
 * the split-lock guard (refuse while a split PR is in progress), the
 * live-service cleanup callbacks, and the post-archive GitHub sync. Reuses the
 * exact renderer services (`archiveSingleRepoWorktree` /
 * `archiveMultiRepoWorktree`, dispatched by the persisted workspace type;
 * cowork rejected). The archive service resolves the origin `repoPath` itself
 * from the workspace config, so this adapter does not pass one.
 */
export async function handlePortalWorktreeArchive(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.worktree.archive']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.worktreeId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree archive payload: workspaceId and worktreeId are required.',
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  const worktreeId = payload.worktreeId;
  const mode = payload.mode;
  const expectedCreatedAt = payload.expectedCreatedAt;
  if (
    expectedCreatedAt !== undefined &&
    (typeof expectedCreatedAt !== 'string' || !expectedCreatedAt.trim())
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree archive payload.',
    );
    return;
  }
  if (mode !== undefined && mode !== 'archive' && mode !== 'delete') {
    context.fail(command, 'invalid_payload', 'Invalid worktree archive mode.');
    return;
  }
  const recovery =
    payload.recovery === undefined
      ? undefined
      : WorktreeRecoveryRequestSchema.safeParse(payload.recovery);
  if (
    recovery &&
    (!recovery.success || !recovery.data.expectedCreatedAt || context.origin)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree recovery request.',
    );
    return;
  }
  if (
    (payload.deleteBranch !== undefined &&
      typeof payload.deleteBranch !== 'boolean') ||
    (payload.deleteWithoutRetentionIfMissing !== undefined &&
      typeof payload.deleteWithoutRetentionIfMissing !== 'boolean') ||
    (payload.expectedBranchName !== undefined &&
      typeof payload.expectedBranchName !== 'string')
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree removal options.',
    );
    return;
  }
  if (
    context.origin &&
    (payload.deleteBranch !== undefined ||
      payload.deleteWithoutRetentionIfMissing !== undefined ||
      payload.expectedBranchName !== undefined)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Worktree removal options require a user confirmation.',
    );
    return;
  }
  const recoveryRequest = recovery?.success ? recovery.data : undefined;
  if (recoveryRequest && recoveryRequest.intent !== (mode ?? 'archive')) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree recovery intent.',
    );
    return;
  }
  // The discard description is user-only (CAN-5334); an agent gets the throw.
  const typedRefusal = payload.typedRefusal === true && !context.origin;

  try {
    // The archive boundary resolves the stable origin repo path itself from
    // the project config, so no `repoPath` is passed: the worktree's own
    // checkout is the directory being removed.
    const result = await withTypedArchiveRefusal(
      {
        typedRefusal,
        intent: worktreeRemovalIntent(mode !== 'delete'),
        workspaceId,
        worktreeId,
        archiveTrigger: context.origin ? 'agent' : 'manual',
        expectedCreatedAt:
          recoveryRequest?.expectedCreatedAt ?? expectedCreatedAt,
      },
      () =>
        archiveWorktree(
          {
            workspaceId,
            worktreeId,
            expectedCreatedAt:
              recoveryRequest?.expectedCreatedAt ?? expectedCreatedAt,
            archiveTrigger: context.origin ? 'agent' : 'manual',
            source: 'portal',
            ...(typeof payload.deleteBranch === 'boolean'
              ? { deleteBranch: payload.deleteBranch }
              : {}),
            ...(typeof payload.deleteWithoutRetentionIfMissing === 'boolean'
              ? {
                  deleteWithoutRetentionIfMissing:
                    payload.deleteWithoutRetentionIfMissing,
                }
              : {}),
            ...(typeof payload.expectedBranchName === 'string'
              ? { expectedBranchName: payload.expectedBranchName }
              : {}),
            ...(mode !== 'delete' ? { lockAfterArchive: true } : {}),
          },
          { telemetryParent: 'inherit' },
        ),
    );
    if (result.refusal) {
      context.complete(command, result);
      return;
    }
    await broadcastWorktreeListToRenderer(context, workspaceId);
    context.complete(command, result);
    await broadcastWorkspaceWorktrees(context, workspaceId);
  } catch (error) {
    if (error instanceof WorktreeArchiveRefusedError) {
      context.fail(
        command,
        error.reason === 'not-found' ? 'not_found' : 'invalid_payload',
        error.reason === 'source-unavailable' &&
          (await isDiscardableForMissingSource(workspaceId, worktreeId))
          ? WORKTREE_SOURCE_MISSING_DISCARD_POINTER
          : error.message,
      );
      return;
    }
    failServiceError(command, context, error);
  }
}

/**
 * CAN-5336: an untyped refusal (mobile, external agents, older web) for a
 * source that is gone points at the discard instead of retrying. Typed
 * requests get the description and never reach this copy.
 */
export const WORKTREE_SOURCE_MISSING_DISCARD_POINTER =
  "This worktree's source repository is missing. If it's on a disconnected drive or share, reconnect it and retry. Otherwise, discard it in the desktop app or on the web.";

async function isDiscardableForMissingSource(
  workspaceId: string,
  worktreeId: string,
): Promise<boolean> {
  const description = await describeWorktreeDiscard(
    workspaceId,
    worktreeId,
  ).catch(() => null);
  return (
    description?.status === 'discardable' &&
    description.causes.includes('source-gone')
  );
}

function readDiscardTarget(payload: unknown): {
  workspaceId: string;
  worktreeId: string;
  confirmation?: string;
  /** CAN-5338: any value but `true` describes as without it. */
  retainedArchives?: true;
} | null {
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.worktreeId !== 'string' ||
    (payload.confirmation !== undefined &&
      typeof payload.confirmation !== 'string')
  )
    return null;
  try {
    validateId(payload.workspaceId, 'workspaceId');
    validateId(payload.worktreeId, 'worktreeId');
  } catch {
    return null;
  }
  return {
    workspaceId: payload.workspaceId,
    worktreeId: payload.worktreeId,
    ...(typeof payload.confirmation === 'string'
      ? { confirmation: payload.confirmation }
      : {}),
    ...(payload.retainedArchives === true
      ? { retainedArchives: true as const }
      : {}),
  };
}

/**
 * Handle `portal.worktree.discard.describe` (CAN-5334): the read-only
 * description of a worktree whose ordinary removal cannot finish. User-only:
 * a command an external agent sent is refused.
 */
export async function handlePortalWorktreeDiscardDescribe(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  if (context.origin) {
    context.fail(command, 'forbidden', 'Only a person can discard a worktree.');
    return;
  }
  const target = readDiscardTarget(command.payload);
  if (!target) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree discard payload: workspaceId and worktreeId are required.',
    );
    return;
  }
  try {
    const options = {
      ...(target.retainedArchives ? { retainedArchives: true } : {}),
      ...(isRecord(command.payload) && command.payload.recovery !== undefined
        ? {
            recovery: WorktreeRecoveryRequestSchema.parse(
              command.payload.recovery,
            ),
          }
        : {}),
    };
    context.complete(
      command,
      Object.keys(options).length > 0
        ? await describeWorktreeDiscard(
            target.workspaceId,
            target.worktreeId,
            options,
          )
        : await describeWorktreeDiscard(target.workspaceId, target.worktreeId),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * Handle `portal.worktree.discard` (CAN-5334): the permanent, user-only
 * discard bound to a description's confirmation. It resolves typed refusals
 * as results, and is gated as destructive server-side. Its post-discard
 * effects, the list broadcast included, are the shared helper's, as on IPC.
 */
export async function handlePortalWorktreeDiscard(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  if (context.origin) {
    context.fail(command, 'forbidden', 'Only a person can discard a worktree.');
    return;
  }
  const target = readDiscardTarget(command.payload);
  if (!target?.confirmation) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree discard payload: workspaceId, worktreeId and confirmation are required.',
    );
    return;
  }
  try {
    context.complete(
      command,
      await discardWorktreeFromInterface({
        workspaceId: target.workspaceId,
        worktreeId: target.worktreeId,
        confirmation: target.confirmation,
        source: 'portal-ui',
        ...(target.retainedArchives ? { retainedArchives: true } : {}),
      }),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}
