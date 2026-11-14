import { memo, useState, useEffect, useCallback, type JSX } from 'react';
import {
  isRecoverableAuthFailureClass,
  isValidAuthDependencyFailure,
  type AuthDependencyClass,
  type AuthDependencyFailure,
  type AuthFailureClass,
  type AuthSettingsTarget,
} from '@canopy/protocol/auth-recovery';
import { Button, CopyButton, Notice } from '@canopy/ui-shared/components';
import { CheckIcon, WarningIcon } from '@canopy/ui-shared/icons/AppIcons';
import type {
  AuthTerminalProvider,
  SettingsSection,
} from '@canopy/desktop-shared/types';
import { useAuthRecoveryResume } from '@/hooks/useAuthRecoveryResume';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import { settleGitHubLogin } from '@/lib/githubConnection';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  useMcpAuthRecovery,
  type McpAuthRecoveryTarget,
} from '@/hooks/useMcpAuthRecovery';
import { openIntegrationSettings } from '@/lib/navigation/settings-destinations';

/**
 * Sentence fragments placed around the dependency's display name, so the name
 * can be emphasised without interpolating it into a pre-built string.
 */
interface AuthRecoveryCopy {
  before: string;
  after: string;
}

/**
 * Copy is a TOTAL function of `failureClass` (CAN-1814). A `Record` over the
 * closed union rather than a switch, so adding a failure class fails the build
 * here instead of silently rendering an empty card — which is exactly what an
 * HTTP 403 did before this component existed.
 */
const FAILURE_COPY: Record<AuthFailureClass, AuthRecoveryCopy> = {
  unauthenticated: { before: '', after: ' needs to be reconnected.' },
  expired: { before: '', after: ' needs to be reconnected.' },
  revoked: { before: '', after: ' needs to be reconnected.' },
  reauthorization_required: {
    before: '',
    after: ' needs to be reconnected.',
  },
  insufficient_scope: {
    before: '',
    after:
      ' refused this request — the connection is missing a required permission. Reconnecting will not grant it.',
  },
  quota_exceeded: { before: '', after: ' is over its usage limit.' },
  provider_outage: { before: '', after: ' is unavailable right now.' },
  network_error: { before: 'Could not reach ', after: '.' },
  misconfigured: { before: '', after: ' is not fully configured.' },
  unsupported_auth_method: {
    before: '',
    after: ' uses an authentication method that cannot be completed here.',
  },
};

/**
 * Failure classes whose fix lives in a configuration surface rather than in a
 * login. These may offer a settings route even though their `recovery` is
 * necessarily `{ kind: 'none' }` — the wire invariant forbids a non-`none`
 * recovery on a non-recoverable class. Opening settings is not a login
 * affordance, which is the thing `recovery.kind === 'none'` forbids.
 */
const CONFIGURATION_FAILURE_CLASSES: readonly AuthFailureClass[] = [
  'insufficient_scope',
  'misconfigured',
  'unsupported_auth_method',
];

/** Where the secondary/settings action navigates. */
export type AuthSettingsDestination =
  | { kind: 'mcp-servers' }
  /** GitHub and Linear on this computer, wherever the rail shows them. */
  | { kind: 'integrations' }
  | { kind: 'settings'; section: SettingsSection };

/**
 * What the action means to the user, independent of how it is carried out.
 *
 * `connect` is the login affordance the recoverable classes may offer — even
 * when it is carried out by opening a configuration surface, as the legacy
 * MCP fallback must (it knows a display name but no `serverId`/`configId`).
 * `settings` is the strictly non-login route offered to a failure that
 * logging in cannot fix. Automation distinguishes the two by test id.
 */
export type AuthRecoveryActionIntent = 'connect' | 'settings';

/**
 * The card's primary action, derived from `recovery.kind` — NEVER from
 * `failureClass` alone. A failure whose recovery is `none` can only ever reach
 * an `open-settings` action with the `settings` intent, so "log in again" can
 * never be offered for a quota, outage, or scope failure.
 */
export type AuthRecoveryAction =
  | {
      kind: 'mcp-oauth';
      intent: 'connect';
      label: string;
      target: McpAuthRecoveryTarget;
    }
  | {
      kind: 'provider-login';
      intent: 'connect';
      label: string;
      /**
       * Includes `github`: the GitHub CTA drives the SAME
       * `AuthTerminalManager` PTY the Settings > Account sign-in button does,
       * running `gh auth login` (CAN-1814 PR 4). Not a new auth path — the
       * same modal, reached one click earlier.
       */
      provider: AuthTerminalProvider;
    }
  | {
      kind: 'open-settings';
      intent: AuthRecoveryActionIntent;
      label: string;
      destination: AuthSettingsDestination;
    };

export interface AuthRecoveryCardProps {
  /**
   * Every dependency this turn is blocked on, in checklist order. Callers pass
   * a single-element list for the common case; `readAuthDependencyFailures`
   * produces the list from a persisted block.
   */
  failures: readonly AuthDependencyFailure[];
  originChatTabId?: string;
  sourceMessageId?: string;
}

/** Plain-text form of the card's headline, used for tests and copy review. */
export function authRecoveryMessage(failure: AuthDependencyFailure): string {
  const copy = FAILURE_COPY[failure.failureClass];
  return `${copy.before}${failure.displayName}${copy.after}`;
}

function destinationForTarget(
  target: AuthSettingsTarget,
): AuthSettingsDestination {
  switch (target.page) {
    case 'mcp-servers':
      return { kind: 'mcp-servers' };
    case 'integrations':
      return { kind: 'integrations' };
    case 'provider-accounts':
      return { kind: 'settings', section: target.provider };
    default: {
      const unhandled: never = target;
      void unhandled;
      return { kind: 'settings', section: 'canopy' };
    }
  }
}

function destinationForDependencyClass(
  dependencyClass: AuthDependencyClass,
): AuthSettingsDestination {
  switch (dependencyClass) {
    case 'mcp':
      return { kind: 'mcp-servers' };
    case 'provider':
      return { kind: 'settings', section: 'harnesses' };
    case 'integration':
      return { kind: 'integrations' };
    default: {
      const unhandled: never = dependencyClass;
      void unhandled;
      return { kind: 'settings', section: 'canopy' };
    }
  }
}

/**
 * Resolve the single action this failure supports, or `null` when it supports
 * none. Exported so the invariant ("no login affordance unless `recovery`
 * says so") is unit-testable without rendering.
 */
export function resolveAuthRecoveryAction(
  failure: AuthDependencyFailure,
): AuthRecoveryAction | null {
  // Defence in depth: the persisted read path does not re-validate
  // `authFailure`, so a hand-edited or truncated chat file can pair a
  // non-recoverable class with a login recovery. Callers already guard, and
  // this makes the guard impossible to forget.
  if (!isValidAuthDependencyFailure(failure)) {
    return null;
  }
  const name = failure.displayName;
  const recovery = failure.recovery;
  switch (recovery.kind) {
    case 'mcp_oauth':
      return {
        kind: 'mcp-oauth',
        intent: 'connect',
        label: `Reconnect ${name}`,
        target: { serverId: recovery.serverId, configId: recovery.configId },
      };
    case 'provider_terminal':
      return {
        kind: 'provider-login',
        intent: 'connect',
        label: `Reconnect ${name}`,
        provider: recovery.provider,
      };
    case 'github_login':
      // Reuses the existing `gh auth login` terminal flow (CAN-1814 PR 4).
      return {
        kind: 'provider-login',
        intent: 'connect',
        label: `Reconnect ${name}`,
        provider: 'github',
      };
    case 'linear_login':
      // Linear has NO first-party terminal login to reuse: `resolveLinearToken`
      // reads a stored token and there is no `gh`-equivalent CLI to drive, so
      // the focused configuration surface is the honest route. Nothing emits
      // this kind today either — see the Linear note in
      // `main/lib/auth-preflight.ts`.
      return {
        kind: 'open-settings',
        intent: 'connect',
        label: `Connect ${name}`,
        destination: { kind: 'integrations' },
      };
    case 'settings_deeplink':
      return isRecoverableAuthFailureClass(failure.failureClass)
        ? {
            kind: 'open-settings',
            intent: 'connect',
            label: `Connect ${name}`,
            destination: destinationForTarget(recovery.target),
          }
        : {
            kind: 'open-settings',
            intent: 'settings',
            label: `Open ${name} settings`,
            destination: destinationForTarget(recovery.target),
          };
    case 'none':
      return CONFIGURATION_FAILURE_CLASSES.includes(failure.failureClass)
        ? {
            kind: 'open-settings',
            intent: 'settings',
            label: `Open ${name} settings`,
            destination: destinationForDependencyClass(failure.dependencyClass),
          }
        : null;
    default: {
      const unhandled: never = recovery;
      void unhandled;
      return null;
    }
  }
}

function openAuthSettings(destination: AuthSettingsDestination): void {
  const navigation = useNavigationStore.getState();
  if (destination.kind === 'mcp-servers') {
    navigation.openPluginsTab('mcp');
    return;
  }
  if (destination.kind === 'integrations') {
    openIntegrationSettings();
    return;
  }
  navigation.openSettings(destination.section);
}

/**
 * Stable automation hook for the action button.
 *
 * `chat-connection-cta-*` means CONNECT — it predates this component and the
 * CAN-1814 Electron specs assert both its presence for a recoverable failure
 * and its absence for one that logging in cannot fix. A settings-only route
 * therefore gets its own id rather than reusing that name.
 */
function ctaTestId(
  failure: AuthDependencyFailure,
  action: AuthRecoveryAction,
): string {
  if (action.intent === 'settings') {
    return 'auth-recovery-settings-cta';
  }
  if (action.kind === 'provider-login') {
    return `chat-connection-cta-${action.provider}`;
  }
  return `chat-connection-cta-${failure.dependencyClass}`;
}

/**
 * Collapse to one row per `dependencyId`, first occurrence winning.
 *
 * Defence in depth: the producer already deduplicates, but a persisted block is
 * read back unvalidated and two rows for the same server would offer two
 * reconnect buttons for one login.
 */
function dedupeFailures(
  failures: readonly AuthDependencyFailure[],
): AuthDependencyFailure[] {
  const seen = new Set<string>();
  const rows: AuthDependencyFailure[] = [];
  for (const failure of failures) {
    if (seen.has(failure.dependencyId)) continue;
    seen.add(failure.dependencyId);
    rows.push(failure);
  }
  return rows;
}

interface AuthRecoveryRowProps {
  failure: AuthDependencyFailure;
  onConnectionState: (id: string, connected: boolean) => void;
}

/**
 * One dependency's line in the card: what failed, and the single action (if
 * any) that addresses it.
 *
 * A component rather than inline JSX specifically so each row owns its OWN
 * `useMcpAuthRecovery` and login-modal state (CAN-1814 PR 2 Task 3). Rows are
 * keyed by `dependencyId`, so reconnecting one server neither blocks, resets,
 * nor collapses the others, and a failed reconnect stays contained to its row.
 */
const AuthRecoveryRow = memo(function AuthRecoveryRow({
  failure,
  onConnectionState,
}: AuthRecoveryRowProps): JSX.Element {
  const [loginOpen, setLoginOpen] = useState(false);
  const action = resolveAuthRecoveryAction(failure);
  const mcpTarget = action?.kind === 'mcp-oauth' ? action.target : null;
  const recovery = useMcpAuthRecovery(mcpTarget);
  const copy = FAILURE_COPY[failure.failureClass];

  const connected = mcpTarget !== null && recovery.status === 'connected';
  useEffect(() => {
    onConnectionState(failure.dependencyId, connected);
  }, [failure.dependencyId, connected, onConnectionState]);
  const busy =
    recovery.status === 'starting' ||
    recovery.status === 'awaiting-browser' ||
    recovery.status === 'verifying';

  const actionLabel = ((): string | null => {
    if (!action) return null;
    if (action.kind !== 'mcp-oauth') return action.label;
    switch (recovery.status) {
      case 'starting':
        return 'Connecting…';
      case 'awaiting-browser':
        return 'Waiting for browser…';
      case 'verifying':
        return 'Verifying…';
      case 'connected':
        return null;
      case 'failed':
        return 'Try again';
      case 'idle':
        return action.label;
      default: {
        const unhandled: never = recovery.status;
        void unhandled;
        return action.label;
      }
    }
  })();

  const onAction = (): void => {
    if (!action) return;
    switch (action.kind) {
      case 'mcp-oauth':
        recovery.start();
        return;
      case 'provider-login':
        setLoginOpen(true);
        return;
      case 'open-settings':
        openAuthSettings(action.destination);
        return;
      default: {
        const unhandled: never = action;
        void unhandled;
      }
    }
  };

  return (
    <div
      data-testid="auth-recovery-row"
      data-dependency-class={failure.dependencyClass}
      data-dependency-id={failure.dependencyId}
      data-failure-class={failure.failureClass}
      data-recovery-kind={failure.recovery.kind}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-3">
        {connected ? (
          <CheckIcon
            size={14}
            aria-hidden="true"
            className="shrink-0 fg-success"
          />
        ) : (
          <WarningIcon
            size={14}
            aria-hidden="true"
            className="shrink-0 fg-warning"
          />
        )}
        <span className="min-w-0 flex-1 break-words">
          {connected ? (
            <>
              <strong className="font-medium">{failure.displayName}</strong>
              {' is connected.'}
            </>
          ) : (
            <>
              {copy.before}
              <strong className="font-medium">{failure.displayName}</strong>
              {copy.after}
            </>
          )}
        </span>
        {actionLabel !== null && action ? (
          <Button
            size="compact"
            data-testid={ctaTestId(failure, action)}
            disabled={busy}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        ) : null}
      </div>
      {failure.detail && !connected ? (
        <p
          data-testid="auth-recovery-detail"
          className="min-w-0 break-words fg-secondary"
        >
          {failure.detail}
        </p>
      ) : null}
      {/*
        Also shown on a timed-out `failed`, not only while awaiting the
        browser (CAN-1814 review): the timeout copy tells the user to switch
        to their browser to finish signing in, and gating the link on
        `awaiting-browser` alone took it away at exactly the moment that
        instruction needs it. `authorizationUrl` survives the cap because the
        timeout transition carries the previous value forward.
      */}
      {(recovery.status === 'awaiting-browser' ||
        (recovery.status === 'failed' && recovery.timedOut)) &&
      recovery.authorizationUrl !== null ? (
        <div className="flex items-center gap-2">
          <span className="shrink-0 fg-secondary">
            Finish signing in, then leave this open:
          </span>
          <Button
            variant="link"
            data-testid="auth-recovery-authorization-url"
            onClick={(): void => {
              void window.api.browser.openExternal({
                url: recovery.authorizationUrl ?? '',
              });
            }}
            className="min-w-0 flex-1"
          >
            <span className="block truncate text-left">
              {recovery.authorizationUrl}
            </span>
          </Button>
          <CopyButton
            value={recovery.authorizationUrl}
            dataTestId="auth-recovery-copy-url"
            ariaLabel="Copy the authorization link"
            title="Copy the authorization link"
          />
        </div>
      ) : null}
      {recovery.status === 'failed' ? (
        <p
          data-testid="auth-recovery-failure-detail"
          className="min-w-0 break-words fg-secondary"
        >
          {recovery.timedOut
            ? 'Still not connected. Switch to your browser to finish signing in, then try again.'
            : (recovery.error ?? 'The reconnect could not be started.')}
        </p>
      ) : null}
      {loginOpen && action?.kind === 'provider-login' ? (
        <AuthLoginModal
          provider={action.provider}
          onClose={(): void => {
            setLoginOpen(false);
            // Refreshing GitHub credentials lets main resume turns stopped on
            // GitHub sign-in.
            if (action.provider === 'github') void settleGitHubLogin();
          }}
        />
      ) : null}
    </div>
  );
});

/**
 * Inline recovery for every dependency one turn is blocked on (CAN-1814).
 *
 * ONE card with a row per dependency, not one card per failure: a turn can be
 * blocked on several servers at once, and stacking separate cards would repeat
 * the frame and lose the "this is the set of things to fix" reading. Row state
 * lives in {@link AuthRecoveryRow}, so the rows are independent.
 *
 * Replaces `HarnessConnectionRecovery` (provider) and `McpConnectionRecovery`
 * (MCP), which between them hard-coded their copy, could not name the failing
 * server, and rendered nothing at all for a class they did not anticipate.
 */
export const AuthRecoveryCard = memo(function AuthRecoveryCard({
  failures,
  originChatTabId,
  sourceMessageId,
}: AuthRecoveryCardProps): JSX.Element | null {
  const rows = dedupeFailures(failures);
  const recovery = useAuthRecoveryResume(originChatTabId, sourceMessageId);
  const [connectedIds, setConnectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { resume } = recovery;
  const onConnectionState = useCallback(
    (id: string, connected: boolean): void => {
      setConnectedIds((previous) => {
        if (previous.has(id) === connected) return previous;
        const next = new Set(previous);
        if (connected) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );
  const ready =
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.recovery.kind === 'mcp_oauth' && connectedIds.has(row.dependencyId),
    );
  // The card never resends on its own. Replaying the interrupted turn can
  // repeat an external write, so the only automatic resume is the main-process
  // OAuth-settle path, which is gated on `autoResumeSafe`. Here the user
  // presses Resume.
  if (recovery.retired) return null;
  if (rows.length === 0) {
    return null;
  }
  return (
    <Notice
      intent="attention"
      role="alert"
      icon={null}
      data-testid="auth-recovery-card"
      data-blocker-count={rows.length}
      data-chat-notice=""
      className="mt-1"
    >
      <div className="flex flex-col gap-2">
        {rows.length > 1 ? (
          <p
            data-testid="auth-recovery-checklist-header"
            className="min-w-0 break-words fg-secondary"
          >
            {`${rows.length} connections need attention before this can continue.`}
          </p>
        ) : null}
        {rows.map((row) => (
          <AuthRecoveryRow
            key={row.dependencyId}
            failure={row}
            onConnectionState={onConnectionState}
          />
        ))}
        {ready && sourceMessageId ? (
          <Button
            size="compact"
            className="self-start"
            data-testid="auth-recovery-resume"
            disabled={!recovery.canResume || recovery.resuming}
            onClick={(): void => {
              void resume();
            }}
          >
            {recovery.resuming ? 'Resuming…' : 'Resume'}
          </Button>
        ) : null}
        {recovery.error ? (
          <p role="status" className="fg-secondary">
            {recovery.error}
          </p>
        ) : null}
      </div>
    </Notice>
  );
});
