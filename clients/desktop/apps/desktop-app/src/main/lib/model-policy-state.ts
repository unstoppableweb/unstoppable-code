import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  isModelBlocked,
  modelPolicyForOwner,
  resolveModelPolicyIndex,
  type ModelPolicyIndex,
} from '@canopy/desktop-shared/lib/model-policy';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import {
  isOllamaModel,
  type CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import { getObservabilityService } from '../observability';
import {
  readCanopyCloudAccountWithStatus,
  toPublicCanopyCloudAccountState,
} from './canopy-cloud-account-store';
import { getModelPolicyMarkerFilePath } from './paths';
import { writeFileAtomically } from './atomic-file';
import {
  resolveEnforcementOwner,
  shouldRecordUnknownEnforcementOwner,
} from '../agents/work-owner';

const MODEL_POLICY_MARKER_VERSION = 1;

interface ModelPolicyMarkerFile {
  version: 1;
  orgEnforced: boolean;
  governedOrganizationIds?: string[];
  ungovernedOrganizationIds?: string[];
  updatedAt?: string;
}

export interface ModelPolicyDecision {
  blocked: boolean;
  degraded: boolean;
}

let currentPolicyIndex: ModelPolicyIndex = resolveModelPolicyIndex(null);
let currentMarker: ModelPolicyMarkerFile = {
  version: 1,
  orgEnforced: false,
  governedOrganizationIds: [],
  ungovernedOrganizationIds: [],
};
let degradedRead = false;
let markerCache: ModelPolicyMarkerFile | null = null;
let markerLoad: Promise<ModelPolicyMarkerFile> | null = null;
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

function normalizeMarkerFile(value: unknown): ModelPolicyMarkerFile {
  if (
    !isRecord(value) ||
    value.version !== MODEL_POLICY_MARKER_VERSION ||
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
    ...(governedOrganizationIds === undefined
      ? {}
      : { governedOrganizationIds }),
    ...(ungovernedOrganizationIds === undefined
      ? {}
      : { ungovernedOrganizationIds }),
  };
}

async function readMarkerFile(): Promise<ModelPolicyMarkerFile> {
  try {
    return normalizeMarkerFile(
      JSON.parse(
        await readFile(getModelPolicyMarkerFilePath(), 'utf8'),
      ) as unknown,
    );
  } catch {
    return { version: 1, orgEnforced: false };
  }
}

async function loadMarker(): Promise<ModelPolicyMarkerFile> {
  if (markerCache) return markerCache;
  markerLoad ??= readMarkerFile();
  markerCache = await markerLoad;
  return markerCache;
}

function markerForAccount(
  account: Pick<
    CanopyCloudAccountPublicState,
    'enforcedSettings' | 'organizations'
  > | null,
): ModelPolicyMarkerFile {
  const governanceByOrganization = new Map<string, boolean>();
  for (const organization of account?.organizations ?? []) {
    const organizationId = normalizeUuid(organization.id);
    if (organizationId) governanceByOrganization.set(organizationId, false);
  }
  for (const setting of account?.enforcedSettings ?? []) {
    const organizationId = normalizeUuid(setting.organizationId);
    if (!organizationId) continue;
    const governed = setting.policies.some(
      (policy) => policy.kind === 'model-policy',
    );
    governanceByOrganization.set(organizationId, governed);
  }
  const governedOrganizationIds: string[] = [];
  const ungovernedOrganizationIds: string[] = [];
  governanceByOrganization.forEach((governed, organizationId) =>
    (governed ? governedOrganizationIds : ungovernedOrganizationIds).push(
      organizationId,
    ),
  );
  return {
    version: 1,
    orgEnforced: governedOrganizationIds.length > 0,
    governedOrganizationIds,
    ungovernedOrganizationIds,
  };
}

/** Admission observes the persisted projection after its effective route read. */
export function settleModelPolicyMarkerWrites(): Promise<void> {
  return markerWriteQueue;
}

function writeMarker(marker: ModelPolicyMarkerFile): void {
  currentMarker = marker;
  markerLoad = null;
  if (JSON.stringify(markerCache) === JSON.stringify(marker)) return;
  markerCache = marker;
  const path = getModelPolicyMarkerFilePath();
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

function recordReadFailure(reason: string, error?: unknown): void {
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
      kind: 'model_policy_read_failed',
      reason,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    });
  } catch {
    // Diagnostics are best effort and must not weaken enforcement.
  }
}

function recordUnknownOwner(
  callSite: string,
  owner: WorkOwner | undefined,
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
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'model_enforcement_owner_unknown',
      reason: callSite,
    });
  } catch {
    // Diagnostics are best effort and must not weaken enforcement.
  }
}

function degradedBlocked(
  marker: ModelPolicyMarkerFile,
  owner: WorkOwner | undefined,
): boolean {
  if (owner?.kind === 'personal') return false;
  const hasOrgLists =
    marker.governedOrganizationIds !== undefined ||
    marker.ungovernedOrganizationIds !== undefined;
  if (!hasOrgLists) return marker.orgEnforced;
  if (owner?.kind !== 'organization') return true;
  const organizationId = normalizeUuid(owner.organizationId);
  return (
    organizationId === null ||
    !marker.ungovernedOrganizationIds?.includes(organizationId)
  );
}

export async function readModelPolicyDecision(
  modelId: string | undefined,
  owner: WorkOwner | undefined,
  callSite = 'unknown',
): Promise<ModelPolicyDecision> {
  if (!modelId || isOllamaModel(modelId)) {
    return { blocked: false, degraded: false };
  }
  recordUnknownOwner(callSite, owner);
  const enforcementOwner = resolveEnforcementOwner(owner);
  const result = await readCanopyCloudAccountWithStatus();
  if (result.status === 'ok') {
    const account = toPublicCanopyCloudAccountState(result.entry);
    currentPolicyIndex = resolveModelPolicyIndex(account);
    writeMarker(markerForAccount(account));
    degradedRead = false;
    return {
      blocked: isModelBlocked(
        modelId,
        modelPolicyForOwner(currentPolicyIndex, enforcementOwner),
      ),
      degraded: false,
    };
  }
  recordReadFailure(
    result.status === 'unavailable'
      ? 'safe-storage-unavailable'
      : 'account-read-error',
    result.status === 'error' ? result.error : undefined,
  );
  degradedRead = true;
  const marker = await loadMarker();
  currentMarker = marker;
  return {
    blocked: degradedBlocked(marker, enforcementOwner),
    degraded: true,
  };
}

export async function isModelBlockedByStoredPolicy(
  modelId: string | undefined,
  owner?: WorkOwner,
): Promise<boolean> {
  return (await readModelPolicyDecision(modelId, owner)).blocked;
}

export interface OrgModelPolicyActivity {
  readonly active: boolean;
  /** This probe's own read failed, whatever later reads report. */
  readonly degraded: boolean;
}

export async function readOrgModelPolicyActivityForStoredAccount(
  owner?: WorkOwner,
): Promise<OrgModelPolicyActivity> {
  const decision = await readModelPolicyDecision(
    '__canopy_model_policy_active_probe__',
    owner,
  );
  if (decision.degraded) return { active: decision.blocked, degraded: true };
  return {
    active:
      modelPolicyForOwner(currentPolicyIndex, resolveEnforcementOwner(owner))
        .size > 0,
    degraded: false,
  };
}

export async function isOrgModelPolicyActiveForStoredAccount(
  owner?: WorkOwner,
): Promise<boolean> {
  return (await readOrgModelPolicyActivityForStoredAccount(owner)).active;
}

export function setCurrentModelPolicyAccount(
  account: Pick<
    CanopyCloudAccountPublicState,
    'enforcedSettings' | 'organizations'
  > | null,
): boolean {
  const next = resolveModelPolicyIndex(account);
  const changed =
    next.union.size !== currentPolicyIndex.union.size ||
    Array.from(next.union).some(
      (entry) => !currentPolicyIndex.union.has(entry),
    );
  currentPolicyIndex = next;
  writeMarker(markerForAccount(account));
  degradedRead = false;
  return changed;
}

export function isModelBlockedByCurrentPolicy(
  modelId: string | undefined,
  owner?: WorkOwner,
): boolean {
  if (!modelId || isOllamaModel(modelId)) return false;
  const enforcementOwner = resolveEnforcementOwner(owner);
  return degradedRead
    ? degradedBlocked(currentMarker, enforcementOwner)
    : isModelBlocked(
        modelId,
        modelPolicyForOwner(currentPolicyIndex, enforcementOwner),
      );
}

export function isStoredModelPolicyReadDegraded(): boolean {
  return degradedRead;
}

export function resetModelPolicyStateForTests(): void {
  currentPolicyIndex = resolveModelPolicyIndex(null);
  currentMarker = {
    version: 1,
    orgEnforced: false,
    governedOrganizationIds: [],
    ungovernedOrganizationIds: [],
  };
  degradedRead = false;
  markerCache = null;
  markerLoad = null;
  markerWriteQueue = Promise.resolve();
  unknownOwnerDiagnostics.clear();
}
