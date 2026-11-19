import type { RemoteControlWorktreeSummaryEntity } from '@canopy/protocol/remote-control/shell';
import type { SummarySectionBodyProps } from './SummarySectionBody';

/**
 * Maps the lenient portal projection onto the shared summary card.
 */
export function remoteControlSummaryToSectionBodyProps(
  entity: RemoteControlWorktreeSummaryEntity | undefined,
): SummarySectionBodyProps {
  return {
    summary: entity
      ? {
          title: entity.title,
          description: entity.description,
          highlights: entity.highlights,
          repos: entity.repos,
          generatedAt: entity.generatedAt,
          lastFullRefreshAt: entity.lastFullRefreshAt,
        }
      : undefined,
    generating: entity?.generating === true,
    refreshEnabled: false,
  };
}
