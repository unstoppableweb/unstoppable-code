import { useCallback } from 'react';
import { toAppError } from '@canopy/protocol/app-errors';
import type {
  HarnessInstallItemRef,
  ItemHarnessInstalls,
  PluginStandInCandidate,
} from '@canopy/protocol/plugins';
import { useCustomizeDiscoveryEnabled } from '@canopy/ui-app/customize-discovery';
import { useSettledSetUpHarnesses } from './useSetUpHarnesses';

/** What one Add for every harness did, for the caller to show. */
export type ItemHarnessInstallOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'recorded'; readonly record: ItemHarnessInstalls | null }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * One Add for every harness, for plugins and skills (CAN-6816): after the
 * plugin or skill is installed as before, records what each set-up harness
 * loads from it; main also installs the native copies for harnesses it
 * can't serve. New Customize only; with the experiment off, or on a host
 * without the channel, it does nothing and Add is unchanged.
 */
export function useItemHarnessInstall(): (
  item: HarnessInstallItemRef,
  /**
   * The publisher's MCP server for a plugin's ChatGPT app (CAN-6818): main
   * installs it on the harnesses where the app doesn't run.
   */
  standIn?: PluginStandInCandidate,
) => Promise<ItemHarnessInstallOutcome> {
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  const settledHarnesses = useSettledSetUpHarnesses(discoveryEnabled);
  return useCallback(
    async (
      item: HarnessInstallItemRef,
      standIn?: PluginStandInCandidate,
    ): Promise<ItemHarnessInstallOutcome> => {
      if (!discoveryEnabled || window.plugins.installForHarnesses === undefined)
        return { kind: 'skipped' };
      try {
        const { harnesses, pendingHarnesses } = await settledHarnesses();
        // An empty list still asks: main adds the harnesses it can confirm.
        const record = await window.plugins.installForHarnesses({
          item,
          harnesses,
          ...(pendingHarnesses.length > 0 ? { pendingHarnesses } : {}),
          ...(standIn !== undefined ? { standIn } : {}),
        });
        return { kind: 'recorded', record };
      } catch (cause) {
        // The item is installed and every harness that loads it still can;
        // only the per-harness record is missing, so Add carries on.
        const reason = toAppError(cause)?.detail.message.trim();
        return {
          kind: 'failed',
          message: `Added. Couldn't install it for every harness${reason ? `: ${reason}` : '.'}`,
        };
      }
    },
    [discoveryEnabled, settledHarnesses],
  );
}
