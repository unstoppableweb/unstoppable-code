/**
 * WorktreeLaunchButton — the standalone launch-scripts control extracted from
 * the old ActivityPanel header (the panel-unit rework removed that header).
 * Renders the Launch / Stop toggle for the worktree's launch lifecycle
 * scripts plus the aggregated dev-server "Open" control for running scripts
 * (the header rendered them side by side; both belong to the launch
 * lifecycle). Renders nothing when the worktree has no launch scripts and no
 * running dev servers.
 *
 * Mounted by the worktree top bar; it owns no layout beyond an inline flex
 * row and is safe inside an Electron drag region (`electron-no-drag` on the
 * interactive elements).
 */
import { useCallback, useMemo, type JSX } from 'react';
import type { ScriptRunResponse } from '@canopy/desktop-shared/types';
import {
  ExecutionActionButton,
  HeaderActionButton,
  Tooltip,
} from '@canopy/ui-shared/components';
import { RocketLaunchIcon } from '@canopy/ui-shared/icons/AppIcons';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  hasActiveWorkspaceLaunchRun,
  isScriptRunActive,
  isWorkspaceLaunchRun,
  useScriptsStore,
  type ScriptRunState,
} from '@/stores/scriptsStore';
import {
  ActivityOpenControl,
  type ActivityOpenSection,
} from './ActivityOpenControl';
import {
  buildScriptEntries,
  findWorkspaceLaunchEntry,
  hasRunScripts,
} from './script-utils';
import { useWorktreeEffective } from '@/hooks/useWorktreeEffective';
import { useGitHubStore } from '@/stores/githubStore';
import {
  guardWorktreeLaunch,
  readFreshLaunchProject,
} from '@/components/worktree/worktree-launch';

export interface WorktreeLaunchButtonProps {
  projectId: string;
  worktreeId: string;
  /** Host-owned launch flow, used by read-only shared recipients for consent. */
  onLaunch?: () => void;
  launchLabel?: string;
  launchTestId?: string;
}

export function WorktreeLaunchButton({
  projectId,
  worktreeId,
  onLaunch,
  launchLabel = 'Launch',
  launchTestId = 'worktree-top-launch',
}: WorktreeLaunchButtonProps): JSX.Element {
  useWorktreeEffective(projectId, worktreeId);
  const worktreeKey = `${projectId}/${worktreeId}`;
  const projects = useProjectsStore((state) => state.projects);
  const selectedProject = projects.find((p) => p.id === projectId) ?? null;
  const isMultiRepoWorkspace = selectedProject?.type === 'multi-repo';
  const appliedProjectWorktreeScripts = useProjectsStore(
    (state) => state.appliedProjectWorktreeScripts,
  );
  const showRunButton =
    onLaunch !== undefined ||
    hasRunScripts(
      projects,
      projectId,
      worktreeId,
      appliedProjectWorktreeScripts,
    );

  const startRun = useScriptsStore((state) => state.startRun);
  const completeRun = useScriptsStore((state) => state.completeRun);
  const isRunning = useScriptsStore((state): boolean => {
    const worktreeRuns = state.runs[worktreeKey];
    if (!worktreeRuns) return false;
    if (isMultiRepoWorkspace) {
      return Object.values(worktreeRuns).some(
        (run) => isWorkspaceLaunchRun(run) && run.status === 'running',
      );
    }
    return Object.values(worktreeRuns).some(
      (run) => run.lifecycle === 'launch' && run.status === 'running',
    );
  });
  const isStopping = useScriptsStore((state): boolean => {
    const worktreeRuns = state.runs[worktreeKey];
    if (!worktreeRuns) return false;
    if (isMultiRepoWorkspace) {
      return Object.values(worktreeRuns).some(
        (run) => isWorkspaceLaunchRun(run) && run.status === 'stopping',
      );
    }
    return Object.values(worktreeRuns).some(
      (run) => run.lifecycle === 'launch' && run.status === 'stopping',
    );
  });
  const isSetupRunning = useScriptsStore((state): boolean => {
    const worktreeRuns = state.runs[worktreeKey];
    if (!worktreeRuns) return false;
    return Object.values(worktreeRuns).some(
      (run) =>
        isScriptRunActive(run.status) &&
        (run.lifecycle === 'before-setup' ||
          run.lifecycle === 'setup' ||
          run.lifecycle === 'after-setup'),
    );
  });
  const worktreeRuns = useScriptsStore(
    (state): Record<string, ScriptRunState> | undefined =>
      state.runs[worktreeKey],
  );

  const openSections = useMemo((): ActivityOpenSection[] => {
    if (!worktreeRuns) return [];
    const sections: ActivityOpenSection[] = [];
    for (const [scriptKey, run] of Object.entries(worktreeRuns)) {
      if (run.status !== 'running') continue;
      if (run.devServerHits.length === 0) continue;
      const section: ActivityOpenSection = {
        scriptKey,
        scriptLabel: run.label,
        hits: run.devServerHits,
      };
      if (isMultiRepoWorkspace) {
        if (run.target === 'workspace-root') {
          section.repoContext = 'Project root';
        } else if (run.target === 'workspace-repo' && run.repoName) {
          section.repoContext = run.repoName;
        }
      }
      sections.push(section);
    }
    return sections;
  }, [worktreeRuns, isMultiRepoWorkspace]);

  const devServerContext = useMemo(
    () => ({ projectId, worktreeId }),
    [projectId, worktreeId],
  );

  const runLaunch = useCallback(async (): Promise<void> => {
    if (!selectedProject) return;
    // CAN-6933: what runs is the worktree's own command, read now.
    const freshProject = await readFreshLaunchProject(projectId, worktreeId);
    if (!freshProject) return;
    const entries = buildScriptEntries(
      freshProject,
      worktreeId,
      appliedProjectWorktreeScripts,
    );

    if (freshProject.type === 'multi-repo') {
      const currentRuns = useScriptsStore.getState().runs[worktreeKey];
      if (hasActiveWorkspaceLaunchRun(currentRuns)) {
        return;
      }
      const workspaceLaunch = findWorkspaceLaunchEntry(entries);
      if (!workspaceLaunch?.onRun) {
        useGitHubStore
          .getState()
          .addToast('This worktree has no launch command', 'warning');
        return;
      }
      void workspaceLaunch.onRun().catch(() => undefined);
      return;
    }

    const runEntries = entries.filter(
      (entry) => entry.script.lifecycle === 'launch',
    );
    if (!runEntries.some((entry) => entry.request)) {
      useGitHubStore
        .getState()
        .addToast('This worktree has no launch command', 'warning');
      return;
    }
    for (const entry of runEntries) {
      if (!entry.request) {
        continue;
      }

      startRun(projectId, worktreeId, entry.script);
      void window.api
        .runScript(entry.request)
        .then((response: ScriptRunResponse) => {
          completeRun(projectId, worktreeId, entry.script.scriptKey, response);
        })
        .catch((cause: unknown) => {
          completeRun(projectId, worktreeId, entry.script.scriptKey, {
            success: false,
            exitCode: null,
            output:
              cause instanceof Error
                ? cause.message
                : 'Script execution failed',
            timedOut: false,
            durationMs: 0,
          });
        });
    }
  }, [
    appliedProjectWorktreeScripts,
    completeRun,
    projectId,
    selectedProject,
    startRun,
    worktreeId,
    worktreeKey,
  ]);

  const handleRun = useCallback((): void => {
    if (onLaunch !== undefined) {
      onLaunch();
      return;
    }
    void guardWorktreeLaunch(projectId, worktreeId, runLaunch);
  }, [onLaunch, projectId, runLaunch, worktreeId]);

  const handleStop = useCallback((): void => {
    const scriptsState = useScriptsStore.getState();
    const currentRuns = scriptsState.runs[worktreeKey];
    if (!currentRuns) return;
    for (const [scriptKey, run] of Object.entries(currentRuns)) {
      const isLaunchRun = isMultiRepoWorkspace
        ? isWorkspaceLaunchRun(run)
        : run.lifecycle === 'launch';
      if (run.status === 'running' && isLaunchRun) {
        if (!scriptsState.markStopping(projectId, worktreeId, scriptKey)) {
          continue;
        }
        void window.api
          .stopScript({ projectId, worktreeId, scriptKey })
          .then((response) => {
            const latestScriptsState = useScriptsStore.getState();
            if (response) {
              latestScriptsState.completeRun(
                projectId,
                worktreeId,
                scriptKey,
                response,
              );
              return;
            }
            latestScriptsState.completeStaleRun(
              projectId,
              worktreeId,
              scriptKey,
            );
          })
          .catch(() => {
            useScriptsStore
              .getState()
              .completeStaleRun(projectId, worktreeId, scriptKey);
          });
      }
    }
  }, [isMultiRepoWorkspace, projectId, worktreeId, worktreeKey]);

  if (!showRunButton && openSections.length === 0) {
    return <></>;
  }

  return (
    <div
      // Last tier of the header's progressive disclosure (the earlier tiers
      // live in PrStatusBar's `HEADER_PRIORITY`): below 200px of bar width
      // even this 28px control cannot fit beside the layout menu, so it goes
      // rather than overflowing the bar. Reached only when the sidebar has
      // been dragged wide enough to leave the content region a sliver.
      className="hidden items-center gap-1.5 @[200px]/topbar:flex"
      data-testid="worktree-launch-button"
    >
      {showRunButton &&
        (onLaunch === undefined && (isRunning || isStopping) ? (
          <Tooltip label={isStopping ? 'Stopping scripts' : 'Stop scripts'}>
            <HeaderActionButton
              tone="destructive"
              onClick={handleStop}
              disabled={isStopping}
              // Same ghost shell as the header's other actions (Create PR,
              // Merge, Commit & Push), toned with the failed-status token —
              // this was the last header control on hardcoded palette colors
              // (rose-500) and a bordered/filled body.
              aria-label={isStopping ? 'Stopping scripts' : 'Stop scripts'}
            >
              <span className="inline-flex items-center gap-2.5">
                <LoadingSpinner />
                {isStopping ? 'Stopping' : 'Stop'}
              </span>
            </HeaderActionButton>
          </Tooltip>
        ) : (
          // Icon-only below 640px of bar width, so the label has to live in
          // a tooltip; the shared one matches the rest of the chrome.
          <Tooltip
            label={onLaunch === undefined ? 'Launch scripts' : launchLabel}
          >
            <ExecutionActionButton
              label={launchLabel}
              ariaLabel={
                onLaunch === undefined ? 'Launch scripts' : launchLabel
              }
              variant="primary"
              dataTestId={launchTestId}
              disabled={isSetupRunning}
              onClick={handleRun}
              // Below 640px of top-bar width the label drops and the button
              // becomes a square icon, freeing room for the status region. The
              // accessible name and tooltip carry the meaning either way.
              iconOnlyWhenNarrow
              icon={<RocketLaunchIcon size="sm" aria-hidden="true" />}
            />
          </Tooltip>
        ))}
      <ActivityOpenControl
        sections={openSections}
        context={devServerContext}
        variant="header"
      />
    </div>
  );
}
