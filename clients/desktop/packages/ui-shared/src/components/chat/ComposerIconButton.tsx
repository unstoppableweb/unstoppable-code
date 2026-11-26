'use client';

import { ControlButton } from '../../primitives/Button';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import type { ComposerIconButtonTone } from '../../primitives/control-button-shared';
export type { ComposerIconButtonTone } from '../../primitives/control-button-shared';

/**
 * The pressed state of a tone: the wash stays on and the ink at full
 * strength. The + menu holding an attention item is an active `warning`; the
 * microphone listening is an active `destructive`.
 */

interface ComposerIconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className'
> {
  constrainLabel?: boolean;
  children: ReactNode;
  /** Uses the 32px circular geometry from the Home composer toolbar. */
  capsule?: boolean;
  /**
   * Gives room for a primary icon and a trailing disclosure icon, with 2px
   * between them.
   */
  wide?: boolean;
  /**
   * A labeled capsule: intrinsic width above the wide minimum, the 12px label
   * type, and 4px between icon, label, and disclosure.
   */
  autoWidth?: boolean;
  tone?: ComposerIconButtonTone;
  active?: boolean;
}

/** Canonical icon-only action used by composer-adjacent controls. */
export const ComposerIconButton = forwardRef<
  HTMLButtonElement,
  ComposerIconButtonProps
>(function ComposerIconButton(
  {
    children,
    capsule = false,
    wide = false,
    autoWidth = false,
    tone = 'default',
    active = false,
    type = 'button',
    constrainLabel = false,
    ...props
  },
  ref,
): JSX.Element {
  return (
    <ControlButton
      ref={ref}
      type={type}
      data-composer-icon-button="true"
      presentation="composer-icon"
      appearance={{ tone, active, capsule, wide, autoWidth, constrainLabel }}
      {...props}
    >
      {children}
    </ControlButton>
  );
});

ComposerIconButton.displayName = 'ComposerIconButton';
