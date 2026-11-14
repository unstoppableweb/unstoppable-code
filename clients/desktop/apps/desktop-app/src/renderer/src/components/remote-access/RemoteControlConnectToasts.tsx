import { useEffect, useRef } from 'react';
import { addToast } from '@/stores/toastStore';
import {
  disconnectRemoteController,
  useLiveRemoteControllers,
} from './remote-control-status';

/**
 * A device that drops out and comes back within this long is the same
 * session to the person at this computer (a reconnect, or an agents root
 * between delegated sessions), so it is not announced again.
 */
const REANNOUNCE_AFTER_MS = 60_000;

/**
 * Announces each device that starts controlling this computer with one
 * toast. The toast closes on its own like any update and offers Disconnect;
 * a failed Disconnect opens the connected-devices dialog with the error.
 * Afterwards the account menu's Remote Control item carries the connected
 * dot and opens that dialog.
 *
 * A device already connected when this window opens is announced too: the
 * person at this window has not been told yet. Renders nothing.
 */
export function RemoteControlConnectToasts(): null {
  const live = useLiveRemoteControllers();
  const announced = useRef<ReadonlySet<string>>(new Set());
  const goneAt = useRef(new Map<string, number>());

  useEffect(() => {
    const now = Date.now();
    for (const [deviceId, leftAt] of goneAt.current) {
      if (now - leftAt >= REANNOUNCE_AFTER_MS) goneAt.current.delete(deviceId);
    }
    const current = new Set(live.map((controller) => controller.deviceId));
    for (const deviceId of announced.current) {
      if (!current.has(deviceId)) goneAt.current.set(deviceId, now);
    }
    for (const controller of live) {
      if (announced.current.has(controller.deviceId)) continue;
      const leftAt = goneAt.current.get(controller.deviceId);
      goneAt.current.delete(controller.deviceId);
      if (leftAt !== undefined && now - leftAt < REANNOUNCE_AFTER_MS) continue;
      addToast(
        `${controller.name} can see and change everything here.`,
        'info',
        undefined,
        {
          // The device's name, often a person's, is in the message, which
          // replay can block; a toast title is always recorded.
          title: 'A device is controlling this computer',
          blockMessageFromReplay: true,
          category: 'Account',
          // A deliberate exception to `forceInApp` being for transactional
          // outcomes: another device controlling this computer must be
          // seen even with in-app notifications off. No OS banner: it leaves
          // as quietly as any update.
          forceInApp: true,
          suppressOsNotification: true,
          action: {
            label: 'Disconnect',
            busyLabel: 'Disconnecting…',
            testId: 'remote-control-connected-toast-disconnect',
            onClick: () => disconnectRemoteController(controller),
          },
        },
      );
    }
    announced.current = current;
  }, [live]);

  return null;
}
