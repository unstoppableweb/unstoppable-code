import { CanopyOperationError } from '@canopy/core-runtime';
import type { DesktopDomainAdapter } from './desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';

/** Core archive policy over the existing Electron-owned journal and worker evidence readers. */
export function createCoreWorktreeRecoveryAdapter(): DesktopDomainAdapter {
  return {
    instructions: {
      'core.worktree.recovery.resolve': async (params, context) => {
        if (
          context.caller.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID ||
          context.caller.interfaceKind !== 'desktop'
        )
          throw new CanopyOperationError({
            kind: 'permission_denied',
            message: 'Archive resolution requires a local user.',
            retry: { kind: 'never' },
          });
        validateId(params.workspaceId, 'workspaceId');
        assertWritableScope(params.workspaceId);
        const result = await (
          await import('../lib/worktree-archive-resolution')
        ).resolveWorktreeArchive(params);
        await (await import('./desktop-w5-recovery'))
          .getDesktopW5RecoveryController()
          .refreshJournals();
        return result;
      },
      'core.worktree.recovery.finish': async (params, context) => {
        if (
          context.caller.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID ||
          context.caller.interfaceKind !== 'desktop'
        )
          throw new CanopyOperationError({
            kind: 'permission_denied',
            message: 'Archive Finish requires the local desktop user.',
            retry: { kind: 'never' },
          });
        const result = await (
          await import('../lib/worktree-recovery-finish')
        ).finishWorktreeRecovery(params);
        // Re-enumerate the cold aggregate, retaining unrelated log/file/journal incidents.
        await (await import('./desktop-w5-recovery'))
          .getDesktopW5RecoveryController()
          .refreshJournals();
        return result;
      },
    },
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
