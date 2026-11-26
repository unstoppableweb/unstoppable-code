// ---------------------------------------------------------------------------
// Connect Slack on this computer (CAN-7606, `slack:connect-this-computer`).
//
// One click, then Allow on Slack's own page:
// 1. Re-checks the Slack mentions flag and a signed-in, non-guest account,
//    and captures its credential. Off (always in a local-only build) refuses
//    before any network call.
// 2. `prepare`: the web proves this computer's relay device is the
//    account's and runs the hosted admission check, and answers with the
//    account's hosted root relay device. A refusal here changes nothing on
//    this computer.
// 3. Arms the pairing expectation for that root device (two minutes, single
//    use, this account), so the hosted pairing the web is about to start is
//    approved with no prompt.
// 4. Turns on Listen for Slack mentions and Allow incoming, waits up to 15 s
//    for the relay to list this computer as accepting Remote Control, then
//    asks the web to pair (when it isn't yet, or when this computer holds no
//    hosted controller) and mint a single-use connect intent. Retries once on
//    `offline`, inside the deadline.
// 5. Opens the browser signed in as the captured account at the web's
//    hand-off, `/slack/connect?intent=…`, in strict mode: never a signed-out
//    page. The web starts Sign in with Slack there and goes straight to
//    Slack's consent page (or, where it can't, to Integrations, which does).
//
// Single-flight (a second click joins the run), one 2-minute deadline, and
// the expectation is cleared on every exit. A failure after step 4 leaves the
// gate and Allow incoming on, as the switch itself does.
//
// Both web calls are user-initiated `cloud-client` calls through
// `requestCanopyCloudJson`, authenticated with this computer's own `csk_`
// key; the intent is never logged.
// ---------------------------------------------------------------------------

import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { isDeviceRelayInstallId } from '@canopy/protocol/device-relay';
import type {
  SlackConnectThisComputerFailure,
  SlackConnectThisComputerResult,
} from '@canopy/desktop-shared/types';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import type { StrictAuthenticatedCloudPageResult } from '../canopy-cloud/authenticated-cloud-page';

import {
  SLACK_DESKTOP_CONNECT_PATH,
  SLACK_DESKTOP_CONNECT_PREPARE_PATH,
} from '@canopy/protocol/slack-link';
import { slackConnectHandoffPath } from '@canopy/protocol/settings/account-slack-link';

export { SLACK_DESKTOP_CONNECT_PATH, SLACK_DESKTOP_CONNECT_PREPARE_PATH };

/** The whole run, the life of the pairing expectation. */
export const SLACK_CONNECT_DEADLINE_MS = 2 * 60_000;
/** Longest wait for the relay to list this computer as accepting control. */
export const SLACK_CONNECT_ACCEPTING_WAIT_MS = 15_000;
const PREPARE_TIMEOUT_MS = 20_000;
/** Above the route's own 60-second pairing bound. */
const DESKTOP_CONNECT_TIMEOUT_MS = 75_000;

const INTENT_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The Slack mentions flag (CAN-7604), which also gates Connect Slack. */
export const SLACK_MENTIONS_FLAG_KEY =
  CLIENT_FEATURE_FLAGS.canopyDesktopSlackOrchestratorRequests.key;

const WEB_REFUSALS: readonly SlackConnectThisComputerFailure[] = [
  'not_enabled',
  'entitlement_denied',
  'personal_account_required',
  'feature_disabled',
  'hosted_pairing_busy',
  'hosted_capacity',
  'entitlement_unavailable',
  'device_relay_not_configured',
  'forbidden',
  'denied',
  'offline',
  'host_unsupported',
  'timeout',
  'failed',
  'link_failed',
  'too_many_attempts',
];

function isWebRefusal(
  value: unknown,
): value is SlackConnectThisComputerFailure {
  return WEB_REFUSALS.some((refusal) => refusal === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PostJsonOptions {
  credentialContext: CanopyCloudCredentialContext;
  timeoutMs: number;
  signal: AbortSignal;
}

/** What Connect Slack needs from main; injected so tests drive it directly. */
export interface SlackConnectDeps {
  /** The Slack mentions flag as this computer reads it. */
  slackMentionsEnabled(): boolean;
  /** The signed-in, non-guest account's credential, or null. */
  signedInCredentials(): Promise<CanopyCloudCredentialContext | null>;
  /** This computer's relay device ID (creates the key on first use). */
  relayDeviceId(): Promise<string>;
  /** This install's ID, as the relay token request sends it. */
  installId(): Promise<string>;
  /**
   * Mints a relay token for this device, which records the install's relay
   * device on the web. Used once when `prepare` can't yet prove ownership.
   */
  rememberRelayInstall(deviceId: string): Promise<void>;
  /** POSTs JSON to the web with the captured credential. */
  postJson(
    path: string,
    body: unknown,
    options: PostJsonOptions,
  ): Promise<unknown>;
  armExpectedPairing(controllerDeviceId: string): { clear(): void } | null;
  hasHostedController(): boolean;
  /** Saves Listen for Slack mentions on. */
  enableSlackMentions(): Promise<void>;
  setAllowIncoming(allow: true): Promise<unknown>;
  waitUntilAcceptingRemoteControl(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<boolean>;
  openStrictCloudPage(
    path: string,
    credentialContext: CanopyCloudCredentialContext,
  ): Promise<StrictAuthenticatedCloudPageResult>;
  now?: () => number;
  /** Shortens the overall deadline; tests only. */
  deadlineMs?: number;
  log?: (message: string, context?: unknown) => void;
}

type Step<T> =
  | { ok: true; value: T }
  | { ok: false; reason: SlackConnectThisComputerFailure };

function refused(reason: SlackConnectThisComputerFailure): {
  ok: false;
  reason: SlackConnectThisComputerFailure;
} {
  return { ok: false, reason };
}

class DeadlineError extends Error {
  constructor() {
    super('Connect Slack deadline passed.');
    this.name = 'DeadlineError';
  }
}

/**
 * The web's refusal (`SlackDesktopConnectRefusal` in
 * `@canopy/protocol/slack-link`): the routes answer `{ error, code }`, and
 * the cloud client keeps `code` as `serverCode`.
 */
function webRefusalCode(error: unknown): string | undefined {
  if (!(error instanceof CanopyCloudClientError)) return undefined;
  return error.serverCode ?? error.serverReason;
}

/** The web's answer when this install's relay device isn't on record. */
const DEVICE_NOT_FOUND = 'device_not_found';

/** The web's typed refusal from an error response, or `failed`. */
function refusalFromError(error: unknown): SlackConnectThisComputerFailure {
  if (error instanceof DeadlineError) return 'timeout';
  if (!(error instanceof CanopyCloudClientError)) return 'failed';
  if (error.code === 'network-error') return 'failed';
  const code = webRefusalCode(error);
  if (isWebRefusal(code)) return code;
  // This computer's relay device is not this account's, as far as the web
  // knows; `unauthorized` is a missing or revoked key.
  if (code === DEVICE_NOT_FOUND) return 'forbidden';
  if (error.status === 401 || error.status === 403) return 'forbidden';
  return 'failed';
}

/** The web's typed refusal from a 2xx body that carries one. */
function refusalFromBody(
  body: Record<string, unknown>,
): SlackConnectThisComputerFailure {
  const code = body.code ?? body.error ?? body.reason;
  return isWebRefusal(code) ? code : 'failed';
}

let inFlight: Promise<SlackConnectThisComputerResult> | null = null;

/**
 * Runs Connect Slack once; a call while a run is in progress joins it.
 * Never rejects.
 */
export function connectSlackThisComputer(
  deps: SlackConnectDeps,
): Promise<SlackConnectThisComputerResult> {
  if (inFlight) return inFlight;
  const run = runWithDeadline(deps).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

async function runWithDeadline(
  deps: SlackConnectDeps,
): Promise<SlackConnectThisComputerResult> {
  const controller = new AbortController();
  const expectation: { current: { clear(): void } | null } = {
    current: null,
  };
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<SlackConnectThisComputerResult>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      resolve(refused('timeout'));
    }, deps.deadlineMs ?? SLACK_CONNECT_DEADLINE_MS);
    deadlineTimer.unref?.();
  });
  try {
    const result = await Promise.race([
      runSteps(deps, controller.signal, (armed) => {
        expectation.current = armed;
      }),
      deadline,
    ]);
    if (!result.ok) {
      deps.log?.('Connect Slack did not finish', { reason: result.reason });
    }
    return result;
  } catch (error) {
    const reason = refusalFromError(error);
    deps.log?.('Connect Slack did not finish', { reason });
    return refused(reason);
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    controller.abort();
    // Cleared on every exit, success included: a pairing that completed
    // already consumed it, and nothing else may use it.
    expectation.current?.clear();
  }
}

async function runSteps(
  deps: SlackConnectDeps,
  signal: AbortSignal,
  onArmed: (armed: { clear(): void }) => void,
): Promise<SlackConnectThisComputerResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadlineMs = deps.deadlineMs ?? SLACK_CONNECT_DEADLINE_MS;
  const remaining = (): number => Math.max(0, startedAt + deadlineMs - now());
  const throwIfAborted = (): void => {
    if (signal.aborted) throw new DeadlineError();
  };

  // 1. Gate and account, before any network call.
  if (!deps.slackMentionsEnabled()) return refused('not_enabled');
  const credentials = await deps.signedInCredentials();
  if (!credentials?.account?.id || credentials.apiKey.trim().length === 0) {
    return refused('signed_out');
  }
  const deviceId = await deps.relayDeviceId();
  const rawInstallId = await deps.installId().catch(() => null);
  if (!isDeviceRelayInstallId(rawInstallId)) return refused('failed');
  const installId = rawInstallId.toLowerCase();
  throwIfAborted();

  const post = (
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> =>
    deps.postJson(path, body, {
      credentialContext: credentials,
      timeoutMs: Math.max(1, Math.min(timeoutMs, remaining())),
      signal,
    });

  // 2. Prepare: ownership and admission, nothing changed here yet.
  let deviceUnknown = false;
  const prepare = async (): Promise<Step<string>> => {
    deviceUnknown = false;
    try {
      const body = await post(
        SLACK_DESKTOP_CONNECT_PREPARE_PATH,
        { deviceId, installId },
        PREPARE_TIMEOUT_MS,
      );
      if (!isRecord(body)) return refused('failed');
      const controllerDeviceId = body.controllerDeviceId;
      if (
        typeof controllerDeviceId !== 'string' ||
        !DEVICE_ID_PATTERN.test(controllerDeviceId)
      ) {
        return refused(refusalFromBody(body));
      }
      return { ok: true, value: controllerDeviceId };
    } catch (error) {
      throwIfAborted();
      deviceUnknown = webRefusalCode(error) === DEVICE_NOT_FOUND;
      return refused(refusalFromError(error));
    }
  };
  let prepared = await prepare();
  if (!prepared.ok && deviceUnknown) {
    // The web learns this install's relay device when it mints a relay
    // token; a computer that never started the relay under this account
    // has no record yet. Mint one (nothing local changes) and ask again.
    const remembered = await deps
      .rememberRelayInstall(deviceId)
      .then(() => true)
      .catch(() => false);
    throwIfAborted();
    if (remembered) prepared = await prepare();
  }
  if (!prepared.ok) return prepared;

  // 3. Arm the expectation before anything can start the pairing.
  const armed = deps.armExpectedPairing(prepared.value);
  if (!armed) return refused('signed_out');
  onArmed(armed);

  // 4. Gate and Allow incoming on, then pair and mint the intent.
  await deps.enableSlackMentions();
  await deps.setAllowIncoming(true);
  throwIfAborted();
  await deps.waitUntilAcceptingRemoteControl(
    Math.min(SLACK_CONNECT_ACCEPTING_WAIT_MS, remaining()),
    signal,
  );
  throwIfAborted();

  const desktopConnect = async (): Promise<Step<string>> => {
    try {
      const body = await post(
        SLACK_DESKTOP_CONNECT_PATH,
        { deviceId, installId, repair: !deps.hasHostedController() },
        DESKTOP_CONNECT_TIMEOUT_MS,
      );
      if (!isRecord(body)) return refused('failed');
      const intent = body.intent;
      if (typeof intent !== 'string' || !INTENT_PATTERN.test(intent)) {
        return refused(refusalFromBody(body));
      }
      return { ok: true, value: intent };
    } catch (error) {
      throwIfAborted();
      return refused(refusalFromError(error));
    }
  };
  let connected = await desktopConnect();
  if (!connected.ok && connected.reason === 'offline' && remaining() > 0) {
    await deps.waitUntilAcceptingRemoteControl(
      Math.min(SLACK_CONNECT_ACCEPTING_WAIT_MS, remaining()),
      signal,
    );
    throwIfAborted();
    connected = await desktopConnect();
  }
  if (!connected.ok) return connected;
  throwIfAborted();

  // 5. The browser, signed in as the captured account, never signed out.
  const opened = await deps.openStrictCloudPage(
    slackConnectHandoffPath(connected.value),
    credentials,
  );
  if (opened.ok) return { ok: true };
  switch (opened.reason) {
    case 'unavailable':
      return refused('signed_out');
    case 'identity_changed':
      return refused('identity_changed');
    case 'browser_failed':
      return refused('browser_failed');
    case 'failed':
      return refused('failed');
  }
}

/** The production `postJson`: `requestCanopyCloudJson` (POST, not retried). */
export function postCanopyCloudJson(
  path: string,
  body: unknown,
  options: PostJsonOptions,
): Promise<unknown> {
  return requestCanopyCloudJson<unknown>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    credentialContext: options.credentialContext,
    timeoutMs: Math.max(1, options.timeoutMs),
    signal: options.signal,
  });
}
