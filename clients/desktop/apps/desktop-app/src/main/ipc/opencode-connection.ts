import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  type OpenCodeConnectionStatus,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';
import { OPENCODE_CONNECTION_TIMEOUT_MS } from '@canopy/desktop-shared/types/opencode-connection';
import type { OpenCodeModelEntry } from '@canopy/execution-engine/types/opencode-models';
import { validateId } from '../lib/validation';
import { sendToWebContents } from '../lib/web-contents-send';
import { peekOpenCodeRuntimeAvailability } from '../opencode/runtime-availability';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
import { notifyModelCatalogChanged } from '../remote-projection/agent-catalog-compatibility';
import type { OpenCodeRevokeOptions } from '../opencode/connection';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import {
  SIGN_IN_ALREADY_RUNNING_MESSAGE,
  holdOpenCodeSignInStarts,
  wouldEndAnotherOwnersOpenCodeSignIn,
} from './sign-in-owner-guard';

const operations = new Set<{
  owner: number;
  controller: AbortController;
  done: Promise<unknown>;
  mutation: boolean;
  operationId?: string;
}>();
let shuttingDown = false;

type OpenCodeOwner = IpcMainInvokeEvent['sender'];

function assertOwnerContents(owner: OpenCodeOwner): void {
  if (
    shuttingDown ||
    owner.isDestroyed() ||
    !BrowserWindow.fromWebContents(owner)
  )
    throw new Error('OpenCode setup window is unavailable.');
}

function assertOwner(event: IpcMainInvokeEvent): void {
  if (event.senderFrame !== event.sender.mainFrame)
    throw new Error('OpenCode setup window is unavailable.');
  assertOwnerContents(event.sender);
}

/**
 * Connect and disconnect revoke every live OpenCode runtime, which ends an
 * OpenCode sign-in running on one. A remote bridge may not do that to a
 * sign-in another window started or is starting (CAN-6718); this
 * computer's own window still may, as it may replace any sign-in.
 */
function assertSignInsUntouched(event: IpcMainInvokeEvent): void {
  if (
    resolveRemoteBridgeSender(event.sender) !== null &&
    wouldEndAnotherOwnersOpenCodeSignIn(event.sender)
  )
    throw new Error(SIGN_IN_ALREADY_RUNNING_MESSAGE);
}

async function owned<T>(
  event: IpcMainInvokeEvent,
  mutation: boolean,
  run: (
    signal: AbortSignal,
    progress: (status: OpenCodeConnectionStatus) => void,
  ) => Promise<T>,
  operationId?: string,
): Promise<T> {
  assertOwner(event);
  return ownedBy(event.sender, mutation, run, operationId);
}

async function ownedBy<T>(
  owner: OpenCodeOwner,
  mutation: boolean,
  run: (
    signal: AbortSignal,
    progress: (status: OpenCodeConnectionStatus) => void,
  ) => Promise<T>,
  operationId?: string,
  callerSignal?: AbortSignal,
): Promise<T> {
  assertOwnerContents(owner);
  // A Stop before this call started is never replayed to a listener.
  callerSignal?.throwIfAborted();
  if (Array.from(operations).some((operation) => operation.mutation))
    throw new Error('OpenCode setup is already running.');
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  callerSignal?.addEventListener('abort', stop, { once: true });
  owner.once('destroyed', stop);
  owner.once('render-process-gone', stop);
  owner.once('did-start-navigation', stop);
  const previous = mutation ? Array.from(operations) : [];
  const done = Promise.resolve().then(async () => {
    for (const operation of previous) operation.controller.abort();
    await Promise.allSettled(previous.map((operation) => operation.done));
    assertOwnerContents(owner);
    controller.signal.throwIfAborted();
    callerSignal?.throwIfAborted();
    return run(
      AbortSignal.any([
        controller.signal,
        ...(callerSignal ? [callerSignal] : []),
        AbortSignal.timeout(mutation ? OPENCODE_CONNECTION_TIMEOUT_MS : 60_000),
      ]),
      (status) => {
        if (!owner.isDestroyed() && !controller.signal.aborted)
          sendToWebContents(
            owner,
            IPC_CHANNELS.opencodeConnectionProgress,
            status,
          );
      },
    );
  });
  const operation = {
    owner: owner.id,
    controller,
    done,
    mutation,
    operationId,
  };
  operations.add(operation);
  try {
    return await done;
  } finally {
    operations.delete(operation);
    callerSignal?.removeEventListener('abort', stop);
    owner.off('destroyed', stop);
    owner.off('render-process-gone', stop);
    owner.off('did-start-navigation', stop);
  }
}

function parseOperationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  validateId(value, 'OpenCode operation id');
  if (value.length > 200) throw new Error('OpenCode operation id is too long.');
  return value;
}

function publish(): void {
  broadcastModelRegistryUpdated();
  void notifyModelCatalogChanged().catch(() => undefined);
}

export async function shutdownOpenCodeConnections(): Promise<void> {
  shuttingDown = true;
  for (const operation of Array.from(operations)) operation.controller.abort();
  const { revokeOpenCodeRuntimes } = await import('../opencode/connection');
  await Promise.allSettled([
    revokeOpenCodeRuntimes(),
    ...Array.from(operations).map((operation) => operation.done),
  ]);
}

async function readStatus(): Promise<OpenCodeConnectionStatus> {
  const before = peekOpenCodeRuntimeAvailability();
  const { opencodeConnectionStatus } = await import('../opencode/connection');
  const status = await opencodeConnectionStatus();
  if (before !== peekOpenCodeRuntimeAvailability()) publish();
  return status;
}

async function listModels(signal: AbortSignal): Promise<OpenCodeModelEntry[]> {
  const { listOpenCodeModels } = await import('../opencode/connection');
  const models = await listOpenCodeModels(signal);
  publish();
  return models;
}

async function connect(
  signal: AbortSignal,
  progress: (status: OpenCodeConnectionStatus) => void,
  options: OpenCodeRevokeOptions = {},
): Promise<OpenCodeConnectionStatus> {
  const { connectOpenCode } = await import('../opencode/connection');
  try {
    // Connect discovers the catalog and publishes it after durable enablement.
    return await connectOpenCode(signal, progress, options);
  } finally {
    publish();
  }
}

async function disconnect(options: OpenCodeRevokeOptions = {}): Promise<void> {
  const { disconnectOpenCode } = await import('../opencode/connection');
  await disconnectOpenCode(options);
  publish();
}

/**
 * Runs a bridge's OpenCode setup with other windows' OpenCode sign-in starts
 * held until it settles, so none starts between its checks and its revoke
 * (CAN-6718). This computer's own window holds nothing.
 */
async function heldForBridge<T>(
  event: IpcMainInvokeEvent,
  run: () => Promise<T>,
): Promise<T> {
  if (resolveRemoteBridgeSender(event.sender) === null) return run();
  const release = holdOpenCodeSignInStarts(event.sender);
  try {
    return await run();
  } finally {
    release();
  }
}

/**
 * The revoke check for a call: a remote bridge's setup checks again right
 * before it revokes, since a sign-in can start while it waits. This
 * computer's own window keeps none.
 */
function revokeOptionsFor(event: IpcMainInvokeEvent): OpenCodeRevokeOptions {
  return resolveRemoteBridgeSender(event.sender) === null
    ? {}
    : { beforeRevoke: () => assertSignInsUntouched(event) };
}

async function cancelOwned(
  owner: OpenCodeOwner,
  operationId: string | undefined,
): Promise<void> {
  const pending = Array.from(operations).filter(
    (operation) =>
      operation.owner === owner.id &&
      (operationId === undefined || operation.operationId === operationId),
  );
  for (const operation of pending) operation.controller.abort();
  await Promise.allSettled(pending.map((operation) => operation.done));
}

/**
 * The Settings OpenCode operations, owned by the given window as its own IPC
 * calls are (CAN-6008). An abort of `signal` cancels this call's operation.
 */
export async function runOpenCodeConnectionForWindow(
  window: BrowserWindow,
  operation: 'status' | 'models' | 'connect' | 'cancel' | 'disconnect',
  signal?: AbortSignal,
): Promise<unknown> {
  const owner = window.webContents;
  assertOwnerContents(owner);
  switch (operation) {
    case 'status':
      return readStatus();
    case 'models':
      return ownedBy(owner, false, listModels, undefined, signal);
    case 'connect':
      return ownedBy(
        owner,
        true,
        (setupSignal, progress) => connect(setupSignal, progress),
        undefined,
        signal,
      );
    case 'cancel':
      return cancelOwned(owner, undefined);
    case 'disconnect':
      return ownedBy(owner, true, () => disconnect(), undefined, signal);
  }
}

export function registerOpenCodeConnectionHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.opencodeConnectionStatus, (event) => {
    assertOwner(event);
    return readStatus();
  });
  registerIpcHandler(IPC_CHANNELS.opencodeConnectionModels, (event) =>
    owned(event, false, listModels),
  );
  registerIpcHandler(
    IPC_CHANNELS.opencodeConnectionConnect,
    (event, operationId?: unknown) => {
      const id = parseOperationId(operationId);
      assertSignInsUntouched(event);
      const options = revokeOptionsFor(event);
      return heldForBridge(event, () =>
        owned(
          event,
          true,
          (signal, progress) => connect(signal, progress, options),
          id,
        ),
      );
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.opencodeConnectionCancel,
    async (event, operationId?: unknown) => {
      assertOwner(event);
      await cancelOwned(event.sender, parseOperationId(operationId));
    },
  );
  registerIpcHandler(IPC_CHANNELS.opencodeConnectionDisconnect, (event) => {
    assertSignInsUntouched(event);
    const options = revokeOptionsFor(event);
    return heldForBridge(event, () =>
      owned(event, true, () => disconnect(options)),
    );
  });
}
