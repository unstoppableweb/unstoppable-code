import type { IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  REMOTE_UPLOAD_MAX_BYTES,
  REMOTE_UPLOAD_TOO_LARGE_MESSAGE,
  type RemoteControlApi,
  type RemoteControlContext,
  type RemoteControlPairingEvent,
  type RemoteControlState,
  type RemotePathPickerRequest,
} from '@canopy/desktop-shared/types';
import type { PreloadIpcRenderer, RemoteWindowContext } from '../ipc-router';

export function remoteControlContextFor(
  context: RemoteWindowContext | null,
): RemoteControlContext {
  return context
    ? {
        mode: 'remote',
        deviceId: context.deviceId,
        name: context.name,
        platform: context.platform,
      }
    : { mode: 'local' };
}

export function createRemoteControlApi(
  ipc: PreloadIpcRenderer,
  context: RemoteWindowContext | null,
): RemoteControlApi {
  const windowContext = remoteControlContextFor(context);
  return {
    getContext: () => windowContext,
    getState: (request) =>
      ipc.invoke(IPC_CHANNELS.remoteControlGetState, request ?? {}),
    onStateChanged: (listener) => {
      const handler = (
        _event: IpcRendererEvent,
        state: RemoteControlState,
      ): void => listener(state);
      ipc.on(IPC_CHANNELS.remoteControlStateChanged, handler);
      return () => {
        ipc.removeListener(IPC_CHANNELS.remoteControlStateChanged, handler);
      };
    },
    openMachine: (deviceId) =>
      ipc.invoke(IPC_CHANNELS.remoteControlOpenMachine, deviceId),
    setAllowIncoming: (allow) =>
      ipc.invoke(IPC_CHANNELS.remoteControlSetAllowIncoming, allow),
    setAllowRemoteUpdates: (allow) =>
      ipc.invoke(IPC_CHANNELS.remoteControlSetAllowRemoteUpdates, allow),
    openPairingWindow: () =>
      ipc.invoke(IPC_CHANNELS.remoteControlOpenPairingWindow),
    closePairingWindow: () =>
      ipc.invoke(IPC_CHANNELS.remoteControlClosePairingWindow),
    onPairingEvent: (listener) => {
      const handler = (
        _event: IpcRendererEvent,
        pairingEvent: RemoteControlPairingEvent,
      ): void => listener(pairingEvent);
      ipc.on(IPC_CHANNELS.remoteControlPairingEvent, handler);
      return () => {
        ipc.removeListener(IPC_CHANNELS.remoteControlPairingEvent, handler);
      };
    },
    startPairing: (deviceId) =>
      ipc.invoke(IPC_CHANNELS.remoteControlStartPairing, deviceId),
    cancelPairing: () => ipc.invoke(IPC_CHANNELS.remoteControlCancelPairing),
    respondToPairing: (request) =>
      ipc.invoke(IPC_CHANNELS.remoteControlRespondToPairing, request),
    forgetDevice: (request) =>
      ipc.invoke(IPC_CHANNELS.remoteControlForgetDevice, request),
    disconnectController: (deviceId) =>
      ipc.invoke(IPC_CHANNELS.remoteControlDisconnectController, deviceId),
    onPathPickerRequest: (listener) => {
      const handler = (
        _event: IpcRendererEvent,
        request: RemotePathPickerRequest,
      ): void => listener(request);
      ipc.on(IPC_CHANNELS.remoteControlPathPickerRequest, handler);
      return () => {
        ipc.removeListener(
          IPC_CHANNELS.remoteControlPathPickerRequest,
          handler,
        );
      };
    },
    resolvePathPicker: (response) =>
      ipc.invoke(IPC_CHANNELS.remoteControlPathPickerResolve, response),
    listDirectory: (request) =>
      ipc.invoke(IPC_CHANNELS.remoteControlListDirectory, request),
  };
}

function safeFileName(name: string): string {
  const trimmed = name.replace(/[\\/]/g, '_').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : 'attachment';
}

/**
 * Files dropped in a remote window live on this computer, so the computer
 * being controlled cannot open them by path. Each is uploaded first, one at a
 * time so a large selection holds one file in memory, and the paths returned
 * are where the uploads landed there.
 */
export async function uploadFilesToRemote(
  ipc: Pick<PreloadIpcRenderer, 'invoke'>,
  files: ReadonlyArray<File>,
): Promise<string[]> {
  if (files.some((file) => file.size > REMOTE_UPLOAD_MAX_BYTES)) {
    throw new Error(REMOTE_UPLOAD_TOO_LARGE_MESSAGE);
  }
  const paths: string[] = [];
  for (const file of files) {
    const path: unknown = await ipc.invoke(IPC_CHANNELS.remoteControlUpload, {
      fileName: safeFileName(file.name),
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    if (typeof path !== 'string') {
      throw new Error('The file could not be sent.');
    }
    paths.push(path);
  }
  return paths;
}
