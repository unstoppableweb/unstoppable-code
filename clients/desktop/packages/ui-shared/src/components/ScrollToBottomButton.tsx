import { memo, type JSX, type MouseEventHandler } from 'react';
import { ArrowUp } from '../icons/AppIcons';
import { Button } from '../primitives/Button';
import { Tooltip } from '../primitives/Tooltip';

export interface ScrollToBottomButtonProps {
  onClick: MouseEventHandler<HTMLButtonElement>;
  ariaLabel: string;
  dataTestId: string;
}

/** Hosts own scroll state and placement; the shared button owns its surface. */
export const ScrollToBottomButton = memo(function ScrollToBottomButton({
  onClick,
  ariaLabel,
  dataTestId,
}: ScrollToBottomButtonProps): JSX.Element {
  return (
    <Tooltip label={ariaLabel} className="pointer-events-auto">
      <Button
        iconOnly
        variant="secondary"
        size="md"
        onClick={onClick}
        aria-label={ariaLabel}
        data-testid={dataTestId}
      >
        <ArrowUp size={16} className="rotate-180" aria-hidden="true" />
      </Button>
    </Tooltip>
  );
});
