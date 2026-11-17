'use client';
import type { JSX } from 'react';
import type { W5RecoveryStatus } from '@canopy/protocol/portal';
import {
  w5RecoveryGuidance,
  W5_RECOVERY_QUIT_ALL_GUIDANCE,
} from '../lib/w5-recovery-copy';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Notice, NoticeButton } from './Notice';

export interface W5RecoveryNoticeProps {
  readonly status?: W5RecoveryStatus;
  /** Live archive review does not grant access to cold workspace recovery. */
  readonly archiveRecovery?: {
    readonly unavailable: boolean;
    readonly cleanupOnly?: boolean;
    readonly onReview: () => void;
    readonly onDismiss?: () => void;
  };
  /** Host capability, independent from the target desktop's status. Default-deny. */
  readonly canRecover?: boolean;
  readonly onRecover?: () => void;
  readonly busy?: boolean;
}

export function W5RecoveryNotice({
  status,
  archiveRecovery,
  canRecover = false,
  onRecover,
  busy = false,
}: W5RecoveryNoticeProps): JSX.Element | null {
  const cold = status && status.state !== 'hidden' ? status : null;
  if (!cold && !archiveRecovery) return null;
  const restart = cold?.state === 'restart-required';
  const complete = cold?.state === 'complete';
  return (
    <Notice
      intent={complete && !archiveRecovery ? 'positive' : 'attention'}
      title={
        !cold
          ? archiveRecovery?.cleanupOnly
            ? 'Archive cleanup available'
            : 'Archive recovery needs attention'
          : restart
            ? 'Workspace recovery needs a restart'
            : complete
              ? 'Workspace recovery finished'
              : cold.state === 'refused'
                ? 'Workspace recovery needs attention'
                : 'Some workspace changes are blocked'
      }
      className="pointer-events-auto"
      onDismiss={archiveRecovery?.onDismiss}
      dismissLabel="Dismiss archive recovery notice"
      data-testid="w5-recovery-notice"
      actions={
        archiveRecovery || (canRecover && cold?.canRecover && onRecover) ? (
          <>
            {archiveRecovery ? (
              <NoticeButton
                onClick={archiveRecovery.onReview}
                data-testid="worktree-live-recovery-notice"
              >
                {archiveRecovery.cleanupOnly
                  ? 'Open archive cleanup'
                  : 'Review archive recovery'}
              </NoticeButton>
            ) : null}
            {canRecover && cold?.canRecover && onRecover ? (
              <NoticeButton
                busy={busy}
                busyLabel="Preparing recovery…"
                onClick={onRecover}
                data-testid="w5-recovery-start"
              >
                Restart for recovery
              </NoticeButton>
            ) : null}
          </>
        ) : undefined
      }
    >
      {archiveRecovery ? (
        <p>
          {archiveRecovery.unavailable
            ? "Some archive recovery records couldn't be checked."
            : archiveRecovery.cleanupOnly
              ? 'The archives finished. Leftover saved change data still needs cleanup.'
              : 'Some archives need recovery or cleanup. Choose how to continue or get details to share with support.'}
        </p>
      ) : null}
      {cold ? (
        <>
          <p>
            {restart
              ? 'Quit and reopen the app to inspect the records and choose what to do. Writes are paused until restart.'
              : complete
                ? 'The selected recovery decisions finished.'
                : w5RecoveryGuidance(cold.reason)}
          </p>
          {!complete &&
            cold.state !== 'refused' &&
            cold.reason !== 'platform-unsupported' && (
              <p>{W5_RECOVERY_QUIT_ALL_GUIDANCE}</p>
            )}
          {!canRecover && !restart && !complete && (
            <p>
              Recover workspace records in the app on the computer that holds
              them. This step cannot run from Remote Control.
            </p>
          )}
          {cold.entries.length > 0 && (
            <ul className={REPLAY_BLOCK_CLASS}>
              {cold.entries.slice(0, 5).map((entry) => (
                <li key={entry.id}>
                  {entry.operation}: {entry.detail.slice(0, 160)}
                </li>
              ))}
            </ul>
          )}
          {cold.entries.length > 5 && (
            <p>More changes are included in the recovery diagnosis.</p>
          )}
        </>
      ) : null}
    </Notice>
  );
}
