import { type JSX, useId, useRef, useState } from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  Button,
  FLOATING_MENU_GAP,
  FloatingMenu,
  ModelProviderIcon,
  ProviderAccountUsageDetails,
  useMinuteClock,
  ProviderStatusDot,
  type ProviderStatusDotTone,
} from '@canopy/ui-shared';
import {
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
  type IconSize,
} from '@canopy/ui-shared/icons/AppIcons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { canSignInAccountProxyAccountHere } from '@canopy/desktop-shared/lib/account-proxy';
import { projectAccountProxyUsageAccount } from '@canopy/desktop-shared/lib/account-proxy-usage-projection';
import type {
  AccountProxyAccount,
  AccountProxyAccountStatus,
  AccountProxyStatus,
} from '@canopy/desktop-shared/types/account-proxy';
import { DeleteConfirmModal } from '@/components/shared/DeleteConfirmModal';
import {
  useAccountProxyStatus,
  useAccountProxyStore,
} from '@/stores/accountProxyStore';
import { SettingsRow, SettingsSubRow } from '../SettingsLayout';
import {
  accountProxyAccountDescription,
  accountProxyProviderLabel,
} from './accountProxyCopy';
import { AccountProxySignInAgainButton } from './AccountProxySignInAgainButton';
import { ErrorBanner, StatusLabel } from '@canopy/ui-shared/components';

const STATUS_DOT_TONES: Readonly<
  Record<AccountProxyAccountStatus, ProviderStatusDotTone>
> = {
  active: 'connected',
  refreshing: 'connected',
  cooling: 'limited',
  error: 'failed',
  disabled: 'idle',
  pending: 'pending',
  'sign-in-required': 'failed',
};

const STATUS_LABELS: Readonly<Record<AccountProxyAccountStatus, string>> = {
  active: 'Ready',
  refreshing: 'Ready',
  cooling: 'At a limit',
  error: 'Needs attention',
  disabled: 'Turned off',
  pending: 'Signing in',
  'sign-in-required': 'Needs sign-in',
};

export function AccountProxyStatusDot({
  status,
}: {
  readonly status: AccountProxyAccountStatus;
}): JSX.Element {
  return (
    <ProviderStatusDot
      tone={STATUS_DOT_TONES[status]}
      label={STATUS_LABELS[status]}
      data-status={status}
    />
  );
}

function AccountLabel({
  account,
  iconSize,
  labelId,
}: {
  readonly account: AccountProxyAccount;
  readonly iconSize: IconSize;
  /** Lets the row's menu button name the account by reference, not text. */
  readonly labelId: string;
}): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span
        className="inline-flex shrink-0 fg-primary"
        title={accountProxyProviderLabel(account.provider)}
      >
        <ModelProviderIcon provider={account.provider} size={iconSize} />
      </span>
      <span id={labelId} className={`truncate ${POSTHOG_REPLAY_BLOCK_CLASS}`}>
        {account.label}
      </span>
      <AccountProxyStatusDot status={account.status} />
    </span>
  );
}

// Session replay records attribute values, and account labels are often
// emails, so the menu is named generically and points at the label element
// (which is blocked from replay) instead of copying its text.
const ACCOUNT_MENU_LABEL = 'Account actions';

function AccountMenu({
  account,
  labelId,
  onToggleDisabled,
  onRemove,
}: {
  readonly account: AccountProxyAccount;
  readonly labelId: string;
  readonly onToggleDisabled: () => void;
  readonly onRemove: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // API-key accounts live in the server's config file; the management API
  // cannot turn them off or remove them, so there is nothing to offer.
  if (account.source !== 'sign-in') return null;
  return (
    <>
      <Button
        ref={buttonRef}
        size="compact"
        variant="ghost"
        iconOnly
        aria-label={ACCOUNT_MENU_LABEL}
        aria-describedby={labelId}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`account-proxy-account-menu-${account.authIndex}`}
        onClick={(): void => setOpen((value) => !value)}
      >
        <MoreHorizontalIcon size="sm" aria-hidden />
      </Button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        placement="bottom-right"
        gap={FLOATING_MENU_GAP}
        aria-label={ACCOUNT_MENU_LABEL}
        data-testid={`account-proxy-account-menu-surface-${account.authIndex}`}
        className="w-56"
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={[
              {
                key: 'toggle',
                label: account.status === 'disabled' ? 'Turn on' : 'Turn off',
                icon:
                  account.status === 'disabled' ? <PlayIcon /> : <PauseIcon />,
                testId: 'account-proxy-account-toggle',
                onSelect: onToggleDisabled,
              },
              {
                key: 'remove',
                label: 'Remove from proxy',
                icon: <TrashIcon />,
                tone: 'destructive',
                separatorBefore: true,
                testId: 'account-proxy-account-remove',
                onSelect: onRemove,
              },
            ]}
            onSelect={(item): void => {
              if (item.disabled || !item.onSelect) return;
              setOpen(false);
              buttonRef.current?.focus({ preventScroll: true });
              item.onSelect();
            }}
          />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </>
  );
}

interface AccountProxyAccountListProps {
  readonly accounts: readonly AccountProxyAccount[];
  /** `row` on the Multi-account proxy page; `sub` nested in Settings > Accounts. */
  readonly variant: 'row' | 'sub';
  /**
   * Hides the account menus, for while the server rejects the saved key:
   * every request with that key counts toward the server's 30-minute block.
   */
  readonly actionsDisabled?: boolean;
}

/**
 * The accounts a proxy shares, each with its status and limits, and a menu
 * to turn a signed-in account off or remove it from the server. Both change
 * the server for every client, so Remove asks first.
 */
export function AccountProxyAccountList({
  accounts,
  variant,
  actionsDisabled = false,
}: AccountProxyAccountListProps): JSX.Element {
  const idPrefix = useId();
  const nowMs = useMinuteClock();
  const connectionKind = useAccountProxyStatus()?.connection?.kind;
  const [removing, setRemoving] = useState<AccountProxyAccount | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (
    action: () => Promise<AccountProxyStatus | null>,
    onDone?: () => void,
  ): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const status = await action();
      if (status) useAccountProxyStore.getState().setStatus(status);
      onDone?.();
    } catch {
      setError("Couldn't change the account on the server. Try again.");
    } finally {
      setPending(false);
    }
  };

  const toggle = (account: AccountProxyAccount): void => {
    void run(
      () =>
        window.api.accountProxy?.setAccountDisabled({
          authIndex: account.authIndex,
          disabled: account.status !== 'disabled',
        }) ?? Promise.resolve(null),
    );
  };

  const rows = accounts.map((account) => {
    const labelId = `${idPrefix}-${account.authIndex}`;
    const control = actionsDisabled ? undefined : (
      <span className="inline-flex items-center gap-1">
        <AccountProxySignInAgainButton account={account} />
        <AccountMenu
          account={account}
          labelId={labelId}
          onToggleDisabled={(): void => toggle(account)}
          onRemove={(): void => setRemoving(account)}
        />
      </span>
    );
    const needsAttention =
      account.status === 'error' || account.status === 'sign-in-required';
    // Claude and Codex accounts show their named limits under the row, so
    // the description keeps only the plan or why the account can't serve.
    const showsUsage =
      account.provider === 'claude' || account.provider === 'codex';
    const description = accountProxyAccountDescription(account, {
      withLimits: !showsUsage,
      signInHere: canSignInAccountProxyAccountHere(account, connectionKind),
    });
    const usage = showsUsage ? (
      <div data-testid={`account-proxy-account-usage-${account.authIndex}`}>
        <ProviderAccountUsageDetails
          account={projectAccountProxyUsageAccount(account)}
          nowMs={nowMs}
          collapsible
        />
      </div>
    ) : null;
    return variant === 'row' ? (
      <SettingsRow
        key={account.authIndex}
        dataTestId={`account-proxy-account-${account.authIndex}`}
        label={
          <AccountLabel account={account} iconSize="md" labelId={labelId} />
        }
        description={
          needsAttention ? (
            <StatusLabel>{description}</StatusLabel>
          ) : (
            description
          )
        }
        control={control}
      >
        {usage}
      </SettingsRow>
    ) : (
      <SettingsSubRow
        key={account.authIndex}
        dataTestId={`account-proxy-account-${account.authIndex}`}
        label={
          <AccountLabel account={account} iconSize="sm" labelId={labelId} />
        }
        description={
          needsAttention ? (
            <StatusLabel>{description}</StatusLabel>
          ) : (
            description
          )
        }
        control={control}
      >
        {usage}
      </SettingsSubRow>
    );
  });

  return (
    <>
      {rows}
      <ErrorBanner
        errorSource="account-proxy-account-error"
        className=""
        error={error}
        testId="account-proxy-account-error"
      />
      {removing ? (
        <DeleteConfirmModal
          title="Remove this account from the proxy?"
          message={
            <p className="text-s fg-secondary">
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                {removing.label}
              </span>{' '}
              is removed from the server, so every app and device that uses this
              proxy loses it. To use it again, sign in to it on the server.
            </p>
          }
          confirmLabel="Remove"
          pendingLabel="Removing…"
          pending={pending}
          dataTestId="account-proxy-remove-confirm"
          confirmTestId="account-proxy-remove-confirm-button"
          onCancel={(): void => setRemoving(null)}
          onConfirm={(): void => {
            const target = removing;
            void run(
              () =>
                window.api.accountProxy?.removeAccount({
                  authIndex: target.authIndex,
                }) ?? Promise.resolve(null),
              () => setRemoving(null),
            );
          }}
        />
      ) : null}
    </>
  );
}
