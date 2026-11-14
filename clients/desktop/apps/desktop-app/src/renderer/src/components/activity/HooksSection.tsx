import {
  useCallback,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  HooksSectionBody,
  RunOutputModal,
  describeRunOutcome,
  type HooksSectionHostModel,
  type HooksSectionEntry,
  type HooksSectionRun,
  type RunOutcome,
  type RunOutputStatus,
} from '@canopy/ui-app';
import { ActivitySection, type CollapsedIconColor } from './ActivitySection';
import { SettingsGearButton } from './RunOutputControls';
import { SourceInfoModal } from './SourceInfoModal';
import {
  getHookTriggerDisplayName,
  getHookActionLabel,
  type HookAction,
} from '@canopy/desktop-shared/hooks';
import { getModelDisplayName } from '@canopy/desktop-shared/types';
import { resolvePipelineModelAliasLenient } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import type {
  HookRunResponse,
  HookSourceInfoRequest,
  HookSourceInfoResponse,
} from '@canopy/desktop-shared/types';
import {
  buildHookEntries,
  hasActivePrForHookEntry,
  type HookEntry,
} from './hook-utils';
import { SourceInfoLayers } from './SourceInfoLayers';
import { useProjectsStore } from '@/stores/projectsStore';
import { useHooksStore } from '@/stores/hooksStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useShallow } from 'zustand/shallow';
import { HookIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  HeaderActionButton,
  PauseResumeIcon,
  SourceInfoButton,
  CodeBlock,
} from '@canopy/ui-shared/components';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';
import {
  watchersForHook,
  visibleWatchers,
} from '@/components/watchers/watcherFilters';

function HookOutputModal({
  run,
  onClose,
  onStop,
}: {
  run: HooksSectionRun;
  onClose: () => void;
  onStop?: () => void;
}): JSX.Element {
  const isRunning = run.status === 'running';
  const isSuccess = run.status === 'success';
  const isStopped = run.status === 'stopped';

  const outcome: RunOutcome = isRunning
    ? { kind: 'running' }
    : isSuccess
      ? { kind: 'succeeded', durationMs: run.durationMs }
      : run.timedOut
        ? { kind: 'timed-out', durationMs: run.durationMs }
        : isStopped || run.exitCode === null
          ? { kind: 'stopped', durationMs: run.durationMs }
          : { kind: 'failed', durationMs: run.durationMs };

  const status: RunOutputStatus = isRunning
    ? 'active'
    : isSuccess
      ? 'success'
      : isStopped
        ? 'paused'
        : 'failed';

  return (
    <RunOutputModal
      title={run.label}
      titleId="hook-output-modal-title"
      summary={describeRunOutcome(outcome)}
      status={status}
      outputLines={run.outputLines}
      isRunning={isRunning}
      onClose={onClose}
      onStop={onStop}
      stopLabel="Stop"
      emptyText="No output"
    />
  );
}

function buildSourceInfoRequest(
  entry: HookEntry,
  projectId: string,
  worktreeId: string,
): HookSourceInfoRequest | null {
  if (entry.hook.target === 'project') {
    return {
      target: 'project',
      triggerName: entry.hook.triggerName,
      projectId,
      worktreeId,
    };
  }
  if (entry.hook.target === 'workspace-root') {
    return {
      target: 'workspace-root',
      triggerName: entry.hook.triggerName,
      workspaceId: projectId,
      worktreeId,
    };
  }
  if (!entry.hook.repoId) {
    return null;
  }
  return {
    target: 'workspace-repo',
    triggerName: entry.hook.triggerName,
    workspaceId: projectId,
    repoId: entry.hook.repoId,
    worktreeId,
  };
}

const WORKSPACE_DEFAULT_PLACEHOLDER = 'Project default';

const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

interface ActionDetailItem {
  label: string;
  value?: string;
  placeholder?: boolean;
  /** Command text, which session replay blocks. */
  replayBlocked?: boolean;
}

function HookActionDetails({
  action,
}: {
  action: HookAction;
}): JSX.Element | null {
  const items: ActionDetailItem[] = [];

  if (action.type === 'chat') {
    items.push(
      action.model
        ? {
            label: 'Model',
            // Hook actions may name a pipeline model alias ($default-codex);
            // display the alias target's label rather than the raw alias.
            value: getModelDisplayName(
              resolvePipelineModelAliasLenient(action.model),
            ),
          }
        : {
            label: 'Model',
            value: WORKSPACE_DEFAULT_PLACEHOLDER,
            placeholder: true,
          },
    );
    items.push(
      action.thinking
        ? {
            label: 'Thinking',
            value: THINKING_LEVEL_LABELS[action.thinking] ?? action.thinking,
          }
        : {
            label: 'Thinking',
            value: WORKSPACE_DEFAULT_PLACEHOLDER,
            placeholder: true,
          },
    );
    const ifCommand = action['if-command']?.trim();
    if (ifCommand) {
      items.push({
        label: 'If command',
        value: ifCommand,
        replayBlocked: true,
      });
    }
    if (action.allowChatConcurrency === true) {
      items.push({ label: 'Allows concurrent chats' });
    }
    if (action.autoArchive === true) {
      items.push({ label: 'Auto-archives when finished' });
    }
  } else if (action.type === 'pipeline') {
    if (action.allowPipelineConcurrency === true) {
      items.push({ label: 'Allows concurrent workflows' });
    }
  }

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-start gap-1.5 text-3xs fg-secondary"
        >
          <span className="font-medium fg-secondary/70">{item.label}</span>
          {item.value &&
            (item.placeholder ? (
              <span className="italic fg-secondary/60">{item.value}</span>
            ) : (
              <CodeBlock
                variant="snippet"
                replay={item.replayBlocked ? 'block' : 'inherit'}
                className="max-h-12 flex-1"
              >
                {item.value}
              </CodeBlock>
            ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A hook layer's actions. Command and chat labels quote the command or prompt,
 * so session replay blocks them; pipeline labels stay recorded. The key
 * includes the type so the block mounts with the label.
 */
export function HookActionList({
  actions,
}: {
  actions: readonly HookAction[];
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {actions.map((action, ai) => (
        <div key={`${ai}:${action.type}`} className="flex flex-col gap-1">
          <CodeBlock
            variant="snippet"
            replay={action.type === 'pipeline' ? 'inherit' : 'block'}
            className="max-h-16"
          >
            {getHookActionLabel(action)}
          </CodeBlock>
          <HookActionDetails action={action} />
        </div>
      ))}
    </div>
  );
}

function HookSourceInfoModal({
  entry,
  projectId,
  worktreeId,
  onClose,
}: {
  entry: HookEntry;
  projectId: string;
  worktreeId: string;
  onClose: () => void;
}): JSX.Element {
  const buildRequest = useCallback(
    (target: HookEntry): HookSourceInfoRequest | null =>
      buildSourceInfoRequest(target, projectId, worktreeId),
    [projectId, worktreeId],
  );
  const loadInfo = useCallback(
    (request: HookSourceInfoRequest): Promise<HookSourceInfoResponse> =>
      window.api.getHookSourceInfo(request),
    [],
  );
  return (
    <SourceInfoModal<HookEntry, HookSourceInfoRequest, HookSourceInfoResponse>
      entry={entry}
      title={entry.hook.label}
      subtitle={
        entry.hook.actions.some(
          (action) => action.type === 'command' && action.interactive === true,
        )
          ? 'Interactive terminal · Hook source info'
          : 'Hook source info'
      }
      titleId="hook-source-info-modal-title"
      missingRequestMessage="Hook is missing required repo information"
      emptyText="No sources detected for this hook."
      buildRequest={buildRequest}
      loadInfo={loadInfo}
      renderLayers={(info, emptyText): JSX.Element => (
        <SourceInfoLayers
          layers={info.layers}
          emptyText={emptyText}
          renderBody={(layer) =>
            layer.actions !== null && <HookActionList actions={layer.actions} />
          }
        />
      )}
      onClose={onClose}
    />
  );
}

const EMPTY_PAUSED_HOOK_KEYS: readonly string[] = Object.freeze([]);

function PauseToggleButton({
  paused,
  onClick,
  label,
}: {
  paused: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <HeaderActionButton
      tone={paused ? 'warning' : 'accent'}
      iconOnly
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <PauseResumeIcon paused={paused} />
    </HeaderActionButton>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useHooksHeaderChrome({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}): { subtitle: string; collapsedIconColor: CollapsedIconColor } {
  const project = useProjectsStore((state) =>
    state.projects.find((item) => item.id === projectId),
  );
  const applied = useProjectsStore(
    (state) => state.appliedProjectWorktreeHooks,
  );
  const runs = useHooksStore(
    (state) => state.runs[`${projectId}/${worktreeId}`],
  );
  const watcherGroupCount = useAppAdvisorWatchersStore((state) => {
    const keys = visibleWatchers(state.watchers)
      .filter(
        (watcher) =>
          watcher.trigger === 'worktree_hook_triggered' &&
          watcher.target.kind === 'worktree_hook' &&
          watcher.target.projectId === projectId &&
          watcher.target.worktreeId === worktreeId,
      )
      .map((watcher) =>
        watcher.target.kind === 'worktree_hook'
          ? (watcher.target.hookKey ?? `trigger:${watcher.target.triggerName}`)
          : '',
      );
    return new Set(keys).size;
  });
  const count = project
    ? buildHookEntries(project, worktreeId, applied).length
    : 0;
  const running = runs
    ? Object.values(runs).some((run) => run.status === 'running')
    : false;
  return {
    subtitle:
      count > 0
        ? `${count} configured`
        : watcherGroupCount > 0
          ? `${watcherGroupCount} watched`
          : 'None configured',
    collapsedIconColor: running
      ? 'amber'
      : count > 0 || watcherGroupCount > 0
        ? 'blue'
        : 'muted',
  };
}

export function HooksSection({
  projectId,
  worktreeId,
  onOpenSettings,
}: {
  projectId: string;
  worktreeId: string;
  onOpenSettings?: (tab: 'scripts' | 'hooks') => void;
}): JSX.Element {
  const headerChrome = useHooksHeaderChrome({ projectId, worktreeId });
  const hooksSection = useHooksSectionHostModel({ projectId, worktreeId });

  if (!hooksSection.hasProject) {
    return <></>;
  }

  const {
    hasProject: _hasProject,
    headerAction: pauseAllButton,
    supplementaryContent,
    ...bodyProps
  } = hooksSection;
  void _hasProject;
  const gearButton = onOpenSettings ? (
    <SettingsGearButton
      onClick={(): void => onOpenSettings('hooks')}
      label="Open hooks settings"
    />
  ) : null;
  const headerAction =
    pauseAllButton || gearButton ? (
      <div className="flex items-center gap-0.5">
        {pauseAllButton}
        {gearButton}
      </div>
    ) : null;
  return (
    <ActivitySection
      icon={<HookIcon />}
      title="Hooks"
      subtitle={headerChrome.subtitle}
      collapsedIconColor={headerChrome.collapsedIconColor}
      headerAction={headerAction}
    >
      {(bodyProps.entries.length > 0 ||
        bodyProps.unconfiguredWatchers.length > 0) && (
        <HooksSectionBody {...bodyProps} />
      )}
      {supplementaryContent}
    </ActivitySection>
  );
}

/**
 * Desktop-only extension of the neutral host model: `headerAction` (pause-all)
 * belongs to the surrounding section chrome and `hasProject` to the native
 * empty-fragment guard, so both are stripped by consumers before the model is
 * handed to the shared `ActivityPanel`/`HooksSectionBody`.
 */
export interface DesktopHooksSectionModel extends HooksSectionHostModel {
  readonly hasProject: boolean;
  readonly headerAction?: ReactNode;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useHooksSectionHostModel({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}): DesktopHooksSectionModel {
  const { project, pausedHookKeys } = useProjectsStore(
    useShallow((state) => {
      const proj = state.projects.find((p) => p.id === projectId);
      const worktree =
        proj && proj.type !== 'cowork'
          ? proj.worktrees.find((wt) => wt.id === worktreeId)
          : undefined;
      return {
        project: proj,
        pausedHookKeys: worktree?.pausedHookKeys ?? EMPTY_PAUSED_HOOK_KEYS,
      };
    }),
  );
  const appliedProjectWorktreeHooks = useProjectsStore(
    (state) => state.appliedProjectWorktreeHooks,
  );
  const setWorktreePausedHookKeys = useProjectsStore(
    (state) => state.setWorktreePausedHookKeys,
  );
  const worktreeKeyStr = `${projectId}/${worktreeId}`;
  const hookRuns = useHooksStore((state) => state.runs[worktreeKeyStr]);
  const startRun = useHooksStore((state) => state.startRun);
  const completeRun = useHooksStore((state) => state.completeRun);
  const hookWatchersForWorktree = useAppAdvisorWatchersStore(
    useShallow((state) =>
      visibleWatchers(state.watchers).filter(
        (watcher) =>
          watcher.trigger === 'worktree_hook_triggered' &&
          watcher.target.kind === 'worktree_hook' &&
          watcher.target.projectId === projectId &&
          watcher.target.worktreeId === worktreeId,
      ),
    ),
  );

  // Check if the target repo has a current PR snapshot
  const prStatus = useGitHubStore((state) => state.prStatuses[worktreeKeyStr]);
  const [infoEntry, setInfoEntry] = useState<HookEntry | null>(null);

  useEffect(() => {
    const watchersStore = useAppAdvisorWatchersStore.getState();
    const unsubscribe = watchersStore.subscribeBridge();
    if (!watchersStore.hydrated && !watchersStore.loading) {
      void watchersStore.hydrate();
    }
    return unsubscribe;
  }, []);

  const entries = project
    ? buildHookEntries(project, worktreeId, appliedProjectWorktreeHooks)
    : [];

  const pausedKeySet = new Set(pausedHookKeys);
  const entryKeys = entries.map((entry) => entry.hook.hookKey);
  const configuredHookKeys = new Set(entryKeys);
  const hasConfiguredHookForWatcher = (
    target: Extract<
      (typeof hookWatchersForWorktree)[number]['target'],
      { kind: 'worktree_hook' }
    >,
  ): boolean => {
    if (target.hookKey) {
      return configuredHookKeys.has(target.hookKey);
    }
    return entries.some((entry) => {
      if (entry.hook.triggerName !== target.triggerName) return false;
      if (target.scope && entry.hook.target !== target.scope) return false;
      if (target.repoId && entry.hook.repoId !== target.repoId) return false;
      return true;
    });
  };
  const allPaused =
    entries.length > 0 && entryKeys.every((key) => pausedKeySet.has(key));

  const togglePauseHook = (hookKey: string): void => {
    const next = new Set(pausedKeySet);
    if (next.has(hookKey)) {
      next.delete(hookKey);
    } else {
      next.add(hookKey);
    }
    void setWorktreePausedHookKeys(projectId, worktreeId, Array.from(next));
  };

  const togglePauseAll = (): void => {
    const nextKeys = allPaused ? [] : entryKeys;
    void setWorktreePausedHookKeys(projectId, worktreeId, nextKeys);
  };

  const pauseAllButton =
    entries.length > 0 ? (
      <PauseToggleButton
        paused={allPaused}
        onClick={togglePauseAll}
        label={allPaused ? 'Resume all hooks' : 'Pause all hooks'}
      />
    ) : null;

  const hasRunning = hookRuns
    ? Object.values(hookRuns).some((r) => r.status === 'running')
    : false;

  const handleRun = (entry: HooksSectionEntry): Promise<void> => {
    const sourceEntry = entries.find(
      (candidate) => candidate.hook.hookKey === entry.hook.hookKey,
    );
    if (!sourceEntry?.request) {
      return Promise.reject(new Error('Hook execution failed'));
    }
    startRun(projectId, worktreeId, sourceEntry.hook);
    return window.api
      .runHook(sourceEntry.request)
      .then((response: HookRunResponse) => {
        completeRun(projectId, worktreeId, entry.hook.hookKey, response);
      })
      .catch((cause: unknown) => {
        completeRun(projectId, worktreeId, entry.hook.hookKey, {
          success: false,
          exitCode: null,
          output: '',
          timedOut: false,
          durationMs: 0,
        });
        throw cause;
      });
  };

  const unconfiguredHookWatcherGroups = ((): Array<{
    key: string;
    triggerName: string;
    label: string;
    watchers: typeof hookWatchersForWorktree;
  }> => {
    // Without a hydrated project every hook looks unconfigured; suppress the
    // grouping so watcher rows do not flash during project hydration/removal.
    if (!project) return [];
    const groups = new Map<
      string,
      {
        key: string;
        triggerName: string;
        label: string;
        watchers: typeof hookWatchersForWorktree;
      }
    >();
    for (const watcher of hookWatchersForWorktree) {
      if (watcher.target.kind !== 'worktree_hook') continue;
      if (hasConfiguredHookForWatcher(watcher.target)) continue;
      const key =
        watcher.target.hookKey ?? `trigger:${watcher.target.triggerName}`;
      const existing = groups.get(key);
      if (existing) {
        existing.watchers.push(watcher);
      } else {
        groups.set(key, {
          key,
          triggerName: watcher.target.triggerName,
          label:
            watcher.target.hookLabel ??
            getHookTriggerDisplayName(watcher.target.triggerName),
          watchers: [watcher],
        });
      }
    }
    return Array.from(groups.values());
  })();

  const renderWatcherButton = (
    watchers: typeof hookWatchersForWorktree,
    key: string,
  ): JSX.Element | null => (
    <WatcherManagementButton
      watchers={watchers}
      modalTitle="Hook watchers"
      modalEmptyMessage="No active watchers for this hook."
      ariaLabel="Manage hook watchers"
      dataTestId={`hook-watchers-${key}`}
      tooltipTitle="Hook is being watched"
      className="shrink-0"
    />
  );

  const bodyEntries: HooksSectionEntry[] = entries.map((entry) => {
    const hasActivePr = hasActivePrForHookEntry(entry, prStatus);
    return {
      hook: {
        hookKey: entry.hook.hookKey,
        triggerName: entry.hook.triggerName,
        label: entry.hook.label,
        target: entry.hook.target,
        repoId: entry.hook.repoId,
        repoName: entry.hook.repoName,
        actions: entry.hook.actions.map((action) => ({
          type: action.type,
          label: getHookActionLabel(action),
          ...(action.type === 'command' && action.interactive === true
            ? { interactive: true as const }
            : {}),
        })),
      },
      groupedLabel: getHookTriggerDisplayName(entry.hook.triggerName),
      paused: pausedKeySet.has(entry.hook.hookKey),
      runDisabled: !hasActivePr || hasRunning,
      runDisabledTitle: hasActivePr
        ? undefined
        : 'Manual run requires an active PR',
    };
  });
  const watchersByKey = new Map(
    entries.map((entry) => [
      entry.hook.hookKey,
      watchersForHook(hookWatchersForWorktree, {
        projectId,
        worktreeId,
        triggerName: entry.hook.triggerName,
        hookKey: entry.hook.hookKey,
        scope: entry.hook.target,
        repoId: entry.hook.repoId,
      }),
    ]),
  );
  for (const group of unconfiguredHookWatcherGroups) {
    watchersByKey.set(group.key, group.watchers);
  }

  return {
    identityKey: worktreeKeyStr,
    hasProject: project !== undefined,
    entries: bodyEntries,
    runs: hookRuns ?? {},
    unconfiguredWatchers: unconfiguredHookWatcherGroups,
    onRun: handleRun,
    onStop: (hookKey): void => {
      void window.api.stopHook({ projectId, worktreeId, hookKey });
    },
    onTogglePause: togglePauseHook,
    renderWatcherButton: (key): JSX.Element | null =>
      renderWatcherButton(watchersByKey.get(key) ?? [], key),
    renderSourceInfoButton: (entry, displayLabel): JSX.Element => (
      <SourceInfoButton
        onClick={(): void => {
          const sourceEntry = entries.find(
            (candidate) => candidate.hook.hookKey === entry.hook.hookKey,
          );
          if (sourceEntry) {
            setInfoEntry(sourceEntry);
          }
        }}
        ariaLabel={`Source info for ${displayLabel}`}
        title="Hook source info"
      />
    ),
    renderOutputModal: (run, onClose, onStop): JSX.Element => (
      <HookOutputModal run={run} onClose={onClose} onStop={onStop} />
    ),
    headerAction: pauseAllButton,
    sourceInfoModal: infoEntry ? (
      <HookSourceInfoModal
        entry={infoEntry}
        projectId={projectId}
        worktreeId={worktreeId}
        onClose={(): void => setInfoEntry(null)}
      />
    ) : undefined,
  };
}
