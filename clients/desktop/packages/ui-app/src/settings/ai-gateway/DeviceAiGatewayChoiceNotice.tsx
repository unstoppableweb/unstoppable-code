'use client';

import { useEffect, useState, type JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { gatewayHostname } from '@canopy/protocol/model-gateway/discovery';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  useSettingsDeviceAiGatewayChoice,
  type DeviceAiGatewayChoice,
  type DeviceAiGatewayDecision,
} from '../host';
import { useSettingsErrorCopy } from '../errors';
import {
  AI_GATEWAY_ERROR_SCOPE,
  AI_GATEWAY_KNOWN_ERRORS,
} from './ai-gateway-copy';

export interface DeviceAiGatewayChoiceNoticeProps {
  /** The account's gateway now holds this computer's; re-read it. */
  readonly onAccountGatewayReplaced: () => void;
}

const gatewayName = (displayName: string | null, baseUrl: string): string =>
  displayName || gatewayHostname(baseUrl);

const isStaleRevision = (error: unknown): boolean =>
  error instanceof SettingsOperationError &&
  error.serverCode === 'stale_revision';

/**
 * Sign-in found one AI gateway on the account and a different one set up on
 * this computer while signed out. Only a host that keeps a device gateway
 * supplies the port, so elsewhere this renders nothing.
 */
export function DeviceAiGatewayChoiceNotice({
  onAccountGatewayReplaced,
}: DeviceAiGatewayChoiceNoticeProps): JSX.Element | null {
  const port = useSettingsDeviceAiGatewayChoice();
  const errorCopy = useSettingsErrorCopy(AI_GATEWAY_ERROR_SCOPE);
  const [choice, setChoice] = useState<DeviceAiGatewayChoice | null>(null);
  const [busy, setBusy] = useState<DeviceAiGatewayDecision | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    void port.read().then(
      (next) => {
        if (!cancelled) setChoice(next);
      },
      () => {
        if (!cancelled) setChoice(null);
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [port]);

  if (!port || !choice) return null;

  const decide = async (decision: DeviceAiGatewayDecision): Promise<void> => {
    if (busy) return;
    setBusy(decision);
    setFailure(null);
    try {
      await port.choose(decision, choice.accountRevision);
      setChoice(null);
      if (decision === 'device') onAccountGatewayReplaced();
    } catch (error) {
      if (isStaleRevision(error)) {
        // The account's gateway changed since this was read: show the
        // current one and ask again rather than replace it unseen.
        const next = await port.read().catch(() => null);
        setChoice(next);
        if (next)
          setFailure(
            "Your account's AI gateway changed. Check it and choose again.",
          );
        return;
      }
      setFailure(
        errorCopy.actionFailure(error, {
          action:
            decision === 'device'
              ? "switch to this computer's gateway"
              : "keep your account's gateway",
          known: AI_GATEWAY_KNOWN_ERRORS,
        }).copy,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Notice
      intent="attention"
      role="none"
      title="This computer has a different AI gateway"
      data-testid="device-ai-gateway-choice"
      detail={failure ?? undefined}
      announceDetail
      actions={
        <>
          <NoticeButton
            variant="primary"
            data-testid="device-ai-gateway-choice-use-device"
            aria-disabled={busy ? true : undefined}
            busy={busy === 'device'}
            busyLabel="Switching…"
            onClick={() => void decide('device')}
          >
            {"Use this computer's gateway"}
          </NoticeButton>
          <NoticeButton
            variant="secondary"
            data-testid="device-ai-gateway-choice-keep-account"
            aria-disabled={busy ? true : undefined}
            busy={busy === 'account'}
            busyLabel="Keeping…"
            onClick={() => void decide('account')}
          >
            {"Keep my account's"}
          </NoticeButton>
        </>
      }
    >
      Your account uses{' '}
      {gatewayName(choice.accountDisplayName, choice.accountBaseUrl)}. Before
      you signed in, this computer was set up with{' '}
      {gatewayName(choice.deviceDisplayName, choice.deviceBaseUrl)}. Using this
      computer&apos;s gateway replaces your account&apos;s AI gateway for cloud
      chats and your other computers.
    </Notice>
  );
}
