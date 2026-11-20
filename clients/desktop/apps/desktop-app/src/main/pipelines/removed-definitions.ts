import * as path from 'node:path';
import { inspectStoredPipelineDocument } from '@canopy/execution-engine/pipelines/store';
import type {
  ExecutionState,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';

/**
 * How this process saw a saved definition go: `undone` when an install's
 * rollback removed a definition it had added (CAN-7308), `deleted` when it
 * was deleted (CAN-7347).
 */
export type DefinitionRemoval = 'undone' | 'deleted';

const removedDefinitions = new Map<string, DefinitionRemoval>();

export function noteDefinitionRemoved(
  definitionId: string,
  removal: DefinitionRemoval,
): void {
  removedDefinitions.set(definitionId, removal);
}

function isStoredDefinitionAbsent(definitionId: string): boolean {
  return inspectStoredPipelineDocument(definitionId).kind === 'absent';
}

/**
 * How the definition was removed, while the store still lacks it. The mark
 * drops once the store holds the id again, as after a reinstall.
 */
export function definitionRemoval(
  definitionId: string,
): DefinitionRemoval | undefined {
  const removal = removedDefinitions.get(definitionId);
  if (removal === undefined) return undefined;
  if (isStoredDefinitionAbsent(definitionId)) return removal;
  removedDefinitions.delete(definitionId);
  return undefined;
}

/**
 * Whether a start names a saved user workflow that's gone, so it must not
 * run from the copy its caller holds. Either this process saw it removed,
 * or the caller's locator says it's a stored user workflow and the store
 * lacks it. A definition that was never saved carries neither and runs as
 * given. The locator only ever refuses a start, never admits one.
 */
export function isRemovedSavedDefinition(
  definitionId: string,
  locator: PipelinePreferenceLocator | undefined,
): boolean {
  if (definitionRemoval(definitionId) !== undefined) return true;
  return (
    locator?.type === 'stored' &&
    locator.source === 'user' &&
    locator.value === definitionId &&
    isStoredDefinitionAbsent(definitionId)
  );
}

/**
 * Whether a saved run is a run of a user workflow that's gone, so replaying
 * it would run old steps against files that went with the workflow. Its
 * record says so even after a restart: a stored user locator, or a data
 * folder keyed by the workflow's own id, which only a local user workflow
 * has (every other source keys it by a hash of the source).
 */
export function isRunOfRemovedSavedDefinition(
  run: Pick<
    ExecutionState,
    'pipeline_id' | 'pipeline_preference_locator' | 'pipeline_assets'
  >,
): boolean {
  const definitionId = run.pipeline_id;
  if (isRemovedSavedDefinition(definitionId, run.pipeline_preference_locator))
    return true;
  const dataDir = run.pipeline_assets?.pipeline_data_dir;
  return (
    dataDir !== undefined &&
    path.basename(path.dirname(dataDir)) === definitionId &&
    isStoredDefinitionAbsent(definitionId)
  );
}
