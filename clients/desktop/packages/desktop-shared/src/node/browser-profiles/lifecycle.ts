import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { randomUUID } from 'node:crypto';
import { browserTaskScopeTuple } from '@canopy/protocol/browser-profiles';
import { type BrowserProfileRepository } from './repository';
import {
  browserTaskOwnerIds,
  legacyBrowserPartition,
  legacyBrowserPartitionOwners,
  type BrowserTaskOwner,
} from './owners';
import { errorCode } from './storage';

export const DEFERRED_BROWSER_RETIREMENT_WARNING =
  'Browser data for this worktree will be cleared the next time the app starts.';

export async function uniquelyOwnedLegacyPartition(
  repository: BrowserProfileRepository,
  dataRoot: string,
  owner: BrowserTaskOwner,
): Promise<string | undefined> {
  const partition = legacyBrowserPartition(owner.projectId, owner.worktreeId);
  const owners = new Set(
    (await legacyBrowserPartitionOwners(dataRoot, partition)).map((entry) =>
      browserTaskScopeTuple(entry.scope),
    ),
  );
  for (const slot of await repository.listTaskSlots()) {
    const ids = browserTaskOwnerIds(slot.scope);
    if (legacyBrowserPartition(ids.projectId, ids.worktreeId) === partition)
      owners.add(browserTaskScopeTuple(slot.scope));
  }
  return owners.size === 1 && owners.has(browserTaskScopeTuple(owner.scope))
    ? partition
    : undefined;
}

/** Call before the owner's irreversible work; commit only with an owner receipt. */
export async function prepareBrowserTaskRetirement(
  repository: BrowserProfileRepository,
  dataRoot: string,
  owner: BrowserTaskOwner,
  resolveLegacyPartition: () => Promise<string | undefined> = () =>
    uniquelyOwnedLegacyPartition(repository, dataRoot, owner),
): Promise<string | null> {
  let slot = await repository.getTask(owner.scope);
  if (slot?.lifecycle === 'retired' && slot.ownerCreatedAt === owner.createdAt)
    return null;
  if (slot?.lifecycle === 'retired')
    slot = await repository.ensureSlot(
      owner.scope,
      owner.createdAt,
      randomUUID(),
    );
  if (slot?.lifecycle === 'retirement_pending' && slot.retirementOperationId) {
    const pending = (await repository.getRetirements()).find(
      (entry) => entry.operationId === slot.retirementOperationId,
    );
    if (!pending || slot.ownerCreatedAt !== owner.createdAt)
      throw new BrowserProfileError(
        'recovery_required',
        'A different task incarnation has pending browser retirement.',
      );
    if (pending.initiatorPid !== process.pid) {
      try {
        process.kill(pending.initiatorPid, 0);
      } catch (error) {
        if (errorCode(error) === 'ESRCH') return pending.operationId;
        throw error;
      }
      throw new BrowserProfileError(
        'storage_unavailable',
        'Another process is retiring this browser task.',
      );
    }
    return pending.operationId;
  }
  const id = randomUUID();
  const legacy = slot?.legacyOwnershipResolved
    ? undefined
    : await resolveLegacyPartition();
  await repository.prepareRetirement(owner.scope, owner.createdAt, id, legacy);
  return id;
}
