import type {
  McpAccountConnectParams,
  McpAccountConnectResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import { connectMcpAccount, type CopyToCloudDeps } from '../mcp/copy-to-cloud';
import type { DesktopDomainAdapter } from './desktop-runtime';

/**
 * What a keyed retry is compared on: the request with every secret value
 * left out, so no secret, nor a hash of one, is kept for replay (D33).
 */
function fingerprintParams(params: McpAccountConnectParams): unknown {
  const { _meta, headers, bearerToken, oauthClient, ...rest } = params;
  void _meta;
  return {
    ...rest,
    headerNames: headers === undefined ? null : Object.keys(headers).sort(),
    bearerToken: bearerToken !== undefined,
    oauthClient:
      oauthClient === undefined
        ? null
        : {
            clientId: oauthClient.clientId,
            clientSecret: oauthClient.clientSecret !== undefined,
          },
  };
}

const defaultDeps: CopyToCloudDeps = {
  accountEnabled: () => false,
  readServer: async (serverId) =>
    (await import('../ipc/mcp-servers')).readMcpServerForCloudCopy(serverId),
  start: async (request) =>
    (await import('../canopy-cloud/mcp-connections')).startAccountMcpConnection(
      request,
    ),
  curatedServer: async (serverKey) => {
    const { readCachedCuratedMcpServers } =
      await import('../mcp/curated-catalog');
    const entry = (await readCachedCuratedMcpServers())?.servers.find(
      (server) => server.key === serverKey,
    );
    return entry === undefined
      ? null
      : {
          name: entry.name,
          url: entry.url,
          urlOptions: (entry.urlOptions ?? []).map((option) => option.url),
          ...(entry.oauthHints?.tokenUrl === undefined
            ? {}
            : { tokenUrl: entry.oauthHints.tokenUrl }),
        };
  },
  confirmSecretsLeave: async (request) => {
    const [{ confirmSecretsLeave }, { dialog }, { getMainWindow }, cloud] =
      await Promise.all([
        import('../mcp/confirm-secrets-leave'),
        import('electron'),
        import('../lib/main-window-focus'),
        import('../canopy-cloud/client'),
      ]);
    return confirmSecretsLeave(request, {
      mainWindow: getMainWindow,
      account: async () => {
        const { account } = await cloud.resolveCanopyCloudCredentialContext();
        const label = account?.email ?? account?.name;
        return account?.id && label ? { id: account.id, label } : null;
      },
      showMessageBox: (window, options) =>
        dialog.showMessageBox(window, options),
    });
  },
};

/**
 * `core.integration.mcpAccount.connect` on the desktop dispatcher (CAN-6176
 * PR 4a). A repeat with the same caller, key and parameters returns the first
 * outcome without connecting again, while this process runs; other
 * parameters under that key are `conflict`.
 */
export function createCoreMcpAccountAdapter(
  deps: Partial<CopyToCloudDeps> & { accountEnabled: () => boolean },
): DesktopDomainAdapter {
  const resolved: CopyToCloudDeps = { ...defaultDeps, ...deps };
  const outcomes = new KeyedOutcomes<McpAccountConnectResult>({
    reusedError: (): CanopyOperationError =>
      new CanopyOperationError({
        kind: 'conflict',
        message: 'This request key was already used for another connection.',
        retry: { kind: 'never' },
      }),
  });
  return {
    instructions: {
      'core.integration.mcpAccount.connect': (params, context) =>
        outcomes.run(context, fingerprintParams(params), () =>
          connectMcpAccount(resolved, params),
        ),
    },
  };
}
