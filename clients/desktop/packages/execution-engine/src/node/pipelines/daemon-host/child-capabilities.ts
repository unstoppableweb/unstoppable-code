import {
  WORKER_PIPELINE_OWNER_CHILD_DOCUMENT_MAX,
  type WorkerPipelineHostRequest,
} from '@canopy/protocol/canopy-core';
import type {
  Pipeline,
  ResolvedPipelinePluginCollectionSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import type { DaemonModelAliasResolution } from '../daemon-eligibility';
import type {
  ChildPipelineAdmissionRequest,
  ExecutionRuntime,
} from '../executor/types';
import {
  PIPELINE_OWNER_DEADLINE_MS,
  type PipelineOwnerClient,
} from './owner-client';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { parseLaunchPluginCollections } from './plugin-collections';

/*
 * A same-target child's own plugin collections and model aliases on a cloud
 * runner's pipeline host (CAN-6868 follow-up 3).
 *
 * The run's core resolved the parent's at launch, keyed by id. A child that
 * declares its own asks the core again before it starts or resumes, with
 * `owner.pipeline.childCapabilities`: the core resolves them for the run's
 * person under the run's owner, installs what they need on this worker, and
 * answers in the launch's shapes. They are kept for that child alone: its
 * execution resolves its collections from them (the executor names the
 * execution it resolves for), and its check classifies its steps with them,
 * so a child never gets its parent's collection or alias of the same id,
 * nor its parent a child's.
 */

/** A child's own collections and aliases, as its core resolved them. */
export interface ChildCapabilities {
  readonly pluginCollections: Readonly<
    Record<string, ResolvedPipelinePluginCollectionSnapshot>
  >;
  readonly modelAliases: Readonly<Record<string, DaemonModelAliasResolution>>;
  /**
   * The child's definition with the cloud models its run's person chose
   * when the run started (CAN-7044), which it runs instead; absent when no
   * step's model changes.
   */
  readonly pipeline?: Pipeline;
}

/** Whether a child workflow declares plugin collections or model aliases. */
export function declaresOwnCapabilities(
  pipeline: Pick<Pipeline, 'model_aliases' | 'plugin_collections'>,
): boolean {
  return (
    (pipeline.model_aliases?.length ?? 0) > 0 ||
    (pipeline.plugin_collections?.length ?? 0) > 0
  );
}

/** The message a child gets when its core can't resolve its own. */
const UNRESOLVED =
  "The cloud couldn't resolve this child workflow's plugin collections and model aliases.";

/** The definition the core answered, or null when it isn't one. */
function answeredPipeline(document: string): Pipeline | null {
  try {
    const parsed: unknown = JSON.parse(document);
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      'jobs' in parsed
      ? parsePipelineText(document)
      : null;
  } catch {
    return null;
  }
}

export interface ChildCapabilityStore {
  /**
   * Asks the run's core for the child's own collections and aliases and
   * keeps them for it; throws the core's refusal, or a non-disclosing
   * message, when they can't be resolved.
   */
  resolve(request: ChildPipelineAdmissionRequest): Promise<ChildCapabilities>;
  /** The child's, once resolved; undefined for any other execution. */
  of(executionId: string): ChildCapabilities | undefined;
}

export function createChildCapabilityStore(run: {
  readonly client: PipelineOwnerClient;
  readonly executionId: string;
  readonly owner: WorkerPipelineHostRequest['owner'];
  /** The run's own: a cancelled or checkpointed run withdraws the request. */
  readonly signal?: AbortSignal;
}): ChildCapabilityStore {
  const byChild = new Map<string, ChildCapabilities>();
  return {
    async resolve(request) {
      const document = JSON.stringify(request.pipeline);
      if (document.length > WORKER_PIPELINE_OWNER_CHILD_DOCUMENT_MAX)
        throw new Error(
          'This child workflow is too large to resolve its plugin collections and model aliases.',
        );
      const { step } = request;
      const signal = AbortSignal.any(
        [run.signal, request.signal].filter(
          (entry): entry is AbortSignal => entry !== undefined,
        ),
      );
      const settlement = await run.client.request(
        {
          action: 'owner.pipeline.childCapabilities',
          childExecutionId: request.childExecutionId,
          document,
        },
        {
          executionId: run.executionId,
          // The step that starts the child: the run's, or one of its children's.
          childExecutionId:
            step.executionId === run.executionId ? null : step.executionId,
          jobId: step.jobId,
          stepId: step.stepId,
          attempt: step.attempt,
          iteration: step.iteration,
          owner: run.owner,
          deadlineMs: PIPELINE_OWNER_DEADLINE_MS.short,
        },
        signal,
      );
      const { result } = settlement;
      if (result.status === 'failure')
        throw new Error(result.message || UNRESOLVED);
      if (
        result.status !== 'owner' ||
        result.value.kind !== 'pipeline.childCapabilities'
      )
        throw new Error(UNRESOLVED);
      const pluginCollections =
        result.value.pluginCollectionSnapshots === undefined
          ? {}
          : parseLaunchPluginCollections(
              result.value.pluginCollectionSnapshots,
            );
      if (pluginCollections === null) throw new Error(UNRESOLVED);
      const pipeline =
        result.value.document === undefined
          ? undefined
          : answeredPipeline(result.value.document);
      if (pipeline === null) throw new Error(UNRESOLVED);
      const capabilities: ChildCapabilities = {
        pluginCollections,
        modelAliases: result.value.modelAliasResolutions ?? {},
        ...(pipeline === undefined ? {} : { pipeline }),
      };
      byChild.set(request.childExecutionId, capabilities);
      return capabilities;
    },
    of(executionId) {
      return byChild.get(executionId);
    },
  };
}

/**
 * The executor's collection resolver for a run whose children may hold
 * their own: an execution with its own resolves from them, any other from
 * the launch's.
 */
export function childAwarePluginCollectionResolver(
  launch: Readonly<Record<string, ResolvedPipelinePluginCollectionSnapshot>>,
  children: Pick<ChildCapabilityStore, 'of'> | null,
): NonNullable<ExecutionRuntime['resolvePipelinePluginCollections']> {
  return (collections, _preferences, context) => {
    const snapshots =
      (context === undefined
        ? undefined
        : children?.of(context.executionId)?.pluginCollections) ?? launch;
    const resolved: Record<string, ResolvedPipelinePluginCollectionSnapshot> =
      {};
    for (const { id } of collections ?? []) {
      const snapshot = snapshots[id];
      if (snapshot === undefined)
        return Promise.reject(
          new Error(
            `Plugin collection "${id}" was not resolved for this execution.`,
          ),
        );
      resolved[id] = snapshot;
    }
    return Promise.resolve({ snapshots: resolved });
  };
}
