import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';
import { CheckIcon, WrenchIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  launchWorkspaceReadinessFix,
  navigateToWorkspaceReadinessChat,
} from '@/lib/workspaceReadinessLauncher';
import {
  launchedReadinessFixesForTarget,
  launchedReadinessFixKey,
  type LaunchedReadinessFix,
} from '@/lib/workspaceReadinessLaunches';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  useWorkspaceReadinessLaunchReconciliation,
  useWorkspaceReadinessMissingChats,
} from '@/hooks/useWorkspaceReadinessLaunchReconciliation';
import {
  pruneResolvedWorkspaceReadinessLaunches,
  selectWorkspaceReadinessLaunch,
  snapshotWorkspaceReadinessLaunches,
  useWorkspaceReadinessLaunchStore,
} from '@/stores/workspaceReadinessLaunchStore';
import { Button, LoadingSpinner } from '../shared';
import {
  Stack,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Heading,
  Skeleton,
  Surface,
} from '@canopy/ui-shared/components';

interface WorkspaceReadinessRecommendationsProps {
  workspaceId: string;
  worktreeId?: string;
  /**
   * Dismiss the host surface. Called when the user opens a launched chat, not
   * when one is started: launching keeps this surface open so several
   * recommendations can be fixed in one visit. Resolves whether the surface
   * closed; the chat opens only once it has.
   */
  onViewConversation: () => Promise<boolean>;
  /**
   * `card` frames the recommendations on their own. `row` is one settings
   * row whose fixes sit under it, for a page that groups rows in one box.
   */
  surface?: 'card' | 'row';
}

type LoadState = 'loading' | 'ready' | 'error';

export function WorkspaceReadinessRecommendations({
  workspaceId,
  worktreeId,
  onViewConversation,
  surface = 'card',
}: WorkspaceReadinessRecommendationsProps): JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [issues, setIssues] = useState<WorkspaceReadinessIssue[]>([]);
  const [launchingKey, setLaunchingKey] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  /**
   * Launched readiness fixes, shared with Home and the Overview and persisted
   * across restarts. Only launches from this surface's audit target apply.
   */
  const launchRecords = useWorkspaceReadinessLaunchStore(
    (state) => state.records,
  );
  const missingChats = useWorkspaceReadinessMissingChats(launchRecords);
  useWorkspaceReadinessLaunchReconciliation();
  const loadGeneration = useRef(0);
  const targetKey = `${workspaceId}:${worktreeId ?? 'reference'}`;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;

  const load = useCallback(async (): Promise<void> => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoadState('loading');
    const launchSnapshot = snapshotWorkspaceReadinessLaunches(
      workspaceId,
      worktreeId,
    );
    try {
      const response = await window.api.getWorkspaceReadiness({
        workspaceId,
        worktreeId,
      });
      if (loadGeneration.current !== generation) return;
      pruneResolvedWorkspaceReadinessLaunches(
        launchSnapshot,
        response.issues,
        response.complete,
      );
      setIssues(response.issues);
      setLoadState('ready');
    } catch {
      if (loadGeneration.current !== generation) return;
      setLoadState('error');
    }
  }, [workspaceId, worktreeId]);

  useEffect(() => {
    void load();
    return (): void => {
      loadGeneration.current += 1;
    };
  }, [load]);

  useEffect(() => {
    setLaunchingKey(null);
    setLaunchError(null);
  }, [targetKey]);

  const groupedIssues = useMemo(() => {
    const groups = new Map<string, WorkspaceReadinessIssue[]>();
    for (const issue of issues) {
      const existing = groups.get(issue.repoName) ?? [];
      existing.push(issue);
      groups.set(issue.repoName, existing);
    }
    return Array.from(groups.entries());
  }, [issues]);

  const handleFix = async (issue: WorkspaceReadinessIssue): Promise<void> => {
    if (launchingKey !== null) return;
    const launchTargetKey = targetKey;
    const key = `${launchTargetKey}:${issue.code === 'recovery-required' ? workspaceReadinessIssueKey(issue) : `${issue.repoId ?? 'project'}:${issue.code}`}`;
    setLaunchingKey(key);
    setLaunchError(null);
    // Stay open so the remaining recommendations can be started too; the
    // launch record turns the row into "View conversation".
    const result = await launchWorkspaceReadinessFix(
      workspaceId,
      issue,
      worktreeId,
      { navigateToChat: false },
    );
    if (targetKeyRef.current !== launchTargetKey) return;
    if (!result.ok) {
      setLaunchError(result.message);
    }
    setLaunchingKey(null);
  };

  const launchFor = (
    issue: WorkspaceReadinessIssue,
  ): LaunchedReadinessFix | undefined =>
    selectWorkspaceReadinessLaunch(
      { records: launchRecords },
      workspaceId,
      worktreeId,
      workspaceReadinessIssueKey(issue),
    );

  const handleView = async (launched: LaunchedReadinessFix): Promise<void> => {
    // Dismiss first so the chat is not opened behind this surface.
    if (!(await onViewConversation())) return;
    await navigateToWorkspaceReadinessChat(
      workspaceId,
      launched.worktreeId,
      launched.chatId,
    );
  };

  const ready = loadState === 'ready' && issues.length === 0;
  const launchedChatCount = launchedReadinessFixesForTarget(
    launchRecords,
    workspaceId,
    worktreeId,
  ).length;
  useCurrentUiStateReporter('workspaceReadiness.settings', {
    surface: 'settings',
    workspaceId,
    ...(worktreeId ? { worktreeId } : {}),
    status: loadState,
    issueCount: issues.length,
    launching: launchingKey !== null,
    launchedChatCount,
    errorVisible: loadState === 'error' || launchError !== null,
  });
  const issueKey = (issue: WorkspaceReadinessIssue): string =>
    `${targetKey}:${issue.code === 'recovery-required' ? workspaceReadinessIssueKey(issue) : `${issue.repoId ?? 'project'}:${issue.code}`}`;

  if (surface === 'row') {
    return (
      <Stack gap="item" data-testid="workspace-readiness-recommendations">
        <div className="flex min-h-10 items-center justify-between gap-6">
          <div className="flex flex-col min-w-0 flex-1 gap-0.5">
            <div className="text-s font-medium fg-primary">
              Repository readiness
            </div>
            <div className="text-xs text-pretty fg-secondary">
              {loadState === 'loading'
                ? 'Checking repository readiness…'
                : loadState === 'error'
                  ? 'Couldn’t check repository readiness.'
                  : ready
                    ? 'Setup and launch scripts, hooks and shared agent instructions are in place.'
                    : 'Agents work better with these in place.'}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-s fg-secondary">
            {loadState === 'loading' ? (
              // The count is the value still on its way: its real text,
              // measured.
              <Skeleton
                loading
                label="Checking repository readiness"
                testId="workspace-readiness-loading"
              >
                2 to fix
              </Skeleton>
            ) : loadState === 'error' ? (
              <Button size="compact" onClick={() => void load()}>
                Try again
              </Button>
            ) : ready ? (
              <>
                <CheckIcon
                  size="sm"
                  aria-hidden={true}
                  className="fg-success"
                />
                Ready
              </>
            ) : (
              `${issues.length} to fix`
            )}
          </div>
        </div>
        {loadState === 'ready' &&
          issues.map((issue) => {
            const key = issueKey(issue);
            const isLaunching = launchingKey === key;
            const launched = launchFor(issue);
            const chatMissing =
              launched !== undefined &&
              missingChats.includes(launchedReadinessFixKey(launched));
            return (
              <div
                key={key}
                className="flex min-h-10 items-center justify-between gap-6"
              >
                <div className="flex flex-col min-w-0 flex-1 gap-0.5">
                  <div className="text-s fg-primary">{issue.title}</div>
                  <div className="text-xs text-pretty fg-secondary">
                    {issue.message}
                    {chatMissing && ' Conversation unavailable.'}
                  </div>
                </div>
                {issue.fixPrompt === null ? null : launched ? (
                  <Button
                    size="compact"
                    variant="ghost"
                    onClick={() => void handleView(launched)}
                  >
                    {chatMissing ? 'Open worktree' : 'View conversation'}
                  </Button>
                ) : (
                  <Button
                    size="compact"
                    disabled={launchingKey !== null}
                    onClick={() => void handleFix(issue)}
                  >
                    {isLaunching && <LoadingSpinner decorative />}
                    {isLaunching ? 'Starting…' : 'Fix in new worktree'}
                  </Button>
                )}
              </div>
            );
          })}
        <ErrorBanner className="" error={launchError} />
      </Stack>
    );
  }

  return (
    <Surface
      as="section"
      gap="group"
      variant="group"
      padding="default"
      data-testid="workspace-readiness-recommendations"
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
            ready
              ? 'bg-success-subtle fg-success'
              : 'bg-accent-subtle fg-accent-strong'
          }`}
        >
          {ready ? <CheckIcon size="sm" /> : <WrenchIcon size="sm" />}
        </span>
        <Stack gap="inline" className="min-w-0 flex-1">
          <Stack gap="tight">
            <Heading level={3} variant="title">
              Repository readiness
            </Heading>
            {loadState === 'loading' && (
              <DelayedLoadingPlaceholder slowNote="Still checking repository readiness…">
                <Skeleton
                  loading
                  label="Checking repository readiness"
                  testId="workspace-readiness-loading"
                >
                  <p className="text-xs fg-secondary">
                    This Code project has setup and launch scripts, hooks, and
                    shared agent instructions in place.
                  </p>
                </Skeleton>
              </DelayedLoadingPlaceholder>
            )}
            {ready && (
              <p className="text-xs fg-secondary">
                This Code project has setup and launch scripts, hooks, and
                shared agent instructions in place.
              </p>
            )}
          </Stack>
          {loadState === 'error' && (
            <ErrorBanner
              className=""
              error="Couldn’t check repository readiness."
              onRetry={() => void load()}
            />
          )}
        </Stack>
      </div>

      {((loadState === 'ready' && groupedIssues.length > 0) || launchError) && (
        <Stack gap="item">
          {loadState === 'ready' && groupedIssues.length > 0 && (
            <Stack gap="group">
              {groupedIssues.map(([repoName, repoIssues]) => (
                <Stack gap="inline" key={repoName}>
                  <Heading className="" level={4} variant="label">
                    {repoName}
                  </Heading>
                  <Stack gap="inline">
                    {repoIssues.map((issue) => {
                      const key = `${targetKey}:${issue.code === 'recovery-required' ? workspaceReadinessIssueKey(issue) : `${issue.repoId ?? 'project'}:${issue.code}`}`;
                      const isLaunching = launchingKey === key;
                      const launched = launchFor(issue);
                      const chatMissing =
                        launched !== undefined &&
                        missingChats.includes(
                          launchedReadinessFixKey(launched),
                        );
                      return (
                        <Surface variant="inset" key={key}>
                          <div className="flex items-center justify-between gap-4 px-3 py-3">
                            <Stack gap="tight" className="min-w-0">
                              <div className="text-xs font-medium fg-primary">
                                {issue.title}
                              </div>
                              <div className="text-xs fg-secondary">
                                {issue.message}
                                {chatMissing && ' Conversation unavailable.'}
                              </div>
                            </Stack>
                            {issue.fixPrompt === null ? null : launched ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void handleView(launched)}
                              >
                                {chatMissing
                                  ? 'Open worktree'
                                  : 'View conversation'}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={launchingKey !== null}
                                onClick={() => void handleFix(issue)}
                              >
                                {isLaunching
                                  ? 'Starting…'
                                  : 'Fix in new worktree'}
                              </Button>
                            )}
                          </div>
                        </Surface>
                      );
                    })}
                  </Stack>
                </Stack>
              ))}
            </Stack>
          )}

          <ErrorBanner className="" error={launchError} />
        </Stack>
      )}
    </Surface>
  );
}
