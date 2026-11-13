import {
  createCodexAuthenticationConnection,
  type CodexAppServerConnection,
  type CodexAppServerConnectionOwner,
  type CodexAuthenticationLease,
} from './connection';
import { resolveCodexSpawnProfile } from './profile';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';

export type CodexManagedLogin =
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | {
      type: 'chatgptDeviceCode';
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };
export interface CodexLoginCompletion {
  loginId: string;
  success: boolean;
}

/** Control plane only. This capability never exposes arbitrary runtime requests. */
export class CodexAuthenticationSession {
  private connection: CodexAppServerConnection | null = null;
  private loginId: string | null = null;
  private readonly controller = new AbortController();
  private loginController = new AbortController();
  private readonly earlyCompletions = new Map<string, boolean>();
  private completionListener:
    | ((completion: CodexLoginCompletion) => void)
    | undefined;
  private closePromise: Promise<void> | null = null;
  private startPromise: Promise<CodexManagedLogin> | null = null;
  readonly ready: Promise<void>;

  constructor(
    private readonly lease: CodexAuthenticationLease,
    private readonly onClosed: () => void,
  ) {
    this.ready = lease.ready;
  }

  private createConnection(): CodexAppServerConnection {
    if (this.controller.signal.aborted)
      throw new Error('Codex sign-in was cancelled.');
    const profile = resolveCodexSpawnProfile();
    const owner: CodexAppServerConnectionOwner = {
      // Pin this control worker for the bounded login lifetime, including
      // the browser wait after account/login/start has returned.
      hasActiveTurn: () => true,
      getActiveTurnInterruptTarget: () => null,
      cancelPendingTurnStart: () => {},
      rejectActiveTurn: () => {},
      markProcessSuspended: () => {},
      markProcessFailed: () => {
        this.reportFailure();
      },
      handleConnectionNotification: (method, notification) => {
        if (
          method !== 'account/login/completed' ||
          !isRecord(notification.params)
        )
          return;
        const { loginId, success } = notification.params;
        if (typeof loginId !== 'string' || typeof success !== 'boolean') return;
        if (this.loginId === loginId)
          this.completionListener?.({ loginId, success });
        else if (this.loginId === null && this.earlyCompletions.size < 16)
          this.earlyCompletions.set(loginId, success);
      },
      handleApprovalRequest: async () => {},
      handleRequestUserInput: async () => {},
      handleDynamicToolCall: async () => {},
      handleMcpElicitation: async () => {},
    };
    const connection = createCodexAuthenticationConnection(profile, owner);
    this.connection = connection;
    return connection;
  }

  private reportFailure(): void {
    if (this.loginId)
      this.completionListener?.({ loginId: this.loginId, success: false });
  }

  start(
    type: 'chatgpt' | 'chatgptDeviceCode',
    onCompleted: (completion: CodexLoginCompletion) => void,
  ): Promise<CodexManagedLogin> {
    if (this.startPromise) return this.startPromise;
    this.completionListener = onCompleted;
    this.startPromise = (async (): Promise<CodexManagedLogin> => {
      await this.ready;
      if (this.loginController.signal.aborted)
        throw new Error('Codex sign-in was cancelled.');
      const connection = this.createConnection();
      const response = await connection.request(
        'account/login/start',
        { type },
        { signal: this.loginController.signal },
      );
      if (!isRecord(response) || typeof response.loginId !== 'string')
        throw new Error('Codex returned an invalid sign-in response.');
      let login: CodexManagedLogin;
      if (response.type === 'chatgpt' && typeof response.authUrl === 'string') {
        login = {
          type: response.type,
          loginId: response.loginId,
          authUrl: response.authUrl,
        };
      } else if (
        response.type === 'chatgptDeviceCode' &&
        typeof response.verificationUrl === 'string' &&
        typeof response.userCode === 'string'
      ) {
        login = {
          type: response.type,
          loginId: response.loginId,
          verificationUrl: response.verificationUrl,
          userCode: response.userCode,
        };
      } else throw new Error('Codex returned an unsupported sign-in response.');
      this.loginId = login.loginId;
      const early = this.earlyCompletions.get(login.loginId);
      this.earlyCompletions.clear();
      if (early !== undefined)
        queueMicrotask(() =>
          onCompleted({ loginId: login.loginId, success: early }),
        );
      return login;
    })();
    return this.startPromise;
  }

  /** Cancel may race persistence. Always retire and read the actual account next. */
  async retireLogin(): Promise<void> {
    this.completionListener = undefined;
    this.loginController.abort();
    if (!this.loginId) {
      const connection = this.connection;
      await connection?.terminateForFinalRelease();
      if (this.connection === connection) this.connection = null;
    }
    await this.startPromise?.catch(() => undefined);
    const connection = this.connection;
    if (connection && this.loginId) {
      await connection
        .request(
          'account/login/cancel',
          { loginId: this.loginId },
          { timeoutMs: 3_000 },
        )
        .catch(() => undefined);
    }
    await connection?.terminateForFinalRelease();
    if (this.connection === connection) this.connection = null;
    await this.startPromise?.catch(() => undefined);
    this.earlyCompletions.clear();
  }

  async resetLogin(): Promise<void> {
    await this.retireLogin();
    if (this.controller.signal.aborted)
      throw new Error('Codex sign-in was cancelled.');
    this.loginId = null;
    this.startPromise = null;
    this.loginController = new AbortController();
  }

  async verifyAccount(): Promise<unknown> {
    await this.retireLogin();
    // `start` requires readiness, so a failed cutover means no login began and
    // the stored account is unchanged. Read it once the cutover has settled.
    await this.ready.catch(() => undefined);
    return this.createConnection().request(
      'account/read',
      { refreshToken: false },
      { signal: this.controller.signal },
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.controller.abort();
    const guarded = (async (): Promise<void> => {
      await this.retireLogin();
      await this.lease.close();
      this.onClosed();
    })().catch((error: unknown) => {
      if (this.closePromise === guarded) this.closePromise = null;
      throw error;
    });
    this.closePromise = guarded;
    return this.closePromise;
  }
}
