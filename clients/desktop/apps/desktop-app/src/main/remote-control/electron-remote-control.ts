import {
  recordRemoteControlTelemetry,
  startRemotePairingTelemetry,
} from '../lib/desktop-telemetry';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  ipcMain,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  powerMonitor,
  shell,
  type WebContents,
} from 'electron';
import { is } from '@electron-toolkit/utils';
import { BRAND } from '@canopy/brand/current';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { getWindowTitleBarOptions } from '../lib/window-title-bar';
import {
  DeviceRelayTokenResponseSchema,
  isDeviceId,
  type DevicePlatform,
} from '@canopy/protocol/device-relay';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import { macWindowButtonPosition } from '@canopy/desktop-shared/lib/titlebar-geometry';
import {
  getAppAdvisorRendererToolRequestOriginChatId,
  IPC_CHANNELS,
  REMOTE_UPLOAD_MAX_BYTES,
  REMOTE_UPLOAD_TOO_LARGE_MESSAGE,
  type AppAdvisorWindowCommand,
  type AppAdvisorWindowOpenRequest,
  type RemoteControlForgetDeviceRequest,
  type RemoteControlGetStateRequest,
  type RemoteControlInstallIdResult,
  type RemoteControlPairingEvent,
  type RemoteControlRespondToPairingRequest,
  type RemoteControlState,
  type RemotePathPickerResponse,
} from '@canopy/desktop-shared/types';
import { setAccountProxyRemoteSignInProvider } from '../account-proxy/remote-sign-in';
import { getDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { createRemoteCoreAccess } from './host/remote-core-access';
import {
  notifyRemoteUpdatePolicyChanged,
  setRemoteUpdatePolicy,
} from './remote-update-policy';
import { setInterfaceToolAudienceResolver } from '../agents/interface-tool-binding';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import {
  readDurablePortalInstallId,
  readPortalOptInForMigration,
} from '../portal/portal-state-store';
import {
  redeliverPendingAppAdvisorAskUserRequests,
  setRemoteAppAdvisorWindowHostResolver,
  setRendererToolSurfaceRouter,
} from '../ipc/app-advisor';
import { registerIpcHandler } from '../ipc/register';
import {
  peekCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { setRemoteOpenDialogProvider } from '../lib/dialog-window';
import {
  logMainProcessError,
  logMainProcessInfo,
} from '../lib/main-process-logging';
import { authorizeExternalFileRead } from '../lib/external-file-open';
import { openExternalGuarded } from '../lib/open-external';
import { getDataDir } from '../lib/paths';
import { getWakeLockService } from '../power/wake-lock-service';
import {
  APP_ADVISOR_RENDERER_PAGE,
  APP_ADVISOR_RENDERER_SEARCH,
  appAdvisorDevServerUrl,
  MAIN_WINDOW_RENDERER_PAGE,
} from '../lib/renderer-pages';
import { shouldShowUiAutomationWindow } from '../lib/ui-automation-window';
import { readPreferencesFile } from '../lib/preferences-store';
import { getSecretStoragePolicy } from '../lib/secure-storage-policy';
import {
  applySavedUiZoom,
  registerUiZoomWindowButtons,
  uiScaleToZoomFactor,
  uiZoomWebPreferences,
} from '../lib/ui-zoom';
import { validateId } from '../lib/validation';
import { getMainWindowMaterialOptions } from '../lib/window-material';
import { sendToAllWindows, sendToWindowDetailed } from '../lib/window-send';
import { getObservabilityService } from '../observability';
import {
  describeRemoteControlAvailability,
  isRemoteControlAvailable,
  remoteControlFeatureState,
  onRemoteControlAvailabilityChanged,
} from './availability';
import type { RemoteControlDiagnostic } from './diagnostics';
import {
  RemoteAccountProxySignIns,
  accountProxySignInCallbackPorts,
} from './client/account-proxy-sign-in';
import { markAsDownloaded } from './client/downloaded-files';
import { linkUrlForLocalOpen } from './client/local-links';
import {
  RemoteMachineWindows,
  type RemoteWindowHost,
} from './client/remote-windows';
import {
  createBridgeWindow,
  resolveRemoteBridgeSender,
  type HostBridge,
} from './host/bridge-window';
import { RemoteAppAdvisorSurface } from './host/app-advisor-surface';
import { chatDriver } from './host/chat-drivers';
import { accountProxyRemoteSignInTarget } from './host/account-proxy-sign-in-target';
import { createHostFileReader } from './host/file-reads';
import { listRemoteDirectory } from './host/list-directory';
import { createMainWindowPushSource } from './host/main-window-pushes';
import { RemoteUploadStore } from './host/uploads';
import { currentRemoteVersion } from './protocol-version';
import { RemoteAccessStore } from './remote-access-store';
import {
  RemoteControlService,
  type RemotePortalPort,
  type RemoteRelay,
  type RemoteRelayFactoryOptions,
} from './remote-control-service';
import {
  REMOTE_FILE_OPEN_MAX_BYTES,
  REMOTE_FILE_OPEN_TOO_LARGE_MESSAGE,
} from './remote-protocol';
import { RelayClient } from './transport/relay-client';

const DEVICE_RELAY_TOKEN_PATH = '/api/v1/device-relay/token';

function devicePlatform(): DevicePlatform {
  return hostPlatformOperatingSystem();
}

function deviceName(): string {
  const name = hostname()
    .replace(/\.local$/i, '')
    .trim();
  return (name.length > 0 ? name : 'Computer').slice(0, 120);
}

function isAllowedRendererNavigation(url: string): boolean {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!is.dev || !devServerUrl) return false;
  try {
    return new URL(url).origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

async function loadRenderer(
  window: BrowserWindow,
  surface: RemoteSurface,
): Promise<void> {
  // Follows later scale changes like the main window: its traffic lights
  // move with the zoom, and the scale saved now wins over the one the window
  // was built with.
  registerUiZoomWindowButtons(window, macWindowButtonPosition);
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (is.dev && devServerUrl) {
    await window.loadURL(
      surface === 'app-advisor'
        ? appAdvisorDevServerUrl(devServerUrl)
        : devServerUrl,
    );
  } else if (surface === 'app-advisor') {
    await window.loadFile(
      join(__dirname, '../renderer', APP_ADVISOR_RENDERER_PAGE),
      { search: APP_ADVISOR_RENDERER_SEARCH },
    );
  } else {
    await window.loadFile(
      join(__dirname, '../renderer', MAIN_WINDOW_RENDERER_PAGE),
    );
  }
  await applySavedUiZoom(
    window,
    async () => (await readPreferencesFile()).uiScale,
  );
}

async function fetchRelayToken(
  deviceId: string,
): Promise<ReturnType<typeof DeviceRelayTokenResponseSchema.parse>> {
  const response = await requestCanopyCloudJson<unknown>(
    DEVICE_RELAY_TOKEN_PATH,
    { method: 'POST', body: JSON.stringify({ deviceId }) },
  );
  return DeviceRelayTokenResponseSchema.parse(response);
}

/**
 * The signed-in account's stable identity: its server ID, or a digest of the
 * credential for entries saved before accounts had one.
 */
function signedInAccount(): string | null {
  return signedInAccountKeys()[0] ?? null;
}

/**
 * Every key the signed-in account is known by, `signedInAccount` first: its
 * server ID when it has one, and the digest of its credential. One
 * credential belongs to one account, so a key that changes between the two
 * forms with the same credential is still the same account.
 */
function signedInAccountKeys(): string[] {
  const account = peekCanopyCloudAccount();
  if (!account || account.apiKey.length === 0 || isGuestAccount(account)) {
    return [];
  }
  const keyDigest = `key:${createHash('sha256').update(account.apiKey).digest('hex')}`;
  const accountId = account.account?.id.trim();
  return accountId ? [`account:${accountId}`, keyDigest] : [keyDigest];
}

/** Keeps a connection diagnostic in this computer's app events only. */
function recordRemoteControlDiagnostic(
  diagnostic: RemoteControlDiagnostic,
): void {
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    ...diagnostic,
  });
}

export interface RemoteControlRuntime {
  service: RemoteControlService;
  resolveRemoteBridgeSender: (sender: { id: number }) => string | null;
  /** Open windows showing a paired computer, oldest first. */
  liveMachineWindows: () => BrowserWindow[];
}

let runtime: RemoteControlRuntime | null = null;

export function getRemoteControlRuntime(): RemoteControlRuntime | null {
  return runtime;
}

/**
 * Starts device-to-device remote control and registers its IPC. Safe to call
 * once after the app is ready; idle (no relay connection) until the user
 * turns it on or pairs a computer.
 */
export function initializeRemoteControl(options: {
  getMainWindow: () => BrowserWindow | null;
  /** Shows the main window, recreating it when it was closed. */
  showMainWindow: () => void;
  iconPath: string;
  /** Whether the app has committed to quitting, past any unsaved-changes prompt. */
  isAppQuitting: () => boolean;
  /** Resolves an App Advisor open request into its window's commands. */
  appAdvisorRequestCommands: (
    request: AppAdvisorWindowOpenRequest | undefined,
    send: (command: AppAdvisorWindowCommand) => void,
  ) => Promise<unknown>;
  /**
   * Portal sessions the single Remote Control opt-in starts and ends,
   * supplied by the composition root that owns Portal.
   */
  portal?: RemotePortalPort;
}): RemoteControlRuntime {
  if (runtime) return runtime;
  const dataDir = getDataDir();
  const store = new RemoteAccessStore({
    settingsPath: join(dataDir, 'remote-control.json'),
    identityPath: join(dataDir, 'remote-control-identity.key'),
    secretStorage: getSecretStoragePolicy(),
  });
  const uploads = new RemoteUploadStore(
    join(dataDir, 'remote-control-uploads'),
  );
  const mainWindowPushes = createMainWindowPushSource(() => {
    // Null while the app window is closed, so its events still reach
    // controllers (see main-window-pushes.ts).
    const mainWindow = options.getMainWindow();
    return mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.webContents
      : null;
  });
  // The scale at startup sizes new windows; loadRenderer applies the current one.
  let uiScale: number | undefined;
  void readPreferencesFile()
    .then((preferences) => {
      uiScale = preferences.uiScale;
    })
    .catch(() => undefined);

  let service: RemoteControlService | null = null;
  const windows = new RemoteMachineWindows({
    preloadPath: join(__dirname, '../preload/index.js'),
    title: (host: RemoteWindowHost, surface: RemoteSurface): string =>
      surface === 'app-advisor'
        ? `${ORCHESTRATOR_LABEL} — ${host.name}`
        : `${host.name} — ${BRAND.displayName}`,
    baseWindowOptions: (): BrowserWindowConstructorOptions => ({
      minWidth: 800,
      minHeight: 500,
      icon: options.iconPath,
      ...getWindowTitleBarOptions({
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: macWindowButtonPosition(
          uiScaleToZoomFactor(uiScale),
        ),
      }),
      autoHideMenuBar: true,
      ...getMainWindowMaterialOptions(hostPlatformOperatingSystem()),
      webPreferences: { spellcheck: true, ...uiZoomWebPreferences(uiScale) },
    }),
    loadRenderer,
    getMainWindow: options.getMainWindow,
    showLocalWindow: options.showMainWindow,
    isAllowedNavigation: isAllowedRendererNavigation,
    onClosed: (deviceId: string): void => service?.releaseMachine(deviceId),
    onAppAdvisorStateChanged: (deviceId, state): void =>
      service?.reportAppAdvisorWindowState(deviceId, state),
    keepHidden: (): boolean => !shouldShowUiAutomationWindow(),
    isQuitting: options.isAppQuitting,
  });

  service = new RemoteControlService({
    recordPairing: startRemotePairingTelemetry,
    recordTelemetry: recordRemoteControlTelemetry,
    store,
    createRelay: (relayOptions: RemoteRelayFactoryOptions): RemoteRelay =>
      new RelayClient({
        fetchToken: relayOptions.fetchToken,
        deviceInfo: relayOptions.deviceInfo,
        onStatusChange: relayOptions.onStatusChange,
        onPeersChange: (): void => relayOptions.onPeersChange(),
        onDiagnostic: relayOptions.onDiagnostic,
      }),
    fetchToken: fetchRelayToken,
    isFeatureEnabled: isRemoteControlAvailable,
    featureState: remoteControlFeatureState,
    signedInAccountKeys,
    wakeLock: getWakeLockService(),
    describeAvailability: describeRemoteControlAvailability,
    recordDiagnostic: recordRemoteControlDiagnostic,
    signedInAccount,
    deviceName,
    platform: devicePlatform(),
    onRemoteUpdatesAllowedChange: notifyRemoteUpdatePolicyChanged,
    version: currentRemoteVersion(
      app.getVersion(),
      process.env,
      __CANOPY_E2E__,
    ),
    createBridge: (controllerDeviceId: string): Promise<HostBridge> =>
      createBridgeWindow({
        controllerDeviceId,
        preloadPath: join(__dirname, '../preload/remote-bridge.js'),
      }),
    createAppAdvisorSurface: (session): RemoteAppAdvisorSurface =>
      new RemoteAppAdvisorSurface({
        controllerDeviceId: session.controllerDeviceId,
        bridgeFor: (surface) => session.bridgeFor(surface),
        bridgeWindow: (surface) => session.bridgeWindow(surface),
        requestWindow: (params) => session.requestAppAdvisorWindow(params),
        sendRequestCommands: options.appAdvisorRequestCommands,
        sendToWindow: (window, channel, payload): void => {
          sendToWindowDetailed(window, channel, payload);
        },
        redeliverQuestions: (surface): void =>
          redeliverPendingAppAdvisorAskUserRequests(
            surface.getAppAdvisorWindow,
            surface,
          ),
      }),
    mainWindowPushes,
    uploads,
    readHostFile: createHostFileReader({
      authorize: authorizeExternalFileRead,
      maxBytes: REMOTE_FILE_OPEN_MAX_BYTES,
    }),
    openedFiles: new RemoteUploadStore(
      join(dataDir, 'remote-control-opened-files'),
      {
        maxBytes: REMOTE_FILE_OPEN_MAX_BYTES,
        tooLargeMessage: REMOTE_FILE_OPEN_TOO_LARGE_MESSAGE,
      },
    ),
    markDownloaded: (path: string): Promise<void> =>
      markAsDownloaded(path, { agentName: BRAND.displayName }),
    openLocalFile: (path: string): Promise<void> =>
      openExternalGuarded(pathToFileURL(path).toString()),
    core: createRemoteCoreAccess(getDesktopCanopyRuntime),
    dispatchHostedChatCommand: async (
      request,
      attribution,
    ): Promise<unknown> => {
      const { dispatchHostedChatCommandOnDesktop } =
        await import('./host/hosted-chat-desktop');
      return dispatchHostedChatCommandOnDesktop(request, attribution);
    },
    completeAccountProxySignIn: async (
      controllerDeviceId,
      callback,
    ): Promise<void> => {
      const { completeRemoteAccountProxySignIn } =
        await import('../account-proxy/service');
      await completeRemoteAccountProxySignIn(controllerDeviceId, callback);
    },
    createAccountProxySignIns: ({ forward }): RemoteAccountProxySignIns =>
      new RemoteAccountProxySignIns({
        openExternal: openExternalGuarded,
        forward,
        ports: accountProxySignInCallbackPorts(),
      }),
    windows,
    broadcastState: (state: RemoteControlState): void =>
      sendToAllWindows(IPC_CHANNELS.remoteControlStateChanged, state),
    broadcastPairingEvent: (event: RemoteControlPairingEvent): void =>
      sendToAllWindows(IPC_CHANNELS.remoteControlPairingEvent, event),
    readPortalOptIn: readPortalOptInForMigration,
    ...(options.portal ? { portal: options.portal } : {}),
    webOrigin: (): string => new URL(getCanopyCloudBaseUrl()).origin,
    log: (message: string, context?: unknown): void =>
      logMainProcessInfo(message, context),
  });
  const activeService = service;

  const logReconcileError = (error: unknown): void => {
    logMainProcessError('Remote control could not update', error);
  };
  powerMonitor.on('resume', () => {
    activeService.handleSystemResume();
  });
  onRemoteControlAvailabilityChanged(() => {
    void activeService.reconcile().catch(logReconcileError);
  });
  subscribeCanopyCloudAccountChanges(() => {
    void activeService.reconcile().catch(logReconcileError);
  });

  setRemoteOpenDialogProvider((sender: WebContents, dialogOptions) => {
    const controllerDeviceId = resolveRemoteBridgeSender(sender);
    if (!controllerDeviceId) return null;
    const session = activeService.hostSessionForController(controllerDeviceId);
    if (!session) return Promise.resolve({ canceled: true, filePaths: [] });
    return session
      .showOpenDialog({
        title: dialogOptions.title,
        properties: dialogOptions.properties ?? [],
      })
      .catch(() => ({ canceled: true, filePaths: [] }));
  });

  // A controller's App Advisor window answers its own window calls, and a
  // chat driven from a controller runs its renderer tools there.
  setRemoteAppAdvisorWindowHostResolver((sender: WebContents) => {
    const controllerDeviceId = resolveRemoteBridgeSender(sender);
    return controllerDeviceId
      ? activeService.appAdvisorSurfaceForController(controllerDeviceId)
      : null;
  });
  setRendererToolSurfaceRouter((request) => {
    const chatId = getAppAdvisorRendererToolRequestOriginChatId(request);
    const controllerDeviceId = chatId ? chatDriver(chatId) : null;
    return controllerDeviceId
      ? activeService.appAdvisorSurfaceForController(controllerDeviceId)
      : null;
  });
  setRemoteUpdatePolicy({
    allowed: () => activeService.remoteUpdatesAllowed(),
    nameOf: (principalId) =>
      principalId.startsWith('remote-device:')
        ? activeService.controllerName(
            principalId.slice('remote-device:'.length),
          )
        : null,
  });
  // CAN-5823: a chat driven from a connected controller is served only by
  // that controller's window leases; otherwise by this computer's own.
  setInterfaceToolAudienceResolver((chatId) => {
    const controllerDeviceId = chatDriver(chatId);
    return controllerDeviceId &&
      activeService.hostSessionForController(controllerDeviceId)
      ? controllerDeviceId
      : null;
  });
  setAccountProxyRemoteSignInProvider((sender) => {
    const controllerDeviceId = resolveRemoteBridgeSender(sender);
    if (!controllerDeviceId) return null;
    return accountProxyRemoteSignInTarget({
      controllerDeviceId,
      session: activeService.hostSessionForController(controllerDeviceId),
      outdatedControllerMessage: `Update ${BRAND.displayName} on this computer to add accounts from here, or add the account on ${deviceName()}.`,
    });
  });

  registerRemoteControlIpc(activeService, windows);

  void activeService.initialize().catch((error: unknown) => {
    logMainProcessError('Remote control failed to start', error);
  });

  runtime = {
    service: activeService,
    resolveRemoteBridgeSender,
    liveMachineWindows: (): BrowserWindow[] => windows.liveWindows(),
  };
  return runtime;
}

function remoteDeviceForSender(
  windows: RemoteMachineWindows,
  sender: WebContents,
): string {
  const deviceId = windows.deviceIdForSender(sender);
  if (!deviceId) {
    throw new Error('This window is not showing another computer.');
  }
  return deviceId;
}

function parseDeviceId(value: unknown): string {
  if (typeof value !== 'string' || !isDeviceId(value)) {
    throw new Error('Invalid device ID.');
  }
  return value;
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseArgs(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Arguments must be an array.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function registerRemoteControlIpc(
  service: RemoteControlService,
  windows: RemoteMachineWindows,
): void {
  registerIpcHandler(
    IPC_CHANNELS.remoteControlGetState,
    (_event, request?: RemoteControlGetStateRequest) =>
      service.getState({ discover: request?.discover === true }),
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlOpenMachine,
    (_event, deviceId: unknown) =>
      service.openMachine(deviceId === null ? null : parseDeviceId(deviceId)),
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlSetAllowIncoming,
    (_event, allow: unknown) => {
      if (typeof allow !== 'boolean') throw new Error('Expected a boolean.');
      return service.setAllowIncoming(allow);
    },
  );
  registerIpcHandler(IPC_CHANNELS.remoteControlOpenPairingWindow, () =>
    service.openPairingWindow(),
  );
  registerIpcHandler(IPC_CHANNELS.remoteControlClosePairingWindow, () =>
    service.closePairingWindow(),
  );
  // Tunneled: a controller reads it through its bridge after authorization.
  registerIpcHandler(
    IPC_CHANNELS.remoteControlInstallId,
    async (): Promise<RemoteControlInstallIdResult> => ({
      installId: await readDurablePortalInstallId(),
    }),
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlStartPairing,
    (_event, deviceId: unknown) =>
      service.startPairing(parseDeviceId(deviceId)),
  );
  registerIpcHandler(IPC_CHANNELS.remoteControlCancelPairing, () =>
    service.cancelPairing(),
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlSetAllowRemoteUpdates,
    (_event, allow: unknown) => {
      if (typeof allow !== 'boolean') throw new Error('Expected a boolean.');
      return service.setAllowRemoteUpdates(allow);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlRespondToPairing,
    (_event, request: RemoteControlRespondToPairingRequest) => {
      if (!isRecord(request) || typeof request.approve !== 'boolean') {
        throw new Error('Invalid pairing response.');
      }
      validateId(request.pairingId, 'pairingId');
      return service.respondToPairing(request);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlForgetDevice,
    (_event, request: RemoteControlForgetDeviceRequest) => {
      if (
        !isRecord(request) ||
        (request.role !== 'host' && request.role !== 'controller')
      ) {
        throw new Error('Invalid device.');
      }
      return service.forgetDevice({
        deviceId: parseDeviceId(request.deviceId),
        role: request.role,
      });
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlDisconnectController,
    (_event, deviceId: unknown) =>
      service.disconnectController(parseDeviceId(deviceId)),
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlInvoke,
    (event, channel: unknown, args: unknown): Promise<unknown> => {
      const target = windows.surfaceForSender(event.sender);
      if (!target) {
        throw new Error('This window is not showing another computer.');
      }
      const { deviceId, surface } = target;
      const name = parseString(channel, 'Channel');
      const parsedArgs = parseArgs(args);
      if (
        surface === 'app-advisor' &&
        name === IPC_CHANNELS.appAdvisorWindowRendererReady
      ) {
        windows.markAppAdvisorReady(deviceId);
      }
      const linkUrl = linkUrlForLocalOpen(name, parsedArgs);
      if (linkUrl !== null) {
        // The in-app browser lives on the other computer's screen, so links
        // clicked in its window open in this computer's default browser.
        return shell.openExternal(linkUrl);
      }
      return service.invoke(deviceId, name, parsedArgs, surface);
    },
  );
  ipcMain.removeAllListeners(IPC_CHANNELS.remoteControlSend);
  ipcMain.on(
    IPC_CHANNELS.remoteControlSend,
    (event: IpcMainEvent, channel: unknown, args: unknown) => {
      const target = windows.surfaceForSender(event.sender);
      if (!target || typeof channel !== 'string' || !Array.isArray(args)) {
        return;
      }
      service.post(target.deviceId, channel, args, target.surface);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlUpload,
    (event, request: unknown): Promise<string> => {
      if (
        !isRecord(request) ||
        typeof request.fileName !== 'string' ||
        !(request.bytes instanceof Uint8Array)
      ) {
        throw new Error('Invalid upload.');
      }
      if (request.bytes.byteLength > REMOTE_UPLOAD_MAX_BYTES) {
        throw new Error(REMOTE_UPLOAD_TOO_LARGE_MESSAGE);
      }
      return service.upload(
        remoteDeviceForSender(windows, event.sender),
        request.fileName,
        request.bytes,
      );
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlPathPickerResolve,
    (event, response: RemotePathPickerResponse) => {
      if (
        !isRecord(response) ||
        typeof response.requestId !== 'string' ||
        (response.path !== null && typeof response.path !== 'string')
      ) {
        throw new Error('Invalid picker response.');
      }
      validateId(response.requestId, 'requestId');
      windows.resolvePicker(event.sender, response);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.remoteControlListDirectory,
    (event, request: unknown) => {
      // Only for a remote window's folder picker, tunneled to this computer.
      if (resolveRemoteBridgeSender(event.sender) === null) {
        throw new Error('Directory listing is only for remote control.');
      }
      return listRemoteDirectory(request);
    },
  );
}
