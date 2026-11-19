'use client';

import { useEffect, useRef, type JSX } from 'react';
import type {
  GitHubCloudConnectionDto,
  GitHubCloudTargetDto,
} from '@canopy/protocol/settings/account-github';
import { useSettingsBrand } from '../host';
import type { GitHubCloudConnectionController } from './use-github-cloud-connection';
import {
  classifySelection,
  isGitHubCloudReady,
  type GitHubCloudSelectedAccount,
  type GitHubCloudSelection,
} from './github-cloud-readiness';
import {
  asksToReconnect,
  CheckAgainAction,
  ConnectAction,
  ConnectionLoadingView,
  describeStatus,
  ErrorView,
  isBlockedOnGitHub,
  NoticeView,
  StatusView,
  TargetList,
  useSettleFocus,
  type PrimaryAction,
  type SettleFocus,
  type StatusLine,
} from './github-cloud-view-parts';

// ---------------------------------------------------------------------------
// The reusable "Connect GitHub" step (REG-3020).
//
// A pure view of the page's one controller (`useGitHubCloudConnection`): it
// never calls the hook, requests, navigates or keeps a generation of its own,
// so a page that also shows `GitHubCloudReauthNotice` mounts ONE controller
// and passes it to both. Add project's repository sources mount it
// (REG-3021, `AddWorkspaceCloudGitSource.tsx`); REG-3022 (repo-backed cloud
// composer) and REG-3025 (pull request actions) are its other consumers; see
// "Cloud Git Connect UI handoff" in docs/github-auth.md.
//
// `onReady` means adopted readiness after a fresh verification
// (`isGitHubCloudReady`): the live check answered, the connection is ACTIVE,
// `readyForProjects` is true (Core adopted a target for the current evidence
// generation) and, when the consumer selects an account (by installation id or
// by owner login), THAT account is ACTIVE too. It is called once per
// transition to ready: when the step mounts over a controller that is already
// ready, and again after the step became unready and recovered. A consumer
// that needs it once per page guards in its own state. It is never called for
// a stored snapshot, a failed or stale check, Core adoption pending, or an
// unavailable selected account. It is not a repository write grant: the
// consumer revalidates repository access before creating anything.
//
// Which condition the step shows when several hold (the first match wins):
//
//   1. no snapshot: loading, or the first-read failure with Try again;
//   2. a running Connect, Install or live check: that process;
//   3. DISCONNECTED: Connect GitHub;
//   4. NEEDS_REAUTH: Reconnect GitHub (the stored accounts are not shown);
//      likewise, Reconnect GitHub leads ahead of the actions below when the
//      last action answered `github-cloud-needs-reauth` without persisting
//      it (the stored state still reads ACTIVE or NEEDS_INSTALL);
//   5. a selected account, when given: not installed or removed -> Install
//      GitHub app; blocked on GitHub (permissions to approve, suspended) ->
//      Check again; awaiting Core adoption -> Check again;
//   6. NEEDS_INSTALL: nothing installed -> Install GitHub app; installed but
//      blocked on GitHub -> Check again (Install stays a secondary action);
//   7. ACTIVE, Core adoption pending (or unavailable): Finishing setup with
//      Check again, never an invitation to reinstall;
//   8. ACTIVE, ready but not freshly verified: Check again;
//   9. ready: nothing left to do.
//
// The controller's failure and notice show alongside whichever state holds.
// Accounts are listed only where they explain why the step is not ready; once
// it is ready, which accounts are unavailable (and why) is the picker's job.
// ---------------------------------------------------------------------------

type StepAction = 'connect' | 'install' | 'check';

interface StepPlan {
  readonly actions: readonly StepAction[];
  readonly primary: PrimaryAction;
}

/**
 * Whether installing the app, rather than checking again, is the way out.
 * Only asked while something is missing (NEEDS_INSTALL, or ACTIVE and not
 * ready).
 */
function installIsTheFix(
  connection: GitHubCloudConnectionDto,
  selection: GitHubCloudSelection,
): boolean {
  if (selection.status !== 'unselected') {
    return selection.status === 'unavailable';
  }
  return connection.state === 'NEEDS_INSTALL' && !isBlockedOnGitHub(connection);
}

function planStateStep(
  connection: GitHubCloudConnectionDto,
  selection: GitHubCloudSelection,
  ready: boolean,
): StepPlan {
  switch (connection.state) {
    case 'DISCONNECTED':
    case 'NEEDS_REAUTH':
      return { actions: ['connect'], primary: 'connect' };
    case 'NEEDS_INSTALL':
      // One order whatever leads: only the emphasis moves, so a focused
      // button is never reordered by the result of its own press.
      return {
        actions: ['install', 'check'],
        primary: installIsTheFix(connection, selection) ? 'install' : 'check',
      };
    case 'ACTIVE':
      if (ready) return { actions: [], primary: null };
      return installIsTheFix(connection, selection)
        ? { actions: ['install', 'check'], primary: 'install' }
        : { actions: ['check'], primary: 'check' };
  }
}

/**
 * The state's plan, led by Reconnect when the last action asked to sign in
 * again (`reconnect`) and the state has no Connect of its own.
 */
function planStep(
  connection: GitHubCloudConnectionDto,
  selection: GitHubCloudSelection,
  ready: boolean,
  reconnect: boolean,
): StepPlan {
  const plan = planStateStep(connection, selection, ready);
  if (!reconnect || plan.actions.includes('connect')) return plan;
  return { actions: ['connect', ...plan.actions], primary: 'connect' };
}

function selectedTargetStatus(
  selection: GitHubCloudSelection,
  brandName: string,
): StatusLine | null {
  switch (selection.status) {
    case 'unavailable':
      return {
        title: 'GitHub app needed',
        detail: `Install the ${brandName} GitHub app on the account or organization you selected, then check again.`,
      };
    case 'pending':
      return {
        title: 'Finishing setup',
        detail:
          'GitHub is connected. Cloud projects can use the account you selected once setup finishes. Check again in a moment.',
      };
    case 'blocked':
      return {
        title: 'GitHub app needs attention',
        detail:
          "The app is installed on the account you selected but can't be used yet. Follow the steps under it on GitHub, then check again.",
      };
    case 'unselected':
    case 'active':
      return null;
  }
}

function describeStepStatus(
  controller: GitHubCloudConnectionController,
  brandName: string,
  selection: GitHubCloudSelection,
  ready: boolean,
): StatusLine | null {
  const { connection } = controller;
  const shared = describeStatus(controller, brandName, 'cloud-project');
  // Loading, a running Connect or a live check: that process is the status.
  if (connection === null || shared === null || shared.progress) return shared;
  const installable =
    connection.state === 'ACTIVE' || connection.state === 'NEEDS_INSTALL';
  if (!installable) return shared;
  const selected = selectedTargetStatus(selection, brandName);
  if (selected !== null) return selected;
  if (connection.state === 'NEEDS_INSTALL' || !connection.readyForProjects) {
    return shared;
  }
  if (ready) return { title: 'GitHub connected' };
  // A failed check: the error already says so beside the last known state.
  if (controller.stale && controller.error !== null) return null;
  return {
    title: 'Not confirmed',
    detail: 'Check again to confirm that GitHub is still connected.',
  };
}

/**
 * The accounts that explain why the step is not ready. A ready step lists
 * none: which accounts are unavailable, and why, is then the picker's job.
 */
function reasonTargets(
  connection: GitHubCloudConnectionDto,
  selection: GitHubCloudSelection,
): readonly GitHubCloudTargetDto[] {
  if (connection.state !== 'ACTIVE' && connection.state !== 'NEEDS_INSTALL') {
    return [];
  }
  if (selection.status === 'unselected') {
    // Some account is usable (ready, or awaiting a fresh check): nothing to
    // explain. Otherwise every account says why it cannot be used yet.
    return connection.readyForProjects ? [] : connection.targets;
  }
  // A selected account that is active has nothing to explain.
  if (selection.status === 'active' || selection.target === null) return [];
  return [selection.target];
}

/**
 * Calls `onReady` once per transition to ready and re-arms when the step
 * becomes unready, so a recovery notifies again. The guard lives in this
 * mount's refs, so a step mounted anew over a controller that is already ready
 * notifies once too. The latest callback is
 * called, not the one from the render that became ready, and a Strict Mode
 * effect replay cannot double-notify (the guard is a ref, not an effect
 * cleanup).
 */
function useReadyNotification(ready: boolean, onReady: () => void): void {
  const latest = useRef(onReady);
  const notified = useRef(false);
  useEffect(() => {
    latest.current = onReady;
  });
  useEffect(() => {
    if (!ready) {
      notified.current = false;
      return;
    }
    if (notified.current) return;
    notified.current = true;
    latest.current();
  }, [ready]);
}

interface StepActionsProps {
  readonly controller: GitHubCloudConnectionController;
  readonly connection: GitHubCloudConnectionDto;
  readonly plan: StepPlan;
  readonly press: SettleFocus;
}

/**
 * Each action is keyed by its own identity, so a button that disappears never
 * hands its DOM node (and focus) to an action with another meaning.
 */
function StepActions({
  controller,
  connection,
  plan,
  press,
}: StepActionsProps): JSX.Element | null {
  if (plan.actions.length === 0) return null;
  return (
    <div
      data-testid="github-cloud-actions"
      className="flex flex-wrap items-center gap-2"
    >
      {plan.actions.map((action) => {
        switch (action) {
          case 'connect':
            return (
              <ConnectAction
                key="github-cloud-connect"
                controller={controller}
                press={press}
                testId="github-cloud-connect"
                label={
                  connection.state === 'DISCONNECTED'
                    ? 'Connect GitHub'
                    : 'Reconnect GitHub'
                }
                intent="connect"
                primary={plan.primary === 'connect'}
              />
            );
          case 'install':
            return (
              <ConnectAction
                key="github-cloud-install"
                controller={controller}
                press={press}
                testId="github-cloud-install"
                label="Install GitHub app"
                intent="install"
                primary={plan.primary === 'install'}
              />
            );
          case 'check':
            return (
              <CheckAgainAction
                key="github-cloud-check-again"
                controller={controller}
                press={press}
                primary={plan.primary === 'check'}
              />
            );
        }
      })}
    </div>
  );
}

/**
 * The selection form is `selectedInstallationId` OR `selectedAccountLogin`,
 * never both (see `GitHubCloudSelectedAccount`); neither means any usable
 * account will do.
 */
export type GitHubCloudConnectStepProps = {
  /** The page's one controller; the step never mounts its own. */
  readonly controller: GitHubCloudConnectionController;
  /**
   * Called once per transition to adopted readiness after fresh verification
   * (see `isGitHubCloudReady`): also when the step mounts over a controller
   * that is already ready, and again after the step became unready and
   * recovered. Consumers that need it once per page guard in their own state.
   * Never called for a stored snapshot, a failed or stale check, Core adoption
   * pending, or an unavailable selected account.
   */
  readonly onReady: () => void;
} & GitHubCloudSelectedAccount;

export function GitHubCloudConnectStep(
  props: GitHubCloudConnectStepProps,
): JSX.Element {
  const { controller, onReady } = props;
  const brand = useSettingsBrand();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const ready = isGitHubCloudReady(controller, props);
  // Declared before the settle-focus effect: a consumer that moves focus in
  // `onReady` does so first, and the step then leaves that focus alone.
  useReadyNotification(ready, onReady);
  const press = useSettleFocus(controller, rootRef);

  const { connection, error } = controller;
  const selection = classifySelection(connection?.targets ?? [], props);
  const status = describeStepStatus(
    controller,
    brand.displayName,
    selection,
    ready,
  );
  const targets =
    connection === null ? [] : reasonTargets(connection, selection);

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="GitHub connection"
      tabIndex={-1}
      data-testid="github-cloud-connect-step"
      className="flex flex-col gap-3"
    >
      <ConnectionLoadingView controller={controller} />
      {status !== null || controller.loading ? (
        <StatusView status={status} />
      ) : null}
      <NoticeView controller={controller} press={press} />
      {error ? (
        <ErrorView controller={controller} error={error} press={press} />
      ) : null}
      {targets.length > 0 ? <TargetList targets={targets} /> : null}
      {connection ? (
        <StepActions
          controller={controller}
          connection={connection}
          plan={planStep(
            connection,
            selection,
            ready,
            asksToReconnect(controller),
          )}
          press={press}
        />
      ) : null}
    </div>
  );
}
