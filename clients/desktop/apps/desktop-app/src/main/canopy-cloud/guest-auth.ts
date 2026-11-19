import os from 'node:os';
import { normalizeMemorySearchOrganizationExternalIds } from '@canopy/desktop-shared/lib/org-memory';
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
import { normalizeOrgEnforcedSettingsWithStatus } from '@canopy/desktop-shared/lib/org-enforced-parsing';
import { normalizeOrgBillingStates } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import type {
  CanopyOrganizationSummary,
  CanopyTeamSummary,
} from '@canopy/protocol/pipelines';
import { requestCanopyCloudJson, requestCanopyCloudPublicJson } from './client';
import { parseAuthoritativeOrganizationSnapshot } from './organization-snapshot';
import {
  loadCanopyCloudAccount,
  saveCanopyCloudAccount,
  toPublicCanopyCloudAccountState,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { isRecord } from '../lib/type-guards';
import { getInstallId } from '../lib/install-identity';
import { getSharedContainerReconciliationService } from '../shared-containers/reconciliation-service';
import { organizationSnapshotTransition } from '../shared-containers/organization-snapshot-transition';

/**
 * Parsed guest-mint response. Mirrors the desktop OAuth token response shape
 * (`account`, `capabilities`, `organizations`, `teams`, `enforcedSettings`,
 * `token`, `userApiKey.id`) plus the `isGuest` marker. The raw `token` is the
 * guest `csk_` key and crosses the wire exactly once.
 */
interface GuestMintResponse {
  token: string;
  userApiKey: { id: string };
  account: CanopyServerAccountInfo;
  capabilities: readonly string[];
  memorySearchOrganizationExternalId?: string;
  /** Normalized eligible memory orgs (CAN-3457); empty when none. */
  memorySearchOrganizationExternalIds: string[];
  organizations: CanopyOrganizationSummary[];
  teams: CanopyTeamSummary[];
  enforcedSettings: CanopyOrgEnforcedSettings[];
  telemetryEnforcementUnavailable?: boolean;
  modelGatewayEnforcementUnavailable: boolean;
  /** Per-org billing state (CAN-2311). Empty ⇒ nothing lapsed. */
  orgBillingStates: CanopyOrgBillingState[];
}

export interface GuestMintResult {
  status: CanopyServerStatus;
  account: CanopyCloudAccountPublicState;
}

export interface GuestMintRealSignInBarrier {
  /** A mint that crossed the barrier before this real sign-in began. */
  activeGuestMint: Promise<GuestMintResult> | null;
  release: () => void;
}

let activeGuestMint: Promise<GuestMintResult> | null = null;
let realSignInBlockerCount = 0;
const guestMintUnblockWaiters = new Set<() => void>();

/**
 * Stop new guest mints from crossing the network/persistence boundary while a
 * real sign-in is active. A mint that already crossed is returned so the
 * caller can await it before taking the guest snapshot and minting a link
 * ticket. Multiple OAuth attempts can hold barriers concurrently without
 * serializing each other.
 */
export function pauseGuestMintsForRealSignIn(): GuestMintRealSignInBarrier {
  realSignInBlockerCount += 1;
  const activeAtBarrier = activeGuestMint;
  let released = false;
  return {
    activeGuestMint: activeAtBarrier,
    release: (): void => {
      if (released) return;
      released = true;
      realSignInBlockerCount = Math.max(0, realSignInBlockerCount - 1);
      if (realSignInBlockerCount !== 0) return;
      const waiters = Array.from(guestMintUnblockWaiters);
      guestMintUnblockWaiters.clear();
      for (const resolve of waiters) resolve();
    },
  };
}

function waitForGuestMintUnblocked(): Promise<void> {
  if (realSignInBlockerCount === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    guestMintUnblockWaiters.add(resolve);
  });
}

function invalidGuestResponse(): never {
  throw new Error('Guest session response was invalid.');
}

function readStringField(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  return typeof value === 'string' ? value : invalidGuestResponse();
}

function parseAccountInfo(value: unknown): CanopyServerAccountInfo {
  if (!isRecord(value)) {
    invalidGuestResponse();
  }
  const role = value.role;
  if (role !== 'VIEWER' && role !== 'DEVELOPER' && role !== 'ADMIN') {
    invalidGuestResponse();
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
    invalidGuestResponse();
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
    invalidGuestResponse();
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
    invalidGuestResponse();
  }
  return value;
}

function parseArray<T>(value: unknown, parser: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    invalidGuestResponse();
  }
  return value.map(parser);
}

function parseGuestMintResponse(value: unknown): GuestMintResponse {
  if (!isRecord(value) || !isRecord(value.userApiKey)) {
    invalidGuestResponse();
  }
  const organizations = parseAuthoritativeOrganizationSnapshot(
    value.organizations,
  );
  if (organizations === null) invalidGuestResponse();
  const normalizedEnforcement = normalizeOrgEnforcedSettingsWithStatus(
    value.enforcedSettings,
  );
  return {
    token: readStringField(value, 'token'),
    userApiKey: { id: readStringField(value.userApiKey, 'id') },
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
    enforcedSettings: normalizedEnforcement.settings,
    ...(normalizedEnforcement.telemetryEnforcementUnavailable === true
      ? { telemetryEnforcementUnavailable: true }
      : {}),
    modelGatewayEnforcementUnavailable:
      normalizedEnforcement.modelGatewayEnforcementUnavailable,
    orgBillingStates: normalizeOrgBillingStates(value.orgBillingStates),
  };
}

/**
 * Mint (or idempotently reuse) a device-scoped guest session. POSTs the stable
 * `clientDeviceId` and client metadata to the unauthenticated guest-mint route,
 * then saves the returned guest key with `credentialSource: 'guest'` /
 * `authMode: 'guest'`. Because `isCanopyCloudConnected` is just `hasApiKey &&
 * account`, the saved guest satisfies the Cloud sign-in gate with no gate-logic
 * change.
 */
async function resultFromSavedAccount(
  saved: CanopyCloudAccountEntry,
): Promise<GuestMintResult> {
  const publicAccount = toPublicCanopyCloudAccountState(saved);
  const { applyEnforcedSettings } =
    await import('../services/org-enforced-settings');
  await applyEnforcedSettings(publicAccount);

  return {
    status: {
      authenticated: saved.apiKey.trim().length > 0,
      account: saved.account ?? null,
      capabilities: [...saved.capabilities],
      missingCapabilities: REQUIRED_CANOPY_SERVER_CAPABILITIES.filter(
        (capability) => !saved.capabilities.includes(capability),
      ),
      organizations: saved.organizations ?? [],
      teams: saved.teams ?? [],
      enforcedSettings: saved.enforcedSettings ?? [],
      ...(saved.modelGatewayEnforcementUnavailable === true
        ? { modelGatewayEnforcementUnavailable: true }
        : {}),
      orgBillingStates: saved.orgBillingStates ?? [],
      error: null,
    },
    account: publicAccount,
  };
}

async function performGuestMint(): Promise<GuestMintResult> {
  // A mint can have waited behind one or more real-sign-in barriers. Reuse the
  // credential they established instead of issuing a now-stale guest request.
  const existing = await loadCanopyCloudAccount();
  if (existing?.apiKey.trim()) {
    return resultFromSavedAccount(existing);
  }

  const clientDeviceId = await getInstallId();
  const clientName = `${BRAND.displayName} Desktop`;
  const clientVersion = app?.getVersion?.() ?? null;
  const clientHostname = os.hostname() || null;

  const payload = await requestCanopyCloudPublicJson<unknown>(
    `/api/v1/${BRAND.web.apiNamespace}/desktop-auth/guest`,
    {
      method: 'POST',
      body: JSON.stringify({
        clientDeviceId,
        clientName,
        clientVersion,
        clientHostname,
      }),
    },
  );
  const response = parseGuestMintResponse(payload);

  const now = new Date().toISOString();
  const saved = await saveCanopyCloudAccount(
    {
      apiKey: response.token,
      authMode: 'guest',
      credentialSource: 'guest',
      serverApiKeyId: response.userApiKey.id,
      capabilities: [...response.capabilities],
      ...(response.memorySearchOrganizationExternalId
        ? {
            memorySearchOrganizationExternalId:
              response.memorySearchOrganizationExternalId,
          }
        : {}),
      memorySearchOrganizationExternalIds: [
        ...response.memorySearchOrganizationExternalIds,
      ],
      account: response.account,
      organizations: response.organizations,
      teams: response.teams,
      enforcedSettings: response.enforcedSettings,
      telemetryEnforcementUnavailable:
        response.telemetryEnforcementUnavailable === true,
      modelGatewayEnforcementUnavailable:
        response.modelGatewayEnforcementUnavailable,
      orgBillingStates: response.orgBillingStates,
      createdAt: now,
      updatedAt: now,
    },
    (persist) =>
      getSharedContainerReconciliationService().withReplicaPurgeFence(persist),
    organizationSnapshotTransition(
      response.organizations.map((organization) => organization.id),
    ),
  );

  return resultFromSavedAccount(saved);
}

export function mintGuest(): Promise<GuestMintResult> {
  if (activeGuestMint) return activeGuestMint;
  if (realSignInBlockerCount > 0) {
    return waitForGuestMintUnblocked().then(() => mintGuest());
  }

  const mint = performGuestMint();
  activeGuestMint = mint;
  void mint.then(
    () => {
      if (activeGuestMint === mint) activeGuestMint = null;
    },
    () => {
      if (activeGuestMint === mint) activeGuestMint = null;
    },
  );
  return mint;
}

/**
 * Mint a single-use guest-link ticket bound to the guest identified by the
 * saved guest `csk_` bearer. The ticket rides the OAuth authorize flow so a
 * later sign-in merges the guest's data into the real user. Returns the raw
 * ticket exactly once.
 */
export async function requestGuestLinkTicket(): Promise<string> {
  const payload = await requestCanopyCloudJson<unknown>(
    `/api/v1/${BRAND.web.apiNamespace}/desktop-auth/guest-link-ticket`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
  if (!isRecord(payload) || typeof payload.ticket !== 'string') {
    throw new Error('Guest link ticket response was invalid.');
  }
  return payload.ticket;
}
