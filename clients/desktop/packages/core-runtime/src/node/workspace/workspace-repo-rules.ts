import type {
  CanopyCallerDescriptor,
  CanopyErrorKind,
  CanopyInstructionHandler,
  CanopyQueryHandler,
  CoreWorkspaceRepoRulesErrorCode,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import { repoRulesPolicyErrorCode, type RepoRulesPolicy } from './repo-rules';

/** The message the local-only refusal carries, unchanged from the IPC gate. */
export const REPO_RULES_LOCAL_ONLY_MESSAGE =
  'Editor setup is available on the local desktop.';

/**
 * Repository rules read checkouts under the local account's consent, so only
 * the local desktop user on the desktop interface may use them. This refuses
 * paired remote devices, renderer relay surfaces and Portal sessions.
 */
export function isRepoRulesLocalCaller(
  caller: Pick<CanopyCallerDescriptor, 'principalId' | 'interfaceKind'>,
): boolean {
  return (
    caller.principalId === 'local-desktop-user' &&
    caller.interfaceKind === 'desktop'
  );
}

/** Reviews belong to the caller session that scanned them. */
export function repoRulesSessionKey(
  caller: Pick<CanopyCallerDescriptor, 'principalId' | 'clientInstanceId'>,
): string {
  return `${caller.principalId}:${caller.clientInstanceId}`;
}

export interface CoreWorkspaceRepoRulesBinding {
  /** The policy instance; the host composes its store, resolver and worker. */
  policy: RepoRulesPolicy;
  /** Codes for host failures the policy does not raise, such as a store write. */
  errorCode?: (error: unknown) => CoreWorkspaceRepoRulesErrorCode | undefined;
}

/** Host port for `core.workspace.repoRules.*`, loaded on the first call. */
export interface CoreWorkspaceRepoRulesHost {
  load(): Promise<CoreWorkspaceRepoRulesBinding>;
}

export interface CoreWorkspaceRepoRulesHandlers {
  queries: {
    'core.workspace.repoRules.scan': CanopyQueryHandler<
      'core.workspace.repoRules.scan',
      CanopyHandlerContext
    >;
    'core.workspace.repoRules.preview': CanopyQueryHandler<
      'core.workspace.repoRules.preview',
      CanopyHandlerContext
    >;
    'core.workspace.repoRules.status': CanopyQueryHandler<
      'core.workspace.repoRules.status',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'core.workspace.repoRules.apply': CanopyInstructionHandler<
      'core.workspace.repoRules.apply',
      CanopyHandlerContext
    >;
  };
}

const ERROR_KINDS: Record<CoreWorkspaceRepoRulesErrorCode, CanopyErrorKind> = {
  'core.workspace.repoRules.localOnly': 'permission_denied',
  'core.workspace.repoRules.checkoutUnavailable': 'failed_precondition',
  'core.workspace.repoRules.reviewExpired': 'failed_precondition',
  'core.workspace.repoRules.ruleNotInReview': 'not_found',
  'core.workspace.repoRules.selectionInvalid': 'invalid_argument',
  'core.workspace.repoRules.policyChanged': 'conflict',
  'core.workspace.repoRules.checkoutChanged': 'conflict',
  'core.workspace.repoRules.policyTooLarge': 'resource_exhausted',
  'core.workspace.repoRules.saveFailed': 'internal',
};

// The original error stays the runtime cause so in-process projections can
// rethrow it with its exact message. Unclassified failures stay untyped and
// the dispatcher reports them as `internal`.
function typedError(
  error: unknown,
  binding: CoreWorkspaceRepoRulesBinding,
): unknown {
  if (!(error instanceof Error) || !error.message) return error;
  const code = repoRulesPolicyErrorCode(error) ?? binding.errorCode?.(error);
  if (!code) return error;
  return new CanopyOperationError(
    {
      kind: ERROR_KINDS[code],
      code,
      message: error.message.slice(0, 4_096),
      retry: { kind: 'never' },
    },
    error,
  );
}

function localSession(context: CanopyHandlerContext): string {
  if (!isRepoRulesLocalCaller(context.caller))
    throw new CanopyOperationError(
      {
        kind: 'permission_denied',
        code: 'core.workspace.repoRules.localOnly',
        message: REPO_RULES_LOCAL_ONLY_MESSAGE,
        retry: { kind: 'never' },
      },
      new Error(REPO_RULES_LOCAL_ONLY_MESSAGE),
    );
  return repoRulesSessionKey(context.caller);
}

/**
 * Workspace and checkout membership are checked by the host before any
 * checkout read: the IPC projection authorizes them through the workspace
 * reads, and the resolver accepts only configured checkouts.
 */
export function createCoreWorkspaceRepoRulesHandlers(
  host: CoreWorkspaceRepoRulesHost,
): CoreWorkspaceRepoRulesHandlers {
  const run = async <Result>(
    context: CanopyHandlerContext,
    operation: (policy: RepoRulesPolicy, session: string) => Promise<Result>,
  ): Promise<Result> => {
    const session = localSession(context);
    const binding = await host.load();
    try {
      return await operation(binding.policy, session);
    } catch (error) {
      throw typedError(error, binding);
    }
  };
  return {
    queries: {
      'core.workspace.repoRules.scan': (params, context) =>
        run(context, (policy, session) => policy.scan(session, params)),
      // Preview is synchronous; run catches a throw from inside the call.
      'core.workspace.repoRules.preview': (params, context) =>
        run(context, (policy, session) =>
          Promise.resolve(policy.preview(session, params)),
        ),
      // Status reads workspace policy only; it is not bound to a review.
      'core.workspace.repoRules.status': ({ workspaceId }, context) =>
        run(context, (policy) => policy.status(workspaceId)),
    },
    instructions: {
      'core.workspace.repoRules.apply': (params, context) =>
        run(context, (policy, session) => policy.apply(session, params)),
    },
  };
}
