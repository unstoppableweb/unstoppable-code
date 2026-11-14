import type { JSX, ReactNode } from 'react';
import { ChevronRightMediumIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { Tooltip } from './Tooltip';

export interface CustomizeBreadcrumbItem {
  /** Stable React key. */
  readonly key: string;
  readonly label: string;
  readonly testId?: string;
  /** Navigates in place (desktop). */
  readonly onSelect?: () => void;
  /** Navigates by URL (web); rendered through `renderLink`. */
  readonly href?: string;
  /** Full text for a label that may truncate. */
  readonly title?: string;
  /** User-authored text: masked in session replay. */
  readonly privateLabel?: boolean;
  /** Lets a long label shrink so the following crumbs stay visible. */
  readonly shrink?: boolean;
  readonly entryKind?: string;
}

export interface CustomizeBreadcrumbsProps {
  /** The trail; the last item is the current page. */
  readonly items: readonly CustomizeBreadcrumbItem[];
  readonly testId?: string;
  /** Renders an `href` crumb with the host's router link. */
  readonly renderLink?: (props: {
    href: string;
    className: string;
    testId?: string;
    entryKind?: string;
    children: ReactNode;
  }) => ReactNode;
}

const CRUMB_CLASS =
  'focus-ring inline-flex h-7 items-center whitespace-nowrap rounded-md px-1.5 text-s font-normal fg-secondary transition-colors hover:bg-subtle hover:fg-primary';

/**
 * The Customize location trail shared by desktop and web: chevron-separated
 * crumbs on one row, ending at the current page. The first crumb's padding
 * sits outside the content edge, so its text aligns with the column below.
 */
export function CustomizeBreadcrumbs({
  items,
  testId,
  renderLink,
}: CustomizeBreadcrumbsProps): JSX.Element {
  return (
    <nav
      aria-label="Breadcrumb"
      data-testid={testId}
      className="flex h-7 min-w-0 items-center text-s font-normal"
    >
      <ol className="flex h-full min-w-0 items-center gap-1">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          const label = item.privateLabel ? (
            <span className={`min-w-0 truncate ${REPLAY_MASK_CLASS}`}>
              {item.label}
            </span>
          ) : item.shrink ? (
            <span className="min-w-0 truncate">{item.label}</span>
          ) : (
            item.label
          );
          const width = item.shrink || current ? 'min-w-0' : 'shrink-0';
          const navigable = `${CRUMB_CLASS} ${item.shrink ? 'max-w-full' : ''}`;
          let crumb: ReactNode;
          if (current) {
            crumb = (
              <span
                aria-current="page"
                data-testid={item.testId}
                data-entry-kind={item.entryKind}
                className="flex h-7 min-w-0 items-center truncate whitespace-nowrap px-1.5 fg-primary"
              >
                {label}
              </span>
            );
          } else if (item.href && renderLink) {
            crumb = renderLink({
              href: item.href,
              className: navigable,
              testId: item.testId,
              entryKind: item.entryKind,
              children: label,
            });
          } else if (item.onSelect) {
            crumb = (
              <button
                type="button"
                onClick={item.onSelect}
                data-testid={item.testId}
                data-entry-kind={item.entryKind}
                className={navigable}
              >
                {label}
              </button>
            );
          } else {
            crumb = (
              <span
                data-testid={item.testId}
                data-entry-kind={item.entryKind}
                className="flex h-7 items-center whitespace-nowrap px-1.5 fg-secondary"
              >
                {label}
              </span>
            );
          }
          return [
            index > 0 ? (
              <li
                key={`${item.key}:separator`}
                aria-hidden="true"
                className="flex h-full shrink-0 items-center fg-tertiary"
              >
                <ChevronRightMediumIcon size={16} />
              </li>
            ) : null,
            <li key={item.key} className={`flex h-full items-center ${width}`}>
              <Tooltip
                label={item.title}
                disabled={!item.title}
                allowShrink={item.shrink || current}
                className="max-w-full"
                replayBlock={item.privateLabel}
              >
                {crumb}
              </Tooltip>
            </li>,
          ];
        })}
      </ol>
    </nav>
  );
}
