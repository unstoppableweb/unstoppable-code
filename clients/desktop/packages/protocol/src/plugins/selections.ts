import type { McpHttpAuthPreference } from '../mcp-servers';
import type { TryItCapability } from '../try-it';
import type { SelectionRefOwner } from './selection-ref-owner';

/**
 * Selection refs name their item by two fields and, for an organization's
 * item, its owner (CAN-6235). No owner means the person's own item, which is
 * what every ref saved before the field existed means. The owner is part of a
 * ref's identity: see `@canopy/protocol/plugins` `selectionRefOwnerKey`.
 */
export interface SelectionSkillRef {
  sourceId: string;
  skillName: string;
  owner?: SelectionRefOwner;
}

export interface SelectionPluginRef {
  marketplaceId: string;
  pluginName: string;
  owner?: SelectionRefOwner;
}

export interface SelectionMcpServerRef {
  serverId: string;
  configId: string;
  owner?: SelectionRefOwner;
}

export interface ChatTabPluginSelections {
  /** Catalog selections awaiting installation/auth; never runtime filesystem refs. */
  unresolvedCapabilities?: TryItCapability[];
  /**
   * IDs of locally-saved Collections (formerly "Bundles") attached to this
   * chat. Persisted writes emit only `collectionIds`; the legacy
   * {@link ChatTabPluginSelections.bundleIds} alias is preserved for read-side
   * migration from older persisted state and must not be written by new
   * code.
   */
  collectionIds: string[];
  /**
   * @deprecated Read only for migration from older persisted state. The
   * normalization helper merges any legacy `bundleIds` into `collectionIds`
   * and drops this field on output.
   */
  bundleIds?: string[];
  skillRefs: SelectionSkillRef[];
  pluginRefs: SelectionPluginRef[];
  mcpServerRefs?: SelectionMcpServerRef[];
  /**
   * Per-server overrides for the HTTP MCP auth handler scoped to this
   * chat/worktree's plugin selections. Each entry pairs an
   * {@link McpHttpAuthTarget} with the {@link McpHttpAuthHandler} that should
   * be used in place of the global default.
   *
   * Intentionally NOT counted in {@link hasAnySelections} — overrides alone
   * should not flip an empty selection set into an active one, because that
   * would cause plugin discovery and resolution to run for chats that have
   * no actual plugin/MCP refs.
   */
  mcpHttpAuthPreferences?: McpHttpAuthPreference[];
}

/**
 * Explicit local rejections of inherited plugin defaults, persisted per scope.
 * A workspace config's tombstones suppress
 * {@link PreferencesData.globalPluginSelections} entries for the workspace; a
 * chat tab's tombstones suppress everything the chat inherits (its
 * workspace's `defaultPluginSelections` and the surviving global defaults). A
 * tombstoned entry stays excluded even when the same resource is later
 * re-added as a default, which is what makes a local "turn this default off"
 * durable. Tombstones only suppress inherited layers; they never remove a
 * scope's own local selections. Entries use the same identity granularity as
 * {@link ChatTabPluginSelections}; `mcpHttpAuthPreferences` are not
 * selections and cannot be tombstoned.
 */
export interface PluginSelectionTombstones {
  collectionIds?: string[];
  skillRefs?: SelectionSkillRef[];
  pluginRefs?: SelectionPluginRef[];
  mcpServerRefs?: SelectionMcpServerRef[];
}
