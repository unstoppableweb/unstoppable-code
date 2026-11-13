import * as shared from '@canopy/desktop-shared/lib/shared-import/public-share-plugin-install';
import type { AfterPort } from '@canopy/desktop-shared/lib/shared-import/port';
import { rendererSharedImportPort } from './sharedImportPort';

// The import lives in desktop-shared so Electron main imports the same way
// (CAN-6003); the window binds its own preload APIs.
export {
  type SharedPluginInstallOutcome,
  type SharedPluginInstallTarget,
} from '@canopy/desktop-shared/lib/shared-import/public-share-plugin-install';

export function findInstalledSharedPluginTarget(
  ...args: AfterPort<Parameters<typeof shared.findInstalledSharedPluginTarget>>
): ReturnType<typeof shared.findInstalledSharedPluginTarget> {
  return shared.findInstalledSharedPluginTarget(
    rendererSharedImportPort(),
    ...args,
  );
}

export function installSharedPluginRef(
  ...args: AfterPort<Parameters<typeof shared.installSharedPluginRef>>
): ReturnType<typeof shared.installSharedPluginRef> {
  return shared.installSharedPluginRef(rendererSharedImportPort(), ...args);
}

export function installSharedPluginRefWithOutcome(
  ...args: AfterPort<
    Parameters<typeof shared.installSharedPluginRefWithOutcome>
  >
): ReturnType<typeof shared.installSharedPluginRefWithOutcome> {
  return shared.installSharedPluginRefWithOutcome(
    rendererSharedImportPort(),
    ...args,
  );
}
