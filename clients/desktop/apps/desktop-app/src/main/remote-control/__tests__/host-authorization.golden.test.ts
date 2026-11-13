/**
 * Remote Control host authorization, end to end through RemoteControlService:
 * real handshakes, real encrypted sessions and the real settings store, over
 * an in-memory relay that reports authenticated presence like the device
 * relay does. A break here lets a controller act beyond its profile, pair
 * without consent, or outlive a revocation.
 */
import { sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  hostedDelegationSigningBytes,
  parsePairingFragment,
  type HelloParams,
  type HostedDelegation,
} from '@canopy/protocol/remote-control';
import {
  BROWSER_CONTROLLER_CHANNELS,
  HOSTED_CONTROLLER_CHANNELS,
  HOSTED_IPC_CHANNELS,
  MOBILE_CONTROLLER_CHANNELS,
} from '@canopy/protocol/remote-control/channels';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  ChatCommandExecutionOptions,
  ChatCommandRequest,
  ChatCommandResult,
  PersistedPendingQuestion,
  RemoteControlPairingEvent,
  RemoteControlState,
} from '@canopy/desktop-shared/types';
import { validateChatCommandRequest } from '../../ipc/chat-state';
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
import {
  HOSTED_SECRET_ANSWER_REFUSAL,
  createHostedChatDispatcher,
  type HostedChatAttribution,
  type HostedQuestionAnswerRequest,
} from '../host/hosted-chat-dispatch';
import { RemoteUploadStore } from '../host/uploads';
import {
  RemoteAccessStore,
  type RemoteControlFile,
} from '../remote-access-store';
import {
  RemoteControlService,
  type PortalOptInRead,
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
  settings?: Partial<RemoteControlFile>;
  portalReads?: PortalOptInRead[];
  portalEnabled?: boolean;
  pairingWindowMs?: number;
  dir?: string;
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
  mainPush: (channel: string, args: unknown[]) => void;
  portal: { starts: number; stops: number; reads: number };
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
    emitPush: (channel, args): void => {
      for (const listener of Array.from(pushListeners)) listener(channel, args);
    },
  };
  const events: RemoteControlPairingEvent[] = [];
  const portal = { starts: 0, stops: 0, reads: 0 };
  const portalReads = [
    ...(options.portalReads ?? [{ reliable: true, active: false }]),
  ];
  const uploads = new RemoteUploadStore(join(dir, 'uploads'));
  const hostedChat: HostedChatLog = {
    dispatched: [],
    answers: [],
    questions: new Map(),
    tabs: new Map(),
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
          : { model },
      ),
    modelRefusal: (_target, model) =>
      Promise.resolve(
        model === 'blocked-model'
          ? 'This model is blocked by your organization policy.'
          : null,
      ),
    pendingQuestion: (_scope, chatId, questionId) => {
      const question = hostedChat.questions.get(questionId);
      return Promise.resolve(
        question?.chatId === chatId ? question : undefined,
      );
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
    isFeatureEnabled: (): boolean => true,
    signedInAccount: (): string =>
      options.signedInAccount ?? `account:${ACCOUNT_USER_ID}`,
    ...(options.hostedChat === false ? {} : { dispatchHostedChatCommand }),
    deviceName: (): string => 'Host',
    platform: 'darwin',
    version: VERSION,
    createBridge: (): Promise<HostBridge> =>
      Promise.resolve({
        getChatInterest: (): undefined => undefined,
        window: null,
        invoke: (channel: string, args: unknown[]): Promise<unknown> => {
          bridge.invokes.push(channel);
          bridge.invokeArgs.push(args);
          return Promise.resolve(options.invokeResult ?? 'ok');
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
      }),
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
    readPortalOptIn: (): Promise<PortalOptInRead> => {
      portal.reads += 1;
      return Promise.resolve(
        portalReads.length > 1
          ? (portalReads.shift() ?? { reliable: false })
          : (portalReads[0] ?? { reliable: false }),
      );
    },
    portal: {
      isEnabled: (): boolean => options.portalEnabled === true,
      start: (): Promise<void> => {
        portal.starts += 1;
        return Promise.resolve();
      },
      stop: (): Promise<void> => {
        portal.stops += 1;
        return Promise.resolve();
      },
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
): HostedDelegation {
  return {
    rootPublicKey: root.publicKey,
    sessionPublicKey: sessionKey,
    expiresAt,
    signature: encodeBase64Url(
      sign(
        null,
        hostedDelegationSigningBytes(sessionKey, expiresAt),
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
    for (const channel of Object.values(added)) {
      expect(BROWSER_CONTROLLER_CHANNELS).toContain(channel);
      expect(MOBILE_CONTROLLER_CHANNELS).not.toContain(channel);
      expect(HOSTED_CONTROLLER_CHANNELS).not.toContain(channel);
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
    expect(host.bridge.invokes).toEqual(Object.values(added));
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
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

// The service methods behind remote-control:open-pairing-window,
// remote-control:close-pairing-window and the remote-control:pairing-event
// push (api.remoteControl.openPairingWindow, closePairingWindow and
// onPairingEvent are pass-throughs to them).
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

  async function delegatedSession(options: HostOptions = {}): Promise<{
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
      delegate(root, child.identity.publicKey, Date.now() + 60_000),
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
      envelope({ ...send, planReviewApproval: { approved: true } }),
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
    for (const channel of [NOT_A_MOBILE_CHANNEL, 'chat:send-message']) {
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

  it('tunnels every hosted channel, including the read channels added for hosted agents', () => {
    expect({
      githubGetPrState: IPC_CHANNELS.githubGetPrState,
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

  it('turning off ends sessions, the pairing window and Portal but keeps pins; turning on starts Portal only when its flag is on', async () => {
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
    expect(host.portal.stops).toBe(1);
    expect(host.events).toContainEqual({
      type: 'window-closed',
      reason: 'disabled',
    });
    await expect(host.service.openPairingWindow()).rejects.toThrow();
    await expect(control(host, desktop)).rejects.toThrow();
    expect((await host.readSettings()).pairedControllers).toHaveLength(1);
    await host.service.setAllowIncoming(true);
    expect(host.portal.starts).toBe(0);

    const flagged = await createHost(new Hub(), {
      settings: { allowIncoming: false },
      portalEnabled: true,
    });
    await flagged.service.setAllowIncoming(true);
    expect(flagged.portal.starts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Install identifier
// ---------------------------------------------------------------------------

describe('install identifier (remote-control:install-id)', () => {
  it('initializes through the Portal state store and stays stable across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-install-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    // Each read loads the store afresh, as after a restart.
    const read = async (): Promise<{
      installId: string;
      optIn: PortalOptInRead;
    }> => {
      let result: { installId: string; optIn: PortalOptInRead } | null = null;
      await jest.isolateModulesAsync(async () => {
        const electron = await import('electron');
        jest.spyOn(electron.app, 'getPath').mockReturnValue(dir);
        const portal = await import('../../portal/portal-state-store');
        result = {
          installId: await portal.readDurablePortalInstallId(),
          optIn: await portal.readPortalOptInForMigration(),
        };
      });
      if (!result) throw new Error('No result.');
      return result;
    };
    const first = await read();
    const onDisk: unknown = JSON.parse(
      await readFile(join(dir, 'portal-state.json'), 'utf8'),
    );
    expect(onDisk).toMatchObject({ clientDeviceId: first.installId });
    expect(first.optIn).toEqual({ reliable: true, active: false });
    expect((await read()).installId).toBe(first.installId);
    // An unreadable store is not evidence about the Portal opt-in.
    await writeFile(join(dir, 'portal-state.json'), '{not json');
    expect((await read()).optIn).toEqual({ reliable: false });
  });
});
