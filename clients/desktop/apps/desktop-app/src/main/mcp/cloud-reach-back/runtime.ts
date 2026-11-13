import { app } from 'electron';
import { DEFAULT_MCP_PROXY_PORT } from '@canopy/desktop-shared/types';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import { createApprovalSession } from '../../approvals/approval-service';
import { requestCanopyCloudJson } from '../../canopy-cloud/client';
import { removeAccountMcpConnection } from '../../canopy-cloud/mcp-connections';
import { getFeatureFlagService } from '../../feature-flags';
import { desktopWebCoreBindingOptions } from '../../ipc/cloud-chats';
import {
  peekCanopyCloudAccountId,
  subscribeCanopyCloudAccountChanges,
} from '../../lib/canopy-cloud-account-store';
import { safeReadJsonAsync } from '../../lib/fs-utils';
import { getMainWindow } from '../../lib/main-window-focus';
import {
  getCloudReachBackActivityFilePath,
  getCloudReachBackFilePath,
  getMcpServerFilePath,
} from '../../lib/paths';
import { registerDeviceHttpMcpRoute } from '../../plugins/plugin-resolver';
import { getMcpHttpProxyService } from '../http-proxy-service';
import {
  createReachBackActivityLog,
  type ReachBackActivityLog,
} from './activity-log';
import {
  createReachBackAllowList,
  forgetSignedOutAccounts,
  type ReachBackAllowList,
} from './allow-list';
import { createReachBackApprover } from './approval';
import { createReachBackController } from './controller';
import { createReachBackHttpForwarder } from './http-forwarder';
import { createReachBackServer } from './serve';
import { createReachBackService } from './service';
import { createReachBackSessionOpener } from '../../canopy-cloud/reach-back-web-core-session';

const DESKTOP_CONNECTION_PATH = '/api/v1/mcp-connections/desktop';

/** What the opt-in dialog and the call log read (PR 7c). */
export interface CloudReachBack {
  readonly allowList: ReachBackAllowList;
  readonly log: ReachBackActivityLog;
  readonly controller: ReturnType<typeof createReachBackController>;
}

function connectionIdOf(payload: unknown): string {
  const connection =
    typeof payload === 'object' && payload !== null && 'connection' in payload
      ? payload.connection
      : null;
  const id =
    typeof connection === 'object' && connection !== null && 'id' in connection
      ? connection.id
      : null;
  if (typeof id !== 'string' || id.length === 0)
    throw new Error('Invalid desktop connection response.');
  return id;
}

/**
 * Main's reach-back service, composed (CAN-6176 PR 7a): the allow list and
 * call log, sign-out pruning, the approval, the loopback forwarder, and the
 * stream on main's own web core connection. Returns the parts PR 7c's UI
 * uses and a stop.
 */
export function startCloudReachBackRuntime(): CloudReachBack & {
  stop(): Promise<void>;
} {
  const currentAccountId = (): string | null =>
    peekCanopyCloudAccountId() ?? null;
  const allowList = createReachBackAllowList({
    filePath: getCloudReachBackFilePath,
  });
  const log = createReachBackActivityLog({
    filePath: getCloudReachBackActivityFilePath,
    currentAccountId,
  });
  const stopForgetting = forgetSignedOutAccounts([allowList, log], {
    currentAccountId,
    onAccountChange: (listener) =>
      subscribeCanopyCloudAccountChanges((entry) =>
        listener(entry?.account?.id ?? null),
      ),
  });
  const proxy = getMcpHttpProxyService();
  const forwarder = createReachBackHttpForwarder({
    accountId: currentAccountId,
    readServer: async (serverId) =>
      normalizeMcpServerFile(
        await safeReadJsonAsync<unknown>(getMcpServerFilePath(serverId)),
        serverId,
      ),
    service: proxy,
    port: () => proxy.getPort() ?? DEFAULT_MCP_PROXY_PORT,
    registerRoute: registerDeviceHttpMcpRoute,
  });
  const approver = createReachBackApprover({
    getWindow: getMainWindow,
    createSession: createApprovalSession,
  });
  const server = createReachBackServer({
    allowList,
    log,
    approver,
    forwarder,
  });
  const binding = desktopWebCoreBindingOptions();
  const service = createReachBackService({
    isEnabled: binding.isEnabled,
    onEnabledChange: (listener) =>
      getFeatureFlagService().onSnapshotChanged(() => listener()),
    currentAccountId,
    onAccountChange: (listener) =>
      subscribeCanopyCloudAccountChanges(() => listener()),
    allowList,
    open: createReachBackSessionOpener(binding, app.getVersion()),
    serve: (accountId, request, signal) =>
      server.serve(accountId, request, signal),
    closeRoutes: (accountId) => forwarder.close(accountId),
  });
  const controller = createReachBackController({
    allowList,
    currentAccountId,
    recordDesktopConnection: async (input) => ({
      connectionId: connectionIdOf(
        await requestCanopyCloudJson<unknown>(DESKTOP_CONNECTION_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
    }),
    removeConnection: async (connectionId) => {
      await removeAccountMcpConnection(connectionId);
    },
    onServerOff: (serverId, configId) => forwarder.forget(serverId, configId),
  });
  service.start();
  return {
    allowList,
    log,
    controller,
    async stop() {
      stopForgetting();
      await service.stop();
      approver.dispose();
    },
  };
}
