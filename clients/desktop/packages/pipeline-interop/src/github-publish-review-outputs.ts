// ---------------------------------------------------------------------------
// The `github-publish-review` host step's outputs, shared by the executor's
// contract (`@canopy/execution-engine/pipelines/host-publish-review`), the
// desktop host, the Node fallback and the web core's cloud host step, which
// can't load the execution engine. Browser-safe.
// ---------------------------------------------------------------------------

import type { ReviewPublishResult } from '@canopy/protocol/canopy-core';

/**
 * Every output the action declares except `failure_reason`, which the
 * runner reserves.
 */
export const PUBLISH_REVIEW_OUTPUTS = [
  'status',
  'review_id',
  'review_url',
  'approval_state',
  'approval_reason',
  'approval_min_score',
  'unavailable_reason',
  'publish_failure_reason',
  'inline_comment_count',
  'thread_reply_count',
  'thread_resolve_count',
  'dismissed_approval_count',
] as const;

/** Every output `''`. */
export function emptyPublishReviewOutputs(): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const name of PUBLISH_REVIEW_OUTPUTS) {
    outputs[name] = '';
  }
  return outputs;
}

/** A publish result as the step's outputs. */
export function publishReviewOutputs(
  result: ReviewPublishResult,
): Record<string, string> {
  const outputs = emptyPublishReviewOutputs();
  outputs.status = result.status;
  switch (result.status) {
    case 'published':
      outputs.review_id = result.reviewId;
      outputs.review_url = result.reviewUrl;
      outputs.approval_state = result.approval.state;
      outputs.approval_reason = result.approval.reason;
      outputs.approval_min_score = String(result.approval.minScore);
      outputs.inline_comment_count = String(result.counts.inline);
      outputs.thread_reply_count = String(result.counts.replies);
      outputs.thread_resolve_count = String(result.counts.resolved);
      outputs.dismissed_approval_count = String(
        result.counts.dismissedApprovals,
      );
      break;
    case 'unavailable':
      outputs.unavailable_reason = result.reason;
      break;
    case 'failed':
      outputs.publish_failure_reason = result.reason;
      break;
  }
  return outputs;
}
