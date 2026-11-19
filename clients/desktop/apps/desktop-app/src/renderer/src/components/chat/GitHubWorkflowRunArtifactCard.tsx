import { memo, useEffect, useMemo, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  AppAdvisorWatcherSummary,
  GitHubWorkflowRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import { GitHubWorkflowRunRow } from '@canopy/ui-app';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { extractIpcErrorMessage } from '@/lib/errors';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';
import { refreshGitHubWorkflowRunReceipt } from './agent-artifact-projection';
import { openAgentArtifactNavigation } from './agent-artifact-navigation';

interface GitHubWorkflowRunArtifactCardProps {
  receipt: GitHubWorkflowRunArtifactReceiptV1;
  chatTarget?: { projectId: string; worktreeId: string; chatId: string };
  /** The user turn that owns this card; enables refreshed-snapshot carry. */
  ownerUserMessageId?: string;
}

function watchesRun(
  watcher: AppAdvisorWatcherSummary,
  receipt: GitHubWorkflowRunArtifactReceiptV1,
): boolean {
  return (
    watcher.trigger === 'github_workflow_runs_changed' &&
    watcher.githubProgress?.runs.some(
      (run) =>
        run.repository === receipt.repository && run.runId === receipt.runId,
    ) === true
  );
}

/**
 * One watched GitHub Actions run in the Agent activity section. Live state
 * comes from the watcher summaries the main process already broadcasts on
 * every poll (active or recently completed), never from a request of its own;
 * whatever it learns is written back into the turn's carry so the card keeps
 * its final state once the watcher has retired. Clicking the card or a job
 * dot opens GitHub's own page in the user's browser.
 */
export const GitHubWorkflowRunArtifactCard = memo(
  function GitHubWorkflowRunArtifactCard({
    receipt,
    chatTarget,
    ownerUserMessageId,
  }: GitHubWorkflowRunArtifactCardProps): JSX.Element {
    const { watchers, completedWatchers } = useAppAdvisorWatchersStore(
      useShallow((state) => ({
        watchers: state.watchers,
        completedWatchers: state.completedWatchers,
      })),
    );
    const addToast = useGitHubStore((state) => state.addToast);
    const live = useMemo(
      () =>
        refreshGitHubWorkflowRunReceipt(receipt, [
          ...watchers,
          ...(completedWatchers ?? []),
        ]),
      [completedWatchers, receipt, watchers],
    );

    useEffect(() => {
      if (live === receipt || !chatTarget || !ownerUserMessageId) return;
      useChatStore
        .getState()
        .recordAgentArtifactCarry(chatTarget, ownerUserMessageId, [live]);
    }, [chatTarget, live, ownerUserMessageId, receipt]);

    const matchingWatchers = useMemo(
      () =>
        watchers.filter(
          (watcher) =>
            watcher.id === live.watcherId ||
            (chatTarget !== undefined &&
              watcher.destination.projectId === chatTarget.projectId &&
              watcher.destination.worktreeId === chatTarget.worktreeId &&
              watcher.destination.chatId === chatTarget.chatId &&
              watchesRun(watcher, live)),
        ),
      [chatTarget, live, watchers],
    );

    const openExternal = (url: string): void => {
      void window.api.browser.openLink({ url }).catch((error: unknown) =>
        addToast(extractIpcErrorMessage(error), 'error', undefined, {
          category: 'GitHub',
          caught: error,
        }),
      );
    };

    return (
      <GitHubWorkflowRunRow
        run={live}
        onOpen={(): void =>
          void openAgentArtifactNavigation(live.navigationTarget)
        }
        onJobClick={(job): void => openExternal(job.htmlUrl)}
        renderWatcherButton={(): JSX.Element | null =>
          matchingWatchers.length > 0 ? (
            <WatcherManagementButton
              watchers={matchingWatchers}
              modalTitle="GitHub workflow watchers"
              modalEmptyMessage="No active watchers for this workflow run."
              ariaLabel="Manage GitHub workflow watchers"
              dataTestId={`github-workflow-run-watchers-${live.runId}`}
            />
          ) : null
        }
      />
    );
  },
);
