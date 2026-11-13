'use client';

import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
  type ButtonHTMLAttributes,
} from 'react';
import {
  SIDEBAR_ITEM_GROUP_COLORS,
  defaultSidebarItemGroupName,
  isDefaultSidebarItemGroupName,
  normalizeSidebarItemGroupName,
  resolveSidebarItemGroupLabel,
  sidebarItemGroupColorLabel,
  type SidebarItemGroup as GroupData,
  type SidebarItemGroupColor,
} from '@canopy/protocol/sidebar';
export { sidebarItemGroupColorLabel };
import {
  ChevronDownMediumIcon,
  ChevronTopMediumIcon,
  CloseIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
} from '../icons/AppIcons';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from './ActionMenuItems';
import { ColorSwatchPicker, type ColorSwatchOption } from './ColorSwatchPicker';
import { DisclosureChevron, DisclosureToggle } from './Disclosure';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuLabel,
} from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';
import { TextInput } from './Field';
import { RailIconButton } from './RailIconButton';
import {
  SIDEBAR_ROW_TRAILING_CELL_CLASSNAME,
  SIDEBAR_ROW_LEADING_SLOT_CLASSNAME,
} from './sidebar-item-classes';
import { Tooltip } from './Tooltip';
import { ToggleSwitch } from './ToggleSwitch';
import { useSidebarHeaderRest } from '../lib/useSidebarHeaderRest';

export function sidebarItemGroupColor(color: SidebarItemGroupColor): string {
  return color === 'neutral' ? 'var(--fg-tertiary)' : `var(--${color})`;
}
export const SIDEBAR_ITEM_GROUP_SWATCHES: readonly ColorSwatchOption[] =
  SIDEBAR_ITEM_GROUP_COLORS.map((value) => ({
    value,
    label: sidebarItemGroupColorLabel(value),
    color: sidebarItemGroupColor(value),
  }));

export interface SidebarItemGroupUnitLabel {
  singular: string;
  plural: string;
}
export interface SidebarItemGroupLabelCommit {
  name: string;
  /**
   * Present only when the choice differs from what a host derives from the
   * name alone, so a plain rename stays valid for hosts without this field.
   */
  labelHidden?: boolean;
}
export function sidebarItemGroupCountLabel(
  count: number,
  unitLabel: SidebarItemGroupUnitLabel,
): string {
  return `${count} ${count === 1 ? unitLabel.singular : unitLabel.plural}`;
}
export interface SidebarItemGroupActions {
  onToggle: () => void;
  onCreate: () => void;
  onUngroup: () => void;
  /**
   * Hosts that return the update's promise let the editor wait for its own
   * queued commits before reconciling with the group.
   */
  onLabelCommit: (
    label: SidebarItemGroupLabelCommit,
  ) => void | Promise<unknown>;
  onColorChange: (color: SidebarItemGroupColor) => void;
  onKeepWhenEmptyChange: (keepWhenEmpty: boolean) => void;
}
type ActivatorProps = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | 'onPointerDown'
  | 'onKeyDown'
  | 'onTouchStart'
  | 'aria-describedby'
  | 'aria-roledescription'
  | 'tabIndex'
>;

export function SidebarItemGroupRail({
  color,
  collapsed,
  expanded,
  onToggle,
  onContextMenu,
  activatorProps,
  readOnly = false,
}: {
  readOnly?: boolean;
  color: SidebarItemGroupColor;
  collapsed: boolean;
  expanded?: boolean;
  onToggle: () => void;
  onContextMenu: ButtonHTMLAttributes<HTMLButtonElement>['onContextMenu'];
  activatorProps?: ActivatorProps;
}): JSX.Element {
  const action = collapsed ? 'Expand group' : 'Collapse group';
  return (
    <span className="absolute -left-2 inset-y-0 w-2">
      <Tooltip
        label={readOnly ? action : `${action} · Right-click for options`}
        suppressed={expanded}
        className="h-full w-full"
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={action}
          data-testid="sidebar-item-group-rail"
          onClick={onToggle}
          onContextMenu={onContextMenu}
          {...activatorProps}
          className="group/group-rail flex h-full w-2 items-stretch justify-center py-1 pointer-coarse:pointer-events-none"
        >
          {/* Doubles 2px to 4px on hover and while expanded by `scale` on the
              compositor, never by `width`; the doubled geometry lives with the
              scrollbar's in `canopy-tokens-core.css`. */}
          <span
            aria-hidden="true"
            data-group-rail-line=""
            data-expanded={expanded ? 'true' : undefined}
            className="w-0.5 rounded-full transition-[scale]"
            style={{ backgroundColor: sidebarItemGroupColor(color) }}
          />
        </button>
      </Tooltip>
    </span>
  );
}

export function SidebarItemGroupHeader({
  group,
  count,
  unitLabel,
  contentId,
  onToggle,
  onCreate,
  onMenu,
  menuRef,
  toggleRef,
  menuOpen,
  actionsActive = menuOpen,
  status,
  activatorProps,
  testIdSuffix = '',
  readOnly = false,
  canCreate = true,
}: {
  readOnly?: boolean;
  /** Offer the header `+`. Default `true`; a host that cannot create withholds it. */
  canCreate?: boolean;
  group: GroupData;
  count: number;
  unitLabel: SidebarItemGroupUnitLabel;
  contentId: string;
  onToggle: () => void;
  onCreate: () => void;
  onMenu: () => void;
  menuRef?: RefObject<HTMLButtonElement | null>;
  toggleRef?: RefObject<HTMLButtonElement | null>;
  menuOpen?: boolean;
  actionsActive?: boolean;
  status?: ReactNode;
  activatorProps?: ActivatorProps;
  testIdSuffix?: string;
}): JSX.Element | null {
  const headerRest = useSidebarHeaderRest(group.collapsed, actionsActive);
  // An empty group has no rows to identify it, so it always shows its name.
  const labelHidden = group.labelHidden === true && count > 0;
  if (labelHidden && !group.collapsed) return null;
  const countLabel = sidebarItemGroupCountLabel(count, unitLabel);
  const label = labelHidden ? countLabel : group.name;
  return (
    <div
      className={`${headerRest.resting ? '' : 'group/sidebar-item '}relative flex h-7 min-w-0 items-center gap-1 px-1.5 pointer-coarse:h-11`}
      data-sidebar-header-resting={headerRest.resting || undefined}
      onPointerEnter={headerRest.onPointerEnter}
      onPointerMove={headerRest.onPointerMove}
      onFocusCapture={headerRest.onFocusCapture}
      onKeyDownCapture={headerRest.onKeyDownCapture}
      data-sidebar-item-group-header=""
      data-testid={`sidebar-item-group-header${testIdSuffix}`}
    >
      <DisclosureToggle
        ref={toggleRef}
        variant="sidebar-group"
        open={!group.collapsed}
        bodyId={contentId}
        onClick={(event): void => {
          onToggle();
          if (event.detail > 0) event.currentTarget.blur();
        }}
        {...activatorProps}
        data-testid={`sidebar-item-group-toggle${testIdSuffix}`}
      >
        <span className={SIDEBAR_ROW_LEADING_SLOT_CLASSNAME}>
          <DisclosureChevron direction={group.collapsed ? 'right' : 'down'} />
        </span>
        <span
          id={`${contentId}-label`}
          className={labelHidden ? 'sr-only' : 'truncate'}
        >
          {labelHidden ? `${group.name}, ${countLabel}` : label}
        </span>
        {group.collapsed && !menuOpen && (
          <span
            className={`ml-auto inline-flex shrink-0 items-center gap-1 ${!readOnly ? 'group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden pointer-coarse:hidden' : ''}`}
          >
            {status && (
              <span className="inline-flex h-6 w-6 items-center justify-center">
                {status}
              </span>
            )}
            <span
              className={`${SIDEBAR_ROW_TRAILING_CELL_CLASSNAME} ${labelHidden ? 'w-auto' : ''}`}
              data-testid={`sidebar-item-group-counter${testIdSuffix}`}
              aria-hidden={labelHidden ? true : undefined}
            >
              {labelHidden ? label : count}
            </span>
          </span>
        )}
      </DisclosureToggle>
      {!readOnly && (
        <div
          className={`${headerRest.resting ? 'pointer-fine:invisible ' : ''}${
            group.collapsed && !menuOpen
              ? 'absolute right-1.5 flex pointer-events-none opacity-0 group-hover/sidebar-item:static group-hover/sidebar-item:pointer-events-auto group-hover/sidebar-item:opacity-100 group-focus-within/sidebar-item:static group-focus-within/sidebar-item:pointer-events-auto group-focus-within/sidebar-item:opacity-100 pointer-coarse:static pointer-coarse:pointer-events-auto pointer-coarse:opacity-100'
              : 'flex'
          }`}
        >
          <RailIconButton
            ref={menuRef}
            icon={MoreHorizontalIcon}
            revealOnItemHover={!menuOpen}
            coarsePointerTarget
            aria-label={`More actions for ${group.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={onMenu}
            data-testid={`sidebar-item-group-menu-trigger${testIdSuffix}`}
          />
          {canCreate && (
            <RailIconButton
              icon={PlusIcon}
              revealOnItemHover
              coarsePointerTarget
              aria-label={`New ${unitLabel.singular} in group`}
              onClick={onCreate}
              data-testid={`sidebar-item-group-create${testIdSuffix}`}
            />
          )}
        </div>
      )}
    </div>
  );
}

type SidebarItemGroupMenuKey = 'edit' | 'toggle' | 'create' | 'ungroup';

/**
 * The group header's menu rows: Edit, Collapse (from the rail), New … in
 * group, then Ungroup on its own at the bottom, as the removal row.
 */
function sidebarItemGroupMenuItems({
  group,
  unitLabel,
  fromRail,
  canCreate,
  onEdit,
  onToggle,
  onCreate,
  onUngroup,
}: {
  group: Pick<GroupData, 'collapsed'>;
  unitLabel: SidebarItemGroupUnitLabel;
  fromRail: boolean;
  canCreate: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onCreate: () => void;
  onUngroup: () => void;
}): ActionMenuItem<SidebarItemGroupMenuKey>[] {
  const items: ActionMenuItem<SidebarItemGroupMenuKey>[] = [
    {
      key: 'edit',
      label: 'Edit group…',
      icon: <SettingsIcon />,
      onSelect: onEdit,
      testId: 'sidebar-item-group-edit',
    },
  ];
  if (fromRail) {
    items.push({
      key: 'toggle',
      label: group.collapsed ? 'Expand group' : 'Collapse group',
      icon: group.collapsed ? (
        <ChevronDownMediumIcon />
      ) : (
        <ChevronTopMediumIcon />
      ),
      onSelect: onToggle,
    });
  }
  if (canCreate) {
    items.push({
      key: 'create',
      label: `New ${unitLabel.singular} in group`,
      icon: <PlusIcon />,
      onSelect: onCreate,
    });
  }
  items.push({
    key: 'ungroup',
    label: 'Ungroup',
    icon: <MinusIcon />,
    onSelect: onUngroup,
    separatorBefore: true,
    testId: 'sidebar-item-group-ungroup',
  });
  return items;
}

export function SidebarItemGroupMenu({
  group,
  count,
  unitLabel,
  anchorRef,
  returnFocusRef,
  fromRail,
  open,
  onClose,
  onEdit,
  onToggle,
  onCreate,
  onUngroup,
  canCreate = true,
}: {
  group: GroupData;
  count: number;
  unitLabel: SidebarItemGroupUnitLabel;
  anchorRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  fromRail?: boolean;
  open: boolean;
  onClose: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onCreate: () => void;
  onUngroup: () => void;
  /** Offer "New … in group". Default `true`. */
  canCreate?: boolean;
}): JSX.Element {
  return (
    <FloatingMenu
      open={open}
      onOpenChange={(next): void => {
        if (!next) onClose();
      }}
      anchorRef={anchorRef}
      returnFocusRef={returnFocusRef}
      className="w-56"
      aria-label="Group actions"
      data-testid="sidebar-item-group-menu"
    >
      {fromRail && group.labelHidden && (
        <DropdownMenuLabel>
          {group.name} · {sidebarItemGroupCountLabel(count, unitLabel)}
        </DropdownMenuLabel>
      )}
      <ActionMenuRowStyle>
        <ActionMenuItems
          items={sidebarItemGroupMenuItems({
            group,
            unitLabel,
            fromRail: fromRail === true,
            canCreate,
            onEdit: (): void => {
              onEdit();
              // Hand focus back to the header, as a FloatingMenu pick does.
              returnFocusRef.current?.focus({ preventScroll: true });
            },
            onToggle: (): void => {
              onClose();
              onToggle();
            },
            onCreate: (): void => {
              onClose();
              onCreate();
            },
            onUngroup: (): void => {
              onClose();
              onUngroup();
            },
          })}
          onSelect={(item): void => {
            if (item.disabled || !item.onSelect) return;
            item.onSelect();
          }}
        />
      </ActionMenuRowStyle>
    </FloatingMenu>
  );
}

/** Mount per open session, so Escape can discard the draft without a blur commit. */
export function SidebarItemGroupEditor({
  group,
  groups,
  onEditorChange,
  unitLabel,
  anchorRef,
  returnFocusRef,
  onClose,
  onLabelCommit,
  onColorChange,
  onKeepWhenEmptyChange,
  onCreate,
  onUngroup,
  canCreate = true,
}: {
  onEditorChange?: (groupId: string | null) => void;
  group: GroupData;
  groups: readonly Pick<GroupData, 'id' | 'name'>[];
  unitLabel: SidebarItemGroupUnitLabel;
  anchorRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: (returnFocus?: boolean) => void;
  /** Offer "New … in group". Default `true`. */
  canCreate?: boolean;
} & Pick<
  SidebarItemGroupActions,
  | 'onLabelCommit'
  | 'onColorChange'
  | 'onKeepWhenEmptyChange'
  | 'onCreate'
  | 'onUngroup'
>): JSX.Element {
  useEffect(() => {
    onEditorChange?.(group.id);
    return (): void => onEditorChange?.(null);
  }, [group.id, onEditorChange]);
  const [name, setName] = useState(() =>
    isDefaultSidebarItemGroupName(group.name) ? '' : group.name,
  );
  const [showName, setShowName] = useState(!group.labelHidden);
  const cancelled = useRef(false);
  const initialName = isDefaultSidebarItemGroupName(group.name)
    ? ''
    : group.name;
  const committed = useRef<Required<SidebarItemGroupLabelCommit>>({
    name: normalizeSidebarItemGroupName(initialName),
    labelHidden: group.labelHidden === true,
  });
  // A host can reject a commit and roll the group back. Follow the group then,
  // so the switch and the next commit start from what the host actually holds.
  // While this editor's own commits are still in flight the group can show
  // an earlier one of them, so reconciling waits until they have settled.
  const hostName = normalizeSidebarItemGroupName(
    isDefaultSidebarItemGroupName(group.name) ? '' : group.name,
  );
  const hostLabelHidden = group.labelHidden === true;
  const host = useRef({ name: hostName, labelHidden: hostLabelHidden });
  host.current = { name: hostName, labelHidden: hostLabelHidden };
  const pendingCommits = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => (): void => {
      mounted.current = false;
    },
    [],
  );
  // The name the editor and the host last agreed on. A draft that still equals
  // it was not edited here, so it follows a rename made on another surface
  // instead of committing the old name back when the editor closes.
  const draftBase = useRef(committed.current.name);
  const followHost = (): void => {
    if (pendingCommits.current > 0 || !mounted.current) return;
    if (
      committed.current.name === host.current.name &&
      committed.current.labelHidden === host.current.labelHidden
    ) {
      draftBase.current = host.current.name;
      return;
    }
    const untouched = normalizeSidebarItemGroupName(name) === draftBase.current;
    committed.current = { ...host.current };
    setShowName(!host.current.labelHidden);
    if (untouched) {
      draftBase.current = host.current.name;
      setName(host.current.name);
    }
  };
  const followHostRef = useRef(followHost);
  followHostRef.current = followHost;
  useEffect(() => {
    followHostRef.current();
  }, [hostName, hostLabelHidden]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const showNameId = useId();
  const normalizedName = normalizeSidebarItemGroupName(name);
  const canShowName =
    normalizedName !== '' && !isDefaultSidebarItemGroupName(normalizedName);
  const checked = canShowName && showName;
  const otherGroups = groups.filter((candidate) => candidate.id !== group.id);
  // The placeholder is the name a blank input keeps or would be given.
  const placeholder = isDefaultSidebarItemGroupName(group.name)
    ? group.name
    : defaultSidebarItemGroupName(otherGroups);
  const commit = (nextShowName = showName): void => {
    if (cancelled.current) return;
    const next: Required<SidebarItemGroupLabelCommit> = {
      name: normalizeSidebarItemGroupName(name),
      labelHidden:
        !normalizedName ||
        isDefaultSidebarItemGroupName(normalizedName) ||
        !nextShowName,
    };
    if (
      committed.current.name !== next.name ||
      committed.current.labelHidden !== next.labelHidden
    ) {
      // Compare against this editor's last commit, not the group: an earlier
      // commit may still be queued, and the group would then be one step behind.
      const derived = resolveSidebarItemGroupLabel({
        name: next.name,
        previous: {
          name: committed.current.name || placeholder,
          labelHidden: committed.current.labelHidden,
        },
        others: otherGroups,
      });
      committed.current = next;
      const settled = onLabelCommit(
        derived.labelHidden === next.labelHidden ? { name: next.name } : next,
      );
      if (settled) {
        pendingCommits.current += 1;
        const settle = (): void => {
          pendingCommits.current -= 1;
          followHostRef.current();
        };
        void settled.then(settle, settle);
      }
    }
  };
  const close = (): void => {
    commit();
    onClose();
    returnFocusRef.current?.focus();
  };
  return (
    <FloatingMenu
      open
      interaction="manual"
      trapFocus
      role="dialog"
      aria-label="Edit group"
      closeOnSelect={false}
      initialFocusRef={inputRef}
      anchorRef={anchorRef}
      returnFocusRef={returnFocusRef}
      onOpenChange={(next): void => {
        if (!next) close();
      }}
      className="w-64"
      data-testid="sidebar-item-group-editor"
      onKeyDown={(event): void => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancelled.current = true;
        onClose();
        returnFocusRef.current?.focus();
      }}
    >
      <div className="flex items-center gap-2 px-2 py-1">
        <span id={`${inputId}-label`} className="text-s fg-secondary">
          Group name
        </span>
        <RailIconButton
          icon={CloseIcon}
          aria-label="Close group editor"
          onClick={close}
          data-testid="sidebar-item-group-editor-close"
        />
      </div>
      <div className="px-2 pb-2 flex flex-col gap-2">
        <TextInput
          ref={inputRef}
          id={inputId}
          aria-labelledby={`${inputId}-label`}
          value={name}
          placeholder={placeholder}
          className="w-full"
          data-testid="sidebar-item-group-name"
          onChange={(event): void => {
            const nextName = event.target.value;
            const previousNormalized = normalizeSidebarItemGroupName(name);
            const previousCanShowName =
              previousNormalized !== '' &&
              !isDefaultSidebarItemGroupName(previousNormalized);
            const nextNormalized = normalizeSidebarItemGroupName(nextName);
            const nextCanShowName =
              nextNormalized !== '' &&
              !isDefaultSidebarItemGroupName(nextNormalized);
            setName(nextName);
            if (!nextCanShowName) setShowName(false);
            else if (!previousCanShowName) {
              // Naming a blank/default group should show its new name by default.
              setShowName(true);
            }
          }}
          onBlur={(event): void => {
            if (
              event.relatedTarget instanceof HTMLElement &&
              (event.relatedTarget.id === showNameId ||
                event.relatedTarget.getAttribute('role') === 'menuitem')
            )
              return;
            commit();
          }}
          onKeyDown={(event): void => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            // Enter that confirms an IME candidate is not a save.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            close();
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-s fg-secondary">Show name in sidebar</span>
          <ToggleSwitch
            id={showNameId}
            checked={checked}
            disabled={!canShowName}
            label="Show name in sidebar"
            dataTestId="sidebar-item-group-show-name"
            onChange={(next): void => {
              setShowName(next);
              commit(next);
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-s fg-secondary">Remove group when empty</span>
          <ToggleSwitch
            checked={group.keepWhenEmpty !== true}
            label="Remove group when empty"
            dataTestId="sidebar-item-group-remove-when-empty"
            onChange={(next): void => onKeepWhenEmptyChange(!next)}
          />
        </div>
        <div>
          <ColorSwatchPicker
            value={group.color}
            palette={SIDEBAR_ITEM_GROUP_SWATCHES}
            onChange={(value): void => {
              const color = SIDEBAR_ITEM_GROUP_COLORS.find(
                (option) => option === value,
              );
              if (color) onColorChange(color);
            }}
            testId="sidebar-item-group-colors"
          />
        </div>
      </div>
      <DropdownMenuDivider />
      {canCreate && (
        <>
          <DropdownMenuItem
            onClick={(): void => {
              commit();
              onClose(false);
              onCreate();
            }}
          >
            New {unitLabel.singular} in group
          </DropdownMenuItem>
          <DropdownMenuDivider />
        </>
      )}
      <DropdownMenuItem
        onClick={(): void => {
          cancelled.current = true;
          onClose(false);
          onUngroup();
        }}
      >
        Ungroup
      </DropdownMenuItem>
    </FloatingMenu>
  );
}

export function SidebarItemGroup({
  group,
  groups,
  onEditorChange,
  count,
  unitLabel,
  children,
  actions,
  status,
  returnFocusRef,
  activatorProps,
  readOnly = false,
  canCreate = true,
}: {
  readOnly?: boolean;
  /**
   * Offer the create affordances (header `+`, menu and editor "New … in
   * group"). Default `true`; a host whose target cannot create withholds them.
   */
  canCreate?: boolean;
  group: GroupData;
  groups: readonly Pick<GroupData, 'id' | 'name'>[];
  count: number;
  unitLabel: SidebarItemGroupUnitLabel;
  children: ReactNode;
  onEditorChange?: (groupId: string | null) => void;
  actions: SidebarItemGroupActions;
  status?: ReactNode;
  returnFocusRef: RefObject<HTMLElement | null>;
  activatorProps?: ActivatorProps;
}): JSX.Element {
  const contentId = useId();
  const headerRef = useRef<HTMLButtonElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const toggleFocusPending = useRef(false);
  const railAnchorRef = useRef<HTMLSpanElement | null>(null);
  const [menu, setMenu] = useState<'header' | 'rail' | null>(null);
  const [editor, setEditor] = useState<'header' | 'rail' | null>(null);
  const closingEditorRef = useRef(false);
  const closingFocusRef = useRef<HTMLElement | null>(null);
  useLayoutEffect((): void => {
    if (!toggleFocusPending.current) return;
    toggleFocusPending.current = false;
    (toggleRef.current ?? returnFocusRef.current)?.focus();
  }, [group.collapsed, returnFocusRef]);
  useLayoutEffect((): void => {
    if (!closingEditorRef.current) return;
    closingEditorRef.current = false;
    (closingFocusRef.current?.isConnected
      ? closingFocusRef.current
      : returnFocusRef.current
    )?.focus();
  }, [editor, group.name, returnFocusRef]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Viewport top of a stuck (sticky) header when a collapse was requested.
  const stuckHeaderTop = useRef<number | null>(null);
  const toggle = (): void => {
    const root = rootRef.current;
    const top = root
      ?.querySelector<HTMLElement>('[data-sidebar-item-group-header]')
      ?.getBoundingClientRect().top;
    // Stuck: the header has left its own top edge in the group.
    stuckHeaderTop.current =
      !group.collapsed &&
      root &&
      top !== undefined &&
      top - root.getBoundingClientRect().top > 1
        ? top
        : null;
    actions.onToggle();
  };
  useLayoutEffect((): void => {
    // Collapsing removes the rows a stuck header rides on, which would drop it
    // above its seat out of view; scroll it back to where it was clicked.
    const top = stuckHeaderTop.current;
    stuckHeaderTop.current = null;
    const header = rootRef.current?.querySelector<HTMLElement>(
      '[data-sidebar-item-group-header]',
    );
    if (top === null || !group.collapsed || !header) return;
    let scroller = header.parentElement;
    while (
      scroller &&
      !/auto|scroll/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement;
    if (scroller)
      scroller.scrollTop += header.getBoundingClientRect().top - top;
  }, [group.collapsed]);
  const anchorRef = (editor ?? menu) === 'rail' ? railAnchorRef : headerRef;
  const focusRef = (editor ?? menu) === 'rail' ? returnFocusRef : headerRef;
  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={group.labelHidden ? undefined : `${contentId}-label`}
      aria-label={group.labelHidden ? `${group.name} group` : undefined}
      className="relative my-1 flex flex-col gap-px"
      data-sidebar-item-group-id={group.id}
      data-testid={`sidebar-item-group-${group.id}`}
    >
      <span
        ref={railAnchorRef}
        aria-hidden="true"
        className="absolute -left-2 top-0 h-0 w-0"
      />
      <SidebarItemGroupRail
        readOnly={readOnly}
        color={group.color}
        collapsed={group.collapsed}
        expanded={menu !== null || editor !== null}
        onToggle={toggle}
        activatorProps={activatorProps}
        onContextMenu={(event): void => {
          event.preventDefault();
          if (readOnly) return;
          railAnchorRef.current?.style.setProperty(
            'top',
            `${event.clientY - event.currentTarget.getBoundingClientRect().top}px`,
          );
          setMenu('rail');
        }}
      />
      <SidebarItemGroupHeader
        readOnly={readOnly}
        group={group}
        count={count}
        unitLabel={unitLabel}
        contentId={contentId}
        onToggle={toggle}
        onCreate={actions.onCreate}
        canCreate={canCreate}
        onMenu={(): void => setMenu('header')}
        menuRef={headerRef}
        toggleRef={toggleRef}
        menuOpen={menu === 'header'}
        actionsActive={menu !== null || editor !== null}
        status={status}
        activatorProps={activatorProps}
      />
      <div id={contentId} data-sidebar-item-group-content="">
        {children}
      </div>
      <SidebarItemGroupMenu
        group={group}
        count={count}
        unitLabel={unitLabel}
        anchorRef={anchorRef}
        returnFocusRef={focusRef}
        fromRail={menu === 'rail'}
        open={!readOnly && menu !== null}
        onClose={(): void => setMenu(null)}
        onEdit={(): void => {
          if (menu === 'rail')
            railAnchorRef.current?.style.setProperty('top', '0px');
          setEditor(menu);
          setMenu(null);
        }}
        onToggle={(): void => {
          toggleFocusPending.current = true;
          toggle();
        }}
        onCreate={actions.onCreate}
        onUngroup={actions.onUngroup}
        canCreate={canCreate}
      />
      {!readOnly && editor && (
        <SidebarItemGroupEditor
          onEditorChange={onEditorChange}
          group={group}
          groups={groups}
          unitLabel={unitLabel}
          anchorRef={anchorRef}
          returnFocusRef={focusRef}
          onClose={(returnFocus = true): void => {
            closingFocusRef.current = focusRef.current;
            closingEditorRef.current = returnFocus;
            setEditor(null);
          }}
          onLabelCommit={actions.onLabelCommit}
          onColorChange={actions.onColorChange}
          onKeepWhenEmptyChange={actions.onKeepWhenEmptyChange}
          onCreate={actions.onCreate}
          onUngroup={actions.onUngroup}
          canCreate={canCreate}
        />
      )}
    </div>
  );
}
