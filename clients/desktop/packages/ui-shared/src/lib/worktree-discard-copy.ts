import type {
  WorktreeRecoveryFinishResult,
  WorktreeRecoveryResolveResult,
  WorktreeRecoverySetAsideResult,
} from '@canopy/protocol/canopy-core';
import {
  formatWorktreeRecoveryReason,
  type WorktreeRecoveryAsset,
  type WorktreeRecoveryDescription,
} from '@canopy/protocol/remote-control/shell/worktree-recovery';
import type {
  WorktreeDiscardDeletedData,
  WorktreeDiscardDescription,
  WorktreeDiscardRefusal,
  WorktreeDiscardRetry,
  WorktreeDiscardTarget,
  WorktreeDiscardTargetKind,
} from '@canopy/protocol/remote-control/shell/worktree-discard';

/**
 * CAN-5336: every sentence of the worktree discard confirmation, shared by
 * desktop and the web Portal. The description supplies the facts; this module
 * owns the words.
 */

export const WORKTREE_DISCARD_DISCONNECTED_WARNING =
  'If the repository is on a disconnected drive or share, reconnect it and try again instead.';

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

const AT_RISK_KINDS: readonly WorktreeDiscardTargetKind[] = [
  'git-quarantine',
  'files-only-recovery',
  'retained-archive',
];

function targetLabels(
  descriptions: readonly WorktreeDiscardDescription[],
  include: (kind: WorktreeDiscardTargetKind) => boolean,
): string[] {
  const labels = new Set<string>();
  for (const description of descriptions)
    for (const target of description.targets)
      if (include(target.kind))
        labels.add(TARGET_LABELS[target.kind].toLowerCase());
  return Array.from(labels);
}

/**
 * Names each at-risk folder by the label its row shows, so the warning reads
 * as a note on those rows rather than a rule about quarantines in general.
 * Project deletion passes every worktree it discards, so one warning covers
 * them all.
 */
export function worktreeDiscardOnlyCopyWarning(
  descriptions: readonly WorktreeDiscardDescription[],
): string | null {
  const unverified = descriptions.filter((description) =>
    description.causes.includes('archive-recovery-unverified'),
  );
  const rest = descriptions.filter(
    (description) => !unverified.includes(description),
  );
  // An unverified archive puts the checkout it would remove at risk, wherever
  // that checkout now is; the archive itself is what couldn't be checked.
  const checkouts = targetLabels(
    unverified,
    (kind) => kind !== 'retained-archive',
  );
  const atRisk = targetLabels(rest, (kind) => AT_RISK_KINDS.includes(kind));
  const sentences: string[] = [];
  if (unverified.length > 0)
    sentences.push(
      `The archive's saved copy couldn't be checked, so the ${
        checkouts.length > 0 ? joinList(checkouts) : 'checkout'
      } may hold the only copy of edits made since it was archived.`,
    );
  if (atRisk.length > 0)
    sentences.push(
      `The ${joinList(atRisk)} may hold edits that aren't saved anywhere else.`,
    );
  return sentences.length > 0 ? sentences.join(' ') : null;
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
  /** What is deleted for good, and what is kept, in one paragraph. */
  readonly lead: string;
  readonly targets: readonly WorktreeDiscardPathRow[];
  /** Present when a quarantine or a retained archive is among the targets. */
  readonly onlyCopyWarning: string | null;
  readonly missingSources: readonly WorktreeDiscardPathRow[];
  /** Only beside a missing source, the one case a disconnected drive explains. */
  readonly disconnectedWarning: string | null;
}

function discardLead(description: WorktreeDiscardDescription): string {
  const deleted = joinList(
    description.alsoDeleted.map((data) => DELETED_DATA_LABELS[data]),
  );
  const kept = description.preserved.includes('branches')
    ? ' Its branches stay in the repository.'
    : '';
  const count = description.targets.length;
  if (count === 0)
    return (
      (deleted
        ? `Its folders are already gone. Discarding permanently deletes its ${deleted}.`
        : 'Its folders are already gone. Discarding removes it from the list for good.') +
      kept
    );
  const folders = count === 1 ? 'the folder below' : 'the folders below';
  return `Discarding permanently deletes ${folders}${deleted ? `, along with its ${deleted}` : ''}.${kept}`;
}

export function worktreeDiscardCopy(
  description: WorktreeDiscardDescription,
): WorktreeDiscardCopy {
  const missingSources = description.sources
    .filter(
      (source) =>
        source.state === 'gone-absent' ||
        source.state === 'gone-not-a-repository',
    )
    .map((source) => ({
      label: 'Missing source repository',
      path: source.path,
    }));
  return {
    // The missing source is named in the body; the action stays the title's
    // verb and noun.
    confirmLabel: 'Discard worktree',
    lead: discardLead(description),
    targets: description.targets.map((target) => {
      const details = uncommittedDetails(target);
      return {
        label: TARGET_LABELS[target.kind],
        path: target.path,
        ...(details.length > 0 ? { details } : {}),
      };
    }),
    onlyCopyWarning: worktreeDiscardOnlyCopyWarning([description]),
    missingSources,
    disconnectedWarning:
      missingSources.length > 0 ? WORKTREE_DISCARD_DISCONNECTED_WARNING : null,
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

/** Batches only point at recovery; they never open or confirm extra removals. */
export function worktreeRecoveryBatchPointer(
  recovery: WorktreeRecoveryDescription,
): string {
  return `${formatWorktreeRecoveryReason(recovery)} Open the worktree's row menu to review recovery.`;
}

export const WORKTREE_REMOVAL_UNCONFIRMED =
  "The removal hasn't been confirmed. Check the worktree list before you try again.";

const RECOVERY_ASSET_LABELS: Record<
  keyof WorktreeRecoveryDescription['retained'],
  string
> = {
  checkout: 'Working files',
  stagedCopy: 'Temporary copy',
  gitSnapshot: 'Git snapshots',
  committedArchive: 'Saved archive',
  chats: 'Chats',
};

/** Presence is not completeness or restorability; unknown is never absent. */
export function worktreeRecoveryRetainedFact(
  key: keyof WorktreeRecoveryDescription['retained'],
  asset: WorktreeRecoveryAsset,
): string {
  const label = RECOVERY_ASSET_LABELS[key];
  if (asset.presence === 'unknown') return `${label}: couldn't check.`;
  if (asset.presence === 'absent') return `${label}: not found.`;
  if (key === 'gitSnapshot')
    return 'Some repositories have saved Git snapshots.';
  if (asset.presence === 'partial') return `${label}: incomplete.`;
  if (key === 'committedArchive') return 'The saved archive remains.';
  if (key === 'stagedCopy')
    return asset.verification === 'verified'
      ? 'A temporary copy remains.'
      : "A temporary copy remains. It hasn't been verified.";
  if (asset.verification !== 'verified') return `${label}: not verified.`;
  return key === 'checkout'
    ? 'Working files are still in place.'
    : 'Chats are still saved.';
}

/** Preservation and withdrawal never promise to undo earlier scripts or stopped sessions. */
export function worktreeRecoveryResultCopy(
  result:
    | WorktreeRecoveryFinishResult
    | WorktreeRecoveryResolveResult
    | WorktreeRecoverySetAsideResult,
  action?:
    | 'keep-worktree'
    | 'release'
    | 'finish'
    | 'finish-cleanup'
    | 'delete-hold'
    | 'set-aside',
): string {
  const verb = action
    ? RECOVERY_ACTION_VERBS[action]
    : 'continue archive recovery';
  switch (result.status) {
    case 'worktree-kept':
      return (
        'Worktree kept. Earlier cleanup scripts and stopped sessions have not been reversed.' +
        retainedRecoveryCopy(result)
      );
    case 'attempt-withdrawn':
      return (
        'Archive attempt withdrawn. No worktree was restored.' +
        retainedRecoveryCopy(result)
      );
    case 'hold-deleted':
      return 'Retained recovery material deleted.';
    case 'set-aside':
      return WORKTREE_RECOVERY_SET_ASIDE_DONE;
    case 'finished':
    case 'cleanup-pending':
      if (
        !result.cleanupRequired &&
        !result.gitCleanupPending &&
        result.status === 'finished'
      )
        return action === 'finish-cleanup'
          ? 'Cleanup finished. The worktree was already removed.'
          : 'Archive finished. The worktree has been removed.';
      if (action === 'finish-cleanup')
        return 'The archive finished, but some cleanup is still pending. Check again before continuing.';
      return (
        'Archive saved. The worktree has been removed. ' +
        (result.gitCleanupPending
          ? 'Git cleanup is still pending.' +
            (result.cleanupRequired ? ' Other cleanup is also pending.' : '')
          : 'Separate cleanup is still pending.')
      );
    case 'refused':
      return `Couldn't ${verb}. Check again to review the current options. No completion has been confirmed.`;
    case 'interrupted':
      if ('moved' in result && result.moved)
        return 'The record was moved, but the move could not be confirmed as saved. Check Details for both file names and folders. Quit the app and ask support before putting it back.';
      if ('reservation' in result && result.reservation)
        return 'The move could not be confirmed. A quarantine reservation may remain and keep saved recovery material protected. Check Details and ask support before changing it.';
      return `The attempt to ${verb} was interrupted. Check again before continuing; some changes may already have been applied.`;
  }
}

const RECOVERY_ACTION_VERBS = {
  'keep-worktree': 'keep the worktree',
  release: 'withdraw the archive attempt',
  finish: 'finish the archive',
  'finish-cleanup': 'finish cleanup',
  'delete-hold': 'delete recovery material',
  'set-aside': 'set the record aside',
};

/**
 * CAN-7014: the undo is a manual move while the app is quit (decision q-26
 * 3a), so the result says how. "The app" keeps the copy brand-neutral.
 * Other recovery evidence stays in place and may still block removal.
 */
export const WORKTREE_RECOVERY_SET_ASIDE_DONE =
  "Record set aside. Other recovery records may still block archiving or deleting this worktree. Nothing else was moved or deleted. To undo, quit the app. Details lists both folders and the file's original and quarantined names. Move the file back to the journal folder using its original filename, not its quarantined filename. If the original name is occupied, leave the file in place and ask support. Never replace an existing journal.";

export const WORKTREE_RECOVERY_SET_ASIDE_CONFIRM =
  "This record stops blocking archiving and deleting this worktree. Its working files, saved copies and Git snapshots stay where they are and aren't cleaned up. You can move the record back later, while the app is quit.";

function retainedRecoveryCopy(result: {
  retainedSnapshots: number;
  retainedPayload: boolean;
}): string {
  return result.retainedSnapshots > 0 || result.retainedPayload
    ? ' Saved recovery material is retained separately. You can delete it later.'
    : ' No saved recovery material remains.';
}

/** Unknown delivery is not a refusal or completion, and is never retried automatically. */
export function worktreeRecoveryUnconfirmedCopy(
  action:
    | 'keep-worktree'
    | 'release'
    | 'finish'
    | 'finish-cleanup'
    | 'delete-hold'
    | 'set-aside',
): string {
  const subject = {
    'keep-worktree': 'Keeping the worktree',
    release: 'Withdrawing the archive attempt',
    finish: 'Finishing the archive',
    'finish-cleanup': 'Finishing cleanup',
    'delete-hold': 'Deleting recovery material',
    'set-aside': 'Setting the record aside',
  }[action];
  return `${subject} hasn't been confirmed. Check again before continuing.`;
}
