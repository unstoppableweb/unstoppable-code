import { useMemo, type JSX, type ReactNode } from 'react';
import {
  AnsiOutput,
  Button,
  CopyButton,
  DialogModal,
} from '@canopy/ui-shared/components';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';

/** Operational status of the run, which inks the status text. */
export type RunOutputStatus = 'active' | 'success' | 'paused' | 'failed';

/** How a run ended, or that it has not. */
export type RunOutcome =
  | { readonly kind: 'running' | 'stopping' | 'start-failed' }
  | {
      readonly kind: 'succeeded' | 'failed' | 'timed-out' | 'stopped';
      readonly durationMs: number;
    };

/** `4m 35s`, `12s`, `1h 2m`, `340ms`. */
export function formatRunDuration(durationMs: number): string {
  const milliseconds = Math.max(0, Math.round(durationMs));
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** The modal's one status line: what happened and how long it took. */
export function describeRunOutcome(outcome: RunOutcome): string {
  switch (outcome.kind) {
    case 'running':
      return 'Running…';
    case 'stopping':
      return 'Stopping…';
    case 'start-failed':
      return 'Failed to start';
    case 'succeeded':
      return `Succeeded in ${formatRunDuration(outcome.durationMs)}`;
    case 'timed-out':
      return `Timed out after ${formatRunDuration(outcome.durationMs)}`;
    case 'stopped':
      return `Stopped after ${formatRunDuration(outcome.durationMs)}`;
    case 'failed':
      return `Failed after ${formatRunDuration(outcome.durationMs)}`;
  }
}

// CSI sequences (colors, cursor moves); Copy gives plain text.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface RunOutputModalProps {
  /** Modal title — typically the run label (e.g. script/hook name). */
  title: string;
  /** DOM id for the dialog title (a11y). */
  titleId: string;
  /** The status line under the title; see {@link describeRunOutcome}. */
  summary: string;
  status: RunOutputStatus;
  /** ANSI output lines. When empty, the log surface shows `emptyText`. */
  outputLines: readonly string[];
  /** True while the run is still in flight. Shows the optional Stop button. */
  isRunning: boolean;
  onClose: () => void;
  /** Stop click handler. Required for the Stop button to appear. */
  onStop?: () => void;
  /** Stop button label — script section flips between `Stop` and `Stopping…`,
   * hooks always pass `Stop`. */
  stopLabel?: string;
  /** Disable the stop button (e.g. while a stop is in-flight). */
  stopDisabled?: boolean;
  /** Header controls beside Copy, such as the scripts' Search toggle. */
  headerActions?: ReactNode;
  /** Optional search bar, rendered above the output while open. */
  searchSlot?: ReactNode;
  /**
   * Optional dev-server open-control slot, rendered in the header. Rendered
   * regardless of `isRunning` so the in-memory completed run can still
   * display detected URLs.
   */
  devServerSlot?: ReactNode;
  /** Empty-state copy displayed when `outputLines.length === 0`. */
  emptyText: string;
  /** Optional additional ANSI output props (search highlighting). */
  ansiSearchQuery?: string;
  ansiActiveMatchIndex?: number;
  ansiOnMatchCountChange?: (count: number) => void;
}

/**
 * Shared "enlarge run output" modal used by both {@link HooksSection} and
 * {@link ScriptsSection}: one status line, Copy, and the log.
 *
 * Visible copy is supplied entirely by the caller — this component never
 * embeds section-specific text.
 */
export function RunOutputModal({
  title,
  titleId,
  summary,
  status,
  outputLines,
  isRunning,
  onClose,
  onStop,
  stopLabel,
  stopDisabled,
  headerActions,
  searchSlot,
  devServerSlot,
  emptyText,
  ansiSearchQuery,
  ansiActiveMatchIndex,
  ansiOnMatchCountChange,
}: RunOutputModalProps): JSX.Element {
  // A live run re-renders per chunk; join the log only when it changes.
  const copyText = useMemo(
    () => outputLines.join('\n').replace(ANSI_CSI, ''),
    [outputLines],
  );
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={title}
      subtitle={
        <span className={OPERATIONAL_STATUS_COLORS[status].foreground}>
          {summary}
        </span>
      }
      titleId={titleId}
      maxWidth="3xl"
      minHeight="24rem"
      topRightActions={
        <>
          {devServerSlot}
          {isRunning && onStop && (
            <Button
              type="button"
              variant="ghost-destructive"
              size="compact"
              onClick={onStop}
              disabled={stopDisabled}
            >
              {stopLabel ?? 'Stop'}
            </Button>
          )}
          {headerActions}
          {copyText !== '' && <CopyButton value={copyText} />}
        </>
      }
    >
      {/* The log runs edge to edge and the dialog clips it, so it shares the
          dialog's corners. */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="run-output-body"
      >
        {searchSlot && (
          <div className="px-6 pb-3 pt-3" data-testid="run-output-controls">
            {searchSlot}
          </div>
        )}
        <AnsiOutput
          lines={outputLines}
          variant="reader"
          className="min-h-0 flex-1"
          placeholder={emptyText}
          searchQuery={ansiSearchQuery}
          activeMatchIndex={ansiActiveMatchIndex}
          onMatchCountChange={ansiOnMatchCountChange}
        />
      </div>
    </DialogModal>
  );
}
