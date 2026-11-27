import { Menu, HeaderActionButton } from '@canopy/ui-shared';
import {
  Surface,
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import {
  ChangesIcon,
  ChevronTopMediumIcon,
  DetailsIcon,
  FocusSquareIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PageTextAddIcon,
  RefreshIcon,
  SearchIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useRef, useState, type JSX, type ReactNode } from 'react';

/** One toolbar contract for both presentations of a file panel's embedded tree. */
export interface EmbeddedFileTreeToolbarProps {
  mode: 'file' | 'diff';
  onModeChange: (mode: 'file' | 'diff') => void;
  filter?: ReactNode;
  listView?: boolean;
  onToggleListView?: () => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  onFocusFile: () => void;
  focusDisabled?: boolean;
  onRefresh: () => void;
  refreshDisabled?: boolean;
  onCollapseAll: () => void;
  collapseDisabled?: boolean;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  createDisabled?: boolean;
}

export function EmbeddedFileTreeToolbar({
  mode,
  onModeChange,
  filter,
  listView,
  onToggleListView,
  searchOpen,
  onToggleSearch,
  onFocusFile,
  focusDisabled,
  onRefresh,
  refreshDisabled,
  onCollapseAll,
  collapseDisabled,
  onNewFile,
  onNewFolder,
  createDisabled,
}: EmbeddedFileTreeToolbarProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  // Early access draws the overflow glyph from the app icon set like its
  // neighbours; off keeps the original dots.
  const OverflowIcon = MoreHorizontalIcon;
  const menuItems: ActionMenuItem[] = [
    ...(mode === 'file'
      ? [
          {
            key: 'new-file',
            label: 'New file…',
            icon: <PageTextAddIcon />,
            disabled: createDisabled,
            testId: 'files-tree-new-file',
            onSelect: onNewFile,
          },
          {
            key: 'new-folder',
            label: 'New folder…',
            icon: <FolderPlusIcon />,
            disabled: createDisabled,
            testId: 'files-tree-new-folder',
            onSelect: onNewFolder,
          },
        ]
      : []),
    {
      key: 'refresh',
      label: 'Refresh files',
      icon: <RefreshIcon />,
      disabled: refreshDisabled,
      testId: 'files-tree-refresh',
      separatorBefore: mode === 'file',
      onSelect: onRefresh,
    },
    {
      key: 'collapse-all',
      label: 'Collapse all',
      icon: <ChevronTopMediumIcon />,
      disabled: collapseDisabled,
      testId: 'files-tree-collapse-all',
      onSelect: onCollapseAll,
    },
  ];
  const selectMenuItem = (item: ActionMenuItem): void => {
    if (item.disabled) return;
    item.onSelect?.();
    setOpen(false);
    anchor.current?.focus({ preventScroll: true });
  };
  return (
    <Surface variant="section" boundary="frame">
      <div
        className="flex shrink-0 items-center justify-between px-2 py-1"
        data-testid="file-tree-toolbar"
      >
        <HeaderActionButton
          iconOnly
          tone={mode === 'diff' ? 'accent' : 'neutral'}
          aria-label="Show changed files"
          aria-pressed={mode === 'diff'}
          onClick={() => onModeChange(mode === 'diff' ? 'file' : 'diff')}
        >
          <ChangesIcon size="sm" />
        </HeaderActionButton>
        <div className="flex items-center gap-0.5">
          {mode === 'diff' && (
            <HeaderActionButton
              iconOnly
              tone={listView ? 'accent' : 'neutral'}
              aria-label="List view"
              aria-pressed={listView ?? false}
              onClick={onToggleListView}
            >
              <DetailsIcon size="sm" />
            </HeaderActionButton>
          )}
          {mode === 'diff' && filter}
          <HeaderActionButton
            iconOnly
            tone="neutral"
            aria-label="Search files"
            aria-expanded={searchOpen}
            onClick={onToggleSearch}
            data-testid="files-tree-search-toggle"
          >
            <SearchIcon size={16} />
          </HeaderActionButton>
          <HeaderActionButton
            iconOnly
            tone="neutral"
            aria-label="Jump to file"
            onClick={onFocusFile}
            disabled={focusDisabled}
            data-testid="files-tree-jump-to-file"
          >
            <FocusSquareIcon size={16} />
          </HeaderActionButton>
          <HeaderActionButton
            ref={anchor}
            iconOnly
            tone="neutral"
            aria-label="File tree actions"
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={() => setOpen(!open)}
          >
            <OverflowIcon size="sm" />
          </HeaderActionButton>
        </div>
        <Menu
          open={open}
          onOpenChange={setOpen}
          anchorRef={anchor}
          placement="bottom-right"
        >
          <ActionMenuRowStyle>
            <ActionMenuItems items={menuItems} onSelect={selectMenuItem} />
          </ActionMenuRowStyle>
        </Menu>
      </div>
    </Surface>
  );
}
