import { useContext, useId, useMemo, type JSX, type ReactNode } from 'react';
import { DialogFormFieldContext } from './dialog-form-field-context';
import { FieldError } from './Field';
import {
  FORM_FIELD_DESCRIPTION_CLASS,
  FORM_FIELD_LABEL_CLASS,
} from './FormField';

/**
 * True inside a `DialogFormField`. Settings dropdowns read it: in a dialog's
 * form field they fill the dialog's content width instead of the 144px or
 * 208px column of a Settings page row.
 */
export function useInDialogFormField(): boolean {
  return useContext(DialogFormFieldContext) !== null;
}

export interface DialogFormFieldProps {
  readonly label: ReactNode;
  /** Id of the control the label names. */
  readonly htmlFor?: string;
  /**
   * Id of the label, for a control that names itself with `aria-labelledby`
   * instead of `htmlFor`: a button that opens a picker and shows its value.
   * A `<label for>` would replace the button's text as its name and open the
   * picker when the label is clicked. Generated when not given.
   */
  readonly labelId?: string;
  /**
   * Help text under the field. The control `htmlFor` names (or, without
   * `htmlFor`, the control inside) takes it in its `aria-describedby` on its
   * own when it is a shared field (`TextInput`, `TextArea`, `Select`,
   * `SettingsSelect`), which also take the label as their name when nothing
   * else names them.
   */
  readonly description?: ReactNode;
  /**
   * The field's validation message, shown in `FieldError` directly under the
   * control and before the help text. Its id is `errorId`, or
   * `${htmlFor}-error` (a generated id without `htmlFor`); point the
   * control's `aria-describedby` at it.
   */
  readonly error?: ReactNode;
  readonly errorId?: string;
  readonly dataTestId?: string;
  readonly children: ReactNode;
}

/**
 * One field of a dialog's form: the label over a control that fills the
 * dialog's content width. Shares its label, error, and help text order with
 * `FormField`: label, control, error, help.
 */
export function DialogFormField({
  label,
  htmlFor,
  labelId,
  description,
  error,
  errorId,
  dataTestId,
  children,
}: DialogFormFieldProps): JSX.Element {
  const generatedId = useId();
  const showError =
    error !== undefined && error !== null && error !== false && error !== '';
  const showDescription =
    description !== undefined &&
    description !== null &&
    description !== false &&
    description !== '';
  const descriptionId = `${generatedId}-description`;
  const fieldLabelId = labelId ?? `${generatedId}-label`;
  const fieldDescription = useMemo(
    () => ({
      controlId: htmlFor,
      labelId: fieldLabelId,
      describedBy: showDescription ? descriptionId : undefined,
    }),
    [htmlFor, fieldLabelId, showDescription, descriptionId],
  );
  return (
    <div className="flex flex-col gap-1.5" data-testid={dataTestId}>
      {htmlFor ? (
        <label
          id={fieldLabelId}
          htmlFor={htmlFor}
          className={FORM_FIELD_LABEL_CLASS}
        >
          {label}
        </label>
      ) : (
        <span id={fieldLabelId} className={FORM_FIELD_LABEL_CLASS}>
          {label}
        </span>
      )}
      <DialogFormFieldContext.Provider value={fieldDescription}>
        <div className="flex min-w-0">{children}</div>
      </DialogFormFieldContext.Provider>
      {showError ? (
        <FieldError id={errorId ?? `${htmlFor ?? generatedId}-error`}>
          {error}
        </FieldError>
      ) : null}
      {showDescription ? (
        <p id={descriptionId} className={FORM_FIELD_DESCRIPTION_CLASS}>
          {description}
        </p>
      ) : null}
    </div>
  );
}
