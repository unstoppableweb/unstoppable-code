import type { JSX, ReactNode } from 'react';
import { SPACE_ROLE_GAP_CLASS } from '../primitives/Stack';

/**
 * The page widths, as maximum widths of the column box (gutter included).
 * Only the widths design has decided are here (spacing call 3 decides them
 * page by page); add a width when a page's call lands, never in advance.
 *
 * - `content`: a 640px reading column (704px box with the 32px gutters).
 *   Decided on 2026-11-01; no page uses it since the Feed widened.
 * - `wide`: the Workflows page's width, desktop `PageContent`'s 1152px box
 *   (1088px of content between the 32px gutters), for a page with a table.
 *   Decided for the Feed on 2026-11-02.
 */
export const PAGE_COLUMN_WIDTH_CLASS = {
  content: 'max-w-176',
  wide: 'max-w-6xl',
} as const;

export type PageColumnWidth = keyof typeof PAGE_COLUMN_WIDTH_CLASS;

/** One gutter everywhere: 16px on a phone, 32px from `sm` (call 4). */
const PAGE_GUTTER_CLASS = 'px-4 sm:px-8';

export interface PageColumnProps {
  /** The column's maximum width. */
  readonly width: PageColumnWidth;
  /** `main` for a page's own landmark; `div` (the default) otherwise. */
  readonly as?: 'main' | 'div' | 'section' | 'article';
  /** Placement only (`relative`, `min-h-0 flex-1`); width, gutter and gap are fixed. */
  readonly className?: string;
  readonly 'data-testid'?: string;
  readonly children?: ReactNode;
}

/**
 * The shared page column on desktop and web: centered, one of the page
 * widths, the one side gutter, and the `page` gap (32px) between the page's
 * sections, which therefore never add margins of their own (calls 4, 5, 7).
 * The top inset belongs to the page header, not the column.
 */
export function PageColumn({
  width,
  as: Tag = 'div',
  className,
  'data-testid': testId,
  children,
}: PageColumnProps): JSX.Element {
  const base = `mx-auto flex w-full min-w-0 flex-col ${SPACE_ROLE_GAP_CLASS.page} ${PAGE_GUTTER_CLASS} ${PAGE_COLUMN_WIDTH_CLASS[width]}`;
  return (
    <Tag
      className={className ? `${base} ${className}` : base}
      data-testid={testId}
    >
      {children}
    </Tag>
  );
}
