import type {
  ComponentType,
  HTMLAttributes,
  JSX,
  MouseEventHandler,
  ReactNode,
} from 'react';

/**
 * A catalog icon, or any glyph that takes a `className`. Catalog icons take
 * `exactSize` so a Lucide glyph follows the chip's 1em box instead of the
 * app's 14px icon tier.
 */
export type InlineMentionIcon = ComponentType<{
  className?: string;
  exactSize?: boolean;
}>;

export interface InlineMentionProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'className' | 'children' | 'onClick'
> {
  /** The glyph before the label; the pill sizes it to the surrounding text. */
  icon: InlineMentionIcon;
  children: ReactNode;
  /**
   * Makes the pill a button that opens what it mentions, with the accent
   * tint and focus treatment. Without it the pill is a plain, neutral span.
   */
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

// The chip geometry is written in em on purpose: a chip sits inside running
// text at whatever size that text has (a bubble, a heading, a table cell), so
// its label, icon, padding, and baseline nudge follow the font rather than the
// spacing scale. eslint.design.mjs allows these values in this file alone;
// every inline chip takes its classes from here.
//
// The label is 6/7 of the surrounding text (12px in 14px prose). Matching
// baselines leaves a smaller label visibly low, so the chip is raised to
// centre its label and icon on the surrounding cap height, and its padding
// leans to the top so the tinted box is centred too. Measured in Inter
// 14/22: icon and label within 0.1px of the surrounding cap middle.
//
// The chip never grows past its line: a long label (a path, an issue title)
// wraps inside the chip or truncates instead of running out of the column.
// The icon sits flush against the label, so the two never break apart.
const CHIP_SHAPE_CLASS =
  'inline-block max-w-full rounded-sm pt-[0.125em] pr-[0.5em] pb-[0.042em] pl-[0.417em] align-[0.0625em] text-[0.857em] leading-[1.5] no-underline';

/**
 * A chip that opens what it names: accent ink on the accent tint. Links,
 * pull requests, issues, and files in prose share it.
 */
export const INLINE_CHIP_CLASS = `${CHIP_SHAPE_CLASS} focus-ring cursor-pointer bg-accent-subtle fg-accent-strong transition-colors hover:bg-accent-subtle/80`;

/**
 * A mention token in the composer: the accent chip's look without its
 * pointer and hover, since the editor owns clicks and selection there.
 */
export const INLINE_TOKEN_CHIP_CLASS = `${CHIP_SHAPE_CLASS} bg-accent-subtle fg-accent-strong`;

/** A chip that names something without opening it: neutral fill. */
export const INLINE_STATIC_CHIP_CLASS = `${CHIP_SHAPE_CLASS} bg-muted fg-primary`;

/** The glyph before a chip's label: one label-height square on its centre. */
export const INLINE_CHIP_ICON_CLASS =
  'mr-[0.333em] inline-block h-[1em] w-[1em] shrink-0 align-[-0.133em]';

/**
 * The chip glyph for the GitHub mark, whose catalog artwork is inset 1.5 of
 * 27 units: scaling by 27/24 makes its ink fill the 1em box, the same as the
 * Linear and Slack marks.
 */
export const INLINE_CHIP_GITHUB_ICON_CLASS = `${INLINE_CHIP_ICON_CLASS} scale-[1.125]`;

/**
 * The inline chip for an `@` mention inside a message: a file path, a plugin,
 * or any other target with an icon and a label. The desktop's
 * `FilePathMention` and `PluginMention` render through it, and reference
 * chips share its classes, so the chips cannot drift apart.
 */
export function InlineMention({
  icon: Icon,
  children,
  onClick,
  ...rest
}: InlineMentionProps): JSX.Element {
  const content = (
    <>
      <Icon className={INLINE_CHIP_ICON_CLASS} exactSize />
      {children}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={INLINE_CHIP_CLASS}
        onClick={onClick}
        {...rest}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={INLINE_STATIC_CHIP_CLASS} {...rest}>
      {content}
    </span>
  );
}
