import { normalizeWorkspaceOwner } from '@canopy/desktop-shared/lib/workspace-owner';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';

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

export interface OrganizationMembershipSnapshot {
  account?: { id: string };
  organizations?: readonly { id: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function membershipIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const members: unknown[] = value;
  for (const member of members) {
    if (!isRecord(member) || typeof member.id !== 'string' || !member.id.trim())
      return null;
    ids.add(member.id.trim().toLowerCase());
  }
  return [...ids];
}

export function selectLostOrganizationIds(input: {
  previous: OrganizationMembershipSnapshot;
  saved: OrganizationMembershipSnapshot;
  organizationsRefreshed: boolean;
}): string[] {
  const accountId = input.previous.account?.id.trim();
  if (
    !input.organizationsRefreshed ||
    !accountId ||
    input.saved.account?.id.trim() !== accountId
  )
    return [];
  const previous = membershipIds(input.previous.organizations);
  const saved = membershipIds(input.saved.organizations);
  if (!previous || !saved) return [];
  const retained = new Set(saved);
  return previous.filter((id) => !retained.has(id));
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
  { recordLosses = true }: { recordLosses?: boolean } = {},
): OrganizationAccessLossState | undefined {
  const accountId = next.account?.id.trim();
  if (!accountId || accountId !== previous.account?.id.trim()) return undefined;
  const held = previous.organizationAccessLossState;
  const organizationIds = membershipIds(next.organizations);
  if (!organizationsRefreshed || !organizationIds) {
    const previousIds = membershipIds(previous.organizations);
    return (
      held ??
      (previousIds
        ? { version: 1, accountId, organizationIds: previousIds, pending: [] }
        : undefined)
    );
  }
  const pending = [...(held?.pending ?? [])];
  for (const organizationId of selectLostOrganizationIds({
    previous: held
      ? {
          account: previous.account,
          organizations: held.organizationIds.map((id) => ({ id })),
        }
      : previous,
    saved: next,
    organizationsRefreshed: organizationsRefreshed && recordLosses,
  })) {
    let detachedAt = next.updatedAt;
    while (
      pending.some(
        (record) =>
          record.organizationId === organizationId &&
          record.detachedAt === detachedAt,
      )
    )
      detachedAt = new Date(Date.parse(detachedAt) + 1).toISOString();
    pending.push({
      version: 1,
      accountId,
      organizationId,
      detachedAt,
    });
  }
  return {
    version: 1,
    accountId,
    // A same-account login can confirm restoration but cannot consume a loss
    // diff: only the refresh hook creates the corresponding durable handoff.
    organizationIds: recordLosses
      ? organizationIds
      : [
          ...new Set([
            ...(held?.organizationIds ??
              membershipIds(previous.organizations) ??
              []),
            ...organizationIds,
          ]),
        ],
    pending,
  };
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
