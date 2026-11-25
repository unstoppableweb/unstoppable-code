import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  type AntigravityRuntimeStatus,
} from '@canopy/desktop-shared/types';
import {
  isProviderPlatformSupportedThroughWorker,
  type WorkerAgentProviderPlatformDispatcher,
} from '../agent-providers/provider-platform-projection';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';
import { validateId } from '../lib/validation';
import { sendToWebContents } from '../lib/web-contents-send';

/**
 * The one owner of the managed Antigravity CLI install: status, install,
 * cancel and the progress event. Install and cancel are local-only under
 * remote control; status and host support are readable remotely.
 */
let shuttingDown = false;

function assertOwner(event: IpcMainInvokeEvent): void {
  if (
    shuttingDown ||
    event.senderFrame !== event.sender.mainFrame ||
    event.sender.isDestroyed() ||
    !BrowserWindow.fromWebContents(event.sender)
  )
    throw new Error('Antigravity setup window is unavailable.');
}

function parseOperationId(value: unknown): string {
  validateId(value, 'Antigravity operation id');
  if (value.length > 200)
    throw new Error('Antigravity operation id is too long.');
  return value;
}

async function readStatus(): Promise<AntigravityRuntimeStatus> {
  const { antigravityRuntimeStatus } =
    await import('../antigravity/connection');
  return antigravityRuntimeStatus();
}

async function install(
  event: IpcMainInvokeEvent,
  operationId: string,
): Promise<AntigravityRuntimeStatus> {
  const owner = event.sender;
  const { installAntigravityRuntime, releaseAntigravityRuntimeInstall } =
    await import('../antigravity/connection');
  // A window that goes away cancels the install it started; one that only
  // joined it detaches, leaving the download to the window that started it.
  const stop = (): void => {
    void releaseAntigravityRuntimeInstall(operationId);
  };
  owner.once('destroyed', stop);
  owner.once('render-process-gone', stop);
  try {
    const status = await installAntigravityRuntime(operationId, (progress) => {
      if (!owner.isDestroyed())
        sendToWebContents(
          owner,
          IPC_CHANNELS.antigravityRuntimeProgress,
          progress,
        );
    });
    if (status.phase === 'installed' && status.managed) {
      // A probe that failed before the install would otherwise be served
      // from the 15-second availability cache, so the card's refresh right
      // after the install would not launch the new copy. Imported here
      // because models.ts already imports connection.ts.
      const { markAntigravityCatalogStale } =
        await import('../antigravity/models');
      markAntigravityCatalogStale();
    }
    return status;
  } finally {
    owner.off('destroyed', stop);
    owner.off('render-process-gone', stop);
  }
}

export async function shutdownAntigravityRuntimeInstalls(): Promise<void> {
  shuttingDown = true;
  const { shutdownAntigravityRuntimeInstall } =
    await import('../antigravity/connection');
  await shutdownAntigravityRuntimeInstall();
}

export function registerAntigravityRuntimeHandlers(runtime: {
  dispatcher: WorkerAgentProviderPlatformDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
}): void {
  registerIpcHandler(IPC_CHANNELS.antigravityRuntimeStatus, (event) => {
    assertOwner(event);
    return readStatus();
  });
  // A projection of worker.agent.provider.platform.get, which answers from
  // pinned artifacts alone: no executable lookup or hashing, so pickers and
  // Settings rows can ask on every window without touching the CLI.
  registerIpcHandler(
    IPC_CHANNELS.antigravityRuntimeHostSupport,
    (event): Promise<boolean> => {
      assertOwner(event);
      return isProviderPlatformSupportedThroughWorker(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        'antigravity',
      );
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.antigravityRuntimeInstall,
    (event, operationId?: unknown) => {
      assertOwner(event);
      return install(event, parseOperationId(operationId));
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.antigravityRuntimeCancel,
    async (event, operationId?: unknown) => {
      assertOwner(event);
      const { cancelAntigravityRuntimeInstall } =
        await import('../antigravity/connection');
      await cancelAntigravityRuntimeInstall(parseOperationId(operationId));
    },
  );
}
