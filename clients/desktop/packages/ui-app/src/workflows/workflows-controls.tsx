'use client';

import { useRef, useState, type JSX, type ReactNode } from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  Menu,
  type ActionMenuItem,
  PageSearchField,
  TableActionButton,
} from '@canopy/ui-shared/components';
import { MoreHorizontalIcon } from '@canopy/ui-shared/icons/AppIcons';

export interface WorkflowsSearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** `Search workflows`; also the field's accessible name. */
  readonly placeholder: string;
  readonly testId: string;
  /** Result count while there is a query: `2 of 6`. */
  readonly count?: ReactNode;
}

/**
 * The search of the Runs and Library rows: the page search field, filling
 * the row ahead of the filters and sort.
 */
export function WorkflowsSearchField({
  value,
  onChange,
  placeholder,
  testId,
  count,
}: WorkflowsSearchFieldProps): JSX.Element {
  return (
    <PageSearchField
      value={value}
      onValueChange={onChange}
      placeholder={placeholder}
      aria-label={placeholder}
      data-testid={testId}
      clearTestId={`${testId}-clear`}
      fieldTestId={`${testId}-field`}
      count={count}
    />
  );
}

export interface WorkflowsRowMenuItem {
  readonly id: string;
  readonly label: string;
  /**
   * Leading icon. Consecutive rows in one group that pass the same icon
   * element (Share… and Copy share link) show it once, on the first row.
   */
  readonly icon: ReactNode;
  /** Rows sharing a group sit together; a hairline divides the groups. */
  readonly group?: string;
  /** Destructive rows (red) close the menu in their own last group. */
  readonly destructive?: boolean;
  /** A plain row that removes the item from view, grouped with removals. */
  readonly removal?: boolean;
  readonly onSelect: () => void;
}

export interface WorkflowsRowMenuProps {
  /** Accessible name of the trigger: `More actions for Standup notes`. */
  readonly label: string;
  readonly items: readonly WorkflowsRowMenuItem[];
  readonly testId: string;
}

/** The rows in menu order: removal rows last, a divider between groups. */
export function workflowsRowMenuActionItems(
  items: readonly WorkflowsRowMenuItem[],
  testId: string,
): ActionMenuItem[] {
  const isRemoval = (item: WorkflowsRowMenuItem): boolean =>
    item.destructive === true || item.removal === true;
  const ordered = [
    ...items.filter((item) => !isRemoval(item)),
    ...items.filter(isRemoval),
  ];
  // Removal rows form their own group, apart from any named group.
  const groupOf = (item: WorkflowsRowMenuItem): string | null =>
    isRemoval(item) ? null : (item.group ?? '');
  return ordered.map((item, index) => {
    const previous = ordered[index - 1];
    return {
      key: item.id,
      label: item.label,
      icon: item.icon,
      tone: item.destructive === true ? 'destructive' : 'default',
      separatorBefore:
        previous !== undefined && groupOf(previous) !== groupOf(item),
      testId: `${testId}-item-${item.id}`,
      onSelect: item.onSelect,
    };
  });
}

/**
 * A row's More menu, on the shared action-menu recipe: a leading icon on
 * every row, groups split by hairlines, and removal rows in their own last
 * group. Renders nothing when no item applies, so a row never shows an empty
 * menu.
 */
export function WorkflowsRowMenu({
  label,
  items,
  testId,
}: WorkflowsRowMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        <TableActionButton
          label={label}
          testId={testId}
          onClick={(): void => setOpen((current) => !current)}
        >
          <MoreHorizontalIcon size="sm" aria-hidden="true" />
        </TableActionButton>
      </span>
      <Menu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        data-testid={`${testId}-menu`}
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={workflowsRowMenuActionItems(items, testId)}
            onSelect={(item): void => {
              setOpen(false);
              // Hand focus back to the trigger, as a Menu pick does.
              anchorRef.current
                ?.querySelector<HTMLElement>('button')
                ?.focus({ preventScroll: true });
              item.onSelect?.();
            }}
          />
        </ActionMenuRowStyle>
      </Menu>
    </>
  );
}
