'use client';

import type { JSX, ReactNode, RefObject } from 'react';
import {
  FloatingMenu,
  type FloatingMenuProps,
} from '../primitives/FloatingMenu';

export interface ComposerSuggestionMenuProps {
  readonly open: boolean;
  readonly onDismiss: () => void;
  /**
   * A non-interactive element spanning the composer box; the menu sits above
   * it at its width. It must not contain the editor (FloatingMenu opens on
   * ArrowDown/ArrowUp pressed inside its anchor).
   */
  readonly anchorRef: RefObject<HTMLElement | null>;
  /** The editor surface: presses there do not dismiss the menu. */
  readonly boundaryRef?: RefObject<HTMLElement | null>;
  /**
   * The composer box. Presses on its other controls (Run, attach, pickers)
   * dismiss the menu and still activate the control.
   */
  readonly composerRef?: RefObject<HTMLElement | null>;
  /** Where focus returns on Escape; defaults to the anchor. */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  /** Flip below the composer when there is no room above it (default true). */
  readonly allowFlip?: boolean;
  readonly role?: FloatingMenuProps['role'];
  readonly 'aria-label': string;
  readonly 'data-testid'?: string;
  /** Default 280px. */
  readonly heightLimit?: number;
  readonly children: ReactNode;
}

/**
 * A list that suggests as the user types in the composer (`!`, and next `/`
 * and `@`). It floats above the composer box at its width, with the composer's
 * 20px corners, and never takes focus: the editor keeps it, and the host's
 * typeahead owns the keyboard. Escape stays away from the chat's cancel
 * shortcut, so closing the list does not stop a running turn.
 */
export function ComposerSuggestionMenu({
  open,
  onDismiss,
  anchorRef,
  boundaryRef,
  composerRef,
  returnFocusRef,
  allowFlip = true,
  role = 'dialog',
  'aria-label': ariaLabel,
  'data-testid': dataTestId,
  heightLimit = 280,
  children,
}: ComposerSuggestionMenuProps): JSX.Element {
  return (
    <FloatingMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
      anchorRef={anchorRef}
      {...(boundaryRef ? { outsidePressBoundaryRef: boundaryRef } : {})}
      {...(composerRef ? { outsidePressClickThroughRef: composerRef } : {})}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      placement="top-left"
      interaction="manual"
      allowFlip={allowFlip}
      role={role}
      aria-label={ariaLabel}
      {...(dataTestId ? { 'data-testid': dataTestId } : {})}
      data-chat-cancel-shortcut-ignore
      motion="none"
      className="flex w-[var(--floating-menu-anchor-width)] flex-col overflow-hidden"
      // Composer-attached, like the + menu: the composer's 20px corners.
      style={{ borderRadius: 'var(--radius-2xl)', paddingBlock: 0 }}
      heightLimit={heightLimit}
    >
      {children}
    </FloatingMenu>
  );
}
