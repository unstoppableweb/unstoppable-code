import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type GitExecutableStatus,
  type WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import type {
  WorkerGitBranchCreateParams,
  WorkerGitBranchCreateResult,
  WorkerGitBranchDeleteParams,
  WorkerGitBranchDeleteResult,
  WorkerGitBranchRenameParams,
  WorkerGitBranchRenameResult,
  WorkerGitBranchListParams,
  WorkerGitBranchListResult,
  WorkerGitCheckoutParams,
  WorkerGitCheckoutResult,
  WorkerGitDiffGetParams,
  WorkerGitDiffGetResult,
  WorkerGitExecutableGetParams,
  WorkerGitExecutableGetResult,
  WorkerGitRemoteGetParams,
  WorkerGitRemoteGetResult,
  WorkerGitWorktreeHealthGetParams,
  WorkerGitWorktreeHealthGetResult,
} from '@canopy/protocol/canopy-core';
import type {
  CanopyInstructionOptions,
  CanopyQueryOptions,
} from '@canopy/core-runtime';
import {
  createWorkerGitBranchListHandlers,
  createWorkerGitBranchWriteHandlers,
  createWorkerGitDiffHandlers,
  createWorkerGitExecutableHandlers,
  createWorkerGitRemoteHandlers,
  createWorkerGitWorktreeHealthHandlers,
  WorkerGitScopeError,
  type WorkerGitBranchListHandlers,
  type WorkerGitBranchListHost,
  type WorkerGitBranchWriteHandlers,
  type WorkerGitBranchWriteHost,
  type GitChangeSetReader,
  type GitChangeSetSample,
  type GitReadOutcome,
  type WorkerGitDiffHandlers,
  type WorkerGitDiffHost,
  type WorkerGitExecutableHandlers,
  type WorkerGitExecutableHost,
  type WorkerGitRemoteHandlers,
  type WorkerGitRemoteHost,
  type WorkerGitWorktreeHealthHandlers,
  type WorkerGitWorktreeHealthHost,
} from '@canopy/core-runtime/node/git';
import {
  getRemoteUrlStrict,
  gitBranchDeletePort,
  gitBranchListReads,
  gitBranchWritePort,
  gitChangeSetReads,
  isGitRepo,
  readDiffShortstat,
  readGitQuotePath,
} from '../lib/git';
import { gitPatchReads } from '../lib/git-patch-reads';
import {
  nameStatusNeedsShortstat,
  untrackedListingNeedsQuotePath,
  type LegacyDiffStatsReads,
} from '../lib/legacy-diff-stats';
import {
  detectGitExecutableShared,
  previewGitExecutable,
  type GitExecutableDetection,
} from '../lib/git-executable';
import {
  applyDefaultBranchEffects,
  createDesktopDefaultBranchFacts,
  readDefaultBranchHint,
  type DefaultBranchObservation,
} from '../lib/git-default-branch';
import { resolveHomeBranchRepoPath } from '../lib/home-branch-repo';
import { IdentifierValidationError } from '../lib/identifier-validation-error';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { recordedRepositoryPath } from '../lib/workspace-recorded-repo';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { desktopWorktreeHealthSources } from '../lib/worktree-health';
import { resolveWorktreeRepoPath } from '../lib/worktree-repo-path';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/** The dispatcher surface the `worker.git.*` projections use. */
export interface WorkerGitDispatcher {
  query(
    name: 'worker.git.branch.list',
    params: WorkerGitBranchListParams,
    options: CanopyQueryOptions,
  ): Promise<WorkerGitBranchListResult>;
  query(
    name: 'worker.git.executable.get',
    params: WorkerGitExecutableGetParams,
    options: CanopyQueryOptions,
  ): Promise<WorkerGitExecutableGetResult>;
  query(
    name: 'worker.git.remote.get',
    params: WorkerGitRemoteGetParams,
    options: CanopyQueryOptions,
  ): Promise<WorkerGitRemoteGetResult>;
  query(
    name: 'worker.git.worktree.health.get',
    params: WorkerGitWorktreeHealthGetParams,
    options: CanopyQueryOptions,
  ): Promise<WorkerGitWorktreeHealthGetResult>;
  query(
    name: 'worker.git.diff.get',
    params: WorkerGitDiffGetParams,
    options: CanopyQueryOptions,
  ): Promise<WorkerGitDiffGetResult>;
}

/** The dispatcher surface the `worker.git.*` mutation projections use. */
export interface WorkerGitWriteDispatcher {
  instruction(
    name: 'worker.git.checkout',
    params: WorkerGitCheckoutParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerGitCheckoutResult>;
  instruction(
    name: 'worker.git.branch.create',
    params: WorkerGitBranchCreateParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerGitBranchCreateResult>;
  instruction(
    name: 'worker.git.branch.rename',
    params: WorkerGitBranchRenameParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerGitBranchRenameResult>;
  instruction(
    name: 'worker.git.branch.delete',
    params: WorkerGitBranchDeleteParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerGitBranchDeleteResult>;
}

/**
 * One projected call's adapter context: the freshness hint it supplies and
 * what the host port saw, for the effects after the result.
 */
interface BranchListCapture {
  repoPath?: string;
  now?: number;
  observation: DefaultBranchObservation;
}

const branchListCapture = new AsyncLocalStorage<BranchListCapture>();

// The projection resolves registry-backed scopes before dispatch and keeps
// shared-container run directories on the direct path (CAN-4107 D9).
const APP_MANAGED_CHAT_PROJECT_IDS = new Set([
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
]);

function checkedId(validate: () => void): void {
  try {
    validate();
  } catch (error) {
    if (error instanceof IdentifierValidationError)
      throw new WorkerGitScopeError('invalid', error.message, error);
    throw error;
  }
}

export async function resolveRepository(
  { scope, repository }: WorkerGitBranchListParams,
  signal?: AbortSignal,
): Promise<string | null> {
  const workspaceId = scope.workspaceId ?? '';
  checkedId(() => validateId(workspaceId, 'workspaceId'));
  if (repository.kind === 'reference')
    return resolveHomeBranchRepoPath(workspaceId, signal);
  if (APP_MANAGED_CHAT_PROJECT_IDS.has(workspaceId))
    throw new WorkerGitScopeError(
      'unsupported',
      'App-managed chat scopes are resolved before listing branches.',
    );
  const worktreeId = scope.worktreeId ?? '';
  checkedId(() => validateId(worktreeId, 'worktreeId'));
  checkedId(() => validateOptionalRepoId(scope.repoId, 'repoId'));
  return resolveWorktreeRepoPath({
    projectId: workspaceId,
    worktreeId,
    ...(scope.repoId === undefined ? {} : { repoId: scope.repoId }),
  });
}

/**
 * The desktop host for `worker.git.branch.list`: trusted workspace records
 * locate the repository, and today's Git helpers read it with their
 * environments and caches. Reads only; the projection owns the effects.
 */
export const desktopWorkerGitBranchListHost: WorkerGitBranchListHost<string> = {
  // No enrolled targets: any explicit target is refused.
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  resolveRepository: async (params, { signal }) => {
    const repoPath = await resolveRepository(params, signal);
    const capture = branchListCapture.getStore();
    if (capture && repoPath !== null) capture.repoPath = repoPath;
    return repoPath;
  },
  reads: (repoPath, { signal }) => {
    const capture = branchListCapture.getStore();
    return {
      ...gitBranchListReads(repoPath, signal),
      // The freshness short-circuit is the projection's: other dispatcher
      // callers read no Canopy store and get no hint. It runs inside the
      // listing's parallel default-branch read, as the legacy listing did.
      defaultBranchFacts: createDesktopDefaultBranchFacts(
        repoPath,
        () =>
          capture
            ? readDefaultBranchHint(repoPath, capture.observation, signal)
            : Promise.resolve(null),
        signal,
      ),
    };
  },
  now: () => {
    const now = Date.now();
    const capture = branchListCapture.getStore();
    if (capture) capture.now = now;
    return now;
  },
};

/** One projected executable query's detection and capture of its status. */
interface ExecutableCapture {
  /** The shared live detection the projection started or joined. */
  readonly detection: Promise<GitExecutableDetection>;
  legacy?: GitExecutableStatus;
}

const executableCapture = new AsyncLocalStorage<ExecutableCapture>();

/**
 * The desktop host for `worker.git.executable.get`. Inside the IPC projection
 * it answers from the shared live detection the projection claimed, which
 * applies the preference, environment and Linux effects once per probe for
 * every caller it serves, and captures that detection's status. Any other
 * dispatcher caller gets the pure answer: a running detection it may join,
 * or a preview that changes nothing.
 */
export const desktopWorkerGitExecutableHost: WorkerGitExecutableHost = {
  // No enrolled targets: any explicit target is refused.
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  detect: async ({ recheck }) => {
    const capture = executableCapture.getStore();
    if (!capture) return previewGitExecutable({ force: recheck });
    const detection = await capture.detection;
    capture.legacy = detection.status;
    return detection;
  },
};

/**
 * What the desktop host resolved and read for one projected call: the
 * repository location and `origin`'s URL as Git printed it, which the
 * canonical result withholds for a local remote.
 */
export interface GitRemoteLocation {
  repoPath?: string;
  originUrl?: string;
}

const remoteLocation = new AsyncLocalStorage<GitRemoteLocation>();

async function resolveRemoteRepository({
  scope,
  repository,
}: WorkerGitRemoteGetParams): Promise<string | null> {
  const workspaceId = scope.workspaceId ?? '';
  checkedId(() => validateId(workspaceId, 'workspaceId'));
  if (repository.kind === 'source') {
    const { sourceRepoPath } = await readWorkspaceConfig(workspaceId);
    return sourceRepoPath
      ? resolveWorkspaceReferenceRepoPath(sourceRepoPath)
      : null;
  }
  checkedId(() => validateOptionalRepoId(scope.repoId, 'repoId'));
  return recordedRepositoryPath(
    await readWorkspaceConfig(workspaceId),
    scope.repoId,
  );
}

/**
 * The desktop host for `worker.git.remote.get`: workspace records locate the
 * repository, and today's strict remote and repository probes read it with
 * their environment (D8). Reads only.
 */
export const desktopWorkerGitRemoteHost: WorkerGitRemoteHost<string> = {
  // No enrolled targets: any explicit target is refused.
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  resolveRepository: async (params) => {
    const repoPath = await resolveRemoteRepository(params);
    const location = remoteLocation.getStore();
    if (location && repoPath !== null) location.repoPath = repoPath;
    return repoPath;
  },
  reads: (repoPath) => {
    const location = remoteLocation.getStore();
    return {
      readOriginUrl: async (): Promise<string | null> => {
        const url = await getRemoteUrlStrict(repoPath);
        if (location && url !== null) location.originUrl = url;
        return url;
      },
      isRepository: () => isGitRepo(repoPath),
    };
  },
};

/** The worktree a `worker.git.worktree.health.get` host resolved. */
export interface DesktopHealthWorktree {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
}

/** One projected health query's capture of the host's full issue. */
interface HealthCapture {
  observed: boolean;
  issue: WorktreeHealthIssue | null;
}

const healthCapture = new AsyncLocalStorage<HealthCapture>();

/**
 * The desktop host for `worker.git.worktree.health.get`: trusted workspace
 * records locate the checkout, and today's desktop sources read it. Reads
 * only; the projection records the result.
 */
export const desktopWorkerGitWorktreeHealthHost: WorkerGitWorktreeHealthHost<DesktopHealthWorktree> =
  {
    // No enrolled targets: any explicit target is refused.
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    resolveWorktree: ({ scope }) => {
      const { workspaceId, worktreeId } = scope;
      checkedId(() => validateId(workspaceId, 'workspaceId'));
      if (APP_MANAGED_CHAT_PROJECT_IDS.has(workspaceId))
        throw new WorkerGitScopeError(
          'unsupported',
          'App-managed chat scopes are checked before worktree health.',
        );
      checkedId(() => validateId(worktreeId, 'worktreeId'));
      return Promise.resolve({
        workspaceId,
        worktreeId,
        worktreePath: resolveWorktreeCwd(workspaceId, worktreeId),
      });
    },
    sources: ({ workspaceId, worktreeId, worktreePath }) =>
      desktopWorktreeHealthSources(workspaceId, worktreeId, worktreePath),
    observe: (_worktree, issue) => {
      const capture = healthCapture.getStore();
      if (!capture) return;
      capture.observed = true;
      capture.issue = issue;
    },
  };

/** What the desktop diff host resolved and read for one projected call. */
interface ChangeSetCapture {
  repoPath?: string;
  sample?: GitChangeSetSample;
  /** Set by the diff-stats projection: its legacy-only reads. */
  diffStats?: DiffStatsCapture;
}

interface DiffStatsCapture {
  /** The revision the legacy `--shortstat` compares, the query's `base`. */
  readonly base: string;
  shortstat?: Promise<GitReadOutcome>;
  quotePath?: Promise<boolean | null>;
}

function settled(read: Promise<string>): Promise<GitReadOutcome> {
  return read.then(
    (stdout): GitReadOutcome => ({ ok: true, stdout }),
    (error: unknown): GitReadOutcome => ({ ok: false, error }),
  );
}

function readShortstatOnce(
  repoPath: string,
  diffStats: DiffStatsCapture,
): Promise<GitReadOutcome> {
  diffStats.shortstat ??= settled(readDiffShortstat(repoPath, diffStats.base));
  return diffStats.shortstat;
}

/**
 * The engine's reads, plus, inside the diff-stats projection, the legacy
 * totals' own reads beside them when the engine's cannot supply them:
 * `--shortstat` for the same revision when name-status shows a pairing that
 * may differ or fails, and `core.quotePath` when an untracked name depends on
 * it. Other dispatcher callers run only the engine's reads.
 */
function desktopChangeSetReads(repoPath: string): GitChangeSetReader {
  const reads = gitChangeSetReads(repoPath);
  const diffStats = changeSetCapture.getStore()?.diffStats;
  if (!diffStats) return reads;
  return {
    ...reads,
    read: async (read) => {
      const stdout = await reads.read(read).catch((error: unknown) => {
        if (read.kind === 'diff-name-status')
          void readShortstatOnce(repoPath, diffStats);
        throw error;
      });
      if (read.kind === 'diff-name-status' && nameStatusNeedsShortstat(stdout))
        void readShortstatOnce(repoPath, diffStats);
      if (
        read.kind === 'untracked-files' &&
        untrackedListingNeedsQuotePath(stdout)
      )
        diffStats.quotePath = readGitQuotePath(repoPath);
      return stdout;
    },
  };
}

const changeSetCapture = new AsyncLocalStorage<ChangeSetCapture>();

/**
 * The checkout `repoId` names: the worktree root, or a directory under its
 * `repos/`, as the multi-repository listing enumerates them.
 */
async function resolveDiffRepository({
  scope,
  repoId,
}: WorkerGitDiffGetParams): Promise<string | null> {
  const workspaceId = scope.workspaceId ?? '';
  checkedId(() => validateId(workspaceId, 'workspaceId'));
  if (APP_MANAGED_CHAT_PROJECT_IDS.has(workspaceId))
    throw new WorkerGitScopeError(
      'unsupported',
      'App-managed chat scopes are resolved before reading changes.',
    );
  const worktreeId = scope.worktreeId ?? '';
  checkedId(() => validateId(worktreeId, 'worktreeId'));
  const worktreePath = resolveWorktreeCwd(workspaceId, worktreeId);
  if (repoId === WORKSPACE_ROOT_REPO_ID) return worktreePath;
  if (
    !isMultiRepoWorkspace(workspaceId) ||
    repoId === '.' ||
    repoId === '..' ||
    /[\\/]/.test(repoId)
  )
    return null;
  const repoPath = join(worktreePath, 'repos', repoId);
  const entry = await lstat(repoPath).catch(() => null);
  return entry?.isDirectory() === true ? repoPath : null;
}

/**
 * The desktop host for `worker.git.diff.get`: trusted workspace records
 * locate the checkout, and today's Git environment reads it (D8), patches
 * included. Reads only; fetching and base selection stay in the projection.
 */
export const desktopWorkerGitDiffHost: WorkerGitDiffHost<string> = {
  // No enrolled targets: any explicit target is refused.
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  resolveRepository: async (params) => {
    const repoPath = await resolveDiffRepository(params);
    const capture = changeSetCapture.getStore();
    if (capture && repoPath !== null) capture.repoPath = repoPath;
    return repoPath;
  },
  reads: (repoPath) => desktopChangeSetReads(repoPath),
  patchReads: (repoPath) => gitPatchReads(repoPath),
  observe: (_repoPath, sample) => {
    const capture = changeSetCapture.getStore();
    if (capture) capture.sample = sample;
  },
};
/**
 * The desktop host for the `worker.git` branch writes: trusted workspace
 * records locate the checkout as the branch picker's listing does, or the
 * recorded repository as `worker.git.remote.get` does, and today's Git
 * helpers run in it with their environments (D8). The dispatcher's signal
 * never reaches a mutation (Q11).
 */
export const desktopWorkerGitBranchWriteHost: WorkerGitBranchWriteHost<string> =
  {
    // No enrolled targets: any explicit target is refused.
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    resolveCheckout: (scope) => {
      const { workspaceId, worktreeId, repoId } = scope;
      checkedId(() => validateId(workspaceId, 'workspaceId'));
      if (APP_MANAGED_CHAT_PROJECT_IDS.has(workspaceId))
        throw new WorkerGitScopeError(
          'unsupported',
          'App-managed chat scopes are resolved before changing branches.',
        );
      checkedId(() => validateId(worktreeId, 'worktreeId'));
      checkedId(() => validateOptionalRepoId(repoId, 'repoId'));
      return Promise.resolve(
        resolveWorktreeRepoPath({
          projectId: workspaceId,
          worktreeId,
          ...(repoId === undefined ? {} : { repoId }),
        }),
      );
    },
    port: (checkoutPath, context) =>
      gitBranchWritePort(checkoutPath, context.signal),
    resolveRepository: async ({ workspaceId, repoId }) => {
      checkedId(() => validateId(workspaceId, 'workspaceId'));
      if (APP_MANAGED_CHAT_PROJECT_IDS.has(workspaceId))
        throw new WorkerGitScopeError(
          'unsupported',
          'App-managed chat scopes have no recorded repository.',
        );
      checkedId(() => validateOptionalRepoId(repoId, 'repoId'));
      const repoPath = recordedRepositoryPath(
        await readWorkspaceConfig(workspaceId),
        repoId,
      );
      if (repoPath === null)
        throw new WorkerGitScopeError(
          'unsupported',
          'The workspace records no such repository.',
        );
      return repoPath;
    },
    deletePort: (repoPath) => gitBranchDeletePort(repoPath),
  };

/** `worker.git.*` handlers over the desktop hosts. */
export function createWorkerGitAdapter(
  host: WorkerGitBranchListHost<string> = desktopWorkerGitBranchListHost,
  executableHost: WorkerGitExecutableHost = desktopWorkerGitExecutableHost,
  remoteHost: WorkerGitRemoteHost<string> = desktopWorkerGitRemoteHost,
  healthHost: WorkerGitWorktreeHealthHost<DesktopHealthWorktree> = desktopWorkerGitWorktreeHealthHost,
  diffHost: WorkerGitDiffHost<string> = desktopWorkerGitDiffHost,
  branchWriteHost: WorkerGitBranchWriteHost<string> = desktopWorkerGitBranchWriteHost,
): {
  queries: WorkerGitBranchListHandlers &
    WorkerGitExecutableHandlers &
    WorkerGitRemoteHandlers &
    WorkerGitWorktreeHealthHandlers &
    WorkerGitDiffHandlers;
  instructions: WorkerGitBranchWriteHandlers;
} {
  return {
    queries: {
      ...createWorkerGitBranchListHandlers(host),
      ...createWorkerGitExecutableHandlers(executableHost),
      ...createWorkerGitRemoteHandlers(remoteHost),
      ...createWorkerGitWorktreeHealthHandlers(healthHost),
      ...createWorkerGitDiffHandlers(diffHost),
    },
    instructions: createWorkerGitBranchWriteHandlers(branchWriteHost),
  };
}

/**
 * Dispatches `worker.git.diff.get` in the projection context and returns the
 * checkout and the reads the desktop host captured, whatever the canonical
 * outcome: the legacy changed-files lists are rebuilt from them, and read Git
 * failures as empty. `null` when the call read nothing.
 */
export async function queryChangeSetForLegacyIpc(
  dispatcher: WorkerGitDispatcher,
  params: WorkerGitDiffGetParams,
  options: CanopyQueryOptions,
): Promise<{
  readonly repoPath: string;
  readonly sample: GitChangeSetSample;
} | null> {
  const capture: ChangeSetCapture = {};
  await changeSetCapture
    .run(capture, () =>
      dispatcher.query('worker.git.diff.get', params, options),
    )
    .catch(() => undefined);
  const { repoPath, sample } = capture;
  return repoPath === undefined || sample === undefined
    ? null
    : { repoPath, sample };
}

/**
 * Dispatches `worker.git.diff.get` for `<base>..WORKTREE` in the diff-stats
 * projection context and returns the checkout, the engine's reads and the
 * legacy totals' own reads, whatever the canonical outcome: the legacy stats
 * are rebuilt from them, Git failures included. `null` when the call read
 * nothing.
 */
export async function queryDiffStatsForLegacyIpc(
  dispatcher: WorkerGitDispatcher,
  params: WorkerGitDiffGetParams & {
    readonly base: string;
    readonly head: 'WORKTREE';
  },
  options: CanopyQueryOptions,
): Promise<{
  readonly repoPath: string;
  readonly sample: GitChangeSetSample;
  readonly legacy: LegacyDiffStatsReads;
} | null> {
  const diffStats: DiffStatsCapture = { base: params.base };
  const capture: ChangeSetCapture = { diffStats };
  await changeSetCapture
    .run(capture, () =>
      dispatcher.query('worker.git.diff.get', params, options),
    )
    .catch(() => undefined);
  const { repoPath, sample } = capture;
  if (repoPath === undefined || sample === undefined) return null;
  return {
    repoPath,
    sample,
    legacy: {
      shortstat: () => readShortstatOnce(repoPath, diffStats),
      // Unread: no listed name depends on it.
      quotePath:
        diffStats.quotePath === undefined ? true : await diffStats.quotePath,
    },
  };
}

/**
 * Dispatches `worker.git.worktree.health.get` in the projection context and
 * returns the canonical result with the host's full legacy issue, paths,
 * names, messages and Git error included, for the IPC channel to record and
 * return byte for byte.
 */
export async function queryWorktreeHealthForLegacyIpc(
  dispatcher: WorkerGitDispatcher,
  params: WorkerGitWorktreeHealthGetParams,
  options: CanopyQueryOptions,
): Promise<{
  canonicalResult: WorkerGitWorktreeHealthGetResult;
  legacyResult: WorktreeHealthIssue | null;
}> {
  const capture: HealthCapture = { observed: false, issue: null };
  const canonicalResult = await healthCapture.run(capture, () =>
    dispatcher.query('worker.git.worktree.health.get', params, options),
  );
  if (!capture.observed)
    throw new Error('Worktree health projection was not captured.');
  return { canonicalResult, legacyResult: capture.issue };
}

/**
 * Dispatches `worker.git.executable.get` for the local authority in the
 * projection context and returns the canonical result with the legacy status
 * the shared detection produced, path and message included, for the IPC
 * channels to return byte for byte.
 */
export async function queryGitExecutableForLegacyIpc(
  dispatcher: WorkerGitDispatcher,
  request: { recheck: boolean },
  options: CanopyQueryOptions,
): Promise<{
  canonicalResult: WorkerGitExecutableGetResult;
  legacyResult: GitExecutableStatus;
}> {
  // Only the local scope, which the host never refuses, so the probe claimed
  // below never runs for a scope the host would refuse.
  const params: WorkerGitExecutableGetParams = {
    scope: {},
    recheck: request.recheck,
  };
  // Claimed in the invoking turn, as the direct handlers did, so a direct
  // caller arriving while the dispatcher admits this call joins this probe
  // instead of starting one a forced recheck would not join (CAN-5137).
  const detection = detectGitExecutableShared({ force: params.recheck });
  // The host awaits it; until then a failure must not surface as unhandled.
  void detection.catch(() => undefined);
  const capture: ExecutableCapture = { detection };
  let canonicalResult: WorkerGitExecutableGetResult;
  try {
    canonicalResult = await executableCapture.run(capture, () =>
      dispatcher.query('worker.git.executable.get', params, options),
    );
  } catch (error) {
    // A refused call still lets its probe finish before it rejects.
    await detection.catch(() => undefined);
    throw error;
  }
  if (!capture.legacy)
    throw new Error('Git executable projection was not captured.');
  return { canonicalResult, legacyResult: capture.legacy };
}

/**
 * Dispatches `worker.git.branch.list` with the freshness hint, then applies
 * the effects a remote-verified default earns (freshness record, origin/HEAD
 * repair) as the legacy listing did. Other dispatcher callers get the pure
 * result without the hint.
 */
export async function queryGitBranchListWithEffects(
  dispatcher: WorkerGitDispatcher,
  params: WorkerGitBranchListParams,
  options: CanopyQueryOptions,
): Promise<WorkerGitBranchListResult> {
  const capture: BranchListCapture = { observation: {} };
  const result = await branchListCapture.run(capture, () =>
    dispatcher.query('worker.git.branch.list', params, options),
  );
  if (capture.repoPath !== undefined && capture.now !== undefined)
    await applyDefaultBranchEffects(
      capture.repoPath,
      {
        defaultBranch: result.defaultBranch,
        source: result.defaultBranchSource,
      },
      capture.observation,
      capture.now,
    );
  return result;
}

/**
 * Dispatches `worker.git.remote.get` and records in `location` where the
 * desktop host resolved the repository and the origin URL it read, for
 * projections whose legacy responses carry them. Other dispatcher callers
 * record nothing.
 */
export function queryGitRemoteAtLocation(
  dispatcher: WorkerGitDispatcher,
  params: WorkerGitRemoteGetParams,
  options: CanopyQueryOptions,
  location: GitRemoteLocation,
): Promise<WorkerGitRemoteGetResult> {
  return remoteLocation.run(location, () =>
    dispatcher.query('worker.git.remote.get', params, options),
  );
}

/**
 * The origin URL a legacy response carries: the URL the desktop host read,
 * which a local remote's canonical result withholds, or `null` when `origin`
 * is absent.
 */
export function legacyOriginUrl(
  { origin }: WorkerGitRemoteGetResult,
  location: GitRemoteLocation,
): string | null {
  if (origin.state === 'absent') return null;
  if (location.originUrl === undefined)
    throw new Error('The origin URL was not read in this context.');
  return location.originUrl;
}
