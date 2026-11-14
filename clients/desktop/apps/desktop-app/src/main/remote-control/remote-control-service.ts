import { classifyError } from '@canopy/protocol/app-errors/classification';
import type {
  PairingTelemetryAttempt,
  PairingTelemetryRecorder,
  PairingTelemetryOutcome,
  RemoteControlPairingFailureReason,
  RemoteControlSessionEndReason,
  RemoteControlTelemetryEvent,
  RemoteControlTelemetryRecorder,
} from '@canopy/desktop-instrumentation/pairing';
import { beginPairingTelemetry } from '../lib/pairing-telemetry';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol/ui-labels';
import { randomBytes, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  DEVICE_RELAY_FEATURE_DEVICE_KIND,
  deviceKindOrDefault,
  type DeviceKind,
  type DevicePlatform,
  type DeviceRelayDeviceInfo,
  type DeviceRelayTokenResponse,
} from '@canopy/protocol/device-relay';
import { wakeLockHolder, wakeLockHolderKey } from '@canopy/core-runtime';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  RemoteControlForgetDeviceRequest,
  RemoteControlOpenPairingWindowResult,
  RemoteControlPairingEvent,
  RemoteControlPairingRequestOutcome,
  RemoteControlPairingWindowCloseReason,
  RemoteControlRespondToPairingRequest,
  RemoteControlState,
  RemoteIncomingPairing,
  RemoteOutgoingPairing,
} from '@canopy/desktop-shared/types';
import {
  RemoteHostConnection,
  type PinnedHostSession,
} from './client/host-connection';
import {
  assertSafeToOpen,
  copyRemoteFile,
  parseFileOpenTarget,
  remoteImageForLocalOpen,
} from './client/remote-file-opens';
import type { RemoteControlWindows } from './client/remote-windows';
import type { RemoteControlFeatureState } from './availability';
import { encodeBase64Url, type DeviceKeyPair } from './crypto/device-key';
import type {
  RemoteControlAvailability,
  RemoteControlDiagnostic,
  RemoteRelayStoppedDiagnostic,
} from './diagnostics';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import type { RemoteAppAdvisorSurface } from './host/app-advisor-surface';
import type { HostBridge } from './host/bridge-window';
import type { RemoteCoreAccess } from './host/remote-core-access';
import {
  HOST_FEATURES,
  accountUserIdFrom,
  authenticatedPresenceKind,
  decidePairedKind,
  hostedAgentSender,
  kindMayPairByProof,
  pairingProofMatches,
  verifyHostedDelegation,
} from './host/controller-profile';
import type { HostedChatAttribution } from './host/hosted-chat-dispatch';
import type { HostFileReader } from './host/file-reads';
import { RemoteHostSession } from './host/host-session';
import type { MainWindowPushSource } from './host/main-window-pushes';
import type { RemoteUploadStore } from './host/uploads';
import {
  upsertPairedDevice,
  type PairedDevice,
  type RemoteAccessStore,
} from './remote-access-store';
import {
  HelloParamsSchema,
  PairRequestParamsSchema,
  PairRequestResultSchema,
  buildPairingLink,
  REMOTE_METHODS,
  RemoteChannelUnavailableError,
  isUnknownRemoteMethodError,
  type AppAdvisorWindowStateParams,
  type AccountProxySignInCallbackParams,
  type AccountProxySignInOpenParams,
  type DialogOpenResult,
  type HelloResult,
  type PairRequestParams,
  type PairRequestResult,
  type RemoteVersion,
  type RemoteSessionEndReason,
} from './remote-protocol';
import type {
  RelayClientDiagnostic,
  RelayConnectionStatus,
  RemoteRelay,
} from './transport/relay-client';
import { RpcPeer } from './transport/rpc-peer';
import {
  RemoteSessionManager,
  type HandshakeAdmission,
  type SecureSession,
  type SessionGrant,
  type SessionState,
} from './transport/session-manager';

export type { RemoteControlWindows, RemoteRelay };

/** The part of `RemoteAccountProxySignIns` a host connection drives. */
export interface AccountProxySignInListener {
  open(params: AccountProxySignInOpenParams): Promise<void>;
  end(state: string): void;
  closeAll(): void;
}

export interface RemoteRelayFactoryOptions {
  fetchToken: () => Promise<DeviceRelayTokenResponse>;
  deviceInfo: () => DeviceRelayDeviceInfo;
  onStatusChange: (status: RelayConnectionStatus, detail?: string) => void;
  onPeersChange: () => void;
  onDiagnostic: (diagnostic: RelayClientDiagnostic) => void;
}

/**
 * The Portal opt-in as its state store reads it. `reliable: false` means the
 * store could not be read with confidence, so the migration waits.
 */
export type PortalOptInRead =
  | { reliable: true; active: boolean }
  | { reliable: false };

/** The Portal lifecycle the single Remote Control opt-in coordinates. */
export interface RemotePortalPort {
  /** Whether the Portal feature flag is on now. */
  isEnabled(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RemoteControlServiceDeps {
  recordPairing?: PairingTelemetryRecorder;
  /** Host product events (`remote_control:*`); bounded values only. */
  recordTelemetry?: RemoteControlTelemetryRecorder;
  /** Connection diagnostics kept on this computer; bounded values only. */
  recordDiagnostic?: (diagnostic: RemoteControlDiagnostic) => void;
  store: RemoteAccessStore;
  createRelay: (options: RemoteRelayFactoryOptions) => RemoteRelay;
  fetchToken: (deviceId: string) => Promise<DeviceRelayTokenResponse>;
  isFeatureEnabled: () => boolean;
  /**
   * `isFeatureEnabled`, with whether a "no" is transient: the flag has no
   * live value right now. A running relay then stays up for a while (see
   * `transientStopHoldMs`) instead of ending every session. Absent, every
   * "no" stops the relay at once.
   */
  featureState?: () => RemoteControlFeatureState;
  /**
   * Why `isFeatureEnabled` answers as it does, for the diagnostic recorded
   * when it stops the relay.
   */
  describeAvailability?: () => RemoteControlAvailability;
  /**
   * A stable key for the signed-in account, or null when signed out. The
   * relay and every session belong to the account they started under.
   */
  signedInAccount: () => string | null;
  /**
   * Every key the signed-in account is known by, `signedInAccount` among
   * them: its server ID and its credential digest. When the account key
   * changes form but the old key is one of these, it is the same account
   * and the relay keeps running. Absent, only `signedInAccount` counts.
   */
  signedInAccountKeys?: () => ReadonlyArray<string>;
  /**
   * Keeps the computer awake while it hosts a session, so a host does not
   * sleep under a controller. The wake-lock preference still applies.
   */
  wakeLock?: RemoteWakeLock;
  deviceName: () => string;
  platform: DevicePlatform;
  /** Called when whether paired computers may update this one changes. */
  onRemoteUpdatesAllowedChange?: () => void;
  /** This computer's version; sessions need the same protocol on both sides. */
  version: RemoteVersion;
  createBridge: (
    controllerDeviceId: string,
    surface: RemoteSurface,
    exactWorktreeBaseBranch: boolean,
  ) => Promise<HostBridge>;
  /**
   * The App Advisor window a controller shows for this computer, made per
   * session. Absent in tests that do not exercise App Advisor.
   */
  createAppAdvisorSurface?: (
    session: RemoteHostSession,
  ) => RemoteAppAdvisorSurface;
  mainWindowPushes: MainWindowPushSource;
  uploads: RemoteUploadStore;
  /** Serves controllers' reads of files they open in their own apps. */
  readHostFile: HostFileReader;
  /** Copies of the controlled computers' files opened on this one. */
  openedFiles: RemoteUploadStore;
  /** Marks a copy the way the OS marks a download; failing refuses the open. */
  markDownloaded: (path: string) => Promise<void>;
  /** Opens a file on this computer in its default app. */
  openLocalFile: (path: string) => Promise<void>;
  /** Bytes per `file.read`; tests shorten it. */
  fileReadChunkBytes?: number;
  /** Core operations served to paired controllers, whatever their protocol. */
  core?: RemoteCoreAccess;
  /**
   * Serves a hosted agent session's `chat:command` with the attribution this
   * computer derived from the session (CAN-5985). Without it hosted sessions
   * cannot start chats, send messages or answer questions.
   */
  dispatchHostedChatCommand?: (
    request: unknown,
    attribution: HostedChatAttribution,
  ) => Promise<unknown>;
  /** Hands a controller's account proxy sign-in redirect to the proxy here. */
  completeAccountProxySignIn?: (
    controllerDeviceId: string,
    callback: AccountProxySignInCallbackParams,
  ) => Promise<void>;
  /**
   * Account proxy sign-ins a controlled computer opens in this computer's
   * browser, one set per controlled computer.
   */
  createAccountProxySignIns?: (options: {
    forward: (callback: AccountProxySignInCallbackParams) => Promise<void>;
  }) => AccountProxySignInListener;
  windows: RemoteControlWindows;
  broadcastState: (state: RemoteControlState) => void;
  broadcastPairingEvent?: (event: RemoteControlPairingEvent) => void;
  /**
   * Reads the Portal opt-in through the Portal state store's reader, for the
   * one-time `allowIncoming` migration.
   */
  readPortalOptIn: () => Promise<PortalOptInRead>;
  /** Portal sessions the opt-in starts and ends; absent when not wired. */
  portal?: RemotePortalPort;
  /** The web origin pairing links open; throws when it is not configured. */
  webOrigin: () => string;
  /** How long a pairing link stays valid; tests shorten it. */
  pairingWindowMs?: number;
  /** Delay before retrying an opt-in migration that could not read Portal. */
  migrationRetryMs?: number;
  log?: (message: string, context?: unknown) => void;
  now?: () => number;
  /** How long a discovery request keeps the relay up; tests shorten it. */
  discoveryWindowMs?: number;
  /**
   * How long a transient flag change may keep a running relay up before it
   * stops; tests shorten it.
   */
  transientStopHoldMs?: number;
}

/** The wake-lock holders a host takes; the desktop's wake-lock service. */
export interface RemoteWakeLock {
  acquire(key: string, reason: string): void;
  release(key: string): void;
}

const DISCOVERY_WINDOW_MS = 5 * 60_000;
const PAIRING_DECISION_TIMEOUT_MS = 3 * 60_000;
const PAIRING_WINDOW_MS = 10 * 60_000;
const PAIRING_SECRET_BYTES = 32;
const MIGRATION_RETRY_MS = 60_000;
/**
 * The longest a transient flag change (the flag service initializing, or
 * in an outage without live values) keeps a running relay up. Meanwhile no
 * new session is admitted; when it ends with the flag still off, the relay
 * stops as it would have at once.
 */
const TRANSIENT_STOP_HOLD_MS = 60_000;
/** One holder for every hosted session: held while any is live. */
const HOST_WAKE_LOCK_ID = 'host';

/** What `stopRelay` was asked to stop for; the rest it fills in. */
type RelayStop = Pick<
  RemoteRelayStoppedDiagnostic,
  'cause' | 'accountFormChanged' | 'flagStatus' | 'heldMs'
>;

/** `account` or `key`: how `signedInAccount` identified the account. */
function accountKeyForm(account: string): string {
  return account.slice(0, Math.max(0, account.indexOf(':')));
}

/**
 * How long a paired host stays shown online while this computer's session
 * with it is suspended, so a relay rotation or a brief drop on either side
 * passes without the host flickering offline. Presence still follows the
 * relay once the grace ends, or at once when the session closes.
 */
const HOST_PRESENCE_GRACE_MS = 10_000;

interface PairingWindow {
  /** Single-use link secret; held only in this process's memory. */
  secret: Buffer;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** What a pairing that may still be saved was admitted under. */
interface PairingAdmission {
  incomingEpoch: number;
  removalMark: number;
}

function pairingFailureFor(
  outcome: RemoteControlPairingRequestOutcome,
): RemoteControlPairingFailureReason {
  switch (outcome) {
    case 'declined':
      return 'denied';
    case 'timed-out':
      return 'expired';
    case 'approved':
    case 'cancelled':
    case 'failed':
      return 'cancelled';
  }
}

type ProofOutcome =
  | { approved: true }
  | { approved: false; reason: RemoteControlPairingFailureReason };

interface IncomingPairingEntry {
  view: RemoteIncomingPairing;
  publicKey: string;
  decide: (approve: boolean) => void;
  cancel: () => void;
}

interface OutgoingPairingEntry {
  telemetry?: PairingTelemetryAttempt;
  view: RemoteOutgoingPairing;
  rpc: RpcPeer | null;
  cancelled: boolean;
  /**
   * Set once the other computer approves. Approval is the decision to pair,
   * so from then on the pairing finishes even if cancelled; forgetting the
   * computer is the way to undo it.
   */
  committed: boolean;
}

export class RemoteControlService {
  private relay: RemoteRelay | null = null;
  private sessions: RemoteSessionManager | null = null;
  private relayAccount: string | null = null;
  /** Every key `relayAccount`'s account was known by when last checked. */
  private relayAccountKeys: ReadonlySet<string> = new Set();
  /**
   * A transient flag change is holding the running relay up until `until`;
   * no new session is admitted meanwhile.
   */
  private transientHold: {
    since: number;
    until: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private hostWakeLockHeld = false;
  /** When the current relay connection was started. */
  private relayStartedAt = 0;
  private relayStatus: RelayConnectionStatus = 'stopped';
  private relayDetail: string | null = null;
  private discoveryUntil = 0;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Each suspended session with a host, true while its presence grace runs
   * and false once its timer has ended it, until the session is active again.
   */
  private readonly presenceGrace = new WeakMap<SecureSession, boolean>();
  /** Each running grace's timer, which ends it and broadcasts. */
  private readonly presenceGraceTimers = new Map<
    SecureSession,
    ReturnType<typeof setTimeout>
  >();
  private reconcileChain: Promise<void> = Promise.resolve();
  private readonly hostSessions = new Set<RemoteHostSession>();
  private readonly appAdvisorSurfaces = new Map<
    RemoteHostSession,
    RemoteAppAdvisorSurface
  >();
  private readonly connections = new Map<string, RemoteHostConnection>();
  private readonly incoming = new Map<string, IncomingPairingEntry>();
  private outgoing: OutgoingPairingEntry | null = null;
  /**
   * Revocations whose save is still queued. Refused at once, so a device
   * cannot slip back in before the settings cache catches up.
   */
  private readonly revokingControllers = new Set<string>();
  private disallowingIncoming = 0;
  /** Remote-update opt-outs still saving; a cache refresh cannot undo them. */
  private disallowingRemoteUpdates = 0;
  private settingsCache: {
    allowIncoming: boolean;
    allowRemoteUpdates: boolean;
  } = { allowIncoming: false, allowRemoteUpdates: false };
  private lastRemoteUpdatesAllowed = false;
  /** Paired controllers' names, for the update notice and status. */
  private controllerNames = new Map<string, string>();
  private pairingWindow: PairingWindow | null = null;
  /** Serializes proof verification, consumption and pinning. */
  private proofChain: Promise<unknown> = Promise.resolve();
  /** Bumped by every disable; pairings admitted before it cannot save. */
  private incomingEpoch = 0;
  /** Bumped by every explicit opt-in change; the migration yields to it. */
  private allowIncomingGeneration = 0;
  /** Removal marks per controller, so a removal beats a racing pairing. */
  private removalCounter = 0;
  private readonly removalMarks = new Map<string, number>();
  private readonly sessionExpiries = new Map<
    RemoteHostSession,
    { expiresAt: number; timer: ReturnType<typeof setTimeout> }
  >();
  private migrationRun: Promise<void> | null = null;
  /** Why each live session is being ended, for its `session_end` event. */
  private readonly sessionEndReasons = new Map<
    RemoteHostSession,
    RemoteControlSessionEndReason
  >();
  /** The last pairing window was spent by a proof (not expired or closed). */
  private pairingWindowConsumed = false;
  private migrationTimer: ReturnType<typeof setTimeout> | null = null;
  private identityCache: { deviceId: string; publicKey: string } | null = null;
  private broadcastScheduled = false;
  private disposed = false;

  constructor(private readonly deps: RemoteControlServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.refreshCaches();
    await this.migrateOptIn().catch((error: unknown) => {
      this.deps.log?.('Remote Control opt-in migration failed', error);
      this.scheduleMigrationRetry();
    });
    await this.deps.uploads.pruneExpired().catch(() => undefined);
    await this.deps.openedFiles.pruneExpired().catch(() => undefined);
    await this.reconcile();
  }

  /**
   * Re-evaluates whether the relay should run; call on any input change.
   * Runs one at a time, so overlapping calls never start two relays.
   */
  reconcile(): Promise<void> {
    const run = this.reconcileChain.then(() => this.reconcileNow());
    this.reconcileChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcileNow(): Promise<void> {
    if (this.disposed) return;
    const settings = await this.refreshCaches();
    const account = this.deps.signedInAccount();
    if (this.relay && this.relayAccount !== account && account !== null) {
      this.adoptSameAccountKey(account);
    }
    // Another account signed in: nothing set up under the old one survives.
    if (this.relay && this.relayAccount !== account) {
      this.cancelOutgoing();
      this.stopRelay(
        account === null || this.relayAccount === null
          ? { cause: 'signed_out' }
          : {
              cause: 'account_changed',
              accountFormChanged:
                accountKeyForm(this.relayAccount) !== accountKeyForm(account),
            },
      );
    }
    const feature = this.featureState();
    const featureEnabled = feature.enabled;
    const needed =
      account !== null &&
      (settings.allowIncoming ||
        settings.pairedHosts.length > 0 ||
        this.discoveryUntil > this.now() ||
        this.pairingInProgress());
    const wanted = featureEnabled && needed;
    let held = false;
    if (wanted && account !== null && !this.relay) {
      await this.startRelay(account);
    } else if (!wanted && this.relay) {
      // Only a flag value still settling may hold the relay; Labs off,
      // sign-out, a live "no" and nothing needing the relay stop it now.
      held = !featureEnabled && feature.transient && needed && this.holdRelay();
      if (!held) this.stopRelay(this.unwantedStop(featureEnabled));
    } else if (this.relay) {
      this.relay.announce();
    } else if (!wanted) {
      this.relayStatus = 'stopped';
      this.relayDetail = null;
    }
    if (!held) this.endTransientHold();
    this.scheduleBroadcast();
  }

  private featureState(): RemoteControlFeatureState {
    return (
      this.deps.featureState?.() ?? {
        enabled: this.deps.isFeatureEnabled(),
        transient: false,
      }
    );
  }

  /**
   * The account key changed form (a credential digest and a server ID) for
   * the same account: keep the relay, now under the new key. Any other
   * change is another account, and `reconcileNow` stops the relay.
   */
  private adoptSameAccountKey(account: string): void {
    const keys = new Set([
      account,
      ...(this.deps.signedInAccountKeys?.() ?? []),
    ]);
    const relayKeys = this.relayAccountKeys;
    if (!Array.from(keys).some((key) => relayKeys.has(key))) return;
    this.deps.log?.('Remote control account key changed form', {
      from:
        this.relayAccount === null ? null : accountKeyForm(this.relayAccount),
      to: accountKeyForm(account),
    });
    this.relayAccount = account;
    this.relayAccountKeys = keys;
  }

  /**
   * Keeps the running relay up through a transient flag change, for at most
   * `transientStopHoldMs` from the first one. False once that has passed.
   */
  private holdRelay(): boolean {
    const now = this.now();
    if (this.transientHold === null) {
      const holdMs = this.deps.transientStopHoldMs ?? TRANSIENT_STOP_HOLD_MS;
      const holdTimer = setTimeout(() => {
        if (this.transientHold?.timer === holdTimer) {
          this.transientHold = { ...this.transientHold, until: 0 };
        }
        void this.reconcile().catch(() => undefined);
      }, holdMs);
      holdTimer.unref?.();
      this.transientHold = {
        since: now,
        until: now + holdMs,
        timer: holdTimer,
      };
      this.deps.log?.('Remote control relay held for a transient flag change', {
        holdMs,
      });
      return true;
    }
    return now < this.transientHold.until;
  }

  private endTransientHold(): void {
    if (this.transientHold === null) return;
    clearTimeout(this.transientHold.timer);
    this.transientHold = null;
  }

  /** Why a running relay is no longer wanted, for its stop diagnostic. */
  private unwantedStop(featureEnabled: boolean): RelayStop {
    if (featureEnabled) return { cause: 'not_wanted' };
    let availability: RemoteControlAvailability | undefined;
    try {
      availability = this.deps.describeAvailability?.();
    } catch {
      availability = undefined;
    }
    if (availability && !availability.labsEnabled) return { cause: 'labs_off' };
    const heldMs =
      this.transientHold === null
        ? {}
        : { heldMs: Math.max(0, this.now() - this.transientHold.since) };
    return availability
      ? {
          cause: 'feature_flag',
          flagStatus: availability.flagStatus,
          ...heldMs,
        }
      : { cause: 'feature_flag', ...heldMs };
  }

  /** A finished pairing stays on screen but no longer needs the relay. */
  private pairingInProgress(): boolean {
    const status = this.outgoing?.view.status;
    return status === 'connecting' || status === 'awaiting-approval';
  }

  dispose(): void {
    this.disposed = true;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = null;
    if (this.migrationTimer) clearTimeout(this.migrationTimer);
    this.migrationTimer = null;
    this.endPairingWindow('disabled');
    this.stopRelay({ cause: 'dispose' });
  }

  // -------------------------------------------------------------------------
  // One-time opt-in migration
  // -------------------------------------------------------------------------

  /**
   * Folds the Portal opt-in into `allowIncoming` once:
   * `allowIncoming = allowIncoming || Portal active`, saved together with
   * `migratedOptIn` in one atomic write. When Portal state cannot be read
   * reliably the settings stay as they are and the migration retries later.
   */
  migrateOptIn(): Promise<void> {
    this.migrationRun ??= this.runOptInMigration().finally(() => {
      this.migrationRun = null;
    });
    return this.migrationRun;
  }

  private async runOptInMigration(): Promise<void> {
    if (this.disposed) return;
    const settings = await this.deps.store.read();
    if (settings.migratedOptIn === true) return;
    const generation = this.allowIncomingGeneration;
    let portal: PortalOptInRead;
    try {
      portal = await this.deps.readPortalOptIn();
    } catch {
      portal = { reliable: false };
    }
    if (!portal.reliable) {
      this.scheduleMigrationRetry();
      return;
    }
    const portalActive = portal.active;
    await this.deps.store.update((current) => {
      if (current.migratedOptIn === true) return current;
      // An explicit choice made meanwhile wins over the Portal opt-in.
      const explicit = generation !== this.allowIncomingGeneration;
      return {
        ...current,
        allowIncoming: explicit
          ? current.allowIncoming
          : current.allowIncoming || portalActive,
        migratedOptIn: true,
      };
    });
    if (this.migrationTimer) clearTimeout(this.migrationTimer);
    this.migrationTimer = null;
    await this.refreshCaches();
    this.scheduleBroadcast();
    if (!this.disposed) void this.reconcile().catch(() => undefined);
  }

  private scheduleMigrationRetry(): void {
    if (this.disposed || this.migrationTimer) return;
    this.migrationTimer = setTimeout(() => {
      this.migrationTimer = null;
      void this.migrateOptIn().catch(() => this.scheduleMigrationRetry());
    }, this.deps.migrationRetryMs ?? MIGRATION_RETRY_MS);
    this.migrationTimer.unref?.();
  }

  private async refreshCaches(): Promise<
    Awaited<ReturnType<RemoteAccessStore['read']>>
  > {
    const settings = await this.deps.store.read();
    this.setSettingsCache({
      allowIncoming: settings.allowIncoming,
      allowRemoteUpdates: this.remoteUpdatesSetting(settings),
    });
    this.controllerNames = new Map(
      settings.pairedControllers.map((controller) => [
        controller.deviceId,
        controller.name,
      ]),
    );
    return settings;
  }

  /**
   * Loads or creates this device's key. Deferred until remote control is
   * used, so startup never touches the OS keychain for people who don't.
   */
  private async ensureIdentity(): Promise<DeviceKeyPair> {
    const identity = await this.deps.store.identity();
    this.identityCache = {
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
    };
    return identity;
  }

  private async startRelay(account: string): Promise<void> {
    let identity: DeviceKeyPair;
    try {
      identity = await this.ensureIdentity();
    } catch (error) {
      this.relayStatus = 'unavailable';
      this.relayDetail =
        error instanceof Error
          ? error.message
          : 'Remote control is unavailable.';
      this.deps.log?.('Remote control identity is unavailable', error);
      return;
    }
    if (this.disposed) return;
    const relay = this.deps.createRelay({
      fetchToken: () => this.deps.fetchToken(identity.deviceId),
      deviceInfo: () => this.deviceInfo(),
      onStatusChange: (status, detail) => {
        if (status !== this.relayStatus) {
          this.deps.log?.('Remote control relay status changed', {
            status,
            previous: this.relayStatus,
          });
        }
        this.relayStatus = status;
        this.relayDetail = detail ?? null;
        if (status === 'connected') this.retryHostConnections();
        this.scheduleBroadcast();
      },
      onPeersChange: () => {
        this.retryHostConnections();
        this.scheduleBroadcast();
      },
      onDiagnostic: (remoteRelayConnection) => {
        this.diagnostic({
          kind: 'remote_relay_connection',
          remoteRelayConnection,
        });
        this.deps.log?.(
          'Remote control relay connection',
          remoteRelayConnection,
        );
      },
    });
    this.relay = relay;
    this.relayAccount = account;
    this.relayAccountKeys = new Set([
      account,
      ...(this.deps.signedInAccountKeys?.() ?? []),
    ]);
    this.relayStartedAt = this.now();
    this.sessions = new RemoteSessionManager({
      transport: relay,
      identity: (): DeviceKeyPair => identity,
      authorize: (request: HandshakeAdmission): Promise<SessionGrant | null> =>
        this.authorizeHandshake(request),
      onIncomingSession: (session: SecureSession): void =>
        this.handleIncomingSession(session),
      onSessionClosed: (remoteSessionClosed): void => {
        this.diagnostic({ kind: 'remote_session_closed', remoteSessionClosed });
        this.deps.log?.('Remote control session closed', remoteSessionClosed);
      },
    });
    this.sessions.onSessionStateChange((session, state) =>
      this.handleSessionStateChange(session, state),
    );
    relay.start();
  }

  /**
   * The computer woke from sleep: its relay socket may have died silently
   * meanwhile. Reconnecting now takes every session over it through the
   * peers going offline, then online, so resumable sessions resume and the
   * rest end at once, and host windows come back without waiting for a
   * keepalive to time out.
   */
  handleSystemResume(): void {
    this.relay?.reconnectNow();
  }

  /**
   * Starts a host's presence grace when this computer's session with it
   * suspends, and ends it when the session is active again.
   */
  private handleSessionStateChange(
    session: SecureSession,
    state: SessionState,
  ): void {
    if (session.role !== 'initiator' || session.purpose !== 'control') return;
    if (state === 'active') {
      // A later suspension starts a grace of its own.
      clearTimeout(this.presenceGraceTimers.get(session));
      this.presenceGraceTimers.delete(session);
      this.presenceGrace.delete(session);
    } else if (!this.presenceGrace.has(session)) {
      this.presenceGrace.set(session, true);
      // The timer alone ends the grace: a clock read here could still fall
      // just inside it when the timer fires, leaving the host shown online.
      const timer = setTimeout(() => {
        this.presenceGraceTimers.delete(session);
        this.presenceGrace.set(session, false);
        this.scheduleBroadcast();
      }, HOST_PRESENCE_GRACE_MS);
      timer.unref?.();
      this.presenceGraceTimers.set(session, timer);
    }
    this.scheduleBroadcast();
  }

  /** Whether a host that left the relay is still shown online. */
  private inPresenceGrace(hostDeviceId: string): boolean {
    return (this.sessions?.suspendedSessions(hostDeviceId) ?? []).some(
      (session) => this.presenceGrace.get(session) === true,
    );
  }

  /** Reconnects every wanted host connection whose host is online now. */
  private retryHostConnections(): void {
    const online = new Set(
      (this.relay?.peers ?? []).map((peer) => peer.deviceId),
    );
    this.connections.forEach((connection, deviceId) => {
      if (online.has(deviceId)) connection.retryNow();
    });
  }

  private stopRelay(stop: RelayStop): void {
    if (this.relay) {
      const remoteRelayStopped: RemoteRelayStoppedDiagnostic = {
        ...stop,
        relayStatus: this.relayStatus,
        uptimeMs: Math.max(0, this.now() - this.relayStartedAt),
        hostSessions: this.hostSessions.size,
        hostConnections: this.connections.size,
      };
      this.diagnostic({ kind: 'remote_relay_stopped', remoteRelayStopped });
      this.deps.log?.('Remote control relay stopped', remoteRelayStopped);
    }
    // A window left without its connection could never reconnect; close it.
    for (const [deviceId, connection] of Array.from(this.connections)) {
      connection.release();
      this.deps.windows.close(deviceId);
    }
    this.connections.clear();
    this.endTransientHold();
    this.endPairingWindow('disabled');
    for (const session of Array.from(this.hostSessions))
      session.close('shutdown');
    this.setHostWakeLock(false);
    for (const entry of Array.from(this.incoming.values())) entry.cancel();
    // A finished pairing's outcome stays on screen.
    if (this.pairingInProgress()) this.cancelOutgoing();
    this.sessions?.dispose();
    this.sessions = null;
    for (const timer of this.presenceGraceTimers.values()) clearTimeout(timer);
    this.presenceGraceTimers.clear();
    this.relay?.stop();
    this.relay = null;
    this.relayAccount = null;
    this.relayAccountKeys = new Set();
    this.relayStatus = 'stopped';
    this.relayDetail = null;
    this.scheduleBroadcast();
  }

  /**
   * Holds the computer awake while it hosts any session: asleep, it would
   * miss the relay's pings and drop every controller.
   */
  private setHostWakeLock(held: boolean): void {
    const wakeLock = this.deps.wakeLock;
    if (!wakeLock || held === this.hostWakeLockHeld) return;
    this.hostWakeLockHeld = held;
    try {
      if (held) {
        wakeLock.acquire(
          ...wakeLockHolder('remote-session', HOST_WAKE_LOCK_ID),
        );
      } else {
        wakeLock.release(
          wakeLockHolderKey('remote-session', HOST_WAKE_LOCK_ID),
        );
      }
    } catch (error) {
      this.deps.log?.('Remote control wake lock failed', error);
    }
  }

  private deviceInfo(): DeviceRelayDeviceInfo {
    const identity = this.identityOrThrow();
    return {
      deviceId: identity.deviceId,
      name: this.deps.deviceName(),
      platform: this.deps.platform,
      appVersion: this.deps.version.appVersion,
      publicKey: identity.publicKey,
      acceptsRemoteControl: this.settingsCache.allowIncoming,
    };
  }

  private identityOrThrow(): { deviceId: string; publicKey: string } {
    if (!this.identityCache) {
      throw new Error('Remote control identity is not loaded.');
    }
    return this.identityCache;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async getState(
    request: { discover?: boolean } = {},
  ): Promise<RemoteControlState> {
    if (request.discover) {
      const windowMs = this.deps.discoveryWindowMs ?? DISCOVERY_WINDOW_MS;
      this.discoveryUntil = this.now() + windowMs;
      // Let a relay started only for discovery stop when the window ends.
      if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
      this.discoveryTimer = setTimeout(() => {
        this.discoveryTimer = null;
        // Timers may fire a moment before the clock reads the deadline.
        this.discoveryUntil = 0;
        void this.reconcile().catch(() => undefined);
      }, windowMs);
      this.discoveryTimer.unref?.();
      await this.reconcile();
    }
    return this.snapshot();
  }

  private async snapshot(): Promise<RemoteControlState> {
    const settings = await this.refreshCaches();
    const identity = this.identityCache;
    const peers = new Map(
      (this.relay?.peers ?? []).map((peer) => [peer.deviceId, peer]),
    );
    const connectedControllers = new Set(
      Array.from(this.hostSessions).map(
        (session) => session.attributedDeviceId,
      ),
    );
    const pairedHostIds = new Set(
      settings.pairedHosts.map((host) => host.deviceId),
    );
    return {
      available: this.deps.isFeatureEnabled(),
      signedIn: this.deps.signedInAccount() !== null,
      relayStatus: this.relayStatus,
      relayDetail: this.relayDetail,
      // Null until remote control is first used and the key exists.
      thisDevice: identity
        ? {
            deviceId: identity.deviceId,
            name: this.deps.deviceName(),
            platform: this.deps.platform,
          }
        : null,
      allowIncoming: settings.allowIncoming,
      allowRemoteUpdates: this.remoteUpdatesSetting(settings),
      hosts: settings.pairedHosts.map((host) => {
        const connection = this.connections.get(host.deviceId);
        const peer = peers.get(host.deviceId);
        return {
          deviceId: host.deviceId,
          name: peer?.name ?? host.name,
          platform: peer?.platform ?? host.platform,
          pairedAt: host.pairedAt,
          online:
            (peer !== undefined && peer.acceptsRemoteControl) ||
            this.inPresenceGrace(host.deviceId),
          connection: connection?.status ?? 'idle',
          error: connection?.error ?? null,
          ended: connection?.ended ?? false,
        };
      }),
      controllers: settings.pairedControllers.map((controller) => {
        const peer = peers.get(controller.deviceId);
        return {
          deviceId: controller.deviceId,
          name: peer?.name ?? controller.name,
          platform: peer?.platform ?? controller.platform,
          kind: deviceKindOrDefault(controller),
          pairedAt: controller.pairedAt,
          online: peer !== undefined,
          connected: connectedControllers.has(controller.deviceId),
          hostedSessions: this.hostedChildren(controller.deviceId),
        };
      }),
      discoverable: Array.from(peers.values())
        .filter(
          (peer) =>
            peer.acceptsRemoteControl && !pairedHostIds.has(peer.deviceId),
        )
        .map((peer) => ({
          deviceId: peer.deviceId,
          name: peer.name,
          platform: peer.platform,
        })),
      outgoingPairing: this.outgoing ? { ...this.outgoing.view } : null,
      incomingPairings: Array.from(this.incoming.values()).map((entry) => ({
        ...entry.view,
      })),
      pairingWindow: this.pairingWindow
        ? { expiresAt: new Date(this.pairingWindow.expiresAt).toISOString() }
        : null,
    };
  }

  /** Delegated sessions attributed to a hosted root. */
  private hostedChildren(
    rootDeviceId: string,
  ): RemoteControlState['controllers'][number]['hostedSessions'] {
    const children: RemoteControlState['controllers'][number]['hostedSessions'] =
      [];
    for (const [session, expiry] of Array.from(this.sessionExpiries)) {
      if (
        session.attributedDeviceId === rootDeviceId &&
        session.controllerDeviceId !== rootDeviceId
      ) {
        children.push({
          deviceId: session.controllerDeviceId,
          expiresAt: new Date(expiry.expiresAt).toISOString(),
        });
      }
    }
    return children;
  }

  private diagnostic(diagnostic: RemoteControlDiagnostic): void {
    try {
      this.deps.recordDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics never affect Remote Control.
    }
  }

  private telemetry(event: RemoteControlTelemetryEvent): void {
    try {
      this.deps.recordTelemetry?.(event);
    } catch {
      // Telemetry never affects Remote Control.
    }
  }

  /** Ends a session on purpose, remembering why for its `session_end`. */
  private endHostSession(
    session: RemoteHostSession,
    reason: RemoteSessionEndReason,
    telemetryReason: RemoteControlSessionEndReason,
  ): void {
    if (!this.sessionEndReasons.has(session)) {
      this.sessionEndReasons.set(session, telemetryReason);
    }
    session.end(reason);
  }

  private emitPairingEvent(event: RemoteControlPairingEvent): void {
    if (this.disposed) return;
    try {
      this.deps.broadcastPairingEvent?.(event);
    } catch (error) {
      this.deps.log?.('Remote Control pairing event failed to send', error);
    }
  }

  private scheduleBroadcast(): void {
    if (this.broadcastScheduled || this.disposed) return;
    this.broadcastScheduled = true;
    setImmediate(() => {
      this.broadcastScheduled = false;
      void this.snapshot().then(
        (state) => this.deps.broadcastState(state),
        () => undefined,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /**
   * Whether paired computers may install this computer's updates. Off by
   * default on Linux, where an install needs administrator approval.
   */
  private remoteUpdatesSetting(settings: {
    allowRemoteUpdates?: boolean | undefined;
  }): boolean {
    return settings.allowRemoteUpdates ?? this.deps.platform !== 'linux';
  }

  /** Paired computers controlling this one may install its updates now. */
  remoteUpdatesAllowed(): boolean {
    return (
      this.disallowingRemoteUpdates === 0 &&
      this.disallowingIncoming === 0 &&
      this.settingsCache.allowIncoming &&
      this.settingsCache.allowRemoteUpdates
    );
  }

  private setSettingsCache(next: RemoteControlService['settingsCache']): void {
    this.settingsCache = next;
    this.noteRemoteUpdatesAllowed();
  }

  private noteRemoteUpdatesAllowed(): void {
    const allowed = this.remoteUpdatesAllowed();
    if (allowed === this.lastRemoteUpdatesAllowed) return;
    this.lastRemoteUpdatesAllowed = allowed;
    this.deps.onRemoteUpdatesAllowedChange?.();
  }

  /** A paired controller's name, or null for a device this one doesn't know. */
  controllerName(deviceId: string): string | null {
    return this.controllerNames.get(deviceId) ?? null;
  }

  async setAllowRemoteUpdates(allow: boolean): Promise<RemoteControlState> {
    const saving = this.deps.store.update((current) => ({
      ...current,
      allowRemoteUpdates: allow,
    }));
    if (!allow) {
      // Refused at once, without waiting for the save, and a cache refresh
      // that reads the old value meanwhile cannot turn it back on.
      this.disallowingRemoteUpdates += 1;
      this.setSettingsCache({
        ...this.settingsCache,
        allowRemoteUpdates: false,
      });
    }
    try {
      await saving;
      // An opt-in counts only once saved; a failed one leaves it off.
      this.setSettingsCache({
        ...this.settingsCache,
        allowRemoteUpdates: allow,
      });
    } finally {
      if (!allow) {
        this.disallowingRemoteUpdates -= 1;
        this.noteRemoteUpdatesAllowed();
      }
    }
    this.scheduleBroadcast();
    return this.snapshot();
  }

  async setAllowIncoming(allow: boolean): Promise<RemoteControlState> {
    this.allowIncomingGeneration += 1;
    const wasAllowed = this.settingsCache.allowIncoming;
    // An explicit choice also settles the one-time Portal migration.
    const saving = this.deps.store.update((current) => ({
      ...current,
      allowIncoming: allow,
      migratedOptIn: true,
    }));
    if (!allow) {
      // Revocation takes effect at once, without waiting for the save, and
      // holds even if saving fails; the error still reaches the caller.
      this.disallowingIncoming += 1;
      this.incomingEpoch += 1;
      this.setSettingsCache({ ...this.settingsCache, allowIncoming: false });
      this.endPairingWindow('disabled');
      this.endAllControl();
      this.stopPortal();
    }
    try {
      await saving;
    } finally {
      if (!allow) {
        // The cache now refuses on its own; drop anything that got through.
        this.endAllControl();
        this.disallowingIncoming -= 1;
      }
      this.setSettingsCache({ ...this.settingsCache, allowIncoming: allow });
    }
    if (allow && !wasAllowed) this.startPortalIfEnabled();
    await this.reconcile();
    return this.snapshot();
  }

  /** Ends any Portal session; the direct pairings are kept. */
  private stopPortal(): void {
    const portal = this.deps.portal;
    if (!portal) return;
    void portal.stop().catch((error: unknown) => {
      this.deps.log?.('Portal could not stop with Remote Control', error);
    });
  }

  /** Re-enabling starts Portal only while its own flag is on. */
  private startPortalIfEnabled(): void {
    const portal = this.deps.portal;
    if (!portal || !portal.isEnabled()) return;
    void portal.start().catch((error: unknown) => {
      this.deps.log?.('Portal could not start with Remote Control', error);
    });
  }

  async forgetDevice(
    request: RemoteControlForgetDeviceRequest,
  ): Promise<RemoteControlState> {
    if (request.role === 'host') {
      try {
        await this.deps.store.update((current) => ({
          ...current,
          pairedHosts: current.pairedHosts.filter(
            (host) => host.deviceId !== request.deviceId,
          ),
        }));
      } finally {
        // The pairing is already gone from the cache; drop its connection
        // too, even if saving failed.
        this.connections.get(request.deviceId)?.release();
        this.connections.delete(request.deviceId);
        this.deps.windows.close(request.deviceId);
      }
    } else {
      await this.removeController(request.deviceId, { cutOffFirst: true });
    }
    await this.reconcile();
    return this.snapshot();
  }

  /**
   * Removes one controller's pairing and ends every session attributed to
   * it, delegated hosted sessions included. A pairing of that device still
   * in progress can no longer save. `cutOffFirst` ends sessions before the
   * save; otherwise they end once it settles, so a controller revoking its
   * own pairing hears the answer first.
   */
  private async removeController(
    deviceId: string,
    options: { cutOffFirst: boolean },
  ): Promise<void> {
    const removed = this.deps.store
      .peek()
      ?.pairedControllers.find(
        (controller) => controller.deviceId === deviceId,
      );
    if (removed) {
      this.telemetry({
        event: 'device_remove',
        device_kind: deviceKindOrDefault(removed),
      });
    }
    this.removalCounter += 1;
    this.removalMarks.set(deviceId, this.removalCounter);
    const saving = this.deps.store.update((current) => ({
      ...current,
      pairedControllers: current.pairedControllers.filter(
        (controller) => controller.deviceId !== deviceId,
      ),
    }));
    // Refused at once, even before the save lands and if saving fails.
    this.revokingControllers.add(deviceId);
    if (options.cutOffFirst) {
      this.closeControllerSessions(deviceId, 'revoked', 'removed');
    }
    try {
      await saving;
    } finally {
      if (options.cutOffFirst) {
        this.closeControllerSessions(deviceId, 'revoked', 'removed');
      } else {
        // After the reply to the revoking request has been sent.
        setImmediate(() =>
          this.closeControllerSessions(deviceId, 'revoked', 'removed'),
        );
      }
      this.revokingControllers.delete(deviceId);
      this.scheduleBroadcast();
    }
  }

  /**
   * Ends the controller's current session. It stays paired, but does not
   * reconnect on its own: it waits until its user opens this computer again.
   */
  async disconnectController(deviceId: string): Promise<RemoteControlState> {
    this.closeControllerSessions(deviceId, 'disconnected', 'disconnected');
    return this.snapshot();
  }

  private endAllControl(): void {
    for (const session of Array.from(this.hostSessions)) {
      this.endHostSession(session, 'revoked', 'disabled');
    }
    for (const entry of Array.from(this.incoming.values())) entry.cancel();
  }

  /** Sessions of the device itself and those attributed to it. */
  private closeControllerSessions(
    deviceId: string,
    reason: RemoteSessionEndReason,
    telemetryReason: RemoteControlSessionEndReason,
  ): void {
    for (const session of Array.from(this.hostSessions)) {
      if (
        session.controllerDeviceId === deviceId ||
        session.attributedDeviceId === deviceId
      ) {
        this.endHostSession(session, reason, telemetryReason);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pairing window
  // -------------------------------------------------------------------------

  /**
   * Arms a ten-minute, single-use pairing secret, replacing any earlier one,
   * and returns the link that carries it. The secret lives only in this
   * process: disabling Remote Control or restarting the app invalidates it.
   */
  async openPairingWindow(): Promise<RemoteControlOpenPairingWindowResult> {
    if (!this.deps.isFeatureEnabled() || this.deps.signedInAccount() === null) {
      throw new Error(`${REMOTE_CONTROL_LABEL} is not available.`);
    }
    await this.refreshCaches();
    if (!this.incomingAllowed()) {
      throw new Error(
        `Turn on ${REMOTE_CONTROL_LABEL} before pairing a device.`,
      );
    }
    const generation = this.incomingEpoch;
    const identity = await this.ensureIdentity();
    const secret = randomBytes(PAIRING_SECRET_BYTES);
    const link = buildPairingLink(
      this.deps.webOrigin(),
      identity.deviceId,
      encodeBase64Url(secret),
    );
    if (!this.incomingAllowed() || generation !== this.incomingEpoch) {
      secret.fill(0);
      throw new Error(`${REMOTE_CONTROL_LABEL} was turned off.`);
    }
    this.endPairingWindow('replaced');
    this.pairingWindowConsumed = false;
    const windowMs = this.deps.pairingWindowMs ?? PAIRING_WINDOW_MS;
    const expiresAt = this.now() + windowMs;
    const timer = setTimeout(() => this.endPairingWindow('expired'), windowMs);
    timer.unref?.();
    this.pairingWindow = { secret, expiresAt, timer };
    const expiresAtIso = new Date(expiresAt).toISOString();
    this.emitPairingEvent({ type: 'window-opened', expiresAt: expiresAtIso });
    this.scheduleBroadcast();
    await this.reconcile();
    return { link, expiresAt: expiresAtIso };
  }

  async closePairingWindow(): Promise<RemoteControlState> {
    this.endPairingWindow('closed');
    return this.snapshot();
  }

  private endPairingWindow(
    reason: RemoteControlPairingWindowCloseReason,
  ): void {
    const window = this.pairingWindow;
    if (!window) return;
    this.pairingWindow = null;
    this.pairingWindowConsumed = reason === 'consumed';
    clearTimeout(window.timer);
    window.secret.fill(0);
    this.emitPairingEvent({ type: 'window-closed', reason });
    this.scheduleBroadcast();
  }

  // -------------------------------------------------------------------------
  // Host side: this computer being controlled
  // -------------------------------------------------------------------------

  /** Synchronous: uses the settings snapshot refreshed on every change. */
  private incomingAllowed(): boolean {
    return (
      this.disallowingIncoming === 0 &&
      this.deps.store.peek()?.allowIncoming === true
    );
  }

  /** What the relay authenticated this peer as, or null when unknown. */
  private presenceKind(peerDeviceId: string): DeviceKind | null {
    const relay = this.relay;
    if (!relay) return null;
    return authenticatedPresenceKind(
      relay.peers.find((peer) => peer.deviceId === peerDeviceId),
      relay.features,
    );
  }

  /**
   * Authorizes an incoming handshake, before hello2 and again after hello3.
   * The grant names the controller profile the session is held to.
   */
  private async authorizeHandshake(
    request: HandshakeAdmission,
  ): Promise<SessionGrant | null> {
    if (!this.incomingAllowed()) return null;
    // The flag may be turning off: keep live sessions, admit no new ones.
    if (this.transientHold !== null) return null;
    const presence = this.presenceKind(request.peerDeviceId);
    // A relay that authenticates kinds lists every connected peer, so a peer
    // missing from its presence is refused, never read as a legacy desktop.
    if (
      presence === null &&
      this.relay?.features.includes(DEVICE_RELAY_FEATURE_DEVICE_KIND) === true
    )
      return null;
    if (request.purpose === 'pair') {
      if (request.delegation !== null) return null;
      // Pairing ignores versions and pins; the kind is what the relay says,
      // or the legacy desktop profile when it cannot say.
      return {
        kind: presence ?? 'desktop',
        kindAuthenticated: presence !== null,
        rootDeviceId: null,
        expiresAt: null,
      };
    }
    if (request.delegation !== null) {
      return this.authorizeDelegated(request, presence);
    }
    return this.authorizePaired(request, presence);
  }

  private async authorizePaired(
    request: HandshakeAdmission,
    presence: DeviceKind | null,
  ): Promise<SessionGrant | null> {
    const deviceId = request.peerDeviceId;
    const record = this.pairedController(deviceId, request.initiatorKey);
    if (!record || this.revokingControllers.has(deviceId)) return null;
    const decision = decidePairedKind(deviceKindOrDefault(record), presence);
    if (decision.outcome === 'deny') return null;
    if (decision.outcome === 'grant') {
      return {
        kind: decision.kind,
        kindAuthenticated: decision.authenticated,
        rootDeviceId: null,
        expiresAt: null,
      };
    }
    // Narrow desktop to the authenticated restricted kind, durably, before
    // granting anything.
    const narrowed = await this.narrowController(record, decision.kind);
    if (
      !narrowed ||
      !this.incomingAllowed() ||
      this.revokingControllers.has(deviceId)
    ) {
      return null;
    }
    return {
      kind: decision.kind,
      kindAuthenticated: true,
      rootDeviceId: null,
      expiresAt: null,
    };
  }

  private pairedController(
    deviceId: string,
    publicKey: string,
  ): PairedDevice | undefined {
    return this.deps.store
      .peek()
      ?.pairedControllers.find(
        (controller) =>
          controller.deviceId === deviceId &&
          controller.publicKey === publicKey,
      );
  }

  /** Persists a desktop pairing's narrowing; false when it did not save. */
  private async narrowController(
    record: PairedDevice,
    kind: Exclude<DeviceKind, 'desktop'>,
  ): Promise<boolean> {
    let narrowed = false;
    try {
      await this.deps.store.update((current) => {
        narrowed = false;
        const pairedControllers = current.pairedControllers.map(
          (controller) => {
            if (
              controller.deviceId !== record.deviceId ||
              controller.publicKey !== record.publicKey
            ) {
              return controller;
            }
            const pinned = deviceKindOrDefault(controller);
            if (pinned === kind) narrowed = true;
            if (pinned !== 'desktop') return controller;
            narrowed = true;
            return { ...controller, kind };
          },
        );
        return narrowed ? { ...current, pairedControllers } : current;
      });
    } catch (error) {
      this.deps.log?.(
        'Remote Control could not save a narrowed pairing',
        error,
      );
      return false;
    }
    if (narrowed) {
      // Sessions opened under the wider profile lose their authority now.
      for (const session of Array.from(this.hostSessions)) {
        if (
          session.controllerDeviceId === record.deviceId &&
          session.kind !== kind
        ) {
          this.endHostSession(session, 'revoked', 'revoked');
        }
      }
      this.scheduleBroadcast();
    }
    return narrowed;
  }

  private authorizeDelegated(
    request: HandshakeAdmission,
    presence: DeviceKind | null,
  ): SessionGrant | null {
    const delegation = request.delegation;
    if (delegation === null || request.purpose !== 'control') return null;
    // Only a relay-authenticated hosted device may present a delegation.
    if (presence !== 'hosted') return null;
    if (!verifyHostedDelegation(delegation, request.initiatorKey, this.now())) {
      return null;
    }
    const root = this.deps.store
      .peek()
      ?.pairedControllers.find(
        (controller) =>
          controller.publicKey === delegation.rootPublicKey &&
          deviceKindOrDefault(controller) === 'hosted',
      );
    if (!root || this.revokingControllers.has(root.deviceId)) return null;
    return {
      kind: 'hosted',
      kindAuthenticated: true,
      rootDeviceId: root.deviceId,
      expiresAt: delegation.expiresAt,
    };
  }

  /**
   * Whether a live session keeps its authority. Checked on every request and
   * event, so a revocation, a narrowing or a lapsed delegation holds even if
   * the session outlived it. Nothing is cached past the current settings.
   */
  private sessionStillAuthorized(session: SecureSession): boolean {
    const grant = session.grant;
    if (grant === null || !this.incomingAllowed()) return false;
    if (grant.rootDeviceId !== null) {
      const rootDeviceId = grant.rootDeviceId;
      if (grant.expiresAt === null || this.now() >= grant.expiresAt) {
        return false;
      }
      if (this.revokingControllers.has(rootDeviceId)) return false;
      return (
        this.deps.store
          .peek()
          ?.pairedControllers.some(
            (controller) =>
              controller.deviceId === rootDeviceId &&
              deviceKindOrDefault(controller) === 'hosted',
          ) === true
      );
    }
    if (this.revokingControllers.has(session.peerDeviceId)) return false;
    const record = this.pairedController(
      session.peerDeviceId,
      session.handshake.peerPublicKey,
    );
    return record !== undefined && deviceKindOrDefault(record) === grant.kind;
  }

  private handleIncomingSession(session: SecureSession): void {
    // Admitted before the flag started turning off (see `holdRelay`).
    if (this.transientHold !== null) {
      session.close('closed');
      return;
    }
    if (session.purpose === 'pair') {
      this.handleIncomingPairing(session);
      return;
    }
    const grant = session.grant;
    // Authorized at the handshake, but revoked while it finished.
    if (grant === null || !this.sessionStillAuthorized(session)) {
      session.close('closed');
      return;
    }
    const attributedDeviceId = grant.rootDeviceId ?? session.peerDeviceId;
    let appAdvisor: RemoteAppAdvisorSurface | null = null;
    const hostSession = new RemoteHostSession({
      session,
      createBridge: (surface, exactWorktreeBaseBranch): Promise<HostBridge> =>
        this.deps.createBridge(
          session.peerDeviceId,
          surface,
          exactWorktreeBaseBranch,
        ),
      onAppAdvisorWindowState: (state): void => appAdvisor?.applyState(state),
      mainWindowPushes: this.deps.mainWindowPushes,
      uploads: this.deps.uploads,
      readFile: this.deps.readHostFile,
      disposition: getRemoteChannelDisposition,
      kind: grant.kind,
      attributedDeviceId,
      revokeOwnPairing: (): Promise<void> =>
        this.removeController(attributedDeviceId, { cutOffFirst: false }),
      isAuthorized: (): boolean => this.sessionStillAuthorized(session),
      version: this.deps.version,
      hello: (): Pick<HelloResult, 'name' | 'platform'> => ({
        name: this.deps.deviceName(),
        platform: this.deps.platform,
      }),
      onClose: (reason): void => {
        if (this.hostSessions.has(hostSession)) {
          const endReason =
            this.sessionEndReasons.get(hostSession) ?? 'disconnected';
          this.telemetry({
            event: 'session_end',
            device_kind: grant.kind,
            end_reason: endReason,
          });
          this.deps.log?.('Remote control session ended', {
            reason,
            endReason,
            kind: grant.kind,
          });
        }
        this.sessionEndReasons.delete(hostSession);
        this.hostSessions.delete(hostSession);
        this.setHostWakeLock(this.hostSessions.size > 0);
        this.appAdvisorSurfaces.delete(hostSession);
        const expiry = this.sessionExpiries.get(hostSession);
        if (expiry) clearTimeout(expiry.timer);
        this.sessionExpiries.delete(hostSession);
        this.scheduleBroadcast();
      },
      onBridgeError: (error: unknown): void => {
        this.deps.log?.('Remote control bridge failed to start', error);
      },
      ...(this.deps.completeAccountProxySignIn
        ? { completeAccountProxySignIn: this.deps.completeAccountProxySignIn }
        : {}),
      ...(this.deps.core ? { core: this.deps.core } : {}),
      ...(grant.kind === 'hosted'
        ? {
            hostedChat: (request: unknown): Promise<unknown> =>
              this.dispatchHostedChat(
                request,
                attributedDeviceId,
                session.peerDeviceId,
              ),
          }
        : {}),
    });
    if (hostSession.rpc.isClosed) return;
    this.hostSessions.add(hostSession);
    this.setHostWakeLock(true);
    this.telemetry({
      event: 'session_start',
      device_kind: grant.kind,
      is_delegated: grant.rootDeviceId !== null,
    });
    if (grant.expiresAt !== null) {
      // A delegated session closes when its delegation does.
      const timer = setTimeout(
        () => {
          if (!this.sessionEndReasons.has(hostSession)) {
            this.sessionEndReasons.set(hostSession, 'expired');
          }
          hostSession.close('revoked');
        },
        Math.max(0, grant.expiresAt - this.now()),
      );
      timer.unref?.();
      this.sessionExpiries.set(hostSession, {
        expiresAt: grant.expiresAt,
        timer,
      });
    }
    appAdvisor = this.deps.createAppAdvisorSurface?.(hostSession) ?? null;
    if (appAdvisor) this.appAdvisorSurfaces.set(hostSession, appAdvisor);
    this.deps.log?.('Remote control session started', {
      controllerDeviceId: session.peerDeviceId,
      kind: grant.kind,
      delegated: grant.rootDeviceId !== null,
    });
    this.scheduleBroadcast();
  }

  /**
   * A hosted session's chat command, attributed to the pinned hosted root it
   * acts for and this computer's signed-in account, both read now. Refused
   * when either is unknown: an agent's message is never sent unattributed.
   */
  private dispatchHostedChat(
    request: unknown,
    rootDeviceId: string,
    sessionDeviceId: string,
  ): Promise<unknown> {
    const dispatch = this.deps.dispatchHostedChatCommand;
    const root = this.deps.store
      .peek()
      ?.pairedControllers.find(
        (controller) =>
          controller.deviceId === rootDeviceId &&
          deviceKindOrDefault(controller) === 'hosted',
      );
    const sender =
      root === undefined
        ? null
        : hostedAgentSender({
            rootDeviceId,
            rootName: root.name,
            accountUserId: accountUserIdFrom(this.deps.signedInAccount()),
          });
    if (!dispatch || sender === null) {
      return Promise.reject(
        new RemoteChannelUnavailableError(IPC_CHANNELS.chatCommand),
      );
    }
    return dispatch(request, { sender, rootDeviceId, sessionDeviceId });
  }

  /** A connected controller's App Advisor window, for its calls and tools. */
  appAdvisorSurfaceForController(
    deviceId: string,
  ): RemoteAppAdvisorSurface | null {
    const session = this.hostSessionForController(deviceId);
    return session ? (this.appAdvisorSurfaces.get(session) ?? null) : null;
  }

  /** The live session behind a bridge, for its dialog requests. */
  hostSessionForController(deviceId: string): RemoteHostSession | null {
    for (const session of Array.from(this.hostSessions)) {
      if (session.controllerDeviceId === deviceId) return session;
    }
    return null;
  }

  private pairingAdmission(): PairingAdmission {
    return {
      incomingEpoch: this.incomingEpoch,
      removalMark: this.removalCounter,
    };
  }

  /** Whether a pairing admitted under `admission` may still be saved. */
  private pairingStillAdmissible(
    deviceId: string,
    admission: PairingAdmission,
  ): boolean {
    return (
      this.incomingAllowed() &&
      admission.incomingEpoch === this.incomingEpoch &&
      (this.removalMarks.get(deviceId) ?? 0) <= admission.removalMark
    );
  }

  /**
   * Pins the controller, atomically refusing when the connection closed,
   * Remote Control was turned off or the device was removed meanwhile.
   * True only once the pairing is durable.
   */
  private async persistController(
    session: SecureSession,
    rpc: RpcPeer,
    request: PairRequestParams,
    kind: DeviceKind,
    admission: PairingAdmission,
  ): Promise<boolean> {
    let persisted = false;
    await this.deps.store.update((current) => {
      persisted = false;
      if (
        rpc.isClosed ||
        !current.allowIncoming ||
        !this.pairingStillAdmissible(session.peerDeviceId, admission)
      ) {
        return current;
      }
      persisted = true;
      return {
        ...current,
        pairedControllers: upsertPairedDevice(current.pairedControllers, {
          deviceId: session.peerDeviceId,
          name: request.name,
          platform: request.platform,
          kind,
          publicKey: session.handshake.peerPublicKey,
          pairedAt: new Date(this.now()).toISOString(),
        }),
      };
    });
    return persisted && !rpc.isClosed;
  }

  /**
   * Link pairing: verifies `HMAC-SHA256(secret, label || transcriptHash)` in
   * constant time, consumes the secret, and pins the device, one request at
   * a time so a proof is never used twice. Any failure refuses outright; it
   * never falls back to asking on this computer.
   */
  private pairWithProof(
    session: SecureSession,
    rpc: RpcPeer,
    request: PairRequestParams,
    proof: string,
    grant: SessionGrant,
    admission: PairingAdmission,
  ): Promise<ProofOutcome> {
    const run = this.proofChain.then(() =>
      this.consumeProofAndPin(session, rpc, request, proof, grant, admission),
    );
    this.proofChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async consumeProofAndPin(
    session: SecureSession,
    rpc: RpcPeer,
    request: PairRequestParams,
    proof: string,
    grant: SessionGrant,
    admission: PairingAdmission,
  ): Promise<ProofOutcome> {
    // Only a relay-authenticated interactive kind may pair by link.
    if (!grant.kindAuthenticated || !kindMayPairByProof(grant.kind)) {
      return { approved: false, reason: 'denied' };
    }
    if (
      rpc.isClosed ||
      !this.pairingStillAdmissible(session.peerDeviceId, admission)
    ) {
      return { approved: false, reason: 'cancelled' };
    }
    const window = this.pairingWindow;
    if (!window || this.now() >= window.expiresAt) {
      return {
        approved: false,
        reason: this.pairingWindowConsumed ? 'proof_consumed' : 'expired',
      };
    }
    if (
      !pairingProofMatches(
        proof,
        window.secret,
        session.handshake.transcriptHash,
      )
    ) {
      return { approved: false, reason: 'proof_invalid' };
    }
    // Single use: spent before pinning, so a failed save needs a new link.
    this.endPairingWindow('consumed');
    try {
      const persisted = await this.persistController(
        session,
        rpc,
        request,
        grant.kind,
        admission,
      );
      return persisted
        ? { approved: true }
        : { approved: false, reason: 'cancelled' };
    } catch (error) {
      this.deps.log?.('Remote Control could not save a link pairing', error);
      return { approved: false, reason: 'persist_failed' };
    }
  }

  private handleIncomingPairing(session: SecureSession): void {
    const grant = session.grant;
    if (grant === null) {
      session.close('closed');
      return;
    }
    const admission = this.pairingAdmission();
    const pairingId = randomUUID();
    let requested = false;
    const rpc = new RpcPeer(session, {
      onEvent: (): void => undefined,
      onRequest: async (method: string, params: unknown): Promise<unknown> => {
        // Portable controllers check this computer's features before they
        // pair. Identity only: a pairing session serves nothing else.
        if (method === REMOTE_METHODS.hello) {
          HelloParamsSchema.parse(params);
          const hello: HelloResult = {
            name: this.deps.deviceName(),
            platform: this.deps.platform,
            appVersion: this.deps.version.appVersion,
            version: this.deps.version,
            features: { ...HOST_FEATURES },
          };
          return hello;
        }
        if (method !== REMOTE_METHODS.pairRequest) {
          throw new Error(`Unknown remote method ${method}.`);
        }
        if (requested) {
          throw new Error('This connection already asked to pair.');
        }
        requested = true;
        const request = PairRequestParamsSchema.parse(params);
        const answer = (approved: boolean): PairRequestResult => ({
          approved,
          name: this.deps.deviceName(),
          platform: this.deps.platform,
        });
        if (request.proof !== undefined) {
          const outcome = await this.pairWithProof(
            session,
            rpc,
            request,
            request.proof,
            grant,
            admission,
          );
          if (outcome.approved) {
            this.telemetry({
              event: 'device_add',
              device_kind: grant.kind,
              pair_method: 'link',
            });
            this.emitPairingEvent({
              type: 'paired',
              deviceId: session.peerDeviceId,
              name: request.name,
              kind: grant.kind,
              method: 'link',
            });
            this.scheduleBroadcast();
          } else {
            this.telemetry({
              event: 'pairing_fail',
              device_kind: grant.kind,
              pair_method: 'link',
              failure_reason: outcome.reason,
            });
          }
          return answer(outcome.approved);
        }
        const approved = await this.askToPair(
          session,
          rpc,
          request,
          grant,
          admission,
          pairingId,
        );
        return answer(approved);
      },
    });
  }

  /** A pairing without a link: the person here compares codes and decides. */
  private async askToPair(
    session: SecureSession,
    rpc: RpcPeer,
    request: PairRequestParams,
    grant: SessionGrant,
    admission: PairingAdmission,
    pairingId: string,
  ): Promise<boolean> {
    const telemetry = beginPairingTelemetry(this.deps.recordPairing, {
      pairing_kind: 'computer_incoming',
      pairing_entry: 'incoming_prompt',
      peer_platform: request.platform,
    });
    let decisionOutcome: PairingTelemetryOutcome = 'declined';
    let requestOutcome: RemoteControlPairingRequestOutcome = 'declined';
    let stopWatchingClose = (): void => undefined;
    const view: RemoteIncomingPairing = {
      pairingId,
      deviceId: session.peerDeviceId,
      name: request.name,
      platform: request.platform,
      kind: grant.kind,
      code: session.handshake.shortAuthenticationString,
    };
    const approved = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (
        approve: boolean,
        outcome: PairingTelemetryOutcome,
        ended: RemoteControlPairingRequestOutcome,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        decisionOutcome = outcome;
        requestOutcome = ended;
        resolve(approve);
      };
      const timer = setTimeout(() => {
        settle(false, 'timed_out', 'timed-out');
      }, PAIRING_DECISION_TIMEOUT_MS);
      this.incoming.set(pairingId, {
        view,
        publicKey: session.handshake.peerPublicKey,
        cancel: () => {
          settle(false, 'failed', 'cancelled');
        },
        decide: (approve) => {
          settle(approve, 'declined', approve ? 'approved' : 'declined');
        },
      });
      stopWatchingClose = rpc.onClose(() => {
        settle(false, 'failed', 'cancelled');
      });
      this.emitPairingEvent({ type: 'request', pairing: { ...view } });
      this.scheduleBroadcast();
    });
    stopWatchingClose();
    this.incoming.delete(pairingId);
    this.scheduleBroadcast();
    // The other device saves the pairing only once it hears the answer;
    // after the connection closes it never will, so neither does this one.
    const fail = (failure_reason: RemoteControlPairingFailureReason): void =>
      this.telemetry({
        event: 'pairing_fail',
        device_kind: grant.kind,
        pair_method: 'code',
        failure_reason,
      });
    if (approved && !rpc.isClosed) {
      let persisted = false;
      try {
        persisted = await this.persistController(
          session,
          rpc,
          request,
          grant.kind,
          admission,
        );
      } catch (error) {
        telemetry?.end('failed');
        fail('persist_failed');
        this.emitPairingEvent({
          type: 'request-ended',
          pairingId,
          outcome: 'failed',
        });
        throw error;
      }
      telemetry?.end(persisted ? 'approved' : 'failed');
      this.emitPairingEvent({
        type: 'request-ended',
        pairingId,
        outcome: persisted ? 'approved' : 'failed',
      });
      if (persisted) {
        this.telemetry({
          event: 'device_add',
          device_kind: grant.kind,
          pair_method: 'code',
        });
        this.emitPairingEvent({
          type: 'paired',
          deviceId: session.peerDeviceId,
          name: request.name,
          kind: grant.kind,
          method: 'code',
        });
      } else {
        fail('cancelled');
      }
      return persisted;
    }
    telemetry?.end(approved ? 'failed' : decisionOutcome);
    const ended: RemoteControlPairingRequestOutcome = approved
      ? 'failed'
      : requestOutcome;
    fail(pairingFailureFor(ended));
    this.emitPairingEvent({ type: 'request-ended', pairingId, outcome: ended });
    return false;
  }

  async respondToPairing(
    request: RemoteControlRespondToPairingRequest,
  ): Promise<RemoteControlState> {
    this.incoming.get(request.pairingId)?.decide(request.approve);
    return this.snapshot();
  }

  // -------------------------------------------------------------------------
  // Controller side: this computer controlling paired ones
  // -------------------------------------------------------------------------

  async startPairing(deviceId: string): Promise<RemoteControlState> {
    this.cancelOutgoing();
    const peer = this.relay?.peers.find((entry) => entry.deviceId === deviceId);
    const sessions = this.sessions;
    if (!peer || !sessions) {
      throw new Error('That computer is not online.');
    }
    const entry: OutgoingPairingEntry = {
      view: {
        deviceId,
        name: peer.name,
        platform: peer.platform,
        status: 'connecting',
        code: null,
        error: null,
      },
      rpc: null,
      cancelled: false,
      committed: false,
    };
    entry.telemetry = beginPairingTelemetry(this.deps.recordPairing, {
      pairing_kind: 'computer_outgoing',
      pairing_entry: 'pair_computer_dialog',
      peer_platform: peer.platform,
    });
    this.outgoing = entry;
    this.scheduleBroadcast();
    void this.runOutgoingPairing(entry, sessions);
    return this.snapshot();
  }

  private async runOutgoingPairing(
    entry: OutgoingPairingEntry,
    sessions: RemoteSessionManager,
  ): Promise<void> {
    const update = (patch: Partial<RemoteOutgoingPairing>): void => {
      if (this.outgoing !== entry) return;
      entry.view = { ...entry.view, ...patch };
      this.scheduleBroadcast();
    };
    try {
      const session = await sessions.connect({
        peerDeviceId: entry.view.deviceId,
        purpose: 'pair',
        pinnedPeerPublicKey: null,
      });
      if (entry.cancelled) {
        session.close('closed');
        return;
      }
      const rpc = new RpcPeer(session, {
        onEvent: (): void => undefined,
        onRequest: (): Promise<unknown> =>
          Promise.reject(new Error('Not supported.')),
      });
      entry.rpc = rpc;
      update({
        status: 'awaiting-approval',
        code: session.handshake.shortAuthenticationString,
      });
      const result = PairRequestResultSchema.parse(
        await rpc.request(
          REMOTE_METHODS.pairRequest,
          { name: this.deps.deviceName(), platform: this.deps.platform },
          { timeoutMs: PAIRING_DECISION_TIMEOUT_MS + 10_000 },
        ),
      );
      rpc.close('closed');
      if (!result.approved) {
        entry.telemetry?.end('rejected');
        update({ status: 'rejected' });
        return;
      }
      if (entry.cancelled) return;
      entry.committed = true;
      await this.deps.store.update((current) => ({
        ...current,
        pairedHosts: upsertPairedDevice(current.pairedHosts, {
          deviceId: session.peerDeviceId,
          name: result.name,
          platform: result.platform,
          publicKey: session.handshake.peerPublicKey,
          pairedAt: new Date(this.now()).toISOString(),
        }),
      }));
      entry.telemetry?.end('approved');
      update({ status: 'approved', name: result.name });
    } catch (error) {
      if (entry.cancelled) return;
      entry.telemetry?.end('failed');
      update({
        status: 'failed',
        error:
          error instanceof Error ? error.message : 'Pairing did not finish.',
      });
    } finally {
      await this.reconcile();
    }
  }

  private cancelOutgoing(): void {
    const entry = this.outgoing;
    if (!entry) return;
    if (entry.committed) {
      // An approved pairing is already decided: while it saves, it finishes
      // and stays shown; once it has an outcome, this only dismisses it.
      if (entry.view.status !== 'awaiting-approval') this.outgoing = null;
      return;
    }
    entry.telemetry?.end('cancelled');
    entry.cancelled = true;
    entry.rpc?.close('closed');
    this.outgoing = null;
  }

  async cancelPairing(): Promise<RemoteControlState> {
    this.cancelOutgoing();
    await this.reconcile();
    return this.snapshot();
  }

  async openMachine(deviceId: string | null): Promise<void> {
    if (deviceId === null) {
      this.deps.windows.focusLocal();
      return;
    }
    const settings = await this.deps.store.read();
    const host = settings.pairedHosts.find(
      (entry) => entry.deviceId === deviceId,
    );
    if (!host) throw new Error('That computer is not paired.');
    this.connectionFor(host).keepConnected();
    this.deps.windows.open(host);
    this.scheduleBroadcast();
  }

  /** Called when a remote window closes. */
  releaseMachine(deviceId: string): void {
    this.connections.get(deviceId)?.release();
    this.connections.delete(deviceId);
    this.scheduleBroadcast();
  }

  private connectionFor(host: PairedDevice): RemoteHostConnection {
    const existing = this.connections.get(host.deviceId);
    if (existing) return existing;
    const signIns =
      this.deps.createAccountProxySignIns?.({
        forward: (callback): Promise<void> =>
          connection.sendAccountProxySignInCallback(callback),
      }) ?? null;
    const connection: RemoteHostConnection = new RemoteHostConnection({
      version: this.deps.version,
      connect: (): Promise<SecureSession> => {
        const sessions = this.sessions;
        if (!sessions) {
          return Promise.reject(
            classifyError(
              new Error('Remote control is turned off.'),
              'external.state_changed',
            ),
          );
        }
        return sessions.connect({
          peerDeviceId: host.deviceId,
          purpose: 'control',
          pinnedPeerPublicKey: host.publicKey,
        });
      },
      onPush: (channel, args, surface) =>
        this.deps.windows.deliverPush(host.deviceId, channel, args, surface),
      onAppAdvisorWindow: (params) =>
        this.deps.windows.appAdvisorWindow(host.deviceId, params),
      onDialogOpen: (params): Promise<DialogOpenResult> =>
        this.deps.windows.showDialog(
          host.deviceId,
          params,
          (fileName, bytes): Promise<string> =>
            connection.upload(fileName, bytes),
        ),
      onStatusChange: () => this.scheduleBroadcast(),
      onReconnected: () => this.deps.windows.reload(host.deviceId),
      ...(signIns
        ? {
            onAccountProxySignInOpen: (params): Promise<void> =>
              signIns.open(params),
            onAccountProxySignInEnded: (state: string): void =>
              signIns.end(state),
          }
        : {}),
      onSessionEnded: (reason): void => {
        signIns?.closeAll();
        this.deps.log?.('Remote control host connection ended', { reason });
      },
    });
    this.connections.set(host.deviceId, connection);
    return connection;
  }

  private connectionForDevice(deviceId: string): RemoteHostConnection {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      throw classifyError(
        new Error('This window is not connected to another computer.'),
        'external.state_changed',
      );
    }
    return connection;
  }

  /** A computer's App Advisor window here opened, closed, or changed focus. */
  reportAppAdvisorWindowState(
    deviceId: string,
    state: AppAdvisorWindowStateParams,
  ): void {
    this.connections.get(deviceId)?.reportAppAdvisorWindowState(state);
  }

  /** A remote window's tunneled call. */
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    surface: RemoteSurface = 'main',
  ): Promise<unknown> {
    if (channel === IPC_CHANNELS.fileOpenExternal) {
      return this.openFileLocally(deviceId, args);
    }
    if (getRemoteChannelDisposition(channel) !== 'tunnel') {
      return Promise.reject(
        classifyError(
          new RemoteChannelUnavailableError(channel),
          'external.state_changed',
        ),
      );
    }
    return this.connectionForDevice(deviceId).invoke(channel, args, surface);
  }

  /**
   * Opening a file in its default app would happen on the controlled
   * computer's screen, so the file opens in this computer's default app
   * instead, from a copy read through the session and stored here.
   */
  private async openFileLocally(
    deviceId: string,
    args: unknown[],
  ): Promise<void> {
    const target = parseFileOpenTarget(args);
    // One session carries the whole copy: if the window closes or the session
    // drops, the copy fails instead of reconnecting, and nothing opens.
    const session = await this.connectionForDevice(deviceId).pinSession();
    let path: string;
    try {
      path = await copyRemoteFile({
        deviceId,
        target,
        read: (params) => session.readFile(params),
        store: this.deps.openedFiles,
        ...(this.deps.fileReadChunkBytes === undefined
          ? {}
          : { chunkBytes: this.deps.fileReadChunkBytes }),
      });
    } catch (error) {
      if (!isUnknownRemoteMethodError(error, REMOTE_METHODS.fileRead)) {
        throw error;
      }
      path = await this.copyRemotePreviewImage(
        deviceId,
        session,
        target.absolutePath,
      );
    }
    try {
      assertSafeToOpen(basename(path));
      await this.deps.markDownloaded(path);
      if (!session.active) {
        throw new Error(
          `Couldn't open ${basename(path)} because the other computer disconnected.`,
        );
      }
    } catch (error) {
      await this.deps.openedFiles.remove(path);
      throw error;
    }
    await this.deps.openLocalFile(path);
  }

  /**
   * A host released before `file.read` can still send a picture of up to
   * 5 MB through its preview; anything else stays unavailable there.
   */
  private async copyRemotePreviewImage(
    deviceId: string,
    session: PinnedHostSession,
    absolutePath: string,
  ): Promise<string> {
    const preview = await session.invoke(IPC_CHANNELS.fileReadPreview, [
      { absolutePath },
    ]);
    const image = remoteImageForLocalOpen(preview);
    if (!image) {
      throw new RemoteChannelUnavailableError(IPC_CHANNELS.fileOpenExternal);
    }
    return this.deps.openedFiles.put(deviceId, image.fileName, image.bytes);
  }

  post(
    deviceId: string,
    channel: string,
    args: unknown[],
    surface: RemoteSurface = 'main',
  ): void {
    if (getRemoteChannelDisposition(channel) !== 'tunnel') return;
    this.connections.get(deviceId)?.post(channel, args, surface);
  }

  /** Sends a file from this computer; returns its path on the other one. */
  upload(
    deviceId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<string> {
    return this.connectionForDevice(deviceId).upload(fileName, bytes);
  }
}
