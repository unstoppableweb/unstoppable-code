/**
 * Attachments activity card — exposes the worktree's existing attachment
 * directory (storage unchanged: `workspaces/{ws}/attachments/{worktreeId}`
 * for code workspaces, the brand-managed attachments dir for cowork) as the
 * shared section body's rows: each file's type icon, name, size and date. A
 * click opens the file (an image or a video in the in-app viewer, a known
 * document in its default app); each row reveals @-mention,
 * reveal-in-finder and delete actions, and the section imports by picker
 * and drop. No file's picture is read for the list.
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
import { formatByteSize } from '@canopy/ui-shared/lib';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import {
  OPEN_EXTERNAL_FILE_FAILED,
  REVEAL_FILE_FAILED,
} from '@/lib/file-reveal';
import { AttachmentIcon as CentralAttachmentIcon } from '@canopy/ui-shared/icons/AppIcons';
import { AttachmentPreviewPopover } from '@/components/shared/AttachmentPreviewPopover';
import { useDesktopMediaViewer } from '@/components/shared/useDesktopMediaViewer';
import { useAttachmentHover } from '@/hooks/useAttachmentHover';
import {
  PanelSection,
  type CollapsedIconColor,
  useActivitySectionChrome,
} from '@/components/shared/panel-section';
import {
  ATTACHMENT_IMPORT_ERROR_MESSAGE,
  createClipboardAttachments,
} from '@/lib/chatAttachments';
import { PREVIEWABLE_IMAGE_FILENAME, VIDEO_FILENAME } from '@/lib/file-type';
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

/**
 * Documents a row click may hand to their default app. A click opens only
 * these: another file there could be a script, an app or a bare executable,
 * which its default app (Terminal, for a `.command` or an extensionless
 * binary) runs. Any other file shows its preview card on hover, whose Open
 * action is a deliberate second step, as every attachment row's was.
 */
const OPENS_IN_DEFAULT_APP =
  /\.(pdf|txt|md|markdown|rtf|csv|tsv|json|ya?ml|xml|log|docx?|xlsx?|pptx?|odt|ods|odp|pages|numbers|key|epub|mp3|m4a|wav|aiff?|flac|ogg|opus|aac|heic|heif|tiff?|psd|ai|eps|sketch|fig|zip)$/i;

function attachmentKind(filename: string): 'image' | 'video' | 'file' {
  if (PREVIEWABLE_IMAGE_FILENAME.test(filename)) return 'image';
  if (VIDEO_FILENAME.test(filename)) return 'video';
  return 'file';
}

/** Whether a click on a writable folder's row opens its file. */
function opensOnClick(filename: string): boolean {
  return (
    attachmentKind(filename) !== 'file' || OPENS_IN_DEFAULT_APP.test(filename)
  );
}

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
  // Read-only scopes (the shared-container recipient) list and open the
  // published attachments without import, drop, mention, reveal or delete.
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
  // Images and videos open in the in-app viewer, with the folder's other
  // media beside them.
  // A read-only folder's files may not be handed to another app.
  const mediaViewer = useDesktopMediaViewer(
    { projectId, worktreeId },
    { canOpenExternal: !readOnly },
  );
  const openMediaViewer = mediaViewer.open;
  // A read-only folder's document cannot be opened where it is (see `open`
  // below), so resting on its row shows its preview.
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
    // A read-only folder's videos are read through the shared copy's byte
    // reader, which serves its repositories only, so there the viewer holds
    // its images; a video row there opens nothing.
    const media = attachments.filter((attachment) =>
      readOnly
        ? attachmentKind(attachment.filename) === 'image'
        : attachmentKind(attachment.filename) !== 'file',
    );
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
      detail: (row): string | undefined => {
        const attachment = byFilename.get(row.id);
        if (attachment === undefined) return undefined;
        const size = formatByteSize(attachment.sizeBytes);
        // A shared container's copy carries no creation time: the row then
        // shows the size alone, not "Invalid Date".
        const created = new Date(attachment.createdAt);
        if (Number.isNaN(created.getTime())) return size;
        const date = created.toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          ...(created.getFullYear() === new Date().getFullYear()
            ? {}
            : { year: 'numeric' }),
        });
        return `${size} · ${date}`;
      },
      // A document that a click does not open shows its preview on hover:
      // every document of a read-only folder, and elsewhere any file that
      // is not a known document type.
      ...(readOnly || attachments.some((item) => !opensOnClick(item.filename))
        ? {
            hover: {
              shows: (row: AttachmentListRow): boolean =>
                attachmentKind(row.filename) === 'file' &&
                (readOnly || !opensOnClick(row.filename)),
              onEnter: (row: AttachmentListRow, anchor: HTMLElement): void => {
                const absolutePath = pathOf(row);
                if (absolutePath !== undefined) {
                  handleMouseEnter(absolutePath, anchor);
                }
              },
              onLeave: handleMouseLeave,
              overlay: hoveredPath ? (
                <AttachmentPreviewPopover
                  absolutePath={hoveredPath}
                  filename={hoveredAttachment?.filename}
                  sizeBytes={hoveredAttachment?.sizeBytes}
                  anchorRef={anchorRef}
                  onMouseEnter={popoverMouseEnter}
                  onMouseLeave={popoverMouseLeave}
                />
              ) : null,
            },
          }
        : {}),
      // Images and videos open in the in-app viewer; known document types
      // in their default app (OPENS_IN_DEFAULT_APP). A read-only folder (a shared container's sealed copy)
      // may not hand a file to another app, and the app's file viewer has
      // no root for that folder to read it through, so there only media
      // opens; a document shows its preview on hover instead.
      open: {
        canOpen: (row): boolean =>
          byFilename.has(row.id) &&
          (readOnly
            ? attachmentKind(row.filename) === 'image'
            : opensOnClick(row.filename)),
        run: (row): void | Promise<void> => {
          const attachment = byFilename.get(row.id);
          if (attachment === undefined) return undefined;
          if (attachmentKind(attachment.filename) === 'file') {
            return window.api
              .openExternalFile({ absolutePath: attachment.absolutePath })
              .catch((error: unknown): never => {
                reportClientAppError(error);
                throw error;
              });
          }
          openMediaViewer(
            media.map((item) => ({
              absolutePath: item.absolutePath,
              name: item.filename,
              kind:
                attachmentKind(item.filename) === 'video' ? 'video' : 'image',
            })),
            media.findIndex((item) => item.filename === attachment.filename),
          );
          return undefined;
        },
        failureMessage: OPEN_EXTERNAL_FILE_FAILED,
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
              run: (row: AttachmentListRow): void | Promise<void> => {
                const absolutePath = pathOf(row);
                if (absolutePath === undefined) return undefined;
                return window.api
                  .showInFinder({
                    absolutePath,
                    projectId,
                    worktreeId,
                  })
                  .catch((error: unknown): never => {
                    reportClientAppError(error);
                    throw error;
                  });
              },
              failureMessage: REVEAL_FILE_FAILED,
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
    openMediaViewer,
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
      {mediaViewer.viewer}
    </PanelSection>
  );
}
