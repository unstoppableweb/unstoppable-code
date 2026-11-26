import type { UsageDataPolicySnapshot } from '@canopy/desktop-shared/types';
import type { PostHogRuntimeFlags } from '@canopy/desktop-instrumentation/types';
import {
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';

function postHogFlagsFromSnapshot(snapshot: FeatureFlagSnapshot): {
  captureEnabled: boolean;
  sessionReplaySampleRate: number;
  autocaptureEnabled: boolean;
} {
  return {
    captureEnabled:
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key],
    sessionReplaySampleRate:
      snapshot.values[
        CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate.key
      ],
    autocaptureEnabled:
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled.key],
  };
}

/**
 * Combines the LaunchDarkly snapshot with main's effective usage-data policy
 * into one `PostHogRuntimeFlags` object. The policy flags stay `false` until
 * the policy has been read (fail closed), and a read never overwrites a newer
 * push from either source.
 *
 * The capture kill switch fails closed (CAN-4181 F5): flags come only from
 * main's `feature-flags:*` IPC, read and subscribed here when instrumentation
 * starts, before App mounts. Neither the store's follower, which starts on
 * mount, nor core's cached copy, which a relay failure leaves stale, can hold
 * capture on after main turns it off.
 */
export function createPostHogFlagSource(): {
  getSnapshot: () => Promise<PostHogRuntimeFlags>;
  onSnapshotChanged: (
    listener: (flags: PostHogRuntimeFlags) => void,
  ) => () => void;
} {
  let flags: FeatureFlagSnapshot | undefined;
  let policy: UsageDataPolicySnapshot | undefined;
  let flagsRevision = 0;
  let policyRevision = 0;
  const listeners = new Set<(flags: PostHogRuntimeFlags) => void>();
  const combine = (): PostHogRuntimeFlags => ({
    ...(flags
      ? postHogFlagsFromSnapshot(flags)
      : {
          captureEnabled: false,
          sessionReplaySampleRate: 0,
          autocaptureEnabled: false,
        }),
    productAnalytics: policy?.effective.productAnalytics === true,
    errorReports: policy?.effective.errorReports === true,
    sessionReplay: policy?.effective.sessionReplay === true,
  });
  return {
    getSnapshot: async () => {
      const startFlags = flagsRevision;
      const startPolicy = policyRevision;
      // A failed policy read leaves the usage-data flags closed until main
      // pushes the policy; a failed flag read propagates as before.
      const [flagsRead, policyRead] = await Promise.allSettled([
        window.api.featureFlags.getSnapshot(),
        window.api.observability.getUsageDataPolicy(),
      ]);
      if (flagsRead.status === 'rejected') throw flagsRead.reason;
      const nextFlags = flagsRead.value;
      const nextPolicy =
        policyRead.status === 'fulfilled' ? policyRead.value : undefined;
      const pushed =
        flagsRevision !== startFlags || policyRevision !== startPolicy;
      if (flagsRevision === startFlags) flags = nextFlags;
      if (policyRevision === startPolicy && nextPolicy) policy = nextPolicy;
      const combined = combine();
      // A push during the read published a half-known state; the client
      // drops this read in favor of that push, so republish the merge.
      if (pushed) listeners.forEach((listener) => listener(combined));
      return combined;
    },
    onSnapshotChanged: (listener) => {
      listeners.add(listener);
      const unsubscribeFlags = window.api.featureFlags.onSnapshotChanged(
        (snapshot) => {
          flagsRevision++;
          flags = snapshot;
          listener(combine());
        },
      );
      const unsubscribePolicy =
        window.api.observability.onUsageDataPolicyChanged((snapshot) => {
          policyRevision++;
          policy = snapshot;
          listener(combine());
        });
      return (): void => {
        listeners.delete(listener);
        unsubscribeFlags();
        unsubscribePolicy();
      };
    },
  };
}
