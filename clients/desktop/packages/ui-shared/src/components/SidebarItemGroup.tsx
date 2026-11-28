'use client';

import { Button, ControlButton } from '../primitives/Button';
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
  type SidebarItemGroupUpdateRequest,
} from '@canopy/protocol/sidebar';
export { sidebarItemGroupColorLabel };
import {
  ChevronDownMediumIcon,
  ChevronTopMediumIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
} from '../icons/AppIcons';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from '../primitives/ActionMenuItems';
import { ColorSwatchPicker, type ColorSwatchOption } from './ColorSwatchPicker';
import { DisclosureChevron, DisclosureToggle } from '../primitives/Disclosure';
import { MenuLabel } from '../primitives/MenuItem';
import { Menu } from '../primitives/Menu';
import { FieldError, TextInput } from '../primitives/Field';
import { FormField } from '../primitives/FormField';
import { Heading } from '../primitives/Heading';
import { OverlayScrollArea } from '../primitives/OverlayScrollArea';
import { RailIconButton } from './RailIconButton';
import {
  SIDEBAR_ROW_TRAILING_CELL_CLASSNAME,
  SIDEBAR_ROW_LEADING_SLOT_CLASSNAME,
} from '../primitives/sidebar-item-classes';
import { Tooltip } from '../primitives/Tooltip';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { useRowToggleClick } from './settings/SettingsRows';
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
type SidebarItemGroupSettings = Pick<
  SidebarItemGroupUpdateRequest,
  'name' | 'labelHidden' | 'color' | 'keepWhenEmpty'
>;
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
  /** A host that reports a failed update returns false so the draft stays open. */
  onSave: (patch: SidebarItemGroupSettings) => void | Promise<void | false>;
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
    <span className="absolute -left-2 inset-y-1 w-2">
      <Tooltip
        label={readOnly ? action : `${action} · Right-click for options`}
        suppressed={expanded}
        className="h-full w-full"
      >
        <ControlButton
          type="button"
          tabIndex={-1}
          aria-label={action}
          data-testid="sidebar-item-group-rail"
          onClick={onToggle}
          onContextMenu={onContextMenu}
          {...activatorProps}
          presentation="sidebar-group-rail"
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
        </ControlButton>
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
          title={labelHidden ? undefined : group.name}
        >
          {labelHidden ? `${group.name}, ${countLabel}` : label}
        </span>
        {group.collapsed && !menuOpen && (
          <span
            className={`ml-auto inline-flex shrink-0 items-center gap-1 ${!readOnly ? 'group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden' : ''}`}
          >
            {status && (
              <span className="inline-flex h-6 w-6 items-center justify-center">
                {status}
              </span>
            )}
            <span
              // On touch the actions show at rest and take the count's place;
              // the status stays, since it may say the group needs you.
              className={`${SIDEBAR_ROW_TRAILING_CELL_CLASSNAME} ${labelHidden ? 'w-auto' : ''} ${!readOnly ? 'pointer-coarse:hidden' : ''}`}
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
    <Menu
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
        <MenuLabel>
          {group.name} · {sidebarItemGroupCountLabel(count, unitLabel)}
        </MenuLabel>
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
              // Hand focus back to the header, as a Menu pick does.
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
    </Menu>
  );
}

/** A switch with its text; a click on the text flips it, as in a Settings row. */
function EditorSwitchRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  const { controlRef, onRowClick } = useRowToggleClick();
  return (
    <div
      className="flex items-center justify-between gap-2 pointer-coarse:min-h-11"
      onClick={onRowClick}
    >
      <span className="text-s fg-secondary">{label}</span>
      <div ref={controlRef} className="flex">
        {children}
      </div>
    </div>
  );
}

/** Mount per open session so dismissing the editor discards its draft. */
export function SidebarItemGroupEditor({
  group,
  groups,
  onEditorChange,
  anchorRef,
  returnFocusRef,
  onClose,
  onSave,
}: {
  group: GroupData;
  groups: readonly Pick<GroupData, 'id' | 'name'>[];
  onEditorChange?: (groupId: string | null) => void;
  anchorRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: (restoreFocus: boolean) => void;
  onSave: SidebarItemGroupActions['onSave'];
}): JSX.Element {
  useEffect(() => {
    onEditorChange?.(group.id);
    return (): void => onEditorChange?.(null);
  }, [group.id, onEditorChange]);

  const [draft, setDraft] = useState<SidebarItemGroupSettings>({});
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const failedPatch = useRef<SidebarItemGroupSettings>({});
  const headingId = useId();
  const saveErrorId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasDefaultName = isDefaultSidebarItemGroupName(group.name);
  const name = draft.name ?? (hasDefaultName ? '' : group.name);
  const normalizedName = normalizeSidebarItemGroupName(name);
  const canShowName =
    normalizedName !== '' && !isDefaultSidebarItemGroupName(normalizedName);
  const showName = canShowName && !(draft.labelHidden ?? group.labelHidden);
  const color = draft.color ?? group.color;
  const keepWhenEmpty = draft.keepWhenEmpty ?? group.keepWhenEmpty === true;
  const otherGroups = groups.filter((candidate) => candidate.id !== group.id);
  const placeholder = hasDefaultName
    ? group.name
    : defaultSidebarItemGroupName(otherGroups);

  const edit = (patch: SidebarItemGroupSettings): void => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setSaveFailed(false);
  };

  const close = (): void => {
    const dialog = dialogRef.current;
    const restoreFocus =
      dialog?.contains(dialog.ownerDocument.activeElement) === true;
    onClose(restoreFocus);
    if (restoreFocus) returnFocusRef.current?.focus({ preventScroll: true });
  };

  const save = async (): Promise<void> => {
    // A rejected field may still look saved in the optimistic projection.
    const retry = failedPatch.current;
    const label = resolveSidebarItemGroupLabel({
      name: draft.name,
      labelHidden: !showName,
      previous: group,
      others: otherGroups,
    });
    const patch: SidebarItemGroupSettings = {};
    if (
      draft.name !== undefined &&
      (retry.name !== undefined || label.name !== group.name)
    )
      patch.name = normalizedName;
    // Only send the visibility field when the name alone won't produce the
    // chosen visibility. Older Remote Control hosts derive it from the name.
    const derived = resolveSidebarItemGroupLabel({
      name: patch.name,
      previous: group,
      others: otherGroups,
    });
    if (
      retry.labelHidden !== undefined ||
      derived.labelHidden !== label.labelHidden
    )
      patch.labelHidden = label.labelHidden;
    if (
      draft.color !== undefined &&
      (retry.color !== undefined || draft.color !== group.color)
    )
      patch.color = draft.color;
    if (
      draft.keepWhenEmpty !== undefined &&
      (retry.keepWhenEmpty !== undefined ||
        draft.keepWhenEmpty !== (group.keepWhenEmpty === true))
    )
      patch.keepWhenEmpty = draft.keepWhenEmpty;
    if (Object.keys(patch).length === 0) {
      close();
      return;
    }

    setSaving(true);
    const saved = await onSave(patch);
    // Another editor may have opened, or saving may have removed this group.
    if (!dialogRef.current?.isConnected) return;
    setSaving(false);
    if (saved === false) {
      failedPatch.current = { ...retry, ...patch };
      setSaveFailed(true);
    } else close();
  };

  return (
    <Menu
      ref={dialogRef}
      open
      interaction="manual"
      trapFocus
      role="dialog"
      aria-labelledby={headingId}
      closeOnSelect={false}
      closeOnOutsidePress={!saving}
      initialFocusRef={inputRef}
      keepTouchKeyboardClosed
      anchorRef={anchorRef}
      returnFocusRef={returnFocusRef}
      onOpenChange={(open): void => {
        if (!open && !saving) close();
      }}
      padding="readout"
      className="flex w-72 flex-col overflow-hidden"
      data-testid="sidebar-item-group-editor"
      onKeyDown={(event): void => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (!saving) close();
      }}
    >
      <form
        className="flex min-h-0 flex-col gap-3"
        aria-busy={saving}
        aria-describedby={saveFailed ? saveErrorId : undefined}
        onSubmit={(event): void => {
          event.preventDefault();
          event.stopPropagation();
          if (!saving) void save();
        }}
      >
        <Heading id={headingId} level={2} variant="title" className="shrink-0">
          Edit group
        </Heading>
        <OverlayScrollArea
          className="-m-1"
          viewportClassName="overscroll-contain"
          contentClassName="flex flex-col gap-3 p-1"
        >
          <FormField label="Group name">
            {(control) => (
              <TextInput
                {...control}
                ref={inputRef}
                value={name}
                placeholder={placeholder}
                readOnly={saving}
                data-testid="sidebar-item-group-name"
                onChange={(event): void => {
                  const nextName = event.target.value;
                  // The first custom name shows by default for an unnamed group.
                  edit({
                    name: nextName,
                    ...(!canShowName ? { labelHidden: false } : {}),
                  });
                }}
                onKeyDown={(event): void => {
                  if (
                    event.key === 'Enter' &&
                    (event.nativeEvent.isComposing || event.keyCode === 229)
                  )
                    event.preventDefault();
                }}
              />
            )}
          </FormField>
          <FormField label="Group color">
            <ColorSwatchPicker
              value={color}
              palette={SIDEBAR_ITEM_GROUP_SWATCHES}
              disabled={saving}
              onChange={(value): void => {
                const selected = SIDEBAR_ITEM_GROUP_COLORS.find(
                  (option) => option === value,
                );
                if (selected) edit({ color: selected });
              }}
              testId="sidebar-item-group-colors"
              label="Group color"
            />
          </FormField>
          <div className="flex flex-col gap-2">
            <EditorSwitchRow label="Show name in sidebar">
              <ToggleSwitch
                checked={showName}
                disabled={!canShowName || saving}
                label="Show name in sidebar"
                dataTestId="sidebar-item-group-show-name"
                onChange={(next): void => edit({ labelHidden: !next })}
              />
            </EditorSwitchRow>
            <EditorSwitchRow label="Remove group when empty">
              <ToggleSwitch
                checked={!keepWhenEmpty}
                disabled={saving}
                label="Remove group when empty"
                dataTestId="sidebar-item-group-remove-when-empty"
                onChange={(next): void => edit({ keepWhenEmpty: !next })}
              />
            </EditorSwitchRow>
          </div>
          {saveFailed && (
            <FieldError id={saveErrorId} announce>
              Group changes couldn’t be saved. Try again.
            </FieldError>
          )}
        </OverlayScrollArea>
        <div className="flex shrink-0 justify-end gap-2">
          <Button
            size="compact"
            variant="ghost"
            disabled={saving}
            onClick={close}
          >
            Cancel
          </Button>
          {/* Creating the group from the row menu already adds its members. */}
          <Button
            size="compact"
            variant="primary"
            type="submit"
            loading={saving}
            loadingLabel="Saving…"
          >
            Save changes
          </Button>
        </div>
      </form>
    </Menu>
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
   * Offer "New … in group" in the header and group menu. Default `true`.
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
    const focusTarget = closingFocusRef.current?.isConnected
      ? closingFocusRef.current
      : returnFocusRef.current;
    if (
      focusTarget &&
      focusTarget.ownerDocument.activeElement === focusTarget.ownerDocument.body
    )
      focusTarget.focus({ preventScroll: true });
  }, [editor, group.name, returnFocusRef]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Viewport top of a stuck (sticky) header when a collapse was requested.
  const stuckHeaderTop = useRef<number | null>(null);
  const toggle = (): void => {
    const root = rootRef.current;
    const top = root
      ?.querySelector<HTMLElement>('[data-sidebar-item-group-header]')
      ?.getBoundingClientRect().top;
    const topPadding = root
      ? Number.parseFloat(getComputedStyle(root).paddingTop) || 0
      : 0;
    // A sticky header has moved down from the group's content edge.
    stuckHeaderTop.current =
      !group.collapsed &&
      root &&
      top !== undefined &&
      top - root.getBoundingClientRect().top - topPadding > 1
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
      className="relative flex flex-col gap-px py-1"
      data-sidebar-item-group-id={group.id}
      data-testid={`sidebar-item-group-${group.id}`}
    >
      <span
        ref={railAnchorRef}
        aria-hidden="true"
        className="absolute -left-2 top-1 h-0 w-0"
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
          const root = rootRef.current;
          if (readOnly || !root) return;
          railAnchorRef.current?.style.setProperty(
            'top',
            `${event.clientY - root.getBoundingClientRect().top}px`,
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
            railAnchorRef.current?.style.removeProperty('top');
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
          anchorRef={anchorRef}
          returnFocusRef={focusRef}
          onClose={(restoreFocus): void => {
            closingFocusRef.current = focusRef.current;
            closingEditorRef.current = restoreFocus;
            setEditor(null);
          }}
          onSave={actions.onSave}
        />
      )}
    </div>
  );
}
