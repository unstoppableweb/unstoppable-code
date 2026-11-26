import type { JSX } from 'react';
import { CloseIcon } from '../icons/AppIcons';
import { formatRelativeTime } from '../lib/format-relative-time';
import {
  WORKFLOW_LAST_RUN_GLYPHS,
  WORKFLOW_LAST_RUN_LABELS,
  WORKFLOW_NOT_RUN_YET,
  type WorkflowLastRun,
} from '../lib/workflow-last-run';
import { StatusGlyph } from '../primitives/StatusGlyph';
import { Tooltip } from '../primitives/Tooltip';

export interface WorkflowLastRunTextProps {
  /** `null` and `undefined` both read `Not run yet`. */
  readonly lastRun: WorkflowLastRun | null | undefined;
  /** Test id on the glyph. */
  readonly dataTestId?: string;
  /** Epoch milliseconds the relative time counts from. */
  readonly now?: number;
  /** Compact treatment used only by Customize workflow rows. */
  readonly variant?: 'default' | 'customize';
}

/** A workflow's last run: glyph, outcome and how long ago it ran. */
export function WorkflowLastRunText({
  lastRun,
  dataTestId = 'workflows-last-run-status',
  now,
  variant = 'default',
}: WorkflowLastRunTextProps): JSX.Element | null {
  if (variant === 'customize') {
    if (lastRun === null || lastRun === undefined) return null;
    if (lastRun.state === 'running') {
      return (
        <span className="fg-tertiary" aria-label="Last run running">
          Running
        </span>
      );
    }
    const relativeTime =
      lastRun.at === undefined
        ? undefined
        : formatRelativeTime(lastRun.at, now);
    if (relativeTime === undefined) return null;
    const failed = lastRun.state === 'failure';
    const accessibleLabel = `Last run${failed ? ' failed' : ''} ${relativeTime}`;
    if (!failed) {
      return (
        <span className="fg-tertiary" aria-label={accessibleLabel}>
          {relativeTime}
        </span>
      );
    }
    const tooltip = `${accessibleLabel}${lastRun.errorMessage ? `: ${lastRun.errorMessage}` : ''}`;
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1 fg-tertiary"
        aria-label={accessibleLabel}
      >
        <span>{relativeTime}</span>
        <Tooltip label={tooltip}>
          <span
            tabIndex={0}
            aria-label={tooltip}
            className="inline-flex fg-destructive-strong"
            data-status-glyph="failed"
            data-testid={dataTestId}
          >
            <CloseIcon size={14} aria-hidden="true" />
          </span>
        </Tooltip>
      </span>
    );
  }
  if (lastRun === null || lastRun === undefined) {
    return <span className="fg-tertiary">{WORKFLOW_NOT_RUN_YET}</span>;
  }
  const at =
    lastRun.state === 'running'
      ? 'Now'
      : lastRun.at === undefined
        ? undefined
        : formatRelativeTime(lastRun.at, now);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <StatusGlyph
        state={WORKFLOW_LAST_RUN_GLYPHS[lastRun.state]}
        dataTestId={dataTestId}
        tone="state"
      />
      <span className="truncate">
        <span className="fg-primary">
          {WORKFLOW_LAST_RUN_LABELS[lastRun.state]}
        </span>
        {at ? (
          <span className="fg-tertiary">
            {' · '}
            {at}
          </span>
        ) : null}
      </span>
    </span>
  );
}
