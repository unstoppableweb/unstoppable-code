import type {
  WorktreeRecoveryFinishResult,
  WorktreeRecoveryResolveResult,
  WorktreeRecoverySetAsideParams,
  WorktreeRecoverySetAsideResult,
} from '@canopy/protocol/canopy-core';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardRefusal,
  WorktreeDiscardResult,
} from '@canopy/protocol/remote-control/shell/worktree-discard';
import type { WorktreeDiscardOffer } from './discard-offer';
import { WorktreeRecoveryDescriptionSchema } from '@canopy/protocol/remote-control/shell/worktree-discard-schemas';
import {
  unavailableWorktreeRecovery,
  worktreeRecoveryOfferedActions,
  worktreeRecoveryResolutionAction,
  type WorktreeRecoveryDescription,
} from '@canopy/protocol/remote-control/shell/worktree-recovery';
import { isHostRecordedFailure } from '../host-recorded-failure';
import { worktreeRecoveryHostOutdatedMessage } from './host-outdated';
import { offerLifecycleJournalQuarantine } from '../lifecycle-journal/quarantine-offer';

/**
 * Why the last discard attempt didn't finish. Reason codes only: the shared
 * UI owns the copy. `failed` carries the transport's own message.
 */
export type WorktreeDiscardAttemptError =
  | { readonly kind: 'refused'; readonly reason: WorktreeDiscardRefusal }
  | { readonly kind: 'changed' }
  | {
      readonly kind: 'failed';
      readonly message: string | null;
      /** The host already recorded this failure. */
      readonly recorded?: true;
    };

/** A finished discard's report for the host's own cleanup. */
interface WorktreeDiscardFinished {
  readonly expectedCreatedAt?: string;
  readonly warnings: string[];
  /** CAN-5338: a retained archive was discarded; no row was listed. */
  readonly retainedArchive?: true;
  /** The temporary project the discard left empty and removed. */
  readonly removedTemporaryWorkspaceId?: string;
}

/** CAN-5336: the discard confirmation one client shows at a time. */
export type WorktreeDiscardView =
  | { readonly phase: 'closed' }
  | { readonly phase: 'describing'; readonly offer: WorktreeDiscardOffer }
  | {
      readonly phase: 'recovery';
      readonly offer: WorktreeDiscardOffer;
      readonly recovery: WorktreeRecoveryDescription;
      /** Keeps Check again bound after an unconfirmed action withdraws diagnosis. */
      readonly reviewedOperationId?: string;
      readonly busy:
        | 'refresh'
        | 'retry'
        | 'finishArchive'
        | 'discard'
        | 'keepWorktree'
        | 'release'
        | 'setAside'
        | null;
      readonly outcome?:
        | WorktreeRecoveryFinishResult
        | WorktreeRecoveryResolveResult
        | WorktreeRecoverySetAsideResult;
      readonly error: 'transport-failed' | 'unconfirmed' | null;
      readonly unconfirmedAction?:
        | 'keep-worktree'
        | 'release'
        | 'finish'
        | 'set-aside';
      /** An older computer refused the action; the reviewed recovery is kept. */
      readonly hostOutdated?: string;
    }
  | {
      readonly phase: 'open';
      readonly offer: WorktreeDiscardOffer;
      readonly description: WorktreeDiscardDescription;
      readonly busy: boolean;
      readonly error: WorktreeDiscardAttemptError | null;
    };

export interface WorktreeDiscardState {
  /** A composite client must never send this computer's work to its next target. */
  readonly isCurrentComputer: () => boolean;
  readonly view: WorktreeDiscardView;
  /** Kept for this computer until explicit dismissal, including across detach. */
  readonly setAsideResult: WorktreeRecoverySetAsideResult | null;
  /**
   * Opens `offer`, describing it first when it came without a description.
   * Resolves `false`, and stays closed, when nothing can be discarded: the
   * host then shows the refusal's own message.
   */
  readonly open: (offer: WorktreeDiscardOffer) => Promise<boolean>;
  /** Resolves with what a finished discard reports to its host, or `null`. */
  readonly discard: () => Promise<WorktreeDiscardFinished | null>;
  /**
   * Closes the dialog and runs the ordinary removal again, unless
   * `worktreeRemovalRetryable` says that removal isn't the way back.
   */
  readonly retry: () => void;
  readonly recover: (
    action: 'retry' | 'finishArchive' | 'keepWorktree' | 'release',
  ) => Promise<WorktreeDiscardFinished | null>;
  readonly confirmDiscard: () => Promise<void>;
  /** CAN-7014: runs after the dialog's own confirmation; never a removal. */
  readonly setAside: (target: WorktreeRecoverySetAsideParams) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly deactivate: () => void;
  readonly close: () => void;
}

export type WorktreeDiscardStore = UseBoundStore<
  StoreApi<WorktreeDiscardState>
>;

/**
 * Whether Retry may run the offer's ordinary removal again. Not when the
 * refusal points at the project's deletion: that, not this removal, is the
 * way back (CAN-4995 E).
 */
export function worktreeRemovalRetryable(view: WorktreeDiscardView): boolean {
  if (view.phase === 'closed') return false;
  if (view.phase === 'describing') return view.offer.retry !== undefined;
  if (view.phase === 'recovery') return view.recovery.actions.retry.eligible;
  if (view.offer.recovery || !view.offer.retry) return false;
  const refusal = view.description.refusal;
  return (
    refusal?.retry !== 'delete-project' &&
    refusal?.reason !== 'project-deletion-pending'
  );
}

/**
 * CAN-5338: a description of a retained archive, which only a host that
 * received `retainedArchives` returns. Its discard sends the opt-in too, so no
 * caller has to remember it.
 */
export function describesRetainedArchive(
  description: WorktreeDiscardDescription,
): boolean {
  return description.targets.some(
    (target) => target.kind === 'retained-archive',
  );
}

/** Electron wraps IPC rejections as `Error invoking remote method '…': Class: text`. */
export function failureText(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : '';
  const text = raw
    .replace(/^error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(?:error|[a-z][a-z0-9_]*error):\s*/i, '')
    .trim();
  return text || null;
}

/** The `failed` attempt error for a rejected command. */
export function failedAttempt(error: unknown): {
  readonly kind: 'failed';
  readonly message: string | null;
  readonly recorded?: true;
} {
  return {
    kind: 'failed',
    message: failureText(error),
    ...(isHostRecordedFailure(error) ? { recorded: true as const } : {}),
  };
}

function sameRecoverySubject(
  description: WorktreeDiscardDescription | undefined,
  recovery: WorktreeRecoveryDescription,
): boolean {
  return (
    description?.workspaceId === recovery.subject.workspaceId &&
    description.worktreeId === recovery.subject.worktreeId &&
    description.createdAt === recovery.subject.createdAt
  );
}

function createWorktreeDiscardStore(
  client: CanopyClient,
  isCurrentComputer: () => boolean,
): WorktreeDiscardStore {
  // Each opening owns its answers; a late answer to an older one is dropped.
  let generation = 0;
  return create<WorktreeDiscardState>()((set, get) => {
    const unavailable = (
      view: Extract<WorktreeDiscardView, { phase: 'recovery' }>,
    ): WorktreeRecoveryDescription =>
      unavailableWorktreeRecovery(
        view.recovery.subject,
        {
          intent: view.recovery.intent,
          expectedCreatedAt: view.recovery.subject.createdAt,
        },
        'refresh-unavailable',
      );
    const inspect = async (
      view: Extract<WorktreeDiscardView, { phase: 'recovery' }>,
    ): Promise<{
      readonly description?: WorktreeDiscardDescription;
      readonly hostOutdated: string | null;
    }> => {
      const operationId =
        view.recovery.diagnosis?.operationId ?? view.reviewedOperationId;
      return client
        .command('worktree.discard.describe', {
          workspaceId: view.offer.workspaceId,
          worktreeId: view.offer.worktreeId,
          recovery: {
            intent: view.recovery.intent,
            expectedCreatedAt: view.recovery.subject.createdAt,
            ...(operationId ? { operationId } : {}),
          },
        })
        .then(
          (description) => ({ description, hostOutdated: null }),
          (error: unknown) => ({
            hostOutdated: worktreeRecoveryHostOutdatedMessage(error),
          }),
        );
    };
    const admitted = (
      view: Extract<WorktreeDiscardView, { phase: 'recovery' }>,
      value: unknown,
    ): WorktreeRecoveryDescription => {
      const parsed = WorktreeRecoveryDescriptionSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.subject.workspaceId !== view.offer.workspaceId ||
        parsed.data.subject.worktreeId !== view.offer.worktreeId ||
        parsed.data.subject.createdAt !== view.recovery.subject.createdAt ||
        parsed.data.intent !== view.recovery.intent
      )
        return unavailable(view);
      return parsed.data;
    };
    const routeReview = (recovery: WorktreeRecoveryDescription): boolean => {
      if (
        get().setAsideResult ||
        recovery.destination.kind !== 'journal-review'
      )
        return false;
      offerLifecycleJournalQuarantine(undefined, recovery.destination.reason);
      set({ view: { phase: 'closed' } });
      return true;
    };
    return {
      isCurrentComputer,
      view: { phase: 'closed' },
      setAsideResult: null,
      open: async (offer): Promise<boolean> => {
        if (!isCurrentComputer()) return false;
        // Running actions and undismissed Set aside results keep their dialog.
        const showing = get().view;
        if (
          ((showing.phase === 'open' || showing.phase === 'recovery') &&
            showing.busy) ||
          get().setAsideResult
        )
          return false;
        generation += 1;
        const current = generation;
        if (offer.recovery) {
          if (client.capabilities.worktreeRecovery !== true) return false;
          const initial: Extract<WorktreeDiscardView, { phase: 'recovery' }> = {
            phase: 'recovery',
            offer,
            recovery: offer.recovery,
            busy: null,
            error: null,
          };
          const recovery = admitted(initial, offer.recovery);
          if (routeReview(recovery)) return true;
          set({ view: { ...initial, recovery } });
          return true;
        }
        let description = offer.description;
        if (!description) {
          set({ view: { phase: 'describing', offer } });
          description = await client
            .command('worktree.discard.describe', {
              workspaceId: offer.workspaceId,
              worktreeId: offer.worktreeId,
              ...(offer.retainedArchives === true
                ? { retainedArchives: true }
                : {}),
            })
            .catch(() => undefined);
          if (current !== generation) return false;
        }
        if (description?.status !== 'discardable') {
          set({ view: { phase: 'closed' } });
          return false;
        }
        set({
          view: { phase: 'open', offer, description, busy: false, error: null },
        });
        return true;
      },
      discard: async (): Promise<WorktreeDiscardFinished | null> => {
        if (!isCurrentComputer()) return null;
        const view = get().view;
        if (view.phase !== 'open' || view.busy) return null;
        if (view.description.status !== 'discardable') return null;
        const current = generation;
        set({ view: { ...view, busy: true, error: null } });
        const retainedArchive = describesRetainedArchive(view.description);
        let result: WorktreeDiscardResult;
        try {
          result = await client.command('worktree.discard', {
            workspaceId: view.offer.workspaceId,
            worktreeId: view.offer.worktreeId,
            confirmation: view.description.confirmation,
            ...(retainedArchive ? { retainedArchives: true } : {}),
          });
        } catch (error) {
          if (current === generation)
            set({
              view: {
                ...view,
                busy: false,
                error: failedAttempt(error),
              },
            });
          return null;
        }
        if (current !== generation) return null;
        if (result.status === 'discarded') {
          generation += 1;
          set({ view: { phase: 'closed' } });
          return {
            warnings: result.warnings,
            ...(view.offer.recovery?.subject.createdAt
              ? { expectedCreatedAt: view.offer.recovery.subject.createdAt }
              : {}),
            ...(retainedArchive ? { retainedArchive: true } : {}),
            ...(result.removedTemporaryWorkspaceId
              ? {
                  removedTemporaryWorkspaceId:
                    result.removedTemporaryWorkspaceId,
                }
              : {}),
          };
        }
        if (
          view.offer.recovery &&
          (result.description.status !== 'discardable' ||
            !sameRecoverySubject(result.description, view.offer.recovery))
        ) {
          const previous: Extract<WorktreeDiscardView, { phase: 'recovery' }> =
            {
              phase: 'recovery',
              offer: view.offer,
              recovery: view.offer.recovery,
              busy: null,
              error: null,
            };
          if (!sameRecoverySubject(result.description, previous.recovery)) {
            // A token for a replacement is never a continuation of this offer.
            set({ view: { ...previous, recovery: unavailable(previous) } });
            return null;
          }
          const { description } = await inspect(previous);
          if (current !== generation) return null;
          const recovery = admitted(
            previous,
            sameRecoverySubject(description, previous.recovery)
              ? description?.recovery
              : undefined,
          );
          if (!routeReview(recovery)) set({ view: { ...previous, recovery } });
          return null;
        }
        // The new description replaces the reviewed one; confirming again is
        // the user's choice, never automatic.
        set({
          view: {
            ...view,
            description: result.description,
            busy: false,
            error:
              result.reason === 'changed'
                ? { kind: 'changed' }
                : { kind: 'refused', reason: result.reason },
          },
        });
        return null;
      },
      refresh: async (): Promise<void> => {
        if (!isCurrentComputer()) return;
        const view = get().view;
        if (view.phase !== 'recovery' || view.busy) return;
        const current = generation;
        set({
          view: {
            ...view,
            busy: 'refresh',
            outcome: undefined,
            error: null,
            unconfirmedAction: undefined,
            hostOutdated: undefined,
          },
        });
        const { description, hostOutdated } = await inspect(view);
        if (current !== generation) return;
        if (hostOutdated !== null) {
          set({
            view: {
              ...view,
              outcome: undefined,
              unconfirmedAction: undefined,
              busy: null,
              error: null,
              hostOutdated,
            },
          });
          return;
        }
        const recovery = admitted(view, description?.recovery);
        if (!routeReview(recovery))
          set({
            view: {
              ...view,
              recovery,
              reviewedOperationId:
                view.recovery.diagnosis?.operationId ??
                view.reviewedOperationId,
              outcome: undefined,
              unconfirmedAction: undefined,
              busy: null,
              error: description?.recovery ? null : 'transport-failed',
              hostOutdated: undefined,
            },
          });
      },
      confirmDiscard: async (): Promise<void> => {
        if (!isCurrentComputer()) return;
        const view = get().view;
        if (
          view.phase !== 'recovery' ||
          view.busy ||
          get().setAsideResult ||
          !view.recovery.actions.discard.eligible ||
          view.outcome !== undefined
        )
          return;
        const current = generation;
        set({ view: { ...view, busy: 'discard', hostOutdated: undefined } });
        const { description, hostOutdated } = await inspect(view);
        if (current !== generation) return;
        if (hostOutdated !== null) {
          set({ view: { ...view, busy: null, error: null, hostOutdated } });
          return;
        }
        const recovery = admitted(
          view,
          sameRecoverySubject(description, view.recovery)
            ? description?.recovery
            : undefined,
        );
        if (routeReview(recovery)) return;
        if (
          description?.status === 'discardable' &&
          recovery.actions.discard.eligible
        ) {
          set({
            view: {
              phase: 'open',
              offer: { ...view.offer, recovery },
              description,
              busy: false,
              error: null,
            },
          });
        } else
          set({
            view: {
              ...view,
              recovery,
              busy: null,
              error: description ? null : 'transport-failed',
              hostOutdated: undefined,
            },
          });
      },
      recover: async (action): Promise<WorktreeDiscardFinished | null> => {
        if (!isCurrentComputer()) return null;
        const showing = get().view;
        if (
          showing.phase !== 'recovery' ||
          showing.busy ||
          showing.outcome ||
          get().setAsideResult
        )
          return null;
        // A new action replaces the last refusal's update message.
        const view = { ...showing, hostOutdated: undefined };
        const resolution =
          client.capabilities.worktreeRecoveryResolution === true
            ? worktreeRecoveryResolutionAction(view.recovery)
            : null;
        const exact = view.recovery.diagnosis;
        if (
          exact &&
          ((action === 'keepWorktree' && resolution === 'keep-worktree') ||
            (action === 'release' && resolution === 'release') ||
            (action === 'finishArchive' && resolution === 'finish'))
        ) {
          const current = generation;
          set({ view: { ...view, busy: action, error: null } });
          try {
            const target = {
              workspaceId: view.offer.workspaceId,
              operationId: exact.operationId,
              revision: exact.revision,
            };
            const outcome =
              action === 'finishArchive'
                ? await client.command('worktree.recovery.finish', target)
                : await client.command('worktree.recovery.resolve', {
                    ...target,
                    action:
                      action === 'keepWorktree' ? 'keep-worktree' : 'release',
                  });
            if (current !== generation) return null;
            set({ view: { ...view, busy: null, outcome, error: null } });
            // Keep/Release preserve host panels. Only an actual removal reconciles them.
            if (
              outcome.status === 'finished' ||
              outcome.status === 'cleanup-pending'
            )
              return {
                warnings: [],
                ...(view.recovery.subject.createdAt
                  ? { expectedCreatedAt: view.recovery.subject.createdAt }
                  : {}),
              };
          } catch (failure) {
            if (current !== generation) return null;
            // An older computer refused the action, so nothing ran: the
            // reviewed recovery stays as it was (CAN-7444).
            const hostOutdated = worktreeRecoveryHostOutdatedMessage(failure);
            if (hostOutdated !== null)
              set({ view: { ...view, busy: null, error: null, hostOutdated } });
            else
              set({
                view: {
                  ...view,
                  recovery: {
                    ...unavailable(view),
                    evidence: view.recovery.evidence,
                  },
                  busy: null,
                  error: 'unconfirmed',
                  unconfirmedAction:
                    action === 'keepWorktree'
                      ? 'keep-worktree'
                      : action === 'release'
                        ? 'release'
                        : 'finish',
                },
              });
          }
          return null;
        }
        if (
          action === 'keepWorktree' ||
          action === 'release' ||
          (action === 'finishArchive' &&
            client.capabilities.worktreeRecoveryResolution === true) ||
          !view.recovery.actions[action].eligible
        )
          return null;
        if (!view.recovery.subject.createdAt) return null;
        const current = generation;
        set({ view: { ...view, busy: action, error: null } });
        const result = await client
          .command('worktree.archive', {
            ...view.offer.removal,
            workspaceId: view.offer.workspaceId,
            worktreeId: view.offer.worktreeId,
            mode: view.recovery.intent,
            typedRefusal: true,
            recovery: {
              intent: view.recovery.intent,
              expectedCreatedAt: view.recovery.subject.createdAt,
            },
          })
          .catch(() => ({ status: 'unconfirmed' as const }));
        if (current !== generation) return null;
        if (result?.status === 'completed') {
          generation += 1;
          set({ view: { phase: 'closed' } });
          return {
            warnings: result.warnings,
            expectedCreatedAt: view.recovery.subject.createdAt,
            ...(result.removedTemporaryWorkspaceId
              ? {
                  removedTemporaryWorkspaceId:
                    result.removedTemporaryWorkspaceId,
                }
              : {}),
          };
        }
        const recovery =
          result?.status === 'refused'
            ? admitted(view, result.refusal.recovery)
            : unavailable(view);
        if (routeReview(recovery)) return null;
        set({
          view: {
            ...view,
            recovery,
            busy: null,
            error:
              result?.status === 'refused'
                ? null
                : result?.status === 'transport-failed'
                  ? 'transport-failed'
                  : 'unconfirmed',
          },
        });
        return null;
      },
      setAside: async (target): Promise<void> => {
        if (!isCurrentComputer()) return;
        const showing = get().view;
        const view =
          showing.phase === 'recovery'
            ? { ...showing, hostOutdated: undefined }
            : showing;
        const exact =
          view.phase === 'recovery' ? view.recovery.diagnosis : null;
        if (
          view.phase !== 'recovery' ||
          view.busy ||
          view.outcome ||
          get().setAsideResult ||
          !exact ||
          target.workspaceId !== view.offer.workspaceId ||
          target.operationId !== exact.operationId ||
          target.revision !== exact.revision ||
          !worktreeRecoveryOfferedActions(view.recovery, {
            canResolve: client.capabilities.worktreeRecoveryResolution === true,
            canSetAside: client.capabilities.worktreeRecoverySetAside === true,
          }).includes('set-aside')
        )
          return;
        const current = generation;
        set({ view: { ...view, busy: 'setAside', error: null } });
        try {
          const outcome = await client.command('worktree.recovery.setAside', {
            workspaceId: target.workspaceId,
            operationId: target.operationId,
            revision: target.revision,
          });
          if (current !== generation) return;
          set({
            // A live-journal scan cannot recover quarantine locations. Keep
            // the reply separately from diagnosis until explicit dismissal.
            ...(outcome.status !== 'refused'
              ? { setAsideResult: outcome }
              : {}),
            view: {
              ...view,
              busy: null,
              outcome: outcome.status === 'refused' ? outcome : undefined,
              error: null,
            },
          });
        } catch (failure) {
          const hostOutdated = worktreeRecoveryHostOutdatedMessage(failure);
          if (current === generation && hostOutdated !== null) {
            set({ view: { ...view, busy: null, error: null, hostOutdated } });
            return;
          }
          if (current === generation)
            set({
              view: {
                ...view,
                reviewedOperationId: target.operationId,
                recovery: {
                  ...unavailable(view),
                  evidence: view.recovery.evidence,
                },
                busy: null,
                error: 'unconfirmed',
                unconfirmedAction: 'set-aside',
              },
            });
        }
      },
      deactivate: (): void => {
        const view = get().view;
        // Detaching is not dismissal. Cancel only the read, so reattachment
        // can show (and dismiss) the result even if that read never answers.
        if (view.phase === 'recovery' && get().setAsideResult) {
          generation += 1;
          set({ view: { ...view, busy: null } });
          return;
        }
        // The move can still return the only copy of its put-back mapping.
        if (view.phase === 'recovery' && view.busy === 'setAside') return;
        generation += 1;
        set({ view: { phase: 'closed' } });
      },
      retry: (): void => {
        if (!isCurrentComputer()) return;
        const view = get().view;
        if (
          view.phase === 'closed' ||
          view.phase === 'recovery' ||
          (view.phase === 'open' && view.busy)
        )
          return;
        if (!worktreeRemovalRetryable(view)) return;
        generation += 1;
        set({ view: { phase: 'closed' } });
        view.offer.retry?.();
      },
      close: (): void => {
        const view = get().view;
        if (get().setAsideResult) {
          generation += 1;
          set({ view: { phase: 'closed' }, setAsideResult: null });
          return;
        }
        if ((view.phase === 'open' || view.phase === 'recovery') && view.busy)
          return;
        if (view.phase === 'open' && view.offer.recovery) {
          set({
            view: {
              phase: 'recovery',
              offer: view.offer,
              recovery: view.offer.recovery,
              busy: null,
              error: null,
            },
          });
          return;
        }
        generation += 1;
        set({ view: { phase: 'closed' } });
      },
    };
  });
}

interface ComputerStores {
  currentComputer: string | null | undefined;
  readonly activations: Set<object>;
  readonly computers: Map<string | null, WorktreeDiscardStore>;
}

const storesByClient = new WeakMap<CanopyClient, ComputerStores>();

function computerStoresFor(client: CanopyClient): ComputerStores {
  let registry = storesByClient.get(client);
  if (!registry) {
    registry = {
      currentComputer: undefined,
      activations: new Set(),
      computers: new Map(),
    };
    storesByClient.set(client, registry);
  }
  return registry;
}

/** Pure lookup: speculative renders must not switch the client's computer. */
export function worktreeDiscardStoreFor(
  client: CanopyClient,
  computerScopeKey: string | null = null,
): WorktreeDiscardStore {
  const registry = computerStoresFor(client);
  const existing = registry.computers.get(computerScopeKey);
  if (existing) return existing;
  const store = createWorktreeDiscardStore(
    client,
    () =>
      registry.currentComputer === computerScopeKey &&
      registry.activations.size > 0,
  );
  registry.computers.set(computerScopeKey, store);
  return store;
}

/** Commit-phase ownership shared by the discard host and recovery notice. */
export function activateWorktreeDiscardComputer(
  client: CanopyClient,
  computerScopeKey: string | null = null,
): () => void {
  const store = worktreeDiscardStoreFor(client, computerScopeKey);
  const registry = computerStoresFor(client);
  if (registry.currentComputer !== computerScopeKey) {
    const previous =
      registry.currentComputer === undefined
        ? undefined
        : registry.computers.get(registry.currentComputer);
    registry.currentComputer = computerScopeKey;
    registry.activations.clear();
    previous?.getState().deactivate();
  }
  const activation = {};
  registry.activations.add(activation);
  return (): void => {
    if (!registry.activations.delete(activation)) return;
    // StrictMode reattaches synchronously. An old panel's cleanup must not
    // cancel a newly mounted A after an A -> B -> A switch.
    queueMicrotask(() => {
      if (
        registry.currentComputer === computerScopeKey &&
        registry.activations.size === 0
      ) {
        registry.currentComputer = undefined;
        store.getState().deactivate();
      }
    });
  };
}
