import {
  AgentPortError,
  type AgentActionCall,
  type AgentRemoteControlDialogOpenResult,
  type AgentRemoteControlDialogPort,
} from '@canopy/agent-actions';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol/ui-labels';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import {
  sendToWindowDetailed,
  type SendableBrowserWindow,
} from '../lib/window-send';

type RemoteControlServiceLike = {
  getState(request?: { discover?: boolean }): Promise<{ available?: boolean }>;
};

export interface DesktopRemoteControlDialogPortDeps {
  /** The main window of the calling chat, or null when it has none. */
  getWindow(
    call: AgentActionCall<CanopyInjectedToolRuntime>,
  ): SendableBrowserWindow | null;
  /** The Remote Control service, or null before it starts. */
  service(): Promise<RemoteControlServiceLike | null>;
}

function windowUnavailable(): AgentPortError {
  return new AgentPortError(
    'surface_unavailable',
    `The ${REMOTE_CONTROL_LABEL} dialog could not be reached because this chat has no open window. Retry once the window is open.`,
    true,
  );
}

function isOpenWindow(
  window: SendableBrowserWindow | null,
): window is SendableBrowserWindow {
  return window !== null && !window.isDestroyed();
}

/**
 * `remote_control.open_dialog` / `close_dialog` on desktop (CAN-7298): ask
 * the calling chat's main window to open or close its Remote Control dialog
 * over the one-way `remote-control:dialog-request` push. `opened` means the
 * request was delivered, not that the dialog is on screen: the window still
 * shows its disabled notice when its own state says Remote Control is
 * unavailable.
 */
export function createDesktopRemoteControlDialogPort(
  deps: DesktopRemoteControlDialogPortDeps,
): AgentRemoteControlDialogPort<CanopyInjectedToolRuntime> {
  return {
    open: async (call): Promise<AgentRemoteControlDialogOpenResult> => {
      // The window comes first, so a headless host answers
      // surface_unavailable rather than skipped.
      const window = deps.getWindow(call);
      if (!isOpenWindow(window)) throw windowUnavailable();
      const service = await deps.service();
      if (!service) return { status: 'unavailable' };
      const state = await service.getState({ discover: false });
      if (state.available === false) return { status: 'unavailable' };
      const delivery = sendToWindowDetailed(
        window,
        IPC_CHANNELS.remoteControlDialogRequest,
        { open: true },
      );
      if (!delivery.delivered) throw windowUnavailable();
      return { status: 'opened' };
    },
    close: (call): Promise<void> => {
      const delivery = sendToWindowDetailed(
        deps.getWindow(call),
        IPC_CHANNELS.remoteControlDialogRequest,
        { open: false },
      );
      if (!delivery.delivered) return Promise.reject(windowUnavailable());
      return Promise.resolve();
    },
  };
}

export const desktopRemoteControlDialogPort =
  createDesktopRemoteControlDialogPort({
    getWindow: (call) =>
      call.host.worktreeActionRuntime?.getWindow() ??
      call.host.settingsWindow?.() ??
      null,
    // Loaded on first use: the Remote Control runtime pulls in Electron-only
    // modules at load, and this port is reachable from the shared
    // agent-action host that main-process services (and their tests) import.
    service: async () => {
      const { getRemoteControlRuntime } =
        await import('../remote-control/electron-remote-control');
      return getRemoteControlRuntime()?.service ?? null;
    },
  });
