/**
 * Remote Control host authorization, end to end through RemoteControlService:
 * real handshakes, real encrypted sessions and the real settings store, over
 * an in-memory relay that reports authenticated presence like the device
 * relay does. A break here lets a controller act beyond its profile, pair
 * without consent, or outlive a revocation.
 */
import { sign } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DeviceKind,
  DeviceRelayDeviceInfo,
} from '@canopy/protocol/device-relay';
import {
  HOSTED_DELEGATION_MAX_MS,
  HelloResultSchema,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
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
  HOSTED_CHAT_COMMAND_FIELDS,
  HOSTED_CONTROLLER_CHANNELS,
  HOSTED_IPC_CHANNELS,
  HOSTED_TASK_CHANNELS,
  MOBILE_CONTROLLER_CHANNELS,
  hostedInvocationAllowed,
  browserInvocationAllowed,
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
import type { HostBridge } from '../host/bridge-window';
import { pairingProofFor } from '../host/controller-profile';
import { mergeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import {
  HOSTED_CHAT_COMMAND_REFUSAL,
  HOSTED_MODEL_PROVIDER_REFUSAL,
  HOSTED_SECRET_ANSWER_REFUSAL,
  HOSTED_SLACK_REQUESTS_OFF_REFUSAL,
  HOSTED_SLACK_REQUESTS_UNAVAILABLE_REFUSAL,
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
import { RpcPeer, RpcRemoteError } from '../transport/rpc-peer';
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
  private readonly links = new Map<string, Promise<void>>();

  deliver(from: string, to: string, payload: Buffer): boolean {
    const target = this.endpoints.get(to);
    if (!target?.online) return false;
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

  // Presence never changes here, so nothing announces a peer online.
  onPeerOnline(): () => void {
    return () => undefined;
  }

  onUndeliverable(listener: (peer: string) => void): () => void {
    this.undeliverable.add(listener);
    return () => this.undeliverable.delete(listener);
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
  mainPush: (channel: string, args: unknown[]) => void;
  portal: { reads: number };
  readSettings: () => Promise<RemoteControlFile>;
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
  const dispatchHostedChatCommand = createHostedChatDispatcher({
    validate: (request) => validateChatCommandRequest(request),
    dispatch: (request, attribution, options): Promise<ChatCommandResult> => {
      hostedChat.dispatched.push({
        request,
        attribution,
        ...(options === undefined ? {} : { options }),
      });
      const command = request.command;
      if (command.type === 'chat.create_tab') {
        hostedChat.tabs.set(command.tabId, command.model);
      }
      const runnable =
        command.type !== 'chat.send_message' ||
        hostedChat.tabs.get(command.chatId) !== undefined;
      return Promise.resolve({
        commandId: request.commandId,
        revision: 1,
        outcome: runnable ? 'applied' : 'rejected',
        ...(command.type === 'chat.send_message'
          ? { entityId: command.chatId, messageId: command.userMessageId }
          : {}),
      });
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
    signedInAccount: (): string =>
      options.signedInAccount ?? `account:${ACCOUNT_USER_ID}`,
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
    ): Promise<HostBridge> => {
      bridge.created.push({ controllerDeviceId, exact });
      return Promise.resolve({
        getChatInterest: (): undefined => undefined,
        window: null,
        invoke: (channel: string, args: unknown[]): Promise<unknown> => {
          bridge.invokes.push(channel);
          bridge.invokeArgs.push(args);
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
    broadcastState: (): void => undefined,
    broadcastPairingEvent: (event): void => {
      events.push(event);
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
    mainPush: (channel, args): void => {
      for (const listener of Array.from(mainListeners)) listener(channel, args);
    },
    portal,
    readSettings: async (): Promise<RemoteControlFile> =>
      JSON.parse(await readFile(settingsPath, 'utf8')) as RemoteControlFile,
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

  it('serves the archive recovery list, Resolve and Finish to browsers and desktops only (CAN-7439, CAN-7444)', async () => {
    // The list is a read under the bridge's `core.worktree.read`; the
    // revision tokens it returns are accepted only by Resolve and Finish.
    // The bridge principal is the same for every controller kind, so the
    // profile lists alone keep mobile and hosted controllers out.
    const list = IPC_CHANNELS.worktreeRecoveryList;
    const actions = [
      IPC_CHANNELS.worktreeRecoveryResolve,
      IPC_CHANNELS.worktreeRecoveryFinish,
    ];
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
      expect(await invokeCode(fromHosted.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    const fromPhone = await control(host, phone);
    await hello(fromPhone.rpc, {
      version: VERSION,
      controller: { kind: 'mobile', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const channel of [list, ...actions])
      expect(await invokeCode(fromPhone.rpc, channel)).toBe(
        'remote_channel_unavailable',
      );
    expect(host.bridge.invokes).toEqual([]);
    const fromDesktop = await control(host, desktop);
    await hello(fromDesktop.rpc, { version: VERSION });
    for (const action of actions)
      expect(await invokeCode(fromDesktop.rpc, action)).toBe('ok');
    expect(host.bridge.invokes).toEqual(actions);
    const fromBrowser = await control(host, browser);
    await hello(fromBrowser.rpc, {
      version: VERSION,
      controller: { kind: 'browser', minVersion: REMOTE_PROTOCOL_VERSION },
    });
    for (const action of actions)
      expect(await invokeCode(fromBrowser.rpc, action)).toBe('ok');
    expect(await invokeCode(fromBrowser.rpc, list)).toBe('ok');
    expect(host.bridge.invokes).toEqual([...actions, ...actions, list]);
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
    ['work-entries:delete', IPC_CHANNELS.workEntriesDelete],
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
    const { rpc } = await control(
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
    return { host, root, invoke, request, rpc, child };
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
      envelope({ type: 'chat.close_tab', chatId: 'chat-1' }),
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
