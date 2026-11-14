'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  LedgerClient,
  LedgerFilePicker,
  LedgerNavigator,
} from '@canopy/app-core';
import type {
  LedgerViewChangeNotice,
  LedgerViewDetailState,
  LedgerViewEntryChangeState,
  LedgerViewOwnersState,
  LedgerViewProblem,
  LedgerViewSelectOptions,
  LedgerViewState,
  LedgerViewStore,
} from '@canopy/app-state';
import {
  ledgerSourceKindOfOrigin,
  toLedgerEntrySearchItem,
  type LedgerEntrySearchItem,
  type LedgerFileRef,
  type LedgerOwnerCandidate,
  type LedgerStatus,
} from '@canopy/protocol/canopy-core/core/ledger';
import {
  isLedgerTaskViewScope,
  ledgerViewScopeKey,
  type LedgerViewEntry,
  type LedgerViewResult,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  LedgerCorrectionBox,
  LedgerOwnerPicker,
  LedgerActivityLine,
  LedgerStatusControl,
  DelayedLoadingPlaceholder,
  Notice,
  NoticeButton,
  Skeleton,
  type LedgerActivityItem,
  type LedgerDensity,
  type LedgerEntrySlots,
  type LedgerOpenEntry,
} from '@canopy/ui-shared/components';
import {
  groupLedgerThreads,
  isLedgerEntryClosed,
  ledgerClosedEntryExplanation,
  ledgerSearchItemSourceAction,
  ledgerSourceDescription,
} from '@canopy/ui-shared/lib';
import { LedgerComposer } from './LedgerComposer';
import {
  LedgerCloseIntentPrompt,
  type LedgerCloseIntentChoice,
} from './ledger-close-intent';
import { problemCopy } from './ledger-problem-copy';
import {
  ledgerChangeNoticeCopy,
  ledgerSaveProblemText,
  ADD_CORRECTION_TITLE_PENDING_REASON,
} from './ledger-write-copy';

/*
 * What the Ledger panel and the Feed share for the rows of one of this
 * device's scopes: the scope's state the rows read, the actions they take
 * through the scope's view store, the controls each row offers, the open
 * entry, and the correction draft under the entry it corrects. Rows render
 * from list data; only the open entry is read.
 *
 * Everything here keeps its identity while nothing it shows changes, so the
 * thread list skips rows that did not change. Correction text is subscribed
 * to only by the box that edits it.
 */

const KEEP_DRAFT: LedgerViewSelectOptions = { keepDraft: true };

/** What a scope's rows read from its view: neither its list nor draft text. */
export interface LedgerScopeRowsState {
  readonly scope: LedgerViewScope;
  readonly selectedEntryId: string | null;
  readonly detail: LedgerViewDetailState;
  readonly change: LedgerViewEntryChangeState;
  readonly owners: LedgerViewOwnersState;
  /** Corrected entry IDs in correction creation order. */
  readonly correctionIds: readonly string[];
  /** A close waiting for the person's choice. */
  readonly closeIntent: LedgerViewState['closeIntent'];
}

const NO_CORRECTION_IDS: readonly string[] = [];

/** Why a global (workflow) entry's file can't open: it can have none. */
const GLOBAL_FILES_UNAVAILABLE =
  "Global Feed entries can't reference files. Add file references to a task's Feed.";

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function rowsStateOf(
  state: LedgerViewState,
  previous: LedgerScopeRowsState | undefined,
): LedgerScopeRowsState {
  const correctionIds = Object.keys(state.corrections);
  const stableCorrectionIds =
    previous !== undefined && sameStrings(previous.correctionIds, correctionIds)
      ? previous.correctionIds
      : correctionIds.length === 0
        ? NO_CORRECTION_IDS
        : correctionIds;
  if (
    previous !== undefined &&
    previous.scope === state.scope &&
    previous.selectedEntryId === state.selectedEntryId &&
    previous.detail === state.detail &&
    previous.change === state.change &&
    previous.owners === state.owners &&
    previous.correctionIds === stableCorrectionIds &&
    previous.closeIntent === state.closeIntent
  ) {
    return previous;
  }
  return {
    scope: state.scope,
    selectedEntryId: state.selectedEntryId,
    detail: state.detail,
    change: state.change,
    owners: state.owners,
    correctionIds: stableCorrectionIds,
    closeIntent: state.closeIntent,
  };
}

const NO_ROWS_STATES: readonly LedgerScopeRowsState[] = [];

/**
 * The rows state of each store, in order. The array and each state keep
 * their identity while none of what rows read changes. Pass a stable array.
 */
export function useLedgerScopeRowsStates(
  stores: readonly LedgerViewStore[],
): readonly LedgerScopeRowsState[] {
  const cache = useRef(new WeakMap<LedgerViewStore, LedgerScopeRowsState>());
  const last = useRef<readonly LedgerScopeRowsState[]>(NO_ROWS_STATES);
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      const unsubscribes = stores.map((store) => store.subscribe(onChange));
      return (): void => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [stores],
  );
  const getSnapshot = useCallback((): readonly LedgerScopeRowsState[] => {
    const states = stores.map((store) => {
      const next = rowsStateOf(store.getState(), cache.current.get(store));
      cache.current.set(store, next);
      return next;
    });
    const previous = last.current;
    if (
      previous.length === states.length &&
      states.every((state, index) => state === previous[index])
    ) {
      return previous;
    }
    last.current = states;
    return states;
  }, [stores]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const RESTING_DETAIL: LedgerViewDetailState = {
  status: 'idle',
  entryId: null,
  view: null,
  problem: null,
  loadingMoreHistory: false,
};
const RESTING_CHANGE: LedgerViewEntryChangeState = {
  saving: false,
  request: null,
  notice: null,
  message: null,
};
const RESTING_OWNERS: LedgerViewOwnersState = {
  status: 'idle',
  candidates: [],
  problem: null,
};

/**
 * The rows state of a scope nothing watches: nothing open or saving, no
 * corrections and no owners read yet. Cache it per scope to keep identity.
 */
export function ledgerRestingRowsState(
  scope: LedgerViewScope,
): LedgerScopeRowsState {
  return {
    scope,
    selectedEntryId: null,
    detail: RESTING_DETAIL,
    change: RESTING_CHANGE,
    owners: RESTING_OWNERS,
    correctionIds: NO_CORRECTION_IDS,
    closeIntent: null,
  };
}

/** The rows state of one store. */
export function useLedgerScopeRowsState(
  store: LedgerViewStore,
): LedgerScopeRowsState {
  const stores = useMemo(() => [store], [store]);
  const [state] = useLedgerScopeRowsStates(stores);
  // One store in, one state out.
  if (state === undefined) {
    return rowsStateOf(store.getState(), undefined);
  }
  return state;
}

/** Why opening an entry's source or file failed, shown on that entry. */
export interface LedgerOpenError {
  readonly entryId: string;
  readonly message: string;
}

/** What one entry's row does, through its scope's view store. */
export interface LedgerScopeActions {
  /** Opens the entry, keeping a draft on screen. */
  readonly open: (entryId: string) => void;
  /** Closes the open entry of the scope, keeping a draft on screen. */
  readonly close: () => void;
  readonly changeStatus: (entryId: string, status: LedgerStatus) => void;
  readonly assignOwner: (
    entryId: string,
    owner: LedgerOwnerCandidate | null,
  ) => void;
  readonly loadOwners: () => void;
  /** Starts or continues a correction of the entry without opening it. */
  readonly startCorrection: (entry: LedgerEntrySearchItem) => void;
  readonly openSource: (entry: LedgerEntrySearchItem) => void;
  readonly openFile: (
    entry: LedgerEntrySearchItem,
    file: LedgerFileRef,
  ) => void;
  readonly retryChange: () => void;
  readonly dismissChangeNotice: () => void;
  readonly reloadDetail: () => void;
  readonly loadMoreHistory: () => void;
}

export interface LedgerScopeActionsOptions {
  /**
   * The scope's view store, looked up whenever an action runs: a host may
   * let go of a scope's store while nothing holds it.
   */
  readonly view: () => LedgerViewStore;
  readonly client: LedgerClient;
  readonly navigator: LedgerNavigator;
  /**
   * Makes the entry the one the surrounding view shows open, before its
   * scope selects it: the Feed's own selection. The panel needs none.
   */
  readonly onFocus?: (entryId: string) => void;
  /** Shows why opening a source or file failed (null clears it). */
  readonly onOpenError: (error: LedgerOpenError | null) => void;
  /** The Feed needs to watch this scope after it starts a correction. */
  readonly onStartCorrection?: () => void;
  /** An owner picker of this scope opened and reads the owners. */
  readonly onLoadOwners?: () => void;
}

function readProblemOf(
  result: Exclude<LedgerViewResult<unknown>, { status: 'ok' }>,
): LedgerViewProblem {
  return result.status === 'unavailable'
    ? { kind: 'unavailable', reason: result.reason }
    : { kind: 'error', reason: result.reason, message: result.message };
}

/** The entry's read: the scope's detail when it is that entry, else a read. */
async function readEntry(
  client: LedgerClient,
  state: LedgerViewState,
  entryId: string,
): Promise<LedgerViewResult<LedgerViewEntry>> {
  const { detail } = state;
  if (
    detail.status === 'ready' &&
    detail.entryId === entryId &&
    detail.view !== null
  ) {
    return { status: 'ok', value: detail.view };
  }
  try {
    return await client.getEntry({ scope: state.scope, entryId });
  } catch (error) {
    return {
      status: 'error',
      reason: 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The actions of one scope's rows. Build once per scope and keep it. */
export function createLedgerScopeActions({
  view,
  client,
  navigator,
  onFocus,
  onOpenError,
  onStartCorrection,
  onLoadOwners,
}: LedgerScopeActionsOptions): LedgerScopeActions {
  const open = (entryId: string): void => {
    onFocus?.(entryId);
    void view().getState().select(entryId, KEEP_DRAFT);
  };
  /** A failed open shows on its entry, which opens to show it. */
  const failOpen = (entryId: string, message: string): void => {
    const { selectedEntryId } = view().getState();
    if (selectedEntryId !== entryId) open(entryId);
    onOpenError({ entryId, message });
  };
  return {
    open,
    close: (): void => {
      void view().getState().select(null, KEEP_DRAFT);
    },
    changeStatus: (entryId, status): void => {
      onFocus?.(entryId);
      void view().getState().changeStatusOf(entryId, status);
    },
    assignOwner: (entryId, owner): void => {
      onFocus?.(entryId);
      void view().getState().assignOwnerOf(entryId, owner);
    },
    loadOwners: (): void => {
      onLoadOwners?.();
      void view().getState().loadOwners();
    },
    startCorrection: (entry): void => {
      view().getState().startCorrection(entry);
      onStartCorrection?.();
    },
    openSource: (entry): void => {
      onOpenError(null);
      const state = view().getState();
      const { scope } = state;
      void readEntry(client, state, entry.entryId).then((result) => {
        if (result.status !== 'ok') {
          failOpen(
            entry.entryId,
            problemCopy(readProblemOf(result), 'entry').message,
          );
          return;
        }
        const { source } = result.value;
        const target = source?.target ?? null;
        if (target === null) {
          // Nothing to open: say why, as the entry's details do.
          failOpen(
            entry.entryId,
            ledgerSourceDescription(result.value.entry.entry.origin, source),
          );
          return;
        }
        void navigator.openSource(scope, target).then((opened) => {
          if (!opened.ok) failOpen(entry.entryId, opened.message);
        });
      });
    },
    openFile: (entry, file): void => {
      onOpenError(null);
      const { scope } = view().getState();
      // Only a task has files; a global (workflow) entry never references one.
      if (!isLedgerTaskViewScope(scope)) {
        failOpen(entry.entryId, GLOBAL_FILES_UNAVAILABLE);
        return;
      }
      void navigator.openFile(scope, file).then((opened) => {
        if (!opened.ok) failOpen(entry.entryId, opened.message);
      });
    },
    retryChange: (): void => {
      void view().getState().retryChange();
    },
    dismissChangeNotice: (): void => {
      view().getState().dismissChangeNotice();
    },
    reloadDetail: (): void => {
      void view().getState().reloadDetail();
    },
    loadMoreHistory: (): void => {
      void view().getState().loadMoreHistory();
    },
  };
}

type SlotsBuilder = (
  entryId: string,
  deps: readonly unknown[],
  build: () => LedgerEntrySlots,
) => LedgerEntrySlots;

/**
 * A per-entry cache of slots: the same slots while their inputs are the
 * same, so unchanged rows skip rendering.
 */
export function useLedgerSlotsCache(): SlotsBuilder {
  const cache = useRef(
    new Map<
      string,
      { readonly deps: readonly unknown[]; readonly slots: LedgerEntrySlots }
    >(),
  );
  return useCallback((entryId, deps, build) => {
    const hit = cache.current.get(entryId);
    if (
      hit !== undefined &&
      hit.deps.length === deps.length &&
      hit.deps.every((dep, index) => Object.is(dep, deps[index]))
    ) {
      return hit.slots;
    }
    const slots = build();
    cache.current.set(entryId, { deps, slots });
    return slots;
  }, []);
}

export interface LedgerWritableSlotsInput {
  readonly entry: LedgerEntrySearchItem;
  /** The owner's name, as the row shows it. */
  readonly ownerName: string;
  readonly rows: LedgerScopeRowsState;
  readonly actions: LedgerScopeActions;
}

/** The inputs a writable entry's slots depend on, for the slots cache. */
export function ledgerWritableSlotsDeps({
  entry,
  ownerName,
  rows,
  actions,
}: LedgerWritableSlotsInput): readonly unknown[] {
  const { change } = rows;
  const saving = change.saving && change.request?.entryId === entry.entryId;
  return [entry, ownerName, rows.owners, saving, actions];
}

/**
 * What an entry of this device offers: while it is open, its status and
 * owner change in place; its source opens; a correction starts unless its
 * title is still being written.
 */
export function ledgerWritableEntrySlots({
  entry,
  ownerName,
  rows,
  actions,
}: LedgerWritableSlotsInput): LedgerEntrySlots {
  const { change, owners } = rows;
  const saving = change.saving && change.request?.entryId === entry.entryId;
  const correction: Pick<
    LedgerEntrySlots,
    'onAddCorrection' | 'addCorrectionDisabledReason'
  > = {
    onAddCorrection: (): void => {
      actions.startCorrection(entry);
    },
    addCorrectionDisabledReason:
      entry.titlePending === true ? ADD_CORRECTION_TITLE_PENDING_REASON : null,
  };
  const source = {
    sourceAction: ledgerSearchItemSourceAction(entry),
    onOpenSource: (): void => {
      actions.openSource(entry);
    },
  };
  if (isLedgerEntryClosed(entry.status)) return { ...source, ...correction };
  return {
    statusControl: (
      <LedgerStatusControl
        variant="inline"
        status={entry.status}
        saving={saving}
        onChange={(status) => actions.changeStatus(entry.entryId, status)}
      />
    ),
    ownerControl: (
      <LedgerOwnerPicker
        variant="inline"
        ownerName={ownerName}
        ownerActorId={entry.owner.actorId}
        candidates={owners.candidates}
        status={owners.status}
        saving={saving}
        onOpen={actions.loadOwners}
        onSelect={(candidate) => actions.assignOwner(entry.entryId, candidate)}
      />
    ),
    ...source,
    ...correction,
  };
}

/** How the last status or owner change went, with what can follow. */
function LedgerChangeNotice({
  notice,
  onRetry,
  onDismiss,
}: {
  readonly notice: LedgerViewChangeNotice;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const copy = ledgerChangeNoticeCopy(notice);
  return (
    <Notice
      errorSource="ledger-entry-change-notice"
      data-testid="ledger-entry-change-notice"
      data-notice={notice}
      intent={copy.intent}
      actions={
        copy.retry ? (
          <NoticeButton onClick={onRetry}>Try again</NoticeButton>
        ) : (
          <NoticeButton onClick={onDismiss}>Dismiss</NoticeButton>
        )
      }
    >
      {copy.message}
    </Notice>
  );
}

/** A failed read of the open entry, and Try again when it can help. */
export function LedgerEntryReadProblem({
  problem,
  onRetry,
}: {
  readonly problem: LedgerViewProblem;
  readonly onRetry: () => void;
}): JSX.Element {
  const copy = problemCopy(problem, 'entry');
  return (
    <Notice
      errorSource="ledger-detail-problem"
      data-testid="ledger-detail-problem"
      intent={copy.retry ? 'destructive' : 'neutral'}
      actions={
        copy.retry ? (
          <NoticeButton onClick={onRetry}>Try again</NoticeButton>
        ) : undefined
      }
    >
      {copy.message}
    </Notice>
  );
}

const SAMPLE_ACTIVITY_NOW = new Date('2026-01-01T12:30:00.000Z');

/** Plain activity lines the read's skeleton measures. */
const SAMPLE_ACTIVITY: readonly LedgerActivityItem[] = [
  {
    key: 'ledger-activity-skeleton-1',
    text: 'Status changed to In progress',
    occurredAt: '2026-01-01T12:00:00.000Z',
  },
  {
    key: 'ledger-activity-skeleton-2',
    text: 'Owner changed to the release agent',
    occurredAt: '2026-01-01T12:10:00.000Z',
  },
];

/**
 * The open entry's read while it loads: the activity lines it brings, drawn
 * from plain samples inside the measured `Skeleton`.
 */
export function LedgerEntryReadLoading(): JSX.Element {
  return (
    <DelayedLoadingPlaceholder slowNote="Still loading entry…">
      <Skeleton loading label="Loading entry" testId="ledger-entry-loading">
        <ul className="flex flex-col gap-2.5">
          {SAMPLE_ACTIVITY.map((item) => (
            <LedgerActivityLine
              key={item.key}
              item={item}
              now={SAMPLE_ACTIVITY_NOW}
            />
          ))}
        </ul>
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}

/** Why a closed entry can't change, where its controls would be. */
export function LedgerClosedExplanation({
  status,
}: {
  readonly status: LedgerStatus;
}): JSX.Element {
  return (
    <p data-testid="ledger-entry-closed" className="text-2xs fg-tertiary">
      {ledgerClosedEntryExplanation(status)}
    </p>
  );
}

/**
 * The scope's open entry: its selected entry with its read, how the read
 * and the last change went, and why a closed entry can't change. Memoize
 * the result on its inputs. With `onChooseClose`, a close waiting on this
 * entry shows its choice where the change's notice goes; a surface that
 * shows the choice elsewhere leaves it out.
 */
export function ledgerScopeOpenEntry(
  rows: Pick<LedgerScopeRowsState, 'selectedEntryId' | 'detail' | 'change'> & {
    readonly closeIntent?: LedgerScopeRowsState['closeIntent'];
  },
  actions: LedgerScopeActions,
  openError: LedgerOpenError | null,
  onChooseClose?: (choice: LedgerCloseIntentChoice) => Promise<void>,
): LedgerOpenEntry | null {
  const { selectedEntryId: entryId, detail, change } = rows;
  if (entryId === null) return null;
  const view =
    detail.status === 'ready' && detail.entryId === entryId
      ? detail.view
      : null;
  let readState: ReactNode;
  if (detail.status === 'problem' && detail.problem !== null) {
    readState = (
      <LedgerEntryReadProblem
        problem={detail.problem}
        onRetry={actions.reloadDetail}
      />
    );
  } else if (view === null) {
    readState = <LedgerEntryReadLoading />;
  }
  const entryType = view?.entry.entry.type;
  const closeIntent = rows.closeIntent ?? null;
  const notice =
    onChooseClose !== undefined &&
    closeIntent !== null &&
    closeIntent.entryId === entryId &&
    (entryType === 'OPERATION' || entryType === 'TASK') ? (
      <LedgerCloseIntentPrompt
        openCount={closeIntent.openCount}
        openCountIsLowerBound={closeIntent.openCountIsLowerBound}
        kind={entryType}
        onChoose={async (choice): Promise<{ readonly ok: true }> => {
          await onChooseClose(choice);
          return { ok: true };
        }}
      />
    ) : change.notice === null ? undefined : (
      <LedgerChangeNotice
        notice={change.notice}
        onRetry={actions.retryChange}
        onDismiss={actions.dismissChangeNotice}
      />
    );
  const status = view?.entry.entry.status;
  const closedExplanation =
    notice === undefined &&
    status !== undefined &&
    isLedgerEntryClosed(status) ? (
      <LedgerClosedExplanation status={status} />
    ) : undefined;
  const hasMoreHistory =
    view !== null &&
    view.entry.history !== null &&
    view.entry.history.nextCursor !== null;
  return {
    entryId,
    view,
    readState,
    notice,
    closedExplanation,
    openError: openError?.entryId === entryId ? openError.message : null,
    ...(hasMoreHistory ? { onLoadMoreHistory: actions.loadMoreHistory } : {}),
    loadingMoreHistory: detail.loadingMoreHistory,
  };
}

/** The open entry's read as a list item, for showing it when it isn't loaded. */
export function ledgerReadItem(
  view: LedgerViewEntry | null,
): LedgerEntrySearchItem | null {
  if (view === null) return null;
  const read = view.entry;
  const item = toLedgerEntrySearchItem(
    read.entry,
    read.sourceAvailability,
    read.syncState,
  );
  const titlePending = 'titlePending' in read && read.titlePending === true;
  const sourceKind = ledgerSourceKindOfOrigin(read.entry.origin);
  return {
    ...item,
    ...(sourceKind === undefined ? {} : { sourceKind }),
    ...(titlePending ? { titlePending: true } : {}),
  };
}

/** The loaded entries with the open one placed, if it isn't loaded. */
export interface LedgerPlacedEntries {
  readonly entries: readonly LedgerEntrySearchItem[];
  /** The open entry above the list: not loaded, and not a reply. */
  readonly pinnedEntry: LedgerEntrySearchItem | null;
}

/**
 * Places an open entry that isn't loaded, such as one App Advisor opened or
 * one just saved: a correction of a loaded entry joins its thread as a
 * reply, anything else is pinned above the list. Memoize on its inputs.
 */
export function placeLedgerOpenEntry(
  entries: readonly LedgerEntrySearchItem[],
  openItem: LedgerEntrySearchItem | null,
): LedgerPlacedEntries {
  if (
    openItem === null ||
    entries.some((entry) => entry.entryId === openItem.entryId)
  ) {
    return { entries, pinnedEntry: null };
  }
  const target = openItem.supersedesEntryId;
  if (
    target !== undefined &&
    entries.some((entry) => entry.entryId === target)
  ) {
    return { entries: [...entries, openItem], pinnedEntry: null };
  }
  return { entries, pinnedEntry: openItem };
}

/** Each entry's thread root, as the thread list groups them. */
export function ledgerThreadRootIds(
  entries: readonly LedgerEntrySearchItem[],
): ReadonlyMap<string, string> {
  const roots = new Map<string, string>();
  for (const thread of groupLedgerThreads(entries)) {
    roots.set(thread.root.entryId, thread.root.entryId);
    for (const correction of thread.corrections) {
      roots.set(correction.entryId, thread.root.entryId);
    }
  }
  return roots;
}

export interface LedgerCorrectionDraftLocation {
  readonly store: LedgerViewStore;
  readonly entryId: string;
  readonly scopeKey: string;
}

interface CachedCorrectionRoot {
  readonly locations: readonly LedgerCorrectionDraftLocation[];
  readonly node: ReactNode;
}

interface CachedCorrectionPlacements {
  readonly groups: ReadonlyMap<
    string,
    readonly LedgerCorrectionDraftLocation[]
  >;
  readonly corrections: ReadonlyMap<string, ReactNode>;
  readonly unlisted: readonly LedgerCorrectionDraftLocation[];
  readonly density: LedgerDensity;
  readonly personName: string;
  readonly files: LedgerFilePicker | undefined;
  readonly onSaved: ((entryId: string) => void) | undefined;
}

function sameCorrectionLocations(
  left: readonly LedgerCorrectionDraftLocation[],
  right: readonly LedgerCorrectionDraftLocation[],
): boolean {
  return (
    left.length === right.length &&
    left.every((location, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        location.scopeKey === other.scopeKey &&
        location.entryId === other.entryId &&
        location.store === other.store
      );
    })
  );
}

function sameCorrectionGroups(
  left: ReadonlyMap<string, readonly LedgerCorrectionDraftLocation[]>,
  right: ReadonlyMap<string, readonly LedgerCorrectionDraftLocation[]>,
): boolean {
  if (left.size !== right.size) return false;
  const leftGroups = [...left];
  const rightGroups = [...right];
  return leftGroups.every(([rootId, locations], index) => {
    const other = rightGroups[index];
    return (
      other !== undefined &&
      rootId === other[0] &&
      sameCorrectionLocations(locations, other[1])
    );
  });
}

/**
 * Places each correction draft beneath its loaded thread, or returns it for
 * the composer area when its corrected entry is not currently listed. A
 * thread keeps the same React node while its ordered set of drafts and the
 * node's props stay the same. `onSaved` hears of each correction saved from
 * a box, with the entry it became; pass a stable function.
 */
export function useLedgerCorrectionPlacements(
  drafts: readonly LedgerCorrectionDraftLocation[],
  roots: ReadonlyMap<string, string>,
  pinnedEntryId: string | null,
  density: LedgerDensity,
  personName: string,
  files: LedgerFilePicker | undefined,
  onSaved?: (entryId: string) => void,
): {
  readonly corrections: ReadonlyMap<string, ReactNode>;
  readonly unlisted: readonly LedgerCorrectionDraftLocation[];
} {
  const rootNodes = useRef(new Map<string, CachedCorrectionRoot>());
  const previous = useRef<CachedCorrectionPlacements | null>(null);
  return useMemo(() => {
    const groups = new Map<string, LedgerCorrectionDraftLocation[]>();
    const unlisted: LedgerCorrectionDraftLocation[] = [];
    for (const draft of drafts) {
      const rootId =
        roots.get(draft.entryId) ??
        (pinnedEntryId === draft.entryId ? pinnedEntryId : null);
      if (rootId === null) {
        unlisted.push(draft);
        continue;
      }
      const group = groups.get(rootId);
      if (group === undefined) groups.set(rootId, [draft]);
      else group.push(draft);
    }

    const current = previous.current;
    const sameProps =
      current !== null &&
      current.density === density &&
      current.personName === personName &&
      current.files === files &&
      current.onSaved === onSaved;
    const sameGroups =
      current !== null && sameCorrectionGroups(current.groups, groups);
    const sameUnlisted =
      current !== null && sameCorrectionLocations(current.unlisted, unlisted);
    if (sameProps && sameGroups && sameUnlisted && current !== null) {
      return current;
    }

    const nextRootNodes = new Map<string, CachedCorrectionRoot>();
    const reuseCorrections = sameProps && sameGroups && current !== null;
    const nextCorrections = reuseCorrections
      ? null
      : new Map<string, ReactNode>();
    for (const [rootId, locations] of groups) {
      const cached = rootNodes.current.get(rootId);
      const node =
        sameProps &&
        cached !== undefined &&
        sameCorrectionLocations(cached.locations, locations) ? (
          cached.node
        ) : (
          <>
            {locations.map((location) => (
              <LedgerScopeCorrectionDraft
                key={`${location.scopeKey}:${location.entryId}`}
                store={location.store}
                entryId={location.entryId}
                density={density}
                personName={personName}
                files={files}
                {...(onSaved === undefined ? {} : { onSaved })}
              />
            ))}
          </>
        );
      nextRootNodes.set(rootId, { locations, node });
      nextCorrections?.set(rootId, node);
    }
    rootNodes.current = nextRootNodes;
    const placements: CachedCorrectionPlacements = {
      groups,
      corrections:
        reuseCorrections && current !== null
          ? current.corrections
          : (nextCorrections ?? new Map<string, ReactNode>()),
      unlisted: sameUnlisted && current !== null ? current.unlisted : unlisted,
      density,
      personName,
      files,
      onSaved,
    };
    previous.current = placements;
    return placements;
  }, [drafts, roots, pinnedEntryId, density, personName, files, onSaved]);
}

export interface LedgerScopeCorrectionDraftProps {
  readonly store: LedgerViewStore;
  readonly entryId: string;
  readonly density: LedgerDensity;
  /** The person writing, for the box's avatar. */
  readonly personName: string;
  readonly files?: LedgerFilePicker;
  /** Hears of the saved correction, with the entry it became. */
  readonly onSaved?: (entryId: string) => void;
}

/**
 * The scope's correction draft under the entry it corrects: a box for its
 * content, or the full form after `More options`. It reads the draft
 * itself, so typing renders only this.
 */
export function LedgerScopeCorrectionDraft({
  store,
  entryId,
  density,
  personName,
  files,
  onSaved,
}: LedgerScopeCorrectionDraftProps): JSX.Element | null {
  const correction = store((state) => state.corrections[entryId] ?? null);
  const [expanded, setExpanded] = useState(false);
  if (correction === null) return null;
  if (expanded) {
    return (
      <LedgerComposer
        store={store}
        files={files}
        correctionOf={entryId}
        {...(onSaved === undefined ? {} : { onSaved })}
      />
    );
  }
  return (
    <LedgerCorrectionBox
      density={density}
      personName={personName}
      value={correction.draft.content}
      onChange={(content) =>
        store.getState().updateCorrection(entryId, { content })
      }
      onSubmit={() => {
        void store
          .getState()
          .submitCorrection(entryId)
          .then((savedId) => {
            if (savedId !== null) onSaved?.(savedId);
          });
      }}
      onDiscard={() => store.getState().cancelCorrection(entryId)}
      onMoreOptions={() => setExpanded(true)}
      saving={correction.saving}
      problem={
        correction.problem === null
          ? null
          : ledgerSaveProblemText(correction.problem)
      }
    />
  );
}

/** How often relative times ("5m ago") move on. */
const NOW_TICK_MS = 60_000;

/** The current time for relative times, moving on once a minute. */
export function useLedgerNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), NOW_TICK_MS);
    return (): void => clearInterval(interval);
  }, []);
  return now;
}

/** The name a scope is known by in maps. */
export function ledgerScopeKey(scope: LedgerViewScope): string {
  return ledgerViewScopeKey(scope);
}
