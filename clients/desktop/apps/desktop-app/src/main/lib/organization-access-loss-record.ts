import { normalizeWorkspaceOwner } from '@canopy/desktop-shared/lib/workspace-owner';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import {
  prepareOrganizationLossState,
  type OrganizationMembershipSnapshot,
} from '@canopy/core-runtime/node/cloud-account';

export {
  selectLostOrganizationIds,
  type OrganizationMembershipSnapshot,
} from '@canopy/core-runtime/node/cloud-account';

export interface OrganizationAccessLossWorkspace {
  workspaceId: string;
  /** Captured before attempting the write; includes the complete fence. */
  owner?: WorkspaceOwnerBinding;
  complete?: boolean;
}

/** Account-store handoff, committed with the authoritative membership snapshot. */
export interface OrganizationAccessLossRecord {
  version: 1;
  accountId: string;
  organizationId: string;
  detachedAt: string;
  workspaces?: OrganizationAccessLossWorkspace[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OrganizationAccessLossState {
  version: 1;
  accountId: string;
  organizationIds: string[];
  pending: OrganizationAccessLossRecord[];
}

export function normalizeOrganizationAccessLossState(
  value: unknown,
  accountId: string | undefined,
): OrganizationAccessLossState | undefined {
  if (value === undefined || !accountId?.trim()) return undefined;
  if (typeof value !== 'object' || value === null || !('accountId' in value))
    throw new Error('Invalid organization access loss handoff');
  if (value.accountId !== accountId.trim()) return undefined;
  if (
    !('version' in value) ||
    value.version !== 1 ||
    !('organizationIds' in value) ||
    !Array.isArray(value.organizationIds) ||
    !value.organizationIds.every(
      (id): id is string => typeof id === 'string' && !!id.trim(),
    ) ||
    !('pending' in value) ||
    !Array.isArray(value.pending)
  )
    throw new Error('Invalid organization access loss handoff');
  return {
    version: 1,
    accountId: accountId.trim(),
    organizationIds: [
      ...new Set(value.organizationIds.map((id) => id.trim().toLowerCase())),
    ],
    pending: normalizeOrganizationAccessLossRecords(value.pending, accountId),
  };
}

export function prepareOrganizationAccessLossState(
  previous: OrganizationMembershipSnapshot & {
    organizationAccessLossState?: OrganizationAccessLossState;
  },
  next: OrganizationMembershipSnapshot & { updatedAt: string },
  organizationsRefreshed: boolean,
  options: { recordLosses?: boolean } = {},
): OrganizationAccessLossState | undefined {
  return prepareOrganizationLossState(
    previous,
    next,
    organizationsRefreshed,
    options,
  );
}

export function normalizeOrganizationAccessLossRecords(
  value: unknown,
  accountId: string | undefined,
): OrganizationAccessLossRecord[] {
  if (!Array.isArray(value) || !accountId?.trim()) return [];
  const records = new Map<string, OrganizationAccessLossRecord>();
  const entries: unknown[] = value;
  for (const record of entries) {
    if (
      !isRecord(record) ||
      record.version !== 1 ||
      record.accountId !== accountId.trim() ||
      typeof record.organizationId !== 'string' ||
      !record.organizationId.trim() ||
      typeof record.detachedAt !== 'string' ||
      !Number.isFinite(Date.parse(record.detachedAt))
    )
      throw new Error('Invalid pending organization access loss');
    const organizationId = record.organizationId.trim().toLowerCase();
    records.set(JSON.stringify([organizationId, record.detachedAt]), {
      version: 1,
      accountId: record.accountId,
      organizationId,
      detachedAt: record.detachedAt,
      ...(record.workspaces === undefined
        ? {}
        : { workspaces: normalizeLossWorkspaces(record.workspaces) }),
    });
  }
  return [...records.values()];
}

function normalizeLossWorkspaces(
  value: unknown,
): OrganizationAccessLossWorkspace[] {
  if (!Array.isArray(value)) throw new Error('Invalid access loss workspaces');
  const result = new Map<string, OrganizationAccessLossWorkspace>();
  const entries: unknown[] = value;
  for (const item of entries) {
    if (
      !isRecord(item) ||
      typeof item.workspaceId !== 'string' ||
      !item.workspaceId.trim() ||
      (item.complete !== undefined && typeof item.complete !== 'boolean')
    )
      throw new Error('Invalid access loss workspace');
    const owner = normalizeWorkspaceOwner(item.owner);
    if (item.owner !== undefined && !owner)
      throw new Error('Invalid access loss binding');
    result.set(item.workspaceId, {
      workspaceId: item.workspaceId,
      ...(owner ? { owner } : {}),
      ...(item.complete ? { complete: true } : {}),
    });
  }
  return [...result.values()];
}
