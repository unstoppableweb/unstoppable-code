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
  DelayedLoadingPlaceholder,
  ErrorBanner,
  InlineDeleteConfirm,
  LoadingSpinner,
  RowActionButton,
  RowActionTray,
  Skeleton,
  Surface,
} from '@canopy/ui-shared/components';
import { FileTypeIcon, MentionIcon } from '@canopy/ui-shared/icons';
import {
  AttachmentIcon,
  CloseIcon,
  DownloadIcon,
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
  /** What a row shows at its end, such as the file's size and date. */
  readonly detail?: (row: AttachmentListRow) => string | undefined;
  /**
   * What a click on a row does: a viewer, a preview, the file's own app.
   * A rejection shows `failureMessage` under the list.
   */
  readonly open?: {
    readonly canOpen: (row: AttachmentListRow) => boolean;
    readonly run: (row: AttachmentListRow) => void | Promise<void>;
    readonly failureMessage?: string;
  };
  /**
   * The host's own preview while the pointer rests on a row, for a file the
   * scope cannot open (a read-only folder's document). `overlay` is drawn
   * once, beside the list.
   */
  readonly hover?: {
    readonly shows: (row: AttachmentListRow) => boolean;
    readonly onEnter: (row: AttachmentListRow, anchor: HTMLElement) => void;
    readonly onLeave: () => void;
    readonly overlay: ReactNode;
  };
  readonly mention?: (row: AttachmentListRow) => void;
  /** A rejection shows `failureMessage` under the list. */
  readonly reveal?: {
    readonly label: string;
    readonly run: (row: AttachmentListRow) => void | Promise<void>;
    readonly failureMessage?: string;
  };
  readonly download?: (row: AttachmentListRow) => Promise<void>;
  readonly remove?: (row: AttachmentListRow) => Promise<void>;
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
  /** The row's open button, where the row opens its file. */
  readonly rowContent?: string;
  readonly rowActions?: string;
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

/** The open button's generic label; the row names the file. */
function openLabel(row: AttachmentListRow): string {
  const type = row.mediaType ?? '';
  if (type.startsWith('image/') || IMAGE_FILENAME.test(row.filename))
    return 'Open image';
  if (type.startsWith('video/') || VIDEO_FILENAME.test(row.filename))
    return 'Open video';
  return 'Open file';
}

const IMAGE_FILENAME = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i;
const VIDEO_FILENAME = /\.(mp4|mov|m4v|webm)$/i;

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

/** Where focus goes once the row actions the user was in re-render. */
type PendingFocus =
  | { readonly kind: 'delete-button'; readonly rowId: string }
  | {
      readonly kind: 'after-delete';
      readonly rowId: string;
      readonly index: number;
    };

/** Whether a row shows any control, so a row without one keeps its size. */
function rowHasActions(source: AttachmentsSource): boolean {
  const { mention, reveal, download, remove } = source;
  return (
    mention !== undefined ||
    reveal !== undefined ||
    download !== undefined ||
    remove !== undefined
  );
}

const SAMPLE_ROWS: readonly AttachmentListRow[] = [
  { id: 'sample-1', filename: 'design-notes.md', sizeBytes: 4200 },
  { id: 'sample-2', filename: 'screenshot.png', sizeBytes: 182_000 },
  { id: 'sample-3', filename: 'requirements.pdf', sizeBytes: 96_000 },
];

/** The list that has not arrived: real rows from samples, measured. */
function AttachmentListSkeleton({
  testId,
  showDetail,
}: {
  readonly testId: string;
  readonly showDetail: boolean;
}): JSX.Element {
  return (
    <Skeleton loading label="Loading attachments" testId={testId}>
      <ul className="flex flex-col gap-1">
        {SAMPLE_ROWS.map((row) => (
          <AttachmentItemRow
            key={row.id}
            as="li"
            testId={`${testId}-row`}
            filename={row.filename}
            icon={
              <FileTypeIcon
                filename={row.filename}
                size="sm"
                className="shrink-0"
              />
            }
            metadata={
              showDetail && row.sizeBytes !== undefined
                ? formatAttachmentSize(row.sizeBytes)
                : undefined
            }
          />
        ))}
      </ul>
    </Skeleton>
  );
}

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

/**
 * The body of an attachments section: the files as rows
 * (`AttachmentItemRow`), the drop target, add and each file's actions. A
 * click on a row opens the file where the source can; uploads in flight are
 * rows after them.
 */
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
  // Rows whose download is in flight. A ref, not `disabled`, so a second
  // click is ignored without pulling the focused button out from under it.
  const downloadingRef = useRef(new Set<string>());
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const dropTargetRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<PendingFocus | null>(null);

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
    setAnnouncement('');
    // Read only by completions, never rendered.
    // eslint-disable-next-line react-hooks/refs
    activationRef.current = next;
  }

  // A new scope drops the previous one's focus intent and download guards.
  // Declared before the focus effect below, so it runs first.
  useEffect(() => {
    pendingFocusRef.current = null;
    downloadingRef.current = new Set();
  }, [scopeKey]);

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

  /**
   * An open or reveal that fails says so under the list, beside the files.
   * Only the latest one's failure is told: an earlier one that fails after a
   * later one succeeded would bring back a banner for a done action.
   */
  const fileActionRef = useRef(0);
  const runFileAction = (
    run: () => void | Promise<void>,
    failureMessage: string,
  ): void => {
    const generation = activationRef.current.generation;
    fileActionRef.current += 1;
    const action = fileActionRef.current;
    setActionError(null);
    const pending = run();
    if (pending === undefined) return;
    void pending.catch((): void => {
      if (isCurrent(generation) && action === fileActionRef.current) {
        setActionError(failureMessage);
      }
    });
  };

  const handleDownload = (row: AttachmentListRow): void => {
    if (source.download === undefined) return;
    const downloading = downloadingRef.current;
    if (downloading.has(row.id)) return;
    downloading.add(row.id);
    const generation = activationRef.current.generation;
    setActionError(null);
    void source
      .download(row)
      .catch((): void => {
        if (isCurrent(generation))
          setActionError('Download failed. Try again.');
      })
      .finally((): void => {
        downloading.delete(row.id);
      });
  };

  const rows = load.kind === 'ready' ? load.rows : [];

  const handleCancelDelete = (row: AttachmentListRow): void => {
    pendingFocusRef.current = { kind: 'delete-button', rowId: row.id };
    setConfirmingId(null);
  };

  const handleDelete = (row: AttachmentListRow): void => {
    if (source.remove === undefined) return;
    const generation = activationRef.current.generation;
    const index = rows.findIndex((candidate) => candidate.id === row.id);
    setDeletePending(true);
    setActionError(null);
    setAnnouncement('');
    void source
      .remove(row)
      .then((): void => {
        if (!isCurrent(generation)) return;
        pendingFocusRef.current = {
          kind: 'after-delete',
          rowId: row.id,
          index,
        };
        setAnnouncement('Attachment deleted.');
      })
      .catch((): void => {
        if (!isCurrent(generation)) return;
        pendingFocusRef.current = { kind: 'delete-button', rowId: row.id };
        setActionError('Delete failed. Try again.');
      })
      .finally((): void => {
        if (!isCurrent(generation)) return;
        setConfirmingId(null);
        setDeletePending(false);
      });
  };

  // Upload rows come after the files, and a long folder already fills the
  // list's height: bring newly added uploads (they join the end) into view, and an
  // upload that has just failed, whose row grows by its Try again. A batch
  // keeps its order, so a failed row can sit above later ones: the list
  // scrolls to that row, not to its end.
  const shownUploadsRef = useRef<{
    readonly count: number;
    readonly failed: ReadonlySet<string>;
    readonly listState: string;
  }>({ count: 0, failed: new Set(), listState: '' });
  const uploadCount = uploads.length;
  const failedUploadKey = uploads
    .filter((upload) => upload.state === 'error')
    .map((upload) => upload.localId)
    .join('\n');
  // The list reloads after a later upload lands, which rebuilds the list and
  // resets its scroll: a failed row already brought into view is brought
  // back once the list is shown again.
  // A drag over the section shows the drop zone in the list's place, so a
  // row cannot be scrolled to until the drag ends.
  const listState = drag.dragging
    ? 'dragging'
    : load.kind === 'ready'
      ? `ready:${String(load.rows.length)}`
      : load.kind;
  useEffect(() => {
    const list = dropTargetRef.current;
    const shown = shownUploadsRef.current;
    const failed = failedUploadKey === '' ? [] : failedUploadKey.split('\n');
    // A failed row counts as shown only once it has been scrolled to.
    const shownFailed = new Set(failed.filter((id) => shown.failed.has(id)));
    const relisted = listState !== shown.listState;
    const target =
      failed.find((id) => !shownFailed.has(id)) ??
      (relisted ? failed[failed.length - 1] : undefined);
    if (list !== null && target !== undefined) {
      const row = Array.from(
        list.querySelectorAll<HTMLElement>('[data-upload-id]'),
      ).find((element) => element.dataset.uploadId === target);
      if (row !== undefined) {
        const rowBox = row.getBoundingClientRect();
        const listBox = list.getBoundingClientRect();
        if (rowBox.top < listBox.top) {
          list.scrollTop -= listBox.top - rowBox.top;
        } else if (rowBox.bottom > listBox.bottom) {
          list.scrollTop += rowBox.bottom - listBox.bottom;
        }
        shownFailed.add(target);
      }
    } else if (list !== null && uploadCount > shown.count) {
      list.scrollTop = list.scrollHeight;
    }
    shownUploadsRef.current = {
      count: uploadCount,
      failed: shownFailed,
      listState,
    };
  }, [uploadCount, failedUploadKey, listState]);

  // Focus was in the row's actions, which re-render or unmount, so place it
  // again rather than let it fall to the page. A deleted row waits for the
  // source to drop it, then focus moves to the row now in its place.
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending === null) return;
    // Only replace focus the section lost: never pull it back from the
    // composer or another pane the person moved to meanwhile.
    const active = document.activeElement;
    const root = dropTargetRef.current;
    if (
      active !== null &&
      active !== document.body &&
      root?.contains(active) !== true
    ) {
      pendingFocusRef.current = null;
      return;
    }
    const listed = load.kind === 'ready' ? load.rows : [];
    const index = listed.findIndex((row) => row.id === pending.rowId);
    const list = listRef.current;
    if (pending.kind === 'delete-button') {
      pendingFocusRef.current = null;
      list?.children
        .item(index)
        ?.querySelector<HTMLElement>(`[data-testid="${testIds.delete}"]`)
        ?.focus();
      return;
    }
    if (index !== -1) return;
    pendingFocusRef.current = null;
    const next =
      list?.children.item(pending.index) ??
      list?.children.item(pending.index - 1);
    const target =
      next?.querySelector<HTMLElement>('button, [role="button"]') ??
      list ??
      dropTargetRef.current?.querySelector<HTMLElement>('[role="button"]');
    target?.focus();
  }, [load, confirmingId, testIds.delete]);
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
        ref={dropTargetRef}
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
              <DelayedLoadingPlaceholder slowNote="Still loading attachments…">
                <AttachmentListSkeleton
                  testId={testIds.loading}
                  showDetail={source.detail !== undefined}
                />
              </DelayedLoadingPlaceholder>
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
                onAdd={add === undefined ? undefined : openPicker}
                testId={testIds.empty}
              />
            ) : null}
            {rows.length > 0 || uploads.length > 0 ? (
              <ul
                ref={listRef}
                tabIndex={-1}
                aria-label="Attachments"
                className="flex flex-col gap-1 outline-none"
              >
                {rows.map((row) => {
                  const open = source.open;
                  const opens = open?.canOpen(row) === true;
                  const hover = source.hover?.shows(row) === true;
                  return (
                    <AttachmentItemRow
                      key={row.id}
                      as="li"
                      testId={testIds.row}
                      attachmentId={row.domId}
                      state="ready"
                      filename={row.filename}
                      icon={
                        <FileTypeIcon
                          filename={row.filename}
                          size="sm"
                          className="shrink-0"
                        />
                      }
                      metadata={source.detail?.(row)}
                      {...(testIds.rowContent === undefined
                        ? {}
                        : { contentTestId: testIds.rowContent })}
                      {...(opens && open !== undefined
                        ? {
                            onOpen: (): void =>
                              runFileAction(
                                () => open.run(row),
                                open.failureMessage ??
                                  'Open failed. Try again.',
                              ),
                            openLabel: openLabel(row),
                          }
                        : {})}
                      {...(hover
                        ? {
                            onMouseEnter: (event): void =>
                              source.hover?.onEnter(row, event.currentTarget),
                            onMouseLeave: source.hover?.onLeave,
                          }
                        : {})}
                      actions={
                        rowHasActions(source)
                          ? (nameId): ReactNode => (
                              <AttachmentRowActions
                                row={row}
                                nameId={nameId}
                                source={source}
                                testIds={testIds}
                                confirming={confirmingId === row.id}
                                deletePending={deletePending}
                                uploadPending={uploadPending}
                                mutationsPending={mutationsPending}
                                onRequestDelete={(): void =>
                                  setConfirmingId(row.id)
                                }
                                onCancelDelete={(): void =>
                                  handleCancelDelete(row)
                                }
                                onConfirmDelete={(): void => handleDelete(row)}
                                onReveal={(): void => {
                                  const reveal = source.reveal;
                                  if (reveal === undefined) return;
                                  runFileAction(
                                    () => reveal.run(row),
                                    reveal.failureMessage ??
                                      'Reveal failed. Try again.',
                                  );
                                }}
                                onDownload={(): void => handleDownload(row)}
                              />
                            )
                          : undefined
                      }
                    />
                  );
                })}
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
      <p role="status" className="sr-only">
        {announcement}
      </p>
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

/**
 * A row's actions, in the tray its end reveals on hover or focus. The
 * delete confirm takes the tray's place while it asks.
 */
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
  onReveal,
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
  readonly onReveal: () => void;
  readonly onDownload: () => void;
}): JSX.Element {
  const { mention, reveal, download, remove } = source;
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
              onClick={onReveal}
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
      data-upload-id={upload.localId}
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
          // Safe in replay: the block class drops the element's attributes.
          title={upload.file.name}
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
              <CloseIcon size={12} />
            </RowActionButton>
          </>
        ) : (
          <span className="shrink-0 text-2xs tabular-nums fg-secondary">
            {formatAttachmentSize(upload.file.size)}
          </span>
        )}
      </div>
    </Surface>
  );
}
