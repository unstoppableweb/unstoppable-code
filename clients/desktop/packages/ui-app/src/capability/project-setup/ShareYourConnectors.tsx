'use client';

import { useEffect, useId, useState, type JSX } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { SharedConnectionOwn } from '@canopy/protocol/canopy-core';
import { Button, DialogModal, ErrorBanner } from '@canopy/ui-shared/components';
import { SETTINGS_CARD_ROW_CLASS } from '@canopy/ui-shared/components/settings/SettingsCard';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  logSettingsError,
  settingsActionErrorCopy,
  settingsFailure,
  type SettingsFailure,
} from '../../settings/errors';
import type { SettingsLogger } from '../../settings/host/settings-host';
import {
  SignInPendingRow,
  useReadAgainOnReturn,
} from '../../settings/organization/settings/shared-connection-display';

export interface ShareYourConnectorsProps {
  readonly client: AccountOrganizationSettingsClient;
  readonly organizationId: string;
  readonly projectId: string;
  /** The caller's own connectors the project doesn't hold yet. */
  readonly yours: readonly SharedConnectionOwn[];
  readonly disabled: boolean;
  /** Opens the organization's sign-in (a same-origin web path). */
  readonly openSignIn: (signInPath: string) => void;
  /** Reads the project's setup again: the shared connection is in it. */
  readonly onShared: () => void;
  /**
   * The sign-in state of a connection the project holds, as its setup last
   * read: `pending` until its sign-in finishes; undefined when not held.
   */
  readonly connectionStatus: (connectionId: string) => string | undefined;
  readonly logger?: SettingsLogger;
}

/**
 * "Share with this project" (CAN-6251; spec FR-10): an owner or admin picks
 * one of their own connectors, and the organization connects the same
 * service with a fresh sign-in, added to this project at once. Their own
 * connection is never read, converted or changed, and nothing is shared
 * until they confirm.
 */
export function ShareYourConnectors({
  client,
  organizationId,
  projectId,
  yours,
  disabled,
  openSignIn,
  onShared,
  connectionStatus,
  logger,
}: ShareYourConnectorsProps): JSX.Element | null {
  const [confirming, setConfirming] = useState<SharedConnectionOwn | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  /**
   * The sign-in last opened and its connection, until the project's setup
   * reads that connection as signed in. The sign-in is offered again in
   * case the browser blocked it: on web it opens after the connect request,
   * outside the click.
   */
  const [sharing, setSharing] = useState<{
    readonly signInPath: string;
    readonly connectionId: string | null;
  } | null>(null);
  const signingIn = sharing !== null;
  const status =
    sharing === null || sharing.connectionId === null
      ? undefined
      : connectionStatus(sharing.connectionId);

  // Done once a read of the setup holds the connection and it isn't waiting
  // for its sign-in any more.
  useEffect(() => {
    if (status !== undefined && status !== 'pending') setSharing(null);
  }, [status]);

  useReadAgainOnReturn(signingIn, onShared);

  if (yours.length === 0 && !signingIn) return null;

  const share = async (connector: SharedConnectionOwn): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const started = await client.write(
        'organization.settings.connections.connect',
        {
          organizationId,
          serverKey: connector.serverKey,
          projectId,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setConfirming(null);
      onShared();
      if (started.signInPath !== undefined) {
        setSharing({
          signInPath: started.signInPath,
          connectionId: started.connectionId ?? null,
        });
        openSignIn(started.signInPath);
      }
    } catch (failure) {
      if (logger) logSettingsError(logger, 'share a connector', failure);
      setError(
        settingsFailure(
          failure,
          settingsActionErrorCopy(failure, {
            action: `share ${connector.name} with this project`,
          }),
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className={SETTINGS_CARD_ROW_CLASS}
        data-testid="project-setup-share-yours"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-s font-medium fg-primary">
            Share your own connectors
          </p>
          <p className="text-xs text-pretty fg-secondary">
            The organization signs in to the service separately, so everyone in
            this project can use it. Your own sign-in stays yours.
          </p>
        </div>
      </div>
      {sharing !== null && (
        <SignInPendingRow
          onOpen={() => openSignIn(sharing.signInPath)}
          testId="project-setup-share-yours-sign-in-pending"
          openTestId="project-setup-share-yours-open-sign-in"
        />
      )}
      <ErrorBanner
        errorSource="project-setup-share-yours"
        testId="project-setup-share-yours-error"
        className=""
        error={confirming === null ? error?.copy : undefined}
        details={confirming === null ? error?.details : undefined}
      />
      {yours.map((connector) => (
        <YourConnectorRow
          key={connector.serverKey}
          connector={connector}
          disabled={disabled || busy}
          onShare={() => {
            setError(null);
            setConfirming(connector);
          }}
        />
      ))}
      {confirming !== null && (
        <DialogModal
          title="Share with this project?"
          subtitle={
            <span className={REPLAY_MASK_CLASS}>{confirming.name}</span>
          }
          maxWidth="sm"
          dataTestId="project-setup-share-yours-dialog"
          closeOnBackdrop={!busy}
          closeButtonDisabled={busy}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button
                type="button"
                variant="secondary"
                size="compact"
                disabled={busy}
                data-testid="project-setup-share-yours-cancel"
                onClick={() => setConfirming(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="compact"
                disabled={busy}
                aria-busy={busy}
                data-testid="project-setup-share-yours-confirm"
                onClick={() => void share(confirming)}
              >
                Sign in and share
              </Button>
            </>
          }
        >
          <ErrorBanner
            errorSource="project-setup-share-yours"
            testId="project-setup-share-yours-dialog-error"
            className=""
            error={busy ? undefined : error?.copy}
            details={busy ? undefined : error?.details}
          />
          <p className="text-s text-pretty fg-secondary">
            You’ll sign in again as the organization. Your own connector and its
            sign-in don’t change, and nobody in the project sees the new
            sign-in.
          </p>
        </DialogModal>
      )}
    </>
  );
}

function YourConnectorRow({
  connector,
  disabled,
  onShare,
}: {
  connector: SharedConnectionOwn;
  disabled: boolean;
  onShare: () => void;
}): JSX.Element {
  const nameId = useId();
  const shareId = useId();
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`project-setup-share-yours-row-${connector.serverKey}`}
    >
      <p
        id={nameId}
        className={`min-w-0 truncate text-s font-medium fg-primary ${REPLAY_MASK_CLASS}`}
      >
        {connector.name}
      </p>
      <Button
        id={shareId}
        variant="secondary"
        size="compact"
        disabled={disabled}
        // The name is masked in replay, so the button is named by the masked
        // element rather than an aria-label.
        aria-labelledby={`${shareId} ${nameId}`}
        data-testid={`project-setup-share-yours-${connector.serverKey}`}
        onClick={onShare}
      >
        Share with this project
      </Button>
    </div>
  );
}
