import { WorktreeRecoveryDescriptionSchema } from '@canopy/protocol/portal/worktree-discard-schemas';
import {
  formatWorktreeRecoveryReason,
  type WorktreeRecoveryDescription,
} from '@canopy/protocol/portal/worktree-recovery';
import type { PortalWorktreeArchivePayload } from '@canopy/protocol/portal';
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
  readonly recovery?: WorktreeRecoveryDescription;
  /** Safety choices from the original confirmation, not a component callback. */
  readonly removal?: Pick<
    PortalWorktreeArchivePayload,
    'deleteBranch' | 'expectedBranchName' | 'deleteWithoutRetentionIfMissing'
  >;
  /**
   * CAN-5338: a retained archive's permanent deletion failed; describe it
   * with `retainedArchives`.
   */
  readonly retainedArchives?: boolean;
  /** Legacy ordinary removal only; recovery actions never call it. */
  readonly retry?: () => void;
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
 * Supported recovery wins; unreadable evidence retains its journal review.
 * Without settled-action support, use the legacy discardable/fail routes.
 */
export function archiveRefusalOutcome(
  result: unknown,
  recoverySupported = true,
):
  | {
      readonly kind: 'recovery' | 'journal-review';
      readonly message: string;
      readonly recovery: WorktreeRecoveryDescription;
    }
  | { readonly kind: 'offer'; readonly message: string }
  | { readonly kind: 'fail'; readonly message: string }
  | null {
  if (!isRecord(result) || !isRecord(result.refusal)) return null;
  const { refusal } = result;
  const supported = WorktreeRecoveryDescriptionSchema.safeParse(
    refusal.recovery,
  );
  if (recoverySupported && supported.success)
    return {
      kind:
        supported.data.destination.kind === 'journal-review'
          ? 'journal-review'
          : 'recovery',
      message: formatWorktreeRecoveryReason(supported.data),
      recovery: supported.data,
    };
  const message =
    typeof refusal.message === 'string' && refusal.message.trim() !== ''
      ? refusal.message
      : "Couldn't remove this worktree. Try again.";
  return isRecord(refusal.discard) && refusal.discard.status === 'discardable'
    ? { kind: 'offer', message }
    : { kind: 'fail', message };
}
