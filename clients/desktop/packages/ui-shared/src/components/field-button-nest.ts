'use client';

import { createContext, useContext } from 'react';

/**
 * The field a button nests in. The button's corner is the field's corner
 * less the button's inset, so the two arcs share a centre, and the field
 * keeps the same inset from its end as from its top and bottom.
 *
 * - `field`: a 28px field with 10px corners (`SearchField` `sm`, a `compact`
 *   or `settings` `TextInput`). A 24px button 2px in: 8px corners.
 * - `field-md`: a 32px field with 10px corners (`SearchField` `md`). A 24px
 *   button 4px in: 6px corners.
 * - `field-lg`: a 36px field with 12px corners (a `default` `TextInput`). A
 *   28px button 4px in: 8px corners.
 * - `header`: the 44px header of a palette, which has no edge of its own to
 *   nest in. A 28px button, round.
 *
 * The field owns this: `SearchField` and `TextInput` provide it, and
 * `FieldButton` (in `SearchField.tsx`) reads it. Nothing else sets it.
 */
export type FieldButtonNest = 'field' | 'field-md' | 'field-lg' | 'header';

const FieldButtonNestContext = createContext<FieldButtonNest>('field');

/** For the field components only: names the field its buttons nest in. */
export const FieldButtonNestProvider = FieldButtonNestContext.Provider;

export function useFieldButtonNest(): FieldButtonNest {
  return useContext(FieldButtonNestContext);
}
