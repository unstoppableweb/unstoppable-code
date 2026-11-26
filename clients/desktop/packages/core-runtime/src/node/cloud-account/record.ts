import { createHash } from 'node:crypto';
import {
  CLOUD_ACCOUNT_ENTRY_MAX_BYTES,
  CloudAccountEntryJsonSchema,
} from '@canopy/protocol/canopy-core';
export { CLOUD_ACCOUNT_ENTRY_MAX_BYTES } from '@canopy/protocol/canopy-core';
import type {
  CanopyOrgBillingState,
  CanopyOrgEnforcedSettings,
} from '@canopy/protocol/canopy-server';
import { normalizeOrgBillingStates } from '@canopy/protocol/canopy-server/org-billing-state-parsing';
import {
  cloudModelPolicySnapshotUnavailable,
  normalizeOrgEnforcedSettingsWithStatus,
} from '@canopy/protocol/canopy-server/org-enforced-parsing';
import {
  readOrganizationLossState,
  type OrganizationLossState,
  type StoredOrganizationLossRecord,
} from './organization-loss';

/**
 * The whole Cloud account entry as one custody record (CAN-6997): identity,
 * organizations, enforced settings, billing, personal-gateway and loss-handoff
 * state travel together with the credential, as the Electron store encrypts
 * them together. Unknown fields are preserved, so a newer writer's additions
 * survive a daemon refresh. The record is never projected to a client.
 */
export { cloudModelPolicySnapshotUnavailable } from '@canopy/protocol/canopy-server/org-enforced-parsing';

export type CloudAccountEntryJson = Readonly<Record<string, unknown>>;

export type CloudAccountAuthMode = 'oauth' | 'api_key' | 'guest';
export type CloudAccountCredentialSource = 'oauth_desktop' | 'manual' | 'guest';

export interface CloudAccountRecord {
  /** The entry exactly as stored, deep-cloned and frozen. */
  readonly entry: CloudAccountEntryJson;
  readonly apiKey: string;
  readonly authMode: CloudAccountAuthMode;
  readonly credentialSource: CloudAccountCredentialSource;
  readonly serverApiKeyId: string | null;
  readonly accountId: string | null;
  /** The pending organization-loss handoff for this account, if any. */
  readonly organizationAccessLossState: OrganizationLossState<StoredOrganizationLossRecord> | null;
  readonly personalOrganizationId: string | null;
  readonly organizationIds: readonly string[];
  readonly enforcedSettings: readonly CanopyOrgEnforcedSettings[];
  readonly modelPolicyEnforcementUnavailable: boolean;
  readonly modelGatewayEnforcementUnavailable: boolean;
  readonly orgBillingStates: readonly CanopyOrgBillingState[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Same defaults as the Electron normalizer: unknown sources read as manual. */
function credentialSourceOf(value: unknown): CloudAccountCredentialSource {
  return value === 'oauth_desktop' || value === 'guest' ? value : 'manual';
}

function authModeOf(
  value: unknown,
  source: CloudAccountCredentialSource,
): CloudAccountAuthMode {
  if (source === 'oauth_desktop') return 'oauth';
  return value === 'oauth' || value === 'guest' ? value : 'api_key';
}

/**
 * The account id custody fences on, or null. The app drops an account it
 * cannot normalize, and its identity then falls back to the credential; use
 * the same rule so both fences agree.
 */
export function cloudAccountIdOf(account: unknown): string | null {
  return isRecord(account) &&
    typeof account.id === 'string' &&
    typeof account.name === 'string' &&
    typeof account.email === 'string' &&
    (account.role === 'VIEWER' ||
      account.role === 'DEVELOPER' ||
      account.role === 'ADMIN')
    ? trimmed(account.id)
    : null;
}

/**
 * Validates and indexes an entry. Null for anything that is not a usable
 * entry: missing credential or timestamps, non-JSON values or an oversized
 * record. The returned entry is a frozen JSON clone, never the input.
 */
export function readCloudAccountRecord(
  value: unknown,
): CloudAccountRecord | null {
  if (!isRecord(value)) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (Buffer.byteLength(json, 'utf8') > CLOUD_ACCOUNT_ENTRY_MAX_BYTES)
    return null;
  const entry: unknown = JSON.parse(json);
  if (!CloudAccountEntryJsonSchema.safeParse(entry).success) return null;
  if (
    !isRecord(entry) ||
    typeof entry.apiKey !== 'string' ||
    typeof entry.createdAt !== 'string' ||
    typeof entry.updatedAt !== 'string'
  )
    return null;
  const credentialSource = credentialSourceOf(entry.credentialSource);
  const organizations = Array.isArray(entry.organizations)
    ? entry.organizations.flatMap((organization: unknown) => {
        const id = isRecord(organization) ? trimmed(organization.id) : null;
        return id ? [id.toLowerCase()] : [];
      })
    : [];
  const enforcement = normalizeOrgEnforcedSettingsWithStatus(
    entry.enforcedSettings,
  );
  const accountId = cloudAccountIdOf(entry.account);
  const loss = readOrganizationLossState(
    entry.organizationAccessLossState,
    accountId,
  );
  if (loss.kind === 'malformed') return null;
  return deepFreeze({
    entry,
    apiKey: entry.apiKey,
    authMode: authModeOf(entry.authMode, credentialSource),
    credentialSource,
    serverApiKeyId: trimmed(entry.serverApiKeyId),
    accountId,
    organizationAccessLossState: loss.state ?? null,
    personalOrganizationId: trimmed(entry.personalOrganizationId),
    organizationIds: [...new Set(organizations)],
    enforcedSettings: enforcement.settings,
    modelPolicyEnforcementUnavailable:
      entry.modelPolicyEnforcementUnavailable === true ||
      // Older clients preserve only this broad structural-degradation marker
      // after tolerant normalization; it cannot prove model policy absent.
      entry.telemetryEnforcementUnavailable === true ||
      cloudModelPolicySnapshotUnavailable(entry.enforcedSettings),
    modelGatewayEnforcementUnavailable:
      entry.modelGatewayEnforcementUnavailable === true ||
      enforcement.modelGatewayEnforcementUnavailable,
    orgBillingStates: normalizeOrgBillingStates(entry.orgBillingStates),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

export function isGuestCloudAccount(record: CloudAccountRecord): boolean {
  return record.credentialSource === 'guest' || record.authMode === 'guest';
}

/** Whether the record can be probed: a non-empty credential. */
export function hasCloudAccountCredential(
  record: CloudAccountRecord | null,
): record is CloudAccountRecord {
  return record !== null && record.apiKey.trim().length > 0;
}

/**
 * Same rule as the Electron store's `hasCanopyCloudIdentityChanged`: the server
 * account id is the stable identity; without one on both sides the credential
 * decides, so an ambiguous replacement fails closed.
 */
export function hasCloudAccountIdentityChanged(
  previous: CloudAccountRecord | null,
  next: CloudAccountRecord,
): boolean {
  if (!previous) return true;
  if (previous.accountId && next.accountId)
    return previous.accountId !== next.accountId;
  return previous.apiKey !== next.apiKey;
}

/**
 * The non-secret identity a brokered route is bound to, as the app's AI
 * Credits routing context derives it: account id, then server key id, then a
 * digest of the credential. A legacy entry without an account id therefore
 * never lets a replacement key for an unknown account inherit the route.
 */
export function cloudAccountRouteIdentity(record: CloudAccountRecord): string {
  return (
    record.accountId ??
    record.serverApiKeyId ??
    createHash('sha256').update(record.apiKey.trim()).digest('hex')
  );
}

/** Same fence as the Electron store's `matchesExpectedAccountTransition`. */
export function matchesCloudAccountTransition(
  current: CloudAccountRecord | null,
  expected: CloudAccountRecord | null,
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

/**
 * Whether two entries differ in anything other than their save time and loss
 * handoff. Conservative: key-order differences read as a change and only cost
 * an extra notification.
 */
export function cloudAccountDiffersBeyondUpdatedAt(
  next: CloudAccountRecord,
  previous: CloudAccountRecord | null,
): boolean {
  if (!previous) return true;
  const comparable = (record: CloudAccountRecord): string =>
    JSON.stringify({
      ...record.entry,
      updatedAt: '',
      organizationAccessLossState: undefined,
    });
  return comparable(next) !== comparable(previous);
}

/** Redacted identity for diagnostics: never the credential. */
export function cloudAccountDiagnosticIdentity(
  record: CloudAccountRecord | null,
): {
  readonly signedIn: boolean;
  readonly kind: 'guest' | 'oauth' | 'apiKey' | 'none';
  readonly accountId: string | null;
} {
  if (!hasCloudAccountCredential(record))
    return { signedIn: false, kind: 'none', accountId: null };
  return {
    signedIn: true,
    kind: isGuestCloudAccount(record)
      ? 'guest'
      : record.authMode === 'oauth'
        ? 'oauth'
        : 'apiKey',
    accountId: record.accountId,
  };
}
