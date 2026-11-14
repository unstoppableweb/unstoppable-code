import { isW5DaemonHostingRequired } from '@canopy/core-runtime/node/w5/storage-binding';

/** The namespaces the W5 commit log decides; the flip moves them together. */
export const W5_FLIP_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
] as const;

/**
 * TRANSITIONAL (CAN-5543, GB12): whether this build's compiled storage rows
 * hand the W5 namespaces to the daemon, which turns on the flip launch's
 * startup handoff. All three must admit `daemon`; a mixed set fails closed.
 * There is no runtime or environment override. Remove at W15 with the
 * legacy writers.
 */
export function isW5DaemonFlipCompiled(): boolean {
  return isW5DaemonHostingRequired();
}
