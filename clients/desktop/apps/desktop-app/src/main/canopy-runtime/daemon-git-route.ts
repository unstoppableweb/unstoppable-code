import {
  CanopyClientError,
  type CanopyClientQueryOptions,
} from '@canopy/core-client';
import {
  CanopyOperationError,
  type CanopyQueryOptions,
} from '@canopy/core-runtime';
import {
  WORKER_GIT_BRANCH_LIST_ERROR_CODES,
  WORKER_GIT_WORKTREE_HEALTH_ERROR_CODES,
  WorkerGitBranchListResultSchema,
  WorkerGitWorktreeHealthGetResultSchema,
  type CanopyCallerDescriptor,
  type CanopyErrorKind,
  type CanopyHostExecution,
  type WorkerGitBranchListParams,
  type WorkerGitBranchListResult,
  type WorkerGitWorktreeHealthGetParams,
  type WorkerGitWorktreeHealthGetResult,
} from '@canopy/protocol/canopy-core';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import {
  applyDefaultBranchEffects,
  readDefaultBranchHint,
  type DefaultBranchObservation,
} from '../lib/git-default-branch';
import { resolveRepository } from './worker-git-adapter';
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
  /** Each route validates the answer against its operation's result schema. */
  query(
    name: 'worker.git.branch.list' | 'worker.git.worktree.health.get',
    params: WorkerGitBranchListParams | WorkerGitWorktreeHealthGetParams,
    options?: CanopyClientQueryOptions,
  ): Promise<unknown>;
}

/** The reads this route may send to the daemon. */
export type DaemonGitRouteOperation =
  | 'git.branch.list'
  | 'git.worktree.health.get';

export interface DaemonGitRouteRequest {
  readonly sender: CallerLifetimeSender & { readonly id: number };
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
  darwin: new Set(['git.branch.list', 'git.worktree.health.get']),
  win32: new Set(),
  linux: new Set(['git.branch.list', 'git.worktree.health.get']),
};
const NO_SELECTION: ReadonlySet<DaemonGitRouteOperation> = new Set();
const BRANCH_LIST = "Couldn't list branches.";
const WORKTREE_HEALTH = "Couldn't check the worktree.";

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

function untilAborted<T>(
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
      const owner = options.lifetime.ownerFor(request.sender);
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
      const owner = options.lifetime.ownerFor(request.sender);
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
    dispose: (): void => lifetime.abort(),
  };
}
