import type { JSX, ReactNode } from 'react';
import type { DevicePlatform } from '@canopy/protocol/device-relay';
import {
  Button,
  EmptyState,
  ErrorBanner,
  ListRow,
  ListRowStatic,
  LoadingSpinner,
  Notice,
  Stack,
} from '@canopy/ui-shared/components';
import { RemoteControlPairingCode } from '@canopy/ui-shared/components/RemoteControlPairingCode';
import { MacbookIcon } from '@canopy/ui-shared/icons/AppIcons';
import { platformLabel } from './remote-control-display';

/**
 * How the flow sits in its host:
 *
 * - `dialog`: the flow owns the whole dialog body. Steps stack with the
 *   centered code, an error line and a trailing footer of large actions.
 * - `inline`: the flow is one part of a larger body (the web connect dialog,
 *   with its manual code entry and app offer). Compact actions follow the
 *   step they belong to.
 *
 * The two presentations keep each host's existing layout; converging them is
 * a deliberate design change, not part of sharing the flow.
 */
export type RemoteControlPairingPresentation = 'dialog' | 'inline';

/** A computer this device can pair with. */
export interface RemoteControlPairingComputer {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: DevicePlatform;
}

/** A computer on the account, listed with its own Connect action. */
export interface RemoteControlComputerChoice {
  readonly deviceId: string;
  readonly name: string;
  /** Offline computers are listed but cannot be chosen. */
  readonly online: boolean;
}

export interface RemoteControlPairingAction {
  readonly label: ReactNode;
  readonly onSelect: () => void;
  /** The step's main way forward. At most one action per step. */
  readonly primary?: boolean;
  readonly disabled?: boolean;
  readonly testId?: string;
}

/**
 * One step of the controller-side pairing flow. Hosts derive the step from
 * their own transport state (desktop IPC, Portal, the direct relay) and pass
 * its copy; the flow draws it the same way everywhere.
 */
export type RemoteControlPairingStep =
  /** Work in progress: looking for a scanned code, connecting. */
  | {
      readonly kind: 'progress';
      readonly message: ReactNode;
      readonly testId?: string;
    }
  /** Choose the computer to pair with. */
  | {
      readonly kind: 'choose';
      readonly computers: readonly RemoteControlPairingComputer[];
      /** Still looking: shown instead of the empty state while no computer is listed. */
      readonly searching: boolean;
      /** The empty state's explanation of how to make a computer pairable. */
      readonly emptyHint: string;
      readonly relayUnavailable: boolean;
      readonly disabled: boolean;
      readonly onChoose: (computer: RemoteControlPairingComputer) => void;
    }
  /**
   * The account's computers, online or not, each with a Connect action:
   * a controller that discovers computers itself rather than pairing with
   * whichever one is ready.
   */
  | {
      readonly kind: 'computers';
      readonly description: ReactNode;
      readonly computers: readonly RemoteControlComputerChoice[];
      /** Still looking: shown instead of the hint while none is listed. */
      readonly searching: boolean;
      /** How to make a missing computer appear; shown under the list. */
      readonly hint: ReactNode;
      readonly connectLabel: string;
      readonly disabled?: boolean;
      readonly onConnect: (computer: RemoteControlComputerChoice) => void;
    }
  /** Compare the six-digit code both devices show. */
  | {
      readonly kind: 'compare';
      readonly heading?: string;
      readonly instruction: ReactNode;
      /** Null until the handshake has produced it. */
      readonly code: string | null;
      /** What the flow is waiting for, such as approval on the other device. */
      readonly waiting?: ReactNode;
      readonly testId?: string;
    }
  /** A finished attempt: paired, declined. */
  | {
      readonly kind: 'outcome';
      readonly message: ReactNode;
      readonly testId?: string;
    }
  /** A failed attempt. */
  | {
      readonly kind: 'failed';
      readonly message: string;
      readonly testId?: string;
    }
  /**
   * A host-owned step the flow does not draw itself, such as the sign-in
   * prompt or the Portal's manual code entry.
   */
  | { readonly kind: 'content'; readonly content: ReactNode };

export interface RemoteControlPairingProps {
  readonly step: RemoteControlPairingStep;
  readonly presentation: RemoteControlPairingPresentation;
  /** The step's actions, in reading order. */
  readonly actions?: readonly RemoteControlPairingAction[];
  /** A failed action that leaves the step in place (dialog presentation). */
  readonly error?: string | null;
  /** Prefix for the flow's derived test ids (`<prefix>-status`, `-code`, ...). */
  readonly testIdPrefix: string;
}

/**
 * The controller side of Remote Control pairing: choose a computer, compare
 * the code both devices show, wait for the other device, then the outcome.
 * Shared by the desktop's Add a computer dialog and the web connect dialog.
 */
export function RemoteControlPairing({
  step,
  presentation,
  actions = [],
  error = null,
  testIdPrefix,
}: RemoteControlPairingProps): JSX.Element {
  if (presentation === 'inline') {
    return (
      <InlineStep step={step} actions={actions} testIdPrefix={testIdPrefix} />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <DialogStep step={step} testIdPrefix={testIdPrefix} />
      <ErrorBanner
        errorSource="remote-control-pairing"
        className=""
        error={error}
        testId={`${testIdPrefix}-error`}
      />
      <div className="flex items-center justify-end gap-2">
        {actions.map((action, index) => (
          <Button
            key={action.testId ?? index}
            variant={action.primary === true ? 'primary' : 'outline'}
            size="lg"
            disabled={action.disabled === true}
            onClick={action.onSelect}
            data-testid={action.testId}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function StatusLine({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId: string;
}): JSX.Element {
  return (
    <p
      role="status"
      className="flex items-center gap-2 text-s fg-secondary"
      data-testid={testId}
    >
      <LoadingSpinner tone="secondary" decorative />
      {children}
    </p>
  );
}

function DialogStep({
  step,
  testIdPrefix,
}: {
  readonly step: RemoteControlPairingStep;
  readonly testIdPrefix: string;
}): ReactNode {
  const statusTestId = `${testIdPrefix}-status`;
  switch (step.kind) {
    case 'progress':
      return (
        <StatusLine testId={step.testId ?? statusTestId}>
          {step.message}
        </StatusLine>
      );
    case 'choose':
      return (
        <ChooseComputer
          step={step}
          statusTestId={statusTestId}
          testIdPrefix={testIdPrefix}
        />
      );
    case 'computers':
      return (
        <AccountComputers
          step={step}
          statusTestId={statusTestId}
          testIdPrefix={testIdPrefix}
        />
      );
    case 'compare':
      return (
        <div className="flex flex-col gap-4" data-testid={step.testId}>
          {step.heading !== undefined ? (
            <p className="text-s font-medium fg-primary">{step.heading}</p>
          ) : null}
          <p className="text-s fg-secondary">{step.instruction}</p>
          {step.code !== null ? (
            <RemoteControlPairingCode
              code={step.code}
              size="hero"
              data-testid={`${testIdPrefix}-code`}
            />
          ) : null}
          {step.waiting !== undefined ? (
            <StatusLine testId={statusTestId}>{step.waiting}</StatusLine>
          ) : null}
        </div>
      );
    case 'outcome':
      return (
        <p
          role="status"
          className="text-s fg-primary"
          data-testid={step.testId}
        >
          {step.message}
        </p>
      );
    case 'failed':
      return (
        <ErrorBanner
          errorSource="remote-control-pairing-step"
          className=""
          testId={step.testId}
          error={step.message}
        />
      );
    case 'content':
      return step.content;
  }
}

function ChooseComputer({
  step,
  statusTestId,
  testIdPrefix,
}: {
  readonly step: Extract<RemoteControlPairingStep, { kind: 'choose' }>;
  readonly statusTestId: string;
  readonly testIdPrefix: string;
}): JSX.Element {
  return (
    <>
      {step.relayUnavailable ? (
        <Notice intent="attention" title="Can't reach the connection service">
          Retrying automatically. Check your internet connection.
        </Notice>
      ) : null}
      {step.computers.length > 0 ? (
        <>
          <p className="text-s fg-secondary">
            Choose the computer you want to control from this one.
          </p>
          <ul
            aria-label="Computers ready to pair"
            className="-mx-2 flex flex-col gap-px"
            data-testid={`${testIdPrefix}-list`}
          >
            {step.computers.map((computer) => (
              <li key={computer.deviceId}>
                <ListRow
                  disabled={step.disabled}
                  onClick={() => step.onChoose(computer)}
                  data-testid={`${testIdPrefix}-option-${computer.deviceId}`}
                  icon={<MacbookIcon size={16} aria-hidden="true" />}
                  trailing={platformLabel(computer.platform)}
                >
                  {computer.name}
                </ListRow>
              </li>
            ))}
          </ul>
        </>
      ) : step.searching ? (
        <StatusLine testId={statusTestId}>Looking for computers…</StatusLine>
      ) : (
        <EmptyState
          testId={`${testIdPrefix}-empty`}
          inset="none"
          title="No computers ready to pair"
          subtitle={step.emptyHint}
        />
      )}
    </>
  );
}

function InlineActions({
  actions,
}: {
  readonly actions: readonly RemoteControlPairingAction[];
}): JSX.Element | null {
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((action, index) => (
        <Button
          key={action.testId ?? index}
          variant={action.primary === true ? 'primary' : 'secondary'}
          size="compact"
          disabled={action.disabled === true}
          onClick={action.onSelect}
          data-testid={action.testId}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}

function InlineStep({
  step,
  actions,
  testIdPrefix,
}: {
  readonly step: RemoteControlPairingStep;
  readonly actions: readonly RemoteControlPairingAction[];
  readonly testIdPrefix: string;
}): ReactNode {
  switch (step.kind) {
    case 'progress':
      return (
        <Stack gap="group">
          <p
            role="status"
            className="flex items-center gap-1.5 text-s fg-secondary"
            data-testid={step.testId ?? `${testIdPrefix}-status`}
          >
            <LoadingSpinner decorative />
            {step.message}
          </p>
          <InlineActions actions={actions} />
        </Stack>
      );
    case 'compare':
      return (
        <div className="flex flex-col gap-4" data-testid={step.testId}>
          {step.heading !== undefined ? (
            <p className="text-s font-medium fg-primary">{step.heading}</p>
          ) : null}
          <Stack gap="tight">
            <p className="text-s fg-secondary">{step.instruction}</p>
            {step.code !== null ? (
              <RemoteControlPairingCode
                code={step.code}
                size="inline"
                data-testid={`${testIdPrefix}-code`}
              />
            ) : null}
          </Stack>
          {step.waiting !== undefined ? (
            <p
              role="status"
              className="flex items-center gap-1.5 text-s fg-secondary"
              data-testid={`${testIdPrefix}-status`}
            >
              <LoadingSpinner decorative />
              {step.waiting}
            </p>
          ) : null}
          <InlineActions actions={actions} />
        </div>
      );
    case 'outcome':
      return (
        <div className="flex flex-col gap-4" data-testid={step.testId}>
          <p role="status" className="text-s font-medium fg-primary">
            {step.message}
          </p>
          <InlineActions actions={actions} />
        </div>
      );
    case 'failed':
      return (
        <div className="flex flex-col gap-4">
          <ErrorBanner
            errorSource="inline-step"
            className=""
            testId={step.testId}
            error={step.message}
          />
          <InlineActions actions={actions} />
        </div>
      );
    case 'choose':
      return (
        <div className="flex flex-col gap-4">
          <ChooseComputer
            step={step}
            statusTestId={`${testIdPrefix}-status`}
            testIdPrefix={testIdPrefix}
          />
          <InlineActions actions={actions} />
        </div>
      );
    case 'computers':
      return (
        <div className="flex flex-col gap-4">
          <AccountComputers
            step={step}
            statusTestId={`${testIdPrefix}-status`}
            testIdPrefix={testIdPrefix}
          />
          <InlineActions actions={actions} />
        </div>
      );
    case 'content':
      return step.content;
  }
}

function AccountComputers({
  step,
  statusTestId,
  testIdPrefix,
}: {
  readonly step: Extract<RemoteControlPairingStep, { kind: 'computers' }>;
  readonly statusTestId: string;
  readonly testIdPrefix: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-s text-pretty fg-secondary">{step.description}</p>
      {step.computers.length > 0 ? (
        <ul
          aria-label="Computers"
          className="-mx-2 flex flex-col gap-px"
          data-testid={`${testIdPrefix}-computers`}
        >
          {step.computers.map((computer) => (
            <li key={computer.deviceId}>
              <ListRowStatic
                disabled={!computer.online}
                icon={<MacbookIcon size={16} aria-hidden="true" />}
                description={computer.online ? 'Online' : 'Offline'}
                actionsReveal={false}
                data-testid={`${testIdPrefix}-computer-${computer.deviceId}`}
                actions={
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={step.disabled === true || !computer.online}
                    onClick={() => step.onConnect(computer)}
                    aria-label={`${step.connectLabel} ${computer.name}`}
                    data-testid={`${testIdPrefix}-connect-${computer.deviceId}`}
                  >
                    {step.connectLabel}
                  </Button>
                }
              >
                {computer.name}
              </ListRowStatic>
            </li>
          ))}
        </ul>
      ) : step.searching ? (
        <StatusLine testId={statusTestId}>Looking for computers…</StatusLine>
      ) : null}
      <p
        className="text-s text-pretty fg-secondary"
        data-testid={`${testIdPrefix}-hint`}
      >
        {step.hint}
      </p>
    </div>
  );
}
