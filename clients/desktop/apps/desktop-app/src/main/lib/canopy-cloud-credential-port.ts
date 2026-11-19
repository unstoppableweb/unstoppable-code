import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type {
  CloudCredentialPort,
  CloudCredentialQuarantine,
  CloudCredentialRead,
  CloudCredentialReadCache,
  CloudCredentialRecovery,
} from '@canopy/core-runtime/node/cloud-account';
import type { SecureStorageFailure } from '@canopy/desktop-shared/types';
import { writeFileAtomically } from './atomic-file';
import { logMainProcessWarn } from './main-process-logging';
import {
  getCanopyCloudAccountFilePath,
  getInternalLegacySharedCanopyCloudAccountFilePath,
  getLegacyCanopyCloudAccountFilePath,
} from './paths';
import { migrateSecureStorageFile } from './secure-storage-migration';
import type { SafeStorageStatus } from './safe-storage';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
} from './secure-storage-policy';
import { isErrnoException } from './type-guards';

const CLOUD_DISPLAY_NAME = `${BRAND.displayName} Cloud`;

export const CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR = `Secure storage is unavailable for ${CLOUD_DISPLAY_NAME} credentials.`;

export type CanopyCloudCredentialPort<TRecord> = CloudCredentialPort<
  TRecord,
  SecureStorageFailure,
  SafeStorageStatus
>;

export function assertCanopyCloudStorageWritable(): void {
  try {
    getSecretStoragePolicy().assertCanWrite();
  } catch (error) {
    const secureStorageFailure = getSecureStorageFailure(error);
    if (!secureStorageFailure) throw error;
    throw Object.assign(new Error(CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR), {
      secureStorageFailure,
    });
  }
}

function observedStorageBackend(): string {
  const status = getSecretStoragePolicy().getStatus();
  return JSON.stringify([hostOperatingSystem(), status.backend]);
}

function buildRecoveryBackupPath(filePath: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/,
      '$1$2$3-$4$5$6-$7Z',
    );
  return `${filePath}.bak-${timestamp}-${randomBytes(8).toString('hex')}`;
}

async function chooseUnusedRecoveryBackupPath(
  filePath: string,
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = buildRecoveryBackupPath(filePath);
    try {
      await access(candidate);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return candidate;
      }
      throw error;
    }
  }
  throw new Error('Unable to reserve a unique secure account backup name.');
}

/**
 * The Electron-main implementation over the encrypted account file. It is the
 * only module that reads or writes the file, its legacy copies and their
 * encryption; `normalize` turns decrypted JSON into a record or rejects it.
 */
export function createCanopyCloudCredentialPort<TRecord>(
  normalize: (value: unknown) => TRecord | null,
): CanopyCloudCredentialPort<TRecord> {
  const decode = (encrypted: Buffer): TRecord => {
    const normalized = normalize(
      JSON.parse(getSecretStoragePolicy().decrypt(encrypted)),
    );
    if (!normalized) {
      throw new Error(`Invalid stored ${CLOUD_DISPLAY_NAME} account entry.`);
    }
    return normalized;
  };
  const encode = (record: TRecord): Buffer =>
    getSecretStoragePolicy().encrypt(JSON.stringify(record));

  const read = async (
    cache?: CloudCredentialReadCache<TRecord>,
  ): Promise<CloudCredentialRead<TRecord, SecureStorageFailure>> => {
    try {
      // A held cache never grants permission to expose unreadable credentials.
      getSecretStoragePolicy().assertCanRead();
      const backend = observedStorageBackend();
      const cached = cache?.get(backend);
      if (cached !== undefined) return { status: 'ok', record: cached };

      const filePath = getCanopyCloudAccountFilePath();
      const migration = await migrateSecureStorageFile<TRecord>({
        currentPath: filePath,
        legacyPath: getInternalLegacySharedCanopyCloudAccountFilePath(),
        decode,
        encode,
        storeKind: 'cloud-account',
        beforeWrite: async () => {
          await mkdir(dirname(filePath), { recursive: true });
          assertCanopyCloudStorageWritable();
        },
        writeOptions: { mode: 0o600 },
      });
      if (
        migration.status === 'storage-error' ||
        migration.status === 'current-error'
      )
        throw migration.error;
      if (migration.status === 'unavailable') {
        getSecretStoragePolicy().assertCanRead();
        throw new Error(CANOPY_CLOUD_STORAGE_UNAVAILABLE_ERROR);
      }
      if (migration.status === 'foreign-legacy-skipped') {
        if (!migration.secureStorageFailure) {
          throw new Error(
            `Invalid stored ${CLOUD_DISPLAY_NAME} account entry.`,
          );
        }
        // Foreign identity data is not our account. Do not cache absence, so
        // changing back to the original backend can still recover the source.
        return { status: 'ok', record: null };
      }
      let normalized =
        migration.status === 'current' ||
        migration.status === 'migrated' ||
        migration.status === 'legacy-decoded-write-deferred'
          ? migration.value
          : null;
      if (!normalized) {
        normalized = decode(
          await readFile(getLegacyCanopyCloudAccountFilePath()),
        );
      }
      // Retry deferred migrations on the next ordinary read, not just at TTL.
      if (migration.status !== 'legacy-decoded-write-deferred')
        cache?.set(normalized, backend);
      return {
        status: 'ok',
        record: normalized,
        ...(migration.status === 'legacy-decoded-write-deferred' &&
        migration.secureStorageFailure
          ? { migrationWriteFailure: migration.secureStorageFailure }
          : {}),
      };
    } catch (error) {
      const secureStorageFailure = getSecureStorageFailure(error);
      if (secureStorageFailure)
        return secureStorageFailure.code === 'SECURE_STORAGE_DECRYPT_FAILED' &&
          !secureStorageFailure.retryable
          ? { status: 'error', error, failure: secureStorageFailure }
          : { status: 'unavailable', error, failure: secureStorageFailure };
      if (isErrnoException(error) && error.code === 'ENOENT') {
        cache?.set(null, observedStorageBackend());
        return { status: 'ok', record: null };
      }
      logMainProcessWarn(
        '[canopy-cloud-account-store] Failed to decrypt account file:',
        { reason: error instanceof Error ? error.name : 'unknown' },
      );
      return { status: 'error', error };
    }
  };

  const write = async (record: TRecord): Promise<string> => {
    const backend = observedStorageBackend();
    const encrypted = encode(record);
    const filePath = getCanopyCloudAccountFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    assertCanopyCloudStorageWritable();
    await writeFileAtomically(filePath, encrypted, { mode: 0o600 });
    await rm(getLegacyCanopyCloudAccountFilePath(), { force: true }).catch(
      () => undefined,
    );
    return backend;
  };

  const clear = async (): Promise<void> => {
    await rm(getLegacyCanopyCloudAccountFilePath(), { force: true });
    await rm(getCanopyCloudAccountFilePath(), { force: true }).catch(
      (error: unknown) => {
        logMainProcessWarn(
          '[canopy-cloud-account-store] Failed to remove account file:',
          { reason: error instanceof Error ? error.name : 'unknown' },
        );
        throw error;
      },
    );
  };

  const inspectForRecovery = async (): Promise<
    CloudCredentialRecovery<TRecord>
  > => {
    getSecretStoragePolicy().assertCanRead();
    let filePath = getCanopyCloudAccountFilePath();
    let encrypted: Buffer;
    try {
      encrypted = await readFile(filePath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
      filePath = getLegacyCanopyCloudAccountFilePath();
      try {
        encrypted = await readFile(filePath);
      } catch (legacyError) {
        if (isErrnoException(legacyError) && legacyError.code === 'ENOENT') {
          return { status: 'absent' };
        }
        throw legacyError;
      }
    }

    try {
      return { status: 'readable', record: decode(encrypted) };
    } catch (error) {
      const failure = getSecureStorageFailure(error);
      if (
        failure &&
        (failure.code !== 'SECURE_STORAGE_DECRYPT_FAILED' ||
          failure.state === 'unavailable' ||
          failure.state === 'locked')
      )
        throw error;
      // Explicit recovery preserves unreadable bytes, including ciphertext
      // encrypted under a lost key, by renaming them to a backup.
    }

    const unreadablePath = filePath;
    return {
      status: 'unreadable',
      prepareQuarantine: async (): Promise<CloudCredentialQuarantine> => {
        const backupPath = await chooseUnusedRecoveryBackupPath(unreadablePath);
        return {
          backupFileName: basename(backupPath),
          move: () => rename(unreadablePath, backupPath),
        };
      },
    };
  };

  return {
    read,
    write,
    clear,
    inspectForRecovery,
    isWritable: () => getSecretStoragePolicy().isWriteAvailable(),
    storageStatus: () => getSecretStoragePolicy().getStatus(),
    assertWritable: assertCanopyCloudStorageWritable,
    backendKey: observedStorageBackend,
  };
}
