import type { ListBranchesResponse } from '@canopy/desktop-shared/types';
import { readRemoteControlContext } from '@/stores/remoteControlStore';

export function hasExactWorktreeBaseCatalogue(
  response: ListBranchesResponse | null,
): boolean {
  return (
    readRemoteControlContext().mode === 'local' ||
    (response !== null &&
      'exactWorktreeBaseBranch' in response &&
      response.exactWorktreeBaseBranch === true)
  );
}
