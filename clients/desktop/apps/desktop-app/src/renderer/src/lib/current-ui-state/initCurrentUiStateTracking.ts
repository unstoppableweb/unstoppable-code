import { useBrowserStore } from '@/stores/browserStore';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useLabsExperimentsStore } from '@/stores/labsExperimentsStore';
import { useFileLabelsStore } from '@/stores/fileLabelsStore';
import { desktopFileSessionController } from '@/lib/file-viewer/desktop-file-session-controller';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import { throttleTrailing } from './throttle-trailing';

/**
 * `setWidth` fires once per `mousemove` while the sidebar resize handle is
 * being dragged, and each notification triggers a full snapshot build+hash.
 * Throttle only this subscription (trailing edge, so the final width always
 * lands) to cap recomputes at roughly 1 per 100ms during a drag. See
 * `throttle-trailing.ts` for why 100ms was chosen over a
 * `requestAnimationFrame` batch.
 */
const SIDEBAR_RECOMPUTE_THROTTLE_MS = 100;

interface RelevantPipelinePauseFacts {
  executionId: string | null;
  stateExists: boolean;
  inputPauseRequiresInput: boolean;
}

function relevantPipelinePauseFacts(
  pipelineRuns: ReturnType<typeof usePipelineRunsStore.getState>,
): RelevantPipelinePauseFacts {
  const selectedWorktree = useChatStore.getState().selectedWorktree;
  const projectId =
    selectedWorktree?.projectId ?? pipelineRuns.currentProjectId;
  const worktreeId =
    selectedWorktree?.worktreeId ?? pipelineRuns.currentWorktreeId;
  const summary =
    pipelineRuns.summaries.find(
      (entry) =>
        entry.project_id === projectId && entry.worktree_id === worktreeId,
    ) ??
    pipelineRuns.summaries.find(
      (entry) =>
        entry.project_id === pipelineRuns.currentProjectId &&
        entry.worktree_id === pipelineRuns.currentWorktreeId,
    );
  if (!summary) {
    return {
      executionId: null,
      stateExists: false,
      inputPauseRequiresInput: false,
    };
  }

  const executionState =
    pipelineRuns.statesById[summary.id] ??
    pipelineRuns.rowStatesById[summary.id];
  return {
    executionId: summary.id,
    stateExists: executionState !== undefined,
    inputPauseRequiresInput:
      executionState?.pending_pauses?.some(
        (pause) => pause.kind === 'input' && pause.request !== undefined,
      ) ?? false,
  };
}

function pipelinePauseFactsChanged(
  left: RelevantPipelinePauseFacts,
  right: RelevantPipelinePauseFacts,
): boolean {
  return (
    left.executionId !== right.executionId ||
    left.stateExists !== right.stateExists ||
    left.inputPauseRequiresInput !== right.inputPauseRequiresInput
  );
}

/**
 * Wire the current-UI-state envelope to recompute whenever any of the
 * top-level renderer stores publish a new value. Component-local reporters
 * call {@link useCurrentUiStateReporter} for state that lives outside these
 * stores.
 *
 * Returns a disposer so the App.tsx mount effect can detach the
 * subscriptions on unmount (matters for renderer hot-reload but not for the
 * production process).
 */
export function initCurrentUiStateTracking(): () => void {
  const recompute = (): void =>
    useCurrentUiStateStore.getState().recomputeEnvelope();

  const unsubNav = useNavigationStore.subscribe(recompute);
  const unsubNavigationHistory = useNavigationHistoryStore.subscribe(recompute);
  const unsubChat = useChatStore.subscribe(recompute);
  const unsubFeatureFlags = useFeatureFlagsStore.subscribe(recompute);
  const unsubLabs = useLabsExperimentsStore.subscribe(
    (state, previousState) => {
      if (state.snapshot !== previousState.snapshot) recompute();
    },
  );
  const unsubWorkspaceContext = useWorkspaceContextStore.subscribe(recompute);
  const unsubFileLabels = useFileLabelsStore.subscribe(
    (state, previousState) => {
      if (state.hiddenLabelIds !== previousState.hiddenLabelIds) recompute();
    },
  );
  const unsubTerminal = useTerminalStore.subscribe(recompute);
  const unsubFiles = desktopFileSessionController.subscribe(recompute);
  const unsubProjects = useProjectsStore.subscribe(recompute);
  const unsubStandaloneChats = useStandaloneChatStore.subscribe(
    (state, previous) => {
      if (state.activeChatProjectId !== previous.activeChatProjectId)
        recompute();
    },
  );
  const unsubPipelineRuns = usePipelineRunsStore.subscribe(
    (state, previousState) => {
      // The hidden UI snapshot deliberately excludes pipeline logs and
      // detail. Step output lives in `pipelineStepLogStore`; row changes only
      // matter when the relevant run's state-exists or input-pause facts
      // change. Avoid rebuilding + hashing the full snapshot for step/job
      // events that do not affect those facts.
      const selectionChanged =
        state.currentProjectId !== previousState.currentProjectId ||
        state.currentWorktreeId !== previousState.currentWorktreeId ||
        state.summaries !== previousState.summaries;
      const pauseFactsChanged = pipelinePauseFactsChanged(
        relevantPipelinePauseFacts(previousState),
        relevantPipelinePauseFacts(state),
      );
      if (selectionChanged || pauseFactsChanged) {
        recompute();
      }
    },
  );
  const unsubPanelLayout = usePanelLayoutStore.subscribe(recompute);
  const unsubWorkspaceLayoutMode =
    useWorkspaceLayoutModeStore.subscribe(recompute);
  // Browser summary is derived centrally from the panel layout + browser
  // store (no per-surface `browser.drawer` reporter), so browser-store
  // changes (active browser, titles, loading, diagnostics) recompute too.
  const unsubBrowser = useBrowserStore.subscribe(recompute);
  const unsubAppAdvisorWindow =
    window.api?.appAdvisor?.onWindowUiStateChanged?.((state) => {
      // The popout nav's bulk removal dialog, read by the snapshot builder
      // beside the main rail's.
      useCurrentUiStateStore
        .getState()
        .updateSlice(
          'appAdvisor.batchRemovalDialog',
          state.batchRemovalDialog === undefined ||
            state.batchRemovalDialog === null
            ? null
            : { ...state.batchRemovalDialog },
        );
      useCurrentUiStateStore.getState().updateSlice('appAdvisor.window', {
        activeWorkEntryId: state.activeWorkEntryId,
        activeChatId: state.activeChatId,
        navCollapsed: state.navCollapsed,
        groupEditorId: state.groupEditorId ?? null,
        settingsModalOpen: state.settingsModalOpen,
        archivedOverviewOpen: state.archivedOverviewOpen,
        archivedOverviewWorkspaceId: state.archivedOverviewWorkspaceId,
        emptyTrashConfirmationOpen: state.emptyTrashConfirmationOpen,
        emptyTrashRunning: state.emptyTrashRunning,
        lastArchivedOverviewRequestId: state.lastArchivedOverviewRequestId,
        lastArchivedOverviewConfirmationOpened:
          state.lastArchivedOverviewConfirmationOpened,
      });
    }) ?? ((): void => undefined);

  const throttledSidebarRecompute = throttleTrailing(
    recompute,
    SIDEBAR_RECOMPUTE_THROTTLE_MS,
  );
  const unsubSidebar = useSidebarStore.subscribe(throttledSidebarRecompute);

  // Compute once so consumers reading the envelope at startup see a
  // non-empty snapshot.
  recompute();

  return (): void => {
    unsubNav();
    unsubNavigationHistory();
    unsubChat();
    unsubFeatureFlags();
    unsubLabs();
    unsubWorkspaceContext();
    unsubFileLabels();
    unsubTerminal();
    unsubFiles();
    unsubProjects();
    unsubStandaloneChats();
    unsubPipelineRuns();
    unsubSidebar();
    throttledSidebarRecompute.cancel();
    unsubPanelLayout();
    unsubWorkspaceLayoutMode();
    unsubBrowser();
    unsubAppAdvisorWindow();
  };
}
