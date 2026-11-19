import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  filesystemSnapshotFailure,
  isFilesystemSnapshotUnavailable,
  readFilesystemScope,
  type FilesystemEntryMutationHost,
  type FilesystemScopeResolver,
} from '@canopy/core-runtime/node';

/** Trusted roots; admission stays closed until split locks and holds are shared. */
export function createDaemonFilesystemWriteHost(
  resolveScope: FilesystemScopeResolver,
): FilesystemEntryMutationHost {
  const roots: FilesystemEntryMutationHost['roots'] = async (scope) => {
    try {
      const dependencies = await resolveScope(scope, 'directory');
      // As in Files read snapshots, visibility hides empty attachments, not trusted roots.
      const catalog = await readFilesystemScope(
        scope,
        { ...dependencies, rootVisibility: () => Promise.resolve(true) },
        'directory',
      );
      return catalog.roots.map((root) => ({
        fileRootId: root.id,
        absolutePath: root.absolutePath,
        excludedDescendantRoots: root.excludedDescendantRoots,
      }));
    } catch (error) {
      // A catalog the system refused to read is not a missing root.
      if (isFilesystemSnapshotUnavailable(error))
        throw filesystemSnapshotFailure(error);
      if (
        !(error instanceof CanopyOperationError) ||
        !/^worker\.filesystem\.(roots|directory)\.(notFound|invalidState)$/.test(
          error.payload.code ?? '',
        )
      )
        throw error;
      // Scope readers emit only notFound/invalidState; retain their kind and retry.
      throw new CanopyOperationError(
        { ...error.payload, code: 'worker.filesystem.root.notFound' },
        error.runtimeCause,
      );
    }
  };
  return {
    os: hostPlatformOperatingSystem(),
    roots,
    assertMutable: async (scope) => {
      await roots(scope);
      // Split locks, Auto Delete reservations and activity still live in Electron.
      throw new CanopyOperationError({
        kind: 'failed_precondition',
        message: 'Filesystem write admission is not available in this host.',
        retry: { kind: 'never' },
      });
    },
  };
}
