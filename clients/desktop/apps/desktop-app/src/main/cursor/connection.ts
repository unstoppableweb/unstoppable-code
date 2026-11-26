import { withProviderConnectionAttempt } from '../lib/provider-connection-events';
import { revokeDelegationLifecycle } from '../agents/delegation/lifecycle';
import { stripVTControlCharacters } from 'node:util';
import type {
  CursorAccount,
  CursorAccountIntent,
  CursorConnectionStatus,
} from '@canopy/desktop-shared/types';
import type { CursorRuntimeTarget } from '@canopy/desktop-shared/lib/cursor-runtime-targets';
import {
  getCursorRuntimeRootDir,
  getCursorRuntimeStateDir,
} from '../lib/paths';
import { updatePreferencesFile } from '../lib/preferences-store';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { ProviderAccountConnectSource } from '../auth/provider-auth-state';
import { openExternalGuarded } from '../lib/open-external';
import { isProviderSignInLink } from '@canopy/desktop-shared/lib/provider-sign-in-links';
import {
  assertCursorSignInReachable,
  cursorSignInLinkOpener,
  type CursorSignInOptions,
} from './sign-in-link';
import { getEnhancedEnv } from '../pipelines/config-paths';
import {
  CursorRuntimeInstaller,
  type CursorRuntimeArtifact,
  type CursorLaunch,
} from './runtime-installer';
import {
  getCursorRuntimeArtifact,
  getCursorRuntimeTargetForHost,
  CURSOR_RUNTIME_VERSION,
} from '@canopy/desktop-shared/node/cursor/runtime-metadata';
import {
  prepareCursorRuntimeEnvironment,
  type CursorRuntimeEnvironmentOptions,
} from '@canopy/desktop-shared/node/cursor/runtime-environment';
import { runCursorRuntimeCommand } from '@canopy/desktop-shared/node/cursor/runtime-process';
import { cursorConnectionStatus } from './runtime-status';

// One message for one condition: `runtime()` runs before the artifact read on
// every Connect path, so a second wording here would never reach a user.
const UNSUPPORTED_DEVICE = 'Cursor setup is not available on this device.';

function artifactForRuntime(): CursorRuntimeArtifact {
  const artifact = getCursorRuntimeArtifact();
  if (!artifact) throw new Error(UNSUPPORTED_DEVICE);
  // Compiled out of production. Tests use a local archive with its own pinned digests.
  if (
    typeof __CANOPY_E2E__ !== 'undefined' &&
    __CANOPY_E2E__ &&
    process.env.CANOPY_E2E_CURSOR_RUNTIME
  ) {
    const value: unknown = JSON.parse(process.env.CANOPY_E2E_CURSOR_RUNTIME);
    if (
      typeof value === 'object' &&
      value !== null &&
      'url' in value &&
      typeof value.url === 'string' &&
      'sha256' in value &&
      typeof value.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.sha256) &&
      'filesSha256' in value &&
      typeof value.filesSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.filesSha256) &&
      'archiveBytes' in value &&
      typeof value.archiveBytes === 'number' &&
      Number.isSafeInteger(value.archiveBytes) &&
      value.archiveBytes > 0 &&
      value.archiveBytes < 1024 * 1024
    )
      return {
        version: artifact.version,
        url: value.url,
        sha256: value.sha256,
        filesSha256: value.filesSha256,
        archiveBytes: value.archiveBytes,
      };
    throw new Error('Invalid Cursor runtime test fixture.');
  }
  return artifact;
}
// A fresh installer per call: the installer's own single-flight only dedupes
// within one instance, and production concurrency is bounded by the IPC layer's
// `active` guard in ipc/cursor-connection.ts.
function runtime(): {
  installer: CursorRuntimeInstaller;
  target: CursorRuntimeTarget;
} {
  // Resolved once here so callers that also need the target share this guard
  // rather than repeating a throw that could never fire.
  const target = getCursorRuntimeTargetForHost();
  if (!target) throw new Error(UNSUPPORTED_DEVICE);
  return {
    target,
    installer: new CursorRuntimeInstaller({
      root: getCursorRuntimeRootDir(),
      artifact: artifactForRuntime(),
      target,
      allowLoopback: typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__,
    }),
  };
}
type RuntimeEnvironmentScope = Exclude<
  NonNullable<Parameters<typeof getEnhancedEnv>[0]>['environment'],
  false | undefined
>;

/**
 * The only way to build a Cursor child environment. Canopy-managed secrets
 * never enter it; user-configured runtime variables enter only when a caller
 * names the scope that owns them.
 */
export function cursorBaseEnvironment(
  environment?: RuntimeEnvironmentScope,
): NodeJS.ProcessEnv {
  return getEnhancedEnv({
    includeCanopySecrets: false,
    environment: environment ?? false,
  });
}

export async function getManagedCursorRuntime(
  signal: AbortSignal,
  environment?: RuntimeEnvironmentScope,
  options?: CursorRuntimeEnvironmentOptions,
): Promise<{
  launch: CursorLaunch;
  env: NodeJS.ProcessEnv;
  target: CursorRuntimeTarget;
}> {
  const { installer, target } = runtime();
  const launch = await installer.verify(signal);
  const env = await prepareCursorRuntimeEnvironment(
    getCursorRuntimeStateDir(),
    cursorBaseEnvironment(environment),
    process.platform,
    options,
  );
  return { launch, env, target };
}
export type { CursorSignInOptions } from './sign-in-link';

export async function connectCursor(
  signal: AbortSignal,
  progress: (status: CursorConnectionStatus) => void,
  options: CursorSignInOptions = {},
): Promise<CursorConnectionStatus> {
  return withProviderConnectionAttempt('cursor', 'native_login', signal, () =>
    connectCursorImpl(signal, progress, options),
  );
}

async function connectCursorImpl(
  signal: AbortSignal,
  progress: (status: CursorConnectionStatus) => void,
  options: CursorSignInOptions,
): Promise<CursorConnectionStatus> {
  const { installer } = runtime();
  const status: CursorConnectionStatus = {
    supported: true,
    installed: false,
    enabled: false,
    version: CURSOR_RUNTIME_VERSION,
    phase: 'downloading',
    archiveBytes: artifactForRuntime().archiveBytes,
  };
  const launch = await installer.install(signal, (phase, percent) =>
    progress({ ...status, phase, percent }),
  );
  signal.throwIfAborted();
  // The vendor CLI never receives Canopy-managed secrets or user-configured
  // runtime variables; it only needs the managed PATH and the private overlay.
  const env = await prepareCursorRuntimeEnvironment(
    getCursorRuntimeStateDir(),
    cursorBaseEnvironment(),
  );
  const version = await runCursorRuntimeCommand(
    launch,
    ['--version'],
    env,
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  );
  if (version.code !== 0 || version.stdout.trim() !== CURSOR_RUNTIME_VERSION)
    throw new Error(
      'Cursor runtime version verification failed. Try connecting again.',
    );
  // Setup replaces whoever was signed in, so no read that began before it may
  // commit afterwards.
  invalidateCursorAccountCache();
  const generation = accountGeneration;
  let signIn = await readCursorSignIn(launch, env, signal);
  // Setup signs in whenever the runtime is not already signed in. An unknown
  // read is treated the same way here: `login` on a live session is harmless,
  // unlike the sign-out an account change would run.
  if (signIn.state !== 'signed-in') {
    assertCursorSignInReachable(options);
    const signingIn: CursorConnectionStatus = {
      ...status,
      installed: true,
      phase: 'signing-in',
    };
    progress(signingIn);
    await signInWithBrowser(
      launch,
      env,
      signal,
      cursorSignInLinkOpener(options, (signInUrl) =>
        progress({ ...signingIn, signInUrl }),
      ),
    );
    // `login` exiting cleanly is not proof of a session; require the CLI to
    // report authentication before this app records the runtime as connected.
    signIn = await readCursorSignIn(launch, env, signal);
    if (signIn.state !== 'signed-in')
      throw new Error('Cursor sign-in did not finish. Try connecting again.');
  }
  signal.throwIfAborted();
  await updatePreferencesFile(() => ({
    cursorEnabled: true,
    cursorAgentPath: '',
  }));
  if (signal.aborted) {
    await updatePreferencesFile(() => ({ cursorEnabled: false }));
    signal.throwIfAborted();
  }
  const connected: CursorConnectionStatus = {
    ...status,
    installed: true,
    enabled: true,
    phase: 'connected',
    account: signIn.account,
  };
  if (generation === accountGeneration) {
    cachedAccount = { account: signIn.account, readAt: Date.now() };
    confirmCursorAccount(signIn.account, 'in_app');
  }
  progress(connected);
  return connected;
}

/** What `status --format json` says about the shared Cursor sign-in. */
type CursorSignIn =
  | { state: 'signed-in'; account: CursorAccount }
  | { state: 'signed-out'; account: null }
  | { state: 'unknown'; account: null };

/**
 * The CLI resolves rather than rejects on a non-zero exit, so a read that
 * failed has to be told apart from a real sign-out here. Collapsing the two
 * would offer a sign-in button on a guess, and that button signs the shared
 * credential store out.
 */
function parseCursorSignIn(result: {
  code: number | null;
  stdout: string;
}): CursorSignIn {
  if (result.code !== 0) return { state: 'unknown', account: null };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { state: 'unknown', account: null };
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('isAuthenticated' in value) ||
    typeof value.isAuthenticated !== 'boolean'
  )
    return { state: 'unknown', account: null };
  if (!value.isAuthenticated) return { state: 'signed-out', account: null };
  const info: unknown = 'userInfo' in value ? value.userInfo : undefined;
  const raw =
    typeof info === 'object' &&
    info !== null &&
    'email' in info &&
    typeof info.email === 'string'
      ? info.email.trim()
      : '';
  // Third-party CLI stdout reaches the panel and every App Advisor prompt from
  // here. Length alone does not stop newlines or bidi overrides, so anything
  // that is not a plain address is dropped; the panel renders `Signed in`.
  // Checked before any truncation: a cut address is a different address, and
  // naming the wrong account is worse than naming none.
  const email =
    raw.length <= MAX_ACCOUNT_EMAIL_LENGTH && ACCOUNT_EMAIL_PATTERN.test(raw)
      ? raw
      : '';
  return { state: 'signed-in', account: { email } };
}

async function readCursorSignIn(
  launch: CursorLaunch,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<CursorSignIn> {
  return parseCursorSignIn(
    await runCursorRuntimeCommand(
      launch,
      ['status', '--format', 'json'],
      env,
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    ),
  );
}

/** Runs the CLI's browser sign-in, opening the first cursor.com URL it prints. */
async function signInWithBrowser(
  launch: CursorLaunch,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  openUrl: (url: string) => Promise<void> = openExternalGuarded,
): Promise<void> {
  let opened = false;
  let openFailed = false;
  let opening: Promise<void> | undefined;
  const loginAbort = new AbortController();
  const result = await runCursorRuntimeCommand(
    launch,
    ['login'],
    env,
    AbortSignal.any([
      signal,
      AbortSignal.timeout(5 * 60_000),
      loginAbort.signal,
    ]),
    (output) => {
      if (opened || signal.aborted) return;
      // `output` is the retained stdout buffer, not a single chunk, so the
      // trailing-whitespace lookahead is satisfied by any later newline.
      const match = stripVTControlCharacters(output).match(
        /https:\/\/cursor\.com\/[^\s]+(?=\s)/,
      );
      if (!match) return;
      const url = new URL(match[0]);
      if (!isProviderSignInLink('cursor', url.href)) return;
      opened = true;
      // A browser that cannot open ends the sign-in wait immediately instead
      // of leaving the CLI to run out its five-minute deadline.
      opening = openUrl(url.href).catch(() => {
        openFailed = true;
        loginAbort.abort();
      });
    },
  );
  await opening;
  if (openFailed)
    throw new Error(
      'Could not open the browser for Cursor sign-in. Try connecting again.',
    );
  if (result.code !== 0)
    throw new Error('Cursor sign-in did not finish. Try connecting again.');
}

/** RFC 5321 caps an address at 254 characters. */
const MAX_ACCOUNT_EMAIL_LENGTH = 254;
/** Deliberately narrower than RFC 5322: printable, no spaces, one `@`. */
// Constructor form, not a literal: this project's tsconfig has no `target`,
// and `tsc -b` rejects a `u`-flagged literal below es6 (TS1501).
const ACCOUNT_EMAIL_PATTERN = new RegExp(
  '^[^\\s@\\p{C}]+@[^\\s@\\p{C}]+\\.[^\\s@\\p{C}]+$',
  'u',
);
/**
 * Reading the account launches the runtime, and every managed launch re-hashes
 * it, so the answer is cached: the settings panel unmounts whenever the user
 * switches sections and would otherwise pay for a full verification each time.
 * Every flow that can change the answer clears this, and the short window
 * bounds a sign-in the user made outside the app.
 */
const ACCOUNT_CACHE_MS = 5 * 60_000;
let cachedAccount:
  | { account: CursorAccount | null; readAt: number }
  | undefined;
// A read runs the CLI for seconds, so an account change can start and finish
// while one is in flight. The generation stamp lets a read that began before
// an invalidation be discarded instead of committing a pre-change answer on
// top of the post-change one.
let accountGeneration = 0;

/** A Cursor account was confirmed signed in, as a different account. */
export interface ConfirmedCursorAccountEvent {
  connectSource: ProviderAccountConnectSource;
}

type ConfirmedCursorAccountListener = (
  event: ConfirmedCursorAccountEvent,
) => void;

const confirmedAccountListeners = new Set<ConfirmedCursorAccountListener>();
/**
 * The account last confirmed this launch, by email (never reported): `null`
 * once confirmed signed out, `undefined` before the first confirmation.
 */
let confirmedAccountEmail: string | null | undefined;

/**
 * Hear each confirmed Cursor sign-in: the first signed-in read this launch, a
 * Connect or Change account, and a different account found by a later read.
 * A repeat of the same account, a sign-out, and an unreadable sign-in are not
 * reported. Listeners must be quick and must not throw.
 */
export function subscribeConfirmedCursorAccount(
  listener: ConfirmedCursorAccountListener,
): () => void {
  confirmedAccountListeners.add(listener);
  return (): void => {
    confirmedAccountListeners.delete(listener);
  };
}

export function resetConfirmedCursorAccountForTests(): void {
  confirmedAccountEmail = undefined;
}

function confirmCursorAccount(
  account: CursorAccount | null,
  via: 'in_app' | 'read',
): void {
  const previous = confirmedAccountEmail;
  confirmedAccountEmail = account?.email ?? null;
  if (!account || previous === account.email) return;
  const event: ConfirmedCursorAccountEvent = {
    connectSource:
      via === 'in_app'
        ? 'in_app'
        : previous === undefined
          ? 'at_startup'
          : 'external_change',
  };
  for (const listener of Array.from(confirmedAccountListeners)) {
    try {
      listener(event);
    } catch (error) {
      logMainProcessWarn('[cursor] Account listener failed', error);
    }
  }
}

export function peekCursorAccount(): CursorAccount | null | undefined {
  return cachedAccount && Date.now() - cachedAccount.readAt < ACCOUNT_CACHE_MS
    ? cachedAccount.account
    : undefined;
}

export function getCursorAccountGeneration(): number {
  return accountGeneration;
}

export function invalidateCursorAccountCache(): void {
  cachedAccount = undefined;
  accountGeneration += 1;
}

/**
 * The account the installed runtime is signed in as, or `null` when signed
 * out. Verifies the runtime before running it, like every managed launch.
 * Rejects when the sign-in cannot be read, so callers report that rather than
 * showing a failed read as a sign-out.
 */
export async function readCursorAccount(
  signal: AbortSignal,
): Promise<CursorAccount | null> {
  if (cachedAccount && Date.now() - cachedAccount.readAt < ACCOUNT_CACHE_MS)
    return cachedAccount.account;
  const generation = accountGeneration;
  const { launch, env } = await getManagedCursorRuntime(signal);
  const signIn = await readCursorSignIn(launch, env, signal);
  if (signIn.state === 'unknown')
    throw new Error('Could not check the Cursor sign-in.');
  if (generation === accountGeneration) {
    cachedAccount = { account: signIn.account, readAt: Date.now() };
    confirmCursorAccount(signIn.account, 'read');
  }
  return signIn.account;
}

async function revokeCursorDelegations(): Promise<void> {
  try {
    await revokeDelegationLifecycle('cursor');
  } catch (error) {
    // Both callers have invalidated the account generation, denying retained
    // routes. Failed cleanup must not block disabling Cursor or changing accounts.
    logMainProcessWarn(
      '[cursor] Delegation revocation failed; continuing account transition',
      error,
    );
  }
}

/**
 * Runs the same browser sign-in as Connect. `change` first signs the shared
 * Cursor credential store out so the CLI prompts for an account instead of
 * short-circuiting on the live session; `sign-in` takes nothing away, and the
 * panel's copy promises exactly that. The intent is checked against a live
 * read rather than trusted: if the runtime is not in the state the panel
 * showed, this refuses instead of signing out a session the user never saw.
 * The runtime stays enabled throughout; a cancelled or failed sign-in leaves
 * it connected but signed out, which the panel reports.
 */
export async function changeCursorAccount(
  signal: AbortSignal,
  progress: (status: CursorConnectionStatus) => void,
  intent: CursorAccountIntent,
  /**
   * Runs once the pre-flight checks pass and the account is about to change.
   * The refusals above it change nothing, so a caller that drops per-account
   * state must not do so until this fires.
   */
  onBeforeChange: () => Promise<void> = (): Promise<void> => Promise.resolve(),
  options: CursorSignInOptions = {},
): Promise<CursorConnectionStatus> {
  return withProviderConnectionAttempt('cursor', 'native_login', signal, () =>
    changeCursorAccountImpl(signal, progress, intent, onBeforeChange, options),
  );
}

async function changeCursorAccountImpl(
  signal: AbortSignal,
  progress: (status: CursorConnectionStatus) => void,
  intent: CursorAccountIntent,
  /**
   * Runs once the pre-flight checks pass and the account is about to change.
   * The refusals above it change nothing, so a caller that drops per-account
   * state must not do so until this fires.
   */
  onBeforeChange: () => Promise<void> = (): Promise<void> => Promise.resolve(),
  options: CursorSignInOptions = {},
): Promise<CursorConnectionStatus> {
  // Before any read or sign-out: a controller that can't show the link
  // could never finish the sign-in this would leave pending.
  assertCursorSignInReachable(options);
  // The returned status must not out-claim reality: read the real one rather
  // than asserting this runtime is supported, installed and enabled.
  const base = await cursorConnectionStatus();
  if (!base.enabled || !base.installed)
    throw new Error('Connect Cursor before changing its account.');
  const { launch, env } = await getManagedCursorRuntime(signal);
  const current = await readCursorSignIn(launch, env, signal);
  if (current.state === 'unknown')
    throw new Error('Could not check the Cursor sign-in. Try again.');
  if (intent === 'sign-in' && current.state === 'signed-in')
    throw new Error('Cursor is already signed in. Try Change account.');
  // Anything past this point can change who is signed in.
  await onBeforeChange();
  invalidateCursorAccountCache();
  await revokeCursorDelegations();
  const generation = accountGeneration;
  const status: CursorConnectionStatus = { ...base, phase: 'signing-in' };
  if (current.state === 'signed-in') {
    // Announced here rather than at the click: the pre-flight read above can
    // take seconds and can refuse, and a status line must not report a
    // sign-out that never ran.
    progress({ ...base, phase: 'signing-out' });
    const signedOut = await runCursorRuntimeCommand(
      launch,
      ['logout'],
      env,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    );
    if (signedOut.code !== 0)
      throw new Error('Could not sign out of Cursor. Try again.');
  }
  progress(status);
  await signInWithBrowser(
    launch,
    env,
    signal,
    cursorSignInLinkOpener(options, (signInUrl) =>
      progress({ ...status, signInUrl }),
    ),
  );
  const signIn = await readCursorSignIn(launch, env, signal);
  if (signIn.state !== 'signed-in')
    throw new Error('Cursor sign-in did not finish. Try again.');
  signal.throwIfAborted();
  const connected: CursorConnectionStatus = {
    ...status,
    phase: 'connected',
    account: signIn.account,
  };
  if (generation === accountGeneration) {
    cachedAccount = { account: signIn.account, readAt: Date.now() };
    confirmCursorAccount(signIn.account, 'in_app');
  }
  progress(connected);
  return connected;
}
export async function disconnectCursor(): Promise<void> {
  invalidateCursorAccountCache();
  // Connecting again, even as the same account, is a new in-app sign-in.
  confirmedAccountEmail = null;
  await revokeCursorDelegations();
  await updatePreferencesFile(() => ({
    cursorEnabled: false,
    cursorAgentPath: '',
  }));
}
