'use client';

import { useEffect, useRef, type JSX, type RefObject } from 'react';
import {
  Button,
  DelayedLoadingPlaceholder,
  LoadingSpinner,
  Notice,
  NoticeButton,
  Skeleton,
} from '@canopy/ui-shared/components';
import { GitHubIcon } from '@canopy/ui-shared/icons/AppIcons';
import { withPrivacyClass } from '../account/privacy-class';
import { useSettingsPrivacy } from '../host';
import type {
  GitHubCloudConnectionDto,
  GitHubCloudTargetDto,
  GitHubCloudTargetState,
} from '@canopy/protocol/settings/account-github';
import type {
  GitHubCloudConnectionController,
  GitHubCloudControllerError,
} from './use-github-cloud-connection';

// ---------------------------------------------------------------------------
// Building blocks shared by the "GitHub for cloud" views (REG-3020): the
// Settings card and the reusable Connect step. Each is a pure view of the
// page's one controller (`useGitHubCloudConnection`); none requests, navigates
// or keeps a generation of its own. Every message about a failure is the
// controller's fixed local copy, never text from a response.
//
// - Busy buttons stay in the tab order (`aria-disabled`, not `disabled`) so a
//   focused button keeps focus and its changed label is announced.
// - A target awaiting Core ("Finishing setup") offers Check again, never an
//   invitation to reinstall: the installation is fine, adoption is pending.
// - A row hint never names a button: the action that installs again is
//   "Add account" in one connection state and "Install GitHub app" in another.
// ---------------------------------------------------------------------------

export interface StatusLine {
  readonly title: string;
  readonly detail?: string;
  /** Show the progress glyph: the status is a running process. */
  readonly progress?: boolean;
}

/**
 * Wraps a pressed action so a view can settle focus once it finishes. Every
 * control that the next state may remove (action buttons, Try again, a
 * Notice's dismiss) goes through it.
 */
export type SettleFocus = (action: () => void) => () => void;

export type PrimaryAction = 'connect' | 'install' | 'check' | null;

interface TargetPresentation {
  readonly label: string;
  /** Ink for the label; the text always carries the state too. */
  readonly ink: string;
  readonly hint: (target: GitHubCloudTargetDto) => string | null;
}

/**
 * How an account's state reads: its label and the reason a user cannot use it
 * yet. REG-3021's picker reuses these so a row that is unavailable explains
 * itself in the same words as Settings.
 */
export const GITHUB_CLOUD_TARGET_PRESENTATION: Readonly<
  Record<GitHubCloudTargetState, TargetPresentation>
> = {
  ACTIVE: { label: 'Active', ink: 'fg-success', hint: () => null },
  PENDING_ADOPTION: {
    label: 'Finishing setup',
    ink: 'fg-secondary',
    hint: () => "Cloud projects can't use it yet. Check again in a moment.",
  },
  NEEDS_APPROVAL: {
    label: 'Permissions needed',
    ink: 'fg-warning',
    hint: (target) =>
      target.accountType === 'Organization'
        ? "An owner of this organization needs to approve the app's permissions on GitHub, then check again."
        : "Approve the app's permissions on GitHub, then check again.",
  },
  SUSPENDED: {
    label: 'Suspended',
    ink: 'fg-warning',
    hint: () => 'Unsuspend the app on GitHub, then check again.',
  },
  REMOVED: {
    label: 'Removed',
    ink: 'fg-secondary',
    // Names no button: the action that installs again is "Add account" in one
    // connection state and "Install GitHub app" in another.
    hint: () =>
      'The app is no longer available for this account. Install it again to use its repositories.',
  },
};

/**
 * The app is installed but a target is blocked on GitHub (permissions to
 * approve, installation suspended). The fix happens on GitHub, then Check
 * again: reinstalling is not the way out.
 */
export function isBlockedOnGitHub(
  connection: GitHubCloudConnectionDto,
): boolean {
  return connection.targets.some(
    (target) =>
      target.state === 'NEEDS_APPROVAL' || target.state === 'SUSPENDED',
  );
}

/**
 * The last action answered `github-cloud-needs-reauth` without a durable
 * NEEDS_REAUTH (another verified GitHub identity, or a refresh rejection not
 * yet confirmed), so the stored state can still read ACTIVE. The views then
 * offer Reconnect beside that state: an explicit Connect reauthorizes.
 */
export function asksToReconnect(
  controller: GitHubCloudConnectionController,
): boolean {
  return controller.error?.code === 'github-cloud-needs-reauth';
}

/** The running process, if one is on: Connect, Install or a live check. */
function inFlightStatus(
  controller: GitHubCloudConnectionController,
): StatusLine | null {
  if (controller.busy === 'connect' || controller.busy === 'install') {
    return { title: 'Connecting to GitHub…', progress: true };
  }
  if (controller.checking || controller.busy === 'verify') {
    return { title: 'Checking with GitHub…', progress: true };
  }
  return null;
}

export function describeStatus(
  controller: GitHubCloudConnectionController,
  brandName: string,
): StatusLine | null {
  const { connection } = controller;
  // The first read has no status line: `ConnectionLoadingView` holds the
  // place with a spinner instead.
  if (connection === null) return null;
  const running = inFlightStatus(controller);
  if (running !== null) return running;
  switch (connection.state) {
    case 'DISCONNECTED':
      return {
        title: 'Not connected',
        detail: `You'll sign in with GitHub, then choose where to install the ${brandName} GitHub app.`,
      };
    case 'NEEDS_REAUTH':
      return {
        title: 'Sign in again',
        detail:
          'GitHub needs you to sign in again before cloud projects can use your repositories.',
      };
    case 'NEEDS_INSTALL':
      return isBlockedOnGitHub(connection)
        ? {
            title: 'GitHub app needs attention',
            detail:
              "The app is installed but can't be used yet. Follow the steps under each account on GitHub, then check again.",
          }
        : {
            title: 'GitHub app needed',
            detail: `Install the ${brandName} GitHub app on the account or organization that owns your repositories, then check again.`,
          };
    case 'ACTIVE':
      // A ready connection needs no explanation: the subtitle already says
      // what it is for and the account rows below say where it applies.
      return connection.readyForProjects
        ? { title: 'Connected' }
        : {
            title: 'Finishing setup',
            detail:
              'GitHub is connected. Cloud projects can use these repositories once setup finishes. Check again in a moment.',
          };
  }
}

interface ActionButtonProps {
  readonly testId: string;
  readonly label: string;
  /** Label while this button's own action runs; defaults to `label`. */
  readonly busyLabel?: string;
  readonly primary: boolean;
  /** This button's own action is running. */
  readonly busy: boolean;
  /** Another action is running; the press is ignored. */
  readonly blocked: boolean;
  readonly onPress: () => void;
  readonly className?: string;
}

/**
 * One action. While busy or blocked it keeps `aria-disabled` rather than
 * `disabled`, so a focused button stays focused and a busy label is announced.
 */
export function ActionButton({
  testId,
  label,
  busyLabel,
  primary,
  busy,
  blocked,
  onPress,
  className,
}: ActionButtonProps): JSX.Element {
  const inactive = busy || blocked;
  return (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      size="compact"
      data-testid={testId}
      aria-disabled={inactive ? true : undefined}
      aria-busy={busy ? true : undefined}
      className={className}
      onClick={() => {
        if (!inactive) onPress();
      }}
    >
      {busy ? (busyLabel ?? label) : label}
    </Button>
  );
}

interface ControllerActionProps {
  readonly controller: GitHubCloudConnectionController;
  /** Wraps the press so the view can settle focus once it finishes. */
  readonly press: SettleFocus;
  readonly primary: boolean;
}

interface ConnectActionProps extends ControllerActionProps {
  readonly testId: string;
  readonly label: string;
  /** Install intent (Install GitHub app, Add account) instead of Connect. */
  readonly install: boolean;
}

/** Connect, Reconnect, Install GitHub app or Add account: opens GitHub. */
export function ConnectAction({
  controller,
  press,
  primary,
  testId,
  label,
  install,
}: ConnectActionProps): JSX.Element {
  const connecting =
    controller.busy === 'connect' || controller.busy === 'install';
  const blocked = controller.busy !== null || controller.checking;
  return (
    <ActionButton
      testId={testId}
      label={label}
      busyLabel="Connecting…"
      primary={primary}
      busy={connecting}
      blocked={blocked}
      onPress={press(
        () =>
          void (install
            ? controller.connect({ intent: 'install' })
            : controller.connect()),
      )}
    />
  );
}

/** Check again: a live check against GitHub. */
export function CheckAgainAction({
  controller,
  press,
  primary,
}: ControllerActionProps): JSX.Element {
  const verifying = controller.busy === 'verify' || controller.checking;
  const blocked = controller.busy !== null || controller.checking;
  return (
    <ActionButton
      testId="github-cloud-check-again"
      label="Check again"
      busyLabel="Checking…"
      primary={primary}
      busy={verifying}
      blocked={blocked}
      onPress={press(() => void controller.verify())}
    />
  );
}

function TargetRow({ target }: { target: GitHubCloudTargetDto }): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const presentation = GITHUB_CLOUD_TARGET_PRESENTATION[target.state];
  const hint = presentation.hint(target);
  const kind =
    target.accountType === 'Organization' ? 'Organization' : 'Personal account';
  const selection =
    target.repositorySelection === 'all'
      ? 'all repositories'
      : 'selected repositories';
  return (
    <li
      data-testid="github-cloud-target"
      data-target-state={target.state}
      className="grid gap-x-4 gap-y-0.5 py-3 sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <p
        data-testid="github-cloud-target-login"
        title={target.accountLogin}
        className={withPrivacyClass(
          'min-w-0 truncate text-s font-medium fg-primary',
          blockClassName,
        )}
      >
        {target.accountLogin}
      </p>
      <p
        data-testid="github-cloud-target-state"
        className={`text-s font-medium ${presentation.ink}`}
      >
        {presentation.label}
      </p>
      <p className="text-s fg-tertiary">{`${kind}, ${selection}`}</p>
      {hint ? <p className="text-s fg-tertiary sm:col-span-2">{hint}</p> : null}
    </li>
  );
}

/** The accounts that explain why the connection cannot be used yet. */
export function TargetList({
  targets,
}: {
  targets: readonly GitHubCloudTargetDto[];
}): JSX.Element {
  return (
    <ul
      data-testid="github-cloud-targets"
      aria-label="GitHub accounts and organizations"
      className="flex flex-col divide-y"
    >
      {targets.map((target) => (
        <TargetRow key={target.id} target={target} />
      ))}
    </ul>
  );
}

/** The signed-in GitHub identity. A login is third-party text: one line. */
export function Identity({ login }: { login: string }): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  return (
    <div data-testid="github-cloud-identity" className="min-w-0">
      <p className="text-s fg-tertiary">GitHub account</p>
      <p className="flex min-w-0 items-center gap-2 text-s font-medium fg-primary">
        <GitHubIcon size={16} className="shrink-0" />
        <span
          data-testid="github-cloud-identity-login"
          title={login}
          className={withPrivacyClass('min-w-0 truncate', blockClassName)}
        >
          {login}
        </span>
      </p>
    </div>
  );
}

const SAMPLE_STATUS: StatusLine = {
  title: 'Connected',
  detail: 'Cloud projects can use your repositories',
};

/**
 * The first read of the connection, before there is anything to describe:
 * after the shared delay, the status line and account it will show, drawn
 * from plain samples inside the measured `Skeleton`, never loading copy.
 */
export function ConnectionLoadingView({
  controller,
}: {
  controller: GitHubCloudConnectionController;
}): JSX.Element | null {
  if (controller.connection !== null || !controller.loading) return null;
  return (
    <div data-testid="github-cloud-loading" className="flex min-h-16">
      <DelayedLoadingPlaceholder>
        <Skeleton
          loading
          label="Loading GitHub connection"
          testId="github-cloud-loading-skeleton"
        >
          <div className="flex flex-col gap-4">
            <p className="text-s">
              <StatusText status={SAMPLE_STATUS} />
            </p>
            <Identity login="octocat" />
          </div>
        </Skeleton>
      </DelayedLoadingPlaceholder>
    </div>
  );
}

/** The status line's words: its title, then its detail, quieter. */
function StatusText({ status }: { status: StatusLine }): JSX.Element {
  return (
    <>
      <span className="font-medium fg-primary">
        {status.detail ? `${status.title}.` : status.title}
      </span>
      {status.detail ? (
        <>
          {' '}
          <span className="fg-tertiary">{status.detail}</span>
        </>
      ) : null}
    </>
  );
}

/**
 * The status line: a polite live region. During the first read it has no
 * line to show (`ConnectionLoadingView` holds the place), so it stays mounted
 * empty and visually hidden; the first state it describes is then announced
 * as a change rather than appearing in a fresh region.
 */
export function StatusView({
  status,
}: {
  status: StatusLine | null;
}): JSX.Element {
  if (status === null) {
    return (
      <p role="status" data-testid="github-cloud-status" className="sr-only" />
    );
  }
  return (
    <p role="status" data-testid="github-cloud-status" className="text-s">
      {status.progress ? (
        <LoadingSpinner decorative quiet className="mr-2 align-middle" />
      ) : null}
      <StatusText status={status} />
    </p>
  );
}

export function NoticeView({
  controller,
  press,
}: {
  controller: GitHubCloudConnectionController;
  press: SettleFocus;
}): JSX.Element | null {
  const { connection, notice } = controller;
  if (notice === null) return null;
  // With no connection to show, the rollout notice is the whole view: keep it.
  const keep = notice.kind === 'unavailable' && connection === null;
  return (
    <Notice
      data-testid="github-cloud-notice"
      data-notice-kind={notice.kind === 'handoff' ? 'handoff' : undefined}
      actions={
        notice.kind === 'handoff' ? (
          <NoticeButton
            variant="secondary"
            data-testid="github-cloud-handoff-check-again"
            onClick={press(controller.reload)}
          >
            Check again
          </NoticeButton>
        ) : undefined
      }
      onDismiss={keep ? undefined : press(controller.dismissNotice)}
    >
      {notice.message}
    </Notice>
  );
}

export function ErrorView({
  controller,
  error: controllerFailure,
  press,
}: {
  controller: GitHubCloudConnectionController;
  error: GitHubCloudControllerError;
  press: SettleFocus;
}): JSX.Element {
  const loadFailed =
    controller.connection === null && controllerFailure.source === 'load';
  const rateLimited = controllerFailure.code === 'github-rate-limited';
  const lastKnown = controller.stale && controllerFailure.source === 'verify';
  return (
    <Notice
      errorSource="github-cloud"
      data-testid={
        rateLimited ? 'github-cloud-rate-limit' : 'github-cloud-error'
      }
      intent={rateLimited ? 'attention' : 'destructive'}
      detail={lastKnown ? 'Showing the last known status.' : undefined}
      actions={
        loadFailed ? (
          <NoticeButton
            variant="secondary"
            data-testid="github-cloud-retry"
            onClick={press(controller.reload)}
          >
            Try again
          </NoticeButton>
        ) : undefined
      }
      onDismiss={loadFailed ? undefined : press(controller.clearError)}
    >
      {/* Fixed local copy from the controller, never server text. */}
      {controllerFailure.message}
    </Notice>
  );
}

/**
 * Once a pressed action settles, a focused control that the new state removed
 * hands focus to `target`, never to `<body>`. Focus the user moved elsewhere
 * is left alone. Returns the wrapper that arms this for an action.
 */
export function useSettleFocus(
  controller: GitHubCloudConnectionController,
  target: RefObject<HTMLElement | null>,
): SettleFocus {
  const armed = useRef(false);
  useEffect(() => {
    if (!armed.current) return;
    if (controller.busy !== null || controller.checking || controller.loading) {
      return;
    }
    armed.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) target.current?.focus();
  });
  return (action) => () => {
    armed.current = true;
    action();
  };
}
