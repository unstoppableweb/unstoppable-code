import { AsyncLocalStorage } from 'node:async_hooks';
import type { ArchiveRecoveryReceipt } from '@canopy/desktop-shared/node/archive-recovery-store';
import type { ProjectDeletionPendingRecovery } from '@canopy/protocol/remote-control/shell/project-deletion-discard';

const confirmed = new AsyncLocalStorage<{
  workspaceId: string;
  active: boolean;
  members: readonly ProjectDeletionPendingRecovery[];
}>();

export function confirmedPendingArchiveRecoveries(): readonly ProjectDeletionPendingRecovery[] {
  const scope = confirmed.getStore();
  return scope?.active ? scope.members : [];
}

export async function withConfirmedPendingArchiveRecoveries<T>(
  workspaceId: string,
  members: readonly ProjectDeletionPendingRecovery[],
  run: () => Promise<T>,
): Promise<T> {
  const scope = { workspaceId, members, active: true };
  return confirmed.run(scope, async () => {
    try {
      return await run();
    } finally {
      scope.active = false;
    }
  });
}

export function isConfirmedPendingArchiveRecovery(
  receipt: ArchiveRecoveryReceipt,
): boolean {
  return (
    confirmed.getStore()?.workspaceId === receipt.workspaceId &&
    confirmedPendingArchiveRecoveries().some(
      (member) => member.operationId === receipt.operationId,
    )
  );
}
