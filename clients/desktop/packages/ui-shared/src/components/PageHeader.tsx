import type { JSX, ReactNode, Ref } from 'react';
import { BackIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { Stack } from './Stack';

/** A detail page's way back to the list it came from, named for that list. */
export interface PageHeaderBack {
  readonly label: string;
  readonly onClick: () => void;
  readonly testId?: string;
}

export interface PageHeaderProps {
  /** The page's name: the same words as its nav label, or the item's name. */
  title: ReactNode;
  /** One sentence saying what the page is for. Keep it to one line. */
  description?: ReactNode;
  /**
   * `h1` unless the host already renders the page's `h1` (for example an
   * organization name above this header). Both levels look the same.
   */
  headingLevel?: 'h1' | 'h2';
  /**
   * A detail or drill-in page's way back, on its own line above the title and
   * left-aligned with it. Top-level pages have none.
   */
  back?: PageHeaderBack;
  /**
   * Let the description run wider than the default measure, for a line that
   * carries inline marks and would otherwise wrap.
   */
  wideDescription?: boolean;
  /** A quiet state beside the title, such as `Read-only` or `Off`. */
  badge?: ReactNode;
  /**
   * Page-level controls at the end of the title row: 28px capsule buttons,
   * secondary and icon buttons first, the one primary action last.
   */
  actions?: ReactNode;
  /**
   * Keep the actions slot at a button's height even when a page has no
   * actions (or before they resolve), so sibling pages keep the same box.
   */
  reserveActions?: boolean;
  /**
   * The page's tab bar, straight after the description. The selected tab's
   * toolbar, then any notices, follow the header in that order.
   */
  tabs?: ReactNode;
  /**
   * `page` (default): the header opens a page under the window's title bar
   * and keeps the shared 48px top inset, which puts the title at the same
   * height as a settings page's title, so switching pages never moves it.
   * `none`: the host already insets the top (the settings column, a web
   * page frame), or the header follows other content.
   */
  inset?: 'page' | 'none';
  /** Focus target for a page that moves focus to its title on open. */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Overrides `page-header-title`, for hosts whose specs key on their own. */
  titleTestId?: string;
  /** Placement only. The header owns its own spacing. */
  className?: string;
}

/**
 * The one header at the top of every page, on desktop and on the web: an
 * optional back link on its own line, the title row with the page's actions
 * at its end, a one-line description, then the page's tabs. The title sits at
 * the same offset from the page's top edge on every page, so switching pages
 * never moves it.
 */
export function PageHeader({
  title,
  description,
  wideDescription = false,
  headingLevel = 'h1',
  back,
  badge,
  actions,
  reserveActions = false,
  tabs,
  inset = 'page',
  headingRef,
  titleTestId = 'page-header-title',
  className,
}: PageHeaderProps): JSX.Element {
  const HeadingTag = headingLevel;
  const showActions = actions !== undefined || reserveActions;
  return (
    <header
      className={`min-w-0${inset === 'page' ? ' pt-12' : ''}${
        className ? ` ${className}` : ''
      }`}
      data-testid="page-header"
      // Lets a host's window layout tune the page inset (desktop's inset
      // layout starts the card below an empty top row).
      data-inset={inset}
    >
      <Stack gap="group">
        <Stack gap="inline">
          {back ? (
            <Button
              variant="ghost"
              size="compact"
              onClick={back.onClick}
              data-testid={back.testId ?? 'page-header-back'}
              className="-ml-3 self-start"
            >
              <BackIcon size="sm" aria-hidden="true" />
              {back.label}
            </Button>
          ) : null}
          <Stack gap="tight">
            <div className="flex min-h-7 items-center gap-2">
              <HeadingTag
                ref={headingRef}
                tabIndex={headingRef ? -1 : undefined}
                className="min-w-0 text-xl font-medium text-balance break-words fg-primary outline-none"
                data-testid={titleTestId}
              >
                {title}
              </HeadingTag>
              {badge ? (
                <span
                  className="flex shrink-0 items-center gap-1.5 text-xs fg-tertiary"
                  data-testid="page-header-badge"
                >
                  {badge}
                </span>
              ) : null}
              {showActions ? (
                <div
                  className="ml-auto flex min-h-7 shrink-0 items-center gap-2"
                  data-testid="page-header-actions"
                >
                  {actions}
                </div>
              ) : null}
            </div>
            {description ? (
              // A div, not a p: some hosts pass a link or a short block. A
              // saved description of any length (a workflow's) stops at two
              // lines, so the page body below keeps its room.
              <div
                className={`line-clamp-2 ${wideDescription ? 'max-w-4xl' : 'max-w-160'} text-s text-pretty fg-tertiary`}
                data-testid="page-header-description"
              >
                {description}
              </div>
            ) : null}
          </Stack>
        </Stack>
        {tabs ? <div data-testid="page-header-tabs">{tabs}</div> : null}
      </Stack>
    </header>
  );
}
