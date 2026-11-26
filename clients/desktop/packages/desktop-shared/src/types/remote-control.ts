import type { DeviceKind, DevicePlatform } from '@canopy/protocol/device-relay';
import type { CloudProjectBinding } from '@canopy/protocol/memory-sync';
import type { RemoteHostUpdateStatus } from '@canopy/protocol/remote-control';

export type { RemoteHostUpdateStatus } from '@canopy/protocol/remote-control';

/**
 * Renderer-facing contract for device-to-device remote control.
 * Design: docs/planning/2026-10-05-device-remote-control/README.md
 */

/** Which computer a window shows. */
export type RemoteControlContext =
  | { mode: 'local' }
  | {
      mode: 'remote';
      deviceId: string;
      name: string;
      platform: DevicePlatform;
    };

export type RemoteRelayStatus =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unavailable';

export type RemoteHostConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error';

export interface RemoteControlDevice {
  deviceId: string;
  name: string;
  platform: DevicePlatform;
}

/** A computer this device has paired with and may control. */
export interface RemoteControlHost extends RemoteControlDevice {
  pairedAt: string;
  online: boolean;
  connection: RemoteHostConnectionStatus;
  error: string | null;
  /**
   * The other computer ended the session or withdrew access. Nothing retries
   * until this computer opens it again; otherwise a dropped connection keeps
   * retrying on its own.
   */
  ended: boolean;
  /**
   * The two computers run different remote-control protocols and one of
   * them needs an update; null otherwise. While it is set, the window can't
   * show the other computer and offers the update instead (CAN-5899).
   */
  update: RemoteHostUpdateStatus | null;
}

/**
 * A short-lived session a hosted agents root opened through a signed
 * delegation. It is attributed to, and revoked with, its root.
 */
export interface RemoteControlHostedSession {
  /** The ephemeral relay device the session runs over. */
  deviceId: string;
  /** ISO timestamp; the session closes then at the latest. */
  expiresAt: string;
}

/** A device allowed to control this computer. */
export interface RemoteControlController extends RemoteControlDevice {
  /**
   * The controller profile this pairing is held to: what the relay
   * authenticated, never what the device said about itself. Pairings saved
   * before kinds existed are `desktop`.
   */
  kind: DeviceKind;
  pairedAt: string;
  online: boolean;
  /** Whether it is controlling this computer right now. */
  connected: boolean;
  /** Live delegated sessions, for a hosted agents root; otherwise empty. */
  hostedSessions: RemoteControlHostedSession[];
}

export type RemoteOutgoingPairingStatus =
  | 'connecting'
  | 'awaiting-approval'
  | 'approved'
  | 'rejected'
  | 'failed';

export interface RemoteOutgoingPairing extends RemoteControlDevice {
  status: RemoteOutgoingPairingStatus;
  /** Six-digit code both computers show; null until the handshake ends. */
  code: string | null;
  error: string | null;
}

export interface RemoteIncomingPairing extends RemoteControlDevice {
  pairingId: string;
  /** The relay-authenticated kind of the asking device. */
  kind: DeviceKind;
  code: string;
}

/** The open pairing link window; its secret never leaves the main process. */
export interface RemoteControlPairingWindowState {
  /** ISO timestamp. */
  expiresAt: string;
}

export interface RemoteControlOpenPairingWindowResult {
  /** The link to show as a QR code; possession authorizes one pairing. */
  link: string;
  /** ISO timestamp. */
  expiresAt: string;
}

export type RemoteControlPairingWindowCloseReason =
  | 'expired'
  | 'replaced'
  | 'closed'
  | 'disabled'
  | 'consumed';

export type RemoteControlPairingRequestOutcome =
  | 'approved'
  | 'declined'
  | 'cancelled'
  | 'timed-out'
  | 'failed';

/** Pairing progress on this computer, pushed on `remote-control:pairing-event`. */
export type RemoteControlPairingEvent =
  | { type: 'window-opened'; expiresAt: string }
  | { type: 'window-closed'; reason: RemoteControlPairingWindowCloseReason }
  /** A device asks to pair without a link and needs Allow or Deny. */
  | { type: 'request'; pairing: RemoteIncomingPairing }
  | {
      type: 'request-ended';
      pairingId: string;
      outcome: RemoteControlPairingRequestOutcome;
    }
  /** A pairing was saved; reported only after it is durable. */
  | {
      type: 'paired';
      deviceId: string;
      name: string;
      kind: DeviceKind;
      method: 'link' | 'code' | 'expected';
    };

/** `remote-control:install-id`: this computer's stable install identifier. */
export interface RemoteControlInstallIdResult {
  installId: string;
}

/** Progress of the delete that turning inventory sync off starts. */
export type RemoteControlInventoryDeleteStatus = 'idle' | 'pending' | 'failed';

export interface RemoteControlState {
  /** The feature flag is on. */
  available: boolean;
  /** Signed in to an account the relay can authenticate. */
  signedIn: boolean;
  relayStatus: RemoteRelayStatus;
  relayDetail: string | null;
  thisDevice: RemoteControlDevice | null;
  allowIncoming: boolean;
  /** Paired computers that control this one may install its updates. */
  allowRemoteUpdates: boolean;
  /**
   * Paired desktop computers that control this one may open its local web
   * servers on localhost (CAN-7712). Off until turned on; an opt-out holds
   * even if its save failed, and an opt-in counts once saved. It applies only while Allow incoming
   * and the `canopy-remote-web-preview` flag are on.
   */
  allowWebPreview: boolean;
  /**
   * The saved web preview choice couldn't be read (a read error, a damaged
   * file, or a directory in its place), and no choice has been made since:
   * preview reads off, but the file may still hold an opt-in that a later
   * read would find, so Settings offers to save off (CAN-7712). Local only;
   * absent reads as false.
   */
  webPreviewChoiceUnread?: boolean;
  /**
   * This computer syncs its plugin, MCP and pipeline lists to the web while
   * Allow incoming is on (CAN-5986). Optional on the wire: hosts that
   * predate the field do not send it, and readers treat it as on.
   */
  inventorySyncEnabled?: boolean;
  /**
   * The server-side delete that turning inventory sync off started:
   * `pending` until it succeeds, `failed` while it retries. Local only.
   */
  inventoryDeleteStatus?: RemoteControlInventoryDeleteStatus;
  hosts: RemoteControlHost[];
  controllers: RemoteControlController[];
  /** Online devices on this account that accept pairing and are not paired. */
  discoverable: RemoteControlDevice[];
  outgoingPairing: RemoteOutgoingPairing | null;
  incomingPairings: RemoteIncomingPairing[];
  /** The open pairing link window, or null. */
  pairingWindow: RemoteControlPairingWindowState | null;
}

export interface RemoteControlGetStateRequest {
  /** Keep the relay connected for a few minutes to list pairable devices. */
  discover?: boolean;
}

export interface RemoteControlRespondToPairingRequest {
  pairingId: string;
  approve: boolean;
}

/**
 * An update step for the paired computer a window shows, while the two run
 * different protocols: start the update, restart it now instead of waiting
 * for its running chats, or withdraw the restart this computer asked for.
 */
export type RemoteControlHostUpdateAction = 'update' | 'restart-now' | 'cancel';

export interface RemoteControlUpdateHostRequest {
  deviceId: string;
  action: RemoteControlHostUpdateAction;
}

export interface RemoteControlForgetDeviceRequest {
  deviceId: string;
  role: 'host' | 'controller';
}

export type RemotePathPickerMode = 'directory' | 'file';

/** Main asks a remote window to pick a path on the controlled computer. */
export interface RemotePathPickerRequest {
  requestId: string;
  mode: RemotePathPickerMode;
  title: string;
}

export interface RemotePathPickerResponse {
  requestId: string;
  /** Absolute path on the controlled computer, or null when cancelled. */
  path: string | null;
}

export interface RemoteDirectoryListRequest {
  /** Absolute directory on the controlled computer; null for home. */
  path: string | null;
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
}

export interface RemoteDirectoryListing {
  path: string;
  parent: string | null;
  entries: RemoteDirectoryEntry[];
}

/**
 * Largest file one upload carries. Each upload is one session message, so
 * this stays below the session's 256 MiB message limit with room to spare.
 */
export const REMOTE_UPLOAD_MAX_BYTES = 240 * 1024 * 1024;

export const REMOTE_UPLOAD_TOO_LARGE_MESSAGE =
  'File is too large to send to the other computer.';

/**
 * Why Connect Slack on this computer (`slack:connect-this-computer`,
 * CAN-7606) did not finish.
 *
 * - `not_enabled`: Slack mentions are off for this app or account (always in
 *   a local-only build); nothing was changed or sent.
 * - `signed_out`: no account (or a guest) is signed in; nothing was sent.
 * - `identity_changed`: the account changed while connecting.
 * - The hosted Remote Control admission refusals, from the web:
 *   `entitlement_denied`, `personal_account_required`, `feature_disabled`,
 *   `hosted_pairing_busy`, `hosted_capacity`, `entitlement_unavailable`,
 *   `device_relay_not_configured`, `forbidden` (this computer's relay device
 *   is not this account's).
 * - Pairing failures: `denied`, `offline`, `host_unsupported`, `timeout`
 *   (also the 2-minute overall deadline), `failed`, `link_failed`.
 * - `too_many_attempts`: too many unfinished connects for this account.
 * - `browser_failed`: the signed-in Slack page could not be opened.
 *
 * A failure after Listen for Slack mentions and Allow incoming were turned
 * on leaves both on.
 */
export type SlackConnectThisComputerFailure =
  | 'not_enabled'
  | 'signed_out'
  | 'identity_changed'
  | 'entitlement_denied'
  | 'personal_account_required'
  | 'feature_disabled'
  | 'hosted_pairing_busy'
  | 'hosted_capacity'
  | 'entitlement_unavailable'
  | 'device_relay_not_configured'
  | 'forbidden'
  | 'denied'
  | 'offline'
  | 'host_unsupported'
  | 'timeout'
  | 'failed'
  | 'link_failed'
  | 'too_many_attempts'
  | 'browser_failed';

export type SlackConnectThisComputerResult =
  | { ok: true }
  | { ok: false; reason: SlackConnectThisComputerFailure };

export interface RemoteControlApi {
  /** Synchronous: which computer this window shows. */
  getContext(): RemoteControlContext;
  getState(request?: RemoteControlGetStateRequest): Promise<RemoteControlState>;
  onStateChanged(listener: (state: RemoteControlState) => void): () => void;
  /** Opens or focuses a computer's window; null means this computer. */
  openMachine(deviceId: string | null): Promise<void>;
  /**
   * The single Remote Control opt-in. Turning it off ends incoming direct
   * and Portal sessions and closes the pairing window; pairings are kept.
   */
  setAllowIncoming(allow: boolean): Promise<RemoteControlState>;
  setAllowRemoteUpdates(allow: boolean): Promise<RemoteControlState>;
  /**
   * This computer's web preview consent (CAN-7712). Turning it off resets
   * every preview stream at once and ends, without resume, each session
   * that carried preview data. Frames already handed to the relay may still
   * drain until CAN-7715.
   */
  setAllowWebPreview(allow: boolean): Promise<RemoteControlState>;
  /**
   * This computer's inventory sync switch. Turning it off (after the user
   * confirms) deletes this computer's synced lists from the web for the
   * signed-in account; turning it on re-syncs them. The IPC stays local
   * only, but a paired controller can answer the approval card an agent's
   * `inventory_sync.set_enabled` shows on this computer (CAN-7262).
   */
  setInventorySyncEnabled(enabled: boolean): Promise<RemoteControlState>;
  /** Opens, or replaces, the pairing link window. Needs Remote Control on. */
  openPairingWindow(): Promise<RemoteControlOpenPairingWindowResult>;
  closePairingWindow(): Promise<RemoteControlState>;
  onPairingEvent(
    listener: (event: RemoteControlPairingEvent) => void,
  ): () => void;
  startPairing(deviceId: string): Promise<RemoteControlState>;
  cancelPairing(): Promise<RemoteControlState>;
  respondToPairing(
    request: RemoteControlRespondToPairingRequest,
  ): Promise<RemoteControlState>;
  forgetDevice(
    request: RemoteControlForgetDeviceRequest,
  ): Promise<RemoteControlState>;
  disconnectController(deviceId: string): Promise<RemoteControlState>;
  /**
   * Updates a paired computer that runs an older protocol (CAN-5899).
   * Resolves once the step is accepted; progress arrives with the state.
   */
  updateHost(request: RemoteControlUpdateHostRequest): Promise<void>;
  onPathPickerRequest(
    listener: (request: RemotePathPickerRequest) => void,
  ): () => void;
  resolvePathPicker(response: RemotePathPickerResponse): Promise<void>;
  listDirectory(
    request: RemoteDirectoryListRequest,
  ): Promise<RemoteDirectoryListing>;
  /**
   * Connect Slack on this computer (CAN-7606): one click turns on Listen for
   * Slack mentions and Allow incoming, pairs this computer for agents with no
   * prompt when it isn't yet, and opens the browser signed in at Slack's
   * sign-in. A second call while one runs joins it. Never throws for a
   * refusal; resolves to its reason.
   */
  connectSlackThisComputer(): Promise<SlackConnectThisComputerResult>;
}

/** A computer's remote-control version, as the other computer sees it. */
export interface PairedComputerVersion {
  protocolVersion: number;
  /** Shown to the user only. */
  appVersion: string;
}

/**
 * Why a paired computer and this one cannot work together in the main
 * window until one of them updates (CAN-7761):
 *
 * - `computer-too-old`: the paired computer is below the one-window floor,
 *   or predates the version check;
 * - `computer-without-one-window`: it is at or above the floor but does not
 *   serve the one-window mode on another protocol than this computer's;
 * - `this-computer-older`: the paired computer is newer and no longer
 *   serves this computer's protocol.
 */
export type PairedComputerUpdateReason =
  | 'computer-too-old'
  | 'computer-without-one-window'
  | 'this-computer-older';

/**
 * Why a paired computer can't be reached from the main window right now,
 * other than its version:
 *
 * - `not-paired`: this computer has no pairing with that device;
 * - `remote-control-off`: Remote Control isn't running on this computer
 *   (turned off, signed out);
 * - `one-window-off`: the one-window switch is off on this computer;
 * - `offline`: the computer isn't on the relay;
 * - `ended`: it ended the session or withdrew access; nothing retries until
 *   it is held again;
 * - `error`: the connection failed and is being retried.
 */
export type PairedComputerUnavailableReason =
  | 'not-paired'
  | 'remote-control-off'
  | 'one-window-off'
  | 'offline'
  | 'ended'
  | 'error';

/**
 * A paired computer's connection as the main window sees it (CAN-7761).
 * State only: the window decides what to show (CAN-7766, CAN-7770).
 */
export type PairedComputerState =
  /** Nothing in this computer holds a connection to it. */
  | { status: 'idle' }
  | { status: 'connecting' }
  | {
      status: 'connected';
      version: PairedComputerVersion;
      /**
       * The one-window capabilities it serves to this computer
       * (`ONE_WINDOW_CAPABILITY_CHANNELS`); a feature whose capability is
       * missing is off for that computer.
       */
      capabilities: string[];
    }
  | {
      status: 'needs-update';
      reason: PairedComputerUpdateReason;
      /** Null when it predates the version check. */
      computerVersion: PairedComputerVersion | null;
      /** Its app version as it reports it, shown to the user. */
      computerAppVersion: string;
      thisComputerVersion: PairedComputerVersion;
      /** The update one of the two can run, as the separate window shows it. */
      update: RemoteHostUpdateStatus | null;
    }
  | {
      status: 'unavailable';
      reason: PairedComputerUnavailableReason;
      message: string | null;
    };

/** What a paired computer sent, on its own subscription. */
export type PairedComputerUpdate =
  /** A push on one of the one-window channels, with that computer's ids. */
  | { type: 'push'; channel: string; args: unknown[] }
  /**
   * A new handshake replaced a dropped session: pushes may have been
   * missed, so read again what was read from it.
   */
  | { type: 'reconnected' };

/** One window's hold on a paired computer's connection. */
export interface PairedComputerHoldResult {
  /** Pass to `release`; dead once the connection closes under it. */
  holdId: string;
  state: PairedComputerState;
}

/**
 * Main → window: one paired computer's update or state change, sent only to
 * windows that hold it. The preload splits these per computer.
 */
export type PairedComputerWindowEvent =
  | ({ deviceId: string } & PairedComputerUpdate)
  | { deviceId: string; type: 'state'; state: PairedComputerState };

/**
 * What this computer knows about one of its projects beyond its sidebar row,
 * for matching it with a paired computer's copy (CAN-7766): the stored cloud
 * binding, and each repository's address as a credential-free
 * `https://<host>/<path>.git` (null for a repository with no usable origin).
 */
export interface PairedComputerLocalProjectFacts {
  cloudBinding: CloudProjectBinding | null;
  repositoryRemotes: (string | null)[];
}

/**
 * The main window's API for a named paired computer (CAN-7761), beside the
 * local IPC it keeps using unchanged. Each call names the computer by its
 * relay device id and carries that computer's own local ids: strip a
 * `computer-<deviceId>:` qualifier before calling (see
 * `pairedComputerAddress` in the renderer). Main offers only the reviewed
 * one-window channels the computer announced and refuses anything else.
 * Installed in this computer's own windows only, never in a window showing
 * another computer; the renderer reads it through its one-window switch.
 */
export interface PairedComputersApi {
  /**
   * Keeps the computer's connection open until released, the window closes,
   * the computer is unpaired or the one-window switch turns off. Refused
   * when the computer isn't paired or the switch is off.
   */
  hold(deviceId: string): Promise<PairedComputerHoldResult>;
  release(holdId: string): Promise<void>;
  /** Calls a one-window channel on a computer this window holds. */
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<unknown>;
  /** Sends on a one-window channel; dropped when main refuses it. */
  send(deviceId: string, channel: string, args: unknown[]): void;
  getState(deviceId: string): Promise<PairedComputerState>;
  /**
   * This computer's facts for the projects named, by project id (CAN-7766);
   * a project main can't read is left out. A local read, cached in main.
   */
  localProjectFacts(
    projectIds: string[],
  ): Promise<Record<string, PairedComputerLocalProjectFacts>>;
  /** That computer's pushes and reconnects, and nothing from any other. */
  onUpdate(
    deviceId: string,
    listener: (update: PairedComputerUpdate) => void,
  ): () => void;
  /** That computer's connection state changes. */
  onStateChanged(
    deviceId: string,
    listener: (state: PairedComputerState) => void,
  ): () => void;
}
