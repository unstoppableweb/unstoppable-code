import type { HTMLAttributes, JSX, ReactNode } from 'react';

/**
 * The spacing between siblings, named by the relationship it expresses
 * rather than by its size. `docs/design/layout.md` gives every group one
 * spacing owner, the parent's gap; `Stack` and `Inline` are that owner.
 *
 * - `tight` (4px): a label over its description, an icon beside its text.
 * - `inline` (8px): controls in one row, a toolbar, a chip list.
 * - `item` (12px): items in one group, a heading over its box.
 * - `group` (16px): groups in a dialog or card body, fields in a form.
 * - `block` (20px): inside a side panel or card body, between its blocks.
 * - `section` (24px): sections of a page.
 * - `page` (32px): major regions of a page, a page's top and bottom room.
 * - `hero` (40px): empty states, first-run and onboarding.
 *
 * Other sizes (2, 6, 10, 14, 28, 48px and up) are not layout values: they
 * move to the nearest role, or live only inside a control primitive.
 */
export type SpaceRole =
  | 'tight'
  | 'inline'
  | 'item'
  | 'group'
  | 'block'
  | 'section'
  | 'page'
  | 'hero';

/**
 * The `gap` utility each role renders. The one place to rename a role or
 * retune the scale.
 */
export const SPACE_ROLE_GAP_CLASS: Readonly<Record<SpaceRole, string>> = {
  tight: 'gap-1',
  inline: 'gap-2',
  item: 'gap-3',
  group: 'gap-4',
  block: 'gap-5',
  section: 'gap-6',
  page: 'gap-8',
  hero: 'gap-10',
};

/** Elements a layout primitive may render as. */
export type LayoutElement =
  | 'div'
  | 'section'
  | 'article'
  | 'aside'
  | 'header'
  | 'footer'
  | 'main'
  | 'nav'
  | 'form'
  | 'fieldset'
  | 'ul'
  | 'ol'
  | 'li'
  | 'dl'
  | 'span';

type LayoutAttributes = Omit<
  HTMLAttributes<HTMLElement>,
  'className' | 'style' | 'children'
>;

interface LayoutBaseProps extends LayoutAttributes {
  /** The element to render; `div` by default. */
  readonly as?: LayoutElement;
  /** Placement only (width, flex participation, position); never spacing. */
  readonly className?: string;
  readonly children?: ReactNode;
}

export type StackAlign = 'stretch' | 'start' | 'center' | 'end';

const STACK_ALIGN_CLASS: Readonly<Record<StackAlign, string>> = {
  stretch: '',
  start: ' items-start',
  center: ' items-center',
  end: ' items-end',
};

export interface StackProps extends LayoutBaseProps {
  /** The space between children, by role. */
  readonly gap: SpaceRole;
  /** Cross-axis alignment; children stretch to the full width by default. */
  readonly align?: StackAlign;
}

function withPlacement(base: string, className: string | undefined): string {
  return className ? `${base} ${className}` : base;
}

/**
 * A vertical group whose spacing is its own gap. Children never add margins
 * to space themselves.
 */
export function Stack({
  as: Tag = 'div',
  gap,
  align = 'stretch',
  className,
  children,
  ...rest
}: StackProps): JSX.Element {
  return (
    <Tag
      {...rest}
      className={withPlacement(
        `flex flex-col ${SPACE_ROLE_GAP_CLASS[gap]}${STACK_ALIGN_CLASS[align]}`,
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export type InlineAlign = 'center' | 'start' | 'end' | 'baseline' | 'stretch';
export type InlineJustify = 'start' | 'center' | 'end' | 'between';

const INLINE_ALIGN_CLASS: Readonly<Record<InlineAlign, string>> = {
  center: ' items-center',
  start: ' items-start',
  end: ' items-end',
  baseline: ' items-baseline',
  stretch: '',
};

const INLINE_JUSTIFY_CLASS: Readonly<Record<InlineJustify, string>> = {
  start: '',
  center: ' justify-center',
  end: ' justify-end',
  between: ' justify-between',
};

export interface InlineProps extends LayoutBaseProps {
  /** The space between children, by role; `inline` (8px) by default. */
  readonly gap?: SpaceRole;
  /** Cross-axis alignment; centered by default. */
  readonly align?: InlineAlign;
  /** Main-axis distribution; packed at the start by default. */
  readonly justify?: InlineJustify;
  /** Wrap onto more lines when the row runs out of width. */
  readonly wrap?: boolean;
}

/**
 * A horizontal group whose spacing is its own gap. When it wraps, the same
 * gap separates the lines.
 */
export function Inline({
  as: Tag = 'div',
  gap = 'inline',
  align = 'center',
  justify = 'start',
  wrap = false,
  className,
  children,
  ...rest
}: InlineProps): JSX.Element {
  return (
    <Tag
      {...rest}
      className={withPlacement(
        `flex ${SPACE_ROLE_GAP_CLASS[gap]}${INLINE_ALIGN_CLASS[align]}${INLINE_JUSTIFY_CLASS[justify]}${wrap ? ' flex-wrap' : ''}`,
        className,
      )}
    >
      {children}
    </Tag>
  );
}
