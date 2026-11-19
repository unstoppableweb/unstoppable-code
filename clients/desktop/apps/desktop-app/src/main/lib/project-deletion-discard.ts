import { describePendingArchiveRecoveries } from './archive-recovery-project-deletion';
import { archiveRecoveryStore } from './archive-recovery-refs';
import type {
  ProjectDeletionDiscardDescription,
  ProjectDeletionDiscardItem,
  ProjectDeletionInterruptedDeletion,
} from '@canopy/protocol/remote-control/shell/project-deletion-discard';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardRefusal,
} from '@canopy/protocol/remote-control/shell/worktree-discard';
import { basename, dirname, resolve } from 'node:path';
import { readArchivedContainerManifestIncludingExpired } from './archived-containers';
import { getArchivedContainersRootDir } from './paths';
import { isWritableScope } from './read-only-scope';
import { validateId } from './validation';
import {
  isAdmittedByUserProjectDeletion,
  isDestructiveRecoveryOwnerless,
  isInterruptedIndexRemovalDeletion,
  readWorkspaceDestructiveRecoveries,
} from './w5-destructive-recovery';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from './workspace-persistence';
import {
  assertRetainedArchivesReadable,
  assertWorkspaceDeletableBesideItsWorktrees,
  isWorkspaceIndexed,
} from './workspace-deletion';
import { describeWorktreeDiscard } from './worktree-discard';

/**
 * CAN-5337 (CAN-4995 E): what keeps a listed code project's deletion from
 * finishing, when that is only worktrees a user can discard (CAN-5334) and an
 * interrupted deletion the next one may supersede. Read-only, like the
 * worktree description it is built from; it discards nothing. Any other
 * refusal, an unreadable journal or an operation still running leaves it
 * `refused`, so the deletion's own message stands. An unindexed project is
 * out of scope (CAN-5316).
 */

/** An ordinary deletion finishes these itself; they block nothing. */
const ORDINARY_REMOVAL: ReadonlySet<WorktreeDiscardRefusal> = new Set([
  'no-broken-removal',
  'retry-available',
  'not-found',
]);

interface Candidate {
  worktreeId: string;
  worktreeName?: string;
  /** An unfinished journal of it that the deletion's admission refuses. */
  blocksAdmission: boolean;
}

function refusedDescription(
  workspaceId: string,
): ProjectDeletionDiscardDescription {
  return { version: 1, workspaceId, status: 'refused', items: [] };
}

/**
 * Its list order: the rows, then worktrees only a journal still names, then
 * the retained archives whose recovery refuses the deletion (CAN-5338).
 */
async function readCandidates(
  workspaceId: string,
  blocking: ReadonlySet<string>,
  blockedArchives: ReadonlySet<string>,
): Promise<Candidate[] | null> {
  const list = await readWorkspaceWorktreesDetailed(workspaceId, {
    persistRemovalCleanup: false,
  });
  if (list.authority !== 'ok' && list.authority !== 'absent') return null;
  const candidates: Candidate[] = list.worktrees.map((worktree) => ({
    worktreeId: worktree.id,
    worktreeName: worktree.label?.trim() || worktree.branchName || worktree.id,
    blocksAdmission: blocking.has(worktree.id),
  }));
  for (const worktreeId of blocking)
    if (!candidates.some((candidate) => candidate.worktreeId === worktreeId))
      candidates.push({ worktreeId, blocksAdmission: true });
  for (const worktreeId of blockedArchives) {
    const known = candidates.find(
      (candidate) => candidate.worktreeId === worktreeId,
    );
    if (known) {
      known.blocksAdmission = true;
      continue;
    }
    const manifest = await readArchivedContainerManifestIncludingExpired(
      workspaceId,
      worktreeId,
    ).catch(() => null);
    const worktreeName = manifest?.label?.trim() || manifest?.name;
    candidates.push({
      worktreeId,
      ...(worktreeName ? { worktreeName } : {}),
      blocksAdmission: true,
    });
  }
  return candidates;
}

/** An indexed code project whose deletion's other admission checks pass. */
async function isDeletableBesideItsWorktrees(
  workspaceId: string,
  blockedArchives?: Set<string>,
): Promise<boolean> {
  if (!(await isWorkspaceIndexed(workspaceId))) return false;
  const kind = await assertWorkspaceDeletableBesideItsWorktrees(
    workspaceId,
    blockedArchives,
  );
  return (
    (kind === 'single-repo' || kind === 'multi-repo') &&
    (await readWorkspaceConfigDetailed(workspaceId)).authority === 'ok'
  );
}

interface JournalFindings {
  /** Worktrees whose unfinished journal the deletion's admission refuses. */
  blocking: Set<string>;
  interruptedDeletion?: ProjectDeletionInterruptedDeletion;
}

/**
 * The project's unfinished journals as the deletion's admission sees them;
 * null when one refuses it for anything but a discardable item. Throws for
 * any unreadable journal, which keeps its quarantine review.
 */
async function readJournalFindings(
  workspaceId: string,
): Promise<JournalFindings | null> {
  const findings: JournalFindings = { blocking: new Set() };
  for (const record of await readWorkspaceDestructiveRecoveries(workspaceId)) {
    if (record.state === 'completed') continue;
    if (!isDestructiveRecoveryOwnerless(record)) return null;
    if (await isAdmittedByUserProjectDeletion(record)) continue;
    if (record.worktreeId !== undefined) {
      findings.blocking.add(record.worktreeId);
      continue;
    }
    if (!(await isInterruptedIndexRemovalDeletion(record))) return null;
    findings.interruptedDeletion = { operationId: record.operationId };
  }
  return findings;
}

/** Each discardable candidate; null when one blocks for anything else. */
async function describeItems(
  workspaceId: string,
  candidates: readonly Candidate[],
  ignoreInterruptedDeletion: boolean,
  retainedArchives: boolean,
): Promise<ProjectDeletionDiscardItem[] | null> {
  const items: ProjectDeletionDiscardItem[] = [];
  for (const candidate of candidates) {
    const description: WorktreeDiscardDescription =
      await describeWorktreeDiscard(workspaceId, candidate.worktreeId, {
        ignoreInterruptedDeletion,
        ...(retainedArchives ? { retainedArchives } : {}),
      });
    if (description.status === 'discardable') {
      items.push({
        ...(candidate.worktreeName
          ? { worktreeName: candidate.worktreeName }
          : {}),
        description,
      });
      continue;
    }
    const reason = description.refusal?.reason;
    if (
      candidate.blocksAdmission ||
      reason === undefined ||
      !ORDINARY_REMOVAL.has(reason)
    )
      return null;
  }
  return items;
}

/**
 * The archive-root entries the items' discards remove: each recovery copy
 * target where it now is, in place or moved aside by an interrupted discard.
 * A container a discard does not target stays under the deletion's reads.
 */
function archiveDirectoriesDiscarded(
  workspaceId: string,
  items: readonly ProjectDeletionDiscardItem[],
): Set<string> {
  const root = resolve(getArchivedContainersRootDir(workspaceId));
  const names = new Set<string>();
  for (const { description } of items)
    for (const target of description.targets)
      if (
        (target.kind === 'files-only-recovery' ||
          target.kind === 'retained-archive') &&
        resolve(dirname(target.path)) === root
      )
        names.add(basename(target.path));
  return names;
}

/**
 * CAN-5338: `retainedArchives` also lists each retained archive whose
 * recovery refuses the deletion, discarded before it like any other item.
 * Without it, such an archive refuses the description as before.
 */
export async function describeProjectDeletionDiscard(
  workspaceId: string,
  options: { retainedArchives?: boolean } = {},
): Promise<ProjectDeletionDiscardDescription> {
  validateId(workspaceId, 'workspaceId');
  const refused = refusedDescription(workspaceId);
  if (!isWritableScope(workspaceId)) return refused;
  const retainedArchives = options.retainedArchives === true;
  const blockedArchives = new Set<string>();
  try {
    const pendingRecovery = await describePendingArchiveRecoveries(workspaceId);
    if (
      !(await isDeletableBesideItsWorktrees(
        workspaceId,
        retainedArchives ? blockedArchives : undefined,
      ))
    )
      return refused;
    const findings = await readJournalFindings(workspaceId);
    if (!findings) return refused;
    const { interruptedDeletion } = findings;
    const candidates = await readCandidates(
      workspaceId,
      findings.blocking,
      blockedArchives,
    );
    const items =
      candidates &&
      (await describeItems(
        workspaceId,
        candidates,
        interruptedDeletion !== undefined,
        retainedArchives,
      ));
    if (
      !items ||
      (items.length === 0 && !interruptedDeletion && !pendingRecovery.length)
    )
      return refused;
    const discardedArchives = archiveDirectoriesDiscarded(workspaceId, items);
    const store = archiveRecoveryStore();
    for (const pending of pendingRecovery) {
      const receipt = await store.read(workspaceId, pending.operationId);
      if (!receipt) return refused;
      // Row discards are separate requests: they cannot borrow this deletion's
      // confirmed-resolution admission to bypass the same-slot removal fence.
      if (
        items.some((item) => item.description.worktreeId === receipt.worktreeId)
      )
        return refused;
      // Ordinary child archive retry consumes this exact, untouched staging.
      if ((await store.inspect(receipt)).effectFree)
        discardedArchives.add(receipt.worktreeId);
    }
    // The deletion would fail on another archive after these discards.
    await assertRetainedArchivesReadable(workspaceId, discardedArchives);
    return {
      version: 1,
      workspaceId,
      status: 'discardable',
      items,
      ...(interruptedDeletion ? { interruptedDeletion } : {}),
      ...(pendingRecovery.length ? { pendingRecovery } : {}),
    };
  } catch {
    return refused;
  }
}
