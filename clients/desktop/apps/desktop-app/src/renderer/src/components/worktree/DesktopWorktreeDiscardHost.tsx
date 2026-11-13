import { useCallback, type JSX } from 'react';
import type { WorktreeDiscardOffer } from '@canopy/app-state';
import {
  WorktreeDiscardHost,
  type WorktreeDiscarded,
} from '@canopy/ui-app/worktree-discard';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { finishWorktreeArchive } from './finishWorktreeArchive';

/**
 * CAN-5336: the desktop mount of the shared discard confirmation. A refusal
 * with nothing to discard keeps today's toast; a discard reconciles the list
 * (including a temporary project it left empty) and drops the worktree's
 * panels, as a finished archive does.
 */
export function DesktopWorktreeDiscardHost(): JSX.Element {
  const notify = useCallback((offer: WorktreeDiscardOffer): void => {
    useGitHubStore.getState().addToast(offer.message, 'error', undefined, {
      projectId: offer.workspaceId,
      worktreeId: offer.worktreeId,
    });
  }, []);
  const onDiscarded = useCallback(
    ({
      workspaceId,
      worktreeId,
      warnings,
      removedTemporaryWorkspaceId,
      retainedArchive,
    }: WorktreeDiscarded): void => {
      for (const warning of warnings) {
        useGitHubStore.getState().addToast(warning, 'warning', undefined, {
          category: 'Worktree',
          projectId: workspaceId,
          worktreeId,
        });
      }
      // CAN-5338: no row was listed; the archived item goes as a deletion's does.
      if (retainedArchive) {
        void useArchivedContainersStore
          .getState()
          .settleDeleted(workspaceId, worktreeId);
        return;
      }
      // As performArchive does, drop a temporary project left empty.
      void useProjectsStore
        .getState()
        .reconcileArchivedWorktree(
          workspaceId,
          worktreeId,
          removedTemporaryWorkspaceId ? { removedTemporaryWorkspaceId } : {},
        );
      finishWorktreeArchive({
        projectId: workspaceId,
        worktreeId,
        refreshReferenceRepos: false,
      });
    },
    [],
  );
  return (
    <WorktreeDiscardHost
      client={ipcCanopyClient}
      notify={notify}
      onDiscarded={onDiscarded}
    />
  );
}
