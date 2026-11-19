/**
 * A worktree's panel rows (plans, scripts, hooks, pipelines and its summary)
 * as entity envelopes. Remote Control controllers read them over
 * `worktree:activity-entities` (CAN-5985); Portal's `worktree` snapshot reuses
 * the same section readers while it still runs.
 */
import type {
  PortalEntityEnvelope,
  PortalHookRun,
  PortalPipelineRun,
  PortalScriptRun,
} from '@canopy/desktop-shared/types';
import { worktreeScopedParentLocalId } from '@canopy/protocol/portal';
import { validateId } from '../lib/validation';
import { readWorktreeSummary } from '../lib/worktree-summary-persistence';
import { isWorktreeSummaryGenerating } from '../lib/worktree-summary-scheduler';
import { listPlans, planToPortalEntity } from '../services/plans-service';
import {
  listScripts,
  listScriptRuns,
  scriptToPortalEntity,
} from '../services/scripts-service';
import {
  hookToPortalEntity,
  listHookRuns,
  listHooks,
} from '../services/hooks-service';
import {
  listPipelineRuns,
  listPipelines,
  pipelineToPortalEntity,
} from '../services/pipelines-service';

function scriptRunToPortalEntity(run: PortalScriptRun): PortalEntityEnvelope {
  return {
    entityType: 'script_run',
    localId: run.localId,
    parentLocalId: worktreeScopedParentLocalId(
      run.workspaceLocalId,
      run.worktreeLocalId,
    ),
    payload: run,
  };
}

function hookRunToPortalEntity(run: PortalHookRun): PortalEntityEnvelope {
  return {
    entityType: 'hook_run',
    localId: run.localId,
    parentLocalId: worktreeScopedParentLocalId(
      run.workspaceLocalId,
      run.worktreeLocalId,
    ),
    payload: run,
  };
}

function pipelineRunToPortalEntity(
  run: PortalPipelineRun,
): PortalEntityEnvelope {
  return {
    entityType: 'pipeline_run',
    localId: run.localId,
    parentLocalId: worktreeScopedParentLocalId(
      run.workspaceLocalId,
      run.worktreeLocalId,
    ),
    payload: run,
  };
}

export async function listScriptEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const scriptInput = {
    ...input,
    workspaceId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
    projectId: input.workspaceLocalId,
  };
  const [scripts, scriptRuns] = await Promise.all([
    listScripts(scriptInput).catch(() => []),
    listScriptRuns(scriptInput).catch(() => []),
  ]);
  return [
    ...scripts.map(scriptToPortalEntity),
    ...scriptRuns.map(scriptRunToPortalEntity),
  ];
}

export async function listPipelineEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const pipelineInput = {
    ...input,
    workspaceId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
    projectId: input.workspaceLocalId,
  };
  const [pipelines, pipelineRuns] = await Promise.all([
    listPipelines(pipelineInput).catch(() => []),
    listPipelineRuns(pipelineInput).catch(() => []),
  ]);
  return [
    ...pipelines.map(pipelineToPortalEntity),
    ...pipelineRuns.map(pipelineRunToPortalEntity),
  ];
}

export async function listPlanEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const plans = await listPlans({
    projectId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
  }).catch(() => []);
  return plans.map(planToPortalEntity);
}

export async function listHookEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const hookInput = {
    ...input,
    workspaceId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
    projectId: input.workspaceLocalId,
  };
  const [hooks, hookRuns] = await Promise.all([
    listHooks(hookInput).catch(() => []),
    listHookRuns(hookInput).catch(() => []),
  ]);
  return [
    ...hooks.map(hookToPortalEntity),
    ...hookRuns.map(hookRunToPortalEntity),
  ];
}

export async function listSummaryEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const { workspaceLocalId, worktreeLocalId } = input;
  const summary = await readWorktreeSummary(
    workspaceLocalId,
    worktreeLocalId,
  ).catch(() => null);
  if (!summary) return [];
  return [
    {
      entityType: 'worktree_summary',
      localId: worktreeLocalId,
      parentLocalId: worktreeScopedParentLocalId(
        workspaceLocalId,
        worktreeLocalId,
      ),
      payload: {
        workspaceLocalId,
        worktreeLocalId,
        title: summary.title,
        description: summary.description,
        highlights: summary.highlights,
        repos: summary.repos,
        generatedAt: summary.generatedAt,
        lastFullRefreshAt: summary.lastFullRefreshAt,
        generating: isWorktreeSummaryGenerating(
          workspaceLocalId,
          worktreeLocalId,
        ),
      },
    },
  ];
}

/**
 * One worktree's plan, script, hook, pipeline and summary entities, built by
 * the same section readers a Portal `worktree` snapshot uses. Browser Remote
 * Control controllers read them over `worktree:activity-entities` (CAN-5985),
 * so their panels list exactly the rows a Portal session would.
 */
export async function listWorktreeActivityEntities(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  validateId(input.workspaceLocalId, 'projectId');
  validateId(input.worktreeLocalId, 'worktreeId');
  const sections = await Promise.all([
    listPlanEntitiesForWorktree(input),
    listScriptEntitiesForWorktree(input),
    listHookEntitiesForWorktree(input),
    listPipelineEntitiesForWorktree(input),
    listSummaryEntitiesForWorktree(input),
  ]);
  return sections.flat();
}
