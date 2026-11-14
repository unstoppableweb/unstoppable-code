import { type JSX, useState } from 'react';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { Button } from '@canopy/ui-shared';
import { canSignInAccountProxyAccountHere } from '@canopy/desktop-shared/lib/account-proxy';
import type { AccountProxyAccount } from '@canopy/desktop-shared/types/account-proxy';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import {
  useAccountProxyStatus,
  useAccountProxyStore,
} from '@/stores/accountProxyStore';

/**
 * Signs an account the proxy on this device can no longer renew in again.
 * The proxy keeps the same credential and refuses a different account.
 */
export function AccountProxySignInAgainButton({
  account,
}: {
  readonly account: AccountProxyAccount;
}): JSX.Element | null {
  const status = useAccountProxyStatus();
  const [failure, setFailure] = useState<InlineFailure | null>(null);
  const provider = account.provider;
  if (
    !canSignInAccountProxyAccountHere(account, status?.connection?.kind) ||
    (provider !== 'claude' && provider !== 'codex')
  ) {
    return null;
  }
  const waiting = status?.signIn?.phase === 'waiting';
  return (
    <span className="inline-flex shrink-0 flex-col items-end gap-1">
      <Button
        size="compact"
        disabled={waiting}
        data-testid={`account-proxy-sign-in-again-${account.authIndex}`}
        onClick={(): void => {
          setFailure(null);
          const accountProxy = window.api.accountProxy;
          if (!accountProxy) return;
          accountProxy
            .signIn({ action: 'start', provider, authIndex: account.authIndex })
            .then((next) => useAccountProxyStore.getState().setStatus(next))
            .catch((caught: unknown) => {
              const appError = toAppError(resolveClientAppError(caught));
              if (appError)
                setFailure(inlineFailure(appError, "Couldn't start sign-in."));
            });
        }}
      >
        {waiting ? 'Finishing sign-in…' : 'Sign in'}
      </Button>
      {failure ? (
        <DesktopErrorBanner
          errorSource="account-proxy-sign-in-again-button"
          error={failure.error}
          {...(failure.details === undefined
            ? {}
            : { details: failure.details })}
          className=""
        />
      ) : null}
    </span>
  );
}
