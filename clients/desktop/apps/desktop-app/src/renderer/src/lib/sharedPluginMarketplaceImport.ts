import * as shared from '@canopy/desktop-shared/lib/shared-import/shared-plugin-marketplace-import';
import type { AfterPort } from '@canopy/desktop-shared/lib/shared-import/port';
import { rendererSharedImportPort } from './sharedImportPort';

// The import lives in desktop-shared so Electron main imports the same way
// (CAN-6003); the window binds its own preload APIs.
export {
  findBuiltInMarketplace,
  findMarketplaceByRepo,
  type ImportedSharedPluginRef,
} from '@canopy/desktop-shared/lib/shared-import/shared-plugin-marketplace-import';

export function importSharedMarketplacePlugin(
  ...args: AfterPort<Parameters<typeof shared.importSharedMarketplacePlugin>>
): ReturnType<typeof shared.importSharedMarketplacePlugin> {
  return shared.importSharedMarketplacePlugin(
    rendererSharedImportPort(),
    ...args,
  );
}
