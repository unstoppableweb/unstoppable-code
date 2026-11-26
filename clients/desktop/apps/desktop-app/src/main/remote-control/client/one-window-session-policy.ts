import {
  ONE_WINDOW_CAPABILITIES,
  ONE_WINDOW_CAPABILITY_CHANNELS,
  oneWindowControllerProfile,
  oneWindowHostChannels,
  oneWindowInvocationAllowed,
  type OneWindowCapability,
} from '@canopy/protocol/remote-control/channels';
import type { HelloResult, RemoteVersion } from '../remote-protocol';
import type { WindowlessSessionPolicy } from './paired-computer-connections';

/**
 * The windowless session policy of the one-window work (CAN-7761): the
 * hello carries CAN-7758's one-window profile, and a channel is allowed
 * only when it is on the reviewed list and the computer announced its
 * capability in the hello (`oneWindowHostChannels`). Calls and sends also
 * pass `oneWindowInvocationAllowed` on their arguments. Main injects it only
 * while the one-window switch is on.
 */
export function createOneWindowSessionPolicy(
  local: RemoteVersion,
): WindowlessSessionPolicy {
  // Pushes are checked one by one, so each hello's channel set is built once.
  const channelsByHello = new WeakMap<HelloResult, ReadonlySet<string>>();
  const channelsOf = (hello: HelloResult): ReadonlySet<string> => {
    let channels = channelsByHello.get(hello);
    if (!channels) {
      channels = oneWindowHostChannels(hello, local) ?? new Set<string>();
      channelsByHello.set(hello, channels);
    }
    return channels;
  };
  return {
    controllerProfile: oneWindowControllerProfile,
    allowsChannel: (channel, hello) => channelsOf(hello).has(channel),
    allowsInvocation: (channel, args, hello) =>
      channelsOf(hello).has(channel) &&
      oneWindowInvocationAllowed(channel, args),
  };
}

/**
 * The one-window capabilities a computer serves to this one: each whose
 * every channel its hello allows. Sorted, as `ONE_WINDOW_CAPABILITIES`.
 */
export function oneWindowHostCapabilities(
  hello: HelloResult,
  local: RemoteVersion,
): OneWindowCapability[] {
  const channels = oneWindowHostChannels(hello, local);
  if (!channels) return [];
  return ONE_WINDOW_CAPABILITIES.filter((capability) =>
    ONE_WINDOW_CAPABILITY_CHANNELS[capability].every((channel) =>
      channels.has(channel),
    ),
  );
}

/** The one-window switch as main reads it (`main/lib/one-window-switch.ts`). */
export interface OneWindowSwitch {
  isEnabled: () => boolean;
  /** Returns the unsubscribe. */
  onChange: (listener: (enabled: boolean) => void) => () => void;
}

/**
 * Keeps the service's windowless policy in step with the switch: `policy`
 * while it is on, none while it is off. The switch reads off until startup
 * has read the saved choice and while preferences are unconfirmed, and turns
 * off when a failed recovery latches; each time it goes off every windowless
 * session closes and every hold is dropped. Returns the unsubscribe.
 */
export function followOneWindowSwitch(
  service: {
    setWindowlessSession: (policy: WindowlessSessionPolicy | null) => void;
  },
  oneWindow: OneWindowSwitch,
  policy: WindowlessSessionPolicy,
): () => void {
  const apply = (enabled: boolean): void =>
    service.setWindowlessSession(enabled ? policy : null);
  const stop = oneWindow.onChange(apply);
  apply(oneWindow.isEnabled());
  return stop;
}
