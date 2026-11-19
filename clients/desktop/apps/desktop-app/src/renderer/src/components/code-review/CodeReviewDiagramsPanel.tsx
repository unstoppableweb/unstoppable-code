import { HeaderActionButton } from '@canopy/ui-shared';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { RefreshSpinner } from '@/components/shared/loading/spinners/RefreshSpinner';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import type {
  CodeReviewArtifact,
  CodeReviewFile,
} from '@canopy/desktop-shared/types';
import type { PlanDiagramArtifact } from '@canopy/desktop-shared/types/plan-diagrams';
import { PlanLogicDiffDiagram } from '@/components/plan-explore/diagram/PlanLogicDiffDiagram';
import { PlanDataModelDiffDiagram } from '@/components/plan-explore/diagram/PlanDataModelDiffDiagram';
import { usePlanDiagramViews } from '@/components/plan-explore/diagram/usePlanDiagramViews';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import type { AddNodeCommentInput } from '@/components/plan-explore/usePlanComments';
import {
  Surface,
  Stack,
  Button,
  SegmentedControl,
  Heading,
} from '@canopy/ui-shared/components';

type DiagramsTab = 'logicDiff' | 'dataModelDiff';

/** Request to switch to a diagram and reveal/select a node (e.g. from a
 * bottom-tray diagram comment). `requestId` is a monotonic token so repeating
 * the same node re-triggers the reveal. */
export interface DiagramNodeRevealRequest {
  requestId: number;
  diagramKind: DiagramsTab;
  nodeId: string;
}

export interface CodeReviewDiagramsPanelProps {
  review: CodeReviewFile | null;
  readOnly?: boolean;
  /** Whether the review has been armed (annotation/diagram generation requested at least once). */
  armed: boolean;
  /** Arm the review, kicking off the first annotation/diagram generation run. */
  onArm: () => void;
  /** Re-run annotation/diagram generation for the current branch diff. */
  onRefresh: () => void;
  /** Immediate request state before persisted generation status arrives. */
  refreshing?: boolean;
  /** Stage a comment anchored to a diagram node (routed through useReviewComments). */
  onAddNodeComment?: (input: AddNodeCommentInput) => void;
  /** Switch to the node's diagram and reveal it (bottom-tray diagram jump). */
  revealNodeRequest?: DiagramNodeRevealRequest | null;
  /** Re-run host-owned search when the active diagram or its artifact changes. */
  onSearchContextChange?: () => void;
}

/**
 * Adapts a code-review artifact envelope (fingerprint-keyed) to the plan
 * diagram renderers' envelope shape (revision-keyed) so
 * `PlanLogicDiffDiagram`/`PlanDataModelDiffDiagram` can be reused without any
 * changes to those components. `derivedFromRevision` is display-inert in
 * both renderers — it is never read outside their own test fixtures — so a
 * constant `0` is safe here.
 */
function toPlanArtifact<T>(
  artifact: CodeReviewArtifact<T> | undefined,
): PlanDiagramArtifact<T> | undefined {
  if (!artifact) {
    return undefined;
  }
  return {
    data: artifact.data,
    derivedFromRevision: 0,
    status: artifact.status,
    ...(artifact.generatedAt !== undefined
      ? { generatedAt: artifact.generatedAt }
      : {}),
    ...(artifact.error !== undefined ? { error: artifact.error } : {}),
  };
}

/** Workspace diagram type picker, with host actions beside the highest visible row.
 * The optional Data Model artifact controls type availability; its removal
 * falls back to Logic. Search and comment reveal target the active diagram.
 */
export const CodeReviewDiagramsPanel = forwardRef<
  DiagramSearchHandle,
  CodeReviewDiagramsPanelProps
>(function CodeReviewDiagramsPanel(
  {
    review,
    readOnly = false,
    armed,
    onArm,
    onRefresh,
    refreshing = false,
    onAddNodeComment,
    revealNodeRequest,
    onSearchContextChange,
  },
  ref,
): JSX.Element {
  const [activeTab, setActiveTab] = useState<DiagramsTab>('logicDiff');
  // Diagram code loads on demand; until it has, no diagram handle exists.
  const diagramsLoaded = usePlanDiagramViews() !== null;

  const logicDiffSearchRef = useRef<DiagramSearchHandle | null>(null);
  const dataModelSearchRef = useRef<DiagramSearchHandle | null>(null);

  const logicDiff = review?.diagrams.logicDiff;
  const dataModelDiff = review?.diagrams.dataModelDiff;
  const annotations = review?.annotations;

  // The Data Model artifact stays absent until generation writes an
  // applicable result (no placeholder for first-time generation), and the
  // backend removes it again when a revised branch is no longer
  // schema-touching.
  const dataModelPresent = dataModelDiff !== undefined;

  // Active-tab fallback: if the Data Model artifact disappears (branch
  // became non-schema-touching) while its tab is active, resolve to Logic.
  // Derived during render so the tab/content never flash blank, and
  // reconciled into state below so search routing stays correct.
  const resolvedTab: DiagramsTab =
    activeTab === 'dataModelDiff' && !dataModelPresent
      ? 'logicDiff'
      : activeTab;
  const activeArtifact =
    resolvedTab === 'dataModelDiff' ? dataModelDiff : logicDiff;

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

  const activeRef = useCallback((): RefObject<DiagramSearchHandle | null> => {
    return resolvedTab === 'dataModelDiff'
      ? dataModelSearchRef
      : logicDiffSearchRef;
  }, [resolvedTab]);

  // Apply a "reveal this node" request (bottom-tray diagram jump): switch to
  // the node's diagram if needed, then reveal it once that tab is mounted. If
  // the tab isn't active yet, `setActiveTab` re-renders and this effect re-runs
  // when `resolvedTab` updates. A data-model node with no data-model artifact
  // falls back to the Logic tab (the node simply won't be found there).
  useEffect(() => {
    if (!revealNodeRequest) {
      return undefined;
    }
    const targetTab: DiagramsTab =
      revealNodeRequest.diagramKind === 'dataModelDiff' && dataModelPresent
        ? 'dataModelDiff'
        : 'logicDiff';
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
        logicDiffSearchRef.current?.clear();
        dataModelSearchRef.current?.clear();
      },
    }),
    [activeRef],
  );

  const isGenerating =
    refreshing ||
    logicDiff?.status === 'generating' ||
    dataModelDiff?.status === 'generating' ||
    annotations?.status === 'generating';

  const hasGeneratedDiagram = Boolean(logicDiff?.data || dataModelDiff?.data);
  const refreshAction = hasGeneratedDiagram ? (
    <HeaderActionButton
      iconOnly
      tone="neutral"
      aria-label="Refresh diagram"
      data-testid="change-diagram-refresh"
      disabled={readOnly || isGenerating}
      onClick={onRefresh}
    >
      <RefreshSpinner spinning={isGenerating} />
    </HeaderActionButton>
  ) : null;

  const hasAnyArtifact = logicDiff !== undefined || dataModelDiff !== undefined;

  if (!armed && !hasAnyArtifact) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col items-center justify-center overflow-hidden p-8">
        <div className="flex flex-col max-w-md text-center gap-5">
          <Stack gap="tight">
            <Heading level={2} variant="section">
              Review this branch
            </Heading>
            <p className="text-s fg-secondary">
              Generate annotations and diagrams for the branch&apos;s changes.
            </p>
          </Stack>
          <Button
            className="self-center"
            variant="primary"
            onClick={onArm}
            disabled={readOnly}
            data-testid="code-review-start"
          >
            Start review
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {dataModelPresent && (
        <Surface variant="section" boundary="bottom" className="shrink-0">
          <div
            data-testid="change-diagram-type-row"
            className="flex shrink-0 items-center gap-1 px-2 py-1.5"
          >
            <SegmentedControl
              label="Diagram type"
              semantics="tabs"
              width="content"
              value={resolvedTab}
              onChange={setActiveTab}
              options={[
                { value: 'logicDiff', label: 'Logic' },
                ...(dataModelPresent
                  ? [
                      {
                        value: 'dataModelDiff' as const,
                        label: 'Data model',
                        dataTestId: 'code-review-data-model-tab',
                      },
                    ]
                  : []),
              ]}
            />
            <div className="ml-auto">{refreshAction}</div>
          </div>
        </Surface>
      )}

      {/* The diagrams are derived from the diff: blocked from session replay.
          The diagram type tabs stay recorded. This element mounts with the
          diagrams, so the block is in place before any node is recorded. */}
      <div
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
      >
        {resolvedTab === 'logicDiff' && (
          <PlanLogicDiffDiagram
            ref={logicDiffSearchRef}
            artifact={toPlanArtifact(logicDiff)}
            onGenerate={readOnly ? undefined : onRefresh}
            isGenerating={isGenerating}
            onAddNodeComment={onAddNodeComment}
            commentsReadOnly={readOnly}
            viewLabels={{ current: 'Before', planned: 'After' }}
            toolbarActions={!dataModelPresent ? refreshAction : undefined}
          />
        )}
        {resolvedTab === 'dataModelDiff' && (
          <PlanDataModelDiffDiagram
            ref={dataModelSearchRef}
            artifact={toPlanArtifact(dataModelDiff)}
            onGenerate={readOnly ? undefined : onRefresh}
            isGenerating={isGenerating}
            onAddNodeComment={onAddNodeComment}
            commentsReadOnly={readOnly}
          />
        )}
      </div>
    </div>
  );
});

CodeReviewDiagramsPanel.displayName = 'CodeReviewDiagramsPanel';
