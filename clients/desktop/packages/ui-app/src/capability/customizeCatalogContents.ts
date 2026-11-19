import type { PluginContentsRow } from '@canopy/ui-shared/components';
import type { PluginManifestPreview } from '@canopy/protocol/plugins';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';

/**
 * A plugin's Contents before it is added, by name: the skills and MCP
 * servers its own listing names, or an installed copy in its group does
 * (another marketplace's copy of the same plugin), then what a light
 * preview of its repository names. Kinds nothing names are left to the
 * listing's counts.
 */
export function customizeCatalogContents(
  entry: UnifiedPluginEntry,
  /** A light preview's names, read from the repository's listing. */
  preview?: PluginManifestPreview,
): PluginContentsRow[] {
  const sources = [
    entry,
    // Installed, or installed and waiting on a sign-in.
    ...(entry.marketplaceListings ?? []).filter(
      (listing) =>
        listing.state === 'installed' || listing.state === 'needs-auth',
    ),
  ];
  const rows = new Map<string, PluginContentsRow>();
  for (const source of sources) {
    // A name read from an installed copy's files is replay-blocked.
    const fromCopy = source !== entry;
    const privacy = fromCopy ? { replayBlockName: true } : {};
    for (const name of source.bundledSkillNames ?? []) {
      const key = `skill:${name.toLowerCase()}`;
      if (!rows.has(key))
        rows.set(key, { key, type: 'Skill', name, ...privacy });
    }
    for (const server of source.bundledServers ?? []) {
      const key = `mcp:${server.key.toLowerCase()}`;
      if (!rows.has(key))
        rows.set(key, {
          key,
          type: 'MCP server',
          name: server.name,
          ...privacy,
        });
    }
  }
  if (preview) {
    // File names from the repository's listing: replay-blocked.
    const add = (type: string, name: string): void => {
      const key = `${type.toLowerCase()}:${name.toLowerCase()}`;
      if (!rows.has(key))
        rows.set(key, { key, type, name, replayBlockName: true });
    };
    for (const name of preview.skills) add('Skill', name);
    for (const name of preview.commands) add('Command', name);
    for (const name of preview.agents) add('Agent', name);
    if (preview.hooks) add('Hook', 'Hooks');
    // An MCP server already named by the listing or a copy stays as it is.
    const servers = new Set(
      [...rows.values()]
        .filter((row) => row.type === 'MCP server')
        .map((row) => row.name.toLowerCase()),
    );
    for (const name of preview.mcpServerNames)
      if (!servers.has(name.toLowerCase())) add('MCP server', name);
    if (preview.mcpServers && preview.mcpServerNames.length === 0)
      add('MCP server', 'MCP servers');
  }
  return [...rows.values()];
}
