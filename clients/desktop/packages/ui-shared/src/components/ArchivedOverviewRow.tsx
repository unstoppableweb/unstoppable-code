'use client';

import { ListRowFrame } from '../primitives/ListRow';
import { archivedOverviewRowClassName } from '../primitives/control-button-shared';
export { ARCHIVED_ROW_ACTIONS_RESERVE_WIDE } from '../primitives/control-button-shared';
import { ControlButton } from '../primitives/Button';
import { useId, type JSX, type ReactNode } from 'react';
import { ArchivedStateIcon } from '../icons/ArchivedStateIcon';
import { LoadingSpinner } from '../primitives/LoadingSpinner';
import { HoverCard } from '../primitives/HoverCard';
import {
  getArchivedContainerStateLabel,
  type ArchivedContainerState,
} from '../lib/archived-state';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

/**
 * Container-query root for an "Archived and deleted" list. Rows inside it
 * keep their ⋯ menu always visible once the list is at least 36rem wide and
 * fall back to hover/focus reveal (always visible on touch) below that.
 */
export const ARCHIVED_LIST_CONTAINER_CLASS_NAME = '@container/archived-list';

// Literal class strings on purpose: Tailwind's scanner only sees classes it
// can read verbatim from source, so these must not be built from a template.
export const ARCHIVED_ROW_ACTIONS_VISIBLE_WIDE =
  '@min-[36rem]/archived-list:pointer-events-auto @min-[36rem]/archived-list:opacity-100';

export interface ArchivedOverviewRowProps {
  state: ArchivedContainerState;
  title: string;
  /** Native tooltip on the title; defaults to the title itself. */
  titleTooltip?: string;
  /** Rich tooltip content for the state icon (label plus retention rule). */
  stateTooltip: ReactNode;
  stateTooltipTestId?: string;
  stateTestId?: string;
  /** A lifecycle request is in flight: a spinner stands in for the icon. */
  busy?: boolean;
  /** Host-specific indicators rendered between the title and the date. */
  trailing?: ReactNode;
  /**
   * The entry's sealed observed cost, already formatted by a host that has
   * cost (this row imports no cost code). Absent shows nothing.
   */
  observedCostLabel?: string;
  date: string;
  dateTooltip?: string;
  /** When set, the row body is a button that opens the item. */
  onOpen?: () => void;
  openTestId?: string;
  /** The row's action controls, usually `ArchivedRowActionsMenu`. */
  actions: ReactNode;
  testId?: string;
}

export interface OverviewListRowProps {
  /** The row's leading glyph, before the title. */
  leading: ReactNode;
  title: string;
  /** Native tooltip on the title; defaults to the title itself. */
  titleTooltip?: string;
  /** Indicators rendered between the title and the date. */
  trailing?: ReactNode;
  date: string;
  dateTooltip?: string;
  /** When set, the row body is a button that opens the item. */
  onOpen?: () => void;
  openTestId?: string;
  /** The row's action controls, in the absolutely positioned trailing slot. */
  actions: ReactNode;
  /**
   * `reveal` (default) reserves room for a hover-revealed ⋯ menu. `inline`
   * always reserves room for a labeled button, which stays visible.
   */
  actionsReserve?: 'reveal' | 'inline';
  testId?: string;
  /** Mirrored to `data-state` on the row. */
  state?: string;
  busy?: boolean;
  /**
   * Read to screen readers as the open button's description, for detail a
   * pointer gets from a hover tooltip.
   */
  description?: ReactNode;
}

/**
 * Layout shell for one row of an overview list: leading glyph, truncated
 * title, optional indicators, a date, and an absolutely positioned action
 * slot. The body reserves room for that slot on hover, focus, wide
 * containers, and touch layouts (where the trigger is always visible and
 * grows to a 44px target).
 */
export function OverviewListRow({
  leading,
  title,
  titleTooltip,
  trailing,
  date,
  dateTooltip,
  onOpen,
  openTestId,
  actions,
  actionsReserve = 'reveal',
  testId,
  state,
  busy = false,
  description,
}: OverviewListRowProps): JSX.Element {
  const descriptionId = useId();
  const described =
    onOpen !== undefined &&
    description !== undefined &&
    description !== null &&
    description !== false;
  const bodyClassName = archivedOverviewRowClassName(actionsReserve);
  const body = (
    <>
      {leading}
      <span
        className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate text-xs leading-snug fg-primary/75`}
        title={titleTooltip ?? title}
      >
        {title}
      </span>
      {trailing}
      <span
        className="shrink-0 text-2xs tabular-nums fg-secondary"
        title={dateTooltip}
      >
        {date}
      </span>
    </>
  );
  return (
    <ListRowFrame
      layout="archive-overview"
      data-testid={testId}
      data-state={state}
      aria-busy={busy ? 'true' : undefined}
    >
      {onOpen ? (
        <ControlButton
          type="button"
          data-testid={openTestId}
          onClick={onOpen}
          aria-describedby={described ? descriptionId : undefined}
          presentation="archived-overview-row"
          appearance={{ actionsReserve }}
        >
          {body}
        </ControlButton>
      ) : (
        <div className={bodyClassName}>{body}</div>
      )}
      {described ? (
        <span id={descriptionId} hidden>
          {description}
        </span>
      ) : null}
      <span className="absolute inset-y-0 right-1 flex items-center">
        {actions}
      </span>
    </ListRowFrame>
  );
}

/**
 * One retained item in an "Archived and deleted" overview, shared by the
 * desktop and web surfaces: state icon with its retention tooltip, truncated
 * title, optional host indicators, the state date, and the action slot, on
 * the {@link OverviewListRow} shell.
 */
export function ArchivedOverviewRow({
  state,
  title,
  titleTooltip,
  stateTooltip,
  stateTooltipTestId,
  stateTestId,
  busy = false,
  trailing,
  observedCostLabel,
  date,
  dateTooltip,
  onOpen,
  openTestId,
  actions,
  testId,
}: ArchivedOverviewRowProps): JSX.Element {
  const stateLabel = getArchivedContainerStateLabel(state);
  return (
    <OverviewListRow
      leading={
        busy ? (
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <LoadingSpinner tone="secondary" decorative />
          </span>
        ) : (
          <HoverCard
            dataTestId={stateTooltipTestId}
            surfaceClassName="min-w-55 max-w-80"
            surfacePadding="card"
            content={stateTooltip}
          >
            <span
              data-testid={stateTestId}
              data-state={state}
              aria-label={stateLabel}
              role="img"
              className="flex shrink-0 items-center"
            >
              <ArchivedStateIcon state={state} />
            </span>
          </HoverCard>
        )
      }
      title={title}
      titleTooltip={titleTooltip}
      trailing={
        <>
          {observedCostLabel !== undefined ? (
            <span
              data-testid="archived-overview-row-cost"
              className="shrink-0 text-2xs tabular-nums fg-secondary"
            >
              <span className="sr-only">Observed cost </span>
              {observedCostLabel}
            </span>
          ) : null}
          {trailing}
        </>
      }
      date={date}
      dateTooltip={dateTooltip}
      onOpen={onOpen}
      openTestId={openTestId}
      actions={actions}
      testId={testId}
      state={state}
      busy={busy}
      description={busy ? undefined : stateTooltip}
    />
  );
}
