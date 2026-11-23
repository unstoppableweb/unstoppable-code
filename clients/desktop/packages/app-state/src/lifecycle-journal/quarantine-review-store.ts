import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import type {
  LifecycleJournalInspection,
  LifecycleJournalQuarantineResult,
  LifecycleJournalUnreadableEntry,
} from '@canopy/protocol/remote-control/shell/lifecycle-journal';
import { isHostRecordedFailure } from '../host-recorded-failure';

/**
 * CAN-5335: the review a deletion or archive refusal opens when an unreadable
 * destructive lifecycle journal entry, or its unlistable folder, refused it.
 * Loaded with the review; refusal surfaces use `quarantine-offer` only.
 */
export type LifecycleJournalQuarantineView =
  | { readonly phase: 'closed' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed'; readonly message: string }
  /** Moved, but the re-read failed: only a fresh check is offered. */
  | {
      readonly phase: 'moved-unchecked';
      readonly moved: LifecycleJournalQuarantineResult;
    }
  | {
      readonly phase: 'inspected';
      readonly inspection: LifecycleJournalInspection;
      readonly moving: boolean;
      readonly moveError: string | null;
      /** The host already recorded the failure behind `moveError`. */
      readonly moveRecorded: boolean;
      readonly moved: LifecycleJournalQuarantineResult | null;
    };

export interface LifecycleJournalQuarantineState {
  readonly view: LifecycleJournalQuarantineView;
  readonly open: () => Promise<void>;
  readonly quarantine: (
    entry: LifecycleJournalUnreadableEntry,
  ) => Promise<void>;
  readonly close: () => void;
}

export type LifecycleJournalQuarantineStore = UseBoundStore<
  StoreApi<LifecycleJournalQuarantineState>
>;

const INSPECT_FAILED = "Couldn't review the operation records. Try again.";
const MOVE_FAILED =
  "Couldn't move the record. It's still where it was. Try again.";

/** Electron wraps IPC rejections as `Error invoking remote method '…': Class: text`. */
function failureText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : '';
  const text = raw
    .replace(/^error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(?:error|[a-z][a-z0-9_]*error):\s*/i, '')
    .trim();
  return text || fallback;
}

function createLifecycleJournalQuarantineStore(
  client: CanopyClient,
): LifecycleJournalQuarantineStore {
  // Each opening owns its results; a late answer to an older one is dropped.
  let generation = 0;
  return create<LifecycleJournalQuarantineState>()((set, get) => {
    const inspect = async (current: number): Promise<void> => {
      try {
        const inspection = await client.command('lifecycleJournal.inspect', {});
        if (current !== generation) return;
        set({
          view: {
            phase: 'inspected',
            inspection,
            moving: false,
            moveError: null,
            moveRecorded: false,
            moved: null,
          },
        });
      } catch (error) {
        if (current !== generation) return;
        set({
          view: {
            phase: 'failed',
            message: failureText(error, INSPECT_FAILED),
          },
        });
      }
    };
    /**
     * Re-reads after a move attempt, so a retry confirms what is there now.
     * A failed read shows `unread`, never the reviewed identity again.
     */
    const reread = async (
      current: number,
      next: (
        inspection: LifecycleJournalInspection,
      ) => LifecycleJournalQuarantineView,
      unread: LifecycleJournalQuarantineView,
    ): Promise<void> => {
      const inspection = await client
        .command('lifecycleJournal.inspect', {})
        .catch(() => null);
      if (current !== generation) return;
      set({ view: inspection ? next(inspection) : unread });
    };
    return {
      view: { phase: 'closed' },
      open: (): Promise<void> => {
        generation += 1;
        set({ view: { phase: 'loading' } });
        return inspect(generation);
      },
      quarantine: async (entry): Promise<void> => {
        const view = get().view;
        if (view.phase !== 'inspected' || view.moving) return;
        const current = generation;
        set({
          view: { ...view, moving: true, moveError: null, moveRecorded: false },
        });
        let moved: LifecycleJournalQuarantineResult;
        try {
          moved = await client.command('lifecycleJournal.quarantine', {
            name: entry.name,
            identity: entry.identity,
          });
        } catch (error) {
          if (current !== generation) return;
          const moveError = failureText(error, MOVE_FAILED);
          // An unconfirmed move may already have renamed the entry.
          await reread(
            current,
            (inspection) => ({
              ...view,
              inspection,
              moving: false,
              moveError,
              moveRecorded: isHostRecordedFailure(error),
            }),
            { phase: 'failed', message: moveError },
          );
          return;
        }
        if (current !== generation) return;
        // Another entry may still refuse, or none is left.
        await reread(
          current,
          (inspection) => ({
            phase: 'inspected',
            inspection,
            moving: false,
            moveError: null,
            moveRecorded: false,
            moved,
          }),
          { phase: 'moved-unchecked', moved },
        );
      },
      close: (): void => {
        generation += 1;
        set({ view: { phase: 'closed' } });
      },
    };
  });
}

const storesByClient = new WeakMap<
  CanopyClient,
  LifecycleJournalQuarantineStore
>();

/** One review per client, opened from any deletion or archive surface. */
export function lifecycleJournalQuarantineStoreFor(
  client: CanopyClient,
): LifecycleJournalQuarantineStore {
  const existing = storesByClient.get(client);
  if (existing) return existing;
  const store = createLifecycleJournalQuarantineStore(client);
  storesByClient.set(client, store);
  return store;
}
