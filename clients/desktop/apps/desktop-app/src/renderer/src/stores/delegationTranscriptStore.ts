/**
 * Child transcripts of delegated agent runs whose cards keep them in the
 * parent chat's delegate log (`transcriptStore: 'chat-log-v1'`).
 *
 * Such a card is the run's only row in the committed transcript, so its
 * children and live progress come from here: live snapshots main pushes on
 * `chat:event` (never committed), and, for a run with no live snapshot in
 * this session, the delegate log read once when its card mounts. Live
 * snapshots alternate whole transcripts with patches of changed items
 * (`transcriptMode: 'patch'`), merged here by item id; a patch for a run whose
 * earlier items this window never saw reads the delegate log to fill them in.
 * Active cards in the current chat also read their existing snapshot endpoint
 * once after reconnect; a delegate log contains items, not live card progress.
 *
 * Bounded: the least recently used runs no mounted card holds are forgotten
 * beyond {@link DELEGATION_TRANSCRIPT_RUN_LIMIT}; a card mounted again reads
 * its log.
 */
import { create } from 'zustand';
import {
  DELEGATION_TRANSCRIPT_CHAT_LOG,
  type AgentDelegationSnapshot,
  type AgentDelegationTranscript,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
// Type only: the chat store must not load the shared UI package at runtime.
import type { ManagedDelegationProgress } from '@canopy/ui-app';
import { isWebCoreScope } from '@/lib/chat-authority';

export const DELEGATION_TRANSCRIPT_RUN_LIMIT = 48;

/** Where a run's card is rendered, and so where its delegate log lives. */
export interface DelegationTranscriptSource {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly archivedContainerId?: string;
  readonly standaloneHistory?: boolean;
}

export interface DelegationRunEntry {
  /** The newest live snapshot this session (card fields and items). */
  readonly live?: AgentDelegationTranscript;
  /** Newest stream-backed card progress, never child transcript items. */
  readonly streamProgress?: ManagedDelegationProgress & {
    readonly sequence: number;
    readonly arrivalStamp: number;
  };
  /** Snapshot endpoint progress, ordered against live frame arrival. */
  readonly streamHydrated?: {
    readonly progress: ManagedDelegationProgress;
    readonly requestArrivalStamp: number;
  };
  /** Current card fields read once after reconnect, never child-log items. */
  readonly hydrated?: {
    readonly snapshot: AgentDelegationSnapshot;
    readonly revision: number;
  };
  readonly snapshotRequested?: boolean;
  /** `live` holds only patched items until the delegate log is read. */
  readonly partial?: boolean;
  /** Items read from the delegate log. */
  readonly logged?: readonly AgentDelegationTranscriptItem[];
  readonly loading?: boolean;
  readonly failed?: boolean;
}

interface DelegationTranscriptState {
  runs: Readonly<Record<string, DelegationRunEntry>>;
  /** Least recently used first. */
  order: readonly string[];
  applyLive: (
    target: Pick<
      DelegationTranscriptSource,
      'projectId' | 'worktreeId' | 'chatId'
    >,
    transcript: AgentDelegationTranscript,
  ) => void;
  /** Reads the run's delegate log unless it is known or being read. */
  load: (
    source: DelegationTranscriptSource,
    run: { delegationId: string; runGeneration: number },
  ) => void;
  /** Bootstraps current card progress without touching archived/history copies. */
  hydrateCurrent: (
    source: DelegationTranscriptSource,
    run: {
      delegationId: string;
      runGeneration: number;
      transcriptStore?: string;
    },
  ) => void;
  reset: () => void;
}

/**
 * An archived or standalone-history copy of a chat keeps its own delegate
 * log under the same chat id, so the copy is part of the key.
 */
export function delegationRunKey(
  source: Pick<
    DelegationTranscriptSource,
    'projectId' | 'worktreeId' | 'chatId'
  > &
    Partial<
      Pick<
        DelegationTranscriptSource,
        'archivedContainerId' | 'standaloneHistory'
      >
    >,
  run: { delegationId: string; runGeneration: number },
): string {
  const copy = source.archivedContainerId
    ? `archive:${source.archivedContainerId}`
    : source.standaloneHistory
      ? 'history'
      : 'live';
  return `${copy}/${source.projectId}/${source.worktreeId}/${source.chatId}/${run.delegationId}:${String(run.runGeneration)}`;
}

/** `updates` over `base` by item id, in transcript order. */
function mergeItems(
  base: readonly AgentDelegationTranscriptItem[],
  updates: readonly AgentDelegationTranscriptItem[],
): AgentDelegationTranscriptItem[] {
  const byId = new Map(base.map((item) => [item.id, item]));
  for (const item of updates) byId.set(item.id, item);
  return Array.from(byId.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

/** Mounted cards per run key: a held run is never evicted. */
const heldRuns = new Map<string, number>();

/**
 * Same rule as `isStreamBackedDelegation` in `@canopy/ui-app`: an unknown
 * store marker is not a delegate log, so it never reads one.
 */
function isStreamBackedDelegation(
  transcriptStore: string | undefined,
): boolean {
  return (
    transcriptStore !== undefined &&
    transcriptStore !== DELEGATION_TRANSCRIPT_CHAT_LOG
  );
}

/** Shared arrival order for stream frames and snapshot requests. */
let arrivalCounter = 0;

function nextArrivalStamp(): number {
  arrivalCounter += 1;
  return arrivalCounter;
}

function progressFromSnapshot(
  snapshot: AgentDelegationSnapshot,
  runGeneration: number,
): ManagedDelegationProgress {
  return {
    runGeneration,
    status: snapshot.status,
    ...(snapshot.phase === undefined ? {} : { phase: snapshot.phase }),
    ...(snapshot.queue === undefined ? {} : { queue: snapshot.queue }),
    ...(snapshot.approvalPending === undefined
      ? {}
      : { approvalPending: snapshot.approvalPending }),
  };
}

/** Holds a run's entry while a card shows it; returns the release. */
export function holdDelegationRun(key: string): () => void {
  heldRuns.set(key, (heldRuns.get(key) ?? 0) + 1);
  return () => {
    const count = (heldRuns.get(key) ?? 1) - 1;
    if (count > 0) heldRuns.set(key, count);
    else heldRuns.delete(key);
  };
}

function touch(
  state: Pick<DelegationTranscriptState, 'runs' | 'order'>,
  key: string,
  entry: DelegationRunEntry,
): Pick<DelegationTranscriptState, 'runs' | 'order'> {
  const order = [...state.order.filter((candidate) => candidate !== key), key];
  const runs: Record<string, DelegationRunEntry> = {
    ...state.runs,
    [key]: entry,
  };
  // Least recently used first, skipping runs a mounted card shows: more
  // mounted cards than the limit keep every one of them.
  for (
    let index = 0;
    order.length > DELEGATION_TRANSCRIPT_RUN_LIMIT && index < order.length;
  ) {
    const candidate = order[index];
    if (candidate === undefined || heldRuns.has(candidate)) {
      index += 1;
      continue;
    }
    order.splice(index, 1);
    delete runs[candidate];
  }
  return { runs, order };
}

export const useDelegationTranscriptStore = create<DelegationTranscriptState>(
  (set, get) => ({
    runs: {},
    order: [],
    applyLive: (target, transcript): void => {
      if (isStreamBackedDelegation(transcript.transcriptStore)) {
        if (
          transcript.snapshot.delegationId !== transcript.delegationId ||
          (transcript.snapshot.runGeneration !== undefined &&
            transcript.snapshot.runGeneration !== transcript.runGeneration)
        )
          return;
        const key = delegationRunKey(target, transcript);
        const arrivalStamp = nextArrivalStamp();
        set((state) => {
          const entry = state.runs[key];
          const previous = entry?.streamProgress;
          if (previous && previous.sequence >= transcript.sequence)
            return state;
          return touch(state, key, {
            ...entry,
            streamProgress: {
              ...progressFromSnapshot(
                transcript.snapshot,
                transcript.runGeneration,
              ),
              sequence: transcript.sequence,
              arrivalStamp,
            },
          });
        });
        return;
      }
      if (transcript.transcriptStore !== DELEGATION_TRANSCRIPT_CHAT_LOG) return;
      const key = delegationRunKey(target, transcript);
      let readLog = false;
      set((state) => {
        const entry = state.runs[key];
        const previous = entry?.live;
        // An equal-sequence whole frame is main's catch-up keyframe for a
        // window that missed patches and merged later ones over stale items.
        if (
          previous &&
          (previous.sequence > transcript.sequence ||
            (previous.sequence === transcript.sequence &&
              transcript.transcriptMode === 'patch'))
        )
          return state;
        if (transcript.transcriptMode !== 'patch')
          return touch(state, key, {
            ...entry,
            live: transcript,
            partial: false,
          });
        // A patch carries only changed items (none for a card-only patch).
        const base = previous?.transcript ?? entry?.logged;
        readLog = base === undefined;
        return touch(state, key, {
          ...entry,
          live: {
            ...transcript,
            transcript: mergeItems(base ?? [], transcript.transcript),
          },
          partial: entry?.partial === true || base === undefined,
        });
      });
      if (readLog) get().load(target, transcript);
    },
    hydrateCurrent: (source, run): void => {
      if (source.archivedContainerId || source.standaloneHistory) return;
      // A cloud chat's delegates read through the window's transcript reads,
      // never this computer's delegation service (CAN-7027).
      if (isWebCoreScope(source.projectId)) return;
      const key = delegationRunKey(source, run);
      const streamBacked = isStreamBackedDelegation(run.transcriptStore);
      const entry = get().runs[key];
      if (entry?.snapshotRequested || (!streamBacked && entry?.live)) return;
      set((state) =>
        touch(state, key, { ...state.runs[key], snapshotRequested: true }),
      );
      void Promise.resolve()
        .then(() => {
          const requestArrivalStamp = nextArrivalStamp();
          return window.api.managedDelegation
            .transcriptPage({
              projectId: source.projectId,
              worktreeId: source.worktreeId,
              chatId: source.chatId,
              delegationId: run.delegationId,
              runGeneration: run.runGeneration,
            })
            .then((result) => ({ result, requestArrivalStamp }));
        })
        .then(
          ({ result, requestArrivalStamp }) => {
            if (
              !result.ok ||
              result.runGeneration !== run.runGeneration ||
              result.snapshot.delegationId !== run.delegationId ||
              (result.snapshot.runGeneration !== undefined &&
                result.snapshot.runGeneration !== run.runGeneration)
            )
              return;
            set((state) => {
              const current = state.runs[key];
              if (
                streamBacked &&
                current?.streamProgress &&
                current.streamProgress.arrivalStamp > requestArrivalStamp
              )
                return state;
              // Live delivery wins over a read started before it, including
              // equal revisions whose queue details may have changed.
              if (
                !current ||
                (!streamBacked && current.live) ||
                (current.hydrated &&
                  current.hydrated.revision >= result.revision)
              )
                return state;
              if (streamBacked)
                return touch(state, key, {
                  ...current,
                  streamHydrated: {
                    progress: progressFromSnapshot(
                      result.snapshot,
                      run.runGeneration,
                    ),
                    requestArrivalStamp,
                  },
                });
              return touch(state, key, {
                ...current,
                hydrated: {
                  snapshot: result.snapshot,
                  revision: result.revision,
                },
              });
            });
          },
          () => undefined,
        );
    },
    load: (source, run): void => {
      if (isWebCoreScope(source.projectId)) return;
      const key = delegationRunKey(source, run);
      const entry = get().runs[key];
      if (
        entry &&
        (entry.logged || entry.loading || (entry.live && !entry.partial))
      )
        return;
      set((state) => touch(state, key, { ...state.runs[key], loading: true }));
      const settle = (next: DelegationRunEntry): void => {
        set((state) => {
          const current = state.runs[key];
          if (current?.live) {
            // A whole live snapshot that arrived meanwhile is newer than the
            // log; patched items are newer than their logged versions.
            if (!current.partial || !next.logged)
              return touch(state, key, { ...current, loading: false });
            return touch(state, key, {
              ...current,
              logged: next.logged,
              loading: false,
              partial: false,
              live: {
                ...current.live,
                transcript: mergeItems(next.logged, current.live.transcript),
              },
            });
          }
          return touch(state, key, { ...current, ...next, loading: false });
        });
      };
      void window.api.managedDelegation
        .transcript({
          projectId: source.projectId,
          worktreeId: source.worktreeId,
          chatId: source.chatId,
          delegationId: run.delegationId,
          runGeneration: run.runGeneration,
          ...(source.archivedContainerId
            ? { archivedContainerId: source.archivedContainerId }
            : {}),
          ...(source.standaloneHistory ? { standaloneHistory: true } : {}),
        })
        .then(
          (result) => {
            settle(result.ok ? { logged: result.items } : { failed: true });
          },
          () => {
            settle({ failed: true });
          },
        );
    },
    reset: (): void => {
      set({ runs: {}, order: [] });
    },
  }),
);
