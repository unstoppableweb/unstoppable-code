import { watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import {
  isW5CaptureWorkspaceId,
  type W5CaptureFile,
  type W5FileImage,
} from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import { isRecord } from '../lib/type-guards';

interface DirectoryWatch {
  readonly watcher: FSWatcher;
  readonly files: readonly W5CaptureFile[];
}

export interface W5ReadCacheCoverage {
  /** Captured indexes may enroll early; only an accepted index removes watches. */
  reconcile(
    root: string,
    index: W5FileImage | undefined,
    prune?: boolean,
  ): void;
  /** Frozen into the next serving token; undefined while desired coverage is lost. */
  certify(
    files: readonly W5CaptureFile[],
  ): readonly W5CaptureFile[] | undefined;
  dispose(): void;
}

function workspaceIds(image: W5FileImage | undefined): string[] | undefined {
  if (image?.state === 'absent') return [];
  if (image?.state !== 'present') return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(image.base64, 'base64').toString('utf8'),
    );
    if (!isRecord(value) || !Array.isArray(value.workspaces)) return undefined;
    return value.workspaces.flatMap((entry: unknown) =>
      isRecord(entry) && isW5CaptureWorkspaceId(entry.id) ? [entry.id] : [],
    );
  } catch {
    return undefined;
  }
}

/**
 * Cache-only native notifications, independent of sidebar visibility and its
 * reconciliation/renderer effects. No polling or retry timer: an uncovered
 * request takes today's path. Reads and existing refill/recovery work retry
 * enrollment. A missed OS notification stays stale until a commit or recovery
 * invalidates it (q-61); this is not write admission.
 */
export function createW5ReadCacheCoverage(
  markDirty: (files: readonly W5CaptureFile[]) => void,
  revoke: (reason: 'loss' | 'membership') => void,
  onAvailable: () => void,
): W5ReadCacheCoverage {
  let root: string | undefined;
  let disposed = false;
  let parsedImage: W5FileImage | undefined;
  let parsedIds: string[] | undefined;
  const desired = new Set<string>();
  const uncovered = new Set<string>();
  const failed = new Set<string>();
  // The empty key is the root; workspace ids cannot be empty.
  const watches = new Map<string, DirectoryWatch>();
  const rootFiles: readonly W5CaptureFile[] = [{ kind: 'index' }];
  const workspaceFiles = (workspaceId: string): readonly W5CaptureFile[] => [
    { kind: 'manifest', workspaceId },
    { kind: 'worktrees', workspaceId },
  ];
  const retire = (key: string): void => {
    const entry = watches.get(key);
    if (!entry) return;
    watches.delete(key);
    revoke(!key || desired.has(key) ? 'loss' : 'membership');
    if (key && desired.has(key)) uncovered.add(key);
    markDirty(entry.files);
    entry.watcher.close();
  };
  const lose = (key: string): void => {
    if (key === '') {
      for (const id of Array.from(watches.keys())) retire(id);
    } else retire(key);
  };
  const enroll = (key: string, files: readonly W5CaptureFile[]): boolean => {
    if (!root || watches.has(key) || disposed) return false;
    const directory = key ? join(root, key) : root;
    try {
      const watcher = watch(
        directory,
        { persistent: false },
        (event, filename): void => {
          if (watches.get(key)?.watcher !== watcher) return;
          const name = filename?.toString();
          const file = key
            ? name === 'workspace.json'
              ? files[0]
              : name === 'worktrees.json'
                ? files[1]
                : undefined
            : name === 'index.json'
              ? files[0]
              : undefined;
          if ((event === 'change' || event === 'rename') && file) {
            markDirty([file]);
            return;
          }
          // A root change without a child name cannot prove inode continuity.
          // Retire its dependent watches too: they may still follow the old root.
          if (
            (key === '' || event !== 'change') &&
            (!name || name === basename(directory))
          ) {
            lose(key);
            return;
          }
          markDirty(files);
          if (key === '' && event === 'rename' && name && desired.has(name))
            lose(name);
          else if (event !== 'change' && event !== 'rename') lose(key);
        },
      );
      watches.set(key, { watcher, files });
      uncovered.delete(key);
      failed.delete(key);
      const lost = (): void => {
        if (watches.get(key)?.watcher === watcher) lose(key);
      };
      watcher.on('error', lost);
      watcher.on('close', lost);
      // Captures requested without this watch cannot become current after it
      // enrolls, even if they finish after a newer capture settles this mark.
      markDirty(files);
      return true;
    } catch {
      // One failed enrollment streak is one loss, not a periodic revocation.
      if (!failed.has(key)) {
        failed.add(key);
        revoke('loss');
      }
      return false;
    }
  };
  return {
    reconcile(nextRoot, image, prune = true): void {
      if (disposed) return;
      if (root !== undefined && root !== nextRoot) lose('');
      root = nextRoot;
      const changed = image !== parsedImage;
      if (changed) {
        parsedImage = image;
        parsedIds = workspaceIds(image);
      }
      const ids = parsedIds;
      let membershipChanged = false;
      if (ids && (changed || prune)) {
        if (prune) {
          const next = new Set(ids);
          for (const id of desired)
            if (!next.has(id)) {
              desired.delete(id);
              uncovered.delete(id);
              failed.delete(id);
              retire(id);
              membershipChanged = true;
            }
        }
        for (const id of ids)
          if (!desired.has(id)) {
            desired.add(id);
            uncovered.add(id);
            revoke('membership');
            membershipChanged = true;
          }
      }
      let enrolled = enroll('', rootFiles);
      // Without a root watch a workspace-directory replacement is invisible.
      if (!watches.has('')) return;
      for (const id of uncovered)
        enrolled = enroll(id, workspaceFiles(id)) || enrolled;
      if ((enrolled || membershipChanged) && !uncovered.size) onAvailable();
    },
    certify(files): readonly W5CaptureFile[] | undefined {
      if (disposed || !watches.has('') || uncovered.size) return undefined;
      return files.filter(
        (file) =>
          // The backup is not part of the index/manifest/list enrollment. Keep
          // its rare explicit reads on today's path rather than adding a hold.
          file.kind !== 'index-backup' &&
          (!('workspaceId' in file) || watches.has(file.workspaceId)),
      );
    },
    dispose(): void {
      disposed = true;
      for (const entry of watches.values()) entry.watcher.close();
      watches.clear();
      desired.clear();
      uncovered.clear();
      failed.clear();
    },
  };
}
