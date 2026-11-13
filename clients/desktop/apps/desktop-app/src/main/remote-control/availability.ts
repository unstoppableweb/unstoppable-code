import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import {
  isRemoteControlEnabled,
  onRemoteControlEnabledChanged,
} from '../lib/remote-control-preference';
import type { RemoteControlAvailability } from './diagnostics';

/** The inputs to {@link isRemoteControlAvailable}, for diagnostics. */
export function describeRemoteControlAvailability(): RemoteControlAvailability {
  const flags = getFeatureFlagService();
  return {
    labsEnabled: isRemoteControlEnabled(),
    flagEnabled: flags.isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDeviceRemoteControl.key,
    ),
    flagStatus: flags.getSnapshot().status,
  };
}

/**
 * Whether remote control is available now, and whether a "no" may be the
 * flag's value still settling rather than a decision.
 */
export interface RemoteControlFeatureState {
  enabled: boolean;
  /**
   * Off only because the flag has no live value right now: the Labs switch
   * is on, the flag service is initializing or in an outage, and the value
   * it holds is not one LaunchDarkly served. A live `false`, including one
   * an error or initializing snapshot keeps, the Labs switch and an
   * unconfigured flag service are never transient.
   */
  transient: boolean;
}

/** {@link isRemoteControlAvailable}, with whether a "no" is transient. */
export function remoteControlFeatureState(): RemoteControlFeatureState {
  const { labsEnabled, flagEnabled, flagStatus } =
    describeRemoteControlAvailability();
  const enabled = labsEnabled && flagEnabled;
  if (
    enabled ||
    !labsEnabled ||
    (flagStatus !== 'initializing' && flagStatus !== 'error')
  ) {
    return { enabled, transient: false };
  }
  // The kill switch: a false LaunchDarkly served stays a decision while the
  // service retries, so it stops the relay at once.
  const { liveValues } = getFeatureFlagService().getLabsAvailabilityState();
  return {
    enabled,
    transient:
      liveValues[CLIENT_FEATURE_FLAGS.canopyDeviceRemoteControl.key] !== false,
  };
}

/**
 * Remote control needs its feature flag and its own switch in Settings →
 * Labs. While either is off this computer stays off the relay, so
 * nothing can pair with or control it.
 */
export function isRemoteControlAvailable(): boolean {
  return (
    isRemoteControlEnabled() &&
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDeviceRemoteControl.key,
    )
  );
}

/** Calls `listener` when the flag or the switch may have changed. */
export function onRemoteControlAvailabilityChanged(
  listener: () => void,
): () => void {
  const unsubscribeFlags = getFeatureFlagService().onSnapshotChanged(listener);
  const unsubscribeSwitch = onRemoteControlEnabledChanged(listener);
  return () => {
    unsubscribeFlags();
    unsubscribeSwitch();
  };
}
