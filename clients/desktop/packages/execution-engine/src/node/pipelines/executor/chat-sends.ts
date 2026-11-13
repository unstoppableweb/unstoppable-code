import type {
  ExecutionState,
  PipelineChatSendRecord,
} from '@canopy/execution-engine/types/pipeline';

/**
 * Every `chat_send` record of one execution, in step completion order.
 *
 * Walks jobs (matrix variants are flat jobs) and their steps in insertion
 * order, keeps every record whatever the step's status (a failed steer still
 * delivered its message), then stable-sorts by `completed_at`; ties and
 * missing timestamps keep walk order. A child pipeline's sends live on the
 * child's execution and are not collected here. A job or variant retry and a
 * `max_iterations` loop reset `job.steps`, so only each step's latest attempt
 * and iteration is listed; earlier ones live in the job's history.
 */
export function listExecutionChatSends(
  state: ExecutionState,
): PipelineChatSendRecord[] {
  const found: { record: PipelineChatSendRecord; completedAt?: string }[] = [];
  for (const job of Object.values(state.jobs)) {
    for (const step of Object.values(job.steps)) {
      if (step.chat_send !== undefined) {
        found.push({
          record: step.chat_send,
          ...(step.completed_at !== undefined
            ? { completedAt: step.completed_at }
            : {}),
        });
      }
    }
  }
  // A record without a usable timestamp takes its predecessor's, so it stays
  // right after it in walk order and the sort remains a total order.
  let previous = Number.NEGATIVE_INFINITY;
  const keyed = found.map((entry, index) => {
    const parsed =
      entry.completedAt !== undefined ? Date.parse(entry.completedAt) : NaN;
    const time = Number.isNaN(parsed) ? previous : parsed;
    previous = time;
    return { record: entry.record, index, time };
  });
  keyed.sort((a, b) => a.time - b.time || a.index - b.index);
  return keyed.map((entry) => entry.record);
}
