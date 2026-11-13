import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { RemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { BrowserWindow } from 'electron';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import { ChatEventInterestFilter } from '../../ipc/chat-event-interest';
import { shouldDropObservabilityEvent } from '../../ipc/observability-event-interest';
import { getObservabilityService } from '../../observability';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import { describeLegacyControllerRefusal } from '../protocol-version';
import {
  AppAdvisorWindowStateParamsSchema,
  AccountProxySignInCallbackParamsSchema,
  CoreCallParamsSchema,
  CoreSubscribeParamsSchema,
  CoreUnsubscribeParamsSchema,
  DialogOpenResultSchema,
  HelloParamsSchema,
  FileReadParamsSchema,
  InvokeParamsSchema,
  PairRevokeParamsSchema,
  REMOTE_EVENTS,
  REMOTE_TRANSPORT_RESUME_VERSION,
  REMOTE_METHODS,
  RemoteProtocolMismatchError,
  RemoteChannelUnavailableError,
  RemoteControllerRefusedError,
  UnknownRemoteMethodError,
  UploadPutParamsSchema,
  type AppAdvisorWindowParams,
  type AppAdvisorWindowStateParams,
  type AccountProxySignInCallbackParams,
  type AccountProxySignInOpenParams,
  type DialogOpenParams,
  type DialogOpenResult,
  type HelloResult,
  type PairRevokeResult,
  type RemoteVersion,
  type RemoteSessionEndReason,
} from '../remote-protocol';
import { RpcPeer } from '../transport/rpc-peer';
import type {
  SecureSession,
  SessionCloseReason,
} from '../transport/session-manager';
import type { HostBridge } from './bridge-window';
import {
  endRemoteInterfaceLease,
  openRemoteInterfaceLease,
} from '../../canopy-runtime/interface-tools/remote-interface-leases';
import {
  HOST_FEATURES,
  controllerMayInvoke,
  controllerMayUseChannel,
  negotiateHello,
} from './controller-profile';
import type { HostFileReader } from './file-reads';
import type { MainWindowPushSource } from './main-window-pushes';
import { createPushForwarder, type PushForwarder } from './push-forwarder';
import { RemotePushSummaryAccumulator } from './push-summary';
import type { RemoteCoreAccess } from './remote-core-access';
import type { RemoteUploadStore } from './uploads';

export interface HostSessionOptions {
  session: SecureSession;
  /** One bridge per controller window, made on that window's first call. */
  createBridge: (surface: RemoteSurface) => Promise<HostBridge>;
  mainWindowPushes: MainWindowPushSource;
  uploads: RemoteUploadStore;
  /** Reads files the controller opens in its own default app. */
  readFile: HostFileReader;
  disposition: (channel: string) => RemoteChannelDisposition;
  /**
   * The controller profile the handshake authorized. Every invoke, send and
   * push is checked against it; it never changes during a session.
   */
  kind: DeviceKind;
  /**
   * The pinned device the session acts for: the controller itself, or the
   * hosted root a delegated session is attributed to.
   */
  attributedDeviceId: string;
  /**
   * Removes the attributed device's pairing and ends its sessions, saved
   * before it resolves. Without it the host does not serve `pair.revoke`.
   */
  revokeOwnPairing?: () => Promise<void>;
  /**
   * Whether the controller may still control this computer. Checked on every
   * request, so a revocation holds even if a session outlived it.
   */
  isAuthorized: () => boolean;
  /**
   * Serves a hosted session's `chat:command` on this computer instead of the
   * bridge window, stamping the agent attribution it derives from the
   * session (CAN-5985). A hosted session without it is refused the channel.
   */
  hostedChat?: (request: unknown) => Promise<unknown>;
  /** This computer's version; a controller on another protocol is refused. */
  version: RemoteVersion;
  hello: () => Pick<HelloResult, 'name' | 'platform'>;
  onClose: (reason: SessionCloseReason) => void;
  /** The bridge warmed after hello could not start. */
  onBridgeError?: (error: unknown) => void;
  /** The controller's App Advisor window for this computer changed. */
  onAppAdvisorWindowState?: (state: AppAdvisorWindowStateParams) => void;
  /**
   * Hands this controller's account proxy sign-in redirect to the proxy.
   * Without it the host answers that it does not serve the method.
   */
  completeAccountProxySignIn?: (
    controllerDeviceId: string,
    callback: AccountProxySignInCallbackParams,
  ) => Promise<void>;
  /**
   * Core operations served to this controller whatever its protocol, listed
   * in hello. Without it the host answers that it does not serve them.
   */
  core?: RemoteCoreAccess;
}

/** Streams one controller may hold open at once. */
const MAX_CORE_SUBSCRIPTIONS = 8;

function isEndFrame(frame: unknown): boolean {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    'kind' in frame &&
    frame.kind === 'end'
  );
}

const APP_ADVISOR_WINDOW_TIMEOUT_MS = 15_000;

/** Deployed mobile usage readers accept only the original account states. */
function projectControllerAccountProxyStatus(value: unknown): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('accounts' in value) ||
    !Array.isArray(value.accounts)
  )
    return value;
  return {
    ...value,
    accounts: value.accounts.map((account: unknown) =>
      typeof account === 'object' &&
      account !== null &&
      'status' in account &&
      account.status === 'sign-in-required'
        ? { ...account, status: 'error', signInRequired: true }
        : account,
    ),
  };
}

/**
 * One controller's live session on this computer: replays each controller
 * window's calls through its own bridge window and forwards this computer's
 * pushes back. Nothing is replayed or forwarded until the controller's hello
 * shows it speaks the same protocol version as this computer.
 */
export class RemoteHostSession {
  readonly rpc: RpcPeer;
  private readonly bridges = new Map<RemoteSurface, Promise<HostBridge>>();
  private readonly startedBridges = new Map<RemoteSurface, HostBridge>();
  /** Each bridge's WebContents id, kept for its lease: a closed window has none. */
  private readonly leasedWebContents = new Map<RemoteSurface, number>();
  private forwarder: PushForwarder | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly chatEventInterestFilter = new ChatEventInterestFilter();
  private closed = false;
  private readonly pushSummary = new RemotePushSummaryAccumulator(
    () => this.startedBridges.get('main')?.getChatInterest(),
    (remotePushSummary) => {
      try {
        getObservabilityService().recordAppDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'remote_push_summary',
          remotePushSummary,
        });
      } catch {
        // A best-effort local diagnostic cannot hold a remote session open.
      }
    },
  );
  private compatible = false;
  /** The controller sent a valid hello, whatever its protocol. */
  private greeted = false;
  /** Each open core stream's close, by key, including ones still opening. */
  private readonly coreSubscriptions = new Map<string, () => void>();
  private readonly closedListeners = new Set<() => void>();

  constructor(private readonly options: HostSessionOptions) {
    this.rpc = new RpcPeer(options.session, {
      onRequest: (method: string, params: unknown): Promise<unknown> =>
        this.handleRequest(method, params),
      onEvent: (name: string, payload: unknown): void =>
        this.handleEvent(name, payload),
    });
    this.rpc.onClose((reason) => this.handleClosed(reason));
    if (this.rpc.isClosed) this.pushSummary.close();
  }

  get controllerDeviceId(): string {
    return this.options.session.peerDeviceId;
  }

  /** The pinned device this session is attributed to. */
  get attributedDeviceId(): string {
    return this.options.attributedDeviceId;
  }

  get kind(): DeviceKind {
    return this.options.kind;
  }

  /** Whether this controller's profile allows the channel. */
  private allows(channel: string): boolean {
    return controllerMayUseChannel(
      this.options.kind,
      channel,
      this.options.disposition,
    );
  }

  /** Whether this controller's profile allows the call with these arguments. */
  private allowsInvoke(channel: string, args: readonly unknown[]): boolean {
    return controllerMayInvoke(
      this.options.kind,
      channel,
      args,
      this.options.disposition,
    );
  }

  /** Starts the main window's bridge and push forwarding. */
  start(): Promise<HostBridge> {
    return this.bridgeFor('main');
  }

  /**
   * The bridge for one controller window, started on first use once the
   * versions match. Its pushes go to that window only.
   */
  bridgeFor(surface: RemoteSurface): Promise<HostBridge> {
    const existing = this.bridges.get(surface);
    if (existing) return existing;
    if (!this.compatible) return Promise.reject(this.mismatchError());
    const forwarder = this.ensureForwarding();
    const bridge = this.options.createBridge(surface).then(
      (created) => {
        if (this.closed) {
          created.destroy();
          throw new Error('The remote session ended.');
        }
        this.startedBridges.set(surface, created);
        // CAN-5823: a desktop controller's window behind this bridge serves
        // agent tools through its own lease, which ends with the bridge or
        // session. Mobile and browser controllers implement none of them.
        const webContentsId =
          this.options.kind === 'desktop'
            ? created.window?.webContents.id
            : undefined;
        if (webContentsId !== undefined) {
          this.leasedWebContents.set(surface, webContentsId);
          openRemoteInterfaceLease({
            webContentsId,
            surface,
            controllerDeviceId: this.controllerDeviceId,
          });
        }
        this.unsubscribers.push(
          created.onPush((channel, args) =>
            forwarder.offer(channel, args, surface),
          ),
          // A bridge that dies (its renderer crashed) cannot be reused: end
          // the session, and the controller reconnects to a fresh one.
          created.onClosed(() => {
            if (webContentsId !== undefined) {
              this.leasedWebContents.delete(surface);
              endRemoteInterfaceLease(webContentsId);
            }
            this.rpc.close('protocol_error');
          }),
        );
        return created;
      },
      (error: unknown) => {
        this.rpc.close('protocol_error');
        throw error;
      },
    );
    bridge.catch(() => undefined);
    this.bridges.set(surface, bridge);
    return bridge;
  }

  /** A started bridge's hidden window; main sends to it to reach that window. */
  bridgeWindow(surface: RemoteSurface): BrowserWindow | null {
    return this.startedBridges.get(surface)?.window ?? null;
  }

  /** Asks the controller to show, create or hide its App Advisor window. */
  async requestAppAdvisorWindow(
    params: AppAdvisorWindowParams,
  ): Promise<AppAdvisorWindowStateParams> {
    return AppAdvisorWindowStateParamsSchema.parse(
      await this.rpc.request(REMOTE_METHODS.appAdvisorWindow, params, {
        timeoutMs: APP_ADVISOR_WINDOW_TIMEOUT_MS,
      }),
    );
  }

  private ensureForwarding(): PushForwarder {
    if (this.forwarder) return this.forwarder;
    const forwarder = createPushForwarder(
      (channel, args, surface) => {
        if (!this.allows(channel)) return;
        this.forwardPush(channel, args, surface);
      },
      undefined,
      () => Array.from(this.bridges.keys()),
      () => this.pushSummary.duplicateDropped(),
    );
    this.forwarder = forwarder;
    this.unsubscribers.push(
      this.options.mainWindowPushes.subscribe((channel, args) =>
        forwarder.offer(channel, args),
      ),
    );
    return forwarder;
  }

  private forwardPush(
    channel: string,
    args: unknown[],
    surface?: RemoteSurface,
  ): void {
    if (
      (channel === IPC_CHANNELS.chatEvent ||
        channel === IPC_CHANNELS.observabilityEvent) &&
      surface === undefined &&
      this.startedBridges.size > 1
    ) {
      for (const target of Array.from(this.startedBridges.keys())) {
        this.forwardPush(channel, args, target);
      }
      return;
    }
    const bridge = this.startedBridges.get(surface ?? 'main');
    const interest = bridge?.getChatInterest();
    if (
      channel === IPC_CHANNELS.chatEvent &&
      bridge &&
      this.chatEventInterestFilter.shouldDrop(bridge, interest, args[0])
    )
      return;
    if (
      channel === IPC_CHANNELS.observabilityEvent &&
      shouldDropObservabilityEvent(interest, args[0])
    )
      return;
    let bytes = 0;
    const wireArgs =
      this.options.kind !== 'desktop' &&
      channel === IPC_CHANNELS.accountProxyChanged
        ? args.map(projectControllerAccountProxyStatus)
        : args;
    const sent = this.rpc.notify(
      REMOTE_EVENTS.push,
      surface === undefined
        ? { channel, args: wireArgs }
        : { channel, args: wireArgs, surface },
      (serializedBytes) => {
        bytes = serializedBytes;
      },
    );
    if (sent)
      this.pushSummary.forwarded(channel, args, bytes, interest ?? null);
  }

  close(reason: SessionCloseReason): void {
    this.rpc.close(reason);
  }

  /** Ends the session on purpose and tells the controller not to come back. */
  end(reason: RemoteSessionEndReason): void {
    if (this.closed) return;
    this.rpc.notify(REMOTE_EVENTS.ended, { reason });
    this.rpc.close('revoked');
  }

  /** Shows a handler's file dialog on the controlling computer. */
  async showOpenDialog(params: DialogOpenParams): Promise<DialogOpenResult> {
    const result = DialogOpenResultSchema.parse(
      await this.rpc.request(REMOTE_METHODS.dialogOpen, params, {
        timeoutMs: null,
      }),
    );
    return result;
  }

  /**
   * Opens an account proxy sign-in page in the controller's browser, which
   * catches the redirect and sends it back with
   * `account-proxy.sign-in.callback`.
   */
  async openAccountProxySignIn(
    params: AccountProxySignInOpenParams,
  ): Promise<void> {
    if (!this.compatible) throw this.mismatchError();
    await this.rpc.request(REMOTE_METHODS.accountProxySignInOpen, params);
  }

  /** Tells the controller to stop listening for that sign-in. */
  endAccountProxySignIn(state: string): void {
    if (this.closed) return;
    this.rpc.notify(REMOTE_EVENTS.accountProxySignInEnded, { state });
  }

  /** Called once when the session closes; at once if it already has. */
  onClosed(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => undefined;
    }
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  /** Ends the session if the controller lost its authorization. */
  private ensureAuthorized(): boolean {
    if (this.options.isAuthorized()) return true;
    this.end('revoked');
    return false;
  }

  private async handleRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (!this.ensureAuthorized()) {
      throw new Error('This computer no longer allows remote control.');
    }
    switch (method) {
      case REMOTE_METHODS.hello:
        return this.handleHello(params);
      case REMOTE_METHODS.invoke: {
        if (!this.compatible) throw this.mismatchError();
        const { channel, args, surface } = InvokeParamsSchema.parse(params);
        if (!this.allowsInvoke(channel, args)) {
          throw new RemoteChannelUnavailableError(channel);
        }
        if (this.servesHostedChat(channel)) {
          return this.dispatchHostedChat(channel, args[0]);
        }
        const bridge = await this.bridgeFor(surface ?? 'main');
        const result = await bridge.invoke(channel, args);
        return this.options.kind !== 'desktop' &&
          channel === IPC_CHANNELS.accountProxyStatus
          ? projectControllerAccountProxyStatus(result)
          : result;
      }
      case REMOTE_METHODS.pairRevoke: {
        const revoke = this.options.revokeOwnPairing;
        if (!revoke) throw new UnknownRemoteMethodError(method);
        PairRevokeParamsSchema.parse(params);
        await revoke();
        const result: PairRevokeResult = { revoked: true };
        return result;
      }
      case REMOTE_METHODS.uploadPut: {
        if (!this.compatible) throw this.mismatchError();
        this.assertUploadProfile(method);
        const { fileName, bytes } = UploadPutParamsSchema.parse(params);
        const path = await this.options.uploads.put(
          this.controllerDeviceId,
          fileName,
          bytes,
        );
        return { path };
      }
      case REMOTE_METHODS.fileRead:
        if (!this.compatible) throw this.mismatchError();
        this.assertDesktopProfile(method);
        return this.options.readFile(FileReadParamsSchema.parse(params));
      case REMOTE_METHODS.accountProxySignInCallback: {
        const complete = this.options.completeAccountProxySignIn;
        if (!complete) throw new UnknownRemoteMethodError(method);
        if (!this.compatible) throw this.mismatchError();
        this.assertDesktopProfile(method);
        await complete(
          this.controllerDeviceId,
          AccountProxySignInCallbackParamsSchema.parse(params),
        );
        return { accepted: true };
      }
      case REMOTE_METHODS.coreCall: {
        const core = this.requireCore(method);
        const {
          operation,
          version,
          params: call,
        } = CoreCallParamsSchema.parse(params);
        return core.call(this.controllerDeviceId, operation, version, call);
      }
      case REMOTE_METHODS.coreSubscribe:
        return this.subscribeCore(
          this.requireCore(method),
          CoreSubscribeParamsSchema.parse(params),
        );
      case REMOTE_METHODS.coreUnsubscribe: {
        this.requireCore(method);
        const { subscriptionKey } = CoreUnsubscribeParamsSchema.parse(params);
        this.coreSubscriptions.get(subscriptionKey)?.();
        this.coreSubscriptions.delete(subscriptionKey);
        return { closed: true };
      }
      default:
        throw new UnknownRemoteMethodError(method);
    }
  }

  /**
   * Core operations need only a valid hello: their own versions are the
   * contract, so a controller on another protocol is still served them.
   */
  private requireCore(method: string): RemoteCoreAccess {
    const core = this.options.core;
    if (!core) throw new UnknownRemoteMethodError(method);
    if (!this.greeted) throw this.mismatchError();
    this.assertDesktopProfile(method);
    return core;
  }

  private async subscribeCore(
    core: RemoteCoreAccess,
    request: {
      subscriptionKey: string;
      operation: string;
      version: number;
      params: unknown;
    },
  ): Promise<unknown> {
    const { subscriptionKey } = request;
    if (this.coreSubscriptions.has(subscriptionKey)) {
      return {
        ok: false,
        error: {
          kind: 'already_exists',
          message: 'A stream with this key is already open.',
        },
      };
    }
    if (this.coreSubscriptions.size >= MAX_CORE_SUBSCRIPTIONS) {
      return {
        ok: false,
        error: {
          kind: 'resource_exhausted',
          message: 'Too many streams are open on this computer.',
        },
      };
    }
    // The key and its place under the limit are held while the stream
    // opens, so an overlapping request with the same key is refused. Closing
    // it meanwhile closes the stream as soon as it opens.
    let cancelled = false;
    let ended = false;
    const reservation = (): void => {
      cancelled = true;
    };
    // This stream's entry: the reservation, then the open stream's close.
    let entry = reservation;
    const release = (): void => {
      if (this.coreSubscriptions.get(subscriptionKey) === entry)
        this.coreSubscriptions.delete(subscriptionKey);
    };
    this.coreSubscriptions.set(subscriptionKey, entry);
    let settled = false;
    try {
      const opened = await core.subscribe(
        this.controllerDeviceId,
        request.operation,
        request.version,
        request.params,
        (frame) => {
          if (this.closed) return;
          // A stream unsubscribed while it opened no longer owns its key,
          // which a newer stream may use; its frames go nowhere.
          if (this.coreSubscriptions.get(subscriptionKey) !== entry) {
            if (isEndFrame(frame)) ended = true;
            return;
          }
          this.rpc.notify(REMOTE_EVENTS.coreEvent, { subscriptionKey, frame });
          if (!isEndFrame(frame)) return;
          // An ended stream frees its key at once, even before it finished
          // opening as a stale cursor's does, so the retry can reuse it.
          ended = true;
          release();
        },
      );
      settled = true;
      if (!opened.ok) {
        release();
        return opened;
      }
      if (this.closed || cancelled || ended) {
        opened.close();
        release();
        return { ok: true, result: null };
      }
      entry = opened.close;
      this.coreSubscriptions.set(subscriptionKey, entry);
      return { ok: true, result: null };
    } finally {
      if (!settled) release();
    }
  }

  /**
   * Identifies this computer. A controller on another protocol version gets
   * the answer so it can say which computer to update, but is never served;
   * one that predates the check cannot read it and is refused outright.
   */
  private handleHello(params: unknown): HelloResult {
    const hello: HelloResult = {
      ...this.options.hello(),
      appVersion: this.options.version.appVersion,
      version: this.options.version,
      ...(this.options.core && this.options.kind === 'desktop'
        ? { coreOperations: { ...this.options.core.operations } }
        : {}),
      features: { ...HOST_FEATURES },
    };
    const session = this.options.session;
    const parsed = HelloParamsSchema.safeParse(params);
    if (!parsed.success) {
      session.setResumeNegotiated(false);
      throw this.mismatchError();
    }
    const decision = negotiateHello(
      parsed.data,
      this.options.kind,
      this.options.version,
    );
    // Resume only a session this computer serves, and only when offered.
    const resume =
      decision.outcome === 'compatible' &&
      session.purpose === 'control' &&
      (parsed.data.transport?.resume ?? 0) >= REMOTE_TRANSPORT_RESUME_VERSION;
    // Before the answer is sealed, so every frame from here on is held.
    session.setResumeNegotiated(resume);
    if (decision.outcome === 'refused') {
      throw new RemoteControllerRefusedError(decision.reason);
    }
    this.greeted = true;
    if (decision.outcome === 'incompatible') return hello;
    this.compatible = true;
    // Warm the bridge so the controller's first calls do not wait for it.
    this.start().catch((error: unknown) => this.options.onBridgeError?.(error));
    return resume
      ? { ...hello, transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION } }
      : hello;
  }

  /** A hosted session's chat dispatch, which this computer serves itself. */
  private servesHostedChat(channel: string): boolean {
    return (
      this.options.kind === 'hosted' && channel === IPC_CHANNELS.chatCommand
    );
  }

  private async dispatchHostedChat(
    channel: string,
    request: unknown,
  ): Promise<unknown> {
    const dispatch = this.options.hostedChat;
    // Never through the bridge: that would send it unattributed.
    if (!dispatch) throw new RemoteChannelUnavailableError(channel);
    return dispatch(request);
  }

  /**
   * Session methods outside the IPC allowlists (host file reads, account
   * proxy sign-in) stay with full desktop controllers; uploads see
   * {@link assertUploadProfile}.
   */
  private assertDesktopProfile(method: string): void {
    if (this.options.kind !== 'desktop') {
      throw new RemoteControllerRefusedError(
        `"${method}" is not available to this controller.`,
      );
    }
  }

  /**
   * Uploads also serve interactive browser controllers (CAN-5985): a file the
   * person attaches in the browser is stored here before the send that names
   * it, the effect of Portal's attachment upload. The store is per controller
   * device and expires its files; nothing the browser sends selects a path.
   * Mobile and hosted controllers stay refused.
   */
  private assertUploadProfile(method: string): void {
    if (this.options.kind !== 'desktop' && this.options.kind !== 'browser') {
      throw new RemoteControllerRefusedError(
        `"${method}" is not available to this controller.`,
      );
    }
  }

  private mismatchError(): RemoteProtocolMismatchError {
    return new RemoteProtocolMismatchError(
      describeLegacyControllerRefusal(
        this.options.hello().name,
        this.options.version,
      ),
    );
  }

  private handleEvent(name: string, payload: unknown): void {
    if (!this.compatible) return;
    if (!this.ensureAuthorized()) return;
    if (name === REMOTE_EVENTS.appAdvisorWindowState) {
      const state = AppAdvisorWindowStateParamsSchema.safeParse(payload);
      if (state.success) this.options.onAppAdvisorWindowState?.(state.data);
      return;
    }
    if (name !== REMOTE_EVENTS.ipcSend) return;
    const parsed = InvokeParamsSchema.safeParse(payload);
    if (!parsed.success) return;
    const { channel, args, surface } = parsed.data;
    if (!this.allowsInvoke(channel, args)) return;
    if (this.servesHostedChat(channel)) {
      this.dispatchHostedChat(channel, args[0]).catch(() => undefined);
      return;
    }
    void this.bridgeFor(surface ?? 'main').then(
      (bridge) => bridge.post(channel, args),
      () => undefined,
    );
  }

  private handleClosed(reason: SessionCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.pushSummary.close();
    for (const close of Array.from(this.coreSubscriptions.values())) close();
    this.coreSubscriptions.clear();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    for (const webContentsId of Array.from(this.leasedWebContents.values()))
      endRemoteInterfaceLease(webContentsId);
    this.leasedWebContents.clear();
    for (const bridge of Array.from(this.bridges.values())) {
      void bridge.then(
        (created) => created.destroy(),
        () => undefined,
      );
    }
    for (const listener of Array.from(this.closedListeners)) listener();
    this.closedListeners.clear();
    this.options.onClose(reason);
  }
}
