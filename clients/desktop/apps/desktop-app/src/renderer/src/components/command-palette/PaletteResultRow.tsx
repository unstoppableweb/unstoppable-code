import { Badge } from '@canopy/ui-shared/components/Badge';
import { memo, type JSX } from 'react';
import {
  ArchiveIcon,
  Bot,
  CalendarClock,
  ClipboardList,
  Eye,
  FileText,
  MessageSquare,
  Puzzle,
  Settings,
  Sparkles,
  Terminal,
  Workflow,
  GitBranch,
  type AppIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  HighlightedSegments,
  rangesToIndices,
  splitMatchSegments,
} from '@canopy/ui-shared';
import { ListRow, SearchPaletteRowContext } from '@canopy/ui-shared/components';
import { ProjectIcon } from '@/components/shared/ProjectIcon';
import type { PaletteItem, PaletteItemKind } from './paletteItems';

// One glyph per kind, at the default icon step like every menu row. Chats,
// worktrees and archived containers draw their project's badge instead, as
// the sidebar does.
const KIND_ICON: Record<PaletteItemKind, AppIcon> = {
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

interface PaletteResultRowProps {
  item: PaletteItem;
  titleIndices: number[];
  index: number;
  isSelected: boolean;
  onHover: (index: number) => void;
  onActivate: (item: PaletteItem) => void;
  registerRef: (index: number, node: HTMLLIElement | null) => void;
}

function RowGlyph({ item }: { item: PaletteItem }): JSX.Element {
  const testId = `command-palette-kind-${item.kind}`;
  if (item.project) {
    return (
      <span
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} inline-flex`}
        data-testid={testId}
        aria-hidden
      >
        <ProjectIcon
          kind={item.project.kind}
          color={item.project.color}
          temporary={item.project.temporary}
          repoPath={item.project.repoPath}
        />
      </span>
    );
  }
  const Icon = KIND_ICON[item.kind];
  return <Icon data-testid={testId} aria-hidden />;
}

function PaletteResultRowInner({
  item,
  titleIndices,
  index,
  isSelected,
  onHover,
  onActivate,
  registerRef,
}: PaletteResultRowProps): JSX.Element {
  const commandTestId =
    item.kind === 'command' &&
    (item.navigation.commandKey === 'open-cost-panel' ||
      item.navigation.commandKey === 'open-session-breakdown')
      ? `command-palette-command-${item.navigation.commandKey}`
      : 'command-palette-result';
  // A content hit (a transcript or plan snippet) leads with the matching
  // line and names its chat or plan at the end. Session replay blocks the
  // snippet: it quotes chat or plan text.
  const contentHit = item.subtitle !== undefined && item.subtitleMatchRanges;
  const primary = contentHit ? (
    <span className={`${POSTHOG_REPLAY_BLOCK_CLASS} min-w-0 truncate`}>
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
          ? `${POSTHOG_REPLAY_MASK_CLASS} min-w-0 truncate`
          : 'min-w-0 truncate'
      }
    >
      <HighlightedSegments
        segments={splitMatchSegments(item.title, titleIndices)}
      />
    </span>
  );
  const context = item.shortcut ? (
    <SearchPaletteRowContext data-testid="command-palette-shortcut">
      {item.shortcut}
    </SearchPaletteRowContext>
  ) : contentHit ? (
    <SearchPaletteRowContext>
      <span
        className={
          item.titleReplayMasked ? POSTHOG_REPLAY_MASK_CLASS : undefined
        }
      >
        {item.title}
      </span>
    </SearchPaletteRowContext>
  ) : item.context ? (
    <SearchPaletteRowContext data-testid="command-palette-context">
      <span className={POSTHOG_REPLAY_MASK_CLASS}>{item.context}</span>
    </SearchPaletteRowContext>
  ) : null;

  return (
    <li
      ref={(node): void => registerRef(index, node)}
      data-palette-kind={item.kind}
    >
      <ListRow
        role="option"
        aria-selected={isSelected}
        selected={isSelected}
        data-testid={commandTestId}
        onMouseEnter={(): void => onHover(index)}
        onClick={(): void => onActivate(item)}
        icon={<RowGlyph item={item} />}
        trailing={
          item.statusBadge || context ? (
            <span className="flex min-w-0 shrink-0 items-center gap-2">
              {item.statusBadge && (
                <Badge data-testid="command-palette-status-badge">
                  {item.statusBadge}
                </Badge>
              )}
              {context}
            </span>
          ) : undefined
        }
      >
        <span className="flex min-w-0 items-center gap-2">
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
      </ListRow>
    </li>
  );
}

export const PaletteResultRow = memo(PaletteResultRowInner);
