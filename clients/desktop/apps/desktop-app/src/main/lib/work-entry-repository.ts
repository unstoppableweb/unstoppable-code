import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createWorkEntryRepository,
  type WorkEntryRegistryReconciler,
} from '@canopy/core-runtime/node/work-entries';
import type { CoworkWorkEntryData } from '@canopy/desktop-shared/types';
import { renameWithRetry } from './atomic-file';
import { parseWorkEntriesFile } from './cowork-work-entries-file';
import { isPathInside } from './path-safety';
import { getWorkspaceDir, getWorkspaceWorkEntriesFilePath } from './paths';
import { publishSidebarItemGroupsChanged } from './sidebar-item-groups';
import { isErrnoException } from './type-guards';

export type { WorkEntryRegistryWriteOptions } from '@canopy/core-runtime/node/work-entries';

/*
 * The desktop composition of the Work Entry registry repository (CAN-4476):
 * the only module that imports the engine, and the only one that writes
 * work-entries.json. It binds the registry paths, node:fs and today's install
 * (sibling `.work-entries-<uuid>.tmp`, then atomic-file's rename).
 */

let registryReconciler:
  | WorkEntryRegistryReconciler<CoworkWorkEntryData>
  | undefined;

export function setWorkEntryRegistryReconciler(
  reconciler: WorkEntryRegistryReconciler<CoworkWorkEntryData>,
): void {
  registryReconciler = reconciler;
}

/** Called with the resolved workspace id after an entry-list write lands. */
export type WorkEntryListChangeListener = (workspaceId: string) => void;

const listChangeListeners = new Set<WorkEntryListChangeListener>();

/**
 * Observe structural changes to a workspace's Work Entry list — an entry
 * added, removed or moved — which shift every sibling's registry index. The
 * registry cannot import the Portal projection (import cycle), so the
 * projection registers here instead. Returns the unsubscribe function.
 */
export function onWorkEntryListChanged(
  listener: WorkEntryListChangeListener,
): () => void {
  listChangeListeners.add(listener);
  return (): void => {
    listChangeListeners.delete(listener);
  };
}

/** Fired after the registry lock settles; a listener can never fail a write. */
export function notifyWorkEntryListChanged(workspaceId: string): void {
  listChangeListeners.forEach((listener) => {
    try {
      listener(workspaceId);
    } catch {
      // Observers are best-effort mirrors of the durable registry write.
    }
  });
}

function isMissing(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
}

export const workEntryRepository = createWorkEntryRepository({
  registryPath: (workspaceId) => getWorkspaceWorkEntriesFilePath(workspaceId),
  io: {
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async mkdirParent(path) {
      await mkdir(dirname(path), { recursive: true });
    },
    tempPath: (path) =>
      join(dirname(path), `.work-entries-${randomUUID()}.tmp`),
    writeFile: (path, data) => writeFile(path, data, 'utf8'),
    // Late-bound: tests intercept the install by spying on atomic-file.
    rename: (source, target, options) =>
      renameWithRetry(source, target, options),
    unlink: (path) => unlink(path),
  },
  codec: {
    parse: parseWorkEntriesFile,
    serialize: (file) => JSON.stringify(file, null, 2),
  },
  reconciler: () => registryReconciler,
  publishGroups: (workspaceId) => publishSidebarItemGroupsChanged(workspaceId),
  onListChanged: notifyWorkEntryListChanged,
  // No-op until PR3 (the CAN-4476 ratchet) admits this module on the
  // work_entries row; without that row assertAdmittedWriter refuses.
  assertWriter: () => undefined,
});

const BUNDLE_FILE_NAME = 'work-entries.json';

/** Where an export bundle carries the registry. */
export function workEntryRegistryBundleSource(bundleRoot: string): string {
  return join(bundleRoot, BUNDLE_FILE_NAME);
}

/** Copies the registry's bytes into an export bundle when one exists. */
export async function exportWorkEntryRegistry(
  workspaceId: string,
  bundleRoot: string,
): Promise<void> {
  const source = getWorkspaceWorkEntriesFilePath(workspaceId);
  const present = await stat(source).then(
    () => true,
    () => false,
  );
  if (present) await cp(source, workEntryRegistryBundleSource(bundleRoot));
}

/**
 * Installs a bundle's registry bytes into a freshly created workspace, under
 * its queue. The caller has already refused symlinks and an unparsable file.
 */
export async function importWorkEntryRegistry(
  workspaceId: string,
  source: string,
): Promise<void> {
  const destination = getWorkspaceWorkEntriesFilePath(workspaceId);
  if (!isPathInside(getWorkspaceDir(workspaceId), destination)) {
    throw new Error('Invalid import destination path');
  }
  await workEntryRepository.installRaw(workspaceId, await readFile(source));
}
