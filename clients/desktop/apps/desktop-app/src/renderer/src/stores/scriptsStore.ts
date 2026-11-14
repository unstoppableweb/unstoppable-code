import { create } from 'zustand';
import type {
  ScriptCompleteEvent,
  ScriptDescriptor,
  ScriptOutputEvent,
  ScriptRunResponse,
  ScriptRunSnapshot,
  ScriptStartedEvent,
} from '@canopy/desktop-shared/types';
import type {
  ProjectLifecycleScriptName,
  ScriptDevServerPattern,
  ScriptLifecyclePhase,
} from '@canopy/desktop-shared/scripts';
import {
  extractDevServerHits,
  type DevServerHit,
} from '@/lib/scriptDevServerDetection';
import {
  applyBatchToRunsMap,
  createIdleOutputBuffer,
  type IdleOutputBuffer,
} from './idleOutputBuffer';

const MAX_OUTPUT_LINES = 1000;
/**
 * How many trailing output lines to keep resident when a worktree is unloaded
 * (navigated away from). Keeping a small tail — rather than clearing output —
 * means switching back to a still-running script shows its last lines instantly
 * instead of a blank box while the async snapshot reload is in flight. The full
 * history (and anything emitted while away) is still restored from the
 * persisted snapshot on focus. Tiny memory cost vs. the previous zero.
 */
const RETAINED_TAIL_LINES = 50;
const RETAINED_RUN_START_SKEW_MS = 10_000;
const loadedWorktreeKeys = new Set<string>();

/**
 * Pending output events are accumulated here and flushed in a single
 * `set()` call via `requestIdleCallback` so that rapid IPC messages
 * don't trigger one React re-render each and user interactions
 * (clicks, typing, scrolling) always process first.
 */
interface PendingOutput {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
  lines: string[];
  script: ScriptDescriptor;
  runId?: string;
}

interface ScriptRunIdentity {
  token: symbol;
  runId?: string;
  awaitingStart: boolean;
  completionReceived: boolean;
  failureNotified: boolean;
}

let outputBuffer: IdleOutputBuffer<PendingOutput> | null = null;

export interface ScriptRunState {
  label: string;
  scriptName: string;
  lifecycle: ScriptLifecyclePhase | 'custom';
  command: string;
  target: ScriptDescriptor['target'];
  repoId?: string;
  repoName?: string;
  status: 'running' | 'stopping' | 'success' | 'failed';
  outputLines: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: number;
  /**
   * Optional dev-server pattern (regex source string or array of entries) copied
   * from the descriptor at `startRun` time. Survives the transition to
   * success/failed because `completeRunFromEvent` spreads the existing run
   * state first; consumed by `appendOutput` to detect URLs in streamed output.
   */
  devServerPattern?: ScriptDevServerPattern;
  /**
   * Detected dev-server URL hits accumulated across the full run lifetime.
   * Always defined (empty array when no patterns match or none are configured)
   * so consumers can call `.length` without a guard.
   */
  devServerHits: DevServerHit[];
  /**
   * True when `outputLines` is a trimmed tail kept across a worktree unload
   * (not the full live output). Marks the run as still eligible for snapshot
   * hydration on reload — `mergeLoadedRunState` treats it like an empty
   * placeholder so the persisted full history replaces the tail on focus.
   * Cleared once hydrated (the snapshot-derived run does not set it).
   */
  outputIsRetainedTail?: boolean;
  /** The persisted run's id, for a user's Stop or Clear of it (CAN-6482). */
  executionId?: string;
  /** Set while a restart's orphaned run still runs: see ScriptRunSnapshot. */
  orphan?: ScriptRunSnapshot['orphan'];
  /** A lost run whose record names no process: it may still be running. */
  lostFrom?: 'unrecorded';
}

function isWorkspaceLifecycleRun(
  run: ScriptRunState,
  lifecycle: ProjectLifecycleScriptName,
): boolean {
  if (run.lifecycle !== lifecycle) {
    return false;
  }

  if (run.target === 'workspace-repo') {
    return true;
  }

  if (run.target !== 'workspace-root') {
    return false;
  }

  const beforeScriptName = `before-${lifecycle}`;
  const afterScriptName = `after-${lifecycle}`;
  return (
    run.scriptName === lifecycle ||
    run.scriptName === beforeScriptName ||
    run.scriptName === afterScriptName
  );
}
export function hasActiveWorkspaceLifecycleRun(
  runs: Record<string, ScriptRunState> | undefined,
  lifecycle: ProjectLifecycleScriptName,
): boolean {
  if (!runs) {
    return false;
  }

  return Object.values(runs).some(
    (run) =>
      isWorkspaceLifecycleRun(run, lifecycle) && isScriptRunActive(run.status),
  );
}

export function isWorkspaceLaunchRun(run: ScriptRunState): boolean {
  return isWorkspaceLifecycleRun(run, 'launch');
}

export function hasActiveWorkspaceLaunchRun(
  runs: Record<string, ScriptRunState> | undefined,
): boolean {
  return hasActiveWorkspaceLifecycleRun(runs, 'launch');
}
interface ScriptsState {
  /** Keyed by `${projectId}/${worktreeId}` → scriptKey → ScriptRunState */
  runs: Record<string, Record<string, ScriptRunState>>;
  startRun: (
    projectId: string,
    worktreeId: string,
    script: ScriptDescriptor,
  ) => symbol;
  startRunFromEvent: (event: ScriptStartedEvent) => void;
  appendOutput: (event: ScriptOutputEvent) => void;
  markStopping: (
    projectId: string,
    worktreeId: string,
    scriptKey: string,
  ) => symbol | false;
  completeRun: (
    projectId: string,
    worktreeId: string,
    scriptKey: string,
    response: ScriptRunResponse,
    token?: symbol,
  ) => void;
  completeStaleRun: (
    projectId: string,
    worktreeId: string,
    scriptKey: string,
    token?: symbol,
  ) => void;
  completeRunFromEvent: (event: ScriptCompleteEvent) => boolean;
  claimFailureNotification: (event: ScriptCompleteEvent) => boolean;
  loadWorktreeRuns: (projectId: string, worktreeId: string) => Promise<void>;
  /**
   * Applies a user's Stop or Clear of the persisted run `executionId`
   * (CAN-6482): `lost` once its process is stopped or gone, `cleared` once
   * its record is removed. A newer run of the script key is left alone.
   */
  settlePersistedRun: (
    projectId: string,
    worktreeId: string,
    scriptKey: string,
    executionId: string,
    outcome: 'lost' | 'cleared',
  ) => void;
  unloadWorktreeRuns: (projectId: string, worktreeId: string) => void;
  cleanupWorktree: (projectId: string, worktreeId: string) => void;
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function createRunState(script: ScriptDescriptor): ScriptRunState {
  const run: ScriptRunState = {
    label: script.label,
    scriptName: script.scriptName,
    lifecycle: script.lifecycle,
    command: script.command,
    target: script.target,
    repoId: script.repoId,
    repoName: script.repoName,
    status: 'running',
    outputLines: [],
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    startedAt: Date.now(),
    devServerHits: [],
  };
  if (script.devServerPattern !== undefined) {
    run.devServerPattern = script.devServerPattern;
  }
  return run;
}

function runStateFromSnapshot(snapshot: ScriptRunSnapshot): ScriptRunState {
  const run = createRunState(snapshot.script);
  const parsedStartedAt = Date.parse(snapshot.startedAt);
  return {
    ...run,
    status:
      snapshot.status === 'running'
        ? 'running'
        : snapshot.status === 'success'
          ? 'success'
          : 'failed',
    outputLines:
      snapshot.outputLines.length > MAX_OUTPUT_LINES
        ? snapshot.outputLines.slice(-MAX_OUTPUT_LINES)
        : snapshot.outputLines,
    exitCode: snapshot.exitCode,
    timedOut: snapshot.timedOut,
    durationMs: snapshot.durationMs,
    startedAt: Number.isNaN(parsedStartedAt) ? Date.now() : parsedStartedAt,
    devServerHits: extractDevServerHits({
      devServerPattern: snapshot.script.devServerPattern,
      lines: snapshot.outputLines,
      existingHits: [],
    }),
    ...(snapshot.runId !== undefined && { executionId: snapshot.runId }),
    ...(snapshot.orphan !== undefined && { orphan: snapshot.orphan }),
    ...(snapshot.lostFrom !== undefined && { lostFrom: snapshot.lostFrom }),
  };
}

function mergeLoadedRunState(
  existing: ScriptRunState | undefined,
  loaded: ScriptRunState,
): ScriptRunState {
  if (!existing) {
    return loaded;
  }

  const loadedStartedAfterExisting = loaded.startedAt >= existing.startedAt;
  const loadedActiveWithinMainRendererSkew =
    isScriptRunActive(loaded.status) &&
    loaded.startedAt + RETAINED_RUN_START_SKEW_MS >= existing.startedAt;
  const canHydrateRetainedActiveRun =
    isScriptRunActive(existing.status) &&
    // An emptied placeholder OR a retained tail (kept across unload) is a
    // stand-in for the persisted run and should be replaced by the on-disk
    // snapshot. A live, fully-loaded run (non-empty, no retained-tail mark) is
    // left untouched so a repeat load never clobbers streaming output.
    (existing.outputLines.length === 0 ||
      existing.outputIsRetainedTail === true) &&
    // `startRunFromEvent` stamps renderer time, while persisted setup logs are
    // created in main immediately before that event. Allow a small skew so
    // returning to a worktree can restore the on-disk output tail instead of
    // preserving an empty active placeholder.
    (loadedStartedAfterExisting || loadedActiveWithinMainRendererSkew);
  const canHydrateRetainedCompletedRun =
    !isScriptRunActive(existing.status) &&
    (existing.outputLines.length === 0 ||
      existing.outputIsRetainedTail === true) &&
    loaded.outputLines.length > 0 &&
    existing.status === loaded.status &&
    (loadedStartedAfterExisting ||
      loaded.startedAt + RETAINED_RUN_START_SKEW_MS >= existing.startedAt);

  if (!canHydrateRetainedActiveRun && !canHydrateRetainedCompletedRun) {
    return existing;
  }

  const devServerHits = extractDevServerHits({
    devServerPattern: loaded.devServerPattern,
    lines: loaded.outputLines,
    existingHits: existing.devServerHits,
  });

  return {
    ...loaded,
    status:
      canHydrateRetainedActiveRun && isScriptRunActive(loaded.status)
        ? existing.status
        : loaded.status,
    devServerHits,
  };
}

export function isScriptRunActive(status: ScriptRunState['status']): boolean {
  return status === 'running' || status === 'stopping';
}

export function hasActiveSetupRun(
  runs: Record<string, ScriptRunState> | undefined,
): boolean {
  return Object.values(runs ?? {}).some(
    (run) => run.lifecycle === 'setup' && isScriptRunActive(run.status),
  );
}

function retainActiveRunsWithTail(
  worktreeRuns: Record<string, ScriptRunState>,
): Record<string, ScriptRunState> | null {
  const retained: Record<string, ScriptRunState> = {};
  for (const [scriptKey, run] of Object.entries(worktreeRuns)) {
    if (isScriptRunActive(run.status)) {
      retained[scriptKey] = {
        ...run,
        outputLines: run.outputLines.slice(-RETAINED_TAIL_LINES),
        outputIsRetainedTail: true,
      };
    }
  }
  return Object.keys(retained).length > 0 ? retained : null;
}

/**
 * Merge a batch of pending output items into an existing runs map.
 * Shared between the idle-flush callback and the synchronous
 * `flushPendingScriptOutputs` helper so the logic stays in one place.
 */
function applyBatchToRuns(
  runs: Record<string, Record<string, ScriptRunState>>,
  batch: PendingOutput[],
): Record<string, Record<string, ScriptRunState>> {
  return applyBatchToRunsMap(runs, batch, {
    getKey: (item) => ({
      worktreeKey: worktreeKey(item.projectId, item.worktreeId),
      runKey: item.scriptKey,
      lines: item.lines,
    }),
    createRun: (item, outputLines, newLines) => {
      const base = createRunState(item.script);
      const devServerHits = extractDevServerHits({
        devServerPattern: item.script.devServerPattern,
        lines: newLines,
        existingHits: base.devServerHits,
      });
      return {
        ...base,
        outputLines,
        devServerHits,
      };
    },
    updateRun: (run, outputLines, newLines) => {
      const devServerHits = extractDevServerHits({
        devServerPattern: run.devServerPattern,
        lines: newLines,
        existingHits: run.devServerHits,
      });
      return {
        ...run,
        outputLines,
        devServerHits,
      };
    },
    maxOutputLines: MAX_OUTPUT_LINES,
  });
}

export const useScriptsStore = create<ScriptsState>((set, get) => {
  // Keep one identity per current script, including unloaded worktrees whose
  // events still notify. Local tokens associate invoke responses with the
  // start that issued them; lifecycle messages use the service's existing ID.
  const identities = new Map<string, Map<string, ScriptRunIdentity>>();
  const identityFor = (
    wk: string,
    scriptKey: string,
  ): ScriptRunIdentity | undefined => identities.get(wk)?.get(scriptKey);
  const setIdentity = (
    wk: string,
    scriptKey: string,
    runId?: string,
    awaitingStart = false,
  ): ScriptRunIdentity => {
    const identity: ScriptRunIdentity = {
      token: Symbol(),
      runId,
      awaitingStart,
      completionReceived: false,
      failureNotified: false,
    };
    const worktree: Map<string, ScriptRunIdentity> =
      identities.get(wk) ?? new Map<string, ScriptRunIdentity>();
    worktree.set(scriptKey, identity);
    identities.set(wk, worktree);
    return identity;
  };
  const acceptsEvent = (
    wk: string,
    scriptKey: string,
    runId: string | undefined,
  ): boolean => {
    if (runId === undefined) return true;
    const current = identityFor(wk, scriptKey);
    return (
      current === undefined ||
      (!current.awaitingStart && current.runId === undefined) ||
      current.runId === runId
    );
  };
  const buffer = createIdleOutputBuffer<PendingOutput>({
    getWorktreeKey: (item) => worktreeKey(item.projectId, item.worktreeId),
    flushBatch: (batch) => {
      const current = batch.filter((item) =>
        acceptsEvent(
          worktreeKey(item.projectId, item.worktreeId),
          item.scriptKey,
          item.runId,
        ),
      );
      if (current.length > 0) {
        set((state) => ({ runs: applyBatchToRuns(state.runs, current) }));
      }
    },
    minFlushIntervalMs: 250,
  });
  outputBuffer = buffer;

  return {
    runs: {},

    startRun: (
      projectId: string,
      worktreeId: string,
      script: ScriptDescriptor,
    ): symbol => {
      const wk = worktreeKey(projectId, worktreeId);
      const identity = setIdentity(wk, script.scriptKey, undefined, true);
      loadedWorktreeKeys.add(wk);
      set((state) => {
        const nextRun: ScriptRunState = createRunState(script);

        return {
          runs: {
            ...state.runs,
            [wk]: {
              ...state.runs[wk],
              [script.scriptKey]: nextRun,
            },
          },
        };
      });
      return identity.token;
    },

    startRunFromEvent: (event: ScriptStartedEvent): void => {
      const wk = worktreeKey(event.projectId, event.worktreeId);
      const current = identityFor(wk, event.script.scriptKey);
      if (event.runId !== undefined && current?.runId === event.runId) return;
      if (current?.awaitingStart) {
        current.runId = event.runId;
        current.awaitingStart = false;
      } else {
        setIdentity(wk, event.script.scriptKey, event.runId);
      }
      if (!loadedWorktreeKeys.has(wk)) return;
      set((state) => ({
        runs: {
          ...state.runs,
          [wk]: {
            ...state.runs[wk],
            [event.script.scriptKey]: createRunState(event.script),
          },
        },
      }));
    },

    appendOutput: (event: ScriptOutputEvent): void => {
      const wk = worktreeKey(event.projectId, event.worktreeId);
      if (!loadedWorktreeKeys.has(wk)) {
        return;
      }
      buffer.push({
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        scriptKey: event.script.scriptKey,
        lines: event.lines,
        script: event.script,
        runId: event.runId,
      });
    },

    markStopping: (
      projectId: string,
      worktreeId: string,
      scriptKey: string,
    ): symbol | false => {
      const wk = worktreeKey(projectId, worktreeId);
      const worktreeRuns = get().runs[wk];
      if (!worktreeRuns) return false;

      const existing = worktreeRuns[scriptKey];
      if (!existing || existing.status !== 'running') return false;

      set((state) => ({
        runs: {
          ...state.runs,
          [wk]: {
            ...state.runs[wk],
            [scriptKey]: {
              ...existing,
              status: 'stopping',
            },
          },
        },
      }));

      return (identityFor(wk, scriptKey) ?? setIdentity(wk, scriptKey)).token;
    },

    completeRun: (
      projectId: string,
      worktreeId: string,
      scriptKey: string,
      response: ScriptRunResponse,
      token?: symbol,
    ): void => {
      const wk = worktreeKey(projectId, worktreeId);
      const identity = identityFor(wk, scriptKey);
      if (
        token !== undefined &&
        (identity?.token !== token || identity.completionReceived)
      ) {
        return;
      }
      set((state) => {
        const worktreeRuns = state.runs[wk];
        if (!worktreeRuns) return state;
        const existing = worktreeRuns[scriptKey];
        if (!existing) return state;

        return {
          runs: {
            ...state.runs,
            [wk]: {
              ...worktreeRuns,
              [scriptKey]: {
                ...existing,
                status: response.success ? 'success' : 'failed',
                exitCode: response.exitCode,
                timedOut: response.timedOut,
                durationMs: response.durationMs,
              },
            },
          },
        };
      });
    },

    completeStaleRun: (
      projectId: string,
      worktreeId: string,
      scriptKey: string,
      token?: symbol,
    ): void => {
      const wk = worktreeKey(projectId, worktreeId);
      if (token !== undefined && identityFor(wk, scriptKey)?.token !== token) {
        return;
      }
      set((state) => {
        const worktreeRuns = state.runs[wk];
        if (!worktreeRuns) return state;
        const existing = worktreeRuns[scriptKey];
        if (!existing || !isScriptRunActive(existing.status)) return state;

        return {
          runs: {
            ...state.runs,
            [wk]: {
              ...worktreeRuns,
              [scriptKey]: {
                ...existing,
                status: 'failed',
                exitCode: null,
                timedOut: false,
                durationMs: Math.max(0, Date.now() - existing.startedAt),
              },
            },
          },
        };
      });
    },

    completeRunFromEvent: (event: ScriptCompleteEvent): boolean => {
      const wk = worktreeKey(event.projectId, event.worktreeId);
      if (!acceptsEvent(wk, event.script.scriptKey, event.runId)) return false;
      const identity =
        identityFor(wk, event.script.scriptKey) ??
        setIdentity(wk, event.script.scriptKey, event.runId);
      identity.runId = event.runId ?? identity.runId;
      identity.completionReceived = true;
      buffer.flush();
      set((state) => {
        const worktreeRuns = state.runs[wk] ?? {};
        if (!loadedWorktreeKeys.has(wk) && state.runs[wk] === undefined) {
          return state;
        }
        const existing =
          worktreeRuns[event.script.scriptKey] ?? createRunState(event.script);

        return {
          runs: {
            ...state.runs,
            [wk]: {
              ...worktreeRuns,
              [event.script.scriptKey]: {
                ...existing,
                status: event.result.success ? 'success' : 'failed',
                exitCode: event.result.exitCode,
                timedOut: event.result.timedOut,
                durationMs: event.result.durationMs,
              },
            },
          },
        };
      });
      return true;
    },

    claimFailureNotification: (event: ScriptCompleteEvent): boolean => {
      // Older producers have no reliable identity; preserve their behavior.
      if (event.runId === undefined) return true;
      const identity = identityFor(
        worktreeKey(event.projectId, event.worktreeId),
        event.script.scriptKey,
      );
      if (identity?.runId !== event.runId || identity.failureNotified) {
        return false;
      }
      identity.failureNotified = true;
      return true;
    },

    loadWorktreeRuns: async (
      projectId: string,
      worktreeId: string,
    ): Promise<void> => {
      const wk = worktreeKey(projectId, worktreeId);
      loadedWorktreeKeys.add(wk);
      if (typeof window.api.loadWorktreeScriptRuns !== 'function') {
        return;
      }
      const snapshots = await window.api.loadWorktreeScriptRuns({
        projectId,
        worktreeId,
        maxLines: MAX_OUTPUT_LINES,
      });
      set((state) => {
        if (!loadedWorktreeKeys.has(wk)) {
          return state;
        }
        const loadedRuns: Record<string, ScriptRunState> = {};
        for (const snapshot of snapshots) {
          loadedRuns[snapshot.script.scriptKey] =
            runStateFromSnapshot(snapshot);
        }
        const existing = state.runs[wk] ?? {};
        const mergedRuns: Record<string, ScriptRunState> = { ...existing };
        for (const [scriptKey, loadedRun] of Object.entries(loadedRuns)) {
          mergedRuns[scriptKey] = mergeLoadedRunState(
            existing[scriptKey],
            loadedRun,
          );
        }
        return {
          runs: {
            ...state.runs,
            [wk]: mergedRuns,
          },
        };
      });
    },

    settlePersistedRun: (
      projectId,
      worktreeId,
      scriptKey,
      executionId,
      outcome,
    ): void => {
      const wk = worktreeKey(projectId, worktreeId);
      set((state) => {
        const worktreeRuns = state.runs[wk];
        const run = worktreeRuns?.[scriptKey];
        if (!worktreeRuns || run?.executionId !== executionId) return state;
        const next = { ...worktreeRuns };
        if (outcome === 'cleared') {
          delete next[scriptKey];
        } else {
          const lost: ScriptRunState = {
            ...run,
            status: 'failed',
            exitCode: null,
          };
          delete lost.orphan;
          next[scriptKey] = lost;
        }
        return { runs: { ...state.runs, [wk]: next } };
      });
    },

    unloadWorktreeRuns: (projectId: string, worktreeId: string): void => {
      const wk = worktreeKey(projectId, worktreeId);
      loadedWorktreeKeys.delete(wk);
      buffer.removeWorktree(wk);
      set((state) => {
        const worktreeRuns = state.runs[wk];
        if (!worktreeRuns) return state;
        const retainedRuns = retainActiveRunsWithTail(worktreeRuns);
        if (retainedRuns) {
          return {
            runs: {
              ...state.runs,
              [wk]: retainedRuns,
            },
          };
        }
        const next = { ...state.runs };
        delete next[wk];
        return { runs: next };
      });
    },

    cleanupWorktree: (projectId: string, worktreeId: string): void => {
      const wk = worktreeKey(projectId, worktreeId);
      identities.delete(wk);
      loadedWorktreeKeys.delete(wk);
      buffer.removeWorktree(wk);
      set((state) => {
        if (!state.runs[wk]) return state;
        const next = { ...state.runs };
        delete next[wk];
        return { runs: next };
      });
    },
  };
});

/**
 * Immediately flush any buffered `appendOutput` events into the store.
 * Exposed for testing — production code relies on `requestIdleCallback`.
 */
export function flushPendingScriptOutputs(): void {
  outputBuffer?.flush();
}
