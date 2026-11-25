/**
 * Installed-item status and plugin installs over the portable adapter
 * (CAN-7442). Every reply is parsed strictly: a wrong shape is a
 * {@link RemoteIpcMalformedReplyError}. A computer on an older release
 * refuses these channels with `remote_channel_unavailable`; that becomes a
 * {@link RemoteHostOutdatedError} the UI can tell apart from a refusal.
 */
import type { CommandMap, QueryMap } from '@canopy/app-core';
import { extractIpcErrorMessage } from '@canopy/protocol/app-errors/ipc-rejection';
import {
  InstalledItemMutationResultSchema,
  InstalledItemSnapshotSchema,
} from '@canopy/protocol/installed-items';
import {
  CLAUDE_FACET_UNAVAILABLE_MESSAGE,
  CODEX_FACET_UNAVAILABLE_MESSAGE,
  REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE,
  RemoteBuiltInPluginInstallResultSchema,
  RemotePluginInstallResultSchema,
} from '@canopy/protocol/plugins/remote-install';
import { isChannelUnavailableRejection } from '@canopy/protocol/remote-control';
import {
  REMOTE_IPC_CHANNELS as C,
  type RemoteIpcChannel,
} from '@canopy/protocol/remote-control/channels';
import {
  RemoteIpcMalformedReplyError,
  type ChannelClient,
} from './channel-client';
import { anyReply } from './decoders';

export const REMOTE_HOST_OUTDATED_CODE = 'remote_host_outdated';

/**
 * The computer runs a release without this operation; updating it is the
 * only fix. Nothing ran on the computer.
 */
export class RemoteHostOutdatedError extends Error {
  readonly code = REMOTE_HOST_OUTDATED_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'RemoteHostOutdatedError';
  }
}

export const INSTALLED_ITEM_STATUS_HOST_OUTDATED =
  'Update the desktop app to see installed items from here.';
export const INSTALLED_ITEM_CHANGE_HOST_OUTDATED =
  'Update the desktop app to change installed items from here.';
export const PLUGIN_INSTALL_HOST_OUTDATED =
  'Update the desktop app to install plugins from here.';

async function invokeRaw(
  channels: ChannelClient,
  channel: RemoteIpcChannel,
  outdated: string,
  args: readonly unknown[],
  installRefreshToken?: string,
): Promise<unknown> {
  try {
    if (channel === C.pluginsInstallPlugin && installRefreshToken !== undefined)
      return await channels.invokeWithInstallRefreshToken(
        channel,
        args,
        installRefreshToken,
      );
    return await channels.invoke(channel, anyReply<unknown>(), ...args);
  } catch (error) {
    if (isChannelUnavailableRejection(error, channel))
      throw new RemoteHostOutdatedError(outdated);
    throw new Error(extractIpcErrorMessage(error));
  }
}

async function readInstalledItems(
  channels: ChannelClient,
): Promise<QueryMap['installedItems.listStatus']['result']> {
  const parsed = InstalledItemSnapshotSchema.safeParse(
    await invokeRaw(
      channels,
      C.installedItemsListStatus,
      INSTALLED_ITEM_STATUS_HOST_OUTDATED,
      [],
    ),
  );
  if (!parsed.success)
    throw new RemoteIpcMalformedReplyError(C.installedItemsListStatus);
  return parsed.data;
}

async function changeInstalledItem(
  channels: ChannelClient,
  channel: RemoteIpcChannel,
  request: unknown,
): Promise<CommandMap['installedItems.setStatus']['result']> {
  const parsed = InstalledItemMutationResultSchema.safeParse(
    await invokeRaw(channels, channel, INSTALLED_ITEM_CHANGE_HOST_OUTDATED, [
      request,
    ]),
  );
  if (!parsed.success) throw new RemoteIpcMalformedReplyError(channel);
  return parsed.data;
}

async function installPlugin(
  channels: ChannelClient,
  args: CommandMap['plugins.install']['args'],
): Promise<CommandMap['plugins.install']['result']> {
  // The empty source URL asks the computer for the source it has stored; a
  // browser never names one, and the computer refuses any other URL from it.
  const parsed = RemotePluginInstallResultSchema.safeParse(
    await invokeRaw(
      channels,
      C.pluginsInstallPlugin,
      PLUGIN_INSTALL_HOST_OUTDATED,
      [args.marketplaceId, args.pluginName, ''],
      args.installRefreshToken,
    ),
  );
  if (!parsed.success)
    throw new RemoteIpcMalformedReplyError(C.pluginsInstallPlugin);
  const result = parsed.data;
  if (!result.success)
    throw new Error(result.error ?? REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE);
  if (result.data === undefined)
    throw new RemoteIpcMalformedReplyError(C.pluginsInstallPlugin);
  return result.data;
}

/** A provider's answer when the plugin has nothing for it to install. */
const FACET_UNAVAILABLE: ReadonlySet<string> = new Set([
  CLAUDE_FACET_UNAVAILABLE_MESSAGE,
  CODEX_FACET_UNAVAILABLE_MESSAGE,
]);

async function installBuiltInPlugin(
  channels: ChannelClient,
  args: CommandMap['plugins.installBuiltIn']['args'],
): Promise<CommandMap['plugins.installBuiltIn']['result']> {
  const parsed = RemoteBuiltInPluginInstallResultSchema.safeParse(
    await invokeRaw(
      channels,
      C.pluginsInstallBuiltInPlugin,
      PLUGIN_INSTALL_HOST_OUTDATED,
      [
        {
          marketplaceId: args.marketplaceId,
          pluginName: args.pluginName,
          providers: [...new Set(args.providers)],
        },
      ],
    ),
  );
  if (!parsed.success)
    throw new RemoteIpcMalformedReplyError(C.pluginsInstallBuiltInPlugin);
  const result = parsed.data;
  // A success the computer's projection couldn't describe: the plugin may be
  // installed, so the outcome is unknown, as for a single-plugin install.
  if (result.success && result.data === undefined)
    throw new RemoteIpcMalformedReplyError(C.pluginsInstallBuiltInPlugin);
  const outcomes = result.data?.providerOutcomes ?? {};
  // `success` is true when any provider installed. When none did, the first
  // requested provider's error explains it better than the joined summary,
  // preferring a real failure over a provider the plugin has no facet for.
  if (!result.success || result.data === undefined) {
    const providerErrors = args.providers.flatMap((provider) => {
      const error = outcomes[provider]?.error;
      return error === undefined ? [] : [error];
    });
    const providerError =
      providerErrors.find((error) => !FACET_UNAVAILABLE.has(error)) ??
      providerErrors[0];
    throw new Error(
      providerError ?? result.error ?? REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE,
    );
  }
  return { plugin: result.data.plugin, providerOutcomes: outcomes };
}

export function createMarketplaceMutationQueries(channels: ChannelClient): {
  'installedItems.listStatus': () => Promise<
    QueryMap['installedItems.listStatus']['result']
  >;
} {
  return {
    'installedItems.listStatus': () => readInstalledItems(channels),
  };
}

export function createMarketplaceMutationCommands(channels: ChannelClient): {
  [K in
    | 'installedItems.setStatus'
    | 'installedItems.uninstall'
    | 'plugins.install'
    | 'plugins.installBuiltIn']: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
} {
  return {
    'installedItems.setStatus': (args) =>
      changeInstalledItem(channels, C.installedItemsSetStatus, {
        target: args.target,
        status: args.status,
      }),
    'installedItems.uninstall': (args) =>
      changeInstalledItem(channels, C.installedItemsUninstall, {
        target: args.target,
      }),
    'plugins.install': (args) => installPlugin(channels, args),
    'plugins.installBuiltIn': (args) => installBuiltInPlugin(channels, args),
  };
}
