import type { SecretValueInput } from '@canopy/execution-engine/types/stored-secrets';
import { useGitHubStore } from '@/stores/githubStore';
import type { AccountMcpClientSetup } from '@canopy/protocol/mcp-servers';
import {
  MCP_MANAGEMENT_REASONS,
  resolveMcpConnectionBadge,
} from '@canopy/ui-shared/lib/mcp-card-display';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AccountMcpConnection,
  McpServerDataView,
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  McpServerManagementCard,
  type McpAction,
  type McpTestConnectionOutcome,
} from '@canopy/ui-app/capability';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { withIpcErrorMessage } from '@/lib/ipcErrorMessage';
import {
  accountMcpConnectionKey,
  type AccountMcpActions,
} from '@/hooks/useAccountMcpActions';
import {
  AccountMcpCredentialDialog,
  type AccountMcpCredentialKind,
} from './AccountMcpControls';
import { CloudReachBackPanel } from './CloudReachBackPanel';
import { McpPromoteDialog } from './McpPlacementDialogs';
import {
  CLOUD_REGISTRATION_UNAVAILABLE,
  CLOUD_SINGLE_CONFIG_REQUIRED,
  cloudHeadersProblem,
  cloudMcpHeaders,
  cloudUrlProblem,
  isCloudReadyUrl,
  deleteDesktopMcpTarget,
  loadSignedInAccountId,
  promoteCustomMcpServer,
  requireCapturedMcpAccount,
} from './mcpManagementOperations';
import type { AccountMcpDetailSignIn } from './useAccountMcpActionRequests';
import { Stack, ErrorBanner } from '@canopy/ui-shared/components';

/** Host lifecycle stays here; both hosts render the same feature sections. */
export function DesktopMcpManagementSections({
  server,
  status,
  connection: givenConnection,
  row,
  actions,
  accountSignIn,
  accountEnabled,
  busy,
  onChanged,
  onDeleted,
  onMoveToDevice,
  onBusyChange,
  onActionStart,
  registerErrorClearer,
}: {
  server: McpServerDataView | null;
  status?: McpServerStatusEntry;
  connection?: AccountMcpConnection;
  row?: McpServerIndexEntry;
  actions: AccountMcpActions;
  /** The page's sign-in when it owns this connection's Connect and Cancel. */
  accountSignIn?: AccountMcpDetailSignIn;
  accountEnabled: boolean;
  busy: boolean;
  onChanged: () => Promise<void>;
  onDeleted?: () => void;
  onMoveToDevice: (connection: AccountMcpConnection) => void;
  onBusyChange: (busy: boolean) => void;
  onActionStart?: () => void;
  registerErrorClearer?: (clear: () => void) => () => void;
}): JSX.Element {
  const [linkedConnection, setLinkedConnection] =
    useState<AccountMcpConnection>();
  const connection = givenConnection ?? linkedConnection;
  useEffect(() => {
    if (
      !server ||
      givenConnection ||
      (server.definition.httpAuthHandler !== 'account' &&
        !row?.accountConnectionId)
    )
      return;
    let cancelled = false;
    void window.mcpServers
      .loadIndex()
      .then((index) => {
        const match = index.servers.find(
          (item) =>
            item.accountConnection &&
            (item.accountConnection.id === row?.accountConnectionId ||
              item.deviceCopies?.some(
                (copy) => copy.id === server.definition.id,
              )),
        );
        if (!cancelled) setLinkedConnection(match?.accountConnection);
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, [givenConnection, row?.accountConnectionId, server]);
  const targetKey = connection?.id ?? server?.definition.id ?? '';
  const [operating, setOperating] = useState(false);
  const operationRef = useRef(false);
  const [testing, setTesting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [pageConnecting, setPageConnecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [promotion, setPromotion] = useState<{ accountId: string } | null>(
    null,
  );
  const [credential, setCredential] = useState<{
    accountId: string;
    kind: AccountMcpCredentialKind;
    promotion: boolean;
    clientSetup?: AccountMcpClientSetup;
  } | null>(null);
  const [accountId, setAccountId] = useState<string>();
  const [refreshError, setRefreshError] = useState('');
  const rowErrorClearer = useRef<(() => void) | undefined>(undefined);
  const registerRowErrorClearer = useCallback(
    (clear: () => void): (() => void) => {
      rowErrorClearer.current = clear;
      return (): void => {
        if (rowErrorClearer.current === clear)
          rowErrorClearer.current = undefined;
      };
    },
    [],
  );
  const clearLocalErrors = useRef((): void => undefined);
  clearLocalErrors.current = (): void => {
    setRefreshError('');
    actions.clearError();
    rowErrorClearer.current?.();
  };
  useEffect(
    (): (() => void) | undefined =>
      registerErrorClearer?.((): void => clearLocalErrors.current()),
    [registerErrorClearer],
  );
  const clearErrors = (): void => {
    clearLocalErrors.current();
    if (onActionStart) onActionStart();
    else if (connection)
      accountSignIn?.clearError(accountMcpConnectionKey(connection));
  };
  const deleteAccount = useRef<Promise<string | undefined>>(
    Promise.resolve(undefined),
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const read = (): void => {
      void loadSignedInAccountId().then((id) => {
        if (!mounted.current) return;
        setAccountId(id);
        setPromotion((open) => (open?.accountId === id ? open : null));
        setCredential((open) => (open?.accountId === id ? open : null));
      });
    };
    read();
    const unsubscribe = window.mcpServers.onAuthChanged?.(read);
    return (): void => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      await onChanged();
      if (mounted.current) setRefreshError('');
    } catch {
      const message =
        'The action finished, but the server list could not refresh. Reopen the detail to try again.';
      if (mounted.current) setRefreshError(message);
      else useGitHubStore.getState().addToast(message, 'error');
    }
  }, [onChanged]);
  useEffect(() => {
    onBusyChange(
      operating ||
        testing ||
        (managing && !pageConnecting) ||
        promotion !== null ||
        credential !== null,
    );
    return (): void => onBusyChange(false);
  }, [
    credential,
    managing,
    onBusyChange,
    operating,
    pageConnecting,
    promotion,
    testing,
  ]);
  const provider =
    status?.handler === 'provider' ||
    server?.definition.httpAuthHandler === 'provider';
  const cloud = connection !== undefined;
  const deleteConnection =
    server && connection?.kind !== 'CUSTOM' ? undefined : connection;
  const custom = server
    ? server.definition.type === 'http' && !server.definition.curated
    : connection?.kind === 'CUSTOM';
  const cloudReason = !accountEnabled
    ? 'Cloud connections are unavailable.'
    : !accountId
      ? 'Sign in to manage cloud connections.'
      : undefined;
  const promotionReason =
    server && custom && !cloud
      ? (cloudReason ??
        (server.configs.length > 1
          ? CLOUD_SINGLE_CONFIG_REQUIRED
          : !isCloudReadyUrl(server.definition.url ?? '')
            ? (cloudUrlProblem(server.definition.url ?? '') ??
              'Enter an HTTPS URL in Advanced configuration first.')
            : cloudHeadersProblem(
                cloudMcpHeaders(server.definition.headers, server.configs),
              )))
      : undefined;
  const promote = async (
    token: SecretValueInput | undefined,
    expectedAccountId: string,
  ): Promise<void> => {
    if (!row) throw new Error('Reopen the server detail to move it.');
    await requireCapturedMcpAccount(expectedAccountId);
    await promoteCustomMcpServer(
      row,
      { bearerToken: token, expectedAccountId },
      actions,
      () => {
        if (mounted.current)
          setCredential({
            accountId: expectedAccountId,
            kind: 'bearer',
            promotion: true,
          });
      },
    );
    await refresh();
  };
  const accountAction: McpAction<() => Promise<void>> | undefined =
    connection &&
    (connection.kind === 'CUSTOM' || connection.status !== 'DISCONNECTED')
      ? cloudReason
        ? { available: false, reason: cloudReason }
        : {
            available: true,
            run: (): Promise<void> =>
              withIpcErrorMessage(async (): Promise<void> => {
                if (!accountId) return;
                clearErrors();
                const pageOwnedConnect =
                  connection.status === 'DISCONNECTED' && accountSignIn;
                // The placement row reports pending while validating identity.
                // That must not reserve the detail key against its own start.
                if (pageOwnedConnect) setPageConnecting(true);
                else onBusyChange(true);
                try {
                  await requireCapturedMcpAccount(accountId);
                  // Reconnect stays on the detail's primary; this slot ends a
                  // connection that still holds or awaits a credential.
                  if (
                    connection.status === 'PENDING' &&
                    accountSignIn?.isConnectingConnection(connection)
                  )
                    accountSignIn.cancel(accountMcpConnectionKey(connection));
                  else if (
                    connection.status === 'PENDING' &&
                    actions.isConnectingConnection(connection)
                  )
                    await actions.cancel(
                      actions.pendingKeyForConnection(connection) ??
                        accountMcpConnectionKey(connection),
                      connection.id,
                    );
                  else if (connection.status !== 'DISCONNECTED')
                    await actions.disconnect(connection.id);
                  else if (accountSignIn) {
                    const started = accountSignIn.start(connection);
                    if (started.kind === 'blocked')
                      throw new Error(started.reason);
                    if (started.kind === 'unsupported')
                      throw new Error(started.message);
                  } else if (
                    connection.kind === 'CUSTOM' &&
                    connection.authMode === 'BEARER'
                  ) {
                    setCredential({
                      accountId,
                      kind: 'bearer',
                      promotion: false,
                    });
                  } else
                    await actions.connect(
                      connection.serverKey,
                      connection.configId,
                      {
                        pendingKey: accountMcpConnectionKey(connection),
                        expectedAccountId: accountId,
                        onOAuthClientRequired: (clientSetup): void => {
                          void loadSignedInAccountId().then((current): void => {
                            if (mounted.current && current === accountId)
                              setCredential({
                                accountId,
                                kind: 'oauth-client',
                                promotion: false,
                                clientSetup,
                              });
                          });
                        },
                      },
                    );
                  await refresh();
                } finally {
                  if (pageOwnedConnect) {
                    if (mounted.current) setPageConnecting(false);
                  } else onBusyChange(false);
                }
              }),
          }
      : undefined;
  useCurrentUiStateReporter('plugins.connection.management', {
    healthStatus: resolveMcpConnectionBadge(status, connection?.status).status,
    testPending: testing,
    actionPending: managing,
    deleteConfirmOpen: confirming,
    promoteDialogOpen: promotion !== null,
    credentialDialogOpen: credential !== null,
    deviceServer: server !== null,
  });
  const captureDeleteAccount = useCallback((open: boolean): void => {
    setConfirming(open);
    if (open) deleteAccount.current = loadSignedInAccountId();
  }, []);
  return (
    <Stack gap="block" data-testid="mcp-browse-detail-management">
      <McpServerManagementCard
        health={{
          targetKey: targetKey,
          status: status,
          accountConnectionStatus: connection?.status,
          configs:
            server?.configs ??
            (connection
              ? [{ id: connection.configId, name: connection.displayName }]
              : []),
          testConnection:
            server && !provider
              ? {
                  available: true,
                  run: (configId): Promise<McpTestConnectionOutcome> =>
                    withIpcErrorMessage(() =>
                      window.mcpServers.testConnection(
                        server.definition.id,
                        configId,
                      ),
                    ),
                }
              : {
                  available: false,
                  reason: provider
                    ? MCP_MANAGEMENT_REASONS.provider
                    : MCP_MANAGEMENT_REASONS.cloudTest,
                },
          busy:
            busy ||
            operating ||
            managing ||
            promotion !== null ||
            credential !== null,
          onPendingChange: setTesting,
          onTested: (): void => {
            void refresh();
          },
        }}
        management={{
          targetKey: targetKey,
          serverName: server?.definition.name ?? connection?.displayName ?? '',
          placement: provider ? 'provider' : cloud ? 'cloud' : 'device',
          deleteScope:
            cloud && server
              ? deleteConnection
                ? 'device-and-cloud'
                : 'device-retaining-cloud'
              : undefined,
          account: accountAction
            ? {
                label:
                  connection?.status === 'CONNECTED' ||
                  connection?.status === 'REAUTH_REQUIRED'
                    ? 'Disconnect cloud account'
                    : connection?.status === 'PENDING'
                      ? 'Cancel connection'
                      : 'Connect cloud account',
                action: accountAction,
              }
            : undefined,
          moveToCloud:
            custom &&
            server &&
            !cloud &&
            !provider &&
            isCloudReadyUrl(server.definition.url ?? '')
              ? promotionReason
                ? { available: false, reason: promotionReason }
                : {
                    available: true,
                    run: (): Promise<void> => {
                      if (accountId) {
                        if (row && accountSignIn?.isPending(row.id))
                          return Promise.reject(
                            new Error('Finish the current sign-in first.'),
                          );
                        onBusyChange(true);
                        clearErrors();
                        setPromotion({ accountId });
                      }
                      return Promise.resolve();
                    },
                  }
              : undefined,
          moveToDevice:
            custom && cloud
              ? cloudReason
                ? { available: false, reason: cloudReason }
                : {
                    available: true,
                    run: (): Promise<void> => {
                      if (connection) onMoveToDevice(connection);
                      return Promise.resolve();
                    },
                  }
              : undefined,
          deleteServer: provider
            ? undefined
            : deleteConnection && cloudReason
              ? { available: false, reason: cloudReason }
              : {
                  available: true,
                  run: (): Promise<void> =>
                    withIpcErrorMessage(async (): Promise<void> => {
                      const expectedAccountId = await deleteAccount.current;
                      if (deleteConnection && !expectedAccountId)
                        throw new Error(
                          'Sign in to delete this cloud connection.',
                        );
                      try {
                        await deleteDesktopMcpTarget({
                          ...(server ? { serverId: server.definition.id } : {}),
                          ...(deleteConnection
                            ? { connection: deleteConnection }
                            : {}),
                          ...(expectedAccountId ? { expectedAccountId } : {}),
                        });
                      } catch (error) {
                        // Older clouds can sign out while declining removal.
                        // Reconcile that partial outcome, retaining the detail.
                        await refresh();
                        throw error;
                      }
                    }),
                },
          onDeleted: (): void => {
            onDeleted?.();
            void refresh();
          },
          busy:
            busy ||
            operating ||
            testing ||
            promotion !== null ||
            credential !== null,
          onPendingChange: setManaging,
          registerErrorClearer: registerRowErrorClearer,
          onConfirmationChange: captureDeleteAccount,
        }}
      />
      {server && !provider && (
        <CloudReachBackPanel
          serverId={server.definition.id}
          serverName={server.definition.name}
          configs={server.configs}
          busy={busy || operating || managing}
        />
      )}
      <ErrorBanner
        errorSource="desktop-mcp-management-sections-refresh"
        className=""
        error={refreshError}
        blockMessageFromReplay
      />
      {promotion && server && (
        <McpPromoteDialog
          serverId={server.definition.id}
          serverName={server.definition.name}
          onClose={() => setPromotion(null)}
          onConfirm={(token): void => {
            if (operationRef.current) return;
            clearErrors();
            operationRef.current = true;
            setOperating(true);
            const captured = promotion;
            setPromotion(null);
            void promote(token, captured.accountId)
              .catch((error: unknown) => {
                if (mounted.current)
                  setRefreshError(
                    error instanceof Error
                      ? error.message
                      : 'The server could not move. Try again.',
                  );
              })
              .finally(() => {
                operationRef.current = false;
                if (mounted.current) setOperating(false);
              });
          }}
        />
      )}
      {credential && (
        <AccountMcpCredentialDialog
          kind={credential.kind}
          clientSetup={credential.clientSetup}
          displayName={server?.definition.name ?? connection?.displayName ?? ''}
          intro={
            credential.promotion ? CLOUD_REGISTRATION_UNAVAILABLE : undefined
          }
          onClose={() => setCredential(null)}
          onSubmit={(value): void => {
            if (operationRef.current) return;
            clearErrors();
            operationRef.current = true;
            setOperating(true);
            const captured = credential;
            setCredential(null);
            void (async (): Promise<void> => {
              await requireCapturedMcpAccount(captured.accountId);
              if (captured.promotion && 'bearerToken' in value)
                await promote(value.bearerToken, captured.accountId);
              else if (connection) {
                await actions.connect(
                  connection.serverKey,
                  connection.configId,
                  {
                    ...value,
                    pendingKey: accountMcpConnectionKey(connection),
                    expectedAccountId: captured.accountId,
                  },
                );
                await refresh();
              }
            })()
              .catch((error: unknown) => {
                if (mounted.current)
                  setRefreshError(
                    error instanceof Error
                      ? error.message
                      : 'The connection could not finish. Try again.',
                  );
              })
              .finally(() => {
                operationRef.current = false;
                if (mounted.current) setOperating(false);
              });
          }}
        />
      )}
    </Stack>
  );
}
