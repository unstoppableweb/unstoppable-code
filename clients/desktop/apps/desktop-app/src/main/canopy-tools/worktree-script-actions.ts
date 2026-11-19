import { resolveEffectiveScriptInteractive } from '@canopy/desktop-shared/scripts';
import {
  IPC_CHANNELS,
  type AppAdvisorActionError,
  type AppAdvisorActionResponse,
  type AppAdvisorJson,
  type ScriptDescriptor,
  type ScriptRunResponse,
} from '@canopy/desktop-shared/types';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  isTerminalOperationStatus,
  type WorkerScriptExecution,
} from '@canopy/protocol/canopy-core';
import { findScriptRun, readScriptRun } from '../lib/script-execution';
import { isTrackedShellScriptRunning } from '../lib/script-runner';
import { sendToWindow, type SendableBrowserWindow } from '../lib/window-send';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { getWorkspaceType } from '../lib/workspace-registry';
import { mapHumanStatus, resolveScriptKey } from '../mcp/script-output';
import { RemoteControlServiceError } from '../services/remote-control-service-error';
import {
  listWorktreeScriptEntries,
  runScript,
  type WorktreeScriptEntry,
} from '../services/scripts-service';
import { MAX_SCRIPT_WAIT_SECONDS } from './definitions';
import type { WorktreeChatCoreWrites } from './worktree-chat-core-writes';

/**
 * Typed worktree script actions. The project and worktree always come from
 * the trusted runtime scope, never from the action payload.
 */
export type WorktreeScriptAction =
  | { type: 'worktree.list_scripts' }
  | {
      type: 'worktree.run_script';
      scriptId: string;
      repo?: string;
      waitSeconds?: number;
    };

/** Trusted scope for script actions; `WorktreeActionRuntime` satisfies it. */
export interface WorktreeScriptActionRuntime {
  projectId: string;
  worktreeId: string;
  getWindow: () => SendableBrowserWindow | null;
  getSendableWindow?: () => SendableBrowserWindow | null;
  /** Ends a `waitSeconds` wait early. It never stops the script itself. */
  signal?: AbortSignal;
  /**
   * Approves the resolved script command before it runs. A managed delegate
   * supplies this so a run is approved as the command it executes, under the
   * parent's command policy, not only as the DispatchAction call.
   */
  authorizeScriptCommand?: (command: string) => Promise<boolean>;
  /** A chat's tool call, which names the run it starts (CAN-5830). */
  coreWrites?: Pick<WorktreeChatCoreWrites, 'scriptRunId'>;
}

const OUTPUT_TAIL_MAX_LINES = 100;
const OUTPUT_TAIL_MAX_CHARS = 8_000;
const MISSING_SCRIPT_KEY_LIMIT = 25;
const SCRIPTS_SECTION_HINT = 'Ask the user to run it from the Scripts section.';

/**
 * Agent-started runs that have not settled, keyed by worktree and script. The
 * script runner registers a process only after resolution and log setup, so
 * this closes the window in which two concurrent calls could both start the
 * same script.
 */
const activeAgentRuns = new Set<string>();

interface ScriptTarget {
  projectId: string;
  worktreeId: string;
}

type RunOutcome =
  | { kind: 'finished'; response: ScriptRunResponse }
  | { kind: 'failed'; cause: unknown };

interface OutputTail {
  push(lines: readonly string[]): void;
  snapshot(): { lines: string[]; truncated: boolean };
}

function success(result: AppAdvisorJson): AppAdvisorActionResponse {
  return { requestId: '', ok: true, result };
}

function failure(
  code: AppAdvisorActionError['code'],
  message: string,
  retryable = false,
): AppAdvisorActionResponse {
  return {
    requestId: '',
    ok: false,
    error: { code, message, ...(retryable ? { retryable } : {}) },
  };
}

async function resolveScriptTarget(
  runtime: WorktreeScriptActionRuntime,
): Promise<{ target: ScriptTarget } | { response: AppAdvisorActionResponse }> {
  const { projectId, worktreeId } = runtime;
  const workspaceType = getWorkspaceType(projectId);
  if (workspaceType === 'cowork') {
    return {
      response: failure(
        'invalid_target',
        `Project ${projectId} is a Cowork project. Scripts run only in Code project worktrees.`,
      ),
    };
  }
  if (workspaceType !== 'single-repo' && workspaceType !== 'multi-repo') {
    return {
      response: failure(
        'invalid_target',
        `Project ${projectId} is not a Code project. Scripts run only in Code project worktrees.`,
      ),
    };
  }
  const worktrees = await readWorkspaceWorktrees(projectId);
  if (!worktrees.some((worktree) => worktree.id === worktreeId)) {
    return {
      response: failure(
        'not_found',
        `Worktree ${worktreeId} not found in project ${projectId}`,
      ),
    };
  }
  return { target: { projectId, worktreeId } };
}

function runKey(target: ScriptTarget, scriptKey: string): string {
  return `${target.projectId}\u0000${target.worktreeId}\u0000${scriptKey}`;
}

function isScriptActive(target: ScriptTarget, scriptKey: string): boolean {
  return (
    activeAgentRuns.has(runKey(target, scriptKey)) ||
    isTrackedShellScriptRunning({ ...target, scriptKey })
  );
}

function isTeardownScript(script: ScriptDescriptor): boolean {
  return (
    script.lifecycle === 'teardown' ||
    script.lifecycle === 'before-teardown' ||
    script.lifecycle === 'after-teardown'
  );
}

/** Whether the runner backs this script with a terminal PTY. */
function runsInTerminal(script: ScriptDescriptor): boolean {
  return resolveEffectiveScriptInteractive({
    scriptName: script.scriptName,
    configuredInteractive: script.interactive === true,
  });
}

/**
 * Why an agent may not run a script. Teardown tears down the environment a
 * worktree's archive or delete flow expects to own, and an interactive
 * script's terminal can wait for input an agent cannot type.
 */
function agentRunBlock(
  script: ScriptDescriptor,
): { reason: string; message: string } | null {
  if (isTeardownScript(script)) {
    return {
      reason: 'Teardown scripts run when a worktree is archived or deleted.',
      message: `Agents cannot run teardown scripts such as "${script.label}": they run when a worktree is archived or deleted. ${SCRIPTS_SECTION_HINT}`,
    };
  }
  if (runsInTerminal(script)) {
    return {
      reason:
        'Interactive scripts run in a terminal and can wait for typed input.',
      message: `Agents cannot run interactive scripts such as "${script.label}": they run in a terminal and can wait for typed input. ${SCRIPTS_SECTION_HINT}`,
    };
  }
  return null;
}

function scriptIdentity(script: ScriptDescriptor): {
  [key: string]: AppAdvisorJson;
} {
  return {
    scriptKey: script.scriptKey,
    scriptName: script.scriptName,
    label: script.label,
    lifecycle: script.lifecycle,
    scope: script.target,
    repoId: script.repoId ?? null,
  };
}

function lastRunJson(
  meta: WorkerScriptExecution,
  running: boolean,
): AppAdvisorJson {
  // A persisted running record with no live process was stopped, for
  // example by an app restart.
  const status =
    meta.status === 'running' && !running ? 'stopped' : mapHumanStatus(meta);
  return {
    status,
    exitCode: meta.exitCode,
    timedOut: meta.timedOut,
    durationMs: meta.durationMs,
    startedAt: meta.startedAt,
    completedAt: meta.completedAt,
  };
}

async function scriptListRow(
  script: ScriptDescriptor,
  target: ScriptTarget,
): Promise<AppAdvisorJson> {
  const running = isScriptActive(target, script.scriptKey);
  const block = agentRunBlock(script);
  const meta = await readScriptRun({
    ...target,
    scriptKey: script.scriptKey,
    tailLines: 0,
  }).then(
    ({ run }) => run?.execution ?? null,
    (): null => null,
  );
  return {
    ...scriptIdentity(script),
    repoName: script.repoName ?? null,
    interactive: runsInTerminal(script),
    agentRunnable: block === null,
    notRunnableReason: block?.reason ?? null,
    running,
    lastRun: meta ? lastRunJson(meta, running) : null,
  };
}

/**
 * `worktree.list_scripts`: the worktree's configured scripts with their run
 * state. Commands are omitted; agents read repository-defined commands from
 * the checkout when they need them.
 */
export async function listWorktreeScripts(
  runtime: WorktreeScriptActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const resolved = await resolveScriptTarget(runtime);
  if ('response' in resolved) return resolved.response;
  const { target } = resolved;
  const entries = await listWorktreeScriptEntries(target);
  const scripts = await Promise.all(
    entries.map(({ descriptor }) => scriptListRow(descriptor, target)),
  );
  return success({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    scripts,
    hint: 'Run a script with worktree.run_script using its scriptKey, then read its output with GetScriptOutput.',
  });
}

function missingScriptMessage(
  scriptKey: string,
  entries: readonly WorktreeScriptEntry[],
): string {
  if (entries.length === 0) {
    return `No script "${scriptKey}" is configured for this worktree, which has no configured scripts.`;
  }
  const keys = entries
    .slice(0, MISSING_SCRIPT_KEY_LIMIT)
    .map((entry) => entry.descriptor.scriptKey)
    .join(', ');
  return `No script "${scriptKey}" is configured for this worktree. Configured scripts: ${keys}. Use worktree.list_scripts for details.`;
}

async function selectScript(
  target: ScriptTarget,
  scriptId: string,
  repo: string | undefined,
): Promise<
  { entry: WorktreeScriptEntry } | { response: AppAdvisorActionResponse }
> {
  const key = await resolveScriptKey({
    projectId: target.projectId,
    scriptId,
    ...(repo ? { repo } : {}),
  });
  if ('error' in key)
    return { response: failure('invalid_payload', key.error) };
  const entries = await listWorktreeScriptEntries(target);
  const entry = entries.find(
    (candidate) => candidate.descriptor.scriptKey === key.scriptKey,
  );
  return entry
    ? { entry }
    : {
        response: failure(
          'not_found',
          missingScriptMessage(key.scriptKey, entries),
        ),
      };
}

function normalizeWaitSeconds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(MAX_SCRIPT_WAIT_SECONDS, Math.max(0, Math.floor(value)));
}

function createOutputTail(): OutputTail {
  let lines: string[] = [];
  let dropped = false;
  return {
    push(next: readonly string[]): void {
      lines = [...lines, ...next.slice(-OUTPUT_TAIL_MAX_LINES)];
      if (next.length > OUTPUT_TAIL_MAX_LINES) dropped = true;
      if (lines.length > OUTPUT_TAIL_MAX_LINES) {
        lines = lines.slice(-OUTPUT_TAIL_MAX_LINES);
        dropped = true;
      }
    },
    snapshot(): { lines: string[]; truncated: boolean } {
      const kept: string[] = [];
      let chars = 0;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? '';
        if (chars + line.length > OUTPUT_TAIL_MAX_CHARS) {
          if (kept.length === 0) kept.push(line.slice(-OUTPUT_TAIL_MAX_CHARS));
          return { lines: kept, truncated: true };
        }
        kept.unshift(line);
        chars += line.length;
      }
      return { lines: kept, truncated: dropped };
    },
  };
}

function tailJson(tail: OutputTail): {
  outputTail: string[];
  outputTruncated: boolean;
} {
  const snapshot = tail.snapshot();
  return { outputTail: snapshot.lines, outputTruncated: snapshot.truncated };
}

function rendererForwarder(
  runtime: WorktreeScriptActionRuntime,
): (channel: string, event: unknown) => void {
  // Keep the accessor lazy so each delivery targets the current window.
  const getWindow = runtime.getSendableWindow ?? runtime.getWindow;
  return (channel: string, event: unknown): void => {
    try {
      sendToWindow(getWindow(), channel, event);
    } catch (cause) {
      logMainProcessError(
        'Failed to deliver an agent script event to the renderer.',
        cause,
      );
    }
  };
}

function waitForOutcome(
  outcome: Promise<RunOutcome>,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<RunOutcome | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const cleanup: Array<() => void> = [];
    const finish = (value: RunOutcome | null): void => {
      for (const dispose of cleanup) dispose();
      resolve(value);
    };
    const timer = setTimeout((): void => finish(null), waitMs);
    cleanup.push((): void => clearTimeout(timer));
    if (signal) {
      const onAbort = (): void => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
      cleanup.push((): void => signal.removeEventListener('abort', onAbort));
    }
    void outcome.then(finish);
  });
}

function runningRunResult(
  script: ScriptDescriptor,
  tail: OutputTail,
  waitedSeconds: number,
): AppAdvisorActionResponse {
  const readOutput = `Read its output with GetScriptOutput using scriptId "${script.scriptKey}".`;
  return success({
    ...scriptIdentity(script),
    started: true,
    finished: false,
    status: 'running',
    waitedSeconds,
    ...(waitedSeconds > 0 ? tailJson(tail) : {}),
    hint:
      script.lifecycle === 'launch'
        ? `${script.label} keeps running until it is stopped. ${readOutput}`
        : `The run appears in the Scripts section. ${readOutput}`,
  });
}

function failureFromCause(cause: unknown): AppAdvisorActionResponse {
  const message =
    cause instanceof Error && cause.message
      ? cause.message
      : 'The script could not run.';
  return failure(
    cause instanceof RemoteControlServiceError &&
      cause.code !== 'github_not_connected'
      ? cause.code
      : 'execution_failed',
    message,
  );
}

function settledRunResult(
  script: ScriptDescriptor,
  outcome: RunOutcome,
  tail: OutputTail,
): AppAdvisorActionResponse {
  if (outcome.kind === 'failed') return failureFromCause(outcome.cause);
  const { response } = outcome;
  return success({
    ...scriptIdentity(script),
    started: true,
    finished: true,
    status: mapHumanStatus({
      status: response.success ? 'success' : 'failed',
      timedOut: response.timedOut,
      exitCode: response.exitCode,
    }),
    success: response.success,
    exitCode: response.exitCode,
    timedOut: response.timedOut,
    durationMs: response.durationMs,
    ...tailJson(tail),
    hint: `Read the full output with GetScriptOutput using scriptId "${script.scriptKey}".`,
  });
}

/** A refusal a retry of the same tool call can never turn into a run. */
function finalFailure(
  code: AppAdvisorActionError['code'],
  message: string,
): AppAdvisorActionResponse {
  return {
    requestId: '',
    ok: false,
    error: { code, message, retryable: false },
  };
}

const RUN_AGAIN_HINT =
  'Check the Scripts section, then send the action again as a new tool call to run it again.';

type PriorRun = Awaited<ReturnType<typeof findScriptRun>>;

/**
 * A repeated tool call answers the run it already started, never a second
 * run: from the run log while it is the script's latest run, otherwise from
 * core's operation for that run. Whether it is still going comes from that
 * run's own state, not from other runs of the script.
 */
function priorRunResult(
  script: ScriptDescriptor,
  operation: NonNullable<PriorRun['operation']>,
  run: PriorRun['run'],
): AppAdvisorActionResponse {
  if (operation.status === 'conflict')
    return finalFailure(
      'idempotency_conflict',
      `This tool call already ran a different script, so ${script.label} was not started. Send the action again as a new tool call.`,
    );
  const live =
    operation.status === 'in_flight' ||
    !isTerminalOperationStatus(operation.status);
  const replayHint = `This tool call already started this run, so it was not started again. Read its output with GetScriptOutput using scriptId "${script.scriptKey}".`;
  if (run) {
    const { execution } = run;
    // A recorded running run whose operation ended was stopped, for example
    // by an app restart.
    const status =
      execution.status === 'running' && !live
        ? 'stopped'
        : mapHumanStatus(execution);
    return success({
      ...scriptIdentity(script),
      started: true,
      replayed: true,
      finished: status !== 'running' && status !== 'orphaned',
      status,
      success: execution.status === 'success',
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      durationMs: execution.durationMs,
      outputTail: run.lines,
      outputTruncated: false,
      hint: replayHint,
    });
  }
  if (live)
    return success({
      ...scriptIdentity(script),
      started: true,
      replayed: true,
      finished: false,
      status:
        operation.status === 'in_flight' || operation.status === 'running'
          ? 'running'
          : operation.status,
      hint: replayHint,
    });
  if (operation.status === 'completed') {
    const { result } = operation;
    return success({
      ...scriptIdentity(script),
      started: true,
      replayed: true,
      finished: true,
      status: mapHumanStatus(result),
      success: result.status === 'success',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      hint: `This tool call already ran this script, and a later run has replaced its output, so it was not started again. ${RUN_AGAIN_HINT}`,
    });
  }
  return finalFailure(
    'execution_failed',
    `This tool call already tried to run ${script.label}, and that run did not finish, so it was not started again. ${RUN_AGAIN_HINT}`,
  );
}

/**
 * Start a run through the same service the Scripts section uses and forward
 * its started/output/complete events so the run appears in the UI. Resolves
 * once execution starts, or after up to `waitSeconds` for it to finish.
 */
async function startAgentRun(
  entry: WorktreeScriptEntry,
  target: ScriptTarget,
  waitSeconds: number,
  runtime: WorktreeScriptActionRuntime,
  runId: string | undefined,
): Promise<AppAdvisorActionResponse> {
  const key = runKey(target, entry.descriptor.scriptKey);
  activeAgentRuns.add(key);
  const tail = createOutputTail();
  const forward = rendererForwarder(runtime);
  let markStarted: () => void = (): void => undefined;
  const executionStarted = new Promise<'started'>((resolve) => {
    markStarted = (): void => resolve('started');
  });
  const outcome = runScript(entry.request, {
    ...(runId ? { runId, keyed: true } : {}),
    // Runs exactly the script that was checked (and approved, for a
    // delegate); a script changed since then is refused, not run.
    expectedScript: {
      command: entry.descriptor.command,
      interactive: runsInTerminal(entry.descriptor),
      ...(entry.descriptor.shell ? { shell: entry.descriptor.shell } : {}),
    },
    onExecutionStarted: (): void => markStarted(),
    onRendererStarted: (event): void =>
      forward(IPC_CHANNELS.scriptStarted, event),
    onRendererOutput: (event): void => {
      tail.push(event.lines);
      forward(IPC_CHANNELS.scriptOutput, event);
    },
    onRendererComplete: (event): void =>
      forward(IPC_CHANNELS.scriptComplete, event),
  }).then(
    (response): RunOutcome => ({ kind: 'finished', response }),
    (cause: unknown): RunOutcome => ({ kind: 'failed', cause }),
  );
  void outcome.then((): void => {
    activeAgentRuns.delete(key);
  });
  const first = await Promise.race([executionStarted, outcome]);
  if (first !== 'started')
    return settledRunResult(entry.descriptor, first, tail);
  if (waitSeconds === 0) return runningRunResult(entry.descriptor, tail, 0);
  const settled = await waitForOutcome(
    outcome,
    waitSeconds * 1000,
    runtime.signal,
  );
  return settled
    ? settledRunResult(entry.descriptor, settled, tail)
    : runningRunResult(entry.descriptor, tail, waitSeconds);
}

/**
 * `worktree.run_script`: run one configured script. `scriptId` and `repo`
 * resolve exactly as they do for GetScriptOutput. A script that is already
 * running is never started twice, and interactive and teardown scripts stay
 * user-only.
 */
export async function runWorktreeScript(
  action: Extract<WorktreeScriptAction, { type: 'worktree.run_script' }>,
  runtime: WorktreeScriptActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const scriptId = action.scriptId.trim();
  if (!scriptId) return failure('invalid_payload', 'scriptId is required.');
  const resolved = await resolveScriptTarget(runtime);
  if ('response' in resolved) return resolved.response;
  const { target } = resolved;
  const selected = await selectScript(target, scriptId, action.repo?.trim());
  if ('response' in selected) return selected.response;
  const script = selected.entry.descriptor;
  const runId = runtime.coreWrites?.scriptRunId(target);
  if (runId) {
    const prior = await findScriptRun({
      ...target,
      executionId: runId,
      scriptKey: script.scriptKey,
      tailLines: OUTPUT_TAIL_MAX_LINES,
    });
    if (prior.operation)
      return priorRunResult(script, prior.operation, prior.run);
  }
  const block = agentRunBlock(script);
  if (block) return failure('invalid_target', block.message);
  const alreadyRunning = (): AppAdvisorActionResponse =>
    failure(
      'invalid_target',
      `${script.label} is already running in this worktree, so a second run was not started. Read its output with GetScriptOutput using scriptId "${script.scriptKey}", or run it again after it finishes.`,
      true,
    );
  if (isScriptActive(target, script.scriptKey)) return alreadyRunning();
  if (runtime.authorizeScriptCommand) {
    // Reserve the run while approval waits, so a parallel call cannot pass
    // the check above and start a second copy.
    const key = runKey(target, script.scriptKey);
    activeAgentRuns.add(key);
    let approved: boolean;
    try {
      approved = await runtime.authorizeScriptCommand(script.command);
    } catch (error) {
      activeAgentRuns.delete(key);
      throw error;
    }
    if (!approved) {
      activeAgentRuns.delete(key);
      return failure(
        'authorization_conflict',
        `Running ${script.label} was denied by the approval policy.`,
      );
    }
    // The user may have started it from the Scripts section meanwhile.
    if (
      isTrackedShellScriptRunning({ ...target, scriptKey: script.scriptKey })
    ) {
      activeAgentRuns.delete(key);
      return alreadyRunning();
    }
  }
  return startAgentRun(
    selected.entry,
    target,
    normalizeWaitSeconds(action.waitSeconds),
    runtime,
    runId,
  );
}
