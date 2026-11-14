import type {
  CanopyQueryHandler,
  WorkerGitBranchListParams,
  WorkerGitBranchListResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import { listGitBranches, type GitBranchListSources } from './branch-list';
import {
  selectGitDefaultBranch,
  type GitDefaultBranchFacts,
  type GitDefaultBranchHint,
} from './default-branch';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';

/**
 * Thrown by a host resolver that refuses a scope. `invalid` scopes name a
 * missing or malformed identifier; `unsupported` scopes name app-managed chat
 * containers the caller must resolve first. `hostCause` keeps the host's own
 * error for in-process projections.
 */
export class WorkerGitScopeError extends Error {
  public readonly reason: 'invalid' | 'unsupported';
  public readonly hostCause: unknown;

  public constructor(
    reason: 'invalid' | 'unsupported',
    message: string,
    hostCause?: unknown,
  ) {
    super(message);
    this.name = 'WorkerGitScopeError';
    this.reason = reason;
    this.hostCause = hostCause;
  }
}

export interface WorkerGitRepositoryReads {
  readBranchRefs: GitBranchListSources<unknown>['readBranchRefs'];
  readWorktreeList: GitBranchListSources<unknown>['readWorktreeList'];
  defaultBranchFacts: GitDefaultBranchFacts;
  /** Older/unsupported hosts omit this advisory read. */
  readHeadUnborn?(): Promise<boolean | undefined>;
}

/**
 * Host port for `worker.git.branch.list`. The host maps the scope to a
 * repository from trusted records and supplies read-only Git reads for it;
 * repository handles and paths never leave the host.
 */
export interface WorkerGitBranchListHost<
  Repository,
> extends WorkerGitServedSelection {
  /** `null` when a `reference` workspace has no source repository. */
  resolveRepository(
    params: WorkerGitBranchListParams,
    context: CanopyHandlerContext,
  ): Promise<Repository | null>;
  reads(
    repository: Repository,
    context: CanopyHandlerContext,
  ): WorkerGitRepositoryReads;
  now(): number;
}

export interface WorkerGitBranchListHandlers {
  'worker.git.branch.list': CanopyQueryHandler<
    'worker.git.branch.list',
    CanopyHandlerContext
  >;
}

function scopeError(
  reason: 'invalid' | 'unsupported',
  message: string,
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    reason === 'invalid'
      ? {
          kind: 'invalid_argument',
          code: 'worker.git.branch.invalidScope',
          message: message.slice(0, 4_096),
          retry: { kind: 'never' },
        }
      : {
          kind: 'failed_precondition',
          code: 'worker.git.branch.scopeUnsupported',
          message: message.slice(0, 4_096),
          retry: { kind: 'never' },
        },
    cause,
  );
}

function assertScopeShape(params: WorkerGitBranchListParams): void {
  const { scope, repository } = params;
  if (!scope.workspaceId)
    throw scopeError('invalid', 'A workspace is required.');
  if (repository.kind === 'checkout' && !scope.worktreeId)
    throw scopeError('invalid', 'A checkout requires a worktree.');
  if (
    repository.kind === 'reference' &&
    (scope.worktreeId !== undefined || scope.repoId !== undefined)
  )
    throw scopeError(
      'invalid',
      'The reference repository takes no worktree or repository.',
    );
}

export function createWorkerGitBranchListHandlers<Repository>(
  host: WorkerGitBranchListHost<Repository>,
): WorkerGitBranchListHandlers {
  return {
    'worker.git.branch.list': async (
      params,
      context,
    ): Promise<WorkerGitBranchListResult> => {
      assertScopeShape(params);
      assertWorkerGitServedSelection(params.scope, host);
      let repository: Repository | null;
      try {
        repository = await host.resolveRepository(params, context);
      } catch (error) {
        if (error instanceof WorkerGitScopeError)
          throw scopeError(error.reason, error.message, error.hostCause);
        throw error;
      }
      if (repository === null)
        throw new CanopyOperationError({
          kind: 'failed_precondition',
          code: 'worker.git.branch.repositoryUnavailable',
          message: 'The workspace has no source repository.',
          retry: { kind: 'never' },
        });
      const reads = host.reads(repository, context);
      // Hints affect only read-only selection; host scope and grants still apply.
      const facts =
        params.defaultBranchHint === undefined
          ? reads.defaultBranchFacts
          : {
              ...reads.defaultBranchFacts,
              readHint: (): Promise<GitDefaultBranchHint | null> =>
                Promise.resolve(params.defaultBranchHint ?? null),
            };
      const now = host.now();
      const [listed, headUnborn] = await Promise.all([
        listGitBranches(
          {
            readBranchRefs: reads.readBranchRefs,
            readWorktreeList: reads.readWorktreeList,
            resolveDefaultBranch: () =>
              selectGitDefaultBranch(facts, {
                now,
                allowRemoteLookup: params.allowRemoteLookup,
              }),
          },
          (selection) => selection.defaultBranch,
          params.exactWorktreeBaseBranch === true ||
            context.caller.interfaceKind === 'portal',
        ),
        params.includeHeadState
          ? reads.readHeadUnborn?.().catch(() => undefined)
          : undefined,
      ]);
      return {
        branches: listed.branches,
        defaultBranch: listed.defaultBranch.defaultBranch,
        defaultBranchSource: listed.defaultBranch.source,
        ...(headUnborn === undefined ? {} : { headUnborn }),
      };
    },
  };
}
