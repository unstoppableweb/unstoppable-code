import type {
  ActionDefinition,
  Pipeline,
  PipelineExecutionScope,
  PipelinePackageCapabilityOverlay,
  PipelineRunTarget,
  NormalizedStep,
} from '@canopy/execution-engine/types/pipeline';
import {
  executionContextSatisfies,
  reachableExecutionContexts,
  scopesOverlap,
} from '@canopy/execution-engine/pipelines/scope';
import { normalizePipeline } from '@canopy/execution-engine/node/pipelines/executor/normalize-pipeline';
import { resolveActionRuntime } from '../action-resolver';
import { resolveChildPipeline } from './child-pipeline-resolver';
import type { ExecutionRuntime } from './types';
import type { ShellType } from '@canopy/execution-engine/types/pipeline';

export interface PipelineScopeValidationOptions {
  pipeline: Pipeline;
  pipelineId: string;
  cwd: string;
  pipelineFileDir?: string;
  repoPath?: string;
  packageOverlay?: PipelinePackageCapabilityOverlay;
  runtime: Pick<
    ExecutionRuntime,
    | 'bundledActionsDir'
    | 'getProjectActionsDir'
    | 'getProjectActionsDirCandidates'
    | 'getProjectPipelinesDir'
    | 'getProjectPipelinesDirCandidates'
  >;
  defaultShell?: ShellType;
}

function formatScopes(scopes: readonly PipelineExecutionScope[]): string {
  return scopes.join(', ');
}

function stepLabel(step: NormalizedStep, jobId: string): string {
  return `Step "${step.id}" in job "${jobId}"`;
}

function hasExpression(value: string | undefined): boolean {
  return value?.includes('${{') === true;
}

function actionInputValues(
  action: ActionDefinition,
  step: NormalizedStep,
): Record<string, string> {
  const result: Record<string, string> = {};
  const definitions = action.inputs ?? {};
  const provided = step.with ?? {};

  for (const [name, input] of Object.entries(definitions)) {
    const value = provided[name] ?? input.default;
    if (value !== undefined) {
      result[name] = String(value);
    }
  }

  for (const [name, value] of Object.entries(provided)) {
    if (result[name] === undefined) {
      result[name] = String(value);
    }
  }

  return result;
}

function validateChildTargetCompatibility(args: {
  parentScopes: PipelineExecutionScope[];
  childScopes: PipelineExecutionScope[];
  target: PipelineRunTarget;
  step: NormalizedStep;
  jobId: string;
  childPipelineId: string;
}): void {
  const valid =
    args.target.scope === 'inherit'
      ? scopesOverlap(args.parentScopes, args.childScopes)
      : executionContextSatisfies(args.childScopes, args.target.scope);

  if (!valid) {
    throw new Error(
      `${stepLabel(args.step, args.jobId)} targets scope "${args.target.scope}" but child workflow "${args.childPipelineId}" supports [${formatScopes(args.childScopes)}]`,
    );
  }
}

export async function validatePipelineScopes(
  options: PipelineScopeValidationOptions,
): Promise<void> {
  const normalizedPipeline = normalizePipeline(options.pipeline, {
    defaultShell: options.defaultShell,
  });

  for (const [jobId, job] of Object.entries(normalizedPipeline.jobs)) {
    for (const step of job.steps) {
      if (!step.uses) {
        if (step.target) {
          throw new Error(
            `${stepLabel(step, jobId)} defines target but only action steps can define target`,
          );
        }
        continue;
      }

      const action = resolveActionRuntime(
        step.uses,
        options.runtime,
        options.repoPath,
        options.packageOverlay,
      );

      if (!action) {
        if (step.skip_on_missing_action) {
          continue;
        }
        throw new Error(`Unable to resolve action "${step.uses}"`);
      }

      if (!scopesOverlap(normalizedPipeline.scope, action.definition.scopes)) {
        throw new Error(
          `${stepLabel(step, jobId)} uses action "${step.uses}" with scopes [${formatScopes(action.definition.scopes)}] but workflow scopes are [${formatScopes(normalizedPipeline.scope)}]`,
        );
      }

      if (step.target && action.definition.runs.using !== 'pipeline') {
        throw new Error(
          `${stepLabel(step, jobId)} defines target but action "${step.uses}" is not a workflow action`,
        );
      }

      if (action.definition.runs.using !== 'pipeline') {
        continue;
      }

      const inputValues = actionInputValues(action.definition, step);
      if (
        hasExpression(inputValues.pipeline) ||
        hasExpression(inputValues.pipeline_yaml)
      ) {
        continue;
      }

      const getProjectPipelinesDirCandidates = (repoPath: string): string[] =>
        options.runtime.getProjectPipelinesDirCandidates?.(repoPath) ?? [
          options.runtime.getProjectPipelinesDir(repoPath),
        ];

      const child = await resolveChildPipeline({
        pipelineRef: inputValues.pipeline,
        pipelineYaml: inputValues.pipeline_yaml,
        cwd: options.cwd,
        pipelineFileDir: options.pipelineFileDir,
        repoPath: options.repoPath,
        packageOverlay: options.packageOverlay,
        getProjectPipelinesDirCandidates,
      });
      const childPipeline = normalizePipeline(child.pipeline, {
        defaultShell: options.defaultShell,
      });
      validateChildTargetCompatibility({
        parentScopes: reachableExecutionContexts(normalizedPipeline.scope),
        childScopes: childPipeline.scope,
        target: step.target ?? { scope: 'inherit' },
        step,
        jobId,
        childPipelineId: child.pipelineId,
      });
    }
  }
}
