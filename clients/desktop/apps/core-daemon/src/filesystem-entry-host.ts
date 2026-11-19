import { CanopyOperationError } from '@canopy/core-runtime';
import {
  readFilesystemScope,
  type FilesystemEntryMutationHost,
  type FilesystemEntryRoot,
  type FilesystemScopeResolver,
} from '@canopy/core-runtime/node';
import type { CanopyWorkspaceScope } from '@canopy/protocol/canopy-core';

/** Trusted roots; split-lock and viewer read-only pre-checks stay in Electron (CAN-4730). */
export function createDaemonEntryMutationHost(
  options: Pick<FilesystemEntryMutationHost, 'os' | 'trash'> & {
    readonly resolveScope: FilesystemScopeResolver;
  },
): FilesystemEntryMutationHost {
  const roots = async (
    scope: CanopyWorkspaceScope,
  ): Promise<readonly FilesystemEntryRoot[]> => {
    try {
      const dependencies = await options.resolveScope(scope, 'roots');
      return (await readFilesystemScope(scope, dependencies)).roots.map(
        (root) => ({
          fileRootId: root.id,
          absolutePath: root.absolutePath,
          excludedDescendantRoots: root.excludedDescendantRoots,
        }),
      );
    } catch (error) {
      if (!(error instanceof CanopyOperationError)) throw error;
      // The read codes are not entry codes, and copy accepts fewer than move.
      const payload = { ...error.payload };
      delete payload.code;
      throw new CanopyOperationError({
        ...payload,
        ...(payload.kind === 'not_found' && {
          code: 'worker.filesystem.root.notFound',
        }),
      });
    }
  };
  return {
    os: options.os,
    ...(options.trash && { trash: options.trash }),
    // The engines resolve trusted roots before effects. Doing that here too
    // would put root lookup before the absent-Trash refusal.
    assertMutable: (): void => undefined,
    roots,
  };
}
