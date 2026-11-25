import { getSecureStorageFailure } from '../lib/secure-storage-policy';
// The account proxy connection: reads the server's accounts and routing
// through the management API and applies the account actions the settings
// offer. See docs/planning/2026-10-12-account-proxy/README.md.
//
// A rejected management key is never retried on its own. The proxy blocks an
// address after five wrong keys, so once the server answers 401 or blocks us,
// refreshes return the stored error until the user connects with a new key.

import { createHash, randomUUID } from 'node:crypto';
import {
  accountProxyNoUsableAccountsMessage,
  countReadyAccountProxyAccounts,
  type AccountProxyHarness,
  normalizeAccountProxyUrl,
  parseAccountProxyConfigAccounts,
  parseAccountProxyCredentials,
  parseAccountProxyPassiveUsage,
  parseAccountProxyRouting,
  sortAccountProxyAccounts,
  accountProxyAccountKey,
} from '@canopy/desktop-shared/lib/account-proxy';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  AccountProxyAccount,
  AccountProxyConnectRequest,
  AccountProxyConnectResult,
  AccountProxyConnection,
  AccountProxyError,
  AccountProxyErrorCode,
  AccountProxyLocalControlRequest,
  AccountProxyRouting,
  AccountProxyRoutingStrategy,
  AccountProxySignIn,
  AccountProxySignInProvider,
  AccountProxySignInRequest,
  AccountProxyStatus,
} from '@canopy/desktop-shared/types/account-proxy';
import {
  AccountProxyStorageUnavailableError,
  deleteAccountProxyCredentials,
  loadAccountProxyCredentials,
  markAccountProxyKeyRejected,
  saveAccountProxyCredentials,
  type AccountProxyKeyRejection,
} from '../lib/account-proxy-credential-store';
import {
  revealLocalAccountProxyKey,
  type LocalAccountProxyKey,
} from './local-launch-keys';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { logMainProcessInfo } from '../lib/main-process-logging';
import { openExternalGuarded } from '../lib/open-external';
import { sendToAllWindows } from '../lib/window-send';
import {
  isAccountProxyFlagEnabled,
  isAccountProxyFlagSettled,
} from './feature-flag';
import type {
  AccountProxyRemoteSignInTarget,
  AccountProxySignInCallback,
} from './remote-sign-in';
import {
  ACCOUNT_PROXY_SIGN_IN_STATE_PATTERN,
  ACCOUNT_PROXY_SIGN_IN_TIMEOUT_MS,
  accountProxySignInPage,
  sameAccountProxySignInState,
} from './sign-in-pages';
import {
  accountProxyClientKeyFingerprint,
  ensureAccountProxyClientKey,
  revokeAccountProxyClientKey,
} from './client-key';
import {
  AccountProxyManagementError,
  requestAccountProxyManagement,
  type AccountProxyManagementKey,
} from './management-client';
import {
  parseClaudeOAuthProfilePlanType,
  parseAccountProxyUsageResponse,
  type AccountProxyUsageInventoryEntry,
  type AccountProxyUsageReadResult,
} from './usage';
import {
  clearLocalAccountProxyLeftovers,
  getLocalAccountProxyLaunch,
  getLocalAccountProxyPort,
  getLocalAccountProxyRuntime,
  isLocalAccountProxyStarting,
  LocalAccountProxyError,
  onLocalAccountProxyChanged,
  pickLocalAccountProxyPort,
  startLocalAccountProxy,
  stopLocalAccountProxy,
} from './local-runtime';

/** Errors that mean the stored key must not be sent again. */
const KEY_REJECTED_CODES: ReadonlySet<AccountProxyErrorCode> =
  new Set<AccountProxyErrorCode>(['unauthorized', 'blocked']);

/** How long the proxy blocks an address after five wrong keys. */
const PROXY_BLOCK_MS = 30 * 60_000;

/** A server's client key, or the handle of a local launch's client key. */
export type AccountProxyClientKey = string | LocalAccountProxyKey;

/**
 * The keys requests to `connection` use. A server's are the ones stored for
 * it. The proxy on this device's belong to its running launch, are never
 * stored, and exist only while it serves the connection's port (CAN-4406).
 */
interface ConnectionKeys {
  readonly managementKey: AccountProxyManagementKey;
  /** Null for a server without client keys, which accepts every request. */
  readonly clientKey: AccountProxyClientKey | null;
  readonly keyRejection?: AccountProxyKeyRejection | null;
}

async function loadConnectionKeys(
  connection: AccountProxyConnection,
): Promise<ConnectionKeys | null> {
  if (connection.kind !== 'local') {
    return loadAccountProxyCredentials(connection.id);
  }
  const launch = getLocalAccountProxyLaunch();
  if (!launch || launch.port !== portOf(connection)) return null;
  return {
    managementKey: launch.keys.management,
    clientKey: launch.keys.client,
    keyRejection: null,
  };
}

/**
 * The client key requests to `connection` send now: null for a server that
 * takes every request, undefined when there is none, such as the proxy on
 * this device while it is stopped.
 */
export async function loadAccountProxyClientKey(
  connection: AccountProxyConnection,
): Promise<AccountProxyClientKey | null | undefined> {
  const keys = await loadConnectionKeys(connection).catch(() => null);
  return keys ? keys.clientKey : undefined;
}

/**
 * The value to send for `key`, or null once the local launch it belongs to
 * has ended. Only the senders call this; everything else holds the handle.
 */
export function revealAccountProxyClientKey(
  key: AccountProxyClientKey,
): string | null {
  return typeof key === 'string' ? key : revealLocalAccountProxyKey(key);
}

/** Names a client key in logs and broker callbacks without revealing it. */
export function accountProxyClientKeyVersion(
  key: AccountProxyClientKey,
): string {
  return typeof key === 'string'
    ? accountProxyClientKeyFingerprint(key)
    : key.fingerprint;
}

function keyRejectionOf(
  error: unknown,
): AccountProxyKeyRejection['code'] | null {
  if (!(error instanceof AccountProxyManagementError)) return null;
  return error.code === 'unauthorized' || error.code === 'blocked'
    ? error.code
    : null;
}

/**
 * A saved rejection that still applies. A wrong key stays refused until the
 * user enters another; a blocked address may try again once the block ends.
 */
function activeKeyRejection(
  rejection: AccountProxyKeyRejection | null | undefined,
): AccountProxyKeyRejection | null {
  if (!rejection) return null;
  if (
    rejection.code === 'blocked' &&
    Date.now() - rejection.at > PROXY_BLOCK_MS
  )
    return null;
  return rejection;
}

interface Snapshot {
  readonly connectionId: string;
  readonly version: string | null;
  readonly accounts: readonly AccountProxyAccount[];
  readonly usageInventory: readonly AccountProxyUsageInventoryEntry[];
  readonly routing: AccountProxyRouting | null;
  readonly error: AccountProxyError | null;
  readonly refreshedAt: number | null;
}

let snapshot: Snapshot | null = null;
let refreshing: Promise<void> | null = null;
/**
 * Bumped whenever the connection or its key changes. A refresh that started
 * under an older generation drops its result, so a reply to a replaced key
 * can never overwrite the new connection's state.
 */
let generation = 0;
let refreshAttemptAt: number | null = null;
let refreshFailures = 0;

/**
 * Cancels the requests refreshes sent under the current generation, so a
 * refresh overtaken by a rejection or a new key sends nothing more with the
 * old key, not just drops its result.
 */
let generationAbort = new AbortController();

const usageInventoryListeners = new Set<() => void>();
const usageInventoryEntryGeneration = new WeakMap<object, number>();
const usageInventoryCodexAccountId = new WeakMap<object, string>();
let usageInventoryGeneration = -1;

function notifyUsageInventoryChanged(): void {
  for (const listener of Array.from(usageInventoryListeners)) {
    try {
      listener();
    } catch {
      // A subscriber cannot prevent the proxy lifecycle from progressing.
    }
  }
}

/** Subscribe to proxy status and quota transport credential inventory changes. */
export function onAccountProxyInventoryChanged(
  listener: () => void,
): () => void {
  usageInventoryListeners.add(listener);
  return (): void => {
    usageInventoryListeners.delete(listener);
  };
}

function startNewGeneration(): void {
  generation += 1;
  refreshAttemptAt = null;
  refreshFailures = 0;
  refreshing = null;
  usageInventoryGeneration = -1;
  generationAbort.abort();
  generationAbort = new AbortController();
  notifyUsageInventoryChanged();
}

/**
 * Aborted when the proxy on this device stops serving its port, so session
 * requests to it are cancelled before whatever takes the port next gets them.
 */
let servingAbort = new AbortController();

/** The signal session routes check before each request to the proxy. */
export function accountProxyServingSignal(): AbortSignal {
  return servingAbort.signal;
}

/** Cancel refreshes and session requests sent to the proxy on this device. */
function cancelServedRequests(): void {
  startNewGeneration();
  servingAbort.abort();
  servingAbort = new AbortController();
}

/**
 * Bumped whenever the proxy on this device is stopped on purpose. A start
 * that began before then does not launch it.
 */
let localLifecycle = 0;

/**
 * Why the proxy on this device should run in this launch: it is set to start
 * with the app, or the user started it, and it has not been stopped, turned
 * off, or replaced since. Null when it should not. The flag served off stops
 * the proxy but keeps this, so it starts again once the flag is served on.
 */
let localStartWanted: 'with-app' | 'user' | null = null;
/** The start {@link publishAccountProxyStatus} made, until it ends. */
let localAutoStart: {
  readonly start: Promise<void>;
  /** The lifecycle it started in; a stop since then cancels it. */
  readonly lifecycle: number;
} | null = null;

/** Why the proxy on this device was stopped, for the main log. */
type LocalStopReason =
  | 'user-stop'
  | 'restart'
  | 'disconnect'
  | 'replaced-by-server'
  | 'turned-off'
  | 'flag-off'
  | 'not-the-connection'
  | 'turned-off-while-starting';

/**
 * Stop the proxy on this device, cancelling what was sent to it first.
 * Resolves with the lifecycle this stop began, so a restart starts again
 * only if no later stop came while it waited.
 */
async function releaseLocalProxy(reason: LocalStopReason): Promise<number> {
  localLifecycle += 1;
  const lifecycle = localLifecycle;
  logMainProcessInfo('[account-proxy] Stopping the proxy on this device', {
    reason,
  });
  cancelServedRequests();
  await stopLocalAccountProxy();
  return lifecycle;
}

/**
 * Bumped by every connect and disconnect. A connect saves nothing once a
 * later one, or a disconnect, has started.
 */
let connectAttempt = 0;
let persistence: Promise<void> = Promise.resolve();

/** Runs connect and disconnect saves one at a time, in call order. */
function withPersistenceLock<T>(task: () => Promise<T>): Promise<T> {
  const run = persistence.then(task);
  persistence = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** When the rejection in the snapshot was recorded, for a block's expiry. */
let rejectedAt = 0;

/**
 * Whether the snapshot holds a rejection that still applies. A wrong key
 * stays refused; a blocked address may try again once the block ends.
 */
function keyRejected(): boolean {
  const code = snapshot?.error?.code;
  if (code === 'unauthorized') return true;
  return code === 'blocked' && Date.now() - rejectedAt <= PROXY_BLOCK_MS;
}

function errorOf(error: unknown): AccountProxyError {
  if (error instanceof AccountProxyManagementError) {
    return { code: error.code, message: error.message };
  }
  const secureStorageFailure = getSecureStorageFailure(error);
  if (secureStorageFailure) {
    return {
      code: 'storage-unavailable',
      message: 'Secure storage unavailable',
      secureStorageFailure,
    };
  }
  if (error instanceof AccountProxyStorageUnavailableError) {
    return { code: 'storage-unavailable', message: error.message };
  }
  if (error instanceof LocalAccountProxyError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'unexpected', message: 'unexpected' };
}

interface Settings {
  readonly available: boolean;
  /** The proxy is turned on: on unless the user turned it off. */
  readonly optedIn: boolean;
  /**
   * LaunchDarkly served the flag off. A fallback while it starts, changes
   * account, or cannot be reached is not this, though the feature is not
   * available then either.
   */
  readonly flagServedOff: boolean;
  readonly connection: AccountProxyConnection | null;
  readonly keepChatOnOneAccount: boolean;
  readonly routeClaude: boolean;
  readonly routeCodex: boolean;
  readonly startWithApp: boolean;
  /** The account order for the proxy on this device; null for its default. */
  readonly localRoutingStrategy: AccountProxyRoutingStrategy | null;
}

/** The settings last read, for decisions that cannot wait on a file read. */
let lastSettings: Settings | null = null;

async function readSettings(): Promise<Settings> {
  const preferences = await readPreferencesFile();
  const optedIn = preferences.accountProxyEnabled === true;
  const flagEnabled = isAccountProxyFlagEnabled();
  const nextSettings: Settings = {
    available: flagEnabled && optedIn,
    optedIn,
    flagServedOff: !flagEnabled && isAccountProxyFlagSettled(),
    connection: preferences.accountProxyConnection ?? null,
    keepChatOnOneAccount:
      preferences.accountProxyKeepChatOnOneAccount !== false,
    routeClaude: preferences.accountProxyRouteClaude !== false,
    routeCodex: preferences.accountProxyRouteCodex !== false,
    startWithApp: preferences.accountProxyLocalStartWithApp !== false,
    localRoutingStrategy: preferences.accountProxyLocalRoutingStrategy ?? null,
  };
  const previous = lastSettings;
  const previousConnection = previous?.connection;
  const nextConnection = nextSettings.connection;
  const connectionChanged =
    previous !== null &&
    (previousConnection?.id !== nextConnection?.id ||
      previousConnection?.kind !== nextConnection?.kind ||
      previousConnection?.url !== nextConnection?.url);
  const availabilityChanged =
    previous !== null && previous.available !== nextSettings.available;
  const providerRoutingChanged =
    previous !== null &&
    (previous.routeClaude !== nextSettings.routeClaude ||
      previous.routeCodex !== nextSettings.routeCodex);
  lastSettings = nextSettings;
  if (connectionChanged || availabilityChanged) startNewGeneration();
  else if (providerRoutingChanged) notifyUsageInventoryChanged();
  return lastSettings;
}

/**
 * Whether the feature is off for certain: the user opted out, or the flag was
 * served off. The proxy on this device stops only then, never on a flag
 * fallback, which would leave it stopped until someone started it again.
 */
function isTurnedOff(settings: Settings): boolean {
  return !settings.optedIn || settings.flagServedOff;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function normalizedIdentityValue(value: string | null): string {
  // Provider subjects and account IDs are opaque and can be case-sensitive.
  return value?.trim() ?? '';
}

function sameUsageInventoryEntry(
  left: AccountProxyUsageInventoryEntry,
  right: AccountProxyUsageInventoryEntry,
): boolean {
  return (
    left.identity === right.identity &&
    left.connectionId === right.connectionId &&
    left.authIndex === right.authIndex &&
    left.provider === right.provider &&
    left.planType === right.planType &&
    JSON.stringify(left.passiveUsage) === JSON.stringify(right.passiveUsage)
  );
}

function usageInventoryFromCredentials(
  connectionId: string,
  body: unknown,
  accounts: readonly AccountProxyAccount[],
): readonly AccountProxyUsageInventoryEntry[] {
  if (!isRecord(body) || !Array.isArray(body.files)) return [];
  const files = body.files.filter(isRecord);
  const entries: AccountProxyUsageInventoryEntry[] = [];

  for (const account of accounts) {
    if (account.provider !== 'claude' && account.provider !== 'codex') continue;
    const raw = files.find(
      (entry) =>
        stringField(entry, 'auth_index')?.toLowerCase() === account.authIndex,
    );
    if (!raw) continue;

    const idToken = isRecord(raw.id_token) ? raw.id_token : null;
    const codexAccountId =
      account.provider === 'codex' && idToken
        ? stringField(idToken, 'chatgpt_account_id')
        : null;
    const explicitAccountId =
      stringField(raw, 'account_id') ??
      stringField(raw, 'accountId') ??
      (idToken
        ? (stringField(idToken, 'account_id') ??
          stringField(idToken, 'accountId'))
        : null);
    const email =
      stringField(raw, 'email') ??
      (idToken ? stringField(idToken, 'email') : null);
    const accountName = stringField(raw, 'account');
    const label = stringField(raw, 'label') ?? account.label;
    const providerSubject =
      stringField(raw, 'subject') ??
      stringField(raw, 'sub') ??
      (idToken
        ? (stringField(idToken, 'subject') ??
          stringField(idToken, 'sub') ??
          stringField(idToken, 'user_id'))
        : null);
    const planType = idToken ? stringField(idToken, 'plan_type') : null;
    const credentialId = normalizedIdentityValue(stringField(raw, 'id'));
    const name = account.fileName ?? '';
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          connectionId,
          credentialId,
          account.authIndex,
          normalizedIdentityValue(name),
          normalizedIdentityValue(account.provider),
          normalizedIdentityValue(codexAccountId),
          normalizedIdentityValue(email),
          normalizedIdentityValue(accountName),
          normalizedIdentityValue(explicitAccountId),
          normalizedIdentityValue(label),
          normalizedIdentityValue(providerSubject),
        ]),
      )
      .digest('hex');
    const passiveUsage = parseAccountProxyPassiveUsage(
      account.provider,
      raw.quota,
    );
    const entry = Object.freeze({
      connectionId,
      authIndex: account.authIndex,
      provider: account.provider,
      identity,
      ...(passiveUsage ? { passiveUsage } : {}),
      ...(planType ? { planType } : {}),
    });
    if (codexAccountId) usageInventoryCodexAccountId.set(entry, codexAccountId);
    entries.push(entry);
  }

  return Object.freeze(entries);
}

function bindUsageInventoryToGeneration(
  entries: readonly AccountProxyUsageInventoryEntry[],
  startedGeneration: number,
): void {
  for (const entry of entries) {
    usageInventoryEntryGeneration.set(entry, startedGeneration);
  }
}

function reuseUnchangedUsageEntries(
  previous: readonly AccountProxyUsageInventoryEntry[],
  next: readonly AccountProxyUsageInventoryEntry[],
): readonly AccountProxyUsageInventoryEntry[] {
  const previousByIdentity = new Map(
    previous.map((entry) => [entry.identity, entry]),
  );
  return Object.freeze(
    next.map((entry) => {
      const previousEntry = previousByIdentity.get(entry.identity);
      return previousEntry && sameUsageInventoryEntry(previousEntry, entry)
        ? previousEntry
        : entry;
    }),
  );
}

function currentUsageSnapshot(): Snapshot | null {
  const settings = lastSettings;
  const connection = settings?.connection;
  const current = snapshot;
  if (
    !settings?.available ||
    !settings.optedIn ||
    !isAccountProxyFlagEnabled() ||
    !connection ||
    !current ||
    current.connectionId !== connection.id ||
    usageInventoryGeneration !== generation ||
    keyRejected() ||
    !isLocalConnectionRunning(connection)
  ) {
    return null;
  }
  return current;
}

/** Narrow, synchronous account metadata for passive usage projection. */
export interface AccountProxyUsageProjectionAccount {
  /** Internal lookup keys; the desktop projection never serializes either. */
  readonly connectionId: string;
  readonly authIndex: string;
  readonly provider: string;
  readonly label?: string;
  readonly planLabel?: string;
  readonly status: AccountProxyAccount['status'];
  readonly availableAt: number | null;
  readonly legacyLimits: AccountProxyAccount['limits'];
}

/** Current cached proxy inventory and its last successful observation time. */
export interface AccountProxyUsageProjectionInventory {
  readonly state:
    | 'observed'
    | 'unavailable'
    | 'not_observed'
    | 'not_configured';
  readonly observedAt: string | null;
  readonly errorCode?: AccountProxyErrorCode;
  readonly accounts: readonly AccountProxyUsageProjectionAccount[];
}

/**
 * Read only the last same-generation proxy inventory. This intentionally does
 * not apply provider routing flags or account status filters: disabled and
 * cooling accounts are still useful usage records. It never reads preferences,
 * credentials, or the proxy management API.
 */
export function getAccountProxyUsageProjectionInventory(): AccountProxyUsageProjectionInventory {
  const settings = lastSettings;
  if (settings === null) {
    return { state: 'not_observed', observedAt: null, accounts: [] };
  }
  const connection = settings.connection;
  if (connection === null) {
    return { state: 'not_configured', observedAt: null, accounts: [] };
  }
  if (!settings.optedIn || settings.flagServedOff) {
    return { state: 'not_configured', observedAt: null, accounts: [] };
  }
  if (!settings.available) {
    return { state: 'unavailable', observedAt: null, accounts: [] };
  }

  const current = snapshot;
  if (current === null || current.connectionId !== connection.id) {
    return { state: 'not_observed', observedAt: null, accounts: [] };
  }

  const rejectionCode = current.error?.code;
  if (rejectionCode === 'unauthorized' || rejectionCode === 'blocked') {
    return {
      state: 'unavailable',
      observedAt: null,
      errorCode: rejectionCode,
      accounts: [],
    };
  }
  if (!isLocalConnectionRunning(connection)) {
    return {
      state: 'unavailable',
      observedAt: null,
      accounts: [],
    };
  }
  if (usageInventoryGeneration !== generation) {
    return {
      state: 'not_observed',
      observedAt: null,
      accounts: [],
    };
  }

  const refreshedAt =
    current.refreshedAt === null ? undefined : new Date(current.refreshedAt);
  const observedAt =
    refreshedAt === undefined || !Number.isFinite(refreshedAt.getTime())
      ? null
      : refreshedAt.toISOString();
  const accounts = current.accounts.map((account) => ({
    connectionId: connection.id,
    authIndex: account.authIndex,
    provider: account.provider,
    ...(account.label !== account.fileName &&
    account.label !== account.fileName?.split(/[\\/]/).pop() &&
    account.label !== account.authIndex &&
    account.label.trim().length > 0
      ? { label: account.label }
      : {}),
    ...(account.planType ? { planLabel: account.planType } : {}),
    status: account.status,
    availableAt: account.availableAt,
    legacyLimits: account.limits,
  }));

  return {
    state: current.error ? 'unavailable' : 'observed',
    observedAt,
    ...(current.error ? { errorCode: current.error.code } : {}),
    accounts,
  };
}

/** Synchronous credential metadata for the canonical quota usage service. */
export function getAccountProxyUsageInventory(): readonly AccountProxyUsageInventoryEntry[] {
  return currentUsageSnapshot()?.usageInventory ?? [];
}

function invalidUsageRead(): AccountProxyUsageReadResult {
  return { status: 'failure', errorInfo: { kind: 'unknown' } };
}

function activeUsageEntry(
  target: AccountProxyUsageInventoryEntry,
  startedGeneration: number,
): boolean {
  return (
    generation === startedGeneration &&
    usageInventoryEntryGeneration.get(target) === startedGeneration &&
    currentUsageSnapshot()?.usageInventory.some(
      (entry) =>
        entry.identity === target.identity &&
        entry.connectionId === target.connectionId &&
        entry.authIndex === target.authIndex &&
        entry.provider === target.provider,
    ) === true
  );
}

/** Read one account's provider quota through the proxy's management transport. */
export async function fetchAccountProxyUsage(
  target: AccountProxyUsageInventoryEntry,
  signal?: AbortSignal,
): Promise<AccountProxyUsageReadResult> {
  const startedGeneration = generation;
  if (signal?.aborted) return invalidUsageRead();
  if (!activeUsageEntry(target, startedGeneration)) return invalidUsageRead();
  const settings = lastSettings;
  const connection = settings?.connection;
  if (!connection || connection.id !== target.connectionId) {
    return invalidUsageRead();
  }

  let credentials: ConnectionKeys | null;
  try {
    credentials = await loadConnectionKeys(connection);
  } catch {
    return invalidUsageRead();
  }
  if (
    !activeUsageEntry(target, startedGeneration) ||
    !credentials ||
    activeKeyRejection(credentials.keyRejection)
  ) {
    return invalidUsageRead();
  }

  const providerUrl =
    target.provider === 'claude'
      ? 'https://api.anthropic.com/api/oauth/usage'
      : 'https://chatgpt.com/backend-api/wham/usage';
  const codexAccountId =
    target.provider === 'codex'
      ? usageInventoryCodexAccountId.get(target)
      : undefined;
  const headers =
    target.provider === 'claude'
      ? {
          Authorization: 'Bearer $TOKEN$',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        }
      : {
          Authorization: 'Bearer $TOKEN$',
          ...(codexAccountId ? { 'Chatgpt-Account-Id': codexAccountId } : {}),
        };
  const requestSignal = signal
    ? AbortSignal.any([signal, generationAbort.signal])
    : generationAbort.signal;

  if (!activeUsageEntry(target, startedGeneration)) return invalidUsageRead();
  try {
    const response = await requestAccountProxyManagement({
      baseUrl: connection.url,
      managementKey: credentials.managementKey,
      method: 'POST',
      path: '/requests/api-call',
      body: {
        auth_index: target.authIndex,
        method: 'GET',
        url: providerUrl,
        header: headers,
      },
      signal: requestSignal,
    });
    if (requestSignal.aborted || !activeUsageEntry(target, startedGeneration)) {
      return invalidUsageRead();
    }
    const usage = parseAccountProxyUsageResponse(
      target.provider,
      response.body,
      target.planType,
    );
    if (target.provider !== 'claude' || usage.status !== 'success') {
      return usage;
    }

    // Quota windows normally carry no plan. Read the OAuth profile using the
    // same proxy credential; only the resolved plan crosses this boundary.
    let planType: string | null = null;
    try {
      const profile = await requestAccountProxyManagement({
        baseUrl: connection.url,
        managementKey: credentials.managementKey,
        method: 'POST',
        path: '/requests/api-call',
        body: {
          auth_index: target.authIndex,
          method: 'GET',
          url: 'https://api.anthropic.com/api/oauth/profile',
          header: {
            Authorization: 'Bearer $TOKEN$',
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        },
        signal: requestSignal,
      });
      planType = parseClaudeOAuthProfilePlanType(profile.body);
    } catch (error) {
      if (keyRejectionOf(error)) throw error;
      // The profile is optional; its failure must not discard quota windows.
    }
    if (requestSignal.aborted || !activeUsageEntry(target, startedGeneration)) {
      return invalidUsageRead();
    }
    return planType ? { ...usage, planType } : usage;
  } catch (error) {
    if (requestSignal.aborted) return invalidUsageRead();
    if (keyRejectionOf(error) && activeUsageEntry(target, startedGeneration)) {
      const current =
        snapshot?.connectionId === target.connectionId ? snapshot : null;
      await recordKeyRejection(
        connection.id,
        credentials.managementKey,
        error,
        {
          connectionId: connection.id,
          version: current?.version ?? null,
          accounts: current?.accounts ?? [],
          usageInventory: current?.usageInventory ?? [],
          routing: current?.routing ?? null,
          refreshedAt: current?.refreshedAt ?? null,
          error: errorOf(error),
        },
      );
      return invalidUsageRead();
    }
    if (!activeUsageEntry(target, startedGeneration)) return invalidUsageRead();
    if (error instanceof AccountProxyManagementError) {
      return {
        status: 'failure',
        errorInfo: {
          kind: error.code === 'unreachable' ? 'network' : 'service',
        },
      };
    }
    return { status: 'failure', errorInfo: { kind: 'network' } };
  }
}

async function hasStoredKey(
  connection: AccountProxyConnection,
): Promise<boolean> {
  // The proxy on this device makes its keys when it starts.
  if (connection.kind === 'local') return true;
  try {
    return (await loadAccountProxyCredentials(connection.id)) !== null;
  } catch (error) {
    if (getSecureStorageFailure(error)) throw error;
    return false;
  }
}

async function buildStatus(settings: Settings): Promise<AccountProxyStatus> {
  const base = {
    available: settings.available,
    connection: settings.connection,
    keepChatOnOneAccount: settings.keepChatOnOneAccount,
    routeClaude: settings.routeClaude,
    routeCodex: settings.routeCodex,
    local: await getLocalAccountProxyRuntime(settings.startWithApp),
    signIn: currentSignIn(settings),
  };
  const empty = {
    error: null,
    version: null,
    accounts: [],
    routing: null,
    refreshedAt: null,
  };
  if (!settings.connection) {
    return { ...base, ...empty, state: 'not-configured' };
  }
  try {
    if (!(await hasStoredKey(settings.connection))) {
      return { ...base, ...empty, state: 'needs-key' };
    }
  } catch (error) {
    return { ...base, ...empty, state: 'error', error: errorOf(error) };
  }
  const current =
    snapshot?.connectionId === settings.connection.id ? snapshot : null;
  if (!current) {
    return { ...base, ...empty, state: 'connected' };
  }
  const { peekObservabilityService } = await import('../observability');
  const observability = peekObservabilityService();
  const accounts = current.accounts.map((account) => {
    const usage = observability?.getAccountProxyUsage(
      current.connectionId,
      account.authIndex,
    );
    return usage
      ? { ...account, usage, planType: usage.planType ?? account.planType }
      : account;
  });
  return {
    ...base,
    state: current.error ? 'error' : 'connected',
    error: current.error,
    version: current.version,
    accounts,
    routing: current.routing,
    refreshedAt: current.refreshedAt,
  };
}

async function readServer(
  connection: AccountProxyConnection,
  managementKey: AccountProxyManagementKey,
  signal?: AbortSignal,
): Promise<Omit<Snapshot, 'connectionId' | 'error'>> {
  const request = {
    baseUrl: connection.url,
    managementKey,
    method: 'GET',
    signal,
  } as const;
  // Credentials first: it carries the version check and the key check, so a
  // wrong key costs the server one failed attempt, not two.
  const credentials = await requestAccountProxyManagement({
    ...request,
    path: '/credentials',
  });
  const now = Date.now();
  let configAccounts: AccountProxyAccount[] = [];
  let routing: AccountProxyRouting | null = null;
  try {
    const config = await requestAccountProxyManagement({
      ...request,
      path: '/config',
    });
    configAccounts = parseAccountProxyConfigAccounts(config.body);
    routing = parseAccountProxyRouting(config.body);
  } catch (error) {
    // A server that hides its config answers 404 and still lists signed-in
    // accounts. Any other failure fails the read, so the last good list and
    // routing stay in place with the error shown.
    if (
      !(error instanceof AccountProxyManagementError) ||
      error.code !== 'management-disabled'
    ) {
      throw error;
    }
  }
  const credentialAccounts = parseAccountProxyCredentials(
    credentials.body,
    now,
  );
  return {
    version: credentials.version,
    accounts: sortAccountProxyAccounts([
      ...credentialAccounts,
      ...configAccounts,
    ]),
    usageInventory: usageInventoryFromCredentials(
      connection.id,
      credentials.body,
      credentialAccounts,
    ),
    routing,
    refreshedAt: now,
  };
}

async function refreshSnapshot(settings: Settings): Promise<void> {
  const connection = settings.connection;
  if (!settings.available || !connection) return;
  // The proxy on this device is read only while it runs: its port is free
  // otherwise, and whatever takes it must not be sent the key.
  if (!isLocalConnectionRunning(connection)) return;
  const startedGeneration = generation;
  const startedSignal = generationAbort.signal;
  const previous = snapshot?.connectionId === connection.id ? snapshot : null;
  const previousInventory =
    previous && usageInventoryGeneration === startedGeneration
      ? previous.usageInventory
      : [];
  if (previous && keyRejected()) return;
  const keepPrevious = (error: unknown): Snapshot => ({
    connectionId: connection.id,
    version: previous?.version ?? null,
    accounts: previous?.accounts ?? [],
    usageInventory: previousInventory,
    routing: previous?.routing ?? null,
    refreshedAt: previous?.refreshedAt ?? null,
    error: errorOf(error),
  });
  let next: Snapshot | null;
  let sentKey: AccountProxyManagementKey | null = null;
  try {
    const credentials = await loadConnectionKeys(connection);
    // The proxy on this device can stop while the key is read.
    if (
      generation !== startedGeneration ||
      !isLocalConnectionRunning(connection)
    )
      return;
    sentKey = credentials?.managementKey ?? null;
    const savedRejection = activeKeyRejection(credentials?.keyRejection);
    if (savedRejection) {
      // Refused before the app last quit: nothing is sent until a new key.
      rejectedAt = savedRejection.at;
      next = keepPrevious(new AccountProxyManagementError(savedRejection.code));
    } else {
      if (credentials) {
        const server = await readServer(
          connection,
          credentials.managementKey,
          startedSignal,
        );
        next = {
          connectionId: connection.id,
          ...server,
          usageInventory: reuseUnchangedUsageEntries(
            previousInventory,
            server.usageInventory,
          ),
          error: null,
        };
      } else {
        next = null;
      }
    }
  } catch (error) {
    // The user reconnected or disconnected while this refresh was in flight.
    if (generation !== startedGeneration) return;
    if (keyRejectionOf(error)) {
      if (sentKey !== null) {
        await recordKeyRejection(
          connection.id,
          sentKey,
          error,
          keepPrevious(error),
        );
      }
      return;
    }
    // Keep the last accounts on a transient failure so the list does not
    // empty out while the server restarts.
    next = keepPrevious(error);
  }
  // The user reconnected or disconnected while this refresh was in flight.
  if (generation !== startedGeneration) return;
  if (!next) {
    usageInventoryGeneration = -1;
    notifyUsageInventoryChanged();
    return;
  }
  snapshot = next;
  if (!next.error) {
    bindUsageInventoryToGeneration(next.usageInventory, startedGeneration);
    usageInventoryGeneration = startedGeneration;
    notifyUsageInventoryChanged();
  } else if (!previous?.error) {
    // A newly failed proxy no longer serves new provider work. Keep the last
    // successful quota inventory intact, but let source projections reread
    // the changed status. Repeated failures do not invalidate it again.
    notifyUsageInventoryChanged();
  }
  refreshFailures = next.error ? refreshFailures + 1 : 0;
}

/**
 * Records that the server refused the stored key. A new generation makes any
 * refresh still in flight drop its result, so nothing can replace the
 * rejection and let the key be sent again; the saved copy outlasts a restart.
 */
async function recordKeyRejection(
  connectionId: string,
  rejectedKey: AccountProxyManagementKey,
  error: unknown,
  next: Snapshot,
): Promise<void> {
  const code = keyRejectionOf(error);
  if (!code) return;
  startNewGeneration();
  rejectedAt = Date.now();
  snapshot = next;
  // A launch's key is stored nowhere; the next start makes new ones.
  if (typeof rejectedKey !== 'string') return;
  await markAccountProxyKeyRejected(
    connectionId,
    { code, at: rejectedAt },
    rejectedKey,
  ).catch(() => undefined);
}

async function publish(): Promise<AccountProxyStatus> {
  const status = await buildStatus(await readSettings());
  sendToAllWindows(IPC_CHANNELS.accountProxyChanged, status);
  return status;
}

export async function getAccountProxyStatus(
  options: {
    readonly refresh?: boolean;
    readonly maxAgeMs?: number;
    readonly refreshUsage?: boolean;
  } = {},
): Promise<AccountProxyStatus> {
  const settings = await readSettings();
  if (options.refresh && settings.available && settings.connection) {
    // Background callers share successful snapshots and failed attempts. A
    // manual refresh still bypasses the cache; rejected keys remain latched.
    const current =
      snapshot?.connectionId === settings.connection.id ? snapshot : null;
    const maxAge = Math.max(5000, options.maxAgeMs ?? 0);
    const retryDelay = refreshFailures
      ? Math.min(300_000, 30_000 * 2 ** Math.min(refreshFailures - 1, 4))
      : maxAge;
    const checkedAt = Math.max(
      current?.refreshedAt ?? 0,
      refreshAttemptAt ?? 0,
    );
    if (refreshing) await refreshing;
    else if (
      options.maxAgeMs === undefined ||
      Date.now() - checkedAt >= retryDelay
    ) {
      refreshAttemptAt = Date.now();
      const read = refreshSnapshot(settings);
      const pending = read.finally(() => {
        if (refreshing === pending) refreshing = null;
      });
      refreshing = pending;
      await pending;
    }
  }
  if (options.refreshUsage) {
    const { getObservabilityService } = await import('../observability');
    await getObservabilityService().refreshAccountProxyUsage({
      interactive: true,
    });
  }
  return buildStatus(await readSettings());
}

function connectError(code: AccountProxyErrorCode): AccountProxyConnectResult {
  return { ok: false, error: { code, message: code } };
}

export async function connectAccountProxy(
  request: AccountProxyConnectRequest,
): Promise<AccountProxyConnectResult> {
  // Taken before the first await, so a disconnect called after this connect
  // always wins.
  connectAttempt += 1;
  const attempt = connectAttempt;
  const settings = await readSettings();
  if (!settings.available) return connectError('unexpected');
  const url = normalizeAccountProxyUrl(request.url);
  if (!url.ok) return connectError(url.code);
  const managementKey = request.managementKey.trim();
  if (!managementKey) return connectError('unauthorized');
  const connection: AccountProxyConnection = {
    // Reconnecting to the same server keeps its id, so per-account history
    // recorded against it stays together.
    id:
      settings.connection?.url === url.url
        ? settings.connection.id
        : randomUUID(),
    kind: 'server',
    url: url.url,
  };
  let server: Awaited<ReturnType<typeof readServer>>;
  try {
    server = await readServer(connection, managementKey);
  } catch (error) {
    return { ok: false, error: errorOf(error) };
  }
  return withPersistenceLock(async () => {
    // The user disconnected, or connected again, while this check ran.
    if (attempt !== connectAttempt) return connectError('unexpected');
    // Before the new key is written, so a refresh or action still running on
    // the old key drops its reply instead of recording it against this one.
    startNewGeneration();
    const previous = (await readSettings()).connection;
    const previousId = previous?.id;
    if (previous?.kind === 'local') {
      // The proxy on this device goes with its connection.
      localStartWanted = null;
      await releaseLocalProxy('replaced-by-server');
    }
    let stored: Awaited<ReturnType<typeof loadAccountProxyCredentials>> = null;
    if (previousId === connection.id) {
      try {
        stored = await loadAccountProxyCredentials(connection.id);
      } catch (error) {
        if (getSecureStorageFailure(error))
          return { ok: false, error: errorOf(error) };
      }
    }
    // Agents on this device send their own client key, so the server can
    // revoke this device alone. A failure here does not stop the connection:
    // sessions make sure of the key again before they route.
    let clientKey: string | null;
    try {
      clientKey = await ensureAccountProxyClientKey(
        connection,
        managementKey,
        stored?.clientKey ?? null,
      );
      openServerCheckedAt.delete(connection.id);
    } catch {
      // A failed check is not proof the server is open: keep the key this
      // device had, and have the next route lookup check it with the server.
      clientKey = stored?.clientKey ?? null;
      if (clientKey) {
        suspectClientKeys.add(accountProxyClientKeyFingerprint(clientKey));
      }
      openServerCheckedAt.delete(connection.id);
      clientKeyCheckFailedAt.delete(connection.id);
    }
    try {
      await saveAccountProxyCredentials(connection.id, {
        managementKey,
        clientKey,
      });
    } catch (error) {
      return { ok: false, error: errorOf(error) };
    }
    await updatePreferencesFile((preferences) => ({
      ...preferences,
      accountProxyConnection: connection,
    }));
    await readSettings();
    if (previousId && previousId !== connection.id) {
      await deleteAccountProxyCredentials(previousId).catch(() => undefined);
    }
    startNewGeneration();
    snapshot = { connectionId: connection.id, ...server, error: null };
    bindUsageInventoryToGeneration(snapshot.usageInventory, generation);
    usageInventoryGeneration = generation;
    notifyUsageInventoryChanged();
    return { ok: true, status: await publish() };
  });
}

export function disconnectAccountProxy(): Promise<AccountProxyStatus> {
  connectAttempt += 1;
  return disconnectCurrent();
}

/**
 * Remove the current connection. Takes no attempt of its own, so a setup
 * that replaces a server still gives way to a disconnect the user makes
 * meanwhile.
 */
function disconnectCurrent(): Promise<AccountProxyStatus> {
  return withPersistenceLock(removeCurrentConnection);
}

/** {@link disconnectCurrent}, for callers that hold the persistence lock. */
async function removeCurrentConnection(): Promise<AccountProxyStatus> {
  const settings = await readSettings();
  const connection = settings.connection;
  if (connection?.kind === 'local') {
    // The proxy goes with the connection. Its signed-in accounts stay on
    // this device, so setting it up again brings them back. Refreshes in
    // flight drop the key before the port is released.
    endSignIn();
    localStartWanted = null;
    await releaseLocalProxy('disconnect');
  } else if (connection && !keyRejected()) {
    // Take this device's client key off the server. Best effort: a server
    // that is down keeps the key until someone removes it there.
    const credentials = await loadAccountProxyCredentials(connection.id).catch(
      () => null,
    );
    if (credentials?.clientKey && !credentials.keyRejection) {
      await revokeAccountProxyClientKey(
        connection,
        credentials.managementKey,
        credentials.clientKey,
      ).catch(() => undefined);
    }
  }
  await updatePreferencesFile((preferences) => ({
    ...preferences,
    accountProxyConnection: null,
  }));
  if (connection) {
    await deleteAccountProxyCredentials(connection.id).catch(() => undefined);
  }
  startNewGeneration();
  snapshot = null;
  return publish();
}

export type { AccountProxyHarness };

/** How old the account list may be when a session decides its route. */
const ROUTE_SNAPSHOT_MAX_AGE_MS = 60_000;
let lastRouteRefreshAt = 0;
/** The account list read a session start is waiting on, shared by all. */
let routeRefresh: Promise<void> | null = null;

/** What a session needs to route through the proxy. */
export interface AccountProxyRouteTarget {
  readonly connection: AccountProxyConnection;
  /** Null for a server without client keys, which accepts every request. */
  readonly clientKey: AccountProxyClientKey | null;
  /** Send session ids so the server keeps a chat on one account. */
  readonly keepChatOnOneAccount: boolean;
  /** Accounts for this harness that can take a request now. */
  readonly readyAccounts: number;
  /**
   * Why no account for this harness can take the session until the user acts,
   * such as adding one; null while one is ready or can become ready.
   */
  readonly noUsableAccounts: string | null;
}

/**
 * The proxy this device routes `harness` sessions through, or null when it
 * should not: the flag or opt-in is off, nothing is connected, the user
 * turned routing off for this harness, or the server rejects the key.
 */
export async function getAccountProxyRouteTarget(
  harness: AccountProxyHarness,
): Promise<AccountProxyRouteTarget | null> {
  const settings = await readSettings();
  const connection = settings.connection;
  if (!settings.available || !connection) return null;
  if (!(harness === 'claude' ? settings.routeClaude : settings.routeCodex))
    return null;
  // A stopped proxy on this device takes no sessions; they use their usual
  // billing, and nothing is sent to its released port.
  if (!isLocalConnectionRunning(connection)) return null;
  const now = Date.now();
  const stale =
    snapshot?.connectionId !== connection.id ||
    snapshot.refreshedAt === null ||
    now - snapshot.refreshedAt > ROUTE_SNAPSHOT_MAX_AGE_MS;
  // A failed refresh keeps the old time, so without the second check every
  // session start would wait on a server that is down. The promise is set
  // before any await, so lookups that start together share one read.
  if (
    !routeRefresh &&
    stale &&
    now - lastRouteRefreshAt > ROUTE_SNAPSHOT_MAX_AGE_MS
  ) {
    lastRouteRefreshAt = now;
    routeRefresh = getAccountProxyStatus({ refresh: true })
      // Windows learn the accounts a session start read, so the model picker
      // agrees with routing without opening Settings.
      .then(() => publish())
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        routeRefresh = null;
      });
  }
  // Another session's read, or a Settings refresh, is the list to use.
  await (routeRefresh ?? refreshing)?.catch(() => undefined);
  // A server that cannot be reached, or that rejects the key, gets no new
  // sessions; they use their usual billing instead.
  if (snapshot?.connectionId !== connection.id || snapshot.error) return null;
  const startedGeneration = generation;
  const credentials = await loadConnectionKeys(connection).catch(() => null);
  if (!credentials) return null;
  // The proxy on this device can stop while the keys are read.
  if (!isLocalConnectionRunning(connection)) return null;
  let clientKey = credentials.clientKey;
  if (
    !clientKey ||
    suspectClientKeys.has(accountProxyClientKeyVersion(clientKey))
  ) {
    // The proxy on this device takes the key its launch wrote into its
    // config, so there is nothing to repair through its management API; a
    // restart makes new keys.
    if (clientKey !== null && typeof clientKey !== 'string') return null;
    // Connections made before this device had its own key get one now, a
    // key the proxy refused is checked and replaced, and an open server is
    // checked again in case it started requiring keys.
    const repaired = await repairClientKey(connection, clientKey);
    if (repaired === undefined) return null;
    clientKey = repaired;
  }
  // The user reconnected or disconnected while the key was loaded.
  const current = snapshot;
  if (
    generation !== startedGeneration ||
    current?.connectionId !== connection.id ||
    current.error
  ) {
    return null;
  }
  const serverAffinity = current.routing?.sessionAffinity !== false;
  return {
    connection,
    clientKey,
    keepChatOnOneAccount: serverAffinity && settings.keepChatOnOneAccount,
    readyAccounts: readyAccountCount(current, harness),
    noUsableAccounts: accountProxyNoUsableAccountsMessage(
      current.accounts,
      harness,
    ),
  };
}

function readyAccountCount(
  current: Snapshot,
  harness: AccountProxyHarness,
): number {
  return countReadyAccountProxyAccounts(current.accounts, harness);
}

/**
 * The proxy settings a `harness` session is created under, from the settings
 * last read: empty when the proxy is off, otherwise the connection, whether
 * this harness routes through it, and whether chats are kept on one account.
 * Synchronous, for the session registry's routing signature, so changing any
 * of them recreates the session; the route itself is decided when the session
 * is created.
 */
export function accountProxySettingsSignature(
  harness: AccountProxyHarness,
): string {
  const settings = lastSettings;
  const connection = settings?.connection;
  if (!isAccountProxyFlagEnabled() || !settings?.available || !connection)
    return '';
  const routes =
    harness === 'claude' ? settings.routeClaude : settings.routeCodex;
  const signature = `account-proxy:${connection.id}:${routes ? 'on' : 'off'}:${
    settings.keepChatOnOneAccount ? 'keep' : 'spread'
  }`;
  if (connection.kind !== 'local') return signature;
  // Sessions route through the proxy on this device only while it runs, so
  // starting or stopping it recreates them with the current route.
  const port = getLocalAccountProxyPort();
  return isLocalConnectionRunning(connection) && port !== null
    ? `${signature}:local-${String(port)}`
    : `${signature}:local-stopped`;
}

/** Fingerprints of client keys the proxy answered 401 or 403 to. */
const suspectClientKeys = new Set<string>();
/** How long a client key check result stands before it is checked again. */
const CLIENT_KEY_RECHECK_MS = 60_000;
const clientKeyCheckFailedAt = new Map<string, number>();
const openServerCheckedAt = new Map<string, number>();
/** One client key repair per connection; concurrent sessions share it. */
const clientKeyRepairs = new Map<string, Promise<string | null | undefined>>();

/**
 * Called by the broker when the proxy refuses a client key. The next route
 * lookup checks the key with the server and replaces it if it is gone.
 */
export function reportAccountProxyClientKeyRejected(fingerprint: string): void {
  suspectClientKeys.add(fingerprint);
}

/**
 * Makes sure the server lists this device's client key, adding one if not.
 * Resolves to the key, null for an open server, or undefined when it could
 * not be checked. Runs under the save lock against freshly loaded
 * credentials, so it never overwrites a newer key or management key.
 */
function repairClientKey(
  connection: AccountProxyConnection,
  stored: string | null,
): Promise<string | null | undefined> {
  const pending = clientKeyRepairs.get(connection.id);
  if (pending) return pending;
  // A check that just failed, or that just found an open server, is not
  // repeated for every session start.
  const now = Date.now();
  if (
    now - (clientKeyCheckFailedAt.get(connection.id) ?? 0) <
    CLIENT_KEY_RECHECK_MS
  )
    return Promise.resolve(undefined);
  if (
    stored === null &&
    now - (openServerCheckedAt.get(connection.id) ?? 0) < CLIENT_KEY_RECHECK_MS
  )
    return Promise.resolve(null);
  const startedGeneration = generation;
  const run = withPersistenceLock(async () => {
    if (generation !== startedGeneration) return undefined;
    const current = await loadAccountProxyCredentials(connection.id).catch(
      () => null,
    );
    if (!current || activeKeyRejection(current.keyRejection)) return undefined;
    const stored = current.clientKey;
    const storedFingerprint = stored
      ? accountProxyClientKeyFingerprint(stored)
      : null;
    // Another repair already settled it.
    if (
      stored &&
      storedFingerprint &&
      !suspectClientKeys.has(storedFingerprint)
    )
      return stored;
    let key: string | null;
    try {
      key = await ensureAccountProxyClientKey(
        connection,
        current.managementKey,
        stored,
      );
    } catch (error) {
      clientKeyCheckFailedAt.set(connection.id, Date.now());
      if (keyRejectionOf(error) && generation === startedGeneration) {
        await recordKeyRejection(connection.id, current.managementKey, error, {
          connectionId: connection.id,
          version: snapshot?.version ?? null,
          accounts: snapshot?.accounts ?? [],
          usageInventory: snapshot?.usageInventory ?? [],
          routing: snapshot?.routing ?? null,
          refreshedAt: snapshot?.refreshedAt ?? null,
          error: errorOf(error),
        });
        void publish();
      }
      return undefined;
    }
    if (key !== stored) {
      // Sessions read the key from storage for every request, so a key that
      // was not saved cannot be used.
      try {
        await saveAccountProxyCredentials(connection.id, {
          managementKey: current.managementKey,
          clientKey: key,
        });
      } catch {
        return undefined;
      }
    }
    if (storedFingerprint) suspectClientKeys.delete(storedFingerprint);
    clientKeyCheckFailedAt.delete(connection.id);
    if (key === null) openServerCheckedAt.set(connection.id, Date.now());
    return key;
  }).finally(() => {
    clientKeyRepairs.delete(connection.id);
  });
  clientKeyRepairs.set(connection.id, run);
  return run;
}

/** The account the proxy reported by `auth_index`, for attribution. */
/**
 * The labels of the accounts the last read listed, by the key cost views use
 * (CAN-4021). Accounts of another connection are not in it.
 */
export function getAccountProxyAccountLabels(): ReadonlyMap<string, string> {
  const current = snapshot;
  if (!current) return new Map();
  return new Map(
    current.accounts.map((account) => [
      accountProxyAccountKey(current.connectionId, account.authIndex),
      account.label,
    ]),
  );
}

/**
 * The account `authIndex` names in the last account list read. With
 * `connectionId`, only when that list is the connection's: another
 * connection reuses the same ids for other credentials.
 */
export function findAccountProxyAccount(
  authIndex: string,
  connectionId?: string,
): AccountProxyAccount | null {
  if (connectionId !== undefined && snapshot?.connectionId !== connectionId) {
    return null;
  }
  return (
    snapshot?.accounts.find((account) => account.authIndex === authIndex) ??
    null
  );
}

interface ManagementTarget {
  readonly connection: AccountProxyConnection;
  readonly managementKey: AccountProxyManagementKey;
}

/** The connection a management change goes to, once it may be sent. */
async function managementConnection(): Promise<AccountProxyConnection> {
  const settings = await readSettings();
  if (!settings.available || !settings.connection) {
    throw new Error('Connect to an account proxy first.');
  }
  if (!isLocalConnectionRunning(settings.connection)) {
    throw new Error('Start the proxy on this device first.');
  }
  // Every request with a rejected key counts toward the server's 30-minute
  // block, so nothing is sent until the user enters the current key.
  if (keyRejected()) {
    throw new Error('Enter the current management key first.');
  }
  return settings.connection;
}

async function managementKeyOf(
  connection: AccountProxyConnection,
): Promise<AccountProxyManagementKey> {
  const credentials = await loadConnectionKeys(connection);
  if (!credentials) {
    throw new Error(
      connection.kind === 'local'
        ? 'Start the proxy on this device first.'
        : 'Add the management key first.',
    );
  }
  return credentials.managementKey;
}

async function signInAccount(
  authIndex: string,
): Promise<ManagementTarget & { readonly fileName: string }> {
  const connection = await managementConnection();
  const account = snapshot?.accounts.find(
    (candidate) => candidate.authIndex === authIndex,
  );
  if (
    snapshot?.connectionId !== connection.id ||
    !account ||
    account.source !== 'sign-in' ||
    !account.fileName
  ) {
    throw new Error('That account can only be changed on the server.');
  }
  return {
    connection,
    managementKey: await managementKeyOf(connection),
    fileName: account.fileName,
  };
}

async function routingTarget(): Promise<ManagementTarget> {
  const connection = await managementConnection();
  return { connection, managementKey: await managementKeyOf(connection) };
}

async function applyManagementAction<Target extends ManagementTarget>(
  loadTarget: () => Promise<Target>,
  action: (target: Target) => Promise<void>,
): Promise<AccountProxyStatus> {
  // Taken before the key is loaded: a reconnect during the load replaces the
  // key, and the old one must not be sent or blamed for the new connection.
  const startedGeneration = generation;
  const target = await loadTarget();
  if (generation !== startedGeneration) {
    throw new Error('The connection changed. Try again.');
  }
  // Checked again after the key loaded: a stop in between released the port.
  if (!isLocalConnectionRunning(target.connection)) {
    throw new Error('Start the proxy on this device first.');
  }
  try {
    await action(target);
  } catch (error) {
    if (
      error instanceof AccountProxyManagementError &&
      KEY_REJECTED_CODES.has(error.code) &&
      snapshot
    ) {
      // A reply to a key the user has since replaced says nothing about the
      // new one.
      if (generation !== startedGeneration) throw error;
      await recordKeyRejection(
        target.connection.id,
        target.managementKey,
        error,
        {
          ...snapshot,
          error: errorOf(error),
        },
      );
      return publish();
    }
    throw error;
  }
  // A refresh that began before the change would report the old state, so
  // wait it out, then refresh through the same lock as every other caller.
  await refreshing?.catch(() => undefined);
  await getAccountProxyStatus({ refresh: true });
  notifyUsageInventoryChanged();
  return publish();
}

function applyAccountAction(
  authIndex: string,
  action: (target: Awaited<ReturnType<typeof signInAccount>>) => Promise<void>,
): Promise<AccountProxyStatus> {
  return applyManagementAction(() => signInAccount(authIndex), action);
}

export function setAccountProxyAccountDisabled(
  authIndex: string,
  disabled: boolean,
): Promise<AccountProxyStatus> {
  return applyAccountAction(authIndex, async (target) => {
    await requestAccountProxyManagement({
      baseUrl: target.connection.url,
      managementKey: target.managementKey,
      method: 'PATCH',
      path: '/credentials/status',
      body: { name: target.fileName, auth_index: authIndex, disabled },
    });
  });
}

export function removeAccountProxyAccount(
  authIndex: string,
): Promise<AccountProxyStatus> {
  return applyAccountAction(authIndex, async (target) => {
    await requestAccountProxyManagement({
      baseUrl: target.connection.url,
      managementKey: target.managementKey,
      method: 'DELETE',
      path: `/credentials?name=${encodeURIComponent(target.fileName)}`,
    });
  });
}

/**
 * Change the proxy's `routing.strategy`. The proxy saves it to its config
 * file. For the proxy on this device the choice is also kept here, because
 * the config is written again on every start.
 */
export function setAccountProxyRoutingStrategy(
  strategy: AccountProxyRoutingStrategy,
): Promise<AccountProxyStatus> {
  return applyManagementAction(routingTarget, async (target) => {
    await requestAccountProxyManagement({
      baseUrl: target.connection.url,
      managementKey: target.managementKey,
      method: 'PUT',
      path: '/config/routing/strategy',
      body: strategy,
    });
    if (target.connection.kind !== 'local') return;
    await updatePreferencesFile((preferences) =>
      preferences.accountProxyConnection?.id === target.connection.id
        ? { ...preferences, accountProxyLocalRoutingStrategy: strategy }
        : preferences,
    );
  });
}

/**
 * Status reconciliations, one at a time, so each sees the stop before it
 * finished: a flag served on while the proxy stops for it being served off
 * starts the proxy again.
 */
let localReconcile: Promise<unknown> = Promise.resolve();

/** Re-publish after the opt-in, the flag, or the routing preference change. */
export async function publishAccountProxyStatus(): Promise<void> {
  const run = localReconcile.then(reconcileLocalProxy, reconcileLocalProxy);
  localReconcile = run.catch(() => undefined);
  const started = await run;
  await publish();
  // Awaited outside the queue, so a download does not hold up a later stop.
  await started?.start;
}

/** A start the reconciliation began, wrapped so it is not awaited there. */
interface LocalAutoStart {
  readonly start: Promise<void>;
}

/** Stop or start the proxy on this device to match the settings. */
async function reconcileLocalProxy(): Promise<LocalAutoStart | null> {
  const settings = await readSettings();
  const local =
    settings.connection?.kind === 'local' ? settings.connection : null;
  // The proxy on this device runs only while it is the connection and the
  // feature is on. A flag on its fallback, while LaunchDarkly starts or
  // changes account, leaves it as it is.
  if (!local || isTurnedOff(settings)) {
    // Opting out or another connection ends the start with the app; the
    // flag served off does not, so the proxy comes back when it is served on.
    if (!local || !settings.optedIn) localStartWanted = null;
    // A sign-in waiting on, or starting with, that proxy ends with it.
    endSignIn();
    if (getLocalAccountProxyPort() !== null || isLocalAccountProxyStarting()) {
      // Refreshes in flight drop the key before the port is released.
      await releaseLocalProxy(
        !local
          ? 'not-the-connection'
          : settings.optedIn
            ? 'flag-off'
            : 'turned-off',
      );
    } else {
      // A start still reading its keys does not launch the proxy.
      localLifecycle += 1;
    }
    return null;
  }
  if (
    settings.available &&
    (localStartWanted === 'user' ||
      (localStartWanted === 'with-app' && settings.startWithApp))
  ) {
    return startWantedLocalProxy(local, settings.startWithApp);
  }
  return null;
}

/**
 * Start the proxy on this device when this launch wants it and it is not
 * running: the flag arrived after the app opened, or was served on again.
 * One that failed or exited keeps its error until the user starts it.
 */
async function startWantedLocalProxy(
  connection: AccountProxyConnection,
  startWithApp: boolean,
): Promise<LocalAutoStart | null> {
  // A start a stop has since cancelled reconciles again once it ends.
  if (localAutoStart) {
    return localAutoStart.lifecycle === localLifecycle
      ? { start: localAutoStart.start }
      : null;
  }
  if (isLocalAccountProxyStarting()) return null;
  // Taken before the runtime is read, so a stop meanwhile cancels this start.
  const lifecycle = localLifecycle;
  const { phase } = await getLocalAccountProxyRuntime(startWithApp);
  if (phase !== 'stopped' && phase !== 'not-installed') return null;
  if (
    lifecycle !== localLifecycle ||
    localStartWanted === null ||
    localAutoStart ||
    isLocalAccountProxyStarting()
  ) {
    return null;
  }
  const start = startLocalConnection(connection, lifecycle)
    .catch(() => undefined)
    .finally(() => {
      if (localAutoStart?.start !== start) return;
      localAutoStart = null;
      // Stopped while it started: the settings may want it running again,
      // such as a flag served off and then on before this start ended.
      if (lifecycle !== localLifecycle) {
        void publishAccountProxyStatus().catch(() => undefined);
      }
    });
  localAutoStart = { start, lifecycle };
  return { start };
}

/**
 * Whether requests may go to `connection` now: a server always, the proxy
 * on this device only while it runs on the connection's port. Routes ask on
 * every request, so a stopped proxy is sent no key.
 */
export function isAccountProxyConnectionServing(
  connection: AccountProxyConnection,
): boolean {
  return isLocalConnectionRunning(connection);
}

/**
 * Whether `connection` can be read and routed to now. A server always can;
 * the proxy on this device only while it runs on the connection's port.
 */
function isLocalConnectionRunning(connection: AccountProxyConnection): boolean {
  if (connection.kind !== 'local') return true;
  const port = getLocalAccountProxyPort();
  return port !== null && port === portOf(connection);
}

function localUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

function portOf(connection: AccountProxyConnection): number | null {
  try {
    const port = Number(new URL(connection.url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Start the proxy for a local connection and point the connection at the
 * port it got. A port taken by another program moves the proxy, and sessions
 * started after that use the new address.
 */
async function startLocalConnection(
  connection: AccountProxyConnection,
  lifecycle: number = localLifecycle,
): Promise<void> {
  watchLocalRuntime();
  const { localRoutingStrategy } = await readSettings();
  // Stopped since the start was asked for. A stop made after this point is
  // queued behind the start and undoes it.
  if (lifecycle !== localLifecycle) {
    throw new LocalAccountProxyError(
      'local-failed',
      'The account proxy was stopped while it started.',
    );
  }
  const launchBefore = getLocalAccountProxyLaunch()?.keys.epoch ?? null;
  const port = await startLocalAccountProxy({
    preferredPort: portOf(connection),
    routingStrategy: localRoutingStrategy,
  });
  // A refusal recorded against an earlier launch's key says nothing about
  // a new launch's keys. A start that found the proxy running kept its keys,
  // and the refusal with them.
  const launchAfter = getLocalAccountProxyLaunch()?.keys.epoch ?? null;
  if (
    launchAfter !== null &&
    launchAfter !== launchBefore &&
    snapshot?.connectionId === connection.id &&
    snapshot.error &&
    KEY_REJECTED_CODES.has(snapshot.error.code)
  ) {
    snapshot = { ...snapshot, error: null };
  }
  // Turned off, disconnected, or replaced while the proxy started. Only a
  // start nothing has superseded stops it; otherwise the proxy running now
  // belongs to the newer start.
  const now = await readSettings();
  if (isTurnedOff(now) || now.connection?.id !== connection.id) {
    if (lifecycle === localLifecycle)
      await releaseLocalProxy('turned-off-while-starting');
    throw new LocalAccountProxyError(
      'local-failed',
      'The account proxy was turned off while it started.',
    );
  }
  if (port !== portOf(connection)) {
    await withPersistenceLock(async () => {
      // A newer start or stop owns the address now.
      if (lifecycle !== localLifecycle || getLocalAccountProxyPort() !== port)
        return;
      await updatePreferencesFile((preferences) =>
        preferences.accountProxyConnection?.id === connection.id
          ? {
              ...preferences,
              accountProxyConnection: { ...connection, url: localUrl(port) },
            }
          : preferences,
      );
      startNewGeneration();
    });
  }
  await getAccountProxyStatus({ refresh: true });
}

/**
 * "Run on this device": make the proxy on this device the connection, in
 * place of any server, and start it. Each start makes its own keys. A failed
 * download or start keeps the connection, so the settings can offer Retry.
 */
export async function setUpLocalAccountProxy(): Promise<AccountProxyConnectResult> {
  connectAttempt += 1;
  const attempt = connectAttempt;
  // Taken before any wait, so turning the feature off meanwhile cancels the
  // start this setup ends with.
  const lifecycle = localLifecycle;
  const settings = await readSettings();
  if (!settings.available) return connectError('unexpected');
  if ((await getLocalAccountProxyRuntime(true)).phase === 'unsupported') {
    return connectError('local-unsupported');
  }
  let connection = settings.connection;
  if (connection?.kind !== 'local') {
    // Picked before a server connection is removed, so failing to find a
    // port leaves that connection in place.
    let port: number;
    try {
      port = await pickLocalAccountProxyPort();
    } catch (error) {
      return { ok: false, error: errorOf(error) };
    }
    if (attempt !== connectAttempt) return connectError('unexpected');
    const created: AccountProxyConnection = {
      id: randomUUID(),
      kind: 'local',
      url: localUrl(port),
    };
    const replacing = connection !== null;
    const saved = await withPersistenceLock(async () => {
      // A disconnect or a server connect made while this ran wins.
      if (attempt !== connectAttempt) {
        const superseded: AccountProxyError = {
          code: 'unexpected',
          message: 'unexpected',
        };
        return superseded;
      }
      if (replacing) await removeCurrentConnection();
      await updatePreferencesFile((preferences) => ({
        ...preferences,
        accountProxyConnection: created,
      }));
      startNewGeneration();
      snapshot = null;
      return null;
    });
    if (saved) return { ok: false, error: saved };
    connection = created;
  }
  if (attempt !== connectAttempt) return connectError('unexpected');
  // A stop made while this set up keeps the proxy from starting again later.
  if (lifecycle === localLifecycle) localStartWanted = 'user';
  try {
    await startLocalConnection(connection, lifecycle);
  } catch (error) {
    await publish();
    return { ok: false, error: errorOf(error) };
  }
  return { ok: true, status: await publish() };
}

/** Start, stop, or restart the proxy on this device. */
export async function controlLocalAccountProxy(
  request: AccountProxyLocalControlRequest,
): Promise<AccountProxyStatus> {
  // Taken before any wait, so a stop made meanwhile cancels this request.
  let lifecycle = localLifecycle;
  const settings = await readSettings();
  const connection = settings.connection;
  if (!settings.available || connection?.kind !== 'local') {
    throw new Error('The proxy on this device is not set up.');
  }
  // A start a later stop superseded does not ask for the proxy again.
  if (request.action === 'stop') localStartWanted = null;
  else if (lifecycle === localLifecycle) localStartWanted = 'user';
  if (request.action !== 'start') {
    // Refreshes in flight drop the key before the port is released.
    endSignIn();
    lifecycle = await releaseLocalProxy(
      request.action === 'stop' ? 'user-stop' : 'restart',
    );
  }
  if (request.action !== 'stop') {
    // A failed start is shown in the status; the request itself succeeds.
    await startLocalConnection(connection, lifecycle).catch(() => undefined);
  }
  return publish();
}

let localListener: (() => void) | null = null;
let watchedLocalPort: number | null = null;

/**
 * Publishes the proxy's state as it changes. When it stops serving its port,
 * including when it exits unexpectedly, refreshes and session requests in
 * flight are cancelled before they reach whatever takes the port next.
 */
function watchLocalRuntime(): void {
  if (localListener) return;
  watchedLocalPort = getLocalAccountProxyPort();
  localListener = onLocalAccountProxyChanged(() => {
    const port = getLocalAccountProxyPort();
    // Nothing may still be on its way to a port the proxy no longer holds.
    if (
      port === null ||
      (watchedLocalPort !== null && port !== watchedLocalPort)
    ) {
      cancelServedRequests();
    }
    watchedLocalPort = port;
    void publish().catch(() => undefined);
  });
}

/**
 * App start: publish the proxy's state as it changes, and start the proxy on
 * this device if it is the connection and set to start with the app.
 */
export async function initializeLocalAccountProxy(): Promise<void> {
  watchLocalRuntime();
  // Taken before any wait, so a stop made meanwhile cancels this start.
  const lifecycle = localLifecycle;
  // A proxy an earlier run left behind holds keys that died with that run.
  await clearLocalAccountProxyLeftovers().catch(() => undefined);
  const settings = await readSettings();
  const connection = settings.connection;
  // Earlier versions stored keys for the proxy on this device; launches no
  // longer read them.
  if (connection?.kind === 'local') {
    await deleteAccountProxyCredentials(connection.id).catch(() => undefined);
  }
  if (
    lifecycle === localLifecycle &&
    settings.optedIn &&
    connection?.kind === 'local' &&
    settings.startWithApp
  ) {
    // Kept when the flag is not available yet, such as LaunchDarkly not
    // answering at launch: the proxy starts once it is.
    localStartWanted = 'with-app';
    if (settings.available) {
      await startLocalConnection(connection, lifecycle).catch(() => undefined);
    }
  }
}

const SIGN_IN_POLL_MS = 2_000;
const SIGN_IN_TIMEOUT_MS = ACCOUNT_PROXY_SIGN_IN_TIMEOUT_MS;

interface PendingSignIn {
  readonly connectionId: string;
  readonly provider: AccountProxySignInProvider;
  readonly authIndex?: string;
  readonly state: string;
  readonly url: string;
  readonly startedAt: number;
  phase: AccountProxySignIn['phase'];
  message: string | null;
  /** The controlling computer whose browser this sign-in opened in. */
  readonly remote: AccountProxyRemoteSignInTarget | null;
  /** Set once that computer stops listening or its callback arrived. */
  remoteReleased: boolean;
  /** Set once that computer's callback went to the proxy. */
  callbackSent: boolean;
  unwatchRemote: (() => void) | null;
}

/** Stops the controlling computer's listener for `pending`, once. */
function releaseRemoteSignIn(
  pending: PendingSignIn,
  options: { readonly notify: boolean } = { notify: true },
): void {
  pending.unwatchRemote?.();
  pending.unwatchRemote = null;
  if (!pending.remote || pending.remoteReleased) return;
  pending.remoteReleased = true;
  if (options.notify) pending.remote.end(pending.state);
}

function failSignIn(pending: PendingSignIn, message: string): void {
  pending.phase = 'failed';
  pending.message = message;
  if (signIn === pending && signInTimer) {
    clearTimeout(signInTimer);
    signInTimer = null;
  }
  releaseRemoteSignIn(pending);
}

let signIn: PendingSignIn | null = null;
let signInTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The sign-in start in progress, until its page opens. Only one starts at a
 * time, and one cancelled or replaced meanwhile drops its result.
 */
let signInStarting: object | null = null;

function currentSignIn(settings: Settings): AccountProxySignIn | null {
  if (!signIn || settings.connection?.id !== signIn.connectionId) return null;
  return {
    provider: signIn.provider,
    authIndex: signIn.authIndex,
    phase: signIn.phase,
    message: signIn.message,
  };
}

/** Forget the sign-in waited on; a start in progress keeps going. */
function clearPendingSignIn(): void {
  if (signInTimer) clearTimeout(signInTimer);
  signInTimer = null;
  if (signIn) releaseRemoteSignIn(signIn);
  signIn = null;
}

/** Forget every sign-in, including one still starting. */
function endSignIn(): void {
  clearPendingSignIn();
  signInStarting = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The local proxy's address and key, while it runs, with the signal that
 * aborts when it stops serving that port.
 */
async function runningLocalTarget(): Promise<{
  readonly connection: AccountProxyConnection;
  readonly managementKey: AccountProxyManagementKey;
  readonly signal: AbortSignal;
}> {
  // Taken before any wait, so a stop meanwhile is seen after it.
  const signal = accountProxyServingSignal();
  const settings = await readSettings();
  const connection = settings.connection;
  if (!settings.available || connection?.kind !== 'local') {
    throw new Error(
      'Accounts can be added here only to the proxy on this device.',
    );
  }
  if (getLocalAccountProxyPort() === null) {
    throw new Error('Start the proxy on this device first.');
  }
  // The running launch's key; a launch that ended has none.
  const credentials = await loadConnectionKeys(connection);
  if (!credentials) throw new Error('Start the proxy on this device first.');
  // A key the proxy refused is not sent again; a restart makes new keys.
  if (keyRejected()) {
    throw new AccountProxyManagementError(
      'unauthorized',
      'The proxy on this device refused its key. Restart it.',
    );
  }
  // The key goes only to the proxy still serving the port it was read for.
  if (signal.aborted || !isLocalConnectionRunning(connection)) {
    throw new Error('Start the proxy on this device first.');
  }
  return { connection, managementKey: credentials.managementKey, signal };
}

/**
 * The provider page the proxy asked to open. Only an https page on the
 * provider's own sign-in host is opened, whatever the proxy answered.
 */
function signInUrl(
  provider: AccountProxySignInProvider,
  body: unknown,
): { readonly url: string; readonly state: string } {
  if (
    !isRecord(body) ||
    typeof body.url !== 'string' ||
    typeof body.state !== 'string' ||
    !ACCOUNT_PROXY_SIGN_IN_STATE_PATTERN.test(body.state)
  ) {
    throw new Error('The proxy did not return a sign-in page.');
  }
  const url = accountProxySignInPage(provider, body.url);
  if (url === null) {
    throw new Error(
      URL.canParse(body.url)
        ? 'The proxy returned an unexpected sign-in page.'
        : 'The proxy did not return a sign-in page.',
    );
  }
  return { url, state: body.state };
}

/**
 * Record that the proxy on this device refused the key a sign-in sent, as
 * other management calls do, so it is not sent again.
 */
async function recordSignInKeyRejection(
  connectionId: string,
  key: AccountProxyManagementKey,
  error: unknown,
): Promise<void> {
  if (!keyRejectionOf(error)) return;
  const previous = snapshot?.connectionId === connectionId ? snapshot : null;
  await recordKeyRejection(connectionId, key, error, {
    connectionId,
    version: previous?.version ?? null,
    accounts: previous?.accounts ?? [],
    usageInventory: previous?.usageInventory ?? [],
    routing: previous?.routing ?? null,
    refreshedAt: previous?.refreshedAt ?? null,
    error: errorOf(error),
  }).catch(() => undefined);
}

function scheduleSignInPoll(pending: PendingSignIn): void {
  signInTimer = setTimeout(() => {
    signInTimer = null;
    void pollSignIn(pending);
  }, SIGN_IN_POLL_MS);
}

async function pollSignIn(pending: PendingSignIn): Promise<void> {
  if (signIn !== pending || pending.phase !== 'waiting') return;
  if (Date.now() - pending.startedAt > SIGN_IN_TIMEOUT_MS) {
    failSignIn(pending, 'Sign-in timed out. Try again.');
    await publish();
    return;
  }
  let outcome:
    | { readonly kind: 'wait' }
    | { readonly kind: 'ok' }
    | { readonly kind: 'failed'; readonly message: string } = { kind: 'wait' };
  let sent: {
    readonly connectionId: string;
    readonly key: AccountProxyManagementKey;
  } | null = null;
  try {
    const { connection, managementKey, signal } = await runningLocalTarget();
    sent = { connectionId: connection.id, key: managementKey };
    if (connection.id !== pending.connectionId) return;
    const reply = await requestAccountProxyManagement({
      baseUrl: connection.url,
      managementKey,
      signal,
      method: 'GET',
      path: `/oauth/status?state=${encodeURIComponent(pending.state)}`,
    });
    const body = reply.body;
    if (isRecord(body) && body.status === 'ok') outcome = { kind: 'ok' };
    else if (isRecord(body) && body.status === 'error') {
      outcome = {
        kind: 'failed',
        message:
          typeof body.error === 'string' && body.error.trim()
            ? body.error.trim()
            : 'Sign-in failed.',
      };
    }
  } catch (error) {
    // A refused key ends the sign-in and is recorded like any other refusal;
    // other missed polls are retried until the timeout.
    if (keyRejectionOf(error)) {
      outcome = {
        kind: 'failed',
        message: 'The proxy on this device refused its key. Restart it.',
      };
      if (sent) {
        await recordSignInKeyRejection(sent.connectionId, sent.key, error);
      }
    }
  }
  if (signIn !== pending || pending.phase !== 'waiting') return;
  if (outcome.kind === 'wait') {
    scheduleSignInPoll(pending);
    return;
  }
  if (outcome.kind === 'ok') {
    clearPendingSignIn();
    // A refresh already running read the accounts before this one was
    // added; the list is read again once it settles.
    await refreshing?.catch(() => undefined);
    await getAccountProxyStatus({ refresh: true }).catch(() => undefined);
  } else {
    failSignIn(pending, outcome.message);
  }
  await publish();
}

/**
 * Sign an account in through the proxy on this device. `start` opens the
 * provider's page in the browser and waits for the proxy to finish;
 * `reopen` opens it again; `cancel` stops waiting and tells the proxy. From
 * a controlling computer's window (`remote`), the page opens in that
 * computer's browser, which sends the redirect back here.
 */
export async function signInLocalAccountProxyAccount(
  request: AccountProxySignInRequest,
  remote: AccountProxyRemoteSignInTarget | null = null,
): Promise<AccountProxyStatus> {
  if (request.action === 'reopen') {
    const pending = signIn;
    if (pending?.phase === 'waiting') await openSignInPage(pending);
    return publish();
  }
  if (request.action === 'cancel') {
    const pending = signIn;
    endSignIn();
    if (pending) {
      await runningLocalTarget()
        .then(({ connection, managementKey, signal }) =>
          requestAccountProxyManagement({
            baseUrl: connection.url,
            managementKey,
            signal,
            method: 'DELETE',
            path: `/oauth/session?state=${encodeURIComponent(pending.state)}`,
          }),
        )
        .catch(() => undefined);
    }
    return publish();
  }
  if (signInStarting) throw new Error('A sign-in is already starting.');
  const attempt = {};
  signInStarting = attempt;
  let page: { readonly url: string; readonly state: string };
  let connection: AccountProxyConnection;
  let target: Awaited<ReturnType<typeof runningLocalTarget>>;
  try {
    target = await runningLocalTarget();
    connection = target.connection;
    if (signIn && signInStarting === attempt) {
      // The sign-in this one replaces; its own start stays reserved.
      const replaced = signIn;
      endSignIn();
      signInStarting = attempt;
      await requestAccountProxyManagement({
        baseUrl: connection.url,
        managementKey: target.managementKey,
        signal: target.signal,
        method: 'DELETE',
        path: `/oauth/session?state=${encodeURIComponent(replaced.state)}`,
      }).catch(() => undefined);
    }
    const reply = await requestAccountProxyManagement({
      baseUrl: connection.url,
      managementKey: target.managementKey,
      signal: target.signal,
      method: 'GET',
      // Without `is_webui` the proxy binds no callback port here; the
      // controlling computer catches the redirect and relays it.
      // `auth_index` re-signs that credential; the proxy refuses another account.
      path: `/oauth/auth-url?provider=${request.provider}${
        remote ? '' : '&is_webui=true'
      }${
        request.authIndex
          ? `&auth_index=${encodeURIComponent(request.authIndex)}`
          : ''
      }`,
    }).catch(async (error: unknown) => {
      await recordSignInKeyRejection(
        connection.id,
        target.managementKey,
        error,
      );
      throw error;
    });
    page = signInUrl(request.provider, reply.body);
    if (signInStarting !== attempt) {
      // Cancelled, stopped, or disconnected while the proxy answered: the
      // session it opened is closed and nothing is shown.
      await requestAccountProxyManagement({
        baseUrl: connection.url,
        managementKey: target.managementKey,
        signal: target.signal,
        method: 'DELETE',
        path: `/oauth/session?state=${encodeURIComponent(page.state)}`,
      }).catch(() => undefined);
      throw new Error('The sign-in was cancelled.');
    }
  } finally {
    if (signInStarting === attempt) signInStarting = null;
  }
  const pending: PendingSignIn = {
    connectionId: connection.id,
    provider: request.provider,
    authIndex: request.authIndex,
    state: page.state,
    url: page.url,
    startedAt: Date.now(),
    phase: 'waiting',
    message: null,
    remote,
    remoteReleased: false,
    callbackSent: false,
    unwatchRemote: null,
  };
  signIn = pending;
  scheduleSignInPoll(pending);
  try {
    await openSignInPage(pending);
  } catch (error) {
    if (!pending.remote) throw error;
    // Nothing can catch the browser's redirect, so the proxy stops waiting.
    if (signIn === pending) clearPendingSignIn();
    await requestAccountProxyManagement({
      baseUrl: connection.url,
      managementKey: target.managementKey,
      signal: target.signal,
      method: 'DELETE',
      path: `/oauth/session?state=${encodeURIComponent(pending.state)}`,
    }).catch(() => undefined);
    await publish();
    throw error;
  }
  return publish();
}

/**
 * Opens the provider page in this computer's browser, or in the controlling
 * computer's when the sign-in started from its window.
 */
async function openSignInPage(pending: PendingSignIn): Promise<void> {
  const remote = pending.remote;
  if (!remote) {
    await openExternalGuarded(pending.url);
    return;
  }
  if (pending.callbackSent) return;
  pending.remoteReleased = false;
  await remote.open({
    provider: pending.provider,
    url: pending.url,
    state: pending.state,
  });
  if (signIn !== pending || pending.phase !== 'waiting') {
    // The release that ended it reached that computer before it listened.
    pending.unwatchRemote?.();
    pending.unwatchRemote = null;
    pending.remoteReleased = true;
    remote.end(pending.state);
    return;
  }
  pending.unwatchRemote ??= remote.onClosed(() => {
    pending.unwatchRemote = null;
    if (signIn !== pending || pending.phase !== 'waiting') return;
    pending.remoteReleased = true;
    failSignIn(
      pending,
      'The computers disconnected before the sign-in finished. Try again.',
    );
    void publish().catch(() => undefined);
  });
}

/**
 * The browser's redirect for a sign-in started from `controllerDeviceId`'s
 * window, caught on that computer. Accepted only for the sign-in waiting on
 * that computer with the same state, once; the proxy then finishes it and
 * the status poll reports how.
 */
export async function completeRemoteAccountProxySignIn(
  controllerDeviceId: string,
  callback: AccountProxySignInCallback,
): Promise<void> {
  const pending = signIn;
  if (
    !pending ||
    pending.phase !== 'waiting' ||
    pending.remote?.controllerDeviceId !== controllerDeviceId ||
    pending.callbackSent ||
    !sameAccountProxySignInState(pending.state, callback.state)
  ) {
    throw new Error('This sign-in is no longer waiting. Start it again.');
  }
  if (callback.code === null && callback.error === null) {
    throw new Error('The browser did not finish the sign-in.');
  }
  // The controlling computer already stopped listening after sending it.
  pending.callbackSent = true;
  releaseRemoteSignIn(pending, { notify: false });
  let sent: {
    readonly connectionId: string;
    readonly key: AccountProxyManagementKey;
  } | null = null;
  try {
    const { connection, managementKey, signal } = await runningLocalTarget();
    if (connection.id !== pending.connectionId || signIn !== pending) {
      throw new Error('The sign-in was cancelled.');
    }
    sent = { connectionId: connection.id, key: managementKey };
    await requestAccountProxyManagement({
      baseUrl: connection.url,
      managementKey,
      signal,
      method: 'POST',
      path: '/oauth/callback',
      body: {
        state: pending.state,
        ...(callback.code !== null ? { code: callback.code } : {}),
        ...(callback.error !== null ? { error: callback.error } : {}),
      },
    });
  } catch (error) {
    if (sent)
      await recordSignInKeyRejection(sent.connectionId, sent.key, error);
    if (signIn === pending && pending.phase === 'waiting') {
      failSignIn(pending, 'The proxy did not accept the sign-in. Try again.');
      await publish();
    }
    throw new Error('The proxy did not accept the sign-in.');
  }
}

export function resetAccountProxyServiceForTests(): void {
  endSignIn();
  localListener?.();
  localListener = null;
  watchedLocalPort = null;
  snapshot = null;
  usageInventoryGeneration = -1;
  usageInventoryListeners.clear();
  refreshing = null;
  generation = 0;
  refreshAttemptAt = null;
  refreshFailures = 0;
  connectAttempt = 0;
  persistence = Promise.resolve();
  rejectedAt = 0;
  generationAbort = new AbortController();
  lastRouteRefreshAt = 0;
  routeRefresh = null;
  suspectClientKeys.clear();
  clientKeyRepairs.clear();
  clientKeyCheckFailedAt.clear();
  openServerCheckedAt.clear();
  lastSettings = null;
  localStartWanted = null;
  localAutoStart = null;
  localReconcile = Promise.resolve();
}
