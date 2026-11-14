'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import type {
  ExternalAgentComputer,
  ExternalAgentComputerConnectOutcome,
} from '@canopy/protocol/external-agents';
import type { ExternalAgentComputersClient } from '@canopy/app-core';
import {
  Badge,
  Button,
  ConfirmDialog,
  DialogModal,
  EmptyStateRow,
  LoadingSpinner,
  Notice,
  NoticeButton,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from './external-agents-parts';
import { DESKTOP_DOWNLOAD_PATH } from './paths';
import type { ExternalAgentComputersState } from './use-external-agent-computers';

/**
 * Raises a confirmation through the host's notification stack, like
 * `ShareNotify`. Required, so no host mounts the page with a silent success.
 */
export type ExternalAgentsNotify = (toast: {
  readonly tone: 'success';
  readonly message: string;
}) => void;

/** UX copy E1/E2 (CAN-5985). */
const AGENT_LIMITS =
  'Agents can start and follow chats, read files and run pipelines. They can’t use terminals, answer approvals or delete work.';

/**
 * UX copy for computers agents still reach through the retiring Remote
 * Control path (CAN-6039). Users know that path only as Remote Control, so
 * the copy never says Portal. Every row the relay can't see right now uses the
 * unseen sentence, whether or not its desktop has minted a relay token, so
 * the copy covers both an outdated app and Remote Control being off.
 */
const NEEDS_CONNECTING_ONLINE =
  'Connect this computer so agents can keep using it.';
const NEEDS_CONNECTING_UNSEEN =
  'Update the app on this computer and turn on Remote Control to connect it.';

const EMPTY_DESCRIPTION = `Open the app on your computer and turn on ${REMOTE_CONTROL_LABEL} in Settings.`;

type ConnectFailure = Exclude<
  ExternalAgentComputerConnectOutcome,
  { status: 'paired' }
>['status'];

function connectFailureMessage(status: ConnectFailure, name: string): string {
  switch (status) {
    case 'denied':
      return `${name} didn’t allow agents.`;
    case 'offline':
      return `${name} is offline. Open the app on it, then try again.`;
    case 'host_unsupported':
      return `Update the app on ${name}, then try again.`;
    case 'timeout':
      return `Nobody chose Allow on ${name} in time.`;
    case 'cancelled':
      return 'The request was cancelled.';
    case 'busy':
      return 'Another computer is being connected. Try again in a moment.';
    case 'capacity':
      return 'Your agents are using every connection right now. Try again in a moment.';
    case 'plan_required':
      return 'Remote Control needs a Pro plan.';
    case 'failed':
      return `Couldn’t connect ${name}.`;
  }
}

function agentsLabel(computer: ExternalAgentComputer): string {
  if (computer.viaPortal) {
    return computer.online ? NEEDS_CONNECTING_ONLINE : NEEDS_CONNECTING_UNSEEN;
  }
  switch (computer.agents) {
    case 'connected':
      return 'Connected for agents';
    case 'removal_pending':
      return 'Removal pending';
    case 'not_connected':
      return 'Not connected';
  }
}

export function ExternalAgentComputersSection({
  client,
  state,
  onOpenPath,
  notify,
  desktopDownloadAvailable,
}: {
  readonly client: ExternalAgentComputersClient;
  readonly state: ExternalAgentComputersState;
  readonly onOpenPath: (path: string) => void;
  readonly notify: ExternalAgentsNotify;
  /** The host can link to the download page and the visit isn't from the app. */
  readonly desktopDownloadAvailable: boolean;
}): JSX.Element {
  const { computers, portalOnly, problem, load, setPaused } = state;
  const [connecting, setConnecting] = useState<ExternalAgentComputer | null>(
    null,
  );
  const [removing, setRemoving] = useState<ExternalAgentComputer | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);

  // No new background refresh starts while the person acts on a row. A
  // response already in flight still applies; the dialogs hold their own
  // copy of the row, so a list change can't drop what they act on.
  const acting = connecting !== null || removing !== null || removeBusy;
  useEffect(() => {
    if (!acting) return undefined;
    setPaused(true);
    return (): void => setPaused(false);
  }, [acting, setPaused]);

  const confirmRemove = async (): Promise<void> => {
    if (!removing?.remoteId) return;
    setRemoveBusy(true);
    setRemoveError(null);
    const result = await client.remove(removing.remoteId);
    setRemoveBusy(false);
    if (!result.ok) {
      setRemoveError(`Couldn’t remove ${removing.name}. Try again.`);
      return;
    }
    setPendingNotice(
      result.value.status === 'pending'
        ? `Agents can’t use ${removing.name} anymore. It finishes removing the next time it’s online.`
        : null,
    );
    setRemoving(null);
    await load();
  };

  return (
    <SettingsSection
      title="Computers"
      description="Let your connected agents work on these computers. You approve each one on the computer."
      testId="external-agents-computers"
    >
      {problem ? (
        <Notice
          intent="attention"
          actions={
            <NoticeButton
              variant="secondary"
              onClick={(): void => void load()}
              data-testid="external-agents-computers-retry"
            >
              Try again
            </NoticeButton>
          }
          data-testid="external-agents-computers-error"
        >
          Couldn’t load your computers.
        </Notice>
      ) : null}
      {pendingNotice ? (
        <Notice
          intent="neutral"
          data-testid="external-agents-computers-pending"
        >
          {pendingNotice}
        </Notice>
      ) : null}
      <SettingsGroup>
        {computers === null && !problem ? (
          <EmptyStateRow title="Loading computers…" />
        ) : computers !== null &&
          computers.length === 0 &&
          portalOnly.length === 0 ? (
          <SettingsRow
            testId="external-agents-computers-empty"
            label="No computers yet"
            description={EMPTY_DESCRIPTION}
            control={
              desktopDownloadAvailable ? (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={(): void => onOpenPath(DESKTOP_DOWNLOAD_PATH)}
                  data-testid="external-agents-computers-download"
                >
                  Download the app
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {(computers ?? []).map((computer) => (
              <SettingsRow
                key={computer.deviceId}
                testId={`external-agents-computer-${computer.deviceId}`}
                label={computer.name}
                description={
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{agentsLabel(computer)}</span>
                    <Badge tone={computer.online ? 'success' : 'neutral'}>
                      {computer.online ? 'Online' : 'Offline'}
                    </Badge>
                    {computer.viaPortal ? (
                      <Badge
                        tone="warning"
                        data-testid="external-agents-computer-needs-connecting"
                      >
                        Needs connecting
                      </Badge>
                    ) : null}
                  </span>
                }
                control={
                  computer.agents === 'not_connected' ? (
                    <Tooltip
                      label={`Open the app on ${computer.name} to connect it`}
                      disabled={computer.online}
                      showOnTouch
                      contentClassName="max-w-sm whitespace-normal break-words"
                    >
                      <Button
                        variant="secondary"
                        size="compact"
                        aria-disabled={!computer.online || undefined}
                        onClick={(): void => setConnecting(computer)}
                        data-testid="external-agents-computer-connect"
                      >
                        Connect
                      </Button>
                    </Tooltip>
                  ) : (
                    <Button
                      variant="secondary"
                      size="compact"
                      onClick={(): void => {
                        setRemoveError(null);
                        setRemoving(computer);
                      }}
                      data-testid="external-agents-computer-remove"
                    >
                      Remove
                    </Button>
                  )
                }
              />
            ))}
            {portalOnly.map((computer) => (
              <SettingsRow
                key={computer.remoteId}
                testId={`external-agents-computer-portal-${computer.remoteId}`}
                label={computer.name}
                description={
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{NEEDS_CONNECTING_UNSEEN}</span>
                    <Badge
                      tone="warning"
                      data-testid="external-agents-computer-needs-connecting"
                    >
                      Needs connecting
                    </Badge>
                  </span>
                }
              />
            ))}
          </>
        )}
      </SettingsGroup>
      <p className="text-xs text-pretty fg-secondary">{AGENT_LIMITS}</p>
      {connecting ? (
        <ConnectComputerDialog
          client={client}
          computer={connecting}
          onClose={(paired): void => {
            const name = connecting.name;
            setConnecting(null);
            if (!paired) return;
            notify({
              tone: 'success',
              message: `${name} is connected. Your agents can use it now.`,
            });
            void load();
          }}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message="Your agents stop working on this computer."
          confirmLabel="Remove computer"
          busyLabel="Removing…"
          busy={removeBusy}
          errorMessage={removeError}
          destructive
          onConfirm={(): void => void confirmRemove()}
          onCancel={(): void => setRemoving(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

type ConnectState =
  | { phase: 'waiting'; code: string | null }
  | { phase: 'failed'; status: ConnectFailure };

function ConnectComputerDialog({
  client,
  computer,
  onClose,
}: {
  readonly client: ExternalAgentComputersClient;
  readonly computer: ExternalAgentComputer;
  readonly onClose: (paired: boolean) => void;
}): JSX.Element {
  const [state, setState] = useState<ConnectState>({
    phase: 'waiting',
    code: null,
  });
  const [attempt, setAttempt] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const abort = new AbortController();
    setState({ phase: 'waiting', code: null });
    void client
      .connect(
        computer.deviceId,
        (code) => {
          if (!abort.signal.aborted) setState({ phase: 'waiting', code });
        },
        abort.signal,
      )
      .then((result) => {
        if (abort.signal.aborted) return;
        if (!result.ok) {
          setState({ phase: 'failed', status: 'failed' });
          return;
        }
        const outcome = result.value;
        if (outcome.status === 'paired') {
          onCloseRef.current(true);
          return;
        }
        setState({ phase: 'failed', status: outcome.status });
      });
    // Closing the dialog cancels the request on the server.
    return (): void => abort.abort();
  }, [client, computer.deviceId, attempt]);

  return (
    <DialogModal
      onClose={(): void => onClose(false)}
      title={`Check the code on ${computer.name}`}
      subtitle={`Choose Allow on ${computer.name} to finish.`}
      maxWidth="sm"
      dataTestId="external-agents-computer-connect-dialog"
    >
      {state.phase === 'waiting' ? (
        <div className="flex flex-col items-center gap-3 py-2">
          {state.code ? (
            <output
              className="text-center font-mono text-3xl font-medium tabular-nums fg-primary"
              data-testid="external-agents-computer-code"
            >
              {state.code}
            </output>
          ) : null}
          <div className="flex items-center gap-2">
            {state.code === null ? <LoadingSpinner decorative /> : null}
            <p
              role="status"
              className="text-s fg-secondary"
              data-testid="external-agents-computer-connect-status"
            >
              {state.code === null
                ? `Contacting ${computer.name}…`
                : 'Waiting for approval…'}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Notice
            intent="attention"
            data-testid="external-agents-computer-connect-failed"
          >
            {connectFailureMessage(state.status, computer.name)}
          </Notice>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="compact"
              onClick={(): void => setAttempt((value) => value + 1)}
              data-testid="external-agents-computer-connect-retry"
            >
              Try again
            </Button>
          </div>
        </div>
      )}
    </DialogModal>
  );
}
