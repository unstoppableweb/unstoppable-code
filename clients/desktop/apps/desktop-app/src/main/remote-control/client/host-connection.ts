import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import type {
  CheckWorktreeRemovalAdmissionResponse,
  RemoteHostConnectionStatus,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { FileSaveConflictError } from '@canopy/protocol/file-save-conflict';
import { restoreFileImageSaveError } from '@canopy/protocol/file-image-save';
import {
  compatibleRemoteVersions,
  describeHostVersionMismatch,
} from '../protocol-version';
import {
  AppAdvisorWindowParamsSchema,
  AccountProxySignInEndedParamsSchema,
  AccountProxySignInOpenParamsSchema,
  DialogOpenParamsSchema,
  FileReadResultSchema,
  HelloResultSchema,
  InvokeParamsSchema,
  isRemoteChannelUnavailableError,
  REMOTE_PROTOCOL_MISMATCH_CODE,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_TRANSPORT_RESUME_VERSION,
  SessionEndedParamsSchema,
  UnknownRemoteMethodError,
  UploadPutResultSchema,
  type AppAdvisorWindowParams,
  type AppAdvisorWindowStateParams,
  type AccountProxySignInCallbackParams,
  type AccountProxySignInOpenParams,
  type DialogOpenParams,
  type DialogOpenResult,
  type HelloParams,
  type FileReadParams,
  type FileReadResult,
  type HelloResult,
  type RemoteVersion,
  type RemoteSessionEndReason,
} from '../remote-protocol';
import { RpcClosedError, RpcPeer, RpcRemoteError } from '../transport/rpc-peer';
import type {
  SecureSession,
  SessionCloseReason,
} from '../transport/session-manager';

export interface HostConnectionOptions {
  /** This computer's version; the host must speak the same protocol. */
  version: RemoteVersion;
  connect: () => Promise<SecureSession>;
  /** `surface` absent: every window that shows the host. */
  onPush: (channel: string, args: unknown[], surface?: RemoteSurface) => void;
  /** Shows a picker for a file dialog raised by a handler on the host. */
  onDialogOpen: (params: DialogOpenParams) => Promise<DialogOpenResult>;
  /** Shows, creates or hides this computer's App Advisor window for the host. */
  onAppAdvisorWindow: (
    params: AppAdvisorWindowParams,
  ) => Promise<AppAdvisorWindowStateParams>;
  onStatusChange: () => void;
  /**
   * Called after a dropped session is replaced by a new handshake. A session
   * that resumes after a relay drop lost nothing, so this is not called.
   */
  onReconnected: () => void;
  /**
   * Opens an account proxy sign-in page the host asked for and listens for
   * its redirect here. Without it this computer answers that it does not
   * serve the method, as releases before it do.
   */
  onAccountProxySignInOpen?: (
    params: AccountProxySignInOpenParams,
  ) => Promise<void>;
  /** The host stopped waiting for that sign-in. */
  onAccountProxySignInEnded?: (state: string) => void;
  /**
   * The open session closed, with its close reason, or the connection was
   * released (`released`).
   */
  onSessionEnded?: (reason: SessionCloseReason | 'released') => void;
  minRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

const ENDED_MESSAGES: Record<RemoteSessionEndReason, string> = {
  disconnected: 'The other computer ended this session.',
  revoked: 'The other computer no longer allows this computer to control it.',
};

/** Requests held to one session; see `RemoteHostConnection.pinSession`. */
export interface PinnedHostSession {
  /** Whether that session is still this connection's open one. */
  readonly active: boolean;
  readFile: (params: FileReadParams) => Promise<FileReadResult>;
  invoke: (channel: string, args: unknown[]) => Promise<unknown>;
}

/** The connection was released while a session was being set up. */
class HostConnectionReleasedError extends Error {
  constructor() {
    super('The connection was closed.');
  }
}

/**
 * This computer's control connection to one paired computer. Kept warm while
 * a window shows that computer, re-established with backoff after drops.
 */
export class RemoteHostConnection {
  private rpc: RpcPeer | null = null;
  /** The session still waiting for hello; release() closes it at once. */
  private pendingRpc: RpcPeer | null = null;
  private connecting: Promise<RpcPeer> | null = null;
  private wanted = false;
  /** Bumped by release(), so a connect that was under way is abandoned. */
  private generation = 0;
  /**
   * Set when the host ended the session on purpose or speaks another protocol; no
   * retries until reopened.
   */
  private endedMessage: string | null = null;
  private hadSession = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private statusValue: RemoteHostConnectionStatus = 'idle';
  private errorValue: string | null = null;
  private helloValue: HelloResult | null = null;

  constructor(private readonly options: HostConnectionOptions) {}

  get status(): RemoteHostConnectionStatus {
    return this.statusValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  /** The host ended the session or is incompatible; no retries until reopened. */
  get ended(): boolean {
    return this.endedMessage !== null;
  }

  get hostInfo(): HelloResult | null {
    return this.helloValue;
  }

  keepConnected(): void {
    this.wanted = true;
    // Opening the computer again is the user's choice to reconnect.
    this.endedMessage = null;
    void this.ensure().catch(() => undefined);
  }

  /**
   * Retries at once instead of waiting out the backoff; called when the
   * relay is back or the host comes online, so recovery follows the network
   * rather than the retry timer.
   */
  retryNow(): void {
    if (
      !this.wanted ||
      this.endedMessage !== null ||
      (this.rpc && !this.rpc.isClosed) ||
      this.connecting
    ) {
      return;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    void this.ensure().catch(() => undefined);
  }

  release(): void {
    this.wanted = false;
    this.generation += 1;
    this.connecting = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const rpc = this.rpc;
    this.rpc = null;
    rpc?.close('closed');
    this.pendingRpc?.close('closed');
    this.pendingRpc = null;
    this.hadSession = false;
    this.options.onSessionEnded?.('released');
    this.setStatus('idle', null);
  }

  ensure(): Promise<RpcPeer> {
    if (this.rpc && !this.rpc.isClosed) return Promise.resolve(this.rpc);
    if (this.connecting) return this.connecting;
    if (this.endedMessage !== null) {
      return Promise.reject(new Error(this.endedMessage));
    }
    this.setStatus('connecting', null);
    const generation = this.generation;
    const connecting = this.open(generation);
    this.connecting = connecting;
    void connecting.then(
      () => {
        if (this.connecting === connecting) this.connecting = null;
      },
      (error: unknown) => {
        if (this.connecting === connecting) this.connecting = null;
        if (generation !== this.generation) return;
        this.setStatus(
          'error',
          error instanceof Error ? error.message : 'Could not connect.',
        );
        this.scheduleRetry();
      },
    );
    return connecting;
  }

  async invoke(
    channel: string,
    args: unknown[],
    surface: RemoteSurface = 'main',
  ): Promise<unknown> {
    const rpc = await this.ensure();
    // No deadline: local IPC has none, and a dropped session rejects.
    try {
      return await rpc.request(
        REMOTE_METHODS.invoke,
        surface === 'main' ? { channel, args } : { channel, args, surface },
        { timeoutMs: null },
      );
    } catch (error) {
      // The host bridge already carries Electron's named rejection in the
      // existing RPC message. Restore that identity before this computer's
      // IPC wraps it again; no wire change or message-copy matching is needed.
      if (
        channel === IPC_CHANNELS.fileSaveContent &&
        error instanceof RpcRemoteError
      ) {
        const imageSaveError = restoreFileImageSaveError(error);
        if (imageSaveError) throw imageSaveError;
        const conflict =
          /^Error invoking remote method 'file:save-content': FileSaveConflictError: ([\s\S]*)$/.exec(
            error.message,
          );
        if (conflict) throw new FileSaveConflictError(conflict[1]);
      }
      // A host release without this read-only pre-check keeps the earlier
      // removal order: its own archive admission, where present, still runs.
      if (
        channel === IPC_CHANNELS.worktreeCheckRemovalAdmission &&
        isRemoteChannelUnavailableError(error)
      ) {
        const unchecked: CheckWorktreeRemovalAdmissionResponse = {
          status: 'unchecked',
        };
        return unchecked;
      }
      throw error;
    }
  }

  post(
    channel: string,
    args: unknown[],
    surface: RemoteSurface = 'main',
  ): void {
    void this.ensure().then(
      (rpc) =>
        rpc.notify(
          REMOTE_EVENTS.ipcSend,
          surface === 'main' ? { channel, args } : { channel, args, surface },
        ),
      () => undefined,
    );
  }

  /** Tells the host about its App Advisor window here, while connected. */
  reportAppAdvisorWindowState(state: AppAdvisorWindowStateParams): void {
    if (this.rpc && !this.rpc.isClosed) {
      this.rpc.notify(REMOTE_EVENTS.appAdvisorWindowState, state);
    }
  }

  /**
   * Sends the redirect an account proxy sign-in caught here to the host, on
   * the session that is open now; it never reconnects for it.
   */
  async sendAccountProxySignInCallback(
    callback: AccountProxySignInCallbackParams,
  ): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || rpc.isClosed) throw new RpcClosedError('closed');
    await rpc.request(REMOTE_METHODS.accountProxySignInCallback, callback);
  }

  /** Stores a file on the host; returns its path there. */
  async upload(fileName: string, bytes: Uint8Array): Promise<string> {
    const rpc = await this.ensure();
    const { path } = UploadPutResultSchema.parse(
      await rpc.request(
        REMOTE_METHODS.uploadPut,
        { fileName, bytes },
        // Large files take a while; a dropped session still rejects.
        { timeoutMs: null },
      ),
    );
    return path;
  }

  /**
   * Holds a transfer of several requests, such as copying a file part by
   * part, to the session that is open now. It never reconnects: once that
   * session closes or this connection is released, every request fails and
   * `active` turns false.
   */
  async pinSession(): Promise<PinnedHostSession> {
    const generation = this.generation;
    const rpc = await this.ensure();
    const isActive = (): boolean =>
      generation === this.generation && this.rpc === rpc && !rpc.isClosed;
    const request = (
      method: string,
      params: unknown,
      options: { timeoutMs?: number | null } = {},
    ): Promise<unknown> =>
      isActive()
        ? rpc.request(method, params, options)
        : Promise.reject(new RpcClosedError('closed'));
    return {
      get active(): boolean {
        return isActive();
      },
      readFile: async (params: FileReadParams): Promise<FileReadResult> =>
        FileReadResultSchema.parse(
          await request(REMOTE_METHODS.fileRead, params),
        ),
      invoke: (channel: string, args: unknown[]): Promise<unknown> =>
        // No deadline, as for any tunneled call.
        request(REMOTE_METHODS.invoke, { channel, args }, { timeoutMs: null }),
    };
  }

  private async open(generation: number): Promise<RpcPeer> {
    const session = await this.options.connect();
    if (generation !== this.generation) {
      session.close('closed');
      throw new HostConnectionReleasedError();
    }
    const rpc = new RpcPeer(session, {
      onRequest: (method: string, params: unknown): Promise<unknown> => {
        if (method === REMOTE_METHODS.dialogOpen) {
          return this.options.onDialogOpen(
            DialogOpenParamsSchema.parse(params),
          );
        }
        if (method === REMOTE_METHODS.appAdvisorWindow) {
          return this.options.onAppAdvisorWindow(
            AppAdvisorWindowParamsSchema.parse(params),
          );
        }
        const openSignIn = this.options.onAccountProxySignInOpen;
        if (method === REMOTE_METHODS.accountProxySignInOpen && openSignIn) {
          return openSignIn(
            AccountProxySignInOpenParamsSchema.parse(params),
          ).then(() => ({ opened: true }));
        }
        return Promise.reject(new UnknownRemoteMethodError(method));
      },
      onEvent: (name: string, payload: unknown): void => {
        if (name === REMOTE_EVENTS.ended) {
          const ended = SessionEndedParamsSchema.safeParse(payload);
          if (ended.success) {
            this.endedMessage = ENDED_MESSAGES[ended.data.reason];
          }
          return;
        }
        if (name === REMOTE_EVENTS.accountProxySignInEnded) {
          const ended = AccountProxySignInEndedParamsSchema.safeParse(payload);
          if (ended.success) {
            this.options.onAccountProxySignInEnded?.(ended.data.state);
          }
          return;
        }
        if (name !== REMOTE_EVENTS.push) return;
        const parsed = InvokeParamsSchema.safeParse(payload);
        if (parsed.success) {
          this.options.onPush(
            parsed.data.channel,
            parsed.data.args,
            parsed.data.surface,
          );
        }
      },
    });
    rpc.onClose((reason) => this.handleDropped(rpc, reason));
    // A resumable session rides out a relay drop: show it as connecting
    // meanwhile, and keep the window, since nothing was lost.
    session.onStateChange((state) => {
      if (this.rpc !== rpc) return;
      this.setStatus(state === 'active' ? 'connected' : 'connecting', null);
    });
    this.pendingRpc = rpc;
    let hello: HelloResult;
    try {
      const params: HelloParams = {
        version: this.options.version,
        transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION },
      };
      hello = HelloResultSchema.parse(
        await rpc
          .request(REMOTE_METHODS.hello, params, { timeoutMs: 15_000 })
          .catch((error: unknown) => {
            if (
              error instanceof RpcRemoteError &&
              error.code === REMOTE_PROTOCOL_MISMATCH_CODE &&
              generation === this.generation
            ) {
              this.endedMessage = error.message;
            }
            throw error;
          }),
      );
      if (generation !== this.generation) {
        throw new HostConnectionReleasedError();
      }
      if (
        !hello.version ||
        !compatibleRemoteVersions(hello.version, this.options.version)
      ) {
        // Another protocol would read this computer's calls differently;
        // reopening the computer, after updating, tries again.
        this.endedMessage = describeHostVersionMismatch(
          hello.name,
          hello.appVersion,
          hello.version ?? null,
          this.options.version,
        );
        throw new Error(this.endedMessage);
      }
      // Hosts released before session resume answer without it.
      session.setResumeNegotiated(
        (hello.transport?.resume ?? 0) >= REMOTE_TRANSPORT_RESUME_VERSION,
      );
      // It may have closed after answering, before this resumed; its close
      // was ignored because it was not published yet, so retry from here.
      if (rpc.isClosed) {
        throw new Error('The connection to the other computer closed.');
      }
    } catch (error) {
      // Never leave a session open that nothing will use.
      rpc.close('closed');
      throw error;
    } finally {
      if (this.pendingRpc === rpc) this.pendingRpc = null;
    }
    this.helloValue = hello;
    this.rpc = rpc;
    this.attempt = 0;
    const reconnected = this.hadSession;
    this.hadSession = true;
    this.setStatus(
      session.state === 'active' ? 'connected' : 'connecting',
      null,
    );
    if (reconnected) this.options.onReconnected();
    return rpc;
  }

  private handleDropped(rpc: RpcPeer, reason: SessionCloseReason): void {
    if (this.rpc !== rpc) return;
    this.rpc = null;
    this.options.onSessionEnded?.(reason);
    if (!this.wanted) {
      this.setStatus('idle', null);
      return;
    }
    if (this.endedMessage !== null) {
      this.setStatus('error', this.endedMessage);
      return;
    }
    this.setStatus('connecting', null);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retryTimer || this.endedMessage !== null) return;
    const min = this.options.minRetryDelayMs ?? 1_000;
    const max = this.options.maxRetryDelayMs ?? 15_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    // Jitter, so controllers that lost a host together do not retry in step.
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) void this.ensure().catch(() => undefined);
    }, delay);
    this.retryTimer.unref?.();
  }

  private setStatus(
    status: RemoteHostConnectionStatus,
    error: string | null,
  ): void {
    if (this.statusValue === status && this.errorValue === error) return;
    this.statusValue = status;
    this.errorValue = error;
    this.options.onStatusChange();
  }
}
