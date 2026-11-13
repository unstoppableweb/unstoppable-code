'use client';

import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { Stack, Fact, FactList, Heading } from '@canopy/ui-shared/components';
import type {
  LocalMemoryChatRef,
  LocalMemoryClient,
  LocalMemoryFile,
  LocalMemoryFileDocument,
  LocalMemoryNotify,
  LocalMemoryScope,
  LocalMemoryStatus,
} from '@canopy/app-core/local-memory';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  DelayedLoadingPlaceholder,
  FormField,
  ErrorBanner,
  ErrorState,
  Markdown,
  Skeleton,
  TextArea,
  TextInput,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import { markdownOptions } from '@canopy/ui-shared/components/Markdown';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { formatRelativeTime } from '@canopy/ui-shared/lib';
import {
  BackIcon,
  HistoryIcon,
  ListFilterIcon,
  PencilIcon,
  RefreshIcon,
  RerunIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  MEMORY_KIND_LABELS,
  defaultFilters,
  groupByDay,
  hiddenFilterCount,
  memoryContent,
  memoryEntries,
  memoryScopeKey,
  rowTime,
  savedTime,
  visibleEntries,
  type MemoryContent,
  type MemoryEntry,
  type MemoryFilters,
  type MemoryKind,
  type MemoryPanelScope,
} from './memory-model';
import {
  SAMPLE_MEMORY_ENTRIES,
  SAMPLE_MEMORY_PARAGRAPHS,
} from './memory-samples';
import {
  MemoryFilterMenu,
  MemoryMoreMenu,
  MemoryRow,
  MemorySearchField,
  editorKeyDown,
  rowMenuItems,
} from './memory-panel-parts';
import { memorySyncFailureText } from './memory-sync-copy';
import { consolidationProblem, rebuildProblem } from './memory-status-copy';
import {
  MemoryProjectSyncRow,
  MemorySyncConflictsView,
  MemorySyncHistoryView,
  MemorySyncMergeReview,
  MemorySyncStatusRow,
  memorySyncActive,
  useMemorySyncState,
  type MemorySyncPanelUiState,
} from './MemorySyncPanelParts';

export interface MemoryPanelProps {
  readonly client: LocalMemoryClient;
  readonly notify: LocalMemoryNotify;
  /**
   * The scopes listed together, user scope first. Refresh, consolidation and
   * rebuild act on the last one: the project in the side panel, the user
   * scope in Settings.
   */
  readonly scopes: readonly MemoryPanelScope[];
  /** Adds "Memory settings" to the panel menu. */
  readonly showSettingsLink?: boolean;
  readonly hideWhenEmpty?: boolean;
  readonly onEmptyChange?: (empty: boolean) => void;
  /** The sync view open in the panel, for the host's assistant context. */
  readonly onSyncViewChange?: (view: MemorySyncPanelUiState | null) => void;
}

/**
 * How long a deleted memory can come back with Undo. The file is deleted when
 * this runs out, or at once when the panel closes.
 */
export const MEMORY_UNDO_WINDOW_MS = 15_000;

const DOCUMENT_ERROR = "Couldn't open this memory.";
// A host from before whole-memory edits returns no markdown and has no
// update channel; its memories can be read but not edited here.
const LEGACY_HOST_EDIT =
  'Update the app on the computer that holds this memory to edit it.';
function MemoryImage({ alt }: ComponentProps<'img'>): JSX.Element | null {
  return alt ? <span>{alt}</span> : null;
}

/** The memory file a relative link in `fileKey` points at, if any. */
function linkedFileKey(fileKey: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return null;
  try {
    const resolved = new URL(href, `https://memory.local/${fileKey}`);
    return decodeURIComponent(resolved.pathname.slice(1));
  } catch {
    return null;
  }
}

type View =
  | { readonly kind: 'list' }
  /** Memory sync: memories two computers changed at once. */
  | { readonly kind: 'conflicts' }
  /** Memory sync: the versions the cloud keeps. */
  | { readonly kind: 'history' }
  | {
      readonly kind: 'detail';
      readonly id: string;
      readonly editing: boolean;
      /** The memory being edited, kept if its file disappears meanwhile. */
      readonly entry?: MemoryEntry;
    };

interface DocumentState {
  readonly id: string;
  readonly document: LocalMemoryFileDocument | null;
  readonly error: string | null;
}

interface PendingDelete {
  readonly entry: MemoryEntry;
  readonly revision: string;
  // The client and scope the delete was queued with, so a later client or
  // scope change neither sends it early nor sends it somewhere else.
  readonly client: LocalMemoryClient;
  readonly scope: LocalMemoryScope;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** "Consolidate now", where the host can consolidate. */
function ConsolidateNowButton({
  available,
  disabled,
  onClick,
}: {
  readonly available: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): JSX.Element | null {
  if (!available) return null;
  return (
    <Button
      variant="link"
      onClick={onClick}
      disabled={disabled}
      data-testid="memory-consolidate"
    >
      Consolidate now
    </Button>
  );
}

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : '';
}

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

function conflict(failure: unknown): boolean {
  return /conflict|changed|revision/i.test(errorText(failure));
}

function tooLargeToSync(failure: unknown): boolean {
  return /too large to sync/i.test(errorText(failure));
}

const noop = (): void => undefined;

/** A day's memories: its label, then one row per memory. */
function MemoryDaySection({
  group,
  children,
}: {
  readonly group: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section aria-label={group}>
      <Heading
        level={3}
        variant="label"
        className="mx-2.5 mb-0.5 mt-3 first:mt-1"
      >
        {group}
      </Heading>
      <ul>{children}</ul>
    </section>
  );
}

/** A memory's body, as its Markdown renders. */
function MemoryBody({
  testId,
  children,
}: {
  readonly testId?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`mb-4 min-w-0 text-xs fg-primary wrap-anywhere ${REPLAY_BLOCK_CLASS} [&_li]:my-0 [&_ol]:my-0 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-0 [&_p+p]:mt-2 [&_pre]:my-1 [&_pre]:overflow-auto [&_ul]:my-0 [&_ul]:list-disc [&_ul]:pl-4`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function MemoryPanel({
  client,
  notify,
  scopes,
  showSettingsLink = false,
  hideWhenEmpty = false,
  onEmptyChange,
  onSyncViewChange,
}: MemoryPanelProps): JSX.Element {
  // Each scope's files under the scope's key, so a scope added or removed
  // leaves every other scope's rows, ids and filter choice as they were.
  const [lists, setLists] = useState<
    ReadonlyMap<string, readonly LocalMemoryFile[]>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [filterChoice, setFilterChoice] = useState<{
    readonly kinds: ReadonlySet<MemoryKind>;
    readonly hiddenScopes: ReadonlySet<string>;
  }>(() => ({ kinds: defaultFilters(0).kinds, hiddenScopes: new Set() }));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<View>({ kind: 'list' });
  const [documentState, setDocumentState] = useState<DocumentState | null>(
    null,
  );
  const [chats, setChats] = useState<ReadonlyMap<string, LocalMemoryChatRef>>(
    new Map(),
  );
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState<LocalMemoryStatus | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMessage, setRebuildMessage] = useState<{
    text: string;
    lastRunAt: string | null;
  } | null>(null);
  const [savingProjectMemory, setSavingProjectMemory] = useState(false);
  const [reviewingProject, setReviewingProject] = useState(false);
  const closeProjectReview = useCallback(() => setReviewingProject(false), []);
  const ignoreProjectReviewState = useCallback(() => undefined, []);
  const pending = useRef(new Map<string, PendingDelete>());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const backRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<string | null>(null);
  const active = useRef(true);
  // Changes whenever the panel opens or leaves a memory, so a read that
  // finishes late never replaces another memory's view or draft.
  const navigation = useRef(0);
  const scopeKey = scopes.map(({ scope }) => memoryScopeKey(scope)).join('|');
  // Scopes arrive as a fresh array each render; the key holds them steady.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by scopeKey
  const stableScopes = useMemo(() => scopes, [scopeKey]);
  const scopeKeys = useMemo(
    () => stableScopes.map(({ scope }) => memoryScopeKey(scope)),
    [stableScopes],
  );
  const filters = useMemo<MemoryFilters>(
    () => ({
      kinds: filterChoice.kinds,
      scopes: new Set(
        scopeKeys.flatMap((key, index) =>
          filterChoice.hiddenScopes.has(key) ? [] : [index],
        ),
      ),
    }),
    [filterChoice, scopeKeys],
  );
  const setFilters = useCallback(
    (next: MemoryFilters): void =>
      setFilterChoice({
        kinds: next.kinds,
        hiddenScopes: new Set(
          scopeKeys.filter((_key, index) => !next.scopes.has(index)),
        ),
      }),
    [scopeKeys],
  );
  const maintenance = stableScopes[stableScopes.length - 1]?.scope;
  const now = new Date();
  // Memory sync covers the memories saved for every project (the user
  // scope) and each project linked to a cloud project, so a panel that
  // lists either one reads sync's state.
  const listsUserScope = stableScopes.some(
    ({ scope }) => scope.scope === 'user',
  );
  const listedWorkspaceId = stableScopes.find(
    ({ scope }) => scope.scope === 'workspace',
  )?.scope;
  const workspaceId =
    listedWorkspaceId?.scope === 'workspace'
      ? listedWorkspaceId.workspaceId
      : undefined;
  const allState = useMemorySyncState(
    listsUserScope || workspaceId !== undefined ? client.sync : undefined,
  );
  // The user scope's line, history and conflicts belong to a panel that
  // lists it: a project with Private memory on lists only its own.
  const syncState = listsUserScope ? allState : null;
  const projectMemory =
    workspaceId === undefined
      ? undefined
      : allState?.projects.find((memory) => memory.workspaceId === workspaceId);
  const userScopeLabel = stableScopes.find(
    ({ scope }) => scope.scope === 'user',
  )?.label;

  /**
   * Keeps this project's memories on this computer, or syncs them again.
   * The host reads the project's link again and refuses when it no longer
   * syncs, which the notice explains; the next broadcast carries the new
   * switch either way.
   */
  async function setProjectMemory(keepOnThisComputer: boolean): Promise<void> {
    const sync = client.sync;
    if (sync?.setProjectMemory === undefined || workspaceId === undefined) {
      return;
    }
    setSavingProjectMemory(true);
    try {
      const result = await sync.setProjectMemory(
        workspaceId,
        keepOnThisComputer,
      );
      if (!result.ok) {
        notify({
          message: memorySyncFailureText(result.code),
          tone: 'error',
        });
      }
    } catch {
      notify({ message: memorySyncFailureText('offline'), tone: 'error' });
    } finally {
      setSavingProjectMemory(false);
    }
  }

  useEffect(() => {
    active.current = true;
    return (): void => {
      active.current = false;
    };
  }, []);

  // Mirrors refreshVersion so a finished delete can name the list it waits for.
  const version = useRef(0);
  // A finished delete's id and the refresh whose list no longer has the file.
  const finishedDeletes = useRef(new Map<string, number>());
  // Deletes the store refused, so a late Undo can say so.
  const failedDeletes = useRef(new Set<string>());
  // The latest notifier, for deletes that finish after the panel closed.
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);
  const refresh = useCallback((): void => {
    version.current += 1;
    setRefreshVersion(version.current);
  }, []);

  useEffect(() => {
    let current = true;
    void Promise.all(
      stableScopes.map(
        async ({ scope }): Promise<[string, readonly LocalMemoryFile[]]> => [
          memoryScopeKey(scope),
          await client.list(scope),
        ],
      ),
    )
      .then((next) => {
        if (!current) return;
        setLists(new Map(next));
        setListError(null);
        setLoading(false);
        // A deleted row stays hidden until a list fetched after its delete
        // arrives, so it never flashes back; after that a memory saved again
        // under the same name shows as usual.
        const settled = [...finishedDeletes.current]
          .filter(([, after]) => refreshVersion >= after)
          .map(([id]) => id);
        if (settled.length > 0) {
          for (const id of settled) finishedDeletes.current.delete(id);
          setHidden((currentHidden) => settled.reduce(without, currentHidden));
        }
      })
      .catch(() => {
        if (!current) return;
        setListError("Couldn't load memories. Try again.");
        setLoading(false);
      });
    return (): void => {
      current = false;
    };
  }, [client, stableScopes, refreshVersion]);

  useEffect(() => {
    const stops = stableScopes.map(({ scope }) => client.watch(scope, refresh));
    return (): void => {
      for (const stop of stops) stop();
    };
  }, [client, stableScopes, refresh]);

  useEffect(() => {
    if (!maintenance) return;
    let current = true;
    void client
      .status(maintenance)
      .then((next) => {
        if (current) setStatus(next);
      })
      .catch(() => undefined);
    return (): void => {
      current = false;
    };
  }, [client, maintenance, refreshVersion]);

  // A scope that is gone has no rows, even before the next list arrives.
  const entries = useMemo(
    () =>
      memoryEntries(
        scopeKeys.map((key) => lists.get(key) ?? []),
        scopeKeys,
      ),
    [lists, scopeKeys],
  );
  const chatIds = useMemo(
    () =>
      Array.from(
        new Set(
          entries.flatMap((entry) =>
            entry.file.source ? [entry.file.source.chatId] : [],
          ),
        ),
      ).sort(),
    [entries],
  );
  const chatKey = chatIds.join('\n');
  // Bumped when the host's chat list changes, so a chat missed the first time
  // is looked up again; the list's Refresh does the same.
  const [chatVersion, setChatVersion] = useState(0);
  useEffect(
    () => client.watchChats(() => setChatVersion((value) => value + 1)),
    [client],
  );
  useEffect(() => {
    if (chatIds.length === 0) return;
    let current = true;
    void client
      .lookupChats(chatIds)
      .then((found) => {
        if (current) setChats(found);
      })
      .catch(() => undefined);
    return (): void => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by chatKey
  }, [client, chatKey, chatVersion, refreshVersion]);

  const shown = entries.filter((entry) => !hidden.has(entry.id));
  // An open editor keeps the panel up even if its file was the last one.
  const empty =
    !loading &&
    listError === null &&
    shown.length === 0 &&
    !(view.kind === 'detail' && view.editing);
  useEffect(() => {
    if (!loading) onEmptyChange?.(empty);
  }, [empty, loading, onEmptyChange]);
  const syncView =
    view.kind === 'conflicts' || view.kind === 'history' ? view.kind : null;
  const syncConflicts = syncState?.user?.conflicts.length ?? 0;
  useEffect(() => {
    onSyncViewChange?.(
      syncView === null ? null : { view: syncView, conflicts: syncConflicts },
    );
  }, [syncView, syncConflicts, onSyncViewChange]);
  useEffect(
    () => (): void => {
      onSyncViewChange?.(null);
    },
    [onSyncViewChange],
  );

  // A deletion still waiting for Undo happens now when the panel closes or
  // the window unloads: quitting or reloading skips React's cleanup.
  useEffect(() => {
    const flush = (): void => {
      for (const {
        entry,
        revision,
        timer,
        client,
        scope,
      } of pending.current.values()) {
        clearTimeout(timer);
        void client
          .deleteFile(scope, {
            fileKey: entry.file.fileKey,
            revision,
          })
          .catch(() => {
            failedDeletes.current.add(entry.id);
            notifyRef.current({
              message: `Couldn't delete “${entry.title}”.`,
              tone: 'error',
            });
          });
      }
      pending.current.clear();
    };
    window.addEventListener('pagehide', flush);
    return (): void => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const listedEntry =
    view.kind === 'detail'
      ? entries.find((entry) => entry.id === view.id)
      : undefined;
  const openEntry =
    listedEntry ?? (view.kind === 'detail' ? view.entry : undefined);
  // The file under an open editor went away (deleted or archived elsewhere).
  const removedWhileEditing =
    view.kind === 'detail' && view.editing && !loading && !listedEntry;

  const readDocument = useCallback(
    async (entry: MemoryEntry): Promise<LocalMemoryFileDocument> =>
      client.read(stableScopes[entry.scopeIndex].scope, entry.file.fileKey),
    [client, stableScopes],
  );

  // The open memory's document, read again whenever the list refreshes.
  const openId = openEntry?.id;
  const openModifiedAt = openEntry?.file.modifiedAt;
  const editing = view.kind === 'detail' && view.editing;
  useEffect(() => {
    if (!openEntry || editing) return;
    let current = true;
    void readDocument(openEntry).then(
      (document) => {
        if (current)
          setDocumentState({ id: openEntry.id, document, error: null });
      },
      () => {
        if (current)
          setDocumentState({
            id: openEntry.id,
            document: null,
            error: DOCUMENT_ERROR,
          });
      },
    );
    return (): void => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id and time
  }, [openId, openModifiedAt, editing, readDocument]);

  useEffect(() => {
    if (view.kind === 'detail') {
      backRef.current?.focus({ preventScroll: true });
      return;
    }
    const id = returnFocus.current;
    returnFocus.current = null;
    if (id) rowRefs.current.get(id)?.focus({ preventScroll: true });
  }, [view.kind]);

  // A memory deleted elsewhere closes its detail view, unless it's being
  // edited: then the draft stays until the user cancels.
  useEffect(() => {
    if (view.kind === 'detail' && !loading && !openEntry)
      setView({ kind: 'list' });
  }, [view, loading, openEntry]);

  const document =
    documentState && documentState.id === openId ? documentState : null;
  // Links between memory files open that memory; web links open the way
  // other content links do; anything else stays plain text.
  const markdown = useMemo(() => {
    if (!openEntry) return null;
    const from = openEntry;
    return markdownOptions({
      img: MemoryImage,
      a: function MemoryLink({
        href,
        children,
      }: ComponentProps<'a'>): JSX.Element {
        const target = href ? linkedFileKey(from.file.fileKey, href) : null;
        const linked = target
          ? entries.find(
              (entry) =>
                entry.scopeIndex === from.scopeIndex &&
                entry.file.fileKey === target,
            )
          : undefined;
        const web = href !== undefined && /^https?:\/\//i.test(href);
        if (!linked && !web) return <span>{children}</span>;
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (linked) openDetail(linked);
              else if (href) client.openLink(href);
            }}
          >
            {children}
          </a>
        );
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openDetail is stable in effect
  }, [openEntry, entries, client]);
  const content: MemoryContent | null = document?.document
    ? memoryContent(document.document)
    : null;

  function openDetail(entry: MemoryEntry, edit = false): void {
    navigation.current += 1;
    returnFocus.current = entry.id;
    setSaveError(null);
    setView({ kind: 'detail', id: entry.id, editing: false });
    if (edit) void startEditing(entry);
  }

  function closeDetail(): void {
    navigation.current += 1;
    setView({ kind: 'list' });
    setSaveError(null);
  }

  async function startEditing(entry: MemoryEntry): Promise<void> {
    // Each edit request supersedes the last, even for the same memory, so an
    // older read never replaces a draft the user has started typing.
    navigation.current += 1;
    const opened = navigation.current;
    try {
      const loaded =
        document?.document && document.id === entry.id
          ? document.document
          : await readDocument(entry);
      if (!active.current || navigation.current !== opened) return;
      setDocumentState({ id: entry.id, document: loaded, error: null });
      if (loaded.markdown === undefined) {
        notify({ message: LEGACY_HOST_EDIT, tone: 'error' });
        return;
      }
      const next = memoryContent(loaded);
      setDraftTitle(next.title ?? '');
      setDraftBody(next.body);
      setSaveError(null);
      setView({ kind: 'detail', id: entry.id, editing: true, entry });
    } catch {
      if (navigation.current !== opened) return;
      notify({ message: DOCUMENT_ERROR, tone: 'error' });
    }
  }

  async function save(): Promise<void> {
    if (!openEntry || !document?.document || saving || removedWhileEditing)
      return;
    const titled = content?.title !== undefined;
    if (titled && !draftTitle.trim()) return;
    if (!titled && !draftBody.trim()) return;
    // Saving what was already there leaves the file exactly as it was.
    if (
      draftBody === content?.body &&
      (!titled || draftTitle === content.title)
    ) {
      setView({ kind: 'detail', id: openEntry.id, editing: false });
      return;
    }
    const saved = openEntry;
    const opened = navigation.current;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await client.updateFile(
        stableScopes[openEntry.scopeIndex].scope,
        {
          fileKey: openEntry.file.fileKey,
          revision: document.document.revision,
          ...(titled ? { title: draftTitle } : {}),
          body: draftBody,
        },
      );
      if (!active.current) return;
      // A save that finishes after the user moved on leaves their view alone.
      if (navigation.current === opened) {
        setDocumentState({ id: saved.id, document: updated, error: null });
        setView({ kind: 'detail', id: saved.id, editing: false });
      }
      notify({ message: 'Memory saved', tone: 'success' });
      refresh();
    } catch (failure) {
      if (!active.current) return;
      if (navigation.current !== opened) {
        notify({ message: `Couldn't save “${saved.title}”.`, tone: 'error' });
        return;
      }
      setSaveError(
        tooLargeToSync(failure)
          ? "Couldn't save this memory because it's too large to sync. Your draft is kept; shorten it and try again."
          : conflict(failure)
            ? "Couldn't save because this memory changed. Your draft is kept; cancel and try again."
            : "Couldn't save this memory. Your draft is kept; try again.",
      );
    } finally {
      if (active.current) setSaving(false);
    }
  }

  function commitDelete(id: string): void {
    const waiting = pending.current.get(id);
    if (!waiting) return;
    pending.current.delete(id);
    clearTimeout(waiting.timer);
    void waiting.client
      .deleteFile(waiting.scope, {
        fileKey: waiting.entry.file.fileKey,
        revision: waiting.revision,
      })
      .then(
        () => {
          if (!active.current) return;
          // The row stays hidden until the list fetched by this refresh
          // arrives without it.
          refresh();
          finishedDeletes.current.set(id, version.current);
        },
        (failure: unknown) => {
          failedDeletes.current.add(id);
          // Reported even after the panel closed: the memory is still there.
          if (active.current) setHidden((current) => without(current, id));
          notifyRef.current({
            tone: 'error',
            message: conflict(failure)
              ? `Couldn't delete “${waiting.entry.title}” because it changed.`
              : `Couldn't delete “${waiting.entry.title}”.`,
          });
        },
      );
  }

  // Deliberate deviation from DESIGN.md's detail action bar rule ("Delete
  // still confirms in a dialog") for the Memory panel's detail view and row
  // menu, as in the approved design: delete hides the memory at once and
  // offers Undo for MEMORY_UNDO_WINDOW_MS. Nothing is removed until that
  // window ends or the panel closes, so Undo always restores it.
  async function deleteEntry(entry: MemoryEntry): Promise<void> {
    let revision: string;
    try {
      revision =
        document?.document && document.id === entry.id
          ? document.document.revision
          : (await readDocument(entry)).revision;
    } catch {
      notify({ message: `Couldn't delete “${entry.title}”.`, tone: 'error' });
      return;
    }
    if (!active.current) return;
    if (view.kind === 'detail' && view.id === entry.id) {
      returnFocus.current = null;
      setView({ kind: 'list' });
    }
    setHidden((current) => new Set(current).add(entry.id));
    pending.current.set(entry.id, {
      entry,
      revision,
      client,
      scope: stableScopes[entry.scopeIndex].scope,
      timer: setTimeout(() => commitDelete(entry.id), MEMORY_UNDO_WINDOW_MS),
    });
    notify({
      message: `Deleted “${entry.title}”`,
      action: {
        label: 'Undo',
        run: () => {
          const waiting = pending.current.get(entry.id);
          if (!waiting) {
            notifyRef.current({
              message: failedDeletes.current.has(entry.id)
                ? `“${entry.title}” wasn't deleted, so there's nothing to undo.`
                : `“${entry.title}” was already deleted.`,
              tone: 'error',
            });
            return;
          }
          clearTimeout(waiting.timer);
          pending.current.delete(entry.id);
          if (!active.current) return;
          setHidden((current) => without(current, entry.id));
        },
      },
    });
  }

  async function copyEntry(entry: MemoryEntry): Promise<void> {
    try {
      const loaded = memoryContent(await readDocument(entry));
      await navigator.clipboard.writeText(
        loaded.title ? `${loaded.title}\n\n${loaded.body}` : loaded.body,
      );
      notify({ message: 'Copied', tone: 'success' });
    } catch {
      notify({ message: "Couldn't copy this memory.", tone: 'error' });
    }
  }

  async function consolidateNow(): Promise<void> {
    if (!maintenance || consolidating || client.consolidate === undefined)
      return;
    setConsolidating(true);
    setRebuildMessage(null);
    try {
      const next = await client.consolidate(maintenance);
      if (active.current) setStatus(next);
    } catch (failure) {
      if (active.current)
        setStatus((current) =>
          current
            ? {
                ...current,
                running: false,
                lastResult: 'failed',
                lastReason: errorText(failure) || 'failed',
              }
            : current,
        );
    } finally {
      if (active.current) setConsolidating(false);
      refresh();
    }
  }

  async function rebuildNow(): Promise<void> {
    setConfirmingRebuild(false);
    if (!maintenance || rebuilding || client.rebuild === undefined) return;
    setRebuilding(true);
    setRebuildMessage(null);
    try {
      const response = await client.rebuild(maintenance);
      if (active.current) {
        setStatus(response.status);
        const text = rebuildProblem(response.rebuild);
        setRebuildMessage(
          text === null ? null : { text, lastRunAt: response.status.lastRunAt },
        );
      }
    } catch (failure) {
      if (active.current)
        setRebuildMessage({
          text:
            rebuildProblem({
              status: 'failed',
              reason: errorText(failure) || undefined,
            }) ?? '',
          lastRunAt: status?.lastRunAt ?? null,
        });
    } finally {
      if (active.current) setRebuilding(false);
      refresh();
    }
  }

  const running = consolidating || rebuilding || status?.running === true;
  const panelMenu: ActionMenuItem[] = [
    {
      key: 'refresh',
      label: 'Refresh',
      icon: <RefreshIcon size="sm" />,
      onSelect: refresh,
    },
    ...(client.rebuild === undefined
      ? []
      : [
          {
            key: 'rebuild',
            label: 'Rebuild memories…',
            icon: <RerunIcon size="sm" />,
            disabled: running || editing,
            onSelect: () => setConfirmingRebuild(true),
          },
        ]),
    ...(client.sync !== undefined && memorySyncActive(syncState)
      ? [
          {
            key: 'sync-history',
            label: 'Sync history',
            icon: <HistoryIcon size="sm" />,
            disabled: editing,
            onSelect: () => setView({ kind: 'history' }),
          },
        ]
      : []),
    ...(showSettingsLink
      ? [
          {
            key: 'settings',
            label: 'Memory settings',
            icon: <SettingsIcon size="sm" />,
            separatorBefore: true,
            onSelect: () => client.openSettings(),
          },
        ]
      : []),
  ];

  function renderStatus(): JSX.Element | null {
    if (!status) return null;
    const rebuildRunning = rebuilding || status.rebuilding;
    const currentRebuildMessage =
      rebuildMessage !== null && rebuildMessage.lastRunAt === status.lastRunAt
        ? rebuildMessage.text
        : null;
    const problem = running
      ? null
      : (currentRebuildMessage ?? consolidationProblem(status));
    const waiting = status.pendingNotes;
    if (!running && problem === null && waiting === 0) return null;
    const message = running
      ? rebuildRunning
        ? 'Rebuilding memories…'
        : 'Consolidating…'
      : (problem ??
        `${waiting} ${waiting === 1 ? 'note' : 'notes'} waiting to be consolidated${
          status.lastConsolidatedAt
            ? ` · Consolidated ${formatRelativeTime(status.lastConsolidatedAt)}`
            : ''
        }`);
    return (
      <p
        className={`flex shrink-0 flex-wrap items-baseline gap-x-2 px-1 text-2xs ${problem === null ? 'fg-tertiary' : 'fg-destructive'}`}
        data-testid="memory-consolidation-status"
        data-state={
          running ? 'running' : problem !== null ? 'problem' : 'pending'
        }
      >
        <span className="min-w-0">{message}</span>
        <ConsolidateNowButton
          available={client.consolidate !== undefined}
          disabled={running || editing}
          onClick={() => {
            void consolidateNow();
          }}
        />
      </p>
    );
  }

  function rowMeta(entry: MemoryEntry): string {
    const parts: string[] = [];
    if (entry.file.source)
      parts.push(chats.get(entry.file.source.chatId)?.title ?? 'Chat');
    parts.push(scopes[entry.scopeIndex].label);
    if (entry.file.kind !== 'topic')
      parts.push(MEMORY_KIND_LABELS[entry.file.kind]);
    return parts.join(' · ');
  }

  function renderList(): JSX.Element {
    if (loading)
      return (
        <DelayedLoadingPlaceholder slowNote="Still loading memories…">
          <Skeleton
            loading
            label="Loading memories"
            testId="memory-list-loading"
          >
            <MemoryDaySection group="Today">
              {SAMPLE_MEMORY_ENTRIES.map((entry) => (
                <MemoryRow
                  key={entry.id}
                  entry={entry}
                  scope="user"
                  meta="Topic"
                  time="12:00"
                  onOpen={noop}
                  menu={null}
                />
              ))}
            </MemoryDaySection>
          </Skeleton>
        </DelayedLoadingPlaceholder>
      );
    if (listError)
      return (
        <ErrorState
          space="panel"
          testId="memory-list-error"
          message={listError}
          onRetry={refresh}
        />
      );
    if (shown.length === 0)
      return (
        <p
          className="px-4 py-6 text-center text-xs fg-tertiary"
          data-testid="memory-empty"
        >
          Ask in a chat to remember something about you or your projects. Saved
          memories will appear here.
        </p>
      );
    const visible = visibleEntries(entries, filters, query, hidden);
    if (visible.length === 0) {
      const searching = query.trim() !== '';
      return (
        <EmptyState
          testId={searching ? 'memory-empty-search' : 'memory-empty-filters'}
          icon={
            searching ? (
              <SearchIcon size="xl" aria-hidden="true" />
            ) : (
              <ListFilterIcon size="xl" aria-hidden="true" />
            )
          }
          // The search text stays out of the title: it isn't covered by
          // the privacy marker on the memory rows.
          title={
            searching
              ? 'No memories match your search.'
              : 'No memories match these filters.'
          }
          tone="quiet"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                searching
                  ? setQuery('')
                  : setFilters(defaultFilters(stableScopes.length))
              }
            >
              {searching ? 'Clear search' : 'Clear filters'}
            </Button>
          }
        />
      );
    }
    return (
      <div data-testid="memory-items">
        {groupByDay(visible, now).map(({ group, entries: rows }) => (
          <MemoryDaySection key={group} group={group}>
            {rows.map((entry) => (
              <MemoryRow
                key={entry.id}
                ref={(element) => {
                  if (element) rowRefs.current.set(entry.id, element);
                  else rowRefs.current.delete(entry.id);
                }}
                entry={entry}
                scope={stableScopes[entry.scopeIndex].scope.scope}
                meta={rowMeta(entry)}
                time={rowTime(entry.file.modifiedAt, now)}
                onOpen={() => openDetail(entry)}
                menu={
                  <MemoryMoreMenu
                    size="row"
                    // A fixed name: session replay records labels as
                    // text, and titles can be the memory itself.
                    label="More actions"
                    testId="memory-row-menu"
                    items={rowMenuItems({
                      onEdit: () => openDetail(entry, true),
                      onCopy: () => {
                        void copyEntry(entry);
                      },
                      ...(entry.file.kind === 'index'
                        ? {}
                        : {
                            onDelete: (): void => {
                              void deleteEntry(entry);
                            },
                          }),
                    })}
                  />
                }
              />
            ))}
          </MemoryDaySection>
        ))}
      </div>
    );
  }

  function renderFacts(entry: MemoryEntry): JSX.Element {
    const source = entry.file.source;
    const chat = source ? chats.get(source.chatId) : undefined;
    return (
      <FactList
        labelWidth="6rem"
        columnGap="3"
        rowGap="2"
        dataTestId="memory-detail-facts"
      >
        {source && (
          <>
            <Fact label="Source">
              {chat ? (
                <Button
                  variant="link"
                  className="max-w-full"
                  data-testid="memory-detail-source"
                  onClick={() => {
                    void client.openChat(source.chatId).then((result) => {
                      if (!result.ok)
                        notify({ message: result.message, tone: 'error' });
                    });
                  }}
                >
                  <span className="block truncate">
                    Chat ·{' '}
                    <span className={REPLAY_MASK_CLASS}>{chat.title}</span>
                  </span>
                </Button>
              ) : (
                <span data-testid="memory-detail-source">Chat</span>
              )}
            </Fact>
          </>
        )}
        <Fact label="Saved for">
          <span className={REPLAY_MASK_CLASS}>
            {scopes[entry.scopeIndex].savedFor}
          </span>
        </Fact>
        <Fact label="Kind">{MEMORY_KIND_LABELS[entry.file.kind]}</Fact>
        {entry.file.deviceLabel !== undefined && (
          <Fact label="Saved on" dataTestId="memory-detail-device">
            <span className={REPLAY_MASK_CLASS}>{entry.file.deviceLabel}</span>
          </Fact>
        )}
        <Fact label="Saved">{savedTime(entry.file.modifiedAt, now)}</Fact>
        {entry.file.usageCount !== undefined && (
          <>
            <Fact label="Used" dataTestId="memory-detail-usage">
              {entry.file.usageCount === 0
                ? 'Not used yet'
                : entry.file.usageCount === 1
                  ? '1 time'
                  : `${entry.file.usageCount} times`}
            </Fact>
          </>
        )}
      </FactList>
    );
  }

  function renderEditor(entry: MemoryEntry): JSX.Element {
    const titled = content?.title !== undefined;
    const titleMissing = titled && !draftTitle.trim();
    const bodyMissing = !titled && !draftBody.trim();
    const cancel = (): void => {
      if (saving) return;
      setSaveError(null);
      setView({ kind: 'detail', id: entry.id, editing: false });
    };
    const onKeyDown = (event: Parameters<typeof editorKeyDown>[0]): void =>
      editorKeyDown(event, () => void save(), cancel);
    return (
      <div className="flex flex-col" data-testid="memory-item-editor">
        {titled && (
          <div className="mb-3.5">
            <FormField
              id="memory-edit-title"
              label="Title"
              error={titleMissing ? 'Add a title.' : undefined}
            >
              {(control) => (
                <TextInput
                  {...control}
                  autoFocus
                  value={draftTitle}
                  disabled={saving}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onKeyDown={onKeyDown}
                  data-testid="memory-item-title"
                />
              )}
            </FormField>
          </div>
        )}
        <FormField id="memory-edit-body" label="Memory">
          {(control) => (
            <TextArea
              {...control}
              autoFocus={!titled}
              rows={Math.min(14, Math.max(5, draftBody.split('\n').length + 1))}
              value={draftBody}
              disabled={saving}
              onChange={(event) => setDraftBody(event.target.value)}
              onKeyDown={onKeyDown}
              data-testid="memory-item-draft"
            />
          )}
        </FormField>
        {removedWhileEditing ? (
          <ErrorBanner
            className="mt-2"
            testId="memory-item-removed"
            error="This memory was removed, so it can't be saved. Copy your draft before you cancel."
          />
        ) : (
          <ErrorBanner className="mt-2" error={saveError} />
        )}
        <div className="mt-3.5 flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={cancel}
            disabled={saving}
            data-testid="memory-item-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={
              saving || titleMissing || bodyMissing || removedWhileEditing
            }
            data-testid="memory-item-save"
          >
            {saving ? 'Saving…' : 'Save'}
            <span aria-hidden="true" className="ml-1.5 opacity-70">
              {isMac() ? '⌘↵' : 'Ctrl+↵'}
            </span>
          </Button>
        </div>
      </div>
    );
  }

  function renderDetail(entry: MemoryEntry): JSX.Element {
    return (
      <div
        className="flex min-h-0 flex-auto flex-col"
        data-testid="memory-detail"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !editing) {
            event.preventDefault();
            closeDetail();
          }
        }}
      >
        <div className="flex h-9 shrink-0 items-center gap-1 px-1">
          <Button
            ref={backRef}
            variant="ghost"
            size="compact"
            iconOnly
            aria-label="Back to memories"
            onClick={closeDetail}
            data-testid="memory-detail-back"
          >
            <BackIcon size="sm" aria-hidden="true" />
          </Button>
          <span className="text-xs fg-tertiary">Memory</span>
        </div>
        <div className="min-h-0 flex-auto overflow-y-auto px-3 pb-5 pt-1.5">
          {editing ? (
            renderEditor(entry)
          ) : (
            <>
              <Heading
                level={2}
                variant="title"
                className="mb-2"
                data-testid="memory-detail-title"
              >
                <span className={REPLAY_MASK_CLASS}>
                  {content?.title || entry.title}
                </span>
              </Heading>
              {document?.error ? (
                <ErrorBanner error={document.error} />
              ) : content ? (
                content.body && (
                  <MemoryBody testId="memory-detail-body">
                    <Markdown options={markdown ?? undefined}>
                      {content.body}
                    </Markdown>
                  </MemoryBody>
                )
              ) : (
                <DelayedLoadingPlaceholder slowNote="Still opening…">
                  <Skeleton
                    loading
                    label="Opening memory"
                    testId="memory-detail-loading"
                  >
                    <MemoryBody>
                      {SAMPLE_MEMORY_PARAGRAPHS.map((paragraph) => (
                        <p key={paragraph}>{paragraph}</p>
                      ))}
                    </MemoryBody>
                  </Skeleton>
                </DelayedLoadingPlaceholder>
              )}
              <Stack gap="group">
                {renderFacts(entry)}
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      !content || document?.document?.markdown === undefined
                    }
                    onClick={() => void startEditing(entry)}
                    data-testid="memory-detail-edit"
                  >
                    <PencilIcon size="sm" aria-hidden="true" />
                    Edit
                  </Button>
                  {entry.file.kind !== 'index' && (
                    <Button
                      variant="ghost-destructive"
                      size="sm"
                      disabled={!content}
                      onClick={() => void deleteEntry(entry)}
                      data-testid="memory-detail-delete"
                    >
                      <TrashIcon size="sm" aria-hidden="true" />
                      Delete
                    </Button>
                  )}
                </div>
              </Stack>
            </>
          )}
        </div>
      </div>
    );
  }

  if (hideWhenEmpty && empty) return <></>;

  const scopeLabels = scopes.map(({ label }) => label);
  return (
    <div
      className="relative flex min-h-0 flex-auto flex-col"
      data-testid={`memory-explorer-${maintenance?.scope ?? 'user'}`}
    >
      {view.kind === 'conflicts' && client.sync !== undefined ? (
        <MemorySyncConflictsView
          sync={client.sync}
          state={syncState}
          notify={notify}
          onBack={() => setView({ kind: 'list' })}
        />
      ) : view.kind === 'history' && client.sync !== undefined ? (
        <MemorySyncHistoryView
          sync={client.sync}
          notify={notify}
          onBack={() => setView({ kind: 'list' })}
        />
      ) : openEntry ? (
        renderDetail(openEntry)
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 px-0.5 pb-1.5 pt-0.5">
            <MemorySearchField
              query={query}
              onQueryChange={setQuery}
              filters={filters}
              hiddenFilters={hiddenFilterCount(filters, stableScopes.length)}
              filterMenu={(anchorRef, open, setOpen) => (
                <MemoryFilterMenu
                  anchorRef={anchorRef}
                  open={open}
                  onOpenChange={setOpen}
                  filters={filters}
                  onChange={setFilters}
                  scopeLabels={scopeLabels}
                />
              )}
            />
            <MemoryMoreMenu
              label="Memory actions"
              testId="memory-panel-menu"
              items={panelMenu}
            />
          </div>
          <MemorySyncStatusRow
            state={syncState}
            {...(stableScopes.length > 1 && userScopeLabel !== undefined
              ? { prefix: userScopeLabel }
              : {})}
            onReviewConflicts={() => setView({ kind: 'conflicts' })}
          />
          {projectMemory !== undefined && client.sync !== undefined && (
            <MemoryProjectSyncRow
              memory={projectMemory}
              saving={savingProjectMemory}
              onChange={(keepOnThisComputer) =>
                void setProjectMemory(keepOnThisComputer)
              }
              onReviewMerge={() => setReviewingProject(true)}
            />
          )}
          {renderStatus()}
          <div className="min-h-0 flex-auto overflow-y-auto overflow-x-hidden pb-3">
            {renderList()}
          </div>
        </>
      )}
      {reviewingProject &&
        workspaceId !== undefined &&
        client.sync !== undefined && (
          <MemorySyncMergeReview
            sync={client.sync}
            notify={notify}
            workspaceId={workspaceId}
            onClose={closeProjectReview}
            onStateChange={ignoreProjectReviewState}
          />
        )}
      {confirmingRebuild && (
        <ConfirmDialog
          title="Rebuild memories?"
          message={
            <>
              {maintenance?.scope === 'workspace'
                ? "This project's memories are rebuilt"
                : 'Your memories are rebuilt'}{' '}
              from every saved note and import with the memory model. The
              current index and topics are replaced after a snapshot of them is
              saved. This can take several minutes.
            </>
          }
          confirmLabel="Rebuild memories"
          destructive
          onConfirm={() => {
            void rebuildNow();
          }}
          onCancel={() => setConfirmingRebuild(false)}
          dataTestId="memory-rebuild-dialog"
          confirmTestId="memory-rebuild-confirm"
        />
      )}
    </div>
  );
}

function isMac(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}
