import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type WorktreesFileChangedEvent,
} from '@canopy/desktop-shared/types';
import type { BackgroundServiceStatus } from '@canopy/desktop-shared/lib/background-service-status';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import { retryDesktopDaemonFilesConnection } from '../canopy-runtime/electron-daemon-files-access';
import { sendToAllWindows } from '../lib/window-send';
import { registerIpcHandler } from './register';

/**
 * The background service notice (CAN-5541): main's health status, its pushes
 * to every window, and Try again. Blocked for remote control: a window that
 * shows another computer reads Files through the bridge, never a daemon.
 * Remote controllers read the status from session snapshots (CAN-7061).
 */
export function registerBackgroundServiceHandlers(
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor,
): () => void {
  const health = getElectronDaemonHealth();
  registerIpcHandler<[], BackgroundServiceStatus>(
    IPC_CHANNELS.backgroundServiceStatus,
    () => health.getStatus(),
  );
  registerIpcHandler<[], BackgroundServiceStatus>(
    IPC_CHANNELS.backgroundServiceRetry,
    // `resolveCaller` refuses an untrusted sender before any attempt.
    (event) =>
      retryDesktopDaemonFilesConnection(event.sender, resolveCaller(event)),
  );
  let previous = health.getStatus().state;
  return health.onStatusChanged((status) => {
    const recovered = previous !== 'ok' && status.state === 'ok';
    // Remote Control carries only a shown failure.
    const remoteChanged =
      previous === 'unavailable' || status.state === 'unavailable';
    previous = status.state;
    sendToAllWindows(IPC_CHANNELS.backgroundServiceStatusChanged, status);
    if (remoteChanged)
      void import('../services/desktop-structure-signal')
        .then(({ scheduleDesktopStructureChanged }) =>
          scheduleDesktopStructureChanged('structural.background-service'),
        )
        .catch(() => undefined);
    if (recovered) {
      const event: WorktreesFileChangedEvent = { scope: 'all' };
      sendToAllWindows(IPC_CHANNELS.worktreesFileChanged, event);
    }
  });
}
