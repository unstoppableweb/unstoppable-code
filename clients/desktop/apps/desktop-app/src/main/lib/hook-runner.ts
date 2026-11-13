import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getHookActionLogLabel,
  getHookTriggerDisplayName,
  interpolateHookPrompt,
  type ChatHookAction,
  type PipelineHookAction,
} from '@canopy/desktop-shared/hooks';
import { setBrandEnv } from '@canopy/execution-engine/brand/env';
import type { PersistedPrSnapshotFileV1 } from '@canopy/desktop-shared/types/github';
import { buildPrQueueHookVariables } from '@canopy/desktop-shared/lib/pr-merge-queue';
import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type HookDescriptor,
  type HookRunResponse,
  type HookStopRequest,
} from '@canopy/desktop-shared/types';
import { buildWorktreeDataEnv } from './worktree-data-env';
import {
  appendHookRunLogLines,
  completeHookRunLog,
  startHookRunLog,
  type HookRunLogRef,
} from './hook-log-store';
import { getHookInvocationDir } from './paths';
import { runShellScript } from './script-runner';
import type { PipelineTriggerSource } from '@canopy/execution-engine/node/pipelines/executor';
import type {
  HookFirePreparation,
  HookFireResult,
  HookPausePolicy,
  InitiatedWorkClientPresence,
  InitiatedWorkRequest,
  InitiatedWorkRunControl,
  LiveHookRun,
} from '@canopy/core-runtime/node/initiated-work';
import {
  initiatedWorkNoClientPolicy,
  type InitiatedWorkGate,
  type InitiatedWorkRunResult,
} from '@canopy/protocol/canopy-core';
import {
  getHookFiring,
  getHookInitiatedWork,
  hookIdentity,
  type HookIdentity,
} from './hook-initiated-work';
import { sendToWindow } from './window-send';

interface ActiveHookRun {
  projectId: string;
  worktreeId: string;
  hook: HookIdentity;
  running: boolean;
  waitForExit: Promise<HookRunResponse>;
}

export interface RunHookOptions {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  cwd: string;
  invocation: 'automatic' | 'manual';
  /**
   * Whether the worktree's pause applies. Automatic firings enforce it; a
   * manual run bypasses it explicitly.
   */
  pause: HookPausePolicy;
  timeoutSeconds?: number | null;
  currentSnapshot?: PersistedPrSnapshotFileV1;
  currentSnapshotPath?: string;
  previousSnapshotPath?: string;
  env?: NodeJS.ProcessEnv;
  /** The firing's stable identity; a repeat returns the recorded run. */
  occurrenceKey?: string;
  /**
   * The run's operation when its firing was already accepted with the state
   * that fired it (CAN-4145); the run starts under it instead of a new one.
   */
  acceptedOperationId?: string;
  /**
   * Whether a client is connected. A hook whose actions defer without a
   * client (a hook chat) waits for one; without this the run never waits.
   */
  clientPresence?: InitiatedWorkClientPresence;
  getWindow: () => BrowserWindow | null;
  onEnqueued?: () => void;
  onStarted?: (hook: HookDescriptor, ref: HookRunLogRef) => void;
  onOutput?: (
    hook: HookDescriptor,
    lines: string[],
    ref?: HookRunLogRef,
    activeActionIndex?: number,
  ) => void;
  onComplete?: (
    hook: HookDescriptor,
    result: HookRunResponse,
    ref: HookRunLogRef,
  ) => void;
}

const activeHookRuns = new Map<string, ActiveHookRun[]>();
const activeHookRunListeners = new Set<() => void>();

function notifyActiveHookRunsChanged(): void {
  activeHookRunListeners.forEach((listener): void => {
    // A throwing subscriber must not disturb hook execution or other
    // listeners; this registry is observational only.
    try {
      listener();
    } catch {
      // Ignore listener failures.
    }
  });
}

export function subscribeActiveHookRunsChanged(
  listener: () => void,
): () => void {
  activeHookRunListeners.add(listener);
  return (): void => {
    activeHookRunListeners.delete(listener);
  };
}

export function listActiveHookRunTargets(): Array<{
  projectId: string;
  worktreeId: string;
}> {
  return Array.from(activeHookRuns.values()).flatMap((runs) =>
    runs
      .filter((run) => run.running)
      .map((run) => ({
        projectId: run.projectId,
        worktreeId: run.worktreeId,
      })),
  );
}

function buildActiveKey(
  projectId: string,
  worktreeId: string,
  hookKey: string,
): string {
  return `${projectId}\0${worktreeId}\0${hookKey}`;
}

function buildCancelledHookRunResponse(message: string): HookRunResponse {
  return {
    success: false,
    stopped: true,
    exitCode: null,
    output: message,
    timedOut: false,
    durationMs: 0,
  };
}

function toHookRunResponse(result: HookRunResponse): HookRunResponse {
  return {
    ...result,
    stopped: result.stopped ?? (result.exitCode === null && !result.timedOut),
  };
}

async function emitHookOutput(args: {
  ref: Awaited<ReturnType<typeof startHookRunLog>>;
  hook: HookDescriptor;
  lines: string[];
  onOutput?: (
    hook: HookDescriptor,
    lines: string[],
    ref?: HookRunLogRef,
    activeActionIndex?: number,
  ) => void;
  activeActionIndex?: number;
}): Promise<void> {
  await appendHookRunLogLines({
    ref: args.ref,
    lines: args.lines,
    activeActionIndex: args.activeActionIndex,
  }).catch(() => {});
  args.onOutput?.(args.hook, args.lines, args.ref, args.activeActionIndex);
}

function buildChatIfCommandStopResponse(args: {
  result: HookRunResponse;
  durationMs: number;
}): HookRunResponse {
  const message =
    args.result.output.trim().length > 0
      ? args.result.output
      : 'Chat if-command exited with code 2 and intentionally stopped the hook.';

  return {
    success: false,
    stopped: true,
    exitCode: 2,
    output: message,
    timedOut: false,
    durationMs: args.durationMs,
  };
}

function buildChatIfCommandFailureResponse(args: {
  result: HookRunResponse;
  durationMs: number;
}): HookRunResponse {
  const fallbackMessage = args.result.timedOut
    ? 'Chat if-command timed out.'
    : args.result.stopped
      ? 'Chat if-command was cancelled before completion.'
      : args.result.exitCode === null
        ? 'Chat if-command failed without an exit code.'
        : `Chat if-command failed with exit code ${args.result.exitCode}.`;
  const message =
    args.result.output.trim().length > 0 ? args.result.output : fallbackMessage;

  return {
    ...args.result,
    output: message,
    durationMs: args.durationMs,
  };
}

async function runChatIfCommand(args: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  action: ChatHookAction;
  cwd: string;
  timeoutSeconds?: number | null;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  logRef: Awaited<ReturnType<typeof startHookRunLog>>;
  onOutput?: (
    hook: HookDescriptor,
    lines: string[],
    ref?: HookRunLogRef,
    activeActionIndex?: number,
  ) => void;
  activeActionIndex: number;
  control: InitiatedWorkRunControl;
}): Promise<HookRunResponse | null> {
  const ifCommand = args.action['if-command'];
  if (!ifCommand) {
    return null;
  }
  const recordGate = (
    decision: 'passed' | 'skipped' | 'failed' | 'cancelled',
    message?: string,
  ): void =>
    args.control.recordGate('commandGate', decision, {
      actionIndex: args.activeActionIndex,
      ...(message !== undefined ? { message } : {}),
    });

  await emitHookOutput({
    ref: args.logRef,
    hook: args.hook,
    lines: ['Running chat if-command gate.'],
    onOutput: args.onOutput,
    activeActionIndex: args.activeActionIndex,
  });

  const startedAt = Date.now();
  const gateResult = toHookRunResponse(
    await runShellScript({
      script: ifCommand,
      cwd: args.cwd,
      timeoutSeconds: args.timeoutSeconds,
      signal: args.signal,
      env: args.env,
      onChunk: (lines: string[]): void => {
        void emitHookOutput({
          ref: args.logRef,
          hook: args.hook,
          lines,
          onOutput: args.onOutput,
          activeActionIndex: args.activeActionIndex,
        }).catch(() => {});
      },
      tracking: {
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        scriptKey: args.hook.hookKey,
      },
    }),
  );

  const durationMs = Date.now() - startedAt;
  if (gateResult.success) {
    recordGate('passed');
    return null;
  }

  if (!gateResult.timedOut && gateResult.exitCode === 2) {
    const stoppedResult = buildChatIfCommandStopResponse({
      result: gateResult,
      durationMs,
    });
    recordGate('skipped', stoppedResult.output);
    if (stoppedResult.output !== gateResult.output) {
      await emitHookOutput({
        ref: args.logRef,
        hook: args.hook,
        lines: [stoppedResult.output],
        onOutput: args.onOutput,
        activeActionIndex: args.activeActionIndex,
      });
    }
    return stoppedResult;
  }

  const failedResult = buildChatIfCommandFailureResponse({
    result: gateResult,
    durationMs,
  });
  recordGate(args.signal.aborted ? 'cancelled' : 'failed', failedResult.output);
  if (failedResult.output !== gateResult.output) {
    await emitHookOutput({
      ref: args.logRef,
      hook: args.hook,
      lines: [failedResult.output],
      onOutput: args.onOutput,
      activeActionIndex: args.activeActionIndex,
    });
  }
  return failedResult;
}

async function runPipelineAction(args: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  action: PipelineHookAction;
  actionIndex: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  getWindow: () => BrowserWindow | null;
  logRef: Awaited<ReturnType<typeof startHookRunLog>>;
  onOutput?: (
    hook: HookDescriptor,
    lines: string[],
    ref?: HookRunLogRef,
    activeActionIndex?: number,
  ) => void;
  control: InitiatedWorkRunControl;
}): Promise<HookRunResponse> {
  const { launchHookPipeline } = await import('./hook-pipeline');
  const startedAt = Date.now();
  const triggerSource: PipelineTriggerSource = {
    kind: 'hook',
    hook_key: args.hook.hookKey,
    hook_label: args.hook.label,
    trigger_name: args.hook.triggerName,
    target: args.hook.target,
    action_index: args.actionIndex,
    triggered_at: new Date().toISOString(),
  };
  if (args.hook.repoId !== undefined) {
    triggerSource.repo_id = args.hook.repoId;
  }
  if (args.hook.repoName !== undefined) {
    triggerSource.repo_name = args.hook.repoName;
  }

  const launched = await launchHookPipeline({
    identity: {
      operationId: args.control.operationId,
      actionIndex: args.actionIndex,
    },
    action: args.action,
    cwd: args.cwd,
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    env: args.env,
    triggerSource,
    getWindow: args.getWindow,
  });
  if (launched.status === 'started')
    args.control.recordArtifact({
      kind: 'pipelineExecution',
      id: launched.executionId,
      actionIndex: args.actionIndex,
    });
  const line =
    launched.status === 'started'
      ? `Started workflow "${launched.pipelineName}".`
      : launched.status === 'ended'
        ? `Workflow "${launched.pipelineName}" was already handled by an earlier attempt.`
        : `Queued workflow "${launched.pipelineName}" — waiting for active workflow runs to finish.`;

  await emitHookOutput({
    ref: args.logRef,
    hook: args.hook,
    lines: [line],
    onOutput: args.onOutput,
    activeActionIndex: args.actionIndex,
  });

  return {
    success: true,
    stopped: false,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: Date.now() - startedAt,
  };
}

function buildHookEnv(
  projectId: string,
  worktreeId: string,
  hook: HookDescriptor,
  snapshot: PersistedPrSnapshotFileV1 | undefined,
  currentSnapshotPath: string | undefined,
  previousSnapshotPath: string | undefined,
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const snapshotEnv: NodeJS.ProcessEnv = { ...env };
  if (hook.target === 'workspace-repo' && hook.repoId) {
    setBrandEnv(snapshotEnv, 'WORKSPACE_CHILD_REPO_ID', hook.repoId);
  }
  if (snapshot && currentSnapshotPath) {
    if (previousSnapshotPath) {
      setBrandEnv(snapshotEnv, 'PR_PREV_FILE', previousSnapshotPath);
    }
    setBrandEnv(snapshotEnv, 'PR_CURRENT_FILE', currentSnapshotPath);
    setBrandEnv(snapshotEnv, 'PR_BRANCH', snapshot.branch.headRefName);
    setBrandEnv(snapshotEnv, 'PR_BASE_BRANCH', snapshot.branch.baseRefName);
    setBrandEnv(snapshotEnv, 'PR_REPO_NAME', snapshot.repository.name);
    setBrandEnv(snapshotEnv, 'PR_REPO_OWNER', snapshot.repository.owner);
    setBrandEnv(snapshotEnv, 'PR_NUMBER', String(snapshot.pr.number));
    setBrandEnv(snapshotEnv, 'PR_ID', String(snapshot.pr.number));
    setBrandEnv(snapshotEnv, 'PR_URL', snapshot.pr.htmlUrl);
    for (const [name, value] of Object.entries(
      buildPrQueueHookVariables(snapshot, hook.triggerName),
    )) {
      setBrandEnv(snapshotEnv, name, value);
    }
  }

  return buildWorktreeDataEnv(projectId, worktreeId, snapshotEnv, {
    runtime: 'canopy',
  });
}

async function prepareInvocationSnapshotFiles(args: {
  projectId: string;
  worktreeId: string;
  runId: string;
  currentSnapshot: PersistedPrSnapshotFileV1;
  currentSnapshotPath?: string;
  previousSnapshotPath?: string;
}): Promise<{
  currentSnapshotPath: string;
  previousSnapshotPath?: string;
}> {
  const invocationDir = getHookInvocationDir(
    args.projectId,
    args.worktreeId,
    args.runId,
  );
  const snapshotsDir = join(invocationDir, 'snapshots');
  await mkdir(snapshotsDir, { recursive: true });

  const copiedCurrentSnapshotPath = join(snapshotsDir, 'current.json');
  if (args.currentSnapshotPath) {
    try {
      await copyFile(args.currentSnapshotPath, copiedCurrentSnapshotPath);
    } catch {
      await writeFile(
        copiedCurrentSnapshotPath,
        JSON.stringify(args.currentSnapshot, null, 2),
        'utf8',
      );
    }
  } else {
    await writeFile(
      copiedCurrentSnapshotPath,
      JSON.stringify(args.currentSnapshot, null, 2),
      'utf8',
    );
  }

  let copiedPreviousSnapshotPath: string | undefined;
  if (args.previousSnapshotPath) {
    copiedPreviousSnapshotPath = join(snapshotsDir, 'previous.json');
    try {
      await copyFile(args.previousSnapshotPath, copiedPreviousSnapshotPath);
    } catch {
      copiedPreviousSnapshotPath = undefined;
    }
  }

  return {
    currentSnapshotPath: copiedCurrentSnapshotPath,
    previousSnapshotPath: copiedPreviousSnapshotPath,
  };
}

function toRunResult(response: HookRunResponse): InitiatedWorkRunResult {
  return {
    status: response.timedOut
      ? 'timedOut'
      : response.success
        ? 'succeeded'
        : response.stopped
          ? 'stopped'
          : 'failed',
    exitCode: response.exitCode,
    durationMs: Math.max(0, Math.round(response.durationMs)),
  };
}

/** Runs an accepted hook's actions in order; the engine owns its queue. */
async function executeHookActions(
  options: RunHookOptions,
  control: InitiatedWorkRunControl,
  registeredRun: ActiveHookRun,
): Promise<HookRunResponse> {
  const { signal } = control;
  registeredRun.running = true;
  notifyActiveHookRunsChanged();

  let hookLogRef: Awaited<ReturnType<typeof startHookRunLog>> | null = null;
  let stoppedBy: 'commandGate' | undefined;

  let finalResult: HookRunResponse = {
    success: true,
    stopped: false,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: 0,
  };

  try {
    const logRef = await startHookRunLog({
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      hook: options.hook,
      invocation: options.invocation,
      operationId: control.operationId,
    });
    hookLogRef = logRef;
    control.recordArtifact({ kind: 'runLog', id: logRef.runId });
    const copiedSnapshots = options.currentSnapshot
      ? await prepareInvocationSnapshotFiles({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          runId: logRef.runId,
          currentSnapshot: options.currentSnapshot,
          currentSnapshotPath: options.currentSnapshotPath,
          previousSnapshotPath: options.previousSnapshotPath,
        })
      : undefined;
    options.onStarted?.(options.hook, logRef);

    const totalActions = options.hook.actions.length;
    const env = buildHookEnv(
      options.projectId,
      options.worktreeId,
      options.hook,
      options.currentSnapshot,
      copiedSnapshots?.currentSnapshotPath,
      copiedSnapshots?.previousSnapshotPath,
      options.env,
    );

    if (signal.aborted) {
      finalResult = buildCancelledHookRunResponse('Hook run cancelled.');
      return finalResult;
    }

    for (let index = 0; index < totalActions; index++) {
      const action = options.hook.actions[index];
      const boundary = `$ [${index + 1}/${totalActions}] ${getHookActionLogLabel(action)}`;
      await emitHookOutput({
        ref: logRef,
        hook: options.hook,
        lines: [boundary],
        onOutput: options.onOutput,
        activeActionIndex: index,
      });

      let result: HookRunResponse;
      if (action.type === 'command') {
        result = toHookRunResponse(
          await runShellScript({
            script: action.command,
            cwd: options.cwd,
            shell: action.shell,
            timeoutSeconds:
              action.interactive === true ? null : options.timeoutSeconds,
            signal,
            env,
            interactive: action.interactive === true,
            terminalTitle: options.hook.label,
            focusOnSpawn: options.invocation === 'manual',
            onChunk: (lines: string[]): void => {
              void emitHookOutput({
                ref: logRef,
                hook: options.hook,
                lines,
                onOutput: options.onOutput,
                activeActionIndex: index,
              }).catch(() => {});
            },
            tracking: {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              scriptKey: options.hook.hookKey,
              kind: 'hook',
            },
          }),
        );
      } else if (action.type === 'chat') {
        result = await (async (): Promise<HookRunResponse> => {
          if (signal.aborted) {
            return buildCancelledHookRunResponse('Hook run cancelled.');
          }

          const ifCommandResult = await runChatIfCommand({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            hook: options.hook,
            action,
            cwd: options.cwd,
            timeoutSeconds: options.timeoutSeconds,
            signal,
            env,
            logRef,
            onOutput: options.onOutput,
            activeActionIndex: index,
            control,
          });
          if (ifCommandResult) {
            if (
              ifCommandResult.stopped &&
              ifCommandResult.exitCode === 2 &&
              !ifCommandResult.timedOut
            )
              stoppedBy = 'commandGate';
            return ifCommandResult;
          }

          const { launchHookChat } = await import('./hook-chat');
          const startedAt = Date.now();
          const launched = await launchHookChat({
            identity: { operationId: control.operationId, actionIndex: index },
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            action,
            prompt: action.promptReferences?.length
              ? action.prompt
              : interpolateHookPrompt(action.prompt, env),
            ...(action.promptReferences?.length
              ? {
                  interpolateText: (text: string): string =>
                    interpolateHookPrompt(text, env),
                }
              : {}),
            triggerName: options.hook.triggerName,
            getWindow: options.getWindow,
            ...(options.hook.target === 'workspace-repo' && options.hook.repoId
              ? { selectedRepoId: options.hook.repoId }
              : {}),
          });
          if (launched.status !== 'removed')
            control.recordArtifact({
              kind: 'chat',
              id: launched.chatId,
              actionIndex: index,
            });
          return {
            success: true,
            stopped: false,
            exitCode: 0,
            output: '',
            timedOut: false,
            durationMs: Date.now() - startedAt,
          };
        })();
      } else {
        if (signal.aborted) {
          result = buildCancelledHookRunResponse('Hook run cancelled.');
        } else {
          result = await runPipelineAction({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            hook: options.hook,
            action,
            actionIndex: index,
            cwd: options.cwd,
            env,
            getWindow: options.getWindow,
            logRef,
            onOutput: options.onOutput,
            control,
          });
        }
      }
      finalResult = result;
      if (!result.success) {
        break;
      }
    }
  } catch (error) {
    finalResult = {
      success: false,
      stopped: false,
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error),
      timedOut: false,
      durationMs: 0,
    };
    if (hookLogRef) {
      await appendHookRunLogLines({
        ref: hookLogRef,
        lines: [finalResult.output],
      }).catch(() => {});
    }
    options.onOutput?.(
      options.hook,
      [finalResult.output],
      hookLogRef ?? undefined,
    );
  } finally {
    if (hookLogRef) {
      await completeHookRunLog({
        ref: hookLogRef,
        response: finalResult,
        ...(stoppedBy && finalResult.stopped ? { stoppedBy } : {}),
      }).catch(() => {});
      options.onComplete?.(options.hook, finalResult, hookLogRef);
    }
  }

  return finalResult;
}

/** A repeated firing answers with the run its first firing recorded. */
async function recordedHookRunResponse(
  operationId: string,
): Promise<HookRunResponse> {
  const operation = await getHookInitiatedWork().waitForRun(operationId);
  const result = operation.result;
  return {
    success: operation.status === 'completed' && result?.status === 'succeeded',
    stopped: operation.status === 'cancelled' || result?.status === 'stopped',
    exitCode: result?.exitCode ?? null,
    output: '',
    timedOut: result?.status === 'timedOut',
    durationMs: result?.durationMs ?? 0,
  };
}

function toHookRunResponseFromFiring(
  firing: HookFireResult<HookRunResponse>,
): Promise<HookRunResponse> {
  switch (firing.disposition) {
    case 'unconfigured':
      return Promise.resolve(firing.value);
    case 'ran':
      return Promise.resolve(firing.value);
    case 'cancelled':
      return Promise.resolve(
        buildCancelledHookRunResponse('Hook run cancelled before start.'),
      );
    case 'refused':
      return Promise.reject(
        firing.cause instanceof Error
          ? firing.cause
          : new Error(firing.failure.message),
      );
    case 'skipped':
      return Promise.resolve({
        success: false,
        stopped: true,
        exitCode: null,
        output: firing.message,
        timedOut: false,
        durationMs: 0,
      });
    case 'duplicate':
      return recordedHookRunResponse(firing.operation.operationId);
    case 'held':
      return Promise.resolve(
        buildCancelledHookRunResponse(
          'Hook run kept queued until the app starts again.',
        ),
      );
  }
}

/** Tells the window a paused hook's firing was recorded as skipped. */
export function announceHookSkippedPaused(args: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  window: BrowserWindow | null;
}): void {
  sendToWindow(args.window, IPC_CHANNELS.hookSkippedPaused, {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    hook: args.hook,
    triggerDisplayName: getHookTriggerDisplayName(args.hook.triggerName),
  });
}

function hookNeedsClient(hook: HookDescriptor): boolean {
  return hook.actions.some(
    (action) => initiatedWorkNoClientPolicy('hook', action.type) === 'defer',
  );
}

/** What the engine runs for a prepared hook: its client policy and actions. */
function hookRunBody(
  options: RunHookOptions,
  registeredRun: ActiveHookRun | null,
): Pick<
  InitiatedWorkRequest<HookRunResponse>,
  'client' | 'onQueued' | 'execute'
> {
  return {
    ...(options.clientPresence && hookNeedsClient(options.hook)
      ? { client: options.clientPresence }
      : {}),
    onQueued: () => {
      options.onEnqueued?.();
    },
    execute: async (control) => {
      if (!registeredRun) throw new Error('This hook run is not registered.');
      const value = await executeHookActions(options, control, registeredRun);
      return { value, result: toRunResult(value) };
    },
  };
}

function hookPreparation(
  options: RunHookOptions,
  registeredRun: ActiveHookRun | null,
): HookFirePreparation<HookRunResponse> {
  return {
    kind: 'ready',
    actions: options.hook.actions,
    ...(options.currentSnapshot
      ? {
          pullRequest: {
            repository: options.currentSnapshot.repository.fullName,
            number: options.currentSnapshot.pr.number,
          },
        }
      : {}),
    ...hookRunBody(options, registeredRun),
  };
}

function registerHookRun(
  base: { projectId: string; worktreeId: string; hook: HookIdentity },
  execution: () => Promise<HookRunResponse>,
): { run: ActiveHookRun; unregister: () => void } {
  const activeKey = buildActiveKey(
    base.projectId,
    base.worktreeId,
    base.hook.hookKey,
  );
  const run: ActiveHookRun = {
    projectId: base.projectId,
    worktreeId: base.worktreeId,
    hook: hookIdentity(base.hook),
    running: false,
    get waitForExit(): Promise<HookRunResponse> {
      return execution();
    },
  };
  const registeredRuns = activeHookRuns.get(activeKey) ?? [];
  registeredRuns.push(run);
  activeHookRuns.set(activeKey, registeredRuns);
  return {
    run,
    unregister: (): void => {
      const runs = activeHookRuns.get(activeKey);
      if (runs) {
        const index = runs.indexOf(run);
        if (index >= 0) runs.splice(index, 1);
      }
      if (runs?.length === 0) activeHookRuns.delete(activeKey);
      if (run.running) notifyActiveHookRunsChanged();
    },
  };
}

/** What a firing names before its hook's configuration is read. */
export interface HookFiringRequest {
  projectId: string;
  worktreeId: string;
  hook: HookIdentity;
  invocation: 'automatic' | 'manual';
  pause: HookPausePolicy;
  occurrenceKey?: string;
  acceptedOperationId?: string;
  getWindow: () => BrowserWindow | null;
  /** The hook the window is told about when its pause skips the firing. */
  describedHook?: HookDescriptor;
}

/** A source's answer once a firing's configuration-free gates let it in. */
export type HookRunPreparation =
  | { kind: 'unconfigured'; response: HookRunResponse }
  | { kind: 'refused'; gate: InitiatedWorkGate; error: Error }
  | { kind: 'ready'; options: RunHookOptions };

/**
 * Fire a hook through the core hook source, which decides its pause, split
 * lock, deletion fence and owner gates. `prepare` reads the hook's
 * configuration once the gates that need none let it in. Hooks for one repo
 * target of a worktree run one at a time in the order they were fired. The
 * promise rejects with the host's error for a refused run.
 */
export function fireHook(
  request: HookFiringRequest,
  prepare: () => Promise<HookRunPreparation>,
): Promise<HookRunResponse> {
  let execution: Promise<HookRunResponse> = Promise.resolve(
    buildCancelledHookRunResponse('Hook run cancelled before start.'),
  );
  // Registered at once, so a stop reaches a firing whose gates are still
  // being decided; a stopped or refused firing unregisters when it settles.
  const registered = registerHookRun(request, () => execution);
  let firing: Promise<HookFireResult<HookRunResponse>>;
  try {
    firing = getHookFiring().fire<HookRunResponse>({
      workspaceId: request.projectId,
      worktreeId: request.worktreeId,
      hook: hookIdentity(request.hook),
      invocation: request.invocation,
      pause: request.pause,
      ...(request.occurrenceKey !== undefined
        ? { occurrenceKey: request.occurrenceKey }
        : {}),
      ...(request.acceptedOperationId !== undefined
        ? { acceptedOperationId: request.acceptedOperationId }
        : {}),
      prepare: async () => {
        const prepared = await prepare();
        if (prepared.kind === 'unconfigured')
          return { kind: 'unconfigured', value: prepared.response };
        if (prepared.kind === 'refused')
          return {
            kind: 'refused',
            gate: prepared.gate,
            failure: {
              kind: 'failed_precondition',
              message: prepared.error.message,
              retry: { kind: 'never' },
            },
            cause: prepared.error,
          };
        return hookPreparation(prepared.options, registered.run);
      },
    });
  } catch (error) {
    registered.unregister();
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  execution = firing
    .then((result) => {
      if (
        result.disposition === 'skipped' &&
        result.gate === 'pause' &&
        request.describedHook
      )
        announceHookSkippedPaused({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          hook: request.describedHook,
          window: request.getWindow(),
        });
      return toHookRunResponseFromFiring(result);
    })
    .finally(registered.unregister);
  return execution;
}

/** Fire a hook whose configuration the source already read. */
export function runHook(options: RunHookOptions): Promise<HookRunResponse> {
  return fireHook({ ...options, describedHook: options.hook }, () =>
    Promise.resolve({ kind: 'ready', options }),
  );
}

/**
 * The body of a hook run a restart interrupted before it started, rebuilt
 * from its current configuration (CAN-4145). The engine runs it under its
 * recorded operation, after the gates the core hook source decides again.
 */
export function resumedHookRunBody(
  options: RunHookOptions,
): Pick<
  InitiatedWorkRequest<HookRunResponse>,
  'client' | 'onQueued' | 'execute'
> {
  return {
    ...hookRunBody(options, null),
    // Registered only once it starts: a stop before then reaches it through
    // the engine, which ends it without running it.
    execute: async (control) => {
      let execution: Promise<HookRunResponse> = Promise.resolve(
        buildCancelledHookRunResponse('Hook run cancelled.'),
      );
      const registered = registerHookRun(options, () => execution);
      try {
        execution = executeHookActions(options, control, registered.run);
        const value = await execution;
        return { value, result: toRunResult(value) };
      } finally {
        registered.unregister();
      }
    },
  };
}

const HOOK_STOP_PRINCIPAL = 'desktop-core';

/** Cancel the selected runs through their operations and wait for them. */
async function cancelHookRuns(
  select: (run: LiveHookRun) => boolean,
  runs: readonly ActiveHookRun[],
  reason: string,
): Promise<void> {
  await getHookFiring().cancelWhere(select, {
    reason,
    requestedBy: HOOK_STOP_PRINCIPAL,
  });
  await Promise.all(runs.map((run) => run.waitForExit.catch(() => {})));
}

function registeredRunsWhere(
  select: (run: ActiveHookRun) => boolean,
): ActiveHookRun[] {
  return Array.from(activeHookRuns.values()).flatMap((runs) =>
    runs.filter(select),
  );
}

export async function stopRunningHook(
  request: HookStopRequest,
): Promise<HookRunResponse | null> {
  const activeKey = buildActiveKey(
    request.projectId,
    request.worktreeId,
    request.hookKey,
  );
  const runs = Array.from(activeHookRuns.get(activeKey) ?? []);
  // Runs a restart recovered are stopped through the engine even before
  // they start and register here.
  await cancelHookRuns(
    (run) =>
      run.scope.workspaceId === request.projectId &&
      run.scope.worktreeId === request.worktreeId &&
      run.hookKey === request.hookKey,
    runs,
    'Stopped from the hooks panel.',
  );
  if (runs.length === 0) return null;
  const results = await Promise.all(runs.map((run) => run.waitForExit));
  return results[results.length - 1] ?? null;
}

export async function stopHooksForRepoTarget(args: {
  projectId: string;
  worktreeId: string;
  repoId: string;
}): Promise<void> {
  const runs = registeredRunsWhere(
    (run) =>
      run.projectId === args.projectId &&
      run.worktreeId === args.worktreeId &&
      run.hook.repoId === args.repoId,
  );
  await cancelHookRuns(
    (run) =>
      run.scope.workspaceId === args.projectId &&
      run.scope.worktreeId === args.worktreeId &&
      run.scope.repoId === args.repoId,
    runs,
    'The repository was removed from this worktree.',
  );
}

export async function stopHooksForWorktree(args: {
  projectId: string;
  worktreeId: string;
}): Promise<void> {
  const runs = registeredRunsWhere(
    (run) =>
      run.projectId === args.projectId && run.worktreeId === args.worktreeId,
  );
  await cancelHookRuns(
    (run) =>
      run.scope.workspaceId === args.projectId &&
      run.scope.worktreeId === args.worktreeId,
    runs,
    'The worktree is closing.',
  );
}

export function stopAllRunningHooks(): void {
  const runs = registeredRunsWhere(() => true);
  if (runs.length === 0) return;
  void cancelHookRuns(() => true, runs, 'The app is shutting down.').catch(
    () => {},
  );
}

/**
 * At app shutdown, start no more hooks and stop the ones that started.
 * Accepted runs that have not started stay queued in the ledger and resume
 * after the restart (CAN-4145).
 */
export function holdHooksForShutdown(): void {
  try {
    getHookInitiatedWork().stopStarting();
  } catch {
    // No runtime is accepting work, so nothing can start.
  }
  const runs = registeredRunsWhere((run) => run.running);
  if (runs.length === 0) return;
  void cancelHookRuns(
    (run) => run.started,
    runs,
    'The app is shutting down.',
  ).catch(() => {});
}
