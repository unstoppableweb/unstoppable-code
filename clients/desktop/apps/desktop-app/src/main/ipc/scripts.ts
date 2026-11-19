import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  type LoadWorktreeScriptRunsRequest,
  type SaveProjectScriptsRequest,
  type SaveWorkspacePlanDetectionRequest,
  type SaveWorkspaceRepoScriptsRequest,
  type SaveWorkspaceScriptsRequest,
  type ScriptRunRequest,
  type ScriptRunLogRequest,
  type ScriptRunLogResponse,
  type ScriptRunResponse,
  type ScriptRunSnapshot,
  type ScriptSourceInfoRequest,
  type ScriptSourceInfoResponse,
  type ScriptStopRequest,
} from '@canopy/desktop-shared/types';
import {
  loadWorktreeScriptRuns,
  readScriptRunTail,
  runScript,
  stopScript,
} from '../services/scripts-service';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';
import { readScriptSourceInfo } from '../lib/script-source-info';
import {
  saveProjectScripts,
  saveWorkspaceRepoScripts,
  saveWorkspaceScripts,
} from '../lib/script-definition-saves';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { projectWorktreeSetupCancel } from '../canopy-runtime/core-worktree-setup-adapter';
import {
  projectedWorkspaceMetadataCommands,
  type ProjectedWorkspaceMetadataCommands,
} from '../canopy-runtime/workspace-metadata-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import { withDaemonScriptRoute } from '../lib/daemon-script-route-context';
import {
  selectDaemonScripts,
  type DaemonScriptRouteContext,
} from '../lib/daemon-script-route';

export function registerScriptHandlers(
  runtime: {
    dispatcher: Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;
    resolveCaller: DesktopIpcCallerResolver;
  },
  windows: {
    getMainWindow: () => BrowserWindow | null;
    getAppAdvisorWindow: () => BrowserWindow | null;
  } = {
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
  },
): void {
  const metadataCommands = (
    event: Parameters<DesktopIpcCallerResolver>[0],
  ): ProjectedWorkspaceMetadataCommands =>
    projectedWorkspaceMetadataCommands({
      dispatcher: runtime.dispatcher,
      caller: runtime.resolveCaller(event),
    });
  const routeContext = (
    event: Pick<IpcMainInvokeEvent, 'sender'> | null | undefined,
  ): DaemonScriptRouteContext => ({
    localWindow:
      event !== null &&
      event !== undefined &&
      resolveRemoteBridgeSender(event.sender) === null &&
      [windows.getMainWindow(), windows.getAppAdvisorWindow()].some(
        (window) =>
          window !== null &&
          window.webContents === event.sender &&
          !window.isDestroyed(),
      ),
  });
  registerIpcHandler(
    IPC_CHANNELS.scriptRun,
    async (event, request: ScriptRunRequest): Promise<ScriptRunResponse> =>
      (
        await withDaemonScriptRoute(
          selectDaemonScripts(routeContext(event)),
          () =>
            runScript(request, {
              onRendererStarted: (started) => {
                if (event.sender.isDestroyed()) return;
                sendToWebContents(
                  event.sender,
                  IPC_CHANNELS.scriptStarted,
                  started,
                );
              },
              onRendererOutput: (output) => {
                if (event.sender.isDestroyed()) return;
                sendToWebContents(
                  event.sender,
                  IPC_CHANNELS.scriptOutput,
                  output,
                );
              },
              onRendererComplete: (complete) => {
                if (event.sender.isDestroyed()) return;
                sendToWebContents(
                  event.sender,
                  IPC_CHANNELS.scriptComplete,
                  complete,
                );
              },
            }),
        )
      ).value,
  );

  registerIpcHandler(
    IPC_CHANNELS.scriptStop,
    async (
      event,
      request: ScriptStopRequest,
    ): Promise<ScriptRunResponse | null> =>
      stopScript(request, {
        onRendererComplete: (complete) => {
          sendToWebContents(
            event.sender,
            IPC_CHANNELS.scriptComplete,
            complete,
          );
        },
      }),
  );

  registerIpcHandler(
    IPC_CHANNELS.scriptCancelWorktreeSetup,
    async (
      event,
      request: { projectId: string; worktreeId: string },
    ): Promise<void> =>
      projectWorktreeSetupCancel(
        {
          dispatcher: runtime.dispatcher,
          caller: runtime.resolveCaller(event),
        },
        request,
        (complete) => {
          sendToWebContents(
            event.sender,
            IPC_CHANNELS.scriptComplete,
            complete,
          );
        },
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.scriptLoadWorktreeRuns,
    async (
      _event,
      request: LoadWorktreeScriptRunsRequest,
    ): Promise<ScriptRunSnapshot[]> => loadWorktreeScriptRuns(request),
  );

  // One script's latest run as its log tail, the read Portal's script log
  // request runs, without its event-stream push (browser Remote Control,
  // CAN-5985).
  registerIpcHandler(
    IPC_CHANNELS.scriptReadRunLog,
    async (
      _event,
      request: ScriptRunLogRequest,
    ): Promise<ScriptRunLogResponse> => {
      if (typeof request.scriptKey !== 'string' || !request.scriptKey) {
        throw new Error('scriptKey is required.');
      }
      const { lines } = await readScriptRunTail({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        scriptKey: request.scriptKey,
      });
      return { lines };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.scriptSourceInfo,
    async (
      event,
      request: ScriptSourceInfoRequest,
    ): Promise<ScriptSourceInfoResponse> =>
      readScriptSourceInfo(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.projectSaveScripts,
    async (event, request: SaveProjectScriptsRequest): Promise<void> =>
      saveProjectScripts(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveScripts,
    async (event, request: SaveWorkspaceScriptsRequest): Promise<void> =>
      saveWorkspaceScripts(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSavePlanDetection,
    async (
      event,
      request: SaveWorkspacePlanDetectionRequest,
    ): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      await metadataCommands(event).updatePlanDetection({
        workspaceId: request.workspaceId,
        planDetection: request.planDetection,
        source: 'desktop',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveRepoScripts,
    async (event, request: SaveWorkspaceRepoScriptsRequest): Promise<void> =>
      saveWorkspaceRepoScripts(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );
}
