import { lstat, mkdir, rmdir } from 'node:fs/promises';
import { KeyedAsyncLock } from './keyed-async-lock';
import { isErrnoException } from './type-guards';

export interface WorktreeMetadataIdentity {
  dev: number;
  ino: number;
}

// Electron-main only: detached creates and source-apply allocations share this
// guard. It does not coordinate independent processes or filesystem tools.
// Keep admission, publication and Git outside it; never nest a same-path claim.
const metadataReservationLocks = new KeyedAsyncLock();

export async function ensureWorktreeMetadataDirectory(
  metadataDir: string,
): Promise<void> {
  // Preserve base recursive ensure-existing: exclusive claims would refuse working
  // source applies. Revisit shared-ID ownership with CAN-4097.
  await metadataReservationLocks.run(metadataDir, async () => {
    await mkdir(metadataDir, { recursive: true });
  });
}

export async function claimWorktreeMetadataDirectory(
  metadataDir: string,
  onReserved?: () => void,
  captureIdentity = false,
): Promise<WorktreeMetadataIdentity | undefined> {
  return metadataReservationLocks.run(metadataDir, async () => {
    try {
      await mkdir(metadataDir, { recursive: false });
    } catch (error) {
      // EEXIST is a collision, not an uncertain allocation; keep its retry path.
      if (!isErrnoException(error) || error.code !== 'EEXIST') {
        const absent = await lstat(metadataDir).then(
          () => false,
          (probeError: unknown) =>
            isErrnoException(probeError) && probeError.code === 'ENOENT',
        );
        if (!absent) {
          try {
            onReserved?.();
          } catch {
            // Preserve the mkdir error even if marking uncertainty fails.
          }
        }
      }
      throw error;
    }
    onReserved?.();
    // Cleanup proof must not become admission for an otherwise usable id.
    return captureIdentity
      ? lstat(metadataDir).catch(() => undefined)
      : undefined;
  });
}

export async function removeEmptyWorktreeMetadataDirectory(
  metadataDir: string,
  identity: WorktreeMetadataIdentity | undefined,
): Promise<void> {
  await metadataReservationLocks.run(metadataDir, async () => {
    const current = await lstat(metadataDir).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!current) return;
    if (
      !identity ||
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new Error('Worktree metadata reservation identity changed');
    // Before publication the directory is empty. Never recursively remove
    // material another actor may have placed here while admission ran.
    await rmdir(metadataDir).catch((error: unknown) => {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    });
  });
}
