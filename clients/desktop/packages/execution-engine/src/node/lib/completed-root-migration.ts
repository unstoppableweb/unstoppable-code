import { homedir } from 'node:os';
import { hasDataDirectoryOverride } from '@canopy/core-runtime/node/build-identity';
import { getCanopyBuildIdentity, getCanopyDataDir } from '../../canopy-paths';

export interface CompletedRootMigration {
  source: string;
  destination: string;
  transactionId: string;
  completedAtMs: number;
}

// Migration is cold-only: evidence cannot change while an admitted host runs.
const migrations = new Map<
  string,
  Promise<CompletedRootMigration | undefined>
>();

/** Only the validated journal can authorize a retained-root path replacement. */
export async function getCompletedRootMigration(): Promise<
  CompletedRootMigration | undefined
> {
  const identity = getCanopyBuildIdentity();
  if (identity.build !== 'internal' || hasDataDirectoryOverride(process.env))
    return undefined;
  const destination = getCanopyDataDir();
  const key = JSON.stringify([identity.brandId, destination]);
  let pending = migrations.get(key);
  if (!pending) {
    pending = readCompletedRootMigration(identity, destination).catch(
      (error: unknown) => {
        migrations.delete(key);
        throw error;
      },
    );
    migrations.set(key, pending);
  }
  return pending;
}

async function readCompletedRootMigration(
  identity: ReturnType<typeof getCanopyBuildIdentity>,
  destination: string,
): Promise<CompletedRootMigration | undefined> {
  const { canonicalStoragePath, readInternalRootStartup } =
    await import('@canopy/core-platform/build-storage-startup');
  let completed: CompletedRootMigration | undefined;
  const status = readInternalRootStartup({
    home: canonicalStoragePath(homedir()),
    identity,
    onCompletedMigration: (migration) => {
      completed = migration;
    },
  });
  if (status === 'fresh' || status === 'required' || status === 'stable-owned')
    return undefined;
  if (status !== 'complete' || completed?.destination !== destination) {
    throw new Error(
      'The completed migration location could not be verified. Preserve both roots and the migration journal before continuing work.',
    );
  }
  return completed;
}
