import { existsSync } from 'node:fs';
import type {
  CatalogHarnessId,
  CatalogPluginHarness,
  CatalogPluginHarnesses,
} from '@canopy/protocol/canopy-core';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import {
  cursorPluginFacetProvider,
  cursorPluginFacetSupport,
  cursorLoadsPluginMemberKind,
} from '@canopy/plugin-interop/cursor-support';
import {
  discoverCursorPluginMembers,
  loadPluginManifest,
  readPluginMcpConfigObjects,
  resolvePluginInfoPath,
} from './plugin-resolver';

/*
 * What each agent harness gets from one installed marketplace plugin
 * (CAN-6034): support, the installed-facet check and members. The catalog
 * snapshot carries these facts; the deferred-tools search projects them.
 */

type PluginMember = CatalogPluginHarness['members'][number];

/** Whether `provider` can load the plugin's content at all. */
function providerAllowsPluginSupport(
  plugin: PluginInfo,
  provider: CatalogHarnessId,
): boolean {
  // OpenCode uses the same projected facet/member contract as Cursor.
  if (provider === 'opencode') {
    return cursorPluginFacetSupport(plugin.facets).supported;
  }
  if (provider === 'codex') {
    return plugin.providerSupport.codex !== 'none';
  }
  return plugin.providerSupport.claude === 'native';
}

/** Whether the content `provider` loads is installed on this computer. */
function providerHasInstalledPluginFacet(
  plugin: PluginInfo,
  provider: CatalogHarnessId,
): boolean {
  if (
    provider !== 'opencode' &&
    plugin.cachePath &&
    existsSync(plugin.cachePath)
  ) {
    return true;
  }
  const facets =
    provider === 'opencode'
      ? [plugin.facets[cursorPluginFacetProvider(plugin.facets)]]
      : provider === 'codex'
        ? plugin.providerSupport.codex === 'native'
          ? [plugin.facets.codex]
          : [plugin.facets.codexCompatibility, plugin.facets.claude]
        : [plugin.facets.claude];
  return facets.some(
    (facet) =>
      facet !== undefined &&
      ((facet.cachePath !== undefined && existsSync(facet.cachePath)) ||
        (facet.installLocation.length > 0 &&
          existsSync(facet.installLocation))),
  );
}

/** The skills and commands `provider` sees in the plugin's facet details. */
function pluginMembersForProvider(
  plugin: PluginInfo,
  provider: CatalogHarnessId,
): PluginMember[] {
  const details =
    provider === 'opencode'
      ? plugin.facets[cursorPluginFacetProvider(plugin.facets)]?.details
      : provider === 'codex'
        ? (plugin.facets.codex?.details ??
          plugin.facets.codexCompatibility?.details ??
          plugin.details)
        : (plugin.facets.claude?.details ?? plugin.details);
  if (!details) return [];

  const members: PluginMember[] = [];
  const seen = new Set<string>();
  for (const member of details.skills) {
    const key = `skill\0${member.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({
      kind: 'skill',
      name: member.name,
      description: member.description,
    });
  }
  const commands =
    provider === 'opencode' &&
    !cursorLoadsPluginMemberKind(
      cursorPluginFacetProvider(plugin.facets),
      'commands',
    )
      ? []
      : details.commands;
  for (const member of commands) {
    const key = `command\0${member.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({
      kind: 'command',
      name: member.name,
      description: member.description,
    });
  }
  return members;
}

/**
 * Copilot projects installed content: the members and MCP servers it finds
 * in the plugin's installed root. Native hooks, agents and apps are not
 * capabilities. Never installs, and never falls back to another facet.
 */
async function copilotHarness(
  marketplace: MarketplaceInfo,
  plugin: PluginInfo,
): Promise<CatalogPluginHarness> {
  // Match non-Codex execution's Claude-first facet precedence.
  const provider = plugin.facets.claude ? 'claude' : 'codex';
  const root = await resolvePluginInfoPath(
    plugin,
    marketplace,
    [],
    false,
    provider,
  );
  if (!root)
    return { supported: false, enabled: true, installed: false, members: [] };
  const members = discoverCursorPluginMembers(root, provider);
  // Only whether MCP servers exist matters here; reading their auth
  // entries would touch the token store.
  const mcpServers = Object.keys(
    readPluginMcpConfigObjects(root, loadPluginManifest(root, provider)),
  ).length;
  return {
    supported: members.length > 0 || mcpServers > 0,
    enabled: true,
    installed: true,
    members: members.map((member) => ({
      kind: member.kind === 'plugin_skill' ? 'skill' : 'command',
      name: member.name,
      description:
        member.kind === 'plugin_skill'
          ? member.skill.description
          : member.command.description,
    })),
  };
}

function facetHarness(
  plugin: PluginInfo,
  provider: Exclude<CatalogHarnessId, 'copilot'>,
): CatalogPluginHarness {
  return {
    supported: providerAllowsPluginSupport(plugin, provider),
    enabled: !(
      provider === 'codex' &&
      plugin.providerSupport.codex === 'compat' &&
      plugin.codexCompatDisabled === true
    ),
    installed: providerHasInstalledPluginFacet(plugin, provider),
    members: pluginMembersForProvider(plugin, provider),
  };
}

/** Every harness's facts for one marketplace plugin. */
export async function pluginHarnessFacts(
  marketplace: MarketplaceInfo,
  plugin: PluginInfo,
): Promise<CatalogPluginHarnesses> {
  return {
    claude: facetHarness(plugin, 'claude'),
    codex: facetHarness(plugin, 'codex'),
    ollama: facetHarness(plugin, 'ollama'),
    copilot: await copilotHarness(marketplace, plugin),
    opencode: facetHarness(plugin, 'opencode'),
  };
}
