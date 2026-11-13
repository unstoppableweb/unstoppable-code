import type { JSX } from 'react';
import { ListStartIcon, MessageCircleDashedIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { Tooltip } from './Tooltip';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

export interface WakeTurnBoundaryProps {
  /**
   * The finished task, from its tool call's description, command or prompt;
   * absent when the provider doesn't name it. Blocked in session replay.
   */
  taskLabel?: string;
  /** The task reported an event and keeps running, rather than finishing. */
  event?: boolean;
  /** A scheduled prompt (a cron job) fired; `taskLabel` is its prompt. */
  scheduled?: boolean;
  /** The agent continued after Canopy restarted it to load tools. */
  toolsLoaded?: boolean;
  /** Shows the turn that started the task; absent when it isn't in view. */
  onShowSpawningTurn?: () => void;
}

/**
 * The head row of an autonomous (wake) turn: the agent continued on its own
 * after background work finished or reported an event (turn-state D2), for
 * a scheduled prompt that fired, or after loading tools.
 */
export function WakeTurnBoundary({
  taskLabel,
  event,
  scheduled,
  toolsLoaded,
  onShowSpawningTurn,
}: WakeTurnBoundaryProps): JSX.Element {
  return (
    <div
      data-testid="wake-turn-boundary"
      className="flex items-center gap-2 rounded-lg border bg-fg-primary/[0.03] px-3 py-1.5 text-xs fg-secondary"
    >
      <MessageCircleDashedIcon
        size={14}
        aria-hidden="true"
        className="flex-shrink-0"
      />
      <span className="min-w-0 flex-1 truncate">
        {toolsLoaded ? (
          'Continued after loading tools'
        ) : scheduled ? (
          taskLabel ? (
            <>
              Continued for the scheduled prompt{' '}
              <strong className={REPLAY_BLOCK_CLASS}>{taskLabel}</strong>
            </>
          ) : (
            'Continued for a scheduled prompt'
          )
        ) : event ? (
          taskLabel ? (
            <>
              Continued after an event from{' '}
              <strong className={REPLAY_BLOCK_CLASS}>{taskLabel}</strong>
            </>
          ) : (
            'Continued after a background event'
          )
        ) : taskLabel ? (
          <>
            Continued after{' '}
            <strong className={REPLAY_BLOCK_CLASS}>{taskLabel}</strong> finished
          </>
        ) : (
          'Continued after background work finished'
        )}
      </span>
      {onShowSpawningTurn ? (
        <Tooltip label="Show where it started">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Show where it started"
            data-testid="wake-turn-boundary-show-spawning-turn"
            onClick={onShowSpawningTurn}
          >
            <ListStartIcon size={14} aria-hidden="true" />
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}
