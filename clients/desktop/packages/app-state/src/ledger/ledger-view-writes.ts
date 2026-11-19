import type { LedgerClient } from '@canopy/app-core';
import {
  LEDGER_DEFAULT_STATUS_BY_TYPE,
  LEDGER_PUBLIC_ENTRY_TYPES,
  isLedgerTerminalStatus,
  isSameLedgerPipelinePause,
  type LedgerAddEntryParams,
  type LedgerEntry,
  type LedgerFileRef,
  type LedgerOwnerCandidate,
  type LedgerOwnerTarget,
  type LedgerPublicEntryType,
  type LedgerStatus,
} from '@canopy/protocol/canopy-core/core/ledger';
import type {
  LedgerViewOwnerPage,
  LedgerViewReceipt,
  LedgerViewResult,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import type { LedgerViewSelectOptions } from './create-ledger-view-store';
import { readLedgerOpenDescendants } from './ledger-open-descendants';
import { keepCause, thrownResult } from './ledger-view-results';

/*
 * The person's writes from a Ledger view: a new-entry draft, independent
 * corrections, and status or owner changes of the selected entry. Every write
 * goes through the client as the person; nothing here decides policy. A draft
 * keeps its request key through every retry of the same content and closes
 * only once the Ledger returned a durable receipt, so a lost answer never
 * records it twice; content edited after a send goes out under a fresh key. A
 * change applies to the revision the view shows; when the entry changed
 * meanwhile, the view reads it again instead of replaying the change.
 */

/** A new entry being written, or a correction of an existing one. */
export interface LedgerViewDraft {
  readonly type: LedgerPublicEntryType;
  readonly title: string;
  readonly content: string;
  readonly highlights: readonly string[];
  readonly referenceFiles: readonly LedgerFileRef[];
  readonly status: LedgerStatus;
  /** Null keeps the person writing it as the owner ("You"). */
  readonly owner: LedgerOwnerCandidate | null;
  /** An optional operation parent; scoped to the task this draft belongs to. */
  readonly parent: { readonly entryId: string; readonly title: string } | null;
  /** The entry this one corrects; null for a new entry. */
  readonly supersedes: {
    readonly entryId: string;
    readonly title: string;
  } | null;
}

/** Why a write did not apply. Never an empty result. */
export interface LedgerViewWriteProblem {
  readonly reason: string;
  readonly message: string;
}

/**
 * A send of the draft that came back without a receipt. The Ledger may have
 * recorded it, so what it carried only ever goes out again under its key.
 */
export interface LedgerViewUnconfirmedSend {
  readonly requestKey: string;
  /** The add params it carried, serialized. */
  readonly params: string;
}

export interface LedgerViewComposerState {
  /** Null until the person starts an entry, and again once it is saved. */
  readonly draft: LedgerViewDraft | null;
  /** Whether the draft is on screen; selecting an entry sets it aside. */
  readonly shown: boolean;
  readonly saving: boolean;
  /**
   * The key the draft goes out under as it now reads: kept through every
   * retry of the same content, and never one that carried other content.
   */
  readonly requestKey: string | null;
  /** Every send of this draft that came back without a receipt. */
  readonly unconfirmed: readonly LedgerViewUnconfirmedSend[];
  readonly problem: LedgerViewWriteProblem | null;
  /**
   * The ID a draft taken from elsewhere came with, such as the Feed's, so
   * the Feed knows its own draft; null for a draft started in this view.
   */
  readonly adoptedId: string | null;
}

/** A correction of one entry being written. */
export interface LedgerViewCorrectionState {
  /** Its `supersedes` names the corrected entry. */
  readonly draft: LedgerViewDraft;
  readonly saving: boolean;
  /** Same rules as the composer's key: kept through retries of the same content, never reused for other content. */
  readonly requestKey: string;
  readonly unconfirmed: readonly LedgerViewUnconfirmedSend[];
  readonly problem: LedgerViewWriteProblem | null;
}

export interface LedgerViewOwnersState {
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  readonly candidates: readonly LedgerOwnerCandidate[];
  readonly problem: LedgerViewWriteProblem | null;
}

/** Why the last status or owner change did not apply as asked. */
export type LedgerViewChangeNotice =
  /** The entry changed meanwhile; the view read it again. */
  | 'conflict'
  /** The chosen owner can no longer be assigned; owners were read again. */
  | 'owner_unavailable'
  /** The entry was closed meanwhile; the view read it again. */
  | 'closed'
  /** The change failed; it can be tried again as it was. */
  | 'failed';

/** One status or owner change of an entry. */
export interface LedgerViewChangeRequest {
  readonly entryId: string;
  readonly requestKey: string;
  readonly expectedRevision: number;
  readonly status?: LedgerStatus;
  readonly owner?: LedgerOwnerTarget;
  /** Explicit resolution of open descendants when closing a parent. */
  readonly openChildren?: 'complete' | 'detach';
}

export interface LedgerViewEntryChangeState {
  readonly saving: boolean;
  /** The change in flight, or the failed one "Try again" sends again. */
  readonly request: LedgerViewChangeRequest | null;
  readonly notice: LedgerViewChangeNotice | null;
  readonly message: string | null;
}

/** A draft taken from elsewhere that this view saved. */
export interface LedgerViewSavedAdopted {
  /** The ID the draft came with (see `adoptDraft`). */
  readonly adoptedId: string;
  /** The entry it became. */
  readonly entryId: string;
}

/** What the person can write, as store state and actions. */
export interface LedgerViewWriteSlice {
  readonly composer: LedgerViewComposerState;
  /**
   * Corrections keyed by corrected entry ID. Key insertion order is creation
   * order (entry IDs are UUIDs, never integer-like keys); updates spread this
   * record and overwrite a key to preserve that order.
   */
  readonly corrections: Readonly<Record<string, LedgerViewCorrectionState>>;
  readonly owners: LedgerViewOwnersState;
  readonly change: LedgerViewEntryChangeState;
  /** A parent closure awaiting the person's explicit descendant disposition. */
  readonly closeIntent: {
    /** The operation or task being closed. */
    readonly entryId: string;
    /** The terminal status requested for the parent. */
    readonly status: LedgerStatus;
    /** Open descendants found, excluding the parent itself. */
    readonly openCount: number;
    /** More descendants may exist beyond the single bounded search page. */
    readonly openCountIsLowerBound: boolean;
  } | null;
  /** Cancels closing, moves open descendants out, or completes them all. */
  readonly resolveCloseIntent: (
    choice: 'cancel' | 'detach' | 'complete',
  ) => Promise<void>;
  /**
   * The last saved draft, when it was taken from elsewhere, so the Feed can
   * tell its draft saved here from one dropped here; null after a save of
   * this view's own draft.
   */
  readonly savedAdopted: LedgerViewSavedAdopted | null;
  /** Shows the draft, starting a blank one when there is none. */
  readonly startEntry: () => void;
  /**
   * Starts a correction of `entry`, linked to it, unless one already exists.
   */
  readonly startCorrection: (entry: LedgerCorrectionTarget) => void;
  /** Updates one correction; its corrected-entry link cannot change. */
  readonly updateCorrection: (
    entryId: string,
    patch: Partial<LedgerViewDraft>,
  ) => void;
  /**
   * Saves one correction without selecting its new entry. Resolves to the
   * entry it became, so a host can show what the person saved; null when it
   * did not save (or the view was reset meanwhile).
   */
  readonly submitCorrection: (entryId: string) => Promise<string | null>;
  /** Drops a correction unless its save is still in flight. */
  readonly cancelCorrection: (entryId: string) => void;
  /**
   * Takes a new entry's draft written elsewhere, such as the Feed's, and
   * shows it under a fresh request key, recording the ID it came with.
   * Returns false, changing nothing, while this view's new-entry composer
   * already has a draft; independent correction drafts do not block it.
   */
  readonly adoptDraft: (draft: LedgerViewDraft, adoptedId: string) => boolean;
  /**
   * Lets the draft go so it can move to another scope, and returns it.
   * Returns null, keeping it, unless `ledgerDraftMovable` allows the move.
   */
  readonly releaseDraft: () => LedgerViewDraft | null;
  readonly updateDraft: (patch: Partial<LedgerViewDraft>) => void;
  /** Sets the draft aside; it stays until saved or discarded. */
  readonly hideDraft: () => void;
  readonly discardDraft: () => void;
  readonly submitDraft: () => Promise<void>;
  /** Reads the owners the person may assign. */
  readonly loadOwners: () => Promise<void>;
  /** Changes the selected entry's status from the revision shown. */
  readonly changeStatus: (status: LedgerStatus) => Promise<void>;
  /** Assigns the selected entry; null assigns it to the person. */
  readonly assignOwner: (owner: LedgerOwnerCandidate | null) => Promise<void>;
  /** Changes an entry's status, selecting and reading it first if needed. */
  readonly changeStatusOf: (
    entryId: string,
    status: LedgerStatus,
  ) => Promise<void>;
  /** Assigns an entry, selecting and reading it first if needed. */
  readonly assignOwnerOf: (
    entryId: string,
    owner: LedgerOwnerCandidate | null,
  ) => Promise<void>;
  /** Sends the failed change again, with its request key. */
  readonly retryChange: () => Promise<void>;
  readonly dismissChangeNotice: () => void;
}

/** The view state the write flows read. */
export interface LedgerViewWriteHostState extends LedgerViewWriteSlice {
  readonly selectedEntryId: string | null;
  readonly detail: {
    readonly status: 'idle' | 'loading' | 'ready' | 'problem';
    readonly view: { readonly entry: { readonly entry: LedgerEntry } } | null;
  };
}

/** An update of the write slice: its new fields, or a function of state. */
export type LedgerViewWriteUpdate =
  | Partial<LedgerViewWriteSlice>
  | ((state: LedgerViewWriteHostState) => Partial<LedgerViewWriteSlice>);

type LedgerDraftSlotState = Pick<
  LedgerViewCorrectionState,
  'draft' | 'saving' | 'requestKey' | 'unconfirmed' | 'problem'
>;

interface LedgerDraftSlot {
  /** Null denotes the one new-entry composer draft. */
  readonly correctionEntryId: string | null;
  readonly read: () => LedgerDraftSlotState | null;
  readonly update: (
    updater: (state: LedgerDraftSlotState) => LedgerDraftSlotState,
  ) => void;
}

export interface LedgerViewWriteContext {
  readonly client: LedgerClient;
  readonly scope: LedgerViewScope;
  readonly get: () => LedgerViewWriteHostState;
  readonly set: (update: LedgerViewWriteUpdate) => void;
  readonly newRequestKey: () => string;
  /**
   * Re-reads the list in place. `ownEntryId` is an entry the person just
   * saved, which shows at once rather than waiting as new activity.
   */
  readonly refreshList: (ownEntryId?: string) => Promise<void>;
  /**
   * Re-reads an entry's detail after a saved change, without a loading
   * state. What is shown is out of date until it succeeds, so a failed read
   * shows as a problem.
   */
  readonly reloadDetail: (entryId: string) => Promise<void>;
  /**
   * Re-reads an entry's detail with a loading state, so a failed read shows
   * as a problem rather than the previous revision.
   */
  readonly rereadDetail: (entryId: string) => Promise<void>;
  /** Selects an entry and reads its detail. */
  readonly select: (
    entryId: string,
    options?: LedgerViewSelectOptions,
  ) => Promise<void>;
}

/** The fields a correction needs from a selected row or detail. */
export type LedgerCorrectionTarget = Pick<
  LedgerEntry,
  'entryId' | 'type' | 'title'
>;

export const CLOSED_COMPOSER: LedgerViewComposerState = {
  draft: null,
  shown: false,
  saving: false,
  requestKey: null,
  unconfirmed: [],
  problem: null,
  adoptedId: null,
};

export const EMPTY_LEDGER_VIEW_CORRECTIONS: Readonly<
  Record<string, LedgerViewCorrectionState>
> = Object.freeze({});

export const IDLE_OWNERS: LedgerViewOwnersState = {
  status: 'idle',
  candidates: [],
  problem: null,
};

export const IDLE_CHANGE: LedgerViewEntryChangeState = {
  saving: false,
  request: null,
  notice: null,
  message: null,
};

function isPublicType(type: string): type is LedgerPublicEntryType {
  return LEDGER_PUBLIC_ENTRY_TYPES.some((publicType) => publicType === type);
}

/** A new entry's empty draft: its type's default status, owned by the person. */
export function blankLedgerViewDraft(
  type: LedgerPublicEntryType,
): LedgerViewDraft {
  return {
    type,
    title: '',
    content: '',
    highlights: [],
    referenceFiles: [],
    status: LEDGER_DEFAULT_STATUS_BY_TYPE[type],
    owner: null,
    parent: null,
    supersedes: null,
  };
}

/**
 * A draft with the person's change. A new type brings its default status,
 * unless the person chose another status or chooses one now.
 */
export function applyLedgerDraftPatch(
  draft: LedgerViewDraft,
  patch: Partial<LedgerViewDraft>,
): LedgerViewDraft {
  const next: LedgerViewDraft = { ...draft, ...patch };
  const status =
    patch.type !== undefined &&
    patch.status === undefined &&
    draft.status === LEDGER_DEFAULT_STATUS_BY_TYPE[draft.type]
      ? LEDGER_DEFAULT_STATUS_BY_TYPE[patch.type]
      : next.status;
  return { ...next, status };
}

/**
 * Whether a view's draft can move to another scope: a new entry's draft that
 * is not saving and that no send left unconfirmed, since the Ledger may have
 * recorded that one here. A correction stays with the entry it corrects.
 */
export function ledgerDraftMovable(composer: LedgerViewComposerState): boolean {
  return (
    composer.draft !== null &&
    composer.draft.supersedes === null &&
    !composer.saving &&
    composer.unconfirmed.length === 0
  );
}

/** A random request key, unique per draft or change. */
export function defaultLedgerRequestKey(): string {
  return globalThis.crypto.randomUUID();
}

function problemOf(
  result: Exclude<LedgerViewResult<unknown>, { status: 'ok' }>,
): LedgerViewWriteProblem {
  return result.status === 'unavailable'
    ? { reason: result.reason, message: '' }
    : keepCause({ reason: result.reason, message: result.message }, result);
}

/** The add params of a draft; empty optional fields are left out. */
export function ledgerDraftAddParams(
  draft: LedgerViewDraft,
): LedgerAddEntryParams {
  const title = draft.title.trim();
  const highlights = draft.highlights
    .map((highlight) => highlight.trim())
    .filter((highlight) => highlight.length > 0);
  return {
    type: draft.type,
    ...(title.length > 0 ? { title } : {}),
    content: draft.content.trim(),
    ...(highlights.length > 0 ? { highlights } : {}),
    ...(draft.referenceFiles.length > 0
      ? { referenceFiles: [...draft.referenceFiles] }
      : {}),
    status: draft.status,
    owner:
      draft.owner === null || draft.owner.isSelf
        ? 'self'
        : {
            actorId: draft.owner.actor.actorId,
            eligibilityToken: draft.owner.eligibilityToken,
          },
    ...(draft.type === 'TASK' &&
    draft.supersedes === null &&
    draft.parent !== null
      ? { parentEntryId: draft.parent.entryId }
      : {}),
    ...(draft.supersedes === null
      ? {}
      : { supersedesEntryId: draft.supersedes.entryId }),
  };
}

/** A draft's add params as one comparable string. */
function serializedParams(draft: LedgerViewDraft): string {
  return JSON.stringify(ledgerDraftAddParams(draft));
}

/** Whether a draft has what the Ledger requires to save it. */
export function isLedgerDraftComplete(draft: LedgerViewDraft): boolean {
  return draft.content.trim().length > 0;
}

/** Whether a view holds any draft the person wrote: a new entry's or a correction. */
export function ledgerViewHoldsDraft(
  state: Pick<LedgerViewWriteSlice, 'composer' | 'corrections'>,
): boolean {
  return (
    state.composer.draft !== null || Object.keys(state.corrections).length > 0
  );
}

/** The write slice, and a reset that drops everything still in flight. */
export interface LedgerViewWrites {
  readonly slice: LedgerViewWriteSlice;
  /**
   * The change state an entry is shown with when it is selected: still
   * saving while its change is unanswered, how a change went while the
   * person was elsewhere (told once), otherwise idle.
   */
  readonly changeFor: (entryId: string | null) => LedgerViewEntryChangeState;
  /** Results of writes and owner reads started before it are ignored. */
  readonly reset: () => void;
}

export function createLedgerViewWriteSlice(
  context: LedgerViewWriteContext,
): LedgerViewWrites {
  const { client, scope, get, newRequestKey } = context;
  let ownersGeneration = 0;
  // Bumped by a reset: whatever was in flight then no longer applies.
  let viewGeneration = 0;
  /** Changes sent and not yet answered, by entry. */
  const unanswered = new Map<string, LedgerViewChangeRequest>();
  /** The checked revision and key retained while a close prompt is open. */
  let pendingClose: LedgerViewChangeRequest | null = null;
  /**
   * Failed preflight reads must be retried before sending any closure: each
   * request key, with its entry's parent (null for a top-level entry).
   */
  const uncheckedClosures = new Map<string, string | null>();
  /**
   * How a change went for an entry the person had left, kept until the entry
   * is shown again.
   */
  const outcomes = new Map<string, LedgerViewEntryChangeState>();
  const setSlice = (update: LedgerViewWriteUpdate): void => {
    context.set(update);
  };

  const draftSlotState = (
    state: LedgerViewWriteHostState,
    correctionEntryId: string | null,
  ): LedgerDraftSlotState | null => {
    if (correctionEntryId !== null) {
      return state.corrections[correctionEntryId] ?? null;
    }
    const { composer } = state;
    if (composer.draft === null || composer.requestKey === null) return null;
    return {
      draft: composer.draft,
      saving: composer.saving,
      requestKey: composer.requestKey,
      unconfirmed: composer.unconfirmed,
      problem: composer.problem,
    };
  };

  /** One accessor lets every draft use the same send and key rules. */
  const createDraftSlot = (
    correctionEntryId: string | null,
  ): LedgerDraftSlot => ({
    correctionEntryId,
    read: (): LedgerDraftSlotState | null =>
      draftSlotState(get(), correctionEntryId),
    update: (updater): void => {
      setSlice((state) => {
        const current = draftSlotState(state, correctionEntryId);
        if (current === null) return {};
        const next = updater(current);
        if (correctionEntryId === null) {
          return { composer: { ...state.composer, ...next } };
        }
        const correction = state.corrections[correctionEntryId];
        if (correction === undefined) return {};
        return {
          // Replacing an existing key on a spread record keeps its creation
          // position; a correction never moves ahead of a later draft.
          corrections: {
            ...state.corrections,
            [correctionEntryId]: { ...correction, ...next },
          },
        };
      });
    },
  });

  const composerSlot = createDraftSlot(null);

  const removeCorrection = (entryId: string): void => {
    setSlice((state) => {
      if (state.corrections[entryId] === undefined) return {};
      const remaining = Object.fromEntries(
        Object.entries(state.corrections).filter(([key]) => key !== entryId),
      );
      return {
        corrections:
          Object.keys(remaining).length === 0
            ? EMPTY_LEDGER_VIEW_CORRECTIONS
            : remaining,
      };
    });
  };

  const loadOwners = async (): Promise<void> => {
    const generation = ++ownersGeneration;
    const view = viewGeneration;
    setSlice((state) => ({
      owners: { ...state.owners, status: 'loading', problem: null },
    }));
    const candidates: LedgerOwnerCandidate[] = [];
    let cursor: string | undefined;
    // Every page: an owner left unread could never be assigned.
    for (;;) {
      let result: LedgerViewResult<LedgerViewOwnerPage>;
      try {
        result = await client.listOwners({
          scope,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (error) {
        result = thrownResult(error);
      }
      if (generation !== ownersGeneration || view !== viewGeneration) return;
      if (result.status !== 'ok') {
        setSlice({
          owners: {
            status: 'problem',
            candidates: [],
            problem: problemOf(result),
          },
        });
        return;
      }
      candidates.push(...result.value.candidates);
      const { nextCursor } = result.value;
      if (nextCursor === null) break;
      if (nextCursor === cursor) {
        // A repeated cursor would never end: report it, never a short list.
        setSlice({
          owners: {
            status: 'problem',
            candidates: [],
            problem: { reason: 'UNKNOWN', message: '' },
          },
        });
        return;
      }
      cursor = nextCursor;
    }
    setSlice({ owners: { status: 'ready', candidates, problem: null } });
  };

  /** Shares notices, selection handling and refreshes for writes and failed preflights. */
  const finishChange = async (
    request: LedgerViewChangeRequest,
    result: LedgerViewResult<LedgerViewReceipt>,
  ): Promise<void> => {
    unanswered.delete(request.entryId);
    const reason = result.status === 'ok' ? null : result.reason;
    // A conflict or a closed entry is never replayed: the person reviews
    // the latest version first. Only a failed change can be tried again.
    const outcome: LedgerViewEntryChangeState =
      result.status === 'ok'
        ? IDLE_CHANGE
        : reason === 'REVISION_CONFLICT'
          ? { ...IDLE_CHANGE, notice: 'conflict' }
          : reason === 'TERMINAL_ENTRY'
            ? { ...IDLE_CHANGE, notice: 'closed' }
            : reason === 'OWNER_UNAVAILABLE'
              ? { ...IDLE_CHANGE, notice: 'owner_unavailable' }
              : {
                  saving: false,
                  request,
                  notice: 'failed',
                  message: problemOf(result).message,
                };
    const entryChanged =
      result.status === 'ok' ||
      outcome.notice === 'conflict' ||
      outcome.notice === 'closed';
    // How a change went belongs to its own entry. Another entry selected
    // meanwhile keeps its state: the outcome waits for its entry to be shown
    // again, and only the list catches up.
    if (get().selectedEntryId !== request.entryId) {
      if (outcome.notice !== null) outcomes.set(request.entryId, outcome);
      if (entryChanged) await context.refreshList();
      return;
    }
    setSlice({ change: outcome });
    if (result.status === 'ok') {
      await Promise.all([
        context.reloadDetail(request.entryId),
        context.refreshList(),
      ]);
    } else if (entryChanged) {
      // Read with a loading state, so a failed read is not shown as the
      // latest version.
      await Promise.all([
        context.rereadDetail(request.entryId),
        context.refreshList(),
      ]);
    } else if (outcome.notice === 'owner_unavailable') {
      await loadOwners();
    }
  };
  const sendChange = async (
    request: LedgerViewChangeRequest,
  ): Promise<void> => {
    const view = viewGeneration;
    unanswered.set(request.entryId, request);
    setSlice({
      change: { saving: true, request, notice: null, message: null },
    });
    let result: LedgerViewResult<LedgerViewReceipt>;
    try {
      result = await client.updateEntry({
        scope,
        requestKey: request.requestKey,
        params: {
          entryId: request.entryId,
          expectedRevision: request.expectedRevision,
          ...(request.status === undefined ? {} : { status: request.status }),
          ...(request.owner === undefined ? {} : { owner: request.owner }),
          ...(request.openChildren === undefined
            ? {}
            : { openChildren: request.openChildren }),
        },
      });
    } catch (error) {
      result = thrownResult(error);
    }
    if (view !== viewGeneration) return;
    await finishChange(request, result);
  };

  /** Counts open tasks under the entry before a terminal write; never closes unchecked. */
  const checkClose = async (
    request: LedgerViewChangeRequest,
    parentEntryId: string | undefined,
  ): Promise<void> => {
    const status = request.status;
    if (status === undefined) return;
    const view = viewGeneration;
    unanswered.set(request.entryId, request);
    setSlice({
      change: { saving: true, request, notice: null, message: null },
    });
    const result = await readLedgerOpenDescendants(
      client,
      scope,
      request.entryId,
      parentEntryId,
    );
    if (view !== viewGeneration) return;
    if (result.status !== 'ok') {
      uncheckedClosures.set(request.requestKey, parentEntryId ?? null);
      await finishChange(request, result);
      return;
    }
    uncheckedClosures.delete(request.requestKey);
    const { count: openCount, lowerBound } = result.value;
    if (openCount === 0) {
      await sendChange(request);
      return;
    }
    unanswered.delete(request.entryId);
    pendingClose = request;
    setSlice((state) => ({
      closeIntent: {
        entryId: request.entryId,
        status,
        openCount,
        openCountIsLowerBound: lowerBound,
      },
      ...(state.selectedEntryId === request.entryId
        ? { change: IDLE_CHANGE }
        : {}),
    }));
  };

  /**
   * The key for a draft as it now reads. Content an unconfirmed send carried
   * keeps that send's key, since the Ledger may have recorded it; other
   * content needs a key no send used.
   */
  const requestKeyFor = (
    draft: LedgerViewDraft,
    slot: LedgerDraftSlotState,
  ): string => {
    const { unconfirmed, requestKey } = slot;
    const params = serializedParams(draft);
    const sent = unconfirmed.find((send) => send.params === params);
    if (sent !== undefined) return sent.requestKey;
    return unconfirmed.some((send) => send.requestKey === requestKey)
      ? newRequestKey()
      : requestKey;
  };

  const updateDraftSlot = (
    slot: LedgerDraftSlot,
    patch: Partial<LedgerViewDraft>,
    keepSupersedes = false,
  ): void => {
    slot.update((current) => {
      const effectivePatch = keepSupersedes
        ? { ...patch, supersedes: current.draft.supersedes }
        : patch;
      const draft = applyLedgerDraftPatch(current.draft, effectivePatch);
      return {
        ...current,
        draft,
        requestKey: requestKeyFor(draft, current),
        problem: null,
      };
    });
  };

  /** The selected entry, when its detail is on screen and still open. */
  const openSelectedEntry = (): LedgerEntry | null => {
    const { selectedEntryId, detail, change } = get();
    const entry = detail.view?.entry.entry ?? null;
    if (
      change.saving ||
      selectedEntryId === null ||
      detail.status !== 'ready' ||
      entry === null ||
      entry.entryId !== selectedEntryId ||
      isLedgerTerminalStatus(entry.status)
    ) {
      return null;
    }
    return entry;
  };

  /** Selects and reads an entry unless that exact detail is already ready. */
  const selectEntryIfNeeded = async (entryId: string): Promise<void> => {
    const state = get();
    const detailEntry = state.detail.view?.entry.entry;
    if (
      state.selectedEntryId !== entryId ||
      state.detail.status !== 'ready' ||
      detailEntry?.entryId !== entryId
    ) {
      await context.select(entryId, { keepDraft: true });
    }
  };

  /**
   * Sends a composer or correction draft as it now reads. `mayRefreshOwner`
   * lets a stale owner token send once more with that owner's fresh token.
   */
  const sendDraft = async (
    slot: LedgerDraftSlot,
    mayRefreshOwner: boolean,
  ): Promise<string | null> => {
    const currentSlot = slot.read();
    if (currentSlot === null || currentSlot.saving) return null;
    const { draft, requestKey } = currentSlot;
    if (!isLedgerDraftComplete(draft)) {
      slot.update((current) => ({
        ...current,
        problem: { reason: 'INVALID_INPUT', message: 'Add content.' },
      }));
      return null;
    }
    const view = viewGeneration;
    slot.update((current) => ({ ...current, saving: true, problem: null }));
    let result: LedgerViewResult<LedgerViewReceipt>;
    try {
      result = await client.addEntry({
        scope,
        requestKey,
        params: ledgerDraftAddParams(draft),
      });
    } catch (error) {
      result = thrownResult(error);
    }
    if (view !== viewGeneration) return null;
    if (result.status === 'ok') {
      const savedEntryId = result.value.entry.entryId;
      if (slot.correctionEntryId === null) {
        // A saved new entry joins the refreshed list, but opening it is a
        // separate choice the person makes.
        const { adoptedId } = get().composer;
        setSlice({
          composer: CLOSED_COMPOSER,
          savedAdopted:
            adoptedId === null ? null : { adoptedId, entryId: savedEntryId },
        });
      } else {
        removeCorrection(slot.correctionEntryId);
      }
      await context.refreshList(savedEntryId);
      return savedEntryId;
    }
    const problem = problemOf(result);
    // The draft and its key stay, so retrying cannot record the same content
    // twice. Each slot keeps its own unconfirmed sends.
    slot.update((current) => ({
      ...current,
      saving: false,
      unconfirmed: current.unconfirmed.some(
        (send) => send.requestKey === requestKey,
      )
        ? current.unconfirmed
        : [
            ...current.unconfirmed,
            { requestKey, params: serializedParams(draft) },
          ],
      problem,
    }));
    if (problem.reason !== 'OWNER_UNAVAILABLE') return null;
    await loadOwners();
    if (view !== viewGeneration || !mayRefreshOwner) return null;
    // An eligibility token only lasts so long. When the very owner chosen
    // can still be assigned, its fresh token goes out once more. Another
    // pause of the same pipeline agent is not that owner: the explanation
    // stays, and the person chooses again.
    const chosen = draft.owner;
    const current = slot.read()?.draft ?? null;
    const fresh =
      chosen === null
        ? undefined
        : get().owners.candidates.find(
            (candidate) =>
              candidate.actor.actorId === chosen.actor.actorId &&
              isSameLedgerPipelinePause(
                candidate.pipelineAgent,
                chosen.pipelineAgent,
              ),
          );
    if (
      fresh === undefined ||
      fresh.eligibilityToken === chosen?.eligibilityToken ||
      current === null ||
      current.owner?.actor.actorId !== fresh.actor.actorId
    ) {
      return null;
    }
    if (slot.correctionEntryId === null) {
      get().updateDraft({ owner: fresh });
    } else {
      get().updateCorrection(slot.correctionEntryId, { owner: fresh });
    }
    return sendDraft(slot, false);
  };

  const slice: LedgerViewWriteSlice = {
    composer: CLOSED_COMPOSER,
    corrections: EMPTY_LEDGER_VIEW_CORRECTIONS,
    owners: IDLE_OWNERS,
    change: IDLE_CHANGE,
    closeIntent: null,
    savedAdopted: null,
    startEntry: (): void => {
      setSlice((state) =>
        state.composer.draft === null
          ? {
              composer: {
                ...CLOSED_COMPOSER,
                draft: blankLedgerViewDraft('TASK'),
                shown: true,
                requestKey: newRequestKey(),
              },
            }
          : { composer: { ...state.composer, shown: true } },
      );
    },
    startCorrection: (entry): void => {
      if (get().corrections[entry.entryId] !== undefined) return;
      const type = isPublicType(entry.type) ? entry.type : 'OBSERVATION';
      setSlice((state) => ({
        corrections: {
          ...state.corrections,
          [entry.entryId]: {
            draft: {
              ...blankLedgerViewDraft(type),
              title: entry.title,
              supersedes: { entryId: entry.entryId, title: entry.title },
            },
            saving: false,
            requestKey: newRequestKey(),
            unconfirmed: [],
            problem: null,
          },
        },
      }));
    },
    updateCorrection: (entryId, patch): void => {
      const slot = createDraftSlot(entryId);
      const current = slot.read();
      if (current === null || current.saving) return;
      updateDraftSlot(slot, patch, true);
    },
    submitCorrection: (entryId): Promise<string | null> =>
      sendDraft(createDraftSlot(entryId), true),
    cancelCorrection: (entryId): void => {
      const correction = get().corrections[entryId];
      if (correction === undefined || correction.saving) return;
      removeCorrection(entryId);
    },
    adoptDraft: (draft, adoptedId): boolean => {
      if (get().composer.draft !== null) return false;
      setSlice({
        composer: {
          ...CLOSED_COMPOSER,
          draft,
          shown: true,
          requestKey: newRequestKey(),
          adoptedId,
        },
      });
      return true;
    },
    releaseDraft: (): LedgerViewDraft | null => {
      const { composer } = get();
      if (!ledgerDraftMovable(composer)) return null;
      setSlice({ composer: CLOSED_COMPOSER });
      return composer.draft;
    },
    updateDraft: (patch): void => {
      const current = composerSlot.read();
      if (current === null || current.saving) return;
      updateDraftSlot(composerSlot, patch);
    },
    hideDraft: (): void => {
      setSlice((state) => ({ composer: { ...state.composer, shown: false } }));
    },
    discardDraft: (): void => {
      if (get().composer.saving) return;
      setSlice({ composer: CLOSED_COMPOSER });
    },
    submitDraft: async (): Promise<void> => {
      await sendDraft(composerSlot, true);
    },
    loadOwners,
    changeStatus: async (status): Promise<void> => {
      const entry = openSelectedEntry();
      if (entry === null || entry.status === status) return;
      // A later change replaces a close choice nobody answered, which a
      // surface without the prompt could otherwise leave in the way.
      if (get().closeIntent !== null) {
        pendingClose = null;
        setSlice({ closeIntent: null });
      }
      const request: LedgerViewChangeRequest = {
        entryId: entry.entryId,
        requestKey: newRequestKey(),
        expectedRevision: entry.revision,
        status,
      };
      if (
        (entry.type === 'OPERATION' || entry.type === 'TASK') &&
        isLedgerTerminalStatus(status)
      ) {
        await checkClose(request, entry.parentEntryId);
      } else {
        await sendChange(request);
      }
    },
    resolveCloseIntent: async (choice): Promise<void> => {
      const request = pendingClose;
      pendingClose = null;
      setSlice({ closeIntent: null });
      if (choice === 'cancel' || request === null) return;
      await sendChange({ ...request, openChildren: choice });
    },
    assignOwner: async (owner): Promise<void> => {
      const entry = openSelectedEntry();
      if (entry === null) return;
      if (owner === null || owner.isSelf) {
        await sendChange({
          entryId: entry.entryId,
          requestKey: newRequestKey(),
          expectedRevision: entry.revision,
          owner: 'self',
        });
        return;
      }
      if (owner.actor.actorId === entry.owner.actorId) return;
      await sendChange({
        entryId: entry.entryId,
        requestKey: newRequestKey(),
        expectedRevision: entry.revision,
        owner: {
          actorId: owner.actor.actorId,
          eligibilityToken: owner.eligibilityToken,
        },
      });
    },
    changeStatusOf: async (entryId, status): Promise<void> => {
      await selectEntryIfNeeded(entryId);
      const selected = get();
      if (
        selected.selectedEntryId !== entryId ||
        selected.detail.status !== 'ready' ||
        selected.detail.view?.entry.entry.entryId !== entryId
      ) {
        return;
      }
      // Use the selected-entry action so its existing guards and write shape
      // remain the single path for status changes.
      await get().changeStatus(status);
    },
    assignOwnerOf: async (entryId, owner): Promise<void> => {
      await selectEntryIfNeeded(entryId);
      const selected = get();
      if (
        selected.selectedEntryId !== entryId ||
        selected.detail.status !== 'ready' ||
        selected.detail.view?.entry.entry.entryId !== entryId
      ) {
        return;
      }
      // Use the selected-entry action so its existing guards and write shape
      // remain the single path for owner changes.
      await get().assignOwner(owner);
    },
    retryChange: async (): Promise<void> => {
      const { change } = get();
      if (
        change.saving ||
        change.notice !== 'failed' ||
        change.request === null
      ) {
        return;
      }
      const parentEntryId = uncheckedClosures.get(change.request.requestKey);
      if (parentEntryId !== undefined) {
        await checkClose(change.request, parentEntryId ?? undefined);
      } else {
        await sendChange(change.request);
      }
    },
    dismissChangeNotice: (): void => {
      setSlice((state) => (state.change.saving ? {} : { change: IDLE_CHANGE }));
    },
  };
  return {
    slice,
    changeFor: (entryId): LedgerViewEntryChangeState => {
      if (entryId === null) return IDLE_CHANGE;
      const request = unanswered.get(entryId);
      if (request !== undefined) {
        return { saving: true, request, notice: null, message: null };
      }
      const outcome = outcomes.get(entryId);
      outcomes.delete(entryId);
      return outcome ?? IDLE_CHANGE;
    },
    reset: (): void => {
      viewGeneration += 1;
      ownersGeneration += 1;
      unanswered.clear();
      pendingClose = null;
      uncheckedClosures.clear();
      outcomes.clear();
    },
  };
}
