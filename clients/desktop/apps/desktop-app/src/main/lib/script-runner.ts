import { getDesktopExecutionSecrets } from '../execution-secrets/owner';
import { spawn } from 'node:child_process';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { withW5ProcessFileLocks } from '@canopy/core-platform/w5-process-file-lock';
import {
  buildScriptShellCommand,
  ScriptExecutionWorker,
  type ScriptChildProcess,
  type ScriptCommandShell,
  type ScriptExecutionWorkerHost,
  type ScriptRunTracking,
  type ScriptShellCommand,
  type StoppedScriptRun,
} from '@canopy/core-runtime/node/script/execution';
import { findExecutableOnPath } from '@canopy/execution-engine/node/lib/path-lookup';
import { buildCmdCommandLine } from '@canopy/execution-engine/node/lib/windows-process';
import type { ScriptRunResponse } from '@canopy/desktop-shared/types';
import { MAX_SCRIPT_TIMEOUT_SECONDS } from '@canopy/desktop-shared/scripts';
import { getResolvedCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { CANOPY_IN_PROCESS_WORKER_TARGET_ID } from '@canopy/protocol/canopy-core';
import type { ScriptRunLogRef } from './script-log-store';
import {
  lowerSpawnedProcessPriority,
  prepareBackgroundProcessLaunch,
} from './background-process';
import { writeFileAtomically } from './atomic-file';
import { logMainProcessWarn } from './main-process-logging';
import { buildScriptRunFileStem, resolveScriptRunDir } from './paths';
import { drainOwnedProcess, killChildProcessGroup } from './process-kill';
import { resolveWindowsGitBash } from './windows-git-bash';
import { desktopScriptRunWriterFence } from './script-run-writer-fence';
import { getResourceMonitorService } from '../resource-monitor';
import {
  getExecutionAccounting,
  withExecutionLease,
} from '../execution-accounting';
import { assertWorkspaceTargetRuntimeStartAllowed } from './workspace-target-exclusion';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  evaluateStorageWrite,
  STORAGE_OWNERSHIP,
  StorageWriteRefusedError,
} from '@canopy/core-runtime/storage';

/**
 * Admits Electron main's run-log writes (CAN-6985). Every write and delete of
 * the run logs enters `logLock`, so this is their one admission. It admits
 * them while `script_runs` stays legacy and refuses them once the daemon owns
 * the store. A section that only reads the run logs (a snapshot copied
 * elsewhere) is not a write and is not checked.
 */
function admitRunLogWrite<T>(write: () => Promise<T>): Promise<T> {
  const decision = evaluateStorageWrite(
    'script_runs',
    'electron_main',
    STORAGE_OWNERSHIP,
  );
  return decision.allowed
    ? write()
    : Promise.reject(
        new StorageWriteRefusedError(
          'script_runs',
          'electron_main',
          decision.reason,
        ),
      );
}

/**
 * Electron main's host for the worker's script execution (CAN-4143): process
 * effects, run-log paths and the projection of a script's context onto this
 * machine's checkouts. The runner, registry and run log are worker code in
 * `@canopy/core-runtime/node/script/execution`.
 */
const desktopScriptHost: ScriptExecutionWorkerHost = {
  secrets: getDesktopExecutionSecrets(),
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  platform: () => hostPlatformOperatingSystem(),
  findExecutable: (name) => findExecutableOnPath(name),
  windowsGitBash: () => resolveWindowsGitBash(),
  cmdCommandLine: (scriptPath) => buildCmdCommandLine(scriptPath),
  loginShell: () => process.env.SHELL,
  comSpec: () => process.env.ComSpec,
  prepareLaunch: (command, args, background) =>
    prepareBackgroundProcessLaunch(command, args, background),
  lowerPriority: (pid) => lowerSpawnedProcessPriority(pid),
  spawn: (command, args, options): ScriptChildProcess => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: options.detached,
      windowsHide: true,
    });
    return {
      get pid(): number | undefined {
        return child.pid;
      },
      stdout: child.stdout && {
        onData: (listener) => child.stdout?.on('data', listener),
        destroy: () => child.stdout?.destroy(),
      },
      stderr: child.stderr && {
        onData: (listener) => child.stderr?.on('data', listener),
        destroy: () => child.stderr?.destroy(),
      },
      onError: (listener) => child.on('error', listener),
      onClose: (listener) => child.on('close', listener),
      killGroup: (signal) => killChildProcessGroup(child, signal),
    };
  },
  drainOwnedProcess: (pid, isOwned) => drainOwnedProcess(pid, isOwned),
  assertStartAllowed: (projectId, worktreeId) =>
    assertWorkspaceTargetRuntimeStartAllowed(projectId, worktreeId),
  registerProcess: (pid, tracking) => {
    const script = tracking.script;
    if (!script) return undefined;
    const resourceId = `script:${tracking.projectId}:${tracking.worktreeId}:${tracking.scriptKey}:${pid}`;
    const registration = getResourceMonitorService().registerProcess({
      id: resourceId,
      groupId: 'scripts',
      kind: 'script',
      label: script.label,
      pid,
      processGroupId: pid,
      metadata: {
        type: 'script',
        script: {
          projectId: tracking.projectId,
          worktreeId: tracking.worktreeId,
          scriptKey: tracking.scriptKey,
          scriptName: script.scriptName,
          scriptLabel: script.label,
          target: script.target,
          ...(script.repoId ? { repoId: script.repoId } : {}),
          ...(script.repoName ? { repoName: script.repoName } : {}),
          ...(tracking.invocation ? { invocation: tracking.invocation } : {}),
        },
      },
    });
    return withExecutionLease(
      getExecutionAccounting().track('script', resourceId),
      registration,
    );
  },
  logPaths: {
    runDir: (projectId, worktreeId) =>
      resolveScriptRunDir(projectId, worktreeId),
    fileStem: (scriptKey) => buildScriptRunFileStem(scriptKey),
  },
  logFiles: {
    writeFileAtomically: (path, text) =>
      writeFileAtomically(path, text, { encoding: 'utf8' }),
  },
  writerFence: desktopScriptRunWriterFence,
  // The daemon writes the same run logs under the same lock (CAN-5839).
  logLock: {
    run: (runDir, work, access) => {
      const lock = { dataRoot: getResolvedCanopyDataDir().path };
      return access === 'read'
        ? withW5ProcessFileLocks([runDir], lock, work)
        : admitRunLogWrite(() => withW5ProcessFileLocks([runDir], lock, work));
    },
  },
  // Manual runs reveal their terminal, as before the move (CAN-5062).
  revealTerminal: (tracking) =>
    tracking.invocation?.startsWith('manual') === true,
  // Keep the PTY backend off the import path of hooks and ordinary runs.
  terminals: async () =>
    (await import('../terminal/worker-terminal')).workerTerminal,
  resolvePlace: async (scope, context, secrets) =>
    (await import('./script-execution-place')).resolveScriptExecutionPlace(
      scope,
      context,
      secrets,
    ),
  warn: (message, details) => logMainProcessWarn(message, details),
};

/** This process's local worker script execution; the dispatcher serves it. */
export const desktopScriptWorker = new ScriptExecutionWorker(desktopScriptHost);

export type ScriptTrackingInfo = ScriptRunTracking;
export type StoppedTrackedShellScript = StoppedScriptRun;

export interface RunShellScriptOptions {
  script: string;
  cwd: string;
  shell?: ScriptCommandShell;
  /** Pass null or omit to disable the timeout. Must be positive when set. */
  timeoutSeconds?: number | null;
  onChunk?: (lines: string[]) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  tracking?: ScriptTrackingInfo;
  /**
   * Run the shell and the processes it launches below the app's priority.
   * Intended for automatic background work, not user-started scripts.
   */
  backgroundPriority?: boolean;
  /** Run in one of the worker's terminals so the script can accept input. */
  interactive?: boolean;
  /** Visible title for an interactive terminal session. */
  terminalTitle?: string;
  /** Reveal and focus the interactive terminal when it is spawned. */
  focusOnSpawn?: boolean;
  /** Called synchronously after the child/PTY is registered for teardown. */
  onProcessStarted?: () => void;
}

/** A positive timeout in seconds, clamped, as the runner's milliseconds. */
export function scriptTimeoutMs(
  timeoutSeconds: number | null | undefined,
): number | null {
  return typeof timeoutSeconds === 'number' && timeoutSeconds > 0
    ? Math.min(timeoutSeconds, MAX_SCRIPT_TIMEOUT_SECONDS) * 1000
    : null;
}

export function buildShellScriptCommand(
  script: string,
  shell?: ScriptCommandShell,
  options?: { interactive?: boolean },
): ScriptShellCommand {
  return buildScriptShellCommand(desktopScriptHost, script, shell, options);
}

/** Runs this process tracks that another host executes (CAN-5087). */
export interface ExternalScriptRuns {
  list(): ScriptRunTracking[];
  subscribe(listener: () => void): () => void;
  /** Stops every external run of the script key; resolves once each settled. */
  stop(target: ScriptRunTracking): Promise<StoppedScriptRun[]>;
  stopRun(
    target: ScriptRunTracking & { runId: string },
  ): Promise<StoppedScriptRun | null>;
  drainMatching(
    target: { projectId: string; worktreeId: string },
    shouldDrain: (tracking: ScriptRunTracking) => boolean,
  ): Promise<StoppedScriptRun[]>;
  drainWorktree(projectId: string, worktreeId: string): Promise<void>;
  /** Requests a stop of every external run without waiting. */
  stopAll(): void;
}

let external: ExternalScriptRuns | null = null;
let unsubscribeExternal: (() => void) | null = null;
const externalListeners = new Set<() => void>();

function notifyExternalListeners(): void {
  externalListeners.forEach((listener) => listener());
}

export function setExternalScriptRuns(source: ExternalScriptRuns | null): void {
  unsubscribeExternal?.();
  unsubscribeExternal = null;
  external = source;
  if (source) unsubscribeExternal = source.subscribe(notifyExternalListeners);
  notifyExternalListeners();
}

function withExternalListener(
  listener: () => void,
  unsubscribe: () => void,
): () => void {
  externalListeners.add(listener);
  return (): void => {
    unsubscribe();
    externalListeners.delete(listener);
  };
}

export function subscribeTrackedScriptsChanged(
  listener: () => void,
): () => void {
  return withExternalListener(
    listener,
    desktopScriptWorker.registry.subscribe(listener),
  );
}

export function listTrackedShellScripts(): ScriptTrackingInfo[] {
  return [...desktopScriptWorker.registry.list(), ...(external?.list() ?? [])];
}

export function stopAllRunningShellScripts(): void {
  desktopScriptWorker.registry.stopAll();
  external?.stopAll();
}

export async function stopTrackedShellScript(
  target: ScriptTrackingInfo,
): Promise<StoppedTrackedShellScript | null> {
  // Both hosts may hold a run of the key: stop every one of them.
  const [own, others] = await Promise.all([
    desktopScriptWorker.registry.stop(target),
    external?.stop(target) ?? Promise.resolve([]),
  ]);
  return own ?? others[0] ?? null;
}

/** Stop one concrete run without affecting concurrent instances of its script. */
export async function stopTrackedShellScriptRun(
  target: ScriptTrackingInfo & { logRef: ScriptRunLogRef },
): Promise<StoppedTrackedShellScript | null> {
  return (
    (await desktopScriptWorker.registry.stopRun({
      ...target,
      runId: target.logRef.runId,
    })) ??
    (await external?.stopRun({ ...target, runId: target.logRef.runId })) ??
    null
  );
}

/** See {@link ScriptRunRegistry.drainMatching}. */
export async function drainTrackedShellScriptRunsForWorktree(
  target: { projectId: string; worktreeId: string },
  shouldDrain: (tracking: ScriptTrackingInfo) => boolean,
): Promise<StoppedTrackedShellScript[]> {
  const [own, others] = await Promise.all([
    desktopScriptWorker.registry.drainMatching(target, shouldDrain),
    external?.drainMatching(target, shouldDrain) ?? Promise.resolve([]),
  ]);
  return [...own, ...others];
}

/** Includes hooks, automatic setup, and duplicate keys absent from renderer state. */
export async function drainWorktreeShellScripts(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  await Promise.all([
    desktopScriptWorker.registry.drainWorktree(projectId, worktreeId),
    external?.drainWorktree(projectId, worktreeId),
  ]);
}

export function isTrackedShellScriptRunning(
  target: ScriptTrackingInfo,
): boolean {
  return (
    desktopScriptWorker.registry.isRunning(target) ||
    (external?.list() ?? []).some(
      (tracking) =>
        tracking.projectId === target.projectId &&
        tracking.worktreeId === target.worktreeId &&
        tracking.scriptKey === target.scriptKey &&
        (tracking.kind ?? 'script') === (target.kind ?? 'script'),
    )
  );
}

/**
 * List the tracking info for every currently-running tracked shell script that
 * belongs to a given worktree. Used by the Split PR start handler to enumerate
 * (and then stop) running scripts for the worktree before acquiring the lock.
 */
export function listTrackedShellScriptsForWorktree(target: {
  projectId: string;
  worktreeId: string;
}): ScriptTrackingInfo[] {
  return [
    ...desktopScriptWorker.registry.listForWorktree(target),
    ...(external?.list() ?? []).filter(
      (tracking) =>
        tracking.projectId === target.projectId &&
        tracking.worktreeId === target.worktreeId &&
        (tracking.kind ?? 'script') === 'script',
    ),
  ];
}

/**
 * Run a command on this process's worker without a run log or dispatch
 * record, in a process or, when interactive, in one of the worker's
 * terminals. Scripts run through `lib/script-execution`; this remains for
 * hook commands (CAN-4146).
 */
export function runShellScript(
  options: RunShellScriptOptions,
): Promise<ScriptRunResponse> {
  const common = {
    script: options.script,
    cwd: options.cwd,
    ...(options.shell ? { shell: options.shell } : {}),
    timeoutMs: scriptTimeoutMs(options.timeoutSeconds),
    ...(options.onChunk ? { onChunk: options.onChunk } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.tracking ? { tracking: options.tracking } : {}),
    backgroundPriority: options.backgroundPriority === true,
    ...(options.onProcessStarted
      ? { onProcessStarted: options.onProcessStarted }
      : {}),
  };
  return (
    options.interactive === true
      ? desktopScriptWorker.runTerminal({
          ...common,
          ...(options.terminalTitle ? { title: options.terminalTitle } : {}),
          ...(options.focusOnSpawn !== undefined
            ? { focus: options.focusOnSpawn }
            : {}),
        })
      : desktopScriptWorker.runProcess(common)
  ).then(({ success, exitCode, output, timedOut, durationMs }) => ({
    success,
    exitCode,
    output,
    timedOut,
    durationMs,
  }));
}
