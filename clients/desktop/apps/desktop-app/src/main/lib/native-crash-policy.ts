import { app, crashReporter } from 'electron';
import {
  createMainCrashAnnotation,
  MAIN_CRASH_ELIGIBLE_ANNOTATION,
  resolveMainCrashCapturePolicy,
  type MainCrashAnnotation,
  type MainCrashCapturePolicy,
} from '@canopy/desktop-instrumentation/electron/main';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags/service';
import { getUsageDataPolicy } from './usage-data-policy';

function readCommittedCrashPolicy(): MainCrashCapturePolicy {
  const policy = getUsageDataPolicy();
  const usage = policy.getUsageDataPolicySnapshot();
  const flags = getFeatureFlagService();
  return resolveMainCrashCapturePolicy(
    flags.getSnapshot(),
    {
      preferenceOptOut: !usage.preferences.errorReports,
      organizationOptOut: Boolean(
        usage.prohibitedBy.errorReports?.organizationName,
      ),
      contextResolved: policy.hasWorkspaceContext(),
      effective: usage.effective.errorReports,
    },
    flags.getLiveBooleanValue(
      CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key,
    ),
  );
}

export const nativeCrashAnnotation: MainCrashAnnotation =
  createMainCrashAnnotation(readCommittedCrashPolicy, (eligible): void => {
    if (eligible) {
      crashReporter.addExtraParameter(
        MAIN_CRASH_ELIGIBLE_ANNOTATION,
        app.getVersion(),
      );
    } else {
      crashReporter.removeExtraParameter(MAIN_CRASH_ELIGIBLE_ANNOTATION);
    }
  });

/** Install after the shared consent store has loaded saved preferences. */
export function observeNativeCrashPolicy(): void {
  getUsageDataPolicy().subscribe(nativeCrashAnnotation.refresh, {
    includeErrorReportsPreference: true,
  });
  getFeatureFlagService().onSnapshotChanged(nativeCrashAnnotation.refresh);
  nativeCrashAnnotation.start();
}
