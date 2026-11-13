import { logMainProcessError } from '../lib/main-process-logging';
import { saveGitHubPat } from '../lib/github-pat-save';
import { probeModelGateway } from '../services/model-gateway-probe';
import { createHash } from 'node:crypto';
import {
  observeProviderConnection,
  recordProviderConnectionFailure,
  withProviderConnectionAttempt,
} from '../lib/provider-connection-events';
import { BrowserWindow } from 'electron';
import { loadCloudReleaseNotes } from '../canopy-cloud/release-notes';
import { normalizePersonalOrganizationId } from '@canopy/protocol/workspace-context';
import { normalizeMemorySearchOrganizationExternalIds } from '@canopy/desktop-shared/lib/org-memory';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseLinearIdentifier } from '@canopy/desktop-shared/lib/create-from-reference';
import { parseLinearIssueSearchQuery } from '@canopy/protocol/reference-previews';
import { BRAND } from '@canopy/brand/current';
import {
  IPC_CHANNELS,
  type AgentProviderAuthStatus,
  type CanopyCloudAccountPublicState,
  type CanopyCloudAiCreditsState,
  type SecureStorageRecheckResult,
  type CanopyCloudEntitlementsState,
  type CloudDigestPreferences,
  type CloudDigestPreferencesState,
  type MobileActivationState,
  type MobileActivationLoadOptions,
  type CanopyServerStatus,
  type NativeAiCreditsAvailability,
  type AiCreditsScopeRequest,
  type GitHubCliStatus,
  type StarSourceRepositoryResult,
  type GitHubPermissionsRequest,
  type GitHubPermissionsStatus,
  type LinearStatus,
  type LinearTicketSearchResult,
  type ModelGatewayCredentialInput,
  type ModelGatewayCredentialState,
  type ModelGatewayCredentialValidation,
  type ResetUnreadableCanopyCloudAccountResult,
  type SecureStorageFailure,
  type CredentialReadFailure,
  type CredentialSaveResult,
  type StoredSecretReadResult,
} from '@canopy/desktop-shared/types';
import {
  normalizeModelGatewayBaseUrl,
  type CanopyAccountResponse,
} from '@canopy/protocol/canopy-server';
import { MEMORY_SEARCH_CAPABILITY } from '@canopy/protocol/memory';
import type {
  AiCreditsBalance,
  AiCreditsSubscription,
  OrgAiCreditsSpendable,
  WorkOwner,
} from '@canopy/protocol/llm-gateway';
import { AI_CREDITS_WORK_OWNER_HEADER } from '@canopy/protocol/llm-gateway';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { scopeAiCreditsBalanceToWorkOwner } from '@canopy/desktop-shared/lib/ai-credits-funding';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import { summarizeProviderCarryover } from '../plugins/provider-carryover';
import {
  isProviderCarryoverProvider,
  type ProviderCarryoverSummary,
} from '@canopy/desktop-shared/types/provider-carryover';
import { validateId } from '../lib/validation';
import {
  normalizeOrgEnforcedSettingsWithStatus,
  personalGatewayAccountFields,
} from '@canopy/desktop-shared/lib/org-enforced-parsing';
import { normalizeOrgBillingStates } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import type { CanopyGuestConsent } from '@canopy/desktop-shared/constants/consent';
import type { CanopyTeamSummary } from '@canopy/protocol/pipelines';
import {
  invalidateTokenCache,
  resolveGitHubToken,
  readStoredPatWithStatus,
} from '../lib/github-auth';
import {
  initializeGitHubPatEnvRuntime,
  invalidateGitHubPatEnvCache,
} from '../lib/github-pat-env';
import { getGitHubBroker } from '../lib/github-broker';
import { probeGitHubPermissions } from '../lib/github-permissions';
import { invalidateGitHubRepoListCache } from '../lib/github-repo-listing';
import { invalidatePullRequestListingCache } from '../lib/github-pr-listing';
import { resetGitHubPullRequestReadModel } from '../lib/github-pr-read-model';
import { resetGitHubMergeQueueReadModel } from '../lib/github-merge-queue-read-model';
import { getSharedContainerReconciliationService } from '../shared-containers/reconciliation-service';
import { organizationSnapshotTransition } from '../shared-containers/organization-snapshot-transition';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import {
  beginCanopyCloudSessionProbe,
  isCurrentCanopyCloudSessionProbe,
  type CanopyCloudSessionProbe,
} from '../canopy-cloud/session-status';
import { parseAuthoritativeOrganizationSnapshot } from '../canopy-cloud/organization-snapshot';
import { normalizeCanopyOrganizationSummaries } from '../canopy-cloud/organization-summary';
import { openAuthenticatedPortalPage } from '../canopy-cloud/authenticated-portal';
import { openAuthenticatedPortalRequest } from '../services/authenticated-portal-open';
import type { AuthenticatedPortalResult } from '@canopy/desktop-shared/lib/authenticated-portal-request';
import {
  getUnstoppableDomainsAiCreditsManageUrl,
  getUnstoppableDomainsAiCreditsPurchaseUrl,
} from '../unstoppable-domains/config';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  revokeCurrentOAuthDesktopKey,
} from '../canopy-cloud/client';
import {
  probeEntitlementsWithModelLibrary,
  subscribeModelLibraryAccess,
} from '../canopy-cloud/model-library-access';
import { sendToWebContents } from '../lib/web-contents-send';
import {
  captureDailyCreditGrantAccount,
  clearDailyCreditGrantStatus,
  recordDailyCreditGrantFromBalance,
} from '../lib/daily-credit-grant-telemetry';
import {
  loadCloudDigestPreferences,
  saveCloudDigestPreferences,
} from '../canopy-cloud/digest-preferences';
import {
  loadInstallUpdateEmailPreference,
  saveInstallUpdateEmailPreference,
} from '../canopy-cloud/install-update-email-preference';
import {
  invalidateMobileActivationCache,
  probeMobileActivation,
} from '../canopy-cloud/mobile-activation';
import {
  CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR,
  assertCanopyCloudStorageAvailable,
  applyCanopyCloudSessionProbeResult,
  readCanopyCloudAccountWithStatus,
  type CanopyCloudAccountEntry,
  clearCanopyCloudAccountUnlessGuest,
  hasCanopyCloudIdentityChanged,
  loadCanopyCloudAccount,
  loadCanopyCloudAccountPublicState,
  resetUnreadableCanopyCloudAccount,
  saveCanopyCloudAccountIfUnchanged,
  saveManualCanopyCloudAccount,
  toPublicCanopyCloudAccountState,
} from '../lib/canopy-cloud-account-store';
import { applyEnforcedSettings } from '../services/org-enforced-settings';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { sendToAllWindows } from '../lib/window-send';
import { rebindLedgerGuestScopes } from '../ledger/sync-host';
import {
  readPreferencesFile,
  writePreferencesFile,
} from '../lib/preferences-store';
import {
  invalidateLinearTokenCache,
  resolveLinearToken,
  readStoredLinearTokenWithStatus,
} from '../lib/linear-auth';
import {
  isLinearApiError,
  readLinearIssueAttachments,
  readLinearViewer,
  searchLinearIssues as searchLinearApiIssues,
  type LinearIssueSearchResult,
} from '../lib/linear-api';
import {
  getLegacyLinearTokenFilePath,
  getLinearTokenFilePath,
} from '../lib/paths';
import { registerIpcHandler } from './register';
import type { DesktopIpcCallerResolver } from './file-tree';
import type { CoreIntegrationDispatcher } from '../canopy-runtime/core-integration-adapter';
import {
  getGitHubCliStatus,
  starSourceRepository,
} from '../canopy-runtime/github-integration-dispatch';
import { getFeatureFlagService } from '../feature-flags';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  DEFAULT_DIGEST_PREFERENCES,
  parseDigestPreferences,
} from '@canopy/protocol/digests';
import {
  parseInstallUpdateEmailPreference,
  type InstallUpdateEmailPreference,
} from '@canopy/protocol/account-notifications';
import {
  getCachedClaudeAuthStatusObserved,
  getCachedCodexAuthStatusObserved,
} from '../auth/provider-auth-state';
// Deliberately the LEAF module, not `agents/ai-credits-routing` — that module
// imports `loadNativeAiCreditsAvailability` from this file, so importing it
// here would close a cycle.
import { hasUserSuppliedProviderCredential } from '../agents/user-supplied-credential';
import { invalidateReconcileViewerCache } from '../lib/github-pr-reconcile';
import { isMissingFileError } from '../lib/fs-utils';
import { writeFileAtomically } from '../lib/atomic-file';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
  recheckSecretStorage,
} from '../lib/secure-storage-policy';
import {
  authorizeModelGatewayCredential,
  clearModelGatewayCredential,
  GatewayCredentialStorageUnavailableError,
  isModelGatewayCredentialStorageAvailable,
  loadModelGatewayCredential,
  saveModelGatewayCredential,
} from '../lib/model-gateway-credential-store';

const REQUIRED_CANOPY_CLOUD_CAPABILITIES = [
  'pipelines-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
] as const;
const CANOPY_CLOUD_REQUEST_TIMEOUT_MS = 15_000;
const CLOUD_DISPLAY_NAME = `${BRAND.displayName} Cloud`;
const GUEST_MANUAL_KEY_REPLACEMENT_ERROR =
  'A manual API key cannot replace a guest session. Sign in with your browser to keep your guest work.';
const SUPERSEDED_MANUAL_KEY_SAVE_ERROR =
  'The connected account changed while the API key was being validated. Review the current account and try again.';

type DesktopCanopyServerStatus = CanopyServerStatus & {
  /** Definitive rejection by the authenticated account endpoint only. */
  credentialRejected?: boolean;
  /** @deprecated Read `memorySearchOrganizationExternalIds` (CAN-3457). */
  memorySearchOrganizationExternalId?: string;
  /** Normalized eligible memory orgs; absent when none. */
  memorySearchOrganizationExternalIds?: string[];
  organizationsRefreshed?: boolean;
  personalOrganizationId?: string | null;
  personalModelGateway?: CanopyAccountResponse['personalModelGateway'];
  personalModelGatewayEnforcementUnavailable?: boolean;
};

function memorySearchOrganizationsField(payload: {
  memorySearchOrganizationExternalId?: unknown;
  memorySearchOrganizationExternalIds?: unknown;
}): {
  memorySearchOrganizationExternalIds?: string[];
} {
  const organizations = normalizeMemorySearchOrganizationExternalIds(
    payload.memorySearchOrganizationExternalIds,
    payload.memorySearchOrganizationExternalId,
  );
  return organizations.length > 0
    ? { memorySearchOrganizationExternalIds: organizations }
    : {};
}

function refreshFeatureFlagContextAfterSettingsChange(reason: string): void {
  void getFeatureFlagService()
    .refreshContext()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[settings] Failed to refresh feature flag context after ${reason}: ${message}\n`,
      );
    });
}

function resetGitHubCredentialState(): void {
  invalidateTokenCache();
  invalidateGitHubPatEnvCache();
  getGitHubBroker().resetCredentials();
  invalidateGitHubRepoListCache();
  invalidatePullRequestListingCache();
  resetGitHubPullRequestReadModel();
  resetGitHubMergeQueueReadModel();
  invalidateReconcileViewerCache();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCanopyTeams(value: unknown): CanopyTeamSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is CanopyTeamSummary =>
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.name === 'string' &&
      isRecord(entry.organization) &&
      typeof entry.organization.id === 'string' &&
      typeof entry.organization.name === 'string' &&
      typeof entry.organization.createdAt === 'string' &&
      typeof entry.organization.updatedAt === 'string' &&
      typeof entry.createdAt === 'string' &&
      typeof entry.updatedAt === 'string',
  );
}

function buildWellKnownUrl(baseUrl: string): string {
  return `${baseUrl}/.well-known/${BRAND.web.wellKnownNamespace}`;
}

function buildAccountUrl(baseUrl: string): string {
  return `${baseUrl}/api/v1/${BRAND.web.apiNamespace}/account`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function fetchCanopyCloud(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, CANOPY_CLOUD_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    // Fetch resolves at headers. Keep the deadline active through the body,
    // otherwise a stalled account response can hold a settings write forever.
    const body = await response.blob();
    return new Response(body.size === 0 ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json();
  return payload as T;
}

async function readErrorResponse(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const payload: unknown = await response.json();
      if (
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        typeof payload.error === 'string'
      ) {
        return payload.error;
      }
    } catch {
      // Fall through to text body.
    }
  }

  const text = await response.text().catch(() => '');
  if (text.trim().length > 0) {
    return text.trim();
  }

  return `${response.status} ${response.statusText}`.trim();
}

async function probeCanopyCloud(
  apiKey: string,
): Promise<DesktopCanopyServerStatus> {
  let baseUrl: string;
  try {
    baseUrl = getCanopyCloudBaseUrl();
  } catch (error) {
    return {
      authenticated: false,
      capabilities: [],
      missingCapabilities: [...REQUIRED_CANOPY_CLOUD_CAPABILITIES],
      account: null,
      organizations: [],
      teams: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let capabilities: string[] = [];
  try {
    const wellKnownResponse = await fetchCanopyCloud(
      buildWellKnownUrl(baseUrl),
      {
        headers: {
          Accept: 'application/json',
        },
      },
    );
    if (!wellKnownResponse.ok) {
      return {
        authenticated: false,
        capabilities: [],
        missingCapabilities: [...REQUIRED_CANOPY_CLOUD_CAPABILITIES],
        account: null,
        organizations: [],
        teams: [],
        error: await readErrorResponse(wellKnownResponse),
      };
    }

    const payload = await readJsonResponse<{ capabilities?: unknown }>(
      wellKnownResponse,
    );
    capabilities = Array.isArray(payload.capabilities)
      ? payload.capabilities.filter(
          (capability): capability is string => typeof capability === 'string',
        )
      : [];
  } catch (error) {
    return {
      authenticated: false,
      capabilities: [],
      missingCapabilities: [...REQUIRED_CANOPY_CLOUD_CAPABILITIES],
      account: null,
      organizations: [],
      teams: [],
      error: isAbortError(error)
        ? `${CLOUD_DISPLAY_NAME} request timed out.`
        : error instanceof Error
          ? error.message
          : `Failed to reach ${CLOUD_DISPLAY_NAME}.`,
    };
  }

  const missingCapabilities = REQUIRED_CANOPY_CLOUD_CAPABILITIES.filter(
    (capability) => !capabilities.includes(capability),
  );

  if (!apiKey) {
    return {
      authenticated: false,
      capabilities,
      missingCapabilities,
      account: null,
      organizations: [],
      teams: [],
      error: `${CLOUD_DISPLAY_NAME} API key is required.`,
    };
  }

  try {
    const accountResponse = await fetchCanopyCloud(buildAccountUrl(baseUrl), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!accountResponse.ok) {
      return {
        ...(accountResponse.status === 401 ? { credentialRejected: true } : {}),
        authenticated: false,
        capabilities,
        missingCapabilities,
        account: null,
        organizations: [],
        teams: [],
        error: await readErrorResponse(accountResponse),
      };
    }

    const payload =
      await readJsonResponse<Partial<CanopyAccountResponse>>(accountResponse);
    const effectiveCapabilities = Array.isArray(payload.capabilities)
      ? payload.capabilities.filter(
          (capability): capability is string => typeof capability === 'string',
        )
      : capabilities;
    const effectiveMissingCapabilities =
      REQUIRED_CANOPY_CLOUD_CAPABILITIES.filter(
        (capability) => !effectiveCapabilities.includes(capability),
      );
    const authoritativeOrganizations = parseAuthoritativeOrganizationSnapshot(
      payload.organizations,
    );
    const organizations =
      authoritativeOrganizations ??
      normalizeCanopyOrganizationSummaries(payload.organizations);
    const normalizedEnforcement = normalizeOrgEnforcedSettingsWithStatus(
      payload.enforcedSettings,
    );
    return {
      authenticated: true,
      capabilities: effectiveCapabilities,
      missingCapabilities: effectiveMissingCapabilities,
      account: payload.account ?? null,
      personalOrganizationId: normalizePersonalOrganizationId(
        payload.personalOrganizationId,
      ),
      organizations,
      organizationsRefreshed: authoritativeOrganizations !== null,
      ...personalGatewayAccountFields(payload),
      teams: normalizeCanopyTeams(payload.teams),
      enforcedSettings: normalizedEnforcement.settings,
      ...(normalizedEnforcement.telemetryEnforcementUnavailable === true
        ? { telemetryEnforcementUnavailable: true }
        : {}),
      modelGatewayEnforcementUnavailable:
        normalizedEnforcement.modelGatewayEnforcementUnavailable,
      // PRESENCE IS THE SIGNAL, so the key is spread rather than always set.
      // `normalizeOrgBillingStates` maps an absent or malformed field to `[]`,
      // which is indistinguishable from "the server told us no org is lapsed".
      // `reprobeAndApplyCanopyCloudEnforcedSettings` reports whether per-org
      // billing state was genuinely refreshed by testing this key for
      // `undefined`, and `TelemetrySyncService` treats that report as the
      // precondition for an irreversible queue delete. Normalizing an omission
      // to `[]` would make every authenticated probe claim a refresh, including
      // one against a server that has never sent the field.
      ...(Array.isArray(payload.orgBillingStates)
        ? {
            orgBillingStates: normalizeOrgBillingStates(
              payload.orgBillingStates,
            ),
          }
        : {}),
      ...(typeof payload.memorySearchOrganizationExternalId === 'string' &&
      payload.memorySearchOrganizationExternalId.trim().length > 0
        ? {
            memorySearchOrganizationExternalId:
              payload.memorySearchOrganizationExternalId.trim(),
          }
        : {}),
      ...memorySearchOrganizationsField(payload),
      error:
        effectiveMissingCapabilities.length > 0
          ? `${CLOUD_DISPLAY_NAME} is missing required capabilities: ${effectiveMissingCapabilities.join(', ')}`
          : null,
    };
  } catch (error) {
    return {
      authenticated: false,
      capabilities,
      missingCapabilities,
      account: null,
      organizations: [],
      teams: [],
      error: isAbortError(error)
        ? `${CLOUD_DISPLAY_NAME} request timed out.`
        : error instanceof Error
          ? error.message
          : `Failed to reach ${CLOUD_DISPLAY_NAME}.`,
    };
  }
}

async function validateCanopyCloudApiKey(request: {
  apiKey?: string;
}): Promise<CanopyServerStatus> {
  const requestApiKey = String(request.apiKey ?? '').trim();
  const storedRead = requestApiKey
    ? null
    : await readCanopyCloudAccountWithStatus();
  if (storedRead && storedRead.status !== 'ok') {
    if (storedRead.status === 'error' && !storedRead.secureStorageFailure)
      throw storedRead.error;
    return failedCanopyCloudStatus(
      CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR,
      storedRead.secureStorageFailure,
    );
  }
  const storedApiKey =
    storedRead?.status === 'ok' ? (storedRead.entry?.apiKey ?? '') : '';
  const apiKey = requestApiKey || storedApiKey;
  if (!apiKey) {
    return failedCanopyCloudStatus(
      `${CLOUD_DISPLAY_NAME} API key is required.`,
    );
  }
  return probeCanopyCloud(apiKey);
}

/**
 * Why an account refresh did or did not apply a fresh server snapshot.
 * `billingStatesRefreshed` keeps the narrower boolean the telemetry sync reads.
 */
export interface CanopyCloudAccountRefreshResult {
  outcome:
    | 'applied'
    | 'superseded'
    | 'offline'
    | 'unauthenticated'
    | 'stale-probe'
    | 'no-key';
  billingStatesRefreshed: boolean;
}

interface PendingAccountRefresh {
  promise: Promise<CanopyCloudAccountRefreshResult>;
  waiting: boolean;
}

const accountRefreshes = new Map<string, PendingAccountRefresh>();

function accountRefreshResult(
  outcome: CanopyCloudAccountRefreshResult['outcome'],
  billingStatesRefreshed = false,
): CanopyCloudAccountRefreshResult {
  return { outcome, billingStatesRefreshed };
}

/**
 * Re-probe the signed-in account to refresh `organizations` + `enforcedSettings`,
 * persist the refreshed snapshot, then apply enforcement. On probe failure
 * (offline) we keep the last-known cached snapshot and still apply from it, so
 * offline pref edits get re-enforced. No-op when signed out.
 *
 * Used by startup, the periodic interval and settings membership writes.
 * Concurrent calls share at most one waiting probe per credential; that probe
 * starts after the active save so a newer snapshot cannot lose its save fence.
 */
export async function reprobeAndApplyCanopyCloudEnforcedSettings(): Promise<boolean> {
  const result = await refreshCanopyCloudAccountWithOutcome();
  return result.billingStatesRefreshed;
}

/**
 * Same refresh and dedupe as {@link reprobeAndApplyCanopyCloudEnforcedSettings},
 * reporting whether the fresh snapshot was applied and, if not, why.
 */
export async function refreshCanopyCloudAccountWithOutcome(): Promise<CanopyCloudAccountRefreshResult> {
  // Capture before any read/wait: clear + same-key replacement invalidates it.
  const sessionProbe = beginCanopyCloudSessionProbe();
  const expected = await loadCanopyCloudAccount();
  if (!expected || expected.apiKey.trim().length === 0)
    return accountRefreshResult('no-key');
  const previous = accountRefreshes.get(expected.apiKey);
  if (previous?.waiting) return previous.promise;
  const pending: PendingAccountRefresh = {
    promise: Promise.resolve(accountRefreshResult('stale-probe')),
    waiting: previous !== undefined,
  };
  const run = (): Promise<CanopyCloudAccountRefreshResult> => {
    pending.waiting = false;
    return reprobeAndApplyAccountSnapshot(expected, sessionProbe);
  };
  pending.promise = (
    previous ? previous.promise.catch(() => undefined).then(run) : run()
  )
    .then((result) => {
      if (result.outcome === 'applied') accountRefreshAppliedGeneration += 1;
      return result;
    })
    .finally(() => {
      if (accountRefreshes.get(expected.apiKey) === pending)
        accountRefreshes.delete(expected.apiKey);
    });
  accountRefreshes.set(expected.apiKey, pending);
  return pending.promise;
}

/** Delays for the detached retries after a settings write's refresh misses. */
const SETTINGS_WRITE_REFRESH_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

/**
 * Counts applied refreshes so a retry can tell a later refresh already won.
 * Process-wide on purpose: after an account switch, the old account's retries
 * have nothing left to apply.
 */
let accountRefreshAppliedGeneration = 0;
let settingsWriteRefreshRetriesStopped = false;
const settingsWriteRefreshRetryTimers = new Set<
  ReturnType<typeof setTimeout>
>();

function isRetryableAccountRefreshOutcome(
  outcome: CanopyCloudAccountRefreshResult['outcome'],
): boolean {
  // Unauthenticated, stale-probe and no-key need a sign-in or a newer probe;
  // retrying them would only repeat the same request.
  return outcome === 'superseded' || outcome === 'offline';
}

/**
 * Refresh the account after a hosted settings write, so the write's effect
 * (for example a new AI gateway) reaches enforcement without waiting for the
 * periodic re-probe. The first attempt is awaited; a superseded or offline
 * miss schedules detached retries that never block the write's response.
 */
export async function refreshAccountAfterSettingsWrite(
  operationName: string,
): Promise<void> {
  const result = await refreshCanopyCloudAccountWithOutcome();
  // Read after the attempt: a refresh already in flight when the write
  // finished may apply a pre-write snapshot, and must not cancel the retries.
  // Refreshes are serialized, so any later apply started after this attempt.
  const generation = accountRefreshAppliedGeneration;
  if (result.outcome === 'applied') return;
  logMainProcessWarn('[settings] Post-write account refresh', {
    operation: operationName,
    attempt: 1,
    outcome: result.outcome,
  });
  if (!isRetryableAccountRefreshOutcome(result.outcome)) return;
  scheduleSettingsWriteRefreshRetry(operationName, generation, 0);
}

function scheduleSettingsWriteRefreshRetry(
  operationName: string,
  generation: number,
  retryIndex: number,
): void {
  const delay = SETTINGS_WRITE_REFRESH_RETRY_DELAYS_MS[retryIndex];
  if (delay === undefined || settingsWriteRefreshRetriesStopped) return;
  const timer = setTimeout(() => {
    settingsWriteRefreshRetryTimers.delete(timer);
    if (
      settingsWriteRefreshRetriesStopped ||
      accountRefreshAppliedGeneration !== generation
    )
      return;
    void refreshCanopyCloudAccountWithOutcome()
      .then((result) => {
        if (result.outcome === 'applied') return;
        logMainProcessWarn('[settings] Post-write account refresh', {
          operation: operationName,
          attempt: retryIndex + 2,
          outcome: result.outcome,
        });
        if (isRetryableAccountRefreshOutcome(result.outcome))
          scheduleSettingsWriteRefreshRetry(
            operationName,
            generation,
            retryIndex + 1,
          );
      })
      .catch((error: unknown) => {
        logMainProcessWarn('[settings] Post-write account refresh failed', {
          operation: operationName,
          attempt: retryIndex + 2,
          errorName:
            error instanceof Error ? error.constructor.name : typeof error,
        });
      });
  }, delay);
  timer.unref();
  settingsWriteRefreshRetryTimers.add(timer);
}

/** Cancel pending post-write refresh retries; called when the app quits. */
export function stopSettingsWriteRefreshRetries(): void {
  settingsWriteRefreshRetriesStopped = true;
  for (const timer of settingsWriteRefreshRetryTimers) clearTimeout(timer);
  settingsWriteRefreshRetryTimers.clear();
}

async function applyCachedAccountEnforcementIfCurrent(
  expected: CanopyCloudAccountEntry,
): Promise<void> {
  const current = await loadCanopyCloudAccount();
  if (
    !current ||
    current.apiKey !== expected.apiKey ||
    hasCanopyCloudIdentityChanged(expected, current)
  )
    return;
  // Use the latest cached policies, and never reapply the previous account's
  // policies after a disconnect or credential/identity replacement.
  await applyEnforcedSettings(toPublicCanopyCloudAccountState(current));
}

async function reprobeAndApplyAccountSnapshot(
  expected: CanopyCloudAccountEntry,
  sessionProbe: CanopyCloudSessionProbe,
): Promise<CanopyCloudAccountRefreshResult> {
  // A waiting refresh reads the active refresh's saved version, while keeping
  // the caller's identity/credential fence across the wait.
  const entry = await loadCanopyCloudAccount();
  if (
    !isCurrentCanopyCloudSessionProbe(sessionProbe) ||
    !entry ||
    entry.apiKey !== expected.apiKey ||
    hasCanopyCloudIdentityChanged(expected, entry)
  )
    return accountRefreshResult('stale-probe');

  let status: DesktopCanopyServerStatus;
  try {
    status = await probeCanopyCloud(entry.apiKey);
  } catch {
    await applyCachedAccountEnforcementIfCurrent(entry);
    return accountRefreshResult('offline');
  }

  if (status.credentialRejected || (status.authenticated && status.account)) {
    await applyCanopyCloudSessionProbeResult(
      entry,
      sessionProbe,
      status.credentialRejected ? 'rejected' : 'accepted',
    );
  }

  if (!status.authenticated || !status.account) {
    // Offline / probe failure: apply from the cached snapshot, unchanged.
    await applyCachedAccountEnforcementIfCurrent(entry);
    return accountRefreshResult(
      status.credentialRejected ? 'unauthenticated' : 'offline',
    );
  }

  // Memory-org eligibility is replaced, never merged: `...entry` would
  // otherwise keep a cached org the server stopped advertising (CAN-3457), and
  // org memory would keep searching an org the user may no longer search.
  const entryWithoutMemoryOrganizations: CanopyCloudAccountEntry = {
    ...entry,
  };
  delete entryWithoutMemoryOrganizations.personalOrganizationId;
  delete entryWithoutMemoryOrganizations.personalModelGateway;
  delete entryWithoutMemoryOrganizations.personalModelGatewayEnforcementUnavailable;
  delete entryWithoutMemoryOrganizations.memorySearchOrganizationExternalId;
  delete entryWithoutMemoryOrganizations.memorySearchOrganizationExternalIds;
  const nextAccount: CanopyCloudAccountEntry = {
    ...entryWithoutMemoryOrganizations,
    capabilities: status.capabilities,
    ...(status.memorySearchOrganizationExternalId
      ? {
          memorySearchOrganizationExternalId:
            status.memorySearchOrganizationExternalId,
        }
      : {}),
    ...(status.memorySearchOrganizationExternalIds
      ? {
          memorySearchOrganizationExternalIds:
            status.memorySearchOrganizationExternalIds,
        }
      : {}),
    ...(status.personalOrganizationId
      ? { personalOrganizationId: status.personalOrganizationId }
      : {}),
    ...personalGatewayAccountFields(status),
    ...(status.personalModelGatewayEnforcementUnavailable
      ? { personalModelGatewayEnforcementUnavailable: true }
      : {}),
    account: status.account,
    organizations: status.organizations,
    teams: status.teams,
    ...(status.enforcedSettings
      ? { enforcedSettings: status.enforcedSettings }
      : {}),
    telemetryEnforcementUnavailable:
      status.telemetryEnforcementUnavailable === true,
    modelGatewayEnforcementUnavailable:
      status.modelGatewayEnforcementUnavailable === true,
    // An AUTHENTICATED response that omits the field clears the cached states
    // rather than preserving them. Preserving would make a lapse STICKY across
    // a server rollback: a deployment that predates `orgBillingStates` would
    // leave every previously-lapsed org gated locally forever — org memory off,
    // AI credits zeroed, sharing refused — which contradicts the invariant in
    // `lib/org-billing-state.ts` that an older server means NOT lapsed, and the
    // PR's claim that either side rolls back independently.
    //
    // This is only reached on the authenticated branch. The early returns above
    // (no key, offline, unauthenticated) still leave the cached value untouched,
    // because those tell us nothing about the server's support for the field.
    orgBillingStates: status.orgBillingStates ?? [],
    updatedAt: new Date().toISOString(),
  };
  const organizationIds = status.organizations.map(
    (organization) => organization.id,
  );
  const saveResult = await saveCanopyCloudAccountIfUnchanged(
    nextAccount,
    entry,
    // Only a well-formed authenticated organization array is conclusive
    // evidence for authorization loss. Run removed-organization cleanup and
    // persistence inside the matched account-store operation so a stale probe
    // can neither purge a replacement identity nor resurrect its credential.
    status.organizationsRefreshed
      ? organizationSnapshotTransition(
          organizationIds,
          status.personalOrganizationId,
        )
      : undefined,
    sessionProbe,
    status.organizationsRefreshed === true,
  );
  if (saveResult.status === 'superseded') {
    return accountRefreshResult('superseded');
  }
  const saved = saveResult.entry;
  // The store committed pending losses with this snapshot, before the only old
  // membership diff disappeared. Authoritative refreshes (including startup)
  // also retry those receipts. Manual API-key replacement never enters here.
  if (
    status.organizationsRefreshed &&
    saved.organizationAccessLossState?.pending.length
  ) {
    void import('../services/organization-access-loss-service')
      .then(({ getOrganizationAccessLossService }) =>
        getOrganizationAccessLossService().process(
          saved.organizationAccessLossState?.pending ?? [],
        ),
      )
      .catch((error: unknown): void =>
        logMainProcessError(
          'Failed to process organization access loss:',
          error,
        ),
      );
  }
  await applyEnforcedSettings(toPublicCanopyCloudAccountState(saved));
  // Reports whether PER-ORG BILLING STATE was genuinely refreshed from the
  // server, which is narrower than "the probe ran". A caller that deletes data
  // on a lapse verdict (see `TelemetrySyncService`) must be able to tell a
  // confirmed verdict from a stale one, and every early return above leaves
  // `orgBillingStates` untouched: no key, an offline probe, and an
  // unauthenticated response.
  //
  // Deliberately NOT the same question as what was persisted above. The clear
  // keeps the GATE fail-open (an omitted field must not gate anyone); this
  // boolean keeps DELETION fail-safe (an omitted field must not authorize an
  // irreversible drop). Both directions are needed, and they disagree on this
  // exact input, so the write and the report are decided separately.
  return accountRefreshResult('applied', status.orgBillingStates !== undefined);
}

/**
 * Re-probe + apply enforcement on demand (e.g. when a settings surface that
 * shows enforcement opens), then return the refreshed public account state.
 * Reuses {@link reprobeAndApplyCanopyCloudEnforcedSettings}, so it persists the
 * latest snapshot and broadcasts `preferencesChanged` when enforcement changed.
 */
export async function refreshCanopyCloudEnforcedSettings(): Promise<CanopyCloudAccountPublicState> {
  await reprobeAndApplyCanopyCloudEnforcedSettings();
  // Status-preserving: this is a pure *read* path exposed over IPC, so it must
  // not claim `read: 'ok'` for a degraded secure-store read. Post-write paths
  // (sign-in, disconnect, guest mint) legitimately keep the `'ok'` default
  // because they already know the entry they just persisted.
  return loadCanopyCloudAccountPublicState();
}

function disconnectedAiCreditsState(): CanopyCloudAiCreditsState {
  return {
    connected: false,
    email: null,
    subscription: null,
    balance: null,
    noUdAccount: false,
    error: null,
    purchaseUrl: getUnstoppableDomainsAiCreditsPurchaseUrl(),
    manageUrl: getUnstoppableDomainsAiCreditsManageUrl(),
  };
}

/**
 * Load the connected account's UD AI Credits subscription + balance from the
 * cloud. Never throws: a disconnected account yields a disconnected state, a
 * missing UD account sets `noUdAccount`, and a transient failure sets `error`.
 * (CAN-771)
 */
export async function loadCanopyCloudAiCredits(
  owner?: WorkOwner,
): Promise<CanopyCloudAiCreditsState> {
  const account = toPublicCanopyCloudAccountState(
    await loadCanopyCloudAccount(),
  );
  if (!account.hasApiKey) {
    clearDailyCreditGrantStatus();
    return disconnectedAiCreditsState();
  }

  const email = account.account?.email ?? null;
  const purchaseUrl = getUnstoppableDomainsAiCreditsPurchaseUrl();
  const manageUrl = getUnstoppableDomainsAiCreditsManageUrl();

  const grantAccount = captureDailyCreditGrantAccount();
  const [subscriptionResult, balanceResult] = await Promise.allSettled([
    requestCanopyCloudJson<AiCreditsSubscription>(
      '/api/v1/ai-credits/subscription',
    ),
    requestCanopyCloudJson<AiCreditsBalance>('/api/v1/ai-credits/balance', {
      ...(owner
        ? {
            headers: {
              [AI_CREDITS_WORK_OWNER_HEADER]: serializeWorkspaceContext(owner),
            },
          }
        : {}),
    }),
  ] as const);
  // The balance can mint a grant even if subscription loading fails.
  if (balanceResult.status === 'fulfilled') {
    recordDailyCreditGrantFromBalance(
      balanceResult.value,
      undefined,
      grantAccount,
    );
  }
  if (
    subscriptionResult.status === 'rejected' ||
    balanceResult.status === 'rejected'
  ) {
    const rejectedReason: unknown =
      subscriptionResult.status === 'rejected'
        ? subscriptionResult.reason
        : balanceResult.status === 'rejected'
          ? balanceResult.reason
          : undefined;
    const hasUnknownUdAccount =
      (subscriptionResult.status === 'rejected' &&
        subscriptionResult.reason instanceof CanopyCloudClientError &&
        subscriptionResult.reason.status === 404) ||
      (balanceResult.status === 'rejected' &&
        balanceResult.reason instanceof CanopyCloudClientError &&
        balanceResult.reason.status === 404);
    if (hasUnknownUdAccount) {
      return {
        connected: true,
        email,
        subscription: null,
        balance: null,
        noUdAccount: true,
        error: null,
        purchaseUrl,
        manageUrl,
      };
    }
    return {
      connected: true,
      email,
      subscription: null,
      balance: null,
      noUdAccount: false,
      error: formatErrorMessage(rejectedReason),
      purchaseUrl,
      manageUrl,
    };
  }

  return {
    connected: true,
    email,
    subscription: subscriptionResult.value,
    balance: scopeAiCreditsBalanceToWorkOwner(balanceResult.value, owner),
    noUdAccount: false,
    error: null,
    purchaseUrl,
    manageUrl,
  };
}

/**
 * Read the connected cloud account's entitlements via `GET /api/v1/entitlements`
 * (CAN-1037 / T21): a plain projection of the `data_sync_control` capability
 * (it no longer gates sharing) and the subscription display projection (plan /
 * trial / manageable org) that drives the sidebar subscription pill. Reading
 * entitlements never rewrites sharing preferences. Never throws: a
 * transient failure resolves with `resolved: false` (caller keeps
 * last-known-good), and an unlinked account (404) resolves with `resolved: true`
 * and no grant (`canDisableSharing: false`, `source: 'none'`, null fields).
 */
export async function loadCanopyCloudEntitlements(
  scope?: AiCreditsScopeRequest,
): Promise<CanopyCloudEntitlementsState> {
  // Personal model-library access rides on the same response (CAN-4028). It is
  // resolved against the account saved for the whole request, and survives a
  // transient failure as the last valid answer for that same account — so it
  // is reported on the unresolved branch too.
  const {
    probe,
    modelLibrary,
    accountKey: modelLibraryAccountKey,
    workModelLibrary,
    ownerKey: modelLibraryOwnerKey,
  } = await probeEntitlementsWithModelLibrary(
    scope ? await resolveAiCreditsScopeOwner(scope) : undefined,
  );
  const contextualAccess = scope
    ? {
        workModelLibrary: workModelLibrary ?? ({ status: 'unknown' } as const),
        ...(modelLibraryOwnerKey ? { modelLibraryOwnerKey } : {}),
      }
    : {};
  if (!probe.resolved) {
    return {
      resolved: false,
      canDisableSharing: false,
      canRemoteControl: false,
      source: 'none',
      plan: null,
      trial: null,
      billingManageableOrg: null,
      displayPlan: null,
      billingPresentation: null,
      modelLibrary,
      modelLibraryAccountKey,
      ...contextualAccess,
    };
  }
  return {
    resolved: true,
    canDisableSharing: probe.canDisableSharing,
    canRemoteControl: probe.canRemoteControl,
    source: probe.source,
    plan: probe.plan,
    trial: probe.trial,
    billingManageableOrg: probe.billingManageableOrg,
    displayPlan: probe.displayPlan,
    billingPresentation: probe.billingPresentation,
    freeAccess: probe.freeAccess,
    modelLibrary,
    modelLibraryAccountKey,
    ...contextualAccess,
  };
}

/** Read the connected account's live, revocable mobile activation signal. */
export async function loadCanopyCloudMobileActivation(
  options: MobileActivationLoadOptions = {},
): Promise<MobileActivationState> {
  const probe = await probeMobileActivation(options);
  return probe.resolved
    ? {
        resolved: true,
        hasMobileActivation: probe.hasMobileActivation,
      }
    : { resolved: false, hasMobileActivation: false };
}

/** No-coverage `OrgAiCreditsSpendable` used when the org read fails or 404s. */
function noOrgSpendableCoverage(): OrgAiCreditsSpendable {
  return {
    hasSpendableHeadroom: false,
    hasBalanceNow: false,
    canReplenish: false,
    orgCreditPoolCapable: false,
    balanceCredits: 0,
    balanceUsd: 0,
    hasPaymentMethodOnFile: false,
    billingActive: false,
  };
}

/**
 * Read one org's spendable AI-credit headroom from the cloud
 * (`/api/v1/{apiNamespace}/organizations/{orgId}/billing/credits/spendable`).
 * Never throws: a 404 (native billing disabled / non-member) or any transient
 * failure degrades to no coverage so the usage-exhausted CTA still resolves.
 * (CAN-1235)
 */
export async function loadOrgAiCreditsSpendable(
  orgExternalId: string,
): Promise<OrgAiCreditsSpendable> {
  // Per-org billing gate (CAN-2311): an org that has lost the `teams`
  // capability no longer funds its members, so it reports no coverage rather
  // than a balance the gateway would refuse to spend. This is the single
  // chokepoint for the org credit pool — `loadNativeAiCreditsAvailability`
  // (and, through it, `getAiCreditsRoutingContext` in
  // `agents/ai-credits-routing.ts`) both compose their org signals from this
  // call, so gating here keeps the decision keyed to ONE org id and leaves a
  // member's other, healthy orgs spending normally.
  //
  // The SERVER is the authority here, and it is asked unconditionally. The
  // local `orgBillingStates` snapshot is deliberately NOT consulted first:
  // it refreshes on a ~20-minute background interval, so short-circuiting on
  // it would keep reporting "no coverage" to a customer who has already
  // restored billing for up to that long — spending their own money and being
  // told they cannot. The spendable endpoint refuses a genuinely lapsed org on
  // its own, so asking costs one request and removes the staleness window
  // entirely. The cached verdict still drives the lapse UI (banners, share
  // targeting); it is advisory state, not routing state.
  return (await probeOrgAiCreditsSpendable(orgExternalId)).spendable;
}

/**
 * Resolution-aware core of {@link loadOrgAiCreditsSpendable}.
 *
 * The all-false payload this returns on failure is INDISTINGUISHABLE from a
 * genuine "this org funds nothing" answer, and that ambiguity is not harmless:
 * `resolveAiCreditsCoverage` suppresses the purchase CTA only when the
 * consolidated availability is marked `inconclusive`, so a transient failure
 * here would otherwise classify a healthy org member as self-serve and invite
 * them to buy personal credits they do not need. `resolved` is what lets the
 * composition above tell those two cases apart; the exported wrapper keeps its
 * simpler never-throws shape for callers that only need coverage.
 */
async function probeOrgAiCreditsSpendable(
  orgExternalId: string,
): Promise<{ spendable: OrgAiCreditsSpendable; resolved: boolean }> {
  try {
    const spendable = await requestCanopyCloudJson<OrgAiCreditsSpendable>(
      `/api/v1/${BRAND.web.apiNamespace}/organizations/${orgExternalId}/billing/credits/spendable`,
    );
    return { spendable, resolved: true };
  } catch (error) {
    // A 404 is an ANSWER, not a failure. The endpoint returns it when native
    // billing is disabled for the org or the caller is not a member, which is
    // exactly "this org funds nothing" — the same reading the UD-account
    // composition above already gives a 404. Marking it unresolved makes the
    // whole availability payload `inconclusive`, which suppresses the purchase
    // CTA and shows "we couldn't check your account" — a state the user can
    // never clear, because every retry returns 404 again.
    if (error instanceof CanopyCloudClientError && error.status === 404) {
      return { spendable: noOrgSpendableCoverage(), resolved: true };
    }
    // Offline or the request failed. Report no coverage rather than throwing —
    // this is the "never throws" contract the callers below rely on — but say
    // so, since "we could not ask" must not read as "the org has nothing".
    return { spendable: noOrgSpendableCoverage(), resolved: false };
  }
}

/**
 * Consolidated native-billing availability signal for the usage-exhausted CTA
 * and the model picker (CAN-1235). Composes the source-agnostic personal balance
 * eligibility (native Canopy ledger OR already-linked UD mirror; the
 * `noUdAccount` blocker is intentionally ignored — we never promote UD linking)
 * with per-org spendable headroom for each of the signed-in account's orgs.
 * Never throws: a disconnected account or transient failure yields an all-false,
 * uncovered payload so the renderer always has a usable answer.
 */
export async function loadNativeAiCreditsAvailability(
  owner?: WorkOwner,
): Promise<NativeAiCreditsAvailability> {
  const pricingUrl = `${getCanopyCloudBaseUrl()}/pricing`;
  // `inconclusive` marks the payload as defaults rather than observations. A
  // signed-out account is a real answer (nothing can pay), so only the failure
  // paths set it.
  const uncovered = (opts?: {
    inconclusive?: boolean;
  }): NativeAiCreditsAvailability => ({
    personalEligible: false,
    inOrg: false,
    orgCreditPoolCovered: false,
    orgSpendable: false,
    pricingUrl,
    ...(opts?.inconclusive ? { inconclusive: true } : {}),
  });

  // Honor the "never throws" contract for the whole body: a disconnected
  // account, a decrypt/store failure, or a transient cloud error all degrade to
  // the all-false uncovered payload so the renderer always has a usable answer.
  try {
    const account = toPublicCanopyCloudAccountState(
      await loadCanopyCloudAccount(),
    );
    if (!account.hasApiKey) {
      return uncovered();
    }

    const ownerOrganization =
      owner?.kind === 'organization'
        ? (account.organizations ?? []).find(
            (org) => org.id === owner.organizationId,
          )
        : undefined;
    const orgExternalIds = ownerOrganization ? [ownerOrganization.id] : [];
    const [credits, orgProbes] = await Promise.all([
      loadCanopyCloudAiCredits(owner),
      Promise.all(orgExternalIds.map((id) => probeOrgAiCreditsSpendable(id))),
    ]);
    const orgSpendables = orgProbes.map((probe) => probe.spendable);
    // An org probe that never resolved contributes an all-false payload that is
    // shaped exactly like real absence of coverage. Marking the consolidated
    // read inconclusive keeps the renderer from turning "we could not ask your
    // org" into "your org has nothing, go buy your own credits".
    const orgReadsResolved = orgProbes.every((probe) => probe.resolved);
    // The personal ledger needs the SAME treatment for the same reason:
    // `loadCanopyCloudAiCredits` reports a transient subscription/balance
    // failure as `balance: null` plus a non-null `error`, which would otherwise
    // collapse to `personalEligible: false` with no marker — so a funded user
    // with no orgs gets a purchase CTA on a read that simply failed. Keyed on
    // `error`, NOT `noUdAccount`: a 404 "no UD account" is a real, conclusive
    // answer and must stay conclusive.
    const personalReadResolved = credits.error === null;
    const personalEligible = credits.balance?.eligible ?? false;
    const orgSpendable = orgSpendables.some(
      (spendable) => spendable.hasSpendableHeadroom,
    );
    /**
     * Only an unresolved read that could still CHANGE the answer is worth
     * degrading the whole payload for.
     *
     * `inconclusive` is checked before `personalEligible`/`orgSpendable` in
     * `resolveAiCreditsCoverage`, so marking it unconditionally would suppress
     * `canSpendCredits` for someone we have already positively confirmed can
     * pay — costing a paying user the "switch and resume on AI Credits" offer
     * during an unrelated org outage. Once coverage is established, a failed
     * probe elsewhere cannot un-establish it.
     */
    const definitelyCovered = personalEligible || orgSpendable;
    const readsInconclusive =
      !definitelyCovered && !(orgReadsResolved && personalReadResolved);

    return {
      // Source-agnostic: `eligible` is reported against whichever ledger is
      // active (native OR already-linked UD). Ignore `noUdAccount` — the CTA no
      // longer surfaces UD linking as a path.
      personalEligible,
      inOrg: orgExternalIds.length > 0,
      orgCreditPoolCovered: orgSpendables.some(
        (spendable) => spendable.orgCreditPoolCapable,
      ),
      orgSpendable,
      ...(ownerOrganization
        ? {
            ownerOrganization: {
              id: ownerOrganization.id,
              name: ownerOrganization.name,
            },
          }
        : {}),
      // The pool balance, only from a read that actually reached the pool: a
      // 404 resolves to an all-zero payload that is not a real balance. Member
      // responses omit the balance without changing spendability classification.
      ...(ownerOrganization &&
      orgProbes[0]?.resolved &&
      orgProbes[0].spendable.orgCreditPoolCapable &&
      typeof orgProbes[0].spendable.balanceCredits === 'number' &&
      Number.isFinite(orgProbes[0].spendable.balanceCredits)
        ? {
            ownerOrganizationBalanceCredits:
              orgProbes[0].spendable.balanceCredits,
          }
        : {}),
      pricingUrl,
      ...(readsInconclusive ? { inconclusive: true } : {}),
    };
  } catch {
    return uncovered({ inconclusive: true });
  }
}

function parseAiCreditsScopeRequest(
  value: unknown,
): AiCreditsScopeRequest | null {
  if (value === undefined) return { kind: 'navigation' };
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'navigation') return { kind: 'navigation' };
  if (
    candidate.kind !== 'work' ||
    typeof candidate.projectId !== 'string' ||
    candidate.projectId.length === 0 ||
    (candidate.worktreeId !== undefined &&
      (typeof candidate.worktreeId !== 'string' ||
        candidate.worktreeId.length === 0)) ||
    (candidate.chatId !== undefined &&
      (typeof candidate.chatId !== 'string' ||
        candidate.chatId.length === 0)) ||
    (candidate.chatId !== undefined && candidate.worktreeId === undefined)
  ) {
    return null;
  }
  try {
    validateId(candidate.projectId, 'projectId');
    if (candidate.worktreeId !== undefined) {
      validateId(candidate.worktreeId, 'worktreeId');
    }
    if (candidate.chatId !== undefined) {
      validateId(candidate.chatId, 'chatId');
    }
  } catch {
    // Invalid renderer input is intentionally wallet-only: never let it reach
    // the owner resolver, whose identifiers select persisted workspace state.
    return null;
  }
  return {
    kind: 'work',
    projectId: candidate.projectId,
    ...(typeof candidate.worktreeId === 'string'
      ? { worktreeId: candidate.worktreeId }
      : {}),
    ...(typeof candidate.chatId === 'string'
      ? { chatId: candidate.chatId }
      : {}),
  };
}

function failedCanopyCloudStatus(
  error: string,
  secureStorageFailure?: SecureStorageFailure,
): CanopyServerStatus {
  return {
    authenticated: false,
    capabilities: [],
    missingCapabilities: [...REQUIRED_CANOPY_CLOUD_CAPABILITIES],
    account: null,
    organizations: [],
    teams: [],
    error,
    ...(secureStorageFailure ? { secureStorageFailure } : {}),
  };
}

async function bestEffortRevokeOAuthDesktopKey(
  entry: CanopyCloudAccountEntry | null,
  reason: string,
): Promise<void> {
  if (entry?.credentialSource !== 'oauth_desktop') {
    return;
  }

  try {
    await revokeCurrentOAuthDesktopKey(entry.apiKey);
  } catch (error) {
    process.stderr.write(
      `[settings] Failed to revoke ${CLOUD_DISPLAY_NAME} OAuth key during ${reason}: ${formatErrorMessage(error)}\n`,
    );
  }
}

// Guest preparation precedes the loopback listener, so its cancellation must
// be registered before the first await in the IPC handler as well.
let pendingOAuthPreparation: AbortController | null = null;

function awaitOAuthPreparation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('OAuth login cancelled.'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    // A shared guest mint must finish for its other callers. Abandon only this
    // login's wait, and consume late completion without continuing sign-in.
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * After disconnecting a real Canopy Cloud account, fall back to an anonymous
 * guest session so the app is never left credential-less. A fully-signed-out
 * state dead-ends contextual features (AI Credits / UD linking) with no
 * actionable control, so in guest-mode builds "signed out" should mean
 * "anonymous guest", not "no identity at all".
 *
 * Only mints when guest mode is enabled and the user has already accepted the
 * terms: an explicit guest consent, or the first-run legal consent (same ToS),
 * which is recorded as guest consent so the guest record is explicit and future
 * guest mints are satisfied. Best-effort: any failure (guest mode off, no
 * recorded consent, offline mint) returns `null` and leaves the disconnected
 * state intact.
 */
async function restoreGuestSessionAfterDisconnect(): Promise<CanopyCloudAccountPublicState | null> {
  try {
    if (
      !getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key,
      )
    ) {
      return null;
    }

    const prefs = await readPreferencesFile();
    if (!prefs.guestConsentAcceptedAt) {
      // No explicit guest consent, but the first-run legal consent covers the
      // same terms — treat it as the guest-consent basis.
      if (!prefs.legalConsentAcceptedAt) {
        return null;
      }
      // Record it as guest consent so future guest mints are satisfied.
      // Best-effort: a bookkeeping write failure must not block restoring the
      // guest session (the mint below does not itself depend on it).
      try {
        await writePreferencesFile({
          guestConsentAcceptedAt: prefs.legalConsentAcceptedAt,
          guestConsentTosVersion:
            prefs.legalConsentTosVersion ?? prefs.guestConsentTosVersion,
        });
      } catch (writeError) {
        process.stderr.write(
          `[settings] Failed to record guest consent from legal consent: ${formatErrorMessage(writeError)}\n`,
        );
      }
    }

    const { mintGuest } = await import('../canopy-cloud/guest-auth');
    const result = await mintGuest();
    if (result.status.capabilities.includes(MEMORY_SEARCH_CAPABILITY)) {
      await reprobeAndApplyCanopyCloudEnforcedSettings();
      result.account = toPublicCanopyCloudAccountState(
        await loadCanopyCloudAccount(),
      );
    }
    refreshFeatureFlagContextAfterSettingsChange(
      `${CLOUD_DISPLAY_NAME} guest fallback`,
    );
    return result.account;
  } catch (error) {
    process.stderr.write(
      `[settings] ${CLOUD_DISPLAY_NAME} guest fallback after disconnect failed: ${formatErrorMessage(error)}\n`,
    );
    return null;
  }
}

export async function disconnectCanopyCloudAccount(): Promise<CanopyCloudAccountPublicState> {
  // Guest credentials are device-scoped and cannot be re-minted in the same
  // state once destroyed, so a disconnect must never delete one. Return the
  // existing guest state unchanged (no-op) instead of clearing + re-minting.
  // Guard on either guest signal (shared `isGuestAccount`): a guest is minted
  // with both `credentialSource: 'guest'` and `authMode: 'guest'`, but
  // legacy/normalized entries can carry `authMode: 'guest'` without
  // `credentialSource: 'guest'`, and failing open here would irreversibly
  // destroy the guest token.
  // The guard and local deletion are one account-store operation. Guest minting
  // uses the same lock, so a guest committed while disconnect is queued cannot
  // be deleted after this check.
  const clearResult = await clearCanopyCloudAccountUnlessGuest((persist) =>
    getSharedContainerReconciliationService().withReplicaPurgeFence(persist),
  );
  if (clearResult.status === 'guest-protected') {
    return toPublicCanopyCloudAccountState(clearResult.account);
  }
  const previousAccount = clearResult.previousAccount;
  await bestEffortRevokeOAuthDesktopKey(previousAccount, 'disconnect');
  await applyLocalCloudIdentityTeardown(`${CLOUD_DISPLAY_NAME} disconnect`);

  // In guest-mode builds, drop back to an anonymous guest session rather than
  // leaving the app credential-less (which would dead-end AI Credits / UD
  // linking with no actionable control). Falls through to signed-out when a
  // guest cannot be minted.
  const guestState = await restoreGuestSessionAfterDisconnect();
  if (guestState) {
    return guestState;
  }

  return toPublicCanopyCloudAccountState(null);
}

async function applyLocalCloudIdentityTeardown(reason: string): Promise<void> {
  invalidateMobileActivationCache();
  refreshFeatureFlagContextAfterSettingsChange(reason);
  await applyEnforcedSettings(toPublicCanopyCloudAccountState(null));
}

async function resetUnreadableCloudAccount(): Promise<ResetUnreadableCanopyCloudAccountResult> {
  const result = await resetUnreadableCanopyCloudAccount((persist) =>
    getSharedContainerReconciliationService().withReplicaPurgeFence(persist),
  );
  // A prior recovery attempt may have renamed the credential successfully and
  // then failed during local teardown. Its retry observes an absent file and
  // returns `not-needed`; repeat the idempotent teardown for that conclusive
  // signed-out state so enforced policy cannot remain stranded indefinitely.
  // A readable replacement account must never be torn down.
  if (result.status === 'reset' || !result.account.hasApiKey) {
    await applyLocalCloudIdentityTeardown(
      `${CLOUD_DISPLAY_NAME} unreadable credential reset`,
    );
  }
  return result;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function logLinearSearchError(error: unknown): void {
  const details = isLinearApiError(error)
    ? `operation=${error.operation} status=${error.status ?? 'null'} type=${error.type}`
    : 'type unknown';
  process.stderr.write(
    `[settings] Failed to search Linear issues: ${details}\n`,
  );
}

function mapLinearIssueSearchResult(
  issue: LinearIssueSearchResult,
): LinearTicketSearchResult {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    url: issue.url,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    branchName: issue.branchName,
  };
}

async function withLinearIssueAttachments(
  token: string,
  result: LinearTicketSearchResult,
): Promise<LinearTicketSearchResult> {
  try {
    // Bounded to one page of 50. A further page is incomplete evidence, never
    // proof that this issue belongs to the one repository found so far.
    const payload = await readLinearIssueAttachments(token, result.id);
    return {
      ...result,
      attachments: payload.attachments.map((attachment) => ({
        url: attachment.url,
        ...(attachment.sourceType !== undefined
          ? { source: attachment.sourceType }
          : {}),
        ...(attachment.title !== undefined ? { title: attachment.title } : {}),
      })),
      attachmentsComplete: payload.complete,
    };
  } catch (error: unknown) {
    logLinearSearchError(error);
    return { ...result, attachmentsComplete: false };
  }
}

function credentialReadResult(
  result: StoredSecretReadResult<string>,
): string | CredentialReadFailure {
  if (result.status === 'ok') return result.value ?? '';
  if (result.status === 'error')
    return { success: false, error: "Couldn't read saved credentials." };
  return {
    success: false,
    error: 'Secure storage unavailable',
    secureStorageFailure: result.failure,
  };
}

function credentialStorageFailure(
  error: unknown,
): CredentialReadFailure | null {
  const secureStorageFailure = getSecureStorageFailure(error);
  return secureStorageFailure
    ? {
        success: false,
        error: 'Secure storage unavailable',
        secureStorageFailure,
      }
    : null;
}

async function loadGitHubPat(): Promise<string | CredentialReadFailure> {
  return credentialReadResult(await readStoredPatWithStatus());
}

async function loadLinearToken(): Promise<string | CredentialReadFailure> {
  const result = await readStoredLinearTokenWithStatus();
  if (result.status === 'ok' && !result.value) return resolveLinearToken();
  return credentialReadResult(result);
}

async function validateLinearToken(token: string): Promise<LinearStatus> {
  const normalized = token.trim();
  if (!normalized) {
    return { authenticated: false, displayName: null, error: null };
  }
  try {
    const viewer = await readLinearViewer(normalized);
    return {
      authenticated: true,
      displayName: viewer.displayName ?? viewer.name,
      error: null,
    };
  } catch {
    return {
      authenticated: false,
      displayName: null,
      error: 'Invalid API key or unable to reach Linear.',
    };
  }
}

/**
 * `rejected` is narrower than `!valid` on purpose, and the difference is
 * load-bearing.
 *
 * `resolveOrgGatewayCredential` REFUSES to route any turn while the stored
 * record carries a `lastError`, so only a verdict the GATEWAY itself returned
 * about the key (401/403) may be persisted there. A flaky network, a timeout,
 * or a gateway that simply does not serve `/v1/models` would otherwise write a
 * durable block and leave the member stuck behind "Add a current organization
 * gateway key" with a key that is perfectly good. Those still surface inline in
 * Settings through `error`; they just do not outlive the save.
 */
interface ModelGatewayCredentialProbe extends ModelGatewayCredentialValidation {
  rejected: boolean;
}

async function probeModelGatewayCredential(
  input: ModelGatewayCredentialInput,
): Promise<ModelGatewayCredentialProbe> {
  await authorizeModelGatewayCredential(input.organizationId, input.baseUrl);
  const result = await probeModelGateway(input);
  return {
    valid: result.status === 'connected',
    rejected: result.status === 'unauthorized',
    error:
      result.status === 'connected'
        ? null
        : result.status === 'invalid_url'
          ? 'The gateway URL is invalid.'
          : result.status === 'key_required'
            ? 'Enter a gateway API key.'
            : result.status === 'unauthorized'
              ? 'The gateway rejected this API key.'
              : 'Unable to reach the AI gateway.',
  };
}

async function validateModelGatewayCredential(
  input: ModelGatewayCredentialInput,
): Promise<ModelGatewayCredentialValidation> {
  const { valid, error } = await probeModelGatewayCredential(input);
  return { valid, error };
}

const modelGatewayCredentialSaveQueues = new Map<string, Promise<void>>();
// A completed write supersedes older reads, including their final owner check.
const modelGatewayCredentialSaveGenerations = new Map<string, number>();

function gatewayCredentialSaveGeneration(scope: string | null): number {
  return scope === null
    ? 0
    : (modelGatewayCredentialSaveGenerations.get(scope) ?? 0);
}

function advanceGatewayCredentialSaveGeneration(scope: string | null): void {
  if (scope !== null)
    modelGatewayCredentialSaveGenerations.set(
      scope,
      gatewayCredentialSaveGeneration(scope) + 1,
    );
}

export function enqueueModelGatewayCredentialSave<T>(
  organizationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = modelGatewayCredentialSaveQueues.get(organizationId);
  const result = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  modelGatewayCredentialSaveQueues.set(organizationId, tail);
  void tail.finally(() => {
    if (modelGatewayCredentialSaveQueues.get(organizationId) === tail) {
      modelGatewayCredentialSaveQueues.delete(organizationId);
    }
  });
  return result;
}

async function readGatewayConnectionScope(
  organizationId: string,
): Promise<string | null> {
  try {
    const account = await loadCanopyCloudAccount();
    return JSON.stringify([
      account?.account?.id.trim() ?? null,
      organizationId,
    ]);
  } catch {
    // Analytics must not affect credential reads or durable saves.
    return null;
  }
}

async function observeGatewayConnection(
  organizationId: string,
  scope: string | null,
  apiKey: string,
  baseUrl: string,
  via: 'read' | 'in_app',
  baselineOnly = false,
  readGeneration?: number,
): Promise<void> {
  if (
    scope === null ||
    scope !== (await readGatewayConnectionScope(organizationId)) ||
    (readGeneration !== undefined &&
      readGeneration !== gatewayCredentialSaveGeneration(scope))
  )
    return;
  observeProviderConnection({
    provider: 'model_gateway',
    connectionMethod: 'api_key',
    via,
    baselineOnly,
    scope,
    fingerprint: apiKey
      ? createHash('sha256')
          .update(JSON.stringify([baseUrl, apiKey]))
          .digest('hex')
      : null,
  });
}

export async function saveModelGatewayCredentialInOrder(
  input: ModelGatewayCredentialInput,
  options: {
    signal?: AbortSignal;
    beforeSave?: () => Promise<void>;
    expectedAccountId?: string;
  } = {},
): Promise<ModelGatewayCredentialValidation> {
  options.signal?.throwIfAborted();
  const authorized = await authorizeModelGatewayCredential(
    input.organizationId,
    input.baseUrl,
  );
  if (
    options.expectedAccountId !== undefined &&
    authorized.accountId !== options.expectedAccountId
  )
    throw new Error('Gateway account changed');
  const scope = await readGatewayConnectionScope(input.organizationId);
  const readGeneration = gatewayCredentialSaveGeneration(scope);
  let previous: Awaited<ReturnType<typeof loadModelGatewayCredential>> = null;
  try {
    previous = await loadModelGatewayCredential(input.organizationId);
    await observeGatewayConnection(
      input.organizationId,
      scope,
      previous && previous.validated !== false && !previous.lastError
        ? previous.apiKey
        : '',
      previous?.baseUrlAtSave ?? '',
      'read',
      previous?.validated === undefined,
      readGeneration,
    );
  } catch {
    // Analytics baseline collection must not block replacing an unreadable key.
    // The existing validation and durable writer still decide the save result.
  }
  const normalizedInput = {
    ...input,
    baseUrl: normalizeModelGatewayBaseUrl(input.baseUrl) ?? input.baseUrl,
  };
  if (!input.apiKey.trim()) {
    await saveModelGatewayCredential({
      organizationId: input.organizationId,
      apiKey: '',
      expectedAccountId: authorized.accountId,
      baseUrlAtSave: normalizedInput.baseUrl,
    });
    advanceGatewayCredentialSaveGeneration(scope);
    await observeGatewayConnection(
      input.organizationId,
      scope,
      '',
      normalizedInput.baseUrl,
      'in_app',
    );
    await bestEffortInvalidateModelGatewayAuthSessions();
    return { valid: false, error: null };
  }
  const probe = await probeModelGatewayCredential(normalizedInput);
  options.signal?.throwIfAborted();
  // A failed replacement never destroys a working key or changes its endpoint.
  if (!probe.valid) return { valid: false, error: probe.error };
  await options.beforeSave?.();
  options.signal?.throwIfAborted();
  await saveModelGatewayCredential({
    organizationId: input.organizationId,
    apiKey: input.apiKey,
    expectedAccountId: authorized.accountId,
    signal: options.signal,
    baseUrlAtSave: normalizedInput.baseUrl,
    lastValidatedAt: new Date().toISOString(),
    // A temporary outage cannot invalidate a prior success for the same key.
    // Rejections and credential changes still require a fresh validation.
    validated:
      probe.valid ||
      (!probe.rejected &&
        previous?.validated === true &&
        !previous.lastError &&
        previous.apiKey.trim() === input.apiKey.trim() &&
        normalizeModelGatewayBaseUrl(previous.baseUrlAtSave) ===
          normalizedInput.baseUrl),
    // Only a gateway-issued rejection becomes the durable block routing
    // reads; see `probeModelGatewayCredential`.
    lastError: probe.rejected ? (probe.error ?? undefined) : undefined,
  });
  advanceGatewayCredentialSaveGeneration(scope);
  if (probe.valid)
    await observeGatewayConnection(
      input.organizationId,
      scope,
      input.apiKey.trim(),
      normalizedInput.baseUrl,
      'in_app',
    );
  else
    recordProviderConnectionFailure(
      'model_gateway',
      'api_key',
      probe.rejected ? 'authentication' : 'network',
    );
  await bestEffortInvalidateModelGatewayAuthSessions();
  return { valid: probe.valid, error: probe.error };
}

async function bestEffortInvalidateModelGatewayAuthSessions(): Promise<void> {
  try {
    const { invalidateProviderAuthSessions } =
      await import('../agents/session-manager');
    await Promise.all(
      (['claude', 'codex'] as const).map((provider) =>
        invalidateProviderAuthSessions(
          provider,
          'model-gateway-credential-changed',
          { activeTurnPolicy: 'preserve' },
        ),
      ),
    );
  } catch (error) {
    process.stderr.write(
      `[settings] Failed to invalidate model gateway auth sessions after save: ${error instanceof Error ? error.name : 'unknown'}\n`,
    );
  }
}

/**
 * Delete this device's stored key for an organization whose gateway a hosted
 * settings write just removed, so a later connect to the same endpoint asks
 * for the key again instead of silently reusing it. Serialized with connect
 * and save for the organization; skipped when the account that authorized the
 * write is no longer the signed-in account.
 *
 * Waiting behind an in-flight connect or save, key probe included, is the
 * point: run beside it, that connect could store the removed gateway's key
 * after this clear. The wait is bounded by the probe's own 10 second timeout,
 * so at worst the removal's response, and the dialog's busy state, waits that
 * long.
 */
export async function clearModelGatewayCredentialForRemovedGateway(
  organizationId: string,
  expectedAccountId: string,
): Promise<boolean> {
  return enqueueModelGatewayCredentialSave(organizationId, async () => {
    const scope = await readGatewayConnectionScope(organizationId);
    const result = await clearModelGatewayCredential(
      organizationId,
      expectedAccountId,
    );
    if (result === 'unauthorized') {
      logMainProcessWarn(
        '[settings] Skipped removed AI gateway key clear for an unauthorized account',
        { organizationId },
      );
      return false;
    }
    // Fence a connect that started before the removal even when no key was
    // stored; only a deleted key needs sessions and windows to re-read it.
    advanceGatewayCredentialSaveGeneration(scope);
    if (result === 'nothing-to-clear') return true;
    await bestEffortInvalidateModelGatewayAuthSessions();
    sendToAllWindows(
      IPC_CHANNELS.modelGatewayCredentialChanged,
      organizationId,
    );
    return true;
  });
}

async function searchLinearIssues(
  query: string,
): Promise<LinearTicketSearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const identifier =
    parseLinearIdentifier(normalizedQuery) ??
    parseLinearIdentifier(normalizedQuery.toUpperCase());

  const token = (await resolveLinearToken()).trim();
  if (!token) {
    if (identifier) throw new Error('Connect Linear to look up this issue.');
    return [];
  }

  try {
    const issues = await searchLinearApiIssues(
      token,
      identifier ?? normalizedQuery,
    );

    // Keyword autocomplete keeps its existing single-request behavior. Fetch
    // evidence only for the exact identifier, never a fuzzy search neighbor.
    const exactIssues = identifier
      ? issues.filter((issue) => issue.identifier.toUpperCase() === identifier)
      : [];
    const otherIssues = identifier
      ? issues.filter((issue) => issue.identifier.toUpperCase() !== identifier)
      : issues;
    const results = [...exactIssues, ...otherIssues]
      .slice(0, 20)
      .map(mapLinearIssueSearchResult);
    return await Promise.all(
      results.map(
        (result): Promise<LinearTicketSearchResult> =>
          identifier && result.identifier.toUpperCase() === identifier
            ? withLinearIssueAttachments(token, result)
            : Promise.resolve(result),
      ),
    );
  } catch (error: unknown) {
    logLinearSearchError(error);
    if (identifier) {
      if (
        isLinearApiError(error) &&
        (error.type === 'authentication' || error.type === 'forbidden')
      ) {
        throw Object.defineProperty(
          new Error('Reconnect Linear to look up this issue.'),
          'cause',
          { value: error, configurable: true },
        );
      }
      if (isLinearApiError(error) && error.type === 'ratelimited') {
        throw Object.defineProperty(
          new Error('Linear is rate limiting requests. Try again shortly.'),
          'cause',
          { value: error, configurable: true },
        );
      }
      throw Object.defineProperty(
        new Error('Couldn’t reach Linear. Try again.'),
        'cause',
        { value: error, configurable: true },
      );
    }
    return [];
  }
}

async function saveLinearToken(token: string): Promise<void> {
  const normalized = token.trim();
  const filePath = getLinearTokenFilePath();

  if (!normalized) {
    await rm(getLegacyLinearTokenFilePath(), { force: true }).catch(
      (error: unknown) => {
        if (!isMissingFileError(error)) throw error;
      },
    );
    try {
      await rm(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return;
  }

  const encrypted = getSecretStoragePolicy().encrypt(normalized);
  await mkdir(dirname(filePath), { recursive: true });
  getSecretStoragePolicy().assertCanWrite();
  await writeFileAtomically(filePath, encrypted, { mode: 0o600 });
  await rm(getLegacyLinearTokenFilePath(), { force: true }).catch(
    () => undefined,
  );
}

/**
 * Attach the Environments-supplied-credential fact to a provider auth status.
 *
 * The probe runs with the Environments injector disabled, so a user whose
 * `ANTHROPIC_API_KEY` (or Bedrock/Vertex redirect, or the Codex equivalent)
 * arrives through Canopy Environments reads as signed out. Main already ORs
 * this fact into lane availability; without shipping it to the renderer the two
 * disagree for that user and the composer shows a dead-end banner for a chat
 * whose sends all succeed.
 *
 * Global runtime slot only — see `AgentProviderAuthStatus.userSuppliedCredential`.
 */
function withUserSuppliedCredentialFlag(
  provider: 'claude' | 'codex',
  status: AgentProviderAuthStatus,
): AgentProviderAuthStatus {
  if (status.authenticated) return status;
  return hasUserSuppliedProviderCredential(provider)
    ? { ...status, userSuppliedCredential: true }
    : status;
}

/** The Settings API key save, shared with App Advisor (CAN-6008). */
export async function saveCanopyCloudApiKeyForWindow(request: {
  apiKey: string;
}): Promise<{
  status: CanopyServerStatus;
  account: CanopyCloudAccountPublicState;
}> {
  const previousRead = await readCanopyCloudAccountWithStatus();
  if (previousRead.status !== 'ok') {
    if (!previousRead.secureStorageFailure) throw previousRead.error;
    return {
      status: failedCanopyCloudStatus(
        CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR,
        previousRead.secureStorageFailure,
      ),
      account: toPublicCanopyCloudAccountState(
        null,
        previousRead.status,
        previousRead.secureStorageFailure,
      ),
    };
  }
  const previousAccount = previousRead.entry;
  const previousPublic = toPublicCanopyCloudAccountState(previousAccount);
  const apiKey = String(request?.apiKey ?? '').trim();
  if (!apiKey) {
    return {
      status: failedCanopyCloudStatus(
        `${CLOUD_DISPLAY_NAME} API key is required.`,
      ),
      account: previousPublic,
    };
  }

  if (!previousPublic.storageAvailable) {
    let secureStorageFailure: SecureStorageFailure | null = null;
    try {
      assertCanopyCloudStorageAvailable();
    } catch (error) {
      secureStorageFailure = getSecureStorageFailure(error);
      if (!secureStorageFailure) throw error;
    }
    return {
      status: failedCanopyCloudStatus(
        CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR,
        secureStorageFailure ?? undefined,
      ),
      account: {
        ...previousPublic,
        ...(secureStorageFailure ? { secureStorageFailure } : {}),
      },
    };
  }

  if (isGuestAccount(previousAccount)) {
    return {
      status: failedCanopyCloudStatus(GUEST_MANUAL_KEY_REPLACEMENT_ERROR),
      account: previousPublic,
    };
  }

  const status = await probeCanopyCloud(apiKey);
  if (
    !status.authenticated ||
    !status.account ||
    status.missingCapabilities.length > 0
  ) {
    return {
      status,
      account: previousPublic,
    };
  }

  const now = new Date().toISOString();
  const nextAccount: CanopyCloudAccountEntry = {
    apiKey,
    authMode: 'api_key',
    credentialSource: 'manual',
    capabilities: status.capabilities,
    ...(status.memorySearchOrganizationExternalId
      ? {
          memorySearchOrganizationExternalId:
            status.memorySearchOrganizationExternalId,
        }
      : {}),
    ...(status.memorySearchOrganizationExternalIds
      ? {
          memorySearchOrganizationExternalIds:
            status.memorySearchOrganizationExternalIds,
        }
      : {}),
    ...(status.personalOrganizationId
      ? { personalOrganizationId: status.personalOrganizationId }
      : {}),
    ...personalGatewayAccountFields(status),
    ...(status.personalModelGatewayEnforcementUnavailable
      ? { personalModelGatewayEnforcementUnavailable: true }
      : {}),
    account: status.account,
    organizations: status.organizations,
    teams: status.teams,
    ...(status.enforcedSettings
      ? { enforcedSettings: status.enforcedSettings }
      : {}),
    telemetryEnforcementUnavailable:
      status.telemetryEnforcementUnavailable === true,
    modelGatewayEnforcementUnavailable:
      status.modelGatewayEnforcementUnavailable === true,
    ...(status.orgBillingStates
      ? { orgBillingStates: status.orgBillingStates }
      : {}),
    createdAt: previousAccount?.createdAt ?? now,
    updatedAt: now,
  };
  let saveResult: Awaited<ReturnType<typeof saveManualCanopyCloudAccount>>;
  try {
    saveResult = await saveManualCanopyCloudAccount(
      nextAccount,
      previousAccount,
      (persist) =>
        getSharedContainerReconciliationService().withReplicaPurgeFence(
          persist,
        ),
      status.organizationsRefreshed
        ? organizationSnapshotTransition(
            status.organizations.map((organization) => organization.id),
            status.personalOrganizationId,
          )
        : undefined,
    );
  } catch (error) {
    const secureStorageFailure = getSecureStorageFailure(error);
    if (!secureStorageFailure) throw error;
    return {
      status: failedCanopyCloudStatus(
        CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR,
        secureStorageFailure ?? undefined,
      ),
      account: {
        ...previousPublic,
        storageAvailable: getSecretStoragePolicy().isWriteAvailable(),
        secureStorageFailure,
      },
    };
  }
  if (saveResult.status === 'guest-protected') {
    return {
      status: failedCanopyCloudStatus(GUEST_MANUAL_KEY_REPLACEMENT_ERROR),
      account: toPublicCanopyCloudAccountState(saveResult.account),
    };
  }
  if (saveResult.status === 'superseded') {
    return {
      status: failedCanopyCloudStatus(SUPERSEDED_MANUAL_KEY_SAVE_ERROR),
      account: toPublicCanopyCloudAccountState(saveResult.account),
    };
  }
  const savedEntry = saveResult.entry;
  invalidateMobileActivationCache();
  await bestEffortRevokeOAuthDesktopKey(
    saveResult.previousAccount,
    'manual save',
  );
  refreshFeatureFlagContextAfterSettingsChange(`${CLOUD_DISPLAY_NAME} save`);

  const publicAccount = toPublicCanopyCloudAccountState(savedEntry);
  await applyEnforcedSettings(publicAccount);

  return {
    status,
    account: publicAccount,
  };
}

/** The Settings browser sign-in, shared with App Advisor (CAN-6008). */
export async function startCanopyCloudOAuthLoginForWindow(): Promise<{
  status: CanopyServerStatus;
  account: CanopyCloudAccountPublicState;
  guestDataMerged?: boolean;
}> {
  const preparation = new AbortController();
  pendingOAuthPreparation?.abort();
  pendingOAuthPreparation = preparation;
  const { signal } = preparation;
  let releaseGuestMints: (() => void) | undefined;
  try {
    const guestAuth = await awaitOAuthPreparation(
      import('../canopy-cloud/guest-auth'),
      signal,
    );
    signal.throwIfAborted();
    const guestMintBarrier = guestAuth.pauseGuestMintsForRealSignIn();
    releaseGuestMints = guestMintBarrier.release;
    // A guest request may have started before this OAuth attempt. Let it
    // settle before taking the account snapshot so its identity can ride
    // the OAuth link ticket. Mints started after the barrier wait for OAuth
    // and then reuse the resulting real account.
    try {
      await awaitOAuthPreparation(
        Promise.resolve(guestMintBarrier.activeGuestMint),
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      process.stderr.write(
        `[settings] Failed to settle in-flight ${CLOUD_DISPLAY_NAME} guest mint before OAuth (continuing): ${formatErrorMessage(error)}\n`,
      );
    }

    signal.throwIfAborted();
    const previousRead = await awaitOAuthPreparation(
      readCanopyCloudAccountWithStatus(),
      signal,
    );
    if (previousRead.status !== 'ok') {
      if (!previousRead.secureStorageFailure) throw previousRead.error;
      return {
        status: failedCanopyCloudStatus(
          CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR,
          previousRead.secureStorageFailure,
        ),
        account: toPublicCanopyCloudAccountState(
          null,
          previousRead.status,
          previousRead.secureStorageFailure,
        ),
      };
    }
    const previousAccount = previousRead.entry;
    signal.throwIfAborted();
    assertCanopyCloudStorageAvailable();
    // CAN-934: when signing in while holding a guest credential, mint a
    // single-use link ticket so the token exchange re-owns the guest's data
    // onto the real user. Best-effort — a failure here fails open (sign-in
    // proceeds with no merge).
    let guestLinkTicket: string | null = null;
    if (isGuestAccount(previousAccount)) {
      try {
        guestLinkTicket = await awaitOAuthPreparation(
          guestAuth.requestGuestLinkTicket(),
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        process.stderr.write(
          `[settings] Failed to mint ${CLOUD_DISPLAY_NAME} guest link ticket (continuing without merge): ${formatErrorMessage(error)}\n`,
        );
      }
    }
    const { startCanopyCloudOAuthLogin } = await awaitOAuthPreparation(
      import('../canopy-cloud/oauth-login'),
      signal,
    );
    signal.throwIfAborted();
    // Transfer cancellation ownership to the loopback flow synchronously.
    if (pendingOAuthPreparation === preparation) {
      pendingOAuthPreparation = null;
    }
    const response = await startCanopyCloudOAuthLogin({ guestLinkTicket });
    invalidateMobileActivationCache();
    if (response.guestDataMerged === true) {
      // The server merged the guest into this account, its mirrored
      // Ledger scopes included, so the guest's local scopes follow (LD02).
      // Only this launch knows the guest's ID: record the rebind durably
      // before reporting the sign-in. It is applied in the background.
      await rebindLedgerGuestScopes(
        previousAccount?.account?.id ?? '',
        response.account.account?.id ?? '',
      );
    }
    // OAuth already persisted and applied the authoritative token snapshot.
    // A second account probe only delays the desktop after confirmation.
    // Revocation targets the captured old key and cannot alter the new one.
    void bestEffortRevokeOAuthDesktopKey(previousAccount, 'OAuth login');
    refreshFeatureFlagContextAfterSettingsChange(
      `${CLOUD_DISPLAY_NAME} OAuth login`,
    );
    return response;
  } catch (error) {
    const secureStorageFailure = getSecureStorageFailure(error);
    if (!secureStorageFailure) throw error;
    const account = await loadCanopyCloudAccountPublicState();
    return {
      status: failedCanopyCloudStatus(
        CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR,
        secureStorageFailure,
      ),
      account: { ...account, secureStorageFailure },
    };
  } finally {
    if (pendingOAuthPreparation === preparation) {
      pendingOAuthPreparation = null;
    }
    releaseGuestMints?.();
  }
}

/** Cancels the pending browser sign-in, shared with App Advisor (CAN-6008). */
export async function cancelCanopyCloudOAuthLoginForWindow(): Promise<void> {
  pendingOAuthPreparation?.abort();
  const { cancelCanopyCloudOAuthLogin } =
    await import('../canopy-cloud/oauth-login');
  cancelCanopyCloudOAuthLogin();
}

/** The Settings API key check, shared with App Advisor (CAN-6008). */
export async function validateCanopyCloudApiKeyForWindow(request: {
  apiKey?: string;
}): Promise<CanopyServerStatus> {
  const status = await validateCanopyCloudApiKey(request);
  if (status.authenticated) {
    refreshFeatureFlagContextAfterSettingsChange(
      `${CLOUD_DISPLAY_NAME} validation`,
    );
  }
  return status;
}

export function registerSettingsHandlers(runtime: {
  dispatcher: CoreIntegrationDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
}): void {
  initializeGitHubPatEnvRuntime();
  registerIpcHandler(
    IPC_CHANNELS.settingsClaudeAuthStatus,
    async (
      _event,
      options?: { forceRefresh?: boolean },
    ): Promise<AgentProviderAuthStatus> =>
      withUserSuppliedCredentialFlag(
        'claude',
        await getCachedClaudeAuthStatusObserved('settings-status', {
          forceRefresh: options?.forceRefresh,
        }),
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsCodexAuthStatus,
    async (
      _event,
      options?: { forceRefresh?: boolean },
    ): Promise<AgentProviderAuthStatus> =>
      withUserSuppliedCredentialFlag(
        'codex',
        await getCachedCodexAuthStatusObserved('settings-status', {
          forceRefresh: options?.forceRefresh,
        }),
      ),
  );

  // What a connected provider carries over from the user's own setup, for
  // the confirmation under its sign-in (CAN-3701). A read, never a write.
  registerIpcHandler(
    IPC_CHANNELS.settingsProviderCarryover,
    async (_event, provider: unknown): Promise<ProviderCarryoverSummary> => {
      if (!isProviderCarryoverProvider(provider))
        throw new Error('Unknown provider for carry-over summary.');
      return summarizeProviderCarryover(provider);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsGitHubCliStatus,
    async (event): Promise<GitHubCliStatus> =>
      getGitHubCliStatus(runtime.dispatcher, runtime.resolveCaller(event)),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsStarSourceRepository,
    async (event): Promise<StarSourceRepositoryResult> =>
      starSourceRepository(runtime.dispatcher, runtime.resolveCaller(event)),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsGitHubPermissions,
    async (
      _event,
      request: GitHubPermissionsRequest,
    ): Promise<GitHubPermissionsStatus> => {
      const source = request?.source;
      if (source !== 'pat' && source !== 'oauth' && source !== 'any') {
        throw new Error(`Invalid github-permissions source: ${String(source)}`);
      }
      return probeGitHubPermissions(source);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsLoadGitHubPat,
    async (): Promise<string | CredentialReadFailure> => loadGitHubPat(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsSaveGitHubPat,
    async (_event, token: string): Promise<CredentialSaveResult> => {
      try {
        await saveGitHubPat(token);
      } catch (error) {
        const failure = credentialStorageFailure(error);
        return (
          failure ?? { success: false, error: "Couldn't save credentials." }
        );
      }
      resetGitHubCredentialState();
      refreshFeatureFlagContextAfterSettingsChange('GitHub token save');
      return { success: true };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsRefreshGitHubCredentials,
    async (event): Promise<void> => {
      resetGitHubCredentialState();
      if (await resolveGitHubToken()) {
        const { resumeChatsAfterGitHubLogin } =
          await import('../lib/auth-failure-resume');
        await resumeChatsAfterGitHubLogin({
          getWindow: () =>
            event?.sender ? BrowserWindow.fromWebContents(event.sender) : null,
        });
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsLoadLinearToken,
    async (): Promise<string | CredentialReadFailure> => loadLinearToken(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsSaveLinearToken,
    async (_event, token: string): Promise<CredentialSaveResult> => {
      try {
        await saveLinearToken(token);
      } catch (error) {
        const failure = credentialStorageFailure(error);
        return (
          failure ?? { success: false, error: "Couldn't save credentials." }
        );
      }
      invalidateLinearTokenCache();
      return { success: true };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsValidateLinearToken,
    async (_event, token: string): Promise<LinearStatus> =>
      validateLinearToken(token),
  );

  registerIpcHandler(
    IPC_CHANNELS.modelGatewayLoadCredential,
    async (
      _event,
      organizationId: string,
      expectedBaseUrl?: string,
    ): Promise<ModelGatewayCredentialState> => {
      if (
        expectedBaseUrl !== undefined &&
        !normalizeModelGatewayBaseUrl(expectedBaseUrl)
      ) {
        throw new Error('Invalid AI gateway endpoint.');
      }
      const scope = await readGatewayConnectionScope(organizationId);
      const readGeneration = gatewayCredentialSaveGeneration(scope);
      let record: Awaited<ReturnType<typeof loadModelGatewayCredential>> = null;
      let secureStorageFailure: SecureStorageFailure | null = null;
      try {
        record = await loadModelGatewayCredential(
          organizationId,
          expectedBaseUrl,
        );
        await observeGatewayConnection(
          organizationId,
          scope,
          record && record.validated !== false && !record.lastError
            ? record.apiKey
            : '',
          record?.baseUrlAtSave ?? '',
          'read',
          record?.validated === undefined,
          readGeneration,
        );
      } catch (error) {
        // Secure storage being unavailable is a renderable state, not an IPC
        // failure: the credential field must stay disabled rather than looking
        // writable and failing only after the member pastes a key. Corrupt/IO
        // errors still reject so callers do not mistake lost data for no key.
        secureStorageFailure = getSecureStorageFailure(error);
        if (
          !secureStorageFailure &&
          !(error instanceof GatewayCredentialStorageUnavailableError)
        ) {
          throw error;
        }
      }
      return {
        organizationId,
        apiKey: record?.apiKey ?? '',
        baseUrlAtSave: record?.baseUrlAtSave ?? '',
        updatedAt: record?.updatedAt,
        lastValidatedAt: record?.lastValidatedAt,
        lastError: record?.lastError,
        storageAvailable: isModelGatewayCredentialStorageAvailable(),
        ...(secureStorageFailure ? { secureStorageFailure } : {}),
      };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.modelGatewayValidateCredential,
    async (
      _event,
      input: ModelGatewayCredentialInput,
    ): Promise<ModelGatewayCredentialValidation> =>
      validateModelGatewayCredential(input),
  );

  registerIpcHandler(
    IPC_CHANNELS.modelGatewaySaveCredential,
    async (
      _event,
      input: ModelGatewayCredentialInput,
    ): Promise<ModelGatewayCredentialValidation> =>
      enqueueModelGatewayCredentialSave(input.organizationId, async () => {
        try {
          return await withProviderConnectionAttempt(
            'model_gateway',
            'api_key',
            undefined,
            () => saveModelGatewayCredentialInOrder(input),
          );
        } catch (error) {
          const secureStorageFailure = getSecureStorageFailure(error);
          if (!secureStorageFailure) throw error;
          return {
            valid: false,
            error: formatErrorMessage(error),
            secureStorageFailure,
          };
        }
      }),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsLoadCanopyCloudAccount,
    // Status-preserving read: a degraded secure-store read must reach the
    // renderer as `read: 'unavailable' | 'error'` rather than as a `null` entry
    // that is indistinguishable from a real sign-out. See
    // `CanopyCloudAccountPublicState.read`.
    async (): Promise<CanopyCloudAccountPublicState> =>
      loadCanopyCloudAccountPublicState(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsGetCanopyCloudBaseUrl,
    (): string | null => {
      try {
        return getCanopyCloudBaseUrl();
      } catch {
        // Base URL not configured (e.g. an unconfigured local build). Callers
        // fall back to plain text rather than rendering a broken legal link.
        return null;
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsOpenAuthenticatedPortalPage,
    // Preserve legacy strings. Every other payload must pass strict validation.
    async (
      _event,
      value: unknown,
    ): Promise<boolean | AuthenticatedPortalResult> =>
      typeof value === 'string'
        ? openAuthenticatedPortalPage(value)
        : openAuthenticatedPortalRequest(value),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsLoadCanopyCloudAiCredits,
    async (_event, value?: unknown): Promise<CanopyCloudAiCreditsState> => {
      const scope = parseAiCreditsScopeRequest(value);
      const owner = scope ? await resolveAiCreditsScopeOwner(scope) : undefined;
      return loadCanopyCloudAiCredits(owner);
    },
  );

  const libraryWatches = new Map<string, () => void>();
  registerIpcHandler(
    IPC_CHANNELS.modelLibraryWatch,
    async (event, watchId: unknown, value?: unknown): Promise<void> => {
      if (typeof watchId !== 'string' || watchId.length > 128)
        throw new Error('Invalid access watch');
      validateId(watchId, 'watchId');
      const scope = parseAiCreditsScopeRequest(value);
      if (!scope) throw new Error('Invalid access scope');
      const key = `${event.sender.id}|${watchId}`;
      if (
        libraryWatches.has(key) ||
        Array.from(libraryWatches.keys()).filter((candidate) =>
          candidate.startsWith(`${event.sender.id}|`),
        ).length >= 100
      )
        throw new Error('Access watch limit reached');
      let active = true;
      let stop: (() => void) | undefined;
      const close = (): void => {
        active = false;
        stop?.();
        libraryWatches.delete(key);
        event.sender.removeListener('destroyed', close);
      };
      libraryWatches.set(key, close);
      event.sender.once('destroyed', close);
      try {
        const owner = await resolveAiCreditsScopeOwner(scope);
        if (!active) return;
        if (!owner) {
          close();
          return;
        }
        stop = await subscribeModelLibraryAccess(
          owner,
          (credentialsChanged): void => {
            if (active && !event.sender.isDestroyed())
              sendToWebContents(
                event.sender,
                IPC_CHANNELS.modelLibraryChanged,
                watchId,
                credentialsChanged,
              );
          },
        );
        if (!active) stop();
      } catch (error) {
        close();
        throw error;
      }
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.modelLibraryUnwatch,
    (event, watchId: unknown): void => {
      if (typeof watchId === 'string')
        libraryWatches.get(`${event.sender.id}|${watchId}`)?.();
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.settingsLoadCanopyCloudEntitlements,
    async (_event, value?: unknown): Promise<CanopyCloudEntitlementsState> =>
      loadCanopyCloudEntitlements(
        parseAiCreditsScopeRequest(value) ?? undefined,
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsLoadCloudReleaseNotes,
    async (_event, version: unknown) => loadCloudReleaseNotes(version),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsLoadCloudDigestPreferences,
    async (): Promise<CloudDigestPreferencesState> =>
      loadCloudDigestPreferences(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsSaveCloudDigestPreferences,
    async (
      _event,
      preferences: CloudDigestPreferences,
    ): Promise<CloudDigestPreferencesState> => {
      // The type annotation is erased at runtime, so validate the
      // renderer-supplied payload here rather than letting a malformed body
      // reach an authenticated PATCH and come back as the generic "Could not
      // save digest settings." The route requires all three booleans, so this
      // keeps that invariant on the sending side.
      const parsed = parseDigestPreferences(preferences);
      if (!parsed) {
        return {
          available: true,
          resolved: false,
          preferences: DEFAULT_DIGEST_PREFERENCES,
        };
      }
      return saveCloudDigestPreferences(parsed);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsLoadInstallUpdateEmailPreference,
    async (): Promise<InstallUpdateEmailPreference> =>
      loadInstallUpdateEmailPreference(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsSaveInstallUpdateEmailPreference,
    async (
      _event,
      preference: unknown,
    ): Promise<InstallUpdateEmailPreference> => {
      // Validate the renderer payload before an authenticated PATCH. Unlike
      // the digest save this rejects: there is no state shape to carry a
      // failure, and a substituted default would overwrite the real choice.
      const parsed = parseInstallUpdateEmailPreference(preference);
      if (!parsed) {
        throw new Error('Invalid install update email preference.');
      }
      return saveInstallUpdateEmailPreference(parsed);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.canopyCloudMobileActivationLoad,
    async (
      _event,
      options: MobileActivationLoadOptions = {},
    ): Promise<MobileActivationState> =>
      loadCanopyCloudMobileActivation(options),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsLoadNativeAiCreditsAvailability,
    async (_event, value?: unknown): Promise<NativeAiCreditsAvailability> => {
      const scope = parseAiCreditsScopeRequest(value);
      const owner = scope ? await resolveAiCreditsScopeOwner(scope) : undefined;
      return loadNativeAiCreditsAvailability(owner);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsRefreshCanopyCloudEnforcedSettings,
    async (): Promise<CanopyCloudAccountPublicState> =>
      refreshCanopyCloudEnforcedSettings(),
  );

  registerIpcHandler(
    IPC_CHANNELS.secureStorageRecheck,
    async (_event, request: unknown): Promise<SecureStorageRecheckResult> => ({
      // Only an explicit Retry skips the throttle; anything else is `shown`.
      changed: await recheckSecretStorage(
        isRecord(request) && request.trigger === 'retry' ? 'retry' : 'shown',
      ),
    }),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsLoadCanopyCloudApiKey,
    async (): Promise<string> => {
      const account = await loadCanopyCloudAccount();
      if (
        account?.authMode !== 'api_key' ||
        account.credentialSource !== 'manual'
      ) {
        return '';
      }
      return account.apiKey;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsSaveCanopyCloudApiKey,
    (_event, request: { apiKey: string }) =>
      saveCanopyCloudApiKeyForWindow(request),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsClearCanopyCloudApiKey,
    async (): Promise<CanopyCloudAccountPublicState> =>
      disconnectCanopyCloudAccount(),
  );

  registerIpcHandler(IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin, () =>
    startCanopyCloudOAuthLoginForWindow(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsStartCanopyGuestSession,
    async (
      _event,
      consent: CanopyGuestConsent | undefined,
    ): Promise<CanopyCloudAccountPublicState> => {
      // Record consent locally first so a mint that must be retried later
      // (offline first launch) still has the recorded acceptance. Consent is a
      // desktop-local record; the guest-mint endpoint does not receive it.
      if (
        consent &&
        typeof consent.acceptedAt === 'string' &&
        typeof consent.tosVersion === 'string'
      ) {
        await writePreferencesFile({
          guestConsentAcceptedAt: consent.acceptedAt,
          guestConsentTosVersion: consent.tosVersion,
        });
      }

      // Idempotent: if a credential is already connected, do not mint again.
      const existingRead = await readCanopyCloudAccountWithStatus();
      if (existingRead.status !== 'ok') {
        if (!existingRead.secureStorageFailure) throw existingRead.error;
        return toPublicCanopyCloudAccountState(
          null,
          existingRead.status,
          existingRead.secureStorageFailure,
        );
      }
      const existing = existingRead.entry;
      if (existing && existing.apiKey.trim().length > 0) {
        return toPublicCanopyCloudAccountState(existing);
      }

      // Require recorded consent before minting a guest (legal), whether from
      // this call or a prior one.
      const prefs = await readPreferencesFile();
      if (!prefs.guestConsentAcceptedAt) {
        throw new Error('Guest consent has not been recorded.');
      }

      try {
        const { mintGuest } = await import('../canopy-cloud/guest-auth');
        const result = await mintGuest();
        if (result.status.capabilities.includes(MEMORY_SEARCH_CAPABILITY)) {
          await reprobeAndApplyCanopyCloudEnforcedSettings();
          result.account = toPublicCanopyCloudAccountState(
            await loadCanopyCloudAccount(),
          );
        }
        refreshFeatureFlagContextAfterSettingsChange(
          `${CLOUD_DISPLAY_NAME} guest session`,
        );
        return result.account;
      } catch (error) {
        const secureStorageFailure = getSecureStorageFailure(error);
        if (secureStorageFailure) {
          const account = await loadCanopyCloudAccountPublicState();
          return { ...account, secureStorageFailure };
        }
        // Offline / transient network failure: consent is already persisted, so
        // the app can enter the shell and retry the mint later. Surface the
        // current (unconnected) account state instead of failing the gate.
        if (
          error instanceof CanopyCloudClientError &&
          error.code === 'network-error'
        ) {
          process.stderr.write(
            `[settings] ${CLOUD_DISPLAY_NAME} guest mint deferred (offline); will retry: ${formatErrorMessage(error)}\n`,
          );
          return toPublicCanopyCloudAccountState(
            await loadCanopyCloudAccount(),
          );
        }
        throw error;
      }
    },
  );

  registerIpcHandler(IPC_CHANNELS.settingsCancelCanopyCloudOAuthLogin, () =>
    cancelCanopyCloudOAuthLoginForWindow(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsDisconnectCanopyCloudAccount,
    async (): Promise<CanopyCloudAccountPublicState> =>
      disconnectCanopyCloudAccount(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsResetUnreadableCanopyCloudAccount,
    async (): Promise<ResetUnreadableCanopyCloudAccountResult> =>
      resetUnreadableCloudAccount(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsValidateCanopyCloudApiKey,
    (_event, request: { apiKey?: string } | undefined) =>
      validateCanopyCloudApiKeyForWindow(request ?? {}),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsSearchLinearIssues,
    async (_event, query: unknown): Promise<LinearTicketSearchResult[]> => {
      const parsedQuery = parseLinearIssueSearchQuery(query);
      if (parsedQuery === null) return [];
      return searchLinearIssues(parsedQuery);
    },
  );
}
