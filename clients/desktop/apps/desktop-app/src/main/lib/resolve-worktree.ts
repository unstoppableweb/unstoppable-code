import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isDefaultWorktreeBranchName } from '@canopy/desktop-shared/lib/default-worktree-branch';
import { runWithW5Caller } from '@canopy/desktop-shared/node/work-counters';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { getDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { getCodeReviewTargetSync } from './code-review-registry';
import { getCurrentBranch } from './git';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { getWorkspaceType, isCoworkWorkspace } from './workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import {
  getWorktreeDir,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getCoworkWorkspaceRootDir,
  getChatArchivesFilePath,
  getChatTabsFilePath,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceChatTabsFilePath,
  getTrackedPlansFilePath,
  getWorkspaceTrackedPlansFilePath,
  getDetectedPlansFilePath,
  getWorkspaceDetectedPlansFilePath,
  getWorktreeSummaryFilePath,
  getWorkspaceWorktreeSummaryFilePath,
  getCodeReviewChatTabsFilePath,
  getPlanExploreChatTabsFilePath,
  getAppAdvisorHomeDir,
  getDataDir,
  getSharedContainerRunRepoDir,
  getSharedContainerRunRootDir,
} from './paths';
import { getPlanExploreTargetSync } from './plan-explore-registry';
import {
  validateOptionalRepoId,
  validateWorktreeChatScope,
} from './validation';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

function assertChatPersistencePathContained(filePath: string): string {
  const relativePath = relative(getDataDir(), filePath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      'Resolved chat persistence path escapes the data directory',
    );
  }
  return filePath;
}

/**
 * One registry hop for the chat scopes that borrow a real worktree: the
 * plan-explore scope (`worktreeId` is the planId) and the code-review scope
 * (`worktreeId` is the `projectId--worktreeId` composite). `undefined` for any
 * other scope; an unregistered borrowing scope throws.
 */
function registeredChatWorktree(
  projectId: string,
  worktreeId: string,
): { projectId: string; worktreeId: string } | undefined {
  if (projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    const ref = getPlanExploreTargetSync(worktreeId);
    if (!ref) {
      throw new Error(
        `No plan-explore target registered for plan ${worktreeId}`,
      );
    }
    return ref;
  }
  if (projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    const ref = getCodeReviewTargetSync(worktreeId);
    if (!ref) {
      throw new Error(
        `No code-review target registered for scope ${worktreeId}`,
      );
    }
    return ref;
  }
  return undefined;
}

/**
 * Follows registry-backed chat scopes to the real worktree they borrow, with
 * the errors `resolveWorktreeCwd` raises; other scopes return unchanged.
 */
export function resolveRegisteredChatWorktree(
  projectId: string,
  worktreeId: string,
): WorktreeTargetIds {
  let target: WorktreeTargetIds = { projectId, worktreeId };
  const visited = new Set<string>();
  for (
    let next = registeredChatWorktree(projectId, worktreeId);
    next;
    next = registeredChatWorktree(target.projectId, target.worktreeId)
  ) {
    // A registry entry that leads back to a visited scope never resolves.
    const key = `${next.projectId}\0${next.worktreeId}`;
    if (visited.has(key))
      throw new Error(`Chat scope ${worktreeId} has a cyclic worktree target`);
    visited.add(key);
    target = { projectId: next.projectId, worktreeId: next.worktreeId };
  }
  return target;
}

/**
 * Resolve the working directory for a worktree, dispatching between
 * single-repo projects and multi-repo workspaces.
 *
 * For multi-repo workspaces, an optional `selectedRepoId` chooses a child
 * repo's checkout instead of the workspace root. `WORKSPACE_ROOT_REPO_ID`
 * and `undefined` both resolve to the workspace worktree root.
 */
export function resolveWorktreeCwd(
  projectId: string,
  worktreeId: string,
  selectedRepoId?: string,
): string {
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return selectedRepoId
      ? getSharedContainerRunRepoDir(worktreeId, selectedRepoId)
      : getSharedContainerRunRootDir(worktreeId);
  }
  const registered = registeredChatWorktree(projectId, worktreeId);
  if (registered) {
    // Resolve recursively so workspace/single-repo dispatch and
    // selectedRepoId handling stay in one place.
    return resolveWorktreeCwd(
      registered.projectId,
      registered.worktreeId,
      selectedRepoId,
    );
  }
  if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    return getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(worktreeId));
  }
  if (isBotProjectId(projectId)) {
    return getAppAdvisorHomeDir();
  }
  if (isCoworkWorkspace(projectId)) {
    // Attached external folder when registered, otherwise the managed home.
    return getCoworkWorkspaceRootDir(projectId);
  }
  if (getWorkspaceType(projectId) !== null) {
    validateOptionalRepoId(selectedRepoId, 'selectedRepoId');
    if (selectedRepoId && selectedRepoId !== WORKSPACE_ROOT_REPO_ID) {
      return getWorkspaceWorktreeRepoDir(projectId, worktreeId, selectedRepoId);
    }
    return getWorkspaceWorktreeDir(projectId, worktreeId);
  }
  return getWorktreeDir(projectId, worktreeId);
}

export interface WorktreeTargetIds {
  projectId: string;
  worktreeId: string;
}

/** Resolves app-managed chat sentinels to the real worktree they borrow. */
export function resolveWorktreeTargetIds(
  projectId: string,
  worktreeId: string,
): WorktreeTargetIds | null {
  if (projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    return getPlanExploreTargetSync(worktreeId);
  }
  if (projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    return getCodeReviewTargetSync(worktreeId);
  }
  if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    const workspaceId = resolveCoworkWorkspaceId(worktreeId);
    return isCoworkWorkspace(workspaceId)
      ? { projectId: workspaceId, worktreeId: COWORK_HOME_WORKTREE_ID }
      : null;
  }
  return { projectId, worktreeId };
}

/**
 * Resolve the chat tabs file path for a worktree.
 */
export function resolveChatTabsFilePath(
  projectId: string,
  worktreeId: string,
): string {
  validateWorktreeChatScope(projectId, worktreeId);
  let filePath: string;
  if (getWorkspaceType(projectId) !== null) {
    filePath = getWorkspaceChatTabsFilePath(projectId, worktreeId);
  } else if (projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    filePath = getPlanExploreChatTabsFilePath(worktreeId);
  } else if (projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    filePath = getCodeReviewChatTabsFilePath(worktreeId);
  } else if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    filePath = getWorkspaceChatTabsFilePath(
      resolveCoworkWorkspaceId(worktreeId),
      COWORK_HOME_WORKTREE_ID,
    );
  } else {
    filePath = getChatTabsFilePath(projectId, worktreeId);
  }
  return assertChatPersistencePathContained(filePath);
}

/**
 * Resolve the journal beside the scope's workspace-aware `chats/` directory.
 * Deriving this from the already-canonical tabs path preserves every existing
 * sentinel/entry key without introducing a second scope-key mapping.
 */
export function resolveChatJournalFilePath(
  projectId: string,
  worktreeId: string,
): string {
  const tabsPath = resolveChatTabsFilePath(projectId, worktreeId);
  const fileName = basename(tabsPath).replace(/\.json$/, '.jsonl');
  return join(dirname(dirname(tabsPath)), 'chat-journals', fileName);
}

/**
 * Resolve the legacy archives file for a chat scope. Every branch mirrors
 * `resolveChatTabsFilePath` so the v2 repository, which pins its legacy
 * migration inputs from the first caller of a scope, sees the same archive
 * family regardless of which alias (sentinel or real cowork id) admitted it.
 */
export function resolveChatArchivesFilePath(
  projectId: string,
  worktreeId: string,
): string {
  validateWorktreeChatScope(projectId, worktreeId);
  let filePath: string;
  if (getWorkspaceType(projectId) !== null) {
    filePath = getWorkspaceChatArchivesFilePath(projectId, worktreeId);
  } else if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    // Legacy sentinel keying carries the cowork workspace id in worktreeId;
    // its archives live beside the cowork home tabs (`chat-archives/home.json`).
    filePath = getWorkspaceChatArchivesFilePath(
      resolveCoworkWorkspaceId(worktreeId),
      COWORK_HOME_WORKTREE_ID,
    );
  } else {
    // Plan-explore and code-review sentinels keep their existing
    // `workspaces/{sentinel}/chat-archives/{scope}.json` family.
    filePath = getChatArchivesFilePath(projectId, worktreeId);
  }
  return assertChatPersistencePathContained(filePath);
}

export function resolveWorktreeSummaryFilePath(
  projectId: string,
  worktreeId: string,
): string {
  if (projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    throw new Error('Plan-explore chats do not have worktree summaries');
  }
  if (projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    throw new Error('Code-review chats do not have worktree summaries');
  }
  if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    // Legacy sentinel keying carries the cowork workspace id in worktreeId
    // (mirroring resolveChatTabsFilePath).
    return getWorkspaceWorktreeSummaryFilePath(
      resolveCoworkWorkspaceId(worktreeId),
      COWORK_HOME_WORKTREE_ID,
    );
  }
  // Cowork workspaces have summaries too (workspaces/{id}/summaries/home.json)
  // — real cowork ids fall through to the workspace-typed branch below.
  if (getWorkspaceType(projectId) !== null) {
    return getWorkspaceWorktreeSummaryFilePath(projectId, worktreeId);
  }
  return getWorktreeSummaryFilePath(projectId, worktreeId);
}

export function resolveTrackedPlansFilePath(
  projectId: string,
  worktreeId: string,
): string {
  if (projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    throw new Error('Plan-explore chats do not have tracked plans');
  }
  if (projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    throw new Error('Code-review chats do not have tracked plans');
  }
  if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    throw new Error('Standalone chats do not have tracked plans');
  }
  if (isCoworkWorkspace(projectId)) {
    throw new Error(
      `Tracked plans are not available for cowork project ${projectId}`,
    );
  }
  if (getWorkspaceType(projectId) !== null) {
    return getWorkspaceTrackedPlansFilePath(projectId, worktreeId);
  }
  return getTrackedPlansFilePath(projectId, worktreeId);
}

export function resolveDetectedPlansFilePath(
  projectId: string,
  worktreeId: string,
): string {
  if (projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    throw new Error('Plan-explore chats do not have detected plans');
  }
  if (projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    throw new Error('Code-review chats do not have detected plans');
  }
  if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    throw new Error('Standalone chats do not have detected plans');
  }
  if (isCoworkWorkspace(projectId)) {
    throw new Error(
      `Detected plans are not available for cowork project ${projectId}`,
    );
  }
  if (getWorkspaceType(projectId) !== null) {
    return getWorkspaceDetectedPlansFilePath(projectId, worktreeId);
  }
  return getDetectedPlansFilePath(projectId, worktreeId);
}

export interface PersistedWorktreeBranch {
  worktreeId: string;
  branchName: string;
}

const WORKTREE_READ_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-worktree-chat-target',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: ['core.worktree.read'],
};

/**
 * The worktree row through `core.worktree.get` (CAN-5478), with the authority
 * of its list read; null when the runtime, workspace or row is unavailable.
 */
async function readWorktreeRow(
  target: WorktreeTargetIds,
): Promise<{ row: WorktreeData; listIsComplete: boolean } | null> {
  try {
    const { legacyResult, legacyAuthority } = await runWithW5Caller(
      'background:resolve-worktree',
      () =>
        getDesktopCanopyRuntime().queryWorktreeGetForLegacyIpc(
          {
            worktreeId: target.worktreeId,
            scope: { workspaceId: target.projectId },
          },
          { caller: WORKTREE_READ_CALLER },
        ),
    );
    return {
      row: legacyResult,
      listIsComplete: legacyAuthority?.authority === 'ok',
    };
  } catch {
    return null;
  }
}

/** Read the persisted branch and resolved target id without spawning git. */
export async function readPersistedWorktreeBranch(
  projectId: string,
  worktreeId: string,
): Promise<PersistedWorktreeBranch | null> {
  const target = resolveWorktreeTargetIds(projectId, worktreeId);
  if (!target) return null;
  const read = await readWorktreeRow(target);
  // Any row the list could not read leaves the branch unproven.
  return read?.listIsComplete
    ? { worktreeId: target.worktreeId, branchName: read.row.branchName }
    : null;
}

/**
 * Check whether the one-time branch rename prompt has already been sent
 * for the given worktree.
 */
export async function isBranchPromptSent(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  const read = await readWorktreeRow({ projectId, worktreeId });
  return read?.row.branchPromptSent === true;
}

export type BranchMatchResult =
  | { matches: false }
  | { matches: true; matchingRepos?: string[] };

function branchMatchesWorktreePlaceholder(
  branchName: string,
  worktreeId: string,
): boolean {
  return isDefaultWorktreeBranchName(branchName, worktreeId);
}

/**
 * Check whether the worktree's git branch still matches the worktree ID
 * (i.e. the user has not yet renamed it). Git setup may append a numeric
 * suffix to the initial branch when the preferred worktree-id branch collides.
 *
 * For multi-repo workspaces the result includes the repo ids whose branch
 * still matches, including the synthetic workspace-root repo id when present.
 */
export async function doesBranchMatchWorktreeId(
  projectId: string,
  worktreeId: string,
  cwd: string,
): Promise<BranchMatchResult> {
  try {
    if (getWorkspaceType(projectId) === 'multi-repo') {
      const matching: string[] = [];
      const repoEntries = await listWorkspaceWorktreeRepoEntries(
        projectId,
        cwd,
      );
      await settleAll(
        repoEntries.map(async (entry) => {
          const branch = await getCurrentBranch(entry.repoPath).catch(() => '');
          if (branchMatchesWorktreePlaceholder(branch, worktreeId)) {
            matching.push(entry.repoId);
          }
        }),
      );

      return matching.length > 0
        ? { matches: true, matchingRepos: matching.sort() }
        : { matches: false };
    }

    const branch = await getCurrentBranch(cwd);
    return branchMatchesWorktreePlaceholder(branch, worktreeId)
      ? { matches: true }
      : { matches: false };
  } catch {
    return { matches: false };
  }
}
