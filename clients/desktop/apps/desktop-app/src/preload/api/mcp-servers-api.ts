import type { IpcRendererEvent } from 'electron';
import { ipcRenderer, remoteWindowContext } from '../ipc-router';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import type { CuratedMcpServerListResponse } from '@canopy/protocol/mcp-catalog';
import type { McpServerHarnessInstalls } from '@canopy/protocol/mcp-servers';
import type {
  AccountMcpConnection,
  AccountMcpConnectionFailure,
  AccountMcpUpstreamTool,
  StartAccountMcpConnectionResponse,
  ClearMcpOAuthTokenRequest,
  ListDetectedMcpServersRequest,
  ListDetectedMcpServersResponse,
  McpProxyState,
  SaveMcpServerRequest,
  AccountMcpConnectionSummary,
  McpServerHealthCheckResult,
  McpServerStatusEntry,
  ProviderConnectorListResult,
  ProviderConnectorProvider,
  McpServerTestConnectionResult,
  McpServerToolsCacheEntry,
  McpServerFile,
  McpServersAPI,
  McpServersIndexFile,
  RemoveAccountMcpConnectionResponse,
  RewriteMcpServerRefsResponse,
  StartMcpOAuthLoginRequest,
  StartMcpOAuthLoginResponse,
} from '@canopy/execution-engine/types/mcp-servers';

export type { McpServersAPI };

export function createMcpServersAPI(): McpServersAPI {
  return {
    removalCandidates: () =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.REMOVAL_CANDIDATES),
    inspectRemoval: (request) =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.INSPECT_REMOVAL, request),
    forceRemoval: (request) =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.FORCE_REMOVAL, request),
    listAccountConnections: (): Promise<AccountMcpConnectionSummary[]> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.LIST_ACCOUNT_CONNECTIONS),
    startAccountConnection: (
      request,
    ): Promise<
      StartAccountMcpConnectionResponse | AccountMcpConnectionFailure
    > => {
      // Older hosts validate this request strictly. Embedded routing belongs
      // to the local pane, so never put its key on the tunnel at all.
      const { browser, ...externalRequest } = request;
      return ipcRenderer.invoke(
        MCP_SERVER_CHANNELS.START_ACCOUNT,
        !remoteWindowContext && browser === 'embedded'
          ? { ...externalRequest, browser }
          : externalRequest,
      );
    },
    getAccountConnection: (id): Promise<AccountMcpConnection> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.GET_ACCOUNT, id),
    updateAccountConnection: (
      id,
      request,
    ): Promise<AccountMcpConnection | AccountMcpConnectionFailure> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.UPDATE_ACCOUNT, id, request),
    removeAccountConnection: (
      id,
      options,
    ): Promise<RemoveAccountMcpConnectionResponse> => {
      if (options === undefined)
        return ipcRenderer.invoke(MCP_SERVER_CHANNELS.REMOVE_ACCOUNT, id);
      // A paired host of an older build reads only the id and would remove a
      // row the sign-in connected meanwhile, so a remote window never sends a
      // sign-in's own cleanup; the person can still Remove the row.
      if (options.unlessConnected && remoteWindowContext)
        return Promise.resolve({ removed: false });
      return ipcRenderer.invoke(
        MCP_SERVER_CHANNELS.REMOVE_ACCOUNT,
        id,
        options,
      );
    },
    rewriteServerRefs: (request): Promise<RewriteMcpServerRefsResponse> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.REWRITE_REFS, request),
    disconnectAccountConnection: (id): Promise<void> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.DISCONNECT_ACCOUNT, id),
    setAccountConnectionTools: (id, tools): Promise<AccountMcpConnection> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.SET_ACCOUNT_TOOLS, id, tools),
    listAccountConnectionUpstreamTools: (
      id,
    ): Promise<AccountMcpUpstreamTool[]> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.LIST_ACCOUNT_UPSTREAM_TOOLS, id),
    awaitAccountConnection: (
      id,
      options,
    ): Promise<AccountMcpConnection | AccountMcpConnectionFailure> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.AWAIT_ACCOUNT, id, options),
    loadIndex: (): Promise<McpServersIndexFile> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.LOAD_INDEX),
    loadServer: (id: string): Promise<McpServerFile> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.LOAD_SERVER, id),
    saveServer: (server: SaveMcpServerRequest): Promise<McpServerFile> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.SAVE_SERVER, server),
    deleteServer: (id: string): Promise<void> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.DELETE_SERVER, id),
    checkHealth: (
      serverId: string,
      configId?: string,
    ): Promise<McpServerHealthCheckResult> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.CHECK_HEALTH, serverId, configId),
    testConnection: (
      serverId: string,
      configId?: string,
    ): Promise<McpServerTestConnectionResult> =>
      ipcRenderer.invoke(
        MCP_SERVER_CHANNELS.TEST_CONNECTION,
        serverId,
        configId,
      ),
    listDetected: (
      request: ListDetectedMcpServersRequest,
    ): Promise<ListDetectedMcpServersResponse> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.LIST_DETECTED, request),
    cancelOAuthLogin: (flowId: string): Promise<void> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.CANCEL_OAUTH_LOGIN, flowId),
    startOAuthLogin: (
      request: StartMcpOAuthLoginRequest,
    ): Promise<StartMcpOAuthLoginResponse> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.START_OAUTH_LOGIN, request),
    clearOAuthToken: (request: ClearMcpOAuthTokenRequest): Promise<void> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.CLEAR_OAUTH_TOKEN, request),
    getProxyState: (): Promise<McpProxyState> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.GET_PROXY_STATE),
    applyProxyPort: (port: number): Promise<McpProxyState> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.APPLY_PROXY_PORT, port),
    onAuthChanged: (callback: () => void): (() => void) => {
      const listener = (): void => callback();
      ipcRenderer.on(MCP_SERVER_CHANNELS.AUTH_CHANGED, listener);
      return (): void => {
        ipcRenderer.removeListener(MCP_SERVER_CHANNELS.AUTH_CHANGED, listener);
      };
    },
    onProxyStatus: (callback: (state: McpProxyState) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, state: McpProxyState): void =>
        callback(state);
      ipcRenderer.on(MCP_SERVER_CHANNELS.PROXY_STATUS, listener);
      return (): void => {
        ipcRenderer.removeListener(MCP_SERVER_CHANNELS.PROXY_STATUS, listener);
      };
    },
    listProviderConnectors: (): Promise<ProviderConnectorListResult[]> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.LIST_PROVIDER_CONNECTORS),
    openProviderConnectorSettings: (request: {
      provider: ProviderConnectorProvider;
      installUrl?: string;
    }): Promise<void> =>
      ipcRenderer.invoke(
        MCP_SERVER_CHANNELS.OPEN_PROVIDER_CONNECTOR_SETTINGS,
        request,
      ),
    listCurated: (): Promise<CuratedMcpServerListResponse> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.LIST_CURATED),
    refreshCurated: (): Promise<CuratedMcpServerListResponse> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.REFRESH_CURATED),
    // `enhanced`: the caller shows New Customize; main still requires the
    // experiment on before it uses that resolution. Older hosts ignore it.
    resolveRemoteImage: (
      url: string,
      options?: { readonly enhanced?: boolean },
    ): Promise<string | null> =>
      ipcRenderer.invoke(
        MCP_SERVER_CHANNELS.RESOLVE_REMOTE_IMAGE,
        url,
        options,
      ),
    listStatus: (): Promise<McpServerStatusEntry[]> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.LIST_STATUS),
    getTools: (
      serverId: string,
      configId?: string,
    ): Promise<McpServerToolsCacheEntry | null> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.GET_TOOLS, serverId, configId),
    installForHarnesses: (request): Promise<McpServerHarnessInstalls | null> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.INSTALL_FOR_HARNESSES, request),
    retryHarnessInstall: (request): Promise<McpServerHarnessInstalls> =>
      ipcRenderer.invoke(MCP_SERVER_CHANNELS.RETRY_HARNESS_INSTALL, request),
  };
}
