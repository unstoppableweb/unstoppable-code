import type { RemoteControlChatSummaryEntity } from '@canopy/protocol/remote-control/shell';
import { mapWithConcurrency } from '../lib/concurrency';
import { listWorktreeChatSummaries } from './chat-service';

export interface WorktreeChatSummaryTarget {
  workspaceLocalId: string;
  worktreeLocalId: string;
}

/** Reuses the sidebar batch's four-worktree I/O bound. The caller supplies
 * authorized pairs. Activity uses the strict default reader; the existing
 * Portal batch supplies its tolerant reader to retain its error semantics.
 */
export async function listWorktreeChatSummaryBatch(
  targets: readonly WorktreeChatSummaryTarget[],
  read: (
    target: WorktreeChatSummaryTarget,
  ) => Promise<RemoteControlChatSummaryEntity[]> = (target) =>
    listWorktreeChatSummaries({
      workspaceId: target.workspaceLocalId,
      worktreeId: target.worktreeLocalId,
    }),
): Promise<
  Array<{
    target: WorktreeChatSummaryTarget;
    summaries: RemoteControlChatSummaryEntity[];
  }>
> {
  return mapWithConcurrency([...targets], 4, async (target) => ({
    target,
    summaries: await read(target),
  }));
}
