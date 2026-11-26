'use client';

import { useState, type JSX, type RefObject } from 'react';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { SettingsConfirmDialog, useSettingsClient } from '../host';
import { useSettingsErrorCopy, type SettingsFailure } from '../errors';
import { PROJECTS_ERROR_SCOPE } from './team-projects-create-dialog';
import { MaskedNameList } from './settings/shared-connection-display';

/**
 * What an archive offers to disconnect (CAN-6253): the organization's shared
 * connections the archived project used that no active project uses now.
 */
export interface ArchiveDisconnectOffer {
  readonly projectName: string;
  readonly connections: readonly { id: string; name: string }[];
}

/**
 * Asks the owner or admin who archived a project whether to disconnect the
 * shared connections only it used. Disconnecting keeps each connection and
 * the projects' setups, so restoring the project and reconnecting brings it
 * back; declining changes nothing (the archived project can't use them
 * either way).
 */
export function ArchiveDisconnectDialog({
  organizationId,
  offer,
  onClose,
  restoreFocusRef,
}: {
  organizationId: string;
  offer: ArchiveDisconnectOffer;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(PROJECTS_ERROR_SCOPE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  /** Connections still to disconnect: a retry skips those already done. */
  const [remaining, setRemaining] = useState(offer.connections);
  const several = offer.connections.length > 1;

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    let left = remaining;
    try {
      for (const connection of remaining) {
        await client.write('organization.settings.connections.disconnect', {
          organizationId,
          connectionId: connection.id,
          idempotencyKey: crypto.randomUUID(),
        });
        left = left.filter((entry) => entry.id !== connection.id);
      }
      onClose();
    } catch (failure) {
      setRemaining(left);
      setError(
        errorCopy.actionFailure(failure, {
          action: several ? 'disconnect these connections' : 'disconnect it',
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsConfirmDialog
      title={
        several
          ? 'Disconnect unused connections?'
          : 'Disconnect unused connection?'
      }
      message={
        <p>
          <span className={REPLAY_MASK_CLASS}>{offer.projectName}</span> was the
          only active project using <MaskedNameList names={offer.connections} />
          . Disconnect {several ? 'them' : 'it'} so the organization stops
          holding {several ? 'their' : 'its'} sign-in? You can reconnect from
          the Connectors page.
        </p>
      }
      confirmLabel="Disconnect"
      busyLabel="Disconnecting…"
      busy={busy}
      destructive
      dataTestId="team-projects-archive-disconnect"
      errorSource="organization-projects-archive-offer"
      errorMessage={error?.copy}
      errorDetails={error?.details}
      restoreFocusRef={restoreFocusRef}
      onCancel={onClose}
      onConfirm={(): void => void disconnect()}
    />
  );
}
