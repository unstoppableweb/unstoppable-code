import {
  bindW5Storage,
  type W5StorageAdmission,
} from '@canopy/core-runtime/node/w5/storage-binding';
import {
  withStorageAdmission as admitSharedStorage,
  withStorageAuthorityAdmission,
} from '@canopy/execution-engine/node/lib/storage-admission';
import { W5_FLIP_NAMESPACES } from './w5-flip-gate';
import type { AtomicFileStorage } from './atomic-file';

export const withStorageAdmission: W5StorageAdmission = (targets, operation) =>
  withStorageAuthorityAdmission(W5_FLIP_NAMESPACES, () =>
    admitSharedStorage(targets, operation),
  );

// Desktop main's W5 writer principal (CAN-3880).
const storage = bindW5Storage('electron_main', withStorageAdmission);

export const WORKSPACE_INDEX_STORAGE: AtomicFileStorage =
  storage.workspaceIndex;
export const WORKSPACE_MANIFEST_STORAGE: AtomicFileStorage =
  storage.workspaceManifest;
export const WORKTREE_LIST_STORAGE: AtomicFileStorage = storage.worktreeList;
/**
 * Every W5 namespace. Cowork operations admit it too: the sidebar writer
 * rewrites each repository sibling's worktree list.
 */
export const PROJECT_W5_STORAGE: AtomicFileStorage[] = storage.project;
/** The bound admission the commit-log store admits staged scopes through. */
export const admitW5Storage: W5StorageAdmission = storage.admit;
