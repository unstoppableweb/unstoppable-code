import {
  CoreInitiatedWorkSourceListResultSchema,
  CoreScriptDefinitionListResultSchema,
  WorkerGitRemoteGetResultSchema,
  type CoreHookSource,
  type CoreScriptDefinition,
  type CoreScriptTarget,
  type WorkerGitRemoteRepositorySelector,
} from '@canopy/protocol/canopy-core';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol';
import { getScriptDisplayName } from '@canopy/desktop-shared/scripts';
import { getHookTriggerDisplayName } from '@canopy/desktop-shared/hooks';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  activeProjectConfigFile,
  projectLocalEditTarget,
  projectLocalHookRows,
  projectLocalScriptRows,
  type ProjectLocalRepository,
  type ProjectLocalRow,
  type ProjectLocalSetup,
  type ProjectLocalSetupPort,
} from '@canopy/ui-app/capability/project-setup/project-local-setup';
import type { FileTreeRoot } from '@canopy/desktop-shared/types';
import { brand } from '@/lib/brand';
import { joinRoot, pathInsideRoot } from '@/lib/show-files';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

// ---------------------------------------------------------------------------
// The Shared setup panel's scripts and hooks on desktop (CAN-6239, phase 08).
//
// Read-only, through operations this computer's core already serves over the
// renderer relay: `core.script.definition.list` (the scripts a run would
// use, with the layer that supplied each), `core.initiatedWork.source.list`
// (the hooks, likewise) and `worker.git.remote.get` (the origin a repository's
// "Edit in repo" links to). No channel is added. Each repository's config file
// is the first of the brand's `storage.configFileNames` its checkout has, as
// the runtime picks it (`findExistingProjectConfigFile`), read in the
// worktree "Edit in repo" opens.
// ---------------------------------------------------------------------------

type CodeWorkspace = SingleRepoSidebarItem | MultiRepoSidebarItem;

interface Target {
  readonly repository: Omit<ProjectLocalRepository, 'edit' | 'configFile'>;
  /** Row grouping; null in a single-repository project. */
  readonly rowKey: string | null;
  readonly scripts: CoreScriptTarget;
  readonly remote: {
    readonly repoId?: string;
    readonly repository: WorkerGitRemoteRepositorySelector;
  } | null;
  /** The file tree root its config file sits in, by repo id. */
  readonly rootRepoId: string | null;
}

async function query(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (typeof window === 'undefined' || !window.canopyCore)
    throw new Error('Scripts and hooks are unavailable right now');
  const reply = await window.canopyCore.invoke({
    kind: 'request',
    method,
    params,
  });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.value;
}

function targetsOf(workspace: CodeWorkspace): Target[] {
  if (workspace.type === 'single-repo')
    return [
      {
        repository: { key: 'repository', name: workspace.name },
        rowKey: null,
        scripts: { kind: 'project', workspaceId: workspace.id },
        remote: { repository: { kind: 'recorded' } },
        rootRepoId: null,
      },
    ];
  return [
    {
      repository: { key: WORKSPACE_ROOT_REPO_ID, name: workspace.name },
      rowKey: WORKSPACE_ROOT_REPO_ID,
      scripts: { kind: 'workspace-root', workspaceId: workspace.id },
      // Only a project with a source repository has a root config file.
      remote: workspace.sourceRepoPath
        ? { repository: { kind: 'source' } }
        : null,
      rootRepoId: workspace.sourceRepoPath ? WORKSPACE_ROOT_REPO_ID : null,
    },
    ...workspace.repos.map(
      (repo): Target => ({
        repository: { key: repo.id, name: repo.name },
        rowKey: repo.id,
        scripts: {
          kind: 'workspace-repo',
          workspaceId: workspace.id,
          repoId: repo.id,
        },
        remote: { repoId: repo.id, repository: { kind: 'recorded' } },
        rootRepoId: repo.id,
      }),
    ),
  ];
}

async function remoteUrl(
  workspaceId: string,
  remote: Target['remote'],
): Promise<string | null> {
  if (remote === null) return null;
  // Without an origin to link to, the local file opens instead.
  return query('worker.git.remote.get', {
    scope: {
      workspaceId,
      ...(remote.repoId === undefined ? {} : { repoId: remote.repoId }),
    },
    repository: remote.repository,
  }).then(
    (value): string | null => {
      const parsed = WorkerGitRemoteGetResultSchema.safeParse(value);
      if (!parsed.success) return null;
      const { origin } = parsed.data;
      return origin.state === 'configured' && origin.endpoint.kind === 'network'
        ? origin.endpoint.url
        : null;
    },
    (): null => null,
  );
}

/** The worktree a local config file opens in, and its file tree roots. */
interface Checkout {
  readonly worktree: WorktreeData;
  readonly roots: readonly FileTreeRoot[];
}

async function checkoutOf(workspace: CodeWorkspace): Promise<Checkout | null> {
  const worktree = latestWorktree(workspace);
  if (worktree === null) return null;
  const { roots } = await window.api.getFileTreeRoots({
    projectId: workspace.id,
    worktreeId: worktree.id,
  });
  return { worktree, roots };
}

/** The root a repository's config file sits in, in `checkout`. */
function rootOf(
  workspace: CodeWorkspace,
  checkout: Checkout,
  repositoryKey: string | null,
): FileTreeRoot | null {
  if (workspace.type === 'single-repo') return checkout.roots[0] ?? null;
  if (repositoryKey === null) return null;
  return (
    checkout.roots.find((candidate) => candidate.repoId === repositoryKey) ??
    null
  );
}

/**
 * The config file a repository uses on this computer: the first brand name
 * its checkout has, else the brand's primary name (also when there is no
 * checkout or it can't be read).
 */
async function configFileOf(
  workspace: CodeWorkspace,
  checkout: Checkout | null,
  repositoryKey: string | null,
): Promise<string> {
  const names = brand.storage.configFileNames;
  const root = checkout ? rootOf(workspace, checkout, repositoryKey) : null;
  if (checkout === null || root === null)
    return activeProjectConfigFile([], names);
  const present = await Promise.all(
    names.map(async (name): Promise<string | null> => {
      const absolutePath = joinRoot(root.absolutePath, name);
      if (!absolutePath || !pathInsideRoot(absolutePath, root.absolutePath))
        return null;
      // A file that can't be read counts as absent, as the runtime's
      // `access` check does.
      return window.api
        .readFileContent({
          absolutePath,
          workspaceTarget: {
            projectId: workspace.id,
            worktreeId: checkout.worktree.id,
          },
        })
        .then(
          (file) => (file.kind === 'missing' ? null : name),
          (): null => null,
        );
    }),
  );
  return activeProjectConfigFile(
    present.filter((name): name is string => name !== null),
    names,
  );
}

async function readTarget(
  workspace: CodeWorkspace,
  target: Target,
  files: { readonly repository: string; readonly project: string },
  /**
   * The checkout the config file names were read from. Scripts and hooks are
   * read from the same one, so a row's source and Edit in repo name the file
   * that holds it.
   */
  worktreeId: string | null,
): Promise<{
  readonly repository: ProjectLocalRepository;
  readonly scripts: ProjectLocalRow[];
  readonly hooks: ProjectLocalRow[];
}> {
  const scope =
    worktreeId === null ? target.scripts : { ...target.scripts, worktreeId };
  const [definitions, hooks, url] = await Promise.all([
    query('core.script.definition.list', { target: scope }).then(
      (value): readonly CoreScriptDefinition[] =>
        CoreScriptDefinitionListResultSchema.parse(value).definitions,
    ),
    query('core.initiatedWork.source.list', {
      sourceKind: 'hook',
      target: scope,
    }).then(
      (value): readonly CoreHookSource[] =>
        CoreInitiatedWorkSourceListResultSchema.parse(value).sources,
    ),
    remoteUrl(workspace.id, target.remote),
  ]);
  const hasCheckout =
    workspace.worktrees.length > 0 &&
    (workspace.type === 'single-repo' || target.rootRepoId !== null);
  return {
    repository: {
      ...target.repository,
      configFile: files.repository,
      edit: projectLocalEditTarget(url, hasCheckout, files.repository),
    },
    scripts: projectLocalScriptRows(
      definitions,
      target.rowKey,
      files,
      getScriptDisplayName,
    ),
    hooks: projectLocalHookRows(
      hooks,
      target.rowKey,
      files,
      getHookTriggerDisplayName,
    ),
  };
}

/** The worktree a local config file opens in: the one used last. */
function latestWorktree(workspace: CodeWorkspace): WorktreeData | null {
  let latest: WorktreeData | null = null;
  for (const worktree of workspace.worktrees) {
    const touched = worktree.lastTouchedAt ?? worktree.createdAt;
    const best = latest ? (latest.lastTouchedAt ?? latest.createdAt) : '';
    if (latest === null || touched > best) latest = worktree;
  }
  return latest;
}

async function openLocalConfigFile(
  workspace: CodeWorkspace,
  repository: ProjectLocalRepository,
): Promise<void> {
  const checkout = await checkoutOf(workspace);
  if (checkout === null) throw new Error('No worktree to open it in');
  const target = { projectId: workspace.id, worktreeId: checkout.worktree.id };
  const root = rootOf(workspace, checkout, repository.key);
  const absolutePath = root
    ? joinRoot(root.absolutePath, repository.configFile)
    : null;
  if (
    !root ||
    !absolutePath ||
    !pathInsideRoot(absolutePath, root.absolutePath)
  )
    throw new Error('No checkout to open it in');
  // The file opens in its worktree's tabs; go there first, as the Feed's
  // file links do, or the tab would open out of sight.
  const chatStore = useChatStore.getState();
  useNavigationStore.getState().navigate('main');
  chatStore.selectWorktree(target.projectId, target.worktreeId);
  await chatStore.loadTabsForTarget(target.projectId, target.worktreeId);
  const tabId = chatStore.openFileTab(
    { absolutePath, filename: repository.configFile },
    target,
  );
  if (tabId === null) throw new Error('The file could not be opened');
  chatStore.switchTab(tabId, target);
}

/**
 * What a read depends on: a new port (and so a new read) only when one of
 * these changes, not on every sidebar update.
 */
export function projectLocalSetupKey(workspace: CodeWorkspace): string {
  return JSON.stringify([
    workspace.id,
    workspace.type,
    workspace.worktrees.length > 0,
    workspace.type === 'multi-repo'
      ? [
          workspace.sourceRepoPath ?? null,
          workspace.repos.map((repo) => [repo.id, repo.name]),
        ]
      : workspace.name,
  ]);
}

/**
 * The Shared setup panel's port for one local project, read through
 * `getWorkspace` at each call so a port outlives sidebar updates.
 * `onOpened` runs once a local config file opened in its worktree, so
 * project settings can close over it.
 */
export function createDesktopProjectLocalSetup(
  getWorkspace: () => CodeWorkspace | null,
  onOpened: () => void,
): ProjectLocalSetupPort {
  return {
    read: async (): Promise<ProjectLocalSetup | null> => {
      const workspace = getWorkspace();
      if (workspace === null) return null;
      const targets = targetsOf(workspace);
      // Without a readable checkout every repository uses the primary name.
      const checkout = await checkoutOf(workspace).then(
        (found) => found,
        (): null => null,
      );
      const files = await Promise.all(
        targets.map((target) =>
          configFileOf(workspace, checkout, target.rootRepoId),
        ),
      );
      // A multi-repository project's own file is its root's (the first
      // target); a single repository's is its own.
      const projectFile =
        files[0] ?? activeProjectConfigFile([], brand.storage.configFileNames);
      const read = await Promise.all(
        targets.map((target, index) =>
          readTarget(
            workspace,
            target,
            {
              repository: files[index] ?? projectFile,
              project: projectFile,
            },
            checkout?.worktree.id ?? null,
          ),
        ),
      );
      return {
        repositories: read.map((entry) => entry.repository),
        scripts: read.flatMap((entry) => entry.scripts),
        hooks: read.flatMap((entry) => entry.hooks),
      };
    },
    editInRepository: async (repository): Promise<void> => {
      if (repository.edit === null) return;
      if (repository.edit.kind === 'web') {
        await window.api.browser.openExternal({ url: repository.edit.url });
        return;
      }
      const workspace = getWorkspace();
      if (workspace === null) throw new Error('The project is not here');
      await openLocalConfigFile(workspace, repository);
      onOpened();
    },
  };
}

/** This computer's checkout of an organization project, if it has one. */
function localOrganizationProject(
  organizationId: string,
  projectId: string,
): CodeWorkspace | null {
  for (const item of useProjectsStore.getState().projects) {
    if (item.type === 'cowork') continue;
    if (
      item.owner?.organizationId === organizationId &&
      item.owner.projectId === projectId
    )
      return item;
  }
  return null;
}

/**
 * The organization Settings project editor's ports (CAN-6239): each reads the
 * project's checkout on this computer, or answers that it has none. One port
 * per project, so the editor does not read again on every render; opening a
 * local config file closes Settings.
 */
export function createDesktopProjectLocalSetupSlot(): (
  organizationId: string,
  projectId: string,
) => ProjectLocalSetupPort {
  const ports = new Map<string, ProjectLocalSetupPort>();
  return (organizationId, projectId) => {
    const key = `${organizationId}\n${projectId}`;
    const existing = ports.get(key);
    if (existing) return existing;
    const port = createDesktopProjectLocalSetup(
      () => localOrganizationProject(organizationId, projectId),
      () => useNavigationStore.getState().closeSettings(),
    );
    ports.set(key, port);
    return port;
  };
}
