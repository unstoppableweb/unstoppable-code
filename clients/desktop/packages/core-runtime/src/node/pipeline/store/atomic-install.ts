import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  STORAGE_OWNERSHIP,
  StorageOutcomeUnknownError,
  assertAdmittedWriter,
  type StorageOwnershipRow,
  type StorageWriterPrincipal,
} from '../../../storage';

/** The row, principal and module a durable install claims for admission. */
export interface DurableInstallClaim {
  readonly namespace:
    | 'pipeline_definitions'
    | 'pipeline_local_metadata'
    | 'pipeline_data';
  readonly writer: StorageWriterPrincipal;
  readonly module: string;
  readonly ownership?: readonly StorageOwnershipRow[];
}

const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80] as const;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object'
    ? String(Reflect.get(error, 'code'))
    : '';
}

/** Retries transient sharing violations; never deletes the destination. */
export function renameWithRetry(source: string, target: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error))
      )
        throw error;
      sleepSync(delay);
    }
  }
}

/**
 * The daemon's durable install for the definitions store (CAN-5092), with
 * execution-engine's synchronous atomic writer's install semantics: the
 * claim is admitted before anything is written, a complete sibling file is
 * synced and renamed over the target, then its folder is flushed through
 * the host's platform flush. A failed flush after the rename rejects with a
 * storage outcome-unknown error; any earlier failure removes the sibling and
 * leaves the target as it was. It does not register W5 root presence, which
 * must be settled before the daemon path is switched on.
 */
export function createDurableAtomicInstall(
  flushDirectorySync: (directory: string) => void,
): (
  filePath: string,
  data: string | Uint8Array,
  claim: DurableInstallClaim,
  mode?: number,
) => void {
  return (filePath, data, claim, mode): void => {
    assertAdmittedWriter(
      claim.namespace,
      claim.writer,
      claim.module,
      claim.ownership ?? STORAGE_OWNERSHIP,
    );
    const tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let installed = false;
    try {
      const fd = openSync(tempPath, 'wx', mode);
      try {
        writeFileSync(
          fd,
          data,
          typeof data === 'string' ? { encoding: 'utf8' } : {},
        );
        if (mode !== undefined) {
          try {
            fchmodSync(fd, mode);
          } catch {
            // The creation mode already applies.
          }
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameWithRetry(tempPath, filePath);
      installed = true;
    } finally {
      if (!installed) {
        try {
          unlinkSync(tempPath);
        } catch {
          // The sibling may never have been created.
        }
      }
    }
    try {
      flushDirectorySync(dirname(filePath));
    } catch (error) {
      throw new StorageOutcomeUnknownError('directory_flush', error);
    }
  };
}
