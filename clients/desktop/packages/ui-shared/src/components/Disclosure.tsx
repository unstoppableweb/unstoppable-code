'use client';

import {
  forwardRef,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import {
  ChevronDownIcon,
  ChevronDownMediumIcon,
  ChevronRightMediumIcon,
} from '../icons/AppIcons';
import { Button, isAriaDisabled, swallowUnavailableClick } from './Button';

/**
 * - `inline`: a quiet text toggle with the body under it (Advanced, Setup
 *   logs, Show details). Its chevron leads the label and turns down when
 *   open.
 * - `box`: a section in a hairline box whose title row opens it. Its chevron
 *   sits at the row's right edge and turns up when open (design call 2B,
 *   2026-11-01).
 */
export type DisclosureVariant = 'inline' | 'box';

export interface DisclosureProps {
  /** What the body holds, in sentence case (`Advanced`, `Setup logs`). */
  readonly label: ReactNode;
  readonly children?: ReactNode;
  readonly variant?: DisclosureVariant;
  /**
   * A non-default choice inside, named beside the closed label so closing
   * the disclosure never hides it (for example `Private memory on`).
   */
  readonly hint?: ReactNode;
  /** Quiet text at the end of a `box` title row (`3 sources`). */
  readonly meta?: ReactNode;
  /** A 12–16px mark after the chevron. Decorative: the label names it. */
  readonly leadingIcon?: ReactNode;
  /** Uncontrolled start state. */
  readonly defaultOpen?: boolean;
  /** Controlled state; pass `onOpenChange` with it. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Keep the body in the DOM while closed, hidden, so its state survives and
   * find-in-page reaches it. Off by default: a closed body is not rendered.
   */
  readonly keepMounted?: boolean;
  /** Root test id; the toggle and body append `-toggle` / `-body`. */
  readonly dataTestId?: string;
  /** Overrides the toggle's test id, for hosts whose specs key on their own. */
  readonly toggleTestId?: string;
  /** Placement only. The disclosure owns its own look. */
  readonly className?: string;
}

/**
 * The chevron's 16px slot. The medium chevron draws its glyph inside that
 * box, so the slot centers it in the same 16px column as a row's or card's
 * icon above or beside the toggle.
 */
const CHEVRON_SLOT_CLASS =
  'inline-flex size-4 shrink-0 items-center justify-center';

const CHEVRON_CLASS =
  'shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none';

const TOGGLE_CLASS: Readonly<Record<DisclosureVariant, string>> = {
  inline:
    'focus-ring inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pr-1 text-left text-xs font-medium fg-secondary hover:fg-primary',
  box: 'focus-ring flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left text-s font-medium fg-primary hover:bg-subtle',
};

const ROOT_CLASS: Readonly<Record<DisclosureVariant, string>> = {
  inline: 'flex min-w-0 flex-col gap-2',
  box: 'min-w-0 rounded-lg ring-[length:var(--border-hairline)] ring-line-base',
};

const BODY_CLASS: Readonly<Record<DisclosureVariant, string>> = {
  inline: 'flex min-w-0 flex-col gap-2',
  box: 'flex min-w-0 flex-col gap-2 px-4 pb-3',
};

/**
 * The one "show more" control on desktop and web: a toggle with a chevron
 * and the body it reveals. Only optional
 * or secondary content belongs inside; anything that blocks the surrounding
 * action stays outside, always visible.
 */
export function Disclosure({
  label,
  children,
  variant = 'inline',
  hint,
  meta,
  leadingIcon,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  keepMounted = false,
  dataTestId = 'disclosure',
  toggleTestId,
  className,
}: DisclosureProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = openProp ?? uncontrolledOpen;
  const bodyId = useId();
  const showBody = open || keepMounted;
  const toggle = (): void => {
    if (openProp === undefined) setUncontrolledOpen(!open);
    onOpenChange?.(!open);
  };
  return (
    <div
      className={
        className ? `${ROOT_CLASS[variant]} ${className}` : ROOT_CLASS[variant]
      }
      data-testid={dataTestId}
      data-state={open ? 'open' : 'closed'}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={showBody ? bodyId : undefined}
        data-testid={toggleTestId ?? `${dataTestId}-toggle`}
        className={TOGGLE_CLASS[variant]}
        onClick={toggle}
      >
        {variant === 'inline' ? (
          <span className={CHEVRON_SLOT_CLASS}>
            <ChevronRightMediumIcon
              size="md"
              aria-hidden="true"
              className={`${CHEVRON_CLASS}${open ? ' rotate-90' : ''}`}
            />
          </span>
        ) : null}
        {leadingIcon ? (
          <span aria-hidden="true" className="flex shrink-0 items-center">
            {leadingIcon}
          </span>
        ) : null}
        <span
          className={variant === 'box' ? 'min-w-0 flex-1 truncate' : 'min-w-0'}
        >
          {label}
          {!open && hint ? (
            <span className="font-normal fg-tertiary">
              {' · '}
              {hint}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span className="shrink-0 text-xs font-normal fg-tertiary">
            {meta}
          </span>
        ) : null}
        {variant === 'box' ? (
          <span className={CHEVRON_SLOT_CLASS}>
            <ChevronDownMediumIcon
              size="md"
              aria-hidden="true"
              className={`${CHEVRON_CLASS} fg-secondary${open ? ' rotate-180' : ''}`}
            />
          </span>
        ) : null}
      </button>
      {showBody ? (
        <div
          id={bodyId}
          hidden={!open}
          // A display class would override `hidden`, so a closed body has none.
          className={open ? BODY_CLASS[variant] : undefined}
          data-testid={`${dataTestId}-body`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface RailSectionHeaderFrameProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children'
> {
  readonly label: string;
  readonly resting?: boolean;
  readonly sticky?: boolean;
  readonly belowChats?: boolean;
  readonly kind: 'projects' | 'chats';
  readonly actions?: ReactNode;
  readonly expanded?: boolean;
  readonly returnToRows?: boolean;
  readonly touchTargets?: boolean;
  /** A host's sticky Chats band includes padding above the 32px label. */
  readonly labelSetsHeight?: boolean;
  readonly chevronTestId?: string;
  readonly toggleProps?: ButtonHTMLAttributes<HTMLButtonElement> &
    Record<`data-${string}`, string | undefined>;
}

/** The production Projects and Chats header, including disclosure geometry. */
export const RailSectionHeaderFrame = forwardRef<
  HTMLDivElement,
  RailSectionHeaderFrameProps
>(function RailSectionHeaderFrame(
  {
    label,
    kind,
    resting = false,
    sticky = true,
    belowChats = false,
    actions,
    expanded,
    returnToRows = false,
    touchTargets = false,
    labelSetsHeight = false,
    chevronTestId,
    toggleProps,
    className = '',
    ...attributes
  },
  ref,
): JSX.Element {
  const projects = kind === 'projects';
  const height = touchTargets ? 'min-h-11' : 'h-8';
  const labelContent = (
    <span
      className={
        projects
          ? 'shrink-0 translate-y-0.5 whitespace-nowrap'
          : 'min-w-0 truncate'
      }
    >
      {label}
    </span>
  );
  return (
    <div
      {...attributes}
      ref={ref}
      className={`group/rail-section group/section flex min-w-0 items-center gap-1 bg-sidebar px-1 ${projects ? 'sidebar-sticky-header group/workspaces z-10 shrink-0' : 'group/chats'} ${resting ? '' : 'group/sidebar-item'} ${sticky ? 'sticky' : ''} ${projects ? (belowChats ? (touchTargets ? 'top-11' : 'top-8') : 'top-0') : labelSetsHeight ? 'z-40 pt-3' : 'top-0 z-20'} ${labelSetsHeight ? '' : height} ${className}`}
    >
      {toggleProps ? (
        <button
          type="button"
          {...toggleProps}
          aria-expanded={returnToRows ? undefined : expanded}
          className={`focus-ring flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-s font-normal fg-quaternary transition-colors hover:fg-secondary group-focus-within/rail-section:fg-secondary ${height}`}
        >
          {labelContent}
          <ChevronDownMediumIcon
            data-testid={chevronTestId}
            size="md"
            className={`shrink-0 ${projects ? 'translate-y-0.5 ' : ''}transition-[transform,opacity] group-hover/rail-section:opacity-100 group-focus-within/rail-section:opacity-100 ${
              returnToRows
                ? 'rotate-180 opacity-100'
                : expanded === false
                  ? '-rotate-90 opacity-100'
                  : 'opacity-0'
            }`}
          />
        </button>
      ) : (
        <span
          className={`flex min-w-0 flex-1 items-center px-1 text-s font-normal fg-quaternary ${height}`}
        >
          {labelContent}
        </span>
      )}
      {actions}
    </div>
  );
});

export interface NativeDisclosureProps extends Pick<
  DisclosureProps,
  | 'label'
  | 'children'
  | 'variant'
  | 'hint'
  | 'meta'
  | 'leadingIcon'
  | 'defaultOpen'
  | 'dataTestId'
  | 'toggleTestId'
  | 'className'
> {
  /** A quiet explanation below the label that stays visible while closed. */
  readonly description?: ReactNode;
  readonly [attribute: `data-${string}`]: string | undefined;
}

/**
 * The native disclosure for public server-rendered content. Its summary and
 * body are present in the initial HTML and toggle without JavaScript. The
 * browser owns the open state; the existing Disclosure recipes own its look.
 */
export function NativeDisclosure({
  label,
  children,
  variant = 'inline',
  hint,
  meta,
  leadingIcon,
  defaultOpen = false,
  dataTestId = 'native-disclosure',
  toggleTestId,
  className = '',
  description,
  ...dataAttributes
}: NativeDisclosureProps): JSX.Element {
  const rotation =
    variant === 'inline'
      ? '[&[open]>summary>[data-disclosure-chevron]]:rotate-90'
      : '[&[open]>summary>[data-disclosure-chevron]]:rotate-180';
  const chevron = (
    <span
      aria-hidden="true"
      data-disclosure-chevron=""
      className={`${CHEVRON_SLOT_CLASS} ${CHEVRON_CLASS}`}
    >
      {variant === 'inline' ? (
        <ChevronRightMediumIcon size="md" aria-hidden="true" />
      ) : (
        <ChevronDownMediumIcon
          size="md"
          aria-hidden="true"
          className="fg-secondary"
        />
      )}
    </span>
  );
  return (
    <details
      {...dataAttributes}
      open={defaultOpen}
      data-testid={dataTestId}
      className={`${ROOT_CLASS[variant]} ${rotation} [&[open]>summary_[data-disclosure-hint]]:hidden ${className}`}
    >
      <summary
        data-testid={toggleTestId ?? `${dataTestId}-toggle`}
        className={`${TOGGLE_CLASS[variant]} list-none [&::-webkit-details-marker]:hidden`}
      >
        {variant === 'inline' ? chevron : null}
        {leadingIcon ? (
          <span aria-hidden="true" className="flex shrink-0 items-center">
            {leadingIcon}
          </span>
        ) : null}
        <span className={variant === 'box' ? 'min-w-0 flex-1' : 'min-w-0'}>
          {label}
          {hint ? (
            <span data-disclosure-hint="" className="font-normal fg-tertiary">
              {' · '}
              {hint}
            </span>
          ) : null}
          {description ? (
            <span className="mt-0.5 block text-xs font-normal text-pretty fg-secondary">
              {description}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span className="shrink-0 text-xs font-normal fg-tertiary">
            {meta}
          </span>
        ) : null}
        {variant === 'box' ? chevron : null}
      </summary>
      <div className={BODY_CLASS[variant]} data-testid={`${dataTestId}-body`}>
        {children}
      </div>
    </details>
  );
}

export type DisclosureChevronDirection = 'right' | 'down' | 'up';

const CHEVRON_DIRECTION_CLASS: Readonly<
  Record<DisclosureChevronDirection, string>
> = {
  right: '-rotate-90',
  down: '',
  up: 'rotate-180',
};

export interface DisclosureChevronProps {
  /**
   * Where it points. A hidden body that opens under its toggle reads `right`
   * then `down`; a detached body beside a value or action reads `down` then
   * `up`.
   */
  readonly direction: DisclosureChevronDirection;
  /**
   * `xs` is the 12px small glyph, for a toggle swapped in for a 12px icon.
   * `sm` is the 14px glyph of the subagents tree.
   */
  readonly size?: 'xs' | 'sm' | 'md';
  /** Turns over 150ms instead of snapping. */
  readonly animated?: boolean;
  readonly dataTestId?: string;
}

/** The chevron of a `DisclosureToggle`, placed by the row that holds it. */
export function DisclosureChevron({
  direction,
  size = 'md',
  animated = false,
  dataTestId,
}: DisclosureChevronProps): JSX.Element {
  const className = `${animated ? CHEVRON_CLASS : 'shrink-0'} ${CHEVRON_DIRECTION_CLASS[direction]}`;
  return size === 'xs' ? (
    <ChevronDownIcon
      size="xs"
      aria-hidden="true"
      data-testid={dataTestId}
      className={className}
    />
  ) : (
    <ChevronDownMediumIcon
      size={size === 'sm' ? 'sm' : 'md'}
      aria-hidden="true"
      data-testid={dataTestId}
      className={className}
    />
  );
}

/**
 * The toggle's frame where `Disclosure`'s own layout does not fit: the body
 * sits apart from the toggle, or the toggle is a row in a list.
 *
 * - `section-chats`, `section-workspaces`: a sidebar section header, lit by
 *   the header around it.
 * - `sidebar-group`: a sidebar item group's header.
 * - `sidebar-row`: a row at the foot of a sidebar list.
 * - `tree`: the 16px chevron column of a tree row. It stays 16px on a touch
 *   screen, so foldable rows keep the height and indent of their siblings;
 *   an overlay grows the hit area to 44px wide instead. It reaches 22px
 *   toward the indent and only 6px toward the row's content, so it stops at
 *   the 6px gap before the status glyph. Deliberate exception to the 44 × 44
 *   touch target in docs/design/principles.md: the row's cell clips the
 *   overlay to the 36px row height (44 × 36), because growing foldable rows
 *   would misalign them with their siblings.
 * - `tree-icon`: a row's icon that turns into the chevron on hover.
 * - `row`: a label and a value on one line, with the body further down.
 * - `usage-section`: a section label whose hit area covers its row, with
 *   independent actions and the chevron placed after it by the parent.
 * - `summary`, `summary-wrapping`: a card's title row, whose hit area
 *   stretches over the card; `summary-wrapping` gives the row to its actions
 *   below 32rem.
 */
export type DisclosureToggleVariant =
  | 'section-chats'
  | 'section-workspaces'
  | 'sidebar-group'
  | 'sidebar-row'
  | 'tree'
  | 'tree-icon'
  | 'row'
  | 'usage-section'
  | 'summary'
  | 'summary-wrapping';

const SECTION_TOGGLE_CLASS =
  'focus-ring flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-s font-normal fg-quaternary transition-colors hover:fg-secondary';

const SUMMARY_TOGGLE_CLASS =
  "focus-ring focus-ring-stretched before:absolute before:inset-0 before:rounded-lg before:content-[''] flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left text-s pointer-coarse:min-h-11";

const DISCLOSURE_TOGGLE_CLASS: Readonly<
  Record<DisclosureToggleVariant, string>
> = {
  'section-chats': `${SECTION_TOGGLE_CLASS} group-hover/chats:fg-secondary group-focus-within/chats:fg-secondary`,
  'section-workspaces': `${SECTION_TOGGLE_CLASS} group-hover/workspaces:fg-secondary group-focus-within/workspaces:fg-secondary`,
  'sidebar-group':
    'focus-ring flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded text-left text-s font-normal fg-quaternary hover:fg-secondary group-focus-within/sidebar-item:fg-secondary pointer-coarse:h-11',
  'sidebar-row':
    'focus-ring flex h-7 w-full items-center gap-1.5 rounded-row px-1.5 text-left text-s font-normal fg-tertiary hover:bg-subtle hover:fg-primary',
  tree: "focus-ring pointer-coarse:relative pointer-coarse:before:absolute pointer-coarse:before:-inset-y-3.5 pointer-coarse:before:-left-5.5 pointer-coarse:before:-right-1.5 pointer-coarse:before:content-[''] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm fg-secondary hover:fg-primary",
  'tree-icon':
    'focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11 flex rounded-sm fg-tertiary hover:fg-primary',
  row: 'group focus-ring flex items-center justify-between gap-3 rounded-sm text-left text-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11',
  'usage-section':
    "group peer focus-ring flex flex-1 items-center rounded-sm text-left text-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11 after:absolute after:inset-0 after:content-['']",
  summary: SUMMARY_TOGGLE_CLASS,
  'summary-wrapping': `${SUMMARY_TOGGLE_CLASS} basis-full @min-[32rem]/turn-files:basis-0`,
};

const SECTION_HEIGHT_CLASS = 'h-8';
const TOUCH_SECTION_HEIGHT_CLASS = 'min-h-11';

export interface DisclosureToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'style' | 'type' | 'aria-expanded' | 'aria-controls'
> {
  readonly variant: DisclosureToggleVariant;
  /**
   * Whether the body shows. `undefined` while the control is briefly not a
   * disclosure, so it announces no state it won't change.
   */
  readonly open: boolean | undefined;
  /** The body's id, when it is in the DOM. */
  readonly bodyId?: string;
  /** Raises a section header to the 44px touch minimum. */
  readonly touchTarget?: boolean;
  readonly children: ReactNode;
}

/**
 * The button of a disclosure whose body lives apart from it. It owns the
 * toggle's semantics and frame; the host owns the open state, the body and
 * what sits in the row. Use `Disclosure` whenever the body can follow the
 * toggle.
 */
export const DisclosureToggle = forwardRef<
  HTMLButtonElement,
  DisclosureToggleProps
>(function DisclosureToggle(
  { variant, open, bodyId, touchTarget = false, children, ...buttonProps },
  ref,
) {
  const unavailable =
    buttonProps.disabled === true ||
    isAriaDisabled(buttonProps['aria-disabled']);
  const sectionHeight =
    variant === 'section-chats' || variant === 'section-workspaces'
      ? ` ${touchTarget ? TOUCH_SECTION_HEIGHT_CLASS : SECTION_HEIGHT_CLASS}`
      : '';
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-expanded={open}
      aria-controls={bodyId}
      onClick={
        unavailable
          ? (event): void => {
              swallowUnavailableClick(event);
              event.stopPropagation();
            }
          : buttonProps.onClick
      }
      className={`${DISCLOSURE_TOGGLE_CLASS[variant]}${sectionHeight} disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-transparent aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:bg-transparent`}
    >
      {children}
    </button>
  );
});

export interface DisclosureButtonProps {
  /** Whether the list shows. */
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The list's summary while it is hidden, such as `3 globs enabled`. */
  readonly closedLabel: string;
  readonly openLabel: string;
  readonly dataTestId?: string;
}

/**
 * Shows or hides a list from the control slot of the list's header row, as a
 * compact button that says what it will do.
 */
export function DisclosureButton({
  open,
  onToggle,
  closedLabel,
  openLabel,
  dataTestId,
}: DisclosureButtonProps): JSX.Element {
  return (
    <Button
      size="compact"
      variant="secondary"
      onClick={onToggle}
      aria-expanded={open}
      data-testid={dataTestId}
    >
      {open ? openLabel : closedLabel}
      <ChevronDownIcon
        size="sm"
        className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
      />
    </Button>
  );
}
