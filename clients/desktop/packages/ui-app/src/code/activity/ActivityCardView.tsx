'use client';

import { useId, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  ActivityItemDensityContext,
  DEFAULT_MENU_ROW_STYLE,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuRowStyleProvider,
  FloatingMenu,
  type DropdownMenuRowStyle,
  HeaderActionDefaultToneContext,
  EmptyStateRow,
} from '@canopy/ui-shared/components';
import { PlusMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Divider } from '@canopy/ui-shared/components';

/**
 * Which block of the card a row joins. `work` is what happened in this
 * worktree (summary, changes, pull request, runs), `setup` is what the agent
 * works with (servers, scripts, hooks, plugins), and `add` collects the
 * sections that are empty but still offer an action; those live behind the
 * card's Add row instead of taking rows of their own.
 */
export type ActivityCardRowGroup = 'work' | 'setup' | 'add';

export interface ActivityCardRow {
  readonly key: string;
  readonly group: ActivityCardRowGroup;
  /**
   * The block the section belongs to when it has content. An empty section
   * picked from the + menu shows there.
   */
  readonly block: Exclude<ActivityCardRowGroup, 'add'>;
  readonly title: ReactNode;
  readonly icon: ReactNode;
  /** Short state after the name (`2`, `9h ago`, `+133 -8`). */
  readonly value?: ReactNode;
  /** The section's own controls (refresh, review), shown while expanded. */
  readonly headerAction?: ReactNode;
  readonly renderBody: () => ReactNode;
  /**
   * Runs the row's action instead of expanding it. Empty sections whose
   * whole body would be one button (Generate summary, Add MCP server) use it.
   */
  readonly onActivate?: () => void;
}

export interface ActivityCardViewProps {
  readonly rows: readonly ActivityCardRow[];
  /** Sections the user has expanded. */
  readonly expandedKeys: ReadonlySet<string>;
  readonly onToggleExpanded: (key: string) => void;
  /**
   * Opens a section in its own panel instead of expanding it here (desktop:
   * a Side Panel tab). Returns `false` when the section has no panel, and the
   * row then expands in place as before.
   */
  readonly onOpenSection?: (key: string) => boolean;
}

/**
 * The card's rows: the menu's 32px row and 16px icon, with small text and the
 * sidebar rows' corner radius, so they match the rows beside the card. Its
 * icons set their own (tertiary) ink, so the icon tone here never applies.
 */
const CARD_ROW_STYLE: DropdownMenuRowStyle = {
  textStyle: 'small',
  iconTone: 'inherit',
  corners: 'row',
};

/**
 * The card's look for what it shows: section bodies draw plain rows at the
 * card's size, and their header controls take its neutral ink. Also wraps a
 * body the card renders elsewhere (a retained body's portal).
 */
export function ActivityCardStyle({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <DropdownMenuRowStyleProvider value={CARD_ROW_STYLE}>
      <ActivityItemDensityContext.Provider value="compact">
        <HeaderActionDefaultToneContext.Provider value="neutral">
          {children}
        </HeaderActionDefaultToneContext.Provider>
      </ActivityItemDensityContext.Provider>
    </DropdownMenuRowStyleProvider>
  );
}

/**
 * A section row that expands its content in place, below itself. The open
 * row wears the selected surface, so the row and the list under it read as
 * one item.
 */
function SectionRow({
  row,
  expanded,
  opensInPanel,
  onActivate,
}: {
  readonly row: ActivityCardRow;
  readonly expanded: boolean;
  /** The row opens its section elsewhere, so it has no expanded state. */
  readonly opensInPanel: boolean;
  readonly onActivate: () => void;
}): JSX.Element {
  const bodyId = useId();
  return (
    <div data-testid={`activity-card-section-${row.key}`}>
      <div className="flex items-center gap-0.5">
        <DropdownMenuItem
          asButton
          selected={expanded}
          aria-expanded={opensInPanel ? undefined : expanded}
          aria-controls={expanded ? bodyId : undefined}
          data-testid={`activity-card-row-${row.key}`}
          onClick={onActivate}
          className="min-w-0 flex-1"
        >
          <DropdownMenuItemIcon tone="tertiary">
            {row.icon}
          </DropdownMenuItemIcon>
          {/* The state (`2`, `9h ago`) sits at the row's right end. */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate">{row.title}</span>
            {row.value ? (
              <span
                className="min-w-0 shrink-2 truncate text-right fg-tertiary"
                data-testid={`activity-card-value-${row.key}`}
              >
                {row.value}
              </span>
            ) : null}
          </span>
        </DropdownMenuItem>
        {expanded && row.headerAction ? (
          <div className="flex shrink-0 items-center">{row.headerAction}</div>
        ) : null}
      </div>
      {expanded ? (
        <div
          id={bodyId}
          // Indented so its rows start under the section name (the 16px icon
          // and 8px gap): the list reads as belonging to its row by
          // placement, without a box.
          className="pt-0.5 pb-1 pl-6"
          data-testid="activity-card-detail"
          data-section={row.key}
        >
          {row.renderBody()}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The card's last row, below a divider: everything the empty sections offer,
 * in one menu.
 */
function AddMenu({
  rows,
  onChoose,
}: {
  readonly rows: readonly ActivityCardRow[];
  readonly onChoose: (row: ActivityCardRow) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  return (
    <>
      <DropdownMenuItem
        ref={triggerRef}
        asButton
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="activity-card-add"
        onClick={(): void => setOpen((current) => !current)}
      >
        <DropdownMenuItemIcon tone="tertiary">
          <PlusMediumIcon aria-hidden="true" />
        </DropdownMenuItemIcon>
        <span className="min-w-0 flex-1 truncate">Add</span>
      </DropdownMenuItem>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        data-testid="activity-card-add-menu"
        aria-label="Add"
        className="w-56"
      >
        {/* The card's row style reaches through the portal; reset it. */}
        <DropdownMenuRowStyleProvider value={DEFAULT_MENU_ROW_STYLE}>
          {rows.map((row) => (
            <DropdownMenuItem
              key={row.key}
              data-testid={`activity-card-row-${row.key}`}
              onClick={(): void => {
                setOpen(false);
                onChoose(row);
              }}
            >
              <DropdownMenuItemIcon tone="tertiary">
                {row.icon}
              </DropdownMenuItemIcon>
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}

/**
 * The Activity card's content: one list of rows, what happened in this
 * worktree (summary, changes, pull request, runs) and then what the agent
 * works with (servers, scripts, hooks, plugins), with no headings. Below a
 * divider, Add offers what can still be added. A row opens its section in a
 * panel when the host can (`onOpenSection`), else expands it in place. The
 * host owns the surface around it and its toggle.
 */
export function ActivityCardView({
  rows,
  expandedKeys,
  onToggleExpanded,
  onOpenSection,
}: ActivityCardViewProps): JSX.Element {
  const add = rows.filter((row) => row.group === 'add');
  // An add item for an empty section without a one-step action shows that
  // section expanded, in its block, with its own action ready.
  const [shownEmptyKey, setShownEmptyKey] = useState<string | null>(null);
  const inBlock = (block: 'work' | 'setup'): ActivityCardRow[] =>
    rows.filter(
      (row) =>
        row.block === block &&
        (row.group === block || row.key === shownEmptyKey),
    );
  // A row runs its one-step action, else opens its section in a panel, else
  // expands it here.
  const activate = (row: ActivityCardRow): void => {
    if (row.onActivate) {
      row.onActivate();
      return;
    }
    if (onOpenSection?.(row.key) === true) return;
    onToggleExpanded(row.key);
  };
  const listed = [...inBlock('work'), ...inBlock('setup')];
  return (
    // Sections opened here draw plain rows at the card's size, and their
    // header controls take the card's neutral ink.
    <ActivityCardStyle>
      <div
        className="flex min-w-0 flex-col"
        data-testid="activity-card-content"
      >
        {listed.length === 0 ? (
          <div className="px-2">
            <EmptyStateRow
              testId="activity-card-empty"
              title="Nothing has happened here yet."
            />
          </div>
        ) : (
          <div className="flex flex-col" data-testid="activity-card-overview">
            {listed.map((row) => (
              <SectionRow
                key={row.key}
                row={row}
                expanded={expandedKeys.has(row.key)}
                opensInPanel={onOpenSection !== undefined}
                onActivate={(): void => activate(row)}
              />
            ))}
          </div>
        )}
        {add.length > 0 ? (
          <>
            {/* Inset to the rows' 8px padding, so it starts at their icons
                  and ends with their labels; 4px of space above and below. */}
            <div className="px-2 py-1">
              <Divider />
            </div>
            <AddMenu
              rows={add}
              onChoose={(row): void => {
                if (row.onActivate) {
                  row.onActivate();
                  return;
                }
                if (onOpenSection?.(row.key) === true) return;
                setShownEmptyKey(row.key);
                if (!expandedKeys.has(row.key)) onToggleExpanded(row.key);
              }}
            />
          </>
        ) : null}
      </div>
    </ActivityCardStyle>
  );
}
