import { agentResourceContextEnabled } from '../agents/resource-lanes';
import { refreshAgentModelsFromStore } from '../lib/agent-models';
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import { showRemoteOpenDialogForEvent } from '../lib/dialog-window';
import {
  IPC_CHANNELS,
  toOllamaModelId,
  type ModelRegistrySnapshot,
  type OllamaConfigurationUpdate,
  type OllamaDeleteResult,
  type OllamaInstallProgress,
  type OllamaPullProgress,
  type OllamaState,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  destroySessionsByModel,
  destroySessionsByProvider,
} from '../agents/session-manager';
import { isRecord } from '../lib/type-guards';
import { getOllamaService } from '../ollama';
import { readPreferencesFile } from './preferences';
import { invalidateRendererRuntimePreferencesCache } from '../lib/preferences-store';
import { registerIpcHandler } from './register';
import type { DesktopIpcCallerResolver } from './file-tree';
import {
  getModelRegistryThroughWorker,
  type WorkerAgentProviderDispatcher,
} from '../agent-providers/model-registry-projection';
import { retryAiGatewayModelCatalog } from '../ai-gateway-models/status';
import {
  broadcastModelRegistryUpdated as broadcastSharedModelRegistryUpdated,
  buildModelRegistrySnapshot,
  getSynchronousModelRegistrySnapshot,
  setModelRegistryBroadcastHandler,
} from '../models/model-registry';
import { sendToWebContents } from '../lib/web-contents-send';

function broadcast(
  getWindow: () => BrowserWindow | null,
  channel: string,
  data: unknown,
): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    sendToWebContents(win.webContents, channel, data);
  }
}

const OLLAMA_FLAT_MODEL_PREFERENCE_USAGE_LABELS = [
  ['summaryModel', 'Chat settings > Chat title model'],
  ['handoffSummaryModel', 'Chat settings > Conversation handoff model'],
  ['worktreeSummaryModel', 'Chat settings > Worktree activity summary model'],
  ['branchNamingModel', 'Git settings > Branch naming model'],
  ['prGenerationModel', 'Git settings > Pull request generation model'],
  ['commitGenerationModel', 'Git settings > Commit message generation model'],
  ['localMemoryModel', 'Memory settings > Local memory model'],
] as const satisfies ReadonlyArray<readonly [keyof PreferencesData, string]>;

function extractModelName(req: unknown): string {
  if (typeof req === 'string') {
    return req;
  }

  if (isRecord(req) && typeof req.model === 'string') {
    return req.model;
  }

  throw new Error('Model name is required');
}

function getConfiguredPreferenceUsages(
  preferences: PreferencesData,
  rawModelName: string,
): string[] {
  const modelId = toOllamaModelId(rawModelName);
  const flatUsages = OLLAMA_FLAT_MODEL_PREFERENCE_USAGE_LABELS.flatMap(
    ([key, label]) => (preferences[key] === modelId ? [label] : []),
  );
  const perProviderUsages: string[] = [];
  if (preferences.defaultChatModelByProvider.ollama?.model === modelId) {
    perProviderUsages.push('Chat settings > Standalone Chat model (Ollama)');
  }
  if (preferences.defaultWorktreeModelByProvider.ollama?.model === modelId) {
    perProviderUsages.push('Chat settings > Worktree model (Ollama)');
  }
  return [...perProviderUsages, ...flatUsages];
}

function broadcastOllamaStatus(
  getWindow: () => BrowserWindow | null,
  state: OllamaState,
): void {
  broadcast(getWindow, IPC_CHANNELS.ollamaStatus, state);
}

function broadcastOllamaPullProgress(
  getWindow: () => BrowserWindow | null,
  progress: OllamaPullProgress,
): void {
  broadcast(getWindow, IPC_CHANNELS.ollamaPullProgress, progress);
}

function broadcastOllamaInstallProgress(
  getWindow: () => BrowserWindow | null,
  progress: OllamaInstallProgress,
): void {
  broadcast(getWindow, IPC_CHANNELS.ollamaInstallProgress, progress);
}

function broadcastModelRegistryUpdated(
  getWindow: () => BrowserWindow | null,
  snapshot: ModelRegistrySnapshot,
): void {
  const windows =
    typeof BrowserWindow.getAllWindows === 'function'
      ? BrowserWindow.getAllWindows()
      : [getWindow()].filter((window): window is BrowserWindow =>
          Boolean(window),
        );
  for (const window of windows) {
    if (!window.isDestroyed()) {
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.modelRegistryUpdated,
        snapshot,
      );
    }
  }
}

function resolveBrowsedOllamaExecutablePath(filePath: string): string {
  if (process.platform === 'darwin' && filePath.endsWith('.app')) {
    return `${filePath}/Contents/Resources/ollama`;
  }
  if (
    process.platform === 'win32' &&
    !filePath.toLowerCase().endsWith('ollama.exe')
  ) {
    throw new Error('Select the Ollama executable named ollama.exe.');
  }
  return filePath;
}

export function registerModelRegistryHandlers(
  getWindow: (() => BrowserWindow | null) | undefined,
  runtime: {
    dispatcher: WorkerAgentProviderDispatcher;
    resolveCaller: DesktopIpcCallerResolver;
  },
): void {
  if (getWindow) {
    setModelRegistryBroadcastHandler((snapshot: ModelRegistrySnapshot) => {
      invalidateRendererRuntimePreferencesCache();
      broadcastModelRegistryUpdated(getWindow, snapshot);
    });
  }

  ipcMain.on(IPC_CHANNELS.modelRegistryGet, (event) => {
    event.returnValue = getSynchronousModelRegistrySnapshot();
    void buildModelRegistrySnapshot();
  });

  registerIpcHandler(
    IPC_CHANNELS.modelRegistryGet,
    async (event, request?: { probe?: boolean }) => {
      if (agentResourceContextEnabled()) await refreshAgentModelsFromStore();
      // worker.agent.provider.list; the synchronous bootstrap listener above
      // keeps the direct snapshot (CAN-4121 D13).
      const snapshot = await getModelRegistryThroughWorker(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request?.probe === true,
      );
      if (request?.probe === true) {
        const { notifyPortalModelCatalogChanged } =
          await import('../portal/portal-event-bus');
        broadcastSharedModelRegistryUpdated();
        await notifyPortalModelCatalogChanged();
      }
      return snapshot;
    },
  );

  // The outcome reaches the renderer through the registry broadcast that the
  // catalog status change triggers; this resolves once the attempt finishes.
  registerIpcHandler(
    IPC_CHANNELS.aiGatewayModelCatalogRetry,
    async (): Promise<void> => {
      await retryAiGatewayModelCatalog();
    },
  );
}

/** The Settings Ollama install, shared with App Advisor (CAN-6008). */
export async function installOllamaForWindow(
  getWindow: () => BrowserWindow | null,
): Promise<OllamaState> {
  const ollamaService = getOllamaService();
  const before = await ollamaService.getState();
  const state = await ollamaService.install((progress) =>
    broadcastOllamaInstallProgress(getWindow, progress),
  );
  if (state.installation.path !== before.installation.path) {
    await destroySessionsByProvider('ollama');
  }
  return state;
}

export function registerOllamaHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  const ollamaService = getOllamaService();
  ollamaService.setBroadcastHandlers({
    status: (state: OllamaState): void =>
      broadcastOllamaStatus(getWindow, state),
    pullProgress: (progress: OllamaPullProgress): void =>
      broadcastOllamaPullProgress(getWindow, progress),
    installProgress: (progress: OllamaInstallProgress): void =>
      broadcastOllamaInstallProgress(getWindow, progress),
    modelRegistryUpdated: (): void => {
      void broadcastSharedModelRegistryUpdated();
    },
  });

  registerIpcHandler(IPC_CHANNELS.ollamaGetState, () =>
    ollamaService.getState(),
  );

  registerIpcHandler(IPC_CHANNELS.ollamaRefreshModels, async () => {
    return ollamaService.refreshModels({ allowStart: true });
  });

  registerIpcHandler(
    IPC_CHANNELS.ollamaPullModel,
    async (_event: IpcMainInvokeEvent, req: unknown) => {
      return ollamaService.pullModel(extractModelName(req));
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ollamaDeleteModel,
    async (_event: IpcMainInvokeEvent, req: unknown) => {
      const model = extractModelName(req);
      const preferences = await readPreferencesFile();
      const blockedByPreferences = getConfiguredPreferenceUsages(
        preferences,
        model,
      );
      if (blockedByPreferences.length > 0) {
        return {
          ok: false,
          blockedByPreferences,
        } satisfies OllamaDeleteResult;
      }

      await destroySessionsByModel(toOllamaModelId(model));
      const state = await ollamaService.deleteModel(model);
      return {
        ok: true,
        state,
      } satisfies OllamaDeleteResult;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ollamaSetConfiguration,
    async (_event: IpcMainInvokeEvent, update: OllamaConfigurationUpdate) => {
      const state = await ollamaService.setConfiguration(update);
      await destroySessionsByProvider('ollama');
      return state;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.ollamaTestConnection,
    async (_event: IpcMainInvokeEvent, req?: unknown) => {
      const port =
        isRecord(req) && typeof req.port === 'number' ? req.port : undefined;
      return ollamaService.testConnection(port, {
        background: isRecord(req) && req.background === true,
      });
    },
  );

  registerIpcHandler(IPC_CHANNELS.ollamaRedetectInstallation, async () => {
    const before = await ollamaService.getState();
    const state = await ollamaService.redetectInstallation({ force: true });
    if (
      state.installation.ready !== before.installation.ready ||
      state.installation.path !== before.installation.path ||
      state.installation.version !== before.installation.version
    ) {
      await destroySessionsByProvider('ollama');
    }
    return state;
  });

  registerIpcHandler(IPC_CHANNELS.ollamaBrowseInstallation, async (event) => {
    const win = getWindow();
    const dialogOptions: OpenDialogOptions = {
      title: 'Select Ollama',
      properties:
        process.platform === 'darwin'
          ? ['openFile', 'openDirectory']
          : ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Ollama executable', extensions: ['exe'] }]
          : [],
    };
    const result =
      (await showRemoteOpenDialogForEvent(event, dialogOptions)) ??
      (win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions));
    if (result.canceled || result.filePaths.length === 0) {
      return ollamaService.getState();
    }
    const executablePath = resolveBrowsedOllamaExecutablePath(
      result.filePaths[0],
    );
    const state = await ollamaService.setExecutablePath(executablePath);
    if (
      state.installation.ready &&
      state.installation.path === executablePath
    ) {
      await destroySessionsByProvider('ollama');
    }
    return state;
  });

  registerIpcHandler(IPC_CHANNELS.ollamaInstall, () =>
    installOllamaForWindow(getWindow),
  );
}
