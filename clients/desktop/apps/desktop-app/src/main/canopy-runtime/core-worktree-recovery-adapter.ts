import { CanopyOperationError } from '@canopy/core-runtime';
import type { DesktopDomainAdapter } from './desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { isArchiveRecoveryReviewer } from './archive-recovery-reviewer';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';

// A cold-status read cannot revoke a confirmed action.
async function refreshRecoveryJournals(): Promise<void> {
  await (await import('./desktop-w5-recovery'))
    .getDesktopW5RecoveryController()
    .refreshJournals();
}

/** Core archive policy over the existing Electron-owned journal and worker evidence readers. */
export function createCoreWorktreeRecoveryAdapter(): DesktopDomainAdapter {
  return {
    instructions: {
      'core.worktree.recovery.resolve': async (params, context) => {
        if (!isArchiveRecoveryReviewer(context.caller, { portal: true }))
          throw new CanopyOperationError({
            kind: 'permission_denied',
            message: 'Archive resolution requires a user review.',
            retry: { kind: 'never' },
          });
        validateId(params.workspaceId, 'workspaceId');
        assertWritableScope(params.workspaceId);
        const result = await (
          await import('../lib/worktree-archive-resolution')
        ).resolveWorktreeArchive(params);
        await refreshRecoveryJournals().catch(() => undefined);
        return result;
      },
      'core.worktree.recovery.finish': async (params, context) => {
        if (!isArchiveRecoveryReviewer(context.caller, { portal: true }))
          throw new CanopyOperationError({
            kind: 'permission_denied',
            message: 'Archive Finish requires a user review.',
            retry: { kind: 'never' },
          });
        const result = await (
          await import('../lib/worktree-recovery-finish')
        ).finishWorktreeRecovery(params);
        // Re-enumerate the cold aggregate, retaining unrelated log/file/journal incidents.
        await refreshRecoveryJournals().catch(() => undefined);
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
        const { describeWorktreeDiscard } =
          await import('../lib/worktree-discard');
        return (
          await import('../lib/worktree-recovery-description')
        ).listWorktreeRecovery(params, describeWorktreeDiscard);
      },
    },
  };
}
