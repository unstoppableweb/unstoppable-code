import type { JSX, ReactNode } from 'react';
import {
  ChevronDownMediumIcon,
  ChevronRightMediumIcon,
} from '../icons/AppIcons';
import { ControlButton } from './Button';
import { Heading } from './Heading';

export interface CustomizeSectionProps {
  /** Stable DOM id; also the target of `#customize-section-<id>` anchors. */
  readonly domId: string;
  readonly title: string;
  /** Matching entries before any preview, shown beside the title. */
  readonly count?: number;
  /** Trailing heading controls (Update all, pipeline filters). */
  readonly actions?: ReactNode;
  /** A short line under the heading, above its hairline. */
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly footnote?: ReactNode;
  /**
   * Lets the person fold the section: a small chevron leads the title and
   * the rows and footnote hide while `collapsed`. The host owns the state.
   */
  readonly collapsible?: {
    readonly collapsed: boolean;
    readonly onToggle: () => void;
  };
}

/** One headed band of the Customize page: heading, hairline, then content. */
export function CustomizeSection({
  domId,
  title,
  count,
  actions,
  description,
  children,
  footnote,
  collapsible,
}: CustomizeSectionProps): JSX.Element {
  const headingId = `${domId}-heading`;
  const collapsed = collapsible?.collapsed === true;
  const heading = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{title}</span>
      {count !== undefined && (
        <span
          data-testid={`${domId}-count`}
          className="shrink-0 text-s font-normal fg-tertiary"
        >
          {count}
        </span>
      )}
    </span>
  );
  return (
    <section
      id={domId}
      data-testid={domId}
      aria-labelledby={headingId}
      className="scroll-mt-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-2">
        <div className="flex h-7 min-w-0 items-center">
          <Heading
            level={2}
            variant="section"
            id={headingId}
            className="min-w-0"
          >
            {collapsible ? (
              // The chevron, title and count are one button, so the whole
              // heading folds the section.
              <ControlButton
                type="button"
                presentation="section-heading-toggle"
                aria-expanded={!collapsed}
                aria-controls={`${domId}-body`}
                data-testid={`${domId}-toggle`}
                onClick={collapsible.onToggle}
              >
                {collapsed ? (
                  <ChevronRightMediumIcon
                    size={12}
                    aria-hidden
                    className="shrink-0 fg-secondary"
                  />
                ) : (
                  <ChevronDownMediumIcon
                    size={12}
                    aria-hidden
                    className="shrink-0 fg-secondary"
                  />
                )}
                {heading}
              </ControlButton>
            ) : (
              heading
            )}
          </Heading>
        </div>
        {actions}
        {description && (
          <p
            data-testid={`${domId}-description`}
            className="basis-full text-xs fg-tertiary"
          >
            {description}
          </p>
        )}
      </div>
      <div id={`${domId}-body`} hidden={collapsed}>
        {collapsed ? null : children}
      </div>
      {footnote && !collapsed && (
        <div className="pt-3">
          <p data-testid={`${domId}-footnote`} className="text-xs fg-tertiary">
            {footnote}
          </p>
        </div>
      )}
    </section>
  );
}
