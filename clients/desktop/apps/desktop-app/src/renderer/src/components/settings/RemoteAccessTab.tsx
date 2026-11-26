import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/shallow';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  ConfirmDialog,
  Notice,
  NoticeButton,
  REMOTE_UPDATES_SWITCH_LABEL,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  RemoteControlDevices,
  type RemoteControlDevicesPorts,
  type RemoteControlFailureText,
  type RemoteControlIncomingDevices,
} from '@canopy/ui-app/remote-control';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { useRemoteWebPreviewEnabled } from '@/hooks/useRemoteWebPreviewEnabled';
import { ALLOW_INCOMING_LABEL } from '@/components/remote-access/remote-access-copy';
import { useNavigationStore } from '@/stores/navigationStore';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import {
  inlineFailure,
  inlineFailureText,
  type InlineFailure,
} from '@/lib/inline-app-error';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from './SettingsLayout';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';

/**
 * B1 copy (CAN-5985). The helper names both ways to pair: holding the link
 * pairs without a second prompt, a code needs approval here.
 */
const PAGE_DESCRIPTION =
  'Control this computer from your other devices, or control your other computers from here.';
const ALLOW_INCOMING_HELPER =
  'A paired device can see and change everything on this computer, including running commands. Pair using the QR code or link, or approve a matching code on this computer.';
/** B3: turning Remote Control off keeps every pairing. */
const TURN_OFF_MESSAGE =
  "Paired devices disconnect now and can't reconnect until you turn it back on. Their pairings are kept.";
/**
 * Inventory sync (CAN-5986): a data-sharing opt-out, paused while Allow
 * incoming is off. Turning it off removes this computer's synced lists from
 * the web for the signed-in account, so it asks first. The tab renders only
 * while signed in, and main falls back to the last account signed in here
 * if the sign-in ended meanwhile, so the confirmation can always say the
 * lists are removed. Turning it off stays available while Allow incoming
 * is off; only turning it on waits for Allow incoming.
 */
const INVENTORY_SYNC_LABEL = 'Sync lists to the web';
const INVENTORY_SYNC_HELPER =
  "Show this computer's plugin, MCP server and pipeline lists on the web while your other devices can control it. Only the lists are shared, not files or credentials.";
// Shown only while the switch is on but nothing syncs, so an on switch
// isn't read as syncing now.
const INVENTORY_SYNC_PAUSED =
  "Paused while your other devices can't control this computer.";
// The agent approval card repeats this message and the dialog's title from
// main: keep main/agent-actions/desktop-inventory-sync-port.ts in step.
const INVENTORY_SYNC_TURN_OFF_MESSAGE =
  "This computer's synced plugin, MCP server and pipeline lists are removed from the web. Turn it back on to sync them again.";
/**
 * Web preview consent (CAN-7712): off until turned on, and the helper
 * says so first, since turning it on lets another computer in. "Local web
 * servers" names what people run; "(localhost)" says which ones, since only
 * this computer's own addresses are reachable, not the network's. "Paired
 * computers" matches the pairing list below; only paired desktop computers
 * can use it.
 */
const WEB_PREVIEW_LABEL =
  "Let paired computers open this computer's local web servers (localhost)";
const WEB_PREVIEW_HELPER =
  'Off by default. When on, a paired computer can open sites this computer serves on localhost, such as a dev server, in its own browser. Other addresses on your network stay out of reach, and servers this app runs for itself are never shared.';
/**
 * The saved web preview choice couldn't be read, so preview is off for now,
 * but an earlier opt-in may still be in the file and come back after a
 * restart. The switch shows off, so it could only turn preview on; this
 * notice's button is how the person saves off.
 */
const WEB_PREVIEW_UNREAD_TITLE = "Couldn't read your saved web preview choice";
const WEB_PREVIEW_UNREAD_MESSAGE =
  'Web preview is off for now, but an earlier choice to allow it may come back after a restart. Turn it off to save that.';
// One status covers both failure paths: a transient failure retries on a
// timer, and a refused one (401/403) retries once you sign in again, so the
// copy names both instead of promising an automatic retry.
const INVENTORY_DELETE_FAILED =
  "Couldn't remove this computer's lists from the web yet. It tries again later, or after you sign in again.";

/**
 * Settings → Remote Control: the single opt-in that lets this account's
 * other devices control this computer, the devices that can, and the
 * computers this one can control. Main owns every value; each action
 * returns the new state, which the store applies.
 */
export function RemoteAccessTab(): JSX.Element {
  const {
    hydrated,
    state,
    setAllowIncoming,
    setAllowRemoteUpdates,
    setAllowWebPreview,
    setInventorySyncEnabled,
    openMachine,
    forgetDevice,
    openPairDialog,
  } = useRemoteControlStore(
    useShallow((store) => ({
      hydrated: store.hydrated,
      state: store.state,
      setAllowIncoming: store.setAllowIncoming,
      setAllowRemoteUpdates: store.setAllowRemoteUpdates,
      setAllowWebPreview: store.setAllowWebPreview,
      setInventorySyncEnabled: store.setInventorySyncEnabled,
      openMachine: store.openMachine,
      forgetDevice: store.forgetDevice,
      openPairDialog: store.openPairDialog,
    })),
  );
  const openRemoteControl = useNavigationStore(
    (store) => store.openRemoteControlDialog,
  );
  const [savingAllow, setSavingAllow] = useState(false);
  const [savingUpdates, setSavingUpdates] = useState(false);
  const [savingWebPreview, setSavingWebPreview] = useState(false);
  const webPreviewEnabled = useRemoteWebPreviewEnabled();
  const [savingInventorySync, setSavingInventorySync] = useState(false);
  const [confirmingTurnOff, setConfirmingTurnOff] = useState(false);
  const [confirmingInventoryOff, setConfirmingInventoryOff] = useState(false);
  const [error, setError] = useState<InlineFailure | null>(null);
  const devicePorts = useMemo<RemoteControlDevicesPorts>(
    () => ({
      openHost: openMachine,
      removeDevice: forgetDevice,
      connectComputer: openPairDialog,
      reportActionFailure: (failure): void => {
        if (failure === null) {
          setError(null);
          return;
        }
        const appError = toAppError(resolveClientAppError(failure.cause));
        if (appError) setError(inlineFailure(appError, failure.fallback));
      },
      describeRemovalFailure: (
        cause,
        fallback,
      ): RemoteControlFailureText | null => {
        const appError = toAppError(resolveClientAppError(cause));
        if (!appError) return null;
        const failure = inlineFailure(appError, fallback);
        const message = inlineFailureText(failure);
        if (message === null) return null;
        return {
          message,
          ...(failure.details === undefined
            ? {}
            : { details: failure.details }),
          ...(appError.recordedBy === undefined
            ? {}
            : { recorded: true as const }),
        };
      },
    }),
    [openMachine, forgetDevice, openPairDialog],
  );
  const incoming = useMemo<RemoteControlIncomingDevices>(
    () => ({
      controllers: state.controllers,
      // The Remote Control dialog opens the pairing window, or offers to
      // turn Remote Control on first.
      pairDevice: openRemoteControl,
    }),
    [state.controllers, openRemoteControl],
  );

  const page = (children: ReactNode): JSX.Element => (
    <SettingsPage
      title={REMOTE_CONTROL_LABEL}
      description={PAGE_DESCRIPTION}
      dataTestId="settings-tab-remote-access"
    >
      {children}
    </SettingsPage>
  );

  if (!hydrated) {
    return page(<SettingsLoading variant="spinner" />);
  }

  const saveAllow = (next: boolean): Promise<void> => {
    setSavingAllow(true);
    setError(null);
    return setAllowIncoming(next)
      .catch((cause: unknown) => {
        const appError = toAppError(resolveClientAppError(cause));
        if (appError)
          setError(inlineFailure(appError, "Couldn't save the setting."));
      })
      .finally(() => setSavingAllow(false));
  };

  const toggleRemoteUpdates = (next: boolean): void => {
    setSavingUpdates(true);
    setError(null);
    void setAllowRemoteUpdates(next)
      .catch((cause: unknown) => {
        const appError = toAppError(resolveClientAppError(cause));
        if (appError)
          setError(inlineFailure(appError, "Couldn't save the setting."));
      })
      .finally(() => setSavingUpdates(false));
  };

  const toggleWebPreview = (next: boolean): void => {
    setSavingWebPreview(true);
    setError(null);
    void setAllowWebPreview(next)
      .catch((cause: unknown) => {
        const appError = toAppError(resolveClientAppError(cause));
        if (appError)
          setError(inlineFailure(appError, "Couldn't save the setting."));
      })
      .finally(() => setSavingWebPreview(false));
  };

  const saveInventorySync = (next: boolean): Promise<void> => {
    setSavingInventorySync(true);
    setError(null);
    return setInventorySyncEnabled(next)
      .catch((cause: unknown) => {
        const appError = toAppError(resolveClientAppError(cause));
        if (appError)
          setError(inlineFailure(appError, "Couldn't save the setting."));
      })
      .finally(() => setSavingInventorySync(false));
  };

  // Turning sync on re-syncs at once; turning it off deletes the synced
  // lists from the web, so it asks first.
  const toggleInventorySync = (next: boolean): void => {
    if (next) {
      void saveInventorySync(true);
      return;
    }
    setConfirmingInventoryOff(true);
  };

  // Hosts that predate the field omit it; absent reads as on.
  const inventorySyncEnabled = state.inventorySyncEnabled ?? true;

  // Turning on takes effect at once; turning off disconnects paired devices,
  // so it asks first (B3).
  const toggleAllow = (next: boolean): void => {
    if (next) {
      void saveAllow(true);
      return;
    }
    setConfirmingTurnOff(true);
  };

  // Shown whatever the flag, and signed out too: an opt-in left in the file
  // would come back once the flag and the read both work, so saving off
  // can't wait for either.
  const unreadNotice =
    state.webPreviewChoiceUnread === true ? (
      <Notice
        intent="attention"
        title={WEB_PREVIEW_UNREAD_TITLE}
        data-testid="settings-remote-access-web-preview-unread"
        actions={
          <NoticeButton
            variant="primary"
            data-testid="settings-remote-access-web-preview-turn-off"
            disabled={savingWebPreview}
            onClick={() => toggleWebPreview(false)}
          >
            Turn off
          </NoticeButton>
        }
      >
        {WEB_PREVIEW_UNREAD_MESSAGE}
      </Notice>
    ) : null;

  if (!state.signedIn) {
    return page(
      <>
        <Notice
          intent="attention"
          title="Sign in to pair devices"
          data-testid="settings-remote-access-signed-out"
          actions={
            <NoticeButton
              variant="primary"
              onClick={() => openCloudAccountSettings()}
            >
              Open account settings
            </NoticeButton>
          }
        >
          Every device you pair must be signed in to the same account.
        </Notice>
        {unreadNotice}
        {/* A failed save from the notice shows here too. */}
        <DesktopErrorBanner
          errorSource="settings-remote-access-error"
          className=""
          error={error?.error}
          {...(error?.details === undefined ? {} : { details: error.details })}
          testId="settings-remote-access-error"
        />
      </>,
    );
  }

  return page(
    <>
      {state.relayStatus === 'unavailable' ? (
        <Notice
          intent="attention"
          title="Can't reach the connection service"
          data-testid="settings-remote-access-unavailable"
        >
          Paired devices can't connect until it's back. Retrying automatically.
        </Notice>
      ) : null}
      <DesktopErrorBanner
        errorSource="settings-remote-access-error"
        className=""
        error={error?.error}
        {...(error?.details === undefined ? {} : { details: error.details })}
        testId="settings-remote-access-error"
      />
      {state.inventoryDeleteStatus === 'failed' ? (
        <DesktopErrorBanner
          errorSource="settings-remote-access-inventory-delete-error"
          className=""
          error={INVENTORY_DELETE_FAILED}
          testId="settings-remote-access-inventory-delete-error"
        />
      ) : null}

      {unreadNotice}
      <SettingsSection>
        <SettingsGroup>
          <SettingsRow
            label={ALLOW_INCOMING_LABEL}
            description={ALLOW_INCOMING_HELPER}
            htmlFor="settings-remote-access-allow-incoming"
            dataTestId="settings-remote-access-allow-row"
            control={
              <ToggleSwitch
                id="settings-remote-access-allow-incoming"
                checked={state.allowIncoming}
                label={ALLOW_INCOMING_LABEL}
                dataTestId="settings-remote-access-allow-incoming"
                disabled={savingAllow}
                onChange={toggleAllow}
              />
            }
          />
          <SettingsRow
            label={REMOTE_UPDATES_SWITCH_LABEL}
            description="A paired computer can install this computer's updates. It restarts once nothing is running, and you can cancel from the update prompt here."
            htmlFor="settings-remote-access-allow-updates"
            dataTestId="settings-remote-access-allow-updates-row"
            control={
              <ToggleSwitch
                id="settings-remote-access-allow-updates"
                checked={state.allowIncoming && state.allowRemoteUpdates}
                label={REMOTE_UPDATES_SWITCH_LABEL}
                dataTestId="settings-remote-access-allow-updates"
                disabled={savingUpdates || !state.allowIncoming}
                onChange={toggleRemoteUpdates}
              />
            }
          />
          {webPreviewEnabled ? (
            <SettingsRow
              label={WEB_PREVIEW_LABEL}
              description={WEB_PREVIEW_HELPER}
              htmlFor="settings-remote-access-allow-web-preview"
              dataTestId="settings-remote-access-allow-web-preview-row"
              control={
                <ToggleSwitch
                  id="settings-remote-access-allow-web-preview"
                  checked={state.allowIncoming && state.allowWebPreview}
                  label={WEB_PREVIEW_LABEL}
                  dataTestId="settings-remote-access-allow-web-preview"
                  disabled={savingWebPreview || !state.allowIncoming}
                  onChange={toggleWebPreview}
                />
              }
            />
          ) : null}
          <SettingsRow
            label={INVENTORY_SYNC_LABEL}
            description={
              !state.allowIncoming && inventorySyncEnabled
                ? `${INVENTORY_SYNC_HELPER} ${INVENTORY_SYNC_PAUSED}`
                : INVENTORY_SYNC_HELPER
            }
            htmlFor="settings-remote-access-inventory-sync"
            dataTestId="settings-remote-access-inventory-sync-row"
            control={
              <ToggleSwitch
                id="settings-remote-access-inventory-sync"
                checked={inventorySyncEnabled}
                label={INVENTORY_SYNC_LABEL}
                dataTestId="settings-remote-access-inventory-sync"
                // Turning it off (and deleting) never waits for Allow
                // incoming; turning it on does.
                disabled={
                  savingInventorySync ||
                  (!state.allowIncoming && !inventorySyncEnabled)
                }
                onChange={toggleInventorySync}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <RemoteControlDevices
        hosts={state.hosts}
        incoming={incoming}
        ports={devicePorts}
        testIdPrefix="settings-remote-access"
      />

      {confirmingTurnOff ? (
        <ConfirmDialog
          title={`Turn off ${REMOTE_CONTROL_LABEL}?`}
          message={TURN_OFF_MESSAGE}
          confirmLabel="Turn off"
          busyLabel="Turning off…"
          busy={savingAllow}
          destructive
          onConfirm={() => {
            void saveAllow(false).finally(() => setConfirmingTurnOff(false));
          }}
          onCancel={() => setConfirmingTurnOff(false)}
          confirmTestId="settings-remote-access-turn-off-confirm"
          dataTestId="settings-remote-access-turn-off-dialog"
        />
      ) : null}
      {confirmingInventoryOff ? (
        <ConfirmDialog
          title="Stop syncing lists to the web?"
          message={INVENTORY_SYNC_TURN_OFF_MESSAGE}
          confirmLabel="Turn off"
          busyLabel="Turning off…"
          busy={savingInventorySync}
          destructive
          onConfirm={() => {
            void saveInventorySync(false).finally(() =>
              setConfirmingInventoryOff(false),
            );
          }}
          onCancel={() => setConfirmingInventoryOff(false)}
          confirmTestId="settings-remote-access-inventory-sync-off-confirm"
          dataTestId="settings-remote-access-inventory-sync-off-dialog"
        />
      ) : null}
    </>,
  );
}
