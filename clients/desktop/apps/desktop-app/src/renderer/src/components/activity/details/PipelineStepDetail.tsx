import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Stack, Notice, Surface } from '@canopy/ui-shared/components';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type {
  NormalizedStep,
  StepResult,
} from '@canopy/execution-engine/types/pipeline';
import {
  getDisplayablePipelineStepInputs,
  getDisplayablePipelineStepOutputs,
  resolvePipelineStepLogSources,
  type PipelineLogViewMode,
} from '@/lib/pipelineExecutionDetail';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  hasRenderableTranscriptPrefix,
  markTranscriptProbe,
  transcriptChangedSinceProbe,
  type TranscriptProbeMark,
} from '@/lib/pipelineTranscriptAvailability';
import { useStepLogInterest } from '@/stores/pipelineDetailCoordinator';
import {
  isTerminalStepStatus,
  type SelectedStepSource,
} from '@/lib/pipelineAttemptTimeline';
import {
  DEFAULT_SHELL,
  DEFAULT_TIMEOUT_MINUTES,
} from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { AnsiOutput } from '../AnsiOutput';
import { TranscriptViewer } from '../../chat/TranscriptViewer';
import { LoadingSpinner } from '../../shared/loading/spinners/LoadingSpinner';
import { TerminalModeBanner } from './TerminalModeBanner';
import { useArchivedStepLog } from './useArchivedStepLog';
import {
  stepSessionKey,
  useRetainedSessionValue,
  useSessionWriter,
} from './pipelineDetailSession';
import type { ArchivedPipelineSource } from './pipelineDetailTypes';
import { SearchBar } from '../../shared/search/SearchBar';
import type { SearchExecutor } from '@/components/shared/search/search-types';
import { useAnsiSearch } from '@/hooks/useAnsiSearch';
import { useContentSearch } from '@/hooks/useContentSearch';
import { createDomSearchExecutor } from '@/lib/dom-search-highlight';
import {
  DetailSection,
  KeyValueTable,
  ShellCommandContent,
  TimingSummaryCard,
} from './PipelineStepDetailParts';
import { SegmentedControl } from '@canopy/ui-shared/components';

interface PipelineStepDetailProps {
  executionId: string;
  jobId: string;
  stepDef: NormalizedStep;
  stepResult: StepResult | undefined;
  attempt: number;
  iteration: number;
  source: SelectedStepSource;
  /** Opens a terminal-mode step's worker; defaults to the Workers page. */
  onViewWorker?: (workerId: string) => void;
  /**
   * Read-only archived source. Logs are read once through the archive
   * transport, never `window.pipelines.readStepLog`, and live-only controls
   * (the worker jump) are hidden.
   */
  archivedSource?: ArchivedPipelineSource;
  /**
   * Whether this live step may hold a log interest (the detail's visibility
   * gate). Defaults to true; ignored for archived steps.
   */
  logsEnabled?: boolean;
}

/**
 * Remembers whether a step's transcript source has produced a renderable
 * message, probing only while the answer is still unknown. Once a message
 * exists the answer cannot change for that source, so a running transcript
 * is not re-parsed on every output frame just to pick the default view.
 */
function useRichTranscriptDetected(
  sourceKey: string,
  lines: string[],
  provider: AgentProviderType | undefined,
  enabled: boolean,
): boolean {
  const [detectedKey, setDetectedKey] = useState<string | null>(null);
  const detected = detectedKey === sourceKey;
  const probedRef = useRef<{
    key: string;
    mark: TranscriptProbeMark;
  } | null>(null);
  useEffect(() => {
    if (!enabled || detected || lines.length === 0) return;
    const probed = probedRef.current;
    if (
      probed?.key === sourceKey &&
      !transcriptChangedSinceProbe(probed.mark, lines)
    ) {
      return;
    }
    probedRef.current = { key: sourceKey, mark: markTranscriptProbe(lines) };
    if (hasRenderableTranscriptPrefix(lines, provider)) {
      setDetectedKey(sourceKey);
    }
  }, [detected, enabled, lines, provider, sourceKey]);
  return detected;
}

/**
 * Self-contained per-step detail for the GitHub-Actions-style job view. Holds
 * a log interest for its step while mounted (the persisted log joined with
 * live output), and renders the same detail sections (Timing / Configuration
 * / Shell command / Inputs / Outputs) the modal shows today, followed by the
 * log output (raw ANSI or a Rich / Raw transcript toggle for agent steps).
 */
export function PipelineStepDetail({
  executionId,
  jobId,
  stepDef,
  stepResult,
  attempt,
  iteration,
  source,
  onViewWorker,
  archivedSource,
  logsEnabled = true,
}: PipelineStepDetailProps): JSX.Element {
  const archived = archivedSource !== undefined;
  // A panel keeps the user's raw/rich choice across remounts; until they
  // choose, a detected transcript switches to rich automatically.
  const logViewSessionKey = stepSessionKey({
    executionId,
    jobId,
    stepId: stepDef.id,
    source,
    attempt,
    iteration,
  });
  const retainedLogViewMode = useRetainedSessionValue(
    (session) => session.stepLogViewMode[logViewSessionKey],
  );
  const writeSession = useSessionWriter();
  const [logViewMode, setLogViewModeState] = useState<PipelineLogViewMode>(
    retainedLogViewMode ?? 'plain',
  );
  const userToggledLogViewRef = useRef(retainedLogViewMode !== undefined);
  const chooseLogViewMode = (mode: PipelineLogViewMode): void => {
    setLogViewModeState(mode);
    userToggledLogViewRef.current = true;
    writeSession((previous) => ({
      ...previous,
      stepLogViewMode: {
        ...previous.stepLogViewMode,
        [logViewSessionKey]: mode,
      },
    }));
  };

  // Log output search — ANSI (plain) and DOM (rich transcript) executors,
  // restored to match the pre-rework details modal behavior.
  const ansiSearch = useAnsiSearch();
  const richContentRef = useRef<HTMLDivElement>(null);
  const richSearchExecutor = useMemo<SearchExecutor>(
    () => createDomSearchExecutor(() => richContentRef.current),
    [],
  );
  const richSearchExecutorRef = useRef<SearchExecutor>(richSearchExecutor);
  richSearchExecutorRef.current = richSearchExecutor;
  const richSearch = useContentSearch(richSearchExecutorRef);
  const logSearchInputRef = useRef<HTMLInputElement>(null);

  const logSources = useMemo(
    () => resolvePipelineStepLogSources(stepResult),
    [stepResult],
  );
  const isStepRunning = stepResult?.status === 'running';
  // Only a settled step is terminal for its log. Pending, paused, and
  // not-yet-started steps are not, so a direct move to a settled state (which
  // coalesced or batched events can deliver without an observed `running`)
  // still produces the terminal edge that triggers the final authoritative
  // read. A step first observed settled is read exactly once.
  const isStepSettled = isTerminalStepStatus(stepResult?.status);
  const identity = useMemo(
    () => ({
      executionId,
      jobId,
      stepId: stepDef.id,
      attempt,
      iteration,
      recovery: stepResult?.recovery_count ?? 0,
    }),
    [
      attempt,
      executionId,
      iteration,
      jobId,
      stepDef.id,
      stepResult?.recovery_count,
    ],
  );

  // One interest serves the plain log and, for every current writer, the rich
  // transcript too (the transcript is the same file). A distinct transcript
  // file is read separately, and only once the step has settled: while it
  // runs the live plain log is its source.
  const liveLogPlain = useStepLogInterest({
    identity,
    logFilePath: logSources.plainLogFile,
    terminal: isStepSettled,
    enabled: !archived && logsEnabled,
  });
  const richIsSeparateSource =
    logSources.richLogFile !== undefined &&
    logSources.richLogFile !== logSources.plainLogFile;
  const liveSeparateRichLog = useStepLogInterest({
    identity,
    logFilePath: logSources.richLogFile,
    terminal: isStepSettled,
    enabled: !archived && logsEnabled && richIsSeparateSource && !isStepRunning,
    acceptsLiveOutput: false,
  });
  // An archived step is immutable: each file is read once through the
  // archive transport.
  const archivedIdentity = {
    executionId,
    jobId,
    stepId: stepDef.id,
    attempt,
    iteration,
    recovery: stepResult?.recovery_count,
  };
  const archivedPlainLog = useArchivedStepLog(
    archivedSource,
    archived
      ? { ...archivedIdentity, logFilePath: logSources.plainLogFile }
      : null,
  );
  const archivedSeparateRichLog = useArchivedStepLog(
    archivedSource,
    archived && richIsSeparateSource
      ? { ...archivedIdentity, logFilePath: logSources.richLogFile }
      : null,
  );

  const displayLines = archived ? archivedPlainLog.lines : liveLogPlain.lines;
  const loadingPlain = archived
    ? archivedPlainLog.loading
    : liveLogPlain.status === 'loading';
  const richSourceLines =
    richIsSeparateSource && !isStepRunning
      ? archived
        ? archivedSeparateRichLog.lines
        : liveSeparateRichLog.lines
      : displayLines;
  const loadingRich = richIsSeparateSource
    ? archived
      ? archivedSeparateRichLog.loading
      : liveSeparateRichLog.status === 'loading'
    : loadingPlain;

  // The transcript is parsed once, by `TranscriptViewer`, and only while the
  // rich view is shown. Choosing the default view needs only a bounded probe.
  const richSourceKey = [
    logSources.richLogFile ?? '',
    richIsSeparateSource && !isStepRunning ? 'settled' : 'live',
    executionId,
    jobId,
    stepDef.id,
    String(attempt),
    String(iteration),
  ].join('\0');
  const richTranscriptDetected = useRichTranscriptDetected(
    richSourceKey,
    richSourceLines,
    stepResult?.agent_provider,
    logSources.richLogFile !== undefined && !userToggledLogViewRef.current,
  );
  const richTranscriptAvailable = logSources.richLogFile !== undefined;
  const loadingOutput =
    logViewMode === 'rich' ? !isStepRunning && loadingRich : loadingPlain;

  // The rich transcript searches the rendered DOM; plain logs search the ANSI
  // text. Route the SearchBar to whichever view is active.
  const useRichSearch = logViewMode === 'rich' && richTranscriptAvailable;
  const activeSearch = useRichSearch ? richSearch : ansiSearch;

  // Auto-switch to rich when a transcript becomes available unless the user
  // manually toggled the log view for this step.
  useEffect(() => {
    if (!userToggledLogViewRef.current && richTranscriptDetected) {
      setLogViewModeState('rich');
    }
  }, [richTranscriptDetected]);

  const configurationContent = useMemo((): JSX.Element | null => {
    const entries: Record<string, string | number | boolean> = {};
    if (stepDef.if) {
      entries['if'] = stepDef.if;
    }
    if (stepDef.continue_on_error) {
      entries['continue_on_error'] = true;
    }
    if (stepDef.skip_on_missing_action) {
      entries['skip_on_missing_action'] = true;
    }
    if (stepDef.timeout_minutes !== DEFAULT_TIMEOUT_MINUTES) {
      entries['timeout_minutes'] = stepDef.timeout_minutes;
    }
    if (stepDef.working_directory) {
      entries['working_directory'] = stepDef.working_directory;
    }
    if (stepDef.shell !== DEFAULT_SHELL) {
      entries['shell'] = stepDef.shell;
    }
    if (stepDef.log_format_hint) {
      entries['log_format_hint'] = stepDef.log_format_hint;
    }
    if (stepDef.uses) {
      entries['uses'] = stepDef.uses;
    }
    if (Object.keys(entries).length === 0) {
      return null;
    }
    return <KeyValueTable values={entries} />;
  }, [stepDef]);

  const showStepConfig =
    Object.keys(stepDef.with ?? {}).length > 0 ||
    Object.keys(stepDef.env ?? {}).length > 0;
  const hasOutputs =
    Object.keys(stepResult?.outputs ?? {}).length > 0 ||
    Object.keys(stepResult?.dynamic_env ?? {}).length > 0 ||
    stepResult?.exit_code !== undefined ||
    Boolean(stepResult?.error);

  const shellCommandContent = stepDef.run ? (
    <ShellCommandContent step={stepDef} stepResult={stepResult} />
  ) : null;
  // Inputs carry prompts and resolved env values, and outputs carry agent
  // results, dynamic env, and error output, so each section body is blocked
  // while its heading stays recorded. The wrapper keeps the section's
  // parent gap rhythm between its tables.
  const inputsContent = showStepConfig ? (
    <div className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-col gap-2`}>
      <KeyValueTable
        values={getDisplayablePipelineStepInputs(stepDef.with, stepResult)}
      />
      <KeyValueTable values={stepDef.env} />
    </div>
  ) : null;
  const outputsContent = hasOutputs ? (
    <div className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-col gap-2`}>
      <KeyValueTable
        values={getDisplayablePipelineStepOutputs(
          stepResult?.outputs,
          stepResult,
        )}
      />
      <KeyValueTable values={stepResult?.dynamic_env} />
      <KeyValueTable
        values={{
          ...(stepResult?.exit_code !== undefined
            ? { exit_code: stepResult.exit_code }
            : {}),
          ...(stepResult?.error ? { error: stepResult.error } : {}),
        }}
      />
    </div>
  ) : null;
  const timingContent = (
    <TimingSummaryCard
      title="Step"
      identity={`step:${executionId}:${jobId}:${stepDef.id}:${source}:${attempt}:${iteration}`}
      kind="step"
      status={stepResult?.status ?? 'pending'}
      startedAt={stepResult?.started_at}
      completedAt={stepResult?.completed_at}
      source={source}
    />
  );

  return (
    <div
      className="flex flex-col px-3 py-3 gap-4"
      data-testid={`pipeline-step-detail-${stepDef.id}`}
      onKeyDown={(e): void => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          e.stopPropagation();
          logSearchInputRef.current?.focus();
        }
      }}
    >
      {stepResult?.agentTerminalMode && (
        <TerminalModeBanner
          agentTerminalMode={stepResult.agentTerminalMode}
          workerId={archived ? undefined : stepResult.workerId}
          workerQueued={stepResult.workerQueued}
          onViewWorker={onViewWorker}
        />
      )}

      {stepResult?.error && (
        <Notice
          errorSource="pipeline-step-detail"
          intent="destructive"
          title="Step failed"
        >
          {/* Step error text is command output: blocked from session replay. */}
          <span
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words font-mono`}
          >
            {stepResult.error}
          </span>
        </Notice>
      )}

      {stepResult?.agent_provider && (
        <div className="flex flex-wrap items-center gap-2 text-2xs fg-secondary">
          <span className="rounded border bg-fg-primary/[0.04] px-1.5 py-0.5 font-mono fg-primary/70">
            {stepResult.agent_provider}
          </span>
          {stepResult.agent_model && (
            <span className="rounded border bg-fg-primary/[0.04] px-1.5 py-0.5 font-mono fg-primary/70">
              {stepResult.agent_model}
            </span>
          )}
        </div>
      )}

      <DetailSection title="Timing" content={timingContent} collapsible />
      <DetailSection
        title="Configuration"
        content={configurationContent}
        collapsible
      />
      <DetailSection
        title="Shell command"
        content={shellCommandContent}
        collapsible
        defaultOpen={false}
      />
      <DetailSection title="Inputs" content={inputsContent} collapsible />
      <DetailSection title="Outputs" content={outputsContent} collapsible />

      <Stack gap="inline" className="min-h-0">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium fg-secondary">
            <span>Log output</span>
            {isStepRunning && <LoadingSpinner tone="active" />}
          </div>
          {logSources.richLogFile !== undefined && (
            <SegmentedControl
              label="Log view"
              shape="capsule"
              width="content"
              value={logViewMode}
              onChange={(mode): void => {
                chooseLogViewMode(mode);
                if (mode === 'plain') richSearch.close();
                else ansiSearch.close();
              }}
              options={[
                {
                  value: 'plain',
                  label: 'Raw',
                  dataTestId: `pipeline-step-log-mode-raw-${stepDef.id}`,
                },
                {
                  value: 'rich',
                  label: 'Rich',
                  dataTestId: `pipeline-step-log-mode-rich-${stepDef.id}`,
                  unavailable: !richTranscriptAvailable,
                  ...(richTranscriptAvailable
                    ? {}
                    : { tooltip: 'No rich transcript for this step' }),
                },
              ]}
            />
          )}
        </div>

        <SearchBar
          className=""
          query={activeSearch.query}
          onQueryChange={activeSearch.setQuery}
          currentIndex={activeSearch.currentIndex}
          totalCount={activeSearch.totalCount}
          onNext={activeSearch.goToNext}
          onPrevious={activeSearch.goToPrevious}
          onClose={activeSearch.close}
          inputRef={logSearchInputRef}
        />

        <div data-testid={`pipeline-step-log-output-${stepDef.id}`}>
          {loadingOutput ? (
            <div className="flex min-h-40 items-center justify-center text-s fg-secondary">
              Loading output…
            </div>
          ) : logViewMode === 'rich' && richTranscriptAvailable ? (
            <Surface variant="group" className="overflow-hidden">
              <div
                className="min-h-40 overflow-auto px-3 py-2"
                ref={richContentRef}
              >
                <TranscriptViewer
                  transcriptKey={[
                    executionId,
                    jobId,
                    stepDef.id,
                    String(attempt),
                    String(iteration),
                  ].join(':')}
                  lines={richSourceLines}
                  providerHint={stepResult?.agent_provider}
                  closeOpenTurnAtEnd={!isStepRunning}
                  emptyMessage={
                    isStepRunning
                      ? 'Waiting for agent output…'
                      : 'No transcript available.'
                  }
                />
              </div>
            </Surface>
          ) : displayLines.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center text-s fg-secondary">
              No output available.
            </div>
          ) : (
            <AnsiOutput
              lines={displayLines}
              searchQuery={ansiSearch.ansiSearchQuery}
              activeMatchIndex={ansiSearch.ansiActiveMatchIndex}
              onMatchCountChange={ansiSearch.ansiOnMatchCountChange}
              className="max-h-120 min-h-40"
            />
          )}
        </div>
      </Stack>
    </div>
  );
}
