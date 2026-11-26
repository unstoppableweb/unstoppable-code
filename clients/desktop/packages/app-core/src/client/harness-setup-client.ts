import type {
  HarnessAntigravityRuntimeStatus,
  HarnessCodexLoginState,
  HarnessCopilotAccount,
  HarnessCopilotStatus,
  HarnessCursorAccount,
  HarnessCursorAccountIntent,
  HarnessCursorStatus,
  HarnessOpenCodeStatus,
  HarnessProviderAuthStatus,
  HarnessSignInExit,
  HarnessSignInOutput,
  HarnessSignInProvider,
  HarnessSignInSession,
} from '@canopy/protocol/remote-control/harness-setup';
import type { Unsubscribe } from '../events/domain-events';

/**
 * One managed provider runtime on the computer (Cursor, Copilot, OpenCode):
 * its status, the Connect that downloads, verifies and signs it in, and the
 * progress of that work. Calls reject with the host's error.
 */
export interface HarnessManagedRuntimeClient<Status> {
  status(): Promise<Status>;
  connect(): Promise<Status>;
  /** Stops this client's own Connect or account change. */
  cancel(): Promise<void>;
  disconnect(): Promise<void>;
  /** Progress of Connect and account changes this client started. */
  onProgress(listener: (status: Status) => void): Unsubscribe;
}

/**
 * The computer's agent harness setup, for its Settings provider rows and a
 * browser controlling it (gap 1 of CAN-6718). Present only on hosts that
 * report `capabilities.harnessSetup`.
 *
 * Sign-ins never open a browser on the computer when a controller starts
 * them: Cursor's link arrives as `signInUrl` on progress, Copilot's device
 * code as `userCode`, Codex's device code on the login state, and Claude's,
 * OpenCode's and Antigravity's link and code prompt in the sign-in text.
 */
export interface HarnessSetupClient {
  /** The managed Antigravity CLI. The operation id names this install. */
  readonly antigravity: {
    status(): Promise<HarnessAntigravityRuntimeStatus>;
    install(operationId: string): Promise<HarnessAntigravityRuntimeStatus>;
    cancel(operationId: string): Promise<void>;
    onProgress(
      listener: (status: HarnessAntigravityRuntimeStatus) => void,
    ): Unsubscribe;
  };
  readonly cursor: HarnessManagedRuntimeClient<HarnessCursorStatus> & {
    /** Verifies the runtime and reads its signed-in account, if any. */
    account(): Promise<HarnessCursorAccount | null>;
    changeAccount(
      intent: HarnessCursorAccountIntent,
    ): Promise<HarnessCursorStatus>;
  };
  readonly copilot: HarnessManagedRuntimeClient<HarnessCopilotStatus> & {
    account(): Promise<HarnessCopilotAccount | null>;
    changeAccount(): Promise<HarnessCopilotStatus>;
  };
  readonly opencode: HarnessManagedRuntimeClient<HarnessOpenCodeStatus>;
  /** Claude's and Codex's sign-in status; `forceRefresh` probes again. */
  readonly providerAuth: {
    status(
      provider: 'claude' | 'codex',
      options?: { readonly forceRefresh?: boolean },
    ): Promise<HarnessProviderAuthStatus>;
  };
  /**
   * Codex's device-code sign-in. `start` with `confirmPause: false` answers
   * `confirm` when running turns would be paused; start again with `true`.
   */
  readonly codexLogin: {
    startDeviceCode(request: {
      readonly confirmPause: boolean;
    }): Promise<HarnessCodexLoginState>;
    cancel(): Promise<HarnessCodexLoginState>;
    retryVerification(): Promise<HarnessCodexLoginState>;
    onState(listener: (state: HarnessCodexLoginState) => void): Unsubscribe;
  };
  /**
   * The fixed sign-in commands (`claude auth login`, OpenCode's `auth login`,
   * Antigravity's `--login`) as a text stream with one code line at a time.
   * Starting one ends any sign-in already running on the computer.
   */
  readonly signIn: {
    start(provider: HarnessSignInProvider): Promise<HarnessSignInSession>;
    /** Sends one line, then Enter. Refuses a line with control characters. */
    submitLine(sessionId: string, line: string): Promise<void>;
    stop(sessionId: string): Promise<void>;
    onOutput(listener: (output: HarnessSignInOutput) => void): Unsubscribe;
    onExit(listener: (exit: HarnessSignInExit) => void): Unsubscribe;
  };
}
