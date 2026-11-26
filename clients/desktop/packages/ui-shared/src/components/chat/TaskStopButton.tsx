import type { JSX } from 'react';
import { Button } from '../../primitives/Button';
import { ExecutionActionButton } from '../ExecutionActionButton';
import { Tooltip } from '../../primitives/Tooltip';
import { StopFilledIcon } from '../../icons/AppIcons';

/** Visible label of a running task's Stop control. */
export const TASK_STOP_LABEL = 'Stop';

/** Visible and accessible label while a task's stop is in flight. */
export const TASK_STOPPING_LABEL = 'Stopping…';

export interface TaskStopButtonProps {
  /** The stop was sent and the task has not ended yet. */
  stopping: boolean;
  onStop: () => void;
  /** Names what Stop ends, for example `Stop agent`. */
  accessibleLabel: string;
  /**
   * Hover help, only when it adds something the accessible label does not
   * already say. Hidden while stopping.
   */
  title?: string;
  dataTestId: string;
  /**
   * Keeps key presses from reaching the row around the button (default). Pass
   * `false` where an ancestor must still see them, such as a dialog's Escape.
   */
  stopKeyDownPropagation?: boolean;
  /**
   * `chip` (default): the execution rows' rose Stop caption. `row`: the
   * background drawer's 28px capsule in the destructive ink, filling its
   * row's action column so every row action is one width.
   */
  appearance?: 'chip' | 'row' | 'drawer';
}

/**
 * Always-visible Stop for one running task row. While the stop is in flight
 * it reads `Stopping…` and is disabled, so it cannot be sent twice; the host
 * drops it once the task ends.
 */
export function TaskStopButton({
  stopping,
  onStop,
  accessibleLabel,
  title,
  dataTestId,
  stopKeyDownPropagation,
  appearance = 'chip',
}: TaskStopButtonProps): JSX.Element {
  if (appearance === 'row' || appearance === 'drawer') {
    const button = (
      <Button
        variant={appearance === 'drawer' ? 'ghost' : 'ghost-destructive'}
        size={appearance === 'drawer' ? 'compact' : 'sm'}
        iconOnly={appearance === 'drawer'}
        className={appearance === 'row' ? 'min-w-full' : undefined}
        aria-label={stopping ? TASK_STOPPING_LABEL : accessibleLabel}
        disabled={stopping}
        data-testid={dataTestId}
        onClick={onStop}
        onKeyDown={
          stopKeyDownPropagation === false
            ? undefined
            : (event): void => event.stopPropagation()
        }
      >
        {appearance === 'drawer' ? (
          <StopFilledIcon size="xs" aria-hidden="true" />
        ) : stopping ? (
          TASK_STOPPING_LABEL
        ) : (
          TASK_STOP_LABEL
        )}
      </Button>
    );
    // Hover help through the shared tooltip, never a native title.
    return appearance === 'row' && title === undefined ? (
      button
    ) : (
      <Tooltip
        label={title ?? accessibleLabel}
        disabled={stopping}
        delay="long"
      >
        {button}
      </Tooltip>
    );
  }
  return (
    <ExecutionActionButton
      label={stopping ? TASK_STOPPING_LABEL : TASK_STOP_LABEL}
      ariaLabel={stopping ? TASK_STOPPING_LABEL : accessibleLabel}
      title={stopping ? undefined : title}
      variant="destructive"
      disabled={stopping}
      dataTestId={dataTestId}
      onClick={onStop}
      stopKeyDownPropagation={stopKeyDownPropagation}
    />
  );
}
