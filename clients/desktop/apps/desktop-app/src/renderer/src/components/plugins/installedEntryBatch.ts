import {
  findInstalledItem,
  installedEntryStatusState,
  installedItemTargetKey,
  marketplaceDisplayName,
  officialMarketplaceProvider,
  type InstalledEntryStatusState,
  type InstalledItemMutationOutcome,
  type InstalledItemRemovalScopeRow,
  type InstalledItemSnapshotState,
  type UnifiedEntryAlternative,
} from '@canopy/ui-shared';
import {
  INSTALLED_ITEM_MARKETPLACE_OWNED_REASON,
  type InstalledItemTarget,
  type InstalledItemUninstallTarget,
} from '@canopy/protocol/installed-items';
import type { UnifiedEntryRef } from '@canopy/protocol/unified-entry';

/**
 * The pure pieces behind one Status row speaking for every installed copy of
 * a plugin (CAN-7547): which copies one change reaches, how their results
 * collapse into one, and how the uninstall confirmation names them.
 */

export type ReadyStatusState = Extract<
  InstalledEntryStatusState,
  { kind: 'ready' }
>;

/** One installed copy in a batch; the primary has no `copy`. */
export interface InstalledBatchMember {
  readonly copy?: UnifiedEntryAlternative;
  readonly state: ReadyStatusState;
}

function isReady(state: InstalledEntryStatusState): state is ReadyStatusState {
  return state.kind === 'ready';
}

/**
 * Whether a copy's uninstall is still saved after a failed one: main reports
 * it with a retryable `partial_removal` notice, whatever the item's own status
 * or removable flag say. Such a copy is being removed, so a status change must
 * not turn it back on, and an uninstall retry must still reach it.
 */
function hasPendingUninstall(member: InstalledBatchMember): boolean {
  return member.state.item.notices.some(
    (notice) => notice.code === 'partial_removal',
  );
}

/**
 * Whether main reports an install of the copy's own, so a status change
 * belongs on it. The catalog's `installed` state is no proof: an inline
 * listing in another marketplace checkout reads as installed, and main lists
 * it with a status but no install, not removable because its marketplace owns
 * it. Main's `removable` is an install of its own; a bundled copy ships
 * installed and names its own reason. Anything else counts as not installed.
 */
function hasOwnInstall(member: InstalledBatchMember): boolean {
  const { removable, reason } = member.state.item;
  return (
    removable ||
    (reason !== undefined && reason !== INSTALLED_ITEM_MARKETPLACE_OWNED_REASON)
  );
}

/**
 * Whether a status change reaches this copy: it has a status and an install
 * of its own, and no uninstall waiting for cleanup (a status change would undo
 * that uninstall). The uninstall retry still reaches the rest.
 */
function takesStatus(member: InstalledBatchMember): boolean {
  return (
    member.state.item.status !== null &&
    !hasPendingUninstall(member) &&
    hasOwnInstall(member)
  );
}

/**
 * The installed copies the item's one Add brought along (`addedWithItem`):
 * the same plugin, so they share the primary's status and removal. The detail
 * snapshot decides, not the catalog: the plugins page and this section load
 * separate snapshots, so a copy installed after the catalog was built still
 * reads `available` there. A copy joins when the snapshot has a ready entry
 * for it and main reports an install of the copy's own (`hasOwnInstall`) or a
 * pending cleanup (`hasPendingUninstall`); the catalog state is no proof (an
 * inline listing in another checkout reads as installed, yet main lists it
 * with no install). A copy the snapshot has no ready entry for (not in the
 * list, still loading, failed) has no member to build: the catalog state would
 * only say it might be installed, and a batch member needs a snapshot entry
 * to send a status or an uninstall target, so it is left out, as is any other
 * kind of item. A copy with no status of its own, or a pending cleanup, stays
 * in: an uninstall retry must reach it (`batchStatusTargets` and
 * `batchRetryCurrent` skip it).
 *
 * Membership follows `addedWithItem` by design: the acceptance rule for this
 * feature is that one Status and Uninstall cover every installed
 * `alsoAvailableFrom` copy with it, the same plugin the item's one Add
 * installs. The uninstall confirmation names every copy that will be removed
 * (Plugin | Harness | Marketplace) before anything is, and main still applies
 * its own per-target checks on each uninstall.
 */
export function collectCopyMembers(
  ref: UnifiedEntryRef,
  alsoAvailableFrom: readonly UnifiedEntryAlternative[] | undefined,
  snapshot: InstalledItemSnapshotState,
): InstalledBatchMember[] {
  // A curated plugin's status resolves to its installed marketplace copy too.
  if (ref.type !== 'marketplace-plugin' && ref.type !== 'curated-plugin')
    return [];
  return (alsoAvailableFrom ?? []).flatMap((copy) => {
    if (copy.addedWithItem !== true) return [];
    const state = installedEntryStatusState(copy.ref, snapshot);
    if (!isReady(state)) return [];
    const member = { copy, state };
    return hasOwnInstall(member) || hasPendingUninstall(member) ? [member] : [];
  });
}

/**
 * The copies an uninstall left behind, read again from the current snapshot:
 * a copy stays in the batch until its cleanup is gone, even once its catalog
 * listing has dropped out of `alsoAvailableFrom`. A copy no longer in the
 * snapshot is done and drops out.
 */
export function carriedCopyMembers(
  carried: readonly InstalledBatchMember[],
  snapshot: InstalledItemSnapshotState,
): InstalledBatchMember[] {
  if (snapshot.kind !== 'ready') return [];
  return carried.flatMap((member) => {
    const item = findInstalledItem(snapshot.snapshot, member.state.item.target);
    return item
      ? [{ ...member, state: { ...member.state, item, configurations: [] } }]
      : [];
  });
}

/** The primary first, then each copy once: a target never appears twice. */
export function installedBatch(
  primary: InstalledEntryStatusState | null,
  copies: readonly InstalledBatchMember[],
): InstalledBatchMember[] {
  const own: InstalledBatchMember[] =
    primary && isReady(primary) ? [{ state: primary }] : [];
  const seen = new Set<string>();
  return [...own, ...copies].filter((member) => {
    const key = installedItemTargetKey(member.state.item.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The first failed outcome, else the last success: a batch is one result. */
export function batchOutcome(
  outcomes: readonly InstalledItemMutationOutcome[],
): InstalledItemMutationOutcome {
  return (
    outcomes.find((outcome) => !outcome.ok) ??
    outcomes[outcomes.length - 1] ?? { ok: true, notices: [] }
  );
}

/**
 * Whether choosing the displayed status again should send it anyway: some
 * copy has a retryable notice, or a status other than the primary's (a
 * partly applied change). Undefined leaves the row's own decision.
 */
export function batchRetryCurrent(
  batch: readonly InstalledBatchMember[],
): true | undefined {
  // A copy a status change does not reach is not a status to compare.
  const members = batch.filter(
    (member, index) => index === 0 || takesStatus(member),
  );
  if (members.length < 2) return undefined;
  const shown = members[0]?.state.item.status;
  return members.some(
    ({ state }) =>
      state.item.status !== shown ||
      state.item.notices.some((notice) => notice.retryable),
  )
    ? true
    : undefined;
}

/**
 * The row's own target first, then every other copy a status change reaches
 * (`takesStatus`).
 */
export function batchStatusTargets(
  batch: readonly InstalledBatchMember[],
  target: InstalledItemTarget,
): InstalledItemTarget[] {
  const key = installedItemTargetKey(target);
  return [
    target,
    ...batch
      .filter(takesStatus)
      .map((member) => member.state.item.target)
      .filter((other) => installedItemTargetKey(other) !== key),
  ];
}

/** A batch member whose uninstall the batch really sends. */
interface RemovableMember {
  readonly member: InstalledBatchMember;
  readonly uninstallTarget: InstalledItemUninstallTarget;
}

/**
 * The members an uninstall reaches: removable, or with an uninstall still
 * waiting for cleanup, and with an uninstall target, once each. A pending copy
 * is kept even when the snapshot reports it not removable: dropping it would
 * report the batch done with its saved uninstall left behind, so main decides
 * (and its error shows). The one source for both what is sent and what the
 * confirmation lists.
 */
function removableMembers(
  batch: readonly InstalledBatchMember[],
): RemovableMember[] {
  const seen = new Set<string>();
  return batch.flatMap((member) => {
    const { removable, uninstallTarget } = member.state.item;
    if (uninstallTarget === undefined) return [];
    if (!removable && !hasPendingUninstall(member)) return [];
    const key = JSON.stringify(uninstallTarget);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ member, uninstallTarget }];
  });
}

/** The copies (never the primary) that one sent uninstall target removes. */
export function batchCopiesFor(
  batch: readonly InstalledBatchMember[],
  target: InstalledItemUninstallTarget,
): InstalledBatchMember[] {
  const key = JSON.stringify(target);
  return removableMembers(batch).flatMap(({ member, uninstallTarget }) =>
    member.copy && JSON.stringify(uninstallTarget) === key ? [member] : [],
  );
}

/** The row's own uninstall first, then every other removable copy's. */
export function batchUninstallTargets(
  batch: readonly InstalledBatchMember[],
  target: InstalledItemUninstallTarget,
): InstalledItemUninstallTarget[] {
  const own = JSON.stringify(target);
  return [
    target,
    ...removableMembers(batch)
      .map(({ uninstallTarget }) => uninstallTarget)
      .filter((other) => JSON.stringify(other) !== own),
  ];
}

/**
 * Uninstalls the other copies first and the primary (the first target) last,
 * and only if every copy went. The primary is the row's own item: while it
 * stays installed the confirmation stays open, so a failed copy's first error
 * shows and a retry collects what is left. Without one, the row would turn
 * read-only under a pending confirmation and swallow the error.
 */
export async function uninstallBatch(
  targets: readonly InstalledItemUninstallTarget[],
  uninstall: (
    target: InstalledItemUninstallTarget,
  ) => Promise<InstalledItemMutationOutcome>,
): Promise<InstalledItemMutationOutcome> {
  const [primary, ...copies] = targets;
  if (primary === undefined) return { ok: true, notices: [] };
  const outcomes = await Promise.all(copies.map((copy) => uninstall(copy)));
  const failed = outcomes.find((outcome) => !outcome.ok);
  return failed ?? uninstall(primary);
}

/**
 * One copy changing is the row changing: when any batch member is pending,
 * the primary's key is pending too, so its row shows the change.
 */
export function batchPendingKeys(
  pendingKeys: ReadonlySet<string>,
  batch: readonly InstalledBatchMember[],
  primary: InstalledEntryStatusState | null,
): ReadonlySet<string> {
  if (!primary || !isReady(primary)) return pendingKeys;
  const anyPending = batch.some((member) =>
    pendingKeys.has(installedItemTargetKey(member.state.item.target)),
  );
  if (!anyPending) return pendingKeys;
  return new Set([...pendingKeys, installedItemTargetKey(primary.item.target)]);
}

type HarnessSource = Pick<
  UnifiedEntryAlternative,
  'installedHarnesses' | 'harnessRows' | 'installedHarnessNames'
>;

/**
 * The harnesses a copy is installed for, by its own install data: its
 * installed harness rows and installed harness names (which name every
 * harness sharing a facet, such as Cursor), then any Claude or Codex flag
 * they leave out.
 */
function installedHarnessLabel(source: HarnessSource): string | undefined {
  const fromRows = [
    ...(source.harnessRows ?? [])
      .filter((row) => row.installation === 'Installed')
      .map((row) => row.name),
    ...(source.installedHarnessNames ?? []),
  ];
  const fromFlags = [
    ...(source.installedHarnesses?.claude === true ? ['Claude'] : []),
    ...(source.installedHarnesses?.codex === true ? ['Codex'] : []),
  ];
  const labels = [...new Set([...fromRows, ...fromFlags])];
  return labels.length > 0 ? labels.join(', ') : undefined;
}

/**
 * What one Uninstall removes, for the confirmation: each copy the batch
 * uninstalls, with its harness and marketplace. Fewer than two has nothing
 * to list. A copy's harness comes from its own install data, else its
 * official marketplace's provider.
 */
export function batchRemovalScope(
  batch: readonly InstalledBatchMember[],
  entry: HarnessSource & {
    readonly ref: UnifiedEntryRef;
    readonly name: string;
    readonly sourceLabel?: string;
  },
  sourceName: string | undefined,
): InstalledItemRemovalScopeRow[] {
  const removable = removableMembers(batch);
  if (removable.length < 2) return [];
  return removable.map(({ member: { copy, state } }) => {
    const ref = copy?.ref ?? entry.ref;
    const harness =
      installedHarnessLabel(copy ?? entry) ??
      (ref.type === 'marketplace-plugin'
        ? officialMarketplaceProvider(ref.marketplaceId)
        : undefined);
    // The copy's marketplace name, as the primary row shows it; the id-based
    // label only when the copy carries no name (a repository id otherwise).
    const source = copy
      ? (copy.marketplaceSourceName ??
        (ref.type === 'marketplace-plugin'
          ? marketplaceDisplayName(ref.marketplaceId)
          : copy.label))
      : (sourceName ?? entry.sourceLabel);
    return {
      id: installedItemTargetKey(state.item.target),
      name: copy?.copyBase?.name ?? copy?.copyName ?? entry.name,
      ...(copy?.copyBase?.publisher
        ? { publisher: copy.copyBase.publisher }
        : {}),
      ...(harness ? { harness } : {}),
      ...(source ? { source } : {}),
    };
  });
}
