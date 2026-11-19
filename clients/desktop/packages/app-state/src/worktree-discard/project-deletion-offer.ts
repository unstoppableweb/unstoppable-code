import { create } from 'zustand';
import type { ProjectDeletionDiscardDescription } from '@canopy/protocol/remote-control/shell/project-deletion-discard';

/**
 * CAN-5337: a project deletion the host refused, offered to the mounted
 * project deletion discard host. The host describes it and opens the
 * confirmation only when discardable items are all that block the deletion;
 * otherwise the refusing surface keeps showing `message`.
 */
export interface ProjectDeletionDiscardOffer {
  readonly workspaceId: string;
  /** The project's name, for the dialog title. */
  readonly projectName: string;
  /** The refusal's own message. */
  readonly message: string;
  /** Present when the host already described the deletion. */
  readonly description?: ProjectDeletionDiscardDescription;
  /**
   * Runs the ordinary deletion again after the discards. A refusal it meets
   * goes through the surface's own handling, which offers again.
   */
  readonly retry: () => void;
  /** The confirmation opened: the refusing surface closes its own dialog. */
  readonly onOpen?: () => void;
  /** Superseding an interrupted deletion deleted the project by itself. */
  readonly onDeleted?: () => void;
}

/** One request slot per page, as for the worktree discard offer. */
const projectDeletionDiscardOffers = create<{
  readonly token: number;
  readonly offer: ProjectDeletionDiscardOffer | null;
}>()(() => ({ token: 0, offer: null }));

/** The latest offer and its token; a host answers each token once. */
export function useProjectDeletionDiscardOffer(): {
  readonly token: number;
  readonly offer: ProjectDeletionDiscardOffer | null;
} {
  const token = projectDeletionDiscardOffers((state) => state.token);
  const offer = projectDeletionDiscardOffers((state) => state.offer);
  return { token, offer };
}

export function offerProjectDeletionDiscard(
  offer: ProjectDeletionDiscardOffer,
): void {
  projectDeletionDiscardOffers.setState((state) => ({
    token: state.token + 1,
    offer,
  }));
}
