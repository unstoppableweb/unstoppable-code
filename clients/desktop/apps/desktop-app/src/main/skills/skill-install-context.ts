import type {
  InstallReceipt,
  ResourceContextInput,
} from '@canopy/desktop-shared/node';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { createHash } from 'node:crypto';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
  DesktopSharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';
import { classifyResourceOwner } from '@canopy/execution-engine/lib/resource-context';
import { normalizeInstallReceiptDisplayNames } from '@canopy/execution-engine/lib/resource-context-policy';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import { listCapabilityPackageInstalls } from '../pipelines/pipeline-package-install-store';
import { getPipelinePackageInstallStorePath } from '../lib/paths';
import {
  assertSkillContext,
  assertSkillContextSnapshot,
  skillContextSnapshot,
  skillResourceContextEnabled,
} from './resource-lanes';
import { getSharedSkill } from './canopy-server-client';
import { classifyInstalledResourceOrigin } from '../lib/resource-install-context';
import { hasPendingSkillReplacement } from './skill-replacement-state';

/** A missing inventory row must not erase the identity of a receipted install. */
export async function getSharedSkillWithInstallState(
  remoteId: string,
): Promise<DesktopSharedSkillDetail> {
  if (!skillResourceContextEnabled()) return getSharedSkill(remoteId);
  const snapshot = await skillContextSnapshot();
  const detail = await getSharedSkill(remoteId);
  await assertSkillContext({ owner: detail.owner });
  const copies = await getSharedSkillInstallIds(detail.id, true);
  await assertSkillContextSnapshot(snapshot);
  return { ...detail, installedCopyIds: Array.from(copies).sort() };
}

/**
 * `expired` lets a caller that has already given up (a serialized install past
 * its check budget) fail before the cloud read instead of starting it.
 */
export async function assertStoredSkillContext(
  localId: string,
  projectId?: string,
  expired?: () => boolean,
): Promise<void> {
  if (!skillResourceContextEnabled()) return;
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  const binding = await createResourceInstallReceiptsStore(
    accountId ?? 'signed-out',
  ).findLocal('skills', localId);
  if (!binding) {
    await assertSkillContext(
      {
        owner: { type: 'user', id: 'local', name: null },
      },
      projectId,
    );
    return;
  }
  if (!accountId || binding.accountId !== accountId) {
    throw new Error('Skill unavailable (access-removed)');
  }
  // Fail closed: a skipped lookup must never read as a passed check.
  if (expired?.())
    throw new Error("Couldn't check the skill in time. Try again.");
  // An install receipt is provenance, never a grant: reauthorize the remote id.
  const detail = await getSharedSkill(binding.receipt.remoteId);
  await assertSkillContext(
    {
      owner: detail.owner,
      provenance: binding.receipt,
    },
    projectId,
  );
}

/** Origin reuse includes dependencies; recipient actions only target primary copies. */
export async function getSharedSkillInstallIds(
  remoteId: string,
  primaryOnly = false,
): Promise<Set<string>> {
  if (!skillResourceContextEnabled()) return new Set();
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  if (!accountId) throw new Error('Skill unavailable (access-removed)');
  const receipt = await createResourceInstallReceiptsStore(accountId).find(
    'skills',
    remoteId,
    true,
  );
  // An explicit empty list survives compensation of a failed first install.
  // Only an unknown alias list requires recovery before another installation.
  if (receipt && receipt.localResourceIds === undefined)
    throw new Error(
      'Skill unavailable (missing-copy). Restore the installed copy and review the skill again.',
    );
  const active =
    receipt?.localResourceIds?.filter(
      (id) => !receipt.uninstalledLocalResourceIds?.includes(id),
    ) ?? [];
  if (!primaryOnly || !receipt) return new Set(active);
  // Older package receipts did not distinguish dependencies from primary copies.
  // The package ledger records the actual primary's local identity independently.
  const legacyIds = active.filter(
    (id) => receipt.localResourceRoles?.[id] === undefined,
  );
  const packages = legacyIds.length
    ? await listCapabilityPackageInstalls(getPipelinePackageInstallStorePath())
    : [];
  const legacyPrimaries = new Set(
    packages.flatMap((record) =>
      record.owner.kind === 'skill' && record.originExternalId === remoteId
        ? [`custom:app/${record.owner.localId}`]
        : [],
    ),
  );
  return new Set(
    active.filter((id) => {
      const role = receipt.localResourceRoles?.[id];
      return (
        role === 'primary' ||
        (role === undefined &&
          (legacyPrimaries.size === 0 || legacyPrimaries.has(id)))
      );
    }),
  );
}

export async function recordSharedSkillInstall(
  detail: SharedSkillDetail,
  localId: string,
  localContentHash = createHash('sha256').update(detail.rawSkill).digest('hex'),
  contextSnapshot?: string,
  role: 'primary' | 'dependency' = 'primary',
): Promise<(() => Promise<void>) | undefined> {
  if (contextSnapshot !== undefined)
    await assertSkillContextSnapshot(contextSnapshot);
  if (!skillResourceContextEnabled()) {
    if (contextSnapshot !== undefined)
      throw new Error('Skill unavailable (replacement-unsupported)');
    return;
  }
  await assertSkillContext({ owner: detail.owner });
  const account = await readCanopyCloudAccountWithStatus();
  if (contextSnapshot !== undefined)
    await assertSkillContextSnapshot(contextSnapshot);
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  if (!accountId) throw new Error('Skill unavailable (access-removed)');
  const owner = classifyResourceOwner(detail.owner, { strict: true });
  if (owner === 'unknown')
    throw new Error('Skill unavailable (unknown-provenance)');
  const store = createResourceInstallReceiptsStore(accountId);
  const previous = await store.find('skills', detail.id, true);
  const receipt: InstallReceipt = {
    family: 'skills',
    remoteId: detail.id,
    localResourceIds: [localId],
    shareScope: detail.shareScope ?? 'private',
    ownerContext:
      typeof owner === 'object'
        ? { kind: 'organization', organizationId: owner.organizationId }
        : { kind: 'personal' },
    hash: createHash('sha256').update(detail.rawSkill).digest('hex'),
    localContentHashes: { [localId]: localContentHash },
    localResourceRoles: {
      [localId]:
        previous?.localResourceRoles?.[localId] === 'primary'
          ? 'primary'
          : role,
    },
    authorizedAt: new Date().toISOString(),
    ...normalizeInstallReceiptDisplayNames({
      sharedByName: detail.createdBy.name ?? undefined,
      ownerName:
        detail.owner.type === 'team'
          ? (detail.owner.organization.name ?? undefined)
          : detail.owner.type === 'organization'
            ? (detail.owner.name ?? undefined)
            : undefined,
      teamName:
        detail.owner.type === 'team'
          ? (detail.owner.name ?? undefined)
          : undefined,
    }),
  };
  if (contextSnapshot !== undefined)
    await assertSkillContextSnapshot(contextSnapshot);
  await store.record(receipt);
  return (): Promise<void> => store.rollbackInstall(receipt, previous);
}

/** Capture account and origin before removal; keep provenance after an intentional uninstall. */
export async function prepareSkillUninstall(
  localId: string,
): Promise<() => Promise<void>> {
  if (!skillResourceContextEnabled()) return async () => {};
  const snapshot = await skillContextSnapshot();
  await assertStoredSkillContext(localId);
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  const store = createResourceInstallReceiptsStore(accountId ?? 'signed-out');
  const binding = await store.findLocal('skills', localId);
  if (binding && (!accountId || binding.accountId !== accountId))
    throw new Error('Skill unavailable (access-removed)');
  await assertSkillContextSnapshot(snapshot);
  return async () => {
    if (!binding) return;
    // The receipt writer merges untouched aliases/removal markers. This does
    // not erase organization origin or grant access after revocation.
    await store.record({
      ...binding.receipt,
      localResourceIds: [localId],
      uninstalledLocalResourceIds: [localId],
      localContentHashes: binding.receipt.localContentHashes?.[localId]
        ? { [localId]: binding.receipt.localContentHashes[localId] }
        : undefined,
      localResourceRoles: binding.receipt.localResourceRoles?.[localId]
        ? { [localId]: binding.receipt.localResourceRoles[localId] }
        : undefined,
    });
  };
}

/**
 * Name the share each receipted local skill was installed from, and the
 * supporting-file package that completed for it, so a recipient surface reads
 * this account's receipts instead of guessing from content. A copy with no
 * receipt for a share is not that share's install: a scoped import never
 * reuses it. Read-only; failed verification must not masquerade as absence.
 */
export async function annotateSharedSkillInstalls(
  rows: InstalledSkillInfo[],
): Promise<InstalledSkillInfo[]> {
  if (!skillResourceContextEnabled()) return rows;
  try {
    const account = await readCanopyCloudAccountWithStatus();
    if (account.status !== 'ok') throw new Error('Account verification failed');
    const accountId =
      account.status === 'ok' ? account.entry?.account?.id : undefined;
    if (!accountId) return rows;
    const receipts =
      await createResourceInstallReceiptsStore(accountId).listForAccount(true);
    // A local name freed by a deletion can be claimed by another share while
    // an older receipt still lists it; the latest authorization owns it.
    const bindings = new Map<string, { receipt: InstallReceipt; at: number }>();
    for (const receipt of receipts) {
      if (receipt.family !== 'skills') continue;
      const at = Date.parse(receipt.authorizedAt);
      for (const localId of receipt.localResourceIds ?? []) {
        const current = bindings.get(localId);
        if (current === undefined || at > current.at)
          bindings.set(localId, { receipt, at });
      }
    }
    if (bindings.size === 0) return rows;
    const packages = await listCapabilityPackageInstalls(
      getPipelinePackageInstallStorePath(),
    );
    return await Promise.all(
      rows.map(async (row) => {
        const receipt = bindings.get(`${row.sourceId}/${row.name}`)?.receipt;
        if (receipt === undefined) return row;
        const remoteId = receipt.remoteId;
        const installed = packages.find(
          (record) =>
            record.owner.kind === 'skill' &&
            record.owner.localId === row.name &&
            record.originExternalId === remoteId &&
            record.supportingFilesComplete !== false &&
            record.distributionMode !== 'definition_only',
        );
        return {
          ...row,
          installedFromShare: {
            remoteId,
            ...((await hasPendingSkillReplacement(row.name))
              ? { replacementPending: true }
              : {}),
            shareScope: receipt.shareScope,
            ownerContext: receipt.ownerContext,
            // The legacy store has one snapshot per share and merges aliases.
            // A later import can advance that hash without changing older copies.
            // Legacy multiple aliases therefore have no per-copy baseline.
            ...(receipt.localContentHashes?.[`${row.sourceId}/${row.name}`]
              ? {
                  contentHash:
                    receipt.localContentHashes[`${row.sourceId}/${row.name}`],
                }
              : receipt.localResourceIds?.length === 1 &&
                  !receipt.localContentHashes
                ? { contentHash: receipt.hash }
                : {}),
            authorizedAt: receipt.authorizedAt,
            ...normalizeInstallReceiptDisplayNames(receipt),
            ...(installed?.packageDigest
              ? { packageDigest: installed.packageDigest }
              : {}),
          },
        };
      }),
    );
  } catch {
    // Leaving an unreadable receipt store unannotated would look like absence
    // and permit duplicate installs. Surface a retryable inventory failure.
    throw new Error(
      'Skill install verification failed. Try loading skills again.',
    );
  }
}

/**
 * Whether an install receipt binds this local skill to an owned remote source.
 * A receipted copy belongs to its receipt's context; a public install must not
 * adopt it even when the bytes are identical.
 */
export async function hasSkillInstallReceipt(
  localId: string,
): Promise<boolean> {
  if (!skillResourceContextEnabled()) return false;
  const account = await readCanopyCloudAccountWithStatus();
  if (account.status !== 'ok') return true;
  const accountId = account.entry?.account?.id;
  const binding = await createResourceInstallReceiptsStore(
    accountId ?? 'signed-out',
  ).findLocal('skills', localId);
  return binding !== undefined;
}

/** Returns an undo for a save that fails before it commits. */
export async function copySkillInstallOrigin(
  source: string,
  destination: string,
): Promise<(() => Promise<void>) | undefined> {
  if (!skillResourceContextEnabled()) return undefined;
  await assertStoredSkillContext(source);
  const account = await readCanopyCloudAccountWithStatus();
  const id = account.status === 'ok' ? account.entry?.account?.id : undefined;
  if (!id) return undefined;
  const store = createResourceInstallReceiptsStore(id);
  const binding = await store.findLocal('skills', source);
  if (binding) {
    const hash = binding.receipt.localContentHashes?.[source];
    const role =
      binding.receipt.localResourceRoles?.[source] ??
      ((await getSharedSkillInstallIds(binding.receipt.remoteId, true)).has(
        source,
      )
        ? 'primary'
        : 'dependency');
    const receipt = {
      ...binding.receipt,
      localResourceIds: [destination],
      // The new copy is live; removal markers belong to their original aliases.
      ...(binding.receipt.uninstalledLocalResourceIds
        ? { uninstalledLocalResourceIds: [] }
        : {}),
      localContentHashes: hash ? { [destination]: hash } : undefined,
      localResourceRoles: { [destination]: role },
    };
    await store.record(receipt);
    return (): Promise<void> => store.rollbackInstall(receipt, binding.receipt);
  }
  return undefined;
}

const STORED_SKILL_FILTER_PASSES = 3;

export async function filterStoredSkillContexts<
  T extends { sourceId: string; name: string },
>(rows: T[]): Promise<T[]> {
  if (!skillResourceContextEnabled()) return rows;
  // A context change while the slow per-row filter runs only invalidates that
  // pass; retry so the result still matches exactly one snapshot.
  for (let pass = 1; ; pass++) {
    const snapshot = await skillContextSnapshot();
    const allowed = await filterRowsInContext(rows);
    if (pass === STORED_SKILL_FILTER_PASSES)
      await assertSkillContextSnapshot(snapshot);
    else if (snapshot !== (await skillContextSnapshot())) continue;
    return rows.filter((_row, index) => allowed[index]);
  }
}

function filterRowsInContext<T extends { sourceId: string; name: string }>(
  rows: T[],
): Promise<boolean[]> {
  return Promise.all(
    rows.map(async (row): Promise<boolean> => {
      try {
        await assertStoredSkillContext(`${row.sourceId}/${row.name}`);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

/** Context-independent Personal inventory used by desktop cloud sync. */
export async function filterPersonalStoredSkills<
  T extends { sourceId: string; name: string },
>(rows: T[]): Promise<T[]> {
  const origins = await Promise.all(
    rows.map((row) =>
      classifyInstalledResourceOrigin('skills', `${row.sourceId}/${row.name}`),
    ),
  );
  return rows.filter((_row, index) => origins[index] !== 'excluded');
}

/** An organization-origin copy must not be republished as a portable private copy. */
export async function assertSkillShareOrigin(
  localId: string,
  destinationOwner: unknown,
): Promise<void> {
  if (!skillResourceContextEnabled()) return;
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  const binding = await createResourceInstallReceiptsStore(
    accountId ?? 'signed-out',
  ).findLocal('skills', localId);
  if (binding?.receipt.ownerContext.kind !== 'organization') return;
  const resource: ResourceContextInput['resource'] = {
    owner: { type: 'system' },
    provenance: binding.receipt,
  };
  const owner = classifyResourceOwner(destinationOwner, { strict: true });
  const { getResourceContextPolicyService } =
    await import('../services/resource-context-policy-service');
  const decision = await getResourceContextPolicyService().decide({
    resource,
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
    target: {
      workspaceOwner:
        typeof owner === 'object'
          ? { kind: 'organization', organizationId: owner.organizationId }
          : { kind: 'personal' },
    },
  });
  if (!decision.allow)
    throw new Error(`Skill unavailable (${decision.reason})`);
}
