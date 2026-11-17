import type {
  MultiRepoSidebarItem,
  ScriptRunResponse,
  SidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  buildScriptEntries,
  findLaunchEntry,
  launchScriptsProject,
  type ScriptEntry,
} from '@/components/activity/script-utils';
import type { AppliedProjectWorktreeScripts } from '@/lib/projectWorktreeScripts';
import {
  isScriptRunActive,
  useScriptsStore,
  type ScriptRunState,
} from '@/stores/scriptsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useGitHubStore } from '@/stores/githubStore';

// UX: surface-specific refusals for Launch; never fall back to the project.
const NO_LAUNCH_COMMAND = 'This worktree has no launch command';
const LAUNCH_UNREADABLE = "Couldn't read this worktree's launch command";

type CodeProject = SingleRepoSidebarItem | MultiRepoSidebarItem;

/**
 * CAN-6933: the project as this worktree's own checkout resolves it, read
 * now. Its scripts are the worktree's alone, even when that map is empty, so
 * Launch never runs the project's command for a branch that changed or
 * removed its own. A failed read refuses rather than falling back.
 */
export async function readFreshLaunchProject(
  projectId: string,
  worktreeId: string,
): Promise<CodeProject | null> {
  const read = await useProjectsStore
    .getState()
    .ensureWorktreeEffective(projectId, [worktreeId]);
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === projectId);
  const own =
    project && project.type !== 'cowork'
      ? project.worktreeEffective?.[worktreeId]
      : undefined;
  if (!read || !project || project.type === 'cowork' || !own) {
    useGitHubStore.getState().addToast(LAUNCH_UNREADABLE, 'warning');
    return null;
  }
  return launchScriptsProject(project, worktreeId);
}

const pendingLaunches = new Set<string>();

/**
 * Runs `launch` at most once at a time per worktree, so a second click while
 * the worktree's scripts are being read starts nothing.
 */
export async function guardWorktreeLaunch(
  projectId: string,
  worktreeId: string,
  launch: () => Promise<void>,
): Promise<void> {
  const key = `${projectId}/${worktreeId}`;
  if (pendingLaunches.has(key)) return;
  pendingLaunches.add(key);
  try {
    await launch();
  } finally {
    pendingLaunches.delete(key);
  }
}

/** Launch from a row menu: the worktree's own command, read now, or nothing. */
export function launchWorktreeFresh(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  return guardWorktreeLaunch(projectId, worktreeId, async () => {
    const project = await readFreshLaunchProject(projectId, worktreeId);
    if (!project) return;
    const entry = resolveWorktreeLaunchEntry(
      project,
      worktreeId,
      useProjectsStore.getState().appliedProjectWorktreeScripts,
    );
    if (!entry) {
      useGitHubStore.getState().addToast(NO_LAUNCH_COMMAND, 'warning');
      return;
    }
    const runs = useScriptsStore.getState().runs[`${projectId}/${worktreeId}`];
    if (isWorktreeLaunchActive(entry, runs)) return;
    runWorktreeLaunch(projectId, worktreeId, entry);
  });
}

/**
 * A worktree's Launch script, shared by both sidebar rails' Launch menu item:
 * the legacy row (through `WorktreeItemAdapter`) and the shared rail's host.
 */
export function resolveWorktreeLaunchEntry(
  project: SidebarItem,
  worktreeId: string,
  appliedProjectWorktreeScripts: AppliedProjectWorktreeScripts,
): ScriptEntry | undefined {
  return findLaunchEntry(
    buildScriptEntries(
      project.type === 'cowork'
        ? project
        : launchScriptsProject(project, worktreeId),
      worktreeId,
      appliedProjectWorktreeScripts,
    ),
  );
}

/**
 * Whether the worktree's launch is already running, which disables Launch.
 * A workspace-level launch (`onRun`) owns every launch-lifecycle run; a
 * project script owns only its own run.
 */
export function isWorktreeLaunchActive(
  launchEntry: ScriptEntry | undefined,
  runs: Readonly<Record<string, ScriptRunState>> | undefined,
): boolean {
  if (!launchEntry || !runs) return false;
  if (launchEntry.onRun) {
    return Object.values(runs).some(
      (run) => run.lifecycle === 'launch' && isScriptRunActive(run.status),
    );
  }
  const existingRun = runs[launchEntry.script.scriptKey];
  return existingRun ? isScriptRunActive(existingRun.status) : false;
}

/** Start the worktree's launch script and record its run in the scripts store. */
export function runWorktreeLaunch(
  projectId: string,
  worktreeId: string,
  launchEntry: ScriptEntry,
): void {
  if (launchEntry.onRun) {
    void launchEntry.onRun().catch(() => undefined);
    return;
  }
  const request = launchEntry.request;
  if (!request) return;
  const scriptKey = launchEntry.script.scriptKey;
  useScriptsStore
    .getState()
    .startRun(projectId, worktreeId, launchEntry.script);
  void window.api
    .runScript(request)
    .then((response: ScriptRunResponse) => {
      useScriptsStore
        .getState()
        .completeRun(projectId, worktreeId, scriptKey, response);
    })
    .catch((cause: unknown) => {
      useScriptsStore.getState().completeRun(projectId, worktreeId, scriptKey, {
        success: false,
        exitCode: null,
        output:
          cause instanceof Error ? cause.message : 'Script execution failed',
        timedOut: false,
        durationMs: 0,
      });
    });
}

/**
 * Every active script run, keyed `worktreeKey` + NUL + `scriptKey`, valued by
 * its lifecycle. It carries no output, so a `useShallow` subscriber (the
 * shared rail's host) re-renders when a run starts or stops, never as it
 * prints.
 */
export function indexActiveScriptRuns(
  runs: Readonly<Record<string, Readonly<Record<string, ScriptRunState>>>>,
): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [worktreeKey, worktreeRuns] of Object.entries(runs)) {
    for (const [scriptKey, run] of Object.entries(worktreeRuns)) {
      if (isScriptRunActive(run.status)) {
        index[`${worktreeKey}\u0000${scriptKey}`] = run.lifecycle;
      }
    }
  }
  return index;
}

/** {@link isWorktreeLaunchActive} over an {@link indexActiveScriptRuns} index. */
export function isWorktreeLaunchActiveInIndex(
  launchEntry: ScriptEntry | undefined,
  index: Readonly<Record<string, string>>,
  worktreeKey: string,
): boolean {
  if (!launchEntry) return false;
  const prefix = `${worktreeKey}\u0000`;
  if (launchEntry.onRun) {
    return Object.entries(index).some(
      ([key, lifecycle]) => key.startsWith(prefix) && lifecycle === 'launch',
    );
  }
  return `${prefix}${launchEntry.script.scriptKey}` in index;
}

/**
 * Worktree keys with an active run of `lifecycle`, read from an
 * {@link indexActiveScriptRuns} index.
 */
export function worktreesWithActiveRun(
  index: Readonly<Record<string, string>>,
  lifecycle: ScriptRunState['lifecycle'],
): Set<string> {
  const keys = new Set<string>();
  for (const [key, runLifecycle] of Object.entries(index)) {
    if (runLifecycle !== lifecycle) continue;
    keys.add(key.slice(0, key.indexOf('\u0000')));
  }
  return keys;
}

/**
 * Worktree keys (`projectId/worktreeId`) with a script run that can still be
 * stopped: running, not already stopping. A `useShallow` subscriber
 * re-renders only when that set changes.
 */
export function worktreesWithStoppableScripts(
  runs: Readonly<Record<string, Readonly<Record<string, ScriptRunState>>>>,
): string[] {
  return Object.entries(runs)
    .filter(([, worktreeRuns]) =>
      Object.values(worktreeRuns).some((run) => run.status === 'running'),
    )
    .map(([worktreeKey]) => worktreeKey);
}

/**
 * Stops one script. A run the scripts store holds as running is marked
 * stopping and settled with main's reply; one already stopping is left alone.
 * Anything else (a worktree the store has not loaded, or a store entry that
 * finished while main still runs the key) is stopped in main alone, leaving
 * the store's entry as it is.
 */
export function stopWorktreeScript(
  projectId: string,
  worktreeId: string,
  scriptKey: string,
): void {
  const scriptsState = useScriptsStore.getState();
  const status =
    scriptsState.runs[`${projectId}/${worktreeId}`]?.[scriptKey]?.status;
  if (status === 'stopping') return;
  const tracked =
    status === 'running' &&
    scriptsState.markStopping(projectId, worktreeId, scriptKey);
  void window.api
    .stopScript({ projectId, worktreeId, scriptKey })
    .then((response) => {
      if (!tracked) return;
      const latest = useScriptsStore.getState();
      if (response) {
        latest.completeRun(projectId, worktreeId, scriptKey, response);
        return;
      }
      latest.completeStaleRun(projectId, worktreeId, scriptKey);
    })
    .catch((cause: unknown) => {
      if (tracked) {
        useScriptsStore
          .getState()
          .completeStaleRun(projectId, worktreeId, scriptKey);
      }
      reportClientAppError(cause);
    });
}

/**
 * Stops every running script in a worktree: the row menu's Stop running
 * scripts, alone or across a bulk selection. The scripts store holds only
 * worktrees the user has opened, so main's runs are read too. Main lists the
 * latest run per script, which can hide an older instance still running, so
 * every script it knows is stopped: main cancels each running instance of a
 * key and does nothing for a key with none.
 */
export async function stopWorktreeScripts(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const keys = new Set<string>();
  const runs = useScriptsStore.getState().runs[`${projectId}/${worktreeId}`];
  for (const [scriptKey, run] of Object.entries(runs ?? {})) {
    if (run.status === 'running') keys.add(scriptKey);
  }
  try {
    const persisted = await window.api.loadWorktreeScriptRuns({
      projectId,
      worktreeId,
      maxLines: 0,
    });
    for (const run of persisted) keys.add(run.script.scriptKey);
  } catch (cause: unknown) {
    // The store's own runs still stop below.
    reportClientAppError(cause);
  }
  for (const scriptKey of keys) {
    stopWorktreeScript(projectId, worktreeId, scriptKey);
  }
}
