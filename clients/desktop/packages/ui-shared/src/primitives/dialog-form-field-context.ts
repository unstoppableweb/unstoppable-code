'use client';

import { createContext, useContext } from 'react';

/**
 * What a `DialogFormField` tells the controls inside it: the id of the
 * control its label names, the label's own id, and the ids that describe the
 * control (its help text). `null` outside a dialog form field.
 */
export interface DialogFormFieldDescription {
  readonly controlId: string | undefined;
  readonly labelId: string;
  readonly describedBy: string | undefined;
}

export const DialogFormFieldContext =
  createContext<DialogFormFieldDescription | null>(null);

/**
 * The control's `aria-describedby` with its `DialogFormField`'s help text
 * added, so a dialog form never wires the help text by hand. The control the
 * field's label names (`id` equal to `htmlFor`) takes it, and so does any
 * control in a field without `htmlFor`; ids the caller already lists stay
 * first and are not repeated.
 */
export function useDialogFormFieldDescribedBy(
  id: string | undefined,
  describedBy: string | undefined,
): string | undefined {
  const field = useContext(DialogFormFieldContext);
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
 * when nothing else names the control (no `aria-label`, and no `htmlFor`
 * pointing at its `id`).
 */
export function useDialogFormFieldLabelledBy(
  id: string | undefined,
  ariaLabel: string | undefined,
  ariaLabelledBy: string | undefined,
): string | undefined {
  const field = useContext(DialogFormFieldContext);
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
