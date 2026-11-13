import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { ModelGatewayModel } from '@canopy/protocol/canopy-server';
import {
  AI_GATEWAY_MODELS,
  getExecutionHarnessForModel,
  type CanopyCloudAccountPublicState,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import {
  gatewayRequirementForOwner,
  isModelExcludedByGatewayRequirement,
  isOrgGatewayRouteUsableByOwner,
  listOrgGatewayModelsForOrganization,
  resolveModelGatewayIndex,
  soleEnforcingOrganizationId,
  type OrganizationModelGateway,
  type ModelGatewayIndex,
  type ModelGatewayRequirement,
} from '@canopy/desktop-shared/lib/org-model-gateway';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { resolveOrgGatewayOrganizationId } from '@canopy/execution-engine/lib/gateway-model-availability';
import { getObservabilityService } from '../observability';
import {
  readCanopyCloudAccountWithStatus,
  toPublicCanopyCloudAccountState,
} from './canopy-cloud-account-store';
import { updateOrgGatewayModelCatalog } from './model-config';
import { getModelGatewayMarkerFilePath } from './paths';
import { writeFileAtomically } from './atomic-file';
import { shouldRecordUnknownEnforcementOwner } from '../agents/work-owner';
import { personalGatewayAccountFields } from '@canopy/desktop-shared/lib/org-enforced-parsing';

interface ModelGatewayMarkerFile {
  version: 1;
  personalOrganizationId?: string;
  personalGatewayEnforced?: boolean;
  personalModelGateway?: CanopyCloudAccountPublicState['personalModelGateway'];
  orgEnforced: boolean;
  governedOrganizationIds?: string[];
  ungovernedOrganizationIds?: string[];
}

export type ModelGatewayAccountUpdate =
  | {
      changed: false;
      changedOrganizationIds: readonly string[];
      catalogChanged?: boolean;
    }
  | {
      changed: true;
      catalogChanged?: boolean;
      changedOrganizationIds: readonly string[] | 'all';
      personalOrganizationIds?: readonly string[];
    };

let currentIndex: ModelGatewayIndex = resolveModelGatewayIndex(null);
let markerCache: ModelGatewayMarkerFile | null = null;
let markerWriteQueue: Promise<void> = Promise.resolve();
const UNKNOWN_OWNER_DIAGNOSTIC_INTERVAL_MS = 5 * 60 * 1000;
const unknownOwnerDiagnostics = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const normalized = normalizeUuid(entry);
    return normalized ? [normalized] : [];
  });
}

function normalizeMarker(value: unknown): ModelGatewayMarkerFile {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.orgEnforced !== 'boolean'
  ) {
    return { version: 1, orgEnforced: false };
  }
  const governedOrganizationIds = normalizeIds(value.governedOrganizationIds);
  const ungovernedOrganizationIds = normalizeIds(
    value.ungovernedOrganizationIds,
  );
  return {
    version: 1,
    orgEnforced: value.orgEnforced,
    personalOrganizationId:
      normalizeUuid(value.personalOrganizationId) ?? undefined,
    personalGatewayEnforced: value.personalGatewayEnforced === true,
    ...personalGatewayAccountFields(value),
    ...(governedOrganizationIds === undefined
      ? {}
      : { governedOrganizationIds }),
    ...(ungovernedOrganizationIds === undefined
      ? {}
      : { ungovernedOrganizationIds }),
  };
}

async function readMarker(): Promise<ModelGatewayMarkerFile> {
  if (markerCache) return markerCache;
  try {
    markerCache = normalizeMarker(
      JSON.parse(
        await readFile(getModelGatewayMarkerFilePath(), 'utf8'),
      ) as unknown,
    );
  } catch {
    markerCache = { version: 1, orgEnforced: false };
  }
  return markerCache;
}

function markerForAccount(
  account: Pick<
    CanopyCloudAccountPublicState,
    'organizations' | 'personalModelGateway'
  > | null,
  index: ModelGatewayIndex,
): ModelGatewayMarkerFile {
  const governanceByOrganization = new Map<string, boolean>();
  for (const organization of account?.organizations ?? []) {
    const organizationId = normalizeUuid(organization.id);
    if (organizationId) {
      governanceByOrganization.set(organizationId, index.accountUnavailable);
    }
  }
  index.byOrganization.forEach((gateway, organizationId) => {
    if (organizationId === index.personalOrganizationId) return;
    governanceByOrganization.set(
      organizationId,
      index.accountUnavailable || gateway.enforced || gateway.unavailable,
    );
  });
  const governedOrganizationIds: string[] = [];
  const ungovernedOrganizationIds: string[] = [];
  governanceByOrganization.forEach((governed, organizationId) =>
    (governed ? governedOrganizationIds : ungovernedOrganizationIds).push(
      organizationId,
    ),
  );
  return {
    version: 1,
    personalOrganizationId: index.personalOrganizationId,
    personalGatewayEnforced:
      index.personalUnavailable ||
      (index.personalOrganizationId
        ? index.byOrganization.get(index.personalOrganizationId)?.enforced
        : false),
    personalModelGateway: account?.personalModelGateway,
    orgEnforced: index.accountUnavailable || governedOrganizationIds.length > 0,
    governedOrganizationIds,
    ungovernedOrganizationIds,
  };
}

function writeMarker(marker: ModelGatewayMarkerFile): void {
  if (JSON.stringify(markerCache) === JSON.stringify(marker)) return;
  markerCache = marker;
  const path = getModelGatewayMarkerFilePath();
  const contents = `${JSON.stringify(
    { ...marker, updatedAt: new Date().toISOString() },
    null,
    2,
  )}\n`;
  markerWriteQueue = markerWriteQueue
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomically(path, contents, {
        encoding: 'utf8',
        mode: 0o600,
      });
    })
    .catch(() => {
      if (markerCache === marker) markerCache = null;
    });
}

function recordDiagnostic(
  kind: 'model_gateway_read_failed' | 'model_enforcement_owner_unknown',
  reason: string,
  error?: unknown,
): void {
  const errorMessage =
    error instanceof Error
      ? error.message
      : error === undefined
        ? undefined
        : (JSON.stringify(error) ?? 'Unknown error');
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind,
      reason,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    });
  } catch {
    // Diagnostics are best effort and may never weaken the boundary.
  }
}

function recordUnknownOwner(
  owner: WorkOwner | undefined,
  callSite: string,
): void {
  if (!shouldRecordUnknownEnforcementOwner(owner)) return;
  const now = Date.now();
  const lastRecordedAt = unknownOwnerDiagnostics.get(callSite);
  if (
    lastRecordedAt !== undefined &&
    now >= lastRecordedAt &&
    now - lastRecordedAt < UNKNOWN_OWNER_DIAGNOSTIC_INTERVAL_MS
  )
    return;
  unknownOwnerDiagnostics.set(callSite, now);
  recordDiagnostic('model_enforcement_owner_unknown', callSite);
}

function requirementFromMarker(
  marker: ModelGatewayMarkerFile,
  owner: WorkOwner | undefined,
): ModelGatewayRequirement {
  if (owner?.kind === 'personal')
    return marker.personalGatewayEnforced
      ? { kind: 'blocked', reason: 'account-unavailable' }
      : { kind: 'unrestricted' };
  const hasLists =
    marker.governedOrganizationIds !== undefined ||
    marker.ungovernedOrganizationIds !== undefined;
  if (!hasLists) {
    return marker.orgEnforced
      ? { kind: 'blocked', reason: 'account-unavailable' }
      : { kind: 'unrestricted' };
  }
  if (owner?.kind !== 'organization') {
    return { kind: 'blocked', reason: 'account-unavailable' };
  }
  const organizationId = normalizeUuid(owner.organizationId);
  return organizationId &&
    marker.ungovernedOrganizationIds?.includes(organizationId)
    ? { kind: 'unrestricted' }
    : { kind: 'blocked', reason: 'organization-unavailable' };
}

function catalogGateways(
  index: ModelGatewayIndex,
): Parameters<typeof updateOrgGatewayModelCatalog>[0] {
  const gateways: Array<{
    organizationId: string;
    organizationName: string;
    baseUrl: string;
    models: readonly ModelGatewayModel[];
    promptCachePassthrough: boolean;
    personal?: boolean;
  }> = [];
  index.byOrganization.forEach((gateway, organizationId) => {
    if (gateway.unavailable || !gateway.baseUrl) return;
    gateways.push({
      organizationId,
      personal: organizationId === index.personalOrganizationId,
      organizationName: gateway.organizationName,
      baseUrl: gateway.baseUrl,
      models: gateway.models,
      promptCachePassthrough: gateway.promptCachePassthrough,
    });
  });
  return gateways;
}

export function setCurrentModelGatewayAccount(
  account: Pick<
    CanopyCloudAccountPublicState,
    | 'account'
    | 'enforcedSettings'
    | 'modelGatewayEnforcementUnavailable'
    | 'organizations'
    | 'personalOrganizationId'
    | 'personalModelGateway'
    | 'personalModelGatewayEnforcementUnavailable'
  > | null,
): ModelGatewayAccountUpdate {
  const next = resolveModelGatewayIndex(account);
  const allOrganizationIds = new Set<string>();
  currentIndex.byOrganization.forEach((_gateway, organizationId) =>
    allOrganizationIds.add(organizationId),
  );
  next.byOrganization.forEach((_gateway, organizationId) =>
    allOrganizationIds.add(organizationId),
  );
  const catalogChanged = Array.from(allOrganizationIds).some(
    (id) =>
      JSON.stringify(currentIndex.byOrganization.get(id)) !==
      JSON.stringify(next.byOrganization.get(id)),
  );
  const personalOrganizationIds = [
    currentIndex.personalOrganizationId,
    next.personalOrganizationId,
  ].filter((id): id is string => id !== undefined);
  const executionPolicy = (
    gateway: OrganizationModelGateway | undefined,
  ):
    | Omit<OrganizationModelGateway, 'organizationName' | 'displayName'>
    | undefined =>
    gateway
      ? {
          baseUrl: gateway.baseUrl,
          enforced: gateway.enforced,
          promptCachePassthrough: gateway.promptCachePassthrough,
          models: gateway.models,
          unavailable: gateway.unavailable,
        }
      : undefined;
  const changedOrganizationIds = Array.from(allOrganizationIds).filter(
    (organizationId) =>
      JSON.stringify(
        executionPolicy(currentIndex.byOrganization.get(organizationId)),
      ) !==
      JSON.stringify(executionPolicy(next.byOrganization.get(organizationId))),
  );
  const accountChanged =
    currentIndex.accountId !== next.accountId ||
    currentIndex.accountUnavailable !== next.accountUnavailable ||
    currentIndex.personalUnavailable !== next.personalUnavailable;
  currentIndex = next;
  writeMarker(markerForAccount(account, next));
  if (accountChanged || catalogChanged) {
    updateOrgGatewayModelCatalog(catalogGateways(next));
  }
  return accountChanged
    ? { changed: true, changedOrganizationIds: 'all', personalOrganizationIds }
    : changedOrganizationIds.length > 0
      ? { changed: true, changedOrganizationIds, personalOrganizationIds }
      : { changed: false, changedOrganizationIds: [], catalogChanged };
}

export async function getModelGatewayRequirementForOwner(
  owner: WorkOwner | undefined,
  callSite = 'unknown',
): Promise<ModelGatewayRequirement> {
  recordUnknownOwner(owner, callSite);
  const enforcementOwner = owner;
  const result = await readCanopyCloudAccountWithStatus();
  if (result.status === 'ok') {
    const account = toPublicCanopyCloudAccountState(result.entry);
    const index = resolveModelGatewayIndex(account);
    // Only the account applier advances the shared index: an admission read
    // must not consume the diff before session invalidation processes it.
    writeMarker(markerForAccount(account, index));
    return gatewayRequirementForOwner(index, enforcementOwner);
  }
  recordDiagnostic(
    'model_gateway_read_failed',
    result.status === 'unavailable'
      ? 'safe-storage-unavailable'
      : 'account-read-error',
    result.status === 'error' ? result.error : undefined,
  );
  const marker = await readMarker();
  return requirementFromMarker(marker, enforcementOwner);
}

export function getCurrentModelGatewayRequirementForOwner(
  owner: WorkOwner | undefined,
): ModelGatewayRequirement {
  return gatewayRequirementForOwner(currentIndex, owner);
}

export function isModelExcludedByCurrentGatewayRequirement(
  modelId: string | undefined,
  owner: WorkOwner | undefined,
): boolean {
  const enforcementOwner = owner;
  return isModelExcludedByGatewayRequirement(
    modelId,
    gatewayRequirementForOwner(currentIndex, enforcementOwner),
    enforcementOwner,
    currentIndex.personalOrganizationId,
  );
}

function organizationName(organizationId: string | undefined): string {
  return (
    (organizationId
      ? currentIndex.byOrganization.get(organizationId)?.organizationName
      : undefined) ?? 'Your organization'
  );
}

export async function checkModelGatewayRoute(
  modelId: string | undefined,
  owner: WorkOwner | undefined,
): Promise<{ ok: true; orgRoute: boolean } | { ok: false; message: string }> {
  const enforcementOwner = owner;
  const requirement = await getModelGatewayRequirementForOwner(
    owner,
    'checkModelGatewayRoute',
  );
  const routeOrganizationId = normalizeUuid(
    resolveOrgGatewayOrganizationId(modelId),
  );
  if (
    !isOrgGatewayRouteUsableByOwner(
      modelId,
      enforcementOwner,
      currentIndex.personalOrganizationId,
    )
  ) {
    return {
      ok: false,
      message: 'This model belongs to another AI gateway.',
    };
  }
  if (requirement.kind === 'blocked') {
    return {
      ok: false,
      message:
        enforcementOwner?.kind === 'personal'
          ? 'Your AI gateway settings are unavailable.'
          : `${organizationName(
              enforcementOwner?.kind === 'organization'
                ? enforcementOwner.organizationId
                : undefined,
            )}'s AI gateway settings are unavailable.`,
    };
  }
  if (
    isModelExcludedByGatewayRequirement(
      modelId,
      requirement,
      enforcementOwner,
      currentIndex.personalOrganizationId,
    )
  ) {
    const requiredOrganizationId = soleEnforcingOrganizationId(requirement);
    return {
      ok: false,
      message:
        enforcementOwner?.kind === 'personal'
          ? 'Use a model from your AI gateway to send this.'
          : `${organizationName(
              requiredOrganizationId,
            )} requires model traffic to use its configured gateway.`,
    };
  }
  return { ok: true, orgRoute: routeOrganizationId !== null };
}

export async function resolveHelperModelForEnforcedGateway(
  model: ChatModel | undefined,
  owner: WorkOwner | undefined,
): Promise<ChatModel | undefined> {
  const enforcementOwner = owner;
  const requirement = await getModelGatewayRequirementForOwner(
    owner,
    'resolveHelperModelForEnforcedGateway',
  );
  if (requirement.kind !== 'enforced') return model;
  if (
    model &&
    !isOrgGatewayRouteUsableByOwner(
      model,
      enforcementOwner,
      currentIndex.personalOrganizationId,
    )
  ) {
    return undefined;
  }
  if (
    model &&
    !isModelExcludedByGatewayRequirement(
      model,
      requirement,
      enforcementOwner,
      currentIndex.personalOrganizationId,
    )
  ) {
    return model;
  }
  if (!enforcementOwner && requirement.organizationIds.length > 1) {
    recordUnknownOwner(
      undefined,
      'resolveHelperModelForEnforcedGateway:multiple',
    );
    return model;
  }
  const organizationId = soleEnforcingOrganizationId(requirement);
  if (!organizationId) return model;
  const orgModels = listOrgGatewayModelsForOrganization(
    AI_GATEWAY_MODELS,
    organizationId,
  );
  if (orgModels.length === 0) return model;
  const harness = model ? getExecutionHarnessForModel(model) : undefined;
  return (
    orgModels.find(
      (candidate) => getExecutionHarnessForModel(candidate) === harness,
    ) ?? orgModels[0]
  );
}

export function resetModelGatewayStateForTests(): void {
  currentIndex = resolveModelGatewayIndex(null);
  markerCache = null;
  markerWriteQueue = Promise.resolve();
  unknownOwnerDiagnostics.clear();
}
