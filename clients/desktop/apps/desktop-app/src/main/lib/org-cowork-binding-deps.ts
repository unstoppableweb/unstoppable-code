import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { orgDefaultCoworkWorkspaceId } from '@canopy/protocol/ui-labels';
import {
  IPC_CHANNELS,
  type WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import type {
  ClaimOrgProjectInstanceRequest,
  ClaimOrgProjectInstanceResponse,
  CompleteOrgProjectInstanceRequest,
} from '@canopy/protocol/org-projects';
import {
  CanopyCloudClientError,
  ensureOrgDefaultChats,
  requestCanopyCloudJson,
} from '../canopy-cloud/client';
import { getDesktopOAuthClientDeviceId } from '../canopy-cloud/oauth-login';
import { getFeatureFlagService } from '../feature-flags';
import { getObservabilityService } from '../observability';
import {
  createOrgCoworkBinding,
  type OrgCoworkBinding,
} from './org-cowork-binding';
import { readCanopyCloudAccountWithStatus } from './canopy-cloud-account-store';
import { readInstallationGeneration } from './installation-generation';
import { isOrganizationTeamsLapsed } from './org-billing-state';
import { readAllSidebarItemsSnapshot } from './sidebar-items';
import {
  isCoworkW5WriteRefusal,
  refuseCoworkProvisionWhileW5Degraded,
} from './cowork-w5-write-refusal';
import { getSidebarItemsPreserveWorkspaceIds } from './sidebar-items-preservation';
import { getWorkspaceContextService } from './workspace-context-service';
import { readWorkspaceOwnership } from './workspace-persistence';
import { sendToAllWindows } from './window-send';
import { detachedWorkCallback } from '@canopy/desktop-shared/node/lib/detached-work';

export type OrgDefaultCoworkEligibility = 'eligible' | 'ineligible';
export type OrgMemberCodeEligibility = 'eligible' | 'ineligible';

const permanentlyIneligibleOrganizations = new Set<string>();
/** A ready default Chats workspace answers repeat listings this long (CAN-6096). */
const PROVISIONED_TTL_MS = 2 * 60_000;
const provisioning = new Map<string, Promise<void>>();
const provisionedAt = new Map<string, number>();
let provisioningGeneration = 0;
let binding: OrgCoworkBinding | undefined;
let installed = false;

function createProductionBinding(): OrgCoworkBinding {
  return createOrgCoworkBinding({
    cloud: {
      ensureDefaultChats: (organizationId) =>
        ensureOrgDefaultChats({ organizationId }),
      claim: (
        projectId: string,
        request: ClaimOrgProjectInstanceRequest,
      ): Promise<ClaimOrgProjectInstanceResponse> =>
        requestCanopyCloudJson(
          `/api/v1/projects/${encodeURIComponent(projectId)}/instances/claim`,
          { method: 'POST', body: JSON.stringify(request) },
        ),
      complete: (
        instanceId: string,
        request: CompleteOrgProjectInstanceRequest,
      ): Promise<void> =>
        requestCanopyCloudJson(
          `/api/v1/projects/instances/${encodeURIComponent(instanceId)}/complete`,
          { method: 'POST', body: JSON.stringify(request) },
        ),
    },
    readOwnership: readWorkspaceOwnership,
    resolveDeviceId: getDesktopOAuthClientDeviceId,
    readInstallationGeneration,
    isClaimConflict: (error) =>
      error instanceof CanopyCloudClientError &&
      error.status === 409 &&
      error.serverCode === 'conflict',
  });
}

export function getOrgCoworkBinding(): OrgCoworkBinding {
  binding ??= createProductionBinding();
  return binding;
}

/**
 * Which organization an operation may target. `selected` (the default)
 * requires the selected workspace context to be that organization.
 * `membership` accepts any organization the member belongs to, for an explicit
 * pick such as the sidebar's Move to organization; it never switches context.
 */
export type OrgOperationScope = 'selected' | 'membership';

export interface OrgOperationEligibilityOptions {
  scope?: OrgOperationScope;
}

function isOrganizationInScope(
  organizationId: string,
  scope: OrgOperationScope,
): boolean {
  const state = getWorkspaceContextService().getState();
  if (scope === 'membership') {
    return state.organizations.some(
      (organization) => organization.id === organizationId,
    );
  }
  return (
    state.context.kind === 'organization' &&
    state.context.organizationId === organizationId
  );
}

export async function isOrgCoworkOperationEligible(
  organizationId: string,
  options: OrgOperationEligibilityOptions = {},
): Promise<boolean> {
  if (permanentlyIneligibleOrganizations.has(organizationId)) return false;
  if (
    !getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    )
  ) {
    return false;
  }
  if (!isOrganizationInScope(organizationId, options.scope ?? 'selected')) {
    return false;
  }
  if (await isOrganizationTeamsLapsed(organizationId)) {
    return false;
  }
  const account = await readCanopyCloudAccountWithStatus();
  if (account.status === 'unavailable') {
    throw new Error('The cloud account store is temporarily unavailable');
  }
  if (account.status === 'error') {
    throw account.error instanceof Error
      ? account.error
      : new Error('The cloud account could not be read');
  }
  return account.entry?.capabilities.includes('org-projects-v1') === true;
}

function permanentRejection(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    error.code === 'http-error' &&
    (error.status === 403 || error.status === 404)
  );
}

function recordFailure(error: unknown): void {
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'org_default_chats_provision_failed',
    reason: permanentRejection(error) ? 'permanent' : 'transient',
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function getOrgDefaultCoworkEligibility(
  organizationId: string,
): Promise<OrgDefaultCoworkEligibility> {
  return (await isOrgCoworkOperationEligible(organizationId))
    ? 'eligible'
    : 'ineligible';
}

export async function isOrgMemberCodeOperationEligible(
  organizationId: string,
  options: OrgOperationEligibilityOptions = {},
): Promise<boolean> {
  if (!(await isOrgCoworkOperationEligible(organizationId, options)))
    return false;
  const account = await readCanopyCloudAccountWithStatus();
  if (account.status === 'unavailable')
    throw new Error('The cloud account store is temporarily unavailable');
  if (account.status === 'error')
    throw account.error instanceof Error
      ? account.error
      : new Error('The cloud account could not be read');
  return (
    account.entry?.capabilities.includes('org-member-code-projects-v1') === true
  );
}

export async function getOrgMemberCodeEligibility(
  organizationId: string,
): Promise<OrgMemberCodeEligibility> {
  return (await isOrgMemberCodeOperationEligible(organizationId))
    ? 'eligible'
    : 'ineligible';
}

/** Ensure the selected organization's bound local Chats workspace. */
export async function ensureOrgDefaultCoworkWorkspace(
  organizationId: string,
): Promise<void> {
  if (!(await isOrgCoworkOperationEligible(organizationId))) {
    throw new Error('Organization Chats is not available');
  }
  try {
    // The hosted ensure runs before the local records: refuse first while W5
    // writes are refused, after an index read settles the handoff (CAN-7316).
    await readAllSidebarItemsSnapshot();
    refuseCoworkProvisionWhileW5Degraded();
    const localWorkspaceId = orgDefaultCoworkWorkspaceId(organizationId);
    let repairedIndexedWorkspace = false;
    const ensureLocal = async (
      owner: WorkspaceOwnerBinding,
      publish: boolean,
    ): Promise<void> => {
      const snapshot = await readAllSidebarItemsSnapshot();
      if (
        snapshot.indexAuthority !== 'ok' &&
        snapshot.indexAuthority !== 'absent'
      ) {
        throw new Error('The workspace index is unavailable');
      }
      const preserveWorkspaceIds = getSidebarItemsPreserveWorkspaceIds(
        snapshot.file,
      );
      const repairsIndexedProjection =
        !publish &&
        !snapshot.file.items.some((item) => item.id === localWorkspaceId) &&
        preserveWorkspaceIds.includes(localWorkspaceId);
      // Deferred: cowork-workspace-crud reaches this module back through the
      // sidebar, watcher and project-discovery imports.
      const { ensureDefaultCoworkWorkspace } =
        await import('./cowork-workspace-crud');
      await ensureDefaultCoworkWorkspace(
        snapshot.file.items,
        preserveWorkspaceIds,
        { id: localWorkspaceId, owner },
        { publishToIndex: publish },
      );
      if (repairsIndexedProjection) repairedIndexedWorkspace = true;
      if (publish && repairedIndexedWorkspace) {
        sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, {
          workspaceId: localWorkspaceId,
        });
      }
    };
    await getOrgCoworkBinding().ensureOrgDefaultCoworkWorkspace(
      organizationId,
      (owner) => ensureLocal(owner, false),
      (owner) => ensureLocal(owner, true),
    );
    permanentlyIneligibleOrganizations.delete(organizationId);
  } catch (error) {
    if (permanentRejection(error)) {
      permanentlyIneligibleOrganizations.add(organizationId);
    }
    // A degraded handoff refuses every attempt until restart and records its
    // own w5_handoff_degraded diagnostic; don't add one per refused attempt.
    if (!isCoworkW5WriteRefusal(error)) recordFailure(error);
    throw error;
  }
}

function forgetProvisioning(): void {
  provisioningGeneration += 1;
  provisioning.clear();
  provisionedAt.clear();
}

/**
 * Fire-and-forget provisioning used by startup, context switches, and lists.
 * Concurrent starts share one attempt and a success answers repeats for
 * {@link PROVISIONED_TTL_MS}; a failure is never remembered.
 */
export function startOrgDefaultCoworkProvisioning(
  organizationId: string,
): Promise<void> {
  const inFlight = provisioning.get(organizationId);
  if (inFlight) return inFlight;
  const readyAt = provisionedAt.get(organizationId);
  if (readyAt !== undefined && Date.now() - readyAt < PROVISIONED_TTL_MS)
    return Promise.resolve();
  const generation = provisioningGeneration;
  const attempt = ensureOrgDefaultCoworkWorkspace(organizationId)
    .then(
      () => {
        if (generation === provisioningGeneration)
          provisionedAt.set(organizationId, Date.now());
      },
      () => undefined,
    )
    .finally(() => {
      if (provisioning.get(organizationId) === attempt)
        provisioning.delete(organizationId);
    });
  provisioning.set(organizationId, attempt);
  return attempt;
}

export function installOrgDefaultCoworkProvisioning(): void {
  if (installed) return;
  installed = true;
  const contextService = getWorkspaceContextService();
  const startForContext = (
    context: ReturnType<typeof contextService.getState>['context'],
  ): void => {
    if (context.kind === 'organization') {
      detachedWorkCallback(() =>
        startOrgDefaultCoworkProvisioning(context.organizationId),
      )();
    }
  };
  startForContext(contextService.getState().context);
  contextService.subscribe((state) => {
    if (state.reason === 'account-change') {
      permanentlyIneligibleOrganizations.clear();
    }
    forgetProvisioning();
    startForContext(state.context);
  });
}

export function resetOrgCoworkBindingForTests(): void {
  binding = undefined;
  installed = false;
  permanentlyIneligibleOrganizations.clear();
  forgetProvisioning();
}
