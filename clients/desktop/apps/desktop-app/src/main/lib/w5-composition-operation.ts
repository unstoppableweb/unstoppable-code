import {
  createW5BoundaryStep,
  createW5CompositionLocks,
  createW5CompositionRevisionCheck,
  type W5CompositionLockInput,
} from '@canopy/core-runtime/node/w5/composition-operation';
import { w5RecordReadPaths } from './paths';
import type { W5CommitOptions } from './w5-commit-scope';
import type { W5RepositoryLock } from './w5-repository-locks';
import { checkW5ExpectedRevision } from './w5-boundary-operation';
import { withW5Commit } from './w5-commit-log-file-store';

export {
  admitW5Composition,
  type W5CompositionOptions,
} from '@canopy/core-runtime/node/w5/composition-operation';
export {
  decodeW5CompositionOutcome,
  w5CombineOutcomeParser,
  w5ExistingCombineOutcomeParser,
  w5PromoteOutcomeParser,
  type W5CombineOutcome,
  type W5ExistingCombineOutcome,
  type W5PromoteOutcome,
} from '@canopy/core-runtime/node/w5/composition-outcome';

/*
 * Core composition helpers bound to desktop main's revision reads, commit and
 * workspace paths, resolved at call time so test injection and spies still
 * intercept. Hoisted declarations with no module-level bindings, so import
 * cycles cannot reach them uninitialized.
 */

export function checkW5CompositionRevisions(
  options: W5CommitOptions,
): Promise<void> {
  return createW5CompositionRevisionCheck((resource, expected) =>
    checkW5ExpectedRevision(resource, expected),
  )(options);
}

/** A record-only transition. Never place Git, provisioning, migration or publication inside work. */
export function commitW5BoundaryStep<T>(
  options: W5CommitOptions | undefined,
  locks: readonly W5RepositoryLock[],
  work: () => Promise<T>,
): Promise<T> {
  return createW5BoundaryStep((commit, commitWork) =>
    withW5Commit(commit, commitWork),
  )(options, locks, work);
}

export function w5CompositionLocks(
  input: W5CompositionLockInput,
): W5RepositoryLock[] {
  return createW5CompositionLocks({
    workspaceIndex: () => w5RecordReadPaths.index(),
    workspaceManifest: (workspaceId) => w5RecordReadPaths.manifest(workspaceId),
    worktreeList: (workspaceId) => w5RecordReadPaths.worktrees(workspaceId),
  })(input);
}
