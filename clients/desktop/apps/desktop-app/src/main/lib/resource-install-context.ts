import { classifyResourceOwner } from '@canopy/execution-engine/lib/resource-context';
import type { InstallReceipt } from '@canopy/execution-engine/lib/resource-context-policy';
import { decideResourceContext } from '@canopy/execution-engine/lib/resource-context-policy';
import {
  PERSONAL_WORKSPACE_CONTEXT,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { readCanopyCloudAccountWithStatus } from './canopy-cloud-account-store';
import { createResourceInstallReceiptsStore } from './resource-install-receipts';
import {
  assertResourceContext,
  assertResourceContextForContext,
  resourceContextEnabled,
} from './resource-context';

type Family = 'automations' | 'collections' | 'pipelines' | 'skills';
interface Detail {
  id: string;
  owner?: unknown;
  shareScope?: 'private' | 'team' | 'organization';
  contentHash: string;
}
async function accountId(): Promise<string | undefined> {
  const account = await readCanopyCloudAccountWithStatus();
  return account.status === 'ok' ? account.entry?.account?.id : undefined;
}

export type InstalledResourceOrigin = 'local' | 'personal' | 'excluded';

/** Classify a local resource for the context-independent Personal sync view. */
export async function classifyInstalledResourceOrigin(
  family: Family,
  localId: string,
): Promise<InstalledResourceOrigin> {
  const account = await readCanopyCloudAccountWithStatus();
  if (account.status !== 'ok') {
    throw new Error('Could not read the account for resource classification.');
  }
  const id = account.entry?.account?.id;
  const binding = await createResourceInstallReceiptsStore(
    id ?? 'signed-out',
  ).findLocal(family, localId);
  if (!binding) return 'local';
  const decision = decideResourceContext({
    resource: { owner: { type: 'system' }, provenance: binding.receipt },
    invocation: {
      mode: 'background',
      context: PERSONAL_WORKSPACE_CONTEXT,
    },
  });
  return decision.allow ? 'personal' : 'excluded';
}

/**
 * Receipts are provenance, never grants. Reauthorize the original remote id.
 * A trusted caller `context` (an agent's project owner) replaces the selected
 * sidebar context; without it the foreground selection is used.
 */
export async function assertInstalledResourceContext(
  family: Family,
  localId: string,
  fetch: (id: string) => Promise<Detail>,
  context?: WorkspaceContext,
): Promise<void> {
  if (!resourceContextEnabled()) return;
  const assertContext = (
    resource: Parameters<typeof assertResourceContext>[0],
  ): Promise<void> =>
    context === undefined
      ? assertResourceContext(resource)
      : assertResourceContextForContext(resource, context);
  const id = await accountId();
  const binding = await createResourceInstallReceiptsStore(
    id ?? 'signed-out',
  ).findLocal(family, localId);
  if (!binding) {
    await assertContext({
      owner: { type: 'user', id: 'local', name: null },
    });
    return;
  }
  // A Public share is readable by anyone, so its install is not tied to the
  // account, if any, that was signed in when it was made.
  const publicCollection =
    binding.receipt.sourceKind === 'public-share' && family === 'collections';
  if (!publicCollection && (!id || binding.accountId !== id)) {
    await assertContext({ owner: undefined });
    throw new Error('Resource unavailable (access-removed)');
  }
  let detail: Detail;
  if (publicCollection) {
    const { getPublicCollectionShareSnapshot } =
      await import('../canopy-cloud/public-share-client');
    const snapshot = await getPublicCollectionShareSnapshot(
      binding.receipt.remoteId,
    );
    detail = {
      id: snapshot.externalId,
      contentHash: snapshot.contentHash,
      owner: { shareScope: 'private' },
      shareScope: 'private',
    };
  } else {
    detail = await fetch(binding.receipt.remoteId);
  }
  await assertContext({
    owner: detail.owner,
    provenance: binding.receipt,
  });
}

/**
 * Local collection management reads retain already-installed content after a
 * share is revoked. This authorizes only its original account/context lane;
 * execution, republishing and new imports still require live authorization.
 */
export async function assertLocalCollectionManagementContext(
  localId: string,
): Promise<void> {
  if (!resourceContextEnabled()) return;
  const id = await accountId();
  const binding = await createResourceInstallReceiptsStore(
    id ?? 'signed-out',
  ).findLocal('collections', localId);
  if (!binding) {
    await assertResourceContext({
      owner: { type: 'user', id: 'local', name: null },
    });
    return;
  }
  const publicShare = binding.receipt.sourceKind === 'public-share';
  if (!publicShare && (!id || binding.accountId !== id))
    throw new Error('Resource unavailable (access-removed)');
  const context = binding.receipt.ownerContext;
  await assertResourceContext({
    owner:
      context.kind === 'organization'
        ? { type: 'organization', id: context.organizationId, name: null }
        : { type: 'user', id: id ?? 'local', name: null },
    provenance: binding.receipt,
  });
}

export async function recordResourceInstall(
  family: Family,
  detail: Detail,
  localResourceIds: string[],
  sourceKind?: 'public-share',
): Promise<void> {
  if (!resourceContextEnabled()) return;
  await assertResourceContext({ owner: detail.owner });
  const id = await accountId();
  // Only a Public share may be recorded with no account signed in.
  if (!id && sourceKind !== 'public-share')
    throw new Error('Resource unavailable (access-removed)');
  const owner = classifyResourceOwner(detail.owner, { strict: true });
  if (owner === 'unknown')
    throw new Error('Resource unavailable (unknown-provenance)');
  const receipt: InstallReceipt = {
    family,
    remoteId: detail.id,
    ...(sourceKind ? { sourceKind } : {}),
    localResourceIds,
    shareScope: detail.shareScope ?? 'private',
    ownerContext:
      typeof owner === 'object'
        ? { kind: 'organization', organizationId: owner.organizationId }
        : { kind: 'personal' },
    hash: detail.contentHash,
    authorizedAt: new Date().toISOString(),
  };
  await createResourceInstallReceiptsStore(id ?? 'signed-out').record(receipt);
}

export async function assertInstalledResourceShare(
  family: Family,
  localId: string,
  destination:
    | { kind: 'personal' }
    | { kind: 'organization'; organizationId: string },
  fetch: (id: string) => Promise<Detail>,
): Promise<void> {
  if (!resourceContextEnabled()) return;
  await assertInstalledResourceContext(family, localId, fetch);
  const id = await accountId();
  const binding = await createResourceInstallReceiptsStore(
    id ?? 'signed-out',
  ).findLocal(family, localId);
  if (!binding || binding.receipt.ownerContext.kind !== 'organization') return;
  const detail = await fetch(binding.receipt.remoteId);
  await assertResourceContext(
    { owner: detail.owner, provenance: binding.receipt },
    { workspaceOwner: destination },
  );
}
