import { assertWorkingDirectoryAvailable } from '@canopy/desktop-shared/node/lib/working-directory';
import { isWorktreeReadAvailable } from '../lib/worktree-read-availability';
import { subscribeWorkspaceTargetRemoval } from '../lib/workspace-target-exclusion';
import { basename } from 'node:path';
import {
  IPC_CHANNELS,
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type ChatTabPluginSelections,
  type FileIndexResponse,
  type HomeBranchTargetsRequest,
  type HomeBranchTargetsResponse,
  type HomeDiscoverEnvironmentRequest,
  type HomeDiscoverEnvironmentResponse,
  type ConfigurationComposerAdvisorEnvironmentRequest,
  type ConfigurationComposerAdvisorEnvironmentResponse,
  type HomeDiscoveryTarget,
  type HomeFileIndexRequest,
  type HomeGetCoworkRootRequest,
  type RepoFileIndex,
  type WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import type { FileGlobMatcher } from '../lib/file-glob-matcher';
import { getRemoteUrlStrict, isGitRepo } from '../lib/git';
import { resolveHomeBranchRepoPath } from '../lib/home-branch-repo';
import { buildFileGlobMatcher } from '../lib/file-glob-matcher';
import { buildFileIndex } from '../lib/file-system-listing';
import { getCoworkWorkspaceRootDir } from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import { chatSurfaceUsesGlobalPluginDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { getInheritedPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';
import { ensureRepoShadow } from '../lib/repo-shadow';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { ensureAppAdvisorHomeScaffold } from '../lib/app-advisor-workspace';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { buildFileIndexes } from '../services/files-service';
import { listHomeBranchTargets } from '../canopy-runtime/worker-git-dispatch';
import type { DaemonGitRoute } from '../canopy-runtime/daemon-git-route';
import type { WorkerGitDispatcher } from '../canopy-runtime/worker-git-adapter';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';
import { runProviderDiscovery } from './worktree-discovery';

const HOME_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const discoveryCache = new Map<
  string,
  { at: number; discovery: WorktreeDiscovery }
>();

function discoveryPluginSelectionsCacheKey(
  selections: ChatTabPluginSelections | undefined,
): string {
  return selections ? JSON.stringify(selections) : 'default';
}

function sweepExpiredDiscoveryCache(now: number): void {
  discoveryCache.forEach((entry, key) => {
    if (now - entry.at >= HOME_DISCOVERY_CACHE_TTL_MS) {
      discoveryCache.delete(key);
    }
  });
}

/**
 * True when `repoId` scopes a multi-repo target to a child repo rather than
 * the workspace root (`undefined` and the `WORKSPACE_ROOT_REPO_ID` sentinel
 * both mean "project root").
 */
function isChildRepoScope(repoId: string | undefined): repoId is string {
  return repoId !== undefined && repoId !== WORKSPACE_ROOT_REPO_ID;
}

/**
 * Resolves a baseline target's child-repo scope to that repo's local repo
 * path, or `null` when the workspace has no such child repo.
 */
async function resolveBaselineChildRepoPath(
  workspaceId: string,
  repoId: string,
): Promise<string | null> {
  const config = await readWorkspaceConfig(workspaceId);
  if (config.type !== 'multi-repo') {
    return null;
  }
  const repo = config.repos.find((candidate) => candidate.id === repoId);
  return repo ? repo.repoPath : null;
}

async function resolveLocalOnlyBaselinePath(
  repoPath: string,
): Promise<string | null> {
  const canonicalRepoPath = await resolveWorkspaceReferenceRepoPath(repoPath);
  let remoteUrl: string | null;
  try {
    remoteUrl = await getRemoteUrlStrict(canonicalRepoPath);
  } catch (error) {
    if (!(await isGitRepo(canonicalRepoPath))) {
      return null;
    }
    throw error;
  }
  if (remoteUrl !== null || !(await isGitRepo(canonicalRepoPath))) {
    return null;
  }
  return canonicalRepoPath;
}

/**
 * Resolve the working directory a Home-surface discovery should run in.
 *
 * - `worktree` targets resolve to the worktree checkout (optionally scoped to
 *   a child repo). Unlike the worktree discovery handler, this path has no
 *   App Advisor special case — Home targets are always real workspaces.
 * - `cowork` targets resolve to the cowork root (attached external folder or
 *   managed home).
 * - `baseline` targets resolve to the workspace's repo shadow checkout — the
 *   source repo's shadow for the workspace-root scope, or the selected child
 *   repo's own shadow when `target.repoId` names one. Local-only repositories
 *   without an origin use their canonical live checkout because they have no
 *   remote default branch to mirror. Returns `null` when the scope has no
 *   canonical repo (non-source multi-repo root, unknown child).
 */
export async function resolveHomeDiscoveryCwd(
  workspaceId: string,
  target: HomeDiscoveryTarget,
): Promise<string | null> {
  if (target.kind === 'worktree') {
    return resolveWorktreeCwd(workspaceId, target.worktreeId, target.repoId);
  }
  if (target.kind === 'cowork') {
    return getCoworkWorkspaceRootDir(workspaceId);
  }
  const repoPath = isChildRepoScope(target.repoId)
    ? await resolveBaselineChildRepoPath(workspaceId, target.repoId)
    : await resolveHomeBranchRepoPath(workspaceId);
  if (!repoPath) {
    return null;
  }
  const localOnlyPath = await resolveLocalOnlyBaselinePath(repoPath);
  if (localOnlyPath) {
    return localOnlyPath;
  }
  const shadow = await ensureRepoShadow(repoPath);
  return shadow.shadowPath;
}

const HOME_DISCOVERY_WORKTREE_ID = '__home__';

export async function handleHomeDiscoverEnvironment(
  request: HomeDiscoverEnvironmentRequest,
): Promise<HomeDiscoverEnvironmentResponse> {
  validateId(request.workspaceId, 'workspaceId');
  if (request.target.kind === 'worktree') {
    validateId(request.target.worktreeId, 'worktreeId');
  }
  if (request.target.kind !== 'cowork') {
    validateOptionalRepoId(request.target.repoId, 'repoId');
  }
  const cwd = await resolveHomeDiscoveryCwd(
    request.workspaceId,
    request.target,
  );
  if (!cwd) {
    return { discovery: null };
  }
  const target = request.target;
  const canDiscover = async (): Promise<boolean> => {
    if (target.kind === 'worktree')
      return isWorktreeReadAvailable(
        request.workspaceId,
        target.worktreeId,
        cwd,
      );
    try {
      await assertWorkingDirectoryAvailable(cwd);
      return true;
    } catch {
      return false;
    }
  };
  // Refusals must neither read nor populate the discovery cache.
  if (!(await canDiscover())) return { discovery: null };
  const providerType = request.providerType ?? 'claude';
  // The result depends on the inherited default-plugin layers (global and
  // this workspace's defaults), so the cache key includes their revision — a
  // defaults change invalidates cached discovery immediately instead of
  // serving stale results for the TTL.
  const cacheKey = `${cwd}::${providerType}::${discoveryPluginSelectionsCacheKey(
    request.pluginSelections,
  )}::d${String(
    getInheritedPluginDefaultsRevision({
      projectId: request.workspaceId,
      worktreeId: HOME_DISCOVERY_WORKTREE_ID,
    }),
  )}`;
  // A forced request skips the cache read entirely and re-runs discovery,
  // then overwrites the stale entry below.
  if (!request.force) {
    const cached = discoveryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < HOME_DISCOVERY_CACHE_TTL_MS) {
      return { discovery: cached.discovery };
    }
  }
  const ac = new AbortController();
  const unsubscribe =
    target.kind === 'worktree'
      ? subscribeWorkspaceTargetRemoval((projectId, worktreeId) => {
          if (
            projectId === request.workspaceId &&
            worktreeId === target.worktreeId
          )
            ac.abort();
        })
      : (): void => {};
  const discovery = await runProviderDiscovery({
    cwd,
    providerType,
    projectId: request.workspaceId,
    worktreeId: HOME_DISCOVERY_WORKTREE_ID,
    chatId: '__home_discovery__',
    pluginSelections: request.pluginSelections,
    // workspaceId is always a real workspace here (Home composes ordinary
    // worktree/cowork chats), but route through the shared predicate anyway
    // so this site can never drift from session eligibility.
    applyGlobalDefaults: chatSurfaceUsesGlobalPluginDefaults(
      request.workspaceId,
    ),
    // The draft is seeded from the workspace defaults; one the user unchecked
    // stays off, as it does for the chat the draft creates.
    draftPluginSelections: true,
    strictEmptyMcpConfig: request.target.kind === 'baseline',
    safeProjectDiscovery: request.target.kind === 'baseline',
    signal: ac.signal,
    canDiscover,
  }).finally(unsubscribe);
  if (!discovery || ac.signal.aborted || !(await canDiscover()))
    return { discovery: null };
  const discoveredAt = Date.now();
  // Revisioned keys prevent stale reads after a global-defaults edit. Sweep
  // expired generations on every write so those revisions cannot turn this
  // process-lifetime cache into an unbounded accumulator.
  sweepExpiredDiscoveryCache(discoveredAt);
  discoveryCache.set(cacheKey, { at: discoveredAt, discovery });
  return { discovery };
}

function handleGetCoworkRoot(request: HomeGetCoworkRootRequest): string {
  validateId(request.workspaceId, 'workspaceId');
  return getCoworkWorkspaceRootDir(request.workspaceId);
}

const HOME_FILE_INDEX_CACHE_TTL_MS = 60 * 1000;
/**
 * Per-baseline-checkout file listings, keyed by shadow or canonical local path
 * so an entry is REUSED by every workspace that references the same repo
 * (single-repo workspace, multi-repo child, source root). Entries cache only
 * the `files` array; the
 * `RepoFileIndex` wrapper (repoId/repoName/rootKind) is workspace-relative
 * and rebuilt per request.
 */
const baselineFileIndexCache = new Map<
  string,
  { at: number; files: RepoFileIndex['files'] }
>();

async function buildCoworkFileIndex(
  workspaceId: string,
): Promise<FileIndexResponse> {
  const root = getCoworkWorkspaceRootDir(workspaceId);
  const preferences = await readPreferencesFile();
  const globMatcher = buildFileGlobMatcher(preferences.fileIndexing);
  const files = await buildFileIndex(root, { gitAware: false, globMatcher });
  return {
    repos: [
      {
        repoId: 'cowork',
        repoName: basename(root),
        absolutePath: root,
        rootKind: 'standalone',
        files,
      },
    ],
  };
}

/**
 * One repo whose default-branch shadow (or live local-only checkout) should
 * contribute a `RepoFileIndex` entry to a baseline file index. `repoName`
 * defaults to the canonical repo directory basename when unset (the
 * single-repo convention).
 */
interface BaselineIndexSource {
  repoId: string;
  repoName?: string;
  rootKind: 'git-repo' | 'workspace-root';
  repoPath: string;
}

/**
 * Maps a workspace + working-directory scope to the shadow/local-backed index
 * sources the baseline file index is built from:
 *
 * - single-repo: the repo itself (legacy `baseline` repoId).
 * - multi-repo, workspace-root scope: the source repo's shadow as the
 *   `workspace-root` entry (when source-backed) plus EVERY child repo's own
 *   shadow — separate index sources per repo, mirroring the multi-root shape
 *   `getFileBrowserRoots` produces for a real worktree (same repo ids, so
 *   `getCwdFromFileIndex` selection works identically against both).
 * - multi-repo, child scope: just that child repo's shadow.
 */
async function resolveBaselineIndexSources(
  workspaceId: string,
  repoId: string | undefined,
): Promise<BaselineIndexSource[]> {
  const config = await readWorkspaceConfig(workspaceId);
  if (config.type === 'single-repo') {
    return config.repoPath
      ? [
          {
            repoId: 'baseline',
            rootKind: 'git-repo',
            repoPath: config.repoPath,
          },
        ]
      : [];
  }
  if (config.type !== 'multi-repo') {
    return [];
  }
  if (isChildRepoScope(repoId)) {
    const repo = config.repos.find((candidate) => candidate.id === repoId);
    return repo
      ? [
          {
            repoId: repo.id,
            repoName: repo.name,
            rootKind: 'git-repo',
            repoPath: repo.repoPath,
          },
        ]
      : [];
  }
  return [
    ...(config.sourceRepoPath
      ? [
          {
            repoId: WORKSPACE_ROOT_REPO_ID,
            repoName: WORKSPACE_ROOT_REPO_NAME,
            rootKind: 'workspace-root' as const,
            repoPath: config.sourceRepoPath,
          },
        ]
      : []),
    ...config.repos.map(
      (repo): BaselineIndexSource => ({
        repoId: repo.id,
        repoName: repo.name,
        rootKind: 'git-repo',
        repoPath: repo.repoPath,
      }),
    ),
  ];
}

/**
 * Builds (or serves from the baseline-path-keyed cache) one source's
 * `RepoFileIndex` entry. A local-only repository without an origin uses its
 * canonical live checkout because there is no remote default branch to mirror.
 * Other shadow failures degrade to a missing entry so one broken remote does
 * not fail the whole multi-root index.
 */
async function buildShadowRepoIndexEntry(
  source: BaselineIndexSource,
  globMatcher: FileGlobMatcher,
  force: boolean,
): Promise<RepoFileIndex | null> {
  let baselinePath: string;
  let canonicalRepoPath: string;
  try {
    const localOnlyPath = await resolveLocalOnlyBaselinePath(source.repoPath);
    if (localOnlyPath) {
      baselinePath = localOnlyPath;
      canonicalRepoPath = localOnlyPath;
    } else {
      const shadow = await ensureRepoShadow(source.repoPath);
      baselinePath = shadow.shadowPath;
      canonicalRepoPath = shadow.repoPath;
    }
  } catch {
    return null;
  }

  const cached = force ? undefined : baselineFileIndexCache.get(baselinePath);
  const files =
    cached && Date.now() - cached.at < HOME_FILE_INDEX_CACHE_TTL_MS
      ? cached.files
      : await buildFileIndex(baselinePath, {
          gitAware: true,
          globMatcher,
        });
  if (!cached || cached.files !== files) {
    baselineFileIndexCache.set(baselinePath, { at: Date.now(), files });
  }

  return {
    repoId: source.repoId,
    repoName: source.repoName ?? basename(canonicalRepoPath),
    absolutePath: baselinePath,
    rootKind: source.rootKind,
    files,
  };
}

/**
 * Builds the `baseline` target's file index over repo shadow checkouts.
 * Serves BOTH the `new-worktree` and non-checked-out `branch` targets (see
 * `resolveHomeDiscoveryTarget` in `homeComposerStore.ts`) — shadows always
 * mirror the default branch, so a named branch target's actual files may
 * differ from what this index reports. Accepted fallback: nothing has been
 * checked out for that branch yet, so the default-branch shadows are the
 * closest available approximation.
 *
 * Per-baseline-path listings are cached with a short TTL. A shadow's own
 * refresh cadence bounds its staleness; local-only checkouts use the same
 * short cache and `force` bypass convention as
 * `handleHomeDiscoverEnvironment`.
 */
async function buildBaselineFileIndex(
  workspaceId: string,
  repoId: string | undefined,
  force: boolean,
): Promise<FileIndexResponse> {
  const sources = await resolveBaselineIndexSources(workspaceId, repoId);
  if (sources.length === 0) {
    return { repos: [] };
  }

  const preferences = await readPreferencesFile();
  const globMatcher = buildFileGlobMatcher(preferences.fileIndexing);
  const entries = await Promise.all(
    sources.map((source) =>
      buildShadowRepoIndexEntry(source, globMatcher, force),
    ),
  );
  return {
    repos: entries.filter((entry): entry is RepoFileIndex => entry !== null),
  };
}

export async function handleHomeFileIndex(
  request: HomeFileIndexRequest,
): Promise<FileIndexResponse> {
  validateId(request.workspaceId, 'workspaceId');
  if (request.target.kind !== 'cowork') {
    validateOptionalRepoId(request.target.repoId, 'repoId');
  }
  if (request.target.kind === 'worktree') {
    validateId(request.target.worktreeId, 'worktreeId');
    const indexRequest = {
      projectId: request.workspaceId,
      worktreeId: request.target.worktreeId,
    };
    return isChildRepoScope(request.target.repoId)
      ? buildFileIndexes(indexRequest, { repoId: request.target.repoId })
      : buildFileIndexes(indexRequest);
  }
  if (request.target.kind === 'cowork') {
    return buildCoworkFileIndex(request.workspaceId);
  }
  return buildBaselineFileIndex(
    request.workspaceId,
    request.target.repoId,
    request.force === true,
  );
}

export async function handleConfigurationComposerAdvisorEnvironment(
  request: Omit<
    ConfigurationComposerAdvisorEnvironmentRequest,
    'providerType'
  > & {
    providerType?: unknown;
  },
): Promise<ConfigurationComposerAdvisorEnvironmentResponse> {
  if (
    !request ||
    (request.providerType !== undefined &&
      request.providerType !== 'claude' &&
      request.providerType !== 'codex')
  ) {
    throw new Error('Unsupported App Advisor discovery provider.');
  }
  await ensureAppAdvisorHomeScaffold();
  const cwd = resolveWorktreeCwd(
    APP_ADVISOR_PROJECT_ID,
    APP_ADVISOR_WORKTREE_ID,
  );
  const [discovery, index] = await Promise.all([
    request.providerType
      ? runProviderDiscovery({
          cwd,
          providerType: request.providerType,
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
          chatId: '__configuration_composer_discovery__',
          pluginSelections: request.pluginSelections,
          applyGlobalDefaults: chatSurfaceUsesGlobalPluginDefaults(
            APP_ADVISOR_PROJECT_ID,
          ),
          signal: new AbortController().signal,
        })
      : Promise.resolve(null),
    buildFileIndexes({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
    }),
  ]);
  return {
    discovery,
    repos: index.repos.filter((repo) => repo.rootKind !== 'attachments'),
  };
}

export function registerHomeSurfaceHandlers(runtime: {
  dispatcher: WorkerGitDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
  daemonGitRoute?: () => DaemonGitRoute;
}): void {
  registerIpcHandler<
    [ConfigurationComposerAdvisorEnvironmentRequest],
    ConfigurationComposerAdvisorEnvironmentResponse
  >(IPC_CHANNELS.configurationComposerAdvisorEnvironment, (_event, request) =>
    handleConfigurationComposerAdvisorEnvironment(request),
  );
  // ---- Branch targets (worker.git.branch.list) ----
  registerIpcHandler<[HomeBranchTargetsRequest], HomeBranchTargetsResponse>(
    IPC_CHANNELS.homeListBranchTargets,
    (event, request) =>
      listHomeBranchTargets(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
        runtime.daemonGitRoute
          ? { route: runtime.daemonGitRoute(), sender: event.sender }
          : undefined,
      ),
  );
  registerIpcHandler<
    [HomeDiscoverEnvironmentRequest],
    HomeDiscoverEnvironmentResponse
  >(IPC_CHANNELS.homeDiscoverEnvironment, (_event, request) =>
    handleHomeDiscoverEnvironment(request),
  );
  registerIpcHandler<[HomeGetCoworkRootRequest], string>(
    IPC_CHANNELS.homeGetCoworkRoot,
    (_event, request) => handleGetCoworkRoot(request),
  );
  registerIpcHandler<[HomeFileIndexRequest], FileIndexResponse>(
    IPC_CHANNELS.homeFileIndex,
    (_event, request) => handleHomeFileIndex(request),
  );
}
