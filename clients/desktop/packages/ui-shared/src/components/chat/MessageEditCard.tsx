'use client';

import {
  useLayoutEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Button } from '../Button';
import { ChatComposerShell } from '../ChatComposerShell';
import { Stack } from '../Stack';

// The desktop composer's editable text (ui-rich composer density), on a
// plain textarea: no native ring or resize grip, growing with its content.
const MESSAGE_EDIT_TEXT_CLASS =
  'block min-h-8 max-h-50 w-full resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-s pointer-coarse:text-m leading-5 fg-primary outline-none';

export interface MessageEditCardProps {
  readonly value: string;
  readonly onChange?: (text: string) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
  readonly ariaLabel: string;
  readonly inputTestId: string;
  readonly readOnly?: boolean;
  /** Optional label above the text, such as "Unsaved edit". */
  readonly label?: ReactNode;
  /** Status or notes between the text and the actions. */
  readonly children?: ReactNode;
  /**
   * Own the gap before and between margin-free children with the text's
   * tight gap. Omitted, children follow the text with their own spacing.
   */
  readonly childrenGap?: 'tight';
  /** Trailing buttons, in the composer's send position. */
  readonly actions: ReactNode;
  readonly dataTestId?: string;
}

/**
 * Inline editor for a queued or pending message: the composer box with its
 * text and trailing Cancel/Save capsules, as desktop's editing composer draws
 * it. Hosts own the draft, keyboard handling and edit locks.
 */
export function MessageEditCard({
  value,
  onChange,
  onKeyDown,
  inputRef,
  ariaLabel,
  inputTestId,
  readOnly = false,
  label,
  children,
  childrenGap,
  actions,
  dataTestId,
}: MessageEditCardProps): JSX.Element {
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return (
    <div data-testid={dataTestId}>
      <ChatComposerShell dataTestId="message-edit-card">
        <div className="px-4 pt-3.5 pb-1.5">
          <Stack gap="tight">
            {label ? (
              <div className="text-3xs fg-secondary">{label}</div>
            ) : null}
            <textarea
              ref={(element): void => {
                textarea.current = element;
                if (typeof inputRef === 'function') inputRef(element);
                else if (inputRef) inputRef.current = element;
              }}
              rows={1}
              readOnly={readOnly}
              aria-label={ariaLabel}
              data-testid={inputTestId}
              className={MESSAGE_EDIT_TEXT_CLASS}
              value={value}
              onChange={(event): void => onChange?.(event.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            {childrenGap === 'tight' ? children : null}
          </Stack>
          {childrenGap === 'tight' ? null : children}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-2.5 pb-2.5">
          {actions}
        </div>
      </ChatComposerShell>
    </div>
  );
}

export interface MessageEditCancelSaveProps {
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly saveDisabled?: boolean;
}

/** The editing composer's Cancel and Save capsules. */
export function MessageEditCancelSave({
  onCancel,
  onSave,
  saveDisabled = false,
}: MessageEditCancelSaveProps): JSX.Element {
  return (
    <>
      <Button
        size="md"
        variant="secondary"
        onClick={onCancel}
        data-testid="queued-message-edit-cancel"
      >
        Cancel
      </Button>
      <Button
        size="md"
        variant="primary"
        onClick={onSave}
        disabled={saveDisabled}
        data-testid="queued-message-edit-save"
      >
        Save
      </Button>
    </>
  );
}
