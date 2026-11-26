import type {
  CanopyAccountResponse,
  OrganizationModelGatewayConfig,
  PersonalModelGatewayConfig,
} from './index';
import { normalizePersonalOrganizationId } from '../workspace-context';
import { normalizeUuid } from '../workspace-owner';
// ---------------------------------------------------------------------------
// Tolerant org-enforced settings parsing.
//
// Single source of truth for turning untrusted JSON (an OAuth token response, a
// decrypted account file, or a refreshed account payload) into the structured
// `CanopyOrgEnforcedSettings[]` wire shape. Enforcement is optional everywhere,
// so parsing is tolerant rather than strict: unknown policy kinds and malformed
// entries are normalized without throwing, which keeps a single bad field from
// failing an otherwise-valid login or account read. Recognizable enforcement
// boundaries retain a degraded marker so malformed policy fails closed.
//
// No I/O and no Electron, so it is shared by the daemon's key sign-in and
// every desktop parse site
// (`oauth-login`, `canopy-cloud-account-store`, `ipc/settings`) and passes
// `pnpm run check:electron-boundary`. Adding a future enforced-policy kind means
// adding one branch to `normalizeOrgEnforcedPolicy` here — every parse site then
// understands it automatically.
// ---------------------------------------------------------------------------

import type {
  CanopyOrgEnforcedPolicy,
  CanopyOrgEnforcedSettings,
  ModelGatewayModel,
  TelemetryEnforcedScopeMap,
} from './index';
import {
  MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH,
  MODEL_GATEWAY_MAX_ID_LENGTH,
  MODEL_GATEWAY_MAX_LABEL_LENGTH,
  MODEL_GATEWAY_MAX_MODELS,
  normalizeModelGatewayBaseUrl,
} from './index';
import {
  AI_GATEWAY_THINKING_LEVELS,
  isAiGatewayThinkingLevel,
} from '../ai-gateway-models';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce an untrusted scope map with a strict `=== true` per key. Anything that
 * is not literally `true` (absent, `null`, `'true'`, `1`) reads as not-set.
 */
function normalizeScopeMap(value: unknown): TelemetryEnforcedScopeMap {
  const scopes = isRecord(value) ? value : {};
  return {
    transcripts: scopes.transcripts === true,
    plans: scopes.plans === true,
    metadata: scopes.metadata === true,
    summaries: scopes.summaries === true,
  };
}

/**
 * Read a model id list defensively. A non-array, or an array holding anything
 * that is not a string, yields only the usable string ids (an empty list when
 * nothing is usable) rather than discarding the surrounding policy.
 */
function readModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(value.filter((id): id is string => typeof id === 'string')),
  );
}

const THINKING_ORDER = new Map(
  AI_GATEWAY_THINKING_LEVELS.map((level, index) => [level, index]),
);

function readGatewayBaseUrl(value: unknown): string | null {
  return normalizeModelGatewayBaseUrl(value);
}

function readGatewayModels(value: unknown): ModelGatewayModel[] | null {
  if (!Array.isArray(value) || value.length > MODEL_GATEWAY_MAX_MODELS) {
    return null;
  }
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const models: ModelGatewayModel[] = [];
  for (const row of value) {
    if (!isRecord(row)) return null;
    const levels = row.supportedThinkingLevels;
    if (
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      row.id.length > MODEL_GATEWAY_MAX_ID_LENGTH ||
      typeof row.gatewayId !== 'string' ||
      row.gatewayId.length === 0 ||
      row.gatewayId.length > MODEL_GATEWAY_MAX_ID_LENGTH ||
      typeof row.label !== 'string' ||
      row.label.length === 0 ||
      row.label.length > MODEL_GATEWAY_MAX_LABEL_LENGTH ||
      (row.harness !== 'claude' && row.harness !== 'codex') ||
      typeof row.contextWindow !== 'number' ||
      !Number.isInteger(row.contextWindow) ||
      row.contextWindow <= 0 ||
      !Array.isArray(levels) ||
      !levels.every(isAiGatewayThinkingLevel) ||
      (row.toolSchemaProfile !== 'standard' &&
        row.toolSchemaProfile !== 'flat') ||
      seenIds.has(row.id) ||
      seenLabels.has(row.label)
    ) {
      return null;
    }
    const uniqueLevels = Array.from(new Set(levels));
    if (
      uniqueLevels.length !== levels.length ||
      uniqueLevels.some(
        (level, index) =>
          index > 0 &&
          (THINKING_ORDER.get(uniqueLevels[index - 1]) ?? -1) >=
            (THINKING_ORDER.get(level) ?? -1),
      )
    ) {
      return null;
    }
    seenIds.add(row.id);
    seenLabels.add(row.label);
    models.push({
      id: row.id,
      gatewayId: row.gatewayId,
      label: row.label,
      harness: row.harness,
      contextWindow: row.contextWindow,
      supportedThinkingLevels: uniqueLevels,
      toolSchemaProfile: row.toolSchemaProfile,
    });
  }
  return models;
}

/**
 * Normalize a single enforced policy. Returns `null` for non-records and
 * unknown policy kinds so callers can filter them out.
 *
 * A recognized-but-malformed `model-policy` is NOT dropped: see the fail-closed
 * note below.
 */
export function normalizeOrgEnforcedPolicy(
  value: unknown,
): CanopyOrgEnforcedPolicy | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === 'telemetry-sync') {
    // `prohibitedScopes` is absent on policies from an org that does not
    // enforce its full data-sharing configuration, and on any policy minted by
    // a server that predates two-way enforcement. Absent ⇒ `undefined` (nothing
    // prohibited), NOT an all-false map — the distinction keeps a missing field
    // from reading as a deliberate policy downstream.
    const prohibitedScopes =
      'prohibitedScopes' in value && isRecord(value.prohibitedScopes)
        ? normalizeScopeMap(value.prohibitedScopes)
        : undefined;
    return {
      kind: 'telemetry-sync',
      scopes: normalizeScopeMap(value.scopes),
      ...(prohibitedScopes ? { prohibitedScopes } : {}),
    };
  }
  if (value.kind === 'model-policy') {
    // Fail CLOSED on a malformed model policy. Dropping it (returning null)
    // would leave the member completely unrestricted, which is the opposite of
    // every other degraded path in this feature. A policy whose arrays cannot
    // be trusted normalizes to "nothing reviewed", and an id absent from the
    // reviewed snapshot is blocked — so garbage denies rather than permits.
    return {
      kind: 'model-policy',
      blockedModelIds: readModelIds(value.blockedModelIds),
      reviewedModelIds: readModelIds(value.reviewedModelIds),
    };
  }
  if (value.kind === 'model-gateway') {
    const baseUrl = readGatewayBaseUrl(value.baseUrl);
    const models = readGatewayModels(value.models);
    if (
      !baseUrl ||
      !models ||
      typeof value.enforced !== 'boolean' ||
      (value.promptCachePassthrough !== undefined &&
        typeof value.promptCachePassthrough !== 'boolean')
    ) {
      return null;
    }
    return {
      kind: 'model-gateway',
      ...(typeof value.displayName === 'string' &&
      value.displayName.trim().length > 0 &&
      value.displayName.trim().length <= MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH
        ? { displayName: value.displayName.trim() }
        : {}),
      baseUrl,
      models,
      enforced: value.enforced,
      promptCachePassthrough: value.promptCachePassthrough !== false,
    };
  }
  if (value.kind === 'usage-data') {
    // Prohibitions only narrow, so a missing or malformed flag reads as
    // "not prohibited" and unknown keys from a newer server are ignored.
    const prohibited = isRecord(value.prohibited) ? value.prohibited : {};
    return {
      kind: 'usage-data',
      prohibited: {
        productAnalytics: prohibited.productAnalytics === true,
        errorReports: prohibited.errorReports === true,
        sessionReplay: prohibited.sessionReplay === true,
        activeUseSignal: prohibited.activeUseSignal === true,
        featureFlagIdentity: prohibited.featureFlagIdentity === true,
      },
    };
  }
  return null;
}

/**
 * Normalize a full `enforcedSettings` array. Non-arrays, entries missing the
 * org id/name, and unknown policies are dropped, so the result is always a
 * well-formed (possibly empty) list.
 */
export function normalizeOrgEnforcedSettings(
  value: unknown,
): CanopyOrgEnforcedSettings[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: CanopyOrgEnforcedSettings[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.organizationId !== 'string' ||
      typeof entry.organizationName !== 'string'
    ) {
      continue;
    }
    const rawPolicies = Array.isArray(entry.policies) ? entry.policies : [];
    let modelGatewayEnforcementUnavailable =
      entry.modelGatewayEnforcementUnavailable === true;
    const policies: CanopyOrgEnforcedPolicy[] = [];
    for (const rawPolicy of rawPolicies) {
      const policy = normalizeOrgEnforcedPolicy(rawPolicy);
      if (policy !== null) {
        policies.push(policy);
        continue;
      }
      if (
        isRecord(rawPolicy) &&
        rawPolicy.kind === 'model-gateway' &&
        rawPolicy.enforced !== false
      ) {
        modelGatewayEnforcementUnavailable = true;
      }
    }
    result.push({
      organizationId: entry.organizationId,
      organizationName: entry.organizationName,
      policies,
      ...(modelGatewayEnforcementUnavailable
        ? { modelGatewayEnforcementUnavailable: true }
        : {}),
    });
  }
  return result;
}

function telemetryScopeMapIsUsable(value: unknown): boolean {
  return (
    isRecord(value) &&
    ['metadata', 'plans', 'summaries', 'transcripts'].every(
      (scope) =>
        value[scope] === undefined || typeof value[scope] === 'boolean',
    )
  );
}
function telemetrySnapshotIsUsable(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.organizationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          entry.organizationId,
        ) ||
        typeof entry.organizationName !== 'string' ||
        !Array.isArray(entry.policies)
      )
        return false;
      return entry.policies.every(
        (policy) =>
          isRecord(policy) &&
          typeof policy.kind === 'string' &&
          (policy.kind !== 'telemetry-sync' ||
            (telemetryScopeMapIsUsable(policy.scopes) &&
              (policy.prohibitedScopes === undefined ||
                telemetryScopeMapIsUsable(policy.prohibitedScopes)))),
      );
    })
  );
}

export function normalizeOrgEnforcedSettingsWithStatus(value: unknown): {
  settings: CanopyOrgEnforcedSettings[];
  telemetryEnforcementUnavailable?: boolean;
  modelGatewayEnforcementUnavailable: boolean;
} {
  const settings = normalizeOrgEnforcedSettings(value);
  const topLevelContainerIsUsable = Array.isArray(value);
  const malformedRecordValues: unknown[] = [];
  let malformedContainerExceededScanBound = false;
  if (!topLevelContainerIsUsable && isRecord(value)) {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (malformedRecordValues.length >= MODEL_GATEWAY_MAX_MODELS) {
        malformedContainerExceededScanBound = true;
        break;
      }
      malformedRecordValues.push(value[key]);
    }
  }
  const rawEntries = topLevelContainerIsUsable
    ? value
    : isRecord(value)
      ? [value, ...malformedRecordValues]
      : [];
  const recognizableEnforcedGatewayIsUnusable = rawEntries.some((entry) => {
    if (!isRecord(entry)) return false;
    const organizationIsUsable =
      typeof entry.organizationId === 'string' &&
      typeof entry.organizationName === 'string';
    const rawPolicies = Array.isArray(entry.policies)
      ? entry.policies
      : [entry.policies];
    return rawPolicies.some((rawPolicy) => {
      if (
        !isRecord(rawPolicy) ||
        rawPolicy.kind !== 'model-gateway' ||
        rawPolicy.enforced === false
      ) {
        return false;
      }
      return (
        !topLevelContainerIsUsable ||
        !organizationIsUsable ||
        !Array.isArray(entry.policies) ||
        normalizeOrgEnforcedPolicy(rawPolicy) === null
      );
    });
  });
  return {
    settings,
    ...(!telemetrySnapshotIsUsable(value)
      ? { telemetryEnforcementUnavailable: true }
      : {}),
    modelGatewayEnforcementUnavailable:
      malformedContainerExceededScanBound ||
      recognizableEnforcedGatewayIsUnusable ||
      settings.some(
        (entry) => entry.modelGatewayEnforcementUnavailable === true,
      ),
  };
}

export interface ModelGatewayAccountFields {
  personalModelGateway?: CanopyAccountResponse['personalModelGateway'];
  personalModelGatewayEnforcementUnavailable?: true;
  personalModelGatewayConfig?: PersonalModelGatewayConfig;
  organizationModelGatewayConfigs?: OrganizationModelGatewayConfig[];
}

/**
 * The account's gateway fields: the Personal routing projection and the saved
 * configurations behind it. Personal is never included in organization
 * consent or the enforcing union.
 */
export function modelGatewayAccountFields(
  value: unknown,
): ModelGatewayAccountFields {
  if (!isRecord(value)) return {};
  return {
    ...personalGatewayRouteFields(value),
    ...modelGatewayConfigFields(value),
  };
}

function modelGatewayConfigFields(
  value: Record<string, unknown>,
): Pick<
  ModelGatewayAccountFields,
  'personalModelGatewayConfig' | 'organizationModelGatewayConfigs'
> {
  const personal = personalGatewayConfigField(value);
  const organizations = organizationGatewayConfigsField(
    value.organizationModelGatewayConfigs,
  );
  return {
    ...(personal ? { personalModelGatewayConfig: personal } : {}),
    ...(organizations
      ? { organizationModelGatewayConfigs: organizations }
      : {}),
  };
}

function personalGatewayConfigField(
  value: Record<string, unknown>,
): PersonalModelGatewayConfig | undefined {
  const raw = value.personalModelGatewayConfig;
  const organizationId = normalizePersonalOrganizationId(
    value.personalOrganizationId,
  );
  if (
    !isRecord(raw) ||
    organizationId === null ||
    normalizePersonalOrganizationId(raw.organizationId) !== organizationId ||
    typeof raw.enabled !== 'boolean'
  )
    return undefined;
  if (raw.baseUrl === null)
    return { organizationId, enabled: false, baseUrl: null };
  // An unparseable URL is unknown, never "removed".
  const baseUrl = normalizeModelGatewayBaseUrl(raw.baseUrl);
  return baseUrl
    ? { organizationId, enabled: raw.enabled, baseUrl }
    : undefined;
}

const GATEWAY_URL_FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * One malformed entry makes the whole list unknown: an organization missing
 * from it reads as a removed gateway, so a partial list is never kept.
 */
function organizationGatewayConfigsField(
  raw: unknown,
): OrganizationModelGatewayConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const configs: OrganizationModelGatewayConfig[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.enabled !== 'boolean' ||
      typeof entry.configured !== 'boolean'
    )
      return undefined;
    const organizationId = normalizeUuid(entry.organizationId);
    if (organizationId === null) return undefined;
    if (!entry.configured) {
      configs.push({ organizationId, enabled: false, configured: false });
      continue;
    }
    if (
      typeof entry.baseUrlFingerprint !== 'string' ||
      !GATEWAY_URL_FINGERPRINT.test(entry.baseUrlFingerprint)
    )
      return undefined;
    configs.push({
      organizationId,
      enabled: entry.enabled,
      configured: true,
      baseUrlFingerprint: entry.baseUrlFingerprint,
    });
  }
  return configs;
}

function personalGatewayRouteFields(
  value: Record<string, unknown>,
): Pick<
  ModelGatewayAccountFields,
  'personalModelGateway' | 'personalModelGatewayEnforcementUnavailable'
> {
  if (value.personalModelGateway === undefined) return {};
  const raw = value.personalModelGateway;
  if (!isRecord(raw))
    return { personalModelGatewayEnforcementUnavailable: true };
  const policy = normalizeOrgEnforcedPolicy(raw);
  if (
    policy?.kind !== 'model-gateway' ||
    typeof raw.organizationId !== 'string' ||
    normalizePersonalOrganizationId(raw.organizationId) === null ||
    normalizePersonalOrganizationId(raw.organizationId) !==
      normalizePersonalOrganizationId(value.personalOrganizationId)
  ) {
    return raw.enforced === false
      ? {}
      : { personalModelGatewayEnforcementUnavailable: true };
  }
  return {
    personalModelGateway: { ...policy, organizationId: raw.organizationId },
  };
}

/** Preserve uncertainty before the tolerant shared normalizer drops bad rows. */
export function cloudModelPolicySnapshotUnavailable(value: unknown): boolean {
  return (
    !Array.isArray(value) ||
    value.some((setting: unknown) => {
      if (
        !isRecord(setting) ||
        typeof setting.organizationId !== 'string' ||
        setting.organizationId.trim().length === 0 ||
        typeof setting.organizationName !== 'string' ||
        !Array.isArray(setting.policies)
      )
        return true;
      return setting.policies.some((policy: unknown) => {
        if (!isRecord(policy) || typeof policy.kind !== 'string') return true;
        return (
          policy.kind === 'model-policy' &&
          (!Array.isArray(policy.reviewedModelIds) ||
            !policy.reviewedModelIds.every(
              (id: unknown) => typeof id === 'string',
            ) ||
            !Array.isArray(policy.blockedModelIds) ||
            !policy.blockedModelIds.every(
              (id: unknown) => typeof id === 'string',
            ))
        );
      });
    })
  );
}
