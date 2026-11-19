import type { ReviewPublishResult } from '@canopy/protocol/canopy-core';
import type { AgentActionCatalogEntry } from '../../catalog/types';
import {
  agentActionFingerprint,
  agentActionIdempotencyKey,
  agentActionResult,
  portErrorResponse,
} from '../../action-support';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
  type AgentActionFamilyJsonSchema,
} from '../../surface/family';
import {
  PULL_REQUEST_REVIEW_ACTION_TYPES,
  pullRequestReviewActionSchema,
  reviewPublishRequestOf,
  type AgentReviewPublishRequest,
} from './actions';

export {
  PULL_REQUEST_REVIEW_ACTION_TYPES,
  pullRequestReviewActionSchema,
  type AgentReviewPublishRequest,
} from './actions';

/**
 * The backend `pull_request.review.publish` runs on: the
 * `core.pullRequest.review.publish` operation, as the calling chat's
 * signed-in person and for the chat's owner, which the host supplies from
 * the trusted call. Every publication outcome is a result, never a throw;
 * only a host that can't act at all throws an `AgentPortError`.
 */
export interface AgentPullRequestReviewPort<H> {
  publish(
    request: AgentReviewPublishRequest,
    idempotencyKey: string,
    call: AgentActionCall<H>,
  ): Promise<ReviewPublishResult>;
}

/**
 * `pull_request.review.publish`: a code review posted as the GitHub App,
 * approving when the owner's code review approval policy allows it. The
 * server keys each publication by this tool call's key, so a retried call
 * answers the first call's result without posting again; no receipt store.
 */
export function createPullRequestReviewActionFamily<H>(options: {
  port: AgentPullRequestReviewPort<H>;
}): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'pull-request-review',
    types: PULL_REQUEST_REVIEW_ACTION_TYPES,
    actionSchema: pullRequestReviewActionSchema,
    supportedTypes: () => PULL_REQUEST_REVIEW_ACTION_TYPES,
    catalog: pullRequestReviewActionCatalog,
    dispatchJsonSchema: pullRequestReviewDispatchJsonSchema,
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      try {
        const result = await options.port.publish(
          reviewPublishRequestOf(action),
          publicationKey(action, call),
          call,
        );
        return agentActionResult(call, action.type, { ...result });
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}

/**
 * The tool call's replay key plus the review's fingerprint. The server keys a
 * publication by it and answers a repeat with the stored result, so a
 * tool-use id that repeats across connections must never make a different
 * review replay an earlier one instead of posting. Without a tool-use id the
 * replay key already ends in the same fingerprint; the repeat is harmless.
 */
function publicationKey<H>(
  action: Parameters<typeof reviewPublishRequestOf>[0],
  call: AgentActionCall<H>,
): string {
  return `${agentActionIdempotencyKey(action.type, call, action)}:${agentActionFingerprint(action)}`;
}

export function pullRequestReviewActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'pull_request.review.publish',
      category: 'git',
      summary:
        "Post a code review to a GitHub pull request as the GitHub App, not with the user's own account. The App approves the pull request only when the owner's code review approval policy allows it: the verdict is pass, the score meets the policy minimum, the review is complete, it covered the pull request's current head, and the user can push to the repository. Otherwise it posts as a comment.",
      fields: [
        {
          name: 'pullRequest',
          type: 'string',
          required: true,
          description:
            'The pull request: a GitHub URL or owner/repository#number.',
        },
        {
          name: 'body',
          type: 'string',
          required: true,
          description:
            'The review summary in Markdown, at most 65,000 characters.',
        },
        {
          name: 'comments',
          type: 'array',
          required: false,
          description:
            'Inline comments: { path, body, line, start_line?, side?, start_side? } on lines in the diff, or { path, body, subject_type: "file" } for a file-level comment. At most 200.',
        },
        {
          name: 'replies',
          type: 'array',
          required: false,
          description:
            'Replies to existing review threads: { body, comment_id or thread_id, resolve? }. Only threads the App wrote are resolved. At most 200.',
        },
        {
          name: 'reviewedHead',
          type: 'string',
          required: true,
          description:
            'The full commit SHA the review covered, normally the pull request head when the review started.',
        },
        {
          name: 'reviewedUncommitted',
          type: 'boolean',
          required: true,
          description:
            'Whether the review included uncommitted local changes. true never approves.',
        },
        {
          name: 'verdict',
          type: 'string',
          required: true,
          description:
            'pass when the review passed; anything else never approves.',
        },
        {
          name: 'score',
          type: 'number',
          required: true,
          description:
            'The review score, an integer from 1 to 10 (10 is safest), or null.',
        },
        {
          name: 'complete',
          type: 'boolean',
          required: true,
          description:
            'Whether every part of the review ran, for example every requested reviewer answered.',
        },
      ],
      example: {
        type: 'pull_request.review.publish',
        pullRequest: 'octo-org/widgets#42',
        body: '## Code review\n\nNo blocking issues.',
        comments: [
          { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Minor: rename.' },
        ],
        reviewedHead: '0123456789abcdef0123456789abcdef01234567',
        reviewedUncommitted: false,
        verdict: 'pass',
        score: 9,
        complete: true,
      },
      keywords: [
        'code review',
        'review',
        'approve',
        'approval',
        'pull request',
        'pr',
        'github',
        'github app',
        'publish',
        'post review',
      ],
      notes: [
        'Result status published: the App posted it; approval.state says whether it approved and approval.reason why.',
        'Status unavailable: nothing was posted (for example the feature is off or GitHub is not connected). You may post the same review with gh instead.',
        'Status failed: the review may already be on the pull request. Never post it again another way.',
        'An error response with code execution_failed may follow a request that reached GitHub: treat it like status failed. Any other error code (for example invalid_payload or invalid_target) means nothing was posted.',
        "Use the pull request's head SHA from when the review started as reviewedHead. The review body, comments and replies must fit in 512 KiB as JSON.",
        'Report the verdict, score and completeness honestly: they decide whether the App approves.',
      ],
    },
  ];
}

const SIDE: AgentActionFamilyJsonSchema['properties'][string] = {
  type: 'string',
  enum: ['LEFT', 'RIGHT'],
};
const LINE: AgentActionFamilyJsonSchema['properties'][string] = {
  type: 'integer',
  minimum: 1,
};

export const pullRequestReviewDispatchJsonSchema: AgentActionFamilyJsonSchema =
  {
    properties: {
      pullRequest: {
        type: 'string',
        description:
          'For pull_request.review.publish: a GitHub pull request URL or owner/repository#number.',
      },
      body: { type: 'string', minLength: 1, maxLength: 65_000 },
      comments: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'body'],
          properties: {
            path: { type: 'string', minLength: 1 },
            body: { type: 'string', minLength: 1 },
            line: LINE,
            start_line: LINE,
            side: SIDE,
            start_side: SIDE,
            subject_type: { type: 'string', enum: ['line', 'file'] },
          },
        },
      },
      replies: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['body'],
          properties: {
            body: { type: 'string', minLength: 1 },
            comment_id: { type: 'integer', minimum: 1 },
            thread_id: { type: 'string', minLength: 1 },
            resolve: { type: 'boolean' },
            action: { type: 'string', maxLength: 64 },
          },
        },
      },
      reviewedHead: {
        type: 'string',
        pattern: '^(?:|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$',
      },
      reviewedUncommitted: { type: 'boolean' },
      verdict: { type: 'string', maxLength: 64 },
      score: { type: ['number', 'null'] },
      complete: { type: 'boolean' },
    },
    allOf: [
      {
        if: {
          properties: { type: { const: 'pull_request.review.publish' } },
        },
        then: {
          required: [
            'pullRequest',
            'body',
            'reviewedHead',
            'reviewedUncommitted',
            'verdict',
            'score',
            'complete',
          ],
        },
      },
    ],
  };
