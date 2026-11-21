'use client';

import { SPACE_ROLE_GAP_CLASS, Stack, type SpaceRole } from '../Stack';
import {
  useRef,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Heading } from '../Heading';
import { NoticeShapeProvider } from '../Notice';
import { SETTINGS_GROUP_CLASS } from './SettingsCard';

/**
 * The Settings row kit, the one copy desktop and web render: a section is a
 * text-only heading over one grouped box, and each row is a label and a
 * one-line hint on the leading side with one control on the trailing side.
 * Desktop's `SettingsLayout` (`SettingsSection`, `SettingsGroup`,
 * `SettingsRow`, `SettingsSubRow`) renders these, and so do the shared
 * project settings dialog and the Code Graph summary.
 *
 * A row's control moves under its label only on a phone-width screen; in the
 * settings column it always keeps the trailing side.
 */

export interface SettingsRowsSectionProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** Id for the heading, so the section is named by it. */
  readonly headingId?: string;
  readonly ariaLabel?: string;
  readonly dataTestId?: string;
  /**
   * Grow to fill the rest of a flex column whose height its host sets, such
   * as a full-height page, and pass that height on to a `fill` group. Off by
   * default. The section never shrinks below its content's minimum, so a
   * short page scrolls instead of clipping it; see {@link FILL_CLASS}.
   */
  readonly fill?: boolean;
  /**
   * One quiet line under the section's box, such as a note on how the data
   * the rows control is handled or a link to read more. Text only; an action
   * still lives in a row.
   */
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
}

/**
 * Grows into the remaining height of a flex column its host sizes. The zero
 * basis (not `flex-1`'s `0%`, which an indefinite height reads as the content
 * height) keeps a scrolling list inside from counting its full length toward
 * the minimum: the minimum is the heading and the `fill` group's own minimum.
 */
const FILL_CLASS = 'grow basis-0';

/**
 * One group of related settings: the heading sits over the section's box,
 * on the box's outer left edge, and whitespace alone separates sections.
 * The heading holds only text; every action lives in a row inside the box.
 */
export function SettingsRowsSection({
  title,
  description,
  headingId,
  ariaLabel,
  dataTestId,
  fill = false,
  footer,
  children,
}: SettingsRowsSectionProps): JSX.Element {
  return (
    <section
      className={
        fill ? `flex flex-col gap-3 ${FILL_CLASS}` : 'flex flex-col gap-3'
      }
      aria-labelledby={title && headingId ? headingId : undefined}
      aria-label={ariaLabel}
      data-testid={dataTestId}
    >
      {title || description ? (
        <Stack gap="tight">
          {title ? (
            <Heading level={2} variant="section" id={headingId}>
              {title}
            </Heading>
          ) : null}
          {description ? (
            <div className="text-xs text-pretty fg-secondary">
              {description}
            </div>
          ) : null}
        </Stack>
      ) : null}
      {children}
      {footer ? (
        <div className="text-xs text-pretty fg-secondary">{footer}</div>
      ) : null}
    </section>
  );
}

export interface SettingsRowsGroupProps {
  readonly dataTestId?: string;
  /** Names the box as a group for assistive technology. */
  readonly ariaLabel?: string;
  /**
   * Dims and blocks the rows while a parent setting turns them off. The box
   * is `inert`, so the keyboard cannot reach or flip a control in it either.
   */
  readonly disabled?: boolean;
  /**
   * `box` groups the rows in the settings box, as on a Settings page.
   * `plain` is rows separated by hairlines with no box, for a surface that
   * is already a card, such as a dialog.
   * `list` is rows separated by hairlines with no box and no padding around
   * each row, so every row is its own 40px line: a list of figures in a
   * panel, sheet or popover (cost and usage rows, design call 1C,
   * 2026-10-31).
   */
  readonly surface?: 'box' | 'plain' | 'list';
  /**
   * Host-owned replay marker for rows that render user content, such as
   * instruction text. The heading above the box stays recorded. Set it from
   * mount; a recorder ignores a block class added to an element it has
   * already recorded. It never changes how the box looks.
   */
  readonly replayPrivacy?: { readonly blockClassName: string };
  /**
   * Take a `fill` section's remaining height for a scrolling list, while
   * the box ends at its last row, so a short list leaves the space under
   * the box empty. Off by default. The group must hold a scrolling child
   * with the `settings-fill-list` utility, which grows up to its rows'
   * height, before a last child that does not shrink, such as an action
   * footer. When the rows outgrow the space they scroll inside the box and
   * the footer stays in view. See {@link FILL_BOX_CLASS}.
   */
  readonly fill?: boolean;
  readonly children?: ReactNode;
}

const PLAIN_GROUP_CLASS = 'flex flex-col divide-y *:py-3';
const LIST_GROUP_CLASS = 'flex flex-col divide-y';

/**
 * A `fill` box. The box itself grows into the section, so its minimum stays
 * the list's minimum plus the footer's real height (see {@link FILL_CLASS}),
 * but only the list grows inside it, up to its rows. The box's surface,
 * the one {@link SETTINGS_GROUP_CLASS} draws, is a layer behind the rows
 * that ends at the last child's bottom edge (`settings-fill-box` in the
 * shared tokens stylesheet), so the unused height under the footer stays
 * transparent.
 */
const FILL_BOX_CLASS = `settings-fill-box flex flex-col divide-y px-4 *:py-3 ${FILL_CLASS} before:rounded-lg before:bg-secondary before:ring-[length:var(--border-hairline)] before:ring-line-base`;

/**
 * The box a section's rows live in: the shared settings group (the secondary
 * surface with a hairline edge). Every direct child is one row: it gets the
 * row's vertical padding, and an inset hairline splits it from the row above.
 */
export function SettingsRowsGroup({
  dataTestId,
  ariaLabel,
  disabled,
  surface = 'box',
  replayPrivacy,
  fill = false,
  children,
}: SettingsRowsGroupProps): JSX.Element {
  const surfaceClass =
    surface === 'list'
      ? fill
        ? `${LIST_GROUP_CLASS} ${FILL_CLASS}`
        : LIST_GROUP_CLASS
      : surface === 'plain'
        ? fill
          ? `${PLAIN_GROUP_CLASS} ${FILL_CLASS}`
          : PLAIN_GROUP_CLASS
        : fill
          ? FILL_BOX_CLASS
          : SETTINGS_GROUP_CLASS;
  const replayClass = replayPrivacy ? `${replayPrivacy.blockClassName} ` : '';
  const disabledClass = disabled ? ' pointer-events-none opacity-50' : '';
  return (
    <div
      role={ariaLabel ? 'group' : undefined}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      inert={disabled}
      data-testid={dataTestId}
      data-surface={surface}
      className={`${replayClass}${surfaceClass}${disabledClass}`}
    >
      {/* A notice inside a row is part of that row's content, not a card.
          Always mounted, so toggling a notice keeps the rows' state. */}
      <NoticeShapeProvider shape="default">{children}</NoticeShapeProvider>
    </div>
  );
}

/**
 * Targets in a row's text that keep their own click: controls, links, labels
 * that already name a control, and the code values settings text leaves
 * selectable.
 */
const ROW_TEXT_OWN_CLICK_SELECTOR =
  'a, button, input, select, textarea, label[for], [role="button"], [role="link"], code, pre, .font-mono';

const ROW_TOGGLE_SELECTOR = '[role="switch"], input[type="checkbox"]';

/**
 * Settings text is not selectable, so a click on a row's label or
 * explanation flips the row's switch, as if it had landed on the switch. Only
 * a row with exactly one switch or checkbox does this; with more, a click on
 * the text could mean either.
 */
export function useRowToggleClick(): {
  readonly controlRef: RefObject<HTMLDivElement | null>;
  readonly onRowClick: (event: MouseEvent<HTMLDivElement>) => void;
} {
  const controlRef = useRef<HTMLDivElement>(null);
  const onRowClick = (event: MouseEvent<HTMLDivElement>): void => {
    const control = controlRef.current;
    const target = event.target;
    if (!control || !(target instanceof Element) || control.contains(target)) {
      return;
    }
    // A double or triple click repeats the first press, and a click that ends
    // a drag-select is selecting text, not asking for the switch.
    const selection = target.ownerDocument.defaultView?.getSelection();
    if (event.detail > 1 || (selection && !selection.isCollapsed)) {
      return;
    }
    const ownClickTarget = target.closest(ROW_TEXT_OWN_CLICK_SELECTOR);
    if (ownClickTarget && event.currentTarget.contains(ownClickTarget)) {
      return;
    }
    const toggles = control.querySelectorAll<HTMLElement>(ROW_TOGGLE_SELECTOR);
    const toggle = toggles.length === 1 ? toggles[0] : undefined;
    if (
      !toggle ||
      toggle.matches(':disabled') ||
      toggle.getAttribute('aria-disabled') === 'true'
    ) {
      return;
    }
    toggle.click();
  };
  return { controlRef, onRowClick };
}

export interface SettingsRowsRowProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** The row's control, aligned to the trailing edge. */
  readonly control?: ReactNode;
  /** Id of the control the label names, so clicking the label activates it. */
  readonly htmlFor?: string;
  readonly labelId?: string;
  readonly dataTestId?: string;
  /**
   * A fact rather than a setting: the label keeps its own width and the
   * value takes the rest of the row, wrapping on the trailing edge, so a
   * long value never runs into its label. Detail pages set it on every row
   * whose control is a `SettingsRowsValue`.
   */
  readonly fact?: boolean;
  /**
   * Content under the label that belongs to this row: an editor, a status
   * line, or `SettingsRowsSubRow`s for settings that depend on this one.
   */
  readonly children?: ReactNode;
  /** Space before and between the row's child blocks; callers add no margins. */
  readonly contentGap?: SpaceRole;
}

interface RowLineProps extends SettingsRowsRowProps {
  readonly labelClassName: string;
  readonly gapClassName: string;
  /** Marks a top-level row's label; a sub-row's label is not a row label. */
  readonly rowLabel: boolean;
}

function RowLine({
  label,
  description,
  control,
  htmlFor,
  labelId,
  dataTestId,
  fact = false,
  children,
  labelClassName,
  gapClassName,
  rowLabel,
}: RowLineProps): JSX.Element {
  const { controlRef, onRowClick } = useRowToggleClick();
  const rowLabelMarker = rowLabel ? '' : undefined;
  return (
    <div className={`flex flex-col ${gapClassName}`} data-testid={dataTestId}>
      {/* The control moves under its label only on a phone-width screen. */}
      <div
        className="flex min-h-10 items-center justify-between gap-x-6 gap-y-2 max-sm:flex-wrap"
        onClick={onRowClick}
      >
        <div
          className={
            fact
              ? 'shrink-0 flex flex-col gap-0.5'
              : 'min-w-0 flex-1 flex flex-col gap-0.5 max-sm:min-w-[min(100%,12rem)]'
          }
        >
          {htmlFor ? (
            <label
              id={labelId}
              htmlFor={htmlFor}
              className={labelClassName}
              data-settings-row-label={rowLabelMarker}
            >
              {label}
            </label>
          ) : (
            <div
              id={labelId}
              className={labelClassName}
              data-settings-row-label={rowLabelMarker}
            >
              {label}
            </div>
          )}
          {description ? (
            <div className="text-xs text-pretty fg-secondary">
              {description}
            </div>
          ) : null}
        </div>
        {control ? (
          <div
            ref={controlRef}
            className={
              fact
                ? 'flex min-w-0 flex-1 items-center justify-end gap-2'
                : 'flex max-w-full shrink-0 items-center gap-2'
            }
          >
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/**
 * One setting: its label and explanation on the leading side, its control on
 * the trailing side. The label keeps the primary ink at the heavier weight;
 * the explanation takes the secondary ink.
 */
export function SettingsRowsRow(props: SettingsRowsRowProps): JSX.Element {
  return (
    <RowLine
      {...props}
      labelClassName="block text-s font-medium fg-primary"
      gapClassName={SPACE_ROLE_GAP_CLASS[props.contentGap ?? 'item']}
      rowLabel
    />
  );
}

export interface SettingsRowsValueProps {
  readonly dataTestId?: string;
  /** Tabular figures for counts, amounts and times. */
  readonly numeric?: boolean;
  /** A monospaced value (a key, a path, a score); breaks anywhere. */
  readonly mono?: boolean;
  /** Full value on hover. */
  readonly title?: string;
  readonly children?: ReactNode;
}

/**
 * A fact's value in a row's `control` slot: body text in the secondary ink,
 * on the trailing edge, wrapping long words. Pair it with the row's `fact`
 * layout so the value, not the label, gives way in a narrow column. Detail
 * pages show their facts as rows with this value (docs/design/pages.md).
 */
export function SettingsRowsValue({
  dataTestId,
  numeric = false,
  mono = false,
  title,
  children,
}: SettingsRowsValueProps): JSX.Element {
  return (
    <span
      className={`min-w-0 text-right text-s fg-secondary${mono ? ' break-all font-mono' : ' break-words'}${numeric ? ' tabular-nums' : ''}`}
      data-testid={dataTestId}
      title={title}
    >
      {children}
    </span>
  );
}

export type SettingsRowsSubRowProps = Omit<SettingsRowsRowProps, 'labelId'>;

/**
 * A setting that depends on the row it sits in, such as the maximum behind a
 * "Limit…" switch. It goes in the parent row's children, so no hairline
 * splits it from its parent; its label takes the regular weight so the parent
 * stays the row's heading.
 */
export function SettingsRowsSubRow(
  props: SettingsRowsSubRowProps,
): JSX.Element {
  return (
    <RowLine
      {...props}
      labelClassName="block text-s fg-primary"
      gapClassName={SPACE_ROLE_GAP_CLASS[props.contentGap ?? 'inline']}
      rowLabel={false}
    />
  );
}
