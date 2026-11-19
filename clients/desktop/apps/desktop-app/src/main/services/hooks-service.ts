import type {
  HookDescriptor,
  HookRunRequest,
  HookRunResponse,
  HookRunSnapshot,
  HookSourceInfoRequest,
  HookSourceInfoResponse,
  HookStopRequest,
  SaveProjectHooksRequest,
  SaveWorkspaceHooksRequest,
  SaveWorkspaceRepoHooksRequest,
  RemoteControlEntityEnvelope,
  RemoteControlHookRun,
  RemoteControlHookSummary,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { worktreeScopedParentLocalId } from '@canopy/protocol/remote-control/shell';
import { validateId } from '../lib/validation';
import { createHookKey } from '@canopy/desktop-shared/hooks';
import type { HookIdentity } from '../lib/hook-initiated-work';
import {
  fireHook,
  stopRunningHook,
  type HookRunPreparation,
  type RunHookOptions,
} from '../lib/hook-runner';
import { RemoteControlServiceError } from './remote-control-service-error';
import {
  getResolvedHookActions,
  type ResolvedHookMap,
  resolveProjectHooks,
  resolveWorkspaceRepoHooks,
  resolveWorkspaceRootHooks,
} from '../lib/hook-resolver';
import {
  createProjectHookDescriptor,
  createWorkspaceRepoHookDescriptor,
  createWorkspaceRootHookDescriptor,
} from '../lib/hook-events';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  normalizePausedHookKeys,
  ScriptHookSettingsRefusedError,
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
  type ScriptHookSettingsSource,
  type WorktreeHookPauseChange,
} from '../lib/workspace-script-hook-settings';
import {
  getProjectRepoStorageKey,
  getWorkspaceRepoStorageKey,
  getWorkspaceRootRepoStorageKey,
  readCurrentPrTrackingSnapshot,
} from '../lib/github-pr-hook-state';
import {
  getWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
} from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import type {
  CanopyCallerDescriptor,
  CoreHookSourceTarget,
} from '@canopy/protocol/canopy-core';
import { getDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import {
  getHookSourceInfoThroughCore,
  HOOK_SOURCE_HOST_CALLER,
  listHookSourcesThroughCore,
} from '../canopy-runtime/hook-source-dispatch';
import { readAllSidebarItems } from '../lib/sidebar-items';
import type { HookRunLogRef } from '../lib/hook-log-store';
import {
  listHookRunLogTails,
  listLatestHookRunLogTails,
  readHookRunLogTail,
} from '../lib/hook-log-store';
import {
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

export async function getWorktreePausedHookKeys(input: {
  projectId: string;
  worktreeId: string;
}): Promise<string[]> {
  validateId(input.projectId, 'projectId');
  validateId(input.worktreeId, 'worktreeId');
  const worktree = (await readWorkspaceWorktrees(input.projectId)).find(
    (candidate) => candidate.id === input.worktreeId,
  );
  if (!worktree) {
    throw new RemoteControlServiceError(
      'not_found',
      `Worktree ${input.worktreeId} not found in project ${input.projectId}`,
    );
  }
  return normalizePausedHookKeys(worktree.pausedHookKeys ?? []);
}

/**
 * `core.worktree.hooks.setPaused` for the hooks service's callers: the
 * renderer's `worktree:set-paused-hooks` replaces the whole set, and the
 * portal and App Advisor pause or resume named keys. An unknown worktree is
 * refused as `not_found`, as it always was.
 */
export async function changeWorktreeHookPause(
  input: {
    projectId: string;
    worktreeId: string;
    change: WorktreeHookPauseChange;
    source: ScriptHookSettingsSource;
  },
  setPaused: typeof setWorktreeHooksPaused = setWorktreeHooksPaused,
): Promise<{ worktree: WorktreeData; pausedHookKeys: string[] }> {
  try {
    const outcome = await setPaused({
      workspaceId: input.projectId,
      worktreeId: input.worktreeId,
      change: input.change,
      source: input.source,
    });
    return {
      worktree: outcome.worktree,
      pausedHookKeys: outcome.pausedHookKeys,
    };
  } catch (error) {
    if (
      error instanceof ScriptHookSettingsRefusedError &&
      error.reason === 'not-found'
    ) {
      throw new RemoteControlServiceError('not_found', error.message);
    }
    throw error;
  }
}

/**
 * The renderer's `worktree:set-paused-hooks`; its IPC handler passes the
 * registered operation's projection (W7b-1b).
 */
export async function setWorktreePausedHookKeys(
  input: {
    projectId: string;
    worktreeId: string;
    pausedHookKeys: readonly unknown[];
  },
  setPaused: typeof setWorktreeHooksPaused = setWorktreeHooksPaused,
): Promise<WorktreeData> {
  const { worktree } = await changeWorktreeHookPause(
    {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      change: { kind: 'replace', pausedHookKeys: input.pausedHookKeys },
      source: 'desktop',
    },
    setPaused,
  );
  return worktree;
}

/**
 * Pause or resume one listed hook, or every listed hook, of a worktree. The
 * change applies to the latest worktree row, so a competing pause or resume
 * is kept. Portal's `portal.hook.pause`/`resume` and the tunneled
 * `hook:change-pause` (browser Remote Control, CAN-5985) both run it. A hook
 * the worktree does not list is refused as `not_found`.
 */
export async function changeListedHookPause(
  input: {
    projectId: string;
    worktreeId: string;
    kind: 'pause' | 'resume';
    selection: { readonly hookKey: string } | { readonly all: true };
    source: ScriptHookSettingsSource;
  },
  setPaused: typeof setWorktreeHooksPaused = setWorktreeHooksPaused,
  listed: typeof listHooks = listHooks,
): Promise<{ pausedHookKeys: string[] }> {
  const hooks = await listed({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
  });
  let hookKeys: string[];
  if ('hookKey' in input.selection) {
    const { hookKey } = input.selection;
    if (!hooks.some((hook) => hook.hookKey === hookKey)) {
      throw new RemoteControlServiceError(
        'not_found',
        `Hook ${hookKey} was not found.`,
      );
    }
    hookKeys = [hookKey];
  } else {
    hookKeys = hooks.map((hook) => hook.hookKey);
  }
  const { pausedHookKeys } = await changeWorktreeHookPause(
    {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      change: { kind: input.kind, hookKeys },
      source: input.source,
    },
    setPaused,
  );
  return { pausedHookKeys };
}

const NOOP_SUCCESS: HookRunResponse = {
  success: true,
  stopped: false,
  exitCode: 0,
  output: '',
  timedOut: false,
  durationMs: 0,
};
const RUN_TAIL_MAX_BYTES = 8 * 1024;
const MANUAL_RUN_REQUIRES_ACTIVE_PR = 'Manual run requires an active PR';

export async function remoteControlHookRunAvailability(
  input: {
    projectId: string;
    worktreeId: string;
    target: HookDescriptor['target'];
    repoId?: string;
  },
  readSnapshot: typeof readCurrentPrTrackingSnapshot = readCurrentPrTrackingSnapshot,
): Promise<
  Pick<RemoteControlHookSummary, 'runDisabled' | 'runDisabledReason'>
> {
  const repoStorageKey =
    input.target === 'project'
      ? getProjectRepoStorageKey()
      : input.target === 'workspace-root'
        ? getWorkspaceRootRepoStorageKey()
        : input.repoId
          ? getWorkspaceRepoStorageKey(input.repoId)
          : null;
  const hasActivePr =
    repoStorageKey !== null &&
    (
      await readSnapshot({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        repoStorageKey,
      }).catch(() => ({ snapshot: null }))
    ).snapshot !== null;

  // Keep this predicate aligned with hasActivePrForHookEntry and the
  // runDisabledTitle mapping in renderer activity/HooksSection.tsx.
  return hasActivePr
    ? {}
    : {
        runDisabled: true,
        runDisabledReason: MANUAL_RUN_REQUIRES_ACTIVE_PR,
      };
}

function manualHookIdentity(request: HookRunRequest): HookIdentity {
  const repoId =
    request.target === 'workspace-repo' ? request.repoId : undefined;
  return {
    hookKey: createHookKey(request.target, request.triggerName, repoId),
    triggerName: request.triggerName,
    target: request.target,
    ...(repoId !== undefined ? { repoId } : {}),
  };
}

function noActivePrError(message: string): RemoteControlServiceError {
  return new RemoteControlServiceError('execution_failed', message);
}

/**
 * A manual or Portal hook run. It bypasses the worktree's pause explicitly;
 * the core hook source decides its split lock (before any configuration is
 * read), deletion fence and owner gates. A configured hook needs an active PR
 * snapshot.
 */
export function runHookCommand(
  request: HookRunRequest,
  options: {
    portalCommandId?: string;
    onRunUpdate?: (run: RemoteControlHookRun) => void;
    getWindow?: RunHookOptions['getWindow'];
    onEnqueued?: RunHookOptions['onEnqueued'];
    onStarted?: RunHookOptions['onStarted'];
    onOutput?: RunHookOptions['onOutput'];
    onComplete?: RunHookOptions['onComplete'];
  } = {},
): Promise<HookRunResponse> {
  const hookWorkspaceId =
    request.target === 'project' ? request.projectId : request.workspaceId;
  const occurrenceKey =
    options.portalCommandId !== undefined
      ? `portal:${options.portalCommandId}`
      : undefined;
  try {
    validateId(hookWorkspaceId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    if (request.target === 'workspace-repo')
      validateId(request.repoId, 'repoId');
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  return fireHook(
    {
      projectId: hookWorkspaceId,
      worktreeId: request.worktreeId,
      hook: manualHookIdentity(request),
      invocation: 'manual',
      pause: 'bypass',
      ...(occurrenceKey !== undefined ? { occurrenceKey } : {}),
      getWindow: options.getWindow ?? ((): null => null),
    },
    async (): Promise<HookRunPreparation> => {
      const prefs = await readPreferencesFile();
      const resolved = await resolveHookForRun(request);
      if (!resolved.hook)
        return { kind: 'unconfigured', response: NOOP_SUCCESS };
      const snapshotRef = await readCurrentPrTrackingSnapshot({
        projectId: resolved.workspaceId,
        worktreeId: request.worktreeId,
        repoStorageKey: resolved.repoStorageKey,
      });
      if (!snapshotRef.snapshot)
        return {
          kind: 'refused',
          gate: 'activePr',
          error: noActivePrError(
            request.target === 'project'
              ? 'No current PR snapshot exists for this worktree.'
              : 'No current PR snapshot exists for this repo target.',
          ),
        };
      return {
        kind: 'ready',
        options: resolvedHookRunOptions({
          projectId: resolved.workspaceId,
          worktreeId: request.worktreeId,
          hook: resolved.hook,
          cwd: resolved.cwd,
          timeoutSeconds: prefs.scriptTimeoutMinutes * 60,
          snapshotRef: { ...snapshotRef, snapshot: snapshotRef.snapshot },
          portalCommandId: options.portalCommandId,
          onRunUpdate: options.onRunUpdate,
          getWindow: options.getWindow,
          onEnqueued: options.onEnqueued,
          onStarted: options.onStarted,
          onOutput: options.onOutput,
          onComplete: options.onComplete,
        }),
      };
    },
  );
}

/**
 * The hook a run request names, resolved from the target's layered
 * configuration, with its checkout and PR tracking location. `hook` is null
 * when the trigger has no actions there.
 */
export async function resolveHookForRun(request: HookRunRequest): Promise<{
  workspaceId: string;
  hook: HookDescriptor | null;
  cwd: string;
  repoStorageKey: string;
}> {
  if (request.target === 'project') {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    const config = await readWorkspaceConfig(request.projectId);
    const cwd = getWorktreeDir(request.projectId, request.worktreeId);
    const resolvedHooks = await resolveProjectHooks(
      {
        id: request.projectId,
        owner: config.owner,
        repoPath: config.repoPath ?? cwd,
        hooks: config.hooks,
      },
      cwd,
    );
    const actions = getResolvedHookActions(resolvedHooks, request.triggerName);
    return {
      workspaceId: request.projectId,
      hook:
        Array.isArray(actions) && actions.length > 0
          ? createProjectHookDescriptor(request.triggerName, actions)
          : null,
      cwd,
      repoStorageKey: getProjectRepoStorageKey(),
    };
  }

  validateId(request.workspaceId, 'workspaceId');
  validateId(request.worktreeId, 'worktreeId');
  if (request.target === 'workspace-root') {
    const cwd = getWorkspaceWorktreeRootRepoDir(
      request.workspaceId,
      request.worktreeId,
    );
    const resolvedHooks = await resolveWorkspaceRootHooks(request.workspaceId, {
      workspaceRootPath: cwd,
    });
    const actions = getResolvedHookActions(resolvedHooks, request.triggerName);
    return {
      workspaceId: request.workspaceId,
      hook:
        Array.isArray(actions) && actions.length > 0
          ? createWorkspaceRootHookDescriptor(request.triggerName, actions)
          : null,
      cwd,
      repoStorageKey: getWorkspaceRootRepoStorageKey(),
    };
  }

  validateId(request.repoId, 'repoId');
  const config = await readWorkspaceConfig(request.workspaceId);
  const repo = config.repos.find(
    (candidate) => candidate.id === request.repoId,
  );
  if (!repo) {
    throw new RemoteControlServiceError('not_found', 'Repo not found.');
  }
  const workspaceRootPath = getWorkspaceWorktreeRootRepoDir(
    request.workspaceId,
    request.worktreeId,
  );
  const cwd = getWorkspaceWorktreeRepoDir(
    request.workspaceId,
    request.worktreeId,
    request.repoId,
  );
  const resolvedHooks = await resolveWorkspaceRepoHooks(
    request.workspaceId,
    request.repoId,
    { workspaceRootPath, repoPath: cwd },
  );
  const actions = getResolvedHookActions(resolvedHooks, request.triggerName);
  return {
    workspaceId: request.workspaceId,
    hook:
      Array.isArray(actions) && actions.length > 0
        ? createWorkspaceRepoHookDescriptor(
            repo.id,
            repo.name,
            request.triggerName,
            actions,
          )
        : null,
    cwd,
    repoStorageKey: getWorkspaceRepoStorageKey(request.repoId),
  };
}

function resolvedHookRunOptions(args: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  cwd: string;
  timeoutSeconds: number | null;
  snapshotRef: Awaited<ReturnType<typeof readCurrentPrTrackingSnapshot>> & {
    snapshot: NonNullable<
      Awaited<ReturnType<typeof readCurrentPrTrackingSnapshot>>['snapshot']
    >;
  };
  portalCommandId?: string;
  onRunUpdate?: (run: RemoteControlHookRun) => void;
  getWindow?: RunHookOptions['getWindow'];
  onEnqueued?: RunHookOptions['onEnqueued'];
  onStarted?: RunHookOptions['onStarted'];
  onOutput?: RunHookOptions['onOutput'];
  onComplete?: RunHookOptions['onComplete'];
}): RunHookOptions {
  const emit = async (
    ref: HookRunLogRef,
    status: RemoteControlHookRun['status'],
    finishedAt?: string,
    activeActionIndex?: number,
  ): Promise<void> => {
    const onRunUpdate = args.onRunUpdate;
    if (!onRunUpdate) return;
    const { lines } = await readHookRunLogTail({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      runId: ref.runId,
      maxLines: 80,
    }).catch(() => ({ lines: [] }));
    const run = buildRemoteControlHookRun({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      hook: args.hook,
      runId: ref.runId,
      status,
      outputTail: trimUtf8Tail(lines.join('\n'), RUN_TAIL_MAX_BYTES),
      finishedAt,
      activeActionIndex,
    });
    onRunUpdate(run);
  };
  return {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    hook: args.hook,
    cwd: args.cwd,
    invocation: 'manual',
    pause: 'bypass',
    ...(args.portalCommandId !== undefined
      ? { occurrenceKey: `portal:${args.portalCommandId}` }
      : {}),
    timeoutSeconds: args.timeoutSeconds,
    currentSnapshot: args.snapshotRef.snapshot,
    currentSnapshotPath: args.snapshotRef.currentSnapshotPath,
    previousSnapshotPath: args.snapshotRef.previousSnapshotPath,
    getWindow: args.getWindow ?? ((): null => null),
    onEnqueued: args.onEnqueued,
    onStarted: (hook, ref) => {
      args.onStarted?.(hook, ref);
      trackDetachedWork(() => emit(ref, 'running'));
    },
    onOutput: (hook, lines, ref, activeActionIndex) => {
      args.onOutput?.(hook, lines, ref, activeActionIndex);
      if (ref)
        trackDetachedWork(() =>
          emit(ref, 'running', undefined, activeActionIndex),
        );
    },
    onComplete: (hook, result, ref) => {
      args.onComplete?.(hook, result, ref);
      trackDetachedWork(() =>
        emit(
          ref,
          result.timedOut
            ? 'timed_out'
            : result.stopped
              ? 'cancelled'
              : result.success
                ? 'success'
                : 'failed',
          new Date().toISOString(),
        ),
      );
    },
  };
}

export async function cancelHook(
  request: HookStopRequest,
): Promise<HookRunResponse | null> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  return stopRunningHook({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    hookKey: request.hookKey,
  });
}

export async function readLatestHookRunTail(request: {
  projectId: string;
  worktreeId: string;
  hookKey: string;
  maxLines?: number;
}): Promise<{ lines: string[]; run?: RemoteControlHookRun }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const runs = await listHookRuns({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  });
  const latest = runs
    .filter((run) => run.hookId === request.hookKey)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
  if (!latest?.runId) return { lines: [] };
  return readHookRunTail({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    runId: latest.runId,
    maxLines: request.maxLines,
  });
}

export async function readHookRunTail(request: {
  projectId: string;
  worktreeId: string;
  runId: string;
  maxLines?: number;
}): Promise<{ lines: string[]; run?: RemoteControlHookRun }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.runId, 'runId');
  const { meta, lines } = await readHookRunLogTail({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    runId: request.runId,
    maxLines: request.maxLines ?? 500,
  });
  if (!meta) return { lines };
  return {
    lines,
    run: buildRemoteControlHookRun({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      hook: meta.hook,
      runId: meta.runId,
      status: meta.timedOut ? 'timed_out' : meta.status,
      outputTail: trimUtf8Tail(lines.join('\n'), RUN_TAIL_MAX_BYTES),
      finishedAt: meta.completedAt,
      startedAt: meta.startedAt,
    }),
  };
}

export async function loadWorktreeHookRuns(request: {
  projectId: string;
  worktreeId: string;
  maxLines?: number;
}): Promise<HookRunSnapshot[]> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const runs = await listLatestHookRunLogTails({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    maxLines: request.maxLines ?? 1000,
  });

  const latestByHookKey = new Map<string, HookRunSnapshot>();
  for (const { meta, lines } of runs) {
    const snapshot: HookRunSnapshot = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      hook: meta.hook,
      status: meta.status,
      outputLines: lines,
      exitCode: meta.exitCode,
      timedOut: meta.timedOut,
      durationMs: meta.durationMs,
      startedAt: meta.startedAt,
      activeActionIndex: meta.activeActionIndex,
      ...(meta.completedAt ? { completedAt: meta.completedAt } : {}),
    };
    const existing = latestByHookKey.get(meta.hook.hookKey);
    if (!existing || snapshot.startedAt > existing.startedAt) {
      latestByHookKey.set(meta.hook.hookKey, snapshot);
    }
  }

  return Array.from(latestByHookKey.values()).sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}

function buildRemoteControlHookRun(input: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  runId: string;
  status: RemoteControlHookRun['status'];
  outputTail: string;
  startedAt?: string;
  finishedAt?: string;
  activeActionIndex?: number;
}): RemoteControlHookRun {
  return {
    workspaceLocalId: input.projectId,
    worktreeLocalId: input.worktreeId,
    localId: input.runId,
    runId: input.runId,
    hookId: input.hook.hookKey,
    // Transport plan §1.3: hookKey is canonical; hookId is a legacy alias
    // that MUST equal hookKey while the rollout is in flight.
    hookKey: input.hook.hookKey,
    name: input.hook.label,
    triggerName: input.hook.triggerName,
    target: input.hook.target,
    repoId: input.hook.repoId,
    repoName: input.hook.repoName,
    status: input.status,
    startedAt: input.startedAt ?? new Date().toISOString(),
    finishedAt: input.finishedAt,
    outputTail: input.outputTail,
    activeActionIndex: input.activeActionIndex,
  };
}

function trimUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
}

// The Portal hook list reads each target through core.initiatedWork.source.list;
// an unreadable target lists no hooks, as before.
async function listTargetHookSources(
  target: CoreHookSourceTarget,
): Promise<ResolvedHookMap> {
  try {
    return await listHookSourcesThroughCore(
      getDesktopCanopyRuntime(),
      HOOK_SOURCE_HOST_CALLER,
      target,
    );
  } catch {
    return {};
  }
}

export async function listHooks(input?: {
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
}): Promise<RemoteControlHookSummary[]> {
  const workspaceLocalId =
    input?.workspaceLocalId ?? input?.workspaceId ?? input?.projectId;
  const worktreeLocalId = input?.worktreeLocalId ?? input?.worktreeId;
  if (!workspaceLocalId || !worktreeLocalId) return [];
  const { items } = await readAllSidebarItems();
  const item = items.find((candidate) => candidate.id === workspaceLocalId);
  if (!item) return [];
  if (item.type === 'cowork') return [];
  const worktree = item.worktrees.find(
    (candidate) => candidate.id === worktreeLocalId,
  );
  const pausedHookKeys = new Set(worktree?.pausedHookKeys ?? []);
  if (item.type === 'single-repo') {
    const hooks = await listTargetHookSources({
      kind: 'project',
      workspaceId: workspaceLocalId,
      worktreeId: worktreeLocalId,
    });
    const rows = Object.entries(hooks).flatMap(([triggerName, field]) => {
      const actions = field.actions;
      if (!actions || actions.length === 0) return [];
      const descriptor = createProjectHookDescriptor(triggerName, actions);
      return [
        {
          workspaceLocalId,
          worktreeLocalId,
          hookId: descriptor.hookKey,
          // Transport plan §1.3 canonical fields.
          hookKey: descriptor.hookKey,
          name: descriptor.label,
          triggerName,
          target: descriptor.target,
          repoId: descriptor.repoId,
          repoName: descriptor.repoName,
          source: 'project',
          paused: pausedHookKeys.has(descriptor.hookKey),
        },
      ];
    });
    return settleAll(
      rows.map(async (row) => ({
        ...row,
        ...(await remoteControlHookRunAvailability({
          projectId: workspaceLocalId,
          worktreeId: worktreeLocalId,
          target: row.target,
          repoId: row.repoId,
        })),
      })),
    );
  }
  const rootHooks = await listTargetHookSources({
    kind: 'workspace-root',
    workspaceId: workspaceLocalId,
    worktreeId: worktreeLocalId,
  });
  const rootRows = Object.entries(rootHooks).flatMap(([triggerName, field]) => {
    const actions = field.actions;
    if (!actions || actions.length === 0) return [];
    const descriptor = createWorkspaceRootHookDescriptor(triggerName, actions);
    return [
      {
        workspaceLocalId,
        worktreeLocalId,
        hookId: descriptor.hookKey,
        // Transport plan §1.3 canonical fields.
        hookKey: descriptor.hookKey,
        name: descriptor.label,
        triggerName,
        target: descriptor.target,
        repoId: descriptor.repoId,
        repoName: descriptor.repoName,
        source: 'workspace-root',
        paused: pausedHookKeys.has(descriptor.hookKey),
      },
    ];
  });
  const repoRows = await settleAll(
    item.repos.map(async (repo) => {
      const hooks = await listTargetHookSources({
        kind: 'workspace-repo',
        workspaceId: workspaceLocalId,
        repoId: repo.id,
        worktreeId: worktreeLocalId,
      });
      return Object.entries(hooks).flatMap(([triggerName, field]) => {
        const actions = field.actions;
        if (!actions || actions.length === 0) return [];
        const descriptor = createWorkspaceRepoHookDescriptor(
          repo.id,
          repo.name,
          triggerName,
          actions,
        );
        return [
          {
            workspaceLocalId,
            worktreeLocalId,
            hookId: descriptor.hookKey,
            // Transport plan §1.3 canonical fields.
            hookKey: descriptor.hookKey,
            name: descriptor.label,
            triggerName,
            target: descriptor.target,
            repoId: descriptor.repoId,
            repoName: descriptor.repoName,
            source: repo.name,
            paused: pausedHookKeys.has(descriptor.hookKey),
          },
        ];
      });
    }),
  );
  const rows = [...rootRows, ...repoRows.flat()];
  return settleAll(
    rows.map(async (row) => ({
      ...row,
      ...(await remoteControlHookRunAvailability({
        projectId: workspaceLocalId,
        worktreeId: worktreeLocalId,
        target: row.target,
        repoId: row.repoId,
      })),
    })),
  );
}

export async function listHookRuns(input?: {
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
}): Promise<RemoteControlHookRun[]> {
  const workspaceLocalId =
    input?.workspaceLocalId ?? input?.workspaceId ?? input?.projectId;
  const worktreeLocalId = input?.worktreeLocalId ?? input?.worktreeId;
  if (!workspaceLocalId || !worktreeLocalId) return [];
  const runs = await listHookRunLogTails({
    projectId: workspaceLocalId,
    worktreeId: worktreeLocalId,
    maxLines: 80,
  });
  return runs.map(
    ({ meta, lines }): RemoteControlHookRun => ({
      workspaceLocalId,
      worktreeLocalId,
      localId: meta.runId,
      runId: meta.runId,
      hookId: meta.hook.hookKey,
      // Transport plan §1.3 canonical fields.
      hookKey: meta.hook.hookKey,
      name: meta.hook.label,
      triggerName: meta.hook.triggerName,
      target: meta.hook.target,
      repoId: meta.hook.repoId,
      repoName: meta.hook.repoName,
      status: meta.timedOut ? 'timed_out' : meta.status,
      startedAt: meta.startedAt,
      finishedAt: meta.completedAt,
      outputTail: lines.join('\n'),
    }),
  );
}

/** `core.initiatedWork.source.get` for one hook trigger of a target. */
export async function getHookSourceInfo(
  request: HookSourceInfoRequest,
  caller: CanopyCallerDescriptor = HOOK_SOURCE_HOST_CALLER,
): Promise<HookSourceInfoResponse> {
  return getHookSourceInfoThroughCore(
    getDesktopCanopyRuntime(),
    caller,
    request,
  );
}

/**
 * `project:save-hooks`, `workspace:save-hooks` and
 * `workspace:save-repo-hooks`: compatibility adapters over the W5
 * `core.workspace.hooks.update` boundary (CAN-3816). The IPC handlers pass
 * its registered operation's projection (W7b-1b).
 */
export async function saveProjectHooksFromService(
  request: SaveProjectHooksRequest,
  update: typeof updateWorkspaceHooks = updateWorkspaceHooks,
): Promise<void> {
  validateId(request.projectId, 'projectId');
  await update({
    workspaceId: request.projectId,
    change: { kind: 'replace', hooks: request.hooks },
    source: 'desktop',
  });
}

export async function saveWorkspaceHooksFromService(
  request: SaveWorkspaceHooksRequest,
  update: typeof updateWorkspaceHooks = updateWorkspaceHooks,
): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  await update({
    workspaceId: request.workspaceId,
    change: { kind: 'replace', hooks: request.hooks },
    source: 'desktop',
  });
}

export async function saveWorkspaceRepoHooksFromService(
  request: SaveWorkspaceRepoHooksRequest,
  update: typeof updateWorkspaceHooks = updateWorkspaceHooks,
): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  try {
    await update({
      workspaceId: request.workspaceId,
      change: { kind: 'repositories', repos: request.repos },
      source: 'desktop',
    });
  } catch (error) {
    if (
      error instanceof ScriptHookSettingsRefusedError &&
      error.reason === 'not-found'
    ) {
      throw new RemoteControlServiceError('not_found', error.message);
    }
    throw error;
  }
}

export function hookToRemoteControlEntity(
  hook: RemoteControlHookSummary,
): RemoteControlEntityEnvelope {
  return {
    entityType: 'hook_descriptor',
    localId: hook.hookId,
    parentLocalId: worktreeScopedParentLocalId(
      hook.workspaceLocalId,
      hook.worktreeLocalId,
    ),
    payload: hook,
  };
}
