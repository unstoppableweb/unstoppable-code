import { focusPipelineAssistantComposer } from '@/lib/pipelineAssistantEvents';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
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
import { SharedPipelineNotice } from '@canopy/ui-app/workflows';
import { PipelineSettingsPanel } from './PipelineSettingsPanel';
import { RawYamlView } from './RawYamlView';
import { PipelinePublicShareRow } from './PipelinePublicShareRow';
import type {
  EntryDetailReturnContext,
  PipelineReturnTarget,
} from '@/stores/navigationStore';
import { JobList } from './steps/JobList';
import { JobDetailPanel } from './steps/JobDetailPanel';
import { StepDetailPanel } from './steps/StepDetailPanel';
import { PipelineFlowDiagram } from '@/components/pipeline/flow/PipelineFlowDiagram';
import type { PipelineEditorSession } from './usePipelineEditorSession';

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
}: PipelineEditorBodyProps): JSX.Element {
  const { editor, flowSource, selectionIsValid } = session;
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
    return session.readDetailView === 'flowchart' && flowSource ? (
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

  const showDetailPanel =
    (editor.selection.type === 'step' || editor.selection.type === 'job') &&
    selectionIsValid &&
    editor.activePanel !== 'settings';
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
              {editor.mainView === 'list' ? (
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

                <div
                  className="border-l overflow-auto shrink-0"
                  style={{ width: detailPanelWidth }}
                >
                  {editor.selection.type === 'step' && (
                    <StepDetailPanel
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
                      readonly={editor.readonly}
                    />
                  )}
                  {editor.selection.type === 'job' && (
                    <JobDetailPanel
                      jobId={editor.selection.jobId}
                      job={editor.pipeline.jobs[editor.selection.jobId]}
                      allJobIds={Object.keys(editor.pipeline.jobs)}
                      onChange={editor.updateJob}
                      onRenameJob={editor.renameJob}
                      onRemove={editor.removeJob}
                      onClose={() => editor.setSelection({ type: 'none' })}
                      readonly={editor.readonly}
                    />
                  )}
                </div>
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

          <div
            className="border-l shrink-0"
            style={{ width: settingsPanelWidth }}
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
            />
          </div>
        </>
      )}
    </div>
  );
}
