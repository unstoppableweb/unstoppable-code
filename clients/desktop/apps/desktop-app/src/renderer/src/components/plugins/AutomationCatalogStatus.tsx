import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import { brandText } from '@/lib/brand';
import type { CuratedAutomationsController } from '../../hooks/useCuratedAutomations';
import { BusyLabel, Button } from '@canopy/ui-shared/components';

/** Mirrors the curated pipeline catalog's saved-copy notice. */
function curatedAutomationStaleMessage(cloudDisplayName: string): string {
  return `Showing saved catalog metadata. Connect to ${cloudDisplayName} to preview or add an automation.`;
}

interface AutomationCatalogStatusProps {
  /** Undefined while the account has no curated automation catalog. */
  readonly curated:
    | Pick<
        CuratedAutomationsController,
        | 'error'
        | 'stale'
        | 'nextCursor'
        | 'loading'
        | 'onRefresh'
        | 'onLoadMore'
      >
    | undefined;
  readonly sharedNextCursor: string | null;
  readonly sharedLoadingMore: boolean;
  readonly onLoadMoreShared: () => void;
}

/**
 * What the Automations tab says under its list: a saved-catalog or
 * load-failure notice when one applies, and one control for the next page of
 * every catalog that has one. The Pipelines tab's `PipelineCatalogStatus`
 * follows the same rules.
 */
export function AutomationCatalogStatus({
  curated,
  sharedNextCursor,
  sharedLoadingMore,
  onLoadMoreShared,
}: AutomationCatalogStatusProps): JSX.Element | null {
  const curatedHasMore = Boolean(curated?.nextCursor) && !curated?.error;
  const hasMore = curatedHasMore || sharedNextCursor !== null;
  const loadingMore = sharedLoadingMore || (curatedHasMore && curated?.loading);
  const notice = curated?.error ? (
    <Notice
      errorSource="plugins-curated-automations-error"
      intent="destructive"
      role="none"
      title="Couldn't load curated automations."
      data-testid="plugins-curated-automations-error"
      actions={
        <NoticeButton onClick={curated.onRefresh}>Try again</NoticeButton>
      }
    >
      {curated.error}
    </Notice>
  ) : curated?.stale ? (
    <Notice
      intent="neutral"
      role="none"
      data-testid="plugins-curated-automations-stale"
    >
      {curatedAutomationStaleMessage(`${brandText.appName} Cloud`)}
    </Notice>
  ) : null;

  if (!notice && !hasMore) return null;
  return (
    <div
      data-testid="automation-catalog-status"
      className="flex flex-col items-start gap-4"
    >
      {hasMore && (
        <Button
          size="compact"
          data-testid="automation-catalog-load-more"
          disabled={loadingMore}
          onClick={() => {
            if (curatedHasMore) curated?.onLoadMore();
            if (sharedNextCursor !== null) onLoadMoreShared();
          }}
        >
          <BusyLabel busy={loadingMore === true}>
            Show more automations
          </BusyLabel>
        </Button>
      )}
      {notice}
    </div>
  );
}
