import {
  AgentPortError,
  type AgentPullRequestReviewPort,
} from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { agentPipelineOwnerContext } from '../pipelines/pipeline-owner-policy';
import {
  PUBLISH_REVIEW_CALL_TIMEOUT_MS,
  publishReviewOverWebCore,
  type PublishReviewHostDeps,
} from '../pipelines/host-publish-review';

type OwnerContext = Awaited<ReturnType<typeof agentPipelineOwnerContext>>;

/** Both attempts' deadlines, with room to settle the second. */
const PUBLISH_DEADLINE_MS = PUBLISH_REVIEW_CALL_TIMEOUT_MS * 2 + 30_000;

export interface DesktopPullRequestReviewPortDeps {
  /** The calling chat's project owner; injected in tests. */
  readonly ownerContext?: (chat: {
    projectId: string;
    worktreeId: string;
  }) => Promise<OwnerContext>;
  readonly publish?: typeof publishReviewOverWebCore;
  readonly hostDeps?: PublishReviewHostDeps;
}

/**
 * `pull_request.review.publish` on desktop: the same web core call as the
 * `github-publish-review` pipeline step, as the signed-in account, for the
 * calling chat's project owner (never the payload). The web core authorizes
 * the caller, the owner, the installation and the repository, so this port
 * does no access check of its own. Chats outside a project have no owner and
 * can't publish.
 */
export function createDesktopPullRequestReviewPort(
  deps: DesktopPullRequestReviewPortDeps = {},
): AgentPullRequestReviewPort<CanopyInjectedToolRuntime> {
  const ownerContext = deps.ownerContext ?? agentPipelineOwnerContext;
  const publish = deps.publish ?? publishReviewOverWebCore;
  return {
    publish: async (request, idempotencyKey, call) => {
      const scoped = call.host.worktreeActionRuntime;
      const chatId = call.scope?.chatId;
      if (!scoped || chatId === undefined)
        throw new AgentPortError(
          'invalid_target',
          'Only a project chat can post a code review as the GitHub App.',
        );
      const owner = await ownerContext({
        projectId: scoped.projectId,
        worktreeId: scoped.worktreeId,
      });
      if ('refusal' in owner)
        throw new AgentPortError('owner_context_unavailable', owner.refusal);
      try {
        return await publish(
          {
            owner: owner.owner,
            pr: request.pr,
            reviewedHead: request.reviewedHead,
            reviewedUncommitted: request.reviewedUncommitted,
            payload: request.payload,
            approvalFacts: request.approvalFacts,
            executionRef: `agent-chat:${chatId}`,
            idempotencyKey,
          },
          deps.hostDeps ?? {},
          AbortSignal.timeout(PUBLISH_DEADLINE_MS),
        );
      } catch {
        // The transport answers every outcome itself; it throws only when
        // this deadline ran out during a lost first attempt, before any
        // retry. That request may have posted, so the agent must not post
        // again another way. Catching every throw here is deliberate: an
        // unexpected one fails safe, with no second post through gh.
        return { status: 'failed', reason: 'outcome_unknown' };
      }
    },
  };
}

export const desktopPullRequestReviewPort =
  createDesktopPullRequestReviewPort();
