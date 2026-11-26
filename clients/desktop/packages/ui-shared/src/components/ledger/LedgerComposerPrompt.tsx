'use client';

import { ControlButton } from '../../primitives/Button';
import { useId, type JSX } from 'react';
import { Tooltip } from '../../primitives/Tooltip';
import { LedgerActorAvatar } from './LedgerActorAvatar';
import type { LedgerDensity } from './ledger-entry-slots';

export interface LedgerComposerPromptProps {
  readonly density: LedgerDensity;
  /** The person, for their avatar. */
  readonly personName: string;
  /** The prompt; defaults to `Add a task, decision or finding`. The feature layer passes `Continue draft` while one is set aside. */
  readonly label?: string;
  readonly onOpen: () => void;
  /** Why nothing can be added now; disables the prompt and explains it. */
  readonly disabledReason?: string | null;
  /**
   * The pill's `data-testid`, for a host whose automation already names
   * this action, such as `ledger-add-entry`.
   */
  readonly testId?: string;
}

/** A quiet, collapsed prompt for the column's entry composer. */
export function LedgerComposerPrompt({
  density,
  personName,
  label = 'Add a task, decision or finding',
  onOpen,
  disabledReason,
  testId = 'ledger-composer-prompt',
}: LedgerComposerPromptProps): JSX.Element {
  const reasonId = useId();
  const reason = disabledReason ?? undefined;
  const disabled = reason !== undefined;
  const page = density === 'page';

  return (
    <section
      aria-label="Add an entry"
      className={`flex items-center gap-3 border-b border-line-base ${page ? 'pb-4' : 'pb-3'}`}
    >
      <LedgerActorAvatar
        kind="user"
        name={personName}
        size={page ? 'large' : 'small'}
        // The person writing is the one on this device.
        localUser
      />
      {/* Unavailable, the prompt stays focusable (aria-disabled, not
          disabled) so hover and keyboard focus both show the reason. */}
      <Tooltip
        label={reason}
        disabled={!disabled}
        allowShrink
        className="flex-1"
      >
        <ControlButton
          type="button"
          data-testid={testId}
          aria-disabled={disabled || undefined}
          aria-describedby={disabled ? reasonId : undefined}
          onClick={disabled ? undefined : onOpen}
          presentation="ledger-composer-prompt"
          appearance={{ disabled: !!disabled, page: !!page }}
        >
          {label}
        </ControlButton>
      </Tooltip>
      {disabled && (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </section>
  );
}
