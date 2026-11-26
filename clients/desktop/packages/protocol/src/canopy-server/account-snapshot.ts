import {
  isCanopyOrganizationRole,
  type CanopyOrganizationSummary,
  type CanopyTeamSummary,
} from '../pipelines';
import { normalizePersonalOrganizationId } from '../workspace-context';
import { normalizeUuid } from '../workspace-owner';
import type {
  CanopyAccountResponse,
  CanopyOrgBillingState,
  CanopyOrgEnforcedSettings,
} from './index';
import { normalizeOrgBillingStates } from './org-billing-state-parsing';
import {
  normalizeOrgEnforcedSettingsWithStatus,
  modelGatewayAccountFields,
  type ModelGatewayAccountFields,
} from './org-enforced-parsing';

/**
 * The account response normalizers and the refresh snapshot rules, browser-safe
 * so every host builds the same entry from the same response (CAN-6997).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An organization branding logo the renderer may load: an absolute http(s)
 * URL only, never a local or script scheme from the wire (CAN-3522).
 */
export function isDisplayableLogoUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Normalize one organization summary from an untrusted wire or stored value.
 * Returns `null` when a required field is missing or mistyped. Unknown fields
 * are stripped. A `role` is kept only when it is a known role; an unknown role
 * is dropped rather than failing the entry, because an older or newer server
 * disagreeing on the vocabulary must not hide the organization itself
 * (consumers treat an absent role as MEMBER).
 */
export function normalizeCanopyOrganizationSummary(
  value: unknown,
): CanopyOrganizationSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    ...(isCanopyOrganizationRole(value.role) ? { role: value.role } : {}),
    // The branding logo the scope switcher shows, as on the web portal
    // (CAN-3522). Only an absolute http(s) URL is kept, so the renderer never
    // loads a local or script scheme from the wire.
    ...(isDisplayableLogoUrl(value.logoUrl) ? { logoUrl: value.logoUrl } : {}),
    // Decides whether the shared-container invite modal can offer Public for
    // an organization-owned container. Absent (older servers) reads as off.
    ...(typeof value.allowExternalContainerSharing === 'boolean'
      ? { allowExternalContainerSharing: value.allowExternalContainerSharing }
      : {}),
    ...(typeof value.automaticPersonalProjectConversionExcluded === 'boolean'
      ? {
          automaticPersonalProjectConversionExcluded:
            value.automaticPersonalProjectConversionExcluded,
        }
      : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** List form of {@link normalizeCanopyOrganizationSummary}; drops bad entries. */
export function normalizeCanopyOrganizationSummaries(
  value: unknown,
): CanopyOrganizationSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeCanopyOrganizationSummary)
    .filter((entry): entry is CanopyOrganizationSummary => entry !== null);
}

function isCanonicalRequiredString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}

/**
 * The organization list as conclusive membership evidence, or null when any
 * entry is malformed or duplicated: only an exact list may drive loss cleanup.
 */
export function parseAuthoritativeOrganizationSnapshot(
  value: unknown,
): CanopyOrganizationSummary[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const organizations: CanopyOrganizationSummary[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isCanonicalRequiredString(entry.id) ||
      !isCanonicalRequiredString(entry.name) ||
      !isCanonicalRequiredString(entry.createdAt) ||
      !isCanonicalRequiredString(entry.updatedAt) ||
      ids.has(entry.id)
    ) {
      return null;
    }
    ids.add(entry.id);
    organizations.push({
      id: entry.id,
      name: entry.name,
      // An unknown role must not make the snapshot non-authoritative: the
      // membership list is still exact, only the role vocabulary drifted.
      ...(isCanopyOrganizationRole(entry.role) ? { role: entry.role } : {}),
      // The switcher's branding logo (CAN-3522); a bad URL is dropped, never
      // fatal to the membership snapshot.
      ...(isDisplayableLogoUrl(entry.logoUrl)
        ? { logoUrl: entry.logoUrl }
        : {}),
      // Optional policy detail; a missing or malformed value reads as off and
      // never makes the membership snapshot non-authoritative.
      ...(typeof entry.allowExternalContainerSharing === 'boolean'
        ? { allowExternalContainerSharing: entry.allowExternalContainerSharing }
        : {}),
      ...(typeof entry.automaticPersonalProjectConversionExcluded === 'boolean'
        ? {
            automaticPersonalProjectConversionExcluded:
              entry.automaticPersonalProjectConversionExcluded,
          }
        : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  }
  return organizations;
}

export function normalizeCanopyTeams(value: unknown): CanopyTeamSummary[] {
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

const MAX_MEMORY_SEARCH_ORGANIZATIONS = 256;

/**
 * Normalizes an organization external id (a UUID) to its lowercase form, or
 * returns `null` when the value is not a UUID. Organization memory keys every
 * search, delivery ack, and feedback call by this id (CAN-3457), so a malformed
 * value must never reach a request.
 */
export function normalizeOrganizationExternalId(value: unknown): string | null {
  return normalizeUuid(value);
}

/**
 * Normalizes the account response's organization-memory eligibility into the
 * list of organizations the user may search (CAN-3457).
 *
 * - The list drops malformed values and duplicates and lowercases the UUIDs.
 * - A response without the list but with the deprecated single-org field (an
 *   older server) is read as `[legacyId]`. This is not a fallback to another
 *   org: the owning org is still searched only when it appears in the list.
 */
export function normalizeMemorySearchOrganizationExternalIds(
  list: unknown,
  legacyId: unknown,
): string[] {
  const source: unknown[] = Array.isArray(list)
    ? list
    : legacyId === undefined
      ? []
      : [legacyId];
  const normalized: string[] = [];
  for (const raw of source.slice(0, MAX_MEMORY_SEARCH_ORGANIZATIONS)) {
    const id = normalizeOrganizationExternalId(raw);
    if (id !== null && !normalized.includes(id)) normalized.push(id);
  }
  return normalized;
}

/** Everything an authenticated account response contributes, except `account`. */
export interface CanopyAccountSnapshot extends Readonly<ModelGatewayAccountFields> {
  /** The response's effective capabilities, else the advertised ones. */
  readonly capabilities: string[];
  readonly personalOrganizationId: string | null;
  readonly organizations: CanopyOrganizationSummary[];
  /** Only a well-formed organization list is conclusive membership evidence. */
  readonly organizationsRefreshed: boolean;
  readonly teams: CanopyTeamSummary[];
  readonly enforcedSettings: CanopyOrgEnforcedSettings[];
  readonly telemetryEnforcementUnavailable?: true;
  readonly modelGatewayEnforcementUnavailable: boolean;
  /**
   * PRESENCE IS THE SIGNAL: absent when the response omitted the field.
   * `normalizeOrgBillingStates` maps an absent or malformed field to `[]`,
   * which is indistinguishable from "the server told us no org is lapsed".
   * A refresh reports billing as refreshed only when this is present, and
   * telemetry sync treats that report as the precondition for an
   * irreversible queue delete.
   */
  readonly orgBillingStates?: CanopyOrgBillingState[];
  /** @deprecated Read `memorySearchOrganizationExternalIds` (CAN-3457). */
  readonly memorySearchOrganizationExternalId?: string;
  /** Normalized eligible memory orgs; absent when none. */
  readonly memorySearchOrganizationExternalIds?: string[];
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : null;
}

/** Normalizes an authenticated account response body. */
export function parseCanopyAccountSnapshot(
  payload: unknown,
  advertisedCapabilities: readonly string[],
): CanopyAccountSnapshot {
  const body = isRecord(payload) ? payload : {};
  const authoritativeOrganizations = parseAuthoritativeOrganizationSnapshot(
    body.organizations,
  );
  const enforcement = normalizeOrgEnforcedSettingsWithStatus(
    body.enforcedSettings,
  );
  const memoryOrganizations = normalizeMemorySearchOrganizationExternalIds(
    body.memorySearchOrganizationExternalIds,
    body.memorySearchOrganizationExternalId,
  );
  return {
    capabilities: stringList(body.capabilities) ?? [...advertisedCapabilities],
    personalOrganizationId: normalizePersonalOrganizationId(
      body.personalOrganizationId,
    ),
    organizations:
      authoritativeOrganizations ??
      normalizeCanopyOrganizationSummaries(body.organizations),
    organizationsRefreshed: authoritativeOrganizations !== null,
    ...modelGatewayAccountFields(body),
    teams: normalizeCanopyTeams(body.teams),
    enforcedSettings: enforcement.settings,
    ...(enforcement.telemetryEnforcementUnavailable === true
      ? { telemetryEnforcementUnavailable: true }
      : {}),
    modelGatewayEnforcementUnavailable:
      enforcement.modelGatewayEnforcementUnavailable,
    ...(Array.isArray(body.orgBillingStates)
      ? { orgBillingStates: normalizeOrgBillingStates(body.orgBillingStates) }
      : {}),
    ...(typeof body.memorySearchOrganizationExternalId === 'string' &&
    body.memorySearchOrganizationExternalId.trim().length > 0
      ? {
          memorySearchOrganizationExternalId:
            body.memorySearchOrganizationExternalId.trim(),
        }
      : {}),
    ...(memoryOrganizations.length > 0
      ? { memorySearchOrganizationExternalIds: memoryOrganizations }
      : {}),
  };
}

/**
 * Stored fields a refresh replaces rather than merges: keeping them from the
 * previous entry would keep, for example, a memory org the server stopped
 * advertising (CAN-3457). Delete them from the stored entry before applying
 * {@link canopyAccountRefreshFields}.
 */
export const CANOPY_ACCOUNT_REFRESH_REPLACED_FIELDS = [
  'personalOrganizationId',
  'personalModelGateway',
  'personalModelGatewayEnforcementUnavailable',
  'personalModelGatewayConfig',
  'organizationModelGatewayConfigs',
  'memorySearchOrganizationExternalId',
  'memorySearchOrganizationExternalIds',
] as const;

/** The stored fields a refresh writes from an authenticated snapshot. */
export interface CanopyAccountRefreshSource {
  readonly capabilities: string[];
  readonly personalOrganizationId?: string | null;
  readonly personalModelGateway?: CanopyAccountResponse['personalModelGateway'];
  readonly personalModelGatewayEnforcementUnavailable?: boolean;
  readonly personalModelGatewayConfig?: CanopyAccountResponse['personalModelGatewayConfig'];
  readonly organizationModelGatewayConfigs?: CanopyAccountResponse['organizationModelGatewayConfigs'];
  readonly organizations: CanopyOrganizationSummary[];
  readonly teams: CanopyTeamSummary[];
  readonly enforcedSettings?: CanopyOrgEnforcedSettings[];
  readonly telemetryEnforcementUnavailable?: boolean;
  readonly modelGatewayEnforcementUnavailable?: boolean;
  readonly orgBillingStates?: CanopyOrgBillingState[];
  readonly memorySearchOrganizationExternalId?: string;
  readonly memorySearchOrganizationExternalIds?: string[];
}

export function canopyAccountRefreshFields(
  snapshot: CanopyAccountRefreshSource,
): {
  capabilities: string[];
  memorySearchOrganizationExternalId?: string;
  memorySearchOrganizationExternalIds?: string[];
  personalOrganizationId?: string;
  personalModelGateway?: CanopyAccountResponse['personalModelGateway'];
  personalModelGatewayEnforcementUnavailable?: boolean;
  personalModelGatewayConfig?: CanopyAccountResponse['personalModelGatewayConfig'];
  organizationModelGatewayConfigs?: CanopyAccountResponse['organizationModelGatewayConfigs'];
  organizations: CanopyOrganizationSummary[];
  teams: CanopyTeamSummary[];
  enforcedSettings?: CanopyOrgEnforcedSettings[];
  telemetryEnforcementUnavailable: boolean;
  modelGatewayEnforcementUnavailable: boolean;
  orgBillingStates: CanopyOrgBillingState[];
} {
  return {
    capabilities: snapshot.capabilities,
    ...(snapshot.memorySearchOrganizationExternalId
      ? {
          memorySearchOrganizationExternalId:
            snapshot.memorySearchOrganizationExternalId,
        }
      : {}),
    ...(snapshot.memorySearchOrganizationExternalIds
      ? {
          memorySearchOrganizationExternalIds:
            snapshot.memorySearchOrganizationExternalIds,
        }
      : {}),
    ...(snapshot.personalOrganizationId
      ? { personalOrganizationId: snapshot.personalOrganizationId }
      : {}),
    ...modelGatewayAccountFields(snapshot),
    ...(snapshot.personalModelGatewayEnforcementUnavailable
      ? { personalModelGatewayEnforcementUnavailable: true }
      : {}),
    organizations: snapshot.organizations,
    teams: snapshot.teams,
    ...(snapshot.enforcedSettings
      ? { enforcedSettings: snapshot.enforcedSettings }
      : {}),
    telemetryEnforcementUnavailable:
      snapshot.telemetryEnforcementUnavailable === true,
    modelGatewayEnforcementUnavailable:
      snapshot.modelGatewayEnforcementUnavailable === true,
    // An AUTHENTICATED response that omits the field clears the cached states
    // rather than preserving them: preserving would make a lapse STICKY across
    // a server rollback, contradicting the invariant in
    // `lib/org-billing-state.ts` that an older server means NOT lapsed.
    orgBillingStates: snapshot.orgBillingStates ?? [],
  };
}
