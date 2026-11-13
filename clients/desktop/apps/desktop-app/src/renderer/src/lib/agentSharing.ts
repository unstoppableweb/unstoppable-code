import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { UnifiedTableRow } from '@/hooks/useUnifiedTableData';

/**
 * User-facing copy shown when an Agent's plugin selections cannot be
 * represented as a portable {@link ShareablePluginRef} list. Sharing is blocked
 * — the UI surfaces this message; the authoritative conversion + blocking rules
 * live in the backend share client.
 */
export const AGENT_SHARE_BLOCKED_MESSAGE =
  'Agents with Collections, local-only plugins, MCP servers, or MCP auth ' +
  'preferences cannot be shared. Remove them before sharing.';

export type AgentShareablePluginsResult =
  | { ok: true; plugins: ShareablePluginRef[] }
  | { ok: false };

/**
 * Resolve an Agent's local {@link ChatTabPluginSelections} into a portable
 * {@link ShareablePluginRef} list for the shared-Agent document, or report that
 * sharing is blocked.
 *
 * Sharing is blocked when the selections include any category that has no
 * portable representation:
 *   - Collections (`collectionIds`),
 *   - MCP servers (`mcpServerRefs`),
 *   - MCP HTTP auth preferences (`mcpHttpAuthPreferences`),
 *   - or a skill/plugin that resolves to a local-only catalog entry (no
 *     `shareableRef` on its unified-table row).
 *
 * `rows` is the unified skill/plugin catalog (from `useUnifiedTableData`); each
 * shareable row carries a canonical `shareableRef`. Rows are keyed
 * `${sourceId}/${name}` for skills and `${marketplaceId}/${name}` for plugins,
 * matching the selection ref shapes.
 */
export function deriveShareableAgentPlugins(
  selections: ChatTabPluginSelections,
  rows: readonly UnifiedTableRow[],
): AgentShareablePluginsResult {
  const normalized = normalizePluginSelections(selections);
  if (
    normalized.collectionIds.length > 0 ||
    (normalized.mcpServerRefs?.length ?? 0) > 0 ||
    (normalized.mcpHttpAuthPreferences?.length ?? 0) > 0
  ) {
    return { ok: false };
  }

  const shareableByKey = new Map<string, ShareablePluginRef>();
  for (const row of rows) {
    if ((row.kind === 'skill' || row.kind === 'plugin') && row.shareableRef) {
      shareableByKey.set(`${row.kind}:${row.key}`, row.shareableRef);
    }
  }

  const plugins: ShareablePluginRef[] = [];

  for (const skill of normalized.skillRefs) {
    const ref = shareableByKey.get(
      `skill:${skill.sourceId}/${skill.skillName}`,
    );
    if (!ref) {
      return { ok: false };
    }
    plugins.push(ref);
  }

  for (const plugin of normalized.pluginRefs) {
    const ref = shareableByKey.get(
      `plugin:${plugin.marketplaceId}/${plugin.pluginName}`,
    );
    if (!ref) {
      return { ok: false };
    }
    plugins.push(ref);
  }

  return { ok: true, plugins };
}

/**
 * Partitioned resolution of local {@link ChatTabPluginSelections} for
 * automation sharing.
 *
 * `plugins` carries every selection that has a portable
 * {@link ShareablePluginRef}; `dropped` carries human-readable labels for the
 * ones that only exist on this machine (Collections, MCP servers, MCP auth
 * preferences, and local-only skills/plugins). The automation share modal
 * names the dropped entries in a notice rather than refusing the share.
 */
export interface LenientShareablePluginsResult {
  plugins: ShareablePluginRef[];
  dropped: string[];
}

/**
 * Lenient sibling of {@link deriveShareableAgentPlugins}.
 *
 * Agent sharing is deliberately all-or-nothing, so that helper's contract is
 * unchanged. Automation sharing instead downgrades: portable selections
 * travel and the rest are named in an author-facing notice. `rows` is the
 * unified skill/plugin catalog; rows of any kind are also used to turn an
 * opaque id into a readable label when the catalog happens to include them.
 */
export function deriveShareablePluginsLenient(
  selections: ChatTabPluginSelections,
  rows: readonly UnifiedTableRow[],
  options: { packageLocalCapabilities?: boolean } = {},
): LenientShareablePluginsResult {
  const normalized = normalizePluginSelections(selections);

  const shareableByKey = new Map<string, ShareablePluginRef>();
  const labelByKey = new Map<string, string>();
  for (const row of rows) {
    labelByKey.set(`${row.kind}:${row.key}`, row.name);
    if ((row.kind === 'skill' || row.kind === 'plugin') && row.shareableRef) {
      shareableByKey.set(`${row.kind}:${row.key}`, row.shareableRef);
    }
  }

  const plugins: ShareablePluginRef[] = [];
  const dropped: string[] = [];

  for (const collectionId of normalized.collectionIds) {
    if (!options.packageLocalCapabilities) {
      dropped.push(
        labelByKey.get(`collection:${collectionId}`) ?? collectionId,
      );
    }
  }

  for (const skill of normalized.skillRefs) {
    const key = `skill:${skill.sourceId}/${skill.skillName}`;
    const ref = shareableByKey.get(key);
    if (ref) {
      plugins.push(ref);
    } else if (!options.packageLocalCapabilities) {
      dropped.push(`${skill.sourceId}/${skill.skillName}`);
    }
  }

  for (const plugin of normalized.pluginRefs) {
    const key = `plugin:${plugin.marketplaceId}/${plugin.pluginName}`;
    const ref = shareableByKey.get(key);
    if (ref) {
      plugins.push(ref);
    } else if (!options.packageLocalCapabilities) {
      dropped.push(`${plugin.marketplaceId}/${plugin.pluginName}`);
    }
  }

  for (const server of normalized.mcpServerRefs ?? []) {
    dropped.push(
      labelByKey.get(`mcp:${server.configId}`) ??
        labelByKey.get(`mcp:${server.serverId}`) ??
        server.serverId,
    );
  }

  for (const preference of normalized.mcpHttpAuthPreferences ?? []) {
    const target = preference.target;
    const label =
      target.kind === 'standalone'
        ? target.serverId
        : `${target.marketplaceId}/${target.pluginName}/${target.serverName}`;
    dropped.push(`${label} (auth preference)`);
  }

  return { plugins, dropped };
}
