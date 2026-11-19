import type { JSX, MouseEvent } from 'react';
import { ShareIcon } from '../icons/AppIcons';
import type { MarketplaceShareAction } from '../lib/marketplace-share';
import { Button, type ButtonVariant } from './Button';
import { Tooltip } from './Tooltip';

/**
 * The one Share action: the share glyph, labelled `Share`, wherever a
 * shareable resource is listed or opened. A list row and a detail header
 * render the same control, so sharing looks and reads the same for skills,
 * pipelines, automations, agents, collections, plugins and project templates.
 *
 * The icon placements show `Share` as their tooltip. Their accessible name
 * names the resource, so a screen reader can tell a list's Share buttons
 * apart. The `detail` placement shows a visible `Share` label instead, with
 * the shared secondary recipe. Every Marketplace detail puts it in the same
 * place: the top right of its Back row, or of a dialog's title bar.
 *
 * A disabled Share stays focusable, using `aria-disabled` instead of the
 * native attribute. Keyboard users can still reach the tooltip and its
 * `aria-description`, which explain why sharing is unavailable. Activation
 * never calls `onClick`.
 */
export interface ShareActionButtonProps {
  /** Accessible name, e.g. `Share Release notes`. */
  ariaLabel: string;
  onClick: () => void;
  /**
   * `row` is the quiet circle at the end of a list row; `header` is the
   * secondary circle that sits with a detail header's other actions;
   * `detail` is the labeled secondary button at the top right of a
   * Marketplace detail's Back row or dialog title bar.
   */
  placement: 'row' | 'header' | 'detail';
  /**
   * The `header` and `detail` buttons' size: `compact`, the 28px capsule a
   * page header's actions use. The deprecated `control` rectangle is gone.
   */
  size?: 'compact';
  disabled?: boolean;
  disabledReason?: string;
  dataTestId?: string;
}

/** The label every Share action shows. */
export const SHARE_ACTION_LABEL = 'Share';

const PLACEMENT_VARIANT: Record<
  ShareActionButtonProps['placement'],
  ButtonVariant
> = {
  // The row placement sits on a list row's hover surface.
  row: 'ghost',
  header: 'secondary',
  detail: 'secondary',
};

export function ShareActionButton({
  ariaLabel,
  onClick,
  placement,
  size = 'compact',
  disabled = false,
  disabledReason,
  dataTestId,
}: ShareActionButtonProps): JSX.Element {
  const labeled = placement === 'detail';
  const icon = <ShareIcon size="sm" aria-hidden />;
  const shared = {
    variant: PLACEMENT_VARIANT[placement],
    'data-testid': dataTestId,
    'aria-label': ariaLabel,
    'aria-disabled': disabled ? true : undefined,
    'aria-description': disabled ? disabledReason : undefined,
    onClick: (event: MouseEvent<HTMLButtonElement>): void => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onClick();
    },
  };
  const button = labeled ? (
    <Button {...shared} size={size}>
      {icon}
      {SHARE_ACTION_LABEL}
    </Button>
  ) : (
    // The square placements keep the 28px frame of the header's other
    // actions: the deprecated rectangle by default, the capsule on request.
    <Button {...shared} size={size} iconOnly>
      {icon}
    </Button>
  );
  if (disabled && disabledReason) {
    return <Tooltip label={disabledReason}>{button}</Tooltip>;
  }
  // A labeled button already reads `Share`; a redundant tooltip adds noise.
  if (labeled) return button;
  return <Tooltip label={SHARE_ACTION_LABEL}>{button}</Tooltip>;
}

export interface MarketplaceShareButtonProps {
  /** Omitted when the host has no sharing capability: nothing renders. */
  action: MarketplaceShareAction | undefined;
  /** The resource name, used in the accessible name. */
  name: string;
  placement: ShareActionButtonProps['placement'];
  dataTestId?: string;
}

/**
 * Renders a Marketplace entry's share action from its one discriminated
 * state: an enabled callback or a blocked reason. Hosts never pass separate
 * callback, reason and visibility props that could disagree.
 */
export function MarketplaceShareButton({
  action,
  name,
  placement,
  dataTestId,
}: MarketplaceShareButtonProps): JSX.Element | null {
  if (!action) return null;
  return (
    <ShareActionButton
      placement={placement}
      dataTestId={dataTestId}
      ariaLabel={`Share ${name}`}
      onClick={action.status === 'shareable' ? action.onShare : noop}
      disabled={action.status === 'blocked'}
      disabledReason={action.status === 'blocked' ? action.reason : undefined}
    />
  );
}

function noop(): void {}
