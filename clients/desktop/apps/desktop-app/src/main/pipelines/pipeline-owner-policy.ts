import { backgroundExecutionDeniedMessage } from '@canopy/execution-engine/lib/automation-context-copy';
import type {
  PipelineOwnershipPort,
  PipelineOwnershipWorktreeTarget,
} from '@canopy/execution-engine/node/pipelines/executor';
import type { PipelineHostActionCaller } from '@canopy/execution-engine/node/pipelines/executor/types';
import { PipelineHostRefusal } from '@canopy/execution-engine/pipelines/host-actions';
import { isTopLevelGlobalRun } from '@canopy/execution-engine/node/pipelines/executor';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { getStoredPipelinePathWithSource } from '@canopy/execution-engine/pipelines/store';
import {
  PIPELINE_NOW_OWNED_ERROR_CODE,
  PIPELINE_NOW_OWNED_MESSAGE,
  type Pipeline,
  type PipelineExecutionScope,
  type ResolvedPipelineExecutionTarget,
} from '@canopy/execution-engine/types/pipeline';
import type { ProjectOwnerContext } from '@canopy/desktop-shared/types';
import {
  parseWorkspaceContext,
  serializeWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  decideSameOwnerAccess,
  resolveProjectSavedOwner,
  type ProjectOwnerTarget,
  type ResolvedProjectOwner,
} from '../lib/project-owner';
import {
  backgroundExecutionContextEnabled,
  captureBackgroundExecutionContext,
  resolveBackgroundTargetContext,
} from '../services/background-execution-context';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import type { PipelineHostTarget } from './host-task-resolution';
import {
  isPipelineLocalMetadataReadable,
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
} from './pipeline-local-metadata-store';

/** The selected owner, or Personal while organization projects are off. */
export async function selectedOwnerContext(): Promise<string> {
  if (!backgroundExecutionContextEnabled()) return 'personal';
  return (await captureBackgroundExecutionContext()) ?? 'personal';
}

/** Whether `pipelineId` names a pipeline in the local user pipeline store. */
export function isLocalUserPipeline(pipelineId: string): boolean {
  const stored = getStoredPipelinePathWithSource(pipelineId);
  return stored.success && stored.data?.source === 'user';
}

/**
 * The stored owner of a user pipeline. A legacy pipeline without one takes
 * the selected owner now and keeps it.
 */
export async function getUserPipelineOwner(
  pipelineId: string,
): Promise<string> {
  const stored = readPipelineLocalMetadata({
    type: 'stored',
    source: 'user',
    value: pipelineId,
  }).owner;
  if (stored !== undefined) return stored;
  const owner = await selectedOwnerContext();
  recordUserPipelineOwner(pipelineId, owner);
  return owner;
}

type OwnerResult = { owner: string } | { refusal: string };

/**
 * A run owner, plus the legacy unowned user pipeline the caller binds to it
 * once the run is authorized.
 */
type ExecutionOwnerResult =
  | { owner: string; bindUserPipelineId?: string }
  | { refusal: string; code?: typeof PIPELINE_NOW_OWNED_ERROR_CODE };

/** A person's start found the pipeline bound to another owner meanwhile. */
export class PipelineNowOwnedError extends Error {
  readonly code = PIPELINE_NOW_OWNED_ERROR_CODE;

  constructor() {
    super(PIPELINE_NOW_OWNED_MESSAGE);
    this.name = 'PipelineNowOwnedError';
  }
}

export const CHOOSE_RUN_OWNER_MESSAGE = 'Choose an owner for this run.';
export const RUN_OWNER_UNAVAILABLE_MESSAGE =
  "That owner isn't available. Choose another owner.";

/**
 * Whether `requestedOwner` is an owner a person may choose: a serialized
 * workspace context, and Personal while organization projects are off.
 * Membership is checked when the run is authorized.
 */
export function isAcceptableRequestedOwner(requestedOwner: string): boolean {
  const parsed = parseWorkspaceContext(requestedOwner);
  if (parsed === null) return false;
  return backgroundExecutionContextEnabled() || parsed.kind === 'personal';
}

/**
 * The saved local owner of a user pipeline, for the single-pipeline read.
 * Throws while stored owners can't be read, so the pipeline never appears
 * unowned.
 */
export function readUserPipelineLocalRunOwner(
  pipelineId: string,
): string | undefined {
  if (!isPipelineLocalMetadataReadable())
    throw new Error(backgroundExecutionDeniedMessage('unknown-provenance'));
  return readPipelineLocalMetadata({
    type: 'stored',
    source: 'user',
    value: pipelineId,
  }).owner;
}

/** Whether the signed-in account has an organization to choose. */
async function accountHasOrganizations(): Promise<boolean> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  return service.getState().organizations.length > 0;
}

/**
 * A person's global run: a saved local owner is authoritative; otherwise the
 * person must choose one. Main never defaults an owner for a person.
 */
async function resolvePersonGlobalOwner(
  requestedOwner: string | undefined,
  userPipelineId: string | undefined,
): Promise<ExecutionOwnerResult> {
  if (
    requestedOwner !== undefined &&
    !isAcceptableRequestedOwner(requestedOwner)
  )
    return { refusal: RUN_OWNER_UNAVAILABLE_MESSAGE };
  // Without organizations every run is Personal, even for a pipeline saved
  // under an organization; that saved owner is left unchanged.
  if (!backgroundExecutionContextEnabled()) return { owner: 'personal' };
  let saved: string | undefined;
  if (userPipelineId !== undefined) {
    // An owner that can't be read refuses the run, like an unknown project.
    if (!isPipelineLocalMetadataReadable())
      return {
        refusal: backgroundExecutionDeniedMessage('unknown-provenance'),
      };
    saved = readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: userPipelineId,
    }).owner;
  }
  if (saved !== undefined) {
    // The pipeline may have become owned after the dialog read it.
    if (requestedOwner !== undefined && requestedOwner !== saved)
      return {
        refusal: PIPELINE_NOW_OWNED_MESSAGE,
        code: PIPELINE_NOW_OWNED_ERROR_CODE,
      };
    return { owner: saved };
  }
  if (requestedOwner === undefined)
    return { refusal: CHOOSE_RUN_OWNER_MESSAGE };
  // Personal is only a choice when there is an organization to choose
  // instead; a fixed Personal owner runs without binding the pipeline.
  const chosen =
    parseWorkspaceContext(requestedOwner)?.kind !== 'personal' ||
    (await accountHasOrganizations());
  return {
    owner: requestedOwner,
    ...(userPipelineId === undefined || !chosen
      ? {}
      : { bindUserPipelineId: userPipelineId }),
  };
}

export interface ExecutionOwnerRequest {
  /** A trusted caller's binding: hook, automation, agent, or foreground org dispatch. */
  explicit: string | undefined;
  /** The selected context captured at dispatch (absent with the flag off). */
  captured: string | undefined;
  scope: PipelineExecutionScope | undefined;
  parentExecutionId: string | undefined;
  projectId: string | undefined;
  worktreeId: string | undefined;
  target?: ResolvedPipelineExecutionTarget;
  /** Set only when the run's pipeline is in the local user pipeline store. */
  userPipelineId: string | undefined;
  /**
   * Present when a person starts the run. `requestedOwner` is their choice
   * for a global run of an unowned definition.
   */
  person?: { requestedOwner: string | undefined };
}

/**
 * The owner every top-level run records in `execution_context`: an explicit
 * binding; for a person's global run, the pipeline's saved owner or the
 * owner they chose; for another global run of a user pipeline, the
 * pipeline's owner; for any other run without a project, the selected
 * context; otherwise the target project's saved owner (App Advisor's is
 * Personal). With organization projects off, everything but an explicit
 * binding is Personal.
 */
export async function resolveExecutionOwnerContext(
  request: ExecutionOwnerRequest,
): Promise<ExecutionOwnerResult> {
  if (request.explicit !== undefined) return { owner: request.explicit };
  const topLevelGlobal = isTopLevelGlobalRun({
    scope: request.scope,
    parentExecutionId: request.parentExecutionId,
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    target: request.target,
  });
  if (request.person !== undefined && topLevelGlobal)
    return await resolvePersonGlobalOwner(
      request.person.requestedOwner,
      request.userPipelineId,
    );
  if (!backgroundExecutionContextEnabled()) return { owner: 'personal' };
  if (request.userPipelineId !== undefined && topLevelGlobal) {
    // An owner that can't be read refuses the run, like an unknown project.
    if (!isPipelineLocalMetadataReadable())
      return {
        refusal: backgroundExecutionDeniedMessage('unknown-provenance'),
      };
    return { owner: await getUserPipelineOwner(request.userPipelineId) };
  }
  if (!request.projectId) {
    return { owner: request.captured ?? (await selectedOwnerContext()) };
  }
  const saved = await resolveProjectSavedOwner({
    projectId: request.projectId,
    ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
  });
  if (saved.kind === 'unknown')
    return { refusal: backgroundExecutionDeniedMessage('unknown-provenance') };
  if (saved.kind === 'none') return { owner: 'personal' };
  return { owner: serializeWorkspaceContext(saved) };
}

/**
 * The owner of a pipeline an agent writes inside a project: that project's
 * saved owner, or the selected context for App Advisor.
 */
export async function agentPipelineOwnerContext(target: {
  projectId: string;
  worktreeId?: string;
}): Promise<OwnerResult> {
  if (!backgroundExecutionContextEnabled()) return { owner: 'personal' };
  const saved = await resolveProjectSavedOwner(target);
  if (saved.kind === 'unknown')
    return { refusal: backgroundExecutionDeniedMessage('unknown-provenance') };
  if (saved.kind === 'none') return { owner: await selectedOwnerContext() };
  return { owner: serializeWorkspaceContext(saved) };
}

/**
 * A run's owner from its `execution_context`, one rule for the host owner
 * check and the pipeline sender: absent is Personal, unparseable is unknown.
 */
export function pipelineHostCallerOwner(
  executionContext: string | undefined,
): ProjectOwnerContext | { kind: 'unknown' } {
  return (
    parseWorkspaceContext(executionContext ?? 'personal') ?? {
      kind: 'unknown',
    }
  );
}

/**
 * A Personal project linked to the caller's organization runs in that
 * organization, as {@link resolveBackgroundTargetContext} decides for the run
 * itself, so a run bound to the organization may target it.
 */
async function isPersonalProjectLinkedToCaller(
  caller: ResolvedProjectOwner,
  target: ProjectOwnerTarget,
): Promise<boolean> {
  if (caller.kind !== 'organization') return false;
  try {
    const resolved = await resolveBackgroundTargetContext(target, caller);
    return resolved.matches && resolved.targetOwner.kind === 'personal';
  } catch {
    return false;
  }
}

type SameOwnerTargetAccess = 'allowed' | 'hidden' | 'unknown';

async function sameOwnerTargetAccess(
  executionContext: string | undefined,
  target: ProjectOwnerTarget,
): Promise<SameOwnerTargetAccess> {
  const caller: ResolvedProjectOwner =
    pipelineHostCallerOwner(executionContext);
  const decision = await decideSameOwnerAccess(caller, target);
  switch (decision.kind) {
    case 'allowed':
      return 'allowed';
    case 'hidden':
      return (await isPersonalProjectLinkedToCaller(caller, target))
        ? 'allowed'
        : 'hidden';
    case 'caller_owner_unknown':
    case 'target_owner_unknown':
      return 'unknown';
  }
}

function projectHiddenMessage(projectId: string): string {
  return `Project \`${projectId}\` isn't available to this pipeline`;
}

function projectUncheckedMessage(projectId: string): string {
  return `Project \`${projectId}\` can't be checked right now. Try again.`;
}

async function sameOwnerTargetError(
  executionContext: string | undefined,
  target: ProjectOwnerTarget,
): Promise<string | null> {
  switch (await sameOwnerTargetAccess(executionContext, target)) {
    case 'allowed':
      return null;
    case 'hidden':
      return projectHiddenMessage(target.projectId);
    case 'unknown':
      return projectUncheckedMessage(target.projectId);
  }
}

/**
 * Host steps' owner check. The caller's `executionContext` is the owner the
 * run recorded at dispatch ({@link resolveExecutionOwnerContext}), the same
 * value child-run targets are checked against. Another owner's project reads
 * exactly like a missing one; an owner that can't be resolved fails closed.
 * App Advisor isn't owner-limited. Not flag-gated.
 */
export async function assertPipelineHostTargetOwner(
  caller: PipelineHostActionCaller,
  target: PipelineHostTarget,
): Promise<void> {
  if (target.kind === 'bot') return;
  const access = await sameOwnerTargetAccess(caller.executionContext, {
    projectId: target.projectId,
    ...(target.taskId !== undefined ? { worktreeId: target.taskId } : {}),
  });
  switch (access) {
    case 'allowed':
      return;
    case 'hidden':
      throw new PipelineHostRefusal(
        'not_found',
        projectHiddenMessage(target.projectId),
      );
    case 'unknown':
      throw new PipelineHostRefusal(
        'owner_context_unavailable',
        projectUncheckedMessage(target.projectId),
      );
  }
}

/**
 * Refuse a `run-pipeline` worktree target another owner holds. The message
 * names only the ID the author wrote. Not flag-gated.
 */
export async function assertRunPipelineTargetOwner(args: {
  executionContext: string | undefined;
  target: PipelineOwnershipWorktreeTarget | ResolvedPipelineExecutionTarget;
}): Promise<void> {
  if (args.target.scope !== 'worktree') return;
  const error = await sameOwnerTargetError(args.executionContext, {
    projectId: args.target.workspace_id,
    worktreeId: args.target.worktree_id,
  });
  if (error !== null) throw new Error(error);
}

function isLiteral(value: string): boolean {
  return !value.includes('${{');
}

const HOST_STEP_PROJECT_INPUTS: Readonly<Record<string, readonly string[]>> = {
  'builtin/move-to-group': ['project_id'],
  'builtin/create-worktree': ['project_id', 'workspace_id'],
  'builtin/create-project-entry': ['project_id'],
  'builtin/send-agent-message': ['project_id'],
  'builtin/wait-for-agent-reply': ['project_id'],
};

/** The literal project a host step names, if any; expressions are checked at run time. */
function literalHostStepProject(step: {
  uses?: string;
  with?: Record<string, unknown>;
}): string | undefined {
  const inputs = step.uses ? HOST_STEP_PROJECT_INPUTS[step.uses] : undefined;
  if (!inputs) return undefined;
  for (const name of inputs) {
    const value = step.with?.[name];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && isLiteral(trimmed)) return trimmed;
  }
  return undefined;
}

/**
 * Check the literal `run-pipeline` worktree targets of a pipeline that can
 * run globally against the owner it is saved in. A project-scoped pipeline
 * takes its target project's owner at run time, so it is not checked here.
 * Returns the first refusal, or `null`.
 */
export async function validatePipelineOwnerTargetsOnSave(
  pipeline: Pipeline,
  ownerContext: string,
): Promise<string | null> {
  let normalized: ReturnType<typeof normalizePipeline>;
  try {
    normalized = normalizePipeline(pipeline);
  } catch {
    // Invalid pipelines are refused by the store's own validation.
    return null;
  }
  if (!normalized.scope.includes('global')) return null;
  for (const job of Object.values(normalized.jobs)) {
    for (const step of job.steps) {
      const hostProject = literalHostStepProject(step);
      if (hostProject !== undefined) {
        const error = await sameOwnerTargetError(ownerContext, {
          projectId: hostProject,
        });
        if (error !== null) return error;
      }
      const target = step.target;
      if (target?.scope !== 'worktree' || !isLiteral(target.workspace_id))
        continue;
      const worktreeId =
        'id' in target.worktree && isLiteral(target.worktree.id)
          ? target.worktree.id
          : undefined;
      const error = await sameOwnerTargetError(ownerContext, {
        projectId: target.workspace_id,
        ...(worktreeId ? { worktreeId } : {}),
      });
      if (error !== null) return error;
    }
  }
  return null;
}

export function createDesktopPipelineOwnershipPort(): PipelineOwnershipPort {
  return {
    authorizeTarget: assertRunPipelineTargetOwner,
    readAgentAuthor: (locator) =>
      readPipelineLocalMetadata(locator).agentAuthor,
  };
}
