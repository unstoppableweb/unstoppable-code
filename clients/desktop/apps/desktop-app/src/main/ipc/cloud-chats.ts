import { join } from 'node:path';
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  IPC_CHANNELS,
  type CloudChatFileDownloadResult,
  type CloudChatAttachmentUploadResult,
  type CloudChatsReconnectResult,
} from '@canopy/desktop-shared/types';
import { getFeatureFlagService } from '../feature-flags';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { resolveCanopyCloudCredentialContext } from '../canopy-cloud/client';
import type {
  WebCoreBindingOptions,
  WebCoreCredentials,
} from '../canopy-cloud/web-core-connection';
import { createWebCoreReconnect } from '../canopy-cloud/web-core-reconnect';
import {
  createCloudChatAttachmentUpload,
  createWebCoreAttachmentSender,
} from '../canopy-cloud/cloud-chat-attachments';
import {
  createCloudChatFileDownload,
  createWebCoreFileReader,
} from '../canopy-cloud/cloud-chat-file-download';
import type {
  RendererRelayEvent,
  RendererRelaySurfaceResolution,
} from '../canopy-runtime/renderer-relay/relay';
import { registerIpcHandler } from './register';

export function cloudChatsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key,
  );
}

/** The signed-in cloud account's external id, or null. */
export async function signedInAccountId(): Promise<string | null> {
  const read = await readCanopyCloudAccountWithStatus();
  return (read.status === 'ok' ? read.entry?.account?.id : null) ?? null;
}

/**
 * The signed-in account's cloud origin, desktop key and external id, or a
 * rejection when signed out or the account is not yet known.
 */
async function readWebCoreCredentials(): Promise<WebCoreCredentials> {
  const [context, accountId] = await Promise.all([
    resolveCanopyCloudCredentialContext(),
    signedInAccountId(),
  ]);
  if (accountId === null) throw new Error('No signed-in cloud account.');
  return { baseUrl: context.baseUrl, apiKey: context.apiKey, accountId };
}

/**
 * Main's web core binding: `canopyDesktopCloudChats`, and the signed-in
 * account's desktop key (CAN-5989).
 */
export function desktopWebCoreBindingOptions(): WebCoreBindingOptions {
  return {
    isEnabled: cloudChatsEnabled,
    readCredentials: readWebCoreCredentials,
    onAccountChange: (listener) =>
      subscribeCanopyCloudAccountChanges((entry) =>
        listener(
          entry === null
            ? null
            : { apiKey: entry.apiKey, accountId: entry.account?.id ?? '' },
        ),
      ),
  };
}

/**
 * The cloud chats Reconnect action (CAN-4185); its throttle lives in main.
 * Only the app's own main window may ask, by the same trusted-surface check
 * that keeps the web-core relay main-window only.
 */
export function registerCloudChatsHandlers(
  resolveSurface: (event: RendererRelayEvent) => RendererRelaySurfaceResolution,
): void {
  const reconnect = createWebCoreReconnect({
    isEnabled: cloudChatsEnabled,
    currentAccountId: signedInAccountId,
    readCredentials: readWebCoreCredentials,
  });
  const requireMainWindow = (event: RendererRelayEvent): void => {
    let trusted = false;
    try {
      trusted = resolveSurface(event).surface === 'main';
    } catch {
      // An untrusted sender is refused below.
    }
    if (!trusted) throw new Error('Untrusted cloud chats sender.');
  };
  registerIpcHandler<[], CloudChatsReconnectResult>(
    IPC_CHANNELS.cloudChatsReconnect,
    (event) => {
      requireMainWindow(event);
      return reconnect();
    },
  );
  // The renderer sends the bytes of a file the user picked or dropped; main
  // uploads them on its own web core connection (CAN-5972, CAN-5988).
  const binding = desktopWebCoreBindingOptions();
  const upload = createCloudChatAttachmentUpload({
    isEnabled: binding.isEnabled,
    send: createWebCoreAttachmentSender(binding, app.getVersion()),
  });
  registerIpcHandler<[unknown, unknown], CloudChatAttachmentUploadResult>(
    IPC_CHANNELS.cloudChatsUploadAttachment,
    (event, target, file) => {
      requireMainWindow(event);
      return upload(target, file);
    },
  );
  // The renderer names a cloud chat and one of its files; main asks where
  // to save it and writes only there (CAN-6587).
  const reader = createWebCoreFileReader(binding, app.getVersion());
  registerIpcHandler<[unknown, unknown], CloudChatFileDownloadResult>(
    IPC_CHANNELS.cloudChatsDownloadFile,
    (event, target, file) => {
      requireMainWindow(event);
      return createCloudChatFileDownload({
        isEnabled: binding.isEnabled,
        choosePath: (filename) => chooseSavePath(event, filename),
        withReader: reader,
      })(target, file);
    },
  );
}

/** The save dialog over the window that asked, in the user's Downloads folder. */
async function chooseSavePath(
  event: IpcMainInvokeEvent,
  filename: string,
): Promise<string | null> {
  const options = { defaultPath: join(app.getPath('downloads'), filename) };
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  return result.canceled || result.filePath === undefined
    ? null
    : result.filePath;
}
