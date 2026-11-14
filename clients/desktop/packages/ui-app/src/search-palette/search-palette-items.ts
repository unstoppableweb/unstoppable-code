import type { WorkspaceKind } from '@canopy/ui-shared/components';
import { WORKFLOW_TYPE_TAB_LABELS } from '@canopy/ui-shared/lib/workflow-labels';

/**
 * Every kind of result the search palette lists. A host lists the kinds it
 * can serve: desktop lists them all, the Portal its chats and worktrees.
 * `chat-content` rows come from a deferred text search and are appended
 * after the ranked sections.
 */
export type SearchPaletteItemKind =
  | 'command'
  | 'worktree'
  | 'archive'
  | 'chat'
  | 'chat-content'
  | 'plan'
  | 'pipeline'
  | 'automation'
  | 'watcher'
  | 'agent'
  | 'plugin'
  | 'skill'
  | 'setting';

/**
 * The owning project's badge, drawn as the sidebar draws it: its kind, its
 * colour (stored or derived with `workspaceColor`), and the owner avatar a
 * single-repo project may show.
 */
export interface SearchPaletteProjectBadge {
  readonly kind: WorkspaceKind;
  readonly color: string;
  readonly temporary: boolean;
  readonly avatarUrl?: string;
}

/** A highlighted span of a content snippet, as `[start, end)` offsets. */
export interface SearchPaletteMatchRange {
  readonly start: number;
  readonly end: number;
}

/**
 * One palette result, as the shared palette ranks and draws it. Hosts extend
 * it with their own navigation; display fields are precomputed so ranking
 * never derives them per keystroke.
 */
export interface SearchPaletteItem {
  /** Stable, unique key for React and for deduping content hits. */
  readonly id: string;
  readonly kind: SearchPaletteItemKind;
  /** Primary label; highlighted on a fuzzy match. */
  readonly title: string;
  /** Matched at reduced weight; drawn only as a content hit's snippet. */
  readonly subtitle?: string;
  /** Extra lowercase tokens matched but never highlighted. */
  readonly keywords?: readonly string[];
  /** Epoch ms for the recency order and the recency tie-break. */
  readonly timestamp?: number;
  /** Draws a retained-item badge. */
  readonly archived?: boolean;
  /**
   * Which retained state the badge names: `deleted` (removed after the
   * retention window) or `archived` (kept until deleted). Unset keeps the
   * plain "Archived" badge.
   */
  readonly archiveState?: 'archived' | 'deleted';
  /** A state the item is in (OFF, FAILED, a review status), never a category. */
  readonly statusBadge?: string;
  /** A command's shortcut, drawn as quiet text at the row's end. */
  readonly shortcut?: string;
  /** The owning project's badge, the row glyph for chats and worktrees. */
  readonly project?: SearchPaletteProjectBadge;
  /**
   * Quiet text at the row's end saying where the item lives: the worktree a
   * chat runs in, or a worktree's branch when its title is a task name.
   */
  readonly context?: string;
  /**
   * Highlight ranges into {@link subtitle} for a content hit. The row then
   * leads with the snippet and names the item at its end.
   */
  readonly subtitleMatchRanges?: readonly SearchPaletteMatchRange[];
  /** The title is a user-authored name, so session replay masks it. */
  readonly titleReplayMasked?: boolean;
}

export interface SearchPaletteSectionMeta {
  /** Stable section key, also the row group's `data-palette-section`. */
  readonly id: string;
  /** User-facing section header. */
  readonly label: string;
}

/**
 * The section each kind belongs to. Title matches for chats live under
 * "Chats"; content matches are appended under "In content" once the
 * deferred search resolves.
 */
export const SEARCH_PALETTE_SECTION_BY_KIND: Readonly<
  Record<SearchPaletteItemKind, SearchPaletteSectionMeta>
> = {
  chat: { id: 'chats', label: 'Chats' },
  worktree: { id: 'worktrees', label: 'Worktrees' },
  archive: { id: 'archives', label: 'Archived and deleted' },
  plan: { id: 'plans', label: 'Plans' },
  pipeline: { id: 'pipelines', label: WORKFLOW_TYPE_TAB_LABELS.pipeline },
  automation: {
    id: 'automations',
    label: WORKFLOW_TYPE_TAB_LABELS.automation,
  },
  watcher: { id: 'watchers', label: 'Watchers' },
  agent: { id: 'agents', label: 'Agents' },
  plugin: { id: 'plugins', label: 'Plugins' },
  skill: { id: 'skills', label: 'Skills' },
  setting: { id: 'settings', label: 'Settings' },
  command: { id: 'commands', label: 'Commands' },
  // Mixed deferred results (chat transcripts and plan text). The section id
  // predates plan docs and is kept for `data-palette-section` stability.
  'chat-content': { id: 'transcripts', label: 'In content' },
};

/**
 * Canonical section order, the tie-breaker when two sections' best matches
 * score equally. At query time sections are ordered by their strongest match
 * with commands pinned last, and the deferred content section is always
 * appended at the very end, so indices and the keyboard selection stay
 * stable when it arrives.
 */
export const SEARCH_PALETTE_SECTION_ORDER: readonly SearchPaletteItemKind[] = [
  'chat',
  'worktree',
  'archive',
  'plan',
  'pipeline',
  'automation',
  'watcher',
  'agent',
  'plugin',
  'skill',
  'setting',
  'command',
  'chat-content',
];

/** Max rows shown per grouped section before "Show more". */
export const SEARCH_PALETTE_SECTION_CAP = 6;

/** Max rows shown in the empty-query "Recent" section. */
export const SEARCH_PALETTE_RECENT_CAP = 8;
