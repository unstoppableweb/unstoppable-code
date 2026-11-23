import { useEffect, useMemo, useRef, useState } from 'react';
import { newAccountMcpInstanceConfigId } from '@canopy/protocol/mcp-servers';
import { AccountMcpConnectionError } from '@canopy/execution-engine/types/mcp-servers';
import type { McpAccountActionsPort } from '@canopy/ui-app/capability';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  useAccountMcpSignIn,
  type AccountMcpSignIn,
} from './useAccountMcpSignIn';

const SAVE_FAILED = "Couldn't save the account. Try again.";
const REMOVE_FAILED = "Couldn't remove the account. Try again.";
// An older cloud answers a removal by only signing the account out.
const REMOVE_UNSUPPORTED =
  "Your cloud account can't remove accounts yet, so it was only signed out. Try again after it updates.";
const CATALOG_LOADING =
  'The connector’s setup is still loading. Try again in a moment.';
const ACCOUNT_CHANGED = new AccountMcpConnectionError('account-changed')
  .message;
// The same words a setup step uses when no cloud account is signed in.
const SIGN_IN_REQUIRED = 'Sign in to connect account servers.';
/** The configuration a person's first account of a server uses. */
const DEFAULT_CONFIG_ID = 'default';

/**
 * Whether the person holds no cloud account of `serverKey`, read when Add is
 * submitted rather than from the list the detail last loaded, so a
 * connection made elsewhere meanwhile is never taken over as the first
 * account. Any row counts, finished or not. An unreadable list counts as
 * holding one, so the account then gets its own configuration.
 */
async function holdsNoCloudAccount(serverKey: string): Promise<boolean> {
  try {
    const connections = await window.mcpServers.listAccountConnections();
    return !connections.some(
      (connection) => connection.serverKey === serverKey,
    );
  } catch (error) {
    reportClientAppError(error);
    return false;
  }
}

/** The signed-in cloud account, or undefined when it can't be read. */
async function cloudAccountId(): Promise<string | undefined> {
  try {
    return (await window.api?.loadCanopyCloudAccount?.())?.account?.id;
  } catch (error) {
    reportClientAppError(error);
    return undefined;
  }
}

/**
 * The desktop's account controls for one curated connector (CAN-6226). Add
 * another account runs the same sign-in as Connect (the catalog setup, token,
 * OAuth app and endpoint steps) for a new configuration named by the person,
 * in their browser; Rename and Make default edit the cloud connection in
 * place, and Remove deletes it from the account. `signIn` carries the setup
 * dialogs and the sign-in's failure, which the host renders once beside the
 * controls. The first account (beside a device copy, `firstOpen`) signs in
 * to the `default` configuration, so refs that name it reach it.
 */
export function useDesktopMcpAccountActions({
  serverKey,
  firstOpen,
  refresh,
}: {
  /** The curated key; null when the detail is not a curated account server. */
  serverKey: string | null;
  /** The detail last saw no cloud account beside a device copy. */
  firstOpen: boolean;
  refresh: () => Promise<void>;
}): {
  actions: McpAccountActionsPort | null;
  signIn: AccountMcpSignIn;
  /** An added account is still signing in; Add waits for it. */
  addPending: boolean;
} {
  const signIn = useAccountMcpSignIn(refresh, { enabled: serverKey !== null });
  const [addPending, setAddPending] = useState(false);
  // An Add still reading the account list when the detail closes must not
  // start a sign-in afterwards.
  const mounted = useRef(true);
  // The cloud account the Add dialog opened under, read as it opens.
  const openedUnder = useRef<Promise<string | undefined> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  const actions = useMemo((): McpAccountActionsPort | null => {
    if (!serverKey) return null;
    const update = async (
      connectionId: string,
      request: { label?: string | null; isDefault?: true },
    ): Promise<string | null> => {
      try {
        const result = await window.mcpServers.updateAccountConnection(
          connectionId,
          request,
        );
        if ('error' in result) return SAVE_FAILED;
        await refresh();
        return null;
      } catch (error) {
        reportClientAppError(error);
        return SAVE_FAILED;
      }
    };
    // Whether the last removal's failure was reported here (or by the sign-in
    // it cancelled). An older cloud's sign-out is not, so the confirmation
    // records that one.
    let removeReported = false;
    return {
      // The name dialog closes once the sign-in starts; its setup dialogs and
      // any failure show through `signIn`, like Connect's.
      beginAddAccount: (): void => {
        openedUnder.current = cloudAccountId();
      },
      addAccount: async (label: string): Promise<string | null> => {
        // The account the name was typed under, read as its dialog opened: an
        // unknown one can't be bound, a switch since then (or during the
        // lookup) stops the Add, and every start of its sign-in is bound to it.
        const accountId = await (openedUnder.current ?? cloudAccountId());
        if (!accountId) return SIGN_IN_REQUIRED;
        if ((await cloudAccountId()) !== accountId) return ACCOUNT_CHANGED;
        // An account beside another gets its own configuration; the first
        // (beside a device copy) takes `default`, as Connect's would.
        const first = firstOpen && (await holdsNoCloudAccount(serverKey));
        if (!mounted.current) return null;
        if ((await cloudAccountId()) !== accountId) return ACCOUNT_CHANGED;
        if (!mounted.current) return null;
        const target = {
          curatedKey: serverKey,
          configId: first ? DEFAULT_CONFIG_ID : newAccountMcpInstanceConfigId(),
        };
        if (signIn.waitsForCatalog(target)) return CATALOG_LOADING;
        // The person's browser, as Connect uses: the start still asks the
        // provider to let them choose an added account (prompt=select_account),
        // so it doesn't sign straight in as the one the browser holds. A
        // sign-in that is cancelled or fails takes its new row with it, so an
        // abandoned first account leaves the connector open for it again.
        // For the first account only the row its own start named goes:
        // `default` is shared, so a row found by configuration may be
        // another sign-in's. Add waits until this sign-in settles, so a retry
        // can't start a second one under the same name.
        setAddPending(true);
        signIn.connect(target, {
          label,
          expectedAccountId: accountId,
          discardOnAbandon: true,
          discardNamedRowOnly: first,
          onSettled: (): void => setAddPending(false),
        });
        return null;
      },
      renameAccount: (connectionId, label) => update(connectionId, { label }),
      makeDefault: (connectionId) => update(connectionId, { isDefault: true }),
      removeAccount: async (connectionId): Promise<string | null> => {
        // An account still waiting on its sign-in belongs to that sign-in:
        // cancelling it removes the row and ends the wait. Success is
        // reported only once the row is gone, since a cancellation the cloud
        // couldn't remove only signs the account out.
        removeReported = false;
        const pendingKey = signIn.actions.pendingKeyForConnection({
          id: connectionId,
          serverKey,
          configId: '',
        });
        if (pendingKey) {
          // Whether the cancellation reported its own failed removal; it
          // leaves the row behind then, which is the same failure.
          let cancelReported = false;
          try {
            cancelReported = await signIn.actions.cancel(
              pendingKey,
              connectionId,
            );
            const remaining = await window.mcpServers.listAccountConnections();
            await refresh();
            if (
              !remaining.some(
                (connection): boolean => connection.id === connectionId,
              )
            )
              return null;
            removeReported = cancelReported;
            return REMOVE_FAILED;
          } catch (error) {
            if (!cancelReported) reportClientAppError(error);
            removeReported = true;
            return REMOVE_FAILED;
          }
        }
        try {
          const { removed } =
            await window.mcpServers.removeAccountConnection(connectionId);
          await refresh();
          return removed ? null : REMOVE_UNSUPPORTED;
        } catch (error) {
          reportClientAppError(error);
          removeReported = true;
          return REMOVE_FAILED;
        }
      },
      removeFailureRecorded: (): boolean => removeReported,
    };
  }, [firstOpen, refresh, serverKey, signIn]);
  return { actions, signIn, addPending };
}
