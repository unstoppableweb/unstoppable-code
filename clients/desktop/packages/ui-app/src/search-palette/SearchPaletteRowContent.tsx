import type { JSX, ReactNode } from 'react';
import {
  ArchiveIcon,
  Bot,
  CalendarClock,
  ClipboardList,
  Eye,
  FileText,
  GitBranch,
  MessageSquare,
  Puzzle,
  Settings,
  Sparkles,
  Terminal,
  Workflow,
  type AppIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  Badge,
  HighlightedSegments,
  PickerMenuOptionTrailing,
  ProjectAvatarBadge,
  SearchPaletteRowContext,
  rangesToIndices,
  splitMatchSegments,
} from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import type {
  SearchPaletteItem,
  SearchPaletteItemKind,
} from './search-palette-items';

// One glyph per kind, at the default icon step like every menu row. Chats,
// worktrees and archived containers draw their project's badge instead, as
// the sidebar does.
const KIND_ICON: Record<SearchPaletteItemKind, AppIcon> = {
  command: Terminal,
  archive: ArchiveIcon,
  chat: MessageSquare,
  'chat-content': FileText,
  plan: ClipboardList,
  pipeline: Workflow,
  automation: CalendarClock,
  watcher: Eye,
  agent: Bot,
  plugin: Puzzle,
  skill: Sparkles,
  setting: Settings,
  worktree: GitBranch,
};

interface SearchPaletteRowContentProps {
  readonly item: SearchPaletteItem;
  readonly titleIndices: readonly number[];
  /**
   * The project badge, when the host resolves avatars itself (desktop reads
   * a repository's owner avatar over IPC). Unset draws the item's
   * `avatarUrl` over the kind badge.
   */
  readonly projectBadge?: ReactNode;
}

function RowGlyph({
  item,
  projectBadge,
}: {
  readonly item: SearchPaletteItem;
  readonly projectBadge?: ReactNode;
}): JSX.Element {
  const testId = `command-palette-kind-${item.kind}`;
  const project = item.project;
  if (project) {
    return (
      // Session replay blocks the badge: it can show a repository owner's
      // avatar.
      <span
        className={`${REPLAY_BLOCK_CLASS} inline-flex`}
        data-testid={testId}
        aria-hidden
      >
        {projectBadge ?? (
          <ProjectAvatarBadge
            kind={project.kind}
            color={project.color}
            temporary={project.temporary}
            avatarUrl={project.avatarUrl}
          />
        )}
      </span>
    );
  }
  const Icon = KIND_ICON[item.kind];
  return <Icon data-testid={testId} aria-hidden />;
}

/**
 * One result line inside its picker option: the kind's glyph (or the
 * project's badge), the title with its match highlighted, and quiet text at
 * the end naming where it lives or its shortcut. A content hit leads with
 * its matching line instead.
 */
export function SearchPaletteRowContent({
  item,
  titleIndices,
  projectBadge,
}: SearchPaletteRowContentProps): JSX.Element {
  // A content hit (a transcript or plan snippet) leads with the matching
  // line and names its chat or plan at the end. Session replay blocks the
  // snippet: it quotes chat or plan text.
  const contentHit = item.subtitle !== undefined && item.subtitleMatchRanges;
  const primary = contentHit ? (
    <span className={`${REPLAY_BLOCK_CLASS} min-w-0 truncate`}>
      <HighlightedSegments
        segments={splitMatchSegments(
          item.subtitle ?? '',
          rangesToIndices([...(item.subtitleMatchRanges ?? [])]),
        )}
      />
    </span>
  ) : (
    <span
      className={
        item.titleReplayMasked
          ? `${REPLAY_MASK_CLASS} min-w-0 truncate`
          : 'min-w-0 truncate'
      }
    >
      <HighlightedSegments
        segments={splitMatchSegments(item.title, [...titleIndices])}
      />
    </span>
  );
  const context = item.shortcut ? (
    <SearchPaletteRowContext data-testid="command-palette-shortcut">
      {item.shortcut}
    </SearchPaletteRowContext>
  ) : contentHit ? (
    <SearchPaletteRowContext>
      <span className={item.titleReplayMasked ? REPLAY_MASK_CLASS : undefined}>
        {item.title}
      </span>
    </SearchPaletteRowContext>
  ) : item.context ? (
    <SearchPaletteRowContext data-testid="command-palette-context">
      <span className={REPLAY_MASK_CLASS}>{item.context}</span>
    </SearchPaletteRowContext>
  ) : null;

  return (
    <>
      <span className="inline-flex h-5 w-4 shrink-0 items-center justify-center">
        <RowGlyph item={item} projectBadge={projectBadge} />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {primary}
        {item.archived && (
          <span
            data-testid="command-palette-archive-badge"
            data-archive-state={item.archiveState ?? 'archived'}
            className="inline-flex shrink-0"
          >
            <Badge>
              {item.archiveState === 'deleted' ? 'Deleted' : 'Archived'}
            </Badge>
          </span>
        )}
      </span>
      {(item.statusBadge || context) && (
        <span className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
          {item.statusBadge && (
            <Badge data-testid="command-palette-status-badge">
              {item.statusBadge}
            </Badge>
          )}
          {/* The picker row's trailing part sets the quiet type. */}
          {context && (
            <PickerMenuOptionTrailing>{context}</PickerMenuOptionTrailing>
          )}
        </span>
      )}
    </>
  );
}
