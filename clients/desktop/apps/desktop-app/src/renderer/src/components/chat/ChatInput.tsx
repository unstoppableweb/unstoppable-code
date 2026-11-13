import { useSuggestionsClaimApi } from '@canopy/ui-app/suggestions';
import { useDesktopFilesGuestGate } from '@/hooks/useDesktopFilesGuestGate';
import {
  isPlanModeReadOnly,
  isGenuinePlanModeUse,
} from '@canopy/ui-shared/lib/plan-mode-suggestion';
import {
  GitHubStarPrompt,
  PlanModeHint,
  useGitHubStarPrompt,
  usePlanModeSuggestion,
  useComposerHintActivity,
  type ComposerMenuCommandOutcome,
  type ComposerMenuPick,
} from '@canopy/ui-app';
import { getPlanModeHintStore } from '@/lib/planModeHint';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import {
  subscribePlanWorkflowRequests,
  takePlanWorkflowRequest,
} from '@/lib/chat/plan-workflow-request';
import { trackPlanModeHintAction } from '@/lib/planModeHintTelemetry';
import { getGitHubStarPromptStore } from '@/lib/githubStarPrompt';
import { trackGitHubStarPromptAction } from '@/lib/githubStarPromptTelemetry';
import { useGitHubStarPromptLogin } from '@/hooks/useGitHubStarPromptLogin';
import {
  COMPACT_CHIPS_BREAKPOINT_REM,
  COMPACT_CHIPS_HYSTERESIS_REM,
  CHAT_COMPOSER_MIN_TEXT_WIDTH_PX,
  ComposerStatusRow,
  expandedComposerEditorContainerClassName,
  ONE_LINE_COMPOSER_CLASS_NAMES,
  TERMINAL_MODE_ERROR_SHELL_CLASS,
  TERMINAL_MODE_SHELL_CLASS,
  TerminalModeLabel,
  useAnimatedComposerBox,
  useOneLineComposer,
  VOICE_TAKE_EDITOR_CONTAINER_CLASS,
  offeredPromptSuggestion,
  promptSuggestionKeyAction,
  PromptSuggestionKeyHint,
} from '@canopy/ui-shared';
import { PROMPT_SUGGESTIONS_EXPERIMENT_ID } from '@canopy/desktop-shared/lib/labs-experiments';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import {
  usePromptSuggestionEntry,
  usePromptSuggestionStore,
} from '@/stores/promptSuggestionStore';
import { isClaudeTurnLimitMessage } from '@canopy/agent-transcript';
import {
  ComposerWorkDrawer,
  LifetimeLimitNotice,
  PortalModelPicker,
} from '@canopy/ui-app';
import { deriveChatWorkflowCapabilities } from '@canopy/app-core';
import {
  ComposerTipArbiterProvider,
  UnresolvedCapabilitySelection,
} from '@canopy/ui-shared/components';
import { pickProvider } from '@/lib/pickProvider';
import { useComposerMenu } from '@/hooks/useComposerMenu';
import {
  buildComposerCommands,
  getComposerAction,
} from '@/lib/composerCommands';
import { requestModelPickerOpen } from '@/lib/composerShortcutRequests';
import {
  consumeChatPanelReveal,
  subscribeChatPanelReveal,
} from '@/lib/chatPanelReveal';
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  QuestionPrompt,
  QuestionSkipButton,
} from '@canopy/ui-shared/components/chat/QuestionPrompt';
import { questionPromptPlaceholder } from '@canopy/ui-shared/components/chat/useQuestionPrompt';
import {
  setQuestionPromptClosed,
  useQuestionPromptClosed,
} from '@canopy/ui-shared/components/chat/question-prompt-progress';
import { isTypingOutside } from './ComposerPrompt';
import {
  useComposerQuestionPrompt,
  type ComposerPendingQuestion,
  type ComposerQuestionDelivery,
} from './useComposerQuestionPrompt';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useComposerQuestions } from './useComposerQuestions';
import {
  Editor,
  Element as SlateElement,
  Node as SlateNode,
  type Descendant,
  Transforms,
} from 'slate';
import { ReactEditor } from 'slate-react';
import {
  clearResumedChatUsageLimitBanner,
  resolveLaneForTarget,
  resolveTabDefaults,
  useChatStore as useLiveChatStore,
  useChatTabRenderState,
  type ChatRenderTarget,
  type ChatTab,
  type PendingPlanExit,
} from '@/stores/chatStore';
import type { QueuedWithoutDispatchLocation } from '@/stores/chat/types';
import {
  useChatSurfaceScope,
  useChatSurfaceStore,
} from '@/stores/chat/surface-store';
import {
  approvalDefaultCacheKey,
  getApprovalDefaultsGeneration,
  subscribeApprovalDefaultsGeneration,
} from '@/stores/chat/approval-defaults';
import {
  useCancelRunningChatShortcut,
  useCancelShortcutConfirmationStore,
} from './useCancelRunningChatShortcut';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useResourceMonitorStore } from '@/stores/resourceMonitorStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import {
  getRendererBillingLaneFactsVersion,
  subscribeRendererBillingLaneFacts,
} from '@/stores/billingLaneRuntime';
import {
  getRendererModelFactsVersion,
  getRendererModelPolicy,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import {
  chatInheritsProjectDefaults,
  chatSurfaceUsesGlobalPluginDefaults,
  effectiveChatPluginSelections,
  splitChosenChatPluginSelections,
  subtractPluginSelections,
  unionPluginSelections,
  type InheritedPluginLayers,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { queueDesktopTryItSelectionUpdate } from '@/lib/tryItContinuationRunner';
import {
  getProjectPluginDefaults,
  getProjectPluginTombstones,
} from '@/stores/chat/tab-utils';
import { inheritedDefaultLayers } from '@/lib/chatPluginEditing';
import { brandText, getBrandSourceRepository } from '@/lib/brand';
import { isCoworkChatTarget } from '@/lib/cowork';
import { isWebCoreScope, webCoreLocalId } from '@/lib/chat-authority';
import { CloudChatPluginsPicker } from '@/cloud-chats/CloudChatPluginsPicker';
import { CloudTaskCreationNotice } from '@/cloud-chats/CloudTaskCreationNotice';
import { loadWebCoreModels, webCoreChatId } from '@/stores/chat/web-core';
import { useWebCoreFastModeStore } from '@/stores/chat/web-core/fast-mode';
import type { CodexSpeed } from '@canopy/protocol/automations';
import {
  useWebCoreModelCatalogStore,
  webCoreModelLabel,
  webCoreModelList,
  webCoreModelOption,
  webCoreThinkingLevels,
} from '@/stores/chat/web-core/model-catalog';
import { resolveComposerWorkflowGates } from './composer-workflow-gates';
import {
  isChatAttachmentShortcutTarget,
  OPEN_CHAT_ATTACHMENTS_EVENT,
} from '@/lib/chatAttachmentShortcut';
import { useComposerActions } from '@/hooks/useComposerActions';
import { useComposerShortcutRequests } from '@/hooks/useComposerShortcutRequests';
import { DICTATION_SHORTCUT_LABEL } from '@/lib/keyboardShortcuts';
import type { ComposerShortcutScope } from '@/lib/composerShortcutRequests';
import {
  useCanopyClient,
  useOnboardingTipsStore,
  onboardingTipTranscript,
} from '@canopy/app-state';
import { useTerminalComposerMode } from '@canopy/ui-app/code/composer/terminal-mode';
import {
  OnboardingTipSlot,
  type OnboardingTipContext,
} from '@canopy/ui-app/onboarding-tips';
import type { OnboardingTipId } from '@canopy/protocol/onboarding-tips';
import { runCommandInTerminal } from '@canopy/ui-app/script-actions/run-command-in-terminal';
import {
  caretOnFirstLine,
  ScriptTypeaheadMenu,
  useScriptTypeahead,
} from '@canopy/ui-app/script-actions/typeahead';
import { desktopTerminalRunHost } from '@/lib/script-actions-terminal-host';
import { usePanelPlacement } from '@/lib/panels/panel-placement-context';
import {
  getWorktreeCacheKey,
  isFileIndexStale,
  useFileListStore,
  useRetainFileIndex,
  withRetainedFileIndex,
} from '@/stores/fileListStore';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import { useShallow } from 'zustand/react/shallow';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_MODEL,
  DEFAULT_TERMINAL_DRAWER_HEIGHT,
  type ApprovalMode,
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type AgentProviderType,
  type AttachmentMeta,
  type AgentModelConfig,
  type ChatAttachmentPromptContext,
  type ChatModel,
  type ModelHarness,
  type ChatTabPluginSelections,
  type FileIndexResponse,
  type FileReference,
  type RepoFileIndex,
  type LinearTicketSearchResult,
  type ScheduledActivity,
  type SlashCommandData,
  clampThinkingLevelForModel,
  getAgentModelSelectionId,
  getEffectiveSupportedThinkingLevelsForModel,
  getProviderForModel,
  modelConfigForProviderSupportsFastMode,
  resolveOverallDefault,
  getModelDisplayName,
  isChatAttachmentPromptKind,
  DEFAULT_CREDITS_CODEX_MODEL,
  isAgentModel,
  resolveRuntimeModel,
} from '@canopy/desktop-shared/types';
import { DEFAULT_VOICE_DICTATION_ENABLED } from '@canopy/desktop-shared/constants/preferences';
import { computeUsageLimitResumePrompt } from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import { normalizeEpochMs } from '@canopy/desktop-shared/ai-credits-routing-state';
import {
  EMPTY_COMPLETION_RESUME_PROMPT,
  buildEmptyCompletionRetryPrompt,
  type EmptyCompletionRecoveryView,
} from '@/stores/chat/empty-completion';
import { EmptyCompletionRecoveryNotice } from './EmptyCompletionRecoveryNotice';
import { StoppedTurnResumeNotice } from './StoppedTurnResumeNotice';
import { InterruptedTurnResumeNotice } from './InterruptedTurnResumeNotice';
import {
  dismissInterruptedTurnResume,
  interruptedTurnResumeKey,
  resumeInterruptedTurn,
  shouldShowInterruptedTurnResume,
  shouldShowStoppedTurnResume,
  useInterruptedTurnResumeStore,
} from '@/stores/chat/interrupted-turn-resume';
import type {
  PipelineData,
  PipelineModelAliasPreference,
  PipelinePluginCollectionPreference,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import {
  resolveEffectiveProviderType,
  selectDiscoverySlashCommands,
} from '@/lib/chatDiscovery';
import { resolveDiscoveryProviderType } from '@/stores/chat/discovery';
import { ChatPluginsModal } from './ChatPluginsModal';
import { PlanDetectionBanner } from './PlanDetectionBanner';
import { SkillShareNudgeBanner } from './SkillShareNudgeBanner';
import { SkillSuggestionBannerHost } from './SkillSuggestionBannerHost';
import {
  AiCreditsRoutingStatusBanner,
  SubscriptionAvailabilityNotice,
} from './AiCreditsRoutingStatusBanner';
import { useSubscriptionSwitch } from './useSubscriptionSwitch';
import { useEffectiveAiCreditsRouting } from '@/hooks/useEffectiveAiCreditsRouting';
import { useResumeInterruptedTurnOnAiCredits } from '@/hooks/useResumeInterruptedTurnOnAiCredits';
import { ModelUnlockConfirmedBanner } from './ModelUnlockConfirmedBanner';
import { ModelUnlockPendingBanner } from './ModelUnlockPendingBanner';
import { ModelGatewayKeyBanner } from './ModelGatewayKeyBanner';
import { ApprovalsUpgradeNotice } from './ApprovalsUpgradeNotice';
import { ToolApprovalDock } from './ToolApprovalDock';
import { canApprovalTakeFocus } from '@canopy/ui-shared/lib/approval-focus-policy';
import { hasPendingApprovalForChat } from '@/stores/chat/pending-approvals';
import { ChatBackgroundTray } from './ChatBackgroundTray';
import { useComposerWorkDrawerLink } from './composer-work-drawer-context';
import { AiCreditsUsageLimitBanner } from './AiCreditsUsageLimitBanner';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import { NoBillingSourceBanner } from './NoBillingSourceBanner';
import { OrgLapsedBanner } from './OrgLapsedBanner';
import { FirstSendFailedSlot } from './FirstSendFailedSlot';
import { usePanelHostState } from '@/lib/panels/panel-host-context';
import { TransientRetryBanner } from './TransientRetryBanner';
import { ScheduledAutomationsNotice } from './ScheduledAutomationsNotice';
import { ClaudeModsComposerNotice } from './ClaudeModsComposerNotice';
import { TryItSignInBanner } from './TryItSignInBanner';
import {
  useAiCreditsBannerStore,
  useAiCreditsRoutingActive,
  useVisibleUsageLimitBanner,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import {
  canRestoreComposerDraft,
  applyComposerRecovery,
  decideComposerRecovery,
} from '@canopy/ui-app/composer-recovery';
import {
  composerRecoveryHead,
  composerRecoveryKey,
  composerRecoveryStore,
  composerRecoveryTranscript,
  handOffComposerRecoveryToQueue,
  restoreRejectedComposerInputs,
  settleAcceptedComposerRecovery,
} from '@/stores/composerRecoveryStore';
import { draftHasContent } from '@/lib/chat-draft-content';
import { useHeldQueueComposerRecovery } from '@/hooks/useHeldQueueComposerRecovery';
import { useCatchingUpLag } from '@/stores/ingestionLagStore';
import {
  isGatewayOnlyModel,
  resolveOrgGatewayOrganizationId,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { openPendingPlanExit } from '@/lib/plans/open-tracked-plan';
import { PlanReadyPipelineModal } from './PlanReadyPipelineModal';
import { usePipelineRunWatcher } from '@/components/activity/usePipelineRunWatcher';
import { ModelPicker } from './ModelPicker';
import { trackChatComposerSend } from '@/lib/chatMessageSendTelemetry';
import { notifyAcceptedWorktreeTurn } from '@/components/onboarding-tips/homeSendEvents';
import {
  resolveChatBillingFramework,
  resolveCreditsModelRoutability,
  type ChatBillingResolution,
  type BillingFramework,
} from '@/lib/chatBillingFramework';
import {
  canOfferCreditsModelSwitch,
  continueOnCreditsModel,
  type CreditsModelSwitchResult,
  type CreditsModelSwitchTarget,
} from '@/lib/creditsModelSwitch';
import { useProviderAvailability } from '@/hooks/useProviderAvailability';
import { useThinkingHarness } from './useThinkingHarness';
import { DirectoryPicker } from './DirectoryPicker';
import { UsageIndicator } from './UsageIndicator';
import { getSlashCommandInsertText } from '@/hooks/useSlashCommands';
import { useInvocableInventory } from '@/hooks/useInvocableInventory';
import {
  buildSlashInventoryCommands,
  flattenCollectionRefs,
  runInventorySelection,
  type CollectionEnabledRefs,
  inventoryRowNeedsResolution,
} from '@/lib/slashInvocableInventory';
import { createEmptySelections } from '@/lib/pluginSelections';
import {
  mergeAgentChatPluginSelections,
  stripAgentOnlyChatPluginSelections,
} from '@/lib/chatPluginSelections';
import { useComposerTurnActivity } from '@/hooks/useComposerTurnActivity';
import { useStuckAgentTimer } from '@/hooks/useStuckAgentTimer';
import {
  ComposerEditor,
  type ComposerDensity,
  buildEditorValueFromMessage,
  createChatEditor,
  focusEditor,
  resetEditor,
  restoreEditorContent,
  serializeEditorValue,
  createEmptyValue,
} from '@canopy/ui-rich/editor';
import type {
  FileReferenceElement,
  SerializedFileReference,
} from '@canopy/ui-rich/types';
import { VoiceInputButton } from '../shared/VoiceInputButton';
import { VoiceDictationErrorModal } from '../shared/VoiceDictationErrorModal';
import { useVoiceTranscription } from '@/hooks/useVoiceTranscription';
import { useHoldToDictate } from '@/hooks/useHoldToDictate';
import { onVoiceDictationEnabledChanged } from '@/lib/voice/voice-dictation-pref';
import { createSlateVoiceTarget } from '@/lib/voice/insert-into-slate';
import { shouldMarkFinalTranscriptAsVoiceInput } from './dictation-input-mode';
import { shouldMaterializeCodexThread } from './codex-thread-materialization';
import { localPlatform } from '@/lib/local-platform';
import { shouldProbeVoiceSupport } from '@/lib/voice/voice-platform';
import {
  getCwdFromFileIndex,
  rewriteFileReferencesForCwd,
} from '@/lib/file-reference-paths';
import {
  EMPTY_ATTACHMENT_ITEMS,
  EMPTY_NOTE_ITEMS,
  EMPTY_PROMPT_ITEMS,
  searchWorkspaceItemMentions,
  searchFileMentions,
  type WorkspaceItemMentionSources,
} from '@/lib/fileMentionSearch';
import { missingMentionedPluginRefs } from '@canopy/desktop-shared/lib/plugin-mention';
import {
  expandPromptMentions,
  mergePromptAwareFileReferences,
} from '@/lib/promptMentionExpansion';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import { AttachmentPillCarousel } from './AttachmentPillCarousel';
import { ScheduledSendChip } from './ScheduledSendChip';
import { ApprovalModePicker } from './ApprovalModePicker';
import {
  PLAN_APPROVAL_BOX_CLASS,
  PLAN_APPROVAL_EDITOR_CONTAINER_CLASS,
  type PlanApprovalOption,
} from './PlanApprovalPrompt';
import {
  PlanApprovalPromptWithComments,
  type PlanApprovalCommentsTarget,
} from './PlanApprovalUnsentComments';
import { resolveComposerPendingPlanExit } from './resolveComposerPendingPlanExit';
import { ChatDropOverlay } from './ChatDropOverlay';
import { useChatFileDrop } from './useChatFileDrop';
import { VoiceRecordingRow } from './VoiceRecordingRow';
import {
  type ComposerActionHandlers,
  runComposerAction,
  buildPlanReadyChip,
  buildChatComposerPlusItems,
} from './ComposerLayout';
import { useClaudeTuiChatsEnabled } from '@/lib/claude-tui-chats';
import {
  resolveChatInterfaceModeOptions,
  type ChatInterfaceModeControl,
} from './chatInterfaceModes';
import { SelectionContextChips } from './SelectionContextChips';
import {
  appendSelectionContextBlocks,
  INSERT_CHAT_TEXT_EVENT,
  isChatComposerFocusRequest,
  REVEAL_EDITOR_RANGE_EVENT,
  shouldHandleChatTextInsertion,
  stashPendingEditorRangeReveal,
  type EditorSelectionContext,
  type InsertChatTextDetail,
  type RevealEditorRangeDetail,
  type SelectionFreshness,
} from '@/lib/editorSelectionContext';
import type { ActiveComposerView } from './types';
import { computeColsRowsForPixels } from '@/lib/terminal-dimensions';
import {
  DISCARD_CHAT_DRAFT_EVENT,
  SAVE_CHAT_DRAFTS_EVENT,
  saveDraftForExistingTab,
} from '@/lib/chatDrafts';
import { readTryItDraft, saveTryItDraft } from '@/lib/tryItDraftStorage';
import { appendDraftText } from '@canopy/ui-rich/editor/append-draft-text';
import {
  findComposerDensityPanel,
  resolveComposerDensity,
} from '@/lib/composer-density';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  isEditorSelectionAtBoundary,
  type HistoryBoundary,
  type MessageHistoryNavigationState,
} from './message-history';
import {
  ChatComposerToolbar,
  FLOATING_PICKER_GAP,
  Notice,
  NoticeButton,
  StuckAgentNotice,
  CatchingUpNotice,
  ConfirmDialog,
  ThinkingLevelPanelPicker,
  NoticeShapeProvider,
  ChatComposerShell,
  ComposerAccessUsage,
  nextCodexSpeed,
  buildPlanModeChip,
  buildQuestionReadyChip,
  ComposerSendButton,
  defaultChatPlaceholder,
  planCopyStateFromMarkdown,
  type PlanCopyState,
} from '@canopy/ui-shared';
import {
  ComposerDrawer,
  ComposerNoticeStack,
  MessageEditCancelSave,
  PendingTurnSettingsHint,
  useCompactQueue,
} from '@canopy/ui-shared/components';
import { canContinueOnOtherHarness } from '@/lib/chatProviderLock';
import { hasPendingQuestionForChat } from '@/stores/chat/pending-questions';
import { isTabAiCreditsRouted } from '@/stores/chat/tab-utils';
import { tabRequestedCodexSpeed } from '@/stores/chat/codex-speed';
import { usePendingTurnSettings } from './usePendingTurnSettings';
import { useContextualCodexSpeedControl } from '@/hooks/useContextualCodexSpeedControl';
import { useCodexSpeedDowngrade } from '@/hooks/useCodexSpeedDowngrade';
import { getDocument } from '@canopy/ui-shared/panels';
import { useAutoModelRoutingAvailability } from '@/hooks/useAutoModelRouting';
import { chatAiCreditsScope } from '@/lib/aiCreditsScope';
import { useAutomationsStore } from '@/stores/automationsStore';
import { captureActivePlanContext } from '@/stores/activePlanStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { selectProviderUsageLimitResumeAt } from '@/lib/claudeUsageLimitResume';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { ScheduleMessageModal } from './ScheduleMessageModal';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  ATTACHMENT_IMPORT_ERROR_MESSAGE,
  addPendingAttachmentsAndRefreshIndex,
  createClipboardAttachments,
  importChatAttachments,
  importWebCoreChatFiles,
} from '@/lib/chatAttachments';
import { stageLinearTicketAttachment } from '@/lib/linearTicketStaging';
import { ComposerPlusMenu } from '@/components/shared/ComposerPlusMenu';
import { dispatchBrowserViewBoundsInvalidated } from '@/lib/browserViewBounds';
import { hasForkedContainerFocus } from '@/lib/shared-containers/forked-container-focus';
import { findPendingUsageLimitResume } from '@/lib/scheduledUsageLimitResume';
import type { BillingLane } from '@canopy/desktop-shared/lib/default-model-lane';
import type { StuckAgentCheckResult } from '@canopy/ui-shared/components';
import { checkChatStatus } from './check-chat-status';

interface PipelinePluginCollectionContext {
  preferences: Record<string, PipelinePluginCollectionPreference>;
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  modelConfig?: AgentModelConfig;
}

const WORKTREE_CHAT_TIPS: readonly OnboardingTipId[] = ['worktree-chat'];
const NO_TIPS: readonly OnboardingTipId[] = [];

const COMPACT_TOOLBAR_BREAKPOINT_REM = 40;
const COMPACT_TOOLBAR_HYSTERESIS_REM = COMPACT_CHIPS_HYSTERESIS_REM;

const DEFAULT_TERMINAL_SPAWN_COLS = 80;
const DEFAULT_TERMINAL_SPAWN_ROWS = 24;

// Stable empty list so tabs without staged editor selections do not re-render
// the composer on unrelated store updates.
const NO_PENDING_SELECTIONS: readonly EditorSelectionContext[] = [];

// Lazy-loaded so the Linear ticket picker (and its debounced-search UI) only
// enters the chat chunk once a user actually opens the `+` menu's Linear row,
// following the same named-export lazy pattern App.tsx uses for its pages.
const LinearTicketPickerModal = lazy(() =>
  import('@/components/shared/linear/LinearTicketPickerModal').then((m) => ({
    default: m.LinearTicketPickerModal,
  })),
);

function getPendingPlanText(pendingExit: PendingPlanExit): string {
  const input = pendingExit.toolInput;
  return typeof input.plan === 'string'
    ? input.plan
    : JSON.stringify(input, null, 2);
}

/**
 * Inline-editing contract for a queued message. When provided, ChatInput
 * renders as an in-place editor instead of the live composer:
 *  - editor content is seeded from `initialText` + `initialFileReferences`,
 *  - tab drafts are not saved or restored,
 *  - attachments use the caller-managed local list rather than the tab's
 *    `pendingAttachments`,
 *  - the streaming/idle send button is hidden in favor of a Cancel/Save row
 *    rendered just outside the rounded composer container,
 *  - banners that only apply to the live composer (stuck-agent, plan-exit,
 *    stale session) are suppressed.
 */
export interface ChatInputEditingState {
  autoFocus?: boolean;
  initialText: string;
  initialFileReferences: FileReference[];
  attachments: AttachmentMeta[];
  onAddAttachments: (attachments: AttachmentMeta[]) => void;
  onRemoveAttachment: (absolutePath: string) => void;
  onCancel: () => void;
  onSave: (
    text: string,
    fileReferences: FileReference[],
    attachmentPaths: string[],
    attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
    inputMode: 'typed' | 'voice',
    scheduledSendDraft: { runAt: string } | undefined,
  ) => void;
  scheduledSendDraft?: { runAt: string };
  scheduleEnabled?: boolean;
}

export interface ComposerFileIndexOptions {
  fileListKey: string | null;
  projectId: string | undefined;
  worktreeId: string | undefined;
  menuOpen: boolean;
  draftHasFileReferences: boolean;
}

export interface ComposerFileIndexState {
  fileRepos: RepoFileIndex[];
  fileIndexEntry: { data: FileIndexResponse; fetchedAt: number } | undefined;
  fileIndexLoading: boolean;
  /**
   * Repos to rewrite a submission's file references with. A missing index is
   * fetched under a lease first, so a send during its reload still rewrites.
   */
  resolveSubmissionFileRepos: (
    hasFileReferences: boolean,
  ) => Promise<RepoFileIndex[]>;
}

/**
 * Detect file-reference pills in the Slate paragraph values used by the
 * composer. The tree walk is linear and allocates nothing.
 */
export function composerValueHasFileReferences(
  value: readonly Descendant[],
): boolean {
  for (const block of value) {
    if (!SlateElement.isElement(block) || block.type !== 'paragraph') continue;
    for (const child of block.children) {
      if (SlateElement.isElement(child) && child.type === 'file-reference') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Keeps the current worktree's full index resident for the mounted composer
 * and loads it on demand for an open file menu or a draft containing file
 * references. Plain empty composers do not load the index until the menu opens.
 */
export function useComposerFileIndex({
  fileListKey,
  projectId,
  worktreeId,
  menuOpen,
  draftHasFileReferences,
}: ComposerFileIndexOptions): ComposerFileIndexState {
  useRetainFileIndex(fileListKey);

  const { fileIndexEntry, fileIndexError, fileIndexLoading, fetchFileIndex } =
    useFileListStore(
      useShallow((state) => ({
        fileIndexEntry:
          fileListKey === null ? undefined : state.indexCache[fileListKey],
        fileIndexError:
          fileListKey === null ? undefined : state.indexErrors[fileListKey],
        fileIndexLoading:
          fileListKey === null ? false : state.indexLoading.has(fileListKey),
        fetchFileIndex: state.fetchFileIndex,
      })),
    );

  const fileRepos = useMemo(
    () => fileIndexEntry?.data.repos ?? [],
    [fileIndexEntry],
  );

  useEffect(() => {
    if (
      fileListKey === null ||
      projectId === undefined ||
      worktreeId === undefined ||
      !menuOpen
    ) {
      return;
    }
    if (isFileIndexStale(fileIndexEntry)) {
      void fetchFileIndex(projectId, worktreeId);
    }
  }, [
    fetchFileIndex,
    fileIndexEntry,
    fileListKey,
    menuOpen,
    projectId,
    worktreeId,
  ]);

  useEffect(() => {
    if (
      fileListKey === null ||
      projectId === undefined ||
      worktreeId === undefined ||
      menuOpen ||
      !draftHasFileReferences ||
      fileIndexEntry !== undefined ||
      fileIndexLoading ||
      fileIndexError !== undefined
    ) {
      return;
    }
    void fetchFileIndex(projectId, worktreeId);
  }, [
    draftHasFileReferences,
    fetchFileIndex,
    fileIndexEntry,
    fileIndexError,
    fileIndexLoading,
    fileListKey,
    menuOpen,
    projectId,
    worktreeId,
  ]);

  const resolveSubmissionFileRepos = useCallback(
    async (hasFileReferences: boolean): Promise<RepoFileIndex[]> => {
      if (fileListKey === null) return [];
      const cached = useFileListStore.getState().indexCache[fileListKey];
      if (
        cached !== undefined ||
        !hasFileReferences ||
        projectId === undefined ||
        worktreeId === undefined
      ) {
        return cached?.data.repos ?? [];
      }
      return withRetainedFileIndex(
        fileListKey,
        async (): Promise<RepoFileIndex[]> => {
          await useFileListStore
            .getState()
            .fetchFileIndex(projectId, worktreeId);
          return (
            useFileListStore.getState().indexCache[fileListKey]?.data.repos ??
            []
          );
        },
      );
    },
    [fileListKey, projectId, worktreeId],
  );

  return {
    fileRepos,
    fileIndexEntry,
    fileIndexLoading,
    resolveSubmissionFileRepos,
  };
}

interface ChatInputProps {
  tab: ActiveComposerView | null;
  userMessageHistory?: readonly string[];
  beforeComposer?: ReactNode;
  /**
   * A Claude chat's interface modes (the app's chat, Auto, Claude Code),
   * offered under View in the + menu. Supplied by worktree chat panels in the
   * Canopy display surface; the terminal surface floats its own toggle.
   */
  interfaceModeControl?: ChatInterfaceModeControl;
  extraFileReferences?: FileReference[];
  editingState?: ChatInputEditingState;
  targetOverride?: { projectId: string; worktreeId: string; chatId: string };
  /**
   * Marks a `targetOverride` composer as a live persisted chat session rather
   * than a mirror/embedded surface. Code worktree, Cowork, and App Advisor
   * composers opt in so scheduled sends and usage-limit resume target their
   * existing chat; pipeline/plan/archive mirrors leave this disabled.
   */
  nativeSessionComposer?: boolean;
  /** Opt in only for the ordinary Code/worktree chat surface. */
  allowCursor?: boolean;
  /** Whether this mounted composer owns global composer shortcut requests. */
  composerShortcutsEnabled?: boolean;
  /** Owning document for shortcuts when rendered in a popped-out panel. */
  cancelShortcutOwnerDocument?: Document;
  /** Active chat-panel root used to reject Escape from sibling surfaces. */
  cancelShortcutTargetRootRef?: RefObject<HTMLElement | null>;
  hidePlanMode?: boolean;
  hideDirectoryPicker?: boolean;
  disableTerminalMode?: boolean;
  disableFileTypeahead?: boolean;
  /**
   * Skills forced on for this surface that the user cannot remove. Forwarded to
   * the plugins modal so matching rows render as locked. Used by the embedded
   * pipeline-editor chat drawer for its required brand-specific
   * pipeline-writing skill.
   */
  lockedSkillRefs?: { sourceId: string; skillName: string }[];
  onSendMessage?: (
    text: string,
    fileReferences?: FileReference[],
    inputMode?: 'typed' | 'voice',
    attachmentPaths?: string[],
    attachmentPromptContexts?: ChatAttachmentPromptContext[],
  ) => Promise<void>;
}

function attachmentPromptContextsFromMeta(
  attachments: readonly AttachmentMeta[],
): ChatAttachmentPromptContext[] | undefined {
  const contexts = attachments
    .filter(
      (
        attachment,
      ): attachment is AttachmentMeta & {
        promptKind: NonNullable<AttachmentMeta['promptKind']>;
      } => isChatAttachmentPromptKind(attachment.promptKind),
    )
    .map((attachment) => ({
      attachmentPath: attachment.absolutePath,
      promptKind: attachment.promptKind,
    }));
  return contexts.length > 0 ? contexts : undefined;
}

/**
 * App Advisor's questions answer and skip through its own store, which
 * resolves the waiting tool call at once.
 */
const APP_ADVISOR_QUESTION_DELIVERY: ComposerQuestionDelivery = {
  answer: (requestId, answers): Promise<void> => {
    const store = useAppAdvisorStore.getState();
    const [answer] = answers;
    if (answer) store.answerQuestion(requestId, answer);
    else store.dismissQuestion(requestId);
    return Promise.resolve();
  },
  dismiss: (requestId): Promise<void> => {
    useAppAdvisorStore.getState().dismissQuestion(requestId);
    return Promise.resolve();
  },
};

/** The default a new chat in `projectId` starts on, read when a pick lands. */
function chatDefaultModel(
  projectId: string | undefined,
  modelDefaults: Parameters<typeof resolveTabDefaults>[1],
): ChatModel | undefined {
  return projectId
    ? resolveTabDefaults(projectId, modelDefaults).model
    : undefined;
}

export const ChatInput = memo(function ChatInput(
  props: ChatInputProps,
): JSX.Element {
  return (
    <ComposerTipArbiterProvider>
      <ChatInputContent {...props} />
    </ComposerTipArbiterProvider>
  );
});

function ChatInputContent({
  tab,
  userMessageHistory = [],
  beforeComposer,
  interfaceModeControl,
  extraFileReferences = [],
  editingState,
  targetOverride,
  nativeSessionComposer = false,
  allowCursor = false,
  composerShortcutsEnabled = true,
  cancelShortcutOwnerDocument,
  cancelShortcutTargetRootRef,
  hidePlanMode = false,
  hideDirectoryPicker = false,
  disableTerminalMode = false,
  disableFileTypeahead = false,
  lockedSkillRefs,
  onSendMessage,
}: ChatInputProps): JSX.Element {
  const useChatStore = useChatSurfaceStore(useLiveChatStore);
  const sandbox = useChatSurfaceScope()?.mode === 'sandbox';
  const isEditingQueued = editingState !== undefined;
  const compactQueue = useCompactQueue();
  const composerWorkDrawerLink = useComposerWorkDrawerLink();
  const [hintDraftSession, setHintDraftSession] = useState(0);
  const editor = useMemo(() => createChatEditor(), []);
  const initialEditorValue = useMemo<Descendant[]>(
    () =>
      editingState
        ? buildEditorValueFromMessage(
            editingState.initialText,
            editingState.initialFileReferences,
          )
        : createEmptyValue(),
    // Only the initial render snapshot matters — re-mount the editor (via
    // ChatMessageList's keyed wrapper) to seed a different message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [value, setValue] = useState<Descendant[]>(() =>
    structuredClone(initialEditorValue),
  );
  const [, setSelectionRevision] = useState(0);
  const tabId = tab?.id;
  const messageHistoryNavigationRef =
    useRef<MessageHistoryNavigationState | null>(null);
  const historyNavigationProgrammaticChangeRef = useRef(false);
  const composerRootRef = useRef<HTMLDivElement | null>(null);

  const getDraftForSave = useCallback(
    (draftTabId: string | null, fallbackDraft: Descendant[]): Descendant[] => {
      const navigationState = messageHistoryNavigationRef.current;
      if (draftTabId !== null && navigationState?.tabId === draftTabId) {
        return navigationState.draft;
      }
      return fallbackDraft;
    },
    [],
  );

  const markHistoryNavigationProgrammaticChange = useCallback((): void => {
    historyNavigationProgrammaticChangeRef.current = true;
    window.setTimeout((): void => {
      historyNavigationProgrammaticChangeRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    messageHistoryNavigationRef.current = null;
  }, [tabId]);

  // Save outgoing tab's draft and restore incoming tab's draft on tab switch.
  // Uses useLayoutEffect to prevent a flash of stale content before the swap.
  // A separate cleanup below saves the current draft when the composer
  // unmounts, such as when a file tab becomes active.
  const prevTabIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (isEditingQueued) {
      // Edit-mode editor is seeded from `editingState.initialText`; drafts
      // are intentionally untouched so the live composer below keeps its own.
      restoreEditorContent(editor, initialEditorValue);
      setValue(structuredClone(editor.children));
      prevTabIdRef.current = tab?.id ?? null;
      return;
    }

    const state = useChatStore.getState();
    const currentTabId = tab?.id ?? null;

    // Save outgoing tab's draft — but only if the tab still exists (it may
    // have been closed, in which case closeTab already cleared its draft).
    if (
      prevTabIdRef.current !== null &&
      prevTabIdRef.current !== currentTabId
    ) {
      saveDraftForExistingTab(
        state,
        prevTabIdRef.current,
        getDraftForSave(prevTabIdRef.current, editor.children),
      );
    }

    // Restore incoming tab's draft or reset
    if (currentTabId !== null) {
      const draft = state.getTabDraft(currentTabId);
      if (draft && draft.length > 0) {
        restoreEditorContent(editor, draft);
        setValue(structuredClone(editor.children));
      } else if (
        prevTabIdRef.current !== null &&
        prevTabIdRef.current !== currentTabId
      ) {
        resetEditor(editor);
        setValue(createEmptyValue());
      }
    } else {
      resetEditor(editor);
      setValue(createEmptyValue());
    }

    prevTabIdRef.current = currentTabId;
  }, [
    tab?.id,
    editor,
    getDraftForSave,
    isEditingQueued,
    initialEditorValue,
    useChatStore,
  ]);

  // Discard in an unsaved-changes prompt that counted this tab's draft (the
  // Pipeline Assistant's): empty the composer, so leaving saves nothing.
  const discardTabId = tab?.id ?? null;
  useEffect(() => {
    if (isEditingQueued || discardTabId === null) return undefined;
    const handler = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (typeof detail !== 'object' || detail === null) return;
      if (Reflect.get(detail, 'tabId') !== discardTabId) return;
      // A draft stashed while browsing sent messages is discarded too, or
      // leaving would save it back.
      messageHistoryNavigationRef.current = null;
      resetEditor(editor);
      setValue(createEmptyValue());
    };
    document.addEventListener(DISCARD_CHAT_DRAFT_EVENT, handler);
    return (): void => {
      document.removeEventListener(DISCARD_CHAT_DRAFT_EVENT, handler);
    };
  }, [discardTabId, editor, isEditingQueued]);

  useLayoutEffect(() => {
    if (isEditingQueued) return undefined;
    const saveDraft = (): void => {
      saveDraftForExistingTab(
        useChatStore.getState(),
        prevTabIdRef.current,
        getDraftForSave(prevTabIdRef.current, editor.children),
      );
    };
    document.addEventListener(SAVE_CHAT_DRAFTS_EVENT, saveDraft);
    return (): void => {
      document.removeEventListener(SAVE_CHAT_DRAFTS_EVENT, saveDraft);
      saveDraft();
    };
  }, [editor, getDraftForSave, isEditingQueued, useChatStore]);

  useEffect(() => {
    const node = composerRootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    dispatchBrowserViewBoundsInvalidated();
    const observer = new ResizeObserver(() => {
      dispatchBrowserViewBoundsInvalidated();
    });
    observer.observe(node);
    return (): void => {
      observer.disconnect();
      dispatchBrowserViewBoundsInvalidated();
    };
  }, []);

  // Reset dictation mode whenever the user switches tabs so a voice-marked
  // draft does not accidentally follow the user into a different chat.
  useEffect(() => {
    dictationInputModeRef.current = 'typed';
  }, [tab?.id]);

  // Several composers can be mounted at once (split chat panels and MainPage
  // behind other pages). Document-level insert/focus events must only act on a
  // composer the user can actually see, otherwise one event would fan out into
  // every mounted editor.
  const isComposerVisible = useCallback((): boolean => {
    const node = composerRootRef.current;
    return node !== null && node.getClientRects().length > 0;
  }, []);
  const hostVisible = usePanelHostState().visible !== false;

  const sendMessage = useChatStore((s) => s.sendMessage);
  const dismissSendRefusal = useChatStore((s) => s.dismissSendRefusal);
  const cancelSession = useChatStore((s) => s.cancelSession);
  const resumeStoppedTurn = useChatStore((s) => s.resumeStoppedTurn);
  // Escape-to-cancel confirmation (ECW-8986): the arming hook may live in a
  // separate tree (ChatContent with hideComposer), so the pending state is
  // read from the shared store, matched on this composer's chat identity.
  const cancelShortcutChatKey = useChatStore((s) => {
    if (targetOverride) {
      return `${targetOverride.projectId}/${targetOverride.worktreeId}/${targetOverride.chatId}`;
    }
    if (!tab || !s.selectedWorktree) return null;
    return `${s.selectedWorktree.projectId}/${s.selectedWorktree.worktreeId}/${tab.id}`;
  });
  const cancelShortcutArmed = useCancelShortcutConfirmationStore(
    (s) => s.armedChatKey !== null && s.armedChatKey === cancelShortcutChatKey,
  );
  const verifyStreamingTabs = useChatStore((s) => s.verifyStreamingTabs);
  const togglePlanMode = useChatStore((s) => s.togglePlanMode);
  const setSpeed = useChatStore((s) => s.setSpeed);
  const cycleThinkingLevel = useChatStore((s) => s.cycleThinkingLevel);
  const setThinkingLevel = useChatStore((s) => s.setThinkingLevel);
  const approvePlanExit = useChatStore((s) => s.approvePlanExit);
  const dismissPlanForPipeline = useChatStore((s) => s.dismissPlanForPipeline);
  const handleStaleSessionStartNew = useChatStore(
    (s) => s.handleStaleSessionStartNew,
  );
  const handleStaleSessionHandOff = useChatStore(
    (s) => s.handleStaleSessionHandOff,
  );
  const pendingPlanExits = useChatStore((s) => s.pendingPlanExits);
  const setModel = useChatStore((s) => s.setModel);
  const setModelSelectionMode = useChatStore((s) => s.setModelSelectionMode);
  const setTabApprovalMode = useChatStore((s) => s.setTabApprovalMode);
  const setModelAndWait = useChatStore((s) => s.setModelAndWait);
  const createTab = useChatStore((s) => s.createTab);
  const continueTabOnProvider = useChatStore((s) => s.continueTabOnProvider);
  const setSelectedRepoId = useChatStore((s) => s.setSelectedRepoId);
  const selectedWorktree = useChatStore((s) => s.selectedWorktree);
  // What this chat's scope serves (CAN-6175 D4): a cloud tab hides the
  // controls its web core refuses.
  const scopeCapabilities = useScopeCapabilities({
    projectId: targetOverride?.projectId ?? selectedWorktree?.projectId ?? '',
  });
  const canChangePluginSelections =
    scopeCapabilities.chatPluginSelections === true;
  const canAttachFiles = scopeCapabilities.chatAttachments === true;
  const modelChangeKey = ((): string | undefined => {
    const selection = targetOverride ?? selectedWorktree;
    const chatId = targetOverride?.chatId ?? tab?.id;
    return selection && chatId
      ? `${selection.projectId}/${selection.worktreeId}/${chatId}`
      : undefined;
  })();
  const pendingModelChange = useChatStore(
    useShallow((s) =>
      modelChangeKey ? s.pendingModelChanges[modelChangeKey] : undefined,
    ),
  );
  const panelPlacement = usePanelPlacement();
  const openSettings = useNavigationStore((s) => s.openSettings);
  const addToast = useGitHubStore((s) => s.addToast);
  const enableAiCreditsRouting = useChatStore((s) => s.enableAiCreditsRouting);
  const selectBillingFramework = useChatStore((s) => s.selectBillingFramework);
  const setAiCreditsRoutingResetsAt = useChatStore(
    (s) => s.setAiCreditsRoutingResetsAt,
  );
  const setScheduledSendDraft = useChatStore((s) => s.setScheduledSendDraft);
  const automationsActivities = useAutomationsStore((s) => s.activities);
  const createAutomationActivity = useAutomationsStore((s) => s.createActivity);
  const setUsageLimitBanner = useAiCreditsBannerStore((s) => s.setUsageLimit);
  const setNoBillingSourceBanner = useAiCreditsBannerStore(
    (s) => s.setNoBillingSource,
  );
  const refreshProviderUsageSnapshot = useObservabilityStore(
    (s) => s.refreshProviderUsageSnapshot,
  );
  const slashCommandTarget = useMemo(() => {
    if (targetOverride) {
      return {
        projectId: targetOverride.projectId,
        worktreeId: targetOverride.worktreeId,
      };
    }
    return selectedWorktree;
  }, [selectedWorktree, targetOverride]);
  const watcherDestination = useMemo(() => {
    if (!tabId) return null;
    if (targetOverride) return targetOverride;
    if (!selectedWorktree) return null;
    // Cowork chats have no watcher destination — EXCEPT App Advisor, whose
    // entry-keyed chats are the primary watcher recipients.
    if (
      isCoworkChatTarget(selectedWorktree.projectId) &&
      selectedWorktree.projectId !== APP_ADVISOR_PROJECT_ID
    ) {
      return null;
    }
    const worktreeChat =
      useChatStore.getState().worktreeChats[
        `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
      ];
    if (!worktreeChat?.tabs.some((candidate) => candidate.id === tabId)) {
      return null;
    }
    return {
      projectId: selectedWorktree.projectId,
      worktreeId: selectedWorktree.worktreeId,
      chatId: tabId,
    };
  }, [selectedWorktree, tabId, targetOverride, useChatStore]);

  // Own the automations store from the chat surface so the usage-limit banner's
  // idempotency check and scheduled-message rows work without ever opening the
  // Automations page. `subscribeBridge` is safe to mount from multiple
  // components; the hydrated/loading guard avoids a duplicate initial list().
  useEffect(() => {
    const store = useAutomationsStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);

  // Focus the editor whenever the selected worktree or active tab changes so
  // the user can start typing immediately after clicking a worktree in the
  // sidebar or creating/switching tabs. A copy that just opened keeps the
  // focus it was given (CAN-4782).
  const worktreeKey = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : null;
  useEffect(() => {
    if (!worktreeKey) {
      return;
    }

    // Defer focus until after Slate has rendered its DOM nodes
    const animationFrameId = requestAnimationFrame(() => {
      if (
        !isComposerVisible() ||
        editingState?.autoFocus === false ||
        getDocument(composerRootRef.current).activeElement?.closest(
          '[data-testid="tool-approval-dock"]',
        ) != null ||
        hasForkedContainerFocus(document)
      ) {
        return;
      }
      focusEditor(editor);
    });

    return (): void => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [
    worktreeKey,
    tab?.id,
    editor,
    isComposerVisible,
    editingState?.autoFocus,
  ]);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail: unknown =
        event instanceof CustomEvent ? event.detail : undefined;
      if (isChatComposerFocusRequest(detail) && detail.targetTabId !== tabId)
        return;
      if (!isComposerVisible()) return;
      if (isChatComposerFocusRequest(detail)) {
        focusEditor(editor);
        detail.markHandled();
        return;
      }
      requestAnimationFrame(() => {
        focusEditor(editor);
      });
    };
    document.addEventListener('canopy:focus-chat-input', handler);
    return (): void => {
      document.removeEventListener('canopy:focus-chat-input', handler);
    };
  }, [editor, isComposerVisible, tabId]);

  // Listen for external file-reference insertion requests (e.g. @ mentions
  // from the workspace-item activity cards). The event carries
  // `detail.{displayPath, absolutePath, repoName?, kind?}` which are used to
  // insert a FileReferenceElement pill at the end of the current editor
  // content. `kind` tags note/prompt/attachment mentions for send-time
  // handling (prompt expansion).
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (
        e as CustomEvent<{
          displayPath: string;
          absolutePath: string;
          repoName?: string;
          kind?: string;
        }>
      ).detail;
      if (!detail?.displayPath) return;
      if (!isComposerVisible()) return;

      const end = Editor.end(editor, []);
      Transforms.select(editor, end);

      const node: FileReferenceElement = {
        type: 'file-reference',
        displayPath: detail.displayPath,
        absolutePath: detail.absolutePath,
        ...(detail.repoName ? { repoName: detail.repoName } : {}),
        ...(detail.kind ? { kind: detail.kind } : {}),
        children: [{ text: '' }],
      };
      Transforms.insertNodes(editor, node);
      Transforms.move(editor);
      Transforms.insertText(editor, ' ');

      setValue([...editor.children]);
      focusEditor(editor);
    };
    document.addEventListener('canopy:insert-file-reference', handler);
    return (): void => {
      document.removeEventListener('canopy:insert-file-reference', handler);
    };
  }, [editor, isComposerVisible]);

  // Listen for external plain-text insertion requests (for example file and
  // terminal selection toolbars). Targeted file requests route by chat tab;
  // untargeted terminal requests retain visible-composer-only behavior. Text
  // is appended with a blank line so selection blocks remain readable.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<InsertChatTextDetail>).detail;
      const text = detail?.text;
      if (!text) return;
      const composerVisible = isComposerVisible();
      if (
        !shouldHandleChatTextInsertion(
          detail,
          tabId,
          composerVisible,
          isEditingQueued,
        )
      ) {
        return;
      }

      if (detail.stagingId && tabId) {
        if (readTryItDraft(tabId)?.stagingIds.includes(detail.stagingId)) {
          detail.markHandled?.();
          return;
        }
        const next = appendDraftText(
          getDraftForSave(tabId, editor.children),
          text,
        );
        try {
          saveTryItDraft(tabId, next, detail.stagingId);
        } catch (error: unknown) {
          detail.markFailed?.(error);
          return;
        }
        messageHistoryNavigationRef.current = null;
        restoreEditorContent(editor, next);
        useChatStore.getState().saveTabDraft(tabId, next);
        setValue([...editor.children]);
        detail.markHandled?.();
        if (composerVisible) focusEditor(editor);
        return;
      }
      const end = Editor.end(editor, []);
      Transforms.select(editor, end);

      const hasContent = SlateNode.string(editor).trim().length > 0;
      const prefix = hasContent ? '\n\n' : '';
      Transforms.insertText(editor, `${prefix}${text}`);

      setValue([...editor.children]);
      detail.markHandled?.();
      if (composerVisible) {
        focusEditor(editor);
      }

      // The composer is `max-h-[200px] overflow-y-auto`; after appending a
      // chunk longer than that, the new text lives below the fold. Scroll
      // its scrollable ancestor to the bottom on the next frame so the user
      // can immediately see what was added.
      if (!composerVisible) return;
      requestAnimationFrame(() => {
        const editable = document.querySelector('[data-chat-textarea]');
        let scroller = editable?.parentElement ?? null;
        while (scroller && scroller !== document.body) {
          const style = window.getComputedStyle(scroller);
          if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            scroller.scrollHeight > scroller.clientHeight
          ) {
            scroller.scrollTop = scroller.scrollHeight;
            return;
          }
          scroller = scroller.parentElement;
        }
      });
    };
    document.addEventListener(INSERT_CHAT_TEXT_EVENT, handler);
    return (): void => {
      document.removeEventListener(INSERT_CHAT_TEXT_EVENT, handler);
    };
  }, [editor, getDraftForSave, isComposerVisible, isEditingQueued, tabId]);

  const canUsePlanMode = Boolean(
    !hidePlanMode &&
    selectedWorktree &&
    !isCoworkChatTarget(selectedWorktree.projectId) &&
    scopeCapabilities.chatWorkflows?.planMode === true,
  );
  const planMode = canUsePlanMode ? (tab?.planMode ?? false) : false;
  // Unlike plan mode, the approval-mode picker is available on every chat
  // surface, including cowork — Codex/Claude tool-approval prompts apply
  // there too.
  const approvalModeTarget = useMemo(() => {
    if (targetOverride) return targetOverride;
    if (!selectedWorktree || !tabId) return undefined;
    return {
      projectId: selectedWorktree.projectId,
      worktreeId: selectedWorktree.worktreeId,
      chatId: tabId,
    };
  }, [selectedWorktree, tabId, targetOverride]);
  // Same target the send reserves inputs for and refusal events carry.
  const composerRecoveryTargetKey = approvalModeTarget
    ? composerRecoveryKey(approvalModeTarget)
    : undefined;
  const approvalDefaultForProject = useChatStore((s) => {
    const projectId =
      approvalModeTarget?.projectId ?? selectedWorktree?.projectId;
    const worktreeId =
      approvalModeTarget?.worktreeId ?? selectedWorktree?.worktreeId;
    return projectId
      ? s.approvalDefaultsCache[approvalDefaultCacheKey(projectId, worktreeId)]
      : undefined;
  });
  const approvalDefaultsGeneration = useSyncExternalStore(
    subscribeApprovalDefaultsGeneration,
    getApprovalDefaultsGeneration,
    getApprovalDefaultsGeneration,
  );
  const [approvalDefaultLookupResult, setApprovalDefaultLookupResult] =
    useState<{
      cacheKey: string;
      generation: number;
      mode: ApprovalMode;
    } | null>(null);
  const approvalDefaultTargetKey = approvalModeTarget
    ? approvalDefaultCacheKey(
        approvalModeTarget.projectId,
        approvalModeTarget.worktreeId,
      )
    : undefined;
  const settledApprovalDefault =
    approvalDefaultLookupResult?.cacheKey === approvalDefaultTargetKey &&
    approvalDefaultLookupResult?.generation === approvalDefaultsGeneration
      ? approvalDefaultLookupResult?.mode
      : undefined;

  useEffect(() => {
    if (!approvalModeTarget || tab?.approvalMode !== undefined) return;
    const cacheKey = approvalDefaultCacheKey(
      approvalModeTarget.projectId,
      approvalModeTarget.worktreeId,
    );
    if (cacheKey in useChatStore.getState().approvalDefaultsCache) return;
    let active = true;
    void useChatStore
      .getState()
      .fetchApprovalDefault(
        approvalModeTarget.projectId,
        approvalModeTarget.worktreeId,
      )
      .then((mode): void => {
        if (
          !active ||
          approvalDefaultsGeneration !== getApprovalDefaultsGeneration()
        ) {
          return;
        }
        setApprovalDefaultLookupResult({
          cacheKey,
          generation: approvalDefaultsGeneration,
          mode,
        });
      });
    return (): void => {
      active = false;
    };
  }, [
    approvalDefaultForProject,
    approvalDefaultsGeneration,
    approvalModeTarget,
    tab?.approvalMode,
  ]);
  // Display-only fallback for the brief window before the tab's stamped mode
  // or the cached surface default resolves. Derived from the single shared
  // product default so it cannot drift.
  //
  // It tracks the PRODUCT default, not what main will necessarily enforce: on
  // a degraded preferences read main fails closed to Ask while this still
  // shows Full Access, so the capsule can briefly read more permissive than
  // reality. That direction is deliberate — the send itself always goes
  // through main's fail-closed resolver, and flashing a stricter mode on every
  // normal open would be the more misleading of the two (CAN-3055).
  const approvalMode: ApprovalMode =
    tab?.approvalMode ??
    approvalDefaultForProject ??
    settledApprovalDefault ??
    DEFAULT_APPROVAL_DEFAULTS.worktree;
  const handleApprovalModeChange = useCallback(
    (mode: ApprovalMode): void => {
      void setTabApprovalMode(approvalModeTarget, mode).catch(() => {
        addToast('Failed to change approval mode.', 'error');
      });
    },
    [addToast, approvalModeTarget, setTabApprovalMode],
  );
  const thinkingLevel = tab?.thinkingLevel ?? 'high';
  const model = tab?.model;
  const fallbackModel = useChatStore(
    useShallow((s) => {
      if (tab?.model) {
        return tab.model;
      }

      const selection = targetOverride
        ? {
            projectId: targetOverride.projectId,
            worktreeId: targetOverride.worktreeId,
          }
        : s.selectedWorktree;
      if (!selection || !s.modelDefaults) {
        return DEFAULT_MODEL;
      }

      const isStandalone = isCoworkChatTarget(selection.projectId);
      const resolved = isStandalone
        ? resolveOverallDefault(
            s.modelDefaults.chatModelByProvider,
            s.modelDefaults.chatProvider,
          )
        : resolveOverallDefault(
            s.modelDefaults.worktreeModelByProvider,
            s.modelDefaults.worktreeProvider,
          );
      return resolved.model ?? DEFAULT_MODEL;
    }),
  );
  const selectedGatewayOrganizationId = resolveOrgGatewayOrganizationId(
    model ?? fallbackModel,
  );
  const providerType = tab?.providerType;
  const readOnly = tab?.readOnly ?? false;
  const filesGuestGate = useDesktopFilesGuestGate(
    `${(targetOverride ?? selectedWorktree)?.projectId}/${(targetOverride ?? selectedWorktree)?.worktreeId}/${targetOverride?.chatId ?? tabId}/${readOnly}`,
  );
  const staleSessionDetected = tab?.staleSessionDetected;
  const pluginSelections = tab?.pluginSelections;
  const tabDisabledGlobalPluginSelections = tab?.disabledGlobalPluginSelections;
  // A chat written before project defaults were live keeps its own selection
  // and inherits no project layer until main normalizes it.
  const tabInheritsProjectDefaults = chatInheritsProjectDefaults(
    tab ?? undefined,
  );
  // Worktree and cowork chats inherit project and global default plugins;
  // purpose-built surfaces keep only their explicit selections.
  const overlayProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId;
  const overlayWorktreeId =
    targetOverride?.worktreeId ?? selectedWorktree?.worktreeId;
  const globalOverlayEligible =
    overlayProjectId !== undefined &&
    chatSurfaceUsesGlobalPluginDefaults(overlayProjectId);
  const globalPluginDefaults = useGlobalPluginDefaultsStore((state) =>
    globalOverlayEligible && state.hydrated ? state.selections : undefined,
  );
  const scopedProjectPluginDefaults = useChatStore((state) =>
    globalOverlayEligible && overlayWorktreeId !== undefined
      ? state.worktreeDefaultPlugins[`${overlayProjectId}/${overlayWorktreeId}`]
      : undefined,
  );
  const workspaceProjectPluginDefaults = useProjectsStore((state) =>
    globalOverlayEligible
      ? state.projects.find((project) => project.id === overlayProjectId)
          ?.defaultPluginSelections
      : undefined,
  );
  const projectPluginTombstones = useProjectsStore((state) =>
    globalOverlayEligible
      ? state.projects.find((project) => project.id === overlayProjectId)
          ?.disabledGlobalPluginSelections
      : undefined,
  );
  const projectPluginDefaults = useMemo(() => {
    const layer = tabInheritsProjectDefaults
      ? (scopedProjectPluginDefaults ?? workspaceProjectPluginDefaults)
      : undefined;
    return layer ? normalizePluginSelections(layer) : undefined;
  }, [
    scopedProjectPluginDefaults,
    tabInheritsProjectDefaults,
    workspaceProjectPluginDefaults,
  ]);
  const agentPluginSelections = useModelCatalogStore(
    useShallow((state) =>
      model
        ? state.snapshot?.agents?.find(
            (entry) => entry.id === getAgentModelSelectionId(model),
          )?.pluginSelections
        : undefined,
    ),
  );
  const previousAgentPluginSelectionsRef = useRef(agentPluginSelections);
  const displayedPluginSelections = useMemo(
    () =>
      globalPluginDefaults || projectPluginDefaults
        ? effectiveChatPluginSelections({
            local: pluginSelections,
            projectDefaults: projectPluginDefaults,
            global: globalPluginDefaults,
            projectTombstones: projectPluginTombstones,
            chatTombstones: tabDisabledGlobalPluginSelections,
          })
        : pluginSelections,
    [
      globalPluginDefaults,
      pluginSelections,
      projectPluginDefaults,
      projectPluginTombstones,
      tabDisabledGlobalPluginSelections,
    ],
  );
  const effectivePluginSelections = useMemo(
    () =>
      mergeAgentChatPluginSelections(
        displayedPluginSelections,
        agentPluginSelections,
      ),
    [agentPluginSelections, displayedPluginSelections],
  );
  const tabUsage = tab?.usage;
  const lastEventAt = tab?.lastEventAt;
  const tabDiscovery = tab?.discovery;
  const trackedPlanId = tab?.trackedPlanId;
  // Revision numbers belong to the tracked plan; without one, the first heading.
  const planRevised =
    trackedPlanId !== undefined && (tab?.latestRevisionNumber ?? 0) > 1;
  // This composer's chat in the composer's worktree. Its selectors run only
  // when this chat's tab changes, never for another chat's commit.
  const composerScope = targetOverride ?? selectedWorktree;
  const composerChatTarget: ChatRenderTarget | null =
    composerScope && tab
      ? {
          projectId: composerScope.projectId,
          worktreeId: composerScope.worktreeId,
          chatId: tab.id,
        }
      : null;
  const hasComposerChatId = !!tab?.id;
  const trackedPlanReviewStatus = useChatTabRenderState(
    composerChatTarget,
    ({ tab: storeTab }) =>
      hasComposerChatId ? storeTab?.trackedPlanReviewStatus : undefined,
  );
  const lockedProvider = tab?.lockedProvider;
  const lockedHarness = tab?.lockedHarness;
  const draftExecutionHarness = useChatTabRenderState(
    composerChatTarget,
    ({ tab: storeTab }) =>
      hasComposerChatId ? storeTab?.executionHarness : undefined,
  );
  const composerProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId;
  const composerWorktreeId =
    targetOverride?.worktreeId ?? selectedWorktree?.worktreeId;
  const { questions: composerQuestions, onDeliveryChange } =
    useComposerQuestions(
      tab?.id,
      composerProjectId,
      composerWorktreeId,
      !isEditingQueued && !readOnly,
    );
  // An unanswered ask-user card leaves the tab at `'idle'` with a paused timer,
  // so the row-enable decision cannot see it from tab state alone. Subscribed
  // as a boolean rather than the map so the composer only re-renders when the
  // answer actually lands.
  const hasUnansweredQuestion = useChatStore((s) =>
    tab?.id === undefined ||
    composerProjectId === undefined ||
    composerWorktreeId === undefined
      ? false
      : hasPendingQuestionForChat(
          s.pendingQuestions,
          composerProjectId,
          composerWorktreeId,
          tab.id,
        ),
  );
  // Claude and Codex are the only continuable harnesses, so a locked chat has
  // exactly one cross-harness target.
  const continueTargetProvider: AgentProviderType | undefined =
    lockedProvider === 'claude'
      ? 'codex'
      : lockedProvider === 'codex'
        ? 'claude'
        : undefined;
  const continueEligibility = useMemo(() => {
    if (!continueTargetProvider) return undefined;
    // `lockedProvider` already encodes "this tab has conversation state", which
    // is the only thing `getLockedProvider` reads `messages` for.
    return canContinueOnOtherHarness(
      {
        messages: { length: 1 },
        // The existing active-composer selector projects only the count. This
        // keeps queued turns live without adding another store subscription and
        // tab scan to every mounted composer.
        queuedMessages: { length: tab?.queuedMessageCount ?? 0 },
        providerType: lockedProvider,
        ...(tab?.readOnly ? { readOnly: true } : {}),
        ...(tab?.status ? { status: tab.status } : {}),
        ...(tab?.interfaceMode ? { interfaceMode: tab.interfaceMode } : {}),
        ...(tab?.pendingPlanExit
          ? { pendingPlanExit: tab.pendingPlanExit }
          : {}),
        ...(hasUnansweredQuestion ? { hasUnansweredQuestion: true } : {}),
      },
      continueTargetProvider,
      composerProjectId,
    );
  }, [
    composerProjectId,
    continueTargetProvider,
    hasUnansweredQuestion,
    lockedProvider,
    tab?.interfaceMode,
    tab?.pendingPlanExit,
    tab?.queuedMessageCount,
    tab?.readOnly,
    tab?.status,
  ]);
  // Bind the pending continue to the chat it was opened FOR, not to whatever
  // chat happens to be active at confirm time. Not every surface remounts the
  // composer on a chat switch: Plan Explore and Pipeline Assistant render a
  // clickable `ChatTabBar` above a single unkeyed `ChatContent`, so switching
  // there is a prop change and this component (and its state) survives it.
  const [continuePick, setContinuePick] = useState<
    | { tabId: string; model: ChatModel; billingFramework?: BillingFramework }
    | undefined
  >(undefined);
  const [continueBusy, setContinueBusy] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  // Only honor the pending pick while its own chat is still the active one.
  const continueTargetModel =
    continuePick !== undefined && continuePick.tabId === tab?.id
      ? continuePick.model
      : undefined;

  // Owner of the work this composer bills (CAN-3463). AI Credits spill only
  // onto that owner's organization pool, so every credits read on this surface
  // (picker gating, Auto, banners, recovery) asks about this chat, not about
  // whichever org happens to be funded.
  const creditsProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId;
  const creditsWorktreeId =
    targetOverride?.worktreeId ?? selectedWorktree?.worktreeId;
  const creditsChatId = targetOverride?.chatId ?? tabId;
  const creditsScope = useMemo(
    () =>
      chatAiCreditsScope(creditsProjectId, creditsWorktreeId, creditsChatId),
    [creditsProjectId, creditsWorktreeId, creditsChatId],
  );
  const autoRouting = useAutoModelRoutingAvailability(creditsScope);
  const autoRoutingProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId;
  /**
   * Auto covers interactive chats only. The App Advisor, Pipeline Editor,
   * plan-explore, and code-review surfaces are Canopy-owned assistants with
   * their own model contracts — routing them per turn is explicitly out of
   * scope for V1, and main refuses to route them regardless.
   */
  const autoRoutingSurfaceEligible =
    autoRouting.offered &&
    tab !== null &&
    autoRoutingProjectId !== undefined &&
    autoRoutingProjectId !== APP_ADVISOR_PROJECT_ID &&
    autoRoutingProjectId !== PIPELINE_EDITOR_PROJECT_ID &&
    autoRoutingProjectId !== PLAN_EXPLORE_CHAT_PROJECT_ID &&
    autoRoutingProjectId !== CODE_REVIEW_CHAT_PROJECT_ID;
  const autoSelected = tab?.modelSelectionMode === 'auto';
  const handleSelectAuto = useCallback((): void => {
    void setModelSelectionMode('auto', targetOverride);
  }, [setModelSelectionMode, targetOverride]);
  const autoPickerOption = useMemo(() => {
    if (!autoRoutingSurfaceEligible) return undefined;
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
    autoRouting.unavailableAction,
    autoRouting.unavailableReason,
    autoRoutingSurfaceEligible,
    autoSelected,
    handleSelectAuto,
  ]);

  const handleModelChange = useCallback(
    (
      nextModel: ChatModel,
      billingFramework?: BillingFramework,
      executionHarness?: ModelHarness,
    ): void => {
      // A pick from the other harness never reaches `setModel` (the main
      // process would refuse it anyway). It opens the continue dialog, which
      // creates a NEW chat on the target provider instead.
      // Match the dialog's own target rather than "anything but the locked
      // provider", so a row outside the continuable pair can never open a dialog
      // that names a provider the pick is not for.
      const sourceTabId = tab?.id;
      if (
        sourceTabId &&
        lockedProvider &&
        continueEligibility?.ok === true &&
        (executionHarness ??
          pickProvider(
            nextModel,
            chatDefaultModel(
              (targetOverride ?? selectedWorktree)?.projectId,
              useChatStore.getState().modelDefaults,
            ),
          )) === continueTargetProvider
      ) {
        setContinueError(null);
        setContinuePick({
          tabId: sourceTabId,
          model: nextModel,
          ...(billingFramework ? { billingFramework } : {}),
        });
        return;
      }
      // Picking a concrete model IS the exit from Auto (plan Key Decisions).
      // Cleared here as well as in main so the chip stops reading `Auto`
      // on the same frame as the pick rather than after the canonical patch
      // round-trips.
      void setModelSelectionMode('manual', targetOverride);
      if (billingFramework || executionHarness) {
        void setModelAndWait(
          nextModel,
          targetOverride,
          executionHarness,
          billingFramework,
        );
      } else {
        setModel(nextModel, targetOverride);
      }
    },
    [
      continueEligibility,
      continueTargetProvider,
      lockedProvider,
      setModel,
      setModelAndWait,
      setModelSelectionMode,
      tab?.id,
      targetOverride,
      selectedWorktree,
      useChatStore,
    ],
  );

  /**
   * `handleModelChange`, but it reports whether the change actually LANDED.
   *
   * Used only by the recovery flow, which closes a modal on the strength of
   * this call. `setModel` is fire-and-forget and main refuses a cross-provider
   * change on a locked chat, so the ordinary path cannot tell a landed change
   * from a dropped one — and closing the modal over a dropped one is the exact
   * silent dead end CAN-2349 exists to remove. `setModelAndWait` surfaces
   * main's `accepted` answer, which is authoritative for the ORIGINATING chat
   * regardless of which chat the picker is rendering by then.
   *
   * Opening the continue dialog counts as landed: the user gets a visible
   * surface that carries the pick forward, which is the opposite of a silent
   * drop even though no model changed on THIS chat.
   */
  const handleRecoveryCommit = useCallback(
    async (
      nextModel: ChatModel,
      billingFramework?: BillingFramework,
      executionHarness?: ModelHarness,
    ): Promise<boolean> => {
      const sourceTabId = tab?.id;
      if (
        sourceTabId &&
        lockedProvider &&
        continueEligibility?.ok === true &&
        executionHarness !== 'opencode' &&
        pickProvider(
          nextModel,
          chatDefaultModel(
            (targetOverride ?? selectedWorktree)?.projectId,
            useChatStore.getState().modelDefaults,
          ),
        ) === continueTargetProvider
      ) {
        setContinueError(null);
        setContinuePick({
          tabId: sourceTabId,
          model: nextModel,
          ...(billingFramework ? { billingFramework } : {}),
        });
        return true;
      }
      // Resolve a CONCRETE target where we can prove one, so a chat switch
      // during an in-flight recovery cannot land the commit on whatever chat is
      // active by then — the cross-chat leak `recoveryModelChangeRef` and
      // `recoveryChatKey` exist to prevent.
      //
      // The MEMBERSHIP CHECK is load-bearing, not defensive. `selectedWorktree`
      // comes from the store while `sourceTabId` comes from the `tab` prop, and
      // those two can describe different chats: `PanelContentRoot` mounts
      // several layout keys, each with its own `PanelWorktreeContext`, so a
      // composer without `targetOverride` (`QueuedMessageEditor` renders one)
      // can belong to worktree A while the store's selection is B. Composing
      // `{B, tabOfA}` unchecked yields a target `getWorktreeChatContext`
      // resolves to B with `activeTab: undefined` — it does NOT bail — and
      // `changeModel` then reports success for a chat that does not exist,
      // closing the modal over a commit that landed nowhere. Falling back to
      // `undefined` restores the previous behavior, which at least always names
      // a real chat. Mirrors `watcherDestination` above.
      const target = ((): typeof targetOverride => {
        if (targetOverride) return targetOverride;
        if (!sourceTabId || !selectedWorktree) return undefined;
        const worktreeChat =
          useChatStore.getState().worktreeChats[
            `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
          ];
        return worktreeChat?.tabs.some(
          (candidate) => candidate.id === sourceTabId,
        )
          ? {
              projectId: selectedWorktree.projectId,
              worktreeId: selectedWorktree.worktreeId,
              chatId: sourceTabId,
            }
          : undefined;
      })();
      return setModelAndWait(
        nextModel,
        target,
        executionHarness,
        billingFramework,
      );
    },
    [
      continueEligibility,
      continueTargetProvider,
      lockedProvider,
      selectedWorktree,
      setModelAndWait,
      tab?.id,
      targetOverride,
      useChatStore,
    ],
  );

  /**
   * CAN-2349 case H — a cross-harness row that can NEVER be continued (an
   * Ollama pair). There is no transient state to wait out, so the picker offers
   * a fresh chat instead of refusing. Seed the model through `createTab`'s
   * `CreateTabTarget`: `setModel(nextModel, targetOverride)` captures the OLD
   * `chatId` on panel-targeted composers, and an async change-model IPC would
   * therefore update the source tab (or no-op) rather than the tab just made.
   *
   * Deliberately does NOT touch the current chat's model — that is the whole
   * difference between this and an ordinary pick, and the reason the picker
   * cannot just call `onModelChange`.
   */
  const handleStartNewChatWithModel = useCallback(
    (nextModel: ChatModel, billingFramework?: BillingFramework): void => {
      const target = targetOverride
        ? {
            projectId: targetOverride.projectId,
            worktreeId: targetOverride.worktreeId,
          }
        : selectedWorktree;
      if (!target) return;
      if (billingFramework)
        useChatStore.getState().rememberBillingFramework(billingFramework);
      createTab({ ...target, model: nextModel, modelExplicitlyChosen: true });
    },
    [createTab, selectedWorktree, targetOverride],
  );
  /**
   * Whether case H can actually deliver a new chat.
   *
   * `ModelPicker` derives `canStartNewChat` from `onStartNewChat !== undefined`
   * and clears its pending recovery BEFORE invoking the handler, so offering
   * the affordance without a resolvable target would close the modal and do
   * nothing — a dead click, on the one recovery branch with no async surface to
   * report the failure through. Withholding the prop instead lets the gate fall
   * back to the hard-disabled reason, which at least explains itself.
   */
  const canStartNewChatWithModel = Boolean(targetOverride ?? selectedWorktree);
  const closeContinueDialog = useCallback((): void => {
    setContinuePick(undefined);
    setContinueError(null);
  }, []);

  // Identifies the continue operation currently allowed to own the dialog's
  // state. A run whose token has been retired must not touch `continuePick`,
  // `continueError` or `continueBusy` on its way out, because by then those
  // belong to a different chat.
  const continueRunIdRef = useRef(0);

  // Hiding the pick on a chat switch is not enough on a surface that preserves
  // this component across the switch (Plan Explore and Pipeline Assistant): the
  // pick would still be sitting there, so switching BACK would resurrect the
  // dialog — with a stale error attached — long after the user moved on. Drop
  // it instead.
  //
  // Retiring the in-flight run matters just as much, and clearing the pick
  // alone does not do it. `continueBusy` and the pending callback outlive the
  // switch, so a dialog opened on the next chat would render already-busy
  // (Confirm dead, Cancel disabled) and then be closed, or shown the previous
  // chat's error, whenever the old request finally settled.
  //
  // Keyed off an actual change in tab identity rather than a dependency list:
  // putting `continueBusy` in deps would re-run this when the spinner clears
  // and wipe the very `continueError` the dialog just set.
  const activeComposerTabId = tab?.id;
  const lastComposerTabIdRef = useRef(activeComposerTabId);
  useEffect(() => {
    if (lastComposerTabIdRef.current === activeComposerTabId) return;
    lastComposerTabIdRef.current = activeComposerTabId;
    continueRunIdRef.current += 1;
    setContinuePick(undefined);
    setContinueError(null);
    setContinueBusy(false);
  }, [activeComposerTabId]);

  const handleConfirmContinue = useCallback((): void => {
    if (continueBusy || continuePick === undefined) return;
    // Re-check at confirm time: if the active chat moved on, the dialog is
    // already hidden and confirming must not continue the newly-selected chat.
    if (continuePick.tabId !== tab?.id) {
      setContinuePick(undefined);
      setContinueError(null);
      return;
    }
    const { tabId, model, billingFramework } = continuePick;
    const runId = continueRunIdRef.current + 1;
    continueRunIdRef.current = runId;
    setContinueBusy(true);
    setContinueError(null);
    void (async (): Promise<void> => {
      try {
        const result = await continueTabOnProvider(
          tabId,
          model,
          targetOverride,
          ...(billingFramework ? [billingFramework] : []),
        );
        if (result.status === 'created' && billingFramework) {
          useChatStore.getState().rememberBillingFramework(billingFramework);
        }
        // A retired run still created (or failed to create) its chat in the
        // store — that part is done and correct. It just no longer owns this
        // dialog, so it reports nothing rather than reporting to the wrong one.
        if (continueRunIdRef.current !== runId) return;
        if (result.status === 'failed') {
          // Keep the dialog open so the user sees why nothing happened. The
          // store creates no tab on failure, so there is nothing to roll back.
          setContinueError(result.message);
          return;
        }
        setContinuePick(undefined);
      } catch (error: unknown) {
        // `continueTabOnProvider` converts expected failures into a `failed`
        // result, so reaching here means something unexpected threw. Without
        // this the dialog would just stop spinning and silently do nothing.
        if (continueRunIdRef.current !== runId) return;
        setContinueError(extractIpcErrorMessage(error));
      } finally {
        if (continueRunIdRef.current === runId) setContinueBusy(false);
      }
    })();
  }, [
    continueBusy,
    continuePick,
    continueTabOnProvider,
    tab?.id,
    targetOverride,
  ]);
  const providerAvailability = useProviderAvailability(creditsScope);
  const selectedRepoId = tab?.selectedRepoId;
  const hasStartedSession = tab?.hasStartedSession ?? false;

  const livePendingAttachments = useChatTabRenderState(
    composerChatTarget,
    useShallow(
      ({ tab: currentTab }): AttachmentMeta[] =>
        currentTab?.pendingAttachments ?? [],
    ),
  );
  const pendingAttachments: AttachmentMeta[] = editingState
    ? editingState.attachments
    : livePendingAttachments;

  // Editor selections staged on this tab (CAN-1250). Queued-message editing
  // has no selection chips — chips belong to the live composer only.
  const livePendingSelections = useChatStore((s) =>
    tabId !== undefined ? s.pendingEditorSelections[tabId] : undefined,
  );
  const pendingSelections = isEditingQueued
    ? NO_PENDING_SELECTIONS
    : (livePendingSelections ?? NO_PENDING_SELECTIONS);
  // The chips row owns the (provider-bound) freshness subscription and reports
  // the latest map here for send-time serialization.
  const selectionFreshnessRef = useRef<Record<string, SelectionFreshness>>({});
  const handleSelectionFreshnessChange = useCallback(
    (freshness: Record<string, SelectionFreshness>): void => {
      selectionFreshnessRef.current = freshness;
    },
    [],
  );

  const handleRevealSelection = useCallback(
    (selection: EditorSelectionContext): void => {
      // Passive reveal (chip focused): highlight the range in any editor that
      // currently shows the file, without opening tabs or stealing panels.
      const detail: RevealEditorRangeDetail = {
        absolutePath: selection.absolutePath,
        startLine: selection.startLine,
        startColumn: selection.startColumn,
        endLine: selection.endLine,
        endColumn: selection.endColumn,
      };
      document.dispatchEvent(
        new CustomEvent(REVEAL_EDITOR_RANGE_EVENT, { detail }),
      );
    },
    [],
  );

  const handleOpenSelection = useCallback(
    (selection: EditorSelectionContext): void => {
      // Full open (chip activated): stash the reveal so a newly mounted or
      // still-loading editor picks it up, then open/activate the file tab.
      const detail: RevealEditorRangeDetail = {
        absolutePath: selection.absolutePath,
        startLine: selection.startLine,
        startColumn: selection.startColumn,
        endLine: selection.endLine,
        endColumn: selection.endColumn,
      };
      stashPendingEditorRangeReveal(detail);
      document.dispatchEvent(
        new CustomEvent(REVEAL_EDITOR_RANGE_EVENT, { detail }),
      );
      useChatStore.getState().openFileTab({
        absolutePath: selection.absolutePath,
        filename:
          selection.displayPath.split('/').pop() ?? selection.displayPath,
      });
    },
    [useChatStore],
  );

  const handleRemoveSelection = useCallback(
    (selectionId: string): void => {
      if (tabId === undefined) return;
      useChatStore.getState().removePendingEditorSelection(tabId, selectionId);
    },
    [tabId, useChatStore],
  );

  const effectiveProviderType = useMemo(
    () => resolveEffectiveProviderType(model, providerType),
    [model, providerType],
  );
  // Match the provider key used by discovery requests. Ollama on Claude
  // retains its local endpoint even though its execution harness is Claude.
  const discoveryProviderType = resolveDiscoveryProviderType({
    model,
    providerType: effectiveProviderType,
    executionHarness: lockedHarness ?? draftExecutionHarness,
  });
  const isAccountHarness = isPlanModeReadOnly(effectiveProviderType);
  // The exact speed requested for this chat's next turn (never a claim about
  // the turn in flight); the legacy boolean never outranks it.
  const storedSpeed = tab ? tabRequestedCodexSpeed(tab) : 'standard';
  // A cloud chat's model is listed by its web core catalog, not the desktop
  // model registry: its thinking levels come from there (CAN-6175 R5).
  const webCoreProjectId =
    composerProjectId !== undefined && isWebCoreScope(composerProjectId)
      ? composerProjectId
      : undefined;
  // Why the web core refused this cloud chat's last send (CAN-6364).
  const sendRefusalTarget = useMemo(
    () =>
      webCoreProjectId !== undefined &&
      composerWorktreeId !== undefined &&
      tabId
        ? {
            projectId: webCoreProjectId,
            worktreeId: composerWorktreeId,
            chatId: tabId,
          }
        : null,
    [composerWorktreeId, tabId, webCoreProjectId],
  );
  const sendRefusal = useChatStore((s) =>
    sendRefusalTarget === null
      ? undefined
      : s.worktreeChats[
          `${sendRefusalTarget.projectId}/${sendRefusalTarget.worktreeId}`
        ]?.tabs.find((entry) => entry.id === sendRefusalTarget.chatId)
          ?.sendRefusal,
  );
  // A cloud chat's skills, plugins and MCP servers are its web core
  // catalog's, in the picker the web's cloud chats use (CAN-6175 R5).
  // A tab this window created keeps the id it minted, which the web core
  // backend maps to the chat's own once it sends the creation: read on every
  // render, since the tab itself doesn't change when that happens.
  const cloudTabId = webCoreProjectId === undefined ? undefined : tab?.id;
  const cloudChatId =
    cloudTabId === undefined ? null : webCoreChatId(cloudTabId);
  const cloudPluginsTarget = useMemo(() => {
    if (webCoreProjectId === undefined || cloudTabId === undefined) return null;
    const workspaceId = webCoreLocalId(webCoreProjectId);
    const worktreeId =
      composerWorktreeId === undefined
        ? null
        : webCoreLocalId(composerWorktreeId);
    return workspaceId === null || worktreeId === null || cloudChatId === null
      ? null
      : { key: cloudTabId, workspaceId, worktreeId, chatId: cloudChatId };
  }, [cloudChatId, cloudTabId, composerWorktreeId, webCoreProjectId]);
  useEffect(() => {
    if (webCoreProjectId !== undefined)
      void loadWebCoreModels(webCoreProjectId);
  }, [webCoreProjectId]);
  const webCoreModels = useWebCoreModelCatalogStore(
    useShallow((state) =>
      webCoreProjectId === undefined
        ? undefined
        : webCoreModelList(state, webCoreProjectId),
    ),
  );
  const webCoreLabel = useWebCoreModelCatalogStore((state) =>
    webCoreProjectId === undefined
      ? undefined
      : webCoreModelLabel(state, webCoreProjectId, model),
  );
  const webCoreLevels = useWebCoreModelCatalogStore(
    useShallow((state) =>
      webCoreProjectId === undefined
        ? undefined
        : webCoreThinkingLevels(state, webCoreProjectId, model),
    ),
  );
  // A cloud chat's fast mode runs where its model's catalog says so, and is
  // the window's choice for its sends (CAN-6322).
  const webCoreModelRunsFast = useWebCoreModelCatalogStore((state) =>
    webCoreProjectId === undefined
      ? false
      : webCoreModelOption(state, webCoreProjectId, model)?.supportsFastMode ===
        true,
  );
  const webCoreFastMode = useWebCoreFastModeStore((state) =>
    tab ? state.byChat[tab.id] === true : false,
  );
  const supportsFastMode =
    scopeCapabilities.chatFastMode === true &&
    (webCoreProjectId !== undefined
      ? webCoreModelRunsFast
      : effectiveProviderType
        ? modelConfigForProviderSupportsFastMode(effectiveProviderType)
        : false);
  // The Codex speed route is this computer's: a cloud chat never reads it.
  const localSpeedControl = supportsFastMode && webCoreProjectId === undefined;
  // A cloud model that runs fast mode without effort levels gets the
  // speed-only panel.
  const cloudSpeedOnly = supportsFastMode && webCoreProjectId !== undefined;
  // Thinking controls follow the captured (locked) or effective execution
  // harness — a Codex-harnessed gateway/Ollama model shows Codex effort
  // semantics — while billing, fast-mode, and source-specific affordances
  // keep following the model's source provider.
  const thinkingHarness = useThinkingHarness({
    lockedHarness,
    executionHarness: draftExecutionHarness,
    model,
    effectiveProviderType,
  });
  const isCodex = thinkingHarness === 'codex';
  // Capability lookups must follow the billing route the session executes
  // on: an AI-Credits-routed chat displays and cycles the gateway-advertised
  // set, not the model's native tiers.
  const aiCreditsRouted = tab ? isTabAiCreditsRouted(tab) : false;
  const supportedThinkingLevels =
    webCoreLevels ??
    getEffectiveSupportedThinkingLevelsForModel(
      model,
      aiCreditsRouted,
      effectiveProviderType ?? 'claude',
      thinkingHarness,
    );
  const effortVisible =
    supportedThinkingLevels.length > 0 &&
    scopeCapabilities.chatThinkingLevel === true;
  // Tiers the model does not support display as the nearest lower supported
  // tier (e.g. `ultra` on non-Ultra models) while the canonical stored value
  // is preserved until the user cycles. Gateway-advertised supported levels
  // are honored through the hydrated model registry.
  const displayThinkingLevel = clampThinkingLevelForModel(
    thinkingLevel,
    model,
    thinkingHarness,
    aiCreditsRouted,
    supportedThinkingLevels,
  );
  // Speed availability follows this chat's actual route: its model, Auto
  // routing, captured harness, and billing lane. Only Codex chats read it.
  const speedControl = useContextualCodexSpeedControl({
    enabled: localSpeedControl,
    context:
      tab && composerProjectId && composerWorktreeId
        ? {
            kind: 'chat',
            projectId: composerProjectId,
            worktreeId: composerWorktreeId,
            chatId: tab.id,
          }
        : null,
    revalidationKey: JSON.stringify([
      lockedHarness ?? draftExecutionHarness,
      tab?.aiCreditsRouting,
      tab?.subscriptionBillingOverride,
    ]),
    route: {
      model,
      auto: autoSelected,
      capturedHarness: lockedHarness ?? draftExecutionHarness,
      aiCreditsRouted,
    },
  });
  // A model that cannot run Ultra fast steps the chat down to Fast (or
  // Regular) rather than holding a choice its next turn would be refused.
  const localRequestedSpeed = useCodexSpeedDowngrade({
    enabled: localSpeedControl,
    speed: storedSpeed,
    control: speedControl,
    apply: (next): void => void setSpeed(next, targetOverride),
  });
  // A cloud chat offers Regular and Fast.
  const requestedSpeed: CodexSpeed =
    webCoreProjectId === undefined
      ? localRequestedSpeed
      : webCoreFastMode
        ? 'fast'
        : 'standard';
  const nextSpeed: CodexSpeed =
    webCoreProjectId === undefined
      ? nextCodexSpeed(requestedSpeed, speedControl.states)
      : requestedSpeed === 'fast'
        ? 'standard'
        : 'fast';
  // Speed applies to the next turn; an active turn is never interrupted.
  // Regular → Fast → Ultra fast, where the route offers it.
  const cycleSpeed = useCallback((): void => {
    void setSpeed(nextSpeed, targetOverride);
  }, [setSpeed, nextSpeed, targetOverride]);
  // Live session pending exit (from global store) or restored from persistence
  const pendingExit: PendingPlanExit | null = useMemo(() => {
    return resolveComposerPendingPlanExit(tab, composerScope, pendingPlanExits);
  }, [pendingPlanExits, composerScope, tab]);

  // The waiting plan whose unsent comments the prompt warns about. The exit
  // must be in this composer's own scope; identifiers from another scope
  // (a persisted exit read against a different selected worktree) are never
  // combined, so the notice is simply absent.
  const pendingExitProjectId = pendingExit?.projectId;
  const pendingExitWorktreeId = pendingExit?.worktreeId;
  const pendingExitChatId = pendingExit?.chatId;
  const planCommentsTarget = useMemo((): PlanApprovalCommentsTarget | null => {
    if (
      !trackedPlanId ||
      !pendingExitChatId ||
      !composerProjectId ||
      !composerWorktreeId ||
      pendingExitProjectId !== composerProjectId ||
      pendingExitWorktreeId !== composerWorktreeId
    ) {
      return null;
    }
    return {
      projectId: composerProjectId,
      worktreeId: composerWorktreeId,
      planId: trackedPlanId,
      chatId: pendingExitChatId,
    };
  }, [
    trackedPlanId,
    pendingExitChatId,
    pendingExitProjectId,
    pendingExitWorktreeId,
    composerProjectId,
    composerWorktreeId,
  ]);
  // Copy plan copies this proposal's own Markdown, never the serialized tool
  // input `getPendingPlanText` falls back to (CAN-5354).
  const pendingPlanCopy = useMemo((): PlanCopyState | undefined => {
    if (pendingExit === null) return undefined;
    const plan = pendingExit.toolInput.plan;
    return planCopyStateFromMarkdown(typeof plan === 'string' ? plan : null);
  }, [pendingExit]);

  // A waiting plan turns the composer into the plan-approval prompt.
  // Closing it (x, Escape) keeps the plan waiting: Plan's chip beside
  // + then reads "Plan ready" and reopens it. The choice is per plan request,
  // so the next plan asks again.
  const planRequestKey =
    pendingExit === null
      ? null
      : `${pendingExit.chatId}:${pendingExit.requestId}`;
  const [closedPlanRequestKey, setClosedPlanRequestKey] = useState<
    string | null
  >(null);
  const planWaiting =
    !hidePlanMode && !isEditingQueued && planRequestKey !== null;
  const planCardOpen = planWaiting && closedPlanRequestKey !== planRequestKey;
  const planReady = planWaiting && !planCardOpen;

  // A waiting question turns the composer into the question prompt, as a
  // plan does. Closing it (x, Escape) keeps the question waiting: the
  // "Question" chip beside + then reopens it. A question asks before a plan.
  // App Advisor asks through its own store rather than the chat's MCP
  // questions: its composer takes the question its chat asked, and one whose
  // chat is not in this Work Entry (or names none), so a question is never
  // out of sight; it answers through that store.
  const isAppAdvisorComposer = composerProjectId === APP_ADVISOR_PROJECT_ID;
  const appAdvisorEntryTabIds = useChatStore(
    useShallow((s): string[] =>
      isAppAdvisorComposer
        ? (s.worktreeChats[
            `${composerProjectId}/${composerWorktreeId ?? ''}`
          ]?.tabs.map((entry) => entry.id) ?? [])
        : [],
    ),
  );
  const appAdvisorQuestion = useAppAdvisorStore((s) =>
    isAppAdvisorComposer && !isEditingQueued && !readOnly
      ? s.pendingQuestions.find(
          (entry) =>
            entry.chatId === undefined ||
            entry.chatId === tab?.id ||
            !appAdvisorEntryTabIds.includes(entry.chatId),
        )
      : undefined,
  );
  const appAdvisorPending = useMemo(
    (): ComposerPendingQuestion | undefined =>
      appAdvisorQuestion
        ? {
            requestId: appAdvisorQuestion.requestId,
            questions: [appAdvisorQuestion.question],
          }
        : undefined,
    [appAdvisorQuestion],
  );
  const appAdvisorDelivery = useMemo(
    (): ComposerQuestionDelivery | undefined =>
      isAppAdvisorComposer ? APP_ADVISOR_QUESTION_DELIVERY : undefined,
    [isAppAdvisorComposer],
  );
  const activeQuestion: ComposerPendingQuestion | undefined =
    appAdvisorPending ?? composerQuestions[0];
  const questionPrompt = useComposerQuestionPrompt(
    activeQuestion,
    onDeliveryChange,
    appAdvisorDelivery,
  );
  const questionPromptClosed = useQuestionPromptClosed(
    activeQuestion?.requestId,
  );
  const questionPromptOpen =
    activeQuestion !== undefined && !questionPromptClosed;
  const questionReady = activeQuestion !== undefined && !questionPromptOpen;
  /** The composer box is asking something: a question or a plan. */
  const promptOpen = questionPromptOpen || planCardOpen;
  const questionPlaceholder = questionPromptPlaceholder(
    questionPrompt.prompt.question,
  );

  // Canonical runtime decides whether a turn is running (a pending sending
  // lease counts until main acknowledges it), never the tab's local status.
  // Awaiting plan approval is treated as turn-ended (no cancel button, no
  // spinner).
  const composerTurn = useComposerTurnActivity(composerChatTarget, tab?.status);
  const isStreaming = composerTurn.activity !== 'idle' && !pendingExit;
  // A model or thinking-level change made mid-turn on a session that applies
  // setters only from its next turn (OpenCode) shows as pending beside the
  // controls until that turn ends.
  const pendingTurnSettingsState = usePendingTurnSettings({
    projectId: targetOverride?.projectId ?? selectedWorktree?.projectId,
    worktreeId: targetOverride?.worktreeId ?? selectedWorktree?.worktreeId,
    chatId: tab?.id,
    turnActive: isStreaming,
    model,
    thinkingLevel,
    supportedThinkingLevels,
  });
  const handleCancelRunningChat = useCallback((): void => {
    void cancelSession(targetOverride);
  }, [cancelSession, targetOverride]);
  useCancelRunningChatShortcut({
    enabled: isStreaming,
    // Only the active panel owns document-level composer shortcuts. Keeping
    // this separate from `enabled` prevents panel-focus handoffs from
    // disarming a still-running chat's confirmation.
    active: composerShortcutsEnabled && !isEditingQueued,
    onCancel: handleCancelRunningChat,
    chatKey: cancelShortcutChatKey,
    ownerDocument: cancelShortcutOwnerDocument,
    targetRootRef: cancelShortcutTargetRootRef,
  });

  // Only a turn main runs qualifies, never an unacknowledged send, and the
  // warning waits for a fresh read to confirm that same turn.
  const stuckMinutes = useStuckAgentTimer(
    composerTurn.activity === 'active' &&
      !pendingExit &&
      tab?.hasActiveAgentStep !== true,
    lastEventAt,
    tab?.id,
    composerTurn.confirmStuckTurn,
  );

  const resourceGuardBlock = useResourceMonitorStore(
    useShallow((s) => {
      const snapshot = s.snapshot;
      if (!snapshot || snapshot.guards.chatTurns.blocked !== true) {
        return null;
      }
      const { chatTurns } = snapshot.guards;
      const memoryCritical = snapshot.pressure.level === 'critical';
      return {
        reason: memoryCritical ? 'memory' : 'concurrency',
        maxConcurrentTurns: chatTurns.maxConcurrentTurns,
      };
    }),
  );
  const isResourceGuardBlocked = resourceGuardBlock !== null;
  // Follows the "Sending paused" title on the same line: the cause, then
  // what lifts it.
  const resourceGuardMessage: string | null = resourceGuardBlock
    ? resourceGuardBlock.reason === 'memory'
      ? 'Memory pressure is high, so sends resume when active work finishes.'
      : resourceGuardBlock.maxConcurrentTurns !== null
        ? `${brandText.appName} is at its limit of ${String(resourceGuardBlock.maxConcurrentTurns)} concurrent chat turn${resourceGuardBlock.maxConcurrentTurns === 1 ? '' : 's'}, so wait for one to finish before sending another.`
        : 'Sends resume when active work finishes.'
    : null;

  const [pluginsModalOpen, setPluginsModalOpen] = useState(false);
  // Inherited default layers (project, global, and the globals the project
  // turned off) frozen when the plugins modal opens: display and the
  // save-time split must use the same snapshot, or a defaults change landing
  // mid-modal would misclassify entries (an added default would look turned
  // off, a removed one would get pinned as local). `null` = the chat does not
  // inherit defaults.
  const [pluginsModalInheritedLayers, setPluginsModalInheritedLayers] =
    useState<InheritedPluginLayers | null>(null);
  const openPluginsModal = useCallback(async (): Promise<void> => {
    if (webCoreProjectId !== undefined) {
      if (cloudPluginsTarget !== null) setPluginsModalOpen(true);
      return;
    }
    // Retries a failed startup hydration and waits before mounting the picker.
    // Opening against an unhydrated empty overlay would render globally
    // supplied plugins unchecked and make unchecking them a silent no-op.
    const hydrated = await useGlobalPluginDefaultsStore.getState().hydrate();
    const defaultsStore = useGlobalPluginDefaultsStore.getState();
    if (globalOverlayEligible && (!hydrated || !defaultsStore.hydrated)) {
      addToast(
        'Could not load global plugin defaults. Try opening Plugins again.',
        'error',
      );
      return;
    }
    const projectDefaults =
      overlayProjectId !== undefined &&
      overlayWorktreeId !== undefined &&
      tabInheritsProjectDefaults
        ? getProjectPluginDefaults(
            overlayProjectId,
            overlayWorktreeId,
            useChatStore.getState().worktreeDefaultPlugins,
          )
        : undefined;
    const projectTombstones =
      overlayProjectId !== undefined
        ? getProjectPluginTombstones(overlayProjectId)
        : undefined;
    setPluginsModalInheritedLayers(
      globalOverlayEligible
        ? {
            ...(projectDefaults
              ? { projectDefaults: normalizePluginSelections(projectDefaults) }
              : {}),
            ...(defaultsStore.hydrated
              ? { global: defaultsStore.selections }
              : {}),
            ...(projectTombstones ? { projectTombstones } : {}),
          }
        : null,
    );
    setPluginsModalOpen(true);
  }, [
    addToast,
    cloudPluginsTarget,
    globalOverlayEligible,
    overlayProjectId,
    overlayWorktreeId,
    tabInheritsProjectDefaults,
    webCoreProjectId,
  ]);
  const [linearPickerOpen, setLinearPickerOpen] = useState(false);
  const [pipelineModalOpen, setPipelineModalOpen] = useState(false);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineRunError, setPipelineRunError] = useState<string | null>(null);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const setPluginSelections = useChatStore((s) => s.setPluginSelections);

  const lockedSkillKeys = useMemo(
    () =>
      new Set(
        (lockedSkillRefs ?? []).map(
          (ref) => `${ref.sourceId}/${ref.skillName}`,
        ),
      ),
    [lockedSkillRefs],
  );
  const hasPluginSelections =
    (effectivePluginSelections?.collectionIds?.length ?? 0) > 0 ||
    (effectivePluginSelections?.bundleIds?.length ?? 0) > 0 ||
    (effectivePluginSelections?.skillRefs ?? []).some(
      (ref) => !lockedSkillKeys.has(`${ref.sourceId}/${ref.skillName}`),
    ) ||
    (effectivePluginSelections?.pluginRefs?.length ?? 0) > 0 ||
    (effectivePluginSelections?.mcpServerRefs?.length ?? 0) > 0;

  const composerPopupAnchorRef = useRef<HTMLSpanElement>(null);
  const plusTriggerRef = useRef<HTMLButtonElement>(null);

  const tabDiscoveryLoading = useChatStore((s) => s.tabDiscoveryLoading);
  const refreshWorktreeTabDiscoveries = useChatStore(
    (s) => s.refreshWorktreeTabDiscoveries,
  );
  useEffect(() => {
    const previousAgentPluginSelections =
      previousAgentPluginSelectionsRef.current;
    if (previousAgentPluginSelections === agentPluginSelections) return;
    if (!slashCommandTarget || !tab) return;
    previousAgentPluginSelectionsRef.current = agentPluginSelections;

    refreshWorktreeTabDiscoveries(
      slashCommandTarget.projectId,
      slashCommandTarget.worktreeId,
    );
  }, [
    agentPluginSelections,
    refreshWorktreeTabDiscoveries,
    slashCommandTarget,
    tab,
  ]);
  const projects = useProjectsStore((s) => s.projects);
  const discoveryLoading = useProjectsStore((s) => s.discoveryLoading);

  const childRepos = useMemo(() => {
    if (!selectedWorktree) return [];
    const project = projects.find((p) => p.id === selectedWorktree.projectId);
    if (!project || project.type !== 'multi-repo') return [];
    return project.repos.map((repo) => ({ id: repo.id, name: repo.name }));
  }, [projects, selectedWorktree]);
  const isMultiRepo = childRepos.length > 0;

  const { allCommands, isRefreshing } = useMemo(() => {
    if (!slashCommandTarget || isAccountHarness)
      return { allCommands: [], isRefreshing: false };

    const project = projects.find((p) => p.id === slashCommandTarget.projectId);
    const worktree =
      project && project.type !== 'cowork'
        ? project.worktrees.find((w) => w.id === slashCommandTarget.worktreeId)
        : undefined;
    const slashCommands = selectDiscoverySlashCommands({
      providerType: discoveryProviderType,
      tabDiscovery,
      worktreeDiscovery: worktree?.discovery,
    });

    const commands = [...(slashCommands ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    // Check per-tab loading first, then worktree-level loading.
    const tabLoading = tab ? tabDiscoveryLoading.has(tab.id) : false;
    const wtKey = `${slashCommandTarget.projectId}/${slashCommandTarget.worktreeId}`;
    const refreshing = tabLoading || discoveryLoading.has(wtKey);

    return {
      allCommands: commands,
      isRefreshing: refreshing,
    };
  }, [
    slashCommandTarget,
    tab,
    tabDiscovery,
    projects,
    discoveryProviderType,
    isAccountHarness,
    tabDiscoveryLoading,
    discoveryLoading,
  ]);

  // Prebuilt invocable-inventory cache for the execution harness. Read-only;
  // the menu never scans skill/plugin folders on open.
  const inventoryProviderType = thinkingHarness;
  const invocableInventory = useInvocableInventory(inventoryProviderType);

  // Flatten the tab's selected Collections into their enabled skill/plugin refs
  // so already-enabled (via a Collection) inventory rows can be excluded. Loaded
  // through the renderer-accessible collection configs; no file parsing here.
  const collectionIdsKey = (
    effectivePluginSelections?.collectionIds ?? []
  ).join('\n');
  const [collectionEnabledRefs, setCollectionEnabledRefs] =
    useState<CollectionEnabledRefs>({ skillRefs: [], pluginRefs: [] });
  useEffect(() => {
    const ids = collectionIdsKey ? collectionIdsKey.split('\n') : [];
    if (ids.length === 0) {
      setCollectionEnabledRefs({ skillRefs: [], pluginRefs: [] });
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const configs = await Promise.all(
          ids.map((id) =>
            window.collections.loadCollection(id).catch(() => null),
          ),
        );
        if (cancelled) return;
        setCollectionEnabledRefs(flattenCollectionRefs(configs));
      } catch {
        if (!cancelled) {
          setCollectionEnabledRefs({ skillRefs: [], pluginRefs: [] });
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [collectionIdsKey]);

  // Merge discovered and cached inventory rows for every composer entry point.
  const { typeaheadCommands } = useMemo(() => {
    const {
      discoveredCommands,
      promotedInventoryCommands,
      availableInventoryCommands,
    } = buildSlashInventoryCommands({
      entries: invocableInventory.entries,
      discoveredCommands: allCommands,
      selections: effectivePluginSelections,
      collectionRefs: collectionEnabledRefs,
      isDiscovering: isRefreshing,
    });
    const typeahead: SlashCommandData[] = [
      ...discoveredCommands,
      ...promotedInventoryCommands,
      ...availableInventoryCommands,
    ];
    return {
      typeaheadCommands: typeahead,
    };
  }, [
    invocableInventory.entries,
    allCommands,
    effectivePluginSelections,
    collectionEnabledRefs,
    isRefreshing,
  ]);

  const serializedDraft = useMemo(() => serializeEditorValue(value), [value]);
  const mergedFileReferences = useMemo(
    () =>
      mergePromptAwareFileReferences(
        serializedDraft.fileReferences,
        extraFileReferences,
      ),
    [extraFileReferences, serializedDraft.fileReferences],
  );

  // Terminal mode: when the first non-whitespace character of the draft is `!`,
  // the composer switches into a "send the rest of the line as a shell command"
  // mode. Standalone-chat projects have no worktree-scoped terminal drawer to
  // send the command into, so the mode is gated on a real worktree. The shared
  // hook parses the command and owns the send's error/reset behavior; the run
  // itself is wired below, once the terminal target is known.
  const terminalModeEnabled =
    !disableTerminalMode &&
    selectedWorktree !== null &&
    selectedWorktree !== undefined &&
    !isCoworkChatTarget(selectedWorktree.projectId) &&
    !readOnly;
  const runTerminalCommandRef = useRef<(command: string) => Promise<void>>(() =>
    Promise.reject(new Error('Terminal mode is not ready')),
  );
  const terminalCommandSentRef = useRef<() => void>(() => undefined);
  const runInTerminal = useCallback(
    (command: string): Promise<void> => runTerminalCommandRef.current(command),
    [],
  );
  const handleTerminalCommandSent = useCallback(
    (): void => terminalCommandSentRef.current(),
    [],
  );
  const terminalMode = useTerminalComposerMode({
    draftText: serializedDraft.text,
    enabled: terminalModeEnabled,
    runInTerminal,
    onSent: handleTerminalCommandSent,
  });
  const isTerminalMode = terminalMode.active;
  const terminalCommand = terminalMode.command;
  const composerCommands = useMemo(
    () =>
      buildComposerCommands(typeaheadCommands, {
        home: false,
        fast: supportsFastMode,
      }),
    [typeaheadCommands, supportsFastMode],
  );
  const slashTypeaheadEnabled = composerCommands.length > 0 || isRefreshing;

  const composerMenu = useComposerMenu(editor, {
    enabled: !isTerminalMode && !readOnly,
    dollar: isCodex,
    // The scope is the composer's target only. A harness or provider switch
    // commits in main after the picker already reads the new model, so a `/`
    // typed in that window has Claude's rows open when the switch lands; the
    // rows re-project from `commands` for the new harness, whereas a scope
    // reset would dismiss the typed trigger and the menu would not return.
    scopeKey: `${slashCommandTarget?.projectId}/${slashCommandTarget?.worktreeId}/${tab?.id}`,
    onChange: () => setValue(structuredClone(editor.children)),
  });

  const fileTypeaheadEnabled =
    Boolean(selectedWorktree) &&
    !disableFileTypeahead &&
    scopeCapabilities.chatFileMentions === true;
  const fileListKey =
    fileTypeaheadEnabled && selectedWorktree
      ? getWorktreeCacheKey(
          selectedWorktree.projectId,
          selectedWorktree.worktreeId,
        )
      : null;
  const draftHasFileReferences = useMemo(
    () =>
      composerValueHasFileReferences(value) || extraFileReferences.length > 0,
    [extraFileReferences.length, value],
  );
  const { fileIndexLoading, fileRepos, resolveSubmissionFileRepos } =
    useComposerFileIndex({
      fileListKey,
      projectId: selectedWorktree?.projectId,
      worktreeId: selectedWorktree?.worktreeId,
      menuOpen: composerMenu.open,
      draftHasFileReferences,
    });

  // The `!` typeahead: approved repository scripts for the terminal-mode
  // draft. Selecting one only fills the box; the next Enter runs it.
  const replaceTerminalDraft = useCallback(
    (text: string): void => {
      messageHistoryNavigationRef.current = null;
      restoreEditorContent(editor, buildEditorValueFromMessage(text, []));
      setValue(structuredClone(editor.children));
      focusEditor(editor);
    },
    [editor],
  );
  const scriptTypeahead = useScriptTypeahead({
    available: terminalModeEnabled,
    terminalMode: isTerminalMode,
    projectId: slashCommandTarget?.projectId,
    worktreeId: slashCommandTarget?.worktreeId,
    selectedRepoId,
    multiRepo: fileRepos.length > 1,
    draftText: serializedDraft.text,
    caretOnFirstLine: caretOnFirstLine(editor.selection),
    replaceDraft: replaceTerminalDraft,
  });
  // Workspace items (notes/prompts/attachments) as extra `@` candidates.
  // Lazy-loaded per selection; prompt mentions expand at send time.
  // Scope to the composer's actual target: a `targetOverride` panel (cowork
  // work-entry chats and other embedded surfaces) may not match the globally
  // selected worktree, so prefer it just like `slashCommandTarget`. Without
  // this, cowork prompt @-mentions never expanded — the send-time
  // `expandPromptMentions` call keys off `mentionProjectId`, which was null/
  // mismatched for cowork panels and left the raw prompt path in the message.
  const mentionProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId ?? null;
  const mentionWorktreeId =
    targetOverride?.worktreeId ?? selectedWorktree?.worktreeId ?? null;
  useEffect(() => {
    if (!fileTypeaheadEnabled || !mentionProjectId || !mentionWorktreeId) {
      return;
    }
    const store = useWorkspaceItemsStore.getState();
    void store.loadNotes(mentionProjectId);
    void store.loadPrompts(mentionProjectId);
    if (filesGuestGate.status === 'signed-in')
      void store.loadAttachments(
        mentionProjectId,
        mentionWorktreeId,
        filesGuestGate.captureAccess(),
      );
  }, [
    fileTypeaheadEnabled,
    mentionProjectId,
    mentionWorktreeId,
    filesGuestGate,
  ]);
  const workspaceItemSources = useWorkspaceItemsStore(
    useShallow((s): WorkspaceItemMentionSources => {
      // Fallbacks must be the stable module-level empties: a fresh `[]` per
      // snapshot makes useShallow always see a change and loops the
      // useSyncExternalStore subscription (React max-update-depth crash).
      const attachmentsKey =
        mentionProjectId && mentionWorktreeId
          ? `${mentionProjectId}/${mentionWorktreeId}`
          : null;
      return {
        notes: mentionProjectId
          ? (s.notes[mentionProjectId] ?? EMPTY_NOTE_ITEMS)
          : EMPTY_NOTE_ITEMS,
        prompts: mentionProjectId
          ? (s.prompts[mentionProjectId] ?? EMPTY_PROMPT_ITEMS)
          : EMPTY_PROMPT_ITEMS,
        attachments:
          filesGuestGate.status === 'signed-in' && attachmentsKey
            ? (s.attachments[attachmentsKey] ?? EMPTY_ATTACHMENT_ITEMS)
            : EMPTY_ATTACHMENT_ITEMS,
      };
    }),
  );
  const workspaceItemSearch = useCallback(
    (query: string) => searchWorkspaceItemMentions(query, workspaceItemSources),
    [workspaceItemSources],
  );
  // The menu opened: list the inventory cache again so the backend can
  // re-check the inherited Cursor folders (home skills, the Cursor app's
  // plugin cache), which no Canopy mutation marks stale. Answered from the
  // cache; a change arrives as the usual inventory push.
  const composerMenuOpen = composerMenu.open;
  const reloadInvocableInventory = invocableInventory.reload;
  useEffect(() => {
    if (composerMenuOpen) void reloadInvocableInventory();
  }, [composerMenuOpen, reloadInvocableInventory]);
  const searchComposerFiles = useCallback(
    (query: string) =>
      fileTypeaheadEnabled
        ? [
            ...searchFileMentions(query, fileRepos, 50),
            ...workspaceItemSearch(query),
          ]
        : [],
    [fileTypeaheadEnabled, fileRepos, workspaceItemSearch],
  );
  const chatPlaceholder = useMemo(
    () => defaultChatPlaceholder(slashTypeaheadEnabled, fileTypeaheadEnabled),
    [fileTypeaheadEnabled, slashTypeaheadEnabled],
  );

  // -------------------------------------------------------------------------
  // Existing-session scheduled send + usage-limit resume
  // -------------------------------------------------------------------------

  // Genuine native persisted-chat target. Code worktree, Cowork, and App
  // Advisor composers all opt in explicitly when they render through a
  // `targetOverride`; embedded mirrors (pipeline editor, plan-explore, archived
  // transcripts) stay excluded. `workspaceId` in the automation action maps to
  // projectId for every supported context.
  const sessionChatTarget = useMemo<{
    projectId: string;
    worktreeId: string;
    chatId: string;
  } | null>(() => {
    if (editingState) return null;
    if (onSendMessage && !nativeSessionComposer) return null;
    if (targetOverride && !nativeSessionComposer) return null;
    const target = targetOverride
      ? targetOverride
      : tabId && selectedWorktree
        ? {
            projectId: selectedWorktree.projectId,
            worktreeId: selectedWorktree.worktreeId,
            chatId: tabId,
          }
        : null;
    if (!target) return null;
    const key = `${target.projectId}/${target.worktreeId}`;
    const wc = useChatStore.getState().worktreeChats[key];
    if (!wc?.tabs.some((candidate) => candidate.id === target.chatId)) {
      return null;
    }
    return target;
  }, [
    editingState,
    onSendMessage,
    targetOverride,
    nativeSessionComposer,
    tabId,
    selectedWorktree,
    useChatStore,
  ]);

  // The chat a Mod allow applies to: its repository finds a skills folder.
  const claudeModsComposerContext = useMemo(
    () =>
      sessionChatTarget
        ? {
            ...sessionChatTarget,
            ...(selectedRepoId !== undefined ? { repoId: selectedRepoId } : {}),
          }
        : null,
    [sessionChatTarget, selectedRepoId],
  );

  // Code-worktree-only actions remain scoped to real worktrees. Cowork and App
  // Advisor share scheduling, but do not gain worktree-specific plan detection
  // or the per-worktree "Just this time" routing override as a side effect.
  const worktreeChatTarget = useMemo(() => {
    if (!sessionChatTarget) return null;
    if (
      sessionChatTarget.projectId === APP_ADVISOR_PROJECT_ID &&
      sessionChatTarget.worktreeId === APP_ADVISOR_WORKTREE_ID
    ) {
      return null;
    }
    return isCoworkChatTarget(sessionChatTarget.projectId)
      ? null
      : sessionChatTarget;
  }, [sessionChatTarget]);

  // General chat target valid on EVERY surface (worktree, standalone, App
  // Advisor, pipeline editor, plan-explore). Unlike `worktreeChatTarget` this is
  // populated for `targetOverride` surfaces too, so shared banners keyed by
  // target (e.g. the AI Credits routing status) render everywhere (CAN-838).
  const modelDefaults = useChatStore((s) => s.modelDefaults);
  // CAN-1929 dead end: no (lane, model) pair is both payable and allowed by
  // org policy. Recomputed against `providerAvailability` because that is what
  // changes when the underlying lane facts settle — `resolveLaneForTarget`
  // itself reads the module-level runtime, not props.
  //
  // `resolveLaneForTarget` also reads module-level runtimes React cannot see —
  // the billing-lane availability written from an app-root effect, the policy
  // snapshot, and the model-registry/gateway-catalog hydration flags. None of
  // those move `providerAvailability` or `modelDefaults`, so the memo is
  // subscribed to their version counters as well; otherwise the banner stayed
  // stale through exactly the hydration that would have cleared it.
  //
  // The third argument is the same getter: these are module-level renderer
  // singletons with no server counterpart, and the static-markup render path
  // used by the component health tests requires it to be present.
  const laneFactsVersion = useSyncExternalStore(
    subscribeRendererBillingLaneFacts,
    getRendererBillingLaneFactsVersion,
    getRendererBillingLaneFactsVersion,
  );
  const modelFactsVersion = useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  const noDispatchableModel = useMemo<{
    missing: 'billing-lane' | 'policy-allowance' | 'both';
    lanesNeeded: readonly BillingLane[];
    policyRestricted: boolean;
    hasPolicyAllowedLane: boolean;
  } | null>(() => {
    const projectId = targetOverride?.projectId ?? selectedWorktree?.projectId;
    if (!projectId) return null;
    const resolution = resolveLaneForTarget(
      projectId,
      useChatStore.getState().modelDefaults,
    );
    return resolution?.outcome === 'no-dispatchable-model'
      ? {
          missing: resolution.missing,
          lanesNeeded: resolution.lanesNeeded,
          hasPolicyAllowedLane: resolution.hasPolicyAllowedLane,
          // Whether an org model policy is ACTUALLY in force (CAN-2436).
          //
          // `missing` / `lanesNeeded` cannot answer this. The resolver derives
          // `lanesNeeded` from `policyAllowedLanes`, and a lane drops out of
          // that set either because policy blocked its candidates OR simply
          // because no candidate is runnable on it — a gateway-only default
          // leaves `['ai-credits']` with no org involved at all. The banner
          // uses that same shape to say "your organization only allows…", so
          // without this flag it invents an organization the user may not have.
          //
          // An empty policy set means no restriction: `isModelBlocked` tests
          // membership, so nothing is blocked and the dead end is about
          // billing, not allowance.
          policyRestricted: getRendererModelPolicy().size > 0,
        }
      : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    targetOverride,
    selectedWorktree,
    providerAvailability,
    modelDefaults,
    laneFactsVersion,
    modelFactsVersion,
  ]);
  // What an Agent that inherits the default would run on in this chat.
  const inheritedDefaultModel = useMemo((): ChatModel | undefined => {
    const projectId = targetOverride?.projectId ?? selectedWorktree?.projectId;
    return projectId
      ? resolveTabDefaults(projectId, modelDefaults).model
      : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    targetOverride,
    selectedWorktree,
    modelDefaults,
    laneFactsVersion,
    modelFactsVersion,
  ]);

  const bannerTarget = useMemo<ChatBannerTarget | null>(() => {
    if (editingState || (onSendMessage && !nativeSessionComposer)) return null;
    if (targetOverride) return targetOverride;
    if (!tabId || !selectedWorktree) return null;
    return {
      projectId: selectedWorktree.projectId,
      worktreeId: selectedWorktree.worktreeId,
      chatId: tabId,
    };
  }, [
    editingState,
    nativeSessionComposer,
    onSendMessage,
    targetOverride,
    tabId,
    selectedWorktree,
  ]);

  // The approval dock shows above this composer whenever its chat has a
  // pending approval and no queued message is being edited (CAN-4997).
  const approvalPending = useChatStore(
    (s): boolean =>
      !isEditingQueued &&
      bannerTarget !== null &&
      hasPendingApprovalForChat(
        s.pendingApprovals,
        bannerTarget.projectId,
        bannerTarget.worktreeId,
        bannerTarget.chatId,
      ),
  );
  // Next prompt suggestions (Labs): only a native session composer, whose
  // chat main sends them for, offers one.
  const promptSuggestionsEnabled = useLabsExperimentEnabled(
    PROMPT_SUGGESTIONS_EXPERIMENT_ID,
  );
  const promptSuggestionTarget = promptSuggestionsEnabled
    ? sessionChatTarget
    : null;
  const promptSuggestionEntry = usePromptSuggestionEntry(
    promptSuggestionTarget,
  );
  // A suggestion follows the turn it came from; a later send makes it stale.
  const latestUserMessageId = useChatStore((s): string | undefined => {
    if (!promptSuggestionTarget || !promptSuggestionEntry) return undefined;
    const messages = s.worktreeChats[
      `${promptSuggestionTarget.projectId}/${promptSuggestionTarget.worktreeId}`
    ]?.tabs.find(
      (candidate) => candidate.id === promptSuggestionTarget.chatId,
    )?.messages;
    if (!messages) return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') return messages[index].id;
    }
    return undefined;
  });
  // A newly displayed approval card takes focus only from the body or this
  // composer with no draft (`approval-focus-policy.ts`), evaluated now.
  const canApprovalTakeComposerFocus = useCallback((): boolean => {
    if (!isComposerVisible()) return false;
    const root = composerRootRef.current;
    const doc = getDocument(root);
    return canApprovalTakeFocus({
      activeElement: doc.activeElement,
      body: doc.body,
      composerRoot: root?.querySelector('[data-chat-textarea]') ?? null,
      composerDraftText: SlateNode.string(editor),
      composing: ReactEditor.isComposing(editor),
      modalOpen:
        doc.querySelector('[aria-modal="true"]') !== null ||
        doc.body.dataset.sidebarMenuOpen === 'true',
    });
  }, [editor, isComposerVisible]);
  // After the last approval that owned focus is answered, focus returns to
  // the composer with its draft intact; a hidden composer declines.
  const focusComposerAfterApproval = useCallback((): void => {
    if (!isComposerVisible()) return;
    focusEditor(editor);
  }, [editor, isComposerVisible]);

  // Main reports that it is behind the agent (phase 15c). While it is, the
  // composer says so instead of warning that the agent might be stuck.
  const catchingUpLag = useCatchingUpLag(bannerTarget);

  // Per-chat billing framework toggle for the model picker. Shown only when the
  // current model's provider has BOTH a native login and an AI Credits balance
  // (`nativeAuth && creditsEligible`); otherwise the single available framework
  // is chosen implicitly, exactly as before. The derived `value` prefers the
  // explicit per-tab bits, then falls back to the live routing-active signal so
  // the default is truthful when a global routing mode is silently routing.
  const billingRoutingActiveForChat = useAiCreditsRoutingActive(bannerTarget);
  const modelGatewayEnforced = useModelCatalogStore(
    (state) => state.modelGatewayEnforced,
  );
  const modelForBilling = model ?? fallbackModel;
  // A persisted model can disappear from the registry between launches. Keep
  // the composer renderable and prefer its persisted provider when available.
  const billingProvider =
    getProviderForModel(modelForBilling) ?? effectiveProviderType ?? 'claude';
  // Whether this chat's model, and the default credits model, can bill to AI
  // Credits (CAN-4900). The usage-limit banner, its actions, the switch to the
  // credits model, and stale-routing cleanup all read these. The answer
  // depends on the gateway catalog, so it re-derives when model facts change.
  const creditsModelRoutability = useMemo(
    () => resolveCreditsModelRoutability(modelForBilling),
    // Re-derive when the gateway catalog hydrates; React cannot see it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelForBilling, modelFactsVersion],
  );
  const creditsTargetRoutable = useMemo(
    () =>
      resolveCreditsModelRoutability(DEFAULT_CREDITS_CODEX_MODEL) ===
      'routable',
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelFactsVersion],
  );
  // An Agent bills as its base model, so the gate names the base model.
  const chatModelLabel = useMemo((): string | undefined => {
    if (!modelForBilling) return undefined;
    const baseModel = isAgentModel(modelForBilling)
      ? (resolveRuntimeModel(modelForBilling) ?? modelForBilling)
      : modelForBilling;
    return getModelDisplayName(baseModel);
    // Display names come from the model registry, which React cannot see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelForBilling, modelFactsVersion]);
  // Stored "just this time" routing stops after its reset time or a native
  // account change; main ignores it from then on, so the composer does too
  // (CAN-4200).
  const {
    inEffect: aiCreditsRoutingInEffect,
    accountChangedAt: billingAccountChangedAt,
  } = useEffectiveAiCreditsRouting(
    tab?.aiCreditsRouting,
    billingProvider === 'claude' || billingProvider === 'codex'
      ? billingProvider
      : undefined,
    bannerTarget,
    creditsModelRoutability,
  );
  // Which of the two "this turn cannot be paid for" banners owns the composer.
  // `OrgLapsedBanner` reports when it is speaking so `NoBillingSourceBanner`
  // stands down instead of stacking a purchase CTA on top of an explanation
  // that says to contact the org admin (CAN-2311 review round 3).
  const [orgLapseVisible, setOrgLapseVisible] = useState(false);
  // Single pure resolver drives BOTH the picker toggle and the AI Credits
  // banner, so they can never disagree. It locks the toggle (with a reason)
  // when only one billing framework is possible for this model + account, and
  // reports the effective framework plus `aiCreditsBannerVisible` — the
  // banner's own gate, deliberately narrower than `framework === 'ai-credits'`
  // for gateway-only models. Native-capable models keep the switch while auth
  // is inconclusive; a confirmed sign-out with available credits and no
  // explicit subscription override locks to credits, so the card offers no
  // switch (CAN-5349). Applies streaming or idle.
  const billingResolution = useMemo<ChatBillingResolution>(
    () =>
      resolveChatBillingFramework({
        model: modelForBilling,
        provider: billingProvider,
        availability: providerAvailability[billingProvider],
        aiCreditsRoutingActive: aiCreditsRoutingInEffect,
        subscriptionBillingOverride: tab?.subscriptionBillingOverride ?? false,
        routingActiveForChat: billingRoutingActiveForChat,
        modelGatewayEnforced,
      }),
    [
      modelForBilling,
      billingProvider,
      providerAvailability,
      aiCreditsRoutingInEffect,
      tab?.subscriptionBillingOverride,
      billingRoutingActiveForChat,
      modelGatewayEnforced,
    ],
  );
  // Whether the "Using AI Credits" card will show once this chat can spend
  // credits. Credits bought from the No billing source banner are confirmed
  // in that card, and the CTA learns of a purchase before this composer's
  // eligibility read does; the banner waits for the card instead of flashing
  // its own notice first (CAN-5160).
  const aiCreditsCardExpected = useMemo((): boolean => {
    const availability = providerAvailability[billingProvider];
    if (!availability || availability.creditsEligible) {
      return billingResolution.aiCreditsBannerVisible;
    }
    return resolveChatBillingFramework({
      model: modelForBilling,
      provider: billingProvider,
      availability: { ...availability, creditsEligible: true },
      aiCreditsRoutingActive: aiCreditsRoutingInEffect,
      subscriptionBillingOverride: tab?.subscriptionBillingOverride ?? false,
      routingActiveForChat: billingRoutingActiveForChat,
      modelGatewayEnforced,
    }).aiCreditsBannerVisible;
  }, [
    billingResolution.aiCreditsBannerVisible,
    modelForBilling,
    billingProvider,
    providerAvailability,
    aiCreditsRoutingInEffect,
    tab?.subscriptionBillingOverride,
    billingRoutingActiveForChat,
    modelGatewayEnforced,
  ]);
  const billingControl = useMemo<
    | {
        value: 'subscription' | 'ai-credits';
        onChange: (framework: 'subscription' | 'ai-credits') => void;
        allowUnverifiedSubscription?: boolean;
        disabled?: boolean;
        lockedReason?: string;
        lockKind?: ChatBillingResolution['lockKind'];
        provider: AgentProviderType;
      }
    | undefined
  >(() => {
    if (!bannerTarget) return undefined;
    const { framework, toggleVisible, toggleDisabled, lockedReason, lockKind } =
      billingResolution;
    if (!toggleVisible || !framework) return undefined;
    const autoLaneLocked = autoSelected && hasStartedSession;
    return {
      value: framework,
      allowUnverifiedSubscription: tab?.subscriptionBillingOverride === true,
      disabled: toggleDisabled || autoLaneLocked,
      provider: billingProvider,
      ...(autoLaneLocked
        ? { lockedReason: 'Start a new chat to change billing.' }
        : lockedReason
          ? { lockedReason }
          : {}),
      // A started Auto lane lock cannot offer the probe-recovery action.
      ...(lockKind && !autoLaneLocked ? { lockKind } : {}),
      onChange: (nextFramework): void => {
        selectBillingFramework(nextFramework, bannerTarget);
      },
    };
  }, [
    autoSelected,
    bannerTarget,
    billingProvider,
    billingResolution,
    hasStartedSession,
    selectBillingFramework,
    tab?.subscriptionBillingOverride,
  ]);

  // Credits bought from a non-worktree chat's usage-limit banner route that
  // chat through the picker's own per-chat choice (CAN-5159). A hidden or
  // locked toggle leaves the banner without it.
  const canUseCreditsForThisChat =
    worktreeChatTarget === null &&
    billingControl !== undefined &&
    billingControl.disabled !== true;
  const handleUseCreditsForThisChat = useCallback((): void => {
    // The banner offers nothing for a model that can't run on credits; the
    // catalog can still change between render and click (CAN-4900).
    if (!bannerTarget || creditsModelRoutability !== 'routable') return;
    selectBillingFramework('ai-credits', bannerTarget);
  }, [creditsModelRoutability, selectBillingFramework, bannerTarget]);

  // The routing card's "Switch to subscription" acts exactly like the picker's
  // subscription choice. Unlike the picker it ignores the Auto lane lock: a
  // started Auto chat's next turn runs on the subscription with its pinned
  // harness (CAN-4200). A still-limited subscription is confirmed in the card
  // first, and the switch then restores the usage-limit warning (CAN-4759).
  const selectSubscriptionBilling = useCallback(
    (target: ChatBannerTarget): void => {
      selectBillingFramework('subscription', target);
    },
    [selectBillingFramework],
  );
  const focusComposerAfterSwitch = useCallback((): void => {
    if (!isComposerVisible()) return;
    if (
      composerRootRef.current?.querySelector(
        '[data-chat-textarea][contenteditable="true"]',
      )
    ) {
      focusEditor(editor);
    } else {
      composerRootRef.current
        ?.querySelector<HTMLElement>(
          '[data-testid="chat-input-usage-limit-banner"], [data-testid="chat-input-subscription-availability-notice"]',
        )
        ?.focus();
    }
  }, [editor, isComposerVisible]);
  const {
    switchToSubscription,
    availabilityNoticeProvider: subscriptionAvailabilityNoticeProvider,
    dismissAvailabilityNotice: dismissSubscriptionAvailabilityNotice,
  } = useSubscriptionSwitch({
    target: bannerTarget,
    provider:
      billingProvider === 'claude' || billingProvider === 'codex'
        ? billingProvider
        : undefined,
    framework: billingResolution.framework,
    turnActive: isStreaming,
    selectSubscription: selectSubscriptionBilling,
    focusComposer: focusComposerAfterSwitch,
  });
  // A locked toggle, including a confirmed sign-out's `no-native-login` lock,
  // leaves the card without a switch; the picker carries the sign-in remedy.
  const handleSwitchToSubscription =
    bannerTarget &&
    billingResolution.toggleVisible &&
    !billingResolution.toggleDisabled
      ? switchToSubscription
      : undefined;

  useEffect(() => {
    if (!bannerTarget) return;
    const persistedBanner = tab?.llmProviderUsageLimitBanner;
    if (!persistedBanner) return;
    if (
      tab?.dismissedLlmProviderUsageLimitBannerKey ===
      persistedBanner.dismissKey
    ) {
      return;
    }
    setUsageLimitBanner(bannerTarget, {
      provider: persistedBanner.provider,
      ...(typeof persistedBanner.resetsAt === 'number'
        ? { resetsAt: persistedBanner.resetsAt }
        : {}),
    });
  }, [
    bannerTarget,
    setUsageLimitBanner,
    tab?.llmProviderUsageLimitBanner,
    tab?.dismissedLlmProviderUsageLimitBannerKey,
  ]);

  // Reload durability for the runtime no-billing-source banner (CAN-2413). The
  // live chat event is the primary path; this replays the per-tab flag the
  // transcript parser set, so a restart (or a tab hydrated from disk, or an E2E
  // seed) still shows the recovery banner instead of leaving a chat that cannot
  // send with no explanation above the composer.
  useEffect(() => {
    if (!bannerTarget) return;
    const persisted = tab?.aiCreditsNoBillingSource;
    if (!persisted) return;
    setNoBillingSourceBanner(bannerTarget, {
      provider: persisted.provider,
      detectedAt: persisted.detectedAt,
    });
  }, [bannerTarget, setNoBillingSourceBanner, tab?.aiCreditsNoBillingSource]);

  // Scheduled send + resume run through the Canopy composer: available for
  // native chats and `auto` terminal chats (the scheduled prompt is routed
  // into the managed terminal once its turn is idle). Hidden only for the
  // always-on `claude-code` terminal surface, which has no Canopy composer.
  // Account harnesses follow the shared workflow decision for their target.
  const workflowGateProjectId = (
    sessionChatTarget ??
    targetOverride ??
    selectedWorktree
  )?.projectId;
  const workflowGates = useMemo(
    () =>
      resolveComposerWorkflowGates({
        providerType: effectiveProviderType,
        interfaceMode: tab?.interfaceMode ?? 'canopy',
        projectId: workflowGateProjectId,
        capabilities: scopeCapabilities,
      }),
    [
      effectiveProviderType,
      scopeCapabilities,
      tab?.interfaceMode,
      workflowGateProjectId,
    ],
  );
  const supportsScheduledSends = workflowGates.scheduledSends;

  const worktreeSessionNames = useMemo(() => {
    if (!sessionChatTarget) return null;
    const project = projects.find((p) => p.id === sessionChatTarget.projectId);
    const worktree =
      project && project.type !== 'cowork'
        ? project.worktrees.find((w) => w.id === sessionChatTarget.worktreeId)
        : undefined;
    return {
      workspaceName: project ? getWorkspaceDisplayName(project) : undefined,
      worktreeName: worktree?.branchName,
      chatTitle: tab?.title,
    };
  }, [projects, sessionChatTarget, tab?.title]);

  // The worktree chat tip (CAN-4904) names the project and the worktree as
  // the sidebar does: its label, else its branch (a new worktree's branch is
  // its own name).
  const worktreeTipContext = useMemo<OnboardingTipContext>(() => {
    if (!worktreeChatTarget) return {};
    const project = projects.find(
      (candidate) => candidate.id === worktreeChatTarget.projectId,
    );
    const worktree =
      project && project.type !== 'cowork'
        ? project.worktrees.find(
            (candidate) => candidate.id === worktreeChatTarget.worktreeId,
          )
        : undefined;
    const worktreeName = worktree?.label ?? worktree?.branchName;
    return {
      ...(project ? { projectName: getWorkspaceDisplayName(project) } : {}),
      ...(worktreeName ? { worktreeName } : {}),
    };
  }, [projects, worktreeChatTarget]);

  // The worktree tip shows only to a first-time worktree user (CAN-5005), so
  // it needs this chat's own history. A tab the store does not hold yet, or
  // one whose rows may be old, is still loading rather than empty.
  const worktreeTipTranscript = useChatStore(
    (state): 'loading' | 'empty' | 'used' | undefined => {
      if (!worktreeChatTarget) return undefined;
      const chat = state.worktreeChats[
        `${worktreeChatTarget.projectId}/${worktreeChatTarget.worktreeId}`
      ]?.tabs.find((candidate) => candidate.id === worktreeChatTarget.chatId);
      const pendingMessages = chat?.pendingUserMessages;
      const messages = pendingMessages?.length
        ? chat?.messages.filter(
            (message) =>
              !pendingMessages.some((pending) => pending.id === message.id),
          )
        : chat?.messages;
      return onboardingTipTranscript(
        messages,
        chat !== undefined &&
          !chat.transcriptStale &&
          chat.transcriptLoaded !== false,
      );
    },
  );
  const noteOnboardingTurnSent = useOnboardingTipsStore(
    (state) => state.noteTurnSent,
  );

  const buildWorktreeSessionDisplayFields = useCallback(
    (): {
      workspaceName?: string;
      worktreeName?: string;
      chatTitle?: string;
    } => ({
      ...(worktreeSessionNames?.workspaceName
        ? { workspaceName: worktreeSessionNames.workspaceName }
        : {}),
      ...(worktreeSessionNames?.worktreeName
        ? { worktreeName: worktreeSessionNames.worktreeName }
        : {}),
      ...(worktreeSessionNames?.chatTitle
        ? { chatTitle: worktreeSessionNames.chatTitle }
        : {}),
    }),
    [worktreeSessionNames],
  );

  // Usage-limit banner is served by the shared target-keyed store, fed
  // authoritatively by the main process for every chat surface (CAN-838).
  // Existing-session Schedule Resume is wired here; the rest of the banner
  // lives in the shared AiCreditsUsageLimitBanner component.
  const usageLimitBanner = useVisibleUsageLimitBanner(bannerTarget);
  // In-chat resume for a turn an app close interrupted (CAN-5177). The
  // banner above, when visible, already offers Resume and takes precedence.
  const interruptedTurnResumeUserMessageId =
    tab?.interruptedTurnResumeUserMessageId;
  const interruptedTurnResumeSessionKey =
    sessionChatTarget !== null &&
    interruptedTurnResumeUserMessageId !== undefined
      ? interruptedTurnResumeKey(
          sessionChatTarget,
          interruptedTurnResumeUserMessageId,
        )
      : null;
  const interruptedTurnResumeSession = useInterruptedTurnResumeStore((s) =>
    interruptedTurnResumeSessionKey === null
      ? undefined
      : s.sessions[interruptedTurnResumeSessionKey],
  );
  const showInterruptedTurnResume =
    !isEditingQueued &&
    shouldShowInterruptedTurnResume({
      capabilities: scopeCapabilities,
      target: sessionChatTarget,
      userMessageId: interruptedTurnResumeUserMessageId,
      session: interruptedTurnResumeSession,
      usageLimitBannerVisible: usageLimitBanner !== null,
    });
  const canScheduleUsageLimitResume =
    usageLimitBanner !== null &&
    sessionChatTarget !== null &&
    supportsScheduledSends;

  const findResumeAutomation = useCallback(
    (
      activities: readonly ScheduledActivity[],
    ): ScheduledActivity | undefined =>
      sessionChatTarget === null
        ? undefined
        : findPendingUsageLimitResume(
            activities,
            {
              workspaceId: sessionChatTarget.projectId,
              worktreeId: sessionChatTarget.worktreeId,
              chatId: sessionChatTarget.chatId,
            },
            Date.now(),
          ),
    [sessionChatTarget],
  );

  // Select the first pending automation, evaluating the whole list at one time.
  const existingResumeAutomation = useMemo(
    () => findResumeAutomation(automationsActivities),
    [automationsActivities, findResumeAutomation],
  );

  const [scheduleResumeInFlight, setScheduleResumeInFlight] = useState(false);
  const [scheduleResumeError, setScheduleResumeError] = useState<string | null>(
    null,
  );
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleSendError, setScheduleSendError] = useState<string | null>(
    null,
  );
  const [editingScheduledSendDraft, setEditingScheduledSendDraft] = useState<{
    runAt: string;
  } | null>(() => editingState?.scheduledSendDraft ?? null);

  // Worktree-only "just this time" routing: enable a per-session override so the
  // next turn on this worktree chat routes through AI Credits without changing
  // the persistent mode. Other surfaces route a chat through the picker's
  // per-chat billing choice once credits bought from its banner arrive, and
  // otherwise rely on the banner's "Always use credits". Global on/on-quota
  // auto-routing now lives in the main process, so the old renderer
  // auto-enable effects were removed as redundant (CAN-838).
  const enableSessionCreditsRouting = useCallback(
    (target: CreditsModelSwitchTarget): boolean => {
      // The Codex transcript banner carries the app-server's epoch seconds.
      const resetsAt =
        typeof usageLimitBanner?.resetsAt === 'number'
          ? normalizeEpochMs(usageLimitBanner.resetsAt)
          : undefined;
      const activatedAt = enableAiCreditsRouting(
        {
          scope: 'session',
          ...(typeof resetsAt === 'number' ? { resetsAt } : {}),
        },
        target,
      );
      // Without a reset time the routing would only end on an account switch, so
      // look one up from the provider's usage snapshot. The click never waits on
      // it, and the store ignores the result if the routing has since changed
      // (CAN-4200).
      const provider = usageLimitBanner?.provider;
      if (
        typeof resetsAt === 'number' ||
        activatedAt === undefined ||
        !provider
      ) {
        return activatedAt !== undefined;
      }
      void refreshProviderUsageSnapshot(provider)
        .then((snapshot) => {
          const resumeAt = selectProviderUsageLimitResumeAt(snapshot, provider);
          const resumeAtMs = resumeAt ? Date.parse(resumeAt) : Number.NaN;
          if (!Number.isFinite(resumeAtMs) || resumeAtMs <= Date.now()) return;
          setAiCreditsRoutingResetsAt(
            { resetsAt: resumeAtMs, activatedAt },
            target,
          );
        })
        .catch(() => {});
      return true;
    },
    [
      enableAiCreditsRouting,
      refreshProviderUsageSnapshot,
      setAiCreditsRoutingResetsAt,
      usageLimitBanner?.provider,
      usageLimitBanner?.resetsAt,
    ],
  );
  const handleUseAiCreditsJustThisTime = useCallback((): void => {
    // Saved routing must match what the banner shows (CAN-4900).
    if (!worktreeChatTarget || creditsModelRoutability !== 'routable') return;
    enableSessionCreditsRouting(worktreeChatTarget);
  }, [
    creditsModelRoutability,
    enableSessionCreditsRouting,
    worktreeChatTarget,
  ]);

  // "Continue on <default credits model>" (CAN-4900): a chat on a model with no gateway
  // route moves onto the default credits model, then routes this session
  // through AI Credits until the limit resets. Once the "Using AI Credits"
  // card replaces the notice, focus follows it so it is not lost with the
  // notice. The flag is set before the switch because the card can render
  // before the switch's promise settles. The tab takes the new model before
  // the store's settings write settles, so for that one round trip the notice
  // can show the ordinary offer for the now-routable model; routing is written
  // as soon as the switch resolves and the card replaces it.
  const pendingCardFocusRef = useRef(false);
  const handleContinueOnCreditsModel =
    useCallback(async (): Promise<CreditsModelSwitchResult> => {
      // The catalog can change between render and click (CAN-4900).
      if (!worktreeChatTarget || !creditsTargetRoutable) return 'switch-failed';
      pendingCardFocusRef.current = true;
      const result = await continueOnCreditsModel({
        target: worktreeChatTarget,
        creditsModel: DEFAULT_CREDITS_CODEX_MODEL,
        setModelAndWait: (nextModel, target) =>
          setModelAndWait(nextModel, target),
        enableSessionCreditsRouting,
      });
      if (result !== 'switched') pendingCardFocusRef.current = false;
      return result;
    }, [
      creditsTargetRoutable,
      enableSessionCreditsRouting,
      setModelAndWait,
      worktreeChatTarget,
    ]);
  const aiCreditsCardVisible = billingResolution.aiCreditsBannerVisible;
  useEffect(() => {
    if (!aiCreditsCardVisible || !pendingCardFocusRef.current) return;
    pendingCardFocusRef.current = false;
    composerRootRef.current
      ?.querySelector<HTMLElement>(
        '[data-testid="chat-input-ai-credits-active"]',
      )
      ?.focus();
  }, [aiCreditsCardVisible]);
  // A later card for another chat, or after the limit is dismissed, must not
  // take focus.
  const worktreeChatTargetKey = worktreeChatTarget
    ? `${worktreeChatTarget.projectId}/${worktreeChatTarget.worktreeId}/${worktreeChatTarget.chatId}`
    : null;
  const usageLimitShown = usageLimitBanner !== null;
  useEffect(() => {
    if (!usageLimitShown) pendingCardFocusRef.current = false;
  }, [usageLimitShown]);
  useEffect(() => {
    pendingCardFocusRef.current = false;
  }, [worktreeChatTargetKey]);

  // Empty-completion recovery (CAN-2307). Main flags a turn the provider
  // reported as complete while producing no visible output, and clears the
  // flag itself once late output reconciles the same turn or a new turn
  // starts — so neither action below has to retire the notice, and nothing
  // here ever fires without a click.
  // Reassembled from the composer view's three flat fields — see the note on
  // `ActiveComposerView.emptyCompletionTurnUserMessageId` for why they travel
  // flat and are only made into an object here.
  const emptyCompletionTurnId = tab?.emptyCompletionTurnUserMessageId;
  const stoppedTurnResumeUserMessageId = tab?.stoppedTurnResumeUserMessageId;
  const [turnLimitResumeBusy, setTurnLimitResumeBusy] = useState(false);
  const turnLimitResumeInFlight = useRef(false);
  const [turnLimitResumeError, setTurnLimitResumeError] = useState<
    string | null
  >(null);
  useEffect((): void => {
    setTurnLimitResumeError(null);
  }, [tab?.id, tab?.error]);
  const resumeTurnLimit = useCallback(async (): Promise<void> => {
    if (!sessionChatTarget || turnLimitResumeInFlight.current) return;
    turnLimitResumeInFlight.current = true;
    setTurnLimitResumeBusy(true);
    setTurnLimitResumeError(null);
    try {
      const rejected = (): void => {
        setTurnLimitResumeError('Could not resume this chat. Try again.');
      };
      await sendMessage('Continue', undefined, sessionChatTarget, 'typed', {
        composerAttachmentsReserved: true,
        onDispatchRejected: rejected,
        onPreDispatchRejected: rejected,
      });
    } catch {
      setTurnLimitResumeError('Could not resume this chat. Try again.');
    } finally {
      turnLimitResumeInFlight.current = false;
      setTurnLimitResumeBusy(false);
    }
  }, [sendMessage, sessionChatTarget]);

  // Choosing AI Credits from the usage-limit banner continues the interrupted
  // turn (CAN-4756). The "Using AI Credits" card offers the same send as
  // Continue while the interruption is unanswered: after credits arrive from
  // Buy AI Credits (routing only) or after a failed send.
  const {
    resume: resumeInterruptedTurnOnAiCredits,
    busy: continueOnAiCreditsBusy,
    error: continueOnAiCreditsError,
    pending: interruptedTurnPending,
  } = useResumeInterruptedTurnOnAiCredits(sessionChatTarget);
  const handleContinueOnAiCredits = useCallback((): void => {
    void resumeInterruptedTurnOnAiCredits();
  }, [resumeInterruptedTurnOnAiCredits]);

  const emptyCompletionRepeatsToolActivity =
    tab?.emptyCompletionRepeatsToolActivity === true;
  const emptyCompletionCanRetryPrompt =
    tab?.emptyCompletionCanRetryPrompt === true;
  const emptyCompletionRecovery = useMemo<
    EmptyCompletionRecoveryView | undefined
  >(
    () =>
      emptyCompletionTurnId
        ? {
            turnUserMessageId: emptyCompletionTurnId,
            repeatsToolActivity: emptyCompletionRepeatsToolActivity,
            canRetryPrompt: emptyCompletionCanRetryPrompt,
          }
        : undefined,
    [
      emptyCompletionCanRetryPrompt,
      emptyCompletionRepeatsToolActivity,
      emptyCompletionTurnId,
    ],
  );
  const [emptyCompletionBusy, setEmptyCompletionBusy] = useState(false);
  const [emptyCompletionError, setEmptyCompletionError] = useState<
    string | null
  >(null);

  // A new empty turn is a new problem; carrying the previous attempt's failure
  // line onto it would describe something that did not happen.
  useEffect(() => {
    setEmptyCompletionError(null);
  }, [emptyCompletionTurnId]);

  const dispatchEmptyCompletionRecovery = useCallback(
    async (mode: 'resume' | 'retry'): Promise<void> => {
      if (!sessionChatTarget || !emptyCompletionTurnId) return;
      if (mode === 'retry' && emptyCompletionRepeatsToolActivity) {
        setEmptyCompletionError(
          'Trying again is unavailable because it may repeat work that already ran. Try Resume.',
        );
        return;
      }
      setEmptyCompletionBusy(true);
      setEmptyCompletionError(null);
      try {
        if (mode === 'resume') {
          // The same session, nudged. The agent reads its own history first,
          // so whatever already ran is not issued a second time.
          await sendMessage(
            EMPTY_COMPLETION_RESUME_PROMPT,
            undefined,
            sessionChatTarget,
            'typed',
          );
          return;
        }
        // Read the prompt off the live store rather than the composer view:
        // the transcript may have grown since this render, and the turn's own
        // user message is the only correct source for a re-send.
        const key = `${sessionChatTarget.projectId}/${sessionChatTarget.worktreeId}`;
        const recoveryTab = useChatStore
          .getState()
          .worktreeChats[
            key
          ]?.tabs.find((candidate) => candidate.id === sessionChatTarget.chatId);
        const prompt = buildEmptyCompletionRetryPrompt(
          recoveryTab?.messages ?? [],
          emptyCompletionTurnId,
        );
        if (!prompt) {
          setEmptyCompletionError(
            'That message is no longer available to send again. Try Resume.',
          );
          return;
        }
        await sendMessage(
          prompt.text,
          prompt.fileReferences,
          sessionChatTarget,
          prompt.inputMode ?? 'typed',
          {
            ...(prompt.attachmentPaths?.length
              ? { attachmentPaths: prompt.attachmentPaths }
              : {}),
            ...(prompt.attachmentPromptContexts?.length
              ? {
                  attachmentPromptContexts: prompt.attachmentPromptContexts,
                }
              : {}),
          },
        );
      } catch {
        setEmptyCompletionError(
          mode === 'resume'
            ? 'Could not resume this chat.'
            : 'Could not send that message again.',
        );
      } finally {
        setEmptyCompletionBusy(false);
      }
    },
    [
      emptyCompletionRepeatsToolActivity,
      emptyCompletionTurnId,
      sendMessage,
      sessionChatTarget,
    ],
  );

  const handleScheduleResume = useCallback(async (): Promise<void> => {
    if (!sessionChatTarget) return;
    if (!usageLimitBanner) return;
    setScheduleResumeInFlight(true);
    setScheduleResumeError(null);
    try {
      const providerName =
        usageLimitBanner.provider === 'codex' ? 'Codex' : 'Claude';
      // If the last turn was just the user's message hitting the usage limit
      // before the agent did anything, resume by re-sending that message;
      // otherwise fall back to the plain "Continue" nudge.
      const key = `${sessionChatTarget.projectId}/${sessionChatTarget.worktreeId}`;
      const resumeTab = useChatStore
        .getState()
        .worktreeChats[
          key
        ]?.tabs.find((candidate) => candidate.id === sessionChatTarget.chatId);
      const resumePrompt = computeUsageLimitResumePrompt(
        resumeTab?.messages ?? [],
      );
      const snapshot = await refreshProviderUsageSnapshot(
        usageLimitBanner.provider,
      );
      const resumeAtIso = selectProviderUsageLimitResumeAt(
        snapshot,
        usageLimitBanner.provider,
      );
      if (!resumeAtIso) {
        if (findResumeAutomation(useAutomationsStore.getState().activities)) {
          return;
        }
        // Resume now goes through the trusted resume entry, not the composer:
        // main derives the prompt and records it as sent automatically, with
        // the same readiness and duplicate-dispatch checks as Home.
        const target = {
          projectId: sessionChatTarget.projectId,
          worktreeId: sessionChatTarget.worktreeId,
          chatId: sessionChatTarget.chatId,
        };
        const response = await window.api.resumeUsageLimitedChats({
          targets: [target],
        });
        if (response.resumedCount !== 1) {
          setScheduleResumeError('Could not resume this chat.');
          return;
        }
        clearResumedChatUsageLimitBanner(target);
        return;
      }
      // Re-check idempotency against the freshest store snapshot before create.
      if (findResumeAutomation(useAutomationsStore.getState().activities)) {
        return;
      }
      const response = await createAutomationActivity({
        name: `Resume chat after ${providerName} usage reset`,
        schedule: { kind: 'one_time', runAt: resumeAtIso, timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: sessionChatTarget.projectId,
          worktreeId: sessionChatTarget.worktreeId,
          chatId: sessionChatTarget.chatId,
          prompt: resumePrompt.text,
          ...(resumePrompt.fileReferences?.length
            ? { fileReferences: resumePrompt.fileReferences }
            : {}),
          ...(resumePrompt.attachmentPaths?.length
            ? { attachmentPaths: resumePrompt.attachmentPaths }
            : {}),
          ...(resumePrompt.attachmentPromptContexts?.length
            ? {
                attachmentPromptContexts: resumePrompt.attachmentPromptContexts,
              }
            : {}),
          inputMode: resumePrompt.inputMode ?? 'typed',
          purpose: 'usage_limit_resume',
          ...buildWorktreeSessionDisplayFields(),
        },
      });
      if (!response.ok) {
        setScheduleResumeError(response.error ?? 'Could not schedule resume.');
      }
    } catch {
      setScheduleResumeError('Could not schedule resume.');
    } finally {
      setScheduleResumeInFlight(false);
    }
  }, [
    buildWorktreeSessionDisplayFields,
    createAutomationActivity,
    findResumeAutomation,
    refreshProviderUsageSnapshot,
    usageLimitBanner,
    sessionChatTarget,
    useChatStore,
  ]);

  // Schedule button + pill are offered on live persisted-session composers and
  // on queued-message inline editors when the parent chat surface enables it.
  const showScheduleControls =
    supportsScheduledSends &&
    !isTerminalMode &&
    (isEditingQueued
      ? editingState.scheduleEnabled === true
      : sessionChatTarget !== null);
  // Unsupported account-harness drafts remain clearable without exposing
  // schedule editing.
  const showScheduledSendDraft =
    showScheduleControls || (nativeSessionComposer && isAccountHarness);
  const scheduledSendDraft = isEditingQueued
    ? editingScheduledSendDraft
    : (tab?.scheduledSendDraft ?? null);

  const handleClearScheduledSend = useCallback((): void => {
    setScheduleSendError(null);
    if (isEditingQueued) {
      setEditingScheduledSendDraft(null);
      return;
    }
    void setScheduledSendDraft(null, sessionChatTarget ?? undefined);
  }, [isEditingQueued, sessionChatTarget, setScheduledSendDraft]);

  const handleSaveSchedule = useCallback(
    (runAtIso: string): void => {
      setScheduleSendError(null);
      if (isEditingQueued) {
        setEditingScheduledSendDraft({ runAt: runAtIso });
        setScheduleModalOpen(false);
        return;
      }
      void setScheduledSendDraft(
        { runAt: runAtIso },
        sessionChatTarget ?? undefined,
      );
      setScheduleModalOpen(false);
    },
    [isEditingQueued, sessionChatTarget, setScheduledSendDraft],
  );

  const handleScheduledSend = useCallback(
    async (
      trimmedText: string,
      outboundReferences: SerializedFileReference[],
      runAtIso: string,
      stagedSelectionIds: readonly string[],
    ): Promise<void> => {
      if (!sessionChatTarget) return;
      if (!supportsScheduledSends) {
        setScheduleSendError(
          'This harness does not support scheduled messages. Choose another model or clear the schedule.',
        );
        return;
      }
      const inputMode = dictationInputModeRef.current;
      const cwd = getCwdFromFileIndex(
        await resolveSubmissionFileRepos(outboundReferences.length > 0),
        selectedRepoId,
      );
      const rewritten = rewriteFileReferencesForCwd(
        trimmedText,
        outboundReferences,
        cwd,
      );
      const userAttachmentPaths = pendingAttachments.map(
        (attachment) => attachment.absolutePath,
      );
      const revertAttachmentPath = tab?.pendingRevertAttachmentPath;
      const combinedAttachmentPaths = revertAttachmentPath
        ? [revertAttachmentPath, ...userAttachmentPaths]
        : userAttachmentPaths;
      const attachmentPromptContexts =
        attachmentPromptContextsFromMeta(pendingAttachments);
      setScheduleSendError(null);
      const response = await createAutomationActivity({
        name: 'Scheduled message',
        schedule: { kind: 'one_time', runAt: runAtIso, timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: sessionChatTarget.projectId,
          worktreeId: sessionChatTarget.worktreeId,
          chatId: sessionChatTarget.chatId,
          prompt: rewritten.text,
          ...(rewritten.fileReferences.length > 0
            ? { fileReferences: rewritten.fileReferences }
            : {}),
          ...(combinedAttachmentPaths.length > 0
            ? { attachmentPaths: combinedAttachmentPaths }
            : {}),
          ...(attachmentPromptContexts ? { attachmentPromptContexts } : {}),
          inputMode,
          purpose: 'scheduled_send',
          ...buildWorktreeSessionDisplayFields(),
        },
      });
      if (!response.ok) {
        // Keep editor content, attachments, and schedule intact on failure.
        setScheduleSendError('Could not schedule message.');
        return;
      }
      // Success: clear editor draft, attachments, the synthetic revert
      // attachment, and the staged schedule — never sending immediately.
      dictationInputModeRef.current = 'typed';
      messageHistoryNavigationRef.current = null;
      resetEditor(editor);
      setValue(createEmptyValue());
      if (tabId) {
        useChatStore.getState().clearTabDraft(tabId);
      }
      useChatStore
        .getState()
        .clearScheduledSendComposerState(sessionChatTarget);
      const chatStore = useChatStore.getState();
      for (const selectionId of stagedSelectionIds) {
        chatStore.removePendingEditorSelection(
          sessionChatTarget.chatId,
          selectionId,
        );
      }
    },
    [
      buildWorktreeSessionDisplayFields,
      createAutomationActivity,
      editor,
      pendingAttachments,
      resolveSubmissionFileRepos,
      selectedRepoId,
      tab?.pendingRevertAttachmentPath,
      tabId,
      sessionChatTarget,
      supportsScheduledSends,
      useChatStore,
    ],
  );

  // Mirror the schedule-modal open state into the store so the App Advisor
  // current-UI snapshot can report it on the active chat. Cleared on unmount.
  useEffect(() => {
    useChatStore
      .getState()
      .setScheduledSendModalOpen(scheduleModalOpen && showScheduleControls);
    return (): void => {
      useChatStore.getState().setScheduledSendModalOpen(false);
    };
  }, [scheduleModalOpen, showScheduleControls, useChatStore]);

  const syncEditorValue = useCallback(() => {
    setValue(structuredClone(editor.children));
  }, [editor]);

  // Live composer-content signal (CAN-1809): report emptiness flips so
  // empty-state affordances (suggested prompts) hide while a draft is in
  // progress. Cleared on unmount / tab change so stale tabs never read as
  // "has text".
  const composerSignalTabId = tab?.id ?? null;
  const hadComposerTextRef = useRef(false);
  useEffect(() => {
    if (composerSignalTabId === null) return;
    // Serialized emptiness: a draft holding only file-reference pills has no
    // plain text but is still content the user typed into the composer.
    const serialized = serializeEditorValue(editor.children);
    const hasText =
      serialized.text.trim().length > 0 || serialized.fileReferences.length > 0;
    if (hasText !== hadComposerTextRef.current) {
      hadComposerTextRef.current = hasText;
      useChatStore
        .getState()
        .setComposerTextPresent(composerSignalTabId, hasText);
    }
  }, [value, composerSignalTabId, editor, useChatStore]);
  useEffect(() => {
    if (composerSignalTabId === null) return;
    return (): void => {
      hadComposerTextRef.current = false;
      useChatStore
        .getState()
        .setComposerTextPresent(composerSignalTabId, false);
    };
  }, [composerSignalTabId, useChatStore]);

  useEffect(() => {
    if (!staleSessionDetected) {
      setHandoffLoading(false);
      setHandoffError(null);
    }
  }, [staleSessionDetected]);

  const selectHistoryBoundary = useCallback(
    (boundary: HistoryBoundary): void => {
      const point =
        boundary === 'start'
          ? Editor.start(editor, [])
          : Editor.end(editor, []);
      Transforms.select(editor, point);
    },
    [editor],
  );

  const replaceEditorTextFromHistory = useCallback(
    (nextText: string, boundary: HistoryBoundary): void => {
      setHintDraftSession((current) => current + 1);
      markHistoryNavigationProgrammaticChange();
      resetEditor(editor);
      if (nextText) {
        Transforms.insertText(editor, nextText);
      }
      selectHistoryBoundary(boundary);
      syncEditorValue();
      focusEditor(editor);
    },
    [
      editor,
      markHistoryNavigationProgrammaticChange,
      selectHistoryBoundary,
      syncEditorValue,
    ],
  );

  const restoreHistoryDraft = useCallback(
    (draft: Descendant[]): void => {
      setHintDraftSession((current) => current + 1);
      markHistoryNavigationProgrammaticChange();
      restoreEditorContent(editor, draft);
      selectHistoryBoundary('end');
      syncEditorValue();
      focusEditor(editor);
    },
    [
      editor,
      markHistoryNavigationProgrammaticChange,
      selectHistoryBoundary,
      syncEditorValue,
    ],
  );

  const handleMessageHistoryKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): boolean => {
      if (
        !tabId ||
        userMessageHistory.length === 0 ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey
      ) {
        return false;
      }

      if (e.key === 'ArrowUp') {
        if (!isEditorSelectionAtBoundary(editor, 'start')) {
          return false;
        }

        const activeState =
          messageHistoryNavigationRef.current?.tabId === tabId
            ? messageHistoryNavigationRef.current
            : null;
        const currentIndex =
          activeState !== null
            ? Math.min(activeState.index, userMessageHistory.length)
            : userMessageHistory.length;
        const nextIndex = Math.max(0, currentIndex - 1);
        const nextMessage = userMessageHistory[nextIndex];
        if (nextMessage === undefined) {
          return false;
        }

        e.preventDefault();
        messageHistoryNavigationRef.current = {
          tabId,
          index: nextIndex,
          draft: activeState?.draft ?? structuredClone(editor.children),
          draftInputMode:
            activeState?.draftInputMode ?? dictationInputModeRef.current,
        };
        dictationInputModeRef.current = 'typed';
        replaceEditorTextFromHistory(nextMessage, 'start');
        return true;
      }

      if (e.key === 'ArrowDown') {
        const activeState =
          messageHistoryNavigationRef.current?.tabId === tabId
            ? messageHistoryNavigationRef.current
            : null;
        if (activeState === null) {
          return false;
        }

        const isSelectionAtHistoryBoundary =
          isEditorSelectionAtBoundary(editor, 'end') ||
          isEditorSelectionAtBoundary(editor, 'start');
        if (!isSelectionAtHistoryBoundary) {
          return false;
        }

        const nextIndex = activeState.index + 1;
        if (nextIndex >= userMessageHistory.length) {
          e.preventDefault();
          messageHistoryNavigationRef.current = null;
          dictationInputModeRef.current = activeState.draftInputMode;
          restoreHistoryDraft(activeState.draft);
          return true;
        }

        const nextMessage = userMessageHistory[nextIndex];
        if (nextMessage === undefined) {
          return false;
        }

        e.preventDefault();
        messageHistoryNavigationRef.current = {
          ...activeState,
          index: nextIndex,
        };
        dictationInputModeRef.current = 'typed';
        replaceEditorTextFromHistory(nextMessage, 'end');
        return true;
      }

      return false;
    },
    [
      editor,
      replaceEditorTextFromHistory,
      restoreHistoryDraft,
      tabId,
      userMessageHistory,
    ],
  );

  // Voice dictation. Feature-detect on mount; the mic button is hidden when
  // on-device recognition is not available (no Swift helper, older macOS,
  // Linux/Windows, etc.) so there's no UI affordance to confuse the user.
  // The user can also disable it explicitly from Settings → Dictation.
  //
  // On platforms that never expose voice dictation (Windows, Linux), we skip
  // the IPC probe entirely and never load the preference, so the microphone
  // button is unreachable from this composer.
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceEnabledPref, setVoiceEnabledPref] = useState(
    DEFAULT_VOICE_DICTATION_ENABLED,
  );
  useEffect(() => {
    if (!shouldProbeVoiceSupport(localPlatform())) {
      setVoiceSupported(false);
      return;
    }
    let cancelled = false;
    const voiceApi = window.api.voice;
    if (!voiceApi) return;
    void voiceApi
      .isSupported()
      .then((result) => {
        if (!cancelled) setVoiceSupported(result.supported);
      })
      .catch(() => {
        if (!cancelled) setVoiceSupported(false);
      });
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (!cancelled) setVoiceEnabledPref(prefs.voiceDictationEnabled);
      })
      .catch(() => {
        // Leave default `true` in place so the mic stays visible if the
        // preference file is unreadable.
      });
    const unsubscribe = onVoiceDictationEnabledChanged((enabled) => {
      if (!cancelled) setVoiceEnabledPref(enabled);
    });
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // `dictationInputMode` tracks whether the next send was authored by the mic —
  // flips to 'voice' when the provider commits a final transcript, and back to
  // 'typed' on any keyboard input or after a send.
  const dictationInputModeRef = useRef<'typed' | 'voice'>('typed');
  const voiceTarget = useMemo(() => createSlateVoiceTarget(editor), [editor]);
  const voice = useVoiceTranscription({
    target: voiceTarget,
    destinationKey: cancelShortcutChatKey,
    onFinalCommitted: (transcribed): void => {
      if (shouldMarkFinalTranscriptAsVoiceInput(transcribed)) {
        dictationInputModeRef.current = 'voice';
      }
      // Final transcript changes the editor content — sync our local value.
      setValue(structuredClone(editor.children));
      focusEditor(editor);
    },
  });

  const terminalModeError = terminalMode.error;

  const estimateTerminalSpawnSize = useCallback((): {
    cols: number;
    rows: number;
  } => {
    const composerRect = dropContainerRef.current?.getBoundingClientRect();
    const computed =
      composerRect !== undefined
        ? computeColsRowsForPixels(
            Math.max(0, composerRect.width),
            DEFAULT_TERMINAL_DRAWER_HEIGHT,
          )
        : null;
    return (
      computed ?? {
        cols: DEFAULT_TERMINAL_SPAWN_COLS,
        rows: DEFAULT_TERMINAL_SPAWN_ROWS,
      }
    );
  }, []);

  // Terminal mode bypasses the chat queue: it spawns a fresh PTY and writes
  // the command directly, regardless of whether the agent is currently
  // streaming. After the editor resets, `isTerminalMode` flips back to false,
  // so the composer naturally returns to the streaming-aware UI (queue button
  // / queue placeholder if still streaming, normal send otherwise). A script
  // picked from the `!` typeahead runs its full body in its own repository and
  // package directory; a raw command runs its first line where the composer
  // points. Composer sends always start a new terminal.
  const canopyClient = useCanopyClient();
  runTerminalCommandRef.current = async (command: string): Promise<void> => {
    if (!slashCommandTarget) {
      throw new Error('Terminal mode needs a worktree');
    }
    const { projectId, worktreeId } = slashCommandTarget;
    const submission = await scriptTypeahead.resolveSubmission();
    const repoId =
      submission.kind === 'script' ? submission.selectedRepoId : selectedRepoId;
    const { cols, rows } = estimateTerminalSpawnSize();
    // Surface the terminal in the panel grid: expand it if collapsed, or
    // create a terminal panel (lower drawer) when none is open, so the
    // spawned command is actually visible.
    const host = desktopTerminalRunHost({
      projectId,
      worktreeId,
      panelPlacement,
      ownerDocument: dropContainerRef.current?.ownerDocument ?? document,
    });
    await runCommandInTerminal({
      client: canopyClient,
      spawn: {
        projectId,
        worktreeId,
        ...(repoId ? { selectedRepoId: repoId } : {}),
        ...(submission.kind === 'script' && submission.relativeCwd
          ? { relativeCwd: submission.relativeCwd }
          : {}),
        cols,
        rows,
      },
      command: submission.kind === 'script' ? submission.command : command,
      hydrate: host.hydrate,
      reveal: host.reveal,
    });
  };
  terminalCommandSentRef.current = (): void => {
    messageHistoryNavigationRef.current = null;
    resetEditor(editor);
    setValue(createEmptyValue());
    if (tabId) {
      useChatStore.getState().clearTabDraft(tabId);
    }
    dictationInputModeRef.current = 'typed';
    scriptTypeahead.reset();
    focusEditor(editor);
  };
  const sendTerminalCommand = terminalMode.send;
  const handleSendTerminalCommand = useCallback(async (): Promise<void> => {
    // A failure keeps the command in the box with the error in the mode
    // label's place; nothing is retried.
    await sendTerminalCommand();
  }, [sendTerminalCommand]);

  // Distinct drafts may be submitted while the previous send is awaiting
  // main-process admission. Keep their order without letting a repeated Enter
  // submit the same draft twice.
  const submittingDraftRevisionsRef = useRef(new Set<number>());
  const pendingSendRef = useRef<Promise<void>>(Promise.resolve());
  const draftRevisionRef = useRef(0);
  const recoveryOperationsRef = useRef(
    new WeakSet<(typeof editor.operations)[number]>(),
  );

  /**
   * Enable plugins for this chat the way the Plugins picker does: persist the
   * merged selections through `chat:update-plugins` (materializing a Codex
   * thread when needed) and mirror the response into the store. Shared by the
   * composer menu's plugin rows and by send, which re-enables any mentioned
   * plugin the user removed after dropping its pill. Resolves `false` on
   * failure after surfacing a toast; callers decide whether to continue.
   */
  const enablePluginsForChat = useCallback(
    async (refs: ChatTabPluginSelections['pluginRefs']): Promise<boolean> => {
      if (refs.length === 0) return true;
      // Not `watcherDestination`: that one is null for cowork chats by
      // design (they receive no watchers), but they do carry plugin
      // selections and must enable mentions like any other chat.
      const destination =
        targetOverride ??
        (selectedWorktree && tabId
          ? {
              projectId: selectedWorktree.projectId,
              worktreeId: selectedWorktree.worktreeId,
              chatId: tabId,
            }
          : null);
      if (!destination) return false;
      // The local core holds no cloud chat's selection; its catalog does.
      if (isWebCoreScope(destination.projectId)) return true;
      return queueDesktopTryItSelectionUpdate(
        destination,
        async (): Promise<boolean> => {
          const currentTab = useChatStore
            .getState()
            .worktreeChats[
              `${destination.projectId}/${destination.worktreeId}`
            ]?.tabs.find((candidate) => candidate.id === destination.chatId);
          if (
            !currentTab ||
            currentTab.readOnly ||
            currentTab.pendingInitialCreation
          )
            return false;
          // Merge into the tab's LIVE selections, not a render-time snapshot: a
          // second pick while the first round-trip is in flight must not drop
          // the first plugin.
          const next = unionPluginSelections(
            currentTab.pluginSelections ?? createEmptySelections(),
            {
              ...createEmptySelections(),
              pluginRefs: refs,
            },
          );
          try {
            const save = (
              pluginSelections: ChatTabPluginSelections,
            ): ReturnType<typeof window.api.chat.updatePlugins> => {
              const liveTab = useChatStore
                .getState()
                .worktreeChats[
                  `${destination.projectId}/${destination.worktreeId}`
                ]?.tabs.find((candidate) => candidate.id === destination.chatId);
              return window.api.chat.updatePlugins({
                ...destination,
                pluginSelections,
                materializeCodexThread: shouldMaterializeCodexThread({
                  providerType: effectiveProviderType,
                  executionHarness:
                    liveTab?.executionHarness ?? thinkingHarness,
                  sdkSessionId: liveTab?.sdkSessionId,
                }),
                expectedCurrentThreadId: liveTab?.sdkSessionId,
                ...(selectedRepoId ? { selectedRepoId } : {}),
              });
            };
            const response = await save(next);
            setPluginSelections(
              response.pluginSelections,
              destination,
              response.deferredToolsAllowed,
              {
                runtimeAlreadyUpdated: true,
                ...(response.sdkSessionId
                  ? { sdkSessionId: response.sdkSessionId }
                  : {}),
              },
            );
            return true;
          } catch {
            addToast(
              'Could not enable this plugin. Please try again.',
              'error',
            );
            return false;
          }
        },
      );
    },
    [
      targetOverride,
      selectedWorktree,
      tabId,
      effectiveProviderType,
      thinkingHarness,
      selectedRepoId,
      setPluginSelections,
      addToast,
    ],
  );

  // A cloud chat's attachments upload before they join the message, so it
  // waits for them, as the web composer does (CAN-6175 R6).
  const [cloudUploadsByTab, setCloudUploadsByTab] = useState<
    Readonly<Record<string, number>>
  >({});
  const cloudUploading =
    tabId !== undefined && (cloudUploadsByTab[tabId] ?? 0) > 0;

  const handleSend = useCallback(() => {
    if (!editingState && tab?.firstSendPreparing) return;
    if (cloudUploading) return;
    // Slate mutates the editor tree before React commits the corresponding
    // `value` update. A queued-message Save can therefore run in the same
    // interaction window as the final edit and must read the live tree rather
    // than the previous render's memoized serialization.
    const currentDraft = editingState
      ? serializeEditorValue(editor.children)
      : serializedDraft;
    const { text } = currentDraft;
    const currentFileReferences = editingState
      ? mergePromptAwareFileReferences(
          currentDraft.fileReferences,
          extraFileReferences,
        )
      : mergedFileReferences;
    const trimmed = text.trim();
    if (
      questionPromptOpen &&
      !editingState &&
      questionPrompt.prompt.sendAnswers(text)
    ) {
      if (
        !questionPrompt.prompt.canSend(text) ||
        questionPrompt.busy !== null ||
        questionPrompt.disconnected
      )
        return;
      questionPrompt.prompt.send(text);
      resetEditor(editor);
      setValue(createEmptyValue());
      if (tabId) {
        useChatStore.getState().clearTabDraft(tabId);
      }
      return;
    }
    if (!trimmed) return;
    // Read the live intent as well as disabling the button: a keyboard send
    // can arrive in the same task as a model click, before React repaints.
    if (
      modelChangeKey &&
      useChatStore.getState().pendingModelChanges[modelChangeKey] &&
      !editingState &&
      !isTerminalMode
    )
      return;

    if (isResourceGuardBlocked && !editingState && !isTerminalMode) {
      // Banner above the composer explains why; bail silently so we never
      // surface the raw ResourceGuardError IPC text in the transcript.
      return;
    }
    const submittedPlanMode = isGenuinePlanModeUse({
      planMode,
      planAvailable: canUsePlanMode,
      planReadOnly: isAccountHarness,
      pipelineMode: isTerminalMode,
    });
    const submittedDraftRevision = draftRevisionRef.current;
    if (submittingDraftRevisionsRef.current.has(submittedDraftRevision)) return;
    submittingDraftRevisionsRef.current.add(submittedDraftRevision);
    const submittedEditorValue = structuredClone(editor.children);
    // Snapshot selections before prompt expansion or scheduled-send creation
    // yields. Anything staged afterward belongs to the next message.
    const stagedSelections =
      !editingState && !isTerminalMode && tabId !== undefined
        ? (useChatStore.getState().pendingEditorSelections[tabId] ??
          NO_PENDING_SELECTIONS)
        : NO_PENDING_SELECTIONS;
    const stagedSelectionIds = stagedSelections.map(
      (selection) => selection.id,
    );
    const attachmentTarget =
      targetOverride ??
      (selectedWorktree && tabId
        ? { ...selectedWorktree, chatId: tabId }
        : undefined);
    // The target worktree's active plan, read at submit before anything
    // yields: a plan focused while this send waits belongs to the next one.
    const activePlan = captureActivePlanContext(
      targetOverride ?? selectedWorktree,
    );
    const submittedAttachments =
      !editingState && !isTerminalMode && !tab?.scheduledSendDraft?.runAt
        ? attachmentTarget
          ? (useChatStore
              .getState()
              .worktreeChats[
                `${attachmentTarget.projectId}/${attachmentTarget.worktreeId}`
              ]?.tabs.find((candidate) => candidate.id === attachmentTarget.chatId)
              ?.pendingAttachments ?? [])
          : pendingAttachments
        : [];
    const reserveComposerInputs =
      !editingState && !isTerminalMode && !tab?.scheduledSendDraft?.runAt;
    let submittedRevertAttachmentPath: string | undefined;
    if (reserveComposerInputs) {
      const chatStore = useChatStore.getState();
      submittedRevertAttachmentPath =
        chatStore.reservePendingRevertAttachment(attachmentTarget);
      for (const selectionId of stagedSelectionIds) {
        if (tabId) chatStore.removePendingEditorSelection(tabId, selectionId);
      }
      for (const attachment of submittedAttachments) {
        chatStore.removePendingAttachment(
          attachment.absolutePath,
          attachmentTarget,
        );
      }
    }
    const recoveryKey =
      !editingState && !isTerminalMode && attachmentTarget
        ? composerRecoveryKey(attachmentTarget)
        : undefined;
    // A newer send supersedes a refused submission still waiting to return.
    const recoverySubmissionGeneration = recoveryKey
      ? composerRecoveryStore.beginSubmission(recoveryKey)
      : undefined;
    let reservedInputsSettled = false;
    const restoreReservedInputs = (): void => {
      if (!reserveComposerInputs || reservedInputsSettled) return;
      reservedInputsSettled = true;
      const chatStore = useChatStore.getState();
      if (tabId) {
        for (const selection of stagedSelections) {
          chatStore.addPendingEditorSelection(tabId, selection);
        }
      }
      if (submittedAttachments.length > 0) {
        chatStore.addPendingAttachments(submittedAttachments, attachmentTarget);
      }
      if (submittedRevertAttachmentPath) {
        chatStore.restorePendingRevertAttachment(
          submittedRevertAttachmentPath,
          attachmentTarget,
        );
      }
    };

    const submission = pendingSendRef.current.then(async (): Promise<void> => {
      // Prompt @-mentions expand into the outgoing text before anything else
      // (path rewriting, scheduling, send); note/attachment mentions pass
      // through as pills. Skipped when no workspace scope is known.
      const expandedResult = mentionProjectId
        ? await expandPromptMentions(
            mentionProjectId,
            text,
            currentFileReferences,
          )
        : { text, fileReferences: [...currentFileReferences] };
      const expanded = {
        ...expandedResult,
        text: expandedResult.text.trim(),
      };

      // The model picker remains interactive while prompt mentions expand.
      // Re-read the live intent after that await so an in-flight send cannot
      // overtake a newer model selection.
      if (
        modelChangeKey &&
        useChatStore.getState().pendingModelChanges[modelChangeKey] &&
        !editingState &&
        !isTerminalMode
      ) {
        restoreReservedInputs();
        return;
      }

      // Staged editor selections (CAN-1250) ride the outgoing text as
      // structured blocks, tagged with their freshness at the moment of send.
      // Queued-message edits and terminal commands never carry them.
      expanded.text = appendSelectionContextBlocks(
        expanded.text,
        stagedSelections.map((selection) => ({
          selection,
          freshness: selectionFreshnessRef.current[selection.id] ?? 'checking',
        })),
      );

      if (editingState) {
        const inputMode = dictationInputModeRef.current;
        dictationInputModeRef.current = 'typed';
        const cwd = getCwdFromFileIndex(
          await resolveSubmissionFileRepos(expanded.fileReferences.length > 0),
          selectedRepoId,
        );
        const rewritten = rewriteFileReferencesForCwd(
          expanded.text,
          expanded.fileReferences,
          cwd,
        );
        const attachmentPaths = editingState.attachments.map(
          (attachment) => attachment.absolutePath,
        );
        const attachmentPromptContexts = attachmentPromptContextsFromMeta(
          editingState.attachments,
        );
        editingState.onSave(
          rewritten.text,
          rewritten.fileReferences,
          attachmentPaths,
          attachmentPromptContexts,
          inputMode,
          editingScheduledSendDraft ?? undefined,
        );
        return;
      }

      if (isTerminalMode) {
        if (!terminalCommand) return;
        void handleSendTerminalCommand();
        return;
      }

      // Scheduled send: when a one-time schedule is staged on a supported live
      // chat, create a `worktree_session_prompt` automation instead of sending
      // now. The handler owns editor/attachment cleanup (only on success).
      const scheduledRunAt = tab?.scheduledSendDraft?.runAt;
      if (scheduledRunAt && sessionChatTarget) {
        await handleScheduledSend(
          expanded.text,
          expanded.fileReferences,
          scheduledRunAt,
          stagedSelectionIds,
        );
        return;
      }

      // Recorded at submit, before dispatch, so a send that fails before its
      // turn starts is still counted (CAN-4630).
      if (!onSendMessage) {
        trackChatComposerSend({
          target: attachmentTarget,
          provider: effectiveProviderType ?? billingProvider,
          model: modelForBilling,
          isAutoModel: autoSelected,
          isAiCreditsBilled: billingResolution.framework === 'ai-credits',
          // The availability-gated composer state (CAN-5382), not hint
          // retirement's `submittedPlanMode`, which drops read-only harnesses.
          isPlanMode: planMode,
        });
      }

      const inputMode = dictationInputModeRef.current;
      dictationInputModeRef.current = 'typed';
      messageHistoryNavigationRef.current = null;
      let clearedDraftRevision: number | undefined;
      // Prompt expansion is asynchronous while the composer remains editable.
      // Preserve any newer draft the user created while this send was waiting.
      if (draftRevisionRef.current === submittedDraftRevision) {
        resetEditor(editor);
        setValue(createEmptyValue());
        clearedDraftRevision = draftRevisionRef.current;
        if (tabId) {
          useChatStore.getState().clearTabDraft(tabId);
        }
      }

      const cwd = getCwdFromFileIndex(
        await resolveSubmissionFileRepos(expanded.fileReferences.length > 0),
        selectedRepoId,
      );
      const rewritten = rewriteFileReferencesForCwd(
        expanded.text,
        expanded.fileReferences,
        cwd,
      );

      const outboundFileReferences =
        rewritten.fileReferences.length > 0
          ? rewritten.fileReferences
          : undefined;
      const attachmentPaths =
        submittedAttachments.length > 0 || submittedRevertAttachmentPath
          ? [
              ...(submittedRevertAttachmentPath
                ? [submittedRevertAttachmentPath]
                : []),
              ...submittedAttachments.map(
                (attachment) => attachment.absolutePath,
              ),
            ]
          : undefined;
      const attachmentPromptContexts =
        attachmentPromptContextsFromMeta(submittedAttachments);
      const removeStagedSelections = (): void => {
        if (
          reserveComposerInputs ||
          stagedSelectionIds.length === 0 ||
          tabId === undefined
        )
          return;
        const chatStore = useChatStore.getState();
        for (const selectionId of stagedSelectionIds) {
          chatStore.removePendingEditorSelection(tabId, selectionId);
        }
      };
      /** Puts the submitted draft back; `false` when the composer moved on. */
      const restoreRejectedDraft = (): boolean => {
        restoreReservedInputs();
        if (
          !canRestoreComposerDraft({
            submittedTarget: recoveryKey,
            currentTarget: recoveryContextRef.current.key,
            submittedRevision: clearedDraftRevision,
            currentRevision: draftRevisionRef.current,
          })
        ) {
          return false;
        }
        restoreEditorContent(editor, submittedEditorValue);
        const restoredValue = structuredClone(editor.children);
        setValue(restoredValue);
        if (tabId) {
          useChatStore.getState().saveTabDraft(tabId, restoredValue);
        }
        focusEditor(editor);
        return true;
      };
      const clearAcceptedSavedDraft = (): void => {
        if (!tabId) return;
        const chatStore = useChatStore.getState();
        const savedDraft = chatStore.getTabDraft(tabId);
        // A tab switch can save this already-submitted editor value while the
        // send waits behind an earlier one. Clear only that exact snapshot;
        // any newer draft in the same tab belongs to the next message.
        if (
          savedDraft &&
          JSON.stringify(savedDraft) === JSON.stringify(submittedEditorValue)
        ) {
          chatStore.clearTabDraft(tabId);
        }
      };
      // Mentioning a plugin means "use it": re-enable any `@plugin` pill whose
      // plugin was removed after the pill was dropped, before the turn starts,
      // so the agent is never told about a plugin it cannot load. A failed
      // re-enable is surfaced by toast and does not block the send.
      await enablePluginsForChat(
        missingMentionedPluginRefs(
          rewritten.fileReferences,
          effectivePluginSelections?.pluginRefs ?? [],
        ),
      );
      const acceptSend = (): void => {
        setHintDraftSession((current) => current + 1);
        reservedInputsSettled = true;
        removeStagedSelections();
        clearAcceptedSavedDraft();
        // An accepted new turn lifts a What's new hold on tips, and in a
        // worktree chat retires the beginner worktree tip (CAN-5005).
        noteOnboardingTurnSent({ worktreeChat: worktreeChatTarget !== null });
        // App Advisor and terminal/pipeline sends do not count toward the
        // GitHub star prompt (CAN-5604); a brand without one has no store.
        if (!isAppAdvisorComposer && !isTerminalMode)
          void getGitHubStarPromptStore()?.getState().noteTurnSent();
      };
      if (onSendMessage) {
        await onSendMessage(
          rewritten.text,
          outboundFileReferences,
          inputMode,
          attachmentPaths,
          attachmentPromptContexts,
        );
        acceptSend();
      } else {
        // Recorded with the final outbound text, before dispatch can emit a
        // refusal, so a no-billing abort can hand this submission back
        // (CAN-5348). The newest user message now predates this turn.
        const recoveryUserMessageId = crypto.randomUUID();
        const recoveryGeneration =
          recoveryKey && attachmentTarget
            ? composerRecoveryStore.record(
                recoveryKey,
                {
                  editorValue: submittedEditorValue,
                  reservedInputs: {
                    attachments: submittedAttachments,
                    selections: stagedSelections,
                    revertAttachmentPath: submittedRevertAttachmentPath,
                  },
                  outboundText: rewritten.text,
                  userMessageId: recoveryUserMessageId,
                  priorLastUserMessageId: composerRecoveryHead(
                    useChatStore
                      .getState()
                      .worktreeChats[
                        `${attachmentTarget.projectId}/${attachmentTarget.worktreeId}`
                      ]?.tabs.find((candidate) => candidate.id === attachmentTarget.chatId)
                      ?.messages ?? [],
                  ).lastUserMessageId,
                  // Input typed while plugins were enabling is the user's own.
                  composerCleared:
                    clearedDraftRevision !== undefined &&
                    draftRevisionRef.current === clearedDraftRevision,
                },
                recoverySubmissionGeneration,
              )
            : undefined;
        const releaseRecovery = (): void => {
          if (recoveryKey && recoveryGeneration !== undefined) {
            composerRecoveryStore.release(recoveryKey, recoveryGeneration);
          }
        };
        const isCurrentRecovery = (): boolean =>
          !recoveryKey ||
          recoveryGeneration === undefined ||
          composerRecoveryStore.isCurrentSubmission(
            recoveryKey,
            recoveryGeneration,
          );
        const acceptNativeSend = (): void => {
          if (!isCurrentRecovery()) return;
          acceptSend();
          if (submittedPlanMode)
            void getPlanModeHintStore().getState().markTried();
          if (worktreeChatTarget !== null) {
            notifyAcceptedWorktreeTurn({
              retry: Boolean(tab?.failedFirstSend),
            });
          }
          // Host queue acceptance hands recovery to the queue in the same
          // tick. Settling first would let a refusal processed before this
          // acknowledgement restore the queued prompt (CAN-5618).
          settleAcceptedComposerRecovery(recoveryKey, recoveryGeneration);
        };
        const queueNativeSend = (
          location: QueuedWithoutDispatchLocation,
        ): void => {
          handOffComposerRecoveryToQueue(
            recoveryKey,
            recoveryGeneration,
            location,
          );
        };
        const rejectNativeDispatch = (): void => {
          // Returning the send's own reservations is not a new user edit.
          if (recoveryKey && recoveryGeneration !== undefined) {
            restoreRejectedComposerInputs(
              recoveryKey,
              recoveryGeneration,
              restoreReservedInputs,
            );
          } else {
            restoreReservedInputs();
          }
        };
        const rejectNativePreDispatch = (): boolean => {
          // A newer send only supersedes editor recovery, never ownership of
          // the rejected send's already-reserved attachments and selections.
          restoreReservedInputs();
          if (!isCurrentRecovery()) return false;
          // The existing rejection path restores the whole draft itself.
          releaseRecovery();
          return restoreRejectedDraft();
        };
        try {
          await sendMessage(
            rewritten.text,
            outboundFileReferences,
            targetOverride,
            inputMode,
            attachmentPaths || attachmentPromptContexts
              ? {
                  ...(attachmentPaths ? { attachmentPaths } : {}),
                  ...(attachmentPromptContexts
                    ? { attachmentPromptContexts }
                    : {}),
                  ...(activePlan ? { activePlan } : {}),
                  replaceFailedFirstSend: tab?.failedFirstSend,
                  composerAttachmentsReserved: reserveComposerInputs,
                  reservedRevertAttachmentPath: submittedRevertAttachmentPath,
                  userMessageId: recoveryUserMessageId,
                  onDispatchAccepted: acceptNativeSend,
                  onQueuedWithoutDispatch: queueNativeSend,
                  onDispatchRejected: rejectNativeDispatch,
                  onPreDispatchRejected: rejectNativePreDispatch,
                }
              : {
                  ...(activePlan ? { activePlan } : {}),
                  replaceFailedFirstSend: tab?.failedFirstSend,
                  composerAttachmentsReserved: reserveComposerInputs,
                  reservedRevertAttachmentPath: submittedRevertAttachmentPath,
                  userMessageId: recoveryUserMessageId,
                  onDispatchAccepted: acceptNativeSend,
                  onQueuedWithoutDispatch: queueNativeSend,
                  onDispatchRejected: rejectNativeDispatch,
                  onPreDispatchRejected: rejectNativePreDispatch,
                },
          );
        } catch (error) {
          releaseRecovery();
          throw error;
        }
      }
    });
    // A later draft must reach the host after this one, including when prompt
    // expansion or plugin activation took longer than the next key press.
    pendingSendRef.current = submission.catch(() => {
      restoreReservedInputs();
    });
    void submission.then(
      () => submittingDraftRevisionsRef.current.delete(submittedDraftRevision),
      () => submittingDraftRevisionsRef.current.delete(submittedDraftRevision),
    );
  }, [
    cloudUploading,
    questionPromptOpen,
    questionPrompt.busy,
    questionPrompt.disconnected,
    questionPrompt.prompt,
    autoSelected,
    billingProvider,
    billingResolution.framework,
    modelForBilling,
    effectiveProviderType,
    enablePluginsForChat,
    effectivePluginSelections,
    editingState,
    editingScheduledSendDraft,
    editor,
    extraFileReferences,
    handleScheduledSend,
    handleSendTerminalCommand,
    isResourceGuardBlocked,
    isTerminalMode,
    planMode,
    canUsePlanMode,
    isAccountHarness,
    mentionProjectId,
    mergedFileReferences,
    pendingAttachments,
    resolveSubmissionFileRepos,
    selectedWorktree,
    modelChangeKey,
    selectedRepoId,
    sendMessage,
    serializedDraft,
    tab?.scheduledSendDraft?.runAt,
    tab?.firstSendPreparing,
    tab?.failedFirstSend,
    tabId,
    targetOverride,
    terminalCommand,
    sessionChatTarget,
    noteOnboardingTurnSent,
    isAppAdvisorComposer,
    worktreeChatTarget,
    onSendMessage,
    useChatStore,
  ]);

  // CAN-5348: a no-billing refusal before any agent work hands the refused
  // submission back to this composer once send cleanup and the tab's draft
  // load are done, so the user can press Send again after recovering credits.
  // Runs imperatively from store notifications to keep streaming re-renders
  // out of the composer; most notifications return before any work.
  const recoveryContextRef = useRef({
    key: composerRecoveryTargetKey,
    target: approvalModeTarget,
    terminal: isTerminalMode,
  });
  recoveryContextRef.current = {
    key: composerRecoveryTargetKey,
    target: approvalModeTarget,
    terminal: isTerminalMode,
  };
  const runComposerRecovery = useCallback((): void => {
    const { key, target, terminal } = recoveryContextRef.current;
    if (!key || !target) return;
    const entry = composerRecoveryStore.get(key);
    if (!entry) return;
    const state = useChatStore.getState();
    const liveTab = state.worktreeChats[
      `${target.projectId}/${target.worktreeId}`
    ]?.tabs.find((candidate) => candidate.id === target.chatId);
    const decision = decideComposerRecovery(entry, {
      composerHydrated: prevTabIdRef.current === target.chatId,
      transcript: liveTab ? composerRecoveryTranscript(liveTab.messages) : null,
      occupancy: {
        editorContent: draftHasContent(editor.children),
        attachments: (liveTab?.pendingAttachments?.length ?? 0) > 0,
        selections:
          (state.pendingEditorSelections[target.chatId]?.length ?? 0) > 0,
        revertAttachment: Boolean(liveTab?.pendingRevertAttachmentPath),
        savedDraft: draftHasContent(state.getTabDraft(target.chatId) ?? []),
      },
      mode: terminal ? 'terminal' : 'compose',
    });
    if (decision.kind === 'wait') return;
    if (decision.kind === 'skip') {
      composerRecoveryStore.release(key, entry.generation);
      return;
    }
    const editorBefore = structuredClone(editor.children);
    const draftBefore = state.getTabDraft(target.chatId);
    const operationsBefore = new Set(editor.operations);
    const applied = applyComposerRecovery(
      composerRecoveryStore,
      key,
      decision.generation,
      () => {
        restoreEditorContent(
          editor,
          structuredClone(entry.submission.editorValue),
        );
        // Save the restored tree itself, not the stale pre-update React value.
        const restoredValue = structuredClone(editor.children);
        setValue(restoredValue);
        if (decision.restoreReservedInputs) {
          const { attachments, selections, revertAttachmentPath } =
            entry.submission.reservedInputs;
          for (const selection of selections) {
            state.addPendingEditorSelection(target.chatId, selection);
          }
          if (attachments.length > 0) {
            state.addPendingAttachments([...attachments], target);
          }
          if (revertAttachmentPath) {
            state.restorePendingRevertAttachment(revertAttachmentPath, target);
          }
        }
        state.saveTabDraft(target.chatId, restoredValue);
      },
      () => {
        // Restore only this composer's fields; preserve unrelated transcript/state.
        useChatStore.setState((current) => {
          const worktreeKey = `${target.projectId}/${target.worktreeId}`;
          const worktree = current.worktreeChats[worktreeKey];
          return {
            worktreeChats: worktree
              ? {
                  ...current.worktreeChats,
                  [worktreeKey]: {
                    ...worktree,
                    tabs: worktree.tabs.map((candidate) =>
                      candidate.id === target.chatId
                        ? {
                            ...candidate,
                            pendingAttachments: liveTab?.pendingAttachments,
                            pendingRevertAttachmentPath:
                              liveTab?.pendingRevertAttachmentPath,
                          }
                        : candidate,
                    ),
                  },
                }
              : current.worktreeChats,
            pendingEditorSelections: {
              ...current.pendingEditorSelections,
              [target.chatId]:
                state.pendingEditorSelections[target.chatId] ?? [],
            },
          };
        });
        restoreEditorContent(editor, editorBefore);
        setValue(editorBefore);
        if (draftBefore) state.saveTabDraft(target.chatId, draftBefore);
        else state.clearTabDraft(target.chatId);
      },
    );
    for (const operation of editor.operations) {
      if (!operationsBefore.has(operation))
        recoveryOperationsRef.current.add(operation);
    }
    if (!applied) return;
    setHintDraftSession((current) => current + 1);
    // Never pull focus from billing UI, another field, or another tab.
    const focused = document.activeElement;
    if (
      isComposerVisible() &&
      (focused === null ||
        focused === document.body ||
        composerRootRef.current?.contains(focused) === true)
    ) {
      focusEditor(editor);
    }
  }, [editor, isComposerVisible, useChatStore]);
  useEffect(() => {
    if (!composerRecoveryTargetKey) return undefined;
    if (isEditingQueued) {
      composerRecoveryStore.release(composerRecoveryTargetKey);
      return undefined;
    }
    composerRecoveryStore.retryApplication(composerRecoveryTargetKey);
    runComposerRecovery();
    const unsubscribeRecovery =
      composerRecoveryStore.subscribe(runComposerRecovery);
    const unsubscribeChat = useChatStore.subscribe(runComposerRecovery);
    return (): void => {
      unsubscribeRecovery();
      unsubscribeChat();
    };
    // `tabId` and terminal mode re-run the check after a tab's draft loads.
  }, [
    composerRecoveryTargetKey,
    isEditingQueued,
    isTerminalMode,
    runComposerRecovery,
    tabId,
    useChatStore,
  ]);

  // CAN-5618 backstop: a credit-held queue row is that prompt's only recovery
  // copy. When a known held row leaves the queue (retried, sent after funding,
  // or deleted), clear a composer draft that is exactly its text so a stale
  // restored copy cannot send it again. Text alone cannot tell a restored
  // draft from identical typed text; both are cleared. A skipped release is
  // still consumed, never applied later.
  const heldQueueEditingRef = useRef(isEditingQueued);
  heldQueueEditingRef.current = isEditingQueued;
  const heldQueueTab = (): ChatTab | undefined => {
    const target = recoveryContextRef.current.target;
    if (!target) return undefined;
    return useChatStore
      .getState()
      .worktreeChats[
        `${target.projectId}/${target.worktreeId}`
      ]?.tabs.find((candidate) => candidate.id === target.chatId);
  };
  useHeldQueueComposerRecovery(composerRecoveryTargetKey, {
    subscribe: useChatStore.subscribe,
    readQueue: () => {
      const { key, target } = recoveryContextRef.current;
      if (!key || !target) return undefined;
      const sync =
        useChatStore.getState().chatStateSync[
          `${target.projectId}/${target.worktreeId}`
        ];
      if (sync && sync.phase !== 'live') return undefined;
      const liveTab = heldQueueTab();
      return liveTab ? { key, rows: liveTab.queuedMessages } : undefined;
    },
    readDraft: () => {
      const { key, target, terminal } = recoveryContextRef.current;
      if (!target || prevTabIdRef.current !== target.chatId) return undefined;
      const liveTab = heldQueueTab();
      if (!liveTab) return undefined;
      const state = useChatStore.getState();
      const draft = serializeEditorValue(editor.children);
      return {
        key,
        text: draft.text,
        occupancy: {
          attachments: (liveTab.pendingAttachments?.length ?? 0) > 0,
          selections:
            (state.pendingEditorSelections[target.chatId]?.length ?? 0) > 0,
          revertAttachment: Boolean(liveTab.pendingRevertAttachmentPath),
          fileReferences: draft.fileReferences.length > 0,
          scheduledSend: Boolean(liveTab.scheduledSendDraft),
          queuedEdit: heldQueueEditingRef.current,
          terminal,
          // Message-history browsing can stash an independent draft that
          // unmount would otherwise save back after this editor was cleared.
          stashedDraft: draftHasContent(
            messageHistoryNavigationRef.current?.draft ?? [],
          ),
        },
      };
    },
    clearDraft: () => {
      const target = recoveryContextRef.current.target;
      if (!target) return;
      resetEditor(editor);
      setValue(createEmptyValue());
      useChatStore.getState().clearTabDraft(target.chatId);
    },
  });

  // Dictation owns the box's bottom row while it runs (see VoiceRecordingRow).
  const voiceRecording =
    voice.state === 'connecting' || voice.state === 'listening';
  // Send from the recording row: stop the take, and send once its final words
  // have landed in the draft (the session reports idle after committing them).
  const sendAfterVoiceRef = useRef(false);
  useEffect(() => {
    // A take discarded on a chat switch must not send the incoming draft.
    sendAfterVoiceRef.current = false;
  }, [cancelShortcutChatKey]);
  const handleVoiceSend = useCallback((): void => {
    sendAfterVoiceRef.current = true;
    void voice.stop();
  }, [voice]);
  useEffect(() => {
    if (!sendAfterVoiceRef.current) return;
    if (voice.state === 'error') {
      sendAfterVoiceRef.current = false;
      return;
    }
    if (voice.state !== 'idle') return;
    sendAfterVoiceRef.current = false;
    handleSend();
  }, [voice.state, handleSend]);
  // The recording row replaces the microphone that had focus, so Escape
  // discards the take from anywhere in the window, not only the editor.
  useEffect(() => {
    if (!voiceRecording) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      dictationInputModeRef.current = 'typed';
      void voice.cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [voiceRecording, voice]);

  const handleSelectionChange = useCallback((): void => {
    setSelectionRevision((current) => current + 1);
  }, []);

  const handleEditorChange = useCallback(
    (newValue: Descendant[]): void => {
      // Caret movement has only set_selection operations. Programmatic
      // restore/reset swaps children directly and calls onChange with none.
      if (
        editor.operations.length === 0 ||
        editor.operations.some(
          (operation) => operation.type !== 'set_selection',
        )
      ) {
        draftRevisionRef.current += 1;
      }
      // A user edit, even one deleted again, makes the cleared composer theirs:
      // a refused submission must not reappear over it (CAN-5348).
      if (
        !isEditingQueued &&
        composerRecoveryTargetKey &&
        editor.operations.some(
          (operation) =>
            operation.type !== 'set_selection' &&
            !recoveryOperationsRef.current.has(operation),
        )
      ) {
        composerRecoveryStore.noteUserInput(composerRecoveryTargetKey);
      }
      if (
        !historyNavigationProgrammaticChangeRef.current &&
        messageHistoryNavigationRef.current?.tabId === tabId
      ) {
        messageHistoryNavigationRef.current = null;
      }
      setValue([...newValue]);
      if (tabId && !isEditingQueued && readTryItDraft(tabId))
        useChatStore
          .getState()
          .saveTabDraft(tabId, getDraftForSave(tabId, newValue));
    },
    [
      editor,
      tabId,
      isEditingQueued,
      getDraftForSave,
      composerRecoveryTargetKey,
    ],
  );

  const editingAddAttachmentsRef = useRef(editingState?.onAddAttachments);
  editingAddAttachmentsRef.current = editingState?.onAddAttachments;

  // A cloud chat's files upload to this composer's chat as they are attached
  // (CAN-6175 R6); nothing reads them from a path. Files left out say why
  // beside the composer, as the web composer does.
  const [attachmentProblems, setAttachmentProblems] = useState<
    readonly string[]
  >([]);
  useEffect(() => {
    setAttachmentProblems([]);
  }, [tabId]);
  const attachWebCoreFiles = useCallback(
    (
      target: { projectId: string; worktreeId: string },
      files: readonly File[] | null,
      isCurrent: () => boolean,
    ): void => {
      if (!tabId) return;
      const chatTarget = { ...target, chatId: tabId };
      setAttachmentProblems([]);
      const countUpload = (by: number): void =>
        setCloudUploadsByTab((current) => ({
          ...current,
          [tabId]: (current[tabId] ?? 0) + by,
        }));
      countUpload(1);
      void importWebCoreChatFiles(chatTarget, files, isCurrent)
        .then(({ attachments, problems }) => {
          if (!isCurrent()) return;
          // A slower earlier batch adds to a later one's reasons.
          if (problems.length > 0)
            setAttachmentProblems((current) => [
              ...new Set([...current, ...problems]),
            ]);
          addPendingAttachmentsAndRefreshIndex(
            target,
            attachments,
            editingAddAttachmentsRef.current,
            chatTarget,
          );
        })
        .catch((error: unknown) => {
          reportClientAppError(error);
          if (isCurrent())
            setAttachmentProblems((current) => [
              ...new Set([...current, ATTACHMENT_IMPORT_ERROR_MESSAGE]),
            ]);
        })
        .finally(() => countUpload(-1));
    },
    [tabId],
  );

  const handleImportAttachments = useCallback(async () => {
    if (filesGuestGate.interceptAttachment() || readOnly) return;
    const isCurrent = filesGuestGate.captureAccess();
    const attachmentTarget = targetOverride ?? selectedWorktree;
    if (!attachmentTarget) return;
    if (isWebCoreScope(attachmentTarget.projectId)) {
      attachWebCoreFiles(attachmentTarget, null, isCurrent);
      return;
    }
    const attachments = await importChatAttachments(
      attachmentTarget,
      [],
      undefined,
      isCurrent,
    );
    if (!isCurrent()) return;
    addPendingAttachmentsAndRefreshIndex(
      attachmentTarget,
      attachments,
      editingAddAttachmentsRef.current,
      targetOverride,
    );
  }, [
    attachWebCoreFiles,
    filesGuestGate,
    readOnly,
    selectedWorktree,
    targetOverride,
  ]);

  // ⌘/Ctrl+U (ECW-7984): the global shortcut handler identifies the active
  // chat explicitly so a split layout with multiple visible composers opens
  // exactly one attachment picker.
  useEffect(() => {
    const attachmentTarget =
      targetOverride ??
      (selectedWorktree && tabId
        ? {
            projectId: selectedWorktree.projectId,
            worktreeId: selectedWorktree.worktreeId,
            chatId: tabId,
          }
        : null);
    if (attachmentTarget === null) return undefined;

    const handler = (event: Event): void => {
      const detail: unknown = 'detail' in event ? event.detail : null;
      if (
        !canAttachFiles ||
        !isComposerVisible() ||
        !isChatAttachmentShortcutTarget(detail, attachmentTarget)
      ) {
        return;
      }
      void handleImportAttachments();
    };
    document.addEventListener(OPEN_CHAT_ATTACHMENTS_EVENT, handler);
    return (): void => {
      document.removeEventListener(OPEN_CHAT_ATTACHMENTS_EVENT, handler);
    };
  }, [
    canAttachFiles,
    handleImportAttachments,
    isComposerVisible,
    selectedWorktree,
    tabId,
    targetOverride,
  ]);

  // ⌥M / ⌥T (ECW-7984 follow-up). Unlike the ⌘U path above, which gates on
  // layout visibility, these match on the full chat identity the global
  // handler resolved from the store's ACTIVE tab — so exactly one composer
  // reacts even when several split panels are visible at once.
  const composerShortcutTarget = useMemo((): ComposerShortcutScope | null => {
    const scopeTarget = targetOverride ?? selectedWorktree;
    if (!scopeTarget || !tabId) {
      return null;
    }
    return {
      scope: 'chat',
      projectId: scopeTarget.projectId,
      worktreeId: scopeTarget.worktreeId,
      chatId: tabId,
    };
  }, [selectedWorktree, tabId, targetOverride]);

  useComposerActions(
    composerShortcutTarget,
    canChangePluginSelections
      ? { plugins: (): void => void openPluginsModal() }
      : {},
    !readOnly && editingState === undefined,
  );

  // Hold ⌃M to dictate (a tap leaves the take running hands-free).
  const holdToDictate = useHoldToDictate(voice);

  const handleCycleThinkingLevel = useCallback((): void => {
    cycleThinkingLevel(targetOverride);
  }, [cycleThinkingLevel, targetOverride]);

  const modelPickerOpenSignal = useComposerShortcutRequests({
    target: composerShortcutTarget,
    onCycleEffort: handleCycleThinkingLevel,
    ...(voiceSupported && voiceEnabledPref ? holdToDictate : {}),
    enabled:
      composerShortcutsEnabled &&
      !isTerminalMode &&
      !readOnly &&
      editingState === undefined,
  });

  // Mirrors `handleImportAttachments`'s target resolution and pending-sink
  // wiring exactly (including the editing-state override) so a staged Linear
  // ticket lands in the same place a picked file attachment would.
  const handleSelectLinearTicket = useCallback(
    async (ticket: LinearTicketSearchResult) => {
      const attachmentTarget = targetOverride ?? selectedWorktree;
      if (!attachmentTarget) return;
      await stageLinearTicketAttachment(
        attachmentTarget,
        ticket,
        (attachments) =>
          addPendingAttachmentsAndRefreshIndex(
            attachmentTarget,
            attachments,
            editingAddAttachmentsRef.current,
            targetOverride,
          ),
      );
    },
    [selectedWorktree, targetOverride],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const items = event.clipboardData?.items;
      if (!items || !Array.from(items).some((item) => item.kind === 'file'))
        return;
      if (!canAttachFiles) {
        event.preventDefault();
        return;
      }
      if (filesGuestGate.interceptAttachment()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (readOnly) return;
      const isCurrent = filesGuestGate.captureAccess();
      const attachmentTarget = targetOverride ?? selectedWorktree;
      if (!attachmentTarget) return;
      if (isWebCoreScope(attachmentTarget.projectId)) {
        event.preventDefault();
        attachWebCoreFiles(
          attachmentTarget,
          Array.from(items).flatMap((item) => item.getAsFile() ?? []),
          isCurrent,
        );
        return;
      }

      const filePaths: string[] = [];
      const blobFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (!file) continue;
          if ('path' in file && typeof file.path === 'string' && file.path) {
            filePaths.push(file.path);
          } else {
            blobFiles.push(file);
          }
        }
      }
      if (filePaths.length === 0 && blobFiles.length === 0) return;

      event.preventDefault();

      void createClipboardAttachments(blobFiles, 'clipboard-image')
        .then((clipboardItems) =>
          isCurrent()
            ? importChatAttachments(
                attachmentTarget,
                filePaths,
                clipboardItems,
                isCurrent,
              )
            : [],
        )
        .then((attachments) => {
          if (!isCurrent()) return;
          addPendingAttachmentsAndRefreshIndex(
            attachmentTarget,
            attachments,
            editingAddAttachmentsRef.current,
            targetOverride,
          );
        })
        .catch(() => {
          if (!isCurrent()) return;
          addToast(ATTACHMENT_IMPORT_ERROR_MESSAGE, 'error', undefined, {
            category: 'Chat',
          });
        });
    },
    [
      attachWebCoreFiles,
      filesGuestGate,
      readOnly,
      addToast,
      selectedWorktree,
      targetOverride,
    ],
  );

  const dropContainerRef = useRef<HTMLDivElement>(null);
  const selectedWorktreeRef = useRef(selectedWorktree);
  selectedWorktreeRef.current = selectedWorktree;
  const targetOverrideRef = useRef(targetOverride);
  targetOverrideRef.current = targetOverride;

  // Files dropped anywhere on the chat attach to this composer; the chat
  // dims while they are dragged over it. The queued-message editor keeps
  // drops on its own box for the message it edits.
  const fileDrop = useChatFileDrop({
    boxRef: dropContainerRef,
    rootRef: composerRootRef,
    enabled:
      canAttachFiles && (filesGuestGate.status !== 'signed-in' || !readOnly),
    ownBoxOnly: isEditingQueued,
    onDropFiles: (files): void => {
      if (filesGuestGate.interceptAttachment() || readOnly) return;
      const isCurrent = filesGuestGate.captureAccess();
      const wt = targetOverrideRef.current ?? selectedWorktreeRef.current;
      if (!wt) return;
      if (isWebCoreScope(wt.projectId)) {
        attachWebCoreFiles(wt, files, isCurrent);
        return;
      }

      const filePaths: string[] = [];
      const blobFiles: File[] = [];
      for (const file of files) {
        if ('path' in file && typeof file.path === 'string' && file.path) {
          filePaths.push(file.path);
        } else {
          blobFiles.push(file);
        }
      }

      void createClipboardAttachments(blobFiles, 'dropped-file')
        .then((clipboardItems) =>
          isCurrent()
            ? importChatAttachments(wt, filePaths, clipboardItems, isCurrent)
            : [],
        )
        .then((attachments) => {
          if (!isCurrent()) return;
          addPendingAttachmentsAndRefreshIndex(
            wt,
            attachments,
            editingAddAttachmentsRef.current,
            targetOverrideRef.current,
          );
        })
        .catch(() => {
          if (!isCurrent()) return;
          addToast(ATTACHMENT_IMPORT_ERROR_MESSAGE, 'error', undefined, {
            category: 'Chat',
          });
        });
    },
  });

  const bottomRowRef = useRef<HTMLDivElement>(null);
  const [isCompact, setIsCompact] = useState(false);
  // A narrow box draws its chips small: Plan and watchers as icons, a
  // scheduled send as its time.
  const [chipsCompact, setChipsCompact] = useState(false);
  useLayoutEffect(() => {
    // Measure the composer box: on one line the toolbar row has no box of
    // its own (`display: contents`), so it cannot be observed.
    const el = dropContainerRef.current;
    if (!el) return;
    const updateCompactState = (width: number): void => {
      if (width <= 0) return;
      const rootFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const compactBreakpoint = COMPACT_TOOLBAR_BREAKPOINT_REM * rootFontSize;
      const compactHysteresis = COMPACT_TOOLBAR_HYSTERESIS_REM * rootFontSize;
      setIsCompact((prev) =>
        prev
          ? width < compactBreakpoint + compactHysteresis
          : width < compactBreakpoint,
      );
      const chipsBreakpoint = COMPACT_CHIPS_BREAKPOINT_REM * rootFontSize;
      setChipsCompact((prev) =>
        prev
          ? width < chipsBreakpoint + compactHysteresis
          : width < chipsBreakpoint,
      );
    };
    updateCompactState(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateCompactState(entry.contentRect.width);
    });
    observer.observe(el);
    const scaleObserver = new MutationObserver(() => {
      updateCompactState(el.getBoundingClientRect().width);
    });
    scaleObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ui-scale'],
    });
    return (): void => {
      observer.disconnect();
      scaleObserver.disconnect();
    };
  }, [readOnly, tab?.id]);

  // One line by default; anything else that lives in the box (attachments,
  // selections) needs the full layout. Chips beside + (Plan, a scheduled
  // send) and the terminal mode label share the one line until
  // they leave the text too little room; then they take the row under it.
  const composerSideContentKey = [
    planReady ? 'plan-ready' : planMode ? 'plan' : '',
    showScheduledSendDraft && scheduledSendDraft
      ? `scheduled:${scheduledSendDraft.runAt}:${scheduleSendError ?? ''}`
      : '',
    isTerminalMode
      ? `terminal:${terminalModeError ?? ''}:${scriptTypeahead.hint ?? ''}`
      : '',
    chipsCompact ? 'compact' : '',
  ].join('|');
  // Only chips can crowd the text. With none beside it, the one line keeps
  // its text slot however narrow it gets (the placeholder truncates), so a
  // panel still widening as it opens never flips the layout under typing.
  const composerHasSideChips =
    planMode ||
    planReady ||
    (showScheduledSendDraft && scheduledSendDraft !== null) ||
    isTerminalMode;
  const composerInline = useOneLineComposer({
    boxRef: dropContainerRef,
    hasDraftText: serializedDraft.text.length > 0,
    allowed:
      !isEditingQueued &&
      // A prompt lays out its own rows.
      !promptOpen &&
      // A take shows its words above the recording row.
      !voiceRecording &&
      pendingSelections.length === 0 &&
      pendingAttachments.length === 0 &&
      // Catalog selections awaiting setup get their own row above the text.
      !effectivePluginSelections?.unresolvedCapabilities?.length,
    draftRevision: value,
    minTextWidth: composerHasSideChips
      ? CHAT_COMPOSER_MIN_TEXT_WIDTH_PX
      : undefined,
    sideContentKey: composerSideContentKey,
  });
  // The selectors under the box keep their labels until that row runs out
  // of room, independently of the box's own narrow layout.
  const statusRowRef = useRef<HTMLDivElement>(null);
  // A Claude chat's interface modes, offered in the + menu under View.
  const claudeTuiChatsEnabled = useClaudeTuiChatsEnabled();
  const interfaceModeOptions =
    interfaceModeControl?.providerIsClaude && claudeTuiChatsEnabled
      ? resolveChatInterfaceModeOptions(interfaceModeControl)
      : undefined;
  useAnimatedComposerBox(
    dropContainerRef,
    `${String(readOnly)}:${tab?.id ?? ''}`,
  );

  const [composerDensity, setComposerDensity] =
    useState<ComposerDensity>('comfortable');
  useLayoutEffect(() => {
    const node = composerRootRef.current;
    // The composer and the transcript column are siblings inside the
    // height-constrained `flex flex-col` wrapper that each ChatContent
    // caller provides (through ChatContent's `display: contents` root), so
    // that wrapper's height is the panel/surface height and does not change
    // when the composer shrinks — no measure→shrink→remeasure feedback loop.
    const panel = findComposerDensityPanel(node);
    if (!panel || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const applyHeight = (height: number): void => {
      setComposerDensity((prev) => resolveComposerDensity(height, prev));
    };
    applyHeight(panel.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyHeight(entry.contentRect.height);
    });
    observer.observe(panel);
    return (): void => {
      observer.disconnect();
    };
  }, [readOnly, tab?.id]);

  const handleApprove = useCallback(() => {
    if (pendingExit) {
      void approvePlanExit(pendingExit.requestId);
    }
  }, [pendingExit, approvePlanExit]);

  // Open the pending plan's Plan panel beside this chat. The plan is created
  // from the pending text when its tracked id was never persisted (seeded tab
  // state), so the panel always has a plan to show.
  const handleExplorePlan = useCallback(async (): Promise<void> => {
    if (
      !pendingExit ||
      !pendingExit.projectId ||
      !pendingExit.worktreeId ||
      !trackedPlanId
    ) {
      return;
    }
    const { projectId, worktreeId } = pendingExit;
    try {
      await openPendingPlanExit(
        {
          projectId,
          worktreeId,
          chatId: pendingExit.chatId,
          source: pendingExit.source,
          content: getPendingPlanText(pendingExit),
        },
        trackedPlanId,
      );
    } catch (error: unknown) {
      addToast(
        error instanceof Error ? error.message : 'Failed to open plan',
        'error',
        undefined,
        { category: 'Chat', projectId, worktreeId },
      );
    }
  }, [pendingExit, trackedPlanId, addToast]);

  // The plan prompt moves the editor into its text row and back, so focus
  // follows it once the box has re-rendered.
  const focusEditorAfterPlanCardRef = useRef(false);
  const closePlanCard = useCallback((): void => {
    focusEditorAfterPlanCardRef.current = true;
    setClosedPlanRequestKey(planRequestKey);
  }, [planRequestKey]);
  const reopenPlanCard = useCallback((): void => {
    focusEditorAfterPlanCardRef.current = true;
    setClosedPlanRequestKey(null);
  }, []);
  const closeQuestionPrompt = useCallback((): void => {
    focusEditorAfterPlanCardRef.current = true;
    if (activeQuestion) setQuestionPromptClosed(activeQuestion.requestId, true);
  }, [activeQuestion]);
  const reopenQuestionPrompt = useCallback((): void => {
    focusEditorAfterPlanCardRef.current = true;
    if (activeQuestion)
      setQuestionPromptClosed(activeQuestion.requestId, false);
  }, [activeQuestion]);
  // A picked answer takes the typed text with it, as a send would.
  const takeQuestionText = useCallback((): string => {
    const { text } = serializeEditorValue(editor.children);
    if (!text.trim()) return '';
    resetEditor(editor);
    setValue(createEmptyValue());
    if (tabId) useChatStore.getState().clearTabDraft(tabId);
    return text;
  }, [editor, tabId]);
  useEffect(() => {
    const chatId = tab?.id;
    if (!composerProjectId || !composerWorktreeId || !chatId) return undefined;
    const revealTarget = {
      projectId: composerProjectId,
      worktreeId: composerWorktreeId,
      chatId,
    };
    // Explicit navigation to pending attention also reopens a prompt the
    // reader previously collapsed to its composer chip. Neither action
    // resolves the pending question or plan. A reveal fired before this
    // composer mounted (another worktree's chat) waits until its question is
    // here, so a question that loads just after mount still opens.
    const reveal = (): void => {
      reopenQuestionPrompt();
      reopenPlanCard();
    };
    if (activeQuestion && consumeChatPanelReveal(revealTarget)) reveal();
    return subscribeChatPanelReveal((target): void => {
      if (
        target.projectId !== revealTarget.projectId ||
        target.worktreeId !== revealTarget.worktreeId ||
        target.chatId !== revealTarget.chatId
      )
        return;
      consumeChatPanelReveal(target);
      reveal();
    });
  }, [
    composerProjectId,
    composerWorktreeId,
    tab?.id,
    activeQuestion,
    reopenQuestionPrompt,
    reopenPlanCard,
  ]);
  useEffect(() => {
    if (!focusEditorAfterPlanCardRef.current) return;
    focusEditorAfterPlanCardRef.current = false;
    focusEditor(editor);
  }, [planCardOpen, questionPromptOpen, editor]);

  // A prompt that shows (a question, its next step, or a waiting plan) puts
  // the cursor in the composer's input, ready for a typed answer or note. It
  // never takes focus from another field or terminal the user is typing in.
  const promptFocusKey = questionPromptOpen
    ? `question:${activeQuestion?.requestId ?? ''}:${questionPrompt.prompt.step}`
    : planCardOpen
      ? `plan:${planRequestKey ?? ''}`
      : null;
  // A question step with its own field focuses that field instead
  // (QuestionPrompt).
  const promptFocusesEditor =
    !questionPromptOpen || questionPrompt.prompt.kind !== 'field';
  useEffect(() => {
    if (promptFocusKey === null || !promptFocusesEditor) return;
    // The prompt moves the editor into its text row: wait for Slate to
    // render it there before focusing.
    const frame = requestAnimationFrame(() => {
      if (!isComposerVisible()) return;
      if (!isTypingOutside(composerRootRef.current)) focusEditor(editor);
    });
    return (): void => cancelAnimationFrame(frame);
  }, [promptFocusKey, promptFocusesEditor, editor, isComposerVisible]);

  const planReviewClosed =
    trackedPlanReviewStatus !== undefined &&
    trackedPlanReviewStatus !== 'pending';
  const {
    planImplementation: planImplementationAllowed,
    planPipeline: planPipelineAllowed,
  } = deriveChatWorkflowCapabilities({
    resolvedProvider:
      pendingExit?.source ??
      (typeof pendingExit?.toolInput.source === 'string'
        ? pendingExit.toolInput.source
        : 'claude'),
    interfaceMode: tab?.interfaceMode ?? 'canopy',
    target: 'worktree',
    capabilities: scopeCapabilities,
  });
  const planApprovalOptions: readonly PlanApprovalOption[] = [
    {
      label: planImplementationAllowed
        ? 'Yes, implement this plan'
        : 'Implementation unavailable',
      onSelect: handleApprove,
      disabled: planReviewClosed || !planImplementationAllowed,
      testId: 'chat-plan-implement',
    },
    ...(planPipelineAllowed
      ? [
          {
            label: 'Run it as a workflow',
            onSelect: (): void => setPipelineModalOpen(true),
            disabled: planReviewClosed,
            testId: 'chat-plan-pipeline',
          },
        ]
      : []),
  ];

  const planPipelineWatcher = usePipelineRunWatcher(
    pendingExit?.projectId && pendingExit?.worktreeId
      ? {
          projectId: pendingExit.projectId,
          worktreeId: pendingExit.worktreeId,
        }
      : null,
  );

  // The Feed's Run it as a workflow opens this chat and asks for the same
  // picker this prompt's answer opens.
  const planWorkflowChatId = pendingExitChatId ?? tabId;
  useEffect(() => {
    if (
      !planPipelineAllowed ||
      !pendingExitProjectId ||
      !pendingExitWorktreeId ||
      !planWorkflowChatId
    ) {
      return undefined;
    }
    const target = {
      projectId: pendingExitProjectId,
      worktreeId: pendingExitWorktreeId,
      chatId: planWorkflowChatId,
    };
    const take = (): void => {
      if (takePlanWorkflowRequest(target)) setPipelineModalOpen(true);
    };
    take();
    return subscribePlanWorkflowRequests(take);
  }, [
    planPipelineAllowed,
    pendingExitProjectId,
    pendingExitWorktreeId,
    planWorkflowChatId,
  ]);

  const handlePipelineRun = useCallback(
    async (
      _pipelineId: string,
      pipeline: PipelineData,
      inputs: Record<string, string> | undefined,
      selectedRepoId: string | undefined,
      pluginCollectionContext: PipelinePluginCollectionContext,
    ): Promise<void> => {
      if (!pendingExit || !planPipelineAllowed) return;

      const planText = getPendingPlanText(pendingExit);

      let cwd = '';
      if (pendingExit.projectId && pendingExit.worktreeId) {
        cwd = await window.api.getWorktreePath({
          projectId: pendingExit.projectId,
          worktreeId: pendingExit.worktreeId,
          repoId: selectedRepoId,
        });
      }

      setPipelineRunning(true);
      setPipelineRunError(null);

      // Execute the pipeline and only dismiss plan approval on success
      let result: { success: boolean; error?: string; data?: { id?: string } };
      try {
        const appAdvisorPipelineWatchers =
          planPipelineWatcher.appAdvisorPipelineWatchers();
        result = await window.pipelines.execute(pipeline.content, {
          cwd,
          pipelineId: pipeline.info.id,
          pipelineFilePath:
            pipeline.info.source === 'project'
              ? pipeline.info.filePath
              : undefined,
          repoPath: pipeline.info.source === 'project' && cwd ? cwd : undefined,
          projectId: pendingExit.projectId,
          worktreeId: pendingExit.worktreeId,
          chatId: pendingExit.chatId,
          planId: trackedPlanId,
          eventName: 'plan_ready',
          eventData: {
            plan_ready: { plan_text: planText },
          },
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
          pluginCollectionPreferences: pluginCollectionContext.preferences,
          ...(pluginCollectionContext.modelAliasPreferences
            ? {
                modelAliasPreferences:
                  pluginCollectionContext.modelAliasPreferences,
              }
            : {}),
          modelConfig: pluginCollectionContext.modelConfig,
          ...(appAdvisorPipelineWatchers ? { appAdvisorPipelineWatchers } : {}),
          ...(pluginCollectionContext.pipelinePreferenceLocator
            ? {
                pipelinePreferenceLocator:
                  pluginCollectionContext.pipelinePreferenceLocator,
              }
            : {}),
          ...(pipeline.info.source === 'shared' &&
          pipeline.info.serverId &&
          pipeline.info.remoteId
            ? {
                sharedPipeline: {
                  serverId: pipeline.info.serverId,
                  remoteId: pipeline.info.remoteId,
                },
              }
            : {}),
        });
      } catch (err: unknown) {
        setPipelineRunning(false);
        setPipelineRunError(extractIpcErrorMessage(err));
        return;
      }

      if (!result.success) {
        setPipelineRunning(false);
        setPipelineRunError(result.error ?? 'Workflow execution failed');
        return;
      }

      planPipelineWatcher.reset();
      try {
        await dismissPlanForPipeline(pendingExit.requestId);
      } finally {
        setPipelineModalOpen(false);
        setPipelineRunning(false);
      }
    },
    [
      pendingExit,
      trackedPlanId,
      dismissPlanForPipeline,
      planPipelineWatcher,
      planPipelineAllowed,
    ],
  );

  // A row that must be enabled first returns its outcome to the composer
  // menu, which shows the row enabling and reports a failure in place.
  // Dismissing the menu aborts `pick.signal`: the enable still runs to its
  // end, but inserts nothing.
  const handleSelectCommand = useCallback(
    (
      cmd: SlashCommandData,
      pick?: ComposerMenuPick,
    ): Promise<ComposerMenuCommandOutcome> | undefined => {
      // Replaces the trigger the command was picked from; while the menu
      // holds an enabling pick, an edited trigger inserts nothing and this
      // reports `false`.
      const insertSelection = (selected: typeof cmd): boolean => {
        if (!composerMenu.consumeTrigger()) return false;
        Transforms.insertText(editor, getSlashCommandInsertText(selected));
        return true;
      };
      if (
        ('disabledReason' in cmd && cmd.disabledReason !== undefined) ||
        readOnly
      )
        return undefined;
      const action = getComposerAction(cmd);
      if (action) {
        const handlers: ComposerActionHandlers = {
          ...(canChangePluginSelections
            ? {
                plugins: (): void => {
                  void openPluginsModal();
                },
              }
            : {}),
          ...(canAttachFiles
            ? {
                attach: (): void => {
                  void handleImportAttachments();
                },
              }
            : {}),
          model: () => {
            if (composerShortcutTarget)
              requestModelPickerOpen(composerShortcutTarget);
          },
          ...(scopeCapabilities.chatThinkingLevel === true
            ? { thinking: handleCycleThinkingLevel }
            : {}),
          ...(pendingExit && planPipelineAllowed
            ? { pipeline: () => setPipelineModalOpen(true) }
            : {}),
          ...(canUsePlanMode
            ? { plan: () => togglePlanMode(targetOverride) }
            : {}),
          ...(supportsFastMode ? { fast: cycleSpeed } : {}),
          ...(showScheduleControls
            ? { schedule: () => setScheduleModalOpen(true) }
            : {}),
        };
        runComposerAction(action, {
          controller: composerMenu,
          handlers,
          syncDraft: syncEditorValue,
          onUnavailable: () =>
            addToast('This action is unavailable in this composer.', 'error'),
        });
        return undefined;
      }
      const insertDiscovered = (): void => {
        insertSelection(cmd);
        syncEditorValue();
        focusEditor(editor);
      };

      // Available-to-enable rows: enable the underlying skill/plugin for this
      // chat (like the plugin picker), validate it live, then insert the
      // RESOLVED invocation text. Inherited rows take the same path for the
      // resolved id alone. Other discovered rows fall straight through.
      if (!inventoryRowNeedsResolution(cmd)) {
        insertDiscovered();
        return undefined;
      }

      const entry = cmd.inventoryEntry;
      // Every enable failure is logged into the app diagnostics
      // (`app-events`) with the chat, project and worktree the removed toast
      // carried. The open menu shows it in place, and its banner records the
      // surfaced error; a pick the person dismissed shows nothing, since a
      // failed on-screen action does not toast (feedback.md, legacy error
      // ratchet).
      const reportEnableFailure = (status: string): void =>
        reportRendererConsoleError('Composer menu could not enable a command', {
          status,
          menuDismissed: pick?.signal.aborted ?? false,
          ...(entry ? { entryId: entry.id } : {}),
          ...(slashCommandTarget
            ? {
                projectId: slashCommandTarget.projectId,
                worktreeId: slashCommandTarget.worktreeId,
              }
            : {}),
          ...(tab ? { chatId: tab.id } : {}),
        });
      if (!entry || !slashCommandTarget || !tab || !inventoryProviderType) {
        // Nothing to enable here, so the menu offers no Try again.
        reportEnableFailure('unavailable');
        return Promise.resolve('unavailable');
      }
      const target = slashCommandTarget;
      const providerType = inventoryProviderType;

      let inserted = false;
      const enableAndInsert = async (): Promise<ComposerMenuCommandOutcome> => {
        // The chat's checkout: Claude Code plugins installed for one
        // repository are inherited (and numbered) only there.
        const projectPath = await window.api
          .getWorktreePath({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            repoId: selectedRepoId,
          })
          .catch((): string => '');
        const outcome = await runInventorySelection({
          entry,
          providerType,
          currentSelections:
            effectivePluginSelections ?? createEmptySelections(),
          ...(tabDisabledGlobalPluginSelections
            ? { chatTombstones: tabDisabledGlobalPluginSelections }
            : {}),
          ...(projectPath ? { projectPath } : {}),
          deps: {
            prepareCodexCompatibilityPlugin: (marketplaceId, pluginName) =>
              window.plugins.prepareCodexCompatibilityPlugin(
                marketplaceId,
                pluginName,
              ),
            resolveSelection: (request) =>
              window.invocableInventory.resolveSelection(request),
            applySelections: (next) =>
              setPluginSelections(
                stripAgentOnlyChatPluginSelections(
                  next,
                  agentPluginSelections,
                  pluginSelections,
                ),
                targetOverride,
              ),
            insertResolvedText: (insertText) => {
              // The person dismissed the menu: the enable stands, but the
              // command is not inserted.
              if (pick?.signal.aborted) return;
              // Reuse the trigger-range replacement with the resolved value.
              if (!insertSelection({ ...cmd, insertText })) return;
              inserted = true;
              syncEditorValue();
              focusEditor(editor);
            },
            // The outcome below reports a failure.
            onError: () => undefined,
            refreshInventory: () => {
              void invocableInventory.refresh();
            },
          },
        });
        if (outcome !== 'inserted') {
          reportEnableFailure(outcome);
          return 'failed';
        }
        return inserted ? 'done' : 'skipped';
      };
      return enableAndInsert();
    },
    [
      readOnly,
      composerMenu,
      openPluginsModal,
      handleImportAttachments,
      composerShortcutTarget,
      handleCycleThinkingLevel,
      canUsePlanMode,
      togglePlanMode,
      supportsFastMode,
      cycleSpeed,
      showScheduleControls,
      planPipelineAllowed,
      pendingExit,
      addToast,
      editor,
      inventoryProviderType,
      effectivePluginSelections,
      invocableInventory,
      agentPluginSelections,
      pluginSelections,
      setPluginSelections,
      slashCommandTarget,
      syncEditorValue,
      selectedRepoId,
      tabDisabledGlobalPluginSelections,
      tab,
      targetOverride,
    ],
  );

  const handleCommandSelect = useCallback(
    (
      cmd: SlashCommandData,
      pick: ComposerMenuPick,
    ): Promise<ComposerMenuCommandOutcome> | undefined =>
      handleSelectCommand(cmd, pick),
    [handleSelectCommand],
  );

  const confirmComposerTurn = composerTurn.confirmTurn;
  const handleCheckStatus = useCallback(
    (): Promise<StuckAgentCheckResult> =>
      checkChatStatus({
        confirmTurn: confirmComposerTurn,
        verifyStreamingTabs,
      }),
    [confirmComposerTurn, verifyStreamingTabs],
  );

  // Offered only where the default placeholder would show, so it never hides
  // a question, plan, approval or other prompt the composer is waiting on.
  const promptSuggestion = offeredPromptSuggestion({
    suggestion: promptSuggestionEntry?.suggestion,
    dismissed: promptSuggestionEntry?.dismissed ?? false,
    latestUserMessageId,
    // Untrimmed: Slate hides the placeholder for any text, whitespace too, and
    // Tab must not insert a suggestion the person can no longer see.
    draftEmpty:
      serializedDraft.text.length === 0 &&
      serializedDraft.fileReferences.length === 0 &&
      pendingAttachments.length === 0,
    showsDefaultPlaceholder:
      !voiceRecording &&
      voice.state === 'idle' &&
      !questionPromptOpen &&
      !planCardOpen &&
      !isEditingQueued &&
      !isTerminalMode &&
      !pendingExit &&
      !approvalPending &&
      !isStreaming &&
      !isAccountHarness &&
      !readOnly &&
      !sandbox,
  });

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The `!` typeahead runs before send: Enter/Tab pick a script while it is
    // open, and an unmatched draft still sends raw.
    if (scriptTypeahead.handleKeyDown(e)) return;
    if (composerMenu.handleKeyDown(e)) return;
    // Menus had the key first, so their Tab and Escape still work. With no
    // suggestion offered, Tab keeps moving focus.
    const suggestionAction = promptSuggestionKeyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        isComposing: e.nativeEvent.isComposing,
      },
      promptSuggestion !== null && promptSuggestionTarget !== null,
    );
    if (suggestionAction === 'accept' && promptSuggestion !== null) {
      e.preventDefault();
      dictationInputModeRef.current = 'typed';
      Transforms.insertText(editor, promptSuggestion);
      return;
    }
    if (suggestionAction === 'dismiss' && promptSuggestionTarget !== null) {
      e.preventDefault();
      usePromptSuggestionStore.getState().dismiss(promptSuggestionTarget);
      return;
    }
    // Cancel an active dictation session when the user hits Escape, and keep
    // any keystroke from staying marked as voice input.
    if (e.key === 'Escape' && voice.state !== 'idle') {
      e.preventDefault();
      dictationInputModeRef.current = 'typed';
      void voice.cancel();
      return;
    }
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
      dictationInputModeRef.current = 'typed';
    }

    if (!isEditingQueued && handleMessageHistoryKeyDown(e)) return;

    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      handleSend();
    }
    // Cmd+Shift+Enter → approve plan exit (suppressed in edit-queued mode
    // since the plan-exit bar is hidden and Cancel/Save own the action row).
    if (
      !isEditingQueued &&
      e.key === 'Enter' &&
      e.shiftKey &&
      e.metaKey &&
      pendingExit
    ) {
      e.preventDefault();
      handleApprove();
    }
  };

  const handleStartNewSession = useCallback((): void => {
    setHandoffError(null);
    void handleStaleSessionStartNew().catch((err: unknown) => {
      setHandoffError(
        err instanceof Error ? err.message : 'Failed to start new session',
      );
    });
  }, [handleStaleSessionStartNew]);

  const handleHandOffSession = useCallback((): void => {
    if (handoffLoading) {
      return;
    }

    setHandoffLoading(true);
    setHandoffError(null);
    void handleStaleSessionHandOff()
      .catch((err: unknown) => {
        setHandoffError(
          err instanceof Error
            ? err.message
            : 'Failed to create handoff summary',
        );
      })
      .finally(() => {
        setHandoffLoading(false);
      });
  }, [handoffLoading, handleStaleSessionHandOff]);

  // Expanded, the editor sizes to its text like the one-line composer;
  // the density step only caps its height on short panels.
  const expandedEditorContainerClassName =
    expandedComposerEditorContainerClassName(composerDensity);
  const slateContainerClassName = `${expandedEditorContainerClassName}${
    voiceRecording ? ` ${VOICE_TAKE_EDITOR_CONTAINER_CLASS}` : ''
  }`;

  const voiceAvailable = voiceSupported && voiceEnabledPref;
  const renderVoiceButton = (primary: boolean): JSX.Element | null =>
    voiceAvailable ? (
      <VoiceInputButton
        state={voice.state}
        error={voice.error}
        onStart={(): void => void voice.start()}
        onStop={(): void => void voice.stop()}
        disabled={isTerminalMode || sandbox}
        capsule
        primary={primary}
        shortcut={DICTATION_SHORTCUT_LABEL}
      />
    ) : null;

  // Terminal mode keeps the default box and adds its dashed warning edge,
  // red while the last command could not be sent.
  /* eslint-disable shadcn/require-static-classes -- Preserve the existing terminal and prompt recipes in the shared shell. */
  const shellDecoration = isTerminalMode
    ? terminalModeError === null
      ? TERMINAL_MODE_SHELL_CLASS
      : TERMINAL_MODE_ERROR_SHELL_CLASS
    : '';
  const containerClasses = promptOpen
    ? `${shellDecoration}${shellDecoration ? ' ' : ''}${PLAN_APPROVAL_BOX_CLASS}`
    : shellDecoration;
  /* eslint-enable shadcn/require-static-classes */

  const readOnlySessionActions = (
    <>
      <NoticeButton
        data-testid="read-only-start-new-session"
        onClick={handleStartNewSession}
        disabled={handoffLoading}
      >
        Start new session
      </NoticeButton>
      <NoticeButton
        data-testid="read-only-hand-off-session"
        onClick={handleHandOffSession}
        disabled={handoffLoading}
      >
        {handoffLoading ? 'Handing off…' : 'Hand off session'}
      </NoticeButton>
    </>
  );

  const hintActivity = useComposerHintActivity(
    composerRootRef,
    composerShortcutsEnabled && !isEditingQueued && !readOnly,
  );
  const hint = usePlanModeSuggestion({
    suggestionsClaimApi: useSuggestionsClaimApi(),
    text: serializedDraft.text,
    draftKey: `chat:${composerProjectId}:${composerWorktreeId}:${tabId}:${hintDraftSession}`,
    activationKey: effectiveProviderType,
    planMode,
    planAvailable: canUsePlanMode && !readOnly && !promptOpen,
    planReadOnly: isAccountHarness,
    pipelineMode: isTerminalMode,
    ...hintActivity,
    store: getPlanModeHintStore(),
    onEnablePlanMode: () => {
      if (!tabId) return false;
      const current = useChatStore.getState();
      const currentTab = Object.values(current.worktreeChats)
        .flatMap((state) => state.tabs)
        .find((candidate) => candidate.id === tabId);
      if (
        !currentTab ||
        resolveEffectiveProviderType(
          currentTab.model,
          currentTab.providerType,
        ) !== effectiveProviderType
      )
        return false;
      if (currentTab.planMode) return true;
      if (!composerProjectId || !composerWorktreeId) return false;
      return new Promise<boolean>((resolve) =>
        current.togglePlanMode(
          {
            projectId: composerProjectId,
            worktreeId: composerWorktreeId,
            chatId: tabId,
          },
          resolve,
        ),
      );
    },
    focusComposer: () => focusEditor(editor),
    onShown: () => trackPlanModeHintAction('shown', 'chat'),
    onAccepted: () => trackPlanModeHintAction('accepted', 'chat'),
    onDismissed: () => trackPlanModeHintAction('dismissed', 'chat'),
  });
  // App Advisor never shows the star prompt; a brand without a source
  // repository has no store, so nothing counts or shows there either.
  const starPromptStore = isAppAdvisorComposer
    ? null
    : getGitHubStarPromptStore();
  const starLogin = useGitHubStarPromptLogin(starPromptStore);
  const starPrompt = useGitHubStarPrompt({
    store: starPromptStore,
    repository: getBrandSourceRepository(),
    starLogin,
    active: hintActivity.active && !isTerminalMode,
    turnActive: isStreaming,
    focusComposer: () => focusEditor(editor),
    onShown: () => trackGitHubStarPromptAction('shown'),
    onStarred: () => trackGitHubStarPromptAction('starred'),
    onOpened: ({ fallback }) =>
      trackGitHubStarPromptAction('opened', { fallback }),
    onDismissed: () => trackGitHubStarPromptAction('dismissed'),
  });
  if (readOnly) {
    return (
      <div
        ref={composerRootRef}
        data-chat-composer-root
        data-chat-composer-tab-id={tabId}
        className="relative z-30 mx-auto w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 px-4 pb-4 pt-2"
      >
        {/* The banners above the composer, in place of the box. */}
        <NoticeShapeProvider shape="composer">
          {staleSessionDetected ? (
            <Notice
              intent="attention"
              title="This session can no longer be resumed"
              {...(handoffError ? { detail: handoffError } : {})}
              actions={readOnlySessionActions}
            >
              Your last message was not delivered.
            </Notice>
          ) : (
            <Notice
              intent="neutral"
              role="none"
              title="This session has been archived"
              {...(handoffError ? { detail: handoffError } : {})}
              actions={readOnlySessionActions}
            >
              Messages are read-only.
            </Notice>
          )}
        </NoticeShapeProvider>
      </div>
    );
  }

  // The editor and the controls around it, laid out by the box below: in
  // the box itself, or in the plan-approval prompt's text row.
  const composerEditor = (
    <ComposerEditor
      editor={editor}
      value={value}
      onChange={handleEditorChange}
      onSelectionChange={handleSelectionChange}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      monospace={isTerminalMode}
      density="minimal"
      typeToFocus
      className={
        composerInline || promptOpen
          ? ONE_LINE_COMPOSER_CLASS_NAMES.editor
          : undefined
      }
      containerClassName={
        promptOpen
          ? PLAN_APPROVAL_EDITOR_CONTAINER_CLASS
          : composerInline
            ? ONE_LINE_COMPOSER_CLASS_NAMES.editorContainer
            : slateContainerClassName
      }
      placeholder={
        voiceRecording
          ? 'Start talking…'
          : questionPromptOpen
            ? questionPlaceholder
            : planCardOpen
              ? 'No, explain what to do differently'
              : isEditingQueued
                ? 'Edit queued message…'
                : isTerminalMode
                  ? '! shell command…'
                  : pendingExit
                    ? 'Enter your plan adjustments here…'
                    : approvalPending
                      ? 'Answer the approval above first'
                      : isStreaming
                        ? 'Type to queue a follow-up message…'
                        : isAccountHarness
                          ? 'Send a message'
                          : (promptSuggestion ?? chatPlaceholder)
      }
      placeholderSuffix={
        promptSuggestion !== null ? <PromptSuggestionKeyHint /> : undefined
      }
    />
  );
  const composerControls = voiceRecording ? (
    <VoiceRecordingRow
      readLevel={voice.readLevel}
      listeningSince={voice.listeningSince}
      onCancel={(): void => {
        dictationInputModeRef.current = 'typed';
        void voice.cancel();
      }}
      onStop={(): void => void voice.stop()}
      onSend={handleVoiceSend}
    />
  ) : (
    <ChatComposerToolbar
      dataTestId="chat-input-controls-row"
      capsuleLayout
      compact={isCompact}
      // In the plan prompt's text row the controls sit on its one line, as
      // on the one-line composer.
      inline={composerInline || promptOpen}
      rowRef={bottomRowRef}
      leadingSlot={
        <div
          // The prompt shows no +, but + stays mounted out of view: its menu
          // is the popup @, / and $ open over the box, there as here.
          className={
            promptOpen
              ? 'sr-only'
              : composerInline
                ? `relative shrink-0 ${ONE_LINE_COMPOSER_CLASS_NAMES.leading}`
                : 'relative shrink-0'
          }
          inert={promptOpen}
          data-chat-cancel-shortcut-ignore={
            composerMenu.open ? 'true' : undefined
          }
        >
          {/* Non-interactive anchor for composer submenus. `FloatingMenu` attaches an
                  ArrowDown/ArrowUp open listener to its anchor, so anchoring the
                  popup on the wrapper that CONTAINS the `+` button gave ArrowDown a
                  second meaning: the button's keydown bubbled to the wrapper and
                  opened both surfaces. This span shares the wrapper's box (so
                  placement is unchanged) without containing the trigger. */}
          <span
            ref={composerPopupAnchorRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
          />
          <ComposerPlusMenu
            key={modelChangeKey}
            {...(canAttachFiles
              ? {
                  onPickAttachment: (): void => void handleImportAttachments(),
                }
              : {})}
            {...(scopeCapabilities.chatInterfaceModes === true
              ? { onPickLinear: (): void => setLinearPickerOpen(true) }
              : {})}
            disabled={isTerminalMode || sandbox}
            dataTestIdPrefix="chat-input"
            // The pickers' spacing: clear of the composer, like the
            // model and approval menus.
            gap={FLOATING_PICKER_GAP}
            triggerRef={plusTriggerRef}
            capsuleTrigger
            // A chat scope that serves no attachments, plugins, files or
            // composer actions shows no `+`; each key a backend turns on
            // brings its row, and the `+`, back.
            hideTriggerWhenEmpty
            controller={composerMenu}
            {...(fileTypeaheadEnabled
              ? {
                  searchFiles: searchComposerFiles,
                  onSelectFile: (
                    file: Parameters<typeof composerMenu.insertFile>[0],
                  ): void => composerMenu.insertFile(file, fileRepos.length),
                }
              : {})}
            multiRepo={fileRepos.length > 1}
            commands={composerCommands}
            pluginSelections={effectivePluginSelections}
            providerScope={effectiveProviderType ?? 'mixed'}
            // The inline pick lists this computer's marketplaces and writes
            // the local core's selection: a cloud chat picks from its catalog.
            {...(canChangePluginSelections && webCoreProjectId === undefined
              ? {
                  onSelectPlugin: (
                    ref: { marketplaceId: string; pluginName: string },
                    { label, enabled }: { label: string; enabled: boolean },
                  ): void => {
                    // The mention pill lands regardless of enablement state
                    // so an already-enabled plugin can still be called out
                    // inline.
                    composerMenu.insertPlugin({ ...ref, label });
                    syncEditorValue();
                    if (!enabled) void enablePluginsForChat([ref]);
                  },
                }
              : {})}
            onSelectCommand={handleCommandSelect}
            isRefreshing={isRefreshing || fileIndexLoading}
            additionalItems={buildChatComposerPlusItems({
              ...(canChangePluginSelections
                ? { onOpenPlugins: (): void => void openPluginsModal() }
                : {}),
              hasPluginSelections,
              ...(canUsePlanMode
                ? {
                    plan: {
                      on: planMode,
                      readOnly: workflowGates.planModeReadOnly,
                      disabled:
                        isTerminalMode || (isAccountHarness && isStreaming),
                      onToggle: (): void => togglePlanMode(targetOverride),
                    },
                  }
                : {}),
              ...(showScheduleControls
                ? { onSchedule: (): void => setScheduleModalOpen(true) }
                : {}),
              ...(interfaceModeOptions && interfaceModeControl
                ? {
                    interfaceModes: {
                      options: interfaceModeOptions,
                      onSelect: interfaceModeControl.onChange,
                    },
                  }
                : {}),
            })}
          />
        </div>
      }
      planMode={
        promptOpen
          ? undefined
          : questionReady
            ? buildQuestionReadyChip({
                compact: chipsCompact,
                onOpen: reopenQuestionPrompt,
              })
            : planReady
              ? buildPlanReadyChip({
                  compact: chipsCompact,
                  onOpen: reopenPlanCard,
                })
              : planMode
                ? buildPlanModeChip({
                    readOnly: workflowGates.planModeReadOnly,
                    compact: chipsCompact,
                    disabled:
                      isTerminalMode || (isAccountHarness && isStreaming),
                    onDisable: (): void => {
                      togglePlanMode(targetOverride);
                      focusEditor(editor);
                    },
                  })
                : undefined
      }
      scheduledSendSlot={
        !promptOpen && showScheduledSendDraft && scheduledSendDraft ? (
          <ScheduledSendChip
            runAt={scheduledSendDraft.runAt}
            error={scheduleSendError}
            editable={supportsScheduledSends}
            compact={chipsCompact}
            onEdit={(): void => setScheduleModalOpen(true)}
            onClear={handleClearScheduledSend}
          />
        ) : null
      }
      terminalLabelSlot={
        isTerminalMode ? (
          <TerminalModeLabel
            error={terminalModeError}
            hint={scriptTypeahead.hint}
          />
        ) : null
      }
      trailingSlot={
        // Editing a queued message, Cancel and Save take send's place,
        // as capsules at send's height. Otherwise (the plan prompt's text
        // row too) the microphone sits beside the trailing action, and
        // with an empty draft it takes that place as the primary action
        // instead of a disabled send. A shell command is typed, not
        // dictated: no microphone.
        isEditingQueued && editingState ? (
          <MessageEditCancelSave
            onCancel={editingState.onCancel}
            onSave={handleSend}
            saveDisabled={!serializedDraft.text.trim()}
          />
        ) : isTerminalMode ? (
          <ComposerSendButton
            kind="terminal"
            onRun={handleSend}
            disabled={!terminalCommand}
            failed={terminalModeError !== null}
          />
        ) : questionPromptOpen &&
          (questionPrompt.prompt.skips(serializedDraft.text) ||
            questionPrompt.prompt.sendAnswers(serializedDraft.text)) ? (
          // An open question owns the trailing action, even mid-turn: stop
          // returns once the question is closed (x or Esc).
          // Until something is answered, Skip takes send's place.
          <>
            {renderVoiceButton(false)}
            {questionPrompt.prompt.skips(serializedDraft.text) ? (
              <QuestionSkipButton
                busy={questionPrompt.busy}
                disabled={questionPrompt.disconnected}
                onSkip={questionPrompt.skip}
              />
            ) : (
              <ComposerSendButton
                kind="send"
                onSend={handleSend}
                disabled={
                  !questionPrompt.prompt.canSend(serializedDraft.text) ||
                  questionPrompt.busy !== null ||
                  questionPrompt.disconnected
                }
                pending={false}
                dataTestId="chat-question-send"
              />
            )}
          </>
        ) : isStreaming ? (
          <>
            {renderVoiceButton(false)}
            <ComposerSendButton
              kind="stop"
              onStop={(): void => void cancelSession(targetOverride)}
              pending={pendingModelChange !== undefined}
              armed={cancelShortcutArmed}
              shortcutReady={composerShortcutsEnabled}
              dataTestId="chat-stop-generation"
            />
          </>
        ) : voiceAvailable &&
          !serializedDraft.text.trim() &&
          pendingModelChange === undefined ? (
          renderVoiceButton(true)
        ) : (
          <>
            {renderVoiceButton(false)}
            <ComposerSendButton
              kind="send"
              onSend={handleSend}
              disabled={
                !serializedDraft.text.trim() ||
                isResourceGuardBlocked ||
                tab?.firstSendPreparing === true ||
                cloudUploading
              }
              pending={pendingModelChange !== undefined}
              {...(isResourceGuardBlocked
                ? {
                    blockedReason: resourceGuardMessage ?? 'Send message',
                  }
                : cloudUploading
                  ? { blockedReason: 'Attachments are uploading' }
                  : {})}
            />
          </>
        )
      }
    />
  );

  // A prompt's text row: the composer's own editor, microphone, and send.
  const promptTextRow = voiceRecording ? (
    <div className="flex min-w-0 flex-1 flex-col">
      {composerEditor}
      {composerControls}
    </div>
  ) : (
    <>
      {composerEditor}
      {composerControls}
    </>
  );

  return (
    <div
      ref={composerRootRef}
      data-chat-composer-root
      data-chat-composer-tab-id={tabId}
      data-testid={isEditingQueued ? 'queued-message-editor' : undefined}
      data-composer-density={composerDensity}
      data-question-prompt={questionPromptOpen}
      // Under the controls row the panel edge sits as far from the controls
      // as the composer box does above them (8px each side).
      className="relative z-30 mx-auto w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 px-4 pt-2 pb-2"
    >
      {/*
        Guidance and its dismissal are owned by the hook, which resets them on
        every attempt. Keying dismissal on the error message here used to
        silence this modal permanently: a denied microphone reports the same
        string on every retry.
      */}
      <VoiceDictationErrorModal
        guidance={voice.errorGuidance}
        onDismiss={voice.dismissError}
      />
      {/* Composer notices: the shared stack owns their spacing and composer
          corners, and collapses when none render. Every notice is the shared
          `Notice` primitive. */}
      <ComposerNoticeStack data-testid="chat-input-notices">
        {/* A cloud task the web core refused to create says why first, with
            Try again (CAN-6098). */}
        {webCoreProjectId !== undefined && composerWorktreeId !== undefined ? (
          <CloudTaskCreationNotice
            projectId={webCoreProjectId}
            worktreeId={composerWorktreeId}
          />
        ) : null}
        {/* A cloud send the web core refused: the draft is back above, and
            this says why (CAN-6364), as the cloud chat page does. */}
        {!isEditingQueued &&
        sendRefusalTarget !== null &&
        sendRefusal !== undefined ? (
          <Notice
            intent="destructive"
            data-testid="chat-input-send-refused"
            onDismiss={(): void => dismissSendRefusal(sendRefusalTarget)}
            dismissLabel="Dismiss"
          >
            {sendRefusal
              ? `Your message wasn't sent: ${sendRefusal}`
              : "Your message wasn't sent."}
          </Notice>
        ) : null}
        {!isEditingQueued && attachmentProblems.length > 0 ? (
          <Notice
            intent="attention"
            data-testid="chat-input-attachment-problems"
            onDismiss={(): void => setAttachmentProblems([])}
            dismissLabel="Dismiss"
          >
            {attachmentProblems.map((problem) => (
              <span key={problem} className="block">
                {problem}
              </span>
            ))}
          </Notice>
        ) : null}
        {/* A Home first send whose model was refused (CAN-5021). First in
            the stack: it says why the prompt above never sent. Only the
            chat the user is looking at takes focus. */}
        {!isEditingQueued && sessionChatTarget && tab?.failedFirstSend ? (
          <FirstSendFailedSlot
            target={sessionChatTarget}
            failure={tab.failedFirstSend}
            active={composerShortcutsEnabled && hostVisible}
          />
        ) : null}
        {slashCommandTarget &&
        !isCoworkChatTarget(slashCommandTarget.projectId) &&
        tabId ? (
          <LifetimeLimitNotice
            projectId={slashCommandTarget.projectId}
            worktreeId={slashCommandTarget.worktreeId}
            placement="chat"
            chatId={tabId}
          />
        ) : null}
        {/* Resource-guard warning (chat send blocked by memory pressure or concurrency cap) */}
        {!isEditingQueued && resourceGuardMessage && (
          <Notice
            intent="attention"
            title="Sending paused"
            data-testid="chat-input-resource-guard-warning"
            actions={
              <NoticeButton
                variant="secondary"
                onClick={(): void => openSettings('performance')}
                data-testid="chat-input-resource-guard-settings-link"
              >
                Open performance settings
              </NoticeButton>
            }
          >
            {resourceGuardMessage}
          </Notice>
        )}

        {/* Completed turn that produced nothing (CAN-2307). Sits above the
              stuck-agent warning: this one describes a turn that is already
              over, so it names the state the user is actually in. */}
        {!isEditingQueued &&
          sessionChatTarget !== null &&
          emptyCompletionRecovery !== undefined && (
            <EmptyCompletionRecoveryNotice
              recovery={emptyCompletionRecovery}
              busy={emptyCompletionBusy}
              error={emptyCompletionError}
              onResume={(): void => {
                void dispatchEmptyCompletionRecovery('resume');
              }}
              onRetry={(): void => {
                void dispatchEmptyCompletionRecovery('retry');
              }}
            />
          )}

        {!isEditingQueued &&
          sessionChatTarget !== null &&
          effectiveProviderType === 'claude' &&
          tab?.status === 'error' &&
          isClaudeTurnLimitMessage(tab.error) && (
            <Notice
              intent="destructive"
              title="Claude turn limit reached"
              data-testid="claude-turn-limit-notice"
              {...(turnLimitResumeError
                ? { detail: turnLimitResumeError }
                : {})}
              actions={
                <>
                  <NoticeButton
                    variant="primary"
                    disabled={turnLimitResumeBusy}
                    onClick={(): void => {
                      void resumeTurnLimit();
                    }}
                    data-testid="claude-turn-limit-resume"
                  >
                    Resume
                  </NoticeButton>
                  <NoticeButton onClick={(): void => openSettings('claude')}>
                    Claude settings
                  </NoticeButton>
                </>
              }
            >
              Resume to continue where Claude left off.
            </Notice>
          )}

        {/* Resume a turn the app closed on, in place (CAN-5177). */}
        {showInterruptedTurnResume &&
          sessionChatTarget !== null &&
          interruptedTurnResumeUserMessageId !== undefined && (
            <InterruptedTurnResumeNotice
              {...(tab?.interruptedTurnResumePromptKind
                ? { promptKind: tab.interruptedTurnResumePromptKind }
                : {})}
              busy={interruptedTurnResumeSession?.phase === 'resuming'}
              {...(interruptedTurnResumeSession?.error
                ? { error: interruptedTurnResumeSession.error }
                : {})}
              onResume={(): void => {
                void resumeInterruptedTurn(
                  sessionChatTarget,
                  interruptedTurnResumeUserMessageId,
                  scopeCapabilities,
                );
              }}
              onDismiss={(): void => {
                dismissInterruptedTurnResume(
                  sessionChatTarget,
                  interruptedTurnResumeUserMessageId,
                );
              }}
            />
          )}

        {/* Explicit Resume for a turn the user stopped (CAN-3137). One resume
            offer at a time: the app-closed one above wins. */}
        {!isEditingQueued &&
          shouldShowStoppedTurnResume({
            stoppedUserMessageId: stoppedTurnResumeUserMessageId,
            interruptedUserMessageId: interruptedTurnResumeUserMessageId,
            interruptedSession: interruptedTurnResumeSession,
            interruptedNoticeVisible: showInterruptedTurnResume,
            usageLimitBannerVisible: usageLimitBanner !== null,
          }) &&
          sessionChatTarget !== null &&
          stoppedTurnResumeUserMessageId !== undefined && (
            <StoppedTurnResumeNotice
              {...(tab?.stoppedTurnResumeError
                ? { error: tab.stoppedTurnResumeError }
                : {})}
              onResume={(): void => {
                void resumeStoppedTurn(sessionChatTarget);
              }}
            />
          )}

        {/* Catching up: main is behind the agent, so a quiet transcript is
            not a stuck agent. It replaces the stuck warning and offers no
            action that touches the turn; Stop stays. */}
        {!isEditingQueued && catchingUpLag !== null && (
          <CatchingUpNotice lagMs={catchingUpLag.lagMs} />
        )}

        {/* Stuck agent warning */}
        {!isEditingQueued &&
          stuckMinutes !== null &&
          catchingUpLag === null && (
            <StuckAgentNotice
              key={tab?.id}
              minutes={stuckMinutes}
              onCheckStatus={handleCheckStatus}
            />
          )}

        {/* Shared, universal AI Credits usage-limit + routing-status banners.
            Driven by the target-keyed store (fed authoritatively by the main
            process), so they render on every chat surface. Existing-session
            scheduling and code-worktree-only actions are passed independently.
            The usage-limit notice yields to the routing-status card whenever
            that card shows, so the two never offer and confirm credits at
            once (CAN-4757). */}
        {!isEditingQueued && (
          <>
            <AiCreditsUsageLimitBanner
              target={bannerTarget}
              {...(billingResolution.framework !== null
                ? {
                    billsToAiCredits:
                      billingResolution.framework === 'ai-credits',
                  }
                : {})}
              aiCreditsCardVisible={billingResolution.aiCreditsBannerVisible}
              modelRoutability={creditsModelRoutability}
              {...(chatModelLabel !== undefined
                ? { modelLabel: chatModelLabel }
                : {})}
              {...(canOfferCreditsModelSwitch({
                model: modelForBilling,
                billingProvider,
                hasWorktreeTarget: worktreeChatTarget !== null,
                creditsModelRoutable: creditsTargetRoutable,
              })
                ? {
                    creditsModelLabel: getModelDisplayName(
                      DEFAULT_CREDITS_CODEX_MODEL,
                    ),
                    onContinueOnCreditsModel: handleContinueOnCreditsModel,
                  }
                : {})}
              {...(worktreeChatTarget
                ? { onUseJustThisTime: handleUseAiCreditsJustThisTime }
                : {})}
              {...(canUseCreditsForThisChat
                ? { onUseCreditsForThisChat: handleUseCreditsForThisChat }
                : {})}
              {...(sessionChatTarget !== null
                ? { onContinueAfterUsingCredits: handleContinueOnAiCredits }
                : {})}
              {...(canScheduleUsageLimitResume
                ? {
                    scheduleResume: {
                      onSchedule: (): void => {
                        void handleScheduleResume();
                      },
                      inFlight: scheduleResumeInFlight,
                      disabled: existingResumeAutomation !== undefined,
                      error: scheduleResumeError,
                      scheduledForLabel: formatUsageLimitTimeLabel(
                        existingResumeAutomation?.nextRunAt,
                      ),
                    },
                  }
                : {})}
            />
            <TransientRetryBanner target={bannerTarget} />
            <AiCreditsRoutingStatusBanner
              target={bannerTarget}
              model={modelForBilling}
              active={billingResolution.aiCreditsBannerVisible}
              turnActive={isStreaming}
              {...(billingProvider === 'claude' || billingProvider === 'codex'
                ? { provider: billingProvider }
                : {})}
              {...(handleSwitchToSubscription
                ? { onSwitchToSubscription: handleSwitchToSubscription }
                : {})}
              {...(billingAccountChangedAt !== undefined
                ? { accountChangedAt: billingAccountChangedAt }
                : {})}
              {...(billingResolution.aiCreditsBannerVisible &&
              interruptedTurnPending &&
              sessionChatTarget !== null
                ? {
                    continueInterruptedTurn: {
                      onContinue: handleContinueOnAiCredits,
                      busy: continueOnAiCreditsBusy,
                      error: continueOnAiCreditsError,
                    },
                  }
                : {})}
            />
            {subscriptionAvailabilityNoticeProvider ? (
              <SubscriptionAvailabilityNotice
                provider={subscriptionAvailabilityNoticeProvider}
                onDismiss={dismissSubscriptionAvailabilityNotice}
              />
            ) : null}
            {/* A confirmed advanced-model unlock, in the chat it started in
                (CAN-5027). Hidden, not dismissed, while a queued message is
                being edited. */}
            <ModelUnlockConfirmedBanner
              target={tab ? bannerTarget : null}
              model={model}
            />
            {/* An org gateway the member has no working key for. Reads its own
                state rather than the target-keyed store: nothing has failed at
                runtime yet — the point is to catch it BEFORE the first turn. */}
            <ModelGatewayKeyBanner
              selectedGatewayOrganizationId={selectedGatewayOrganizationId}
            />
            {scopeCapabilities.chatApprovalMode === true && (
              <ApprovalsUpgradeNotice />
            )}
            {/* An org whose trial ended stops funding its members the moment it
                lapses (CAN-2311). Names the specific org, and stays silent when
                a healthy org or a personal balance still covers the turn.

                Rendered BEFORE the generic no-billing-source banner because the
                two describe the same dead end for a member of a lapsed org (the
                lapse zeroes the org credit pool), with different next actions.
                The one that names the cause wins the composer while it is up;
                the generic self-serve remedies below take over as soon as it is
                dismissed or the org is restored. */}
            <OrgLapsedBanner
              provider={billingProvider}
              target={bannerTarget}
              nativeAuth={providerAvailability[billingProvider].nativeAuth}
              availabilityLoading={
                providerAvailability[billingProvider].loading
              }
              onVisibleChange={setOrgLapseVisible}
            />
            {/* Neither a native login nor spendable credits: nothing can pay for
                the next turn, and the raw provider `Please run /login` names only
                one of the two remedies. Surfaces both up front (ECW-9091). */}
            {/* `target` feeds the runtime path: a turn that already died on an
                empty credit balance shows the banner even when the derived
                pre-flight condition says the user is fine (CAN-2413).
                `gatewayOnlyModel` uses the same helper as the billing toggle's
                `lockKind: 'gateway-only-model'`, so the banner and the toggle
                never disagree about whether a native login is a remedy. */}
            <NoBillingSourceBanner
              provider={billingProvider}
              availability={providerAvailability[billingProvider]}
              orgLapseVisible={orgLapseVisible}
              target={bannerTarget}
              queuedCreditHeld={tab?.queuedCreditHeld}
              gatewayOnlyModel={isGatewayOnlyModel(modelForBilling)}
              effectiveBillingFramework={billingResolution.framework ?? null}
              noDispatchableModel={noDispatchableModel}
              turnActive={isStreaming}
              aiCreditsCardVisible={billingResolution.aiCreditsBannerVisible}
              aiCreditsCardExpected={aiCreditsCardExpected}
            />
          </>
        )}
        {/* An advanced-model purchase still finishing in the browser
            (CAN-5030). Beside the billing notices but outside their
            queued-edit guard: while the purchase is pending, this is the only
            cue that it is still being followed, so it never hides. */}
        <ModelUnlockPendingBanner chatId={tabId} />

        {/* Plan detection banner */}
        {!isEditingQueued && worktreeChatTarget && (
          <PlanDetectionBanner
            projectId={worktreeChatTarget.projectId}
            worktreeId={worktreeChatTarget.worktreeId}
            chatId={worktreeChatTarget.chatId}
          />
        )}

        {/* Suggests sharing a skill or plugin this chat keeps using, in the
              shared suggestion corner (renders nothing here). Session
              target so Cowork chats are covered too. */}
        {!isEditingQueued && sessionChatTarget && (
          <SkillShareNudgeBanner
            projectId={sessionChatTarget.projectId}
            worktreeId={sessionChatTarget.worktreeId}
            chatId={sessionChatTarget.chatId}
            streaming={isStreaming}
            isComposerVisible={isComposerVisible}
          />
        )}

        {/* A guest Try it chat whose capability needs an account. */}
        {!isEditingQueued && sessionChatTarget ? (
          <TryItSignInBanner
            target={sessionChatTarget}
            unresolvedCapabilities={
              effectivePluginSelections?.unresolvedCapabilities ?? []
            }
          />
        ) : null}

        {/* Offers to turn a request the user keeps repeating into a skill. */}
        {!isEditingQueued && sessionChatTarget && (
          <SkillSuggestionBannerHost
            projectId={sessionChatTarget.projectId}
            worktreeId={sessionChatTarget.worktreeId}
            chatId={sessionChatTarget.chatId}
            streaming={isStreaming}
            isComposerVisible={isComposerVisible}
          />
        )}

        {/* Recurring automations that target this chat. Session target, not
              the worktree target: Cowork and App Advisor chats schedule too. */}
        {!isEditingQueued && (
          <ScheduledAutomationsNotice target={sessionChatTarget} />
        )}

        {/* Mods of plugins this chat turned on that its next message won't
            load, from discovery for the provider the chat uses now. */}
        {!isEditingQueued &&
        claudeModsComposerContext &&
        tabDiscovery?.skippedMods &&
        tabDiscovery.providerType === discoveryProviderType ? (
          <ClaudeModsComposerNotice
            key={claudeModsComposerContext.chatId}
            context={claudeModsComposerContext}
            mods={tabDiscovery.skippedMods}
          />
        ) : null}
      </ComposerNoticeStack>

      {/* Docked tool-approval prompt(s) — replaces the previous in-transcript
          card mount. Renders above the composer for the active chat only;
          see `ToolApprovalDock.tsx` for the multi-approval navigation
          contract. */}
      {!isEditingQueued && bannerTarget && (
        <ToolApprovalDock
          projectId={bannerTarget.projectId}
          worktreeId={bannerTarget.worktreeId}
          chatId={bannerTarget.chatId}
          canTakeFocus={canApprovalTakeComposerFocus}
          focusComposer={focusComposerAfterApproval}
        />
      )}

      {beforeComposer}

      {/* Compact queue: the tip is a banner of its own, as wide as
          the drawer, and the drawer's tabs hold the queue and the chat's
          background work, one list open at a time. The queue stays while a
          queued message is open in the editor. */}
      {compactQueue && (
        <>
          {!isEditingQueued && (
            <ComposerNoticeStack>
              <PlanModeHint hint={hint} appearance="notice" />
              <GitHubStarPrompt
                prompt={starPrompt}
                appName={brandText.appName}
                starLogin={starLogin}
                appearance="notice"
              />
              <OnboardingTipSlot
                placement="composer"
                appearance="notice"
                eligible={worktreeChatTarget ? WORKTREE_CHAT_TIPS : NO_TIPS}
                arrivalKey={worktreeChatTarget?.chatId ?? ''}
                {...(worktreeChatTarget && worktreeTipTranscript
                  ? {
                      worktreeChat: {
                        chatId: worktreeChatTarget.chatId,
                        workspaceLocalId: worktreeChatTarget.projectId,
                        worktreeLocalId: worktreeChatTarget.worktreeId,
                        transcript: worktreeTipTranscript,
                      },
                    }
                  : {})}
                context={worktreeTipContext}
                data-testid="chat-input-onboarding-tip"
              />
            </ComposerNoticeStack>
          )}
          {!isEditingQueued && bannerTarget ? (
            <ChatBackgroundTray target={bannerTarget}>
              {(tray, counts, sections): JSX.Element => (
                <ComposerWorkDrawer
                  queuedCount={composerWorkDrawerLink?.queuedCount ?? 0}
                  queuedPanelRef={composerWorkDrawerLink?.queuedPanelRef}
                  background={{
                    count: counts.items,
                    needsYou: counts.needsYou,
                    running: counts.running,
                    panel: tray,
                    sections,
                    watching: counts.watching,
                    pullRequests: counts.pullRequests,
                  }}
                />
              )}
            </ChatBackgroundTray>
          ) : (
            <ComposerWorkDrawer
              queuedCount={composerWorkDrawerLink?.queuedCount ?? 0}
              queuedPanelRef={
                isEditingQueued
                  ? composerWorkDrawerLink?.queuedEditorPanelRef
                  : composerWorkDrawerLink?.queuedPanelRef
              }
            />
          )}
        </>
      )}

      {/* The composer's top drawer, under the notices and approvals: the
          tip (CAN-4904) first, then the chat's background work (D11). It
          draws nothing while neither shows. */}
      {!compactQueue && !isEditingQueued && (
        <ComposerDrawer edge="top" data-testid="chat-input-composer-drawer">
          <PlanModeHint hint={hint} />
          <GitHubStarPrompt
            prompt={starPrompt}
            appName={brandText.appName}
            starLogin={starLogin}
          />
          <OnboardingTipSlot
            placement="composer"
            eligible={worktreeChatTarget ? WORKTREE_CHAT_TIPS : NO_TIPS}
            arrivalKey={worktreeChatTarget?.chatId ?? ''}
            {...(worktreeChatTarget && worktreeTipTranscript
              ? {
                  worktreeChat: {
                    chatId: worktreeChatTarget.chatId,
                    workspaceLocalId: worktreeChatTarget.projectId,
                    worktreeLocalId: worktreeChatTarget.worktreeId,
                    transcript: worktreeTipTranscript,
                  },
                }
              : {})}
            context={worktreeTipContext}
            data-testid="chat-input-onboarding-tip"
          />
          {bannerTarget && <ChatBackgroundTray target={bannerTarget} />}
        </ComposerDrawer>
      )}

      <ChatComposerShell
        shellRef={dropContainerRef}
        layout={
          questionPromptOpen
            ? 'question'
            : planCardOpen
              ? 'plan-approval'
              : composerInline
                ? 'one-line'
                : 'full'
        }
        className={containerClasses}
        // Esc dismisses the `!` typeahead rather than stopping the turn.
        data-chat-cancel-shortcut-ignore={
          scriptTypeahead.open ? 'true' : undefined
        }
      >
        <span
          ref={composerMenu.anchorRef}
          aria-hidden
          className="pointer-events-none absolute inset-0"
        />
        {scriptTypeahead.enabled ? (
          <ScriptTypeaheadMenu
            typeahead={scriptTypeahead}
            anchorRef={composerMenu.anchorRef}
            boundaryRef={composerMenu.editorRef}
            composerRef={dropContainerRef}
            returnFocusRef={composerMenu.editorRef}
            dataTestIdPrefix="chat-input-scripts"
          />
        ) : null}
        {/* The chat area dims while files are dragged over it. */}
        {filesGuestGate.status === 'signed-in' &&
          fileDrop.dragging &&
          fileDrop.zone &&
          createPortal(<ChatDropOverlay />, fileDrop.zone)}
        <UnresolvedCapabilitySelection
          capabilities={effectivePluginSelections?.unresolvedCapabilities}
        />
        {/* Attachments lead the box, above the text: code selections first,
            then files, in one strip. */}
        {(pendingAttachments.length > 0 || pendingSelections.length > 0) && (
          <AttachmentPillCarousel
            leading={
              pendingSelections.length > 0 ? (
                <SelectionContextChips
                  selections={pendingSelections}
                  onReveal={handleRevealSelection}
                  onOpen={handleOpenSelection}
                  onRemove={handleRemoveSelection}
                  onFreshnessChange={handleSelectionFreshnessChange}
                />
              ) : undefined
            }
            attachments={pendingAttachments}
            onRemove={(absolutePath): void => {
              if (editingState) {
                editingState.onRemoveAttachment(absolutePath);
              } else {
                useChatStore
                  .getState()
                  .removePendingAttachment(absolutePath, targetOverride);
              }
            }}
          />
        )}

        {questionPromptOpen ? (
          <QuestionPrompt
            prompt={questionPrompt.prompt}
            busy={questionPrompt.busy}
            errorKind={questionPrompt.errorKind}
            disconnected={questionPrompt.disconnected}
            onRetry={questionPrompt.retry}
            onClose={closeQuestionPrompt}
            takeText={takeQuestionText}
          >
            {promptTextRow}
          </QuestionPrompt>
        ) : planCardOpen ? (
          <PlanApprovalPromptWithComments
            target={planCommentsTarget}
            options={planApprovalOptions}
            revised={planRevised}
            {...(trackedPlanId
              ? { onOpenPlan: (): void => void handleExplorePlan() }
              : {})}
            {...(pendingPlanCopy ? { planCopy: pendingPlanCopy } : {})}
            onClose={closePlanCard}
          >
            {promptTextRow}
          </PlanApprovalPromptWithComments>
        ) : (
          <>
            {composerEditor}
            {composerControls}
          </>
        )}
      </ChatComposerShell>

      {/* The queued-message editor edits text only and omits the row. */}
      {!isEditingQueued && (
        <ComposerStatusRow
          rowRef={statusRowRef}
          // The model and its effort lead the row and take its free width,
          // truncating as it narrows; the permission level and the usage
          // meter trail it at their own width.
          fill="start"
          start={
            <>
              <div
                // Nothing on the row collapses: the model name truncates as
                // the row narrows, its icon folding away at the first ellipsis.
                className="flex min-w-0 items-center"
                aria-busy={pendingModelChange !== undefined}
              >
                {webCoreModels !== undefined ? (
                  // A cloud chat lists its web core catalog in the shared
                  // picker the web's cloud chats use (CAN-6175 R5).
                  <PortalModelPicker
                    statusRow
                    catalog={webCoreModels}
                    {...(model === undefined ? {} : { currentModel: model })}
                    {...(webCoreLabel === undefined
                      ? {}
                      : { currentModelLabel: webCoreLabel })}
                    menuAlignRef={dropContainerRef}
                    triggerTooltip={null}
                    disabled={
                      isTerminalMode || tab?.firstSendPreparing === true
                    }
                    openSignal={modelPickerOpenSignal}
                    onSelect={(modelId): void => {
                      void setModelAndWait(modelId, targetOverride);
                    }}
                  />
                ) : (
                  <ModelPicker
                    browserLayout="harnesses"
                    currentModel={
                      pendingModelChange?.model ?? model ?? fallbackModel
                    }
                    executionHarness={draftExecutionHarness}
                    onModelChange={handleModelChange}
                    {...(inheritedDefaultModel
                      ? { inheritedDefaultModel }
                      : {})}
                    allowCursor={allowCursor}
                    allowCopilot={allowCursor}
                    allowOpenCode={allowCursor}
                    {...(tab?.id ? { recoveryChatKey: tab.id } : {})}
                    onRecoveryCommit={handleRecoveryCommit}
                    {...(creditsScope ? { aiCreditsScope: creditsScope } : {})}
                    lockedProvider={lockedProvider}
                    lockedHarness={lockedHarness}
                    executionHarnessExplicitlyChosen={
                      tab?.executionHarnessExplicitlyChosen
                    }
                    lockedProviderBehavior={
                      continueEligibility?.ok === true ? 'continue' : 'disabled'
                    }
                    {...(continueEligibility &&
                    continueEligibility.ok === false &&
                    continueEligibility.code !== 'not-continuable'
                      ? { lockedProviderReason: continueEligibility.reason }
                      : {})}
                    providerAvailability={providerAvailability}
                    {...(autoPickerOption ? { auto: autoPickerOption } : {})}
                    {...(canStartNewChatWithModel
                      ? { onStartNewChat: handleStartNewChatWithModel }
                      : {})}
                    {...(billingControl ? { billing: billingControl } : {})}
                    capsule
                    // The menu sits over the row, left-aligned to the box.
                    allowTriggerShrink
                    foldTriggerIconWhenTight
                    foldTriggerIconOnTruncate
                    hideTriggerChevron
                    menuAlignRef={dropContainerRef}
                    menuAlignEdge="left"
                    // The composer already makes the chip's job plain.
                    triggerTooltip={null}
                    disabled={
                      isTerminalMode || tab?.firstSendPreparing === true
                    }
                    openSignal={modelPickerOpenSignal}
                    onRestoreFocus={(): void => {
                      requestAnimationFrame(() => focusEditor(editor));
                    }}
                  />
                )}
              </div>
              {/* Tri-state contract: a model that declares an explicit empty
              supported set does not think at all, so the control is hidden
              entirely (matching the web composer's gating). An absent
              declaration already resolved to the provider fallback above. */}
              {effortVisible || cloudSpeedOnly ? (
                <ThinkingLevelPanelPicker
                  testId="chat-input-thinking-level-button"
                  // A cloud model may run fast mode without effort levels,
                  // as on the web (CAN-6322).
                  speedOnly={!effortVisible}
                  // Every level the model declares, None and Low included;
                  // a stored level it lacks shows as its nearest lower one.
                  value={
                    supportedThinkingLevels.includes(thinkingLevel)
                      ? thinkingLevel
                      : displayThinkingLevel
                  }
                  supportedLevels={supportedThinkingLevels}
                  includeLow
                  onChange={(next): void => {
                    if (next !== undefined) {
                      void setThinkingLevel(next, targetOverride);
                    }
                  }}
                  disabled={isTerminalMode}
                  allowTriggerShrink
                  hideTriggerChevron
                  // Opens over its own trigger, 8px left of its edge.
                  menuAlignEdge="left"
                  menuAlignOffset={-8}
                  // Fast mode rides in the effort panel, for models that
                  // offer it; Ultra fast is its third, purple state.
                  {...(supportsFastMode
                    ? {
                        fastMode: {
                          on: requestedSpeed !== 'standard',
                          ultra: requestedSpeed === 'ultrafast',
                          disabled: isTerminalMode,
                          onToggle: cycleSpeed,
                        },
                      }
                    : {})}
                />
              ) : null}
              {pendingTurnSettingsState ? (
                // The row's own gap is zero (each control pads itself), so
                // the cue carries its lead-in on a wrapper, never the badge.
                <span className="flex shrink-0 pl-2">
                  <PendingTurnSettingsHint pending={pendingTurnSettingsState} />
                </span>
              ) : null}
              {/* Multi-repo projects: the folder the chat runs in, beside
                  effort. Its name truncates with the model's as the row
                  narrows. */}
              {isMultiRepo && !hideDirectoryPicker ? (
                <DirectoryPicker
                  currentRepoId={selectedRepoId}
                  childRepos={childRepos}
                  disabled={hasStartedSession || readOnly || isTerminalMode}
                  sessionLocked={hasStartedSession}
                  statusRow
                  onSelect={setSelectedRepoId}
                />
              ) : null}
            </>
          }
          end={
            <ComposerAccessUsage
              access={
                scopeCapabilities.chatApprovalMode === true ? (
                  <ApprovalModePicker
                    mode={approvalMode}
                    onChange={handleApprovalModeChange}
                    disabled={isTerminalMode}
                    hideTriggerIcon
                    hideTriggerChevron
                    menuAlignRef={dropContainerRef}
                    menuAlignEdge="right"
                  />
                ) : null
              }
              usage={
                scopeCapabilities.chatContextUsage === true ? (
                  <UsageIndicator
                    usage={tabUsage}
                    isCodex={isCodex}
                    isCursor={effectiveProviderType === 'cursor'}
                    executionHarness={
                      lockedHarness ??
                      draftExecutionHarness ??
                      (effectiveProviderType === 'opencode'
                        ? 'opencode'
                        : undefined)
                    }
                    model={model}
                    {...(effectiveProviderType
                      ? { providerType: effectiveProviderType }
                      : {})}
                    aiCreditsRouted={aiCreditsRouted}
                    aiCreditsBilled={
                      billingResolution.framework === 'ai-credits'
                    }
                    subscriptionBillingOverride={
                      tab?.subscriptionBillingOverride === true
                    }
                    accountProxyRouted={tab?.accountProxyRouted}
                    alignRef={dropContainerRef}
                    {...(tab
                      ? {
                          creditTarget: {
                            ...(composerProjectId !== undefined
                              ? { projectId: composerProjectId }
                              : {}),
                            ...(composerWorktreeId !== undefined
                              ? { worktreeId: composerWorktreeId }
                              : {}),
                            chatId: tab.id,
                          },
                        }
                      : {})}
                    turnActive={isStreaming}
                    {...(tab?.modelConfig?.contextWindow !== undefined
                      ? { contextWindowSetting: tab.modelConfig.contextWindow }
                      : {})}
                    {...(composerProjectId && composerWorktreeId && tab
                      ? {
                          contextTarget: {
                            projectId: composerProjectId,
                            worktreeId: composerWorktreeId,
                            chatId: tab.id,
                          },
                        }
                      : {})}
                  />
                ) : null
              }
            />
          }
        />
      )}

      {scheduleModalOpen && showScheduleControls && (
        <ScheduleMessageModal
          initialRunAt={scheduledSendDraft?.runAt}
          onCancel={(): void => setScheduleModalOpen(false)}
          onSave={handleSaveSchedule}
          ownerDocument={getDocument(composerRootRef.current)}
        />
      )}

      {pluginsModalOpen && cloudPluginsTarget !== null && (
        <CloudChatPluginsPicker
          target={cloudPluginsTarget}
          onClose={(): void => setPluginsModalOpen(false)}
          returnFocusRef={plusTriggerRef}
        />
      )}

      {pluginsModalOpen && webCoreProjectId === undefined && (
        <ChatPluginsModal
          initial={
            pluginsModalInheritedLayers
              ? effectiveChatPluginSelections({
                  local: pluginSelections,
                  ...pluginsModalInheritedLayers,
                  chatTombstones: tabDisabledGlobalPluginSelections,
                })
              : (pluginSelections ?? {
                  collectionIds: [],
                  skillRefs: [],
                  pluginRefs: [],
                  mcpServerRefs: [],
                })
          }
          inheritedDefaults={
            pluginsModalInheritedLayers
              ? inheritedDefaultLayers(pluginsModalInheritedLayers)
              : undefined
          }
          onSave={async (
            selections: ChatTabPluginSelections,
            deferredToolsAllowed: boolean,
            appliedProjectDefaults?: ChatTabPluginSelections,
          ) => {
            const nextSelections = stripAgentOnlyChatPluginSelections(
              selections,
              agentPluginSelections,
              pluginSelections,
            );
            if (!watcherDestination) {
              throw new Error('Chat target is unavailable');
            }
            // The modal displayed the effective set (local ∪ surviving
            // inherited defaults) computed from the layers frozen at modal
            // open. Split the chosen set back into tab-local selections and
            // tombstones against that same snapshot: unchecked inherited
            // entries become durable chat-level rejections, entries the tab
            // already owned locally stay local, and tombstones derive from
            // the pre-strip chosen set so agent-locked stripping cannot
            // reject a default the user left checked.
            const currentChatTab = useChatStore
              .getState()
              .worktreeChats[
                `${watcherDestination.projectId}/${watcherDestination.worktreeId}`
              ]?.tabs.find((candidate) => candidate.id === watcherDestination.chatId);
            // A recommendation applied in the modal replaced the project
            // layer; its new defaults are inherited, not the chat's own.
            const inheritedLayers =
              pluginsModalInheritedLayers && appliedProjectDefaults
                ? {
                    ...pluginsModalInheritedLayers,
                    projectDefaults: appliedProjectDefaults,
                  }
                : (pluginsModalInheritedLayers ?? {});
            const { localSelections } = splitChosenChatPluginSelections({
              chosen: nextSelections,
              ...inheritedLayers,
              previousLocal: pluginSelections,
              previousTombstones: tabDisabledGlobalPluginSelections,
            });
            const { tombstones } = splitChosenChatPluginSelections({
              chosen: selections,
              ...inheritedLayers,
              previousTombstones: tabDisabledGlobalPluginSelections,
            });
            const before =
              currentChatTab?.pluginSelections ?? createEmptySelections();
            const removed = subtractPluginSelections(before, localSelections);
            const added = subtractPluginSelections(localSelections, before);
            await queueDesktopTryItSelectionUpdate(
              watcherDestination,
              async () => {
                const liveTab = useChatStore
                  .getState()
                  .worktreeChats[
                    `${watcherDestination.projectId}/${watcherDestination.worktreeId}`
                  ]?.tabs.find((candidate) => candidate.id === watcherDestination.chatId);
                if (
                  !liveTab ||
                  liveTab.readOnly ||
                  liveTab.pendingInitialCreation
                )
                  throw new Error('Chat target is unavailable');
                // Apply only this picker's intent after any pending authorization;
                // its older snapshot must not remove the newly resolved capability.
                const pluginSelections = unionPluginSelections(
                  subtractPluginSelections(
                    liveTab.pluginSelections ?? createEmptySelections(),
                    removed,
                  ),
                  added,
                );
                const response = await window.api.chat.updatePlugins({
                  ...watcherDestination,
                  pluginSelections,
                  ...(pluginsModalInheritedLayers
                    ? { disabledGlobalPluginSelections: tombstones }
                    : {}),
                  deferredToolsAllowed,
                  materializeCodexThread: shouldMaterializeCodexThread({
                    providerType: effectiveProviderType,
                    executionHarness:
                      liveTab.executionHarness ?? thinkingHarness,
                    sdkSessionId: liveTab.sdkSessionId,
                  }),
                  expectedCurrentThreadId: liveTab.sdkSessionId,
                  ...(selectedRepoId ? { selectedRepoId } : {}),
                });
                setPluginSelections(
                  response.pluginSelections,
                  watcherDestination,
                  response.deferredToolsAllowed,
                  {
                    runtimeAlreadyUpdated: true,
                    ...(pluginsModalInheritedLayers
                      ? {
                          disabledGlobalPluginSelections:
                            response.disabledGlobalPluginSelections ??
                            tombstones,
                        }
                      : {}),
                    ...(response.sdkSessionId
                      ? { sdkSessionId: response.sdkSessionId }
                      : {}),
                  },
                );
                setPluginsModalOpen(false);
              },
            );
          }}
          onClose={() => setPluginsModalOpen(false)}
          projectId={
            selectedWorktree && !isCoworkChatTarget(selectedWorktree.projectId)
              ? selectedWorktree.projectId
              : undefined
          }
          worktreeId={
            selectedWorktree && !isCoworkChatTarget(selectedWorktree.projectId)
              ? selectedWorktree.worktreeId
              : undefined
          }
          repoId={selectedRepoId ?? undefined}
          effectiveProviderType={effectiveProviderType}
          lockedSkillRefs={lockedSkillRefs}
          lockedSelections={agentPluginSelections}
          // Managed account turns cannot reload their CLI mid-turn, so the
          // deferred-tools setting has no effect there.
          showDeferredToolsToggle={
            !isAccountHarness ||
            effectiveProviderType === 'copilot' ||
            effectiveProviderType === 'opencode'
          }
          deferredToolsAllowed={tab?.deferredToolsAllowed !== false}
          ownerDocument={getDocument(composerRootRef.current)}
        />
      )}

      {linearPickerOpen && (
        <Suspense fallback={null}>
          <LinearTicketPickerModal
            onSelect={(ticket): void => void handleSelectLinearTicket(ticket)}
            onClose={() => setLinearPickerOpen(false)}
            ownerDocument={getDocument(composerRootRef.current)}
          />
        </Suspense>
      )}

      {pipelineModalOpen && planPipelineAllowed && pendingExit && (
        <PlanReadyPipelineModal
          projectId={pendingExit.projectId}
          worktreeId={pendingExit.worktreeId}
          onClose={() => {
            setPipelineModalOpen(false);
            setPipelineRunError(null);
            planPipelineWatcher.reset();
          }}
          onRun={handlePipelineRun}
          isRunning={pipelineRunning}
          runError={pipelineRunError}
          watcherRecipientGroups={planPipelineWatcher.recipientGroups}
          onWatcherSelectionChange={
            planPipelineWatcher.onWatcherSelectionChange
          }
          ownerDocument={getDocument(composerRootRef.current)}
        />
      )}

      {/* Cross-harness continue confirmation. Hosted here rather than inside
          ModelPicker because the picker is shared with pipelines, hooks,
          automations, the Agent base-model modal and the Home composer, none of
          which have a chat to continue. Opened in the composer's own document
          so a popped-out composer shows it, and takes its Escape, there.

          The copy names the MODEL and nothing else. "Claude", "Codex" and
          "harness" are internal vocabulary; the model the user just clicked is
          the only name they have any reason to recognize, so the dialog is
          written entirely in terms of it. Keep provider labels out of here. */}
      {continueTargetModel !== undefined &&
        continueTargetProvider !== undefined &&
        lockedProvider !== undefined && (
          <ConfirmDialog
            dataTestId="continue-on-provider-dialog"
            confirmTestId="continue-on-provider-confirm"
            title={`Start a new chat with ${getModelDisplayName(continueTargetModel)}?`}
            message={
              <span className="flex flex-col gap-2">
                <span>
                  {`This chat isn't compatible with ${getModelDisplayName(continueTargetModel)}, so ${brandText.appName} will start a new chat with it and bring over a summary of what you've done so far.`}
                </span>
                <span>
                  Your files aren't changed, and this chat stays open.
                </span>
              </span>
            }
            confirmLabel="Start new chat"
            busy={continueBusy}
            busyLabel="Setting up…"
            errorMessage={continueError}
            onConfirm={handleConfirmContinue}
            onCancel={closeContinueDialog}
            ownerDocument={getDocument(composerRootRef.current)}
          />
        )}
    </div>
  );
}
