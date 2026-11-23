import { type JSX, useCallback, useMemo, useState } from 'react';
import { useCustomizeDiscoveryEnabled } from '@canopy/ui-app/capability';
import {
  entryHasInstalledStatus,
  installedEntryStatusState,
  InstalledItemStatusRow,
  type InstalledItemMutationOutcome,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared';
import type {
  InstalledItemStatus,
  InstalledItemTarget,
  InstalledItemUninstallTarget,
} from '@canopy/protocol/installed-items';
import { useDesktopInstalledItemStatuses } from '@/hooks/useDesktopInstalledItemStatuses';
import {
  batchCopiesFor,
  batchOutcome,
  batchRetryCurrent,
  batchPendingKeys,
  batchRemovalScope,
  batchStatusTargets,
  batchUninstallTargets,
  carriedCopyMembers,
  collectCopyMembers,
  installedBatch,
  uninstallBatch,
  type InstalledBatchMember,
} from './installedEntryBatch';

/**
 * The installed-item Status row for a desktop detail page (CAN-4255): status
 * picker, provider notices and Uninstall. Renders nothing for browse-only
 * entries and kinds without an installed status.
 *
 * With New Customize on, a plugin's one tile speaks for every installed copy
 * its Add brought along (`alsoAvailableFrom` entries marked `addedWithItem`):
 * the row shows the primary's status, and a status change or an uninstall runs
 * on all of them together (CAN-7547). With it off, only the primary.
 */
export function InstalledEntryStatusSection({
  entry,
  onUninstalled,
  headerOwnsRemoval = false,
  onManageSource,
  sourceName,
}: {
  /** This listing's marketplace, named in a batch uninstall's list. */
  sourceName?: string;
  /** Opens the marketplace that owns this item. */
  onManageSource?: () => void;
  entry: Pick<UnifiedPluginEntry, 'state' | 'ref' | 'name' | 'integration'> &
    Partial<
      Pick<
        UnifiedPluginEntry,
        | 'alsoAvailableFrom'
        | 'installedHarnesses'
        | 'harnessRows'
        | 'sourceLabel'
      >
    >;
  /** Leaves the detail once the item is gone. */
  onUninstalled: () => void;
  /**
   * The detail's header ⋯ already removes the item (a skill's Delete or
   * Remove), so Status offers no second ⋯ with its own Uninstall.
   */
  headerOwnsRemoval?: boolean;
}): JSX.Element | null {
  const enabled = entryHasInstalledStatus({ ...entry, state: 'installed' });
  const controller = useDesktopInstalledItemStatuses(enabled);
  const { setStatus, uninstall } = controller;
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  const state = useMemo(
    () =>
      enabled
        ? installedEntryStatusState(
            entry.ref,
            controller.state,
            entry.integration?.connections,
          )
        : null,
    [enabled, entry.ref, entry.integration, controller.state],
  );
  // The copies the last batch uninstall failed on. A retry reaches them until
  // their cleanup is done, even once their listings leave the catalog.
  const [carried, setCarried] = useState<readonly InstalledBatchMember[]>([]);
  const batch = useMemo(
    () =>
      installedBatch(
        state,
        enabled && discoveryEnabled
          ? [
              ...collectCopyMembers(
                entry.ref,
                entry.alsoAvailableFrom,
                controller.state,
              ),
              ...carriedCopyMembers(carried, controller.state),
            ]
          : [],
      ),
    [
      state,
      enabled,
      discoveryEnabled,
      entry.ref,
      entry.alsoAvailableFrom,
      controller.state,
      carried,
    ],
  );
  const removalScope = useMemo(
    () => batchRemovalScope(batch, entry, sourceName),
    [batch, entry, sourceName],
  );
  const pendingKeys = useMemo(
    () => batchPendingKeys(controller.pendingKeys, batch, state),
    [controller.pendingKeys, batch, state],
  );
  const retryCurrent = useMemo(() => batchRetryCurrent(batch), [batch]);
  // A lone copy takes the controller's own path, unbatched.
  const onSetStatus = useCallback(
    async (
      target: InstalledItemTarget,
      status: InstalledItemStatus,
    ): Promise<InstalledItemMutationOutcome> => {
      if (batch.length < 2) return setStatus(target, status);
      return batchOutcome(
        await Promise.all(
          batchStatusTargets(batch, target).map((each) =>
            setStatus(each, status),
          ),
        ),
      );
    },
    [batch, setStatus],
  );
  const onUninstall = useCallback(
    async (
      target: InstalledItemUninstallTarget,
    ): Promise<InstalledItemMutationOutcome> => {
      if (batch.length < 2) return uninstall(target);
      const failed: InstalledBatchMember[] = [];
      const outcome = await uninstallBatch(
        batchUninstallTargets(batch, target),
        async (each) => {
          const result = await uninstall(each);
          if (!result.ok) failed.push(...batchCopiesFor(batch, each));
          return result;
        },
      );
      setCarried(failed);
      return outcome;
    },
    [batch, uninstall],
  );
  if (!state || !entryHasInstalledStatus(entry, controller.state)) return null;
  return (
    <InstalledItemStatusRow
      itemName={entry.name}
      state={state}
      pendingKeys={pendingKeys}
      onSetStatus={onSetStatus}
      onUninstall={headerOwnsRemoval ? undefined : onUninstall}
      onUninstalled={onUninstalled}
      removalScope={removalScope}
      retryCurrent={retryCurrent}
      onManageSource={onManageSource}
      testId="plugins-entry-detail-status"
    />
  );
}
