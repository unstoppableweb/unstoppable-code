import type {
  WorktreeDiscardDeletedData,
  WorktreeDiscardDescription,
  WorktreeDiscardRefusal,
  WorktreeDiscardRetry,
  WorktreeDiscardTarget,
  WorktreeDiscardTargetKind,
} from '@canopy/protocol/portal/worktree-discard';

/**
 * CAN-5336: every sentence of the worktree discard confirmation, shared by
 * desktop and the web Portal. The description supplies the facts; this module
 * owns the words.
 */

export const WORKTREE_DISCARD_DISCONNECTED_WARNING =
  'If the repository is on a disconnected drive or share, reconnect it and retry instead.';

/** A batch row's reason for a discardable worktree: the batch never discards. */
export function worktreeDiscardBatchPointer(
  description: WorktreeDiscardDescription,
): string {
  return description.causes.includes('source-gone')
    ? 'Its source repository is missing. Discard it from the row menu.'
    : "Its removal can't finish. Discard it from the row menu.";
}

const TARGET_LABELS: Record<WorktreeDiscardTargetKind, string> = {
  'live-checkout': 'Worktree folder',
  'git-quarantine': 'Quarantined checkout',
  'files-only-recovery': 'Recovery copy',
  'recreated-checkout-path': "Folder at the worktree's location",
  'retained-archive': 'Archived worktree',
};

const DELETED_DATA_LABELS: Record<WorktreeDiscardDeletedData, string> = {
  chats: 'chats',
  plans: 'plans',
  attachments: 'attachments',
  'cost-history': 'cost history',
  'retained-payload-copy': 'saved archive copy',
};

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function isQuarantine(kind: WorktreeDiscardTargetKind): boolean {
  return kind === 'git-quarantine' || kind === 'files-only-recovery';
}

function onlyCopyWarning(
  description: WorktreeDiscardDescription,
): string | null {
  const kinds = description.targets.map((target) => target.kind);
  if (description.causes.includes('archive-recovery-unverified'))
    return "The archive's saved copy couldn't be verified. The checkout may hold the only copy of edits made after it was archived.";
  if (kinds.some(isQuarantine))
    return 'A quarantined or recovery copy may hold the only copy of edits that were never saved anywhere else.';
  if (kinds.includes('retained-archive'))
    return 'The archived worktree may hold the only copy of edits that were never saved anywhere else.';
  return null;
}

export interface WorktreeDiscardPathRow {
  readonly label: string;
  readonly path: string;
  /** Edits the folder holds that the discard deletes with it. */
  readonly details?: readonly string[];
}

/**
 * A multi-repo checkout also deletes its healthy siblings' checkouts, so their
 * uncommitted changes are named (CAN-4995 parent risk).
 */
function uncommittedDetails(target: WorktreeDiscardTarget): string[] {
  const repositories = target.repositories ?? [];
  const named = (flag: boolean | 'unknown'): string[] =>
    repositories
      .filter((repository) => repository.uncommittedChanges === flag)
      .map((repository) => repository.relativePath);
  const dirty = named(true);
  const unknown = named('unknown');
  const details: string[] = [];
  if (dirty.includes('.')) details.push('Has uncommitted changes.');
  const dirtySiblings = dirty.filter((path) => path !== '.');
  if (dirtySiblings.length > 0)
    details.push(`Uncommitted changes in ${joinList(dirtySiblings)}.`);
  if (unknown.includes('.'))
    details.push("Couldn't check for uncommitted changes.");
  const unknownSiblings = unknown.filter((path) => path !== '.');
  if (unknownSiblings.length > 0)
    details.push(
      `Couldn't check ${joinList(unknownSiblings)} for uncommitted changes.`,
    );
  return details;
}

export interface WorktreeDiscardCopy {
  readonly confirmLabel: string;
  /** What happens, and that it is permanent. */
  readonly lead: string;
  readonly targets: readonly WorktreeDiscardPathRow[];
  /** Present when a quarantine or a retained archive is among the targets. */
  readonly onlyCopyWarning: string | null;
  readonly missingSources: readonly WorktreeDiscardPathRow[];
  readonly alsoDeleted: string | null;
  readonly preserved: string | null;
  readonly disconnectedWarning: string;
}

export function worktreeDiscardCopy(
  description: WorktreeDiscardDescription,
): WorktreeDiscardCopy {
  const { targets } = description;
  const deleted = description.alsoDeleted.map(
    (data) => DELETED_DATA_LABELS[data],
  );
  return {
    confirmLabel: description.causes.includes('source-gone')
      ? 'Discard worktree (source missing)'
      : 'Discard worktree',
    lead:
      targets.length === 0
        ? 'Its folders are already gone. Discarding removes it from the list for good.'
        : targets.length === 1
          ? "Discarding permanently deletes this folder. It can't be recovered."
          : "Discarding permanently deletes these folders. They can't be recovered.",
    targets: targets.map((target) => {
      const details = uncommittedDetails(target);
      return {
        label: TARGET_LABELS[target.kind],
        path: target.path,
        ...(details.length > 0 ? { details } : {}),
      };
    }),
    onlyCopyWarning: onlyCopyWarning(description),
    missingSources: description.sources
      .filter(
        (source) =>
          source.state === 'gone-absent' ||
          source.state === 'gone-not-a-repository',
      )
      .map((source) => ({
        label: 'Missing source repository',
        path: source.path,
      })),
    alsoDeleted:
      deleted.length > 0 ? `Its ${joinList(deleted)} are deleted too.` : null,
    preserved: description.preserved.includes('branches')
      ? 'Branches in the source repository are kept.'
      : null,
    disconnectedWarning: WORKTREE_DISCARD_DISCONNECTED_WARNING,
  };
}

/** Why a confirmed discard didn't run; the dialog stays open. */
export function worktreeDiscardRefusalCopy(
  reason: WorktreeDiscardRefusal | 'changed',
  retry?: WorktreeDiscardRetry,
): string {
  switch (reason) {
    case 'changed':
      return "This worktree changed. Review what's deleted, then discard again.";
    case 'busy':
      return 'Something is still running in this worktree. Stop it, then try again.';
    case 'retry-available':
      return retry === 'delete-project'
        ? 'Nothing needs discarding now. Delete the project again instead.'
        : 'Nothing needs discarding now. Try again to remove it normally.';
    case 'no-broken-removal':
      return 'Nothing needs discarding now. Try again to remove it normally.';
    case 'source-unverified':
      return "Couldn't confirm the source repository is gone. Reconnect it or check access, then retry.";
    case 'not-found':
      return 'This worktree is already gone.';
    case 'project-deletion-pending':
      return 'This project is being deleted. Finish deleting it instead.';
    case 'read-only-scope':
    case 'forbidden':
      return "You can't discard this worktree.";
    default:
      return "Couldn't discard this worktree. Try again.";
  }
}

export const WORKTREE_DISCARD_FAILED =
  "Couldn't discard this worktree. Try again.";
