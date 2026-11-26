import { useState, type JSX, type ReactNode } from 'react';
import type { RemoteHostUpdateStatus } from '@canopy/protocol/remote-control';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol/ui-labels';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Notice, NoticeButton, type NoticeIntent } from '../primitives/Notice';
import { CopyDetailsButton } from '../primitives/CopyDetailsButton';

/*
 * The notice a window shows when it can't show another computer because the
 * two run different remote-control protocols (CAN-5899). It names the
 * computer that has to update and offers that update. Pure display: the host
 * app supplies the status and runs the actions, so any surface that can
 * update a paired computer words it the same way.
 */

/** The host's Settings switch that lets paired computers update it. */
export const REMOTE_UPDATES_SWITCH_LABEL =
  'Let computers that control this one update it';

export interface RemoteHostUpdateCopy {
  readonly title: string;
  readonly body: string;
  /**
   * Text from the updating computer itself, such as its manual update
   * commands or an updater error, shown after the body and kept out of
   * session replay.
   */
  readonly hostText: string | null;
  readonly intent: Exclude<NoticeIntent, 'destructive'>;
}

const FLAVOR_LABELS: Readonly<Record<string, string>> = {
  stable: 'stable',
  rc: 'RC',
  internal: 'internal',
};

function flavorLabel(flavor: string | null): string | null {
  if (flavor === null) return null;
  return FLAVOR_LABELS[flavor] ?? null;
}

function percent(progress: number | null): string {
  if (progress === null) return '';
  return ` ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

/** Why the older computer's channel has nothing that the other can use. */
function upToDateBody(name: string, update: RemoteHostUpdateStatus): string {
  const host = flavorLabel(update.hostFlavor);
  const local = flavorLabel(update.localFlavor);
  if (update.target === 'this-computer') {
    return `This computer has the latest update on its release channel, which can't control ${name} yet. Try again once a newer release is out.`;
  }
  if (host !== null && local !== null && host !== local) {
    return `${name} has the latest ${host} build, which this ${local} build can't control yet. Try again once a newer ${host} build is out.`;
  }
  return `${name} has the latest update on its release channel, which this computer can't control yet. Try again once a newer release is out.`;
}

function unavailableBody(name: string, update: RemoteHostUpdateStatus): string {
  switch (update.reason) {
    case 'remote-updates-off':
      return `${name} doesn't allow updates from other computers. Update it on ${name}, or turn on "${REMOTE_UPDATES_SWITCH_LABEL}" in its ${REMOTE_CONTROL_LABEL} settings.`;
    case 'development-build':
      return `${name} runs a development build and can't update itself.`;
    case 'windows-host':
      return `Updating a Windows computer from another computer isn't available yet. Update ${name} on ${name} to connect.`;
    case 'manual-update':
      // Its own steps follow as host text.
      return update.detail
        ? `${name} can't install updates on its own.`
        : `${name} can't install updates on its own. Update it on ${name} to connect.`;
    default:
      return `Update ${name} on ${name} to connect.`;
  }
}

function readyBody(name: string, update: RemoteHostUpdateStatus): string {
  if (update.reason === 'restarted-without-updating') {
    return `${name} restarted without updating. Try again, or update it on ${name}.`;
  }
  if (update.reason === 'cancelled-at-host') {
    return `Someone at ${name} cancelled the update.`;
  }
  if (update.target === 'this-computer') {
    return 'Update this computer to connect.';
  }
  return `Update it from here. It restarts once nothing is running on it, and this window reconnects.`;
}

function waitingBody(name: string, update: RemoteHostUpdateStatus): string {
  const asked = update.requestedBy
    ? `${update.requestedBy} asked ${name} to update. `
    : '';
  return update.waitingForChats
    ? `${asked}Waiting for running chats on ${name} to finish. It restarts to update after that.`
    : `${asked}${name} restarts to update in a moment.`;
}

/** The title, body and tone of the notice for a status. */
export function describeRemoteHostUpdate(
  name: string,
  update: RemoteHostUpdateStatus,
): RemoteHostUpdateCopy {
  const title =
    update.target === 'host'
      ? `${name} needs an update`
      : `Update this computer to control ${name}`;
  const versions =
    update.target === 'host'
      ? `${name} runs ${update.hostVersion}, which this computer (${update.localVersion}) can't control.`
      : `This computer runs ${update.localVersion}, which can't control ${name} (${update.hostVersion}).`;
  const subject = update.target === 'host' ? name : 'this computer';
  switch (update.phase) {
    case 'ready':
      return {
        title,
        body: `${versions} ${readyBody(name, update)}`,
        intent: 'neutral',
        hostText: null,
      };
    case 'checking':
      return {
        title,
        body: `Checking ${subject} for updates…`,
        intent: 'neutral',
        hostText: null,
      };
    case 'downloading':
      return {
        title,
        body: `Downloading the update to ${subject}…${percent(update.progress)}`,
        intent: 'neutral',
        hostText: null,
      };
    case 'downloaded':
      return {
        title,
        body: 'The update is ready. Restart to finish updating.',
        intent: 'neutral',
        hostText: null,
      };
    case 'waiting':
      return {
        title,
        body: waitingBody(name, update),
        intent: 'neutral',
        hostText: null,
      };
    case 'restarting':
      return {
        title: `Restarting ${name}…`,
        body: `${name} is installing the update. This window reconnects when it's back.`,
        intent: 'neutral',
        hostText: null,
      };
    case 'reconnecting':
      return {
        title,
        body: `Reconnecting to ${name}…`,
        intent: 'neutral',
        hostText: null,
      };
    case 'not-back':
      return {
        title: `${name} hasn't come back`,
        body: `${name} restarted to update and hasn't come back yet. Check that it's on and connected, then reconnect.`,
        intent: 'attention',
        hostText: null,
      };
    case 'up-to-date':
      return {
        title,
        body: upToDateBody(name, update),
        intent: 'attention',
        hostText: null,
      };
    case 'failed':
      return {
        title: `Couldn't update ${subject}`,
        body:
          update.reason === 'targeted-update-pending'
            ? `Someone at ${name} picked a specific version to install. Finish or cancel it on ${name}.`
            : '',
        intent: 'attention',
        // The host's raw reason goes behind Copy details, never in the copy.
        hostText: null,
      };
    case 'unavailable':
      return {
        title,
        body: `${versions} ${unavailableBody(name, update)}`,
        intent: 'attention',
        hostText: update.reason === 'manual-update' ? update.detail : null,
      };
  }
}

export interface RemoteHostUpdateNoticeProps {
  /** The other computer's name. */
  readonly computerName: string;
  readonly update: RemoteHostUpdateStatus;
  /** An action this window started is still running. */
  readonly busy: boolean;
  /** Why the last action failed, in this window's words. */
  readonly error: string | null;
  /** Starts the update, or tries it again. */
  readonly onUpdate: () => void;
  /** Restarts the updating computer now instead of waiting. */
  readonly onRestartNow: () => void;
  /** Withdraws the restart this computer asked for. */
  readonly onCancel: () => void;
  readonly onReconnect: () => void;
  readonly icon?: ReactNode;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

export function RemoteHostUpdateNotice({
  computerName,
  update,
  busy,
  error,
  onUpdate,
  onRestartNow,
  onCancel,
  onReconnect,
  icon,
  className,
  'data-testid': dataTestId,
}: RemoteHostUpdateNoticeProps): JSX.Element {
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const copy = describeRemoteHostUpdate(computerName, update);
  const host = update.target === 'host';
  const confirming =
    confirmingRestart && update.phase === 'waiting' && update.waitingForChats;

  let actions: ReactNode = null;
  if (confirming) {
    actions = (
      <>
        <NoticeButton
          onClick={() => setConfirmingRestart(false)}
          data-testid="remote-host-update-keep-waiting"
        >
          Keep waiting
        </NoticeButton>
        <NoticeButton
          variant="primary"
          busy={busy}
          onClick={() => {
            setConfirmingRestart(false);
            onRestartNow();
          }}
          data-testid="remote-host-update-restart-confirm"
        >
          Restart now
        </NoticeButton>
      </>
    );
  } else {
    switch (update.phase) {
      case 'ready':
        actions = (
          <NoticeButton
            variant="primary"
            busy={busy}
            onClick={onUpdate}
            data-testid="remote-host-update-start"
          >
            {host ? `Update ${computerName}` : 'Update this computer'}
          </NoticeButton>
        );
        break;
      case 'failed':
        actions = (
          <>
            {update.reason !== 'targeted-update-pending' && update.detail ? (
              <CopyDetailsButton
                details={update.detail}
                data-testid="remote-host-update-copy-details"
              />
            ) : null}
            <NoticeButton
              variant="primary"
              busy={busy}
              onClick={onUpdate}
              data-testid="remote-host-update-retry"
            >
              Try again
            </NoticeButton>
          </>
        );
        break;
      case 'up-to-date':
        actions = (
          <NoticeButton
            busy={busy}
            onClick={onUpdate}
            data-testid="remote-host-update-check-again"
          >
            Check again
          </NoticeButton>
        );
        break;
      case 'downloaded':
        actions = (
          <NoticeButton
            variant="primary"
            busy={busy}
            onClick={onRestartNow}
            data-testid="remote-host-update-restart"
          >
            Restart to update
          </NoticeButton>
        );
        break;
      case 'waiting':
        actions =
          update.canCancel || update.waitingForChats ? (
            <>
              {update.canCancel ? (
                <NoticeButton
                  busy={busy}
                  onClick={onCancel}
                  data-testid="remote-host-update-cancel"
                >
                  Cancel update
                </NoticeButton>
              ) : null}
              {update.waitingForChats ? (
                <NoticeButton
                  variant="primary"
                  disabled={busy}
                  onClick={() => setConfirmingRestart(true)}
                  data-testid="remote-host-update-restart-now"
                >
                  {`Restart ${computerName} now`}
                </NoticeButton>
              ) : null}
            </>
          ) : null;
        break;
      case 'not-back':
      case 'unavailable':
        actions = (
          <NoticeButton
            variant="primary"
            busy={busy}
            onClick={onReconnect}
            data-testid="remote-host-update-reconnect"
          >
            Reconnect
          </NoticeButton>
        );
        break;
      case 'checking':
      case 'downloading':
      case 'restarting':
      case 'reconnecting':
        actions = null;
        break;
    }
  }

  return (
    <Notice
      intent={copy.intent}
      icon={icon}
      title={copy.title}
      detail={error ?? undefined}
      actions={actions ?? undefined}
      className={className}
      data-testid={dataTestId}
      data-phase={update.phase}
      data-target={update.target}
    >
      {confirming ? (
        `Chats running on ${computerName} stop when it restarts.`
      ) : (
        <>
          {copy.body}
          {copy.hostText ? (
            <>
              {' '}
              <span className={REPLAY_BLOCK_CLASS}>{copy.hostText}</span>
            </>
          ) : null}
        </>
      )}
    </Notice>
  );
}
