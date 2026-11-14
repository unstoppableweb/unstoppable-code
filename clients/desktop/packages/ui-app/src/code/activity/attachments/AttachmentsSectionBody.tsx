import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  AttachmentDropZone,
  AttachmentItemRow,
  Button,
  ErrorBanner,
  InlineDeleteConfirm,
  LoadingSpinner,
  RowActionButton,
  RowActionTray,
  Surface,
} from '@canopy/ui-shared/components';
import { MentionIcon } from '@canopy/ui-shared/icons';
import {
  AttachmentIcon,
  DownloadIcon,
  EyeIcon,
  FolderIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { dataTransferHasFiles } from '../../terminal/terminal-file-drop';
import { GuestFilesState } from '../GuestFilesState';

/** One attachment the section lists. */
export interface AttachmentListRow {
  /** Stable within the scope: a file name, or the server's attachment id. */
  readonly id: string;
  /**
   * An opaque id the row may expose in the DOM. Session replay records
   * attributes, so a host whose `id` is a filename leaves this unset.
   */
  readonly domId?: string;
  readonly filename: string;
  readonly sizeBytes?: number;
  readonly mediaType?: string;
}

export type AttachmentListLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly retry: () => void }
  | { readonly kind: 'ready'; readonly rows: readonly AttachmentListRow[] };

/** How files reach the scope. */
export type AttachmentsAdd =
  /**
   * Each file uploads on its own. Its row shows while it uploads and keeps a
   * failure with retry; the source's list shows it once it lands.
   */
  | {
      readonly kind: 'upload';
      readonly upload: (file: File) => Promise<void>;
      readonly failureMessage: (error: unknown) => string;
    }
  /**
   * The host imports a batch and reports its own failures. `pick` opens the
   * host's own file picker.
   */
  | {
      readonly kind: 'import';
      readonly importFiles: (files: readonly File[]) => void;
      readonly pick: () => void;
    };

/**
 * Everything the section can do for one scope. The section renders an action
 * only when the source provides it; it never asks which host it runs in.
 */
export interface AttachmentsSource {
  /** What the section lists. A change drops the previous scope's state. */
  readonly scopeKey: string | undefined;
  readonly load: AttachmentListLoad;
  /** Absent for a scope that only lists (read-only, or no add path yet). */
  readonly add?: AttachmentsAdd;
  /** Set while the viewer must sign in before using attachments. */
  readonly guest?: { readonly onSignIn: () => void };
  readonly preview?: {
    readonly canPreview: (row: AttachmentListRow) => boolean;
    readonly open: (row: AttachmentListRow) => void;
  };
  readonly mention?: (row: AttachmentListRow) => void;
  readonly reveal?: {
    readonly label: string;
    readonly run: (row: AttachmentListRow) => void;
  };
  readonly download?: (row: AttachmentListRow) => Promise<void>;
  readonly remove?: (row: AttachmentListRow) => Promise<void>;
  readonly rowIcon?: (row: AttachmentListRow) => ReactNode;
  readonly showSize?: boolean;
  readonly hover?: {
    readonly onEnter: (row: AttachmentListRow, element: HTMLElement) => void;
    readonly onLeave: () => void;
    readonly overlay: ReactNode;
  };
  /** Empty-state text for a scope that can't add files. */
  readonly emptyMessage?: string;
}

export interface AttachmentsSectionTestIds {
  readonly root?: string;
  readonly input: string;
  readonly dropzone: string;
  readonly activeDropzone: string;
  readonly empty: string;
  readonly loading: string;
  readonly error: string;
  readonly retry: string;
  readonly row: string;
  readonly rowContent?: string;
  readonly rowActions?: string;
  readonly preview: string;
  readonly mention: string;
  readonly reveal: string;
  readonly download: string;
  readonly delete: string;
  readonly deleteConfirm: string;
  readonly deleteCancel: string;
  readonly uploadRow: string;
  readonly uploadSpinner: string;
  readonly uploadRetry: string;
  readonly uploadDismiss: string;
  readonly actionError: string;
}

/** The section's test ids under one prefix, with per-host exceptions. */
export function attachmentsSectionTestIds(
  prefix: string,
  overrides: Partial<AttachmentsSectionTestIds> = {},
): AttachmentsSectionTestIds {
  return {
    input: `${prefix}-input`,
    dropzone: `${prefix}-dropzone`,
    activeDropzone: `${prefix}-active-dropzone`,
    empty: `${prefix}-empty`,
    loading: `${prefix}-loading`,
    error: `${prefix}-error`,
    retry: `${prefix}-retry`,
    row: `${prefix}-row`,
    preview: `${prefix}-preview`,
    mention: `${prefix}-mention`,
    reveal: `${prefix}-reveal`,
    download: `${prefix}-download`,
    delete: `${prefix}-delete`,
    deleteConfirm: `${prefix}-delete-confirm`,
    deleteCancel: `${prefix}-delete-cancel`,
    uploadRow: `${prefix}-upload-row`,
    uploadSpinner: `${prefix}-upload-spinner`,
    uploadRetry: `${prefix}-upload-retry`,
    uploadDismiss: `${prefix}-upload-dismiss`,
    actionError: `${prefix}-action-error`,
    ...overrides,
  };
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * File drag state for an attachments drop target. Enter and leave fire for
 * every nested element the pointer crosses, so they are counted rather than
 * trusted one at a time, and a drag that ends elsewhere resets at the window.
 */
export function useAttachmentFileDrag({
  enabled,
  onFiles,
}: {
  readonly enabled: boolean;
  readonly onFiles: (files: readonly File[]) => void;
}): {
  readonly dragging: boolean;
  readonly reset: () => void;
  readonly handlers: {
    readonly onDragEnter: (event: DragEvent<HTMLElement>) => void;
    readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
    readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
    readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  };
} {
  const [dragging, setDragging] = useState(false);
  const depthRef = useRef(0);
  const reset = useCallback((): void => {
    depthRef.current = 0;
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!dragging) return undefined;
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return (): void => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, [dragging, reset]);

  return {
    dragging,
    reset,
    handlers: {
      onDragEnter: (event): void => {
        if (!enabled || !dataTransferHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        depthRef.current += 1;
        setDragging(true);
      },
      onDragLeave: (event): void => {
        if (depthRef.current === 0) return;
        event.preventDefault();
        event.stopPropagation();
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setDragging(false);
      },
      onDragOver: (event): void => {
        if (!enabled || !dataTransferHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDrop: (event): void => {
        if (!enabled || !dataTransferHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        reset();
        onFiles(Array.from(event.dataTransfer.files));
      },
    },
  };
}

interface PendingUpload {
  readonly localId: string;
  readonly file: File;
  readonly state: 'staged' | 'uploading' | 'error';
  readonly error?: string;
}

let uploadSequence = 0;

export interface AttachmentsSectionBodyProps {
  readonly source: AttachmentsSource;
  readonly testIds: AttachmentsSectionTestIds;
  /**
   * Grow the list to the section's height, for a section that fills its panel
   * (the desktop rail's frameless chrome). Otherwise the list scrolls past a
   * fixed height.
   */
  readonly fill?: boolean;
  /**
   * The section header renders outside this body, so its add button reaches
   * the body's picker through this handle.
   */
  readonly addTriggerRef?: RefObject<(() => void) | null>;
}

/** The body of an attachments section: list, drop target, add and actions. */
export function AttachmentsSectionBody({
  source,
  testIds,
  fill = false,
  addTriggerRef,
}: AttachmentsSectionBodyProps): JSX.Element {
  const { scopeKey, load, add, guest } = source;
  const [uploads, setUploads] = useState<readonly PendingUpload[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Mutations have no AbortSignal of their own (a half-applied delete must
  // still land), so completions check that the scope they started in is still
  // the one shown. The generation tells apart separate visits in A -> B -> A.
  const activationRef = useRef({ scopeKey, generation: 0 });
  const [renderedScope, setRenderedScope] = useState({
    scopeKey,
    generation: 0,
  });
  const scopeChanged = renderedScope.scopeKey !== scopeKey;
  if (scopeChanged) {
    // Reset during render, not in an effect, so the new scope's first paint
    // never shows the previous scope's uploads, confirm or error.
    const next = { scopeKey, generation: renderedScope.generation + 1 };
    setRenderedScope(next);
    setUploads([]);
    setConfirmingId(null);
    setDeletePending(false);
    setActionError(null);
    // Read only by completions, never rendered.
    // eslint-disable-next-line react-hooks/refs
    activationRef.current = next;
  }

  // A body that unmounts (a closed rail, or an account switch remounting the
  // tree) stops its remaining uploads before they start.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrent = useCallback(
    (generation: number): boolean =>
      mountedRef.current && activationRef.current.generation === generation,
    [],
  );

  const runUploads = (
    entries: readonly PendingUpload[],
    generation: number,
  ): void => {
    if (add?.kind !== 'upload') return;
    setActionError(null);
    void (async (): Promise<void> => {
      for (const entry of entries) {
        if (!isCurrent(generation)) return;
        setUploads((previous) =>
          previous.map((upload) =>
            upload.localId === entry.localId
              ? { ...upload, state: 'uploading' }
              : upload,
          ),
        );
        try {
          await add.upload(entry.file);
          if (!isCurrent(generation)) return;
          // The source lists the file once it lands; drop the stand-in.
          setUploads((previous) =>
            previous.filter((upload) => upload.localId !== entry.localId),
          );
        } catch (error) {
          if (!isCurrent(generation)) return;
          const message = add.failureMessage(error);
          setUploads((previous) =>
            previous.map((upload) =>
              upload.localId === entry.localId
                ? { ...upload, state: 'error', error: message }
                : upload,
            ),
          );
        }
      }
    })();
  };

  /** The one funnel for the picker, the header and drops. */
  const addFiles = (files: readonly File[]): void => {
    if (guest !== undefined) {
      guest.onSignIn();
      return;
    }
    if (add === undefined || files.length === 0 || scopeKey === undefined) {
      return;
    }
    if (add.kind === 'import') {
      add.importFiles(files);
      return;
    }
    const entries = files.map((file): PendingUpload => {
      uploadSequence += 1;
      return {
        localId: `upload-${String(uploadSequence)}`,
        file,
        state: 'staged',
      };
    });
    setUploads((previous) => [...previous, ...entries]);
    runUploads(entries, activationRef.current.generation);
  };

  const openPicker = useCallback((): void => {
    if (guest !== undefined) {
      guest.onSignIn();
      return;
    }
    if (add?.kind === 'import') add.pick();
    else inputRef.current?.click();
  }, [add, guest]);

  useEffect(() => {
    if (!addTriggerRef) return undefined;
    addTriggerRef.current = openPicker;
    return (): void => {
      addTriggerRef.current = null;
    };
  }, [openPicker, addTriggerRef]);

  const dropEnabled =
    guest !== undefined || (add !== undefined && scopeKey !== undefined);
  const drag = useAttachmentFileDrag({
    enabled: dropEnabled,
    onFiles: addFiles,
  });
  if (scopeChanged && drag.dragging) drag.reset();

  const handleFilesSelected = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    // Clear the control so picking the same file again still fires `change`.
    event.target.value = '';
    addFiles(files);
  };

  const handleRetryUpload = (entry: PendingUpload): void => {
    const staged: PendingUpload = {
      localId: entry.localId,
      file: entry.file,
      state: 'staged',
    };
    setUploads((previous) =>
      previous.map((upload) =>
        upload.localId === entry.localId ? staged : upload,
      ),
    );
    runUploads([staged], activationRef.current.generation);
  };

  const handleDownload = (row: AttachmentListRow): void => {
    if (source.download === undefined) return;
    const generation = activationRef.current.generation;
    setActionError(null);
    void source.download(row).catch((): void => {
      if (isCurrent(generation)) setActionError('Download failed. Try again.');
    });
  };

  const handleDelete = (row: AttachmentListRow): void => {
    if (source.remove === undefined) return;
    const generation = activationRef.current.generation;
    setDeletePending(true);
    setActionError(null);
    void source
      .remove(row)
      .catch((): void => {
        if (isCurrent(generation)) setActionError('Delete failed. Try again.');
      })
      .finally((): void => {
        if (!isCurrent(generation)) return;
        setConfirmingId(null);
        setDeletePending(false);
      });
  };

  const rows = load.kind === 'ready' ? load.rows : [];
  // Pending rows are the source of truth for upload activity, so one batch
  // finishing never clears another's.
  const uploadPending = uploads.some((upload) => upload.state !== 'error');
  const mutationsPending = deletePending || uploadPending;
  const uploadError = uploads.find(
    (upload) => upload.state === 'error' && upload.error !== undefined,
  )?.error;
  const visibleActionError = actionError ?? uploadError ?? null;

  return (
    <div
      className={
        fill
          ? 'flex min-h-0 flex-1 flex-col gap-2'
          : 'flex min-h-0 flex-col gap-2'
      }
      data-testid={testIds.root}
    >
      {add?.kind === 'upload' ? (
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid={testIds.input}
          onChange={handleFilesSelected}
        />
      ) : null}
      <div
        className={
          fill
            ? 'relative min-h-28 flex-1 overflow-y-auto'
            : 'relative min-h-28 max-h-75 overflow-y-auto'
        }
        data-testid={testIds.dropzone}
        data-drop-enabled={dropEnabled ? 'true' : 'false'}
        {...drag.handlers}
      >
        {guest !== undefined ? (
          <GuestFilesState onSignIn={guest.onSignIn} />
        ) : drag.dragging ? (
          <AttachmentDropZone active testId={testIds.activeDropzone} />
        ) : (
          <>
            {load.kind === 'loading' ? (
              <p
                className="py-3 text-center text-xs fg-secondary"
                data-testid={testIds.loading}
              >
                Loading attachments…
              </p>
            ) : null}
            {load.kind === 'error' ? (
              <div
                className="flex flex-col items-center gap-2 py-3 text-center text-xs fg-secondary"
                data-testid={testIds.error}
              >
                <span>Unable to load attachments.</span>
                <Button
                  size="compact"
                  data-testid={testIds.retry}
                  onClick={load.retry}
                >
                  Try again
                </Button>
              </div>
            ) : null}
            {load.kind === 'ready' &&
            rows.length === 0 &&
            uploads.length === 0 ? (
              <AttachmentDropZone
                emptyMessage={source.emptyMessage}
                testId={testIds.empty}
              />
            ) : null}
            {rows.length > 0 || uploads.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {rows.map((row) => (
                  <AttachmentItemRow
                    key={row.id}
                    as="li"
                    testId={testIds.row}
                    attachmentId={row.domId}
                    state="ready"
                    filename={row.filename}
                    icon={
                      source.rowIcon?.(row) ?? (
                        <AttachmentIcon size={14} className="shrink-0" />
                      )
                    }
                    metadata={
                      source.showSize === true && row.sizeBytes !== undefined
                        ? formatAttachmentSize(row.sizeBytes)
                        : undefined
                    }
                    contentTestId={testIds.rowContent}
                    onMouseEnter={
                      source.hover === undefined
                        ? undefined
                        : (event): void =>
                            source.hover?.onEnter(row, event.currentTarget)
                    }
                    onMouseLeave={source.hover?.onLeave}
                    actions={(nameId): ReactNode => (
                      <AttachmentRowActions
                        row={row}
                        nameId={nameId}
                        source={source}
                        testIds={testIds}
                        confirming={confirmingId === row.id}
                        deletePending={deletePending}
                        uploadPending={uploadPending}
                        mutationsPending={mutationsPending}
                        onRequestDelete={(): void => setConfirmingId(row.id)}
                        onCancelDelete={(): void => setConfirmingId(null)}
                        onConfirmDelete={(): void => handleDelete(row)}
                        onDownload={(): void => handleDownload(row)}
                      />
                    )}
                  />
                ))}
                {uploads.map((upload) => (
                  <PendingUploadRow
                    key={upload.localId}
                    upload={upload}
                    testIds={testIds}
                    onRetry={(): void => handleRetryUpload(upload)}
                    onDismiss={(): void =>
                      setUploads((previous) =>
                        previous.filter(
                          (entry) => entry.localId !== upload.localId,
                        ),
                      )
                    }
                  />
                ))}
              </ul>
            ) : null}
            {rows.length > 0 ? source.hover?.overlay : null}
          </>
        )}
      </div>
      {guest === undefined && visibleActionError !== null ? (
        <ErrorBanner
          errorSource="attachments-action-error"
          className=""
          error={visibleActionError}
          testId={testIds.actionError}
        />
      ) : null}
    </div>
  );
}

function AttachmentRowActions({
  row,
  nameId,
  source,
  testIds,
  confirming,
  deletePending,
  uploadPending,
  mutationsPending,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onDownload,
}: {
  readonly row: AttachmentListRow;
  readonly nameId: string;
  readonly source: AttachmentsSource;
  readonly testIds: AttachmentsSectionTestIds;
  readonly confirming: boolean;
  readonly deletePending: boolean;
  readonly uploadPending: boolean;
  readonly mutationsPending: boolean;
  readonly onRequestDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onConfirmDelete: () => void;
  readonly onDownload: () => void;
}): JSX.Element | null {
  const { preview, mention, reveal, download, remove } = source;
  if (
    (preview === undefined || !preview.canPreview(row)) &&
    mention === undefined &&
    reveal === undefined &&
    download === undefined &&
    remove === undefined
  ) {
    return null;
  }
  // Session replay records attributes, so labels stay generic and each
  // control names its file through the row's blocked name.
  return (
    <RowActionTray
      inRowOnTouch
      testId={testIds.rowActions}
      revealOnFocus
      forceVisible={confirming}
    >
      {confirming ? (
        <InlineDeleteConfirm
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
          deleting={deletePending}
          disabled={uploadPending}
          confirmTestId={testIds.deleteConfirm}
          cancelTestId={testIds.deleteCancel}
          autoFocusConfirm
        />
      ) : (
        <>
          {preview !== undefined && preview.canPreview(row) ? (
            <RowActionButton
              label="Preview attachment"
              describedBy={nameId}
              onClick={(): void => preview.open(row)}
              testId={testIds.preview}
            >
              <EyeIcon size={12} />
            </RowActionButton>
          ) : null}
          {mention !== undefined ? (
            <RowActionButton
              label="Mention in chat"
              describedBy={nameId}
              onClick={(): void => mention(row)}
              testId={testIds.mention}
            >
              <MentionIcon />
            </RowActionButton>
          ) : null}
          {reveal !== undefined ? (
            <RowActionButton
              label={reveal.label}
              describedBy={nameId}
              onClick={(): void => reveal.run(row)}
              testId={testIds.reveal}
            >
              <FolderIcon size="sm" />
            </RowActionButton>
          ) : null}
          {download !== undefined ? (
            <RowActionButton
              label="Download attachment"
              describedBy={nameId}
              onClick={onDownload}
              testId={testIds.download}
            >
              <DownloadIcon size={12} />
            </RowActionButton>
          ) : null}
          {remove !== undefined ? (
            <RowActionButton
              label="Delete attachment"
              describedBy={nameId}
              destructive
              disabled={mutationsPending}
              onClick={onRequestDelete}
              testId={testIds.delete}
            >
              <TrashIcon size={12} />
            </RowActionButton>
          ) : null}
        </>
      )}
    </RowActionTray>
  );
}

function PendingUploadRow({
  upload,
  testIds,
  onRetry,
  onDismiss,
}: {
  readonly upload: PendingUpload;
  readonly testIds: AttachmentsSectionTestIds;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const nameId = `${upload.localId}-name`;
  return (
    <Surface
      data-testid={testIds.uploadRow}
      data-state={upload.state}
      as="li"
      variant="group"
      size="small"
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        {upload.state === 'uploading' ? (
          <span
            className="inline-flex h-3 w-3 shrink-0 items-center justify-center fg-secondary"
            aria-label="Uploading"
            role="status"
          >
            <LoadingSpinner
              className="scale-75"
              dataTestId={testIds.uploadSpinner}
              decorative
            />
          </span>
        ) : (
          <AttachmentIcon size={14} className="shrink-0" />
        )}
        <span
          id={nameId}
          className={`${REPLAY_BLOCK_CLASS} min-w-0 flex-1 truncate text-xs fg-primary`}
        >
          {upload.file.name}
        </span>
        {upload.state === 'error' ? (
          <>
            <span className="shrink-0 text-xs">
              <Button
                type="button"
                variant="link"
                aria-describedby={nameId}
                data-testid={testIds.uploadRetry}
                onClick={onRetry}
              >
                Try again
              </Button>
            </span>
            <RowActionButton
              label="Dismiss upload"
              describedBy={nameId}
              testId={testIds.uploadDismiss}
              onClick={onDismiss}
            >
              <TrashIcon size={12} />
            </RowActionButton>
          </>
        ) : (
          <span className="shrink-0 text-2xs fg-secondary">
            {formatAttachmentSize(upload.file.size)}
          </span>
        )}
      </div>
    </Surface>
  );
}
