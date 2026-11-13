'use client';

import { useState, type JSX } from 'react';
import type { DeviceKind, DevicePlatform } from '@canopy/protocol/device-relay';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dot,
  SettingsButtonRow,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
} from '@canopy/ui-shared/components';
import { formatDate } from '@canopy/ui-shared/lib';
import {
  ADD_COMPUTER_ROW_LABEL,
  HOSTED_CONTROLLER_LIMITS,
  PAIR_DEVICE_LABEL,
  deviceKindLabel,
  remoteHostDotTone,
  remoteHostStatus,
  type RemoteControlHostConnection,
} from './remote-control-display';

/** A computer this device has paired with and can control. */
export interface RemoteControlHostRow {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  readonly online: boolean;
  readonly connection: RemoteControlHostConnection;
  readonly error: string | null;
}

/** A live session a hosted agents root opened through a delegation. */
export interface RemoteControlHostedSessionRow {
  readonly deviceId: string;
  /** ISO timestamp. */
  readonly expiresAt: string;
}

/** A device paired to control this computer. */
export interface RemoteControlControllerRow {
  readonly deviceId: string;
  readonly name: string;
  /** The relay-authenticated controller kind the pairing is held to. */
  readonly kind: DeviceKind;
  /** ISO timestamp. */
  readonly pairedAt: string;
  /** Whether it is controlling this computer right now. */
  readonly connected: boolean;
  /**
   * Live delegated sessions of a hosted agents root. They count as the
   * root's own live state: the row shows Connected while any is open.
   */
  readonly hostedSessions: readonly RemoteControlHostedSessionRow[];
}

/** Which pairing a removal ends. */
export interface RemoteControlDeviceTarget {
  readonly deviceId: string;
  readonly role: 'host' | 'controller';
}

/** A failed row action, for the host's own error presentation. */
export interface RemoteControlActionFailure {
  readonly cause: unknown;
  /** Our sentence for the action, used when the cause has none of its own. */
  readonly fallback: string;
}

/** A failure as the removal confirmation shows it. */
export interface RemoteControlFailureText {
  readonly message: string;
  /** The raw reason, copied on request and never rendered. */
  readonly details?: string;
}

/**
 * The devices that can control this computer, for a host that accepts
 * incoming control. A host that never does (a browser) leaves it out, and
 * the section is not drawn.
 */
export interface RemoteControlIncomingDevices {
  readonly controllers: readonly RemoteControlControllerRow[];
  /** Opens pairing so another device can control this computer. */
  readonly pairDevice: () => void;
}

/**
 * What the device lists need from their host. Every action resolves once the
 * host has applied the new state; the lists re-render from the new rows.
 */
export interface RemoteControlDevicesPorts {
  readonly openHost: (deviceId: string) => Promise<void>;
  readonly removeDevice: (target: RemoteControlDeviceTarget) => Promise<void>;
  /** Opens the flow that pairs this device with a computer to control. */
  readonly connectComputer: () => void;
  /** Clears (null) or reports a failed row action on the host's page. */
  readonly reportActionFailure: (
    failure: RemoteControlActionFailure | null,
  ) => void;
  /** The confirmation's inline error for a failed removal; null shows none. */
  readonly describeRemovalFailure: (
    cause: unknown,
    fallback: string,
  ) => RemoteControlFailureText | null;
}

export interface RemoteControlDevicesProps {
  readonly hosts: readonly RemoteControlHostRow[];
  /** Absent where this device can't be controlled; the section is hidden. */
  readonly incoming?: RemoteControlIncomingDevices;
  readonly ports: RemoteControlDevicesPorts;
  /** Prefix for the lists' test ids (`<prefix>-hosts`, `-controllers`, ...). */
  readonly testIdPrefix: string;
}

type PendingRemoval =
  | { readonly role: 'host'; readonly device: RemoteControlHostRow }
  | {
      readonly role: 'controller';
      readonly device: RemoteControlControllerRow;
    };

/** A hosted root is live while any delegated session is (CAN-5985). */
function controllerLive(controller: RemoteControlControllerRow): boolean {
  return controller.connected || controller.hostedSessions.length > 0;
}

/**
 * The confirmation button repeats the title's verb and names the device's
 * kind (docs/ux-writing/confirmations.md); a computer you control is always
 * a computer.
 */
function removeConfirmLabel(removal: PendingRemoval): string {
  if (removal.role === 'host') return 'Remove computer';
  return `Remove ${deviceKindLabel(removal.device.kind).toLowerCase()}`;
}

function hostDescription(host: RemoteControlHostRow): string {
  const status = remoteHostStatus(host);
  return host.connection === 'error' && host.error
    ? `${status.label}. ${host.error}`
    : status.label;
}

/**
 * The Remote Control device lists: the devices that can control this
 * computer, with the way to pair another, and the computers this device can
 * control, with the way to connect to another. Removing either kind of
 * pairing asks first.
 */
export function RemoteControlDevices({
  hosts,
  incoming,
  ports,
  testIdPrefix,
}: RemoteControlDevicesProps): JSX.Element {
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(
    null,
  );
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] =
    useState<RemoteControlFailureText | null>(null);

  const openHost = (deviceId: string): void => {
    setBusyDevice(deviceId);
    ports.reportActionFailure(null);
    void ports
      .openHost(deviceId)
      .catch((cause: unknown) => {
        ports.reportActionFailure({
          cause,
          fallback: "Couldn't open that computer.",
        });
      })
      .finally(() => setBusyDevice(null));
  };

  const askToRemove = (removal: PendingRemoval): void => {
    setRemoveError(null);
    setPendingRemoval(removal);
  };

  const confirmRemoval = (): void => {
    if (!pendingRemoval) return;
    setRemoving(true);
    setRemoveError(null);
    void ports
      .removeDevice({
        deviceId: pendingRemoval.device.deviceId,
        role: pendingRemoval.role,
      })
      .then(() => setPendingRemoval(null))
      .catch((cause: unknown) => {
        setRemoveError(
          ports.describeRemovalFailure(
            cause,
            pendingRemoval.role === 'host'
              ? "Couldn't remove the computer."
              : "Couldn't remove the device.",
          ),
        );
      })
      .finally(() => setRemoving(false));
  };

  return (
    <>
      {incoming ? (
        <SettingsRowsSection
          title="Devices that can control this computer"
          dataTestId={`${testIdPrefix}-controllers`}
        >
          <SettingsRowsGroup>
            {/* The section's action is its first row: a settings heading
                holds only text (SettingsRowsSection). */}
            <SettingsButtonRow
              label={PAIR_DEVICE_LABEL}
              trailing="open"
              onClick={incoming.pairDevice}
              data-testid={`${testIdPrefix}-pair-device`}
            />
            {incoming.controllers.map((controller) => {
              const kind = deviceKindLabel(controller.kind);
              const paired = `${kind} · Paired ${formatDate(controller.pairedAt)}`;
              return (
                <SettingsRowsRow
                  key={controller.deviceId}
                  dataTestId={`${testIdPrefix}-controller-${controller.deviceId}`}
                  label={
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <span className="truncate">{controller.name}</span>
                      {controllerLive(controller) ? (
                        <Badge
                          tone="success"
                          data-testid={`${testIdPrefix}-controller-connected-${controller.deviceId}`}
                        >
                          Connected
                        </Badge>
                      ) : null}
                    </span>
                  }
                  description={
                    controller.kind === 'hosted' ? (
                      <>
                        <span className="block">{paired}</span>
                        <span className="block">
                          {HOSTED_CONTROLLER_LIMITS}
                        </span>
                      </>
                    ) : (
                      paired
                    )
                  }
                  control={
                    <Button
                      size="compact"
                      variant="secondary"
                      disabled={busyDevice === controller.deviceId}
                      onClick={() =>
                        askToRemove({ role: 'controller', device: controller })
                      }
                      data-testid={`${testIdPrefix}-controller-remove-${controller.deviceId}`}
                    >
                      Remove
                    </Button>
                  }
                />
              );
            })}
          </SettingsRowsGroup>
        </SettingsRowsSection>
      ) : null}

      <SettingsRowsSection
        title="Computers you can control"
        dataTestId={`${testIdPrefix}-hosts`}
      >
        <SettingsRowsGroup>
          <SettingsButtonRow
            label={ADD_COMPUTER_ROW_LABEL}
            trailing="open"
            onClick={ports.connectComputer}
            data-testid={`${testIdPrefix}-add`}
          />
          {hosts.map((host) => {
            const dot = remoteHostDotTone(remoteHostStatus(host).tone);
            return (
              <SettingsRowsRow
                key={host.deviceId}
                dataTestId={`${testIdPrefix}-host-${host.deviceId}`}
                label={
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span className="truncate">{host.name}</span>
                    {dot ? <Dot tone={dot} /> : null}
                  </span>
                }
                description={hostDescription(host)}
                control={
                  <>
                    <Button
                      size="compact"
                      variant="secondary"
                      disabled={busyDevice === host.deviceId}
                      onClick={() =>
                        askToRemove({ role: 'host', device: host })
                      }
                      data-testid={`${testIdPrefix}-host-remove-${host.deviceId}`}
                    >
                      Remove
                    </Button>
                    <Button
                      size="compact"
                      variant="secondary"
                      disabled={busyDevice === host.deviceId}
                      onClick={() => openHost(host.deviceId)}
                      data-testid={`${testIdPrefix}-host-open-${host.deviceId}`}
                    >
                      Open
                    </Button>
                  </>
                }
              />
            );
          })}
        </SettingsRowsGroup>
      </SettingsRowsSection>

      {pendingRemoval ? (
        <ConfirmDialog
          title={`Remove ${pendingRemoval.device.name}?`}
          message={
            pendingRemoval.role === 'host'
              ? `You won't be able to open ${pendingRemoval.device.name} from here until you pair it again.`
              : `${pendingRemoval.device.name} won't be able to control this computer, and control ends now if it's connected. It needs your approval to pair again.`
          }
          confirmLabel={removeConfirmLabel(pendingRemoval)}
          busyLabel="Removing…"
          busy={removing}
          errorMessage={removeError?.message ?? null}
          {...(removeError?.details === undefined
            ? {}
            : { errorDetails: removeError.details })}
          destructive
          onConfirm={confirmRemoval}
          onCancel={() => setPendingRemoval(null)}
          confirmTestId={`${testIdPrefix}-remove-confirm`}
          dataTestId={`${testIdPrefix}-remove-dialog`}
        />
      ) : null}
    </>
  );
}
