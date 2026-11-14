import type {
  ChatSearchMatchRange,
  ChatSearchSource,
} from '@canopy/desktop-shared/types';
import type { WorktreeUiStatus } from '@/lib/worktree-status';
import type { SettingsSection } from '@/components/settings/SettingsNav';
import type {
  SearchPaletteItemKind,
  SearchPaletteProjectBadge,
} from '@canopy/ui-app/search-palette';
import type { CommandExecutionResult } from './paletteCommands';

/**
 * Every searchable/actionable target in the unified Cmd+K palette, one of
 * the shared palette's kinds. Entity kinds are sourced from renderer
 * stores/hooks (tier 0) and the chat-search catalog (tier 1), while
 * `chat-content` rows come from the deferred transcript query (tier 2).
 */
type PaletteItemKind = SearchPaletteItemKind;

/**
 * The owning project's badge, plus the repository whose owner avatar the
 * desktop resolves over IPC (`ProjectIcon`).
 */
export interface PaletteProjectBadge extends SearchPaletteProjectBadge {
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
