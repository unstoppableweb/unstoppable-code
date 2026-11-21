'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  DIALOG_CONFIRM_CHORD,
  DISMISS_CHORD,
  formatChord,
} from '../lib/shortcut-platform';
import { Button } from './Button';
import { DialogModal } from './DialogModal';
import { DialogFormField } from './DialogFormField';
import { TextInput } from './Field';
import { LoadingSpinner } from './LoadingSpinner';

export interface RenameDialogProps {
  readonly title: string;
  readonly label: string;
  /** Read once on mount; remount (or change `key`) to reopen with a fresh value. */
  readonly initialValue: string;
  readonly placeholder?: string;
  readonly helperText?: string;
  readonly maxLength?: number;
  /** Repeats the title's verb. Defaults to `Rename`. */
  readonly submitLabel?: string;
  /** Disables the action and dismissal while the host persists the value. */
  readonly busy?: boolean;
  /**
   * Why the submitted value can't be saved (`A workflow named “Bug fix”
   * already exists.`). It shows under the field only after a submit: the
   * dialog stays open with the person's text, and editing the field clears
   * the message until the next submit. The host sets it from `onSubmit`.
   */
  readonly error?: string | null;
  /**
   * Receives the raw draft. Normalization, empty-value semantics and whether
   * an unchanged value is a no-op belong to the host.
   */
  readonly onSubmit: (value: string) => void;
  readonly onClose: () => void;
  readonly ownerDocument?: Document;
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  readonly titleId?: string;
  readonly inputId?: string;
  readonly dataTestId?: string;
  readonly inputTestId?: string;
  readonly submitTestId?: string;
  readonly cancelTestId?: string;
}

/**
 * Single-field rename dialog shared by desktop and web hosts. It takes the
 * compact confirmation shape: the field focuses to the neutral halo with its
 * value selected, Enter submits, and Cancel or Escape closes it. Both keys
 * sit inside their buttons, as in {@link ConfirmDialog}.
 */
export function RenameDialog({
  title,
  label,
  initialValue,
  placeholder,
  helperText,
  maxLength,
  submitLabel = 'Rename',
  busy = false,
  error = null,
  onSubmit,
  onClose,
  ownerDocument,
  restoreFocusRef,
  titleId,
  inputId,
  dataTestId,
  inputTestId,
  submitTestId,
  cancelTestId,
}: RenameDialogProps): JSX.Element {
  const [draft, setDraft] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const fieldId = inputId ?? `${generatedId}-input`;
  const errorId = `${fieldId}-error`;
  // An error is about the last submit, so it shows only until the person
  // edits the field again.
  const [submittedSinceEdit, setSubmittedSinceEdit] = useState(false);
  const visibleError =
    error !== null && error !== '' && submittedSinceEdit ? error : null;
  // `DialogFormField` adds its help text to the field's description.
  const describedBy = visibleError !== null ? errorId : undefined;

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const close = busy ? (): void => undefined : onClose;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    setSubmittedSinceEdit(true);
    onSubmit(draft);
  };

  // Enter during IME composition commits the candidate, not the form.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) {
      event.preventDefault();
    }
  };

  return (
    <DialogModal
      variant="confirm"
      onClose={close}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      title={title}
      titleId={titleId}
      dataTestId={dataTestId}
      ownerDocument={ownerDocument}
      trapFocus
      initialFocusRef={inputRef}
      restoreFocusRef={restoreFocusRef}
    >
      <form className="flex flex-col gap-4.5 pt-3" onSubmit={handleSubmit}>
        <div>
          <DialogFormField
            label={label}
            htmlFor={fieldId}
            errorId={errorId}
            error={
              visibleError !== null ? (
                <span
                  data-testid={inputTestId ? `${inputTestId}-error` : undefined}
                >
                  {visibleError}
                </span>
              ) : null
            }
            description={helperText ?? null}
          >
            <TextInput
              ref={inputRef}
              id={fieldId}
              density="settings"
              value={draft}
              placeholder={placeholder}
              maxLength={maxLength}
              onChange={(event) => {
                setDraft(event.target.value);
                // Editing makes the last submit's error stale.
                setSubmittedSinceEdit(false);
              }}
              onKeyDown={handleKeyDown}
              aria-describedby={describedBy}
              aria-invalid={visibleError !== null ? true : undefined}
              data-testid={inputTestId}
              autoComplete="off"
              spellCheck={false}
            />
          </DialogFormField>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="compact"
            onClick={close}
            disabled={busy}
            shortcut={formatChord(DISMISS_CHORD)}
            data-testid={cancelTestId}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="compact"
            disabled={busy}
            aria-busy={busy}
            shortcut={busy ? undefined : formatChord(DIALOG_CONFIRM_CHORD)}
            data-testid={submitTestId}
          >
            {busy && (
              <LoadingSpinner
                className="shrink-0"
                dataTestId="rename-dialog-spinner"
                decorative
              />
            )}
            {submitLabel}
          </Button>
        </div>
      </form>
    </DialogModal>
  );
}
