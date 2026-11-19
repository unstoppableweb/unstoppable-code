import type { CanopyAccountResponse } from '@canopy/protocol/canopy-server';
import { normalizePersonalOrganizationId } from '@canopy/protocol/workspace-context';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeMemorySearchOrganizationExternalIds } from '@canopy/desktop-shared/lib/org-memory';
import { createServer, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import { app } from 'electron';
import { BRAND } from '@canopy/brand/current';
import type {
  CanopyCloudAccountPublicState,
  CanopyServerStatus,
} from '@canopy/desktop-shared/types';
import { REQUIRED_CANOPY_SERVER_CAPABILITIES } from '@canopy/protocol/canopy-server';
import type {
  CanopyOrgBillingState,
  CanopyOrgEnforcedSettings,
  CanopyServerAccountInfo,
} from '@canopy/protocol/canopy-server';
import {
  normalizeOrgEnforcedSettingsWithStatus,
  personalGatewayAccountFields,
} from '@canopy/desktop-shared/lib/org-enforced-parsing';
import { normalizeOrgBillingStates } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import type {
  CanopyOrganizationSummary,
  CanopyTeamSummary,
} from '@canopy/protocol/pipelines';
import { getCanopyCloudBaseUrl } from './config';
import { parseAuthoritativeOrganizationSnapshot } from './organization-snapshot';
import {
  type CanopyCloudAccountEntry,
  saveCanopyCloudAccount,
  toPublicCanopyCloudAccountState,
} from '../lib/canopy-cloud-account-store';
import { writeBrandedCallbackPage } from '../lib/branded-callback-page';
import { openExternalGuarded } from '../lib/open-external';
import { focusMainWindow } from '../lib/main-window-focus';
import { isE2eBuild } from '../lib/e2e-gate';
import { isRecord } from '../lib/type-guards';
import { getInstallId } from '../lib/install-identity';
import { getObservabilityService } from '../observability';
import { getSharedContainerReconciliationService } from '../shared-containers/reconciliation-service';
import { organizationSnapshotTransition } from '../shared-containers/organization-snapshot-transition';
import type {
  CloudOAuthDiagnosticOutcome,
  CloudOAuthDiagnosticStage,
  CloudOAuthFailureClass,
  CloudOAuthProviderError,
} from '../observability/types';

const CALLBACK_PATH = '/desktop-connect';
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const CALLBACK_DRAIN_TIMEOUT_MS = 250;

/**
 * Requests to this loopback server still carry an authorization code in their
 * URL even when they are rejected, so the not-found response gets the same
 * no-cache / no-referrer / no-sniff treatment as the rendered pages.
 */
const NOT_FOUND_HEADERS: Record<string, string> = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

interface DesktopOAuthTokenResponse {
  token: string;
  userApiKey: { id: string };
  account: CanopyServerAccountInfo;
  capabilities: readonly string[];
  memorySearchOrganizationExternalId?: string;
  /** Normalized eligible memory orgs (CAN-3457); empty when none. */
  memorySearchOrganizationExternalIds: string[];
  personalOrganizationId?: string;
  personalModelGateway?: CanopyAccountResponse['personalModelGateway'];
  personalModelGatewayEnforcementUnavailable?: boolean;
  organizations: CanopyOrganizationSummary[];
  teams: CanopyTeamSummary[];
  enforcedSettings: CanopyOrgEnforcedSettings[];
  telemetryEnforcementUnavailable?: boolean;
  modelGatewayEnforcementUnavailable: boolean;
  /** Per-org billing state (CAN-2311). Empty ⇒ nothing lapsed. */
  orgBillingStates: CanopyOrgBillingState[];
  /**
   * Present only when the sign-in consumed a guest-link ticket (CAN-934):
   * `true` when the guest's data was re-owned onto the real user, `false` when
   * the merge failed (sign-in still succeeds — fail open). Absent for ordinary
   * sign-ins with no guest to merge.
   */
  guestDataMerged?: boolean;
}

interface PendingLogin {
  cancel: (reason: string) => void;
}

interface CanopyCloudOAuthLoginResult {
  status: CanopyServerStatus;
  account: CanopyCloudAccountPublicState;
  guestDataMerged?: boolean;
}

function recordOAuthDiagnostic(input: {
  kind:
    | 'cloud_oauth_login_stage'
    | 'cloud_oauth_login_failed'
    | 'cloud_oauth_callback_rejected';
  stage: CloudOAuthDiagnosticStage;
  outcome?: CloudOAuthDiagnosticOutcome;
  reason?: string;
  failureClass?: CloudOAuthFailureClass;
  httpStatus?: number | null;
  providerError?: CloudOAuthProviderError;
  startedAtMs: number;
  correlationId: string;
  loopbackPort?: number;
  clientDeviceId: string;
}): void {
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: input.kind,
      cloudOAuthStage: input.stage,
      cloudOAuthOutcome: input.outcome,
      reason: input.reason,
      cloudOAuthFailureClass: input.failureClass,
      cloudOAuthHttpStatus: input.httpStatus,
      cloudOAuthProviderError: input.providerError,
      cloudOAuthDurationMs: Math.max(0, Date.now() - input.startedAtMs),
      cloudOAuthCorrelationId: input.correlationId,
      cloudOAuthPlatform: process.platform,
      cloudOAuthAppVersion: app?.getVersion?.() ?? null,
      cloudOAuthLoopbackPort: input.loopbackPort,
      cloudOAuthClientDeviceId: input.clientDeviceId,
    });
  } catch {
    // OAuth diagnostics are best-effort and must never alter sign-in behavior.
  }
}

/**
 * Thrown inside the commit mutex when the login was cancelled or superseded
 * while it was queued behind another commit. Distinguishes "the user backed
 * out" from "the write failed", which need different callback copy.
 */
class LoginAbandonedError extends Error {
  constructor() {
    super('OAuth login was abandoned before its commit.');
    this.name = 'LoginAbandonedError';
  }
}

class CloudOAuthExchangeError extends Error {
  constructor(
    message: string,
    public readonly failureClass: CloudOAuthFailureClass,
    public readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = 'CloudOAuthExchangeError';
  }
}

let pendingLogin: PendingLogin | null = null;

function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function writeSuccessPage(
  response: ServerResponse,
  accountName: string | null | undefined,
): void {
  const name = accountName?.trim() ?? '';
  const readyLine = `${BRAND.displayName} Desktop is ready to go.`;
  writeBrandedCallbackPage(response, 200, {
    tone: 'success',
    title: 'Desktop connected',
    // Segments rather than a matched substring: a short account name such as
    // `in` or `as` would otherwise emphasize the wrong word in this sentence.
    message: name
      ? [
          { text: `You're signed in as ` },
          { text: name, emphasis: true },
          { text: `. ${readyLine}` },
        ]
      : `You're signed in. ${readyLine}`,
    hint: `You can close this tab and return to ${BRAND.displayName} Desktop.`,
    scrubQuery: true,
  });
}

/**
 * Shown when a callback arrives for a login that has already settled. The
 * outcome is deliberately not restated here: this request did not determine it,
 * and claiming either success or cancellation could contradict what the desktop
 * app is showing.
 */
function writeAlreadyFinishedPage(response: ServerResponse): void {
  writeBrandedCallbackPage(response, 200, {
    tone: 'neutral',
    title: 'Sign-in finished',
    message: `This sign-in link has already been used. Check ${BRAND.displayName} Desktop for the result.`,
    hint: `You can close this tab.`,
    scrubQuery: true,
  });
}

/**
 * Shown to a duplicate callback that lost the race to claim this login — a
 * browser prefetch or a reload landing while the first request is still
 * running. The sign-in is very likely succeeding on the other request, so a
 * bare 404 would misrepresent it.
 */
function writeSignInInProgressPage(response: ServerResponse): void {
  writeBrandedCallbackPage(response, 200, {
    tone: 'neutral',
    title: 'Finishing sign-in',
    message: `${BRAND.displayName} Desktop is completing this sign-in.`,
    hint: `You can close this tab.`,
    scrubQuery: true,
  });
}

/**
 * Errors stay on `200`: the browser is rendering a page for a human, not
 * consuming an API response.
 */
function writeErrorPage(response: ServerResponse, detail: string): void {
  writeBrandedCallbackPage(response, 200, {
    tone: 'error',
    title: `Couldn't connect`,
    message: `Head back to ${BRAND.displayName} Desktop and try again.`,
    detail,
    scrubQuery: true,
  });
}

/**
 * Persists the freshly minted credential, then applies any org-enforced
 * settings on a best-effort basis.
 *
 * The write runs while the browser request is still open, before the success
 * page is written and before the desktop window is raised: if secure storage
 * fails, the sign-in has not actually completed, and showing "Desktop
 * connected" plus stealing focus would contradict the IPC rejection the
 * renderer is about to surface.
 *
 * The account write is the whole commit, and the only step that can fail the
 * login. Applying org-enforced settings deliberately happens *after* this
 * returns (see `applyEnforcedSettingsInBackground`): it cannot fail the login,
 * and it can reach a 15s-bounded network probe, so gating the browser response
 * on it would leave the user on a blank tab for a step that does not affect
 * the outcome.
 *
 * There is deliberately no deadline around the write: it is local
 * (`safeStorage.encryptString` plus `mkdir`/`writeFile`), and a `Promise.race`
 * deadline cannot cancel its loser — an orphaned write landing after a
 * rollback is strictly worse than no deadline, because it resurrects a
 * credential the user was told had failed.
 */
async function persistCompletedLogin(
  tokenResponse: DesktopOAuthTokenResponse,
): Promise<CanopyCloudOAuthLoginResult> {
  const now = new Date().toISOString();
  const nextAccount: CanopyCloudAccountEntry = {
    apiKey: tokenResponse.token,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    serverApiKeyId: tokenResponse.userApiKey.id,
    capabilities: [...tokenResponse.capabilities],
    ...(tokenResponse.memorySearchOrganizationExternalId
      ? {
          memorySearchOrganizationExternalId:
            tokenResponse.memorySearchOrganizationExternalId,
        }
      : {}),
    memorySearchOrganizationExternalIds: [
      ...tokenResponse.memorySearchOrganizationExternalIds,
    ],
    account: tokenResponse.account,
    ...(tokenResponse.personalOrganizationId
      ? { personalOrganizationId: tokenResponse.personalOrganizationId }
      : {}),
    organizations: tokenResponse.organizations,
    teams: tokenResponse.teams,
    ...personalGatewayAccountFields(tokenResponse),
    ...(tokenResponse.personalModelGatewayEnforcementUnavailable
      ? { personalModelGatewayEnforcementUnavailable: true }
      : {}),
    enforcedSettings: tokenResponse.enforcedSettings,
    telemetryEnforcementUnavailable:
      tokenResponse.telemetryEnforcementUnavailable === true,
    modelGatewayEnforcementUnavailable:
      tokenResponse.modelGatewayEnforcementUnavailable,
    orgBillingStates: tokenResponse.orgBillingStates,
    createdAt: now,
    updatedAt: now,
  };
  const saved = await saveCanopyCloudAccount(
    nextAccount,
    (persist) =>
      getSharedContainerReconciliationService().withReplicaPurgeFence(persist),
    organizationSnapshotTransition(
      tokenResponse.organizations.map((organization) => organization.id),
      tokenResponse.personalOrganizationId,
    ),
  );

  const publicAccount = toPublicCanopyCloudAccountState(saved);

  return {
    status: {
      authenticated: true,
      account: tokenResponse.account,
      capabilities: [...tokenResponse.capabilities],
      missingCapabilities: REQUIRED_CANOPY_SERVER_CAPABILITIES.filter(
        (capability) => !tokenResponse.capabilities.includes(capability),
      ),
      organizations: tokenResponse.organizations,
      teams: tokenResponse.teams,
      ...personalGatewayAccountFields(tokenResponse),
      ...(tokenResponse.personalModelGatewayEnforcementUnavailable
        ? { personalModelGatewayEnforcementUnavailable: true }
        : {}),
      enforcedSettings: tokenResponse.enforcedSettings,
      ...(tokenResponse.modelGatewayEnforcementUnavailable
        ? { modelGatewayEnforcementUnavailable: true }
        : {}),
      orgBillingStates: tokenResponse.orgBillingStates,
      error: null,
    },
    account: publicAccount,
    ...(typeof tokenResponse.guestDataMerged === 'boolean'
      ? { guestDataMerged: tokenResponse.guestDataMerged }
      : {}),
  };
}

/**
 * Applies org-enforced settings without blocking the browser response.
 *
 * `applyEnforcedSettings` already isolates every individual applier failure and
 * resolves, so the only way it rejects is the dynamic import failing — and by
 * this point the credential is on disk, so failing the login would contradict
 * it and rolling back would sign the user out of the session this login just
 * overwrote. It can also reach a 15s-bounded entitlements probe on a fresh
 * sign-in, which has no business holding the browser response open.
 *
 * This returns its promise rather than being fire-and-forget, and
 * `runCanopyCloudOAuthLogin` awaits it before resolving the IPC. The token
 * response supplies the authoritative policy snapshot; callers can proceed
 * immediately without another account probe once this apply finishes. These
 * policies gate prohibited telemetry scopes and blocked models, so login
 * completion must not race their application.
 *
 * It never rejects, so awaiting it cannot fail a committed login.
 */
function applyEnforcedSettingsDetached(
  account: CanopyCloudAccountPublicState,
): Promise<void> {
  const next = enforcedSettingsMutex.then(async (): Promise<void> => {
    try {
      const { applyEnforcedSettings } =
        await import('../services/org-enforced-settings');
      await applyEnforcedSettings(account);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        '[canopy-cloud-oauth] enforced settings could not be applied after sign-in:',
        error,
      );
    }
  });
  enforcedSettingsMutex = next;
  return next;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    // Let the confirmation/error response drain, but do not let an unfinished
    // browser request keep a cancelled or completed login IPC pending. Stopping
    // admission before the bounded drain also prevents new connections racing
    // the forced cleanup. The credential commit has already settled here.
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, CALLBACK_DRAIN_TIMEOUT_MS);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function readErrorResponse(response: Response): Promise<string> {
  return response
    .json()
    .then((payload: unknown) => {
      if (
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        typeof payload.error === 'string'
      ) {
        return payload.error;
      }
      return `${response.status} ${response.statusText}`.trim();
    })
    .catch(() => `${response.status} ${response.statusText}`.trim());
}

function invalidTokenResponse(): never {
  throw new Error('OAuth token response was invalid.');
}

function readStringField(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  return typeof value === 'string' ? value : invalidTokenResponse();
}

function parseAccountInfo(value: unknown): CanopyServerAccountInfo {
  if (!isRecord(value)) {
    invalidTokenResponse();
  }
  const role = value.role;
  if (role !== 'VIEWER' && role !== 'DEVELOPER' && role !== 'ADMIN') {
    invalidTokenResponse();
  }
  return {
    id: readStringField(value, 'id'),
    name: readStringField(value, 'name'),
    email: readStringField(value, 'email'),
    role,
    ...(typeof value.image === 'string' && value.image.trim().length > 0
      ? { image: value.image }
      : {}),
  };
}

function parseOrganization(value: unknown): CanopyOrganizationSummary {
  if (!isRecord(value)) {
    invalidTokenResponse();
  }
  return {
    id: readStringField(value, 'id'),
    name: readStringField(value, 'name'),
    createdAt: readStringField(value, 'createdAt'),
    updatedAt: readStringField(value, 'updatedAt'),
  };
}

function parseTeam(value: unknown): CanopyTeamSummary {
  if (!isRecord(value)) {
    invalidTokenResponse();
  }
  return {
    id: readStringField(value, 'id'),
    name: readStringField(value, 'name'),
    organization: parseOrganization(value.organization),
    createdAt: readStringField(value, 'createdAt'),
    updatedAt: readStringField(value, 'updatedAt'),
  };
}

function parseStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string')
  ) {
    invalidTokenResponse();
  }
  return value;
}

function parseArray<T>(value: unknown, parser: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    invalidTokenResponse();
  }
  return value.map(parser);
}

function parseDesktopOAuthTokenResponse(
  value: unknown,
): DesktopOAuthTokenResponse {
  if (!isRecord(value) || !isRecord(value.userApiKey)) {
    invalidTokenResponse();
  }
  const organizations = parseAuthoritativeOrganizationSnapshot(
    value.organizations,
  );
  if (organizations === null) invalidTokenResponse();
  const normalizedEnforcement = normalizeOrgEnforcedSettingsWithStatus(
    value.enforcedSettings,
  );
  const personalOrganizationId = normalizePersonalOrganizationId(
    value.personalOrganizationId,
  );
  return {
    ...(personalOrganizationId ? { personalOrganizationId } : {}),
    token: readStringField(value, 'token'),
    userApiKey: {
      id: readStringField(value.userApiKey, 'id'),
    },
    account: parseAccountInfo(value.account),
    capabilities: parseStringArray(value.capabilities),
    ...(typeof value.memorySearchOrganizationExternalId === 'string' &&
    value.memorySearchOrganizationExternalId.trim().length > 0
      ? {
          memorySearchOrganizationExternalId:
            value.memorySearchOrganizationExternalId.trim(),
        }
      : {}),
    memorySearchOrganizationExternalIds:
      normalizeMemorySearchOrganizationExternalIds(
        value.memorySearchOrganizationExternalIds,
        value.memorySearchOrganizationExternalId,
      ),
    organizations,
    teams: parseArray(value.teams, parseTeam),
    ...personalGatewayAccountFields(value),
    enforcedSettings: normalizedEnforcement.settings,
    ...(normalizedEnforcement.telemetryEnforcementUnavailable === true
      ? { telemetryEnforcementUnavailable: true }
      : {}),
    modelGatewayEnforcementUnavailable:
      normalizedEnforcement.modelGatewayEnforcementUnavailable,
    orgBillingStates: normalizeOrgBillingStates(value.orgBillingStates),
    ...(typeof value.guestDataMerged === 'boolean'
      ? { guestDataMerged: value.guestDataMerged }
      : {}),
  };
}

async function exchangeCode(input: {
  baseUrl: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientName: string;
  clientDeviceId: string;
  clientVersion: string | null;
  clientHostname: string | null;
  correlationId: string;
  signal: AbortSignal;
}): Promise<DesktopOAuthTokenResponse> {
  let response: Response;
  try {
    response = await fetch(
      `${input.baseUrl}/api/v1/${BRAND.web.apiNamespace}/desktop-auth/token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        signal: input.signal,
        body: JSON.stringify({
          grantType: 'authorization_code',
          code: input.code,
          codeVerifier: input.codeVerifier,
          redirectUri: input.redirectUri,
          clientName: input.clientName,
          clientDeviceId: input.clientDeviceId,
          clientVersion: input.clientVersion,
          clientHostname: input.clientHostname,
          correlationId: input.correlationId,
        }),
      },
    );
  } catch (error) {
    throw new CloudOAuthExchangeError(
      error instanceof Error ? error.message : 'Token exchange failed.',
      'network_error',
      null,
    );
  }

  if (!response.ok) {
    throw new CloudOAuthExchangeError(
      await readErrorResponse(response),
      'http_error',
      response.status,
    );
  }

  try {
    const payload: unknown = await response.json();
    return parseDesktopOAuthTokenResponse(payload);
  } catch (error) {
    throw new CloudOAuthExchangeError(
      error instanceof Error ? error.message : 'Token response was invalid.',
      'invalid_response',
      response.status,
    );
  }
}

function normalizeProviderError(error: string): CloudOAuthProviderError {
  switch (error) {
    case 'access_denied':
    case 'invalid_request':
    case 'invalid_scope':
    case 'server_error':
    case 'temporarily_unavailable':
    case 'unauthorized_client':
    case 'unsupported_response_type':
      return error;
    default:
      return 'other';
  }
}

function buildAuthorizeUrl(input: {
  baseUrl: string;
  state: string;
  codeChallenge: string;
  redirectUri: string;
  clientName: string;
  clientDeviceId: string;
  clientVersion: string | null;
  clientHostname: string | null;
  guestLinkTicket: string | null;
}): string {
  const authorizeUrl = new URL('/desktop-auth', input.baseUrl);
  authorizeUrl.searchParams.set('state', input.state);
  authorizeUrl.searchParams.set('code_challenge', input.codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('redirect_uri', input.redirectUri);
  authorizeUrl.searchParams.set('client_name', input.clientName);
  authorizeUrl.searchParams.set('client_device_id', input.clientDeviceId);
  if (input.clientVersion) {
    authorizeUrl.searchParams.set('client_version', input.clientVersion);
  }
  if (input.clientHostname) {
    authorizeUrl.searchParams.set('client_hostname', input.clientHostname);
  }
  // CAN-934: when signing in from a guest session, ride the single-use link
  // ticket through the authorize flow so the token exchange merges the guest's
  // data into the real user. The web desktop-auth panel forwards this camelCase
  // into the authorize POST body.
  if (input.guestLinkTicket) {
    authorizeUrl.searchParams.set('guest_link_ticket', input.guestLinkTicket);
  }
  return authorizeUrl.toString();
}

function isValidCallbackRequest(input: {
  requestUrl: URL;
  hostHeader: string | undefined;
  port: number;
}): boolean {
  const expectedPort = String(input.port);
  return (
    input.requestUrl.protocol === 'http:' &&
    input.requestUrl.hostname === '127.0.0.1' &&
    input.requestUrl.port === expectedPort &&
    input.requestUrl.pathname === CALLBACK_PATH &&
    input.hostHeader === `127.0.0.1:${expectedPort}`
  );
}

export async function getDesktopOAuthClientDeviceId(): Promise<string> {
  return await getInstallId();
}

/**
 * Monotonic id for each login start. Setting up a login is asynchronous
 * (`getDesktopOAuthClientDeviceId()`), so two concurrent callers could both
 * complete setup and both register — leaving the earlier one's loopback server
 * orphaned for the full `LOGIN_TIMEOUT_MS` and unreachable by
 * `cancelCanopyCloudOAuthLogin()`. Each login captures its generation and
 * refuses to register once a newer start has superseded it. The renderer
 * guards are per-component (`CanopyCloudAccountSection`, `SidebarAccountMenu`,
 * App Advisor dispatch) and do not serialize each other, so this has to hold
 * here.
 */
let startGeneration = 0;
let cancelledGeneration = 0;

/**
 * Serializes the commit phase across logins. Cancelling a login that is
 * already writing its credential is a documented no-op, so without this a
 * replacement could issue a second unsynchronized `writeFile()` against the
 * same account path, leaving a timing-dependent credential. This guards only
 * the write — not login setup — so a login parked waiting for the user in the
 * browser never blocks a replacement.
 *
 * The account store serializes each individual save and clear, but it does not
 * make callers' wider read/network/write sequences transactional or replace
 * the credential file atomically. This OAuth-specific queue remains useful
 * because it abandons cancelled or replaced logins before they reach the
 * shared store queue, preserving login-generation semantics.
 */
let commitMutex: Promise<unknown> = Promise.resolve();

/**
 * Preserves the account commit order for org-policy application without
 * holding either the commit queue or the browser success response open. Each
 * apply is enqueued while its login still owns the commit slot, so a slower
 * superseded account can never finish after the newer account and restore its
 * stale policy globally.
 */
let enforcedSettingsMutex: Promise<void> = Promise.resolve();

/**
 * How long a login may wait for a *previous* login's commit before giving up.
 *
 * Only the wait for the slot is bounded — never the write itself. A deadline
 * around the write would be unsafe for the reason round 4 removed
 * `commitWithDeadline`: `Promise.race` cannot cancel its loser, so an orphaned
 * write can land after the login was told it failed and resurrect a credential.
 * Abandoning a *queued* commit has no such hazard, because the queued work
 * never starts.
 *
 * Without this bound, a hung `safeStorage.encryptString`/`writeFile` would park
 * every subsequent sign-in for the lifetime of the process — and because each
 * parked handler holds its callback response open, their `closeServer()` calls
 * would never complete either.
 */
const COMMIT_QUEUE_TIMEOUT_MS = 30_000;

class CommitQueueTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for a previous sign-in to finish saving.');
    this.name = 'CommitQueueTimeoutError';
  }
}

/**
 * Runs `work` with the commit mutex held.
 *
 * Waiting for the slot is bounded by `COMMIT_QUEUE_TIMEOUT_MS` and aborted
 * eagerly by `abandonSignal`, so a cancelled or replaced login parked behind
 * another commit settles immediately instead of being held hostage by a write
 * it has nothing to do with. In both cases `work` never runs, so nothing is
 * written for a login that gave up. Once `work` starts, neither bound applies.
 */
function runExclusiveCommit<T>(
  work: () => Promise<T>,
  options?: { abandonSignal?: AbortSignal },
): Promise<T> {
  const abandonSignal = options?.abandonSignal;
  let abandoned = false;
  let acquired = false;
  let releaseWaiters: (() => void) | undefined;

  const run = async (): Promise<T> => {
    // We hold the slot: stop bounding, and let the waiter-side listeners go.
    acquired = true;
    releaseWaiters?.();
    if (abandoned) {
      // The caller already settled via timeout/abort. Advance the chain
      // without writing anything.
      throw new CommitQueueTimeoutError();
    }
    return work();
  };

  const next = commitMutex.then(run, run);
  commitMutex = next.then(
    () => undefined,
    () => undefined,
  );

  return new Promise<T>((resolve, reject) => {
    const giveUp = (error: Error): void => {
      if (acquired || abandoned) {
        return;
      }
      abandoned = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => giveUp(new LoginAbandonedError());
    const timer = setTimeout(
      () => giveUp(new CommitQueueTimeoutError()),
      COMMIT_QUEUE_TIMEOUT_MS,
    );
    function cleanup(): void {
      clearTimeout(timer);
      abandonSignal?.removeEventListener('abort', onAbort);
    }
    releaseWaiters = cleanup;

    if (abandonSignal?.aborted) {
      giveUp(new LoginAbandonedError());
      return;
    }
    abandonSignal?.addEventListener('abort', onAbort);

    next.then(
      (value) => {
        cleanup();
        if (!abandoned) {
          resolve(value);
        }
      },
      (error: unknown) => {
        cleanup();
        if (!abandoned) {
          reject(
            error instanceof Error
              ? error
              : new Error('Failed to save the signed-in account.'),
          );
        }
      },
    );
  });
}

export function cancelCanopyCloudOAuthLogin(): void {
  // Also cancels a login still in setup, which is not yet registered and so
  // would otherwise go on to open a browser after the user cancelled.
  cancelledGeneration = startGeneration;
  pendingLogin?.cancel('cancelled');
}

export function startCanopyCloudOAuthLogin(options?: {
  /**
   * Single-use guest-link ticket (CAN-934). When set, the authorize URL carries
   * `guest_link_ticket` so the token exchange merges the guest's data into the
   * real user. Callers holding a guest credential mint this via
   * `requestGuestLinkTicket()` before starting the OAuth flow.
   */
  guestLinkTicket?: string | null;
}): Promise<{
  status: CanopyServerStatus;
  account: CanopyCloudAccountPublicState;
  guestDataMerged?: boolean;
}> {
  const generation = ++startGeneration;
  // Cancel whatever is registered right now. A login still in setup is handled
  // by the generation check instead, since it has nothing to cancel yet.
  pendingLogin?.cancel('replaced');
  return runCanopyCloudOAuthLogin(generation, options);
}

async function runCanopyCloudOAuthLogin(
  generation: number,
  options?: {
    /**
     * Single-use guest-link ticket (CAN-934). When set, the authorize URL carries
     * `guest_link_ticket` so the token exchange merges the guest's data into the
     * real user. Callers holding a guest credential mint this via
     * `requestGuestLinkTicket()` before starting the OAuth flow.
     */
    guestLinkTicket?: string | null;
  },
): Promise<{
  status: CanopyServerStatus;
  account: CanopyCloudAccountPublicState;
  guestDataMerged?: boolean;
}> {
  const guestLinkTicket = options?.guestLinkTicket ?? null;
  const baseUrl = getCanopyCloudBaseUrl();
  const state = randomBytes(32).toString('base64url');
  const correlationId = createHash('sha256')
    .update(state)
    .digest('hex')
    .slice(0, 16);
  const startedAtMs = Date.now();
  let currentStage: CloudOAuthDiagnosticStage = 'start';
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createPkceChallenge(codeVerifier);
  const clientName = `${BRAND.displayName} Desktop`;
  const clientDeviceId = await getDesktopOAuthClientDeviceId();

  // Setup is asynchronous, so a newer start (or a cancel) may have landed while
  // we were resolving the device id. Bail out before binding a port and opening
  // a browser: registering now would orphan whichever login lost, leaving its
  // loopback server open and unreachable by `cancelCanopyCloudOAuthLogin()`.
  if (generation !== startGeneration) {
    recordOAuthDiagnostic({
      kind: 'cloud_oauth_login_failed',
      stage: currentStage,
      outcome: 'replaced',
      startedAtMs,
      correlationId,
      clientDeviceId,
    });
    throw new Error('OAuth login replaced.');
  }
  if (generation <= cancelledGeneration) {
    recordOAuthDiagnostic({
      kind: 'cloud_oauth_login_failed',
      stage: currentStage,
      outcome: 'cancelled',
      startedAtMs,
      correlationId,
      clientDeviceId,
    });
    throw new Error('OAuth login cancelled.');
  }

  const clientVersion = app?.getVersion?.() ?? null;
  const clientHostname = os.hostname() || null;
  const controller = new AbortController();

  let timeoutId: NodeJS.Timeout | undefined;
  let settled = false;
  /**
   * Set once the callback handler starts writing the account to disk. That
   * write and the enforced-settings pass cannot be un-done (`AbortController`
   * only reaches the token-exchange `fetch`), so the commit is the login's
   * point of no return: a cancel, replacement, or timeout arriving afterwards
   * must not reject a login whose credential is already being persisted, or
   * the desktop would report failure for an account it just saved.
   */
  let committing = false;
  /**
   * Set synchronously by the first callback request that passes validation,
   * before any `await`, so exactly one request can drive the exchange/commit.
   */
  let handling = false;
  let server: Server | null = null;
  let currentPending: PendingLogin | null = null;
  let redirectUri = '';
  let boundLoopbackPort: number | undefined;
  let terminalDiagnosticRecorded = false;
  let callbackRejectionDiagnosticRecorded = false;
  /**
   * Set once the commit succeeds, so a late throw in the response path can
   * still resolve the login it already persisted instead of hanging.
   */
  let committedLogin: CanopyCloudOAuthLoginResult | null = null;
  /**
   * The in-flight org-enforced-settings apply, awaited before this function
   * returns so the IPC resolves strictly after it. Defaults to an already
   * resolved promise for the paths that never reach a commit. See
   * `applyEnforcedSettingsDetached`.
   */
  let enforcedSettingsApplied: Promise<void> = Promise.resolve();

  const loginPromise = new Promise<CanopyCloudOAuthLoginResult>(
    (resolve, reject) => {
      const finish = (
        error: Error | null,
        result?: CanopyCloudOAuthLoginResult,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (error) {
          reject(error);
        } else if (result) {
          resolve(result);
        } else {
          reject(new Error('OAuth login failed.'));
        }
      };

      const recordTerminalDiagnostic = (
        outcome: CloudOAuthDiagnosticOutcome,
        loopbackPortOverride?: number,
        details?: {
          failureClass?: CloudOAuthFailureClass;
          httpStatus?: number | null;
          providerError?: CloudOAuthProviderError;
        },
      ): void => {
        if (terminalDiagnosticRecorded) {
          return;
        }
        terminalDiagnosticRecorded = true;
        recordOAuthDiagnostic({
          kind: 'cloud_oauth_login_failed',
          stage: currentStage,
          outcome,
          failureClass: details?.failureClass,
          httpStatus: details?.httpStatus,
          providerError: details?.providerError,
          startedAtMs,
          correlationId,
          loopbackPort: loopbackPortOverride ?? boundLoopbackPort,
          clientDeviceId,
        });
      };

      /**
       * Abandon the login from outside the callback handler (cancel, replace,
       * timeout). Ignored once the commit phase has begun.
       */
      const abandon = (
        error: Error,
        outcome: CloudOAuthDiagnosticOutcome,
      ): void => {
        if (committing || settled) {
          return;
        }
        recordTerminalDiagnostic(outcome);
        finish(error);
      };

      server = createServer((request, response) => {
        void (async (): Promise<void> => {
          try {
            const address = server?.address();
            if (!address || typeof address === 'string') {
              throw new Error('OAuth callback server is unavailable.');
            }
            const requestUrl = new URL(
              request.url ?? '/',
              `http://127.0.0.1:${String(address.port)}`,
            );
            if (
              !isValidCallbackRequest({
                requestUrl,
                hostHeader: request.headers.host,
                port: address.port,
              })
            ) {
              if (!callbackRejectionDiagnosticRecorded) {
                callbackRejectionDiagnosticRecorded = true;
                recordOAuthDiagnostic({
                  kind: 'cloud_oauth_callback_rejected',
                  stage: 'callback_rejected',
                  reason: 'invalid_request_identity',
                  startedAtMs,
                  correlationId,
                  loopbackPort: address.port,
                  clientDeviceId,
                });
              }
              response.writeHead(404, NOT_FOUND_HEADERS);
              response.end('Not found');
              return;
            }

            // `finish()` is idempotent, but this handler body is not: it
            // exchanges the code and writes the account. A browser prefetch, a
            // reload, or a keep-alive socket delivering a second callback would
            // otherwise re-run the whole sequence and save the account twice.
            //
            // The claim below is set synchronously, before the first `await`,
            // so exactly one handler can ever get past this point. Guarding on
            // `committing` alone was not enough: it is only set *after* the
            // token exchange, leaving the whole exchange window unclaimed.
            if (settled) {
              writeAlreadyFinishedPage(response);
              return;
            }
            if (handling) {
              writeSignInInProgressPage(response);
              return;
            }
            handling = true;
            currentStage = 'callback_received';

            recordOAuthDiagnostic({
              kind: 'cloud_oauth_login_stage',
              stage: currentStage,
              startedAtMs,
              correlationId,
              loopbackPort: address.port,
              clientDeviceId,
            });

            const error = requestUrl.searchParams.get('error');
            const code = requestUrl.searchParams.get('code');
            const returnedState = requestUrl.searchParams.get('state');
            if (returnedState !== state) {
              recordTerminalDiagnostic('state_mismatch', address.port);
              writeErrorPage(
                response,
                `This sign-in link doesn't match the request from your desktop app.`,
              );
              finish(new Error('OAuth callback state did not match.'));
              return;
            }
            if (error) {
              recordTerminalDiagnostic('provider_error', address.port, {
                providerError: normalizeProviderError(error),
              });
              writeErrorPage(response, error);
              finish(new Error(error));
              return;
            }
            if (!code) {
              recordTerminalDiagnostic('missing_code', address.port);
              writeErrorPage(response, 'The sign-in response was incomplete.');
              finish(new Error('OAuth callback is missing code.'));
              return;
            }

            let tokenResponse: DesktopOAuthTokenResponse;
            currentStage = 'exchange';
            try {
              tokenResponse = await exchangeCode({
                baseUrl,
                code,
                codeVerifier,
                redirectUri,
                clientName,
                clientDeviceId,
                clientVersion,
                clientHostname,
                correlationId,
                signal: controller.signal,
              });
            } catch (exchangeError) {
              if (!settled) {
                recordTerminalDiagnostic('exchange_failed', address.port, {
                  failureClass:
                    exchangeError instanceof CloudOAuthExchangeError
                      ? exchangeError.failureClass
                      : 'invalid_response',
                  httpStatus:
                    exchangeError instanceof CloudOAuthExchangeError
                      ? exchangeError.httpStatus
                      : null,
                });
              }
              throw exchangeError;
            }
            // The exchange can take a while, so the user may have cancelled (or
            // a replacement login may have started) in the meantime. Bail out
            // before the commit rather than saving a credential and applying
            // org-enforced settings for a sign-in that was abandoned.
            if (settled) {
              writeErrorPage(response, 'This sign-in was already cancelled.');
              return;
            }

            // Persist before claiming success: the browser must not show
            // "Desktop connected" (and the window must not jump forward) for a
            // login that fails to save locally. From here the login is past its
            // point of no return, so `abandon()` stops rejecting it.
            let completedLogin: CanopyCloudOAuthLoginResult;
            currentStage = 'persist';
            try {
              completedLogin = await runExclusiveCommit(
                async () => {
                  // The point of no return is here, not before the mutex. While
                  // this login was queued behind another commit it had written
                  // nothing, so a cancel or replacement arriving in that window
                  // must still be honored rather than persisting a credential
                  // the user backed out of.
                  if (settled || generation <= cancelledGeneration) {
                    throw new LoginAbandonedError();
                  }
                  committing = true;
                  const persisted = await persistCompletedLogin(tokenResponse);
                  // Enqueue while this login still owns the commit slot. The
                  // work itself remains detached, so the next credential write
                  // and this request's browser success page are not gated on a
                  // potentially network-backed policy apply.
                  enforcedSettingsApplied = applyEnforcedSettingsDetached(
                    persisted.account,
                  );
                  return persisted;
                },
                // Lets a cancel/replace arriving while this login is still
                // queued settle it immediately, rather than waiting out a
                // previous login's write before it can answer the browser.
                { abandonSignal: controller.signal },
              );
            } catch (persistError) {
              committing = false;
              if (persistError instanceof LoginAbandonedError) {
                // `finish()` already ran via the cancel/replace path.
                writeErrorPage(response, 'This sign-in was already cancelled.');
                return;
              }
              if (persistError instanceof CommitQueueTimeoutError) {
                recordTerminalDiagnostic('commit_queue_timeout', address.port);
                writeErrorPage(
                  response,
                  `${BRAND.displayName} Desktop is still finishing a previous sign-in. Please try again.`,
                );
                finish(persistError);
                return;
              }
              recordTerminalDiagnostic('persist_failed', address.port);
              writeErrorPage(
                response,
                `${BRAND.displayName} Desktop couldn't save your account.`,
              );
              finish(
                persistError instanceof Error
                  ? persistError
                  : new Error('Failed to save the signed-in account.'),
              );
              return;
            }

            // Everything below runs after the point of no return, so nothing
            // here may reject the login: the credential is already on disk.
            //
            // Started here but awaited in `runCanopyCloudOAuthLogin`: the
            // browser response is not gated on it, while the IPC still resolves
            // strictly after it. See `applyEnforcedSettingsDetached`.
            committedLogin = completedLogin;
            try {
              writeSuccessPage(response, tokenResponse.account.name);
              focusMainWindow({ steal: !isE2eBuild() });
            } catch {
              // Rendering the page and raising the window are both best-effort
              // and must not fail a login that has already committed. Still
              // close the request out: `writeSuccessPage` is the likelier
              // thrower of the two, and an open socket both spins the browser
              // tab and stalls `closeServer()` in the outer `finally`.
              if (!response.writableEnded) {
                response.end();
              }
            }
            currentStage = 'success';
            recordOAuthDiagnostic({
              kind: 'cloud_oauth_login_stage',
              stage: currentStage,
              startedAtMs,
              correlationId,
              loopbackPort: address.port,
              clientDeviceId,
            });
            finish(null, completedLogin);
          } catch (error) {
            if (committing) {
              // A committed login must not be rejected by a late failure in
              // the response path; `finish()` below would otherwise reject a
              // sign-in whose credential is already saved. Still close the
              // request out, or the browser tab spins forever.
              if (!response.writableEnded) {
                response.end();
              }
              // Resolve with the account that was already committed. Because
              // `abandon()` is suppressed while `committing`, returning without
              // settling would leave `loginPromise` pending forever and hang
              // the IPC — a permanent hang in place of a degraded success.
              if (committedLogin) {
                finish(null, committedLogin);
              } else {
                finish(
                  error instanceof Error
                    ? error
                    : new Error('OAuth login failed after its commit.'),
                );
              }
              return;
            }
            recordTerminalDiagnostic('callback_failed');
            writeErrorPage(
              response,
              `We couldn't finish the handshake with ${BRAND.displayName}.`,
            );
            finish(
              error instanceof Error
                ? error
                : new Error('OAuth token exchange failed.'),
            );
          }
        })();
      });

      server.on('error', (error) => abandon(error, 'listener_failed'));
      server.listen(0, '127.0.0.1', (): void => {
        const address = server?.address();
        if (!address || typeof address === 'string') {
          abandon(
            new Error('OAuth callback server did not bind to a port.'),
            'listener_failed',
          );
          return;
        }

        if (settled || generation <= cancelledGeneration) {
          // Defense in depth: this callback fires in the same turn as
          // `listen()`, but opening a browser for an abandoned login is the
          // exact orphan the generation counter exists to prevent.
          return;
        }

        boundLoopbackPort = address.port;
        redirectUri = `http://127.0.0.1:${String(address.port)}${CALLBACK_PATH}`;
        currentStage = 'start';
        recordOAuthDiagnostic({
          kind: 'cloud_oauth_login_stage',
          stage: currentStage,
          startedAtMs,
          correlationId,
          loopbackPort: address.port,
          clientDeviceId,
        });
        const authorizeUrl = buildAuthorizeUrl({
          baseUrl,
          state,
          codeChallenge,
          redirectUri,
          clientName,
          clientDeviceId,
          clientVersion,
          clientHostname,
          guestLinkTicket,
        });

        void openExternalGuarded(authorizeUrl).then(
          () => {
            try {
              if (settled || currentStage !== 'start') {
                return;
              }
              currentStage = 'browser_opened';
              recordOAuthDiagnostic({
                kind: 'cloud_oauth_login_stage',
                stage: currentStage,
                startedAtMs,
                correlationId,
                loopbackPort: address.port,
                clientDeviceId,
              });
            } catch {
              // Browser-open diagnostics cannot alter a successful open.
            }
          },
          (error: unknown) => {
            abandon(
              error instanceof Error
                ? error
                : new Error('Failed to open browser for OAuth login.'),
              'browser_open_failed',
            );
          },
        );
      });

      timeoutId = setTimeout(() => {
        abandon(new Error('OAuth login timed out.'), 'timeout');
      }, LOGIN_TIMEOUT_MS);

      currentPending = {
        cancel: (reason: string): void => {
          if (committing) {
            // Past the point of no return — the credential is already being
            // written, so let the login finish rather than reporting a failure
            // for an account that will exist on disk.
            return;
          }
          controller.abort();
          abandon(
            new Error(`OAuth login ${reason}.`),
            reason === 'replaced' ? 'replaced' : 'cancelled',
          );
        },
      };
      pendingLogin = currentPending;
    },
  );

  try {
    // Account persistence already happened inside the callback handler, before
    // the success page was written.
    const result = await loginPromise;
    // The browser response is not gated on policy application, but the desktop
    // must have applied the token's snapshot before returning login success.
    await enforcedSettingsApplied;
    return result;
  } finally {
    if (pendingLogin === currentPending) {
      pendingLogin = null;
    }
    if (server) {
      await closeServer(server);
    }
  }
}
