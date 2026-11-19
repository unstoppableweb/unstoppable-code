import { requestMcpRemovalRepair } from '@canopy/ui-app/capability';
import type {
  AccountMcpConnection,
  AccountMcpConnectionSummary,
  McpServerDataView,
  McpServerConfigView,
  McpServerIndexEntry,
  SaveMcpServerRequest,
  RewriteMcpServerRefsRequest,
} from '@canopy/execution-engine/types/mcp-servers';
import { AccountMcpConnectionError } from '@canopy/execution-engine/types/mcp-servers';
import {
  isStoredSecretValue,
  type SecretValueInput,
} from '@canopy/execution-engine/types/stored-secrets';
import {
  MAX_MCP_EXTRA_HEADERS,
  mcpExtraHeadersProblem,
} from '@canopy/protocol/mcp-servers';
import { isLoopbackMcpHost } from '@canopy/ui-app/capability';
import { pointRefsAt } from '@/lib/mcpServerRefs';
import { useGitHubStore } from '@/stores/githubStore';
import type { AccountMcpActions } from '@/hooks/useAccountMcpActions';

export function getDefaultConfigId(configs: McpServerConfigView[]): string {
  return configs.find((config) => config.enabled)?.id ?? configs[0]?.id ?? '';
}

// START_ACCOUNT refuses longer display names, so every send is capped to it.
export const CLOUD_DISPLAY_NAME_MAX = 120;
export const CLOUD_LOOPBACK_UNSUPPORTED =
  "Desktop only. Local addresses can't be reached from the cloud.";
export const CLOUD_HTTPS_REQUIRED =
  'Use an HTTPS URL to add this server to your cloud account.';
export const CLOUD_SIGN_IN_REQUIRED =
  'Sign in to add this server to your cloud account.';
export const CLOUD_CONNECT_FAILED =
  'Could not add this server to your cloud account. Try again.';
// A move carries one configuration into one cloud connection, so references
// to any other configuration would silently lose its settings.
export const CLOUD_SINGLE_CONFIG_REQUIRED =
  'This server has more than one configuration. Only single-configuration servers can move to your cloud account.';
// The cloud only accepts a supplied OAuth client for catalog issuers, so a
// custom server that can't register one needs an access token instead.
export const CLOUD_REGISTRATION_UNAVAILABLE =
  "This server doesn't support automatic client registration. Connect it with an access token instead.";

/**
 * The headers a cloud connection stores: the server's headers with the
 * default config's extra headers winning by case-insensitive name, as the
 * local proxy merges them.
 */
export function cloudMcpHeaders(
  headers: Record<string, SecretValueInput> | undefined,
  configs: McpServerConfigView[],
): Record<string, SecretValueInput> {
  const extra =
    configs.find((config) => config.id === getDefaultConfigId(configs))
      ?.extraHeaders ?? {};
  const overridden = new Set(
    Object.keys(extra).map((name): string => name.toLowerCase()),
  );
  return {
    ...Object.fromEntries(
      Object.entries(headers ?? {}).filter(
        ([name]): boolean => !overridden.has(name.toLowerCase()),
      ),
    ),
    ...extra,
  };
}

/** Why the cloud can't store these headers, naming the header at fault. */
export function cloudHeadersProblem(
  headers: Record<string, SecretValueInput>,
): string | undefined {
  // A saved value was checked when it was stored and main checks it again
  // once resolved; here only its name is judged.
  const problem = mcpExtraHeadersProblem(
    Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        isStoredSecretValue(value) ? 'saved' : value,
      ]),
    ),
  );
  if (!problem) return undefined;
  const stays = 'so this server stays on this device.';
  switch (problem.kind) {
    case 'blocked_name':
      return `The cloud sets ${problem.header} itself, ${stays}`;
    case 'too_many':
    case 'not_object':
      return `The cloud stores up to ${String(MAX_MCP_EXTRA_HEADERS)} headers, ${stays}`;
    default:
      return `The cloud can't store the ${problem.header || 'unnamed'} header, ${stays}`;
  }
}

/** Why a URL can't back a cloud connection; unparseable input is not judged. */
export function cloudUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (isLoopbackMcpHost(parsed.hostname)) return CLOUD_LOOPBACK_UNSUPPORTED;
  return parsed.protocol === 'https:' ? undefined : CLOUD_HTTPS_REQUIRED;
}

export function isCloudReadyUrl(url: string): boolean {
  try {
    new URL(url.trim());
  } catch {
    return false;
  }
  return cloudUrlProblem(url) === undefined;
}

export function defaultConfigAuthToken(
  configs: McpServerConfigView[],
): SecretValueInput | undefined {
  const token = configs.find(
    (config) => config.id === getDefaultConfigId(configs),
  )?.authToken;
  if (token === undefined || isStoredSecretValue(token)) return token;
  return token.trim() ? token : undefined;
}

/** Whether a cloud request keeps any device secret by reference. */
export function keepsStoredSecrets(
  values: ReadonlyArray<SecretValueInput | null | undefined>,
): boolean {
  return values.some((value) => isStoredSecretValue(value));
}

/**
 * Copies a device HTTP server to the signed-in cloud account (CAN-6176
 * PR 4b) through `core.integration.mcpAccount.connect`. The renderer names
 * the secret slots the person ticked; main resolves their values from the
 * server's own store and sends them only to the server's own origin.
 */
export async function copyMcpServerToCloud(input: {
  readonly serverId: string;
  readonly url: string;
  readonly displayName: string;
  readonly configId: string;
  readonly secretSlots: readonly string[];
  readonly expectedAccountId: string;
}): Promise<void> {
  const reply = await window.canopyCore.invoke({
    kind: 'request',
    method: 'core.integration.mcpAccount.connect',
    params: {
      customUrl: input.url,
      displayName: input.displayName.trim().slice(0, 120),
      configId: input.configId,
      fromDeviceServer: {
        serverId: input.serverId,
        configId: input.configId,
        secretSlots: [...input.secretSlots],
      },
      expectedAccountId: input.expectedAccountId,
      _meta: { idempotencyKey: crypto.randomUUID() },
    },
  });
  if (!reply.ok) throw new Error(reply.error.message);
}

export async function loadSignedInAccountId(): Promise<string | undefined> {
  try {
    return (await window.api?.loadCanopyCloudAccount?.())?.account?.id;
  } catch {
    return undefined;
  }
}

/** Configs without their plaintext tokens; a cloud server keeps its own. */
export function withoutAuthTokens(
  configs: McpServerConfigView[],
): McpServerConfigView[] {
  return configs.map((config): McpServerConfigView => {
    const next = { ...config };
    delete next.authToken;
    return next;
  });
}

export function sameHeaders(
  left: Record<string, SecretValueInput>,
  right: Record<string, SecretValueInput>,
): boolean {
  const entries = (headers: Record<string, SecretValueInput>): string =>
    JSON.stringify(
      Object.entries(headers).sort(([a], [b]): number => a.localeCompare(b)),
    );
  return entries(left) === entries(right);
}

// A device server's own sign-ins stop mattering once the cloud owns it.
export async function clearDeviceSignIns(
  server: McpServerDataView,
): Promise<void> {
  await Promise.all(
    server.configs.map(async (config): Promise<void> => {
      try {
        await window.mcpServers.clearOAuthToken({
          serverId: server.definition.id,
          configId: config.id,
        });
      } catch {
        // A stale local sign-in is unused once the cloud owns the server.
      }
    }),
  );
}

/** Every ref form a cloud connection is saved under on this device. */
export function accountConnectionRefs(
  connection: Pick<AccountMcpConnection, 'id' | 'serverKey' | 'configId'>,
): RewriteMcpServerRefsRequest['from'] {
  return [
    { serverId: connection.serverKey, configId: connection.configId },
    { serverId: `account:${connection.id}`, configId: connection.configId },
  ];
}

export const MOVED_REMOVE_FAILED =
  "Moved to this device, but couldn't remove it from your cloud account. Delete it from the list.";
// An older cloud answers a removal by only signing the server out.
export const MOVED_REMOVE_UNSUPPORTED =
  "Moved to this device, but your cloud account can't remove servers yet. Delete it from the list after it updates.";
export const DELETE_REMOVE_UNSUPPORTED =
  "Your cloud account can't remove servers yet, so it was only signed out. Try again after it updates.";
export const DELETED_HERE_REMOVE_FAILED =
  "Deleted from this device, but couldn't remove it from your cloud account. Delete it from the list to try again.";
export const DELETED_HERE_REMOVE_UNSUPPORTED =
  "Deleted from this device. It's still in your cloud account, which can't remove servers yet. Delete it from the list after your cloud account updates.";

/** Shared by the legacy row and Marketplace detail; the captured account owns credentials. */
export async function promoteCustomMcpServer(
  row: McpServerIndexEntry,
  credential: { bearerToken?: SecretValueInput; expectedAccountId: string },
  accountActions: AccountMcpActions,
  onOAuthClientRequired: () => void,
): Promise<void> {
  let server: McpServerDataView;
  try {
    server = (await window.mcpServers.loadServer(row.id)).server;
  } catch {
    throw new Error(CLOUD_CONNECT_FAILED);
  }
  const definition = server.definition;
  if (
    definition.type !== 'http' ||
    !definition.url ||
    definition.curated?.key ||
    definition.httpAuthHandler === 'provider'
  ) {
    throw new Error(CLOUD_CONNECT_FAILED);
  }
  // The URL may have changed since the row was indexed.
  if (!isCloudReadyUrl(definition.url)) {
    throw new Error(cloudUrlProblem(definition.url) ?? CLOUD_HTTPS_REQUIRED);
  }
  // Configurations may have been added since the row was indexed.
  if (server.configs.length > 1) {
    throw new Error(CLOUD_SINGLE_CONFIG_REQUIRED);
  }
  const headers = cloudMcpHeaders(definition.headers, server.configs);
  const headersProblem = cloudHeadersProblem(headers);
  if (headersProblem) {
    throw new Error(headersProblem);
  }
  const { bearerToken, expectedAccountId } = credential;
  let bound = false;
  let cancelled = false;
  await accountActions.connect(undefined, 'default', {
    errorOperation: 'promote',
    customUrl: definition.url,
    displayName: definition.name.trim().slice(0, CLOUD_DISPLAY_NAME_MAX),
    pendingKey: row.id,
    expectedAccountId,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(bearerToken ? { bearerToken } : {}),
    // Saved headers and tokens reach the cloud by reference; main resolves
    // them against this server and its own URL only.
    ...(keepsStoredSecrets([...Object.values(headers), bearerToken])
      ? { secretSource: { serverId: row.id } }
      : {}),
    // The cloud can't register an OAuth client for this server and never
    // takes a user-supplied one for a custom URL; an access token still works.
    onOAuthClientRequired: (): void => onOAuthClientRequired(),
    onStarted: async (connection): Promise<void> => {
      // The device token stays until the cloud connects: a cancelled move
      // restores this server by reference, and the reference needs it.
      await window.mcpServers.saveServer({
        ...server,
        definition: {
          ...definition,
          httpAuthHandler: 'account',
          updatedAt: new Date().toISOString(),
        },
        accountConnectionId: connection.id,
      });
      bound = true;
      // The bound copy still routes through the cloud, so a reference the
      // rewrite misses keeps working on this device.
      await pointRefsAt(
        [{ serverId: row.id, configId: getDefaultConfigId(server.configs) }],
        { serverId: connection.serverKey, configId: connection.configId },
      ).catch((): void => undefined);
    },
    // A browser sign-in can take a while; drop the token from the server as
    // it is now, so edits saved meanwhile stay.
    onConnected: async (connection): Promise<void> => {
      const current = (await window.mcpServers.loadServer(row.id)).server;
      await window.mcpServers.saveServer({
        ...current,
        configs: withoutAuthTokens(current.configs),
        accountConnectionId: connection.id,
      });
    },
    // A cancelled promotion puts the row back on this device exactly as it
    // was, keeping the handler the index held for it before.
    onCancelled: async (connection): Promise<void> => {
      cancelled = true;
      await window.mcpServers.saveServer({
        ...server,
        definition: {
          ...definition,
          ...(!definition.httpAuthHandler && row.authHandler
            ? { httpAuthHandler: row.authHandler }
            : {}),
        },
        accountRouting: 'clear',
      });
      await pointRefsAt(accountConnectionRefs(connection), {
        serverId: row.id,
        configId: getDefaultConfigId(server.configs),
      }).catch((): void => undefined);
    },
  });
  // Its own sign-ins go once the move sticks.
  if (bound && !cancelled) await clearDeviceSignIns(server);
}

/** Revalidate the account captured before opening a cloud operation. */
export async function requireCapturedMcpAccount(
  expectedAccountId: string,
): Promise<void> {
  if ((await loadSignedInAccountId()) !== expectedAccountId) {
    throw new AccountMcpConnectionError('account-changed');
  }
}

/** Existing deletion order and partial-cloud-removal notices, shared by both entry points. */
export async function deleteDesktopMcpTarget({
  serverId,
  connection,
  expectedAccountId,
}: {
  serverId?: string;
  connection?: AccountMcpConnectionSummary;
  expectedAccountId?: string;
}): Promise<void> {
  if (!serverId && !connection)
    throw new Error('This server is no longer available.');
  if (connection && expectedAccountId)
    await requireCapturedMcpAccount(expectedAccountId);
  if (serverId) {
    try {
      await window.mcpServers.deleteServer(serverId);
    } catch (error) {
      requestMcpRemovalRepair(serverId);
      throw error;
    }
  }
  if (!connection) return;
  if (!serverId) {
    const { removed } = await window.mcpServers.removeAccountConnection(
      connection.id,
    );
    if (!removed) throw new Error(DELETE_REMOVE_UNSUPPORTED);
    return;
  }
  try {
    if (expectedAccountId) await requireCapturedMcpAccount(expectedAccountId);
    const { removed } = await window.mcpServers.removeAccountConnection(
      connection.id,
    );
    if (!removed)
      useGitHubStore
        .getState()
        .addToast(DELETED_HERE_REMOVE_UNSUPPORTED, 'error');
  } catch (error) {
    useGitHubStore
      .getState()
      .addToast(DELETED_HERE_REMOVE_FAILED, 'error', undefined, {
        caught: error,
      });
  }
}

/** Save destination, rewrite references, then remove source; retain partial-success notices. */
export async function moveDesktopMcpTarget({
  data,
  connection,
  expectedAccountId,
}: {
  data: SaveMcpServerRequest;
  connection: AccountMcpConnectionSummary;
  expectedAccountId?: string;
}): Promise<void> {
  if (expectedAccountId) await requireCapturedMcpAccount(expectedAccountId);
  await window.mcpServers.saveServer(data);
  await pointRefsAt(accountConnectionRefs(connection), {
    serverId: data.definition.id,
    configId: getDefaultConfigId(data.configs),
  });
  try {
    if (expectedAccountId) await requireCapturedMcpAccount(expectedAccountId);
    const { removed } = await window.mcpServers.removeAccountConnection(
      connection.id,
    );
    if (!removed)
      useGitHubStore.getState().addToast(MOVED_REMOVE_UNSUPPORTED, 'error');
  } catch (error) {
    useGitHubStore
      .getState()
      .addToast(MOVED_REMOVE_FAILED, 'error', undefined, { caught: error });
  }
}
