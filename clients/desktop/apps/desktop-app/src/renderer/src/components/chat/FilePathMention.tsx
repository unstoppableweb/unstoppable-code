import {
  memo,
  useCallback,
  useContext,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { FileLinkLineLocation } from '@canopy/ui-shared/lib/file-link-line-suffix';
import { useAgentFilePresentationStore } from '@/stores/agentFilePresentationStore';
import { INLINE_CHIP_ICON_CLASS, InlineMention } from '@canopy/ui-shared';
import { FileTypeIcon } from '@canopy/ui-shared/icons';
import { useChatStore } from '@/stores/chatStore';
import { requestFilePanelPlacementBesideChat } from '@/lib/panels/chat-panel-sync';
import type { FilePathMentionTarget } from '@/lib/filePathMentionIndex';
import {
  isBrowserRenderedFile,
  openFileInBrowserPanel,
} from '@/lib/openFileInBrowserPanel';
import { ChatMarkdownFileTargetContext } from './chat-markdown-file-target';

interface FilePathMentionProps {
  target: FilePathMentionTarget;
  location?: FileLinkLineLocation;
  displayText?: string;
  originChatTabId?: string;
  children: ReactNode;
}

export const FilePathMention = memo(function FilePathMention({
  target,
  location,
  displayText,
  originChatTabId,
  children,
}: FilePathMentionProps): JSX.Element {
  const openFileTab = useChatStore((state) => state.openFileTab);
  const scope = useContext(ChatMarkdownFileTargetContext);
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      // A mentioned page opens rendered in the browser beside the chat.
      const browserScope = scope ?? useChatStore.getState().selectedWorktree;
      if (browserScope) {
        useAgentFilePresentationStore
          .getState()
          .beginTranscriptOpen(browserScope, originChatTabId);
      }
      if (!location && browserScope && isBrowserRenderedFile(target.filename)) {
        void openFileInBrowserPanel(
          browserScope.projectId,
          browserScope.worktreeId,
          target.absolutePath,
          originChatTabId !== undefined ? { originChatTabId } : {},
        );
        return;
      }
      const fileTabId = openFileTab({
        absolutePath: target.absolutePath,
        filename: target.filename,
      });
      if (!fileTabId) return;
      useAgentFilePresentationStore
        .getState()
        .present(fileTabId, location ?? {});
      if (originChatTabId !== undefined) {
        requestFilePanelPlacementBesideChat(fileTabId, originChatTabId);
      }
    },
    [
      location,
      openFileTab,
      originChatTabId,
      scope,
      target.absolutePath,
      target.filename,
    ],
  );

  return (
    <InlineMention
      icon={
        <FileTypeIcon
          filename={target.filename}
          className={INLINE_CHIP_ICON_CLASS}
          exactSize
        />
      }
      title={`Open ${displayText ?? target.displayPath}`}
      aria-label={`Open ${displayText ?? target.displayPath}`}
      onClick={handleClick}
    >
      {children}
    </InlineMention>
  );
});
