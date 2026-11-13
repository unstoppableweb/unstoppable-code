import { normalizeRepositoryCloneUrl } from '@canopy/protocol/portal';
import { execFile } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { BRAND } from '@canopy/brand/current';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { PROJECT_COLORS } from '../../constants/project-colors';
import { getDefaultWorkspaceClaudeMd } from '../../constants/workspace-templates';
import { getGitExecutableCommand } from '../../lib/git-executable';
import type {
  MultiRepoSidebarItem,
  CoworkSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
  WorkspaceConfigFile,
  WorkspaceImportFromRepoResponse,
  WorkspaceIndexEntry,
  WorkspaceRepoData,
  WorktreeData,
} from '../../types';
import {
  getCanopyJsonPath,
  hasManifestRepos,
  readCanopyJson,
  writeCanopyJson,
} from './canopy-json';
import {
  writeFileAtomically,
  type AtomicFileStorage,
} from '@canopy/execution-engine/node/lib/atomic-file';
import { assertImportFolderExists } from './import-folder';
import { withStorageAdmission } from '@canopy/execution-engine/node/lib/storage-admission';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';
import {
  WORKSPACE_SOURCE_REPO_INITIAL_COMMIT_MESSAGE,
  ensureGitignoreContainsReposEntry,
  linkAgentsMdToClaudeMd,
  reserveWorkspaceSourceRepoPath,
  sanitizeWorkspaceSourceRepoName,
} from './workspace-source-repo';
import { settleAll } from './detached-work';
import {
  getWorkspaceDir,
  getWorkspacesRootDir,
  listWorkspaceItems,
  loadWorkspaceIndex,
  readWorkspaceIndex,
} from './workspace-cli-reads';

export {
  getWorkspaceItem,
  listWorkspaceItems,
  toWorkspaceCliRecord,
} from './workspace-cli-reads';

const execFileAsync = promisify(execFile);

// Shared W5 writers run in CLI commands and headless built-in actions.
const WORKSPACE_INDEX_STORAGE: AtomicFileStorage = {
  namespace: 'workspace_index',
  writer: 'desktop_cli',
};
const WORKSPACE_MANIFEST_STORAGE: AtomicFileStorage = {
  namespace: 'workspace_manifest',
  writer: 'desktop_cli',
};
const WORKTREE_LIST_STORAGE: AtomicFileStorage = {
  namespace: 'worktree_list',
  writer: 'desktop_cli',
};
/** Namespaces a Cowork project publishes; repository projects add the list. */
const COWORK_W5_STORAGE = [WORKSPACE_INDEX_STORAGE, WORKSPACE_MANIFEST_STORAGE];
const PROJECT_W5_STORAGE = [...COWORK_W5_STORAGE, WORKTREE_LIST_STORAGE];

interface WorkspaceIndexFile {
  version: 1;
  workspaces: WorkspaceIndexEntry[];
}

// Writer-side twins of ./workspace-cli-reads' private resolvers: the daemon
// writer boundary flags any import of a storage resolver name.
function getWorkspaceIndexFilePath(): string {
  return path.join(getWorkspacesRootDir(), 'index.json');
}

function getWorkspaceConfigPath(workspaceId: string): string {
  return path.join(getWorkspaceDir(workspaceId), 'workspace.json');
}

function getWorkspaceWorktreesFilePath(workspaceId: string): string {
  return path.join(getWorkspaceDir(workspaceId), 'worktrees.json');
}

function getNextSidebarColor(itemCount: number): string {
  return PROJECT_COLORS[itemCount % PROJECT_COLORS.length] ?? PROJECT_COLORS[0];
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Allocates an id unused by both the loaded items and the raw index: an index
 * entry whose config fails to load is not a loaded item, but it keeps its id
 * (CAN-3329).
 */
async function uniqueWorkspaceId(
  name: string,
  existing: SidebarItem[],
): Promise<string> {
  const base = slugify(name) || 'workspace';
  const existingIds = new Set([
    ...existing.map((item) => item.id),
    ...(await readWorkspaceIndex()).map((entry) => entry.id),
  ]);
  let candidate = base;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function toWorkspaceIndexEntry(item: SidebarItem): WorkspaceIndexEntry {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    color: item.color,
    collapsed: item.collapsed,
    order: item.order,
    ...(item.pinned === true ? { pinned: true } : {}),
    activitySectionOrder:
      item.type === 'cowork' ? undefined : item.activitySectionOrder,
  };
}

/**
 * Appends one entry to the persisted index. Builds on the raw index, not on
 * the loaded items, so a project whose config fails to load is kept; refuses
 * an unreadable index rather than replacing it (CAN-3329).
 */
async function appendWorkspaceIndexEntry(
  entry: WorkspaceIndexEntry,
): Promise<void> {
  const index = await loadWorkspaceIndex();
  if (index === null) {
    throw new Error(
      'The project list could not be read, so the project was not added',
    );
  }
  const { entries, completeRaw, partial } = index;
  if (partial) {
    throw new Error(
      'The project list could not be read completely, so the project was not added',
    );
  }
  if (entries.some((existing) => existing.id === entry.id)) {
    throw new Error(`A project with id ${entry.id} already exists`);
  }
  const payload: WorkspaceIndexFile = {
    version: 1,
    workspaces: [...entries, { ...entry, order: entries.length }],
  };
  const filePath = getWorkspaceIndexFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  // Same rolling backup as the desktop writer: only a fully readable index.
  if (completeRaw !== null) {
    await writeFileAtomically(`${filePath}.bak`, completeRaw, {
      encoding: 'utf8',
      storage: WORKSPACE_INDEX_STORAGE,
    });
  }
  await writeFileAtomically(filePath, JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    storage: WORKSPACE_INDEX_STORAGE,
  });
}

async function writeWorkspaceConfig(
  workspaceId: string,
  config: WorkspaceConfigFile,
): Promise<void> {
  const filePath = getWorkspaceConfigPath(workspaceId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, JSON.stringify(config, null, 2), {
    encoding: 'utf8',
    storage: WORKSPACE_MANIFEST_STORAGE,
  });
}

async function writeWorkspaceWorktrees(
  workspaceId: string,
  worktrees: WorktreeData[],
): Promise<void> {
  const filePath = getWorkspaceWorktreesFilePath(workspaceId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(
    filePath,
    JSON.stringify({ version: 1, worktrees }, null, 2),
    { encoding: 'utf8', storage: WORKTREE_LIST_STORAGE },
  );
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(
    getGitExecutableCommand(process.env),
    args,
    {
      cwd,
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: process.platform === 'win32',
    },
  );
  return stdout.trim();
}

async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    return await runGit(['remote', 'get-url', 'origin'], repoPath);
  } catch {
    return null;
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--git-dir'], dir);
    return true;
  } catch {
    return false;
  }
}

async function resolveRealPath(candidatePath: string): Promise<string> {
  return realpath(candidatePath).catch(() => path.resolve(candidatePath));
}

function collectWorkspaceRootPaths(items: SidebarItem[]): string[] {
  const rootPaths: string[] = [];

  for (const item of items) {
    if (item.type === 'single-repo') {
      rootPaths.push(item.repoPath);
      continue;
    }

    if (item.type === 'multi-repo') {
      if (item.sourceRepoPath) {
        rootPaths.push(item.sourceRepoPath);
      }
      for (const repo of item.repos) {
        rootPaths.push(repo.repoPath);
      }
      continue;
    }

    if (item.externalPath) {
      rootPaths.push(item.externalPath);
    }
  }

  return rootPaths;
}

/**
 * Guards importing a non-git folder as an external cowork workspace: rejects
 * folders that live inside the Canopy data directory, folders that
 * themselves contain the Canopy data directory, folders that are already
 * tracked verbatim by an existing workspace/repo, folders nested inside an
 * existing workspace's/repo's root path, and folders that themselves contain
 * an existing workspace's/repo's root path. The last two containment
 * directions matter because an agent operating inside a cowork workspace can
 * read/write anything nested under that workspace's root — so a folder that
 * contains the data dir or another workspace root would leak access to all
 * Canopy data or every git workspace nested under it. Comparisons use
 * resolved real paths so symlinked folders can't bypass the containment
 * checks. Mirrors the desktop app's `assertFolderIsImportable`
 * (apps/desktop-app/src/main/lib/workspace-service.ts).
 */
async function assertFolderIsImportable(
  resolvedFolderPath: string,
  items: SidebarItem[],
): Promise<void> {
  const resolvedDataDir = await resolveRealPath(getCanopyDataDir());
  if (
    resolvedFolderPath === resolvedDataDir ||
    isPathInside(resolvedDataDir, resolvedFolderPath)
  ) {
    throw new Error(
      `Cannot add a folder inside the app data directory: ${resolvedFolderPath}`,
    );
  }

  if (isPathInside(resolvedFolderPath, resolvedDataDir)) {
    throw new Error(
      `Cannot add a folder that contains the app data directory: ${resolvedFolderPath}`,
    );
  }

  const existingRootPaths = await settleAll(
    collectWorkspaceRootPaths(items).map((rootPath) =>
      resolveRealPath(rootPath),
    ),
  );

  for (const existingRootPath of existingRootPaths) {
    if (resolvedFolderPath === existingRootPath) {
      throw new Error(
        `This folder is already tracked as a project: ${resolvedFolderPath}`,
      );
    }

    if (isPathInside(existingRootPath, resolvedFolderPath)) {
      throw new Error(
        `Cannot add a folder nested inside an existing project: ${resolvedFolderPath}`,
      );
    }

    if (isPathInside(resolvedFolderPath, existingRootPath)) {
      throw new Error(
        `Cannot add a folder that contains an existing project: ${resolvedFolderPath}`,
      );
    }
  }
}

function repoNameFromPath(repoPath: string): string {
  return path.basename(repoPath.replace(/\/$/, '')) || 'Repository';
}

/**
 * Appends the index entry, then writes the manifest and worktree list.
 * `onIndexed` runs once the entry is published, so a caller can tell a
 * failure before publication from a later partial write.
 */
function persistWorkspace(
  item: SingleRepoSidebarItem | MultiRepoSidebarItem | CoworkSidebarItem,
  onIndexed?: () => void,
): Promise<SingleRepoSidebarItem | MultiRepoSidebarItem | CoworkSidebarItem> {
  return withStorageAdmission(
    item.type === 'cowork' ? COWORK_W5_STORAGE : PROJECT_W5_STORAGE,
    () => persistAdmittedWorkspace(item, onIndexed),
  );
}

async function persistAdmittedWorkspace(
  item: SingleRepoSidebarItem | MultiRepoSidebarItem | CoworkSidebarItem,
  onIndexed?: () => void,
): Promise<SingleRepoSidebarItem | MultiRepoSidebarItem | CoworkSidebarItem> {
  const indexEntryCount = (await readWorkspaceIndex()).length;
  const persisted:
    | SingleRepoSidebarItem
    | MultiRepoSidebarItem
    | CoworkSidebarItem = {
    ...item,
    order: indexEntryCount,
  };
  await appendWorkspaceIndexEntry(toWorkspaceIndexEntry(persisted));
  onIndexed?.();
  const config: WorkspaceConfigFile =
    persisted.type === 'single-repo'
      ? {
          version: 1,
          type: 'single-repo',
          repoPath: persisted.repoPath,
          repos: [],
          alwaysShow: persisted.alwaysShow,
        }
      : persisted.type === 'cowork'
        ? {
            version: 1,
            type: 'cowork',
            repos: [],
            externalPath: persisted.externalPath,
            alwaysShow: persisted.alwaysShow,
          }
        : {
            version: 1,
            type: 'multi-repo',
            repos: persisted.repos,
            sourceRepoPath: persisted.sourceRepoPath,
            suppressedRepoIds: persisted.suppressedRepoIds,
            alwaysShow: persisted.alwaysShow,
          };
  await writeWorkspaceConfig(persisted.id, config);
  if (persisted.type !== 'cowork') {
    await writeWorkspaceWorktrees(persisted.id, persisted.worktrees);
  }
  return persisted;
}

export async function importWorkspaceFromRepoPath(
  repoPath: string,
): Promise<SidebarItem> {
  await assertImportFolderExists(repoPath);
  const isRepo = await isGitRepo(repoPath);
  return withStorageAdmission(
    isRepo ? PROJECT_W5_STORAGE : COWORK_W5_STORAGE,
    () => importAdmittedWorkspace(repoPath, isRepo),
  );
}

async function importAdmittedWorkspace(
  repoPath: string,
  isRepo: boolean,
): Promise<SidebarItem> {
  if (!isRepo) {
    const resolvedFolderPath = await resolveRealPath(repoPath);
    const items = await listWorkspaceItems();
    await assertFolderIsImportable(resolvedFolderPath, items);
    const name = repoNameFromPath(resolvedFolderPath);
    return persistWorkspace({
      type: 'cowork',
      id: await uniqueWorkspaceId(name, items),
      name,
      color: getNextSidebarColor(items.length),
      collapsed: false,
      order: items.length,
      externalPath: resolvedFolderPath,
    });
  }

  const manifest = await readCanopyJson(repoPath);
  if (hasManifestRepos(manifest)) {
    const imported = await importMultiRepoWorkspaceManifestFromRepo(repoPath);
    return imported.workspace;
  }
  if (manifest === null) {
    await writeCanopyJson(repoPath, { version: 1 });
  }
  const items = await listWorkspaceItems();
  const name = repoNameFromPath(repoPath);
  return persistWorkspace({
    type: 'single-repo',
    id: await uniqueWorkspaceId(name, items),
    name,
    repoPath,
    color: getNextSidebarColor(items.length),
    worktrees: [],
    collapsed: false,
    order: items.length,
  });
}

export function addWorkspaceFromRemote(
  ...args: Parameters<typeof addAdmittedWorkspaceFromRemote>
): Promise<SidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    addAdmittedWorkspaceFromRemote(...args),
  );
}

async function addAdmittedWorkspaceFromRemote(
  remoteUrl: string,
  destinationDir: string,
): Promise<SidebarItem> {
  await mkdir(path.dirname(destinationDir), { recursive: true });
  await runGit([
    'clone',
    normalizeRepositoryCloneUrl(remoteUrl),
    destinationDir,
  ]);
  return importWorkspaceFromRepoPath(destinationDir);
}

export function createNewSingleRepoWorkspace(
  ...args: Parameters<typeof createAdmittedSingleRepoWorkspace>
): Promise<SidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    createAdmittedSingleRepoWorkspace(...args),
  );
}

async function createAdmittedSingleRepoWorkspace(
  name: string,
): Promise<SidebarItem> {
  const items = await listWorkspaceItems();
  const workspaceId = await uniqueWorkspaceId(name, items);
  const repoPath = path.join(getCanopyDataDir(), 'repos', workspaceId);
  await mkdir(repoPath, { recursive: true });
  await runGit(['init'], repoPath);
  await writeCanopyJson(repoPath, { version: 1 });
  await runGit(['add', path.basename(getCanopyJsonPath(repoPath))], repoPath);
  await runGit(
    [
      '-c',
      `user.name=${BRAND.displayName}`,
      '-c',
      `user.email=${BRAND.internalName}@example.invalid`,
      'commit',
      '-m',
      `Initialize ${BRAND.displayName} workspace`,
    ],
    repoPath,
  );
  return persistWorkspace({
    type: 'single-repo',
    id: workspaceId,
    name,
    repoPath,
    color: getNextSidebarColor(items.length),
    worktrees: [],
    collapsed: false,
    order: items.length,
  });
}

export async function createNewMultiRepoWorkspaceDraft(
  name: string,
): Promise<MultiRepoSidebarItem> {
  const items = await listWorkspaceItems();
  return {
    type: 'multi-repo',
    id: await uniqueWorkspaceId(name, items),
    name,
    color: getNextSidebarColor(items.length),
    repos: [],
    worktrees: [],
    collapsed: false,
    order: items.length,
  };
}

/**
 * Creates the project source repo the desktop creates for a new multi-repo
 * project (CAN-3799): `.gitignore` with `repos/`, an empty `canopy.json`, the
 * default `CLAUDE.md` with an `AGENTS.md` link, and one initial commit.
 */
async function initializeEmptyWorkspaceSourceRepo(
  workspaceName: string,
  claudeMd: string,
): Promise<string> {
  const sourceRepoPath = await reserveWorkspaceSourceRepoPath(
    path.join(getCanopyDataDir(), 'repos'),
    sanitizeWorkspaceSourceRepoName(workspaceName),
  );
  try {
    await runGit(['init'], sourceRepoPath);
    await ensureGitignoreContainsReposEntry(sourceRepoPath);
    await writeCanopyJson(sourceRepoPath, { version: 1, repos: [] });
    await writeFile(path.join(sourceRepoPath, 'CLAUDE.md'), claudeMd, 'utf8');
    await linkAgentsMdToClaudeMd(sourceRepoPath);
    await runGit(['add', '-A'], sourceRepoPath);
    await runGit(
      [
        '-c',
        `user.name=${BRAND.displayName}`,
        '-c',
        `user.email=${BRAND.internalName}@local.invalid`,
        'commit',
        '-m',
        WORKSPACE_SOURCE_REPO_INITIAL_COMMIT_MESSAGE,
      ],
      sourceRepoPath,
    );
  } catch (error) {
    await rm(sourceRepoPath, { recursive: true, force: true });
    throw error;
  }
  return sourceRepoPath;
}

export function createAndPersistNewMultiRepoWorkspace(
  name: string,
): Promise<MultiRepoSidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    createAndPersistAdmittedMultiRepoWorkspace(name),
  );
}

async function createAndPersistAdmittedMultiRepoWorkspace(
  name: string,
): Promise<MultiRepoSidebarItem> {
  const draft = await createNewMultiRepoWorkspaceDraft(name);
  const claudeMd = getDefaultWorkspaceClaudeMd(name.trim());
  const sourceRepoPath = await initializeEmptyWorkspaceSourceRepo(
    name,
    claudeMd,
  );
  let indexed = false;
  let persisted: SidebarItem;
  try {
    persisted = await persistWorkspace({ ...draft, sourceRepoPath }, () => {
      indexed = true;
    });
  } catch (error) {
    // Before the index entry is published, remove only the source repo this
    // call reserved: on an id race the workspace directory belongs to the
    // other writer. Once published, the entry references the repo, so keep it.
    if (!indexed) await rm(sourceRepoPath, { recursive: true, force: true });
    throw error;
  }
  if (persisted.type !== 'multi-repo') {
    throw new Error('Created project was not persisted as multi-repo');
  }
  await writeFile(
    path.join(getWorkspaceDir(persisted.id), 'CLAUDE.md'),
    claudeMd,
    'utf8',
  );
  return persisted;
}

export function importMultiRepoWorkspaceManifestFromRepo(
  ...args: Parameters<typeof importAdmittedWorkspaceManifest>
): Promise<WorkspaceImportFromRepoResponse> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    importAdmittedWorkspaceManifest(...args),
  );
}

async function importAdmittedWorkspaceManifest(
  repoPath: string,
): Promise<WorkspaceImportFromRepoResponse> {
  const manifest = await readCanopyJson(repoPath);
  if (!hasManifestRepos(manifest)) {
    throw new Error('Imported project repo must contain manifest repos');
  }
  const items = await listWorkspaceItems();
  const workspaceId = await uniqueWorkspaceId(
    repoNameFromPath(repoPath),
    items,
  );
  const clonedRepoIds: string[] = [];
  const repos: WorkspaceRepoData[] = [];
  const reposDir = path.join(getCanopyDataDir(), 'repos', workspaceId);

  for (const repo of manifest.repos) {
    const destination = path.join(reposDir, repo.id);
    await mkdir(path.dirname(destination), { recursive: true });
    await runGit(['clone', repo.url, destination]);
    clonedRepoIds.push(repo.id);
    repos.push({
      id: repo.id,
      name: repo.name,
      repoPath: destination,
      source: 'manifest',
      manifestUrl: repo.url,
      scripts: repo.scripts,
      hooks: repo.hooks,
    });
  }

  const workspace: MultiRepoSidebarItem = {
    type: 'multi-repo',
    id: workspaceId,
    name: repoNameFromPath(repoPath),
    color: getNextSidebarColor(items.length),
    repos,
    worktrees: [],
    collapsed: false,
    order: items.length,
    sourceRepoPath: repoPath,
  };
  const persisted = await persistWorkspace(workspace);
  if (persisted.type !== 'multi-repo') {
    throw new Error('Imported project was not persisted as multi-repo');
  }
  return { workspace: persisted, clonedRepoIds };
}

export const workspaceServiceTestExports = {
  getWorkspaceConfigPath,
  getWorkspaceWorktreesFilePath,
  getRemoteUrl,
};
