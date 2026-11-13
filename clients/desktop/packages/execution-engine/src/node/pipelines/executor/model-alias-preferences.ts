import type { PipelineModelAliasPreference } from '@canopy/execution-engine/types/pipeline';
import { loadPipelineModelAliasPreferences } from '../plugin-collection-store';
import type { ExecutionOptions, NormalizedPipeline } from './types';

/*
 * A run's model alias preferences as its executor merges them at start:
 * stored, then draft, filtered to the pipeline's aliases. Also what a daemon
 * launch carries (CAN-5832), so both hosts record the same map.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeExecutionModelAliasPreferences(
  preferences: unknown,
): Record<string, PipelineModelAliasPreference> {
  if (!isRecord(preferences)) {
    return {};
  }

  const normalized: Record<string, PipelineModelAliasPreference> = {};
  for (const [aliasId, rawRecord] of Object.entries(preferences)) {
    const trimmedAliasId = aliasId.trim();
    if (!trimmedAliasId) continue;
    if (!isRecord(rawRecord)) {
      continue;
    }
    const mode = rawRecord.mode;
    if (typeof mode !== 'string') {
      continue;
    }
    if (mode === 'reset') {
      normalized[trimmedAliasId] = { mode: 'reset' };
      continue;
    }
    if (mode === 'agent') {
      const rawAgentId = rawRecord.agent_id;
      const agentId = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
      if (agentId.startsWith('agent_model_')) {
        normalized[trimmedAliasId] = { mode: 'agent', agent_id: agentId };
      }
      continue;
    }
    if (mode === 'inline') {
      const rawBase = rawRecord.base;
      const base = typeof rawBase === 'string' ? rawBase.trim() : '';
      if (!base) continue;
      const rawInstructions = rawRecord.instructions;
      if (
        rawInstructions !== undefined &&
        typeof rawInstructions !== 'string'
      ) {
        continue;
      }
      const rawPluginCollectionId = rawRecord.plugin_collection_id;
      const pluginCollectionId =
        rawPluginCollectionId === undefined
          ? undefined
          : typeof rawPluginCollectionId === 'string'
            ? rawPluginCollectionId.trim()
            : '';
      if (rawPluginCollectionId !== undefined && !pluginCollectionId) {
        continue;
      }
      normalized[trimmedAliasId] = {
        mode: 'inline',
        base,
        ...(rawInstructions !== undefined
          ? { instructions: rawInstructions }
          : {}),
        ...(pluginCollectionId
          ? { plugin_collection_id: pluginCollectionId }
          : {}),
      };
    }
  }
  return normalized;
}

export function filterModelAliasPreferencesToPipeline(
  normalizedPipeline: Pick<NormalizedPipeline, 'model_aliases'>,
  preferences: Record<string, PipelineModelAliasPreference>,
): Record<string, PipelineModelAliasPreference> | undefined {
  const aliasIds = new Set(
    (normalizedPipeline.model_aliases ?? []).map((alias) => alias.id),
  );
  if (aliasIds.size === 0) {
    return undefined;
  }
  const filtered: Record<string, PipelineModelAliasPreference> = {};
  for (const [aliasId, preference] of Object.entries(preferences)) {
    if (aliasIds.has(aliasId)) {
      filtered[aliasId] = preference;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/** A run's model alias preferences as it starts: stored, then draft (also CAN-5832's daemon launch). */
export function resolveExecutionModelAliasPreferences(
  normalizedPipeline: Pick<NormalizedPipeline, 'model_aliases'>,
  options: Pick<
    ExecutionOptions,
    'pipelinePreferenceLocator' | 'modelAliasPreferences'
  >,
): Record<string, PipelineModelAliasPreference> | undefined {
  if (!normalizedPipeline.model_aliases) {
    return undefined;
  }
  const storedPreferences = options.pipelinePreferenceLocator
    ? loadPipelineModelAliasPreferences(options.pipelinePreferenceLocator)
    : {};
  const draftPreferences = normalizeExecutionModelAliasPreferences(
    options.modelAliasPreferences,
  );
  return filterModelAliasPreferencesToPipeline(normalizedPipeline, {
    ...storedPreferences,
    ...draftPreferences,
  });
}
