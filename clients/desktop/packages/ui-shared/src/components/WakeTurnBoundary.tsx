import type { JSX } from 'react';
import { AppAdvisorWatcherIcon } from '../icons/AppIcons';
import type { ChatWatcherFiredInfo } from '@canopy/protocol/remote-control/shell';
import { Button } from './Button';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { TranscriptEventRow } from './chat/TranscriptEventRow';

export interface WakeTurnBoundaryProps {
  /** The task's description, command or prompt. Blocked in session replay. */
  taskLabel?: string;
  /** The task reported an event and keeps running. */
  event?: boolean;
  scheduled?: boolean;
  toolsLoaded?: boolean;
  watcher?: ChatWatcherFiredInfo;
  followUp?: string;
  timestamp?: number;
  forceOpen?: boolean;
  onShowSpawningTurn?: () => void;
}

/** The shared transcript row for an agent turn started by a wake event. */
export function WakeTurnBoundary({
  taskLabel,
  event,
  scheduled,
  toolsLoaded,
  watcher,
  followUp,
  timestamp,
  forceOpen,
  onShowSpawningTurn,
}: WakeTurnBoundaryProps): JSX.Element {
  const watchers = watcher?.combinedWatchers ?? [];
  const summary = watcher
    ? watchers.length > 1
      ? `${watchers.length} watchers`
      : watcher.kind
    : toolsLoaded
      ? 'Loaded tools'
      : scheduled
        ? 'Scheduled prompt'
        : event
          ? 'Background task reported'
          : 'Background task finished';
  const time =
    timestamp !== undefined && Number.isFinite(timestamp)
      ? new Date(timestamp).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        })
      : undefined;

  return (
    <TranscriptEventRow
      dataTestId="wake-turn-boundary"
      forceOpen={forceOpen}
      icon={<AppAdvisorWatcherIcon size="sm" aria-hidden="true" />}
      label={
        <>
          Woke up:{' '}
          <span className={watcher ? REPLAY_MASK_CLASS : undefined}>
            {summary}
          </span>
        </>
      }
      detail={
        taskLabel ? (
          <>
            <span className={REPLAY_BLOCK_CLASS}>{taskLabel}</span>
            {time ? <> · {time}</> : null}
          </>
        ) : (
          time
        )
      }
    >
      {taskLabel || followUp || watchers.length > 0 || onShowSpawningTurn ? (
        <div className="flex min-w-0 flex-col items-start gap-2">
          {taskLabel ? (
            <div className={REPLAY_BLOCK_CLASS}>{taskLabel}</div>
          ) : null}
          {watchers.length > 0 ? (
            watchers.map(({ kind, text }, index) => (
              <div key={`${kind}-${index}`} className="min-w-0">
                <div className={REPLAY_MASK_CLASS}>{kind}</div>
                <div
                  className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words`}
                >
                  {text}
                </div>
              </div>
            ))
          ) : followUp ? (
            <div
              className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words`}
            >
              {followUp}
            </div>
          ) : null}
          {onShowSpawningTurn ? (
            <Button
              variant="link"
              data-testid="wake-turn-boundary-show-spawning-turn"
              onClick={onShowSpawningTurn}
            >
              Show where it started
            </Button>
          ) : null}
        </div>
      ) : null}
    </TranscriptEventRow>
  );
}
