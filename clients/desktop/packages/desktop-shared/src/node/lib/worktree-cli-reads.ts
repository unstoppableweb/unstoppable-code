import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { getGitExecutableCommand } from '../../lib/git-executable';
import { WORKSPACE_ROOT_REPO_ID, WORKSPACE_ROOT_REPO_NAME } from '../../types';
import type {
  DiffStats,
  DiffStatsBatchResponseItem,
  McpServerStatusData,
  SidebarItem,
  SlashCommandData,
  WorktreeDiscovery,
  WorktreeCliRecord,
  WorktreeData,
  WorktreeHealthIssue,
  WorktreeHealthRepoIssue,
} from '../../types';
import type {
  CheckDetail,
  CheckExecutionState,
  PrLabel,
  PrMergeQueuePhase,
  PrMergeQueueStatus,
  PrStatusData,
  RepoPrStatus,
  ReviewerInfo,
  WorktreePrStatus,
} from '../../types/github';
import { isPrMergeQueuePhase } from '../../types/github';
import { PORTAL_PULL_REQUEST_CHECK_EXECUTION_STATES } from '@canopy/protocol/portal';
import { getWorkspaceItem } from './workspace-cli-reads';
import { listCodeGraphWorktreeRepositories } from '@canopy/code-graph/host/worktree-repositories';
import type { CodeGraphRepositoryInput } from '@canopy/code-graph/types/code-graph';
import { listExecutionSummaries } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import { settleAll } from './detached-work';

// CLI reads of worktree lists, paths and diff stats. Writers live in
// ./worktree-service; this module must not import it.

const execFileAsync = promisify(execFile);

interface ListWorktreePipelineExecutionsOptions {
  workspaceId: string;
  worktreeId: string;
  limit?: number;
  offset?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getWorkspaceDir(workspaceId: string): string {
  return path.join(getCanopyDataDir(), 'workspaces', workspaceId);
}

export function getWorktreesFilePath(workspaceId: string): string {
  return path.join(getWorkspaceDir(workspaceId), 'worktrees.json');
}

export function getSingleRepoWorktreeDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return path.join(getWorkspaceDir(workspaceId), 'worktrees', worktreeId);
}

export function getMultiRepoWorktreeDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return path.join(getWorkspaceDir(workspaceId), 'worktrees', worktreeId);
}

export function getMultiRepoRepoWorktreeDir(
  workspaceId: string,
  worktreeId: string,
  repoId: string,
): string {
  return path.join(
    getMultiRepoWorktreeDir(workspaceId, worktreeId),
    'repos',
    repoId,
  );
}

export function getMultiRepoRootWorktreeDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return getMultiRepoWorktreeDir(workspaceId, worktreeId);
}

function getPipelineExecutionsDir(): string {
  return path.join(getCanopyDataDir(), 'pipeline-executions');
}

export async function runGit(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  const pending = execFileAsync(getGitExecutableCommand(process.env), args, {
    cwd,
    signal,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8,
    // Ignored off Windows; a platform read here would be a new
    // platform-boundary site.
    windowsHide: true,
  });
  // execFile rejects on abort before the child closes. Recovery must wait for
  // the actual Git child, not mistake promise rejection for process completion.
  const closed = new Promise<void>((resolve) =>
    pending.child.once('close', () => resolve()),
  );
  try {
    const { stdout } = await pending;
    return stdout.trim();
  } finally {
    await closed;
  }
}

export function normalizeWorktree(value: unknown): WorktreeData | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.branchName !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    return null;
  }
  const worktree: WorktreeData = {
    id: value.id,
    branchName: value.branchName,
    createdAt: value.createdAt,
  };
  if (typeof value.restoredFromFilesOnlyArchiveId === 'string') {
    worktree.restoredFromFilesOnlyArchiveId =
      value.restoredFromFilesOnlyArchiveId;
  }
  if (value.pinned === true) {
    worktree.pinned = true;
  }
  if (typeof value.lastTouchedAt === 'string') {
    worktree.lastTouchedAt = value.lastTouchedAt;
  }
  if (typeof value.label === 'string') {
    worktree.label = value.label;
  }
  const discovery = normalizeWorktreeDiscovery(value.discovery);
  if (discovery) {
    worktree.discovery = discovery;
  }
  if (typeof value.branchPromptSent === 'boolean') {
    worktree.branchPromptSent = value.branchPromptSent;
  }
  if (value.status === 'active' || value.status === 'done') {
    worktree.status = value.status;
  }
  if (
    Array.isArray(value.seenPipelineExecutionIds) &&
    value.seenPipelineExecutionIds.every((entry) => typeof entry === 'string')
  ) {
    worktree.seenPipelineExecutionIds = value.seenPipelineExecutionIds;
  }
  if (typeof value.trackedBaseBranch === 'string') {
    worktree.trackedBaseBranch = value.trackedBaseBranch;
  } else if (value.trackedBaseBranch === null) {
    worktree.trackedBaseBranch = null;
  }
  const trackedRepoBaseBranches = normalizeStringRecord(
    value.trackedRepoBaseBranches,
  );
  if (trackedRepoBaseBranches) {
    worktree.trackedRepoBaseBranches = trackedRepoBaseBranches;
  }
  if (
    value.branchGroupingOverride === 'group' ||
    value.branchGroupingOverride === 'ungroup'
  ) {
    worktree.branchGroupingOverride = value.branchGroupingOverride;
  }
  if (typeof value.branchGroupingParentWorktreeId === 'string') {
    worktree.branchGroupingParentWorktreeId =
      value.branchGroupingParentWorktreeId;
  }
  const lastKnownPrStatus = normalizeWorktreePrStatus(value.lastKnownPrStatus);
  if (lastKnownPrStatus !== undefined) {
    worktree.lastKnownPrStatus = lastKnownPrStatus;
  }
  if (
    Array.isArray(value.pausedHookKeys) &&
    value.pausedHookKeys.every((entry) => typeof entry === 'string')
  ) {
    worktree.pausedHookKeys = value.pausedHookKeys;
  }
  const healthIssue = normalizeWorktreeHealthIssue(value.healthIssue);
  if (healthIssue) {
    worktree.healthIssue = healthIssue;
  }
  if (typeof value.hidden === 'boolean') {
    worktree.hidden = value.hidden;
  }
  if (value.setupPhase === 'git-pending' || value.setupPhase === 'git-ready') {
    worktree.setupPhase = value.setupPhase;
  }
  if (
    Array.isArray(value.includedRepoIds) &&
    value.includedRepoIds.every((entry) => typeof entry === 'string')
  ) {
    worktree.includedRepoIds = value.includedRepoIds;
  }
  if (value.splitRecoveryRequired === true) {
    worktree.splitRecoveryRequired = true;
  }
  return worktree;
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeWorktreeDiscovery(
  value: unknown,
): WorktreeDiscovery | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!Array.isArray(value.slashCommands) || !Array.isArray(value.mcpServers)) {
    return undefined;
  }
  if (typeof value.discoveredAt !== 'string') {
    return undefined;
  }
  const slashCommands = value.slashCommands
    .map((entry) => normalizeSlashCommand(entry))
    .filter((entry): entry is SlashCommandData => entry !== null);
  const mcpServers = value.mcpServers
    .map((entry) => normalizeMcpServer(entry))
    .filter((entry): entry is McpServerStatusData => entry !== null);
  const discovery: WorktreeDiscovery = {
    slashCommands,
    mcpServers,
    discoveredAt: value.discoveredAt,
  };
  if (isAgentProviderType(value.providerType)) {
    discovery.providerType = value.providerType;
  }
  return discovery;
}

function normalizeSlashCommand(value: unknown): SlashCommandData | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.name !== 'string' || typeof value.description !== 'string') {
    return null;
  }
  const command: SlashCommandData = {
    name: value.name,
    description: value.description,
  };
  if (typeof value.argumentHint === 'string') {
    command.argumentHint = value.argumentHint;
  }
  if (typeof value.displayName === 'string') {
    command.displayName = value.displayName;
  }
  if (typeof value.insertText === 'string') {
    command.insertText = value.insertText;
  }
  return command;
}

function normalizeMcpServer(value: unknown): McpServerStatusData | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.name !== 'string' || !isMcpServerStatus(value.status)) {
    return null;
  }
  const server: McpServerStatusData = {
    name: value.name,
    status: value.status,
  };
  if (isRecord(value.serverInfo)) {
    if (
      typeof value.serverInfo.name === 'string' &&
      typeof value.serverInfo.version === 'string'
    ) {
      server.serverInfo = {
        name: value.serverInfo.name,
        version: value.serverInfo.version,
      };
    }
  }
  if (typeof value.error === 'string') {
    server.error = value.error;
  }
  if (typeof value.scope === 'string') {
    server.scope = value.scope;
  }
  if (Array.isArray(value.tools)) {
    const tools = value.tools
      .map((tool) => {
        if (!isRecord(tool) || typeof tool.name !== 'string') {
          return null;
        }
        const normalized: { name: string; description?: string } = {
          name: tool.name,
        };
        if (typeof tool.description === 'string') {
          normalized.description = tool.description;
        }
        return normalized;
      })
      .filter(
        (tool): tool is { name: string; description?: string } => tool !== null,
      );
    server.tools = tools;
  }
  return server;
}

function isAgentProviderType(
  value: unknown,
): value is 'claude' | 'codex' | 'ollama' {
  return value === 'claude' || value === 'codex' || value === 'ollama';
}

function isMcpServerStatus(
  value: unknown,
): value is McpServerStatusData['status'] {
  return (
    value === 'connected' ||
    value === 'failed' ||
    value === 'needs-auth' ||
    value === 'pending' ||
    value === 'disabled'
  );
}

function normalizeWorktreePrStatus(
  value: unknown,
): WorktreePrStatus | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.repos)) {
    return undefined;
  }
  if (typeof value.lastCheckedAt !== 'string') {
    return undefined;
  }
  const repos = value.repos
    .map((repo) => normalizeRepoPrStatus(repo))
    .filter((repo): repo is RepoPrStatus => repo !== null);
  return {
    repos,
    lastCheckedAt: value.lastCheckedAt,
  };
}

function normalizeRepoPrStatus(value: unknown): RepoPrStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.repoId !== 'string' || typeof value.repoName !== 'string') {
    return null;
  }
  const status = normalizePrStatusData(value.status);
  if (status === undefined) {
    return null;
  }
  return {
    repoId: value.repoId,
    repoName: value.repoName,
    status,
    ...(typeof value.prLookupAvailable === 'boolean'
      ? { prLookupAvailable: value.prLookupAvailable }
      : {}),
  };
}

function normalizePrStatusData(
  value: unknown,
): PrStatusData | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.prNumber !== 'number' ||
    typeof value.prUrl !== 'string' ||
    !isPrState(value.state) ||
    typeof value.title !== 'string' ||
    !isCheckStatus(value.checkStatus) ||
    !Array.isArray(value.checkDetails) ||
    !isReviewStatus(value.reviewStatus) ||
    !Array.isArray(value.reviewers) ||
    typeof value.hasConflicts !== 'boolean' ||
    typeof value.commentCount !== 'number' ||
    typeof value.updatedAt !== 'string'
  ) {
    return undefined;
  }
  const checkDetails = value.checkDetails
    .map((entry) => normalizeCheckDetail(entry))
    .filter((entry): entry is CheckDetail => entry !== null);
  const reviewers = value.reviewers
    .map((entry) => normalizeReviewerInfo(entry))
    .filter((entry): entry is ReviewerInfo => entry !== null);
  const labels = Array.isArray(value.labels)
    ? value.labels
        .map((entry) => normalizePrLabel(entry))
        .filter((entry): entry is PrLabel => entry !== null)
    : [];
  const status: PrStatusData = {
    prNumber: value.prNumber,
    prUrl: value.prUrl,
    state: value.state,
    title: value.title,
    checkStatus: value.checkStatus,
    checkDetails,
    reviewStatus: value.reviewStatus,
    reviewers,
    hasConflicts: value.hasConflicts,
    commentCount: value.commentCount,
    updatedAt: value.updatedAt,
  };
  if (labels.length > 0) {
    status.labels = labels;
  }
  if (typeof value.headSha === 'string') {
    status.headSha = value.headSha;
  }
  if (typeof value.baseRefName === 'string') {
    status.baseRefName = value.baseRefName;
  }
  if (typeof value.mergeable === 'boolean' || value.mergeable === null) {
    status.mergeable = value.mergeable;
  }
  if (
    typeof value.mergeableState === 'string' ||
    value.mergeableState === null
  ) {
    status.mergeableState = value.mergeableState;
  }
  const mergeQueue = normalizePrMergeQueueStatus(value.mergeQueue);
  if (mergeQueue) {
    status.mergeQueue = mergeQueue;
  }
  return status;
}

function normalizePrMergeQueueStatus(
  value: unknown,
): PrMergeQueueStatus | undefined {
  if (
    !isRecord(value) ||
    (value.required !== undefined && typeof value.required !== 'boolean') ||
    (value.inQueue !== undefined && typeof value.inQueue !== 'boolean') ||
    (value.required === undefined && value.inQueue === undefined)
  ) {
    return undefined;
  }
  // A phase only describes a queued PR; one from a newer build reads as unknown.
  let phase: PrMergeQueuePhase | undefined;
  if (value.inQueue && typeof value.phase === 'string') {
    phase = isPrMergeQueuePhase(value.phase) ? value.phase : 'unknown';
  }
  return {
    ...(typeof value.required === 'boolean'
      ? { required: value.required }
      : {}),
    ...(typeof value.inQueue === 'boolean' ? { inQueue: value.inQueue } : {}),
    ...(typeof value.position === 'number' || value.position === null
      ? { position: value.position }
      : {}),
    ...(phase ? { phase } : {}),
  };
}

function normalizeCheckDetail(value: unknown): CheckDetail | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.name !== 'string' || !isCheckStatus(value.status)) {
    return null;
  }
  if (typeof value.detailsUrl !== 'string' && value.detailsUrl !== null) {
    return null;
  }
  // The detailed state is optional: an unknown or malformed one is dropped
  // without discarding the otherwise valid row.
  return {
    name: value.name,
    status: value.status,
    ...(isCheckExecutionState(value.executionState)
      ? { executionState: value.executionState }
      : {}),
    detailsUrl: value.detailsUrl,
  };
}

function normalizeReviewerInfo(value: unknown): ReviewerInfo | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.login !== 'string' || !isReviewerState(value.state)) {
    return null;
  }
  return {
    login: value.login,
    state: value.state,
  };
}

function normalizePrLabel(value: unknown): PrLabel | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.color !== 'string'
  ) {
    return null;
  }
  if (typeof value.description !== 'string' && value.description !== null) {
    return null;
  }
  return {
    name: value.name,
    color: value.color,
    description: value.description,
  };
}

function isPrState(value: unknown): value is PrStatusData['state'] {
  return (
    value === 'open' ||
    value === 'merged' ||
    value === 'closed' ||
    value === 'draft'
  );
}

function isCheckStatus(value: unknown): value is PrStatusData['checkStatus'] {
  return (
    value === 'passing' ||
    value === 'failing' ||
    value === 'pending' ||
    value === 'neutral' ||
    value === 'none'
  );
}

function isCheckExecutionState(value: unknown): value is CheckExecutionState {
  return PORTAL_PULL_REQUEST_CHECK_EXECUTION_STATES.some(
    (state) => state === value,
  );
}

function isReviewStatus(value: unknown): value is PrStatusData['reviewStatus'] {
  return (
    value === 'approved' ||
    value === 'changes_requested' ||
    value === 'pending' ||
    value === 'none'
  );
}

function isReviewerState(value: unknown): value is ReviewerInfo['state'] {
  return (
    value === 'approved' || value === 'changes_requested' || value === 'pending'
  );
}

function normalizeWorktreeHealthIssue(
  value: unknown,
): WorktreeHealthIssue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.status !== 'broken' ||
    !isWorktreeHealthIssueCode(value.code) ||
    typeof value.message !== 'string' ||
    typeof value.checkedAt !== 'string' ||
    typeof value.worktreePath !== 'string'
  ) {
    return undefined;
  }
  const issue: WorktreeHealthIssue = {
    status: 'broken',
    code: value.code,
    message: value.message,
    checkedAt: value.checkedAt,
    worktreePath: value.worktreePath,
  };
  if (typeof value.gitError === 'string') {
    issue.gitError = value.gitError;
  }
  if (Array.isArray(value.repoIssues)) {
    const repoIssues = value.repoIssues
      .map((entry) => normalizeWorktreeHealthRepoIssue(entry))
      .filter((entry): entry is WorktreeHealthRepoIssue => entry !== null);
    issue.repoIssues = repoIssues;
  }
  if (value.failureReason === 'source-no-commits') {
    issue.failureReason = value.failureReason;
    if (typeof value.sourceRepoId === 'string')
      issue.sourceRepoId = value.sourceRepoId;
  }
  return issue;
}

function normalizeWorktreeHealthRepoIssue(
  value: unknown,
): WorktreeHealthRepoIssue | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.repoId !== 'string' ||
    typeof value.repoName !== 'string' ||
    typeof value.repoPath !== 'string' ||
    !isWorktreeHealthIssueCode(value.code) ||
    typeof value.message !== 'string'
  ) {
    return null;
  }
  const issue: WorktreeHealthRepoIssue = {
    repoId: value.repoId,
    repoName: value.repoName,
    repoPath: value.repoPath,
    code: value.code,
    message: value.message,
  };
  if (typeof value.gitError === 'string') {
    issue.gitError = value.gitError;
  }
  return issue;
}

function isWorktreeHealthIssueCode(
  value: unknown,
): value is WorktreeHealthIssue['code'] {
  return (
    value === 'missing-worktree-path' ||
    value === 'missing-git-metadata' ||
    value === 'invalid-git-worktree' ||
    value === 'missing-repository' ||
    value === 'git-error'
  );
}

export async function readWorktrees(
  workspaceId: string,
): Promise<WorktreeData[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(getWorktreesFilePath(workspaceId), 'utf8'),
    );
    if (!isRecord(parsed) || !Array.isArray(parsed.worktrees)) {
      return [];
    }
    return parsed.worktrees
      .map((worktree) => normalizeWorktree(worktree))
      .filter((worktree): worktree is WorktreeData => worktree !== null);
  } catch {
    return [];
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function multiRepoGitEntries(
  workspace: SidebarItem & { type: 'multi-repo' },
  worktreeId: string,
): Array<{ id: string; name: string; repoPath: string; worktreePath: string }> {
  const entries = workspace.repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    repoPath: repo.repoPath,
    worktreePath: getMultiRepoRepoWorktreeDir(
      workspace.id,
      worktreeId,
      repo.id,
    ),
  }));

  if (!workspace.sourceRepoPath) {
    return entries;
  }

  return [
    {
      id: WORKSPACE_ROOT_REPO_ID,
      name: WORKSPACE_ROOT_REPO_NAME,
      repoPath: workspace.sourceRepoPath,
      worktreePath: getMultiRepoRootWorktreeDir(workspace.id, worktreeId),
    },
    ...entries,
  ];
}

export interface WorktreeCliRepoEntry {
  repoId: string;
  repoName: string;
  repoPath: string;
}

// Mirrors the Electron-only `isGitRepo` (`apps/desktop-app/src/main/lib/git.ts`)
// using this file's own git runner. A nonexistent dir fails the spawn and
// reports `false`, same as the Electron helper.
async function isGitRepoDir(dir: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--git-dir'], dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * The repositories a worktree's code graph lists, for the CLI: the listing
 * Electron main and the core daemon use, with the layout from the workspace
 * record, so every host graphs a checkout under the same repository ids
 * (CAN-6010).
 */
export async function listWorktreeCliCodeGraphRepositories(
  workspaceId: string,
  worktreePath: string,
): Promise<{ multiRepo: boolean; listed: CodeGraphRepositoryInput[] }> {
  const workspace = await getWorkspaceItem(workspaceId);
  const multiRepo = workspace.type === 'multi-repo';
  const listed = await listCodeGraphWorktreeRepositories(
    worktreePath,
    {
      multiRepo,
      hasSourceRepo: multiRepo && Boolean(workspace.sourceRepoPath),
    },
    isGitRepoDir,
  );
  if (workspace.type !== 'multi-repo') return { multiRepo, listed };
  // The ids are the shared listing's; the order stays the configured one,
  // so a command without --repo still targets the first configured
  // repository. Unconfigured directories keep their listed order, last.
  const configured = new Map(
    workspace.repos.map((repo, index) => [repo.id, index]),
  );
  const rank = (repository: CodeGraphRepositoryInput): number =>
    repository.repoId === WORKSPACE_ROOT_REPO_ID
      ? -1
      : (configured.get(repository.repoId) ?? configured.size);
  return {
    multiRepo,
    listed: [...listed].sort((a, b) => rank(a) - rank(b)),
  };
}

/**
 * CLI-safe repo enumeration for an *existing* worktree, mirroring the
 * Electron-only `listWorkspaceWorktreeRepoEntries`
 * (`apps/desktop-app/src/main/lib/worktree-repo-entries.ts`) contract of
 * `{ repoId, repoName, repoPath }` entries. The Electron helper cannot be
 * imported from the CLI (it depends on `readWorkspaceConfig`/`isGitRepo`,
 * both Electron-main-only), so this rebuilds the same semantics from this
 * file's existing path helpers and static `workspace.repos` config:
 *
 * - The workspace-root entry appears when the workspace is source-backed OR
 *   the worktree root itself is a git repo (Electron's `isGitRepo` fallback).
 * - Child repo entries are skipped when their computed checkout dir is
 *   missing on disk — Electron discovers children via `readdir`, so a repo
 *   without a checkout never appears there either.
 *
 * Single-repo and cowork workspaces have no distinct child repos and return
 * an empty array; callers that need a single implicit root repository should
 * fall back to `WORKSPACE_ROOT_REPO_ID` plus the worktree's own path, exactly
 * like the Electron-side `resolveRepositories` helper in
 * `apps/desktop-app/src/main/canopy-tools/code-graph-runtime.ts` does.
 */
export async function listWorktreeCliRepoEntries(
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeCliRepoEntry[]> {
  const workspace = await getWorkspaceItem(workspaceId);
  if (workspace.type !== 'multi-repo') {
    return [];
  }

  const entries: WorktreeCliRepoEntry[] = [];

  const worktreeRoot = getMultiRepoRootWorktreeDir(workspace.id, worktreeId);
  const hasWorkspaceRootRepo =
    Boolean(workspace.sourceRepoPath) || (await isGitRepoDir(worktreeRoot));
  if (hasWorkspaceRootRepo) {
    entries.push({
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoName: WORKSPACE_ROOT_REPO_NAME,
      repoPath: worktreeRoot,
    });
  }

  for (const repo of workspace.repos) {
    const repoWorktreePath = getMultiRepoRepoWorktreeDir(
      workspace.id,
      worktreeId,
      repo.id,
    );
    if (!(await pathExists(repoWorktreePath))) {
      continue;
    }
    entries.push({
      repoId: repo.id,
      repoName: repo.name,
      repoPath: repoWorktreePath,
    });
  }

  return entries;
}

function worktreePathFor(workspace: SidebarItem, worktreeId: string): string {
  return workspace.type === 'single-repo'
    ? getSingleRepoWorktreeDir(workspace.id, worktreeId)
    : getMultiRepoWorktreeDir(workspace.id, worktreeId);
}

async function readDiffStats(repoPath: string): Promise<DiffStats> {
  try {
    const output = await runGit(['diff', '--numstat'], repoPath);
    return output.split('\n').reduce<DiffStats>(
      (stats, line) => {
        const [insertions, deletions] = line.split('\t');
        return {
          insertions: stats.insertions + (Number(insertions) || 0),
          deletions: stats.deletions + (Number(deletions) || 0),
        };
      },
      { insertions: 0, deletions: 0 },
    );
  } catch {
    return { insertions: 0, deletions: 0 };
  }
}

export async function aggregateMultiRepoDiffStats(
  workspaceId: string,
  worktreeId: string,
  worktreePath: string,
): Promise<DiffStatsBatchResponseItem> {
  const workspace = await getWorkspaceItem(workspaceId);
  const repoPaths =
    workspace.type === 'single-repo'
      ? [worktreePath]
      : workspace.type === 'cowork'
        ? []
        : multiRepoGitEntries(workspace, worktreeId).map(
            (entry) => entry.worktreePath,
          );
  const stats = await settleAll(
    repoPaths.map((repoPath) => readDiffStats(repoPath)),
  );
  return {
    projectId: workspaceId,
    worktreeId,
    insertions: stats.reduce((sum, item) => sum + item.insertions, 0),
    deletions: stats.reduce((sum, item) => sum + item.deletions, 0),
  };
}

export async function getWorktreeStats(
  workspaceId: string,
  worktreeId: string,
): Promise<DiffStats> {
  const workspace = await getWorkspaceItem(workspaceId);
  const stats = await aggregateMultiRepoDiffStats(
    workspaceId,
    worktreeId,
    worktreePathFor(workspace, worktreeId),
  );
  return { insertions: stats.insertions, deletions: stats.deletions };
}

export async function getWorktreeCliRecord(
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeCliRecord> {
  const workspace = await getWorkspaceItem(workspaceId);
  const worktree = (await readWorktrees(workspaceId)).find(
    (candidate) => candidate.id === worktreeId,
  );
  if (!worktree) {
    throw new Error(`Worktree ${worktreeId} not found`);
  }
  return {
    workspaceId,
    workspaceName: workspace.name,
    workspaceType: workspace.type,
    id: worktree.id,
    branchName: worktree.branchName,
    createdAt: worktree.createdAt,
    path: worktreePathFor(workspace, worktree.id),
    status: worktree.status,
    trackedBaseBranch: worktree.trackedBaseBranch,
    stats: await aggregateMultiRepoDiffStats(
      workspaceId,
      worktreeId,
      worktreePathFor(workspace, worktree.id),
    ),
  };
}

export async function listWorktreeCliRows(
  workspaceId: string,
): Promise<WorktreeCliRecord[]> {
  const worktrees = await readWorktrees(workspaceId);
  return settleAll(
    worktrees.map((worktree) => getWorktreeCliRecord(workspaceId, worktree.id)),
  );
}

export async function listWorktreePipelineExecutions(
  options: ListWorktreePipelineExecutionsOptions,
): Promise<Array<{ id: string; pipelineName: string; status: string }>> {
  const summaries = await listExecutionSummaries(getPipelineExecutionsDir());
  const offset = options.offset ?? 0;
  const scoped = summaries.filter(
    (summary) =>
      summary.project_id === options.workspaceId &&
      summary.worktree_id === options.worktreeId,
  );
  const limit = options.limit ?? scoped.length;
  return scoped.slice(offset, offset + limit).map((summary) => ({
    id: summary.id,
    pipelineName: summary.pipeline_name,
    status: summary.status,
  }));
}
