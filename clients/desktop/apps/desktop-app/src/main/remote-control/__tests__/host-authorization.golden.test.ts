/**
 * Remote Control host authorization, end to end through RemoteControlService:
 * real handshakes, real encrypted sessions and the real settings store, over
 * an in-memory relay that reports authenticated presence like the device
 * relay does. A break here lets a controller act beyond its profile, pair
 * without consent, or outlive a revocation.
 */
import { isMirrored } from '../host/main-window-pushes';
import { scrubHostPaths } from '../host/browser-host-paths';
import type { RemoteControlTelemetryEvent } from '@canopy/desktop-instrumentation/pairing';
import { sign } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os, { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DeviceKind,
  DeviceRelayDeviceInfo,
} from '@canopy/protocol/device-relay';
import {
  ARGUMENTS_REFUSED_CODE,
  CHANNEL_UNAVAILABLE_CODE,
  DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION,
  DESKTOP_ONE_WINDOW_MODE,
  HOSTED_DELEGATION_MAX_MS,
  HelloResultSchema,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TRANSPORT_RESUME_VERSION,
  RemoteChannelUnavailableError,
  WEB_CONTROLLER_MIN_PROTOCOL_VERSION,
  hostedDelegationSigningBytes,
  parsePairingFragment,
  type HelloParams,
  type HelloResult,
  type HostedDelegation,
} from '@canopy/protocol/remote-control';
import {
  HostUnsupportedError,
  assertHostSupportsController,
  webControllerProfile,
} from '@canopy/remote-session';
import {
  BROWSER_CONTROLLER_CHANNELS,
  BROWSER_PENDING_RECOVERY_FIELD_MAX_LENGTH,
  BROWSER_PENDING_RECOVERY_MAX_ENTRIES,
  HOSTED_ARCHIVE_CHANNELS,
  HOSTED_CHAT_COMMAND_FIELDS,
  HOSTED_CONTROLLER_CHANNELS,
  HOSTED_IPC_CHANNELS,
  HOSTED_SLACK_REQUESTS_OFF_REFUSAL,
  HOSTED_SLACK_REQUESTS_UNAVAILABLE_REFUSAL,
  HOSTED_TASK_CHANNELS,
  MOBILE_CONTROLLER_CHANNELS,
  ONE_WINDOW_CAPABILITIES,
  ONE_WINDOW_CAPABILITY_CHANNELS,
  ONE_WINDOW_CHAT_COMMANDS,
  ONE_WINDOW_CONTROLLER_CHANNELS,
  hostedInvocationAllowed,
  browserInvocationAllowed,
  oneWindowChannelAllowed,
  oneWindowControllerProfile,
  oneWindowHostChannels,
  browserWorkspaceDeleteAllowed,
  browserWorktreeDiscardDescribeAllowed,
} from '@canopy/protocol/remote-control/channels';
import { toPortableCloneJobs } from '@canopy/protocol/clone-jobs';
import { REPOSITORY_CLONE_FAILURE_MESSAGE } from '@canopy/protocol/remote-control/shell';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { ClaudeModsUpdate } from '@canopy/protocol/claude-mods';
import type {
  ClaudeModSurfaceCommandArgs,
  ClaudeModSurfacePushEvent,
} from '@canopy/protocol/extension-ui';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { INSTALLED_ITEM_CHANNELS } from '@canopy/desktop-shared/types/installed-items';
import {
  PLUGIN_NOT_IN_MARKETPLACE_MESSAGE,
  REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE,
  REMOTE_PLUGIN_SOURCE_REFUSAL,
  RemoteBuiltInPluginInstallResultSchema,
  RemotePluginInstallResultSchema,
} from '@canopy/protocol/plugins/remote-install';
import { InstalledItemMutationResultSchema } from '@canopy/protocol/installed-items';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  ChatCommandExecutionOptions,
  ChatCommandRequest,
  ChatCommandResult,
  PairedComputerUpdate,
  PairedComputerWindowEvent,
  PersistedPendingQuestion,
  RemoteControlPairingEvent,
  RemoteControlState,
} from '@canopy/desktop-shared/types';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  serveChatDelegationRead,
  validateChatCommandRequest,
  type ChatDelegationCoreRead,
} from '../../ipc/chat-state';
import {
  stopExactChatTurn,
  type ExactChatTurnStopDeps,
} from '../../ipc/chat-cancel-exact';
import {
  decodeBase64Url,
  encodeBase64Url,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  type DeviceKeyPair,
} from '../crypto/device-key';
import { decodeEnvelope } from '../transport/envelope';
import {
  createOneWindowSessionPolicy,
  followOneWindowSwitch,
} from '../client/one-window-session-policy';
import {
  applyOneWindowChoice,
  isOneWindowEnabled,
  onOneWindowEnabledChanged,
} from '../../lib/one-window-switch';
import {
  PairedComputerWindowApi,
  ownWindowCheck,
} from '../client/paired-computer-window-api';
import { createPairedComputersApi } from '../../../preload/api/paired-computers-api';
import type { PreloadIpcRenderer } from '../../../preload/ipc-router';
import type { HostBridge } from '../host/bridge-window';
import { pairingProofFor } from '../host/controller-profile';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/protocol/chat-targets';
import { mergeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import {
  HOSTED_CHAT_COMMAND_REFUSAL,
  HOSTED_MODEL_PROVIDER_REFUSAL,
  HOSTED_SECRET_ANSWER_REFUSAL,
  HOSTED_WORK_ENTRY_CHAT_ARCHIVE_REFUSAL,
  createHostedChatDispatcher,
  type HostedChatAttribution,
  type HostedQuestionAnswerRequest,
} from '../host/hosted-chat-dispatch';
import { RemoteUploadStore } from '../host/uploads';
import {
  RemoteAccessStore,
  type RemoteControlFile,
} from '../remote-access-store';
import type { LegacyPortalOptInRead } from '../legacy-portal-opt-in';
import {
  RemoteControlService,
  type RemoteControlServiceDeps,
  type RemoteRelayFactoryOptions,
} from '../remote-control-service';
import type { RemoteRelay } from '../transport/relay-client';
import { RpcPeer, RpcPublicError, RpcRemoteError } from '../transport/rpc-peer';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { TunnelStreamMux } from '../tunnel/stream-mux';
import { webPreviewFlagOn } from '../host/web-preview-flag';
import { RemoteWebPreviewStore } from '../remote-web-preview-store';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { TunnelOpenError } from '../tunnel/tunnel-socket';
import { NEXT_PAGE, startDevServers } from './helpers/dev-servers';
import {
  RemoteSessionManager,
  type RelayTransport,
  type SecureSession,
} from '../transport/session-manager';

jest.setTimeout(20_000);

const VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.0.0',
};
const NOT_A_MOBILE_CHANNEL = 'terminal:spawn';
const MOBILE_CHANNEL = 'projects:load';
/** On the mobile list but not the browser list. */
const MOBILE_ONLY_CHANNEL = 'account-proxy:status';
/** The account this computer is signed in to. */
const ACCOUNT_USER_ID = '00000000-0000-4000-8000-0000000000ab';
/** The model Portal's create would start a new chat on here. */
const DEFAULT_MODEL = 'default-model';
/** The Orchestrator's own model, which a Slack thread's tab starts on. */
const ORCHESTRATOR_MODEL = 'orchestrator-model';
/** A Work Entry (Cowork) project in the hosted chat fixture. */
const WORK_ENTRY_PROJECT_ID = 'cowork-project-1';
/** A model whose create seed carries plugin selections (CAN-7445). */
const SEEDED_MODEL = 'seeded-model';
const SEED_PLUGIN_SELECTIONS = {
  collectionIds: ['seed-collection'],
  skillRefs: [],
  pluginRefs: [],
};
/** The provider this computer knows for a model, as `getProviderForModel`. */
function fixtureModelProvider(model: string): string | undefined {
  if (model.startsWith('claude-')) return 'claude';
  if (model.startsWith('gpt-')) return 'codex';
  return undefined;
}

// ---------------------------------------------------------------------------
// In-memory relay
// ---------------------------------------------------------------------------

type FrameListener = (peer: string, payload: Buffer) => void;
type Hold = (from: string, to: string, payload: Buffer) => Promise<void>;

class Hub {
  readonly endpoints = new Map<string, Endpoint>();
  /** Whether the relay authenticates kinds (`device-kind`). */
  authenticatesKind = true;
  hold: Hold | null = null;
  /** Links the relay can't carry right now, both ways (`a>b` and `b>a`). */
  readonly cut = new Set<string>();
  private readonly links = new Map<string, Promise<void>>();

  deliver(from: string, to: string, payload: Buffer): boolean {
    const target = this.endpoints.get(to);
    if (!target?.online) return false;
    if (this.cut.has(`${from}>${to}`)) return false;
    const key = `${from}>${to}`;
    const run = async (): Promise<void> => {
      if (this.hold) await this.hold(from, to, payload);
      target.receive(from, payload);
    };
    this.links.set(key, (this.links.get(key) ?? Promise.resolve()).then(run));
    return true;
  }

  peersOf(id: string): DeviceRelayDeviceInfo[] {
    return Array.from(this.endpoints.values())
      .filter((endpoint) => endpoint.online && endpoint.info.deviceId !== id)
      .map((endpoint) => {
        if (this.authenticatesKind) return endpoint.info;
        // An older relay forwards no kind.
        const legacy: DeviceRelayDeviceInfo = { ...endpoint.info };
        delete legacy.kind;
        return legacy;
      });
  }
}

class Endpoint implements RemoteRelay {
  online = false;
  private readonly frames = new Set<FrameListener>();
  private readonly offline = new Set<(peer: string) => void>();
  private readonly cameOnline = new Set<(peer: string) => void>();
  private readonly undeliverable = new Set<(peer: string) => void>();

  constructor(
    private readonly hub: Hub,
    readonly info: DeviceRelayDeviceInfo,
    private readonly onStatus?: RemoteRelayFactoryOptions['onStatusChange'],
  ) {}

  get connectionStatus(): RemoteRelay['connectionStatus'] {
    return this.online ? 'connected' : 'stopped';
  }

  get peers(): ReadonlyArray<DeviceRelayDeviceInfo> {
    return this.hub.peersOf(this.info.deviceId);
  }

  get features(): ReadonlyArray<string> {
    return this.hub.authenticatesKind ? ['device-kind'] : [];
  }

  start(): void {
    this.online = true;
    this.hub.endpoints.set(this.info.deviceId, this);
    this.onStatus?.('connected');
  }

  stop(): void {
    this.online = false;
    this.hub.endpoints.delete(this.info.deviceId);
  }

  announce(): void {}
  reconnectNow(): void {}

  sendFrame(peer: string, payload: Uint8Array): boolean {
    return this.hub.deliver(this.info.deviceId, peer, Buffer.from(payload));
  }

  receive(from: string, payload: Buffer): void {
    for (const listener of Array.from(this.frames)) listener(from, payload);
  }

  onFrame(listener: FrameListener): () => void {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onPeerOffline(listener: (peer: string) => void): () => void {
    this.offline.add(listener);
    return () => this.offline.delete(listener);
  }

  /** Presence changes only when a test says so (`peerWent`). */
  onPeerOnline(listener: (peer: string) => void): () => void {
    this.cameOnline.add(listener);
    return () => this.cameOnline.delete(listener);
  }

  /** Tells this endpoint's listeners a peer went offline or came back. */
  peerWent(peer: string, presence: 'offline' | 'online'): void {
    const listeners = presence === 'offline' ? this.offline : this.cameOnline;
    for (const listener of Array.from(listeners)) listener(peer);
  }

  onUndeliverable(listener: (peer: string) => void): () => void {
    this.undeliverable.add(listener);
    return () => this.undeliverable.delete(listener);
  }

  /** Listeners registered on this endpoint, of every kind. */
  listenerCount(): number {
    return (
      this.frames.size +
      this.offline.size +
      this.cameOnline.size +
      this.undeliverable.size
    );
  }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

interface FakeBridgeLog {
  invokes: string[];
  /** Arguments of each invoke, in order. */
  invokeArgs: unknown[][];
  posts: string[];
  /** Each bridge created, with its controller and exact base-branch mode. */
  created: Array<{ controllerDeviceId: string; exact: boolean }>;
  /**
   * The session check each bridge was given, which a send or new chat it
   * replays must pass before it commits (CAN-7872), in creation order.
   */
  commitGuards: Array<() => boolean>;
  /** Whether each bridge serves a one-window session (CAN-7854). */
  oneWindowFlags: boolean[];
  emitPush: (channel: string, args: unknown[]) => void;
}

/** What the host served itself for hosted sessions' `chat:command`. */
interface HostedChatLog {
  dispatched: Array<{
    request: ChatCommandRequest;
    attribution: HostedChatAttribution;
    options?: ChatCommandExecutionOptions;
  }>;
  answers: HostedQuestionAnswerRequest[];
  /** Pending agent questions by request ID. */
  questions: Map<string, PersistedPendingQuestion>;
  /** Chats created, with the model each started on. */
  tabs: Map<string, string | undefined>;
  /** The Slack conversations entries created, oldest first (CAN-7604). */
  slackEntries: string[];
  /** The Slack thread tabs readied, in order. */
  slackTabs: string[];
  /** Turn status reads a Slack session made. */
  slackStatusReads: unknown[];
}

/** A settings store whose writes can be failed or held. */
class TestStore extends RemoteAccessStore {
  failWrites = false;
  gate: Promise<void> | null = null;

  override update(
    mutate: (current: RemoteControlFile) => RemoteControlFile,
  ): Promise<RemoteControlFile> {
    if (this.failWrites) return Promise.reject(new Error('Disk is full.'));
    const gate = this.gate;
    if (gate) return gate.then(() => super.update(mutate));
    return super.update(mutate);
  }
}

interface HostOptions {
  /** False: no hosted chat dispatch, as on a host without it. */
  hostedChat?: false;
  /** The signed-in account key; an account with a user ID by default. */
  signedInAccount?: string;
  invokeResult?: unknown;
  /** A reply per channel; takes precedence over `invokeResult`. */
  invokeResultFor?: (channel: string) => unknown;
  /** A rejection per channel, as a bridge passes a handler's error. */
  invokeRejectFor?: (channel: string) => Error | undefined;
  /** Holds each hosted `chat:command` dispatch until it settles. */
  hostedDispatchGate?: Promise<void>;
  settings?: Partial<RemoteControlFile>;
  portalReads?: LegacyPortalOptInRead[];
  pairingWindowMs?: number;
  dir?: string;
  /** This host's version; the current protocol by default. */
  version?: { protocolVersion: number; appVersion: string };
  /** This computer's Slack gate (CAN-7604); off by default. */
  slackGate?: boolean;
  /** The Slack requests feature flag (CAN-7604); on by default. */
  slackFlag?: boolean;
  /** A signed-in account a test can change; overrides `signedInAccount`. */
  account?: { current: string | null };
  /** How long a Connect Slack expectation stays armed (CAN-7606). */
  expectedPairingMs?: number;
  /** The web preview flag (CAN-7705); off by default. */
  webPreviewFlag?: boolean;
  /**
   * This computer's saved web preview consent (CAN-7712) when no file is
   * there yet: on by default, so the flag's goldens see preview served;
   * 'missing' leaves the file absent.
   */
  webPreviewConsent?: boolean | 'missing';
  /** First retry of a failed web preview off (CAN-7712). */
  webPreviewRetryMs?: number;
  /** Replaces the web preview consent file's write (CAN-7712). */
  webPreviewWrite?: (path: string, contents: string) => Promise<void>;
  /** Replaces the web preview consent file's read (CAN-7712). */
  webPreviewRead?: (path: string) => Promise<string>;
  /** Runs before the service first reads its settings. */
  beforeInitialize?: (service: RemoteControlService) => void;
}

interface Host {
  service: RemoteControlService;
  store: TestStore;
  hub: Hub;
  dir: string;
  identity: DeviceKeyPair;
  events: RemoteControlPairingEvent[];
  bridge: FakeBridgeLog;
  hostedChat: HostedChatLog;
  /** Answers the secret request port took (U7), first answer per request. */
  secretAnswers: Array<{ answer: unknown; from: string }>;
  /** Everything the service logged. */
  logs: string[];
  /** The Remote Control telemetry events the service recorded. */
  telemetry: RemoteControlTelemetryEvent[];
  mainPush: (channel: string, args: unknown[]) => void;
  portal: { reads: number };
  readSettings: () => Promise<RemoteControlFile>;
  /** Turns the web preview flag on or off and tells the service. */
  /** Where web preview consent is saved (CAN-7712). */
  webPreviewPath: string;
  webPreviewStore: RemoteWebPreviewStore;
  setWebPreviewFlag: (value: boolean) => void;
  /** The flag service's snapshot status changes, keeping its values. */
  setWebPreviewFlagStatus: (status: FeatureFlagSnapshot['status']) => void;
  /** Every state the service broadcast to this computer's windows. */
  broadcasts: RemoteControlState[];
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createHost(hub: Hub, options: HostOptions = {}): Promise<Host> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'rc-host-')));
  if (!options.dir)
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const settingsPath = join(dir, 'remote-control.json');
  const identityPath = join(dir, 'remote-control-identity.key');
  let identity: DeviceKeyPair;
  try {
    const text = (await readFile(identityPath, 'utf8')).trim();
    const { importDeviceKeyPair } = await import('../crypto/device-key');
    identity = importDeviceKeyPair(
      Buffer.from(text.slice('pkcs8:'.length), 'base64'),
    );
  } catch {
    identity = generateDeviceKeyPair();
    await writeFile(
      identityPath,
      `pkcs8:${exportDeviceKeyPair(identity).toString('base64')}\n`,
    );
  }
  if (options.settings) {
    const file: RemoteControlFile = {
      version: 1,
      allowIncoming: true,
      pairedHosts: [],
      pairedControllers: [],
      ...options.settings,
    };
    await writeFile(settingsPath, JSON.stringify(file));
  }
  const unavailable = (): never => {
    throw new Error('Not used: the identity is stored unencrypted here.');
  };
  const store = new TestStore({
    settingsPath,
    identityPath,
    secretStorage: {
      getStatus: unavailable,
      isWriteAvailable: (): boolean => false,
      nativeEncryptionAvailable: (): boolean => false,
      assertCanRead: unavailable,
      assertCanWrite: unavailable,
      encrypt: unavailable,
      decrypt: unavailable,
    },
  });
  const pushListeners = new Set<(channel: string, args: unknown[]) => void>();
  const mainListeners = new Set<
    (channel: string, args: ReadonlyArray<unknown>) => void
  >();
  const bridge: FakeBridgeLog = {
    invokes: [],
    invokeArgs: [],
    posts: [],
    created: [],
    commitGuards: [],
    oneWindowFlags: [],
    emitPush: (channel, args): void => {
      for (const listener of Array.from(pushListeners)) listener(channel, args);
    },
  };
  const events: RemoteControlPairingEvent[] = [];
  const portal = { reads: 0 };
  const portalReads = [
    ...(options.portalReads ?? [{ reliable: true, active: false }]),
  ];
  const uploads = new RemoteUploadStore(join(dir, 'uploads'));
  const webPreviewPath = join(dir, 'remote-web-preview.json');
  // A restarted host (a reused `dir`) keeps exactly what it saved: nothing is
  // seeded unless the test asks, so a lost file can't be recreated.
  const seed =
    options.webPreviewConsent !== 'missing' &&
    (options.dir === undefined || options.webPreviewConsent !== undefined);
  if (seed) {
    // Only when nothing is there.
    await writeFile(
      webPreviewPath,
      JSON.stringify({
        version: 1,
        allowWebPreview: options.webPreviewConsent ?? true,
      }),
      { flag: 'wx' },
    ).catch(() => undefined);
  }
  const webPreviewStore = new RemoteWebPreviewStore(webPreviewPath, {
    ...(options.webPreviewRetryMs === undefined
      ? {}
      : { retryMs: options.webPreviewRetryMs }),
    ...(options.webPreviewWrite === undefined
      ? {}
      : { writeFile: options.webPreviewWrite }),
    ...(options.webPreviewRead === undefined
      ? {}
      : { readFile: options.webPreviewRead }),
  });
  // The flag service's snapshot, read the way main reads it.
  const webPreviewFlag: Pick<FeatureFlagSnapshot, 'status' | 'values'> = {
    status: 'ready',
    values: {
      ...getDefaultFeatureFlagSnapshot('ready').values,
      [CLIENT_FEATURE_FLAGS.canopyRemoteWebPreview.key]:
        options.webPreviewFlag ?? false,
    },
  };
  const webPreviewFlagListeners = new Set<() => void>();
  const broadcasts: RemoteControlState[] = [];
  // The secret form's settlement, first answer wins as in the real store.
  const secretAnswers: Host['secretAnswers'] = [];
  const settledSecretRequests = new Set<string>();
  const settleSecret = (
    requestId: string,
    answer: unknown,
    from: string,
  ): Promise<{
    accepted: boolean;
    error?: string;
    reason?: 'ended' | 'answered';
  }> => {
    if (settledSecretRequests.has(requestId))
      return Promise.resolve({
        accepted: false,
        error: 'This request was already answered.',
        reason: 'answered',
      });
    settledSecretRequests.add(requestId);
    secretAnswers.push({ answer, from });
    return Promise.resolve({ accepted: true });
  };
  const logs: string[] = [];
  const telemetry: RemoteControlTelemetryEvent[] = [];
  const hostedChat: HostedChatLog = {
    dispatched: [],
    answers: [],
    questions: new Map(),
    tabs: new Map(),
    slackEntries: [],
    slackTabs: [],
    slackStatusReads: [],
  };
  const slackEntry = (): string => {
    if (hostedChat.slackEntries.length === 0)
      hostedChat.slackEntries.push('slack-entry-1');
    return hostedChat.slackEntries[hostedChat.slackEntries.length - 1] ?? '';
  };
  // The real dispatcher and validation over a recorded chat state: a send to
  // a chat that started without a model is refused, as its first turn could
  // not run.
  const hostedDispatchGate = options.hostedDispatchGate;
  const dispatchHostedChatCommand = createHostedChatDispatcher({
    validate: (request) => validateChatCommandRequest(request),
    // A Work Entry project's chats close only with their task (CAN-7446).
    isWorkEntryScope: (projectId) => projectId === WORK_ENTRY_PROJECT_ID,
    dispatch: async (
      request,
      attribution,
      options,
    ): Promise<ChatCommandResult> => {
      hostedChat.dispatched.push({
        request,
        attribution,
        ...(options === undefined ? {} : { options }),
      });
      if (hostedDispatchGate) await hostedDispatchGate;
      const command = request.command;
      if (command.type === 'chat.create_tab') {
        hostedChat.tabs.set(command.tabId, command.model);
      }
      const runnable =
        command.type !== 'chat.send_message' ||
        hostedChat.tabs.get(command.chatId) !== undefined;
      return {
        commandId: request.commandId,
        revision: 1,
        outcome: runnable ? 'applied' : 'rejected',
        ...(command.type === 'chat.send_message'
          ? { entityId: command.chatId, messageId: command.userMessageId }
          : {}),
      };
    },
    createSeed: (_projectId, model) =>
      Promise.resolve(
        model === undefined
          ? { model: DEFAULT_MODEL, defaultStampModel: DEFAULT_MODEL }
          : model === SEEDED_MODEL
            ? { model, pluginSelections: SEED_PLUGIN_SELECTIONS }
            : { model },
      ),
    modelRefusal: (_target, model) =>
      Promise.resolve(
        model === 'blocked-model'
          ? 'This model is blocked by your organization policy.'
          : null,
      ),
    modelProvider: fixtureModelProvider,
    pendingQuestion: (_scope, chatId, questionId) => {
      const question = hostedChat.questions.get(questionId);
      return Promise.resolve(
        question?.chatId === chatId ? question : undefined,
      );
    },
    // The Slack conversations entry and tabs over the recorded chat state;
    // the desktop module that owns them runs in the hosted MCP Electron spec.
    orchestrator: {
      slackRequests: () =>
        Promise.resolve(
          options.slackFlag === false
            ? 'unavailable'
            : options.slackGate === true
              ? 'on'
              : 'off',
        ),
      slackConversationsEntry: () => Promise.resolve(slackEntry()),
      openSlackTab: async ({ chatId }, _attribution, send) => {
        hostedChat.slackTabs.push(chatId);
        hostedChat.tabs.set(chatId, ORCHESTRATOR_MODEL);
        return { status: 'dispatched', result: await send() };
      },
    },
    answerQuestion: (request) => {
      hostedChat.answers.push(request);
      return Promise.resolve({
        status: 'applied',
        result: {
          commandId: request.commandId,
          revision: 2,
          outcome: 'applied',
          entityId: request.chatId,
        },
      });
    },
  });
  const service = new RemoteControlService({
    store,
    createRelay: (relay: RemoteRelayFactoryOptions): RemoteRelay =>
      new Endpoint(hub, relay.deviceInfo(), relay.onStatusChange),
    fetchToken: (): ReturnType<RemoteControlServiceDeps['fetchToken']> =>
      Promise.resolve({
        token: 't',
        relayUrl: 'wss://relay.test',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    signedInAccount: (): string | null =>
      options.account
        ? options.account.current
        : (options.signedInAccount ?? `account:${ACCOUNT_USER_ID}`),
    recordTelemetry: (event: RemoteControlTelemetryEvent): void => {
      telemetry.push(event);
    },
    ...(options.expectedPairingMs === undefined
      ? {}
      : { expectedPairingMs: options.expectedPairingMs }),
    ...(options.hostedChat === false ? {} : { dispatchHostedChatCommand }),
    hostedOrchestratorReads: {
      readsChat: (entryId, chatId): Promise<boolean> =>
        Promise.resolve(
          hostedChat.slackEntries.includes(entryId) &&
            hostedChat.slackTabs.includes(chatId),
        ),
      turnStatus: (request): Promise<unknown> => {
        hostedChat.slackStatusReads.push(request);
        return Promise.resolve({ state: 'running', worktreeId: slackEntry() });
      },
    },
    deviceName: (): string => 'Host',
    platform: 'darwin',
    version: options.version ?? VERSION,
    secretRequests: {
      submit: (request, from): ReturnType<typeof settleSecret> =>
        settleSecret(request.requestId, request, from),
      decline: (requestId, from): ReturnType<typeof settleSecret> =>
        settleSecret(requestId, { decline: requestId }, from),
    },
    log: (message: string, context?: unknown): void => {
      logs.push(`${message} ${JSON.stringify(context ?? null)}`);
    },
    createBridge: (
      controllerDeviceId: string,
      _surface: unknown,
      exact: boolean,
      isAuthorized: () => boolean,
      oneWindow: boolean,
    ): Promise<HostBridge> => {
      bridge.created.push({ controllerDeviceId, exact });
      bridge.commitGuards.push(isAuthorized);
      bridge.oneWindowFlags.push(oneWindow);
      return Promise.resolve({
        getChatInterest: (): undefined => undefined,
        window: null,
        invoke: (channel: string, args: unknown[]): Promise<unknown> => {
          bridge.invokes.push(channel);
          bridge.invokeArgs.push(args);
          const rejection = options.invokeRejectFor?.(channel);
          if (rejection) return Promise.reject(rejection);
          return Promise.resolve(
            options.invokeResultFor
              ? options.invokeResultFor(channel)
              : (options.invokeResult ?? 'ok'),
          );
        },
        post: (channel: string): void => {
          bridge.posts.push(channel);
        },
        onPush: (listener): (() => void) => {
          pushListeners.add(listener);
          return (): void => {
            pushListeners.delete(listener);
          };
        },
        onClosed: (): (() => void) => (): void => undefined,
        destroy: (): void => undefined,
      });
    },
    mainWindowPushes: {
      subscribe: (listener): (() => void) => {
        mainListeners.add(listener);
        return (): void => {
          mainListeners.delete(listener);
        };
      },
    },
    uploads,
    readHostFile: (): Promise<never> => Promise.reject(new Error('Not used.')),
    openedFiles: uploads,
    markDownloaded: (): Promise<void> => Promise.resolve(),
    openLocalFile: (): Promise<void> => Promise.resolve(),
    windows: {
      open: (): void => undefined,
      close: (): void => undefined,
      focusLocal: (): void => undefined,
      deliverPush: (): void => undefined,
      reload: (): void => undefined,
      appAdvisorWindow: (): Promise<{ open: boolean; focused: boolean }> =>
        Promise.resolve({ open: false, focused: false }),
      showDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
        Promise.resolve({ canceled: true, filePaths: [] }),
    },
    broadcastState: (broadcast): void => {
      broadcasts.push(broadcast);
    },
    broadcastPairingEvent: (event): void => {
      events.push(event);
    },
    webPreview: {
      store: webPreviewStore,
      flag: {
        isEnabled: (): boolean => webPreviewFlagOn(webPreviewFlag),
        onChange: (listener): (() => void) => {
          webPreviewFlagListeners.add(listener);
          return (): void => {
            webPreviewFlagListeners.delete(listener);
          };
        },
      },
    },
    readLegacyPortalOptIn: (): Promise<LegacyPortalOptInRead> => {
      portal.reads += 1;
      return Promise.resolve(
        portalReads.length > 1
          ? (portalReads.shift() ?? { reliable: false })
          : (portalReads[0] ?? { reliable: false }),
      );
    },
    webOrigin: (): string => 'https://app.example.test',
    migrationRetryMs: 60,
    ...(options.pairingWindowMs === undefined
      ? {}
      : { pairingWindowMs: options.pairingWindowMs }),
  });
  cleanups.push((): void => service.dispose());
  options.beforeInitialize?.(service);
  await service.initialize();
  return {
    service,
    store,
    hub,
    dir,
    identity,
    events,
    bridge,
    hostedChat,
    secretAnswers,
    logs,
    telemetry,
    mainPush: (channel, args): void => {
      for (const listener of Array.from(mainListeners)) listener(channel, args);
    },
    portal,
    webPreviewPath,
    webPreviewStore,
    readSettings: async (): Promise<RemoteControlFile> =>
      JSON.parse(await readFile(settingsPath, 'utf8')) as RemoteControlFile,
    setWebPreviewFlag: (value): void => {
      webPreviewFlag.values = {
        ...webPreviewFlag.values,
        [CLIENT_FEATURE_FLAGS.canopyRemoteWebPreview.key]: value,
      };
      for (const listener of Array.from(webPreviewFlagListeners)) listener();
    },
    setWebPreviewFlagStatus: (status): void => {
      // A published initializing or error snapshot keeps the earlier
      // values, as the service does.
      webPreviewFlag.status = status;
      for (const listener of Array.from(webPreviewFlagListeners)) listener();
    },
    broadcasts,
  };
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

interface Controller {
  identity: DeviceKeyPair;
  deviceId: string;
  endpoint: Endpoint;
  sessions: RemoteSessionManager;
  pushes: string[];
  pushPayloads: unknown[];
}

function addController(
  hub: Hub,
  kind: DeviceKind | undefined,
  identity: DeviceKeyPair = generateDeviceKeyPair(),
): Controller {
  const endpoint = new Endpoint(hub, {
    deviceId: identity.deviceId,
    name: `Controller ${identity.deviceId.slice(0, 4)}`,
    platform: 'darwin',
    ...(kind ? { kind } : {}),
    appVersion: '1.0.0',
    publicKey: identity.publicKey,
    acceptsRemoteControl: false,
  });
  endpoint.start();
  const transport: RelayTransport = endpoint;
  const sessions = new RemoteSessionManager({
    transport,
    identity: (): DeviceKeyPair => identity,
    authorize: (): null => null,
    onIncomingSession: (session): void => session.close('closed'),
  });
  cleanups.push(() => {
    sessions.dispose();
    endpoint.stop();
  });
  return {
    identity,
    deviceId: identity.deviceId,
    endpoint,
    sessions,
    pushes: [],
    pushPayloads: [],
  };
}

function pinned(
  controller: Controller,
  kind?: DeviceKind,
): RemoteControlFile['pairedControllers'][number] {
  return {
    deviceId: controller.deviceId,
    name: 'Pinned',
    platform: 'darwin',
    ...(kind ? { kind } : {}),
    publicKey: controller.identity.publicKey,
    pairedAt: new Date(0).toISOString(),
  };
}

function rpcFor(controller: Controller, session: SecureSession): RpcPeer {
  return new RpcPeer(session, {
    onRequest: () => Promise.reject(new Error('Not served.')),
    onEvent: (name, payload) => {
      if (
        name === REMOTE_EVENTS.push &&
        typeof payload === 'object' &&
        payload !== null &&
        'channel' in payload &&
        typeof payload.channel === 'string'
      ) {
        controller.pushes.push(payload.channel);
        controller.pushPayloads.push(payload);
      }
    },
  });
}

async function control(
  host: Host,
  controller: Controller,
  delegation?: HostedDelegation,
): Promise<{ session: SecureSession; rpc: RpcPeer }> {
  const session = await controller.sessions.connect({
    peerDeviceId: host.identity.deviceId,
    purpose: 'control',
    pinnedPeerPublicKey: host.identity.publicKey,
    ...(delegation ? { delegation } : {}),
  });
  return { session, rpc: rpcFor(controller, session) };
}

async function hello(
  rpc: RpcPeer,
  params: HelloParams = { version: VERSION },
): Promise<Record<string, unknown>> {
  const result: unknown = await rpc.request(REMOTE_METHODS.hello, params);
  if (typeof result !== 'object' || result === null) throw new Error('hello');
  return { ...result };
}

async function invokeCode(rpc: RpcPeer, channel: string): Promise<string> {
  try {
    await rpc.request(REMOTE_METHODS.invoke, { channel, args: [] });
    return 'ok';
  } catch (error) {
    return error instanceof RpcRemoteError
      ? (error.code ?? error.message)
      : 'failed';
  }
}

async function invokeCodeWith(
  rpc: RpcPeer,
  channel: string,
  args: unknown[],
): Promise<string> {
  try {
    await rpc.request(REMOTE_METHODS.invoke, { channel, args });
    return 'ok';
  } catch (error) {
    return error instanceof RpcRemoteError
      ? (error.code ?? error.message)
      : 'failed';
  }
}

async function pairRequest(
  host: Host,
  controller: Controller,
  proof?: (session: SecureSession) => string,
): Promise<{ approved: boolean; session: SecureSession }> {
  const session = await controller.sessions.connect({
    peerDeviceId: host.identity.deviceId,
    purpose: 'pair',
    pinnedPeerPublicKey: null,
  });
  const rpc = rpcFor(controller, session);
  const result: unknown = await rpc.request(
    REMOTE_METHODS.pairRequest,
    {
      name: 'Phone',
      platform: 'darwin',
      ...(proof ? { proof: proof(session) } : {}),
    },
    { timeoutMs: 5_000 },
  );
  return {
    approved:
      typeof result === 'object' &&
      result !== null &&
      'approved' in result &&
      result.approved === true,
    session,
  };
}

function linkSecret(link: string): Buffer {
  const fragment = parsePairingFragment(new URL(link).hash);
  if (!fragment) throw new Error('Bad link.');
  return decodeBase64Url(fragment.secret);
}

function proofFrom(secret: Buffer): (session: SecureSession) => string {
  return (session) =>
    encodeBase64Url(pairingProofFor(secret, session.handshake.transcriptHash));
}

async function state(host: Host): Promise<RemoteControlState> {
  return host.service.getState();
}

function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await settle(10);
  }
  throw new Error('Timed out waiting.');
}

function delegate(
  root: DeviceKeyPair,
  sessionKey: string,
  expiresAt: number,
  firstPartyClient?: 'slack',
): HostedDelegation {
  return {
    rootPublicKey: root.publicKey,
    sessionPublicKey: sessionKey,
    expiresAt,
    ...(firstPartyClient === undefined ? {} : { firstPartyClient }),
    signature: encodeBase64Url(
      sign(
        null,
        hostedDelegationSigningBytes(sessionKey, expiresAt, firstPartyClient),
        root.privateKey,
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Controller profiles
// ---------------------------------------------------------------------------

/** A sign-in push as the controller received it: its channel and text. */
function signInPushOf(value: unknown): { channel: string; data?: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('channel' in value) ||
    typeof value.channel !== 'string'
  )
    throw new Error('Not a push.');
  const args: unknown = 'args' in value ? value.args : undefined;
  const first: unknown = Array.isArray(args) ? args[0] : undefined;
  const data =
    typeof first === 'object' &&
    first !== null &&
    'data' in first &&
    typeof first.data === 'string'
      ? first.data
      : undefined;
  return data === undefined
    ? { channel: value.channel }
    : { channel: value.channel, data };
}

describe('controller profiles', () => {
  it.each(['mobile', 'desktop'] as const)(
    'keeps renewal status readable on %s account-proxy reads and pushes',
    async (kind) => {
      const hub = new Hub();
      const controller = addController(hub, kind);
      const status = {
        accounts: [
          { authIndex: 'a1f3c2d4a1f3c2d4', status: 'sign-in-required' },
        ],
        signIn: {
          provider: 'claude',
          phase: 'failed',
          authIndex: 'a1f3c2d4a1f3c2d4',
        },
      };
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller)] },
        invokeResult: status,
      });
      const { rpc } = await control(host, controller);
      await hello(rpc);
      const expected =
        kind === 'mobile'
          ? {
              ...status,
              accounts: [
                {
                  authIndex: 'a1f3c2d4a1f3c2d4',
                  status: 'error',
                  signInRequired: true,
                },
              ],
            }
          : status;
      expect(
        await rpc.request(REMOTE_METHODS.invoke, {
          channel: 'account-proxy:status',
          args: [],
        }),
      ).toEqual(expected);
      host.mainPush('account-proxy:changed', [status]);
      await until(() => controller.pushPayloads.length > 0);
      expect(controller.pushPayloads).toEqual([
        { channel: 'account-proxy:changed', args: [expected] },
      ]);
      expect(status.accounts[0].status).toBe('sign-in-required');
    },
  );

  it('keeps every tunneled channel for desktop controllers and advertises enforced features', async () => {
    const hub = new Hub();
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(desktop)] },
    });
    const { rpc } = await control(host, desktop);
    const result = await hello(rpc);
    expect(result.features).toEqual({
      controllerProfiles: true,
      pairingProof: true,
      hostedDelegation: true,
      pairRevoke: true,
    });
    expect(await invokeCode(rpc, NOT_A_MOBILE_CHANNEL)).toBe('ok');
    expect(await invokeCode(rpc, 'no-such:channel')).toBe(
      'remote_channel_unavailable',
    );
    // Only a Slack session reads Slack turn status (CAN-7604); a desktop
    // controller is refused before the bridge.
    const bridged = host.bridge.invokes.length;
    expect(
      await invokeCodeWith(rpc, IPC_CHANNELS.appAdvisorSlackTurnStatus, [
        { chatId: 'chat-1', userMessageId: 'message-1' },
      ]),
    ).toBe('remote_channel_unavailable');
    expect(host.bridge.invokes).toHaveLength(bridged);
  });

  it("keeps this computer's inventory sync switch out of every controller's reach (CAN-5986)", async () => {
    // Turning the switch off deletes this computer's synced lists from the
    // web, so only this computer's own user may change it.
    const channel = IPC_CHANNELS.remoteControlSetInventorySyncEnabled;
    expect(getRemoteChannelDisposition(channel)).toBe('local');
    expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(channel);
    expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
    expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
    const hub = new Hub();
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(desktop)] },
    });
    const { rpc } = await control(host, desktop);
    await hello(rpc);
    expect(await invokeCode(rpc, channel)).toBe('remote_channel_unavailable');
    expect(host.bridge.invokes).not.toContain(channel);
  });

  it('narrows a legacy desktop pairing to the authenticated mobile kind, durably, before access', async () => {
    const hub = new Hub();
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(phone)] },
    });
    const { rpc } = await control(host, phone);
    // Narrowed on disk before the session existed.
    expect((await host.readSettings()).pairedControllers[0]?.kind).toBe(
      'mobile',
    );
    await hello(rpc);
    expect(await invokeCode(rpc, NOT_A_MOBILE_CHANNEL)).toBe(
      'remote_channel_unavailable',
    );
    expect(await invokeCode(rpc, MOBILE_CHANNEL)).toBe('ok');
    // A report in the phone's Files list needs both reads, including images
    // relative to the report. The bridge receives the scope unchanged.
    const scope = { projectId: 'project', worktreeId: 'worktree' };
    const rootsArgs = [scope];
    const reportArgs = [
      {
        absolutePath: '/workspace/.playwright/report/report.md',
        workspaceTarget: scope,
      },
    ];
    const imageArgs = [
      {
        absolutePath: '/workspace/.playwright/report/screenshot.png',
        workspaceTarget: scope,
      },
    ];
    for (const [channel, args] of [
      [IPC_CHANNELS.fileTreeRoots, rootsArgs],
      [IPC_CHANNELS.fileReadContent, reportArgs],
      [IPC_CHANNELS.fileReadContent, imageArgs],
    ] satisfies [string, unknown[]][]) {
      expect(await rpc.request(REMOTE_METHODS.invoke, { channel, args })).toBe(
        'ok',
      );
    }
    for (const request of [
      { absolutePath: '/outside/secret.txt' },
      { absolutePath: '/outside/secret.txt', workspaceTarget: null },
      { absolutePath: '/outside/secret.txt', workspaceTarget: {} },
      {
        absolutePath: '/outside/secret.txt',
        workspaceTarget: scope,
        allowedRoot: 'codex-generated-images',
      },
    ]) {
      await expect(
        rpc.request(REMOTE_METHODS.invoke, {
          channel: IPC_CHANNELS.fileReadContent,
          args: [request],
        }),
      ).rejects.toMatchObject({ code: 'remote_channel_unavailable' });
    }
    for (const channel of [
      IPC_CHANNELS.fileSaveContent,
      IPC_CHANNELS.fileTreeMutate,
    ]) {
      expect(await invokeCode(rpc, channel)).toBe('remote_channel_unavailable');
    }
    expect(host.bridge.invokes).toEqual([
      MOBILE_CHANNEL,
      IPC_CHANNELS.fileTreeRoots,
      IPC_CHANNELS.fileReadContent,
      IPC_CHANNELS.fileReadContent,
    ]);
    expect(host.bridge.invokeArgs).toEqual([
      [],
      rootsArgs,
      reportArgs,
      imageArgs,
    ]);
    // Sends and pushes follow the same allowlist.
    rpc.notify(REMOTE_EVENTS.ipcSend, { channel: 'terminal:write', args: [] });
    rpc.notify(REMOTE_EVENTS.ipcSend, { channel: 'chat:cancel', args: [] });
    host.mainPush('terminal:output', [{}]);
    host.mainPush('chat:state-changed', [{}]);
    // Bridge replay: process output never reaches a phone.
    host.bridge.emitPush('activity:bg-process-output', [{}]);
    await until(() => host.bridge.posts.length > 0 && phone.pushes.length > 0);
    await settle(20);
    expect(host.bridge.posts).toEqual(['chat:cancel']);
    expect(phone.pushes).toEqual(['chat:state-changed']);
    expect(
      (await state(host)).controllers.map((controller) => controller.kind),
    ).toEqual(['mobile']);
  });

  it('refuses forged and changed kinds, and fails closed without authenticated presence', async () => {
    const hub = new Hub();
    const phone = addController(hub, 'mobile');
    const browser = addController(hub, 'browser');
    const posing = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(phone),
          pinned(browser, 'mobile'),
          pinned(posing, 'mobile'),
        ],
      },
    });
    // A self-asserted desktop profile on a mobile session is refused.
    const { rpc } = await control(host, phone);
    await expect(
      hello(rpc, {
        version: VERSION,
        controller: { kind: 'desktop', minVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'remote_controller_refused' });
    // Restricted pairings accept only the same kind: neither another
    // restricted kind nor desktop.
    await expect(control(host, browser)).rejects.toThrow();
    await expect(control(host, posing)).rejects.toThrow();
    // An older relay cannot authenticate kinds: restricted pins fail closed.
    hub.authenticatesKind = false;
    await expect(control(host, phone)).rejects.toThrow();
    const pins = (await host.readSettings()).pairedControllers;
    expect(pins.map((pin) => pin.kind)).toEqual(['mobile', 'mobile', 'mobile']);
  });

  it('holds browser controllers to their list and honors a minimum version only for restricted kinds', async () => {
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [pinned(browser, 'browser'), pinned(desktop)],
      },
    });
    const newer = {
      protocolVersion: REMOTE_PROTOCOL_VERSION + 3,
      appVersion: '9',
    };
    const first = await control(host, browser);
    await hello(first.rpc, {
      version: newer,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    // Compatible, so the browser allowlist answers, not the version check.
    expect(await invokeCode(first.rpc, MOBILE_ONLY_CHANNEL)).toBe(
      'remote_channel_unavailable',
    );
    expect(await invokeCode(first.rpc, NOT_A_MOBILE_CHANNEL)).toBe(
      'remote_channel_unavailable',
    );
    const second = await control(host, browser);
    const answer = await hello(second.rpc, {
      version: newer,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION + 1 },
    });
    expect(answer.version).toEqual(VERSION);
    expect(await invokeCode(second.rpc, MOBILE_CHANNEL)).toBe(
      'remote_protocol_mismatch',
    );
    // Desktop negotiation stays exact even when it names a minimum.
    const third = await control(host, desktop);
    await hello(third.rpc, {
      version: newer,
      controller: { kind: 'desktop', minVersion: 1 },
    });
    expect(await invokeCode(third.rpc, MOBILE_CHANNEL)).toBe(
      'remote_protocol_mismatch',
    );
    expect(host.bridge.invokes).toEqual([]);
  });

  it('serves the web controller from a host at its floor and refuses one below it', async () => {
    // The web deploys ahead of desktops: a host on an older protocol, down to
    // the web's floor, must stay controllable from the web.
    const web = webControllerProfile('browser', 'web');
    expect(web.minVersion).toBe(WEB_CONTROLLER_MIN_PROTOCOL_VERSION);
    const helloFrom = async (
      protocolVersion: number,
    ): Promise<{ host: Host; rpc: RpcPeer; answer: HelloResult }> => {
      const hub = new Hub();
      const browser = addController(hub, 'browser');
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(browser, 'browser')] },
        version: { protocolVersion, appVersion: '1.0.0' },
      });
      const { rpc } = await control(host, browser);
      const answer = HelloResultSchema.parse(
        await hello(rpc, {
          version: web.version,
          controller: { kind: web.kind, minVersion: web.minVersion },
        }),
      );
      return { host, rpc, answer };
    };
    const atFloor = await helloFrom(WEB_CONTROLLER_MIN_PROTOCOL_VERSION);
    expect(() =>
      assertHostSupportsController(atFloor.answer, web, { pairingProof: true }),
    ).not.toThrow();
    expect(await invokeCode(atFloor.rpc, MOBILE_CHANNEL)).toBe('ok');
    expect(atFloor.host.bridge.invokes).toEqual([MOBILE_CHANNEL]);
    // Below the floor the host serves nothing and the web names the update.
    const below = await helloFrom(WEB_CONTROLLER_MIN_PROTOCOL_VERSION - 1);
    expect(below.answer.version?.protocolVersion).toBe(
      WEB_CONTROLLER_MIN_PROTOCOL_VERSION - 1,
    );
    expect(() =>
      assertHostSupportsController(below.answer, web, { pairingProof: true }),
    ).toThrow(HostUnsupportedError);
    expect(await invokeCode(below.rpc, MOBILE_CHANNEL)).toBe(
      'remote_protocol_mismatch',
    );
    expect(below.host.bridge.invokes).toEqual([]);
  });
});

describe('one-window desktop controllers (CAN-7758)', () => {
  /** What a host released before one-window mode advertises. */
  const HOST_FEATURES_BEFORE_ONE_WINDOW = {
    controllerProfiles: true,
    pairingProof: true,
    hostedDelegation: true,
    pairRevoke: true,
  };
  /** On the one-window list: the chat state the main window reads. */
  const LIST_CHANNEL = IPC_CHANNELS.chatGetState;
  const oneWindow = oneWindowControllerProfile();

  async function oneWindowSession(options: {
    host?: { protocolVersion: number; appVersion: string };
    controller?: { protocolVersion: number; appVersion: string };
    profile?: NonNullable<HelloParams['controller']>;
  }): Promise<{
    host: Host;
    desktop: Controller;
    rpc: RpcPeer;
    answer: HelloResult;
  }> {
    const hub = new Hub();
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(desktop)] },
      ...(options.host ? { version: options.host } : {}),
    });
    const { rpc } = await control(host, desktop);
    const answer = HelloResultSchema.parse(
      await hello(rpc, {
        version: options.controller ?? VERSION,
        controller: options.profile ?? oneWindow,
      }),
    );
    return { host, desktop, rpc, answer };
  }

  it('keeps the reviewed list within tunneled channels, with the calls the desktop chat backend needs', () => {
    expect(oneWindow).toEqual({
      kind: 'desktop',
      minVersion: DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION,
      mode: DESKTOP_ONE_WINDOW_MODE,
    });
    for (const channel of ONE_WINDOW_CONTROLLER_CHANNELS) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
    }
    // The browser list lacks these; the desktop chat store's native API
    // shows approvals and declares chat scopes and interest with them.
    for (const channel of [
      IPC_CHANNELS.approvalRequest,
      IPC_CHANNELS.chatSetStateScopes,
      IPC_CHANNELS.chatSetInterest,
    ]) {
      expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(oneWindowChannelAllowed(channel)).toBe(true);
    }
    // The queue's actions wait for CAN-7877, and answering an approval until
    // the host ties the answer to a chat's approval; secret
    // input, a terminal and the approval mode setter, which writes this
    // computer's default for every chat, never reach a one-window session.
    for (const channel of [
      IPC_CHANNELS.chatQueueEdit,
      IPC_CHANNELS.chatQueueSetEditLock,
      IPC_CHANNELS.chatQueueCancel,
      IPC_CHANNELS.chatQueueForce,
      // A chat's settings stay off: the setters save without checking the
      // pairing again, and plan mode restarts a terminal-backed chat's
      // terminal, ending its running turn.
      IPC_CHANNELS.planModeToggle,
      IPC_CHANNELS.thinkingLevelToggle,
      IPC_CHANNELS.chatCodexFastModeToggle,
      IPC_CHANNELS.approvalRespond,
      IPC_CHANNELS.approvalDismiss,
      IPC_CHANNELS.chatModelChange,
      IPC_CHANNELS.approvalSecretInput,
      IPC_CHANNELS.approvalModeSet,
      NOT_A_MOBILE_CHANNEL,
      'no-such:channel',
    ]) {
      expect(oneWindowChannelAllowed(channel)).toBe(false);
    }
  });

  it.each([
    [
      'a newer controller',
      VERSION,
      { protocolVersion: REMOTE_PROTOCOL_VERSION + 3, appVersion: '9' },
    ],
    [
      'an older controller at the floor',
      { protocolVersion: REMOTE_PROTOCOL_VERSION + 2, appVersion: '9' },
      {
        protocolVersion: DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION,
        appVersion: '1',
      },
    ],
  ])(
    'serves %s at or above the floor the reviewed list and nothing else',
    async (_label, hostVersion, controllerVersion) => {
      const { host, desktop, rpc, answer } = await oneWindowSession({
        host: hostVersion,
        controller: controllerVersion,
      });
      expect(answer.version).toEqual(hostVersion);
      expect(answer.features).toEqual({
        controllerProfiles: true,
        pairingProof: true,
        hostedDelegation: true,
        pairRevoke: true,
        oneWindow: { capabilities: [...ONE_WINDOW_CAPABILITIES] },
      });
      expect(oneWindowHostChannels(answer, controllerVersion)).toEqual(
        new Set(ONE_WINDOW_CONTROLLER_CHANNELS),
      );
      expect(await invokeCode(rpc, LIST_CHANNEL)).toBe('ok');
      const approval = {
        requestId: 'request-1',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-1',
      };
      // Approval requests are shown, not answered: the host settles a
      // response by its request ID alone, which also names prompts that
      // belong to no chat, and saves the rule target the caller sends.
      for (const [channel, request] of [
        [
          IPC_CHANNELS.approvalRespond,
          { ...approval, decision: { behavior: 'allow', scope: 'once' } },
        ],
        [IPC_CHANNELS.approvalDismiss, approval],
      ] as const) {
        expect(await invokeCodeWith(rpc, channel, [request])).toBe(
          'remote_channel_unavailable',
        );
      }
      // Outside the list: refused before the bridge, as an older host refuses
      // a channel it does not tunnel, so the feature reports itself unavailable.
      for (const channel of [
        NOT_A_MOBILE_CHANNEL,
        MOBILE_CHANNEL,
        IPC_CHANNELS.approvalSecretInput,
        IPC_CHANNELS.approvalModeSet,
        'no-such:channel',
      ]) {
        expect(await invokeCode(rpc, channel)).toBe(
          'remote_channel_unavailable',
        );
      }
      // The main surface only: a one-window session has no App Advisor window.
      await expect(
        rpc.request(REMOTE_METHODS.invoke, {
          channel: LIST_CHANNEL,
          args: [],
          surface: 'app-advisor',
        }),
      ).rejects.toMatchObject({ code: 'remote_channel_unavailable' });
      // The model catalog is read without options: probe and recheck start
      // provider discovery on this computer.
      for (const request of [{ probe: true }, { probe: true, recheck: true }]) {
        expect(
          await invokeCodeWith(rpc, IPC_CHANNELS.modelRegistryGet, [request]),
        ).toBe('remote_channel_unavailable');
      }
      expect(
        await invokeCodeWith(rpc, IPC_CHANNELS.modelRegistryGet, [{}]),
      ).toBe('ok');
      expect(host.bridge.invokes).toEqual([
        LIST_CHANNEL,
        IPC_CHANNELS.modelRegistryGet,
      ]);
      expect(
        host.bridge.created.map((bridge) => bridge.controllerDeviceId),
      ).toEqual([desktop.deviceId]);
      // Its bridge is marked one-window, so its exact Stop ends only the
      // running turn on this computer (CAN-7854).
      expect(host.bridge.oneWindowFlags).toEqual([true]);
      // Sends and pushes follow the same list.
      rpc.notify(REMOTE_EVENTS.ipcSend, {
        channel: 'terminal:write',
        args: [],
      });
      rpc.notify(REMOTE_EVENTS.ipcSend, {
        channel: IPC_CHANNELS.chatCancel,
        args: [],
      });
      rpc.notify(REMOTE_EVENTS.ipcSend, {
        channel: IPC_CHANNELS.chatSetInterest,
        args: [],
        surface: 'app-advisor',
      });
      rpc.notify(REMOTE_EVENTS.ipcSend, {
        channel: IPC_CHANNELS.chatSetInterest,
        args: [],
      });
      host.mainPush('terminal:output', [{}]);
      host.mainPush(IPC_CHANNELS.chatStateChanged, [{}]);
      host.bridge.emitPush('activity:bg-process-output', [{}]);
      host.bridge.emitPush(IPC_CHANNELS.approvalRequest, [{}]);
      await until(
        () => host.bridge.posts.length > 0 && desktop.pushes.length > 1,
      );
      await settle(20);
      expect(host.bridge.posts).toEqual([IPC_CHANNELS.chatSetInterest]);
      expect(desktop.pushes).toEqual([
        IPC_CHANNELS.chatStateChanged,
        IPC_CHANNELS.approvalRequest,
      ]);
      // The session methods that stay with the separate window are refused.
      await expect(
        rpc.request(REMOTE_METHODS.uploadPut, {
          fileName: 'a.txt',
          bytes: new Uint8Array([1]),
        }),
      ).rejects.toMatchObject({ code: 'remote_controller_refused' });
      await expect(
        rpc.request(REMOTE_METHODS.fileRead, {
          absolutePath: '/workspace/a.txt',
          offset: 0,
          length: 1,
        }),
      ).rejects.toMatchObject({ code: 'remote_controller_refused' });
      await expect(
        rpc.request(REMOTE_METHODS.tunnelOpen, {
          streamId: 1,
          host: 'localhost',
          port: 3000,
          class: 'loopback',
        }),
      ).rejects.toMatchObject({ code: 'remote_controller_refused' });
    },
  );

  it('never offers web preview to a one-window session', async () => {
    const hub = new Hub();
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(desktop)] },
      webPreviewFlag: true,
    });
    const { rpc } = await control(host, desktop);
    const answer = HelloResultSchema.parse(
      await hello(rpc, {
        version: VERSION,
        controller: oneWindow,
        webPreview: { version: 1 },
      }),
    );
    expect(answer.features?.webPreview).toBeUndefined();
    expect(answer.features?.oneWindow).toBeDefined();
  });

  it('serves nothing below either floor, refuses unknown and misplaced modes, and keeps a session in its first mode', async () => {
    const belowFloor = {
      protocolVersion: DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION - 1,
      appVersion: '0.9',
    };
    const newer = {
      protocolVersion: REMOTE_PROTOCOL_VERSION + 3,
      appVersion: '9',
    };
    // A controller below this host's floor, a host below the controller's
    // floor, a host below its own floor, and a mode this host does not know:
    // each answers with the host's version and serves no channel.
    for (const refused of [
      { controller: belowFloor },
      {
        controller: newer,
        profile: { ...oneWindow, minVersion: REMOTE_PROTOCOL_VERSION + 1 },
      },
      { host: belowFloor },
      { profile: { ...oneWindow, mode: 'every-window' } },
    ]) {
      const { host, rpc, answer } = await oneWindowSession(refused);
      expect(answer.version).toEqual(refused.host ?? VERSION);
      expect(answer.features?.oneWindow).toBeUndefined();
      // This build's controller sends only the mode it knows.
      if (refused.profile?.mode !== 'every-window')
        expect(
          oneWindowHostChannels(answer, refused.controller ?? VERSION),
        ).toBeNull();
      expect(await invokeCode(rpc, LIST_CHANNEL)).toBe(
        'remote_protocol_mismatch',
      );
      await expect(
        rpc.request(REMOTE_METHODS.uploadPut, {
          fileName: 'a.txt',
          bytes: new Uint8Array([1]),
        }),
      ).rejects.toMatchObject({ code: 'remote_protocol_mismatch' });
      expect(host.bridge.invokes).toEqual([]);
      expect(host.bridge.created).toEqual([]);
    }
    // Only desktop controllers have modes.
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(browser, 'browser')] },
    });
    const { rpc: browserRpc } = await control(host, browser);
    await expect(
      hello(browserRpc, {
        version: VERSION,
        controller: {
          kind: 'browser',
          minVersion: WEB_CONTROLLER_MIN_PROTOCOL_VERSION,
          mode: DESKTOP_ONE_WINDOW_MODE,
        },
      }),
    ).rejects.toMatchObject({ code: 'remote_controller_refused' });
    // A later hello in the full-tunnel mode cannot widen a one-window
    // session, even on this host's exact protocol.
    const session = await oneWindowSession({});
    await expect(
      hello(session.rpc, { version: VERSION }),
    ).rejects.toMatchObject({ code: 'remote_controller_refused' });
    expect(await invokeCode(session.rpc, NOT_A_MOBILE_CHANNEL)).toBe(
      'remote_channel_unavailable',
    );
  });

  it('holds chat:command to the reviewed command types, so a one-window session cannot archive, fork or reset chats', async () => {
    const { host, rpc } = await oneWindowSession({
      controller: {
        protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
        appVersion: '9',
      },
    });
    const commandRequest = (command: Record<string, unknown>): unknown[] => [
      {
        schemaVersion: 1,
        commandId: 'command-1',
        projectId: 'project',
        worktreeId: 'worktree',
        command,
      },
    ];
    for (const command of [
      { type: 'chat.archive_tab', chatId: 'chat-1' },
      { type: 'chat.reset_to_point', chatId: 'chat-1', messageId: 'm-1' },
      { type: 'chat.fork_tab', chatId: 'chat-1' },
      { type: 'chat.close_tab', chatId: 'chat-1' },
      { type: 'chat.not_a_command' },
      { chatId: 'chat-1' },
    ]) {
      expect(
        await invokeCodeWith(
          rpc,
          IPC_CHANNELS.chatCommand,
          commandRequest(command),
        ),
      ).toBe('remote_channel_unavailable');
    }
    expect(await invokeCodeWith(rpc, IPC_CHANNELS.chatCommand, [])).toBe(
      'remote_channel_unavailable',
    );
    const send = commandRequest({
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Hello',
    });
    expect(await invokeCodeWith(rpc, IPC_CHANNELS.chatCommand, send)).toBe(
      'ok',
    );
    // A command is an invoke on this computer, so a send of one, which
    // would get no reply, is refused even when the invoke is served; only
    // the read-only channels may be sent.
    rpc.notify(REMOTE_EVENTS.ipcSend, {
      channel: IPC_CHANNELS.chatCommand,
      args: commandRequest({ type: 'chat.archive_tab', chatId: 'chat-1' }),
    });
    rpc.notify(REMOTE_EVENTS.ipcSend, {
      channel: IPC_CHANNELS.chatCommand,
      args: send,
    });
    rpc.notify(REMOTE_EVENTS.ipcSend, {
      channel: IPC_CHANNELS.chatSetInterest,
      args: [],
    });
    await until(() => host.bridge.posts.length > 0);
    await settle(20);
    expect(host.bridge.posts).toEqual([IPC_CHANNELS.chatSetInterest]);
    expect(host.bridge.invokes).toEqual([IPC_CHANNELS.chatCommand]);
    expect(host.bridge.invokeArgs).toEqual([send]);
    for (const type of ONE_WINDOW_CHAT_COMMANDS) {
      expect(type).not.toMatch(/archive|fork|reset|close|restore/);
    }
    // A send, held to the pairing at commit (CAN-7872); a new chat waits
    // until the host gives it this computer's defaults (CAN-7907), and the
    // queue's commands wait for CAN-7877.
    expect(ONE_WINDOW_CHAT_COMMANDS).toEqual(['chat.send_message']);
    // Allowed commands carry only their reviewed fields: no auto-archive,
    // session, pin or approval keys in a settings patch, no seeded or
    // session-carrying new chat, no approval mode, and no host-set origin.
    for (const command of [
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { autoArchive: true },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { autoArchive: null },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { sdkSessionId: 's-1' },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { pinned: true },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: {
          modelConfig: { thinkingLevel: 'high', approvalMode: 'full-access' },
        },
      },
      {
        type: 'chat.create_tab',
        tabId: 'chat-2',
        seedTab: { sdkSessionId: 's-1' },
      },
      { type: 'chat.create_tab', tabId: 'chat-2', sdkSessionId: 's-1' },
      {
        type: 'chat.create_tab',
        tabId: 'chat-2',
        claudeForkSessionOnNextSend: true,
      },
      { type: 'chat.create_tab', tabId: 'chat-2', approvalMode: 'full-access' },
      {
        type: 'chat.set_approval_mode',
        tabId: 'chat-1',
        approvalMode: 'full-access',
      },
      { type: 'chat.dismiss_question', chatId: 'chat-1', questionId: 'q-1' },
      // Question answers wait until the host refuses a remote answer to a
      // secret or person-only question; chat.set_model takes the provider
      // from its caller (a model change is chat:model-change); read and
      // attention state waits until the host checks the version named.
      {
        type: 'chat.answer_question',
        chatId: 'chat-1',
        questionId: 'q-1',
        answers: {},
      },
      {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'model-1',
        providerType: 'codex',
      },
      { type: 'chat.set_model', tabId: 'chat-1', model: 'model-1' },
      { type: 'chat.mark_read', chatId: 'chat-1' },
      { type: 'chat.mark_unread', chatId: 'chat-1' },
      { type: 'chat.dismiss_attention', chatId: 'chat-1', attentionVersion: 1 },
    ]) {
      expect(
        await invokeCodeWith(
          rpc,
          IPC_CHANNELS.chatCommand,
          commandRequest(command),
        ),
      ).toBe('remote_channel_unavailable');
    }
    const [envelope] = send;
    expect(
      await invokeCodeWith(rpc, IPC_CHANNELS.chatCommand, [
        { ...Object(envelope), origin: { kind: 'automation' } },
      ]),
    ).toBe('remote_channel_unavailable');
    // Values are checked too: plugin selections carry only the reviewed
    // keys, so a controller cannot route MCP credentials, and a field holds
    // only its type.
    const selections = { collectionIds: [], skillRefs: [], pluginRefs: [] };
    const credentialRouting = {
      ...selections,
      mcpHttpAuthPreferences: { 'server-1': 'oauth' },
    };
    for (const command of [
      // No settings patch: turning on Auto would let a later send route the
      // chat to another provider with its transcript, unasked; plan mode
      // and model settings skip the live-session update their dedicated
      // setters make; and a patch replaces plugin selections whole,
      // dropping this computer's MCP auth preferences.
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { modelSelectionMode: 'auto' },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: true },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { modelConfig: { thinkingLevel: 'high' } },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { modelConfig: { speed: 'ultrafast' } },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { pluginSelections: selections },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { modelSelectionMode: 'auto', planMode: true },
      },
      {
        type: 'chat.create_tab',
        tabId: 'chat-2',
        pluginSelections: selections,
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { pluginSelections: credentialRouting },
      },
      {
        type: 'chat.create_tab',
        tabId: 'chat-2',
        pluginSelections: credentialRouting,
      },
      { type: 'chat.patch_tab_settings', tabId: 'chat-1', patch: {} },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { modelSelectionMode: 'manual' },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: 'yes' },
      },
      {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-2',
        text: { nested: ['Hello'] },
      },
      {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-2',
        text: '',
      },
      { type: 'chat.create_tab', tabId: { id: 'chat-2' } },
    ]) {
      expect(
        await invokeCodeWith(
          rpc,
          IPC_CHANNELS.chatCommand,
          commandRequest(command),
        ),
      ).toBe('remote_channel_unavailable');
    }
    // The host checks no revision guard on these commands from this caller,
    // so a request naming one is refused rather than looking guarded.
    for (const extra of [
      { schemaVersion: 2 },
      { expectedRevision: 3 },
      { expectedTabRevision: 3 },
    ]) {
      expect(
        await invokeCodeWith(rpc, IPC_CHANNELS.chatCommand, [
          { ...Object(envelope), ...extra },
        ]),
      ).toBe('remote_channel_unavailable');
    }
    // A new chat waits for CAN-7907: the controller sends no defaults.
    expect(
      await invokeCodeWith(
        rpc,
        IPC_CHANNELS.chatCommand,
        commandRequest({
          type: 'chat.create_tab',
          tabId: 'chat-2',
          model: 'model-1',
          planMode: true,
        }),
      ),
    ).toBe('remote_channel_unavailable');
    expect(host.bridge.invokeArgs).toEqual([send]);
  });

  it('holds every call that changes something to its reviewed fields, one case per call', async () => {
    const { host, rpc } = await oneWindowSession({});
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
    };
    const sendCommand = {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Hello',
    };
    const send = {
      schemaVersion: 1,
      commandId: 'command-1',
      projectId: 'project',
      worktreeId: 'worktree',
      command: sendCommand,
    };
    const entry = { ...scope, entryId: 'entry-1' };
    const stop = { ...scope, expectedUserMessageId: 'message-1' };
    // Each call with the fields it may carry, and with one it may not.
    const cases: Array<
      [string, Record<string, unknown>, Record<string, unknown>[]]
    > = [
      [
        // A send takes the session and settings from the saved chat, so it
        // may not change the model or plan mode, name a session, steer a
        // turn the host does not check, or carry attachments, overlays,
        // approval state or provenance.
        IPC_CHANNELS.chatCommand,
        send,
        [
          { model: 'model-2' },
          { planMode: true },
          { sendWhileRunning: true },
          { steerTurnId: 'turn-1' },
          { attachmentPaths: ['/tmp/a.png'] },
          { attachmentPromptContexts: [] },
          { fileReferences: [] },
          { packageOverlay: { plugins: [] } },
          { approvalMode: 'full-access' },
          { sessionApprovalRules: [] },
          { sdkSessionId: 's-1' },
          { claudeForkSession: true },
          { agentSent: {} },
          { internalRow: {} },
        ].map((extra) => ({ ...send, command: { ...sendCommand, ...extra } })),
      ],
      // Each value is an ID-sized string and every field is required. Stop
      // names the exact turn: a plain Stop would end whatever turn runs when
      // it lands.
      [
        IPC_CHANNELS.chatCancel,
        stop,
        [
          scope,
          { ...stop, force: true },
          { ...stop, chatId: { id: 'chat-1' } },
          { ...stop, expectedUserMessageId: true },
        ],
      ],
    ];
    for (const [channel, allowed, refused] of cases) {
      for (const request of refused) {
        expect(await invokeCodeWith(rpc, channel, [request])).toBe(
          'remote_channel_unavailable',
        );
      }
      // One request object, nothing more.
      expect(await invokeCodeWith(rpc, channel, [allowed, {}])).toBe(
        'remote_channel_unavailable',
      );
      expect(await invokeCodeWith(rpc, channel, [allowed])).toBe('ok');
    }
    // The older send takes the session and settings from its caller; a
    // model change waits until the host derives the chat's harness lock for
    // a remote caller instead of taking it from the request; and editing a
    // queued message waits until attachments join: an edit that omits them
    // clears the entry's.
    expect(
      await invokeCodeWith(rpc, IPC_CHANNELS.chatSendMessage, [
        { ...scope, userMessageId: 'message-1', text: 'Hello' },
      ]),
    ).toBe('remote_channel_unavailable');
    for (const request of [
      { ...scope, model: 'model-1' },
      { ...scope, model: 'model-1', lockedHarness: 'claude' },
    ]) {
      expect(
        await invokeCodeWith(rpc, IPC_CHANNELS.chatModelChange, [request]),
      ).toBe('remote_channel_unavailable');
    }
    for (const channel of [
      IPC_CHANNELS.chatQueueEdit,
      IPC_CHANNELS.chatQueueSetEditLock,
    ]) {
      expect(
        await invokeCodeWith(rpc, channel, [{ ...entry, text: 'Edited' }]),
      ).toBe('remote_channel_unavailable');
    }
    // The queue's actions stay off until CAN-7877 holds them to the pairing:
    // cancelling drains the queue, which can dispatch the next message, and
    // Run now and steer deliver a queued one.
    for (const channel of [
      IPC_CHANNELS.chatQueueCancel,
      IPC_CHANNELS.chatQueueForce,
    ]) {
      expect(await invokeCodeWith(rpc, channel, [entry])).toBe(
        'remote_channel_unavailable',
      );
    }
    for (const command of [
      {
        type: 'chat.steer_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'entry-1',
      },
      {
        type: 'chat.force_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'entry-1',
      },
      {
        type: 'chat.cancel_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'entry-1',
      },
    ]) {
      expect(
        await invokeCodeWith(rpc, IPC_CHANNELS.chatCommand, [
          { ...send, command },
        ]),
      ).toBe('remote_channel_unavailable');
    }
    // Every call that changes something is an invoke here: a send of one,
    // which would get no reply, is refused even with allowed fields.
    rpc.notify(REMOTE_EVENTS.ipcSend, {
      channel: IPC_CHANNELS.chatSendMessage,
      args: [{ ...scope, userMessageId: 'message-1', text: 'Hello' }],
    });
    rpc.notify(REMOTE_EVENTS.ipcSend, {
      channel: IPC_CHANNELS.chatQueueEdit,
      args: [{ ...entry, text: 'Edited' }],
    });
    for (const [channel, allowed] of cases) {
      rpc.notify(REMOTE_EVENTS.ipcSend, { channel, args: [allowed] });
    }
    rpc.notify(REMOTE_EVENTS.ipcSend, {
      channel: IPC_CHANNELS.chatSetInterest,
      args: [],
    });
    await until(() => host.bridge.posts.length > 0);
    await settle(20);
    expect(host.bridge.posts).toEqual([IPC_CHANNELS.chatSetInterest]);
    expect(host.bridge.invokeArgs).toEqual(
      cases.map(([, allowed]) => [allowed]),
    );
  });

  it('refuses an incompatible second hello on an admitted session, which keeps serving its list', async () => {
    const { host, rpc } = await oneWindowSession({});
    for (const params of [
      {
        version: VERSION,
        controller: { ...oneWindow, mode: 'every-window' },
      },
      {
        version: {
          protocolVersion: DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION - 1,
          appVersion: '0.9',
        },
        controller: oneWindow,
      },
    ]) {
      await expect(hello(rpc, params)).rejects.toMatchObject({
        code: 'remote_controller_refused',
      });
    }
    expect(await invokeCode(rpc, LIST_CHANNEL)).toBe('ok');
    expect(await invokeCode(rpc, NOT_A_MOBILE_CHANNEL)).toBe(
      'remote_channel_unavailable',
    );
    expect(host.bridge.invokes).toEqual([LIST_CHANNEL]);
  });

  it('never routes App Advisor windows, file dialogs or interface tools to a one-window session', async () => {
    const { host, desktop } = await oneWindowSession({});
    // Host-initiated window requests find no session for this controller,
    // so they stay on this computer instead of waiting on a window the
    // controlling computer does not have.
    expect(host.service.hostSessionForController(desktop.deviceId)).toBeNull();
    expect(
      host.service.appAdvisorSurfaceForController(desktop.deviceId),
    ).toBeNull();
    // A session still waiting for its hello, as a reconnecting one-window
    // session is, gets none either; the same device's separate window gets
    // them once its hello confirms the mode.
    const full = await control(host, desktop);
    expect(host.service.hostSessionForController(desktop.deviceId)).toBeNull();
    await hello(full.rpc);
    expect(
      host.service.hostSessionForController(desktop.deviceId)?.isOneWindow,
    ).toBe(false);
  });

  it('keeps a session resumable when it refuses a later hello it would not accept', async () => {
    const hub = new Hub();
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(desktop)] },
    });
    const { session, rpc } = await control(host, desktop);
    const answer = HelloResultSchema.parse(
      await hello(rpc, {
        version: VERSION,
        controller: oneWindow,
        transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION },
      }),
    );
    expect(answer.transport?.resume).toBe(REMOTE_TRANSPORT_RESUME_VERSION);
    session.setResumeNegotiated(true);
    // A hello in the other mode, a profile naming another kind, and a hello
    // the host cannot parse are all refused without touching resume.
    for (const params of [
      {
        version: VERSION,
        transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION },
      },
      {
        version: VERSION,
        controller: { kind: 'browser' as const, minVersion: 1 },
        transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION },
      },
    ]) {
      await expect(hello(rpc, params)).rejects.toMatchObject({
        code: 'remote_controller_refused',
      });
    }
    await expect(
      rpc.request(REMOTE_METHODS.hello, { version: 'not a version' }),
    ).rejects.toMatchObject({ code: 'remote_protocol_mismatch' });
    // The relay drops the link, then brings it back: the session resumes.
    const hostId = host.identity.deviceId;
    host.hub.cut.add(`${hostId}>${desktop.deviceId}`);
    host.hub.cut.add(`${desktop.deviceId}>${hostId}`);
    host.hub.endpoints.get(hostId)?.peerWent(desktop.deviceId, 'offline');
    desktop.endpoint.peerWent(hostId, 'offline');
    expect(session.state).toBe('suspended');
    host.hub.cut.delete(`${hostId}>${desktop.deviceId}`);
    host.hub.cut.delete(`${desktop.deviceId}>${hostId}`);
    desktop.endpoint.peerWent(hostId, 'online');
    await until(() => session.state === 'active' || session.isClosed);
    expect(session.state).toBe('active');
    expect(await invokeCode(rpc, LIST_CHANNEL)).toBe('ok');
    expect(await invokeCode(rpc, NOT_A_MOBILE_CHANNEL)).toBe(
      'remote_channel_unavailable',
    );
  });

  it('keeps the separate window per computer on the exact match and the full tunnel', async () => {
    const hub = new Hub();
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(desktop)] },
    });
    // On another protocol, with or without a minimum, nothing is served.
    for (const params of [
      {
        version: {
          protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
          appVersion: '9',
        },
      },
      {
        version: {
          protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
          appVersion: '9',
        },
        controller: { kind: 'desktop' as const, minVersion: 1 },
      },
    ]) {
      const { rpc } = await control(host, desktop);
      const answer = HelloResultSchema.parse(await hello(rpc, params));
      expect(answer.features?.oneWindow).toBeUndefined();
      expect(await invokeCode(rpc, NOT_A_MOBILE_CHANNEL)).toBe(
        'remote_protocol_mismatch',
      );
    }
    // On the same protocol, every tunneled channel, and a full session
    // cannot narrow itself into one-window mode afterwards.
    const { rpc } = await control(host, desktop);
    const answer = HelloResultSchema.parse(await hello(rpc));
    expect(answer.features?.oneWindow).toBeUndefined();
    expect(await invokeCode(rpc, NOT_A_MOBILE_CHANNEL)).toBe('ok');
    await expect(
      hello(rpc, { version: VERSION, controller: oneWindow }),
    ).rejects.toMatchObject({ code: 'remote_controller_refused' });
    expect(await invokeCode(rpc, NOT_A_MOBILE_CHANNEL)).toBe('ok');
    // A host released before one-window mode strips it and answers like
    // this full session: on the exact protocol the controller may use only
    // the read-only capabilities, since that host has no field allowlists
    // or one-window checks for a call that changes something (CAN-7854);
    // and nothing on another protocol.
    const olderHost: HelloResult = {
      ...answer,
      features: HOST_FEATURES_BEFORE_ONE_WINDOW,
    };
    const readOnly = oneWindowHostChannels(olderHost, VERSION);
    expect(readOnly).toEqual(
      new Set(
        ONE_WINDOW_CONTROLLER_CHANNELS.filter(
          (channel) =>
            !(
              ONE_WINDOW_CAPABILITY_CHANNELS.send as readonly string[]
            ).includes(channel),
        ),
      ),
    );
    for (const channel of [
      IPC_CHANNELS.chatCommand,
      IPC_CHANNELS.chatCancel,
      IPC_CHANNELS.planModeToggle,
      IPC_CHANNELS.thinkingLevelToggle,
      IPC_CHANNELS.chatCodexFastModeToggle,
    ])
      expect(readOnly?.has(channel)).toBe(false);
    expect(readOnly?.has(IPC_CHANNELS.chatGetState)).toBe(true);
    expect(
      oneWindowHostChannels(
        {
          ...olderHost,
          version: {
            protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
            appVersion: '9',
          },
        },
        VERSION,
      ),
    ).toBeNull();
  });
});

describe("the main window's per-computer API (CAN-7761)", () => {
  /** On the one-window list: the chat state the main window reads. */
  const LIST_CHANNEL = IPC_CHANNELS.chatGetState;
  /** A valid chat state read, in the paired computer's own ids. */
  const READ = { projectId: 'project-1', worktreeId: 'worktree-1' };
  /** A push on the one-window list. */
  const LIST_PUSH = IPC_CHANNELS.desktopSessionSnapshotStale;
  const WINDOW_CHANNELS = [
    IPC_CHANNELS.remoteControlComputerHold,
    IPC_CHANNELS.remoteControlComputerRelease,
    IPC_CHANNELS.remoteControlComputerInvoke,
    IPC_CHANNELS.remoteControlComputerSend,
    IPC_CHANNELS.remoteControlComputerState,
    IPC_CHANNELS.remoteControlComputerEvent,
  ];
  type Version = { protocolVersion: number; appVersion: string };

  /** A window's renderer, as main sees its sender. */
  class Window {
    destroyed = false;
    readonly events: PairedComputerWindowEvent[] = [];
    private readonly resets = new Set<() => void>();
    constructor(
      readonly id: number,
      readonly role: 'own' | 'bridge' | 'shows-another' = 'own',
    ) {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    onReset(listener: () => void): void {
      this.resets.add(listener);
    }
    /** The renderer reloads: same window, a new document. */
    reload(): void {
      for (const listener of Array.from(this.resets)) listener();
    }
    close(): void {
      this.destroyed = true;
      for (const listener of Array.from(this.resets)) listener();
    }
  }

  async function identityDir(identity: DeviceKeyPair): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rc-paired-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      join(dir, 'remote-control-identity.key'),
      `pkcs8:${exportDeviceKeyPair(identity).toString('base64')}\n`,
    );
    return dir;
  }

  /** A computer that this desktop has paired with and that pins it back. */
  async function addPairedHost(
    hub: Hub,
    desktop: DeviceKeyPair,
    version: Version = VERSION,
  ): Promise<{ host: Host; identity: DeviceKeyPair }> {
    const identity = generateDeviceKeyPair();
    const host = await createHost(hub, {
      dir: await identityDir(identity),
      version,
      settings: {
        pairedControllers: [
          {
            deviceId: desktop.deviceId,
            name: 'Desktop',
            platform: 'darwin',
            kind: 'desktop',
            publicKey: desktop.publicKey,
            pairedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
    return { host, identity };
  }

  /**
   * This desktop's own RemoteControlService, paired with each host, its
   * window API with the real own-window check, and the switch.
   */
  async function pairedDesktop(
    options: {
      hosts?: Version[];
      desktop?: Version;
      oneWindow?: boolean;
      /** This desktop's signed-in account; null signs it out. */
      account?: { current: string | null };
    } = {},
  ): Promise<{
    desktop: Host;
    hosts: Array<{ host: Host; deviceId: string }>;
    api: PairedComputerWindowApi<Window>;
    setOneWindow: (on: boolean, unconfirmed?: boolean) => void;
    local: Version;
  }> {
    const hub = new Hub();
    const identity = generateDeviceKeyPair();
    const paired = [];
    for (const version of options.hosts ?? [VERSION])
      paired.push(await addPairedHost(hub, identity, version));
    const hosts = paired.map(({ host, identity: hostIdentity }) => ({
      host,
      deviceId: hostIdentity.deviceId,
    }));
    const local = options.desktop ?? VERSION;
    const desktop = await createHost(hub, {
      dir: await identityDir(identity),
      version: local,
      ...(options.account ? { account: options.account } : {}),
      settings: {
        allowIncoming: false,
        pairedHosts: paired.map(({ identity: hostIdentity }, index) => ({
          deviceId: hostIdentity.deviceId,
          name: `Computer ${index + 1}`,
          platform: 'darwin' as const,
          publicKey: hostIdentity.publicKey,
          pairedAt: new Date(0).toISOString(),
        })),
      },
    });
    await until(() => desktop.hub.endpoints.has(identity.deviceId));
    // Main's real switch, followed as main follows it; a saved choice turns
    // it on or off, and unconfirmed preferences read off.
    const setOneWindow = (on: boolean, unconfirmed = false): void =>
      applyOneWindowChoice(on, unconfirmed);
    setOneWindow(options.oneWindow !== false);
    const stopFollowing = followOneWindowSwitch(
      desktop.service,
      { isEnabled: isOneWindowEnabled, onChange: onOneWindowEnabledChanged },
      createOneWindowSessionPolicy(local),
    );
    cleanups.push(() => {
      stopFollowing();
      applyOneWindowChoice(false, false);
    });
    const api = new PairedComputerWindowApi<Window>({
      service: desktop.service,
      // The check main uses, over this test's window roles.
      isOwnWindow: ownWindowCheck<Window>({
        bridgeController: (sender) =>
          sender.role === 'bridge' ? (hosts[0]?.deviceId ?? 'paired') : null,
        showsAnotherComputer: (sender) => sender.role === 'shows-another',
        isAppWindow: () => true,
      }),
      deliver: (sender, event): void => {
        sender.events.push(event);
      },
      onRendererReset: (sender, listener): void => sender.onReset(listener),
    });
    cleanups.push(() => api.dispose());
    return { desktop, hosts, api, setOneWindow, local };
  }

  function fail(message: string): never {
    throw new Error(message);
  }

  function connectedControllers(host: Host): Promise<number> {
    return state(host).then(
      (snapshot) =>
        snapshot.controllers.filter((controller) => controller.connected)
          .length,
    );
  }

  it('keeps every window channel local, so no controller reaches a third computer through this one', async () => {
    for (const channel of WINDOW_CHANNELS) {
      expect(getRemoteChannelDisposition(channel)).toBe('local');
      expect(oneWindowChannelAllowed(channel)).toBe(false);
    }
    // A paired desktop on the full tunnel, and one in one-window mode, are
    // refused every window channel before the host's bridge sees it.
    const hub = new Hub();
    const controller = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(controller)] },
    });
    for (const params of [
      { version: VERSION },
      { version: VERSION, controller: oneWindowControllerProfile() },
    ]) {
      const { rpc } = await control(host, controller);
      await hello(rpc, params);
      for (const channel of WINDOW_CHANNELS) {
        expect(await invokeCode(rpc, channel)).toBe(
          'remote_channel_unavailable',
        );
      }
    }
    expect(host.bridge.invokes).toEqual([]);
    // In main, a bridge window and a window showing another computer are
    // refused every call; neither opens a session.
    const { api, hosts } = await pairedDesktop();
    const deviceId = hosts[0]?.deviceId ?? fail('no host');
    for (const sender of [
      new Window(1, 'bridge'),
      new Window(2, 'shows-another'),
    ]) {
      await expect(api.hold(sender, deviceId)).rejects.toThrow(
        "Only this computer's own windows can reach a paired computer.",
      );
      expect(() => api.state(sender, deviceId)).toThrow(
        "Only this computer's own windows",
      );
      await expect(
        Promise.resolve().then(() =>
          api.invoke(sender, deviceId, LIST_CHANNEL, [READ]),
        ),
      ).rejects.toThrow("Only this computer's own windows");
      api.send(sender, deviceId, LIST_CHANNEL, [READ]);
    }
    await settle(20);
    expect(await connectedControllers(hosts[0]?.host ?? fail('no host'))).toBe(
      0,
    );
  });

  it('is inert while the one-window switch is off, and closes everything when it turns off', async () => {
    const { api, hosts, setOneWindow, desktop } = await pairedDesktop({
      oneWindow: false,
    });
    const { host, deviceId } = hosts[0] ?? fail('no host');
    const window = new Window(1);
    await expect(api.hold(window, deviceId)).rejects.toThrow(
      'Connecting to another computer without its window is off.',
    );
    expect(api.state(window, deviceId)).toEqual({
      status: 'unavailable',
      reason: 'one-window-off',
      message: null,
    });
    await settle(20);
    expect(await connectedControllers(host)).toBe(0);
    expect(host.bridge.created).toEqual([]);

    setOneWindow(true);
    const { holdId } = await api.hold(window, deviceId);
    await until(() => api.state(window, deviceId).status === 'connected');
    expect(await api.invoke(window, deviceId, LIST_CHANNEL, [READ])).toBe('ok');

    setOneWindow(false);
    expect(window.events.at(-1)).toEqual({
      deviceId,
      type: 'state',
      state: { status: 'unavailable', reason: 'one-window-off', message: null },
    });
    await until(async () => (await connectedControllers(host)) === 0);
    // The window's hold went with the switch: it holds nothing to call.
    await expect(
      Promise.resolve().then(() =>
        api.invoke(window, deviceId, LIST_CHANNEL, [READ]),
      ),
    ).rejects.toThrow('This window is not connected to that computer.');
    api.release(window, holdId);
    // Turning it back on reconnects nothing until a window holds it again.
    setOneWindow(true);
    await settle(20);
    expect(await connectedControllers(host)).toBe(0);
    expect(desktop.service.computerState(deviceId)).toEqual({ status: 'idle' });

    // A failed preferences recovery latches the switch off: the same close.
    await api.hold(window, deviceId);
    await until(() => api.state(window, deviceId).status === 'connected');
    setOneWindow(true, true);
    expect(isOneWindowEnabled()).toBe(false);
    expect(window.events.at(-1)).toEqual({
      deviceId,
      type: 'state',
      state: { status: 'unavailable', reason: 'one-window-off', message: null },
    });
    await until(async () => (await connectedControllers(host)) === 0);
  });

  it('serves only the announced list, refusing anything else in main, and only to a window holding a paired computer', async () => {
    const { api, hosts } = await pairedDesktop();
    const { host, deviceId } = hosts[0] ?? fail('no host');
    const window = new Window(1);
    const other = new Window(2);
    // Not paired: refused, and nothing connects.
    const stranger = generateDeviceKeyPair().deviceId;
    await expect(api.hold(window, stranger)).rejects.toThrow(
      'That computer is not paired.',
    );
    expect(api.state(window, stranger)).toEqual({
      status: 'unavailable',
      reason: 'not-paired',
      message: null,
    });
    await expect(api.hold(window, 'not a device')).rejects.toThrow(
      'Invalid device ID.',
    );

    const held = await api.hold(window, deviceId);
    expect(typeof held.holdId).toBe('string');
    await until(() => api.state(window, deviceId).status === 'connected');
    expect(api.state(window, deviceId)).toEqual({
      status: 'connected',
      version: VERSION,
      capabilities: [...ONE_WINDOW_CAPABILITIES],
    });
    expect(await api.invoke(window, deviceId, LIST_CHANNEL, [READ])).toBe('ok');
    // The other computer receives exactly the call the window made.
    expect(host.bridge.invokes.at(-1)).toBe(LIST_CHANNEL);
    expect(host.bridge.invokeArgs.at(-1)).toEqual([READ]);
    // Off the list, or on it with arguments it may not carry: refused here,
    // before anything reaches the other computer.
    const before = host.bridge.invokes.length;
    for (const [channel, args] of [
      [NOT_A_MOBILE_CHANNEL, []],
      [IPC_CHANNELS.approvalModeSet, [{ mode: 'full' }]],
      [IPC_CHANNELS.modelRegistryGet, [{ probe: true }]],
      ['no-such-channel', []],
    ] as const) {
      const refusal = await api
        .invoke(window, deviceId, channel, [...args])
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refusal).toBeInstanceOf(RemoteChannelUnavailableError);
      expect(refusal).not.toBeInstanceOf(RpcRemoteError);
      api.send(window, deviceId, channel, [...args]);
    }
    // A qualified id is the window's mistake: the computer gets its own ids.
    await expect(
      Promise.resolve().then(() =>
        api.invoke(window, deviceId, LIST_CHANNEL, [
          { chatId: `computer-${deviceId}:chat-1` },
        ]),
      ),
    ).rejects.toThrow('Invalid id: pass the computer its own id.');
    // In the session snapshot's selectors too.
    for (const selector of [
      'workspaceLocalId',
      'worktreeLocalId',
      'standaloneChatLocalId',
    ]) {
      await expect(
        Promise.resolve().then(() =>
          api.invoke(window, deviceId, IPC_CHANNELS.desktopSessionSnapshot, [
            { [selector]: `computer-${deviceId}:local-1` },
          ]),
        ),
      ).rejects.toThrow('Invalid id: pass the computer its own id.');
    }
    // Nested in a declaration's lists too, such as the scopes it covers.
    await expect(
      Promise.resolve().then(() =>
        api.invoke(window, deviceId, IPC_CHANNELS.chatSetStateScopes, [
          {
            kind: 'scopes',
            scopes: [
              { projectId: `computer-${deviceId}:project-1`, worktreeId: 'w' },
            ],
          },
        ]),
      ),
    ).rejects.toThrow('Invalid id: pass the computer its own id.');
    await settle(20);
    expect(host.bridge.invokes.slice(before)).toEqual([]);
    expect(host.bridge.posts).toEqual([]);
    // Another window that holds nothing can't use this one's hold.
    await expect(
      Promise.resolve().then(() =>
        api.invoke(other, deviceId, LIST_CHANNEL, [READ]),
      ),
    ).rejects.toThrow('This window is not connected to that computer.');
    api.release(other, held.holdId);
    expect(await api.invoke(window, deviceId, LIST_CHANNEL, [READ])).toBe('ok');
    // Closing the window lets the session go.
    window.close();
    await until(async () => (await connectedControllers(host)) === 0);
  });

  it('lets go of a window that reloads, a call its window let go of, and every hold at sign-out', async () => {
    const account: { current: string | null } = {
      current: `account:${ACCOUNT_USER_ID}`,
    };
    const { api, hosts, desktop } = await pairedDesktop({ account });
    const { host, deviceId } = hosts[0] ?? fail('no host');
    // A reloaded renderer never saw its old hold ids: they go with it.
    const reloading = new Window(1);
    await api.hold(reloading, deviceId);
    await until(() => api.state(reloading, deviceId).status === 'connected');
    reloading.reload();
    await expect(
      Promise.resolve().then(() =>
        api.invoke(reloading, deviceId, LIST_CHANNEL, [READ]),
      ),
    ).rejects.toThrow('This window is not connected to that computer.');
    await until(async () => (await connectedControllers(host)) === 0);

    // A call the old page made is dropped even when the reloaded page holds
    // the computer again before the connection opens, and another window
    // keeps that connection.
    const keeper = new Window(9);
    const { holdId: keeperHold } = await api.hold(keeper, deviceId);
    const { holdId: oldHold } = await api.hold(reloading, deviceId);
    const oldCall = api.invoke(reloading, deviceId, LIST_CHANNEL, [READ]);
    reloading.reload();
    const { holdId: newHold } = await api.hold(reloading, deviceId);
    await expect(oldCall).rejects.toThrow(
      'The connection to that computer was closed.',
    );
    await until(() => api.state(reloading, deviceId).status === 'connected');
    await settle(20);
    expect(host.bridge.invokes).toEqual([]);
    expect(oldHold).not.toBe(newHold);
    expect(await api.invoke(reloading, deviceId, LIST_CHANNEL, [READ])).toBe(
      'ok',
    );
    api.release(reloading, newHold);
    api.release(keeper, keeperHold);
    await until(async () => (await connectedControllers(host)) === 0);

    // A call made while the connection opens is dropped once its window
    // lets go, even though another window keeps the connection.
    const leaving = new Window(2);
    const staying = new Window(3);
    const { holdId } = await api.hold(leaving, deviceId);
    await api.hold(staying, deviceId);
    const before = host.bridge.invokes.length;
    const call = api.invoke(leaving, deviceId, LIST_CHANNEL, [READ]);
    api.send(leaving, deviceId, LIST_CHANNEL, [READ]);
    api.release(leaving, holdId);
    await expect(call).rejects.toThrow(
      'The connection to that computer was closed.',
    );
    await until(() => api.state(staying, deviceId).status === 'connected');
    await settle(20);
    expect(host.bridge.invokes.slice(before)).toEqual([]);
    expect(host.bridge.posts).toEqual([]);
    expect(await api.invoke(staying, deviceId, LIST_CHANNEL, [READ])).toBe(
      'ok',
    );

    // Signing out stops Remote Control: the window hears why, not idle.
    account.current = null;
    await desktop.service.reconcile();
    expect(staying.events.at(-1)).toEqual({
      deviceId,
      type: 'state',
      state: {
        status: 'unavailable',
        reason: 'remote-control-off',
        message: null,
      },
    });
    await until(async () => (await connectedControllers(host)) === 0);
  });

  it("delivers each computer's updates only to windows holding it, split per computer in the preload", async () => {
    const { api, hosts } = await pairedDesktop({ hosts: [VERSION, VERSION] });
    const [studio, laptop] = hosts;
    if (!studio || !laptop) fail('two hosts');
    const window = new Window(1);
    const bystander = new Window(2);
    // The preload's transport over this window's events.
    const listeners = new Set<Parameters<PreloadIpcRenderer['on']>[1]>();
    const preload = createPairedComputersApi({
      invoke: (): Promise<never> => Promise.reject(new Error('unused')),
      send: (): void => undefined,
      sendSync: (): undefined => undefined,
      on: (_channel, listener): void => {
        listeners.add(listener);
      },
      once: (): void => undefined,
      removeListener: (_channel, listener): void => {
        listeners.delete(listener);
      },
      removeAllListeners: (): void => undefined,
    });
    const studioUpdates: PairedComputerUpdate[] = [];
    const laptopUpdates: PairedComputerUpdate[] = [];
    const stopStudio = preload.onUpdate(studio.deviceId, (update) =>
      studioUpdates.push(update),
    );
    preload.onUpdate(laptop.deviceId, (update) => laptopUpdates.push(update));
    const forward = (): void => {
      for (const event of window.events.splice(0))
        for (const listener of Array.from(listeners))
          Reflect.apply(listener, undefined, [{}, event]);
    };

    await api.hold(window, studio.deviceId);
    await api.hold(window, laptop.deviceId);
    await until(
      () =>
        api.state(window, studio.deviceId).status === 'connected' &&
        api.state(window, laptop.deviceId).status === 'connected',
    );
    studio.host.bridge.emitPush(LIST_PUSH, ['studio']);
    laptop.host.bridge.emitPush(LIST_PUSH, ['laptop']);
    // Off the list: the host does not forward it, nor would main.
    studio.host.bridge.emitPush(NOT_A_MOBILE_CHANNEL, ['never']);
    await until(
      () => window.events.filter((event) => event.type === 'push').length === 2,
    );
    forward();
    expect(studioUpdates).toEqual([
      { type: 'push', channel: LIST_PUSH, args: ['studio'] },
    ]);
    expect(laptopUpdates).toEqual([
      { type: 'push', channel: LIST_PUSH, args: ['laptop'] },
    ]);
    expect(bystander.events).toEqual([]);
    // Unsubscribed from one computer, the other's updates still arrive.
    stopStudio();
    studio.host.bridge.emitPush(LIST_PUSH, ['studio again']);
    laptop.host.bridge.emitPush(LIST_PUSH, ['laptop again']);
    await until(
      () => window.events.filter((event) => event.type === 'push').length === 2,
    );
    forward();
    expect(studioUpdates).toHaveLength(1);
    expect(laptopUpdates.at(-1)).toEqual({
      type: 'push',
      channel: LIST_PUSH,
      args: ['laptop again'],
    });
  });

  it('connects to a paired computer on another version at or above the floor; the separate window keeps the exact match', async () => {
    const newer = {
      protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
      appVersion: '2.0.0',
    };
    const { api, hosts, desktop } = await pairedDesktop({ desktop: newer });
    const { deviceId } = hosts[0] ?? fail('no host');
    const window = new Window(1);
    await api.hold(window, deviceId);
    await until(() => api.state(window, deviceId).status === 'connected');
    expect(api.state(window, deviceId)).toMatchObject({
      status: 'connected',
      version: VERSION,
    });
    expect(await api.invoke(window, deviceId, LIST_CHANNEL, [READ])).toBe('ok');
    // The separate window to the same computer is still refused.
    await desktop.service.openMachine(deviceId);
    await until(async () =>
      (await state(desktop)).hosts.some(
        (entry) => entry.deviceId === deviceId && entry.connection === 'error',
      ),
    );
    const entry = (await state(desktop)).hosts.find(
      (candidate) => candidate.deviceId === deviceId,
    );
    expect(entry?.error).toContain('Update Host to connect.');
    // The windowless session is unaffected.
    expect(await api.invoke(window, deviceId, LIST_CHANNEL, [READ])).toBe('ok');
  });

  it('reports a paired computer below the floor as needing an update, with both versions', async () => {
    const belowFloor = {
      protocolVersion: DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION - 1,
      appVersion: '0.9.0',
    };
    const { api, hosts, local } = await pairedDesktop({ hosts: [belowFloor] });
    const { host, deviceId } = hosts[0] ?? fail('no host');
    const window = new Window(1);
    await api.hold(window, deviceId);
    await until(() => api.state(window, deviceId).status === 'needs-update');
    expect(api.state(window, deviceId)).toEqual({
      status: 'needs-update',
      reason: 'computer-too-old',
      computerVersion: belowFloor,
      computerAppVersion: belowFloor.appVersion,
      thisComputerVersion: local,
      update: null,
    });
    expect(
      window.events.some(
        (event) =>
          event.type === 'state' && event.state.status === 'needs-update',
      ),
    ).toBe(true);
    // Nothing reaches it: no bridge, no calls.
    await expect(
      api.invoke(window, deviceId, LIST_CHANNEL, [READ]),
    ).rejects.toThrow('Update Host to connect.');
    expect(host.bridge.created).toEqual([]);
    expect(host.bridge.invokes).toEqual([]);
  });

  it('names this computer as the one to update when the paired computer is newer and refuses it', async () => {
    const newer = {
      protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
      appVersion: '2.0.0',
    };
    // This computer's own build is below the floor (an E2E override).
    const belowFloor = {
      protocolVersion: DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION - 1,
      appVersion: '0.9.0',
    };
    const { api, hosts } = await pairedDesktop({
      hosts: [newer],
      desktop: belowFloor,
    });
    const { deviceId } = hosts[0] ?? fail('no host');
    const window = new Window(1);
    await api.hold(window, deviceId);
    await until(() => api.state(window, deviceId).status === 'needs-update');
    expect(api.state(window, deviceId)).toMatchObject({
      status: 'needs-update',
      reason: 'this-computer-older',
      computerVersion: newer,
      thisComputerVersion: belowFloor,
    });
  });

  it('keeps nothing for thousands of calls that fail while its relay is down (CAN-8049)', async () => {
    const { desktop, hosts } = await pairedDesktop({ oneWindow: false });
    const hostId = hosts[0].deviceId;
    const desktopId = desktop.identity.deviceId;
    const endpoint = desktop.hub.endpoints.get(desktopId);
    if (!endpoint) throw new Error('The desktop is not on the relay.');
    const connection = async (): Promise<string | undefined> =>
      (await desktop.service.getState()).hosts.find(
        (entry) => entry.deviceId === hostId,
      )?.connection;
    await desktop.service.openMachine(hostId);
    await until(async () => (await connection()) === 'connected');
    expect(await desktop.service.invoke(hostId, LIST_CHANNEL, [READ])).toBe(
      'ok',
    );
    // The window's session is gone and the relay drops this computer: every
    // reconnect fails at once, as after the soak's stuck relay (CAN-8048).
    desktop.service.releaseMachine(hostId);
    endpoint.stop();
    desktop.hub.cut.add(`${desktopId}>${hostId}`);
    desktop.hub.cut.add(`${hostId}>${desktopId}`);
    endpoint.peerWent(hostId, 'offline');
    // Every timer from here is counted, unref'ed ones and the reopened
    // window's first retry too; they still run on time.
    jest.useFakeTimers({
      advanceTimers: true,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    // One after another: calls made together share one connection attempt.
    const failures: unknown[] = [];
    let timers: number;
    let listeners: number;
    try {
      await desktop.service.openMachine(hostId);
      await settle(20);
      listeners = endpoint.listenerCount();
      for (let call = 0; call < 3_000; call += 1) {
        failures.push(
          await desktop.service.invoke(hostId, LIST_CHANNEL, [READ]).then(
            () => null,
            (error: unknown) => error,
          ),
        );
      }
      await settle(20);
      timers = jest.getTimerCount();
    } finally {
      jest.useRealTimers();
    }
    expect(
      failures.every(
        (error) =>
          error instanceof Error &&
          error.message === 'Not connected to the relay.',
      ),
    ).toBe(true);
    // No call left a timer, a listener or a connection attempt behind; the
    // connection keeps at most its one retry timer.
    expect(timers).toBeLessThanOrEqual(1);
    expect(endpoint.listenerCount()).toBe(listeners);
    expect(await connection()).not.toBe('connected');
    // The relay comes back: the next call goes through.
    desktop.hub.cut.clear();
    endpoint.start();
    endpoint.peerWent(hostId, 'online');
    await until(async () => {
      try {
        const result = await desktop.service.invoke(hostId, LIST_CHANNEL, [
          READ,
        ]);
        return result === 'ok';
      } catch {
        return false;
      }
    });
  });
});

describe('browser controller channels', () => {
  it('tunnels every browser channel and serves the read channels added for browsers only to them', async () => {
    // The composer menus, plugin catalog and pipeline detail Portal's
    // executor serves, and the worktree panel rows, script log, hook pause
    // and Orchestrator settings Portal serves, as desktop channels
    // (CAN-5985).
    const added = {
      editorListSlashCommands: IPC_CHANNELS.editorListSlashCommands,
      editorListInvocables: IPC_CHANNELS.editorListInvocables,
      editorResolveInvocable: IPC_CHANNELS.editorResolveInvocable,
      pluginCatalogList: IPC_CHANNELS.pluginCatalogList,
      pipelinesGetForWorktree: PIPELINE_CHANNELS.GET_FOR_WORKTREE,
      worktreeActivityEntities: IPC_CHANNELS.worktreeActivityEntities,
      scriptReadRunLog: IPC_CHANNELS.scriptReadRunLog,
      hookChangePause: IPC_CHANNELS.hookChangePause,
      appAdvisorSettingsView: IPC_CHANNELS.appAdvisorSettingsView,
      appAdvisorSettingsPatch: IPC_CHANNELS.appAdvisorSettingsPatch,
    };
    expect(added).toEqual({
      editorListSlashCommands: 'editor:list-slash-commands',
      editorListInvocables: 'editor:list-invocables',
      editorResolveInvocable: 'editor:resolve-invocable',
      pluginCatalogList: 'plugin-catalog:list',
      pipelinesGetForWorktree: 'pipelines:get-for-worktree',
      worktreeActivityEntities: 'worktree:activity-entities',
      scriptReadRunLog: 'script:read-run-log',
      hookChangePause: 'hook:change-pause',
      appAdvisorSettingsView: 'app-advisor:settings-view',
      appAdvisorSettingsPatch: 'app-advisor:settings-patch',
    });
    expect(
      BROWSER_CONTROLLER_CHANNELS.filter(
        (channel) =>
          getRemoteChannelDisposition(channel) !== 'tunnel' ||
          channel.startsWith('terminal:'),
      ),
    ).toEqual([]);
    // A settings save is announced to the desktop's own windows
    // (app-advisor:settings-changed, as mobile hears it); a browser reads the
    // settings view again instead.
    expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(
      IPC_CHANNELS.appAdvisorSettingsChanged,
    );
    // The plugin catalog, worktree activity entities and hook pause also
    // serve the hosted Tasks tools (CAN-7445); the rest stay browser-only.
    const alsoHosted: readonly string[] = [
      added.pluginCatalogList,
      added.worktreeActivityEntities,
      added.hookChangePause,
    ];
    for (const channel of Object.values(added)) {
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
      if (alsoHosted.includes(channel))
        expect(HOSTED_CONTROLLER_CHANNELS).toContain(channel);
      else expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
        ],
      },
    });
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of Object.values(added)) {
      expect(await invokeCode(fromBrowser.rpc, channel)).toBe('ok');
      expect(await invokeCode(fromPhone.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    }

    const absolutePath = '/workspace/report.md';
    const workspaceRead = {
      absolutePath,
      workspaceTarget: { projectId: 'project', worktreeId: 'worktree' },
    };
    const catalogRead = {
      ...workspaceRead,
      file: { fileRootId: 'repo', relativePath: 'report.md' },
    };
    const channel = IPC_CHANNELS.fileReadContent;
    for (const request of [
      { absolutePath },
      { absolutePath, workspaceTarget: { projectId: 'project' } },
      { ...workspaceRead, allowedRoot: 'codex-generated-images' },
    ]) {
      await expect(
        fromBrowser.rpc.request(REMOTE_METHODS.invoke, {
          channel,
          args: [request],
        }),
      ).rejects.toMatchObject({ code: 'remote_channel_unavailable' });
    }
    expect(host.bridge.invokes).toEqual(Object.values(added));
    for (const request of [workspaceRead, catalogRead]) {
      expect(
        await fromBrowser.rpc.request(REMOTE_METHODS.invoke, {
          channel,
          args: [request],
        }),
      ).toBe('ok');
    }
    expect(host.bridge.invokeArgs.slice(Object.keys(added).length)).toEqual([
      [workspaceRead],
      [catalogRead],
    ]);
  });

  it('serves script review to browsers only, and never the found push or a terminal', async () => {
    // The script review the desktop's own dialog makes, and the push its
    // snapshot refreshes on (CAN-6038). Execution stays terminal-bound.
    const invoked = [
      IPC_CHANNELS.scriptActionsList,
      IPC_CHANNELS.scriptActionsReceipt,
      IPC_CHANNELS.scriptActionsRescan,
      IPC_CHANNELS.scriptActionsReview,
      IPC_CHANNELS.scriptActionsSetShortcut,
      IPC_CHANNELS.scriptActionsSetPinned,
      IPC_CHANNELS.scriptActionsEnableShellAliasScan,
    ];
    for (const channel of [...invoked, IPC_CHANNELS.scriptActionsChanged]) {
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    const withheld = [
      IPC_CHANNELS.scriptActionsFound,
      IPC_CHANNELS.terminalSpawn,
    ];
    for (const channel of withheld) {
      expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
        ],
      },
    });
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of invoked) {
      expect(await invokeCode(fromBrowser.rpc, channel)).toBe('ok');
      expect(await invokeCode(fromPhone.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    }
    for (const channel of withheld) {
      expect(await invokeCode(fromBrowser.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    }
    expect(host.bridge.invokes).toEqual(invoked);
  });

  it('serves Claude Mods to browsers and keeps composer requests on this computer (CAN-7436)', async () => {
    const channels = [
      IPC_CHANNELS.claudeModsGet,
      IPC_CHANNELS.claudeModsUpdate,
      IPC_CHANNELS.claudeModSurfaceCommand,
      IPC_CHANNELS.claudeModSurfacePush,
    ];
    expect(channels).toEqual([
      'claude-mods:get',
      'claude-mods:update',
      'claude-mods:surface-command',
      'claude-mods:surface-push',
    ]);
    for (const channel of channels) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    const chat = { projectId: 'p1', worktreeId: 'w1', chatId: 'c1' };
    const command = (
      value: ClaudeModSurfaceCommandArgs['command'],
    ): ClaudeModSurfaceCommandArgs[] => [{ ...chat, command: value }];
    const press = command({
      kind: 'press',
      press: { plugin: 'mod@market', handle: 1 },
      key: 'go',
    });
    const answer = command({
      kind: 'composer-answer',
      requestId: 'r1',
      answer: { kind: 'read', text: 'draft', cursor: 5 },
    });
    const modsOff: ClaudeModsUpdate = {
      action: 'set-mods-disabled',
      modsDisabled: true,
    };
    const pushOf = (
      push: ClaudeModSurfacePushEvent['push'],
    ): ClaudeModSurfacePushEvent[] => [{ ...chat, push }];

    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
          pinned(desktop),
        ],
      },
    });
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    const fromDesktop = await control(host, desktop);
    await hello(fromDesktop.rpc);

    const allowed: Array<[string, unknown[]]> = [
      [IPC_CHANNELS.claudeModsGet, [{}]],
      [IPC_CHANNELS.claudeModsUpdate, [modsOff]],
      [IPC_CHANNELS.claudeModSurfaceCommand, press],
    ];
    for (const [channel, args] of allowed) {
      expect(await invokeCodeWith(fromBrowser.rpc, channel, args)).toBe('ok');
      expect(await invokeCodeWith(fromPhone.rpc, channel, args)).toBe(
        'remote_channel_unavailable',
      );
    }
    // No controller answers a Mod's composer request, and a command whose
    // kind cannot be read is refused before the handler.
    const refused: unknown[][] = [
      answer,
      [],
      [{ ...chat }],
      [{ ...chat, command: {} }],
      [{ ...chat, command: { kind: 7 } }],
      [{ ...chat, command: { kind: 'toString' } }],
    ];
    for (const args of refused) {
      for (const rpc of [fromBrowser.rpc, fromDesktop.rpc]) {
        expect(
          await invokeCodeWith(rpc, IPC_CHANNELS.claudeModSurfaceCommand, args),
        ).toBe('remote_channel_unavailable');
      }
    }
    expect(
      await invokeCodeWith(
        fromDesktop.rpc,
        IPC_CHANNELS.claudeModSurfaceCommand,
        press,
      ),
    ).toBe('ok');
    expect(host.bridge.invokes).toEqual([
      ...allowed.map(([channel]) => channel),
      IPC_CHANNELS.claudeModSurfaceCommand,
    ]);
    expect(host.bridge.invokeArgs).toEqual([
      ...allowed.map(([, args]) => args),
      press,
    ]);

    // Composer requests and withdrawals, and pushes of unreadable kinds,
    // never leave this computer; composer activity is a log line and does.
    host.mainPush(
      IPC_CHANNELS.claudeModSurfacePush,
      pushOf({
        kind: 'composer-request',
        requestId: 'r1',
        request: { kind: 'read' },
        expiresAt: 1,
      }),
    );
    host.mainPush(
      IPC_CHANNELS.claudeModSurfacePush,
      pushOf({ kind: 'composer-withdraw', requestId: 'r1' }),
    );
    host.mainPush(IPC_CHANNELS.claudeModSurfacePush, [{ ...chat }]);
    host.mainPush(IPC_CHANNELS.claudeModSurfacePush, [
      { ...chat, push: { kind: null } },
    ]);
    const forwarded = [
      pushOf({ kind: 'status', plugin: 'mod@market', text: 'Ready' }),
      pushOf({
        kind: 'tree',
        site: 'band',
        instanceId: 'above-prompt',
        tree: null,
      }),
      pushOf({ kind: 'composer-activity', action: 'read', plugin: null }),
    ];
    for (const args of forwarded) {
      host.mainPush(IPC_CHANNELS.claudeModSurfacePush, args);
    }
    await until(() => browser.pushes.length >= 3 && desktop.pushes.length >= 3);
    await settle(20);
    for (const controller of [browser, desktop]) {
      expect(controller.pushPayloads).toEqual(
        forwarded.map((args) => ({
          channel: IPC_CHANNELS.claudeModSurfacePush,
          args,
        })),
      );
    }
    expect(phone.pushes).toEqual([]);
  });

  it('serves the archived Work Entry list to browsers and refuses controllers without it', async () => {
    // The archive overview Portal's paired session read (CAN-5986). Portal
    // allowed it only to its own active pairing; over Remote Control the
    // controller profile is that authorization, so mobile and hosted
    // controllers are refused before the desktop handler runs.
    const channel = IPC_CHANNELS.workEntriesListArchived;
    expect(channel).toBe('work-entries:list-archived');
    expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
    expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
    expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
    expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
        ],
      },
    });
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    expect(await invokeCode(fromPhone.rpc, channel)).toBe(
      'remote_channel_unavailable',
    );
    expect(host.bridge.invokes).toEqual([]);
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    expect(await invokeCode(fromBrowser.rpc, channel)).toBe('ok');
    expect(host.bridge.invokes).toEqual([channel]);
  });

  it('serves the archive recovery list, Resolve, Finish and Set aside to browsers and desktops only (CAN-7439, CAN-7444)', async () => {
    // The list is a read under the bridge's `core.worktree.read`; the
    // revision tokens it returns are accepted by Resolve, Finish and Set aside.
    // The bridge principal is the same for every controller kind, so the
    // profile lists alone keep mobile and hosted controllers out.
    const list = IPC_CHANNELS.worktreeRecoveryList;
    const actions = [
      IPC_CHANNELS.worktreeRecoveryResolve,
      IPC_CHANNELS.worktreeRecoveryFinish,
      IPC_CHANNELS.worktreeRecoverySetAside,
    ];
    const reviewed = {
      workspaceId: 'ws',
      operationId: '00000000-0000-4000-8000-000000007014',
      revision: 'a'.repeat(64),
    };
    const argsFor = (channel: string): unknown[] =>
      channel === IPC_CHANNELS.worktreeRecoveryResolve
        ? [{ ...reviewed, action: 'release' }]
        : channel === list
          ? []
          : [reviewed];
    expect(list).toBe('worktree:recovery-list');
    expect(getRemoteChannelDisposition(list)).toBe('tunnel');
    expect(BROWSER_CONTROLLER_CHANNELS).toContain(list);
    expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(list);
    expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(list);
    for (const action of actions) {
      expect(getRemoteChannelDisposition(action)).toBe('tunnel');
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(action);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(action);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(action);
    }
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const desktop = addController(hub, 'desktop');
    const root = generateDeviceKeyPair();
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
          pinned(desktop),
          {
            deviceId: root.deviceId,
            name: 'Agents',
            platform: 'linux',
            kind: 'hosted',
            publicKey: root.publicKey,
            pairedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
    const agent = addController(hub, 'hosted');
    const fromHosted = await control(
      host,
      agent,
      delegate(root, agent.identity.publicKey, Date.now() + 60_000),
    );
    await hello(fromHosted.rpc);
    for (const channel of [list, ...actions])
      expect(
        await invokeCodeWith(fromHosted.rpc, channel, argsFor(channel)),
      ).toBe('remote_channel_unavailable');
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of [list, ...actions])
      expect(
        await invokeCodeWith(fromPhone.rpc, channel, argsFor(channel)),
      ).toBe('remote_channel_unavailable');
    expect(host.bridge.invokes).toEqual([]);
    const fromDesktop = await control(host, desktop);
    await hello(fromDesktop.rpc, { version: VERSION });
    for (const action of actions)
      expect(
        await invokeCodeWith(fromDesktop.rpc, action, argsFor(action)),
      ).toBe('ok');
    expect(host.bridge.invokes).toEqual(actions);
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    // Browser callers reach only the adapter's exact reviewed-target shape.
    for (const args of [
      [],
      [null],
      [reviewed, reviewed],
      [{ ...reviewed, path: '/tmp/record' }],
      [{ ...reviewed, workspaceId: '' }],
      [{ ...reviewed, workspaceId: 'w'.repeat(513) }],
      [{ ...reviewed, operationId: 'not-a-uuid' }],
      [{ ...reviewed, revision: 'a'.repeat(63) }],
      [{ ...reviewed, revision: 'G'.repeat(64) }],
      [{ operationId: reviewed.operationId, revision: reviewed.revision }],
    ]) {
      expect(
        await invokeCodeWith(
          fromBrowser.rpc,
          IPC_CHANNELS.worktreeRecoverySetAside,
          args,
        ),
      ).toBe('remote_channel_unavailable');
    }
    expect(host.bridge.invokes).toEqual(actions);
    for (const action of actions)
      expect(
        await invokeCodeWith(fromBrowser.rpc, action, argsFor(action)),
      ).toBe('ok');
    expect(await invokeCode(fromBrowser.rpc, list)).toBe('ok');
    expect(host.bridge.invokes).toEqual([...actions, ...actions, list]);
    expect(
      await invokeCodeWith(
        fromBrowser.rpc,
        IPC_CHANNELS.worktreeRecoverySetAside,
        [{ ...reviewed, workspaceId: 'w'.repeat(512) }],
      ),
    ).toBe('ok');
    expect(host.bridge.invokes).toEqual([
      ...actions,
      ...actions,
      list,
      IPC_CHANNELS.worktreeRecoverySetAside,
    ]);
  });

  it('passes only code-shaped archive Finish checks to browsers (CAN-7444)', async () => {
    const finished = {
      status: 'finished',
      operationId: '00000000-0000-4000-8000-000000007444',
      cleanupRequired: false,
      gitCleanupPending: false,
    };
    const results: readonly (readonly [unknown, unknown])[] = [
      // A W5 refusal's `check` is whatever string its thrower set.
      [
        { status: 'refused', check: '/Users/someone/code/app/.git' },
        { status: 'refused', check: 'finish-refused' },
      ],
      [
        { status: 'interrupted', check: 'C:\\Users\\someone' },
        { status: 'interrupted', check: 'finish-refused' },
      ],
      [
        { status: 'refused', check: 'storage admission' },
        { status: 'refused', check: 'finish-refused' },
      ],
      [
        { status: 'refused', check: '~/code' },
        { status: 'refused', check: 'finish-refused' },
      ],
      [
        { status: 'refused', check: 'a'.repeat(65) },
        { status: 'refused', check: 'finish-refused' },
      ],
      [
        { status: 'refused', check: 42 },
        { status: 'refused', check: 'finish-refused' },
      ],
      // Whatever the status, a present `check` is projected.
      [
        { ...finished, check: '/Users/someone' },
        { ...finished, check: 'finish-refused' },
      ],
      [
        { status: 'refused', check: 'review-changed' },
        { status: 'refused', check: 'review-changed' },
      ],
      [
        { status: 'interrupted', check: 'browser-retirement-timeout' },
        { status: 'interrupted', check: 'browser-retirement-timeout' },
      ],
      [finished, finished],
    ];
    for (const kind of ['browser', 'desktop'] as const)
      for (const [sent, projected] of results) {
        const hub = new Hub();
        const controller = addController(hub, kind);
        const host = await createHost(hub, {
          settings: {
            pairedControllers: [
              kind === 'browser'
                ? pinned(controller, kind)
                : pinned(controller),
            ],
          },
          invokeResult: sent,
        });
        const { rpc } = await control(host, controller);
        await hello(
          rpc,
          kind === 'browser'
            ? {
                version: VERSION,
                controller: { kind, minVersion: REMOTE_PROTOCOL_VERSION },
              }
            : { version: VERSION },
        );
        expect(
          await rpc.request(REMOTE_METHODS.invoke, {
            channel: IPC_CHANNELS.worktreeRecoveryFinish,
            args: [
              {
                workspaceId: 'ws',
                operationId: '00000000-0000-4000-8000-000000007444',
                revision: 'a'.repeat(64),
              },
            ],
          }),
        ).toEqual(kind === 'browser' ? projected : sent);
      }
  });

  it('serves the narrow tips and suggestions reads and their writes to browsers, never preferences:load', async () => {
    // CAN-7434: the browser reads only the tips or suggestions state and
    // writes only those fields; every preference stays desktop-only.
    const channels = [
      IPC_CHANNELS.preferencesLoadOnboardingTips,
      IPC_CHANNELS.preferencesLoadSuggestions,
      IPC_CHANNELS.preferencesUpdateOnboardingTips,
      IPC_CHANNELS.preferencesUpdateSuggestions,
    ];
    for (const channel of channels) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(
      IPC_CHANNELS.preferencesLoad,
    );
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
        ],
      },
    });
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of channels) {
      expect(await invokeCode(fromPhone.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    }
    expect(host.bridge.invokes).toEqual([]);
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    expect(
      await invokeCode(fromBrowser.rpc, IPC_CHANNELS.preferencesLoad),
    ).toBe('remote_channel_unavailable');
    for (const channel of channels) {
      expect(await invokeCode(fromBrowser.rpc, channel)).toBe('ok');
    }
    expect(host.bridge.invokes).toEqual(channels);
  });

  it.each([
    [
      'workspace:set-archive-retention',
      IPC_CHANNELS.workspaceSetArchiveRetention,
    ],
    // Web discard and journal quarantine (CAN-7443), under the same rule.
    ['worktree:discard-describe', IPC_CHANNELS.worktreeDiscardDescribe],
    ['worktree:discard', IPC_CHANNELS.worktreeDiscard],
    [
      'workspace:delete-discard-describe',
      IPC_CHANNELS.workspaceDeleteDiscardDescribe,
    ],
    ['lifecycle-journal:inspect', IPC_CHANNELS.lifecycleJournalInspect],
    ['lifecycle-journal:quarantine', IPC_CHANNELS.lifecycleJournalQuarantine],
  ])(
    'serves %s to browsers and refuses mobile and hosted controllers',
    async (name, channel) => {
      // Web archive and retention over direct Remote Control (CAN-7438): a
      // direct browser session is only ever to the account's own computer,
      // so the browser controller profile is the authorization. Mobile and
      // hosted controllers are refused before the desktop handler runs.
      expect(channel).toBe(name);
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
      const hub = new Hub();
      const browser = addController(hub, 'browser');
      const phone = addController(hub, 'mobile');
      const host = await createHost(hub, {
        settings: {
          pairedControllers: [
            pinned(browser, 'browser'),
            pinned(phone, 'mobile'),
          ],
        },
      });
      const fromPhone = await control(host, phone);
      await hello(fromPhone.rpc, {
        version: VERSION,
        controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
      });
      expect(await invokeCode(fromPhone.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
      expect(host.bridge.invokes).toEqual([]);
      const fromBrowser = await control(host, browser);
      await hello(fromBrowser.rpc, {
        version: VERSION,
        controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
      });
      expect(await invokeCode(fromBrowser.rpc, channel)).toBe('ok');
      expect(host.bridge.invokes).toEqual([channel]);
    },
  );

  it('serves Personal project conversion to browsers only, never the session-owned team steps', async () => {
    // Listing, converting and reading a run's status (CAN-7440). Conversion
    // runs as the computer's signed-in account and deletes nothing; the
    // browser's own session promotes the team and sends invites, so those
    // channels stay off every controller list but the desktop's.
    const invoked = [
      IPC_CHANNELS.personalOrganizationUpgradeList,
      IPC_CHANNELS.personalOrganizationUpgradeConvert,
      IPC_CHANNELS.personalOrganizationUpgradeStatus,
    ];
    for (const channel of invoked) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    const withheld = [
      IPC_CHANNELS.personalOrganizationUpgradePromote,
      IPC_CHANNELS.personalOrganizationUpgradeInvite,
      IPC_CHANNELS.personalOrganizationUpgradeInviteStatus,
    ];
    for (const channel of withheld) {
      expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
        ],
      },
    });
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of invoked) {
      expect(await invokeCode(fromPhone.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    }
    expect(host.bridge.invokes).toEqual([]);
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of withheld) {
      expect(await invokeCode(fromBrowser.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    }
    for (const channel of invoked) {
      expect(await invokeCode(fromBrowser.rpc, channel)).toBe('ok');
    }
    expect(host.bridge.invokes).toEqual(invoked);
  });

  it('serves chat visuals and delegate transcript reads to browsers (CAN-7432)', async () => {
    // Read only and browser-only: mobile and hosted agents get none of them.
    // The watcher list stays off the browser list until the browser can
    // project it.
    const delegationReads = [
      IPC_CHANNELS.chatReadDelegationPage,
      IPC_CHANNELS.chatReadDelegationContent,
      IPC_CHANNELS.chatReadDelegationBlocks,
    ];
    const invoked = [IPC_CHANNELS.chatReadVisual, ...delegationReads];
    expect(invoked).toEqual([
      'chat:read-visual',
      'chat:read-delegation-page',
      'chat:read-delegation-content',
      'chat:read-delegation-blocks',
    ]);
    for (const channel of invoked) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(
      IPC_CHANNELS.appAdvisorWatchersList,
    );
    expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(
      IPC_CHANNELS.appAdvisorWatchersChanged,
    );
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
        ],
      },
    });
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of invoked) {
      expect(await invokeCode(fromPhone.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    }
    expect(host.bridge.invokes).toEqual([]);
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of invoked) {
      expect(await invokeCode(fromBrowser.rpc, channel)).toBe('ok');
    }
    expect(host.bridge.invokes).toEqual(invoked);
  });

  it('reads delegate transcripts only for delegation targets and replies with a reason only', async () => {
    const target = {
      kind: 'delegation',
      chatId: 'chat-1',
      delegationId: 'delegation-1',
      runGeneration: 2,
    };
    const base = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      target,
    };
    const content = {
      ...base,
      messageId: 'message-1',
      blockOrdinal: 3,
      field: 'output',
      offset: 0,
      limit: 65_536,
    };
    const blocks = { ...base, messageId: 'message-1', limit: 64 };
    const scope = {
      workspaceId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    const reads: ChatDelegationCoreRead[] = [];
    const read = (request: ChatDelegationCoreRead): Promise<unknown> => {
      reads.push(request);
      return Promise.resolve({ served: reads.length });
    };
    expect(
      await serveChatDelegationRead(
        'page',
        { ...base, archivedContainerId: 'worktree-1', cursor: 'next' },
        read,
      ),
    ).toStrictEqual({ ok: true, value: { served: 1 } });
    expect(
      await serveChatDelegationRead(
        'content',
        { ...content, fieldSource: 'logical' },
        read,
      ),
    ).toStrictEqual({ ok: true, value: { served: 2 } });
    expect(
      await serveChatDelegationRead(
        'blocks',
        { ...blocks, firstBlockOrdinal: 4 },
        read,
      ),
    ).toStrictEqual({ ok: true, value: { served: 3 } });
    expect(reads).toStrictEqual([
      {
        operation: 'core.chat.transcript.page',
        params: {
          scope,
          archivedContainerId: 'worktree-1',
          target,
          cursor: 'next',
        },
      },
      {
        operation: 'core.chat.content.read',
        params: {
          scope,
          target,
          messageId: 'message-1',
          blockOrdinal: 3,
          field: 'output',
          fieldSource: 'logical',
          offset: 0,
          limit: 65_536,
        },
      },
      {
        operation: 'core.chat.transcript.blocks.page',
        params: {
          scope,
          target,
          messageId: 'message-1',
          firstBlockOrdinal: 4,
          limit: 64,
          projection: 'bounded-v1',
        },
      },
    ]);

    const refused: Array<['page' | 'content' | 'blocks', unknown]> = [
      ['page', { ...base, target: { kind: 'primary', chatId: 'chat-1' } }],
      [
        'content',
        { ...content, target: { kind: 'primary', chatId: 'chat-1' } },
      ],
      ['page', { ...base, target: { ...target, chatId: 'chat-2' } }],
      ['page', { ...base, archivedContainerId: 'worktree-2' }],
      ['page', { ...base, standaloneHistory: true }],
      ['page', { ...base, target: { ...target, extra: true } }],
      ['content', { ...content, limit: 65_537 }],
      ['content', { ...content, fieldSource: 'stored' }],
      ['blocks', { ...blocks, limit: 513 }],
      ['page', { ...base, cursor: 'c'.repeat(2049) }],
      ['blocks', { ...blocks, firstBlockOrdinal: 0, cursor: 'next' }],
      ['page', null],
    ];
    for (const [kind, value] of refused) {
      await expect(serveChatDelegationRead(kind, value, read)).rejects.toThrow(
        'Delegation transcript read request is invalid.',
      );
    }
    expect(reads).toHaveLength(3);

    const failing = (error: Error) => (): Promise<unknown> =>
      Promise.reject(error);
    expect(
      await serveChatDelegationRead(
        'page',
        base,
        failing(
          new CanopyOperationError({
            kind: 'failed_precondition',
            code: 'core.chat.transcript.page.staleCursor',
            message: 'Stale cursor at /Users/someone/chat.jsonl',
            retry: { kind: 'never' },
          }),
        ),
      ),
    ).toStrictEqual({ ok: false, reason: 'stale' });
    expect(
      await serveChatDelegationRead(
        'blocks',
        blocks,
        failing(
          new CanopyOperationError({
            kind: 'capability_unavailable',
            message: 'Transcript block reads are unavailable.',
            retry: { kind: 'never' },
          }),
        ),
      ),
    ).toStrictEqual({ ok: false, reason: 'unavailable' });
    expect(
      await serveChatDelegationRead(
        'content',
        content,
        failing(new Error('ENOENT: /Users/someone/.canopy/chat.jsonl')),
      ),
    ).toStrictEqual({ ok: false, reason: 'failed' });
  });

  it('serves pending clones, quotas and the owner lookup to browsers only (CAN-7433)', async () => {
    const ownerLookup = IPC_CHANNELS.orgProjectsFindRepositoryOwner;
    const remoteUrl = { remoteUrl: 'https://github.com/acme/app.git' };
    // Each new browser invoke, with the arguments the portable adapter sends.
    const invoked: readonly (readonly [string, readonly unknown[]])[] = [
      [IPC_CHANNELS.cloneJobsList, []],
      [IPC_CHANNELS.cloneJobsCancel, ['job-1']],
      [IPC_CHANNELS.cloneJobsDismiss, ['job-1']],
      [IPC_CHANNELS.providerUsageLoad, []],
      [IPC_CHANNELS.providerUsageRefresh, [{ provider: 'claude' }]],
      [ownerLookup, [remoteUrl]],
    ];
    for (const [channel] of invoked) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    expect(BROWSER_CONTROLLER_CHANNELS).toContain(
      IPC_CHANNELS.cloneJobsChanged,
    );
    // Mobile already lists and receives clone jobs; nothing else here.
    const mobileRefused = [
      IPC_CHANNELS.cloneJobsCancel,
      IPC_CHANNELS.cloneJobsDismiss,
      ownerLookup,
      IPC_CHANNELS.providerUsageLoad,
      IPC_CHANNELS.providerUsageRefresh,
    ];
    const browserRefused = [
      IPC_CHANNELS.cloneJobsBackground,
      IPC_CHANNELS.observabilityLoadSnapshot,
      IPC_CHANNELS.observabilityRefreshUsage,
    ];
    for (const channel of browserRefused)
      expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(channel);

    const invokeWith = async (
      rpc: RpcPeer,
      channel: string,
      args: readonly unknown[],
    ): Promise<string> => {
      try {
        await rpc.request(REMOTE_METHODS.invoke, { channel, args });
        return 'ok';
      } catch (error) {
        return error instanceof RpcRemoteError
          ? (error.code ?? error.message)
          : 'failed';
      }
    };
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
        ],
      },
    });
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of mobileRefused)
      expect(await invokeWith(fromPhone.rpc, channel, [remoteUrl])).toBe(
        'remote_channel_unavailable',
      );
    expect(host.bridge.invokes).toEqual([]);

    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const [channel, args] of invoked)
      expect([
        channel,
        await invokeWith(fromBrowser.rpc, channel, args),
      ]).toEqual([channel, 'ok']);
    for (const channel of browserRefused)
      expect(await invokeWith(fromBrowser.rpc, channel, [])).toBe(
        'remote_channel_unavailable',
      );
    // The owner lookup takes exactly `{ remoteUrl }` from a browser: never
    // a host path, and nothing beside or instead of the URL.
    const refusedLookups: readonly (readonly unknown[])[] = [
      [{ path: '/Users/someone/code/app' }],
      [{ path: '/Users/someone/code/app', ...remoteUrl }],
      [{ ...remoteUrl, extra: true }],
      [remoteUrl, remoteUrl],
      [],
      [{ remoteUrl: 42 }],
      [{ remoteUrl: '' }],
      [{ remoteUrl: '   ' }],
      [{ remoteUrl: `https://github.com/${'a'.repeat(2048)}` }],
      ['https://github.com/acme/app.git'],
    ];
    for (const args of refusedLookups)
      expect(await invokeWith(fromBrowser.rpc, ownerLookup, args)).toBe(
        'remote_channel_unavailable',
      );
    expect(host.bridge.invokes).toEqual(invoked.map(([channel]) => channel));
  });

  it('serves browsers recovery on discard and deletion only in the adapter shapes, never narrowing a desktop (CAN-7443, CAN-7444)', async () => {
    const describe = IPC_CHANNELS.worktreeDiscardDescribe;
    const deletes = [IPC_CHANNELS.workspaceDelete, IPC_CHANNELS.projectDelete];
    const target = { projectId: 'project-1', worktreeId: 'worktree-1' };
    const operationId = '00000000-0000-4000-8000-000000007444';
    const recovery = {
      intent: 'delete',
      expectedCreatedAt: '2026-11-21T00:00:00.000Z',
    };
    const pendingEntry = { operationId, confirmation: 'b'.repeat(64) };
    // A recovery request is checked key for key; the handler's own schema
    // strips unknown keys instead of refusing them.
    const badRecoveries: readonly unknown[] = [
      undefined,
      null,
      false,
      [recovery],
      'recovery',
      { ...recovery, extra: true },
      { expectedCreatedAt: '2026-11-21T00:00:00.000Z' },
      { ...recovery, intent: 'discard' },
      { ...recovery, intent: undefined },
      { intent: 'archive' },
      { ...recovery, expectedCreatedAt: '' },
      { ...recovery, expectedCreatedAt: 1 },
      { ...recovery, operationId: 'op-1' },
      { ...recovery, operationId: undefined },
      { operationId },
    ];
    const badPending: readonly unknown[] = [
      undefined,
      null,
      false,
      pendingEntry,
      'pending',
      Array.from(
        { length: BROWSER_PENDING_RECOVERY_MAX_ENTRIES + 1 },
        () => pendingEntry,
      ),
      [{ ...pendingEntry, extra: true }],
      [{ operationId }],
      [{ confirmation: pendingEntry.confirmation }],
      [{ ...pendingEntry, operationId: '' }],
      [{ ...pendingEntry, confirmation: '' }],
      [{ ...pendingEntry, confirmation: 1 }],
      [
        {
          ...pendingEntry,
          confirmation: 'c'.repeat(
            BROWSER_PENDING_RECOVERY_FIELD_MAX_LENGTH + 1,
          ),
        },
      ],
      [null],
    ];
    const refused: readonly (readonly [string, readonly unknown[]])[] = [
      ...badRecoveries.map(
        (bad) => [describe, [{ ...target, recovery: bad }]] as const,
      ),
      // Only the first argument may carry it.
      [describe, [target, { recovery }]],
      [describe, [{ ...target, recovery }, { recovery }]],
      ...deletes.flatMap((channel) => [
        ...badPending.map(
          (pending) =>
            [
              channel,
              [{ workspaceId: 'workspace-1', discardPendingRecovery: pending }],
            ] as const,
        ),
        [
          channel,
          [{ projectId: 'project-1' }, { discardPendingRecovery: [] }],
        ] as const,
        [
          channel,
          [
            { projectId: 'project-1', discardPendingRecovery: [pendingEntry] },
            { discardPendingRecovery: [pendingEntry] },
          ],
        ] as const,
      ]),
    ];
    // What the adapter sends, and shapes the first-argument key check passes:
    // the handler reads only the first argument's own keys.
    const served: readonly (readonly [string, readonly unknown[]])[] = [
      [describe, [{ ...target, recovery }]],
      [describe, [{ ...target, recovery: { ...recovery, operationId } }]],
      [
        describe,
        [
          {
            ...target,
            recovery: { intent: 'archive', expectedCreatedAt: null },
          },
        ],
      ],
      ...deletes.flatMap((channel) => [
        [
          channel,
          [
            {
              workspaceId: 'workspace-1',
              discardPendingRecovery: [pendingEntry],
            },
          ],
        ] as const,
        // An empty list confirms no pending recovery; the computer refuses
        // it when any is pending.
        [
          channel,
          [{ workspaceId: 'workspace-1', discardPendingRecovery: [] }],
        ] as const,
        [
          channel,
          [
            {
              projectId: 'project-1',
              supersedeInterruptedDeletion: 'op-1',
              discardPendingRecovery: Array.from(
                { length: BROWSER_PENDING_RECOVERY_MAX_ENTRIES },
                () => pendingEntry,
              ),
            },
          ],
        ] as const,
      ]),
      [describe, [target]],
      [describe, [{ ...target, retainedArchives: true }]],
      [describe, [{ ...target, nested: { recovery: true } }]],
      [describe, [null]],
      [describe, [['recovery']]],
      [describe, ['recovery']],
      [describe, []],
      [IPC_CHANNELS.workspaceDelete, [{ workspaceId: 'workspace-1' }]],
      [IPC_CHANNELS.projectDelete, [{ projectId: 'project-1' }]],
      [
        IPC_CHANNELS.workspaceDelete,
        [{ workspaceId: 'workspace-1', supersedeInterruptedDeletion: 'op-1' }],
      ],
      [
        IPC_CHANNELS.projectDelete,
        [{ projectId: 'project-1', supersedeInterruptedDeletion: 'op-1' }],
      ],
      [IPC_CHANNELS.projectDelete, [null]],
      [IPC_CHANNELS.workspaceDelete, []],
      [
        IPC_CHANNELS.workspaceDeleteDiscardDescribe,
        [{ workspaceId: 'workspace-1', retainedArchives: true }],
      ],
    ];
    for (const [channel, args] of refused)
      expect([channel, browserInvocationAllowed(channel, args)]).toEqual([
        channel,
        false,
      ]);
    for (const [channel, args] of served)
      expect([channel, browserInvocationAllowed(channel, args)]).toEqual([
        channel,
        true,
      ]);
    expect(browserWorktreeDiscardDescribeAllowed([{ recovery: 1 }])).toBe(
      false,
    );
    expect(browserWorktreeDiscardDescribeAllowed([{ recovery }])).toBe(true);
    expect(browserWorkspaceDeleteAllowed([{ discardPendingRecovery: 1 }])).toBe(
      false,
    );
    expect(
      browserWorkspaceDeleteAllowed([
        { discardPendingRecovery: [pendingEntry] },
      ]),
    ).toBe(true);

    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [pinned(browser, 'browser'), pinned(desktop)],
      },
    });
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const [channel, args] of refused)
      expect([
        channel,
        await invokeCodeWith(fromBrowser.rpc, channel, [...args]),
      ]).toEqual([channel, 'remote_channel_unavailable']);
    expect(host.bridge.invokes).toEqual([]);
    for (const [channel, args] of served)
      expect([
        channel,
        await invokeCodeWith(fromBrowser.rpc, channel, [...args]),
      ]).toEqual([channel, 'ok']);
    expect(host.bridge.invokes).toEqual(served.map(([channel]) => channel));

    // A desktop controller keeps the local recovery arguments.
    const fromDesktop = await control(host, desktop);
    await hello(fromDesktop.rpc);
    const desktopArgs: readonly (readonly [string, unknown[]])[] = [
      [describe, [{ ...target, recovery: { operationId: 'op-1' } }]],
      [
        IPC_CHANNELS.workspaceDelete,
        [{ workspaceId: 'workspace-1', discardPendingRecovery: [] }],
      ],
      [
        IPC_CHANNELS.projectDelete,
        [{ projectId: 'project-1', discardPendingRecovery: [] }],
      ],
    ];
    for (const [channel, args] of desktopArgs)
      expect([
        channel,
        await invokeCodeWith(fromDesktop.rpc, channel, args),
      ]).toEqual([channel, 'ok']);
  });

  it('blanks clone destinations for browsers only (CAN-7433)', async () => {
    // The `CloneJobSnapshot` wire shape: a running job carries `error: null`.
    const job = {
      id: 'job-1',
      repoName: 'app',
      remoteUrl: 'https://token@github.com/acme/app.git',
      destinationPath: '/Users/someone/code/app',
      status: 'running',
      phase: 'receiving',
      phasePercent: 40,
      percent: 35,
      processedCount: 400,
      totalCount: 1000,
      received: '12.34 MiB',
      throughput: '3.21 MiB/s',
      startedAt: 1_700_000_000_000,
      background: true,
      cancellable: true,
      workspaceId: null,
      workspaceName: null,
      error: null,
    };
    // A Cancel whose cleanup fails names the folder in `error`.
    const cleanupFailed = {
      ...job,
      id: 'job-2',
      status: 'failed',
      error:
        "Couldn't remove the incomplete clone at /Users/someone/code/app. Remove it manually.",
    };
    // Free text outside the safe clone messages never reaches a browser.
    const unknownFailure = {
      ...job,
      id: 'job-3',
      status: 'failed',
      error: "fatal: could not create work tree dir '/Users/someone/code/'",
    };
    const jobs = [job, cleanupFailed, unknownFailure];
    const forController = jobs.map((entry) => ({
      ...entry,
      remoteUrl: '',
    }));
    // A browser receives only the snapshot's known fields, so a field this
    // build does not know (here `hostOnly`) is never sent to one.
    const hostJobs = jobs.map((entry) => ({
      ...entry,
      hostOnly: '/Users/someone/code/app',
    }));
    for (const kind of ['browser', 'mobile'] as const) {
      const hub = new Hub();
      const controller = addController(hub, kind);
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller, kind)] },
        invokeResult: kind === 'browser' ? hostJobs : jobs,
      });
      const { rpc } = await control(host, controller);
      await hello(rpc, {
        version: VERSION,
        controller: { kind, minVersion: REMOTE_PROTOCOL_VERSION },
      });
      const expected =
        kind === 'browser'
          ? [
              { ...forController[0], destinationPath: null },
              {
                ...forController[1],
                destinationPath: null,
                error:
                  "Couldn't remove the incomplete clone. Remove it on the computer.",
              },
              {
                ...forController[2],
                destinationPath: null,
                error: REPOSITORY_CLONE_FAILURE_MESSAGE,
              },
            ]
          : forController;
      const listed = await rpc.request(REMOTE_METHODS.invoke, {
        channel: IPC_CHANNELS.cloneJobsList,
        args: [],
      });
      expect(listed).toEqual(expected);
      // The web client's own parser keeps every job a controller receives.
      expect(toPortableCloneJobs(listed)).toHaveLength(jobs.length);
      // A browser gets only the job list, never a trailing argument.
      host.mainPush(IPC_CHANNELS.cloneJobsChanged, [
        kind === 'browser' ? hostJobs : jobs,
        ...(kind === 'browser' ? ['/Users/someone/code/app'] : []),
      ]);
      await until(() => controller.pushPayloads.length > 0);
      expect(controller.pushPayloads).toEqual([
        { channel: IPC_CHANNELS.cloneJobsChanged, args: [expected] },
      ]);
      expect(job.destinationPath).toBe('/Users/someone/code/app');
    }
  });

  // Gap 1 of CAN-6718: a sign-in's text, exit and Codex code reach a
  // controller only through its own bridge (`ipc/auth-terminal.ts`,
  // `ipc/codex-login.ts`); main's copies for this computer's window are never
  // mirrored (`main-window-pushes.ts`). What a bridge forwards reaches its
  // controller whole, the device code included. A browser never receives the
  // Antigravity executable path, in a result or a progress push.
  it('forwards a bridge’s own sign-ins whole and keeps the Antigravity path from a browser (gap 1 of CAN-6718)', async () => {
    const runtimeWithoutPath = {
      supported: true,
      installed: true,
      managed: false,
      version: '1.5.1',
      phase: 'installed',
    };
    const runtime = {
      ...runtimeWithoutPath,
      executable: '/home/someone/.local/bin/agy',
    };
    const codex = {
      attemptId: 'attempt-own',
      phase: 'waiting',
      activeWorkCount: 0,
      method: 'chatgptDeviceCode',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
    };
    for (const kind of ['browser', 'desktop'] as const) {
      const hub = new Hub();
      const controller = addController(hub, kind);
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller, kind)] },
        invokeResult: runtime,
      });
      const { rpc } = await control(host, controller);
      await hello(rpc, {
        version: VERSION,
        controller: { kind, minVersion: REMOTE_PROTOCOL_VERSION },
      });
      const status = await rpc.request(REMOTE_METHODS.invoke, {
        channel: IPC_CHANNELS.antigravityRuntimeStatus,
        args: [],
      });
      expect(status).toEqual(kind === 'browser' ? runtimeWithoutPath : runtime);
      const pushes: readonly (readonly [string, unknown])[] = [
        [IPC_CHANNELS.authTerminalOutput, { sessionId: 'own', data: 'b' }],
        [
          IPC_CHANNELS.authTerminalExit,
          { sessionId: 'own', exitCode: 0, signal: null },
        ],
        [IPC_CHANNELS.codexLoginState, codex],
        [IPC_CHANNELS.antigravityRuntimeProgress, runtime],
      ];
      for (const [channel, payload] of pushes)
        host.bridge.emitPush(channel, [payload]);
      const expected = pushes.map(([channel, payload]) => ({
        channel,
        args: [
          kind === 'browser' && payload === runtime
            ? runtimeWithoutPath
            : payload,
        ],
        surface: 'main',
      }));
      await until(() => controller.pushPayloads.length >= expected.length);
      expect(controller.pushPayloads).toEqual(expected);
    }
    // Main's copies of setup progress for this computer's window stay off
    // the mirror too: Copilot's carries its device code.
    for (const channel of [
      IPC_CHANNELS.authTerminalOutput,
      IPC_CHANNELS.authTerminalExit,
      IPC_CHANNELS.codexLoginState,
      IPC_CHANNELS.antigravityRuntimeProgress,
      IPC_CHANNELS.copilotConnectionProgress,
    ])
      expect([channel, isMirrored(channel)]).toEqual([channel, false]);
  });

  // CAN-6718 review: sign-in text a browser receives names no host folder.
  // A raw error a sign-in prints (Antigravity's, creating its folder) can
  // quote the app's data folder; a desktop controller gets the text as is.
  it('keeps host folders out of the sign-in text a browser receives', async () => {
    const dataDir = getCanopyDataDir();
    const raw = `EACCES: permission denied, mkdir '${dataDir}/antigravity/login'\r\n`;
    for (const kind of ['browser', 'desktop'] as const) {
      const hub = new Hub();
      const controller = addController(hub, kind);
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller, kind)] },
      });
      const { rpc } = await control(host, controller);
      await hello(rpc, {
        version: VERSION,
        controller: { kind, minVersion: REMOTE_PROTOCOL_VERSION },
      });
      host.bridge.emitPush(IPC_CHANNELS.authTerminalOutput, [
        { sessionId: 'own', data: raw },
      ]);
      await until(() => controller.pushPayloads.length >= 1);
      expect(controller.pushPayloads).toEqual([
        {
          channel: IPC_CHANNELS.authTerminalOutput,
          args: [
            {
              sessionId: 'own',
              data:
                kind === 'browser'
                  ? "EACCES: permission denied, mkdir 'the app's data folder/antigravity/login'\r\n"
                  : raw,
            },
          ],
          surface: 'main',
        },
      ]);
    }
  });

  // CAN-6718 review: a host folder split across two output events is still
  // named generically, and text held back at the end of one event reaches
  // the browser with the next one or before the exit.
  it('scrubs a host folder split across sign-in output events', async () => {
    const dataDir = getCanopyDataDir();
    const cut = Math.floor(dataDir.length / 2);
    const hub = new Hub();
    const controller = addController(hub, 'browser');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(controller, 'browser')] },
    });
    const { rpc } = await control(host, controller);
    await hello(rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    const chunks = [
      `failed: '${dataDir.slice(0, cut)}`,
      `${dataDir.slice(cut)}/login'\r\nnext `,
      `${dataDir.slice(0, cut)}`,
    ];
    for (const data of chunks)
      host.bridge.emitPush(IPC_CHANNELS.authTerminalOutput, [
        { sessionId: 'own', data },
      ]);
    host.bridge.emitPush(IPC_CHANNELS.authTerminalExit, [
      { sessionId: 'own', exitCode: 1, signal: null },
    ]);
    await until(() =>
      controller.pushPayloads
        .map(signInPushOf)
        .some((push) => push.channel === IPC_CHANNELS.authTerminalExit),
    );
    const pushes = controller.pushPayloads.map(signInPushOf);
    const outputs = pushes.filter(
      (push) => push.channel === IPC_CHANNELS.authTerminalOutput,
    );
    const text = outputs.map((push) => push.data ?? '').join('');
    expect(text).toBe(
      `failed: 'the app's data folder/login'\r\nnext ${scrubHostPaths(dataDir.slice(0, cut))}`,
    );
    for (const push of outputs)
      expect(push.data ?? '').not.toContain(dataDir.slice(0, cut + 1));
    expect(pushes.at(-1)?.channel).toBe(IPC_CHANNELS.authTerminalExit);
  });

  // CAN-6718 review: a host folder whose own tail begins a folder prefix
  // (a home folder at /home/home) is never cut in two by the held tail.
  it('never cuts a host folder in two when holding sign-in text back', async () => {
    const home = jest.spyOn(os, 'homedir').mockReturnValue('/home/home');
    try {
      const hub = new Hub();
      const controller = addController(hub, 'browser');
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller, 'browser')] },
      });
      const { rpc } = await control(host, controller);
      await hello(rpc, {
        version: VERSION,
        controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
      });
      for (const data of ['open /home/home/h', 'istory\r\n'])
        host.bridge.emitPush(IPC_CHANNELS.authTerminalOutput, [
          { sessionId: 'own', data },
        ]);
      host.bridge.emitPush(IPC_CHANNELS.authTerminalExit, [
        { sessionId: 'own', exitCode: 0, signal: null },
      ]);
      await until(() =>
        controller.pushPayloads
          .map(signInPushOf)
          .some((push) => push.channel === IPC_CHANNELS.authTerminalExit),
      );
      const text = controller.pushPayloads
        .map(signInPushOf)
        .filter((push) => push.channel === IPC_CHANNELS.authTerminalOutput)
        .map((push) => push.data ?? '')
        .join('');
      expect(text).toBe('open ~/history\r\n');
    } finally {
      home.mockRestore();
    }
  });

  // CAN-6718 review W1: only harness setup's argument refusals carry their
  // own code; another browser policy keeps its documented refusal.
  it('refuses a browser harness setup value with its own code, other channels as before', async () => {
    const hub = new Hub();
    const controller = addController(hub, 'browser');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(controller, 'browser')] },
    });
    const { rpc } = await control(host, controller);
    await hello(rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    const codeOf = async (
      channel: string,
      args: readonly unknown[],
    ): Promise<unknown> =>
      rpc.request(REMOTE_METHODS.invoke, { channel, args }).then(
        () => 'served',
        (error: unknown) =>
          error instanceof RpcRemoteError ? error.code : 'failed',
      );
    expect(
      await codeOf(IPC_CHANNELS.authTerminalStart, [
        { provider: 'github', cols: 100, rows: 30 },
      ]),
    ).toBe(ARGUMENTS_REFUSED_CODE);
    expect(
      await codeOf(IPC_CHANNELS.codexLoginStart, [
        { confirmPause: false, method: 'chatgpt' },
      ]),
    ).toBe(ARGUMENTS_REFUSED_CODE);
    expect(await codeOf(IPC_CHANNELS.authTerminalResize, [{}])).toBe(
      CHANNEL_UNAVAILABLE_CODE,
    );
    expect(
      await codeOf(INSTALLED_ITEM_CHANNELS.LIST_STATUS, [{ unexpected: true }]),
    ).toBe(CHANNEL_UNAVAILABLE_CODE);
    expect(host.bridge.invokes).toEqual([]);
  });

  // CAN-6718 review S1: a finished Codex sign-in's account reaches a
  // browser without its opaque fingerprint or account kind, in pushes and in
  // the start, cancel and retry results; a desktop controller keeps them.
  it('sends a browser no Codex account fingerprint or kind', async () => {
    const account = {
      authenticated: true,
      accountLabel: 'person@example.com',
      accountEmail: 'person@example.com',
      detail: null,
      error: null,
      planType: 'plus',
      accountKind: 'subscription',
      authFingerprint: 'fp-0123456789',
    };
    const browserAccount = {
      authenticated: true,
      accountLabel: 'person@example.com',
      accountEmail: 'person@example.com',
      detail: null,
      error: null,
      planType: 'plus',
    };
    const complete = {
      attemptId: null,
      phase: 'complete',
      activeWorkCount: 0,
      outcome: 'success',
      account,
    };
    const browserComplete = { ...complete, account: browserAccount };
    for (const kind of ['browser', 'desktop'] as const) {
      const hub = new Hub();
      const controller = addController(hub, kind);
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller, kind)] },
        invokeResult: complete,
      });
      const { rpc } = await control(host, controller);
      await hello(rpc, {
        version: VERSION,
        controller: { kind, minVersion: REMOTE_PROTOCOL_VERSION },
      });
      const shown = kind === 'browser' ? browserComplete : complete;
      for (const [channel, args] of [
        [
          IPC_CHANNELS.codexLoginStart,
          [{ confirmPause: false, method: 'chatgptDeviceCode' }],
        ],
        [IPC_CHANNELS.codexLoginCancel, []],
        [IPC_CHANNELS.codexLoginRetryVerification, []],
      ] as const)
        expect([
          channel,
          await rpc.request(REMOTE_METHODS.invoke, { channel, args }),
        ]).toEqual([channel, shown]);
      host.mainPush(IPC_CHANNELS.codexLoginState, [complete]);
      await until(() => controller.pushPayloads.length >= 1);
      expect(controller.pushPayloads).toEqual([
        { channel: IPC_CHANNELS.codexLoginState, args: [shown] },
      ]);
    }
  });

  // Gap 1 of CAN-6718: Claude's and Codex's sign-in status reach a browser
  // without the opaque account-change fingerprint or the account kind, as
  // Codex login states do; a desktop controller keeps both.
  it('sends a browser no auth status fingerprint or account kind', async () => {
    const status = {
      authenticated: true,
      accountLabel: 'person@example.com',
      accountEmail: 'person@example.com',
      detail: 'plus',
      error: null,
      planType: 'plus',
      workspaceName: null,
      accountKind: 'subscription',
      authFingerprint: 'auth:subscription:person@example.com',
    };
    const browserStatus = {
      authenticated: true,
      accountLabel: 'person@example.com',
      accountEmail: 'person@example.com',
      detail: 'plus',
      error: null,
      planType: 'plus',
      workspaceName: null,
    };
    for (const kind of ['browser', 'desktop'] as const) {
      const hub = new Hub();
      const controller = addController(hub, kind);
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller, kind)] },
        invokeResult: status,
      });
      const { rpc } = await control(host, controller);
      await hello(rpc, {
        version: VERSION,
        controller: { kind, minVersion: REMOTE_PROTOCOL_VERSION },
      });
      for (const channel of [
        IPC_CHANNELS.settingsClaudeAuthStatus,
        IPC_CHANNELS.settingsCodexAuthStatus,
      ])
        expect([
          channel,
          await rpc.request(REMOTE_METHODS.invoke, { channel, args: [] }),
        ]).toEqual([channel, kind === 'browser' ? browserStatus : status]);
    }
  });

  // CAN-6718 review S3: errors a browser receives from harness setup never
  // quote this computer's folders. An install failure becomes a fixed
  // sentence, and every other error has the home folder and the app's data
  // folders named generically. A desktop controller still gets the raw text.
  it('keeps host paths out of the harness setup errors a browser receives', async () => {
    const home = homedir();
    const dataDir = getCanopyDataDir();
    const rawInstall = `ENOSPC: no space left on device, open '${dataDir}/runtimes/antigravity/.install-AbC123/runtime.tgz'`;
    const runtime = (error: string): unknown => ({
      supported: true,
      installed: false,
      managed: false,
      version: '1.5.1',
      phase: 'failed',
      error,
    });
    const invokeResultFor = (channel: string): unknown => {
      if (channel === IPC_CHANNELS.antigravityRuntimeInstall)
        return runtime(rawInstall);
      return runtime('Antigravity CLI download failed. Try connecting again.');
    };
    const invokeRejectFor = (channel: string): Error | undefined => {
      if (channel === IPC_CHANNELS.cursorConnectionConnect)
        return new RpcPublicError(
          `EACCES: permission denied, open '${dataDir}/cursor/x'`,
        );
      if (channel === IPC_CHANNELS.opencodeConnectionConnect)
        return new RpcPublicError(
          `EACCES: permission denied, open '${home}/x'`,
        );
      return undefined;
    };
    for (const kind of ['browser', 'desktop'] as const) {
      const browser = kind === 'browser';
      const hub = new Hub();
      const controller = addController(hub, kind);
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller, kind)] },
        invokeResultFor,
        invokeRejectFor,
      });
      const { rpc } = await control(host, controller);
      await hello(rpc, {
        version: VERSION,
        controller: { kind, minVersion: REMOTE_PROTOCOL_VERSION },
      });
      const invoke = (channel: string, args: unknown[]): Promise<unknown> =>
        rpc.request(REMOTE_METHODS.invoke, { channel, args });
      expect(
        await invoke(IPC_CHANNELS.antigravityRuntimeInstall, [
          '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
        ]),
      ).toEqual(
        runtime(
          browser ? 'Antigravity CLI install failed. Try again.' : rawInstall,
        ),
      );
      expect(await invoke(IPC_CHANNELS.antigravityRuntimeStatus, [])).toEqual(
        runtime('Antigravity CLI download failed. Try connecting again.'),
      );
      await expect(
        invoke(IPC_CHANNELS.cursorConnectionConnect, [{ signInLink: true }]),
      ).rejects.toMatchObject({
        message: browser
          ? "EACCES: permission denied, open 'the app's data folder/cursor/x'"
          : `EACCES: permission denied, open '${dataDir}/cursor/x'`,
      });
      await expect(
        invoke(IPC_CHANNELS.opencodeConnectionConnect, []),
      ).rejects.toMatchObject({
        message: browser
          ? "EACCES: permission denied, open '~/x'"
          : `EACCES: permission denied, open '${home}/x'`,
      });
      host.mainPush(IPC_CHANNELS.antigravityRuntimeProgress, [
        runtime(rawInstall),
      ]);
      await until(() => controller.pushPayloads.length >= 1);
      expect(controller.pushPayloads).toEqual([
        {
          channel: IPC_CHANNELS.antigravityRuntimeProgress,
          args: [
            browser
              ? runtime('Antigravity CLI install failed. Try again.')
              : runtime(rawInstall),
          ],
        },
      ]);
    }
  });

  it('serves installed items and plugin installs to browsers only, with the arguments the adapter sends (CAN-7442)', async () => {
    const target = {
      kind: 'plugin',
      marketplaceId: 'acme',
      pluginName: 'lint',
    };
    const invoked: readonly (readonly [string, readonly unknown[]])[] = [
      [INSTALLED_ITEM_CHANNELS.LIST_STATUS, []],
      [INSTALLED_ITEM_CHANNELS.SET_STATUS, [{ target, status: 'disabled' }]],
      [INSTALLED_ITEM_CHANNELS.UNINSTALL, [{ target }]],
      [PLUGINS_CHANNELS.INSTALL_PLUGIN, ['acme', 'lint', '']],
      [
        PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
        [
          {
            marketplaceId: 'curated/cloud',
            pluginName: 'notes',
            providers: ['claude', 'codex'],
          },
        ],
      ],
    ];
    for (const channel of [
      ...invoked.map(([channel]) => channel),
      INSTALLED_ITEM_CHANNELS.CHANGED,
    ]) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
    }
    // No URL, marketplace add, harness record or Codex compatibility.
    const browserRefused = [
      PLUGINS_CHANNELS.ADD,
      PLUGINS_CHANNELS.INSTALL_FOR_HARNESSES,
      PLUGINS_CHANNELS.RETRY_HARNESS_INSTALL,
      PLUGINS_CHANNELS.PREPARE_CODEX_COMPATIBILITY,
      PLUGINS_CHANNELS.SET_CODEX_COMPAT_DISABLED,
      PLUGINS_CHANNELS.READ_COMPONENT,
    ];
    for (const channel of browserRefused)
      expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(channel);

    const invokeWith = async (
      rpc: RpcPeer,
      channel: string,
      args: readonly unknown[],
    ): Promise<string> => {
      try {
        await rpc.request(REMOTE_METHODS.invoke, { channel, args });
        return 'ok';
      } catch (error) {
        return error instanceof RpcRemoteError
          ? (error.code ?? error.message)
          : 'failed';
      }
    };
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
        ],
      },
    });
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const [channel, args] of invoked)
      expect(await invokeWith(fromPhone.rpc, channel, args)).toBe(
        'remote_channel_unavailable',
      );
    expect(host.bridge.invokes).toEqual([]);

    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const [channel, args] of invoked)
      expect([
        channel,
        await invokeWith(fromBrowser.rpc, channel, args),
      ]).toEqual([channel, 'ok']);
    for (const channel of browserRefused)
      expect(await invokeWith(fromBrowser.rpc, channel, [])).toBe(
        'remote_channel_unavailable',
      );
    // A browser names no source URL and sends nothing beside the request.
    const refused: readonly (readonly [string, readonly unknown[]])[] = [
      [
        PLUGINS_CHANNELS.INSTALL_PLUGIN,
        ['acme', 'lint', 'https://github.com/acme/lint.git'],
      ],
      [PLUGINS_CHANNELS.INSTALL_PLUGIN, ['acme', 'lint', '  ']],
      [PLUGINS_CHANNELS.INSTALL_PLUGIN, ['acme', 'lint']],
      [
        PLUGINS_CHANNELS.INSTALL_PLUGIN,
        ['acme', 'lint', '', { disableRedirects: false }],
      ],
      [PLUGINS_CHANNELS.INSTALL_PLUGIN, ['', 'lint', '']],
      [PLUGINS_CHANNELS.INSTALL_PLUGIN, ['acme', 42, '']],
      [PLUGINS_CHANNELS.INSTALL_PLUGIN, ['acme', 'x'.repeat(257), '']],
      [
        PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
        [
          {
            marketplaceId: 'curated/cloud',
            pluginName: 'notes',
            providers: [],
          },
        ],
      ],
      [
        PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
        [
          {
            marketplaceId: 'curated/cloud',
            pluginName: 'notes',
            providers: ['claude', 'claude'],
          },
        ],
      ],
      [
        PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
        [
          {
            marketplaceId: 'curated/cloud',
            pluginName: 'notes',
            providers: ['cursor'],
          },
        ],
      ],
      [
        PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
        [
          {
            marketplaceId: 'curated/cloud',
            pluginName: 'notes',
            providers: ['claude'],
            sourceUrl: 'https://github.com/acme/notes.git',
          },
        ],
      ],
      [
        PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
        [
          {
            marketplaceId: 'curated/cloud',
            pluginName: 'notes',
            providers: ['claude'],
          },
          {},
        ],
      ],
      [INSTALLED_ITEM_CHANNELS.LIST_STATUS, [{}]],
      [INSTALLED_ITEM_CHANNELS.SET_STATUS, []],
      [INSTALLED_ITEM_CHANNELS.UNINSTALL, [{ target }, {}]],
    ];
    for (const [channel, args] of refused)
      expect([
        channel,
        await invokeWith(fromBrowser.rpc, channel, args),
      ]).toEqual([channel, 'remote_channel_unavailable']);
    expect(host.bridge.invokes).toEqual(invoked.map(([channel]) => channel));

    // The change notice reaches the browser.
    host.mainPush(INSTALLED_ITEM_CHANNELS.CHANGED, []);
    await until(() => browser.pushPayloads.length > 0);
    expect(browser.pushPayloads).toEqual([
      { channel: INSTALLED_ITEM_CHANNELS.CHANGED, args: [] },
    ]);
  });

  it('sends a browser only the path-free install and change results, and a desktop the full ones (CAN-7442)', async () => {
    const HOME = '/Users/someone';
    const hostPlugin = {
      name: 'lint',
      displayName: 'Lint',
      marketplaceId: 'acme',
      version: '1.0.0',
      sourcePath: `${HOME}/.claude/plugins/marketplaces/acme/lint`,
      cachePath: `${HOME}/.claude/plugins/cache/lint`,
      details: { readme: `${HOME}/README.md` },
      externalSource: { url: 'https://github.com/acme/lint.git' },
      harnessInstalls: { codex: { path: `${HOME}/.codex/plugins/lint` } },
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {
        claude: {
          provider: 'claude',
          mode: 'native',
          cachePath: `${HOME}/.claude/plugins/cache/lint`,
          installLocation: `${HOME}/.claude/plugins/lint`,
          sourcePath: `${HOME}/src/lint`,
        },
      },
      globalInstallStatus: {
        checkedAt: '2026-11-20T00:00:00.000Z',
        claude: {
          available: true,
          installed: true,
          enabled: true,
          installPath: `${HOME}/.claude/plugins/lint`,
          error: `EACCES ${HOME}/.claude`,
        },
      },
      cachedAt: '2026-11-20T00:00:00.000Z',
      // A field a newer host adds is never sent to a browser.
      hostOnly: `${HOME}/secret`,
    };
    const browserPlugin = {
      name: 'lint',
      displayName: 'Lint',
      marketplaceId: 'acme',
      version: '1.0.0',
      providerSupport: { claude: 'native', codex: 'none' },
      globalInstallStatus: {
        checkedAt: '2026-11-20T00:00:00.000Z',
        claude: { available: true, installed: true, enabled: true },
      },
      cachedAt: '2026-11-20T00:00:00.000Z',
    };
    const target = {
      kind: 'plugin',
      marketplaceId: 'acme',
      pluginName: 'lint',
    };
    const snapshot = {
      items: [
        {
          target,
          status: 'active',
          removable: true,
          uninstallTarget: target,
          notices: [],
        },
      ],
    };
    const replies: Record<string, unknown> = {
      [PLUGINS_CHANNELS.INSTALL_PLUGIN]: {
        success: true,
        data: hostPlugin,
        appError: { code: 'x', detail: HOME },
      },
      [PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN]: {
        success: true,
        data: {
          plugin: hostPlugin,
          providerOutcomes: {
            claude: { installed: true },
            codex: {
              installed: false,
              error: `codex: spawn ${HOME}/.local/bin/codex ENOENT`,
            },
          },
        },
      },
      [INSTALLED_ITEM_CHANNELS.LIST_STATUS]: snapshot,
      [INSTALLED_ITEM_CHANNELS.SET_STATUS]: {
        success: false,
        requestedStatus: 'disabled',
        snapshot,
        removed: [],
        errors: [
          {
            target,
            code: 'transition_failed',
            message: `Couldn't turn it off for Claude: EACCES ${HOME}/.claude/settings.json`,
            retryable: true,
          },
          {
            target,
            code: 'refresh_failed',
            message:
              'The change was saved, but the catalog could not be refreshed. Retry to reconcile its state.',
            retryable: true,
          },
        ],
      },
      [INSTALLED_ITEM_CHANNELS.UNINSTALL]: {
        success: true,
        snapshot: { items: [] },
        removed: [target],
        errors: [],
      },
    };
    const results = async (
      kind: 'browser' | 'desktop',
    ): Promise<Record<string, unknown>> => {
      const hub = new Hub();
      const controller = addController(hub, kind);
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller, kind)] },
        invokeResultFor: (channel) => replies[channel] ?? 'ok',
      });
      const { rpc } = await control(host, controller);
      await hello(rpc, {
        version: VERSION,
        controller: { kind, minVersion: REMOTE_PROTOCOL_VERSION },
      });
      const calls: readonly (readonly [string, readonly unknown[]])[] = [
        [PLUGINS_CHANNELS.INSTALL_PLUGIN, ['acme', 'lint', '']],
        [
          PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
          [
            {
              marketplaceId: 'acme',
              pluginName: 'lint',
              providers: ['claude', 'codex'],
            },
          ],
        ],
        [INSTALLED_ITEM_CHANNELS.LIST_STATUS, []],
        [INSTALLED_ITEM_CHANNELS.SET_STATUS, [{ target, status: 'disabled' }]],
        [INSTALLED_ITEM_CHANNELS.UNINSTALL, [{ target }]],
      ];
      const received: Record<string, unknown> = {};
      for (const [channel, args] of calls)
        received[channel] = await rpc.request(REMOTE_METHODS.invoke, {
          channel,
          args,
        });
      return received;
    };

    const browser = await results('browser');
    expect(JSON.stringify(browser)).not.toContain(HOME);
    expect(browser[PLUGINS_CHANNELS.INSTALL_PLUGIN]).toEqual({
      success: true,
      data: browserPlugin,
    });
    expect(browser[PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN]).toEqual({
      success: true,
      data: {
        plugin: browserPlugin,
        providerOutcomes: {
          claude: { installed: true },
          codex: {
            installed: false,
            error: REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE,
          },
        },
      },
    });
    // The web adapter's strict parsers accept every browser result.
    expect(
      RemotePluginInstallResultSchema.safeParse(
        browser[PLUGINS_CHANNELS.INSTALL_PLUGIN],
      ).success,
    ).toBe(true);
    expect(
      RemoteBuiltInPluginInstallResultSchema.safeParse(
        browser[PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN],
      ).success,
    ).toBe(true);
    expect(browser[INSTALLED_ITEM_CHANNELS.LIST_STATUS]).toEqual(snapshot);
    const changed = InstalledItemMutationResultSchema.parse(
      browser[INSTALLED_ITEM_CHANNELS.SET_STATUS],
    );
    expect(changed.errors.map((error) => error.message)).toEqual([
      "Couldn't change this item. Check the desktop app for details.",
      'The change was saved, but the catalog could not be refreshed. Retry to reconcile its state.',
    ]);
    expect(browser[INSTALLED_ITEM_CHANNELS.UNINSTALL]).toEqual(
      replies[INSTALLED_ITEM_CHANNELS.UNINSTALL],
    );

    // A desktop controller still receives the full result.
    const desktop = await results('desktop');
    expect(desktop[PLUGINS_CHANNELS.INSTALL_PLUGIN]).toEqual(
      replies[PLUGINS_CHANNELS.INSTALL_PLUGIN],
    );
    expect(desktop[INSTALLED_ITEM_CHANNELS.SET_STATUS]).toEqual(
      replies[INSTALLED_ITEM_CHANNELS.SET_STATUS],
    );
  });

  it('passes a browser only the fixed install messages (CAN-7442)', async () => {
    const failures: readonly (readonly [unknown, string])[] = [
      [PLUGIN_NOT_IN_MARKETPLACE_MESSAGE, PLUGIN_NOT_IN_MARKETPLACE_MESSAGE],
      [
        `${PLUGIN_NOT_IN_MARKETPLACE_MESSAGE} at /Users/someone/.claude`,
        REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE,
      ],
      [
        `${REMOTE_PLUGIN_SOURCE_REFUSAL} https://10.0.0.5/acme/lint.git resolves to a private address.`,
        REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE,
      ],
      [
        "fatal: could not create work tree dir '/Users/someone/.claude/plugins'",
        REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE,
      ],
      [undefined, REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE],
      [{ path: '/Users/someone' }, REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE],
    ];
    for (const [error, expected] of failures) {
      const hub = new Hub();
      const controller = addController(hub, 'browser');
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(controller, 'browser')] },
        invokeResultFor: (channel) =>
          channel === PLUGINS_CHANNELS.INSTALL_PLUGIN
            ? { success: false, error, appError: { detail: '/Users/someone' } }
            : {
                success: false,
                error,
                data: {
                  plugin: { name: 'notes', marketplaceId: 'curated/cloud' },
                  providerOutcomes: { claude: { installed: false, error } },
                },
              },
      });
      const { rpc } = await control(host, controller);
      await hello(rpc, {
        version: VERSION,
        controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
      });
      expect(
        await rpc.request(REMOTE_METHODS.invoke, {
          channel: PLUGINS_CHANNELS.INSTALL_PLUGIN,
          args: ['acme', 'lint', ''],
        }),
      ).toEqual({ success: false, error: expected });
      expect(
        await rpc.request(REMOTE_METHODS.invoke, {
          channel: PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
          args: [
            {
              marketplaceId: 'curated/cloud',
              pluginName: 'notes',
              providers: ['claude'],
            },
          ],
        }),
      ).toEqual({
        success: false,
        error: expected,
        data: {
          plugin: { name: 'notes', marketplaceId: 'curated/cloud' },
          // An absent provider error stays absent.
          providerOutcomes: {
            claude: {
              installed: false,
              ...(error === undefined ? {} : { error: expected }),
            },
          },
        },
      });
    }
    // A reply that is not an install result reaches a browser as the
    // generic failure.
    const hub = new Hub();
    const controller = addController(hub, 'browser');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(controller, 'browser')] },
      invokeResult: '/Users/someone/.claude/plugins/lint',
    });
    const { rpc } = await control(host, controller);
    await hello(rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    expect(
      await rpc.request(REMOTE_METHODS.invoke, {
        channel: PLUGINS_CHANNELS.INSTALL_PLUGIN,
        args: ['acme', 'lint', ''],
      }),
    ).toEqual({ success: false, error: REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE });
  });

  it('fails closed on clone job shapes it does not expect (CAN-7433)', async () => {
    // A job without a `destinationPath` key still has its free-text `error`
    // reduced to a safe clone message, and only job records reach a browser.
    const pathless = {
      id: 'job-1',
      repoName: 'app',
      status: 'failed',
      error: "fatal: could not create work tree dir '/Users/someone/code/'",
    };
    const expectedJobs = [
      {
        ...pathless,
        destinationPath: null,
        error: REPOSITORY_CLONE_FAILURE_MESSAGE,
      },
    ];
    const hub = new Hub();
    const controller = addController(hub, 'browser');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(controller, 'browser')] },
      invokeResult: [pathless, '/Users/someone/code/app', null, ['nested']],
    });
    const { rpc } = await control(host, controller);
    await hello(rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    expect(
      await rpc.request(REMOTE_METHODS.invoke, {
        channel: IPC_CHANNELS.cloneJobsList,
        args: [],
      }),
    ).toEqual(expectedJobs);
    // A push whose first argument is not the job list carries no jobs.
    host.mainPush(IPC_CHANNELS.cloneJobsChanged, [
      { destinationPath: '/Users/someone/code/app' },
    ]);
    host.mainPush(IPC_CHANNELS.cloneJobsChanged, [
      [
        pathless,
        42,
        // An `error` that is not text never reaches a browser.
        {
          id: 'job-2',
          status: 'failed',
          error: { path: '/Users/someone/code/app' },
        },
      ],
    ]);
    await until(() => controller.pushPayloads.length > 1);
    expect(controller.pushPayloads).toEqual([
      { channel: IPC_CHANNELS.cloneJobsChanged, args: [[]] },
      {
        channel: IPC_CHANNELS.cloneJobsChanged,
        args: [
          [
            ...expectedJobs,
            {
              id: 'job-2',
              status: 'failed',
              destinationPath: null,
              error: null,
            },
          ],
        ],
      },
    ]);
  });

  it('lists New Task base branches for browsers and agrees the exact base mode only with browsers that offer it (CAN-7437)', async () => {
    const branchTargets = IPC_CHANNELS.homeListBranchTargets;
    expect(branchTargets).toBe('home:list-branch-targets');
    expect(BROWSER_CONTROLLER_CHANNELS).toContain(branchTargets);
    expect(MOBILE_CONTROLLER_CHANNELS).toContain(branchTargets);
    // Hosted agents read it for task_create_ref_list (CAN-7445).
    expect(HOSTED_CONTROLLER_CHANNELS).toContain(branchTargets);
    // The browser profile offers the exact mode; the hosted agent does not.
    expect(webControllerProfile('browser', 'web').exactWorktreeBaseBranch).toBe(
      true,
    );
    expect(
      webControllerProfile('hosted', 'web').exactWorktreeBaseBranch,
    ).toBeUndefined();

    const hub = new Hub();
    const offering = addController(hub, 'browser');
    const silent = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const root = generateDeviceKeyPair();
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(offering, 'browser'),
          pinned(silent, 'browser'),
          pinned(phone, 'mobile'),
          {
            deviceId: root.deviceId,
            name: 'Agents',
            platform: 'linux',
            kind: 'hosted',
            publicKey: root.publicKey,
            pairedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
    const featuresOf = (answer: Record<string, unknown>): unknown =>
      HelloResultSchema.parse(answer).features?.exactWorktreeBaseBranch;
    const exactCreates: Array<[string, Record<string, unknown>]> = [
      [
        IPC_CHANNELS.worktreeCreate,
        { projectId: 'project', baseBranch: 'remote:main' },
      ],
      [
        IPC_CHANNELS.workspaceCreateWorktree,
        { workspaceId: 'project', baseBranch: 'local:feature' },
      ],
    ];
    const refused = 'Update both desktops to use this base branch.';

    // A browser that offers the mode gets it echoed, a bridge in exact
    // mode, and its exact bases forwarded unchanged.
    const fromOffering = await control(host, offering);
    expect(
      featuresOf(
        await hello(fromOffering.rpc, {
          version: VERSION,
          controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
          exactWorktreeBaseBranch: true,
        }),
      ),
    ).toBe(true);
    expect(
      await invokeCodeWith(fromOffering.rpc, branchTargets, [
        { workspaceId: 'project' },
      ]),
    ).toBe('ok');
    for (const [channel, request] of exactCreates) {
      expect(await invokeCodeWith(fromOffering.rpc, channel, [request])).toBe(
        'ok',
      );
    }
    expect(host.bridge.invokes).toEqual([
      branchTargets,
      ...exactCreates.map(([channel]) => channel),
    ]);
    expect(host.bridge.invokeArgs).toEqual([
      [{ workspaceId: 'project' }],
      ...exactCreates.map(([, request]) => [request]),
    ]);
    expect(host.bridge.created).toContainEqual({
      controllerDeviceId: offering.deviceId,
      exact: true,
    });
    // The other base-branch channels the mode affects stay off for browsers.
    for (const channel of [
      IPC_CHANNELS.worktreeListBranches,
      IPC_CHANNELS.worktreeCreateBranch,
      IPC_CHANNELS.preferencesLoad,
    ]) {
      expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(await invokeCode(fromOffering.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    }
    const servedToOffering = host.bridge.invokes.length;

    // A browser that does not offer it keeps the legacy mode: the catalogue
    // read is served, and an exact base is refused before the bridge.
    const fromSilent = await control(host, silent);
    expect(
      featuresOf(
        await hello(fromSilent.rpc, {
          version: VERSION,
          controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
        }),
      ),
    ).toBeUndefined();
    expect(
      await invokeCodeWith(fromSilent.rpc, branchTargets, [
        { workspaceId: 'project' },
      ]),
    ).toBe('ok');
    for (const [channel, request] of exactCreates) {
      expect(await invokeCodeWith(fromSilent.rpc, channel, [request])).toBe(
        refused,
      );
    }
    expect(host.bridge.invokes.slice(servedToOffering)).toEqual([
      branchTargets,
    ]);
    expect(host.bridge.created).toContainEqual({
      controllerDeviceId: silent.deviceId,
      exact: false,
    });
    const servedToBrowsers = host.bridge.invokes.length;

    // Mobile and hosted sessions that offer the mode are never agreed.
    const fromPhone = await control(host, phone);
    expect(
      featuresOf(
        await hello(fromPhone.rpc, {
          version: VERSION,
          controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
          exactWorktreeBaseBranch: true,
        }),
      ),
    ).toBeUndefined();
    expect(
      await invokeCodeWith(fromPhone.rpc, branchTargets, [
        { workspaceId: 'project' },
      ]),
    ).toBe('ok');
    const agent = addController(hub, 'hosted');
    const fromAgent = await control(
      host,
      agent,
      delegate(root, agent.identity.publicKey, Date.now() + 60_000),
    );
    expect(
      featuresOf(
        await hello(fromAgent.rpc, {
          version: VERSION,
          controller: { kind: 'hosted', minVersion: REMOTE_PROTOCOL_VERSION },
          exactWorktreeBaseBranch: true,
        }),
      ),
    ).toBeUndefined();
    // A hosted session reads the legacy catalogue, with exactly its
    // workspace argument (CAN-7445).
    expect(await invokeCode(fromAgent.rpc, branchTargets)).toBe(
      'remote_channel_unavailable',
    );
    expect(
      await invokeCodeWith(fromAgent.rpc, branchTargets, [
        { workspaceId: 'project', exact: true },
      ]),
    ).toBe('remote_channel_unavailable');
    expect(
      await invokeCodeWith(fromAgent.rpc, branchTargets, [
        { workspaceId: 'project' },
      ]),
    ).toBe('ok');
    expect(host.bridge.created).toContainEqual({
      controllerDeviceId: agent.deviceId,
      exact: false,
    });
    for (const rpc of [fromPhone.rpc, fromAgent.rpc]) {
      for (const [channel, request] of exactCreates) {
        expect(await invokeCodeWith(rpc, channel, [request])).toBe(refused);
      }
    }
    expect(host.bridge.invokes.slice(servedToBrowsers)).toEqual([
      branchTargets,
      branchTargets,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

// The service methods behind remote-control:open-pairing-window,
// remote-control:close-pairing-window and the remote-control:pairing-event
// push (api.remoteControl.openPairingWindow, closePairingWindow and
// onPairingEvent are pass-throughs to them).
describe('paired secret requests (U7)', () => {
  const CANARY = 'canary-3e9d1b7a-paired-secret';
  const requestId = '5b1f0f2e-4d8a-4c1e-9b3a-2f6d7e8c9a01';
  const provide = {
    action: 'provide',
    requestId,
    values: { NPM_TOKEN: CANARY },
    useHeld: [],
  };

  async function settleCode(rpc: RpcPeer, params: unknown): Promise<unknown> {
    try {
      return await rpc.request(REMOTE_METHODS.secretRequestSettle, params);
    } catch (error) {
      return error instanceof RpcRemoteError
        ? (error.code ?? error.message)
        : 'failed';
    }
  }

  it('serves browser and mobile people only, advertised in hello', async () => {
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const mobile = addController(hub, 'mobile');
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(mobile, 'mobile'),
          pinned(desktop),
        ],
      },
    });
    const fromBrowser = await control(host, browser);
    const browserHello = await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    expect(browserHello.features).toMatchObject({ secretRequestSettle: true });
    expect(await settleCode(fromBrowser.rpc, provide)).toEqual({
      accepted: true,
    });
    const fromMobile = await control(host, mobile);
    expect(
      (
        await hello(fromMobile.rpc, {
          version: VERSION,
          controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
        })
      ).features,
    ).toMatchObject({ secretRequestSettle: true });
    expect(
      await settleCode(fromMobile.rpc, {
        action: 'decline',
        requestId: '6c2a1f3e-5d8b-4c1e-9b3a-2f6d7e8c9a02',
      }),
    ).toEqual({ accepted: true });
    expect(host.secretAnswers).toEqual([
      {
        answer: { requestId, values: { NPM_TOKEN: CANARY }, useHeld: [] },
        from: 'browser',
      },
      {
        answer: { decline: '6c2a1f3e-5d8b-4c1e-9b3a-2f6d7e8c9a02' },
        from: 'mobile',
      },
    ]);
    // A desktop controller answers in its own window's form.
    const fromDesktop = await control(host, desktop);
    expect((await hello(fromDesktop.rpc)).features).not.toHaveProperty(
      'secretRequestSettle',
    );
    expect(await settleCode(fromDesktop.rpc, provide)).toBe(
      'remote_controller_refused',
    );
    // Never through the bridge, a channel, or a log.
    expect(host.bridge.invokes).toEqual([]);
    expect(JSON.stringify(host.bridge.invokeArgs)).not.toContain(CANARY);
    expect(host.logs.join('\n')).not.toContain(CANARY);
    expect(host.secretAnswers).toHaveLength(2);
  });

  it('refuses hosted agents and malformed answers without echoing a value', async () => {
    const hub = new Hub();
    const root = generateDeviceKeyPair();
    const browser = addController(hub, 'browser');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          {
            deviceId: root.deviceId,
            name: 'Agents',
            platform: 'linux',
            kind: 'hosted',
            publicKey: root.publicKey,
            pairedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
    const child = addController(hub, 'hosted');
    const hosted = await control(
      host,
      child,
      delegate(root, child.identity.publicKey, Date.now() + 60_000),
    );
    expect((await hello(hosted.rpc)).features).not.toHaveProperty(
      'secretRequestSettle',
    );
    expect(await settleCode(hosted.rpc, provide)).toBe(
      'remote_controller_refused',
    );
    const { rpc } = await control(host, browser);
    await hello(rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const params of [
      { ...provide, scope: 'project' },
      { ...provide, values: { 'not a name': CANARY } },
      { ...provide, requestId: 'not-a-uuid' },
      { ...provide, values: { NPM_TOKEN: '' } },
      CANARY,
    ]) {
      const answer = await settleCode(rpc, params);
      expect(answer).toEqual({
        accepted: false,
        error: 'Check the secrets and try again.',
      });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect(host.secretAnswers).toEqual([]);
  });

  it('settles once: a resent answer, or one sent again after a reconnect, is refused', async () => {
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(browser, 'browser')] },
    });
    const first = await control(host, browser);
    await hello(first.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    expect(await settleCode(first.rpc, provide)).toEqual({ accepted: true });
    // A controller that didn't ask for refusal reasons never gets one: older
    // web builds parse the result strictly.
    expect(await settleCode(first.rpc, provide)).toEqual({
      accepted: false,
      error: 'This request was already answered.',
    });
    // A new session has new keys; the request is still settled once.
    first.session.close('closed');
    const again = await control(host, browser);
    await hello(again.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
      secretRequestSettleReason: true,
    });
    expect(
      await settleCode(again.rpc, {
        ...provide,
        values: { NPM_TOKEN: 'another-value' },
      }),
    ).toEqual({
      accepted: false,
      error: 'This request was already answered.',
      reason: 'answered',
    });
    expect(host.secretAnswers).toHaveLength(1);
  });
});

describe('pairing', () => {
  it('pairs once per link without a prompt, saving the authenticated kind before answering', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const { link, expiresAt } = await host.service.openPairingWindow();
    expect(new URL(link).origin).toBe('https://app.example.test');
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    const secret = linkSecret(link);
    const browser = addController(hub, 'browser');
    const replay = addController(hub, 'browser');
    const first = await pairRequest(host, browser, proofFrom(secret));
    expect(first.approved).toBe(true);
    // Durable by the time the answer arrived.
    expect((await host.readSettings()).pairedControllers).toEqual([
      expect.objectContaining({ deviceId: browser.deviceId, kind: 'browser' }),
    ]);
    // Single use: the same secret never pairs again, and never prompts.
    const second = await pairRequest(host, replay, proofFrom(secret));
    expect(second.approved).toBe(false);
    expect(host.events.map((event) => event.type)).toEqual([
      'window-opened',
      'window-closed',
      'paired',
    ]);
    expect((await state(host)).pairingWindow).toBeNull();
  });

  it('identifies itself on a pairing session before a portable controller pairs there', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const { link } = await host.service.openPairingWindow();
    const browser = addController(hub, 'browser');
    const session = await browser.sessions.connect({
      peerDeviceId: host.identity.deviceId,
      purpose: 'pair',
      pinnedPeerPublicKey: null,
    });
    const rpc = rpcFor(browser, session);
    // Portable controllers check the host's features before sending a proof.
    const hello = HelloResultSchema.parse(
      await rpc.request(
        REMOTE_METHODS.hello,
        {
          version: {
            protocolVersion: REMOTE_PROTOCOL_VERSION,
            appVersion: '1.0.0',
          },
          controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
        },
        { timeoutMs: 5_000 },
      ),
    );
    expect(hello.features).toEqual(
      expect.objectContaining({ controllerProfiles: true, pairingProof: true }),
    );
    // A pairing session never serves anything beyond identity and pairing.
    await expect(
      rpc.request(
        REMOTE_METHODS.invoke,
        { channel: 'projects:load', args: [] },
        { timeoutMs: 5_000 },
      ),
    ).rejects.toThrow();
    const result: unknown = await rpc.request(
      REMOTE_METHODS.pairRequest,
      {
        name: 'Browser',
        platform: 'darwin',
        proof: proofFrom(linkSecret(link))(session),
      },
      { timeoutMs: 5_000 },
    );
    expect(result).toEqual(expect.objectContaining({ approved: true }));
  });

  it('serializes racing proofs so exactly one consumes the secret', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const secret = linkSecret((await host.service.openPairingWindow()).link);
    const racers = [1, 2, 3].map(() => addController(hub, 'mobile'));
    const results = await Promise.all(
      racers.map((racer) => pairRequest(host, racer, proofFrom(secret))),
    );
    expect(results.filter((result) => result.approved)).toHaveLength(1);
    expect((await host.readSettings()).pairedControllers).toHaveLength(1);
  });

  it('rejects invalid, expired, replaced and hosted proofs without falling back to a prompt', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {}, pairingWindowMs: 150 });
    const old = linkSecret((await host.service.openPairingWindow()).link);
    const current = linkSecret((await host.service.openPairingWindow()).link);
    expect(
      (await pairRequest(host, addController(hub, 'browser'), proofFrom(old)))
        .approved,
    ).toBe(false);
    expect(
      (
        await pairRequest(
          host,
          addController(hub, 'browser'),
          proofFrom(Buffer.alloc(32, 7)),
        )
      ).approved,
    ).toBe(false);
    // Hosted pairing always needs approval on this computer.
    expect(
      (
        await pairRequest(
          host,
          addController(hub, 'hosted'),
          proofFrom(current),
        )
      ).approved,
    ).toBe(false);
    await settle(200);
    expect(
      (
        await pairRequest(
          host,
          addController(hub, 'browser'),
          proofFrom(current),
        )
      ).approved,
    ).toBe(false);
    expect(host.events.some((event) => event.type === 'request')).toBe(false);
    expect(
      host.events.filter((event) => event.type === 'window-closed'),
    ).toEqual([
      { type: 'window-closed', reason: 'replaced' },
      { type: 'window-closed', reason: 'expired' },
    ]);
    // Closing the window explicitly spends its secret too.
    const closing = linkSecret((await host.service.openPairingWindow()).link);
    expect((await host.service.closePairingWindow()).pairingWindow).toBeNull();
    expect(
      (
        await pairRequest(
          host,
          addController(hub, 'mobile'),
          proofFrom(closing),
        )
      ).approved,
    ).toBe(false);
    expect(host.events.at(-1)).toEqual({
      type: 'window-closed',
      reason: 'closed',
    });
    expect((await host.readSettings()).pairedControllers).toEqual([]);
  });

  it('fails closed when the pin cannot be saved, spending the link', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const secret = linkSecret((await host.service.openPairingWindow()).link);
    host.store.failWrites = true;
    const phone = addController(hub, 'mobile');
    expect((await pairRequest(host, phone, proofFrom(secret))).approved).toBe(
      false,
    );
    host.store.failWrites = false;
    expect((await pairRequest(host, phone, proofFrom(secret))).approved).toBe(
      false,
    );
    expect((await host.readSettings()).pairedControllers).toEqual([]);
  });

  it('asks on this computer, with the authenticated kind, for hosted and proofless requests', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const agents = addController(hub, 'hosted');
    const pending = pairRequest(host, agents);
    await until(() => host.events.some((event) => event.type === 'request'));
    const request = host.events.find((event) => event.type === 'request');
    if (request?.type !== 'request') throw new Error('No request.');
    expect(request.pairing.kind).toBe('hosted');
    await host.service.respondToPairing({
      pairingId: request.pairing.pairingId,
      approve: true,
    });
    expect((await pending).approved).toBe(true);
    expect((await host.readSettings()).pairedControllers).toEqual([
      expect.objectContaining({ deviceId: agents.deviceId, kind: 'hosted' }),
    ]);
  });

  it('lets disabling or removal win over a pairing that is still saving', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const asking = addController(hub, 'desktop');
    const pending = pairRequest(host, asking);
    await until(() => host.events.some((event) => event.type === 'request'));
    const request = host.events.find((event) => event.type === 'request');
    if (request?.type !== 'request') throw new Error('No request.');
    let release = (): void => undefined;
    host.store.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await host.service.respondToPairing({
      pairingId: request.pairing.pairingId,
      approve: true,
    });
    const disabling = host.service.setAllowIncoming(false);
    host.store.gate = null;
    release();
    await disabling;
    expect((await pending).approved).toBe(false);
    expect((await host.readSettings()).pairedControllers).toEqual([]);

    // Removal racing a re-pairing of a device already pinned.
    await host.service.setAllowIncoming(true);
    const secret = linkSecret((await host.service.openPairingWindow()).link);
    const phone = addController(hub, 'mobile');
    await host.store.update((current) => ({
      ...current,
      pairedControllers: [pinned(phone, 'mobile')],
    }));
    host.store.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repairing = pairRequest(host, phone, proofFrom(secret));
    await until(() =>
      host.events.some(
        (event) =>
          event.type === 'window-closed' && event.reason === 'consumed',
      ),
    );
    const removing = host.service.forgetDevice({
      deviceId: phone.deviceId,
      role: 'controller',
    });
    host.store.gate = null;
    release();
    await removing;
    expect((await repairing).approved).toBe(false);
    expect((await host.readSettings()).pairedControllers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Connect Slack: the one expected hosted pairing (CAN-7606)
// ---------------------------------------------------------------------------

describe('expected hosted pairing (Connect Slack, CAN-7606)', () => {
  /** Answers the prompt a request raised, or fails when none came. */
  async function declinePrompt(host: Host): Promise<void> {
    await until(() => host.events.some((event) => event.type === 'request'));
    const request = host.events.find((event) => event.type === 'request');
    if (request?.type !== 'request') throw new Error('No request.');
    await host.service.respondToPairing({
      pairingId: request.pairing.pairingId,
      approve: false,
    });
  }

  it('pairs the armed hosted root once with no prompt, recorded as expected', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const root = addController(hub, 'hosted');
    expect(host.service.hasHostedController()).toBe(false);
    expect(host.service.armExpectedPairing(root.deviceId)).not.toBeNull();
    expect((await pairRequest(host, root)).approved).toBe(true);
    expect((await host.readSettings()).pairedControllers).toEqual([
      expect.objectContaining({ deviceId: root.deviceId, kind: 'hosted' }),
    ]);
    expect(host.service.hasHostedController()).toBe(true);
    // No prompt, no code: the request never reached `incoming`.
    expect(host.events.map((event) => event.type)).toEqual(['paired']);
    expect(host.events[0]).toEqual(
      expect.objectContaining({ method: 'expected', kind: 'hosted' }),
    );
    expect((await state(host)).incomingPairings).toEqual([]);
    expect(host.telemetry).toContainEqual({
      event: 'device_add',
      device_kind: 'hosted',
      pair_method: 'expected',
    });

    // Single use: the next request from the same root asks on this computer.
    const again = pairRequest(host, root);
    await declinePrompt(host);
    expect((await again).approved).toBe(false);
  });

  it('prompts as usual when nothing is armed, or the expectation expired or was cleared', async () => {
    const hub = new Hub();
    const host = await createHost(hub, {
      settings: {},
      expectedPairingMs: 100,
    });
    const root = addController(hub, 'hosted');

    const unarmed = pairRequest(host, root);
    await declinePrompt(host);
    expect((await unarmed).approved).toBe(false);

    host.service.armExpectedPairing(root.deviceId);
    await settle(150);
    host.events.length = 0;
    const expired = pairRequest(host, root);
    await declinePrompt(host);
    expect((await expired).approved).toBe(false);

    host.service.armExpectedPairing(root.deviceId)?.clear();
    host.events.length = 0;
    const cleared = pairRequest(host, root);
    await declinePrompt(host);
    expect((await cleared).approved).toBe(false);
    expect((await host.readSettings()).pairedControllers).toEqual([]);
  });

  it('prompts for another device or a kind other than hosted, and keeps the expectation for its own root', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const root = addController(hub, 'hosted');
    const otherRoot = addController(hub, 'hosted');
    host.service.armExpectedPairing(root.deviceId);

    // A different root device: prompted, and the expectation stays armed.
    const other = pairRequest(host, otherRoot);
    await declinePrompt(host);
    expect((await other).approved).toBe(false);
    expect((await pairRequest(host, root)).approved).toBe(true);

    // The bound device under any kind but authenticated hosted is prompted.
    for (const kind of ['browser', 'desktop', undefined] as const) {
      const sibling = new Hub();
      const local = await createHost(sibling, { settings: {} });
      const device = addController(sibling, kind);
      local.service.armExpectedPairing(device.deviceId);
      const pending = pairRequest(local, device);
      await declinePrompt(local);
      expect((await pending).approved).toBe(false);
      expect((await local.readSettings()).pairedControllers).toEqual([]);
    }
  });

  it('prompts when Allow incoming was turned off, and turning it off disarms', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const root = addController(hub, 'hosted');
    host.service.armExpectedPairing(root.deviceId);
    await host.service.setAllowIncoming(false);
    await host.service.setAllowIncoming(true);
    const pending = pairRequest(host, root);
    await declinePrompt(host);
    expect((await pending).approved).toBe(false);
    expect((await host.readSettings()).pairedControllers).toEqual([]);
  });

  it('never approves for an account other than the one it was armed under', async () => {
    const hub = new Hub();
    const account = { current: `account:${ACCOUNT_USER_ID}` as string | null };
    const host = await createHost(hub, { settings: {}, account });
    const root = addController(hub, 'hosted');
    host.service.armExpectedPairing(root.deviceId);
    // Another account, same relay connection still up for this request.
    account.current = 'account:other-user';
    const pending = pairRequest(host, root);
    await declinePrompt(host);
    expect((await pending).approved).toBe(false);

    // Signed out: nothing to arm under.
    account.current = null;
    expect(host.service.armExpectedPairing(root.deviceId)).toBeNull();
    expect((await host.readSettings()).pairedControllers).toEqual([]);
  });

  it('replaces an earlier expectation when armed again', async () => {
    const hub = new Hub();
    const host = await createHost(hub, { settings: {} });
    const first = addController(hub, 'hosted');
    const second = addController(hub, 'hosted');
    const stale = host.service.armExpectedPairing(first.deviceId);
    host.service.armExpectedPairing(second.deviceId);
    // Clearing the replaced handle leaves the newer expectation armed.
    stale?.clear();
    const firstTry = pairRequest(host, first);
    await declinePrompt(host);
    expect((await firstTry).approved).toBe(false);
    expect((await pairRequest(host, second)).approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hosted delegation
// ---------------------------------------------------------------------------

describe('hosted delegation', () => {
  async function hostedSetup(): Promise<{
    hub: Hub;
    host: Host;
    root: DeviceKeyPair;
    other: Controller;
  }> {
    const hub = new Hub();
    const root = generateDeviceKeyPair();
    const rootPin = {
      deviceId: root.deviceId,
      name: 'Agents',
      platform: 'linux' as const,
      kind: 'hosted' as const,
      publicKey: root.publicKey,
      pairedAt: new Date(0).toISOString(),
    };
    const other = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [rootPin, pinned(other)] },
    });
    return { hub, host, root, other };
  }

  it('attributes valid delegated sessions to the pinned root and refuses invalid delegations', async () => {
    const { hub, host, root } = await hostedSetup();
    const child = addController(hub, 'hosted');
    const valid = delegate(root, child.identity.publicKey, Date.now() + 60_000);
    const { rpc } = await control(host, child, valid);
    await hello(rpc);
    await until(async () =>
      (await state(host)).controllers.some(
        (controller) => controller.hostedSessions.length === 1,
      ),
    );
    const rootView = (await state(host)).controllers.find(
      (controller) => controller.deviceId === root.deviceId,
    );
    expect(rootView).toMatchObject({ kind: 'hosted', connected: true });
    expect(rootView?.hostedSessions[0]?.deviceId).toBe(child.deviceId);

    const now = Date.now();
    const stranger = generateDeviceKeyPair();
    const cases: Array<[DeviceKind, DeviceKeyPair, number]> = [
      // Signed by a key that is not pinned.
      ['hosted', stranger, now + 60_000],
      // Lasts longer than the maximum.
      ['hosted', root, now + HOSTED_DELEGATION_MAX_MS + 60_000],
      // Already expired.
      ['hosted', root, now - 1],
      // Presented by a device the relay does not authenticate as hosted.
      ['browser', root, now + 60_000],
    ];
    for (const [kind, signer, expiresAt] of cases) {
      const initiator = addController(hub, kind);
      await expect(
        control(
          host,
          initiator,
          delegate(signer, initiator.identity.publicKey, expiresAt),
        ),
      ).rejects.toThrow();
    }
    // A delegation for another session key.
    const thief = addController(hub, 'hosted');
    await expect(control(host, thief, valid)).rejects.toThrow();
  });

  async function delegatedSession(
    options: HostOptions = {},
    firstPartyClient?: 'slack',
  ): Promise<{
    host: Host;
    root: DeviceKeyPair;
    invoke: (channel: string, args: unknown[]) => Promise<string>;
    request: (channel: string, args: unknown[]) => Promise<unknown>;
    rpc: RpcPeer;
    child: Controller;
    session: SecureSession;
  }> {
    const hub = new Hub();
    const root = generateDeviceKeyPair();
    const host = await createHost(hub, {
      ...options,
      settings: {
        pairedControllers: [
          {
            deviceId: root.deviceId,
            name: 'Agents',
            platform: 'linux',
            kind: 'hosted',
            publicKey: root.publicKey,
            pairedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
    const child = addController(hub, 'hosted');
    const { rpc, session } = await control(
      host,
      child,
      delegate(
        root,
        child.identity.publicKey,
        Date.now() + 60_000,
        firstPartyClient,
      ),
    );
    await hello(rpc);
    const request = (channel: string, args: unknown[]): Promise<unknown> =>
      rpc.request(REMOTE_METHODS.invoke, { channel, args });
    const invoke = async (
      channel: string,
      args: unknown[],
    ): Promise<string> => {
      try {
        await request(channel, args);
        return 'ok';
      } catch (error) {
        return error instanceof RpcRemoteError
          ? (error.code ?? error.message)
          : 'failed';
      }
    };
    return { host, root, invoke, request, rpc, child, session };
  }

  const envelope = (
    command: Record<string, unknown>,
  ): Record<string, unknown> => ({
    schemaVersion: 1,
    commandId: 'command-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    command,
  });
  const send = {
    type: 'chat.send_message',
    chatId: 'chat-1',
    userMessageId: 'message-1',
    text: 'Run the tests',
  };
  const answer = {
    type: 'chat.answer_question',
    chatId: 'chat-1',
    questionId: 'question-1',
    answers: [{ question: 'Which branch?', selectedOptions: ['main'] }],
  };

  it("refuses to commit a desktop controller's send that is in flight when its pairing is removed (CAN-7872)", async () => {
    const hub = new Hub();
    const desktop = addController(hub, 'desktop');
    const other = addController(hub, 'desktop');
    let release = (): void => undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    // What the replayed send's commit check says when it would commit.
    const atCommit: boolean[] = [];
    const host: Host = await createHost(hub, {
      settings: { pairedControllers: [pinned(desktop), pinned(other)] },
      invokeResultFor: (channel) =>
        channel === IPC_CHANNELS.chatCommand
          ? inFlight.then(() => {
              atCommit.push(host.bridge.commitGuards[0]?.() === true);
              return 'ok';
            })
          : 'ok',
    });
    const sender = await control(host, desktop);
    await hello(sender.rpc);
    const bystander = await control(host, other);
    await hello(bystander.rpc);
    const sending = sender.rpc
      .request(REMOTE_METHODS.invoke, {
        channel: IPC_CHANNELS.chatCommand,
        args: [envelope(send)],
      })
      .catch(() => 'ended');
    await until(() => host.bridge.invokes.includes(IPC_CHANNELS.chatCommand));
    expect(await invokeCode(bystander.rpc, IPC_CHANNELS.chatGetState)).toBe(
      'ok',
    );
    const [guard, bystanderGuard] = host.bridge.commitGuards;
    // Separate-window desktop sessions keep the full Stop (CAN-7854).
    expect(host.bridge.oneWindowFlags).toEqual([false, false]);
    expect(guard?.()).toBe(true);
    // The pairing goes while the send is still being prepared.
    await host.service.forgetDevice({
      deviceId: desktop.deviceId,
      role: 'controller',
    });
    release();
    await until(() => atCommit.length > 0);
    expect(atCommit).toEqual([false]);
    expect(guard?.()).toBe(false);
    // Another computer's pairing is untouched.
    expect(bystanderGuard?.()).toBe(true);
    await sending;
  });

  it("refuses to commit a hosted controller's send that is in flight when its pairing is removed (CAN-7872)", async () => {
    let release = (): void => undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, root, request } = await delegatedSession({
      hostedDispatchGate: inFlight,
    });
    host.hostedChat.tabs.set('chat-1', DEFAULT_MODEL);
    const sending = request('chat:command', [envelope(send)]).catch(
      () => 'ended',
    );
    await until(() => host.hostedChat.dispatched.length > 0);
    const canCommit = host.hostedChat.dispatched[0]?.attribution.canCommit;
    expect(canCommit?.()).toBe(true);
    await host.service.forgetDevice({
      deviceId: root.deviceId,
      role: 'controller',
    });
    // The dispatch still running is told its session lost its pairing, so
    // the send and any new chat it makes are refused before they commit.
    expect(canCommit?.()).toBe(false);
    release();
    await sending;
  });

  it("gives a hosted controller's question answer its pairing check (CAN-7872)", async () => {
    const { host, root, request } = await delegatedSession();
    host.hostedChat.tabs.set('chat-1', DEFAULT_MODEL);
    host.hostedChat.questions.set('question-1', {
      requestId: 'question-1',
      chatId: 'chat-1',
      questions: [{ question: 'Which branch?', options: ['main', 'develop'] }],
    });
    await request('chat:command', [envelope(answer)]);
    // The answer carries the same check as a send. An answer to an async
    // question is accepted as a send, which the chat-state service checks
    // before it commits; one the agent is waiting on is CAN-7877's.
    const canCommit = host.hostedChat.answers[0]?.attribution.canCommit;
    expect(canCommit?.()).toBe(true);
    await host.service.forgetDevice({
      deviceId: root.deviceId,
      role: 'controller',
    });
    expect(canCommit?.()).toBe(false);
  });

  it("refuses to commit a hosted controller's send that is in flight when its session ends, pairing kept (CAN-7872)", async () => {
    let release = (): void => undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, request, session } = await delegatedSession({
      hostedDispatchGate: inFlight,
    });
    host.hostedChat.tabs.set('chat-1', DEFAULT_MODEL);
    const sending = request('chat:command', [envelope(send)]).catch(
      () => 'ended',
    );
    await until(() => host.hostedChat.dispatched.length > 0);
    const canCommit = host.hostedChat.dispatched[0]?.attribution.canCommit;
    expect(canCommit?.()).toBe(true);
    // The session ends but the pairing stays: the dispatch still running is
    // refused all the same.
    session.close('closed');
    await until(() => canCommit?.() === false);
    expect((await host.readSettings()).pairedControllers).toHaveLength(1);
    release();
    await sending;
  });

  it('carries the pairing check across queue actions and older send paths for desktop, browser and mobile controllers (CAN-7877)', async () => {
    const hub = new Hub();
    const desktop = addController(hub, 'desktop');
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const bystander = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(desktop),
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
          pinned(bystander),
        ],
      },
    });
    const desktopSession = await control(host, desktop);
    await hello(desktopSession.rpc);
    const browserSession = await control(host, browser);
    await hello(browserSession.rpc, {
      version: VERSION,
      controller: webControllerProfile('browser', 'web'),
    });
    const phoneSession = await control(host, phone);
    await hello(phoneSession.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: 1 },
    });
    const bystanderSession = await control(host, bystander);
    await hello(bystanderSession.rpc);

    const queueEntry = {
      projectId: 'p-1',
      worktreeId: 'w-1',
      chatId: 'chat-1',
      entryId: 'row-1',
    };
    const sendPayload = {
      projectId: 'p-1',
      worktreeId: 'w-1',
      chatId: 'chat-1',
      userMessageId: 'msg-1',
      text: 'Hello',
    };
    const queueCommands: Record<string, unknown>[] = [
      {
        type: 'chat.edit_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'row-1',
        text: 'Edited',
      },
      {
        type: 'chat.move_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'row-2',
        beforeQueuedMessageId: 'row-1',
      },
      {
        type: 'chat.cancel_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'row-1',
      },
      {
        type: 'chat.force_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'row-1',
      },
      {
        type: 'chat.set_queued_message_edit_lock',
        chatId: 'chat-1',
        queuedMessageId: 'row-1',
        locked: true,
      },
    ];

    const invokeStatus = async (
      rpc: RpcPeer,
      channel: string,
      args: unknown[],
    ): Promise<string> => {
      try {
        await rpc.request(REMOTE_METHODS.invoke, { channel, args });
        return 'ok';
      } catch (error) {
        return error instanceof RpcRemoteError
          ? (error.code ?? error.message)
          : String(error);
      }
    };

    // Desktop and browser can reach chat:send-message, chat:queue-*, and chat:command queue actions.
    for (const rpc of [desktopSession.rpc, browserSession.rpc]) {
      expect(
        await invokeStatus(rpc, IPC_CHANNELS.chatSendMessage, [sendPayload]),
      ).toBe('ok');
      expect(
        await invokeStatus(rpc, IPC_CHANNELS.chatQueueEdit, [
          { ...queueEntry, text: 'Updated' },
        ]),
      ).toBe('ok');
      expect(
        await invokeStatus(rpc, IPC_CHANNELS.chatQueueCancel, [queueEntry]),
      ).toBe('ok');
      expect(
        await invokeStatus(rpc, IPC_CHANNELS.chatQueueForce, [queueEntry]),
      ).toBe('ok');
      expect(
        await invokeStatus(rpc, IPC_CHANNELS.chatQueueSetEditLock, [
          { ...queueEntry, locked: true },
        ]),
      ).toBe('ok');
      for (const command of queueCommands) {
        expect(
          await invokeStatus(rpc, IPC_CHANNELS.chatCommand, [
            envelope(command),
          ]),
        ).toBe('ok');
      }
    }

    // Mobile reaches chat:send-message and chat:command queue actions (chat:queue-* stays refused).
    expect(
      await invokeStatus(phoneSession.rpc, IPC_CHANNELS.chatSendMessage, [
        sendPayload,
      ]),
    ).toBe('ok');
    for (const command of queueCommands) {
      expect(
        await invokeStatus(phoneSession.rpc, IPC_CHANNELS.chatCommand, [
          envelope(command),
        ]),
      ).toBe('ok');
    }
    expect(
      await invokeStatus(phoneSession.rpc, IPC_CHANNELS.chatQueueForce, [
        queueEntry,
      ]),
    ).toBe(CHANNEL_UNAVAILABLE_CODE);

    // Bystander establishes its own bridge so we can prove unpairing others never flips it.
    expect(
      await invokeCode(bystanderSession.rpc, IPC_CHANNELS.chatGetState),
    ).toBe('ok');
    const [desktopGuard, browserGuard, phoneGuard, bystanderGuard] =
      host.bridge.commitGuards;
    expect([
      desktopGuard?.(),
      browserGuard?.(),
      phoneGuard?.(),
      bystanderGuard?.(),
    ]).toEqual([true, true, true, true]);

    for (const controller of [desktop, browser, phone]) {
      await host.service.forgetDevice({
        deviceId: controller.deviceId,
        role: 'controller',
      });
    }
    expect([
      desktopGuard?.(),
      browserGuard?.(),
      phoneGuard?.(),
      bystanderGuard?.(),
    ]).toEqual([false, false, false, true]);
  });

  it('carries the pairing check across hosted queue actions on unpairing and session end (CAN-7877)', async () => {
    const queueEntry = {
      projectId: 'p-1',
      worktreeId: 'w-1',
      chatId: 'chat-1',
      entryId: 'row-1',
    };
    const hostedSend: Record<string, unknown> = {
      type: 'chat.send_message',
      chatId: 'chat-1',
      userMessageId: 'msg-hosted-1',
      text: 'Hello from hosted',
    };

    // 1. Unpairing flips both the hosted bridge guard (chat:queue-*) and hosted chat send guard.
    const unpaired = await delegatedSession();
    unpaired.host.hostedChat.tabs.set('chat-1', DEFAULT_MODEL);
    await unpaired.request(IPC_CHANNELS.chatQueueEdit, [
      { ...queueEntry, text: 'Updated' },
    ]);
    await unpaired.request(IPC_CHANNELS.chatQueueCancel, [queueEntry]);
    await unpaired.request(IPC_CHANNELS.chatQueueForce, [queueEntry]);
    await unpaired.request(IPC_CHANNELS.chatCommand, [envelope(hostedSend)]);
    const bridgeGuard = unpaired.host.bridge.commitGuards[0];
    const commandGuard =
      unpaired.host.hostedChat.dispatched[0]?.attribution.canCommit;
    expect(bridgeGuard?.()).toBe(true);
    expect(commandGuard?.()).toBe(true);
    await unpaired.host.service.forgetDevice({
      deviceId: unpaired.root.deviceId,
      role: 'controller',
    });
    expect(bridgeGuard?.()).toBe(false);
    expect(commandGuard?.()).toBe(false);

    // 2. Ending the hosted session with pairing kept flips both guards as well.
    const ended = await delegatedSession();
    ended.host.hostedChat.tabs.set('chat-1', DEFAULT_MODEL);
    await ended.request(IPC_CHANNELS.chatQueueForce, [queueEntry]);
    await ended.request(IPC_CHANNELS.chatCommand, [envelope(hostedSend)]);
    const endedBridgeGuard = ended.host.bridge.commitGuards[0];
    const endedCommandGuard =
      ended.host.hostedChat.dispatched[0]?.attribution.canCommit;
    expect(endedBridgeGuard?.()).toBe(true);
    expect(endedCommandGuard?.()).toBe(true);
    ended.session.close('closed');
    await until(
      () => endedBridgeGuard?.() === false && endedCommandGuard?.() === false,
    );
    expect((await ended.host.readSettings()).pairedControllers).toHaveLength(1);
  });

  it('stores uploads for desktop and browser controllers only; host file reads stay with desktops', async () => {
    const methodCode = async (
      rpc: RpcPeer,
      method: string,
      params: unknown,
    ): Promise<string> => {
      try {
        await rpc.request(method, params);
        return 'ok';
      } catch (error) {
        return error instanceof RpcRemoteError
          ? (error.code ?? error.message)
          : 'failed';
      }
    };
    const upload = {
      fileName: 'notes.txt',
      bytes: new Uint8Array([104, 105]),
    };
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const phone = addController(hub, 'mobile');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [
          pinned(browser, 'browser'),
          pinned(phone, 'mobile'),
        ],
      },
    });
    // A browser's attachment is stored here, as Portal's upload would be,
    // under that controller's own upload directory.
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    const stored: unknown = await fromBrowser.rpc.request(
      REMOTE_METHODS.uploadPut,
      upload,
    );
    const path: unknown =
      typeof stored === 'object' && stored !== null
        ? Reflect.get(stored, 'path')
        : undefined;
    if (typeof path !== 'string') throw new Error('upload path');
    expect(path).toContain(browser.deviceId);
    expect([...(await readFile(path))]).toEqual([104, 105]);
    // Reading host files stays a desktop controller's method.
    expect(
      await methodCode(fromBrowser.rpc, REMOTE_METHODS.fileRead, {
        absolutePath: path,
        offset: 0,
        length: 2,
      }),
    ).toBe('remote_controller_refused');
    // Mobile controllers are not given uploads or the unscoped file method.
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    expect(
      await methodCode(fromPhone.rpc, REMOTE_METHODS.fileRead, {
        absolutePath: path,
        offset: 0,
        length: 2,
      }),
    ).toBe('remote_controller_refused');
    expect(
      await methodCode(fromPhone.rpc, REMOTE_METHODS.uploadPut, upload),
    ).toBe('remote_controller_refused');
    // Neither are hosted agents.
    const hosted = await delegatedSession();
    expect(await methodCode(hosted.rpc, REMOTE_METHODS.uploadPut, upload)).toBe(
      'remote_controller_refused',
    );
  });

  it('holds delegated sessions to the hosted allowlist and its argument policies', async () => {
    const { host, invoke, rpc, child } = await delegatedSession();
    host.hostedChat.tabs.set('chat-1', DEFAULT_MODEL);
    host.hostedChat.questions.set('question-1', {
      requestId: 'question-1',
      chatId: 'chat-1',
      questions: [{ question: 'Which branch?', options: ['main', 'develop'] }],
    });
    expect(await invoke('chat:command', [envelope(send)])).toBe('ok');
    expect(
      await invoke('chat:command', [
        envelope({ type: 'chat.create_tab', tabId: 'chat-2', planMode: true }),
      ]),
    ).toBe('ok');
    // An ordinary question's answer.
    expect(await invoke('chat:command', [envelope(answer)])).toBe('ok');
    expect(await invoke('projects:load', [])).toBe('ok');
    const stop = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      expectedUserMessageId: 'message-1',
    };
    expect(await invoke('chat:cancel', [stop])).toBe('ok');
    expect(
      await invoke('work-entries:create', [{ projectId: 'project-1' }]),
    ).toBe('ok');
    const refused = [
      // Approvals, dismissals and destructive or rewriting commands.
      envelope({ ...answer, answers: [] }),
      envelope({ ...answer, decision: 'allow' }),
      envelope({
        ...answer,
        answers: [{ question: 'Run it?', selectedOptions: [], approved: true }],
      }),
      envelope({
        type: 'chat.dismiss_question',
        chatId: 'chat-1',
        questionId: 'question-1',
      }),
      envelope({ type: 'chat.archive_tab', chatId: 'chat-1' }),
      envelope({
        type: 'chat.archive_tab',
        tabId: 'chat-1',
        keepSession: true,
      }),
      envelope({ type: 'chat.archive_tab', tabId: 'chat-1', unread: true }),
      envelope({ type: 'chat.archive_tab', tabId: 'chat-1', extra: 1 }),
      envelope({ type: 'chat.close_tab', chatId: 'chat-1' }),
      envelope({ type: 'chat.close_tab', tabId: 'chat-1' }),
      envelope({
        type: 'chat.reset_to_point',
        chatId: 'chat-1',
        messageId: 'message-1',
      }),
      envelope({
        type: 'chat.set_approval_mode',
        chatId: 'chat-1',
        approvalMode: 'bypassPermissions',
      }),
      // Allowed commands carrying fields outside the policy.
      envelope({
        type: 'chat.create_tab',
        tabId: 'chat-3',
        approvalMode: 'bypassPermissions',
      }),
      envelope({ type: 'chat.create_tab', tabId: 'chat-3', planMode: 'true' }),
      envelope({
        type: 'chat.create_tab',
        tabId: 'chat-3',
        model: 'model-a',
        plugins: [],
      }),
      envelope({ ...send, planReviewApproval: { approved: true } }),
      // Plan review stays a person's decision (CAN-7435): no chat decision,
      // approval send or tracked-plan implementation from a hosted agent.
      envelope({
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { trackedPlanReviewStatus: 'approved', planMode: false },
        expectedPendingPlanExitRequestId: 'request-1',
      }),
      envelope({
        ...send,
        planReviewApproval: {
          requestId: 'request-1',
          planId: 'plan-1',
          revisionNumber: 1,
        },
      }),
      envelope({
        ...send,
        trackedPlanImplementation: {
          planId: 'plan-1',
          revisionNumber: 1,
          userMessageId: 'message-1',
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      envelope({ ...send, attachmentPaths: ['/etc/hosts'] }),
      envelope({
        ...send,
        agentSent: {
          kind: 'external_agent',
          connectionId: '00000000-0000-4000-8000-000000000001',
          clientName: 'Forged',
          verified: true,
          userId: ACCOUNT_USER_ID,
        },
      }),
      { ...envelope(send), origin: 'automation' },
      'not an envelope',
    ];
    for (const args of refused) {
      expect(await invoke('chat:command', [args])).toBe(
        'remote_channel_unavailable',
      );
    }
    expect(await invoke('chat:command', [envelope(send), {}])).toBe(
      'remote_channel_unavailable',
    );
    // A plain Stop ends whatever turn runs: refused without the exact turn.
    for (const args of [
      [{ projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' }],
      [{ ...stop, force: true }],
      [stop, {}],
    ]) {
      expect(await invoke('chat:cancel', args)).toBe(
        'remote_channel_unavailable',
      );
    }
    expect(
      await invoke('work-entries:create', [
        { projectId: 'project-1', title: 'Mine' },
      ]),
    ).toBe('remote_channel_unavailable');
    for (const channel of [
      NOT_A_MOBILE_CHANNEL,
      'chat:send-message',
      // Plan review's tracked-plan write and its chat read (CAN-7435).
      'tracked-plans:update',
      'chat:get-state',
    ]) {
      expect(await invoke(channel, [])).toBe('remote_channel_unavailable');
    }
    // Sends follow the same policy, and the host serves chat commands itself.
    rpc.notify(REMOTE_EVENTS.ipcSend, {
      channel: 'chat:command',
      args: [envelope({ type: 'chat.archive_tab', chatId: 'chat-1' })],
    });
    rpc.notify(REMOTE_EVENTS.ipcSend, {
      channel: 'chat:command',
      args: [envelope({ type: 'chat.create_tab', tabId: 'chat-4' })],
    });
    await until(() => host.hostedChat.tabs.has('chat-4'));
    // Pushes: the snapshot-stale signal reaches agents, terminal output never.
    host.mainPush('terminal:output', [{}]);
    host.mainPush('desktop:session-snapshot-stale', []);
    await until(() => child.pushes.length > 0);
    await settle(20);
    // Chat commands never reach the bridge, where they would go unattributed.
    expect(host.bridge.posts).toEqual([]);
    expect(host.bridge.invokes).toEqual([
      'projects:load',
      'chat:cancel',
      'work-entries:create',
    ]);
    // The exact turn reaches the computer's Stop unchanged.
    expect(host.bridge.invokeArgs[1]).toEqual([stop]);
    expect(
      host.hostedChat.dispatched.map(({ request }) => request.command.type),
    ).toEqual(['chat.send_message', 'chat.create_tab', 'chat.create_tab']);
    expect(host.hostedChat.answers).toHaveLength(1);
    expect(child.pushes).toEqual(['desktop:session-snapshot-stale']);
  });

  it('attributes hosted sends and answers to the paired agents from the session, never the controller', async () => {
    const { host, root, request } = await delegatedSession();
    host.hostedChat.questions.set('question-1', {
      requestId: 'question-1',
      chatId: 'chat-1',
      questions: [{ question: 'Which branch?', options: ['main'] }],
    });
    // A new chat starts on Portal's default model, so its first prompt runs.
    await request('chat:command', [
      envelope({ type: 'chat.create_tab', tabId: 'chat-1' }),
    ]);
    const sent = await request('chat:command', [envelope(send)]);
    expect(sent).toMatchObject({ outcome: 'applied', entityId: 'chat-1' });
    await request('chat:command', [envelope(answer)]);
    const [created, message] = host.hostedChat.dispatched;
    expect(created?.request).toMatchObject({
      origin: 'portal',
      command: {
        type: 'chat.create_tab',
        tabId: 'chat-1',
        model: DEFAULT_MODEL,
        defaultStampModel: DEFAULT_MODEL,
      },
    });
    const sender = {
      kind: 'external_agent',
      clientName: 'Agents',
      verified: false,
      userId: ACCOUNT_USER_ID,
    };
    expect(message?.attribution.sender.connectionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(message?.request).toMatchObject({
      origin: 'portal',
      command: { type: 'chat.send_message', agentSent: sender },
    });
    expect(message?.attribution).toMatchObject({
      rootDeviceId: root.deviceId,
      sender,
    });
    expect(host.hostedChat.answers[0]).toMatchObject({
      questionId: 'question-1',
      answers: answer.answers,
      attribution: { sender },
    });
    // The same pairing always has the same identity.
    expect(host.hostedChat.answers[0]?.attribution.sender.connectionId).toBe(
      message?.attribution.sender.connectionId,
    );
    // A blocked model never starts a chat; a secret question is the person's.
    const blocked = await request('chat:command', [
      envelope({
        type: 'chat.create_tab',
        tabId: 'chat-5',
        model: 'blocked-model',
      }),
    ]);
    expect(blocked).toMatchObject({ outcome: 'rejected' });
    host.hostedChat.questions.set('question-2', {
      requestId: 'question-2',
      chatId: 'chat-1',
      questions: [{ question: 'Token?', options: [], secret: true }],
    });
    const secret = await request('chat:command', [
      envelope({ ...answer, questionId: 'question-2' }),
    ]);
    expect(secret).toMatchObject({
      outcome: 'rejected',
      reason: HOSTED_SECRET_ANSWER_REFUSAL,
    });
    expect(host.hostedChat.dispatched).toHaveLength(2);
    expect(host.hostedChat.answers).toHaveLength(1);
  });

  it('refuses hosted chat commands it cannot attribute, never sending them through the bridge', async () => {
    for (const options of [
      { signedInAccount: 'key:0123' },
      { hostedChat: false as const },
    ]) {
      const { host, invoke } = await delegatedSession(options);
      expect(await invoke('chat:command', [envelope(send)])).toBe(
        'remote_channel_unavailable',
      );
      expect(host.bridge.invokes).toEqual([]);
      expect(host.hostedChat.dispatched).toEqual([]);
    }
  });

  it('refuses every hosted call that names a Bot project, so the Orchestrator is never an ordinary chat (CAN-7604)', async () => {
    const { host, invoke } = await delegatedSession();
    for (const projectId of [
      'app-advisor',
      'bot--01hzzzzzzzzzzzzzzzzzzzzzzz',
    ]) {
      const scoped = { projectId, worktreeId: 'entry-1' };
      const calls: Array<[string, unknown]> = [
        ['chat:command', { ...envelope(send), ...scoped }],
        [
          'chat:command',
          {
            ...envelope({ type: 'chat.create_tab', tabId: 'chat-1' }),
            ...scoped,
          },
        ],
        ['work-entries:create', { projectId }],
        ['chat:get-transcript-page', { ...scoped, chatId: 'chat-1' }],
        [
          'chat:cancel',
          { ...scoped, chatId: 'chat-1', expectedUserMessageId: 'message-1' },
        ],
        [
          'file:read-content',
          { absolutePath: '/notes.md', workspaceTarget: scoped },
        ],
      ];
      for (const [channel, arg] of calls) {
        expect(await invoke(channel, [arg])).toBe('remote_channel_unavailable');
      }
    }
    expect(host.bridge.invokes).toEqual([]);
    expect(host.hostedChat.dispatched).toEqual([]);
  });

  const slackSend = {
    schemaVersion: 1,
    commandId: 'command-slack-1',
    projectId: 'app-advisor',
    worktreeId: 'slack-conversations',
    command: {
      type: 'chat.send_message',
      chatId: 'slack-thread-1-sender-a',
      userMessageId: 'slack-message-1',
      text: 'What changed today?',
    },
  };

  it("serves a Slack session's Orchestrator send only behind this computer's gate, as the verified Slack sender (CAN-7604)", async () => {
    // Gate off: refused before an entry or a tab exists.
    const off = await delegatedSession({}, 'slack');
    expect(await off.request('chat:command', [slackSend])).toMatchObject({
      outcome: 'rejected',
      reason: HOSTED_SLACK_REQUESTS_OFF_REFUSAL,
    });
    expect(off.host.hostedChat.slackEntries).toEqual([]);
    expect(off.host.hostedChat.dispatched).toEqual([]);

    // Flag off: refused even with the gate on, without pointing at a setting
    // this computer doesn't show.
    const unoffered = await delegatedSession(
      { slackGate: true, slackFlag: false },
      'slack',
    );
    expect(await unoffered.request('chat:command', [slackSend])).toMatchObject({
      outcome: 'rejected',
      reason: HOSTED_SLACK_REQUESTS_UNAVAILABLE_REFUSAL,
    });
    expect(unoffered.host.hostedChat.slackEntries).toEqual([]);
    expect(unoffered.host.hostedChat.dispatched).toEqual([]);

    // Gate on: the thread's tab in the Slack conversations entry, sent as
    // the verified Slack sender with no model or approval mode of its own,
    // so the Orchestrator's settings on this computer apply.
    const on = await delegatedSession({ slackGate: true }, 'slack');
    expect(await on.request('chat:command', [slackSend])).toMatchObject({
      outcome: 'applied',
      entityId: 'slack-thread-1-sender-a',
      worktreeId: 'slack-entry-1',
    });
    expect(on.host.hostedChat.slackTabs).toEqual(['slack-thread-1-sender-a']);
    const [sent] = on.host.hostedChat.dispatched;
    // Its own stable identity, apart from the agents pairing's.
    const connectionId: unknown =
      sent?.request.command.type === 'chat.send_message'
        ? Reflect.get(Object(sent.request.command.agentSent), 'connectionId')
        : undefined;
    expect(connectionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(sent?.request).toEqual({
      schemaVersion: 1,
      commandId: 'command-slack-1',
      projectId: 'app-advisor',
      worktreeId: 'slack-entry-1',
      origin: 'portal',
      command: {
        type: 'chat.send_message',
        chatId: 'slack-thread-1-sender-a',
        userMessageId: 'slack-message-1',
        text: 'What changed today?',
        agentSent: {
          kind: 'external_agent',
          connectionId,
          clientName: 'Slack',
          verified: true,
          userId: ACCOUNT_USER_ID,
        },
      },
    });
    expect(on.host.bridge.invokes).toEqual([]);

    // Another person in the same Slack thread has their own tab: the tab ID
    // is the caller's, per sender, in the same Slack conversations entry.
    expect(
      await on.request('chat:command', [
        {
          ...slackSend,
          commandId: 'command-slack-2',
          command: {
            ...slackSend.command,
            chatId: 'slack-thread-1-sender-b',
            userMessageId: 'slack-message-2',
          },
        },
      ]),
    ).toMatchObject({ outcome: 'applied', worktreeId: 'slack-entry-1' });
    expect(on.host.hostedChat.slackTabs).toEqual([
      'slack-thread-1-sender-a',
      'slack-thread-1-sender-b',
    ]);
    expect(on.host.hostedChat.slackEntries).toEqual(['slack-entry-1']);

    // A Slack session makes only that send: no other Orchestrator command,
    // no entry it names itself, no model, and no ordinary project.
    for (const refused of [
      { ...slackSend, worktreeId: 'slack-entry-1' },
      {
        ...slackSend,
        command: { type: 'chat.create_tab', tabId: 'slack-thread-1-sender-a' },
      },
      { ...slackSend, command: { ...slackSend.command, model: DEFAULT_MODEL } },
      { ...slackSend, projectId: 'project-1', worktreeId: 'worktree-1' },
    ]) {
      expect(await on.invoke('chat:command', [refused])).toBe(
        'remote_channel_unavailable',
      );
    }
    expect(
      await on.invoke('work-entries:create', [{ projectId: 'app-advisor' }]),
    ).toBe('remote_channel_unavailable');
    expect(on.host.hostedChat.dispatched).toHaveLength(2);

    // An agents session, even with the gate on, never reaches the Orchestrator.
    const agents = await delegatedSession({ slackGate: true });
    expect(await agents.invoke('chat:command', [slackSend])).toBe(
      'remote_channel_unavailable',
    );
    expect(agents.host.hostedChat.dispatched).toEqual([]);
  });

  it("reads only the Slack conversations entries' transcripts and turn status, in a Slack session alone (CAN-7604)", async () => {
    const slack = await delegatedSession({ slackGate: true }, 'slack');
    await slack.request('chat:command', [slackSend]);
    const read = {
      projectId: 'app-advisor',
      worktreeId: 'slack-entry-1',
      chatId: 'slack-thread-1-sender-a',
    };
    expect(await slack.invoke('chat:get-transcript-page', [read])).toBe('ok');
    expect(
      await slack.invoke('chat:get-transcript-page', [
        { ...read, worktreeId: 'another-entry' },
      ]),
    ).toBe('remote_channel_unavailable');
    // Nor a chat in that entry no Slack message was sent to.
    expect(
      await slack.invoke('chat:get-transcript-page', [
        { ...read, chatId: 'chat-made-on-this-computer' },
      ]),
    ).toBe('remote_channel_unavailable');
    const status = {
      chatId: 'slack-thread-1-sender-a',
      userMessageId: 'slack-message-1',
    };
    expect(
      await slack.request('app-advisor:slack-turn-status', [status]),
    ).toEqual({ state: 'running', worktreeId: 'slack-entry-1' });
    expect(slack.host.hostedChat.slackStatusReads).toEqual([status]);
    // The read went to the bridge once; the status never did.
    expect(slack.host.bridge.invokes).toEqual(['chat:get-transcript-page']);
    // The read started the bridge, yet a Slack session hears none of this
    // computer's pushes, which would carry every chat's events.
    slack.host.mainPush('chat:event', [{ chatId: 'other-chat' }]);
    slack.host.bridge.emitPush('chat:event', [{ chatId: 'other-chat' }]);
    await settle(50);
    expect(slack.child.pushes).toEqual([]);

    const agents = await delegatedSession({ slackGate: true });
    expect(await agents.invoke('chat:get-transcript-page', [read])).toBe(
      'remote_channel_unavailable',
    );
    expect(await agents.invoke('app-advisor:slack-turn-status', [status])).toBe(
      'remote_channel_unavailable',
    );
    expect(agents.host.hostedChat.slackStatusReads).toEqual([]);
    // The same pushes do reach an agents session once its bridge runs.
    expect(
      await agents.invoke('chat:get-transcript-page', [
        { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      ]),
    ).toBe('ok');
    agents.host.mainPush('chat:event', [{ chatId: 'other-chat' }]);
    await until(() => agents.child.pushes.length > 0);
    expect(agents.child.pushes).toEqual(['chat:event']);
  });

  it('refuses a Slack claim the hosted root did not sign (CAN-7604)', async () => {
    const { hub, host, root } = await hostedSetup();
    const expiresAt = Date.now() + 60_000;
    // A v1 signature with a Slack claim added after signing.
    const added = addController(hub, 'hosted');
    await expect(
      control(host, added, {
        ...delegate(root, added.identity.publicKey, expiresAt),
        firstPartyClient: 'slack',
      }),
    ).rejects.toThrow();
    // A v2 Slack signature with the claim taken off.
    const stripped = addController(hub, 'hosted');
    const { firstPartyClient: _claim, ...unclaimed } = delegate(
      root,
      stripped.identity.publicKey,
      expiresAt,
      'slack',
    );
    void _claim;
    await expect(control(host, stripped, unclaimed)).rejects.toThrow();
  });

  it('admits only the empty provider-usage read through a hosted session', async () => {
    const { host, invoke } = await delegatedSession();
    const channel = HOSTED_IPC_CHANNELS.providerUsageLimitsGet;
    expect(await invoke(channel, [{}])).toBe('ok');
    const admitted = host.bridge.invokes.length;
    for (const args of [
      [],
      [null],
      [{ refresh: true }],
      [{ projectId: 'p' }],
      [{}, {}],
    ]) {
      expect(await invoke(channel, args)).toBe('remote_channel_unavailable');
    }
    expect(host.bridge.invokes).toHaveLength(admitted);
  });

  it('tunnels every hosted channel, including the read channels added for hosted agents', () => {
    expect({
      githubGetPrState: IPC_CHANNELS.githubGetPrState,
      providerUsageLimitsGet: IPC_CHANNELS.providerUsageLimitsGet,
      pipelinesListForWorktree: PIPELINE_CHANNELS.LIST_FOR_WORKTREE,
      pipelinesListWorktreeExecutions:
        PIPELINE_CHANNELS.LIST_WORKTREE_EXECUTIONS,
      pipelinesGetWorktreeExecution: PIPELINE_CHANNELS.GET_WORKTREE_EXECUTION,
    }).toEqual(HOSTED_IPC_CHANNELS);
    expect(
      HOSTED_CONTROLLER_CHANNELS.filter(
        (channel) => getRemoteChannelDisposition(channel) !== 'tunnel',
      ),
    ).toEqual([]);
    // The Tasks channels (CAN-7445) are the desktop's own channels; two of
    // them are not in the protocol's REMOTE_IPC_CHANNELS.
    expect(HOSTED_TASK_CHANNELS).toEqual({
      pluginCatalogList: IPC_CHANNELS.pluginCatalogList,
      homeListBranchTargets: IPC_CHANNELS.homeListBranchTargets,
      worktreeActivityEntities: IPC_CHANNELS.worktreeActivityEntities,
      hookChangePause: IPC_CHANNELS.hookChangePause,
      chatQueueCancel: IPC_CHANNELS.chatQueueCancel,
      chatQueueEdit: IPC_CHANNELS.chatQueueEdit,
      chatQueueForce: IPC_CHANNELS.chatQueueForce,
      worktreeSetLabel: IPC_CHANNELS.worktreeSetLabel,
      worktreeSetHidden: IPC_CHANNELS.worktreeSetHidden,
      worktreeSetTrackedBaseBranch: IPC_CHANNELS.worktreeSetTrackedBaseBranch,
      workEntriesUpdate: IPC_CHANNELS.workEntriesUpdate,
      sidebarItemGroupsCreate: IPC_CHANNELS.sidebarItemGroupsCreate,
      sidebarItemGroupsMoveItem: IPC_CHANNELS.sidebarItemGroupsMoveItem,
    });
    for (const channel of Object.values(HOSTED_TASK_CHANNELS))
      expect(HOSTED_CONTROLLER_CHANNELS).toContain(channel);
    // The archive channels (CAN-7446) are the desktop's own channels too.
    expect(HOSTED_ARCHIVE_CHANNELS).toEqual({
      worktreeArchive: IPC_CHANNELS.worktreeArchive,
      workspaceArchiveWorktree: IPC_CHANNELS.workspaceArchiveWorktree,
      workEntriesDelete: IPC_CHANNELS.workEntriesDelete,
    });
    for (const channel of Object.values(HOSTED_ARCHIVE_CHANNELS))
      expect(HOSTED_CONTROLLER_CHANNELS).toContain(channel);
    // Hosted admission leaves the other profiles alone: browsers keep
    // `work-entries:delete` and mobile controllers stay refused it.
    expect(BROWSER_CONTROLLER_CHANNELS).toContain(
      IPC_CHANNELS.workEntriesDelete,
    );
    expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(
      IPC_CHANNELS.workEntriesDelete,
    );
    // Four of them are on no other controller list: they stay hosted-only.
    for (const channel of [
      HOSTED_TASK_CHANNELS.sidebarItemGroupsCreate,
      HOSTED_TASK_CHANNELS.sidebarItemGroupsMoveItem,
      HOSTED_TASK_CHANNELS.workEntriesUpdate,
      HOSTED_TASK_CHANNELS.worktreeSetTrackedBaseBranch,
    ]) {
      expect(BROWSER_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
    }
  });

  it('admits the hosted Tasks channels with exactly their reviewed arguments (CAN-7445)', async () => {
    // A hosted delegation authorizes the session for the whole computer, as
    // the earlier hosted channels are: no channel is held to a subset of
    // workspaces, whichever key (projectId, workspaceId or
    // scope.workspaceLocalId) addresses it. The policy holds the shape.
    const { host, invoke } = await delegatedSession();
    const channels = HOSTED_TASK_CHANNELS;
    const worktree = { projectId: 'project-1', worktreeId: 'worktree-1' };
    const entry = { ...worktree, chatId: 'chat-1', entryId: 'entry-1' };
    const base = { workspaceId: 'project-1', worktreeId: 'worktree-1' };
    const title = { projectId: 'project-1', entryId: 'entry-1' };
    const scope = { workspaceLocalId: 'project-1' };
    const item = { scope, itemId: 'worktree-1' };
    const accepted: Array<[string, Record<string, unknown>]> = [
      [channels.pluginCatalogList, { projectId: 'project-1' }],
      [channels.homeListBranchTargets, { workspaceId: 'project-1' }],
      [channels.worktreeActivityEntities, worktree],
      [channels.hookChangePause, { ...worktree, kind: 'pause', hookKey: 'h' }],
      [channels.hookChangePause, { ...worktree, kind: 'resume', all: true }],
      [channels.chatQueueCancel, entry],
      [channels.chatQueueEdit, { ...entry, text: 'Run the tests' }],
      [channels.chatQueueForce, entry],
      [channels.worktreeSetLabel, { ...worktree, label: 'Fix login' }],
      [channels.worktreeSetLabel, worktree],
      [channels.worktreeSetHidden, { ...worktree, hidden: true }],
      [channels.worktreeSetTrackedBaseBranch, { ...base, baseBranch: 'rel/2' }],
      [channels.workEntriesUpdate, { ...title, title: 'Notes' }],
      [channels.workEntriesUpdate, { ...title, title: null }],
      [
        channels.sidebarItemGroupsCreate,
        { ...item, name: 'Bugs', color: 'categorical-2' },
      ],
      [channels.sidebarItemGroupsCreate, { ...item, name: 'Bugs' }],
      [channels.sidebarItemGroupsMoveItem, { ...item, groupId: 'grp-1' }],
      [channels.sidebarItemGroupsMoveItem, { ...item, groupId: null }],
    ];
    for (const [channel, arg] of accepted)
      expect(await invoke(channel, [arg])).toBe('ok');
    expect(host.bridge.invokes).toEqual(accepted.map(([channel]) => channel));
    expect(host.bridge.invokeArgs).toEqual(accepted.map(([, arg]) => [arg]));

    const refused: Array<[string, unknown[]]> = [
      ...Object.values(channels).flatMap(
        (channel): Array<[string, unknown[]]> => [
          [channel, []],
          [channel, [null]],
        ],
      ),
      [channels.pluginCatalogList, [{ projectId: 'project-1' }, {}]],
      [channels.pluginCatalogList, [{ projectId: 'project-1', refresh: true }]],
      [channels.homeListBranchTargets, [{ workspaceId: '' }]],
      [channels.homeListBranchTargets, [{ projectId: 'project-1' }]],
      [channels.worktreeActivityEntities, [{ projectId: 'project-1' }]],
      [
        channels.hookChangePause,
        [{ ...worktree, kind: 'pause', hookKey: 'h', all: true }],
      ],
      [channels.hookChangePause, [{ ...worktree, kind: 'pause' }]],
      [channels.hookChangePause, [{ ...worktree, kind: 'pause', all: false }]],
      [channels.hookChangePause, [{ ...worktree, kind: 'delete', all: true }]],
      [channels.chatQueueCancel, [{ ...entry, queuedMessageRevision: 1 }]],
      [channels.chatQueueEdit, [entry]],
      [channels.chatQueueEdit, [{ ...entry, text: '' }]],
      [
        channels.chatQueueEdit,
        [{ ...entry, text: 'x', attachmentPaths: ['/etc/hosts'] }],
      ],
      [channels.chatQueueEdit, [{ ...entry, text: 'x', fileReferences: [] }]],
      [channels.chatQueueEdit, [{ ...entry, text: 'x', inputMode: 'voice' }]],
      [
        channels.chatQueueEdit,
        [{ ...entry, text: 'x', attachmentPromptContexts: [] }],
      ],
      [channels.chatQueueForce, [{ ...worktree, chatId: 'chat-1' }]],
      [channels.worktreeSetLabel, [{ ...worktree, label: '' }]],
      [channels.worktreeSetLabel, [{ ...worktree, label: 'a\nb' }]],
      [channels.worktreeSetLabel, [{ ...worktree, label: null }]],
      [channels.worktreeSetHidden, [{ ...worktree, hidden: 'yes' }]],
      [channels.worktreeSetHidden, [worktree]],
      ...[
        { ...base, baseBranch: 'main', repoId: 'repo-1' },
        { ...base, baseBranch: null },
        { ...base, baseBranch: '' },
        { ...base, baseBranch: '-c' },
        { ...base, baseBranch: 'main dev' },
        { ...base, baseBranch: 'a..b' },
        { ...base, baseBranch: 'main.lock' },
        { ...base, baseBranch: 'feat/' },
        { ...base, baseBranch: 'a:b' },
        { ...worktree, baseBranch: 'main' },
      ].map((arg): [string, unknown[]] => [
        channels.worktreeSetTrackedBaseBranch,
        [arg],
      ]),
      [channels.workEntriesUpdate, [{ ...title, title: 'x', status: 'done' }]],
      [channels.workEntriesUpdate, [{ ...title, title: 'x', pinned: true }]],
      [channels.workEntriesUpdate, [title]],
      [channels.workEntriesUpdate, [{ ...title, title: '' }]],
      [channels.sidebarItemGroupsCreate, [item]],
      [channels.sidebarItemGroupsCreate, [{ ...item, name: '   ' }]],
      [
        channels.sidebarItemGroupsCreate,
        [{ ...item, name: 'Bugs', labelHidden: true }],
      ],
      [
        channels.sidebarItemGroupsCreate,
        [{ ...item, name: 'Bugs', scope: { appAdvisor: true } }],
      ],
      [
        channels.sidebarItemGroupsCreate,
        [{ ...item, name: 'Bugs', color: 'red' }],
      ],
      [
        channels.sidebarItemGroupsMoveItem,
        [{ ...item, groupId: 'grp-1', before: 'worktree-2' }],
      ],
      [channels.sidebarItemGroupsMoveItem, [{ ...item, groupId: 'group-1' }]],
      [channels.sidebarItemGroupsMoveItem, [item]],
      // The rest of the group channels stay off.
      ['sidebar-item-groups:ungroup', [{ scope, groupId: 'grp-1' }]],
      ['sidebar-item-groups:update', [{ scope, groupId: 'grp-1', name: 'x' }]],
      ['sidebar-item-groups:move-group', [{ scope, groupId: 'grp-1' }]],
      ['chat:queue-set-edit-lock', [{ ...entry, locked: true }]],
    ];
    for (const [channel, args] of refused)
      expect([channel, await invoke(channel, args)]).toEqual([
        channel,
        'remote_channel_unavailable',
      ]);
    expect(host.bridge.invokes).toHaveLength(accepted.length);
  });

  it('admits the hosted archive channels only as a locked archive that keeps the branch (CAN-7446)', async () => {
    const { host, invoke } = await delegatedSession();
    const channels = HOSTED_ARCHIVE_CHANNELS;
    // A real ISO timestamp, as the computer reports a worktree's createdAt.
    const createdAt = '2026-11-21T09:30:15.123Z';
    const flags = { lockAfterArchive: true, deleteBranch: false };
    const single = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      ...flags,
    };
    const multi = {
      workspaceId: 'project-2',
      worktreeId: 'worktree-2',
      ...flags,
    };
    const entry = {
      projectId: 'project-3',
      entryId: 'entry-1',
      lockAfterArchive: true,
    };
    const accepted: Array<[string, Record<string, unknown>]> = [
      [channels.worktreeArchive, single],
      [channels.worktreeArchive, { ...single, expectedCreatedAt: createdAt }],
      [channels.workspaceArchiveWorktree, multi],
      [
        channels.workspaceArchiveWorktree,
        { ...multi, expectedCreatedAt: createdAt },
      ],
      [channels.workEntriesDelete, entry],
    ];
    for (const [channel, arg] of accepted)
      expect([channel, await invoke(channel, [arg])]).toEqual([channel, 'ok']);
    expect(host.bridge.invokes).toEqual(accepted.map(([channel]) => channel));
    expect(host.bridge.invokeArgs).toEqual(accepted.map(([, arg]) => [arg]));

    const without = (
      value: Record<string, unknown>,
      key: string,
    ): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(value).filter(([name]) => name !== key),
      );
    const worktreeRefusals = (
      channel: string,
      base: Record<string, unknown>,
    ): Array<[string, unknown[]]> => [
      ...Object.keys(base).map((key): [string, unknown[]] => [
        channel,
        [without(base, key)],
      ]),
      [channel, [{ ...base, lockAfterArchive: false }]],
      [channel, [{ ...base, lockAfterArchive: 'true' }]],
      [channel, [{ ...base, lockAfterArchive: 1 }]],
      [channel, [{ ...base, lockAfterArchive: null }]],
      [channel, [{ ...base, deleteBranch: true }]],
      [channel, [{ ...base, deleteBranch: null }]],
      [channel, [{ ...base, repoPath: '/Users/me/repo' }]],
      [channel, [{ ...base, typedRefusal: true }]],
      [channel, [{ ...base, deleteWithoutRetentionIfMissing: true }]],
      [channel, [{ ...base, expectedBranchName: 'main' }]],
      [channel, [{ ...base, remainingWorktreeOrder: [] }]],
      [channel, [{ ...base, expectedRemainingWorktreeOrder: [] }]],
      [channel, [{ ...base, extra: 1 }]],
      [channel, [{ ...base, expectedCreatedAt: 1 }]],
      [channel, [{ ...base, expectedCreatedAt: 'x'.repeat(65) }]],
      [channel, []],
      [channel, [base, {}]],
    ];
    const refused: Array<[string, unknown[]]> = [
      ...worktreeRefusals(channels.worktreeArchive, single),
      ...worktreeRefusals(channels.workspaceArchiveWorktree, multi),
      // Each shape names its project under its own key.
      [channels.worktreeArchive, [{ ...multi }]],
      [channels.workspaceArchiveWorktree, [{ ...single }]],
      ...Object.keys(entry).map((key): [string, unknown[]] => [
        channels.workEntriesDelete,
        [without(entry, key)],
      ]),
      [channels.workEntriesDelete, [{ ...entry, lockAfterArchive: false }]],
      [channels.workEntriesDelete, [{ ...entry, lockAfterArchive: 'true' }]],
      [
        channels.workEntriesDelete,
        [{ ...entry, expectedCreatedAt: createdAt }],
      ],
      [channels.workEntriesDelete, [{ ...entry, extra: 1 }]],
      [channels.workEntriesDelete, []],
      [channels.workEntriesDelete, [entry, {}]],
      // No Bot project, under either key.
      [
        channels.worktreeArchive,
        [{ ...single, projectId: APP_ADVISOR_PROJECT_ID }],
      ],
      [
        channels.workspaceArchiveWorktree,
        [{ ...multi, workspaceId: APP_ADVISOR_PROJECT_ID }],
      ],
      [
        channels.workEntriesDelete,
        [{ ...entry, projectId: APP_ADVISOR_PROJECT_ID }],
      ],
      // The archived-items list and discard stay off.
      ['work-entries:list-archived', [{ projectId: 'project-3' }]],
      [
        'worktree:discard',
        [{ projectId: 'project-1', worktreeId: 'worktree-1' }],
      ],
    ];
    for (const [channel, args] of refused)
      expect([channel, await invoke(channel, args)]).toEqual([
        channel,
        'remote_channel_unavailable',
      ]);
    expect(host.bridge.invokes).toHaveLength(accepted.length);
  });

  it('serves a hosted chat archive itself with only the tab, never in a Work Entry project (CAN-7446)', async () => {
    const { host, request, invoke } = await delegatedSession();
    const archive = { type: 'chat.archive_tab', tabId: 'chat-1' };
    expect(await request('chat:command', [envelope(archive)])).toMatchObject({
      outcome: 'applied',
    });
    expect(host.hostedChat.dispatched.at(-1)?.request).toMatchObject({
      origin: 'portal',
      command: archive,
    });
    expect(
      Object.keys(host.hostedChat.dispatched.at(-1)?.request.command ?? {}),
    ).toEqual(['type', 'tabId']);
    // A Work Entry's chats close only with their task.
    expect(
      await request('chat:command', [
        { ...envelope(archive), projectId: WORK_ENTRY_PROJECT_ID },
      ]),
    ).toMatchObject({
      outcome: 'rejected',
      reason: HOSTED_WORK_ENTRY_CHAT_ARCHIVE_REFUSAL,
    });
    for (const command of [
      { ...archive, keepSession: true },
      { ...archive, unread: true },
      { type: 'chat.archive_tab', chatId: 'chat-1' },
      { type: 'chat.close_tab', tabId: 'chat-1' },
      { type: 'chat.discard_tab', tabId: 'chat-1' },
    ]) {
      expect(await invoke('chat:command', [envelope(command)])).toBe(
        'remote_channel_unavailable',
      );
    }
    expect(host.hostedChat.dispatched).toHaveLength(1);
    expect(host.bridge.posts).toEqual([]);
  });

  it('serves the hosted chat settings commands itself, rebuilt from the reviewed fields (CAN-7445)', async () => {
    const { host, request, invoke } = await delegatedSession();
    const selections = {
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'lint' }],
      mcpServerRefs: [],
    };
    const commandOf = (index: number): unknown =>
      host.hostedChat.dispatched[index]?.request.command;
    // The agent's plugin selections replace the create seed's.
    expect(
      await request('chat:command', [
        envelope({
          type: 'chat.create_tab',
          tabId: 'chat-1',
          model: SEEDED_MODEL,
          pluginSelections: selections,
        }),
      ]),
    ).toMatchObject({ outcome: 'applied' });
    expect(commandOf(0)).toEqual({
      type: 'chat.create_tab',
      tabId: 'chat-1',
      model: SEEDED_MODEL,
      pluginSelections: selections,
    });
    // A model change runs the create preflight and refuses a provider that
    // does not serve the model; an unknown model keeps the requested one.
    const setModel = {
      type: 'chat.set_model',
      tabId: 'chat-1',
      model: 'claude-model',
      providerType: 'claude',
    };
    expect(await request('chat:command', [envelope(setModel)])).toMatchObject({
      outcome: 'applied',
    });
    expect(host.hostedChat.dispatched[1]?.request).toMatchObject({
      origin: 'portal',
      command: setModel,
    });
    expect(
      await request('chat:command', [
        envelope({ ...setModel, model: 'blocked-model' }),
      ]),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'This model is blocked by your organization policy.',
    });
    expect(
      await request('chat:command', [
        envelope({ ...setModel, providerType: 'codex' }),
      ]),
    ).toMatchObject({
      outcome: 'rejected',
      reason: HOSTED_MODEL_PROVIDER_REFUSAL,
    });
    expect(
      await request('chat:command', [
        envelope({
          ...setModel,
          model: 'gateway-model',
          providerType: 'codex',
        }),
      ]),
    ).toMatchObject({ outcome: 'applied' });
    expect(host.hostedChat.dispatched).toHaveLength(3);
    // Each reviewed patch key, alone or together.
    const patches: Array<Record<string, unknown>> = [
      { modelSelectionMode: 'auto' },
      { modelConfig: { thinkingLevel: 'high' } },
      { modelConfig: { fastMode: true } },
      { planMode: true },
      { planMode: false },
      { pluginSelections: selections },
      {
        planMode: true,
        modelConfig: { thinkingLevel: 'low', fastMode: false },
      },
    ];
    for (const patch of patches) {
      const before = host.hostedChat.dispatched.length;
      expect(
        await request('chat:command', [
          envelope({ type: 'chat.patch_tab_settings', tabId: 'chat-1', patch }),
        ]),
      ).toMatchObject({ outcome: 'applied' });
      expect(host.hostedChat.dispatched[before]?.request).toMatchObject({
        origin: 'portal',
      });
      expect(commandOf(before)).toEqual({
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch,
      });
    }
    // Open point D: turning plan mode off while a plan waits for review is
    // dispatched exactly as asked, as on Portal. The patch carries no plan
    // review or pending plan exit field, so the pending request is neither
    // approved nor discarded; the review is only hidden while plan mode is off.
    const dispatchedBefore = host.hostedChat.dispatched.length;
    expect(
      await request('chat:command', [
        envelope({
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { planMode: false },
        }),
      ]),
    ).toMatchObject({ outcome: 'applied' });
    expect(host.hostedChat.dispatched).toHaveLength(dispatchedBefore + 1);
    const planOff = host.hostedChat.dispatched[dispatchedBefore]?.request;
    expect(planOff).toMatchObject({
      origin: 'portal',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: false },
      },
    });
    expect(planOff).not.toHaveProperty('expectedPendingPlanExitRequestId');
    expect(commandOf(dispatchedBefore)).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: { planMode: false },
    });
    // Steering a queued message.
    const steer = {
      type: 'chat.steer_queued_message',
      chatId: 'chat-1',
      queuedMessageId: 'entry-1',
      queuedMessageRevision: 2,
    };
    expect(await request('chat:command', [envelope(steer)])).toMatchObject({
      outcome: 'applied',
    });
    expect(commandOf(host.hostedChat.dispatched.length - 1)).toEqual(steer);
    const served = host.hostedChat.dispatched.length;

    // Refused by the argument policy before the dispatcher: everything
    // CAN-7435 locks out, and anything beyond the reviewed keys.
    const patchOf = (patch: unknown): Record<string, unknown> =>
      envelope({ type: 'chat.patch_tab_settings', tabId: 'chat-1', patch });
    const refused: unknown[] = [
      patchOf({ proposalMode: true }),
      patchOf({ pendingPlanExit: null }),
      patchOf({ pendingPlanExitRequestId: null }),
      patchOf({ trackedPlanImplementation: null }),
      patchOf({ trackedPlanReviewStatus: 'approved' }),
      patchOf({ autoArchive: true }),
      patchOf({ deferredToolsAllowed: true }),
      patchOf({ title: 'Mine' }),
      patchOf({ customTitle: 'Mine' }),
      patchOf({ model: 'claude-model' }),
      patchOf({ approvalMode: 'bypassPermissions' }),
      patchOf({ modelSelectionMode: 'manual' }),
      patchOf({ modelSelectionMode: null }),
      patchOf({ modelConfig: { speed: 'fast' } }),
      patchOf({ modelConfig: {} }),
      patchOf({ modelConfig: { fastMode: 'yes' } }),
      patchOf({}),
      patchOf({ planMode: true, customTitle: 'Mine' }),
      patchOf({ planMode: 'true' }),
      patchOf({ pluginSelections: { ...selections, bundleIds: [] } }),
      patchOf({
        pluginSelections: {
          ...selections,
          collectionIds: Array.from({ length: 101 }, (_, i) => `c-${i}`),
        },
      }),
      patchOf({ pluginSelections: { ...selections, collectionIds: [1] } }),
      patchOf({
        pluginSelections: {
          ...selections,
          pluginRefs: [{ marketplaceId: 'm', pluginName: 'p', owner: 'x' }],
        },
      }),
      envelope({
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: true },
        expectedPluginSelections: selections,
      }),
      envelope({
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: false },
        expectedPendingPlanExitRequestId: 'request-1',
      }),
      envelope({
        type: 'chat.create_tab',
        tabId: 'chat-3',
        pluginSelections: { collectionIds: [], skillRefs: [] },
      }),
      envelope({ ...setModel, providerType: undefined }),
      envelope({ ...setModel, settings: { thinkingLevel: 'high' } }),
      envelope({
        ...setModel,
        notice: { id: 'notice-1', timestamp: 1, text: 'Changed' },
      }),
      envelope({ ...steer, queuedMessageRevision: -1 }),
      envelope({ ...steer, queuedMessageRevision: 1.5 }),
      envelope({
        type: 'chat.force_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'entry-1',
      }),
      envelope({
        type: 'chat.cancel_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'entry-1',
      }),
      envelope({ type: 'chat.mark_read', chatId: 'chat-1' }),
    ];
    for (const args of refused)
      expect(await invoke('chat:command', [args])).toBe(
        'remote_channel_unavailable',
      );
    expect(host.hostedChat.dispatched).toHaveLength(served);
    expect(host.bridge.invokes).toEqual([]);
    expect(host.bridge.posts).toEqual([]);
  });

  it('keeps hosted chat fields within desktop validation and drops unreviewed patch keys past the policy (CAN-7445)', async () => {
    const selections = {
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'lint' }],
      mcpServerRefs: [],
    };
    // Every field the hosted policy admits for these command types is one
    // the desktop's chat command validation (COMMAND_KEYS) accepts. The
    // hosted send's `model` is not, a known gap left out of scope.
    const full: Array<Record<string, unknown> & { type: string }> = [
      {
        type: 'chat.create_tab',
        tabId: 'chat-1',
        model: 'claude-model',
        planMode: true,
        pluginSelections: selections,
      },
      {
        type: 'chat.set_model',
        tabId: 'chat-1',
        model: 'claude-model',
        providerType: 'claude',
        executionHarness: 'claude',
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: {
          modelSelectionMode: 'auto',
          modelConfig: { thinkingLevel: 'high', fastMode: true },
          planMode: true,
          pluginSelections: selections,
        },
      },
      {
        type: 'chat.steer_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'entry-1',
        queuedMessageRevision: 1,
      },
    ];
    for (const command of full) {
      expect(Object.keys(command).sort()).toEqual(
        [...(HOSTED_CHAT_COMMAND_FIELDS.get(command.type) ?? [])].sort(),
      );
      expect(hostedInvocationAllowed('chat:command', [envelope(command)])).toBe(
        true,
      );
      expect(() => validateChatCommandRequest(envelope(command))).not.toThrow();
    }

    // The dispatcher rebuilds a patch from the reviewed keys even when the
    // policy check is bypassed, and refuses one with none left.
    const dispatched: ChatCommandRequest[] = [];
    const dispatcher = createHostedChatDispatcher({
      validate: (value) => validateChatCommandRequest(value),
      isWorkEntryScope: () => false,
      dispatch: (value) => {
        dispatched.push(value);
        return Promise.resolve({
          commandId: value.commandId,
          revision: 1,
          outcome: 'applied',
        });
      },
      createSeed: () => Promise.resolve({ model: DEFAULT_MODEL }),
      modelRefusal: () => Promise.resolve(null),
      modelProvider: fixtureModelProvider,
      pendingQuestion: () => Promise.resolve(undefined),
      answerQuestion: () => Promise.reject(new Error('not answered here')),
    });
    const attribution: HostedChatAttribution = {
      sender: {
        kind: 'external_agent',
        connectionId: '00000000-0000-4000-8000-000000000001',
        clientName: 'Agents',
        verified: false,
        userId: ACCOUNT_USER_ID,
      },
      rootDeviceId: 'root-device',
      sessionDeviceId: 'session-device',
    };
    expect(
      await dispatcher(
        envelope({
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { planMode: true, customTitle: 'Mine', autoArchive: true },
        }),
        attribution,
      ),
    ).toMatchObject({ outcome: 'applied' });
    expect(dispatched[0]).toMatchObject({
      origin: 'portal',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: true },
      },
    });
    expect(dispatched[0]?.command).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: { planMode: true },
    });
    for (const command of [
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { customTitle: 'Mine' },
      },
      { type: 'chat.mark_read', chatId: 'chat-1' },
    ]) {
      expect(await dispatcher(envelope(command), attribution)).toMatchObject({
        outcome: 'rejected',
        reason: HOSTED_CHAT_COMMAND_REFUSAL,
      });
    }
    expect(dispatched).toHaveLength(1);
    // The desktop merges a partial modelConfig field-wise
    // (`applySettingsPatch` uses this merge), so a hosted thinking change
    // keeps the chat's speed.
    expect(
      mergeAgentModelConfig(
        { thinkingLevel: 'high', fastMode: true },
        { thinkingLevel: 'low' },
      ),
    ).toMatchObject({ thinkingLevel: 'low', fastMode: true });
  });

  it("stops only the expected turn: Portal's exact stop for a worktree, the exact user Stop for Cowork", async () => {
    const calls: string[] = [];
    const deps = (
      cowork: boolean,
      active: string | null,
    ): ExactChatTurnStopDeps => ({
      validateId: (value: string, name: string): void => {
        if (value.length === 0) throw new Error(`${name} is required`);
      },
      isCoworkWorkspace: (): boolean => cowork,
      stopActiveTurn: (
        _request: unknown,
        expected: string,
      ): Promise<{ resumableTurn?: { userMessageId: string } } | null> => {
        calls.push(`active:${expected}`);
        return Promise.resolve(expected === active ? {} : null);
      },
      cancelWorktreeTurn: (request: {
        turnId: string;
      }): Promise<{ outcome: 'stop_requested' | 'turn_not_active' }> => {
        calls.push(`worktree:${request.turnId}`);
        return Promise.resolve({
          outcome:
            request.turnId === active ? 'stop_requested' : 'turn_not_active',
        });
      },
    });
    const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    // A newer turn runs: the stop names the old one and changes nothing.
    expect(
      await stopExactChatTurn(scope, 'old-turn', deps(false, 'new-turn')),
    ).toEqual({ outcome: 'turn_not_active' });
    expect(
      await stopExactChatTurn(scope, 'new-turn', deps(false, 'new-turn')),
    ).toEqual({ outcome: 'stop_requested' });
    expect(
      await stopExactChatTurn(scope, 'old-turn', deps(true, 'new-turn')),
    ).toEqual({ outcome: 'turn_not_active' });
    expect(
      await stopExactChatTurn(scope, 'new-turn', deps(true, 'new-turn')),
    ).toEqual({ outcome: 'stop_requested' });
    expect(calls).toEqual([
      'worktree:old-turn',
      'worktree:new-turn',
      'active:old-turn',
      'active:new-turn',
    ]);
    await expect(
      stopExactChatTurn(scope, '', deps(false, 'new-turn')),
    ).rejects.toThrow('expectedUserMessageId');
  });

  it('closes delegated sessions at expiry and when the root is removed, including between hello1 and hello3', async () => {
    const { hub, host, root, other } = await hostedSetup();
    const brief = addController(hub, 'hosted');
    const short = await control(
      host,
      brief,
      delegate(root, brief.identity.publicKey, Date.now() + 300),
    );
    const closed = new Promise<void>((resolve) =>
      short.rpc.onClose(() => resolve()),
    );
    await closed;

    // Expiry while the handshake is in flight.
    const late = addController(hub, 'hosted');
    hub.hold = async (from, _to, payload): Promise<void> => {
      if (
        from === late.deviceId &&
        decodeEnvelope(payload)?.type === 'hello3'
      ) {
        await settle(350);
      }
    };
    await expect(
      control(
        host,
        late,
        delegate(root, late.identity.publicKey, Date.now() + 250),
      ),
    ).rejects.toThrow();

    // Root removed while the handshake is in flight.
    const racing = addController(hub, 'hosted');
    hub.hold = async (from, _to, payload): Promise<void> => {
      if (
        from === racing.deviceId &&
        decodeEnvelope(payload)?.type === 'hello3'
      ) {
        await host.service.forgetDevice({
          deviceId: root.deviceId,
          role: 'controller',
        });
      }
    };
    await expect(
      control(
        host,
        racing,
        delegate(root, racing.identity.publicKey, Date.now() + 60_000),
      ),
    ).rejects.toThrow();
    hub.hold = null;
    // The other pairing is untouched.
    expect(
      (await host.readSettings()).pairedControllers.map((pin) => pin.deviceId),
    ).toEqual([other.deviceId]);
  });

  it('ends live delegated children when the root is removed', async () => {
    const { hub, host, root } = await hostedSetup();
    const child = addController(hub, 'hosted');
    const { rpc } = await control(
      host,
      child,
      delegate(root, child.identity.publicKey, Date.now() + 60_000),
    );
    await hello(rpc);
    const closed = new Promise<void>((resolve) => rpc.onClose(() => resolve()));
    await host.service.forgetDevice({
      deviceId: root.deviceId,
      role: 'controller',
    });
    await closed;
  });

  it('lets a delegated session revoke its root, saved before the answer, touching no other pairing', async () => {
    const { hub, host, root, other } = await hostedSetup();
    const child = addController(hub, 'hosted');
    const { rpc } = await control(
      host,
      child,
      delegate(root, child.identity.publicKey, Date.now() + 60_000),
    );
    const closed = new Promise<void>((resolve) => rpc.onClose(() => resolve()));
    await expect(rpc.request(REMOTE_METHODS.pairRevoke, {})).resolves.toEqual({
      revoked: true,
    });
    expect(
      (await host.readSettings()).pairedControllers.map((pin) => pin.deviceId),
    ).toEqual([other.deviceId]);
    await closed;

    // A paired controller revokes only itself.
    const own = await control(host, other);
    await expect(
      own.rpc.request(REMOTE_METHODS.pairRevoke, {}),
    ).resolves.toEqual({
      revoked: true,
    });
    expect((await host.readSettings()).pairedControllers).toEqual([]);
  });

  it('refuses every method but hello and invoke to a Slack session, so it never revokes the hosted root (CAN-7604)', async () => {
    const { hub, host, root, other } = await hostedSetup();
    const child = addController(hub, 'hosted');
    const { rpc } = await control(
      host,
      child,
      delegate(root, child.identity.publicKey, Date.now() + 60_000, 'slack'),
    );
    await hello(rpc);
    await expect(rpc.request(REMOTE_METHODS.pairRevoke, {})).rejects.toThrow();
    expect(
      (await host.readSettings()).pairedControllers.map((pin) => pin.deviceId),
    ).toEqual([root.deviceId, other.deviceId]);
  });
});

// ---------------------------------------------------------------------------
// The single opt-in
// ---------------------------------------------------------------------------

describe('opt-in', () => {
  it('migrates the Portal opt-in once, retrying while Portal state is unreliable', async () => {
    const hub = new Hub();
    const host = await createHost(hub, {
      settings: { allowIncoming: false },
      portalReads: [{ reliable: false }, { reliable: true, active: true }],
    });
    // Unreliable read: settings untouched.
    expect(await host.readSettings()).toMatchObject({ allowIncoming: false });
    expect((await host.readSettings()).migratedOptIn).toBeUndefined();
    await until(async () => (await host.readSettings()).migratedOptIn === true);
    expect(await host.readSettings()).toMatchObject({ allowIncoming: true });
    const reads = host.portal.reads;
    host.service.dispose();

    // After a restart the migration does not run again.
    const restarted = await createHost(new Hub(), {
      dir: host.dir,
      portalReads: [{ reliable: true, active: false }],
    });
    expect(restarted.portal.reads).toBe(0);
    expect(reads).toBe(2);
    expect((await state(restarted)).allowIncoming).toBe(true);
  });

  it('never re-applies a stale Portal opt-in once the migration has run', async () => {
    // The user turned incoming off after migrating; portal-state.json still
    // records an active session.
    const host = await createHost(new Hub(), {
      settings: { allowIncoming: false, migratedOptIn: true },
      portalReads: [{ reliable: true, active: true }],
    });
    expect(host.portal.reads).toBe(0);
    expect((await state(host)).allowIncoming).toBe(false);
    expect(await host.readSettings()).toMatchObject({
      allowIncoming: false,
      migratedOptIn: true,
    });
  });

  it('turning off ends sessions and the pairing window but keeps pins', async () => {
    const hub = new Hub();
    const desktop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(desktop)] },
    });
    const { rpc } = await control(host, desktop);
    await hello(rpc);
    await host.service.openPairingWindow();
    const closed = new Promise<void>((resolve) => rpc.onClose(() => resolve()));
    await host.service.setAllowIncoming(false);
    await closed;
    expect(host.events).toContainEqual({
      type: 'window-closed',
      reason: 'disabled',
    });
    await expect(host.service.openPairingWindow()).rejects.toThrow();
    await expect(control(host, desktop)).rejects.toThrow();
    expect((await host.readSettings()).pairedControllers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Install identifier
// ---------------------------------------------------------------------------

describe('install identifier (remote-control:install-id)', () => {
  const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-install-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  };
  // Each read loads the modules afresh, as after a restart.
  const read = async (
    dir: string,
  ): Promise<{ installId: string; optIn: LegacyPortalOptInRead }> => {
    let result: { installId: string; optIn: LegacyPortalOptInRead } | null =
      null;
    await jest.isolateModulesAsync(async () => {
      const electron = await import('electron');
      jest.spyOn(electron.app, 'getPath').mockReturnValue(dir);
      const identity = await import('../../lib/install-identity');
      const legacy = await import('../legacy-portal-opt-in');
      result = {
        installId: await identity.readDurableInstallId(),
        optIn: await legacy.readLegacyPortalOptIn(),
      };
    });
    if (!result) throw new Error('No result.');
    return result;
  };
  const onDiskInstallId = async (dir: string): Promise<unknown> =>
    (
      JSON.parse(
        await readFile(join(dir, 'install-identity.json'), 'utf8'),
      ) as { installId?: unknown }
    ).installId;
  const legacyState = (input: {
    clientDeviceId: string;
    active?: boolean;
    lastStopReason?: string;
  }): string =>
    JSON.stringify({
      version: 1,
      clientDeviceId: input.clientDeviceId,
      ...(input.active
        ? {
            activeSession: {
              serverId: 'server',
              sessionId: 'session',
              commandCursor: 0,
              activatedAt: '2026-01-01T00:00:00.000Z',
              lastSeenAt: null,
            },
          }
        : {}),
      ...(input.lastStopReason ? { lastStopReason: input.lastStopReason } : {}),
    });

  it('adopts the identifier from portal-state.json and keeps it after that file is gone', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'portal-state.json'),
      legacyState({ clientDeviceId: 'legacy-install-id', active: true }),
    );
    const first = await read(dir);
    expect(first.installId).toBe('legacy-install-id');
    expect(first.optIn).toEqual({ reliable: true, active: true });
    expect(await onDiskInstallId(dir)).toBe('legacy-install-id');
    // The legacy file is left in place for older builds, unchanged.
    expect(
      JSON.parse(await readFile(join(dir, 'portal-state.json'), 'utf8')),
    ).toMatchObject({ clientDeviceId: 'legacy-install-id' });

    await rm(join(dir, 'portal-state.json'));
    const restarted = await read(dir);
    expect(restarted.installId).toBe('legacy-install-id');
    expect(restarted.optIn).toEqual({ reliable: true, active: false });
  });

  it('mints an identifier when neither file exists and keeps it across restarts', async () => {
    const dir = await tempDir();
    const first = await read(dir);
    expect(first.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.optIn).toEqual({ reliable: true, active: false });
    expect(await onDiskInstallId(dir)).toBe(first.installId);
    expect((await read(dir)).installId).toBe(first.installId);
  });

  it('adopts the legacy identifier when install-identity.json is corrupt', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'install-identity.json'), '{not json');
    await writeFile(
      join(dir, 'portal-state.json'),
      legacyState({ clientDeviceId: 'legacy-install-id' }),
    );
    expect((await read(dir)).installId).toBe('legacy-install-id');
    expect(await onDiskInstallId(dir)).toBe('legacy-install-id');
  });

  it('refuses to mint or adopt while either file is unreadable, then recovers', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    for (const blocked of ['install-identity.json', 'portal-state.json']) {
      const dir = await tempDir();
      await writeFile(
        join(dir, 'install-identity.json'),
        JSON.stringify({ version: 1, installId: 'saved-install-id' }),
      );
      await writeFile(
        join(dir, 'portal-state.json'),
        legacyState({ clientDeviceId: 'legacy-install-id' }),
      );
      if (blocked === 'portal-state.json') {
        await rm(join(dir, 'install-identity.json'));
      }
      await chmod(join(dir, blocked), 0o000);
      await expect(read(dir)).rejects.toMatchObject({ code: 'EACCES' });
      await chmod(join(dir, blocked), 0o600);
      expect((await read(dir)).installId).toBe(
        blocked === 'install-identity.json'
          ? 'saved-install-id'
          : 'legacy-install-id',
      );
    }
  });

  it('reads the legacy opt-in without writing, and treats a corrupt file as not active', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'portal-state.json'),
      legacyState({
        clientDeviceId: 'legacy-install-id',
        active: true,
        lastStopReason: 'local_disconnect',
      }),
    );
    // Stopped on purpose: not an opt-in.
    expect((await read(dir)).optIn).toEqual({ reliable: true, active: false });
    await writeFile(join(dir, 'portal-state.json'), '{not json');
    // The old store replaced an unparseable file with fresh state, so a
    // read-only reader reads it as not active instead of retrying forever.
    expect((await read(dir)).optIn).toEqual({ reliable: true, active: false });
    expect(await readFile(join(dir, 'portal-state.json'), 'utf8')).toBe(
      '{not json',
    );
  });
});

// ---------------------------------------------------------------------------
// Disconnect is not cancellation (CAN-4186)
// ---------------------------------------------------------------------------

describe('a closed controller session', () => {
  it('sends this computer no stop or cancel for a command it already accepted, and keeps serving another controller', async () => {
    const hub = new Hub();
    const browser = addController(hub, 'browser');
    const laptop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [pinned(browser, 'browser'), pinned(laptop)],
      },
    });
    const connected = async (controller: Controller): Promise<boolean> =>
      (await state(host)).controllers.some(
        (each) => each.deviceId === controller.deviceId && each.connected,
      );
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    const send = {
      schemaVersion: 1,
      commandId: 'command-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      command: {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Run the tests',
      },
    };
    expect(
      await fromBrowser.rpc.request(REMOTE_METHODS.invoke, {
        channel: 'chat:command',
        args: [send],
      }),
    ).toBe('ok');
    await until(() => connected(browser));

    fromBrowser.session.close('closed');
    await until(async () => !(await connected(browser)));
    expect(host.bridge.invokes).toEqual(['chat:command']);
    expect(host.bridge.invokeArgs).toEqual([[send]]);
    expect(host.bridge.posts).toEqual([]);

    const fromLaptop = await control(host, laptop);
    await hello(fromLaptop.rpc);
    expect(await invokeCode(fromLaptop.rpc, MOBILE_CHANNEL)).toBe('ok');
    expect(host.bridge.invokes).toEqual(['chat:command', MOBILE_CHANNEL]);
  });
});

// ---------------------------------------------------------------------------
// Web preview (CAN-7705)
// ---------------------------------------------------------------------------

describe('web preview', () => {
  interface PreviewSession {
    session: SecureSession;
    rpc: RpcPeer;
    tunnels: TunnelStreamMux;
    /** What the first hello advertised, if anything. */
    features: unknown;
    /** `session.ended` notices the controller received. */
    ended: unknown[];
  }

  const ASKS: Partial<HelloParams> = { webPreview: { version: 1 } };

  /** Every hello also offers resume, so "without resume" means something. */
  function helloParams(params: Partial<HelloParams>): HelloParams {
    return {
      version: VERSION,
      transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION },
      ...params,
    };
  }

  /** Says hello and keeps the resume the host agreed, as controllers do. */
  async function sayHello(
    control: { session: SecureSession; rpc: RpcPeer },
    params: Partial<HelloParams>,
  ): Promise<unknown> {
    const answer = HelloResultSchema.parse(
      await control.rpc.request(REMOTE_METHODS.hello, helloParams(params)),
    );
    control.session.setResumeNegotiated(
      (answer.transport?.resume ?? 0) >= REMOTE_TRANSPORT_RESUME_VERSION,
    );
    return answer.features?.webPreview;
  }

  /** A desktop controller's session, its events routed to its stream mux. */
  async function previewSession(
    host: Host,
    controller: Controller,
    params: Partial<HelloParams> = ASKS,
  ): Promise<PreviewSession> {
    const session = await controller.sessions.connect({
      peerDeviceId: host.identity.deviceId,
      purpose: 'control',
      pinnedPeerPublicKey: host.identity.publicKey,
    });
    let tunnels: TunnelStreamMux | null = null;
    const ended: unknown[] = [];
    const rpc = new RpcPeer(session, {
      onRequest: (): Promise<never> => Promise.reject(new Error('Not served.')),
      onEvent: (name, payload): void => {
        if (name === REMOTE_EVENTS.ended) ended.push(payload);
        tunnels?.handleEvent(name, payload);
      },
    });
    tunnels = new TunnelStreamMux({
      role: 'controller',
      transport: {
        notify: (name, payload, notifyOptions): boolean =>
          rpc.notify(name, payload, notifyOptions),
        request: (method, params, requestOptions): Promise<unknown> =>
          rpc.request(method, params, requestOptions),
      },
    });
    const mux = tunnels;
    rpc.onClose(() => mux.close());
    return {
      session,
      rpc,
      tunnels,
      features: await sayHello({ session, rpc }, params),
      ended,
    };
  }

  /** Fetches a page through one stream: the answer, or the open's code. */
  function fetchPage(tunnels: TunnelStreamMux, port: number): Promise<string> {
    const socket = tunnels.openStream('localhost', port, {
      class: 'loopback',
    });
    return new Promise((resolve) => {
      const parts: Buffer[] = [];
      socket.on('data', (part: Buffer) => parts.push(part));
      socket.once('end', () => resolve(Buffer.concat(parts).toString()));
      socket.once('error', (error: Error) =>
        resolve(error instanceof TunnelOpenError ? error.code : error.message),
      );
      socket.write(
        'GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      );
    });
  }

  /**
   * Opens a keep-alive stream and waits for its first answer; resolves
   * `closed` once the stream goes away.
   */
  async function heldStream(
    tunnels: TunnelStreamMux,
    port: number,
  ): Promise<{ closed: Promise<string> }> {
    const socket = tunnels.openStream('localhost', port, {
      class: 'loopback',
    });
    // A reset reaches the socket as an error before it closes.
    socket.on('error', () => undefined);
    const closed = new Promise<string>((resolve) => {
      socket.once('close', () => resolve('closed'));
    });
    await new Promise<void>((resolve) => {
      socket.once('data', () => resolve());
      socket.write('GET /next HTTP/1.1\r\nHost: localhost\r\n\r\n');
    });
    return { closed };
  }

  /**
   * The relay drops the link between the two, as when a laptop sleeps:
   * nothing crosses it, so neither side hears what the other sends.
   */
  function dropLink(host: Host, controller: Controller): void {
    host.hub.cut.add(`${host.identity.deviceId}>${controller.deviceId}`);
    host.hub.cut.add(`${controller.deviceId}>${host.identity.deviceId}`);
    host.hub.endpoints
      .get(host.identity.deviceId)
      ?.peerWent(controller.deviceId, 'offline');
    controller.endpoint.peerWent(host.identity.deviceId, 'offline');
  }

  /** The link is back: the controller asks to resume its sessions. */
  function restoreLink(host: Host, controller: Controller): void {
    host.hub.cut.delete(`${host.identity.deviceId}>${controller.deviceId}`);
    host.hub.cut.delete(`${controller.deviceId}>${host.identity.deviceId}`);
    controller.endpoint.peerWent(host.identity.deviceId, 'online');
  }

  const ADVERTISED = {
    version: 1,
    maxStreams: 256,
    initialWindowBytes: 256 * 1024,
    lan: false,
  };

  it('is advertised and served only with the flag on, to desktop controllers that ask', async () => {
    const servers = await startDevServers();
    cleanups.push(() => servers.stop());
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const off = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
    });
    // The flag is off: nothing is advertised or dialed.
    const unflagged = await previewSession(off, laptop);
    expect(unflagged.features).toBeUndefined();
    expect(await fetchPage(unflagged.tunnels, servers.port)).toBe(
      'unavailable',
    );

    const studio = addController(hub, 'desktop');
    const browser = addController(hub, 'browser');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [pinned(studio), pinned(browser, 'browser')],
      },
      webPreviewFlag: true,
    });
    const asking = await previewSession(host, studio);
    expect(asking.features).toEqual(ADVERTISED);
    expect(await fetchPage(asking.tunnels, servers.port)).toContain(NEXT_PAGE);
    // A desktop controller that didn't ask is neither told nor served.
    const silent = await previewSession(host, studio, {});
    expect(silent.features).toBeUndefined();
    expect(await fetchPage(silent.tunnels, servers.port)).toBe('unavailable');
    // Other controllers never are.
    const fromBrowser = await previewSession(host, browser);
    expect(fromBrowser.features).toBeUndefined();
    expect(host.service.webPreviewAllowed()).toBe(true);
  });

  it('serves opens once a hello negotiates preview, even after an earlier open was refused', async () => {
    const servers = await startDevServers();
    cleanups.push(() => servers.stop());
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    // The first hello did not ask, so the first open is refused...
    const early = await previewSession(host, laptop, {});
    expect(early.features).toBeUndefined();
    expect(await fetchPage(early.tunnels, servers.port)).toBe('unavailable');
    // ...and once a hello on the same session negotiates it, opens are served.
    expect(await sayHello(early, ASKS)).toEqual(ADVERTISED);
    expect(await fetchPage(early.tunnels, servers.port)).toContain(NEXT_PAGE);
  });

  it('turning the flag off resets streams and aborts a session that carried preview without resume; its reconnect gets no preview', async () => {
    const servers = await startDevServers();
    cleanups.push(() => servers.stop());
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const studio = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop), pinned(studio)] },
      webPreviewFlag: true,
    });
    const carrying = await previewSession(host, laptop);
    const quiet = await previewSession(host, studio);
    expect(carrying.session.resumeNegotiated).toBe(true);
    const held = await heldStream(carrying.tunnels, servers.port);

    host.setWebPreviewFlag(false);
    expect(await held.closed).toBe('closed');
    await until(() => carrying.session.isClosed);
    // Closed, not suspended: nothing is left to resume.
    expect(laptop.sessions.suspendedSessions(host.identity.deviceId)).toEqual(
      [],
    );
    // Not told to stay away, so it reconnects, and is not offered preview.
    expect(carrying.ended).toEqual([]);
    const again = await previewSession(host, laptop);
    expect(again.features).toBeUndefined();
    expect(await fetchPage(again.tunnels, servers.port)).toBe('unavailable');
    // A session that never carried preview stays, and opens nothing.
    expect(quiet.rpc.isClosed).toBe(false);
    expect(await fetchPage(quiet.tunnels, servers.port)).toBe('unavailable');

    // On again: the session that stayed, and negotiated it, serves again.
    host.setWebPreviewFlag(true);
    expect(await fetchPage(quiet.tunnels, servers.port)).toContain(NEXT_PAGE);

    // Off again: now it carried preview, it is aborted the same way.
    host.setWebPreviewFlag(false);
    await until(() => quiet.session.isClosed);
    expect(quiet.ended).toEqual([]);
    expect((await previewSession(host, studio)).features).toBeUndefined();
  });

  it('revokes preview while the flag service publishes initializing or error, though the snapshot keeps the earlier value', async () => {
    const servers = await startDevServers();
    cleanups.push(() => servers.stop());
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    const carrying = await previewSession(host, laptop);
    expect(await fetchPage(carrying.tunnels, servers.port)).toContain(
      NEXT_PAGE,
    );
    // Published initializing: the earlier true doesn't count.
    host.setWebPreviewFlagStatus('initializing');
    await until(() => carrying.session.isClosed);
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect((await previewSession(host, laptop)).features).toBeUndefined();
    // Evaluated again: on.
    host.setWebPreviewFlagStatus('ready');
    const again = await previewSession(host, laptop);
    expect(again.features).toEqual(ADVERTISED);
    expect(await fetchPage(again.tunnels, servers.port)).toContain(NEXT_PAGE);
    // Published error: off again.
    host.setWebPreviewFlagStatus('error');
    await until(() => again.session.isClosed);
    expect((await previewSession(host, laptop)).features).toBeUndefined();
  });

  it('refuses the resume of a suspended session that carried preview once preview is revoked, while one that never carried resumes', async () => {
    const servers = await startDevServers();
    cleanups.push(() => servers.stop());
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const studio = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop), pinned(studio)] },
      webPreviewFlag: true,
    });
    const carrying = await previewSession(host, laptop);
    const quiet = await previewSession(host, studio);
    expect(await fetchPage(carrying.tunnels, servers.port)).toContain(
      NEXT_PAGE,
    );
    dropLink(host, laptop);
    dropLink(host, studio);
    expect(carrying.session.state).toBe('suspended');
    expect(quiet.session.state).toBe('suspended');

    host.setWebPreviewFlag(false);
    // Nothing crossed the cut link: both controllers still wait to resume.
    await settle(50);
    expect(carrying.session.state).toBe('suspended');
    expect(quiet.session.state).toBe('suspended');
    const carryingStates: string[] = [];
    carrying.session.onStateChange((next) => carryingStates.push(next));
    restoreLink(host, laptop);
    restoreLink(host, studio);
    // The quiet session picks up where it was...
    await until(() => quiet.session.state === 'active');
    expect(await sayHello(quiet, ASKS)).toBeUndefined();
    // ...the one that carried preview has nothing to resume, so it closes
    // without ever being active again, so nothing it held is replayed,
    await until(() => carrying.session.isClosed);
    expect(carryingStates).not.toContain('active');
    expect(carrying.ended).toEqual([]);
    // and its controller's fresh hello is not offered preview.
    expect((await previewSession(host, laptop)).features).toBeUndefined();
  });

  it('when Allow incoming turns off, tells a connected controller it was revoked, and a suspended one is refused its resume and its reconnect', async () => {
    const servers = await startDevServers();
    cleanups.push(() => servers.stop());
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const studio = addController(hub, 'desktop');
    // This computer also controls one, so its relay stays up with Allow
    // incoming off and the suspended controller's resume reaches it.
    const office = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: {
        pairedControllers: [pinned(laptop), pinned(studio)],
        pairedHosts: [pinned(office)],
      },
      webPreviewFlag: true,
    });
    const connected = await previewSession(host, laptop);
    const asleep = await previewSession(host, studio);
    const held = await heldStream(connected.tunnels, servers.port);
    expect(await fetchPage(asleep.tunnels, servers.port)).toContain(NEXT_PAGE);
    dropLink(host, studio);

    await host.service.setAllowIncoming(false);
    expect(await held.closed).toBe('closed');
    await until(() => connected.session.isClosed);
    expect(connected.ended).toEqual([{ reason: 'revoked' }]);
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect(asleep.session.state).toBe('suspended');
    // The suspended controller never heard; its resume is refused...
    restoreLink(host, studio);
    await until(() => asleep.session.isClosed);
    expect(asleep.ended).toEqual([]);
    // ...and so is its reconnect, and the other's.
    await expect(previewSession(host, studio)).rejects.toThrow();
    await expect(previewSession(host, laptop)).rejects.toThrow();
  });

  it('ends a carrying session without resume and refuses other opens as soon as a narrowing starts, whether or not it saves', async () => {
    const servers = await startDevServers();
    cleanups.push(() => servers.stop());
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    const quiet = await previewSession(host, laptop);
    const carrying = await previewSession(host, laptop);
    const held = await heldStream(carrying.tunnels, servers.port);
    // The relay now says the device is a phone, so its pairing narrows. The
    // update is held, so the cached pairing still says desktop meanwhile.
    let releaseSave: () => void = () => undefined;
    host.store.gate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    laptop.endpoint.info.kind = 'mobile';
    const narrowing = laptop.sessions
      .connect({
        peerDeviceId: host.identity.deviceId,
        purpose: 'control',
        pinnedPeerPublicKey: host.identity.publicKey,
      })
      .then(
        () => 'connected',
        () => 'refused',
      );
    // The carrying session's streams reset and it ends at once, before the
    // save settles, without resume.
    expect(await held.closed).toBe('closed');
    await until(() => carrying.session.isClosed);
    expect(laptop.sessions.suspendedSessions(host.identity.deviceId)).toEqual(
      [],
    );
    expect(carrying.ended).toEqual([]);
    // The other session opens nothing while the narrowing waits.
    expect(await fetchPage(quiet.tunnels, servers.port)).toBe('unavailable');
    // The real store caches the narrowed pairing, then its write fails: a
    // directory where the file goes fails the rename whatever the
    // permissions.
    const settingsPath = join(host.dir, 'remote-control.json');
    await rm(settingsPath, { force: true });
    await mkdir(join(settingsPath, 'blocked'), { recursive: true });
    try {
      releaseSave();
      expect(await narrowing).toBe('refused');
    } finally {
      await rm(settingsPath, { recursive: true, force: true });
      host.store.gate = null;
    }
  });
  // Consent (CAN-7712): the host's own switch, saved in remote-web-preview.json.

  it('turning consent off resets streams and ends a session that carried preview without resume, admits none while it saves, and its reconnect gets no preview', async () => {
    const servers = await startDevServers();
    cleanups.push(() => servers.stop());
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const studio = addController(hub, 'desktop');
    const save: { release: (() => void) | null } = { release: null };
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop), pinned(studio)] },
      webPreviewFlag: true,
      webPreviewWrite: async (path, contents): Promise<void> => {
        if (contents.includes('"allowWebPreview": false'))
          await new Promise<void>((resolve) => {
            save.release = resolve;
          });
        await writeFile(path, contents);
      },
    });
    expect((await state(host)).allowWebPreview).toBe(true);
    const carrying = await previewSession(host, laptop);
    const quiet = await previewSession(host, studio);
    const held = await heldStream(carrying.tunnels, servers.port);
    // The switch is this computer's own: a paired computer can't turn it.
    expect(
      await invokeCodeWith(
        carrying.rpc,
        IPC_CHANNELS.remoteControlSetAllowWebPreview,
        [false],
      ),
    ).toBe('remote_channel_unavailable');
    expect(host.service.webPreviewAllowed()).toBe(true);

    const optingOut = host.service.setAllowWebPreview(false);
    // Revoked while the save is still held.
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect(await held.closed).toBe('closed');
    await until(() => carrying.session.isClosed);
    expect(laptop.sessions.suspendedSessions(host.identity.deviceId)).toEqual(
      [],
    );
    expect(carrying.ended).toEqual([]);
    // Nothing is admitted while the opt-out saves.
    await until(() => save.release !== null);
    const meanwhile = await previewSession(host, laptop);
    expect(meanwhile.features).toBeUndefined();
    expect(await fetchPage(meanwhile.tunnels, servers.port)).toBe(
      'unavailable',
    );
    save.release?.();
    expect((await optingOut).allowWebPreview).toBe(false);

    const again = await previewSession(host, laptop);
    expect(again.features).toBeUndefined();
    // A session that never carried preview stays, and opens nothing.
    expect(quiet.rpc.isClosed).toBe(false);
    expect(await fetchPage(quiet.tunnels, servers.port)).toBe('unavailable');

    // An opt-in counts once saved; the session that stayed serves again.
    expect((await host.service.setAllowWebPreview(true)).allowWebPreview).toBe(
      true,
    );
    expect(await fetchPage(quiet.tunnels, servers.port)).toContain(NEXT_PAGE);
  });

  it('writes an off chosen during a slow on after it, so the off always wins, and counts the on only once saved', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const written: boolean[] = [];
    const onSave: { release: (() => void) | null } = { release: null };
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewConsent: false,
      webPreviewWrite: async (path, contents): Promise<void> => {
        const on = contents.includes('"allowWebPreview": true');
        if (on)
          await new Promise<void>((resolve) => {
            onSave.release = resolve;
          });
        written.push(on);
        await writeFile(path, contents);
      },
    });
    const optingIn = host.service.setAllowWebPreview(true);
    await until(() => onSave.release !== null);
    // The on is still saving: not counted yet.
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect((await previewSession(host, laptop)).features).toBeUndefined();
    const optingOut = host.service.setAllowWebPreview(false);
    onSave.release?.();
    await optingIn;
    expect((await optingOut).allowWebPreview).toBe(false);
    expect(written).toEqual([true, false]);
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect(await readFile(host.webPreviewPath, 'utf8')).toContain(
      '"allowWebPreview": false',
    );
    host.service.dispose();
    const restarted = await createHost(hub, {
      dir: host.dir,
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    expect((await state(restarted)).allowWebPreview).toBe(false);
  });

  it('folds quick toggles into the next write, never writing on behind an off', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const written: boolean[] = [];
    const firstSave: { release: (() => void) | null } = { release: null };
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewWrite: async (path, contents): Promise<void> => {
        if (written.length === 0 && firstSave.release === null)
          await new Promise<void>((resolve) => {
            firstSave.release = resolve;
          });
        written.push(contents.includes('"allowWebPreview": true'));
        await writeFile(path, contents);
      },
    });
    // Off, on, off in quick succession, the first save still under way.
    const toggles = Promise.allSettled([
      host.service.setAllowWebPreview(false),
      host.service.setAllowWebPreview(true),
      host.service.setAllowWebPreview(false),
    ]);
    expect(host.service.webPreviewAllowed()).toBe(false);
    await until(() => firstSave.release !== null);
    firstSave.release?.();
    await toggles;
    expect(written).toEqual([false]);
    expect(host.service.webPreviewAllowed()).toBe(false);
  });

  it('keeps preview off when an opt-out fails to save, and saves it once the disk recovers so a restart keeps it off', async () => {
    const servers = await startDevServers();
    cleanups.push(() => servers.stop());
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    let failing = false;
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewRetryMs: 20,
      webPreviewWrite: async (path, contents): Promise<void> => {
        if (failing) throw new Error('Disk is full.');
        await writeFile(path, contents);
      },
    });
    const carrying = await previewSession(host, laptop);
    expect(await fetchPage(carrying.tunnels, servers.port)).toContain(
      NEXT_PAGE,
    );
    failing = true;
    const broadcastsBefore = host.broadcasts.length;
    await expect(host.service.setAllowWebPreview(false)).rejects.toThrow();
    // Revoked all the same.
    await until(() => carrying.session.isClosed);
    expect(host.service.webPreviewAllowed()).toBe(false);
    // The Settings switch hears it is off, though the call failed.
    await until(() => host.broadcasts.length > broadcastsBefore);
    expect(host.broadcasts.at(-1)?.allowWebPreview).toBe(false);
    expect((await previewSession(host, laptop)).features).toBeUndefined();
    // Once the disk takes writes again, the retry saves the off...
    failing = false;
    await until(async () =>
      (await readFile(host.webPreviewPath, 'utf8')).includes(
        '"allowWebPreview": false',
      ),
    );
    host.service.dispose();
    // ...so a restart keeps preview off.
    const restarted = await createHost(hub, {
      dir: host.dir,
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    expect((await state(restarted)).allowWebPreview).toBe(false);
    expect((await previewSession(restarted, laptop)).features).toBeUndefined();
  });

  it('does not take an opt-in whose save failed, so neither a retry nor the quit saves it', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    let failing = true;
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewConsent: 'missing',
      webPreviewRetryMs: 20,
      webPreviewWrite: async (path, contents): Promise<void> => {
        if (failing) throw new Error('Disk is full.');
        await writeFile(path, contents);
      },
    });
    expect((await state(host)).allowWebPreview).toBe(false);
    await expect(host.service.setAllowWebPreview(true)).rejects.toThrow();
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect((await state(host)).allowWebPreview).toBe(false);
    // The disk recovers: nothing saves the opt-in that failed.
    failing = false;
    await settle(80);
    await host.webPreviewStore.flush();
    host.service.dispose();
    const saved = await readFile(host.webPreviewPath, 'utf8').catch(() => '');
    expect(saved).not.toContain('"allowWebPreview": true');
  });

  it('falls back to off when an opt-in fails after a failed opt-out, so the retry and the quit write off, never the old on', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    let failing = false;
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewRetryMs: 20,
      webPreviewWrite: async (path, contents): Promise<void> => {
        if (failing) throw new Error('Disk is full.');
        await writeFile(path, contents);
      },
    });
    expect((await state(host)).allowWebPreview).toBe(true);
    failing = true;
    await expect(host.service.setAllowWebPreview(false)).rejects.toThrow();
    await expect(host.service.setAllowWebPreview(true)).rejects.toThrow();
    // The file may hold either value; the failed opt-in is not taken.
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect((await state(host)).allowWebPreview).toBe(false);
    // The disk recovers: the retry writes off, never the on it held before.
    failing = false;
    await until(async () =>
      (await readFile(host.webPreviewPath, 'utf8')).includes(
        '"allowWebPreview": false',
      ),
    );
    await settle(80);
    await host.webPreviewStore.flush();
    host.service.dispose();
    expect(await readFile(host.webPreviewPath, 'utf8')).toContain(
      '"allowWebPreview": false',
    );
    expect(host.service.webPreviewAllowed()).toBe(false);
    const restarted = await createHost(hub, {
      dir: host.dir,
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    expect((await state(restarted)).allowWebPreview).toBe(false);
  });

  it('keeps preview off after an opt-out until a later opt-in is saved, though the earlier on is still in the file', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const written: boolean[] = [];
    const held: Array<() => void> = [];
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewWrite: async (path, contents): Promise<void> => {
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });
        written.push(contents.includes('"allowWebPreview": true'));
        await writeFile(path, contents);
      },
    });
    expect((await state(host)).allowWebPreview).toBe(true);
    const optingOut = host.service.setAllowWebPreview(false);
    await until(() => held.length === 1);
    // On again while the off is still saving: the file still holds the
    // earlier on, but that on came before the opt-out and doesn't count.
    const optingIn = host.service.setAllowWebPreview(true);
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect((await previewSession(host, laptop)).features).toBeUndefined();
    held[0]?.();
    expect((await optingOut).allowWebPreview).toBe(false);
    await until(() => held.length === 2);
    // The opt-in's own write is under way: still off.
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect((await previewSession(host, laptop)).features).toBeUndefined();
    held[1]?.();
    expect((await optingIn).allowWebPreview).toBe(true);
    expect(written).toEqual([false, true]);
    expect(host.service.webPreviewAllowed()).toBe(true);
  });

  it('holds an opt-out made before the consent file was first read, though the file held on', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    let optingOut: Promise<unknown> = Promise.resolve();
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      beforeInitialize: (service): void => {
        optingOut = service.setAllowWebPreview(false);
      },
    });
    await optingOut;
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect((await state(host)).allowWebPreview).toBe(false);
    expect((await previewSession(host, laptop)).features).toBeUndefined();
    expect(await readFile(host.webPreviewPath, 'utf8')).toContain(
      '"allowWebPreview": false',
    );
  });

  it('reports a failed save to the choice it carried: an opt-in folded over an opt-out fails, the overtaken opt-out does not', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const written: boolean[] = [];
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewConsent: false,
      webPreviewRetryMs: 60_000,
      webPreviewWrite: async (path, contents): Promise<void> => {
        await writeFile(path, contents);
        // The on reaches the file, then its directory's fsync fails.
        if (contents.includes('"allowWebPreview": true'))
          throw new Error('fsync failed.');
        written.push(false);
      },
    });
    const outcome = (saving: Promise<unknown>): Promise<string> =>
      saving.then(
        () => 'done',
        () => 'failed',
      );
    // Off then on before either is written: one write carries the on.
    const optingOut = outcome(host.service.setAllowWebPreview(false));
    const optingIn = outcome(host.service.setAllowWebPreview(true));
    expect(await optingIn).toBe('failed');
    expect(await optingOut).toBe('done');
    // The failed opt-in falls back to off, which is written over the on.
    await until(() => written.length > 0);
    expect(host.service.webPreviewAllowed()).toBe(false);
    expect((await state(host)).allowWebPreview).toBe(false);
    expect(await readFile(host.webPreviewPath, 'utf8')).toContain(
      '"allowWebPreview": false',
    );
  });

  it('counts an opt-in at once when its write finds on already saved, after an earlier write of on lands', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const written: boolean[] = [];
    const firstSave: { release: (() => void) | null } = { release: null };
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewConsent: false,
      webPreviewWrite: async (path, contents): Promise<void> => {
        if (written.length === 0 && firstSave.release === null)
          await new Promise<void>((resolve) => {
            firstSave.release = resolve;
          });
        written.push(contents.includes('"allowWebPreview": true'));
        await writeFile(path, contents);
      },
    });
    const first = host.service.setAllowWebPreview(true);
    await until(() => firstSave.release !== null);
    const optingOut = host.service.setAllowWebPreview(false);
    const optingIn = host.service.setAllowWebPreview(true);
    // The first on is still saving and an opt-out followed it: off.
    expect(host.service.webPreviewAllowed()).toBe(false);
    firstSave.release?.();
    await Promise.all([first, optingOut]);
    expect((await optingIn).allowWebPreview).toBe(true);
    // On was durably in the file when the later opt-in's write came to run,
    // so nothing more was written.
    expect(written).toEqual([true]);
    expect(host.service.webPreviewAllowed()).toBe(true);
  });

  it('writes an off chosen during an opt-in whose write landed and then failed, never trusting the old saved value', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const onSave: { release: (() => void) | null } = { release: null };
    let failOn = true;
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewConsent: false,
      webPreviewRetryMs: 60_000,
      webPreviewWrite: async (path, contents): Promise<void> => {
        const on = contents.includes('"allowWebPreview": true');
        if (on)
          await new Promise<void>((resolve) => {
            onSave.release = resolve;
          });
        await writeFile(path, contents);
        // The rename landed; the directory's fsync fails.
        if (on && failOn) {
          failOn = false;
          throw new Error('fsync failed.');
        }
      },
    });
    const optingIn = host.service.setAllowWebPreview(true).then(
      () => 'saved',
      () => 'failed',
    );
    await until(() => onSave.release !== null);
    const optingOut = host.service.setAllowWebPreview(false);
    onSave.release?.();
    expect(await optingIn).toBe('failed');
    expect((await optingOut).allowWebPreview).toBe(false);
    expect(await readFile(host.webPreviewPath, 'utf8')).toContain(
      '"allowWebPreview": false',
    );
    host.service.dispose();
    const restarted = await createHost(hub, {
      dir: host.dir,
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    expect((await state(restarted)).allowWebPreview).toBe(false);
  });

  it('saves an opt-out whose save was still in flight when the app quit, and then failed', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    let failFirst: (error: Error) => void = () => undefined;
    let writes = 0;
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewRetryMs: 60_000,
      webPreviewWrite: (path, contents): Promise<void> => {
        writes += 1;
        if (writes > 1) return writeFile(path, contents);
        return new Promise((_resolve, reject) => {
          failFirst = reject;
        });
      },
    });
    const optingOut = host.service.setAllowWebPreview(false).then(
      () => 'saved',
      () => 'failed',
    );
    await until(() => writes === 1);
    // The app quits while that save is still in flight; then it fails.
    const quitting = host.webPreviewStore.flush();
    failFirst(new Error('Disk is full.'));
    expect(await optingOut).toBe('failed');
    await quitting;
    host.service.dispose();
    expect(await readFile(host.webPreviewPath, 'utf8')).toContain(
      '"allowWebPreview": false',
    );
  });

  it('saves an unsaved opt-out when the app quits, before its retry is due, and takes no change after that', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    let failing = true;
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewRetryMs: 60_000,
      webPreviewWrite: async (path, contents): Promise<void> => {
        if (failing) throw new Error('Disk is full.');
        await writeFile(path, contents);
      },
    });
    await expect(host.service.setAllowWebPreview(false)).rejects.toThrow();
    // The disk recovers, and the app quits long before the retry is due.
    failing = false;
    await host.webPreviewStore.flush();
    // Nothing would save a change made after the flush, so none is taken.
    await expect(host.service.setAllowWebPreview(true)).rejects.toThrow();
    host.service.dispose();
    expect(await readFile(host.webPreviewPath, 'utf8')).toContain(
      '"allowWebPreview": false',
    );
    const restarted = await createHost(hub, {
      dir: host.dir,
      webPreviewFlag: true,
    });
    expect((await state(restarted)).allowWebPreview).toBe(false);
  });

  it('reads off when the first read fails with EIO or EACCES, and writes an opt-out over the on still in the file', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    for (const code of ['EIO', 'EACCES']) {
      const written: string[] = [];
      const host = await createHost(hub, {
        settings: { pairedControllers: [pinned(laptop)] },
        webPreviewFlag: true,
        webPreviewRead: (): Promise<string> =>
          Promise.reject(
            Object.assign(new Error(`${code}: consent file`), { code }),
          ),
        webPreviewWrite: async (path, contents): Promise<void> => {
          written.push(contents);
          await writeFile(path, contents);
        },
      });
      // The file holds on, but the read failed: off, and its value unknown.
      expect(
        JSON.parse(await readFile(host.webPreviewPath, 'utf8')),
      ).toMatchObject({ allowWebPreview: true });
      expect((await state(host)).allowWebPreview).toBe(false);
      expect((await previewSession(host, laptop)).features).toBeUndefined();
      // Settings is told, so the person can save off (the switch alone
      // could only turn preview on).
      expect((await state(host)).webPreviewChoiceUnread).toBe(true);
      // So the opt-out is written, not skipped as already saved.
      const saved = await host.service.setAllowWebPreview(false);
      expect(written).toHaveLength(1);
      expect(saved.allowWebPreview).toBe(false);
      expect(saved.webPreviewChoiceUnread).toBe(false);
      await host.webPreviewStore.flush();
      host.service.dispose();
      // Once reads work again, a restart keeps preview off.
      const restarted = await createHost(hub, {
        dir: host.dir,
        settings: { pairedControllers: [pinned(laptop)] },
        webPreviewFlag: true,
      });
      expect((await state(restarted)).allowWebPreview).toBe(false);
      restarted.service.dispose();
    }
  });

  it('offers to save off after a failed first read while the flag is off, and saves it', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: false,
      webPreviewRead: (): Promise<string> =>
        Promise.reject(
          Object.assign(new Error('EIO: consent file'), { code: 'EIO' }),
        ),
    });
    // The flag hides the switch, not the state Settings needs to offer off.
    expect((await state(host)).webPreviewChoiceUnread).toBe(true);
    const saved = await host.service.setAllowWebPreview(false);
    expect(saved.webPreviewChoiceUnread).toBe(false);
    expect(JSON.parse(await readFile(host.webPreviewPath, 'utf8'))).toEqual({
      version: 1,
      allowWebPreview: false,
    });
  });

  it('stops offering to save off once the person has chosen, even when that save failed after a failed first read', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewRetryMs: 60_000,
      webPreviewRead: (): Promise<string> =>
        Promise.reject(
          Object.assign(new Error('EIO: consent file'), { code: 'EIO' }),
        ),
      webPreviewWrite: (): Promise<void> =>
        Promise.reject(new Error('Disk is full.')),
    });
    expect((await state(host)).webPreviewChoiceUnread).toBe(true);
    // The person turns it off; the save fails and is reported, and off is
    // retried in the background, so the notice has done its job.
    await expect(host.service.setAllowWebPreview(false)).rejects.toThrow();
    const after = await state(host);
    expect(after.allowWebPreview).toBe(false);
    expect(after.webPreviewChoiceUnread).toBe(false);
  });

  it('writes nothing at quit after a failed first read when no choice was made, so a saved opt-in survives', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const written: string[] = [];
    const host = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewRead: (): Promise<string> =>
        Promise.reject(
          Object.assign(new Error('EIO: consent file'), { code: 'EIO' }),
        ),
      webPreviewWrite: async (path, contents): Promise<void> => {
        written.push(contents);
        await writeFile(path, contents);
      },
    });
    expect((await state(host)).allowWebPreview).toBe(false);
    // Settings is told the saved choice couldn't be read.
    expect((await state(host)).webPreviewChoiceUnread).toBe(true);
    // The app quits without the person touching the switch.
    await host.webPreviewStore.flush();
    host.service.dispose();
    expect(written).toEqual([]);
    // The opt-in is still the file the restart reads (nothing re-seeds it).
    expect(
      JSON.parse(await readFile(host.webPreviewPath, 'utf8')),
    ).toMatchObject({ allowWebPreview: true });
    const restarted = await createHost(hub, {
      dir: host.dir,
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    expect((await state(restarted)).allowWebPreview).toBe(true);
  });

  it('saves consent in its own file, which a remote-control.json write never drops, and reads a missing, damaged or blocked file as off, never skipping the next save after a damaged or blocked one', async () => {
    const hub = new Hub();
    const laptop = addController(hub, 'desktop');
    const first = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    await first.service.setAllowWebPreview(false);
    expect(JSON.parse(await readFile(first.webPreviewPath, 'utf8'))).toEqual({
      version: 1,
      allowWebPreview: false,
    });
    // This build's own remote-control.json writes never carry it.
    await first.service.setAllowRemoteUpdates(true);
    expect(await first.readSettings()).not.toHaveProperty('allowWebPreview');
    first.service.dispose();

    // An older build rewrites remote-control.json in its own format.
    const restarted = await createHost(hub, {
      dir: first.dir,
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
    });
    expect((await state(restarted)).allowWebPreview).toBe(false);
    expect((await previewSession(restarted, laptop)).features).toBeUndefined();
    restarted.service.dispose();

    // A file that can't be parsed reads as off.
    await writeFile(first.webPreviewPath, '{"allowWebPreview": tru');
    const damaged = await createHost(hub, {
      dir: first.dir,
      webPreviewFlag: true,
    });
    expect((await state(damaged)).allowWebPreview).toBe(false);
    expect(damaged.service.webPreviewAllowed()).toBe(false);
    // Its value is unknown, so an opt-out is written, never skipped as saved.
    await damaged.service.setAllowWebPreview(false);
    expect(JSON.parse(await readFile(first.webPreviewPath, 'utf8'))).toEqual({
      version: 1,
      allowWebPreview: false,
    });
    damaged.service.dispose();

    // So does a directory where the file goes.
    await rm(first.webPreviewPath, { force: true });
    await mkdir(join(first.webPreviewPath, 'blocked'), { recursive: true });
    const blocked = await createHost(hub, {
      dir: first.dir,
      webPreviewFlag: true,
    });
    expect((await state(blocked)).allowWebPreview).toBe(false);
    expect(blocked.service.webPreviewAllowed()).toBe(false);
    // An opt-out is tried, and its failure reported, never taken as saved.
    await expect(blocked.service.setAllowWebPreview(false)).rejects.toThrow();
    expect(blocked.service.webPreviewAllowed()).toBe(false);
    blocked.service.dispose();

    // And no file at all: preview is off until the person turns it on.
    const fresh = await createHost(hub, {
      settings: { pairedControllers: [pinned(laptop)] },
      webPreviewFlag: true,
      webPreviewConsent: 'missing',
    });
    expect((await state(fresh)).allowWebPreview).toBe(false);
    expect((await previewSession(fresh, laptop)).features).toBeUndefined();
    expect((await fresh.service.setAllowWebPreview(true)).allowWebPreview).toBe(
      true,
    );
    expect((await previewSession(fresh, laptop)).features).toEqual(ADVERTISED);
  });
});
