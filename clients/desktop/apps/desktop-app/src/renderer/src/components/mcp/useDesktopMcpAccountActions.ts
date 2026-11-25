import { useEffect, useMemo, useRef, useState } from 'react';
import {
  newAccountMcpInstanceConfigId,
  type AccountMcpConnection,
} from '@canopy/protocol/mcp-servers';
import { AccountMcpConnectionError } from '@canopy/execution-engine/types/mcp-servers';
import type { McpAccountActionsPort } from '@canopy/ui-app/capability';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  useAccountMcpSignIn,
  type AccountMcpSignIn,
  type AccountMcpSignInFlow,
  type AccountMcpSignInTarget,
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
// Another account of this server is signing in; the same words as Connect's.
const SIGN_IN_UNDERWAY = 'Finish the current sign-in first.';
// The row changed since it was drawn: connected, turned off or gone.
const ACCOUNT_STATE_CHANGED =
  'This account changed since the list was shown. Check it and try again.';
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
  // The one sign-in these controls run (an Add, or a row's Sign in), so a
  // row's Sign in on the same account opens its page again instead of being
  // refused as a second flow.
  const running = useRef<{ readonly configId: string } | null>(null);
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
    // Read fresh from the cloud as the signed-in account (another account's
    // connection isn't found there): the row is still this server's and
    // configuration's, on, and not connected.
    const stillNeedsSignIn = async (
      connection: AccountMcpConnection,
    ): Promise<boolean> => {
      try {
        const current = await window.mcpServers.getAccountConnection(
          connection.id,
        );
        return (
          current.serverKey === serverKey &&
          current.configId === connection.configId &&
          current.enabled !== false &&
          current.status !== 'CONNECTED'
        );
      } catch (error) {
        // Not found as this account (another account's row, or gone), or
        // unreadable: either way nothing starts.
        reportClientAppError(error);
        return false;
      }
    };
    // Runs one sign-in in the person's browser, as Connect does. Set before
    // the start, so the attempt it replaces settles without clearing it.
    const start = (
      configId: string,
      target: AccountMcpSignInTarget,
      flow: AccountMcpSignInFlow,
      add = false,
    ): void => {
      const entry = { configId };
      running.current = entry;
      if (add) setAddPending(true);
      signIn.connect(target, {
        ...flow,
        onSettled: (): void => {
          if (running.current !== entry) return;
          running.current = null;
          setAddPending(false);
        },
      });
    };
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
        if (running.current) return SIGN_IN_UNDERWAY;
        start(
          target.configId,
          target,
          {
            label,
            expectedAccountId: accountId,
            discardOnAbandon: true,
            discardNamedRowOnly: first,
          },
          true,
        );
        return null;
      },
      signInAccount: async (connection): Promise<string | null> => {
        const target = {
          connection,
          curatedKey: serverKey,
          configId: connection.configId,
        };
        if (signIn.waitsForCatalog(target)) return CATALOG_LOADING;
        const current = running.current;
        if (current && current.configId !== connection.configId)
          return SIGN_IN_UNDERWAY;
        if (current) {
          // The same account's sign-in again: its page may never have opened
          // or was closed. The waiting flow keeps its poll, account binding
          // and cleanup; only its start is sent again, with no name, so a
          // rename made while it waited stands, and main opens a fresh page.
          if (!signIn.actions.isConnectingConnection(connection))
            return SIGN_IN_UNDERWAY;
          // One that finished signing in, or was turned off, since the row was
          // drawn is left to the waiting flow, which sees it on its next poll:
          // a start would reset it and clear its tokens.
          if (!(await stillNeedsSignIn(connection))) {
            await refresh();
            return null;
          }
          return signIn.actions.reopen(connection);
        }
        // The row must be the signed-in account's own, and still need a
        // sign-in: a row still listed from an account signed out since would
        // start under the new one and reset its connection of the same
        // configuration, and a start on one that connected meanwhile would
        // reset its tokens. The account is read around the list, so a switch
        // during the read stops it too.
        const accountId = await cloudAccountId();
        if (!accountId) return SIGN_IN_REQUIRED;
        const listed = await stillNeedsSignIn(connection);
        if ((await cloudAccountId()) !== accountId) return ACCOUNT_CHANGED;
        if (!listed) {
          await refresh();
          return ACCOUNT_STATE_CHANGED;
        }
        if (!mounted.current) return null;
        if (running.current) return SIGN_IN_UNDERWAY;
        start(connection.configId, target, { expectedAccountId: accountId });
        return null;
      },
      renameAccount: (connectionId, label) => update(connectionId, { label }),
      makeDefault: (connectionId) => update(connectionId, { isDefault: true }),
      removeAccount: async (connectionId): Promise<string | null> => {
        // An account still signing in ends that sign-in first, and waits for
        // its start to answer, so a start still in flight can't write the row
        // back after the delete; the browser sign-in itself isn't waited on.
        // An added account's cancellation removes its row; a row's own Sign
        // in only signs it out, so the account is then removed outright, as
        // is an added one the cloud couldn't remove.
        removeReported = false;
        let pendingKey: string | undefined;
        try {
          const listed = (
            await window.mcpServers.listAccountConnections()
          ).find((connection): boolean => connection.id === connectionId);
          pendingKey = signIn.actions.pendingKeyForConnection({
            id: connectionId,
            serverKey,
            configId: listed?.configId ?? '',
          });
        } catch (error) {
          reportClientAppError(error);
          removeReported = true;
          return REMOVE_FAILED;
        }
        if (pendingKey) {
          // Whether the cancellation reported its own failed removal; the
          // account is then removed outright below.
          let cancelReported = false;
          try {
            cancelReported = await signIn.actions.cancel(
              pendingKey,
              connectionId,
            );
            await signIn.actions.written(pendingKey);
            const remaining = await window.mcpServers.listAccountConnections();
            if (
              !remaining.some(
                (connection): boolean => connection.id === connectionId,
              )
            ) {
              await refresh();
              return null;
            }
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
