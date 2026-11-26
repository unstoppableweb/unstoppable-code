import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { Button } from '../primitives/Button';

export interface MobileTopBarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Accessible name. Required rather than optional: every call site is an
   * icon-only control, so without it the button has no name at all.
   */
  readonly 'aria-label': string;
  readonly children?: ReactNode;
}

/**
 * The icon button used by mobile top bars: the 36px `lg` ghost icon button.
 * On a touch screen its hit area grows 4px on each side, to 44 × 44, so a
 * thumb gets the full target without a 44px visible size.
 *
 * Deliberately NOT `HeaderActionButton`: that primitive is desktop header
 * geometry wrapped in a tooltip, a behavior a touch surface can't use (the
 * `/chat` shell's menu, new chat and right-panel buttons, and the App Advisor
 * overlay's close button).
 */
export const MobileTopBarButton = forwardRef<
  HTMLButtonElement,
  MobileTopBarButtonProps
>(function MobileTopBarButton(
  { className = '', children, ...rest },
  ref,
): JSX.Element {
  return (
    <Button
      {...rest}
      ref={ref}
      variant="ghost"
      size="lg"
      iconOnly
      className={className}
    >
      {children}
    </Button>
  );
});
