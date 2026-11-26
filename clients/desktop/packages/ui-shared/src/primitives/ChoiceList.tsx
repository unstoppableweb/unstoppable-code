'use client';

import {
  forwardRef,
  useId,
  useMemo,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { HAIRLINE_INSET_RING_CLASS } from '../lib/row-chips';
import {
  ChoiceListContext,
  type ChoiceListContextValue,
} from './choice-list-context';

/**
 * A short list of choices the person ticks in place (projects to index,
 * owners an agent may act for, roles in a profile), shared by desktop and
 * web.
 *
 * - Box: a hairline inset edge on the 8px radius, with hairline dividers
 *   between rows. It scrolls when the caller caps its height.
 * - Row: `ChoiceField layout="row"`, a label around a native checkbox or
 *   radio, so a click anywhere on the row toggles it and the input keeps its
 *   role and checked state. Selection is the mark alone; the row takes no
 *   selected fill. Hover and keyboard focus still highlight.
 * - `kind="radio"` makes the list a radiogroup whose radios share one name,
 *   so the browser gives it one tab stop (the chosen radio, or the first) and
 *   arrow keys that move and choose, skipping disabled rows and wrapping.
 * - A long list a host virtualizes takes the forwarded ref (the scrolling
 *   box) and moves focus itself through `onKeyDown`; its rows set
 *   `focusableWhenDisabled` so the arrow keys can pass over a disabled row.
 */
export interface ChoiceListProps {
  /** Accessible name of the group: `Projects`, `Owners`. */
  readonly 'aria-label': string;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
  /** Keep long lists scrollable within an 18rem viewport. */
  readonly height?: 'bounded';
  /** Placement only. */
  readonly className?: string;
  /** `radio` when the rows are one choice: a radiogroup with arrow keys. */
  readonly kind?: 'checkbox' | 'radio';
  /** A host's own keys, such as a virtualized list's arrow keys. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export const ChoiceList = forwardRef<HTMLDivElement, ChoiceListProps>(
  function ChoiceList(
    {
      'aria-label': ariaLabel,
      children,
      'data-testid': dataTestId,
      className = '',
      height,
      kind = 'checkbox',
      onKeyDown,
    },
    ref,
  ): JSX.Element {
    const radio = kind === 'radio';
    // Radios that share a name are one group to the browser: one tab stop,
    // and arrow keys that move and choose.
    const radioName = useId();
    const context = useMemo<ChoiceListContextValue>(
      () => ({ radioName: radio ? radioName : undefined }),
      [radio, radioName],
    );
    return (
      <ChoiceListContext.Provider value={context}>
        <div
          ref={ref}
          role={radio ? 'radiogroup' : 'group'}
          aria-label={ariaLabel}
          onKeyDown={onKeyDown}
          data-testid={dataTestId}
          className={`flex flex-col divide-y overflow-y-auto rounded-lg ${HAIRLINE_INSET_RING_CLASS} ring-line-base ${height === 'bounded' ? 'max-h-72' : ''} ${className}`}
        >
          {children}
        </div>
      </ChoiceListContext.Provider>
    );
  },
);
