import { CanopyOperationError } from '@canopy/core-runtime';
import type { DesktopDomainAdapter } from './desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';

/** Core archive policy over the existing Electron-owned journal and worker evidence readers. */
export function createCoreWorktreeRecoveryAdapter(): DesktopDomainAdapter {
  return {
    queries: {
      'core.worktree.recovery.list': async (params, context) => {
        if (context.caller.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
          throw new CanopyOperationError({
            kind: 'permission_denied',
            message: 'Recovery evidence belongs to this desktop.',
            retry: { kind: 'never' },
          });
        validateId(params.workspaceId, 'workspaceId');
        assertWritableScope(params.workspaceId);
        return (
          await import('../lib/worktree-recovery-description')
        ).listWorktreeRecovery(params);
      },
    },
  };
}
