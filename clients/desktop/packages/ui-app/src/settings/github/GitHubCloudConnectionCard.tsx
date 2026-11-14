'use client';

import { useRef, useState, type JSX, type RefObject } from 'react';
import { ErrorBanner, Heading } from '@canopy/ui-shared/components';
import { SettingsConfirmDialog, useSettingsBrand } from '../host';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';
import type { GitHubCloudConnectionDto } from '@canopy/protocol/settings/account-github';
import type {
  GitHubCloudConnectionController,
  GitHubCloudControllerError,
} from './use-github-cloud-connection';
import {
  ActionButton,
  asksToReconnect,
  CheckAgainAction,
  ConnectAction,
  ConnectionLoadingView,
  describeStatus,
  ErrorView,
  Identity,
  isBlockedOnGitHub,
  NoticeView,
  StatusView,
  TargetList,
  useSettleFocus,
  type PrimaryAction,
  type SettleFocus,
} from './github-cloud-view-parts';

// ---------------------------------------------------------------------------
// The "GitHub for cloud work" Settings card (REG-3020).
//
// A pure view of the page's one controller (`useGitHubCloudConnection`): it
// owns no request, no generation and no navigation. Every message it shows
// about a failure is the controller's fixed local copy, never text from a
// response. Its actions are:
//
// - Connect / Reconnect: `connect()`; Install GitHub app / Add account:
//   `connect({ intent: 'install' })`; Check again: `verify()`; Disconnect:
//   a SettingsConfirmDialog, closed only once `disconnect()` resolves true.
// - Reconnect also leads beside a stored ACTIVE or NEEDS_INSTALL state when
//   the last action answered `github-cloud-needs-reauth` (not persisted):
//   the error asks to reconnect, so the button must be there.
// - A target awaiting Core ("Finishing setup") offers Check again, never an
//   invitation to reinstall: the installation is fine, adoption is pending.
// - Busy buttons stay in the tab order (`aria-disabled`, not `disabled`) so a
//   focused button keeps focus and its changed label is announced.
//
// The status line, account rows, notices and action buttons are shared with
// the reusable Connect step: see `github-cloud-view-parts.tsx`.
// ---------------------------------------------------------------------------

const CARD_TITLE = 'GitHub for cloud work';

const DISCONNECT_MESSAGE =
  "Cloud projects can't use your GitHub repositories until you connect again. Signing in with GitHub isn't affected. Worktrees that are already running in the cloud keep working.";

function primaryAction(
  connection: GitHubCloudConnectionDto,
  stale: boolean,
  reconnect: boolean,
): PrimaryAction {
  if (reconnect) return 'connect';
  switch (connection.state) {
    case 'DISCONNECTED':
    case 'NEEDS_REAUTH':
      return 'connect';
    case 'NEEDS_INSTALL':
      return isBlockedOnGitHub(connection) ? 'check' : 'install';
    case 'ACTIVE':
      return connection.readyForProjects && !stale ? null : 'check';
  }
}

interface CardActionsProps {
  readonly controller: GitHubCloudConnectionController;
  readonly connection: GitHubCloudConnectionDto;
  /** Wraps an action so the card can settle focus once it finishes. */
  readonly press: SettleFocus;
  readonly onDisconnect: () => void;
}

/**
 * The state's actions. Each is keyed by its own identity: React would
 * otherwise reuse the DOM button of a vanished action for the next one
 * (Connect GitHub becoming Add account), leaving focus on a control with a
 * different meaning.
 */
function CardActions({
  controller,
  connection,
  press,
  onDisconnect,
}: CardActionsProps): JSX.Element {
  const reconnect = asksToReconnect(controller);
  const primary = primaryAction(connection, controller.stale, reconnect);

  const connectAction = (
    testId: string,
    label: string,
    install: boolean,
  ): JSX.Element => (
    <ConnectAction
      key={testId}
      controller={controller}
      press={press}
      testId={testId}
      label={label}
      install={install}
      primary={primary === (install ? 'install' : 'connect')}
    />
  );
  const checkAgain = (
    <CheckAgainAction
      key="github-cloud-check-again"
      controller={controller}
      press={press}
      primary={primary === 'check'}
    />
  );
  // Only where the state has no Connect of its own.
  const reconnectAction = reconnect
    ? [connectAction('github-cloud-connect', 'Reconnect GitHub', false)]
    : [];
  const disconnect = (
    <ActionButton
      key="github-cloud-disconnect"
      testId="github-cloud-disconnect"
      label="Disconnect"
      primary={false}
      busy={false}
      blocked={controller.busy === 'disconnect'}
      onPress={onDisconnect}
      className="sm:ml-auto"
    />
  );

  let actions: readonly JSX.Element[];
  switch (connection.state) {
    case 'DISCONNECTED':
      actions = [
        connectAction('github-cloud-connect', 'Connect GitHub', false),
      ];
      break;
    case 'NEEDS_REAUTH':
      actions = [
        connectAction('github-cloud-connect', 'Reconnect GitHub', false),
        disconnect,
      ];
      break;
    case 'NEEDS_INSTALL':
      // One order whatever leads: only the emphasis moves (Check again when an
      // installed account is blocked on GitHub), so a focused button is never
      // reordered by the result of its own press.
      actions = [
        ...reconnectAction,
        connectAction('github-cloud-install', 'Install GitHub app', true),
        checkAgain,
        disconnect,
      ];
      break;
    case 'ACTIVE':
      actions = [
        ...reconnectAction,
        connectAction('github-cloud-add-account', 'Add account', true),
        checkAgain,
        disconnect,
      ];
      break;
  }
  return (
    <div
      data-testid="github-cloud-actions"
      className="flex flex-wrap items-center gap-2"
    >
      {actions}
    </div>
  );
}

interface DisconnectDialogProps {
  readonly controller: GitHubCloudConnectionController;
  /** The failure of the Disconnect this dialog started, if any. */
  readonly error: GitHubCloudControllerError | null;
  readonly onClose: () => void;
  readonly restoreFocusRef: RefObject<HTMLElement | null>;
}

/**
 * Confirms Disconnect. It closes only once `disconnect()` resolves true; a
 * failure keeps it open with the error inside, still actionable.
 */
function DisconnectDialog({
  controller,
  error: disconnectFailure,
  onClose,
  restoreFocusRef,
}: DisconnectDialogProps): JSX.Element {
  const confirm = async (): Promise<void> => {
    if (await controller.disconnect()) onClose();
  };
  const cancel = (): void => {
    if (controller.error?.source === 'disconnect') controller.clearError();
    onClose();
  };
  return (
    <SettingsConfirmDialog
      title="Disconnect GitHub?"
      message={
        <div className="flex flex-col gap-3">
          <p>{DISCONNECT_MESSAGE}</p>
          {/* Fixed local copy from the controller, never server text. */}
          <ErrorBanner
            errorSource="github-cloud-disconnect-error"
            className=""
            error={disconnectFailure?.message}
            testId="github-cloud-disconnect-error"
          />
        </div>
      }
      confirmLabel="Disconnect"
      busyLabel="Disconnecting…"
      busy={controller.busy === 'disconnect'}
      destructive
      onConfirm={() => void confirm()}
      onCancel={cancel}
      dataTestId="github-cloud-disconnect-confirm"
      restoreFocusRef={restoreFocusRef}
    />
  );
}

export interface GitHubCloudConnectionCardProps {
  /** The page's one controller; the card never mounts its own. */
  readonly controller: GitHubCloudConnectionController;
}

export function GitHubCloudConnectionCard({
  controller,
}: GitHubCloudConnectionCardProps): JSX.Element {
  const brand = useSettingsBrand();
  const [confirming, setConfirming] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const press = useSettleFocus(controller, headingRef);

  const { connection, error } = controller;
  const status = describeStatus(controller, brand.displayName);
  const dialogError =
    confirming && error?.source === 'disconnect' ? error : null;
  const cardError = error === dialogError ? null : error;
  const showTargets =
    connection !== null &&
    connection.state !== 'DISCONNECTED' &&
    connection.state !== 'NEEDS_REAUTH' &&
    connection.targets.length > 0;

  return (
    <SettingsCard
      title={
        <Heading level={2} variant="section" ref={headingRef} tabIndex={-1}>
          {CARD_TITLE}
        </Heading>
      }
      subtitle={`Connect GitHub so cloud projects in ${brand.displayName} can use your repositories.`}
      testId="github-cloud-card"
    >
      <div className="flex flex-col gap-4">
        <ConnectionLoadingView controller={controller} />
        {status !== null || controller.loading ? (
          <StatusView status={status} />
        ) : null}
        <NoticeView controller={controller} press={press} />
        {cardError ? (
          <ErrorView controller={controller} error={cardError} press={press} />
        ) : null}
        {connection?.githubLogin ? (
          <Identity login={connection.githubLogin} />
        ) : null}
        {showTargets ? <TargetList targets={connection.targets} /> : null}
        {connection ? (
          <CardActions
            controller={controller}
            connection={connection}
            press={press}
            onDisconnect={() => setConfirming(true)}
          />
        ) : null}
      </div>

      {confirming ? (
        <DisconnectDialog
          controller={controller}
          error={dialogError}
          onClose={() => setConfirming(false)}
          restoreFocusRef={headingRef}
        />
      ) : null}
    </SettingsCard>
  );
}
