import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import {
  inlineFailure,
  inlineFailureText,
  type InlineFailure,
} from '@/lib/inline-app-error';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { Button } from '@canopy/ui-shared/components/Button';
import { Heading, Surface } from '@canopy/ui-shared/components';
import { getPlanModeHintStore } from '@/lib/planModeHint';
import { getGitHubStarPromptStore } from '@/lib/githubStarPrompt';
import { ComposerTipArbiterProvider, Chip } from '@canopy/ui-shared/components';
import {
  isPlanModeReadOnly,
  isGenuinePlanModeUse,
} from '@canopy/ui-shared/lib/plan-mode-suggestion';
import { notifyHomeTaskSent } from '../onboarding-tips/homeSendEvents';
import { HomeWorkspaceReadiness } from './HomeWorkspaceReadiness';
import { useDesktopFilesGuestGate } from '@/hooks/useDesktopFilesGuestGate';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { useComposerMenu } from '@/hooks/useComposerMenu';
import {
  buildComposerCommands,
  getComposerAction,
} from '@/lib/composerCommands';
import {
  requestComposerAction,
  requestModelPickerOpen,
  requestWorkspacePickerOpen,
} from '@/lib/composerShortcutRequests';
import {
  useCallback,
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { Descendant } from 'slate';
import { Transforms } from 'slate';
import { useShallow } from 'zustand/shallow';
import { useNavigationMode } from '@/stores/navigationModeStore';
import {
  buildEditorValueFromMessage,
  createChatEditor,
  createEmptyValue,
  focusEditor,
  resetEditor,
  serializeEditorValue,
} from '@canopy/ui-rich/editor';
import {
  DraftComposerEditor,
  PlanModeHint,
  composerDraftContentEquals,
  useComposerDraftRestoration,
  type ComposerDraftSnapshot,
  type PlanModeSuggestion,
} from '@canopy/ui-app';
import {
  COWORK_HOME_WORKTREE_ID,
  hasAnySelections,
  type SlashCommandData,
} from '@canopy/desktop-shared/types';
import {
  CloseMediumIcon,
  ScheduleIcon,
  ChevronDownMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  ComposerDrawer,
  ComposerHeroFrame,
  FirstSendFailedNotice,
  ModelUnavailableNotice,
  Notice,
  NoticeButton,
  Tooltip,
} from '@canopy/ui-shared/components';
import { defaultChatPlaceholder } from '@canopy/ui-shared/lib';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSelectedOrgWithoutPlan } from '@/hooks/useSelectedOrgWithoutPlan';
import {
  askOwnerToChoosePlanCopy,
  CHOOSE_ORG_PLAN_COPY,
  CHOOSE_ORG_PLAN_LABEL,
  openOrganizationBillingPage,
  orgWithoutPlanTitle,
} from '@/lib/organizationPlan';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  getHomeScope,
  resolveHomeContextRebind,
  shouldAttemptHomeSeed,
  shouldRebindHomeToContext,
  shouldShowHomeWorkspacePicker,
  useHomeScope,
  useKeepHomeSelectionInScope,
  type HomeContextRebind,
} from './homeScope';
import {
  useNavigationStore,
  type NavigationPage,
} from '@/stores/navigationStore';
import { useStartupResumeStore } from '@/stores/startupResumeStore';
import {
  isHomeAttachmentImportCurrent,
  isHomeSendEnabled,
  resolveHomeAttachmentWorktreeId,
  useHomeComposerStore,
  resolveHomeEffectiveProviderType,
  defaultNewWorktreeBaseTarget,
  homeNewWorktreeBaseTargetsEqual,
  homeWorktreeBaseMissing,
  MISSING_HOME_WORKTREE_BASE_MESSAGE,
  isGitHubConnectResumeFresh,
  currentMissingFolderRecovery,
} from '@/stores/homeComposerStore';
import { readRemoteControlContext } from '@/stores/remoteControlStore';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  HOME_COMPOSER_KEY,
  markSuggestedPromptInserted,
} from '@/lib/chatMessageSendTelemetry';
import { trackHomeChatSend } from './homeSendTelemetry';
import { snapshotHomeTask } from '@/lib/repeat-task-automation/draft';
import { maybeOfferRepeatTaskAutomation } from '@/lib/repeat-task-automation/offer';
import {
  createClipboardAttachments,
  importChatAttachments,
} from '@/lib/chatAttachments';
import {
  EMPTY_ATTACHMENT_ITEMS,
  EMPTY_NOTE_ITEMS,
  EMPTY_PROMPT_ITEMS,
  searchWorkspaceItemMentions,
  searchFileMentions,
  type WorkspaceItemMentionSources,
} from '@/lib/fileMentionSearch';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import { useHomeSlashCommands } from '@/hooks/useHomeSlashCommands';
import { getSlashCommandInsertText } from '@/hooks/useSlashCommands';
import {
  INVENTORY_ENABLE_ERROR_COPY,
  inventoryRowNeedsResolution,
} from '@/lib/slashInvocableInventory';
import { useTaskReadyPipelineLauncher } from '@/components/worktree/useTaskReadyPipelineLauncher';
import { TaskReadyPipelineModal } from '@/components/worktree/TaskReadyPipelineModal';
import { useWatcherRecipientGroups } from '@/components/watchers/useWatcherRecipientGroups';
import { useCanopyDesktopSuggestedPromptsEnabled } from '@/hooks/useCanopyDesktopSuggestedPromptsEnabled';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { DirectoryPicker } from '@/components/chat/DirectoryPicker';
import { SuggestedPromptChips } from '@/components/suggestions/SuggestedPromptChips';
import { useSuggestedPrompts } from '@/components/suggestions/useSuggestedPrompts';
import type { SuggestedPrompt } from '@/components/suggestions/mcpPromptIndex';
import { HomeBelowComposerGallery } from './HomeBelowComposerGallery';
import { HomeContinueSection } from './HomeContinueSection';
import { isHomeBelowComposerGalleryEnabled } from './home-below-composer-gallery-flag';
import { ModelGatewayKeyBanner } from '@/components/chat/ModelGatewayKeyBanner';
import { resolveOrgGatewayOrganizationId } from '@canopy/execution-engine/lib/gateway-model-availability';
import { useHomeEffectiveModelSettings } from './useHomeEffectiveModelSettings';
import { HomeWorkspacePicker } from './HomeWorkspacePicker';
import { HomeBranchPicker } from './HomeBranchPicker';
import { HomeBaseBranchPicker } from './HomeBaseBranchPicker';
import { HomeComposerControls } from './HomeComposerControls';
import { useUnbillableModelSwitch } from '@/lib/unbillableModel';
import { HomeComposerContextRow } from './HomeComposerContextRow';
import { HomeLinkTargetChip } from './HomeLinkTargetChip';
import { useHomeLinkTargetSync } from './homeLinkTargetSync';
import { useHomeLinkProjectPreview } from './homeLinkProjectPreview';
import { HomeMcpSignInStrip } from './HomeMcpSignInStrip';
import {
  buildPipelineTaskText,
  dispatchHomeSend,
  resolveTaskReadyLaunchTarget,
} from './homeSend';
import {
  homeHeadingComposerGap,
  homeWorkspaceSelectedState,
} from './homeGating';
import { useHomeHeading } from './useHomeHeading';
import { useHomeComposerAutofocus } from './useHomeComposerAutofocus';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';

export interface HomeSurfaceProps {
  /**
   * Distinguishes the standalone `HomePage` mount (`'page'`) from the
   * embedded mounts inside `WorktreePart`'s null-worktree state and
   * `WorktreeManager`'s empty-code-workspace state (`'embedded'`). This no
   * longer changes what renders — heading and background are identical for
   * both — it only sets `data-variant` so Electron specs and future
   * per-host analytics can tell the two mount sites apart.
   */
  variant: 'page' | 'embedded';
}

// The Home composer store is renderer-global and survives this surface
// unmounting, so it is the draft of record: every mounted editor is seeded
// from it and re-synced from it when shown (CAN-3794). Keep draft ownership
// alongside it so a remount can tell whether persisted text belongs to the
// newly selected context.
let homeComposerDraftContextKey: string | null = null;

function homeComposerContextKey(
  scopingContext: ReturnType<typeof useSidebarScopingContext>,
): string | null {
  if (scopingContext === undefined) return null;
  return scopingContext.kind === 'personal'
    ? 'personal'
    : `org:${scopingContext.organizationId}`;
}

function readHomeComposerDraft(): ComposerDraftSnapshot {
  const { text, fileReferences } = useHomeComposerStore.getState();
  return { text, fileReferences };
}

/**
 * The editor value a newly mounted surface starts from. A draft another
 * Personal/organization context owns starts empty instead: the context rebind
 * effect decides whether to clear it, and seeding it first would flash the
 * other context's text.
 */
function initialHomeComposerEditorValue(
  scopingContext: ReturnType<typeof useSidebarScopingContext>,
): Descendant[] {
  const contextKey = homeComposerContextKey(scopingContext);
  const draft = readHomeComposerDraft();
  const ownedElsewhere =
    draft.text.length > 0 &&
    contextKey !== null &&
    homeComposerDraftContextKey !== null &&
    homeComposerDraftContextKey !== contextKey;
  return ownedElsewhere
    ? createEmptyValue()
    : buildEditorValueFromMessage(draft.text, draft.fileReferences);
}
function readHomeComposerWorkspaceId(): string | null {
  return useHomeComposerStore.getState().workspaceId;
}

/**
 * Chat-centric Home surface: a draft composer backed entirely by
 * `homeComposerStore` (workspace picker, branch picker, mode pill, editor,
 * chat controls). This is the single component behind the standalone Home
 * page AND every "no worktree selected" / "no code project" fallthrough
 * empty state, keeping every host visually consistent.
 *
 * Send routes through `dispatchHomeSend` (chat mode) or
 * `useTaskReadyPipelineLauncher` (pipeline mode, mirroring the Create Task
 * modal's `task_ready` pipeline picker flow).
 */
export function HomeSurface(props: HomeSurfaceProps): JSX.Element {
  return (
    <ComposerTipArbiterProvider>
      <HomeSurfaceContent {...props} />
    </ComposerTipArbiterProvider>
  );
}

function HomeSurfaceContent({ variant }: HomeSurfaceProps): JSX.Element {
  const composerId = useId();
  const composerActionScope = useMemo(
    () => ({ scope: 'home' as const, composerId }),
    [composerId],
  );
  const [workspaceCommandOpenSignal, setWorkspaceCommandOpenSignal] =
    useState(0);
  const projects = useProjectsStore((s) => s.projects);
  const scopingContext = useSidebarScopingContext();
  const homeScope = useHomeScope();
  // `composerDisabled` (any-workspace): the composer only locks when there is
  // no selectable send target at all — a cowork-only fresh install must still
  // get a fully functional composer targeting the cowork workspace. An
  // organization with no active plan has none either: its projects and Chats
  // need the plan, and a send there fails closed rather than using Personal.
  const orgWithoutPlan = useSelectedOrgWithoutPlan();
  const composerDisabled =
    homeScope.fallbackWorkspaceId === null || orgWithoutPlan !== null;
  // Typing never waits for a send target: projects load empty and the default
  // Cowork workspace lands shortly after, so locking the editor until then
  // drops what the user types right after launch. Sending still waits.
  const editorLocked = orgWithoutPlan !== null;
  const setWorkspaceContext = useWorkspaceContextStore(
    (state) => state.setContext,
  );
  // Back to Personal failed; shown beside the notice that offered it.
  const [personalSwitchError, setPersonalSwitchError] =
    useState<InlineFailure | null>(null);
  const switchToPersonal = (): void => {
    setPersonalSwitchError(null);
    void setWorkspaceContext({ kind: 'personal' }).catch((error: unknown) => {
      const appError = toAppError(resolveClientAppError(error));
      if (!appError) return;
      setPersonalSwitchError(
        inlineFailure(appError, 'Couldn’t switch to Personal.'),
      );
    });
  };

  const belowComposerGallery =
    variant === 'page' && isHomeBelowComposerGalleryEnabled();

  const pipelineLauncher = useTaskReadyPipelineLauncher();
  // App Advisor chats are the only watcher recipients offered here (mirrors
  // the pre-B6 `WorktreeManager` task-pipeline launcher, which passed no
  // worktree group). The watcher selection is only consumed by the DEFERRED
  // `new-worktree`/`branch` run path; the immediate-execute `worktree`/`cowork`
  // paths intentionally remain watcher-less (Task C4) since they run against an
  // already-resolved cwd with no pending-execution enqueue to attach a watcher
  // destination to.
  const taskWatcherGroups = useWatcherRecipientGroups();

  const {
    workspaceId,
    mode,
    model,
    thinkingLevel,
    isSending,
    sendError,
    sendErrorRetryable,
    sendErrorChooseModel,
    missingFolderRecovery,
    scheduledSendDraft,
    branchTarget,
    newWorktreeBaseTarget,
    selectedRepoId,
    attachments,
    fileReferences,
    draftGeneration,
    pluginSelections,
    discoveryLoading,
    fileIndex,
    fileIndexLoading,
    linkTargetVisible,
    selectWorkspace,
    setSelectedRepoId,
    setDraft,
    setScheduledSendDraft,
    setSendError,
    loadFileIndex,
  } = useHomeComposerStore(
    useShallow((s) => ({
      workspaceId: s.workspaceId,
      mode: s.mode,
      model: s.model,
      thinkingLevel: s.thinkingLevel,
      isSending: s.isSending,
      sendError: s.sendError,
      sendErrorRetryable: s.sendErrorRetryable,
      sendErrorChooseModel: s.sendErrorChooseModel,
      missingFolderRecovery: currentMissingFolderRecovery(s),
      scheduledSendDraft: s.scheduledSendDraft,
      branchTarget: s.branchTarget,
      newWorktreeBaseTarget: s.newWorktreeBaseTarget,
      selectedRepoId: s.selectedRepoId,
      attachments: s.attachments,
      fileReferences: s.fileReferences,
      draftGeneration: s.draftGeneration,
      pluginSelections: s.pluginSelections,
      discoveryLoading: s.discoveryLoading,
      fileIndex: s.fileIndex,
      fileIndexLoading: s.fileIndexLoading,
      linkTargetVisible:
        s.mode === 'chat' &&
        s.linkTarget.status !== 'idle' &&
        s.linkTarget.status !== 'inactive',
      selectWorkspace: s.selectWorkspace,
      setSelectedRepoId: s.setSelectedRepoId,
      setDraft: s.setDraft,
      setScheduledSendDraft: s.setScheduledSendDraft,
      setSendError: s.setSendError,
      loadFileIndex: s.loadFileIndex,
    })),
  );

  // CAN-6019: Locate folder's progress, for the missing-folder notice it was
  // pressed on. Any other notice ignores it.
  const [locateFolder, setLocateFolder] = useState<{
    failure: InlineFailure;
    status: 'opening' | 'failed';
  } | null>(null);
  const locateFolderStatus =
    missingFolderRecovery &&
    locateFolder?.failure === missingFolderRecovery.failure
      ? locateFolder.status
      : null;
  // Like Show in Finder, reveal is blocked while controlling another computer.
  const canLocateFolder =
    readRemoteControlContext().mode !== 'remote' &&
    typeof window.api.chatProject.revealFolderLocation === 'function';
  const locateMissingFolder = (): void => {
    if (!missingFolderRecovery) return;
    const { failure, projectId } = missingFolderRecovery;
    setLocateFolder({ failure, status: 'opening' });
    // Reveals the folder, or its nearest existing parent; the notice and
    // draft stay either way, so the person can send again once it's back.
    window.api.chatProject.revealFolderLocation({ projectId }).then(
      () => {
        setLocateFolder((current) =>
          current?.failure === failure ? null : current,
        );
      },
      () => {
        setLocateFolder((current) =>
          current?.failure === failure
            ? { failure, status: 'failed' }
            : current,
        );
      },
    );
  };

  // CAN-3606: a link in a chat draft previews its worktree destination.
  useHomeLinkTargetSync();

  // The model a send from here would actually run, resolved exactly the way
  // the composer's own toolbar resolves it, so the gateway-key banner and the
  // model picker can never disagree about which route is selected.
  const effectiveSettings = useHomeEffectiveModelSettings(
    workspaceId,
    model,
    thinkingLevel,
  );
  const selectedGatewayOrganizationId = resolveOrgGatewayOrganizationId(
    effectiveSettings.model,
  );
  // CAN-6444 — the chip's model can't run for this account; offer the user's
  // own gateway model before they press send.
  const unbillableModelSwitch = useUnbillableModelSwitch(
    effectiveSettings.model,
  );

  // Seed the default workspace from the MRU preference (falling back to the
  // first project) while no workspace is selected. Both stay inside the
  // selected Personal/organization context; a switch that leaves the
  // selection in another context re-targets it.
  //
  // One attempt per project count: an attempt that ran before the projects
  // store loaded found nothing to select, so it retries once they arrive
  // rather than leaving Home on "Choose project" with Send disabled.
  const [seedAttemptProjectCount, setSeedAttemptProjectCount] = useState<
    number | null
  >(null);
  const projectCount = projects.length;
  useEffect(() => {
    if (
      !shouldAttemptHomeSeed(workspaceId, seedAttemptProjectCount, projectCount)
    ) {
      return;
    }
    setSeedAttemptProjectCount(projectCount);

    void (async (): Promise<void> => {
      let mruWorkspaceId: string | null = null;
      try {
        const preferences = await window.api.loadPreferences();
        mruWorkspaceId = preferences.lastActiveContext?.workspaceId ?? null;
      } catch (error) {
        // Without preferences the seed falls back to the first workspace.
        reportClientAppError(error);
        mruWorkspaceId = null;
      }

      // Re-read live state instead of the closed-over `projects`/`workspaceId`
      // in case something else already selected a workspace while awaiting.
      if (useHomeComposerStore.getState().workspaceId !== null) {
        return;
      }
      const scope = getHomeScope();
      const mruStillExists =
        mruWorkspaceId !== null &&
        scope.projects.some((project) => project.id === mruWorkspaceId);
      const seededWorkspaceId = mruStillExists
        ? mruWorkspaceId
        : scope.fallbackWorkspaceId;

      if (seededWorkspaceId !== null) {
        selectWorkspace(seededWorkspaceId);
      }
    })();
  }, [seedAttemptProjectCount, projectCount, workspaceId, selectWorkspace]);

  const editor = useMemo(() => createChatEditor(), []);
  // MainPage keeps an embedded instance mounted (hidden) under other pages;
  // only the instance on the active page is visible to the user.
  const activePage = useNavigationStore((s) => s.activePage);
  function isSurfaceVisible(page: NavigationPage): boolean {
    return variant === 'page'
      ? page === 'home'
      : page === 'main' || page === 'kanban';
  }
  const surfaceVisible = isSurfaceVisible(activePage);
  useEffect(() => {
    if (!surfaceVisible || !workspaceId) return;
    // A first commit often happens outside this window. Refresh the advisory
    // warning on return and on Git updates, without polling committed repos.
    const refreshUnbornSource = (): void => {
      const state = useHomeComposerStore.getState();
      if (
        state.workspaceId === workspaceId &&
        state.branchTargets?.headUnborn === true &&
        state.branchTargetsStatus !== 'loading' &&
        !state.isSending
      )
        void state.loadBranchTargets();
    };
    const stopBranch = window.api.onWorktreeBranchChanged((event) => {
      if (event.projectId === workspaceId) refreshUnbornSource();
    });
    const stopReady = window.api.onWorktreeGitReady((event) => {
      if (event.projectId === workspaceId) refreshUnbornSource();
    });
    window.addEventListener('focus', refreshUnbornSource);
    return (): void => {
      stopBranch();
      stopReady();
      window.removeEventListener('focus', refreshUnbornSource);
    };
  }, [surfaceVisible, workspaceId]);
  const [editorValue, setEditorValue] = useState<Descendant[]>(() =>
    initialHomeComposerEditorValue(scopingContext),
  );
  // The draft a restoration just wrote into the editor. Slate echoes that
  // write through `onChange`; the echo is not a user edit, so it must neither
  // republish the draft nor reassign its context ownership.
  const restoredDraftRef = useRef<ComposerDraftSnapshot | null>(null);
  const accountEpoch = useWorkspaceContextStore((state) => state.accountEpoch);
  const previousAccountEpochRef = useRef(accountEpoch);
  const previousContextKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (previousAccountEpochRef.current !== accountEpoch) {
      previousAccountEpochRef.current = accountEpoch;
      resetEditor(editor);
      setEditorValue(createEmptyValue());
      homeComposerDraftContextKey = null;
    }
    if (scopingContext === undefined) {
      previousContextKeyRef.current = null;
      return;
    }
    const contextKey =
      scopingContext.kind === 'personal'
        ? 'personal'
        : `org:${scopingContext.organizationId}`;
    const previousContextKey = previousContextKeyRef.current;
    previousContextKeyRef.current = contextKey;
    const composerState = useHomeComposerStore.getState();
    if (composerState.linkContextSwitchPending) {
      homeComposerDraftContextKey = contextKey;
      return;
    }
    // Another mounted Home may have already rebound and cleared the store.
    // Each editor must still discard its own prior-context content before
    // restoration; that local clear must not publish over the current owner.
    if (previousContextKey !== null && previousContextKey !== contextKey) {
      const localDraft = serializeEditorValue(editor.children);
      if (localDraft.text.length > 0 || localDraft.fileReferences.length > 0) {
        restoredDraftRef.current = { text: '', fileReferences: [] };
        resetEditor(editor);
        setEditorValue(createEmptyValue());
      }
    }
    const currentWorkspaceId = composerState.workspaceId;
    const currentStillVisible =
      currentWorkspaceId !== null && homeScope.isInScope(currentWorkspaceId);
    const enteredOrganizationWithPersonalSelection =
      previousContextKey === 'personal' &&
      scopingContext.kind === 'organization' &&
      projects.some(
        (project) =>
          project.id === currentWorkspaceId && project.owner === undefined,
      );
    const draftBelongsToOtherContext =
      composerState.text.length > 0 &&
      homeComposerDraftContextKey !== null &&
      homeComposerDraftContextKey !== contextKey;
    if (
      !shouldRebindHomeToContext({
        previousContextKey,
        contextKey,
        workspaceId: currentWorkspaceId,
        stillVisible: currentStillVisible,
        enteredOrganizationWithPersonalSelection,
        hasDraft: composerState.text.length > 0,
        draftBelongsToOtherContext,
      })
    )
      return;

    const rebind = resolveHomeContextRebind(homeScope);
    selectWorkspace(rebind.workspaceId);
    resetEditor(editor);
    setEditorValue(createEmptyValue());
    setDraft({ text: '', fileReferences: [] });
    homeComposerDraftContextKey = null;
  }, [
    accountEpoch,
    editor,
    homeScope,
    projects,
    scopingContext,
    selectWorkspace,
    setDraft,
  ]);

  // Run the context-change effect before the scope fallback. The fallback
  // reads the live selection so it leaves the project that effect just chose
  // in the same commit alone.
  const rebindOutOfScopeSelection = useCallback(
    (rebind: HomeContextRebind): void => {
      if (useHomeComposerStore.getState().linkContextSwitchPending) return;
      selectWorkspace(rebind.workspaceId);
    },
    [selectWorkspace],
  );
  useKeepHomeSelectionInScope(
    workspaceId,
    rebindOutOfScopeSelection,
    readHomeComposerWorkspaceId,
  );

  function handleEditorChange(value: Descendant[]): void {
    setEditorValue(value);
    const serialized = serializeEditorValue(value);
    const restoredDraft = restoredDraftRef.current;
    restoredDraftRef.current = null;
    if (
      restoredDraft !== null &&
      composerDraftContentEquals(serialized, restoredDraft)
    )
      return;
    if (composerDraftContentEquals(serialized, readHomeComposerDraft())) return;
    // A hidden, still-mounted surface (MainPage's embedded Home) cannot be
    // edited by the user; any change it reports is stale and must not
    // overwrite the draft the visible surface owns.
    if (!isSurfaceVisible(useNavigationStore.getState().activePage)) return;
    setDraft(serialized);
    homeComposerDraftContextKey =
      serialized.text.length === 0
        ? null
        : scopingContext?.kind === 'organization'
          ? `org:${scopingContext.organizationId}`
          : scopingContext?.kind === 'personal'
            ? 'personal'
            : null;
  }

  /**
   * Re-syncs local editor state (`editorValue` / the store's `text` and
   * `fileReferences`) after something mutated the Slate editor directly
   * rather than through `handleEditorChange` — voice dictation finalizing a
   * transcript or the shared composer menu inserting a command or file reference.
   */
  function handleEditorExternallyChanged(): void {
    if (!isSurfaceVisible(useNavigationStore.getState().activePage)) return;
    const value = structuredClone(editor.children);
    setEditorValue(value);
    const serialized = serializeEditorValue(value);
    setDraft(serialized);
    homeComposerDraftContextKey =
      serialized.text.length === 0
        ? null
        : scopingContext?.kind === 'organization'
          ? `org:${scopingContext.organizationId}`
          : scopingContext?.kind === 'personal'
            ? 'personal'
            : null;
    focusEditor(editor);
  }

  /**
   * Replaces the entire editor with `text` — used by the commands popup's
   * "insert command" flow, matching `ChatInput`'s `replaceEditorText`
   * behavior (the commands popup is a quick-trigger affordance, not an
   * append-at-cursor one).
   */
  const [hintDraftRevision, setHintDraftRevision] = useState(0);
  function handleInsertCommandText(text: string): void {
    setHintDraftRevision((revision) => revision + 1);
    resetEditor(editor);
    if (text) {
      Transforms.insertText(editor, text);
    }
    // `handleEditorExternallyChanged` already ends by focusing the editor,
    // which is what returns the caret after the commands popup closes.
    handleEditorExternallyChanged();
  }

  // Consume a staged starter prompt (CAN-2361 v2 "Try now" from the deep-link
  // landing when no worktree is selected). Replaces the draft deliberately —
  // the request is an explicit user action, same as picking a command.
  const pendingHomeComposerText = useNavigationStore(
    (s) => s.pendingHomeComposerText,
  );
  const consumedHomeComposerNonceRef = useRef(0);
  useLayoutEffect(() => {
    if (variant !== 'page' || !pendingHomeComposerText) return;
    if (consumedHomeComposerNonceRef.current === pendingHomeComposerText.nonce)
      return;
    consumedHomeComposerNonceRef.current = pendingHomeComposerText.nonce;
    handleInsertCommandText(pendingHomeComposerText.text);
    useNavigationStore.getState().consumeHomeComposerTextRequest();
    // handleInsertCommandText is a stable-by-usage plain function over refs
    // and the memoized editor; the nonce is the effect's real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, pendingHomeComposerText]);

  // MCP-aware suggested prompts (CAN-1809). The draft's working set
  // (`pluginSelections`) is the single source for BOTH suggestion
  // eligibility and the send path; the effect below rebases an unedited
  // working set whenever the workspace's defaults change (e.g. the async
  // projects load finishing after `selectWorkspace` seeded a stale
  // snapshot), so suggestions can never advertise an MCP the created task
  // would not run with.
  const syncWorkspaceDefaultPluginSelections = useHomeComposerStore(
    (s) => s.syncWorkspaceDefaultPluginSelections,
  );
  const taskPlanPreset = useHomeComposerStore((s) => s.pendingTaskPlanPreset);
  const workspaceDefaultsKey = useProjectsStore((s): string | null => {
    if (!workspaceId) return null;
    const project = s.projects.find((p) => p.id === workspaceId);
    return project?.defaultPluginSelections
      ? JSON.stringify(project.defaultPluginSelections)
      : null;
  });
  useEffect(() => {
    syncWorkspaceDefaultPluginSelections();
  }, [workspaceDefaultsKey, workspaceId, syncWorkspaceDefaultPluginSelections]);
  const suggestionSelections = pluginSelections;
  // CAN-3794: bring this editor in line with the draft of record when it
  // mounts visible, is shown again, or its owner resets. Declared after the
  // context rebind and staged starter-prompt effects so a required clear or
  // an explicit replacement has already landed in the store when this reads
  // it; when the editor already matches, selection and history stay put.
  useComposerDraftRestoration({
    editor,
    active: surfaceVisible,
    // A send can finish after this view has remounted. Reset the editor that
    // is visible now, rather than only the instance that initiated the send.
    resetRevision: draftGeneration,
    readDraft: readHomeComposerDraft,
    onRestore: (value, draft): void => {
      restoredDraftRef.current = draft;
      setEditorValue(value);
    },
  });
  useHomeComposerAutofocus(
    editor,
    surfaceVisible && variant === 'page' && !editorLocked,
  );
  // Only the visible Home instance fetches inventory and records
  // impressions: MainPage keeps an embedded instance mounted (hidden) under
  // other pages, and a hidden surface must not consume an impression slot.
  // Re-showing flips selections null -> non-null, which also refetches the
  // MCP inventory so eligibility picks up auth changes made elsewhere.
  const suggestedPromptsFlagEnabled = useCanopyDesktopSuggestedPromptsEnabled();
  const { prompts: suggestedPrompts } = useSuggestedPrompts(
    !suggestedPromptsFlagEnabled ||
      composerDisabled ||
      !surfaceVisible ||
      belowComposerGallery
      ? null
      : suggestionSelections,
    { surface: 'home', seedKey: 'home', holdAcrossMounts: true },
  );

  function handleSelectSuggestedPrompt(prompt: SuggestedPrompt): void {
    handleInsertCommandText(prompt.text);
    markSuggestedPromptInserted(HOME_COMPOSER_KEY);
  }

  // ---------------------------------------------------------------------
  // Task F3: `@` mention file typeahead, backed by the target-aware file
  // index (worktree checkout / cowork root / repo-shadow baseline — see
  // `resolveHomeDiscoveryTarget` and `loadFileIndex`). Enabled whenever a
  // workspace is selected and the composer isn't disabled, in both chat and
  // pipeline mode. Workspace items (notes/prompts/attachments) join the
  // candidate set for the selected workspace — for cowork targets these come
  // from the cowork managed dirs; prompt mentions expand at send time
  // (`homeSend`).
  const filesGuestGate = useDesktopFilesGuestGate(
    `${workspaceId}/${JSON.stringify(branchTarget)}`,
  );
  const fileTypeaheadEnabled = Boolean(workspaceId) && !composerDisabled;
  useEffect(() => {
    if (!fileTypeaheadEnabled || !workspaceId) {
      return;
    }
    const itemsStore = useWorkspaceItemsStore.getState();
    void itemsStore.loadNotes(workspaceId);
    void itemsStore.loadPrompts(workspaceId);
    if (
      filesGuestGate.status === 'signed-in' &&
      isCoworkChatTarget(workspaceId)
    ) {
      // Cowork attachments are physically shared across Work Entries (the
      // workspace-items cowork adapter ignores worktreeId), so staging keys
      // stay on the legacy shared `home` bucket intentionally.
      void itemsStore.loadAttachments(
        workspaceId,
        COWORK_HOME_WORKTREE_ID,
        filesGuestGate.captureAccess(),
      );
    }
  }, [fileTypeaheadEnabled, workspaceId, filesGuestGate]);
  const workspaceItemSources = useWorkspaceItemsStore(
    useShallow((s): WorkspaceItemMentionSources => {
      // Fallbacks must be the stable module-level empties: a fresh `[]` per
      // snapshot makes useShallow always see a change and loops the
      // useSyncExternalStore subscription (React max-update-depth crash).
      if (!workspaceId) {
        return {
          notes: EMPTY_NOTE_ITEMS,
          prompts: EMPTY_PROMPT_ITEMS,
          attachments: EMPTY_ATTACHMENT_ITEMS,
        };
      }
      return {
        notes: s.notes[workspaceId] ?? EMPTY_NOTE_ITEMS,
        prompts: s.prompts[workspaceId] ?? EMPTY_PROMPT_ITEMS,
        attachments:
          filesGuestGate.status === 'signed-in' &&
          isCoworkChatTarget(workspaceId)
            ? (s.attachments[`${workspaceId}/${COWORK_HOME_WORKTREE_ID}`] ??
              EMPTY_ATTACHMENT_ITEMS)
            : EMPTY_ATTACHMENT_ITEMS,
      };
    }),
  );
  const workspaceItemSearch = useCallback(
    (query: string) => searchWorkspaceItemMentions(query, workspaceItemSources),
    [workspaceItemSources],
  );

  // `branchTarget` itself isn't a primitive dep, so this reads it fresh from
  // the store inside the effect via a stable string key computed by the
  // store's own resolver logic (mirrored here only for the dependency array)
  // — same pattern `HomeComposerControls` uses to reload discovery.
  // `pr`/`linear-issue` intentionally collapse to the `new-worktree` key:
  // like `new-worktree` they resolve discovery/file-index against the
  // default-branch baseline shadow (no worktree exists yet — see
  // `resolveHomeDiscoveryTarget`), so they key the file-index reload identically.
  const branchTargetKey =
    branchTarget.kind === 'worktree'
      ? `worktree:${branchTarget.worktreeId}`
      : branchTarget.kind === 'branch'
        ? `branch:${branchTarget.branchName}:${String(branchTarget.isRemote)}`
        : 'new-worktree';
  useEffect(() => {
    if (!workspaceId) return;
    void loadFileIndex();
  }, [workspaceId, branchTargetKey, selectedRepoId, loadFileIndex]);

  // ---------------------------------------------------------------------
  // Shared catalog for slash, mention, and the plus button.
  //
  // Merge discovered and available inventory once. New-worktree targets
  // often have no discovery yet; cached inventory still lets users enable
  // a capability from any entry point without another subscription.
  const {
    commands: slashCommands,
    isRefreshing: slashCommandsRefreshing,
    isCodex: isCodexProvider,
    runInventoryCommand,
    reloadInventory,
  } = useHomeSlashCommands();

  const composerMenu = useComposerMenu(editor, {
    enabled: !composerDisabled,
    dollar: isCodexProvider,
    scopeKey: `${workspaceId}/${selectedRepoId}/${JSON.stringify(branchTarget)}/${mode}`,
    onChange: handleEditorExternallyChanged,
  });
  // The menu opened: list the inventory cache again so the backend can
  // re-check the inherited Cursor folders, which no Canopy mutation marks
  // stale. Answered from the cache; a change arrives as the usual push.
  const composerMenuOpen = composerMenu.open;
  useEffect(() => {
    if (composerMenuOpen) void reloadInventory();
  }, [composerMenuOpen, reloadInventory]);
  const searchComposerFiles = useCallback(
    (query: string) =>
      fileTypeaheadEnabled
        ? [
            ...searchFileMentions(query, fileIndex ?? [], 50),
            ...workspaceItemSearch(query),
          ]
        : [],
    [fileTypeaheadEnabled, fileIndex, workspaceItemSearch],
  );

  const composerCommands = useMemo(
    () =>
      buildComposerCommands(slashCommands, {
        home: true,
        fast: isCodexProvider,
      }),
    [slashCommands, isCodexProvider],
  );

  const selectedWorkspace = workspaceId
    ? projects.find((project) => project.id === workspaceId)
    : undefined;
  const homeTargetKind =
    selectedWorkspace?.type === 'cowork' ? 'cowork' : branchTarget.kind;
  // Work mode keeps the worktree/branch picker (and the base-branch picker
  // that hangs off it) out of the New Task composer (CAN-1817): the send
  // still targets a new worktree, the user just never has to choose one.
  const navigationMode = useNavigationMode();
  // Work mode keeps the picker one step away rather than removing it: a
  // "See more" link reveals it for the current workspace, and a pending
  // picker request (the Linear onboarding CTA opening the issues tab) reveals
  // it too so that flow keeps working. The reveal resets whenever the
  // workspace or the mode changes.
  // The reveal lives in the shared composer store, not in this instance:
  // both Home surfaces stay mounted and share the target, so a hidden
  // instance must never reset a target the visible one just picked.
  const branchPickerRevealed = useHomeComposerStore(
    (s) => s.branchPickerRevealed,
  );
  useEffect(() => {
    useHomeComposerStore.getState().setBranchPickerRevealed(false);
  }, [navigationMode]);
  const pendingBranchPickerRequest = useHomeComposerStore(
    (s) => s.pendingBranchPickerRequest,
  );
  useEffect(() => {
    if (pendingBranchPickerRequest && navigationMode === 'work') {
      useHomeComposerStore.getState().setBranchPickerRevealed(true);
    }
  }, [pendingBranchPickerRequest, navigationMode]);
  const hasBranchPickerWorkspace = useMemo(() => {
    const project = projects.find((p) => p.id === workspaceId);
    return project !== undefined && project.type !== 'cowork';
  }, [projects, workspaceId]);
  const showBranchPicker =
    hasBranchPickerWorkspace &&
    (navigationMode === 'code' || branchPickerRevealed);
  const canRevealBranchPicker = hasBranchPickerWorkspace && !showBranchPicker;
  // Work mode says where the task will run in plain words instead of showing
  // the developer picker: "New branch from main". The chip is the same
  // control, one step away — clicking it reveals the full picker.
  // Same base resolution as the visible base picker: the repo's default
  // branch when known, else the checked-out branch.
  const collapsedBaseBranchName = useHomeComposerStore((s) => {
    if (!s.branchTargets) return null;
    const base = defaultNewWorktreeBaseTarget(s.branchTargets);
    return base?.kind === 'branch' ? base.branchName : null;
  });
  const collapsedBranchSummary = collapsedBaseBranchName
    ? `New branch from ${collapsedBaseBranchName}`
    : 'New branch';
  const showNewWorktreeBasePicker =
    selectedWorkspace?.type === 'single-repo' &&
    branchTarget.kind === 'new-worktree' &&
    showBranchPicker;
  // A target chosen while the picker was visible must not survive into Work
  // mode as an invisible destination: with the picker hidden the send always
  // creates a new worktree from the default branch (CAN-1817).
  const hiddenPickerNeedsReset =
    selectedWorkspace !== undefined &&
    selectedWorkspace.type !== 'cowork' &&
    !showBranchPicker;
  const selectedWorkspaceType = selectedWorkspace?.type;
  useEffect(() => {
    if (!hiddenPickerNeedsReset) return;
    const store = useHomeComposerStore.getState();
    if (store.branchTarget.kind !== 'new-worktree') {
      store.setBranchTarget({ kind: 'new-worktree' });
    }
    if (selectedWorkspaceType === 'single-repo' && store.branchTargets) {
      const defaultBase = defaultNewWorktreeBaseTarget(store.branchTargets);
      if (
        defaultBase !== null &&
        store.newWorktreeBaseTarget !== null &&
        !homeNewWorktreeBaseTargetsEqual(
          store.newWorktreeBaseTarget,
          defaultBase,
        )
      ) {
        store.setNewWorktreeBaseTarget(defaultBase);
      }
    }
  }, [
    hiddenPickerNeedsReset,
    selectedWorkspaceType,
    branchTarget.kind,
    newWorktreeBaseTarget,
  ]);
  const startupResumeOffer = useStartupResumeStore((s) => s.offer);
  const [continueVisible, setContinueVisible] = useState(false);
  useCurrentUiStateReporter('home.surface', {
    variant,
    workspaceSelected: Boolean(workspaceId),
    ...(workspaceId ? { workspaceId } : {}),
    ...(selectedWorkspace
      ? {
          workspaceName: getWorkspaceDisplayName(selectedWorkspace),
          workspaceType: selectedWorkspace.type,
        }
      : {}),
    mode,
    targetKind: homeTargetKind,
    ...(branchTarget.kind === 'branch'
      ? { branchName: branchTarget.branchName }
      : {}),
    ...(branchTarget.kind === 'worktree'
      ? { worktreeId: branchTarget.worktreeId }
      : {}),
    ...(branchTarget.kind === 'pr' ? { prNumber: branchTarget.number } : {}),
    ...(branchTarget.kind === 'linear-issue'
      ? { issueIdentifier: branchTarget.identifier }
      : {}),
    ...(selectedRepoId ? { workingDirectoryRepoId: selectedRepoId } : {}),
    attachmentCount: attachments.length,
    fileReferenceCount: fileReferences.length,
    scheduledDraft: Boolean(scheduledSendDraft),
    pluginSelectionsActive: pluginSelections
      ? hasAnySelections(pluginSelections)
      : false,
    discoveryLoading,
    fileIndexLoading,
    sendErrorVisible: Boolean(sendError),
    inlineSlashMenuOpen: composerMenu.open,
    startupResumeOfferVisible: continueVisible && startupResumeOffer !== null,
    ...(continueVisible && startupResumeOffer
      ? { startupResumeOfferKind: startupResumeOffer.kind }
      : {}),
  });

  /**
   * Shared discovered-vs-available branch, mirroring `ChatInput`'s
   * `handleSelectCommand`: discovered rows insert as-is; "available to
   * enable" rows run the enable-and-insert flow (enable the backing
   * skill/plugin as a MANUAL selection via `runInventoryCommand`, which
   * routes through the F1 blend path, then insert the RESOLVED invocation
   * text). `onInsertDiscovered`/`onInsertResolved` differ per caller: the
   * inline menu replaces the `/` trigger range in place, while the Commands
   * popup inserts at the caret, preserving the rest of the draft.
   */
  function selectSlashCommand(
    cmd: SlashCommandData,
    onInsertDiscovered: () => void,
    onInsertResolved: (text: string) => void,
  ): void {
    if ('disabledReason' in cmd && cmd.disabledReason !== undefined) return;
    const action = getComposerAction(cmd);
    if (action) {
      if (action === 'help' || action === 'commands') {
        composerMenu.consumeTrigger();
        composerMenu.onOpenChange(true);
      } else if (action === 'workspace' && showWorkspacePicker) {
        setWorkspaceCommandOpenSignal((signal) => signal + 1);
        composerMenu.consumeTrigger();
      } else if (requestComposerAction(composerActionScope, action)) {
        composerMenu.consumeTrigger();
      } else {
        setSendError('This action is unavailable in this composer.');
      }
      handleEditorExternallyChanged();
      return;
    }
    if (!inventoryRowNeedsResolution(cmd)) {
      onInsertDiscovered();
      return;
    }
    const entry = cmd.inventoryEntry;
    if (!entry) {
      setSendError(INVENTORY_ENABLE_ERROR_COPY);
      return;
    }
    void runInventoryCommand(entry, onInsertResolved);
  }

  function handlePopupSelectCommand(cmd: SlashCommandData): void {
    const insert = (text: string): void => {
      composerMenu.insertCommandText(text);
      handleEditorExternallyChanged();
    };
    selectSlashCommand(
      cmd,
      () => insert(getSlashCommandInsertText(cmd)),
      insert,
    );
  }

  /**
   * Clipboard paste → staged attachments, mirroring `ChatInput.handlePaste`:
   * pasted files with a real filesystem path import directly, while pathless
   * blobs (a screenshot copied to the clipboard) round-trip through
   * `createClipboardAttachments`. Text-only pastes fall through to Slate's
   * default handling untouched. Staging resolves the same draft target the
   * `+` menu's file picker and Linear staging use (`HomeComposerControls`),
   * so pasted images land in the identical place and get picked up by the
   * same send orchestrator.
   */
  function handleEditorPaste(event: ClipboardEvent<HTMLDivElement>): void {
    const items = event.clipboardData?.items;
    if (!items || !Array.from(items).some((item) => item.kind === 'file'))
      return;
    if (filesGuestGate.interceptAttachment()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const isCurrent = filesGuestGate.captureAccess();

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

    if (composerDisabled) return;
    const { workspaceId: draftWorkspaceId, branchTarget: draftBranchTarget } =
      useHomeComposerStore.getState();
    if (!draftWorkspaceId) return;

    const target = {
      projectId: draftWorkspaceId,
      worktreeId: resolveHomeAttachmentWorktreeId(
        isCoworkChatTarget(draftWorkspaceId),
        draftBranchTarget,
      ),
    };
    const importToken = useHomeComposerStore.getState().beginAttachmentImport();
    void (async (): Promise<void> => {
      try {
        const clipboardItems = await createClipboardAttachments(
          blobFiles,
          'clipboard-image',
        );
        if (!isCurrent()) return;
        const imported = await importChatAttachments(
          target,
          filePaths,
          clipboardItems,
          isCurrent,
        );
        const store = useHomeComposerStore.getState();
        if (!isCurrent()) return;
        if (
          !isHomeAttachmentImportCurrent(
            target,
            importToken.draftGeneration,
            store.workspaceId,
            store.branchTarget,
            store.workspaceId !== null && isCoworkChatTarget(store.workspaceId),
            store.draftGeneration,
          )
        ) {
          return;
        }
        store.addAttachments(imported);
        store.setSendError(null);
      } catch (error) {
        const appError = toAppError(resolveClientAppError(error));
        const store = useHomeComposerStore.getState();
        if (!appError || !isCurrent()) return;
        if (
          isHomeAttachmentImportCurrent(
            target,
            importToken.draftGeneration,
            store.workspaceId,
            store.branchTarget,
            store.workspaceId !== null && isCoworkChatTarget(store.workspaceId),
            store.draftGeneration,
          )
        ) {
          store.setSendError(
            inlineFailure(appError, 'Couldn’t add the attachments.'),
          );
        }
      } finally {
        useHomeComposerStore.getState().finishAttachmentImport(importToken);
      }
    })();
  }

  function handleEditorKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (composerMenu.handleKeyDown(e)) return;
    // Enter sends; Shift+Enter inserts a newline via Slate's default
    // behavior, and meta-modified Enter is excluded because `ChatInput`
    // reserves Cmd+Enter combinations (plan-exit approval chords) — exact
    // parity with its `!e.shiftKey && !e.metaKey` send condition. The shared
    // menu owns keyboard focus while open. Routes through the same `handleSend` the send button
    // uses, so it must replicate that button's disabled gating itself:
    // `handleSend` guards on a missing workspace and pending imports; without this
    // check Enter could open an empty pipeline task or fire while a send is
    // already in flight even though the button is disabled for the same state.
    // An empty chat draft intentionally creates a work area without a message.
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey) return;

    const {
      mode: draftMode,
      workspaceId: draftWorkspaceId,
      text: draftText,
      attachments: draftAttachments,
      pendingAttachmentImportIds,
      isSending,
    } = useHomeComposerStore.getState();
    if (
      composerDisabled ||
      isSending ||
      pendingAttachmentImportIds.length > 0 ||
      !draftWorkspaceId ||
      !isHomeSendEnabled(draftMode, draftText, draftAttachments)
    ) {
      return;
    }

    e.preventDefault();
    handleSend();
  }

  /**
   * Pipeline mode opens the `task_ready` pipeline picker instead of sending
   * immediately — opening that modal is inherently React state owned by
   * `useTaskReadyPipelineLauncher`, so it can't live in the module-level
   * `dispatchHomeSend` orchestrator. Chat mode (including cowork, existing
   * worktree, new worktree, and other-branch targets) routes through
   * `dispatchHomeSend`.
   *
   * The draft's `branchTarget` (or cowork) is resolved into the launcher's
   * target shape via `resolveTaskReadyLaunchTarget` so pipeline mode honors
   * the same branch picker selection chat mode does (Task C4) instead of
   * always provisioning a new worktree.
   */
  /**
   * Resets the local Slate editor after a successful chat-mode send and
   * re-seeds the just-used workspace. `dispatchHomeSend` resets the store but
   * cannot reach the editor's own content, so without this the stale prompt
   * would stay visible (and re-serialize into the next send). Re-selecting the
   * previous workspace — rather than leaving `workspaceId` null — is the
   * least-surprising behavior: the seed effect only runs once, so a null
   * workspace would strand the picker empty on the non-navigating
   * scheduled-provision path where this surface stays mounted.
   *
   * When the store kept a newer workspace, attachments, schedule, or mode but
   * still held the submitted text/references (CAN-3933), `dispatchHomeSend`
   * purges only that content via `clearSubmittedDraft()` and leaves
   * `workspaceId` set. The `draftGeneration` bump it makes re-syncs the
   * editor through `useComposerDraftRestoration`, so this only drops the
   * now-empty draft's context owner.
   */
  function clearComposerAfterSend(prevWorkspaceId: string): void {
    const { workspaceId, text, fileReferences } =
      useHomeComposerStore.getState();
    if (text === '' && fileReferences.length === 0) {
      homeComposerDraftContextKey = null;
    }
    if (workspaceId !== null) return;
    resetEditor(editor);
    setEditorValue(createEmptyValue());
    setDraft({ text: '', fileReferences: [] });
    homeComposerDraftContextKey = null;
    selectWorkspace(prevWorkspaceId);
  }

  function handleSend(origin: 'user' | 'github-connect-resume' = 'user'): void {
    const sendAccountEpoch = useWorkspaceContextStore.getState().accountEpoch;
    const {
      mode,
      planMode: submittedPlanMode,
      workspaceId: draftWorkspaceId,
      text,
      attachments,
      branchTarget,
      branchTargets,
      branchTargetsStatus,
      newWorktreeBaseTarget: base,
      scheduledSendDraft: submittedSchedule,
      pendingAttachmentImportIds,
    } = useHomeComposerStore.getState();
    const submittedStore = useHomeComposerStore.getState();
    const submittedProvider = resolveHomeEffectiveProviderType(
      draftWorkspaceId,
      submittedStore.model,
      submittedStore.executionHarness,
    );
    if (!draftWorkspaceId) return;
    if (pendingAttachmentImportIds.length > 0) return;

    if (mode === 'pipeline') {
      const taskText = buildPipelineTaskText(text, attachments);
      const workspace = projects.find((p) => p.id === draftWorkspaceId);
      if (
        branchTarget.kind === 'new-worktree' &&
        homeWorktreeBaseMissing(base, branchTargets, branchTargetsStatus)
      ) {
        setSendError(MISSING_HOME_WORKTREE_BASE_MESSAGE);
        return;
      }
      const target = resolveTaskReadyLaunchTarget(
        workspace,
        branchTarget,
        branchTargets?.branches ?? [],
        base,
      );
      void pipelineLauncher.open(draftWorkspaceId, taskText, target);
      return;
    }

    // Captured before dispatch resets the draft.
    const submittedTask = snapshotHomeTask(variant);
    const submittedWorkspace = useProjectsStore
      .getState()
      .projects.find((project) => project.id === draftWorkspaceId);
    // Recorded at submit so a send that fails before its turn starts is
    // still counted (CAN-4630).
    if (origin === 'user') trackHomeChatSend();
    void (async (): Promise<void> => {
      const sent = await dispatchHomeSend();
      if (
        sent &&
        useWorkspaceContextStore.getState().accountEpoch === sendAccountEpoch
      ) {
        clearComposerAfterSend(draftWorkspaceId);
        if (
          isGenuinePlanModeUse({
            planMode: submittedPlanMode,
            planAvailable: !isCoworkChatTarget(draftWorkspaceId),
            planReadOnly: isPlanModeReadOnly(submittedProvider),
            pipelineMode: false,
          })
        )
          void getPlanModeHintStore().getState().markTried();
        const acceptedTurn =
          submittedSchedule === null &&
          (text.trim().length > 0 || attachments.length > 0);
        // Counts toward the GitHub star prompt, which then shows in the new
        // chat's composer; a brand without one has no store (CAN-5604).
        if (acceptedTurn)
          void getGitHubStarPromptStore()?.getState().noteTurnSent();
        // Report accepted Home turns to the independent contextual tips.
        notifyHomeTaskSent({
          kind: 'chat',
          acceptedTurn,
          worktreeChat:
            submittedWorkspace !== undefined &&
            submittedWorkspace.type !== 'cowork',
        });
        void maybeOfferRepeatTaskAutomation(submittedTask);
      }
    })();
  }

  // Resend once after connecting GitHub fixed this link's clone (CAN-4466).
  // The send consumes the request; while it runs, the other mounted surface's
  // send stops on isSending. A stale request is dropped without sending, and
  // one a send never reached (an early return) is dropped after it.
  const pendingGitHubConnectResume = useHomeComposerStore(
    (s) => s.pendingGitHubConnectResume,
  );
  useEffect(() => {
    if (!pendingGitHubConnectResume) return;
    const store = useHomeComposerStore.getState();
    const pending = store.pendingGitHubConnectResume;
    if (!pending) return;
    if (!isGitHubConnectResumeFresh(pending)) {
      store.consumeGitHubConnectResume();
      return;
    }
    handleSend('github-connect-resume');
    useHomeComposerStore.getState().consumeGitHubConnectResume();
    // handleSend is a plain function over current store state; the nonce is
    // the effect's real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGitHubConnectResume]);

  const childRepos = useMemo(() => {
    const project = projects.find((p) => p.id === workspaceId);
    if (!project || project.type !== 'multi-repo') return [];
    return project.repos.map((repo) => ({ id: repo.id, name: repo.name }));
  }, [projects, workspaceId]);
  const linkProjectPreview = useHomeLinkProjectPreview();
  const showWorkspacePicker =
    orgWithoutPlan === null &&
    (shouldShowHomeWorkspacePicker(homeScope, workspaceId) ||
      linkProjectPreview !== null);
  // While the project picker previews a pasted link's destination, the
  // branch and directory pickers would describe the other, still-selected
  // project; the link panel under the composer names the branch instead.
  // Only their display is withheld: hiding them through `showBranchPicker`
  // would reset the selected project's branch choice (CAN-1817).
  const selectionPickersVisible = linkProjectPreview === null;
  const showComposerContext =
    showWorkspacePicker ||
    (selectionPickersVisible &&
      (showBranchPicker || showNewWorktreeBasePicker || childRepos.length > 0));

  const heading = useHomeHeading();
  const homeComposerRef = useRef<HTMLDivElement>(null);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [planModeHint, setPlanModeHint] = useState<PlanModeSuggestion | null>(
    null,
  );

  return (
    <div
      data-testid="home-surface"
      data-variant={variant}
      data-workspace-selected={homeWorkspaceSelectedState(workspaceId)}
      data-target-kind={homeTargetKind}
      className="page-scroll-gutter relative flex h-full w-full flex-col items-center justify-center overflow-auto bg-base p-6"
    >
      <ComposerHeroFrame
        anchorTestId="home-composer-anchor"
        groupTestId="home-composer-group"
        shellTestId="home-composer-shell"
        rhythm="spacious"
        above={
          <div className={homeHeadingComposerGap()}>
            <Heading
              level={1}
              variant="display"
              data-testid="home-heading"
              className="min-w-0 text-center"
            >
              {heading}
            </Heading>
          </div>
        }
        aboveNotices={[
          // Notice rows stay outside the composer; their frame owns the boundary.
          orgWithoutPlan && (
            <Notice
              key="organization-plan"
              data-testid="home-composer-org-without-plan"
              intent="attention"
              title={orgWithoutPlanTitle(orgWithoutPlan.organizationName)}
              className="pointer-events-auto"
              actions={
                orgWithoutPlan.canChoosePlan ? (
                  <NoticeButton
                    variant="primary"
                    data-testid="home-composer-choose-plan"
                    onClick={(): void => {
                      openOrganizationBillingPage(
                        orgWithoutPlan.organizationId,
                      );
                    }}
                  >
                    {CHOOSE_ORG_PLAN_LABEL}
                  </NoticeButton>
                ) : (
                  <NoticeButton
                    data-testid="home-composer-back-to-personal"
                    onClick={switchToPersonal}
                  >
                    Back to Personal
                  </NoticeButton>
                )
              }
            >
              {orgWithoutPlan.canChoosePlan
                ? CHOOSE_ORG_PLAN_COPY
                : askOwnerToChoosePlanCopy(orgWithoutPlan.organizationName)}
            </Notice>
          ),
          unbillableModelSwitch ? (
            <ModelUnavailableNotice
              key="model-unavailable"
              testId="home-composer-model-unavailable"
              modelLabel={unbillableModelSwitch.modelLabel}
              reason={unbillableModelSwitch.reason}
              switchModelLabel={unbillableModelSwitch.switchModelLabel}
              onSwitch={(): void =>
                useHomeComposerStore
                  .getState()
                  .setModel(unbillableModelSwitch.switchModel)
              }
            />
          ) : null,
          orgWithoutPlan && personalSwitchError ? (
            <DesktopErrorBanner
              errorSource="home-composer-personal-switch-error"
              key="personal-switch-error"
              testId="home-composer-personal-switch-error"
              className="pointer-events-auto"
              error={personalSwitchError.error}
              {...(personalSwitchError.details === undefined
                ? {}
                : { details: personalSwitchError.details })}
              onRetry={switchToPersonal}
              onDismiss={(): void => setPersonalSwitchError(null)}
            />
          ) : null,
          missingFolderRecovery ? (
            // CAN-6019: an external project's folder moved or was renamed.
            // Locate folder only reveals where it was; it doesn't repoint
            // the project. No retry: sending again checks the folder afresh.
            <Notice
              errorSource="home-composer-missing-folder"
              displayErrorCode="external.state_changed"
              key="send-error"
              data-testid="home-composer-error"
              intent="destructive"
              title="Couldn’t send"
              className="pointer-events-auto"
              announceDetail
              {...(locateFolderStatus === 'failed'
                ? { detail: 'Couldn’t open the folder location.' }
                : {})}
              actions={
                <>
                  {canLocateFolder && (
                    <NoticeButton
                      variant="primary"
                      data-testid="home-composer-error-locate-folder"
                      busy={locateFolderStatus === 'opening'}
                      busyLabel="Opening…"
                      onClick={locateMissingFolder}
                    >
                      Locate folder
                    </NoticeButton>
                  )}
                  <NoticeButton
                    variant="secondary"
                    data-testid="home-composer-error-choose-project"
                    onClick={(): void => {
                      requestWorkspacePickerOpen();
                    }}
                  >
                    Choose another project
                  </NoticeButton>
                </>
              }
            >
              {inlineFailureText(missingFolderRecovery.failure)}
            </Notice>
          ) : sendError &&
            sendErrorChooseModel?.message === inlineFailureText(sendError) ? (
            // CAN-5021: a refused model keeps the whole draft in the
            // composer; the primary action opens its model picker.
            <FirstSendFailedNotice
              key="send-error"
              data-testid="home-composer-error"
              title="Couldn’t send"
              message={inlineFailureText(sendError) ?? ''}
              onChooseModel={() => requestModelPickerOpen({ scope: 'home' })}
              focusKey={
                surfaceVisible && sendErrorChooseModel.focus
                  ? sendErrorChooseModel.failureId
                  : null
              }
              className="pointer-events-auto"
            />
          ) : sendError ? (
            <DesktopErrorBanner
              errorSource="home-composer-error"
              key="send-error"
              testId="home-composer-error"
              className="pointer-events-auto"
              error={sendError.error}
              {...(sendError.details === undefined
                ? {}
                : { details: sendError.details })}
              blockMessageFromReplay
              {...(sendErrorRetryable
                ? {
                    onRetry: (): void => {
                      void handleSend();
                    },
                    retrying: isSending,
                  }
                : {})}
            />
          ) : null,
        ]}
        aboveContext={
          // Keep the plan hint, tray and picker drawer together above the composer.
          (showComposerContext || planModeHint?.visible === true) && (
            <ComposerDrawer
              edge="top"
              data-testid="home-composer-context-overhang"
              className="pointer-events-auto z-10"
            >
              {planModeHint !== null ? (
                <PlanModeHint hint={planModeHint} />
              ) : null}
              <HomeComposerContextRow visible={showComposerContext}>
                {showWorkspacePicker && (
                  <HomeWorkspacePicker
                    commandOpenSignal={workspaceCommandOpenSignal}
                    shortcutEnabled={variant === 'page'}
                    onRestoreFocus={(): void => focusEditor(editor)}
                  />
                )}
                {selectionPickersVisible && showBranchPicker && (
                  <HomeBranchPicker />
                )}
                {selectionPickersVisible && canRevealBranchPicker && (
                  <Button
                    variant="secondary"
                    size="compact"
                    className="max-w-52"
                    data-testid="home-branch-picker-see-more"
                    aria-label={`${collapsedBranchSummary}. Choose a worktree or branch`}
                    onClick={(): void =>
                      useHomeComposerStore
                        .getState()
                        .setBranchPickerRevealed(true)
                    }
                  >
                    {/* The summary can be cut off: its text keeps a native
                          title with the full value. */}
                    <span className="truncate" title={collapsedBranchSummary}>
                      {collapsedBranchSummary}
                    </span>
                    <ChevronDownMediumIcon size="sm" className="shrink-0" />
                  </Button>
                )}
                {selectionPickersVisible && showNewWorktreeBasePicker && (
                  <HomeBaseBranchPicker />
                )}
                {selectionPickersVisible && childRepos.length > 0 && (
                  <div data-testid="home-directory-picker">
                    <DirectoryPicker
                      currentRepoId={selectedRepoId}
                      childRepos={childRepos}
                      disabled={composerDisabled}
                      onSelect={setSelectedRepoId}
                    />
                  </div>
                )}
              </HomeComposerContextRow>
            </ComposerDrawer>
          )
        }
        composer={
          <div>
            <div
              ref={homeComposerRef}
              data-testid="home-composer"
              className="relative z-20 w-full rounded-2xl bg-tertiary shadow-lg"
            >
              {/* The org gateway a member has no working key for. Home is a
 composer like any other: without this, the first thing a
 new member of an enforcing org does is send a task that
 cannot run, with nothing on screen saying why. Kept inside
 the composer box so it does not shift the vertical center
 line anchored on the composer box. */}
              <ModelGatewayKeyBanner
                selectedGatewayOrganizationId={selectedGatewayOrganizationId}
              />
              <span
                ref={composerMenu.anchorRef}
                aria-hidden
                className="pointer-events-none absolute inset-0"
              />
              <DraftComposerEditor
                editor={editor}
                typeToFocus
                value={editorValue}
                onChange={handleEditorChange}
                onKeyDown={handleEditorKeyDown}
                onPaste={handleEditorPaste}
                placeholder={
                  // While dictating, the empty box prompts for speech, as the
                  // chat composer does.
                  voiceRecording
                    ? 'Start talking…'
                    : mode === 'pipeline'
                      ? 'Describe the task we are working on'
                      : defaultChatPlaceholder(true, true)
                }
                dataTestId="home-composer-editor"
                disabled={editorLocked}
              />

              {mode === 'chat' && scheduledSendDraft && (
                <div className="px-4 pt-2">
                  <Chip
                    icon={ScheduleIcon}
                    onRemove={() => setScheduledSendDraft(null)}
                    removeLabel="Clear scheduled send"
                    data-testid="home-scheduled-send-pill"
                    removeTestId="home-scheduled-send-pill-clear"
                  >
                    Scheduled send{' '}
                    {new Date(scheduledSendDraft.runAt).toLocaleString()}
                  </Chip>
                </div>
              )}

              <HomeComposerControls
                key={`${accountEpoch}:${homeComposerContextKey(scopingContext)}`}
                composerActionScope={composerActionScope}
                composerMenu={composerMenu}
                searchFiles={searchComposerFiles}
                onSelectFile={(file) =>
                  composerMenu.insertFile(file, (fileIndex ?? []).length)
                }
                editor={editor}
                hintDraftRevision={hintDraftRevision}
                disabled={composerDisabled}
                shortcutEnabled={variant === 'page'}
                onSend={() => handleSend()}
                onEditorExternallyChanged={handleEditorExternallyChanged}
                commands={composerCommands}
                commandsRefreshing={slashCommandsRefreshing}
                isCodex={isCodexProvider}
                onSelectCommand={handlePopupSelectCommand}
                composerBoxRef={homeComposerRef}
                onVoiceRecordingChange={setVoiceRecording}
                onPlanModeHintChange={setPlanModeHint}
              />
              {mode === 'pipeline' && taskPlanPreset && (
                <div
                  data-testid="home-task-plan-guidance"
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3"
                >
                  <Surface
                    variant="group"
                    size="small"
                    className="shrink-0 inline-block"
                  >
                    <div className="inline-flex items-center gap-1 py-0.5 pl-2.5 pr-0.5 text-xs font-medium fg-secondary">
                      <span>Task planning</span>
                      <Tooltip label="Cancel task planning">
                        <Button
                          variant="ghost-quiet"
                          size="sm"
                          iconOnly
                          data-testid="home-task-plan-cancel"
                          aria-label="Cancel task planning"
                          disabled={composerDisabled}
                          onClick={(): void => {
                            useHomeComposerStore.getState().setMode('chat');
                            focusEditor(editor);
                          }}
                        >
                          <CloseMediumIcon size={16} aria-hidden="true" />
                        </Button>
                      </Tooltip>
                    </div>
                  </Surface>
                  <p
                    role="status"
                    className="min-w-0 flex-1 basis-64 text-xs fg-secondary"
                  >
                    <span className="sr-only">Task planning selected. </span>
                    Describe your task above, then submit to generate a plan.
                  </p>
                </div>
              )}
            </div>
          </div>
        }
        hanging={
          <>
            {/* CAN-3606: the pasted-link destination, in every state, sits
                centered under the composer rather than in the picker
                overhang, so the composer and headline never move. */}
            {linkTargetVisible && (
              <div
                data-testid="home-link-target-slot"
                className="flex justify-center px-4 pt-4"
              >
                <HomeLinkTargetChip
                  onChooseProject={(): void =>
                    setWorkspaceCommandOpenSignal((signal) => signal + 1)
                  }
                />
              </div>
            )}
            <div data-testid="home-mcp-sign-in">
              {mode === 'chat' && (
                <HomeMcpSignInStrip
                  selections={pluginSelections}
                  ownerKey={`${workspaceId ?? ''}/${draftGeneration}/${mode}`}
                  getSelections={(): ChatTabPluginSelections | null => {
                    const current = useHomeComposerStore.getState();
                    return current.workspaceId === workspaceId &&
                      current.draftGeneration === draftGeneration &&
                      current.mode === mode
                      ? current.pluginSelections
                      : null;
                  }}
                  onSelectionsChange={(next): boolean => {
                    const current = useHomeComposerStore.getState();
                    if (
                      current.workspaceId !== workspaceId ||
                      current.draftGeneration !== draftGeneration ||
                      current.mode !== mode
                    )
                      return false;
                    current.setPluginSelections(next);
                    return (
                      useHomeComposerStore.getState().pluginSelections === next
                    );
                  }}
                  reportUiState={variant === 'page'}
                />
              )}
            </div>
          </>
        }
        below={
          <>
            {belowComposerGallery ? (
              <HomeBelowComposerGallery />
            ) : (
              <>
                {/* Continue leads so a returning user's way back to their
                    work stays directly below the composer (CAN-4746). */}
                <HomeContinueSection
                  onVisibilityChange={setContinueVisible}
                  interruptedActive={variant === 'page' && surfaceVisible}
                  isPageVariant={variant === 'page'}
                />

                {variant === 'page' &&
                  selectedWorkspace &&
                  selectedWorkspace.type !== 'cowork' && (
                    <HomeWorkspaceReadiness
                      key={selectedWorkspace.id}
                      workspaceId={selectedWorkspace.id}
                      workspaceName={selectedWorkspace.name}
                    />
                  )}

                {suggestedPrompts.length > 0 && (
                  <SuggestedPromptChips
                    prompts={suggestedPrompts}
                    surface="home"
                    onSelect={handleSelectSuggestedPrompt}
                  />
                )}
              </>
            )}
          </>
        }
      />
      {pipelineLauncher.ctx && (
        <TaskReadyPipelineModal
          cwd={pipelineLauncher.ctx.cwd}
          repoChoices={pipelineLauncher.ctx.repoChoices}
          executionScope={pipelineLauncher.ctx.executionScope}
          // One-shot preselection staged by the onboarding "Create a
          // Task Plan" CTA (bundled implementation-plan pipeline + the
          // lane-matched model input); cleared when the modal closes.
          initialPipelineId={taskPlanPreset?.pipelineId}
          initialInputs={taskPlanPreset?.inputs}
          onClose={(): void => {
            useHomeComposerStore.getState().stageTaskPlanPreset(null);
            pipelineLauncher.close();
          }}
          onRun={async (...args): Promise<void> => {
            const dispatched = await pipelineLauncher.run(...args);
            // A failed run keeps the modal open on `runError`; the
            // staged preset must survive so a retry does not reload
            // the pipeline list from scratch.
            if (dispatched) {
              useHomeComposerStore.getState().stageTaskPlanPreset(null);
            }
          }}
          isRunning={pipelineLauncher.running}
          runError={pipelineLauncher.runError}
          watcherRecipientGroups={taskWatcherGroups}
          onWatcherSelectionChange={pipelineLauncher.setWatcherSelection}
        />
      )}
    </div>
  );
}
