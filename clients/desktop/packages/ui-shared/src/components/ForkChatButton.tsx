import type { AriaAttributes, JSX, MouseEventHandler } from 'react';
import { ForkSplitIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { CLEAN_ICON_BUTTON_VARIANT } from './chat-look';
import { Tooltip } from './Tooltip';

export interface ForkChatButtonProps extends Pick<
  AriaAttributes,
  'aria-controls' | 'aria-describedby' | 'aria-expanded'
> {
  readonly ariaLabel: string;
  /**
   * The web chat header's request for the 44px touch floor on a coarse
   * pointer. Both looks render the shared `Button`, whose coarse-pointer hit
   * area already reaches it, so nothing more is drawn.
   */
  readonly coarsePointerTarget?: boolean;
  readonly dataTestId?: string;
  readonly disabled?: boolean;
  readonly onClick: MouseEventHandler<HTMLButtonElement>;
  readonly title?: string;
}

export function ForkChatButton({
  ariaLabel,
  dataTestId,
  disabled = false,
  onClick,
  title,
  'aria-controls': ariaControls,
  'aria-describedby': ariaDescribedBy,
  'aria-expanded': ariaExpanded,
}: ForkChatButtonProps): JSX.Element {
  const ariaAttributes = {
    'aria-controls': ariaControls,
    'aria-describedby': ariaDescribedBy,
    'aria-expanded': ariaExpanded,
  };

  return (
    <Tooltip label={title ?? ariaLabel}>
      <Button
        variant={CLEAN_ICON_BUTTON_VARIANT}
        size="sm"
        iconOnly
        aria-label={ariaLabel}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={onClick}
        {...ariaAttributes}
      >
        {/* Split, turned a quarter right, reads as one line forking into
              two (ChatGPT's "Fork from here"). */}
        <span className="inline-flex rotate-90" aria-hidden="true">
          <ForkSplitIcon size="sm" />
        </span>
      </Button>
    </Tooltip>
  );
}
