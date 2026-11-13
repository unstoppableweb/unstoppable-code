import { forwardRef, type ButtonHTMLAttributes, type JSX } from 'react';
import { Button } from './Button';

export interface DrawerInspectorActionProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'style'
> {
  /**
   * Align the label with the inspector's text or its trailing time column,
   * or `inline` among a row's controls, with no offset.
   */
  alignment?: 'leading' | 'trailing' | 'inline';
}

/** The drawer's single footer action treatment, including watcher management. */
export const DrawerInspectorAction = forwardRef<
  HTMLButtonElement,
  DrawerInspectorActionProps
>(function DrawerInspectorAction(
  { alignment = 'trailing', ...props },
  ref,
): JSX.Element {
  return (
    <Button
      {...props}
      ref={ref}
      variant="ghost-overlay"
      // A chat action: the compact 13px label, on the rows' 13px detail line.
      // The offset cancels its 12px inset, so the label lines up.
      size="compact"
      className={
        alignment === 'trailing'
          ? '-mr-3'
          : alignment === 'leading'
            ? '-ml-3'
            : undefined
      }
    />
  );
});
