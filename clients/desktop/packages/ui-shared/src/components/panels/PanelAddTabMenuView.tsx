'use client';

/**
 * PanelAddTabMenuView — the presentational half of the panel `+` add-tab
 * menu, extracted from the desktop `PanelAddTabMenu` (which keeps the
 * catalog building and New-Chat/New-Browser choreography).
 *
 * Uses the shared floating action-menu layer for owner-document portals,
 * collision/available-height placement, entry motion, immediate dismissal,
 * roving focus, and focus return to the `+` button. This component owns the
 * grouped list structure and fixed icon/text row geometry; its rows take the
 * shared action-menu row style (small text, tertiary icons).
 */
import {
  Fragment,
  useMemo,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ActionMenuRowStyle } from '../../primitives/ActionMenuItems';
import { MenuDivider, MenuItem, MenuItemIcon } from '../../primitives/MenuItem';
import { Menu } from '../../primitives/Menu';
import { NestedMenuFlyout } from '../../primitives/NestedMenuFlyout';
import { Tooltip } from '../../primitives/Tooltip';

export interface PanelAddTabMenuViewEntry {
  /** Optional React key when multiple rows intentionally share one test id. */
  readonly key?: string;
  readonly testId: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Optional content rendered after the label, such as a compact badge. */
  readonly accessory?: ReactNode;
  /** Optional tooltip applied to the full menu row. */
  readonly tooltip?: ReactNode;
  readonly onActivate: () => void;
  readonly disabled?: boolean;
  readonly ariaBusy?: boolean;
  /** Keep the menu open while an activation completes asynchronously. */
  readonly keepOpenOnActivate?: boolean;
}

export interface PanelAddTabMenuViewSubsection {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly PanelAddTabMenuViewEntry[];
}

export interface PanelAddTabMenuViewSection {
  /**
   * `'inline'` (default) renders a divider, a label, and the entries in the
   * main list. `'submenu'` renders ONE row that opens the entries in a nested
   * flyout anchored to it. `'row'` renders the entries (normally one) directly
   * after the divider, with no label, group wrapper, or flyout — a section of
   * its own that a single click acts on.
   */
  readonly presentation?: 'inline' | 'submenu' | 'row';
  /** Leading icon for the `'submenu'` row. */
  readonly icon?: ReactNode;
  /**
   * Stable section key — the caller's domain, not this component's. Used for
   * the React `key` and the `data-testid="panel-add-menu-${id}-divider"` /
   * `"panel-add-menu-${id}-group"` attributes (desktop passes `usage` and
   * `activity`; those testids are pinned by Electron specs).
   */
  readonly id: string;
  readonly label: string;
  /**
   * The section's rows. A section with no entry (and, for a submenu, no
   * subsection, header, or footer entry) is omitted with its divider.
   */
  readonly entries: readonly PanelAddTabMenuViewEntry[];
  /** Optional labeled groups rendered inside a submenu in the given order. */
  readonly subsections?: readonly PanelAddTabMenuViewSubsection[];
  /**
   * Actions pinned before submenu content, separated from it by a divider
   * (mirrors {@link footerEntries}). Without other content, no divider.
   */
  readonly headerEntries?: readonly PanelAddTabMenuViewEntry[];
  /** Divider-separated actions pinned after submenu content. */
  readonly footerEntries?: readonly PanelAddTabMenuViewEntry[];
}

export interface PanelAddTabMenuViewProps {
  anchor: HTMLElement;
  groupId: string;
  entries: readonly PanelAddTabMenuViewEntry[];
  sections: readonly PanelAddTabMenuViewSection[];
  onClose: () => void;
}

function MenuEntry({
  entry,
}: {
  readonly entry: PanelAddTabMenuViewEntry;
}): JSX.Element {
  const item = (
    <MenuItem
      className="min-w-0"
      data-testid={entry.testId}
      disabled={entry.disabled}
      aria-busy={entry.ariaBusy}
      onClick={(event: MouseEvent<HTMLButtonElement>): void => {
        if (entry.keepOpenOnActivate) event.preventDefault();
        entry.onActivate();
      }}
    >
      <MenuItemIcon data-testid={`${entry.testId}-icon`}>
        {entry.icon}
      </MenuItemIcon>
      <span
        data-testid={`${entry.testId}-label`}
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
      >
        {entry.label}
      </span>
      {entry.accessory}
    </MenuItem>
  );
  return entry.tooltip ? (
    <Tooltip label={entry.tooltip} className="w-full">
      {item}
    </Tooltip>
  ) : (
    item
  );
}

/**
 * One collapsed section: a row that opens its entries in a nested flyout
 * anchored to itself (kept open while the pointer is inside either surface).
 */
interface MenuSubmenuProps {
  readonly section: PanelAddTabMenuViewSection;
}

function MenuSubmenu({ section }: MenuSubmenuProps): JSX.Element {
  const visibleSubsections = (section.subsections ?? []).filter(
    (subsection) => subsection.entries.length > 0,
  );
  const headerEntries = section.headerEntries ?? [];
  const hasContent =
    visibleSubsections.length > 0 || section.entries.length > 0;

  return (
    <NestedMenuFlyout
      label={section.label}
      leading={section.icon}
      triggerTestId={`panel-add-menu-${section.id}-submenu`}
      menuTestId={`panel-add-menu-${section.id}-group`}
    >
      {headerEntries.map((entry) => (
        <MenuEntry key={entry.key ?? entry.testId} entry={entry} />
      ))}
      {headerEntries.length > 0 && hasContent ? <MenuDivider /> : null}
      {visibleSubsections.length > 0
        ? visibleSubsections.map((subsection, index) => (
            <Fragment key={subsection.id}>
              {index > 0 ? <MenuDivider /> : null}
              <div
                role="group"
                aria-label={subsection.label}
                data-testid={`panel-add-menu-${section.id}-${subsection.id}-group`}
              >
                <div
                  className="canopy-panel-chrome-menu-label"
                  aria-hidden="true"
                >
                  {subsection.label}
                </div>
                {subsection.entries.map((entry) => (
                  <MenuEntry key={entry.key ?? entry.testId} entry={entry} />
                ))}
              </div>
            </Fragment>
          ))
        : section.entries.map((entry) => (
            <MenuEntry key={entry.key ?? entry.testId} entry={entry} />
          ))}
      {(section.footerEntries?.length ?? 0) > 0 ? (
        <>
          <MenuDivider />
          {section.footerEntries?.map((entry) => (
            <MenuEntry key={entry.key ?? entry.testId} entry={entry} />
          ))}
        </>
      ) : null}
    </NestedMenuFlyout>
  );
}

/**
 * Whether a section renders at all: an entry, or — for a submenu, the only
 * presentation that shows them — a non-empty subsection or a pinned
 * header/footer entry. An empty section drops its divider too.
 */
function hasSectionContent(section: PanelAddTabMenuViewSection): boolean {
  if (section.entries.length > 0) return true;
  if (section.presentation !== 'submenu') return false;
  return (
    (section.subsections ?? []).some(
      (subsection) => subsection.entries.length > 0,
    ) ||
    (section.headerEntries?.length ?? 0) > 0 ||
    (section.footerEntries?.length ?? 0) > 0
  );
}

export function PanelAddTabMenuView({
  anchor,
  groupId,
  entries,
  sections,
  onClose,
}: PanelAddTabMenuViewProps): JSX.Element | null {
  const anchorRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({ current: anchor }),
    [anchor],
  );
  const returnFocusRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      current: anchor.matches('button')
        ? anchor
        : anchor.querySelector<HTMLButtonElement>('button'),
    }),
    [anchor],
  );
  // 60% of the viewport, less 216px so the catalog never dominates the
  // window; floored so a short window still shows a usable list.
  const heightLimit = Math.max(
    240,
    Math.floor((anchor.ownerDocument.defaultView?.innerHeight ?? 0) * 0.6) -
      216,
  );

  return (
    <Menu
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      anchorRef={anchorRef}
      returnFocusRef={returnFocusRef}
      placement="bottom-left"
      heightLimit={heightLimit}
      data-testid="panel-add-menu"
      data-group-id={groupId}
      className="w-56 max-w-[calc(100vw-16px)]"
    >
      {/* The quiet action-menu rows: small text, tertiary catalog glyphs. */}
      <ActionMenuRowStyle>
        {entries.map((entry) => (
          <MenuEntry key={entry.key ?? entry.testId} entry={entry} />
        ))}
        {sections.map((section) =>
          !hasSectionContent(section) ? null : (
            <Fragment key={section.id}>
              <MenuDivider
                data-testid={`panel-add-menu-${section.id}-divider`}
              />
              {section.presentation === 'submenu' ? (
                <MenuSubmenu section={section} />
              ) : section.presentation === 'row' ? (
                section.entries.map((entry) => (
                  <MenuEntry key={entry.key ?? entry.testId} entry={entry} />
                ))
              ) : (
                <div
                  role="group"
                  aria-label={section.label}
                  data-testid={`panel-add-menu-${section.id}-group`}
                >
                  <div
                    className="canopy-panel-chrome-menu-label"
                    aria-hidden="true"
                  >
                    {section.label}
                  </div>
                  {section.entries.map((entry) => (
                    <MenuEntry key={entry.key ?? entry.testId} entry={entry} />
                  ))}
                </div>
              )}
            </Fragment>
          ),
        )}
      </ActionMenuRowStyle>
    </Menu>
  );
}
