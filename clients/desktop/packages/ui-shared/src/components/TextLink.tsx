import { forwardRef, type AnchorHTMLAttributes, type JSX } from 'react';
import { buttonClassName } from './Button';

/**
 * - `accent`: a link that stands on its own (a row's "View on GitHub").
 *   Accent ink, underlined on hover; the same look as `Button variant="link"`.
 * - `quiet`: a secondary link beside a primary fact (a check's "Details").
 * - `inline`: a link inside a sentence. The underline stays faintly visible,
 *   so the link is not shown by colour alone (WCAG 1.4.1).
 */
export type TextLinkVariant = 'accent' | 'quiet' | 'inline';

/** The prose link look, shared with agent transcripts. */
export const TEXT_LINK_INLINE_CLASS =
  'fg-accent underline decoration-accent/30 decoration-1 underline-offset-4 transition-[text-decoration-color] hover:decoration-current focus-visible:decoration-current';

const VARIANT_CLASS_NAMES: Record<TextLinkVariant, string> = {
  accent: buttonClassName({ variant: 'link' }),
  quiet: 'focus-ring rounded fg-secondary transition-colors hover:fg-primary',
  inline: TEXT_LINK_INLINE_CLASS,
};

export interface TextLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: TextLinkVariant;
  /** Placement only (`self-start`, `shrink-0`, margins); never colour or type. */
  className?: string;
}

/**
 * True for an absolute web URL, which opens in a new tab; in-app links are
 * relative. It reads only `href`, so server and browser render the same. The
 * desktop main process routes every navigation itself.
 */
export function opensInNewTab(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

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
    { href, variant = 'accent', className = '', ...props },
    ref,
  ): JSX.Element {
    const external = opensInNewTab(href);
    return (
      <a
        ref={ref}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        {...props}
        className={textLinkClassName(variant, className)}
      />
    );
  },
);
