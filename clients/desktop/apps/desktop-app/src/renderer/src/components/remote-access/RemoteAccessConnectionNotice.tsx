import { useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import type {
  RemoteControlHostUpdateAction,
  RemoteHostUpdateStatus,
  UpdatePhase,
} from '@canopy/desktop-shared/types';
import {
  Notice,
  NoticeButton,
  RemoteHostUpdateNotice,
} from '@canopy/ui-shared/components';
import { MacbookIcon } from '@canopy/ui-shared/icons/AppIcons';
import { toAppError, type AppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { useUpdateState } from '@/hooks/useUpdateState';
import {
  inlineFailureText,
  inlineFailureWithMainSentence,
} from '@/lib/inline-app-error';
import { useRemoteControlStore } from '@/stores/remoteControlStore';

/**
 * A failed action's sentence: main's own words when it wrote one (the other
 * computer refusing an update step), otherwise `fallback`. Null when the
 * action was cancelled.
 */
function failureText(
  appError: AppError | undefined,
  fallback: string,
): string | null {
  if (!appError) return null;
  return inlineFailureText(inlineFailureWithMainSentence(appError, fallback));
}

interface UpdateNoticeProps {
  deviceId: string;
  name: string;
  update: RemoteHostUpdateStatus;
  onReconnect: () => Promise<void>;
}

/** The other computer is older: this one asks it to update (CAN-5899). */
function HostUpdateNotice({
  deviceId,
  name,
  update,
  onReconnect,
}: UpdateNoticeProps): JSX.Element {
  const updateHost = useRemoteControlStore((store) => store.updateHost);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (step: () => Promise<void>, fallback: string): void => {
    setBusy(true);
    setError(null);
    void step()
      .catch((cause: unknown) =>
        setError(
          failureText(toAppError(resolveClientAppError(cause)), fallback),
        ),
      )
      .finally(() => setBusy(false));
  };
  const act = (action: RemoteControlHostUpdateAction): void =>
    run(
      () => updateHost({ deviceId, action }),
      `Couldn't reach ${name}. Try again.`,
    );
  return (
    <RemoteHostUpdateNotice
      computerName={name}
      update={update}
      busy={busy}
      error={error}
      onUpdate={() => act('update')}
      onRestartNow={() => act('restart-now')}
      onCancel={() => act('cancel')}
      onReconnect={() => run(onReconnect, "Couldn't reconnect. Try again.")}
      icon={<MacbookIcon size={16} aria-hidden="true" />}
      className="pointer-events-auto"
      data-testid="remote-access-connection-notice"
    />
  );
}

/**
 * This computer's updater phases as the notice shows them. While it checks or
 * downloads, the notice offers no action, so a second click can't start the
 * same step again.
 */
const LOCAL_UPDATE_PHASES: Readonly<
  Record<UpdatePhase, RemoteHostUpdateStatus['phase']>
> = {
  idle: 'ready',
  available: 'ready',
  checking: 'checking',
  downloading: 'downloading',
  downloaded: 'downloaded',
  'not-available': 'up-to-date',
  error: 'failed',
};

/**
 * This computer is older: it updates itself through its own updater, whose
 * channels stay on this computer in every window.
 */
function LocalUpdateNotice({
  name,
  update,
  onReconnect,
}: Omit<UpdateNoticeProps, 'deviceId'>): JSX.Element {
  const { state } = useUpdateState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (step: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    void step()
      .catch((cause: unknown) =>
        setError(
          failureText(
            toAppError(resolveClientAppError(cause)),
            "Couldn't update. Try again.",
          ),
        ),
      )
      .finally(() => setBusy(false));
  };
  const local: RemoteHostUpdateStatus = {
    ...update,
    phase: LOCAL_UPDATE_PHASES[state.phase],
    progress:
      state.phase === 'downloading' && state.progress
        ? state.progress.percent / 100
        : null,
    detail: state.phase === 'error' ? (state.message ?? null) : null,
  };
  return (
    <RemoteHostUpdateNotice
      computerName={name}
      update={local}
      busy={busy}
      error={error}
      onUpdate={() =>
        run(async () => {
          if (state.phase !== 'available') {
            await window.api.update.checkForUpdates();
            const checked = await window.api.update.getState();
            if (checked.phase !== 'available') return;
          }
          await window.api.update.downloadUpdate();
        })
      }
      onRestartNow={() => run(() => window.api.update.installUpdate())}
      // This computer's own update has no restart another computer asked for.
      onCancel={() => undefined}
      onReconnect={() => run(onReconnect)}
      icon={<MacbookIcon size={16} aria-hidden="true" />}
      className="pointer-events-auto"
      data-testid="remote-access-connection-notice"
    />
  );
}

/**
 * Connection state inside a window that shows another computer. While the
 * connection is down it says so: it retries on its own and the window
 * reloads once it is back. When the other computer ended the session nothing
 * retries, so it gives the reason and a way to reconnect. Mounted beside App
 * (`MainWindowApp`) in its own top layer, so it also shows over App's startup
 * screens; it renders nothing in this computer's own windows or while
 * connected.
 */
export function RemoteAccessConnectionNotice(): JSX.Element | null {
  const { remote, host, openMachine } = useRemoteControlStore(
    useShallow((store) => {
      const context = store.context.mode === 'remote' ? store.context : null;
      return {
        remote: context,
        host: context
          ? (store.state.hosts.find(
              (entry) => entry.deviceId === context.deviceId,
            ) ?? null)
          : null,
        openMachine: store.openMachine,
      };
    }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!remote || !host) return null;
  const name = host.name;
  let notice: JSX.Element | null = null;

  if (host.update) {
    const reconnect = (): Promise<void> => openMachine(remote.deviceId);
    notice =
      host.update.target === 'host' ? (
        <HostUpdateNotice
          deviceId={remote.deviceId}
          name={name}
          update={host.update}
          onReconnect={reconnect}
        />
      ) : (
        <LocalUpdateNotice
          name={name}
          update={host.update}
          onReconnect={reconnect}
        />
      );
  } else if (host.ended) {
    const reconnect = (): void => {
      setBusy(true);
      setError(null);
      void openMachine(remote.deviceId)
        .catch((cause: unknown) => {
          setError(
            failureText(
              toAppError(resolveClientAppError(cause)),
              "Couldn't reconnect. Try again.",
            ),
          );
        })
        .finally(() => setBusy(false));
    };
    notice = (
      <Notice
        intent="attention"
        icon={<MacbookIcon size={16} aria-hidden="true" />}
        title={`Disconnected from ${name}`}
        detail={error ?? undefined}
        className="pointer-events-auto"
        data-testid="remote-access-connection-notice"
        data-state="ended"
        actions={
          <NoticeButton
            variant="primary"
            disabled={busy}
            onClick={reconnect}
            data-testid="remote-access-connection-notice-reconnect"
          >
            Reconnect
          </NoticeButton>
        }
      >
        {host.error ?? 'The session ended.'}
      </Notice>
    );
  } else if (host.connection === 'connecting') {
    notice = (
      <Notice
        intent="neutral"
        icon={<MacbookIcon size={16} aria-hidden="true" />}
        title={`Connecting to ${name}…`}
        className="pointer-events-auto"
        data-testid="remote-access-connection-notice"
        data-state="reconnecting"
      >
        This window reloads once it is back.
      </Notice>
    );
  } else if (host.connection === 'error') {
    notice = (
      <Notice
        intent="attention"
        icon={<MacbookIcon size={16} aria-hidden="true" />}
        title={`Can't reach ${name}`}
        className="pointer-events-auto"
        data-testid="remote-access-connection-notice"
        data-state="reconnecting"
        detail="Trying again…"
      >
        {host.error ?? null}
      </Notice>
    );
  }

  if (!notice) return null;
  // Below the title bar, above App's startup screens (`z-modal`).
  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-toast flex justify-center px-4">
      <div className="electron-no-drag w-full max-w-xl">{notice}</div>
    </div>
  );
}
