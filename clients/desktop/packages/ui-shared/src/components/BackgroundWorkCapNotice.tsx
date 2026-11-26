'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import { StopwatchIcon } from '../icons/AppIcons';
import { ComposerDrawerSection } from './ComposerDrawer';
import { Notice, NoticeButton } from '../primitives/Notice';

export interface BackgroundWorkCapNoticeProps {
  /** Epoch ms at which the chat's background work stops for inactivity. */
  readonly capExpiresAtMs: number;
  /** The clock the host ticks; the notice never reads the time itself. */
  readonly nowMs: number;
  /**
   * Moves the stop later. Absent when it can't be moved, or the viewer may
   * not prompt the chat: the notice then only explains.
   */
  readonly onKeepRunning?: () => Promise<void>;
}

const MINUTE_MS = 60_000;

/** Whole minutes left, rounded up and never under one. */
export function backgroundWorkCapMinutes(
  capExpiresAtMs: number,
  nowMs: number,
): number {
  return Math.max(1, Math.ceil((capExpiresAtMs - nowMs) / MINUTE_MS));
}

/** The notice's sentence for the time left. */
export function backgroundWorkCapMessage(
  capExpiresAtMs: number,
  nowMs: number,
): string {
  return `Background work stops in ${backgroundWorkCapMinutes(capExpiresAtMs, nowMs)} min because this chat has been idle.`;
}

export const BACKGROUND_WORK_KEEP_RUNNING_LABEL = 'Keep running';
export const BACKGROUND_WORK_KEEP_RUNNING_FAILED =
  "Couldn't keep it running. Try again.";

/**
 * The composer drawer's warning that a chat's background work is about to
 * stop because nobody has used the chat (security B1). Pure display: the host
 * decides when it shows, ticks the clock and says what Keep running does.
 */
export function BackgroundWorkCapNotice({
  capExpiresAtMs,
  nowMs,
  onKeepRunning,
}: BackgroundWorkCapNoticeProps): JSX.Element {
  const [state, setState] = useState<'idle' | 'extending' | 'failed'>('idle');
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const keepRunning = async (): Promise<void> => {
    if (onKeepRunning === undefined || state === 'extending') return;
    setState('extending');
    try {
      await onKeepRunning();
      if (mountedRef.current) setState('idle');
    } catch {
      if (mountedRef.current) setState('failed');
    }
  };

  // The drawer is the surface, so the notice draws only its line, at the
  // inset of the drawer's rows.
  return (
    <ComposerDrawerSection data-testid="background-work-cap-notice">
      <Notice
        shape="menu"
        surface="none"
        icon={<StopwatchIcon size={16} aria-hidden="true" />}
        detail={
          state === 'failed' ? (
            <span data-testid="background-work-cap-notice-error">
              {BACKGROUND_WORK_KEEP_RUNNING_FAILED}
            </span>
          ) : undefined
        }
        announceDetail
        actions={
          onKeepRunning === undefined ? undefined : (
            <NoticeButton
              busy={state === 'extending'}
              busyLabel="Extending…"
              // Not natively disabled: the button keeps keyboard focus, so a
              // failed request can be retried from where the person is.
              aria-disabled={state === 'extending' || undefined}
              onClick={(): void => {
                void keepRunning();
              }}
              data-testid="background-work-keep-running"
            >
              {BACKGROUND_WORK_KEEP_RUNNING_LABEL}
            </NoticeButton>
          )
        }
      >
        <span data-testid="background-work-cap-notice-message">
          {backgroundWorkCapMessage(capExpiresAtMs, nowMs)}
        </span>
      </Notice>
    </ComposerDrawerSection>
  );
}
