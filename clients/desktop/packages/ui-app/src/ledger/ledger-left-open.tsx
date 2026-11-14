import { useEffect, useState, type JSX } from 'react';
import type { LedgerAgentLiveState } from '@canopy/app-core';
import { ledgerLeftOpenShowsAt } from '@canopy/app-state/ledger-feed';
import type {
  LedgerActorKind,
  LedgerLeftOpen,
  LedgerOwnerCandidate,
} from '@canopy/protocol/canopy-core';
import {
  Button,
  ErrorBanner,
  LedgerOwnerPicker,
  RichHoverTooltip,
  Tooltip,
} from '@canopy/ui-shared/components';
import { WarningIcon } from '@canopy/ui-shared/icons/AppIcons';
import { formatLedgerRelativeTime } from '@canopy/ui-shared/lib';
import { Surface } from '@canopy/ui-shared/components';

const LEFT_OPEN_COPY: Record<
  LedgerLeftOpen['reason'],
  (time: string) => string
> = {
  delegate_settled: (time) => `Its agent finished ${time} and left it open.`,
  pipeline_step_finished: (time) =>
    `Its pipeline step finished ${time} and left it open.`,
  chat_archived: (time) => `Its chat was archived ${time} and left it open.`,
};

/** Describes why an open entry was left behind. */
export function ledgerLeftOpenText(
  leftOpen: LedgerLeftOpen,
  now: number,
): string {
  const time = formatLedgerRelativeTime(leftOpen.at, new Date(now));
  // The time sits mid-sentence; "Just now" is the only capitalized form.
  return LEFT_OPEN_COPY[leftOpen.reason](
    time === 'Just now' ? 'just now' : time,
  );
}

/**
 * Whether an entry a session left open says so now: only once its owner and
 * every agent above it have rested ten minutes (`ledgerLeftOpenShowsAt`). The
 * caller re-renders when that time comes.
 */
export function useLedgerLeftOpenShown(
  leftOpen: LedgerLeftOpen | undefined,
  ownerKind: LedgerActorKind,
  live: LedgerAgentLiveState | undefined,
): boolean {
  const showsAt =
    leftOpen === undefined
      ? null
      : ledgerLeftOpenShowsAt(leftOpen, ownerKind, live);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (showsAt === null) return undefined;
    const wait = showsAt - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return undefined;
    }
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return (): void => clearTimeout(timer);
  }, [showsAt]);
  return showsAt !== null && Math.max(now, Date.now()) >= showsAt;
}

/**
 * A quiet warning at the end of an entry's line. Its hover card says the entry
 * may have been left open; a click shows the options under the line.
 */
export function LedgerLeftOpenTrigger({
  leftOpen,
  now,
  open,
  onToggle,
  testId,
}: {
  readonly leftOpen: LedgerLeftOpen;
  readonly now: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly testId: string;
}): JSX.Element {
  return (
    <RichHoverTooltip
      surfacePadding="relaxed"
      dataTestId={`${testId}-tooltip`}
      content={
        <span className="flex max-w-64 flex-col gap-0.5">
          <span className="font-medium">This may have been left open</span>
          <span className="fg-secondary">
            {ledgerLeftOpenText(leftOpen, now)} Click for options.
          </span>
        </span>
      }
    >
      {/* The card describes the span: a plain hover card clears its own
          trigger's aria-expanded, which the button keeps. */}
      <span className="inline-flex shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="compact"
          iconOnly
          data-testid={`${testId}-trigger`}
          aria-expanded={open}
          aria-label="May have been left open. Show options"
          onClick={(event): void => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <WarningIcon size={14} aria-hidden="true" className="fg-warning" />
        </Button>
      </span>
    </RichHoverTooltip>
  );
}

export interface LedgerLeftOpenNoteProps {
  readonly leftOpen: LedgerLeftOpen;
  readonly now: number;
  readonly ownerName: string;
  readonly ownerActorId: string | null;
  readonly candidates: readonly LedgerOwnerCandidate[];
  readonly ownersStatus: 'idle' | 'loading' | 'ready' | 'problem';
  readonly onLoadOwners: () => void;
  readonly onHandTo: (
    owner: LedgerOwnerCandidate | null,
  ) => Promise<void> | void;
  readonly onTakeIt: () => Promise<void> | void;
  readonly onClose: () => Promise<
    { ok: true } | { ok: false; message: string }
  > | void;
  /** The entry is already owned by the person or can't be assigned to them. */
  readonly takeItDisabled?: boolean;
  /** Why Take it is unavailable; shown as the disabled button's tooltip. */
  readonly disabledReason?: string;
  readonly testId?: string;
}

type PendingAction = 'hand-to' | 'take-it' | 'close';

function actionFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Couldn't complete this action.";
}

/** The options for an entry a session left open, shown under its line. */
export function LedgerLeftOpenNote({
  leftOpen,
  now,
  ownerName,
  ownerActorId,
  candidates,
  ownersStatus,
  onLoadOwners,
  onHandTo,
  onTakeIt,
  onClose,
  takeItDisabled = false,
  disabledReason,
  testId = 'ledger-left-open',
}: LedgerLeftOpenNoteProps): JSX.Element {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);

  const runAction = async (
    action: PendingAction,
    callback: () => Promise<void> | void,
  ): Promise<void> => {
    setFailure(null);
    setPendingAction(action);
    try {
      await callback();
    } catch (error) {
      setFailure(actionFailureMessage(error));
    } finally {
      setPendingAction(null);
    }
  };

  const close = async (): Promise<void> => {
    const result = await onClose();
    if (result !== undefined && !result.ok) setFailure(result.message);
  };
  const takeUnavailable = takeItDisabled || disabledReason !== undefined;
  const takeButton = (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={pendingAction !== null || takeUnavailable}
      aria-description={takeUnavailable ? disabledReason : undefined}
      data-testid="ledger-left-open-take"
      onClick={() => {
        void runAction('take-it', onTakeIt);
      }}
    >
      Take it
    </Button>
  );

  return (
    <Surface
      variant="group"
      size="small"
      role="group"
      aria-label="Left open options"
      data-testid={testId}
    >
      <div className="flex flex-col gap-2 px-3 py-2">
        <p className="text-xs fg-secondary">
          {ledgerLeftOpenText(leftOpen, now)}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <LedgerOwnerPicker
            ownerName={ownerName}
            ownerActorId={ownerActorId}
            candidates={candidates}
            status={ownersStatus}
            saving={pendingAction !== null}
            onOpen={onLoadOwners}
            onSelect={(owner) => {
              void runAction('hand-to', () => onHandTo(owner));
            }}
            triggerLabel="Hand to …"
            triggerTestId="ledger-left-open-hand-to"
            variant="capsule"
          />
          {takeUnavailable ? (
            // A disabled button takes no pointer events: the reason's tooltip
            // hangs on its wrapper.
            <Tooltip label={disabledReason}>{takeButton}</Tooltip>
          ) : (
            takeButton
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pendingAction !== null}
            data-testid="ledger-left-open-close"
            onClick={() => {
              void runAction('close', close);
            }}
          >
            Close
          </Button>
        </div>
        <ErrorBanner
          errorSource="ledger-left-open-error"
          className=""
          error={failure}
          testId="ledger-left-open-error"
        />
      </div>
    </Surface>
  );
}
