import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import { RevertIcon } from '../icons/RevertIcon';
import { Button } from '../primitives/Button';

export interface FileRevertButtonProps {
  onClick: () => void;
  disabled?: boolean;
  /** Accessible label — caller supplies the file path. */
  ariaLabel: string;
  /** Test ID hook for automation. Defaults to `activity-file-revert`. */
  dataTestId?: string;
}

/**
 * Hover-revealed revert button rendered alongside an entry in Changed Files.
 * Pure display: the parent owns the actual revert dispatch. The wrapper owns
 * the reveal (it takes the place of the row's change counts on hover), and the
 * 28px quiet icon button overhangs the row's text line rather than growing it.
 */
export function FileRevertButton({
  onClick,
  disabled = false,
  ariaLabel,
  dataTestId = 'activity-file-revert',
}: FileRevertButtonProps): JSX.Element {
  return (
    <span className="-my-1.5 hidden shrink-0 group-hover:inline-flex group-focus-within:inline-flex pointer-coarse:inline-flex">
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={ariaLabel}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={(event: MouseEvent<HTMLButtonElement>): void => {
          event.stopPropagation();
          if (disabled) {
            return;
          }
          onClick();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>): void => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
          }
        }}
      >
        <RevertIcon />
      </Button>
    </span>
  );
}
