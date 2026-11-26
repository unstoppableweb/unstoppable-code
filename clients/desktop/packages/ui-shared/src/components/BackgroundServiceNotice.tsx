'use client';
import { useState, type JSX } from 'react';
import type {
  BackgroundServiceStatus,
  W5RecoveryStatus,
} from '@canopy/protocol/remote-control/shell';
import {
  BACKGROUND_SERVICE_COPY_DIAGNOSTICS_LABEL,
  BACKGROUND_SERVICE_RESTART_LABEL,
  BACKGROUND_SERVICE_RESTARTING_LABEL,
  STARTUP_BACKUP_NOTICE_TITLE,
  STARTUP_BACKUP_NOTICE_MESSAGE,
  STARTUP_BACKUP_NOTICE_DISMISS_LABEL,
  backgroundServiceDiagnostics,
  backgroundServiceNoticeCopy,
} from '../lib/background-service-copy';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { CopyButton } from '../primitives/CopyButton';
import { InlineCode } from '../primitives/InlineCode';
import { NoticeButton } from '../primitives/Notice';
import { ToastCardNotice } from '../primitives/ToastNotice';
import { TRY_AGAIN_LABEL, TRYING_AGAIN_LABEL } from '../primitives/useRetry';

export interface BackgroundServiceNoticeProps {
  /** The owning computer's health and independent startup-backup advisory. */
  readonly status?: BackgroundServiceStatus;
  /** The host's branded repair command, for `endpoint_repair_required`. */
  readonly repairCommand?: string;
  /**
   * This computer's data folder, for `data_folder_shared`: local text the
   * host supplies, never part of the status Portal receives.
   */
  readonly dataFolder?: string;
  /**
   * Try again, where this host can run it. Without it, the copy points to
   * the app on the computer that runs the service.
   */
  readonly onRetry?: () => Promise<unknown>;
  /** Restart app; resolves whether the restart was scheduled. */
  readonly onRestart?: () => Promise<boolean>;
  /** Workspace recovery status, summarized in Copy diagnostics. */
  readonly recovery?: W5RecoveryStatus;
  /** Host clipboard writer; defaults to the browser clipboard. */
  readonly writeClipboard?: (text: string) => Promise<boolean>;
}

/**
 * The background service notice (CAN-5541, CAN-7061), the same on desktop
 * and Portal: the failure, the action that applies where the person is (Try
 * again, or Restart app after a degraded startup handoff) and Copy
 * diagnostics. A closed notice stays closed until the service is reached
 * and lost again.
 */
export function BackgroundServiceNotice(
  props: BackgroundServiceNoticeProps,
): JSX.Element {
  return (
    <>
      <BackgroundServiceUnavailableNotice {...props} />
      <StartupBackupNotice {...props} />
    </>
  );
}

function StartupBackupNotice({
  status,
  recovery,
  onRetry,
  writeClipboard,
}: BackgroundServiceNoticeProps): JSX.Element | null {
  const [closed, setClosed] = useState(false);
  // An actual outage takes priority; never describe an unavailable service as healthy.
  if (closed || status?.state !== 'ok' || status.backupWarning === undefined)
    return null;
  return (
    <ToastCardNotice
      intent="attention"
      title={STARTUP_BACKUP_NOTICE_TITLE}
      onDismiss={() => setClosed(true)}
      dismissLabel={STARTUP_BACKUP_NOTICE_DISMISS_LABEL}
      data-testid="startup-backup-notice"
      actions={
        <CopyButton
          value={backgroundServiceDiagnostics({
            status,
            recovery,
            place: onRetry === undefined ? 'remote-control' : 'this-computer',
          })}
          label={BACKGROUND_SERVICE_COPY_DIAGNOSTICS_LABEL}
          variant="secondary"
          // The toast\'s 32px action row, like the `NoticeButton`s beside it.
          size="md"
          dataTestId="startup-backup-notice-copy-diagnostics"
          {...(writeClipboard === undefined ? {} : { write: writeClipboard })}
        />
      }
    >
      <p>{STARTUP_BACKUP_NOTICE_MESSAGE}</p>
    </ToastCardNotice>
  );
}

function BackgroundServiceUnavailableNotice({
  status,
  repairCommand,
  dataFolder,
  onRetry,
  onRestart,
  recovery,
  writeClipboard,
}: BackgroundServiceNoticeProps): JSX.Element | null {
  const [closed, setClosed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartUnavailable, setRestartUnavailable] = useState(false);
  const unavailable = status?.state === 'unavailable';
  // Reached again: a later loss shows its notice even if this one was closed.
  if (!unavailable && closed) setClosed(false);
  if (!unavailable || closed) return null;
  const restartApp = status.recovery === 'restart_app';
  const action = restartApp ? onRestart : onRetry;
  const elsewhere = action === undefined;
  const dataFolderShared = status.reason === 'data_folder_shared';
  const copy = backgroundServiceNoticeCopy(
    status.retry,
    status.recovery,
    restartUnavailable,
    status.reason === 'endpoint_repair_required' ? repairCommand : undefined,
    elsewhere,
    dataFolderShared,
  );
  const retry = (): void => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    void onRetry()
      .catch(() => undefined)
      .finally(() => setRetrying(false));
  };
  const restart = (): void => {
    if (!onRestart || restarting) return;
    setRestarting(true);
    void onRestart()
      .then(
        (scheduled) => {
          if (!scheduled) setRestartUnavailable(true);
        },
        () => setRestartUnavailable(true),
      )
      .finally(() => setRestarting(false));
  };
  return (
    <ToastCardNotice
      intent="attention"
      title={copy.title}
      onDismiss={() => setClosed(true)}
      dismissLabel="Dismiss background service notice"
      data-testid="background-service-notice"
      actions={
        <>
          <CopyButton
            value={backgroundServiceDiagnostics({
              status,
              recovery,
              place: elsewhere ? 'remote-control' : 'this-computer',
            })}
            label={BACKGROUND_SERVICE_COPY_DIAGNOSTICS_LABEL}
            variant="secondary"
            // The toast\'s 32px action row, like the `NoticeButton`s beside it.
            size="md"
            dataTestId="background-service-notice-copy-diagnostics"
            {...(writeClipboard === undefined ? {} : { write: writeClipboard })}
          />
          {restartApp && onRestart ? (
            <NoticeButton
              variant="primary"
              busy={restarting}
              busyLabel={BACKGROUND_SERVICE_RESTARTING_LABEL}
              onClick={restart}
              data-testid="background-service-notice-restart"
            >
              {BACKGROUND_SERVICE_RESTART_LABEL}
            </NoticeButton>
          ) : null}
          {!restartApp && onRetry ? (
            <NoticeButton
              variant="primary"
              busy={retrying || status.retry === 'running'}
              busyLabel={TRYING_AGAIN_LABEL}
              onClick={retry}
              data-testid="background-service-notice-retry"
            >
              {TRY_AGAIN_LABEL}
            </NoticeButton>
          ) : null}
        </>
      }
    >
      {/* The repair command is one token; it wraps instead of running under the actions. */}
      <p className="break-words">{copy.message}</p>
      {dataFolderShared && !elsewhere && dataFolder ? (
        // The path names the account; replay records a placeholder.
        <p
          className={`break-all ${REPLAY_BLOCK_CLASS}`}
          data-testid="background-service-notice-data-folder"
        >
          <InlineCode>{dataFolder}</InlineCode>
        </p>
      ) : null}
    </ToastCardNotice>
  );
}
