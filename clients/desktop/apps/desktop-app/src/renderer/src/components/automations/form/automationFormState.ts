// Automation form state: the `FormState` the automation editor works on, the
// helpers that move it between selections, and the pure conversions to and
// from the wire (`activityToFormState`, `buildTrigger`, `buildAction`,
// `buildAutomationMutationRequest`). Kept free of React so every host (the
// Automations page, the side panel, the full-page editor) shares one form
// contract. `AutomationsPage` re-exports the original names.

import type {
  AgentModelConfig,
  ApprovalMode,
  AutomationAction,
  AutomationCreateRequest,
  AutomationDependencies,
  AutomationPipelineDependency,
  AutomationTrigger,
  AutomationUpdateRequest,
  ChatAttachmentPromptContext,
  ChatInterfaceMode,
  ChatModel,
  ChatTabPluginSelections,
  ConfiguredPromptReference,
  FileReference,
  ScheduledActivity,
  ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  hasAnySelections,
} from '@canopy/desktop-shared/types';
import { emptyPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { canonicalizeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import { CHAT_LABEL, ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { validateConfiguredPromptReferences } from '@canopy/protocol/configured-prompt-references';
import {
  normalizeSidebarItemGroupName,
  type SidebarItemGroupScope,
} from '@canopy/protocol/sidebar';
import { type ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import {
  formatCronValidationError,
  validateAutomationTrigger,
  type AutomationChatRunMode,
} from '@canopy/desktop-shared/lib/automations';
import type { PipelineModelAlias } from '@canopy/execution-engine/types/pipeline';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import {
  buildWorktreeSessionPromptAction,
  type WorktreeSessionTarget,
} from '@/components/automations/worktreeSessionPrompt';
import { AUTOMATION_CHAT_TARGET_INCOMPLETE_ERROR } from '@/components/automations/AutomationChatTargetPicker';
import type { AutomationDraftSeed } from '@/lib/workflows/edit-target';
import {
  PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR,
  pipelineAutomationWorkspaceId,
  resolveAutomationPipelineTarget,
} from '@canopy/desktop-shared/lib/automation-pipeline-target';
import type { AutomationPipelineTargetKind } from '@canopy/protocol/automations';

type ActionType = AutomationAction['type'];
type TriggerKind = AutomationTrigger['kind'];
/**
 * Top-level action selector value. `app_advisor` maps 1:1 to the
 * `app_advisor_prompt` wire type; `project` covers the unified
 * workspace-targeted actions (`worktree_prompt`, `worktree_pipeline`,
 * `standalone_prompt`) whose concrete wire type is derived from the selected
 * workspace kind plus the Chat/Pipeline mode; `global` is a
 * `worktree_pipeline` that runs with no project.
 */
export type ActionCategory = 'app_advisor' | 'workspace' | 'global';
/** Chat vs Pipeline mode of the `project` action category. */
export type WorkspaceActionMode = 'chat' | 'pipeline';
type WorktreePipelineAction = Extract<
  AutomationAction,
  { type: 'worktree_pipeline' }
>;
type PromptAction = Extract<
  AutomationAction,
  { type: 'app_advisor_prompt' | 'standalone_prompt' | 'worktree_prompt' }
>;

/** A worktree's label in the automation form and action descriptions. */
export function getAutomationWorktreeLabel(worktree: {
  id: string;
  branchName: string;
}): string {
  return getWorktreeBranchDisplayName({
    rawBranch: worktree.branchName,
    worktreeId: worktree.id,
    hasMultipleBranches: false,
    getBranchDisplayName: (branchName) => branchName,
  });
}

export interface FormState {
  mode: 'create' | 'edit';
  id?: string;
  name: string;
  enabled: boolean;
  triggerKind: TriggerKind;
  cronExpression: string;
  oneTimeDate: string;
  oneTimeTime: string;
  actionType: ActionType;
  prompt: string;
  workspaceId: string;
  baseWorktreeId: string;
  /**
   * Existing worktree that receives a new chat each run (`worktree_prompt`).
   * Authored through the "Existing chat" Run-in mode with "New chat" picked.
   */
  existingWorktreeId: string;
  /**
   * Existing Work Entry that receives a new chat each run (`standalone_prompt`
   * and `app_advisor_prompt`). Authored like `existingWorktreeId`.
   */
  workEntryId: string;
  /**
   * '' = no group; otherwise the sidebar group label new containers join.
   * Only serialized in new_chat mode for the three prompt action types.
   */
  sidebarGroupName: string;
  baseBranch?: string;
  model: ChatModel | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  fastMode: boolean | undefined;
  plugins: ShareablePluginRef[];
  pluginSelections: ChatTabPluginSelections;
  planMode: boolean | undefined;
  approvalMode?: ApprovalMode;
  promptReferences?: ConfiguredPromptReference[];
  chatModelConfig?: AgentModelConfig;
  interfaceMode: ChatInterfaceMode | '';
  pipelineId: string;
  pipelineName: string;
  pipelineSource: WorktreePipelineAction['pipelineSource'];
  projectPipelineFilename: string;
  sharedPipeline?: WorktreePipelineAction['sharedPipeline'];
  repoId: string;
  pipelineInputs: Array<{ key: string; value: string }>;
  pluginCollectionPreferences?: WorktreePipelineAction['pluginCollectionPreferences'];
  modelAliasPreferences?: WorktreePipelineAction['modelAliasPreferences'];
  pipelineModelAliases?: PipelineModelAlias[];
  pipelinePluginCollectionIds?: string[];
  modelConfig?: WorktreePipelineAction['modelConfig'];
  chatProjectId: string;
  // `worktree_session_prompt` (management/edit modal) fields. The target
  // identity, trigger, prompt, and payload are readonly here; edits happen
  // inline from the target chat's queued-message UI.
  worktreeSessionTarget?: WorktreeSessionTarget;
  fileReferences?: FileReference[];
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  inputMode?: 'typed' | 'voice';
  purpose?: 'usage_limit_resume' | 'scheduled_send';
  /**
   * True when the original session-prompt payload came from the chat composer
   * or usage-limit flow. Kept independently of `actionType` so a Run-in mode
   * toggle cannot accidentally unlock fields that remain chat-owned until the
   * user saves the new destination mode.
   */
  chatAuthoredPayload: boolean;
  ifCommand: string;
  targetRequirement?: ScheduledActivity['targetRequirement'];
  /**
   * Local pipelines a prompt automation runs, so sharing packages them.
   * Undefined until the automation has or the author adds one.
   */
  pipelineDependencies?: AutomationPipelineDependency[];
  installed: boolean;
  /**
   * Where a `worktree_pipeline` runs. A legacy action with no saved `target`
   * loads as `new_worktree` with `pipelineTargetExplicit` false, which runs
   * in the project folder on a cowork project.
   */
  pipelineTargetKind: AutomationPipelineTargetKind;
  /** Existing worktree or Work Entry for a `task` destination; '' otherwise. */
  pipelineTaskId: string;
  /**
   * Whether the saved action carries `target`. An unchanged legacy action
   * saves without one; choosing a destination makes it explicit.
   */
  pipelineTargetExplicit: boolean;
  /** The saved owner of an existing automation; read-only here. */
  executionContext?: string;
}

/** The prompt actions whose editor offers pipeline dependencies. */
export function actionTypeTakesPipelineDependencies(
  actionType: AutomationAction['type'],
): boolean {
  return (
    actionType === 'app_advisor_prompt' ||
    actionType === 'standalone_prompt' ||
    actionType === 'worktree_prompt'
  );
}

function savedPipelineDependencies(
  state: FormState,
): AutomationPipelineDependency[] {
  return actionTypeTakesPipelineDependencies(state.actionType)
    ? (state.pipelineDependencies ?? [])
    : [];
}

/** The `dependencies` a create writes: only a non-empty list. */
function createDependenciesField(state: FormState): {
  dependencies?: AutomationDependencies;
} {
  const pipelines = savedPipelineDependencies(state);
  return pipelines.length > 0 ? { dependencies: { pipelines } } : {};
}

/**
 * The `dependencies` an edit writes. An edit that loaded or changed the list
 * always sends it, `null` clearing it (including when the action is no
 * longer a prompt).
 */
function updateDependenciesField(state: FormState): {
  dependencies?: AutomationDependencies | null;
} {
  if (state.pipelineDependencies === undefined) return {};
  const pipelines = savedPipelineDependencies(state);
  return { dependencies: pipelines.length > 0 ? { pipelines } : null };
}

export function emptyFormState(): FormState {
  return {
    installed: false,
    mode: 'create',
    name: '',
    enabled: true,
    triggerKind: 'cron',
    cronExpression: '0 9 * * *',
    oneTimeDate: '',
    oneTimeTime: '',
    actionType: 'app_advisor_prompt',
    prompt: '',
    workspaceId: '',
    baseWorktreeId: '',
    existingWorktreeId: '',
    workEntryId: '',
    sidebarGroupName: '',
    baseBranch: '',
    model: undefined,
    thinkingLevel: undefined,
    fastMode: undefined,
    plugins: [],
    pluginSelections: emptyPluginSelections(),
    planMode: undefined,
    interfaceMode: '',
    pipelineId: '',
    pipelineName: '',
    pipelineSource: undefined,
    projectPipelineFilename: '',
    sharedPipeline: undefined,
    repoId: '',
    pipelineInputs: [],
    pluginCollectionPreferences: undefined,
    modelAliasPreferences: undefined,
    pipelineModelAliases: undefined,
    pipelinePluginCollectionIds: undefined,
    modelConfig: undefined,
    chatProjectId: '',
    chatAuthoredPayload: false,
    ifCommand: '',
    pipelineTargetKind: 'new_worktree',
    pipelineTaskId: '',
    pipelineTargetExplicit: false,
  };
}

/** The destination fields a saved pipeline action loads as. */
function pipelineTargetFormFields(
  action: AutomationAction,
): Pick<
  FormState,
  'pipelineTargetKind' | 'pipelineTaskId' | 'pipelineTargetExplicit'
> {
  const resolved =
    action.type === 'worktree_pipeline'
      ? resolveAutomationPipelineTarget(action)
      : null;
  if (!resolved)
    return {
      pipelineTargetKind: 'new_worktree',
      pipelineTaskId: '',
      pipelineTargetExplicit: false,
    };
  return {
    pipelineTargetKind: resolved.kind,
    pipelineTaskId: resolved.kind === 'task' ? resolved.taskId : '',
    pipelineTargetExplicit:
      resolved.kind !== 'new_worktree' || resolved.explicit,
  };
}

export function activityToFormState(activity: ScheduledActivity): FormState {
  const base: FormState = {
    targetRequirement: activity.targetRequirement,
    ...(activity.dependencies
      ? { pipelineDependencies: activity.dependencies.pipelines }
      : {}),
    installed: activity.installedFrom !== undefined,
    mode: 'edit',
    id: activity.id,
    name: activity.name,
    enabled: activity.enabled,
    triggerKind: activity.schedule.kind,
    cronExpression:
      activity.schedule.kind === 'cron' ? activity.schedule.expression : '',
    oneTimeDate: '',
    oneTimeTime: '',
    actionType: activity.action.type,
    prompt:
      activity.action.type === 'worktree_pipeline' ||
      activity.action.type === 'pipeline_execution_resume'
        ? ''
        : (activity.action.prompt ?? ''),
    workspaceId:
      activity.action.type === 'worktree_prompt'
        ? activity.action.workspaceId
        : activity.action.type === 'worktree_pipeline'
          ? (pipelineAutomationWorkspaceId(activity.action) ?? '')
          : '',
    baseWorktreeId:
      (activity.action.type === 'worktree_prompt' ||
        activity.action.type === 'worktree_pipeline') &&
      activity.action.baseWorktreeId
        ? activity.action.baseWorktreeId
        : '',
    existingWorktreeId:
      activity.action.type === 'worktree_prompt' &&
      activity.action.existingWorktreeId
        ? activity.action.existingWorktreeId
        : '',
    workEntryId:
      (activity.action.type === 'app_advisor_prompt' ||
        activity.action.type === 'standalone_prompt') &&
      activity.action.workEntryId
        ? activity.action.workEntryId
        : '',
    sidebarGroupName:
      activity.action.type === 'app_advisor_prompt' ||
      activity.action.type === 'standalone_prompt' ||
      activity.action.type === 'worktree_prompt'
        ? (activity.action.sidebarGroupName ?? '')
        : '',
    baseBranch:
      activity.action.type === 'worktree_prompt' && activity.action.baseBranch
        ? activity.action.baseBranch
        : '',
    model:
      activity.action.type === 'app_advisor_prompt' ||
      activity.action.type === 'standalone_prompt' ||
      activity.action.type === 'worktree_prompt' ||
      activity.action.type === 'worktree_session_prompt'
        ? activity.action.model
        : undefined,
    thinkingLevel:
      activity.action.type === 'app_advisor_prompt' ||
      activity.action.type === 'standalone_prompt' ||
      activity.action.type === 'worktree_prompt' ||
      activity.action.type === 'worktree_session_prompt'
        ? (activity.action.modelConfig?.thinkingLevel ??
          ('thinking' in activity.action
            ? activity.action.thinking
            : undefined))
        : undefined,
    fastMode:
      activity.action.type === 'app_advisor_prompt' ||
      activity.action.type === 'standalone_prompt' ||
      activity.action.type === 'worktree_prompt' ||
      activity.action.type === 'worktree_session_prompt'
        ? activity.action.modelConfig?.fastMode
        : undefined,
    plugins:
      activity.action.type === 'app_advisor_prompt' ||
      activity.action.type === 'standalone_prompt' ||
      activity.action.type === 'worktree_prompt' ||
      activity.action.type === 'worktree_session_prompt'
        ? (activity.action.plugins ?? [])
        : [],
    pluginSelections:
      activity.action.type === 'app_advisor_prompt' ||
      activity.action.type === 'standalone_prompt' ||
      activity.action.type === 'worktree_prompt' ||
      activity.action.type === 'worktree_session_prompt'
        ? (activity.action.pluginSelections ?? emptyPluginSelections())
        : emptyPluginSelections(),
    planMode:
      'planMode' in activity.action ? activity.action.planMode : undefined,
    approvalMode:
      'approvalMode' in activity.action
        ? activity.action.approvalMode
        : undefined,
    promptReferences:
      'promptReferences' in activity.action
        ? activity.action.promptReferences
        : undefined,
    chatModelConfig:
      'model' in activity.action || 'prompt' in activity.action
        ? activity.action.modelConfig
        : undefined,
    interfaceMode:
      activity.action.type === 'worktree_prompt'
        ? (activity.action.interfaceMode ?? '')
        : '',
    pipelineId:
      activity.action.type === 'worktree_pipeline'
        ? activity.action.pipelineId
        : '',
    pipelineName:
      activity.action.type === 'worktree_pipeline'
        ? (activity.action.pipelineName ?? activity.action.pipelineId)
        : '',
    pipelineSource:
      activity.action.type === 'worktree_pipeline'
        ? activity.action.pipelineSource
        : undefined,
    projectPipelineFilename:
      activity.action.type === 'worktree_pipeline'
        ? (activity.action.projectPipelineFilename ?? '')
        : '',
    sharedPipeline:
      activity.action.type === 'worktree_pipeline'
        ? activity.action.sharedPipeline
        : undefined,
    repoId:
      activity.action.type === 'worktree_pipeline'
        ? (activity.action.repoId ?? '')
        : '',
    pipelineInputs:
      activity.action.type === 'worktree_pipeline' && activity.action.inputs
        ? Object.entries(activity.action.inputs).map(([key, value]) => ({
            key,
            value,
          }))
        : [],
    pluginCollectionPreferences:
      activity.action.type === 'worktree_pipeline'
        ? activity.action.pluginCollectionPreferences
        : undefined,
    modelAliasPreferences:
      activity.action.type === 'worktree_pipeline'
        ? activity.action.modelAliasPreferences
        : undefined,
    pipelineModelAliases: undefined,
    pipelinePluginCollectionIds: undefined,
    modelConfig:
      activity.action.type === 'worktree_pipeline'
        ? activity.action.modelConfig
        : undefined,
    chatProjectId:
      activity.action.type === 'standalone_prompt'
        ? activity.action.chatProjectId
        : '',
    chatAuthoredPayload:
      activity.action.type === 'worktree_session_prompt' &&
      (activity.action.purpose !== undefined ||
        (activity.action.attachmentPaths?.length ?? 0) > 0 ||
        (activity.action.fileReferences?.length ?? 0) > 0),
    ifCommand: activity.ifCommand ?? '',
    ...pipelineTargetFormFields(activity.action),
    ...(activity.executionContext !== undefined
      ? { executionContext: activity.executionContext }
      : {}),
    ...(activity.action.type === 'worktree_session_prompt'
      ? {
          worktreeSessionTarget: {
            workspaceId: activity.action.workspaceId,
            worktreeId: activity.action.worktreeId,
            chatId: activity.action.chatId,
            ...(activity.action.workspaceName
              ? { workspaceName: activity.action.workspaceName }
              : {}),
            ...(activity.action.worktreeName
              ? { worktreeName: activity.action.worktreeName }
              : {}),
            ...(activity.action.chatTitle
              ? { chatTitle: activity.action.chatTitle }
              : {}),
          },
          ...(activity.action.fileReferences
            ? { fileReferences: activity.action.fileReferences }
            : {}),
          ...(activity.action.attachmentPaths
            ? { attachmentPaths: activity.action.attachmentPaths }
            : {}),
          ...(activity.action.attachmentPromptContexts
            ? {
                attachmentPromptContexts:
                  activity.action.attachmentPromptContexts,
              }
            : {}),
          ...(activity.action.inputMode
            ? { inputMode: activity.action.inputMode }
            : { inputMode: 'typed' as const }),
          ...(activity.action.purpose
            ? { purpose: activity.action.purpose }
            : {}),
        }
      : {}),
  };
  if (activity.schedule.kind === 'one_time') {
    const runAt = new Date(activity.schedule.runAt);
    if (!Number.isNaN(runAt.getTime())) {
      const yyyy = runAt.getFullYear().toString().padStart(4, '0');
      const mm = (runAt.getMonth() + 1).toString().padStart(2, '0');
      const dd = runAt.getDate().toString().padStart(2, '0');
      const hh = runAt.getHours().toString().padStart(2, '0');
      const mi = runAt.getMinutes().toString().padStart(2, '0');
      base.oneTimeDate = `${yyyy}-${mm}-${dd}`;
      base.oneTimeTime = `${hh}:${mi}`;
    }
  }
  return base;
}

export function buildTrigger(state: FormState): {
  trigger?: AutomationTrigger;
  error?: string;
} {
  if (state.triggerKind === 'cron') {
    const trigger: AutomationTrigger = {
      kind: 'cron',
      expression: state.cronExpression.trim(),
      timezone: 'local',
    };
    const error = validateAutomationTrigger(trigger);
    return error ? { error: formatCronValidationError(error) } : { trigger };
  }
  if (!state.oneTimeDate || !state.oneTimeTime) {
    return {
      error: 'Pick a date and time for the one-time trigger.',
    };
  }
  const iso = `${state.oneTimeDate}T${state.oneTimeTime}:00`;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    return { error: 'Choose a valid date and time.' };
  }
  if (dt.getTime() <= Date.now()) {
    return { error: 'Choose a future time.' };
  }
  return {
    trigger: { kind: 'one_time', runAt: dt.toISOString(), timezone: 'local' },
  };
}

/**
 * Map a wire action type onto the top-level action selector. Returns
 * `undefined` for the edit-only variants (`worktree_session_prompt`,
 * `pipeline_execution_resume`) that the selector never represents.
 */
export function actionCategoryForType(
  actionType: ActionType,
): ActionCategory | undefined {
  if (actionType === 'app_advisor_prompt') return 'app_advisor';
  if (
    actionType === 'worktree_prompt' ||
    actionType === 'worktree_pipeline' ||
    actionType === 'standalone_prompt'
  ) {
    return 'workspace';
  }
  return undefined;
}

/** Chat vs Pipeline mode implied by a workspace-category wire action type. */
export function workspaceActionModeForType(
  actionType: ActionType,
): WorkspaceActionMode {
  return actionType === 'worktree_pipeline' ? 'pipeline' : 'chat';
}

/**
 * True for a `worktree_session_prompt` that continues an App Advisor chat
 * (or is still picking one). Those belong to the App Advisor target.
 */
export function isAppAdvisorSessionPrompt(state: FormState): boolean {
  return (
    state.actionType === 'worktree_session_prompt' &&
    state.worktreeSessionTarget?.workspaceId === APP_ADVISOR_PROJECT_ID
  );
}

/**
 * Action-aware replacement for {@link actionCategoryForType}. A
 * `worktree_session_prompt` belongs to whichever target owns its chat: App
 * Advisor for App Advisor Work Entries, Project otherwise.
 */
export function automationFormActionCategory(
  state: FormState,
): ActionCategory | undefined {
  if (state.actionType === 'worktree_session_prompt') {
    return isAppAdvisorSessionPrompt(state) ? 'app_advisor' : 'workspace';
  }
  if (
    state.actionType === 'worktree_pipeline' &&
    state.pipelineTargetKind === 'global'
  ) {
    return 'global';
  }
  return actionCategoryForType(state.actionType);
}

/**
 * The Run-in mode the current form state expresses. Deliberately mirrors the
 * shared `getAutomationChatRunMode` derivation, but reads form state — which
 * has no assembled action yet — so the selector stays live mid-edit. The
 * `AutomationsPage` test pins the two in agreement across every variant.
 */
export function automationFormChatRunMode(
  state: FormState,
): AutomationChatRunMode | undefined {
  switch (state.actionType) {
    case 'app_advisor_prompt':
    case 'standalone_prompt':
      return state.workEntryId ? 'existing_chat' : 'new_chat';
    case 'worktree_prompt':
      return state.existingWorktreeId ? 'existing_chat' : 'new_chat';
    case 'worktree_session_prompt':
      return 'existing_chat';
    default:
      return undefined;
  }
}

/**
 * The "Existing chat" destination the form state expresses, in the picker's
 * shape: a specific chat, or `chatId: ''` for a new chat in an existing
 * worktree / Work Entry. `undefined` when the form targets no existing
 * container.
 */
export function automationFormChatTarget(
  state: FormState,
): WorktreeSessionTarget | undefined {
  switch (state.actionType) {
    case 'worktree_session_prompt':
      return state.worktreeSessionTarget;
    case 'worktree_prompt':
      return state.existingWorktreeId
        ? {
            workspaceId: state.workspaceId,
            worktreeId: state.existingWorktreeId,
            chatId: '',
          }
        : undefined;
    case 'standalone_prompt':
      return state.workEntryId
        ? {
            workspaceId: state.chatProjectId,
            worktreeId: state.workEntryId,
            chatId: '',
          }
        : undefined;
    case 'app_advisor_prompt':
      return state.workEntryId
        ? {
            workspaceId: APP_ADVISOR_PROJECT_ID,
            worktreeId: state.workEntryId,
            chatId: '',
          }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Apply an "Existing chat" destination to the form. A specific chat continues
 * it (`worktree_session_prompt`); "New chat" (`chatId: ''`) opens a new chat
 * each run in the chosen container through the new-chat action of its kind
 * (`worktree_prompt.existingWorktreeId`, or `workEntryId` on
 * `standalone_prompt` / `app_advisor_prompt`). A missing container parks a
 * container-less session target so the picker stays scoped to `workspaceId`;
 * `buildAction` refuses to serialize it.
 *
 * `workspaceId` is the picker scope: a project id, or `APP_ADVISOR_PROJECT_ID`.
 * App Advisor destinations leave the project fields alone so a round trip
 * through the App Advisor target can restore the selected project.
 */
export function applyChatTargetSelection(
  state: FormState,
  workspaceId: string,
  isCowork: boolean,
  target: WorktreeSessionTarget | undefined,
): FormState {
  const isAppAdvisor = workspaceId === APP_ADVISOR_PROJECT_ID;
  const cleared: FormState = {
    ...state,
    existingWorktreeId: '',
    workEntryId: '',
    worktreeSessionTarget: undefined,
    ...(isAppAdvisor ? {} : { workspaceId: '', chatProjectId: '' }),
  };
  if (!target?.worktreeId || target.chatId) {
    return {
      ...cleared,
      actionType: 'worktree_session_prompt',
      worktreeSessionTarget: target?.worktreeId
        ? target
        : workspaceId
          ? { workspaceId, worktreeId: '', chatId: '' }
          : undefined,
    };
  }
  if (isAppAdvisor) {
    return {
      ...cleared,
      actionType: 'app_advisor_prompt',
      workEntryId: target.worktreeId,
    };
  }
  if (isCowork) {
    return {
      ...cleared,
      actionType: 'standalone_prompt',
      chatProjectId: workspaceId,
      workEntryId: target.worktreeId,
    };
  }
  return {
    ...cleared,
    actionType: 'worktree_prompt',
    workspaceId,
    existingWorktreeId: target.worktreeId,
    // Provisioning sources are mutually exclusive with an existing worktree.
    baseWorktreeId: '',
    baseBranch: '',
  };
}

/**
 * Flip the Run-in mode of the App Advisor target. "New chat each run" creates
 * a Work Entry per run; "Existing chat" starts with no Work Entry picked.
 */
export function applyAppAdvisorRunModeSelection(
  state: FormState,
  runMode: AutomationChatRunMode,
): FormState {
  if (
    automationFormActionCategory(state) === 'app_advisor' &&
    automationFormChatRunMode(state) === runMode
  ) {
    return state;
  }
  if (runMode === 'existing_chat') {
    return applyChatTargetSelection(
      state,
      APP_ADVISOR_PROJECT_ID,
      false,
      undefined,
    );
  }
  return {
    ...state,
    actionType: 'app_advisor_prompt',
    existingWorktreeId: '',
    workEntryId: '',
    worktreeSessionTarget:
      state.worktreeSessionTarget?.workspaceId === APP_ADVISOR_PROJECT_ID
        ? undefined
        : state.worktreeSessionTarget,
  };
}

/**
 * Change the form target to App Advisor. Sidebar groups are scoped separately
 * from project workspaces, so a project group's label must not carry across.
 */
export function applyAppAdvisorActionCategorySelection(
  state: FormState,
  runMode: AutomationChatRunMode,
): FormState {
  return applyAppAdvisorRunModeSelection(
    {
      ...state,
      actionType: 'app_advisor_prompt',
      existingWorktreeId: '',
      workEntryId: '',
      sidebarGroupName: '',
    },
    runMode,
  );
}

/**
 * True when the session prompt's payload was authored from the chat composer
 * or the usage-limit banner rather than this form. Those edits belong in the
 * target chat's queued-message UI, so prompt + attachments stay read-only —
 * but the Run-in selector and destination picker remain editable, which is
 * what lets an existing automation be re-pointed without recreating it.
 */
export function hasChatAuthoredPayload(state: FormState): boolean {
  return state.chatAuthoredPayload;
}

/**
 * The workspace a workspace-category form state targets. `standalone_prompt`
 * stores the cowork workspace id in `chatProjectId` (cowork workspaces ARE
 * the standalone chat projects); `worktree_session_prompt` carries it on the
 * session target; the worktree actions use `workspaceId`.
 */
export function selectedAutomationWorkspaceId(state: FormState): string {
  if (state.actionType === 'standalone_prompt') return state.chatProjectId;
  if (state.actionType === 'worktree_session_prompt') {
    return state.worktreeSessionTarget?.workspaceId ?? '';
  }
  return state.workspaceId;
}

/**
 * Sidebar group scope that new containers created by this form state join;
 * undefined when the action does not create a new prompt container or has no
 * selected project/workspace.
 */
export function automationFormSidebarGroupScope(
  state: FormState,
): SidebarItemGroupScope | undefined {
  switch (state.actionType) {
    case 'app_advisor_prompt':
      return state.workEntryId ? undefined : { appAdvisor: true };
    case 'worktree_prompt':
      // A worktree branched from a base worktree joins that worktree's branch
      // stack, and stack children follow their root instead of joining groups.
      return state.existingWorktreeId ||
        state.baseWorktreeId ||
        !state.workspaceId
        ? undefined
        : { workspaceLocalId: state.workspaceId };
    case 'standalone_prompt':
      return state.workEntryId || !state.chatProjectId
        ? undefined
        : { workspaceLocalId: state.chatProjectId };
    default:
      return undefined;
  }
}

export function clearedPipelineSelection(): Pick<
  FormState,
  | 'pipelineId'
  | 'pipelineName'
  | 'pipelineSource'
  | 'projectPipelineFilename'
  | 'sharedPipeline'
  | 'repoId'
  | 'pipelineInputs'
  | 'pluginCollectionPreferences'
  | 'modelAliasPreferences'
  | 'pipelineModelAliases'
  | 'pipelinePluginCollectionIds'
  | 'modelConfig'
> {
  return {
    pipelineId: '',
    pipelineName: '',
    pipelineSource: undefined,
    projectPipelineFilename: '',
    sharedPipeline: undefined,
    repoId: '',
    pipelineInputs: [],
    pluginCollectionPreferences: undefined,
    modelAliasPreferences: undefined,
    pipelineModelAliases: undefined,
    pipelinePluginCollectionIds: undefined,
    modelConfig: undefined,
  };
}

/**
 * Re-derive the wire action type from a workspace + Chat/Pipeline mode
 * selection and store the workspace id in the field the derived type reads
 * (`chatProjectId` for `standalone_prompt`, `workspaceId` otherwise).
 *
 * `selected` is the resolved workspace (or `null` when nothing is selected or
 * the stored id no longer resolves to a sidebar workspace). Changing the
 * workspace clears the base-worktree and pipeline configuration — both are
 * scoped to the previous workspace — while a pure mode toggle preserves them
 * so flipping Chat/Pipeline is non-destructive.
 */
export function applyWorkspaceActionSelection(
  state: FormState,
  mode: WorkspaceActionMode,
  selected: { id: string; isCowork: boolean } | null,
  runMode: AutomationChatRunMode = automationFormChatRunMode(state) ??
    'new_chat',
): FormState {
  const isCowork = selected?.isCowork === true;
  const selectedId = selected?.id ?? '';
  const previousId = selectedAutomationWorkspaceId(state);
  const workspaceChanged = selectedId !== previousId;
  const workspaceScopedReset: Partial<FormState> = {
    ...(workspaceChanged
      ? { baseWorktreeId: '', baseBranch: '', ...clearedPipelineSelection() }
      : {}),
    ...(workspaceChanged || automationFormActionCategory(state) !== 'workspace'
      ? { sidebarGroupName: '' }
      : {}),
  };
  if (mode === 'chat' && runMode === 'existing_chat') {
    // A worktree / Work Entry / chat destination is workspace-scoped, so a
    // workspace switch drops it rather than saving an automation that
    // deterministically fails at dispatch. The workspace-only target that
    // replaces it keeps the Project select populated while the user picks the
    // rest.
    const preserved =
      !workspaceChanged && automationFormActionCategory(state) === 'workspace'
        ? automationFormChatTarget(state)
        : undefined;
    return {
      ...applyChatTargetSelection(state, selectedId, isCowork, preserved),
      ...workspaceScopedReset,
    };
  }
  const actionType: ActionType =
    mode === 'pipeline'
      ? 'worktree_pipeline'
      : isCowork
        ? 'standalone_prompt'
        : 'worktree_prompt';
  return {
    ...state,
    actionType,
    workspaceId: actionType === 'standalone_prompt' ? '' : selectedId,
    chatProjectId: actionType === 'standalone_prompt' ? selectedId : '',
    worktreeSessionTarget: undefined,
    existingWorktreeId: '',
    workEntryId: '',
    ...workspaceScopedReset,
    ...projectPipelineTarget(state, workspaceChanged, isCowork),
  };
}

/**
 * The pipeline destination once a project is (re)selected. A task belongs to
 * one project, so a project change drops it. Leaving "No project" restores
 * the default project destination (no saved `target`), which adapts to the
 * project kind; an explicit new worktree each run never applies to a cowork
 * project, so it becomes the project folder.
 */
function projectPipelineTarget(
  state: FormState,
  workspaceChanged: boolean,
  isCowork: boolean,
): Pick<
  FormState,
  'pipelineTargetKind' | 'pipelineTaskId' | 'pipelineTargetExplicit'
> {
  const kind = state.pipelineTargetKind;
  if (kind === 'global')
    return {
      pipelineTargetKind: 'new_worktree',
      pipelineTaskId: '',
      pipelineTargetExplicit: false,
    };
  if (kind === 'new_worktree' && isCowork && state.pipelineTargetExplicit)
    return {
      pipelineTargetKind: 'project',
      pipelineTaskId: '',
      pipelineTargetExplicit: true,
    };
  return {
    pipelineTargetKind: kind,
    pipelineTaskId: workspaceChanged ? '' : state.pipelineTaskId,
    pipelineTargetExplicit: state.pipelineTargetExplicit,
  };
}

/**
 * Change the form target to a pipeline with no project. Project-only fields
 * are cleared (the project, base worktree, repository, and run restriction),
 * and so is a project pipeline, which needs a project. Name, schedule, and a
 * pipeline that can run anywhere carry over.
 */
export function applyGlobalPipelineSelection(state: FormState): FormState {
  const projectPipeline = state.pipelineSource === 'project';
  return {
    ...state,
    actionType: 'worktree_pipeline',
    pipelineTargetKind: 'global',
    pipelineTaskId: '',
    pipelineTargetExplicit: true,
    workspaceId: '',
    chatProjectId: '',
    worktreeSessionTarget: undefined,
    existingWorktreeId: '',
    workEntryId: '',
    baseWorktreeId: '',
    baseBranch: '',
    sidebarGroupName: '',
    targetRequirement: undefined,
    ...(projectPipeline
      ? clearedPipelineSelection()
      : { repoId: '', projectPipelineFilename: '' }),
  };
}

/**
 * Choose where a pipeline on a project runs. Choosing makes the destination
 * explicit, except re-choosing what a legacy action already does.
 */
export function applyPipelineRunInSelection(
  state: FormState,
  kind: Exclude<AutomationPipelineTargetKind, 'global'>,
  displayed: Exclude<AutomationPipelineTargetKind, 'global'>,
): FormState {
  if (kind === displayed) return state;
  return {
    ...state,
    pipelineTargetKind: kind,
    pipelineTargetExplicit: true,
    pipelineTaskId: kind === 'task' ? state.pipelineTaskId : '',
    // A base worktree only seeds a new worktree each run.
    ...(kind === 'new_worktree' ? {} : { baseWorktreeId: '', baseBranch: '' }),
  };
}

/**
 * The destination a pipeline on a project displays. A legacy action runs in
 * the project folder on a cowork project and in a new worktree otherwise.
 */
export function displayedPipelineRunIn(
  state: Pick<FormState, 'pipelineTargetKind' | 'pipelineTargetExplicit'>,
  isCowork: boolean,
): Exclude<AutomationPipelineTargetKind, 'global'> {
  const kind = state.pipelineTargetKind;
  if (kind === 'global') return isCowork ? 'project' : 'new_worktree';
  if (!state.pipelineTargetExplicit && isCowork) return 'project';
  return kind;
}

/**
 * Flip the Run-in mode without losing the rest of the form (CAN-2937 §4.5).
 *
 * Explicit chat settings stay in FormState across mode switches. Existing
 * chats inherit live settings for fields the user has not configured; an
 * explicit override is applied by the canonical runtime dispatch.
 *
 * Name, enabled, trigger, `ifCommand`, prompt, and the selected workspace all
 * survive in both directions. Attachments and file references remain in form
 * state so the chat-authored read-only gate survives the toggle, but
 * `buildAction` deliberately omits them from `new_chat` wire actions. The form
 * warns inline before save.
 */
export function applyChatRunModeSelection(
  state: FormState,
  runMode: AutomationChatRunMode,
  selected: { id: string; isCowork: boolean } | null,
): FormState {
  if (automationFormChatRunMode(state) === runMode) return state;
  return applyWorkspaceActionSelection(state, 'chat', selected, runMode);
}

function buildPromptChatSettings(
  state: FormState,
): Partial<
  Pick<
    PromptAction,
    | 'model'
    | 'modelConfig'
    | 'plugins'
    | 'pluginSelections'
    | 'planMode'
    | 'approvalMode'
  >
> {
  // One canonical record: an exact speed always wins over the form's legacy
  // boolean, and both are written together.
  const modelConfig = canonicalizeAgentModelConfig({
    ...state.chatModelConfig,
    ...(state.thinkingLevel !== undefined
      ? { thinkingLevel: state.thinkingLevel }
      : {}),
    ...(state.fastMode !== undefined ? { fastMode: state.fastMode } : {}),
  });
  return {
    ...(state.model ? { model: state.model } : {}),
    ...(Object.keys(modelConfig).length ? { modelConfig } : {}),
    ...(state.planMode !== undefined ? { planMode: state.planMode } : {}),
    ...(state.approvalMode !== undefined
      ? { approvalMode: state.approvalMode }
      : {}),
    ...(state.plugins.length > 0 ? { plugins: state.plugins } : {}),
    ...(hasAnySelections(state.pluginSelections)
      ? { pluginSelections: state.pluginSelections }
      : {}),
  };
}

/**
 * One string field of a stored model alias preference. Preferences arrive as
 * `Record<string, unknown>` on the action, so each field is read defensively.
 */
function modelAliasPreferenceField(
  preference: unknown,
  key: 'mode' | 'base' | 'plugin_collection_id' | 'agent_id',
): string | undefined {
  if (typeof preference !== 'object' || preference === null) return undefined;
  const value: unknown = Object.entries(preference).find(
    ([entryKey]) => entryKey === key,
  )?.[1];
  return typeof value === 'string' ? value : undefined;
}

/** The reason the picked pipeline's model aliases block a save, if any. */
export function getPipelineModelAliasBlockingError(
  state: FormState,
): string | undefined {
  if (
    state.actionType !== 'worktree_pipeline' ||
    !state.pipelineModelAliases ||
    state.pipelineModelAliases.length === 0
  ) {
    return undefined;
  }

  const preferences = state.modelAliasPreferences;
  const pluginCollectionIds = new Set(state.pipelinePluginCollectionIds ?? []);

  for (const alias of state.pipelineModelAliases) {
    const preference: unknown = preferences?.[alias.id];
    const mode = modelAliasPreferenceField(preference, 'mode');
    const label = alias.name || alias.id;
    if (!alias.defaults && (!preference || mode === 'reset')) {
      return `Configure the ${label} model alias before saving this automation.`;
    }
    if (!preference || mode === 'reset') {
      continue;
    }
    if (mode === 'inline') {
      const base = modelAliasPreferenceField(preference, 'base');
      if (!base || base.trim().length === 0) {
        return `Configure the ${label} model alias before saving this automation.`;
      }
      const pluginCollectionId = modelAliasPreferenceField(
        preference,
        'plugin_collection_id',
      );
      if (pluginCollectionId && !pluginCollectionIds.has(pluginCollectionId)) {
        return `Choose an existing plugin collection for the ${label} model alias.`;
      }
      continue;
    }
    const agentId = modelAliasPreferenceField(preference, 'agent_id');
    if (mode === 'agent' && (!agentId || agentId.trim().length === 0)) {
      return `Choose an agent for the ${label} model alias before saving this automation.`;
    }
  }

  return undefined;
}

function getFilteredModelAliasPreferences(
  state: FormState,
): WorktreePipelineAction['modelAliasPreferences'] {
  if (!state.modelAliasPreferences || !state.pipelineModelAliases) {
    return state.modelAliasPreferences;
  }
  const aliasIds = new Set(state.pipelineModelAliases.map((alias) => alias.id));
  const filtered = Object.fromEntries(
    Object.entries(state.modelAliasPreferences).filter(([aliasId]) =>
      aliasIds.has(aliasId),
    ),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function buildAction(state: FormState): {
  action?: AutomationAction;
  error?: string;
} {
  const prompt = state.prompt.trim();
  const normalizedSidebarGroupName = normalizeSidebarItemGroupName(
    state.sidebarGroupName,
  );
  const referenceError = validateConfiguredPromptReferences(
    state.prompt,
    state.promptReferences,
  );
  if (
    referenceError &&
    state.actionType !== 'worktree_pipeline' &&
    state.actionType !== 'pipeline_execution_resume'
  )
    return { error: referenceError };
  const promptReferences = state.promptReferences?.map((ref) => ({
    ...ref,
    textStart:
      ref.textStart - (state.prompt.length - state.prompt.trimStart().length),
  }));
  const referencePayload = promptReferences?.length ? { promptReferences } : {};
  switch (state.actionType) {
    case 'app_advisor_prompt':
      if (!prompt)
        return { error: `Enter a prompt for ${ORCHESTRATOR_LABEL}.` };
      return {
        action: {
          type: 'app_advisor_prompt',
          ...(state.workEntryId ? { workEntryId: state.workEntryId } : {}),
          ...(!state.workEntryId && normalizedSidebarGroupName
            ? { sidebarGroupName: normalizedSidebarGroupName }
            : {}),
          prompt,
          ...buildPromptChatSettings(state),
          ...referencePayload,
        },
      };
    case 'standalone_prompt':
      if (!state.chatProjectId) return { error: 'Pick a project.' };
      if (!prompt)
        return { error: `Enter a prompt for the ${CHAT_LABEL} chat.` };
      return {
        action: {
          type: 'standalone_prompt',
          chatProjectId: state.chatProjectId,
          ...(state.workEntryId ? { workEntryId: state.workEntryId } : {}),
          ...(!state.workEntryId && normalizedSidebarGroupName
            ? { sidebarGroupName: normalizedSidebarGroupName }
            : {}),
          prompt,
          ...buildPromptChatSettings(state),
          ...referencePayload,
        },
      };
    case 'worktree_prompt':
      if (!state.workspaceId) return { error: 'Pick a project.' };
      if (!prompt) return { error: 'Enter a prompt for the worktree chat.' };
      return {
        action: {
          type: 'worktree_prompt',
          workspaceId: state.workspaceId,
          // Provisioning modes are mutually exclusive: an existing-worktree
          // target wins over any stale source selection.
          ...(state.existingWorktreeId
            ? { existingWorktreeId: state.existingWorktreeId }
            : state.baseWorktreeId
              ? { baseWorktreeId: state.baseWorktreeId }
              : state.baseBranch
                ? { baseBranch: state.baseBranch }
                : {}),
          ...(!state.existingWorktreeId &&
          !state.baseWorktreeId &&
          normalizedSidebarGroupName
            ? { sidebarGroupName: normalizedSidebarGroupName }
            : {}),
          prompt,
          ...buildPromptChatSettings(state),
          ...referencePayload,
          ...(state.interfaceMode
            ? { interfaceMode: state.interfaceMode }
            : {}),
        },
      };
    case 'worktree_pipeline': {
      const global = state.pipelineTargetKind === 'global';
      if (!global && !state.workspaceId) return { error: 'Pick a project.' };
      if (
        state.pipelineTargetKind === 'task' &&
        state.pipelineTargetExplicit &&
        !state.pipelineTaskId
      )
        return { error: AUTOMATION_PIPELINE_TASK_REQUIRED_ERROR };
      if (!state.pipelineId) return { error: 'Pick a workflow to run.' };
      if (global && state.pipelineSource === 'project')
        return { error: PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR };
      {
        const modelAliasError = getPipelineModelAliasBlockingError(state);
        if (modelAliasError) return { error: modelAliasError };
      }
      {
        const modelAliasPreferences = getFilteredModelAliasPreferences(state);
        // A base worktree only seeds a new worktree each run.
        const seedsWorktree = state.pipelineTargetKind === 'new_worktree';
        return {
          action: {
            type: 'worktree_pipeline',
            ...pipelineTargetPayload(state),
            pipelineId: state.pipelineId,
            ...(state.pipelineSource
              ? { pipelineSource: state.pipelineSource }
              : {}),
            ...(state.pipelineName ? { pipelineName: state.pipelineName } : {}),
            ...(state.projectPipelineFilename
              ? { projectPipelineFilename: state.projectPipelineFilename }
              : {}),
            ...(state.sharedPipeline
              ? { sharedPipeline: state.sharedPipeline }
              : {}),
            ...(seedsWorktree && state.baseWorktreeId
              ? { baseWorktreeId: state.baseWorktreeId }
              : {}),
            ...(!global && state.repoId ? { repoId: state.repoId } : {}),
            ...(state.pipelineInputs.length > 0
              ? {
                  inputs: Object.fromEntries(
                    state.pipelineInputs
                      .filter((row) => row.key.trim().length > 0)
                      .map((row) => [row.key.trim(), row.value]),
                  ),
                }
              : {}),
            ...(state.pluginCollectionPreferences
              ? {
                  pluginCollectionPreferences:
                    state.pluginCollectionPreferences,
                }
              : {}),
            ...(modelAliasPreferences ? { modelAliasPreferences } : {}),
            ...(state.modelConfig ? { modelConfig: state.modelConfig } : {}),
          },
        };
      }
    }
    case 'worktree_session_prompt':
      // The "Existing chat" Run-in mode (CAN-2937). `purpose` and the
      // attachment payload of a chat-composer-authored activity are preserved
      // verbatim; the form can re-point the target and edit the prompt.
      if (
        !state.worktreeSessionTarget?.worktreeId ||
        !state.worktreeSessionTarget.chatId
      ) {
        return { error: AUTOMATION_CHAT_TARGET_INCOMPLETE_ERROR };
      }
      return buildWorktreeSessionPromptAction({
        target: state.worktreeSessionTarget,
        prompt: state.prompt,
        ...(!hasChatAuthoredPayload(state)
          ? buildPromptChatSettings(state)
          : {}),
        ...(state.promptReferences?.length
          ? { promptReferences: state.promptReferences }
          : {}),
        ...(state.fileReferences
          ? { fileReferences: state.fileReferences }
          : {}),
        ...(state.attachmentPaths
          ? { attachmentPaths: state.attachmentPaths }
          : {}),
        ...(state.attachmentPromptContexts
          ? { attachmentPromptContexts: state.attachmentPromptContexts }
          : {}),
        ...(state.inputMode ? { inputMode: state.inputMode } : {}),
        ...(state.purpose ? { purpose: state.purpose } : {}),
      });
    case 'pipeline_execution_resume':
      return {
        error: 'Scheduled workflow resumes cannot be edited.',
      };
  }
}

export const AUTOMATION_PIPELINE_TASK_REQUIRED_ERROR =
  'Pick a task to run the workflow in.';

/**
 * The destination fields of a saved pipeline action. A pipeline with no
 * project omits `workspaceId`; an unchanged legacy action omits `target`.
 */
function pipelineTargetPayload(
  state: FormState,
): Pick<WorktreePipelineAction, 'target' | 'workspaceId'> {
  if (state.pipelineTargetKind === 'global')
    return { target: { kind: 'global' } };
  if (!state.pipelineTargetExplicit) return { workspaceId: state.workspaceId };
  return {
    workspaceId: state.workspaceId,
    target:
      state.pipelineTargetKind === 'task'
        ? { kind: 'task', taskId: state.pipelineTaskId }
        : { kind: state.pipelineTargetKind },
  };
}

/**
 * Shared-pipeline binding for a pipeline picked in the edit form. Re-picking
 * the same shared pipeline keeps the existing install pin, so content the
 * user never reviewed still hits the scheduler's pin check (and its review
 * flow) instead of silently running unpinned. A different pipeline starts
 * unpinned, matching a fresh selection.
 */
export function resolveRepickedSharedPipeline(
  previous: WorktreePipelineAction['sharedPipeline'],
  info: { source: string; serverId?: string; remoteId?: string },
): WorktreePipelineAction['sharedPipeline'] {
  if (info.source !== 'shared' || !info.serverId || !info.remoteId) {
    return undefined;
  }
  const next = { serverId: info.serverId, remoteId: info.remoteId };
  if (
    previous?.installPin &&
    previous.serverId === info.serverId &&
    previous.remoteId === info.remoteId
  ) {
    return { ...next, installPin: previous.installPin };
  }
  return next;
}

/**
 * A one-time trigger that has already fired successfully and has no upcoming
 * run left is moved out of the primary table into the collapsed
 * "Previously Triggered" section, so the active trigger list stays focused on
 * activities that can still run.
 */
export function isPreviouslyTriggeredOneTime(
  activity: ScheduledActivity,
  now = Date.now(),
): boolean {
  if (
    activity.schedule.kind !== 'one_time' ||
    activity.lastResult?.status !== 'success'
  ) {
    return false;
  }

  const nextRunAtMs = activity.nextRunAt ? Date.parse(activity.nextRunAt) : NaN;

  return !Number.isFinite(nextRunAtMs) || nextRunAtMs <= now;
}

/** A form field a failed save points at, so a host can reveal it. */
export type AutomationFormField =
  | 'cronExpression'
  | 'oneTimeDate'
  | 'oneTimeTime'
  | 'workspace'
  | 'prompt'
  | 'pipeline'
  | 'chatTarget';

/**
 * The editor section a field lives in. `trigger` holds the schedule, its
 * cron and one-time inputs and the If Command; everything else is
 * `definition`.
 */
export type AutomationFormSection = 'definition' | 'trigger';

export type AutomationMutationRequestResult =
  | { ok: true; mode: 'create'; request: AutomationCreateRequest }
  | { ok: true; mode: 'update'; request: AutomationUpdateRequest }
  | {
      ok: false;
      error: string;
      /** The first blocking field, when one can be named. */
      field?: AutomationFormField;
      section: AutomationFormSection;
    };

function triggerErrorField(state: FormState): AutomationFormField {
  if (state.triggerKind === 'cron') return 'cronExpression';
  if (!state.oneTimeDate) return 'oneTimeDate';
  if (!state.oneTimeTime) return 'oneTimeTime';
  return 'oneTimeDate';
}

/** The field behind `buildAction`'s error, checked in the same order. */
function actionErrorField(state: FormState): AutomationFormField | undefined {
  if (state.actionType === 'pipeline_execution_resume') return undefined;
  if (
    state.actionType !== 'worktree_pipeline' &&
    validateConfiguredPromptReferences(state.prompt, state.promptReferences)
  ) {
    return 'prompt';
  }
  switch (state.actionType) {
    case 'app_advisor_prompt':
      return 'prompt';
    case 'standalone_prompt':
      return state.chatProjectId ? 'prompt' : 'workspace';
    case 'worktree_prompt':
      return state.workspaceId ? 'prompt' : 'workspace';
    case 'worktree_pipeline':
      return state.pipelineTargetKind === 'global' || state.workspaceId
        ? 'pipeline'
        : 'workspace';
    case 'worktree_session_prompt':
      return !state.worktreeSessionTarget?.worktreeId ||
        !state.worktreeSessionTarget.chatId
        ? 'chatTarget'
        : 'prompt';
  }
  return undefined;
}

/**
 * The create or update request a form state saves as, or the first reason it
 * cannot be saved yet. Shared by every automation editor so they save the
 * same fields: a create carries the target requirement when one is set, and
 * an edit of an automation the user authored (not installed from a share)
 * always sends it, so clearing it is saved too.
 */
export function buildAutomationMutationRequest(
  state: FormState,
): AutomationMutationRequestResult {
  const triggerResult = buildTrigger(state);
  if (!triggerResult.trigger) {
    return {
      ok: false,
      error: triggerResult.error ?? 'Please complete the trigger fields.',
      field: triggerErrorField(state),
      section: 'trigger',
    };
  }
  const actionResult = buildAction(state);
  if (!actionResult.action) {
    const field = actionErrorField(state);
    return {
      ok: false,
      error: actionResult.error ?? 'Please complete the action.',
      ...(field ? { field } : {}),
      section: 'definition',
    };
  }
  if (state.mode === 'create') {
    return {
      ok: true,
      mode: 'create',
      request: {
        name: state.name.trim() || 'Untitled automation',
        schedule: triggerResult.trigger,
        action: actionResult.action,
        ...(state.targetRequirement
          ? { targetRequirement: state.targetRequirement }
          : {}),
        ...createDependenciesField(state),
        enabled: state.enabled,
        ...(state.ifCommand.trim()
          ? { ifCommand: state.ifCommand.trim() }
          : {}),
      },
    };
  }
  if (!state.id) {
    // `mode === 'edit'` always carries an id when set via
    // `activityToFormState`; refuse the impossible-but-typed `undefined`
    // instead of asserting.
    return {
      ok: false,
      error: 'This automation could not be saved. Close it and try again.',
      section: 'definition',
    };
  }
  return {
    ok: true,
    mode: 'update',
    request: {
      id: state.id,
      name: state.name.trim() || undefined,
      schedule: triggerResult.trigger,
      action: actionResult.action,
      ...(!state.installed
        ? { targetRequirement: state.targetRequirement ?? null }
        : {}),
      ...updateDependenciesField(state),
      enabled: state.enabled,
      ifCommand: state.ifCommand.trim(),
    },
  };
}

/** Sorted keys, `undefined` dropped, so equal values serialize equally. */
function stableSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSnapshotValue);
  if (typeof value !== 'object' || value === null) return value;
  const entries: Array<[string, unknown]> = Object.entries(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries.sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (entry !== undefined) out[key] = stableSnapshotValue(entry);
  }
  return out;
}

/**
 * A stable serialization of a form state for dirty checks: two states that
 * would save the same automation compare equal. Keys are sorted, `undefined`
 * and absent fields match, and representations the form treats as the same
 * value collapse: the chat model settings fold into the one record a save
 * writes, and empty prompt references and plugin selections match their
 * absence. The picked pipeline's alias and plugin collection metadata only
 * validate the selection and are never saved, so they are left out.
 */
export function automationFormSnapshot(state: FormState): string {
  const modelConfig = canonicalizeAgentModelConfig({
    ...state.chatModelConfig,
    ...(state.thinkingLevel !== undefined
      ? { thinkingLevel: state.thinkingLevel }
      : {}),
    ...(state.fastMode !== undefined ? { fastMode: state.fastMode } : {}),
  });
  return JSON.stringify(
    stableSnapshotValue({
      ...state,
      chatModelConfig: Object.keys(modelConfig).length
        ? modelConfig
        : undefined,
      thinkingLevel: undefined,
      fastMode: undefined,
      promptReferences: state.promptReferences?.length
        ? state.promptReferences
        : undefined,
      pluginSelections: hasAnySelections(state.pluginSelections)
        ? state.pluginSelections
        : undefined,
      pipelineModelAliases: undefined,
      pipelinePluginCollectionIds: undefined,
      pipelineDependencies: state.pipelineDependencies?.length
        ? state.pipelineDependencies
        : undefined,
    }),
  );
}

/**
 * The form state a new automation opens with. Without a seed it is a
 * pipeline workflow with no project; with one it targets the seed's project
 * in Chat mode, and a non-Cowork seed with a worktree opens in "Existing
 * chat" with a new chat on that worktree each run, instead of provisioning a
 * fresh one. A seed's name and prompt prefill those fields.
 */
export function automationDraftFromSeed(seed?: AutomationDraftSeed): FormState {
  if (!seed) return applyGlobalPipelineSelection(emptyFormState());
  const selected = applyWorkspaceActionSelection(emptyFormState(), 'chat', {
    id: seed.projectId,
    isCowork: seed.isCowork,
  });
  const state = {
    ...selected,
    ...(seed.name !== undefined ? { name: seed.name } : {}),
    ...(seed.prompt !== undefined ? { prompt: seed.prompt } : {}),
  };
  return !seed.isCowork && seed.existingWorktreeId
    ? { ...state, existingWorktreeId: seed.existingWorktreeId }
    : state;
}
