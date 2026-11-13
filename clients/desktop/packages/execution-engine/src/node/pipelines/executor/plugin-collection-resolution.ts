import type {
  PipelinePluginCollectionPreference,
  ResolvedPipelinePluginCollectionSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import { resolvePipelinePluginCollections } from '@canopy/execution-engine/node/pipelines/plugin-collection-resolver';
import {
  loadPipelinePluginCollectionPreferences,
  normalizePipelinePluginCollectionPreferences,
} from '../plugin-collection-store';
import type { ExecutionOptions, NormalizedPipeline } from './types';

/*
 * A run's plugin collections as its executor resolves them at start: stored
 * preferences, then draft, through the runtime's resolver. A daemon launch
 * resolves them the same way in its core (CAN-5832).
 */

export async function resolveExecutionPluginCollections(
  normalizedPipeline: Pick<NormalizedPipeline, 'plugin_collections'>,
  options: ExecutionOptions,
): Promise<
  | {
      preferences: Record<string, PipelinePluginCollectionPreference>;
      snapshots: Record<string, ResolvedPipelinePluginCollectionSnapshot>;
    }
  | undefined
> {
  if (!normalizedPipeline.plugin_collections) {
    return undefined;
  }

  const storedPreferences = options.pipelinePreferenceLocator
    ? loadPipelinePluginCollectionPreferences(options.pipelinePreferenceLocator)
    : {};
  const draftPreferences =
    options.pluginCollectionPreferences !== undefined
      ? normalizePipelinePluginCollectionPreferences(
          options.pluginCollectionPreferences,
        )
      : {};
  const preferences = {
    ...storedPreferences,
    ...draftPreferences,
  };
  const resolveCollections =
    options.runtime.resolvePipelinePluginCollections ??
    resolvePipelinePluginCollections;
  const resolution = await resolveCollections(
    normalizedPipeline.plugin_collections,
    preferences,
  );
  const blockingErrors = Object.values(resolution.snapshots).flatMap(
    (snapshot) => snapshot.unresolvedRequiredDefaults,
  );
  if (blockingErrors.length > 0) {
    throw new Error(blockingErrors.map((entry) => entry.error).join('\n'));
  }

  return {
    preferences,
    snapshots: resolution.snapshots,
  };
}
