'use client';

import { ControlButton } from '../../primitives/Button';
import { forwardRef, type ButtonHTMLAttributes, type JSX } from 'react';
import { ChevronDownIcon } from '../../icons/AppIcons';

export type LedgerInPlaceTriggerProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'className'
> & { extent?: 'content' | 'container' | 'flush-owner' };

/** An entry's owner, changed in place on the first line of its row. */
export const LedgerInPlaceTrigger = forwardRef<
  HTMLButtonElement,
  LedgerInPlaceTriggerProps
>(function LedgerInPlaceTrigger(
  { children, extent = 'content', ...props },
  ref,
): JSX.Element {
  return (
    <ControlButton
      {...props}
      ref={ref}
      type="button"
      presentation="ledger-in-place"
      appearance={{ extent }}
    >
      {children}
      <ChevronDownIcon
        size={12}
        aria-hidden="true"
        className="shrink-0 fg-tertiary"
      />
    </ControlButton>
  );
});

LedgerInPlaceTrigger.displayName = 'LedgerInPlaceTrigger';
