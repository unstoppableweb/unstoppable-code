import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { isChannelUnavailableRejection } from '@canopy/protocol/remote-control';
import { useEffect, useState } from 'react';
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

/**
 * Operating systems that pin an Antigravity CLI for some architecture: macOS
 * and Linux. Windows never asks main. The architecture is main's to judge,
 * through readAntigravityHostSupport.
 */
export function isAntigravityPlatform(
  platform: NodeJS.Platform = window.platform,
): boolean {
  return platform === 'darwin' || platform === 'linux';
}

/** The host-support IPC channel, named in an older host's refusal. */
const HOST_SUPPORT_CHANNEL = 'antigravity-runtime:host-support';

/** One read per runtime bridge, which a window has one of. */
const hostSupport = new WeakMap<object, Promise<boolean>>();

/**
 * Whether main pins an Antigravity CLI for this host. It asks host support,
 * which reads only the manifest's pinned artifacts (macOS and Linux on arm64
 * and x64), so a Linux architecture without a pin hides Google chats without
 * main resolving or hashing the CLI. A controlled computer older than that
 * channel refuses it, so this falls back to its runtime status's `supported`.
 * The answer can't change while the app runs, so each window reads it once;
 * a failed read reports unsupported and the next caller reads again.
 */
export function readAntigravityHostSupport(
  platform: NodeJS.Platform = window.platform,
): Promise<boolean> {
  if (!isAntigravityPlatform(platform)) return Promise.resolve(false);
  const runtime = window.api.antigravityRuntime;
  if (!runtime) return Promise.resolve(false);
  const known = hostSupport.get(runtime);
  if (known) return known;
  const read = runtime
    .hostSupported()
    .catch((reason: unknown) => {
      // Only a controlled computer older than this channel falls back.
      if (!isChannelUnavailableRejection(reason, HOST_SUPPORT_CHANNEL))
        throw reason;
      return runtime.status().then((status) => status.supported);
    })
    .catch((reason: unknown) => {
      hostSupport.delete(runtime);
      reportClientAppError(reason);
      return false;
    });
  hostSupport.set(runtime, read);
  return read;
}

/**
 * readAntigravityHostSupport for a component, asked only once `enabled` (the
 * caller's rollout and feature checks) is true, so a window with Google chats
 * off never asks main. False until main answers.
 */
export function useAntigravityHostSupported(enabled: boolean): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    void readAntigravityHostSupport().then((value) => {
      if (current) setSupported(value);
    });
    return (): void => {
      current = false;
    };
  }, [enabled]);
  return enabled && supported;
}

export function getAntigravitySettingsSection(): 'account' | 'experiments' {
  return isAntigravityHarnessReleased(useFeatureFlagsStore.getState())
    ? 'account'
    : 'experiments';
}
