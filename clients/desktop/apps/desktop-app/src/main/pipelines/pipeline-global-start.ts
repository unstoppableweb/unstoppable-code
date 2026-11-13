import { backgroundExecutionDeniedMessage } from '@canopy/execution-engine/lib/automation-context-copy';
import type { ExecutePipelineRequestOptions } from '@canopy/execution-engine/node/pipelines/executor';
import {
  executionContextSatisfies,
  normalizePipelineScopes,
} from '@canopy/execution-engine/pipelines/scope';
import type {
  Pipeline,
  PIPELINE_NOW_OWNED_ERROR_CODE,
} from '@canopy/execution-engine/types/pipeline';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  accountMayRunIn,
  backgroundExecutionContextEnabled,
  captureBackgroundExecutionContext,
} from '../services/background-execution-context';
import {
  isLocalUserPipeline,
  resolveExecutionOwnerContext,
} from './pipeline-owner-policy';

export type GlobalStartRefusalReason =
  | 'invalid_target'
  | 'unsupported_scope'
  | 'unsupported_watchers'
  | 'owner_unavailable';

export interface GlobalStartRefusal {
  reason: GlobalStartRefusalReason;
  message: string;
  /** Set when the pipeline gained a saved owner after the dialog read it. */
  code?: typeof PIPELINE_NOW_OWNED_ERROR_CODE;
}

type GlobalStartRequest = Pick<
  ExecutePipelineRequestOptions,
  | 'pipelineId'
  | 'scope'
  | 'target'
  | 'cwd'
  | 'repoPath'
  | 'projectId'
  | 'worktreeId'
  | 'pipelineFilePath'
  | 'eventName'
  | 'eventData'
  | 'planId'
  | 'appAdvisorPipelineWatchers'
  | 'requestedOwner'
  | 'pipelinePreferenceLocator'
  | 'sharedPipeline'
  | 'initiator'
  | 'initiationSource'
  | 'executionContext'
>;

export const GLOBAL_RUN_OWNER_TARGETED_MESSAGE =
  'An owner can only be chosen for a run with no project.';
export const GLOBAL_RUN_DISPATCH_ONLY_MESSAGE =
  'A run with no project can only be started directly.';
export const GLOBAL_RUN_TARGET_MESSAGE =
  "A run with no project can't name a project, task, or folder.";
export const GLOBAL_RUN_WATCHERS_MESSAGE =
  "Completion watchers aren't available for a run with no project.";
export const GLOBAL_RUN_SCOPE_MESSAGE =
  "This pipeline can't run without a project.";
export const GLOBAL_RUN_OWNER_CHECK_FAILED_MESSAGE =
  "Couldn't check who owns this run. Try again.";

/** Whether the request asks for a run with no project. */
export function isGlobalStartRequest(
  options: Pick<ExecutePipelineRequestOptions, 'scope' | 'target'>,
): boolean {
  return options.scope === 'global' || options.target?.scope === 'global';
}

/**
 * A person's start: the renderer, tunneled Portal EXECUTE, or a direct Portal
 * command. Hooks, automations, agents, and App Advisor bind owners themselves.
 */
export function isPersonStart(
  options: Pick<
    ExecutePipelineRequestOptions,
    'initiator' | 'initiationSource'
  >,
): boolean {
  if (options.initiator !== undefined)
    return (
      options.initiator.kind === 'user' || options.initiator.kind === 'portal'
    );
  return (
    options.initiationSource === undefined ||
    options.initiationSource === 'user' ||
    options.initiationSource === 'portal'
  );
}

/** The local user pipeline a run starts, when its definition is one. */
export function localUserPipelineIdForRequest(
  options: Pick<
    ExecutePipelineRequestOptions,
    | 'pipelineId'
    | 'pipelineFilePath'
    | 'pipelinePreferenceLocator'
    | 'sharedPipeline'
  >,
): string | undefined {
  const locator = options.pipelinePreferenceLocator;
  if (options.sharedPipeline !== undefined) return undefined;
  if (options.pipelineFilePath !== undefined) return undefined;
  if (locator?.type === 'file') return undefined;
  if (locator?.type === 'stored' && locator.source !== 'user') return undefined;
  if (options.pipelineId.startsWith('curated:')) return undefined;
  return isLocalUserPipeline(options.pipelineId)
    ? options.pipelineId
    : undefined;
}

function hasEventTargetData(
  eventData: ExecutePipelineRequestOptions['eventData'],
): boolean {
  return (
    eventData?.plan_ready !== undefined || eventData?.task_ready !== undefined
  );
}

/**
 * Request shape and scope support of a global start, checked before any
 * reservation, owner binding, scratch folder, or watcher exists.
 */
export function validateGlobalStartShape(
  pipeline: Pipeline,
  options: GlobalStartRequest,
): GlobalStartRefusal | null {
  if (!isGlobalStartRequest(options)) {
    return options.requestedOwner === undefined
      ? null
      : {
          reason: 'invalid_target',
          message: GLOBAL_RUN_OWNER_TARGETED_MESSAGE,
        };
  }
  if (
    (options.eventName !== undefined && options.eventName !== 'dispatch') ||
    options.planId !== undefined ||
    hasEventTargetData(options.eventData)
  )
    return {
      reason: 'invalid_target',
      message: GLOBAL_RUN_DISPATCH_ONLY_MESSAGE,
    };
  if (
    options.projectId !== undefined ||
    options.worktreeId !== undefined ||
    options.repoPath !== undefined ||
    options.pipelineFilePath !== undefined ||
    options.cwd !== undefined ||
    options.scope !== 'global' ||
    (options.target !== undefined && options.target.scope !== 'global')
  )
    return { reason: 'invalid_target', message: GLOBAL_RUN_TARGET_MESSAGE };
  if ((options.appAdvisorPipelineWatchers?.length ?? 0) > 0)
    return {
      reason: 'unsupported_watchers',
      message: GLOBAL_RUN_WATCHERS_MESSAGE,
    };
  let scopes: ReturnType<typeof normalizePipelineScopes>;
  try {
    scopes = normalizePipelineScopes(pipeline.scope, 'Pipeline');
  } catch {
    return { reason: 'unsupported_scope', message: GLOBAL_RUN_SCOPE_MESSAGE };
  }
  if (!executionContextSatisfies(scopes, 'global'))
    return { reason: 'unsupported_scope', message: GLOBAL_RUN_SCOPE_MESSAGE };
  return null;
}

/**
 * The owner checks a person's global start must pass before side effects:
 * a valid choice, no conflict with a saved owner, and current membership.
 * The start re-resolves the owner and authorizes resources afterward. A check
 * that can't read refuses the run instead of throwing.
 */
async function preflightPersonGlobalOwner(
  options: GlobalStartRequest,
): Promise<GlobalStartRefusal | null> {
  try {
    return await checkPersonGlobalOwner(options);
  } catch {
    return {
      reason: 'owner_unavailable',
      message: GLOBAL_RUN_OWNER_CHECK_FAILED_MESSAGE,
    };
  }
}

async function checkPersonGlobalOwner(
  options: GlobalStartRequest,
): Promise<GlobalStartRefusal | null> {
  const owner = await resolveExecutionOwnerContext({
    explicit: undefined,
    captured: undefined,
    scope: 'global',
    parentExecutionId: undefined,
    projectId: undefined,
    worktreeId: undefined,
    target: options.target,
    userPipelineId: localUserPipelineIdForRequest(options),
    person: { requestedOwner: options.requestedOwner },
  });
  if ('refusal' in owner)
    return {
      reason: 'owner_unavailable',
      message: owner.refusal,
      ...(owner.code !== undefined ? { code: owner.code } : {}),
    };
  const parsed = parseWorkspaceContext(owner.owner);
  if (parsed === null)
    return {
      reason: 'owner_unavailable',
      message: backgroundExecutionDeniedMessage('unsupported-target'),
    };
  if (parsed.kind !== 'organization') return null;
  const captured = backgroundExecutionContextEnabled()
    ? await captureBackgroundExecutionContext()
    : undefined;
  if (owner.owner !== captured && !(await accountMayRunIn(parsed)))
    return {
      reason: 'owner_unavailable',
      message: backgroundExecutionDeniedMessage('access-removed'),
    };
  return null;
}

/**
 * Every refusal a person's or agent's global start gets before side effects,
 * in order: request shape, scope support, then a person's owner choice.
 * Hooks and automations are trusted callers and are not checked here.
 */
export async function preflightGlobalStart(
  pipeline: Pipeline,
  options: GlobalStartRequest,
): Promise<GlobalStartRefusal | null> {
  if (
    options.initiationSource === 'hook' ||
    options.initiationSource === 'automation'
  )
    return null;
  const shape = validateGlobalStartShape(pipeline, options);
  if (shape !== null) return shape;
  if (!isGlobalStartRequest(options) || !isPersonStart(options)) return null;
  // A trusted main-process caller that binds the owner itself is not a
  // person choosing one.
  if (options.executionContext !== undefined) return null;
  return preflightPersonGlobalOwner(options);
}
