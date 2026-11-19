import { restoreIpcAppError } from './ipc-app-errors';
import {
  ipcRenderer as electronIpcRenderer,
  type IpcRenderer,
  type IpcRendererEvent,
} from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  getRemoteChannelDisposition,
  type RemoteChannelDisposition,
} from '@canopy/desktop-shared/remote-control/channel-dispositions';
import {
  readRemoteWindowContext,
  type RemoteWindowContext,
} from '@canopy/desktop-shared/remote-control/window-context';

export type { RemoteWindowContext };

/**
 * The preload's IPC entry point. Every preload API imports `ipcRenderer` from
 * here instead of from Electron.
 *
 * In a normal window it forwards straight to Electron. In a window that
 * shows another computer (device-to-device remote control), it routes each
 * channel by its remote disposition: `local` channels stay on this computer,
 * everything else goes through this computer's main process to the
 * controlled one, and pushes from the controlled computer arrive on one
 * multiplexed channel and are dispatched to the matching listeners.
 */
type Listener = Parameters<IpcRenderer['on']>[1];

/**
 * The part of Electron's `IpcRenderer` the router forwards to, typed without
 * `any` so forwarded values stay `unknown` inside the router.
 */
export interface IpcRendererTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  sendSync(channel: string, ...args: unknown[]): unknown;
  on(channel: string, listener: Listener): unknown;
  once(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
  removeAllListeners(channel: string): unknown;
}

export interface PreloadIpcRenderer {
  invoke: IpcRenderer['invoke'];
  send: IpcRenderer['send'];
  sendSync: IpcRenderer['sendSync'];
  on(channel: string, listener: Listener): void;
  once(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
  removeAllListeners(channel: string): void;
}

function createLocalIpcRenderer(ipc: IpcRendererTransport): PreloadIpcRenderer {
  return {
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
      ipc.invoke(channel, ...args).catch(restoreIpcAppError),
    send: (channel: string, ...args: unknown[]): void => {
      ipc.send(channel, ...args);
    },
    sendSync: (channel: string, ...args: unknown[]): unknown =>
      ipc.sendSync(channel, ...args),
    on: (channel: string, listener: Listener): void => {
      ipc.on(channel, listener);
    },
    once: (channel: string, listener: Listener): void => {
      ipc.once(channel, listener);
    },
    removeListener: (channel: string, listener: Listener): void => {
      ipc.removeListener(channel, listener);
    },
    removeAllListeners: (channel: string): void => {
      ipc.removeAllListeners(channel);
    },
  };
}

/** Preload harness hooks must be eliminated from normal builds. */
const PRELOAD_REMOTE_DISPOSITIONS: Readonly<
  Record<string, RemoteChannelDisposition>
> = {
  ...(__CANOPY_E2E__ && {
    'canopy:e2e:first-projects-load': 'local',
    'canopy:e2e:first-projects-load-stop': 'local',
    'canopy:e2e:liveness-ping': 'local',
  }),
};

function isLocal(channel: string): boolean {
  return (
    (PRELOAD_REMOTE_DISPOSITIONS[channel] ??
      getRemoteChannelDisposition(channel)) === 'local'
  );
}

/** Routes IPC for a window that shows another computer. */
export function createRemoteIpcRenderer(
  ipc: IpcRendererTransport,
): PreloadIpcRenderer {
  const remoteListeners = new Map<string, Set<Listener>>();
  const onceWrappers = new Map<Listener, Listener>();

  ipc.on(
    IPC_CHANNELS.remoteControlPush,
    (event: IpcRendererEvent, channel: unknown, args: unknown) => {
      if (typeof channel !== 'string' || !Array.isArray(args)) return;
      const listeners = remoteListeners.get(channel);
      if (!listeners) return;
      const payload: unknown[] = args;
      for (const listener of Array.from(listeners)) listener(event, ...payload);
    },
  );

  const addRemote = (channel: string, listener: Listener): void => {
    let listeners = remoteListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      remoteListeners.set(channel, listeners);
    }
    listeners.add(listener);
  };

  const removeRemote = (channel: string, listener: Listener): void => {
    const listeners = remoteListeners.get(channel);
    if (!listeners) return;
    listeners.delete(onceWrappers.get(listener) ?? listener);
    listeners.delete(listener);
    onceWrappers.delete(listener);
    if (listeners.size === 0) remoteListeners.delete(channel);
  };

  return {
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
      (isLocal(channel)
        ? ipc.invoke(channel, ...args)
        : ipc.invoke(IPC_CHANNELS.remoteControlInvoke, channel, args)
      ).catch(restoreIpcAppError),
    send: (channel: string, ...args: unknown[]): void => {
      if (isLocal(channel)) {
        ipc.send(channel, ...args);
      } else {
        ipc.send(IPC_CHANNELS.remoteControlSend, channel, args);
      }
    },
    // Synchronous IPC cannot cross machines; the only caller seeds a cache
    // that the asynchronous registry load replaces.
    sendSync: (channel: string, ...args: unknown[]): unknown =>
      ipc.sendSync(channel, ...args),
    on: (channel: string, listener: Listener): void => {
      if (isLocal(channel)) {
        ipc.on(channel, listener);
      } else {
        addRemote(channel, listener);
      }
    },
    once: (channel: string, listener: Listener): void => {
      if (isLocal(channel)) {
        ipc.once(channel, listener);
        return;
      }
      const wrapper: Listener = (
        event: IpcRendererEvent,
        ...args: unknown[]
      ): void => {
        removeRemote(channel, listener);
        listener(event, ...args);
      };
      onceWrappers.set(listener, wrapper);
      addRemote(channel, wrapper);
    },
    removeListener: (channel: string, listener: Listener): void => {
      if (isLocal(channel)) {
        ipc.removeListener(channel, listener);
      } else {
        removeRemote(channel, listener);
      }
    },
    removeAllListeners: (channel: string): void => {
      if (isLocal(channel)) {
        ipc.removeAllListeners(channel);
      } else {
        remoteListeners.delete(channel);
      }
    },
  };
}

export const remoteWindowContext = readRemoteWindowContext(process.argv);

export const ipcRenderer: PreloadIpcRenderer = remoteWindowContext
  ? createRemoteIpcRenderer(electronIpcRenderer)
  : createLocalIpcRenderer(electronIpcRenderer);
