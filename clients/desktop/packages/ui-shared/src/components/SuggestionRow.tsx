import { ControlButton } from './Button';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';

export interface SuggestionRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className'
> {
  replayMask?: boolean;
  icon: ReactNode;
  /** Allow sentences to wrap on narrow Home layouts. */
  multiline?: boolean;
  /**
   * The row shares its slot with a control placed over its trailing edge
   * by {@link SuggestionRowTrailing}, such as a dismiss button. The label
   * stops short of that control, and hover chrome follows an ancestor
   * `group` so hovering the control keeps the row highlighted. Rows without
   * one reserve no room.
   * `'wide'` reserves room for a short text action beside an icon button.
   */
  trailingControl?: boolean | 'wide';
  /**
   * `muted` sets the label one text step down, for a row that points at work
   * already under way rather than offering a new action. Hover and focus
   * chrome stay the same.
   */
  tone?: 'default' | 'muted';
}

/**
 * Shared icon-and-text action row for suggested prompts and project setup.
 * Forwards its ref to the button so a host can return focus to the row.
 */
export const SuggestionRow = forwardRef<HTMLButtonElement, SuggestionRowProps>(
  function SuggestionRow(
    {
      icon,
      multiline = false,
      children,
      replayMask = false,
      type = 'button',
      trailingControl = false,
      tone = 'default',
      ...props
    },
    ref,
  ): JSX.Element {
    return (
      <ControlButton
        ref={ref}
        type={type}
        presentation="suggestion-row"
        appearance={{ tone, trailingControl, replayMask }}
        {...props}
      >
        {/* A 16px icon starts 16px in, on the section title's edge; the
            32px slot keeps the label 48px in. */}
        <span className="flex h-8 w-8 shrink-0 items-center justify-start pl-2 fg-tertiary">
          {icon}
        </span>
        <span className={multiline ? 'min-w-0' : 'min-w-0 truncate'}>
          {children}
        </span>
      </ControlButton>
    );
  },
);

/**
 * The control over a row's trailing edge, in the row's `relative group`
 * parent. A 28px control in the 48px pill clears its top and bottom by 10px,
 * so it ends 10px from the pill's end too; a section header's ••• bleeds
 * into the same column.
 */
export function SuggestionRowTrailing({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="absolute right-2.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 pointer-coarse:gap-4">
      {children}
    </div>
  );
}
