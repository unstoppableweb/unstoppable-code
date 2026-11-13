import {
  resolveChildPipeline,
  childPipelineAuthorization,
  type ChildPipelineAuthorization,
  type ResolveChildPipelineArgs,
} from '@canopy/execution-engine/node/pipelines/executor/child-pipeline-resolver';
import { getStoredPipelineBySource } from '@canopy/execution-engine/pipelines/store';
import type { ChatTabPluginSelections } from '../types';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import type {
  PipelinePreferenceLocator,
  ResolvedPipelinePluginCollectionSnapshot,
} from '@canopy/execution-engine/types/pipeline';

/** References, not owner claims. Only a host with inventory access can resolve these. */
export interface BackgroundCapabilities {
  selections?: ChatTabPluginSelections;
  plugins?: readonly ShareablePluginRef[];
  model?: string;
  pipeline?: Pick<
    Pipeline,
    'plugin_collections' | 'model_aliases' | 'dependencies'
  >;
  location?: PipelineContextLocation;
  /** A local automation installed from a team/org share; resolved via its receipt. */
  installedAutomation?: { id: string };
  /** Replay resolves the share's current owner before authorizing saved context. */
  sharedPipeline?: { remoteId: string };
}

export type PipelineContextResource = ResourceContextInput['resource'] & {
  childPipeline?: ResolveChildPipelineArgs;
  parentPipelineId?: string;
  storedPipelineId?: string;
  requiresHostAuthorization?: boolean;
  unsupportedTarget?: boolean;
  capabilities?: BackgroundCapabilities;
};
export type PipelineContextLocation = Omit<
  ResolveChildPipelineArgs,
  'pipelineRef' | 'pipelineYaml'
> & {
  pipelineId?: string;
  bundledActionsDir?: string;
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  pluginCollectionPreferences?: Record<string, unknown>;
  modelAliasPreferences?: Record<string, unknown>;
  /** Replay preferences are the saved execution values, not current editor defaults. */
  preferencesResolved?: boolean;
  resolvedPluginCollections?: Record<
    string,
    ResolvedPipelinePluginCollectionSnapshot
  >;
};

import {
  parseWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import {
  resolveAction,
  resolveActionRuntime,
} from '@canopy/execution-engine/node/pipelines/action-resolver';
import {
  decideResourceContext,
  type ResourceContextInput,
  type ResourceContextDecision,
} from '@canopy/execution-engine/lib/resource-context-policy';

export function parseExecutionContext(value: string): WorkspaceContext {
  const context = parseWorkspaceContext(value);
  if (!context)
    throw new Error(
      'Expected --context personal|org:<organizationId> (organization UUID).',
    );
  return context;
}

function isBundledAction(uses: unknown, bundledActionsDir?: string): boolean {
  if (typeof uses !== 'string' || !uses.startsWith('builtin/')) return false;
  try {
    return bundledActionsDir === undefined
      ? resolveAction(uses) !== null
      : resolveActionRuntime(uses, {
          bundledActionsDir,
          getProjectActionsDir: (): string => '',
        }) !== null;
  } catch {
    return false;
  }
}

/** Bundled action manifests are system-owned; other references remain unknown. */
export function pipelineContextResources(
  pipeline: Pick<
    Pipeline,
    'jobs' | 'dependencies' | 'plugin_collections' | 'model_aliases'
  >,
  owner: unknown,
  location: PipelineContextLocation = { cwd: process.cwd() },
  storedPipelineId?: string,
): PipelineContextResource[] {
  const resources: PipelineContextResource[] = [
    { owner, ...(storedPipelineId ? { storedPipelineId } : {}) },
  ];
  if (
    pipeline.dependencies?.length ||
    pipeline.plugin_collections?.length ||
    pipeline.model_aliases?.length
  ) {
    resources.push({
      owner: undefined,
      requiresHostAuthorization: true,
      capabilities: { pipeline, location },
    });
  }
  for (const job of Object.values(pipeline.jobs)) {
    for (const step of job.steps) {
      if (
        'with' in step &&
        typeof step.with?.model === 'string' &&
        step.with.model.startsWith('agent_model_')
      ) {
        resources.push({
          owner: undefined,
          requiresHostAuthorization: true,
          capabilities: { model: step.with.model },
        });
      }
      if ('uses' in step || 'with' in step) {
        resources.push({
          ...('uses' in step && step.uses === 'builtin/run-pipeline'
            ? {
                ...(location.pipelineId
                  ? { parentPipelineId: location.pipelineId }
                  : {}),
                unsupportedTarget: Boolean(
                  ('cwd' in job && job.cwd) ||
                  ('cwd' in step && step.cwd) ||
                  ('target' in step &&
                    step.target &&
                    step.target.scope !== 'inherit') ||
                  step.with?.cwd,
                ),
                childPipeline: {
                  ...location,
                  pipelineRef:
                    typeof step.with?.pipeline === 'string'
                      ? step.with.pipeline
                      : undefined,
                  pipelineYaml:
                    typeof step.with?.pipeline_yaml === 'string'
                      ? step.with.pipeline_yaml
                      : undefined,
                },
              }
            : {}),
          owner:
            'uses' in step &&
            isBundledAction(step.uses, location.bundledActionsDir)
              ? { type: 'system' }
              : undefined,
        });
      }
    }
  }
  return resources;
}

/** Only caller-authored definitions, never stored/shared inventory or references. */
export function localPipelineContextResources(
  pipeline: Pick<
    Pipeline,
    'jobs' | 'dependencies' | 'plugin_collections' | 'model_aliases'
  >,
  location?: PipelineContextLocation,
): PipelineContextResource[] {
  return pipelineContextResources(
    pipeline,
    { shareScope: 'private' },
    location,
  );
}

/** Resolve and authorize each child using the same host policy and trusted binding. */
export async function authorizePipelineContextResources(
  resources: readonly PipelineContextResource[],
  decide: (
    resource: PipelineContextResource,
  ) => Promise<ResourceContextDecision>,
  ancestors: ReadonlySet<string> = new Set(),
  authorizations?: ChildPipelineAuthorization[],
): Promise<ResourceContextDecision> {
  for (const resource of resources) {
    const decision = await decide(resource);
    if (!decision.allow) return decision;
    if (!resource.childPipeline) continue;
    if (resource.unsupportedTarget)
      return { allow: false, reason: 'unsupported-target' };
    const target = resource.childPipeline;
    if (
      ancestors.size >= 16 ||
      [target.pipelineRef, target.pipelineYaml].some((value) =>
        value?.includes('${{'),
      )
    )
      return { allow: false, reason: 'unsupported-target' };
    let child;
    try {
      child = await resolveChildPipeline(target);
    } catch {
      return { allow: false, reason: 'unsupported-target' };
    }
    const identity = JSON.stringify(
      child.preferenceLocator ?? { yaml: target.pipelineYaml },
    );
    if (ancestors.has(identity))
      return { allow: false, reason: 'unsupported-target' };
    let owner: unknown = { shareScope: 'private' };
    let storedPipelineId: string | undefined;
    const locator = child.preferenceLocator;
    if (locator?.type === 'stored') {
      if (locator.source !== 'user' && locator.source !== 'bundled')
        return { allow: false, reason: 'unknown-provenance' };
      const stored = getStoredPipelineBySource(locator.source, locator.value);
      if (!stored.success || !stored.data)
        return { allow: false, reason: 'unknown-provenance' };
      owner =
        stored.data.info.owner ??
        (locator.source === 'bundled'
          ? { type: 'system' }
          : { shareScope: 'private' });
      storedPipelineId = stored.data.info.remoteId ?? stored.data.info.id;
    } else if (child.bundled) owner = { type: 'system' };
    const graph = pipelineContextResources(child.pipeline, owner, {
      ...target,
      pipelineFileDir: child.pipelineFileDir,
      pipelinePreferenceLocator: child.preferenceLocator,
      pluginCollectionPreferences: undefined,
      modelAliasPreferences: undefined,
      resolvedPluginCollections: undefined,
      preferencesResolved: false,
    });
    if (storedPipelineId && graph[0]) {
      graph[0].storedPipelineId = storedPipelineId;
      graph[0].requiresHostAuthorization =
        locator?.type === 'stored' && locator.source !== 'bundled';
    }
    const result = await authorizePipelineContextResources(
      graph,
      decide,
      new Set([...Array.from(ancestors), identity]),
      authorizations,
    );
    if (!result.allow) return result;
    authorizations?.push(childPipelineAuthorization(target, child));
  }
  return { allow: true };
}

/** The CLI has no flag service: calling this helper requires explicit --context. */
export async function decideCliExecutionContext(
  value: string,
  pipeline: Pick<
    Pipeline,
    'jobs' | 'dependencies' | 'plugin_collections' | 'model_aliases'
  >,
  location?: PipelineContextLocation,
  authorizations?: ChildPipelineAuthorization[],
): Promise<ResourceContextDecision> {
  const context = parseExecutionContext(value);
  return authorizePipelineContextResources(
    localPipelineContextResources(pipeline, location),
    (resource) =>
      Promise.resolve(
        resource.requiresHostAuthorization
          ? { allow: false, reason: 'unknown-provenance' }
          : decideResourceContext(
              {
                resource,
                invocation: {
                  mode: 'background',
                  context,
                  executionContext: value,
                },
              },
              { strict: context.kind === 'organization' },
            ),
      ),
    new Set(),
    authorizations,
  );
}

export {
  backgroundExecutionDeniedMessage,
  backgroundExecutionRetryMessage,
  type BackgroundContextMismatchDetails,
  type BackgroundExecutionDeniedMessageOptions,
} from '@canopy/execution-engine/lib/automation-context-copy';

/** A verification that could not complete; the activity stays enabled. */
export function backgroundExecutionUnavailableMessage(): string {
  return "Couldn't verify access to this activity's resources. It'll try again on the next run.";
}
