import type { JSX } from 'react';
import { Button, LoadingSpinner, Stack } from '@canopy/ui-shared/components';
import { RemoteControlPairingCode } from '@canopy/ui-shared/components/RemoteControlPairingCode';
import { deviceKindLabel } from '@canopy/ui-app/remote-control';
import type { RemoteIncomingPairing } from '@canopy/desktop-shared/types';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import type { InlineFailure } from '@/lib/inline-app-error';
import type { IncomingPairingAnswer } from './incoming-pairing-response';

/**
 * What a hosted agents controller may and may not do here (CAN-5985 A6):
 * its host profile admits chats, file reads and pipelines only.
 */
const HOSTED_AGENTS_EFFECTS =
  "Agents you connect can start and follow chats, read files and run pipelines. They can't use terminals, answer approvals or delete work.";
const CONTROL_EFFECTS =
  'It will be able to see and change everything on this computer, including running commands.';

export interface IncomingPairingRequestBodyProps {
  readonly request: RemoteIncomingPairing;
  readonly error: InlineFailure | null;
}

/**
 * What the person compares and what they grant: the kind, the code both
 * devices show and what the device may do here. A hosted agents controller
 * is held to restricted effects, so its sentence says what it can't do.
 */
export function IncomingPairingRequestBody({
  request,
  error,
}: IncomingPairingRequestBodyProps): JSX.Element {
  const hosted = request.kind === 'hosted';
  return (
    <Stack gap="item" data-testid="remote-access-incoming-pairing-body">
      <p
        className="text-s text-pretty fg-secondary"
        data-testid="remote-access-incoming-pairing-kind"
      >
        {hosted
          ? `${deviceKindLabel('hosted')} · Make sure the web page shows the same code.`
          : `${deviceKindLabel(request.kind)} · Make sure it shows the same code.`}
      </p>
      <RemoteControlPairingCode
        code={request.code}
        size="hero"
        data-testid="remote-access-incoming-pairing-code"
      />
      <p className="text-s text-pretty fg-secondary">
        {hosted ? HOSTED_AGENTS_EFFECTS : CONTROL_EFFECTS}
      </p>
      <DesktopErrorBanner
        errorSource="remote-access-incoming-pairing-error"
        className=""
        error={error?.error}
        {...(error?.details === undefined ? {} : { details: error.details })}
        testId="remote-access-incoming-pairing-error"
      />
    </Stack>
  );
}

export interface IncomingPairingRequestActionsProps {
  readonly busy: IncomingPairingAnswer | null;
  readonly onRespond: (approve: boolean) => void;
}

/** Allow and Deny, as every approval prompt here names them. */
export function IncomingPairingRequestActions({
  busy,
  onRespond,
}: IncomingPairingRequestActionsProps): JSX.Element {
  return (
    <>
      <Button
        variant="secondary"
        size="compact"
        disabled={busy !== null}
        onClick={() => onRespond(false)}
        data-testid="remote-access-incoming-pairing-decline"
      >
        {busy === 'deny' ? (
          <LoadingSpinner className="shrink-0" decorative />
        ) : null}
        Deny
      </Button>
      <Button
        variant="primary"
        size="compact"
        disabled={busy !== null}
        aria-busy={busy === 'allow'}
        onClick={() => onRespond(true)}
        data-testid="remote-access-incoming-pairing-allow"
      >
        {busy === 'allow' ? (
          <LoadingSpinner className="shrink-0" decorative />
        ) : null}
        Allow
      </Button>
    </>
  );
}
