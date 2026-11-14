import { useEffect, useRef, useState, type JSX } from 'react';
import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { HomeSection, SuggestionRow } from '@canopy/ui-shared';
import { ErrorBanner } from '@canopy/ui-shared/components';
import { ChatIcon, WrenchIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useWorkspaceReadinessLaunchReconciliation } from '@/hooks/useWorkspaceReadinessLaunchReconciliation';
import {
  launchWorkspaceReadinessFix,
  navigateToWorkspaceReadinessChat,
} from '@/lib/workspaceReadinessLauncher';
import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import {
  findLaunchWorktree,
  launchDestinationLabel,
  launchedReadinessFixKey,
  resolveLaunchedReadinessFixStatus,
  workspaceReadinessLaunchNoun,
  type LaunchedReadinessFix,
  type LaunchedReadinessFixStatus,
} from '@/lib/workspaceReadinessLaunches';
import { hydratedKeys } from '@/stores/chat/hydration';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  pruneResolvedWorkspaceReadinessLaunches,
  selectWorkspaceReadinessLaunch,
  snapshotWorkspaceReadinessLaunches,
  useWorkspaceReadinessLaunchStore,
} from '@/stores/workspaceReadinessLaunchStore';

const STATUS_PHRASE: Record<LaunchedReadinessFixStatus, string> = {
  'in-progress': 'in progress',
  'ready-to-review': 'ready to review',
  unknown: 'fix started',
  'needs-attention': 'needs attention',
  'chat-missing': 'conversation unavailable',
};

/**
 * Stands in for a fix already launched from the reference checkout: one row
 * that opens the launched chat, showing whether that work is still running.
 * A record proves only that the destination exists, so an unhydrated chat
 * reads as started and a known failure as needing attention, never as done.
 */
function LaunchedReadinessFixRow({
  issue,
  launch,
}: {
  issue: WorkspaceReadinessIssue;
  launch: LaunchedReadinessFix;
}): JSX.Element {
  const { workspaceId, worktreeId, chatId } = launch;
  const chatKey = `${workspaceId}/${worktreeId}`;
  const launchKey = launchedReadinessFixKey(launch);
  const worktree = useProjectsStore((state) =>
    findLaunchWorktree(state.projects, workspaceId, worktreeId),
  );
  const tab = useChatStore((state) =>
    state.worktreeChats[chatKey]?.tabs.find((entry) => entry.id === chatId),
  );
  const chatsLoaded = useChatStore(
    (state) => state.worktreeChats[chatKey] !== undefined,
  );
  const sendPending = useWorkspaceReadinessLaunchStore(
    (state) => state.pendingSendKeys[launchKey] === true,
  );
  const sendFailed = useWorkspaceReadinessLaunchStore(
    (state) => state.failedSendKeys[launchKey] === true,
  );
  const status = resolveLaunchedReadinessFixStatus({
    worktree,
    tab,
    chatsHydrated: chatsLoaded && hydratedKeys.has(chatKey),
    sendPending,
    sendFailed,
  });
  const noun = workspaceReadinessLaunchNoun(issue);
  const phrase = STATUS_PHRASE[status];
  const destination = launchDestinationLabel(worktree);
  const action = status === 'chat-missing' ? 'Open worktree' : 'Open chat';

  return (
    <SuggestionRow
      icon={<ChatIcon size={16} aria-hidden="true" />}
      tone="muted"
      data-testid={`home-readiness-launched-${issue.code}`}
      data-status={status}
      aria-label={`${noun}, ${phrase}. ${action}`}
      onClick={(): void => {
        void navigateToWorkspaceReadinessChat(workspaceId, worktreeId, chatId);
      }}
    >
      {noun} · {phrase}
      {destination !== undefined && (
        <>
          {' on '}
          <span className={POSTHOG_REPLAY_MASK_CLASS}>{destination}</span>
        </>
      )}{' '}
      <span className="text-xs fg-secondary">· {action}</span>
    </SuggestionRow>
  );
}

/** Actionable project fixes survive independently of Getting started progress. */
export function HomeWorkspaceReadiness({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName?: string;
}): JSX.Element | null {
  const [issues, setIssues] = useState<WorkspaceReadinessIssue[]>([]);
  const [launching, setLaunching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const records = useWorkspaceReadinessLaunchStore((state) => state.records);
  useWorkspaceReadinessLaunchReconciliation();
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    // Home audits the reference checkout; only launches from it apply here.
    const snapshot = snapshotWorkspaceReadinessLaunches(workspaceId, undefined);
    void window.api.getWorkspaceReadiness({ workspaceId }).then(
      (result) => {
        if (cancelled) return;
        pruneResolvedWorkspaceReadinessLaunches(
          snapshot,
          result.issues,
          result.complete,
        );
        setIssues(result.issues.filter((issue) => issue.fixPrompt !== null));
      },
      () => {
        /* An unavailable audit must not block Home or invent fixes. */
      },
    );
    return (): void => {
      cancelled = true;
      mounted.current = false;
    };
  }, [workspaceId]);

  const fix = async (issue: WorkspaceReadinessIssue): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    const key = workspaceReadinessIssueKey(issue);
    setLaunching(key);
    setError(null);
    try {
      // On success the launch record replaces this row with a link to the
      // launched chat, even if Home unmounted while the send settled.
      const result = await launchWorkspaceReadinessFix(workspaceId, issue);
      if (!mounted.current) return;
      if (!result.ok) setError(result.message);
    } catch {
      if (mounted.current)
        setError('Could not start this project fix. Try again.');
    } finally {
      busy.current = false;
      if (mounted.current) setLaunching(null);
    }
  };

  if (issues.length === 0) return null;
  return (
    <HomeSection
      sectionId={`project-suggestions:${workspaceId}`}
      testId="home-workspace-readiness"
      title={
        workspaceName ? (
          <>
            Suggestions for{' '}
            <span className={POSTHOG_REPLAY_MASK_CLASS}>{workspaceName}</span>
          </>
        ) : (
          'Project suggestions'
        )
      }
    >
      <ul className="flex flex-col">
        {issues.map((issue) => {
          const issueKey = workspaceReadinessIssueKey(issue);
          const launch = selectWorkspaceReadinessLaunch(
            { records },
            workspaceId,
            undefined,
            issueKey,
          );
          return (
            <li key={issueKey}>
              {launch ? (
                <LaunchedReadinessFixRow issue={issue} launch={launch} />
              ) : (
                <SuggestionRow
                  icon={<WrenchIcon size={16} aria-hidden="true" />}
                  data-testid={`home-readiness-fix-${issue.code}`}
                  aria-label={
                    launching === issueKey ? 'Starting fix' : issue.title
                  }
                  disabled={launching !== null}
                  onClick={(): void => {
                    void fix(issue);
                  }}
                >
                  {issue.title}{' '}
                  <span
                    className={`text-xs fg-secondary ${POSTHOG_REPLAY_MASK_CLASS}`}
                  >
                    · {issue.repoName}
                  </span>
                </SuggestionRow>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorBanner
        errorSource="home-workspace-readiness"
        error={error}
        className=""
      />
    </HomeSection>
  );
}
