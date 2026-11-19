import { createHash } from 'node:crypto';
import { ArchiveRecoveryRefusedError } from '@canopy/desktop-shared/node/archive-recovery-store';
import type { ProjectDeletionPendingRecovery } from '@canopy/protocol/remote-control/shell/project-deletion-discard';
import { archiveRecoveryStore } from './archive-recovery-refs';
import { qualifyArchiveRecoveryRefDeletion } from './archived-container-git';

/** Read-only qualification. Unknown ownership is not an unresumable resolution. */
export async function describePendingArchiveRecoveries(
  workspaceId: string,
): Promise<ProjectDeletionPendingRecovery[]> {
  const store = archiveRecoveryStore();
  const result: ProjectDeletionPendingRecovery[] = [];
  for (const receipt of await store.list(workspaceId)) {
    if (receipt.cancelled || receipt.stage === 'completed') continue;
    const evidence = await store.inspect(receipt);
    if (!evidence.effectFree && !canDiscardUnresumableArchiveRecovery(evidence))
      throw new ArchiveRecoveryRefusedError(
        `Archive resolution ${receipt.operationId} must be resumed before project deletion.`,
      );
    try {
      await qualifyArchiveRecoveryRefDeletion(receipt);
    } catch (cause) {
      throw new ArchiveRecoveryRefusedError(
        `Archive resolution ${receipt.operationId} has unverified retained refs.`,
        cause,
      );
    }
    result.push({
      operationId: receipt.operationId,
      confirmation: createHash('sha256')
        .update(
          JSON.stringify({
            receipt,
            reset: evidence.reset,
            copies: evidence.copies,
            payload: evidence.payload,
          }),
        )
        .digest('hex'),
    });
  }
  return result;
}

function canDiscardUnresumableArchiveRecovery(evidence: {
  classification: { conflict: boolean };
  payload: string;
}): boolean {
  return (
    evidence.classification.conflict &&
    (evidence.payload === 'exact' || evidence.payload === 'absent')
  );
}
