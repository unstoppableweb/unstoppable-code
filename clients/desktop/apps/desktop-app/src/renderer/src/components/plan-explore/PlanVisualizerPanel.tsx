import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { RefreshSpinner } from '../shared/loading/spinners/RefreshSpinner';
import { PlanSequenceDiagram } from './diagram/PlanSequenceDiagram';
import { PlanLogicDiffDiagram } from './diagram/PlanLogicDiffDiagram';
import { PlanDataModelDiffDiagram } from './diagram/PlanDataModelDiffDiagram';
import { usePlanDiagramViews } from './diagram/usePlanDiagramViews';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import type { AddNodeCommentInput } from './usePlanComments';
import {
  Surface,
  Button,
  SegmentedControl,
} from '@canopy/ui-shared/components';

type VisualizerTab = 'sequence' | 'logicDiff' | 'dataModelDiff';

/** Request to switch to a diagram and reveal/select a node (e.g. from the
 * bottom comments tray's diagram-anchored jump). `requestId` is a monotonic
 * token so repeating the same node re-triggers the reveal. Mirrors
 * `CodeReviewDiagramsPanel.tsx`'s `DiagramNodeRevealRequest`. */
export interface DiagramNodeRevealRequest {
  requestId: number;
  diagramKind: VisualizerTab;
  nodeId: string;
}

export interface PlanVisualizerPanelProps {
  plan: TrackedPlanData;
  /** Stage a comment anchored to a diagram node (routed through usePlanComments). */
  onAddNodeComment?: (input: AddNodeCommentInput) => void;
  /** Switch to the node's diagram and reveal it (bottom-tray diagram jump). */
  revealNodeRequest?: DiagramNodeRevealRequest | null;
  /**
   * The shown diagram changed (another tab or artifact, or its code finished
   * loading), so an open find re-runs its query against it.
   */
  onSearchContextChange?: () => void;
}

/**
 * Tabbed visualizer column for the Explore modal. The Sequence tab renders the
 * generated parsed-plan dependency diagram; the Current/Planned/Diff tab renders
 * the generated logic diff diagram; and the conditionally-shown Data Model tab
 * renders the generated ERD data model diff diagram. A toolbar button generates
 * the diagrams on demand (for plans that have none yet) or refreshes them.
 *
 * The Data Model tab is shown only when an applicable `dataModelDiff` artifact
 * exists, because the backend persists no placeholder for first-time generation;
 * if a refresh determines the plan is no longer applicable and the artifact is
 * removed, the tab disappears and the active tab falls back so the panel is
 * never left blank.
 *
 * Exposes a `DiagramSearchHandle` that delegates to the currently-active tab's
 * diagram so the find bar's diagram mode searches the visible diagram.
 */
export const PlanVisualizerPanel = forwardRef<
  DiagramSearchHandle,
  PlanVisualizerPanelProps
>(function PlanVisualizerPanel(
  { plan, onAddNodeComment, revealNodeRequest, onSearchContextChange },
  ref,
): JSX.Element {
  const [activeTab, setActiveTab] = useState<VisualizerTab>('sequence');
  // Diagram code loads on demand; until it has, no diagram handle exists.
  const diagramsLoaded = usePlanDiagramViews() !== null;

  const sequenceSearchRef = useRef<DiagramSearchHandle | null>(null);
  const logicDiffSearchRef = useRef<DiagramSearchHandle | null>(null);
  const dataModelSearchRef = useRef<DiagramSearchHandle | null>(null);

  const sequence = plan.diagrams?.sequence;
  const logicDiff = plan.diagrams?.logicDiff;
  const dataModelDiff = plan.diagrams?.dataModelDiff;

  // The Data Model artifact stays absent until generation writes an applicable
  // result (no placeholder for first-time generation), and the backend removes
  // it again when a revised plan is no longer applicable.
  const dataModelPresent = dataModelDiff !== undefined;

  // Active-tab fallback: if the Data Model artifact disappears (plan became
  // non-applicable) while its tab is active, resolve to logicDiff (else
  // sequence). Derived during render so the tab/content never flash blank, and
  // reconciled into state below so search routing stays correct.
  const resolvedTab: VisualizerTab =
    activeTab === 'dataModelDiff' && !dataModelPresent
      ? logicDiff !== undefined
        ? 'logicDiff'
        : 'sequence'
      : activeTab;

  const activeArtifact = plan.diagrams?.[resolvedTab];

  useEffect(() => {
    if (resolvedTab !== activeTab) {
      setActiveTab(resolvedTab);
    }
  }, [resolvedTab, activeTab]);

  useEffect(() => {
    if (diagramsLoaded) {
      onSearchContextChange?.();
    }
  }, [activeArtifact, onSearchContextChange, resolvedTab, diagramsLoaded]);

  const activeRef =
    useCallback((): React.RefObject<DiagramSearchHandle | null> => {
      if (resolvedTab === 'dataModelDiff') {
        return dataModelSearchRef;
      }
      if (resolvedTab === 'logicDiff') {
        return logicDiffSearchRef;
      }
      return sequenceSearchRef;
    }, [resolvedTab]);

  // Apply a "reveal this node" request (bottom-tray diagram jump): switch to
  // the node's diagram if needed, then reveal it once that tab is mounted. If
  // the tab isn't active yet, `setActiveTab` re-renders and this effect
  // re-runs when `resolvedTab` updates. A data-model node with no data-model
  // artifact falls back to the Logic tab (else Sequence); the node simply
  // won't be found there. Mirrors `CodeReviewDiagramsPanel.tsx`.
  useEffect(() => {
    if (!revealNodeRequest) {
      return undefined;
    }
    const targetTab: VisualizerTab =
      revealNodeRequest.diagramKind === 'dataModelDiff' && dataModelPresent
        ? 'dataModelDiff'
        : revealNodeRequest.diagramKind === 'dataModelDiff'
          ? logicDiff !== undefined
            ? 'logicDiff'
            : 'sequence'
          : revealNodeRequest.diagramKind;
    if (resolvedTab !== targetTab) {
      setActiveTab(targetTab);
      return undefined;
    }
    if (!diagramsLoaded) {
      // Re-runs once the diagram code has loaded and the handle is attached.
      return undefined;
    }
    const nodeId = revealNodeRequest.nodeId;
    const frame = window.requestAnimationFrame(() => {
      activeRef().current?.reveal(nodeId);
    });
    return (): void => window.cancelAnimationFrame(frame);
  }, [
    revealNodeRequest,
    resolvedTab,
    dataModelPresent,
    logicDiff,
    activeRef,
    diagramsLoaded,
  ]);

  useImperativeHandle(
    ref,
    (): DiagramSearchHandle => ({
      search: (query: string): string[] =>
        activeRef().current?.search(query) ?? [],
      reveal: (nodeId: string): void => activeRef().current?.reveal(nodeId),
      clear: (): void => {
        sequenceSearchRef.current?.clear();
        logicDiffSearchRef.current?.clear();
        dataModelSearchRef.current?.clear();
      },
    }),
    [activeRef],
  );

  // The backend marks artifacts 'generating', but that status only arrives after
  // a main→renderer round-trip. `requested` provides instant optimistic feedback
  // the moment the user clicks, and is handed off to the backend status as soon
  // as ANY diagram update arrives — including a failure that goes straight to
  // 'error' — with a safety timeout so the control never sticks if a run never
  // starts.
  const [requested, setRequested] = useState(false);
  const requestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedDiagramsRef = useRef<TrackedPlanData['diagrams']>(
    plan.diagrams,
  );

  const backendGenerating = useMemo(
    () =>
      sequence?.status === 'generating' ||
      logicDiff?.status === 'generating' ||
      dataModelDiff?.status === 'generating',
    [sequence?.status, logicDiff?.status, dataModelDiff?.status],
  );
  const isGenerating = requested || backendGenerating;

  // Clear the optimistic flag once the backend pushes any change to the diagrams
  // (the first 'generating' write, or an immediate 'error'/'ready'). Comparing
  // object identity catches every transition, including failed runs.
  useEffect(() => {
    if (requested && plan.diagrams !== requestedDiagramsRef.current) {
      setRequested(false);
    }
  }, [requested, plan.diagrams]);

  useEffect(
    () => (): void => {
      if (requestTimer.current) {
        clearTimeout(requestTimer.current);
      }
    },
    [],
  );

  // No artifact has ever been produced (or scheduled) for this plan.
  const hasAnyDiagram =
    sequence !== undefined ||
    logicDiff !== undefined ||
    dataModelDiff !== undefined;

  // Conditional tab: present whenever the artifact exists. A refresh keeps the
  // prior artifact (and its data) defined, so the tab is never yanked mid-update;
  // only a non-applicability removal clears it (handled by the fallback above).
  const showDataModelTab = dataModelPresent;

  const handleGenerate = useCallback((): void => {
    // Block only re-clicks within the optimistic window. A stale backend
    // 'generating' status (e.g. left over from a run that never finished) stays
    // retryable so the user is never stuck.
    if (requested) {
      return;
    }
    requestedDiagramsRef.current = plan.diagrams;
    setRequested(true);
    if (requestTimer.current) {
      clearTimeout(requestTimer.current);
    }
    requestTimer.current = setTimeout(() => setRequested(false), 12_000);
    void window.api.activity.plans.generateDiagrams({
      projectId: plan.projectId,
      worktreeId: plan.worktreeId,
      planId: plan.id,
    });
  }, [requested, plan.diagrams, plan.projectId, plan.worktreeId, plan.id]);

  const generateLabel = isGenerating
    ? 'Generating…'
    : hasAnyDiagram
      ? 'Refresh'
      : 'Generate diagrams';

  return (
    <div
      data-testid="plan-explore-visualizer-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {/* Wraps in a narrow plan panel so Refresh stays reachable. */}
      <Surface variant="section" boundary="bottom" className="shrink-0">
        <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-1.5">
          <SegmentedControl
            label="Diagram type"
            semantics="tabs"
            width="content"
            value={resolvedTab}
            onChange={setActiveTab}
            options={[
              { value: 'sequence', label: 'Sequence' },
              { value: 'logicDiff', label: 'Current/Planned/Diff' },
              ...(showDataModelTab
                ? [
                    {
                      value: 'dataModelDiff' as const,
                      label: 'Data model',
                      dataTestId: 'plan-visualizer-data-model-tab',
                    },
                  ]
                : []),
            ]}
          />
          <Button
            size="compact"
            className="ml-auto"
            data-testid="plan-visualizer-generate"
            onClick={handleGenerate}
            disabled={requested}
          >
            <RefreshSpinner spinning={isGenerating} size="sm" />
            {generateLabel}
          </Button>
        </div>
      </Surface>

      {/* The plan diagrams: blocked from session replay. The diagram tabs
          and the generate action stay recorded. */}
      <div
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
      >
        {resolvedTab === 'sequence' && (
          <PlanSequenceDiagram
            ref={sequenceSearchRef}
            artifact={sequence}
            onGenerate={handleGenerate}
            isGenerating={isGenerating}
            onAddNodeComment={onAddNodeComment}
          />
        )}
        {resolvedTab === 'logicDiff' && (
          <PlanLogicDiffDiagram
            ref={logicDiffSearchRef}
            artifact={logicDiff}
            onGenerate={handleGenerate}
            isGenerating={isGenerating}
            onAddNodeComment={onAddNodeComment}
          />
        )}
        {resolvedTab === 'dataModelDiff' && (
          <PlanDataModelDiffDiagram
            ref={dataModelSearchRef}
            artifact={dataModelDiff}
            onGenerate={handleGenerate}
            isGenerating={isGenerating}
            onAddNodeComment={onAddNodeComment}
          />
        )}
      </div>
    </div>
  );
});

PlanVisualizerPanel.displayName = 'PlanVisualizerPanel';
