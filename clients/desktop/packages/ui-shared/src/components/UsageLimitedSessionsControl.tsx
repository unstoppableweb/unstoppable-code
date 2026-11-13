import { Stack } from './Stack';
import { useRef, useState, type JSX } from 'react';
import { DialogModal } from './DialogModal';
import { Button } from './Button';
import { ListRow } from './ListRow';
import { UsageRow } from './UsageGroup';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

/** One interrupted session a host can navigate to. Display-only fields. */
export interface UsageLimitedWaitingSession {
  /** Stable, unique key within the list; also forms the row's test ID. */
  id: string;
  kind: 'chat' | 'pipeline';
  /** User-authored chat title or pipeline name (replay-masked). */
  title: string;
  /** Where the session lives, for example its workspace or worktree. */
  subtitle?: string;
}

/** A list that cannot be empty, so a waiting row always has a destination. */
export type NonEmptyUsageLimitedWaitingSessions = readonly [
  UsageLimitedWaitingSession,
  ...UsageLimitedWaitingSession[],
];

export interface UsageLimitedSessionsControlState {
  /** Sessions a still-blocking provider limit interrupted. */
  kind: 'waiting';
  sessions: NonEmptyUsageLimitedWaitingSessions;
  /**
   * Formatted provider reset time, present only when every blocking window
   * reports a valid future reset. `null` renders the unknown-time copy
   * instead of a guess.
   */
  resetLabel: string | null;
  /** Opens the session. Must only navigate, never resume or schedule. */
  onOpenSession: (session: UsageLimitedWaitingSession) => void;
}

export interface UsageLimitedSessionsControlProps {
  /** Loading preserves an open chooser without exposing stale destinations. */
  state: UsageLimitedSessionsControlState | { kind: 'loading' };
  /** Prefix for the `-waiting` row and its action test IDs. */
  testIdPrefix: string;
}

/** The waiting row's title: `2 interrupted sessions`. */
export function formatUsageLimitedWaitingTitle(count: number): string {
  return `${count} interrupted ${count === 1 ? 'session' : 'sessions'}`;
}

/** The waiting row's quiet line: when the blocking limit resets. */
export function formatUsageLimitedWaitingDetail(
  resetLabel: string | null,
): string {
  return resetLabel === null
    ? 'Reset time unavailable'
    : `Limit resets at ${resetLabel}`;
}

function openActionLabel(kind: UsageLimitedWaitingSession['kind']): string {
  return kind === 'chat' ? 'Open chat' : 'Open pipeline';
}

/**
 * A row in a provider's usage group for the sessions its limit interrupted
 * while a window still blocks: how many, when the limit resets, and one
 * action: the session itself when there is one, otherwise `View…`, a
 * chooser listing them. Navigation never resumes. Place it
 * in the group's rows, before the account row.
 */
export function UsageLimitedSessionsControl({
  state,
  testIdPrefix,
}: UsageLimitedSessionsControlProps): JSX.Element {
  const waiting = state.kind === 'waiting' ? state : null;
  const sessions = waiting?.sessions ?? [];
  const [chooserOpen, setChooserOpen] = useState(false);
  const firstSessionRef = useRef<HTMLButtonElement>(null);
  const [only, ...rest] = sessions;
  return (
    <>
      {waiting && only && (
        <UsageRow
          testId={`${testIdPrefix}-waiting`}
          title={formatUsageLimitedWaitingTitle(sessions.length)}
          detail={formatUsageLimitedWaitingDetail(waiting.resetLabel)}
          trailingKind="action"
          trailing={
            rest.length === 0 ? (
              <Button
                variant="secondary"
                size="compact"
                data-testid={`${testIdPrefix}-waiting-open`}
                onClick={(): void => waiting.onOpenSession(only)}
              >
                {openActionLabel(only.kind)}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="compact"
                data-testid={`${testIdPrefix}-waiting-view`}
                aria-haspopup="dialog"
                onClick={(): void => setChooserOpen(true)}
              >
                View…
              </Button>
            )
          }
        />
      )}
      {chooserOpen && (
        <DialogModal
          title="Waiting sessions"
          subtitle="Opening a session doesn't resume it."
          maxWidth="md"
          onClose={(): void => setChooserOpen(false)}
          trapFocus
          initialFocusRef={firstSessionRef}
          dataTestId={`${testIdPrefix}-waiting-chooser`}
        >
          <Stack as="ul" gap="tight" aria-busy={state.kind === 'loading'}>
            {sessions.map((session, index) => (
              <li key={session.id}>
                <ListRow
                  ref={index === 0 ? firstSessionRef : undefined}
                  data-testid={`${testIdPrefix}-waiting-session-${session.id}`}
                  onClick={(): void => {
                    setChooserOpen(false);
                    waiting?.onOpenSession(session);
                  }}
                  description={
                    session.subtitle ? (
                      <span className={REPLAY_MASK_CLASS}>
                        {session.subtitle}
                      </span>
                    ) : undefined
                  }
                  trailing={openActionLabel(session.kind)}
                >
                  <span className={REPLAY_MASK_CLASS}>{session.title}</span>
                </ListRow>
              </li>
            ))}
          </Stack>
        </DialogModal>
      )}
    </>
  );
}
