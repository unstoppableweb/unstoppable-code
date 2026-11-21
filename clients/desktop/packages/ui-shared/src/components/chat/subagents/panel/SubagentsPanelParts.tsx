import { LoadingIndicator } from '../../../LoadingIndicatorStyle';
import type { JSX, ReactNode } from 'react';
import type {
  SubagentNode,
  SubagentLevelsSetting,
  SubagentTree,
} from '@canopy/agent-transcript';
import {
  SUBAGENTS_EMPTY_BODY,
  SUBAGENTS_EMPTY_TITLE,
  SUBAGENTS_FILTER_EMPTY_ACTIVE,
  SUBAGENTS_FILTER_EMPTY_ATTENTION,
  SUBAGENTS_LEVELS_ALL_LABEL,
  SUBAGENTS_LEVELS_AUTO_LABEL,
  SUBAGENTS_LEVELS_MENU_LABEL,
  SUBAGENTS_NO_ROOTS_BODY,
  SUBAGENTS_NO_ROOTS_TITLE,
  SUBAGENTS_ROOT_SECTION_ACTIVE,
  SUBAGENTS_ROOT_SECTION_FINISHED,
  SUBAGENTS_SHOW_ALL_LABEL,
  SUBAGENTS_UNAVAILABLE_TITLE,
  subagentsCountLabel,
  subagentsFocusContextLabel,
  subagentsFocusUpAccessibleLabel,
  subagentsLevelsAllDescription,
  subagentsLevelsAutoDescription,
  subagentsLevelsCountLabel,
  subagentsRootLiveDetail,
} from '../subagent-copy';
import {
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuSection,
  PickerMenuSectionLabel,
} from '../../../PickerMenu';
import { formatRelativeTime } from '../../../../lib/format-relative-time';
import { REPLAY_MASK_CLASS } from '../../../../lib/replay-privacy';
import { ThinkingSpinner } from '../../../ThinkingSpinner';
import { ChatIcon, ChevronLeftMediumIcon } from '../../../../icons/AppIcons';
import { HeaderActionButton } from '../../../HeaderActionButton';
import { SubagentIcon } from '../../../../icons/SubagentIcon';
import { SubagentWorkflowMark } from '../common/SubagentWorkflow';
import { subagentAncestors } from '@canopy/agent-transcript';

/** Root picker menu body shared by worktree, Work Entry and App Advisor hosts. */
export interface SubagentsRootPickerMenuProps {
  /** Open root chats, already ordered live-first and by recent activity. */
  readonly roots: readonly SubagentsRootPickerItem[];
  /** Current selection, if the host has one. */
  readonly selectedRootId: string | null;
  /** Selects a root chat and closes its owning menu. */
  readonly onSelectRoot: (rootId: string) => void;
}

/** Browser-safe display facts for one root-chat choice. */
export interface SubagentsRootPickerItem {
  readonly id: string;
  readonly title: string;
  readonly total: number;
  readonly live: number;
  readonly lastActivityAt?: number;
  readonly loading?: boolean;
}

function RootPickerOption({
  root,
  selected,
  onSelectRoot,
}: {
  readonly root: SubagentsRootPickerItem;
  readonly selected: boolean;
  readonly onSelectRoot: (rootId: string) => void;
}): JSX.Element {
  const detail = root.loading ? (
    <LoadingIndicator />
  ) : root.live > 0 ? (
    subagentsRootLiveDetail(root.live, root.total)
  ) : (
    `${subagentsCountLabel(root.total)} · ${formatRelativeTime(root.lastActivityAt)}`
  );
  return (
    <PickerMenuOption
      role="menuitemradio"
      aria-checked={selected}
      selected={selected}
      data-testid={`subagents-root-option-${root.id}`}
      onClick={(): void => onSelectRoot(root.id)}
    >
      <PickerMenuOptionLeading
        data-testid="subagents-root-status"
        tone={root.live > 0 ? 'accent' : 'tertiary'}
      >
        {root.live > 0 ? (
          // A chat tab's working spinner.
          <ThinkingSpinner sizePx={12} tone="accent" />
        ) : (
          <ChatIcon size={14} />
        )}
      </PickerMenuOptionLeading>
      <PickerMenuOptionContent>
        <PickerMenuOptionLabel>
          <span className={REPLAY_MASK_CLASS}>{root.title}</span>
        </PickerMenuOptionLabel>
        <PickerMenuOptionDescription>{detail}</PickerMenuOptionDescription>
      </PickerMenuOptionContent>
      <PickerMenuOptionCheck selected={selected} />
    </PickerMenuOption>
  );
}

/** Finished roots, divided from Active roots only when there are any. */
function FinishedSection({
  divided,
  children,
}: {
  readonly divided: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return divided ? (
    <PickerMenuSection>{children}</PickerMenuSection>
  ) : (
    <div>{children}</div>
  );
}

/** Content for the root-chat picker popover. */
export function SubagentsRootPickerMenu({
  roots,
  selectedRootId,
  onSelectRoot,
}: SubagentsRootPickerMenuProps): JSX.Element {
  const active = roots.filter((root) => root.live > 0);
  const finished = roots.filter((root) => root.live === 0);
  return (
    <div>
      {active.length > 0 ? (
        <>
          <PickerMenuSectionLabel>
            {SUBAGENTS_ROOT_SECTION_ACTIVE}
          </PickerMenuSectionLabel>
          {active.map((root) => (
            <RootPickerOption
              key={root.id}
              root={root}
              selected={root.id === selectedRootId}
              onSelectRoot={onSelectRoot}
            />
          ))}
        </>
      ) : null}
      {finished.length > 0 ? (
        <FinishedSection divided={active.length > 0}>
          <PickerMenuSectionLabel>
            {SUBAGENTS_ROOT_SECTION_FINISHED}
          </PickerMenuSectionLabel>
          {finished.map((root) => (
            <RootPickerOption
              key={root.id}
              root={root}
              selected={root.id === selectedRootId}
              onSelectRoot={onSelectRoot}
            />
          ))}
        </FinishedSection>
      ) : null}
    </div>
  );
}

/** Level-setting menu options. All controls remain display-only. */
export interface SubagentsLevelsMenuProps {
  /** Currently persisted setting for this root chat. */
  readonly value: SubagentLevelsSetting;
  /** Auto's current canvas-width-derived level count. */
  readonly autoLevels: number;
  /** Maximum numbered level available to this panel. */
  readonly maxDepth: number;
  /** Actual deepest node in the selected tree, used by All's description. */
  readonly treeDepth: number;
  /** Updates this root chat's setting and closes the menu. */
  readonly onChange: (value: SubagentLevelsSetting) => void;
}

function LevelOption({
  value,
  selected,
  description,
  onChange,
}: {
  readonly value: SubagentLevelsSetting;
  readonly selected: boolean;
  readonly description?: string;
  readonly onChange: (value: SubagentLevelsSetting) => void;
}): JSX.Element {
  const key = typeof value === 'number' ? String(value) : value;
  const label =
    value === 'auto'
      ? SUBAGENTS_LEVELS_AUTO_LABEL
      : value === 'all'
        ? SUBAGENTS_LEVELS_ALL_LABEL
        : String(value);
  return (
    <PickerMenuOption
      role="menuitemradio"
      aria-checked={selected}
      selected={selected}
      data-testid={`subagents-levels-option-${key}`}
      onClick={(): void => onChange(value)}
    >
      <PickerMenuOptionCheck selected={selected} reserveSpace />
      <PickerMenuOptionContent>
        <PickerMenuOptionLabel>{label}</PickerMenuOptionLabel>
        {description ? (
          <PickerMenuOptionDescription>
            {description}
          </PickerMenuOptionDescription>
        ) : null}
      </PickerMenuOptionContent>
    </PickerMenuOption>
  );
}

/** Content for the Levels picker menu. */
export function SubagentsLevelsMenu({
  value,
  autoLevels,
  maxDepth,
  treeDepth,
  onChange,
}: SubagentsLevelsMenuProps): JSX.Element {
  const numbered: number[] = [];
  for (let level = 3; level <= maxDepth; level += 1) numbered.push(level);
  return (
    <div>
      <PickerMenuSectionLabel>
        {SUBAGENTS_LEVELS_MENU_LABEL}
      </PickerMenuSectionLabel>
      <LevelOption
        value="auto"
        selected={value === 'auto'}
        description={subagentsLevelsAutoDescription(autoLevels)}
        onChange={onChange}
      />
      <LevelOption
        value="all"
        selected={value === 'all'}
        description={subagentsLevelsAllDescription(treeDepth)}
        onChange={onChange}
      />
      {numbered.map((level) => (
        <LevelOption
          key={level}
          value={level}
          selected={value === level}
          description={subagentsLevelsCountLabel(level)}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

/** Focus bar actions for a focused tree window. */
export interface SubagentsFocusBarProps {
  /** Source tree used to find the nearest visible parent. */
  readonly tree: SubagentTree;
  /** Currently focused task. */
  readonly focusedNode: SubagentNode;
  /** Moves focus to the closest ancestor that remains in the projection. */
  readonly onFocusUp: () => void;
  /** Leaves focus and returns to the full tree. */
  readonly onShowAll: () => void;
}

/** Compact breadcrumb-like context and controls for the focused tree. */
export function SubagentsFocusBar({
  tree,
  focusedNode,
  onFocusUp,
  onShowAll,
}: SubagentsFocusBarProps): JSX.Element {
  const ancestors = subagentAncestors(tree, focusedNode.id);
  const parent = ancestors[0];
  const parentTitle = parent?.title ?? tree.root.title;
  return (
    <div
      data-testid="subagents-focus-bar"
      className="flex shrink-0 items-center gap-2 border-b bg-secondary px-2 py-1.5"
    >
      <HeaderActionButton
        iconOnly
        tone="neutral"
        aria-label={subagentsFocusUpAccessibleLabel(parentTitle)}
        onClick={onFocusUp}
      >
        <ChevronLeftMediumIcon size={14} aria-hidden />
      </HeaderActionButton>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
        {focusedNode.kind === 'workflow-run' ? (
          <SubagentWorkflowMark size={12} />
        ) : focusedNode.kind === 'workflow-phase' ? null : (
          <span className="inline-flex shrink-0 fg-accent">
            <SubagentIcon size={12} />
          </span>
        )}
        <span className={`${REPLAY_MASK_CLASS} shrink-0 fg-primary`}>
          {focusedNode.title}
        </span>
        <span className="min-w-0 truncate fg-tertiary">
          {subagentsFocusContextLabel(parentTitle, focusedNode.depth)}
        </span>
      </span>
      <HeaderActionButton tone="neutral" onClick={onShowAll}>
        {SUBAGENTS_SHOW_ALL_LABEL}
      </HeaderActionButton>
    </div>
  );
}

/** Named empty-state variants presented in the panel's content area. */
export type SubagentsEmptyStateKind =
  | 'no-roots'
  | 'root-empty'
  | 'filter-active'
  | 'filter-attention'
  | 'unavailable';

/** Pure empty-state body using the product's shared subagent copy. */
export function SubagentsEmptyState({
  kind,
}: {
  readonly kind: SubagentsEmptyStateKind;
}): JSX.Element {
  const title =
    kind === 'no-roots'
      ? SUBAGENTS_NO_ROOTS_TITLE
      : kind === 'root-empty'
        ? SUBAGENTS_EMPTY_TITLE
        : kind === 'filter-active'
          ? SUBAGENTS_FILTER_EMPTY_ACTIVE
          : kind === 'filter-attention'
            ? SUBAGENTS_FILTER_EMPTY_ATTENTION
            : SUBAGENTS_UNAVAILABLE_TITLE;
  const body =
    kind === 'no-roots'
      ? SUBAGENTS_NO_ROOTS_BODY
      : kind === 'root-empty'
        ? SUBAGENTS_EMPTY_BODY
        : null;
  return (
    <div
      data-testid={
        kind === 'root-empty' ? 'subagents-empty' : `subagents-empty-${kind}`
      }
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center"
    >
      <p className="text-s font-medium fg-primary">{title}</p>
      {body ? <p className="max-w-md text-xs fg-tertiary">{body}</p> : null}
    </div>
  );
}
