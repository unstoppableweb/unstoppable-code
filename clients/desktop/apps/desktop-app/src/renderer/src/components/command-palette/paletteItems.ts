import type {
  ChatSearchMatchRange,
  ChatSearchSource,
} from '@canopy/desktop-shared/types';
import type { WorktreeUiStatus } from '@/lib/worktree-status';
import type { WorkspaceKind } from '@canopy/ui-shared/components';
import type { SettingsSection } from '@/components/settings/SettingsNav';
import { WORKFLOW_TYPE_TAB_LABELS } from '@canopy/ui-shared/lib/workflow-labels';
import type { CommandExecutionResult } from './paletteCommands';

/**
 * Every searchable/actionable target in the unified Cmd+K palette. The union is
 * discriminated by {@link PaletteItem.kind}; entity kinds are sourced from
 * renderer stores/hooks (tier 0) and the chat-search catalog (tier 1), while
 * `chat-content` rows come from the deferred transcript query (tier 2).
 */
export type PaletteItemKind =
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
 * colour (stored or derived), and the repository whose owner avatar it may
 * show.
 */
export interface PaletteProjectBadge {
  kind: WorkspaceKind;
  color: string;
  temporary: boolean;
  repoPath?: string;
}

/**
 * A single palette result. Display fields are precomputed by the providers so
 * ranking never has to re-derive them per keystroke; `execute` performs the
 * navigation/side-effect and reports whether the palette should close.
 */
interface PaletteItemBase {
  /** Stable, unique key for React + cross-tier dedupe. */
  id: string;
  /** Primary label; highlighted on fuzzy match. */
  title: string;
  /** Secondary line: `project • branch`, a description, or an FTS snippet. */
  subtitle?: string;
  /**
   * Extra lowercase tokens matched but never highlighted (keywords, ids,
   * workspace/branch names, provider, category). Precomputed at build time.
   */
  keywords?: string[];
  /** Epoch ms used for the recency boost and the right-aligned relative time. */
  timestamp?: number;
  /** Renders a retained-item badge; routes chats to the archive viewer. */
  archived?: boolean;
  /**
   * Which retained state the badge names for items owned by a retained
   * container: `deleted` (removed after the retention window) or `archived`
   * (kept until deleted). Legacy per-chat archives leave this unset and keep
   * the plain "Archived" badge.
   */
  archiveState?: 'archived' | 'deleted';
  /** State signal rendered as a pill (e.g. OFF, FAILED, review status). Category labels must NOT use this — see CAN-2687. */
  statusBadge?: string;
  /** Keyboard-shortcut hint rendered on the right (commands only). */
  shortcut?: string;
  /** The owning project's badge, the row glyph for chats and worktrees. */
  project?: PaletteProjectBadge;
  /**
   * Quiet text at the row's end saying where the item lives: the worktree a
   * chat runs in, or a worktree's branch when its title is a task name.
   */
  context?: string;
  /** Worktree status → colored status dot. */
  worktreeStatus?: WorktreeUiStatus;
  /** Agent provider (`claude` | `codex` | …) → provider glyph on chat rows. */
  providerType?: string | null;
  /**
   * Highlight ranges into {@link subtitle} for tier-2 transcript snippets. When
   * present the row highlights the subtitle (the FTS snippet) rather than the
   * title.
   */
  subtitleMatchRanges?: readonly ChatSearchMatchRange[];
  /** The subtitle quotes a prompt, so session replay blocks it. */
  subtitleReplayBlocked?: boolean;
  /** The title is a user-authored project, chat, or worktree name, so session
   * replay masks it. */
  titleReplayMasked?: boolean;
  /** The subtitle names a project or worktree, so session replay masks it. */
  subtitleReplayMasked?: boolean;
  /** Perform this item's navigation/side-effect. */
  execute: () => Promise<CommandExecutionResult> | CommandExecutionResult;
}

/** Kind-specific navigation data kept separate from rendering and scoring. */
export interface PaletteNavigationByKind {
  command: { type: 'command'; commandKey: string };
  worktree: { type: 'worktree'; projectId: string; worktreeId: string };
  archive: { type: 'archive'; projectId: string; containerId: string };
  chat: {
    type: 'chat';
    projectId: string;
    worktreeId: string;
    chatId: string;
    source: Exclude<ChatSearchSource, 'plan'>;
  };
  'chat-content': {
    type: 'chat-content';
    projectId: string;
    worktreeId: string;
    chatId: string;
    source: Exclude<ChatSearchSource, 'plan'>;
  };
  plan: { type: 'plan'; projectId: string; worktreeId: string; planId: string };
  pipeline: { type: 'pipeline'; pipelineId: string; filePath?: string };
  automation: { type: 'automation'; activityId: string };
  watcher: { type: 'watcher'; watcherId: string };
  agent: { type: 'agent'; agentId: string };
  plugin: { type: 'plugin'; marketplaceId: string; pluginName: string };
  skill: { type: 'skill'; sourceId: string; skillName: string };
  setting:
    | { type: 'setting'; section: SettingsSection }
    // An account or organization page inside Settings, by its web path.
    | { type: 'setting-route'; path: string };
}

/**
 * Discriminated result union. Narrowing `kind` also narrows the typed
 * navigation payload, preventing providers from emitting incomplete targets.
 */
export type PaletteItem = {
  [Kind in PaletteItemKind]: PaletteItemBase & {
    kind: Kind;
    navigation: PaletteNavigationByKind[Kind];
  };
}[PaletteItemKind];

export interface PaletteSectionMeta {
  /** Stable section key (also used as a `data-testid` suffix). */
  id: string;
  /** User-facing section header. */
  label: string;
}

/**
 * Section a given item kind belongs to. `chat` and `chat-content` are distinct
 * sections: title matches live under "Chats" (stable indices), transcript
 * matches are appended under "In transcripts" once the deferred query resolves.
 */
export const PALETTE_SECTION_BY_KIND: Record<
  PaletteItemKind,
  PaletteSectionMeta
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
  // Mixed deferred FTS results (chat transcripts + plan content). The section
  // id predates plan docs and is kept for `data-palette-section` stability.
  'chat-content': { id: 'transcripts', label: 'In content' },
};

/**
 * Canonical section order, used as the tie-breaker when two sections' best
 * matches score equally. At query time sections are ordered by their strongest
 * match (see `rankPaletteItems`) with commands pinned last (search-first), and
 * the deferred transcript section is always appended at the very end so
 * existing indices and the keyboard selection stay stable when tier-2 results
 * arrive.
 */
export const PALETTE_SECTION_ORDER: readonly PaletteItemKind[] = [
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

/** Max rows shown per grouped section before truncation. */
export const PALETTE_SECTION_CAP = 6;

/** Max rows shown in the empty-query "Recent" section. */
export const PALETTE_RECENT_CAP = 8;
