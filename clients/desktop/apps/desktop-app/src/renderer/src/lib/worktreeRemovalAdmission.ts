import { archiveRefusalOutcome } from '@canopy/app-state';
import type {
  ArchiveWorktreeResponse,
  WorktreeDiscardDescription,
} from '@canopy/desktop-shared/types';

/** Refused by the read-only removal pre-check, before any renderer effect. */
export class WorktreeRemovalRefusedError extends Error {
  constructor(
    readonly worktreeId: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeRemovalRefusedError';
  }
}

/**
 * Main refused the archive itself and the worktree can be discarded
 * (CAN-5336). The message is main's refusal, unchanged.
 */
export class WorktreeArchiveRefusalError extends Error {
  constructor(
    message: string,
    readonly discard: WorktreeDiscardDescription,
  ) {
    super(message);
    this.name = 'WorktreeArchiveRefusalError';
  }
}

/**
 * Continues a typed archive answer: a discardable refusal throws
 * {@link WorktreeArchiveRefusalError}; any other refusal throws its message
 * down the existing failure path, so an older desktop's journal refusal still
 * reaches its own review. Returns when the archive was not refused.
 */
export function throwIfArchiveRefused(response: ArchiveWorktreeResponse): void {
  const outcome = archiveRefusalOutcome(response);
  if (!outcome) return;
  if (outcome.kind === 'offer' && response.refusal)
    throw new WorktreeArchiveRefusalError(
      outcome.message,
      response.refusal.discard,
    );
  throw new Error(outcome.message);
}

const CHECK_FAILED_MESSAGE =
  "Couldn't check this worktree's sources. Try again.";

/**
 * Main's read-only source admission for an ordinary removal (CAN-5333), run
 * before the renderer registers, deselects, cancels, stops or tears anything
 * down. Resolves the refusal for the first refused worktree, or `undefined`
 * when removal may start: admitted, or `unchecked` on a remote host whose
 * release has no pre-check. A failed or malformed check rejects, so the
 * caller refuses too. It is not a reservation; the archive admits again.
 */
export async function findWorktreeRemovalRefusal(
  workspaceId: string,
  worktreeIds: readonly string[],
  expectedKind?: 'single-repo' | 'multi-repo',
): Promise<WorktreeRemovalRefusedError | undefined> {
  if (worktreeIds.length === 0) return undefined;
  const result: unknown = await window.api.checkWorktreeRemovalAdmission({
    workspaceId,
    worktreeIds: [...worktreeIds],
    ...(expectedKind === undefined ? {} : { expectedKind }),
  });
  if (typeof result === 'object' && result !== null && 'status' in result) {
    if (result.status === 'admitted' || result.status === 'unchecked') {
      return undefined;
    }
    if (
      result.status === 'refused' &&
      'worktreeId' in result &&
      typeof result.worktreeId === 'string' &&
      'message' in result &&
      typeof result.message === 'string' &&
      result.message.trim() !== ''
    ) {
      return new WorktreeRemovalRefusedError(result.worktreeId, result.message);
    }
  }
  throw new Error(CHECK_FAILED_MESSAGE);
}

/** {@link findWorktreeRemovalRefusal}, rejecting with the refusal. */
export async function assertWorktreeRemovalAdmitted(
  workspaceId: string,
  worktreeId: string,
  expectedKind: 'single-repo' | 'multi-repo',
): Promise<void> {
  const refusal = await findWorktreeRemovalRefusal(
    workspaceId,
    [worktreeId],
    expectedKind,
  );
  if (refusal) throw refusal;
}
