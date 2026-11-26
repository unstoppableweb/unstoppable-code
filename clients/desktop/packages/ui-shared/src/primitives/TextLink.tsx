import { forwardRef, type AnchorHTMLAttributes, type JSX } from 'react';
import { buttonClassName } from './Button';
import { MCP_ROW_ACTION_CLASS_NAME } from '../lib/mcp-card-display';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { opensInNewTab } from '../lib/link-target';
import { SECONDARY_SURFACE_CLASS } from '../lib/row-chips';
import {
  CUSTOMIZE_CRUMB_CLASS,
  INLINE_CHIP_CLASS,
  INTERACTIVE_CLASS,
  ROW_TRIGGER_CLASS,
  STORE_BADGE_CONTROL_CLASS,
} from './control-button-shared';
import {
  sidebarNavIconItemClassName,
  sidebarNavItemClassName,
} from './sidebar-item-classes';

/**
 * - `accent`: a link that stands on its own (a row's "View on GitHub").
 *   Accent ink, underlined on hover; the same look as `Button variant="link"`.
 * - `quiet`: a secondary link beside a primary fact (a check's "Details").
 * - `quiet-underlined`: a small, permanently underlined companion link.
 * - `inline`: a link inside a sentence. The underline stays faintly visible,
 *   so the link is not shown by colour alone (WCAG 1.4.1).
 */
export type TextLinkVariant =
  | 'accent'
  | 'quiet'
  | 'quiet-underlined'
  | 'inline'
  | 'pull-request-header'
  | 'muted'
  | 'informational'
  | 'inherited'
  | 'inherited-underlined'
  | 'inherited-hover'
  | 'mention'
  | 'breadcrumb'
  | 'capability'
  | 'mcp-title'
  | 'mcp-action'
  | 'merge-queue-github'
  | 'store-badge'
  | 'worktree-pr-badge'
  | 'worktree-pr-metadata'
  | 'sidebar-navigation';

/** The prose link look, shared with agent transcripts. */
export const TEXT_LINK_INLINE_CLASS =
  'fg-accent underline decoration-accent/30 decoration-1 underline-offset-4 transition-[text-decoration-color] hover:decoration-current focus-visible:decoration-current';

const VARIANT_CLASS_NAMES: Record<TextLinkVariant, string> = {
  accent: buttonClassName({ variant: 'link' }),
  quiet: 'focus-ring rounded fg-secondary transition-colors hover:fg-primary',
  'quiet-underlined':
    'focus-ring rounded text-xs fg-secondary underline underline-offset-4 transition-colors hover:fg-primary',
  inline: TEXT_LINK_INLINE_CLASS,
  'pull-request-header':
    // A pseudo-element brings the 28px link to 44px on touch without growing the header.
    'electron-no-drag focus-ring relative inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-normal fg-primary transition-colors hover:bg-subtle pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2',
  muted: 'focus-ring rounded fg-primary/80 transition-colors hover:fg-primary',
  informational: 'focus-ring rounded fg-info hover:underline',
  inherited: '',
  'inherited-underlined': 'underline transition-colors hover:fg-primary',
  'inherited-hover': 'underline-offset-2 hover:underline',
  mention: INLINE_CHIP_CLASS,
  breadcrumb: CUSTOMIZE_CRUMB_CLASS,
  capability: INTERACTIVE_CLASS,
  'mcp-title':
    'focus-ring rounded text-left hover:underline min-w-0 break-words fg-primary',
  'mcp-action': `${MCP_ROW_ACTION_CLASS_NAME} ${SECONDARY_SURFACE_CLASS} fg-primary`,
  'merge-queue-github':
    'focus-ring inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md text-2xs fg-primary transition-colors hover:bg-subtle',
  'store-badge': STORE_BADGE_CONTROL_CLASS,
  'worktree-pr-badge':
    'inline-flex items-center whitespace-nowrap text-2xs font-normal leading-4',
  'worktree-pr-metadata':
    'inline-flex h-4 items-center gap-1 whitespace-nowrap rounded px-0.5 align-bottom font-normal leading-4 transition-colors',
  'sidebar-navigation': '',
};

const LINK_SIZE_CLASSES = { xs: 'text-xs', s: 'text-s' } as const;

export type WorktreePrLinkTone =
  | ''
  | 'fg-destructive'
  | 'fg-warning'
  | 'fg-success'
  | 'fg-secondary';

export interface TextLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'size'
> {
  href: string;
  variant?: TextLinkVariant;
  size?: keyof typeof LINK_SIZE_CLASSES;
  emphasis?: 'medium';
  /** Align an icon beside the link label. */
  withIcon?: boolean;
  shrink?: boolean;
  row?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
  tone?: WorktreePrLinkTone;
  navigation?: {
    selected: boolean;
    touch: boolean;
    layout: 'row' | 'icon' | 'label';
  };
  replayBlock?: boolean;
  /** Placement only (`self-start`, `shrink-0`, margins); never colour or type. */
  className?: string;
}

export { opensInNewTab };

/** The link look for an element `TextLink` cannot render, such as `next/link`. */
export function textLinkClassName(
  variant: TextLinkVariant = 'accent',
  className = '',
): string {
  return `${VARIANT_CLASS_NAMES[variant]} ${className}`.trim();
}

/**
 * A text link. It takes the size of the copy around it. An absolute web URL
 * opens in a new tab unless the caller passes `target`.
 */
export const TextLink = forwardRef<HTMLAnchorElement, TextLinkProps>(
  function TextLink(
    {
      href,
      variant = 'accent',
      className = '',
      size,
      emphasis,
      withIcon,
      shrink,
      row,
      compact,
      iconOnly,
      tone,
      navigation,
      replayBlock,
      ...props
    },
    ref,
  ): JSX.Element {
    const external = opensInNewTab(href);
    let recipe = VARIANT_CLASS_NAMES[variant];
    if (variant === 'breadcrumb' && shrink) recipe += ' max-w-full';
    if (variant === 'capability' && row) recipe = ROW_TRIGGER_CLASS;
    if (variant === 'mcp-title' && !compact) recipe += ' text-s font-medium';
    if (variant === 'merge-queue-github')
      recipe += iconOnly ? ' w-6 justify-center' : ' px-2';
    if (variant === 'worktree-pr-metadata' && tone) recipe += ` ${tone}`;
    if (variant === 'sidebar-navigation' && navigation) {
      recipe =
        navigation.layout === 'row'
          ? sidebarNavItemClassName(navigation.selected, navigation.touch)
          : sidebarNavIconItemClassName(navigation.selected);
      if (navigation.layout === 'label')
        recipe += ' w-auto min-w-0 px-2 text-s';
    }
    const classes = [
      recipe,
      size && LINK_SIZE_CLASSES[size],
      emphasis && 'font-medium',
      withIcon && 'inline-flex items-center gap-1',
      replayBlock && REPLAY_BLOCK_CLASS,
      className,
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <a
        ref={ref}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        {...props}
        className={classes}
      />
    );
  },
);
