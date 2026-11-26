import { useEffect } from 'react';
import { useGitHubStore } from '@/stores/githubStore';
import { addFailureToast, type ToastMeta } from '@/stores/toastStore';
import { worktreeToastOrigin } from '@/lib/toastWorktreeNavigation';
import { unclassifiedToastError } from '@canopy/ui-shared/lib';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useChatStore } from '@/stores/chatStore';

export function useAutoArchiveNotifications(): void {
  // An agent-armed removal leaves the sidebar well before it completes; leave
  // the item as soon as removal starts, as a manual delete does.
  useEffect(
    () =>
      window.api.workEntryAutoDelete.onChanged(({ workspaceId, targets }) => {
        for (const [targetId, row] of Object.entries(targets)) {
          if (!row.removing) continue;
          const selected = useChatStore.getState().selectedWorktree;
          if (
            selected?.projectId === workspaceId &&
            selected.worktreeId === targetId
          )
            useChatStore.getState().deselectWorktree();
          void useStandaloneChatStore
            .getState()
            .leaveRemovedWorkEntry(workspaceId, targetId);
        }
      }),
    [],
  );
  useEffect(() => {
    return window.api.onAutoArchiveCompleted((notification) => {
      if (notification.status === 'success') {
        if (
          notification.surface === 'cowork' ||
          notification.surface === 'app-advisor'
        ) {
          void useStandaloneChatStore
            .getState()
            .reconcileArchivedWorkEntry(
              notification.workspaceId,
              notification.targetId,
            );
        } else {
          void useProjectsStore
            .getState()
            .reconcileArchivedWorktree(
              notification.workspaceId,
              notification.targetId,
            );
        }
      }
      const subject = `“${notification.targetName}”`;
      const hasWarnings = Boolean(notification.warnings?.length);
      const agentVerb = notification.mode === 'archive' ? 'archive' : 'delete';
      const message =
        notification.trigger === 'agent'
          ? notification.status === 'success'
            ? `An agent asked to ${agentVerb} ${subject} when it was idle. It was ${agentVerb}d.`
            : `An agent asked to ${agentVerb} ${subject}, but it was not ${agentVerb}d${notification.error ? `: ${notification.error}` : '.'}`
          : notification.status === 'success'
            ? `${subject} was automatically deleted after ${notification.inactivityDays} ${notification.inactivityDays === 1 ? 'day' : 'days'} of inactivity.`
            : `${subject} could not be automatically deleted${notification.error ? `: ${notification.error}` : '.'}`;
      const text = hasWarnings
        ? `${message} Cleanup incomplete: ${notification.warnings?.join(' ')}`
        : message;
      const meta: ToastMeta = {
        category: 'Automation',
        title: 'Auto delete',
        workspaceName: notification.workspaceName,
        projectId: notification.workspaceId,
        worktreeId: notification.targetId,
        persistent: notification.status === 'failure' || hasWarnings,
        forceInApp: true,
        // The message names a user-authored worktree or work entry title.
        blockMessageFromReplay: true,
      };
      if (notification.status === 'failure') {
        addFailureToast({
          message: text,
          error: unclassifiedToastError(
            notification.appError ?? notification.error,
          ),
          origin: worktreeToastOrigin(
            notification.workspaceId,
            notification.targetId,
          ),
          meta,
        });
        return;
      }
      useGitHubStore
        .getState()
        .addToast(text, hasWarnings ? 'warning' : 'success', undefined, meta);
    });
  }, []);
}
