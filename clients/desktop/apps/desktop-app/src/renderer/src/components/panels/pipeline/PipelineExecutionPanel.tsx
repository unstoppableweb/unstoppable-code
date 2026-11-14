/**
 * PipelineExecutionPanel — the `pipeline-execution` panel kind's host: one
 * pipeline run's full detail inside a workspace panel tab.
 *
 * - **Owner and binding.** The owner is the panel's layout owner (Code
 *   worktree, or Cowork Work Entry in the worktree slot); the run is the
 *   descriptor's `instance.executionId`. Drilling into child runs changes the
 *   view, never the binding.
 * - **No modal chrome.** The tab owns the title (the run's name once known)
 *   and the close control. There is no fullscreen wrapper, drag bar,
 *   document-wide Escape, or focus trap; opening another surface never closes
 *   the tab.
 * - **Visibility gate.** `visible` is the tab's own visibility (selected,
 *   group expanded, not covered by a maximized sibling) AND the host page's
 *   (main page for main-layout panels, the window itself for popped-out ones)
 *   AND the owning window's document. While it is false the detail is
 *   suspended inside `<Activity mode="hidden">`: its lease, step-log
 *   interests, store subscriptions, report reads, and timers are all released,
 *   and nothing updates until it is shown again. Its React state is kept, and
 *   the small view state that must also survive unmounting (worktree switch)
 *   lives in the per-panel session store.
 * - **Report in place.** View Report selects the shown run's Summary and
 *   brings its report into view, rather than opening the report dialog. The
 *   job list keeps whatever presentation it had.
 * - **Recoverable errors.** A run that cannot be read shows a notice with
 *   Try again, never a crash or an empty tab.
 * - **Job list by width.** The list docks when the panel is wide enough and
 *   presents collapsed (toggle plus hover/focus preview) below
 *   `PIPELINE_PANEL_NAV_AUTO_COLLAPSE_WIDTH_PX`, without writing that to the
 *   session store; widening docks it again. The user's own toggle is stored
 *   as an explicit choice and wins at any width for this panel.
 */
import {
  Activity,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import type { JobStatus } from '@/lib/pipelineDetailsView';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  defaultPipelinePanelUiEntry,
  getPipelinePanelSession,
  patchPipelinePanelUi,
  pipelinePanelUiKey,
  resolvePipelinePanelNavExpanded,
  selectPipelinePanelUiEntry,
  usePipelinePanelUiStore,
  type PipelinePanelUiEntry,
} from '@/stores/pipelinePanelUiStore';
import { PipelineExecutionDetail } from '@/components/activity/details/PipelineExecutionDetail';
import { PipelineRunCostProvider } from '@/components/activity/details/PipelineRunCostPanel';
import { isPipelineDetailsCostSelection } from '@/components/activity/details/pipelineRunCostPanelContext';
import { pipelineDetailPanelUiStateKey } from '@/lib/current-ui-state/pipelineDetailUiState';
import type { PipelineDetailsSelection } from '@/components/activity/details/PipelineDetailsNav';
import { isPipelineDetailsDefinitionSelection } from '@/components/activity/details/pipelineDetailTypes';
import type { PipelineDetailNavigation } from '@/components/activity/details/PipelineDetailNavigation';
import { PipelineDetailSessionContext } from '@/components/activity/details/pipelineDetailSession';
import { PipelineNavPreviewController } from '@/components/activity/details/pipelineNavPreviewController';
import type {
  BreadcrumbEntry,
  PipelineExecutionDetailRevealTarget,
} from '@/components/activity/details/pipelineDetailTypes';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { PipelinePanelWidthTracker } from './pipelinePanelWidthTracker';

export interface PipelineExecutionPanelProps {
  panelId: string;
  /** The bound root run (`instance.executionId`). */
  executionId: string;
  /** The panel's layout owner; a Cowork Work Entry fills `worktreeId`. */
  owner: { readonly projectId: string; readonly worktreeId: string };
  /**
   * Tab visible AND host page visible AND owning document visible. The
   * detail holds data demand only while this is true.
   */
  visible: boolean;
  /**
   * The tab is its layout's active tab (the focused one). Reported to App
   * Advisor's current-UI state; it gates nothing.
   */
  active?: boolean;
  /** The document of the window currently showing the panel. */
  ownerDocument?: Document;
}

/**
 * Keeps the run's name in the panel's session state, so the tab title shows
 * it even after the snapshot is released while the panel is hidden.
 */
function PipelineRunTitleSync({
  uiKey,
  executionId,
}: {
  uiKey: string;
  executionId: string;
}): null {
  const name = usePipelineRunsStore(
    (state) =>
      state.statesById[executionId]?.pipeline_snapshot.name ??
      state.summaries.find((summary) => summary.id === executionId)
        ?.pipeline_name,
  );
  useEffect(() => {
    if (name === undefined || name.trim() === '') return;
    const current = selectPipelinePanelUiEntry(
      usePipelinePanelUiStore.getState(),
      uiKey,
      executionId,
    );
    if (current?.title === name) return;
    patchPipelinePanelUi(uiKey, executionId, { title: name });
  }, [executionId, name, uiKey]);
  return null;
}

function PipelineRunLoadFailed({
  onRetry,
}: {
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <Notice
        errorSource="pipeline-execution-panel-load-error"
        intent="destructive"
        title="Couldn't load this run"
        data-testid="pipeline-execution-panel-load-error"
        actions={
          <NoticeButton
            variant="primary"
            data-testid="pipeline-execution-panel-retry"
            onClick={onRetry}
          >
            Try again
          </NoticeButton>
        }
      >
        It may have been deleted, or its details aren't available right now.
      </Notice>
    </div>
  );
}

export function PipelineExecutionPanel({
  panelId,
  executionId,
  owner,
  visible,
  active = false,
  ownerDocument,
}: PipelineExecutionPanelProps): JSX.Element {
  const ownerKey = `${owner.projectId}/${owner.worktreeId}`;
  const uiKey = pipelinePanelUiKey(ownerKey, panelId);
  // Each shown panel reports under its own key (hidden panels report
  // nothing: the suspended detail releases its slice).
  const auxiliaryWindow =
    ownerDocument !== undefined && ownerDocument !== document;
  const uiStateMetadata = useMemo(
    () => ({
      host: 'panel',
      ownerKey,
      panelId,
      active,
      auxiliaryWindow,
    }),
    [active, auxiliaryWindow, ownerKey, panelId],
  );
  const detailOwner = useMemo(
    () => ({ projectId: owner.projectId, worktreeId: owner.worktreeId }),
    [owner.projectId, owner.worktreeId],
  );
  const costScope = useMemo<CostScopeRef>(
    () => ({
      kind: 'entry',
      projectId: owner.projectId,
      worktreeId: owner.worktreeId,
    }),
    [owner.projectId, owner.worktreeId],
  );

  const retainedEntry = usePipelinePanelUiStore((state) =>
    selectPipelinePanelUiEntry(state, uiKey, executionId),
  );
  const defaultEntry = useMemo(
    () => defaultPipelinePanelUiEntry(executionId),
    [executionId],
  );
  const entry: PipelinePanelUiEntry = retainedEntry ?? defaultEntry;

  const identityRef = useRef({ uiKey, executionId });
  identityRef.current = { uiKey, executionId };
  const patch = useCallback(
    (values: Parameters<typeof patchPipelinePanelUi>[2]): void => {
      const identity = identityRef.current;
      patchPipelinePanelUi(identity.uiKey, identity.executionId, values);
    },
    [],
  );
  const onViewStackChange = useCallback(
    (viewStack: BreadcrumbEntry[]): void => patch({ viewStack }),
    [patch],
  );
  const onSelectionChange = useCallback(
    (selection: PipelineDetailsSelection): void => patch({ selection }),
    [patch],
  );
  const onStatusFilterChange = useCallback(
    (statusFilter: JobStatus | 'all'): void => patch({ statusFilter }),
    [patch],
  );

  // The panel's width class decides the job list's default presentation.
  // Observed on the panel root, in whichever window document shows it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [widthTracker] = useState(() => new PipelinePanelWidthTracker());
  const widthClass = useSyncExternalStore(
    widthTracker.subscribe,
    widthTracker.getSnapshot,
    widthTracker.getSnapshot,
  );
  useLayoutEffect(() => {
    widthTracker.observe(rootRef.current);
    return (): void => widthTracker.disconnect();
  }, [ownerDocument, widthTracker]);
  const navExpanded = resolvePipelinePanelNavExpanded(
    entry.navExpandedOverride,
    widthClass,
  );

  // One job-list preview controller per panel (never the app sidebar's).
  // It reads the presented state and records a toggle as the user's
  // explicit choice.
  const [navController] = useState(
    () =>
      new PipelineNavPreviewController({
        isExpanded: (): boolean => {
          const identity = identityRef.current;
          return resolvePipelinePanelNavExpanded(
            selectPipelinePanelUiEntry(
              usePipelinePanelUiStore.getState(),
              identity.uiKey,
              identity.executionId,
            )?.navExpandedOverride,
            widthTracker.getSnapshot(),
          );
        },
        setExpanded: (expanded: boolean): void =>
          patch({ navExpandedOverride: expanded }),
        scopeId: panelId,
      }),
  );
  useEffect(() => {
    navController.setEnabled(visible);
  }, [navController, visible]);
  // Adopted into another window: the preview and its listeners belonged to
  // the old document.
  const previousDocumentRef = useRef(ownerDocument);
  useEffect(() => {
    if (previousDocumentRef.current === ownerDocument) return;
    previousDocumentRef.current = ownerDocument;
    navController.dismiss();
  }, [navController, ownerDocument]);
  useEffect(() => (): void => navController.dispose(), [navController]);
  // The presentation followed the width: a preview left open from the
  // collapsed presentation must not reappear later.
  const previousWidthClassRef = useRef(widthClass);
  useEffect(() => {
    if (previousWidthClassRef.current === widthClass) return;
    previousWidthClassRef.current = widthClass;
    navController.dismiss();
  }, [navController, widthClass]);

  const navigation = useMemo<PipelineDetailNavigation>(
    () => ({
      controller: navController,
      expanded: navExpanded,
      ownerDocument,
    }),
    [navExpanded, navController, ownerDocument],
  );

  const session = useMemo(() => getPipelinePanelSession(uiKey), [uiKey]);

  // An explicit target (opener reveal) reaches the mounted detail through
  // the entry's nonce; its view values are already applied to the entry.
  const revealNonce = entry.revealNonce;
  const revealSource = useRef(entry);
  revealSource.current = entry;
  const revealTarget = useMemo<
    PipelineExecutionDetailRevealTarget | undefined
  >(() => {
    if (revealNonce === 0) return undefined;
    const source = revealSource.current;
    const selection = source.selection;
    return {
      nonce: revealNonce,
      viewStack: source.viewStack,
      ...(selection === null
        ? {}
        : isPipelineDetailsCostSelection(selection)
          ? { entry: 'cost' }
          : isPipelineDetailsDefinitionSelection(selection)
            ? { entry: 'definition' }
            : {
                jobId: selection.jobId,
                ...(selection.variantJobId !== undefined
                  ? { variantJobId: selection.variantJobId }
                  : {}),
              }),
    };
  }, [revealNonce]);

  // Never-shown panels (a restored layout's background tab) mount nothing:
  // no run reads and no detail bundle work until first shown.
  const [everShown, setEverShown] = useState(visible);
  if (visible && !everShown) setEverShown(true);

  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback((): void => {
    setRetryNonce((current) => current + 1);
  }, []);
  const renderLoadFailed = useCallback(
    (): JSX.Element => <PipelineRunLoadFailed onRetry={retry} />,
    [retry],
  );

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="pipeline-execution-panel"
      data-execution-id={executionId}
      data-detail-state={visible ? 'active' : 'suspended'}
      data-panel-width={widthClass}
    >
      {everShown ? (
        <Activity mode={visible ? 'visible' : 'hidden'}>
          <PipelineRunCostProvider scope={costScope} executionId={executionId}>
            <PipelineDetailSessionContext.Provider value={session}>
              <PipelineRunTitleSync uiKey={uiKey} executionId={executionId} />
              <PipelineExecutionDetail
                key={retryNonce}
                executionId={executionId}
                owner={detailOwner}
                detailEnabled={visible}
                idScope={panelId}
                viewStack={entry.viewStack}
                onViewStackChange={onViewStackChange}
                selection={entry.selection}
                onSelectionChange={onSelectionChange}
                statusFilter={entry.statusFilter}
                onStatusFilterChange={onStatusFilterChange}
                revealTarget={revealTarget}
                navigation={navigation}
                viewReportInline
                renderLoadFailed={renderLoadFailed}
                uiStateKey={pipelineDetailPanelUiStateKey(uiKey)}
                uiStateMetadata={uiStateMetadata}
              />
            </PipelineDetailSessionContext.Provider>
          </PipelineRunCostProvider>
        </Activity>
      ) : null}
    </div>
  );
}
