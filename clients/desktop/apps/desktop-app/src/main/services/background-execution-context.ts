import { dirname } from 'node:path';
import {
  projectBackgroundWorkspaceTarget,
  type BackgroundWorkspaceTarget,
} from './workspace-owner-projection';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  isAddressableSharedPipelineRemoteId,
  parseSharedPipelineLocalId,
} from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import type { createBackgroundCapabilityResolver } from './background-capability-context';
import type { ExecutionState } from '@canopy/execution-engine/node/pipelines/executor';
import type { getStoredPipelineBySource } from '@canopy/execution-engine/pipelines/store';
import {
  pipelineContextResources,
  localPipelineContextResources,
  type PipelineContextLocation,
} from '@canopy/desktop-shared/node/background-execution-context';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import type { ChildPipelineAuthorization } from '@canopy/execution-engine/node/pipelines/executor/child-pipeline-resolver';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { backgroundExecutionDeniedMessage } from '@canopy/desktop-shared/node/background-execution-context';
import {
  parseWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  authorizePipelineContextResources,
  type PipelineContextResource,
} from '@canopy/desktop-shared/node/background-execution-context';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import {
  getChatHookActionOverlayKey,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';
import type {
  ResourceContextDecision,
  ResourceContextInput,
} from '@canopy/execution-engine/lib/resource-context-policy';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getFeatureFlagService } from '../feature-flags';
import {
  recordedOwnershipChange,
  type WorkspaceOwnershipChange,
} from './background-execution-rebinding';
import type {
  AutomationAction,
  AutomationsListResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import {
  automationContextRefusalMessage,
  workspaceContextDisplayLabel,
  type AutomationContextRefusalAction,
  type BackgroundContextMismatchDetails,
} from '@canopy/execution-engine/lib/automation-context-copy';
import {
  isGlobalPipelineAutomationAction,
  resolveAutomationPipelineTarget,
} from '@canopy/desktop-shared/lib/automation-pipeline-target';

export function backgroundExecutionContextEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}

export async function captureBackgroundExecutionContext(): Promise<
  string | undefined
> {
  if (!backgroundExecutionContextEnabled()) return undefined;
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  return serializeWorkspaceContext(service.getState().context);
}

export async function resolveBackgroundWorkspaceTarget(
  projectId: string,
  worktreeId?: string,
): Promise<BackgroundWorkspaceTarget> {
  if (projectId === APP_ADVISOR_PROJECT_ID)
    return {
      workspaceOwner: { kind: 'personal' },
      linkedPersonalCandidate: false,
      ownershipTransferred: false,
      privateMemory: false,
      memoryMalformed: false,
    };
  let workspaceId = projectId;
  if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    if (!worktreeId)
      throw new Error(backgroundExecutionDeniedMessage('unknown-provenance'));
    workspaceId = resolveCoworkWorkspaceId(worktreeId);
  }
  // Defer the heavy workspace persistence/Portal/script-runner graph until authorization.
  const { readWorkspaceConfigDetailed } =
    await import('../lib/workspace-persistence');
  const read = await readWorkspaceConfigDetailed(workspaceId);
  return projectBackgroundWorkspaceTarget(read);
}

/** Read owner authority, never a renderer selection or a default on failed reads. */
export async function resolveBackgroundWorkspaceContext(
  projectId: string,
  worktreeId?: string,
): Promise<string> {
  const target = await resolveBackgroundWorkspaceTarget(projectId, worktreeId);
  return serializeWorkspaceContext(target.workspaceOwner);
}

/** Resolve current provenance while authorizing the exact persisted definition. */
export function persistedPipelineContextResources(
  state: ExecutionState | null,
  lookup: typeof getStoredPipelineBySource,
): PipelineContextResource[] {
  if (!state) return [{ owner: undefined }];
  const location: PipelineContextLocation = {
    cwd: state.cwd,
    repoPath: state.repo_path,
    pipelineId: state.pipeline_id,
    pipelineFileDir: state.pipeline_file_dir,
    pipelinePreferenceLocator: state.pipeline_preference_locator,
    pluginCollectionPreferences: state.plugin_collection_preferences,
    modelAliasPreferences: state.model_alias_preferences,
    resolvedPluginCollections: state.resolved_plugin_collections,
    preferencesResolved: true,
  };
  const locator = state.pipeline_preference_locator;
  if (locator?.type === 'file')
    return localPipelineContextResources(state.pipeline_snapshot, {
      ...location,
      pipelineFileDir: dirname(locator.value),
    });
  if (locator?.type === 'shared') {
    const parsed = parseSharedPipelineLocalId(`shared:${locator.value}`);
    if (
      parsed?.serverId === CANOPY_CLOUD_SERVER_ID &&
      isAddressableSharedPipelineRemoteId(parsed.remoteId) &&
      (!state.shared_pipeline_source ||
        (state.shared_pipeline_source.serverId === parsed.serverId &&
          state.shared_pipeline_source.remoteId === parsed.remoteId))
    ) {
      const resources = pipelineContextResources(
        state.pipeline_snapshot,
        undefined,
        location,
      );
      resources[0] = {
        owner: undefined,
        requiresHostAuthorization: true,
        capabilities: { sharedPipeline: { remoteId: parsed.remoteId } },
      };
      return resources;
    }
  }
  if (locator?.type === 'stored' && locator.source === 'curated') {
    if (
      state.curated_pipeline_source &&
      `curated:${state.curated_pipeline_source.key}` === locator.value &&
      (locator.contentHash === undefined ||
        state.curated_pipeline_source.contentHash === locator.contentHash)
    )
      return pipelineContextResources(
        state.pipeline_snapshot,
        { type: 'system' },
        location,
      );
  }
  if (
    locator?.type === 'shared' ||
    (locator?.type === 'stored' && locator.source === 'curated') ||
    (!locator && parseSharedPipelineLocalId(state.pipeline_id))
  )
    return pipelineContextResources(
      state.pipeline_snapshot,
      undefined,
      location,
    );
  if (
    locator?.type === 'stored' &&
    (locator.source === 'bundled' || locator.source === 'user')
  ) {
    const stored = lookup(locator.source, locator.value);
    if (stored.success && stored.data)
      return pipelineContextResources(
        state.pipeline_snapshot,
        stored.data.info.owner ??
          (locator.source === 'bundled'
            ? { type: 'system' }
            : locator.source === 'user'
              ? { shareScope: 'private' }
              : undefined),
        location,
        stored.data.info.remoteId ?? stored.data.info.id,
      );
  }
  return pipelineContextResources(
    state.pipeline_snapshot,
    undefined,
    location,
    state.pipeline_id,
  );
}

export interface BackgroundTargetContext {
  /** The target may run in the invocation context. */
  matches: boolean;
  target: NonNullable<ResourceContextInput['target']>;
  /** Where the target lives; the invocation context itself for App Advisor. */
  targetOwner: WorkspaceContext;
  ownershipTransferred: boolean;
}

/**
 * Resolve a background destination's owner and whether it matches `context`.
 * App Advisor has no workspace of its own, so it runs in whichever context
 * invoked it; per-resource checks still apply against that context.
 * Throws `WorkspaceTargetResolutionError` when the target can't be resolved.
 */
export async function resolveBackgroundTargetContext(
  destination: { projectId: string; worktreeId?: string },
  context: WorkspaceContext,
  /**
   * The destination's persisted owner, when the caller already read it with
   * {@link resolveBackgroundWorkspaceTarget}; skips a second config read.
   */
  workspaceTarget?: Pick<
    Awaited<ReturnType<typeof resolveBackgroundWorkspaceTarget>>,
    'workspaceOwner' | 'linkedPersonalCandidate' | 'ownershipTransferred'
  >,
): Promise<BackgroundTargetContext> {
  if (destination.projectId === APP_ADVISOR_PROJECT_ID)
    return {
      matches: true,
      target: { workspaceOwner: context, linkedOrganizationIds: [] },
      targetOwner: context,
      ownershipTransferred: false,
    };
  const { workspaceOwner, linkedPersonalCandidate, ownershipTransferred } =
    workspaceTarget ??
    (await resolveBackgroundWorkspaceTarget(
      destination.projectId,
      destination.worktreeId,
    ));
  const { resolveWorkspaceTarget } = await import('./workspace-target');
  const target = await resolveWorkspaceTarget(destination.projectId, {
    workspaceOwner,
    linkedPersonalCandidate,
    ...(context.kind === 'organization'
      ? { organizationId: context.organizationId }
      : {}),
  });
  const matches =
    (context.kind === 'personal' &&
      target.workspaceOwner.kind === 'personal') ||
    (context.kind === 'organization' &&
      ((target.workspaceOwner.kind === 'organization' &&
        target.workspaceOwner.organizationId === context.organizationId) ||
        (target.workspaceOwner.kind === 'personal' &&
          target.linkedOrganizationIds.includes(context.organizationId))));
  return {
    matches,
    target,
    targetOwner: target.workspaceOwner,
    ownershipTransferred,
  };
}

export async function authorizeBackgroundExecution(
  executionContext: string | undefined,
  resources: readonly PipelineContextResource[],
  destination?:
    | { scope: 'global' }
    | { projectId: string; worktreeId?: string },
  authorizations?: ChildPipelineAuthorization[],
): Promise<ResourceContextDecision> {
  if (!backgroundExecutionContextEnabled()) return { allow: true };
  try {
    if (!destination) return { allow: false, reason: 'unknown-provenance' };
    const context: WorkspaceContext | null =
      executionContext === undefined
        ? { kind: 'personal' }
        : parseWorkspaceContext(executionContext);
    if (!context) return { allow: false, reason: 'unsupported-target' };
    let target: ResourceContextInput['target'];
    if (!('scope' in destination)) {
      const { WorkspaceTargetResolutionError } =
        await import('./workspace-target');
      let resolved: BackgroundTargetContext;
      try {
        resolved = await resolveBackgroundTargetContext(destination, context);
      } catch (error) {
        if (error instanceof WorkspaceTargetResolutionError)
          return {
            allow: false,
            reason: error.reason,
            ...(error.transient ? { transient: true } : {}),
          };
        throw error;
      }
      if (!resolved.matches)
        return { allow: false, reason: 'context-mismatch' };
      target = resolved.target;
    }
    // Defer the heavy local policy/observability graph until a flagged dispatch.
    const { getResourceContextPolicyService } =
      await import('./resource-context-policy-service');
    const decide = async (
      resource: PipelineContextResource,
    ): Promise<ResourceContextDecision> => {
      let provenance = resource.provenance;
      if (resource.storedPipelineId) {
        const account = await readCanopyCloudAccountWithStatus();
        const accountId =
          account.status === 'ok' ? account.entry?.account?.id : undefined;
        if (!accountId && resource.requiresHostAuthorization)
          return account.status === 'ok'
            ? { allow: false, reason: 'unknown-provenance' }
            : { allow: false, reason: 'unknown-provenance', transient: true };
        if (accountId)
          provenance = await createResourceInstallReceiptsStore(accountId).find(
            'pipelines',
            resource.storedPipelineId,
          );
      }
      return getResourceContextPolicyService().decide({
        resource: {
          owner: resource.owner,
          ...(provenance ? { provenance } : {}),
          ...(resource.subject ? { subject: resource.subject } : {}),
        },
        target,
        invocation: {
          mode: 'background',
          context,
          executionContext,
        },
      });
    };
    let resolveCapabilities:
      | ReturnType<typeof createBackgroundCapabilityResolver>
      | undefined;
    return await authorizePipelineContextResources(
      resources.length ? resources : [{ owner: undefined }],
      async (resource) => {
        if (!resource.capabilities) return decide(resource);
        resolveCapabilities ??= (
          await import('./background-capability-context')
        ).createBackgroundCapabilityResolver(decide);
        return resolveCapabilities(resource.capabilities);
      },
      new Set(),
      authorizations,
    );
  } catch (error) {
    // Defer the cloud client to the failure path it classifies.
    const { isTransientCanopyCloudFailure } =
      await import('../canopy-cloud/client');
    return isTransientCanopyCloudFailure(error)
      ? { allow: false, reason: 'unknown-provenance', transient: true }
      : { allow: false, reason: 'unknown-provenance' };
  }
}

/** Persist host-captured bindings and ignore binding values supplied by callers. */
export async function bindEnabledHookContexts(
  next: HookOverrides | undefined,
  previous: HookOverrides | undefined,
): Promise<HookOverrides | undefined> {
  if (next === undefined) return next;
  return bindHookContextsWithCapturedContext(
    next,
    previous,
    await captureBackgroundExecutionContext(),
  );
}

/** Bind against a host context captured before entering canonical repository locks. */
export function bindHookContextsWithCapturedContext(
  next: HookOverrides | undefined,
  previous: HookOverrides | undefined,
  context: string | undefined,
): HookOverrides | undefined {
  if (next === undefined) return next;
  for (const [trigger, actions] of Object.entries(next)) {
    for (const action of actions ?? []) {
      if (action.type !== 'pipeline' && action.type !== 'chat') continue;
      const old = previous?.[trigger]?.find((candidate) => {
        if (candidate.type !== action.type) return false;
        return action.type === 'pipeline'
          ? candidate.type === 'pipeline' &&
              candidate.id === action.id &&
              candidate.source === action.source
          : candidate.type === 'chat' &&
              getChatHookActionOverlayKey(candidate) ===
                getChatHookActionOverlayKey(action);
      });
      delete action.executionContext;
      if (old?.type === action.type) {
        if (old.executionContext !== undefined)
          action.executionContext = old.executionContext;
      } else if (context !== undefined) action.executionContext = context;
    }
  }
  return next;
}

// Moved with the hook context rebind decision (W5c2).
export { rebindHookExecutionContexts } from '../lib/worktree-record-decision-apply';

/**
 * The workspace destination an automation action runs against, if any. A
 * pipeline with no project has none; its stored `workspaceId` is inert.
 */
export function automationActionDestination(
  action: AutomationAction,
): { projectId: string; worktreeId?: string } | null {
  switch (action.type) {
    case 'worktree_prompt':
    case 'worktree_session_prompt':
      return { projectId: action.workspaceId };
    case 'worktree_pipeline': {
      const target = resolveAutomationPipelineTarget(action);
      if (!target || target.kind === 'global') return null;
      return target.kind === 'task'
        ? { projectId: target.workspaceId, worktreeId: target.taskId }
        : { projectId: target.workspaceId };
    }
    case 'standalone_prompt':
      return { projectId: resolveCoworkWorkspaceId(action.chatProjectId) };
    case 'pipeline_execution_resume':
      return action.projectId
        ? {
            projectId: action.projectId,
            ...(action.worktreeId ? { worktreeId: action.worktreeId } : {}),
          }
        : null;
    case 'app_advisor_prompt':
      return null;
  }
}

/**
 * The workspace a background destination belongs to: Cowork sentinel ids
 * resolve through the migration map, and App Advisor has none.
 */
export function backgroundDestinationWorkspaceId(destination: {
  projectId: string;
  worktreeId?: string;
}): string | null {
  if (destination.projectId === APP_ADVISOR_PROJECT_ID) return null;
  if (destination.projectId === STANDALONE_CHAT_PROJECT_ID)
    return destination.worktreeId
      ? resolveCoworkWorkspaceId(destination.worktreeId)
      : null;
  return destination.projectId;
}

/**
 * The ownership change to apply when an automation's run is refused because
 * its target moved: only when the target records a transfer, the automation
 * is still bound to the owner it moved from, and the signed-in account may
 * run in the owner it moved to. Anything else stays a refusal.
 */
export async function resolveMovedTargetOwnershipChange(
  action: AutomationAction,
  executionContext: string | undefined,
): Promise<WorkspaceOwnershipChange | null> {
  const destination = automationActionDestination(action);
  const workspaceId = destination
    ? backgroundDestinationWorkspaceId(destination)
    : null;
  if (!workspaceId) return null;
  const { readWorkspaceConfigDetailed } =
    await import('../lib/workspace-persistence');
  const read = await readWorkspaceConfigDetailed(workspaceId);
  if (read.authority !== 'ok' || read.ownerMalformed) return null;
  const change = recordedOwnershipChange(workspaceId, read.config);
  if (
    !change ||
    (executionContext ?? 'personal') !== serializeWorkspaceContext(change.from)
  )
    return null;
  return (await accountMayRunIn(change.to)) ? change : null;
}

/** Personal, or an organization the signed-in account belongs to. */
export async function accountMayRunIn(
  context: WorkspaceContext,
): Promise<boolean> {
  if (context.kind === 'personal') return true;
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  return service
    .getState()
    .organizations.some(
      (organization) => organization.id === context.organizationId,
    );
}

/**
 * The context to bind an automation to when it is created on or turned on,
 * from any surface (CAN-3598): `selectedContext` when its target runs there,
 * otherwise the context that owns the target. App Advisor, a target that
 * can't be resolved, or one in an organization the account isn't in keeps
 * `selectedContext`, so the refusal and run-time checks still report it.
 * `destination` is where the automation runs, as the run-time check resolves it.
 */
export async function automationBindingContext(
  destination: { projectId: string; worktreeId?: string },
  selectedContext: string,
): Promise<string> {
  const context = parseWorkspaceContext(selectedContext);
  if (!context) return selectedContext;
  let resolved: BackgroundTargetContext;
  try {
    resolved = await resolveBackgroundTargetContext(destination, context);
  } catch {
    return selectedContext;
  }
  if (resolved.matches || !(await accountMayRunIn(resolved.targetOwner)))
    return selectedContext;
  return serializeWorkspaceContext(resolved.targetOwner);
}

/** The target and contexts behind a refusal; `boundContext` is the context it was (or would be) bound to. */
export type AutomationContextMismatch = BackgroundContextMismatchDetails;

/**
 * Names for an automation whose target sits outside `executionContext`, or
 * `null` when it matches, targets App Advisor, or can't be resolved. A target
 * that can't be resolved here is left to the run-time check.
 */
export async function describeAutomationContextMismatch(
  action: AutomationAction,
  executionContext: string | undefined,
): Promise<AutomationContextMismatch | null> {
  if (!backgroundExecutionContextEnabled() || executionContext === undefined)
    return null;
  const context = parseWorkspaceContext(executionContext);
  const destination = automationActionDestination(action);
  if (!context || !destination) return null;
  let resolved: BackgroundTargetContext;
  try {
    resolved = await resolveBackgroundTargetContext(destination, context);
  } catch {
    return null;
  }
  if (resolved.matches) return null;
  const workspaceId =
    destination.projectId === STANDALONE_CHAT_PROJECT_ID &&
    destination.worktreeId
      ? resolveCoworkWorkspaceId(destination.worktreeId)
      : destination.projectId;
  let targetName = 'This project';
  try {
    // Defer the sidebar persistence graph to the refusal path that needs a name.
    const { readWorkspaceIndexEntry } = await import('../lib/sidebar-items');
    const entry = await readWorkspaceIndexEntry(workspaceId);
    if (entry?.name.trim()) targetName = entry.name.trim();
  } catch {
    // Keep the generic name; the refusal itself doesn't depend on it.
  }
  const { organizations } = getWorkspaceContextService().getState();
  return {
    targetName,
    // "another organization" only reads right when both sides are organizations.
    targetContext: workspaceContextDisplayLabel(
      resolved.targetOwner,
      organizations,
      context.kind === 'personal' ? 'an organization' : 'another organization',
    ),
    boundContext: workspaceContextDisplayLabel(
      context,
      organizations,
      'your organization',
    ),
    ...(resolved.ownershipTransferred ? { projectMoved: true } : {}),
  };
}

/**
 * Refusal copy for turning on or running an automation in `executionContext`
 * (from {@link automationBindingContext}) when its target is elsewhere.
 */
export async function automationContextRefusal(
  action: AutomationAction,
  executionContext: string | undefined,
  verb: AutomationContextRefusalAction,
): Promise<string | null> {
  const mismatch = await describeAutomationContextMismatch(
    action,
    executionContext,
  );
  return mismatch
    ? automationContextRefusalMessage({
        targetName: mismatch.targetName,
        action: verb,
      })
    : null;
}

/**
 * Whether an automation belongs in the selected context's lists. App Advisor
 * shows everywhere; a target that can't be resolved stays visible rather than
 * disappearing from every list.
 */
export async function automationTargetInContext(
  action: AutomationAction,
  context: WorkspaceContext,
): Promise<boolean> {
  const destination = automationActionDestination(action);
  if (!destination) return true;
  try {
    return (await resolveBackgroundTargetContext(destination, context)).matches;
  } catch {
    return true;
  }
}

/**
 * Whether an automation belongs in `context`'s lists. A pipeline with no
 * project is filed under its saved owner (absent reads as Personal), never
 * by its inert `workspaceId` or the "show everywhere" App Advisor rule.
 */
export async function automationInContext(
  activity: Pick<ScheduledActivity, 'action' | 'executionContext'>,
  context: WorkspaceContext,
): Promise<boolean> {
  if (isGlobalPipelineAutomationAction(activity.action))
    return (
      (activity.executionContext ?? 'personal') ===
      serializeWorkspaceContext(context)
    );
  return automationTargetInContext(activity.action, context);
}

/**
 * Narrow an automations list to the selected context, matching the Automations
 * page. Unchanged while org projects are off.
 */
export async function scopeAutomationsToSelectedContext(
  list: AutomationsListResponse,
): Promise<AutomationsListResponse> {
  const serialized = await captureBackgroundExecutionContext();
  const context =
    serialized === undefined ? null : parseWorkspaceContext(serialized);
  if (!context) return list;
  // Resolve each destination once: many automations share a project.
  const verdicts = new Map<string, Promise<boolean>>();
  const keep = await Promise.all(
    list.activities.map((activity) => {
      const destination = automationActionDestination(activity.action);
      const key = isGlobalPipelineAutomationAction(activity.action)
        ? `owner:${activity.executionContext ?? 'personal'}`
        : destination
          ? `${destination.projectId}:${destination.worktreeId ?? ''}`
          : '';
      let verdict = verdicts.get(key);
      if (!verdict) {
        verdict = automationInContext(activity, context);
        verdicts.set(key, verdict);
      }
      return verdict;
    }),
  );
  const activities = list.activities.filter((_activity, index) => keep[index]);
  const ids = new Set(activities.map((activity) => activity.id));
  return {
    ...list,
    activities,
    recentRuns: list.recentRuns.filter((run) => ids.has(run.activityId)),
  };
}
