import type { JSX } from 'react';
import { ChevronDownMediumIcon } from '../icons/AppIcons';
import {
  WorkspaceSectionHeader,
  type WorkspaceSectionHeaderContextAction,
} from './WorkspaceSectionHeader';

export interface HiddenItemsRowProps {
  readonly label: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly dataTestId?: string;
  readonly touchTarget?: boolean;
  /** Right-click actions over every hidden item, such as Archive all. */
  readonly contextMenuActions?: readonly WorkspaceSectionHeaderContextAction[];
  readonly contextMenuLabel?: string;
}

/**
 * The hidden workspaces or worktrees row, built on the same row primitive as
 * every workspace header. This keeps its icon slot, typography, hover surface, and
 * trailing counter aligned with the surrounding project rows.
 */
export function HiddenItemsRow({
  label,
  count,
  expanded,
  onToggle,
  dataTestId,
  touchTarget = false,
  contextMenuActions,
  contextMenuLabel,
}: HiddenItemsRowProps): JSX.Element {
  const hasActions =
    contextMenuActions !== undefined && contextMenuActions.length > 0;
  return (
    <WorkspaceSectionHeader
      name={label}
      // A quiet disclosure row, in the grey of the sidebar's other
      // secondary rows rather than a project's name ink.
      nameTone="secondary"
      contextMenuActions={hasActions ? contextMenuActions : undefined}
      contextMenuLabel={hasActions ? contextMenuLabel : undefined}
      // Touch has no right-click: a More actions button opens the same menu.
      optionsOpensContextMenu={hasActions}
      hideOptionsForFinePointer
      workspaceType="single-repo"
      worktreeCount={count}
      textScale="sidebar"
      collapsed={!expanded}
      canToggleCollapse={count > 0}
      disableDrag
      showCollapseChevron={false}
      onToggleCollapse={onToggle}
      primaryButtonDataAttrs={
        dataTestId ? { 'data-testid': dataTestId } : undefined
      }
      touchTarget={touchTarget}
      dragHandleSlot={
        <span
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center fg-secondary"
          aria-hidden="true"
          data-hidden-items-disclosure-icon=""
        >
          <ChevronDownMediumIcon
            size={16}
            className={expanded ? undefined : '-rotate-90'}
          />
        </span>
      }
    />
  );
}
