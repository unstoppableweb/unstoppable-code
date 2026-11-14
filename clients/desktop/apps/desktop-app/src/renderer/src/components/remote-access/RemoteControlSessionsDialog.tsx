import { useEffect, useState, type JSX } from 'react';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { RemoteControlController } from '@canopy/desktop-shared/types';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { deviceKindLabel } from '@canopy/ui-app/remote-control';
import { Button, DialogModal } from '@canopy/ui-shared/components';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import {
  disconnectRemoteController,
  useLiveRemoteControllers,
  useRemoteControlStatusUi,
} from './remote-control-status';

/**
 * Who is controlling this computer, and Disconnect for each. The account
 * menu's Remote Control item opens it instead of the Remote Control dialog
 * while a session is live; a Disconnect that failed from the connect toast
 * opens it with the error. It closes itself when the last session ends, so
 * the next press of Remote Control opens the Remote Control dialog again.
 *
 * Primary actions only: the close button, Escape and the scrim dismiss it.
 * Renders nothing in a window that shows another computer.
 */
export function RemoteControlSessionsDialog(): JSX.Element | null {
  const live = useLiveRemoteControllers();
  const open = useRemoteControlStatusUi((s) => s.open);
  const setOpen = useRemoteControlStatusUi((s) => s.setOpen);
  const hasLive = live.length > 0;
  useEffect(() => {
    if (!hasLive) setOpen(false);
  }, [hasLive, setOpen]);
  if (!open || !hasLive) return null;
  return <SessionsDialog controllers={live} onClose={() => setOpen(false)} />;
}

function SessionsDialog({
  controllers,
  onClose,
}: {
  readonly controllers: readonly RemoteControlController[];
  readonly onClose: () => void;
}): JSX.Element {
  const failure = useRemoteControlStatusUi((s) => s.failure);
  const setFailure = useRemoteControlStatusUi((s) => s.setFailure);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const busy = busyDeviceId !== null;

  const disconnect = (controller: RemoteControlController): void => {
    setBusyDeviceId(controller.deviceId);
    void disconnectRemoteController(controller).finally(() =>
      setBusyDeviceId(null),
    );
  };

  return (
    <DialogModal
      onClose={onClose}
      maxWidth="sm"
      trapFocus
      closeOnBackdrop={!busy}
      closeButtonDisabled={busy}
      dataTestId="remote-control-sessions-dialog"
      // Named like the menu item that opens it; the rows name the devices,
      // so the title does not repeat them.
      title={REMOTE_CONTROL_LABEL}
      subtitle={
        controllers.length === 1
          ? '1 device can see and change everything here.'
          : `${controllers.length} devices can see and change everything here.`
      }
    >
      {/* No default margin: the body's gap spaces it. */}
      <DesktopErrorBanner
        errorSource="remote-control-sessions"
        className=""
        error={failure?.error}
        {...(failure?.details === undefined
          ? {}
          : { details: failure.details })}
        onDismiss={(): void => setFailure(null)}
        testId="remote-control-sessions-error"
      />
      <ul className="flex flex-col gap-3">
        {controllers.map((controller) => (
          <li
            key={controller.deviceId}
            className="flex min-w-0 items-center justify-between gap-3"
            data-testid={`remote-control-sessions-device-${controller.deviceId}`}
          >
            <span className="flex min-w-0 flex-col">
              <span
                className={`truncate text-s fg-primary ${POSTHOG_REPLAY_MASK_CLASS}`}
              >
                {controller.name}
              </span>
              <span className="text-xs fg-tertiary">
                {deviceKindLabel(controller.kind)}
              </span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              aria-busy={busyDeviceId === controller.deviceId}
              disabled={busy}
              onClick={() => disconnect(controller)}
              data-testid={`remote-control-sessions-disconnect-${controller.deviceId}`}
            >
              Disconnect
            </Button>
          </li>
        ))}
      </ul>
    </DialogModal>
  );
}
