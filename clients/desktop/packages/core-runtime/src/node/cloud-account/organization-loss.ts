/**
 * Organization-loss handoff rules shared by the Electron account store and the
 * daemon account authority (CAN-6997). Pending records are carried as the
 * writer stored them; only the membership diff is decided here, so detaching
 * workspaces stays with the host that owns them.
 */

export interface OrganizationMembershipSnapshot {
  account?: { id: string };
  organizations?: readonly { id: string }[];
}

export interface OrganizationLossPendingRecord {
  version: 1;
  accountId: string;
  organizationId: string;
  detachedAt: string;
}

export interface OrganizationLossState<
  TPending extends OrganizationLossPendingRecord,
> {
  version: 1;
  accountId: string;
  organizationIds: string[];
  pending: TPending[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A pending handoff as stored, including host-owned fields such as workspaces. */
export type StoredOrganizationLossRecord = OrganizationLossPendingRecord &
  Readonly<Record<string, unknown>>;

/**
 * The app normalizer's acceptance rules for a stored handoff: another
 * account's state is dropped, and any other malformed state is refused rather
 * than dropped, because dropping it would silently abandon a pending
 * workspace detach. Host-owned workspace entries are kept verbatim.
 */
export function readOrganizationLossState(
  value: unknown,
  accountId: string | null,
):
  | {
      readonly kind: 'ok';
      readonly state:
        | OrganizationLossState<StoredOrganizationLossRecord>
        | undefined;
    }
  | { readonly kind: 'malformed' } {
  if (value === undefined || !accountId?.trim())
    return { kind: 'ok', state: undefined };
  if (!isRecord(value) || !('accountId' in value)) return { kind: 'malformed' };
  if (value.accountId !== accountId.trim())
    return { kind: 'ok', state: undefined };
  const organizationIds: unknown = value.organizationIds;
  const pending: unknown = value.pending;
  if (
    value.version !== 1 ||
    !Array.isArray(organizationIds) ||
    !organizationIds.every(
      (id: unknown): id is string => typeof id === 'string' && !!id.trim(),
    ) ||
    !Array.isArray(pending)
  )
    return { kind: 'malformed' };
  const records = new Map<string, StoredOrganizationLossRecord>();
  const items: unknown[] = pending;
  for (const item of items) {
    if (
      !isRecord(item) ||
      item.version !== 1 ||
      item.accountId !== accountId.trim() ||
      typeof item.organizationId !== 'string' ||
      !item.organizationId.trim() ||
      typeof item.detachedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.detachedAt)) ||
      (item.workspaces !== undefined && !Array.isArray(item.workspaces))
    )
      return { kind: 'malformed' };
    const organizationId = item.organizationId.trim().toLowerCase();
    records.set(JSON.stringify([organizationId, item.detachedAt]), {
      ...structuredClone(item),
      version: 1,
      accountId: accountId.trim(),
      organizationId,
      detachedAt: item.detachedAt,
    });
  }
  return {
    kind: 'ok',
    state: {
      version: 1,
      accountId: accountId.trim(),
      organizationIds: [
        ...new Set(organizationIds.map((id) => id.trim().toLowerCase())),
      ],
      pending: [...records.values()],
    },
  };
}

/** Lower-cased unique ids, or null when any member is malformed. */
export function organizationMembershipIds(value: unknown): string[] | null {
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
  const previous = organizationMembershipIds(input.previous.organizations);
  const saved = organizationMembershipIds(input.saved.organizations);
  if (!previous || !saved) return [];
  const retained = new Set(saved);
  return previous.filter((id) => !retained.has(id));
}

export function prepareOrganizationLossState<
  TPending extends OrganizationLossPendingRecord,
>(
  previous: OrganizationMembershipSnapshot & {
    organizationAccessLossState?: OrganizationLossState<TPending>;
  },
  next: OrganizationMembershipSnapshot & { updatedAt: string },
  organizationsRefreshed: boolean,
  { recordLosses = true }: { recordLosses?: boolean } = {},
): OrganizationLossState<TPending | OrganizationLossPendingRecord> | undefined {
  const accountId = next.account?.id.trim();
  if (!accountId || accountId !== previous.account?.id.trim()) return undefined;
  const held = previous.organizationAccessLossState;
  const organizationIds = organizationMembershipIds(next.organizations);
  if (!organizationsRefreshed || !organizationIds) {
    const previousIds = organizationMembershipIds(previous.organizations);
    return (
      held ??
      (previousIds
        ? { version: 1, accountId, organizationIds: previousIds, pending: [] }
        : undefined)
    );
  }
  const pending: (TPending | OrganizationLossPendingRecord)[] = [
    ...(held?.pending ?? []),
  ];
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
              organizationMembershipIds(previous.organizations) ??
              []),
            ...organizationIds,
          ]),
        ],
    pending,
  };
}
