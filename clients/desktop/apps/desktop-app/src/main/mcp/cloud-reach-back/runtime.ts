import { app } from 'electron';
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
import { readPreferencesFile } from '../../lib/preferences-store';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sanitizeEnvVars } from '@canopy/execution-engine/lib/mcp-security';
import type { McpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import { openStdioJsonRpcSession } from '@canopy/desktop-shared/node/mcp/stdio-json-rpc-session';
import { getCodexRuntimeService } from '../../codex/runtime-service';
import type { ReachBackAdmission, ReachBackForwarder } from './serve';
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
import {
  createReachBackHttpForwarder,
  serverConfigRevision,
} from './http-forwarder';
import {
  createReachBackStdioBridge,
  onMcpServerSettingsChange,
  type ReachBackStdioTicket,
} from './stdio-bridge';
import { createReachBackServer } from './serve';
import {
  createReachBackReachability,
  type ReachBackReachability,
} from './reachability';
import { createReachBackService } from './service';
import { servingReport } from './serving-report';
import { createReachBackSessionOpener } from '../../canopy-cloud/reach-back-web-core-session';

const DESKTOP_CONNECTION_PATH = '/api/v1/mcp-connections/desktop';

/** What the opt-in dialog and the call log read (PR 7c). */
export interface CloudReachBack {
  readonly allowList: ReachBackAllowList;
  readonly log: ReachBackActivityLog;
  /** Whether each allowed server was reachable at its last cloud chat call. */
  readonly reachability: ReachBackReachability;
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
  const readServer = async (serverId: string): Promise<McpServerFile> =>
    normalizeMcpServerFile(
      await safeReadJsonAsync<unknown>(getMcpServerFilePath(serverId)),
      serverId,
    );
  // A command server's config, launched through the stdio broker under an
  // owner of its own, revoked when the session closes (PR 7b).
  const stdio = createReachBackStdioBridge({
    onSettingsChange: onMcpServerSettingsChange,
    resolveLaunch: async (server, revision) => {
      const file = await readServer(server.serverId);
      // Launch only the settings the request was checked against.
      if (serverConfigRevision(file, server.configId) !== revision)
        return 'configChanged';
      const definition = file.server.definition;
      const config = file.server.configs.find(
        (candidate) => candidate.id === server.configId,
      );
      if (
        definition.type !== 'command' ||
        !definition.command ||
        !config?.enabled
      )
        return null;
      const broker = getCodexRuntimeService();
      const ownerId = `cloud-reach-back:${randomUUID()}`;
      const route = await broker.registerStdioMcpRoute({
        ownerId,
        routeKey: `${server.serverId}/${server.configId}`,
        command: definition.command,
        args: [...(definition.args ?? []), ...config.extraArgs],
        ...(Object.keys(config.envVars).length > 0
          ? { env: sanitizeEnvVars(config.envVars) }
          : {}),
      });
      return {
        command: route.command,
        args: route.args,
        ...(route.cwd === undefined ? {} : { cwd: route.cwd }),
        // The launcher finds the broker under the temp directory main uses.
        env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() },
        release: (): Promise<void> => broker.revokeStdioMcpRoutes(ownerId),
      };
    },
    openSession: (launch) => openStdioJsonRpcSession(launch),
    // Synchronous, so a request's ticket is taken before any await.
    readSettings: (target) => {
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(getMcpServerFilePath(target.serverId), 'utf8'),
        );
        const file = normalizeMcpServerFile(parsed, target.serverId);
        return {
          startsProcess: file.server.definition.type === 'command',
          configRevision: serverConfigRevision(file, target.configId),
        };
      } catch {
        return null;
      }
    },
  });
  const http = createReachBackHttpForwarder({
    accountId: currentAccountId,
    readServer,
    service: proxy,
    runningPort: () => proxy.getPort(),
    preferredPort: async () => (await readPreferencesFile()).mcpProxyPort,
    registerRoute: registerDeviceHttpMcpRoute,
  });
  /**
   * Command servers go to the stdio bridge, the rest to the loopback route,
   * by the ticket the request was admitted on; one forwarded without a
   * ticket is admitted here, before any await.
   */
  const tickets = new WeakMap<ReachBackAdmission, ReachBackStdioTicket>();
  const commandOrHttp: ReachBackForwarder = {
    admit: (target) => {
      const ticket = stdio.admit(target);
      if (ticket !== null) tickets.set(ticket, ticket);
      return ticket;
    },
    forward: (server, request) => {
      const ticket =
        (request.admission === undefined
          ? undefined
          : tickets.get(request.admission)) ?? stdio.admit(server);
      if (ticket === null)
        return Promise.reject(new Error('The server settings are unreadable.'));
      return ticket.startsProcess
        ? stdio.forward(server, { ...request, admission: ticket })
        : http.forward(server, request);
    },
  };
  const approver = createReachBackApprover({
    getWindow: getMainWindow,
    createSession: createApprovalSession,
  });
  const reachability = createReachBackReachability();
  const server = createReachBackServer({
    allowList,
    log,
    approver,
    forwarder: commandOrHttp,
    reachability,
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
    closeRoutes: (accountId) => {
      stdio.close();
      http.close(accountId);
    },
    servingOf: async (accountId) =>
      servingReport(accountId, await allowList.list(accountId), {
        reachability,
        now: Date.now,
        // A server whose settings are gone or turned off can't start.
        unusable: async (allowed) => {
          try {
            const file = await readServer(allowed.serverId);
            const config = file.server.configs.find(
              (candidate) => candidate.id === allowed.configId,
            );
            return config?.enabled ? null : 'start_failed';
          } catch {
            return 'start_failed';
          }
        },
      }),
    onServingChange: (listener) => {
      const stopReachability = reachability.onChange(listener);
      const stopSettings = onMcpServerSettingsChange(() => listener());
      return (): void => {
        stopReachability();
        stopSettings();
      };
    },
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
    onServerOff: (serverId, configId) => {
      stdio.forget(serverId, configId);
      http.forget(serverId, configId);
      reachability.forget(serverId, configId);
    },
  });
  service.start();
  return {
    allowList,
    log,
    reachability,
    controller,
    async stop() {
      stopForgetting();
      stdio.dispose();
      await service.stop();
      approver.dispose();
    },
  };
}
