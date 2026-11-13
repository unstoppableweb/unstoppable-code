import type { W5CommitOptions } from './w5-commit-scope';
/**
 * Shared engine for adhoc multi-repo combine flows: repo identity
 * resolution, candidate resolution, destination-workspace resolution/reuse,
 * compatibility symlinks, pipeline-execution migration, and the
 * move/remove/rollback primitives.
 *
 * Consumers are the orchestration modules `adhoc-multi-repo-workspaces.ts`
 * (combine a worktree with other workspaces) and
 * `adhoc-existing-worktree-join.ts` (join an existing worktree). The export
 * surface is intentionally broad so both orchestrators can compose the same
 * primitives — do not fold exports back to private without checking both.
 */
import {
  lstat,
  mkdir,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type AdhocMultiRepoCombineResponse,
  type AdhocMultiRepoRepoMapping,
  type MultiRepoSidebarItem,
  type SidebarItem,
  type WorkspaceRepoData,
  type WorktreeCompatibilitySymlink,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { getActiveChatIds } from '../agents/session-manager';
import {
  discardLedgerMoveIntent,
  LEDGER_INTENT_REFUSING_WAIT_MS,
  notifyLedgerContainerMoved,
  recordLedgerMoveIntent,
} from '../ledger/lifecycle';
import { worktreeLedgerIncarnation } from '../ledger/lifecycle-containers';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { relocateExecutionCheckout } from '../pipelines/execution-checkout-location';
import {
  listExecutionSummaries,
  loadExecutionState,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { getDefaultWorkspaceClaudeMd } from '@canopy/desktop-shared/constants/workspace-templates';
import { listArchivedContainerManifests } from './archived-containers';
import {
  createWorktree,
  getCurrentBranch,
  getRemoteUrl,
  getWorktreeTopLevel,
  moveWorktree,
} from './git';
import { ensureAgentsMdSymlink } from './instruction-files';
import { scaffoldWorkspaceInstructions } from '@canopy/core-runtime/node/workspace/workspace-instructions';
import { normalizeRemoteUrl, remoteUrlsMatch } from './repo-url-matcher';
import {
  getWorktreeDir,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreesRootDir,
} from './paths';
import { pathExists } from './fs-utils';
import { safeRemoveWorktree } from './safe-remove-worktree';
import { listTrackedShellScriptsForWorktree } from './script-runner';
import { cleanupCompositionDestination } from './workspace-composition-records';
export {
  buildDestinationWorktree,
  mapTrackedRepoBaseBranches,
} from './workspace-composition-records';
import { slugify, uniqueId } from './string-utils';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from './workspace-persistence';
import {
  createTemporaryMultiRepoWorkspace,
  listWorkspaceItems,
} from './workspace-service';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

export type RepoIdentity =
  | { kind: 'remote'; remoteUrl: string; repoPath: string }
  | { kind: 'path'; repoPath: string };

export interface RepoCandidate {
  source: 'source' | 'join';
  sourceRepoId?: string;
  preferredRepoId: string;
  name: string;
  repoPath: string;
  manifestUrl?: string;
  oldWorktreePath?: string;
  identity: RepoIdentity;
}

export interface ResolvedDestination {
  workspace: MultiRepoSidebarItem;
  createdTemporaryWorkspace: boolean;
  reusedWorkspace: boolean;
}

export interface TemporaryWorkspaceReuseHints {
  repoIdentityKeys?: string[];
  sourceWorkspaceIds?: string[];
  commit?: W5CommitOptions;
}

// Compile-time exhaustiveness guard: fails to compile when WorktreeData gains a field, forcing buildDestinationWorktree to handle it.
const WORKTREE_FIELD_EXHAUSTIVENESS: Record<keyof WorktreeData, true> = {
  // Destination replicas are minted by its list writer, never copied from sources.
  replica: true,
  // A destination never inherits a source creation operation or its checkout paths.
  creation: true,
  id: true,
  branchName: true,
  createdAt: true,
  restoredFromFilesOnlyArchiveId: true,
  pinned: true,
  lastTouchedAt: true,
  pendingArchiveBranchDeletion: true,
  pendingArchiveBranchDeletions: true,
  discovery: true,
  branchPromptSent: true,
  status: true,
  label: true,
  labelSource: true,
  labelProvisional: true,
  hidden: true,
  pausedHookKeys: true,
  seenPipelineExecutionIds: true,
  healthIssue: true,
  lastKnownPrStatus: true,
  trackedBaseBranch: true,
  trackedRepoBaseBranches: true,
  branchGroupingOverride: true,
  branchGroupingParentWorktreeId: true,
  setupPhase: true,
  splitRecoveryRequired: true,
  compatibilitySymlinks: true,
  adhocTransitionSource: true,
  chatBadges: true,
  includedRepoIds: true,
};
void WORKTREE_FIELD_EXHAUSTIVENESS;

function normalizePathIdentity(repoPath: string): string {
  return resolve(repoPath);
}

export async function resolveRepoIdentity(
  repoPath: string,
  remoteUrlHint?: string,
): Promise<RepoIdentity> {
  const remoteUrl = remoteUrlHint?.trim() || (await getRemoteUrl(repoPath));
  if (remoteUrl) {
    return {
      kind: 'remote',
      remoteUrl,
      repoPath: normalizePathIdentity(repoPath),
    };
  }
  return { kind: 'path', repoPath: normalizePathIdentity(repoPath) };
}

export function repoIdentityKey(identity: RepoIdentity): string {
  if (identity.kind === 'remote') {
    const normalizedRemote = normalizeRemoteUrl(identity.remoteUrl);
    if (normalizedRemote) {
      return `remote:${normalizedRemote}`;
    }
  }
  return `path:${identity.repoPath}`;
}

export function identitiesMatch(
  left: RepoIdentity,
  right: RepoIdentity,
): boolean {
  if (left.kind === 'remote' && right.kind === 'remote') {
    return remoteUrlsMatch(left.remoteUrl, right.remoteUrl);
  }
  return left.repoPath === right.repoPath;
}

export function identitySetsMatch(
  left: RepoIdentity[],
  right: RepoIdentity[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftKeys = left.map(repoIdentityKey).sort();
  const rightKeys = right.map(repoIdentityKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

export async function resolveWorkspaceRepoIdentities(
  workspace: MultiRepoSidebarItem,
): Promise<RepoIdentity[]> {
  return settleAll(
    workspace.repos
      .filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
      .map((repo) => resolveRepoIdentity(repo.repoPath, repo.manifestUrl)),
  );
}

export async function resolveSidebarItemRepoIdentities(
  workspace: SidebarItem,
): Promise<RepoIdentity[]> {
  if (workspace.type === 'single-repo') {
    return [await resolveRepoIdentity(workspace.repoPath)];
  }
  if (workspace.type === 'cowork') {
    throw new Error('Cannot combine a cowork project as a git repo source.');
  }
  return resolveWorkspaceRepoIdentities(workspace);
}

export function findWorkspace(
  items: SidebarItem[],
  workspaceId: string,
): SidebarItem | null {
  return items.find((item) => item.id === workspaceId) ?? null;
}

export async function resolveSourceCandidates(
  workspace: SidebarItem,
  sourceWorktreeId: string,
  joinCandidates: RepoCandidate[],
): Promise<RepoCandidate[]> {
  if (workspace.type === 'single-repo') {
    const conflictingIds = new Set(
      joinCandidates.map((candidate) => candidate.preferredRepoId),
    );
    const preferredRepoId = /^[A-Za-z0-9_-]+$/.test(workspace.id)
      ? workspace.id
      : uniqueId(slugify(workspace.name) || 'repo', conflictingIds);
    return [
      {
        source: 'source',
        sourceRepoId: preferredRepoId,
        preferredRepoId,
        name: workspace.name,
        repoPath: workspace.repoPath,
        oldWorktreePath: getWorktreeDir(workspace.id, sourceWorktreeId),
        identity: await resolveRepoIdentity(workspace.repoPath),
      },
    ];
  }

  if (workspace.type === 'cowork') {
    throw new Error('Cannot combine a cowork project as a git repo source.');
  }

  return settleAll(
    workspace.repos
      .filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
      .map(async (repo) => ({
        source: 'source' as const,
        sourceRepoId: repo.id,
        preferredRepoId: repo.id,
        name: repo.name,
        repoPath: repo.repoPath,
        manifestUrl: repo.manifestUrl,
        oldWorktreePath: getWorkspaceWorktreeRepoDir(
          workspace.id,
          sourceWorktreeId,
          repo.id,
        ),
        identity: await resolveRepoIdentity(repo.repoPath, repo.manifestUrl),
      })),
  );
}

export async function resolveJoinCandidates(
  workspace: SidebarItem,
): Promise<RepoCandidate[]> {
  if (workspace.type === 'single-repo') {
    return [
      {
        source: 'join',
        preferredRepoId: workspace.id,
        name: workspace.name,
        repoPath: workspace.repoPath,
        identity: await resolveRepoIdentity(workspace.repoPath),
      },
    ];
  }

  if (workspace.type === 'cowork') {
    throw new Error('Cannot combine a cowork project as a git repo source.');
  }

  return settleAll(
    workspace.repos
      .filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
      .map(async (repo) => ({
        source: 'join' as const,
        preferredRepoId: repo.id,
        name: repo.name,
        repoPath: repo.repoPath,
        manifestUrl: repo.manifestUrl,
        identity: await resolveRepoIdentity(repo.repoPath, repo.manifestUrl),
      })),
  );
}

export async function resolveJoinCandidatesForWorkspaces(
  workspaces: SidebarItem[],
): Promise<RepoCandidate[]> {
  const candidateGroups = await settleAll(
    workspaces.map((workspace) => resolveJoinCandidates(workspace)),
  );
  return candidateGroups.flat();
}

export function dedupeCandidates(candidates: RepoCandidate[]): RepoCandidate[] {
  const result: RepoCandidate[] = [];
  for (const candidate of candidates) {
    if (
      result.some((existing) =>
        identitiesMatch(existing.identity, candidate.identity),
      )
    ) {
      continue;
    }
    result.push(candidate);
  }
  return result;
}

export function compareSidebarItems(
  left: SidebarItem,
  right: SidebarItem,
): number {
  if (left.order !== right.order) {
    return left.order - right.order;
  }
  return left.id.localeCompare(right.id);
}

export function normalizeWorkspaceIdSet(workspaceIds: string[]): string[] {
  return Array.from(new Set(workspaceIds)).sort();
}

export function normalizeRepoIdentityKeySet(
  repoIdentityKeys: string[],
): string[] {
  return Array.from(new Set(repoIdentityKeys)).sort();
}

export function workspaceIdSetsMatch(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  const leftIds = normalizeWorkspaceIdSet(left);
  const rightIds = normalizeWorkspaceIdSet(right);
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
  );
}

export function repoIdentityKeySetsMatch(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  const leftKeys = normalizeRepoIdentityKeySet(left);
  const rightKeys = normalizeRepoIdentityKeySet(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

export function filterNewJoinCandidates(
  sourceCandidates: RepoCandidate[],
  joinCandidates: RepoCandidate[],
): RepoCandidate[] {
  return joinCandidates.filter(
    (joinCandidate) =>
      !sourceCandidates.some((sourceCandidate) =>
        identitiesMatch(sourceCandidate.identity, joinCandidate.identity),
      ),
  );
}

export function workspaceAddsNewRepo(
  sourceIdentities: RepoIdentity[],
  joinIdentities: RepoIdentity[],
): boolean {
  return joinIdentities.some(
    (joinIdentity) =>
      !sourceIdentities.some((sourceIdentity) =>
        identitiesMatch(sourceIdentity, joinIdentity),
      ),
  );
}

export async function resolveDestinationWorkspace(
  items: SidebarItem[],
  candidates: RepoCandidate[],
  options: {
    repoPathsMustMatch?: boolean;
    reuseOwner?: SidebarItem['owner'];
    beforeEffects?: () => void;
    commit?: W5CommitOptions;
  } = {},
): Promise<ResolvedDestination> {
  const finalIdentities = candidates.map((candidate) => candidate.identity);
  const finalIdentityKeys = normalizeRepoIdentityKeySet(
    finalIdentities.map(repoIdentityKey),
  );
  const multiRepoItems = items.filter(
    (item): item is MultiRepoSidebarItem =>
      item.type === 'multi-repo' &&
      item.owner?.organizationId === options.reuseOwner?.organizationId,
  );

  for (const temporary of [false, true]) {
    for (const item of multiRepoItems) {
      if ((item.temporary === true) !== temporary) {
        continue;
      }
      if (
        temporary &&
        repoIdentityKeySetsMatch(
          item.temporaryRepoIdentityKeys,
          finalIdentityKeys,
        ) &&
        (!options.repoPathsMustMatch ||
          (await workspaceRepoPathsMatchCandidates(item, candidates)))
      ) {
        return {
          workspace: item,
          createdTemporaryWorkspace: false,
          reusedWorkspace: true,
        };
      }
      const identities = await resolveWorkspaceRepoIdentities(item);
      if (
        identitySetsMatch(finalIdentities, identities) &&
        (!options.repoPathsMustMatch ||
          (await workspaceRepoPathsMatchCandidates(item, candidates)))
      ) {
        return {
          workspace: item,
          createdTemporaryWorkspace: false,
          reusedWorkspace: true,
        };
      }
    }
  }

  const existingIds = new Set<string>();
  const repos: WorkspaceRepoData[] = candidates.map((candidate) => {
    const repoId = uniqueId(
      candidate.preferredRepoId || slugify(candidate.name) || 'repo',
      existingIds,
    );
    existingIds.add(repoId);
    return {
      id: repoId,
      name: candidate.name,
      repoPath: candidate.repoPath,
      manifestUrl: candidate.manifestUrl,
    };
  });
  options.beforeEffects?.();
  return {
    workspace: await createTemporaryMultiRepoWorkspace(repos, {
      repoIdentityKeys: finalIdentityKeys,
      commit: options.commit,
    }),
    createdTemporaryWorkspace: true,
    reusedWorkspace: false,
  };
}

async function workspaceRepoPathsMatchCandidates(
  workspace: MultiRepoSidebarItem,
  candidates: RepoCandidate[],
): Promise<boolean> {
  for (const candidate of candidates) {
    let matched = false;
    for (const repo of workspace.repos) {
      if (repo.repoPath !== candidate.repoPath) {
        continue;
      }
      const identity = await resolveRepoIdentity(
        repo.repoPath,
        repo.manifestUrl,
      );
      if (identitiesMatch(identity, candidate.identity)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return false;
    }
  }
  return true;
}

export async function resolveWorkspaceForTemporaryRepoSelection(
  items: SidebarItem[],
  candidates: RepoCandidate[],
  reuseHints: TemporaryWorkspaceReuseHints = {},
): Promise<{
  workspace: SidebarItem;
  createdTemporaryWorkspace: boolean;
  reusedWorkspace: boolean;
}> {
  const finalIdentities = candidates.map((candidate) => candidate.identity);
  const finalIdentityKeys =
    reuseHints.repoIdentityKeys ??
    normalizeRepoIdentityKeySet(finalIdentities.map(repoIdentityKey));

  if (candidates.length === 1) {
    for (const item of items) {
      if (item.type !== 'single-repo') {
        continue;
      }
      const identities = await resolveSidebarItemRepoIdentities(item);
      if (identitySetsMatch(finalIdentities, identities)) {
        return {
          workspace: item,
          createdTemporaryWorkspace: false,
          reusedWorkspace: true,
        };
      }
    }
  }

  const multiRepoItems = items.filter(
    (item): item is MultiRepoSidebarItem => item.type === 'multi-repo',
  );
  for (const temporary of [false, true]) {
    for (const item of multiRepoItems) {
      if ((item.temporary === true) !== temporary) {
        continue;
      }
      if (
        temporary &&
        repoIdentityKeySetsMatch(
          item.temporaryRepoIdentityKeys,
          finalIdentityKeys,
        )
      ) {
        return {
          workspace: item,
          createdTemporaryWorkspace: false,
          reusedWorkspace: true,
        };
      }
      if (
        temporary &&
        workspaceIdSetsMatch(
          item.temporarySourceWorkspaceIds,
          reuseHints.sourceWorkspaceIds,
        )
      ) {
        return {
          workspace: item,
          createdTemporaryWorkspace: false,
          reusedWorkspace: true,
        };
      }
      const identities = await resolveWorkspaceRepoIdentities(item);
      if (identitySetsMatch(finalIdentities, identities)) {
        return {
          workspace: item,
          createdTemporaryWorkspace: false,
          reusedWorkspace: true,
        };
      }
    }
  }

  const existingIds = new Set<string>();
  const repos: WorkspaceRepoData[] = candidates.map((candidate) => {
    const repoId = uniqueId(
      candidate.preferredRepoId || slugify(candidate.name) || 'repo',
      existingIds,
    );
    existingIds.add(repoId);
    return {
      id: repoId,
      name: candidate.name,
      repoPath: candidate.repoPath,
      manifestUrl: candidate.manifestUrl,
    };
  });
  return {
    workspace: reuseHints.sourceWorkspaceIds
      ? await createTemporaryMultiRepoWorkspace(repos, {
          repoIdentityKeys: finalIdentityKeys,
          sourceWorkspaceIds: reuseHints.sourceWorkspaceIds,
          commit: reuseHints.commit,
        })
      : await createTemporaryMultiRepoWorkspace(repos, {
          repoIdentityKeys: finalIdentityKeys,
          commit: reuseHints.commit,
        }),
    createdTemporaryWorkspace: true,
    reusedWorkspace: false,
  };
}

export async function mapCandidatesToDestinationRepos(
  candidates: RepoCandidate[],
  destinationWorkspace: MultiRepoSidebarItem,
): Promise<Array<{ candidate: RepoCandidate; repo: WorkspaceRepoData }>> {
  const identities = await settleAll(
    destinationWorkspace.repos.map(async (repo) => ({
      repo,
      identity: await resolveRepoIdentity(repo.repoPath, repo.manifestUrl),
    })),
  );
  return candidates.map((candidate) => {
    const match = identities.find((entry) =>
      identitiesMatch(entry.identity, candidate.identity),
    );
    if (!match) {
      throw new Error(
        `Destination project is missing repo "${candidate.name}"`,
      );
    }
    return { candidate, repo: match.repo };
  });
}

export async function listCompatibilitySymlinkReservedWorktreeIds(
  workspaceId: string,
): Promise<Set<string>> {
  const rootDir = getWorkspaceWorktreesRootDir(workspaceId);
  const reserved = new Set<string>();
  const worktrees = await readWorkspaceWorktrees(workspaceId).catch(() => []);
  for (const worktree of worktrees) {
    for (const link of worktree.compatibilitySymlinks ?? []) {
      if (dirname(link.path) === rootDir) {
        reserved.add(basename(link.path));
      }
    }
  }
  return reserved;
}

export async function allocateAdhocDestinationWorktreeId(
  destinationWorkspaceId: string,
  preferredId: string,
  additionalReservedIds: ReadonlySet<string> = new Set<string>(),
): Promise<string> {
  const reserved = new Set(additionalReservedIds);
  const compatibilityReserved =
    await listCompatibilitySymlinkReservedWorktreeIds(destinationWorkspaceId);
  compatibilityReserved.forEach((id) => reserved.add(id));
  const worktrees = await readWorkspaceWorktrees(destinationWorkspaceId);
  for (const worktree of worktrees) {
    reserved.add(worktree.id);
  }
  const archivedContainers = await listArchivedContainerManifests(
    destinationWorkspaceId,
  );
  for (const manifest of archivedContainers) {
    reserved.add(manifest.id);
  }
  try {
    const entries = await readdir(
      getWorkspaceWorktreesRootDir(destinationWorkspaceId),
      {
        withFileTypes: true,
      },
    );
    for (const entry of entries) {
      reserved.add(entry.name);
    }
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
    // No worktree root yet.
  }
  return uniqueId(preferredId, reserved);
}

export async function replacePathWithCompatibilitySymlink(
  oldPath: string,
  newTargetPath: string,
  params: {
    sourceWorkspaceId: string;
    sourceWorktreeId: string;
    repoId?: string;
  },
  platform: NodeJS.Platform = process.platform,
): Promise<WorktreeCompatibilitySymlink> {
  if (!(await pathExists(newTargetPath))) {
    throw new Error(
      `Cannot create compatibility symlink: ${newTargetPath} is missing`,
    );
  }

  const existing = await lstat(oldPath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    const currentTarget = await readlink(oldPath);
    const resolvedTarget = resolve(dirname(oldPath), currentTarget);
    if (resolvedTarget === resolve(newTargetPath)) {
      return buildCompatibilitySymlink(oldPath, newTargetPath, params);
    }
    throw new Error(`Cannot replace existing symlink at ${oldPath}`);
  }
  if (existing) {
    throw new Error(`Cannot replace existing path at ${oldPath}`);
  }

  await mkdir(dirname(oldPath), { recursive: true });
  const target = relative(dirname(oldPath), newTargetPath) || '.';
  if (platform === 'win32') {
    await symlink(resolve(newTargetPath), oldPath, 'junction');
  } else {
    await symlink(target, oldPath);
  }
  return buildCompatibilitySymlink(oldPath, newTargetPath, params);
}

function buildCompatibilitySymlink(
  oldPath: string,
  newTargetPath: string,
  params: {
    sourceWorkspaceId: string;
    sourceWorktreeId: string;
    repoId?: string;
  },
): WorktreeCompatibilitySymlink {
  return {
    path: resolve(oldPath),
    targetPath: resolve(newTargetPath),
    reason: 'adhoc-multi-repo-transition',
    sourceWorkspaceId: params.sourceWorkspaceId,
    sourceWorktreeId: params.sourceWorktreeId,
    repoId: params.repoId,
    createdAt: new Date().toISOString(),
  };
}

export async function assertNoActiveWorktreeWork(
  workspaceId: string,
  worktreeId: string,
  messages: {
    activeChats: string;
    runningScripts: string;
    runningPipelines: string;
    blockedPipelineStatuses?: ReadonlySet<ExecutionSummary['status']>;
  },
): Promise<void> {
  if (getActiveChatIds(workspaceId, worktreeId).length > 0) {
    throw new Error(messages.activeChats);
  }
  // Scripts (including automatic setup) keep writing to the checkout's
  // original absolute path after it moves.
  if (
    listTrackedShellScriptsForWorktree({ projectId: workspaceId, worktreeId })
      .length > 0
  ) {
    throw new Error(messages.runningScripts);
  }
  const summaries = await listExecutionSummaries(
    createElectronExecutionRuntime().executionsDir,
  );
  const blockedPipelineStatuses =
    messages.blockedPipelineStatuses ??
    new Set<ExecutionSummary['status']>(['running']);
  if (
    summaries.some(
      (summary) =>
        summary.project_id === workspaceId &&
        summary.worktree_id === worktreeId &&
        blockedPipelineStatuses.has(summary.status),
    )
  ) {
    throw new Error(messages.runningPipelines);
  }
}

async function canonicalPathForComparison(filePath: string): Promise<string> {
  return resolve(await realpath(filePath).catch(() => filePath));
}

export interface CheckoutAssertionMessages {
  missing: string;
  notWorktreeRoot: string;
}

const DEFAULT_CHECKOUT_ASSERTION_MESSAGES: CheckoutAssertionMessages = {
  missing: 'Cannot add repo: source checkout is missing at',
  notWorktreeRoot:
    'Cannot add repo: source checkout is not a Git worktree root at',
};

export async function assertSourceCheckoutsExist(
  candidates: RepoCandidate[],
  messages: CheckoutAssertionMessages = DEFAULT_CHECKOUT_ASSERTION_MESSAGES,
): Promise<void> {
  for (const candidate of candidates) {
    if (!candidate.oldWorktreePath) {
      continue;
    }
    if (!(await pathExists(candidate.oldWorktreePath))) {
      throw new Error(`${messages.missing} ${candidate.oldWorktreePath}.`);
    }
    const root = await getWorktreeTopLevel(candidate.oldWorktreePath).catch(
      () => null,
    );
    if (!root) {
      throw new Error(`${messages.missing} ${candidate.oldWorktreePath}.`);
    }
    const [checkoutPath, rootPath] = await settleAll([
      canonicalPathForComparison(candidate.oldWorktreePath),
      canonicalPathForComparison(root),
    ]);
    if (checkoutPath !== rootPath) {
      throw new Error(
        `${messages.notWorktreeRoot} ${candidate.oldWorktreePath}.`,
      );
    }
  }
}

export async function migratePipelineExecutions(params: {
  sourceWorkspaceId: string;
  sourceWorktreeId: string;
  destinationWorkspaceId: string;
  destinationWorktreeId: string;
  rewrites: Array<{ fromRoot: string; toRoot: string }>;
}): Promise<Map<string, ExecutionState>> {
  const executionsDir = createElectronExecutionRuntime().executionsDir;
  const summaries = await listExecutionSummaries(executionsDir);
  const snapshots = new Map<string, ExecutionState>();
  for (const summary of summaries) {
    if (
      summary.project_id !== params.sourceWorkspaceId ||
      summary.worktree_id !== params.sourceWorktreeId
    ) {
      continue;
    }
    const state = await loadExecutionState(summary.id, executionsDir);
    if (!state) {
      continue;
    }
    snapshots.set(summary.id, structuredClone(state));
    await saveExecutionState(
      {
        ...relocateExecutionCheckout(state, params),
        project_id: params.destinationWorkspaceId,
        worktree_id: params.destinationWorktreeId,
      },
      executionsDir,
    );
  }
  return snapshots;
}

export async function restorePipelineSnapshots(
  snapshots: Map<string, ExecutionState>,
): Promise<void> {
  const executionsDir = createElectronExecutionRuntime().executionsDir;
  await settleAll(
    Array.from(snapshots.values()).map((state) =>
      saveExecutionState(state, executionsDir),
    ),
  );
}

/** A worktree row and the workspace whose `worktrees.json` holds it. */
export interface PersistedWorktreeRow {
  workspaceId: string;
  worktree: Pick<WorktreeData, 'id' | 'createdAt'>;
}

/** A worktree's line of work moving to another row, for the Ledger. */
export interface LedgerWorktreeMove {
  from: PersistedWorktreeRow;
  to: PersistedWorktreeRow;
}

/** Why a combine did not commit: its Ledger mapping could not be saved. */
export const LEDGER_COMBINE_NOT_SAVED_MESSAGE =
  "Couldn't combine the projects. Try again.";

/** Why a join did not commit: its Ledger mapping could not be saved. */
export const LEDGER_JOIN_NOT_SAVED_MESSAGE =
  "Couldn't join the worktree. Try again.";

/**
 * Durably records, before a combine commits, that the worktree's scope
 * belongs to the destination row, whose ID may be suffixed: nothing else
 * would let startup find it after an exit. Waits a bounded time, and only
 * when the Ledger database exists. False when a Ledger exists but the
 * mapping could not be saved: the combine must then not commit, so it fails
 * and can be retried, rather than leave the mapping only in memory.
 */
export async function recordLedgerIntentOfWorktreeMove(
  move: LedgerWorktreeMove,
): Promise<boolean> {
  try {
    const recording = await recordLedgerMoveIntent(
      worktreeLedgerIncarnation(move.from.workspaceId, move.from.worktree),
      worktreeLedgerIncarnation(move.to.workspaceId, move.to.worktree),
      { waitMs: LEDGER_INTENT_REFUSING_WAIT_MS },
    );
    return recording !== 'not_durable';
  } catch {
    return false;
  }
}

/** Forgets the recorded move of a combine that did not commit. */
export function discardLedgerIntentOfWorktreeMove(
  move: LedgerWorktreeMove,
): void {
  try {
    discardLedgerMoveIntent(
      worktreeLedgerIncarnation(move.from.workspaceId, move.from.worktree),
      worktreeLedgerIncarnation(move.to.workspaceId, move.to.worktree),
    );
  } catch {
    // The startup pass drops an intent whose move never committed.
  }
}

/**
 * Tells the Ledger that a worktree's line of work now persists as another
 * row, often in another workspace, so its scope follows and keeps its
 * ledger. Call only once the combine has committed and nothing can roll it
 * back. The participant returns at once, so the combine never waits on Ledger
 * storage, and it never throws.
 */
export function notifyLedgerOfWorktreeMove(move: LedgerWorktreeMove): void {
  try {
    notifyLedgerContainerMoved(
      worktreeLedgerIncarnation(move.from.workspaceId, move.from.worktree),
      worktreeLedgerIncarnation(move.to.workspaceId, move.to.worktree),
    );
  } catch {
    // The participant never throws. A defect in it must not fail a committed
    // move; startup reconciliation settles the scope.
  }
}

export async function findExistingAdhocDestination(
  sourceWorkspaceId: string,
  sourceWorktreeId: string,
  readOptions?: { persistRemovalCleanup?: false },
): Promise<{ workspace: MultiRepoSidebarItem; worktree: WorktreeData } | null> {
  const items = readOptions
    ? await listWorkspaceItems(readOptions)
    : await listWorkspaceItems();
  for (const item of items) {
    if (item.type !== 'multi-repo') {
      continue;
    }
    const worktree = item.worktrees.find(
      (entry) =>
        entry.adhocTransitionSource?.sourceWorkspaceId === sourceWorkspaceId &&
        entry.adhocTransitionSource?.sourceWorktreeId === sourceWorktreeId,
    );
    if (worktree) {
      return { workspace: item, worktree };
    }
  }
  return null;
}

export function buildExistingDestinationMigrationPayload(existingDestination: {
  workspace: MultiRepoSidebarItem;
  worktree: WorktreeData;
}): Pick<
  AdhocMultiRepoCombineResponse,
  | 'repoMappings'
  | 'selectedRepoIdRewrites'
  | 'sourceRootRepoIdRewrite'
  | 'filePathRewrites'
> {
  const transition = existingDestination.worktree.adhocTransitionSource;
  if (
    transition?.repoMappings &&
    transition.selectedRepoIdRewrites &&
    transition.filePathRewrites
  ) {
    return {
      repoMappings: transition.repoMappings,
      selectedRepoIdRewrites: transition.selectedRepoIdRewrites,
      sourceRootRepoIdRewrite: transition.sourceRootRepoIdRewrite,
      filePathRewrites: transition.filePathRewrites,
    };
  }

  const reposById = new Map(
    existingDestination.workspace.repos.map((repo) => [repo.id, repo]),
  );
  const repoMappings: AdhocMultiRepoRepoMapping[] = [];
  for (const link of existingDestination.worktree.compatibilitySymlinks ?? []) {
    if (link.repoId) {
      const repo = reposById.get(link.repoId);
      if (!repo) {
        continue;
      }
      const sourceRepoId =
        transition?.sourceRepoIds.find((repoId) => repoId === repo.id) ??
        (transition?.sourceRepoIds.length === 1
          ? transition.sourceRepoIds[0]
          : repo.id);
      repoMappings.push({
        sourceRepoId,
        destinationRepoId: repo.id,
        repoName: repo.name,
        repoPath: repo.repoPath,
        oldWorktreePath: link.path,
        newWorktreePath: link.targetPath,
      });
      continue;
    }

    for (const sourceRepoId of transition?.sourceRepoIds ?? []) {
      const repo = reposById.get(sourceRepoId);
      if (!repo) {
        continue;
      }
      repoMappings.push({
        sourceRepoId,
        destinationRepoId: repo.id,
        repoName: repo.name,
        repoPath: repo.repoPath,
        oldWorktreePath: resolve(link.path, 'repos', sourceRepoId),
        newWorktreePath: getWorkspaceWorktreeRepoDir(
          existingDestination.workspace.id,
          existingDestination.worktree.id,
          repo.id,
        ),
      });
    }
  }

  const selectedRepoIdRewrites = buildRepoIdRewrites(repoMappings);
  const hasRepoScopedCompatibilityLink = (
    existingDestination.worktree.compatibilitySymlinks ?? []
  ).some((link) => link.repoId !== undefined);
  return {
    repoMappings,
    selectedRepoIdRewrites,
    sourceRootRepoIdRewrite:
      hasRepoScopedCompatibilityLink && repoMappings.length === 1
        ? repoMappings[0].destinationRepoId
        : undefined,
    filePathRewrites: buildFilePathRewrites(repoMappings),
  };
}

export async function getEmptyTemporaryWorkspaceId(
  workspaceId: string,
): Promise<string | undefined> {
  const config = await readWorkspaceConfig(workspaceId).catch(() => null);
  if (config?.temporary !== true) {
    return undefined;
  }
  const worktrees = await readWorkspaceWorktrees(workspaceId);
  if (worktrees.length > 0) {
    return undefined;
  }
  // A retained archived container keeps the workspace row alive (its Archived
  // subgroup is the only sidebar path to those chats) — mirror the guard in
  // retryDeferredTemporaryWorkspaceDeletion.
  const { countArchivedContainers } = await import('./archived-containers');
  if ((await countArchivedContainers(workspaceId).catch(() => 0)) > 0) {
    return undefined;
  }
  return workspaceId;
}

export function buildRepoMapping(
  candidate: RepoCandidate,
  repo: WorkspaceRepoData,
  destinationWorkspaceId: string,
  destinationWorktreeId: string,
): AdhocMultiRepoRepoMapping {
  return {
    sourceRepoId: candidate.sourceRepoId,
    destinationRepoId: repo.id,
    repoName: repo.name,
    repoPath: repo.repoPath,
    oldWorktreePath: candidate.oldWorktreePath,
    newWorktreePath: getWorkspaceWorktreeRepoDir(
      destinationWorkspaceId,
      destinationWorktreeId,
      repo.id,
    ),
  };
}

export function buildRepoIdRewrites(
  repoMappings: AdhocMultiRepoRepoMapping[],
): Record<string, string> {
  const rewrites: Record<string, string> = {};
  for (const mapping of repoMappings) {
    if (mapping.sourceRepoId !== undefined) {
      rewrites[mapping.sourceRepoId] = mapping.destinationRepoId;
    }
  }
  return rewrites;
}

export function buildSourceRootRepoIdRewrite(
  sourceWorkspace: SidebarItem,
  repoMappings: AdhocMultiRepoRepoMapping[],
): string | undefined {
  if (sourceWorkspace.type !== 'single-repo') {
    return undefined;
  }
  return repoMappings.find((mapping) => mapping.oldWorktreePath !== undefined)
    ?.destinationRepoId;
}

export function buildFilePathRewrites(
  repoMappings: AdhocMultiRepoRepoMapping[],
  rootRewrite?: { fromRoot: string; toRoot: string },
): Array<{ fromRoot: string; toRoot: string }> {
  const rewrites = repoMappings.flatMap((mapping) => {
    if (mapping.oldWorktreePath === undefined) {
      return [];
    }
    return [
      {
        fromRoot: mapping.oldWorktreePath,
        toRoot: mapping.newWorktreePath,
      },
    ];
  });
  if (rootRewrite) {
    rewrites.push(rootRewrite);
  }
  return rewrites.sort(
    (left, right) => right.fromRoot.length - left.fromRoot.length,
  );
}

/**
 * Shared tail of the two update-source-workspace flows: reload the updated
 * workspace and build the base combine response describing it.
 */
export async function buildUpdatedSourceWorkspaceResponse(params: {
  sourceWorkspaceId: string;
  sourceWorktreeId: string;
  sourceWorkspace: SidebarItem;
  fallbackWorktree: WorktreeData;
  finalCandidates: RepoCandidate[];
}): Promise<AdhocMultiRepoCombineResponse> {
  const refreshedItems = await listWorkspaceItems();
  const destinationWorkspace = findWorkspace(
    refreshedItems,
    params.sourceWorkspaceId,
  );
  if (destinationWorkspace?.type !== 'multi-repo') {
    throw new Error('Updated project could not be reloaded');
  }
  const destinationWorktree =
    destinationWorkspace.worktrees.find(
      (worktree) => worktree.id === params.sourceWorktreeId,
    ) ?? params.fallbackWorktree;
  const mapped = await mapCandidatesToDestinationRepos(
    params.finalCandidates,
    destinationWorkspace,
  );
  const repoMappings = mapped.map(({ candidate, repo }) =>
    buildRepoMapping(
      candidate,
      repo,
      params.sourceWorkspaceId,
      params.sourceWorktreeId,
    ),
  );
  return {
    sourceWorkspaceId: params.sourceWorkspaceId,
    sourceWorktreeId: params.sourceWorktreeId,
    destinationWorkspaceId: params.sourceWorkspaceId,
    destinationWorktreeId: params.sourceWorktreeId,
    destinationWorkspace,
    destinationWorktree,
    repoMappings,
    selectedRepoIdRewrites: buildRepoIdRewrites(repoMappings),
    sourceRootRepoIdRewrite: buildSourceRootRepoIdRewrite(
      params.sourceWorkspace,
      repoMappings,
    ),
    filePathRewrites: buildFilePathRewrites(repoMappings),
    compatibilitySymlinks: [],
    createdTemporaryWorkspace: false,
    reusedWorkspace: true,
    removedSourceWorktree: false,
  };
}

async function cleanupLocalOnlySourceRoot(
  sourceRootPath: string,
): Promise<void> {
  const entries = await readdir(sourceRootPath, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (entry.name === 'CLAUDE.md' || entry.name === 'AGENTS.md') {
      continue;
    }
    if (entry.name === 'repos') {
      const repoEntries = await readdir(`${sourceRootPath}/repos`).catch(
        () => [],
      );
      if (repoEntries.length === 0) {
        continue;
      }
    }
    throw new Error(
      `Cannot remove source worktree root because it contains unexpected content: ${sourceRootPath}`,
    );
  }
  await rm(sourceRootPath, { recursive: true, force: true });
}

export type ConsumedRootRestore =
  | {
      kind: 'source-backed';
      repoPath: string;
      path: string;
      branchName: string;
    }
  | { kind: 'local-only'; path: string };

/**
 * Consume a worktree's on-disk root after its repo checkouts have been moved
 * out (or removed), replacing it with a compatibility symlink.
 *
 * - Single-repo workspace: the checkout dir itself is symlinked to the
 *   destination repo dir of its (single) mapping. No restore entry — the
 *   move rollback covers it.
 * - Multi-repo workspace: the (now repo-empty) root is removed
 *   (source-backed roots via safeRemoveWorktree, local-only roots via
 *   cleanupLocalOnlySourceRoot) and symlinked to the destination root.
 *   `onRootConsumed` fires with the restore record immediately after the root
 *   removal succeeds and before the symlink attempt, so the caller's rollback
 *   can restore the root even if symlinking fails.
 *
 * Returns `null` only on the single-repo path when no mapping has an
 * `oldWorktreePath` (i.e., the source workspace had no checkout to symlink).
 *
 * `fallbackBranchName` is used when the root's current branch cannot be read;
 * callers typically pass the destination worktree id as a safe fallback.
 *
 * `onRootConsumed` must not throw — it fires after the root is removed, and a
 * throw there would lose the restore record.
 */
export async function consumeWorktreeRootWithSymlink(params: {
  workspace: SidebarItem;
  workspaceId: string;
  worktreeId: string;
  repoMappings: AdhocMultiRepoRepoMapping[];
  destinationRoot: string;
  fallbackBranchName: string;
  onRootConsumed: (restore: ConsumedRootRestore) => void;
}): Promise<WorktreeCompatibilitySymlink | null> {
  if (params.workspace.type === 'single-repo') {
    const mapping = params.repoMappings.find(
      (entry) => entry.oldWorktreePath !== undefined,
    );
    if (!mapping?.oldWorktreePath) {
      return null;
    }
    return replacePathWithCompatibilitySymlink(
      mapping.oldWorktreePath,
      mapping.newWorktreePath,
      {
        sourceWorkspaceId: params.workspaceId,
        sourceWorktreeId: params.worktreeId,
        repoId: mapping.destinationRepoId,
      },
    );
  }

  if (params.workspace.type === 'cowork') {
    throw new Error(
      'Cannot consume a worktree root symlink for a cowork project.',
    );
  }

  const rootPath = getWorkspaceWorktreeDir(
    params.workspaceId,
    params.worktreeId,
  );
  if (params.workspace.sourceRepoPath) {
    const rootBranchName =
      (await getCurrentBranch(rootPath).catch(() => null)) ??
      params.fallbackBranchName;
    await safeRemoveWorktree(
      params.workspace.sourceRepoPath,
      rootPath,
      'adhoc-multi-repo source root cleanup',
    );
    params.onRootConsumed({
      kind: 'source-backed',
      repoPath: params.workspace.sourceRepoPath,
      path: rootPath,
      branchName: rootBranchName,
    });
  } else {
    await cleanupLocalOnlySourceRoot(rootPath);
    params.onRootConsumed({ kind: 'local-only', path: rootPath });
  }
  return replacePathWithCompatibilitySymlink(rootPath, params.destinationRoot, {
    sourceWorkspaceId: params.workspaceId,
    sourceWorktreeId: params.worktreeId,
  });
}

/**
 * Scaffold a combine destination worktree root: `repos/` directory, default
 * workspace `CLAUDE.md`, and the `AGENTS.md` compatibility symlink.
 */
export async function scaffoldDestinationRoot(
  destinationRoot: string,
  workspaceName: string,
): Promise<void> {
  await mkdir(`${destinationRoot}/repos`, { recursive: true });
  await scaffoldWorkspaceInstructions(
    {
      content: getDefaultWorkspaceClaudeMd(workspaceName),
      agentsMdAlias: true,
    },
    {
      writeClaudeMd: (content) =>
        writeFile(`${destinationRoot}/CLAUDE.md`, content, 'utf8'),
      ensureAgentsMdAlias: () => ensureAgentsMdSymlink(destinationRoot),
    },
  );
}

/**
 * Rollback helper: re-create a consumed worktree root (source-backed roots as
 * a git worktree, local-only roots as a plain directory). No-op when no root
 * was consumed or it still exists; failures are pushed into `rollbackErrors`.
 */
export async function restoreConsumedRoot(
  restore: ConsumedRootRestore | undefined,
  rollbackErrors: unknown[],
): Promise<void> {
  if (!restore || (await pathExists(restore.path))) {
    return;
  }
  if (restore.kind === 'source-backed') {
    await createWorktree(
      restore.repoPath,
      restore.path,
      restore.branchName,
    ).catch((rollbackError) => rollbackErrors.push(rollbackError));
  } else {
    await mkdir(restore.path, { recursive: true }).catch((rollbackError) =>
      rollbackErrors.push(rollbackError),
    );
  }
}

/**
 * Rollback helper: move successfully-moved checkouts back from the
 * destination to their original paths, in reverse order. Each reversal only
 * runs when the destination copy exists; an occupied original path and other
 * failures are pushed into `rollbackErrors`.
 */
export async function reverseMovedCheckouts(
  moved: Array<{ repoPath: string; oldPath: string; newPath: string }>,
  rollbackErrors: unknown[],
): Promise<void> {
  for (const entry of [...moved].reverse()) {
    if (!(await pathExists(entry.newPath))) {
      continue;
    }
    // Something (e.g. a still-running script) recreated the original path.
    // Reporting it keeps the destination, which holds the only checkout copy.
    if (await pathExists(entry.oldPath)) {
      rollbackErrors.push(
        new Error(
          `Cannot move ${entry.newPath} back because ${entry.oldPath} already exists`,
        ),
      );
      continue;
    }
    await mkdir(dirname(entry.oldPath), { recursive: true }).catch(
      (rollbackError) => rollbackErrors.push(rollbackError),
    );
    await moveWorktree(entry.repoPath, entry.newPath, entry.oldPath).catch(
      (rollbackError) => rollbackErrors.push(rollbackError),
    );
  }
}

/**
 * Rollback helper: best-effort removal of the failed combine destination.
 * A newly created temporary workspace is dropped from the sidebar and its
 * workspace dir removed; otherwise only the destination worktree root is
 * removed. Callers must only invoke this when rollback fully succeeded —
 * destroying the destination after a partial rollback can delete the only
 * remaining copy of a checkout.
 */
export async function cleanupFailedDestination(params: {
  createdTemporaryWorkspace: boolean;
  destinationWorkspaceId: string;
  destinationRoot: string;
}): Promise<void> {
  if (params.createdTemporaryWorkspace) {
    await cleanupCompositionDestination({
      source: 'workspace_combine',
      workspaceId: params.destinationWorkspaceId,
    });
  } else {
    await rm(params.destinationRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Build the error thrown when a combine failed AND its rollback left
 * checkouts unrestored. When `preservedDestinationRoot` is set, the message
 * tells the user the destination was intentionally left in place so their
 * checkouts can be recovered from it.
 */
export function buildRollbackFailureError(
  originalError: unknown,
  rollbackErrors: unknown[],
  prefix: string,
  preservedDestinationRoot?: string,
): Error {
  const original =
    originalError instanceof Error
      ? originalError
      : new Error(String(originalError));
  const rollbackDetails = rollbackErrors
    .map((rollbackError) =>
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError),
    )
    .join('; ');
  const preservedSuffix = preservedDestinationRoot
    ? ` Destination was left in place at ${preservedDestinationRoot} to preserve checkouts.`
    : '';
  return new Error(
    `${prefix}: ${original.message}. Rollback errors: ${rollbackDetails}${preservedSuffix}`,
  );
}
