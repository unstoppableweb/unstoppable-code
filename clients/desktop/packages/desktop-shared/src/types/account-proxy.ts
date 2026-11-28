import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import type {
  ProviderRateLimitSnapshot,
  ProviderUsageErrorInfo,
} from '@canopy/execution-engine/types/observability';
import type {
  AccountProxyConnection,
  AccountProxyErrorCode,
  AccountProxyRoutingStrategy,
} from '@canopy/protocol/preferences';
// Account proxy (CLIProxyAPI) contracts shared by main, preload, and the
// renderer. See docs/planning/2026-10-12-account-proxy/README.md.

export { ACCOUNT_PROXY_ROUTING_STRATEGIES } from '@canopy/protocol/preferences';
export type {
  AccountProxyConnection,
  AccountProxyConnectionKind,
  AccountProxyErrorCode,
  AccountProxyRoutingStrategy,
} from '@canopy/protocol/preferences';

/** The oldest CLIProxyAPI major version whose v8 management API we speak. */
export const ACCOUNT_PROXY_MIN_MAJOR_VERSION = 8;

export type AccountProxyAccountStatus =
  | 'active'
  | 'cooling'
  | 'error'
  | 'disabled'
  | 'refreshing'
  | 'pending'
  /** The proxy can no longer renew this sign-in; it needs a new one. */
  | 'sign-in-required';

export interface AccountProxyLimit {
  readonly id: 'five-hour' | 'weekly';
  /** 0–100. */
  readonly usedPercent: number;
  /** Epoch milliseconds, or null when the provider did not say. */
  readonly resetsAt: number | null;
}

/** A successful provider usage observation attached to a proxy account. */
export interface AccountProxyUsageSnapshot {
  readonly rateLimits: ProviderRateLimitSnapshot[];
  /** Non-secret plan type resolved from this credential's OAuth profile. */
  readonly planType?: string;
  readonly source: 'live' | 'passive';
  /** Time of an actual provider/proxy observation; never the poll time. */
  readonly lastUpdatedAt?: string;
  readonly errorInfo?: ProviderUsageErrorInfo;
  /** Epoch milliseconds before which a rate-limited read should not retry. */
  readonly retryAt?: number;
}

export interface AccountProxyAccount {
  /** CLIProxyAPI's `auth_index`, stable per credential. */
  readonly authIndex: string;
  /** `claude`, `codex`, `antigravity`, `kimi`, `xai`, `gemini`, and so on. */
  readonly provider: string;
  /** Email, label, or the configured group name. */
  readonly label: string;
  /**
   * `sign-in` accounts are credential files the proxy can turn off or remove.
   * `api-key` accounts come from the server's config file.
   */
  readonly source: 'sign-in' | 'api-key';
  /** Credential file name; present for `sign-in` accounts only. */
  readonly fileName: string | null;
  /** Subscription type from credential metadata or this account's OAuth profile. */
  readonly planType: string | null;
  readonly status: AccountProxyAccountStatus;
  /** The proxy's own status message, when it has one. */
  readonly statusMessage: string | null;
  /** Epoch milliseconds when a cooldown ends. */
  readonly availableAt: number | null;
  readonly limits: readonly AccountProxyLimit[];
  /** Detailed provider usage, if a live or passive observation is available. */
  readonly usage?: AccountProxyUsageSnapshot;
}

export interface AccountProxyError {
  readonly secureStorageFailure?: SecureStorageFailure;
  readonly code: AccountProxyErrorCode;
  readonly message: string;
}

export interface AccountProxyRouting {
  readonly strategy: AccountProxyRoutingStrategy;
  /** The server's own `routing.session-affinity`; null when unreadable. */
  readonly sessionAffinity: boolean | null;
}

/**
 * The proxy Canopy runs on this device (CAN-4023). `unsupported` where no
 * release is published for the platform.
 */
export type AccountProxyLocalPhase =
  | 'unsupported'
  | 'not-installed'
  | 'installing'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'error';

export interface AccountProxyLocalRuntime {
  readonly phase: AccountProxyLocalPhase;
  /** The pinned release this device runs; null where unsupported. */
  readonly version: string | null;
  /** Download progress while `phase` is `installing`. */
  readonly install: {
    readonly step: 'downloading' | 'verifying' | 'installing';
    readonly percent: number | null;
  } | null;
  /** The loopback port while running. */
  readonly port: number | null;
  /** Start the proxy when Canopy starts; on unless the user turned it off. */
  readonly startWithApp: boolean;
  /** Why the last start failed, while `phase` is `error`. */
  readonly message: string | null;
}

/** Providers an account can be signed in for from the settings. */
export type AccountProxySignInProvider = 'claude' | 'codex';

/** An account sign-in started from the settings, until it finishes. */
export interface AccountProxySignIn {
  readonly provider: AccountProxySignInProvider;
  /** The credential being renewed; retained if the sign-in is retried. */
  readonly authIndex?: string;
  /** `waiting` until the browser sign-in finishes; `failed` keeps why. */
  readonly phase: 'waiting' | 'failed';
  readonly message: string | null;
}

export type AccountProxySignInRequest =
  | {
      readonly action: 'start';
      readonly provider: AccountProxySignInProvider;
      /** Sign this existing account in again instead of adding one. */
      readonly authIndex?: string;
    }
  | { readonly action: 'reopen' }
  | { readonly action: 'cancel' };

export interface AccountProxyLocalControlRequest {
  readonly action: 'start' | 'stop' | 'restart';
}

export interface AccountProxyStatus {
  /** The flag is on and the user has not turned the proxy off. */
  readonly available: boolean;
  readonly connection: AccountProxyConnection | null;
  readonly state: 'not-configured' | 'needs-key' | 'connected' | 'error';
  readonly error: AccountProxyError | null;
  readonly version: string | null;
  readonly accounts: readonly AccountProxyAccount[];
  readonly routing: AccountProxyRouting | null;
  /** "Keep a chat on one account"; on unless the user turned it off. */
  readonly keepChatOnOneAccount: boolean;
  /** Which harnesses send their requests through the proxy on this device. */
  readonly routeClaude: boolean;
  readonly routeCodex: boolean;
  /** Epoch milliseconds of the last successful read. */
  readonly refreshedAt: number | null;
  /** The proxy on this device, whether or not it is the connection. */
  readonly local: AccountProxyLocalRuntime;
  /** An account sign-in in progress on the proxy on this device. */
  readonly signIn: AccountProxySignIn | null;
}

/** One account that served a session, from the proxy's trace headers. */
export interface AccountProxySessionAccount {
  /**
   * The connection the session's requests went through. `authIndex` names an
   * account on this connection only: another connection reuses the same ids
   * for other credentials. Absent from a remote host on a release before it
   * was reported (the channel is tunneled), when the connection is unknown.
   */
  readonly connectionId?: string;
  readonly authIndex: string;
  /** Null when the recorded connection's last account list did not name it. */
  readonly label: string | null;
  readonly provider: string | null;
  readonly requests: number;
  /** The account that served the session's latest request. */
  readonly current: boolean;
}

/** Identifies one chat for {@link AccountProxyApi.sessionAccounts}. */
export interface AccountProxyChatRequest {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export interface AccountProxyConnectRequest {
  readonly url: string;
  readonly managementKey: string;
}

export interface AccountProxyAccountRequest {
  readonly authIndex: string;
}

export interface AccountProxySetAccountDisabledRequest extends AccountProxyAccountRequest {
  readonly disabled: boolean;
}

export interface AccountProxySetRoutingStrategyRequest {
  readonly strategy: AccountProxyRoutingStrategy;
}

/**
 * A connect attempt. Failures keep the previous connection and return the
 * error for the field it belongs to, so the user can fix it in place.
 */
export type AccountProxyConnectResult =
  | { readonly ok: true; readonly status: AccountProxyStatus }
  | { readonly ok: false; readonly error: AccountProxyError };

export interface AccountProxyApi {
  status(options?: {
    readonly refresh?: boolean;
    readonly refreshUsage?: boolean;
  }): Promise<AccountProxyStatus>;
  connect(
    request: AccountProxyConnectRequest,
  ): Promise<AccountProxyConnectResult>;
  disconnect(): Promise<AccountProxyStatus>;
  /**
   * Run the proxy on this device: download it if needed, start it, and make
   * it the connection in place of any server.
   */
  setUpLocal(): Promise<AccountProxyConnectResult>;
  controlLocal(
    request: AccountProxyLocalControlRequest,
  ): Promise<AccountProxyStatus>;
  /**
   * Sign an account in through the proxy on this device: opens the
   * provider's page in the browser, and the status updates when it finishes.
   */
  signIn(request: AccountProxySignInRequest): Promise<AccountProxyStatus>;
  setAccountDisabled(
    request: AccountProxySetAccountDisabledRequest,
  ): Promise<AccountProxyStatus>;
  removeAccount(
    request: AccountProxyAccountRequest,
  ): Promise<AccountProxyStatus>;
  /** Change the proxy's own `routing.strategy` through its management API. */
  setRoutingStrategy(
    request: AccountProxySetRoutingStrategyRequest,
  ): Promise<AccountProxyStatus>;
  /** The accounts that served a chat's requests so far, on this device. */
  sessionAccounts(
    request: AccountProxyChatRequest,
  ): Promise<readonly AccountProxySessionAccount[]>;
  onChanged(callback: (status: AccountProxyStatus) => void): () => void;
}
