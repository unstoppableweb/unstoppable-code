import type {
  AgentProviderType,
  TrackedPlanSource,
} from '@canopy/desktop-shared/types';
import { getModelCatalogProviderLabel } from '@canopy/protocol';
import { WORKFLOW_ITEM_LABEL } from '@canopy/ui-shared/lib/workflow-labels';

export type UiAgentProvider = AgentProviderType;
export type UiTrackedPlanSource = TrackedPlanSource;

/**
 * Delegates to the protocol helper rather than re-declaring the same switch.
 * Some call sites pair the two — `createContinuedTabTitle` strips an existing
 * provider prefix with `getModelCatalogProviderLabel` while its caller adds the
 * new one with this function — so the prefix-idempotency guarantee held only as
 * long as two independent switch statements happened to agree. One helper makes
 * it structural: divergence is now impossible rather than merely unlikely.
 */
export function getProviderLabel(provider: UiAgentProvider): string {
  return getModelCatalogProviderLabel(provider);
}

export function getPlanSourceLabel(source: UiTrackedPlanSource): string {
  switch (source) {
    case 'claude':
    case 'codex':
    case 'cursor':
    case 'antigravity':
    case 'copilot':
    case 'opencode':
    case 'ollama':
      return getModelCatalogProviderLabel(source);
    case 'pipeline':
      return WORKFLOW_ITEM_LABEL;
    case 'imported':
      return 'Imported';
    case 'detected':
      return 'Detected';
  }
}
