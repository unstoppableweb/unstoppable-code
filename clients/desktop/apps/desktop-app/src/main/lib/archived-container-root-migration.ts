import { isAbsolute, relative, sep } from 'node:path';
import {
  CompletedRootMigrationUnverifiedError,
  getCompletedRootMigration,
} from '@canopy/execution-engine/node/lib/completed-root-migration';
import type { ArchivedContainerManifest } from '@canopy/desktop-shared/types';
import { relocateCheckoutPath } from '../pipelines/execution-checkout-location';
import { logMainProcessInfo, logMainProcessWarn } from './main-process-logging';

interface RootRewrite {
  readonly fromRoot: string;
  readonly toRoot: string;
}

// Root migration is cold-only, so the journal cannot change while this
// process runs: resolve it once and keep the answer, including a failure.
let rewritesPromise: Promise<readonly RootRewrite[]> | null = null;

async function resolveRootRewrites(): Promise<readonly RootRewrite[]> {
  try {
    const migration = await getCompletedRootMigration();
    if (!migration || migration.source === migration.destination) return [];
    logMainProcessInfo(
      'Archived worktrees made before the data root migration are read with their repository paths rebased',
      { source: migration.source, destination: migration.destination },
    );
    return [{ fromRoot: migration.source, toRoot: migration.destination }];
  } catch (error) {
    // Fail closed: without a verified journal, pre-migration archives keep
    // their recorded paths and the Git integrity check keeps refusing them.
    logMainProcessWarn(
      'Archived worktree paths were not rebased: the data root migration journal could not be verified',
      // The closed cause, when a private-path check refused (CAN-7917).
      error instanceof CompletedRootMigrationUnverifiedError &&
        error.privacy !== undefined
        ? { message: error.message, cause: error.privacy }
        : error instanceof Error
          ? error.message
          : String(error),
    );
    return [];
  }
}

function getRootRewrites(): Promise<readonly RootRewrite[]> {
  rewritesPromise ??= resolveRootRewrites();
  return rewritesPromise;
}

function isWithinRoot(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  );
}

function rebaseRepositoryPath(
  path: string,
  rewrites: readonly RootRewrite[],
): string {
  // Idempotent: a path already under a destination (even one nested inside
  // its source) was rebased before, or recorded after the migration.
  if (rewrites.some(({ toRoot }) => isWithinRoot(path, toRoot))) return path;
  return relocateCheckoutPath(path, rewrites);
}

/**
 * Version-2 archives made before the internal data-root migration record the
 * old root in `gitState.repositories[].referenceRepoPath`, which the migration
 * did not rewrite. Map those paths through the validated migration journal so
 * the Git integrity check, ref reads, restore and purge use the current
 * repository. Returns the input object when nothing changes; never mutates it.
 */
export async function rebaseArchivedManifestRepositoryPaths(
  manifest: ArchivedContainerManifest,
): Promise<ArchivedContainerManifest> {
  if (manifest.version !== 2) return manifest;
  // The manifest contract requires `gitState` on version 2.
  const repositories = manifest.gitState.repositories;
  if (repositories.length === 0) return manifest;
  const rewrites = await getRootRewrites();
  if (rewrites.length === 0) return manifest;
  let changed = false;
  const rebased = repositories.map((repository) => {
    const referenceRepoPath = rebaseRepositoryPath(
      repository.referenceRepoPath,
      rewrites,
    );
    if (referenceRepoPath === repository.referenceRepoPath) return repository;
    changed = true;
    return { ...repository, referenceRepoPath };
  });
  if (!changed) return manifest;
  return {
    ...manifest,
    gitState: { ...manifest.gitState, repositories: rebased },
  };
}
