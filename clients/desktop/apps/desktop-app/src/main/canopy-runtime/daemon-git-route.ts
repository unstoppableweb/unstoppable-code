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
  WorkerGitBranchListResultSchema,
  type CanopyCallerDescriptor,
  type CanopyErrorKind,
  type CanopyHostExecution,
  type WorkerGitBranchListParams,
  type WorkerGitBranchListResult,
} from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_PROJECT_ID,
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
  query(
    name: 'worker.git.branch.list',
    params: WorkerGitBranchListParams,
    options?: CanopyClientQueryOptions,
  ): Promise<WorkerGitBranchListResult>;
}

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
  /** Test-only selection; production selects nothing until CAN-4729. */
  readonly selectable?: ReadonlySet<'git.branch.list'>;
  readonly queryDeadlineMs?: number;
  readonly execution?: () => CanopyHostExecution;
  readonly repositoryPath?: (
    params: WorkerGitBranchListParams,
  ) => Promise<string | null>;
}

export interface DaemonGitRoute {
  branchList(
    params: WorkerGitBranchListParams,
    options: CanopyQueryOptions,
    request: DaemonGitRouteRequest,
    direct: () => Promise<WorkerGitBranchListResult>,
  ): Promise<WorkerGitBranchListResult>;
  dispose(): void;
}

const EXCLUDED_WORKSPACES = new Set([
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
]);
const WORKSPACE_TYPES: ReadonlySet<WorkspaceType> = new Set([
  'single-repo',
  'multi-repo',
  'cowork',
]);
const PRODUCTION_SELECTION: ReadonlySet<'git.branch.list'> = new Set();

function failure(kind: CanopyErrorKind, message: string): CanopyOperationError {
  return new CanopyOperationError({ kind, message, retry: { kind: 'never' } });
}

/** Wire errors have no host cause. Keep only this operation's declared codes. */
function typedFailure(error: unknown): CanopyOperationError {
  if (
    !(
      error instanceof CanopyClientError ||
      error instanceof CanopyOperationError
    )
  )
    return failure('internal', "Couldn't list branches.");
  const { code, ...payload } = error.payload;
  return new CanopyOperationError({
    ...payload,
    ...(WORKER_GIT_BRANCH_LIST_ERROR_CODES.some(
      (declared) => declared === code,
    ) && { code }),
    retry:
      payload.retry.kind === 'after_refresh'
        ? payload.retry
        : { kind: 'never' },
  });
}

function untilAborted<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void read.catch(() => undefined);
    return Promise.reject(
      failure(
        'cancelled',
        "Couldn't list branches. The request was cancelled.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(
        failure(
          'cancelled',
          "Couldn't list branches. The request was cancelled.",
        ),
      );
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
  const selectable = options.selectable ?? PRODUCTION_SELECTION;
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
                routedWorkspaceTypes: WORKSPACE_TYPES,
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
        let result: WorkerGitBranchListResult;
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
        const { repoPath, result } = await untilAborted(read(), signal);
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
        throw typedFailure(error);
      }
    },
    dispose: (): void => lifetime.abort(),
  };
}
