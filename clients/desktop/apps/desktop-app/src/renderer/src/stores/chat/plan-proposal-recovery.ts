// Re-runs committed plan proposals whose tracked plan the renderer has not
// linked yet: a plan save that failed, or a proposal event that arrived before
// its tab was installed.
import { isPlanProposal } from '@canopy/desktop-shared/plan-review';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { chatStoreApi } from './store-ref';
import { chatScopeKey } from './revisioned-sync';

export function recoverUntrackedPlanProposals(
  projectId: string,
  worktreeId: string,
): void {
  if (isPairedComputerId(projectId)) return;
  const state = chatStoreApi().getState();
  for (const tab of state.worktreeChats[chatScopeKey(projectId, worktreeId)]
    ?.tabs ?? []) {
    const input = tab.pendingPlanExit;
    const source = input?.source;
    if (
      tab.pendingPlanExitRequestId &&
      input &&
      (source === 'cursor' || source === 'codex' || source === 'antigravity') &&
      isPlanProposal(input)
    ) {
      state.handlePlanExitRequest(
        {
          projectId,
          worktreeId,
          chatId: tab.id,
          requestId: tab.pendingPlanExitRequestId,
          source,
          toolInput: input,
        },
        'recover',
      );
    }
  }
}
