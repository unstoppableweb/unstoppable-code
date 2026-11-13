import { app, type WebContents } from 'electron';
import { is } from '@electron-toolkit/utils';
import { restoreStartupEnvironmentForRelaunch } from '@canopy/execution-engine/pipelines/config-paths';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { UnsavedCloseGuard } from '../lifecycle/unsaved-close-guard';
import { registerIpcHandler } from './register';

export interface AppWindowUnsavedCloseOptions {
  guard: Pick<
    UnsavedCloseGuard,
    'setDirty' | 'isDirty' | 'handleShown' | 'handleDecision'
  >;
  /** Only the main window's renderer reports dirty state and answers. */
  isMainWindowSender: (sender: WebContents) => boolean;
}

function readConfirmCloseResponse(
  value: unknown,
):
  | { requestId: string; kind: 'shown' }
  | { requestId: string; kind: 'decided'; proceed: boolean }
  | null {
  if (typeof value !== 'object' || value === null) return null;
  const requestId: unknown = Reflect.get(value, 'requestId');
  const kind: unknown = Reflect.get(value, 'kind');
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  if (kind === 'shown') return { requestId, kind };
  if (kind !== 'decided') return null;
  const proceed: unknown = Reflect.get(value, 'proceed');
  if (typeof proceed !== 'boolean') return null;
  return { requestId, kind, proceed };
}

export function registerAppWindowHandlers(
  onStartupUnlocked: () => void,
  unsavedClose?: AppWindowUnsavedCloseOptions,
): void {
  registerIpcHandler<[], boolean>(IPC_CHANNELS.appWindowReload, (event) => {
    const sender = event.sender;
    if (sender.isDestroyed()) {
      return false;
    }

    setTimeout(() => {
      if (!sender.isDestroyed()) {
        sender.reloadIgnoringCache();
      }
    }, 0);

    return true;
  });

  registerIpcHandler<[], boolean>(IPC_CHANNELS.appWindowRestart, () => {
    if (is.dev) {
      return false;
    }

    // With unsaved workflow edits the quit would ask, and a relaunch queued
    // for a quit the user then cancels would fire on their next quit. Report
    // restart unavailable instead; callers already ask for a manual restart.
    if (unsavedClose?.guard.isDirty()) {
      return false;
    }

    setTimeout(() => {
      restoreStartupEnvironmentForRelaunch();
      app.relaunch();
      app.quit();
    }, 0);

    return true;
  });

  registerIpcHandler<[], void>(IPC_CHANNELS.appStartupUnlocked, () => {
    onStartupUnlocked();
  });

  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.appWindowSetUnsavedChanges,
    (event, dirty) => {
      if (!unsavedClose || typeof dirty !== 'boolean') return;
      if (!unsavedClose.isMainWindowSender(event.sender)) return;
      unsavedClose.guard.setDirty(dirty);
    },
  );

  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.appWindowConfirmCloseResponse,
    (event, value) => {
      if (!unsavedClose) return;
      if (!unsavedClose.isMainWindowSender(event.sender)) return;
      const response = readConfirmCloseResponse(value);
      if (!response) return;
      if (response.kind === 'shown') {
        unsavedClose.guard.handleShown(response.requestId);
        return;
      }
      unsavedClose.guard.handleDecision(response.requestId, response.proceed);
    },
  );
}
