import { Badge } from '@canopy/ui-shared/primitives/Badge';
import { TextLink, Stack } from '@canopy/ui-shared/components';
import { type JSX } from 'react';
import type { SplitPrMap } from '@canopy/desktop-shared/types/github';

function splitStatusLabel(status: SplitPrMap['status']): string {
  switch (status) {
    case 'completed':
      return 'Split complete';
    case 'cancelled':
      return 'Split cancelled';
    case 'failed':
      return 'Split failed';
    default:
      return 'Split in progress';
  }
}

/**
 * Shared read-only rendering of a persisted `SplitPrMap`: the status badge, the
 * integration PR link ("supersedes #original"), the original PR link, and the
 * per-child `[i/N] title` list with base branch + PR links.
 *
 * Extracted from the PR-panel `SplitResultView` so the full-panel
 * `SplitWorkflowView` Finalize finished page renders the identical summary
 * without duplicating the layout — mirroring how the review panel and progress
 * checklist are shared between the two surfaces. The action buttons
 * (Resume/Discard on the panel, Done on the finished page) stay owned by each
 * caller since they differ.
 */
export function SplitResultSummary({ map }: { map: SplitPrMap }): JSX.Element {
  const childTotal = map.children.length;
  return (
    <Stack gap="inline" className="min-w-0" data-testid="split-result-summary">
      <Badge
        className="self-start"
        tone={map.status === 'completed' ? 'success' : 'warning'}
      >
        {splitStatusLabel(map.status)}
      </Badge>
      {map.integrationPrUrl !== undefined &&
        map.integrationPrNumber !== undefined && (
          <p className="break-words text-xs fg-secondary">
            <TextLink
              href={map.integrationPrUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="muted"
            >
              Integration PR #{map.integrationPrNumber}
            </TextLink>{' '}
            supersedes #{map.originalPrNumber}
          </p>
        )}
      <p className="break-words text-xs fg-secondary">
        <TextLink
          href={map.originalPrUrl}
          target="_blank"
          rel="noopener noreferrer"
          variant="muted"
        >
          Original PR #{map.originalPrNumber}
        </TextLink>
        {map.status === 'completed' ? ' (closed)' : ''}
      </p>
      <div className="flex flex-col gap-1.5">
        {map.children.map((child) => (
          // Two-line stacked row so long branch names and PR links wrap within
          // the card at any width instead of spilling past the border. Both
          // surfaces (the narrow PR activity card and the wide finalize page)
          // render the same component, so the layout is driven by the container
          // rather than a fixed-width right cluster.
          <div
            key={child.index}
            className="min-w-0 text-xs"
            data-testid="split-result-summary-child"
          >
            <div className="flex min-w-0 items-start justify-between gap-2">
              <span className="min-w-0 break-words fg-primary/80">
                [{child.index}/{childTotal}] {child.title}
              </span>
              {child.prUrl !== undefined && child.prNumber !== undefined && (
                <TextLink
                  href={child.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="quiet"
                  className="shrink-0"
                >
                  #{child.prNumber}
                </TextLink>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 flex-col gap-0.5 fg-secondary">
              <span className="min-w-0 break-all">
                base: {child.baseBranch}
              </span>
              <span className="min-w-0 break-all">
                branch: {child.branchName}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Stack>
  );
}
