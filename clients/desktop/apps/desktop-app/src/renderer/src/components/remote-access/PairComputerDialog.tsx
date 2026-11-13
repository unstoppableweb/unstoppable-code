import { useEffect, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import {
  RemoteControlPairing,
  type RemoteControlPairingAction,
  type RemoteControlPairingStep,
} from '@canopy/ui-app/remote-control';
import type {
  RemoteControlDevice,
  RemoteOutgoingPairing,
} from '@canopy/desktop-shared/types';
import { DialogModal } from '@/components/shared/DialogModal';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { ALLOW_INCOMING_LABEL, describeError } from './remote-access-copy';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';

/** Main keeps discovery alive for about five minutes per request. */
const DISCOVERY_REFRESH_MS = 4 * 60_000;

export interface PairComputerDialogProps {
  readonly onClose: () => void;
}

type Phase = 'choose' | 'pairing';

/**
 * Pairs this computer with another one on the same account so this one can
 * control it. Lists the computers that accept pairing, starts the handshake
 * with the one the user picks, and shows the six-digit code both computers
 * display until the other computer approves or declines.
 */
export function PairComputerDialog({
  onClose,
}: PairComputerDialogProps): JSX.Element {
  const { state, discover, startPairing, cancelPairing, openMachine } =
    useRemoteControlStore(
      useShallow((store) => ({
        state: store.state,
        discover: store.discover,
        startPairing: store.startPairing,
        cancelPairing: store.cancelPairing,
        openMachine: store.openMachine,
      })),
    );
  const pairing = state.outgoingPairing;
  const [phase, setPhase] = useState<Phase>(() =>
    pairing === null ? 'choose' : 'pairing',
  );
  const [discovered, setDiscovered] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastDeviceRef = useRef<RemoteControlDevice | null>(pairing);
  // A start still in flight when the dialog closes is cancelled once it lands.
  const startingRef = useRef(false);
  const closedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const run = (): void => {
      void discover()
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setDiscovered(true);
        });
    };
    run();
    const timer = window.setInterval(run, DISCOVERY_REFRESH_MS);
    return (): void => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [discover]);

  const close = (): void => {
    closedRef.current = true;
    // Leaving mid-handshake abandons it; after an outcome this only clears
    // the finished attempt (an approved pairing stays paired).
    if (!startingRef.current && state.outgoingPairing !== null) {
      void cancelPairing().catch(() => undefined);
    }
    onClose();
  };

  const pair = (device: RemoteControlDevice): void => {
    lastDeviceRef.current = device;
    setActionError(null);
    setBusy(true);
    startingRef.current = true;
    void startPairing(device.deviceId)
      .then(() => {
        if (closedRef.current) {
          void cancelPairing().catch(() => undefined);
          return;
        }
        setPhase('pairing');
      })
      .catch((cause: unknown) => {
        if (closedRef.current) return;
        setPhase('choose');
        setActionError(
          describeError(cause, `Couldn't reach ${device.name}. Try again.`),
        );
      })
      .finally(() => {
        startingRef.current = false;
        if (!closedRef.current) setBusy(false);
      });
  };

  const backToList = (): void => {
    setActionError(null);
    setPhase('choose');
    void cancelPairing().catch(() => undefined);
  };

  const openPaired = (deviceId: string): void => {
    setActionError(null);
    setBusy(true);
    void openMachine(deviceId)
      .then(() => {
        void cancelPairing().catch(() => undefined);
        onClose();
      })
      .catch((cause: unknown) => {
        // Stay open so the user sees why and can try again.
        setBusy(false);
        setActionError(describeError(cause, "Couldn't open that computer."));
      });
  };

  const openAccounts = (): void => {
    onClose();
    openCloudAccountSettings();
  };

  let step: RemoteControlPairingStep;
  let actions: readonly RemoteControlPairingAction[];
  const cancel: RemoteControlPairingAction = {
    label: 'Cancel',
    onSelect: close,
    testId: 'remote-access-pair-cancel',
  };
  if (phase === 'pairing' && pairing !== null) {
    ({ step, actions } = pairingStep({
      pairing,
      busy,
      cancel,
      onClose: close,
      onRetry: (): void => {
        const device = lastDeviceRef.current ?? pairing;
        pair(device);
      },
      onBack: backToList,
      onOpen: () => openPaired(pairing.deviceId),
    }));
  } else if (phase === 'pairing') {
    // Started, but the snapshot with the attempt has not arrived yet.
    step = { kind: 'progress', message: 'Connecting…' };
    actions = [{ label: 'Cancel', onSelect: close }];
  } else {
    step = state.signedIn
      ? {
          kind: 'choose',
          computers: state.discoverable,
          searching: !discovered,
          emptyHint: `On the other computer, open Settings → ${REMOTE_CONTROL_LABEL} and turn on ${ALLOW_INCOMING_LABEL}. Both computers must be signed in to the same account.`,
          relayUnavailable: state.relayStatus === 'unavailable',
          disabled: busy,
          onChoose: pair,
        }
      : {
          kind: 'content',
          content: (
            <Notice
              intent="attention"
              title="Sign in to pair computers"
              data-testid="remote-access-pair-signed-out"
              actions={
                <NoticeButton variant="primary" onClick={openAccounts}>
                  Open account settings
                </NoticeButton>
              }
            >
              Both computers must be signed in to the same account.
            </Notice>
          ),
        };
    actions = [cancel];
  }

  return (
    <DialogModal
      onClose={close}
      title="Add a computer"
      maxWidth="md"
      trapFocus
      dataTestId="remote-access-pair-dialog"
    >
      <RemoteControlPairing
        presentation="dialog"
        step={step}
        actions={actions}
        error={actionError}
        testIdPrefix="remote-access-pair"
      />
    </DialogModal>
  );
}

interface PairingStepInput {
  readonly pairing: RemoteOutgoingPairing;
  readonly busy: boolean;
  readonly cancel: RemoteControlPairingAction;
  readonly onClose: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  readonly onOpen: () => void;
}

/** The shared flow's step and actions for an attempt main reports. */
function pairingStep({
  pairing,
  busy,
  cancel,
  onClose,
  onRetry,
  onBack,
  onOpen,
}: PairingStepInput): {
  step: RemoteControlPairingStep;
  actions: readonly RemoteControlPairingAction[];
} {
  switch (pairing.status) {
    case 'connecting':
      return {
        step: { kind: 'progress', message: <>Connecting to {pairing.name}…</> },
        actions: [cancel],
      };
    case 'awaiting-approval':
      return {
        step: {
          kind: 'compare',
          instruction: (
            <>
              Check that {pairing.name} shows the same code, then select Allow
              on that computer.
            </>
          ),
          code: pairing.code,
          waiting: <>Waiting for {pairing.name}…</>,
        },
        actions: [cancel],
      };
    case 'approved':
      return {
        step: {
          kind: 'outcome',
          message: (
            <>
              {pairing.name} is paired. You can open it any time from Computers
              in the account menu.
            </>
          ),
          testId: 'remote-access-pair-approved',
        },
        actions: [
          {
            label: 'Done',
            onSelect: onClose,
            testId: 'remote-access-pair-done',
          },
          {
            label: <>Open {pairing.name}</>,
            onSelect: onOpen,
            primary: true,
            testId: 'remote-access-pair-open',
          },
        ],
      };
    case 'rejected':
      return {
        step: {
          kind: 'outcome',
          message: <>{pairing.name} declined the request.</>,
          testId: 'remote-access-pair-rejected',
        },
        actions: [
          { label: 'Close', onSelect: onClose },
          {
            label: 'Choose another computer',
            onSelect: onBack,
            primary: true,
            testId: 'remote-access-pair-back',
          },
        ],
      };
    case 'failed':
      return {
        step: {
          kind: 'failed',
          message: `Couldn't pair with ${pairing.name}. ${
            pairing.error ?? 'The connection ended before it finished.'
          }`,
          testId: 'remote-access-pair-failed',
        },
        actions: [
          { label: 'Close', onSelect: onClose },
          {
            label: 'Try again',
            onSelect: onRetry,
            primary: true,
            disabled: busy,
            testId: 'remote-access-pair-retry',
          },
        ],
      };
  }
}
