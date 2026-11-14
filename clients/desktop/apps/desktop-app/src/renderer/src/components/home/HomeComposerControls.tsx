import { homeModelRecoveryTarget } from '@/lib/composerModelRecoveryTarget';
import { useSuggestionsClaimApi } from '@canopy/ui-app/suggestions';
import { isPlanModeReadOnly } from '@canopy/ui-shared/lib/plan-mode-suggestion';
import {
  usePlanModeSuggestion,
  useComposerHintActivity,
  type PlanModeSuggestion,
} from '@canopy/ui-app';
import { getPlanModeHintStore } from '@/lib/planModeHint';
import { trackPlanModeHintAction } from '@/lib/planModeHintTelemetry';
import { useDesktopFilesGuestGate } from '@/hooks/useDesktopFilesGuestGate';
import { useVoiceDictationGate } from '@/hooks/useVoiceDictationGate';
import {
  getExecutionHarnessForModel,
  getProviderForModel,
} from '@canopy/desktop-shared/types';
import { mergeChatPluginSelections } from '@/lib/chatPluginSelections';
import type { ComposerPlusMenuProps } from '../shared/ComposerPlusMenu';
import type { ComposerMenuController } from '@/hooks/useComposerMenu';
import type { FileMentionOption } from '@canopy/ui-rich/types';
import { useComposerActions } from '@/hooks/useComposerActions';
import { isCursorModel } from '@canopy/execution-engine/lib/cursor-models';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type RefObject,
} from 'react';
import { useShallow } from 'zustand/shallow';
import type { ChatEditor } from '@canopy/ui-rich/types';
import { focusEditor } from '@canopy/ui-rich/editor';
import type {
  ApprovalMode,
  ChatTabPluginSelections,
  LinearTicketSearchResult,
  SlashCommandData,
} from '@canopy/desktop-shared/types';
import {
  PipelineIcon,
  PlanModeIcon,
  PluginsIcon,
  ScheduleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { LoadingSpinner } from '@canopy/ui-shared/components';
import { createEmptySelections } from '@/lib/pluginSelections';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useAutoModelRoutingAvailability } from '@/hooks/useAutoModelRouting';
import { importChatAttachments } from '@/lib/chatAttachments';
import { stageLinearTicketAttachment } from '@/lib/linearTicketStaging';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useProviderAvailability } from '@/hooks/useProviderAvailability';
import { resolveChatBillingFramework } from '@/lib/chatBillingFramework';
import { useVoiceTranscription } from '@/hooks/useVoiceTranscription';
import { createSlateVoiceTarget } from '@/lib/voice/insert-into-slate';
import {
  createOptionsForBranchTarget,
  resolveHomeEffectiveDefaults,
  resolveHomeEffectiveProviderType,
  isHomeSendEnabled,
  pluginSelectionsSignature,
  resolveHomeAttachmentWorktreeId,
  resolveHomeSpeed,
  useHomeComposerStore,
} from '@/stores/homeComposerStore';
import { useContextualCodexSpeedControl } from '@/hooks/useContextualCodexSpeedControl';
import { useCodexSpeedDowngrade } from '@/hooks/useCodexSpeedDowngrade';
import { useChatStore } from '@/stores/chatStore';
import {
  getApprovalDefaultsGeneration,
  subscribeApprovalDefaultsGeneration,
} from '@/stores/chat/approval-defaults';
import { useComposerShortcutRequests } from '@/hooks/useComposerShortcutRequests';
import type { ComposerShortcutScope } from '@/lib/composerShortcutRequests';
import { ApprovalModePicker } from '@/components/chat/ApprovalModePicker';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { VoiceRecordingRow } from '@/components/chat/VoiceRecordingRow';
import { useComposerChipsCompact } from '@/components/chat/ComposerLayout';
import {
  buildPlanModeChip,
  ChatComposerToolbarChip,
  ComposerSendButton,
  ThinkingLevelPanelPicker,
  nextCodexSpeed,
} from '@canopy/ui-shared';
import { useHoldToDictate } from '@/hooks/useHoldToDictate';
import { DICTATION_SHORTCUT_LABEL } from '@/lib/keyboardShortcuts';
import { ChatPluginsModal } from '@/components/chat/ChatPluginsModal';
import { ScheduleMessageModal } from '@/components/chat/ScheduleMessageModal';
import { AttachmentPillCarousel } from '@/components/chat/AttachmentPillCarousel';
import { VoiceInputButton } from '@/components/shared/VoiceInputButton';
import { VoiceDictationErrorModal } from '@/components/shared/VoiceDictationErrorModal';
import { ComposerPlusMenu } from '@/components/shared/ComposerPlusMenu';
import { LinearTicketPickerModal } from '@/components/shared/linear/LinearTicketPickerModal';
import { useHomeEffectiveModelSettings } from './useHomeEffectiveModelSettings';

interface HomeComposerActionMenuProps {
  composerMenu?: ComposerMenuController;
  searchFiles?: (query: string) => FileMentionOption[];
  onSelectFile?: (file: FileMentionOption) => void;

  disabled: boolean;
  isChatMode: boolean;
  isCodex: boolean;
  planMode: boolean;
  /** Cursor and Copilot present Plan mode as read-only mode. */
  planReadOnly: boolean;
  /** Pipeline mode: Send runs a pipeline instead of starting a chat. */
  pipelineMode: boolean;
  onTogglePipeline: () => void;
  /** The + trigger, for the Plan mode onboarding highlight. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  hasPluginSelections: boolean;
  commands: SlashCommandData[];
  discoveryLoading: boolean;
  onSelectCommand: (cmd: SlashCommandData) => void;
  onPickAttachment: () => void;
  onPickLinear: () => void;
  onOpenPlugins: () => void;
  pluginSelections: ComposerPlusMenuProps['pluginSelections'];
  onSelectPlugin: ComposerPlusMenuProps['onSelectPlugin'];
  providerScope: ComposerPlusMenuProps['providerScope'];
  onTogglePlanMode: () => void;
  scheduleDisabled: boolean;
  /** Tooltip body explaining why scheduling is unavailable (varies by the
   * disabling condition). */
  scheduleDisabledDescription: string;
  onOpenSchedule: () => void;
}

/**
 * Home's consolidated `+` menu. Plan mode, Pipeline and the secondary
 * composer actions live here, so the box's row holds only +, the model,
 * effort and permission, voice and send.
 */
function HomeComposerActionMenu({
  composerMenu,
  searchFiles,
  onSelectFile,
  disabled,
  isChatMode,
  planMode,
  planReadOnly,
  pipelineMode,
  onTogglePipeline,
  triggerRef,
  hasPluginSelections,
  commands,
  discoveryLoading,
  onSelectCommand,
  onPickAttachment,
  onPickLinear,
  onOpenPlugins,
  pluginSelections,
  onSelectPlugin,
  providerScope,
  onTogglePlanMode,
  scheduleDisabled,
  scheduleDisabledDescription,
  onOpenSchedule,
}: HomeComposerActionMenuProps): JSX.Element {
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);

  useCurrentUiStateReporter('home.toolbar', {
    plusMenuOpen,
  });

  function handleCommandSelect(cmd: SlashCommandData): void {
    onSelectCommand(cmd);
  }

  // Pipeline stays offered in pipeline mode, the way back to a chat.
  const pipelineItem = {
    id: 'pipeline',
    group: 'settings' as const,
    label: 'Workflow',
    description: pipelineMode
      ? 'Turn workflow mode off'
      : 'Run the task through predefined automated steps',
    value: pipelineMode ? 'On' : undefined,
    icon: <PipelineIcon size="sm" />,
    onSelect: onTogglePipeline,
    ariaChecked: pipelineMode,
    dataTestId: 'home-pipeline-mode-button',
  };
  const chatItems = isChatMode
    ? [
        // Plugins stay available for every harness: Cursor loads the MCP
        // servers a selection declares and the skills and commands it carries.
        {
          id: 'plugins',
          label: 'Plugins',
          icon: <PluginsIcon size="sm" />,
          onSelect: onOpenPlugins,
          ariaChecked: hasPluginSelections,
          dataTestId: 'home-plugins-button',
        },
        {
          id: 'schedule',
          label: 'Schedule message',
          icon: <ScheduleIcon size="sm" />,
          onSelect: onOpenSchedule,
          disabled: scheduleDisabled,
          dataTestId: 'home-schedule-button',
          disabledTooltip: {
            title: 'Scheduling unavailable',
            description: scheduleDisabledDescription,
          },
        },
        {
          id: 'plan-mode',
          label: planReadOnly ? 'Read-only mode' : 'Plan mode',
          description: planMode ? 'Turn plan mode off' : 'Turn plan mode on',
          value: planMode ? 'On' : undefined,
          icon: <PlanModeIcon size="sm" active={planMode} />,
          onSelect: onTogglePlanMode,
          ariaChecked: planMode,
          dataTestId: 'home-plan-mode-button',
        },
      ]
    : [];
  const additionalItems = [...chatItems, pipelineItem];

  return (
    <div className="relative shrink-0">
      <ComposerPlusMenu
        controller={composerMenu}
        placement="bottom-left"
        allowFlip={false}
        searchFiles={searchFiles}
        onSelectFile={onSelectFile}
        onPickAttachment={onPickAttachment}
        onPickLinear={onPickLinear}
        disabled={disabled}
        dataTestIdPrefix="home-composer"
        triggerRef={triggerRef}
        onOpenChange={(open): void => {
          setPlusMenuOpen(open);
        }}
        commands={isChatMode ? commands : []}
        includeCommandsInAddMenu
        pluginSelections={pluginSelections}
        onSelectPlugin={isChatMode ? onSelectPlugin : undefined}
        providerScope={providerScope}
        onSelectCommand={handleCommandSelect}
        isRefreshing={discoveryLoading}
        additionalItems={additionalItems}
        capsuleTrigger
        // Plan shows its own tile beside +; + lights only for Pipeline.
        active={pipelineMode}
        activeLabel="Workflow mode active"
      />
    </div>
  );
}

export interface HomeComposerControlsProps {
  /** Text-only replacements reset the hint without invalidating attachment imports. */
  hintDraftRevision?: number;
  composerMenu?: ComposerMenuController;
  searchFiles?: (query: string) => FileMentionOption[];
  onSelectFile?: (file: FileMentionOption) => void;

  composerActionScope?: ComposerShortcutScope;
  /** Slate editor instance owned by `HomeSurface`, used only as the voice
   * dictation insertion target. */
  editor: ChatEditor;
  /** True when there are no workspaces at all (composer fully disabled). */
  disabled: boolean;
  /** True only for the standalone Home page that owns global shortcuts. */
  shortcutEnabled: boolean;
  onSend: () => void;
  /** Re-syncs `HomeSurface`'s local editor value/text state after voice
   * dictation mutates the Slate editor directly. */
  onEditorExternallyChanged: () => void;
  /**
   * Task F2: the SAME merged discovered + available-to-enable command list
   * fed to the inline `/` typeahead in `HomeSurface` — owned there (via
   * `useHomeSlashCommands`) so both surfaces share one
   * `useInvocableInventory` subscription instead of double-fetching.
   */
  commands: SlashCommandData[];
  /** True while agent discovery is in flight (Commands popup spinner). */
  commandsRefreshing: boolean;
  /** Effective-model-derived provider flag from `useHomeSlashCommands`,
   * threaded down instead of being recomputed locally so every consumer
   * agrees on the same "Skills" vs. "Commands" label. */
  isCodex: boolean;
  /** Commands-popup selection handler owned by `HomeSurface` (mirrors the
   * inline menu's discovered-vs-available branch and preserves the draft). */
  onSelectCommand: (cmd: SlashCommandData) => void;
  /** The composer box, which the model and permission menus align to. */
  composerBoxRef?: RefObject<HTMLElement | null>;
  /** Reports when dictation starts and ends, so the editor can prompt for it. */
  onVoiceRecordingChange?: (recording: boolean) => void;
  /**
   * The plan mode suggestion (CAN-4008), for the surface to draw as the tip
   * in the composer's top drawer; null once this composer unmounts.
   */
  onPlanModeHintChange?: (hint: PlanModeSuggestion | null) => void;
}

/**
 * Home composer's controls, in the box's bottom row: `+` and, while Plan mode
 * is on, its tile; then the model and its effort (truncating as the box
 * narrows), then the permission level, voice and send. The selectors take
 * the chat composer's look (no chevrons, the effort panel with fast mode, the
 * permission named). Plugins, commands/skills, scheduling, Plan mode and
 * Pipeline live in the `+` menu.
 * Project and branch context remain above—not inside—the composer.
 */
export function HomeComposerControls({
  hintDraftRevision = 0,
  composerMenu,
  searchFiles,
  onSelectFile,
  composerActionScope,
  editor,
  disabled,
  shortcutEnabled,
  onSend,
  onEditorExternallyChanged,
  commands,
  commandsRefreshing,
  isCodex,
  onSelectCommand,
  composerBoxRef,
  onVoiceRecordingChange,
  onPlanModeHintChange,
}: HomeComposerControlsProps): JSX.Element {
  const providerAvailability = useProviderAvailability();

  const {
    workspaceId,
    draftGeneration,
    mode,
    model,
    modelSelectionMode,
    setModelSelectionMode,
    executionHarness,
    thinkingLevel,
    speed,
    fastMode,
    planMode,
    approvalMode,
    pluginSelections,
    selectedRepoId,
    attachments,
    pendingAttachmentImportIds,
    text,
    isSending,
    scheduledSendDraft,
    setModel,
    setThinkingLevel,
    setSpeed,
    cycleThinkingLevel,
    togglePlanMode,
    setApprovalMode,
    setPluginSelections,
    addAttachments,
    removeAttachment,
    setSendError,
    loadDiscovery,
    setScheduledSendDraft,
  } = useHomeComposerStore(
    useShallow((s) => ({
      workspaceId: s.workspaceId,
      draftGeneration: s.draftGeneration,
      mode: s.mode,
      model: s.model,
      modelSelectionMode: s.modelSelectionMode,
      setModelSelectionMode: s.setModelSelectionMode,
      executionHarness: s.executionHarness,
      thinkingLevel: s.thinkingLevel,
      speed: s.speed,
      fastMode: s.fastMode,
      planMode: s.planMode,
      approvalMode: s.approvalMode,
      pluginSelections: s.pluginSelections,
      selectedRepoId: s.selectedRepoId,
      attachments: s.attachments,
      pendingAttachmentImportIds: s.pendingAttachmentImportIds,
      text: s.text,
      isSending: s.isSending,
      scheduledSendDraft: s.scheduledSendDraft,
      setModel: s.setModel,
      setThinkingLevel: s.setThinkingLevel,
      setSpeed: s.setSpeed,
      cycleThinkingLevel: s.cycleThinkingLevel,
      togglePlanMode: s.togglePlanMode,
      setApprovalMode: s.setApprovalMode,
      setPluginSelections: s.setPluginSelections,
      addAttachments: s.addAttachments,
      removeAttachment: s.removeAttachment,
      setSendError: s.setSendError,
      loadDiscovery: s.loadDiscovery,
      setScheduledSendDraft: s.setScheduledSendDraft,
    })),
  );

  const [commandModelPickerOpenSignal, setCommandModelPickerOpenSignal] =
    useState(0);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [linearPickerOpen, setLinearPickerOpen] = useState(false);
  const [pluginsModalOpen, setPluginsModalOpen] = useState(false);
  const plusTriggerRef = useRef<HTMLButtonElement>(null);

  const isCowork = workspaceId !== null && isCoworkChatTarget(workspaceId);
  const autoRouting = useAutoModelRoutingAvailability();
  const autoSelected = modelSelectionMode === 'auto';
  const handleSelectAuto = useCallback((): void => {
    setModelSelectionMode('auto');
  }, [setModelSelectionMode]);
  const autoPickerOption = useMemo(() => {
    if (!autoRouting.offered) return undefined;
    return {
      selected: autoSelected,
      onSelect: handleSelectAuto,
      ...(autoRouting.unavailableReason
        ? { unavailableReason: autoRouting.unavailableReason }
        : {}),
      ...(autoRouting.unavailableAction
        ? { unavailableAction: autoRouting.unavailableAction }
        : {}),
    };
  }, [
    autoRouting.offered,
    autoRouting.unavailableAction,
    autoRouting.unavailableReason,
    autoSelected,
    handleSelectAuto,
  ]);
  const isChatMode = mode === 'chat';

  // ⌥M / ⌥T (ECW-7984 follow-up). The standalone and embedded Home surfaces
  // can be mounted concurrently; only the standalone page is visible while
  // the global handler emits the `home` scope.
  const composerShortcutTarget = useMemo(
    (): ComposerShortcutScope | null =>
      isChatMode && shortcutEnabled ? { scope: 'home' } : null,
    [isChatMode, shortcutEnabled],
  );

  const effectiveSettings = useHomeEffectiveModelSettings(
    workspaceId,
    model,
    thinkingLevel,
  );
  const {
    model: effectiveModel,
    thinkingLevel: effectiveThinkingLevel,
    supportedThinkingLevels,
  } = effectiveSettings;
  // `effectiveSettings` is re-resolved whenever the defaults' inputs change,
  // so it stands in for them here.
  const inheritedDefaultModel = useMemo(
    () => resolveHomeEffectiveDefaults(workspaceId).model,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, effectiveSettings],
  );
  // Home has no chat yet: a model's billing menu sets the billing the next
  // chat starts with, the same value a credits pick used to remember.
  const nextChatBilling = useChatStore(
    (s) => s.modelDefaults?.billingFramework,
  );
  // Home obeys the same eligibility as an existing chat. A remembered explicit
  // subscription choice stays honored; a fresh signed-out choice cannot bypass
  // the credits lock merely because its chat has not been created (CAN-5349).
  const billingProvider = getProviderForModel(effectiveModel) ?? 'claude';
  const billingResolution = resolveChatBillingFramework({
    model: effectiveModel,
    provider: billingProvider,
    availability: providerAvailability[billingProvider],
    aiCreditsRoutingActive: nextChatBilling === 'ai-credits',
    subscriptionBillingOverride: nextChatBilling === 'subscription',
    routingActiveForChat: false,
  });
  // The exact speed the next chat requests: the staged choice, then the
  // Codex default; `undefined` for providers without a Codex speed.
  const resolvedSpeed = resolveHomeSpeed(
    effectiveModel,
    { speed, fastMode },
    executionHarness,
  );
  const speedControl = useContextualCodexSpeedControl({
    enabled: resolvedSpeed !== undefined,
    context: {
      kind: 'home',
      ...(workspaceId ? { projectId: workspaceId } : {}),
      billingFramework: nextChatBilling,
      executionHarness:
        executionHarness === 'antigravity' ||
        executionHarness === 'copilot' ||
        executionHarness === 'opencode'
          ? undefined
          : executionHarness,
    },
    route: {
      model: effectiveModel,
      auto: autoSelected,
      capturedHarness: executionHarness,
      aiCreditsRouted: nextChatBilling === 'ai-credits',
    },
  });
  // A model that cannot run Ultra fast steps the draft down to Fast (or
  // Regular) rather than staging a choice the new chat would be refused.
  const downgradedSpeed = useCodexSpeedDowngrade({
    enabled: resolvedSpeed !== undefined,
    speed: resolvedSpeed ?? 'standard',
    control: speedControl,
    apply: setSpeed,
  });
  const effectiveSpeed =
    resolvedSpeed === undefined ? undefined : downgradedSpeed;
  // Quick cycle through the speeds this draft can run: Regular → Fast →
  // Ultra fast, where the route offers it.
  const cycleSpeed = (): void => {
    if (effectiveSpeed === undefined) return;
    setSpeed(nextCodexSpeed(effectiveSpeed, speedControl.states));
  };
  const approvalDefaultForWorkspace = useChatStore((s) =>
    workspaceId ? s.approvalDefaultsCache[workspaceId] : undefined,
  );
  const approvalDefaultsGeneration = useSyncExternalStore(
    subscribeApprovalDefaultsGeneration,
    getApprovalDefaultsGeneration,
    getApprovalDefaultsGeneration,
  );
  const [approvalDefaultLookupResult, setApprovalDefaultLookupResult] =
    useState<{
      workspaceId: string;
      requestId: number;
      generation: number;
      mode: ApprovalMode;
    } | null>(null);
  const approvalDefaultSelectionRef = useRef({ workspaceId, requestId: 0 });
  if (approvalDefaultSelectionRef.current.workspaceId !== workspaceId) {
    approvalDefaultSelectionRef.current = {
      workspaceId,
      requestId: approvalDefaultSelectionRef.current.requestId + 1,
    };
  }
  const approvalDefaultRequestId =
    approvalDefaultSelectionRef.current.requestId;
  const settledApprovalDefault =
    approvalDefaultLookupResult?.workspaceId === workspaceId &&
    approvalDefaultLookupResult?.requestId === approvalDefaultRequestId &&
    approvalDefaultLookupResult?.generation === approvalDefaultsGeneration
      ? approvalDefaultLookupResult.mode
      : undefined;
  const effectiveApprovalMode: ApprovalMode | undefined =
    approvalMode ?? approvalDefaultForWorkspace ?? settledApprovalDefault;

  useEffect(() => {
    if (!workspaceId) return;
    if (workspaceId in useChatStore.getState().approvalDefaultsCache) return;
    let active = true;
    void useChatStore
      .getState()
      .fetchApprovalDefault(workspaceId)
      .then((mode): void => {
        if (
          !active ||
          approvalDefaultsGeneration !== getApprovalDefaultsGeneration()
        ) {
          return;
        }
        setApprovalDefaultLookupResult({
          workspaceId,
          requestId: approvalDefaultRequestId,
          generation: approvalDefaultsGeneration,
          mode,
        });
      });
    return (): void => {
      active = false;
    };
  }, [
    approvalDefaultForWorkspace,
    approvalDefaultRequestId,
    approvalDefaultsGeneration,
    workspaceId,
  ]);
  const sendDisabled =
    disabled ||
    isSending ||
    pendingAttachmentImportIds.length > 0 ||
    !workspaceId ||
    !isHomeSendEnabled(mode, text, attachments);

  // Reload discovery (slash commands, MCP servers) whenever the workspace,
  // branch target, working directory, model provider, or plugin selections
  // change. Complex store values use stable string signatures for
  // dependency-array comparison.
  const branchTarget = useHomeComposerStore((s) => s.branchTarget);
  const branchTargets = useHomeComposerStore((s) => s.branchTargets);
  // `pr`/`linear-issue` intentionally collapse to the `new-worktree` key: like
  // `new-worktree` they discover against the default-branch baseline shadow (no
  // worktree exists yet — see `resolveHomeDiscoveryTarget`), so they reload
  // discovery on the same key.
  const branchTargetKey =
    branchTarget.kind === 'worktree'
      ? `worktree:${branchTarget.worktreeId}`
      : branchTarget.kind === 'branch'
        ? `branch:${branchTarget.branchName}:${String(branchTarget.isRemote)}`
        : 'new-worktree';
  const pluginSelectionsKey = pluginSelectionsSignature(pluginSelections);
  useEffect(() => {
    if (!workspaceId) return;
    void loadDiscovery();
    // `isCodex` (from `useHomeSlashCommands` in `HomeSurface`, already
    // resolved against the EFFECTIVE model per the Task F2 carry-forward
    // fix) distinguishes the discovery providers; the store clears discovery
    // for Cursor without loading any.
  }, [
    workspaceId,
    branchTargetKey,
    selectedRepoId,
    isCodex,
    pluginSelectionsKey,
    loadDiscovery,
  ]);

  // Scheduled sends that provision a new worktree/branch/PR/Linear-issue fire
  // the `worktree_prompt` automation action, and scheduled cowork sends fire
  // `standalone_prompt` — neither carries attachment fields (there is no
  // target chat/worktree to stage them in until fire time) — see homeSend.ts.
  const scheduleDisabledByAttachments =
    attachments.length > 0 &&
    (isCowork ||
      branchTarget.kind === 'new-worktree' ||
      branchTarget.kind === 'branch' ||
      branchTarget.kind === 'pr' ||
      branchTarget.kind === 'linear-issue');

  // A `linear-issue` target whose suggested branch does not exist yet resolves
  // to a create-new-named-branch (`{ branchName }`), which `worktree_prompt`'s
  // persisted wire shape cannot defer to fire time. (`baseBranch` selects
  // ancestry for an otherwise fresh branch; it is not the new branch's name.)
  // The homeSend guard rejects that schedule; disable the control here so the
  // UI communicates it up front. `createOptionsForBranchTarget` returning a
  // `branchName` (vs `existingBranch`/`undefined`) is exactly the create-new case.
  const scheduleDisabledByMissingLinearBranch =
    branchTarget.kind === 'linear-issue' &&
    createOptionsForBranchTarget(branchTarget, branchTargets?.branches ?? [])
      ?.branchName !== undefined;
  const scheduleDisabledByCursor = isCursorModel(effectiveModel);
  const scheduleDisabled =
    scheduleDisabledByCursor ||
    scheduleDisabledByAttachments ||
    scheduleDisabledByMissingLinearBranch;
  const scheduleDisabledDescription = scheduleDisabledByCursor
    ? 'Cursor currently supports interactive chats only. Choose another model to schedule this message.'
    : scheduleDisabledByMissingLinearBranch
      ? 'Scheduling is not available for a Linear issue whose branch does not exist yet. Send now, or pick its PR or an existing branch.'
      : "Attachments (including Linear tickets) aren't supported for scheduled sends to this destination yet";

  useCurrentUiStateReporter('home.controls', {
    executionHarness:
      executionHarness ?? getExecutionHarnessForModel(effectiveModel) ?? null,
    scheduleModalOpen,
    linearPickerOpen,
    pluginsModalOpen,
    scheduleDisabledByAttachments,
    scheduleDisabledByCursor,
  });

  const draftWorktreeId = resolveHomeAttachmentWorktreeId(
    isCowork,
    branchTarget,
  );

  const filesGuestGate = useDesktopFilesGuestGate(
    `${workspaceId}/${branchTargetKey}`,
  );
  async function handleImportAttachments(): Promise<void> {
    if (filesGuestGate.interceptAttachment() || disabled || !workspaceId)
      return;
    const isCurrent = filesGuestGate.captureAccess();
    const importToken = useHomeComposerStore.getState().beginAttachmentImport();
    const target = { projectId: workspaceId, worktreeId: draftWorktreeId };
    try {
      const imported = await importChatAttachments(
        target,
        [],
        undefined,
        isCurrent,
      );
      const store = useHomeComposerStore.getState();
      if (!isCurrent() || store.draftGeneration !== importToken.draftGeneration)
        return;
      addAttachments(imported);
      setSendError(null);
    } catch {
      // Surface the failure instead of letting the fire-and-forget `void`
      // swallow it — a rejected import otherwise leaves no UI trace at all.
      if (
        isCurrent() &&
        useHomeComposerStore.getState().draftGeneration ===
          importToken.draftGeneration
      )
        setSendError('Failed to import attachments. Please try again.');
    } finally {
      useHomeComposerStore.getState().finishAttachmentImport(importToken);
    }
  }

  useComposerActions(
    composerActionScope ?? composerShortcutTarget,
    {
      plugins: () => setPluginsModalOpen(true),
      attach: () => {
        void handleImportAttachments();
      },
      model: () => {
        setCommandModelPickerOpenSignal((signal) => signal + 1);
      },
      thinking: cycleThinkingLevel,
      plan: togglePlanMode,
      ...(effectiveSpeed !== undefined ? { fast: cycleSpeed } : {}),
      ...(scheduleDisabled
        ? {}
        : { schedule: (): void => setScheduleModalOpen(true) }),
      pipeline: () => useHomeComposerStore.getState().setMode('pipeline'),
    },
    !disabled && isChatMode,
  );

  /**
   * Stages a picked Linear ticket as a snapshot-markdown attachment, using
   * the same draft target `handleImportAttachments` resolves to (the
   * `draftWorktreeId` sentinel dance above). Surfaces failures the same way
   * attachment-import failures are surfaced today.
   */
  async function handleSelectLinearTicket(
    ticket: LinearTicketSearchResult,
  ): Promise<void> {
    if (!workspaceId) return;
    const target = { projectId: workspaceId, worktreeId: draftWorktreeId };
    try {
      await stageLinearTicketAttachment(target, ticket, addAttachments);
      setSendError(null);
    } catch {
      setSendError('Failed to attach Linear ticket. Please try again.');
    }
  }

  // Voice dictation. Same gating as ChatInput: feature-detect on mount and
  // respect the user's dictation preference; the mic button is simply
  // omitted when unsupported so there's no dead affordance.
  const { voiceSupported, voiceEnabledPref } = useVoiceDictationGate();

  const voiceTarget = useMemo(() => createSlateVoiceTarget(editor), [editor]);
  const voice = useVoiceTranscription({
    target: voiceTarget,
    onFinalCommitted: (): void => {
      onEditorExternallyChanged();
    },
  });

  // Hold ⌃M to dictate (a tap leaves the take running hands-free).
  const holdToDictate = useHoldToDictate(voice);
  const modelPickerOpenSignal = useComposerShortcutRequests({
    target: composerShortcutTarget,
    onCycleEffort: cycleThinkingLevel,
    ...(voiceSupported && voiceEnabledPref ? holdToDictate : {}),
    enabled: shortcutEnabled && !disabled,
  });
  // Dictation owns the box's bottom row while it runs (see VoiceRecordingRow).
  const voiceRecording =
    voice.state === 'connecting' || voice.state === 'listening';
  useEffect(() => {
    if (!voiceRecording) return undefined;
    onVoiceRecordingChange?.(true);
    return (): void => onVoiceRecordingChange?.(false);
  }, [voiceRecording, onVoiceRecordingChange]);
  // The recording row replaces the microphone that had focus, so Escape
  // discards the take from anywhere in the window, not only the editor.
  useEffect(() => {
    if (!voiceRecording) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      void voice.cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [voiceRecording, voice]);
  // Send from the recording row: stop the take, and send once its final words
  // have landed in the draft (the session reports idle after committing them).
  const sendAfterVoiceRef = useRef(false);
  useEffect(() => {
    if (!sendAfterVoiceRef.current) return;
    if (voice.state === 'error') {
      sendAfterVoiceRef.current = false;
      return;
    }
    if (voice.state !== 'idle') return;
    sendAfterVoiceRef.current = false;
    onSend();
  }, [voice.state, onSend]);

  // Plan controls retain their existing toggle behavior.
  const handleTogglePlanMode = useCallback((): void => {
    togglePlanMode();
  }, [togglePlanMode]);

  // One provider for the + menu's scope and Plan's presentation: Cursor and
  // Copilot call Plan read-only mode, as in a chat.
  const effectiveProviderType = resolveHomeEffectiveProviderType(
    workspaceId,
    model,
    executionHarness,
  );
  const planReadOnly = isPlanModeReadOnly(effectiveProviderType);
  // While Plan is on, its tile sits beside + and turns it off in one click,
  // as in a chat. Pipeline hides it; Plan stays on for the way back. A narrow
  // box draws it as the glyph alone, at the chat composer's breakpoint.
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(
    null,
  );
  const chipsCompact = useComposerChipsCompact(toolbarElement);
  const hintRootRef = useRef<HTMLDivElement>(null);
  const activity = useComposerHintActivity(
    composerBoxRef ?? hintRootRef,
    !disabled,
  );
  const hint = usePlanModeSuggestion({
    suggestionsClaimApi: useSuggestionsClaimApi(),
    text,
    draftKey: `home:${workspaceId}:${selectedRepoId}:${draftGeneration}:${hintDraftRevision}`,
    activationKey: effectiveProviderType,
    planMode,
    planAvailable: isChatMode && !isCowork && !disabled,
    planReadOnly,
    pipelineMode: !isChatMode,
    ...activity,
    store: getPlanModeHintStore(),
    onEnablePlanMode: () => {
      const current = useHomeComposerStore.getState();
      if (
        current.workspaceId !== workspaceId ||
        current.mode !== 'chat' ||
        resolveHomeEffectiveProviderType(
          current.workspaceId,
          current.model,
          current.executionHarness,
        ) !== effectiveProviderType
      )
        return false;
      if (!current.planMode) current.togglePlanMode();
      return useHomeComposerStore.getState().planMode;
    },
    focusComposer: () => focusEditor(editor),
    onShown: () => trackPlanModeHintAction('shown', 'home'),
    onAccepted: () => trackPlanModeHintAction('accepted', 'home'),
    onDismissed: () => trackPlanModeHintAction('dismissed', 'home'),
  });
  // The drawer that holds the tip belongs to the surface, outside this box.
  const { visible: hintVisible, pending: hintPending } = hint;
  const { accept: acceptHint, dismiss: dismissHint } = hint;
  useEffect(() => {
    onPlanModeHintChange?.({
      visible: hintVisible,
      pending: hintPending,
      accept: acceptHint,
      dismiss: dismissHint,
    });
  }, [onPlanModeHintChange, hintVisible, hintPending, acceptHint, dismissHint]);
  useEffect(
    () => (): void => onPlanModeHintChange?.(null),
    [onPlanModeHintChange],
  );
  const planChip =
    isChatMode && planMode
      ? buildPlanModeChip({
          readOnly: planReadOnly,
          compact: chipsCompact,
          disabled,
          dataTestId: 'home-plan-mode-inline-button',
          onDisable: (): void => {
            handleTogglePlanMode();
            focusEditor(editor);
          },
        })
      : null;

  return (
    <>
      {/* Measures visibility when the surface passes no composer box. */}
      <div ref={hintRootRef} />
      {attachments.length > 0 && (
        <AttachmentPillCarousel
          attachments={attachments}
          onRemove={removeAttachment}
        />
      )}

      {/* Dictation replaces the whole toolbar, as in the chat composer, so
          the recording row spans the box and its waveform fills the gap. */}
      {voiceRecording ? (
        <VoiceRecordingRow
          readLevel={voice.readLevel}
          listeningSince={voice.listeningSince}
          onCancel={(): void => void voice.cancel()}
          onStop={(): void => void voice.stop()}
          onSend={(): void => {
            sendAfterVoiceRef.current = true;
            void voice.stop();
          }}
        />
      ) : (
        <div
          ref={setToolbarElement}
          data-testid="home-composer-toolbar"
          className="flex items-center justify-between gap-2 p-2"
        >
          <HomeComposerActionMenu
            composerMenu={composerMenu}
            searchFiles={searchFiles}
            onSelectFile={onSelectFile}
            disabled={disabled}
            isChatMode={isChatMode}
            isCodex={isCodex}
            planMode={planMode}
            planReadOnly={planReadOnly}
            pipelineMode={mode === 'pipeline'}
            onTogglePipeline={(): void =>
              useHomeComposerStore
                .getState()
                .setMode(mode === 'pipeline' ? 'chat' : 'pipeline')
            }
            triggerRef={plusTriggerRef}
            hasPluginSelections={
              (pluginSelections?.collectionIds.length ?? 0) > 0 ||
              (pluginSelections?.skillRefs.length ?? 0) > 0 ||
              (pluginSelections?.pluginRefs.length ?? 0) > 0 ||
              (pluginSelections?.mcpServerRefs?.length ?? 0) > 0
            }
            commands={commands}
            discoveryLoading={commandsRefreshing}
            onSelectCommand={onSelectCommand}
            onPickAttachment={(): void => void handleImportAttachments()}
            onPickLinear={() => setLinearPickerOpen(true)}
            pluginSelections={pluginSelections ?? undefined}
            providerScope={effectiveProviderType ?? 'mixed'}
            onSelectPlugin={(ref, { label, enabled }): void => {
              composerMenu?.insertPlugin({ ...ref, label });
              if (enabled) return;
              // Merge into the store's live draft, not this render's snapshot.
              setPluginSelections(
                mergeChatPluginSelections(
                  useHomeComposerStore.getState().pluginSelections ??
                    createEmptySelections(),
                  { ...createEmptySelections(), pluginRefs: [ref] },
                ),
              );
            }}
            onOpenPlugins={() => setPluginsModalOpen(true)}
            onTogglePlanMode={handleTogglePlanMode}
            scheduleDisabled={scheduleDisabled}
            scheduleDisabledDescription={scheduleDisabledDescription}
            onOpenSchedule={() => setScheduleModalOpen(true)}
          />
          {planChip ? (
            <div className="flex shrink-0 items-center">
              <ChatComposerToolbarChip {...planChip} />
            </div>
          ) : null}

          {/* The task settings sit in the box: the model and its effort
                after +, truncating as the box narrows; the permission level
                before voice and send. */}
          <div
            data-testid="home-composer-settings"
            className="flex min-w-0 flex-1 items-center gap-0"
          >
            {isChatMode && (
              <>
                <div
                  // Nothing on the row collapses: the model name truncates as
                  // the row narrows, its icon folding away at the first ellipsis.
                  className="relative flex min-w-0 items-center"
                >
                  <ModelPicker
                    key={draftGeneration}
                    recoveryTarget={homeModelRecoveryTarget(
                      useHomeComposerStore.getState,
                    )}
                    separateAgents
                    selectionModel={autoSelected ? undefined : model}
                    browserLayout="harnesses"
                    allowAntigravity={Boolean(workspaceId)}
                    allowCursor={Boolean(workspaceId)}
                    allowCopilot={Boolean(workspaceId)}
                    allowOpenCode={Boolean(workspaceId)}
                    currentModel={effectiveModel}
                    inheritedDefaultModel={inheritedDefaultModel}
                    executionHarness={executionHarness}
                    executionHarnessExplicitlyChosen={
                      executionHarness !== undefined
                    }
                    onModelChange={(
                      selectedModel,
                      billingFramework,
                      harness,
                    ): void => {
                      setModel(selectedModel, billingFramework, harness);
                    }}
                    billing={{
                      value: billingResolution.framework ?? nextChatBilling,
                      provider: billingProvider,
                      disabled: billingResolution.toggleDisabled,
                      lockedReason: billingResolution.lockedReason,
                      lockKind: billingResolution.lockKind,
                      onChange: (framework): void =>
                        useChatStore
                          .getState()
                          .rememberBillingFramework(framework),
                    }}
                    {...(autoPickerOption ? { auto: autoPickerOption } : {})}
                    providerAvailability={providerAvailability}
                    disabled={disabled}
                    capsule
                    allowTriggerShrink
                    foldTriggerIconWhenTight
                    foldTriggerIconOnTruncate
                    hideTriggerChevron
                    {...(composerBoxRef
                      ? {
                          menuAlignRef: composerBoxRef,
                          menuAlignEdge: 'left' as const,
                        }
                      : {})}
                    openSignal={
                      modelPickerOpenSignal + commandModelPickerOpenSignal
                    }
                    onRestoreFocus={(): void => {
                      // Restore after the floating menu finishes focusing its trigger.
                      requestAnimationFrame(() => focusEditor(editor));
                    }}
                    triggerTooltip="Model for this task"
                  />
                </div>
                {/* Tri-state contract: an explicit empty supported set
                      means the model does not think, so the control is
                      hidden entirely (matching the web composer). An absent
                      declaration already resolved to the provider fallback
                      upstream. */}
                {supportedThinkingLevels.length > 0 && (
                  <ThinkingLevelPanelPicker
                    testId="home-thinking-level-button"
                    // Every level the model declares, None and Low
                    // included.
                    value={effectiveThinkingLevel}
                    supportedLevels={supportedThinkingLevels}
                    includeLow
                    onChange={(next): void => {
                      if (next !== undefined) setThinkingLevel(next);
                    }}
                    disabled={disabled}
                    allowTriggerShrink
                    hideTriggerChevron
                    // Opens over its own trigger, 8px left of its edge.
                    menuAlignEdge="left"
                    menuAlignOffset={-8}
                    // Fast mode rides in the effort panel, for models that
                    // offer it; Ultra fast is its third, purple state.
                    {...(effectiveSpeed !== undefined
                      ? {
                          fastMode: {
                            on: effectiveSpeed !== 'standard',
                            ultra: effectiveSpeed === 'ultrafast',
                            disabled,
                            onToggle: cycleSpeed,
                          },
                        }
                      : {})}
                  />
                )}
              </>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isChatMode && (
              <>
                {effectiveApprovalMode ? (
                  <ApprovalModePicker
                    mode={effectiveApprovalMode}
                    onChange={setApprovalMode}
                    disabled={disabled}
                    hideTriggerIcon
                    hideTriggerChevron
                    {...(composerBoxRef
                      ? {
                          menuAlignRef: composerBoxRef,
                          menuAlignEdge: 'right' as const,
                        }
                      : {})}
                  />
                ) : workspaceId ? (
                  <span
                    role="status"
                    aria-label="Loading tool approval mode"
                    data-testid="home-approval-mode-loading"
                    className="inline-flex h-5 w-11 shrink-0 items-center justify-center rounded-md"
                  >
                    <LoadingSpinner decorative tone="tertiary" />
                  </span>
                ) : null}
              </>
            )}
            {voiceSupported && voiceEnabledPref && (
              <VoiceInputButton
                state={voice.state}
                error={voice.error}
                onStart={(): void => void voice.start()}
                onStop={(): void => void voice.stop()}
                disabled={disabled}
                capsule
                shortcut={DICTATION_SHORTCUT_LABEL}
              />
            )}
            <ComposerSendButton
              kind="send"
              onSend={onSend}
              disabled={sendDisabled}
              pending={false}
              dataTestId="home-send-button"
            />
          </div>
        </div>
      )}

      <VoiceDictationErrorModal
        guidance={voice.errorGuidance}
        onDismiss={voice.dismissError}
      />

      {pluginsModalOpen && (
        <ChatPluginsModal
          effectiveProviderType={
            effectiveModel === 'cursor-default' ? 'cursor' : undefined
          }
          initial={pluginSelections ?? createEmptySelections()}
          onSave={(selections: ChatTabPluginSelections) => {
            setPluginSelections(selections);
            setPluginsModalOpen(false);
          }}
          onClose={() => setPluginsModalOpen(false)}
        />
      )}

      {scheduleModalOpen && (
        <ScheduleMessageModal
          initialRunAt={scheduledSendDraft?.runAt}
          onCancel={(): void => setScheduleModalOpen(false)}
          onSave={(runAtIso: string): void => {
            setScheduledSendDraft({ runAt: runAtIso });
            setScheduleModalOpen(false);
          }}
        />
      )}

      {linearPickerOpen && (
        <LinearTicketPickerModal
          onSelect={(ticket): void => void handleSelectLinearTicket(ticket)}
          onClose={() => setLinearPickerOpen(false)}
        />
      )}
    </>
  );
}
