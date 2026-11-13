// ---------------------------------------------------------------------------
// Serialized panel-layout wire contracts for the VS Code-style panel system.
//
// This module is the single source of truth for the shapes that describe a
// worktree's splittable panel grid across process and package boundaries:
//   - the versioned persisted grid file (`SerializablePanelLayoutFile`) written
//     to `worktree-data/{worktreeId}/panel-layout.json`
//   - the separate outer-chrome scalar file (`WorktreePanelLayoutFile`)
//   - the serializable test-facing layout projection used by the Electron
//     UI-automation harness (`window.__canopyPanelTestApi`)
//   - `migratePanelLayout(...)`, the pure validation/migration entry point the
//     desktop persistence reader runs on every load
//
// Two persisted layout types deliberately co-exist here and must stay
// separate (the "two grids, two persistence strategies" split):
//   - `SerializablePanelLayoutFile` is the INNER content grid — a recursive
//     branch/leaf tree mirroring VS Code's `ISerializedGrid`.
//   - `WorktreePanelLayoutFile` is the OUTER chrome state — flat scalars only,
//     rebuilt each boot. It must never be folded into the grid tree: a single
//     bad chrome field must never be able to invalidate the whole grid, and
//     flat scalars keep chrome migration "add field with default" forever.
//
// Panel content is persisted BY ID only (`panelId` + `kind`), never as live
// runtime objects; content is re-attached from live state on restore.
//
// IMPORTANT: this module must stay dependency-free (no React, no Node APIs,
// no Electron, no other workspace packages) so it is safe to import from the
// desktop renderer, the desktop main process, and the web app alike.
// ---------------------------------------------------------------------------

// ===========================================================================
// Panel kinds.
// ===========================================================================

/**
 * Frozen runtime list of every panel kind that can appear on the wire. Use
 * this in validators and tests so the closed union stays in lockstep with the
 * type (same convention as `PORTAL_COMMAND_TYPES`).
 */
export const PANEL_KINDS = [
  'chat',
  'file-diff',
  'terminal',
  'activity-section',
  'browser',
  /**
   * A standalone file tree for the worktree (VS Code's Explorer view).
   * Worktree singleton: takes no `instance` binding.
   */
  'file-explorer',
  'change-diagram',
  /**
   * ONE activity section rendered as its own panel (e.g. just "Changed
   * Files"), bound to a section via `instance.sectionId` — unlike
   * `activity-section`, which is the whole stacked activity rail.
   */
  'activity-card',
  /**
   * Agent usage / rate-limit view (mirrors the standalone Usage page) sized
   * for the panel grid, bound to a variant via `instance.variant`
   * (`all` | `active-chat` | `codex` | `claude`). The `active-chat` variant
   * follows the worktree's active chat provider; the others are pinned.
   */
  'usage',
  /**
   * Workspace-scoped automations view, bound to a variant via
   * `instance.variant` (`full` | `upcoming` | `overview` | `completed`).
   * `full` renders every section collapsible; the others render exactly one
   * section without expand/collapse chrome.
   */
  'automations',
  /**
   * ONE pipeline execution's detail view, bound to a run via
   * `instance.executionId`. Repeatable (distinct runs coexist) but each
   * execution may be bound at most once across a worktree's layout family.
   * Unlike `browser`, it may live in auxiliary windows.
   */
  'pipeline-execution',
  /**
   * ONE tracked plan's document view, bound to a plan via `instance.planId`.
   * At most one `plan` panel per plan id across a worktree's layout family;
   * the desktop layout store prunes invalid or duplicate plan entries before
   * restoring a persisted layout, so this module validates shape only.
   */
  'plan',
  /**
   * ONE tracked plan's diagram split into its own panel, bound to a plan via
   * `instance.planId`. At most one per plan id across the layout family; it
   * may coexist with the same plan's `plan` panel.
   */
  'plan-diagram',
  /**
   * Every visual of ONE chat in a single scroll, bound to that chat via
   * `instance.chatId`. At most one per worktree layout family: it keys on the
   * kind alone, and expanding a visual from another chat rebinds it rather
   * than opening a second panel. It is opened from a visual, never from the
   * add menu, so it is not a singleton kind and keeps its binding.
   */
  'chat-visuals',
  /**
   * The subagents of ONE root chat, as a tree or list. Worktree singleton:
   * takes no `instance` binding. Which root chat it shows is view state owned
   * by the panel, never an identity binding.
   */
  'subagents',
  /**
   * ONE subagent opened as a chat, bound via `instance.rootChatId`,
   * `instance.subagentId`, and `instance.subagentKind`. Repeatable (distinct
   * subagents coexist) but each `(rootChatId, subagentId)` may be bound at
   * most once across a worktree's layout family. It may live in auxiliary
   * windows.
   */
  'subagent-chat',
  /**
   * The Agent Ledger of the panel's work scope: a Code worktree, or a Cowork
   * or App Advisor Work Entry. Scope singleton: takes no `instance` binding
   * and follows the layout it belongs to, never the global selection.
   */
  'ledger',
  /**
   * The observed cost of the panel's work scope: a Code worktree, or a Cowork
   * or App Advisor Work Entry. Scope singleton like `ledger`: takes no
   * `instance` binding and follows the layout it belongs to.
   */
  'cost',
  /**
   * ONE chat's cost, context and activity, bound via `instance.chatId` within
   * the layout's scope. Repeatable (distinct chats coexist) but each chat may
   * be bound at most once across a layout family; opening an existing one
   * focuses it. It may live in auxiliary windows.
   */
  'session-breakdown',
  /**
   * An empty tab that lists what can be opened in its place; choosing one
   * replaces the tab with that panel. Repeatable, bound via
   * `instance.newTabId` so several can coexist.
   */
  'new-tab',
] as const;

/**
 * Identifies what a panel renders. This union only names the kinds that are
 * valid on the wire; the desktop registry
 * (`apps/desktop-app/src/renderer/src/lib/panels/registry.ts`) is the source
 * of truth for each kind's behavior (title, icon, render, `canPopOut`,
 * `isWindowBound`).
 *
 * Growth pattern (matches `PortalCommandType`): new kinds MUST be added to
 * `PANEL_KINDS` first, then registered in the desktop registry. Persisted
 * files containing a kind unknown to this build fail `migratePanelLayout`
 * and fall back to the default layout, so ship the union addition with (or
 * before) the code that writes it.
 */
export type PanelKind = (typeof PANEL_KINDS)[number];

/**
 * Canonical runtime set of panel kinds that may appear at most once across a
 * worktree's layout family and therefore carry no `instance` binding.
 */
export const SINGLETON_PANEL_KINDS: ReadonlySet<PanelKind> = new Set<PanelKind>(
  [
    'activity-section',
    'file-explorer',
    'change-diagram',
    'subagents',
    'ledger',
    'cost',
  ],
);

/**
 * Closed set of instance variants accepted by the `usage` panel kind.
 *
 * This lives beside the wire-level panel kind contract because persisted
 * layouts and App Advisor actions both carry the value as
 * `instance.variant`. Renderer-only labels remain in the desktop registry.
 */
export const USAGE_PANEL_VARIANTS = [
  'all',
  'active-chat',
  'codex',
  'claude',
  'cursor',
  'copilot',
] as const;

export type UsagePanelVariant = (typeof USAGE_PANEL_VARIANTS)[number];

/** Runtime guard for the closed Usage panel variant union. */
export function isUsagePanelVariant(
  value: string | undefined,
): value is UsagePanelVariant {
  return (
    typeof value === 'string' &&
    USAGE_PANEL_VARIANTS.some((variant) => variant === value)
  );
}

/**
 * Closed set of instance variants accepted by the `automations` panel kind.
 *
 * Lives beside the wire-level panel kind contract for the same reason as
 * {@link USAGE_PANEL_VARIANTS}: persisted layouts and App Advisor actions
 * both carry the value as `instance.variant`. Renderer-only labels remain in
 * the desktop registry.
 */
export const AUTOMATIONS_PANEL_VARIANTS = [
  'full',
  'upcoming',
  'overview',
  'completed',
] as const;

export type AutomationsPanelVariant =
  (typeof AUTOMATIONS_PANEL_VARIANTS)[number];

/** Runtime guard for the closed Automations panel variant union. */
export function isAutomationsPanelVariant(
  value: string | undefined,
): value is AutomationsPanelVariant {
  return (
    typeof value === 'string' &&
    AUTOMATIONS_PANEL_VARIANTS.some((variant) => variant === value)
  );
}

/**
 * Length cap for a `pipeline-execution` panel's `instance.executionId`.
 * Execution ids are UUIDs today; the cap is generous headroom that still
 * keeps the identity key (and the deterministic panel id derived from it)
 * well inside {@link PANEL_INSTANCE_VALUE_MAX_LENGTH}.
 */
export const PIPELINE_EXECUTION_PANEL_ID_MAX_LENGTH = 256;

/** The binding a `pipeline-execution` panel carries in `instance`. */
export interface PipelineExecutionPanelInstance {
  readonly executionId: string;
}

/**
 * Runtime guard for the `pipeline-execution` instance contract: exactly one
 * key, `executionId`, whose value is non-empty, already trimmed (surrounding
 * whitespace would mint a second identity for the same run), and at most
 * {@link PIPELINE_EXECUTION_PANEL_ID_MAX_LENGTH} characters.
 */
export function isPipelineExecutionPanelInstance(
  value: unknown,
): value is PipelineExecutionPanelInstance {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    return false;
  }
  const executionId = value.executionId;
  return (
    typeof executionId === 'string' &&
    executionId.length > 0 &&
    executionId.length <= PIPELINE_EXECUTION_PANEL_ID_MAX_LENGTH &&
    executionId.trim() === executionId
  );
}

/**
 * Closed set of subagent kinds a `subagent-chat` panel can bind:
 * - `managed` — a delegate started through the app's managed delegation.
 * - `claude-native` — a Claude Task agent inside a Claude chat.
 * - `codex-native` — a child thread inside a Codex chat.
 * - `workflow-agent` — an agent inside a Claude Code workflow run. Workflow
 *   run and phase groups organize agents but never open as chats.
 */
export const SUBAGENT_KINDS = Object.freeze([
  'managed',
  'claude-native',
  'codex-native',
  'workflow-agent',
] as const);

export type SubagentKind = (typeof SUBAGENT_KINDS)[number];

/** Runtime guard for the closed {@link SubagentKind} union. */
export function isSubagentKind(value: unknown): value is SubagentKind {
  return (
    typeof value === 'string' && SUBAGENT_KINDS.some((kind) => kind === value)
  );
}

/**
 * Length cap for each `subagent-chat` panel binding value (`rootChatId`,
 * `subagentId`). Generous headroom over today's ids (UUIDs, tool use ids,
 * thread ids) that keeps the identity key well inside
 * {@link PANEL_INSTANCE_VALUE_MAX_LENGTH}.
 */
export const SUBAGENT_CHAT_PANEL_ID_MAX_LENGTH = 256;

/** The binding a `subagent-chat` panel carries in `instance`. */
export interface SubagentChatPanelInstance {
  /** The root chat whose transcript holds the subagent. */
  readonly rootChatId: string;
  /**
   * The subagent's id within that root chat: the delegation id for a managed
   * delegate, the tool use id for a Claude Task agent, the child thread id
   * for a Codex subagent.
   */
  readonly subagentId: string;
  readonly subagentKind: SubagentKind;
}

function isBoundedTrimmedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SUBAGENT_CHAT_PANEL_ID_MAX_LENGTH &&
    value.trim() === value
  );
}

/**
 * Runtime guard for the `subagent-chat` instance contract: exactly three
 * keys, `rootChatId`, `subagentId`, and `subagentKind`. Each value is
 * non-empty, already trimmed (surrounding whitespace would mint a second
 * identity for the same subagent), and at most
 * {@link SUBAGENT_CHAT_PANEL_ID_MAX_LENGTH} characters; `subagentKind` is one
 * of {@link SUBAGENT_KINDS}.
 */
export function isSubagentChatPanelInstance(
  value: unknown,
): value is SubagentChatPanelInstance {
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    return false;
  }
  return (
    isBoundedTrimmedId(value.rootChatId) &&
    isBoundedTrimmedId(value.subagentId) &&
    isSubagentKind(value.subagentKind)
  );
}

/**
 * Length cap for a `session-breakdown` panel's `instance.chatId`. Chat ids
 * are UUIDs today; the cap is headroom that keeps the identity key well
 * inside {@link PANEL_INSTANCE_VALUE_MAX_LENGTH}.
 */
export const SESSION_BREAKDOWN_PANEL_ID_MAX_LENGTH = 256;

/** The binding a `session-breakdown` panel carries in `instance`. */
export interface SessionBreakdownPanelInstance {
  readonly chatId: string;
}

/**
 * Runtime guard for the `session-breakdown` instance contract: exactly one
 * key, `chatId`, whose value is non-empty, already trimmed and at most
 * {@link SESSION_BREAKDOWN_PANEL_ID_MAX_LENGTH} characters.
 */
export function isSessionBreakdownPanelInstance(
  value: unknown,
): value is SessionBreakdownPanelInstance {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    return false;
  }
  const chatId = value.chatId;
  return (
    typeof chatId === 'string' &&
    chatId.length > 0 &&
    chatId.length <= SESSION_BREAKDOWN_PANEL_ID_MAX_LENGTH &&
    chatId.trim() === chatId
  );
}

// ===========================================================================
// Auxiliary (pulled-out) panel windows — Phase 8.
//
// The renderer opens an `about:blank` child window per pulled-out panel
// group via `window.open(url, frameName)`. The frame name is the shared
// contract between the renderer (which mints it) and the desktop main
// process (whose `setWindowOpenHandler` allows ONLY `about:blank` opens
// whose frame name carries this prefix — everything else stays deny-all).
// Internal identifier, never user-visible copy.
// ===========================================================================

/** `window.open` frameName prefix identifying a panel auxiliary window. */
export const PANEL_AUX_WINDOW_FRAME_PREFIX = 'canopy-panel-aux:';

/** Builds the `window.open` frame name for one auxiliary panel window. */
export function makePanelAuxWindowFrameName(auxWindowId: string): string {
  return `${PANEL_AUX_WINDOW_FRAME_PREFIX}${auxWindowId}`;
}

/** Whether a `window.open` frame name identifies a panel auxiliary window. */
export function isPanelAuxWindowFrameName(frameName: string): boolean {
  return frameName.startsWith(PANEL_AUX_WINDOW_FRAME_PREFIX);
}

// ===========================================================================
// Persisted inner content grid (per-worktree `panel-layout.json`).
//
// Mirrors VS Code's `ISerializedGrid`/`ISerializedNode` shape, adapted to
// Canopy id-addressing: leaves carry a stable `groupId` plus tabbed panel
// entries instead of an opaque `data` blob.
// ===========================================================================

/**
 * Length cap for persisted panel titles. Enforced by CLAMPING (writers clamp
 * at serialize time, readers clamp on rehydrate via {@link clampPanelTitle}),
 * never by rejecting the file: a hand-edited or corrupt over-length title
 * must degrade to truncation, not to losing the whole layout.
 */
export const PANEL_TITLE_MAX_LENGTH = 500;

/** Clamps a panel title to {@link PANEL_TITLE_MAX_LENGTH} characters. */
export function clampPanelTitle(title: string): string {
  return title.length > PANEL_TITLE_MAX_LENGTH
    ? title.slice(0, PANEL_TITLE_MAX_LENGTH)
    : title;
}

/** Maximum number of keys allowed in a persisted panel `instance` map. */
export const PANEL_INSTANCE_MAX_KEYS = 16;
/** Maximum length of one persisted panel `instance` key. */
export const PANEL_INSTANCE_KEY_MAX_LENGTH = 500;
/**
 * Maximum length of one persisted panel `instance` value. Deliberately
 * generous (file paths can be long); see {@link ISerializedPanelEntry.instance}
 * for why over-length values REJECT the file instead of clamping.
 */
export const PANEL_INSTANCE_VALUE_MAX_LENGTH = 2000;

/** One tabbed panel inside a leaf group, persisted by id — never as a live object. */
export interface ISerializedPanelEntry {
  readonly panelId: string;
  readonly kind: PanelKind;
  /**
   * Optional per-instance tab title (additive field, doc 12 §4 additive-first
   * rule — no version bump; files without it stay valid and display falls
   * back to the registry default for the kind). Validation rejects the file
   * only on a WRONG TYPE; length never rejects — both serialize and
   * rehydrate clamp through {@link clampPanelTitle}.
   */
  readonly title?: string;
  /**
   * Optional per-instance entity binding: a flat string→string map that ties
   * a panel to ONE concrete entity of its kind (additive field — no version
   * bump; files without it stay valid).
   *
   * Per-kind contracts (readers reject files that violate them; validated by
   * the desktop layout store, not here):
   * - `chat` → `{ chatTabId }` — one chat tab.
   * - `file-diff` → `{ fileTabId, filePath }` — one open file tab.
   * - `activity-card` → `{ sectionId }` — one activity section.
   * - `usage` → `{ variant }` — one usage view variant
   *   (`all` | `active-chat` | `codex` | `claude`).
   * - `automations` → `{ variant }` — one automations view variant
   *   (`full` | `upcoming` | `overview` | `completed`).
   * - `browser` → `{ browserId }` — one persisted Browser session. Browser
   *   panels are repeatable, but a given `browserId` may be bound only once
   *   across the main layout and may not be placed in an auxiliary window.
   * - `pipeline-execution` → `{ executionId }` — one pipeline run, and
   *   nothing else (exactly one trimmed, non-empty key bounded by
   *   {@link PIPELINE_EXECUTION_PANEL_ID_MAX_LENGTH}; see
   *   {@link isPipelineExecutionPanelInstance}). Repeatable across runs and
   *   allowed in auxiliary windows; the desktop store keeps one binding per
   *   run across the whole layout family. Unlike most kinds (see also
   *   `subagent-chat`), a malformed entry does NOT reject the file:
   *   `migratePanelLayout` drops just that entry, so one bad run tab never
   *   costs the user's layout.
   * - `plan` → `{ planId }` — one tracked plan's document view.
   * - `plan-diagram` → `{ planId }` — one tracked plan's diagram. Both plan
   *   kinds may pop out. This module validates plan entries by SHAPE only;
   *   the desktop layout store prunes entries with a missing `planId` or a
   *   `planId` repeated within one kind before restoring, so one bad plan
   *   entry never discards the rest of the layout.
   * - `subagent-chat` → `{ rootChatId, subagentId, subagentKind }` — one
   *   subagent of one root chat, and nothing else (exactly three trimmed,
   *   non-empty keys, ids bounded by
   *   {@link SUBAGENT_CHAT_PANEL_ID_MAX_LENGTH}, `subagentKind` one of
   *   {@link SUBAGENT_KINDS}; see {@link isSubagentChatPanelInstance}).
   *   Repeatable across subagents and allowed in auxiliary windows; the
   *   desktop store keeps one binding per `(rootChatId, subagentId)` across
   *   the whole layout family. Like `pipeline-execution`, a malformed entry
   *   does NOT reject the file: `migratePanelLayout` drops just that entry.
   * - `session-breakdown` → `{ chatId }` — one chat of the layout's scope,
   *   and nothing else (see {@link isSessionBreakdownPanelInstance}).
   *   Repeatable across chats; the desktop store keeps one binding per chat
   *   across the layout family. A malformed entry is dropped, like
   *   `pipeline-execution`.
   * - `terminal` / `activity-section` / `file-explorer` / `change-diagram` /
   *   `subagents` / `ledger` / `cost` take NO instance (worktree singletons); readers drop
   *   unexpected instance data. The root chat a `subagents` panel shows is
   *   panel view state, not a binding.
   *
   * Validation ({@link isPanelInstanceRecord}): must be a plain object whose
   * values are all strings, with at most {@link PANEL_INSTANCE_MAX_KEYS}
   * keys, key length ≤ {@link PANEL_INSTANCE_KEY_MAX_LENGTH} and value
   * length ≤ {@link PANEL_INSTANCE_VALUE_MAX_LENGTH}. Unlike `title` —
   * which clamps because a truncated title only degrades display — instance
   * values are IDENTITY bindings (ids/paths): truncating one would silently
   * rebind the panel to the wrong entity, so an over-length key or value
   * rejects the whole file (the caller then falls back to the default
   * layout). The caps are generous enough that rejection only ever fires on
   * corrupt or hand-mangled files.
   */
  readonly instance?: Readonly<Record<string, string>>;
  /**
   * Whether this tab is PINNED (additive field, doc 12 §4 additive-first rule
   * — no version bump; files without it stay valid and the tab is treated as
   * unpinned). Pinned tabs render in their own scroll area, sort before
   * unpinned tabs within a group, and are exempt from bulk "Close *" menu
   * actions. Validation rejects the file only on a WRONG TYPE, matching the
   * `title` type-only check.
   */
  readonly pinned?: boolean;
  /**
   * The chat tab (`chatTabId`) this content tab belongs to (additive field,
   * doc 12 §4 additive-first rule — no version bump; files without it stay
   * valid and the tab shows for every chat). While another chat of the same
   * layout is selected, the tab is hidden but kept, so each chat keeps its
   * own browser, file and plan tabs. Only content kinds use it; see
   * `CHAT_SCOPED_PANEL_KINDS` in `@canopy/ui-app`. Validation rejects the
   * file only on a WRONG TYPE, matching `title` and `pinned`.
   */
  readonly chatScope?: string;
}

/** Directions a leaf group can collapse toward, at outer or inner split edges. */
export const PANEL_COLLAPSE_EDGES = ['left', 'right', 'top', 'bottom'] as const;
export type PanelCollapseEdge = (typeof PANEL_COLLAPSE_EDGES)[number];

/**
 * Persisted collapse state of one leaf group (additive field, doc 12 §4
 * additive-first rule — no version bump; files without it stay valid).
 * `expandedSize` is the node's `size` before collapsing, restored on expand.
 * Malformed shapes REJECT the file (matching the `title`/`pinned` type-strict
 * posture); a well-typed but structurally stale value is dropped by the
 * desktop reader after re-deriving eligibility, never rejected here.
 */
export interface PanelCollapsedState {
  readonly edge: PanelCollapseEdge;
  readonly expandedSize: number;
  /**
   * Canopy collapsed this group as a default; it may be reopened
   * automatically when the panel gains content. Absent means the collapse is
   * the user's and is never undone.
   */
  readonly auto?: boolean;
}

/**
 * A leaf of the grid tree: one tabbed panel group. `size` is the node's extent
 * along the parent branch's orientation, like VS Code's `ISerializedLeafNode`.
 * `activePanelId` is structural only (string or null); referential integrity
 * against `panels` is normalized by the desktop reader, not enforced here.
 */
export interface ISerializedPanelLeafNode {
  readonly type: 'leaf';
  /** Stable group id; the addressing unit for focus/split/move operations. */
  readonly groupId: string;
  readonly panels: readonly ISerializedPanelEntry[];
  readonly activePanelId: string | null;
  readonly size: number;
  readonly visible?: boolean;
  readonly maximized?: boolean;
  readonly collapsed?: PanelCollapsedState;
}

/**
 * An internal node of the grid tree. Children alternate orientation with
 * their parent, so orientation is derived from depth plus the grid root's
 * `orientation` — it is intentionally not stored per branch (VS Code parity).
 */
export interface ISerializedPanelBranchNode {
  /** Extent before automatic subtree collapse; children retain their own sizes. */
  readonly expandedSize?: number;
  /** Child proportions before collapse temporarily redistributes their space. */
  readonly expandedSizes?: readonly number[];
  readonly type: 'branch';
  readonly children: readonly ISerializedPanelNode[];
  readonly size: number;
  readonly visible?: boolean;
}

export type ISerializedPanelNode =
  | ISerializedPanelBranchNode
  | ISerializedPanelLeafNode;

/**
 * The serialized grid tree plus the root dimensions needed to restore
 * proportional sizes. `orientation`: 0 = vertical, 1 = horizontal (VS Code's
 * `Orientation` enum values — `VERTICAL = 0`, `HORIZONTAL = 1` — kept numeric
 * for serialized-grid parity).
 */
export interface ISerializedPanelGrid {
  readonly root: ISerializedPanelNode;
  readonly orientation: 0 | 1;
  readonly width: number;
  readonly height: number;
}

/** Last saved OS-window bounds of a popped-out panel window, in screen px. */
export interface SerializedPoppedPanelWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Best-effort placement hint for recreating a group removed by pop-out. */
export interface SerializedPanelReturnTarget {
  /** A surviving group that bordered the popped-out group. */
  readonly anchorGroupId: string;
  /** Where the popped-out group sat relative to the anchor. */
  readonly direction: 'up' | 'down' | 'left' | 'right';
  /** Original size on the split axis, in CSS pixels. */
  readonly size?: number;
}

/**
 * A pulled-out auxiliary panel window (Phase 9 multi-window persistence).
 * `poppedOut` stays a separate optional top-level array so future pull-out
 * evolution never forces a core grid-tree migration.
 *
 * `grid` reuses the same leaf shape as the main grid, so the aux window's
 * tab metadata (panel ids + kinds, active tab per group) is carried by the
 * leaves themselves. `activeGroupId` / `mostRecentActiveGroupIds` are
 * OPTIONAL additive fields (doc 12 §4 additive-first rule): files written
 * before they existed stay valid, and readers fall back to leaf order.
 */
export interface SerializedPoppedPanelWindow {
  readonly windowId: string;
  readonly grid: ISerializedPanelGrid;
  readonly bounds: SerializedPoppedPanelWindowBounds;
  /** Group in the main grid the window was popped out from (merge-back target). */
  readonly sourceGroupId: string;
  /** Placement hint used when `sourceGroupId` must be recreated. */
  readonly returnTarget?: SerializedPanelReturnTarget;
  /** Active (focused) group of the aux grid. Optional additive field. */
  readonly activeGroupId?: string;
  /** MRU group ids of the aux grid, most recent first. Optional additive field. */
  readonly mostRecentActiveGroupIds?: readonly string[];
}

export const PANEL_LAYOUT_FILE_VERSION = 1;

/**
 * The versioned per-worktree panel grid file
 * (`worktree-data/{worktreeId}/panel-layout.json`). Read exclusively through
 * `migratePanelLayout(...)`; writers always write the current version.
 */
export interface SerializablePanelLayoutFile {
  readonly version: 1;
  readonly grid: ISerializedPanelGrid;
  readonly activeGroupId: string;
  /** Most-recently-active group ids, most recent first (focus restore order). */
  readonly mostRecentActiveGroupIds: readonly string[];
  /** Pulled-out auxiliary windows. Phase 9; optional so v1 files stay minimal. */
  readonly poppedOut?: readonly SerializedPoppedPanelWindow[];
}

// ===========================================================================
// Persisted outer chrome scalars (`WorktreePanelLayoutFile`).
//
// The analog of VS Code's `LayoutStateModel`: part visibilities, positions,
// alignment, and sizes as FLAT SCALARS. The layout tree is recomputed from
// these on every boot; no grid tree is persisted for the outer chrome. Keep
// it that way — migration stays "add field with default" (normalize-on-read
// fills defaults, no version bump needed), and a single bad chrome field can
// never invalidate the inner content grid.
// ===========================================================================

export type PanelPosition = 'bottom' | 'top' | 'left' | 'right';
export type SideBarSide = 'left' | 'right';
export type PanelAlignment = 'left' | 'center' | 'right' | 'justify';

/**
 * Per-worktree outer-chrome layout state. Distinct on-disk concern from
 * `SerializablePanelLayoutFile` — do NOT fold these scalars into the grid
 * tree (see module banner).
 */
export interface WorktreePanelLayoutFile {
  readonly version: 1;

  /** Part visibility, stored positively (not VS Code's inverted `*_HIDDEN`). */
  readonly visibility: {
    readonly activityBar: boolean; // default true
    readonly sideBar: boolean; // default true
    readonly panel: boolean; // default false (hidden), per VS Code PANEL_HIDDEN default
    readonly auxiliaryBar: boolean; // default false
    readonly statusBar: boolean; // default true
    readonly editor: boolean; // default true
  };

  // Positions
  readonly sideBarSide: SideBarSide; // default 'left'
  readonly panelPosition: PanelPosition; // default 'bottom'
  readonly panelAlignment: PanelAlignment; // default 'center'

  /** Sizes in px. Snapshot live sizes at (debounced) save time. */
  readonly sizes: {
    readonly sideBar: number; // default min(300, width/4)
    readonly auxiliaryBar: number; // default min(300, width/4)
    readonly panel: number; // default height/3 when horizontal, else width/4
  };

  /** For un-maximize restore (VS Code PANEL_LAST_NON_MAXIMIZED_*). */
  readonly panelLastNonMaximized: {
    readonly width: number;
    readonly height: number;
  };
  readonly panelWasLastMaximized: boolean; // default false (REMEMBER_LAST behavior)
  readonly editorCentered: boolean; // default false

  /** Zen mode snapshot of what to restore on exit. */
  readonly zen: {
    readonly active: boolean;
    readonly exitInfo: {
      readonly wasVisible: {
        readonly sideBar: boolean;
        readonly panel: boolean;
        readonly auxiliaryBar: boolean;
      };
      readonly transitionedToCenteredEditorLayout: boolean;
      readonly transitionedToFullScreen: boolean;
    };
  };
}

// ===========================================================================
// Test-facing layout projection (`__canopyPanelTestApi`).
//
// A READ VIEW of the live grid for UI-automation assertions — close to
// `ISerializedPanelGrid` but deliberately NOT unified with the persisted
// schema: it flattens defaults into required fields (`visible`, `maximized`),
// uses string orientations, keeps `kind` an open string, and evolves with the
// test harness rather than with the on-disk format.
// ===========================================================================

export interface SerializedPanelLeaf {
  type: 'leaf';
  groupId: string;
  panels: ReadonlyArray<{
    panelId: string;
    kind: string;
    /** Per-instance entity binding passthrough (additive; absent when the
     * live tab has no instance). */
    instance?: Readonly<Record<string, string>>;
    /** Pinned-state passthrough (additive; absent/false when unpinned). */
    pinned?: boolean;
  }>;
  activePanelId: string | null;
  size: number;
  visible: boolean;
  maximized: boolean;
  /** Collapse edge of this leaf, or `null` when expanded. */
  collapsed: PanelCollapseEdge | null;
  /**
   * Whether this leaf's collapse is Canopy's own seeded default
   * (`PanelCollapsedState.auto`) rather than the user's (CAN-2836).
   *
   * `collapsed` above deliberately flattens the descriptor to its edge, which
   * makes the provenance invisible to UI automation — a spec reading
   * `collapsed.auto` off that string silently gets `undefined` and asserts
   * nothing. This additive field exposes the flag so the "a rail the USER
   * collapsed is never reopened" guarantee is observable end to end.
   * Absent when the leaf is expanded or the collapse carries no flag.
   */
  collapsedAuto?: boolean;
}

export interface SerializedPanelBranch {
  type: 'branch';
  orientation: 'horizontal' | 'vertical';
  children: ReadonlyArray<SerializedPanelNode>;
  size: number;
  visible: boolean;
}

export type SerializedPanelNode = SerializedPanelLeaf | SerializedPanelBranch;

export interface SerializedPanelLayout {
  root: SerializedPanelNode;
  width: number;
  height: number;
  activeGroupId: string | null;
}

export type PanelSplitDirection = 'up' | 'down' | 'left' | 'right';
export type PanelDropEdge = 'top' | 'bottom' | 'left' | 'right' | 'center';

// ===========================================================================
// Pure type guards + migration for the persisted grid file.
//
// `migratePanelLayout` mirrors the terminal persistence normalize-on-read
// posture (`normalizePersistedState`, terminal/persistence.ts): it NEVER
// throws — corrupt, unknown, or forward-versioned input returns `null` and
// the caller applies the default layout.
// ===========================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

export function isPanelKind(value: unknown): value is PanelKind {
  return (
    typeof value === 'string' && PANEL_KINDS.some((kind) => kind === value)
  );
}

export function isPanelCollapseEdge(
  value: unknown,
): value is PanelCollapseEdge {
  return (
    typeof value === 'string' &&
    PANEL_COLLAPSE_EDGES.some((edge) => edge === value)
  );
}

export function isPanelCollapsedState(
  value: unknown,
): value is PanelCollapsedState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isPanelCollapseEdge(value.edge) &&
    isFiniteNumber(value.expandedSize) &&
    value.expandedSize > 0 &&
    isOptionalBoolean(value.auto)
  );
}

/**
 * Validates a panel entry's optional `instance` map. Structural AND length
 * checks both reject — instance values are identity bindings, never clamped
 * (see {@link ISerializedPanelEntry.instance} for the rationale).
 */
export function isPanelInstanceRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > PANEL_INSTANCE_MAX_KEYS) return false;
  return entries.every(
    ([key, entryValue]) =>
      key.length <= PANEL_INSTANCE_KEY_MAX_LENGTH &&
      typeof entryValue === 'string' &&
      entryValue.length <= PANEL_INSTANCE_VALUE_MAX_LENGTH,
  );
}

export function isSerializedPanelEntry(
  value: unknown,
): value is ISerializedPanelEntry {
  if (!isRecord(value)) return false;
  const validInstance =
    value.instance === undefined || isPanelInstanceRecord(value.instance);
  if (!validInstance) return false;
  if (
    value.kind === 'browser' &&
    (!isRecord(value.instance) ||
      Object.keys(value.instance).length !== 1 ||
      !isNonEmptyString(value.instance.browserId) ||
      value.instance.browserId.trim().length === 0)
  ) {
    return false;
  }
  // Modeled on `browser` (a required single binding), without its
  // main-window-only rules. `migratePanelLayout` drops entries that fail this
  // before validating the file, so this rejection never costs a whole layout.
  if (
    value.kind === 'pipeline-execution' &&
    !isPipelineExecutionPanelInstance(value.instance)
  ) {
    return false;
  }
  // Same posture as `pipeline-execution`: migration drops these first.
  if (
    value.kind === 'subagent-chat' &&
    !isSubagentChatPanelInstance(value.instance)
  ) {
    return false;
  }
  if (
    value.kind === 'session-breakdown' &&
    !isSessionBreakdownPanelInstance(value.instance)
  ) {
    return false;
  }
  return (
    isNonEmptyString(value.panelId) &&
    isPanelKind(value.kind) &&
    // Type-only check: an over-length title is clamped by readers/writers,
    // never a rejection reason (see ISerializedPanelEntry.title).
    (value.title === undefined || typeof value.title === 'string') &&
    // Instance maps DO reject on bad shape or over-length keys/values —
    // identity bindings must never be silently truncated.
    validInstance &&
    // Type-only check: a non-boolean `pinned` rejects the file, but its
    // absence is valid (unpinned).
    isOptionalBoolean(value.pinned) &&
    // Type-only check, like `pinned`: absent means the tab is shared.
    (value.chatScope === undefined || typeof value.chatScope === 'string')
  );
}

function serializedNodeContainsBrowserPanel(
  node: ISerializedPanelNode,
): boolean {
  if (node.type === 'leaf') {
    return node.panels.some((panel) => panel.kind === 'browser');
  }
  return node.children.some(serializedNodeContainsBrowserPanel);
}

function hasDuplicateMainBrowserBinding(node: ISerializedPanelNode): boolean {
  const instanceKeys = new Set<string>();
  const visit = (current: ISerializedPanelNode): boolean => {
    if (current.type === 'branch') {
      return current.children.some(visit);
    }
    for (const panel of current.panels) {
      if (panel.kind !== 'browser') continue;
      const browserId = panel.instance?.browserId;
      if (browserId === undefined) continue;
      const instanceKey = `browser:${browserId}`;
      if (instanceKeys.has(instanceKey)) return true;
      instanceKeys.add(instanceKey);
    }
    return false;
  };
  return visit(node);
}

export function isSerializedPanelLeafNode(
  value: unknown,
): value is ISerializedPanelLeafNode {
  if (!isRecord(value)) return false;
  if (value.type !== 'leaf') return false;
  // A leaf must not carry branch data; a node claiming both is corrupt.
  if (value.children !== undefined) return false;
  return (
    isNonEmptyString(value.groupId) &&
    Array.isArray(value.panels) &&
    value.panels.every(isSerializedPanelEntry) &&
    (value.activePanelId === null || typeof value.activePanelId === 'string') &&
    isFiniteNonNegativeNumber(value.size) &&
    isOptionalBoolean(value.visible) &&
    isOptionalBoolean(value.maximized) &&
    (value.collapsed === undefined || isPanelCollapsedState(value.collapsed))
  );
}

export function isSerializedPanelBranchNode(
  value: unknown,
): value is ISerializedPanelBranchNode {
  if (!isRecord(value)) return false;
  if (value.type !== 'branch') return false;
  return (
    Array.isArray(value.children) &&
    value.children.length > 0 &&
    value.children.every(isSerializedPanelNode) &&
    isFiniteNonNegativeNumber(value.size) &&
    (value.expandedSize === undefined ||
      isFiniteNonNegativeNumber(value.expandedSize)) &&
    (value.expandedSizes === undefined ||
      (Array.isArray(value.expandedSizes) &&
        value.expandedSizes.length === value.children.length &&
        value.expandedSizes.every(isFiniteNonNegativeNumber) &&
        value.expandedSizes.some((size: number) => size > 0))) &&
    isOptionalBoolean(value.visible)
  );
}

export function isSerializedPanelNode(
  value: unknown,
): value is ISerializedPanelNode {
  return isSerializedPanelLeafNode(value) || isSerializedPanelBranchNode(value);
}

export function isSerializedPanelGrid(
  value: unknown,
): value is ISerializedPanelGrid {
  if (!isRecord(value)) return false;
  return (
    isSerializedPanelNode(value.root) &&
    (value.orientation === 0 || value.orientation === 1) &&
    isFiniteNonNegativeNumber(value.width) &&
    isFiniteNonNegativeNumber(value.height)
  );
}

function isSerializedPoppedPanelWindowBounds(
  value: unknown,
): value is SerializedPoppedPanelWindowBounds {
  if (!isRecord(value)) return false;
  return (
    // x/y may be negative on multi-monitor arrangements.
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNonNegativeNumber(value.width) &&
    isFiniteNonNegativeNumber(value.height)
  );
}

function isSerializedPanelReturnTarget(
  value: unknown,
): value is SerializedPanelReturnTarget {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.anchorGroupId) &&
    (value.direction === 'up' ||
      value.direction === 'down' ||
      value.direction === 'left' ||
      value.direction === 'right') &&
    (value.size === undefined || isFiniteNonNegativeNumber(value.size))
  );
}

export function isSerializedPoppedPanelWindow(
  value: unknown,
): value is SerializedPoppedPanelWindow {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.windowId) &&
    isSerializedPanelGrid(value.grid) &&
    !serializedNodeContainsBrowserPanel(value.grid.root) &&
    isSerializedPoppedPanelWindowBounds(value.bounds) &&
    isNonEmptyString(value.sourceGroupId) &&
    (value.returnTarget === undefined ||
      isSerializedPanelReturnTarget(value.returnTarget)) &&
    (value.activeGroupId === undefined ||
      isNonEmptyString(value.activeGroupId)) &&
    (value.mostRecentActiveGroupIds === undefined ||
      (Array.isArray(value.mostRecentActiveGroupIds) &&
        value.mostRecentActiveGroupIds.every((entry) =>
          isNonEmptyString(entry),
        )))
  );
}

export function isSerializablePanelLayoutFile(
  value: unknown,
): value is SerializablePanelLayoutFile {
  if (!isRecord(value)) return false;
  return (
    value.version === PANEL_LAYOUT_FILE_VERSION &&
    isSerializedPanelGrid(value.grid) &&
    !hasDuplicateMainBrowserBinding(value.grid.root) &&
    isNonEmptyString(value.activeGroupId) &&
    Array.isArray(value.mostRecentActiveGroupIds) &&
    value.mostRecentActiveGroupIds.every((entry) => isNonEmptyString(entry)) &&
    (value.poppedOut === undefined ||
      (Array.isArray(value.poppedOut) &&
        value.poppedOut.every(isSerializedPoppedPanelWindow)))
  );
}

/**
 * Upgrades a file from a given source version to source version + 1, or
 * returns `null` when the shape cannot be upgraded. Upgraders receive raw
 * records (the source shape is by definition not the current type) and are
 * run in sequence by `migratePanelLayout` before final validation.
 */
type PanelLayoutVersionUpgrader = (
  raw: Record<string, unknown>,
) => Record<string, unknown> | null;

/**
 * Per-version upgrader slots, keyed by SOURCE version. Empty today; when
 * version 2 lands, register `1 → upgradeV1ToV2` here and bump
 * `PANEL_LAYOUT_FILE_VERSION`. Prefer optional additive fields (no bump
 * needed — validation already tolerates them) over breaking shape changes.
 */
const PANEL_LAYOUT_UPGRADERS: ReadonlyMap<number, PanelLayoutVersionUpgrader> =
  new Map();

/**
 * Whether a raw panel entry is a `pipeline-execution`, `subagent-chat` or
 * `session-breakdown` tab with a bad binding (the kinds whose malformed
 * entries are dropped instead of rejecting the file).
 */
function isInvalidDroppableBoundEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (entry.kind === 'pipeline-execution') {
    return !isPipelineExecutionPanelInstance(entry.instance);
  }
  if (entry.kind === 'subagent-chat') {
    return !isSubagentChatPanelInstance(entry.instance);
  }
  if (entry.kind === 'session-breakdown') {
    return !isSessionBreakdownPanelInstance(entry.instance);
  }
  return false;
}

/**
 * Drops malformed `pipeline-execution` and `subagent-chat` entries from one
 * raw grid node.
 * Returns the SAME reference when nothing was dropped, so an untouched file
 * keeps `migratePanelLayout`'s identity round-trip. Anything that is not a
 * recognizable leaf/branch is returned as-is for final validation to judge.
 */
function dropInvalidBoundEntriesFromNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  if (node.type === 'leaf') {
    if (!Array.isArray(node.panels)) return node;
    const panels: unknown[] = node.panels;
    const retained = panels.filter(
      (entry) => !isInvalidDroppableBoundEntry(entry),
    );
    return retained.length === panels.length
      ? node
      : { ...node, panels: retained };
  }
  if (node.type === 'branch' && Array.isArray(node.children)) {
    const children: unknown[] = node.children;
    const next = children.map(dropInvalidBoundEntriesFromNode);
    return next.every((child, index) => child === children[index])
      ? node
      : { ...node, children: next };
  }
  return node;
}

// ---------------------------------------------------------------------------
// Raw pre-migration plan sanitization.
//
// The desktop layout store's `pruneInvalidBoundPanelEntries` runs AFTER `migratePanelLayout` has
// already validated the whole file — but the protocol entry validator
// (`isSerializedPanelEntry`) rejects a structurally invalid `instance` (a
// non-string value, an over-length string, too many keys) by returning
// `null` for the ENTIRE file, so a single damaged plan entry never reaches
// the post-migration prune. `sanitizeRawPlanPanelBindings` closes that gap by
// running on the RAW, unvalidated parsed JSON before `migratePanelLayout`,
// touching only `plan` / `plan-diagram` entries and leaving every other
// kind's raw shape untouched for the protocol validator to accept or reject
// exactly as before. It does not deduplicate repeated plan ids — that stays
// `pruneInvalidBoundPanelEntries`'s job (in `@canopy/ui-app`) once the file
// is a validated `SerializablePanelLayoutFile`. It lives here so the main
// process's default-layout loader and the renderer share one pre-migration
// step.
// ---------------------------------------------------------------------------

function isRawRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRawPlanKind(kind: unknown): kind is 'plan' | 'plan-diagram' {
  return kind === 'plan' || kind === 'plan-diagram';
}

/**
 * Whether one raw (unvalidated) `plan`/`plan-diagram` panel entry has a
 * well-formed instance binding: an {@link isPanelInstanceRecord} map (a
 * plain object of strings within the protocol caps) carrying a non-empty,
 * trimmed `planId`. Mirrors `satisfiesInstanceContract`'s plan case, but runs
 * on raw JSON so a shape violation never rejects the whole file.
 */
function isValidRawPlanEntry(entry: Record<string, unknown>): boolean {
  const instance = entry.instance;
  if (!isPanelInstanceRecord(instance)) {
    return false;
  }
  const planId = instance.planId;
  return typeof planId === 'string' && planId.trim().length > 0;
}

/** Drops malformed raw `plan`/`plan-diagram` panels from one raw leaf node. */
function sanitizeRawPlanPanelsInLeaf(
  leaf: Record<string, unknown>,
): Record<string, unknown> {
  const rawPanels = leaf.panels;
  if (!Array.isArray(rawPanels)) {
    return leaf;
  }
  let changed = false;
  const panels: unknown[] = [];
  for (const panel of rawPanels) {
    if (
      isRawRecord(panel) &&
      isRawPlanKind(panel.kind) &&
      !isValidRawPlanEntry(panel)
    ) {
      changed = true;
      continue;
    }
    panels.push(panel);
  }
  if (!changed) {
    return leaf;
  }
  const activePanelId = leaf.activePanelId;
  let nextActivePanelId: string | null;
  if (
    typeof activePanelId === 'string' &&
    panels.some(
      (panel) => isRawRecord(panel) && panel.panelId === activePanelId,
    )
  ) {
    nextActivePanelId = activePanelId;
  } else {
    nextActivePanelId = firstRawPanelId(panels);
  }
  return { ...leaf, panels, activePanelId: nextActivePanelId };
}

/** First panel's `panelId` among raw panel entries, or `null` when none has one. */
function firstRawPanelId(panels: readonly unknown[]): string | null {
  for (const panel of panels) {
    if (isRawRecord(panel) && typeof panel.panelId === 'string') {
      return panel.panelId;
    }
  }
  return null;
}

/** Recursively sanitizes raw plan panels across one raw grid node (leaf or branch). */
function sanitizeRawPlanPanelsInNode(node: unknown): unknown {
  if (!isRawRecord(node)) {
    return node;
  }
  if (node.type === 'leaf') {
    return sanitizeRawPlanPanelsInLeaf(node);
  }
  if (node.type === 'branch' && Array.isArray(node.children)) {
    let changed = false;
    const children = node.children.map((child) => {
      const next = sanitizeRawPlanPanelsInNode(child);
      if (next !== child) {
        changed = true;
      }
      return next;
    });
    return changed ? { ...node, children } : node;
  }
  return node;
}

function dropInvalidBoundEntriesFromGrid(grid: unknown): unknown {
  if (!isRecord(grid)) return grid;
  const root = dropInvalidBoundEntriesFromNode(grid.root);
  return root === grid.root ? grid : { ...grid, root };
}

/**
 * Normalize-on-read for the `pipeline-execution`, `subagent-chat` and
 * `session-breakdown` kinds ONLY: a run or subagent tab whose binding is malformed is removed from the
 * main grid and every popped-out grid instead of failing the whole file.
 * Every other kind keeps its strict reject-the-file posture. A leaf whose
 * `activePanelId` pointed at a dropped entry is left as-is; the desktop
 * reader already normalizes that reference.
 */
function dropInvalidBoundEntries(
  file: Record<string, unknown>,
): Record<string, unknown> {
  const grid = dropInvalidBoundEntriesFromGrid(file.grid);
  let poppedOut = file.poppedOut;
  if (Array.isArray(file.poppedOut)) {
    const windows: unknown[] = file.poppedOut;
    const nextWindows = windows.map((entry) => {
      if (!isRecord(entry)) return entry;
      const entryGrid = dropInvalidBoundEntriesFromGrid(entry.grid);
      return entryGrid === entry.grid ? entry : { ...entry, grid: entryGrid };
    });
    if (nextWindows.some((entry, index) => entry !== windows[index])) {
      poppedOut = nextWindows;
    }
  }
  if (grid === file.grid && poppedOut === file.poppedOut) return file;
  return {
    ...file,
    grid,
    ...(poppedOut !== file.poppedOut ? { poppedOut } : {}),
  };
}

/** Whether a raw (post-sanitize) grid node still carries at least one panel. */
function rawNodeHasPanels(node: unknown): boolean {
  if (!isRawRecord(node)) {
    return false;
  }
  if (node.type === 'leaf') {
    return Array.isArray(node.panels) && node.panels.length > 0;
  }
  if (node.type === 'branch' && Array.isArray(node.children)) {
    return node.children.some(rawNodeHasPanels);
  }
  return false;
}

/**
 * Drops malformed raw `plan` / `plan-diagram` panel entries from an
 * unvalidated, freshly parsed `panel-layout.json` (or saved-default-template)
 * value BEFORE it reaches {@link migratePanelLayout}. An entry is dropped
 * when its `instance` is not a plain string-valued record within the
 * protocol caps, or it lacks a non-empty trimmed `planId`. Each touched
 * leaf's `activePanelId` is re-pointed at a surviving panel (or `null`), and
 * a `poppedOut` window left with zero panels is dropped entirely. Every
 * other panel kind's raw shape is returned byte-for-byte unchanged, so an
 * unrelated malformed entry still fails {@link migratePanelLayout} exactly as
 * before. Never throws on arbitrary input; returns the SAME reference when
 * nothing was dropped.
 */
export function sanitizeRawPlanPanelBindings(raw: unknown): unknown {
  if (!isRawRecord(raw)) {
    return raw;
  }

  let gridChanged = false;
  let nextGrid: unknown = raw.grid;
  if (isRawRecord(raw.grid)) {
    const nextRoot = sanitizeRawPlanPanelsInNode(raw.grid.root);
    if (nextRoot !== raw.grid.root) {
      gridChanged = true;
      nextGrid = { ...raw.grid, root: nextRoot };
    }
  }

  let poppedOutChanged = false;
  let nextPoppedOut: readonly unknown[] = [];
  if (Array.isArray(raw.poppedOut)) {
    const kept: unknown[] = [];
    for (const entry of raw.poppedOut) {
      if (!isRawRecord(entry)) {
        kept.push(entry);
        continue;
      }
      const entryGrid = entry.grid;
      if (!isRawRecord(entryGrid)) {
        kept.push(entry);
        continue;
      }
      const nextRoot = sanitizeRawPlanPanelsInNode(entryGrid.root);
      if (nextRoot === entryGrid.root) {
        kept.push(entry);
        continue;
      }
      poppedOutChanged = true;
      if (rawNodeHasPanels(nextRoot)) {
        kept.push({ ...entry, grid: { ...entryGrid, root: nextRoot } });
      }
      // Else: the popped-out window lost every panel — drop the whole entry.
    }
    if (poppedOutChanged) {
      nextPoppedOut = kept;
    }
  }

  if (!gridChanged && !poppedOutChanged) {
    return raw;
  }
  const next: Record<string, unknown> = { ...raw };
  if (gridChanged) {
    next.grid = nextGrid;
  }
  if (poppedOutChanged) {
    // Matches the desktop store's `pruneInvalidBoundPanelEntries`: an empty result OMITS the
    // field entirely rather than persisting an empty array.
    if (nextPoppedOut.length > 0) {
      next.poppedOut = nextPoppedOut;
    } else {
      delete next.poppedOut;
    }
  }
  return next;
}

/**
 * Validates (and, for older versions, migrates) a raw parsed
 * `panel-layout.json` value. Returns the validated current-version file, or
 * `null` for non-objects, unknown/forward versions, missing upgraders, or any
 * corruption anywhere in the recursive grid tree — the caller then applies
 * the default layout. Never throws. The exceptions to whole-file rejection
 * are malformed `pipeline-execution`, `subagent-chat` and `session-breakdown`
 * entries, which are dropped (see {@link ISerializedPanelEntry.instance}).
 */
export function migratePanelLayout(
  raw: unknown,
): SerializablePanelLayoutFile | null {
  if (!isRecord(raw)) return null;

  const version = raw.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > PANEL_LAYOUT_FILE_VERSION
  ) {
    return null;
  }

  let current: Record<string, unknown> = raw;
  for (
    let sourceVersion = version;
    sourceVersion < PANEL_LAYOUT_FILE_VERSION;
    sourceVersion += 1
  ) {
    const upgrade = PANEL_LAYOUT_UPGRADERS.get(sourceVersion);
    if (upgrade === undefined) return null;
    const upgraded = upgrade(current);
    if (upgraded === null) return null;
    current = upgraded;
  }

  current = dropInvalidBoundEntries(current);
  return isSerializablePanelLayoutFile(current) ? current : null;
}
