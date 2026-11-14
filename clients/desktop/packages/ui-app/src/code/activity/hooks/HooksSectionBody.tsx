'use client';

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import {
  Stack,
  HeaderActionButton,
  AnsiOutput,
  Button,
  Disclosure,
  ExecutionActionButton,
  LoadingSpinner,
  PauseResumeIcon,
  RunConfirmationCard,
  RunningProcessCard,
  COMPACT_ACTIVITY_ITEM_CLASS_NAME,
  useActivityItemDensity,
} from '@canopy/ui-shared/components';
import {
  ChatIcon,
  ExternalIcon,
  PipelineIcon,
  TerminalBorderedIcon,
  TerminalIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ChevronIcon } from '@canopy/ui-shared/icons';
import { PAUSED_HOOK_LABEL_CLASSES } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { Notice } from '@canopy/ui-shared/components/Notice';
import { Surface } from '@canopy/ui-shared/components';

export type HooksSectionTarget =
  | 'project'
  | 'workspace-root'
  | 'workspace-repo';
export type HooksSectionActionType = 'command' | 'pipeline' | 'chat';
export type HooksSectionRunStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'stopped';

export interface HooksSectionAction {
  readonly type: HooksSectionActionType;
  readonly label: string;
  readonly interactive?: true;
}

export interface HooksSectionHook {
  readonly hookKey: string;
  readonly triggerName: string;
  readonly label: string;
  readonly target: HooksSectionTarget;
  readonly repoId?: string;
  readonly repoName?: string;
  readonly actions: readonly HooksSectionAction[];
}

export interface HooksSectionEntry {
  readonly hook: HooksSectionHook;
  readonly groupedLabel: string;
  readonly paused: boolean;
  readonly runDisabled: boolean;
  readonly runDisabledTitle?: string;
}

export interface HooksSectionRun {
  readonly label: string;
  readonly status: HooksSectionRunStatus;
  readonly outputLines: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly startedAt: number;
  /** Zero-based index of the action currently executing, when known. */
  readonly activeActionIndex?: number;
}

export interface HooksSectionUnconfiguredWatcher {
  readonly key: string;
  readonly label: string;
}

export interface HooksSectionBodyProps {
  readonly identityKey: string;
  readonly entries: readonly HooksSectionEntry[];
  readonly runs: Readonly<Record<string, HooksSectionRun>>;
  readonly unconfiguredWatchers: readonly HooksSectionUnconfiguredWatcher[];
  readonly onRun?: (entry: HooksSectionEntry) => Promise<void>;
  readonly onStop?: (hookKey: string) => void;
  readonly onTogglePause?: (hookKey: string) => void;
  readonly renderWatcherButton?: (key: string) => ReactNode;
  readonly renderSourceInfoButton?: (
    entry: HooksSectionEntry,
    displayLabel: string,
  ) => ReactNode;
  readonly sourceInfoModal?: ReactNode;
  readonly renderOutputModal?: (
    run: HooksSectionRun,
    onClose: () => void,
    onStop?: () => void,
  ) => ReactNode;
}

interface RepoGroup {
  readonly repoId: string;
  readonly repoName: string;
  readonly entries: HooksSectionEntry[];
}

type HookRow =
  | { readonly kind: 'entry'; readonly entry: HooksSectionEntry }
  | { readonly kind: 'repo-group'; readonly group: RepoGroup };

function buildRows(entries: readonly HooksSectionEntry[]): HookRow[] {
  const rows: HookRow[] = [];
  const repoGroups = new Map<string, RepoGroup>();
  for (const entry of entries) {
    if (
      entry.hook.target !== 'workspace-repo' ||
      entry.hook.repoId === undefined
    ) {
      rows.push({ kind: 'entry', entry });
      continue;
    }
    const existing = repoGroups.get(entry.hook.repoId);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    const group: RepoGroup = {
      repoId: entry.hook.repoId,
      repoName: entry.hook.repoName ?? entry.hook.repoId,
      entries: [entry],
    };
    repoGroups.set(entry.hook.repoId, group);
    rows.push({ kind: 'repo-group', group });
  }
  return rows.map((row) =>
    row.kind === 'repo-group' && row.group.entries.length === 1
      ? { kind: 'entry', entry: row.group.entries[0] }
      : row,
  );
}

function toggle(previous: Set<string>, value: string): Set<string> {
  const next = new Set(previous);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

export function PauseToggleButton({
  paused,
  onClick,
  label,
}: {
  readonly paused: boolean;
  readonly onClick: () => void;
  readonly label: string;
}): JSX.Element {
  return (
    <HeaderActionButton
      tone={paused ? 'warning' : 'accent'}
      iconOnly
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid="activity-hooks-pause-toggle"
    >
      <PauseResumeIcon paused={paused} />
    </HeaderActionButton>
  );
}

function HookLiveOutput({
  run,
  interactive,
  onStop,
  onEnlarge,
}: {
  readonly run: HooksSectionRun;
  readonly interactive: boolean;
  readonly onStop?: () => void;
  readonly onEnlarge?: () => void;
}): JSX.Element {
  return (
    <RunningProcessCard
      dataTestId="activity-hooks-entry"
      statusContent={
        <>
          {interactive
            ? `${run.label} · Running in terminal`
            : `Running ${run.label}…`}
        </>
      }
      stopLabel="Stop"
      onStop={onStop}
      spinner={<LoadingSpinner />}
      enlargeButton={
        onEnlarge && !interactive ? (
          <Button
            type="button"
            variant="ghost-accent"
            size="compact"
            iconOnly
            onClick={onEnlarge}
            aria-label="Enlarge output"
          >
            <ExternalIcon size={14} />
          </Button>
        ) : undefined
      }
      body={
        interactive ? undefined : (
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

function HookCompletedRunCard({
  run,
  onEnlarge,
}: {
  readonly run: HooksSectionRun;
  readonly onEnlarge?: () => void;
}): JSX.Element {
  const isSuccess = run.status === 'success';
  const isStopped = run.status === 'stopped';
  const containerClass = isSuccess
    ? 'bg-fg-primary/[0.015]'
    : isStopped
      ? 'border-line-attention bg-warning/[0.06]'
      : 'border-fg-destructive-strong/20 bg-fg-destructive-strong/[0.06]';
  const colorClass = isSuccess
    ? 'fg-success-strong'
    : isStopped
      ? 'fg-warning'
      : 'fg-destructive-strong';
  const statusText = isSuccess
    ? 'Success'
    : isStopped
      ? 'Stopped'
      : run.timedOut
        ? 'Timed out'
        : run.exitCode === null
          ? 'Failed'
          : `Exit ${run.exitCode}`;
  return (
    <div className={`rounded-lg border p-2.5 text-xs ${containerClass}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {onEnlarge && (
            <HeaderActionButton
              iconOnly
              onClick={onEnlarge}
              aria-label="Enlarge output"
              // The 28px control overhangs the card's text line rather than
              // growing it.
              className="-my-1.5"
            >
              <ExternalIcon size={14} />
            </HeaderActionButton>
          )}
          <span className={`font-medium ${colorClass}`}>{run.label}</span>
        </div>
        <span className="text-3xs fg-secondary">
          {statusText} · {Math.round(run.durationMs / 1000)}s
        </span>
      </div>
    </div>
  );
}

function runIcon(entry: HooksSectionEntry): JSX.Element | null {
  const action = entry.hook.actions[0];
  const type = action?.type;
  if (type === undefined) {
    return null;
  }
  if (type === 'chat') {
    return <ChatIcon size="sm" />;
  }
  if (type === 'pipeline') {
    return <PipelineIcon size="sm" />;
  }
  return action.interactive ? (
    <TerminalBorderedIcon
      size="sm"
      data-testid="interactive-hook-command-icon"
      aria-hidden="true"
    />
  ) : (
    <TerminalIcon
      size="sm"
      data-testid="default-hook-command-icon"
      aria-hidden="true"
    />
  );
}

function hasInteractiveAction(entry: HooksSectionEntry): boolean {
  return entry.hook.actions.some(
    (action) => action.type === 'command' && action.interactive === true,
  );
}

function isActiveActionInteractive(
  entry: HooksSectionEntry,
  run: HooksSectionRun,
): boolean {
  if (run.activeActionIndex !== undefined) {
    const action = entry.hook.actions[run.activeActionIndex];
    return action?.type === 'command' && action.interactive === true;
  }
  return (
    entry.hook.actions.length === 1 &&
    entry.hook.actions[0]?.type === 'command' &&
    entry.hook.actions[0].interactive === true
  );
}

export function HooksSectionBody({
  identityKey,
  entries,
  runs,
  unconfiguredWatchers,
  onRun,
  onStop,
  onTogglePause,
  renderWatcherButton,
  renderSourceInfoButton,
  sourceInfoModal,
  renderOutputModal,
}: HooksSectionBodyProps): JSX.Element {
  const compact = useActivityItemDensity() === 'compact';
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enlargedKey, setEnlargedKey] = useState<string | null>(null);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect((): void => {
    setConfirmingKey(null);
    setError(null);
    setEnlargedKey(null);
  }, [identityKey]);

  const runEntry = (entry: HooksSectionEntry): void => {
    if (onRun === undefined) return;
    setConfirmingKey(null);
    setError(null);
    void onRun(entry).catch((cause: unknown) => {
      setError(
        cause instanceof Error ? cause.message : 'Hook execution failed',
      );
    });
  };
  const completedRuns = Object.entries(runs).filter(
    ([, run]) => run.status !== 'running',
  );
  const rows = buildRows(entries);

  const renderEntry = (
    entry: HooksSectionEntry,
    labelOverride?: string,
  ): JSX.Element => {
    const key = entry.hook.hookKey;
    const run = runs[key];
    const label = labelOverride ?? entry.hook.label;
    const configuredInteractive = hasInteractiveAction(entry);
    if (run !== undefined && run.status === 'running') {
      const interactive = isActiveActionInteractive(entry, run);
      return (
        <HookLiveOutput
          key={key}
          run={run}
          interactive={interactive}
          onStop={onStop ? (): void => onStop(key) : undefined}
          onEnlarge={
            renderOutputModal && !interactive
              ? (): void => setEnlargedKey(key)
              : undefined
          }
        />
      );
    }
    if (confirmingKey === key) {
      return (
        <div key={key} data-testid="activity-hooks-entry">
          <RunConfirmationCard
            prompt={
              <>
                Run <span className="font-medium">{label}</span>?
              </>
            }
            details={
              <div className="flex flex-col gap-1">
                {entry.hook.actions.map((action, index) => (
                  // Command and chat labels quote the command or prompt;
                  // pipeline labels name the pipeline and stay recorded.
                  <Surface
                    key={`${action.type}-${index}`}
                    variant="inset"
                    className="overflow-hidden"
                  >
                    <pre
                      className={`${action.type === 'pipeline' ? '' : REPLAY_BLOCK_CLASS} max-h-20 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-2xs fg-secondary`}
                    >
                      {action.label}
                    </pre>
                  </Surface>
                ))}
              </div>
            }
            onConfirm={(): void => runEntry(entry)}
            onCancel={(): void => setConfirmingKey(null)}
          />
        </div>
      );
    }
    return (
      <BoxUnlessCompact key={key} compact={compact}>
        <div
          className={
            compact
              ? `group flex ${COMPACT_ACTIVITY_ITEM_CLASS_NAME} pointer-coarse:gap-4`
              : 'group flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs pointer-coarse:gap-4'
          }
          data-testid="activity-hooks-entry"
        >
          <span
            className={`flex-1 ${compact ? 'min-w-0 truncate ' : 'font-medium '}${
              entry.paused
                ? PAUSED_HOOK_LABEL_CLASSES
                : compact
                  ? 'fg-primary'
                  : 'fg-primary/80'
            }`}
          >
            {label}
          </span>
          {renderSourceInfoButton?.(entry, label)}
          {renderWatcherButton?.(key)}
          {onTogglePause && (
            <PauseToggleButton
              paused={entry.paused}
              onClick={(): void => onTogglePause(key)}
              label={entry.paused ? `Resume ${label}` : `Pause ${label}`}
            />
          )}
          {onRun && (
            <ExecutionActionButton
              label="Run"
              ariaLabel={
                configuredInteractive
                  ? `Run ${label} in terminal`
                  : `Run ${label}`
              }
              variant="default"
              disabled={entry.runDisabled}
              onClick={(): void => setConfirmingKey(key)}
              title={entry.runDisabledTitle}
              dataTestId="activity-hooks-run"
              icon={runIcon(entry)}
            />
          )}
        </div>
      </BoxUnlessCompact>
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="activity-hooks-body">
      <div
        className={compact ? 'flex flex-col gap-0' : 'flex flex-col gap-1.5'}
      >
        {rows.map((row) => {
          if (row.kind === 'entry') {
            return renderEntry(row.entry);
          }
          const running = row.group.entries.some(
            (entry) => runs[entry.hook.hookKey]?.status === 'running',
          );
          const expanded = expandedRepos.has(row.group.repoId) || running;
          return (
            <Stack gap="tight" key={`repo-group-${row.group.repoId}`}>
              <button
                type="button"
                onClick={(): void =>
                  setExpandedRepos((previous) =>
                    toggle(previous, row.group.repoId),
                  )
                }
                aria-expanded={expanded}
                className={
                  compact
                    ? `focus-ring flex ${COMPACT_ACTIVITY_ITEM_CLASS_NAME} fg-primary`
                    : 'focus-ring flex w-full items-center gap-1.5 rounded-lg border bg-fg-primary/[0.03] px-2.5 py-2 text-left text-xs font-medium fg-primary/80 transition-colors hover:bg-fg-primary/[0.05]'
                }
              >
                <ChevronIcon open={expanded} />
                <span className="flex-1">{row.group.repoName}</span>
                <span className="text-3xs font-normal fg-secondary/60">
                  {row.group.entries.length} hooks
                </span>
              </button>
              {expanded && (
                <div className="pl-4 flex flex-col gap-1">
                  {row.group.entries.map((entry) =>
                    renderEntry(entry, entry.groupedLabel),
                  )}
                </div>
              )}
            </Stack>
          );
        })}
        {unconfiguredWatchers.map((watcher) => (
          <BoxUnlessCompact
            key={`unconfigured-watch-${watcher.key}`}
            compact={compact}
          >
            <div
              className={
                compact
                  ? `group flex ${COMPACT_ACTIVITY_ITEM_CLASS_NAME} pointer-coarse:gap-4`
                  : 'group flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs pointer-coarse:gap-4'
              }
            >
              <span className="flex-1 font-medium fg-secondary">
                {watcher.label}
              </span>
              {renderWatcherButton?.(watcher.key)}
            </div>
          </BoxUnlessCompact>
        ))}
      </div>
      {error !== null && (
        <div>
          <Notice
            errorSource="hooks-section-body"
            intent="destructive"
            role="none"
          >
            {error}
          </Notice>
        </div>
      )}
      {completedRuns.length > 0 && (
        <Disclosure
          label={`Completed (${completedRuns.length})`}
          open={completedExpanded}
          onOpenChange={setCompletedExpanded}
          dataTestId="activity-hooks-completed"
          toggleTestId="activity-hooks-completed-toggle"
        >
          {completedRuns.map(([hookKey, run]) => (
            <HookCompletedRunCard
              key={`completed-${run.label}-${run.startedAt}`}
              run={run}
              onEnlarge={
                renderOutputModal
                  ? (): void => setEnlargedKey(hookKey)
                  : undefined
              }
            />
          ))}
        </Disclosure>
      )}
      {enlargedKey !== null &&
        runs[enlargedKey] !== undefined &&
        renderOutputModal &&
        renderOutputModal(
          runs[enlargedKey],
          (): void => setEnlargedKey(null),
          runs[enlargedKey].status === 'running' && onStop
            ? (): void => onStop(enlargedKey)
            : undefined,
        )}
      {sourceInfoModal}
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
