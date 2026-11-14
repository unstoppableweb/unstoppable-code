import { useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { MacbookIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { describeError } from './remote-access-copy';

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

  if (host.ended) {
    const reconnect = (): void => {
      setBusy(true);
      setError(null);
      void openMachine(remote.deviceId)
        .catch((cause: unknown) => {
          setError(describeError(cause, "Couldn't reconnect. Try again."));
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
      >
        {host.error ? `${host.error} Trying again…` : 'Trying again…'}
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
