'use client';

import { createContext, useContext } from 'react';

/**
 * What a `FormField` tells a control passed as its children: the id of the
 * control its label names, the label's own id, and the ids that describe the
 * control (its help text). `null` outside such a field, and for a control a
 * `FormField` render function wires by hand.
 */
export interface FormFieldDescription {
  readonly controlId: string | undefined;
  readonly labelId: string;
  readonly describedBy: string | undefined;
}

export const FormFieldContext = createContext<FormFieldDescription | null>(
  null,
);

/**
 * True for a control passed as a `FormField`'s children. Settings dropdowns
 * read it: in a form field they fill the field's width (a dialog's content
 * width) instead of the 144px or 208px column of a Settings page row.
 */
export function useInFormField(): boolean {
  return useContext(FormFieldContext) !== null;
}

/**
 * The control's `aria-describedby` with its `FormField`'s help text added,
 * so a dialog form never wires the help text by hand. The control the
 * field's label names (`id` equal to the field's `id`) takes it, and so does
 * any control in a field without an `id`; ids the caller already lists stay
 * first and are not repeated.
 */
export function useFormFieldDescribedBy(
  id: string | undefined,
  describedBy: string | undefined,
): string | undefined {
  const field = useContext(FormFieldContext);
  if (
    field?.describedBy === undefined ||
    (field.controlId !== undefined && id !== field.controlId)
  ) {
    return describedBy;
  }
  const ids = (describedBy ?? '').split(/\s+/).filter(Boolean);
  for (const added of field.describedBy.split(' ')) {
    if (!ids.includes(added)) ids.push(added);
  }
  return ids.join(' ');
}

/**
 * The control's `aria-labelledby`: the caller's, or else the field's label
 * when nothing else names the control (no `aria-label`, and not the field's
 * `id`, which its label names).
 */
export function useFormFieldLabelledBy(
  id: string | undefined,
  ariaLabel: string | undefined,
  ariaLabelledBy: string | undefined,
): string | undefined {
  const field = useContext(FormFieldContext);
  if (
    field === null ||
    ariaLabelledBy !== undefined ||
    ariaLabel !== undefined ||
    (id !== undefined && id === field.controlId)
  ) {
    return ariaLabelledBy;
  }
  return field.labelId;
}
