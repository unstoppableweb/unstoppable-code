import { w5RecordReadPaths } from './paths';
import type { W5RepositoryLock } from './w5-repository-locks';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isMissingFileError } from './fs-utils';
import { validateId } from './validation';
import {
  workspaceCreationDiagnosticsSchema,
  type WorkspaceCreationDiagnostics,
  type WorkspaceCreationRepository,
} from './w5-workspace-creation-diagnostics';
import { getW5IdentityStore } from './w5-commit-log-file-store';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { W5CommitOptions } from './w5-commit-log-file-store';
import { commitW5BoundaryStep } from './w5-composition-operation';
import { isW5CaptureWorkspaceId } from '../w5-commit-log/commit-log-worker-contract';
import type { W5ReservationInput } from '@canopy/core-runtime/node/w5/commit-log-file-store';

export interface WorkspaceCreationReservationOptions {
  releaseBeforeEffects?: boolean;
  expectedWorkspaceRecords?: W5ReservationInput['expectedWorkspaceRecords'];
}

interface CreationCommitContext {
  options: W5CommitOptions;
  active: boolean;
  beforeEffects?: () => void;
  identityReservationId?: string;
  effectsStarted?: boolean;
  diagnostics?: WorkspaceCreationDiagnostics;
  preEffectFailure?: (error: unknown) => void;
}
const context = new AsyncLocalStorage<CreationCommitContext>();

/** Provisioning names its first potential filesystem/Git effect before starting it. */
export function markWorkspaceCreationEffectsStarted(): void {
  const scope = context.getStore();
  if (scope?.active) {
    scope.effectsStarted = true;
    scope.beforeEffects?.();
  }
}

/** Persist each step before Git and acknowledge completion only after it returns. */
export async function recordWorkspaceCreationRepository(
  repository: WorkspaceCreationRepository,
): Promise<void> {
  const scope = context.getStore();
  const store = getW5IdentityStore();
  if (
    !scope?.active ||
    !scope.identityReservationId ||
    !scope.diagnostics ||
    !store
  )
    return;
  const repositories = [...(scope.diagnostics.repositories ?? [])];
  const index = repositories.findIndex(
    (entry) => entry.role === repository.role && entry.id === repository.id,
  );
  if (index < 0) repositories.push(repository);
  else repositories[index] = repository;
  const diagnostics: WorkspaceCreationDiagnostics = {
    ...scope.diagnostics,
    ownedPaths: Array.from(
      new Set([
        ...scope.diagnostics.ownedPaths,
        ...(repository.owned ? [repository.path] : []),
      ]),
    ),
    phase:
      repository.status === 'completed'
        ? 'before-canonical-commit'
        : repository.role === 'member'
          ? 'member-import'
          : repository.action === 'clone'
            ? 'remote-clone'
            : 'source-initialization',
    repositories,
  };
  await store.updateReservationDiagnostics(
    scope.identityReservationId,
    diagnostics,
  );
  scope.diagnostics = diagnostics;
}

/** Pass options through provisioning without extending any existing lock. */
export async function withWorkspaceCreationCommit<T>(
  options: W5CommitOptions,
  work: () => Promise<T>,
  beforeEffects?: () => void,
  preEffectFailure?: (error: unknown) => void,
): Promise<T> {
  const scope: CreationCommitContext = {
    options,
    active: true,
    beforeEffects,
    preEffectFailure,
  };
  try {
    return await context.run(scope, work);
  } finally {
    scope.active = false;
  }
}

/** Enter inside the existing workspace mutation queue, which covers application. */
export async function commitWorkspaceCreation<T extends SidebarItem>(
  work: () => Promise<T>,
  workspaceIds: readonly string[] = [],
): Promise<T> {
  const scope = context.getStore();
  if (!scope?.active) return work();
  const locks: W5RepositoryLock[] = [
    { kind: 'index', path: w5RecordReadPaths.index() },
    ...workspaceIds.map(
      (id): W5RepositoryLock => ({
        kind: 'manifest',
        path: w5RecordReadPaths.manifest(id),
      }),
    ),
    ...workspaceIds.map(
      (id): W5RepositoryLock => ({
        kind: 'list',
        path: w5RecordReadPaths.worktrees(id),
      }),
    ),
  ];
  // Publication precedes activation/reconciliation and the final response.
  // Keep the keyed reservation open; the boundary records its outcome last.
  const publication: W5CommitOptions = {
    operation: scope.options.operation,
    expectedRevisions: scope.options.expectedRevisions,
    beforeDecision: scope.options.beforeDecision,
    reservationId: scope.identityReservationId,
  };
  const result = await commitW5BoundaryStep(publication, locks, work);
  scope.options.expectedRevisions = publication.expectedRevisions;
  return result;
}

/** Pending identities are never reused, even if interruption preceded mkdir. */
export async function pendingWorkspaceCreationIds(): Promise<string[]> {
  const reservations = (await getW5IdentityStore()?.readReservations()) ?? [];
  return reservations.flatMap((entry) => {
    const parsed = workspaceCreationDiagnosticsSchema.safeParse(
      entry.diagnostics,
    );
    return parsed.success ? [parsed.data.workspaceId] : [];
  });
}

/** One identity across short queued preparation and provisioning outside the queue. */
export interface WorkspaceCreationReservation {
  prepare<T>(work: () => Promise<T>): Promise<T>;
  run<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Drop this identity after its failed creation's owned effects were proven
   * removed, like a pre-effect refusal. Refuses while creation still runs,
   * and once the identity is published or awaiting recovery.
   */
  releaseRemoved(this: void): Promise<void>;
}

/** Reserve through the existing log before the first owned effect, keyed or not.
 * The canonical publication consumes this identity in its file decision. The
 * caller's optional keyed reservation still owns its final post-hook receipt.
 * An uncertain failure keeps files and this record for launch recovery.
 */
export async function reserveWorkspaceCreation(
  workspaceId: string,
  ownedPaths: string[],
  options?: WorkspaceCreationReservationOptions,
): Promise<WorkspaceCreationReservation> {
  validateId(workspaceId, 'workspaceId');
  const store = getW5IdentityStore();
  if (!store)
    return {
      prepare: (work) => work(),
      run: (work) => work(),
      releaseRemoved: () => Promise.resolve(),
    };
  const parent = context.getStore();
  const reservationId = randomUUID();
  const diagnostics: WorkspaceCreationDiagnostics = {
    kind: 'local-workspace-create',
    workspaceId,
    ownedPaths,
    phase: 'before-canonical-commit',
  };
  await store.reserve({
    // Filesystem-impossible historical IDs still cannot be claimed as targets.
    ...(isW5CaptureWorkspaceId(workspaceId) && {
      workspaceIdentity: workspaceId,
      expectedWorkspaceRecords: options?.expectedWorkspaceRecords,
    }),
    reservationId,
    operation: parent?.active
      ? parent.options.operation
      : 'core.workspace.create',
    diagnostics,
  });
  if (parent?.active && !options?.releaseBeforeEffects)
    parent.beforeEffects?.();
  const scope: CreationCommitContext = {
    options: parent?.active
      ? parent.options
      : { operation: 'core.workspace.create' },
    beforeEffects: parent?.active ? parent.beforeEffects : undefined,
    active: true,
    identityReservationId: reservationId,
    diagnostics,
    preEffectFailure: parent?.active ? parent.preEffectFailure : undefined,
  };
  const execute = async <T>(
    work: () => Promise<T>,
    complete: boolean,
  ): Promise<T> => {
    let failed = false;
    try {
      return await context.run(scope, work);
    } catch (error) {
      failed = true;
      if (options?.releaseBeforeEffects && !scope.effectsStarted) {
        // No destination was acquired and no Git command started. Releasing the
        // identity must succeed before the keyed boundary may release its key.
        let released = false;
        try {
          await store.releaseReservation(reservationId);
          released = true;
        } catch {
          // An uncertain release retains the key for launch recovery.
        }
        if (released) scope.preEffectFailure?.(error);
      }
      throw error;
    } finally {
      if (complete || failed) scope.active = false;
    }
  };
  return {
    prepare: (work) => execute(work, false),
    run: (work) => execute(work, true),
    releaseRemoved: async (): Promise<void> => {
      if (scope.active)
        throw new Error('A running workspace creation cannot be released');
      await store.releaseReservation(reservationId);
    },
  };
}

/** Existing local creates keep their full provisioning scope unchanged. */
export async function withLocalWorkspaceCreation<T>(
  workspaceId: string,
  ownedPaths: string[],
  work: () => Promise<T>,
  options?: WorkspaceCreationReservationOptions,
): Promise<T> {
  const reservation = await reserveWorkspaceCreation(
    workspaceId,
    ownedPaths,
    options,
  );
  return reservation.run(work);
}

/** A replacement create must not claim a pending operation's planned paths. */
export async function pendingWorkspaceCreationPaths(): Promise<string[]> {
  const reservations = (await getW5IdentityStore()?.readReservations()) ?? [];
  return reservations.flatMap((entry) => {
    const parsed = workspaceCreationDiagnosticsSchema.safeParse(
      entry.diagnostics,
    );
    return parsed.success ? parsed.data.ownedPaths : [];
  });
}

/** A dangling symlink or unreadable entry cannot prove an identity free. */
export async function workspaceCreationPathOccupied(
  path: string,
): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}
