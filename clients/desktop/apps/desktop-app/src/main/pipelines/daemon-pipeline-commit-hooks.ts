import type { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ExecutionState,
  JobResult,
  StepResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isRecord } from '../lib/type-guards';
import {
  firePrecommitFailureHooks,
  readGitCommitPushResults,
  type GitCommitPushRepoOutput,
} from './execution-runtime-hooks';

/*
 * A daemon run's `git-commit-push` precommit-failure hook (CAN-6012 D3).
 * The daemon's pipeline host has no Electron main, so Electron main runs the
 * hook for the runs it follows, from each settled step's stored outputs on
 * this host; nothing about the commit crosses the event stream. Each step
 * result fires at most once: a marker in the run's main-owned host directory
 * is created exclusively before the hook runs, so a restart or a re-followed
 * run never fires it again. A result is keyed by its execution, job, step and
 * the times it started and finished, which an archived retry or iteration
 * copy keeps and a re-run replaces.
 */

const COMMIT_ACTION = 'builtin/git-commit-push';
const MARKER_FILE = 'precommit-failure-hook.json';
const PENDING_FILE = 'commit-hooks-pending.json';
const SETTLED = new Set(['success', 'failure']);
const FOLLOWED = new Set(['running', 'pending']);
// A paused daemon run resumes in the app, so the daemon adds no results.
const DONE_IN_DAEMON = new Set(['paused', 'success', 'failure', 'cancelled']);

/** Why a settled step's hook did not run; logged as a fixed code, never with outputs. */
export const DAEMON_COMMIT_HOOK_SKIP_OUTPUTS_UNAVAILABLE =
  'pipeline.precommitHook.outputsUnavailable';

export interface DaemonCommitHookScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

export interface DaemonCommitHookPorts {
  fire(args: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly results: readonly GitCommitPushRepoOutput[];
    readonly getWindow?: () => BrowserWindow | null;
  }): Promise<void>;
  warn(message: string, details: Record<string, string>): void;
}

const DEFAULT_PORTS: DaemonCommitHookPorts = {
  fire: firePrecommitFailureHooks,
  warn: logMainProcessWarn,
};

/** `<executionsDir>/<executionId>/host/<sha256(key)>/precommit-failure-hook.json`: no user text in the path. */
export function daemonCommitHookMarkerPath(
  executionsDir: string,
  executionId: string,
  key: string,
): string {
  const digest = createHash('sha256').update(key).digest('hex');
  return path.join(executionsDir, executionId, 'host', digest, MARKER_FILE);
}

/**
 * Marks a run this app sent to the daemon with a top-level `git-commit-push`
 * step, so startup can catch up on results that settled while nothing
 * followed the run. Its follower clears it once the run has ended.
 */
export function daemonCommitHooksPendingPath(
  executionsDir: string,
  executionId: string,
): string {
  return path.join(executionsDir, executionId, 'host', PENDING_FILE);
}

export async function markDaemonCommitHooksPending(
  executionsDir: string,
  executionId: string,
): Promise<void> {
  const file = daemonCommitHooksPendingPath(executionsDir, executionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: 1 })}\n`, {
    mode: 0o600,
  });
}

/** Whether this app sent the run to the daemon and its hooks are not all claimed. */
export async function hasDaemonCommitHooksPending(
  executionsDir: string,
  executionId: string,
): Promise<boolean> {
  return access(daemonCommitHooksPendingPath(executionsDir, executionId)).then(
    () => true,
    () => false,
  );
}

export async function clearDaemonCommitHooksPending(
  executionsDir: string,
  executionId: string,
): Promise<void> {
  await rm(daemonCommitHooksPendingPath(executionsDir, executionId), {
    force: true,
  });
}

/** Whether a launch's pipeline document has a top-level `git-commit-push` step. */
export function hasDaemonCommitSteps(pipeline: unknown): boolean {
  if (!isRecord(pipeline) || !isRecord(pipeline.jobs)) return false;
  return Object.values(pipeline.jobs).some(
    (job) =>
      isRecord(job) &&
      Array.isArray(job.steps) &&
      job.steps.some((step) => isRecord(step) && step.uses === COMMIT_ACTION),
  );
}

/** The key one step result fires under, the same wherever the executor keeps it. */
export function daemonCommitHookKey(
  executionId: string,
  jobId: string,
  stepId: string,
  step: Pick<StepResult, 'started_at' | 'completed_at'>,
): string {
  return [
    executionId,
    jobId,
    stepId,
    step.started_at ?? '',
    step.completed_at ?? '',
  ].join('\0');
}

/** A job's current step results and those its retries and iterations archived. */
function jobStepResults(job: JobResult): Record<string, StepResult>[] {
  const results = [job.steps];
  for (const iteration of job.iteration_history ?? [])
    results.push(iteration.steps);
  for (const attempt of job.retry_history ?? []) {
    results.push(attempt.steps);
    for (const iteration of attempt.iteration_history ?? [])
      results.push(iteration.steps);
  }
  return results;
}

/** Creates the marker; false when it already existed, so the hook already ran. */
async function claim(marker: string, key: string): Promise<boolean> {
  await mkdir(path.dirname(marker), { recursive: true });
  try {
    await writeFile(marker, `${JSON.stringify({ version: 1, key })}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') return false;
    throw error;
  }
}

interface DaemonCommitHookArgs {
  readonly state: ExecutionState;
  readonly executionsDir: string;
  readonly scope: DaemonCommitHookScope;
  readonly handled: Set<string>;
  readonly getWindow?: () => BrowserWindow | null;
  readonly ports?: DaemonCommitHookPorts;
}

/**
 * Runs the precommit-failure hook for every settled `git-commit-push` step
 * result of `state`, current or archived by a retry or iteration, not yet
 * handled. `handled` keeps this follower's keys in memory;
 * the marker keeps them across processes and restarts.
 */
export async function runDaemonCommitHooks(
  args: DaemonCommitHookArgs,
): Promise<void> {
  const ports = args.ports ?? DEFAULT_PORTS;
  const { state } = args;
  for (const [jobId, job] of Object.entries(state.jobs)) {
    // A matrix variant's physical id names its materialized definition.
    const definition =
      state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId];
    const commitSteps = new Set(
      (definition?.steps ?? []).flatMap((entry) =>
        entry.uses === COMMIT_ACTION && entry.id ? [entry.id] : [],
      ),
    );
    if (commitSteps.size === 0) continue;
    for (const steps of jobStepResults(job))
      for (const [stepId, step] of Object.entries(steps)) {
        if (!commitSteps.has(stepId) || !SETTLED.has(step.status)) continue;
        await fireOnce(args, ports, jobId, stepId, step);
      }
  }
}

async function fireOnce(
  args: DaemonCommitHookArgs,
  ports: DaemonCommitHookPorts,
  jobId: string,
  stepId: string,
  step: StepResult,
): Promise<void> {
  const { state } = args;
  const key = daemonCommitHookKey(state.id, jobId, stepId, step);
  if (args.handled.has(key)) return;
  const marker = daemonCommitHookMarkerPath(args.executionsDir, state.id, key);
  // Remembered only once claimed: a claim that fails is tried again.
  const claimed = await claim(marker, key);
  args.handled.add(key);
  if (!claimed) return;
  const results = readGitCommitPushResults(step.outputs);
  if (results === null) {
    ports.warn('Pipeline precommit-failure hook skipped', {
      code: DAEMON_COMMIT_HOOK_SKIP_OUTPUTS_UNAVAILABLE,
      executionId: state.id,
      jobId,
      stepId,
    });
    return;
  }
  await ports.fire({
    projectId: args.scope.projectId,
    worktreeId: args.scope.worktreeId,
    results,
    ...(args.getWindow && { getWindow: args.getWindow }),
  });
}

/**
 * Catch-up for runs this app sent to the daemon that nothing follows: at
 * startup, a commit step that settled after the app's last scan before it
 * quit or crashed; and before the app takes a run over (resume or retry in
 * process), anything its follower left unclaimed. Only a run with a pending
 * mark is scanned, so a run that stayed in the app, whose hooks its
 * post-process already ran, never fires again. Each is scanned once, its
 * markers keep handled results from firing again, and its mark is cleared.
 * A run still running or pending is left to its follower. Resolves with the
 * runs that keep their mark because their scan failed.
 */
export async function catchUpDaemonCommitHooks(args: {
  readonly executionIds: readonly string[];
  readonly executionsDir: string;
  readonly load: (executionId: string) => Promise<ExecutionState | null>;
  readonly scopeOf: (state: ExecutionState) => Promise<
    | {
        readonly scope: DaemonCommitHookScope;
        readonly getWindow?: () => BrowserWindow | null;
      }
    | undefined
  >;
  readonly ports?: DaemonCommitHookPorts;
}): Promise<readonly string[]> {
  const ports = args.ports ?? DEFAULT_PORTS;
  const failed: string[] = [];
  for (const executionId of args.executionIds) {
    try {
      if (!(await hasDaemonCommitHooksPending(args.executionsDir, executionId)))
        continue;
      // Null only when the run's state is gone; a read or parse failure
      // throws, and the mark stays for the next try.
      const state = await args.load(executionId);
      if (state && FOLLOWED.has(state.status)) continue;
      const hooks = state ? await args.scopeOf(state) : undefined;
      if (state && hooks)
        await runDaemonCommitHooks({
          state,
          executionsDir: args.executionsDir,
          scope: hooks.scope,
          handled: new Set(),
          ports,
          ...(hooks.getWindow && { getWindow: hooks.getWindow }),
        });
      await clearDaemonCommitHooksPending(args.executionsDir, executionId);
    } catch {
      // The mark stays, so the next start tries this run again.
      failed.push(executionId);
      ports.warn('Pipeline precommit-failure hook catch-up failed', {
        executionId,
      });
    }
  }
  return failed;
}

/** Whether the daemon adds no more results, so a final scan leaves nothing to catch up on. */
export function daemonCommitHooksDone(state: ExecutionState): boolean {
  return DONE_IN_DAEMON.has(state.status);
}

/**
 * One followed run's scans, one at a time (CAN-6012 D3): a scan starts after
 * every earlier claim and hook has finished, and the pending mark is cleared
 * only after a scan of a state the daemon adds nothing to.
 */
export class DaemonCommitHookFollower {
  private readonly handled = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly options: {
      readonly executionId: string;
      readonly executionsDir: string;
      readonly scope: DaemonCommitHookScope;
      readonly getWindow?: () => BrowserWindow | null;
      readonly ports?: DaemonCommitHookPorts;
    },
  ) {}

  /** Queues a scan of `state`; resolves once it and every earlier one have run. */
  public scan(state: ExecutionState): Promise<void> {
    const { executionId, executionsDir, scope, getWindow, ports } =
      this.options;
    this.chain = this.chain.then(async () => {
      try {
        await runDaemonCommitHooks({
          state,
          executionsDir,
          scope,
          handled: this.handled,
          ...(getWindow && { getWindow }),
          ...(ports && { ports }),
        });
        if (daemonCommitHooksDone(state))
          await clearDaemonCommitHooksPending(executionsDir, executionId);
      } catch {
        // The mark stays, so a later scan or the next start tries again.
        (ports ?? DEFAULT_PORTS).warn(
          'Pipeline precommit-failure hook scan failed',
          { executionId },
        );
      }
    });
    return this.chain;
  }
}
