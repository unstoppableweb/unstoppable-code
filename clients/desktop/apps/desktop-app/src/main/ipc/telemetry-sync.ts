import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type TelemetrySyncStatus,
} from '@canopy/desktop-shared/types';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { getTelemetrySyncPauseMonitor } from '../services/telemetry-sync-pause-host';
import { sendToWindow } from '../lib/window-send';
import { onIpcMessage, registerIpcHandler } from './register';

/**
 * Bridges the main-process `TelemetrySyncService` status surface, with the
 * pause monitor's `pausedReason`, to Settings › Privacy and the sidebar
 * account menu. Modeled on
 * `registerObservabilityHandlers`: a request-response getter plus a push
 * subscription that forwards every status snapshot to the main window.
 */
export function registerTelemetrySyncHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  const service = getTelemetrySyncService();
  // The pause monitor republishes the service status with `pausedReason`
  // attached (CAN-3512), so the renderer can say `Sync paused`.
  const status = getTelemetrySyncPauseMonitor();

  status.subscribeStatus((snapshot) => {
    sendToWindow(getWindow(), IPC_CHANNELS.telemetrySyncStatusEvent, snapshot);
  });

  registerIpcHandler(
    IPC_CHANNELS.telemetrySyncGetStatus,
    (): Promise<TelemetrySyncStatus> => Promise.resolve(status.getStatus()),
  );

  // Presence heartbeat (CAN-3195). One-way `on`, not `handle`: there is nothing
  // to return, and the renderer must never await a presence report. The service
  // only stamps an in-memory map, so this is cheap enough to sit on the main
  // event loop at the renderer's throttled cadence.
  onIpcMessage(
    IPC_CHANNELS.telemetrySyncRecordActivity,
    (_event, projectId: unknown, worktreeId: unknown) => {
      if (typeof projectId !== 'string' || typeof worktreeId !== 'string') {
        return;
      }
      service.recordUserActivity(projectId, worktreeId);
    },
  );
}
