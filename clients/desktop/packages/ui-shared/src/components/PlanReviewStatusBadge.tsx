import type { JSX } from 'react';
import type { BadgeTone } from '../lib/badge';
import type {
  PlanDisplayStatus,
  PlanDisplayStatusKind,
} from '../lib/planDisplayStatus';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { LoadingSpinner } from '../primitives/LoadingSpinner';

const STATUS_TONES: Record<PlanDisplayStatusKind, BadgeTone> = {
  pending: 'warning',
  approved: 'success',
  dismissed: 'neutral',
  implementing: 'info',
  implemented: 'success',
  unknown: 'neutral',
};

export interface PlanReviewStatusBadgeProps {
  status: Pick<PlanDisplayStatus, 'kind' | 'label'>;
  className?: string;
  'data-testid'?: string;
}

/**
 * A tracked plan's review or implementation status, shared by the plan
 * header and the Plans cards on desktop and web. Pure display: hosts resolve
 * the status with `resolvePlanDisplayStatus`. Implementing carries a
 * decorative spinner; the label alone names the state.
 */
export function PlanReviewStatusBadge({
  status,
  className,
  'data-testid': testId,
}: PlanReviewStatusBadgeProps): JSX.Element | null {
  if (!status.label) return null;
  return (
    <Badge
      tone={STATUS_TONES[status.kind]}
      muted={status.kind === 'dismissed'}
      data-testid={testId}
      className={className}
    >
      {status.kind === 'implementing' ? (
        <LoadingSpinner
          decorative
          sizePx={10}
          className="shrink-0"
          dataTestId={testId ? `${testId}-spinner` : undefined}
        />
      ) : null}
      {status.label}
    </Badge>
  );
}

export interface PlanStatusNoteLink {
  /** Visible link label, for example `View run` or `View chat`. */
  label: string;
  onSelect: () => void;
  'data-testid'?: string;
}

export interface PlanStatusNoteProps {
  /** Leading outcome text, for example `Workflow failed`. */
  text?: string;
  link?: PlanStatusNoteLink;
  className?: string;
  'data-testid'?: string;
}

/**
 * One line beside a plan's status: an optional outcome and a navigation
 * link (`Workflow failed · View run`). Renders nothing when it has neither.
 */
export function PlanStatusNote({
  text,
  link,
  className,
  'data-testid': testId,
}: PlanStatusNoteProps): JSX.Element | null {
  if (!text && !link) return null;
  return (
    <span
      data-testid={testId}
      className={`inline-flex min-w-0 items-center gap-1 text-2xs fg-secondary${className ? ` ${className}` : ''}`}
    >
      {text ? <span className="truncate">{text}</span> : null}
      {text && link ? <span aria-hidden="true">·</span> : null}
      {link ? (
        <Button
          variant="link"
          data-testid={link['data-testid']}
          onClick={(event): void => {
            event.stopPropagation();
            link.onSelect();
          }}
          onKeyDown={(event): void => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation();
            }
          }}
          className="shrink-0"
        >
          {link.label}
        </Button>
      ) : null}
    </span>
  );
}
