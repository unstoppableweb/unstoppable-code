import type { JSX, ReactNode } from 'react';
import { AppAdvisorWatcherIcon } from '../icons/AppIcons';
import type { ChatWatcherFiredInfo } from '@canopy/protocol/remote-control/shell';
import { Button } from '../primitives/Button';
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
  /** The wake is waiting behind the running turn: “Will wake”, status Queued. */
  queued?: boolean;
  /** Replaces a queued wake's Queued status, such as “Sending…”. */
  status?: ReactNode;
  /** Controls at the row's end, such as a queued wake's Clear. */
  actions?: ReactNode;
  /** More facts at the top of the details, such as why a wake waits. */
  extraDetails?: ReactNode;
}

/**
 * What a wake row names for a fired watcher: its kind, or “N watchers” for a
 * batch the host delivered together (whose own kind reads “Multiple watchers
 * fired (N)”). Every waiting and woken watcher row says it the same way.
 */
export function watcherWakeSummary(watcher: ChatWatcherFiredInfo): string {
  const count = watcher.combinedWatchers?.length ?? 0;
  return count > 1 ? `${count} watchers` : watcher.kind;
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
  queued = false,
  status,
  actions,
  extraDetails,
}: WakeTurnBoundaryProps): JSX.Element {
  const watchers = watcher?.combinedWatchers ?? [];
  const summary = watcher
    ? watcherWakeSummary(watcher)
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
      status={status ?? (queued ? 'Queued' : undefined)}
      actions={actions}
      icon={<AppAdvisorWatcherIcon size="sm" aria-hidden="true" />}
      label={
        <>
          {queued ? 'Will wake:' : 'Woke up:'}{' '}
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
      {taskLabel ||
      followUp ||
      watchers.length > 0 ||
      onShowSpawningTurn ||
      extraDetails != null ? (
        <div className="flex min-w-0 flex-col items-start gap-2">
          {extraDetails}
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
