import { randomUUID } from 'node:crypto';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import {
  CORE_PULL_REQUEST_GRANTS,
  CorePullRequestCreateParamsSchema,
  CorePullRequestPatchSchema,
  GITHUB_INTEGRATION_ID,
  type CorePullRequest,
  type CorePullRequestCreateParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  mintPullRequestId,
  mintRepositoryId,
  sameGitHubRepository,
  type GitHubRepositoryRef,
  type RecordedRepositoryRef,
} from '@canopy/core-runtime/node/github';
import {
  runInGitHubProjection,
  type PullRequestWriteCapture,
  type PullRequestMergeCapture,
} from '../github/projection-capture';
import { getRemoteUrl, resolveRefSha } from '../lib/git';
import {
  createPrForRepo,
  mergePrForRepo,
  type MergePrForRepoResult,
  parseGitHubRemote,
  updatePrBaseBranchForRepo,
} from '../lib/github-pr';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import {
  desktopCorePullRequestHost,
  type CorePullRequestDispatcher,
} from './core-pull-request-adapter';
import {
  hostError,
  withGrant,
  type LazyCaller,
} from './github-pull-request-dispatch';

/*
 * The `core.pullRequest.create` and `update` projections behind
 * `github:create-pr` and `github:update-pr-base-branch` (CAN-4109). Each
 * dispatched call holds only its operation's grant and a fresh idempotency
 * key. A checkout whose `origin` is not its recorded repository's keeps the
 * direct write, as recorded debt; so does a call the canonical params cannot
 * carry, so no legacy request turns into a validation failure.
 */

/** What `processRepoForPr` passes to its GitHub create step. */
export interface PullRequestCreateStepInput {
  readonly projectId: string;
  readonly worktreeId: string;
  /** The repository entry's id: a multi-repo member, or the root. */
  readonly repoId: string | undefined;
  /** The worktree checkout the flow committed and pushed. */
  readonly repoPath: string;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
}

export interface PullRequestCreateStepResult {
  prNumber: number;
  prUrl: string;
  /** False when GitHub's open pull request for the branch was adopted. */
  created: boolean;
}

/** The composed flow's GitHub create step; it is never aborted once sent. */
export type PullRequestCreateStep = (
  input: PullRequestCreateStepInput,
) => Promise<PullRequestCreateStepResult>;

const STATE_CHANGED = 'PR state changed. Refresh and try again.';

/** The direct create, for requests the dispatcher route cannot represent. */
function createPullRequestDirectly(
  input: PullRequestCreateStepInput,
  verifiedRepository?: GitHubRepositoryRef,
): Promise<PullRequestCreateStepResult> {
  return createPrForRepo(
    input.repoPath,
    input.headBranch,
    input.title,
    input.body,
    input.baseBranch,
    false,
    verifiedRepository,
  );
}

interface RecordedCheckout {
  readonly repository: RecordedRepositoryRef;
  readonly repositoryId: string;
  readonly github: GitHubRepositoryRef;
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof CanopyOperationError &&
    error.payload.code !== undefined &&
    codes.includes(error.payload.code)
  );
}

/** Caller identity failures are never answered by the direct write. */
function refusedCaller(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    (error.payload.kind === 'permission_denied' ||
      error.payload.kind === 'unauthenticated')
  );
}

/**
 * The recorded repository a worktree checkout belongs to, when its `origin`
 * names the GitHub repository the record's `origin` names; `null` otherwise
 * (no record, an unreadable record, a read-only workspace, another remote).
 */
async function recordedCheckout(
  projectId: string,
  repoId: string | undefined,
  repoPath: string,
): Promise<RecordedCheckout | null> {
  const member =
    isMultiRepoWorkspace(projectId) &&
    repoId !== undefined &&
    repoId !== WORKSPACE_ROOT_REPO_ID
      ? repoId
      : undefined;
  const repository: RecordedRepositoryRef = {
    workspaceId: projectId,
    ...(member === undefined ? {} : { repoId: member }),
  };
  const repositoryId = mintRepositoryId(repository);
  if (repositoryId === null) return null;
  const recorded = await desktopCorePullRequestHost
    .resolveRepository(repository, 'write')
    .catch(() => null);
  if (recorded === null) return null;
  const checkoutUrl = await getRemoteUrl(repoPath);
  const checkout = checkoutUrl ? parseGitHubRemote(checkoutUrl) : null;
  if (checkout === null || !sameGitHubRepository(checkout, recorded))
    return null;
  return { repository, repositoryId, github: recorded };
}

/** The commit `origin`'s remote-tracking branch names, after the push or fetch. */
async function originHead(
  repoPath: string,
  branch: string,
): Promise<string | null> {
  const sha = (
    await resolveRefSha(
      repoPath,
      `refs/remotes/origin/${branch}^{commit}`,
    ).catch(() => '')
  ).trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha) ? sha : null;
}

function capturedCreate(
  written: NonNullable<PullRequestWriteCapture['written']>,
): PullRequestCreateStepResult {
  return {
    prNumber: written.number,
    prUrl: written.url,
    created: written.created,
  };
}

/**
 * The create step for `github:create-pr`: `core.pullRequest.create` with the
 * pushed head as `expectedHeadSha`. It returns what GitHub created or
 * adopted even when the read after it fails, rethrows the host error for
 * the flow's base-branch fallback and authentication codes, and reports a
 * head that moved as the flow's other identity checks do.
 */
export function dispatchedPullRequestCreate(
  dispatcher: CorePullRequestDispatcher,
  resolveCaller: LazyCaller,
): PullRequestCreateStep {
  return async (input) => {
    const binding = await recordedCheckout(
      input.projectId,
      input.repoId,
      input.repoPath,
    );
    const expectedHeadSha =
      binding === null
        ? null
        : await originHead(input.repoPath, input.headBranch);
    const params: CorePullRequestCreateParams | null =
      binding === null || expectedHeadSha === null
        ? null
        : {
            integrationId: GITHUB_INTEGRATION_ID,
            repositoryId: binding.repositoryId,
            title: input.title,
            body: input.body,
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            expectedHeadSha,
            draft: false,
          };
    if (
      params === null ||
      !CorePullRequestCreateParamsSchema.safeParse(params).success
    )
      return createPullRequestDirectly(input, binding?.github);
    const caller = withGrant(resolveCaller(), CORE_PULL_REQUEST_GRANTS.write);
    const capture: PullRequestWriteCapture = { kind: 'write' };
    try {
      await runInGitHubProjection(capture, () =>
        dispatcher.instruction('core.pullRequest.create', params, {
          caller,
          metadata: { idempotencyKey: randomUUID() },
        }),
      );
    } catch (error) {
      if (capture.written) return capturedCreate(capture.written);
      if (
        hasCode(
          error,
          'core.pullRequest.create.headMissing',
          'core.pullRequest.create.headMismatch',
        )
      )
        throw new Error(STATE_CHANGED);
      // The record changed after the binding was read; nothing was sent.
      if (
        !capture.mutationSent &&
        hasCode(error, 'core.pullRequest.repositoryUnavailable')
      )
        return createPullRequestDirectly(input, binding?.github);
      throw hostError(error);
    }
    if (!capture.written)
      throw new Error('Pull request creation projection was not captured.');
    return capturedCreate(capture.written);
  };
}

export interface PullRequestBaseUpdateInput {
  readonly projectId: string;
  /** The requested member repository, or `undefined` for the root. */
  readonly repoId: string | undefined;
  readonly repoPath: string;
  readonly prNumber: number;
  readonly newBaseBranch: string;
}

/**
 * `github:update-pr-base-branch` after its validation: the current revision
 * through `core.pullRequest.get`, then a base-only `core.pullRequest.update`.
 * It returns the URL of the update it captured. Until GitHub is asked to
 * update, a canonical refusal (the revision read failing, the revision
 * moving, the record changing) keeps today's direct update, which needs
 * neither; once the update is sent, its host error is rethrown.
 */
export async function updatePullRequestBaseForIpc(
  dispatcher: CorePullRequestDispatcher,
  resolveCaller: LazyCaller,
  input: PullRequestBaseUpdateInput,
): Promise<{ prUrl: string }> {
  // First, so an untracked sender is refused on the direct path too.
  const caller = resolveCaller();
  const binding = await recordedCheckout(
    input.projectId,
    input.repoId,
    input.repoPath,
  );
  const direct = (): Promise<{ prUrl: string }> =>
    updatePrBaseBranchForRepo(
      input.repoPath,
      input.prNumber,
      input.newBaseBranch,
      binding?.github,
    );
  const pullRequestId =
    binding === null
      ? null
      : mintPullRequestId({
          repository: binding.repository,
          github: binding.github,
          number: input.prNumber,
        });
  const patch = {
    title: null,
    body: null,
    baseBranch: input.newBaseBranch,
    draft: null,
  };
  if (
    pullRequestId === null ||
    !CorePullRequestPatchSchema.safeParse(patch).success
  )
    return direct();
  let current: CorePullRequest;
  try {
    current = await dispatcher.query(
      'core.pullRequest.get',
      { pullRequestId, refresh: true },
      { caller: withGrant(caller, CORE_PULL_REQUEST_GRANTS.read) },
    );
  } catch (error) {
    if (refusedCaller(error)) throw error;
    return direct();
  }
  const capture: PullRequestWriteCapture = { kind: 'write' };
  try {
    await runInGitHubProjection(capture, () =>
      dispatcher.instruction(
        'core.pullRequest.update',
        { pullRequestId, expectedRevision: current.revision, patch },
        {
          caller: withGrant(caller, CORE_PULL_REQUEST_GRANTS.write),
          metadata: { idempotencyKey: randomUUID() },
        },
      ),
    );
  } catch (error) {
    if (capture.written) return { prUrl: capture.written.url };
    if (refusedCaller(error) || capture.mutationSent) throw hostError(error);
    return direct();
  }
  if (!capture.written)
    throw new Error('Pull request update projection was not captured.');
  return { prUrl: capture.written.url };
}

export interface PullRequestMergeStepInput {
  readonly projectId: string;
  readonly repoId: string | undefined;
  readonly repoPath: string;
  readonly prNumber: number;
  readonly expectedHeadSha: string;
}

export type PullRequestMergeStep = (
  input: PullRequestMergeStepInput,
) => Promise<MergePrForRepoResult>;

/** Unrepresentable legacy requests retain this bounded compatibility path. */
function mergePullRequestDirectly(
  input: PullRequestMergeStepInput,
  verifiedRepository?: GitHubRepositoryRef,
): Promise<MergePrForRepoResult> {
  return mergePrForRepo(input.repoPath, input.prNumber, input.expectedHeadSha, {
    verifiedRepository,
  });
}

/**
 * The IPC payload has neither revision nor strategy. Read both in the host's
 * projection context; a pre-send contract gap retains legacy behavior (CAN-5886).
 * Once the writer starts it is never invoked again by this projection.
 */
export function dispatchedPullRequestMerge(
  dispatcher: CorePullRequestDispatcher,
  resolveCaller: LazyCaller,
): PullRequestMergeStep {
  return async (input) => {
    const caller = resolveCaller();
    const binding = await recordedCheckout(
      input.projectId,
      input.repoId,
      input.repoPath,
    );
    const pullRequestId =
      binding === null
        ? null
        : mintPullRequestId({
            repository: binding.repository,
            github: binding.github,
            number: input.prNumber,
          });
    if (pullRequestId === null)
      return mergePullRequestDirectly(input, binding?.github);
    const capture: PullRequestMergeCapture = { kind: 'merge' };
    try {
      await runInGitHubProjection(capture, async () => {
        const current = await dispatcher.query(
          'core.pullRequest.get',
          { pullRequestId, refresh: true },
          { caller: withGrant(caller, CORE_PULL_REQUEST_GRANTS.read) },
        );
        if (capture.policy === undefined)
          throw new Error('Merge policy projection was not captured.');
        await dispatcher.instruction(
          'core.pullRequest.merge',
          {
            pullRequestId,
            expectedRevision: current.revision,
            expectedHeadSha: input.expectedHeadSha,
            strategy: capture.policy.preferredStrategy,
          },
          {
            caller: withGrant(caller, CORE_PULL_REQUEST_GRANTS.write),
            metadata: { idempotencyKey: randomUUID() },
          },
        );
      });
    } catch (error) {
      if (capture.result) return capture.result;
      if (refusedCaller(error)) throw hostError(error);
      if (hasCode(error, 'core.pullRequest.merge.headMismatch'))
        throw new Error(
          'Cannot retry the pull request merge because the PR head commit changed.',
        );
      if (
        hasCode(
          error,
          'core.pullRequest.merge.revisionConflict',
          'core.pullRequest.repositoryUnavailable',
        )
      )
        throw new Error(STATE_CHANGED);
      // A typed queue-required refusal proves no direct merge landed, even
      // when a ruleset changed after preflight. Legacy enqueue stays CAN-5886.
      if (hasCode(error, 'core.pullRequest.merge.mergeQueueRequired'))
        return mergePullRequestDirectly(input, binding?.github);
      if (capture.mutationSent) throw hostError(error);
      return mergePullRequestDirectly(input, binding?.github);
    }
    if (capture.result) return capture.result;
    // A canonical already-merged replay does not run the writer again.
    return {
      outcome: 'merged',
      newlyMerged: false,
      mergeMethod: capture.policy?.preferredStrategy ?? 'merge',
      mergeCommitSha: null,
    };
  };
}
