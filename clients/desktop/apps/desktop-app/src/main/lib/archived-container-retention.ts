import { readdir } from 'node:fs/promises';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import {
  APP_ADVISOR_PROJECT_ID,
  type ArchivedContainerManifest,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  isArchivedContainerExpired,
  resolveArchiveRetentionDays,
} from '@canopy/desktop-shared/lib/archive-retention';
import {
  notifyLedgerContainerPurged,
  notifyLedgerContainerRestored,
  recordLedgerRestoreIntent,
} from '../ledger/lifecycle';
import {
  ledgerIncarnationRetiredByPurge,
  ledgerRestoreMappingOf,
} from '../ledger/lifecycle-containers';
import { readAppAdvisorWorkspaceSettings } from './app-advisor-workspace';
import {
  listArchivedContainerManifests,
  purgeArchivedContainer,
  removeIncompleteArchivedContainers,
  withArchivedWorkspaceOperationLock,
} from './archived-containers';
import { getWorkspacesRootDir } from './paths';
import { isErrnoException } from './type-guards';
import { validateId } from './validation';
import { readWorkspaceConfig } from './workspace-persistence';
import {
  reconcileArchivedGitRefsForWorkspace,
  recoverArchivedGitTeardownsForWorkspace,
} from './archived-container-git';
import { hasUnresolvedDestructiveRecovery } from './w5-destructive-recovery';

export { DEFAULT_ARCHIVE_RETENTION_DAYS };

const DAY_MS = 24 * 60 * 60 * 1_000;
const INCOMPLETE_CAPTURE_MAX_AGE_MS = DAY_MS;
const RETENTION_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1_000;

/**
 * Days a "Deleted" container in `projectId` is kept before the sweep removes
 * it. Deletion retention is always on, so this never resolves to "off".
 */
export async function resolveContainerRetentionDays(
  projectId: string,
): Promise<number> {
  validateId(projectId, 'projectId');
  if (isBotProjectId(projectId)) {
    const settings = await readAppAdvisorWorkspaceSettings();
    return resolveArchiveRetentionDays(
      'app-advisor',
      settings.archiveRetentionDays,
    );
  }
  const config = await readWorkspaceConfig(projectId);
  const surface: WorkspaceType = config.type;
  return resolveArchiveRetentionDays(
    surface,
    surface === 'cowork'
      ? config.cowork?.archiveRetentionDays
      : config.archiveRetentionDays,
  );
}

export function createArchivedContainerTiming(
  retentionDays: number,
  now = Date.now(),
): { archivedAt: string; expiresAt: string } {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > MAX_ARCHIVE_RETENTION_DAYS
  ) {
    throw new Error(
      `Archive retention must be an integer from 1 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  }
  const archivedAt = new Date(now);
  const expiresAt = new Date(now + retentionDays * DAY_MS);
  if (
    !Number.isFinite(archivedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    throw new Error('Archive retention dates must be representable');
  }
  return {
    archivedAt: archivedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

async function listWorkspaceIds(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(getWorkspacesRootDir(), { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      // Default Bot only: the only Bot until the Bot registry lists the rest.
      return [APP_ADVISOR_PROJECT_ID];
    }
    throw error;
  }
  // Default Bot only: the only Bot until the Bot registry lists the rest.
  const ids = new Set<string>([APP_ADVISOR_PROJECT_ID]);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      validateId(entry.name, 'workspaceId');
      ids.add(entry.name);
    } catch {
      // Ignore directories that cannot be addressed through workspace APIs.
    }
  }
  return Array.from(ids);
}

async function retryTemporaryWorkspaceCleanup(
  projectId: string,
): Promise<void> {
  if (isBotProjectId(projectId)) return;
  // Break the retention ↔ worktree-service initialization cycle; cleanup is
  // needed only after a purge makes a temporary workspace removable.
  const { retryDeferredTemporaryWorkspaceDeletion } =
    await import('./worktree-service');
  await retryDeferredTemporaryWorkspaceDeletion(projectId).catch(() => null);
}

/**
 * Tells the Ledger that retention purged an archived container, so its scope
 * retires. The participant returns at once, so no archive lock is held while
 * it waits on Ledger storage.
 */
function notifyLedgerOfPurge(manifest: ArchivedContainerManifest): void {
  try {
    const retired = ledgerIncarnationRetiredByPurge(manifest);
    if (retired !== null) notifyLedgerContainerPurged(retired);
  } catch {
    // The participant never throws. A defect in it must not fail the sweep;
    // startup reconciliation settles the scope.
  }
}

/**
 * Before retention removes a partially restored archive, whose `restoredTo`
 * may still be the only lasting record of where its Ledger scope belongs,
 * makes that mapping durable in the Ledger intent journal and queues the
 * reattach. True when the archive may go; false keeps it for the next run.
 * Waits a bounded time, and only when the Ledger database exists.
 */
async function secureLedgerRestoreMapping(
  manifest: ArchivedContainerManifest,
): Promise<boolean> {
  try {
    const mapping = ledgerRestoreMappingOf(manifest);
    if (mapping === null) return true;
    const recording = await recordLedgerRestoreIntent(
      mapping.archived,
      mapping.restored,
    );
    if (recording === 'not_durable') return false;
    notifyLedgerContainerRestored(mapping.archived, mapping.restored);
    return true;
  } catch {
    return false;
  }
}

/**
 * How long a listing leaves an expired container whose purge threw before it
 * tries again. The startup and periodic sweep always retries. In memory only:
 * a relaunch retries everything.
 */
const EXPIRED_PURGE_RETRY_COOLDOWN_MS = 60 * 60 * 1_000;

/** `projectId/containerId` -> wall-clock time of the last thrown purge. */
const failedExpiredPurges = new Map<string, number>();

function expiredPurgeKey(projectId: string, containerId: string): string {
  return `${projectId}/${containerId}`;
}

function isInExpiredPurgeCooldown(key: string, nowMs: number): boolean {
  const failedAtMs = failedExpiredPurges.get(key);
  if (failedAtMs === undefined) return false;
  const ageMs = nowMs - failedAtMs;
  // A negative age means the clock moved back; treat the cooldown as elapsed.
  return ageMs >= 0 && ageMs < EXPIRED_PURGE_RETRY_COOLDOWN_MS;
}

/**
 * Whether any of these expired containers is due a purge attempt: false when
 * the list is empty or every one failed within the cooldown. Also forgets
 * failures for this project's containers that are no longer expired-listed,
 * so the record stays bounded.
 */
export function hasExpiredPurgeToAttempt(
  projectId: string,
  containerIds: readonly string[],
): boolean {
  const listed = new Set(
    containerIds.map((containerId) => expiredPurgeKey(projectId, containerId)),
  );
  const prefix = `${projectId}/`;
  for (const key of [...failedExpiredPurges.keys()]) {
    if (key.startsWith(prefix) && !listed.has(key)) {
      failedExpiredPurges.delete(key);
    }
  }
  const nowMs = Date.now();
  for (const key of listed) {
    if (!isInExpiredPurgeCooldown(key, nowMs)) return true;
  }
  return false;
}

/**
 * Purges the workspace's expired archived containers. It lists and decides
 * under the archive operation lock that restore and purge also take, so each
 * decision rests on the manifest as it is: a restore cannot commit
 * `restoredTo`, nor a lock or unlock change expiry, between the read and the
 * purge.
 */
export async function purgeExpiredArchivedContainersForWorkspace(
  projectId: string,
  now = Date.now(),
  options: { readonly skipRecentFailures?: boolean } = {},
): Promise<number> {
  validateId(projectId, 'projectId');
  const purged = await withArchivedWorkspaceOperationLock(
    projectId,
    async (): Promise<number> => {
      let count = 0;
      for (const manifest of await listArchivedContainerManifests(projectId)) {
        // Locked containers are exempt until the user unlocks them (which
        // also restarts the retention window from the unlock time).
        if (!isArchivedContainerExpired(manifest, now)) continue;
        // `now` is the expiry clock callers pass; failures are timed by the
        // wall clock.
        const failureKey = expiredPurgeKey(projectId, manifest.id);
        if (
          options.skipRecentFailures === true &&
          isInExpiredPurgeCooldown(failureKey, Date.now())
        ) {
          continue;
        }
        if (await hasUnresolvedDestructiveRecovery(projectId, manifest.id)) {
          continue;
        }
        // Keep it until its Ledger mapping is durable elsewhere.
        if (!(await secureLedgerRestoreMapping(manifest))) continue;
        try {
          const removed = await purgeArchivedContainer(projectId, manifest.id);
          failedExpiredPurges.delete(failureKey);
          if (removed) {
            count += 1;
            notifyLedgerOfPurge(manifest);
          }
        } catch (error) {
          failedExpiredPurges.set(failureKey, Date.now());
          // One inaccessible archive must not prevent other expired archives
          // from being purged or make archive listing fail.
          // eslint-disable-next-line no-console
          console.warn('Failed to purge expired archived container.', {
            projectId,
            containerId: manifest.id,
            error,
          });
        }
      }
      return count;
    },
  );
  if (purged > 0) await retryTemporaryWorkspaceCleanup(projectId);
  return purged;
}

export async function applyArchivedContainerRetention(
  now = Date.now(),
): Promise<void> {
  for (const projectId of await listWorkspaceIds()) {
    // Recovery re-enters normal worktree archival, whose activity fence must
    // drain queued touches before that operation acquires this project lock.
    await recoverArchivedGitTeardownsForWorkspace(projectId).catch(
      () => undefined,
    );
    await withArchivedWorkspaceOperationLock(projectId, async () => {
      await removeIncompleteArchivedContainers(
        projectId,
        INCOMPLETE_CAPTURE_MAX_AGE_MS,
        now,
      ).catch(() => 0);
      await purgeExpiredArchivedContainersForWorkspace(projectId, now).catch(
        () => 0,
      );
      await reconcileArchivedGitRefsForWorkspace(projectId).catch(
        (error: unknown) => {
          // eslint-disable-next-line no-console
          console.warn('Failed to reconcile archived Git refs.', {
            projectId,
            error,
          });
        },
      );
    });
  }
}

export function startArchivedContainerRetentionScheduler(): () => void {
  void applyArchivedContainerRetention().catch((error: unknown): void => {
    // eslint-disable-next-line no-console
    console.warn('Failed to apply archived-container retention.', error);
  });
  const timer = setInterval(() => {
    void applyArchivedContainerRetention().catch((error: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn('Failed to apply archived-container retention.', error);
    });
  }, RETENTION_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return (): void => clearInterval(timer);
}
