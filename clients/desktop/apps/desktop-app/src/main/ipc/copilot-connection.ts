import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  type CopilotConnectionStatus,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';
import { assertCopilotHarnessEnabled } from '../copilot/feature-flag';
import { COPILOT_SETUP_TIMEOUT_MS } from '../copilot/connection';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
import { notifyModelCatalogChanged } from '../remote-projection/agent-catalog-compatibility';

const operations = new Set<{
  owner: number;
  controller: AbortController;
  done: Promise<unknown>;
  mutation: boolean;
}>();
let shuttingDown = false;

function assertOwner(event: IpcMainInvokeEvent): void {
  if (
    shuttingDown ||
    event.sender.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame ||
    !BrowserWindow.fromWebContents(event.sender)
  )
    throw new Error('Copilot setup window is unavailable.');
}

async function owned<T>(
  event: IpcMainInvokeEvent,
  mutation: boolean,
  run: (
    signal: AbortSignal,
    progress: (status: CopilotConnectionStatus) => void,
  ) => Promise<T>,
): Promise<T> {
  assertOwner(event);
  if (Array.from(operations).some((operation) => operation.mutation))
    throw new Error('Copilot setup is already running.');
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  const owner = event.sender;
  owner.once('destroyed', stop);
  owner.once('render-process-gone', stop);
  owner.once('did-start-navigation', stop);
  const previous = mutation ? Array.from(operations) : [];
  const done = Promise.resolve().then(async () => {
    for (const operation of previous) operation.controller.abort();
    await Promise.allSettled(previous.map((operation) => operation.done));
    assertOwner(event);
    controller.signal.throwIfAborted();
    return run(
      AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(mutation ? COPILOT_SETUP_TIMEOUT_MS : 60_000),
      ]),
      (status) => {
        if (!owner.isDestroyed() && !controller.signal.aborted)
          sendToWebContents(
            owner,
            IPC_CHANNELS.copilotConnectionProgress,
            status,
          );
      },
    );
  });
  const operation = { owner: owner.id, controller, done, mutation };
  operations.add(operation);
  try {
    return await done;
  } finally {
    operations.delete(operation);
    owner.off('destroyed', stop);
    owner.off('render-process-gone', stop);
    owner.off('did-start-navigation', stop);
  }
}

function publish(): void {
  broadcastModelRegistryUpdated();
  void notifyModelCatalogChanged().catch(() => undefined);
}

export async function shutdownCopilotConnections(): Promise<void> {
  shuttingDown = true;
  for (const operation of Array.from(operations)) operation.controller.abort();
  const { shutdownCopilotRuntimes } = await import('../copilot/connection');
  await Promise.allSettled([
    shutdownCopilotRuntimes(),
    ...Array.from(operations).map((operation) => operation.done),
  ]);
}

export function registerCopilotConnectionHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.copilotConnectionStatus, async (event) => {
    assertOwner(event);
    const { copilotConnectionStatus } = await import('../copilot/connection');
    return copilotConnectionStatus();
  });
  registerIpcHandler(IPC_CHANNELS.copilotConnectionModels, (event) =>
    owned(event, false, async (signal) => {
      assertCopilotHarnessEnabled();
      const { listCopilotModels } = await import('../copilot/connection');
      const models = await listCopilotModels(signal);
      publish();
      return models;
    }),
  );
  registerIpcHandler(IPC_CHANNELS.copilotConnectionUsage, (event) =>
    owned(event, false, async (signal) => {
      assertCopilotHarnessEnabled();
      return (await import('../copilot/connection')).readCopilotAccountUsage(
        signal,
      );
    }),
  );
  registerIpcHandler(IPC_CHANNELS.copilotConnectionAccount, (event) =>
    owned(event, false, async () => {
      assertCopilotHarnessEnabled();
      const { readCopilotAccount } = await import('../copilot/connection');
      return readCopilotAccount();
    }),
  );
  const connect = (
    event: IpcMainInvokeEvent,
    change: boolean,
  ): Promise<CopilotConnectionStatus> =>
    owned(event, true, async (signal, progress) => {
      assertCopilotHarnessEnabled();
      const { connectCopilot, listCopilotModels } =
        await import('../copilot/connection');
      try {
        const status = await connectCopilot(signal, progress, change);
        // A temporary catalog failure does not undo a confirmed account sign-in.
        await listCopilotModels(signal).catch(() => undefined);
        return status;
      } finally {
        publish();
      }
    });
  registerIpcHandler(IPC_CHANNELS.copilotConnectionConnect, (event) =>
    connect(event, false),
  );
  registerIpcHandler(IPC_CHANNELS.copilotConnectionChangeAccount, (event) =>
    connect(event, true),
  );
  registerIpcHandler(IPC_CHANNELS.copilotConnectionCancel, async (event) => {
    assertOwner(event);
    const pending = Array.from(operations).filter(
      (operation) => operation.owner === event.sender.id,
    );
    for (const operation of pending) operation.controller.abort();
    await Promise.allSettled(pending.map((operation) => operation.done));
  });
  registerIpcHandler(IPC_CHANNELS.copilotConnectionDisconnect, (event) =>
    owned(event, true, async () => {
      const { disconnectCopilot } = await import('../copilot/connection');
      await disconnectCopilot();
      publish();
    }),
  );
}
