import type { JSX } from 'react';
import type {
  LinearIssuePreview,
  LinearStatusType,
} from '@canopy/protocol/reference-previews';
import { formatRelativeTime } from '../lib/format-relative-time';
import {
  LinearBacklogIcon,
  LinearCanceledIcon,
  LinearDoneIcon,
  LinearInProgressIcon,
  LinearInReviewIcon,
  LinearTodoIcon,
} from '../icons/LinearStatusIcons';
import { Skeleton } from '../primitives/Skeleton';
import {
  ReferenceHoverCard,
  type ReferenceHoverCardIcon,
} from './ReferenceHoverCard';

export type LinearIssuePreviewCardView =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly preview: LinearIssuePreview;
      readonly checkedAt: number;
      /** A stale value is showing while it refreshes, or after a failed refresh. */
      readonly stale: boolean;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'disconnected' | 'unavailable' | 'failed';
    };

const UNAVAILABLE_COPY = {
  disconnected: 'Connect Linear in Settings to preview this issue',
  unavailable: 'Preview unavailable',
  failed: 'Couldn’t reach Linear',
} as const;

export interface LinearStatusGlyph {
  readonly Icon: ReferenceHoverCardIcon;
  /** Ink for the glyph. */
  readonly ink: string;
  /** Ink for the status name, when it differs from the glyph's. */
  readonly labelInk?: string;
}

/**
 * The glyph for a Linear status, drawn the way Linear draws its kind; a
 * started status named for review is the three-quarter pie. Null without a
 * kind, so callers keep the Linear mark.
 */
export function linearStatusGlyph(
  type: LinearStatusType | null | undefined,
  name: string | null,
): LinearStatusGlyph | null {
  switch (type) {
    case 'backlog':
      return {
        Icon: LinearBacklogIcon,
        ink: 'fg-quaternary',
        labelInk: 'fg-primary',
      };
    case 'triage':
    case 'unstarted':
      return {
        Icon: LinearTodoIcon,
        ink: 'fg-secondary',
        labelInk: 'fg-primary',
      };
    case 'started':
      return name !== null && /review/i.test(name)
        ? { Icon: LinearInReviewIcon, ink: 'fg-success' }
        : { Icon: LinearInProgressIcon, ink: 'fg-warning' };
    case 'completed':
      return { Icon: LinearDoneIcon, ink: 'fg-purple' };
    case 'canceled':
      return { Icon: LinearCanceledIcon, ink: 'fg-quaternary' };
    default:
      return null;
  }
}

function ReadyCard({
  preview,
  stale,
  checkedAt,
}: {
  preview: LinearIssuePreview;
  stale: boolean;
  checkedAt: number;
}): JSX.Element {
  const glyph = linearStatusGlyph(preview.statusType, preview.status);
  return (
    <ReferenceHoverCard
      testId="linear-issue-preview-card"
      icon={glyph?.Icon ?? LinearTodoIcon}
      ink={glyph?.ink ?? 'fg-secondary'}
      leadInk={glyph ? glyph.labelInk : 'fg-primary'}
      lead={preview.status ?? 'No status'}
      context={[preview.identifier]}
      trailing={
        <span className="tabular-nums">
          {formatRelativeTime(preview.updatedAt)}
        </span>
      }
      title={preview.title}
      note={
        stale ? (
          <span className="-mt-1 text-2xs fg-tertiary">
            Checked {formatRelativeTime(checkedAt)}
          </span>
        ) : undefined
      }
      person={preview.assignee ?? 'Unassigned'}
      personImage={preview.assigneeAvatarUrl}
    />
  );
}

/** An issue of typical length, for the loading card's shape. */
function sampleIssue(identifier: string): LinearIssuePreview {
  return {
    identifier,
    title: 'Keep the card the same size while its preview loads from Linear',
    url: 'https://linear.app/',
    description: null,
    status: 'In progress',
    statusType: 'started',
    assignee: 'Assignee name',
    assigneeAvatarUrl: null,
    project: null,
    updatedAt: new Date(0).toISOString(),
  };
}

/** Informational hover card for one Linear issue reference. */
export function LinearIssuePreviewCard({
  identifier,
  view,
}: {
  identifier: string;
  view: LinearIssuePreviewCardView;
}): JSX.Element {
  if (view.status === 'loading') {
    return (
      <Skeleton
        loading
        label="Loading preview"
        testId="linear-issue-preview-skeleton"
      >
        <ReadyCard
          preview={sampleIssue(identifier)}
          stale={false}
          checkedAt={0}
        />
      </Skeleton>
    );
  }
  if (view.status !== 'ready') {
    return (
      <div className="flex min-w-0 flex-col gap-0.5 text-xs" aria-live="polite">
        <span className="font-mono text-2xs fg-secondary">{identifier}</span>
        <span className="fg-secondary">{UNAVAILABLE_COPY[view.reason]}</span>
      </div>
    );
  }
  return (
    <ReadyCard
      preview={view.preview}
      stale={view.stale}
      checkedAt={view.checkedAt}
    />
  );
}
