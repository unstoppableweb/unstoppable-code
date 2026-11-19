import {
  decodeIpcAppError,
  formatIpcLegacyError,
  safeErrorProperty,
} from '@canopy/desktop-shared/ipc/app-error-rejection';
import { CoworkFolderMissingSchema } from '@canopy/protocol/canopy-core';
import { readRemoteOperationFailure } from '@canopy/protocol/remote-control';
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  REMOTE_BRIDGE_CHANNELS,
  type RemoteBridgeResultMessage,
} from '@canopy/desktop-shared/remote-control/bridge-channels';

/**
 * Preload for the hidden bridge window on a computer being controlled from
 * another one. Main hands it each tunneled call; it makes the call through
 * Electron IPC exactly as the app renderer would, so the real handler runs
 * with a real sender, and reports the outcome back. It exposes nothing to
 * the page.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Electron prefixes handler errors with the IPC plumbing; keep the handler's
// own message so the controlling renderer sees what a local one would.
const INVOKE_ERROR_PREFIX =
  /^Error invoking remote method '[^']*': (?:Error: )?/;

function errorMessage(error: unknown): string {
  const raw = safeErrorProperty(error, 'message');
  const decoded = decodeIpcAppError(raw);
  const message = decoded
    ? formatIpcLegacyError(decoded.channel, decoded.legacy)
    : typeof raw === 'string'
      ? raw
      : 'Remote call failed.';
  return message.replace(INVOKE_ERROR_PREFIX, '');
}

function reply(message: RemoteBridgeResultMessage): void {
  ipcRenderer.send(REMOTE_BRIDGE_CHANNELS.result, message);
}

ipcRenderer.on(
  REMOTE_BRIDGE_CHANNELS.invoke,
  (_event: IpcRendererEvent, message: unknown) => {
    if (
      !isRecord(message) ||
      typeof message.id !== 'number' ||
      typeof message.channel !== 'string' ||
      !Array.isArray(message.args)
    ) {
      return;
    }
    const { id, channel } = message;
    const args: unknown[] = message.args;
    ipcRenderer.invoke(channel, ...args).then(
      (value: unknown) => reply({ id, ok: true, value }),
      (error: unknown) => {
        const decoded = decodeIpcAppError(safeErrorProperty(error, 'message'));
        const operationFailure = readRemoteOperationFailure(decoded);
        const missing = CoworkFolderMissingSchema.safeParse(
          decoded?.coworkFolderMissing,
        );
        reply({
          id,
          ok: false,
          message: errorMessage(error),
          ...(missing.success ? { coworkFolderMissing: missing.data } : {}),
          ...(operationFailure ? { operationFailure } : {}),
        });
      },
    );
  },
);

ipcRenderer.on(
  REMOTE_BRIDGE_CHANNELS.post,
  (_event: IpcRendererEvent, message: unknown) => {
    if (
      !isRecord(message) ||
      typeof message.channel !== 'string' ||
      !Array.isArray(message.args)
    ) {
      return;
    }
    const args: unknown[] = message.args;
    ipcRenderer.send(message.channel, ...args);
  },
);

ipcRenderer.send(REMOTE_BRIDGE_CHANNELS.ready);
