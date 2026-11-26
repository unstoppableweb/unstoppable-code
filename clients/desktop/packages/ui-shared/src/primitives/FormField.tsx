'use client';

import {
  Children,
  Fragment,
  isValidElement,
  useId,
  useMemo,
  type JSX,
  type ReactNode,
} from 'react';
import { FieldError } from './Field';
import { FormFieldContext } from './form-field-context';

export { useInFormField } from './form-field-context';

/**
 * The label over a form field: 13px, weight 450, primary ink (design
 * decision, 2026-10-30). Once the shared `Text variant="label"` lands, this
 * should point at it.
 */
export const FORM_FIELD_LABEL_CLASS = 'text-xs font-medium fg-primary';

/** The help text under a form field: 13px, tertiary ink. */
export const FORM_FIELD_DESCRIPTION_CLASS = 'text-xs text-pretty fg-tertiary';

/**
 * What `FormField` hands its control: spread it onto `TextInput`,
 * `TextArea`, or `Select` so the label, help text, and error reach assistive
 * technology without wiring ids by hand.
 */
export interface FormFieldControlProps {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
}

export interface FormFieldProps {
  readonly label: ReactNode;
  /** Inline annotation after the label; the field owns its 8px separation. */
  readonly labelMeta?: ReactNode;
  /**
   * Id of the control the label names. A render function gets it, generated
   * when omitted. A control passed as children keeps its own `id`; give the
   * same one here. Leave it out for a control that names itself with
   * `aria-labelledby` (a button that opens a picker and shows its value): the
   * label is then a span, so clicking it does not open the picker.
   */
  readonly id?: string;
  /** Id of the label, for a control that names itself with `aria-labelledby`. */
  readonly labelId?: string;
  /** Help text under the field. */
  readonly description?: ReactNode;
  /**
   * The validation message, shown in `FieldError` directly under the control.
   * Pass it only after the person submits, and clear it when they edit the
   * field (docs/design/forms.md).
   */
  readonly error?: ReactNode;
  /** The error's id; `${id}-error` by default. */
  readonly errorId?: string;
  /** Margin-free action aligned with the control row, independent of errors. */
  readonly trailingAction?: ReactNode;
  readonly dataTestId?: string;
  /**
   * The control. A function renders it with the ids and state the field
   * supplies. A control passed as children wires itself instead: a shared
   * field (`TextInput`, `TextArea`, `Select`, `SettingsSelect`, `DateField`)
   * adds the help text to its `aria-describedby` and takes the label as its
   * name when nothing else names it, and a `SettingsSelect` fills the field's
   * width. Point its `aria-describedby` at `errorId` yourself.
   */
  readonly children:
    | ReactNode
    | ((control: FormFieldControlProps) => ReactNode);
}

function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

function hasActionContent(node: ReactNode): boolean {
  return Children.toArray(node).some((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? hasActionContent(child.props.children)
      : hasContent(child),
  );
}

/**
 * One labelled form field: the label, the control, its error, and its help
 * text, stacked 6px apart in that order. The field wires the label to the
 * control and points the control at the error and help text, so a form never
 * hand-writes a `<label>` or `aria-describedby`.
 *
 * ```tsx
 * <FormField label="Name" error={submitted ? nameError : null}>
 *   {(control) => <TextInput {...control} value={name} onChange={…} />}
 * </FormField>
 * ```
 *
 * A dialog's form passes its control as children (`<FormField id="name">
 * <TextInput id="name" /></FormField>`), which sit in a row that fills the
 * dialog's content width. In Settings use `SettingsRowsRow`.
 */
export function FormField({
  label,
  labelMeta,
  id,
  labelId,
  description,
  error,
  errorId: errorIdProp,
  trailingAction,
  dataTestId,
  children,
}: FormFieldProps): JSX.Element {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const errorId = errorIdProp ?? `${controlId}-error`;
  const rendersControl = typeof children === 'function';
  // A control passed as children brings its own id, and `${id}-description`
  // may already name another control on the page, so its help text keeps a
  // generated id.
  const descriptionId = `${rendersControl ? controlId : generatedId}-description`;
  const contextLabelId = labelId ?? `${generatedId}-label`;
  const showError = hasContent(error);
  const showDescription = hasContent(description);
  const showTrailingAction = hasActionContent(trailingAction);
  const fieldContext = useMemo(
    () => ({
      controlId: id,
      labelId: contextLabelId,
      describedBy: showDescription ? descriptionId : undefined,
    }),
    [id, contextLabelId, showDescription, descriptionId],
  );
  const describedBy =
    [showError ? errorId : null, showDescription ? descriptionId : null]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;
  const errorContent = showError ? (
    <FieldError
      id={errorId}
      data-testid={dataTestId ? `${dataTestId}-error` : undefined}
    >
      {error}
    </FieldError>
  ) : null;
  const labelClassName = `${FORM_FIELD_LABEL_CLASS}${showTrailingAction ? ' col-start-1' : ''}`;
  const labelContent = (
    <>
      {label}
      {hasActionContent(labelMeta) && (
        <span className="pl-2 empty:pl-0">{labelMeta}</span>
      )}
    </>
  );

  return (
    <div
      className={
        showTrailingAction
          ? 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5'
          : 'flex flex-col gap-1.5'
      }
      data-testid={dataTestId}
    >
      {rendersControl || id !== undefined ? (
        <label
          id={rendersControl ? labelId : contextLabelId}
          htmlFor={controlId}
          className={labelClassName}
        >
          {labelContent}
        </label>
      ) : (
        <span id={contextLabelId} className={labelClassName}>
          {labelContent}
        </span>
      )}
      <div
        className={`flex min-w-0${rendersControl ? ' flex-col' : ''}${showTrailingAction ? ' col-start-1 row-start-2 self-start' : ''}`}
      >
        {typeof children === 'function' ? (
          children({
            id: controlId,
            'aria-describedby': describedBy,
            'aria-invalid': showError ? true : undefined,
          })
        ) : (
          <FormFieldContext.Provider value={fieldContext}>
            {children}
          </FormFieldContext.Provider>
        )}
      </div>
      {showTrailingAction && (
        // Centred on the control row, capped at one field row so the action
        // stays beside a text area's first line instead of its middle.
        <div className="col-start-2 row-start-2 flex max-h-9 items-center self-stretch pointer-coarse:max-h-11">
          {trailingAction}
        </div>
      )}
      {showTrailingAction && errorContent ? (
        <div className="col-start-1">{errorContent}</div>
      ) : (
        errorContent
      )}
      {showDescription ? (
        <p
          id={descriptionId}
          className={`${FORM_FIELD_DESCRIPTION_CLASS}${showTrailingAction ? ' col-start-1' : ''}`}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}
