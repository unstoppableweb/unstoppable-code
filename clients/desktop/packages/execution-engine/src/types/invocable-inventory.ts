// ---------------------------------------------------------------------------
// Invocable Inventory (Fast Slash Menu) — transport contracts.
//
// `@canopy/desktop-shared` OWNS `InvocableInventoryEntry`. This module defines
// the shared types, IPC request/response shapes, and the preload API surface
// that the renderer (frontend) and the main process (backend) both build
// against. The authoritative cache build is backend and the authoritative
// insertion is frontend; this transport layer only guarantees the fields exist
// and that both ends agree on the wire shapes.
//
// Boundary note: this concrete entry type MUST NOT leak into `@canopy/ui-rich`
// (which has no dependency on `@canopy/desktop-shared` and is also consumed by
// `apps/web`). The renderer carries the concrete entry on the typed
// `SlashCommandData.inventoryEntry` field, while `SlashCommandOption` (ui-rich)
// only carries the boundary-safe `data?: unknown` slot.
// ---------------------------------------------------------------------------

import type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
} from '../execution-types';
import type { IPCResult } from './pipeline';

/**
 * Provider universe for the invocable inventory. Ollama reuses the Claude
 * `/`-style projection (there is no Ollama plugin facet). Cursor rows insert
 * the id the chat's private `~/.cursor` root holds for that skill or command
 * (see `@canopy/desktop-shared/lib/cursor-capabilities`).
 */
export type InvocableInventoryProvider =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'copilot'
  | 'antigravity'
  | 'opencode';

/** The kind of invocable an inventory row represents. */
export type InvocableInventoryKind =
  | 'skill'
  | 'plugin_skill'
  | 'plugin_command'
  /** A skill from the user's own home folders; Cursor only, always on. */
  | 'inherited_skill'
  /** A command file from the user's own home folders; Cursor only, always on. */
  | 'inherited_command';

/**
 * Reference used to enable the underlying skill/plugin when an
 * "available but not enabled" row is selected. The element shapes match
 * {@link ChatTabPluginSelections.skillRefs} / `pluginRefs` exactly so the
 * frontend can merge a ref without reshaping. `none` means there is nothing
 * to enable: the row is always on for its provider and only inserts its text.
 */
export type InvocableInventoryEnableRef =
  | { kind: 'skill'; sourceId: string; skillName: string }
  | { kind: 'plugin'; marketplaceId: string; pluginName: string }
  | { kind: 'none' };

export interface InvocableInventoryEntry {
  id: string;
  provider: InvocableInventoryProvider;
  kind: InvocableInventoryKind;
  name: string;
  displayName: string;
  description: string;
  insertText: string;
  invocationKey: string;
  enableRef: InvocableInventoryEnableRef;
  /**
   * For Codex Claude-compatibility plugin_command rows: the ORIGINAL Claude
   * command name. Compatibility projects Claude commands into Codex *skills*
   * with a GENERATED name, so resolveSelection re-derives that name from
   * sourceName via the projection and validates it against
   * codexCompatibility.details.skills. Unset for Claude/Ollama rows,
   * Codex-native rows, and Codex-compat plugin *skills* (those keep their
   * original name).
   */
  sourceName?: string;
  requiresCodexCompatPrepare?: boolean;
  sourceLabel?: string;
}

export interface InvocableInventoryCache {
  /** 6: selected Antigravity skill and command rows, without ambient inheritance. */
  version: 6;
  builtAt: string;
  entries: InvocableInventoryEntry[];
  /**
   * Fingerprint of the inherited Cursor set the entries were built from, so
   * a served list can notice the user's home folders or the Cursor app's
   * plugin cache changed without any Canopy mutation. Absent in a cache
   * written before it was recorded; treated as changed.
   */
  inheritedFingerprint?: string;
}

export interface ListInvocableInventoryRequest {
  providerType: InvocableInventoryProvider | null;
}

export interface ListInvocableInventoryResponse {
  entries: InvocableInventoryEntry[];
  stale: boolean;
  rebuilding: boolean;
  builtAt?: string;
}

/**
 * Validate-and-resolve, called at selection time before enabling/inserting.
 */
export interface ResolveInvocableSelectionRequest {
  providerType: InvocableInventoryProvider;
  /**
   * The specific inventory row being selected. enableRef alone is NOT enough:
   * one plugin ref (`{ marketplaceId, pluginName }`) can back many skills and
   * commands, so the handler needs the row's kind + name (carried on entry,
   * along with enableRef and invocationKey) to validate THAT row and return its
   * exact insert text.
   */
  entry: InvocableInventoryEntry;
  /**
   * The selection the tab will have AFTER merging entry.enableRef (candidate
   * appended last, Collections still referenced by id). The handler expands
   * Collections and computes the exact per-tab invocation from this.
   */
  selections: ChatTabPluginSelections;
  /**
   * The chat's plugin opt-outs, when it has any. A Cursor chat also runs the
   * plugins it inherits from Claude Code minus these, and the handler numbers
   * ids over that same set, so a plugin the chat turned off takes no id.
   */
  chatTombstones?: PluginSelectionTombstones;
  /**
   * The chat's working directory (its worktree checkout), when known. Claude
   * Code installs plugins at user, project, or local scope; the handler
   * counts a project or local install only for the repository it belongs to,
   * exactly as the Cursor session does for that chat.
   */
  projectPath?: string;
}

export interface ResolveInvocableSelectionResponse {
  /**
   * Authoritative invocation text to insert for THIS tab. Overrides the cached
   * entry.insertText, which is only a provisional/global display value (Codex
   * standalone names depend on the tab's full effective skill set).
   */
  insertText: string;
  invocationKey: string;
}

/**
 * Preload bridge surface exposed on `window.invocableInventory`.
 *
 * Observable contract (guaranteed to the renderer; implementation lives in the
 * backend plan):
 * - `list(request)` returns immediately from the in-memory/persisted cache.
 *   Missing cache → `entries: []`, `stale: true`, `rebuilding: true`; stale
 *   cache → stale `entries` with `stale: true`; a background rebuild starts in
 *   both cases. `builtAt` is present when a built cache exists.
 * - `refresh()` forces a rebuild and resolves with the rebuilt response.
 * - `onChanged(callback)` fires after the inventory changes (rebuild completes
 *   / inventory mutated); returns an unsubscribe function.
 * - `resolveSelection(request)` returns the authoritative per-tab
 *   `{ insertText, invocationKey }` on success, which overrides the cached
 *   `entry.insertText`. It returns `success: false` (via {@link IPCResult})
 *   when the selected row — identified by its `entry.kind` + `entry.name`
 *   within its `enableRef` — no longer exists in live inventory (including the
 *   case where the plugin still exists but that specific command/skill was
 *   removed after the cache was built).
 */
export interface InvocableInventoryAPI {
  list(
    request: ListInvocableInventoryRequest,
  ): Promise<IPCResult<ListInvocableInventoryResponse>>;
  refresh(): Promise<IPCResult<ListInvocableInventoryResponse>>;
  resolveSelection(
    request: ResolveInvocableSelectionRequest,
  ): Promise<IPCResult<ResolveInvocableSelectionResponse>>;
  onChanged(callback: () => void): () => void;
}
