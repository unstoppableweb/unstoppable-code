import { forwardRef, type AnchorHTMLAttributes, type JSX } from 'react';
import { buttonClassName, type ButtonSize, type ButtonVariant } from './Button';
import { opensInNewTab } from './TextLink';

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
    /** Renders the link without its `href`, so it cannot be followed. */
    disabled?: boolean;
    /** Placement only (`self-start`, `max-w-full`); never colour or type. */
    className?: string;
  };

/**
 * Navigation that looks like a `Button`. It stays an `<a>`, so middle-click,
 * open in new tab and copy link keep working. Use `Button` for an action and
 * `TextLink` for a text link.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  function ButtonLink(
    {
      href,
      variant = 'secondary',
      size = 'md',
      iconOnly = false,
      leadingIcon = false,
      disabled = false,
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
          iconOnly,
          leadingIcon,
          className,
        })}
      />
    );
  },
);
