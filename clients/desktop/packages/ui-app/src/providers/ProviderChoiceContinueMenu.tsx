'use client';

import { useId, useRef, useState, type JSX } from 'react';
import {
  CHOOSE_PROVIDER_LABEL,
  CONTINUE_MENU_LABEL,
  MenuItem,
  MENU_GAP,
  Menu,
  NoticeButton,
  type NoticeButtonVariant,
} from '@canopy/ui-shared/components';
import { ChevronDown } from '@canopy/ui-shared/icons/AppIcons';

export interface ProviderChoiceContinueMenuProps {
  /** "Continue with {provider}", the menu's first row. */
  readonly continueLabel: string;
  readonly onContinue: () => void;
  /** Opens the provider list, the menu's second row. */
  readonly onChooseProvider: () => void;
  readonly variant: NoticeButtonVariant;
  readonly busy?: boolean;
  readonly testId?: string;
}

/**
 * The recovery notice's Continue button when one other source is usable now.
 * It opens a menu instead of acting at once: "Continue with {provider}"
 * moves the chat there, and Choose provider opens the list, where sources
 * that still need connecting, setting up or buying are listed too.
 */
export function ProviderChoiceContinueMenu({
  continueLabel,
  onContinue,
  onChooseProvider,
  variant,
  busy = false,
  testId,
}: ProviderChoiceContinueMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  // The span anchors placement but can't take focus, so Escape, Tab and a
  // row's pick return focus to the button itself.
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const select = (action: () => void) => (): void => {
    setOpen(false);
    // Focus goes back to the trigger first, so the list a row opens
    // returns focus there rather than to a row that is going away.
    buttonRef.current?.focus({ preventScroll: true });
    action();
  };
  return (
    <>
      <span ref={anchorRef} className="inline-flex max-w-full">
        <NoticeButton
          ref={buttonRef}
          variant={variant}
          busy={busy}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={(): void => setOpen((current) => !current)}
          {...(testId !== undefined ? { 'data-testid': testId } : {})}
        >
          {CONTINUE_MENU_LABEL}
          <ChevronDown size="sm" aria-hidden="true" />
        </NoticeButton>
      </span>
      <Menu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        returnFocusRef={buttonRef}
        // The notice sits above the composer, so the menu opens upward.
        placement="top-right"
        gap={MENU_GAP}
        interaction="menu"
        aria-label={CONTINUE_MENU_LABEL}
        {...(testId !== undefined ? { 'data-testid': `${testId}-menu` } : {})}
      >
        <MenuItem
          onClick={select(onContinue)}
          {...(testId !== undefined
            ? { 'data-testid': `${testId}-continue` }
            : {})}
        >
          {continueLabel}
        </MenuItem>
        <MenuItem
          onClick={select(onChooseProvider)}
          {...(testId !== undefined
            ? { 'data-testid': `${testId}-choose` }
            : {})}
        >
          {CHOOSE_PROVIDER_LABEL}
        </MenuItem>
      </Menu>
    </>
  );
}
