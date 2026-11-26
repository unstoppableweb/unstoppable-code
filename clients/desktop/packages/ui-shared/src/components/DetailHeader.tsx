import { Stack } from '../primitives/Stack';
import type { JSX, ReactNode } from 'react';
import { Heading } from '../primitives/Heading';
import { DetailEntityType } from './MarketplaceTypeLabel';

export interface DetailHeaderProps {
  title: ReactNode;
  /** The heading's id, for a shell's `aria-labelledby`. */
  titleId?: string;
  /** One line under the title saying what the item does. */
  description?: ReactNode;
  /** Quiet facts under the description; empty items are skipped. */
  meta?: readonly ReactNode[];
  /**
   * Page-level actions at the top right, in the `DetailActionBar` order:
   * `[⋯ More] [secondary…] [Share] [Primary]`.
   */
  actions?: ReactNode;
  /**
   * The one alert for the item (an update, a failure), full width under the
   * header. Hosts pick the single most important notice; errors win.
   */
  notice?: ReactNode;
  dataTestId?: string;
}

/**
 * A detail page's header: the item's title, description and a quiet meta
 * line on the left, its actions on the right, and its one notice under both,
 * aligned to the content column. Shared by desktop and web detail pages so
 * every item reads the same way.
 */
export function DetailHeader({
  title,
  titleId,
  description,
  meta = [],
  actions,
  notice,
  dataTestId = 'detail-header',
}: DetailHeaderProps): JSX.Element {
  const facts = meta.filter(
    (item) =>
      item !== null && item !== undefined && item !== false && item !== '',
  );
  return (
    <header className="flex shrink-0 flex-col gap-4" data-testid={dataTestId}>
      <div className="min-w-0 flex flex-col gap-2">
        <Stack gap="tight">
          {/* The title shares its line with the actions; the description and
            meta run the full width under both. */}
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <Heading
              level={1}
              variant="page"
              id={titleId}
              className="min-w-0"
              data-testid={`${dataTestId}-title`}
            >
              <span className="inline-flex flex-wrap items-baseline gap-x-2">
                {title}
                <DetailEntityType />
              </span>
            </Heading>
            {actions ? (
              <div
                className="flex shrink-0 flex-wrap items-center justify-end gap-2"
                data-testid={`${dataTestId}-actions`}
              >
                {actions}
              </div>
            ) : null}
          </div>

          {description ? (
            <p
              className="text-s fg-secondary"
              data-testid={`${dataTestId}-description`}
            >
              {description}
            </p>
          ) : null}
        </Stack>

        {facts.length > 0 ? (
          <p
            className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs fg-tertiary"
            data-testid={`${dataTestId}-meta`}
          >
            {facts.map((fact, index) => (
              // The separator leads its fact, so a wrapped line never ends
              // on a dangling dot.
              <span key={index} className="inline-flex items-center gap-1.5">
                {index > 0 ? <span aria-hidden="true">·</span> : null}
                {fact}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      {notice}
    </header>
  );
}
