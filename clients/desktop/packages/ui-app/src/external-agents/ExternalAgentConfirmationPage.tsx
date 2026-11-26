'use client';

import { CodeBlock } from '@canopy/ui-shared/primitives/CodeBlock';
import { type JSX, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { ExternalAgentsClient } from '@canopy/app-core';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import {
  createExternalAgentPendingActionStore,
  type ExternalAgentDecision,
  type ExternalAgentPendingActionState,
  type ExternalAgentPendingActionStore,
} from '@canopy/app-state/external-agents';
import {
  externalAgentDisplayName,
  type ExternalAgentPendingAction,
} from '@canopy/protocol/external-agents';
import {
  Stack,
  Button,
  Disclosure,
  McpServerLogo,
  Notice,
  NoticeButton,
  Heading,
} from '@canopy/ui-shared/components';
import { EXTERNAL_AGENT_SERVER_COPY, relativeTimeLabel } from './display';
import {
  FactRow,
  SettingsGroup,
  SettingsSection,
  ExternalAgentsUnavailable,
} from './external-agents-parts';
import { ExternalAgentConfirmationSkeleton } from './external-agents-skeletons';
import { EXTERNAL_AGENTS_PATH, externalAgentPath } from './paths';
import { useMountedStore } from './use-mounted-store';
import { Surface } from '@canopy/ui-shared/components';

export interface ExternalAgentConfirmationPageProps {
  readonly pendingActionId: string;
  readonly onOpenPath: (path: string) => void;
}

export function ExternalAgentConfirmationPage({
  pendingActionId,
  onOpenPath,
}: ExternalAgentConfirmationPageProps): JSX.Element {
  const client = useCanopyClient();
  const capabilities = useCapabilities();
  const externalAgents = client.externalAgents;
  if (capabilities.externalAgents !== true || externalAgents === undefined) {
    return <ExternalAgentsUnavailable />;
  }

  return (
    <ExternalAgentConfirmationStoreView
      key={pendingActionId}
      client={externalAgents}
      pendingActionId={pendingActionId}
      onOpenPath={onOpenPath}
    />
  );
}

function ExternalAgentConfirmationStoreView({
  client,
  pendingActionId,
  onOpenPath,
}: {
  readonly client: ExternalAgentsClient;
  readonly pendingActionId: string;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const store = useMountedStore(
    client,
    pendingActionId,
    createExternalAgentPendingActionStore,
  );
  if (store === null) {
    return <ExternalAgentConfirmationLoading onOpenPath={onOpenPath} />;
  }
  return (
    <ExternalAgentConfirmationStoreContent
      store={store}
      onOpenPath={onOpenPath}
    />
  );
}

function ConfirmationPageColumn({
  status,
  children,
}: {
  readonly status: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-testid="external-agent-confirmation"
      data-status={status}
      className="mx-auto flex min-w-0 w-full max-w-176 flex-col gap-8 pb-12 pt-10"
    >
      {children}
    </div>
  );
}

function ExternalAgentConfirmationLoading({
  onOpenPath,
}: {
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  return (
    <ConfirmationPageColumn status="loading">
      <ExternalAgentConfirmationSkeleton />
      <OpenExternalAgents onOpenPath={onOpenPath} />
    </ConfirmationPageColumn>
  );
}

function ExternalAgentConfirmationStoreContent({
  store,
  onOpenPath,
}: {
  readonly store: ExternalAgentPendingActionStore;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const state = useStore(store);
  if (state.status === 'idle' || state.status === 'loading') {
    return <ExternalAgentConfirmationLoading onOpenPath={onOpenPath} />;
  }

  if (state.status === 'not_found') {
    return (
      <ConfirmationPageColumn status="not_found">
        <Notice
          intent="attention"
          title="This request isn’t available."
          data-testid="external-agent-confirmation-not-found"
        >
          It may belong to another account, or the link may be wrong. Requests
          waiting for you are listed in External agents.
        </Notice>
        <OpenExternalAgents onOpenPath={onOpenPath} />
      </ConfirmationPageColumn>
    );
  }

  if (state.action === null) {
    if (state.status === 'problem') {
      return (
        <ConfirmationPageColumn status="problem">
          <Notice
            intent="attention"
            actions={
              <NoticeButton
                variant="secondary"
                onClick={(): void => void state.load()}
              >
                Try again
              </NoticeButton>
            }
            data-testid="external-agent-confirmation-problem"
          >
            Couldn’t load this request.
          </Notice>
          <OpenExternalAgents onOpenPath={onOpenPath} />
        </ConfirmationPageColumn>
      );
    }
    return <ExternalAgentConfirmationLoading onOpenPath={onOpenPath} />;
  }

  return (
    <ExternalAgentConfirmationDetails
      action={state.action}
      state={state}
      onOpenPath={onOpenPath}
    />
  );
}

function ExternalAgentConfirmationDetails({
  action,
  state,
  onOpenPath,
}: {
  readonly action: ExternalAgentPendingAction;
  readonly state: ExternalAgentPendingActionState;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const pending = action.status === 'pending';
  return (
    <ConfirmationPageColumn status={action.status}>
      <header className="flex min-w-0 items-start gap-4">
        <McpServerLogo
          name={action.clientName}
          size={48}
          fallback="monogram"
          shape="squircle"
        />
        <Stack gap="tight" className="min-w-0">
          <Heading level={1} variant="page">
            {action.confirmation.action}
          </Heading>
          {pending ? (
            <p className="text-s text-pretty fg-secondary">
              {`${externalAgentDisplayName(action)} asked to do this for you. Nothing happens unless you confirm.`}
            </p>
          ) : null}
        </Stack>
      </header>

      <SettingsSection
        title="Request"
        testId="external-agent-confirmation-request-facts"
      >
        <SettingsGroup>
          <FactRow label="Agent">
            <Button
              variant="secondary"
              size="compact"
              data-testid="external-agent-confirmation-agent-link"
              onClick={(): void =>
                onOpenPath(externalAgentPath(action.connectionId))
              }
            >
              {`${externalAgentDisplayName(action)}, ${action.clientVerified ? 'verified' : 'unverified'}`}
            </Button>
          </FactRow>
          <FactRow label="Server">
            {EXTERNAL_AGENT_SERVER_COPY[action.server].title}
          </FactRow>
          {action.confirmation.resolvedTargets.map((target) => (
            <FactRow
              key={`${target.resourceKind}-${target.displayName}`}
              label={sentenceCaseResourceKind(target.resourceKind)}
            >
              {target.displayName}
            </FactRow>
          ))}
          <FactRow label="Asked">
            <ExactTime value={action.requestedAt} now={Date.now()} relative />
          </FactRow>
          {pending ? (
            <FactRow label="Expires">
              <ExactTime
                value={action.decisionExpiresAt}
                now={Date.now()}
                relative={false}
              />
            </FactRow>
          ) : null}
          <ExactRequest action={action} />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="What happens">
        <SettingsGroup>
          {action.confirmation.effects.map((effect, index) => (
            <p
              key={`${index}-${effect}`}
              className="text-s text-pretty fg-primary"
            >
              {effect}
            </p>
          ))}
        </SettingsGroup>
      </SettingsSection>

      {pending ? (
        <>
          {state.decisionOutcome !== null ? (
            <div
              data-testid="external-agent-confirmation-outcome"
              data-outcome={state.decisionOutcome.kind}
            >
              <DecisionOutcomeNotice outcome={state.decisionOutcome} />
            </div>
          ) : null}
          <PendingActions action={action} state={state} />
        </>
      ) : (
        <ActionOutcome action={action} state={state} onOpenPath={onOpenPath} />
      )}
    </ConfirmationPageColumn>
  );
}

function ExactTime({
  value,
  now,
  relative,
}: {
  readonly value: string;
  readonly now: number;
  readonly relative: boolean;
}): JSX.Element {
  const exact = exactLocalDateTime(value);
  const timeText = relative ? relativeTimeLabel(value, now) : exact;
  return (
    <span
      title={relative ? (exact ?? undefined) : relativeTimeLabel(value, now)}
    >
      {timeText ?? 'Unknown'}
    </span>
  );
}

function exactLocalDateTime(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

function sentenceCaseResourceKind(resourceKind: string): string {
  const spaced = resourceKind
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return spaced.length === 0
    ? spaced
    : `${spaced[0].toLocaleUpperCase()}${spaced.slice(1)}`;
}

function ExactRequest({
  action,
}: {
  readonly action: ExternalAgentPendingAction;
}): JSX.Element {
  return (
    <Disclosure
      label="Exact request"
      dataTestId="external-agent-confirmation-request-disclosure"
      toggleTestId="external-agent-confirmation-request-toggle"
    >
      <Stack
        data-testid="external-agent-confirmation-request"
        gap="inline"
        className="min-w-0"
      >
        <div className="break-all font-mono text-xs fg-primary">
          {action.toolName}
        </div>
        {action.arguments === null ? (
          <p className="text-xs text-pretty fg-secondary">
            The exact request is no longer kept.
          </p>
        ) : (
          <Surface variant="inset" className="max-w-full overflow-hidden">
            <CodeBlock
              variant="document"
              size="xs"
              wrap="none"
              tone="secondary"
              replay="inherit"
              overflow="horizontal"
            >
              {JSON.stringify(action.arguments, null, 2)}
            </CodeBlock>
          </Surface>
        )}
      </Stack>
    </Disclosure>
  );
}

function DecisionOutcomeNotice({
  outcome,
}: {
  readonly outcome: NonNullable<
    ExternalAgentPendingActionState['decisionOutcome']
  >;
}): JSX.Element {
  if (outcome.kind === 'conflict') {
    return (
      <Notice intent="neutral" title="Already decided." data-outcome="conflict">
        The latest outcome is shown here.
      </Notice>
    );
  }
  if (outcome.kind === 'expired') {
    return (
      <Notice
        intent="attention"
        title="This request expired."
        data-outcome="expired"
      >
        It expired before your choice was saved. Nothing was changed. Ask the
        agent to try again if you still want this action.
      </Notice>
    );
  }
  return (
    <Notice
      intent="attention"
      title={
        outcome.decision === 'confirm'
          ? 'Couldn’t confirm this request.'
          : 'Couldn’t decline this request.'
      }
      data-outcome="unavailable"
    >
      Try again.
    </Notice>
  );
}

function PendingActions({
  action,
  state,
}: {
  readonly action: ExternalAgentPendingAction;
  readonly state: ExternalAgentPendingActionState;
}): JSX.Element {
  const disabled = state.deciding !== null;
  const decide = (decision: ExternalAgentDecision): void => {
    void state.decide(decision);
  };
  return (
    <>
      <footer className="flex w-full items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="compact"
          className="flex-1"
          disabled={disabled}
          data-testid="external-agent-confirmation-decline"
          onClick={(): void => decide('decline')}
        >
          Decline
        </Button>
        <Button
          type="button"
          variant={
            action.confirmation.class === 'destructive'
              ? 'destructive'
              : 'secondary'
          }
          size="compact"
          className="flex-1"
          disabled={disabled}
          data-testid="external-agent-confirmation-confirm"
          onClick={(): void => decide('confirm')}
        >
          Confirm
        </Button>
      </footer>
    </>
  );
}

function PauseOffer({
  action,
  state,
  onOpenPath,
}: {
  readonly action: ExternalAgentPendingAction;
  readonly state: ExternalAgentPendingActionState;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const paused = state.pauseOffer === 'paused';
  if (paused) {
    return (
      <Notice
        intent="neutral"
        title="Paused."
        data-testid="external-agent-confirmation-paused"
      >
        {`${externalAgentDisplayName(action)} can’t read or change anything until you resume it. `}
        <Button
          onClick={(): void =>
            onOpenPath(externalAgentPath(action.connectionId))
          }
          variant="link"
          data-settings-control="link"
        >
          {`Open ${externalAgentDisplayName(action)}`}
        </Button>
        {' to resume it.'}
      </Notice>
    );
  }

  const pausing = state.pauseOffer === 'pausing';
  const pause = (): void => {
    void state.pauseConnection();
  };
  return (
    <div className="flex flex-col gap-3">
      {state.pauseOffer === 'failed' ? (
        <Notice
          intent="attention"
          data-testid="external-agent-confirmation-pause-failed"
        >
          Couldn’t pause {externalAgentDisplayName(action)}. Try again.
        </Notice>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        size="compact"
        disabled={pausing}
        aria-busy={pausing}
        data-testid="external-agent-confirmation-pause"
        onClick={pause}
      >
        {pausing
          ? `Pausing ${externalAgentDisplayName(action)}…`
          : `Pause ${externalAgentDisplayName(action)}`}
      </Button>
    </div>
  );
}

function ActionOutcome({
  action,
  state,
  onOpenPath,
}: {
  readonly action: ExternalAgentPendingAction;
  readonly state: ExternalAgentPendingActionState;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const outcomeName = state.decisionOutcome?.kind ?? action.status;
  const joinedText = action.outcome?.content
    .map((item) => item.text)
    .join('\n\n');
  const resultText =
    joinedText === undefined || joinedText === '' ? undefined : joinedText;
  const outcomeMessage = action.outcome?.structuredContent.message;
  const failureReason =
    typeof outcomeMessage === 'string'
      ? outcomeMessage
      : resultText || 'The action couldn’t be run.';
  // Declined and expired requests also store an error result for the agent;
  // only an action that ran (or could not run) is a failure here.
  const showFailure =
    action.status === 'failed' ||
    (action.status === 'executed' && action.outcome?.isError === true);

  return (
    <>
      <div
        data-testid="external-agent-confirmation-outcome"
        data-outcome={outcomeName}
        className="flex min-w-0 flex-col gap-4"
      >
        {state.decisionOutcome !== null ? (
          <DecisionOutcomeNotice outcome={state.decisionOutcome} />
        ) : null}
        {action.status === 'confirmed' ? (
          state.resultPoll === 'timed_out' ? (
            <Notice
              intent="neutral"
              actions={
                <NoticeButton
                  variant="secondary"
                  data-testid="external-agent-confirmation-reload"
                  onClick={(): void => void state.load()}
                >
                  Reload
                </NoticeButton>
              }
            >
              The result isn’t known yet. Reload to check again.
            </Notice>
          ) : (
            <div
              data-testid="external-agent-confirmation-running"
              role="status"
              className="text-s fg-secondary"
            >
              Running
            </div>
          )
        ) : null}
        {action.status === 'executed' && !showFailure ? (
          <>
            <Notice intent="positive" title="Done.">
              The agent will get the result the next time it asks. You can close
              this page.
            </Notice>
            <SettingsSection title="Result">
              <SettingsGroup>
                <p className="whitespace-pre-wrap text-s text-pretty fg-primary">
                  {resultText ?? 'The result is no longer kept.'}
                </p>
              </SettingsGroup>
            </SettingsSection>
          </>
        ) : null}
        {showFailure ? (
          <Notice intent="attention" title="This action couldn’t run.">
            {failureReason}
          </Notice>
        ) : null}
        {action.status === 'declined' ? (
          <Notice intent="neutral" title="Declined.">
            Nothing was changed. The agent will be told you declined.
          </Notice>
        ) : null}
        {action.status === 'expired' &&
        state.decisionOutcome?.kind !== 'expired' ? (
          <Notice intent="attention" title="This request expired.">
            Nothing was changed. Ask the agent to try again if you still want
            this action.
          </Notice>
        ) : null}
      </div>
      {action.status === 'declined' && state.decided === 'decline' ? (
        <PauseOffer action={action} state={state} onOpenPath={onOpenPath} />
      ) : null}
      <OpenExternalAgents onOpenPath={onOpenPath} />
    </>
  );
}

function OpenExternalAgents({
  onOpenPath,
}: {
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  return (
    <footer className="flex justify-end">
      <Button
        type="button"
        variant="secondary"
        size="compact"
        data-testid="external-agent-confirmation-open-agents"
        onClick={(): void => onOpenPath(EXTERNAL_AGENTS_PATH)}
      >
        Open External agents
      </Button>
    </footer>
  );
}
