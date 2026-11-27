import type { WorktreeDiscardDescription } from '@canopy/protocol/remote-control/shell/worktree-discard';
import {
  WORKTREE_DISCARD_DISCONNECTED_WARNING,
  worktreeDiscardCopy,
  worktreeDiscardOnlyCopyWarning,
  worktreeDiscardRefusalCopy,
  type WorktreeDiscardPathRow,
} from './worktree-discard-copy';

/**
 * CAN-5337: every sentence of the project deletion discard confirmation,
 * shared by desktop and the web Portal. Each worktree's paths reuse the
 * worktree discard's labels. Branches go unmentioned: deleting a project the
 * app created removes its repository, as the deletion's own copy says.
 */

export type ProjectDeletionDiscardItemProgress =
  | 'pending'
  | 'discarding'
  | 'discarded'
  | 'skipped'
  | 'stopped';

export interface ProjectDeletionDiscardItemCopy {
  readonly name: string;
  /** Shown beside the name once the run reaches the item. */
  readonly status: string | null;
  readonly paths: readonly WorktreeDiscardPathRow[];
  /** When nothing is left on disk to delete. */
  readonly emptyNote: string | null;
}

export interface ProjectDeletionDiscardCopy {
  readonly confirmLabel: string;
  /** Each row's own discard, offered while more than one is unfinished. */
  readonly discardItemLabel: string | null;
  readonly lead: string;
  readonly items: readonly ProjectDeletionDiscardItemCopy[];
  readonly onlyCopyWarning: string | null;
  readonly alsoDeleted: string | null;
  readonly interruptedDeletion: string | null;
  /** Precedes the masked names discarded in an earlier confirmation. */
  readonly earlierDiscardedLead: string | null;
  readonly disconnectedWarning: string;
}

const PROGRESS_LABELS: Record<
  ProjectDeletionDiscardItemProgress,
  string | null
> = {
  pending: null,
  discarding: 'Discarding…',
  discarded: 'Discarded',
  skipped: 'Skipped',
  stopped: 'Not discarded',
};

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function projectDeletionDiscardCopy(input: {
  readonly items: readonly {
    readonly name: string;
    readonly description: WorktreeDiscardDescription;
    readonly progress: ProjectDeletionDiscardItemProgress;
  }[];
  readonly interruptedDeletion: boolean;
  readonly pendingRecovery?: boolean;
  readonly earlierDiscarded: readonly string[];
}): ProjectDeletionDiscardCopy {
  const worktreeCopies = input.items.map((item) =>
    worktreeDiscardCopy(item.description),
  );
  const deleted = new Set<string>();
  for (const item of input.items)
    for (const data of item.description.alsoDeleted)
      if (data !== 'retained-payload-copy') deleted.add(data);
  const count = input.items.length;
  return {
    confirmLabel: input.pendingRecovery
      ? 'Discard pending recovery and delete project'
      : count === 0
        ? 'Delete project'
        : count === 1
          ? 'Discard worktree and delete project'
          : 'Discard worktrees and delete project',
    // With one left, the dialog's own action is that discard and says it also
    // deletes the project.
    discardItemLabel:
      !input.pendingRecovery &&
      input.items.filter(
        (item) => item.progress === 'pending' || item.progress === 'stopped',
      ).length > 1
        ? 'Discard'
        : null,
    lead: input.pendingRecovery
      ? 'Deleting this project also discards its pending archive recovery and saved recovery material. This cannot be undone. Recovery material stays protected until the project is deleted.'
      : count === 0
        ? 'An earlier deletion of this project was interrupted. Deleting it again replaces that attempt.'
        : count === 1
          ? "This worktree's removal can't finish. Discarding permanently deletes its folders below, then the project is deleted. They can't be recovered."
          : "These worktrees' removal can't finish. Discarding permanently deletes their folders below, then the project is deleted. They can't be recovered.",
    items: input.items.map((item, index) => {
      const copy = worktreeCopies[index];
      return {
        name: item.name,
        status: PROGRESS_LABELS[item.progress],
        paths: [...copy.targets, ...copy.missingSources],
        emptyNote:
          copy.targets.length === 0 ? 'Its folders are already gone.' : null,
      };
    }),
    onlyCopyWarning: worktreeDiscardOnlyCopyWarning(
      input.items.map((item) => item.description),
    ),
    alsoDeleted:
      deleted.size > 0
        ? `Their ${joinList(
            Array.from(deleted, (data) =>
              data === 'cost-history' ? 'cost history' : data,
            ),
          )} are deleted too.`
        : null,
    interruptedDeletion:
      input.interruptedDeletion && count > 0
        ? 'An earlier deletion of this project was interrupted. Deleting it again replaces that attempt.'
        : null,
    earlierDiscardedLead:
      input.earlierDiscarded.length > 0
        ? 'Already discarded, which is final:'
        : null,
    disconnectedWarning: WORKTREE_DISCARD_DISCONNECTED_WARNING,
  };
}

/** Why the run stopped; the dialog stays open and confirming continues. */
export function projectDeletionDiscardErrorCopy(
  error:
    | { readonly kind: 'changed' }
    | {
        readonly kind: 'refused';
        readonly reason: Parameters<typeof worktreeDiscardRefusalCopy>[0];
      }
    | { readonly kind: 'failed'; readonly message: string | null },
): string {
  // The stopped row names the worktree; names stay out of this sentence.
  switch (error.kind) {
    case 'changed':
      return "A worktree changed. Review what's deleted, then confirm again.";
    case 'refused':
      // The worktree copy sends the person to the deletion, which is here.
      return error.reason === 'project-deletion-pending'
        ? PROJECT_DELETION_DISCARD_STILL_INTERRUPTED
        : worktreeDiscardRefusalCopy(error.reason);
    case 'failed':
      return error.message ?? PROJECT_DELETION_DISCARD_FAILED;
  }
}

export const PROJECT_DELETION_DISCARD_FAILED =
  "Couldn't finish deleting this project. Try again.";

const PROJECT_DELETION_DISCARD_STILL_INTERRUPTED =
  "The interrupted deletion couldn't be replaced. Try again.";
