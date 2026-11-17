import {
  getScriptCommand,
  getScriptDisplayName,
  getScriptInteractive,
  listRunnableScripts,
  resolveEffectiveScriptInteractive,
} from '@canopy/desktop-shared/scripts';
import type { ProjectLifecycleScriptName } from '@canopy/desktop-shared/scripts';
import type {
  MultiRepoSidebarItem,
  ScriptDescriptor,
  SidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  createProjectScriptDescriptor,
  createWorkspaceRootScriptDescriptor,
  createWorkspaceRepoScriptDescriptor,
} from '@/lib/scriptDescriptors';
import {
  getSingleRepoWorktreeEffectiveScripts,
  type AppliedProjectWorktreeScripts,
} from '@/lib/projectWorktreeScripts';
import { useProjectsStore } from '@/stores/projectsStore';

export interface ScriptEntry {
  script: ScriptDescriptor;
  request?: Parameters<typeof window.api.runScript>[0];
  onRun?: () => Promise<void>;
}

export function findWorkspaceLaunchEntry(
  entries: ScriptEntry[],
): ScriptEntry | undefined {
  return entries.find(
    (entry) => entry.onRun && entry.script.lifecycle === 'launch',
  );
}

export function findLaunchEntry(
  entries: ScriptEntry[],
): ScriptEntry | undefined {
  return entries.find((entry) => entry.script.lifecycle === 'launch');
}

function getDisplayScripts(
  baseEffectiveScripts: MultiRepoSidebarItem['effectiveScripts'],
  worktreeEffectiveScripts: MultiRepoSidebarItem['effectiveScripts'],
): MultiRepoSidebarItem['effectiveScripts'] {
  if (
    worktreeEffectiveScripts &&
    Object.keys(worktreeEffectiveScripts).length > 0
  ) {
    return worktreeEffectiveScripts;
  }

  return baseEffectiveScripts;
}

const WORKSPACE_LIFECYCLE_SCRIPT_NAMES: ProjectLifecycleScriptName[] = [
  'setup',
  'launch',
  'teardown',
];

function getWorkspaceLifecycleScriptKey(
  lifecycle: ProjectLifecycleScriptName,
): string {
  return `workspace-${lifecycle}`;
}

function getWorkspaceBeforeScriptName(
  lifecycle: ProjectLifecycleScriptName,
): string {
  return `before-${lifecycle}`;
}

function getWorkspaceAfterScriptName(
  lifecycle: ProjectLifecycleScriptName,
): string {
  return `after-${lifecycle}`;
}

function getEffectiveInteractive(
  scriptName: string,
  interactive: boolean | undefined,
): boolean {
  return resolveEffectiveScriptInteractive({
    scriptName,
    configuredInteractive: interactive,
  });
}

function hasWorkspaceLifecycle(
  project: MultiRepoSidebarItem,
  worktreeId: string | null,
  lifecycle: ProjectLifecycleScriptName,
): boolean {
  const wtOverrides = worktreeId
    ? project.worktreeEffective?.[worktreeId]
    : undefined;
  const rootScripts = getDisplayScripts(
    project.effectiveScripts,
    wtOverrides?.effectiveScripts,
  );

  return (
    Boolean(
      getScriptCommand(rootScripts, getWorkspaceBeforeScriptName(lifecycle)),
    ) ||
    Boolean(
      getScriptCommand(rootScripts, getWorkspaceAfterScriptName(lifecycle)),
    ) ||
    project.repos.some((repo) => {
      const repoScripts = getDisplayScripts(
        repo.effectiveScripts,
        wtOverrides?.repos?.[repo.id]?.effectiveScripts,
      );
      return Boolean(getScriptCommand(repoScripts, lifecycle));
    })
  );
}

function isWorkspaceLifecycleInteractive(
  project: MultiRepoSidebarItem,
  worktreeId: string | null,
  lifecycle: ProjectLifecycleScriptName,
): boolean {
  const wtOverrides = worktreeId
    ? project.worktreeEffective?.[worktreeId]
    : undefined;
  const rootScripts = getDisplayScripts(
    project.effectiveScripts,
    wtOverrides?.effectiveScripts,
  );
  if (
    getScriptInteractive(
      rootScripts,
      getWorkspaceBeforeScriptName(lifecycle),
    ) ||
    getScriptInteractive(rootScripts, getWorkspaceAfterScriptName(lifecycle))
  ) {
    return true;
  }
  return project.repos.some((repo) =>
    getScriptInteractive(
      getDisplayScripts(
        repo.effectiveScripts,
        wtOverrides?.repos?.[repo.id]?.effectiveScripts,
      ),
      lifecycle,
    ),
  );
}

function getWorkspaceLifecycleRunner(
  lifecycle: ProjectLifecycleScriptName,
  projectId: string,
  worktreeId: string,
): () => Promise<void> {
  return async (): Promise<void> => {
    const store = useProjectsStore.getState();
    if (lifecycle === 'setup') {
      await store.setupWorkspace(projectId, worktreeId);
      return;
    }
    if (lifecycle === 'launch') {
      await store.launchWorkspace(projectId, worktreeId);
      return;
    }
    await store.teardownWorkspace(projectId, worktreeId);
  };
}

export function buildScriptEntries(
  project: SidebarItem,
  worktreeId: string,
  appliedProjectWorktreeScripts: AppliedProjectWorktreeScripts,
): ScriptEntry[] {
  const entries: ScriptEntry[] = [];
  if (project.type === 'cowork') {
    return entries;
  }
  const wtOverrides = project.worktreeEffective?.[worktreeId];

  if (project.type === 'single-repo') {
    const effectiveScripts = getDisplayScripts(
      getSingleRepoWorktreeEffectiveScripts(
        project,
        worktreeId,
        appliedProjectWorktreeScripts,
      ),
      wtOverrides?.effectiveScripts,
    );
    for (const runnableScript of listRunnableScripts(effectiveScripts)) {
      const script = createProjectScriptDescriptor(
        runnableScript.name,
        runnableScript.command,
        runnableScript.devServerPattern,
        runnableScript.shell,
        getEffectiveInteractive(
          runnableScript.name,
          runnableScript.interactive,
        ),
      );
      entries.push({
        script,
        request: {
          target: 'project',
          scriptName: runnableScript.name,
          projectId: project.id,
          worktreeId,
        },
      });
    }
    return entries;
  }

  const wsRootScripts = getDisplayScripts(
    project.effectiveScripts,
    wtOverrides?.effectiveScripts,
  );

  for (const lifecycle of WORKSPACE_LIFECYCLE_SCRIPT_NAMES) {
    if (hasWorkspaceLifecycle(project, worktreeId, lifecycle)) {
      const displayName = getScriptDisplayName(lifecycle);
      entries.push({
        script: {
          scriptKey: getWorkspaceLifecycleScriptKey(lifecycle),
          scriptName: lifecycle,
          label: `Workspace ${displayName}`,
          command: `Run before-${lifecycle}, run child ${lifecycle} scripts, then run after-${lifecycle}.`,
          lifecycle,
          target: 'workspace-root',
          ...(getEffectiveInteractive(
            lifecycle,
            isWorkspaceLifecycleInteractive(project, worktreeId, lifecycle),
          )
            ? { interactive: true as const }
            : {}),
        },
        onRun: getWorkspaceLifecycleRunner(lifecycle, project.id, worktreeId),
      });
    }
  }

  for (const runnableScript of listRunnableScripts(wsRootScripts)) {
    const script = createWorkspaceRootScriptDescriptor(
      runnableScript.name,
      runnableScript.command,
      runnableScript.devServerPattern,
      runnableScript.shell,
      getEffectiveInteractive(runnableScript.name, runnableScript.interactive),
    );
    entries.push({
      script,
      request: {
        target: 'workspace-root',
        scriptName: runnableScript.name,
        workspaceId: project.id,
        worktreeId,
      },
    });
  }

  for (const repo of project.repos) {
    const repoScripts = getDisplayScripts(
      repo.effectiveScripts,
      wtOverrides?.repos?.[repo.id]?.effectiveScripts,
    );
    for (const runnableScript of listRunnableScripts(repoScripts)) {
      const script = createWorkspaceRepoScriptDescriptor(
        repo.id,
        repo.name,
        runnableScript.name,
        runnableScript.command,
        runnableScript.devServerPattern,
        runnableScript.shell,
        getEffectiveInteractive(
          runnableScript.name,
          runnableScript.interactive,
        ),
      );
      entries.push({
        script,
        request: {
          target: 'workspace-repo',
          scriptName: runnableScript.name,
          workspaceId: project.id,
          worktreeId,
          repoId: repo.id,
        },
      });
    }
  }

  return entries;
}

/**
 * CAN-6933: `project` as Launch sees `worktreeId` once that worktree's own
 * scripts have been read: those scripts alone, even an empty map, so the
 * Launch shown always matches what runs. A row not read yet keeps the
 * project's scripts.
 */
export function launchScriptsProject(
  project: SingleRepoSidebarItem | MultiRepoSidebarItem,
  worktreeId: string,
): SingleRepoSidebarItem | MultiRepoSidebarItem {
  const own = project.worktreeEffective?.[worktreeId];
  if (!own) return project;
  if (project.type === 'single-repo')
    return { ...project, effectiveScripts: own.effectiveScripts ?? {} };
  return {
    ...project,
    effectiveScripts: own.effectiveScripts ?? {},
    repos: project.repos.map((repo) => ({
      ...repo,
      effectiveScripts: own.repos?.[repo.id]?.effectiveScripts ?? {},
    })),
  };
}

export function hasRunScripts(
  projects: SidebarItem[],
  projectId: string | null,
  worktreeId: string | null,
  appliedProjectWorktreeScripts: AppliedProjectWorktreeScripts,
): boolean {
  if (!projectId) return false;
  const found = projects.find((p) => p.id === projectId);
  if (!found) return false;
  if (found.type === 'cowork') return false;
  const project = worktreeId ? launchScriptsProject(found, worktreeId) : found;
  if (project.type === 'single-repo') {
    if (!worktreeId) {
      return false;
    }
    const wtOverrides = project.worktreeEffective?.[worktreeId];
    const effectiveScripts = getDisplayScripts(
      getSingleRepoWorktreeEffectiveScripts(
        project,
        worktreeId,
        appliedProjectWorktreeScripts,
      ),
      wtOverrides?.effectiveScripts,
    );
    return Boolean(getScriptCommand(effectiveScripts, 'launch'));
  }
  return hasWorkspaceLifecycle(project, worktreeId, 'launch');
}

export function countConfiguredScripts(
  projects: SidebarItem[],
  projectId: string | null,
  worktreeId: string | null,
  appliedProjectWorktreeScripts: AppliedProjectWorktreeScripts,
): number {
  if (!projectId) return 0;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return 0;
  if (project.type === 'cowork') return 0;
  const wtOverrides = worktreeId
    ? project.worktreeEffective?.[worktreeId]
    : undefined;

  if (project.type === 'single-repo') {
    if (!worktreeId) {
      return 0;
    }
    const effectiveScripts = getDisplayScripts(
      getSingleRepoWorktreeEffectiveScripts(
        project,
        worktreeId,
        appliedProjectWorktreeScripts,
      ),
      wtOverrides?.effectiveScripts,
    );
    return listRunnableScripts(effectiveScripts).length;
  }

  let count = listRunnableScripts(
    getDisplayScripts(project.effectiveScripts, wtOverrides?.effectiveScripts),
  ).length;
  for (const repo of project.repos) {
    count += listRunnableScripts(
      getDisplayScripts(
        repo.effectiveScripts,
        wtOverrides?.repos?.[repo.id]?.effectiveScripts,
      ),
    ).length;
  }
  for (const lifecycle of WORKSPACE_LIFECYCLE_SCRIPT_NAMES) {
    if (hasWorkspaceLifecycle(project, worktreeId, lifecycle)) {
      count += 1;
    }
  }
  return count;
}
