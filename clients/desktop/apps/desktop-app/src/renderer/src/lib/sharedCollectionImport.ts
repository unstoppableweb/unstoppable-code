import * as shared from '@canopy/desktop-shared/lib/shared-import/shared-collection-import';
import type { AfterPort } from '@canopy/desktop-shared/lib/shared-import/port';
import { rendererSharedImportPort } from './sharedImportPort';

// The import lives in desktop-shared so Electron main imports the same way
// (CAN-6003); the window binds its own preload APIs.
export {
  type SharedCollectionImportResolution,
  type SharedCollectionImportSource,
  type SharedCollectionMemberFailure,
} from '@canopy/desktop-shared/lib/shared-import/shared-collection-import';

export function resolveSharedCollectionImport(
  ...args: AfterPort<Parameters<typeof shared.resolveSharedCollectionImport>>
): ReturnType<typeof shared.resolveSharedCollectionImport> {
  return shared.resolveSharedCollectionImport(
    rendererSharedImportPort(),
    ...args,
  );
}
