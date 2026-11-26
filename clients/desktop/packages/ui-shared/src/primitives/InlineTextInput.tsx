'use client';

import {
  forwardRef,
  useRef,
  useState,
  type ForwardedRef,
  type InputHTMLAttributes,
  type JSX,
  type KeyboardEvent,
} from 'react';

/**
 * Edit in place: a title, a tab, or a row renamed where it sits (design
 * decision, 2026-10-30). Plain text with no box at rest and no fill on hover
 * or while editing, only the shared neutral field focus edge. 28px tall
 * with the 10px corners of the 28px fields.
 *
 * Enter commits and leaves the field; Escape restores the saved value, calls
 * `onCancel`, and leaves; leaving the field any other way commits. Keys
 * that belong to an input-method composition do neither. An
 * unchanged value never commits. The caller owns validation: reject a value
 * in `onCommit` by not saving it, and the field shows the saved value again.
 *
 * There is no visible label, so `aria-label` or `aria-labelledby` is required.
 */
type InlineTextInputBaseProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | 'value'
  | 'defaultValue'
  | 'onChange'
  | 'type'
  | 'size'
  | 'aria-label'
  | 'aria-labelledby'
> & {
  /** The saved value. */
  readonly value: string;
  readonly onCommit: (next: string) => void;
  readonly onCancel?: () => void;
  /**
   * Each edit to the draft, before it commits. For a host whose save reads
   * the value without the field losing focus first, such as a ⌘S handler;
   * such a host restores its value in `onCancel`.
   */
  readonly onDraftChange?: (draft: string) => void;
  /** Placement only (width, margins, flex). */
  readonly className?: string;
  /**
   * `body` (default) is the 28px row edit in 14px text. `inherit` takes the
   * font (size, weight, line) of the text it replaces, such as a page
   * heading or a 13px branch pill, so the text neither moves nor resizes
   * when editing starts.
   */
  readonly size?: 'body' | 'inherit';
  /** Grow with the text instead of filling the parent's width. */
  readonly grow?: boolean;
};

export type InlineTextInputProps = InlineTextInputBaseProps &
  (
    | { readonly 'aria-label': string; readonly 'aria-labelledby'?: string }
    | { readonly 'aria-label'?: string; readonly 'aria-labelledby': string }
  );

const INLINE_SIZE_CLASS = {
  // 16px text on touch screens keeps iOS from zooming into the field.
  body: 'h-7 text-s pointer-coarse:h-11 pointer-coarse:text-m',
  // Inputs inherit `font` in the app's base styles; no size of its own.
  inherit: 'py-0',
} as const;

const INLINE_CLASS =
  'min-w-0 truncate rounded-row bg-transparent px-2 fg-primary outline-none transition-shadow placeholder:fg-tertiary focus:shadow-field-focus aria-invalid:shadow-field-invalid aria-invalid:focus:shadow-field-invalid-focus disabled:cursor-not-allowed disabled:fg-disabled';

function assignRef(
  ref: ForwardedRef<HTMLInputElement>,
  element: HTMLInputElement | null,
): void {
  if (typeof ref === 'function') ref(element);
  else if (ref) ref.current = element;
}

export const InlineTextInput = forwardRef<
  HTMLInputElement,
  InlineTextInputProps
>(function InlineTextInput(
  {
    value,
    onCommit,
    onCancel,
    onDraftChange,
    className = '',
    size = 'body',
    grow = false,
    onKeyDown,
    onFocus,
    onBlur,
    ...props
  },
  ref,
): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(value);
  // Whether the person typed since the field took focus. Until they do, the
  // field follows a newer saved value (a generated title arriving while it
  // has focus) instead of committing the older text over it. Once they do,
  // their text is theirs, even when it matches the value from before.
  const [typed, setTyped] = useState(false);
  const [editing, setEditing] = useState(false);
  // Set by Escape so the blur that follows does not commit the draft.
  const cancelled = useRef(false);
  const shown = editing && typed ? draft : value;

  const commit = (): void => {
    if (typed && draft !== value) onCommit(draft);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    // Enter and Escape that confirm or dismiss an input-method candidate
    // belong to the input method. Safari reports them with keyCode 229.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      inputRef.current?.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelled.current = true;
      setDraft(value);
      onCancel?.();
      inputRef.current?.blur();
    }
  };

  return (
    <input
      {...props}
      ref={(element) => {
        inputRef.current = element;
        assignRef(ref, element);
      }}
      type="text"
      value={shown}
      onChange={(event) => {
        setTyped(true);
        setDraft(event.target.value);
        onDraftChange?.(event.target.value);
      }}
      onFocus={(event) => {
        cancelled.current = false;
        setTyped(false);
        setDraft(value);
        setEditing(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        if (!cancelled.current) commit();
        cancelled.current = false;
        setEditing(false);
        onBlur?.(event);
      }}
      onKeyDown={handleKeyDown}
      // Growing: the input is as wide as its text (`size` counts characters),
      // never narrower than a few.
      size={grow ? Math.max(shown.length, 4) : undefined}
      className={`${INLINE_CLASS} ${INLINE_SIZE_CLASS[size]} ${grow ? 'max-w-full' : 'w-full'}${className ? ` ${className}` : ''}`}
    />
  );
});

InlineTextInput.displayName = 'InlineTextInput';
