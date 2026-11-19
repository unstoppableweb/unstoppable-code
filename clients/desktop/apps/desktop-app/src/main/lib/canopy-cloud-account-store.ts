import {
  normalizeOrganizationAccessLossState,
  prepareOrganizationAccessLossState,
  type OrganizationAccessLossRecord,
  type OrganizationAccessLossWorkspace,
  type OrganizationAccessLossState,
} from './organization-access-loss-record';
import type { CanopyAccountResponse } from '@canopy/protocol/canopy-server';
import { normalizePersonalOrganizationId } from '@canopy/protocol/workspace-context';
import { normalizeMemorySearchOrganizationExternalIds } from '@canopy/desktop-shared/lib/org-memory';
import { BRAND } from '@canopy/brand/current';
import type {
  CanopyOrgBillingState,
  CanopyOrgEnforcedSettings,
} from '@canopy/protocol/canopy-server';
import {
  normalizeOrgEnforcedSettingsWithStatus,
  personalGatewayAccountFields,
} from '@canopy/desktop-shared/lib/org-enforced-parsing';
import {
  cloneOrgBillingStates,
  normalizeOrgBillingStates,
} from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  isCanopyCloudSessionExpired,
  isCanopyCloudSessionProbeSuperseded,
  isCurrentCanopyCloudSessionProbe,
  recordCanopyCloudSessionProbe,
  resetCanopyCloudSessionCredential,
  type CanopyCloudSessionProbe,
} from '../canopy-cloud/session-status';
import type {
  CanopyCloudAccountPublicState,
  CanopyCloudAccountReadStatus,
  CanopyCloudAuthMode,
  CanopyCloudCredentialSource,
  CanopyOrganizationSummary,
  ResetUnreadableCanopyCloudAccountResult,
  CanopyServerAccountInfo,
  CanopyTeamSummary,
  SecureStorageFailure,
} from '@canopy/desktop-shared/types';
import {
  CanopyCloudConfigError,
  getCanopyCloudBaseUrl,
} from '../canopy-cloud/config';
import {
  normalizeCanopyOrganizationSummaries,
  normalizeCanopyOrganizationSummary,
} from '../canopy-cloud/organization-summary';
import {
  CloudAccountOperationQueue,
  CloudAccountPublisher,
  CloudAccountReadCache,
} from '@canopy/core-runtime/node/cloud-account';
import {
  assertCanopyCloudStorageWritable,
  createCanopyCloudCredentialPort,
} from './canopy-cloud-credential-port';

const CLOUD_DISPLAY_NAME = `${BRAND.displayName} Cloud`;

export { CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR } from './canopy-cloud-credential-port';

export interface CanopyCloudAccountEntry {
  /** Recoverable handoff; private to main, never projected to clients. */
  organizationAccessLossState?: OrganizationAccessLossState;
  apiKey: string;
  authMode?: CanopyCloudAuthMode;
  credentialSource?: CanopyCloudCredentialSource;
  serverApiKeyId?: string;
  capabilities: string[];
  /** @deprecated Read `memorySearchOrganizationExternalIds` (CAN-3457). */
  memorySearchOrganizationExternalId?: string;
  /**
   * Every org eligible for organization-memory search (lowercase UUIDs).
   * Absent ⇒ none.
   */
  memorySearchOrganizationExternalIds?: string[];
  account?: CanopyServerAccountInfo;
  /** External ID for resource authorization; excluded from the switcher. */
  personalOrganizationId?: string;
  personalModelGateway?: CanopyAccountResponse['personalModelGateway'];
  personalModelGatewayEnforcementUnavailable?: boolean;
  organizations?: CanopyOrganizationSummary[];
  teams?: CanopyTeamSummary[];
  enforcedSettings?: CanopyOrgEnforcedSettings[];
  telemetryEnforcementUnavailable?: boolean;
  modelGatewayEnforcementUnavailable?: boolean;
  /** Per-org billing state (CAN-2311). Absent ⇒ nothing known ⇒ nothing lapsed. */
  orgBillingStates?: CanopyOrgBillingState[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Whether replacing `previous` with `next` crosses the decrypted-replica trust
 * boundary. A server account id is the stable identity; legacy entries without
 * one fall back to the credential so an ambiguous replacement fails closed.
 * A missing previous account also requires the transition so first sign-in
 * removes any orphaned replicas left by an interrupted older client.
 */
export function hasCanopyCloudIdentityChanged(
  previous: CanopyCloudAccountEntry | null,
  next: CanopyCloudAccountEntry,
): boolean {
  if (!previous) return true;
  const previousAccountId = previous.account?.id.trim();
  const nextAccountId = next.account?.id.trim();
  if (previousAccountId && nextAccountId) {
    return previousAccountId !== nextAccountId;
  }
  return previous.apiKey !== next.apiKey;
}

export type CanopyCloudAccountTransition<T> = (
  persist: () => Promise<T>,
) => Promise<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function normalizeAuthMode(value: unknown): CanopyCloudAuthMode {
  return value === 'oauth' || value === 'api_key' || value === 'guest'
    ? value
    : 'api_key';
}

function normalizeCredentialSource(
  value: unknown,
): CanopyCloudCredentialSource {
  return value === 'oauth_desktop' || value === 'manual' || value === 'guest'
    ? value
    : 'manual';
}

function normalizeTeam(value: unknown): CanopyTeamSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const organization = normalizeCanopyOrganizationSummary(value.organization);
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !organization ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    organization,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeTeams(value: unknown): CanopyTeamSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeTeam)
    .filter((entry): entry is CanopyTeamSummary => entry !== null);
}

function cloneEnforcedSettings(
  value: CanopyOrgEnforcedSettings[] | undefined,
): CanopyOrgEnforcedSettings[] {
  return (value ?? []).map((entry) => ({
    organizationId: entry.organizationId,
    organizationName: entry.organizationName,
    ...(entry.modelGatewayEnforcementUnavailable
      ? { modelGatewayEnforcementUnavailable: true as const }
      : {}),
    policies: entry.policies.map((policy) => {
      switch (policy.kind) {
        case 'telemetry-sync':
          return {
            ...policy,
            scopes: { ...policy.scopes },
            ...(policy.prohibitedScopes
              ? { prohibitedScopes: { ...policy.prohibitedScopes } }
              : {}),
          };
        case 'model-policy':
          return {
            ...policy,
            blockedModelIds: [...policy.blockedModelIds],
            reviewedModelIds: [...policy.reviewedModelIds],
          };
        case 'model-gateway':
          return {
            ...policy,
            models: policy.models.map((model) => ({
              ...model,
              supportedThinkingLevels: [...model.supportedThinkingLevels],
            })),
          };
        case 'usage-data':
          return { ...policy, prohibited: { ...policy.prohibited } };
      }
    }),
  }));
}

function normalizeCanopyCloudAccountInfo(
  value: unknown,
): CanopyServerAccountInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.email !== 'string'
  ) {
    return undefined;
  }

  if (
    value.role !== 'VIEWER' &&
    value.role !== 'DEVELOPER' &&
    value.role !== 'ADMIN'
  ) {
    return undefined;
  }

  return {
    id: value.id,
    name: value.name,
    email: value.email,
    role: value.role,
    ...(typeof value.image === 'string' && value.image.trim().length > 0
      ? { image: value.image }
      : {}),
  };
}

function normalizeStoredAccountEntry(
  value: unknown,
): CanopyCloudAccountEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const {
    apiKey,
    authMode,
    credentialSource,
    serverApiKeyId,
    capabilities,
    personalOrganizationId,
    memorySearchOrganizationExternalId,
    memorySearchOrganizationExternalIds,
    account,
    organizations,
    teams,
    enforcedSettings,
    telemetryEnforcementUnavailable,
    modelGatewayEnforcementUnavailable,
    orgBillingStates,
    createdAt,
    updatedAt,
  } = value;
  if (
    typeof apiKey !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return null;
  }

  const normalizedPersonalOrganizationId = normalizePersonalOrganizationId(
    personalOrganizationId,
  );
  const normalizedAccount = normalizeCanopyCloudAccountInfo(account);
  const normalizedCredentialSource =
    normalizeCredentialSource(credentialSource);
  const normalizedAuthMode =
    normalizedCredentialSource === 'oauth_desktop'
      ? 'oauth'
      : normalizeAuthMode(authMode);
  const normalizedEnforcement =
    normalizeOrgEnforcedSettingsWithStatus(enforcedSettings);
  // An entry cached before CAN-3457 has only the single-org field; the
  // normalizer reads it as a one-entry list.
  const normalizedMemoryOrganizations =
    normalizeMemorySearchOrganizationExternalIds(
      memorySearchOrganizationExternalIds,
      memorySearchOrganizationExternalId,
    );
  return {
    apiKey,
    organizationAccessLossState: normalizeOrganizationAccessLossState(
      value.organizationAccessLossState,
      normalizedAccount?.id,
    ),
    authMode: normalizedAuthMode,
    credentialSource: normalizedCredentialSource,
    ...(typeof serverApiKeyId === 'string' && serverApiKeyId.trim().length > 0
      ? { serverApiKeyId: serverApiKeyId.trim() }
      : {}),
    capabilities: normalizeStringArray(capabilities),
    ...personalGatewayAccountFields(value),
    ...(value.personalModelGatewayEnforcementUnavailable === true
      ? { personalModelGatewayEnforcementUnavailable: true }
      : {}),
    ...(normalizedPersonalOrganizationId
      ? { personalOrganizationId: normalizedPersonalOrganizationId }
      : {}),
    ...(typeof memorySearchOrganizationExternalId === 'string' &&
    memorySearchOrganizationExternalId.trim().length > 0
      ? {
          memorySearchOrganizationExternalId:
            memorySearchOrganizationExternalId.trim(),
        }
      : {}),
    ...(normalizedMemoryOrganizations.length > 0
      ? { memorySearchOrganizationExternalIds: normalizedMemoryOrganizations }
      : {}),
    ...(normalizedAccount ? { account: normalizedAccount } : {}),
    organizations: normalizeCanopyOrganizationSummaries(organizations),
    teams: normalizeTeams(teams),
    enforcedSettings: normalizedEnforcement.settings,
    ...(normalizedEnforcement.telemetryEnforcementUnavailable === true ||
    telemetryEnforcementUnavailable === true
      ? { telemetryEnforcementUnavailable: true }
      : {}),
    ...(modelGatewayEnforcementUnavailable === true ||
    normalizedEnforcement.modelGatewayEnforcementUnavailable
      ? { modelGatewayEnforcementUnavailable: true }
      : {}),
    orgBillingStates: normalizeOrgBillingStates(orgBillingStates),
    createdAt,
    updatedAt,
  };
}

function cloneEntry(
  entry: CanopyCloudAccountEntry | null,
): CanopyCloudAccountEntry | null {
  return entry ? cloneStoredEntry(entry) : null;
}

function cloneStoredEntry(
  entry: CanopyCloudAccountEntry,
): CanopyCloudAccountEntry {
  return {
    ...entry,
    organizationAccessLossState: entry.organizationAccessLossState
      ? structuredClone(entry.organizationAccessLossState)
      : undefined,
    authMode: entry.authMode ?? 'api_key',
    credentialSource: entry.credentialSource ?? 'manual',
    ...(entry.serverApiKeyId ? { serverApiKeyId: entry.serverApiKeyId } : {}),
    capabilities: [...entry.capabilities],
    ...(entry.memorySearchOrganizationExternalId
      ? {
          memorySearchOrganizationExternalId:
            entry.memorySearchOrganizationExternalId,
        }
      : {}),
    ...(entry.memorySearchOrganizationExternalIds
      ? {
          memorySearchOrganizationExternalIds: [
            ...entry.memorySearchOrganizationExternalIds,
          ],
        }
      : {}),
    ...(entry.account ? { account: { ...entry.account } } : {}),
    organizations: (entry.organizations ?? []).map((organization) => ({
      ...organization,
    })),
    teams: (entry.teams ?? []).map((team) => ({
      ...team,
      organization: { ...team.organization },
    })),
    ...personalGatewayAccountFields(entry),
    enforcedSettings: cloneEnforcedSettings(entry.enforcedSettings),
    orgBillingStates: cloneOrgBillingStates(entry.orgBillingStates),
  };
}

const credentialPort = createCanopyCloudCredentialPort(
  normalizeStoredAccountEntry,
);
const accountCache = new CloudAccountReadCache(cloneStoredEntry);
const accountOperations = new CloudAccountOperationQueue();
const accountPublisher = new CloudAccountPublisher(cloneStoredEntry);

/** Last account snapshot already loaded by the main process; never performs IO. */
export function peekCanopyCloudAccount(): CanopyCloudAccountEntry | null {
  return accountCache.peek();
}

/**
 * The cached account's id without cloning: `null` when signed out (or the
 * entry has no id), `undefined` when main holds no snapshot yet.
 */
export function peekCanopyCloudAccountId(): string | null | undefined {
  const held = accountCache.peekHeld();
  if (held === undefined) return undefined;
  return held?.account?.id ?? null;
}

function writeCache(
  entry: CanopyCloudAccountEntry | null,
  backend = credentialPort.backendKey(),
): void {
  accountCache.set(entry, backend);
}

function notifyAccountChange(entry: CanopyCloudAccountEntry | null): void {
  accountPublisher.notify(entry);
}

function notifyAccountChangeOrThrow(
  entry: CanopyCloudAccountEntry | null,
): void {
  accountPublisher.notifyOrThrow(entry);
}

export function subscribeCanopyCloudAccountChanges(
  listener: (entry: CanopyCloudAccountEntry | null) => void,
): () => void {
  return accountPublisher.addChangeListener(listener);
}

/**
 * Follows refreshes that confirm the stored account without changing it, which
 * do not notify account changes. Use it for work that should retry whenever
 * the server is reachable again (outbox flushes, targeting probes), not for
 * reacting to account state.
 */
export function subscribeCanopyCloudAccountConfirmations(
  listener: () => void,
): () => void {
  return accountPublisher.addConfirmationListener(listener);
}

function notifyAccountConfirmation(): void {
  accountPublisher.notifyConfirmation();
}

export function isCanopyCloudStorageAvailable(): boolean {
  return credentialPort.isWritable();
}

export function assertCanopyCloudStorageAvailable(): void {
  assertCanopyCloudStorageWritable();
}

export type CanopyCloudAccountReadResult =
  | {
      status: 'ok';
      entry: CanopyCloudAccountEntry | null;
      migrationWriteFailure?: SecureStorageFailure;
    }
  | {
      status: 'unavailable';
      error: unknown;
      secureStorageFailure: SecureStorageFailure;
    }
  | {
      status: 'error';
      error: unknown;
      secureStorageFailure?: SecureStorageFailure;
    };

export async function readCanopyCloudAccountWithStatus(
  options: { cache?: boolean } = {},
): Promise<CanopyCloudAccountReadResult> {
  const result = await credentialPort.read(
    options.cache !== false ? accountCache : undefined,
  );
  switch (result.status) {
    case 'ok':
      return {
        status: 'ok',
        entry: cloneEntry(result.record),
        ...(result.migrationWriteFailure
          ? { migrationWriteFailure: result.migrationWriteFailure }
          : {}),
      };
    case 'unavailable':
      return {
        status: 'unavailable',
        error: result.error,
        secureStorageFailure: result.failure,
      };
    case 'error':
      return {
        status: 'error',
        error: result.error,
        ...(result.failure ? { secureStorageFailure: result.failure } : {}),
      };
  }
}

/**
 * Whether THIS call's read failed rather than finding no account.
 *
 * {@link loadCanopyCloudAccount} collapses `unavailable` and `error` into
 * `null`, which every caller then reads as a confirmed sign-out. Billing lane
 * resolution must not treat a keychain lock or a decrypt blip as a CONFIRMED
 * dead credits lane, so it needs the distinction back.
 *
 * Deliberately NOT a "was the last read degraded?" process global. A dozen
 * unrelated main-process subsystems call `loadCanopyCloudAccount()` (org
 * billing, telemetry enforcement, portal sessions, feature-flag targeting, …),
 * so such a flag is rewritten by whichever of them ran most recently and
 * cannot be paired reliably with any particular value.
 *
 * A caller that needs the distinction must read this IMMEDIATELY after its own
 * `loadCanopyCloudAccount()` call and return it ALONGSIDE the value it derived,
 * so consumers receive both in one operation — see
 * `getAiCreditsRoutingContextWithStatus()`, which is the only such caller.
 * Exposing a second long-lived flag for consumers to read later would
 * reintroduce exactly the race this shape avoids.
 */
let lastAccountReadDegraded = false;

export function isCanopyCloudAccountReadDegraded(): boolean {
  return lastAccountReadDegraded;
}

export async function loadCanopyCloudAccount(): Promise<CanopyCloudAccountEntry | null> {
  const result = await readCanopyCloudAccountWithStatus();
  // `ok` with no entry is a real sign-out and must CLEAR this, so a recovered
  // read does not leave a consumer permanently at "unknown".
  lastAccountReadDegraded = result.status !== 'ok';
  return result.status === 'ok' ? result.entry : null;
}

/**
 * Status-preserving counterpart to {@link loadCanopyCloudAccount} for the
 * renderer bridge.
 *
 * {@link loadCanopyCloudAccount} collapses `unavailable` and `error` reads into
 * a `null` entry, which is then indistinguishable from a real sign-out. Renderer
 * surfaces that hold last-known-good account state need that distinction, so
 * this variant carries the read status through to
 * {@link CanopyCloudAccountPublicState.read}.
 */
export async function loadCanopyCloudAccountPublicState(): Promise<CanopyCloudAccountPublicState> {
  const result = await readCanopyCloudAccountWithStatus();
  return result.status === 'ok'
    ? toPublicCanopyCloudAccountState(
        result.entry,
        'ok',
        result.migrationWriteFailure,
      )
    : toPublicCanopyCloudAccountState(
        null,
        result.status,
        result.secureStorageFailure,
      );
}

async function persistCanopyCloudAccount(
  entry: CanopyCloudAccountEntry,
  {
    notify = true,
    confirm = true,
    replaceCredential = false,
  }: {
    notify?: boolean;
    confirm?: boolean;
    replaceCredential?: boolean;
  } = {},
): Promise<CanopyCloudAccountEntry> {
  assertCanopyCloudStorageAvailable();

  const normalized = normalizeStoredAccountEntry(entry);
  if (!normalized) {
    throw new Error(`Invalid ${CLOUD_DISPLAY_NAME} account entry.`);
  }

  const backend = await credentialPort.write(normalized);
  writeCache(normalized, backend);
  if (replaceCredential) resetCanopyCloudSessionCredential();
  const persisted = cloneEntry(normalized);
  if (!persisted) {
    throw new Error(`Invalid ${CLOUD_DISPLAY_NAME} account entry.`);
  }
  if (notify) notifyAccountChange(persisted);
  else if (confirm) notifyAccountConfirmation();
  return persisted;
}

async function withAccountSaveLock<T>(operation: () => Promise<T>): Promise<T> {
  return accountOperations.run(operation);
}

async function loadCanopyCloudAccountForGuard(): Promise<CanopyCloudAccountEntry | null> {
  const result = await readCanopyCloudAccountWithStatus();
  if (result.status === 'unavailable') {
    throw result.error;
  }
  if (result.status === 'error') {
    throw result.error;
  }
  return result.entry;
}

/** Record only definitive results about the credential still stored now. */
export async function applyCanopyCloudSessionProbeResult(
  expected: CanopyCloudAccountEntry,
  probe: CanopyCloudSessionProbe,
  outcome: 'accepted' | 'rejected',
): Promise<void> {
  await withAccountSaveLock(async (): Promise<void> => {
    if (!isCurrentCanopyCloudSessionProbe(probe)) return;
    const read = await readCanopyCloudAccountWithStatus();
    if (read.status !== 'ok') return;
    const current = read.entry;
    if (!current || !matchesExpectedAccountTransition(current, expected))
      return;
    recordCanopyCloudSessionProbe(probe, current, outcome);
  });
}

function matchesExpectedAccountTransition(
  current: CanopyCloudAccountEntry | null,
  expected: CanopyCloudAccountEntry | null,
): boolean {
  if (current === null || expected === null) return current === expected;
  return (
    current.apiKey === expected.apiKey &&
    current.authMode === expected.authMode &&
    current.credentialSource === expected.credentialSource &&
    current.serverApiKeyId === expected.serverApiKeyId &&
    current.createdAt === expected.createdAt &&
    current.updatedAt === expected.updatedAt
  );
}

export async function saveCanopyCloudAccount(
  entry: CanopyCloudAccountEntry,
  withIdentityTransition?: CanopyCloudAccountTransition<CanopyCloudAccountEntry>,
  withSameIdentityTransition?: CanopyCloudAccountTransition<CanopyCloudAccountEntry>,
): Promise<CanopyCloudAccountEntry> {
  return withAccountSaveLock(async () => {
    // Guest minting performs network I/O before it reaches this queue. A real
    // sign-in can therefore finish while the mint request is still pending.
    // Re-check inside the serialized persistence boundary so that delayed
    // guest responses can never downgrade a newer real credential.
    const currentAccount =
      isGuestAccount(entry) ||
      withIdentityTransition ||
      withSameIdentityTransition
        ? await loadCanopyCloudAccountForGuard()
        : null;
    if (isGuestAccount(entry)) {
      if (currentAccount && !isGuestAccount(currentAccount)) {
        return currentAccount;
      }
    }
    const persist = (): Promise<CanopyCloudAccountEntry> =>
      persistCanopyCloudAccount(
        {
          ...entry,
          // OAuth renews credentials without ending this account's recovery.
          // Only the authoritative refresh hook initiates loss processing.
          ...(currentAccount
            ? {
                organizationAccessLossState: prepareOrganizationAccessLossState(
                  currentAccount,
                  entry,
                  entry.authMode === 'oauth',
                  { recordLosses: false },
                ),
              }
            : {}),
        },
        { replaceCredential: true },
      );
    if (hasCanopyCloudIdentityChanged(currentAccount, entry)) {
      return withIdentityTransition
        ? withIdentityTransition(persist)
        : persist();
    }
    return withSameIdentityTransition
      ? withSameIdentityTransition(persist)
      : persist();
  });
}

/**
 * Whether two entries differ in anything other than their save time. The
 * comparison is conservative: a normalizer that keeps a source key order, or
 * an entry that fails normalization, reads as a difference, which only costs
 * an extra notification.
 */
function differsBeyondUpdatedAt(
  entry: CanopyCloudAccountEntry,
  previous: CanopyCloudAccountEntry | null,
): boolean {
  if (!previous) return true;
  const comparable = (value: CanopyCloudAccountEntry): string | null => {
    const normalized = normalizeStoredAccountEntry({
      ...value,
      updatedAt: '',
      organizationAccessLossState: undefined,
    });
    return normalized ? JSON.stringify(normalized) : null;
  };
  const next = comparable(entry);
  return next === null || next !== comparable(previous);
}

/**
 * Persist a refreshed snapshot only while the account that initiated its
 * network request is still current. The optional transition runs inside the
 * account-operation queue, so authorization cleanup and persistence are one
 * serialized boundary relative to disconnects and account replacement.
 *
 * A refresh that only moves `updatedAt` is still saved but notifies
 * confirmation subscribers instead of account-change subscribers: routine
 * re-probes (window focus, the periodic timer) would otherwise re-run every
 * account-change reaction.
 */
export async function saveCanopyCloudAccountIfUnchanged(
  entry: CanopyCloudAccountEntry,
  expectedAccount: CanopyCloudAccountEntry,
  withMatchedTransition?: CanopyCloudAccountTransition<CanopyCloudAccountEntry>,
  sessionProbe?: CanopyCloudSessionProbe,
  organizationsRefreshed = false,
): Promise<
  | { status: 'saved'; entry: CanopyCloudAccountEntry }
  | { status: 'superseded'; account: CanopyCloudAccountEntry | null }
> {
  return withAccountSaveLock(async () => {
    const currentAccount = await loadCanopyCloudAccountForGuard();
    if (
      (sessionProbe && isCanopyCloudSessionProbeSuperseded(sessionProbe)) ||
      !matchesExpectedAccountTransition(currentAccount, expectedAccount)
    ) {
      return { status: 'superseded', account: currentAccount };
    }
    entry = {
      ...entry,
      organizationAccessLossState: prepareOrganizationAccessLossState(
        currentAccount ?? expectedAccount,
        entry,
        organizationsRefreshed,
      ),
    };
    const notify = differsBeyondUpdatedAt(entry, currentAccount);
    const persist = (): Promise<CanopyCloudAccountEntry> =>
      persistCanopyCloudAccount(entry, { notify });
    return {
      status: 'saved',
      entry: withMatchedTransition
        ? await withMatchedTransition(persist)
        : await persist(),
    };
  });
}

/**
 * Persist a manual credential only if it cannot overwrite a guest identity.
 * All persistence operations share the same bounded queue. If the guest save
 * reaches it first, this guard preserves that identity; if the manual save
 * reaches it first, the guest-save guard above prevents a later downgrade.
 */
export async function saveManualCanopyCloudAccount(
  entry: CanopyCloudAccountEntry,
  expectedPreviousAccount: CanopyCloudAccountEntry | null,
  withIdentityTransition?: CanopyCloudAccountTransition<CanopyCloudAccountEntry>,
  withSameIdentityTransition?: CanopyCloudAccountTransition<CanopyCloudAccountEntry>,
): Promise<
  | {
      status: 'saved';
      entry: CanopyCloudAccountEntry;
      previousAccount: CanopyCloudAccountEntry | null;
    }
  | { status: 'guest-protected'; account: CanopyCloudAccountEntry }
  | { status: 'superseded'; account: CanopyCloudAccountEntry | null }
> {
  return withAccountSaveLock(async () => {
    const previousAccount = await loadCanopyCloudAccountForGuard();
    if (previousAccount && isGuestAccount(previousAccount)) {
      return { status: 'guest-protected', account: previousAccount };
    }
    if (
      !matchesExpectedAccountTransition(
        previousAccount,
        expectedPreviousAccount,
      )
    ) {
      return { status: 'superseded', account: previousAccount };
    }
    const persist = (): Promise<CanopyCloudAccountEntry> =>
      persistCanopyCloudAccount(
        { ...entry, organizationAccessLossState: undefined },
        { replaceCredential: true },
      );
    const identityChanged = hasCanopyCloudIdentityChanged(
      previousAccount,
      entry,
    );
    return {
      status: 'saved',
      entry: identityChanged
        ? withIdentityTransition
          ? await withIdentityTransition(persist)
          : await persist()
        : withSameIdentityTransition
          ? await withSameIdentityTransition(persist)
          : await persist(),
      previousAccount,
    };
  });
}

/**
 * Holds the account transition fence across a queued ownership mutation or its
 * recovery effects. Refresh, disconnect and credential replacement cannot race
 * the check. No account lock is acquired by the workspace writer.
 */
export async function withOrganizationAccessLoss<T>(
  record: OrganizationAccessLossRecord,
  operation: (context: {
    membershipLost: boolean;
    record: OrganizationAccessLossRecord;
    checkpoint(workspaces: OrganizationAccessLossWorkspace[]): Promise<void>;
  }) => Promise<T>,
): Promise<T | undefined> {
  return withAccountSaveLock(async () => {
    const entry = await loadCanopyCloudAccountForGuard();
    const state = entry?.organizationAccessLossState;
    if (
      !entry?.apiKey.trim() ||
      entry.account?.id.trim() !== record.accountId ||
      !state?.pending.some(
        (held) =>
          held.organizationId === record.organizationId &&
          held.detachedAt === record.detachedAt,
      )
    )
      return undefined;
    const held = state.pending.find(
      (item) =>
        item.organizationId === record.organizationId &&
        item.detachedAt === record.detachedAt,
    );
    if (!held) return undefined;
    return operation({
      membershipLost: !state.organizationIds.includes(record.organizationId),
      record: held,
      checkpoint: async (workspaces): Promise<void> => {
        const replacement = { ...held, workspaces };
        const nextState = {
          ...state,
          pending: state.pending.map((item) =>
            item === held ? replacement : item,
          ),
        };
        await persistCanopyCloudAccount(
          { ...entry, organizationAccessLossState: nextState },
          { notify: false, confirm: false },
        );
        // A callback may checkpoint both its captured binding and completion.
        held.workspaces = workspaces;
      },
    });
  });
}

/** Acknowledge only this durable handoff; never replace a newer refresh. */
export async function completeOrganizationAccessLoss(
  record: OrganizationAccessLossRecord,
): Promise<void> {
  await withAccountSaveLock(async () => {
    const entry = await loadCanopyCloudAccountForGuard();
    const state = entry?.organizationAccessLossState;
    if (!entry || entry.account?.id.trim() !== record.accountId || !state)
      return;
    const pending = state.pending.filter(
      (held) =>
        held.organizationId !== record.organizationId ||
        held.detachedAt !== record.detachedAt,
    );
    if (pending.length === state.pending.length) return;
    await persistCanopyCloudAccount(
      { ...entry, organizationAccessLossState: { ...state, pending } },
      { notify: false, confirm: false },
    );
  });
}

export async function mergeCanopyCloudAccountCapabilities(
  capabilities: readonly string[],
  expectedApiKey: string,
): Promise<CanopyCloudAccountEntry | null> {
  return withAccountSaveLock(async () => {
    const entry = await loadCanopyCloudAccountForGuard();
    if (!entry || entry.apiKey !== expectedApiKey) {
      return entry;
    }

    const nextCapabilities = Array.from(
      new Set([...entry.capabilities, ...capabilities]),
    );
    if (nextCapabilities.length === entry.capabilities.length) {
      return entry;
    }

    return persistCanopyCloudAccount({
      ...entry,
      capabilities: nextCapabilities,
      updatedAt: new Date().toISOString(),
    });
  });
}

async function persistCanopyCloudAccountClear(): Promise<void> {
  await credentialPort.clear();
  invalidateCanopyCloudAccountCache();
  writeCache(null);
  resetCanopyCloudSessionCredential();
  notifyAccountChange(null);
}

export async function clearCanopyCloudAccount(): Promise<void> {
  return withAccountSaveLock(persistCanopyCloudAccountClear);
}

/**
 * Atomically clear a non-guest credential and return the snapshot that was
 * removed. A guest write that has reached the shared persistence queue is
 * observed before the destructive decision is made.
 */
export async function clearCanopyCloudAccountUnlessGuest(
  withIdentityTransition?: CanopyCloudAccountTransition<void>,
): Promise<
  | { status: 'cleared'; previousAccount: CanopyCloudAccountEntry | null }
  | { status: 'guest-protected'; account: CanopyCloudAccountEntry }
> {
  return withAccountSaveLock(async () => {
    const previousAccount = await loadCanopyCloudAccountForGuard();
    if (previousAccount && isGuestAccount(previousAccount)) {
      return { status: 'guest-protected', account: previousAccount };
    }
    await (withIdentityTransition
      ? withIdentityTransition(persistCanopyCloudAccountClear)
      : persistCanopyCloudAccountClear());
    return { status: 'cleared', previousAccount };
  });
}

export async function resetUnreadableCanopyCloudAccount(
  withReplicaPurgeFence: CanopyCloudAccountTransition<void>,
): Promise<ResetUnreadableCanopyCloudAccountResult> {
  return withAccountSaveLock(async () => {
    const recovery = await credentialPort.inspectForRecovery();
    if (recovery.status === 'absent') {
      writeCache(null);
      resetCanopyCloudSessionCredential();
      return {
        status: 'not-needed',
        account: toPublicCanopyCloudAccountState(null),
      };
    }
    if (recovery.status === 'readable') {
      writeCache(recovery.record);
      return {
        status: 'not-needed',
        account: toPublicCanopyCloudAccountState(recovery.record),
      };
    }

    const quarantine = await recovery.prepareQuarantine();
    await withReplicaPurgeFence(() => quarantine.move());
    writeCache(null);
    resetCanopyCloudSessionCredential();
    notifyAccountChangeOrThrow(null);
    return {
      status: 'reset',
      account: toPublicCanopyCloudAccountState(null),
      backupFileName: quarantine.backupFileName,
    };
  });
}

export async function getCanopyCloudCredentials({
  preserveAccountReadErrors = false,
}: { preserveAccountReadErrors?: boolean } = {}): Promise<{
  baseUrl: string;
  apiKey: string;
  capabilities: string[];
  /** @deprecated Read `memorySearchOrganizationExternalIds` (CAN-3457). */
  memorySearchOrganizationExternalId?: string;
  /** Every org eligible for organization-memory search; empty ⇒ none. */
  memorySearchOrganizationExternalIds: string[];
  account?: CanopyServerAccountInfo;
  organizations?: CanopyOrganizationSummary[];
  teams?: CanopyTeamSummary[];
}> {
  const baseUrl = getCanopyCloudBaseUrl();
  const result = preserveAccountReadErrors
    ? await readCanopyCloudAccountWithStatus()
    : undefined;
  if (result && result.status !== 'ok') throw result.error;
  const entry = result ? result.entry : await loadCanopyCloudAccount();
  if (!entry || entry.apiKey.trim().length === 0) {
    throw new CanopyCloudConfigError(
      'api-key-required',
      `${CLOUD_DISPLAY_NAME} API key is required.`,
    );
  }

  return {
    baseUrl,
    apiKey: entry.apiKey,
    capabilities: [...entry.capabilities],
    ...(entry.memorySearchOrganizationExternalId
      ? {
          memorySearchOrganizationExternalId:
            entry.memorySearchOrganizationExternalId,
        }
      : {}),
    memorySearchOrganizationExternalIds: [
      ...(entry.memorySearchOrganizationExternalIds ?? []),
    ],
    ...(entry.account ? { account: { ...entry.account } } : {}),
    organizations: (entry.organizations ?? []).map((organization) => ({
      ...organization,
    })),
    teams: (entry.teams ?? []).map((team) => ({
      ...team,
      organization: { ...team.organization },
    })),
  };
}

export function invalidateCanopyCloudAccountCache(): void {
  accountCache.invalidate();
}

export function toPublicCanopyCloudAccountState(
  entry: CanopyCloudAccountEntry | null,
  read: CanopyCloudAccountReadStatus = 'ok',
  secureStorageFailure?: SecureStorageFailure,
): CanopyCloudAccountPublicState {
  const storage = credentialPort.storageStatus();
  return {
    secureStorageStatus: {
      version: 1,
      state: storage.state,
      backend: storage.backend,
      writeAvailable: storage.state === 'secure',
    },
    read,
    ...(secureStorageFailure ? { secureStorageFailure } : {}),
    hasApiKey: !!entry?.apiKey.trim(),
    ...(isCanopyCloudSessionExpired(entry) ? { sessionExpired: true } : {}),
    authMode: entry?.authMode ?? null,
    credentialSource: entry?.credentialSource ?? null,
    ...(entry?.serverApiKeyId ? { serverApiKeyId: entry.serverApiKeyId } : {}),
    capabilities: entry ? [...entry.capabilities] : [],
    ...(entry?.personalOrganizationId
      ? { personalOrganizationId: entry.personalOrganizationId }
      : {}),
    ...(entry?.memorySearchOrganizationExternalId
      ? {
          memorySearchOrganizationExternalId:
            entry.memorySearchOrganizationExternalId,
        }
      : {}),
    ...(entry?.memorySearchOrganizationExternalIds
      ? {
          memorySearchOrganizationExternalIds: [
            ...entry.memorySearchOrganizationExternalIds,
          ],
        }
      : {}),
    ...(entry?.account ? { account: { ...entry.account } } : {}),
    organizations: (entry?.organizations ?? []).map((organization) => ({
      ...organization,
    })),
    teams: (entry?.teams ?? []).map((team) => ({
      ...team,
      organization: { ...team.organization },
    })),
    ...personalGatewayAccountFields(entry),
    ...(entry?.personalModelGatewayEnforcementUnavailable
      ? { personalModelGatewayEnforcementUnavailable: true }
      : {}),
    enforcedSettings: cloneEnforcedSettings(entry?.enforcedSettings),
    ...(entry?.telemetryEnforcementUnavailable === true
      ? { telemetryEnforcementUnavailable: true }
      : {}),
    ...(entry?.modelGatewayEnforcementUnavailable === true
      ? { modelGatewayEnforcementUnavailable: true }
      : {}),
    orgBillingStates: cloneOrgBillingStates(entry?.orgBillingStates),
    ...(entry?.createdAt ? { createdAt: entry.createdAt } : {}),
    ...(entry?.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    storageAvailable: isCanopyCloudStorageAvailable(),
  };
}
