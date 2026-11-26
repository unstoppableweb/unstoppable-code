'use client';

import { createContext } from 'react';

export interface ChoiceListContextValue {
  /** The name a radio list's radios share; unset in a checkbox list. */
  readonly radioName: string | undefined;
}

/**
 * Set by `ChoiceList` for the `ChoiceField` rows inside it: a row there takes
 * the list's row look, and a radio the list's shared name.
 */
export const ChoiceListContext = createContext<ChoiceListContextValue | null>(
  null,
);
