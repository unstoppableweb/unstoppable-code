import type { HTMLAttributes, JSX, Ref } from 'react';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The look of a heading, one per role:
 *
 * - `page`: a page's title at 20/28, for a full-window screen that has no
 *   `PageHeader` (a sign-in gate, a startup screen). Every other page title
 *   is a `PageHeader`.
 * - `section`: a section of a page at 16/24, the heading
 *   `SettingsRowsSection` draws over its box.
 * - `title`: a card's, panel's or subsection's title at 14/20.
 * - `label`: a small group heading inside a panel, card or list at 13/18 in
 *   the secondary ink.
 *
 * - `display`: a hero title at 24/32, 30/36 from the `sm` breakpoint, for the
 *   one greeting on a landing screen.
 * - `sidebar`: a sidebar section's name at 14/20 in the quaternary ink.
 *
 * `page` to `label` use the 450 weight; size and ink carry the hierarchy.
 */
export type HeadingVariant =
  | 'page'
  | 'section'
  | 'title'
  | 'label'
  | 'display'
  | 'sidebar';

/** The ink of a heading that announces a result or a risk, or a quiet one. */
export type HeadingTone = 'destructive' | 'warning' | 'success' | 'muted';

const VARIANT_CLASS: Readonly<Record<HeadingVariant, string>> = {
  page: 'text-xl font-medium',
  section: 'text-m font-medium',
  title: 'text-s font-medium',
  label: 'text-xs font-medium',
  display: 'text-2xl font-semibold sm:text-3xl',
  sidebar: 'text-s font-normal',
};

const VARIANT_INK_CLASS: Readonly<Record<HeadingVariant, string>> = {
  page: 'fg-primary',
  section: 'fg-primary',
  title: 'fg-primary',
  label: 'fg-secondary',
  display: 'fg-primary',
  sidebar: 'fg-quaternary',
};

const TONE_CLASS: Readonly<Record<HeadingTone, string>> = {
  destructive: 'fg-destructive',
  warning: 'fg-warning',
  success: 'fg-success-strong',
  muted: 'fg-tertiary',
};

/**
 * Page titles balance, like `PageHeader`'s; every other heading wraps like
 * prose, so a long one never splits into two even halves (design call,
 * 2026-10-30: section headings wrap pretty).
 */
const WRAP_CLASS: Readonly<Record<HeadingVariant, string>> = {
  page: 'text-balance break-words',
  section: 'text-pretty',
  title: 'text-pretty',
  label: 'text-pretty',
  display: 'text-balance',
  sidebar: '',
};

export interface HeadingProps extends Omit<
  HTMLAttributes<HTMLHeadingElement>,
  'className' | 'style'
> {
  /**
   * The level in the page's outline: `1` for the page's own title, then one
   * deeper per nested section. It never changes the look.
   */
  readonly level: HeadingLevel;
  readonly variant: HeadingVariant;
  /** Status ink in place of the variant's; see {@link HeadingTone}. */
  readonly tone?: HeadingTone;
  /** Keep the heading on one line and end it with an ellipsis. */
  readonly truncate?: boolean;
  readonly ref?: Ref<HTMLHeadingElement>;
  /** Placement only (`min-w-0`, `flex-1`, `shrink-0`). The heading owns its type. */
  readonly className?: string;
}

/**
 * The one heading element outside `PageHeader` and `SettingsRowsSection`, on
 * desktop and on the web. Feature code never sets a heading's size, weight or
 * ink itself (docs/design/typography.md).
 */
export function Heading({
  level,
  variant,
  tone,
  truncate = false,
  ref,
  className,
  children,
  ...props
}: HeadingProps): JSX.Element {
  const Element = `h${level}` as const;
  const classes = [
    VARIANT_CLASS[variant],
    tone ? TONE_CLASS[tone] : VARIANT_INK_CLASS[variant],
    truncate ? 'truncate' : WRAP_CLASS[variant],
    // A heading that takes focus (a step's title on open) shows no ring,
    // like `PageHeader`'s: focus only moves the reading position.
    props.tabIndex === undefined ? undefined : 'outline-none',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Element {...props} ref={ref} className={classes}>
      {children}
    </Element>
  );
}
