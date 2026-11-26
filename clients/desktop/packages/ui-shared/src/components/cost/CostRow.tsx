import { costRowClasses } from '../../primitives/control-button-shared';
import { ControlButton } from '../../primitives/Button';
import { useId, type JSX, type ReactNode } from 'react';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import { ArchivedStateIcon } from '../../icons/ArchivedStateIcon';
import { ThinkingSpinner } from '../../primitives/ThinkingSpinner';
import { CostSplitBar } from './CostSplitBar';
import type { CostSegment } from './cost-format';

export interface CostRowProps {
  /** The chat's name or the pipeline's name; truncated visually, full in the accessible name and a title tooltip. */
  readonly name: string;
  /**
   * The name is a user-written title, such as a chat's. Session replay then
   * masks its text, and the name is kept out of every recorded attribute: no
   * title tooltip, and the accessible name points at the masked text.
   */
  readonly maskName?: boolean;
  readonly archived?: boolean;
  /** Shows the running spinner (ThinkingSpinner sizePx 12, tone accent). Ignored when archived is also set? No: running wins visually only if not archived; archived chats are never running. */
  readonly running?: boolean;
  /** A run's start (`Today 9:12 AM`), shown after the name at `panel` density only. */
  readonly startedLabel?: string;
  /** The formatted total (`$3.10`, `$0.00`, `Not priced`). */
  readonly amountLabel: string;
  readonly segments: readonly CostSegment[];
  /** The bar's filled length 0..1 (costBarScale(rowTotal, scaleMax)). */
  readonly scale: number;
  readonly density?: 'card' | 'panel';
  /** Marks the selected row (`aria-current="true"`, subtle background). */
  readonly selected?: boolean;
  /** When set the row is a button; without it the row is static (no button, not focusable). */
  readonly onOpen?: () => void;
  /** Quieter name ink, for the `Not tied to a chat` row. */
  readonly muted?: boolean;
  readonly testId?: string;
}

function CostRowMarker({
  archived,
  running,
  labelId,
}: {
  readonly archived: boolean;
  readonly running: boolean;
  readonly labelId: string;
}): JSX.Element | null {
  if (archived) {
    return (
      <span className="inline-flex shrink-0 items-center">
        <ArchivedStateIcon state="archived" size="sm" />
        <span id={labelId} className="sr-only">
          Archived
        </span>
      </span>
    );
  }
  if (running) {
    return (
      <span className="inline-flex shrink-0 items-center">
        <span aria-hidden="true">
          <ThinkingSpinner sizePx={12} tone="accent" />
        </span>
        <span id={labelId} className="sr-only">
          Running
        </span>
      </span>
    );
  }
  return null;
}

/** The ids the row's parts carry, so a masked row can be named by them. */
interface CostRowPartIds {
  readonly name: string;
  readonly state: string;
  readonly amount: string;
}

function CostRowContents({
  name,
  archived,
  running,
  startedLabel,
  amountLabel,
  segments,
  scale,
  density,
  muted,
  maskName,
  ids,
}: Required<
  Pick<
    CostRowProps,
    | 'name'
    | 'archived'
    | 'running'
    | 'amountLabel'
    | 'segments'
    | 'scale'
    | 'density'
    | 'muted'
    | 'maskName'
  >
> &
  Pick<CostRowProps, 'startedLabel'> & {
    readonly ids: CostRowPartIds;
  }): JSX.Element {
  const marker = (
    <CostRowMarker archived={archived} running={running} labelId={ids.state} />
  );
  const start =
    startedLabel !== undefined && density === 'panel' ? (
      <span className="shrink-0 fg-tertiary">{startedLabel}</span>
    ) : null;

  return (
    <>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-xs">
        <span
          id={ids.name}
          {...(maskName ? {} : { title: name })}
          className={`${maskName ? `${REPLAY_MASK_CLASS} ` : ''}min-w-0 truncate ${muted ? 'fg-secondary' : 'fg-primary'}`}
        >
          {name}
        </span>
        {marker}
        {start}
        <span
          id={ids.amount}
          className="ml-auto shrink-0 pl-2 tabular-nums fg-secondary"
        >
          {amountLabel}
        </span>
      </span>
      <CostSplitBar
        segments={segments}
        label={maskName ? 'Cost' : `${name} cost`}
        scale={scale}
      />
    </>
  );
}

export function CostRow({
  name,
  archived = false,
  running = false,
  startedLabel,
  amountLabel,
  segments,
  scale,
  density = 'panel',
  selected = false,
  onOpen,
  muted = false,
  maskName = false,
  testId,
}: CostRowProps): JSX.Element {
  const idPrefix = useId();
  const ids: CostRowPartIds = {
    name: `${idPrefix}-name`,
    state: `${idPrefix}-state`,
    amount: `${idPrefix}-amount`,
  };
  const activeState = archived ? 'archived' : running ? 'running' : null;
  const accessibleName = activeState
    ? `${name}, ${activeState}, ${amountLabel}`
    : `${name}, ${amountLabel}`;
  // A masked name must not be copied into `aria-label`, which replay records.
  const naming = maskName
    ? {
        'aria-labelledby': [
          ids.name,
          ...(activeState ? [ids.state] : []),
          ids.amount,
        ].join(' '),
      }
    : { 'aria-label': accessibleName };
  const content: ReactNode = (
    <CostRowContents
      name={name}
      archived={archived}
      running={running}
      startedLabel={startedLabel}
      amountLabel={amountLabel}
      segments={segments}
      scale={scale}
      density={density}
      muted={muted}
      maskName={maskName}
      ids={ids}
    />
  );

  if (onOpen !== undefined) {
    return (
      <ControlButton
        type="button"
        onClick={onOpen}
        {...naming}
        aria-current={selected ? 'true' : undefined}
        data-testid={testId}
        presentation="cost-row-open"
        appearance={{ density, selected }}
      >
        {content}
      </ControlButton>
    );
  }

  return (
    <div
      aria-current={selected ? 'true' : undefined}
      data-testid={testId}
      className={costRowClasses(density, selected, false)}
    >
      {content}
    </div>
  );
}
