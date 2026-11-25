import { assertLegacyWorktreeBaseRequest } from '../worktree-base-capability';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { REMOTE_IPC_CHANNELS } from '@canopy/protocol/remote-control/channels';
import { readInstalledItemPushCorrelation } from '../../installed-items/installed-item-push';
import type { RemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { BrowserWindow } from 'electron';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import type { HostedInvocationProfile } from '@canopy/protocol/remote-control/channels';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/protocol/chat-targets';
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
  InvokeRequestParamsSchema,
  type PluginInstallRefreshNotice,
  PairRevokeParamsSchema,
  REMOTE_EVENTS,
  REMOTE_TRANSPORT_RESUME_VERSION,
  REMOTE_METHODS,
  RemoteProtocolMismatchError,
  RemoteChannelUnavailableError,
  RemoteControllerRefusedError,
  SecretRequestSettleParamsSchema,
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
  type SecretRequestSettleResult,
} from '../remote-protocol';
import { RpcPeer, RpcPublicError } from '../transport/rpc-peer';
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
  controllerPushWithheld,
  negotiateHello,
} from './controller-profile';
import type { HostFileReader } from './file-reads';
import { projectBrowserPush, projectBrowserResult } from './browser-host-paths';
import { controllerInvokeRefusal } from './controller-invoke-refusals';
import {
  projectControllerPush,
  projectControllerResult,
} from './controller-remote-urls';
import {
  ControllerUrlWritebacks,
  type StoredStartPages,
} from './controller-url-writebacks';
import type { MainWindowPushSource } from './main-window-pushes';
import { createPushForwarder, type PushForwarder } from './push-forwarder';
import { RemotePushSummaryAccumulator } from './push-summary';
import type { RemoteCoreAccess } from './remote-core-access';
import type { RemoteUploadStore } from './uploads';
import { TunnelStreamMux, type TunnelOpenHandler } from '../tunnel/stream-mux';

export interface HostSessionOptions {
  session: SecureSession;
  /** One bridge per controller window, made on that window's first call. */
  createBridge: (
    surface: RemoteSurface,
    exactWorktreeBaseBranch: boolean,
  ) => Promise<HostBridge>;
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
  /**
   * What a hosted session's verified delegation says it is (CAN-7604): a
   * Slack session may reach the Orchestrator's reviewed calls, which every
   * other hosted session is refused.
   */
  hostedProfile?: HostedInvocationProfile;
  /**
   * A Slack session's Orchestrator reads, served on this computer (CAN-7604).
   * Without it a hosted session's Orchestrator reads are refused.
   */
  hostedOrchestrator?: {
    /**
     * Whether a transcript read may name this chat in this Orchestrator Work
     * Entry: a Slack conversations entry, and a chat Slack sent to.
     */
    readsChat(entryId: string, chatId: string): Promise<boolean>;
    /** `app-advisor:slack-turn-status`, already admitted by the policy. */
    turnStatus(request: unknown): Promise<unknown>;
  };
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
  /**
   * Answers a waiting RequestSecrets form for a browser or mobile controller
   * (`secret-request.settle`, U7): the local form's own submit and decline.
   * Without it the host answers that it does not serve the method.
   */
  secretRequests?: RemoteSecretRequestPort;
  /**
   * Reads the start pages a project stores, so a start page URL a controller
   * sends back unchanged keeps its stored credential (CAN-7082). Without it a
   * controller's start page URL is refused.
   */
  storedStartPages?: StoredStartPages;
  /**
   * Dials each tunnel stream a desktop controller opens. Without it every
   * `tunnel.open` is refused as unavailable.
   */
  tunnelOpen?: TunnelOpenHandler;
  /**
   * Streams this session keeps open at once; defaults to
   * `TUNNEL_MAX_STREAMS`. A host that advertises `features.webPreview`
   * advertises the same number.
   */
  tunnelMaxStreams?: number;
}

/** The local form's settlement, which this session reaches for a person. */
export interface RemoteSecretRequestPort {
  submit(
    request: {
      requestId: string;
      values: Record<string, string>;
      useHeld: string[];
    },
    answeredFrom: SecretRequestController,
  ): Promise<SecretRequestSettleResult>;
  decline(
    requestId: string,
    answeredFrom: SecretRequestController,
  ): Promise<SecretRequestSettleResult>;
}

/** The controller kinds a person answers secret requests from. */
type SecretRequestController = 'browser' | 'mobile';

/** Controllers that are a person on a paired browser or phone. */
function servesSecretRequests(
  kind: DeviceKind,
): kind is SecretRequestController {
  return kind === 'browser' || kind === 'mobile';
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
  private exactWorktreeBaseBranch = false;
  /** The controller parses `reason` in a secret-request.settle result. */
  private secretSettleReason = false;
  /** The controller sent a valid hello, whatever its protocol. */
  private greeted = false;
  /** Each open core stream's close, by key, including ones still opening. */
  private readonly coreSubscriptions = new Map<string, () => void>();
  private readonly closedListeners = new Set<() => void>();
  private readonly urlWritebacks: ControllerUrlWritebacks;
  /** Made on the first `tunnel.open`; desktop controllers only. */
  private tunnels: TunnelStreamMux | null = null;

  constructor(private readonly options: HostSessionOptions) {
    this.urlWritebacks = new ControllerUrlWritebacks(options.storedStartPages);
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
      this.options.hostedProfile,
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
    const startingBridge = this.options.createBridge(
      surface,
      this.exactWorktreeBaseBranch,
    );
    const bridge = startingBridge.then(
      (created) => {
        if (this.closed) {
          created.destroy();
          throw new RpcPublicError('The remote session ended.');
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
        // Composer requests stay on this computer's own window (CAN-7436).
        if (controllerPushWithheld(channel, args)) return;
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
    // A first-party session (the Slack worker, CAN-7604) polls its turn
    // status and reads its own transcripts; it never hears this computer's
    // pushes, which would carry every chat's events.
    if (this.options.hostedProfile?.firstPartyClient !== undefined) return;
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
    // Dedup happens before projection, on the identity shared by the main
    // mirror and the bridge copies. Only the originating browser session
    // gets the token; all other controllers still get the legacy notice.
    let projectedArgs = args;
    if (channel === REMOTE_IPC_CHANNELS.installedItemsChanged) {
      projectedArgs = [];
      const correlation = readInstalledItemPushCorrelation(args[0]);
      if (
        this.options.kind === 'browser' &&
        correlation !== undefined &&
        Array.from(this.startedBridges.values()).some(
          (started) => started.window?.webContents.id === correlation.senderId,
        )
      ) {
        const notice: PluginInstallRefreshNotice = {
          installRefreshToken: correlation.installRefreshToken,
        };
        projectedArgs = [notice];
      }
    }
    const urlArgs = projectControllerPush(channel, projectedArgs);
    const controllerArgs =
      this.options.kind === 'browser'
        ? projectBrowserPush(channel, urlArgs)
        : urlArgs;
    const wireArgs =
      this.options.kind !== 'desktop' &&
      channel === IPC_CHANNELS.accountProxyChanged
        ? controllerArgs.map(projectControllerAccountProxyStatus)
        : controllerArgs;
    const sent = this.rpc.notify(
      REMOTE_EVENTS.push,
      surface === undefined
        ? { channel, args: wireArgs }
        : { channel, args: wireArgs, surface },
      {
        onSerialized: (serializedBytes) => {
          bytes = serializedBytes;
        },
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
      throw new RpcPublicError(
        'This computer no longer allows remote control.',
      );
    }
    // A first-party session (Slack) only negotiates and invokes its
    // Orchestrator calls; it never revokes the hosted pairing it rides on.
    if (
      this.options.hostedProfile?.firstPartyClient !== undefined &&
      method !== REMOTE_METHODS.hello &&
      method !== REMOTE_METHODS.invoke
    )
      throw new UnknownRemoteMethodError(method);
    switch (method) {
      case REMOTE_METHODS.hello:
        return this.handleHello(params);
      case REMOTE_METHODS.invoke: {
        if (!this.compatible) throw this.mismatchError();
        const { channel, args, surface, installRefreshToken } =
          InvokeRequestParamsSchema.parse(params);
        if (!this.allowsInvoke(channel, args)) {
          throw new RemoteChannelUnavailableError(channel);
        }
        const refusal = controllerInvokeRefusal(channel, args);
        if (refusal !== undefined)
          throw new RemoteControllerRefusedError(refusal);
        if (this.servesHostedChat(channel)) {
          return this.dispatchHostedChat(channel, args[0]);
        }
        if (this.servesSlackTurnStatus(channel)) {
          const orchestrator =
            this.options.kind === 'hosted'
              ? this.options.hostedOrchestrator
              : undefined;
          if (!orchestrator) throw new RemoteChannelUnavailableError(channel);
          return orchestrator.turnStatus(args[0]);
        }
        if (await this.refusesOrchestratorRead(channel, args))
          throw new RemoteChannelUnavailableError(channel);
        if (!this.exactWorktreeBaseBranch)
          assertLegacyWorktreeBaseRequest(channel, args[0]);
        const bridge = await this.bridgeFor(surface ?? 'main');
        // The browser still sends exactly three IPC arguments. A fourth
        // value exists only on this host's private Electron bridge hop and
        // can only be set from the admitted browser invoke envelope.
        const bridgeArgs =
          channel !== REMOTE_IPC_CHANNELS.pluginsInstallPlugin
            ? args
            : this.options.kind === 'browser' &&
                installRefreshToken !== undefined
              ? [...args, installRefreshToken]
              : args.slice(0, 3);
        const urlResult = projectControllerResult(
          channel,
          await this.invokeWithStoredUrls(
            bridge,
            surface ?? 'main',
            channel,
            bridgeArgs,
          ),
        );
        const result =
          this.options.kind === 'browser'
            ? projectBrowserResult(channel, urlResult)
            : urlResult;
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
        this.urlWritebacks.clear();
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
      case REMOTE_METHODS.secretRequestSettle:
        return this.settleSecretRequest(method, params);
      case REMOTE_METHODS.tunnelOpen:
        if (!this.compatible) throw this.mismatchError();
        this.assertDesktopProfile(method);
        return this.tunnelMux().serveOpen(params);
      default:
        throw new UnknownRemoteMethodError(method);
    }
  }

  /**
   * A paired person's answer to a RequestSecrets form. Only browser and
   * mobile controllers, whose kind the relay authenticated, are served:
   * hosted agents never provide secrets, and a desktop controller answers in
   * its own window's form. The values are never logged, and a malformed
   * request is refused without echoing what it carried.
   */
  private async settleSecretRequest(
    method: string,
    params: unknown,
  ): Promise<SecretRequestSettleResult> {
    const port = this.options.secretRequests;
    if (!port) throw new UnknownRemoteMethodError(method);
    if (!this.compatible) throw this.mismatchError();
    const kind = this.options.kind;
    if (!servesSecretRequests(kind))
      throw new RemoteControllerRefusedError(
        `"${method}" is not available to this controller.`,
      );
    const request = SecretRequestSettleParamsSchema.safeParse(params);
    if (!request.success)
      return { accepted: false, error: 'Check the secrets and try again.' };
    const answer = request.data;
    // The same validation, person-only and first-answer-wins rules as the
    // local form: the port is that form's own settlement. No scope is
    // accepted, so a paired answer is kept for the chat only.
    const result =
      answer.action === 'provide'
        ? await port.submit(
            {
              requestId: answer.requestId,
              values: answer.values,
              useHeld: answer.useHeld,
            },
            kind,
          )
        : await port.decline(answer.requestId, kind);
    return {
      accepted: result.accepted,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.reason !== undefined && this.secretSettleReason
        ? { reason: result.reason }
        : {}),
    };
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
      features: {
        ...HOST_FEATURES,
        ...(this.options.secretRequests &&
        servesSecretRequests(this.options.kind)
          ? { secretRequestSettle: true }
          : {}),
      },
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
    if (!this.compatible) {
      // Desktop and browser (CAN-7437) controllers may agree the exact
      // catalogue; hosted agents and mobile keep the legacy short names.
      this.exactWorktreeBaseBranch =
        (this.options.kind === 'desktop' || this.options.kind === 'browser') &&
        parsed.data.exactWorktreeBaseBranch === true;
    }
    this.secretSettleReason = parsed.data.secretRequestSettleReason === true;
    this.compatible = true;
    if (this.exactWorktreeBaseBranch && hello.features)
      hello.features.exactWorktreeBaseBranch = true;
    // Warm the bridge so the controller's first calls do not wait for it.
    this.start().catch((error: unknown) => this.options.onBridgeError?.(error));
    return resume
      ? { ...hello, transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION } }
      : hello;
  }

  /** A hosted session's chat dispatch, which this computer serves itself. */
  /**
   * Main's answer to a controller's call, the call's start page URLs merged
   * with the stored ones first (CAN-7082).
   */
  private async invokeWithStoredUrls(
    bridge: HostBridge,
    surface: RemoteSurface,
    channel: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    const sent = await this.urlWritebacks.merge(surface, channel, args);
    const load = this.urlWritebacks.begin(surface, channel);
    const delivered = await bridge.invoke(channel, [...sent]);
    this.urlWritebacks.record(surface, channel, sent, delivered, load);
    return delivered;
  }

  private servesHostedChat(channel: string): boolean {
    return (
      this.options.kind === 'hosted' && channel === IPC_CHANNELS.chatCommand
    );
  }

  /**
   * A Slack session's turn status, which this computer serves itself. It
   * never reaches the bridge, so every other controller is refused it.
   */
  private servesSlackTurnStatus(channel: string): boolean {
    return channel === IPC_CHANNELS.appAdvisorSlackTurnStatus;
  }

  /** A hosted transcript read in the Orchestrator project. */
  private namesOrchestrator(
    channel: string,
    args: readonly unknown[],
  ): boolean {
    const request = args[0];
    return (
      this.options.kind === 'hosted' &&
      channel === IPC_CHANNELS.chatGetTranscriptPage &&
      typeof request === 'object' &&
      request !== null &&
      Reflect.get(request, 'projectId') === APP_ADVISOR_PROJECT_ID
    );
  }

  /**
   * A Slack session reads only the transcripts of chats Slack sent to, in the
   * Slack conversations entries (CAN-7604); the policy already refused every
   * other hosted session and every other Orchestrator channel.
   */
  private async refusesOrchestratorRead(
    channel: string,
    args: readonly unknown[],
  ): Promise<boolean> {
    if (!this.namesOrchestrator(channel, args)) return false;
    const orchestrator = this.options.hostedOrchestrator;
    const entryId: unknown = Reflect.get(Object(args[0]), 'worktreeId');
    const chatId: unknown = Reflect.get(Object(args[0]), 'chatId');
    return (
      orchestrator === undefined ||
      typeof entryId !== 'string' ||
      typeof chatId !== 'string' ||
      !(await orchestrator.readsChat(entryId, chatId))
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

  /** The session's tunnel streams, made when the first one opens. */
  private tunnelMux(): TunnelStreamMux {
    const session = this.options.session;
    this.tunnels ??= new TunnelStreamMux({
      role: 'host',
      transport: {
        notify: (name, payload, options): boolean =>
          this.rpc.notify(name, payload, options),
        request: (method, params, options): Promise<unknown> =>
          this.rpc.request(method, params, options),
        heldBytes: (): number => session.heldBytes,
        onHeldBytesReleased: (listener): (() => void) =>
          session.onHeldBytesReleased(listener),
      },
      ...(this.options.tunnelOpen ? { open: this.options.tunnelOpen } : {}),
      ...(this.options.tunnelMaxStreams === undefined
        ? {}
        : { maxStreams: this.options.tunnelMaxStreams }),
    });
    // An open answered after the session closed dials nothing.
    if (this.closed) this.tunnels.close();
    return this.tunnels;
  }

  private handleEvent(name: string, payload: unknown): void {
    if (!this.compatible) return;
    if (!this.ensureAuthorized()) return;
    if (
      this.options.hostedProfile?.firstPartyClient !== undefined &&
      name !== REMOTE_EVENTS.ipcSend
    )
      return;
    if (this.tunnels?.handleEvent(name, payload)) return;
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
    if (controllerInvokeRefusal(channel, args) !== undefined) return;
    if (this.servesHostedChat(channel)) {
      this.dispatchHostedChat(channel, args[0]).catch(() => undefined);
      return;
    }
    // Reads have no effect as sends; an Orchestrator one never reaches the bridge.
    if (
      this.servesSlackTurnStatus(channel) ||
      this.namesOrchestrator(channel, args)
    )
      return;
    void this.bridgeFor(surface ?? 'main').then(
      (bridge) => bridge.post(channel, args),
      () => undefined,
    );
  }

  private handleClosed(reason: SessionCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.urlWritebacks.clear();
    this.pushSummary.close();
    for (const close of Array.from(this.coreSubscriptions.values())) close();
    this.coreSubscriptions.clear();
    this.tunnels?.close();
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
