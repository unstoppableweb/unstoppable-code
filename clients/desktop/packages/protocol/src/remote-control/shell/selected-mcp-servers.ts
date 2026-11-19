/**
 * The one definition of which MCP servers a chat's plugin selection uses
 * (REG-3030): the servers it selects directly, plus the account servers each
 * selected plugin brings. Pure and browser-safe, so the New Task sign-in
 * strip, the Activity rail's MCP Servers card, the Plugins picker's sign-in
 * on add, and the web's server-side warnings and pre-turn reconcile all read
 * the same list.
 *
 * A plugin's servers come from its catalog entry's `mcpServerRefs`, which the
 * cloud catalog fills for every curated plugin whatever the state of its
 * member inventory. A marketplace plugin's own `.mcp.json` servers are not
 * account servers, so its entry names none and it adds nothing here.
 */
import type {
  RemoteControlChatTabPluginSelections,
  RemoteControlPluginCatalogUnifiedEntry,
} from './index';

/** How a chat came to use an MCP server. */
export type SelectedMcpServerVia =
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'plugin';
      readonly marketplaceId: string;
      readonly pluginName: string;
      /** The plugin's catalog name, for "from the {plugin} plugin". */
      readonly pluginDisplayName: string;
    };

/** One MCP server a selection uses, once per server and configuration. */
export interface SelectedMcpServer {
  readonly serverId: string;
  readonly configId: string;
  readonly via: SelectedMcpServerVia;
}

/** The catalog fields the resolver reads from each entry. */
export type SelectedMcpServerCatalogEntry = Pick<
  RemoteControlPluginCatalogUnifiedEntry,
  'name' | 'selectionRef' | 'mcpServerRefs'
>;

/** The part of a catalog the resolver reads. */
export interface SelectedMcpServerCatalog {
  readonly entries?: readonly SelectedMcpServerCatalogEntry[];
}

/** `serverId/configId`, the key MCP rows and picker selections use. */
export function selectedMcpServerKey(
  server: Pick<SelectedMcpServer, 'serverId' | 'configId'>,
): string {
  return `${server.serverId}/${server.configId}`;
}

function pluginKey(marketplaceId: string, pluginName: string): string {
  return JSON.stringify([marketplaceId, pluginName]);
}

/**
 * The MCP servers `selections` uses, in order: direct selections first, in
 * selection order, then each selected plugin's servers, in plugin selection
 * order and the plugin's own order. A server named more than once is listed
 * once, as the first of those: a direct selection wins over a plugin.
 * Without a catalog only the direct selections resolve; a selected plugin
 * the catalog does not list adds nothing.
 */
export function resolveSelectedMcpServers(
  selections:
    | Pick<RemoteControlChatTabPluginSelections, 'pluginRefs' | 'mcpServerRefs'>
    | null
    | undefined,
  catalog: SelectedMcpServerCatalog | null | undefined,
): SelectedMcpServer[] {
  if (!selections) return [];
  const resolved: SelectedMcpServer[] = [];
  const seen = new Set<string>();
  const add = (server: SelectedMcpServer): void => {
    const key = selectedMcpServerKey(server);
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push(server);
  };
  for (const ref of selections.mcpServerRefs ?? [])
    add({
      serverId: ref.serverId,
      configId: ref.configId,
      via: { kind: 'direct' },
    });
  if (selections.pluginRefs.length === 0) return resolved;
  const plugins = new Map<string, SelectedMcpServerCatalogEntry>();
  for (const entry of catalog?.entries ?? []) {
    const ref = entry.selectionRef;
    if (ref.type !== 'marketplace-plugin') continue;
    const key = pluginKey(ref.marketplaceId, ref.pluginName);
    if (!plugins.has(key)) plugins.set(key, entry);
  }
  for (const ref of selections.pluginRefs) {
    const entry = plugins.get(pluginKey(ref.marketplaceId, ref.pluginName));
    for (const server of entry?.mcpServerRefs ?? [])
      add({
        serverId: server.serverId,
        configId: server.configId,
        via: {
          kind: 'plugin',
          marketplaceId: ref.marketplaceId,
          pluginName: ref.pluginName,
          pluginDisplayName: entry?.name ?? ref.pluginName,
        },
      });
  }
  return resolved;
}

/**
 * The servers `next` uses that `previous` did not, in `next`'s order: what a
 * picker save or a Getting started row just attached.
 */
export function addedSelectedMcpServers(
  previous:
    | Pick<RemoteControlChatTabPluginSelections, 'pluginRefs' | 'mcpServerRefs'>
    | null
    | undefined,
  next:
    | Pick<RemoteControlChatTabPluginSelections, 'pluginRefs' | 'mcpServerRefs'>
    | null
    | undefined,
  catalog: SelectedMcpServerCatalog | null | undefined,
): SelectedMcpServer[] {
  const before = new Set(
    resolveSelectedMcpServers(previous, catalog).map(selectedMcpServerKey),
  );
  return resolveSelectedMcpServers(next, catalog).filter(
    (server) => !before.has(selectedMcpServerKey(server)),
  );
}
