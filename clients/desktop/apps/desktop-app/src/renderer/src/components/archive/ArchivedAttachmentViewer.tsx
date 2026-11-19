import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  FileTabViewMode,
  WorkspaceAttachmentItem,
} from '@canopy/desktop-shared/types';
import type { RemoteControlFileReadPayload } from '@canopy/protocol/remote-control/shell';
import { fileViewerKey, useFileViewerStore } from '@canopy/app-state';
import { FileViewer, type FileViewerProps } from '@canopy/ui-app';
import { Surface, Button } from '@canopy/ui-shared/components';
import { registerLocalFileRootOverride } from '@/client/ipc-canopy-client';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';

interface ArchivedAttachmentViewerProps {
  workspaceId: string;
  containerId: string;
  attachment: WorkspaceAttachmentItem;
  attachments: WorkspaceAttachmentItem[];
  onSelectAttachment: (attachment: WorkspaceAttachmentItem) => void;
  onClose: () => void;
}

function parentPath(absolutePath: string): string {
  const separatorIndex = Math.max(
    absolutePath.lastIndexOf('/'),
    absolutePath.lastIndexOf('\\'),
  );
  return separatorIndex > 0 ? absolutePath.slice(0, separatorIndex) : '';
}

function relativeAttachmentName(href: string): string | null {
  const withoutQuery = href.split(/[?#]/, 1)[0]?.replace(/\\/g, '/') ?? '';
  if (
    withoutQuery === '' ||
    withoutQuery.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/i.test(withoutQuery)
  ) {
    return null;
  }
  const segments = withoutQuery.split('/').filter((segment) => segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    return null;
  }
  return segments[segments.length - 1] ?? null;
}

export function ArchivedAttachmentViewer({
  workspaceId,
  containerId,
  attachment,
  attachments,
  onSelectAttachment,
  onClose,
}: ArchivedAttachmentViewerProps): JSX.Element {
  const [viewMode, setViewMode] = useState<FileTabViewMode>('raw');
  const [rootReady, setRootReady] = useState(false);
  const closeFile = useFileViewerStore((state) => state.closeFile);
  const rootPath = parentPath(attachment.absolutePath);
  const rootId = `archived-attachments:${workspaceId}:${containerId}`;
  const request = useMemo<RemoteControlFileReadPayload>(
    () => ({
      projectId: workspaceId,
      worktreeId: containerId,
      fileRootLocalId: rootId,
      relativePath: attachment.filename,
    }),
    [attachment.filename, containerId, rootId, workspaceId],
  );

  useEffect(() => {
    const unregister = registerLocalFileRootOverride({
      repoId: rootId,
      repoName: 'Archived attachments',
      absolutePath: rootPath,
      rootKind: 'attachments',
    });
    setRootReady(true);
    return (): void => {
      setRootReady(false);
      closeFile(fileViewerKey(request));
      unregister();
    };
  }, [closeFile, request, rootId, rootPath]);

  const findRelativeAttachment = useCallback(
    (href: string): WorkspaceAttachmentItem | null => {
      const filename = relativeAttachmentName(href);
      return (
        attachments.find((candidate) => candidate.filename === filename) ?? null
      );
    },
    [attachments],
  );

  const resolveAssetSrc = useCallback(
    async (src: string): Promise<string | null> => {
      const target = findRelativeAttachment(src);
      if (!target) return null;
      const result = await window.api.readFileContent({
        absolutePath: target.absolutePath,
      });
      return result.kind === 'image' ? result.content : null;
    },
    [findRelativeAttachment],
  );

  const resolveImageSrc = useCallback(async (): Promise<string | null> => {
    const result = await window.api.readFileContent({
      absolutePath: attachment.absolutePath,
    });
    return result.kind === 'image' ? result.content : null;
  }, [attachment.absolutePath]);

  const resolveHtmlAsset = useCallback<
    NonNullable<FileViewerProps['resolveHtmlAsset']>
  >(
    (src) => {
      const target = findRelativeAttachment(src);
      return Promise.resolve(
        target
          ? {
              identity: target.absolutePath,
              read: (): Promise<string | null> => resolveAssetSrc(src),
            }
          : null,
      );
    },
    [findRelativeAttachment, resolveAssetSrc],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="archived-attachment-viewer"
    >
      <Surface variant="section" boundary="bottom" className="shrink-0">
        <div className="flex shrink-0 items-center gap-2 px-4 py-2">
          <Button
            variant="ghost"
            size="compact"
            onClick={onClose}
            data-testid="archived-attachment-viewer-back"
          >
            Back to attachments
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium fg-primary">
            {attachment.filename}
          </span>
          <Button
            size="compact"
            onClick={() =>
              void window.api.showInFinder({
                absolutePath: attachment.absolutePath,
              })
            }
          >
            Reveal
          </Button>
        </div>
      </Surface>
      {rootReady ? (
        <FileViewer
          request={request}
          viewMode={viewMode === 'diff' ? 'raw' : viewMode}
          onViewModeChange={setViewMode}
          onOpenRelativePath={(href): void => {
            const target = findRelativeAttachment(href);
            if (target) onSelectAttachment(target);
          }}
          resolveAssetSrc={resolveAssetSrc}
          resolveHtmlAsset={resolveHtmlAsset}
          resolveImageSrc={resolveImageSrc}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <DelayedLoadingPlaceholder className="">
            <div className="box-content flex min-h-full flex-1 py-12">
              <CenteredLoadingSpinner className="" />
            </div>
          </DelayedLoadingPlaceholder>
        </div>
      )}
    </div>
  );
}
