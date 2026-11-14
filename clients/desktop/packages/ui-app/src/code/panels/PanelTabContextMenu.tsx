'use client';

/**
 * PanelTabContextMenu — the right-click menu for a panel tab, restoring the
 * VS Code / classic ChatTabBar tab menu on the panel grid: pin/unpin, rename
 * and mark as unread / read (chat panels, when the host supports them),
 * split, new window / full screen, the chat and file rows, then the close
 * rows (close / close others / close
 * to the right / close to the left / close all) as the last group, where the
 * app's action menus keep their removal rows. The split and new window / full
 * screen sections mirror the group overflow menu in `PanelChrome`.
 *
 * It is layout-key addressed so it works for BOTH the main worktree grid and
 * a pulled-out auxiliary window's grid (the two hosts pass their own
 * `layoutKey`). Bulk "Close *" actions never touch pinned tabs (Chrome-like
 * semantics); an individual "Close" on the clicked tab still works regardless
 * of pinned state.
 *
 * Aux-window correctness: `ownerDocument` is threaded through to
 * {@link TabContextMenu} so a right-click inside a pulled-out window opens
 * and positions the menu in THAT window's document, not the main one.
 *
 * Host seam: tab closing defaults to the raw layout-store `closeTab` /
 * `closeTabs` actions; hosts whose panels carry bound sessions (desktop chat
 * ⇄ panel sync) inject sync-aware closers via `onCloseTab`/`onCloseTabs`.
 */
import { type JSX } from 'react';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import type { PanelSplitDirection } from '@canopy/protocol';
import {
  PanelCloseIcon,
  PanelFullScreenIcon,
  PanelNewWindowIcon,
  PanelSplitDirectionIcon,
  type PanelTabStyle,
} from '@canopy/ui-shared/components/panels';
import {
  TabContextMenu,
  type TabContextMenuItem,
} from '@canopy/ui-shared/components';
import {
  ArchiveIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  LayoutWindowIcon,
  MailCheckIcon,
  MailIcon,
  PencilIcon,
  PinIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  usePanelLayoutStore,
  usePanelLayoutViewModel,
} from './panel-layout-store';
import { splitDirectionToDropEdge } from './split-active-tab';

export interface PanelTabContextMenuTarget {
  readonly groupId: string;
  readonly panelId: string;
  readonly x: number;
  readonly y: number;
}

export type ClosePanelTab = (
  layoutKey: string,
  groupId: string,
  panelId: string,
) => void;
export type ClosePanelTabs = (
  layoutKey: string,
  groupId: string,
  panelIds: string[],
) => void;

export interface PanelTabContextMenuProps {
  /** Store layout key the menu's ops dispatch against (main or aux layout). */
  layoutKey: string;
  target: PanelTabContextMenuTarget;
  onClose: () => void;
  /** Owner document for aux windows; defaults to the main renderer document. */
  ownerDocument?: Document;
  /**
   * When provided, chat panels gain a "Share session" scope picker. Omitted
   * by hosts without a worktree scope (e.g. a pulled-out aux window), which
   * simply hide it.
   */
  onShareSession?: (chatTabId: string, ownerDocument?: Document) => void;
  canShareSession?: (chatTabId: string) => boolean;
  /** Opens the secure, one-time session snapshot export confirmation. */
  onExportSession?: (chatTabId: string, ownerDocument?: Document) => void;
  /**
   * Opens the rename dialog for a chat panel. Hosts supply it only when they
   * can persist a chat's custom name; omitted, chat panels offer no Rename.
   */
  onRenameChat?: (chatTabId: string, ownerDocument?: Document) => void;
  /**
   * Current read state of a chat panel, read when the menu opens; undefined
   * where the host has none for that chat, which hides the read item.
   */
  getChatReadState?: (chatTabId: string) => 'read' | 'unread' | undefined;
  /**
   * Marks a chat panel unread (true) or read (false). Omitted, chat panels
   * offer no "Mark as unread" / "Mark as read".
   */
  onSetChatUnread?: (chatTabId: string, unread: boolean) => void;
  /**
   * Opens only the clicked tab in a new auxiliary window. When omitted, the
   * "New window" item is not rendered.
   */
  onNewWindow?: (groupId: string, panelId: string) => void;
  /** App-owned pop-out eligibility check (window-bound tabs return false). */
  canOpenInNewWindow?: (kind: string) => boolean;
  /**
   * Selects the clicked tab and maximizes its group. When omitted, the
   * "Full screen" item is not rendered. Like the group overflow menu, the
   * item is hidden while the group is already maximized and disabled when
   * the layout has a single group.
   */
  onFullScreen?: (groupId: string, panelId: string) => void;
  /** Sync-aware single-tab closer; defaults to the raw store `closeTab`. */
  onCloseTab?: ClosePanelTab;
  /** Sync-aware bulk closer; defaults to the raw store `closeTabs`. */
  onCloseTabs?: ClosePanelTabs;
  /**
   * Whether a tab may be closed. Omitted means all are closable. Bulk actions
   * skip protected tabs the same way they already skip pinned ones; the direct
   * "Close" is disabled when its own tab is protected, so the menu can never
   * offer an action the host will refuse.
   */
  canCloseTab?: (tab: PanelTabModel) => boolean;
  /** Copies a file panel's bound absolute path to the host clipboard. */
  onCopyFilePath?: (absolutePath: string) => void;
  /** Copies a file panel's path relative to its owning workspace. */
  onCopyRelativeFilePath?: (absolutePath: string) => void;
  /** Reveals a file panel's bound absolute path in the host file manager. */
  onOpenFileInFileManager?: (absolutePath: string) => void;
  /** Resolves legacy/persisted file panels that are bound only by fileTabId. */
  resolveFileTabPath?: (fileTabId: string) => string | undefined;
  /** Host-native label, such as "Open in Finder". */
  openInFileManagerLabel?: string;
  getStartPageMenuState?: (
    tab: PanelTabModel,
  ) => { isStartPage: boolean } | null;
  onToggleStartPage?: (tab: PanelTabModel) => void;
  /**
   * Minimal mode's fixed layout. With classic tabs the menu offers only the
   * eligible single-tab Close. With `fill` tabs it leaves out the actions
   * that change the layout's groups (split, new window, full screen) and
   * Close All, which a fixed group refuses; tab-level actions (pin, close,
   * close others, share, copy path) stay.
   */
  layoutLocked?: boolean;
  /**
   * The tab bar's style. `fill` (early access) keeps the fuller Minimal-mode
   * menu described under {@link layoutLocked}.
   */
  tabStyle?: PanelTabStyle;
  /**
   * Presentation for hosts in a document-first mode (desktop Work navigation):
   * a file tab's menu starts with the file-manager item, then Copy path, and
   * leaves out Split and Copy relative path. Chat and other tabs are
   * unchanged. Defaults to the developer ordering.
   */
  fileActionsFirst?: boolean;
  /**
   * The tab's archive row, last among the close rows, when the host offers
   * one: a cloud task's own chat tab, which can't close, archives the task
   * (CAN-6511). Absent leaves the menu unchanged.
   */
  getArchiveAction?: (
    tab: PanelTabModel,
  ) => { readonly label: string; readonly onSelect: () => void } | undefined;
}

const SPLIT_DIRECTIONS: readonly PanelSplitDirection[] = [
  'up',
  'down',
  'left',
  'right',
];

function splitDirectionLabel(direction: PanelSplitDirection): string {
  switch (direction) {
    case 'up':
      return 'Split up';
    case 'down':
      return 'Split down';
    case 'left':
      return 'Split left';
    case 'right':
      return 'Split right';
  }
}

const closeTabWithStore: ClosePanelTab = (layoutKey, groupId, panelId) => {
  usePanelLayoutStore.getState().closeTab(layoutKey, groupId, panelId);
};
const closeTabsWithStore: ClosePanelTabs = (layoutKey, groupId, panelIds) => {
  usePanelLayoutStore.getState().closeTabs(layoutKey, groupId, panelIds);
};

export function PanelTabContextMenu({
  layoutKey,
  target,
  onClose,
  ownerDocument,
  onShareSession,
  canShareSession,
  onExportSession,
  onRenameChat,
  getChatReadState,
  onSetChatUnread,
  onNewWindow,
  canOpenInNewWindow: canOpenInNewWindowKind,
  onFullScreen,
  onCloseTab = closeTabWithStore,
  onCloseTabs = closeTabsWithStore,
  canCloseTab,
  onCopyFilePath,
  onCopyRelativeFilePath,
  onOpenFileInFileManager,
  resolveFileTabPath,
  openInFileManagerLabel = 'Open in file manager',
  getStartPageMenuState,
  onToggleStartPage,
  layoutLocked = false,
  tabStyle = 'classic',
  fileActionsFirst = false,
  getArchiveAction,
}: PanelTabContextMenuProps): JSX.Element | null {
  // Classic tabs in a fixed layout keep the single Close item.
  const closeOnly = layoutLocked && tabStyle !== 'fill';
  const viewModel = usePanelLayoutViewModel(layoutKey);
  const group = viewModel?.groups.find(
    (candidate) => candidate.groupId === target.groupId,
  );
  const tabIndex =
    group?.tabs.findIndex(
      (candidate) => candidate.panelId === target.panelId,
    ) ?? -1;
  const tab = tabIndex >= 0 ? group?.tabs[tabIndex] : undefined;
  if (!group || !tab) return null;

  const store = usePanelLayoutStore.getState;
  const isPinned = tab.pinned === true;
  const canMoveTabToSplit = group.tabs.length > 1;
  const canOpenInNewWindow = canOpenInNewWindowKind?.(tab.kind) ?? true;
  // Protected tabs are skipped by bulk actions exactly as pinned tabs are, so
  // a "Close others" can never silently leave a chat the host refused.
  const closable = (candidate: PanelTabModel): boolean =>
    candidate.pinned !== true && (canCloseTab?.(candidate) ?? true);
  const closeProtected = (panelId: string): boolean => {
    const tab = group.tabs.find((candidate) => candidate.panelId === panelId);
    return tab !== undefined && (canCloseTab?.(tab) ?? true) === false;
  };
  const idsToTheLeft = group.tabs
    .slice(0, tabIndex)
    .filter(closable)
    .map((candidate) => candidate.panelId);
  const idsToTheRight = group.tabs
    .slice(tabIndex + 1)
    .filter(closable)
    .map((candidate) => candidate.panelId);
  const idsExcept = group.tabs
    .filter(
      (candidate) =>
        candidate.panelId !== target.panelId && closable(candidate),
    )
    .map((candidate) => candidate.panelId);
  const idsAll = group.tabs
    .filter(closable)
    .map((candidate) => candidate.panelId);
  // Close rows sit in the last group, in the same ink as the sidebar menus'
  // Archive and Delete.
  const closeTone: TabContextMenuItem['tone'] = 'default';
  // Middle section, matching the group overflow menu: New Window + Full
  // screen. Either may be absent, so the section's divider goes on whichever
  // row comes first.
  const windowItems: TabContextMenuItem[] = [];
  if (onNewWindow) {
    windowItems.push({
      key: 'new-window',
      label: 'New window',
      icon: <PanelNewWindowIcon />,
      testId: 'panel-tab-context-new-window',
      disabled: !canOpenInNewWindow,
      onSelect: (): void => onNewWindow(target.groupId, target.panelId),
    });
  }
  if (onFullScreen && viewModel?.maximizedGroupId !== target.groupId) {
    windowItems.push({
      key: 'full-screen',
      label: 'Full screen',
      icon: <PanelFullScreenIcon />,
      testId: 'panel-tab-context-full-screen',
      // The layout engine cannot maximize a lone group.
      disabled: (viewModel?.groups.length ?? 0) < 2,
      onSelect: (): void => onFullScreen(target.groupId, target.panelId),
    });
  }

  const layoutItems: TabContextMenuItem[] = layoutLocked
    ? []
    : [
        ...SPLIT_DIRECTIONS.map(
          (direction): TabContextMenuItem => ({
            key: `split-${direction}`,
            label: splitDirectionLabel(direction),
            icon: <PanelSplitDirectionIcon direction={direction} />,
            testId: `panel-tab-context-split-${direction}`,
            // Same predicate as the move: a split the store would refuse
            // (a chat leaving the chat group) is not offered.
            disabled:
              !canMoveTabToSplit ||
              !store().canMovePanel(
                layoutKey,
                target.panelId,
                target.groupId,
                splitDirectionToDropEdge(direction),
              ),
            onSelect: (): void => {
              store().movePanel(
                layoutKey,
                target.panelId,
                target.groupId,
                splitDirectionToDropEdge(direction),
              );
            },
          }),
        ),
        ...windowItems.map((item, index) =>
          index === 0 ? { ...item, separatorBefore: true } : item,
        ),
      ];

  const closeItem: TabContextMenuItem = {
    key: 'close',
    label: 'Close',
    icon: <PanelCloseIcon />,
    tone: closeTone,
    testId: 'panel-tab-context-close',
    disabled: closeProtected(target.panelId),
    onSelect: (): void => onCloseTab(layoutKey, target.groupId, target.panelId),
  };

  const archiveAction = getArchiveAction?.(tab);
  const archiveItems: TabContextMenuItem[] =
    archiveAction === undefined
      ? []
      : [
          {
            key: 'archive',
            label: archiveAction.label,
            icon: <ArchiveIcon />,
            tone: closeTone,
            testId: 'panel-tab-context-archive',
            onSelect: archiveAction.onSelect,
          },
        ];
  const closeItems: TabContextMenuItem[] = [
    closeItem,
    {
      key: 'close-others',
      label: 'Close others',
      icon: <PanelCloseIcon />,
      tone: closeTone,
      testId: 'panel-tab-context-close-others',
      disabled: idsExcept.length === 0,
      onSelect: (): void => onCloseTabs(layoutKey, target.groupId, idsExcept),
    },
    {
      key: 'close-right',
      label: 'Close to the right',
      icon: <PanelCloseIcon />,
      tone: closeTone,
      testId: 'panel-tab-context-close-right',
      disabled: idsToTheRight.length === 0,
      onSelect: (): void =>
        onCloseTabs(layoutKey, target.groupId, idsToTheRight),
    },
    {
      key: 'close-left',
      label: 'Close to the left',
      icon: <PanelCloseIcon />,
      tone: closeTone,
      testId: 'panel-tab-context-close-left',
      disabled: idsToTheLeft.length === 0,
      onSelect: (): void =>
        onCloseTabs(layoutKey, target.groupId, idsToTheLeft),
    },
    ...(layoutLocked
      ? []
      : [
          {
            key: 'close-all',
            label: 'Close all',
            icon: <PanelCloseIcon />,
            tone: closeTone,
            testId: 'panel-tab-context-close-all',
            onSelect: (): void =>
              onCloseTabs(layoutKey, target.groupId, idsAll),
          },
        ]),
    ...archiveItems,
  ];

  const chatTabId = tab.kind === 'chat' ? tab.instance?.chatTabId : undefined;
  const filePath =
    tab.kind === 'file-diff'
      ? ((tab.instance?.fileTabId
          ? resolveFileTabPath?.(tab.instance.fileTabId)
          : undefined) ?? tab.instance?.filePath)
      : undefined;
  const startPageState = getStartPageMenuState?.(tab);
  // The menu mounts on open, so this reads the state at open time.
  const chatReadState =
    chatTabId && onSetChatUnread ? getChatReadState?.(chatTabId) : undefined;
  const readStateItem: TabContextMenuItem | undefined =
    chatTabId && onSetChatUnread && chatReadState
      ? chatReadState === 'unread'
        ? {
            key: 'mark-read',
            label: 'Mark as read',
            icon: <MailCheckIcon />,
            testId: 'panel-tab-context-mark-read',
            onSelect: (): void => onSetChatUnread(chatTabId, false),
          }
        : {
            key: 'mark-unread',
            label: 'Mark as unread',
            icon: <MailIcon />,
            testId: 'panel-tab-context-mark-unread',
            onSelect: (): void => onSetChatUnread(chatTabId, true),
          }
      : undefined;
  const copyPathItem: TabContextMenuItem | undefined =
    filePath && onCopyFilePath
      ? {
          key: 'copy-path',
          label: 'Copy path',
          icon: <CopyIcon />,
          testId: 'panel-tab-context-copy-path',
          onSelect: (): void => onCopyFilePath(filePath),
        }
      : undefined;
  const copyRelativePathItem: TabContextMenuItem | undefined =
    filePath && onCopyRelativeFilePath
      ? {
          key: 'copy-relative-path',
          label: 'Copy relative path',
          icon: <CopyIcon />,
          testId: 'panel-tab-context-copy-relative-path',
          onSelect: (): void => onCopyRelativeFilePath(filePath),
        }
      : undefined;
  const openInFileManagerItem: TabContextMenuItem | undefined =
    filePath && onOpenFileInFileManager
      ? {
          key: 'open-in-file-manager',
          label: openInFileManagerLabel,
          icon: <FolderIcon />,
          testId: 'panel-tab-context-open-in-file-manager',
          onSelect: (): void => onOpenFileInFileManager(filePath),
        }
      : undefined;
  const present = (
    items: readonly (TabContextMenuItem | undefined)[],
  ): TabContextMenuItem[] =>
    items.filter((item): item is TabContextMenuItem => item !== undefined);
  const pinItem: TabContextMenuItem = {
    key: 'pin',
    label: isPinned ? 'Unpin tab' : 'Pin tab',
    icon: <PinIcon />,
    testId: 'panel-tab-context-pin',
    onSelect: (): void => {
      store().setTabPinned(
        layoutKey,
        target.groupId,
        target.panelId,
        !isPinned,
      );
    },
  };
  const startPageItems: TabContextMenuItem[] =
    startPageState && onToggleStartPage
      ? [
          {
            key: 'start-page',
            label: startPageState.isStartPage
              ? 'Remove start page'
              : 'Set as start page',
            icon: <LayoutWindowIcon />,
            testId: 'panel-tab-context-start-page',
            onSelect: (): void => onToggleStartPage(tab),
          },
        ]
      : [];
  // Document-first file menu: reveal and Copy path lead, the developer-only
  // Split and Copy relative path drop out, and the window and close rows stay.
  const fileFirstGroups: TabContextMenuItem[][] | undefined =
    fileActionsFirst && filePath && !closeOnly
      ? [
          present([openInFileManagerItem, copyPathItem]),
          [pinItem],
          layoutLocked ? [] : windowItems,
          startPageItems,
          closeItems,
        ]
      : undefined;

  // Each group starts a new section; empty groups drop out, and the divider
  // goes on the first row of every group after the first.
  const groups: TabContextMenuItem[][] = closeOnly
    ? [[closeItem, ...archiveItems]]
    : (fileFirstGroups ?? [
        [
          pinItem,
          ...(onRenameChat && chatTabId
            ? [
                {
                  key: 'rename',
                  label: 'Rename…',
                  icon: <PencilIcon />,
                  testId: 'panel-tab-context-rename',
                  onSelect: (): void => onRenameChat(chatTabId, ownerDocument),
                },
              ]
            : []),
          ...present([readStateItem]),
        ],
        layoutItems,
        chatTabId
          ? [
              ...(onShareSession && (canShareSession?.(chatTabId) ?? true)
                ? [
                    {
                      key: 'share-session',
                      label: 'Share session',
                      icon: <ShareIcon />,
                      testId: 'panel-tab-context-share-run',
                      onSelect: (): void =>
                        onShareSession(chatTabId, ownerDocument),
                    },
                  ]
                : []),
              ...(onExportSession
                ? [
                    {
                      key: 'export-session',
                      label: 'Export session',
                      icon: <DownloadIcon />,
                      testId: 'panel-tab-context-export-session',
                      onSelect: (): void =>
                        onExportSession(chatTabId, ownerDocument),
                    },
                  ]
                : []),
            ]
          : [],
        present([copyPathItem, copyRelativePathItem, openInFileManagerItem]),
        startPageItems,
        closeItems,
      ]);
  const items: TabContextMenuItem[] = groups
    .filter((group) => group.length > 0)
    .flatMap((group, groupIndex) =>
      group.map((item, index) =>
        index === 0 && groupIndex > 0
          ? { ...item, separatorBefore: true }
          : item,
      ),
    );

  return (
    <TabContextMenu
      x={target.x}
      y={target.y}
      items={items}
      onClose={onClose}
      ownerDocument={ownerDocument}
      dataTestId="panel-tab-context-menu"
    />
  );
}
