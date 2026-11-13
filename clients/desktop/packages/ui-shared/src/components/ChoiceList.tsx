import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { HAIRLINE_INSET_RING_CLASS } from '../lib/row-chips';
import { ChoiceMark } from './Choice';

/**
 * A short list of choices the person ticks in place (projects to index,
 * owners an agent may act for, roles in a profile), shared by desktop and
 * web.
 *
 * - Box: a hairline inset edge on the 8px radius, with hairline dividers
 *   between rows. It scrolls when the caller caps its height.
 * - Row: a whole-row control that toggles one choice, its `ChoiceMark`
 *   leading. It is a checkbox or a radio to assistive technology and UI
 *   automation (`role` + `aria-checked`), never a pressed button. Selection
 *   is the mark alone; the row takes no selected fill. Hover and keyboard
 *   focus still highlight.
 * - `kind="radio"` makes the list a radiogroup: one tab stop (the chosen row,
 *   or the first) and arrow keys that move and choose, skipping disabled
 *   rows and wrapping.
 * - A long list a host virtualizes takes the forwarded ref (the scrolling
 *   box) and moves focus itself through `onKeyDown`; its rows set
 *   `focusableWhenDisabled` so the arrow keys can pass over a disabled row.
 */
export interface ChoiceListProps {
  /** Accessible name of the group: `Projects`, `Owners`. */
  readonly 'aria-label': string;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
  /** Placement and height only (`max-h-72`, margins). */
  readonly className?: string;
  /** `radio` when the rows are one choice: a radiogroup with arrow keys. */
  readonly kind?: 'checkbox' | 'radio';
  /** Runs before the radiogroup's own arrow keys. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

const NEXT_KEYS = new Set(['ArrowDown', 'ArrowRight']);
const PREVIOUS_KEYS = new Set(['ArrowUp', 'ArrowLeft']);

function enabledRadios(group: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    group.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ).filter((radio) => !radio.disabled);
}

export const ChoiceList = forwardRef<HTMLDivElement, ChoiceListProps>(
  function ChoiceList(
    {
      'aria-label': ariaLabel,
      children,
      'data-testid': dataTestId,
      className = '',
      kind = 'checkbox',
      onKeyDown: onHostKeyDown,
    },
    ref,
  ): JSX.Element {
    const groupRef = useRef<HTMLDivElement | null>(null);
    const radio = kind === 'radio';
    const setGroupRef = useCallback(
      (node: HTMLDivElement | null): void => {
        groupRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    // Roving tab stop: the chosen radio, or the first enabled one.
    useLayoutEffect(() => {
      const group = groupRef.current;
      if (!radio || !group) return;
      const radios = enabledRadios(group);
      const stop =
        radios.find((row) => row.getAttribute('aria-checked') === 'true') ??
        radios[0];
      for (const row of group.querySelectorAll<HTMLButtonElement>(
        '[role="radio"]',
      )) {
        row.tabIndex = row === stop ? 0 : -1;
      }
    });

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      onHostKeyDown?.(event);
      const group = groupRef.current;
      if (!radio || !group) return;
      const step = NEXT_KEYS.has(event.key)
        ? 1
        : PREVIOUS_KEYS.has(event.key)
          ? -1
          : 0;
      if (step === 0) return;
      const radios = enabledRadios(group);
      const current = radios.findIndex((row) => row === event.target);
      if (current === -1 || radios.length === 0) return;
      event.preventDefault();
      const next = radios[(current + step + radios.length) % radios.length];
      next?.focus();
      next?.click();
    };

    return (
      <div
        ref={setGroupRef}
        role={radio ? 'radiogroup' : 'group'}
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        data-testid={dataTestId}
        className={`flex flex-col divide-y overflow-y-auto rounded-lg ${HAIRLINE_INSET_RING_CLASS} ring-line-base ${className}`}
      >
        {children}
      </div>
    );
  },
);

export interface ChoiceListRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'aria-pressed' | 'aria-checked' | 'role' | 'className' | 'children'
> {
  readonly selected: boolean;
  /** `checkbox` (default) for many choices, `radio` for one. */
  readonly kind?: 'checkbox' | 'radio';
  /** The row's text: one line, or a name over a quieter detail. */
  readonly children: ReactNode;
  /** A quiet note or badge at the row's trailing edge. */
  readonly trailing?: ReactNode;
  /** A glyph or avatar between the mark and the text. */
  readonly leading?: ReactNode;
  /**
   * A disabled row stays focusable (`aria-disabled`) and never toggles, so
   * a host's arrow keys can move through it.
   */
  readonly focusableWhenDisabled?: boolean;
}

/** One choice: the mark, the text, and an optional trailing note. */
export function ChoiceListRow({
  selected,
  kind = 'checkbox',
  children,
  trailing,
  leading,
  disabled,
  focusableWhenDisabled = false,
  onClick,
  ...props
}: ChoiceListRowProps): JSX.Element {
  const softDisabled = focusableWhenDisabled && disabled === true;
  // The focus ring sits inside the full-width row: the list scrolls, and
  // would cut an outside ring off at its sides and the first row's top.
  return (
    <button
      {...props}
      type="button"
      role={kind}
      aria-checked={selected}
      {...(focusableWhenDisabled
        ? { 'aria-disabled': softDisabled || undefined }
        : { disabled })}
      onClick={softDisabled ? undefined : onClick}
      className={
        focusableWhenDisabled
          ? 'group/choice-row focus-ring focus-ring-inset flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-s fg-primary transition-colors hover:bg-subtle focus-visible:bg-subtle aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent'
          : 'group/choice-row focus-ring focus-ring-inset flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-s fg-primary transition-colors hover:bg-subtle focus-visible:bg-subtle disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent'
      }
    >
      <ChoiceMark kind={kind} checked={selected} disabled={disabled} />
      {leading}
      <span className="min-w-0 flex-1">{children}</span>
      {trailing ? (
        <span className="shrink-0 text-xs fg-secondary">{trailing}</span>
      ) : null}
    </button>
  );
}
