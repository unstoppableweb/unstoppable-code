import { useId, useRef, useState, type JSX } from 'react';
import {
  Dot,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  FloatingMenu,
  ListRow,
  NestedMenuFlyout,
  type DotTone,
} from '@canopy/ui-shared/components';
import {
  CheckIcon,
  ChevronDownMediumIcon,
  MacbookIcon,
  PlusIcon,
  StopIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  ADD_COMPUTER_LABEL,
  COMPUTERS_LABEL,
  remoteHostDotTone,
  type RemoteHostStatus,
} from './remote-control-display';

/** One paired computer in the picker's menu. */
export interface RemoteControlComputerRow {
  readonly deviceId: string;
  readonly name: string;
  /**
   * What it is doing right now. `null` when that is not known (a host whose
   * relay connection is down cannot see presence), so the row claims nothing.
   */
  readonly status: RemoteHostStatus | null;
}

/** The computer the host itself is, on a host that is one (desktop). */
export interface RemoteControlLocalComputer {
  readonly name: string;
  /** The trailing label, such as "This computer". */
  readonly label: string;
}

export interface RemoteControlComputerMenuItemsProps {
  readonly computers: readonly RemoteControlComputerRow[];
  readonly localComputer?: RemoteControlLocalComputer;
  /**
   * The computer to check: a device id, or `null` for the local computer.
   * Omit it in a menu whose check would never move.
   */
  readonly checked?: { readonly deviceId: string | null };
  /** A computer was chosen: a device id, or `null` for the local computer. */
  readonly onChoose: (deviceId: string | null) => void;
  readonly onAdd: () => void;
  /**
   * The last item, which stops controlling the current computer without
   * removing its pairing. Hosts that have no such action omit it.
   */
  readonly stop?: { readonly label: string; readonly onSelect: () => void };
  /** Close the menu the rows live in. */
  readonly onClose: () => void;
  /** Prefix for the rows' test ids, so each menu keeps its own. */
  readonly testIdPrefix: string;
  /** Separate "Add a computer…" from the computers with a divider. */
  readonly dividerBeforeAdd: boolean;
}

/**
 * The computers on the account, then "Add a computer…" and, where the host
 * offers it, the stop item. Shared by the desktop's remote-window picker and
 * account menu and by the web's direct Remote Control picker. Choosing a row
 * closes the menu first; the host decides what choosing means.
 */
export function RemoteControlComputerMenuItems({
  computers,
  localComputer,
  checked,
  onChoose,
  onAdd,
  stop,
  onClose,
  testIdPrefix,
  dividerBeforeAdd,
}: RemoteControlComputerMenuItemsProps): JSX.Element {
  const choose = (deviceId: string | null): void => {
    onClose();
    onChoose(deviceId);
  };
  return (
    <>
      {localComputer ? (
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={checked?.deviceId === null}
          data-testid={`${testIdPrefix}-option-local`}
          onClick={() => choose(null)}
        >
          <DropdownMenuItemIcon>
            <MacbookIcon size={16} aria-hidden="true" />
          </DropdownMenuItemIcon>
          <span
            className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate`}
            title={localComputer.name}
          >
            {localComputer.name}
          </span>
          <span className="shrink-0 text-xs fg-secondary">
            {localComputer.label}
          </span>
          {checked?.deviceId === null ? (
            <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
          ) : null}
        </DropdownMenuItem>
      ) : null}
      {computers.map((computer) => {
        const selected = checked?.deviceId === computer.deviceId;
        return (
          <DropdownMenuItem
            key={computer.deviceId}
            role="menuitemradio"
            aria-checked={selected}
            aria-label={
              computer.status
                ? `${computer.name}, ${computer.status.label}`
                : computer.name
            }
            data-testid={`${testIdPrefix}-option-${computer.deviceId}`}
            onClick={() => choose(computer.deviceId)}
          >
            <DropdownMenuItemIcon>
              <MacbookIcon size={16} aria-hidden="true" />
            </DropdownMenuItemIcon>
            <span
              className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate`}
              title={computer.name}
            >
              {computer.name}
            </span>
            {computer.status ? (
              <span className="shrink-0 text-xs fg-secondary">
                {computer.status.label}
              </span>
            ) : null}
            {selected ? (
              <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
            ) : null}
          </DropdownMenuItem>
        );
      })}
      {dividerBeforeAdd ? <DropdownMenuDivider /> : null}
      <DropdownMenuItem
        data-testid={`${testIdPrefix}-add`}
        onClick={() => {
          onClose();
          onAdd();
        }}
      >
        <DropdownMenuItemIcon>
          <PlusIcon size={16} aria-hidden="true" />
        </DropdownMenuItemIcon>
        <span className="min-w-0 flex-1 truncate">{ADD_COMPUTER_LABEL}</span>
      </DropdownMenuItem>
      {stop ? (
        <DropdownMenuItem
          data-testid={`${testIdPrefix}-stop`}
          onClick={() => {
            onClose();
            stop.onSelect();
          }}
        >
          <DropdownMenuItemIcon>
            <StopIcon size={16} aria-hidden="true" />
          </DropdownMenuItemIcon>
          <span className="min-w-0 flex-1 truncate">{stop.label}</span>
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

export interface RemoteControlComputersMenuItemProps {
  readonly computers: readonly RemoteControlComputerRow[];
  readonly localComputer?: RemoteControlLocalComputer;
  readonly onChoose: (deviceId: string | null) => void;
  readonly onAdd: () => void;
  /** Close the menu the row lives in; choosing in the submenu closes both. */
  readonly onClose: () => void;
  /** Prefix for the row's and the submenu's test ids. */
  readonly testIdPrefix: string;
}

/**
 * One account menu row, "Computers", whose submenu lists the computer rows
 * (this computer, the paired computers, then "Add a computer…"). The row
 * counts the paired computers, so a menu with none paired says nothing more
 * than the label. The submenu keeps the account menu's width: a long name
 * truncates and shows in full on hover.
 */
export function RemoteControlComputersMenuItem({
  computers,
  localComputer,
  onChoose,
  onAdd,
  onClose,
  testIdPrefix,
}: RemoteControlComputersMenuItemProps): JSX.Element {
  return (
    <NestedMenuFlyout
      label={COMPUTERS_LABEL}
      leading={<MacbookIcon size={16} aria-hidden="true" />}
      {...(computers.length > 0 ? { trailing: computers.length } : {})}
      menuWidth="compact"
      triggerTestId={testIdPrefix}
      menuTestId={`${testIdPrefix}-menu`}
      // Every row closes the account menu, which closes the submenu with it.
      closeOnSelect={false}
    >
      <RemoteControlComputerMenuItems
        computers={computers}
        {...(localComputer ? { localComputer } : {})}
        onChoose={onChoose}
        onAdd={onAdd}
        onClose={onClose}
        testIdPrefix={testIdPrefix}
        dividerBeforeAdd
      />
    </NestedMenuFlyout>
  );
}

function StatusDot({
  tone,
  testId,
}: {
  readonly tone: DotTone;
  readonly testId: string;
}): JSX.Element {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
      <Dot tone={tone} data-testid={testId} />
    </span>
  );
}

export interface RemoteControlComputerPickerProps {
  /** The computer this surface controls, as its trigger names it. */
  readonly current: {
    readonly name: string;
    readonly status: RemoteHostStatus;
  };
  readonly menu: Omit<
    RemoteControlComputerMenuItemsProps,
    'onClose' | 'testIdPrefix' | 'dividerBeforeAdd'
  >;
  /**
   * Re-enter the host sidebar's instant-feedback scope
   * (`sidebar-instant-interactions`) on the menu, which portals out of the
   * sidebar's subtree. A host without that scope leaves it off.
   */
  readonly menuInstantInteractions?: boolean;
}

/**
 * Which computer this surface controls, pinned above the account row: the
 * computer's name, its connection's status dot, and a menu to switch, add a
 * computer or (where offered) stop. The desktop shows it in a window for a
 * paired computer; the web shows it on `/chat` while it controls one.
 */
export function RemoteControlComputerPicker({
  current,
  menu,
  menuInstantInteractions = false,
}: RemoteControlComputerPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const currentDot = remoteHostDotTone(current.status.tone);
  const triggerLabel = `Computer: ${current.name}, ${current.status.label}`;

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="relative w-full min-w-0">
      <div ref={rowRef} className="flex w-full items-center gap-0">
        <ListRow
          ref={triggerRef}
          onClick={() => setOpen((value) => !value)}
          data-testid="sidebar-machine-picker"
          data-machine-mode="remote"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-label={triggerLabel}
          className="min-w-0"
          icon={<MacbookIcon size={16} aria-hidden="true" />}
          trailing={
            <span className="flex items-center gap-2">
              {currentDot ? (
                <StatusDot
                  tone={currentDot}
                  testId="sidebar-machine-picker-status"
                />
              ) : null}
              <ChevronDownMediumIcon
                size={16}
                aria-hidden="true"
                className="shrink-0 fg-secondary"
              />
            </span>
          }
        >
          <span className={REPLAY_MASK_CLASS} title={current.name}>
            {current.name}
          </span>
        </ListRow>
      </div>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={rowRef}
        returnFocusRef={triggerRef}
        placement="top-left"
        aria-label="Switch computer"
        data-testid="sidebar-machine-picker-menu"
        className={
          menuInstantInteractions ? 'sidebar-instant-interactions w-64' : 'w-64'
        }
        closeOnSelect={false}
      >
        <RemoteControlComputerMenuItems
          {...menu}
          onClose={close}
          testIdPrefix="sidebar-machine"
          dividerBeforeAdd
        />
      </FloatingMenu>
    </div>
  );
}
