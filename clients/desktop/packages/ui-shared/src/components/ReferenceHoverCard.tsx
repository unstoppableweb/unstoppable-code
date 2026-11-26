import type { ComponentType, JSX, ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { DisplayAvatar } from '../primitives/DisplayAvatar';

/** A status glyph: an app icon or any glyph that takes a `className`. */
export type ReferenceHoverCardIcon = ComponentType<{
  className?: string;
  size?: 'sm';
  /** Sizes the glyph by its class, as an inline chip's 1em glyph is. */
  exactSize?: boolean;
}>;

export interface ReferenceHoverCardProps {
  /** The status or kind glyph, drawn at 14px in a 16px slot. */
  readonly icon: ReferenceHoverCardIcon | null;
  /** Ink for the glyph and the lead, such as `fg-success`; default primary. */
  readonly ink?: string;
  /** Ink for the lead alone, when it differs from the glyph's. */
  readonly leadInk?: string;
  /** The status, or the item's own name. */
  readonly lead: ReactNode;
  /** Quiet context after the lead, such as `#812` or a repository. */
  readonly context?: readonly ReactNode[];
  /** Pushed to the row's end: a time, or the kind of item. */
  readonly trailing?: ReactNode;
  readonly title?: ReactNode;
  /** A grey line under the title, such as a description or a full path. */
  readonly detail?: ReactNode;
  /** Rows under the title, such as a "Checked 2m ago" note. */
  readonly note?: ReactNode;
  /** The author or assignee shown in the footer. */
  readonly person?: string;
  /** The person's photo; the empty avatar shows until it loads or if it fails. */
  readonly personImage?: string | null;
  /** Counts at the footer's end, each in a quiet pill. */
  readonly facts?: readonly ReactNode[];
  readonly testId?: string;
  /**
   * Keep the title, detail and person out of session replay. Default true;
   * false for app-provided text such as a skill's description.
   */
  readonly replayBlock?: boolean;
  /** Extra data attributes for the card root. */
  readonly layout?: string;
}

/**
 * The empty avatar's glyph: a head and shoulders, for a person without a
 * photo and while a photo loads. It fills the avatar's disc.
 */
function PersonSilhouette(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-full fill-current opacity-16"
    >
      <circle cx="8" cy="6" r="3" />
      <ellipse cx="8" cy="16" rx="6" ry="5" />
    </svg>
  );
}

/** A quiet count on the card's footer, such as `42 files`. */
export function ReferenceHoverCardFact({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center rounded-sm bg-muted px-1.5 fg-secondary"
      data-testid={testId}
    >
      {children}
    </span>
  );
}

/**
 * The hover card every reference chip shares: a status row (glyph, lead,
 * context, time), the title, an optional detail, and a footer with the
 * person and counts. Wrap it in `Skeleton` with sample data while it loads.
 */
export function ReferenceHoverCard({
  icon: Icon,
  ink,
  leadInk,
  lead,
  context = [],
  trailing,
  title,
  detail,
  note,
  person,
  personImage,
  facts = [],
  testId,
  replayBlock = true,
  layout,
}: ReferenceHoverCardProps): JSX.Element {
  const replay = replayBlock ? `${REPLAY_BLOCK_CLASS} ` : '';
  const hasFooter = person !== undefined || facts.length > 0;
  return (
    <div
      className="flex min-w-0 flex-col gap-2 px-0.5 pt-1 pb-1.5 text-xs"
      data-testid={testId}
      data-layout={layout}
    >
      <div className="flex h-4 min-w-0 items-center gap-2 fg-tertiary">
        <span
          className={`inline-flex min-w-0 items-center gap-2 ${ink ?? 'fg-primary'}`}
        >
          {/* skullet measures the slot, so the loading block is centred on
              the row and keeps the slot's corners. */}
          <span
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm"
            skullet-block=""
          >
            {Icon ? <Icon size="sm" /> : null}
          </span>
          <span className={`truncate ${leadInk ?? ''}`}>{lead}</span>
        </span>
        {context.map((item, index) => (
          <span key={index} className="min-w-0 truncate">
            {item}
          </span>
        ))}
        {trailing ? <span className="ml-auto shrink-0">{trailing}</span> : null}
      </div>
      {title ? (
        <p className={`${replay}line-clamp-2 break-words fg-primary`}>
          {title}
        </p>
      ) : null}
      {detail ? (
        <p className={`${replay}line-clamp-3 break-words fg-tertiary`}>
          {detail}
        </p>
      ) : null}
      {note}
      {hasFooter ? (
        <div className="flex min-w-0 items-center gap-2 pt-4">
          {person ? (
            <span className="flex min-w-0 flex-1 items-center gap-2 fg-secondary">
              <DisplayAvatar
                name={person}
                image={personImage}
                size="xs"
                glyph={<PersonSilhouette />}
              />
              <span className={`${replay}truncate`}>{person}</span>
            </span>
          ) : null}
          {facts.length > 0 ? (
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {facts}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
