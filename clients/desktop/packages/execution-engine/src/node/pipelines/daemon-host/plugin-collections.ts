import type { ResolvedPipelinePluginCollectionSnapshot } from '@canopy/execution-engine/types/pipeline';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { ExecutionRuntime } from '../executor/types';

/*
 * A daemon run's plugin collections (CAN-5832): its core resolves them at
 * launch, as its executor would at start, and the host answers the
 * executor's resolver from that snapshot. Selection references only; a
 * snapshot that carries MCP configuration is refused. One that names a
 * standalone MCP server is kept: an SDK step drops those servers in process
 * too, and this host never reads them (CAN-6011, CAN-6277).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function warnings(
  value: unknown,
): Array<{ defaultKey: string; warning: string }> | null {
  if (!Array.isArray(value)) return null;
  const parsed: Array<{ defaultKey: string; warning: string }> = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.defaultKey !== 'string' ||
      typeof entry.warning !== 'string'
    )
      return null;
    parsed.push({ defaultKey: entry.defaultKey, warning: entry.warning });
  }
  return parsed;
}

function errors(
  value: unknown,
): Array<{ defaultKey: string; error: string }> | null {
  if (!Array.isArray(value)) return null;
  const parsed: Array<{ defaultKey: string; error: string }> = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.defaultKey !== 'string' ||
      typeof entry.error !== 'string'
    )
      return null;
    parsed.push({ defaultKey: entry.defaultKey, error: entry.error });
  }
  return parsed;
}

function parseSnapshot(
  value: unknown,
): ResolvedPipelinePluginCollectionSnapshot | null {
  if (!isRecord(value) || value.mcpServers !== undefined) return null;
  const missingOptionalDefaults = warnings(value.missingOptionalDefaults);
  const unresolvedRequiredDefaults = errors(value.unresolvedRequiredDefaults);
  if (
    !isRecord(value.selections) ||
    missingOptionalDefaults === null ||
    unresolvedRequiredDefaults === null ||
    (value.chatSelections !== undefined && !isRecord(value.chatSelections)) ||
    (value.sourceCollectionIds !== undefined &&
      !isStringArray(value.sourceCollectionIds))
  )
    return null;
  const selections = normalizePluginSelections(value.selections);
  const chatSelections =
    value.chatSelections === undefined
      ? undefined
      : normalizePluginSelections(value.chatSelections);
  return {
    selections,
    ...(chatSelections && { chatSelections }),
    ...(isStringArray(value.sourceCollectionIds) && {
      sourceCollectionIds: value.sourceCollectionIds,
    }),
    missingOptionalDefaults,
    unresolvedRequiredDefaults,
  };
}

/** A launch's snapshots, or null when any does not parse. */
export function parseLaunchPluginCollections(
  value: Readonly<Record<string, unknown>>,
): Record<string, ResolvedPipelinePluginCollectionSnapshot> | null {
  const snapshots: Record<string, ResolvedPipelinePluginCollectionSnapshot> =
    {};
  for (const [id, raw] of Object.entries(value)) {
    const snapshot = parseSnapshot(raw);
    if (snapshot === null) return null;
    snapshots[id] = snapshot;
  }
  return snapshots;
}

/** The executor's collection resolver over a launch's snapshots. */
export function launchPluginCollectionResolver(
  snapshots: Readonly<Record<string, ResolvedPipelinePluginCollectionSnapshot>>,
): NonNullable<ExecutionRuntime['resolvePipelinePluginCollections']> {
  return (collections) => {
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
