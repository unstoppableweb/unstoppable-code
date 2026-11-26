'use client';

import { Badge } from '@canopy/ui-shared/primitives/Badge';
import { useEffect, useRef, useState, type JSX } from 'react';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import {
  Stack,
  DialogModal,
  AnsiOutput,
  useAnsiSearch,
  Notice,
  LoadingSpinner,
} from '@canopy/ui-shared/components';
import { SearchBar } from '@canopy/ui-shared/primitives/SearchBar';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  backgroundProcessStatusBadgeTone,
  isTerminalBackgroundProcessStatus,
} from '@canopy/ui-shared/lib';
import type { BackgroundTaskHostActions } from './background-tasks-section';
import { backgroundTaskStopAccessibleLabel } from './BackgroundProcessesSectionBody';
import { TaskStopAction } from './TaskStopAction';
import { Surface } from '@canopy/ui-shared/components';

const MAX_DETAIL_OUTPUT_LINES = 5000;

/**
 * How long the modal keeps listening for output after the task reaches a
 * terminal status.
 *
 * A task's last writes land after it finishes, so the host keeps delivering
 * output for a short window after the task settles. Dropping the subscription
 * at completion loses those lines here, which is why an open modal used to
 * show less than the card behind it. The extra 500ms covers the final batch,
 * which can arrive after the host's stop timer has already fired.
 */
export const TERMINAL_OUTPUT_FLUSH_WINDOW_MS = 2_500;

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface BackgroundTaskDetailModalProps {
  readonly task: BackgroundTask;
  readonly actions?: BackgroundTaskHostActions;
  readonly onClose: () => void;
}

export function BackgroundTaskDetailModal({
  task,
  actions,
  onClose,
}: BackgroundTaskDetailModalProps): JSX.Element {
  const isWorkflow = task.kind === 'workflow';
  const terminal = isTerminalBackgroundProcessStatus(task.status);
  const detail = actions?.getDetail?.(task) ?? null;
  const stopTarget = task.canStop
    ? (actions?.stopTarget?.(task) ?? null)
    : null;
  // Effects read host callbacks through a ref and depend only on output keys.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const outputSource = detail?.outputSource;
  const outputGeneration = detail?.outputGeneration;
  const outputStreamKey = detail?.outputStreamKey;
  // With neither an output file nor a live stream, the task's own output is
  // the only source, so the modal shows it as it changes.
  const followsTaskOutput =
    !(outputSource && actions?.readFullOutput) &&
    !(outputStreamKey && actions?.subscribeOutput);

  const [lines, setLines] = useState<readonly string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  /** The output file could not be read, so these lines are the store's. */
  const [capturedOnly, setCapturedOnly] = useState(false);
  /**
   * Whether live output can still arrive: the process is running, or it
   * finished while this modal was open and the store's flush window is still
   * open. Released once that window closes, which is also when the finished
   * file is re-read.
   */
  const [streaming, setStreaming] = useState(!terminal);
  /** Bumped once when the flush window closes, to re-read the finished file. */
  const [reloadCount, setReloadCount] = useState(0);

  const shownLines = followsTaskOutput ? task.outputLines : lines;

  const search = useAnsiSearch();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Cmd+F focuses the search input (capture phase so modals take priority)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        searchInputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return (): void =>
      document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const outputLinesRef = useRef(task.outputLines);
  outputLinesRef.current = task.outputLines;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  // Effect 1: Read the output file — on open, when the file becomes known,
  // and once more when the post-terminal flush window closes.
  useEffect(() => {
    let cancelled = false;
    const readFullOutput = actionsRef.current?.readFullOutput;

    if (!outputSource || !readFullOutput) {
      setLines(outputLinesRef.current);
      setTruncated(false);
      setCapturedOnly(false);
      return;
    }

    // Only an empty view waits on the read: the re-read after completion
    // keeps the output already on screen instead of flashing a loader.
    if (linesRef.current.length === 0) {
      setLoading(true);
    }

    // What to show when the file cannot be read. The main handler answers a
    // read error with an empty response, so an empty read with output
    // elsewhere means the same thing as a rejection: fall back to the lines
    // the store captured while the task ran, so the modal never shows less
    // than the card that opened it.
    const capturedFallback = (): readonly string[] =>
      outputLinesRef.current.length >= linesRef.current.length
        ? outputLinesRef.current
        : linesRef.current;

    void readFullOutput(outputSource)
      .then((response) => {
        if (cancelled) return;
        if (response.lines.length > 0) {
          setLines(response.lines);
          setTruncated(response.truncated);
          setCapturedOnly(false);
        } else {
          const captured = capturedFallback();
          setLines(captured);
          setTruncated(false);
          setCapturedOnly(captured.length > 0);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLines(capturedFallback());
        setTruncated(false);
        setCapturedOnly(true);
        setLoading(false);
      });

    return (): void => {
      cancelled = true;
    };
  }, [outputSource, outputGeneration, reloadCount]);

  // Effect 2: Hold the live subscription open across the store's
  // post-terminal flush window, then reconcile against the finished file.
  useEffect(() => {
    if (!terminal) {
      setStreaming(true);
      return;
    }
    // Opened after the process finished: nothing is streaming any more and
    // the file on disk is already complete.
    if (!streamingRef.current) return;

    const timer = setTimeout(() => {
      setStreaming(false);
      setReloadCount((count) => count + 1);
    }, TERMINAL_OUTPUT_FLUSH_WINDOW_MS);

    return (): void => {
      clearTimeout(timer);
    };
  }, [terminal, outputGeneration]);

  // Effect 3: Live subscription — appends incrementally
  useEffect(() => {
    const subscribeOutput = actionsRef.current?.subscribeOutput;
    if (!outputStreamKey || !streaming || !subscribeOutput) return;
    return subscribeOutput(outputStreamKey, (newLines) => {
      setLines((prev) => {
        const next = [...prev, ...newLines];
        return next.length > MAX_DETAIL_OUTPUT_LINES
          ? next.slice(-MAX_DETAIL_OUTPUT_LINES)
          : next;
      });
    });
  }, [outputStreamKey, streaming]);

  return (
    <DialogModal
      onClose={onClose}
      title={
        // Descriptions fall back to the command or prompt.
        <span className={REPLAY_BLOCK_CLASS}>{task.title}</span>
      }
      subtitle={`${task.kind} \u00B7 ${task.status}`}
      maxWidth="3xl"
      dataTestId="bg-process-detail-modal"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden gap-4">
        <Stack gap="group" className="shrink-0">
          {/* Metadata */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-s">
            <div>
              <span className="fg-secondary">Kind</span>
              <span className="pl-2 text-xs font-medium fg-secondary">
                {task.kind}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="fg-secondary">Status</span>
                <span className="inline-flex pl-2 align-middle">
                  <Badge tone={backgroundProcessStatusBadgeTone(task.status)}>
                    {task.status}
                  </Badge>
                </span>
              </div>
              {stopTarget && (
                <TaskStopAction
                  target={stopTarget}
                  live={!terminal}
                  accessibleLabel={backgroundTaskStopAccessibleLabel(task.kind)}
                  dataTestId="bg-process-detail-stop"
                  onError={actions?.onStopError}
                  // The dialog closes on Escape from any of its controls.
                  stopKeyDownPropagation={false}
                />
              )}
            </div>
            <div>
              <span className="fg-secondary">Started</span>
              <span className="pl-2 fg-primary/80">
                {task.startedAt === null
                  ? 'Not started'
                  : formatTimestamp(task.startedAt)}
              </span>
            </div>
            <div>
              <span className="fg-secondary">Updated</span>
              <span className="pl-2 fg-primary/80">
                {formatTimestamp(task.updatedAt)}
              </span>
            </div>
            {detail?.providerTaskId && (
              <div className="col-span-2">
                <span className="fg-secondary">Task ID</span>
                <span className="pl-2 font-mono text-xs fg-primary/80">
                  {detail.providerTaskId}
                </span>
              </div>
            )}
            {detail?.toolName && (
              <div className="col-span-2">
                <span className="fg-secondary">Tool</span>
                <span className="pl-2 fg-primary/80">{detail.toolName}</span>
              </div>
            )}
            {!isWorkflow && detail && detail.outputLocationLabel !== null && (
              <div className="col-span-2">
                <span className="fg-secondary">Output file</span>
                <span className="pl-2 break-all font-mono text-xs fg-primary/80">
                  {detail.outputLocationLabel ?? 'not set'}
                </span>
              </div>
            )}
            {isWorkflow && detail?.runId && (
              <div className="col-span-2">
                <span className="fg-secondary">Run ID</span>
                <span className="pl-2 break-all font-mono text-xs fg-primary/80">
                  {detail.runId}
                </span>
              </div>
            )}
          </div>

          {/* Command (Bash) */}
          {detail?.command && (
            <Stack gap="tight">
              <div className="text-xs font-medium fg-secondary">Command</div>
              <Surface variant="inset" className="overflow-hidden">
                <div
                  className={`${REPLAY_BLOCK_CLASS} overflow-auto px-3 py-2 font-mono text-xs leading-5 fg-secondary`}
                >
                  {detail.command}
                </div>
              </Surface>
            </Stack>
          )}

          {/* Prompt */}
          {detail?.prompt && (
            <Stack gap="tight">
              <div className="text-xs font-medium fg-secondary">Prompt</div>
              <Surface variant="inset" className="overflow-hidden">
                <div
                  className={`${REPLAY_BLOCK_CLASS} max-h-32 overflow-auto px-3 py-2 text-s fg-secondary`}
                >
                  {detail.prompt}
                </div>
              </Surface>
            </Stack>
          )}

          {/* Summary */}
          {task.summary && (
            <Stack gap="tight">
              <div className="text-xs font-medium fg-secondary">Summary</div>
              <div className={`${REPLAY_BLOCK_CLASS} text-s fg-secondary`}>
                {task.summary}
              </div>
            </Stack>
          )}
        </Stack>
        {/* Body: workflow orchestration view OR raw output stream */}
        {isWorkflow ? (
          <div className="min-h-0 flex-1 overflow-auto">
            {actions?.renderWorkflowRun?.(task) ?? null}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <div className="text-xs font-medium fg-secondary inline-flex items-center gap-2">
              Output
              {!terminal && <LoadingSpinner tone="active" />}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              {capturedOnly ? (
                <Notice
                  intent="attention"
                  title="Showing captured output only"
                  data-testid="bg-process-output-notice"
                >
                  The output file couldn&apos;t be read.
                </Notice>
              ) : null}
              {truncated ? (
                <Notice intent="attention">
                  Showing the latest output only.
                </Notice>
              ) : null}
              <SearchBar
                query={search.query}
                onQueryChange={search.setQuery}
                currentIndex={search.currentIndex}
                totalCount={search.totalCount}
                onNext={search.goToNext}
                onPrevious={search.goToPrevious}
                inputRef={searchInputRef}
              />
              {loading ? (
                <Surface variant="inset" className="flex flex-1">
                  <div className="flex flex-1 items-center justify-center py-8 text-s fg-secondary">
                    Loading output…
                  </div>
                </Surface>
              ) : shownLines.length === 0 ? (
                <Surface variant="inset" className="flex flex-1">
                  <div className="flex flex-1 items-center justify-center py-8 text-s fg-secondary">
                    No output available
                  </div>
                </Surface>
              ) : (
                <AnsiOutput
                  lines={shownLines}
                  className="min-h-0 flex-1"
                  style={{ maxHeight: '40vh' }}
                  searchQuery={search.ansiSearchQuery}
                  activeMatchIndex={search.ansiActiveMatchIndex}
                  onMatchCountChange={search.ansiOnMatchCountChange}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </DialogModal>
  );
}
