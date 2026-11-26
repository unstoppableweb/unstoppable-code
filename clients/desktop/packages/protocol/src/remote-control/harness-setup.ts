/**
 * Agent harness setup on a computer, as its Settings provider rows and a
 * controlling browser read it (gap 1 of CAN-6718): each managed runtime's
 * status and progress, Claude's and Codex's sign-in status, the Codex
 * device-code sign-in and the fixed sign-in text stream.
 *
 * These are the portable shapes the CanopyClient `harnessSetup` member
 * answers with. The readers copy only the fields named here, so a newer
 * host's extra field never reaches shared UI, and each reader answers `null`
 * for a value that is not the shape at all.
 *
 * The host sends a browser controller less than its own window receives (see
 * `docs/remote-control-protocol.md`, "Harness setup from a browser"): no
 * Antigravity executable path and no auth fingerprint. Sign-in output reaches
 * only the controller whose bridge started that sign-in.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === 'string' && allowed.some((option) => option === value)
  );
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Spread helper: `{ key: value }` when `value` is defined, else `{}`. */
function field<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  const result: { [P in K]?: V } = {};
  if (value !== undefined) result[key] = value;
  return result;
}

/** The fields every managed provider runtime status shares. */
interface ManagedRuntimeFields {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly version: string;
  readonly percent?: number;
  /** The pinned archive size in bytes, where this platform has one. */
  readonly archiveBytes?: number;
}

function readManagedRuntimeFields(
  value: Record<string, unknown>,
): ManagedRuntimeFields | null {
  if (
    typeof value.supported !== 'boolean' ||
    typeof value.installed !== 'boolean' ||
    typeof value.enabled !== 'boolean' ||
    typeof value.version !== 'string'
  )
    return null;
  return {
    supported: value.supported,
    installed: value.installed,
    enabled: value.enabled,
    version: value.version,
    ...field('percent', optionalNumber(value.percent)),
    ...field('archiveBytes', optionalNumber(value.archiveBytes)),
  };
}

export const HARNESS_CURSOR_PHASES = [
  'idle',
  'downloading',
  'verifying',
  'installing',
  'signing-out',
  'signing-in',
  'connected',
] as const;
export type HarnessCursorPhase = (typeof HARNESS_CURSOR_PHASES)[number];

/** The Cursor account the managed runtime is signed in as. */
export interface HarnessCursorAccount {
  /** Empty when the CLI reports no email, or one that is not a plain address. */
  readonly email: string;
}

/**
 * What the row showed when the person acted. `change` may sign the shared
 * credential store out; `sign-in` promises it will not.
 */
export type HarnessCursorAccountIntent = 'change' | 'sign-in';

/**
 * What the adapter sends after Cursor's Connect and Change account
 * arguments: the browser shows the sign-in link (`signInUrl`) itself. The
 * computer refuses a remote Cursor sign-in without it before signing
 * anything out.
 */
export const HARNESS_CURSOR_SIGN_IN_CLIENT = Object.freeze({
  signInLink: true,
} as const);

export interface HarnessCursorStatus extends ManagedRuntimeFields {
  readonly phase: HarnessCursorPhase;
  /** Present only on results that probed the CLI (Connect, Change account). */
  readonly account?: HarnessCursorAccount | null;
  /**
   * The cursor.com sign-in link, on `signing-in` progress of a sign-in a
   * controller started. The controller opens it in its own browser.
   */
  readonly signInUrl?: string;
}

export function readHarnessCursorAccount(
  value: unknown,
): HarnessCursorAccount | null {
  return isRecord(value) && typeof value.email === 'string'
    ? { email: value.email }
    : null;
}

export function readHarnessCursorStatus(
  value: unknown,
): HarnessCursorStatus | null {
  if (!isRecord(value) || !oneOf(value.phase, HARNESS_CURSOR_PHASES))
    return null;
  const base = readManagedRuntimeFields(value);
  if (!base) return null;
  return {
    ...base,
    phase: value.phase,
    ...(value.account === null
      ? { account: null }
      : field('account', readHarnessCursorAccount(value.account) ?? undefined)),
    ...field('signInUrl', optionalString(value.signInUrl)),
  };
}

export const HARNESS_COPILOT_PHASES = [
  'idle',
  'downloading',
  'verifying',
  'installing',
  'authorizing',
  'checking',
  'connected',
] as const;
export type HarnessCopilotPhase = (typeof HARNESS_COPILOT_PHASES)[number];

export interface HarnessCopilotAccount {
  readonly host: string;
  readonly login: string;
}

export interface HarnessCopilotStatus extends ManagedRuntimeFields {
  readonly phase: HarnessCopilotPhase;
  readonly account?: HarnessCopilotAccount | null;
  /** GitHub device-flow code, only while authorizing. */
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly expiresAt?: string;
}

export function readHarnessCopilotAccount(
  value: unknown,
): HarnessCopilotAccount | null {
  return isRecord(value) &&
    typeof value.host === 'string' &&
    typeof value.login === 'string'
    ? { host: value.host, login: value.login }
    : null;
}

export function readHarnessCopilotStatus(
  value: unknown,
): HarnessCopilotStatus | null {
  if (!isRecord(value) || !oneOf(value.phase, HARNESS_COPILOT_PHASES))
    return null;
  const base = readManagedRuntimeFields(value);
  if (!base) return null;
  return {
    ...base,
    phase: value.phase,
    ...(value.account === null
      ? { account: null }
      : field(
          'account',
          readHarnessCopilotAccount(value.account) ?? undefined,
        )),
    ...field('userCode', optionalString(value.userCode)),
    ...field('verificationUri', optionalString(value.verificationUri)),
    ...field('expiresAt', optionalString(value.expiresAt)),
  };
}

export const HARNESS_OPENCODE_PHASES = [
  'idle',
  'downloading',
  'verifying',
  'installing',
  'discovering',
  'connected',
] as const;
export type HarnessOpenCodePhase = (typeof HARNESS_OPENCODE_PHASES)[number];

export interface HarnessOpenCodeStatus extends ManagedRuntimeFields {
  readonly phase: HarnessOpenCodePhase;
}

export function readHarnessOpenCodeStatus(
  value: unknown,
): HarnessOpenCodeStatus | null {
  if (!isRecord(value) || !oneOf(value.phase, HARNESS_OPENCODE_PHASES))
    return null;
  const base = readManagedRuntimeFields(value);
  return base ? { ...base, phase: value.phase } : null;
}

export const HARNESS_ANTIGRAVITY_RUNTIME_PHASES = [
  'idle',
  'downloading',
  'verifying',
  'installed',
  'failed',
] as const;
export type HarnessAntigravityRuntimePhase =
  (typeof HARNESS_ANTIGRAVITY_RUNTIME_PHASES)[number];

/** The managed Antigravity CLI download on the computer. */
export interface HarnessAntigravityRuntimeStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  /** Whether the installed copy is the managed one, not the person's own. */
  readonly managed: boolean;
  readonly version: string;
  readonly phase: HarnessAntigravityRuntimePhase;
  /**
   * Where the person's own copy is, for the computer's own window and
   * desktop controllers. A browser never receives it: the host removes it.
   */
  readonly executable?: string;
  readonly error?: string;
  /**
   * Set only on the answer to an install this browser joined and then
   * cancelled: it stopped waiting, and the install goes on in the window
   * that started it, still in `phase`.
   */
  readonly detached?: true;
}

export function readHarnessAntigravityRuntimeStatus(
  value: unknown,
): HarnessAntigravityRuntimeStatus | null {
  if (
    !isRecord(value) ||
    typeof value.supported !== 'boolean' ||
    typeof value.installed !== 'boolean' ||
    typeof value.managed !== 'boolean' ||
    typeof value.version !== 'string' ||
    !oneOf(value.phase, HARNESS_ANTIGRAVITY_RUNTIME_PHASES)
  )
    return null;
  return {
    supported: value.supported,
    installed: value.installed,
    managed: value.managed,
    version: value.version,
    phase: value.phase,
    ...field('executable', optionalString(value.executable)),
    ...field('error', optionalString(value.error)),
    ...(value.detached === true ? { detached: true } : {}),
  };
}

/** Claude's or Codex's sign-in status on the computer. */
export interface HarnessProviderAuthStatus {
  readonly authenticated: boolean;
  readonly accountLabel: string | null;
  readonly detail: string | null;
  readonly error: string | null;
  readonly planType?: string | null;
  readonly workspaceName?: string | null;
  /** `authenticated: false` is not a confirmed sign-out. */
  readonly probeFailed?: boolean;
}

export function readHarnessProviderAuthStatus(
  value: unknown,
): HarnessProviderAuthStatus | null {
  if (!isRecord(value) || typeof value.authenticated !== 'boolean') return null;
  return {
    authenticated: value.authenticated,
    accountLabel: nullableString(value.accountLabel),
    detail: nullableString(value.detail),
    error: nullableString(value.error),
    ...(value.planType === undefined
      ? {}
      : { planType: nullableString(value.planType) }),
    ...(value.workspaceName === undefined
      ? {}
      : { workspaceName: nullableString(value.workspaceName) }),
    ...(value.probeFailed === true ? { probeFailed: true } : {}),
  };
}

export const HARNESS_CODEX_LOGIN_PHASES = [
  'ready',
  'confirm',
  'pausing',
  'waiting',
  'verifying',
  'complete',
  'verification-failed',
] as const;
export type HarnessCodexLoginPhase =
  (typeof HARNESS_CODEX_LOGIN_PHASES)[number];

/**
 * A Codex sign-in attempt. A browser only ever starts the device-code
 * method: `userCode` and `verificationUrl` are what it shows and opens. The
 * browser method's URL carries the attempt's PKCE state and a callback on
 * the computer, so it is never part of this state.
 */
export interface HarnessCodexLoginState {
  readonly attemptId: string | null;
  readonly phase: HarnessCodexLoginPhase;
  /** Running turns the sign-in pauses; Continue confirms the pause. */
  readonly activeWorkCount: number;
  readonly method?: 'chatgpt' | 'chatgptDeviceCode';
  readonly userCode?: string;
  readonly verificationUrl?: string;
  readonly outcome?: 'success' | 'cancelled' | 'failed';
  readonly account?: HarnessProviderAuthStatus;
  readonly error?: string;
  /**
   * Set only on a start's answer when nothing started: another window's
   * attempt is running, or is still being cancelled.
   */
  readonly refusal?: 'already-running';
}

export function readHarnessCodexLoginState(
  value: unknown,
): HarnessCodexLoginState | null {
  if (
    !isRecord(value) ||
    !oneOf(value.phase, HARNESS_CODEX_LOGIN_PHASES) ||
    (value.attemptId !== null && typeof value.attemptId !== 'string') ||
    typeof value.activeWorkCount !== 'number'
  )
    return null;
  const method = oneOf(value.method, ['chatgpt', 'chatgptDeviceCode'] as const)
    ? value.method
    : undefined;
  const outcome = oneOf(value.outcome, [
    'success',
    'cancelled',
    'failed',
  ] as const)
    ? value.outcome
    : undefined;
  return {
    attemptId: value.attemptId,
    phase: value.phase,
    activeWorkCount: value.activeWorkCount,
    ...field('method', method),
    ...field('userCode', optionalString(value.userCode)),
    // The device-code page only; a browser-method URL is never shown.
    ...(method === 'chatgptDeviceCode'
      ? field('verificationUrl', optionalString(value.verificationUrl))
      : {}),
    ...field('outcome', outcome),
    ...field(
      'account',
      readHarnessProviderAuthStatus(value.account) ?? undefined,
    ),
    ...field('error', optionalString(value.error)),
    ...(value.refusal === 'already-running'
      ? { refusal: 'already-running' }
      : {}),
  };
}

/**
 * Providers a browser may start a sign-in for. Each runs one fixed sign-in
 * command on the computer (`claude auth login`, the verified OpenCode
 * runtime's `auth login`, Antigravity's `acp --login`); none is a shell.
 * GitHub's `gh auth login` and Codex's terminal path stay off this list.
 */
export const BROWSER_SIGN_IN_PROVIDERS = [
  'claude',
  'opencode',
  'antigravity',
] as const;
export type HarnessSignInProvider = (typeof BROWSER_SIGN_IN_PROVIDERS)[number];

/** The fixed size a browser asks for; the text view wraps its own lines. */
export const BROWSER_SIGN_IN_COLUMNS = 100;
export const BROWSER_SIGN_IN_ROWS = 30;
/** Bounds the host accepts on a browser's sign-in start. */
export const BROWSER_SIGN_IN_MAX_COLUMNS = 500;
export const BROWSER_SIGN_IN_MAX_ROWS = 200;

/**
 * Longest code line, Enter excluded, a browser may send into a sign-in. The
 * codes the providers print are far shorter; the bound only keeps a browser
 * from streaming into the process.
 */
export const BROWSER_SIGN_IN_LINE_MAX_LENGTH = 2048;
/** Longest sign-in session id a browser may name: the host's are UUIDs. */
export const BROWSER_SIGN_IN_SESSION_ID_MAX_LENGTH = 128;

/** A started sign-in. */
export interface HarnessSignInSession {
  readonly sessionId: string;
}

/** Text the sign-in command printed. */
export interface HarnessSignInOutput {
  readonly sessionId: string;
  readonly data: string;
}

/** The sign-in command ended. */
export interface HarnessSignInExit {
  readonly sessionId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export function readHarnessSignInSession(
  value: unknown,
): HarnessSignInSession | null {
  return isRecord(value) && typeof value.sessionId === 'string'
    ? { sessionId: value.sessionId }
    : null;
}

export function readHarnessSignInOutput(
  value: unknown,
): HarnessSignInOutput | null {
  return isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.data === 'string'
    ? { sessionId: value.sessionId, data: value.data }
    : null;
}

export function readHarnessSignInExit(
  value: unknown,
): HarnessSignInExit | null {
  if (!isRecord(value) || typeof value.sessionId !== 'string') return null;
  const exitCode =
    typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)
      ? value.exitCode
      : null;
  return {
    sessionId: value.sessionId,
    exitCode,
    signal: nullableString(value.signal),
  };
}

/**
 * Whether `line` may be sent as one code line: non-empty, at most
 * {@link BROWSER_SIGN_IN_LINE_MAX_LENGTH} characters and free of control
 * characters, so it can't carry a second line, an escape sequence or a
 * terminal signal.
 */
export function isHarnessSignInCodeLine(line: string): boolean {
  return (
    line.length > 0 &&
    line.length <= BROWSER_SIGN_IN_LINE_MAX_LENGTH &&
    // eslint-disable-next-line no-control-regex -- the check is for them.
    !/[\u0000-\u001f\u007f-\u009f]/u.test(line)
  );
}
