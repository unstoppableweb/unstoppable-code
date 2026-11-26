import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { isW5DaemonFlipCompiled } from '../lib/w5-flip-gate';
import {
  defaultCoreWorkspaceReadServices,
  type CoreWorkspaceReadServices,
} from './core-workspace-adapter';
import { runDesktopW5CachedReadView } from './w5-read-cache-server';

export {
  registerDesktopW5ReadCacheServer,
  runDesktopW5CachedReadView,
} from './w5-read-cache-server';

/*
 * TRANSITIONAL (CAN-7155, W5 readers S-9, Seam A): the dispatcher's
 * workspace and worktree reads (`core.workspace.*`, `core.worktree.*` and
 * their legacy wrappers) are served from Electron main's read cache on flip
 * builds outside Windows (enabled by CAN-7646). Only the read view selects
 * the images; pure file reads memoize parsed values and
 * give each consumer a deep copy. RR1 removal filtering, the discovery
 * overlay and the in-process list lock run as before, over the cache's
 * images instead of a fresh capture. Seam B's direct readers (CAN-7835)
 * serve through `w5-read-cache-server.ts`, which keeps them from loading
 * this adapter. Kept out of `w5-read-cache.ts`, which main loads lazily, so
 * the composition root does not load the cache. W10's core read model
 * (CAN-7153) replaces it.
 */

/** Flip builds outside Windows; elsewhere every reader keeps today's path. */
export function isDesktopW5ReadCacheSelected(): boolean {
  return hostPlatformOperatingSystem() !== 'win32' && isW5DaemonFlipCompiled();
}

/**
 * The composition root's `workspaceServices`: undefined where the cache is
 * not selected, so those builds keep the adapter's defaults unchanged.
 */
export function createDesktopW5CachedWorkspaceServices():
  | CoreWorkspaceReadServices
  | undefined {
  if (!isDesktopW5ReadCacheSelected()) return undefined;
  return {
    ...defaultCoreWorkspaceReadServices(),
    readView: runDesktopW5CachedReadView,
  };
}
