import type { JSX, MouseEvent } from 'react';
import { InfoIcon } from '../icons/InfoIcon';
import { Button } from './Button';
import { Tooltip } from './Tooltip';

export interface SourceInfoButtonProps {
  onClick: () => void;
  /** Accessible label — caller supplies the entry label. */
  ariaLabel: string;
  /** Native tooltip. Defaults to "Source info". */
  title?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

/**
 * Info-icon button inside an entry row (Scripts, Hooks, …), revealed on
 * hover/focus and always visible on coarse pointers. Pure display: parent
 * owns the modal/popover dispatch.
 */
export function SourceInfoButton({
  onClick,
  ariaLabel,
  title = 'Source info',
  dataTestId,
}: SourceInfoButtonProps): JSX.Element {
  return (
    // The wrapper owns the reveal; the 28px button overhangs the row's text
    // line (`-my-1.5`) rather than growing it.
    <span className="-my-1.5 inline-flex shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
      <Tooltip label={title}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          data-testid={dataTestId}
          onClick={(event: MouseEvent<HTMLButtonElement>): void => {
            event.stopPropagation();
            onClick();
          }}
          aria-label={ariaLabel}
        >
          <InfoIcon />
        </Button>
      </Tooltip>
    </span>
  );
}
