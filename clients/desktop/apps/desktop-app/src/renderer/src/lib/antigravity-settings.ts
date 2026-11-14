import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

type FlagReader = Pick<
  ReturnType<typeof useFeatureFlagsStore.getState>,
  'isEnabled'
>;

export function isAntigravityHarnessReleased(state: FlagReader): boolean {
  return (
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key) &&
    state.isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarnessReleased.key,
    )
  );
}

export function getAntigravitySettingsSection(): 'account' | 'experiments' {
  return isAntigravityHarnessReleased(useFeatureFlagsStore.getState())
    ? 'account'
    : 'experiments';
}
