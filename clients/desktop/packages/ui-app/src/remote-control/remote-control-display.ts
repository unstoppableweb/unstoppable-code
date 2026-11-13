import type { DeviceKind, DevicePlatform } from '@canopy/protocol/device-relay';
import type { DotTone } from '@canopy/ui-shared/components';

/**
 * Display helpers shared by the Remote Control surfaces on every host: the
 * pairing flow, the device lists and the desktop's sidebar computer picker.
 */
export const ADD_COMPUTER_LABEL = 'Add a computer…';
/**
 * The same action as a settings row, which opens its dialog without an
 * ellipsis like `Pair a device` beside it. One name everywhere: pairing adds
 * an existing computer to this one's list (docs/ux-writing/labels.md).
 */
export const ADD_COMPUTER_ROW_LABEL = 'Add a computer';
/** The account menu row whose submenu lists the account's computers. */
export const COMPUTERS_LABEL = 'Computers';
export const CONTROL_RISK_SENTENCE =
  'can see and change everything on this computer, including running commands';
/**
 * What a hosted agents controller is held back from, as the device list and
 * the desktop's approval prompt both say it (CAN-5985 A6 and B).
 */
export const HOSTED_CONTROLLER_LIMITS =
  "Can't use terminals, answer approvals or delete work";
/** The settings action that pairs a device to control this computer. */
export const PAIR_DEVICE_LABEL = 'Pair a device';

/**
 * A paired controller's kind, as a person names the device. The relay
 * authenticates the kind; a display name never decides it.
 */
const DEVICE_KIND_LABELS: Record<DeviceKind, string> = {
  desktop: 'Computer',
  mobile: 'Phone',
  browser: 'Browser',
  hosted: 'Agents',
};

export function deviceKindLabel(kind: DeviceKind): string {
  return DEVICE_KIND_LABELS[kind];
}

const PLATFORM_LABELS: Record<DevicePlatform, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

export function platformLabel(platform: DevicePlatform): string {
  return PLATFORM_LABELS[platform];
}

/**
 * How this device's connection to a computer it controls is doing.
 * `reconnecting`: a session was open and its transport is coming back (the
 * web's direct relay connection); the desktop never reports it.
 */
export type RemoteControlHostConnection =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'error';

export type RemoteHostTone = 'connected' | 'pending' | 'failed' | 'idle';

export interface RemoteHostStatus {
  readonly label: string;
  readonly tone: RemoteHostTone;
}

/** What a paired computer is doing right now, in one short label. */
export function remoteHostStatus(host: {
  readonly online: boolean;
  readonly connection: RemoteControlHostConnection;
}): RemoteHostStatus {
  switch (host.connection) {
    case 'connected':
      return { label: 'Connected', tone: 'connected' };
    case 'connecting':
      return { label: 'Connecting…', tone: 'pending' };
    case 'reconnecting':
      return { label: 'Reconnecting…', tone: 'pending' };
    case 'error':
      return { label: "Can't connect", tone: 'failed' };
    case 'idle':
      return host.online
        ? { label: 'Online', tone: 'idle' }
        : { label: 'Offline', tone: 'idle' };
  }
}

/**
 * The connection Dot for a host tone: green when connected, red when it
 * can't connect; `null` when the label alone says it (connecting, idle).
 */
export function remoteHostDotTone(tone: RemoteHostTone): DotTone | null {
  switch (tone) {
    case 'connected':
      return 'success';
    case 'failed':
      return 'danger';
    case 'pending':
    case 'idle':
      return null;
  }
}
