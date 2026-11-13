import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import type { BrowserTaskSlot } from '@canopy/protocol/browser-profiles';
import { prepareBrowserTaskRetirement } from '@canopy/desktop-shared/node/browser-profiles/lifecycle';
import {
  browserTaskOwnerIds,
  browserTaskScopesForOwnerIds,
  listBrowserTaskOwners,
  resolveBrowserTaskOwner,
} from '@canopy/desktop-shared/node/browser-profiles/owners';
import { getBrowserProfileService } from './browser-profile-service';
import { getBrowserService } from './browser-service-registry';
import { lstat } from 'node:fs/promises';
import { getWorkspaceWorktreeDir } from '../lib/paths';

export async function prepareTaskBrowserRetirement(
  projectId: string,
  worktreeId: string,
): Promise<string | null> {
  const service = getBrowserProfileService();
  await service.ensureReady();
  const owner = await resolveBrowserTaskOwner(
    service.dataRoot,
    projectId,
    worktreeId,
  );
  if (!owner) return null;
  const id = await prepareBrowserTaskRetirement(
    service.repository,
    service.dataRoot,
    owner,
  );
  try {
    if (id)
      await getBrowserService()?.disposeWorktreeViews(projectId, worktreeId);
  } catch (error) {
    if (id) await service.repository.abortRetirement(id);
    throw error;
  }
  return id;
}

/** Called at the verified Git commit or after entry/index removal, before purge. */
export async function commitTaskBrowserRetirement(
  projectId: string,
  worktreeId: string,
  kind: 'owner_removed' | 'git_quarantine' = 'owner_removed',
): Promise<boolean> {
  const service = getBrowserProfileService();
  const pending = (await service.repository.getRetirements()).filter(
    (entry) => {
      const ids = browserTaskOwnerIds(entry.scope);
      return ids.projectId === projectId && ids.worktreeId === worktreeId;
    },
  );
  if (pending.length > 1)
    throw new BrowserProfileError(
      'recovery_required',
      'Multiple browser task identities have pending retirement.',
    );
  for (const entry of pending) {
    await service.repository.commitRetirement(entry.operationId, {
      kind,
      ownerOperationId: entry.operationId,
    });
    await getBrowserService()?.cleanupRetiredTaskScratch(
      entry.scope,
      entry.incarnationId,
    );
  }
  await service.purgeRetired();
  const profileIds = await Promise.all(
    pending.map(
      async (entry) =>
        (await service.repository.getTask(entry.scope))?.taskProfileId,
    ),
  );
  return (await service.repository.getCleanupJobs()).some(
    (job) =>
      profileIds.includes(job.profileId) ||
      pending.some((entry) => entry.legacyPartition === job.partition),
  );
}

export async function abortTaskBrowserRetirement(
  operationId: string | null,
): Promise<void> {
  if (!operationId) return;
  const service = getBrowserProfileService();
  const pending = (await service.repository.getRetirements()).find(
    (entry) => entry.operationId === operationId,
  );
  if (pending) await service.repository.abortRetirement(operationId);
}

/** Rollback of a newly created import/restore destination owns only that destination. */
export async function withBrowserTaskOwnerRemoval<T>(
  projectId: string,
  worktreeId: string,
  removeOwner: () => Promise<T>,
): Promise<T> {
  const operationId = await prepareTaskBrowserRetirement(projectId, worktreeId);
  try {
    const result = await removeOwner();
    await commitTaskBrowserRetirement(projectId, worktreeId);
    return result;
  } catch (error) {
    await settleFailedTaskBrowserRetirement(operationId);
    throw error;
  }
}

/** A failed archive may already have committed Git quarantine. Never infer rollback from a thrown error. */
export async function settleFailedTaskBrowserRetirement(
  operationId: string | null,
): Promise<void> {
  if (!operationId) return;
  const service = getBrowserProfileService();
  const pending = (await service.repository.getRetirements()).find(
    (entry) => entry.operationId === operationId,
  );
  if (!pending) return;
  const ids = browserTaskOwnerIds(pending.scope);
  const owner = await resolveBrowserTaskOwner(
    service.dataRoot,
    ids.projectId,
    ids.worktreeId,
  );
  if (!owner || owner.createdAt !== pending.ownerCreatedAt) {
    await commitTaskBrowserRetirement(ids.projectId, ids.worktreeId);
    return;
  }
  if (pending.scope.kind === 'worktree') {
    // Defer the heavy Git/archive module until retirement recovery actually
    // needs to inspect a staged worktree quarantine.
    const { readArchivedGitStagedDescriptor } =
      await import('../lib/archived-container-git');
    const staged = await readArchivedGitStagedDescriptor(
      ids.projectId,
      ids.worktreeId,
    );
    if (staged?.teardown?.phase === 'verified') {
      await commitTaskBrowserRetirement(
        ids.projectId,
        ids.worktreeId,
        'git_quarantine',
      );
      return;
    }
    if (staged?.teardown) return; // An incomplete quarantine requires the existing Git recovery path.
    try {
      await lstat(getWorkspaceWorktreeDir(ids.projectId, ids.worktreeId));
    } catch {
      return;
    } // Removal without a receipt is uncertain; keep the fence.
  }
  await abortTaskBrowserRetirement(operationId);
}

export async function prepareWorkspaceBrowserRetirement(
  projectId: string,
): Promise<Array<{ worktreeId: string; operationId: string | null }>> {
  const service = getBrowserProfileService();
  await service.ensureReady();
  const ids = new Set(
    (await service.repository.listTaskSlots())
      .map((slot) => browserTaskOwnerIds(slot.scope))
      .filter((owner) => owner.projectId === projectId)
      .map((owner) => owner.worktreeId),
  );
  for (const owner of await listBrowserTaskOwners(
    service.dataRoot,
    projectId,
    ids.size === 0,
  ))
    ids.add(owner.worktreeId);
  const prepared: Array<{ worktreeId: string; operationId: string | null }> =
    [];
  try {
    for (const worktreeId of Array.from(ids))
      prepared.push({
        worktreeId,
        operationId: await prepareTaskBrowserRetirement(projectId, worktreeId),
      });
  } catch (error) {
    for (const entry of prepared)
      await abortTaskBrowserRetirement(entry.operationId);
    throw error;
  }
  return prepared;
}

/** Covers external registry reconciliation and removal of failed import/restore destinations. */
export async function retireRemovedBrowserTask(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const service = getBrowserProfileService();
  // Read only this owner's slots. Every archive calls this under the metadata
  // lease, and listing reads one file per task the install has ever had.
  let slot: BrowserTaskSlot | null = null;
  for (const scope of browserTaskScopesForOwnerIds(projectId, worktreeId)) {
    const candidate = await service.repository.getTask(scope);
    if (candidate && candidate.lifecycle !== 'retired') {
      slot = candidate;
      break;
    }
  }
  if (!slot) return;
  const owner = await resolveBrowserTaskOwner(
    service.dataRoot,
    projectId,
    worktreeId,
  );
  if (owner?.createdAt === slot.ownerCreatedAt) return;
  await prepareBrowserTaskRetirement(service.repository, service.dataRoot, {
    scope: slot.scope,
    projectId,
    worktreeId,
    createdAt: slot.ownerCreatedAt,
  });
  await getBrowserService()?.disposeWorktreeViews(projectId, worktreeId);
  await commitTaskBrowserRetirement(projectId, worktreeId);
}
