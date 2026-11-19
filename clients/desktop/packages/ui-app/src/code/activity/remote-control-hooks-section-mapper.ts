import type {
  RemoteControlHookDescriptor,
  RemoteControlHookRunProjection,
} from '@canopy/protocol/remote-control/shell';
import {
  HOOK_TRIGGER_DISPLAY_LABELS,
  hookTriggerIndex,
  isHookTriggerName,
} from '@canopy/protocol/hook-triggers';
import type {
  HooksSectionEntry,
  HooksSectionHook,
  HooksSectionRun,
  HooksSectionRunStatus,
  HooksSectionTarget,
  HooksSectionUnconfiguredWatcher,
} from './hooks/HooksSectionBody';

export interface RemoteControlHooksSectionModel {
  readonly entries: readonly HooksSectionEntry[];
  readonly runs: Readonly<Record<string, HooksSectionRun>>;
  readonly unconfiguredWatchers: readonly HooksSectionUnconfiguredWatcher[];
}

function compareTriggerNames(left: string, right: string): number {
  const leftIndex = hookTriggerIndex(left);
  const rightIndex = hookTriggerIndex(right);
  if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex;
  if (leftIndex !== -1) return -1;
  if (rightIndex !== -1) return 1;
  return left.localeCompare(right);
}

function orderDescriptors(
  descriptors: readonly RemoteControlHookDescriptor[],
): RemoteControlHookDescriptor[] {
  const hasProjectTarget = descriptors.some(
    (descriptor) =>
      descriptor.target !== 'workspace-root' &&
      descriptor.target !== 'workspace-repo',
  );
  const hasWorkspaceTarget = descriptors.some(
    (descriptor) =>
      descriptor.target === 'workspace-root' ||
      descriptor.target === 'workspace-repo',
  );
  // Desktop worktrees are either project or workspace scoped. Preserve input
  // order for a mixed/future payload rather than inventing a cross-mode order.
  if (hasProjectTarget && hasWorkspaceTarget) return [...descriptors];

  const repoOrder = new Map<string, number>();
  for (const descriptor of descriptors) {
    if (
      descriptor.target === 'workspace-repo' &&
      descriptor.repoId !== undefined &&
      !repoOrder.has(descriptor.repoId)
    ) {
      repoOrder.set(descriptor.repoId, repoOrder.size);
    }
  }
  const targetOrder = (descriptor: RemoteControlHookDescriptor): number =>
    descriptor.target === 'workspace-root'
      ? 0
      : descriptor.target === 'workspace-repo'
        ? 1 + (repoOrder.get(descriptor.repoId ?? '') ?? repoOrder.size)
        : 0;
  return descriptors
    .map((descriptor, index) => ({ descriptor, index }))
    .sort(
      (left, right) =>
        targetOrder(left.descriptor) - targetOrder(right.descriptor) ||
        compareTriggerNames(
          left.descriptor.triggerName,
          right.descriptor.triggerName,
        ) ||
        left.index - right.index,
    )
    .map(({ descriptor }) => descriptor);
}

// Intentionally mirrors titleCaseIdentifier in
// packages/desktop-shared/src/lib/scoped-config-utils.ts. Once CAN-1698
// merges into this pre-merge stack, use
// @canopy/ui-shared/lib/title-case-identifier instead.
function titleCaseIdentifier(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ');
}

// Matches getHookTriggerDisplayName in packages/desktop-shared/src/hooks.ts;
// both read the shared catalog.
export function triggerDisplayName(triggerName: string): string {
  return isHookTriggerName(triggerName)
    ? HOOK_TRIGGER_DISPLAY_LABELS[triggerName]
    : titleCaseIdentifier(triggerName);
}

function toTarget(target: string | undefined): HooksSectionTarget {
  return target === 'workspace-root' || target === 'workspace-repo'
    ? target
    : 'project';
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'queued' || status === 'pending';
}

function toRunStatus(status: string): HooksSectionRunStatus {
  if (isActiveStatus(status) || status === 'stopping') return 'running';
  if (
    status === 'completed' ||
    status === 'success' ||
    status === 'succeeded'
  ) {
    return 'success';
  }
  if (status === 'cancelled' || status === 'stopped') return 'stopped';
  return 'failed';
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMs(run: RemoteControlHookRunProjection): number {
  if (run.startedAt === undefined || run.finishedAt === undefined) return 0;
  const startedAt = timestamp(run.startedAt);
  const finishedAt = timestamp(run.finishedAt);
  return startedAt > 0 && finishedAt >= startedAt ? finishedAt - startedAt : 0;
}

function outputLines(outputTail: string | undefined): readonly string[] {
  if (outputTail === undefined || outputTail === '') return [];
  const lines = outputTail.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

function toHook(
  descriptor: RemoteControlHookDescriptor | RemoteControlHookRunProjection,
): HooksSectionHook {
  return {
    hookKey: descriptor.hookKey,
    triggerName: descriptor.triggerName,
    label: descriptor.name,
    target: toTarget(descriptor.target),
    ...(descriptor.repoId !== undefined ? { repoId: descriptor.repoId } : {}),
    ...(descriptor.repoName !== undefined
      ? { repoName: descriptor.repoName }
      : {}),
    // Portal hook projections do not carry action metadata, so action icons
    // are intentionally absent.
    actions: [],
  };
}

function latestRunsByHookKey(
  runs: readonly RemoteControlHookRunProjection[],
): Map<string, RemoteControlHookRunProjection> {
  const latest = new Map<string, RemoteControlHookRunProjection>();
  for (const run of runs) {
    const existing = latest.get(run.hookKey);
    const startedAt = run.startedAt ?? '';
    const existingStartedAt = existing?.startedAt ?? '';
    if (
      existing === undefined ||
      startedAt > existingStartedAt ||
      (startedAt === existingStartedAt &&
        isActiveStatus(run.status) &&
        !isActiveStatus(existing.status))
    ) {
      latest.set(run.hookKey, run);
    }
  }
  return latest;
}

function toEntry(
  descriptor: RemoteControlHookDescriptor | RemoteControlHookRunProjection,
  paused: boolean,
  runDisabled: boolean,
  runDisabledTitle?: string,
): HooksSectionEntry {
  return {
    hook: toHook(descriptor),
    groupedLabel: triggerDisplayName(descriptor.triggerName),
    paused,
    runDisabled,
    ...(runDisabledTitle !== undefined ? { runDisabledTitle } : {}),
  };
}

export function remoteControlHooksToSectionModel(
  descriptors: readonly RemoteControlHookDescriptor[],
  hookRuns: readonly RemoteControlHookRunProjection[],
): RemoteControlHooksSectionModel {
  const latestRuns = latestRunsByHookKey(hookRuns);
  const orderedDescriptors = orderDescriptors(descriptors);
  const entries = orderedDescriptors.map((descriptor) => {
    const status = latestRuns.get(descriptor.hookKey)?.status ?? '';
    return toEntry(
      descriptor,
      descriptor.paused === true,
      descriptor.runDisabled === true ||
        status === 'stopping' ||
        isActiveStatus(status),
      descriptor.runDisabledReason,
    );
  });
  const descriptorKeys = new Set(
    orderedDescriptors.map((descriptor) => descriptor.hookKey),
  );
  latestRuns.forEach((run, hookKey): void => {
    if (!descriptorKeys.has(hookKey)) {
      // Preserve the current portal's orphan-run row. It can be stopped while
      // active, but cannot be rerun because no descriptor payload exists.
      entries.push(toEntry(run, false, true));
    }
  });

  const mappedRuns: Record<string, HooksSectionRun> = {};
  latestRuns.forEach((run, hookKey): void => {
    mappedRuns[hookKey] = {
      label: run.name,
      status: toRunStatus(run.status),
      outputLines: outputLines(run.outputTail),
      // The projection has no exit code. Failed runs therefore use the body's
      // generic "Failed" copy rather than an exit-code suffix.
      exitCode: null,
      timedOut: false,
      durationMs: durationMs(run),
      startedAt: timestamp(run.startedAt),
      activeActionIndex: run.activeActionIndex,
    };
  });

  return { entries, runs: mappedRuns, unconfiguredWatchers: [] };
}
