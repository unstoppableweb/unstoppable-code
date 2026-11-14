'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type UIEventHandler,
} from 'react';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';
import {
  fileViewerKey,
  useFileViewerStore,
  type FileOverlapComparison,
  type FileChangeSource,
  type FileSaveConflict,
  type FileViewerSession,
  type FileViewMode,
} from '@canopy/app-state';
import {
  LoadingRegion,
  Button,
  Stack,
  ConfirmDialog,
  ErrorState,
  Notice,
  NoticeButton,
  SegmentedControl,
  type MermaidSaveDestination,
  StatusLabel,
  Surface,
} from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import type { FileLinkLineLocation } from '@canopy/ui-shared/lib/file-link-line-suffix';
import { isShortcutEvent } from '../../find/shortcut-target';
import { FileReadOnlyCode } from './FileReadOnlyCode';
import { FileOverlapNotice, firstUnresolvedPassage } from './FileOverlapNotice';
import {
  fileExtension,
  isNotebookPath,
  resolveFileRenderKind,
  isRichDocumentRenderKind,
  type FileRenderKind,
  type RichDocumentRenderKind,
} from './file-kind';
import { FileHtmlPreview, type FileHtmlPreviewProps } from './FileHtmlPreview';
import { FileMarkdownPreview } from './FileMarkdownPreview';
import { FileCsvPreview } from './FileCsvPreview';
import { FileRenderedRegion } from './FileRenderedRegion';
import {
  FileNotebookPreview,
  notebookParseFailureNotice,
} from './FileNotebookPreview';
import { parseNotebookCached } from './notebook/parse-notebook';
import {
  FilePreviewSearch,
  type PreviewSearchControlled,
  type PreviewSearchPresentation,
  type PreviewSearchState,
} from './FilePreviewSearch';

/**
 * A request to reveal lines of the open file (CAN-4275), from a transcript
 * link such as `src/a.ts:12-20`. Hosts bump `revision` for every click so a
 * repeated click on the same lines is a fresh reveal; the viewer treats each
 * distinct `line`/`lineEnd`/`revision` as one request.
 */
export type FileLineReveal = FileLinkLineLocation & {
  readonly revision?: number;
};

/**
 * Props the host passes to its injected editor. Desktop lazy-loads Monaco and
 * renders it here; the browser-safe package never imports Monaco itself, so a
 * relay host (web) simply omits {@link FileViewerProps.renderEditor} and the
 * viewer falls back to a read-only `<pre>`.
 */
export interface FileEditorSlot {
  readonly value: string;
  readonly language?: string;
  readonly filePath: string;
  readonly dirty: boolean;
  readonly onChange: (next: string) => void;
  readonly onSave: () => void;
  /**
   * The current reveal request, if any. Apply it once per distinct request
   * after the editor shows this file's content (clamped to its lines), not on
   * every content change, so editing never snaps the selection back.
   */
  readonly reveal?: FileLineReveal;
  /** False until this reveal request has read the current file content. */
  readonly revealReady?: boolean;
}

export interface FileContentScrollBinding {
  readonly ref: (node: HTMLElement | null) => void;
  readonly onScroll: UIEventHandler<HTMLElement>;
  /**
   * Called when async content (an image, or images inside rendered markdown)
   * finishes loading and may have grown the scroll extents — hosts use it to
   * re-apply a persisted scroll position after layout settles.
   */
  readonly onContentLoaded?: () => void;
}

export type FileDocumentBytesResult =
  | { readonly status: 'ready'; readonly bytes: ArrayBuffer }
  | { readonly status: 'too-large'; readonly maxBytes: number }
  | { readonly status: 'failed'; readonly message?: string };

export type FileDocumentRenderFailure =
  | 'password-protected'
  | 'corrupt'
  /** The host parser could not convert the bytes (REG-2903 upgrades this seam). */
  | 'parse-failed';

export interface FileRichDocumentSlot {
  readonly bytes: ArrayBuffer;
  readonly request: PortalFileReadPayload;
  readonly displayName: string;
  /** Selects the host renderer without re-sniffing the file. */
  readonly renderKind: RichDocumentRenderKind | 'image';
  readonly onRenderFailure: (failure: FileDocumentRenderFailure) => void;
}

/**
 * The write-once file viewer for the Code tab. Reads/opens the file through the
 * shared {@link useFileViewerStore} (which routes to `client.query('file.read')`
 * / `client.command('file.save')`), and picks a renderer from the file's kind:
 *
 * - `code`: the injected {@link FileViewerProps.renderEditor} when the host can
 *   edit (`fileSystemAccess === 'read-write'`), else a read-only `<pre>`.
 * - `markdown` / `html`: a Raw/Preview toggle over the editor-or-`<pre>` (raw)
 *   and {@link FileMarkdownPreview} / {@link FileHtmlPreview} (preview).
 * - CSV: a Raw/Table toggle over the editor-or-`<pre>` and a parsed table.
 *
 * Editing, saving, and discarding are gated on the store's `canEdit` — the same
 * capability signal — so a relay host shows a read-only view with no Save/Discard.
 */
export interface FileViewerProps {
  /** Mounted background tabs refresh silently. Defaults to a visible viewer. */
  readonly active?: boolean;
  /** Read-only host presentation that shares the file chrome and preserves the editable session. */
  readonly alternateContent?: ReactNode;
  readonly request: PortalFileReadPayload;
  /** Overrides extension dispatch before a binary read (for MIME-known files). */
  readonly requestRenderKind?: FileRenderKind;
  /** Host editor slot (desktop Monaco); omit for a read-only host. */
  readonly renderEditor?: (slot: FileEditorSlot) => ReactNode;
  /** Opens an in-app target for a relative markdown link. */
  readonly onOpenRelativePath?: (path: string) => void;
  /**
   * Where Markdown diagram pictures are saved. Hosts that create files
   * beside the document supply a sibling destination; omitted, pictures
   * download under the document's name.
   */
  readonly diagramSaveDestination?: MermaidSaveDestination;
  /** Resolves relative preview images; HTML requires an image data URL. */
  readonly resolveAssetSrc?: (
    src: string,
  ) => string | Promise<string | null> | null;
  /** Authorized HTML asset identity with a lazy byte read for alias deduplication. */
  readonly resolveHtmlAsset?: FileHtmlPreviewProps['resolveHtmlAsset'];
  /** Resolves an image file request to a host-renderable URL/data URL. */
  readonly resolveImageSrc?: (
    request: PortalFileReadPayload,
  ) => Promise<string | null>;
  /** Fetches bounded bytes for a host-owned rich-document renderer. */
  readonly resolveDocumentBytes?: (
    request: PortalFileReadPayload,
    signal: AbortSignal,
  ) => Promise<FileDocumentBytesResult>;
  /** Host-owned rich-document renderer; ui-app remains vendor-neutral. */
  readonly renderRichDocument?: (slot: FileRichDocumentSlot) => ReactNode;
  /** Rich document kinds this host explicitly supports. Defaults to PDF only. */
  readonly supportedDocumentKinds?: readonly RichDocumentRenderKind[];
  /** Opt-in image renderer sharing the bounded, cancellable document loader. */
  readonly renderImageDocument?: (slot: FileRichDocumentSlot) => ReactNode;
  /** Safe display name for document chrome and failures. */
  readonly documentDisplayName?: string;
  /**
   * Sentence appended to the parse-failed card after
   * "<name> could not be converted for preview." Hosts without a download
   * action (desktop) pass their platform recovery sentence.
   */
  readonly documentRecoveryHint?: string;
  /** Changing this value re-runs the image resolver for the same request. */
  readonly imageRetryGeneration?: number;
  /** Re-resolves document bytes without changing the stable resolver. */
  readonly documentRetryGeneration?: number;
  /** Optional host-owned mode used by desktop's persisted file tabs. */
  readonly viewMode?: FileViewMode;
  /** Host focus gate for Cmd/Ctrl+F when the panel tab owns keyboard focus. */
  readonly searchShortcutActive?: boolean;
  /** Optional host-owned command for the active preview search drawer. */
  readonly previewSearchControl?: {
    operation: 'open' | 'close';
    revision: number;
  };
  /** Acknowledges that a host-owned drawer command was consumed. */
  readonly onPreviewSearchControlApplied?: (revision: number) => void;
  /** Reports bounded drawer metadata without exposing the search query. */
  readonly onPreviewSearchStateChange?: (state: PreviewSearchState) => void;
  /** `headless` hands the preview search UI to the host (desktop find bar). */
  readonly previewSearchPresentation?: PreviewSearchPresentation;
  /** Host-owned search state for the `headless` presentation. */
  readonly previewSearchControlled?: PreviewSearchControlled;
  /** Headless only: the preview asked to open or close the search. */
  readonly onPreviewSearchRequest?: (operation: 'open' | 'close') => void;
  readonly onViewModeChange?: (mode: FileViewMode) => void;
  /** Optional host-owned controls rendered in the existing header row. */
  readonly headerActions?: ReactNode;
  /**
   * Optional host-owned replacement for the plain path text in the header
   * row (e.g. desktop's interactive breadcrumb). Receives the displayed
   * path; the dirty indicator stays owned by the viewer. Returning `null`
   * means the host displays the path in its own chrome, so the viewer leaves
   * the slot empty and drops the whole row when nothing else fills it.
   */
  readonly renderPathBreadcrumb?: (path: string) => ReactNode;
  /**
   * Optional host-owned controls rendered at the very end of the header row,
   * after the view-mode toggle (e.g. desktop's embedded file-tree toggle).
   */
  readonly trailingHeaderActions?: ReactNode;
  /** Optional host-owned action shown after the unsupported-file explanation. */
  readonly unsupportedFileAction?: ReactNode;
  /** Gap before a margin-free fallback action. Omitted keeps the legacy layout. */
  readonly unsupportedFileActionGap?: 'item';
  /**
   * Byte budget the host's file read is capped at, used to state the real
   * limit in the truncation banner. Defaults to desktop's 5 MiB
   * (`MAX_TEXT_BYTES_FULL`); relay hosts with a smaller window pass their own
   * so the banner never overstates how much of the file is on screen.
   */
  readonly previewByteBudget?: number;
  /**
   * Keep a missing first read in the neutral loading state while the host is
   * waiting for an external lifecycle (for example, desktop worktree setup)
   * to make the file available and issue one final read.
   */
  readonly deferMissing?: boolean;
  /** Optional host-owned binding for the active scrollable content body. */
  readonly contentScrollBinding?: FileContentScrollBinding;
  /**
   * Lines to reveal in the raw text view (CAN-4275). Read-only text
   * highlights them and centers the first line in its own scroller; the
   * editor slot receives it as `reveal`. Rendered previews ignore it until
   * the file enters raw mode. Omit for an unlocated open.
   */
  readonly revealLine?: FileLineReveal;
  /**
   * Vocabulary for the raw segment of the view selector (CAN-5004). `edit`
   * names it Edit, for a Cowork project or workspace, but only while the file
   * can actually be edited; otherwise it stays Source. Hosts resolve it from
   * the file's own project or workspace. Defaults to `source`.
   */
  readonly rawViewLabel?: 'source' | 'edit';
  /**
   * Product name from the host's brand helper, used to attribute agent
   * changes in save-conflict copy. Omit for neutral copy.
   */
  readonly appName?: string;
  /**
   * Prepares a follow-up chat draft asking the agent to keep the user's
   * edits to an overlapping passage. Only inserts the draft for review: never
   * sends it, changes the file, or resolves the comparison. Omit where the
   * host cannot insert into the file's chat; the action is then absent.
   */
  readonly onAskToKeepEdits?: (prompt: string) => void;
}

type RawViewLabelText = 'Edit' | 'Source';

function resolveRawViewLabel(
  rawViewLabel: FileViewerProps['rawViewLabel'],
  editable: boolean,
): RawViewLabelText {
  return rawViewLabel === 'edit' && editable ? 'Edit' : 'Source';
}

interface FileStatusActionsProps {
  readonly session: FileViewerSession;
  readonly editable: boolean;
  readonly savedContentNotice?: boolean;
  /** Header row that takes focus when a confirmed discard removes Discard. */
  readonly focusFallbackRef: RefObject<HTMLDivElement | null>;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}

/** One file incarnation, so a confirmation never outlives the file it names. */
function discardConfirmIdentity(session: FileViewerSession): string {
  return JSON.stringify([session.key, session.generation ?? 0]);
}

/**
 * React bubbles portaled events through their React parents, so keys pressed
 * in the discard confirmation reach the header's handlers. Only keys from the
 * header's own DOM may drive its raw-activation guard.
 */
function keyFromHeaderDom(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.composedPath().includes(event.currentTarget);
}

function fileDisplayName(relativePath: string): string {
  const name = relativePath.split(/[\\/]/).pop();
  return name ? name : relativePath;
}

/**
 * Whether `FileStatusActions` renders anything at all. The header gate needs
 * the same answer, and duplicating the component's internal conditions would
 * let the two drift into an empty bordered row.
 */
function fileStatusActionsVisible(
  session: FileViewerSession,
  editable: boolean,
  savedContentNotice = false,
): boolean {
  return (
    session.status === 'saving' ||
    session.status === 'error' ||
    (session.dirty && (editable || savedContentNotice))
  );
}

function FileStatusActions({
  session,
  editable,
  savedContentNotice = false,
  focusFallbackRef,
  onDiscard,
  onSave,
}: FileStatusActionsProps): JSX.Element {
  // The file the open confirmation was asked about, or null when closed.
  const [confirmingDiscard, setConfirmingDiscard] = useState<string | null>(
    null,
  );
  const identity = discardConfirmIdentity(session);
  const confirmOpen =
    confirmingDiscard === identity && editable && session.dirty;
  // Clear rather than hide, so a later dirty cycle never brings it back.
  useEffect(() => {
    if (confirmingDiscard !== null && !confirmOpen) setConfirmingDiscard(null);
  }, [confirmingDiscard, confirmOpen]);
  const stale = session.baselineStale === true;

  const acceptDiscard = (): void => {
    // Recheck here rather than trusting the disabled action or the clearing
    // effect: a save, file switch or clean buffer may have just landed.
    const ready = confirmOpen && session.status !== 'saving';
    setConfirmingDiscard(null);
    if (!ready) return;
    // Discard removes the control that opened the dialog; land on the header
    // first so the dialog leaves focus there instead of on the page.
    focusFallbackRef.current?.focus();
    onDiscard();
  };

  if (!fileStatusActionsVisible(session, editable, savedContentNotice))
    return <></>;
  const statusText =
    session.status === 'saving'
      ? 'Saving…'
      : session.status === 'error'
        ? (session.error ?? 'Save failed')
        : null;
  // Its own 8px rhythm: the header row packs its icon actions 4px apart,
  // which is too tight between status text and labeled buttons. In a narrow
  // header only the status text gives way, so the actions stay whole.
  return (
    <div className="flex min-w-0 items-center gap-2">
      {savedContentNotice && session.dirty && (
        <span
          className="shrink-0 whitespace-nowrap fg-secondary"
          data-testid="file-diff-saved-content"
        >
          Diff shows saved content
        </span>
      )}
      {statusText && (
        <span
          role={session.status === 'error' ? 'alert' : undefined}
          className={`min-w-0 truncate ${
            session.status === 'error' ? '' : 'fg-secondary'
          }`}
          title={statusText}
        >
          {session.status === 'error' ? (
            <StatusLabel>{statusText}</StatusLabel>
          ) : (
            statusText
          )}
        </span>
      )}
      {editable && session.dirty && (
        <>
          <Button
            variant="ghost"
            size="compact"
            disabled={session.status === 'saving'}
            onClick={(): void => setConfirmingDiscard(identity)}
            data-testid="file-discard"
          >
            {/* A stale baseline makes Discard load the disk version. */}
            {stale ? 'Discard my edits' : 'Discard'}
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={session.status === 'saving'}
            onClick={onSave}
            data-testid="file-save"
          >
            Save
          </Button>
        </>
      )}
      {confirmOpen && (
        <ConfirmDialog
          title={
            <>
              Discard your edits to “
              <span className={REPLAY_MASK_CLASS}>
                {fileDisplayName(session.request.relativePath)}
              </span>
              ”?
            </>
          }
          message={
            stale
              ? 'Discarding loses the edits you haven’t saved and shows the latest version of the document.'
              : 'Discarding loses the edits you haven’t saved.'
          }
          confirmLabel="Discard edits"
          destructive
          confirmDisabled={session.status === 'saving'}
          onConfirm={acceptDiscard}
          onCancel={(): void => setConfirmingDiscard(null)}
          restoreFocusRef={focusFallbackRef}
          dataTestId="file-discard-confirm"
          confirmTestId="file-discard-confirm-accept"
          cancelTestId="file-discard-confirm-cancel"
        />
      )}
    </div>
  );
}

interface FileExternalChangeNoticeProps {
  readonly session: FileViewerSession;
  /** Header row that takes focus when an action removes the notice. */
  readonly focusFallbackRef: RefObject<HTMLDivElement | null>;
  readonly appName?: string;
}

/**
 * Keep keyboard focus in the viewer when a focused notice action removes the
 * notice: on Save when edits remain, otherwise on the header row.
 */
function focusSaveOrHeader(
  focusFallbackRef: RefObject<HTMLDivElement | null>,
): void {
  const header = focusFallbackRef.current;
  const save = header?.querySelector<HTMLButtonElement>(
    '[data-testid="file-save"]',
  );
  (save && !save.disabled ? save : header)?.focus();
}

/**
 * Shown when the document changed while the buffer has unsaved edits and the
 * versions cannot be compared passage by passage (otherwise
 * {@link FileOverlapNotice} owns recovery). Keeping the newer version
 * replaces the buffer now. Keep mine changes nothing until the user saves,
 * and it leaves the save baseline stale, so that save meets the existing
 * save-conflict check before anything is replaced. With a clean buffer the
 * notice only offers Show latest.
 */
function FileExternalChangeNotice({
  session,
  focusFallbackRef,
  appName,
}: FileExternalChangeNoticeProps): JSX.Element | null {
  const reloadFromDisk = useFileViewerStore((state) => state.reloadFromDisk);
  const dismissExternalChange = useFileViewerStore(
    (state) => state.dismissExternalChange,
  );
  const noticeRef = useRef<HTMLDivElement>(null);
  const change = session.externalChange;
  // A pending save conflict or a comparison owns recovery; never show both.
  if (!change || session.saveConflict || session.overlap) return null;

  const moveFocusFromNotice = (): void => {
    if (!noticeRef.current?.contains(document.activeElement)) return;
    focusSaveOrHeader(focusFallbackRef);
  };
  // An empty brand reads as unattributed, matching FileSaveConflictNotice.
  const attributed = Boolean(appName) && change.source === 'agent-edit';
  // Neither dirty choice is primary: each discards what the other keeps, so
  // there is no recommended action. A deliberate exception, for this notice
  // only, to the inline-notice rule in docs/ux-writing/errors.md.
  const changedBy = attributed
    ? `${appName} also changed this document.`
    : 'This document also changed.';
  const message = session.dirty
    ? `${changedBy} The version you don't keep is replaced.`
    : attributed
      ? `${appName} changed this document.`
      : 'This document changed.';
  const showLabel = !session.dirty
    ? 'Show latest'
    : attributed
      ? `Keep ${appName}'s`
      : 'Keep latest';

  return (
    <Surface variant="section" boundary="bottom">
      <div ref={noticeRef} className="px-3 py-2">
        <Notice
          intent="attention"
          title="Document updated"
          data-testid="file-external-change-notice"
          detail={
            change.error
              ? `Couldn't load the latest version. ${change.error}`
              : undefined
          }
          actions={
            <>
              {session.dirty && (
                <NoticeButton
                  data-testid="file-external-change-keep"
                  disabled={change.reloading}
                  onClick={(): void => {
                    moveFocusFromNotice();
                    dismissExternalChange(session.key);
                  }}
                >
                  Keep mine
                </NoticeButton>
              )}
              <NoticeButton
                variant={session.dirty ? undefined : 'primary'}
                data-testid="file-external-change-show-latest"
                disabled={change.reloading || session.status === 'saving'}
                onClick={(): void => {
                  const ownedFocus =
                    noticeRef.current?.contains(document.activeElement) ===
                    true;
                  void reloadFromDisk(session.key).then((applied) => {
                    if (
                      applied &&
                      ownedFocus &&
                      (document.activeElement === document.body ||
                        noticeRef.current?.contains(document.activeElement))
                    ) {
                      focusFallbackRef.current?.focus();
                    }
                  });
                }}
              >
                {showLabel}
              </NoticeButton>
            </>
          }
        >
          {message}
        </Notice>
      </div>
    </Surface>
  );
}

interface FileSaveConflictNoticeProps {
  readonly session: FileViewerSession;
  readonly conflict: FileSaveConflict;
  /** Header row that takes focus when an action removes the notice. */
  readonly focusFallbackRef: RefObject<HTMLDivElement | null>;
  /**
   * The last explicit save request this viewer has focused. Owned by the
   * viewer so switching presentations does not focus the notice again.
   */
  readonly handledFocusRequestRef: RefObject<number>;
  readonly appName?: string;
}

const CONFLICT_REASON_COPY: Record<
  Exclude<FileSaveConflict['reason'], 'read-unavailable'>,
  string
> = {
  overlap: "The changes overlap, so they couldn't be combined automatically.",
  'merge-skipped': "These changes couldn't be combined automatically.",
  'changed-again':
    'The document changed again. Review the choices and try again.',
  'newer-edits': 'You have newer unsaved edits. Choose how to continue.',
};

/**
 * Shown when a save was refused because the document changed after editing
 * began, the changes could not be combined, and no passage comparison is
 * available. Both choices replace the whole document, so the message names
 * what each replaces before either is used.
 */
function FileSaveConflictNotice({
  session,
  conflict,
  focusFallbackRef,
  handledFocusRequestRef,
  appName,
}: FileSaveConflictNoticeProps): JSX.Element {
  const reloadFromDisk = useFileViewerStore((state) => state.reloadFromDisk);
  const overwriteWithEdits = useFileViewerStore(
    (state) => state.overwriteWithEdits,
  );
  const noticeRef = useRef<HTMLDivElement>(null);
  const busy = conflict.resolving !== null || session.status === 'saving';

  // Focus once per explicit save request, never for autosave or typing.
  useEffect(() => {
    if (conflict.focusRequest <= handledFocusRequestRef.current) return;
    if (busy) return;
    handledFocusRequestRef.current = conflict.focusRequest;
    noticeRef.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus();
  }, [busy, conflict.focusRequest, handledFocusRequestRef]);

  const attributed = Boolean(appName) && conflict.source === 'agent-edit';
  const showLabel = attributed
    ? `Show ${appName}'s version`
    : 'Show latest version';
  const latestUnavailable = `Couldn't get the latest version. Try ${showLabel} again.`;
  const message = [
    attributed
      ? `${appName} changed this document after you started editing.`
      : 'This document changed after you started editing.',
    conflict.reason === 'read-unavailable'
      ? latestUnavailable
      : CONFLICT_REASON_COPY[conflict.reason],
    `${showLabel} replaces your unsaved edits. Save my version replaces the newer version.`,
  ].join(' ');
  const detail =
    conflict.error === null
      ? undefined
      : conflict.error.kind === 'latest-unavailable'
        ? latestUnavailable
        : `Couldn't save your version. ${conflict.error.message}`;

  // Restore focus only when the action that removed the notice owned it and
  // the user has not moved on (for example, back to the editor).
  const runAction = (action: (key: string) => Promise<boolean>): void => {
    const ownedFocus =
      noticeRef.current?.contains(document.activeElement) === true;
    void action(session.key).then((resolved) => {
      if (
        resolved &&
        ownedFocus &&
        (document.activeElement === document.body ||
          noticeRef.current?.contains(document.activeElement))
      ) {
        focusSaveOrHeader(focusFallbackRef);
      }
    });
  };

  return (
    <Surface variant="section" boundary="bottom">
      <div ref={noticeRef} className="px-3 py-2">
        <Notice
          errorSource="file-save-conflict-notice"
          displayErrorCode={
            conflict.error === null && conflict.reason !== 'read-unavailable'
              ? 'external.state_changed'
              : undefined
          }
          intent="destructive"
          title="Not saved"
          data-testid="file-save-conflict-notice"
          detail={detail}
          actions={
            <>
              <NoticeButton
                data-testid="file-save-conflict-show-latest"
                disabled={busy}
                onClick={(): void => runAction(reloadFromDisk)}
              >
                {showLabel}
              </NoticeButton>
              <NoticeButton
                variant="primary"
                data-testid="file-save-conflict-save-mine"
                disabled={busy}
                onClick={(): void => runAction(overwriteWithEdits)}
              >
                Save my version
              </NoticeButton>
            </>
          }
        >
          {message}
        </Notice>
      </div>
    </Surface>
  );
}

/**
 * Points a reader at the raw view of an editable rendered preview (CAN-5004).
 * Markdown and CSV reveal it on a typing attempt, announce it once, and let
 * it be dismissed; the HTML frame swallows its own keys, so HTML keeps it in
 * place, unannounced and not dismissible, while the rendered view is shown.
 */
function FileReadOnlyHint({
  renderedName,
  rawLabel,
  persistent,
  onSwitch,
  onDismiss,
}: {
  readonly renderedName: string;
  readonly rawLabel: RawViewLabelText;
  readonly persistent: boolean;
  readonly onSwitch: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  return (
    <Surface variant="section" boundary="bottom">
      <div
        className="px-3 py-2"
        onKeyDown={(event): void => {
          if (persistent || event.key !== 'Escape') return;
          event.preventDefault();
          onDismiss();
        }}
      >
        <Notice
          intent="neutral"
          role={persistent ? 'none' : 'status'}
          title={`${renderedName} is read-only.`}
          data-testid="file-readonly-hint"
          onDismiss={persistent ? undefined : onDismiss}
          dismissLabel="Dismiss read-only notice"
          dismissTestId="file-readonly-hint-dismiss"
          actions={
            <NoticeButton
              variant="primary"
              data-testid="file-readonly-hint-switch"
              onClick={onSwitch}
            >
              {`Switch to ${rawLabel}`}
            </NoticeButton>
          }
        >
          {`Switch to ${rawLabel} to change the text.`}
        </Notice>
      </div>
    </Surface>
  );
}

/**
 * Explains that a newer version arrived while the buffer has unsaved edits
 * and that Save will combine them. Informational only: Save and Discard stay
 * in the header, and a notice that asks for a choice takes its place.
 */
function FileCombinableChangeNotice({
  session,
  appName,
}: {
  readonly session: FileViewerSession;
  readonly appName?: string;
}): JSX.Element | null {
  const change = session.combinableChange;
  if (
    !session.dirty ||
    !change ||
    session.saveConflict ||
    session.externalChange
  ) {
    return null;
  }
  const attributed = Boolean(appName) && change.source === 'agent-edit';
  return (
    <Surface variant="section" boundary="bottom">
      <div className="px-3 py-2">
        <Notice
          intent="neutral"
          role="status"
          title={
            attributed
              ? `${appName} updated this document while you were editing`
              : 'This document was updated while you were editing'
          }
          data-testid="file-combinable-change-notice"
        >
          {attributed
            ? `Save to combine your updates with ${appName}'s.`
            : 'Save to combine your updates with the newer changes.'}
        </Notice>
      </div>
    </Surface>
  );
}

/** How long a combined-save confirmation stays while the viewer is active. */
const COMBINED_SAVE_NOTICE_MS = 8_000;

const COMBINED_SAVE_TITLE = 'Saved';

/**
 * The combined-save explanation, shared by the visible confirmation and the
 * live-region announcement so their wording cannot drift.
 */
function combinedSaveMessage(
  appName: string | undefined,
  source: FileChangeSource | null,
): string {
  return appName && source === 'agent-edit'
    ? `Your edits and ${appName}'s changes were combined.`
    : 'Your edits and the newer changes were combined.';
}

/** A visible combined-save confirmation and its dismissal. */
interface CombinedSaveConfirmation {
  readonly message: string;
  readonly dismiss: () => void;
}

interface ObservedCombinedSave {
  /** Distinguishes confirmations, including a revision reused after reopen. */
  readonly serial: number;
  readonly key: string;
  readonly revision: number;
  readonly reloadRevision: number;
  readonly bufferRevision: number;
  readonly version: string | null;
  readonly message: string;
}

/**
 * Owns the session's combined-save confirmation above the normal and
 * alternate layouts, so switching layouts neither restarts nor replays it.
 * Only a save observed while mounted shows one; its eight seconds count only
 * while `visible`. Editing, a newer document event, or a new session makes it
 * obsolete for good.
 */
function useCombinedSaveConfirmation(
  key: string,
  session: FileViewerSession | undefined,
  appName: string | undefined,
  visible: boolean,
): CombinedSaveConfirmation | null {
  const revision = session?.savedMerge?.revision ?? 0;
  const source = session?.savedMerge?.source ?? null;
  const reloadRevision = session?.reloadRevision ?? 0;
  const bufferRevision = session?.bufferRevision ?? 0;
  const version = session?.preview?.version ?? null;
  const hasSession = session !== undefined;
  const observedRef = useRef({ key, revision, hasSession });
  const serialRef = useRef(0);
  const budgetRef = useRef({ serial: 0, remainingMs: COMBINED_SAVE_NOTICE_MS });
  const [confirmation, setConfirmation] = useState<ObservedCombinedSave | null>(
    null,
  );

  useEffect(() => {
    const observed = observedRef.current;
    observedRef.current = { key, revision, hasSession };
    if (
      !hasSession ||
      !observed.hasSession ||
      observed.key !== key ||
      revision < observed.revision
    ) {
      // A different file or a replaced session: its history is not news.
      setConfirmation(null);
      return;
    }
    if (revision === observed.revision) return;
    serialRef.current += 1;
    setConfirmation({
      serial: serialRef.current,
      key,
      revision,
      reloadRevision,
      bufferRevision,
      version,
      message: combinedSaveMessage(appName, source),
    });
  }, [
    key,
    revision,
    hasSession,
    reloadRevision,
    bufferRevision,
    version,
    appName,
    source,
  ]);

  const obsolete =
    confirmation !== null &&
    (confirmation.key !== key ||
      session === undefined ||
      session.dirty ||
      Boolean(session.externalChange) ||
      Boolean(session.combinableChange) ||
      Boolean(session.saveConflict) ||
      reloadRevision !== confirmation.reloadRevision ||
      bufferRevision !== confirmation.bufferRevision ||
      version !== confirmation.version ||
      revision !== confirmation.revision);
  const obsoleteSerial = obsolete ? confirmation.serial : null;
  useEffect(() => {
    if (obsoleteSerial === null) return;
    // A newer save observed in the same commit keeps its confirmation.
    setConfirmation((current) =>
      current?.serial === obsoleteSerial ? null : current,
    );
  }, [obsoleteSerial]);

  const shown = obsolete ? null : confirmation;
  const shownSerial = shown?.serial ?? null;
  useEffect(() => {
    if (shownSerial === null || !visible) return;
    if (budgetRef.current.serial !== shownSerial) {
      budgetRef.current = {
        serial: shownSerial,
        remainingMs: COMBINED_SAVE_NOTICE_MS,
      };
    }
    const startedAt = Date.now();
    const timer = setTimeout((): void => {
      setConfirmation((current) =>
        current?.serial === shownSerial ? null : current,
      );
    }, budgetRef.current.remainingMs);
    return (): void => {
      clearTimeout(timer);
      // Pause: keep what is left rather than granting a new budget.
      if (budgetRef.current.serial === shownSerial) {
        budgetRef.current = {
          serial: shownSerial,
          remainingMs: Math.max(
            0,
            budgetRef.current.remainingMs - (Date.now() - startedAt),
          ),
        };
      }
    };
  }, [shownSerial, visible]);

  const dismiss = useCallback((): void => setConfirmation(null), []);
  return shown ? { message: shown.message, dismiss } : null;
}

/**
 * Confirms a save that combined the user's edits with a newer version. The
 * live region announces the save, so this notice stays silent.
 */
function FileCombinedSaveNotice({
  confirmation,
  focusFallbackRef,
}: {
  readonly confirmation: CombinedSaveConfirmation;
  /** Header row that takes focus when dismissal removes the notice. */
  readonly focusFallbackRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const noticeRef = useRef<HTMLDivElement>(null);
  return (
    <Surface variant="section" boundary="bottom">
      <div ref={noticeRef} className="px-3 py-2">
        <Notice
          intent="positive"
          role="none"
          title={COMBINED_SAVE_TITLE}
          data-testid="file-combined-save-notice"
          onDismiss={(): void => {
            if (noticeRef.current?.contains(document.activeElement)) {
              focusSaveOrHeader(focusFallbackRef);
            }
            confirmation.dismiss();
          }}
          dismissLabel="Dismiss saved notice"
          dismissTestId="file-combined-save-notice-dismiss"
        >
          {confirmation.message}
        </Notice>
      </div>
    </Surface>
  );
}

const RELOAD_ANNOUNCEMENT = 'Document updated to the latest version.';
const OVERLAP_RESOLVED_ANNOUNCEMENT = 'Overlapping edits resolved.';

/**
 * Politely announces the outcome that replaced the shown content: a reload,
 * or a save that combined the user's edits with a newer version. Silent on
 * mount, so initial loads and identical reads say nothing; each new revision
 * clears and re-sets the text so repeated outcomes are announced again.
 */
function FileReloadAnnouncement({
  revision,
  mergeRevision,
  mergeMessage,
  overlapRevision,
  active,
}: {
  readonly revision: number;
  readonly mergeRevision: number;
  readonly mergeMessage: string;
  /** Advances when passage choices settle into a mix of both versions. */
  readonly overlapRevision: number;
  readonly active: boolean;
}): JSX.Element {
  const [message, setMessage] = useState('');
  const announcedRef = useRef({ revision, mergeRevision, overlapRevision });
  useEffect(() => {
    const previous = announcedRef.current;
    announcedRef.current = { revision, mergeRevision, overlapRevision };
    const next =
      mergeRevision !== previous.mergeRevision
        ? mergeMessage
        : overlapRevision !== previous.overlapRevision
          ? OVERLAP_RESOLVED_ANNOUNCEMENT
          : revision !== previous.revision
            ? RELOAD_ANNOUNCEMENT
            : null;
    const clear = setTimeout(() => setMessage(''), 0);
    const announce =
      next !== null && active
        ? setTimeout(() => setMessage(next), 100)
        : undefined;
    return (): void => {
      clearTimeout(clear);
      clearTimeout(announce);
    };
  }, [revision, mergeRevision, mergeMessage, overlapRevision, active]);
  return (
    <span
      role="status"
      aria-live="polite"
      className="sr-only"
      data-testid="file-reload-announcement"
    >
      {message}
    </span>
  );
}

/** Desktop's `MAX_TEXT_BYTES_FULL`; the historical banner figure. */
const DEFAULT_PREVIEW_BYTE_BUDGET = 5 * 1024 * 1024;

function formatByteBudget(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * Visible `Formatted | Source` (or `Table | Source` for CSV) choice for a file
 * with a rendered view; the raw segment reads Edit in an editable Cowork file.
 * `value: null` presses neither segment, for a host showing another view
 * (such as Diff) in the content slot.
 */
function FileViewModeSelector({
  value,
  onChange,
  renderedMode = 'preview',
  rawLabel,
}: {
  value: FileViewMode | null;
  onChange: (next: FileViewMode) => void;
  renderedMode?: 'preview' | 'table';
  rawLabel: RawViewLabelText;
}): JSX.Element {
  return (
    <SegmentedControl<FileViewMode>
      label="View"
      semantics="toggle"
      width="content"
      dataTestId="file-view-toggle"
      value={value}
      onChange={onChange}
      options={[
        {
          value: renderedMode,
          label: renderedMode === 'table' ? 'Table' : 'Formatted',
          dataTestId: 'file-view-toggle-formatted',
        },
        {
          value: 'raw',
          label: rawLabel,
          dataTestId: 'file-view-toggle-source',
        },
      ]}
    />
  );
}

function FileImagePreview({
  request,
  resolveImageSrc,
  retryGeneration,
  scrollBinding,
}: {
  request: PortalFileReadPayload;
  resolveImageSrc: NonNullable<FileViewerProps['resolveImageSrc']>;
  retryGeneration: number;
  scrollBinding?: FileContentScrollBinding;
}): JSX.Element {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'unavailable' }
    | { status: 'ready'; src: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void resolveImageSrc(request)
      .then((src) => {
        if (!cancelled) {
          setState(src ? { status: 'ready', src } : { status: 'unavailable' });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'unavailable' });
      });
    return (): void => {
      cancelled = true;
    };
  }, [request, resolveImageSrc, retryGeneration]);

  return (
    <Surface
      ref={scrollBinding?.ref}
      onScroll={scrollBinding?.onScroll}
      data-testid="file-viewer-image-scroll"
      variant="well"
      padding="default"
      replay="block"
      className="flex min-h-0 flex-1 items-center justify-center overflow-auto"
    >
      {state.status === 'loading' ? (
        <LoadingRegion layout="fill" />
      ) : state.status === 'unavailable' ? (
        <span className="text-s fg-secondary">Image unavailable</span>
      ) : (
        <img
          src={state.src}
          alt={request.relativePath.split('/').pop() ?? request.relativePath}
          onLoad={scrollBinding?.onContentLoaded}
          className="max-h-full max-w-full object-contain"
        />
      )}
    </Surface>
  );
}

// shortcut: plays from bounded in-memory bytes, so videos above the 100 MiB video
// budget show the too-large card; stream from a host URL if longer videos matter.
function FileVideoPreview({
  src,
  displayName,
  onRenderFailure,
}: {
  readonly src: string;
  readonly displayName: string;
  readonly onRenderFailure: FileRichDocumentSlot['onRenderFailure'];
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || typeof IntersectionObserver === 'undefined') return;
    // Hosts keep inactive file tabs mounted but hidden; stop their audio.
    const observer = new IntersectionObserver(([entry]) => {
      if (
        entry?.isIntersecting === false &&
        document.pictureInPictureElement !== video
      )
        video.pause();
    });
    observer.observe(video);
    return (): void => observer.disconnect();
  }, []);
  return (
    <Surface
      variant="well"
      padding="default"
      className="flex min-h-0 flex-1 items-center justify-center"
    >
      <video
        ref={videoRef}
        src={src}
        controls
        aria-label={displayName}
        data-testid="file-viewer-video"
        // An unplayable file shows the recovery card; a mid-playback decode
        // error keeps the native player and its own error state.
        onError={(event): void => {
          if (event.currentTarget.readyState === HTMLMediaElement.HAVE_NOTHING)
            onRenderFailure('parse-failed');
        }}
        className="max-h-full max-w-full"
      />
    </Surface>
  );
}

type FileDocumentPreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly bytes: ArrayBuffer }
  /** Video keeps one Blob copy behind an object URL, not the raw bytes too. */
  | { readonly status: 'video'; readonly src: string }
  | { readonly status: 'too-large'; readonly maxBytes: number }
  | { readonly status: 'fetch-failed'; readonly message?: string }
  | { readonly status: 'password-protected' }
  | { readonly status: 'corrupt' }
  | { readonly status: 'parse-failed' };

function FilePreviewMessage({
  title,
  description,
  action,
  actionGap,
  testId,
  errorKind,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly action?: ReactNode;
  readonly actionGap?: 'item';
  readonly testId: string;
  readonly errorKind?: string;
}): JSX.Element {
  const text = (
    <>
      <p className="text-s font-medium fg-primary">{title}</p>
      <p className="text-xs fg-secondary">{description}</p>
    </>
  );
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col items-center justify-center ${actionGap === 'item' ? 'gap-3' : 'gap-2'} p-6 text-center`}
      data-testid={testId}
      data-error-kind={errorKind}
    >
      {actionGap === 'item' ? (
        <Stack gap="inline" align="center">
          {text}
        </Stack>
      ) : (
        text
      )}
      {action}
    </div>
  );
}

interface FileDocumentPreviewProps {
  readonly request: PortalFileReadPayload;
  readonly renderKind: RichDocumentRenderKind | 'image';
  readonly resolveDocumentBytes: NonNullable<
    FileViewerProps['resolveDocumentBytes']
  >;
  readonly renderRichDocument: NonNullable<
    FileViewerProps['renderRichDocument']
  >;
  readonly displayName: string;
  readonly documentRecoveryHint: string;
  readonly headerActions?: ReactNode;
  readonly unsupportedFileAction?: ReactNode;
  /** Gap before a margin-free fallback action. Omitted keeps the legacy layout. */
  readonly unsupportedFileActionGap?: 'item';
  readonly renderPathBreadcrumb?: FileViewerProps['renderPathBreadcrumb'];
  readonly trailingHeaderActions?: ReactNode;
  readonly documentRetryGeneration: number;
  readonly deferMissing: boolean;
}

function FileDocumentPreview({
  request,
  renderKind,
  resolveDocumentBytes,
  renderRichDocument,
  displayName,
  documentRecoveryHint,
  headerActions,
  unsupportedFileAction,
  unsupportedFileActionGap,
  renderPathBreadcrumb,
  trailingHeaderActions,
  documentRetryGeneration,
  deferMissing,
}: FileDocumentPreviewProps): JSX.Element {
  const requestKey = fileViewerKey(request);
  const activeRequestKey = useRef(requestKey);
  activeRequestKey.current = requestKey;
  const [state, setState] = useState<FileDocumentPreviewState>({
    status: 'loading',
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let videoSrc: string | null = null;
    setState({ status: 'loading' });
    void resolveDocumentBytes(request, controller.signal).then(
      (result) => {
        if (!active || controller.signal.aborted) return;
        if (result.status === 'failed') {
          setState({ status: 'fetch-failed', message: result.message });
          return;
        }
        if (result.status === 'ready' && renderKind === 'video') {
          const type =
            fileExtension(request.relativePath) === 'webm'
              ? 'video/webm'
              : 'video/mp4';
          videoSrc = URL.createObjectURL(new Blob([result.bytes], { type }));
          setState({ status: 'video', src: videoSrc });
          return;
        }
        setState(result);
      },
      () => {
        // Cleanup flips `active` and aborts the signal together, so a
        // rejection after teardown (including the resolver's own abort
        // rejection) is silently dropped.
        if (active) setState({ status: 'fetch-failed' });
      },
    );
    return (): void => {
      active = false;
      controller.abort();
      if (videoSrc !== null) URL.revokeObjectURL(videoSrc);
    };
    // `requestKey` canonically identifies the request; raw object identity is
    // intentionally excluded so equivalent host renders do not refetch. The
    // component is keyed by render kind, so `renderKind` never changes here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, resolveDocumentBytes, documentRetryGeneration]);

  const onRenderFailure = useCallback(
    (failure: FileDocumentRenderFailure): void => {
      if (activeRequestKey.current === requestKey)
        setState({ status: failure });
    },
    [requestKey],
  );

  let body: JSX.Element;
  if (
    state.status === 'too-large' ||
    (state.status === 'fetch-failed' && !deferMissing) ||
    state.status === 'password-protected' ||
    state.status === 'corrupt' ||
    state.status === 'parse-failed'
  ) {
    const video = renderKind === 'video';
    const copy =
      state.status === 'too-large'
        ? `${displayName} exceeds the ${formatByteBudget(state.maxBytes)} ${video ? 'video' : 'document'} preview limit.`
        : state.status === 'fetch-failed'
          ? (state.message ?? `${displayName} could not be loaded for preview.`)
          : state.status === 'password-protected'
            ? `${displayName} is password-protected and cannot be previewed.`
            : state.status === 'parse-failed'
              ? video
                ? `${displayName} can't be played in the app.`
                : `${displayName} could not be converted for preview. ${documentRecoveryHint}`
              : `${displayName} is damaged or invalid and cannot be previewed.`;
    body = (
      <FilePreviewMessage
        title={
          video ? 'Video preview unavailable' : 'Document preview unavailable'
        }
        description={copy}
        action={unsupportedFileAction}
        actionGap={unsupportedFileActionGap}
        testId="file-viewer-document-error"
        errorKind={state.status}
      />
    );
  } else {
    body = (
      <div
        className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
        data-testid="file-viewer-document"
      >
        {state.status === 'video' ? (
          <FileVideoPreview
            src={state.src}
            displayName={displayName}
            onRenderFailure={onRenderFailure}
          />
        ) : state.status !== 'ready' ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <LoadingRegion layout="fill" />
          </div>
        ) : (
          renderRichDocument({
            bytes: state.bytes,
            request,
            displayName,
            renderKind,
            onRenderFailure,
          })
        )}
      </div>
    );
  }
  // A host breadcrumb that renders nothing means the host names the file in
  // its own chrome, so the path slot is absent: without this the row survives
  // as a bare bordered strip under the host's own title.
  const pathSlot = renderPathBreadcrumb?.(request.relativePath) ?? null;
  if (
    pathSlot == null &&
    headerActions == null &&
    trailingHeaderActions == null
  )
    return body;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-viewer">
      <Surface variant="section" boundary="bottom">
        <div
          className="flex items-center gap-1 px-3 py-1.5 text-xs"
          data-testid="file-viewer-document-header"
        >
          {pathSlot !== null ? (
            <div className="flex min-w-0 flex-1 items-center overflow-hidden">
              {pathSlot}
            </div>
          ) : renderPathBreadcrumb === undefined ? (
            <span className="min-w-0 flex-1 truncate fg-secondary">
              {displayName}
            </span>
          ) : (
            // Host-owned name: hold the flexible slot open so the actions stay
            // on the trailing edge, exactly where every other header puts them.
            <div className="min-w-0 flex-1" />
          )}
          {headerActions}
          {trailingHeaderActions}
        </div>
      </Surface>
      {body}
    </div>
  );
}

export function FileViewer(props: FileViewerProps): JSX.Element {
  const alternate = props.alternateContent !== undefined;
  const kind = resolveFileRenderKind({ path: props.request.relativePath });
  const key = fileViewerKey(props.request);
  const session = useFileViewerStore((state) => state.files[key]);
  const defaultCanEdit = useFileViewerStore((state) => state.canEdit);
  const saveFile = useFileViewerStore((state) => state.saveFile);
  const discardEdits = useFileViewerStore((state) => state.discardEdits);
  const setViewMode = useFileViewerStore((state) => state.setViewMode);
  const editable =
    session?.preview?.truncated === false &&
    (session.canEdit ?? defaultCanEdit) &&
    props.renderEditor !== undefined;
  const alternateHeaderRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const alternateRawFocusRef = useRef<string | null>(null);
  const focusContext = JSON.stringify([key, editable]);
  const changeViewMode = (next: FileViewMode): void => {
    alternateRawFocusRef.current =
      alternate && next === 'raw' ? focusContext : null;
    setViewMode(key, next);
    props.onViewModeChange?.(next);
  };
  useEffect(() => {
    if (alternateRawFocusRef.current === null) return;
    if (
      alternateRawFocusRef.current !== focusContext ||
      props.active === false
    ) {
      alternateRawFocusRef.current = null;
      return;
    }
    if (alternate) return;
    alternateRawFocusRef.current = null;
    if ((props.viewMode ?? session?.viewMode) !== 'raw') return;
    const header = viewerRef.current?.querySelector<HTMLElement>(
      '[data-testid="file-viewer-header"]',
    );
    if (!header) return;
    const { activeElement: active, body } = header.ownerDocument;
    if (active !== body && active !== null && !header.contains(active)) return;
    header
      ?.querySelector<HTMLButtonElement>(
        '[data-testid="file-view-toggle-source"]',
      )
      ?.focus({ preventScroll: true });
  }, [
    alternate,
    focusContext,
    props.active,
    props.viewMode,
    session?.viewMode,
  ]);
  const handledFocusRequestRef = useRef(0);
  const saveConflict = session?.saveConflict ?? null;
  // A new conflict (or session) starts its own focus requests.
  useEffect(() => {
    if (saveConflict === null) handledFocusRequestRef.current = 0;
  }, [saveConflict]);
  const mergeMessage = `${COMBINED_SAVE_TITLE}. ${combinedSaveMessage(
    props.appName,
    session?.savedMerge?.source ?? null,
  )}`;
  const combinedSave = useCombinedSaveConfirmation(
    key,
    session,
    props.appName,
    props.active !== false,
  );
  // Session replay records the header (path, status, actions); each content
  // body carries its own block. An `alternateContent` host blocks its own
  // content.
  return (
    <div ref={viewerRef} className="flex h-full min-h-0 flex-col">
      {session && (
        <FileReloadAnnouncement
          key={key}
          revision={session.reloadRevision ?? 0}
          mergeRevision={session.savedMerge?.revision ?? 0}
          mergeMessage={mergeMessage}
          overlapRevision={session.overlapResolvedRevision ?? 0}
          active={props.active !== false}
        />
      )}
      <div
        className={alternate ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
        inert={alternate}
      >
        <FileViewerBody
          {...props}
          onChangeViewMode={changeViewMode}
          searchShortcutActive={!alternate && props.searchShortcutActive}
          suppressStatusChrome={alternate}
          handledFocusRequestRef={handledFocusRequestRef}
          combinedSave={combinedSave}
        />
      </div>
      {alternate && (
        <>
          <Surface variant="section" boundary="frame">
            <div
              ref={alternateHeaderRef}
              tabIndex={-1}
              className="flex items-center gap-1 px-3 py-1.5 text-xs outline-none"
              data-testid="file-viewer-header"
            >
              <div className="min-w-0 flex-1 truncate fg-secondary">
                {props.renderPathBreadcrumb?.(props.request.relativePath) ??
                  props.request.relativePath}
                {session?.dirty === true && (
                  <span
                    className="ml-1 fg-warning"
                    data-testid="file-viewer-dirty"
                  >
                    •
                  </span>
                )}
              </div>
              {session && (
                <FileStatusActions
                  session={session}
                  editable={editable}
                  savedContentNotice
                  focusFallbackRef={alternateHeaderRef}
                  onDiscard={() => discardEdits(key)}
                  onSave={() => {
                    void saveFile(key);
                  }}
                />
              )}
              {props.headerActions}
              {session?.preview?.truncated !== true &&
                (kind === 'markdown' ||
                  kind === 'html' ||
                  props.request.relativePath.toLowerCase().endsWith('.csv') ||
                  isNotebookPath(props.request.relativePath)) && (
                  <FileViewModeSelector
                    value={null}
                    renderedMode={
                      props.request.relativePath.toLowerCase().endsWith('.csv')
                        ? 'table'
                        : 'preview'
                    }
                    rawLabel={resolveRawViewLabel(props.rawViewLabel, editable)}
                    onChange={changeViewMode}
                  />
                )}
              {props.trailingHeaderActions}
            </div>
          </Surface>
          {session?.overlap ? (
            <FileOverlapNotice
              session={session}
              overlap={session.overlap}
              onFocusFallback={(): void =>
                focusSaveOrHeader(alternateHeaderRef)
              }
              handledFocusRequestRef={handledFocusRequestRef}
              appName={props.appName}
              onAskToKeepEdits={props.onAskToKeepEdits}
            />
          ) : (
            session &&
            saveConflict && (
              <FileSaveConflictNotice
                session={session}
                conflict={saveConflict}
                focusFallbackRef={alternateHeaderRef}
                handledFocusRequestRef={handledFocusRequestRef}
                appName={props.appName}
              />
            )
          )}
          {session && (
            <FileExternalChangeNotice
              session={session}
              focusFallbackRef={alternateHeaderRef}
              appName={props.appName}
            />
          )}
          {session && (
            <FileCombinableChangeNotice
              session={session}
              appName={props.appName}
            />
          )}
          {combinedSave && (
            <FileCombinedSaveNotice
              confirmation={combinedSave}
              focusFallbackRef={alternateHeaderRef}
            />
          )}
          {props.alternateContent}
        </>
      )}
    </div>
  );
}

/** A reveal target and the identity that distinguishes it from the last. */
interface RevealTarget {
  readonly identity: string;
  readonly line: number;
  readonly lineEnd: number;
}

/** Per-viewer state behind {@link composeReveal}. */
interface RevealComposition {
  fileKey: string | null;
  generation: number;
  /** One sequence for host and comparison reveals, so revisions never collide. */
  sequence: number;
  identity: string | null;
  reveal: FileLineReveal | undefined;
  /** Requests already observed while a comparison owned the reveal. */
  suppressedHosts: Set<string>;
}

/**
 * The comparison's reveal: the first unresolved passage at its current
 * location in the buffer, clamped to the buffer's lines. A zero-length
 * passage (a deletion or insertion anchor) reveals the nearest line.
 */
function overlapRevealTarget(
  overlap: FileOverlapComparison,
  content: string,
): RevealTarget | null {
  const index = firstUnresolvedPassage(overlap);
  const region = index === null ? undefined : overlap.regions[index];
  if (!region) return null;
  const totalLines = Math.max(
    1,
    content.split('\n').length - (content.endsWith('\n') ? 1 : 0),
  );
  const line = Math.min(Math.max(1, region.oursLines.line), totalLines);
  const lineEnd = Math.min(
    Math.max(line, region.oursLines.line + region.oursLines.lineCount - 1),
    totalLines,
  );
  return {
    identity: JSON.stringify([
      'overlap',
      overlap.generation,
      overlap.latest.version,
      region.index,
      line,
      lineEnd,
    ]),
    line,
    lineEnd,
  };
}

/**
 * Compose the host's reveal with the comparison's. The comparison takes
 * priority while it is unresolved (`overlapActive`); a host request seen
 * meanwhile is remembered so clearing the comparison cannot replay it. Every
 * effective reveal takes the next revision in one per-viewer sequence, and
 * an unchanged target keeps its revision so typing never re-centers.
 */
function composeReveal(
  state: RevealComposition,
  fileKey: string,
  generation: number,
  host: FileLineReveal | undefined,
  overlapActive: boolean,
  overlapTarget: RevealTarget | null,
): FileLineReveal | undefined {
  if (state.fileKey !== fileKey || state.generation !== generation) {
    state.fileKey = fileKey;
    state.generation = generation;
    state.identity = null;
    state.reveal = undefined;
    state.suppressedHosts.clear();
  }
  const hostIdentity = host
    ? JSON.stringify(['host', host.line, host.lineEnd, host.revision])
    : null;
  let target: RevealTarget | null = null;
  if (overlapActive) {
    if (hostIdentity !== null) state.suppressedHosts.add(hostIdentity);
    target = overlapTarget;
  } else if (
    host &&
    hostIdentity !== null &&
    !state.suppressedHosts.has(hostIdentity)
  ) {
    target = {
      identity: hostIdentity,
      line: host.line,
      lineEnd: host.lineEnd ?? host.line,
    };
  }
  const identity = target?.identity ?? null;
  if (identity !== state.identity) {
    state.identity = identity;
    if (target === null) {
      state.reveal = undefined;
    } else {
      state.sequence += 1;
      state.reveal = {
        line: target.line,
        lineEnd: target.lineEnd,
        revision: state.sequence,
      };
    }
  }
  return state.reveal;
}

interface FileViewerBodyProps extends FileViewerProps {
  readonly suppressStatusChrome?: boolean;
  readonly onChangeViewMode: (next: FileViewMode) => void;
  readonly handledFocusRequestRef: RefObject<number>;
  readonly combinedSave: CombinedSaveConfirmation | null;
}

function FileViewerBody({
  request,
  requestRenderKind,
  supportedDocumentKinds = ['pdf'],
  renderEditor,
  onOpenRelativePath,
  resolveAssetSrc,
  resolveHtmlAsset,
  resolveImageSrc,
  resolveDocumentBytes,
  renderRichDocument,
  renderImageDocument,
  documentDisplayName,
  documentRecoveryHint = 'Download it to open in its native app.',
  imageRetryGeneration = 0,
  documentRetryGeneration = 0,
  viewMode,
  searchShortcutActive = false,
  previewSearchControl,
  onPreviewSearchControlApplied,
  onPreviewSearchStateChange,
  previewSearchPresentation,
  previewSearchControlled,
  onPreviewSearchRequest,
  onChangeViewMode,
  headerActions,
  renderPathBreadcrumb,
  trailingHeaderActions,
  unsupportedFileAction,
  unsupportedFileActionGap,
  previewByteBudget = DEFAULT_PREVIEW_BYTE_BUDGET,
  deferMissing = false,
  contentScrollBinding,
  revealLine,
  rawViewLabel,
  active = true,
  suppressStatusChrome = false,
  handledFocusRequestRef,
  combinedSave,
  appName,
  onAskToKeepEdits,
  diagramSaveDestination,
}: FileViewerBodyProps): JSX.Element {
  const key = fileViewerKey(request);
  const documentName = request.relativePath.split('/').pop() ?? '';
  const downloadDestination = useMemo(
    (): MermaidSaveDestination => ({
      kind: 'download',
      documentId: key,
      documentName,
    }),
    [key, documentName],
  );
  const headerRowRef = useRef<HTMLDivElement>(null);
  const renderedRegionRef = useRef<HTMLDivElement>(null);
  // The read-only hint belongs to one file, rendered mode, and editability;
  // it shows only while that context is still current (CAN-5004).
  const [hintContext, setHintContext] = useState<string | null>(null);
  // Focus to restore onto the raw segment once the raw view has committed.
  const pendingRawFocusRef = useRef<string | null>(null);
  // The key whose press revealed the hint: its repeats and release must not
  // activate the selector that just took focus.
  const guardedKeyRef = useRef<string | null>(null);
  // Activation must begin with a fresh press after the hint moves focus.
  // Another key (e.g. Space) may already be held when typing reveals it.
  const guardRawActivationRef = useRef(false);
  const revealRequestKey = JSON.stringify([
    key,
    revealLine?.line,
    revealLine?.lineEnd,
    revealLine?.revision,
  ]);
  const [settledRevealRequest, setSettledRevealRequest] = useState<
    string | null
  >(null);
  const revealCompositionRef = useRef<RevealComposition>({
    fileKey: null,
    generation: 0,
    sequence: 0,
    identity: null,
    reveal: undefined,
    suppressedHosts: new Set(),
  });
  const session = useFileViewerStore((state) => state.files[key]);
  const revealReady =
    settledRevealRequest === revealRequestKey &&
    (session?.dirty === true ||
      (session?.status !== 'loading' && session?.status !== 'error'));
  const defaultCanEdit = useFileViewerStore((state) => state.canEdit);

  const openFile = useFileViewerStore((state) => state.openFile);
  const updateContent = useFileViewerStore((state) => state.updateContent);
  const saveFile = useFileViewerStore((state) => state.saveFile);
  const discardEdits = useFileViewerStore((state) => state.discardEdits);

  const requestKind = resolveFileRenderKind({
    path: request.relativePath,
    language: undefined,
  });
  const effectiveRequestKind = requestRenderKind ?? requestKind;
  // Image tabs render straight from the resolved src below and never read the
  // session, so skip the text `file.read` round trip entirely for them.
  const documentRenderer =
    effectiveRequestKind === 'image'
      ? renderImageDocument
      : isRichDocumentRenderKind(effectiveRequestKind) &&
          supportedDocumentKinds.includes(effectiveRequestKind)
        ? renderRichDocument
        : undefined;
  const rendersAsDocument =
    resolveDocumentBytes != null && documentRenderer != null;
  const rendersAsImage =
    effectiveRequestKind === 'image' &&
    !rendersAsDocument &&
    resolveImageSrc != null;

  useEffect(() => {
    if (rendersAsImage || rendersAsDocument) return;
    let current = true;
    // A fresh location request must wait for the opening read, even when a
    // cached preview is already renderable. The store protects dirty buffers.
    void openFile(request).then(() => {
      if (current) setSettledRevealRequest(revealRequestKey);
    });
    return (): void => {
      current = false;
    };
    // The request key includes both the file identity and location revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequestKey, openFile, rendersAsDocument, rendersAsImage]);

  const committedViewMode = session?.preview
    ? (viewMode ?? session.viewMode)
    : null;
  const hintEditable =
    session?.preview?.truncated === false &&
    (session.canEdit ?? defaultCanEdit) &&
    renderEditor !== undefined;
  // Run even while a new file is loading or has no preview. Neither guidance
  // nor delayed focus may survive a visit to a different context.
  useEffect(() => {
    setHintContext(null);
    guardedKeyRef.current = null;
    guardRawActivationRef.current = false;
    if (
      pendingRawFocusRef.current !== key ||
      !hintEditable ||
      !active ||
      suppressStatusChrome ||
      committedViewMode !== 'raw'
    ) {
      pendingRawFocusRef.current = null;
    }
  }, [key, hintEditable, active, committedViewMode, suppressStatusChrome]);

  useEffect(() => {
    if (pendingRawFocusRef.current !== key) return;
    if (committedViewMode !== 'raw') return;
    pendingRawFocusRef.current = null;
    const header = headerRowRef.current;
    if (!header) return;
    const { activeElement: active, body } = header.ownerDocument;
    // Only reclaim focus the removed notice dropped, never another surface's.
    if (active !== null && active !== body && !header.contains(active)) return;
    header
      ?.querySelector<HTMLButtonElement>(
        '[data-testid="file-view-toggle-source"]',
      )
      ?.focus();
  }, [committedViewMode, key]);

  if (rendersAsImage && resolveImageSrc) {
    const imagePreview = (
      <FileImagePreview
        request={request}
        resolveImageSrc={resolveImageSrc}
        retryGeneration={imageRetryGeneration}
        scrollBinding={contentScrollBinding}
      />
    );
    // Image tabs bypass the shared header entirely (they never read a session),
    // which would strand a host action like Download on exactly the files that
    // most need one. Add a minimal header ONLY when the host filled the slot,
    // so every existing image host keeps its chrome-free markup. Nullish, not
    // just `undefined`: hosts spell "no action" as `null` too (desktop passes
    // `diffTarget ? <button/> : null`), and treating that as present would put
    // an empty header row above every ordinary image preview.
    if (
      (headerActions === undefined || headerActions === null) &&
      (trailingHeaderActions === undefined || trailingHeaderActions === null)
    ) {
      return imagePreview;
    }
    // The breadcrumb deliberately stays out of this gate: adding it would put
    // a path row above every desktop image preview that has no host action.
    const imagePathSlot = renderPathBreadcrumb?.(request.relativePath) ?? null;
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="file-viewer">
        <Surface variant="section" boundary="bottom">
          <div
            className="flex items-center gap-1 px-3 py-1.5 text-xs"
            data-testid="file-viewer-image-header"
          >
            {imagePathSlot !== null ? (
              <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                {imagePathSlot}
              </div>
            ) : renderPathBreadcrumb === undefined ? (
              <span className="min-w-0 flex-1 truncate fg-secondary">
                {request.relativePath}
              </span>
            ) : (
              <div className="min-w-0 flex-1" />
            )}
            {headerActions}
            {trailingHeaderActions}
          </div>
        </Surface>
        {imagePreview}
      </div>
    );
  }

  if (
    rendersAsDocument &&
    resolveDocumentBytes &&
    documentRenderer &&
    (effectiveRequestKind === 'image' ||
      isRichDocumentRenderKind(effectiveRequestKind))
  ) {
    return (
      <FileDocumentPreview
        key={`${key}:${effectiveRequestKind}`}
        request={request}
        renderKind={effectiveRequestKind}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={documentRenderer}
        displayName={documentDisplayName ?? request.relativePath}
        documentRecoveryHint={documentRecoveryHint}
        renderPathBreadcrumb={renderPathBreadcrumb}
        trailingHeaderActions={trailingHeaderActions}
        documentRetryGeneration={documentRetryGeneration}
        deferMissing={deferMissing}
        headerActions={headerActions}
        unsupportedFileAction={unsupportedFileAction}
        unsupportedFileActionGap={unsupportedFileActionGap}
      />
    );
  }

  if (!session || (session.status === 'loading' && session.preview === null)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <LoadingRegion layout="fill" />
      </div>
    );
  }

  if (session.status === 'error' && session.preview === null) {
    // TODO(CAN-759): replace with a typed error code on the file session.
    const missing = session.error?.startsWith('File not found:') === true;
    if (missing) {
      if (deferMissing) {
        return (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <LoadingRegion layout="fill" />
          </div>
        );
      }
      return (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
          data-testid="file-viewer-missing"
        >
          <p className="text-s font-medium fg-primary">File does not exist</p>
          <p className="text-xs fg-secondary">
            {request.relativePath} could not be found. It may have been moved,
            renamed, or deleted.
          </p>
        </div>
      );
    }
    if (session.error?.includes('Binary files cannot be read') === true) {
      return (
        <div className="flex h-full min-h-0 flex-col" data-testid="file-viewer">
          <Surface variant="section" boundary="bottom">
            <div className="flex items-center gap-1 px-3 py-1.5 text-xs">
              {renderPathBreadcrumb ? (
                <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                  {renderPathBreadcrumb(request.relativePath)}
                </div>
              ) : (
                <span className="min-w-0 flex-1 truncate fg-secondary">
                  {request.relativePath}
                </span>
              )}
              {headerActions}
              {trailingHeaderActions}
            </div>
          </Surface>
          <FilePreviewMessage
            title="Unsupported file type"
            description={<>{request.relativePath} cannot be previewed.</>}
            action={unsupportedFileAction}
            actionGap={unsupportedFileActionGap}
            testId="file-viewer-unsupported"
          />
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <ErrorState
          space="panel"
          testId="file-error"
          message={session.error ?? "Couldn't read the file."}
        />
      </div>
    );
  }

  const preview = session.preview;
  if (!preview) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <LoadingRegion layout="fill" />
      </div>
    );
  }

  const kind = requestRenderKind ?? resolveFileRenderKind(preview);
  const isCsv = preview.path.toLowerCase().endsWith('.csv');
  // A notebook's rendered view reads the same text session as its JSON
  // source. Complete content is parsed here (once per content, cached) so a
  // file that is not a v4 notebook stays in Source with a notice instead of
  // offering a Formatted view that cannot render. Truncated content is
  // formatted only when the host can load the complete file as bytes.
  const isNotebook = kind === 'code' && isNotebookPath(preview.path);
  const notebookParse =
    isNotebook && !preview.truncated
      ? parseNotebookCached(session.content)
      : null;
  const notebookFormattable =
    isNotebook &&
    (preview.truncated
      ? resolveDocumentBytes !== undefined
      : notebookParse?.status === 'ok');
  const notebookNotice: string | null = !isNotebook
    ? null
    : preview.truncated
      ? notebookFormattable
        ? null
        : // No size: relay hosts do not always report their read limit.
          'This notebook is too large to preview here. Showing the start of its source.'
      : notebookParse?.status === 'failed'
        ? notebookParseFailureNotice(notebookParse.reason)
        : null;
  const showToggle =
    notebookFormattable ||
    (!preview.truncated && (kind === 'markdown' || kind === 'html' || isCsv));
  const requestedViewMode = viewMode ?? session.viewMode;
  // A CSV has no neutral 'preview' rendering and other kinds have no 'table':
  // normalize both directions so a persisted/host mode from before a rename or
  // from a non-CSV default always maps to a rendered body and an active toggle.
  const effectiveViewMode: FileViewMode =
    isCsv && requestedViewMode === 'preview'
      ? 'table'
      : !isCsv && requestedViewMode === 'table'
        ? 'preview'
        : requestedViewMode;
  const inRawMode = !showToggle || effectiveViewMode === 'raw';
  const editable =
    !preview.truncated &&
    (session.canEdit ?? defaultCanEdit) &&
    renderEditor !== undefined;
  const rawLabel = resolveRawViewLabel(rawViewLabel, editable);
  const renderedName =
    isCsv && effectiveViewMode === 'table' ? 'Table view' : 'Formatted view';
  const currentHintContext = JSON.stringify([key, effectiveViewMode, editable]);
  // A change of file, view, or editability retires the hint for good, so it
  // cannot return when an earlier context comes back.
  if (hintContext !== null && hintContext !== currentHintContext) {
    setHintContext(null);
  }
  const rendersPreview =
    (!inRawMode || preview.truncated) &&
    (kind === 'markdown' || kind === 'html');
  const rendersTable = !inRawMode && isCsv && effectiveViewMode === 'table';
  const editableRenderedView = editable && !inRawMode;
  const transientHintVisible =
    editableRenderedView &&
    kind !== 'html' &&
    hintContext === currentHintContext;
  const persistentHtmlHint = editableRenderedView && kind === 'html';

  const rawSegment = (): HTMLButtonElement | null =>
    headerRowRef.current?.querySelector<HTMLButtonElement>(
      '[data-testid="file-view-toggle-source"]',
    ) ?? null;
  const switchToRawFromHint = (): void => {
    pendingRawFocusRef.current = key;
    setHintContext(null);
    onChangeViewMode('raw');
  };
  const dismissHint = (): void => {
    setHintContext(null);
    guardedKeyRef.current = null;
    guardRawActivationRef.current = false;
    renderedRegionRef.current?.focus({ preventScroll: true });
  };
  const onEditAttempt = (pressedKey: string): void => {
    setHintContext(currentHintContext);
    guardedKeyRef.current = pressedKey;
    guardRawActivationRef.current = true;
    rawSegment()?.focus();
  };

  // A comparison reveals its active passage in Edit/Source only; rendered
  // views keep the comparison usable without claiming an editor reveal.
  const overlap = editable ? (session.overlap ?? null) : null;
  const effectiveReveal = composeReveal(
    revealCompositionRef.current,
    key,
    session.generation ?? overlap?.generation ?? 0,
    revealLine,
    overlap !== null,
    overlap !== null && inRawMode
      ? overlapRevealTarget(overlap, session.content)
      : null,
  );
  // Remounted viewers still wait for their opening read before revealing a
  // cached comparison, just as they do for a host navigation request.
  const effectiveRevealReady = revealReady;

  const rawBody: ReactNode =
    // The `renderEditor` re-check is not redundant: `editable` is a boolean, so
    // TS does not narrow the optional `renderEditor` from it — this guard does.
    editable && renderEditor ? (
      renderEditor({
        value: session.content,
        language: preview.language,
        filePath: preview.path,
        dirty: session.dirty,
        onChange: (next): void => updateContent(key, next),
        onSave: (): void => {
          void saveFile(key);
        },
        reveal: effectiveReveal,
        revealReady: effectiveRevealReady,
      })
    ) : (
      <FileReadOnlyCode
        content={session.content}
        scrollBinding={contentScrollBinding}
        reveal={effectiveReveal}
        revealReady={effectiveRevealReady}
        fileIdentity={key}
      />
    );

  let renderedBody: ReactNode = null;
  if (rendersPreview && kind === 'markdown') {
    renderedBody = (
      <FileMarkdownPreview
        content={session.content}
        onOpenRelativePath={onOpenRelativePath}
        resolveAssetSrc={resolveAssetSrc}
        scrollBinding={contentScrollBinding}
        diagramSaveDestination={diagramSaveDestination ?? downloadDestination}
      />
    );
  } else if (rendersPreview && kind === 'html') {
    renderedBody = (
      <FileHtmlPreview
        content={session.content}
        title={preview.path}
        resolveAssetSrc={resolveAssetSrc}
        resolveHtmlAsset={resolveHtmlAsset}
      />
    );
  } else if (rendersTable) {
    renderedBody = (
      <FileCsvPreview
        content={session.content}
        scrollBinding={contentScrollBinding}
      />
    );
  } else if (!inRawMode && notebookFormattable) {
    renderedBody = (
      <FileNotebookPreview
        request={request}
        parsed={notebookParse}
        truncated={preview.truncated}
        version={preview.version}
        resolveDocumentBytes={resolveDocumentBytes}
        documentRetryGeneration={documentRetryGeneration}
        rawBody={rawBody}
        onOpenRelativePath={onOpenRelativePath}
        resolveAssetSrc={resolveAssetSrc}
        scrollBinding={contentScrollBinding}
      />
    );
  }
  // Only a rendered body is wrapped: the raw editor and read-only text stay
  // as they are, whether or not the selector is shown.
  const body: ReactNode =
    renderedBody === null ? (
      rawBody
    ) : (
      <FileRenderedRegion
        ref={renderedRegionRef}
        label={renderedName}
        description={
          editableRenderedView
            ? `Read-only. Switch to ${rawLabel} to change the text.`
            : 'Read-only.'
        }
        // The sandboxed HTML frame keeps its keys, so it shows the hint
        // persistently instead of on a typing attempt.
        onEditAttempt={
          editableRenderedView && kind !== 'html' ? onEditAttempt : undefined
        }
      >
        {renderedBody}
      </FileRenderedRegion>
    );
  // The full notebook replaces the truncated text in the formatted view, so
  // the "first N MB" banner applies only to the source.
  const showTruncationBanner =
    preview.truncated &&
    notebookNotice === null &&
    !(notebookFormattable && !inRawMode);

  // Mirrors the document header: a breadcrumb that renders nothing hands the
  // filename to the host's chrome, so this row keeps only what it owns — and
  // disappears when it owns nothing.
  const pathSlot = renderPathBreadcrumb?.(preview.path) ?? null;
  const pathVisible = renderPathBreadcrumb === undefined || pathSlot !== null;
  const dirtyMarker =
    !suppressStatusChrome && session.dirty ? (
      <span
        className="ml-1 shrink-0 fg-warning"
        data-testid="file-viewer-dirty"
      >
        •
      </span>
    ) : null;
  const showHeaderRow =
    pathVisible ||
    dirtyMarker !== null ||
    (!suppressStatusChrome && fileStatusActionsVisible(session, editable)) ||
    headerActions != null ||
    showToggle ||
    trailingHeaderActions != null;

  return (
    <FilePreviewSearch
      searchShortcutActive={searchShortcutActive}
      key={key}
      resetKey={effectiveViewMode}
      enabled={
        !inRawMode ||
        !editable ||
        (preview.truncated && (kind === 'markdown' || kind === 'html'))
      }
      remote={kind === 'html' && (!inRawMode || preview.truncated)}
      control={previewSearchControl}
      onControlApplied={onPreviewSearchControlApplied}
      onStateChange={onPreviewSearchStateChange}
      presentation={previewSearchPresentation}
      controlled={previewSearchControlled}
      onSearchRequest={onPreviewSearchRequest}
      onViewerKeyDown={(event): void => {
        // Cmd/Ctrl+S anywhere in an editable viewer saves as Save does, and
        // never opens the browser's own Save Page dialog (CAN-6506).
        if (!editable || event.defaultPrevented) return;
        if (!isShortcutEvent(event.nativeEvent, 's')) return;
        event.preventDefault();
        if (session.dirty && session.status !== 'saving') void saveFile(key);
      }}
      header={
        <>
          {showHeaderRow && (
            <Surface variant="section" boundary="bottom">
              <div
                ref={headerRowRef}
                tabIndex={-1}
                className="flex items-center gap-1 px-3 py-1.5 text-xs outline-none"
                data-testid="file-viewer-header"
                onKeyDownCapture={(event): void => {
                  if (!guardRawActivationRef.current) return;
                  if (!keyFromHeaderDom(event)) return;
                  const activation = event.key === 'Enter' || event.key === ' ';
                  if (
                    event.repeat &&
                    (activation || event.key === guardedKeyRef.current)
                  ) {
                    event.preventDefault();
                    return;
                  }
                  if (!event.repeat && activation) {
                    guardRawActivationRef.current = false;
                    guardedKeyRef.current = null;
                  }
                }}
                onKeyUpCapture={(event): void => {
                  if (!keyFromHeaderDom(event)) return;
                  const revealingKey = guardedKeyRef.current === event.key;
                  if (revealingKey) guardedKeyRef.current = null;
                  if (
                    revealingKey ||
                    (guardRawActivationRef.current &&
                      (event.key === 'Enter' || event.key === ' '))
                  ) {
                    event.preventDefault();
                  }
                }}
                onKeyDown={(event): void => {
                  if (
                    event.key === 'Escape' &&
                    transientHintVisible &&
                    event.target === rawSegment()
                  ) {
                    event.preventDefault();
                    dismissHint();
                  }
                }}
              >
                {pathSlot !== null ? (
                  <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                    {pathSlot}
                    {dirtyMarker}
                  </div>
                ) : renderPathBreadcrumb === undefined ? (
                  <span className="min-w-0 flex-1 truncate fg-secondary">
                    {preview.path}
                    {dirtyMarker}
                  </span>
                ) : (
                  // Host-owned name: the dirty dot is still the viewer's, so it
                  // stays anchored to the flexible slot.
                  <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                    {dirtyMarker}
                  </div>
                )}
                {!suppressStatusChrome && (
                  <FileStatusActions
                    session={session}
                    editable={editable}
                    focusFallbackRef={headerRowRef}
                    onDiscard={() => discardEdits(key)}
                    onSave={() => {
                      void saveFile(key);
                    }}
                  />
                )}
                {headerActions}
                {showToggle && (
                  <FileViewModeSelector
                    value={effectiveViewMode}
                    renderedMode={isCsv ? 'table' : 'preview'}
                    rawLabel={rawLabel}
                    onChange={onChangeViewMode}
                  />
                )}
                {trailingHeaderActions}
              </div>
            </Surface>
          )}
          {!suppressStatusChrome &&
            (session.overlap ? (
              <FileOverlapNotice
                session={session}
                overlap={session.overlap}
                onFocusFallback={(): void => focusSaveOrHeader(headerRowRef)}
                handledFocusRequestRef={handledFocusRequestRef}
                appName={appName}
                onAskToKeepEdits={onAskToKeepEdits}
              />
            ) : (
              session.saveConflict && (
                <FileSaveConflictNotice
                  session={session}
                  conflict={session.saveConflict}
                  focusFallbackRef={headerRowRef}
                  handledFocusRequestRef={handledFocusRequestRef}
                  appName={appName}
                />
              )
            ))}
          {!suppressStatusChrome && (
            <FileExternalChangeNotice
              session={session}
              focusFallbackRef={headerRowRef}
              appName={appName}
            />
          )}
          {!suppressStatusChrome && (
            <FileCombinableChangeNotice session={session} appName={appName} />
          )}
          {!suppressStatusChrome && combinedSave && (
            <FileCombinedSaveNotice
              confirmation={combinedSave}
              focusFallbackRef={headerRowRef}
            />
          )}
          {(transientHintVisible || persistentHtmlHint) && (
            <FileReadOnlyHint
              renderedName={renderedName}
              rawLabel={rawLabel}
              persistent={persistentHtmlHint}
              onSwitch={switchToRawFromHint}
              onDismiss={dismissHint}
            />
          )}
          {showTruncationBanner && (
            <Surface variant="section" boundary="bottom">
              <div className="px-3 py-2">
                <Notice
                  intent="attention"
                  role="none"
                >{`File too large to edit. Showing the first ${formatByteBudget(previewByteBudget)}.`}</Notice>
              </div>
            </Surface>
          )}
          {notebookNotice !== null && (
            <Surface
              variant="section"
              boundary="bottom"
              data-testid="file-notebook-notice"
            >
              {preview.truncated ? (
                <div className="px-3 py-2">
                  <Notice intent="attention" role="none">
                    {notebookNotice}
                  </Notice>
                </div>
              ) : (
                <div className="px-4 py-2 text-xs fg-secondary">
                  {notebookNotice}
                </div>
              )}
            </Surface>
          )}
        </>
      }
    >
      {body}
    </FilePreviewSearch>
  );
}
