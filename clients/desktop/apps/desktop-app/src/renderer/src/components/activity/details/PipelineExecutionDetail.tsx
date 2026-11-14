import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Surface,
  CustomizeBreadcrumbs,
  EmptyState,
  Notice,
} from '@canopy/ui-shared/components';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/execution-engine/types/pipeline';
import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import type { CostNavigator } from '@canopy/app-core';
import { toPipelineRunDefinitionViewModel } from '@canopy/desktop-shared/pipelines/pipeline-read-detail-adapter';
import { PipelineRunDefinitionUsed } from '@canopy/ui-app';
import {
  formatCostTotalIn,
  useCostCurrency,
} from '@canopy/ui-shared/components/cost';
import type { PipelineDetailOwner } from '@/stores/pipelineDetailCoordinator';
import {
  useNavigationStore,
  type PipelineEditDeepLink,
} from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import type { JobStatus } from '@/lib/pipelineDetailsView';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { buildPipelineDetailUiState } from '@/lib/current-ui-state/pipelineDetailUiState';
import { LoadingSpinner } from '../../shared/loading/spinners/LoadingSpinner';
import {
  usePipelineExecutionActions,
  usePipelineExecutionWatchers,
  type PipelineExecutionActions,
} from '../usePipelineExecutionActions';
import {
  PipelineDetailsNav,
  type PipelineDetailsSelection,
} from './PipelineDetailsNav';
import { PipelineExecutionActionBar } from './PipelineExecutionActionBar';
import {
  PipelineCollapsibleNav,
  PipelineNavToggleZone,
  type PipelineDetailNavigation,
} from './PipelineDetailNavigation';
import {
  usePipelineDetailSession,
  useRetainedSessionValue,
  useSessionWriter,
} from './pipelineDetailSession';
import { PipelineExecutionInlineDetail } from './PipelineExecutionInlineDetail';
import { PipelineJobView } from './PipelineJobView';
import { PipelinePauseResumeContent } from './PipelinePauseResumeContent';
import { PipelineReportView } from './PipelineReportView';
import { PipelineSummaryView } from './PipelineSummaryView';
import {
  usePipelineExecutionDetailData,
  useResolvedPipelineDetailOwner,
} from './usePipelineExecutionDetailData';
import {
  isPipelineDetailsDefinitionSelection,
  type ArchivedPipelineSource,
  type BreadcrumbEntry,
  type PipelineDetailDestination,
  type PipelineExecutionDetailRevealTarget,
  type PipelineExecutionDetailTarget,
} from './pipelineDetailTypes';
import {
  isPipelineDetailsCostSelection,
  usePipelineRunCostPanel,
} from './pipelineRunCostPanelContext';

const LazyPipelineRunCostPreviewCard = lazy(() =>
  import('@canopy/ui-app/cost').then((module) => ({
    default: module.PipelineRunCostPreviewCard,
  })),
);
const LazyPipelineRunCostView = lazy(() =>
  import('@canopy/ui-app/cost').then((module) => ({
    default: module.PipelineRunCostView,
  })),
);

export interface PipelineExecutionDetailHeaderContext {
  /** Display title of the execution currently shown (breadcrumb top). */
  title: string;
  activeExecutionId: string;
  state?: ExecutionState;
  summary?: ExecutionSummary;
}

export interface PipelineExecutionDetailProps {
  /** The bound root execution. Drilling into children changes the view only. */
  executionId: string;
  /**
   * Owner the phase 02 detail lease is held under. `undefined` captures the
   * worktree selected at mount (legacy modal behavior); `null` is ownerless.
   * Panel hosts pass their layout owner.
   */
  owner?: PipelineDetailOwner | null;
  /**
   * Visibility gate: holds the detail lease and step log interests only
   * while true. Defaults to true. A hidden panel passes false.
   */
  detailEnabled?: boolean;
  /** Initial breadcrumb stack and job selection (uncontrolled). */
  initialTarget?: PipelineExecutionDetailTarget;
  /**
   * Explicit target applied whenever its `nonce` changes, including on an
   * already-mounted instance. Takes precedence over `initialTarget` at mount.
   */
  revealTarget?: PipelineExecutionDetailRevealTarget;
  /** Controlled breadcrumb stack; pair with `onViewStackChange`. */
  viewStack?: readonly BreadcrumbEntry[];
  onViewStackChange?: (viewStack: BreadcrumbEntry[]) => void;
  /** Controlled job/variant selection (`null` is Summary). */
  selection?: PipelineDetailsSelection;
  onSelectionChange?: (selection: PipelineDetailsSelection) => void;
  /** Controlled job status filter. */
  statusFilter?: JobStatus | 'all';
  onStatusFilterChange?: (statusFilter: JobStatus | 'all') => void;
  /**
   * Prefix for instance-scoped DOM ids (pause input fields). Defaults to a
   * per-instance React id, so several open details never share an id.
   */
  idScope?: string;
  /**
   * Read-only archived source. State, reports, and logs are read through the
   * archive transport; live-only controls (actions, matrix retry/cancel,
   * pause/resume, advisor, watchers, worker jumps) are hidden.
   */
  archivedSource?: ArchivedPipelineSource;
  /**
   * Execution-action controller. Hosts that close on navigation (the modal)
   * pass one that outlives them so its dialogs survive the close. Without
   * it, the detail owns a controller and renders its dialogs itself.
   */
  actions?: PipelineExecutionActions;
  /** Opens a worker. Defaults to the Workers page. Never closes the view. */
  onOpenWorker?: (workerId: string) => void;
  /** Opens the pipeline definition. Defaults to the editor. Never closes. */
  onOpenDefinition?: (link: PipelineEditDeepLink) => void;
  /**
   * Reports that an action took the user to another surface. Covering hosts
   * may close here; panels ignore it.
   */
  onNavigatedAway?: (destination: PipelineDetailDestination) => void;
  /**
   * Show the run's report in place. View Report then selects the active
   * run's Summary (a drilled-in child keeps its own), scrolls the report
   * region into view and focuses it, instead of opening the report dialog or
   * reporting a navigation. The job list's collapsed state is left alone.
   * Panels opt in; the compatibility modal keeps the dialog.
   */
  viewReportInline?: boolean;
  /**
   * Current-UI slice key to report this detail under. Omit to report
   * nothing (inline children, archived views).
   */
  uiStateKey?: string;
  /**
   * Host metadata added to the reported current-UI slice (a panel's owner,
   * panel id, and focus). Pass a referentially stable (memoized) object.
   */
  uiStateMetadata?: Readonly<Record<string, AppAdvisorJson>>;
  /** Rendered above the body with the active execution's title. */
  renderHeader?: (context: PipelineExecutionDetailHeaderContext) => ReactNode;
  /**
   * A panel's collapsible job list: a toolbar toggle plus a rail that
   * collapses to a hover/focus preview. Omit for the static rail.
   */
  navigation?: PipelineDetailNavigation;
  /**
   * Replaces the default message when the run's snapshot could not be read
   * (a missing or removed run), so a host can offer recovery.
   */
  renderLoadFailed?: () => ReactNode;
  className?: string;
}

function defaultOpenWorker(workerId: string): void {
  useNavigationStore.getState().openWorkers(workerId);
}

function defaultOpenDefinition(link: PipelineEditDeepLink): void {
  useNavigationStore.getState().openPipelineEdit(link);
}

function selectionForTarget(
  target: PipelineExecutionDetailTarget | undefined,
): PipelineDetailsSelection {
  if (target?.entry === 'cost') return { entry: 'cost' };
  if (target?.entry === 'definition') return { entry: 'definition' };
  if (target?.jobId === undefined) return null;
  return target.variantJobId !== undefined
    ? { jobId: target.jobId, variantJobId: target.variantJobId }
    : { jobId: target.jobId };
}

/**
 * Controlled-or-uncontrolled state. A defined `value` is controlled and
 * changes are reported through `onChange`; otherwise the state is local and
 * `onChange` is still notified.
 */
function useControllableState<T>(
  value: T | undefined,
  onChange: ((next: T) => void) | undefined,
  initial: () => T,
): [T, (update: (previous: T) => T) => void] {
  const [local, setLocal] = useState<T>(initial);
  const controlled = value !== undefined;
  const current = controlled ? value : local;
  const currentRef = useRef(current);
  currentRef.current = current;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;
  const update = useCallback((updater: (previous: T) => T): void => {
    const next = updater(currentRef.current);
    currentRef.current = next;
    if (!controlledRef.current) {
      setLocal(next);
    }
    onChangeRef.current?.(next);
  }, []);
  return [current, update];
}

const EMPTY_STACK: readonly BreadcrumbEntry[] = [];

/** How long an inline report reveal keeps the report pinned to the top. */
const REPORT_PIN_SETTLE_MS = 1_000;

/** Input that ends a report pin: the user has taken over the scroll. */
const REPORT_PIN_CANCEL_EVENTS = [
  'wheel',
  'touchstart',
  'pointerdown',
  'keydown',
] as const;

/**
 * Keeps an inline report revealed at the top of its scroll `body` while the
 * content above it is still laying out. The reveal scrolls to the region's
 * position at that moment, but the Summary above the report (the flow graph
 * sizes itself from a measurement) can grow afterwards and push the report
 * back down. For a short settle window, each change in the body's content
 * height re-issues an instant scroll when the report has moved off the top.
 * The pin ends early, never fighting the user, on wheel, touch, pointer or
 * key input, and the returned cleanup ends it on unmount or a new request.
 * Uses the region's own window so a pop-out works; does nothing where that
 * window has no `ResizeObserver`.
 */
function keepReportPinned(
  region: HTMLElement,
  body: HTMLElement | null,
): () => void {
  const view = region.ownerDocument.defaultView;
  if (
    body === null ||
    view === null ||
    typeof view.ResizeObserver !== 'function'
  ) {
    return (): void => undefined;
  }
  // The body's direct child that holds the report: its height covers
  // everything above and below the region.
  let content: HTMLElement = region;
  while (content.parentElement !== null && content.parentElement !== body) {
    content = content.parentElement;
  }
  if (content.parentElement !== body) return (): void => undefined;

  let lastHeight = content.getBoundingClientRect().height;
  const observer = new view.ResizeObserver((): void => {
    const height = content.getBoundingClientRect().height;
    if (height === lastHeight) return;
    lastHeight = height;
    const offset =
      region.getBoundingClientRect().top - body.getBoundingClientRect().top;
    if (Math.abs(offset) > 1) {
      region.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  });
  observer.observe(content);

  const doc = region.ownerDocument;
  let ended = false;
  const settleTimer: { id?: number } = {};
  const end = (): void => {
    if (ended) return;
    ended = true;
    view.clearTimeout(settleTimer.id);
    observer.disconnect();
    for (const type of REPORT_PIN_CANCEL_EVENTS) {
      doc.removeEventListener(type, end, true);
    }
  };
  settleTimer.id = view.setTimeout(end, REPORT_PIN_SETTLE_MS);
  for (const type of REPORT_PIN_CANCEL_EVENTS) {
    doc.addEventListener(type, end, { capture: true, passive: true });
  }
  return end;
}

/** Trailing delay before a scroll offset is written to the session. */
const SCROLL_RETAIN_DELAY_MS = 150;

/**
 * Keeps the body's scroll offset in the host session (best effort) and
 * restores it when the body appears: on mount once the run is loaded, and
 * again when a hidden panel is revealed (its layout effects re-run). Without
 * a session it does nothing.
 */
function useRetainedBodyScroll(
  bodyRef: RefObject<HTMLDivElement | null>,
  ready: boolean,
): () => void {
  const session = usePipelineDetailSession();
  const writeSession = useSessionWriter();
  const latestRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const top = latestRef.current;
    if (top === null) return;
    latestRef.current = null;
    writeSession((previous) =>
      previous.scrollTop === top ? previous : { ...previous, scrollTop: top },
    );
  }, [writeSession]);

  useLayoutEffect(() => {
    if (!ready || session === null) return undefined;
    const top = session.read().scrollTop;
    const body = bodyRef.current;
    if (top !== undefined && body !== null) body.scrollTop = top;
    // Hidden or unmounted: keep the last offset seen, never a value read
    // from a body that is already hidden.
    return flush;
  }, [bodyRef, flush, ready, session]);

  return useCallback((): void => {
    const body = bodyRef.current;
    if (session === null || body === null) return;
    latestRef.current = body.scrollTop;
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(flush, SCROLL_RETAIN_DELAY_MS);
  }, [bodyRef, flush, session]);
}

/**
 * The full pipeline execution detail: breadcrumbs and rerun lineage, the
 * live action bar, the job navigation, and the Summary or job view with
 * matrix variants, attempts, nested runs, logs, reports, pause input, and
 * the advisor. It carries no window chrome, focus trapping, or document-wide
 * key handling, so the modal, the archived viewer, and pipeline panels can
 * all host it. Navigation callbacks only navigate; closing is the host's
 * decision.
 */
export function PipelineExecutionDetail({
  executionId,
  owner,
  detailEnabled = true,
  initialTarget,
  revealTarget,
  viewStack: viewStackProp,
  onViewStackChange,
  selection: selectionProp,
  onSelectionChange,
  statusFilter: statusFilterProp,
  onStatusFilterChange,
  idScope: idScopeProp,
  archivedSource,
  actions: actionsProp,
  onOpenWorker,
  onOpenDefinition,
  onNavigatedAway,
  viewReportInline = false,
  uiStateKey,
  uiStateMetadata,
  renderHeader,
  navigation,
  renderLoadFailed,
  className,
}: PipelineExecutionDetailProps): JSX.Element {
  const instanceId = useId();
  const idScope = idScopeProp ?? instanceId;
  const archived = archivedSource !== undefined;
  const resolvedOwner = useResolvedPipelineDetailOwner(owner);
  const ownActions = usePipelineExecutionActions();
  const actions = actionsProp ?? ownActions;

  const mountTarget = revealTarget ?? initialTarget;
  const [viewStack, updateViewStack] = useControllableState<
    readonly BreadcrumbEntry[]
  >(
    viewStackProp,
    onViewStackChange === undefined
      ? undefined
      : (next): void => onViewStackChange([...next]),
    () => mountTarget?.viewStack ?? EMPTY_STACK,
  );
  const [selectedJob, updateSelectedJob] =
    useControllableState<PipelineDetailsSelection>(
      selectionProp,
      onSelectionChange,
      () => selectionForTarget(mountTarget),
    );
  const runCost = usePipelineRunCostPanel();
  const costView = runCost?.value ?? null;
  const costCurrency = useCostCurrency();
  const hasCost = costView !== null && costView.run.agentStepCount > 0;
  const costReadPending =
    runCost !== null &&
    costView === null &&
    (runCost.status === 'idle' || runCost.status === 'loading');
  const costUnavailable = runCost === null || (!hasCost && !costReadPending);
  const costEntrySelected = isPipelineDetailsCostSelection(selectedJob);
  const visibleSelection =
    costEntrySelected && costUnavailable ? null : selectedJob;
  const selectedJobTarget =
    selectedJob !== null && 'jobId' in selectedJob ? selectedJob : null;
  useEffect(() => {
    if (costEntrySelected && costUnavailable) {
      updateSelectedJob(() => null);
    }
  }, [costEntrySelected, costUnavailable, updateSelectedJob]);
  const [statusFilter, updateStatusFilter] = useControllableState<
    JobStatus | 'all'
  >(statusFilterProp, onStatusFilterChange, () => 'all');
  const retainedChildSteps = useRetainedSessionValue(
    (session) => session.expandedChildSteps,
  );
  const writeSession = useSessionWriter();
  const [expandedChildSteps, setExpandedChildStepsState] = useState<
    Set<string>
  >(() => new Set(retainedChildSteps ?? []));
  const setExpandedChildSteps = useCallback(
    (next: Set<string>): void => {
      setExpandedChildStepsState(next);
      writeSession((previous) => ({
        ...previous,
        expandedChildSteps: Array.from(next),
      }));
    },
    [writeSession],
  );

  // Apply an explicit target to this mounted instance whenever its nonce
  // changes; the target present at mount is already the initial view.
  const revealRef = useRef(revealTarget);
  revealRef.current = revealTarget;
  const appliedRevealNonceRef = useRef(revealTarget?.nonce);
  const revealNonce = revealTarget?.nonce;
  useEffect(() => {
    const target = revealRef.current;
    if (
      target === undefined ||
      revealNonce === undefined ||
      appliedRevealNonceRef.current === revealNonce
    ) {
      return;
    }
    appliedRevealNonceRef.current = revealNonce;
    updateViewStack(() => target.viewStack ?? EMPTY_STACK);
    updateSelectedJob(() => selectionForTarget(target));
    // The explicit target must be visible, whatever filter was active.
    updateStatusFilter(() => 'all');
    setExpandedChildSteps(new Set());
  }, [
    revealNonce,
    setExpandedChildSteps,
    updateSelectedJob,
    updateStatusFilter,
    updateViewStack,
  ]);

  const activeExecutionId =
    viewStack.length > 0
      ? viewStack[viewStack.length - 1].executionId
      : executionId;

  const {
    summary,
    state,
    loadFailed,
    childSummaries,
    rootSummary,
    rerunSourceSummary,
    advisorSnapshot,
  } = usePipelineExecutionDetailData({
    rootExecutionId: executionId,
    activeExecutionId,
    owner: resolvedOwner,
    enabled: detailEnabled,
    archivedSource,
  });
  const handleAdvisorEvent = usePipelineRunsStore((s) => s.handleAdvisorEvent);

  // Live watchers for the run shown. The bridge is ref-counted and only
  // retained for live runs.
  const pipelineWatchers = usePipelineExecutionWatchers(
    archived
      ? null
      : {
          projectId: summary?.project_id ?? state?.project_id,
          worktreeId: summary?.worktree_id ?? state?.worktree_id,
          executionId: activeExecutionId,
          pipelineId: summary?.pipeline_id ?? state?.pipeline_id,
        },
  );

  useCurrentUiStateReporter(
    uiStateKey ?? null,
    uiStateKey === undefined || archived
      ? null
      : {
          ...buildPipelineDetailUiState({
            executionId: activeExecutionId,
            summary,
            state,
            selectedJobId: selectedJobTarget?.jobId,
          }),
          ...uiStateMetadata,
        },
  );

  const openWorker = useCallback(
    (workerId: string): void => {
      (onOpenWorker ?? defaultOpenWorker)(workerId);
      onNavigatedAway?.('worker');
    },
    [onNavigatedAway, onOpenWorker],
  );
  const openDefinition = useCallback(
    (link: PipelineEditDeepLink): void => {
      (onOpenDefinition ?? defaultOpenDefinition)(link);
      onNavigatedAway?.('definition');
    },
    [onNavigatedAway, onOpenDefinition],
  );

  // Selecting a matrix variant keeps the logical job selected and narrows the
  // detail view; `undefined` shows the group summary.
  const selectMatrixVariant = useCallback(
    (variantJobId: string | undefined): void => {
      updateSelectedJob((current) =>
        current === null || !('jobId' in current)
          ? null
          : { jobId: current.jobId, variantJobId },
      );
    },
    [updateSelectedJob],
  );
  const selectJob = useCallback(
    (target: PipelineDetailsSelection): void => {
      updateSelectedJob(() => target);
    },
    [updateSelectedJob],
  );
  // View Report, shown in place: go to the active run's Summary, then (once
  // its report region is mounted) bring the report into view. Each request
  // bumps the nonce so a repeat click reveals the report again.
  const reportRegionRef = useRef<HTMLDivElement | null>(null);
  const [reportRevealRequest, setReportRevealRequest] = useState(0);
  const appliedReportRevealRef = useRef(0);
  const showReportInline = useCallback((): void => {
    updateSelectedJob(() => null);
    setReportRevealRequest((current) => current + 1);
  }, [updateSelectedJob]);
  const navController = navigation?.controller;
  // A selection from the job list also closes its preview (the list stays
  // collapsed) and moves focus out of it.
  const selectFromNav = useCallback(
    (target: PipelineDetailsSelection): void => {
      selectJob(target);
      navController?.navigate();
    },
    [navController, selectJob],
  );
  const rootExecutionState = usePipelineRunsStore(
    (store) => store.statesById[executionId],
  );
  const costNavigator = useMemo<CostNavigator | undefined>(() => {
    if (runCost === null) return undefined;
    return {
      ...runCost.navigator,
      openPipelineJob: (scope, costExecutionId, jobId): void => {
        if (
          costExecutionId === activeExecutionId ||
          costExecutionId === executionId
        ) {
          if (costExecutionId === executionId) {
            updateViewStack(() => EMPTY_STACK);
          }
          const shownState =
            costExecutionId === activeExecutionId ? state : rootExecutionState;
          // A plain job is listed as its own single group; only a matrix
          // variant is selected under its group.
          const variantGroup = Object.entries(
            shownState?.job_groups ?? {},
          ).find(
            ([groupId, group]) =>
              group.kind === 'matrix' &&
              groupId !== jobId &&
              group.variant_job_ids.includes(jobId),
          );
          selectJob(
            variantGroup === undefined
              ? { jobId }
              : { jobId: variantGroup[0], variantJobId: jobId },
          );
          navController?.navigate();
          return;
        }
        runCost.navigator.openPipelineJob?.(scope, costExecutionId, jobId);
      },
    };
  }, [
    activeExecutionId,
    executionId,
    navController,
    rootExecutionState,
    runCost,
    selectJob,
    state,
    updateViewStack,
  ]);
  const openDefinitionFromNav = useCallback(
    (link: PipelineEditDeepLink): void => {
      navController?.navigate();
      openDefinition(link);
    },
    [navController, openDefinition],
  );
  const navId = `${idScope}-pipeline-jobs`;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const setBodyElement = useCallback(
    (element: HTMLDivElement | null): void => {
      bodyRef.current = element;
      navController?.setContentElement(element);
    },
    [navController],
  );
  const jobOrder = useMemo<string[]>(
    () => Object.keys(state?.pipeline_snapshot.jobs ?? {}),
    [state],
  );
  // Definition used: the snapshot the run started with, converted only while
  // the entry is shown (the conversion dumps the canonical YAML).
  const definitionSelected = isPipelineDetailsDefinitionSelection(selectedJob);
  const pipelineSnapshot = state?.pipeline_snapshot;
  const definitionUsed = useMemo(
    () =>
      definitionSelected && pipelineSnapshot !== undefined
        ? toPipelineRunDefinitionViewModel(pipelineSnapshot)
        : null,
    [definitionSelected, pipelineSnapshot],
  );

  const expandedChildStepsRef = useRef(expandedChildSteps);
  expandedChildStepsRef.current = expandedChildSteps;
  const toggleChildStep = useCallback(
    (stepInstanceKey: string): void => {
      const next = new Set(expandedChildStepsRef.current);
      if (next.has(stepInstanceKey)) {
        next.delete(stepInstanceKey);
      } else {
        next.add(stepInstanceKey);
      }
      expandedChildStepsRef.current = next;
      setExpandedChildSteps(next);
    },
    [setExpandedChildSteps],
  );

  const renderChildExecution = useCallback(
    (childExecutionId: string): JSX.Element => (
      <div className="pt-1 pl-2">
        <PipelineExecutionInlineDetail
          executionId={childExecutionId}
          owner={resolvedOwner}
          detailEnabled={detailEnabled}
          archivedSource={archivedSource}
          onViewWorker={archived ? undefined : openWorker}
        />
      </div>
    ),
    [archived, archivedSource, detailEnabled, openWorker, resolvedOwner],
  );

  const navigateToBreadcrumb = useCallback(
    (index: number): void => {
      // index -1 = root, 0 = first child, etc.
      updateViewStack((prev) =>
        index < 0 ? EMPTY_STACK : prev.slice(0, index + 1),
      );
      setExpandedChildSteps(new Set());
    },
    [setExpandedChildSteps, updateViewStack],
  );

  // Drill into a child pipeline: push it onto the breadcrumb stack so the
  // detail re-focuses on the child run (its own Summary).
  const drillIntoChild = useCallback(
    (childExecutionId: string, label: string): void => {
      updateViewStack((prev) => [
        ...prev,
        { executionId: childExecutionId, label },
      ]);
      updateSelectedJob(() => null);
      setExpandedChildSteps(new Set());
    },
    [setExpandedChildSteps, updateSelectedJob, updateViewStack],
  );

  const [startingAdvisorExecutionId, setStartingAdvisorExecutionId] = useState<
    string | null
  >(null);
  const [advisorStartError, setAdvisorStartError] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setAdvisorStartError(null);
    setStartingAdvisorExecutionId(null);
  }, [activeExecutionId]);

  const runAdvisorForActiveExecution = useCallback(async (): Promise<void> => {
    setAdvisorStartError(null);
    setStartingAdvisorExecutionId(activeExecutionId);
    try {
      const result = await window.pipelines.runAdvisor(activeExecutionId);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to start Workflow Advisor');
      }
      handleAdvisorEvent({
        executionId: activeExecutionId,
        snapshot: result.data,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      setAdvisorStartError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setStartingAdvisorExecutionId((current) =>
        current === activeExecutionId ? null : current,
      );
    }
  }, [activeExecutionId, handleAdvisorEvent]);

  const title =
    state?.pipeline_snapshot.name ?? summary?.pipeline_name ?? 'Workflow run';
  const rootLabel =
    viewStack.length > 0
      ? (rootSummary?.pipeline_name ?? 'Workflow run')
      : title;

  const handleBodyScroll = useRetainedBodyScroll(bodyRef, state !== undefined);
  const renderNav = (nav: JSX.Element): ReactNode =>
    navigation === undefined ? (
      nav
    ) : (
      <PipelineCollapsibleNav navigation={navigation}>
        {nav}
      </PipelineCollapsibleNav>
    );

  // Runs after the commit that selected Summary: the report region is
  // mounted by then. A request that did not land on Summary (a host that
  // declined the selection) or has no region is dropped, never deferred, so
  // it cannot scroll later for an unrelated navigation. The cleanup ends the
  // settle-window pin on unmount, a new request or a new selection.
  useEffect((): (() => void) | undefined => {
    if (reportRevealRequest === appliedReportRevealRef.current)
      return undefined;
    appliedReportRevealRef.current = reportRevealRequest;
    const region = reportRegionRef.current;
    if (visibleSelection !== null || region === null) return undefined;
    const reduceMotion =
      region.ownerDocument.defaultView?.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches === true;
    region.scrollIntoView({
      block: 'start',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
    // Keyboard users continue from the report; the scroll is already under
    // way, so focusing must not jump it.
    region.focus({ preventScroll: true });
    return keepReportPinned(region, bodyRef.current);
  }, [reportRevealRequest, visibleSelection]);

  const pauseResumeContent =
    archived || state === undefined ? null : (
      <PipelinePauseResumeContent
        executionId={activeExecutionId}
        state={state}
        idScope={idScope}
      />
    );

  return (
    <div
      // Dialogs the detail's own controller opens use this document.
      ref={actionsProp === undefined ? ownActions.dialogAnchorRef : undefined}
      className={className ?? 'flex min-h-0 min-w-0 flex-1 flex-col'}
      data-testid="pipeline-execution-detail"
      data-execution-id={executionId}
      data-active-execution-id={activeExecutionId}
    >
      {renderHeader?.({ title, activeExecutionId, state, summary })}
      {(viewStack.length > 0 || state?.rerun_source_id) && (
        <Surface variant="section" boundary="bottom" className="shrink-0">
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2 text-xs">
            {viewStack.length > 0 && (
              <CustomizeBreadcrumbs
                items={[
                  {
                    key: 'root',
                    label: rootLabel,
                    onSelect: () => navigateToBreadcrumb(-1),
                  },
                  ...viewStack.map((entry, index) => ({
                    key: entry.executionId,
                    label: entry.label,
                    onSelect: () => navigateToBreadcrumb(index),
                  })),
                ]}
              />
            )}
            {state?.rerun_source_id && (
              <span className="text-2xs fg-secondary">
                Started over from{' '}
                <span className="font-medium fg-primary/80">
                  {rerunSourceSummary?.pipeline_name ??
                    state.rerun_source_id.slice(0, 8)}
                </span>
              </span>
            )}
          </div>
        </Surface>
      )}

      {!state && loadFailed && renderLoadFailed !== undefined ? (
        renderLoadFailed()
      ) : !state ? (
        <div className="flex min-h-80 flex-1 items-center justify-center gap-3 p-6 text-s fg-secondary">
          {loadFailed ? (
            'Failed to load execution details.'
          ) : (
            <>
              <LoadingSpinner tone="active" />
              Loading execution details…
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {archived ? null : (
            <PipelineExecutionActionBar
              executionId={activeExecutionId}
              state={state}
              summary={summary}
              actions={actions}
              watchers={pipelineWatchers}
              onNavigatedAway={onNavigatedAway}
              onViewReport={viewReportInline ? showReportInline : undefined}
              leading={
                navigation === undefined ? undefined : (
                  <PipelineNavToggleZone
                    navigation={navigation}
                    navId={navId}
                  />
                )
              }
            />
          )}
          <div
            // `relative isolate`: the job-list preview overlays the body
            // within this row only, never the panel's tab bar or a sibling.
            className="relative isolate flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden"
          >
            {renderNav(
              <PipelineDetailsNav
                id={navigation === undefined ? undefined : navId}
                state={state}
                jobOrder={jobOrder}
                selected={visibleSelection}
                costEntry={
                  hasCost && costView !== null
                    ? {
                        amount: formatCostTotalIn(
                          costView.run.totals,
                          costCurrency,
                        ),
                      }
                    : undefined
                }
                statusFilter={statusFilter}
                onSelect={selectFromNav}
                onStatusFilter={(s): void => {
                  updateStatusFilter(() => s);
                  // A matrix group survives a filter when one variant matches.
                  if (
                    selectedJobTarget !== null &&
                    s !== 'all' &&
                    state.job_groups[selectedJobTarget.jobId]?.status !== s &&
                    !state.job_groups[
                      selectedJobTarget.jobId
                    ]?.variant_job_ids.some(
                      (physicalId) => state.jobs[physicalId]?.status === s,
                    )
                  ) {
                    updateSelectedJob(() => null);
                  }
                }}
                onOpenDefinition={openDefinitionFromNav}
              />,
            )}
            <div
              ref={setBodyElement}
              // Focus target after a keyboard selection from the job-list
              // preview; not a tab stop.
              tabIndex={navigation === undefined ? undefined : -1}
              onScroll={handleBodyScroll}
              className="min-w-0 flex-1 overflow-y-auto focus:outline-none"
              data-testid="pipeline-execution-detail-body"
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto p-5 pt-4">
                {visibleSelection === null ? (
                  <>
                    {pauseResumeContent}
                    {state.error && (
                      <Notice
                        errorSource="pipeline-execution-detail"
                        className=""
                        intent="destructive"
                        title="Execution error"
                      >
                        <span className="whitespace-pre-wrap break-words font-mono">
                          {state.error}
                        </span>
                      </Notice>
                    )}
                    <PipelineSummaryView
                      state={state}
                      jobOrder={jobOrder}
                      advisorSnapshot={advisorSnapshot}
                      advisorRunning={
                        startingAdvisorExecutionId === activeExecutionId
                      }
                      onRunAdvisor={() => {
                        void runAdvisorForActiveExecution();
                      }}
                      advisorStartError={advisorStartError}
                      onSelectJob={(jobId): void => selectJob({ jobId })}
                      hideAdvisor={archived}
                      costPreviewSlot={
                        hasCost &&
                        costView !== null &&
                        runCost !== null &&
                        activeExecutionId === executionId ? (
                          <div data-testid="pipeline-summary-cost-preview">
                            <Suspense fallback={null}>
                              <LazyPipelineRunCostPreviewCard
                                client={runCost.client}
                                scope={runCost.scope}
                                executionId={executionId}
                                store={runCost.store}
                                onOpen={(): void =>
                                  selectFromNav({ entry: 'cost' })
                                }
                              />
                            </Suspense>
                          </div>
                        ) : null
                      }
                      reportSlot={
                        <div
                          ref={reportRegionRef}
                          // Focus target for an inline View Report; not a
                          // tab stop.
                          tabIndex={-1}
                          role="region"
                          aria-label="Report"
                          className="focus-ring focus-ring-inset rounded-xl"
                          data-testid="pipeline-report-region"
                        >
                          {state.report_outputs ? (
                            <PipelineReportView
                              executionId={activeExecutionId}
                              reportOutputs={state.report_outputs}
                              archivedSource={archivedSource}
                            />
                          ) : (
                            <EmptyState title="No report has been generated for this run yet." />
                          )}
                        </div>
                      }
                    />
                  </>
                ) : isPipelineDetailsDefinitionSelection(visibleSelection) ? (
                  <PipelineRunDefinitionUsed definition={definitionUsed} />
                ) : isPipelineDetailsCostSelection(visibleSelection) ? (
                  runCost !== null && costNavigator !== undefined ? (
                    <div data-testid="pipeline-cost-view">
                      <Suspense fallback={null}>
                        <LazyPipelineRunCostView
                          client={runCost.client}
                          navigator={costNavigator}
                          scope={runCost.scope}
                          executionId={executionId}
                          store={runCost.store}
                        />
                      </Suspense>
                    </div>
                  ) : null
                ) : (
                  <>
                    {/* Pause/resume stays reachable here so a paused run can
                        be resumed while a job is selected. Run-level metadata,
                        advisor, and error live on the Summary view only. */}
                    {pauseResumeContent}
                    <PipelineJobView
                      state={state}
                      jobId={visibleSelection.jobId}
                      executionId={activeExecutionId}
                      childSummaries={childSummaries}
                      expandedChildSteps={expandedChildSteps}
                      onToggleChildStep={toggleChildStep}
                      renderChildExecution={renderChildExecution}
                      onViewWorker={archived ? undefined : openWorker}
                      onDrillIntoChild={drillIntoChild}
                      selectedMatrixVariantId={visibleSelection.variantJobId}
                      onSelectMatrixVariant={selectMatrixVariant}
                      archivedSource={archivedSource}
                      logsEnabled={detailEnabled}
                      stepCosts={
                        hasCost ? (costView?.steps ?? undefined) : undefined
                      }
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {actionsProp === undefined && !archived ? ownActions.dialogs : null}
    </div>
  );
}
