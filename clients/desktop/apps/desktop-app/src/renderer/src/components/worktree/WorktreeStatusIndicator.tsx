import type { JSX } from 'react';
import {
  type WorktreeUiStatus,
  WORKTREE_STATUS_META,
} from '@/lib/worktree-status';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import type { StatusGlyphState } from '@canopy/ui-shared/lib';
import { AgentStateGlyph, StatusGlyph } from '@canopy/ui-shared/components';

interface WorktreeStatusIndicatorProps {
  uiStatus: WorktreeUiStatus;
  isRunningSetup: boolean;
  isTearingDown: boolean;
  isPendingGitSetup: boolean;
  isStreaming: boolean;
  /** Live background tasks: the background dot while nothing streams. */
  backgroundTasks?: number;
  fadeStatusOnHover?: boolean;
  showPrimaryIndicator?: boolean;
  doneLabel?: string;
  /**
   * A done worktree whose pull request merged: it draws the shared Merged
   * glyph instead of the finished check.
   */
  merged?: boolean;
}

function getStatusTitle(props: WorktreeStatusIndicatorProps): string | null {
  if (props.isTearingDown) {
    return 'Deleting worktree…';
  }
  // Git checkout through setup reads as one state (CAN-6957).
  if (props.isRunningSetup || props.isPendingGitSetup) {
    return 'Running setup…';
  }
  return null;
}

/** A worktree's status on the shared status glyph map; idle draws none. */
const WORKTREE_GLYPH: Readonly<
  Record<Exclude<WorktreeUiStatus, 'idle'>, StatusGlyphState>
> = {
  planning: 'needs-you',
  working: 'running',
  unread: 'ready',
  done: 'done',
};

function renderPrimaryIndicator(
  props: WorktreeStatusIndicatorProps,
): JSX.Element {
  const statusTitle = getStatusTitle(props);
  if (statusTitle) {
    return (
      <span
        className="inline-flex h-3 w-3 items-center justify-center"
        title={statusTitle}
        aria-label={statusTitle}
      >
        <LoadingSpinner tone="secondary" className="-translate-y-px" />
      </span>
    );
  }

  // Idle is empty space. A working worktree that is streaming is empty too:
  // the agent spinner beside it already says it is running, so the row never
  // shows two spinners.
  if (
    props.uiStatus === 'idle' ||
    (props.uiStatus === 'working' && props.isStreaming)
  ) {
    return (
      <span
        className="inline-flex h-3 w-3"
        aria-hidden="true"
        data-testid="worktree-idle-status-placeholder"
      />
    );
  }

  const label =
    props.uiStatus === 'done'
      ? (props.doneLabel ?? 'Done')
      : WORKTREE_STATUS_META[props.uiStatus].label;
  const hoverClass = props.fadeStatusOnHover ? 'group-hover:opacity-0' : '';
  return (
    <span
      className={`inline-flex h-3 w-3 items-center justify-center transition-opacity ${hoverClass}`}
      title={label}
      aria-label={label}
    >
      <StatusGlyph
        state={
          props.uiStatus === 'done' && props.merged === true
            ? 'merged'
            : WORKTREE_GLYPH[props.uiStatus]
        }
        size={12}
      />
    </span>
  );
}

export function WorktreeStatusIndicator({
  showPrimaryIndicator = true,
  ...props
}: WorktreeStatusIndicatorProps): JSX.Element {
  const primaryIndicator = showPrimaryIndicator
    ? renderPrimaryIndicator(props)
    : null;
  const backgroundTasks = props.backgroundTasks ?? 0;
  const spinner = props.isStreaming ? (
    <AgentStateGlyph state="working" slot="inline" />
  ) : backgroundTasks > 0 ? (
    <AgentStateGlyph state="background" backgroundTasks={backgroundTasks} />
  ) : null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {primaryIndicator}
      {spinner}
    </div>
  );
}
