import { useRef, useState, type JSX, type ReactNode } from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  Button,
  DropdownMenuItemIcon,
  DropdownMenuLinkItem,
  DropdownMenuSurface,
  FloatingMenu,
  SPACE_NOTIFICATION_MENU_COPY,
  SPACE_NOTIFICATION_MENU_HEADING,
  SpaceNotificationMenuRowIcon,
  spaceNotificationMenuChoices,
  spaceNotificationMenuStatus,
  type ActionMenuItem,
  type SpaceNotificationMenuChoice,
  type SpaceNotificationMenuState,
} from '@canopy/ui-shared/components';
import {
  ArchiveIcon,
  ChevronTopMediumIcon,
  CloseIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  LoginIcon,
  MinusIcon,
  PencilIcon,
  PinIcon,
  SettingsIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

/**
 * The Menus sheet. Each menu is one the product draws (a chat row's menu, a
 * sidebar group's, a space's Notifications group) and shows one thing. The
 * menus sit open on the page, sized as a real menu is (as wide as the longest
 * row, between 160px and 320px), so a state reads without a click; the last
 * panel opens one from a button.
 */

const noop = (): void => undefined;

/**
 * A menu drawn open in the page, in the action menus' row style. It is a
 * picture of a menu, not one: nothing opens or dismisses it, so it is a
 * labelled group rather than a `menu` (a real menu is a `FloatingMenu`, as
 * in the last panel).
 */
function OpenMenu({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <ActionMenuRowStyle>
      <div className="w-max max-w-80 min-w-40">
        <DropdownMenuSurface role="group" aria-label="Menu preview">
          {children}
        </DropdownMenuSurface>
      </div>
    </ActionMenuRowStyle>
  );
}

function ItemsMenu({
  items,
}: {
  readonly items: readonly ActionMenuItem[];
}): JSX.Element {
  return (
    <OpenMenu>
      <ActionMenuItems items={items} onSelect={noop} />
    </OpenMenu>
  );
}

const CHAT_ROW_ITEMS: readonly ActionMenuItem[] = [
  { key: 'rename', label: 'Rename', icon: <PencilIcon />, shortcut: 'F2' },
  { key: 'copy', label: 'Copy link', icon: <CopyIcon /> },
  { key: 'pin', label: 'Pin to top', icon: <PinIcon /> },
  {
    key: 'archive',
    label: 'Archive',
    icon: <ArchiveIcon />,
    disabled: true,
    tooltip: 'Finish the running turn first',
  },
  {
    key: 'close',
    label: 'Close',
    icon: <CloseIcon />,
    separatorBefore: true,
  },
  { key: 'close-others', label: 'Close others', icon: <CloseIcon /> },
  { key: 'close-right', label: 'Close to the right', icon: <CloseIcon /> },
  {
    key: 'delete',
    label: 'Delete chat…',
    icon: <TrashIcon />,
    tone: 'destructive',
    separatorBefore: true,
  },
];

/** A sidebar group's rows, under the group's name and a "Move to" label. */
const GROUP_ITEMS: readonly ActionMenuItem[] = [
  { key: 'group-name', kind: 'label', label: 'Design', icon: null },
  { key: 'group-edit', label: 'Edit group…', icon: <SettingsIcon /> },
  {
    key: 'group-collapse',
    label: 'Collapse group',
    icon: <ChevronTopMediumIcon />,
  },
  { key: 'group-remove', label: 'Remove from group', icon: <MinusIcon /> },
  {
    key: 'group-move',
    kind: 'label',
    label: 'Move to',
    icon: null,
    separatorBefore: true,
  },
  { key: 'group-backend', label: 'Backend', icon: <FolderIcon /> },
  { key: 'group-docs', label: 'Docs', icon: <FolderIcon /> },
  { key: 'group-new', label: 'New group', icon: <FolderPlusIcon /> },
];

const SUBMENU_ITEMS: readonly ActionMenuItem[] = [
  { key: 'sub-pin', label: 'Pin to top', icon: <PinIcon /> },
  {
    key: 'sub-group',
    kind: 'submenu',
    label: 'Group',
    icon: <FolderIcon />,
    submenu: GROUP_ITEMS,
  },
  { key: 'sub-archive', label: 'Archive', icon: <ArchiveIcon /> },
];

const LONG_LABEL_ITEMS: readonly ActionMenuItem[] = [
  {
    key: 'long-open',
    label: 'Open fix-sidebar-zoom-at-200-percent in a new window',
    icon: <CopyIcon />,
  },
  {
    key: 'long-delete',
    label: 'Delete this chat and every file it created in the project',
    icon: <TrashIcon />,
    tone: 'destructive',
    separatorBefore: true,
  },
];

const CHOICE_BY_KEY: Readonly<Record<string, SpaceNotificationMenuChoice>> = {
  'notify-all': null,
  'notify-attention': 'attention',
  'notify-mute': 'mute',
};

/**
 * The Notifications group as the sidebar's menus build it: the three choices
 * as radio rows, the check (or the pending save's spinner) in the icon
 * column, and one status line closing the group.
 */
function notificationItems(
  state: SpaceNotificationMenuState,
): readonly ActionMenuItem[] {
  const rows = spaceNotificationMenuChoices(state);
  const status = spaceNotificationMenuStatus(state);
  return rows.map(
    (row, index): ActionMenuItem => ({
      key: row.key,
      label: row.label,
      icon: <SpaceNotificationMenuRowIcon row={row} />,
      role: 'menuitemradio',
      checked: row.checked,
      busy: row.pending,
      disabled: row.disabled,
      tooltip: row.description,
      sectionLabel: index === 0 ? SPACE_NOTIFICATION_MENU_HEADING : undefined,
      sectionStatus: index === rows.length - 1 ? status : undefined,
    }),
  );
}

function NotificationsMenu({
  state,
}: {
  readonly state: SpaceNotificationMenuState;
}): JSX.Element {
  return <ItemsMenu items={notificationItems(state)} />;
}

/** The saved state, live: choosing a row moves the check. */
function LiveNotificationsMenu(): JSX.Element {
  const [override, setOverride] =
    useState<SpaceNotificationMenuChoice>('attention');
  return (
    <OpenMenu>
      <ActionMenuItems
        items={notificationItems({ status: 'ready', override })}
        onSelect={(item): void => {
          const choice = CHOICE_BY_KEY[item.key];
          if (choice !== undefined) setOverride(choice);
        }}
      />
    </OpenMenu>
  );
}

function ButtonMenu(): JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  return (
    <SpecimenCell
      label={
        last ? `Chose ${last}` : 'Opens under its button and closes on a choice'
      }
    >
      <ActionMenuRowStyle>
        <Button
          ref={anchorRef}
          size="compact"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(): void => setOpen((current) => !current)}
        >
          Chat actions
        </Button>
        <FloatingMenu open={open} onOpenChange={setOpen} anchorRef={anchorRef}>
          <ActionMenuItems
            items={CHAT_ROW_ITEMS}
            onSelect={(item): void => {
              setLast(item.label);
              setOpen(false);
            }}
          />
        </FloatingMenu>
      </ActionMenuRowStyle>
    </SpecimenCell>
  );
}

export function MenusSheet(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="Rows"
        hint="An icon on every row, groups split by a divider, removal last"
      >
        <SpecimenGrid min={280}>
          <SpecimenCell label="Actions, a shortcut, a disabled row, and Close sharing one icon">
            <ItemsMenu items={CHAT_ROW_ITEMS} />
          </SpecimenCell>
          <SpecimenCell label="Label rows name a group of rows">
            <ItemsMenu items={GROUP_ITEMS} />
          </SpecimenCell>
          <SpecimenCell label="A submenu opens beside its row">
            <ItemsMenu items={SUBMENU_ITEMS} />
          </SpecimenCell>
          <SpecimenCell label="A long label ends in an ellipsis">
            <ItemsMenu items={LONG_LABEL_ITEMS} />
          </SpecimenCell>
          <SpecimenCell label="A row that navigates is a link">
            <OpenMenu>
              <DropdownMenuLinkItem href="#components-lab">
                <DropdownMenuItemIcon>
                  <LoginIcon />
                </DropdownMenuItemIcon>
                Sign in
              </DropdownMenuLinkItem>
            </OpenMenu>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="A choice group"
        hint="The check sits in the icon column, and one status line closes the group"
      >
        <SpecimenGrid min={280}>
          <SpecimenCell label="Saved: choose a row to move the check">
            <LiveNotificationsMenu />
          </SpecimenCell>
          <SpecimenCell label="Saving: a spinner in the check's place">
            <NotificationsMenu
              state={{
                status: 'saving',
                override: 'attention',
                pendingChoice: 'mute',
              }}
            />
          </SpecimenCell>
          <SpecimenCell label="The save failed">
            <NotificationsMenu
              state={{
                status: 'failed',
                override: 'attention',
                selectionKnown: true,
                failure: SPACE_NOTIFICATION_MENU_COPY.deliveryInProgress,
              }}
            />
          </SpecimenCell>
          <SpecimenCell label="Reading the saved choice">
            <NotificationsMenu state={{ status: 'loading', override: null }} />
          </SpecimenCell>
          <SpecimenCell label="Read-only, with the reason">
            <NotificationsMenu
              state={{
                status: 'ready',
                override: null,
                disabledReason: SPACE_NOTIFICATION_MENU_COPY.signIn,
              }}
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Opened from a button">
        <SpecimenGrid min={280}>
          <ButtonMenu />
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
