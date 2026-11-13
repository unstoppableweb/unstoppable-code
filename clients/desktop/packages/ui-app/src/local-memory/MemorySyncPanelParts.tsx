'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  LocalMemoryNotify,
  LocalMemorySyncClient,
  LocalMemorySyncConflict,
  LocalMemorySyncConflictVersion,
  LocalMemorySyncDocument,
  LocalMemorySyncHistoryResult,
  LocalMemorySyncMergePreview,
  LocalMemorySyncProjectMemory,
  LocalMemorySyncRevision,
  LocalMemorySyncState,
} from '@canopy/app-core/local-memory';
import {
  Button,
  CenteredLoadingSpinner,
  ConfirmDialog,
  DelayedLoadingPlaceholder,
  DialogModal,
  EmptyState,
  ErrorBanner,
  ErrorState,
  Heading,
  ListRow,
  LoadingButton,
  Markdown,
  Notice,
  ToggleSwitchField,
} from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { formatRelativeTime } from '@canopy/ui-shared/lib';
import { BackIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  MEMORY_PROJECT_KEEP_LABEL,
  memoryConflictReasonText,
  memoryDocumentTitle,
  memoryMergedEditsLabel,
  memoryProjectMemoryNote,
  memoryRevisionAuthor,
  memoryRevisionLabel,
  memorySyncFailureText,
  memorySyncStatusLine,
} from './memory-sync-copy';

/** Memory sync's state, kept current while mounted; null until it loads. */
export function useMemorySyncState(
  sync: LocalMemorySyncClient | undefined,
): LocalMemorySyncState | null {
  const [state, setState] = useState<LocalMemorySyncState | null>(null);
  useEffect(() => {
    if (sync === undefined) {
      setState(null);
      return undefined;
    }
    let current = true;
    void sync
      .state()
      .then((next) => {
        if (current) setState(next);
      })
      .catch(() => undefined);
    const stop = sync.watch((next) => {
      if (current) setState(next);
    });
    return (): void => {
      current = false;
      stop();
    };
  }, [sync]);
  return state;
}

/**
 * The Memory panel's sync view as its host's assistant context sees it:
 * which view is open and how many conflicts wait, never memory names.
 */
export interface MemorySyncPanelUiState {
  readonly view: 'conflicts' | 'history';
  readonly conflicts: number;
}

/** The user scope is syncing (or tried to): history and conflicts apply. */
export function memorySyncActive(state: LocalMemorySyncState | null): boolean {
  return (
    state?.availability === 'available' &&
    state.settings?.enabled === true &&
    state.user !== null &&
    (state.user.state === 'syncing' || state.user.state === 'repair_needed')
  );
}

export const MEMORY_SYNC_MARKDOWN_CLASS = `flex min-w-0 flex-col gap-2 text-xs fg-primary wrap-anywhere ${REPLAY_BLOCK_CLASS} [&_li]:my-0 [&_ol]:my-0 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-0 [&_pre]:my-0 [&_pre]:overflow-auto [&_ul]:my-0 [&_ul]:list-disc [&_ul]:pl-4`;

/** The line under the search: how sync stands, and edits merged on their own. */
export function MemorySyncStatusRow({
  state,
  prefix,
  onReviewConflicts,
}: {
  readonly state: LocalMemorySyncState | null;
  /** Names the scope when the panel also lists a project's memories. */
  readonly prefix?: string;
  readonly onReviewConflicts: () => void;
}): JSX.Element | null {
  const line = memorySyncStatusLine(state);
  if (line === null) return null;
  const conflicts = state?.user?.conflicts.length ?? 0;
  return (
    <p
      className={`flex shrink-0 flex-wrap items-baseline gap-x-2 px-1 pb-1 text-2xs ${line.tone === 'quiet' ? 'fg-tertiary' : 'fg-warning'}`}
      data-testid="memory-sync-status"
      data-tone={line.tone}
    >
      <span className="min-w-0">
        {prefix === undefined ? line.text : `${prefix}: ${line.text}`}
      </span>
      {conflicts > 0 && (
        <Button
          variant="link"
          onClick={onReviewConflicts}
          data-testid="memory-sync-review-conflicts"
        >
          {memoryMergedEditsLabel(conflicts)}
        </Button>
      )}
    </p>
  );
}

/**
 * A linked project's memories in the Memory panel (design §22): the switch
 * that keeps them on this computer, and the review when this computer holds
 * memories the cloud has not merged yet. The project's own settings decide
 * where its memories live while Private memory is on, so the switch is then
 * read-only and says so.
 */
export function MemoryProjectSyncRow({
  memory,
  saving,
  onChange,
  onReviewMerge,
}: {
  readonly memory: LocalMemorySyncProjectMemory;
  readonly saving: boolean;
  readonly onChange: (keepOnThisComputer: boolean) => void;
  readonly onReviewMerge: () => void;
}): JSX.Element {
  const note = memoryProjectMemoryNote(memory);
  return (
    <div
      className="flex shrink-0 flex-col gap-1 px-1 pb-1"
      data-testid="memory-project-sync"
      data-state={memory.state}
    >
      <ToggleSwitchField
        checked={memory.mode === 'device_only'}
        disabled={!memory.changeable || memory.mode === null || saving}
        caption={MEMORY_PROJECT_KEEP_LABEL}
        onChange={onChange}
        dataTestId="memory-project-keep-toggle"
      />
      {(note !== null || memory.needsFirstEnable) && (
        <p
          className="flex flex-wrap items-baseline gap-x-2 text-pretty text-2xs fg-tertiary"
          data-testid="memory-project-sync-note"
        >
          {note !== null && <span className="min-w-0">{note}</span>}
          {memory.needsFirstEnable && (
            <Button
              variant="link"
              onClick={onReviewMerge}
              data-testid="memory-project-review-merge"
            >
              Review merge
            </Button>
          )}
        </p>
      )}
    </div>
  );
}

function ViewHeader({
  title,
  onBack,
  backLabel,
}: {
  readonly title: string;
  readonly onBack: () => void;
  readonly backLabel: string;
}): JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 px-1">
      <Button
        variant="ghost"
        size="compact"
        iconOnly
        aria-label={backLabel}
        onClick={onBack}
        data-testid="memory-sync-back"
      >
        <BackIcon size="sm" aria-hidden="true" />
      </Button>
      <span className="text-xs fg-tertiary">{title}</span>
    </div>
  );
}

function VersionBlock({
  heading,
  version,
  testId,
}: {
  readonly heading: string;
  readonly version: LocalMemorySyncConflictVersion;
  readonly testId: string;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-1" data-testid={testId}>
      <Heading level={3} variant="label">
        {heading}
      </Heading>
      {version.kind === 'deleted' ? (
        <p className="text-xs fg-tertiary">Deleted.</p>
      ) : version.kind === 'not_text' ? (
        <p className="text-xs fg-tertiary">
          This version isn&apos;t plain text, so it can&apos;t be shown or
          synced. Save it as UTF-8 text to sync it.
        </p>
      ) : (
        <div className={MEMORY_SYNC_MARKDOWN_CLASS}>
          <Markdown>
            {version.text.replace(/^---\n[\s\S]*?\n---\n+/, '')}
          </Markdown>
        </div>
      )}
    </section>
  );
}

/**
 * The merged edits view (design §13.2): memories changed on this computer
 * and another at once. Each resolved itself (every computer uses the version
 * that synced first, and this computer's edit goes to the next consolidation
 * as a note), so nothing here is required: the person may read the kept
 * copy, restore it, or dismiss the entry.
 */
export function MemorySyncConflictsView({
  sync,
  state,
  notify,
  onBack,
}: {
  readonly sync: LocalMemorySyncClient;
  readonly state: LocalMemorySyncState | null;
  readonly notify: LocalMemoryNotify;
  readonly onBack: () => void;
}): JSX.Element {
  const conflicts = state?.user?.conflicts ?? [];
  const [path, setPath] = useState<string | null>(null);
  const [conflict, setConflict] = useState<LocalMemorySyncConflict | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'restore' | 'dismiss' | null>(null);
  const open = path ?? conflicts[0]?.path ?? null;
  const device = state?.deviceLabel ?? null;

  useEffect(() => {
    if (open === null) return undefined;
    let current = true;
    setConflict(null);
    setLoadError(null);
    void sync
      .readConflict(open)
      .then((next) => {
        if (current) setConflict(next);
      })
      .catch(() => {
        if (current) setLoadError("Couldn't open this edit.");
      });
    return (): void => {
      current = false;
    };
  }, [sync, open]);

  const settle = useCallback(
    async (action: 'restore' | 'dismiss'): Promise<void> => {
      if (open === null) return;
      setBusy(action);
      try {
        const result = await sync.settleConflict(open, action);
        if (!result.ok) {
          notify({
            message: memorySyncFailureText(result.code),
            tone: 'error',
          });
          return;
        }
        setPath(null);
        if (action === 'restore') {
          notify({
            message: 'Restored your version. It syncs to your other computers.',
          });
        }
        if (result.state.user?.conflicts.length === 0) onBack();
      } catch {
        notify({ message: memorySyncFailureText('failed'), tone: 'error' });
      } finally {
        setBusy(null);
      }
    },
    [sync, open, notify, onBack],
  );

  return (
    <div
      className="flex min-h-0 flex-auto flex-col"
      data-testid="memory-sync-conflicts"
    >
      <ViewHeader
        title="Merged edits"
        backLabel="Back to memories"
        onBack={onBack}
      />
      <div className="flex min-h-0 flex-auto flex-col gap-4 overflow-y-auto px-3 pb-5 pt-1.5">
        {open === null ? (
          <p
            className="text-xs fg-tertiary"
            data-testid="memory-sync-no-conflicts"
          >
            No edits were merged automatically.
          </p>
        ) : (
          <>
            {conflicts.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {conflicts.map((entry) => (
                  <Button
                    key={entry.path}
                    variant={entry.path === open ? 'secondary' : 'ghost'}
                    size="compact"
                    onClick={() => setPath(entry.path)}
                  >
                    <span className={REPLAY_MASK_CLASS}>
                      {memoryDocumentTitle(entry.path)}
                    </span>
                  </Button>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Heading level={2} variant="title">
                <span className={REPLAY_MASK_CLASS}>
                  {memoryDocumentTitle(open)}
                </span>
              </Heading>
              <p
                className="text-xs fg-secondary"
                data-testid="memory-sync-conflict-merged"
              >
                {device === null ? (
                  'Merged automatically'
                ) : (
                  <>
                    {'Merged automatically from '}
                    <span className={REPLAY_MASK_CLASS}>{device}</span>
                  </>
                )}
                {conflict === null
                  ? ''
                  : ` · ${formatRelativeTime(conflict.detectedAt)}`}
              </p>
              {conflict !== null && (
                <p
                  className="text-xs fg-tertiary"
                  data-testid="memory-sync-conflict-reason"
                  data-reason={conflict.reason}
                >
                  {memoryConflictReasonText(conflict)}
                </p>
              )}
            </div>
            {loadError !== null ? (
              <ErrorState space="panel" message={loadError} />
            ) : conflict === null ? (
              <DelayedLoadingPlaceholder slowNote="Still opening…">
                <CenteredLoadingSpinner />
              </DelayedLoadingPlaceholder>
            ) : (
              <>
                <VersionBlock
                  heading="In use on your computers"
                  version={conflict.cloud}
                  testId="memory-sync-conflict-cloud"
                />
                <VersionBlock
                  heading="Your version, kept on this computer"
                  version={conflict.mine}
                  testId="memory-sync-conflict-mine"
                />
                <div className="flex flex-wrap gap-2">
                  <LoadingButton
                    variant="secondary"
                    size="sm"
                    loading={busy === 'restore'}
                    loadingLabel="Restoring…"
                    disabled={busy !== null}
                    onClick={() => void settle('restore')}
                    data-testid="memory-sync-restore-mine"
                  >
                    Restore my version
                  </LoadingButton>
                  <LoadingButton
                    variant="ghost"
                    size="sm"
                    loading={busy === 'dismiss'}
                    loadingLabel="Dismissing…"
                    disabled={busy !== null}
                    onClick={() => void settle('dismiss')}
                    data-testid="memory-sync-dismiss-conflict"
                  >
                    Dismiss
                  </LoadingButton>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Sync history (design §14.1): every version of these memories the cloud
 * keeps, newest first, with what changed and where; any earlier version can
 * come back as a new one.
 */
export function MemorySyncHistoryView({
  sync,
  notify,
  onBack,
}: {
  readonly sync: LocalMemorySyncClient;
  readonly notify: LocalMemoryNotify;
  readonly onBack: () => void;
}): JSX.Element {
  const [page, setPage] = useState<LocalMemorySyncHistoryResult | null>(null);
  const [revisions, setRevisions] = useState<LocalMemorySyncRevision[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restoring, setRestoring] = useState<LocalMemorySyncRevision | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    setPage(null);
    void sync
      .history(null)
      .then((next) => {
        if (!current) return;
        setPage(next);
        setRevisions(next.ok ? [...next.revisions] : []);
      })
      .catch(() => {
        if (current) setPage({ ok: false, code: 'offline' });
      });
    return (): void => {
      current = false;
    };
  }, [sync, version]);

  const loadMore = async (): Promise<void> => {
    if (page === null || !page.ok || page.nextBefore === null) return;
    setLoadingMore(true);
    try {
      const next = await sync.history(page.nextBefore);
      setPage(next);
      if (next.ok) setRevisions((known) => [...known, ...next.revisions]);
    } catch {
      notify({ message: memorySyncFailureText('offline'), tone: 'error' });
    } finally {
      setLoadingMore(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (restoring === null) return;
    setBusy(true);
    setRestoreError(null);
    try {
      const result = await sync.restore(restoring.revision);
      if (!result.ok) {
        setRestoreError(memorySyncFailureText(result.code));
        return;
      }
      setRestoring(null);
      notify({ message: `Restored version ${restoring.revision}.` });
      setVersion((value) => value + 1);
    } catch {
      setRestoreError(memorySyncFailureText('failed'));
    } finally {
      setBusy(false);
    }
  };

  const current = page?.ok === true ? page.currentRevision : null;
  return (
    <div
      className="flex min-h-0 flex-auto flex-col"
      data-testid="memory-sync-history"
    >
      <ViewHeader
        title="Sync history"
        backLabel="Back to memories"
        onBack={onBack}
      />
      <div className="min-h-0 flex-auto overflow-y-auto px-1 pb-5 pt-1.5">
        {page === null ? (
          <DelayedLoadingPlaceholder slowNote="Still loading history…">
            <CenteredLoadingSpinner />
          </DelayedLoadingPlaceholder>
        ) : !page.ok ? (
          <ErrorState
            space="panel"
            message={memorySyncFailureText(page.code)}
            onRetry={() => setVersion((value) => value + 1)}
          />
        ) : revisions.length === 0 ? (
          <EmptyState
            tone="quiet"
            title="A version is kept each time your memories change."
          />
        ) : (
          <ul data-testid="memory-sync-revisions">
            {revisions.map((revision) => (
              <li
                key={revision.revision}
                className="flex items-center gap-3 px-2.5 py-2"
                data-testid="memory-sync-revision"
                data-revision={revision.revision}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs fg-primary">
                    {memoryRevisionLabel(revision)}
                    <span className="fg-tertiary">
                      {' · '}
                      <span
                        className={
                          memoryRevisionAuthor(revision).personal
                            ? REPLAY_MASK_CLASS
                            : undefined
                        }
                      >
                        {memoryRevisionAuthor(revision).text}
                      </span>
                    </span>
                  </p>
                  <p className="text-2xs fg-tertiary">
                    {`Version ${revision.revision} · ${formatRelativeTime(revision.committedAt)}`}
                  </p>
                </div>
                {revision.revision === current ? (
                  <span className="text-2xs fg-tertiary">Current</span>
                ) : (
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => {
                      setRestoreError(null);
                      setRestoring(revision);
                    }}
                    data-testid="memory-sync-restore"
                  >
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {page?.ok === true && page.nextBefore !== null && (
          <div className="px-2.5 pt-2">
            <LoadingButton
              variant="ghost"
              size="compact"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              Show older versions
            </LoadingButton>
          </div>
        )}
      </div>
      {restoring !== null && (
        <ConfirmDialog
          title={`Restore version ${restoring.revision}?`}
          message="Your memories go back to this version on every computer. The current version stays in history, so you can restore it later."
          confirmLabel="Restore version"
          busyLabel="Restoring…"
          busy={busy}
          errorMessage={restoreError}
          onConfirm={() => void restore()}
          onCancel={() => setRestoring(null)}
          dataTestId="memory-sync-restore-dialog"
          confirmTestId="memory-sync-restore-confirm"
        />
      )}
    </div>
  );
}

function countLabel(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * What the review says about memories too large to sync as they are: their
 * content still goes up, as notes a later consolidation folds in, so the
 * sentence says where they went rather than asking for anything.
 */
function tooLargeSentence(count: number): string {
  return count === 1
    ? '1 memory is too large to sync as it is, so it goes to the cloud as notes. The next consolidation folds it in.'
    : `${count} memories are too large to sync as they are, so they go to the cloud as notes. The next consolidation folds them in.`;
}

/**
 * The first-enable review as its host's assistant context sees it: its
 * progress and counts, never memory names or contents.
 */
export interface MemorySyncReviewUiState {
  readonly phase: 'loading' | 'ready' | 'applying' | 'failed';
  readonly kind: 'upload' | 'merge' | 'keep' | null;
  /** Loaded again because memories changed while it was open. */
  readonly reloadedAfterChange: boolean;
  /** The last failure, as a code. */
  readonly failure: string | null;
  readonly documentsAfter: number;
  readonly notesSent: number;
  readonly notesKeptOnDevice: number;
  readonly memoriesSkipped: number;
}

/*
 * What the first-enable review calls itself, by what it does. `keep` merges
 * nothing, so it names the one thing it changes: this computer starts
 * syncing with the memories the other computers already share.
 */
const REVIEW_TITLE: Readonly<
  Record<LocalMemorySyncMergePreview['kind'], string>
> = {
  upload: "Upload this computer's memories",
  merge: "Merge this computer's memories",
  keep: 'Start syncing memories',
};

const APPLY_LABEL: Readonly<
  Record<LocalMemorySyncMergePreview['kind'], string>
> = {
  upload: 'Upload and sync',
  merge: 'Merge and sync',
  keep: 'Start syncing',
};

const APPLYING_LABEL: Readonly<
  Record<LocalMemorySyncMergePreview['kind'], string>
> = { upload: 'Uploading…', merge: 'Merging…', keep: 'Starting…' };

const APPLIED_MESSAGE: Readonly<
  Record<LocalMemorySyncMergePreview['kind'], string>
> = {
  upload:
    'Memories uploaded. Your other computers get them next time they sync.',
  merge: 'Memories merged. Every computer now uses the same memories.',
  keep: 'Syncing started. This computer now uses the same memories as your other computers.',
};

/**
 * What an apply that left memories behind says instead: syncing started, but
 * those memories stay here, so it never reads as a plain success. Both the
 * memories the cloud refused and the ones this computer could not send
 * count. The status line explains why each stayed.
 */
function appliedMessage(
  kind: LocalMemorySyncMergePreview['kind'],
  keptHere: number,
): string {
  if (keptHere === 0) return APPLIED_MESSAGE[kind];
  return keptHere === 1
    ? "Syncing started, but 1 memory couldn't be synced. It's kept on this computer."
    : `Syncing started, but ${keptHere} memories couldn't be synced. They're kept on this computer.`;
}

function DocumentList({
  heading,
  documents,
  selected,
  onSelect,
  testId,
}: {
  readonly heading: string;
  readonly documents: readonly LocalMemorySyncDocument[];
  readonly selected?: string | null;
  readonly onSelect?: (path: string) => void;
  readonly testId: string;
}): JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <div className="px-2">
        <Heading level={3} variant="label">
          {heading}
        </Heading>
      </div>
      {documents.length === 0 ? (
        <p className="px-2 text-xs fg-tertiary">None.</p>
      ) : (
        <ul>
          {documents.map((document) => (
            <li key={document.path}>
              {onSelect === undefined ? (
                <p className="truncate px-2 py-1 text-xs fg-secondary">
                  <span className={REPLAY_MASK_CLASS}>
                    {memoryDocumentTitle(document.path)}
                  </span>
                </p>
              ) : (
                <ListRow
                  selected={selected === document.path}
                  aria-current={selected === document.path ? 'true' : undefined}
                  onClick={() => onSelect(document.path)}
                >
                  <span className={REPLAY_MASK_CLASS}>
                    {memoryDocumentTitle(document.path)}
                  </span>
                </ListRow>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The first-enable review (design §17): what the cloud holds, what this
 * computer holds, and the memories merging them leaves, before anything is
 * sent. Merging keeps the version before it in history. A `keep` review has
 * nothing of this computer's to merge, so it only starts syncing.
 */
export function MemorySyncMergeReview({
  sync,
  notify,
  workspaceId,
  onClose,
  onStateChange,
}: {
  readonly sync: LocalMemorySyncClient;
  readonly notify: LocalMemoryNotify;
  /**
   * Reviews the cloud project this workspace is linked to; omitted, it
   * reviews the memories saved for every project (design §22).
   */
  readonly workspaceId?: string;
  readonly onClose: () => void;
  readonly onStateChange: (state: MemorySyncReviewUiState) => void;
}): JSX.Element {
  const [preview, setPreview] = useState<LocalMemorySyncMergePreview | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [changedNotice, setChangedNotice] = useState(false);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const error = failure === null ? null : memorySyncFailureText(failure);

  // Another try already finished it: nothing is left to review.
  const finishedElsewhere = useCallback((): void => {
    notify({ message: 'Your memories are already syncing.' });
    onClose();
  }, [notify, onClose]);

  const load = useCallback((): void => {
    setFailure(null);
    setPreview(null);
    void sync
      .previewMerge(workspaceId)
      .then((result) => {
        if (result.ok) {
          setPreview(result.preview);
          setSelected(result.preview.result[0]?.path ?? null);
        } else if (result.code === 'already_applied') finishedElsewhere();
        else setFailure(result.code);
      })
      .catch(() => setFailure('offline'));
  }, [sync, workspaceId, finishedElsewhere]);
  useEffect(() => {
    load();
  }, [load]);

  const phase: MemorySyncReviewUiState['phase'] = applying
    ? 'applying'
    : preview !== null
      ? 'ready'
      : failure !== null
        ? 'failed'
        : 'loading';
  useEffect(() => {
    onStateChange({
      phase,
      kind: preview?.kind ?? null,
      reloadedAfterChange: changedNotice,
      failure,
      documentsAfter: preview?.result.length ?? 0,
      notesSent: preview?.deviceNotes ?? 0,
      notesKeptOnDevice: preview?.keptOnDevice ?? 0,
      memoriesSkipped: preview?.skipped ?? 0,
    });
  }, [phase, preview, changedNotice, failure, onStateChange]);

  const apply = async (): Promise<void> => {
    if (preview === null) return;
    setApplying(true);
    setFailure(null);
    try {
      const result = await sync.applyMerge(preview.previewId, workspaceId);
      if (!result.ok) {
        if (result.code === 'changed') {
          setChangedNotice(true);
          load();
          return;
        }
        if (result.code === 'already_applied') {
          finishedElsewhere();
          return;
        }
        setFailure(result.code);
        return;
      }
      notify({
        message: appliedMessage(
          preview.kind,
          (result.refusedNotes ?? 0) + preview.skipped,
        ),
      });
      onClose();
    } catch {
      setFailure('offline');
    } finally {
      setApplying(false);
    }
  };

  const shown =
    preview?.result.find((document) => document.path === selected) ?? null;
  return (
    <DialogModal
      onClose={() => {
        if (!applying) onClose();
      }}
      title={REVIEW_TITLE[preview?.kind ?? 'merge']}
      maxWidth="3xl"
      dataTestId="memory-sync-merge-dialog"
      closeButtonDisabled={applying}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={applying}
            onClick={onClose}
            data-testid="memory-sync-merge-cancel"
          >
            Not now
          </Button>
          <LoadingButton
            variant="primary"
            size="sm"
            loading={applying}
            loadingLabel={APPLYING_LABEL[preview?.kind ?? 'merge']}
            disabled={preview === null || applying}
            onClick={() => void apply()}
            data-testid="memory-sync-merge-apply"
          >
            {APPLY_LABEL[preview?.kind ?? 'merge']}
          </LoadingButton>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {error !== null && <ErrorBanner error={error} />}
        {changedNotice && error === null && (
          <Notice
            intent="neutral"
            title="Memories changed while you were reviewing"
            data-testid="memory-sync-merge-changed"
          >
            Check the updated review before you sync.
          </Notice>
        )}
        {preview === null ? (
          error === null && (
            <DelayedLoadingPlaceholder slowNote="Still merging your memories. This can take a few minutes.">
              <CenteredLoadingSpinner />
            </DelayedLoadingPlaceholder>
          )
        ) : (
          <div
            className="flex flex-col gap-4"
            data-testid="memory-sync-merge-review"
            data-kind={preview.kind}
          >
            <p className="text-xs fg-secondary">
              {preview.kind === 'upload' &&
                `Your other computers have no synced memories yet, so this computer's memories go to the cloud as they are${preview.deviceNotes > 0 ? `, with ${countLabel(preview.deviceNotes, 'note', 'notes')} waiting to be consolidated` : ''}.`}
              {preview.kind === 'merge' &&
                'Your memories from this computer and your other computers become one set. The version from before the merge stays in history, so you can restore it.'}
              {preview.kind === 'keep' &&
                "There's nothing from this computer to merge, so the memories your other computers share stay as they are. This computer starts using them."}
              {preview.keptOnDevice > 0 &&
                ` ${countLabel(preview.keptOnDevice, 'note stays', 'notes stay')} on this computer only, kept out by your organization or refused by the cloud.`}
              {preview.skipped - preview.skippedNotText > 0 &&
                ` ${countLabel(preview.skipped - preview.skippedNotText, 'memory stays', 'memories stay')} on this computer because it can't be sent.`}
              {preview.tooLargeAsNotes > 0 &&
                ` ${tooLargeSentence(preview.tooLargeAsNotes)}`}
              {preview.skippedNotText > 0 &&
                ` ${countLabel(preview.skippedNotText, "memory isn't", "memories aren't")} plain text, so ${preview.skippedNotText === 1 ? 'it stays' : 'they stay'} on this computer. Save ${preview.skippedNotText === 1 ? 'it' : 'them'} as UTF-8 text to sync ${preview.skippedNotText === 1 ? 'it' : 'them'}.`}
            </p>
            <div className="grid gap-6 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
              <div className="flex flex-col gap-4">
                {preview.kind !== 'upload' && (
                  <DocumentList
                    heading="Before, on your other computers"
                    documents={preview.cloud}
                    testId="memory-sync-merge-cloud"
                  />
                )}
                <DocumentList
                  heading="Before, on this computer"
                  documents={preview.device}
                  testId="memory-sync-merge-device"
                />
                <DocumentList
                  heading="After"
                  documents={preview.result}
                  selected={selected}
                  onSelect={setSelected}
                  testId="memory-sync-merge-result"
                />
              </div>
              <section
                className="min-w-0"
                data-testid="memory-sync-merge-detail"
              >
                {shown === null ? (
                  <p className="text-xs fg-tertiary">
                    Choose a memory to see it after the merge.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Heading level={3} variant="title">
                      <span className={REPLAY_MASK_CLASS}>
                        {memoryDocumentTitle(shown.path)}
                      </span>
                    </Heading>
                    <div className={MEMORY_SYNC_MARKDOWN_CLASS}>
                      <Markdown>{shown.content}</Markdown>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </div>
        )}
      </div>
    </DialogModal>
  );
}
