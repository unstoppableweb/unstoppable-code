import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { canopyPermissionDeniedError } from '@canopy/core-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

export interface DesktopIpcFrame {
  url: string;
  detached: boolean;
  isDestroyed(): boolean;
}

export interface DesktopIpcSender {
  id: number;
  mainFrame: DesktopIpcFrame;
  getURL(): string;
  isDestroyed(): boolean;
}

export interface DesktopIpcEvent {
  sender: DesktopIpcSender;
  senderFrame: DesktopIpcFrame | null;
}

/** Validate the sending document against Electron's current, live main frame. */
export function isCurrentDesktopMainFrame(
  sender: DesktopIpcSender,
  frame: DesktopIpcFrame | null,
): frame is DesktopIpcFrame {
  // Electron 42 can keep `detached` set on a WebFrameMain wrapper after a
  // crashed renderer is replaced, even though isDestroyed() is now false.
  // Re-read mainFrame on each invocation: an old document or child frame must
  // never gain access just because it shares the current document's URL.
  return (
    !sender.isDestroyed() &&
    frame !== null &&
    frame === sender.mainFrame &&
    !frame.isDestroyed()
  );
}

export interface DesktopAppWindow {
  isDestroyed(): boolean;
  webContents: DesktopIpcSender;
}

export interface DesktopIpcCallerOptions {
  getAppWindows: () => ReadonlyArray<DesktopAppWindow | null>;
  /** The packaged renderer's pages, one per app window. */
  packagedRendererUrls: readonly string[];
  devServerUrl?: string;
  /**
   * Device-to-device remote control: the hidden bridge window that replays a
   * paired controller's calls. Returns the controller's device ID when the
   * sender is a live bridge, null otherwise.
   */
  resolveRemoteBridgeSender?: (sender: DesktopIpcSender) => string | null;
}

function permissionDenied(): never {
  throw canopyPermissionDeniedError('Untrusted desktop IPC sender.');
}

function isExpectedRendererUrl(
  actualUrl: string,
  options: DesktopIpcCallerOptions,
): boolean {
  try {
    const actual = new URL(actualUrl);
    if (options.devServerUrl) {
      const devServer = new URL(options.devServerUrl);
      if (actual.origin === devServer.origin) return true;
    }
    return options.packagedRendererUrls.some((packagedRendererUrl) => {
      const packaged = new URL(packagedRendererUrl);
      return (
        actual.protocol === packaged.protocol &&
        actual.host === packaged.host &&
        actual.pathname === packaged.pathname
      );
    });
  } catch {
    return false;
  }
}

function isTrackedSender(
  sender: DesktopIpcSender,
  options: DesktopIpcCallerOptions,
): boolean {
  return options
    .getAppWindows()
    .some(
      (window) =>
        window !== null &&
        !window.isDestroyed() &&
        window.webContents === sender,
    );
}

const DESKTOP_GRANTS: CanopyCallerDescriptor['grants'] = [
  'worker.filesystem.read',
  'core.workspace.read',
  'core.chat.read',
  'core.chat.write',
  'core.worktree.read',
  'core.chat.write',
];

/** The principal prefix every remote-control controller acts under. */
export const REMOTE_DEVICE_PRINCIPAL_PREFIX = 'remote-device:';
/**
 * The client instance prefix minted only for a remote-control bridge call.
 * Nothing else may produce it: archive recovery review relies on it to tell
 * the bridge apart from the remote core session and hosted chat callers that
 * share the `remote-device:` principal.
 */
export const REMOTE_BRIDGE_CLIENT_INSTANCE_PREFIX = 'remote-bridge:';

function deriveRemoteBridgeCaller(
  event: DesktopIpcEvent,
  options: DesktopIpcCallerOptions,
): CanopyCallerDescriptor | null {
  const sender = event.sender;
  const frame = event.senderFrame;
  const controllerDeviceId = options.resolveRemoteBridgeSender?.(sender);
  if (!controllerDeviceId || !isCurrentDesktopMainFrame(sender, frame)) {
    return null;
  }
  // A paired controller acts with the desktop interface's grants through the
  // bridge, under its own principal so its actions stay attributable.
  return {
    principalId: `${REMOTE_DEVICE_PRINCIPAL_PREFIX}${controllerDeviceId}`,
    clientInstanceId: `${REMOTE_BRIDGE_CLIENT_INSTANCE_PREFIX}${sender.id}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: [...DESKTOP_GRANTS],
  };
}

export function deriveDesktopIpcCaller(
  event: DesktopIpcEvent,
  options: DesktopIpcCallerOptions,
): CanopyCallerDescriptor {
  const bridgeCaller = deriveRemoteBridgeCaller(event, options);
  if (bridgeCaller) return bridgeCaller;
  const sender = event.sender;
  const frame = event.senderFrame;
  if (
    !isCurrentDesktopMainFrame(sender, frame) ||
    !isTrackedSender(sender, options) ||
    frame.url !== sender.getURL() ||
    !isExpectedRendererUrl(frame.url, options)
  ) {
    return permissionDenied();
  }

  return {
    principalId: 'local-desktop-user',
    clientInstanceId: `electron-web-contents:${sender.id}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: [...DESKTOP_GRANTS],
  };
}
