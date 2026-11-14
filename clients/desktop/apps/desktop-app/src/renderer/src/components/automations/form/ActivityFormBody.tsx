// The automation form's fields: name, enabled, trigger, If Command, target,
// prompt or pipeline, and the notices under them, plus the pipeline picker
// they open. Hosts draw the chrome around it: `ActivityFormPanel` puts it in
// a modal with a footer, and a full-page editor can mount one body per
// section (`fieldGroup`) over the same `FormState`.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import { AutomationAuthorTargetRequirement } from '@/components/automations/AutomationAuthorTargetRequirement';
import { usePipelineTaskList } from '@/components/automations/usePipelineTaskList';
import { ConfigurationChatComposer } from '@/components/shared/ConfigurationChatComposer';
import { resolveAutomationComposerContext } from '@/lib/configurationComposerTargets';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  AutomationTrigger,
  ChatInterfaceMode,
  MultiRepoSidebarItem,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import { emptyPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { canonicalizeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import {
  CHAT_UNIT_LABEL,
  ORCHESTRATOR_LABEL,
  WORKTREE_UNIT_LABEL,
} from '@canopy/protocol';
import { brandText } from '@/lib/brand';
import {
  AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAMES,
  AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAMES,
  AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES,
  createAutomationPromptVariableToken,
  formatCronValidationError,
  getAutomationChatRunModeLabel,
  getAutomationIfCommandVariableDefinitions,
  getNextAutomationTriggerRun,
  validateAutomationTrigger,
  type AutomationChatRunMode,
} from '@canopy/desktop-shared/lib/automations';
import type { PipelineData } from '@canopy/execution-engine/types/pipeline';
import type { useProjectsStore } from '@/stores/projectsStore';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { automationContextNoteMessage } from '@canopy/execution-engine/lib/automation-context-copy';
import type { WorktreeSessionTarget } from '@/components/automations/worktreeSessionPrompt';
import { AutomationSidebarGroupPicker } from '@/components/automations/AutomationSidebarGroupPicker';
import { AutomationPipelineDependenciesField } from './AutomationPipelineDependenciesField';
import {
  PipelineTriggerModal,
  type PipelinePluginCollectionRunContext,
  type PipelineRepoChoice,
} from '@/components/activity/PipelineTriggerModal';
import { usePipelineWorktreeContext } from '@/components/activity/usePipelineWorktreeContext';
import { BrandLogo } from '@/components/BrandLogo';
import { useClaudeTuiChatsEnabled } from '@/lib/claude-tui-chats';
import {
  AppAdvisorIcon,
  ChatIcon,
  PipelineIcon,
  TerminalBorderedIcon,
} from '@canopy/ui-shared/icons';
import type { AutomationScope } from '@/hooks/useAutomationScope';
import { ProjectIcon } from '@/components/shared/ProjectIcon';
import { Tooltip } from '@canopy/ui-shared';
import {
  Stack,
  AutomationPipelineTargetFields,
  Button,
  DateField,
  Disclosure,
  ErrorBanner,
  FORM_FIELD_LABEL_CLASS,
  FormField,
  type FormFieldControlProps,
  isAutomationPipelineTaskStale,
  Notice,
  NoticeButton,
  SegmentedControl as SharedSegmentedControl,
  Select,
  Surface,
  TextArea,
  TextInput,
  ToggleSwitch,
  FieldError,
  toIsoDateValue,
} from '@canopy/ui-shared/components';
import { buildTimeSlotOptions, passedTimeOn } from '@/lib/timeSlotOptions';
import { WORKFLOW_ITEM_LABEL } from '@canopy/ui-shared/lib/workflow-labels';
import { automationDestinationExecutionScope } from '@canopy/pipeline-interop/automation-target';
import type { AutomationTargetResolution } from '@canopy/pipeline-interop/automation-target';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '@/components/shared/SearchableSelect';
import {
  AutomationChatTargetPicker,
  AUTOMATION_CHAT_TARGET_INCOMPLETE_ERROR,
  AUTOMATION_CHAT_TARGET_UNAVAILABLE_ERROR,
  type AutomationChatTargetStatus,
} from '@/components/automations/AutomationChatTargetPicker';
import {
  applyAppAdvisorActionCategorySelection,
  applyAppAdvisorRunModeSelection,
  applyChatRunModeSelection,
  applyChatTargetSelection,
  applyGlobalPipelineSelection,
  applyPipelineRunInSelection,
  applyWorkspaceActionSelection,
  automationFormActionCategory,
  automationFormChatRunMode,
  automationFormChatTarget,
  actionTypeTakesPipelineDependencies,
  automationFormSidebarGroupScope,
  buildAction,
  clearedPipelineSelection,
  displayedPipelineRunIn,
  getAutomationWorktreeLabel,
  getPipelineModelAliasBlockingError,
  hasChatAuthoredPayload,
  resolveRepickedSharedPipeline,
  selectedAutomationWorkspaceId,
  workspaceActionModeForType,
  type ActionCategory,
  type FormState,
  type WorkspaceActionMode,
} from './automationFormState';

/**
 * Which fields a body renders. `definition` is everything except the trigger
 * block; `trigger` is the schedule kind, the cron or one-time inputs with the
 * cron generator, and the If Command ("Only run if").
 */
export type ActivityFormFieldGroup = 'all' | 'definition' | 'trigger';

/**
 * Why the form changed. `mount` marks a normalization a field made on its own
 * before the user touched this body (for example the prompt editor settling
 * its value), so a host can take its clean baseline after it. Everything the
 * user does is `user`.
 */
export interface ActivityFormChangeMeta {
  origin: 'mount' | 'user';
}

export interface ActivityFormBodyHandle {
  /**
   * Runs the checks the Save button runs (a pending prompt editor or an
   * unresolved chat destination blocks it), then calls `onSubmit`. Also drops
   * an If Command generation still in flight.
   */
  submit: () => Promise<void>;
  /** Drops an If Command generation still in flight, as cancel does. */
  cancelPendingGenerations: () => void;
}

export interface ActivityFormBodyProps {
  state: FormState;
  saving: boolean;
  /** Every project, so a saved target resolves even outside the context. */
  projects: ReturnType<typeof useProjectsStore.getState>['projects'];
  /**
   * Personal/organization scope (CAN-3448). The Project picker offers only
   * projects in the selected context; omit to offer every project.
   */
  scope?: Pick<
    AutomationScope,
    'context' | 'projectsInContext' | 'labelForWorkspace' | 'memberOfWorkspace'
  > &
    Partial<Pick<AutomationScope, 'ownerLabel'>>;
  /**
   * A failed save (for example, turning on an automation whose target is in
   * another context), shown under the fields. With two bodies mounted, pass it
   * to one of them.
   */
  error?: string | null;
  ownerDocument?: Document;
  onChange: (next: FormState, meta: ActivityFormChangeMeta) => void;
  /** Called by `handleRef.submit()` once the form's own checks pass. */
  onSubmit?: () => void | Promise<void>;
  /** Defaults to `all`. */
  fieldGroup?: ActivityFormFieldGroup;
  /** Defaults to true. A host that shows Enabled itself can hide it here. */
  showEnabledField?: boolean;
  handleRef?: Ref<ActivityFormBodyHandle>;
  /**
   * Whether Save can run, ignoring `saving`: false while the prompt editor is
   * pending or invalid, the chat destination is unresolved, or a pipeline
   * model alias still needs configuring. Reported on mount and on change. A
   * `trigger` body has no such checks and always reports true.
   */
  onSubmitAvailabilityChange?: (canSubmit: boolean) => void;
  /**
   * Draws the host's frame around the fields and notices. Without it they
   * render in a root that carries `data-testid="automations-form-body"`. The
   * pipeline picker always renders after the frame.
   */
  renderFrame?: (content: ReactNode) => ReactNode;
}

/**
 * Chat | Pipeline selector for the `project` action category: a rounded-full
 * bordered pill with a primary-filled active segment and visible labels next
 * to the icons.
 */
interface WorkspaceActionModeControlProps {
  value: WorkspaceActionMode;
  onChange: (value: WorkspaceActionMode) => void;
  disabled?: boolean;
}

function WorkspaceActionModeControl({
  value,
  onChange,
  disabled = false,
}: WorkspaceActionModeControlProps): JSX.Element {
  const options: Array<{
    value: WorkspaceActionMode;
    label: string;
    icon: JSX.Element;
  }> = [
    {
      value: 'chat',
      label: CHAT_UNIT_LABEL,
      icon: <ChatIcon size="sm" aria-hidden="true" />,
    },
    {
      value: 'pipeline',
      label: WORKFLOW_ITEM_LABEL,
      icon: <PipelineIcon size="sm" aria-hidden="true" />,
    },
  ];
  return (
    <div className="flex flex-col gap-1 text-xs fg-secondary">
      <span>Type</span>
      <SharedSegmentedControl
        value={value}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          leading: option.icon,
          dataTestId: `automations-form-workspace-action-mode-${option.value}`,
        }))}
        onChange={onChange}
        label="Project action type"
        shape="capsule"
        width="content"
        disabled={disabled}
        dataTestId="automations-form-workspace-action-mode"
      />
    </div>
  );
}

function InterfaceModeControl({
  value,
  onChange,
}: {
  value: ChatInterfaceMode | '';
  onChange: (value: ChatInterfaceMode | '') => void;
}): JSX.Element {
  const options: Array<{
    value: ChatInterfaceMode | '';
    label: string;
    icon?: JSX.Element;
  }> = [
    { value: '', label: 'Default' },
    {
      value: 'canopy',
      label: brandText.shortName,
      icon: <BrandLogo width={14} height={14} aria-hidden />,
    },
    {
      value: 'claude-code',
      label: 'Claude Code',
      icon: <TerminalBorderedIcon size="sm" aria-hidden="true" />,
    },
  ];

  return (
    <SharedSegmentedControl
      value={value}
      options={options.map((option) => ({
        value: option.value,
        label: option.label,
        leading: option.icon,
      }))}
      onChange={onChange}
      label="Claude chat mode"
      shape="capsule"
      width="content"
      dataTestId="automations-form-interface-mode"
    />
  );
}

/**
 * The folder a multi-repo project-folder run uses, as main resolves it: the
 * chosen repository, else the project's source root. With neither, the picker
 * preselects the first repository, so discovery starts there.
 */
function projectFolderRepoPath(
  project: Pick<MultiRepoSidebarItem, 'repos' | 'sourceRepoPath'>,
  repoId: string | undefined,
): string | undefined {
  if (repoId && repoId !== WORKSPACE_ROOT_REPO_ID)
    return project.repos.find((repo) => repo.id === repoId)?.repoPath;
  return (
    project.sourceRepoPath ?? (repoId ? undefined : project.repos[0]?.repoPath)
  );
}

/**
 * Resolve the cowork workspace root (managed `home/` or attached external
 * folder) for the pipeline picker's cwd. Returns `undefined` while loading,
 * when no workspace is provided, or when resolution fails.
 */
function useCoworkRootCwd(workspaceId: string | undefined): string | undefined {
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) {
      setCwd(undefined);
      return undefined;
    }
    setCwd(undefined);
    void window.api.homeGetCoworkRoot({ workspaceId }).then(
      (path): void => {
        if (!cancelled) setCwd(path || undefined);
      },
      (): void => {
        if (!cancelled) setCwd(undefined);
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [workspaceId]);
  return workspaceId ? cwd : undefined;
}

export function ActivityFormBody({
  state,
  saving,
  projects,
  scope,
  error = null,
  ownerDocument,
  onChange: reportChange,
  onSubmit,
  fieldGroup = 'all',
  showEnabledField = true,
  handleRef,
  onSubmitAvailabilityChange,
  renderFrame,
}: ActivityFormBodyProps): JSX.Element {
  const showDefinition = fieldGroup !== 'trigger';
  const showTrigger = fieldGroup !== 'definition';
  // Until the user interacts with this body, a change a child field reports
  // on its own is a mount normalization, not an edit.
  const userInteractedRef = useRef(false);
  const markUserInteraction = useCallback((): void => {
    userInteractedRef.current = true;
  }, []);
  const onChange = useCallback(
    (next: FormState): void => reportChange(next, { origin: 'user' }),
    [reportChange],
  );
  const onFieldChange = useCallback(
    (next: FormState): void =>
      reportChange(next, {
        origin: userInteractedRef.current ? 'user' : 'mount',
      }),
    [reportChange],
  );
  const claudeTuiChatsEnabled = useClaudeTuiChatsEnabled();
  const actionCategory = automationFormActionCategory(state);
  const workspaceActionMode = workspaceActionModeForType(state.actionType);
  const selectedWorkspaceId = selectedAutomationWorkspaceId(state);
  const selectedProject = projects.find((p) => p.id === selectedWorkspaceId);
  const pickerProjects = scope?.context ? scope.projectsInContext : projects;
  // A saved target outside the selected context stays selected (never
  // dropped or swapped); the note says where it runs.
  const selectedOutsideContext =
    selectedProject !== undefined &&
    !pickerProjects.some((project) => project.id === selectedProject.id);
  const contextNote =
    scope && selectedProject && selectedOutsideContext
      ? automationContextNoteMessage({
          targetName: getWorkspaceDisplayName(selectedProject),
          targetContext: scope.memberOfWorkspace(selectedProject)
            ? scope.labelForWorkspace(selectedProject)
            : null,
        })
      : null;
  const selectedIsCowork = selectedProject?.type === 'cowork';
  const selectedProjectWorktrees =
    selectedProject && selectedProject.type !== 'cowork'
      ? selectedProject.worktrees
      : [];
  const baseWorktree =
    selectedProjectWorktrees.find(
      (worktree) => worktree.id === state.baseWorktreeId,
    ) ?? selectedProjectWorktrees[0];
  const isCoworkPipeline =
    state.actionType === 'worktree_pipeline' && selectedIsCowork;
  const isGlobalPipeline = actionCategory === 'global';
  // Where a pipeline on a project runs; a legacy cowork action shows Project
  // folder, which is what it does.
  const pipelineRunIn = displayedPipelineRunIn(state, selectedIsCowork);
  const pipelineTaskWorktreeId =
    state.actionType === 'worktree_pipeline' &&
    pipelineRunIn === 'task' &&
    state.pipelineTaskId
      ? state.pipelineTaskId
      : undefined;
  // A task run discovers its project pipelines in that task, never another
  // worktree, so the picker waits for a task.
  const pipelineDiscoveryWorktreeId =
    pipelineRunIn === 'task' ? pipelineTaskWorktreeId : baseWorktree?.id;
  // The working directory chosen in the open picker, before it is saved.
  const [pickerRepoId, setPickerRepoId] = useState<string | undefined>();
  // A project-folder run on a code project needs no worktree; its project
  // pipelines are discovered in the folder main runs it in: the selected
  // repository on a multi-repo project, else the project's source root.
  const codeProjectFolderCwd =
    state.actionType === 'worktree_pipeline' &&
    pipelineRunIn === 'project' &&
    selectedProject !== undefined &&
    selectedProject.type !== 'cowork'
      ? selectedProject.type === 'single-repo'
        ? selectedProject.repoPath
        : projectFolderRepoPath(
            selectedProject,
            pickerRepoId !== undefined &&
              (pickerRepoId === WORKSPACE_ROOT_REPO_ID ||
                selectedProject.repos.some((repo) => repo.id === pickerRepoId))
              ? pickerRepoId
              : state.repoId,
          )
      : undefined;
  // That run uses one of the project's own repositories, not a worktree's, so
  // it offers them even when the project has no worktree.
  const codeProjectFolderRepoChoices: PipelineRepoChoice[] | undefined =
    state.actionType === 'worktree_pipeline' &&
    pipelineRunIn === 'project' &&
    selectedProject?.type === 'multi-repo'
      ? [
          ...(selectedProject.sourceRepoPath
            ? [
                {
                  repoId: WORKSPACE_ROOT_REPO_ID,
                  repoName: WORKSPACE_ROOT_REPO_NAME,
                },
              ]
            : []),
          ...selectedProject.repos.map((repo) => ({
            repoId: repo.id,
            repoName: repo.name,
          })),
        ]
      : undefined;
  const pipelineExecutionScope = automationDestinationExecutionScope(
    isGlobalPipeline || state.pipelineTargetExplicit
      ? state.pipelineTargetKind
      : undefined,
    selectedProject?.type,
  );
  // The pipeline picker and the prompt editor live in the definition fields,
  // so a trigger-only body skips the reads that feed them.
  const pipelineWorktreeContext = usePipelineWorktreeContext(
    showDefinition &&
      state.actionType === 'worktree_pipeline' &&
      !selectedIsCowork
      ? state.workspaceId
      : undefined,
    showDefinition &&
      state.actionType === 'worktree_pipeline' &&
      !selectedIsCowork
      ? pipelineDiscoveryWorktreeId
      : undefined,
  );
  const coworkRootCwd = useCoworkRootCwd(
    showDefinition && isCoworkPipeline ? state.workspaceId : undefined,
  );
  const pipelineTaskList = usePipelineTaskList(
    showDefinition &&
      state.actionType === 'worktree_pipeline' &&
      pipelineRunIn === 'task'
      ? selectedWorkspaceId || undefined
      : undefined,
  );
  const pipelineTasks = pipelineTaskList.tasks;
  const pipelineTaskStale =
    state.actionType === 'worktree_pipeline' &&
    pipelineRunIn === 'task' &&
    isAutomationPipelineTaskStale(state.pipelineTaskId, pipelineTasks);
  const ownerLabel =
    scope?.ownerLabel?.(
      state.mode === 'edit'
        ? (state.executionContext ?? 'personal')
        : undefined,
    ) ?? 'Personal';
  // The selected destination's verdict on the picked pipeline. `null` until
  // the action can be built (no pipeline picked yet).
  const [pipelineTargetStatus, setPipelineTargetStatus] = useState<
    AutomationTargetResolution['status'] | null
  >(null);
  // An explicit destination saves only once the picked pipeline is verified
  // to run there; a legacy destination keeps its existing save rules.
  const pipelineTargetBlocked =
    showDefinition &&
    state.actionType === 'worktree_pipeline' &&
    (pipelineTaskStale ||
      ((isGlobalPipeline || state.pipelineTargetExplicit) &&
        (pipelineTargetStatus === 'pending' ||
          pipelineTargetStatus === 'error')));
  const [pipelinePickerOpen, setPipelinePickerOpen] = useState(false);
  const [cronAssistantOpen, setCronAssistantOpen] = useState(false);
  const [cronAssistantText, setCronAssistantText] = useState('');
  const [cronGenerating, setCronGenerating] = useState(false);
  const [cronGenerationWarning, setCronGenerationWarning] = useState<
    string | null
  >(null);
  const [composerPending, setComposerPending] = useState(false);
  const [composerInvalid, setComposerInvalid] = useState(false);
  const composerBlocked =
    (state.actionType === 'app_advisor_prompt' ||
      workspaceActionMode === 'chat') &&
    (composerPending || composerInvalid);
  const onComposerValidityChange = useCallback(
    (result: { valid: boolean }): void => setComposerInvalid(!result.valid),
    [],
  );
  const [sessionPreview, setSessionPreview] = useState<{
    key: string;
    tab: PersistedChatTab;
  }>();
  const sessionTarget =
    showDefinition && state.actionType === 'worktree_session_prompt'
      ? state.worktreeSessionTarget
      : undefined;
  const sessionKey = sessionTarget
    ? `${sessionTarget.workspaceId}/${sessionTarget.worktreeId}/${sessionTarget.chatId}`
    : '';
  useEffect(() => {
    if (
      !sessionTarget?.workspaceId ||
      !sessionTarget.worktreeId ||
      !sessionTarget.chatId ||
      !window.api?.chat?.loadTabs
    )
      return;
    let cancelled = false;
    setSessionPreview(undefined);
    void window.api.chat
      .loadTabs({
        projectId: sessionTarget.workspaceId,
        worktreeId: sessionTarget.worktreeId,
      })
      .then((loaded) => {
        const tab = loaded.tabs.find(
          (entry) =>
            entry.id === sessionTarget.chatId &&
            (entry.kind ?? 'chat') === 'chat' &&
            !entry.readOnly,
        );
        if (!cancelled && tab) setSessionPreview({ key: sessionKey, tab });
      })
      .catch(() => {
        if (!cancelled) setSessionPreview(undefined);
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    sessionKey,
    sessionTarget?.workspaceId,
    sessionTarget?.worktreeId,
    sessionTarget?.chatId,
  ]);
  const previewTab =
    sessionPreview?.key === sessionKey ? sessionPreview.tab : undefined;
  const composerContext = resolveAutomationComposerContext({
    actionType: state.actionType,
    workspaceId: selectedWorkspaceId,
    isCowork: selectedIsCowork,
    baseWorktreeId: state.baseWorktreeId,
    existingWorktreeId: state.existingWorktreeId,
    sessionTarget,
    selectedRepoId: previewTab?.selectedRepoId,
    sessionReady: Boolean(previewTab),
  });
  const [ifCommandOpen, setIfCommandOpen] = useState<boolean>(
    () => state.ifCommand.trim().length > 0,
  );
  const [ifCommandAssistantOpen, setIfCommandAssistantOpen] = useState(false);
  const [ifCommandAssistantText, setIfCommandAssistantText] = useState('');
  const [ifCommandGenerating, setIfCommandGenerating] = useState(false);
  const [ifCommandWarning, setIfCommandWarning] = useState<string | null>(null);
  const latestStateRef = useRef(state);
  const ifCommandGenerationRevisionRef = useRef(0);

  useEffect(() => {
    latestStateRef.current = state;
  }, [state]);

  useEffect(
    () => (): void => {
      ifCommandGenerationRevisionRef.current += 1;
    },
    [],
  );
  const isWorktreeSessionPrompt =
    state.actionType === 'worktree_session_prompt';
  const sidebarGroupScope = automationFormSidebarGroupScope(state);
  const chatRunMode = automationFormChatRunMode(state);
  // CAN-2937: the read-only gate is keyed on whether the payload was authored
  // from chat, not on the action type, so a form-authored existing-chat
  // automation round-trips and a composer-authored one can still be
  // re-pointed (Run-in + picker stay interactive below).
  const formReadOnly = hasChatAuthoredPayload(state);
  const destinationOnlyEdit = hasChatAuthoredPayload(state);
  const isAppAdvisorTarget = actionCategory === 'app_advisor';
  // The picker's scope: App Advisor Work Entries, or the selected project.
  const chatTargetWorkspaceId = isAppAdvisorTarget
    ? APP_ADVISOR_PROJECT_ID
    : selectedWorkspaceId;
  const showRunInSelector =
    chatRunMode !== undefined &&
    (isAppAdvisorTarget ||
      (actionCategory === 'workspace' &&
        workspaceActionMode === 'chat' &&
        Boolean(selectedProject)));
  const [chatTargetStatus, setChatTargetStatus] =
    useState<AutomationChatTargetStatus>(
      chatRunMode === 'existing_chat' ? 'incomplete' : 'ready',
    );
  // Both non-ready states block Save, but "you have not picked one yet" and
  // "the one you picked is gone" are different problems and read differently.
  // The destination picker is a definition field; a trigger-only body never
  // mounts it, so it never waits on it.
  const chatTargetBlocked =
    showDefinition &&
    chatRunMode === 'existing_chat' &&
    chatTargetStatus !== 'ready';
  const chatTargetBlockingMessage = !chatTargetBlocked
    ? null
    : chatTargetStatus === 'unavailable'
      ? AUTOMATION_CHAT_TARGET_UNAVAILABLE_ERROR
      : AUTOMATION_CHAT_TARGET_INCOMPLETE_ERROR;
  const droppedAttachmentCount =
    (state.attachmentPaths?.length ?? 0) + (state.fileReferences?.length ?? 0);

  const previewDate = useMemo(() => {
    if (state.triggerKind === 'cron') {
      const trigger: AutomationTrigger = {
        kind: 'cron',
        expression: state.cronExpression.trim(),
        timezone: 'local',
      };
      if (validateAutomationTrigger(trigger)) return null;
      return getNextAutomationTriggerRun(trigger, new Date());
    }
    if (!state.oneTimeDate || !state.oneTimeTime) return null;
    const dt = new Date(`${state.oneTimeDate}T${state.oneTimeTime}:00`);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
  }, [
    state.cronExpression,
    state.oneTimeDate,
    state.oneTimeTime,
    state.triggerKind,
  ]);

  // The time picker lists every quarter hour, plus the time the form opened
  // with and the current one, so a saved time off the quarter hour (9:07)
  // stays selectable. Earlier today has passed: those slots can't be chosen.
  const [openedOneTimeTime, setOpenedOneTimeTime] = useState(state.oneTimeTime);
  if (!openedOneTimeTime && state.oneTimeTime) {
    setOpenedOneTimeTime(state.oneTimeTime);
  }
  const today = toIsoDateValue(new Date());
  const passedOneTimeTime = passedTimeOn(state.oneTimeDate);
  const timeOptions = useMemo(
    () =>
      buildTimeSlotOptions({
        keep: [openedOneTimeTime, state.oneTimeTime],
        passed: passedOneTimeTime,
      }),
    [openedOneTimeTime, passedOneTimeTime, state.oneTimeTime],
  );

  const cronError = useMemo(() => {
    if (state.triggerKind !== 'cron') return null;
    const error = validateAutomationTrigger({
      kind: 'cron',
      expression: state.cronExpression.trim(),
      timezone: 'local',
    });
    return error ? formatCronValidationError(error) : null;
  }, [state.cronExpression, state.triggerKind]);

  const update = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ): void => {
    onChange({ ...state, [key]: value });
  };

  const resolveWorkspaceSelection = (
    id: string,
  ): { id: string; isCowork: boolean } | null => {
    if (!id) return null;
    const project = projects.find((p) => p.id === id);
    if (!project) return null;
    return { id, isCowork: project.type === 'cowork' };
  };

  const handleActionCategoryChange = (category: ActionCategory): void => {
    if (category === actionCategory) return;
    // The Run-in mode carries across targets; an existing destination does
    // not, because worktrees and Work Entries belong to one target.
    if (chatRunMode === 'existing_chat') setChatTargetStatus('incomplete');
    if (category === 'global') {
      onChange(applyGlobalPipelineSelection(state));
      return;
    }
    if (category === 'app_advisor') {
      onChange(
        applyAppAdvisorActionCategorySelection(
          state,
          chatRunMode ?? 'new_chat',
        ),
      );
      return;
    }
    // Re-enter the workspace category in Chat mode, restoring whichever
    // workspace selection survived the round trip through App Advisor. An
    // existing-chat automation parks its workspace on the session target, so
    // that is the third place worth looking.
    // A pipeline with no project stays a pipeline on the chosen project.
    onChange(
      applyWorkspaceActionSelection(
        state,
        isGlobalPipeline ? 'pipeline' : 'chat',
        resolveWorkspaceSelection(
          state.workspaceId ||
            state.chatProjectId ||
            state.worktreeSessionTarget?.workspaceId ||
            '',
        ),
      ),
    );
  };

  const handleWorkspaceChange = (nextId: string): void => {
    if (chatRunMode === 'existing_chat') setChatTargetStatus('incomplete');
    onChange(
      applyWorkspaceActionSelection(
        state,
        workspaceActionMode,
        resolveWorkspaceSelection(nextId),
      ),
    );
  };

  const handleWorkspaceActionModeChange = (mode: WorkspaceActionMode): void => {
    onChange(
      applyWorkspaceActionSelection(
        state,
        mode,
        resolveWorkspaceSelection(selectedWorkspaceId),
      ),
    );
  };

  const handleChatRunModeChange = (runMode: AutomationChatRunMode): void => {
    setChatTargetStatus(runMode === 'existing_chat' ? 'incomplete' : 'ready');
    onChange(
      isAppAdvisorTarget
        ? applyAppAdvisorRunModeSelection(state, runMode)
        : applyChatRunModeSelection(
            state,
            runMode,
            resolveWorkspaceSelection(selectedWorkspaceId),
          ),
    );
  };

  const handleChatTargetChange = (
    next: WorktreeSessionTarget | undefined,
  ): void => {
    setChatTargetStatus('incomplete');
    onChange(
      applyChatTargetSelection(
        state,
        chatTargetWorkspaceId,
        !isAppAdvisorTarget && selectedIsCowork,
        next,
      ),
    );
  };

  const runInControls = showRunInSelector && chatRunMode && (
    <>
      <SegmentedControl
        label="Run in"
        value={chatRunMode}
        options={[
          {
            label: getAutomationChatRunModeLabel('new_chat'),
            value: 'new_chat',
          },
          {
            label: getAutomationChatRunModeLabel('existing_chat'),
            value: 'existing_chat',
          },
        ]}
        onChange={handleChatRunModeChange}
        testId="automations-form-run-in"
      />
      {chatRunMode === 'existing_chat' && (
        <AutomationChatTargetPicker
          workspaceId={chatTargetWorkspaceId}
          value={automationFormChatTarget(state)}
          ownerDocument={ownerDocument}
          onChange={handleChatTargetChange}
          onStatusChange={setChatTargetStatus}
        />
      )}
      {destinationOnlyEdit && droppedAttachmentCount > 0 && (
        <p
          className="text-2xs fg-secondary"
          data-testid="automations-form-run-in-attachment-warning"
        >
          {isWorktreeSessionPrompt
            ? `Choosing a new ${CHAT_UNIT_LABEL.toLowerCase()} drops`
            : 'Saving this destination drops'}{' '}
          the {droppedAttachmentCount} attached file
          {droppedAttachmentCount === 1 ? '' : 's'} because a new chat cannot
          carry them.
        </p>
      )}
    </>
  );

  const cancelPendingGenerations = useCallback((): void => {
    ifCommandGenerationRevisionRef.current += 1;
  }, []);

  const handleSubmitForm = useCallback(async (): Promise<void> => {
    ifCommandGenerationRevisionRef.current += 1;
    if (composerBlocked || chatTargetBlocked || pipelineTargetBlocked) return;
    await onSubmit?.();
  }, [onSubmit, composerBlocked, chatTargetBlocked, pipelineTargetBlocked]);

  useImperativeHandle(
    handleRef,
    (): ActivityFormBodyHandle => ({
      submit: handleSubmitForm,
      cancelPendingGenerations,
    }),
    [cancelPendingGenerations, handleSubmitForm],
  );

  const handleGenerateCron = useCallback(async (): Promise<void> => {
    const description = cronAssistantText.trim();
    if (!description || cronGenerating) return;
    setCronAssistantOpen(false);
    setCronGenerationWarning(null);
    setCronGenerating(true);
    try {
      const response = await window.api.automations.generateCron({
        description,
      });
      if (!response.ok) {
        setCronGenerationWarning(response.error);
        return;
      }
      const validationError = validateAutomationTrigger({
        kind: 'cron',
        expression: response.expression.trim(),
        timezone: 'local',
      });
      if (validationError) {
        setCronGenerationWarning(
          formatCronValidationError(validationError) ||
            'Generated cron expression is invalid.',
        );
        return;
      }
      onChange({
        ...latestStateRef.current,
        cronExpression: response.expression.trim(),
      });
      setCronAssistantText('');
    } catch (error) {
      setCronGenerationWarning(
        error instanceof Error
          ? error.message
          : 'Could not generate a cron expression.',
      );
    } finally {
      setCronGenerating(false);
    }
  }, [cronAssistantText, cronGenerating, onChange]);

  const handleGenerateIfCommand = useCallback(async (): Promise<void> => {
    const description = ifCommandAssistantText.trim();
    if (!description || ifCommandGenerating) return;
    const generationRevision = ifCommandGenerationRevisionRef.current;
    setIfCommandAssistantOpen(false);
    setIfCommandWarning(null);
    setIfCommandGenerating(true);
    try {
      const response = await window.api.automations.generateIfCommand({
        description,
        currentCommand: state.ifCommand,
      });
      if (generationRevision !== ifCommandGenerationRevisionRef.current) {
        return;
      }
      if (!response.ok) {
        setIfCommandWarning(response.error);
        return;
      }
      onChange({ ...latestStateRef.current, ifCommand: response.command });
      setIfCommandAssistantText('');
    } catch (error) {
      if (generationRevision !== ifCommandGenerationRevisionRef.current) {
        return;
      }
      setIfCommandWarning(
        error instanceof Error
          ? error.message
          : 'Could not generate an If Command.',
      );
    } finally {
      if (generationRevision === ifCommandGenerationRevisionRef.current) {
        setIfCommandGenerating(false);
      }
    }
  }, [ifCommandAssistantText, ifCommandGenerating, onChange, state.ifCommand]);

  const ifCommandConfigured = state.ifCommand.trim().length > 0;
  const promptVariableItems = getAutomationIfCommandVariableDefinitions().map(
    (definition) => ({
      ...definition,
      disabled: !ifCommandConfigured,
      ...(ifCommandConfigured
        ? {}
        : {
            disabledReason:
              'Configure an If Command above to enable this variable.',
          }),
    }),
  );
  const modelAliasBlockingError = showDefinition
    ? getPipelineModelAliasBlockingError(state)
    : undefined;
  const canSubmit =
    !modelAliasBlockingError &&
    !chatTargetBlocked &&
    !composerBlocked &&
    !pipelineTargetBlocked;
  // Before paint, so a host's Save button never shows a stale state.
  useLayoutEffect(() => {
    onSubmitAvailabilityChange?.(canSubmit);
  }, [canSubmit, onSubmitAvailabilityChange]);

  const applyPipelineSelection = useCallback(
    (
      _pipelineId: string,
      pipeline: PipelineData,
      inputs: Record<string, string> | undefined,
      selectedRepoId: string | undefined,
      pluginCollectionContext: PipelinePluginCollectionRunContext,
    ): Promise<void> => {
      const info = pipeline.info;
      onChange({
        ...state,
        pipelineId: info.id,
        pipelineName: info.name,
        pipelineSource: info.source,
        projectPipelineFilename: info.source === 'project' ? info.filename : '',
        sharedPipeline: resolveRepickedSharedPipeline(
          state.sharedPipeline,
          info,
        ),
        repoId: selectedRepoId ?? '',
        pipelineInputs: Object.entries(inputs ?? {}).map(([key, value]) => ({
          key,
          value,
        })),
        pluginCollectionPreferences:
          Object.keys(pluginCollectionContext.preferences).length > 0
            ? pluginCollectionContext.preferences
            : undefined,
        modelAliasPreferences:
          pluginCollectionContext.modelAliasPreferences &&
          Object.keys(pluginCollectionContext.modelAliasPreferences).length > 0
            ? pluginCollectionContext.modelAliasPreferences
            : undefined,
        pipelineModelAliases: pipeline.content.model_aliases ?? [],
        pipelinePluginCollectionIds: (
          pipeline.content.plugin_collections ?? []
        ).map((collection) => collection.id),
        modelConfig: pluginCollectionContext.modelConfig,
      });
      setPipelinePickerOpen(false);
      return Promise.resolve();
    },
    [onChange, state],
  );

  // Any input inside the fields counts, including menus the fields portal
  // out, since React events bubble through portals.
  const interactionCapture = {
    onPointerDownCapture: markUserInteraction,
    onClickCapture: markUserInteraction,
    onKeyDownCapture: markUserInteraction,
    onInputCapture: markUserInteraction,
    onChangeCapture: markUserInteraction,
    onPasteCapture: markUserInteraction,
    onDropCapture: markUserInteraction,
  };

  const content = (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-s"
        {...interactionCapture}
      >
        {showDefinition && (
          <>
            <Field label="Name">
              {(control) => (
                <TextInput
                  {...control}
                  type="text"
                  value={state.name}
                  onChange={(event): void => update('name', event.target.value)}
                  readOnly={formReadOnly}
                  placeholder="Daily standup digest"
                  data-testid="automations-form-name"
                />
              )}
            </Field>
            {showEnabledField && (
              <div className="flex items-center gap-2 text-xs fg-primary">
                <ToggleSwitch
                  label="Enabled"
                  checked={state.enabled}
                  onChange={(next): void => update('enabled', next)}
                  disabled={formReadOnly}
                  dataTestId="automations-form-enabled"
                />
                <span aria-hidden="true">Enabled</span>
              </div>
            )}
          </>
        )}
        {showTrigger && (
          <>
            {formReadOnly ? (
              <Surface
                variant="group"
                size="small"
                data-testid="automations-form-schedule-readonly"
              >
                <div className="flex flex-col px-3 py-2 gap-2">
                  <div className="text-xs font-medium fg-secondary">
                    Trigger
                  </div>
                  <Surface
                    variant="group"
                    size="small"
                    className="inline-block self-start"
                  >
                    <div className="inline-flex self-start px-2 py-1 text-xs fg-primary">
                      One-time
                    </div>
                  </Surface>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Date">
                      {(control) => (
                        <DateField
                          {...control}
                          value={state.oneTimeDate}
                          onValueChange={ignoreReadOnlyChange}
                          disabled
                          data-testid="automations-form-date"
                        />
                      )}
                    </Field>
                    <Field label="Time">
                      {(control) => (
                        <Select
                          {...control}
                          options={timeOptions}
                          value={state.oneTimeTime || null}
                          onValueChange={ignoreReadOnlyChange}
                          disabled
                          data-testid="automations-form-time"
                        />
                      )}
                    </Field>
                  </div>
                  {previewDate ? (
                    <div className="text-xs fg-secondary">
                      Triggers at {previewDate.toLocaleString()}
                    </div>
                  ) : null}
                </div>
              </Surface>
            ) : (
              <SegmentedControl
                label="Trigger"
                value={state.triggerKind}
                options={[
                  { label: 'Scheduled', value: 'cron' },
                  { label: 'One-time', value: 'one_time' },
                ]}
                onChange={(value): void => update('triggerKind', value)}
                testId="automations-form-schedule-kind"
              />
            )}
            {!formReadOnly && state.triggerKind === 'cron' ? (
              <Stack gap="tight">
                <Stack gap={cronGenerating ? 'tight' : 'inline'}>
                  <FormField label="Cron expression">
                    {(control) => (
                      <TextInput
                        {...control}
                        type="text"
                        mono
                        value={state.cronExpression}
                        onChange={(event): void =>
                          update('cronExpression', event.target.value)
                        }
                        disabled={cronGenerating}
                        aria-busy={cronGenerating}
                        spellCheck={false}
                        data-testid="automations-form-cron"
                        trailing={
                          <Tooltip label="Generate cron expression">
                            <Button
                              variant="ghost"
                              size="compact"
                              iconOnly
                              aria-label="Generate cron expression"
                              disabled={cronGenerating}
                              onClick={(): void => {
                                setCronAssistantOpen((open) => !open);
                                setCronGenerationWarning(null);
                              }}
                              data-testid="automations-form-cron-assistant"
                            >
                              <AppAdvisorIcon size="sm" />
                            </Button>
                          </Tooltip>
                        }
                      />
                    )}
                  </FormField>
                  {cronAssistantOpen && !cronGenerating && (
                    <div className="flex items-center gap-2">
                      <TextInput
                        type="text"
                        aria-label="Describe schedule"
                        value={cronAssistantText}
                        onChange={(event): void =>
                          setCronAssistantText(event.target.value)
                        }
                        onKeyDown={(event): void => {
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          void handleGenerateCron();
                        }}
                        placeholder="Describe schedule in natural language"
                        data-testid="automations-form-cron-natural-language"
                        className="min-w-0 flex-1"
                      />
                      <Button
                        size="compact"
                        disabled={cronAssistantText.trim().length === 0}
                        onClick={() => void handleGenerateCron()}
                        data-testid="automations-form-cron-generate"
                      >
                        Generate
                      </Button>
                    </div>
                  )}
                  {cronGenerating && (
                    <div className="text-xs fg-secondary">Generating…</div>
                  )}
                  {cronGenerationWarning && !cronGenerating && (
                    <Notice
                      errorSource="automations-form-cron-generation-warning"
                      className=""
                      intent="destructive"
                      data-testid="automations-form-cron-generation-warning"
                      actions={
                        <NoticeButton
                          variant="primary"
                          onClick={(): void => {
                            setCronGenerationWarning(null);
                            setCronAssistantOpen(true);
                          }}
                          data-testid="automations-form-cron-generation-try-again"
                        >
                          Try again
                        </NoticeButton>
                      }
                    >
                      {cronGenerationWarning}
                    </Notice>
                  )}
                </Stack>
                {cronError ? (
                  <FieldError id="automations-form-cron-error">
                    {cronError}
                  </FieldError>
                ) : previewDate ? (
                  <div className="text-xs fg-secondary">
                    Next trigger: {previewDate.toLocaleString()}
                  </div>
                ) : null}
              </Stack>
            ) : !formReadOnly ? (
              <Stack gap="inline">
                <Field label="Date">
                  {(control) => (
                    <DateField
                      {...control}
                      value={state.oneTimeDate}
                      min={today}
                      onValueChange={(next): void =>
                        update('oneTimeDate', next)
                      }
                      data-testid="automations-form-date"
                    />
                  )}
                </Field>
                <Field label="Time">
                  {(control) => (
                    <Select
                      {...control}
                      options={timeOptions}
                      value={state.oneTimeTime || null}
                      placeholder="Choose a time"
                      onValueChange={(next): void =>
                        update('oneTimeTime', next)
                      }
                      data-testid="automations-form-time"
                    />
                  )}
                </Field>
                {previewDate ? (
                  previewDate.getTime() <= Date.now() ? (
                    <FieldError id="automations-form-time-error">
                      Choose a future time.
                    </FieldError>
                  ) : (
                    <div className="text-xs fg-secondary">
                      Triggers at {previewDate.toLocaleString()}
                    </div>
                  )
                ) : null}
              </Stack>
            ) : null}
            {!formReadOnly && (
              <Disclosure
                variant="box"
                label={
                  <>
                    If command <span className="fg-secondary">(optional)</span>
                  </>
                }
                open={ifCommandOpen}
                onOpenChange={setIfCommandOpen}
                dataTestId="automations-form-if-command-section"
                toggleTestId="automations-form-if-command-toggle"
              >
                <p className="text-2xs fg-secondary">
                  Runs before the action. Exit 0 runs the action; any non-zero
                  exit skips it. Standard output is available to prompts as{' '}
                  <code className="font-mono">
                    {`{{${AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES[0] ?? 'AUTOMATION_IF_CMD_OUTPUT'}}}`}
                  </code>
                  . To prevent duplicate processing, print{' '}
                  <code className="font-mono">
                    {`${AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAMES[0] ?? 'IDEMPOTENCY_KEY'}=value`}
                  </code>{' '}
                  on its own stdout line; automations will be skipped if a
                  recent run used the same key. Scope defaults to this
                  automation only; print{' '}
                  <code className="font-mono">
                    {`${AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAMES[0] ?? 'IDEMPOTENCY_SCOPE'}=global`}
                  </code>{' '}
                  to compare against all automations. Idempotency lines are
                  stripped from prompt output.
                </p>
                <div className="flex items-start gap-2">
                  <TextArea
                    mono
                    aria-label="If command"
                    value={state.ifCommand}
                    onChange={(event): void =>
                      update('ifCommand', event.target.value)
                    }
                    disabled={ifCommandGenerating}
                    rows={2}
                    spellCheck={false}
                    placeholder="e.g. test -f ~/ready-to-run.txt"
                    data-testid="automations-form-if-command"
                    className="min-w-0 flex-1"
                  />
                  {/* A 36px cell centers the 28px button 4px below the
                          field's top edge, level with its first line. */}
                  <span className="flex h-9 shrink-0 items-center">
                    <Tooltip label="Generate if command">
                      <Button
                        variant="ghost"
                        size="compact"
                        iconOnly
                        aria-label="Generate if command"
                        disabled={ifCommandGenerating}
                        onClick={(): void => {
                          setIfCommandAssistantOpen((open) => !open);
                          setIfCommandWarning(null);
                        }}
                        data-testid="automations-form-if-command-assistant"
                      >
                        <AppAdvisorIcon size="sm" />
                      </Button>
                    </Tooltip>
                  </span>
                </div>
                {ifCommandAssistantOpen && !ifCommandGenerating && (
                  <div className="flex items-center gap-2">
                    <TextInput
                      type="text"
                      aria-label="Describe the gate"
                      value={ifCommandAssistantText}
                      onChange={(event): void =>
                        setIfCommandAssistantText(event.target.value)
                      }
                      onKeyDown={(event): void => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        void handleGenerateIfCommand();
                      }}
                      placeholder="Describe the gate in natural language"
                      data-testid="automations-form-if-command-natural-language"
                      className="min-w-0 flex-1"
                    />
                    <Button
                      size="compact"
                      disabled={ifCommandAssistantText.trim().length === 0}
                      onClick={() => void handleGenerateIfCommand()}
                      data-testid="automations-form-if-command-generate"
                    >
                      Generate
                    </Button>
                  </div>
                )}
                {ifCommandGenerating && (
                  <div className="text-xs fg-secondary">Generating…</div>
                )}
                {ifCommandWarning && !ifCommandGenerating && (
                  <Notice
                    errorSource="automations-form-if-command-warning"
                    intent="destructive"
                    data-testid="automations-form-if-command-warning"
                  >
                    {ifCommandWarning}
                  </Notice>
                )}
              </Disclosure>
            )}
          </>
        )}
        {showDefinition && (
          <>
            <SegmentedControl
              label="Target"
              value={actionCategory}
              options={[
                { label: ORCHESTRATOR_LABEL, value: 'app_advisor' },
                { label: 'Project', value: 'workspace' },
                { label: 'No project', value: 'global' },
              ]}
              onChange={handleActionCategoryChange}
              testId="automations-form-action-type"
              disabled={destinationOnlyEdit}
            />
            {isGlobalPipeline && (
              <div
                className="flex flex-col gap-1 text-xs fg-secondary"
                data-testid="automations-form-global-owner"
              >
                <span className="fg-primary">Owner: {ownerLabel}</span>
                <span>Runs without a project. Uses this workflow’s owner.</span>
              </div>
            )}
            <AutomationAuthorTargetRequirement
              action={buildAction(state).action}
              requirement={state.targetRequirement}
              installed={state.installed}
              onStatusChange={setPipelineTargetStatus}
              onChange={(contexts): void =>
                onChange({
                  ...state,
                  targetRequirement: contexts ? { contexts } : undefined,
                })
              }
            />
            {isAppAdvisorTarget && runInControls}
            {actionCategory === 'workspace' && (
              <>
                <Field label="Project">
                  {(control) => (
                    <SearchableSelect
                      id={control.id}
                      value={selectedWorkspaceId}
                      ownerDocument={ownerDocument}
                      selectedFallback={
                        selectedProject && selectedOutsideContext
                          ? projectPickerOption(selectedProject)
                          : undefined
                      }
                      options={pickerProjects.map(projectPickerOption)}
                      onChange={handleWorkspaceChange}
                      placeholder={
                        pickerProjects.length === 0
                          ? 'No projects available'
                          : 'Select a project'
                      }
                      searchPlaceholder="Search projects"
                      emptyListMessage="No matching projects"
                      disabled={pickerProjects.length === 0}
                      testId="automations-form-workspace"
                    />
                  )}
                </Field>
                {contextNote && (
                  <Notice data-testid="automations-form-context-note">
                    {contextNote}
                  </Notice>
                )}
                {selectedProject && (
                  <WorkspaceActionModeControl
                    value={workspaceActionMode}
                    onChange={handleWorkspaceActionModeChange}
                    disabled={destinationOnlyEdit}
                  />
                )}
                {runInControls}
                {state.actionType === 'worktree_pipeline' &&
                  selectedProject && (
                    <AutomationPipelineTargetFields
                      projectKind={selectedIsCowork ? 'cowork' : 'code'}
                      value={pipelineRunIn}
                      onChange={(kind): void =>
                        onChange(
                          applyPipelineRunInSelection(
                            state,
                            kind,
                            pipelineRunIn,
                          ),
                        )
                      }
                      taskId={state.pipelineTaskId}
                      tasks={pipelineTasks}
                      onTaskChange={(taskId): void =>
                        onChange({ ...state, pipelineTaskId: taskId })
                      }
                      onRetryTasks={pipelineTaskList.retry}
                      disabled={saving}
                      testIdPrefix="automations-form"
                    />
                  )}
                {selectedProject &&
                  chatRunMode !== 'existing_chat' &&
                  !selectedIsCowork &&
                  (state.actionType !== 'worktree_pipeline' ||
                    pipelineRunIn === 'new_worktree') && (
                    <Field label={`Base ${WORKTREE_UNIT_LABEL}`}>
                      {(control) => (
                        <SearchableSelect
                          id={control.id}
                          value={state.baseWorktreeId}
                          ownerDocument={ownerDocument}
                          options={selectedProjectWorktrees.map((worktree) => ({
                            id: worktree.id,
                            label: getAutomationWorktreeLabel(worktree),
                          }))}
                          onChange={(nextId): void =>
                            onChange({
                              ...state,
                              baseWorktreeId: nextId,
                              ...(nextId ? { baseBranch: '' } : {}),
                              ...clearedPipelineSelection(),
                            })
                          }
                          placeholder="Project default"
                          emptyOption={{
                            id: '',
                            label: 'Project default',
                            subtitle: "Use the project's default branch",
                          }}
                          searchPlaceholder="Search worktrees"
                          emptyListMessage="No matching worktrees"
                          testId="automations-form-base-worktree"
                        />
                      )}
                    </Field>
                  )}
              </>
            )}
            {sidebarGroupScope &&
              (sidebarGroupScope.appAdvisor ||
                selectedProject !== undefined) && (
                <Field label="Sidebar group">
                  <AutomationSidebarGroupPicker
                    scope={sidebarGroupScope}
                    value={state.sidebarGroupName}
                    onChange={(name): void =>
                      onFieldChange({ ...state, sidebarGroupName: name })
                    }
                    disabled={saving || destinationOnlyEdit}
                  />
                </Field>
              )}
            {(state.actionType === 'app_advisor_prompt' ||
              ((state.actionType === 'worktree_prompt' ||
                state.actionType === 'standalone_prompt') &&
                selectedProject) ||
              isWorktreeSessionPrompt) && (
              <Field label="Prompt">
                {/* The composite field's six-pixel child rhythm previously
                    added to the note/mode margin. Keep those control-internal
                    distances on their parent while the label keeps its gap. */}
                <div
                  className={
                    state.actionType === 'worktree_prompt' &&
                    claudeTuiChatsEnabled
                      ? 'flex flex-col gap-4.5'
                      : 'flex flex-col gap-3.5'
                  }
                >
                  <ConfigurationChatComposer
                    allowAgents
                    editorId={`automation-${state.id ?? 'new'}`}
                    dataTestId="automations-form-prompt"
                    draftGeneration={0}
                    context={composerContext}
                    selectionMode="local"
                    readOnly={formReadOnly}
                    disabled={saving}
                    effectiveModel={previewTab?.model}
                    speedRouteContext={
                      isWorktreeSessionPrompt && state.worktreeSessionTarget
                        ? {
                            kind: 'chat',
                            projectId: state.worktreeSessionTarget.workspaceId,
                            worktreeId: state.worktreeSessionTarget.worktreeId,
                            chatId: state.worktreeSessionTarget.chatId,
                          }
                        : undefined
                    }
                    speedRouteModelSelection={previewTab?.modelSelectionMode}
                    effectiveModelConfig={
                      previewTab?.modelConfig ??
                      (previewTab?.thinkingLevel
                        ? { thinkingLevel: previewTab.thinkingLevel }
                        : undefined)
                    }
                    executionHarness={
                      previewTab?.executionHarness === 'claude' ||
                      previewTab?.executionHarness === 'codex'
                        ? previewTab.executionHarness
                        : undefined
                    }
                    effectivePlanMode={previewTab?.planMode}
                    effectiveApprovalMode={previewTab?.approvalMode}
                    inheritedSelections={previewTab?.pluginSelections}
                    value={{
                      prompt: state.prompt,
                      promptReferences: state.promptReferences,
                      model: state.model,
                      modelConfig: canonicalizeAgentModelConfig({
                        ...state.chatModelConfig,
                        ...(state.thinkingLevel !== undefined
                          ? { thinkingLevel: state.thinkingLevel }
                          : {}),
                        ...(state.fastMode !== undefined
                          ? { fastMode: state.fastMode }
                          : {}),
                      }),
                      planMode: state.planMode,
                      approvalMode: state.approvalMode,
                      plugins: state.plugins,
                      pluginSelections: state.pluginSelections,
                    }}
                    onChange={(next) =>
                      onFieldChange({
                        ...state,
                        prompt: next.prompt,
                        promptReferences: next.promptReferences,
                        model: next.model,
                        chatModelConfig: next.modelConfig,
                        thinkingLevel: next.modelConfig?.thinkingLevel,
                        fastMode: next.modelConfig?.fastMode,
                        planMode: next.planMode,
                        approvalMode: next.approvalMode,
                        plugins: next.plugins ?? [],
                        pluginSelections:
                          next.pluginSelections ?? emptyPluginSelections(),
                      })
                    }
                    onPendingChange={setComposerPending}
                    onValidityChange={onComposerValidityChange}
                    variables={promptVariableItems.map((variable) => ({
                      ...variable,
                      token: createAutomationPromptVariableToken(variable.name),
                    }))}
                  />
                  {!formReadOnly && isWorktreeSessionPrompt && (
                    <p className="text-2xs fg-secondary">
                      Settings changed here apply to this chat when the
                      automation runs. Unchanged settings follow the chat.
                    </p>
                  )}
                  {!formReadOnly &&
                    state.actionType === 'worktree_prompt' &&
                    claudeTuiChatsEnabled && (
                      <div className="flex flex-col gap-1">
                        <span className="text-2xs font-medium fg-secondary">
                          Claude Code mode
                        </span>
                        <InterfaceModeControl
                          value={state.interfaceMode}
                          onChange={(nextMode) =>
                            update('interfaceMode', nextMode)
                          }
                        />
                      </div>
                    )}
                </div>
              </Field>
            )}
            {actionTypeTakesPipelineDependencies(state.actionType) &&
              (state.actionType === 'app_advisor_prompt' || selectedProject) &&
              !formReadOnly && (
                <Field label="Pipelines">
                  <AutomationPipelineDependenciesField
                    value={state.pipelineDependencies ?? []}
                    disabled={saving}
                    onChange={(pipelineDependencies) =>
                      onFieldChange({ ...state, pipelineDependencies })
                    }
                  />
                </Field>
              )}
            {state.actionType === 'worktree_pipeline' &&
              (selectedProject || isGlobalPipeline) && (
                <>
                  <Field label="Workflow">
                    <Surface
                      variant="inset"
                      gap="inline"
                      size="small"
                      padding="tight"
                    >
                      {state.pipelineId ? (
                        <div className="min-w-0">
                          <div className="truncate text-s font-medium fg-primary">
                            {state.pipelineName || state.pipelineId}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs fg-secondary">
                            {state.pipelineSource && (
                              <span className="rounded bg-fg-primary/[0.06] px-1.5 py-0.5">
                                {state.pipelineSource}
                              </span>
                            )}
                            {state.repoId && (
                              <span className="rounded bg-fg-primary/[0.06] px-1.5 py-0.5">
                                {state.repoId}
                              </span>
                            )}
                            <span>
                              {state.pipelineInputs.length === 1
                                ? '1 input'
                                : `${state.pipelineInputs.length} inputs`}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs fg-secondary">
                          {!state.workspaceId && !isGlobalPipeline
                            ? 'Select a project to load workflows.'
                            : 'Select a dispatch workflow and configure its inputs.'}
                        </div>
                      )}
                      <Button
                        size="compact"
                        disabled={
                          !isGlobalPipeline &&
                          (!state.workspaceId ||
                            (isCoworkPipeline
                              ? !coworkRootCwd
                              : !codeProjectFolderCwd &&
                                !pipelineDiscoveryWorktreeId &&
                                !codeProjectFolderRepoChoices?.length))
                        }
                        onClick={(): void => setPipelinePickerOpen(true)}
                        className="self-start"
                        data-testid="automations-form-pipeline"
                      >
                        {state.pipelineId
                          ? 'Change workflow'
                          : 'Select workflow'}
                      </Button>
                      <ErrorBanner
                        errorSource="automations-form-model-alias-error"
                        className=""
                        error={modelAliasBlockingError}
                        testId="automations-form-model-alias-error"
                      />
                    </Surface>
                  </Field>
                  {state.pipelineInputs.length > 0 && (
                    <Field label="Inputs">
                      <Surface
                        variant="group"
                        gap="tight"
                        size="small"
                        padding="tight"
                        data-testid="automations-form-pipeline-inputs"
                      >
                        <div className="flex flex-col gap-1">
                          {state.pipelineInputs.map((row) => (
                            <div
                              key={row.key}
                              className="grid grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)] gap-2 text-xs"
                            >
                              <span className="truncate fg-secondary">
                                {row.key}
                              </span>
                              <span
                                // Input values can carry the automation's prompt;
                                // keys stay recorded.
                                className={`${POSTHOG_REPLAY_BLOCK_CLASS} truncate fg-primary`}
                              >
                                {row.value || '(empty)'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </Surface>
                    </Field>
                  )}
                </>
              )}
          </>
        )}
      </div>
      {chatTargetBlockingMessage && (
        <div className="shrink-0 border-t px-4 pt-3">
          <Notice
            errorSource="automations-form-chat-target-error"
            displayErrorCode="external.state_changed"
            intent={
              chatTargetStatus === 'unavailable' ? 'destructive' : 'neutral'
            }
            data-testid="automations-form-chat-target-error"
          >
            {chatTargetBlockingMessage}
          </Notice>
        </div>
      )}
      {error && (
        <div className="shrink-0 px-4 pb-3">
          <Notice
            errorSource="automations-form-error-activity-body"
            className=""
            intent="destructive"
            data-testid="automations-form-error"
          >
            {error}
          </Notice>
        </div>
      )}
    </>
  );

  return (
    <>
      {renderFrame ? (
        renderFrame(content)
      ) : (
        <div
          data-testid="automations-form-body"
          data-field-group={fieldGroup}
          className="flex min-h-0 flex-col"
        >
          {content}
        </div>
      )}
      {pipelinePickerOpen && state.actionType === 'worktree_pipeline' && (
        <PipelineTriggerModal
          triggerType="dispatch"
          labels={{
            title: 'Select dispatch workflow',
            selectSubtitle: 'Select a workflow with dispatch trigger',
            emptyMessage:
              'No compatible workflows. Choose another destination or create a compatible workflow.',
          }}
          // A pipeline with no project discovers no project pipelines.
          cwd={
            isGlobalPipeline
              ? undefined
              : isCoworkPipeline
                ? coworkRootCwd
                : (codeProjectFolderCwd ?? pipelineWorktreeContext.cwd)
          }
          repoChoices={
            isGlobalPipeline || isCoworkPipeline
              ? []
              : (codeProjectFolderRepoChoices ??
                pipelineWorktreeContext.repoChoices)
          }
          defaultRepoId={state.repoId || undefined}
          onRepoChange={setPickerRepoId}
          executionScope={pipelineExecutionScope}
          onClose={(): void => setPipelinePickerOpen(false)}
          onRun={applyPipelineSelection}
          runLabel="Use workflow"
          ownerDocument={ownerDocument}
        />
      )}
    </>
  );
}

/** The read-only schedule's pickers are disabled, so they never change. */
function ignoreReadOnlyChange(): void {}

/**
 * One labelled field of the automation form. A single control takes the
 * shared `FormField` through a render prop; a composite editor (buttons and
 * fields together) is a named group with the same label.
 */
function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode | ((control: FormFieldControlProps) => ReactNode);
}): JSX.Element {
  if (typeof children === 'function') {
    return <FormField label={label}>{children}</FormField>;
  }
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className={FORM_FIELD_LABEL_CLASS}>{label}</span>
      {children}
    </div>
  );
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  disabled = false,
}: {
  label: string;
  /** `undefined` renders with no segment selected (edit-only action types). */
  value: T | undefined;
  options: Array<{ label: string; value: T }>;
  onChange: (value: T) => void;
  testId: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 text-xs fg-secondary">
      <span>{label}</span>
      <SharedSegmentedControl
        value={value ?? null}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          dataTestId: `${testId}-${option.value}`,
        }))}
        onChange={onChange}
        label={label}
        shape="capsule"
        width="content"
        disabled={disabled}
        dataTestId={testId}
      />
    </div>
  );
}

/** Project picker row for the automation form. */
function projectPickerOption(
  project: ReturnType<typeof useProjectsStore.getState>['projects'][number],
): SearchableSelectOption {
  const displayName = getWorkspaceDisplayName(project);
  const isMultiRepo = project.type === 'multi-repo';
  const isCowork = project.type === 'cowork';
  const subtitle = isMultiRepo
    ? `${project.repos.length} ${
        project.repos.length === 1 ? 'repo' : 'repos'
      }${project.temporary === true ? ' • Temporary' : ''}`
    : undefined;
  return {
    id: project.id,
    label: displayName,
    subtitle,
    badge: (
      <ProjectIcon
        color={project.color}
        repoPath={project.type === 'single-repo' ? project.repoPath : undefined}
        kind={isCowork ? 'cowork' : isMultiRepo ? 'multi-repo' : 'single-repo'}
        temporary={isMultiRepo && project.temporary === true}
      />
    ),
  };
}
