/**
 * Attachments activity card — exposes the worktree's existing attachment
 * directory (storage unchanged: `workspaces/{ws}/attachments/{worktreeId}`
 * for code workspaces, the brand-managed attachments dir for cowork) with
 * import, reveal-in-finder, delete, and @-mention actions.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type JSX,
} from 'react';
import type { WorkspaceAttachmentItem } from '@canopy/desktop-shared/types';
import { GuestFilesState } from '@canopy/ui-app/guest-files';
import {
  useDesktopFilesGuestGate,
  type DesktopFilesGuestGate,
} from '@/hooks/useDesktopFilesGuestGate';
import {
  Stack,
  AttachmentDropZone,
  AttachmentItemRow,
  HeaderActionButton,
} from '@canopy/ui-shared/components';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import {
  AttachmentIcon as CentralAttachmentIcon,
  FolderIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { AttachmentPreviewPopover } from '@/components/shared/AttachmentPreviewPopover';
import {
  PanelSection,
  type CollapsedIconColor,
  useActivitySectionChrome,
} from '@/components/shared/panel-section';
import { FileTypeIcon } from '@canopy/ui-shared/icons';
import { useAttachmentHover } from '@/hooks/useAttachmentHover';
import {
  ATTACHMENT_IMPORT_ERROR_MESSAGE,
  createClipboardAttachments,
} from '@/lib/chatAttachments';
import { dataTransferHasFiles } from '@/lib/terminal-file-drop';
import { useGitHubStore } from '@/stores/githubStore';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import type { ActivitySectionRenderProps } from './activity-sections';
import {
  dispatchWorkspaceItemMention,
  InlineDeleteConfirm,
  MentionIcon,
  PlusIcon,
  RowActionButton,
  RowActionTray,
  TrashIcon,
  useInlineDelete,
} from './workspace-items-shared';

const EMPTY_ATTACHMENTS: readonly WorkspaceAttachmentItem[] = [];

interface AttachmentRowProps {
  attachment: WorkspaceAttachmentItem;
  projectId: string;
  worktreeId: string;
  onDelete: (filename: string) => Promise<void>;
  onMouseEnter: (absolutePath: string, element: HTMLElement) => void;
  onMouseLeave: () => void;
  /** Read-only scopes preview attachments but never mention, reveal or delete. */
  readOnly?: boolean;
}

function AttachmentRow({
  attachment,
  projectId,
  worktreeId,
  onDelete,
  onMouseEnter,
  onMouseLeave,
  readOnly = false,
}: AttachmentRowProps): JSX.Element {
  const del = useInlineDelete(
    useCallback(
      () => onDelete(attachment.filename),
      [attachment.filename, onDelete],
    ),
  );

  const handleMention = useCallback((): void => {
    dispatchWorkspaceItemMention({
      displayPath: attachment.absolutePath,
      absolutePath: attachment.absolutePath,
      repoName: 'Attachments',
      kind: 'attachment',
    });
  }, [attachment.absolutePath]);

  const handleReveal = useCallback((): void => {
    void window.api.showInFinder({
      absolutePath: attachment.absolutePath,
      projectId,
      worktreeId,
    });
  }, [attachment.absolutePath, projectId, worktreeId]);

  return (
    <AttachmentItemRow
      testId="workspace-attachments-item"
      onMouseEnter={(event): void =>
        onMouseEnter(attachment.absolutePath, event.currentTarget)
      }
      onMouseLeave={onMouseLeave}
      filename={attachment.filename}
      icon={
        <FileTypeIcon
          filename={attachment.filename}
          size="sm"
          className="shrink-0"
        />
      }
      actions={
        readOnly ? undefined : (
          <RowActionTray inRowOnTouch>
            {del.confirming ? (
              <InlineDeleteConfirm
                onConfirm={del.confirm}
                onCancel={del.cancel}
                deleting={del.deleting}
              />
            ) : (
              <>
                <RowActionButton
                  label="Mention in chat"
                  onClick={handleMention}
                >
                  <MentionIcon />
                </RowActionButton>
                <RowActionButton
                  label="Reveal in Finder"
                  onClick={handleReveal}
                >
                  <FolderIcon size="sm" />
                </RowActionButton>
                <RowActionButton
                  label="Delete attachment"
                  destructive
                  onClick={del.request}
                >
                  <TrashIcon />
                </RowActionButton>
              </>
            )}
          </RowActionTray>
        )
      }
    />
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAttachmentsHeaderChrome({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): {
  hasContent: boolean;
  subtitle: string | undefined;
  collapsedIconColor: CollapsedIconColor;
} {
  const { status } = useDesktopFilesGuestGate();
  const count = useWorkspaceItemsStore(
    (state) => state.attachments[`${projectId}/${worktreeId}`]?.length ?? 0,
  );
  return {
    hasContent: status === 'signed-in' && count > 0,
    subtitle:
      status === 'signed-in' && count > 0
        ? `${count} file${count !== 1 ? 's' : ''}`
        : undefined,
    collapsedIconColor: status === 'signed-in' && count > 0 ? 'amber' : 'muted',
  };
}

export function AttachmentsSection({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): JSX.Element {
  const gate = useDesktopFilesGuestGate(`${projectId}/${worktreeId}`);
  const readOnly = useWorkspaceIsReadOnly();
  if (gate.status === 'signed-in') {
    return (
      <AuthenticatedAttachmentsSection
        projectId={projectId}
        worktreeId={worktreeId}
        gate={gate}
      />
    );
  }
  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    gate.interceptAttachment();
  };
  const preventFileNavigation = (event: DragEvent<HTMLElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <PanelSection
      icon={<CentralAttachmentIcon size="sm" />}
      title="Attachments"
      collapsedIconColor="muted"
      hasExpandableContent={gate.status === 'guest'}
      headerAction={
        readOnly ? undefined : (
          <HeaderActionButton
            iconOnly
            aria-label="Import attachments"
            data-testid="workspace-attachments-import"
            onClick={gate.onSignIn}
          >
            <PlusIcon />
          </HeaderActionButton>
        )
      }
      framelessBody="flex"
    >
      <div
        data-testid="workspace-attachments-dropzone"
        onDrop={handleDrop}
        onDragOver={preventFileNavigation}
      >
        {gate.status === 'guest' ? (
          <GuestFilesState onSignIn={gate.onSignIn} />
        ) : null}
      </div>
    </PanelSection>
  );
}

function AuthenticatedAttachmentsSection({
  projectId,
  worktreeId,
  gate,
}: ActivitySectionRenderProps & {
  readonly gate: DesktopFilesGuestGate;
}): JSX.Element {
  // Read-only scopes (the shared-container recipient) list the published
  // attachments without import, drop, mention, reveal or delete.
  const readOnly = useWorkspaceIsReadOnly();
  const key = `${projectId}/${worktreeId}`;
  const frameless = useActivitySectionChrome() === 'frameless';
  const attachments = useWorkspaceItemsStore(
    (s) => s.attachments[key] ?? EMPTY_ATTACHMENTS,
  );
  const count = attachments.length;
  const headerChrome = {
    subtitle: count > 0 ? `${count} file${count !== 1 ? 's' : ''}` : undefined,
    collapsedIconColor: count > 0 ? ('amber' as const) : ('muted' as const),
  };
  const addToast = useGitHubStore((state) => state.addToast);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const fileDragDepthRef = useRef(0);
  const {
    hoveredPath,
    anchorRef,
    handleMouseEnter,
    handleMouseLeave,
    popoverMouseEnter,
    popoverMouseLeave,
  } = useAttachmentHover();
  const hoveredAttachment = hoveredPath
    ? attachments.find((attachment) => attachment.absolutePath === hoveredPath)
    : undefined;

  useEffect(() => {
    void useWorkspaceItemsStore
      .getState()
      .loadAttachments(projectId, worktreeId, gate.captureAccess());
  }, [projectId, worktreeId, gate]);

  const reportAttachmentImportFailure = useCallback((): void => {
    addToast(ATTACHMENT_IMPORT_ERROR_MESSAGE, 'error', undefined, {
      category: 'Chat',
    });
  }, [addToast]);

  const handleImport = useCallback((): void => {
    if (gate.interceptAttachment() || readOnly) return;
    const isCurrent = gate.captureAccess();
    // Empty filePaths → the main process opens the file picker dialog.
    void useWorkspaceItemsStore
      .getState()
      .importAttachments(
        {
          projectId,
          worktreeId,
          filePaths: [],
        },
        isCurrent,
      )
      .catch((): void => {
        if (isCurrent()) reportAttachmentImportFailure();
      });
  }, [gate, readOnly, projectId, reportAttachmentImportFailure, worktreeId]);

  const handleDelete = useCallback(
    async (filename: string): Promise<void> => {
      await useWorkspaceItemsStore
        .getState()
        .deleteAttachment(
          projectId,
          worktreeId,
          filename,
          gate.captureAccess(),
        );
    },
    [projectId, worktreeId, gate],
  );

  const handleFileDragEnter = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      fileDragDepthRef.current += 1;
      setIsDraggingFiles(true);
    },
    [],
  );

  const handleFileDragLeave = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (fileDragDepthRef.current === 0) return;
      event.preventDefault();
      event.stopPropagation();
      fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
      if (fileDragDepthRef.current === 0) {
        setIsDraggingFiles(false);
      }
    },
    [],
  );

  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    },
    [],
  );

  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      fileDragDepthRef.current = 0;
      setIsDraggingFiles(false);

      if (gate.interceptAttachment() || readOnly) return;
      const isCurrent = gate.captureAccess();
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;

      const filePaths: string[] = [];
      const blobFiles: File[] = [];
      for (const file of files) {
        let filePath = '';
        try {
          filePath = window.api.getPathForFile(file);
        } catch {
          // Non-native browser File objects have no filesystem path. Import
          // those from their bytes through the clipboard attachment channel.
        }
        if (filePath) {
          filePaths.push(filePath);
        } else {
          blobFiles.push(file);
        }
      }

      const importDroppedFiles = (
        clipboardItems: Awaited<ReturnType<typeof createClipboardAttachments>>,
      ): Promise<WorkspaceAttachmentItem[]> => {
        if (!isCurrent()) return Promise.resolve([]);
        return useWorkspaceItemsStore.getState().importAttachments(
          {
            projectId,
            worktreeId,
            filePaths,
            ...(clipboardItems.length > 0 ? { clipboardItems } : {}),
          },
          isCurrent,
        );
      };

      if (blobFiles.length === 0) {
        void importDroppedFiles([]).catch((): void => {
          if (isCurrent()) reportAttachmentImportFailure();
        });
        return;
      }
      void createClipboardAttachments(blobFiles, 'dropped-file')
        .then(importDroppedFiles)
        .catch((): void => {
          if (isCurrent()) reportAttachmentImportFailure();
        });
    },
    [gate, readOnly, projectId, reportAttachmentImportFailure, worktreeId],
  );

  return (
    <PanelSection
      icon={<CentralAttachmentIcon size="sm" />}
      title="Attachments"
      subtitle={headerChrome.subtitle}
      collapsedIconColor={headerChrome.collapsedIconColor}
      hasExpandableContent={attachments.length > 0}
      actionOnlyCard={!readOnly}
      {...(readOnly
        ? {}
        : {
            actionOnlyLabel: 'Import attachment',
            actionOnlyCardProps: {
              onDragEnter: handleFileDragEnter,
              onDragLeave: handleFileDragLeave,
              onDragOver: handleFileDragOver,
              onDrop: handleFileDrop,
            },
          })}
      headerAction={
        readOnly ? undefined : (
          <HeaderActionButton
            iconOnly
            onClick={handleImport}
            aria-label="Import attachments"
            data-testid="workspace-attachments-import"
          >
            <PlusIcon />
          </HeaderActionButton>
        )
      }
      framelessBody="flex"
    >
      <div
        className={
          frameless
            ? 'relative min-h-28 flex-1 overflow-y-auto'
            : 'relative min-h-28 max-h-75 overflow-y-auto'
        }
        data-testid="workspace-attachments-dropzone"
        {...(readOnly
          ? {}
          : {
              onDragEnter: handleFileDragEnter,
              onDragLeave: handleFileDragLeave,
              onDragOver: handleFileDragOver,
              onDrop: handleFileDrop,
            })}
      >
        {isDraggingFiles ? (
          <AttachmentDropZone
            active
            testId="workspace-attachments-active-dropzone"
          />
        ) : attachments.length === 0 ? (
          <AttachmentDropZone
            emptyMessage={readOnly ? 'No attachments' : undefined}
            testId="workspace-attachments-empty-dropzone"
          />
        ) : (
          <Stack gap="tight">
            {attachments.map((attachment) => (
              <AttachmentRow
                key={attachment.filename}
                attachment={attachment}
                projectId={projectId}
                worktreeId={worktreeId}
                onDelete={handleDelete}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                readOnly={readOnly}
              />
            ))}
            {hoveredPath && (
              <AttachmentPreviewPopover
                absolutePath={hoveredPath}
                filename={hoveredAttachment?.filename}
                sizeBytes={hoveredAttachment?.sizeBytes}
                createdAt={hoveredAttachment?.createdAt}
                anchorRef={anchorRef}
                onMouseEnter={popoverMouseEnter}
                onMouseLeave={popoverMouseLeave}
              />
            )}
          </Stack>
        )}
      </div>
    </PanelSection>
  );
}
