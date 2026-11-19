import { useMemo } from 'react';
import {
  offeredPluginHarnesses,
  type PluginHarnessId,
} from '@canopy/plugin-interop/harness-support';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';

/**
 * The harnesses this build offers for plugins, gated by its own flags. The
 * plugin page's Works with table and New Customize's tile chips both list
 * exactly these.
 */
export function useOfferedPluginHarnesses(): readonly PluginHarnessId[] {
  const cursor = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const copilot = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const opencode = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  // Labs: listed only where Google models were discovered, as in the picker.
  const antigravityFlag = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key),
  );
  const antigravityDiscovered = useModelCatalogStore(
    (state) => (state.snapshot?.antigravity?.length ?? 0) > 0,
  );
  const antigravity = antigravityFlag && antigravityDiscovered;
  return useMemo(
    () => offeredPluginHarnesses({ cursor, copilot, opencode, antigravity }),
    [cursor, copilot, opencode, antigravity],
  );
}
