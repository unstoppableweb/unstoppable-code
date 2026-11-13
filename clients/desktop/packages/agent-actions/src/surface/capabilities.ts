import type { PipelineRunLocation } from '../families/pipelines/actions';
import type { AgentWatcherTriggerType } from '../watchers/catalog';

export type AgentActionExecutionScope = 'worktree' | 'directory';

export type AgentChatCreatePlacement = 'current' | 'new_worktree';

/**
 * What one host's agent surface offers. Shared code branches on these
 * capabilities, never on host identity. They decide what the surface
 * advertises and which action types it dispatches; per-call availability
 * that depends on the calling chat stays with the host's ports.
 */
export interface AgentActionHostCapabilities {
  executionScope: AgentActionExecutionScope;
  /** Action types this surface dispatches; others are `unsupported_action`. */
  actionTypes: readonly string[];
  /**
   * Dispatchable action types that SearchActions lists only for an exact
   * `actionType` lookup: compatibility aliases of other offered actions.
   * Families with their own `search` do not consult it.
   */
  searchHiddenActionTypes?: readonly string[];
  chatCreatePlacements: readonly AgentChatCreatePlacement[];
  /** Watcher triggers the watcher tools advertise and accept. */
  watcherTriggers: readonly AgentWatcherTriggerType[];
  watcherTargetScope: 'any' | 'current_workspace';
  split: { forked: boolean; branched: boolean };
  hiddenInstructions: boolean;
  limits: boolean;
  /**
   * Where `pipeline.run` starts runs. Omitted means both: this computer by
   * default, or the cloud on request. A host with only `cloud` starts every
   * run in the cloud, with no project, and its catalog says so.
   */
  pipelineRunLocations?: readonly PipelineRunLocation[];
}
