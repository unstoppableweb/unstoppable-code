'use client';

import {
  forwardRef,
  useEffect,
  useRef,
  type ChangeEvent,
  type ClipboardEvent,
  type JSX,
} from 'react';
import { TextInput, type TextInputProps } from '../primitives/Field';

/**
 * `numeric` keeps only ASCII digits, up to `length`, preserving leading
 * zeros. `text` keeps every character the person types, for codes that mix
 * digits and letters (2FA backup codes); a paste is only trimmed.
 */
export type OneTimeCodeFormat = 'numeric' | 'text';

export interface OneTimeCodeInputProps extends Omit<
  TextInputProps,
  | 'value'
  | 'onChange'
  | 'onPaste'
  | 'type'
  | 'inputMode'
  | 'autoComplete'
  | 'mono'
  | 'align'
> {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly format?: OneTimeCodeFormat;
  /** Digits in a complete `numeric` code. */
  readonly length?: number;
  /**
   * Called once when a `numeric` code reaches `length`, by typing or
   * pasting. It fires again only after the code changes, so one completed
   * code submits once.
   */
  readonly onComplete?: (code: string) => void;
}

function normalizeCode(
  raw: string,
  format: OneTimeCodeFormat,
  length: number,
): string {
  return format === 'numeric'
    ? raw.replace(/[^0-9]/g, '').slice(0, length)
    : raw;
}

/**
 * One accessible field for a one-time code: numeric keyboard, `one-time-code`
 * autofill, monospace centred value, and paste support. Spread `FormField`'s
 * control props onto it like `TextInput`.
 */
export const OneTimeCodeInput = forwardRef<
  HTMLInputElement,
  OneTimeCodeInputProps
>(function OneTimeCodeInput(
  {
    value,
    onValueChange,
    format = 'numeric',
    length = 6,
    onComplete,
    ...props
  },
  ref,
): JSX.Element {
  const completedRef = useRef<string | null>(null);

  useEffect(() => {
    if (value.length < length || format !== 'numeric') {
      completedRef.current = null;
    }
  }, [value, length, format]);

  const update = (next: string): void => {
    onValueChange(next);
    if (format !== 'numeric') return;
    if (next.length < length) {
      completedRef.current = null;
      return;
    }
    if (completedRef.current === next) return;
    completedRef.current = next;
    onComplete?.(next);
  };

  return (
    <TextInput
      {...props}
      ref={ref}
      type="text"
      inputMode={format === 'numeric' ? 'numeric' : 'text'}
      autoComplete="one-time-code"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      mono
      align="center"
      value={value}
      onChange={(event: ChangeEvent<HTMLInputElement>): void =>
        update(normalizeCode(event.target.value, format, length))
      }
      onPaste={(event: ClipboardEvent<HTMLInputElement>): void => {
        const pasted = event.clipboardData.getData('text');
        if (!pasted) return;
        event.preventDefault();
        update(normalizeCode(pasted.trim(), format, length));
      }}
    />
  );
});
