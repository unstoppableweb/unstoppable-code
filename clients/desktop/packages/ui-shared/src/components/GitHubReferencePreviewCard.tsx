import type { JSX, ReactNode } from 'react';
import type {
  GitHubItemPreview,
  GitHubPreview,
  GitHubRepositoryPreview,
} from '@canopy/protocol/reference-previews';
import { formatRelativeTime } from '../lib/format-relative-time';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { CircleCheckIcon, RecordIcon } from '../icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { GroupedDiffStats } from './GroupedDiffStats';
import { CometSpinner } from '../primitives/CometSpinner';
import { Skeleton } from '../primitives/Skeleton';
import {
  ReferenceHoverCard,
  ReferenceHoverCardFact,
  type ReferenceHoverCardIcon,
} from './ReferenceHoverCard';
import {
  PR_STATUS_LINES,
  prStatusLineKind,
  type WorktreeRowPrStatus,
} from './pr-status-glyph';

export type GitHubReferencePreviewCardView =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly preview: GitHubPreview;
      readonly checkedAt: number;
      /** A stale value is showing while it refreshes, or after a failed refresh. */
      readonly stale: boolean;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'disconnected' | 'unavailable' | 'failed';
    };

const UNAVAILABLE_COPY = {
  disconnected: 'Connect GitHub in Settings to preview this',
  unavailable: 'Preview unavailable',
  failed: "Couldn't reach GitHub",
} as const;

const ITEM_STATE_COPY = {
  open: 'Open',
  closed: 'Closed',
  merged: 'Merged',
} as const;

function itemFacts(preview: GitHubItemPreview): string[] {
  const isPull = preview.itemType === 'pull';
  const state =
    isPull && preview.draft && preview.state === 'open'
      ? 'Draft'
      : ITEM_STATE_COPY[preview.state];
  return [isPull ? 'Pull request' : 'Issue', state];
}

function repositoryFacts(preview: GitHubRepositoryPreview): string[] {
  const facts = ['Repository', preview.private ? 'Private' : 'Public'];
  if (preview.archived) facts.push('Archived');
  return facts;
}

/**
 * How a ready item card is laid out. `classic` is the label and title, body
 * excerpt, and facts line; `status` leads with the state pill, then the
 * title, then the author and the change size.
 */
export type GitHubReferencePreviewCardLayout = 'classic' | 'status';

/** The item as the sidebar's PR glyph reads it. */
function pullStatus(preview: GitHubItemPreview): WorktreeRowPrStatus {
  const open = preview.state === 'open';
  const pull = preview.pull;
  return {
    state: open && preview.draft ? 'draft' : preview.state,
    checkStatus: pull?.checks,
    reviewStatus: pull?.reviewDecision ?? undefined,
    hasConflicts: open && pull?.mergeable === 'conflicting',
    inMergeQueue: open && pull?.inMergeQueue === true,
  };
}

/** The glyph, ink and label an item's status row leads with. */
export function gitHubItemStatus(preview: GitHubItemPreview): {
  kind: string;
  label: string;
  Icon: ReferenceHoverCardIcon | null;
  ink: string;
} {
  if (preview.itemType === 'issue') {
    return preview.state === 'open'
      ? {
          kind: 'open',
          label: 'Open',
          Icon: RecordIcon,
          ink: OPERATIONAL_STATUS_COLORS.success.foreground,
        }
      : {
          kind: 'closed',
          label: 'Closed',
          Icon: CircleCheckIcon,
          ink: OPERATIONAL_STATUS_COLORS.merged.foreground,
        };
  }
  const kind = prStatusLineKind(pullStatus(preview));
  return { kind, ...PR_STATUS_LINES[kind] };
}

/** The running-checks spinner in the glyph's place. */
function ChecksRunningGlyph(): JSX.Element {
  return <CometSpinner sizePx={12} />;
}

function StatusLayoutItemCard({
  preview,
  stale,
  checkedAt,
}: {
  preview: GitHubItemPreview;
  /** A cached value is showing: name when it was checked, not updated. */
  stale: boolean;
  checkedAt: number;
}): JSX.Element {
  const pull = preview.itemType === 'pull' ? preview.pull : undefined;
  const hasChanges = pull !== undefined && pull.additions + pull.deletions > 0;
  const status = gitHubItemStatus(preview);
  const facts: ReactNode[] = [];
  if (pull && hasChanges) {
    facts.push(
      <ReferenceHoverCardFact key="diff" testId="github-reference-preview-diff">
        <GroupedDiffStats
          insertions={pull.additions}
          deletions={pull.deletions}
          numerals="proportional"
        />
      </ReferenceHoverCardFact>,
    );
  }
  if (pull) {
    facts.push(
      <ReferenceHoverCardFact
        key="files"
        testId="github-reference-preview-files"
      >
        {pull.changedFiles === 1
          ? '1 file'
          : `${FILE_COUNT_FORMAT.format(pull.changedFiles)} files`}
      </ReferenceHoverCardFact>,
    );
  }
  return (
    <ReferenceHoverCard
      testId="github-reference-preview-card"
      layout="status"
      icon={status.Icon ?? ChecksRunningGlyph}
      ink={status.ink}
      lead={
        <span
          data-testid="github-reference-preview-status"
          data-status={status.kind}
        >
          {status.label}
        </span>
      }
      context={[`#${preview.number}`]}
      trailing={
        <span data-testid="github-reference-preview-age">
          {formatRelativeTime(preview.updatedAt)}
        </span>
      }
      title={preview.title}
      note={
        // A cached card that couldn't refresh says so on its own line, so
        // the header keeps the status whole.
        stale ? (
          <span
            className="-mt-1 text-2xs fg-tertiary"
            data-testid="github-reference-preview-checked"
          >
            Checked {formatRelativeTime(checkedAt)}
          </span>
        ) : undefined
      }
      person={preview.author ?? undefined}
      personImage={preview.authorAvatarUrl}
      facts={facts}
    />
  );
}

const FILE_COUNT_FORMAT = new Intl.NumberFormat('en-US');

/**
 * The status card while its item loads: the real card with a pull request's
 * sample data, which skullet measures into a skeleton, so the card keeps its
 * size when the data arrives.
 */
function StatusLayoutItemSkeleton({
  itemNumber,
}: {
  itemNumber: number;
}): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading preview"
      testId="github-reference-preview-skeleton"
    >
      <StatusLayoutItemCard
        preview={sampleItem(itemNumber)}
        stale={false}
        checkedAt={0}
      />
    </Skeleton>
  );
}

/** A pull request of typical length, for the loading card's shape. */
const SAMPLE_REPOSITORY: GitHubRepositoryPreview = {
  kind: 'repository',
  owner: 'owner',
  repository: 'repository',
  fullName: 'owner/repository',
  url: 'https://github.com/owner/repository',
  description: 'A one-line description of what the repository holds',
  private: false,
  archived: false,
  updatedAt: new Date(0).toISOString(),
};

function sampleItem(itemNumber: number): GitHubItemPreview {
  return {
    kind: 'item',
    owner: 'owner',
    repository: 'repository',
    number: itemNumber,
    itemType: 'pull',
    title: 'Keep the card the same size while its preview loads from GitHub',
    url: 'https://github.com/owner/repository',
    description: null,
    state: 'open',
    draft: false,
    author: 'author-name',
    authorAvatarUrl: null,
    updatedAt: new Date(0).toISOString(),
    pull: {
      additions: 142,
      deletions: 18,
      changedFiles: 6,
      mergeable: 'mergeable',
      checks: 'none',
      reviewDecision: null,
      inMergeQueue: false,
    },
  };
}

/** Informational hover card for one GitHub repository, issue, or pull request reference. */
export function GitHubReferencePreviewCard({
  label,
  view,
  layout = 'classic',
  itemNumber,
}: {
  /** Display identity: `#1234`, `owner/repo#1234`, or `owner/repo`. */
  label: string;
  view: GitHubReferencePreviewCardView;
  layout?: GitHubReferencePreviewCardLayout;
  /**
   * The issue or pull request number, when the reference names one. While it
   * loads, the status layout shows the card's shape around it.
   */
  itemNumber?: number;
}): JSX.Element {
  if (
    view.status === 'loading' &&
    layout === 'status' &&
    itemNumber !== undefined
  ) {
    return <StatusLayoutItemSkeleton itemNumber={itemNumber} />;
  }
  if (view.status === 'loading' && layout !== 'status') {
    // The classic card with sample data of the reference's kind (a number
    // names an issue or pull request, none a repository), measured into a
    // skeleton, so the card keeps its size when the preview arrives.
    return (
      <Skeleton
        loading
        label="Loading preview"
        testId="github-reference-preview-skeleton"
      >
        <GitHubReferencePreviewCard
          label={label}
          view={{
            status: 'ready',
            preview:
              itemNumber === undefined
                ? SAMPLE_REPOSITORY
                : sampleItem(itemNumber),
            checkedAt: 0,
            stale: false,
          }}
          layout="classic"
        />
      </Skeleton>
    );
  }
  if (view.status !== 'ready') {
    return (
      <div className="flex min-w-0 flex-col gap-0.5 text-xs" aria-live="polite">
        <span
          className={`${REPLAY_BLOCK_CLASS} font-mono text-2xs fg-secondary`}
        >
          {label}
        </span>
        <span className="fg-secondary">
          {view.status === 'loading'
            ? 'Loading preview…'
            : UNAVAILABLE_COPY[view.reason]}
        </span>
      </div>
    );
  }
  const { preview } = view;
  if (layout === 'status' && preview.kind === 'item') {
    return (
      <StatusLayoutItemCard
        preview={preview}
        stale={view.stale}
        checkedAt={view.checkedAt}
      />
    );
  }
  const facts =
    preview.kind === 'item' ? itemFacts(preview) : repositoryFacts(preview);
  return (
    <div
      className="flex min-w-0 flex-col gap-1 text-xs"
      data-testid="github-reference-preview-card"
    >
      {preview.kind === 'item' ? (
        // Inline flow, not flex: a long `owner/repo#1234` label wraps with the
        // title instead of squeezing it.
        <div className="min-w-0 break-words">
          <span
            className={`${REPLAY_BLOCK_CLASS} pr-1.5 font-mono text-2xs fg-secondary`}
          >
            {label}
          </span>
          <span className={`${REPLAY_BLOCK_CLASS} font-medium fg-primary`}>
            {preview.title}
          </span>
        </div>
      ) : (
        <div
          className={`${REPLAY_BLOCK_CLASS} min-w-0 break-words font-medium fg-primary`}
        >
          {preview.fullName}
        </div>
      )}
      {preview.description && (
        <p className={`${REPLAY_BLOCK_CLASS} line-clamp-3 fg-secondary`}>
          {preview.description}
        </p>
      )}
      <div className="truncate fg-secondary">
        {facts.join(' · ')}
        {preview.kind === 'item' && preview.author && (
          <>
            {' · by '}
            <span className={REPLAY_BLOCK_CLASS}>{preview.author}</span>
          </>
        )}
      </div>
      <div className="truncate text-2xs tabular-nums fg-tertiary">
        {view.stale
          ? `Checked ${formatRelativeTime(view.checkedAt)}`
          : `Updated ${formatRelativeTime(preview.updatedAt)}`}
      </div>
    </div>
  );
}
