// ---------------------------------------------------------------------------
// Deferred Skills, Plugins, and MCP Tooling — transport contracts.
//
// This module is the SINGLE SOURCE OF TRUTH for the wire between the renderer
// (frontend) and the main process (backend) for the two branded agent tools
// that let an agent discover + activate already-installed, locally-managed
// skills / plugins / MCP servers mid-turn:
//
//   - SearchDeferredTools / <brand>_search_deferred_tools
//   - LoadDeferredTools   / <brand>_load_deferred_tools
//
// Both the backend's runtime Zod schemas AND the hand-authored provider
// JSON-schemas (maintained in parallel — there is no `zodToJsonSchema`
// generation) MUST conform to the interfaces here. Keep this file the one
// place these shapes are defined so the two forms cannot drift.
//
// Boundary: this module is transport-only. It defines data shapes, the reload
// lifecycle vocabulary, and the IPC payloads. It does NOT implement the
// catalog, executor, coordinator (backend), or the renderer store / continuous
// UX (frontend). Those plans conform to what is defined here.
//
// This file emits NO user-visible copy — every branded, user-facing tool name
// and description is derived from the brand runtime by the backend/registry
// modules, never from literals here — so it is intentionally NOT registered in
// the branding scan's `SHARED_COPY_FILES` allowlist.
// ---------------------------------------------------------------------------

import type {
  AgentProviderType,
  ChatInterfaceMode,
} from '@canopy/agent-transcript';
import type { ChatTabPluginSelections } from '../types';

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/**
 * The three kinds of locally-managed resource this feature can discover and
 * enable. `mcp` is a whole MCP server (server id + config id); plugin-declared
 * MCP subservers are intentionally NOT independently selectable (Non-Goals).
 */
export type DeferredResourceKind = 'skill' | 'plugin' | 'mcp';

/**
 * Provider universe for the deferred-tools surface. Ollama follows Claude
 * compatibility for plugin support (both require native Claude), so it is a
 * first-class member alongside `claude` and `codex`. Copilot, OpenCode and
 * Antigravity read installed skill/command/MCP members through their host
 * projections.
 */
export type DeferredToolProvider =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'copilot'
  | 'opencode'
  | 'antigravity';

// ---------------------------------------------------------------------------
// Search input
// ---------------------------------------------------------------------------

/**
 * A single query in a batched Search call. Agents batch all their queries into
 * one call, so `SearchDeferredToolsInput.queries` is an array.
 */
export interface DeferredToolSearchQuery {
  /** Trimmed, non-empty search text. */
  text: string;
  /**
   * Optional kind filter; omitted means "all kinds". `skill` also searches
   * skills and commands nested inside plugins, returning the parent plugin ref.
   */
  kinds?: DeferredResourceKind[];
  /** Max matches for this query. 1–20, default 10. */
  limit?: number;
}

export interface SearchDeferredToolsInput {
  /** 1–20 queries. */
  queries: DeferredToolSearchQuery[];
}

// ---------------------------------------------------------------------------
// Search result (grouped by original query)
// ---------------------------------------------------------------------------

/**
 * Availability of a single Search match against the live catalog.
 *
 * - `available`      — can be enabled via Load.
 * - `already_enabled`— the capability is already active for this session; the
 *   agent can simply use it without a Load.
 * Unsupported candidates are omitted and counted on the query result instead.
 */
export type DeferredToolMatchStatus = 'available' | 'already_enabled';

/** A skill or slash command discovered inside a plugin search result. */
export interface DeferredPluginMemberMatch {
  kind: 'skill' | 'command';
  /** Provider-facing qualified name, for example `superpowers:brainstorming`. */
  name: string;
  description: string;
}

export interface DeferredToolMatch {
  /**
   * Opaque, stable catalog identity. Encodes catalog identity (standalone
   * skill: source id + skill name; plugin: marketplace id + plugin name; MCP:
   * server id + config id) but remains opaque to agents — Load revalidates it
   * against the live catalog and agents MUST NOT construct references from
   * guesses.
   */
  ref: string;
  kind: DeferredResourceKind;
  name: string;
  description: string;
  sourceLabel?: string;
  status: DeferredToolMatchStatus;
  reason?: string;
  /**
   * Plugin-owned skills/commands that caused this plugin to match. The parent
   * plugin `ref` remains the loadable resource because plugin members cannot
   * be enabled independently.
   */
  matchedMembers?: DeferredPluginMemberMatch[];
}

/** Matches for one original query, preserving the query text for grouping. */
export interface DeferredToolSearchQueryResult {
  query: string;
  matches: DeferredToolMatch[];
  /** Number of matching resources omitted because this provider cannot use them. */
  unsupportedMatches?: number;
}

/**
 * The full Search result. `results` mirrors the input `queries` order so the
 * agent can align each group with the query it issued.
 *
 * Search matching semantics (backend-implemented; the observable shape is
 * fixed here): case-insensitive across name, description, source/marketplace,
 * MCP server name, MCP config name, and plugin-owned skill/command metadata.
 * A `plugin:member` query scopes deep member matching to that plugin.
 * Standalone matches rank before plugin-member matches; within each group rank
 * exact name, prefix, token, then substring, with stable ordering for ties.
 */
export interface DeferredToolSearchResult {
  provider: DeferredToolProvider;
  results: DeferredToolSearchQueryResult[];
}

// ---------------------------------------------------------------------------
// Load input and result
// ---------------------------------------------------------------------------

export interface LoadDeferredToolsItem {
  /** Opaque, stable catalog identity — same encoding as Search's `ref`. */
  ref: string;
}

export interface LoadDeferredToolsInput {
  /** 1–50 items; duplicate refs are deduplicated by the backend. */
  items: LoadDeferredToolsItem[];
}

/**
 * A resource that Load will enable, or that a reload/observability record
 * names. Same opaque `ref` encoding as Search.
 */
export interface DeferredResourceSummary {
  ref: string;
  kind: DeferredResourceKind;
  name: string;
  sourceLabel?: string;
}

/**
 * Terminal classification for a single rejected Load item.
 *
 * `missing_tool_call_id` is returned when the provider did not supply the
 * stable tool-call identity required to coordinate a reload.
 * `reload_in_progress` is returned when a valid reload is already pending for
 * the active turn — concurrent Load calls are rejected rather than queued.
 * `reload_limit` is returned to a managed delegate that has already reloaded
 * its capabilities the maximum number of times in its current run.
 */
export type LoadDeferredToolRejectionCode =
  | 'invalid_ref'
  | 'not_found'
  | 'already_enabled'
  | 'unsupported'
  | 'disabled'
  | 'missing_tool_call_id'
  | 'reload_in_progress'
  | 'reload_limit';

export interface LoadDeferredToolRejection {
  ref: string;
  code: LoadDeferredToolRejectionCode;
  message: string;
}

/**
 * Load's overall status.
 *
 * - `error`           — `willEnable` empty; every requested item was invalid,
 *   unavailable, unsupported, disabled, already enabled, or rejected. This is
 *   returned as an error tool result. No coordinator intent is created; no
 *   reload occurs; the provider turn continues.
 * - `success`         — `willEnable` non-empty, `rejected` empty.
 * - `partial_success` — `willEnable` non-empty AND `rejected` non-empty.
 *
 * When `willEnable` is non-empty the reload lifecycle starts ONLY AFTER this
 * result has been delivered to and accepted by the provider.
 */
export type LoadDeferredToolsStatus = 'success' | 'partial_success' | 'error';

export interface LoadDeferredToolsResult {
  status: LoadDeferredToolsStatus;
  willEnable: DeferredResourceSummary[];
  rejected: LoadDeferredToolRejection[];
}

// ---------------------------------------------------------------------------
// Hidden continuation wire format
// ---------------------------------------------------------------------------

/**
 * The canonical fixed `<system_instruction>` continuation. Resource identities
 * are recorded structurally in transcript metadata rather than interpolated
 * into the prompt. Because every provider resumes with full prior history via
 * the persisted `sdkSessionId`, this is the ENTIRE continuation payload for
 * Claude, Ollama, and Codex — there is no request replay.
 *
 * Exported so both processes reference one template rather than re-deriving
 * the wording. The literal contains no product branding.
 */
export const DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE =
  '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>';

/**
 * Return the fixed hidden `<system_instruction>` continuation payload.
 */
export function buildDeferredToolsReloadContinuation(): string {
  return DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE;
}

/**
 * Shown when the deferred items could not be enabled at all (the original turn
 * was interrupted but never resumed). Closes the original timer.
 */
export const DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE =
  'Couldn’t enable the requested deferred items. The chat was not resumed.';

/**
 * Shown when the selections WERE persisted/enabled but the automatic resume
 * failed. The enabled selections remain active; the user can type "Continue" to
 * retry. Closes the original timer.
 */
export const DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE =
  'The requested items were enabled, but the chat could not resume automatically. Send “Continue” to retry.';

// ---------------------------------------------------------------------------
// Ref → selection bucket mapping (shared)
// ---------------------------------------------------------------------------

/**
 * The three selection buckets a Load addition merges into on the chat tab.
 * Mirrors the {@link ChatTabPluginSelections} field names exactly.
 */
export type DeferredToolsSelectionBucket =
  | 'skillRefs'
  | 'pluginRefs'
  | 'mcpServerRefs';

/**
 * Explicit, machine-checkable mapping from a resource kind to the tab
 * selection bucket its ref merges into. The renderer (writer) and the
 * coordinator (validator) MUST agree on this mapping, so it is defined once
 * here.
 *
 * - `kind: 'skill'`  → `skillRefs`
 * - `kind: 'plugin'` → `pluginRefs`
 * - `kind: 'mcp'`    → `mcpServerRefs`
 */
export const DEFERRED_RESOURCE_KIND_TO_SELECTION_BUCKET = {
  skill: 'skillRefs',
  plugin: 'pluginRefs',
  mcp: 'mcpServerRefs',
} as const satisfies Record<DeferredResourceKind, DeferredToolsSelectionBucket>;

/**
 * Normalized additions to merge into a chat tab's plugin selections, expressed
 * as typed refs bucketed by kind. Element shapes are pinned to
 * {@link ChatTabPluginSelections} so the renderer can merge without reshaping
 * and the two never drift.
 */
export interface DeferredToolsReloadAdditions {
  skillRefs: ChatTabPluginSelections['skillRefs'];
  pluginRefs: ChatTabPluginSelections['pluginRefs'];
  mcpServerRefs: NonNullable<ChatTabPluginSelections['mcpServerRefs']>;
}

// ---------------------------------------------------------------------------
// Reload lifecycle types
// ---------------------------------------------------------------------------

/**
 * Non-terminal progression states plus the successful terminal state
 * (`completed`). See {@link DeferredToolsReloadFailureOutcome} for the
 * unsuccessful terminal outcomes.
 *
 * ```text
 * idle → result_pending → ui_prepared → interrupting → enabling → resuming → completed
 * ```
 */
export type DeferredToolsReloadState =
  | 'idle'
  | 'result_pending'
  | 'ui_prepared'
  | 'interrupting'
  | 'enabling'
  | 'resuming'
  | 'completed';

/** Unsuccessful terminal outcomes of the reload lifecycle. */
export type DeferredToolsReloadFailureOutcome =
  | 'rejected'
  | 'cancelled'
  | 'enable_failed'
  | 'resume_failed';

/**
 * Discriminated state/outcome union so both processes share one vocabulary for
 * the reload lifecycle. `kind: 'state'` carries the progression (including the
 * successful terminal `completed`); `kind: 'outcome'` carries an unsuccessful
 * terminal outcome.
 */
export type DeferredToolsReloadLifecycle =
  | { kind: 'state'; state: DeferredToolsReloadState }
  | { kind: 'outcome'; outcome: DeferredToolsReloadFailureOutcome };

/** True when a lifecycle value is terminal (`completed` or any failure). */
export function isTerminalDeferredToolsReloadLifecycle(
  lifecycle: DeferredToolsReloadLifecycle,
): boolean {
  return (
    lifecycle.kind === 'outcome' ||
    (lifecycle.kind === 'state' && lifecycle.state === 'completed')
  );
}

/**
 * Coordinator scope key. The coordinator is keyed by
 * `(projectId, worktreeId, chatId)` AND the originating tool-call id; the
 * tool-call id is carried separately on the payloads below so this key can be
 * reused for the chat-tab identity alone.
 */
export interface DeferredToolsReloadScopeKey {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/** Failure detail attached to a failed reload event / ack. */
export interface DeferredToolsReloadError {
  outcome: DeferredToolsReloadFailureOutcome;
  message: string;
}

/**
 * Reject codes for a begin/finish/cancel call that could not be applied.
 * `reload_in_progress` mirrors the Load rejection: a valid reload is already
 * pending for the active turn. `stale_request` / `unknown_request` cover
 * duplicate or mismatched request ids per the idempotency contract.
 */
export type DeferredToolsReloadRejectCode =
  | 'reload_in_progress'
  | 'stale_request'
  | 'unknown_request'
  | 'invalid_request';

// ---------------------------------------------------------------------------
// Reload session resume settings
// ---------------------------------------------------------------------------

/**
 * Provider/session settings the backend needs to recreate the provider session
 * and resume the interrupted turn after `chat.updatePlugins` has merged the new
 * selections (which destroys the current session).
 */
export interface DeferredToolsReloadResumeSettings {
  /**
   * The persisted provider session id captured BEFORE `chat.updatePlugins`
   * destroys the session, so the recreated session resumes with full prior
   * history. Absent only when the tab had no session id yet.
   */
  sdkSessionId?: string;
  /** Provider that will resume the turn. */
  providerType?: AgentProviderType;
  /** Interface mode of the resuming session (native vs managed terminal). */
  interfaceMode?: ChatInterfaceMode;
  /**
   * The full, post-merge plugin selections the recreated session must run with.
   * Additions are ADDITIVE — existing selections remain enabled.
   */
  pluginSelections?: ChatTabPluginSelections;
}

// ---------------------------------------------------------------------------
// Reload IPC payloads (renderer ⇆ main)
// ---------------------------------------------------------------------------
//
// Idempotency contract: duplicate begin/finish IPC calls are idempotent by
// `requestId`; stale or mismatched ids return a rejected ack WITHOUT mutating
// another tab.

/** Fields shared by every renderer → main reload request. */
export interface DeferredToolsReloadRequestBase {
  scope: DeferredToolsReloadScopeKey;
  /** Idempotency key for this reload; also used for stale-id rejection. */
  requestId: string;
  /** Originating Load tool-call id — the second half of the coordinator key. */
  toolCallId: string;
}

/**
 * Begin the reload lifecycle (renderer → main). Sent after Load has delivered
 * its `success` / `partial_success` result and the renderer has prepared the
 * continuous UX. Carries the normalized additions to merge.
 */
export interface DeferredToolsReloadBeginRequest extends DeferredToolsReloadRequestBase {
  additions: DeferredToolsReloadAdditions;
  /** The revalidated resource identities that will be enabled. */
  enabledResources: DeferredResourceSummary[];
}

/**
 * Finish the reload lifecycle (renderer → main). Sent after the renderer has
 * merged the additions and persisted them. Carries the resume settings —
 * including the pre-`updatePlugins` `sdkSessionId` — plus the original logical
 * user message id to reuse for the hidden continuation (so no second user
 * bubble is created).
 */
export interface DeferredToolsReloadFinishRequest extends DeferredToolsReloadRequestBase {
  /**
   * The original logical user message id to reuse for the hidden continuation.
   * Round-trips through the send payload as `canopy_turn_user_message_id`.
   */
  userMessageId: string;
  resume: DeferredToolsReloadResumeSettings;
  /** Human-readable `<system_instruction>` continuation payload. */
  continuationText: string;
}

/** Cancel an in-flight reload (renderer → main). */
export interface DeferredToolsReloadCancelRequest extends DeferredToolsReloadRequestBase {
  reason?: string;
}

/**
 * Ack returned by begin / finish / cancel (main → renderer). `accepted: false`
 * carries a `rejection`; a stale or mismatched request id is rejected without
 * mutating another tab.
 */
export interface DeferredToolsReloadAck {
  requestId: string;
  accepted: boolean;
  /** Current lifecycle after applying (or attempting) this call. */
  lifecycle: DeferredToolsReloadLifecycle;
  rejection?: {
    code: DeferredToolsReloadRejectCode;
    message: string;
  };
}

/**
 * Main → renderer reload lifecycle notification (the `onXxx` subscription
 * channel). Emitted as the coordinator advances the FSM so the renderer can
 * mark-in-progress, merge, persist, and render the continuous UX.
 */
export interface DeferredToolsReloadEvent {
  scope: DeferredToolsReloadScopeKey;
  requestId: string;
  toolCallId: string;
  lifecycle: DeferredToolsReloadLifecycle;
  /** Resources enabled by this reload, when known (UI + observability). */
  enabledResources?: DeferredResourceSummary[];
  /**
   * The normalized, typed additions to merge into the originating tab's
   * selection buckets. The refs are opaque to agents but must be typed for the
   * renderer (the authoritative writer) to merge them additively into
   * `pluginSelections` and persist them via `chat.updatePlugins` — the opaque
   * `ref` in {@link DeferredResourceSummary} alone cannot be mapped back to a
   * `{ sourceId, skillName }` / `{ marketplaceId, pluginName }` /
   * `{ serverId, configId }` selection. The coordinator (which computed them
   * from the live catalog during Load) sends them here on the reload's initial
   * lifecycle event; the renderer mirrors them into its tab state when the
   * reload resumes. Absent on terminal-outcome events.
   */
  additions?: DeferredToolsReloadAdditions;
  /** Present on `kind: 'outcome'` (failure) lifecycles. */
  error?: DeferredToolsReloadError;
  /** On `resuming`: the provider session id the continuation resumes. */
  sdkSessionId?: string;
}
