'use client';

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import {
  Stack,
  ActivityItemRow,
  AnsiOutput,
  Button,
  Disclosure,
  ExecutionActionButton,
  HeaderActionButton,
  LoadingSpinner,
  RunConfirmationCard,
  RunningProcessCard,
  COMPACT_ACTIVITY_ITEM_CLASS_NAME,
  useActivityItemDensity,
} from '@canopy/ui-shared/components';
import {
  ExternalIcon,
  TerminalBorderedIcon,
  TerminalIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ChevronIcon } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { ScriptOutputModal } from './ScriptOutputModal';
import { Divider, Surface } from '@canopy/ui-shared/components';
import { Notice } from '@canopy/ui-shared/components/Notice';

export type ScriptsSectionLifecycle = 'setup' | 'launch' | 'teardown';
export type ScriptsSectionTarget =
  | 'project'
  | 'workspace-root'
  | 'workspace-repo';
export type ScriptsSectionRunStatus =
  | 'running'
  | 'stopping'
  | 'success'
  | 'failed';

export interface ScriptsSectionScript {
  readonly scriptKey: string;
  readonly scriptName: string;
  readonly label: string;
  /** Grouped-row label override, precomputed by the host (desktop uses
   * getScriptDisplayName so multi-segment names title-case correctly). */
  readonly displayName: string;
  readonly command: string;
  readonly lifecycle: string;
  readonly target: ScriptsSectionTarget;
  readonly repoId?: string;
  readonly repoName?: string;
  readonly interactive?: true;
}

export interface ScriptsSectionEntry {
  readonly script: ScriptsSectionScript;
  readonly confirmBeforeRun: boolean;
  readonly runDisabled: boolean;
}

export interface ScriptsSectionRun {
  readonly scriptKey: string;
  readonly label: string;
  readonly status: ScriptsSectionRunStatus;
  readonly outputLines: string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly startedAt: number;
  readonly hasDevServerHits: boolean;
  readonly cancelable?: boolean;
  readonly startError?: string;
}

export interface ScriptsSectionWorkspaceLifecycleGroup {
  readonly lifecycle: ScriptsSectionLifecycle;
  readonly entry: ScriptsSectionEntry;
  readonly before?: ScriptsSectionEntry;
  readonly children: ScriptsSectionEntry[];
  readonly after?: ScriptsSectionEntry;
}

export interface ScriptsSectionBodyProps {
  readonly identityKey: string;
  readonly entries: readonly ScriptsSectionEntry[];
  readonly runs: Readonly<Record<string, ScriptsSectionRun>>;
  readonly onRun?: (entry: ScriptsSectionEntry) => Promise<void>;
  readonly onStop?: (scriptKey: string) => void | Promise<void>;
  /** Second arg is the resolved visible row label (group children use the
   * display-name override) so hosts can build matching aria labels. */
  readonly renderSourceInfoButton?: (
    entry: ScriptsSectionEntry,
    label: string,
  ) => ReactNode;
  readonly renderWorkspaceLifecycleInfoButton?: (
    group: ScriptsSectionWorkspaceLifecycleGroup,
  ) => ReactNode;
  readonly renderDevServerControl?: (
    run: ScriptsSectionRun,
    compact: boolean,
  ) => ReactNode;
  readonly renderOutputModal?: (
    run: ScriptsSectionRun,
    onClose: () => void,
    onStop?: () => void,
  ) => ReactNode;
  readonly groupWorkspaceLifecycles?: boolean;
}

interface RepoGroup {
  readonly repoId: string;
  readonly repoName: string;
  readonly entries: ScriptsSectionEntry[];
}

type ScriptRow =
  | { readonly kind: 'entry'; readonly entry: ScriptsSectionEntry }
  | {
      readonly kind: 'workspace-lifecycle';
      readonly group: ScriptsSectionWorkspaceLifecycleGroup;
    }
  | { readonly kind: 'repo-group'; readonly group: RepoGroup };

function isActive(status: ScriptsSectionRunStatus): boolean {
  return status === 'running' || status === 'stopping';
}

function isLifecycleName(value: string): value is ScriptsSectionLifecycle {
  return value === 'setup' || value === 'launch' || value === 'teardown';
}

function isWorkspaceLifecycleEntry(entry: ScriptsSectionEntry): boolean {
  return (
    entry.script.target === 'workspace-root' &&
    isLifecycleName(entry.script.scriptName) &&
    entry.script.scriptKey === `workspace-${entry.script.scriptName}`
  );
}

function rootLifecycle(
  entry: ScriptsSectionEntry,
): ScriptsSectionLifecycle | null {
  if (entry.script.target !== 'workspace-root') {
    return null;
  }
  const prefix = entry.script.scriptName.startsWith('before-')
    ? 'before-'
    : entry.script.scriptName.startsWith('after-')
      ? 'after-'
      : null;
  if (prefix === null) {
    return null;
  }
  const lifecycle = entry.script.scriptName.slice(prefix.length);
  return isLifecycleName(lifecycle) ? lifecycle : null;
}

function buildRows(
  entries: readonly ScriptsSectionEntry[],
  groupWorkspaceLifecycles: boolean,
): ScriptRow[] {
  const lifecycleGroups = new Map<
    ScriptsSectionLifecycle,
    ScriptsSectionWorkspaceLifecycleGroup
  >();
  for (const entry of entries) {
    if (
      !groupWorkspaceLifecycles ||
      !isWorkspaceLifecycleEntry(entry) ||
      !isLifecycleName(entry.script.scriptName)
    ) {
      continue;
    }
    const lifecycle = entry.script.scriptName;
    lifecycleGroups.set(lifecycle, {
      lifecycle,
      entry,
      before: entries.find(
        (candidate) =>
          candidate.script.target === 'workspace-root' &&
          candidate.script.scriptName === `before-${lifecycle}`,
      ),
      children: entries.filter(
        (candidate) =>
          candidate.script.target === 'workspace-repo' &&
          candidate.script.scriptName === lifecycle,
      ),
      after: entries.find(
        (candidate) =>
          candidate.script.target === 'workspace-root' &&
          candidate.script.scriptName === `after-${lifecycle}`,
      ),
    });
  }

  const rows: ScriptRow[] = [];
  const repoGroups = new Map<string, RepoGroup>();
  for (const entry of entries) {
    if (groupWorkspaceLifecycles && isWorkspaceLifecycleEntry(entry)) {
      if (isLifecycleName(entry.script.scriptName)) {
        const group = lifecycleGroups.get(entry.script.scriptName);
        if (group) {
          rows.push({ kind: 'workspace-lifecycle', group });
        }
      }
      continue;
    }
    const lifecycle = rootLifecycle(entry);
    if (lifecycle !== null && lifecycleGroups.has(lifecycle)) {
      continue;
    }
    if (entry.script.target !== 'workspace-repo' || !entry.script.repoId) {
      rows.push({ kind: 'entry', entry });
      continue;
    }
    const existing = repoGroups.get(entry.script.repoId);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    const group: RepoGroup = {
      repoId: entry.script.repoId,
      repoName: entry.script.repoName ?? entry.script.repoId,
      entries: [entry],
    };
    repoGroups.set(entry.script.repoId, group);
    rows.push({ kind: 'repo-group', group });
  }

  return rows.map((row) =>
    row.kind === 'repo-group' && row.group.entries.length === 1
      ? { kind: 'entry', entry: row.group.entries[0] }
      : row,
  );
}

function toggle<TValue extends string>(
  previous: Set<TValue>,
  value: TValue,
): Set<TValue> {
  const next = new Set(previous);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

export function ScriptsSectionBody({
  identityKey,
  entries,
  runs,
  onRun,
  onStop,
  renderSourceInfoButton,
  renderWorkspaceLifecycleInfoButton,
  renderDevServerControl,
  renderOutputModal = (run, onClose, onStop): JSX.Element => (
    <ScriptOutputModal run={run} onClose={onClose} onStop={onStop} />
  ),
  groupWorkspaceLifecycles = true,
}: ScriptsSectionBodyProps): JSX.Element {
  const compact = useActivityItemDensity() === 'compact';
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enlargedKey, setEnlargedKey] = useState<string | null>(null);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedLifecycles, setExpandedLifecycles] = useState<
    Set<ScriptsSectionLifecycle>
  >(() => new Set());

  useEffect((): void => {
    setConfirmingKey(null);
    setError(null);
    setEnlargedKey(null);
  }, [identityKey]);

  const runEntry = (entry: ScriptsSectionEntry): void => {
    if (onRun === undefined) return;
    setConfirmingKey(null);
    setError(null);
    void onRun(entry).catch((cause: unknown) => {
      setError(
        cause instanceof Error ? cause.message : 'Script execution failed',
      );
    });
  };
  const completedRuns = Object.entries(runs).filter(
    ([, run]) => !isActive(run.status),
  );
  const stopRun = (scriptKey: string): void => {
    if (onStop === undefined) return;
    setError(null);
    const failed = (cause: unknown): void => {
      setError(
        cause instanceof Error ? cause.message : 'Script could not be stopped',
      );
    };
    try {
      void Promise.resolve(onStop(scriptKey)).catch(failed);
    } catch (cause) {
      failed(cause);
    }
  };
  const rows = buildRows(entries, groupWorkspaceLifecycles);

  const renderEntry = (
    entry: ScriptsSectionEntry,
    labelOverride?: string,
  ): JSX.Element => {
    const key = entry.script.scriptKey;
    const run = runs[key];
    const label = labelOverride ?? entry.script.label;
    if (run !== undefined && isActive(run.status)) {
      const stopping = run.status === 'stopping';
      return (
        <RunningProcessCard
          key={key}
          dataTestId="activity-scripts-entry"
          stopDataTestId="activity-scripts-stop"
          statusContent={
            <>
              {stopping
                ? `Stopping ${run.label}…`
                : entry.script.interactive
                  ? `${run.label} · Running in terminal`
                  : run.label}
            </>
          }
          stopLabel={stopping ? 'Stopping…' : 'Stop'}
          stopDisabled={stopping}
          onStop={
            onStop && (run.cancelable !== false || stopping)
              ? (): void => stopRun(key)
              : undefined
          }
          spinner={<LoadingSpinner />}
          enlargeButton={
            !entry.script.interactive ? (
              <Button
                type="button"
                variant="ghost-accent"
                size="compact"
                iconOnly
                onClick={(): void => setEnlargedKey(key)}
                aria-label="Enlarge output"
              >
                <ExternalIcon size={14} />
              </Button>
            ) : undefined
          }
          actionSlot={
            !stopping && run.hasDevServerHits && renderDevServerControl
              ? renderDevServerControl(run, true)
              : undefined
          }
          body={
            entry.script.interactive ? undefined : (
              <AnsiOutput
                lines={run.outputLines}
                variant="tail"
                maxRenderLines={12}
                truncateLines
              />
            )
          }
        />
      );
    }
    if (confirmingKey === key) {
      return (
        <div key={key} data-testid="activity-scripts-entry">
          <RunConfirmationCard
            prompt={
              <>
                Run <span className="font-medium">{label}</span>?
              </>
            }
            details={
              entry.script.command ? (
                // Script command lines can carry arguments and secrets.
                <Surface variant="inset" className="overflow-hidden">
                  <pre
                    className={`${REPLAY_BLOCK_CLASS} max-h-20 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-2xs fg-secondary`}
                  >
                    {entry.script.command}
                  </pre>
                </Surface>
              ) : undefined
            }
            onConfirm={(): void => runEntry(entry)}
            onCancel={(): void => setConfirmingKey(null)}
          />
        </div>
      );
    }
    return (
      <ActivityItemRow
        key={key}
        label={label}
        dataTestId="activity-scripts-entry"
      >
        {!isWorkspaceLifecycleEntry(entry) &&
          renderSourceInfoButton &&
          renderSourceInfoButton(entry, label)}
        {onRun && (
          <ExecutionActionButton
            label="Run"
            ariaLabel={
              entry.script.interactive
                ? `Run ${label} in terminal`
                : `Run ${label}`
            }
            variant="default"
            onClick={(): void =>
              entry.confirmBeforeRun ? setConfirmingKey(key) : runEntry(entry)
            }
            disabled={entry.runDisabled}
            dataTestId="activity-scripts-run"
            icon={
              entry.script.interactive ? (
                <TerminalBorderedIcon
                  size="sm"
                  data-testid="interactive-script-icon"
                  aria-hidden="true"
                />
              ) : (
                <TerminalIcon
                  size="sm"
                  data-testid="default-script-icon"
                  aria-hidden="true"
                />
              )
            }
          />
        )}
      </ActivityItemRow>
    );
  };

  return (
    <div
      // The desktop-native body rendered the list, error banner, and
      // completed disclosure as DIRECT children of the ui-shared
      // PanelSection (space-y-3); this wrapper must replicate that spacing
      // between them or the rail loses the 12px gaps (CAN-1698 capture
      // evidence).
      className="flex flex-col gap-3"
      data-testid="activity-scripts-body"
    >
      <div
        className={compact ? 'flex flex-col gap-0' : 'flex flex-col gap-1.5'}
      >
        {rows.map((row) => {
          if (row.kind === 'entry') {
            return renderEntry(row.entry);
          }
          if (row.kind === 'workspace-lifecycle') {
            const { group } = row;
            const details = [group.before, group.after].filter(
              (entry): entry is ScriptsSectionEntry => entry !== undefined,
            );
            const running = group.entry.runDisabled;
            const expanded =
              details.length > 0 &&
              (expandedLifecycles.has(group.lifecycle) || running);
            return (
              <BoxUnlessCompact
                key={group.entry.script.scriptKey}
                compact={compact}
              >
                <div
                  className="group text-xs"
                  data-testid="activity-scripts-entry"
                >
                  <div
                    className={
                      compact
                        ? `flex ${COMPACT_ACTIVITY_ITEM_CLASS_NAME}`
                        : 'flex items-center gap-2 px-2.5 py-2'
                    }
                  >
                    {details.length > 0 && (
                      <HeaderActionButton
                        iconOnly
                        onClick={(): void =>
                          setExpandedLifecycles((previous) =>
                            toggle(previous, group.lifecycle),
                          )
                        }
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} project ${group.lifecycle} scripts`}
                        // The 28px control overhangs the row's text line
                        // rather than growing it.
                        className="-my-1.5"
                      >
                        <ChevronIcon open={expanded} />
                      </HeaderActionButton>
                    )}
                    <span
                      className={`min-w-0 flex-1 truncate ${compact ? 'fg-primary' : 'font-medium fg-primary/80'}`}
                    >
                      {group.entry.script.label}
                    </span>
                    {renderWorkspaceLifecycleInfoButton?.(group)}
                    {onRun && (
                      <ExecutionActionButton
                        label="Run"
                        ariaLabel={`Run ${group.entry.script.label}`}
                        variant="default"
                        onClick={(): void => runEntry(group.entry)}
                        disabled={group.entry.runDisabled}
                        dataTestId="activity-scripts-run"
                      />
                    )}
                  </div>
                  {expanded && (
                    <>
                      {compact ? null : <Divider />}
                      <div
                        className={
                          compact ? 'pl-4' : 'flex flex-col gap-1 px-2.5 py-2'
                        }
                      >
                        {details.map((entry) =>
                          renderEntry(entry, entry.script.displayName),
                        )}
                      </div>
                    </>
                  )}
                </div>
              </BoxUnlessCompact>
            );
          }
          const { group } = row;
          const running = group.entries.some((entry) => {
            const run = runs[entry.script.scriptKey];
            return run !== undefined && isActive(run.status);
          });
          const expanded = expandedRepos.has(group.repoId) || running;
          return (
            <Stack gap="tight" key={`repo-group-${group.repoId}`}>
              <button
                type="button"
                onClick={(): void =>
                  setExpandedRepos((previous) => toggle(previous, group.repoId))
                }
                aria-expanded={expanded}
                className={
                  compact
                    ? `focus-ring flex ${COMPACT_ACTIVITY_ITEM_CLASS_NAME} fg-primary`
                    : 'focus-ring flex w-full items-center gap-1.5 rounded-lg border bg-fg-primary/[0.03] px-2.5 py-2 text-left text-xs font-medium fg-primary/80 transition-colors hover:bg-fg-primary/[0.05]'
                }
                data-testid="activity-scripts-repo-toggle"
              >
                <ChevronIcon open={expanded} />
                <span className="flex-1">{group.repoName}</span>
                <span className="text-3xs font-normal fg-secondary/60">
                  {group.entries.length} scripts
                </span>
              </button>
              {expanded && (
                <div className="pl-4 flex flex-col gap-1">
                  {group.entries.map((entry) =>
                    renderEntry(entry, entry.script.displayName),
                  )}
                </div>
              )}
            </Stack>
          );
        })}
      </div>
      {error !== null && (
        <div>
          <Notice intent="destructive" role="none">
            {error}
          </Notice>
        </div>
      )}
      {completedRuns.length > 0 && (
        <Disclosure
          label={`Completed (${completedRuns.length})`}
          open={completedExpanded}
          onOpenChange={setCompletedExpanded}
          dataTestId="activity-scripts-completed"
          toggleTestId="activity-scripts-completed-toggle"
        >
          {completedRuns.map(([scriptKey, run]) => {
            const stopped =
              run.status === 'failed' &&
              run.exitCode === null &&
              !run.timedOut &&
              !run.startError;
            const failed = run.status === 'failed' && !stopped;
            const status =
              run.status === 'success'
                ? 'Success'
                : run.startError
                  ? 'Failed to start'
                  : run.timedOut
                    ? 'Timed out'
                    : run.exitCode === null
                      ? 'Stopped'
                      : `Exit ${run.exitCode}`;
            const color = failed
              ? 'fg-destructive-strong'
              : stopped
                ? 'fg-secondary'
                : 'fg-success-strong';
            return (
              <div
                key={`completed-${run.label}-${run.startedAt}`}
                className={`rounded-lg border p-2.5 text-xs ${
                  failed
                    ? 'border-fg-destructive-strong/20 bg-fg-destructive-strong/[0.06]'
                    : 'bg-fg-primary/[0.015]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {
                      <HeaderActionButton
                        iconOnly
                        onClick={(): void => setEnlargedKey(scriptKey)}
                        aria-label="Enlarge output"
                        // The 28px control overhangs the card's text line
                        // rather than growing it.
                        className="-my-1.5"
                      >
                        <ExternalIcon size={14} />
                      </HeaderActionButton>
                    }
                    <span className={`font-medium ${color}`}>{run.label}</span>
                  </div>
                  <span className="text-3xs fg-secondary">
                    {status} · {Math.round(run.durationMs / 1000)}s
                  </span>
                </div>
              </div>
            );
          })}
        </Disclosure>
      )}
      {enlargedKey !== null &&
        runs[enlargedKey] !== undefined &&
        renderOutputModal(
          runs[enlargedKey],
          (): void => setEnlargedKey(null),
          isActive(runs[enlargedKey].status) &&
            (runs[enlargedKey].cancelable !== false ||
              runs[enlargedKey].status === 'stopping') &&
            onStop
            ? (): void => stopRun(enlargedKey)
            : undefined,
        )}
    </div>
  );
}

/** The grouped box a row sits in, except in the compact list, which has none. */
function BoxUnlessCompact({
  compact,
  children,
}: {
  readonly compact: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return compact ? (
    <>{children}</>
  ) : (
    <Surface variant="group">{children}</Surface>
  );
}
