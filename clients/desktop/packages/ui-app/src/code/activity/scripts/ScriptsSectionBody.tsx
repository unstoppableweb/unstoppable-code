'use client';

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import {
  Stack,
  ActivityItemRow,
  AnsiOutput,
  Button,
  ConfirmDialog,
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
  /**
   * A run a restart left running, whose process could not be proven its own
   * (CAN-6482). Only a user's Stop ends it, through `onStopOrphan`.
   */
  readonly orphan?: ScriptsSectionRunOrphan;
  /** A lost run whose record names no process: it may still be running. */
  readonly lostFrom?: 'unrecorded';
}

export interface ScriptsSectionRunOrphan {
  /** The recorded process, when the record has one. */
  readonly pid?: number;
  /**
   * `recorded`: a Stop proves the process before every signal, so it needs
   * no confirmation; `unverifiable`: the record has only a PID, so the user
   * confirms a warning first.
   */
  readonly identity: 'recorded' | 'unverifiable';
}

/** How a user's Stop of an orphaned run ended (`worker.script.execution.stop`). */
export type ScriptsSectionOrphanStopOutcome =
  | 'stopped'
  | 'still_running'
  | 'gone'
  | 'not_same'
  | 'unverifiable'
  | 'group_remains';

/** One live process of an orphaned run's group, as the user confirms it (CAN-6601). */
export interface ScriptsSectionOrphanGroupMember {
  readonly pid: number;
  readonly startIdentity: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** The executable's name, never its arguments. */
  readonly command: string;
}

/**
 * An orphaned run's group once its leader has exited
 * (`worker.script.execution.groupMembers`). `offerable`: every member can be
 * tied to the run, so a confirmed group Force stop may be offered.
 */
export interface ScriptsSectionOrphanGroup {
  readonly state: 'listed' | 'not_group' | 'unverifiable';
  readonly offerable: boolean;
  readonly members: readonly ScriptsSectionOrphanGroupMember[];
}

/** What a confirmed group Force stop did (CAN-6601). */
export interface ScriptsSectionOrphanGroupStop {
  readonly outcome: 'stopped' | 'still_running' | 'unverifiable';
  readonly members: readonly {
    readonly pid: number;
    readonly outcome:
      | 'stopped'
      | 'killed'
      | 'gone'
      | 'not_same'
      | 'still_running';
  }[];
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
  /**
   * Stops an orphaned run's recorded process on the user's request. `force`
   * follows a Stop that left an unverifiable record's process running.
   * `confirmed` says the user accepted the warning. Hosts that can't stop
   * one leave it unset, and the run shows without the action.
   */
  readonly onStopOrphan?: (
    scriptKey: string,
    request: { readonly mode: 'stop' | 'force'; readonly confirmed: boolean },
  ) => Promise<ScriptsSectionOrphanStopOutcome>;
  /**
   * Lists the live processes of an orphaned run's group after a Stop found
   * its leader gone (`group_remains`, CAN-6601). With
   * `onForceStopOrphanGroup`, the row then offers a confirmed group Force
   * stop; hosts without either leave the run as it is.
   */
  readonly onListOrphanGroup?: (
    scriptKey: string,
  ) => Promise<ScriptsSectionOrphanGroup>;
  /** Force stops exactly the members the user confirmed (CAN-6601). */
  readonly onForceStopOrphanGroup?: (
    scriptKey: string,
    members: readonly ScriptsSectionOrphanGroupMember[],
  ) => Promise<ScriptsSectionOrphanGroupStop>;
  /**
   * Removes a lost run's record and output (`lostFrom`), on the user's
   * request. It never signals a process.
   */
  readonly onRemoveRun?: (scriptKey: string) => Promise<void>;
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
  onStopOrphan,
  onListOrphanGroup,
  onForceStopOrphanGroup,
  onRemoveRun,
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
  /** The orphaned run whose Stop or Force stop awaits the user's confirmation. */
  const [confirmingOrphan, setConfirmingOrphan] = useState<{
    readonly scriptKey: string;
    readonly mode: 'stop' | 'force';
  } | null>(null);
  /** Unverifiable runs whose Stop left the process running: Force stop is next. */
  const [forceOffered, setForceOffered] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** Runs whose Stop found the leader gone and its group running (CAN-6601). */
  const [groupOffered, setGroupOffered] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** The group members awaiting the user's confirmation of a group Force stop. */
  const [confirmingGroup, setConfirmingGroup] = useState<{
    readonly scriptKey: string;
    readonly members: readonly ScriptsSectionOrphanGroupMember[];
  } | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const groupStoppable =
    onListOrphanGroup !== undefined && onForceStopOrphanGroup !== undefined;

  useEffect((): void => {
    setConfirmingKey(null);
    setError(null);
    setEnlargedKey(null);
    setConfirmingOrphan(null);
    setForceOffered(new Set());
    setGroupOffered(new Set());
    setConfirmingGroup(null);
    setRemovingKey(null);
    setBusyKey(null);
    setNotice(null);
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
  const stopOrphan = (
    scriptKey: string,
    run: ScriptsSectionRun,
    mode: 'stop' | 'force',
    confirmed: boolean,
  ): void => {
    if (onStopOrphan === undefined || run.orphan === undefined) return;
    setError(null);
    setNotice(null);
    setBusyKey(scriptKey);
    void onStopOrphan(scriptKey, { mode, confirmed })
      .then((outcome): void => {
        setConfirmingOrphan(null);
        const offered = new Set(forceOffered);
        offered.delete(scriptKey);
        if (
          outcome === 'still_running' &&
          run.orphan?.identity === 'unverifiable'
        )
          offered.add(scriptKey);
        setForceOffered(offered);
        const grouped = new Set(groupOffered);
        grouped.delete(scriptKey);
        if (outcome === 'group_remains' && groupStoppable)
          grouped.add(scriptKey);
        setGroupOffered(grouped);
        setNotice(orphanStopNotice(outcome, run.orphan, groupStoppable));
      })
      .catch((cause: unknown): void => {
        setConfirmingOrphan(null);
        setError(
          cause instanceof Error
            ? cause.message
            : 'The process could not be stopped',
        );
      })
      .finally((): void => setBusyKey(null));
  };
  /**
   * Reads the group's members (CAN-6601): a confirmation when every one can
   * be tied to the run, otherwise a notice that lists them and offers
   * nothing. A group that has emptied is stopped through the record, which
   * records the run lost.
   */
  const requestGroupStop = (
    scriptKey: string,
    run: ScriptsSectionRun,
  ): void => {
    if (onListOrphanGroup === undefined) return;
    setError(null);
    setNotice(null);
    setBusyKey(scriptKey);
    // An emptied group hands the row to a Stop, which owns the busy state.
    let handedToStop = false;
    void onListOrphanGroup(scriptKey)
      .then((group): void => {
        if (group.state === 'listed' && group.members.length === 0) {
          handedToStop = true;
          stopOrphan(scriptKey, run, 'stop', false);
          return;
        }
        if (group.state === 'listed' && group.offerable) {
          setConfirmingGroup({ scriptKey, members: group.members });
          return;
        }
        const grouped = new Set(groupOffered);
        grouped.delete(scriptKey);
        setGroupOffered(grouped);
        setNotice(
          group.state === 'listed'
            ? unprovenGroupNotice(group.members)
            : 'The app can’t read this run’s processes, so nothing was stopped.',
        );
      })
      .catch((cause: unknown): void => {
        setError(
          cause instanceof Error
            ? cause.message
            : 'The processes could not be read',
        );
      })
      .finally((): void => {
        if (!handedToStop) setBusyKey(null);
      });
  };
  const forceStopGroup = (
    scriptKey: string,
    members: readonly ScriptsSectionOrphanGroupMember[],
  ): void => {
    if (onForceStopOrphanGroup === undefined) return;
    setError(null);
    setNotice(null);
    setBusyKey(scriptKey);
    void onForceStopOrphanGroup(scriptKey, members)
      .then((result): void => {
        setConfirmingGroup(null);
        if (result.outcome === 'stopped') {
          const grouped = new Set(groupOffered);
          grouped.delete(scriptKey);
          setGroupOffered(grouped);
        }
        setNotice(groupStopNotice(result));
      })
      .catch((cause: unknown): void => {
        setConfirmingGroup(null);
        setError(
          cause instanceof Error
            ? cause.message
            : 'The processes could not be stopped',
        );
      })
      .finally((): void => setBusyKey(null));
  };
  const requestOrphanStop = (
    scriptKey: string,
    run: ScriptsSectionRun,
  ): void => {
    if (run.orphan === undefined) return;
    if (groupOffered.has(scriptKey)) {
      requestGroupStop(scriptKey, run);
      return;
    }
    const mode = forceOffered.has(scriptKey) ? 'force' : 'stop';
    // A full record is proven before every signal, so it needs no confirm.
    if (run.orphan.identity === 'recorded' && mode === 'stop') {
      stopOrphan(scriptKey, run, 'stop', false);
      return;
    }
    setConfirmingOrphan({ scriptKey, mode });
  };
  const removeRun = (scriptKey: string): void => {
    if (onRemoveRun === undefined) return;
    setError(null);
    setNotice(null);
    setBusyKey(scriptKey);
    void onRemoveRun(scriptKey)
      .then((): void => setRemovingKey(null))
      .catch((cause: unknown): void => {
        setRemovingKey(null);
        setError(
          cause instanceof Error
            ? cause.message
            : 'The run could not be removed',
        );
      })
      .finally((): void => setBusyKey(null));
  };
  const rows = buildRows(entries, groupWorkspaceLifecycles);

  const renderEntry = (
    entry: ScriptsSectionEntry,
    labelOverride?: string,
  ): JSX.Element => {
    const key = entry.script.scriptKey;
    const run = runs[key];
    const label = labelOverride ?? entry.script.label;
    if (run !== undefined && isActive(run.status) && run.orphan) {
      const busy = busyKey === key;
      const force = forceOffered.has(key) || groupOffered.has(key);
      return (
        <RunningProcessCard
          key={key}
          dataTestId="activity-scripts-entry"
          stopDataTestId="activity-scripts-stop-orphan"
          statusContent={
            // The restart is the user's own; "process" stays the plain word
            // for what Stop ends (UX writing: voice).
            <>
              {run.label} · Still running from before a restart
              {run.orphan.pid !== undefined
                ? ` · Process ${run.orphan.pid}`
                : ''}
            </>
          }
          stopLabel={busy ? 'Stopping…' : force ? 'Force stop' : 'Stop'}
          stopDisabled={busy}
          onStop={
            onStopOrphan ? (): void => requestOrphanStop(key, run) : undefined
          }
          spinner={<LoadingSpinner />}
          enlargeButton={
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
          }
          body={
            <AnsiOutput
              lines={run.outputLines}
              variant="tail"
              maxRenderLines={12}
              truncateLines
            />
          }
        />
      );
    }
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
          <Notice
            errorSource="scripts-section-body"
            intent="destructive"
            role="none"
          >
            {error}
          </Notice>
        </div>
      )}
      {notice !== null && (
        <div data-testid="activity-scripts-orphan-notice">
          <Notice role="status">{notice}</Notice>
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
                : run.lostFrom === 'unrecorded'
                  ? // Coordinator's wording (12 Nov 2026): the record names no
                    // process, so it may still be running.
                    'Started by an earlier version, may still be running'
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
                className={`flex flex-col gap-2 rounded-lg border p-2.5 text-xs ${
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
                    {run.lostFrom === 'unrecorded'
                      ? status
                      : `${status} · ${Math.round(run.durationMs / 1000)}s`}
                  </span>
                </div>
                {run.lostFrom === 'unrecorded' && onRemoveRun && (
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="secondary"
                      size="compact"
                      disabled={busyKey === scriptKey}
                      onClick={(): void => setRemovingKey(scriptKey)}
                      data-testid="activity-scripts-remove-run"
                    >
                      Remove
                    </Button>
                  </div>
                )}
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
            runs[enlargedKey].orphan === undefined &&
            (runs[enlargedKey].cancelable !== false ||
              runs[enlargedKey].status === 'stopping') &&
            onStop
            ? (): void => stopRun(enlargedKey)
            : undefined,
        )}
      {confirmingOrphan !== null &&
        runs[confirmingOrphan.scriptKey]?.orphan !== undefined && (
          <OrphanStopDialog
            run={runs[confirmingOrphan.scriptKey]}
            mode={confirmingOrphan.mode}
            busy={busyKey === confirmingOrphan.scriptKey}
            onConfirm={(): void =>
              stopOrphan(
                confirmingOrphan.scriptKey,
                runs[confirmingOrphan.scriptKey],
                confirmingOrphan.mode,
                true,
              )
            }
            onCancel={(): void => setConfirmingOrphan(null)}
          />
        )}
      {confirmingGroup !== null &&
        runs[confirmingGroup.scriptKey]?.orphan !== undefined && (
          <OrphanGroupStopDialog
            members={confirmingGroup.members}
            busy={busyKey === confirmingGroup.scriptKey}
            onConfirm={(): void =>
              forceStopGroup(confirmingGroup.scriptKey, confirmingGroup.members)
            }
            onCancel={(): void => setConfirmingGroup(null)}
          />
        )}
      {removingKey !== null && runs[removingKey] !== undefined && (
        <ConfirmDialog
          title={`Remove run “${runs[removingKey].label}”?`}
          // Removing never signals a process: say so, since the run may still
          // be running.
          message="Its output will be deleted. If its process is still running, it keeps running."
          confirmLabel="Remove run"
          busyLabel="Removing…"
          busy={busyKey === removingKey}
          destructive
          dataTestId="activity-scripts-remove-run-dialog"
          onConfirm={(): void => removeRun(removingKey)}
          onCancel={(): void => setRemovingKey(null)}
        />
      )}
    </div>
  );
}

/** What a finished Stop of an orphaned run tells the user, or null for none. */
function orphanStopNotice(
  outcome: ScriptsSectionOrphanStopOutcome,
  orphan: ScriptsSectionRunOrphan | undefined,
  groupStoppable: boolean,
): string | null {
  const process =
    orphan?.pid !== undefined ? `Process ${orphan.pid}` : 'The process';
  switch (outcome) {
    case 'stopped':
    case 'gone':
      return null;
    case 'still_running':
      return orphan?.identity === 'unverifiable'
        ? `${process} is still running. You can force stop it.`
        : `${process} is still running.`;
    case 'not_same':
      return 'This script’s process already ended, and another program now uses its process number. Nothing was stopped.';
    case 'unverifiable':
      return 'The app can’t confirm this process belongs to the script, so nothing was stopped.';
    case 'group_remains':
      return groupStoppable
        ? 'The script’s main process has ended, but processes it started are still running. You can force stop them.'
        : 'The script’s main process has ended, but processes it started are still running.';
  }
}

/** Members the app can't tie to the run: listed, with no action (coordinator, 12 Nov 2026). */
function unprovenGroupNotice(
  members: readonly ScriptsSectionOrphanGroupMember[],
): ReactNode {
  const count =
    members.length === 1
      ? '1 process from this run is'
      : `${members.length} processes from this run are`;
  return (
    <>
      {count} still running, but the app can’t confirm they all belong to it, so
      it won’t stop them:{' '}
      {members.map((member, index) => (
        <span key={member.pid}>
          {index > 0 ? ', ' : ''}
          {member.pid} (
          <span className={REPLAY_BLOCK_CLASS}>{member.command}</span>)
        </span>
      ))}
      .
    </>
  );
}

/** What a group Force stop tells the user, or null once the run's processes are all gone. */
function groupStopNotice(result: ScriptsSectionOrphanGroupStop): string | null {
  if (result.outcome === 'unverifiable')
    return 'The app can’t read this run’s processes, so nothing was stopped.';
  const skipped = result.members
    .filter((member) => member.outcome === 'not_same')
    .map((member) => member.pid);
  const skippedNote =
    skipped.length === 0
      ? ''
      : ` ${skipped.length === 1 ? 'Process' : 'Processes'} ${skipped.join(', ')} changed since they were listed, so ${skipped.length === 1 ? 'it wasn’t' : 'they weren’t'} stopped.`;
  if (result.outcome === 'stopped')
    return skippedNote === '' ? null : skippedNote.trim();
  return `Some of this run’s processes are still running.${skippedNote}`;
}

/**
 * The warning before a Stop that can't be proven first: an unverifiable
 * record's Stop, and every Force stop (coordinator decision, 12 Nov 2026).
 */
function OrphanStopDialog({
  run,
  mode,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly run: ScriptsSectionRun;
  readonly mode: 'stop' | 'force';
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const pid = run.orphan?.pid;
  const target = pid !== undefined ? `process ${pid}` : 'this process';
  const force = mode === 'force';
  return (
    <ConfirmDialog
      title={force ? `Force stop ${target}?` : `Stop ${target}?`}
      message={
        force
          ? 'It didn’t stop when asked. Force stopping ends it at once, without letting it finish its work. The app can’t confirm it still belongs to this script.'
          : 'It started before the app restarted, and the app can’t confirm it still belongs to this script. If it doesn’t, another program will be stopped.'
      }
      confirmLabel={force ? 'Force stop process' : 'Stop process'}
      busyLabel="Stopping…"
      busy={busy}
      destructive
      dataTestId="activity-scripts-orphan-stop-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/**
 * The confirmation of a group Force stop (CAN-6601): each process with its
 * PID, command and start time, and the warning that the app can't verify
 * them (coordinator decision, 12 Nov 2026).
 */
function OrphanGroupStopDialog({
  members,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly members: readonly ScriptsSectionOrphanGroupMember[];
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const many = members.length !== 1;
  return (
    <ConfirmDialog
      title={
        many
          ? `Force stop ${members.length} processes?`
          : 'Force stop 1 process?'
      }
      message={`The script’s main process has ended, but ${many ? 'these processes it started are' : 'this process it started is'} still running. Force stopping ends ${many ? 'them' : 'it'} without letting ${many ? 'them' : 'it'} finish. The app can’t verify ${many ? 'they belong' : 'it belongs'} to this script.`}
      confirmLabel={many ? 'Force stop processes' : 'Force stop process'}
      busyLabel="Stopping…"
      busy={busy}
      destructive
      dataTestId="activity-scripts-orphan-group-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <ul
        className="flex flex-col gap-1 text-xs"
        data-testid="activity-scripts-orphan-group-members"
      >
        {members.map((member) => (
          <li key={member.pid} className="flex gap-2">
            <span className="tabular-nums fg-secondary">{member.pid}</span>
            <span className={`truncate font-mono ${REPLAY_BLOCK_CLASS}`}>
              {member.command}
            </span>
            <span className="ml-auto fg-secondary">
              Started {new Date(member.startedAt).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
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
