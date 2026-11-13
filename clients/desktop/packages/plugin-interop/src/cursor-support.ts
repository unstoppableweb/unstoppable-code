/**
 * What a Cursor session loads from a plugin, read from the plugin's catalog
 * facets. Environment-neutral, so every surface that states per-harness
 * support (desktop or web) reads the same facts instead of restating them,
 * and the desktop resolver reads the member-kind fact from here too (facet
 * precedence it applies itself, in `resolvePluginSelection`'s non-Codex
 * branch shared with Claude sessions):
 *
 * - The session reads the Claude facet when the plugin has one, else the
 *   native Codex facet. A Codex compatibility facet is never read: a plugin
 *   that has one also has the Claude facet it was generated from.
 * - From that facet it loads the MCP servers, every skill, and, from a Claude
 *   facet only because Codex plugins carry skills and not commands, every
 *   command. Hooks, agents, LSP servers, and apps never load.
 *
 * The desktop resolver reads the commands fact through
 * `cursorLoadsPluginMemberKind` in `discoverCursorPluginMembers`, which also
 * discovers skills unconditionally, and reads MCP servers separately through
 * `readPluginMcpAuthEntries`; a main-process test checks both paths against
 * this predicate for every member kind.
 */

export type CursorPluginProvider = 'claude' | 'codex';

/** Facet presence is all the precedence rule reads. */
export interface CursorPluginFacetPresence {
  claude?: unknown;
  codex?: unknown;
  /** Present on catalog plugins; deliberately not read. */
  codexCompatibility?: unknown;
}

/** The facet a Cursor session reads: Claude content first, else native Codex. */
export function cursorPluginFacetProvider(
  facets: CursorPluginFacetPresence,
): CursorPluginProvider {
  return facets.claude ? 'claude' : 'codex';
}

/**
 * The members of a catalog plugin facet a Cursor session can load. The
 * catalog's `PluginDetails` carries more (hooks, agents, LSP servers, apps);
 * none of those loads in a Cursor session.
 */
export interface CursorLoadablePluginDetails {
  mcpServers: readonly unknown[];
  skills: readonly unknown[];
  commands: readonly unknown[];
}

export type CursorLoadablePluginMemberKind = keyof CursorLoadablePluginDetails;

export const CURSOR_LOADABLE_PLUGIN_MEMBER_KINDS: readonly CursorLoadablePluginMemberKind[] =
  ['mcpServers', 'skills', 'commands'];

/**
 * Whether a Cursor session loads a member kind from the facet it reads: MCP
 * servers and skills from either provider, commands from a Claude plugin only
 * (Codex plugins carry skills, not commands).
 */
export function cursorLoadsPluginMemberKind(
  provider: CursorPluginProvider,
  kind: CursorLoadablePluginMemberKind,
): boolean {
  return kind !== 'commands' || provider === 'claude';
}

export interface CursorPluginFacetSupport {
  /** The facet a Cursor session reads. */
  provider: CursorPluginProvider;
  /** Whether that facet carries at least one member a Cursor session loads. */
  supported: boolean;
}

interface CursorPluginFacets extends CursorPluginFacetPresence {
  claude?: { details?: CursorLoadablePluginDetails | null } | undefined;
  codex?: { details?: CursorLoadablePluginDetails | null } | undefined;
}

/**
 * Whether a Cursor session gets anything from a plugin, and from which facet.
 * A facet with nothing a Cursor session loads adds nothing to the session,
 * which the session reports in its unavailable-selection notice; here it
 * reports `supported: false`. Surfaces that state per-harness support use
 * this rather than restate it (CAP-01 in the harness checklist).
 */
export function cursorPluginFacetSupport(
  facets: CursorPluginFacets,
): CursorPluginFacetSupport {
  const provider = cursorPluginFacetProvider(facets);
  const details = facets[provider]?.details;
  if (!details) return { provider, supported: false };
  return {
    provider,
    supported: CURSOR_LOADABLE_PLUGIN_MEMBER_KINDS.some(
      (kind) =>
        cursorLoadsPluginMemberKind(provider, kind) && details[kind].length > 0,
    ),
  };
}
