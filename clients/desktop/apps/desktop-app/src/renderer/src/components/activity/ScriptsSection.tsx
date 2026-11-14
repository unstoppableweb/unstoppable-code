import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  ScriptsSectionBody,
  ScriptOutputModal as SharedScriptOutputModal,
  type ScriptsSectionHostModel,
  type ScriptsSectionBodyProps,
  type ScriptsSectionEntry,
  type ScriptsSectionRun,
  type ScriptsSectionWorkspaceLifecycleGroup,
} from '@canopy/ui-app';
import {
  Stack,
  DialogModal,
  LoadingSpinner,
  SourceInfoButton,
  Surface,
  CodeBlock,
} from '@canopy/ui-shared/components';
import { RocketLaunchIcon } from '@canopy/ui-shared/icons';
import type {
  ScriptRunResponse,
  ScriptSourceInfoRequest,
  ScriptSourceInfoResponse,
} from '@canopy/desktop-shared/types';
import { getScriptDisplayName } from '@canopy/desktop-shared/scripts';
import type { ProjectLifecycleScriptName } from '@canopy/desktop-shared/scripts';
import { ActivitySection, type CollapsedIconColor } from './ActivitySection';
import { SettingsGearButton } from './RunOutputControls';
import { DevServerOpenControl } from './DevServerOpenControl';
import type { DevServerOpenContext } from './devServerOpen';
import { SourceInfoModal } from './SourceInfoModal';
import { buildScriptEntries, type ScriptEntry } from './script-utils';
import { SourceInfoLayers } from './SourceInfoLayers';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  clearScriptRun,
  stopOrphanedScriptRun,
  listOrphanedScriptRunGroup,
  forceStopOrphanedScriptRunGroup,
  type ScriptRunTarget,
} from '@/client/script-run-actions-client';
import {
  getSourceLayerStatusColor,
  getSourceLayerStatusLabel,
} from './source-info-layer-helpers';
import {
  hasActiveWorkspaceLifecycleRun,
  isScriptRunActive,
  useScriptsStore,
  type ScriptRunState,
} from '@/stores/scriptsStore';

function ScriptOutputModal({
  run,
  context,
  onClose,
  onStop,
}: {
  run: ScriptRunState;
  context: DevServerOpenContext;
  onClose: () => void;
  onStop?: () => void;
}): JSX.Element {
  return (
    <SharedScriptOutputModal
      run={run}
      onClose={onClose}
      onStop={onStop}
      devServerSlot={
        run.devServerHits.length > 0 ? (
          <DevServerOpenControl hits={run.devServerHits} context={context} />
        ) : undefined
      }
    />
  );
}

function buildSourceInfoRequest(
  entry: ScriptEntry,
  projectId: string,
  worktreeId: string,
): ScriptSourceInfoRequest | null {
  if (entry.script.target === 'project') {
    return {
      target: 'project',
      scriptName: entry.script.scriptName,
      projectId,
      worktreeId,
    };
  }
  if (entry.script.target === 'workspace-root') {
    return {
      target: 'workspace-root',
      scriptName: entry.script.scriptName,
      workspaceId: projectId,
      worktreeId,
    };
  }
  if (!entry.script.repoId) {
    return null;
  }
  return {
    target: 'workspace-repo',
    scriptName: entry.script.scriptName,
    workspaceId: projectId,
    repoId: entry.script.repoId,
    worktreeId,
  };
}

function ScriptSourceInfoModal({
  entry,
  projectId,
  worktreeId,
  onClose,
}: {
  entry: ScriptEntry;
  projectId: string;
  worktreeId: string;
  onClose: () => void;
}): JSX.Element {
  const buildRequest = useCallback(
    (target: ScriptEntry): ScriptSourceInfoRequest | null =>
      buildSourceInfoRequest(target, projectId, worktreeId),
    [projectId, worktreeId],
  );
  const loadInfo = useCallback(
    (request: ScriptSourceInfoRequest): Promise<ScriptSourceInfoResponse> =>
      window.api.getScriptSourceInfo(request),
    [],
  );
  return (
    <SourceInfoModal<
      ScriptEntry,
      ScriptSourceInfoRequest,
      ScriptSourceInfoResponse
    >
      entry={entry}
      title={entry.script.label}
      subtitle={
        entry.script.interactive
          ? 'Interactive terminal · Script source info'
          : 'Script source info'
      }
      titleId="script-source-info-modal-title"
      missingRequestMessage="Script is missing required repo information"
      emptyText="No sources detected for this script."
      buildRequest={buildRequest}
      loadInfo={loadInfo}
      renderLayers={(info, emptyText): JSX.Element => (
        <SourceInfoLayers
          separateBody
          layers={info.layers}
          emptyText={emptyText}
          renderBody={(layer) =>
            layer.command !== null && (
              <CodeBlock variant="snippet" className="max-h-16">
                {layer.command}
              </CodeBlock>
            )
          }
        />
      )}
      onClose={onClose}
    />
  );
}

interface WorkspaceLifecycleSourceInfo {
  entry: ScriptEntry;
  info: ScriptSourceInfoResponse | null;
  error: string | null;
}

function WorkspaceLifecycleInfoModal({
  group,
  entriesByKey,
  projectId,
  worktreeId,
  onClose,
}: {
  group: ScriptsSectionWorkspaceLifecycleGroup;
  entriesByKey: ReadonlyMap<string, ScriptEntry>;
  projectId: string;
  worktreeId: string;
  onClose: () => void;
}): JSX.Element {
  const sequence = useMemo(() => {
    const bodyEntries = [group.before, ...group.children, group.after].filter(
      (entry): entry is ScriptsSectionEntry => entry !== undefined,
    );
    return bodyEntries.flatMap((entry) => {
      const source = entriesByKey.get(entry.script.scriptKey);
      return source ? [source] : [];
    });
  }, [entriesByKey, group]);
  const [items, setItems] = useState<WorkspaceLifecycleSourceInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setItems([]);
    void Promise.all(
      sequence.map(async (entry): Promise<WorkspaceLifecycleSourceInfo> => {
        const request = buildSourceInfoRequest(entry, projectId, worktreeId);
        if (!request) {
          return {
            entry,
            info: null,
            error: 'Script is missing required repo information',
          };
        }
        try {
          return {
            entry,
            info: await window.api.getScriptSourceInfo(request),
            error: null,
          };
        } catch (cause: unknown) {
          return {
            entry,
            info: null,
            error:
              cause instanceof Error
                ? cause.message
                : 'Failed to load source info',
          };
        }
      }),
    ).then((nextItems) => {
      if (!cancelled) {
        setItems(nextItems);
        setLoading(false);
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, [projectId, sequence, worktreeId]);

  return (
    <DialogModal
      onClose={onClose}
      title={group.entry.script.label}
      subtitle={
        [group.before, ...group.children, group.after].some(
          (entry) => entry?.script.interactive === true,
        )
          ? 'Includes interactive terminal scripts · Project lifecycle sequence'
          : 'Project lifecycle sequence'
      }
      titleId="workspace-lifecycle-info-modal-title"
      maxWidth="3xl"
    >
      <div className="max-h-[70vh] overflow-auto">
        {loading && (
          <div className="flex justify-center py-4">
            <LoadingSpinner />
          </div>
        )}
        {!loading && items.length === 0 && (
          <p className="py-2 text-xs fg-secondary">
            No scripts will run for this lifecycle.
          </p>
        )}
        {!loading && items.length > 0 && (
          <Stack gap="item">
            {items.map((item, index) => (
              <Surface
                variant="group"
                padding="compact"
                key={`${item.entry.script.scriptKey}-${index}`}
              >
                <div className="flex flex-col gap-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-baseline gap-1.5 font-medium fg-primary/80">
                      <span className="fg-secondary/60">{index + 1}.</span>
                      {item.entry.script.label}
                    </span>
                    <span className="shrink-0 text-3xs font-medium fg-secondary/60">
                      {item.entry.script.target === 'workspace-root'
                        ? 'Project'
                        : (item.entry.script.repoName ?? 'Repo')}
                    </span>
                  </div>
                  {item.error && (
                    <div className="text-2xs fg-destructive-strong">
                      {item.error}
                    </div>
                  )}
                  {item.info && (
                    <div className="flex flex-col gap-1.5">
                      {item.info.layers.map((layer) => (
                        <div
                          key={layer.sourceKey}
                          className={`flex flex-col gap-1 rounded border px-2 py-1.5 ${
                            layer.status === 'active'
                              ? 'border-line-positive bg-success/[0.05]'
                              : 'bg-base/50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={
                                layer.status === 'active'
                                  ? 'font-medium fg-success-strong'
                                  : 'fg-secondary'
                              }
                            >
                              {layer.sourceLabel}
                            </span>
                            <span
                              className={`text-3xs font-medium ${getSourceLayerStatusColor(layer.status)}`}
                            >
                              {getSourceLayerStatusLabel(layer.status)}
                            </span>
                          </div>
                          {layer.command !== null && (
                            <CodeBlock variant="snippet" className="max-h-14">
                              {layer.command}
                            </CodeBlock>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Surface>
            ))}
          </Stack>
        )}
      </div>
    </DialogModal>
  );
}

function isWorkspaceLifecycleEntry(entry: ScriptEntry): boolean {
  return (
    entry.script.target === 'workspace-root' &&
    (entry.script.scriptName === 'setup' ||
      entry.script.scriptName === 'launch' ||
      entry.script.scriptName === 'teardown') &&
    entry.script.scriptKey === `workspace-${entry.script.scriptName}`
  );
}

function getWorkspaceLifecycle(
  entry: ScriptEntry,
): ProjectLifecycleScriptName | null {
  if (!isWorkspaceLifecycleEntry(entry)) {
    return null;
  }
  const name = entry.script.scriptName;
  return name === 'setup' || name === 'launch' || name === 'teardown'
    ? name
    : null;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useScriptsHeaderChrome({
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
    (state) => state.appliedProjectWorktreeScripts,
  );
  const runs = useScriptsStore(
    (state) => state.runs[`${projectId}/${worktreeId}`],
  );
  const count = project
    ? buildScriptEntries(project, worktreeId, applied).length
    : 0;
  const running = runs
    ? Object.values(runs).some((run) => isScriptRunActive(run.status))
    : false;
  return {
    subtitle: count > 0 ? `${count} configured` : 'None configured',
    collapsedIconColor: running ? 'amber' : count > 0 ? 'blue' : 'muted',
  };
}

export function ScriptsSection({
  projectId,
  worktreeId,
  onOpenSettings,
}: {
  projectId: string;
  worktreeId: string;
  onOpenSettings?: (tab: 'scripts' | 'hooks') => void;
}): JSX.Element {
  const headerChrome = useScriptsHeaderChrome({ projectId, worktreeId });
  const scriptsSection = useScriptsSectionHostModel({ projectId, worktreeId });
  const hasProject = useProjectsStore((state) =>
    state.projects.some((item) => item.id === projectId),
  );
  const gearAction = onOpenSettings ? (
    <SettingsGearButton
      onClick={(): void => onOpenSettings('scripts')}
      label="Open scripts settings"
    />
  ) : null;

  if (!hasProject) {
    return <></>;
  }

  const { supplementaryContent, ...bodyProps } = scriptsSection;
  return (
    <ActivitySection
      icon={<RocketLaunchIcon size="sm" />}
      title="Scripts"
      subtitle={headerChrome.subtitle}
      collapsedIconColor={headerChrome.collapsedIconColor}
      headerAction={gearAction}
    >
      {bodyProps.entries.length > 0 && <ScriptsSectionBody {...bodyProps} />}
      {supplementaryContent}
    </ActivitySection>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useScriptsSectionHostModel({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}): ScriptsSectionHostModel {
  const project = useProjectsStore((state) =>
    state.projects.find((item) => item.id === projectId),
  );
  const applied = useProjectsStore(
    (state) => state.appliedProjectWorktreeScripts,
  );
  const worktreeKey = `${projectId}/${worktreeId}`;
  const scriptRuns = useScriptsStore((state) => state.runs[worktreeKey]);
  const startRun = useScriptsStore((state) => state.startRun);
  const completeRun = useScriptsStore((state) => state.completeRun);
  const completeStaleRun = useScriptsStore((state) => state.completeStaleRun);
  const markStopping = useScriptsStore((state) => state.markStopping);
  const settlePersistedRun = useScriptsStore(
    (state) => state.settlePersistedRun,
  );
  const [infoEntry, setInfoEntry] = useState<ScriptEntry | null>(null);
  const [lifecycleInfo, setLifecycleInfo] =
    useState<ScriptsSectionWorkspaceLifecycleGroup | null>(null);

  useEffect((): void => {
    setInfoEntry(null);
    setLifecycleInfo(null);
  }, [worktreeKey]);

  // Memoized so WorkspaceLifecycleInfoModal's data-loading effect (keyed on
  // entriesByKey identity) does not refetch IPC on unrelated parent renders.
  const entries = useMemo(
    () => (project ? buildScriptEntries(project, worktreeId, applied) : []),
    [project, worktreeId, applied],
  );
  const entriesByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.script.scriptKey, entry])),
    [entries],
  );

  const runs = scriptRuns ?? {};
  const bodyEntries: ScriptsSectionEntry[] = entries.map((entry) => {
    const lifecycle = getWorkspaceLifecycle(entry);
    const active =
      lifecycle !== null
        ? hasActiveWorkspaceLifecycleRun(scriptRuns, lifecycle)
        : Boolean(
            scriptRuns?.[entry.script.scriptKey] &&
            isScriptRunActive(scriptRuns[entry.script.scriptKey].status),
          );
    return {
      script: {
        ...entry.script,
        displayName: getScriptDisplayName(entry.script.scriptName),
      },
      confirmBeforeRun: entry.script.lifecycle !== 'launch',
      runDisabled: active,
    };
  });
  const bodyRuns: Record<string, ScriptsSectionRun> = {};
  for (const [scriptKey, run] of Object.entries(runs)) {
    bodyRuns[scriptKey] = {
      scriptKey,
      label: run.label,
      status: run.status,
      outputLines: run.outputLines,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      startedAt: run.startedAt,
      hasDevServerHits: run.devServerHits.length > 0,
      ...(run.orphan && { orphan: run.orphan }),
      ...(run.lostFrom && { lostFrom: run.lostFrom }),
    };
  }
  /** The persisted run a Stop or Remove names, as the store last read it. */
  const persistedRun = (scriptKey: string): ScriptRunTarget => {
    const executionId = runs[scriptKey]?.executionId;
    if (executionId === undefined)
      throw new Error('This run changed. Refresh the list and try again.');
    return { projectId, worktreeId, scriptKey, executionId };
  };
  const stopOrphan: ScriptsSectionBodyProps['onStopOrphan'] = async (
    scriptKey,
    request,
  ) => {
    const target = persistedRun(scriptKey);
    const outcome = await stopOrphanedScriptRun(target, request);
    if (outcome === 'stopped' || outcome === 'gone')
      settlePersistedRun(
        projectId,
        worktreeId,
        scriptKey,
        target.executionId,
        'lost',
      );
    return outcome;
  };
  const listOrphanGroup: ScriptsSectionBodyProps['onListOrphanGroup'] = (
    scriptKey,
  ) => listOrphanedScriptRunGroup(persistedRun(scriptKey));
  const forceStopOrphanGroup: ScriptsSectionBodyProps['onForceStopOrphanGroup'] =
    async (scriptKey, members) => {
      const target = persistedRun(scriptKey);
      const result = await forceStopOrphanedScriptRunGroup(target, members);
      // The whole group is gone: the run is recorded lost.
      if (result.outcome === 'stopped')
        settlePersistedRun(
          projectId,
          worktreeId,
          scriptKey,
          target.executionId,
          'lost',
        );
      return result;
    };
  const removeRun = async (scriptKey: string): Promise<void> => {
    const target = persistedRun(scriptKey);
    // False: the key's latest run is another one now, so this one is gone.
    await clearScriptRun(target);
    settlePersistedRun(
      projectId,
      worktreeId,
      scriptKey,
      target.executionId,
      'cleared',
    );
  };

  const stopRun = (scriptKey: string): void => {
    const token = markStopping(projectId, worktreeId, scriptKey);
    if (!token) {
      return;
    }
    void window.api
      .stopScript({ projectId, worktreeId, scriptKey })
      .then((response) => {
        if (response) {
          completeRun(projectId, worktreeId, scriptKey, response, token);
        } else {
          completeStaleRun(projectId, worktreeId, scriptKey, token);
        }
      })
      .catch(() => completeStaleRun(projectId, worktreeId, scriptKey, token));
  };
  const runEntry = async (bodyEntry: ScriptsSectionEntry): Promise<void> => {
    const entry = entriesByKey.get(bodyEntry.script.scriptKey);
    if (!entry || bodyEntry.runDisabled) {
      return;
    }
    if (entry.onRun) {
      await entry.onRun();
      return;
    }
    if (!entry.request) {
      throw new Error('Script execution failed');
    }
    const token = startRun(projectId, worktreeId, entry.script);
    try {
      const response: ScriptRunResponse = await window.api.runScript(
        entry.request,
      );
      completeRun(
        projectId,
        worktreeId,
        entry.script.scriptKey,
        response,
        token,
      );
    } catch (cause: unknown) {
      completeRun(
        projectId,
        worktreeId,
        entry.script.scriptKey,
        {
          success: false,
          exitCode: null,
          output: '',
          timedOut: false,
          durationMs: 0,
        },
        token,
      );
      throw cause;
    }
  };
  return {
    identityKey: worktreeKey,
    entries: project ? bodyEntries : [],
    runs: bodyRuns,
    onRun: runEntry,
    onStop: stopRun,
    onStopOrphan: stopOrphan,
    onListOrphanGroup: listOrphanGroup,
    onForceStopOrphanGroup: forceStopOrphanGroup,
    onRemoveRun: removeRun,
    groupWorkspaceLifecycles: true,
    renderSourceInfoButton: (entry, label): JSX.Element => (
      <SourceInfoButton
        onClick={(): void => {
          const source = entriesByKey.get(entry.script.scriptKey);
          if (source) {
            setInfoEntry(source);
          }
        }}
        ariaLabel={`Source info for ${label}`}
        title="Script source info"
      />
    ),
    renderWorkspaceLifecycleInfoButton: (group): JSX.Element => (
      <SourceInfoButton
        onClick={(): void => setLifecycleInfo(group)}
        ariaLabel={`Source info for ${group.entry.script.label}`}
        title="Script source info"
      />
    ),
    renderDevServerControl: (run): JSX.Element | null => {
      const sourceRun = runs[run.scriptKey];
      return sourceRun && sourceRun.devServerHits.length > 0 ? (
        <DevServerOpenControl
          hits={sourceRun.devServerHits}
          context={{ projectId, worktreeId }}
        />
      ) : null;
    },
    renderOutputModal: (run, onClose, onStop): JSX.Element | null => {
      const sourceRun = runs[run.scriptKey];
      return sourceRun ? (
        <ScriptOutputModal
          run={sourceRun}
          context={{ projectId, worktreeId }}
          onClose={onClose}
          onStop={onStop}
        />
      ) : null;
    },
    supplementaryContent: (
      <>
        {infoEntry && (
          <ScriptSourceInfoModal
            entry={infoEntry}
            projectId={projectId}
            worktreeId={worktreeId}
            onClose={(): void => setInfoEntry(null)}
          />
        )}
        {lifecycleInfo && (
          <WorkspaceLifecycleInfoModal
            group={lifecycleInfo}
            entriesByKey={entriesByKey}
            projectId={projectId}
            worktreeId={worktreeId}
            onClose={(): void => setLifecycleInfo(null)}
          />
        )}
      </>
    ),
  };
}
