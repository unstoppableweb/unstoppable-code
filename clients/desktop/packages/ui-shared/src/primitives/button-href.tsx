import { forwardRef, type AnchorHTMLAttributes, type JSX } from 'react';
import { buttonClassName, type ButtonSize, type ButtonVariant } from './Button';
import { opensInNewTab } from '../lib/link-target';

type ButtonLinkShape =
  | {
      /** A circular icon-only link. */
      iconOnly: true;
      /** Accessible name required for icon-only controls. */
      'aria-label': string;
      leadingIcon?: undefined;
    }
  | {
      iconOnly?: false;
      'aria-label'?: string;
      /** The label starts with an icon; the start padding is smaller. */
      leadingIcon?: boolean;
    };

export type ButtonLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'aria-label'
> &
  ButtonLinkShape & {
    href: string;
    /** Every `Button` variant except `link`, which is `TextLink`. */
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Allow a title and supporting line to grow within the outline. */
    multiline?: boolean;
    /** Renders the link without its `href`, so it cannot be followed. */
    disabled?: boolean;
    /** Dim a disabled link when its capsule remains visible as a placeholder. */
    disabledAppearance?: 'dimmed';
    /** A little more separation for a large brand glyph. */
    iconGap?: 'roomy';
    /** Placement only (`self-start`, `max-w-full`); never colour or type. */
    className?: string;
  };

/**
 * The anchor `Button` renders for an `href`: navigation that looks like a
 * button. It stays an `<a>`, so middle-click, open in new tab and copy link
 * keep working. Render it through `<Button href>`.
 */
export const ButtonHrefAnchor = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  function ButtonHrefAnchor(
    {
      href,
      variant = 'secondary',
      size = 'md',
      multiline = false,
      iconOnly = false,
      leadingIcon = false,
      disabled = false,
      disabledAppearance,
      iconGap,
      className = '',
      onClick,
      ...props
    },
    ref,
  ): JSX.Element {
    const external = !disabled && opensInNewTab(href);
    return (
      <a
        ref={ref}
        // Without an href the anchor is no longer a link; keep its role.
        href={disabled ? undefined : href}
        role={disabled ? 'link' : undefined}
        aria-disabled={disabled || undefined}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        onClick={disabled ? undefined : onClick}
        {...props}
        className={buttonClassName({
          variant,
          size,
          multiline,
          iconOnly,
          leadingIcon,
          className: [
            iconGap === 'roomy' && 'gap-2',
            disabled &&
              disabledAppearance === 'dimmed' &&
              'pointer-events-none opacity-50',
            className,
          ]
            .filter(Boolean)
            .join(' '),
        })}
      />
    );
  },
);
