import { publishForeignScriptActivity } from './foreign-activity-sources';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
  PortalEntityEnvelope,
  PortalScriptRun,
  PortalScriptSummary,
  ScriptRunSnapshot,
  ScriptDescriptor,
  ScriptCompleteEvent,
  ScriptOutputEvent,
  ScriptRunRequest,
  ScriptRunResponse,
  ScriptStartedEvent,
  ScriptSourceInfoRequest,
  ScriptSourceInfoResponse,
  ScriptStopRequest,
} from '@canopy/desktop-shared/types';
import {
  type CommandShellDefinition,
  normalizeScriptName,
  resolveEffectiveScriptInteractive,
  resolveEffectiveScriptTimeoutSeconds,
  type ScriptDefinition,
} from '@canopy/desktop-shared/scripts';
import { worktreeScopedParentLocalId } from '@canopy/protocol/portal';

/**
 * Coarse-grained lifecycle bucket the named script belongs to. Mirrors
 * `PortalScriptSummary.lifecycle` — one of `before | setup | after |
 * teardown | null`. Ad-hoc / launch scripts return `null` because they do
 * not participate in setup/teardown grouping.
 */
function classifyScriptLifecycle(
  scriptName: string,
): 'before' | 'setup' | 'after' | 'teardown' | null {
  if (scriptName === 'setup') return 'setup';
  if (
    scriptName === 'teardown' ||
    scriptName === 'before-teardown' ||
    scriptName === 'after-teardown'
  ) {
    return 'teardown';
  }
  if (scriptName.startsWith('before-')) return 'before';
  if (scriptName.startsWith('after-')) return 'after';
  return null;
}
import { readAllSidebarItems } from '../lib/sidebar-items';
import {
  getResolvedScriptDefinition,
  resolveProjectScripts,
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
  type ResolvedScriptMap,
} from '../lib/script-resolver';
import {
  getWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
  getSharedContainerRunRepoDir,
} from '../lib/paths';
import {
  type StoppedTrackedShellScript,
  isTrackedShellScriptRunning,
  listTrackedShellScripts,
  listTrackedShellScriptsForWorktree,
  drainTrackedShellScriptRunsForWorktree,
} from '../lib/script-runner';
import { readPreferencesFile } from '../lib/preferences-store';
import { validateId } from '../lib/validation';
import { cancelWorkspaceTargetRuntimePreparation } from '../lib/workspace-target-exclusion';
import { assertNotSplitLocked } from './split-lock-service';
import { PortalServiceError } from './portal-service-error';
import { readSingleRepoProject } from '../lib/script-definition-host';
import { readScriptSourceInfo } from '../lib/script-source-info';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  CORE_SCRIPT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerScriptContext,
  type WorkerScriptExecution,
} from '@canopy/protocol/canopy-core';
import {
  cancelScriptRuns,
  listScriptRuns as listWorkerScriptRuns,
  readScriptRun,
  runDesktopScript,
} from '../lib/script-execution';
import {
  createProjectScriptDescriptor,
  createScriptCompleteEvent,
  createScriptOutputEvent,
  createScriptStartedEvent,
  createWorkspaceRepoScriptDescriptor,
  createWorkspaceRootScriptDescriptor,
  type ScriptInvocation,
} from '../lib/script-events';
import { readWorkspaceRepoOrThrow } from '../lib/workspace-script-config';
import { emitPortalFeatureUpsert } from './portal-feature-event-service';
import {
  acquireSharedContainerRunLifecycle,
  isSharedContainerAccepted,
  isSharedContainerRunAllowed,
} from '../shared-containers/acceptance-store';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import {
  ensureSharedContainerRunCopy,
  getSharedContainerRunCopyState,
} from '../shared-containers/run/run-copy';
import { getFeatureFlagService } from '../feature-flags';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  settleAll,
  settleEach,
} from '@canopy/desktop-shared/node/lib/detached-work';

// Script actions read source info as the trusted main process.
const SCRIPT_SOURCE_INFO_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-script-actions',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [CORE_SCRIPT_GRANTS.read],
};

const NOOP_SUCCESS: ScriptRunResponse = {
  success: true,
  exitCode: 0,
  output: '',
  timedOut: false,
  durationMs: 0,
};
const RUN_TAIL_MAX_BYTES = 8 * 1024;

interface ScriptExecution {
  projectId: string;
  worktreeId: string;
  script: ScriptDescriptor;
  invocation: ScriptInvocation;
  /** The checkout the worker projects `context` onto, for host prechecks. */
  cwd: string;
  context: WorkerScriptContext;
  command: string;
  shell?: CommandShellDefinition;
  timeoutSeconds: number | null;
}

export interface RunScriptOptions {
  portalCommandId?: string;
  /**
   * The script the caller checked before starting it. When the resolved
   * script no longer matches (a different command, or now interactive), the
   * run is refused instead of running a command the caller never saw.
   */
  expectedScript?: {
    command: string;
    interactive: boolean;
    shell?: CommandShellDefinition;
  };
  onExecutionStarted?: () => void;
  onRendererStarted?: (event: ScriptStartedEvent) => void;
  onRendererOutput?: (event: ScriptOutputEvent) => void;
  onRendererComplete?: (event: ScriptCompleteEvent) => void;
  onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
  onRunUpdate?: (run: PortalScriptRun) => void;
}

export interface StopScriptOptions {
  portalCommandId?: string;
  onRendererComplete?: (event: ScriptCompleteEvent) => void;
}

function emitScriptRun(run: PortalScriptRun, commandId?: string): void {
  publishForeignScriptActivity(run);
  emitPortalFeatureUpsert({
    type: 'portal.script.event',
    commandId,
    entity: {
      entityType: 'script_run',
      localId: run.localId,
      parentLocalId: worktreeScopedParentLocalId(
        run.workspaceLocalId,
        run.worktreeLocalId,
      ),
      payload: run,
    },
  });
}

function notifyScriptRunUpdate(
  run: PortalScriptRun,
  options: RunScriptOptions,
): void {
  options.onRunUpdate?.(run);
  emitScriptRun(run, options.portalCommandId);
}

async function resolveScriptExecution(
  request: ScriptRunRequest,
  defaultTimeoutSeconds: number,
): Promise<ScriptExecution | null> {
  const scriptName = normalizeScriptName(request.scriptName);
  if (!scriptName) {
    throw new PortalServiceError('invalid_payload', 'scriptName is required.');
  }

  if (request.target === 'shared-container') {
    validateId(request.containerId, 'containerId');
    if (
      process.platform !== 'darwin' ||
      !getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
      ) ||
      !(await isSharedContainerAccepted(request.containerId)) ||
      !(await isSharedContainerRunAllowed(request.containerId))
    ) {
      throw new PortalServiceError(
        'invalid_target',
        'Shared-container run is not allowed.',
      );
    }
    const reader = getSharedContainerReader();
    // Every refusal below rejects rather than resolving `null`. A `null`
    // execution is the "nothing to run, and that is fine" answer, which
    // `runScript` reports as a successful no-op — indistinguishable in the
    // renderer from a command that actually started. A recipient who asks for
    // a command the publisher did not publish has to see that refusal.
    const state = await reader.store.get(request.containerId);
    if (state?.status !== 'available' && state?.status !== 'pinned') {
      throw new PortalServiceError(
        'invalid_target',
        'Shared-container revision is not available.',
      );
    }
    const run = await reader.readRunConfig({
      containerId: request.containerId,
      revisionId: state.revisionId,
    });
    if (!run) {
      throw new PortalServiceError(
        'invalid_target',
        'This share did not publish run configuration.',
      );
    }
    const published = run.commands.find(
      (command) => command.name === scriptName,
    );
    if (!published) {
      throw new PortalServiceError(
        'invalid_target',
        'This share did not publish that command.',
      );
    }
    const runCopy = await getSharedContainerRunCopyState(request.containerId);
    if (
      runCopy.state === 'committed' &&
      runCopy.revisionId !== state.revisionId
    ) {
      throw new PortalServiceError(
        'invalid_target',
        'Update the shared-container run copy before running this command.',
      );
    }
    await ensureSharedContainerRunCopy(
      request.containerId,
      reader.store,
      state.revisionId,
    );
    const cwd = getSharedContainerRunRepoDir(
      request.containerId,
      published.repoId,
    );
    const cwdInfo = await lstat(cwd).catch(() => null);
    if (!cwdInfo || !cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()) {
      throw new PortalServiceError(
        'invalid_target',
        'The shared-container run-copy repository is unavailable.',
      );
    }
    // Published commands are interactive, so they run on a host terminal
    // (CAN-5082) with exactly the declared variables the recipient assigned,
    // which the shared context projection reads.
    const declared = new Set(run.requiredEnv);
    return {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: request.containerId,
      script: createProjectScriptDescriptor(
        scriptName,
        published.command,
        undefined,
        undefined,
        true,
      ),
      invocation: 'manual-run',
      cwd,
      context: {
        kind: 'shared-container',
        repoId: published.repoId,
        environmentKeys: Array.from(declared),
      },
      command: published.command,
      timeoutSeconds: defaultTimeoutSeconds,
    };
  }

  if (request.target === 'project') {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    const project = await readSingleRepoProject(request.projectId);
    const cwd = getWorktreeDir(request.projectId, request.worktreeId);
    const scripts = await resolveProjectScripts(project, cwd);
    const definition = getResolvedScriptDefinition(scripts, scriptName);
    if (!definition) return null;
    const command = definition.command;
    return {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      script: createProjectScriptDescriptor(
        scriptName,
        command,
        definition.devServerPattern,
        definition.shell,
        definition.interactive,
      ),
      invocation: 'manual-run',
      cwd,
      context: { kind: 'project' },
      command,
      shell: definition.shell,
      timeoutSeconds: resolveEffectiveScriptTimeoutSeconds({
        scriptName,
        configuredTimeoutSeconds: definition.timeoutSeconds,
        defaultTimeoutSeconds,
      }),
    };
  }

  validateId(request.workspaceId, 'workspaceId');
  validateId(request.worktreeId, 'worktreeId');
  if (request.target === 'workspace-root') {
    const cwd = getWorkspaceWorktreeRootRepoDir(
      request.workspaceId,
      request.worktreeId,
    );
    const scripts = await resolveWorkspaceRootScripts(request.workspaceId, {
      workspaceRootPath: cwd,
    });
    const definition = getResolvedScriptDefinition(scripts, scriptName);
    if (!definition) return null;
    const command = definition.command;
    return {
      projectId: request.workspaceId,
      worktreeId: request.worktreeId,
      script: createWorkspaceRootScriptDescriptor(
        scriptName,
        command,
        definition.devServerPattern,
        definition.shell,
        definition.interactive,
      ),
      invocation: 'manual-lifecycle',
      cwd,
      context: { kind: 'workspace-root' },
      command,
      shell: definition.shell,
      timeoutSeconds: resolveEffectiveScriptTimeoutSeconds({
        scriptName,
        configuredTimeoutSeconds: definition.timeoutSeconds,
        defaultTimeoutSeconds,
      }),
    };
  }

  validateId(request.repoId, 'repoId');
  const repo = await readWorkspaceRepoOrThrow({
    workspaceId: request.workspaceId,
    repoId: request.repoId,
    notFoundMessage: `Repo ${request.repoId} not found in project ${request.workspaceId}`,
  });
  const cwd = getWorkspaceWorktreeRepoDir(
    request.workspaceId,
    request.worktreeId,
    request.repoId,
  );
  const scripts = await resolveWorkspaceRepoScripts(
    request.workspaceId,
    request.repoId,
    {
      workspaceRootPath: getWorkspaceWorktreeRootRepoDir(
        request.workspaceId,
        request.worktreeId,
      ),
      repoPath: cwd,
    },
  );
  const definition = getResolvedScriptDefinition(scripts, scriptName);
  if (!definition) return null;
  const command = definition.command;

  return {
    projectId: request.workspaceId,
    worktreeId: request.worktreeId,
    script: createWorkspaceRepoScriptDescriptor(
      repo.id,
      repo.name,
      scriptName,
      command,
      definition.devServerPattern,
      definition.shell,
      definition.interactive,
    ),
    invocation: 'manual-run',
    cwd,
    context: { kind: 'workspace-repo', repoId: request.repoId },
    command,
    shell: definition.shell,
    timeoutSeconds: resolveEffectiveScriptTimeoutSeconds({
      scriptName,
      configuredTimeoutSeconds: definition.timeoutSeconds,
      defaultTimeoutSeconds,
    }),
  };
}

async function runScriptWithLifecycle(
  request: ScriptRunRequest,
  options: RunScriptOptions = {},
  releaseLifecycle?: () => void,
): Promise<ScriptRunResponse> {
  const scriptName = normalizeScriptName(request.scriptName);
  if (!scriptName) {
    throw new PortalServiceError('invalid_payload', 'scriptName is required.');
  }
  const scriptWorkspaceId =
    request.target === 'shared-container'
      ? SHARED_CONTAINER_VIEWER_PROJECT_ID
      : request.target === 'project'
        ? request.projectId
        : request.workspaceId;
  const scriptWorktreeId =
    request.target === 'shared-container'
      ? request.containerId
      : request.worktreeId;
  assertNotSplitLocked(scriptWorkspaceId, scriptWorktreeId, 'running a script');
  const prefs = await readPreferencesFile();
  const execution = await resolveScriptExecution(
    request,
    prefs.scriptTimeoutMinutes * 60,
  );
  const expected = options.expectedScript;
  if (
    expected &&
    (!execution ||
      execution.command !== expected.command ||
      // The same command text can behave differently under another shell.
      JSON.stringify(execution.shell ?? null) !==
        JSON.stringify(expected.shell ?? null) ||
      resolveEffectiveScriptInteractive({
        scriptName: execution.script.scriptName,
        configuredInteractive: execution.script.interactive,
      }) !== expected.interactive)
  )
    throw new PortalServiceError(
      'invalid_target',
      'The script changed after it was checked, so it was not run. Run it again to use the current command.',
    );
  if (!execution) return NOOP_SUCCESS;
  if (classifyScriptLifecycle(execution.script.scriptName) === 'teardown') {
    try {
      await lstat(execution.cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return NOOP_SUCCESS;
      }
      throw error;
    }
  }
  let outputTail = '';
  const runId = randomUUID();
  // The worker writes the run log; this names the run it starts.
  const ref = {
    projectId: execution.projectId,
    worktreeId: execution.worktreeId,
    script: execution.script,
    runId,
  };
  options.onRendererStarted?.(
    createScriptStartedEvent(
      execution.projectId,
      execution.worktreeId,
      execution.script,
      execution.invocation,
      runId,
    ),
  );
  notifyScriptRunUpdate(
    buildPortalScriptRun({
      execution,
      runId,
      status: 'running',
      outputTail,
    }),
    options,
  );
  let executionError: unknown;
  let response: ScriptRunResponse;
  try {
    // Archival makes teardown rows non-interactive while it waits, so a PTY
    // launched for teardown would be impossible to reach. Other interactive
    // scripts stay terminal-backed and intentionally have no hidden timeout.
    const interactive = resolveEffectiveScriptInteractive({
      scriptName: execution.script.scriptName,
      configuredInteractive: execution.script.interactive,
    });
    let markProcessStarted!: () => void;
    const processStarted = new Promise<void>((resolve) => {
      markProcessStarted = resolve;
    });
    const completion = runDesktopScript(
      {
        projectId: execution.projectId,
        worktreeId: execution.worktreeId,
        context: execution.context,
        script: execution.script,
        invocation: execution.invocation,
        command: execution.command,
        ...(execution.shell ? { shell: execution.shell } : {}),
        timeoutSeconds: interactive ? null : execution.timeoutSeconds,
        interactive,
        runId,
      },
      {
        observer: {
          onLines: (lines) => {
            options.onRendererOutput?.(
              createScriptOutputEvent(
                execution.projectId,
                execution.worktreeId,
                execution.script,
                execution.invocation,
                lines,
                runId,
              ),
            );
            const text = lines.join('\n');
            outputTail = trimUtf8Tail(
              `${outputTail}${outputTail && text ? '\n' : ''}${text}`,
              RUN_TAIL_MAX_BYTES,
            );
            options.onChunk?.({ stream: 'stdout', text });
            notifyScriptRunUpdate(
              buildPortalScriptRun({
                execution,
                runId: ref.runId,
                status: 'running',
                outputTail,
              }),
              options,
            );
          },
          // Execution starts once the process spawns; a launch failure
          // resolves the run without signalling a start.
          onProcessStarted: (): void => {
            markProcessStarted();
            options.onExecutionStarted?.();
          },
        },
      },
    ).then((outcome) => outcome.response);
    if (releaseLifecycle) {
      await Promise.race([
        processStarted,
        completion.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      releaseLifecycle();
    }
    response = await completion;
  } catch (error) {
    executionError = error;
    response = {
      success: false,
      exitCode: 1,
      output: '',
      timedOut: false,
      durationMs: 0,
    };
  }
  notifyScriptRunUpdate(
    buildPortalScriptRun({
      execution,
      runId: ref.runId,
      status: scriptRunStatus(response),
      outputTail,
      finishedAt: new Date().toISOString(),
    }),
    options,
  );
  options.onRendererComplete?.(
    createScriptCompleteEvent(
      execution.projectId,
      execution.worktreeId,
      execution.script,
      execution.invocation,
      response,
      runId,
    ),
  );
  if (executionError !== undefined) {
    throw executionError instanceof Error
      ? executionError
      : new Error('Script execution failed');
  }
  return response;
}

export async function runScript(
  request: ScriptRunRequest,
  options: RunScriptOptions = {},
): Promise<ScriptRunResponse> {
  if (request.target !== 'shared-container') {
    return runScriptWithLifecycle(request, options);
  }
  const release = await acquireSharedContainerRunLifecycle(request.containerId);
  try {
    return await runScriptWithLifecycle(request, options, release);
  } finally {
    release();
  }
}

/**
 * Stop every tracked running script for a worktree. Used by the Split PR start
 * handler to terminate the worktree's running scripts before acquiring the
 * lock. Best-effort: individual stop failures are swallowed so one stuck run
 * does not block termination of the rest.
 */
export async function stopWorktreeScripts(request: {
  projectId: string;
  worktreeId: string;
}): Promise<void> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const tracked = listTrackedShellScriptsForWorktree({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  });
  await settleAll(
    tracked.map((tracking) =>
      // Deliberately swallow per-script stop failures: this is a best-effort
      // bulk teardown (e.g. before a split workflow acquires its lock), and one
      // script failing to stop must not abort stopping the rest or reject the
      // whole call. This module has no logger/observability seam, so the
      // failure is intentionally dropped rather than surfaced. If a diagnostic
      // sink is added to this file later, log the error here.
      stopScript({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        scriptKey: tracking.scriptKey,
      }).catch(() => null),
    ),
  );
}

/**
 * Cancel a worktree's automatic setup so its removal can start at once: setup
 * steps that have not started never start, and running ones are ended, along
 * with any other run of the same scripts.
 * Stopping only the running script would let the sequence start its next
 * step (a repo setup or after-setup) under the removal. Main owns this
 * because the renderer tracks script runs only for the worktrees it has
 * loaded.
 */
export async function cancelWorktreeSetup(
  request: { projectId: string; worktreeId: string },
  options: StopScriptOptions = {},
): Promise<void> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  cancelWorkspaceTargetRuntimePreparation(
    request.projectId,
    request.worktreeId,
  );
  // The setup scripts are found among every concrete run: the per-key list
  // would hide a setup run behind a manual run of the same script.
  const setupScriptKeys = new Set(
    listTrackedShellScripts()
      .filter(
        ({ projectId, worktreeId, invocation }) =>
          projectId === request.projectId &&
          worktreeId === request.worktreeId &&
          (invocation === 'automatic-setup' ||
            invocation === 'workspace-lifecycle'),
      )
      .map(({ scriptKey }) => scriptKey),
  );
  // A manual run of a setup script is drained with it. The renderer shows a
  // script's runs as one row, so once the setup run completes that row the
  // removal can no longer see the manual run to stop it before teardown.
  // Draining rather than stopping leaves no setup child behind its shell.
  // Best effort, as in stopWorktreeScripts: the removal drains whatever is
  // still running.
  const stopped = await drainTrackedShellScriptRunsForWorktree(
    request,
    ({ scriptKey }) => setupScriptKeys.has(scriptKey),
  ).catch(() => []);
  await settleEach(
    stopped.map(async (run) => {
      if (!run.tracking) return;
      const stop = { ...request, scriptKey: run.tracking.scriptKey };
      reportStoppedScript(stop, run, options);
      await emitCancelledScriptRun(stop, options, run.tracking.runId);
    }),
  );
}

export async function cancelScript(
  request: ScriptStopRequest,
  options: StopScriptOptions = {},
): Promise<{ ok: true }> {
  await stopScript(request, options);
  return { ok: true };
}

export async function stopScript(
  request: ScriptStopRequest,
  options: StopScriptOptions = {},
): Promise<ScriptRunResponse | null> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const tracked = listTrackedShellScripts().filter(
    (tracking) =>
      tracking.projectId === request.projectId &&
      tracking.worktreeId === request.worktreeId &&
      tracking.scriptKey === request.scriptKey,
  );
  const { stopped } = await cancelScriptRuns({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    scriptKey: request.scriptKey,
  });
  const first = stopped[0];
  if (!first) {
    return null;
  }
  const response: ScriptRunResponse = {
    success: first.status === 'success',
    exitCode: first.exitCode,
    output: '',
    timedOut: first.timedOut,
    durationMs: first.durationMs,
  };
  reportStoppedScript(
    request,
    {
      response,
      tracking: tracked.find(({ runId }) => runId === first.executionId),
    },
    options,
  );
  await emitCancelledScriptRun(request, options);
  return response;
}

/** Tell the renderer a stopped run completed; the worker closed its log. */
function reportStoppedScript(
  request: ScriptStopRequest,
  stopped: StoppedTrackedShellScript,
  options: StopScriptOptions,
): void {
  const script = stopped.tracking?.logRef?.script ?? stopped.tracking?.script;
  if (script) {
    options.onRendererComplete?.(
      createScriptCompleteEvent(
        request.projectId,
        request.worktreeId,
        script,
        stopped.tracking?.invocation ?? 'manual-run',
        stopped.response,
        stopped.tracking?.runId,
      ),
    );
  }
}

/**
 * Tell the portal the script's latest run was cancelled. With `runId`, only
 * when that run is still the latest one: a newer run of the same script was
 * not the one stopped.
 */
async function emitCancelledScriptRun(
  request: ScriptStopRequest,
  options: StopScriptOptions,
  runId?: string,
): Promise<void> {
  const tail = await readScriptRunTail({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    scriptKey: request.scriptKey,
  }).catch(() => null);
  if (!tail?.run || (runId !== undefined && tail.run.runId !== runId)) return;
  emitScriptRun({ ...tail.run, status: 'cancelled' }, options.portalCommandId);
}

function resolveScriptRunLogStatus(args: {
  projectId: string;
  worktreeId: string;
  execution: WorkerScriptExecution;
}): {
  snapshotStatus: ScriptRunSnapshot['status'];
  portalStatus: PortalScriptRun['status'];
  completedAt?: string;
} {
  const { execution } = args;
  // A lost run (a restart interrupted it) shows as cancelled, as a stale
  // running run always has; `worker.script.*` reports it as lost.
  const isStaleRunning =
    execution.status === 'lost' ||
    (execution.status === 'running' &&
      !isTrackedShellScriptRunning({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        scriptKey: execution.script.scriptKey,
      }));
  const status =
    isStaleRunning || execution.status === 'lost'
      ? 'cancelled'
      : execution.status;
  return {
    snapshotStatus: status,
    portalStatus: execution.timedOut ? 'timed_out' : status,
    completedAt: execution.completedAt ?? undefined,
  };
}

export async function readScriptRunTail(request: {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
  maxLines?: number;
}): Promise<{ lines: string[]; run?: PortalScriptRun }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const { run } = await readScriptRun({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    scriptKey: request.scriptKey,
    tailLines: request.maxLines ?? 500,
  });
  if (!run) return { lines: [] };
  const { execution: meta, lines } = run;
  const { portalStatus, completedAt } = resolveScriptRunLogStatus({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    execution: meta,
  });
  const outputTail = trimUtf8Tail(lines.join('\n'), RUN_TAIL_MAX_BYTES);
  return {
    lines,
    run: {
      workspaceLocalId: request.projectId,
      worktreeLocalId: request.worktreeId,
      localId: meta.executionId,
      runId: meta.executionId,
      scriptId: meta.script.scriptKey,
      // Transport plan §1.2: scriptKey is canonical; scriptId is a legacy
      // alias that MUST equal scriptKey while the rollout is in flight.
      scriptKey: meta.script.scriptKey,
      scriptName: meta.script.scriptName,
      name: meta.script.label,
      target: meta.script.target,
      repoId: meta.script.repoId,
      repoName: meta.script.repoName,
      status: portalStatus,
      startedAt: meta.startedAt,
      finishedAt: completedAt,
      outputTail,
    },
  };
}

export async function readAndEmitScriptRunTail(
  request: {
    projectId: string;
    worktreeId: string;
    scriptKey: string;
    maxLines?: number;
  },
  options: { portalCommandId?: string } = {},
): Promise<{ lines: string[]; run?: PortalScriptRun }> {
  const result = await readScriptRunTail(request);
  if (result.run) {
    emitScriptRun(result.run, options.portalCommandId);
  }
  return result;
}

export async function loadWorktreeScriptRuns(request: {
  projectId: string;
  worktreeId: string;
  maxLines?: number;
}): Promise<ScriptRunSnapshot[]> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const { runs } = await listWorkerScriptRuns({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    tailLines: request.maxLines ?? 1000,
  });

  return runs
    .map(({ execution: meta, lines }): ScriptRunSnapshot => {
      const { snapshotStatus, completedAt } = resolveScriptRunLogStatus({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        execution: meta,
      });

      return {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        script: meta.script,
        invocation: meta.invocation,
        status: snapshotStatus,
        outputLines: lines,
        exitCode: meta.exitCode,
        timedOut: meta.timedOut,
        durationMs: meta.durationMs,
        startedAt: meta.startedAt,
        ...(completedAt ? { completedAt } : {}),
      };
    })
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function scriptRunStatus(
  response: ScriptRunResponse,
): PortalScriptRun['status'] {
  if (response.timedOut) return 'timed_out';
  if (!response.success && response.exitCode === null) return 'cancelled';
  return response.success ? 'success' : 'failed';
}

function buildPortalScriptRun(input: {
  execution: ScriptExecution;
  runId: string;
  status: PortalScriptRun['status'];
  outputTail: string;
  finishedAt?: string;
}): PortalScriptRun {
  return {
    workspaceLocalId: input.execution.projectId,
    worktreeLocalId: input.execution.worktreeId,
    localId: input.runId,
    runId: input.runId,
    scriptId: input.execution.script.scriptKey,
    // Transport plan §1.2: scriptKey is canonical; scriptId is a legacy
    // alias that MUST equal scriptKey while the rollout is in flight.
    scriptKey: input.execution.script.scriptKey,
    scriptName: input.execution.script.scriptName,
    name: input.execution.script.label,
    target: input.execution.script.target,
    repoId: input.execution.script.repoId,
    repoName: input.execution.script.repoName,
    status: input.status,
    startedAt: new Date().toISOString(),
    finishedAt: input.finishedAt,
    outputTail: input.outputTail,
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

/**
 * Source info for the script actions host, through
 * `core.script.definition.get` with the trusted main-process caller.
 */
export async function getScriptSourceInfo(
  request: ScriptSourceInfoRequest,
): Promise<ScriptSourceInfoResponse> {
  return readScriptSourceInfo(
    getActiveDesktopRuntime(),
    SCRIPT_SOURCE_INFO_CALLER,
    request,
  );
}

export async function listScripts(input?: {
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
}): Promise<PortalScriptSummary[]> {
  const workspaceLocalId =
    input?.workspaceLocalId ?? input?.workspaceId ?? input?.projectId;
  const worktreeLocalId = input?.worktreeLocalId ?? input?.worktreeId;
  if (!workspaceLocalId || !worktreeLocalId) return [];
  const { items } = await readAllSidebarItems();
  const item = items.find((candidate) => candidate.id === workspaceLocalId);
  if (!item) return [];
  if (item.type === 'cowork') return [];
  if (item.type === 'single-repo') {
    const cwd = getWorktreeDir(workspaceLocalId, worktreeLocalId);
    const scripts = await resolveProjectScripts(item, cwd).catch(() => ({}));
    return Object.entries(scripts).flatMap(([name, field]) => {
      const command = field.value;
      if (!command) return [];
      const descriptor = createProjectScriptDescriptor(name, command);
      return [
        {
          workspaceLocalId,
          worktreeLocalId,
          scriptId: descriptor.scriptKey,
          // Transport plan §1.2 canonical fields.
          scriptKey: descriptor.scriptKey,
          scriptName: descriptor.scriptName,
          name: descriptor.label,
          target: descriptor.target,
          repoId: descriptor.repoId,
          repoName: descriptor.repoName,
          command,
          source: 'project',
          lifecycle: classifyScriptLifecycle(descriptor.scriptName),
        },
      ];
    });
  }
  const rootPath = getWorkspaceWorktreeRootRepoDir(
    workspaceLocalId,
    worktreeLocalId,
  );
  const rootScripts = await resolveWorkspaceRootScripts(workspaceLocalId, {
    workspaceRootPath: rootPath,
  }).catch(() => ({}));
  const rootRows = Object.entries(rootScripts).flatMap(([name, field]) => {
    const command = field.value;
    if (!command) return [];
    const descriptor = createWorkspaceRootScriptDescriptor(name, command);
    return [
      {
        workspaceLocalId,
        worktreeLocalId,
        scriptId: descriptor.scriptKey,
        // Transport plan §1.2 canonical fields.
        scriptKey: descriptor.scriptKey,
        scriptName: descriptor.scriptName,
        name: descriptor.label,
        target: descriptor.target,
        repoId: descriptor.repoId,
        repoName: descriptor.repoName,
        command,
        source: 'workspace-root',
        lifecycle: classifyScriptLifecycle(descriptor.scriptName),
      },
    ];
  });
  const repoRows = await settleAll(
    item.repos.map(async (repo) => {
      const repoPath = getWorkspaceWorktreeRepoDir(
        workspaceLocalId,
        worktreeLocalId,
        repo.id,
      );
      const scripts = await resolveWorkspaceRepoScripts(
        workspaceLocalId,
        repo.id,
        {
          workspaceRootPath: rootPath,
          repoPath,
        },
      ).catch(() => ({}));
      return Object.entries(scripts).flatMap(([name, field]) => {
        const command = field.value;
        if (!command) return [];
        const descriptor = createWorkspaceRepoScriptDescriptor(
          repo.id,
          repo.name,
          name,
          command,
        );
        return [
          {
            workspaceLocalId,
            worktreeLocalId,
            scriptId: descriptor.scriptKey,
            // Transport plan §1.2 canonical fields.
            scriptKey: descriptor.scriptKey,
            scriptName: descriptor.scriptName,
            name: descriptor.label,
            target: descriptor.target,
            repoId: descriptor.repoId,
            repoName: descriptor.repoName,
            command,
            source: repo.name,
            lifecycle: classifyScriptLifecycle(descriptor.scriptName),
          },
        ];
      });
    }),
  );
  return [...rootRows, ...repoRows.flat()];
}

/**
 * A worktree script run request. Shared-container runs are excluded because
 * resolving one materializes a run copy, which enumeration must never do.
 */
export type WorktreeScriptRunRequest = Exclude<
  ScriptRunRequest,
  { target: 'shared-container' }
>;

/** A configured worktree script and the request that runs it. */
export interface WorktreeScriptEntry {
  /** Resolved descriptor, including the command; callers decide what to expose. */
  descriptor: ScriptDescriptor;
  request: WorktreeScriptRunRequest;
}

function toScriptEntries(
  scripts: ResolvedScriptMap,
  toEntry: (
    scriptName: string,
    definition: ScriptDefinition,
  ) => WorktreeScriptEntry,
): WorktreeScriptEntry[] {
  return Object.entries(scripts).flatMap(([scriptName, field]) =>
    field.definition?.command ? [toEntry(scriptName, field.definition)] : [],
  );
}

/**
 * Enumerate the scripts configured for a Code project worktree, resolved with
 * the same layers {@link runScript} uses, without running anything. Unlike
 * {@link listScripts}, each descriptor keeps runner metadata such as
 * `interactive`. Cowork and unknown projects have no scripts.
 */
export async function listWorktreeScriptEntries(target: {
  projectId: string;
  worktreeId: string;
}): Promise<WorktreeScriptEntry[]> {
  const { projectId, worktreeId } = target;
  const { items } = await readAllSidebarItems();
  const item = items.find((candidate) => candidate.id === projectId);
  if (!item || item.type === 'cowork') return [];
  if (item.type === 'single-repo') {
    const scripts = await resolveProjectScripts(
      item,
      getWorktreeDir(projectId, worktreeId),
    ).catch((): ResolvedScriptMap => ({}));
    return toScriptEntries(scripts, (scriptName, definition) => ({
      descriptor: createProjectScriptDescriptor(
        scriptName,
        definition.command,
        definition.devServerPattern,
        definition.shell,
        definition.interactive,
      ),
      request: { target: 'project', scriptName, projectId, worktreeId },
    }));
  }
  const workspaceRootPath = getWorkspaceWorktreeRootRepoDir(
    projectId,
    worktreeId,
  );
  const rootScripts = await resolveWorkspaceRootScripts(projectId, {
    workspaceRootPath,
  }).catch((): ResolvedScriptMap => ({}));
  const rootEntries = toScriptEntries(
    rootScripts,
    (scriptName, definition) => ({
      descriptor: createWorkspaceRootScriptDescriptor(
        scriptName,
        definition.command,
        definition.devServerPattern,
        definition.shell,
        definition.interactive,
      ),
      request: {
        target: 'workspace-root',
        scriptName,
        workspaceId: projectId,
        worktreeId,
      },
    }),
  );
  const repoEntries = await settleAll(
    item.repos.map(async (repo) => {
      const scripts = await resolveWorkspaceRepoScripts(projectId, repo.id, {
        workspaceRootPath,
        repoPath: getWorkspaceWorktreeRepoDir(projectId, worktreeId, repo.id),
      }).catch((): ResolvedScriptMap => ({}));
      return toScriptEntries(scripts, (scriptName, definition) => ({
        descriptor: createWorkspaceRepoScriptDescriptor(
          repo.id,
          repo.name,
          scriptName,
          definition.command,
          definition.devServerPattern,
          definition.shell,
          definition.interactive,
        ),
        request: {
          target: 'workspace-repo',
          scriptName,
          workspaceId: projectId,
          worktreeId,
          repoId: repo.id,
        },
      }));
    }),
  );
  return [...rootEntries, ...repoEntries.flat()];
}

export async function listScriptRuns(input?: {
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
}): Promise<PortalScriptRun[]> {
  const workspaceLocalId =
    input?.workspaceLocalId ?? input?.workspaceId ?? input?.projectId;
  const worktreeLocalId = input?.worktreeLocalId ?? input?.worktreeId;
  if (!workspaceLocalId || !worktreeLocalId) return [];
  const scripts = await listScripts(input);
  const runs = await settleAll(
    scripts.map(async (script) => {
      const { run } = await readScriptRun({
        projectId: workspaceLocalId,
        worktreeId: worktreeLocalId,
        scriptKey: script.scriptId,
        tailLines: 80,
      }).catch(() => ({ run: null }));
      if (!run) return null;
      const { execution: meta, lines } = run;
      const { portalStatus, completedAt } = resolveScriptRunLogStatus({
        projectId: workspaceLocalId,
        worktreeId: worktreeLocalId,
        execution: meta,
      });
      return {
        workspaceLocalId,
        worktreeLocalId,
        localId: meta.executionId,
        runId: meta.executionId,
        scriptId: script.scriptId,
        // Transport plan §1.2 canonical fields, mirrored from the descriptor
        // we already carry on the summary row.
        scriptKey: script.scriptKey,
        scriptName: script.scriptName,
        name: script.name,
        target: script.target,
        repoId: script.repoId,
        repoName: script.repoName,
        status: portalStatus,
        startedAt: meta.startedAt,
        finishedAt: completedAt,
        // Phase 7 cleanup: only the canonical `outputTail` is populated;
        // the deprecated `logTail` alias was removed from PortalScriptRun
        // along with this dual-population.
        outputTail: lines.join('\n'),
      } satisfies PortalScriptRun;
    }),
  );
  return runs.flatMap((run) => (run ? [run] : []));
}

export function scriptToPortalEntity(
  script: PortalScriptSummary,
): PortalEntityEnvelope {
  return {
    entityType: 'script_descriptor',
    localId: `${script.worktreeLocalId}:${script.scriptId}`,
    parentLocalId: worktreeScopedParentLocalId(
      script.workspaceLocalId,
      script.worktreeLocalId,
    ),
    payload: script,
  };
}
