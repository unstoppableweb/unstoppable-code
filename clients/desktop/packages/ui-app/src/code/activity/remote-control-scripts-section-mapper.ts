import type {
  RemoteControlScriptDescriptor,
  RemoteControlScriptRunProjection,
} from '@canopy/protocol/remote-control/shell';
import { titleCaseIdentifier } from '@canopy/ui-shared/lib';
import type {
  ScriptsSectionEntry,
  ScriptsSectionRun,
  ScriptsSectionRunStatus,
  ScriptsSectionTarget,
} from './scripts/ScriptsSectionBody';

export interface RemoteControlScriptsSectionModel {
  readonly entries: readonly ScriptsSectionEntry[];
  readonly runs: Readonly<Record<string, ScriptsSectionRun>>;
}

const WORKSPACE_LIFECYCLE_RANK = {
  setup: 0,
  launch: 1,
  teardown: 2,
} as const;

function scriptNameFromKey(scriptKey: string): string {
  const segments = scriptKey.split(':');
  return segments[segments.length - 1] || scriptKey;
}

function workspaceLifecycleRank(entry: ScriptsSectionEntry): number | null {
  const { scriptKey, scriptName, target } = entry.script;
  const hasLifecycleIdentity =
    (target === 'workspace-root' && scriptKey === `workspace-${scriptName}`) ||
    (target === 'project' && scriptKey === `project:${scriptName}`);
  if (
    (scriptName !== 'setup' &&
      scriptName !== 'launch' &&
      scriptName !== 'teardown') ||
    !hasLifecycleIdentity
  ) {
    return null;
  }
  return WORKSPACE_LIFECYCLE_RANK[scriptName];
}

function orderEntries(
  entries: readonly ScriptsSectionEntry[],
): ScriptsSectionEntry[] {
  return entries
    .map((entry, projectionIndex) => ({
      entry,
      projectionIndex,
      lifecycleRank: workspaceLifecycleRank(entry),
    }))
    .sort((left, right) => {
      if (left.lifecycleRank === null && right.lifecycleRank === null) {
        return left.projectionIndex - right.projectionIndex;
      }
      if (left.lifecycleRank === null) return 1;
      if (right.lifecycleRank === null) return -1;
      return left.lifecycleRank - right.lifecycleRank;
    })
    .map(({ entry }) => entry);
}

function toTarget(target: string | undefined): ScriptsSectionTarget {
  return target === 'workspace-root' || target === 'workspace-repo'
    ? target
    : 'project';
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'queued' || status === 'pending';
}

function toRunStatus(status: string): ScriptsSectionRunStatus {
  if (isActiveStatus(status)) return 'running';
  if (status === 'stopping') return 'stopping';
  if (
    status === 'completed' ||
    status === 'success' ||
    status === 'succeeded'
  ) {
    return 'success';
  }
  return 'failed';
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMs(run: RemoteControlScriptRunProjection): number {
  if (run.durationMs !== undefined) return run.durationMs;
  if (run.startedAt === undefined || run.finishedAt === undefined) return 0;
  const startedAt = timestamp(run.startedAt);
  const finishedAt = timestamp(run.finishedAt);
  return startedAt > 0 && finishedAt >= startedAt ? finishedAt - startedAt : 0;
}

function toEntry(
  descriptor: RemoteControlScriptDescriptor | RemoteControlScriptRunProjection,
  runDisabled: boolean,
): ScriptsSectionEntry {
  const scriptName =
    descriptor.scriptName ?? scriptNameFromKey(descriptor.scriptKey);
  return {
    script: {
      scriptKey: descriptor.scriptKey,
      scriptName,
      label: descriptor.name,
      displayName: titleCaseIdentifier(scriptName),
      command: descriptor.command ?? '',
      lifecycle: descriptor.lifecycle ?? 'custom',
      target: toTarget(descriptor.target),
      ...(descriptor.repoId !== undefined ? { repoId: descriptor.repoId } : {}),
      ...(descriptor.repoName !== undefined
        ? { repoName: descriptor.repoName }
        : {}),
    },
    confirmBeforeRun: descriptor.lifecycle !== 'launch',
    runDisabled,
  };
}

function latestRunsByScriptKey(
  runs: readonly RemoteControlScriptRunProjection[],
): Map<string, RemoteControlScriptRunProjection> {
  const latest = new Map<string, RemoteControlScriptRunProjection>();
  for (const run of runs) {
    const existing = latest.get(run.scriptKey);
    const startedAt = run.startedAt ?? '';
    const existingStartedAt = existing?.startedAt ?? '';
    if (
      existing === undefined ||
      startedAt > existingStartedAt ||
      (startedAt === existingStartedAt &&
        isActiveStatus(run.status) &&
        !isActiveStatus(existing.status))
    ) {
      latest.set(run.scriptKey, run);
    }
  }
  return latest;
}

export function remoteControlScriptsToSectionModel(
  descriptors: readonly RemoteControlScriptDescriptor[],
  scriptRuns: readonly RemoteControlScriptRunProjection[],
): RemoteControlScriptsSectionModel {
  const latestRuns = latestRunsByScriptKey(scriptRuns);
  const entries = descriptors.map((descriptor) => {
    const status = latestRuns.get(descriptor.scriptKey)?.status ?? '';
    return toEntry(
      descriptor,
      descriptor.runDisabled === true ||
        status === 'stopping' ||
        isActiveStatus(status),
    );
  });
  const descriptorKeys = new Set(
    descriptors.map((descriptor) => descriptor.scriptKey),
  );
  latestRuns.forEach((run, scriptKey): void => {
    if (!descriptorKeys.has(scriptKey)) {
      // Preserve the current portal's orphan-run row. It can be stopped while
      // active, but cannot be rerun because no descriptor payload exists.
      entries.push(toEntry(run, true));
    }
  });

  const mappedRuns: Record<string, ScriptsSectionRun> = {};
  latestRuns.forEach((run, scriptKey): void => {
    mappedRuns[scriptKey] = {
      scriptKey,
      label: run.name,
      status: toRunStatus(run.status),
      outputLines:
        run.outputTail === undefined || run.outputTail === ''
          ? []
          : run.outputTail.replace(/\r\n/g, '\n').split('\n'),
      exitCode: run.exitCode ?? null,
      ...(run.startError === undefined ? {} : { startError: run.startError }),
      timedOut: run.timedOut ?? run.status === 'timed_out',
      durationMs: durationMs(run),
      startedAt: timestamp(run.startedAt),
      hasDevServerHits: false,
      ...(run.cancelable === undefined ? {} : { cancelable: run.cancelable }),
    };
  });

  return { entries: orderEntries(entries), runs: mappedRuns };
}
