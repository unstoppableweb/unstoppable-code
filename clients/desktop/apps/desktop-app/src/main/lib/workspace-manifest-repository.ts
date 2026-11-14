import type { WorkspaceManifestRepository as CoreWorkspaceManifestRepository } from '@canopy/core-runtime/node/w5/workspace-manifest-repository';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';

export {
  WorkspaceConfigUnreadableError,
  type WorkspaceManifestRead,
} from '@canopy/core-runtime/node/w5/workspace-manifest-repository';

export type WorkspaceManifestRepository =
  CoreWorkspaceManifestRepository<WorkspaceConfigFile>;
