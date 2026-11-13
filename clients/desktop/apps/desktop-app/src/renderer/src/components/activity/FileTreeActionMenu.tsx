import { useEffect, useState, type JSX } from 'react';
import {
  FileTreeContextMenu,
  type FileTreeMenuKey,
  type FileTreeMenuLabels,
} from '@canopy/ui-app';
import type {
  DetectedApp,
  FileTreeEntry,
  FileTreeRoot,
} from '@canopy/desktop-shared/types';
import { copyTextToClipboard } from '@/lib/clipboard';
import { buildFileReferenceDisplayPath } from '@/lib/fileMentionSearch';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import { selectPreferredOpenApp } from '../worktree/openInAppSelection';

export interface FileTreeActionNode {
  id: string;
  kind: 'file' | 'folder';
  name: string;
  relativePath: string;
  absolutePath: string;
  root: FileTreeRoot;
  repoCount: number;
}

export interface FileTreeFileActionTarget {
  kind: 'file';
  entry: FileTreeEntry;
  root: FileTreeRoot;
  repoCount: number;
  copyPath: string;
  x: number;
  y: number;
  node: FileTreeActionNode;
  /** Defaults to true. Changed Files marks deleted paths as unavailable. */
  fileExists?: boolean;
  /** Existing path to reveal when the target path itself is unavailable. */
  fileManagerPath?: string;
}

export interface FileTreeFolderActionTarget {
  kind: 'folder';
  copyPath: string;
  absolutePath: string;
  x: number;
  y: number;
  node: FileTreeActionNode;
}

export type FileTreeActionTarget =
  | FileTreeFileActionTarget
  | FileTreeFolderActionTarget;

export type FileTreeMenuAction =
  | 'open'
  | 'open-side'
  | 'open-external'
  | 'new-file'
  | 'new-folder'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'rename'
  | 'delete';

export interface FileTreeActionMenuProps {
  target: FileTreeActionTarget;
  onClose: () => void;
  onOpenInFileManager: (absolutePath: string) => void;
  onAction: (action: FileTreeMenuAction, target: FileTreeActionTarget) => void;
  onOpenInApp: (appId: string) => void;
  canPaste: boolean;
  variant?: 'explorer' | 'changed-file' | 'diff-tree';
  startPageState?: { isStartPage: boolean; toggle: () => void };
}

/** Desktop's current copy; the shared defaults use sentence case. */
const DESKTOP_FILE_TREE_MENU_LABELS: Partial<FileTreeMenuLabels> = {
  newFile: 'New file…',
  newFolder: 'New folder…',
  mention: 'Send to chat',
  copyPath: 'Copy relative path',
};

/** Test ids desktop specs already use for these rows. */
const DESKTOP_FILE_TREE_MENU_TEST_IDS: Partial<
  Record<FileTreeMenuKey, string>
> = {
  mention: 'files-tree-action-send-to-chat',
  'copy-path': 'files-tree-action-copy',
  copy: 'files-tree-action-copy-entry',
};

function sendFileReferenceToChat(target: FileTreeFileActionTarget): void {
  const displayPath = buildFileReferenceDisplayPath(
    {
      relativePath: target.entry.relativePath,
      absolutePath: target.entry.absolutePath,
      repoName: target.root.repoName,
      rootKind: target.root.rootKind,
    },
    target.repoCount,
  );

  document.dispatchEvent(
    new CustomEvent('canopy:insert-file-reference', {
      detail: {
        displayPath,
        absolutePath: target.entry.absolutePath,
        ...(target.repoCount > 1 && target.root.repoName
          ? { repoName: target.root.repoName }
          : {}),
      },
    }),
  );
}

/**
 * Desktop adapter onto the shared file tree menu, used by Explorer and
 * Changed Files. It supplies the rows desktop supports and their behavior.
 */
export function FileTreeActionMenu({
  target,
  onClose,
  onOpenInFileManager,
  onAction,
  onOpenInApp,
  canPaste,
  variant = 'explorer',
  startPageState,
}: FileTreeActionMenuProps): JSX.Element | null {
  const [preferredApp, setPreferredApp] = useState<DetectedApp | null>(null);
  const fileExists = target.kind !== 'file' || target.fileExists !== false;

  useEffect(() => {
    if (target.kind !== 'file' || !fileExists) {
      setPreferredApp(null);
      return;
    }

    let active = true;
    void Promise.all([window.api.detectApps(), window.api.loadPreferences()])
      .then(([apps, preferences]) => {
        if (!active) return;
        setPreferredApp(selectPreferredOpenApp(apps, preferences) ?? null);
      })
      .catch(() => {
        if (active) setPreferredApp(null);
      });
    return (): void => {
      active = false;
    };
  }, [fileExists, target.kind]);

  const explorer = variant === 'explorer';
  const run =
    (action: FileTreeMenuAction): (() => void) =>
    (): void =>
      onAction(action, target);
  const copyPath =
    (absolute: boolean): (() => void) =>
    (): void => {
      void copyTextToClipboard(
        absolute ? target.node.absolutePath : target.copyPath,
      );
    };
  const preferredAppIcon = preferredApp?.icon;

  return (
    <FileTreeContextMenu
      x={target.x}
      y={target.y}
      onClose={onClose}
      targetKind={target.kind}
      labels={DESKTOP_FILE_TREE_MENU_LABELS}
      testIds={DESKTOP_FILE_TREE_MENU_TEST_IDS}
      onNewFile={explorer ? run('new-file') : undefined}
      onNewFolder={explorer ? run('new-folder') : undefined}
      onOpen={variant !== 'diff-tree' ? run('open') : undefined}
      onOpenToSide={explorer ? run('open-side') : undefined}
      onOpenExternal={explorer ? run('open-external') : undefined}
      openInApp={
        fileExists && preferredApp && preferredAppIcon
          ? {
              appName: preferredApp.name,
              iconSrc: preferredAppIcon,
              onSelect: (): void => onOpenInApp(preferredApp.id),
            }
          : undefined
      }
      onMention={
        fileExists && target.kind === 'file'
          ? (): void => sendFileReferenceToChat(target)
          : undefined
      }
      startPage={
        explorer && fileExists && startPageState
          ? {
              isStartPage: startPageState.isStartPage,
              onToggle: startPageState.toggle,
            }
          : undefined
      }
      onCut={explorer ? run('cut') : undefined}
      onCopy={explorer ? run('copy') : undefined}
      onPaste={explorer ? run('paste') : undefined}
      canPaste={canPaste}
      onCopyPath={copyPath(false)}
      copyPathTooltip={`Copy the ${target.kind === 'folder' ? 'folder' : 'file'} path`}
      onCopyAbsolutePath={copyPath(true)}
      onRename={explorer ? run('rename') : undefined}
      openInFileManager={{
        label: pt(uiText.fileManager.openItem),
        onSelect: (): void =>
          onOpenInFileManager(
            target.kind === 'file'
              ? (target.fileManagerPath ?? target.entry.absolutePath)
              : target.absolutePath,
          ),
      }}
      onDelete={explorer ? run('delete') : undefined}
    />
  );
}
