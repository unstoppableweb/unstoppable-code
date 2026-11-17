import { getCanopyRuntimeMode } from '@canopy/execution-engine/canopy-paths';
import {
  isUniqueAnimalNameShape,
  pickUniqueAnimalName,
} from '@canopy/protocol/worktree-branch-names';

export { ANIMAL_NAMES } from '@canopy/protocol/worktree-branch-names';

const DEV_WORKTREE_NAME_PREFIX = 'dev-';

/**
 * The prefix this host puts on generated worktree ids: `dev-` in dev runtime
 * mode, empty in production. Published in the session snapshot so a client
 * can claim an id the host will accept.
 */
export function getWorktreeIdClaimPrefix(): string {
  return getCanopyRuntimeMode() === 'dev' ? DEV_WORKTREE_NAME_PREFIX : '';
}

export function generateUniqueAnimalName(existingNames: Set<string>): string {
  return pickUniqueAnimalName(existingNames, {
    prefix: getWorktreeIdClaimPrefix(),
  });
}

/**
 * Whether a client-claimed worktree id has the shape this host's generator
 * produces in its current mode. A claim from another mode (a `dev-` claim
 * against production) or with any other shape is not claimable.
 */
export function isClaimableWorktreeId(id: string): boolean {
  return isUniqueAnimalNameShape(id, { prefix: getWorktreeIdClaimPrefix() });
}
