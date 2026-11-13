import type { PipelineCapabilitySelection } from '@canopy/execution-engine/types/pipeline';
import type { MarketplaceInfo } from '@canopy/execution-engine/types/plugins';

/**
 * Unified Plugins-page entry id for a resolved capability selection. Curated
 * marketplace plugins surface as `curated:<name>` entries in the discovery
 * projection; every other marketplace plugin is `mkt:<id>/<name>`.
 */
export function entryIdForSelection(
  selection: PipelineCapabilitySelection,
  marketplaces: readonly Pick<MarketplaceInfo, 'id' | 'curated'>[],
): string {
  if (selection.kind === 'skill') {
    return `skill:${selection.sourceId}:${selection.skillName}`;
  }
  const marketplace = marketplaces.find(
    (candidate) => candidate.id === selection.marketplaceId,
  );
  if (marketplace?.curated === true) {
    return `curated:${selection.pluginName}`;
  }
  return `mkt:${selection.marketplaceId}/${selection.pluginName}`;
}
