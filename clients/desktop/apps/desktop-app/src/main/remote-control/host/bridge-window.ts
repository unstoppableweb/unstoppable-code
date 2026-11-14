import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { CoworkFolderMissingSchema } from '@canopy/protocol/canopy-core';
import {
  REMOTE_BRIDGE_CHANNELS,
  type RemoteBridgeInvokeMessage,
  type RemoteBridgePostMessage,
} from '@canopy/desktop-shared/remote-control/bridge-channels';
import type { ChatInterestDeclaration } from '@canopy/desktop-shared/types';
import { recordedChatInterest } from '../../ipc/chat-interest-registry';
import {
  interceptWebContentsSends,
  sendToWebContents,
} from '../../lib/web-contents-send';

/**
 * A hidden window that replays one controller's IPC calls on this computer.
 *
 * Calls go through Electron IPC from a real renderer, so every handler sees
 * a real sender exactly as it would for the app window, with no change to
 * the handlers. Messages main sends this window (broadcasts and replies to
 * its calls) are taken before encoding and before they reach the page, and
 * handed to the remote session instead.
 */
export interface HostBridge {
  /** The chat interest the controller's window declared through this bridge. */
  getChatInterest(): ChatInterestDeclaration | undefined;
  /**
   * The hidden window. Main reaches the controller's window behind it by
   * sending to it, like any renderer window; null only in tests.
   */
  readonly window: BrowserWindow | null;
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  post(channel: string, args: unknown[]): void;
  onPush(
    listener: (channel: string, args: ReadonlyArray<unknown>) => void,
  ): () => void;
  /** Called once when the bridge goes away, for example if it crashes. */
  onClosed(listener: () => void): () => void;
  destroy(): void;
}

interface BridgeRecord {
  controllerDeviceId: string;
  exactWorktreeBaseBranch: boolean;
  onReady: () => void;
  onResult: (message: unknown) => void;
}

const bridgesByWebContentsId = new Map<number, BridgeRecord>();
let listenersInstalled = false;

function installIpcListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  ipcMain.on(REMOTE_BRIDGE_CHANNELS.ready, (event: IpcMainEvent) => {
    bridgesByWebContentsId.get(event.sender.id)?.onReady();
  });
  ipcMain.on(
    REMOTE_BRIDGE_CHANNELS.result,
    (event: IpcMainEvent, message: unknown) => {
      bridgesByWebContentsId.get(event.sender.id)?.onResult(message);
    },
  );
}

const bridgeWindows = new Set<BrowserWindow>();

/**
 * Open bridge windows. Pushes main addresses to each subscribing window
 * separately (`chat:state-changed`) include them, so each controller receives
 * the scopes it declared.
 */
export function remoteBridgeWindows(): BrowserWindow[] {
  return Array.from(bridgeWindows);
}

/** Controller device behind a bridge sender, for IPC caller attribution. */
export function resolveRemoteBridgeSender(sender: {
  id: number;
}): string | null {
  return bridgesByWebContentsId.get(sender.id)?.controllerDeviceId ?? null;
}

/** Local windows and negotiated desktop bridges use the exact catalogue. */
export function usesExactWorktreeBaseCatalogue(sender: {
  id: number;
}): boolean {
  return bridgesByWebContentsId.get(sender.id)?.exactWorktreeBaseBranch ?? true;
}

const BRIDGE_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>Remote control bridge</title>',
)}`;
const READY_TIMEOUT_MS = 15_000;
const BRIDGE_CHANNEL_PREFIX = 'remote-bridge:';

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function createBridgeWindow(options: {
  controllerDeviceId: string;
  exactWorktreeBaseBranch: boolean;
  preloadPath: string;
}): Promise<HostBridge> {
  installIpcListeners();
  const window = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: options.preloadPath,
      sandbox: false,
      contextIsolation: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  bridgeWindows.add(window);
  const webContents = window.webContents;
  const webContentsId = webContents.id;
  const pushListeners = new Set<
    (channel: string, args: ReadonlyArray<unknown>) => void
  >();
  const pending = new Map<number, PendingInvoke>();
  let nextId = 1;
  let destroyed = false;

  const stopIntercepting = interceptWebContentsSends(
    webContents,
    (channel, args): boolean => {
      if (channel.startsWith(BRIDGE_CHANNEL_PREFIX)) return false;
      for (const listener of Array.from(pushListeners)) {
        listener(channel, args);
      }
      return true;
    },
  );

  const failAll = (message: string): void => {
    for (const entry of Array.from(pending.values()))
      entry.reject(new Error(message));
    pending.clear();
  };

  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  bridgesByWebContentsId.set(webContentsId, {
    controllerDeviceId: options.controllerDeviceId,
    exactWorktreeBaseBranch: options.exactWorktreeBaseBranch,
    onReady: () => markReady(),
    onResult: (message) => {
      if (!isRecord(message) || typeof message.id !== 'number') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok === true) {
        entry.resolve(message.value);
      } else {
        const missing = CoworkFolderMissingSchema.safeParse(
          message.coworkFolderMissing,
        );
        const error = new Error(
          typeof message.message === 'string'
            ? message.message
            : 'Remote call failed.',
        );
        entry.reject(
          missing.success ? Object.assign(error, missing.data) : error,
        );
      }
    },
  });

  const closedListeners = new Set<() => void>();
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    bridgesByWebContentsId.delete(webContentsId);
    bridgeWindows.delete(window);
    stopIntercepting();
    pushListeners.clear();
    failAll('The remote session ended.');
    if (!window.isDestroyed()) window.destroy();
    for (const listener of Array.from(closedListeners)) listener();
    closedListeners.clear();
  };

  window.on('closed', destroy);
  webContents.on('render-process-gone', destroy);

  try {
    await Promise.race([
      Promise.all([window.loadURL(BRIDGE_PAGE), ready]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('Remote control bridge did not start.')),
          READY_TIMEOUT_MS,
        ).unref?.();
      }),
    ]);
  } catch (error) {
    destroy();
    throw error;
  }

  return {
    getChatInterest: () =>
      destroyed ? undefined : recordedChatInterest(webContents),
    window,
    invoke(channel: string, args: unknown[]): Promise<unknown> {
      if (destroyed) {
        return Promise.reject(new Error('The remote session ended.'));
      }
      const id = nextId;
      nextId += 1;
      const message: RemoteBridgeInvokeMessage = { id, channel, args };
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          sendToWebContents(
            webContents,
            REMOTE_BRIDGE_CHANNELS.invoke,
            message,
          );
        } catch (error) {
          pending.delete(id);
          reject(
            error instanceof Error ? error : new Error('Remote call failed.'),
          );
        }
      });
    },
    post(channel: string, args: unknown[]): void {
      if (destroyed) return;
      const message: RemoteBridgePostMessage = { channel, args };
      try {
        sendToWebContents(webContents, REMOTE_BRIDGE_CHANNELS.post, message);
      } catch {
        // A fire-and-forget message to a closing bridge is dropped.
      }
    },
    onPush(listener) {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },
    onClosed(listener) {
      if (destroyed) {
        listener();
        return () => undefined;
      }
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    destroy,
  };
}
