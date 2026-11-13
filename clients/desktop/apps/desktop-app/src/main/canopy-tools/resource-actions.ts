import { portablePipelineTriggerTypes } from '@canopy/protocol/pipelines';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type { AgentArtifactChangedField } from '@canopy/protocol/agent-artifacts';
import { updateSharedPipelinePreservingPackage } from '../pipelines/pipeline-package-service';
import { skillResourceContextEnabled } from '../skills/resource-lanes';
import {
  assertStoredSkillContext,
  assertSkillShareOrigin,
  filterStoredSkillContexts,
} from '../skills/skill-install-context';
import {
  assertPipelineContext,
  pipelineResourceContextEnabled,
} from '../pipelines/resource-lanes';
import {
  authorizeProjectPipelineRequest,
  readStoredPipelineContext,
} from '../pipelines/pipeline-install-context';
import { readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { BrowserWindow } from 'electron';
import {
  CANOPY_CLOUD_DISPLAY_NAME,
  CANOPY_CLOUD_SERVER_ID,
} from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  buildAutomationArtifactReceipt,
  buildAutomationRunArtifactReceipt,
  buildPipelineRunArtifactReceipt,
  buildCapabilityReferenceArtifactReceipt,
  automationChangedFields,
  buildPipelineArtifactReceipt,
  buildSkillArtifactReceipt,
  createAgentArtifactDedupeKey,
  normalizeAgentResourceError,
  withAgentArtifacts as withTransportAgentArtifacts,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import {
  AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR,
  validateAgentAutomationCreatePolicy,
  validateAgentAutomationRunPolicy,
  validateAgentAutomationUpdatePolicy,
} from '@canopy/desktop-shared/lib/agent-automation-policy';
import {
  isGlobalPipelineAutomationAction,
  pipelineAutomationTargetSummary,
} from '@canopy/desktop-shared/lib/automation-pipeline-target';
import { validateAgentPipelineMutationPolicy } from '@canopy/desktop-shared/lib/agent-pipeline-policy';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { getTriggerTypes } from '@canopy/execution-engine/types/pipeline';
import type {
  AppAdvisorActionError,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  AutomationsListResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type {
  Pipeline,
  PipelineAgentAuthor,
  PipelineData,
  IPCResult,
  PipelineInfo,
  SharedPipelineDetail,
} from '@canopy/execution-engine/types/pipeline';
import type { DispatchActionArgs } from './definitions';
import { getSharedPipelineSaveImpact } from '../pipelines/shared-pipeline-save-impact';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
} from '../canopy-cloud/client';
import { isPathInside } from '../lib/path-safety';
import { projectOwnedChatAutomation } from '../automations/owned-chat-projection';
import { ownsOrchestratorPromptPipeline } from '../automations/owned-pipeline';
import { targetsAgentHiddenPipeline } from '../automations/workflow-schedules';
import { scopeAutomationsToSelectedContext } from '../services/background-execution-context';
import {
  ADVISOR_ACCESS_DISABLED,
  ADVISOR_ACCESS_DISABLED_MESSAGE,
  decideAppAdvisorAccessForCaller,
  type AppAdvisorAccessDecision,
} from '../lib/app-advisor-project-agent-access';
import {
  decideSameOwnerAccess,
  resolveAutomationTargetProject,
  resolveProjectSavedOwner,
  type ProjectOwnerTarget,
  type ResolvedProjectOwner,
  type SameOwnerDecision,
} from '../lib/project-owner';
import { isClaudeTuiChatsEnabled } from '../lib/claude-tui-chats';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import {
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { readPreferencesFile } from '../lib/preferences-store';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import * as pipelineStore from '../pipelines/pipeline-service';
import {
  deleteUserPipeline,
  duplicatePipelineDefinition,
  isPipelineDefinitionNotFound,
  PIPELINE_DEFINITION_AGENT_CALLER,
  pipelineSourceFailure,
  readDesktopPipelineSnapshot,
  saveUserPipeline,
  setPipelineDefinitionEnabled,
} from '../canopy-runtime/pipeline-definition-dispatch';
import {
  createSharedPipeline,
  deleteSharedPipeline,
  getSharedPipeline,
  getSharedPipelineForExecutionContext,
} from '../pipelines/canopy-server-client';
import {
  discoverProjectPipelines,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import {
  withPipelineCrudTelemetry,
  type PipelineCrudTelemetryContext,
} from '../pipelines/instrumentation';
import {
  recordUserPipelineOwner,
  setUserPipelineAgentAuthor,
} from '../pipelines/pipeline-local-metadata-store';
import {
  agentPipelineOwnerContext,
  getUserPipelineOwner,
  validatePipelineOwnerTargetsOnSave,
} from '../pipelines/pipeline-owner-policy';
import * as skillService from '../skills/skill-service';
import { notifyRenderersSkillsChanged } from '../skills/skill-change-events';
import {
  createSharedSkill,
  deleteSharedSkill,
  getSharedSkill,
  listSharedSkills,
  updateSharedSkill,
} from '../skills/canopy-server-client';
import { CUSTOM_SOURCE_ID, isCustomSourceId } from '../skills/paths';

const RESOURCE_ACTION_TYPE_LIST = [
  'skills.list',
  'skills.read',
  'skills.read_file',
  'skills.create_custom',
  'skills.update_custom',
  'skills.delete_custom',
  'skills.list_shared',
  'skills.read_shared',
  'skills.share_custom',
  'skills.import_shared',
  'skills.update_shared',
  'skills.delete_shared',
  'pipeline.create',
  'pipeline.update',
  'pipeline.delete',
  'pipeline.duplicate',
  'pipeline.share',
  'pipeline.update_shared',
  'pipeline.delete_shared',
  'pipeline.set_enabled',
  'automation.list',
  'automation.get',
  'automation.create',
  'automation.update',
  'automation.disable',
  'automation.delete',
  'automation.run_now',
] as const;

type AgentResourceActionType = (typeof RESOURCE_ACTION_TYPE_LIST)[number];

const RESOURCE_ACTION_TYPES: ReadonlySet<string> = new Set(
  RESOURCE_ACTION_TYPE_LIST,
);

export type AgentResourceAction = Extract<
  DispatchActionArgs['action'],
  { type: AgentResourceActionType }
>;

export interface AgentResourceActionRuntime {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
  repoId?: string;
  executionScope?: 'worktree' | 'directory';
  getWindow: () => BrowserWindow | null;
  /** Scope for stored definitions; defaults to this runtime's project. */
  definitionScope?: { workspaceId?: string };
  /** The chat to record as a write's agent author, when it lives outside this scope. */
  authorChat?: { projectId: string; worktreeId: string; chatId: string };
}

export function isAgentResourceActionType(type: string): boolean {
  return RESOURCE_ACTION_TYPES.has(type);
}

export function isAgentResourceAction(action: {
  type: string;
}): action is AgentResourceAction {
  return RESOURCE_ACTION_TYPES.has(action.type);
}

/**
 * Mark a user pipeline as written by this agent chat, recording the owner of
 * a pipeline it just created.
 */
function recordAgentPipelineWrite(
  pipelineId: string,
  runtime: AgentResourceActionRuntime,
  createdOwner?: string,
): void {
  if (createdOwner !== undefined)
    recordUserPipelineOwner(pipelineId, createdOwner);
  setUserPipelineAgentAuthor(pipelineId, agentAuthorForRuntime(runtime));
}

function definitionScope(runtime: AgentResourceActionRuntime): {
  workspaceId?: string;
} {
  return runtime.definitionScope ?? { workspaceId: runtime.projectId };
}

function agentAuthorForRuntime(
  runtime: AgentResourceActionRuntime,
): PipelineAgentAuthor {
  return {
    chat: runtime.authorChat ?? {
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      chatId: runtime.chatId,
    },
    recordedAt: new Date().toISOString(),
  };
}

/** Saves a copy of a project file this runtime found, through core. */
async function saveAgentProjectCopy(
  info: PipelineInfo,
  runtime: AgentResourceActionRuntime,
  input: { name: string; description: string; icon: string; content: Pipeline },
): Promise<IPCResult<PipelineInfo>> {
  if (pipelineResourceContextEnabled()) {
    if (!info.filePath)
      return {
        success: false,
        error: 'Workflow unavailable (unknown-provenance)',
      };
    const { owner, projectId } = await authorizeProjectPipelineRequest({
      id: info.id,
      cwd: runtime.cwd,
      filePath: info.filePath,
    });
    if (projectId !== runtime.projectId || owner.type === 'organization')
      return {
        success: false,
        error: 'Workflow unavailable (context-mismatch)',
      };
  }
  return saveUserPipeline(input, PIPELINE_DEFINITION_AGENT_CALLER);
}

function json(value: unknown): AppAdvisorJson {
  const cloned: unknown = JSON.parse(JSON.stringify(value));
  return isAppAdvisorJson(cloned) ? cloned : null;
}

function isJsonObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAppAdvisorJson(value: unknown): value is AppAdvisorJson {
  if (value === null) return true;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isAppAdvisorJson);
  return isJsonObject(value) && Object.values(value).every(isAppAdvisorJson);
}

function ok(result?: unknown): AppAdvisorActionResponse {
  return {
    requestId: '',
    ok: true,
    ...(result === undefined ? {} : { result: json(result) }),
  };
}

function withAgentArtifacts(
  response: AppAdvisorActionResponse,
  receipts: readonly unknown[],
): AppAdvisorActionResponse {
  if (!response.ok || !isJsonObject(response.result)) return response;
  const attached = withTransportAgentArtifacts(
    { ...response, ok: true as const, result: response.result },
    receipts,
  );
  return { ...attached, result: json(attached.result) };
}

export async function withAgentPipelineTelemetry(
  context: PipelineCrudTelemetryContext,
  operation: () => AppAdvisorActionResponse | Promise<AppAdvisorActionResponse>,
): Promise<AppAdvisorActionResponse> {
  const instrumented = await withPipelineCrudTelemetry(context, async () => {
    const response = await operation();
    return response.ok
      ? { success: true as const, data: response }
      : {
          success: false as const,
          error: response.error?.message ?? 'Pipeline action failed.',
          data: response,
        };
  });
  return instrumented.data;
}

function failure(
  code: AppAdvisorActionError['code'],
  message: string,
  retryable = false,
): AppAdvisorActionResponse {
  const normalized = normalizeAgentResourceError(
    { code, message, retryable },
    code === 'not_found' ? 'not_found' : 'validation_failed',
  );
  return { requestId: '', ok: false, error: normalized };
}

const ORGANIZATION_SHARE_CONTEXT_MESSAGE =
  'Choose an organization from the context switcher above the account in the sidebar, or pass organizationId, to share with an organization.';

type ShareOrganizationResolution =
  | { ok: true; organizationId: string | undefined }
  | { ok: false; response: AppAdvisorActionResponse };

async function selectedWorkspaceContext(): Promise<WorkspaceContext> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  return service.getState().context;
}

async function resolveActionShareOrganization(action: {
  shareScope?: 'private' | 'team' | 'organization';
  organizationId?: string;
}): Promise<ShareOrganizationResolution> {
  if (action.shareScope !== 'organization' || action.organizationId) {
    return { ok: true, organizationId: action.organizationId };
  }
  // Mirror the renderer's scoping rule (`getSidebarScopingContext`): with the
  // org-projects flag off there is no selected context to default from.
  // `pipelineResourceContextEnabled` reads that same flag.
  const context = pipelineResourceContextEnabled()
    ? await selectedWorkspaceContext()
    : undefined;
  if (context?.kind === 'organization') {
    return { ok: true, organizationId: context.organizationId };
  }
  return {
    ok: false,
    response: {
      requestId: '',
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: ORGANIZATION_SHARE_CONTEXT_MESSAGE,
        retryable: false,
      },
    },
  };
}

function ipcFailure(message: string): AppAdvisorActionResponse {
  const lower = message.toLowerCase();
  if (lower.includes('not found') || lower.includes('does not exist')) {
    return failure('not_found', message);
  }
  if (
    lower.includes('built-in') ||
    lower.includes('bundled') ||
    lower.includes('read-only') ||
    lower.includes('readonly')
  ) {
    return failure('read_only_source', message);
  }
  return failure('validation_failed', message);
}

export function agentResourceActionFailure(
  cause: unknown,
): AppAdvisorActionResponse {
  if (cause instanceof CanopyCloudClientError) {
    if (cause.code === 'unsupported-capability') {
      return failure('missing_capability', cause.message);
    }
    if (
      cause.code === 'cloud-not-configured' ||
      cause.code === 'missing-api-key'
    ) {
      return failure('authentication_failed', cause.message);
    }
    if (cause.status === 401)
      return failure('authentication_failed', cause.message);
    if (cause.status === 403)
      return failure('authorization_conflict', cause.message);
    if (cause.status === 404) return failure('not_found', cause.message);
    if (cause.status === 409 || cause.status === 412) {
      return failure(
        cause.message.toLowerCase().includes('hash')
          ? 'stale_content_hash'
          : 'authorization_conflict',
        cause.message,
      );
    }
    if (cause.code === 'network-error') {
      return failure('validation_failed', cause.message, true);
    }
  }
  return ipcFailure(cause instanceof Error ? cause.message : String(cause));
}

function clampLimit(
  value: number | undefined,
  fallback = 20,
  maximum = 100,
): number {
  return Math.max(1, Math.min(maximum, Math.floor(value ?? fallback)));
}

function matches(query: string | undefined, ...values: string[]): boolean {
  const tokens = (query ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const haystack = values.join(' ').toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

async function assertSkillsCapability(): Promise<void> {
  await assertCanopyCloudCapability('skills-crud-v1');
}

async function assertPipelinesCapability(): Promise<void> {
  await assertCanopyCloudCapability('pipelines-crud-v1');
}

export function skillReceipt(args: {
  operation: string;
  sourceId?: string;
  installedName?: string;
  sharedSkillId?: string;
  name: string;
  description?: string;
  shareScope?: 'private' | 'team' | 'organization';
  owner?: {
    type: 'user' | 'team' | 'organization';
    id: string;
    name: string | null;
  };
  canUpdate: boolean;
  oldInstalledName?: string;
}): ReturnType<typeof buildSkillArtifactReceipt> {
  if (args.sourceId && args.installedName) {
    return buildSkillArtifactReceipt({
      operation: args.operation,
      source: 'installed',
      sourceId: args.sourceId,
      installedName: args.installedName,
      ...(args.sharedSkillId ? { sharedSkillId: args.sharedSkillId } : {}),
      name: args.name,
      ...(args.description ? { description: args.description } : {}),
      ...(args.shareScope ? { shareScope: args.shareScope } : {}),
      canUpdate: args.canUpdate,
      ...(args.oldInstalledName && args.oldInstalledName !== args.installedName
        ? {
            aliases: [
              createAgentArtifactDedupeKey(
                'skill',
                'installed',
                args.sourceId,
                args.oldInstalledName,
              ),
            ],
          }
        : {}),
      navigationTarget: {
        kind: 'installed_skill',
        sourceId: args.sourceId,
        skillName: args.installedName,
      },
    });
  }
  if (!args.sharedSkillId) {
    throw new Error('A shared skill receipt requires a shared skill id.');
  }
  return buildSkillArtifactReceipt({
    operation: args.operation,
    source: 'shared',
    sharedSkillId: args.sharedSkillId,
    name: args.name,
    ...(args.description ? { description: args.description } : {}),
    ...(args.shareScope ? { shareScope: args.shareScope } : {}),
    ...(args.owner
      ? {
          owner: {
            type: args.owner.type,
            id: args.owner.id,
            ...(args.owner.name ? { name: args.owner.name } : {}),
          },
        }
      : {}),
    canUpdate: args.canUpdate,
    navigationTarget: { kind: 'shared_skill', skillId: args.sharedSkillId },
  });
}

async function skillAction(
  action: AgentResourceAction,
): Promise<AppAdvisorActionResponse | null> {
  switch (action.type) {
    case 'skills.list': {
      const result = skillService.loadSkills();
      if (result.success && result.data)
        result.data = await filterStoredSkillContexts(result.data);
      if (!result.success || !result.data)
        return ipcFailure(result.error ?? 'Failed to list skills.');
      const skills = result.data
        .filter((skill) => !action.customOnly || skill.custom === true)
        .filter((skill) =>
          matches(action.query, skill.name, skill.description, skill.sourceId),
        )
        .slice(0, clampLimit(action.limit, 20, 200));
      return ok({ skills, returned: skills.length });
    }
    case 'skills.read': {
      await assertStoredSkillContext(`${action.sourceId}/${action.skillName}`);
      const result = skillService.readSkillContent(
        action.sourceId,
        action.skillName,
      );
      return result.success
        ? withAgentArtifacts(
            ok({
              sourceId: action.sourceId,
              skillName: action.skillName,
              content: result.data,
            }),
            [
              buildCapabilityReferenceArtifactReceipt({
                operation: action.type,
                itemKind: 'skill',
                source: 'installed',
                sourceId: `${action.sourceId}/${action.skillName}`,
                name: action.skillName,
                sourceLabel: 'Installed',
                state: 'installed',
                relation: 'found',
                navigationTarget: {
                  kind: 'installed_skill',
                  sourceId: action.sourceId,
                  skillName: action.skillName,
                },
              }),
            ],
          )
        : ipcFailure(result.error ?? 'Failed to read skill.');
    }
    case 'skills.read_file': {
      const result = await skillService.readSkillFile(
        action.sourceId,
        action.skillName,
        action.filePath,
      );
      return result.success
        ? ok({
            sourceId: action.sourceId,
            skillName: action.skillName,
            filePath: action.filePath,
            file: result.data,
          })
        : ipcFailure(result.error ?? 'Failed to read skill file.');
    }
    case 'skills.create_custom': {
      const result = await skillService.saveCustomSkill(action);
      if (!result.success || !result.data)
        return ipcFailure(result.error ?? 'Failed to create skill.');
      refreshInvocableInventoryAfterMutation('agent:skills:create-custom');
      notifyRenderersSkillsChanged();
      return withAgentArtifacts(ok({ skill: result.data }), [
        skillReceipt({
          operation: action.type,
          sourceId: CUSTOM_SOURCE_ID,
          installedName: result.data.name,
          name: result.data.name,
          description: action.description,
          canUpdate: true,
        }),
      ]);
    }
    case 'skills.update_custom': {
      await assertStoredSkillContext(
        `${CUSTOM_SOURCE_ID}/${action.originalName}`,
      );
      const current = skillService.readSkillContent(
        CUSTOM_SOURCE_ID,
        action.originalName,
      );
      if (!current.success || !current.data)
        return ipcFailure(current.error ?? 'Custom skill not found.');
      const frontmatter = current.data.frontmatter;
      const nextName = action.name ?? action.originalName;
      const payload = {
        originalName: action.originalName,
        name: nextName,
        description:
          action.description ??
          (typeof frontmatter.description === 'string'
            ? frontmatter.description
            : ''),
        body: action.body ?? current.data.body,
        ...(action.extraMetadata
          ? { extraMetadata: action.extraMetadata }
          : {}),
      };
      const result = action.extraMetadata
        ? await skillService.saveCustomSkill(payload)
        : await skillService.saveCustomSkill(payload, {
            preservedMetadata: frontmatter,
          });
      if (!result.success || !result.data)
        return ipcFailure(result.error ?? 'Failed to update skill.');
      refreshInvocableInventoryAfterMutation('agent:skills:update-custom');
      notifyRenderersSkillsChanged();
      return withAgentArtifacts(
        ok({ skill: result.data, originalName: action.originalName }),
        [
          skillReceipt({
            operation: action.type,
            sourceId: CUSTOM_SOURCE_ID,
            installedName: result.data.name,
            oldInstalledName: action.originalName,
            name: result.data.name,
            description:
              action.description ??
              (typeof frontmatter.description === 'string'
                ? frontmatter.description
                : undefined),
            canUpdate: true,
          }),
        ],
      );
    }
    case 'skills.delete_custom': {
      await assertStoredSkillContext(`${CUSTOM_SOURCE_ID}/${action.name}`);
      const result = await skillService.removeSkillForContext(
        CUSTOM_SOURCE_ID,
        action.name,
      );
      if (!result.success)
        return ipcFailure(result.error ?? 'Failed to delete skill.');
      refreshInvocableInventoryAfterMutation('agent:skills:delete-custom');
      notifyRenderersSkillsChanged();
      return ok({ name: action.name, deleted: true });
    }
    case 'skills.list_shared': {
      await assertSkillsCapability();
      return ok(
        await listSharedSkills({
          query: action.query,
          limit: clampLimit(action.limit),
          cursor: action.cursor,
          createdBy: action.createdBy,
        }),
      );
    }
    case 'skills.read_shared': {
      await assertSkillsCapability();
      const skill = await getSharedSkill(action.skillId);
      return withAgentArtifacts(ok({ skill }), [
        buildCapabilityReferenceArtifactReceipt({
          operation: action.type,
          itemKind: 'skill',
          source: 'shared',
          sourceId: skill.id,
          name: skill.name,
          description: skill.description,
          sourceLabel: 'Shared',
          state: 'available',
          relation: 'found',
          navigationTarget: { kind: 'shared_skill', skillId: skill.id },
        }),
      ]);
    }
    case 'skills.share_custom': {
      const shareOrganization = await resolveActionShareOrganization(action);
      if (!shareOrganization.ok) return shareOrganization.response;
      await assertSkillsCapability();
      const local = skillService.loadSkills();
      if (local.success && local.data)
        local.data = await filterStoredSkillContexts(local.data);
      const info = local.success
        ? local.data?.find(
            (skill) =>
              isCustomSourceId(skill.sourceId) && skill.name === action.name,
          )
        : undefined;
      if (!info)
        return failure(
          'not_found',
          `Custom skill ${action.name} was not found.`,
        );
      const shared = await createSharedSkill({
        ...(skillResourceContextEnabled()
          ? { sourceSkillId: `${CUSTOM_SOURCE_ID}/${action.name}` }
          : {}),
        rawSkill: await skillService.readRawSkill(action.name),
        shareScope: action.shareScope,
        teamId: action.teamId,
        organizationId: shareOrganization.organizationId,
      });
      return withAgentArtifacts(ok({ skill: shared }), [
        skillReceipt({
          operation: action.type,
          sharedSkillId: shared.id,
          name: shared.name,
          description: shared.description,
          shareScope: shared.shareScope,
          owner: shared.owner.type === 'system' ? undefined : shared.owner,
          canUpdate: shared.canUpdate,
        }),
      ]);
    }
    case 'skills.import_shared': {
      await assertSkillsCapability();
      const shared = await getSharedSkill(action.skillId);
      const installed = await skillService.writeRawSkillForContext({
        sourceRemoteId: shared.id,
        skillName: shared.name,
        rawSkill: shared.rawSkill,
      });
      refreshInvocableInventoryAfterMutation('agent:skills:import-shared');
      notifyRenderersSkillsChanged();
      return withAgentArtifacts(
        ok({ skill: installed, sharedSkillId: shared.id }),
        [
          skillReceipt({
            operation: action.type,
            sourceId: CUSTOM_SOURCE_ID,
            installedName: installed.skillName,
            sharedSkillId: shared.id,
            name: installed.skillName,
            description: shared.description,
            shareScope: shared.shareScope,
            canUpdate: true,
          }),
        ],
      );
    }
    case 'skills.update_shared': {
      await assertSkillsCapability();
      const current = await getSharedSkill(action.skillId);
      if (!current.canUpdate)
        return failure(
          'authorization_conflict',
          'You do not have permission to update this shared skill.',
        );
      const local = skillService.loadSkills();
      if (local.success && local.data)
        local.data = await filterStoredSkillContexts(local.data);
      const info = local.success
        ? local.data?.find(
            (skill) =>
              isCustomSourceId(skill.sourceId) && skill.name === action.name,
          )
        : undefined;
      if (!info)
        return failure(
          'not_found',
          `Custom skill ${action.name} was not found.`,
        );
      await assertSkillShareOrigin(
        `${CUSTOM_SOURCE_ID}/${action.name}`,
        current.owner,
      );
      const shared = await updateSharedSkill({
        ...(skillResourceContextEnabled()
          ? { sourceSkillId: `${CUSTOM_SOURCE_ID}/${action.name}` }
          : {}),
        skillId: action.skillId,
        rawSkill: await skillService.readRawSkill(action.name),
        expectedContentHash: current.contentHash,
      });
      return withAgentArtifacts(ok({ skill: shared }), [
        skillReceipt({
          operation: action.type,
          sharedSkillId: shared.id,
          name: shared.name,
          description: shared.description,
          shareScope: shared.shareScope,
          owner: shared.owner.type === 'system' ? undefined : shared.owner,
          canUpdate: shared.canUpdate,
        }),
      ]);
    }
    case 'skills.delete_shared': {
      await assertSkillsCapability();
      const current = await getSharedSkill(action.skillId);
      if (!current.canDelete)
        return failure(
          'authorization_conflict',
          'You do not have permission to delete this shared skill.',
        );
      await deleteSharedSkill({ skillId: action.skillId });
      return ok({ skillId: action.skillId, deleted: true });
    }
    default:
      return null;
  }
}

function sharedPipelineRemoteId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const prefix = `shared:${CANOPY_CLOUD_SERVER_ID}:`;
  if (!id.startsWith(prefix)) return undefined;
  const remoteId = id.slice(prefix.length);
  return remoteId || undefined;
}

function resolveSharedPipelineMutationTarget(action: {
  pipelineId?: string;
  remoteId?: string;
}): { remoteId: string } | { response: AppAdvisorActionResponse } {
  const pipelineRemoteId = sharedPipelineRemoteId(action.pipelineId);
  if (action.pipelineId !== undefined && !pipelineRemoteId) {
    return {
      response: failure(
        'validation_failed',
        'Provide remoteId or a shared pipelineId for this server.',
      ),
    };
  }
  if (
    action.remoteId !== undefined &&
    pipelineRemoteId !== undefined &&
    action.remoteId !== pipelineRemoteId
  ) {
    return {
      response: failure(
        'validation_failed',
        'remoteId and pipelineId must identify the same shared pipeline.',
      ),
    };
  }
  const remoteId = action.remoteId ?? pipelineRemoteId;
  return remoteId
    ? { remoteId }
    : {
        response: failure(
          'validation_failed',
          'Provide remoteId or a shared pipelineId for this server.',
        ),
      };
}

function sharedPipelineId(remoteId: string): string {
  return `shared:${CANOPY_CLOUD_SERVER_ID}:${remoteId}`;
}

function materializeSharedPipeline(detail: SharedPipelineDetail): PipelineData {
  const content = parsePipelineText(detail.rawPipeline);
  const normalized = normalizePipeline(content);
  return {
    info: {
      id: sharedPipelineId(detail.id),
      remoteId: detail.id,
      serverId: CANOPY_CLOUD_SERVER_ID,
      serverName: CANOPY_CLOUD_DISPLAY_NAME,
      name: detail.name,
      description: detail.description,
      icon: detail.icon ?? '',
      filename: '',
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      triggerTypes: detail.triggerTypes,
      scopes: normalized.scope,
      source: 'shared',
      readonly: !detail.canUpdate,
      canUpdate: detail.canUpdate,
      canDelete: detail.canDelete,
      shareScope: detail.shareScope,
      owner: detail.owner,
    },
    content,
  };
}

export async function loadAgentPipelineById(
  id: string,
  runtime: AgentResourceActionRuntime,
  cwd = runtime.cwd,
): Promise<PipelineData | null> {
  return (await loadAgentPipelineSnapshot(id, runtime, cwd))?.pipeline ?? null;
}

/**
 * {@link loadAgentPipelineById}, with the checksum of what core read; a
 * project file read from the runtime's directory has none.
 */
async function loadAgentPipelineSnapshot(
  id: string,
  runtime: AgentResourceActionRuntime,
  cwd = runtime.cwd,
): Promise<{ pipeline: PipelineData; checksum?: string } | null> {
  // Core resolves every definition but a project file, which is found from
  // this runtime's directory: core reads project definitions by worktree
  // scope.
  if (!id.startsWith('project--')) {
    try {
      // Core hides a workflow an Orchestrator automation owns from this
      // runtime's place as not found (CAN-4551, CAN-6032).
      const snapshot = await readDesktopPipelineSnapshot(
        id,
        definitionScope(runtime),
        PIPELINE_DEFINITION_AGENT_CALLER,
        { workspaceId: runtime.projectId, worktreeId: runtime.worktreeId },
      );
      return { pipeline: snapshot.data, checksum: snapshot.checksum };
    } catch (error) {
      // A store id that names nothing is reported as not found.
      if (
        isPipelineDefinitionNotFound(error) &&
        !id.startsWith('curated:') &&
        !id.startsWith('shared:')
      )
        return null;
      throw pipelineSourceFailure(error);
    }
  }
  const projects = await discoverProjectPipelines(cwd).catch(() => []);
  const info = projects.find((entry) => entry.id === id);
  if (info?.filePath && pipelineResourceContextEnabled()) {
    const { projectId } = await authorizeProjectPipelineRequest({
      id,
      cwd,
      filePath: info.filePath,
    });
    if (projectId !== runtime.projectId)
      throw new Error('Workflow unavailable (context-mismatch)');
  }
  return info?.filePath
    ? {
        pipeline: {
          info,
          content: await loadProjectPipelineFromDisk(info.filePath),
        },
      }
    : null;
}

/**
 * A pipeline an agent runs with no project: curated, authorized shared,
 * bundled, or local user. Project pipelines are never discovered, so one is
 * reported as not found.
 */
export async function loadAgentGlobalPipelineById(
  id: string,
  executionContext: string,
): Promise<PipelineData | null> {
  if (id.startsWith('curated:')) {
    const { getManagedCuratedPipeline } =
      await import('../pipelines/curated-pipeline-catalog');
    return getManagedCuratedPipeline(id);
  }
  const remoteId = id.startsWith('shared:')
    ? sharedPipelineRemoteId(id)
    : undefined;
  if (remoteId) {
    await assertPipelinesCapability();
    // Read for the account, not the selected navigation context; the run's
    // owner is authorized next.
    const detail = await getSharedPipelineForExecutionContext(remoteId);
    if (pipelineResourceContextEnabled())
      await assertPipelineContext(
        { owner: detail.owner },
        undefined,
        executionContext,
      );
    return materializeSharedPipeline(detail);
  }
  if (id.startsWith('project--')) return null;
  const stored = pipelineStore.getPipeline(id);
  if (!stored.success || !stored.data || stored.data.info.source === 'project')
    return null;
  // Authorize against the run's owner, like the shared branch, never the
  // selected navigation context.
  if (pipelineResourceContextEnabled())
    await assertPipelineContext(
      await readStoredPipelineContext(id, executionContext),
      undefined,
      executionContext,
    );
  return stored.data;
}

async function readMutationYaml(
  action: { rawYaml?: string; yamlFilePath?: string },
  runtime: AgentResourceActionRuntime,
): Promise<string | null> {
  if (action.rawYaml !== undefined && action.yamlFilePath !== undefined) {
    throw new Error('Provide rawYaml or yamlFilePath, not both.');
  }
  if (action.rawYaml !== undefined) return action.rawYaml;
  if (!action.yamlFilePath) return null;
  const resolved = path.resolve(runtime.cwd, action.yamlFilePath);
  if (!isPathInside(runtime.cwd, resolved))
    throw new Error('yamlFilePath must be inside the current project.');
  const [canonicalWorkspace, canonicalTarget] = await Promise.all([
    realpath(runtime.cwd),
    realpath(resolved),
  ]);
  if (!isPathInside(canonicalWorkspace, canonicalTarget)) {
    throw new Error('yamlFilePath must be inside the current project.');
  }
  return readFile(canonicalTarget, 'utf8');
}

function pipelineSaveData(
  content: Pipeline,
  overrides: { name?: string; description?: string; icon?: string },
): { name: string; description: string; icon: string; content: Pipeline } {
  const next = { ...content };
  delete next.readonly;
  if (overrides.name !== undefined) next.name = overrides.name;
  if (overrides.description !== undefined)
    next.description = overrides.description;
  if (overrides.icon !== undefined) next.icon = overrides.icon;
  normalizePipeline(next);
  return {
    name: next.name,
    description: next.description ?? '',
    icon: next.icon ?? '',
    content: next,
  };
}

export async function pipelineReceipt(
  operation: string,
  pipeline: PipelineData,
  runtime: AgentResourceActionRuntime,
): Promise<ReturnType<typeof buildPipelineArtifactReceipt>> {
  const disabledPipelineIds: string[] = await readPreferencesFile()
    .then((preferences) => preferences.disabledPipelineIds)
    .catch((): string[] => []);
  const content = pipeline.content;
  const normalized = normalizePipeline(content);
  const remoteId = pipeline.info.remoteId;
  if (pipeline.info.source === 'shared' && !remoteId) {
    throw new Error('A shared pipeline receipt requires a remote id.');
  }
  return buildPipelineArtifactReceipt({
    operation,
    source: pipeline.info.source,
    ...(pipeline.info.source === 'user'
      ? {
          shareTarget: {
            kind: 'pipeline' as const,
            source: 'stored' as const,
            pipelineId: pipeline.info.id,
          },
        }
      : pipeline.info.source === 'project' && pipeline.info.filePath
        ? {
            shareTarget: {
              kind: 'pipeline' as const,
              source: 'project' as const,
              pipelineId: pipeline.info.id,
              projectId: runtime.projectId,
              worktreeId: runtime.worktreeId,
              relativePath: path
                .relative(runtime.cwd, pipeline.info.filePath)
                .split(path.sep)
                .join('/'),
              ...(runtime.repoId ? { repoId: runtime.repoId } : {}),
            },
          }
        : {}),
    ...(pipeline.info.source === 'shared'
      ? { sharedRemoteId: remoteId }
      : { localId: pipeline.info.id }),
    name: content.name,
    ...(content.description ? { description: content.description } : {}),
    enabled: !disabledPipelineIds.includes(pipeline.info.id),
    scopes: normalized.scope,
    // `workflow` starts only from the Workflows page, never an agent run.
    runModes: portablePipelineTriggerTypes(getTriggerTypes(content.on)),
    jobCount: Object.keys(content.jobs).length,
    stepCount: Object.values(content.jobs).reduce(
      (count, job) => count + job.steps.length,
      0,
    ),
    navigationTarget: {
      kind: 'pipeline_editor',
      pipelineId: pipeline.info.id,
      source: pipeline.info.source,
      ...(pipeline.info.source === 'project'
        ? {
            projectId: runtime.projectId,
            worktreeId: runtime.worktreeId,
            ...(runtime.repoId ? { repoId: runtime.repoId } : {}),
          }
        : {}),
      ...(remoteId ? { sharedRemoteId: remoteId } : {}),
    },
  });
}

async function pipelineAction(
  action: AgentResourceAction,
  runtime: AgentResourceActionRuntime,
): Promise<AppAdvisorActionResponse | null> {
  switch (action.type) {
    case 'pipeline.create': {
      return withAgentPipelineTelemetry(
        { action: 'create', source: 'user' },
        async () => {
          const raw = await readMutationYaml(action, runtime);
          if (!raw)
            return failure(
              'validation_failed',
              'Provide rawYaml or yamlFilePath.',
            );
          const content = parsePipelineText(raw);
          const policyError = validateAgentPipelineMutationPolicy(content);
          if (policyError) return failure('validation_failed', policyError);
          const owner = await agentPipelineOwnerContext(runtime);
          if ('refusal' in owner)
            return failure('validation_failed', owner.refusal);
          const ownerError = await validatePipelineOwnerTargetsOnSave(
            content,
            owner.owner,
          );
          if (ownerError) return failure('validation_failed', ownerError);
          const saveData = pipelineSaveData(content, action);
          const saved = await saveUserPipeline(
            saveData,
            PIPELINE_DEFINITION_AGENT_CALLER,
          );
          if (!saved.success || !saved.data)
            return ipcFailure(saved.error ?? 'Failed to create pipeline.');
          recordAgentPipelineWrite(saved.data.id, runtime, owner.owner);
          const pipeline: PipelineData = {
            info: saved.data,
            content: saveData.content,
          };
          return withAgentArtifacts(ok({ pipeline: saved.data }), [
            await pipelineReceipt(action.type, pipeline, runtime),
          ]);
        },
      );
    }
    case 'pipeline.update': {
      return withAgentPipelineTelemetry(
        { action: 'update', source: 'user' },
        async () => {
          const current = await loadAgentPipelineById(
            action.pipelineId,
            runtime,
          );
          if (!current)
            return failure(
              'not_found',
              `Pipeline ${action.pipelineId} was not found.`,
            );
          if (current.info.source !== 'user')
            return failure(
              'read_only_source',
              `${current.info.source} pipelines are read-only.`,
            );
          const raw = await readMutationYaml(action, runtime);
          const content =
            raw !== null ? parsePipelineText(raw) : current.content;
          if (raw !== null) {
            const policyError = validateAgentPipelineMutationPolicy(content);
            if (policyError) return failure('validation_failed', policyError);
          }
          // An update keeps the pipeline's stored owner.
          const ownerError = await validatePipelineOwnerTargetsOnSave(
            content,
            await getUserPipelineOwner(action.pipelineId),
          );
          if (ownerError) return failure('validation_failed', ownerError);
          const saveData = pipelineSaveData(content, action);
          // The revision read above refuses an edit that landed meanwhile.
          const saved = await saveUserPipeline(
            {
              ...saveData,
              id: action.pipelineId,
              expectedRevision: current.info.revision ?? 0,
            },
            PIPELINE_DEFINITION_AGENT_CALLER,
          );
          if (!saved.success || !saved.data)
            return ipcFailure(saved.error ?? 'Failed to update pipeline.');
          recordAgentPipelineWrite(action.pipelineId, runtime);
          const pipeline: PipelineData = {
            info: saved.data,
            content: saveData.content,
          };
          return withAgentArtifacts(ok({ pipeline: saved.data }), [
            await pipelineReceipt(action.type, pipeline, runtime),
          ]);
        },
      );
    }
    case 'pipeline.delete': {
      return withAgentPipelineTelemetry(
        { action: 'delete', source: 'user', hasPipelineId: true },
        async () => {
          const current = await loadAgentPipelineById(
            action.pipelineId,
            runtime,
          );
          if (!current)
            return failure(
              'not_found',
              `Pipeline ${action.pipelineId} was not found.`,
            );
          if (current.info.source !== 'user')
            return failure(
              'read_only_source',
              `${current.info.source} pipelines are read-only.`,
            );
          // Core deletes it with its preferences, local metadata,
          // subscription ledger entry and package install.
          const deleted = await deleteUserPipeline(
            action.pipelineId,
            current.info.revision ?? 0,
            PIPELINE_DEFINITION_AGENT_CALLER,
          );
          return deleted.success
            ? ok({ pipelineId: action.pipelineId, deleted: true })
            : ipcFailure(deleted.error ?? 'Failed to delete pipeline.');
        },
      );
    }
    case 'pipeline.duplicate': {
      return withAgentPipelineTelemetry(
        { action: 'duplicate', source: 'unknown', hasPipelineId: true },
        async () => {
          // The policy checks the very document core copies: a source that
          // changed since its checksum was read is refused.
          const snapshot = await loadAgentPipelineSnapshot(
            action.pipelineId,
            runtime,
          );
          if (!snapshot)
            return failure(
              'not_found',
              `Pipeline ${action.pipelineId} was not found.`,
            );
          const current = snapshot.pipeline;
          const duplicateContent = {
            ...current.content,
            name: `${current.content.name} (Copy)`,
          };
          const policyError =
            validateAgentPipelineMutationPolicy(duplicateContent);
          if (policyError) return failure('validation_failed', policyError);
          const owner = await agentPipelineOwnerContext(runtime);
          if ('refusal' in owner)
            return failure('validation_failed', owner.refusal);
          const ownerError = await validatePipelineOwnerTargetsOnSave(
            duplicateContent,
            owner.owner,
          );
          if (ownerError) return failure('validation_failed', ownerError);
          const saveData = pipelineSaveData(duplicateContent, {});
          // Core copies the definition under an id it assigns, with its
          // provenance. A project file found from this runtime's directory is
          // saved through core from the content read here, as core reads
          // project definitions by worktree scope.
          const saved =
            current.info.source === 'project'
              ? await saveAgentProjectCopy(current.info, runtime, saveData)
              : await duplicatePipelineDefinition(
                  action.pipelineId,
                  {
                    scope: definitionScope(runtime),
                    name: saveData.name,
                    ...(snapshot.checksum === undefined
                      ? {}
                      : { expectedChecksum: snapshot.checksum }),
                  },
                  PIPELINE_DEFINITION_AGENT_CALLER,
                );
          if (!saved.success || !saved.data)
            return ipcFailure(saved.error ?? 'Failed to duplicate pipeline.');
          recordAgentPipelineWrite(saved.data.id, runtime, owner.owner);
          const pipeline: PipelineData = {
            info: saved.data,
            content: saveData.content,
          };
          return withAgentArtifacts(
            ok({ pipeline: saved.data, duplicatedFrom: action.pipelineId }),
            [await pipelineReceipt(action.type, pipeline, runtime)],
          );
        },
      );
    }
    case 'pipeline.share': {
      return withAgentPipelineTelemetry(
        {
          action: 'shared_create',
          source: 'shared',
          hasPipelineId: true,
          shareScope: action.shareScope,
        },
        async () => {
          const shareOrganization =
            await resolveActionShareOrganization(action);
          if (!shareOrganization.ok) return shareOrganization.response;
          await assertPipelinesCapability();
          const current = await loadAgentPipelineById(
            action.pipelineId,
            runtime,
          );
          if (!current)
            return failure(
              'not_found',
              `Pipeline ${action.pipelineId} was not found.`,
            );
          if (current.info.source === 'shared') {
            return failure(
              'validation_failed',
              'This pipeline is already shared. Use pipeline.update_shared for shared pipelines.',
            );
          }
          const policyError = validateAgentPipelineMutationPolicy(
            current.content,
          );
          if (policyError) return failure('validation_failed', policyError);
          const rawPipeline = yaml.dump(
            { pipeline: current.content },
            { lineWidth: 120, noRefs: true },
          );
          const shareRequest = {
            rawPipeline,
            shareScope: action.shareScope,
            teamId: action.teamId,
            organizationId: shareOrganization.organizationId,
          };
          const shared = await (pipelineResourceContextEnabled()
            ? createSharedPipeline({
                ...shareRequest,
                sourcePipeline:
                  current.info.source === 'project' && current.info.filePath
                    ? {
                        kind: 'project',
                        projectId: runtime.projectId,
                        worktreeId: runtime.worktreeId,
                        repoId: runtime.repoId,
                        pipelineFilePath: current.info.filePath,
                      }
                    : { kind: 'stored', id: action.pipelineId },
              })
            : createSharedPipeline(shareRequest));
          // Sharing always keeps the local pipeline. A legacy `deleteLocal`
          // request is accepted and ignored; deletion is `pipeline.delete`.
          const loaded = materializeSharedPipeline(shared);
          return withAgentArtifacts(
            ok({ pipeline: shared, localDeleted: false }),
            [await pipelineReceipt(action.type, loaded, runtime)],
          );
        },
      );
    }
    case 'pipeline.update_shared': {
      return withAgentPipelineTelemetry(
        {
          action: 'shared_update',
          source: 'shared',
          hasPipelineId: true,
        },
        async () => {
          await assertPipelinesCapability();
          const target = resolveSharedPipelineMutationTarget(action);
          if ('response' in target) return target.response;
          const { remoteId } = target;
          const current = await getSharedPipeline(remoteId);
          if (!current.canUpdate)
            return failure(
              'authorization_conflict',
              'You do not have permission to update this shared pipeline.',
            );
          const raw = action.rawYaml ?? current.rawPipeline;
          const parsed = parsePipelineText(raw);
          if (action.rawYaml !== undefined) {
            const policyError = validateAgentPipelineMutationPolicy(parsed);
            if (policyError) return failure('validation_failed', policyError);
          }
          const content = pipelineSaveData(parsed, action).content;
          const hasAffectedAutomations = await getSharedPipelineSaveImpact(
            remoteId,
          )
            .then((impact) => impact.automations.length > 0)
            .catch(() => true);
          const shared = await updateSharedPipelinePreservingPackage(
            remoteId,
            yaml.dump({ pipeline: content }, { lineWidth: 120, noRefs: true }),
            current,
          );
          const loaded = materializeSharedPipeline(shared);
          return withAgentArtifacts(
            ok({
              pipeline: shared,
              ...(hasAffectedAutomations
                ? {
                    message:
                      'People using this pipeline in their automations will need to approve your changes before they run again.',
                  }
                : {}),
            }),
            [await pipelineReceipt(action.type, loaded, runtime)],
          );
        },
      );
    }
    case 'pipeline.delete_shared': {
      return withAgentPipelineTelemetry(
        {
          action: 'shared_delete',
          source: 'shared',
          hasPipelineId: true,
        },
        async () => {
          await assertPipelinesCapability();
          const target = resolveSharedPipelineMutationTarget(action);
          if ('response' in target) return target.response;
          const { remoteId } = target;
          const current = await getSharedPipeline(remoteId);
          if (!current.canDelete)
            return failure(
              'authorization_conflict',
              'You do not have permission to delete this shared pipeline.',
            );
          await deleteSharedPipeline(remoteId);
          return ok({ remoteId, deleted: true });
        },
      );
    }
    case 'pipeline.set_enabled': {
      return withAgentPipelineTelemetry(
        { action: 'update', source: 'unknown', hasPipelineId: true },
        async () => {
          const current = await loadAgentPipelineById(
            action.pipelineId,
            runtime,
          );
          if (!current)
            return failure(
              'not_found',
              `Pipeline ${action.pipelineId} was not found.`,
            );
          await setPipelineDefinitionEnabled(
            current.info.id,
            action.enabled,
            PIPELINE_DEFINITION_AGENT_CALLER,
          );
          return withAgentArtifacts(
            ok({ pipelineId: current.info.id, enabled: action.enabled }),
            [await pipelineReceipt(action.type, current, runtime)],
          );
        },
      );
    }
    default:
      return null;
  }
}

function automationSchedule(activity: ScheduledActivity): string {
  return activity.schedule.kind === 'cron'
    ? `cron ${activity.schedule.expression} (${activity.schedule.timezone})`
    : `once ${activity.schedule.runAt} (${activity.schedule.timezone})`;
}

function automationTarget(activity: ScheduledActivity): string {
  const action = activity.action;
  switch (action.type) {
    case 'app_advisor_prompt':
      return ORCHESTRATOR_LABEL;
    case 'standalone_prompt':
      return `cowork project ${action.chatProjectId}`;
    case 'worktree_prompt':
      return `project ${action.workspaceId}`;
    case 'worktree_session_prompt':
      return `chat ${action.workspaceId}/${action.worktreeId}/${action.chatId}`;
    case 'worktree_pipeline':
      return pipelineAutomationTargetSummary(action);
    case 'pipeline_execution_resume':
      return `pipeline execution ${action.executionId}`;
  }
}

function hasAutomationTerminalInterfaceMode(
  action: ScheduledActivity['action'],
): boolean {
  return (
    action.type === 'worktree_prompt' &&
    action.interfaceMode !== undefined &&
    action.interfaceMode !== 'canopy'
  );
}

function automationInterfaceModeFailure(): AppAdvisorActionResponse {
  return failure(
    'validation_failed',
    'Claude terminal chat mode cannot be configured for automations while it is unavailable.',
  );
}

const APP_ADVISOR_OWNER_UNKNOWN_MESSAGE =
  'The project owner could not be confirmed, so Orchestrator access is unavailable for agents in this project.';

function appAdvisorAccessFailure(
  decision: AppAdvisorAccessDecision,
): AppAdvisorActionResponse | null {
  if (decision.allowed) return null;
  return failure(
    ADVISOR_ACCESS_DISABLED,
    decision.reason === 'owner_unknown'
      ? APP_ADVISOR_OWNER_UNKNOWN_MESSAGE
      : ADVISOR_ACCESS_DISABLED_MESSAGE,
  );
}

function hiddenAutomationNotFound(id: string): AppAdvisorActionResponse {
  return failure('not_found', `Activity ${id} was not found.`);
}

const AUTOMATION_OWNER_UNKNOWN_MESSAGE =
  'The project owner could not be confirmed, so automation access is unavailable for agents in this project.';

function automationOwnerUnavailable(): AppAdvisorActionResponse {
  return failure('owner_context_unavailable', AUTOMATION_OWNER_UNKNOWN_MESSAGE);
}

function automationOwnerContext(
  owner: ResolvedProjectOwner,
): WorkspaceContext | undefined {
  if (owner.kind === 'personal') return { kind: 'personal' };
  if (owner.kind === 'organization') {
    return { kind: 'organization', organizationId: owner.organizationId };
  }
  return undefined;
}

function automationOwnerDecisionFailure(
  decision: SameOwnerDecision,
  activityId?: string,
): AppAdvisorActionResponse | null {
  if (decision.kind === 'allowed') return null;
  if (decision.kind === 'hidden') {
    return activityId !== undefined
      ? hiddenAutomationNotFound(activityId)
      : failure('not_found', 'Project not found.');
  }
  return automationOwnerUnavailable();
}

/**
 * The action an agent's access and policy checks see. A converted chat
 * automation (CAN-4551) is checked as the chat action its owned pipeline
 * stands for, so converting it changes neither.
 */
function agentPolicyAction(
  activity: ScheduledActivity,
): ScheduledActivity['action'] {
  const projected = projectOwnedChatAutomation(activity);
  // CAN-5782: an owner whose pipeline other schedules share still stands
  // for its chat action, so the session-prompt checks still apply.
  return projected.ownedPipeline?.chatAction ?? projected.action;
}

function isAppAdvisorAutomation(activity: ScheduledActivity): boolean {
  return (
    agentPolicyAction(activity).type === 'app_advisor_prompt' ||
    ownsOrchestratorPromptPipeline(activity) ||
    // CAN-5782: a schedule on an Orchestrator pipeline whose owner is gone.
    targetsAgentHiddenPipeline(activity)
  );
}

function hideAppAdvisorAutomations(
  state: AutomationsListResponse,
): AutomationsListResponse {
  const advisorIds = new Set(
    state.activities
      .filter(isAppAdvisorAutomation)
      .map((activity) => activity.id),
  );
  return {
    ...state,
    activities: state.activities.filter(
      (activity) => !advisorIds.has(activity.id),
    ),
    recentRuns: state.recentRuns.filter(
      (run) => !advisorIds.has(run.activityId),
    ),
  };
}

function automationReceipt(
  operation: string,
  activity: ScheduledActivity,
  running: boolean,
  changedFields?: AgentArtifactChangedField[],
): ReturnType<typeof buildAutomationArtifactReceipt> {
  return buildAutomationArtifactReceipt({
    operation,
    ...(changedFields?.length ? { changedFields } : {}),
    activityId: activity.id,
    name: activity.name,
    enabled: activity.enabled,
    running,
    schedule: automationSchedule(activity),
    ...(activity.nextRunAt ? { nextRunAt: activity.nextRunAt } : {}),
    actionKind: activity.action.type,
    targetSummary: automationTarget(activity),
    ifCommandConfigured: Boolean(activity.ifCommand?.trim()),
    navigationTarget: { kind: 'automation_editor', activityId: activity.id },
  });
}

async function automationAction(
  action: AgentResourceAction,
  runtime: AgentResourceActionRuntime,
): Promise<AppAdvisorActionResponse | null> {
  if (!action.type.startsWith('automation.')) return null;
  const caller = {
    projectId: runtime.projectId,
    worktreeId: runtime.worktreeId,
  };
  const callerOwner = await resolveProjectSavedOwner(caller);
  const advisorAccess = await decideAppAdvisorAccessForCaller(
    caller,
    callerOwner,
  );
  const deniedAdvisorAccess = appAdvisorAccessFailure(advisorAccess);
  const callerContext = automationOwnerContext(callerOwner);

  // Defer the scheduler/service graph until an automation resource action is
  // dispatched so non-automation agent calls do not initialize it eagerly.
  const { getAutomationsService } = await import('../automations/service');
  const service = getAutomationsService();
  const snapshot = (): ReturnType<typeof service.list> =>
    callerContext ? service.listForContext(callerContext) : service.list();
  const find = async (id: string): Promise<ScheduledActivity | undefined> =>
    (await snapshot()).activities.find((activity) => activity.id === id);
  // One view of the caller's owner and its decisions. The initial view is
  // resolved once per action and caches target decisions; mutation guards
  // build a fresh view inside the service queue so an owner change that lands
  // while the mutation waits is seen.
  interface OwnerView {
    callerOwner: ResolvedProjectOwner;
    decideTarget: (target: ProjectOwnerTarget) => Promise<SameOwnerDecision>;
    advisorFailure: () => Promise<AppAdvisorActionResponse | null>;
  }
  const ownerDecisionCache = new Map<string, Promise<SameOwnerDecision>>();
  const initialView: OwnerView = {
    callerOwner,
    decideTarget: (target) => {
      const key = JSON.stringify([target.projectId, target.worktreeId]);
      const cached = ownerDecisionCache.get(key);
      if (cached) return cached;
      const decision = decideSameOwnerAccess(callerOwner, target);
      ownerDecisionCache.set(key, decision);
      return decision;
    },
    advisorFailure: () => Promise.resolve(deniedAdvisorAccess),
  };
  const freshOwnerView = async (): Promise<OwnerView> => {
    const freshCallerOwner = await resolveProjectSavedOwner(caller);
    return {
      callerOwner: freshCallerOwner,
      decideTarget: (target) => decideSameOwnerAccess(freshCallerOwner, target),
      advisorFailure: async () =>
        appAdvisorAccessFailure(
          await decideAppAdvisorAccessForCaller(caller, freshCallerOwner),
        ),
    };
  };
  // A pipeline with no project belongs to the owner it is saved with.
  const globalOwnerOf = (activity: ScheduledActivity): string =>
    activity.executionContext ?? 'personal';
  const decideOwnerForAction = (
    automationAction: ScheduledActivity['action'],
    view: OwnerView = initialView,
    globalOwner?: string,
  ): Promise<SameOwnerDecision> => {
    if (automationAction.type === 'app_advisor_prompt') {
      return Promise.resolve({ kind: 'allowed' });
    }
    if (view.callerOwner.kind === 'none') {
      return Promise.resolve({ kind: 'allowed' });
    }
    const target = resolveAutomationTargetProject(automationAction);
    if (target.kind === 'global') {
      const callerOwnerContext = automationOwnerContext(view.callerOwner);
      return Promise.resolve(
        callerOwnerContext !== undefined &&
          globalOwner === serializeWorkspaceContext(callerOwnerContext)
          ? { kind: 'allowed' }
          : { kind: 'hidden' },
      );
    }
    if (target.kind !== 'project') {
      return Promise.resolve({ kind: 'hidden' });
    }
    return view.decideTarget({
      projectId: target.projectId,
      ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
    });
  };
  const currentActivityFailure = async (
    current: ScheduledActivity,
    operation: 'update' | 'disable' | 'delete' | 'run_now',
    view: OwnerView = initialView,
  ): Promise<AppAdvisorActionResponse | null> => {
    if (isAppAdvisorAutomation(current)) {
      const advisorFailure = await view.advisorFailure();
      if (!advisorFailure) return null;
      if (operation === 'delete') {
        return failure('not_found', 'Activity not found.');
      }
      if (operation === 'disable') {
        return hiddenAutomationNotFound(current.id);
      }
      return advisorFailure;
    }
    if (view.callerOwner.kind === 'unknown') {
      return automationOwnerUnavailable();
    }
    const decision = await decideOwnerForAction(
      current.action,
      view,
      globalOwnerOf(current),
    );
    if (operation === 'delete' && decision.kind === 'hidden') {
      return failure('not_found', 'Activity not found.');
    }
    return automationOwnerDecisionFailure(
      decision,
      operation === 'delete' ? undefined : current.id,
    );
  };
  const currentPolicyFailure = (
    current: ScheduledActivity,
    operation: 'update' | 'disable' | 'run_now',
    updatePatch?: Extract<
      AgentResourceAction,
      { type: 'automation.update' }
    >['patch'],
  ): AppAdvisorActionResponse | null => {
    if (operation === 'run_now') {
      if (current.ifCommand?.trim()) {
        return failure(
          'validation_failed',
          AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR,
        );
      }
      const policyError = validateAgentAutomationRunPolicy(current.action);
      return policyError ? failure('validation_failed', policyError) : null;
    }
    const patch =
      operation === 'disable' ? { enabled: false } : (updatePatch ?? {});
    const policyError = validateAgentAutomationUpdatePolicy(
      agentPolicyAction(current),
      patch,
      current.ifCommand,
      Boolean(current.agentScheduledSend),
    );
    return policyError ? failure('validation_failed', policyError) : null;
  };
  const patchTargetFailure = async (
    current: ScheduledActivity,
    patch: Extract<AgentResourceAction, { type: 'automation.update' }>['patch'],
    view: OwnerView = initialView,
  ): Promise<AppAdvisorActionResponse | null> => {
    if (!patch.action) return null;
    if (patch.action.type === 'app_advisor_prompt') {
      const advisorFailure = await view.advisorFailure();
      if (advisorFailure) return advisorFailure;
    }
    return automationOwnerDecisionFailure(
      await decideOwnerForAction(patch.action, view, globalOwnerOf(current)),
    );
  };
  const respondMutation = async (
    operation: string,
    response: Awaited<ReturnType<typeof service.update>>,
    receipt: boolean,
    before?: ScheduledActivity,
  ): Promise<AppAdvisorActionResponse> => {
    if (!response.ok) return ipcFailure(response.error);
    const responseActivity = response.activity;
    if (!responseActivity) return ok({ run: response.run });
    const state = await snapshot();
    const running = state.recentRuns.some(
      (run) =>
        run.activityId === responseActivity.id && run.status === 'running',
    );
    const success = ok({
      activity: responseActivity,
      ...(response.run ? { run: response.run } : {}),
    });
    return receipt
      ? withAgentArtifacts(success, [
          automationReceipt(
            operation,
            responseActivity,
            running,
            before
              ? automationChangedFields(before, responseActivity)
              : undefined,
          ),
        ])
      : success;
  };
  switch (action.type) {
    case 'automation.list': {
      if (callerOwner.kind === 'unknown') return automationOwnerUnavailable();
      const listed = await snapshot();
      const contextState =
        callerOwner.kind === 'none'
          ? await scopeAutomationsToSelectedContext(listed)
          : listed;
      const advisorState = deniedAdvisorAccess
        ? hideAppAdvisorAutomations(contextState)
        : contextState;
      let state = advisorState;
      if (callerOwner.kind !== 'none') {
        const visibleActivities: ScheduledActivity[] = [];
        const visibleActivityIds = new Set<string>();
        for (const activity of advisorState.activities) {
          const decision = await decideOwnerForAction(
            activity.action,
            initialView,
            globalOwnerOf(activity),
          );
          if (decision.kind === 'allowed') {
            visibleActivities.push(activity);
            visibleActivityIds.add(activity.id);
          }
        }
        state = {
          ...advisorState,
          activities: visibleActivities,
          recentRuns: advisorState.recentRuns.filter((run) =>
            visibleActivityIds.has(run.activityId),
          ),
        };
      }
      return ok(
        action.includeRuns === false ? { activities: state.activities } : state,
      );
    }
    case 'automation.get': {
      const state = await snapshot();
      const activity = state.activities.find(
        (candidate) => candidate.id === action.id,
      );
      if (!activity) {
        return hiddenAutomationNotFound(action.id);
      }
      if (isAppAdvisorAutomation(activity) && deniedAdvisorAccess) {
        return hiddenAutomationNotFound(action.id);
      }
      if (callerOwner.kind === 'unknown') return automationOwnerUnavailable();
      const ownerFailure = automationOwnerDecisionFailure(
        await decideOwnerForAction(
          activity.action,
          initialView,
          globalOwnerOf(activity),
        ),
        action.id,
      );
      if (ownerFailure) return ownerFailure;
      const recentRuns = [];
      let cursor: string | undefined;
      do {
        const page = await service.listRuns(
          {
            activityId: action.id,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          },
          callerContext,
        );
        recentRuns.push(...page.runs);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return withAgentArtifacts(ok({ activity, recentRuns }), [
        buildCapabilityReferenceArtifactReceipt({
          operation: action.type,
          itemKind: 'automation',
          source: 'local',
          sourceId: activity.id,
          name: activity.name,
          sourceLabel: 'Local',
          state: 'installed',
          relation: 'found',
          navigationTarget: {
            kind: 'automation_editor',
            activityId: activity.id,
          },
        }),
      ]);
    }
    case 'automation.create': {
      if (
        action.input.action.type === 'app_advisor_prompt' &&
        deniedAdvisorAccess
      ) {
        return deniedAdvisorAccess;
      }
      if (callerOwner.kind === 'unknown') return automationOwnerUnavailable();
      // A pipeline with no project is owned by the caller's project (the
      // selected context for App Advisor), never by a caller-supplied value.
      let owner: string | undefined;
      if (isGlobalPipelineAutomationAction(action.input.action)) {
        const resolved = await agentPipelineOwnerContext(runtime);
        if ('refusal' in resolved)
          return failure('validation_failed', resolved.refusal);
        owner = resolved.owner;
      }
      const ownerFailure = automationOwnerDecisionFailure(
        await decideOwnerForAction(action.input.action, initialView, owner),
      );
      if (ownerFailure) return ownerFailure;
      const policyError = validateAgentAutomationCreatePolicy(action.input);
      if (policyError) return failure('validation_failed', policyError);
      if (
        !isClaudeTuiChatsEnabled() &&
        hasAutomationTerminalInterfaceMode(action.input.action)
      ) {
        return automationInterfaceModeFailure();
      }
      let guardRefusal: AppAdvisorActionResponse | undefined;
      const authorize = async (): Promise<boolean> => {
        const view = await freshOwnerView();
        if (action.input.action.type === 'app_advisor_prompt') {
          guardRefusal = (await view.advisorFailure()) ?? undefined;
          if (guardRefusal) return false;
        }
        if (view.callerOwner.kind === 'unknown') {
          guardRefusal = automationOwnerUnavailable();
          return false;
        }
        guardRefusal =
          automationOwnerDecisionFailure(
            await decideOwnerForAction(action.input.action, view, owner),
          ) ?? undefined;
        return guardRefusal === undefined;
      };
      // CAN-4551 7c: converted while the chat automation pipelines
      // experiment is on.
      const { createAutomationForAgent } =
        await import('../automations/chat-automation-save');
      const response = await createAutomationForAgent(
        action.input,
        {
          authorize,
          agentAuthor: agentAuthorForRuntime(runtime),
          ...(owner === undefined ? {} : { owner }),
        },
        service,
      );
      if (guardRefusal) return guardRefusal;
      return respondMutation(action.type, response, true);
    }
    case 'automation.update': {
      const current = await find(action.id);
      if (!current) return hiddenAutomationNotFound(action.id);
      const existingFailure = await currentActivityFailure(current, 'update');
      if (existingFailure) return existingFailure;
      const targetFailure = await patchTargetFailure(current, action.patch);
      if (targetFailure) return targetFailure;
      const policyError = validateAgentAutomationUpdatePolicy(
        agentPolicyAction(current),
        action.patch,
        current.ifCommand,
        Boolean(current.agentScheduledSend),
      );
      if (policyError) return failure('validation_failed', policyError);
      if (
        action.patch.action &&
        !isClaudeTuiChatsEnabled() &&
        hasAutomationTerminalInterfaceMode(action.patch.action)
      ) {
        return automationInterfaceModeFailure();
      }
      let guardRefusal: AppAdvisorActionResponse | undefined;
      const authorize = async (fresh: ScheduledActivity): Promise<boolean> => {
        const view = await freshOwnerView();
        guardRefusal =
          (await currentActivityFailure(fresh, 'update', view)) ?? undefined;
        if (guardRefusal) return false;
        guardRefusal =
          (await patchTargetFailure(fresh, action.patch, view)) ?? undefined;
        if (guardRefusal) return false;
        guardRefusal =
          currentPolicyFailure(fresh, 'update', action.patch) ?? undefined;
        if (guardRefusal) return false;
        if (
          action.patch.action &&
          !isClaudeTuiChatsEnabled() &&
          hasAutomationTerminalInterfaceMode(action.patch.action)
        ) {
          guardRefusal = automationInterfaceModeFailure();
          return false;
        }
        return true;
      };
      // CAN-4551 7c: a converted automation stays converted, or converts
      // back once its agent-authored runs would be refused.
      const { updateAutomationForAgent } =
        await import('../automations/chat-automation-save');
      const response = await updateAutomationForAgent(
        { id: action.id, ...action.patch },
        {
          authorize,
          ...(callerContext ? { callerContext } : {}),
          agentAuthor: agentAuthorForRuntime(runtime),
          // Converting back writes an Orchestrator prompt natively, which
          // needs the caller's Orchestrator access, as a native create does.
          authorizeNative: async (native): Promise<boolean> => {
            if (native.type !== 'app_advisor_prompt') return true;
            guardRefusal =
              (await (await freshOwnerView()).advisorFailure()) ?? undefined;
            return guardRefusal === undefined;
          },
        },
        service,
      );
      if (guardRefusal) return guardRefusal;
      if (!response.ok && response.error === 'Activity not found.') {
        return hiddenAutomationNotFound(action.id);
      }
      return respondMutation(action.type, response, true, current);
    }
    case 'automation.disable': {
      const current = await find(action.id);
      if (!current) return hiddenAutomationNotFound(action.id);
      const existingFailure = await currentActivityFailure(current, 'disable');
      if (existingFailure) return existingFailure;
      const policyFailure = currentPolicyFailure(current, 'disable');
      if (policyFailure) return policyFailure;
      let guardRefusal: AppAdvisorActionResponse | undefined;
      const authorize = async (fresh: ScheduledActivity): Promise<boolean> => {
        guardRefusal =
          (await currentActivityFailure(
            fresh,
            'disable',
            await freshOwnerView(),
          )) ?? undefined;
        if (guardRefusal) return false;
        guardRefusal = currentPolicyFailure(fresh, 'disable') ?? undefined;
        return guardRefusal === undefined;
      };
      const updateRequest = { id: action.id, enabled: false };
      const response = callerContext
        ? await service.update(updateRequest, authorize, callerContext)
        : await service.update(updateRequest, authorize);
      if (guardRefusal) return guardRefusal;
      if (!response.ok && response.error === 'Activity not found.') {
        return hiddenAutomationNotFound(action.id);
      }
      return respondMutation(action.type, response, true);
    }
    case 'automation.delete': {
      const current = await find(action.id);
      if (!current) {
        const authorizeMissing = (): Promise<boolean> => Promise.resolve(false);
        const deleteRequest = { id: action.id };
        const response = callerContext
          ? await service.delete(deleteRequest, authorizeMissing, callerContext)
          : await service.delete(deleteRequest, authorizeMissing);
        return respondMutation(action.type, response, false);
      }
      const existingFailure = await currentActivityFailure(current, 'delete');
      if (existingFailure) return existingFailure;
      let guardRefusal: AppAdvisorActionResponse | undefined;
      const authorize = async (fresh: ScheduledActivity): Promise<boolean> => {
        guardRefusal =
          (await currentActivityFailure(
            fresh,
            'delete',
            await freshOwnerView(),
          )) ?? undefined;
        return guardRefusal === undefined;
      };
      const deleteRequest = { id: action.id };
      const response = callerContext
        ? await service.delete(deleteRequest, authorize, callerContext)
        : await service.delete(deleteRequest, authorize);
      if (guardRefusal) return guardRefusal;
      return respondMutation(action.type, response, false);
    }
    case 'automation.run_now': {
      const current = await find(action.id);
      if (!current) return hiddenAutomationNotFound(action.id);
      const existingFailure = await currentActivityFailure(current, 'run_now');
      if (existingFailure) return existingFailure;
      const policyFailure = currentPolicyFailure(current, 'run_now');
      if (policyFailure) return policyFailure;
      let guardRefusal: AppAdvisorActionResponse | undefined;
      const authorize = async (fresh: ScheduledActivity): Promise<boolean> => {
        guardRefusal =
          (await currentActivityFailure(
            fresh,
            'run_now',
            await freshOwnerView(),
          )) ?? undefined;
        if (guardRefusal) return false;
        guardRefusal = currentPolicyFailure(fresh, 'run_now') ?? undefined;
        return guardRefusal === undefined;
      };
      const runRequest = { id: action.id };
      const response = callerContext
        ? await service.runNow(runRequest, authorize, callerContext)
        : await service.runNow(runRequest, authorize);
      if (guardRefusal) return guardRefusal;
      if (!response.ok && response.error === 'Activity not found.') {
        return hiddenAutomationNotFound(action.id);
      }
      if (!response.ok) return ipcFailure(response.error);
      // The authorize callback approved the fresh row that actually ran.
      const ran = response.activity ?? current;
      const success = ok({
        ...(response.activity ? { activity: response.activity } : {}),
        run: response.run,
      });
      if (!response.run) return success;
      const run = response.run;
      const receipts: unknown[] = [buildAutomationRunArtifactReceipt(ran, run)];
      const executionId = run.result?.pipelineExecutionId;
      const projectId = run.result?.projectId;
      const worktreeId = run.result?.worktreeId;
      const pipeline =
        ran.action.type === 'worktree_pipeline'
          ? pipelineStore.getPipeline(ran.action.pipelineId)
          : undefined;
      if (
        executionId &&
        projectId &&
        worktreeId &&
        ran.action.type === 'worktree_pipeline'
      ) {
        receipts.push(
          buildPipelineRunArtifactReceipt({
            operation: action.type,
            executionId,
            pipelineId: ran.action.pipelineId,
            pipelineName:
              pipeline?.success && pipeline.data
                ? pipeline.data.info.name
                : ran.action.pipelineId,
            initialStatus: 'pending',
            queuedAt: run.startedAt,
            projectId,
            worktreeId,
            navigationTarget: {
              kind: 'pipeline_execution',
              executionId,
              projectId,
              worktreeId,
            },
          }),
        );
      }
      if (
        executionId &&
        projectId &&
        worktreeId &&
        ran.action.type === 'pipeline_execution_resume'
      ) {
        try {
          const { createElectronExecutionRuntime } =
            await import('../pipelines/execution-runtime');
          const { loadExecutionState } =
            await import('@canopy/execution-engine/node/pipelines/executor/execution-state');
          const execution = await loadExecutionState(
            executionId,
            createElectronExecutionRuntime().executionsDir,
          );
          if (
            execution &&
            execution.project_id === projectId &&
            execution.worktree_id === worktreeId
          )
            receipts.push(
              buildPipelineRunArtifactReceipt({
                operation: action.type,
                executionId,
                pipelineId: execution.pipeline_id,
                pipelineName: execution.pipeline_snapshot.name,
                initialStatus:
                  execution.status === 'running' ||
                  execution.status === 'paused'
                    ? execution.status
                    : 'pending',
                queuedAt: execution.started_at,
                projectId,
                worktreeId,
                navigationTarget: {
                  kind: 'pipeline_execution',
                  executionId,
                  projectId,
                  worktreeId,
                },
              }),
            );
        } catch {
          /* A missing historical execution must not discard the persisted automation run. */
        }
      }
      return withAgentArtifacts(success, receipts);
    }
    default:
      return null;
  }
}

/** Execute resource actions without consulting or mutating renderer UI state. */
export async function dispatchAgentResourceAction(
  action: AgentResourceAction,
  runtime: AgentResourceActionRuntime,
): Promise<AppAdvisorActionResponse> {
  try {
    return (
      (await skillAction(action)) ??
      (await pipelineAction(action, runtime)) ??
      (await automationAction(action, runtime)) ??
      failure('unsupported_action', `${action.type} is not a resource action.`)
    );
  } catch (cause) {
    return agentResourceActionFailure(cause);
  }
}
