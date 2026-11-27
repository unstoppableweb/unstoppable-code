import { forwardRef, type JSX, type MouseEvent, type ReactNode } from 'react';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import {
  PickerOption,
  type PickerOptionProps,
} from '../primitives/PickerParts';
import {
  MODEL_LIBRARY_UNLOCK_HINTS,
  MODEL_LIBRARY_UNLOCK_LABELS,
} from './creditsPromptCopy';

/**
 * What a locked model row says (Card D). The user can clear the lock (sign
 * in, buy AI Credits, or sign in to the provider), so the row stays reachable
 * and activating it starts that recovery instead of selecting the model.
 */
export interface ModelRowLock {
  /** The remedy, read as the row's description and leading its details. */
  readonly hint: string;
  /**
   * Short visible remedy in the row's trailing slot, where the credits tag
   * would sit (`Sign in`, `Buy AI Credits`). Every lock has one, so a locked
   * row never looks like a usable one: picker cues are text, never a lock
   * icon (docs/design/interaction.md, Picker cues).
   */
  readonly label: string;
}

/**
 * A host's lock on one row: what it says, and what activating it does. Hosts
 * hand this to the shared model picker as the row's `locked` state.
 */
export interface LockedModelRowLock {
  readonly lock: ModelRowLock;
  readonly onActivate: () => void;
  /**
   * Keep the row where it was instead of sinking it below usable rows. A lock
   * that describes recovery the row always had (CAN-5213) must not reorder the
   * section it annotates.
   */
  readonly keepsOrder?: boolean;
}

/**
 * The row lock for a model-library access value, or `undefined` when nothing
 * is locked. Desktop, the Portal and cloud chats name the same remedy for the
 * same access, on model rows and on Auto.
 */
export function modelLibraryRowLock(
  access: ModelLibraryAccess | undefined,
): ModelRowLock | undefined {
  if (access === undefined || access === 'unlocked') return undefined;
  return {
    hint: MODEL_LIBRARY_UNLOCK_HINTS[access],
    label: MODEL_LIBRARY_UNLOCK_LABELS[access],
  };
}

export interface LockedModelRowProps extends Omit<
  PickerOptionProps,
  'role' | 'aria-checked' | 'onClick'
> {
  readonly lock: ModelRowLock;
  /** The row's click and Enter. */
  readonly onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Id for the hint, which describes the row to assistive technology. */
  readonly hintId: string;
  /** Test id of the visible label. */
  readonly cueTestId: string;
  /** Trailing content after the cue. */
  readonly trailing?: ReactNode;
}

/**
 * A model picker row the user must unlock first (Card D). It is a command,
 * not a choice: activating it runs the host's recovery (sign-in, the shared
 * UnlockDialog or the purchase), so it carries no checked state.
 */
export const LockedModelRow = forwardRef<
  HTMLButtonElement,
  LockedModelRowProps
>(function LockedModelRow(
  {
    lock,
    onActivate,
    hintId,
    cueTestId,
    trailing,
    children,
    'aria-describedby': describedBy,
    ...rowProps
  },
  ref,
): JSX.Element {
  const label = lock.label.trim() || undefined;
  return (
    <PickerOption
      {...rowProps}
      ref={ref}
      role="menuitem"
      data-locked="true"
      aria-describedby={describedBy ? `${hintId} ${describedBy}` : hintId}
      onClick={onActivate}
    >
      {children}
      {label ? (
        // Same slot, type and padding as the credits tag it replaces. The
        // label never shrinks: a long model name truncates instead. The hint
        // already names the remedy for assistive technology, so the visible
        // label is not read twice.
        <span
          aria-hidden="true"
          className="-mx-2 -my-2 inline-flex shrink-0 items-center self-stretch px-2 py-2"
        >
          <span
            className="shrink-0 text-2xs fg-secondary"
            data-testid={cueTestId}
          >
            {label}
          </span>
        </span>
      ) : null}
      {trailing}
      <span id={hintId} className="sr-only">
        {lock.hint}
      </span>
    </PickerOption>
  );
});

LockedModelRow.displayName = 'LockedModelRow';
