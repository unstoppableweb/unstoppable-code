'use client';

import { Fragment, isValidElement, type JSX, type ReactNode } from 'react';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  DropdownMenuRowStyleProvider,
  QUIET_MENU_ROW_STYLE,
  useDropdownMenuRowStyle,
} from './DropdownMenu';
import { NestedMenuFlyout } from './NestedMenuFlyout';
import { RichHoverTooltip } from './RichHoverTooltip';
import {
  SpaceNotificationMenuStatusLine,
  type SpaceNotificationMenuStatus,
} from './SpaceNotificationMenu';

interface ActionMenuItemBase<K extends string> {
  readonly key: K;
  readonly label: string;
  /**
   * Every row leads with an icon, so the labels line up down the menu. A run
   * of similar rows in one group (Close, Close others, Close to the right)
   * shares one icon: rows that repeat the icon above them leave the slot
   * empty, so only the first row of the run shows it.
   */
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly tooltip?: string;
  readonly richTooltip?: ReactNode;
  readonly richTooltipTestId?: string;
  readonly tone?: 'default' | 'destructive';
  /** Starts a new group: a hairline divider is drawn above this row. */
  readonly separatorBefore?: boolean;
  readonly testId?: string;
  /**
   * The gesture that does the same thing without the menu, shown after the
   * label (Select's `⌘ Click`), so the menu teaches the shortcut.
   */
  readonly shortcut?: string;
  /**
   * A single choice within a group: announced as a radio with `checked`, and
   * selecting it leaves the menu open so the group can show the outcome.
   */
  readonly role?: 'menuitem' | 'menuitemradio';
  readonly checked?: boolean;
  /** Work started by this row is in flight; announced via `aria-busy`. */
  readonly busy?: boolean;
  /** Heading rendered above this row, opening a labelled group of rows. */
  readonly sectionLabel?: string;
  /** One status line rendered beneath this row, closing its group. */
  readonly sectionStatus?: SpaceNotificationMenuStatus;
  readonly sectionStatusTestId?: string;
}

/**
 * One row of an action menu: the shared recipe behind the sidebar worktree
 * menu and every other right-click or "…" menu. A leading icon on each row,
 * groups split by `separatorBefore`, submenus that open beside their row with
 * a trailing chevron, and removal rows in their own group at the bottom.
 */
export type ActionMenuItem<K extends string = string> = ActionMenuItemBase<K> &
  (
    | {
        readonly kind?: 'action';
        readonly onSelect?: () => void;
        readonly submenu?: never;
      }
    | {
        readonly kind: 'submenu';
        readonly submenu: readonly ActionMenuItem<K>[];
        readonly onSelect?: never;
      }
    | {
        readonly kind: 'label';
        readonly onSelect?: never;
        readonly submenu?: never;
      }
  );

function isPropsRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function sameIcon(a: ReactNode, b: ReactNode): boolean {
  if (!isValidElement(a) || !isValidElement(b) || a.type !== b.type) {
    return false;
  }
  const aProps = isPropsRecord(a.props) ? a.props : {};
  const bProps = isPropsRecord(b.props) ? b.props : {};
  const aKeys = Object.keys(aProps);
  return (
    aKeys.length === Object.keys(bProps).length &&
    aKeys.every((key) => Object.is(aProps[key], bProps[key]))
  );
}

/**
 * The icon a row shows: none when it continues a run of rows with the same
 * icon in its group, so a family of similar actions reads as one. The empty
 * slot keeps its width, so the labels stay aligned with the first row's.
 */
export function actionMenuRowIcon<K extends string>(
  items: readonly ActionMenuItem<K>[],
  index: number,
): ReactNode {
  const item = items[index];
  if (!item) return null;
  const previous = items[index - 1];
  const continuesRun =
    previous !== undefined &&
    previous.kind !== 'label' &&
    item.kind !== 'label' &&
    item.separatorBefore !== true &&
    item.sectionLabel === undefined &&
    sameIcon(previous.icon, item.icon);
  return continuesRun ? null : item.icon;
}

/**
 * The row style every action menu uses, on every host: the sidebar worktree
 * menu's quiet rows (small text, tertiary icons), so the labels lead, as
 * DESIGN.md asks of supporting glyphs.
 */
export function ActionMenuRowStyle({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
      {children}
    </DropdownMenuRowStyleProvider>
  );
}

/**
 * A row's shortcut hint: plain trailing glyphs in the quietest menu ink, as
 * native menus draw them (no key caps in a menu row).
 */
export function ActionMenuShortcut({
  shortcut,
}: {
  readonly shortcut: string | undefined;
}): JSX.Element | null {
  if (shortcut === undefined) return null;
  return (
    <span
      className="ml-auto shrink-0 whitespace-nowrap pl-4 text-xs tabular-nums fg-quaternary"
      data-testid="worktree-menu-item-shortcut"
    >
      {shortcut}
    </span>
  );
}

/** A non-interactive label row, in the menu's row text style. */
export function ActionMenuLabelRow({ label }: { label: string }): JSX.Element {
  const rowStyle = useDropdownMenuRowStyle();
  return (
    <div
      className={`px-2 py-1 ${rowStyle.textStyle === 'small' ? 'text-xs' : 'text-s'} fg-tertiary`}
    >
      {label}
    </div>
  );
}

/** Wraps a menu row in its hover card when the item supplies one. */
export function ActionMenuRichTooltip<K extends string>({
  item,
  children,
}: {
  item: ActionMenuItem<K>;
  children: JSX.Element;
}): JSX.Element {
  if (!item.richTooltip) return children;
  return (
    <RichHoverTooltip
      content={item.richTooltip}
      dataTestId={item.richTooltipTestId}
      preferRightPlacement
      triggerWrapperClassName="w-full"
    >
      {children}
    </RichHoverTooltip>
  );
}

/** Renders action menu rows inside any menu surface or submenu. */
export function ActionMenuItems<K extends string>({
  items,
  onSelect,
}: {
  items: readonly ActionMenuItem<K>[];
  onSelect: (item: ActionMenuItem<K>) => void;
}): JSX.Element {
  return (
    <>
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {item.separatorBefore && <DropdownMenuDivider />}
          {item.sectionLabel !== undefined && (
            <DropdownMenuLabel>{item.sectionLabel}</DropdownMenuLabel>
          )}
          {item.kind === 'label' ? (
            <ActionMenuLabelRow label={item.label} />
          ) : item.kind === 'submenu' ? (
            <NestedMenuFlyout
              label={item.label}
              leading={actionMenuRowIcon(items, index)}
              disabled={item.disabled}
              triggerTestId={item.testId ?? item.key}
              menuTestId={`${item.testId ?? item.key}-menu`}
            >
              <ActionMenuItems items={item.submenu} onSelect={onSelect} />
            </NestedMenuFlyout>
          ) : (
            // A row folded into a submenu (Split PR in More) keeps the hover
            // card that explains why it is disabled, as top-level rows do.
            <ActionMenuRichTooltip item={item}>
              <DropdownMenuItem
                disabled={item.disabled}
                title={item.tooltip}
                tone={item.tone}
                data-testid={item.testId}
                role={item.role}
                aria-checked={
                  item.role === 'menuitemradio'
                    ? item.checked === true
                    : undefined
                }
                aria-busy={item.busy === true ? true : undefined}
                onClick={(event): void => {
                  event.preventDefault();
                  onSelect(item);
                }}
              >
                <DropdownMenuItemIcon>
                  {actionMenuRowIcon(items, index)}
                </DropdownMenuItemIcon>
                {item.label}
                <ActionMenuShortcut shortcut={item.shortcut} />
              </DropdownMenuItem>
            </ActionMenuRichTooltip>
          )}
          {item.sectionStatus && (
            <SpaceNotificationMenuStatusLine
              status={item.sectionStatus}
              testId={item.sectionStatusTestId}
            />
          )}
        </Fragment>
      ))}
    </>
  );
}
