import { Surface } from '@canopy/ui-shared/components';
import { focusPipelineAssistantComposer } from '@/lib/pipelineAssistantEvents';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  projectWorkflowStack,
  workflowStackEditableKeys,
  workflowStackPathJobs,
  workflowStackPathsOf,
} from '@canopy/pipeline-interop/workflow-designer';
import {
  readWorkflowSplit,
  routerLacksInput,
} from '@canopy/pipeline-interop/workflow-designer-split';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { createJobId, type ValidationIssue } from '../../lib/pipelineEditor';
import {
  Notice,
  NoticeButton,
  NoticeList,
  NoticeListItem,
  type NoticeIntent,
  ResizeRailIndicator,
} from '@canopy/ui-shared/components';
import { PipelineReadDetail } from '@canopy/ui-app';
import {
  mayRunBuiltinAction,
  SharedPipelineNotice,
  WorkflowDesigner,
  WorkflowTriggerPanel,
  type WorkflowTriggerSchedule,
} from '@canopy/ui-app/workflows';
import { PipelineDetailPanelShell } from './steps/PipelinePanelPrimitives';
import { useDesignerTrigger } from './useDesignerTrigger';
import {
  PipelineSettingsPanel,
  type PipelineSettingsTriggerFacts,
} from './PipelineSettingsPanel';
import { RawYamlView } from './RawYamlView';
import { PipelinePublicShareRow } from './PipelinePublicShareRow';
import type {
  EntryDetailReturnContext,
  PipelineReturnTarget,
} from '@/stores/navigationStore';
import { JobList } from './steps/JobList';
import { JobDetailPanel } from './steps/JobDetailPanel';
import { StepDetailPanel, type StepSendAsField } from './steps/StepDetailPanel';
import { SplitDetailPanel } from './steps/SplitDetailPanel';
import { PipelineFlowDiagram } from '@/components/pipeline/flow/PipelineFlowDiagram';
import type { PipelineEditorSession } from './usePipelineEditorSession';
import { useDesignerEdits } from './useDesignerEdits';
import type { Selection } from '../../hooks/usePipelineEditor';
import { workflowJobStructure } from '@canopy/pipeline-interop/workflow-designer-job-edits';

const DEFAULT_DETAIL_WIDTH = 320;
const MIN_DETAIL_WIDTH = 240;
const MAX_DETAIL_WIDTH = 600;

const DEFAULT_SETTINGS_WIDTH = 420;
const MIN_SETTINGS_WIDTH = 320;
const MAX_SETTINGS_WIDTH = 720;

function clampWidth(w: number): number {
  return Math.max(MIN_DETAIL_WIDTH, Math.min(MAX_DETAIL_WIDTH, Math.round(w)));
}

function clampSettingsWidth(w: number): number {
  return Math.max(
    MIN_SETTINGS_WIDTH,
    Math.min(MAX_SETTINGS_WIDTH, Math.round(w)),
  );
}

/**
 * Placement for the notices above the editor: the full width of the content
 * below them (CAN-4319), stacked with a small gap.
 */
const EDITOR_NOTICE_PLACEMENT = 'shrink-0';

/** One notice per validation severity, listing every issue at `path: message`. */
function ValidationIssuesNotice({
  intent,
  issues,
}: {
  intent: NoticeIntent;
  issues: ValidationIssue[];
}): JSX.Element {
  return (
    <Notice
      errorSource="validation-issues"
      intent={intent}
      title={`${String(issues.length)} validation ${
        issues.length === 1 ? 'issue' : 'issues'
      }`}
      className={EDITOR_NOTICE_PLACEMENT}
    >
      {/* A real list stays a list, 8px under the title. */}
      <NoticeList>
        {issues.map((issue, i) => (
          <NoticeListItem key={`${issue.type}-${i}`}>
            <span className="font-medium">{issue.path}:</span> {issue.message}
          </NoticeListItem>
        ))}
      </NoticeList>
    </Notice>
  );
}

export interface PipelineEditorNoticesProps {
  readonly session: PipelineEditorSession;
  /** Editor region whose separation from the notices this group owns. */
  readonly children: ReactNode;
  /**
   * Offer Duplicate on the read-only notice. A host whose header carries
   * Duplicate turns this off. Defaults to `true`.
   */
  readonly showDuplicateAction?: boolean;
  /**
   * How many workflows use this pipeline (CAN-5782): from two, a notice says
   * an edit reaches all of them.
   */
  readonly sharedUserCount?: number;
  /**
   * Offer Duplicate on that notice (CAN-4224 phase 07). The host sets it
   * only where main would accept the copy: never for an installed workflow,
   * nor before it can tell.
   */
  readonly offerSharedDuplicate?: boolean;
  /**
   * Unsaved edits anywhere on the page, the pipeline's or its schedules'.
   * Defaults to the pipeline's own.
   */
  readonly pageDirty?: boolean;
}

/**
 * The notices above the editor toolbar: save and load errors, the read-only
 * explanation, a failed Duplicate, the public share link and validation.
 */
export function PipelineEditorNotices({
  session,
  children,
  showDuplicateAction = true,
  sharedUserCount = 0,
  offerSharedDuplicate = false,
  pageDirty = session.isDirty,
}: PipelineEditorNoticesProps): JSX.Element {
  const { pipelineInfo } = session;
  const duplicateAction =
    showDuplicateAction && session.readOnly && session.canDuplicate ? (
      <NoticeButton
        variant="primary"
        disabled={session.duplicating}
        aria-busy={session.duplicating}
        data-testid="pipeline-editor-duplicate"
        onClick={session.duplicate}
      >
        Duplicate
      </NoticeButton>
    ) : undefined;
  const duplicateErrorNotice = session.duplicateError !== null && (
    <Notice
      errorSource="pipeline-editor-duplicate-error"
      intent="destructive"
      className={EDITOR_NOTICE_PLACEMENT}
      data-testid="pipeline-editor-duplicate-error"
    >
      {session.duplicateError}
    </Notice>
  );
  const publicShareRow =
    pipelineInfo?.source === 'shared' && pipelineInfo.remoteId ? (
      <PipelinePublicShareRow
        remoteId={pipelineInfo.remoteId}
        name={pipelineInfo.name}
        readFacts={{
          shareScope: pipelineInfo.shareScope,
          publicShare: pipelineInfo.publicShare,
        }}
      />
    ) : null;
  const errorNotice = session.error && (
    <Notice
      errorSource="pipeline-editor-notices-session"
      intent="destructive"
      className={EDITOR_NOTICE_PLACEMENT}
    >
      {session.error}
    </Notice>
  );

  if (session.readDefinition) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {errorNotice}
        {session.validationErrors.length > 0 && (
          <ValidationIssuesNotice
            intent="destructive"
            issues={session.validationErrors}
          />
        )}
        <Notice
          intent="attention"
          role="none"
          title="Read-only workflow"
          className={EDITOR_NOTICE_PLACEMENT}
          actions={duplicateAction}
        >
          {pipelineInfo?.source === 'shared'
            ? 'Duplicate this shared workflow to make local changes.'
            : 'Duplicate it to make changes.'}
        </Notice>
        {duplicateErrorNotice}
        <div className="flex min-h-0 flex-1 flex-col gap-0">
          {publicShareRow}
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {errorNotice}
      {duplicateErrorNotice}
      {/* The share row has no trailing gap; only notices separate the next block. */}
      <div className="flex min-h-0 flex-1 flex-col gap-0">
        {publicShareRow}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <SharedPipelineNotice
            count={sharedUserCount}
            {...(offerSharedDuplicate && session.canDuplicate
              ? {
                  action: (
                    <NoticeButton
                      // A copy is of the saved workflow: save or discard
                      // first, so it holds what the page shows.
                      disabled={session.duplicating || pageDirty}
                      aria-busy={session.duplicating}
                      data-testid="pipeline-editor-shared-duplicate"
                      onClick={session.duplicate}
                    >
                      Duplicate
                    </NoticeButton>
                  ),
                  ...(pageDirty
                    ? {
                        actionNote:
                          'Save or undo your changes to duplicate it.',
                      }
                    : {}),
                }
              : {})}
            className={EDITOR_NOTICE_PLACEMENT}
          />
          {/* RawYamlView owns validation in raw mode. */}
          {!session.isRawMode && session.validationErrors.length > 0 && (
            <ValidationIssuesNotice
              intent="destructive"
              issues={session.validationErrors}
            />
          )}
          {!session.isRawMode && session.validationWarnings.length > 0 && (
            <ValidationIssuesNotice
              intent="attention"
              issues={session.validationWarnings}
            />
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

export interface PipelineEditorBodyProps {
  readonly session: PipelineEditorSession;
  readonly returnToEntryId?: string;
  readonly returnToEntryContext?: EntryDetailReturnContext;
  readonly returnToPipeline?: PipelineReturnTarget;
  readonly returnToMarketplace?: PipelineReturnTarget['returnToMarketplace'];
  /**
   * Values the steps' `inputs.*` stand for, such as a workflow page's first
   * schedule's (CAN-5782): a create step's sidebar group reads its project.
   */
  readonly inputValues?: Readonly<Record<string, string>>;
  /** What schedules the pipeline, for the Designer's trigger card. */
  readonly designerTrigger?: DesignerTriggerHost;
  /** A send step's "Send as" (CAN-7186), on a workflow page. */
  readonly stepSendAs?: (
    jobId: string,
    stepIndex: number,
  ) => StepSendAsField | undefined;
  /** What Settings' trigger list needs beyond the document (CAN-5782). */
  readonly triggerFacts?: PipelineSettingsTriggerFacts;
}

/**
 * What schedules a pipeline, and how to edit and add them, for the
 * Designer's trigger card (CAN-4224 phase 04). The host knows whether they
 * live on a workflow page or in automations.
 */
export interface DesignerTriggerHost {
  readonly schedules: readonly WorkflowTriggerSchedule[];
  /**
   * Adding edits the page's own schedules, saved with it, so it never
   * leaves the editor; otherwise adding opens the automation editor.
   */
  readonly addsInPlace: boolean;
  readonly onEditSchedule: (key: string) => void;
  readonly onAddSchedule?: (kind: 'schedule' | 'once') => void;
  /**
   * Opens a new schedule after the person's next save, or cancels that
   * (null). The host holds it, so it outlives a draft's first save, which
   * remounts the editor.
   */
  readonly onQueueScheduleAfterSave?: (
    kind: 'schedule' | 'once' | null,
  ) => void;
  readonly addBlockedReason?: string;
  /** Worktree hooks start the pipeline, which needs Run to stay on. */
  readonly startedByHooks: boolean;
  /**
   * The schedules and hooks above are loaded. Until they are, the card
   * can't tell that nothing needs Run.
   */
  readonly startersKnown: boolean;
}

/**
 * The editor below its toolbar: loading and not-found states, the read-only
 * Flow/Details view, or the Flow/List/Raw editor with its detail panel and
 * the settings drawer. It fills the remaining height of a flex column.
 */
export function PipelineEditorBody({
  session,
  returnToEntryId,
  returnToEntryContext,
  returnToPipeline,
  returnToMarketplace,
  inputValues,
  designerTrigger,
  stepSendAs,
  triggerFacts,
}: PipelineEditorBodyProps): JSX.Element {
  const { editor, flowSource, selectionIsValid } = session;
  const designerEdits = useDesignerEdits(editor);
  const openTrigger = useCallback((): void => {
    editor.setSelection({ type: 'none' });
    editor.setActivePanel('steps');
  }, [editor]);
  const trigger = useDesignerTrigger(editor, designerTrigger, openTrigger);
  const [detailPanelWidth, setDetailPanelWidth] =
    useState(DEFAULT_DETAIL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const latestWidthRef = useRef(DEFAULT_DETAIL_WIDTH);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(
    DEFAULT_SETTINGS_WIDTH,
  );
  const [isResizingSettings, setIsResizingSettings] = useState(false);

  // Resize logic: track mouse movement while dragging
  const updateWidthFromPointer = useCallback((clientX: number): void => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    // Panel is on the right side, so width = right edge - mouse X
    const newWidth = clampWidth(rect.right - clientX);
    latestWidthRef.current = newWidth;
    setDetailPanelWidth(newWidth);
  }, []);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      setIsResizing(true);
      updateWidthFromPointer(e.clientX);
    },
    [updateWidthFromPointer],
  );

  useEffect((): (() => void) | undefined => {
    if (!isResizing) return undefined;

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    const handleMouseMove = (event: globalThis.MouseEvent): void => {
      updateWidthFromPointer(event.clientX);
    };

    const handleMouseUp = (): void => {
      setIsResizing(false);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return (): void => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    };
  }, [isResizing, updateWidthFromPointer]);

  const updateSettingsWidthFromPointer = useCallback(
    (clientX: number): void => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setSettingsPanelWidth(clampSettingsWidth(rect.right - clientX));
    },
    [],
  );

  const handleSettingsResizeMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      setIsResizingSettings(true);
      updateSettingsWidthFromPointer(e.clientX);
    },
    [updateSettingsWidthFromPointer],
  );

  useEffect((): (() => void) | undefined => {
    if (!isResizingSettings) return undefined;

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    const handleMouseMove = (event: globalThis.MouseEvent): void => {
      updateSettingsWidthFromPointer(event.clientX);
    };

    const handleMouseUp = (): void => {
      setIsResizingSettings(false);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return (): void => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    };
  }, [isResizingSettings, updateSettingsWidthFromPointer]);

  const handleSelectFlowJob = useCallback(
    (jobId: string): void => {
      editor.setSelection({ type: 'job', jobId });
    },
    [editor],
  );

  const handleSelectFlowStep = useCallback(
    (jobId: string, stepIndex: number): void => {
      editor.setSelection({ type: 'step', jobId, stepIndex });
    },
    [editor],
  );

  // The editable flow (CAN-4319) adds a step to the selected job, and the
  // first job of an empty workflow, then selects what it added so its panel
  // opens for editing.
  const handleAddFlowStep = useCallback(
    (jobId: string): void => {
      const job = editor.pipeline?.jobs[jobId];
      if (!job) return;
      const stepIndex = job.steps.length;
      editor.addStep(jobId);
      editor.setSelection({ type: 'step', jobId, stepIndex });
    },
    [editor],
  );

  // The designer reads only a projection of the draft (CAN-4224).
  const designerStack = useMemo(
    () =>
      editor.pipeline && editor.mainView === 'designer'
        ? projectWorkflowStack(editor.pipeline)
        : null,
    [editor.pipeline, editor.mainView],
  );
  // In the Designer, only cards it shows as editable open the details panel:
  // a job it shows read-only (a matrix, say) stays out of reach (CAN-4224).
  const designerEditableKeys = useMemo(
    () => (designerStack ? workflowStackEditableKeys(designerStack) : null),
    [designerStack],
  );
  const selectionKey =
    editor.selection.type === 'step'
      ? `step:${editor.selection.jobId}:${String(editor.selection.stepIndex)}`
      : editor.selection.type === 'job'
        ? `job:${editor.selection.jobId}`
        : null;
  // A router's routes decide which jobs run. The Designer edits a router
  // only as a split it draws as paths, through the split's own panel; any
  // other router stays read-only. Matching on `uses` alone over-locks
  // rather than predicts.
  const selectedStep =
    editor.selection.type === 'step'
      ? editor.pipeline?.jobs[editor.selection.jobId]?.steps[
          editor.selection.stepIndex
        ]
      : undefined;
  // Decided from `uses` as it was when the card was selected in this view,
  // not as it is typed: a reference typed into Uses passes through partial
  // spellings such as `builtin/` that the fail-closed check would lock.
  // A Designer edit, undo or redo can put a different step at the selected
  // position, so each one decides the lock and mounts the panel again.
  const editRevision = `${String(designerEdits.revision)}.${String(editor.historyRevision)}`;
  const lockSelectionKey = `${editor.mainView}:${selectionKey ?? ''}:${editRevision}`;
  const [usesAtSelection, setUsesAtSelection] = useState<{
    readonly key: string;
    readonly uses: unknown;
  }>({ key: lockSelectionKey, uses: selectedStep?.uses });
  if (usesAtSelection.key !== lockSelectionKey)
    setUsesAtSelection({ key: lockSelectionKey, uses: selectedStep?.uses });
  const lockUses =
    usesAtSelection.key === lockSelectionKey
      ? usesAtSelection.uses
      : selectedStep?.uses;
  const selectedRouterInDesigner =
    editor.mainView === 'designer' &&
    typeof lockUses === 'string' &&
    mayRunBuiltinAction(lockUses, 'router');
  // A split the Designer draws as paths opens its own panel: its routes and
  // its paths' guards change only together, through the split's edits. A
  // split whose paths the stack shows read-only keeps the router's lock.
  const selectedPaths =
    designerStack !== null && editor.selection.type === 'step'
      ? workflowStackPathsOf(designerStack, editor.selection.jobId)
      : null;
  const selectedSplit =
    selectedPaths !== null && editor.pipeline
      ? readWorkflowSplit(editor.pipeline, selectedPaths.jobId)
      : null;
  const splitInPanel =
    selectedSplit !== null &&
    editor.selection.type === 'step' &&
    selectedSplit.routerStepIndex === editor.selection.stepIndex
      ? selectedSplit
      : null;
  // What the Designer's job panel holds back, worked out once per draft,
  // and only for a job it shows as editable: no other opens the panel.
  const selectedJobId =
    editor.selection.type === 'job' &&
    designerEditableKeys?.has(`job:${editor.selection.jobId}`) === true
      ? editor.selection.jobId
      : null;
  const selectedJobStructure = useMemo(
    () =>
      editor.mainView === 'designer' &&
      editor.pipeline &&
      selectedJobId !== null
        ? workflowJobStructure(editor.pipeline, selectedJobId)
        : null,
    [editor.mainView, editor.pipeline, selectedJobId],
  );
  const selectionReadOnlyInDesigner =
    designerEditableKeys !== null &&
    selectionKey !== null &&
    !designerEditableKeys.has(selectionKey);
  const { setSelection, setActivePanel } = editor;
  useEffect(() => {
    if (selectionReadOnlyInDesigner) setSelection({ type: 'none' });
  }, [selectionReadOnlyInDesigner, setSelection]);
  // Selecting a card opens its details panel, so it closes Settings.
  const closeTrigger = trigger.close;
  const selectInDesigner = useCallback(
    (selection: Selection): void => {
      closeTrigger();
      setSelection(selection);
      setActivePanel('steps');
    },
    [closeTrigger, setSelection, setActivePanel],
  );

  const handleAddFirstFlowJob = useCallback((): void => {
    if (!editor.pipeline) return;
    const jobId = createJobId(Object.keys(editor.pipeline.jobs));
    editor.addJob();
    editor.setSelection({ type: 'job', jobId });
  }, [editor]);

  if (editor.loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-3">
          <LoadingSpinner tone="secondary" />
          <span className="text-s fg-secondary">Loading workflow…</span>
        </div>
      </div>
    );
  }

  if (!editor.pipeline) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-s fg-secondary">Workflow not found.</p>
      </div>
    );
  }

  if (session.readDefinition) {
    // A read-only workflow opens in the Designer, read-only: its stack, its
    // trigger card and which steps run only for an entry, with no "+",
    // menus or panel (CAN-4224 phase 05). Duplicate makes an editable copy.
    if (session.readDetailView === 'designer' && designerStack)
      return (
        <div
          className="flex-1 overflow-auto min-w-0"
          data-testid="pipeline-read-designer"
        >
          <WorkflowDesigner
            stack={designerStack}
            selection={{ type: 'none' }}
            onClearSelection={(): void => undefined}
            // No card has a panel to open: they show, disabled.
            {...(trigger.card
              ? {
                  trigger: {
                    title: trigger.card.title,
                    ...(trigger.card.detail !== undefined
                      ? { detail: trigger.card.detail }
                      : {}),
                    selected: false,
                    onDismiss: trigger.card.onDismiss,
                    stepEntries: trigger.card.stepEntries,
                  },
                }
              : {})}
          />
        </div>
      );
    return session.readDetailView === 'map' && flowSource ? (
      <div
        className="flex-1 overflow-hidden min-w-0"
        data-testid="pipeline-read-flow"
      >
        <PipelineFlowDiagram source={flowSource} />
      </div>
    ) : (
      <div className="flex-1 overflow-auto min-w-0">
        <PipelineReadDetail definition={session.readDefinition} />
      </div>
    );
  }

  // The trigger's panel shows in the Designer while no card is selected.
  const triggerInPanel =
    trigger.open &&
    trigger.panel !== undefined &&
    editor.mainView === 'designer' &&
    editor.selection.type === 'none' &&
    editor.activePanel !== 'settings';
  const showDetailPanel =
    ((editor.selection.type === 'step' || editor.selection.type === 'job') &&
      selectionIsValid &&
      !selectionReadOnlyInDesigner &&
      editor.activePanel !== 'settings') ||
    triggerInPanel;
  const showSettingsDrawer = editor.activePanel === 'settings';

  return (
    // Main content area
    <div ref={containerRef} className="flex-1 flex overflow-hidden">
      {/* Primary editor column (jobs/flow/raw + detail panel). Always
          rendered so settings can open as a right-side drawer without
          unmounting the main content. */}
      <div className="flex-1 flex overflow-hidden min-w-0">
        {editor.mainView === 'raw' ? (
          <RawYamlView
            value={session.rawYamlText}
            onChange={session.setRawYamlText}
            error={session.rawYamlError}
            readonly={editor.readonly}
          />
        ) : (
          <>
            <div className="flex-1 overflow-auto min-w-0">
              {editor.mainView === 'designer' && designerStack ? (
                <WorkflowDesigner
                  stack={designerStack}
                  selection={editor.selection}
                  onSelectStep={(jobId, stepIndex) =>
                    selectInDesigner({ type: 'step', jobId, stepIndex })
                  }
                  onSelectJob={(jobId) =>
                    selectInDesigner({ type: 'job', jobId })
                  }
                  onClearSelection={() => {
                    trigger.close();
                    editor.setSelection({ type: 'none' });
                  }}
                  onEditInYaml={() => session.setMainView('raw')}
                  {...(trigger.card
                    ? { trigger: { ...trigger.card, selected: triggerInPanel } }
                    : {})}
                  {...(designerEdits.editing
                    ? { editing: designerEdits.editing }
                    : {})}
                  {...(designerEdits.notice
                    ? { notice: designerEdits.notice }
                    : {})}
                />
              ) : editor.mainView === 'list' ? (
                <JobList
                  pipeline={editor.pipeline}
                  jobOrder={editor.jobOrder}
                  selection={editor.selection}
                  onSelectJob={(jobId) =>
                    editor.setSelection({ type: 'job', jobId })
                  }
                  onSelectStep={(jobId, stepIndex) =>
                    editor.setSelection({ type: 'step', jobId, stepIndex })
                  }
                  onAddJob={editor.addJob}
                  onAddStep={editor.addStep}
                  onDeleteStep={editor.removeStep}
                  onReorderSteps={editor.reorderSteps}
                  onMoveStep={editor.moveStepBetweenJobs}
                  readonly={editor.readonly}
                />
              ) : flowSource ? (
                <PipelineFlowDiagram
                  source={flowSource}
                  selection={
                    editor.selection.type === 'none'
                      ? undefined
                      : editor.selection
                  }
                  onSelectJob={handleSelectFlowJob}
                  onSelectStep={handleSelectFlowStep}
                  {...(editor.readonly
                    ? {}
                    : {
                        onAddStep: handleAddFlowStep,
                        onAddFirstJob: handleAddFirstFlowJob,
                        onAskAssistant: focusPipelineAssistantComposer,
                      })}
                />
              ) : null}
            </div>

            {showDetailPanel && (
              <>
                <div
                  className="group flex w-2 shrink-0 cursor-col-resize items-stretch justify-center"
                  onMouseDown={handleResizeMouseDown}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize detail panel"
                  aria-valuemin={MIN_DETAIL_WIDTH}
                  aria-valuemax={MAX_DETAIL_WIDTH}
                  aria-valuenow={Math.round(detailPanelWidth)}
                >
                  <ResizeRailIndicator active={isResizing} />
                </div>

                <Surface
                  variant="section"
                  boundary="left"
                  className="overflow-auto shrink-0"
                  paneWidth={detailPanelWidth}
                  // In the Designer, Escape closes the panel and the stack
                  // returns focus to the card (CAN-4224).
                  onKeyDown={
                    editor.mainView === 'designer'
                      ? (event) => {
                          if (event.key !== 'Escape' || event.defaultPrevented)
                            return;
                          // A nested editor or dialog (portaled out of the
                          // panel, but bubbling through React) handles its
                          // own Escape; only Escape from the panel closes it.
                          if (
                            !(event.target instanceof Node) ||
                            !event.currentTarget.contains(event.target)
                          )
                            return;
                          event.preventDefault();
                          // Blur first, so a field that commits on blur keeps
                          // its edit before the panel unmounts.
                          if (document.activeElement instanceof HTMLElement)
                            document.activeElement.blur();
                          trigger.close();
                          editor.setSelection({ type: 'none' });
                        }
                      : undefined
                  }
                >
                  {triggerInPanel && trigger.panel ? (
                    <PipelineDetailPanelShell
                      title="Trigger"
                      onClose={trigger.close}
                    >
                      <WorkflowTriggerPanel {...trigger.panel} />
                    </PipelineDetailPanelShell>
                  ) : null}
                  {editor.selection.type === 'step' && splitInPanel ? (
                    <SplitDetailPanel
                      key={`${editor.selection.jobId}:${String(editor.selection.stepIndex)}:${editRevision}`}
                      step={
                        editor.pipeline.jobs[splitInPanel.jobId]?.steps[
                          splitInPanel.routerStepIndex
                        ] ?? {}
                      }
                      paths={splitInPanel.paths}
                      readonly={editor.readonly}
                      missingInput={routerLacksInput(
                        editor.pipeline.jobs[splitInPanel.jobId]?.steps[
                          splitInPanel.routerStepIndex
                        ] ?? {},
                      )}
                      onChange={(step) =>
                        editor.updateStep(
                          splitInPanel.jobId,
                          splitInPanel.routerStepIndex,
                          step,
                        )
                      }
                      onRenamePath={(pathJobId, label) =>
                        designerEdits.renamePath(
                          splitInPanel.jobId,
                          pathJobId,
                          label,
                        )
                      }
                      onAddPath={() =>
                        designerEdits.editing?.onAddPath(splitInPanel.jobId)
                      }
                      onRemovePath={(pathJobId) =>
                        designerEdits.editing?.onRemovePath(
                          splitInPanel.jobId,
                          pathJobId,
                        )
                      }
                      onClose={() => editor.setSelection({ type: 'none' })}
                    />
                  ) : null}
                  {editor.selection.type === 'step' && !splitInPanel && (
                    <StepDetailPanel
                      // One panel per selected step, so nothing typed for
                      // one step carries to the next.
                      key={`${editor.selection.jobId}:${String(editor.selection.stepIndex)}:${editRevision}`}
                      step={
                        editor.pipeline.jobs[editor.selection.jobId]?.steps[
                          editor.selection.stepIndex
                        ]
                      }
                      stepIndex={editor.selection.stepIndex}
                      jobId={editor.selection.jobId}
                      onChange={(step) =>
                        editor.updateStep(
                          editor.selection.type === 'step'
                            ? editor.selection.jobId
                            : '',
                          editor.selection.type === 'step'
                            ? editor.selection.stepIndex
                            : 0,
                          step,
                        )
                      }
                      onClose={() => editor.setSelection({ type: 'none' })}
                      {...(inputValues ? { inputValues } : {})}
                      {...(stepSendAs
                        ? {
                            sendAs: stepSendAs(
                              editor.selection.jobId,
                              editor.selection.stepIndex,
                            ),
                          }
                        : {})}
                      readonly={editor.readonly}
                      {...(editor.mainView === 'designer'
                        ? {
                            onRenameId: (id: string | undefined) =>
                              editor.selection.type === 'step'
                                ? designerEdits.renameStep(
                                    editor.selection.jobId,
                                    editor.selection.stepIndex,
                                    id,
                                  )
                                : null,
                          }
                        : {})}
                      {...(selectedRouterInDesigner
                        ? {
                            lockedReason:
                              'Other jobs follow this step’s routes, so change it in YAML.',
                          }
                        : {})}
                    />
                  )}
                  {editor.selection.type === 'job' && (
                    <JobDetailPanel
                      // Undo and redo restore the job under the panel: its
                      // fields start again from what they restored.
                      key={`${editor.selection.jobId}:${String(editor.historyRevision)}`}
                      jobId={editor.selection.jobId}
                      job={editor.pipeline.jobs[editor.selection.jobId]}
                      allJobIds={Object.keys(editor.pipeline.jobs)}
                      onChange={editor.updateJob}
                      onRenameJob={editor.renameJob}
                      onRemove={editor.removeJob}
                      onClose={() => editor.setSelection({ type: 'none' })}
                      readonly={editor.readonly}
                      {...(selectedJobStructure
                        ? { structure: selectedJobStructure }
                        : {})}
                      {...(designerStack !== null &&
                      workflowStackPathJobs(designerStack).has(
                        editor.selection.jobId,
                      )
                        ? {
                            conditionLockedReason:
                              'Set by the split this path belongs to. Rename the path in the split’s step.',
                          }
                        : {})}
                    />
                  )}
                </Surface>
              </>
            )}
          </>
        )}
      </div>

      {showSettingsDrawer && (
        <>
          <div
            className="group flex w-2 shrink-0 cursor-col-resize items-stretch justify-center"
            onMouseDown={handleSettingsResizeMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize settings panel"
            aria-valuemin={MIN_SETTINGS_WIDTH}
            aria-valuemax={MAX_SETTINGS_WIDTH}
            aria-valuenow={Math.round(settingsPanelWidth)}
          >
            <ResizeRailIndicator active={isResizingSettings} />
          </div>

          <Surface
            variant="section"
            boundary="left"
            className="shrink-0"
            paneWidth={settingsPanelWidth}
          >
            <PipelineSettingsPanel
              pipeline={editor.pipeline}
              onUpdateField={editor.updatePipelineField}
              onUpdateDefaults={editor.updateDefaults}
              onUpdateEnv={editor.updateEnv}
              onClose={() => editor.setActivePanel('steps')}
              readonly={editor.readonly}
              pipelineInfo={editor.pipelineInfo}
              cwd={session.cwd}
              relatedDataRevision={session.relatedDataRevision}
              returnToEntryId={returnToEntryId}
              returnToEntryContext={returnToEntryContext}
              returnToPipeline={returnToPipeline}
              returnToMarketplace={returnToMarketplace}
              onRelatedNavigate={session.relatedNavigate}
              {...(triggerFacts ? { triggerFacts } : {})}
            />
          </Surface>
        </>
      )}
    </div>
  );
}
