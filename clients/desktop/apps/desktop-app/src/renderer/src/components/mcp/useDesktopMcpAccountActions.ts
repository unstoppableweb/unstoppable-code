import { useMemo, useState } from 'react';
import { newAccountMcpInstanceConfigId } from '@canopy/protocol/mcp-servers';
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

/**
 * The desktop's account controls for one curated connector (CAN-6226). Add
 * another account runs the same sign-in as Connect (the catalog setup, token,
 * OAuth app and endpoint steps) for a new configuration named by the person,
 * in their browser; Rename and Make default edit the cloud connection in
 * place, and Remove deletes it from the account. `signIn` carries the setup
 * dialogs and the sign-in's failure, which the host renders once beside the
 * controls.
 */
export function useDesktopMcpAccountActions({
  serverKey,
  refresh,
}: {
  /** The curated key; null when the detail is not a curated account server. */
  serverKey: string | null;
  refresh: () => Promise<void>;
}): {
  actions: McpAccountActionsPort | null;
  signIn: AccountMcpSignIn;
  /** An added account is still signing in; Add waits for it. */
  addPending: boolean;
} {
  const signIn = useAccountMcpSignIn(refresh, { enabled: serverKey !== null });
  const [addPending, setAddPending] = useState(false);
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
    return {
      // The name dialog closes once the sign-in starts; its setup dialogs and
      // any failure show through `signIn`, like Connect's.
      addAccount: (label: string): Promise<string | null> => {
        const target = {
          curatedKey: serverKey,
          configId: newAccountMcpInstanceConfigId(),
        };
        if (signIn.waitsForCatalog(target))
          return Promise.resolve(CATALOG_LOADING);
        // The person's browser, as Connect uses: the start still asks the
        // provider to let them choose the account (prompt=select_account),
        // so it doesn't sign straight in as the one the browser holds. A
        // sign-in that is cancelled or fails takes its new row with it.
        // Add waits until this sign-in settles, so a retry can't start a
        // second one under the same name.
        setAddPending(true);
        signIn.connect(target, {
          label,
          discardOnAbandon: true,
          onSettled: (): void => setAddPending(false),
        });
        return Promise.resolve(null);
      },
      renameAccount: (connectionId, label) => update(connectionId, { label }),
      makeDefault: (connectionId) => update(connectionId, { isDefault: true }),
      removeAccount: async (connectionId): Promise<string | null> => {
        // An account still waiting on its sign-in belongs to that sign-in:
        // cancelling it removes the row and ends the wait. Success is
        // reported only once the row is gone, since a cancellation the cloud
        // couldn't remove only signs the account out.
        const pendingKey = signIn.actions.pendingKeyForConnection({
          id: connectionId,
          serverKey,
          configId: '',
        });
        if (pendingKey) {
          try {
            await signIn.actions.cancel(pendingKey, connectionId);
            const remaining = await window.mcpServers.listAccountConnections();
            await refresh();
            return remaining.some(
              (connection): boolean => connection.id === connectionId,
            )
              ? REMOVE_FAILED
              : null;
          } catch (error) {
            reportClientAppError(error);
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
          return REMOVE_FAILED;
        }
      },
    };
  }, [refresh, serverKey, signIn]);
  return { actions, signIn, addPending };
}
