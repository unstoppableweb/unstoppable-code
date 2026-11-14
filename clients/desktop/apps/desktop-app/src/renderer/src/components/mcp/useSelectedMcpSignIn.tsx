import { Stack } from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  AccountMcpConnectionSummary,
  DetectedMcpServerInfo,
} from '@canopy/execution-engine/types/mcp-servers';
import type { McpServersSectionItem } from '@canopy/ui-app';
import { mcpServersNeedingSignIn } from '@canopy/ui-app/capability';
import {
  DialogModal,
  Button,
  ErrorBanner,
  Notice,
  NoticeButton,
  MCP_SIGN_IN_WAITING_LABEL,
} from '@canopy/ui-shared/components';
import {
  mcpAuthConnectLabel,
  mcpConnectErrorCodeTitle,
} from '@canopy/ui-shared/lib';
import {
  useAccountMcpSignIn,
  accountMcpSignInTargetKey,
  type AccountMcpSignIn,
  type AccountMcpSignInTarget,
} from '@/components/mcp/useAccountMcpSignIn';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  useDetectedMcpServers,
  type UseDetectedMcpServersResult,
} from '@/hooks/useDetectedMcpServers';
import type { McpRowDestination } from '@canopy/ui-shared/components';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { setMcpHttpAuthPreference } from '@canopy/execution-engine/lib/mcp-http-auth';
import { pluginSelectionsEqual } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { targetForDetectedServer } from '@/hooks/detectedMcpServerHelpers';
import { selectedMcpNavigation } from './selectedMcpNavigation';
import {
  desktopRouteSupported,
  isUnboundPlugin,
} from './selectedMcpDesktopRoute';

/** A strip row with what Connect needs to sign it in. */
interface HomeSignInRow extends McpServersSectionItem {
  readonly server: DetectedMcpServerInfo;
  /** The account flow's key and target for this row; absent for a device server. */
  readonly accountKey?: string;
  readonly target?: AccountMcpSignInTarget;
  /** Connect waits for the catalog to load. */
  readonly waitsForCatalog?: boolean;
  /** Connect waits for the server's connection to load. */
  readonly waitsForConnection?: boolean;
  /** An account server no connection can serve here; MCP settings can. */
  readonly opensSettings?: boolean;
  readonly unavailableReason?: string;
}

/** The account's connections, and whether the latest read of them landed. */
interface AccountConnections {
  readonly list: readonly AccountMcpConnectionSummary[];
  readonly status: 'loading' | 'loaded' | 'failed';
}

type HomeSignInStatus = 'signed_in' | 'not_signed_in' | 'needs_reconnecting';

function signInStatus(row: McpServersSectionItem): HomeSignInStatus {
  if (row.authStatus === 'connected') return 'signed_in';
  return mcpAuthConnectLabel(row.authStatus, row.canRefresh) === 'Reconnect'
    ? 'needs_reconnecting'
    : 'not_signed_in';
}

function isAccountServer(server: DetectedMcpServerInfo): boolean {
  if (server.source === 'plugin' && server.httpAuthHandler !== undefined)
    return server.httpAuthHandler === 'account';
  return server.scope === 'account' || server.authHandler === 'account';
}

function selectsCapabilities(selections: ChatTabPluginSelections): boolean {
  return (
    (selections.mcpServerRefs?.length ?? 0) > 0 ||
    selections.pluginRefs.length > 0 ||
    selections.collectionIds.length > 0
  );
}

/** Account bindings and catalog setup stay authoritative; unbound plugins require an explicit route choice. */
function signInRows(
  servers: readonly DetectedMcpServerInfo[],
  connections: AccountConnections,
  accountEnabled: boolean,
  signIn: Pick<AccountMcpSignIn, 'pending' | 'waitsForCatalog'> & {
    readonly pendingKeyForConnection: AccountMcpSignIn['actions']['pendingKeyForConnection'];
    readonly authorizing: ReadonlySet<string>;
  },
): HomeSignInRow[] {
  const rows = servers.flatMap((server): HomeSignInRow[] => {
    if (!isAccountServer(server)) {
      if (!server.canConnect && server.authStatus !== 'connected') return [];
      return [{ ...server, server }];
    }
    if (!accountEnabled) return [];
    const connection = connections.list.find(
      (candidate) => candidate.id === server.accountConnectionId,
    );
    const accountRow = {
      ...server,
      source: server.source === 'standalone' ? 'account' : server.source,
      authStatus:
        server.authStatus === 'connected'
          ? 'connected'
          : connection?.status === 'REAUTH_REQUIRED'
            ? 'expired'
            : server.authStatus,
      canRefresh: false,
      ...(connection?.authMode === 'NONE'
        ? { connectActionLabel: 'Enable', authStatusLabel: 'Not enabled' }
        : {}),
      server,
    } satisfies HomeSignInRow;
    const target: AccountMcpSignInTarget = {
      ...(connection ? { connection } : {}),
      ...(server.curatedKey ? { curatedKey: server.curatedKey } : {}),
      ...(connection?.configId
        ? { configId: connection.configId }
        : server.configId
          ? { configId: server.configId }
          : {}),
    };
    const targetKey = accountMcpSignInTargetKey(target);
    const initiatingKey = connection
      ? signIn.pendingKeyForConnection(connection)
      : undefined;
    const accountKey =
      targetKey !== undefined && signIn.pending.has(targetKey)
        ? targetKey
        : (initiatingKey ?? targetKey);
    const waiting = accountKey !== undefined && signIn.pending.has(accountKey);
    // Inventory can name the ID before its details or the start have landed.
    // Retain that already-owned flow without allowing a replacement Connect.
    if (!connection && server.accountConnectionId && waiting)
      return [
        {
          ...accountRow,
          canConnect: true,
          connectDisabled: true,
          waitsForConnection: true,
          connecting: true,
          waitingForSignIn: signIn.authorizing.has(server.key),
          accountKey,
          target,
        },
      ];
    if (
      connection === undefined &&
      server.accountConnectionId !== undefined &&
      connections.status !== 'loaded'
    )
      return [
        {
          ...accountRow,
          canConnect: true,
          connectDisabled: true,
          waitsForConnection: true,
        },
      ];
    // A stale nonempty binding never falls through to catalog setup or local OAuth.
    if (!connection && server.accountConnectionId)
      return [
        {
          ...accountRow,
          canConnect: false,
          opensSettings: true,
          unavailableReason: 'This MCP server is no longer available',
        },
      ];
    if (accountKey === undefined)
      return [
        {
          ...accountRow,
          canConnect: isUnboundPlugin(server),
          connectDisabled: connections.status !== 'loaded',
          opensSettings: true,
        },
      ];
    const waitsForCatalog = signIn.waitsForCatalog(target);
    return [
      {
        ...accountRow,
        canConnect: true,
        ...(waiting ? { connecting: true } : {}),
        // The detected row survives binding a newly created connection ID.
        waitingForSignIn: waiting && signIn.authorizing.has(server.key),
        ...(waiting || waitsForCatalog || connections.status !== 'loaded'
          ? { connectDisabled: true }
          : {}),
        accountKey,
        target,
        waitsForCatalog,
      },
    ];
  });
  return rows.sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

export interface SelectedMcpSignInOptions {
  /** The Home draft's plugin selections. */
  readonly selections: ChatTabPluginSelections | null;
  /** Report to App Advisor; only one mounted Home surface should. */
  readonly reportUiState?: boolean;
  readonly ownerKey?: string;
  readonly canChangeRoute?: () => boolean;
  readonly getSelections?: () => ChatTabPluginSelections | null;
  /** True only after the owning draft/chat accepts and persists the choice. */
  readonly onSelectionsChange?: (
    next: ChatTabPluginSelections,
  ) => boolean | Promise<boolean>;
}

export interface SelectedMcpSignInResult extends UseDetectedMcpServersResult {
  readonly rows: readonly HomeSignInRow[];
  readonly onConnect: (item: McpServersSectionItem) => void;
  readonly renderRowExtra: (item: McpServersSectionItem) => JSX.Element | null;
  readonly dialogs: JSX.Element;
  readonly notice: JSX.Element | undefined;
  readonly getRowNavigation: (
    item: McpServersSectionItem,
  ) => McpRowDestination | undefined;
  readonly getRowSettings: (
    item: McpServersSectionItem,
  ) => McpRowDestination | undefined;
}

/**
 * The Home composer's MCP sign-in strip: the draft's servers that still need
 * sign-in, signed in right there. Account servers connect through the cloud
 * exactly as the MCP servers settings connect them, device servers through
 * local OAuth as the chat's MCP Servers card does. Rows come from the same
 * inventory that card reads, so servers a selected plugin brings are
 * included.
 */
export function useSelectedMcpSignIn({
  selections,
  reportUiState = false,
  ownerKey = 'default',
  getSelections,
  onSelectionsChange,
  canChangeRoute,
}: SelectedMcpSignInOptions): SelectedMcpSignInResult {
  const accountEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const latest = useRef({
    selections,
    ownerKey,
    getSelections,
    onSelectionsChange,
    canChangeRoute,
    accountEnabled,
  });
  latest.current = {
    selections,
    ownerKey,
    getSelections,
    onSelectionsChange,
    canChangeRoute,
    accountEnabled,
  };
  const [choice, setChoice] = useState<{
    key: string;
    owner: string;
    accountId: string | undefined;
  } | null>(null);
  const [accountRevision, setAccountRevision] = useState(0);
  const [retainedRouteKey, setRetainedRouteKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [accountAuthorizing, setAccountAuthorizing] = useState<
    ReadonlySet<string>
  >(new Set());
  const busy = useRef(false);
  const accountTarget = useRef<string | null>(null);
  const localAccount = useRef<string | undefined>(undefined);
  const live = useRef(true);
  const generation = useRef(0);
  const valid = useCallback(
    (owner: string, attempt: number): boolean =>
      live.current &&
      latest.current.ownerKey === owner &&
      generation.current === attempt,
    [],
  );
  useEffect(() => {
    live.current = true;
    return (): void => {
      live.current = false;
      generation.current += 1;
      connectionsRequest.current += 1;
    };
  }, []);
  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    accountTarget.current = null;
    setChoice(null);
    setRetainedRouteKey(null);
    setAccountAuthorizing(new Set());
    setActionError(null);
    connectionsRequest.current += 1;
    setConnections({ list: [], status: 'loading' });
  }, [ownerKey]);
  const detected = useDetectedMcpServers(
    selections !== null && selectsCapabilities(selections) ? selections : null,
    {
      ownerKey: `${ownerKey}/${accountRevision}`,
      onSelectionsChange: async (next): Promise<boolean> => {
        const writer = latest.current.onSelectionsChange;
        return writer ? await writer(next) : false;
      },
      isCurrent: async (): Promise<boolean> =>
        localAccount.current ===
        (await window.api?.loadCanopyCloudAccount?.())?.account?.id,
    },
  );
  const [connections, setConnections] = useState<AccountConnections>({
    list: [],
    status: 'loading',
  });
  const connectionsRequest = useRef(0);
  const loadConnections = useCallback(async (): Promise<void> => {
    if (!accountEnabled) return;
    const request = ++connectionsRequest.current;
    const owner = latest.current.ownerKey;
    setConnections((current) =>
      current.status === 'loading'
        ? current
        : { ...current, status: 'loading' },
    );
    try {
      const list = await window.mcpServers.listAccountConnections();
      if (
        live.current &&
        latest.current.ownerKey === owner &&
        request === connectionsRequest.current
      )
        setConnections({ list, status: 'loaded' });
    } catch {
      if (
        live.current &&
        latest.current.ownerKey === owner &&
        request === connectionsRequest.current
      )
        setConnections((current) => ({ ...current, status: 'failed' }));
    }
  }, [accountEnabled]);
  const refreshDetected = detected.refresh;
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([refreshDetected(), loadConnections()]);
  }, [loadConnections, refreshDetected]);
  const accountRowsKey = accountEnabled
    ? detected.servers
        .filter(isAccountServer)
        .map((server) => `${server.key}:${server.authStatus}`)
        .join('\n')
    : '';
  const signIn = useAccountMcpSignIn(refresh, {
    enabled: accountRowsKey !== '',
  });

  useEffect(() => {
    if (accountRowsKey !== '') void loadConnections();
    return (): void => {
      connectionsRequest.current += 1;
    };
  }, [accountRowsKey, loadConnections, ownerKey]);

  const signInRef = useRef(signIn);
  signInRef.current = signIn;
  useEffect(
    () => (): void => {
      signInRef.current.stopObserving();
    },
    [ownerKey],
  );

  useEffect(() => {
    if (!accountEnabled) signInRef.current.stopObserving();
  }, [accountEnabled]);

  useEffect(
    () =>
      window.mcpServers?.onAuthChanged?.((): void => {
        const owner = latest.current.ownerKey;
        const attempt = generation.current;
        void (async (): Promise<void> => {
          try {
            const currentAccount = (
              await window.api?.loadCanopyCloudAccount?.()
            )?.account?.id;
            if (!valid(owner, attempt)) return;
            const observing =
              busy.current ||
              accountTarget.current !== null ||
              choice !== null ||
              detected.connectingKey !== null ||
              signInRef.current.pending.size > 0 ||
              signInRef.current.setupOpen;
            if (observing && localAccount.current !== currentAccount) {
              generation.current += 1;
              busy.current = false;
              accountTarget.current = null;
              setChoice(null);
              setRetainedRouteKey(null);
              setAccountAuthorizing(new Set());
              setActionError(null);
              signInRef.current.stopObserving();
              connectionsRequest.current += 1;
              setConnections({ list: [], status: 'loading' });
              // A new inventory owner stops local observation without cancelling
              // the provider's flow or deleting already saved credentials.
              setAccountRevision((revision) => revision + 1);
            }
            await loadConnections();
          } catch {
            if (valid(owner, attempt))
              setConnections({ list: [], status: 'failed' });
          }
        })();
      }),
    [choice, detected.connectingKey, loadConnections, valid],
  );
  const { pending: signInPending, waitsForCatalog } = signIn;
  const pendingKeyForConnection = signIn.actions.pendingKeyForConnection;
  const rows = useMemo(
    () =>
      signInRows(detected.servers, connections, accountEnabled, {
        pending: signInPending,
        pendingKeyForConnection,
        waitsForCatalog,
        authorizing: accountAuthorizing,
      }),
    [
      accountEnabled,
      connections,
      detected.servers,
      signInPending,
      pendingKeyForConnection,
      waitsForCatalog,
      accountAuthorizing,
    ],
  );
  useEffect(() => {
    if (detected.loading || detected.error !== null) return;
    if (
      choice &&
      !detected.servers.some((server) => server.key === choice.key)
    ) {
      generation.current += 1;
      busy.current = false;
      setChoice(null);
    }
    const selectedKeys = new Set(
      rows
        .map((row) => row.accountKey)
        .filter((key): key is string => key !== undefined),
    );
    if (
      accountTarget.current !== null &&
      !detected.servers.some((server) => server.key === accountTarget.current)
    ) {
      accountTarget.current = null;
      signInRef.current.stopObserving();
    }
    if (
      signInRef.current.pending.size > 0 &&
      // Home permits one account flow at a time. Its initiating key or bound
      // connection alias must still select a row, not every alias separately.
      !Array.from(signInRef.current.pending).some((key) =>
        selectedKeys.has(key),
      )
    )
      signInRef.current.stopObserving();
  }, [detected.loading, detected.error, detected.servers, choice, rows]);

  const rowsByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows],
  );
  const pending = mcpServersNeedingSignIn(rows);

  useCurrentUiStateReporter(
    'home.mcpSignIn',
    reportUiState
      ? {
          visible: pending.length > 0,
          setupOpen: signIn.setupOpen || choice !== null,
          servers: pending.slice(0, 20).map((row) => ({
            name: row.displayName,
            status: signInStatus(row),
            pending:
              row.connecting === true || detected.connectingKey === row.key,
          })),
        }
      : null,
  );

  const currentSelections = (): ChatTabPluginSelections | null =>
    latest.current.getSelections
      ? latest.current.getSelections()
      : latest.current.selections;
  const accountId = async (): Promise<string | undefined> =>
    (await window.api?.loadCanopyCloudAccount?.())?.account?.id;
  const resolveInventory = async (): Promise<{
    selections: ChatTabPluginSelections;
    servers: DetectedMcpServerInfo[];
  }> => {
    const current = currentSelections();
    if (!current) throw new Error('This MCP server is no longer available');
    const result = await window.mcpServers.listDetected({
      selections: current,
    });
    return { selections: current, servers: result.servers };
  };
  const routeCandidate = async (
    key: string,
  ): Promise<{
    server: DetectedMcpServerInfo;
    next: ChatTabPluginSelections;
    previous: ChatTabPluginSelections;
  }> => {
    if (latest.current.canChangeRoute?.() === false)
      throw new Error(
        'Wait for this chat to finish before changing its MCP settings.',
      );
    const current = await resolveInventory();
    const server = current.servers.find((entry) => entry.key === key);
    const target = server && targetForDetectedServer(server);
    if (!server || !target || !isUnboundPlugin(server))
      throw new Error('This MCP server cannot sign in on this desktop.');
    const next = setMcpHttpAuthPreference(current.selections, target, 'canopy');
    const preview = await window.mcpServers.listDetected({ selections: next });
    if (!desktopRouteSupported(server, current.servers, preview.servers))
      throw new Error(
        'This MCP server’s selected provider variants cannot share desktop sign-in. Open MCP settings to review them.',
      );
    return { server, next, previous: current.selections };
  };
  const onConnect = (item: McpServersSectionItem): void => {
    if (
      busy.current ||
      detected.connectingKey !== null ||
      signIn.pending.size > 0 ||
      signIn.setupOpen
    )
      return;
    const row = rowsByKey.get(item.key);
    if (!row || row.waitsForConnection || row.connectDisabled) return;
    busy.current = true;
    const owner = latest.current.ownerKey;
    const attempt = ++generation.current;
    setActionError(null);
    void (async (): Promise<void> => {
      try {
        const identity = await accountId();
        localAccount.current = identity;
        const current = await resolveInventory();
        if (!valid(owner, attempt)) return;
        const server = current.servers.find((entry) => entry.key === item.key);
        if (!server) throw new Error('This MCP server is no longer available');
        if (isAccountServer(server)) {
          if (!latest.current.accountEnabled || connections.status !== 'loaded')
            throw new Error('Couldn’t load sign-in details');
          const authoritative =
            await window.mcpServers.listAccountConnections();
          if (identity !== (await accountId()) || !valid(owner, attempt))
            return;
          if (
            !pluginSelectionsEqual(
              currentSelections() ?? undefined,
              current.selections,
            )
          )
            throw new Error('The task’s plugins changed. Try again.');
          const connection = authoritative.find(
            (entry) => entry.id === server.accountConnectionId,
          );
          if (server.accountConnectionId && !connection)
            throw new Error('This MCP server is no longer available');
          if (connection || server.curatedKey) {
            accountTarget.current = item.key;
            const target: AccountMcpSignInTarget = {
              ...(connection
                ? { connection, configId: connection.configId }
                : server.configId
                  ? { configId: server.configId }
                  : {}),
              ...(server.curatedKey ? { curatedKey: server.curatedKey } : {}),
            };
            signIn.connect(target, {
              pendingKey: accountMcpSignInTargetKey(target),
              onAuthorizing: (): void => {
                if (valid(owner, attempt))
                  setAccountAuthorizing(new Set([server.key]));
              },
              onSettled: (): void => {
                if (valid(owner, attempt)) {
                  accountTarget.current = null;
                  setAccountAuthorizing(new Set());
                }
              },
            });
          } else {
            if (!latest.current.onSelectionsChange)
              throw new Error(
                'This task’s MCP routing cannot be changed here.',
              );
            await routeCandidate(item.key);
            if (identity === (await accountId()) && valid(owner, attempt))
              setChoice({ key: item.key, owner, accountId: identity });
          }
        } else {
          if (identity !== (await accountId()) || !valid(owner, attempt))
            return;
          if (!server.canConnect) {
            await detected.refresh();
            if (server.authStatus !== 'connected')
              throw new Error(
                'This MCP server cannot sign in on this desktop.',
              );
            return;
          }
          if (
            !pluginSelectionsEqual(
              currentSelections() ?? undefined,
              current.selections,
            )
          )
            throw new Error('The task’s plugins changed. Try again.');
          await detected.connect(server);
        }
      } catch (error: unknown) {
        if (valid(owner, attempt))
          setActionError(
            error instanceof Error
              ? error.message
              : 'Couldn’t load sign-in details',
          );
      } finally {
        if (valid(owner, attempt)) busy.current = false;
      }
    })();
  };
  const confirmDesktop = (): void => {
    if (!choice || busy.current) return;
    busy.current = true;
    const captured = choice;
    const attempt = ++generation.current;
    void (async (): Promise<void> => {
      let accepted = false;
      try {
        const candidate = await routeCandidate(captured.key);
        if (
          captured.accountId !== (await accountId()) ||
          !valid(captured.owner, attempt)
        )
          return;
        if (
          !pluginSelectionsEqual(
            currentSelections() ?? undefined,
            candidate.previous,
          )
        )
          throw new Error('The task’s plugins changed. Try again.');
        const writer = latest.current.onSelectionsChange;
        if (!writer || !(await writer(candidate.next)))
          throw new Error('Couldn’t save this task’s MCP settings. Try again.');
        accepted = true;
        if (valid(captured.owner, attempt)) setRetainedRouteKey(captured.key);
        if (
          captured.accountId !== (await accountId()) ||
          !valid(captured.owner, attempt)
        )
          return;
        if (
          !pluginSelectionsEqual(
            currentSelections() ?? undefined,
            candidate.next,
          )
        )
          throw new Error('The task’s plugins changed. Try again.');
        setChoice(null);
        localAccount.current = captured.accountId;
        await detected.connectOnDevice(
          captured.key,
          candidate.next,
          (): boolean =>
            valid(captured.owner, attempt) &&
            pluginSelectionsEqual(
              currentSelections() ?? undefined,
              candidate.next,
            ),
        );
      } catch (error: unknown) {
        if (valid(captured.owner, attempt))
          setActionError(
            `${error instanceof Error ? error.message : 'Couldn’t start sign-in.'}${accepted ? ' This task still uses desktop sign-in. Try again to keep using that route.' : ''}`,
          );
      } finally {
        if (valid(captured.owner, attempt)) busy.current = false;
      }
    })();
  };
  const navigation = (
    item: McpServersSectionItem,
    settings: boolean,
  ): McpRowDestination | undefined => {
    const server = detected.servers.find((entry) => entry.key === item.key);
    if (!server) return undefined;
    return {
      kind: 'button',
      onActivate: (): void => {
        const current = detected.servers.find(
          (entry) => entry.key === item.key,
        );
        const intent = current && selectedMcpNavigation(current, settings);
        if (intent) useNavigationStore.getState().openPluginsNavigation(intent);
        else setActionError('This MCP server is no longer available');
      },
    };
  };

  const renderRowExtra = (item: McpServersSectionItem): JSX.Element | null => {
    const row = rowsByKey.get(item.key);
    if (row?.unavailableReason)
      return (
        <p role="status" className="text-2xs fg-secondary">
          {row.unavailableReason}
        </p>
      );
    const accountKey = row?.accountKey;
    if (accountKey === undefined || !signIn.pending.has(accountKey))
      return null;
    return (
      <span
        className="flex items-center gap-2 text-2xs"
        data-testid="mcp-sign-in-strip-waiting"
      >
        <span
          role="status"
          className="fg-secondary"
          aria-label={
            row?.waitingForSignIn
              ? `Waiting for ${item.displayName} sign-in`
              : undefined
          }
        >
          {row?.waitingForSignIn
            ? MCP_SIGN_IN_WAITING_LABEL
            : 'Opening sign-in…'}
        </span>
        <Button
          variant="link"
          onClick={(): void =>
            signIn.cancel(
              accountKey,
              row?.target?.connection?.id ?? row?.server.accountConnectionId,
            )
          }
        >
          Cancel
        </Button>
      </span>
    );
  };

  const error =
    actionError ??
    signIn.error ??
    (detected.error && retainedRouteKey
      ? `${detected.error} This task still uses desktop sign-in. Try again to keep using that route.`
      : detected.error);
  const errorCode = signIn.error === null ? null : signIn.errorCode;
  const catalogBlocksConnect =
    signIn.catalogFailed && pending.some((row) => row.waitsForCatalog === true);
  const connectionsBlockConnect =
    connections.status === 'failed' &&
    rows.some((row) => isAccountServer(row.server));
  const retryLoad = (): void => {
    if (catalogBlocksConnect) signIn.retryCatalog();
    if (connectionsBlockConnect) void loadConnections();
  };
  const decorated = detected.servers.map((server) => {
    const row = rowsByKey.get(server.key);
    return {
      ...server,
      ...(row
        ? {
            authStatus: row.authStatus,
            authStatusLabel: row.authStatusLabel,
            connectActionLabel: row.connectActionLabel,
            canRefresh: row.canRefresh,
            canConnect: row.canConnect,
            connectDisabled: row.connectDisabled,
            connecting: row.connecting,
          }
        : {}),
      canCancelSignIn: detected.connectingKey === server.key,
      waitingForSignIn:
        row?.waitingForSignIn === true ||
        (detected.connectingKey === server.key &&
          detected.awaitingAuthorization),
      ...(detected.connectingKey === server.key && detected.signInUrl
        ? { signInUrl: detected.signInUrl }
        : {}),
    };
  });
  return {
    ...detected,
    cancelConnect: (): void => {
      generation.current += 1;
      busy.current = false;
      detected.cancelConnect();
      if (retainedRouteKey)
        setActionError(
          'Sign-in cancelled. This task still uses desktop sign-in. Try again to keep using that route.',
        );
    },
    servers: decorated,
    rows: rows.map((row) => ({
      ...row,
      canCancelSignIn: detected.connectingKey === row.key,
      waitingForSignIn:
        row.waitingForSignIn === true ||
        (detected.connectingKey === row.key && detected.awaitingAuthorization),
      ...(detected.connectingKey === row.key && detected.signInUrl
        ? { signInUrl: detected.signInUrl }
        : {}),
    })),
    onConnect,
    renderRowExtra,
    dialogs: (
      <>
        {signIn.dialogs}
        {choice && choice.owner === ownerKey && (
          <DialogModal
            inset="flush"
            title="Sign in on this desktop?"
            onClose={(): void => {
              generation.current += 1;
              busy.current = false;
              setChoice(null);
            }}
          >
            <Stack gap="group">
              <Stack gap="inline">
                <p className="text-s fg-secondary">
                  You’ll sign in to{' '}
                  {rowsByKey.get(choice.key)?.displayName ?? 'this service'} in
                  your browser. This task uses that sign-in on this desktop; web
                  chats aren’t affected.
                </p>
                <ErrorBanner
                  errorSource="use-selected-mcp-sign-in-action"
                  error={actionError}
                  className=""
                />
              </Stack>
              <div className="flex justify-end gap-2">
                <>
                  <Button
                    variant="ghost"
                    onClick={(): void => {
                      generation.current += 1;
                      busy.current = false;
                      setChoice(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button onClick={confirmDesktop}>Sign in</Button>
                </>
              </div>
            </Stack>
          </DialogModal>
        )}
      </>
    ),
    getRowNavigation: (
      item: McpServersSectionItem,
    ): McpRowDestination | undefined => navigation(item, false),
    getRowSettings: (
      item: McpServersSectionItem,
    ): McpRowDestination | undefined => navigation(item, true),
    notice:
      catalogBlocksConnect || connectionsBlockConnect ? (
        <Notice
          errorSource="mcp-sign-in-strip-load-error"
          intent="destructive"
          role="status"
          className=""
          data-testid="mcp-sign-in-strip-load-error"
          actions={
            <NoticeButton
              variant="primary"
              data-testid="mcp-sign-in-strip-load-retry"
              onClick={retryLoad}
            >
              Try again
            </NoticeButton>
          }
        >
          Couldn’t load sign-in details.
        </Notice>
      ) : error === null ? undefined : (
        <div
          title={mcpConnectErrorCodeTitle(errorCode)}
          data-mcp-error-code={errorCode ?? undefined}
          data-testid="mcp-sign-in-strip-error"
        >
          <ErrorBanner
            errorSource="use-selected-mcp-sign-in"
            error={error}
            className=""
            retryLabel="Try again"
            onRetry={
              detected.error !== null ||
              actionError === 'This MCP server is no longer available'
                ? (): void => {
                    setActionError(null);
                    void refresh();
                  }
                : undefined
            }
          />
        </div>
      ),
  };
}
