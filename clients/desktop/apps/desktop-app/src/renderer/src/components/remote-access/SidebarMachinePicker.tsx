import { type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { DropdownMenuDivider } from '@canopy/ui-shared/components';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  RemoteControlComputerPicker,
  RemoteControlComputersMenuItem,
  remoteHostStatus,
  type RemoteControlComputerMenuItemsProps,
  type RemoteHostStatus,
} from '@canopy/ui-app/remote-control';
import { THIS_COMPUTER_LABEL, describeError } from './remote-access-copy';

export interface SidebarMachinePickerProps {
  /**
   * Re-enter the desktop sidebar's instant-feedback scope by name, as the
   * account row's menu does: the menu portals out of the sidebar's subtree.
   */
  readonly menuInstantInteractions?: boolean;
}

/**
 * The shared menu rows for this computer's windows: this computer, then the
 * paired computers, then "Add a computer…". Choosing a computer opens or
 * focuses its window; choosing this computer focuses the main window.
 */
function useComputerMenu(): {
  /** The computer this window shows; `null` in this computer's windows. */
  readonly shownId: string | null;
  readonly menu: Omit<
    RemoteControlComputerMenuItemsProps,
    'onClose' | 'testIdPrefix' | 'dividerBeforeAdd' | 'checked'
  >;
} {
  const { context, state, openMachine, openPairDialog } = useRemoteControlStore(
    useShallow((store) => ({
      context: store.context,
      state: store.state,
      openMachine: store.openMachine,
      openPairDialog: store.openPairDialog,
    })),
  );
  const shownId = context.mode === 'remote' ? context.deviceId : null;

  const onChoose = (deviceId: string | null): void => {
    // Choosing the computer already shown only matters to reconnect it.
    const shownHost =
      shownId === null
        ? null
        : (state.hosts.find((host) => host.deviceId === shownId) ?? null);
    const reconnectable =
      shownHost !== null &&
      (shownHost.connection === 'error' || shownHost.connection === 'idle');
    if (deviceId === shownId && !reconnectable) return;
    void openMachine(deviceId).catch((cause: unknown) => {
      useGitHubStore
        .getState()
        .addToast(
          describeError(cause, "Couldn't open that computer. Try again."),
          'error',
        );
    });
  };

  return {
    shownId,
    menu: {
      computers: state.hosts.map((host) => ({
        deviceId: host.deviceId,
        name: host.name,
        status: remoteHostStatus(host),
      })),
      localComputer: {
        name: state.thisDevice?.name ?? THIS_COMPUTER_LABEL,
        label: THIS_COMPUTER_LABEL,
      },
      onChoose,
      onAdd: openPairDialog,
    },
  };
}

/**
 * The Computers row of this computer's account menu, between the account's
 * own rows and Sign out, with the computers in its submenu. This computer's
 * sidebar has no picker, so switching to a paired computer starts here.
 * Rendered only in this computer's own windows while remote access is
 * available and signed in; ends with a divider before Sign out.
 */
export function AccountMenuComputersItem({
  onClose,
}: {
  readonly onClose: () => void;
}): JSX.Element | null {
  const { local, ready } = useRemoteControlStore(
    useShallow((store) => ({
      local: store.context.mode === 'local',
      ready: store.state.available && store.state.signedIn,
    })),
  );
  const { menu } = useComputerMenu();
  if (!local || !ready) return null;
  return (
    <>
      <RemoteControlComputersMenuItem
        {...menu}
        onClose={onClose}
        testIdPrefix="sidebar-account-menu-computers"
      />
      <DropdownMenuDivider />
    </>
  );
}

/**
 * Which computer a remote window shows, pinned above the account row beside
 * the Personal/organization picker: both answer "whose work am I looking at".
 *
 * Only a window opened for a paired computer renders it, with the
 * connection's status dot on the trigger. This computer's own windows reach
 * the same computers from the account menu instead
 * ({@link AccountMenuComputersItem}), so their sidebar looks as it does
 * with remote access off. The presentation is the shared
 * `RemoteControlComputerPicker`, which the web mounts too.
 */
export function SidebarMachinePicker({
  menuInstantInteractions = false,
}: SidebarMachinePickerProps): JSX.Element | null {
  const { context, state } = useRemoteControlStore(
    useShallow((store) => ({
      context: store.context,
      state: store.state,
    })),
  );
  const { shownId, menu } = useComputerMenu();

  if (!state.available || !state.signedIn || context.mode !== 'remote') {
    return null;
  }

  const remote = context;
  const currentHost =
    state.hosts.find((host) => host.deviceId === remote.deviceId) ?? null;
  // The trigger reports this window's own connection; the host row may be
  // missing for a moment after a removal, which reads as not connected.
  const currentStatus: RemoteHostStatus = remoteHostStatus(
    currentHost ?? { online: false, connection: 'error' },
  );

  return (
    <RemoteControlComputerPicker
      current={{
        name: currentHost?.name ?? remote.name,
        status: currentStatus,
      }}
      menu={{ ...menu, checked: { deviceId: shownId } }}
      menuInstantInteractions={menuInstantInteractions}
    />
  );
}
