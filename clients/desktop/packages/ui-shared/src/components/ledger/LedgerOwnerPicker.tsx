'use client';

import { useRef, useState, type JSX, type MouseEvent } from 'react';
import {
  isSameLedgerPipelinePause,
  type LedgerOwnerCandidate,
  type LedgerOwnerPipelineAgent,
} from '@canopy/protocol/canopy-core/core/ledger';
import {
  ledgerOwnerCandidateDescription,
  ledgerOwnerCandidateTitle,
} from '../../lib/ledger-display';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '../../lib/replay-privacy';
import { Button } from '../../primitives/Button';
import { Skeleton } from '../../primitives/Skeleton';
import { Tooltip } from '../../primitives/Tooltip';
import {
  FloatingPickerMenu,
  PickerMenuFooter,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuSampleOptions,
  PickerMenuState,
  PickerTrigger,
  PickerTriggerChevron,
  type PickerTriggerVariant,
} from '../../primitives/PickerMenu';
import { LedgerInPlaceTrigger } from './LedgerInPlaceTrigger';

export interface LedgerOwnerPickerProps {
  /** The current owner's name. */
  ownerName: string;
  /** The current owner's actor; null when it is the person ("You"). */
  ownerActorId: string | null;
  /**
   * The pause the current owner was chosen at, when it is a paused pipeline
   * agent. A later pause of the same agent is then offered as another owner.
   * Omit when the owner is known only by its actor.
   */
  ownerPipelineAgent?: LedgerOwnerPipelineAgent;
  candidates: readonly LedgerOwnerCandidate[];
  status: 'idle' | 'loading' | 'ready' | 'problem';
  /** Reads the candidates; called when the picker opens. */
  onOpen: () => void;
  /** The chosen owner; null is the person ("You"). */
  onSelect: (candidate: LedgerOwnerCandidate | null) => void;
  /** A change is being saved; the picker waits for it. */
  saving?: boolean;
  /** Why no owner can be chosen yet, such as no task chosen; it waits. */
  disabledReason?: string;
  /** `field` inside a form, `capsule` beside details, or `inline` on a row. */
  variant?: PickerTriggerVariant | 'inline';
  /** Names the trigger for screen readers when no visible label does. */
  'aria-label'?: string;
  /** The visible label that names the trigger, inside a form. */
  'aria-labelledby'?: string;
  /** Replaces the current owner's name on the trigger. */
  triggerLabel?: string;
  /** The trigger's test id; defaults to `ledger-owner-picker`. */
  triggerTestId?: string;
  id?: string;
}

/**
 * Chooses who owns an entry: the person ("You", always offered), the scope's
 * chats, retained delegates and paused pipeline agents. Each row is one line;
 * a pipeline agent names its exact run, job and step, and its full locator,
 * checkpoint included, is in the row's tooltip.
 */
export function LedgerOwnerPicker({
  ownerName,
  ownerActorId,
  ownerPipelineAgent,
  candidates,
  status,
  onOpen,
  onSelect,
  saving = false,
  disabledReason,
  variant = 'capsule',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  triggerLabel,
  triggerTestId = 'ledger-owner-picker',
  id,
}: LedgerOwnerPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const self = candidates.find((candidate) => candidate.isSelf);
  const others = candidates.filter((candidate) => !candidate.isSelf);
  const inlineAriaLabel =
    ariaLabel === undefined ? `Change owner, now ${ownerName}` : ariaLabel;
  // Unavailable, the trigger stays focusable (aria-disabled, not disabled),
  // so keyboard and hover both reach the reason's tooltip.
  // Saving keeps it focusable too: focus returns to the trigger after a
  // pick, and disabling it then would drop focus to the page.
  const unavailable = disabledReason !== undefined || saving;
  const onTriggerClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (unavailable) return;
    if (!open) onOpen();
    setOpen((previous) => !previous);
  };
  const youSelected =
    ownerActorId === null ||
    (self !== undefined && self.actor.actorId === ownerActorId);
  const currentOwner = candidates.find(
    (candidate) => candidate.actor.actorId === ownerActorId,
  );
  const ownerNamePrivacyClass =
    ownerActorId === null || currentOwner?.actor.kind === 'user'
      ? REPLAY_BLOCK_CLASS
      : REPLAY_MASK_CLASS;
  const withReason = (trigger: JSX.Element): JSX.Element =>
    disabledReason === undefined ? (
      trigger
    ) : (
      <Tooltip
        label={disabledReason}
        allowShrink
        className={variant === 'field' ? 'w-full' : undefined}
      >
        {trigger}
      </Tooltip>
    );
  return (
    <div
      className={
        // Inline, a flex box: the trigger sets the height and no line box does.
        variant === 'inline' ? 'relative flex min-w-0' : 'relative min-w-0'
      }
    >
      {withReason(
        variant === 'inline' ? (
          <LedgerInPlaceTrigger
            ref={triggerRef}
            id={id}
            aria-disabled={unavailable || undefined}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={inlineAriaLabel}
            data-testid={triggerTestId}
            // The trigger's -mx-1 makes its wrapper 0.5rem narrower than it;
            // `max-w-full` alone would cut a short name such as You.
            extent="flush-owner"
            onClick={onTriggerClick}
          >
            <span className="flex min-w-0 items-center gap-1 text-2xs">
              <span className="shrink-0 fg-tertiary">Owner:</span>
              {triggerLabel === undefined ? (
                <span
                  className={`min-w-0 truncate fg-secondary ${ownerNamePrivacyClass}`}
                >
                  {ownerName}
                </span>
              ) : (
                <span className="min-w-0 truncate fg-secondary">
                  {triggerLabel}
                </span>
              )}
            </span>
          </LedgerInPlaceTrigger>
        ) : (
          <PickerTrigger
            ref={triggerRef}
            id={id}
            variant={variant}
            unavailable={unavailable}
            coarsePointerTarget
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            data-testid={triggerTestId}
            className={
              variant === 'capsule' ? '-mx-2.5' : 'w-full justify-between'
            }
            onClick={onTriggerClick}
          >
            <span
              className={
                triggerLabel === undefined
                  ? `truncate ${ownerNamePrivacyClass}`
                  : 'truncate'
              }
            >
              {triggerLabel ?? ownerName}
            </span>
            <PickerTriggerChevron open={open} variant={variant} />
          </PickerTrigger>
        ),
      )}
      <FloatingPickerMenu
        open={open}
        // Arrow keys on the trigger open it too: never while unavailable,
        // and loading the owners as a click does.
        openOnArrowKeys={!unavailable}
        onOpenChange={(next) => {
          if (next && !open) onOpen();
          setOpen(next);
        }}
        anchorRef={triggerRef}
        placement="bottom-left"
        heightLimit={360}
        interaction="menu"
        // Wide enough for a pipeline agent's run, job and step on one line.
        minimumWidth="17.5rem"
        maximumWidth="22rem"
        data-testid="ledger-owner-menu"
      >
        <PickerMenuOption
          role="menuitemradio"
          aria-checked={youSelected}
          selected={youSelected}
          data-testid="ledger-owner-option-you"
          onClick={() => {
            if (!youSelected) onSelect(self ?? null);
          }}
        >
          <PickerMenuOptionContent>
            <PickerMenuOptionLabel>
              <span className={REPLAY_BLOCK_CLASS}>You</span>
            </PickerMenuOptionLabel>
          </PickerMenuOptionContent>
          <PickerMenuOptionCheck selected={youSelected} />
        </PickerMenuOption>
        {status === 'loading' && (
          <Skeleton loading label="Loading owners">
            <PickerMenuSampleOptions rows={3} leading={false} />
          </Skeleton>
        )}
        {status === 'problem' && (
          <PickerMenuState data-testid="ledger-owner-problem">
            <span className="flex-1">Couldn&apos;t load owners.</span>
            <Button type="button" variant="ghost" size="sm" onClick={onOpen}>
              Try again
            </Button>
          </PickerMenuState>
        )}
        {status === 'ready' && others.length === 0 && (
          <PickerMenuState>No chats or agents to assign yet.</PickerMenuState>
        )}
        {others.map((candidate) => {
          const selected =
            candidate.actor.actorId === ownerActorId &&
            (ownerPipelineAgent === undefined ||
              isSameLedgerPipelinePause(
                ownerPipelineAgent,
                candidate.pipelineAgent,
              ));
          const description = ledgerOwnerCandidateDescription(candidate);
          return (
            <PickerMenuOption
              key={candidate.actor.actorId}
              role="menuitemradio"
              aria-checked={selected}
              selected={selected}
              title={ledgerOwnerCandidateTitle(candidate)}
              data-testid="ledger-owner-option"
              data-owner-kind={candidate.actor.kind}
              data-actor-id={candidate.actor.actorId}
              onClick={() => {
                if (!selected) onSelect(candidate);
              }}
            >
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>
                  <span
                    className={
                      candidate.actor.kind === 'user'
                        ? REPLAY_BLOCK_CLASS
                        : REPLAY_MASK_CLASS
                    }
                  >
                    {candidate.displayName}
                  </span>
                </PickerMenuOptionLabel>
                {description.length > 0 && (
                  <PickerMenuOptionDescription>
                    {description}
                  </PickerMenuOptionDescription>
                )}
              </PickerMenuOptionContent>
              <PickerMenuOptionCheck selected={selected} />
            </PickerMenuOption>
          );
        })}
        <PickerMenuFooter>
          <p className="px-2 py-1 text-2xs fg-tertiary">
            Assigning this entry does not start the session.
          </p>
        </PickerMenuFooter>
      </FloatingPickerMenu>
    </div>
  );
}
