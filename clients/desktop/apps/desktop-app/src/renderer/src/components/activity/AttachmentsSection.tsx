/**
 * Attachments activity card — exposes the worktree's existing attachment
 * directory (storage unchanged: `workspaces/{ws}/attachments/{worktreeId}`
 * for code workspaces, the brand-managed attachments dir for cowork) with
 * import, reveal-in-finder, delete, and @-mention actions.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  type DragEvent,
  type JSX,
} from 'react';
import type { WorkspaceAttachmentItem } from '@canopy/desktop-shared/types';
import {
  AttachmentsSectionBody,
  attachmentsSectionTestIds,
  useAttachmentFileDrag,
  type AttachmentListRow,
  type AttachmentsSource,
} from '@canopy/ui-app/attachments';
import { GuestFilesState } from '@canopy/ui-app/guest-files';
import {
  useDesktopFilesGuestGate,
  type DesktopFilesGuestGate,
} from '@/hooks/useDesktopFilesGuestGate';
import { HeaderActionButton } from '@canopy/ui-shared/components';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { AttachmentIcon as CentralAttachmentIcon } from '@canopy/ui-shared/icons/AppIcons';
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
import { webCoreLocalId } from '@/lib/chat-authority';
import type { ActivitySectionRenderProps } from './activity-sections';
import {
  CloudAttachmentsSection,
  useCloudAttachmentsHeaderChrome,
} from './CloudAttachmentsSection';
import {
  dispatchWorkspaceItemMention,
  PlusIcon,
} from './workspace-items-shared';

const EMPTY_ATTACHMENTS: readonly WorkspaceAttachmentItem[] = [];

const TEST_IDS = attachmentsSectionTestIds('workspace-attachments', {
  row: 'workspace-attachments-item',
  empty: 'workspace-attachments-empty-dropzone',
});

// eslint-disable-next-line react-refresh/only-export-components
export function useAttachmentsHeaderChrome(props: ActivitySectionRenderProps): {
  hasContent: boolean;
  subtitle: string | undefined;
  collapsedIconColor: CollapsedIconColor;
} {
  const local = useLocalAttachmentsHeaderChrome(props);
  const cloud = useCloudAttachmentsHeaderChrome(props);
  return webCoreLocalId(props.worktreeId) === null ? local : cloud;
}

function useLocalAttachmentsHeaderChrome({
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

/**
 * A cloud chat scope's attachments are its chat's, on the web core
 * (CAN-6175 R8d); every other scope's are this computer's attachment folder.
 */
export function AttachmentsSection(
  props: ActivitySectionRenderProps,
): JSX.Element {
  return webCoreLocalId(props.worktreeId) === null ? (
    <LocalAttachmentsSection {...props} />
  ) : (
    <CloudAttachmentsSection {...props} />
  );
}

function LocalAttachmentsSection({
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

  const importFiles = useCallback(
    (files: readonly File[]): void => {
      if (gate.interceptAttachment() || readOnly) return;
      const isCurrent = gate.captureAccess();
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

  // The collapsed card takes drops too; it isn't part of the body.
  const cardDrag = useAttachmentFileDrag({
    enabled: !readOnly,
    onFiles: importFiles,
  });

  const source = useMemo((): AttachmentsSource => {
    const byFilename = new Map(
      attachments.map((attachment) => [attachment.filename, attachment]),
    );
    const pathOf = (row: AttachmentListRow): string | undefined =>
      byFilename.get(row.id)?.absolutePath;
    return {
      scopeKey: key,
      load: {
        kind: 'ready',
        rows: attachments.map(
          (attachment): AttachmentListRow => ({
            id: attachment.filename,
            filename: attachment.filename,
            sizeBytes: attachment.sizeBytes,
          }),
        ),
      },
      rowIcon: (row) => (
        <FileTypeIcon filename={row.filename} size="sm" className="shrink-0" />
      ),
      hover: {
        onEnter: (row, element): void => {
          const absolutePath = pathOf(row);
          if (absolutePath !== undefined) {
            handleMouseEnter(absolutePath, element);
          }
        },
        onLeave: handleMouseLeave,
        overlay: hoveredPath ? (
          <AttachmentPreviewPopover
            absolutePath={hoveredPath}
            filename={hoveredAttachment?.filename}
            sizeBytes={hoveredAttachment?.sizeBytes}
            createdAt={hoveredAttachment?.createdAt}
            anchorRef={anchorRef}
            onMouseEnter={popoverMouseEnter}
            onMouseLeave={popoverMouseLeave}
          />
        ) : null,
      },
      ...(readOnly
        ? { emptyMessage: 'No attachments' }
        : {
            add: { kind: 'import', importFiles, pick: handleImport },
            mention: (row: AttachmentListRow): void => {
              const absolutePath = pathOf(row);
              if (absolutePath === undefined) return;
              dispatchWorkspaceItemMention({
                displayPath: absolutePath,
                absolutePath,
                repoName: 'Attachments',
                kind: 'attachment',
              });
            },
            reveal: {
              label: 'Reveal in Finder',
              run: (row: AttachmentListRow): void => {
                const absolutePath = pathOf(row);
                if (absolutePath === undefined) return;
                void window.api.showInFinder({
                  absolutePath,
                  projectId,
                  worktreeId,
                });
              },
            },
            remove: (row: AttachmentListRow): Promise<void> =>
              useWorkspaceItemsStore
                .getState()
                .deleteAttachment(
                  projectId,
                  worktreeId,
                  row.id,
                  gate.captureAccess(),
                ),
          }),
    };
  }, [
    anchorRef,
    attachments,
    gate,
    handleImport,
    handleMouseEnter,
    handleMouseLeave,
    hoveredAttachment,
    hoveredPath,
    importFiles,
    key,
    popoverMouseEnter,
    popoverMouseLeave,
    projectId,
    readOnly,
    worktreeId,
  ]);

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
            actionOnlyCardProps: cardDrag.handlers,
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
      <AttachmentsSectionBody
        source={source}
        testIds={TEST_IDS}
        fill={frameless}
      />
    </PanelSection>
  );
}
