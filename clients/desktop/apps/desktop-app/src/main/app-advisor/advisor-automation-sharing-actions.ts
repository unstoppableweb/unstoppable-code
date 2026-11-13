import {
  SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION,
  SHARED_AUTOMATION_PIPELINE_TARGET_CAPABILITY,
} from '@canopy/protocol/automations';
import { resolveAutomationSharedAgent } from '@canopy/desktop-shared/lib/automation-agent';
import { getAgentModel } from '../agents/agent-model-store';
import {
  automationAgentPluginsMatch,
  automationAgentPackageMatches,
  getSharedAgent,
} from '../agents/canopy-server-client';
import type {
  ListSharedAutomationsResponse,
  SharedAutomationDetail,
} from '@canopy/protocol/automations';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import {
  AUTOMATION_SHARE_BLOCK_MESSAGES,
  AUTOMATION_SHARE_NOTICE_MESSAGES,
  buildSharedAutomationDocument,
  type BuildSharedAutomationDocumentOptions,
} from '@canopy/desktop-shared/lib/automation-sharing';
import {
  resolveAutomationPipelineScopes,
  resolveSessionTargetKind,
} from '@canopy/desktop-shared/lib/automation-share/automation-targets';
import {
  hashPipelineDocumentYaml,
  loadAutomationPipelineDocument,
  serializePipelineDocument,
} from '@canopy/desktop-shared/lib/automation-share/pipeline-document';
import type { PipelineReadPort } from '@canopy/desktop-shared/lib/automation-share/port';
import { extractPipelineReferenceTokens } from '@canopy/desktop-shared/lib/invocation-tokens';
import { sharedAutomationActivity } from '@canopy/desktop-shared/lib/stored-automation-activity';
import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  AutomationsListResponse,
  CreateSharedAutomationIpcRequest,
  DeleteSharedAutomationIpcRequest,
  ListSharedAutomationsIpcRequest,
  ScheduledActivity,
  UpdateSharedAutomationIpcRequest,
} from '@canopy/desktop-shared/types';
import { agentResourceActionFailure } from '../canopy-tools/resource-actions';
import { toAdvisorJson } from './advisor-json';
import {
  resolveOrganization,
  shareFailure,
  type AdvisorSharingActionHost,
} from './advisor-sharing-actions';

/**
 * CAN-6003 part B: App Advisor's automation sharing actions, in Electron main
 * on the owners the window's automation handlers use, with the window's
 * readiness checks kept (S8): packaged capabilities and local pipelines are
 * refused with the window's text, a re-share sends the server's current
 * hash, and the account's capability gates apply. A share targets the
 * organization by the part A rules.
 */
export const ADVISOR_AUTOMATION_SHARING_ACTION_TYPES = [
  'automation.share',
  'automation.list_shared',
  'automation.read_shared',
  'automation.unshare',
] as const;

export type AdvisorAutomationSharingAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_AUTOMATION_SHARING_ACTION_TYPES)[number] }
>;

export function isAdvisorAutomationSharingAction(
  action: AppAdvisorAction,
): action is AdvisorAutomationSharingAction {
  return ADVISOR_AUTOMATION_SHARING_ACTION_TYPES.some(
    (type) => type === action.type,
  );
}

/** The window's automation owners in Electron main; tests substitute them. */
export interface AdvisorAutomationSharingHost extends Pick<
  AdvisorSharingActionHost,
  'memberOrganizationIds' | 'selectedOrganizationId'
> {
  /** Every automation, as the window's list answers it. */
  list(): Promise<AutomationsListResponse>;
  getShared(automationId: string): Promise<SharedAutomationDetail>;
  listShared(
    request: ListSharedAutomationsIpcRequest,
  ): Promise<ListSharedAutomationsResponse>;
  createShared(
    request: CreateSharedAutomationIpcRequest,
  ): Promise<ShareOperationResult<SharedAutomationDetail>>;
  updateShared(
    request: UpdateSharedAutomationIpcRequest,
  ): Promise<ShareOperationResult<SharedAutomationDetail>>;
  deleteShared(request: DeleteSharedAutomationIpcRequest): Promise<void>;
  /** The signed-in account's server capabilities. */
  accountCapabilities(): Promise<readonly string[]>;
  /** Reads the workflow an automation runs. */
  pipelines: PipelineReadPort;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

function refused(
  message: string,
  code: 'not_found' | 'execution_failed' = 'execution_failed',
): Response {
  return {
    ok: false,
    error:
      code === 'not_found'
        ? { code, message }
        : { code, message, retryable: false },
  };
}

/**
 * Whether sharing may need to package local pipelines, which only the Share
 * dialog's dependency review can do. Deliberately cheap: stored
 * dependencies, a user or project pipeline action, or any pipeline-ID-shaped
 * token in the prompt, with no store lookup or analysis.
 */
function automationMayUsePipelines(activity: ScheduledActivity): boolean {
  if ((activity.dependencies?.pipelines.length ?? 0) > 0) return true;
  const { action } = activity;
  if (action.type === 'worktree_pipeline') {
    return (
      action.pipelineSource === 'user' || action.pipelineSource === 'project'
    );
  }
  return (
    'prompt' in action &&
    extractPipelineReferenceTokens(action.prompt, []).length > 0
  );
}

async function share(
  action: Extract<AdvisorAutomationSharingAction, { type: 'automation.share' }>,
  host: AdvisorAutomationSharingHost,
): Promise<Response> {
  const organization = await resolveOrganization(action, host);
  if ('response' in organization) return organization.response;
  const { organizationId } = organization;
  const listed = (await host.list()).activities.find(
    (entry) => entry.id === action.id,
  );
  // Use the same validated chat/pipeline projection as the share dialog.
  const activity = listed ? sharedAutomationActivity(listed) : undefined;
  if (!activity)
    return refused(
      `Triggered activity ${action.id} was not found.`,
      'not_found',
    );
  if (activity.installedFrom?.capabilityPackage)
    return refused(
      'This automation includes packaged capabilities. Open Workflows → Automations and use Share so its dependencies can be verified and included.',
    );
  if (automationMayUsePipelines(activity))
    return refused(
      'This automation may run local pipelines. Open Workflows → Automations and use Share so its pipelines can be included.',
    );
  // Ownership must never be silently downgraded: a target id without a scope
  // infers the matching scope, and contradictory combinations fail loudly.
  if (action.teamId && organizationId)
    return refused('Provide either teamId or organizationId, not both.');
  const inferredScope =
    action.shareScope ??
    (action.teamId
      ? ('team' as const)
      : organizationId
        ? ('organization' as const)
        : undefined);
  if (
    (inferredScope === 'team' && !action.teamId) ||
    (inferredScope === 'organization' && !organizationId) ||
    (inferredScope === 'team' && organizationId !== undefined) ||
    (inferredScope === 'organization' && action.teamId !== undefined)
  )
    return refused(
      'shareScope and the provided target id do not match. Use shareScope team with teamId or organization with organizationId.',
    );
  if (!activity.remote && inferredScope === undefined)
    return refused(
      'A first automation share requires shareScope team with teamId or organization with organizationId.',
    );
  // A re-share carries the server's current contentHash and keeps the
  // existing description when the action supplies none.
  let description = action.description ?? '';
  let expectedContentHash = activity.remote?.contentHash;
  let declaredTargetContexts = activity.targetRequirement?.contexts;
  if (activity.remote) {
    const existing = await host.getShared(activity.remote.remoteId);
    // A legacy private-only share (no public link) is hidden from everyone
    // else, so it is treated like a first share.
    if (
      inferredScope === undefined &&
      existing.shareScope === 'private' &&
      !existing.publicShare
    )
      return refused(
        'This automation is not shared with anyone yet. Provide shareScope team with teamId or organization with organizationId.',
      );
    expectedContentHash = existing.contentHash;
    if (!activity.targetRequirementCleared)
      declaredTargetContexts ??=
        existing.automation.targetRequirement?.contexts;
    if (action.description === undefined)
      description = existing.automation.description;
  }
  // No plugin resolution and no capability packaging here, as in the window's
  // App Advisor path: the builder strips local selections and says so.
  const buildOptions: BuildSharedAutomationDocumentOptions = {
    description,
    resolvedAgent: await resolveAutomationSharedAgent(
      'model' in activity.action ? activity.action.model : undefined,
      {
        get: getAgentModel,
        getShared: getSharedAgent,
        pluginsMatch: automationAgentPluginsMatch,
        packageMatches: automationAgentPackageMatches,
      },
    ),
    ...(declaredTargetContexts ? { declaredTargetContexts } : {}),
  };
  if (activity.action.type === 'worktree_session_prompt') {
    const sessionTargetKind = await resolveSessionTargetKind(
      host.pipelines,
      activity.action,
    );
    if (sessionTargetKind) buildOptions.sessionTargetKind = sessionTargetKind;
  }
  if (activity.action.type === 'worktree_pipeline') {
    const pipelineAction = activity.action;
    if (pipelineAction.sharedPipeline?.installPin)
      buildOptions.sharedPipelineInstallPin =
        pipelineAction.sharedPipeline.installPin;
    try {
      if (
        pipelineAction.pipelineSource === 'shared' &&
        pipelineAction.sharedPipeline?.remoteId
      ) {
        const resolved =
          await host.pipelines.api.automations.resolveSharedPipelineInstallPin({
            remoteId: pipelineAction.sharedPipeline.remoteId,
          });
        buildOptions.sharedPipelineInstallPin = resolved.installPin;
        const contentHash = await hashPipelineDocumentYaml(
          resolved.rawPipeline,
        );
        if (contentHash !== null) {
          buildOptions.pipelineRawContent = resolved.rawPipeline;
          buildOptions.pipelineContentHash = contentHash;
        }
      } else if (
        pipelineAction.pipelineSource === 'user' ||
        pipelineAction.pipelineSource === 'project'
      ) {
        const loaded = await loadAutomationPipelineDocument(
          host.pipelines,
          pipelineAction,
        );
        if (loaded.data) {
          const rawPipeline = serializePipelineDocument(loaded.data.content);
          const contentHash = await hashPipelineDocumentYaml(rawPipeline);
          if (contentHash !== null) {
            buildOptions.pipelineRawContent = rawPipeline;
            buildOptions.pipelineContentHash = contentHash;
          }
        }
      }
    } catch {
      // Reading the pipeline is best effort: the builder falls back to the
      // shared or unresolved reference when the source can't be read.
    }
    if (buildOptions.pipelineRawContent === undefined)
      buildOptions.pipelineResolution = await resolveAutomationPipelineScopes(
        host.pipelines,
        pipelineAction,
      );
  }
  const built = buildSharedAutomationDocument(activity, buildOptions);
  if (!built.ok)
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: [
          ...built.reasons.map(
            (reason) => AUTOMATION_SHARE_BLOCK_MESSAGES[reason],
          ),
          ...(built.detail ? [built.detail] : []),
        ].join(' '),
      },
    };
  if (
    built.document.version === SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION &&
    !(await host.accountCapabilities()).includes(
      SHARED_AUTOMATION_PIPELINE_TARGET_CAPABILITY,
    )
  )
    return refused(
      'Update the sharing server to share this workflow destination.',
    );
  if (
    built.document.version === 3 &&
    !(await host.accountCapabilities()).includes(
      'automations-target-requirements-v3',
    )
  )
    return refused(
      'The sharing server must be updated before publishing narrowed automation requirements.',
    );
  // An existing share with no explicit ownership keeps its current owner.
  const ownerFields =
    activity.remote && inferredScope === undefined
      ? {}
      : {
          shareScope: inferredScope,
          ...(action.teamId ? { teamId: action.teamId } : {}),
          ...(organizationId ? { organizationId } : {}),
        };
  const published = activity.remote
    ? await host.updateShared({
        activityId: activity.id,
        automationId: activity.remote.remoteId,
        automation: built.document,
        ...(expectedContentHash ? { expectedContentHash } : {}),
        ...ownerFields,
      })
    : await host.createShared({
        activityId: activity.id,
        automation: built.document,
        ...ownerFields,
      });
  if (!published.ok) return shareFailure(published);
  return {
    ok: true,
    result: {
      id: published.value.id,
      contentHash: published.value.contentHash,
      shareScope: published.value.shareScope,
      notices: built.notices.map(
        (notice) => AUTOMATION_SHARE_NOTICE_MESSAGES[notice],
      ),
    },
  };
}

async function run(
  action: AdvisorAutomationSharingAction,
  host: AdvisorAutomationSharingHost,
): Promise<Response> {
  switch (action.type) {
    case 'automation.share':
      return share(action, host);
    case 'automation.list_shared': {
      const response = await host.listShared({
        ...(action.query ? { query: action.query } : {}),
        ...(action.limit ? { limit: action.limit } : {}),
        ...(action.cursor ? { cursor: action.cursor } : {}),
        ...(action.createdBy ? { createdBy: action.createdBy } : {}),
      });
      return {
        ok: true,
        result: {
          automations: toAdvisorJson(response.automations),
          ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
        },
      };
    }
    case 'automation.read_shared':
      return {
        ok: true,
        result: toAdvisorJson(await host.getShared(action.automationId)),
      };
    case 'automation.unshare':
      await host.deleteShared({ automationId: action.automationId });
      return { ok: true, result: { automationId: action.automationId } };
  }
}

export async function dispatchAdvisorAutomationSharingAction(
  action: AdvisorAutomationSharingAction,
  host: AdvisorAutomationSharingHost,
): Promise<Response> {
  try {
    return await run(action, host);
  } catch (error) {
    return agentResourceActionFailure(error);
  }
}
