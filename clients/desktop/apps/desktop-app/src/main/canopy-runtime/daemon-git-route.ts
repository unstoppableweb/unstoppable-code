import {
  CanopyClientError,
  type CanopyClientQueryOptions,
} from '@canopy/core-client';
import { randomUUID } from 'node:crypto';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
  type CanopyQueryOptions,
} from '@canopy/core-runtime';
import type { CanopyRuntimeIdentity } from '@canopy/core-client';
import type {
  GitChangeSetSample,
  GitReadOutcome,
} from '@canopy/core-runtime/node/git';
import {
  WORKER_GIT_BRANCH_LIST_ERROR_CODES,
  WORKER_GIT_DIFF_ERROR_CODES,
  WORKER_GIT_DIFF_READS_REVISION,
  WORKER_GIT_WORKTREE_HEALTH_ERROR_CODES,
  WorkerGitBranchListResultSchema,
  WorkerGitDiffGetResultSchema,
  WorkerGitWorktreeHealthGetResultSchema,
  type CanopyCallerDescriptor,
  type CanopyErrorKind,
  type CanopyHostExecution,
  type WorkerGitBranchListParams,
  type WorkerGitBranchListResult,
  type WorkerGitDiffGetParams,
  type WorkerGitDiffRead,
  type WorkerGitDiffReads,
  type WorkerGitWorktreeHealthGetParams,
  type WorkerGitWorktreeHealthGetResult,
} from '@canopy/protocol/canopy-core';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import { assertWorkingDirectoryAvailable } from '@canopy/desktop-shared/node/lib/working-directory';
import { estimateUntrackedChanges } from '../lib/untracked-line-estimate';
import {
  applyDefaultBranchEffects,
  readDefaultBranchHint,
  type DefaultBranchObservation,
} from '../lib/git-default-branch';
import { resolveDiffRepository, resolveRepository } from './worker-git-adapter';
import { daemonGitRequestExecution } from './daemon-git-environment';
import {
  evaluateReadRoute,
  resolveReadRoutePlatform,
  type ReadRouteLookups,
  type ReadRoutePlatform,
} from './daemon-read-route-guard';
import type {
  ElectronDaemonCallerLifetime,
  CallerLifetimeSender,
} from './electron-daemon-caller-lifetime';

export interface DaemonGitQueryClient {
  readonly signal: AbortSignal;
  /** The attached daemon's handshake; absent on a test double. */
  readonly identity?: Pick<
    CanopyRuntimeIdentity,
    'runtimeId' | 'daemonEpoch' | 'buildVersion'
  >;
  /** Each route validates the answer against its operation's result schema. */
  query(
    name:
      | 'worker.git.branch.list'
      | 'worker.git.worktree.health.get'
      | 'worker.git.diff.get',
    params:
      | WorkerGitBranchListParams
      | WorkerGitWorktreeHealthGetParams
      | WorkerGitDiffGetParams,
    options?: CanopyClientQueryOptions,
  ): Promise<unknown>;
}

/** The reads this route may send to the daemon. */
export type DaemonGitRouteOperation =
  | 'git.branch.list'
  | 'git.worktree.health.get'
  | 'git.diff.get';

/** One comparison of `activity:changed-files`, with its base resolved. */
export type DaemonChangeSetParams = Omit<
  WorkerGitDiffGetParams,
  'revision' | 'paths' | 'contextLines'
> & { readonly base: string };

export interface DaemonGitRouteRequest {
  readonly sender: CallerLifetimeSender & { readonly id: number };
  /**
   * The sender's document owner when the request arrived (`ownerFor`), so
   * work the handler does first cannot pass to a replacement document.
   */
  readonly owner?: AbortSignal;
}

export interface DaemonGitRouteOptions {
  readonly lifetime: ElectronDaemonCallerLifetime;
  readonly connections: () => {
    get(
      caller: CanopyCallerDescriptor,
      owner: AbortSignal,
    ): Promise<{ readonly client: DaemonGitQueryClient }>;
  };
  readonly hostContext: () => Promise<{ readonly authorityId: string }>;
  readonly workspaceType: (workspaceId: string) => WorkspaceType | null;
  readonly resolveWorktreeTargetIds: ReadRouteLookups['resolveWorktreeTargetIds'];
  readonly platform?: ReadRoutePlatform | null;
  /** Test-only selection; production uses {@link DAEMON_GIT_PRODUCTION_SELECTION}. */
  readonly selectable?: ReadonlySet<DaemonGitRouteOperation>;
  readonly queryDeadlineMs?: number;
  readonly execution?: () => CanopyHostExecution;
  readonly repositoryPath?: (
    params: WorkerGitBranchListParams,
  ) => Promise<string | null>;
  /**
   * Whether main reads the workspace manifest the way the daemon will. The
   * daemon refuses a workspace whose manifest it cannot read, while main still
   * records an issue, so health stays in process then; without this input
   * health is never routed.
   */
  readonly workspaceManifestReadable?: (
    workspaceId: string,
  ) => Promise<boolean>;
  /** The checkout a diff scope names in main; defaults to the in-process host's. */
  readonly diffRepositoryPath?: (
    params: DaemonChangeSetParams,
  ) => Promise<string | null>;
  /**
   * Whether the daemon's recorded resolver names `repoPath` for this
   * comparison; without this input changed files are never routed.
   */
  readonly diffScopeAdmitted?: (
    params: DaemonChangeSetParams,
    repoPath: string,
    context: CanopyHandlerContext,
  ) => Promise<boolean>;
}

export interface DaemonGitRoute {
  branchList(
    params: WorkerGitBranchListParams,
    options: CanopyQueryOptions,
    request: DaemonGitRouteRequest,
    direct: () => Promise<WorkerGitBranchListResult>,
  ): Promise<WorkerGitBranchListResult>;
  /**
   * Codes only (q-49): the private issue detail stays in main (CAN-7188).
   * `settle` runs main's follow-up on a daemon answer within the request's
   * lifetime; a retired document or the deadline ends it, and the route
   * checks the request again before handing the answer back to be recorded.
   */
  worktreeHealth(
    params: WorkerGitWorktreeHealthGetParams,
    options: CanopyQueryOptions,
    request: DaemonGitRouteRequest,
    direct: () => Promise<WorkerGitWorktreeHealthGetResult>,
    settle?: (result: WorkerGitWorktreeHealthGetResult) => Promise<void>,
  ): Promise<WorkerGitWorktreeHealthGetResult>;
  /**
   * A comparison's reads for the legacy changed-files lists (CAN-4729):
   * revision 3's answer as the sample the in-process call captures. A scope
   * main resolves to a checkout other than `repoPath` reads in process.
   */
  changeSet(
    params: DaemonChangeSetParams,
    repoPath: string,
    options: CanopyQueryOptions,
    request: DaemonGitRouteRequest,
    direct: () => Promise<GitChangeSetSample | null>,
  ): Promise<GitChangeSetSample | null>;
  /** The sender's current document owner, for `DaemonGitRouteRequest.owner`. */
  ownerFor(sender: DaemonGitRouteRequest['sender']): AbortSignal;
  dispose(): void;
}

const EXCLUDED_WORKSPACES = new Set([
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
]);
// The daemon's recorded Git reader refuses cowork records, so cowork branch
// lists and health checks (and the standalone-chat sentinel resolving to one)
// stay in process.
// shortcut: the daemon's reader refuses every scope while one index row is unreadable, with no fallback; CAN-7675 fixes the reader for branch lists and health.
const ROUTED_WORKSPACE_TYPES: ReadonlySet<WorkspaceType> = new Set([
  'single-repo',
  'multi-repo',
]);

/**
 * Per-platform production selection (CAN-4729, GA4b): reads that may leave
 * for the daemon. Windows waits on CAN-4732 and CAN-5943. Listed literally,
 * so a new read never becomes selectable by accident.
 */
export const DAEMON_GIT_PRODUCTION_SELECTION: Readonly<
  Record<ReadRoutePlatform, ReadonlySet<DaemonGitRouteOperation>>
> = {
  darwin: new Set([
    'git.branch.list',
    'git.worktree.health.get',
    'git.diff.get',
  ]),
  win32: new Set(),
  linux: new Set([
    'git.branch.list',
    'git.worktree.health.get',
    'git.diff.get',
  ]),
};
const NO_SELECTION: ReadonlySet<DaemonGitRouteOperation> = new Set();
const BRANCH_LIST = "Couldn't list branches.";
const WORKTREE_HEALTH = "Couldn't check the worktree.";
export const CHANGED_FILES = "Couldn't list changed files.";

function failure(kind: CanopyErrorKind, message: string): CanopyOperationError {
  return new CanopyOperationError({ kind, message, retry: { kind: 'never' } });
}

/** Wire errors have no host cause. Keep only this operation's declared codes. */
function typedFailure(
  error: unknown,
  codes: readonly string[],
  action: string,
): CanopyOperationError {
  if (
    !(
      error instanceof CanopyClientError ||
      error instanceof CanopyOperationError
    )
  )
    return failure('internal', action);
  const { code, ...payload } = error.payload;
  return new CanopyOperationError({
    ...payload,
    ...(codes.some((declared) => declared === code) && { code }),
    retry:
      payload.retry.kind === 'after_refresh'
        ? payload.retry
        : { kind: 'never' },
  });
}

export function untilAborted<T>(
  read: Promise<T>,
  signal: AbortSignal,
  action: string,
): Promise<T> {
  if (signal.aborted) {
    void read.catch(() => undefined);
    return Promise.reject(
      failure('cancelled', `${action} The request was cancelled.`),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(failure('cancelled', `${action} The request was cancelled.`));
    };
    signal.addEventListener('abort', abort, { once: true });
    void read
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** A revision-3 read as the in-process outcome: over its bound, legacy blanks it. */
function readOutcome(read: WorkerGitDiffRead): GitReadOutcome {
  return read.ok && read.overCap !== true
    ? { ok: true, stdout: read.fields.map((field) => `${field}\0`).join('') }
    : { ok: false, error: read };
}

function rangeOf({
  base,
  head,
}: DaemonChangeSetParams): GitChangeSetSample['range'] {
  return head === 'WORKTREE'
    ? { kind: 'worktree', base }
    : { kind: 'objects', base, head };
}

/** Every read failed with `error`, as the in-process call captures it. */
function failedSample(
  params: DaemonChangeSetParams,
  error: unknown,
): GitChangeSetSample {
  const failed: GitReadOutcome = { ok: false, error };
  const worktree = params.head === 'WORKTREE';
  return {
    range: rangeOf(params),
    nameStatus: failed,
    numstat: failed,
    untracked: worktree ? failed : null,
    unmerged: worktree ? failed : null,
    untrackedEstimates: [],
  };
}

async function changeSetSample(
  params: DaemonChangeSetParams,
  repoPath: string,
  reads: WorkerGitDiffReads,
): Promise<GitChangeSetSample> {
  const estimated = reads.untrackedEstimates;
  const listed =
    reads.untracked?.ok === true && reads.untracked.overCap !== true
      ? reads.untracked.fields.slice(0, estimated.length)
      : null;
  return {
    range: rangeOf(params),
    nameStatus: readOutcome(reads.nameStatus),
    numstat: readOutcome(reads.numstat),
    untracked: reads.untracked && readOutcome(reads.untracked),
    unmerged: reads.unmerged && readOutcome(reads.unmerged),
    // A confined skip is re-estimated as in process, over the whole prefix:
    // the 100,000-line running ceiling is the estimator's own, not per file.
    untrackedEstimates:
      listed !== null && estimated.some(({ confined }) => confined === true)
        ? await estimateUntrackedChanges(repoPath, listed)
        : estimated.map(({ insertions, binary }) => ({ insertions, binary })),
  };
}

/** Decide once before contact. Selected reads never fall back, even on disconnect. */
export function createDaemonGitRoute(
  options: DaemonGitRouteOptions,
): DaemonGitRoute {
  const platform =
    options.platform === undefined
      ? resolveReadRoutePlatform()
      : options.platform;
  const selectable =
    options.selectable ??
    (platform === null
      ? NO_SELECTION
      : DAEMON_GIT_PRODUCTION_SELECTION[platform]);
  const lifetime = new AbortController();
  return {
    async branchList(
      params,
      context,
      request,
      direct,
    ): Promise<WorkerGitBranchListResult> {
      const target =
        !lifetime.signal.aborted && selectable.has('git.branch.list')
          ? evaluateReadRoute({
              operation: 'git.branch.list',
              platform,
              caller: context.caller,
              senderId: request.sender.id,
              scope: params.scope,
              lookups: {
                workspaceType: options.workspaceType,
                resolveWorktreeTargetIds: options.resolveWorktreeTargetIds,
                excludedWorkspaceIds: EXCLUDED_WORKSPACES,
                routedWorkspaceTypes: ROUTED_WORKSPACE_TYPES,
              },
            })
          : null;
      if (target?.shape !== 'repository') return direct();
      const scope = {
        workspaceId: target.workspaceId,
        ...(target.worktreeId !== undefined && {
          worktreeId: target.worktreeId,
        }),
        ...(target.repoId !== undefined && { repoId: target.repoId }),
      };
      const selected: WorkerGitBranchListParams = {
        repository: params.repository,
        scope,
        ...(params.includeHeadState ? { includeHeadState: true } : {}),
        ...(params.exactWorktreeBaseBranch
          ? { exactWorktreeBaseBranch: true }
          : {}),
      };
      const now = Date.now();
      const owner = request.owner ?? options.lifetime.ownerFor(request.sender);
      const deadline = AbortSignal.timeout(options.queryDeadlineMs ?? 60_000);
      const signal = AbortSignal.any([
        owner,
        lifetime.signal,
        deadline,
        ...(context.signal ? [context.signal] : []),
      ]);
      const observation: DefaultBranchObservation = {};
      const read = async (): Promise<{
        repoPath: string;
        result: WorkerGitBranchListResult;
      }> => {
        signal.throwIfAborted();
        const repoPath = await (options.repositoryPath ?? resolveRepository)(
          selected,
        );
        signal.throwIfAborted();
        if (repoPath === null)
          throw new CanopyOperationError({
            kind: 'failed_precondition',
            code: 'worker.git.branch.repositoryUnavailable',
            message: 'The workspace has no source repository.',
            retry: { kind: 'never' },
          });
        const hint = await readDefaultBranchHint(repoPath, observation);
        signal.throwIfAborted();
        const host = await options.hostContext();
        signal.throwIfAborted();
        const session = await options
          .connections()
          .get({ ...context.caller, authorityId: host.authorityId }, owner);
        signal.throwIfAborted();
        const client = session.client;
        const querySignal = AbortSignal.any([signal, client.signal]);
        const assertActive = (): void => {
          signal.throwIfAborted();
          if (client.signal.aborted)
            throw failure(
              'unavailable',
              "Couldn't list branches. The background service disconnected.",
            );
        };
        assertActive();
        let result: unknown;
        try {
          result = await untilAborted(
            client.query(
              'worker.git.branch.list',
              {
                ...selected,
                scope: { ...scope, authorityId: host.authorityId },
                ...(hint && {
                  defaultBranchHint: {
                    defaultBranch: hint.defaultBranch,
                    // The legacy store accepts any Date.parse spelling; the wire is UTC.
                    resolvedAt: new Date(hint.resolvedAt).toISOString(),
                  },
                }),
              },
              {
                signal: querySignal,
                metadata: {
                  deadlineAt: new Date(
                    now + (options.queryDeadlineMs ?? 60_000),
                  ).toISOString(),
                },
                execution:
                  options.execution?.() ??
                  daemonGitRequestExecution('repository-read'),
              },
            ),
            querySignal,
            BRANCH_LIST,
          );
        } catch (error) {
          if (client.signal.aborted && !signal.aborted)
            throw failure(
              'unavailable',
              "Couldn't list branches. The background service disconnected.",
            );
          throw error;
        }
        assertActive();
        const parsed = WorkerGitBranchListResultSchema.safeParse(result);
        if (!parsed.success)
          throw failure(
            'internal',
            "Couldn't list branches. The background service returned an unreadable response.",
          );
        return { repoPath, result: parsed.data };
      };
      try {
        const { repoPath, result } = await untilAborted(
          read(),
          signal,
          BRANCH_LIST,
        );
        signal.throwIfAborted();
        // Effects cannot be rolled back; once they begin, drain them before success.
        await applyDefaultBranchEffects(
          repoPath,
          {
            defaultBranch: result.defaultBranch,
            source: result.defaultBranchSource,
          },
          observation,
          now,
        );
        return result;
      } catch (error) {
        if (deadline.aborted)
          throw failure(
            'deadline_exceeded',
            "Couldn't list branches. The background service took too long to respond.",
          );
        if (signal.aborted)
          throw failure(
            'cancelled',
            "Couldn't list branches. The request was cancelled.",
          );
        throw typedFailure(
          error,
          WORKER_GIT_BRANCH_LIST_ERROR_CODES,
          BRANCH_LIST,
        );
      }
    },
    async worktreeHealth(
      params,
      context,
      request,
      direct,
      settle,
    ): Promise<WorkerGitWorktreeHealthGetResult> {
      const target =
        !lifetime.signal.aborted && selectable.has('git.worktree.health.get')
          ? evaluateReadRoute({
              operation: 'git.worktree.health.get',
              platform,
              caller: context.caller,
              senderId: request.sender.id,
              scope: params.scope,
              lookups: {
                workspaceType: options.workspaceType,
                resolveWorktreeTargetIds: options.resolveWorktreeTargetIds,
                excludedWorkspaceIds: EXCLUDED_WORKSPACES,
                routedWorkspaceTypes: ROUTED_WORKSPACE_TYPES,
              },
            })
          : null;
      if (target?.shape !== 'worktree') return direct();
      const scope = {
        workspaceId: target.workspaceId,
        worktreeId: target.worktreeId,
      };
      const deadlineMs = options.queryDeadlineMs ?? 60_000;
      const deadlineAt = new Date(Date.now() + deadlineMs).toISOString();
      // Held before the manifest read, so a document retired during it cancels the check.
      const owner = request.owner ?? options.lifetime.ownerFor(request.sender);
      const deadline = AbortSignal.timeout(deadlineMs);
      const signal = AbortSignal.any([
        owner,
        lifetime.signal,
        deadline,
        ...(context.signal ? [context.signal] : []),
      ]);
      const aborted = (): CanopyOperationError | null => {
        if (deadline.aborted)
          return failure(
            'deadline_exceeded',
            `${WORKTREE_HEALTH} The background service took too long to respond.`,
          );
        return signal.aborted
          ? failure(
              'cancelled',
              `${WORKTREE_HEALTH} The request was cancelled.`,
            )
          : null;
      };
      let readable: boolean;
      try {
        readable = await untilAborted(
          options.workspaceManifestReadable?.(target.workspaceId) ??
            Promise.resolve(false),
          signal,
          WORKTREE_HEALTH,
        );
      } catch (error) {
        throw aborted() ?? error;
      }
      if (!readable) return direct();
      const disconnected = (): CanopyOperationError =>
        failure(
          'unavailable',
          `${WORKTREE_HEALTH} The background service disconnected.`,
        );
      const read = async (): Promise<WorkerGitWorktreeHealthGetResult> => {
        signal.throwIfAborted();
        const host = await options.hostContext();
        signal.throwIfAborted();
        const { client } = await options
          .connections()
          .get({ ...context.caller, authorityId: host.authorityId }, owner);
        signal.throwIfAborted();
        if (client.signal.aborted) throw disconnected();
        const querySignal = AbortSignal.any([signal, client.signal]);
        let result: unknown;
        try {
          result = await untilAborted(
            client.query(
              'worker.git.worktree.health.get',
              { scope: { ...scope, authorityId: host.authorityId } },
              {
                signal: querySignal,
                metadata: { deadlineAt },
                execution:
                  options.execution?.() ??
                  daemonGitRequestExecution('repository-read'),
              },
            ),
            querySignal,
            WORKTREE_HEALTH,
          );
        } catch (error) {
          if (client.signal.aborted && !signal.aborted) throw disconnected();
          throw error;
        }
        signal.throwIfAborted();
        if (client.signal.aborted) throw disconnected();
        const parsed = WorkerGitWorktreeHealthGetResultSchema.safeParse(result);
        if (!parsed.success)
          throw failure(
            'internal',
            `${WORKTREE_HEALTH} The background service returned an unreadable response.`,
          );
        // Git it has started may finish after an abort; its answer is dropped.
        await settle?.(parsed.data);
        return parsed.data;
      };
      try {
        const result = await untilAborted(read(), signal, WORKTREE_HEALTH);
        // No event turn lies between this check and the caller's record.
        signal.throwIfAborted();
        return result;
      } catch (error) {
        throw (
          aborted() ??
          typedFailure(
            error,
            WORKER_GIT_WORKTREE_HEALTH_ERROR_CODES,
            WORKTREE_HEALTH,
          )
        );
      }
    },
    async changeSet(
      params,
      repoPath,
      context,
      request,
      direct,
    ): Promise<GitChangeSetSample | null> {
      const target =
        !lifetime.signal.aborted && selectable.has('git.diff.get')
          ? evaluateReadRoute({
              operation: 'git.diff.get',
              platform,
              caller: context.caller,
              senderId: request.sender.id,
              scope: params.scope,
              lookups: {
                workspaceType: options.workspaceType,
                resolveWorktreeTargetIds: options.resolveWorktreeTargetIds,
                excludedWorkspaceIds: EXCLUDED_WORKSPACES,
                routedWorkspaceTypes: ROUTED_WORKSPACE_TYPES,
              },
            })
          : null;
      const { diffScopeAdmitted } = options;
      if (
        target?.shape !== 'repository' ||
        target.worktreeId === undefined ||
        diffScopeAdmitted === undefined
      )
        return direct();
      const scope = {
        workspaceId: target.workspaceId,
        worktreeId: target.worktreeId,
      };
      const deadlineMs = options.queryDeadlineMs ?? 60_000;
      const deadlineAt = new Date(Date.now() + deadlineMs).toISOString();
      // Held before resolution and admission, so a document retired during
      // them cancels the read.
      const owner = request.owner ?? options.lifetime.ownerFor(request.sender);
      const deadline = AbortSignal.timeout(deadlineMs);
      const signal = AbortSignal.any([
        owner,
        lifetime.signal,
        deadline,
        ...(context.signal ? [context.signal] : []),
      ]);
      // A scope main cannot resolve or admit gets the in-process call's own answer.
      const admission = (async (): Promise<boolean> => {
        const resolved = await (
          options.diffRepositoryPath ?? resolveDiffRepository
        )(params).catch(() => null);
        return (
          resolved === repoPath &&
          (await diffScopeAdmitted({ ...params, scope }, repoPath, {
            requestId: randomUUID(),
            caller: context.caller,
            metadata: {},
            signal,
          }).catch(() => false))
        );
      })();
      // Both stages read the filesystem; a retired document or the deadline
      // settles the request without waiting for them.
      const admitted = await untilAborted(
        admission,
        signal,
        CHANGED_FILES,
      ).catch((error: unknown): never => {
        throw deadline.aborted
          ? failure(
              'deadline_exceeded',
              `${CHANGED_FILES} The background service took too long to respond.`,
            )
          : error;
      });
      if (!admitted) return direct();
      const disconnected = (): CanopyOperationError =>
        failure(
          'unavailable',
          `${CHANGED_FILES} The background service disconnected.`,
        );
      const read = async (): Promise<GitChangeSetSample> => {
        signal.throwIfAborted();
        const host = await options.hostContext();
        signal.throwIfAborted();
        // shortcut: the first read after launch sets up the daemon connection (~1.1 s vs ~0.37 s in process), warm the daemon connection at launch once routed reads are the default
        const { client } = await options
          .connections()
          .get({ ...context.caller, authorityId: host.authorityId }, owner);
        signal.throwIfAborted();
        if (client.signal.aborted) throw disconnected();
        // A folder being retired fails its reads, as Git in process would.
        try {
          await assertWorkingDirectoryAvailable(repoPath);
        } catch (error) {
          return failedSample(params, error);
        }
        const querySignal = AbortSignal.any([signal, client.signal]);
        let result: unknown;
        try {
          result = await untilAborted(
            client.query(
              'worker.git.diff.get',
              {
                scope: { ...scope, authorityId: host.authorityId },
                repoId: params.repoId,
                base: params.base,
                head: params.head,
                revision: WORKER_GIT_DIFF_READS_REVISION,
              },
              {
                signal: querySignal,
                metadata: { deadlineAt },
                execution:
                  options.execution?.() ??
                  daemonGitRequestExecution('repository-read'),
              },
            ),
            querySignal,
            CHANGED_FILES,
          );
        } catch (error) {
          if (client.signal.aborted && !signal.aborted) throw disconnected();
          throw error;
        }
        signal.throwIfAborted();
        if (client.signal.aborted) throw disconnected();
        const parsed = WorkerGitDiffGetResultSchema.safeParse(result);
        if (!parsed.success || parsed.data.reads === undefined)
          throw failure(
            'internal',
            `${CHANGED_FILES} The background service returned an unreadable response.`,
          );
        return changeSetSample(params, repoPath, parsed.data.reads);
      };
      try {
        const sample = await untilAborted(read(), signal, CHANGED_FILES);
        signal.throwIfAborted();
        return sample;
      } catch (error) {
        if (deadline.aborted)
          throw failure(
            'deadline_exceeded',
            `${CHANGED_FILES} The background service took too long to respond.`,
          );
        if (signal.aborted)
          throw failure(
            'cancelled',
            `${CHANGED_FILES} The request was cancelled.`,
          );
        throw typedFailure(error, WORKER_GIT_DIFF_ERROR_CODES, CHANGED_FILES);
      }
    },
    ownerFor: (sender) => options.lifetime.ownerFor(sender),
    dispose: (): void => lifetime.abort(),
  };
}
