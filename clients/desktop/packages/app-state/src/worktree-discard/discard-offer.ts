import { create } from 'zustand';
import type { WorktreeDiscardDescription } from '@canopy/protocol/portal/worktree-discard';

/**
 * CAN-5336: a worktree removal the host refused, offered to the mounted
 * discard host. The host describes it when no description came with the
 * refusal, and shows `message` instead when nothing can be discarded.
 */
export interface WorktreeDiscardOffer {
  readonly workspaceId: string;
  readonly worktreeId: string;
  /** The row's name, for the dialog title. */
  readonly worktreeName: string;
  /** The refusal's own message; shown when the worktree isn't discardable. */
  readonly message: string;
  /** Present when a typed refusal carried it. */
  readonly description?: WorktreeDiscardDescription;
  /**
   * CAN-5338: a retained archive's permanent deletion failed; describe it
   * with `retainedArchives`.
   */
  readonly retainedArchives?: boolean;
  /** Runs the ordinary removal the user asked for again. */
  readonly retry: () => void;
}

/**
 * One request slot per page, as for the journal review: a surface may hold a
 * narrower client than the host that answers.
 */
const worktreeDiscardOffers = create<{
  readonly token: number;
  readonly offer: WorktreeDiscardOffer | null;
}>()(() => ({ token: 0, offer: null }));

/** The latest offer and its token; a host answers each token once. */
export function useWorktreeDiscardOffer(): {
  readonly token: number;
  readonly offer: WorktreeDiscardOffer | null;
} {
  const token = worktreeDiscardOffers((state) => state.token);
  const offer = worktreeDiscardOffers((state) => state.offer);
  return { token, offer };
}

export function offerWorktreeDiscard(offer: WorktreeDiscardOffer): void {
  worktreeDiscardOffers.setState((state) => ({
    token: state.token + 1,
    offer,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * How a typed archive or delete answer (`typedRefusal`) continues: `offer`
 * the discard for a discardable description, otherwise `fail` down the
 * existing failure path with the refusal's message unchanged, so an older
 * desktop's non-discardable refusal still reaches its own review (CAN-5335).
 * `null` when the answer is not a refusal.
 */
export function archiveRefusalOutcome(
  result: unknown,
):
  | { readonly kind: 'offer'; readonly message: string }
  | { readonly kind: 'fail'; readonly message: string }
  | null {
  if (!isRecord(result) || !isRecord(result.refusal)) return null;
  const { refusal } = result;
  const message =
    typeof refusal.message === 'string' && refusal.message.trim() !== ''
      ? refusal.message
      : "Couldn't remove this worktree. Try again.";
  return isRecord(refusal.discard) && refusal.discard.status === 'discardable'
    ? { kind: 'offer', message }
    : { kind: 'fail', message };
}
