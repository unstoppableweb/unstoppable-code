import {
  type StoredWorkspaceIndexRepository as CoreStoredWorkspaceIndexRepository,
  type WorkspaceIndexChange as CoreWorkspaceIndexChange,
  type WorkspaceIndexRepository as CoreWorkspaceIndexRepository,
  type WorkspaceIndexSnapshot as CoreWorkspaceIndexSnapshot,
  type WorkspaceIndexStoredSnapshot as CoreWorkspaceIndexStoredSnapshot,
} from '@canopy/core-runtime/node/w5/workspace-index-repository';
import { isActivitySectionId } from '@canopy/desktop-shared/constants/activity';
import type {
  ActivitySectionId,
  ProjectData,
  WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';

export {
  WorkspaceIndexUnreadableError,
  type StoredWorkspaceIndexFields,
  type WorkspaceIndexAuthority,
} from '@canopy/core-runtime/node/w5/workspace-index-repository';

export type WorkspaceIndexSnapshot =
  CoreWorkspaceIndexSnapshot<WorkspaceIndexEntry>;
export type WorkspaceIndexChange<T> = CoreWorkspaceIndexChange<
  T,
  WorkspaceIndexEntry
>;
export type WorkspaceIndexRepository =
  CoreWorkspaceIndexRepository<WorkspaceIndexEntry>;
export type WorkspaceIndexStoredSnapshot =
  CoreWorkspaceIndexStoredSnapshot<WorkspaceIndexEntry>;
export type StoredWorkspaceIndexRepository =
  CoreStoredWorkspaceIndexRepository<WorkspaceIndexEntry>;
export function normalizeActivitySectionOrder(
  value: unknown,
): ProjectData['activitySectionOrder'] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.filter(
    (entry): entry is ActivitySectionId =>
      typeof entry === 'string' && isActivitySectionId(entry),
  );
  return normalized.length > 0 ? normalized : undefined;
}
