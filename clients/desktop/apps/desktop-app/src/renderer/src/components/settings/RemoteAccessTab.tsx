import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/shallow';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  ConfirmDialog,
  Notice,
  NoticeButton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  RemoteControlDevices,
  type RemoteControlDevicesPorts,
  type RemoteControlFailureText,
  type RemoteControlIncomingDevices,
} from '@canopy/ui-app/remote-control';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
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
    openMachine,
    forgetDevice,
    openPairDialog,
  } = useRemoteControlStore(
    useShallow((store) => ({
      hydrated: store.hydrated,
      state: store.state,
      setAllowIncoming: store.setAllowIncoming,
      setAllowRemoteUpdates: store.setAllowRemoteUpdates,
      openMachine: store.openMachine,
      forgetDevice: store.forgetDevice,
      openPairDialog: store.openPairDialog,
    })),
  );
  const openRemoteControl = useNavigationStore(
    (store) => store.openCanopyPortal,
  );
  const [savingAllow, setSavingAllow] = useState(false);
  const [savingUpdates, setSavingUpdates] = useState(false);
  const [confirmingTurnOff, setConfirmingTurnOff] = useState(false);
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
        return failure.details === undefined
          ? { message }
          : { message, details: failure.details };
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

  if (!state.signedIn) {
    return page(
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
      </Notice>,
    );
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

  // Turning on takes effect at once; turning off disconnects paired devices,
  // so it asks first (B3).
  const toggleAllow = (next: boolean): void => {
    if (next) {
      void saveAllow(true);
      return;
    }
    setConfirmingTurnOff(true);
  };

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
        className=""
        error={error?.error}
        {...(error?.details === undefined ? {} : { details: error.details })}
        testId="settings-remote-access-error"
      />

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
            label="Let computers that control this one update it"
            description="A paired computer can install this computer's updates. It restarts once nothing is running, and you can cancel from the update prompt here."
            htmlFor="settings-remote-access-allow-updates"
            dataTestId="settings-remote-access-allow-updates-row"
            control={
              <ToggleSwitch
                id="settings-remote-access-allow-updates"
                checked={state.allowIncoming && state.allowRemoteUpdates}
                label="Let computers that control this one update it"
                dataTestId="settings-remote-access-allow-updates"
                disabled={savingUpdates || !state.allowIncoming}
                onChange={toggleRemoteUpdates}
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
    </>,
  );
}
