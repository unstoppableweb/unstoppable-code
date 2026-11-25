import { useEffect, useRef, useState, type JSX } from 'react';
import { NoticeButton } from '@canopy/ui-shared/components';
import {
  BACKGROUND_SERVICE_RESTART_LABEL,
  BACKGROUND_SERVICE_RESTARTING_LABEL,
  backgroundServiceNoticeCopy,
} from '@canopy/ui-shared/lib';
import { restartLocalApp } from '@/components/background-service/useLocalBackgroundServiceNotice';

/**
 * Restart app beside a write refused because the background service is
 * unavailable for the rest of this run (CAN-7137,
 * `external.background_service_unavailable`). Only a relaunch reconnects it.
 * Desktop-only: the shared banner and notice take it as an action and never
 * branch on host.
 *
 * When the restart can't be scheduled (a dev build, unsaved workflow edits)
 * the button returns to idle and the quit-and-reopen guidance the background
 * service notice gives shows beside it, since a dialog can cover that notice.
 */
export function DesktopRestartAppAction(): JSX.Element {
  const [restarting, setRestarting] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const restart = (): void => {
    if (restarting) return;
    setRestarting(true);
    void restartLocalApp()
      .then(
        (scheduled) => scheduled,
        () => false,
      )
      .then((scheduled) => {
        if (!mounted.current) return;
        if (!scheduled) setUnavailable(true);
        setRestarting(false);
      });
  };

  return (
    <>
      {unavailable ? (
        <span
          role="status"
          className="text-xs fg-secondary"
          data-testid="background-service-restart-unavailable"
        >
          {backgroundServiceNoticeCopy('idle', 'restart_app', true).message}
        </span>
      ) : null}
      <NoticeButton
        variant="primary"
        busy={restarting}
        busyLabel={BACKGROUND_SERVICE_RESTARTING_LABEL}
        onClick={restart}
        data-testid="background-service-restart"
      >
        {BACKGROUND_SERVICE_RESTART_LABEL}
      </NoticeButton>
    </>
  );
}
