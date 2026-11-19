import {
  ACCOUNT_MCP_CLIENT_CREDENTIALS_REQUIRED,
  ACCOUNT_MCP_ENDPOINT_REQUIRED,
  ACCOUNT_MCP_SIGN_IN_UNAVAILABLE,
  type AccountMcpClientSetup,
  type AccountMcpOAuthClientCredentials,
} from '@canopy/protocol/mcp-servers';
import { customAccountMcpPromotable } from '@canopy/ui-app/capability';
import {
  mcpConnectErrorMessage,
  mcpSignInUnavailableMessage,
} from '@canopy/ui-shared/lib';
import { useRef, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  AccountMcpConnectionError,
  type AccountMcpConnectionErrorCode,
  type AccountMcpConnectionErrorDetails,
} from '@canopy/execution-engine/types/mcp-servers';
import type {
  AccountMcpConnectionSummary,
  AccountMcpSecretSource,
  McpServerIndexEntry,
  StartAccountMcpConnectionRequest,
} from '@canopy/execution-engine/types/mcp-servers';
import type { SecretValueInput } from '@canopy/execution-engine/types/stored-secrets';

interface PendingConnection {
  /** Settles after cancellation rollback and owned-key release. */
  readonly done: Promise<void>;
  readonly serverKey: string | undefined;
  readonly configId: string;
  id?: string;
  /** Requested credential to revoke if start fails before binding an ID. */
  cancelledConnectionId?: string;
  cancelled: boolean;
  observing: boolean;
  /** See {@link AccountMcpConnectOptions.discardOnAbandon}. */
  readonly discard: boolean;
  /** Shared cleanup barrier for both cancellation paths. */
  releasePromise?: Promise<void>;
}
export type AccountMcpErrorOperation = 'connect' | 'disconnect' | 'promote';
export interface AccountMcpConnectOptions {
  /** The action whose failure this sign-in should explain. */
  errorOperation?: 'connect' | 'promote';
  /** Text, or a device server's saved token named by `secretSource`. */
  bearerToken?: SecretValueInput;
  endpointUrl?: string;
  oauthClient?: AccountMcpOAuthClientCredentials;
  /** Account the credentials were captured under; see useAccountMcpSignIn. */
  expectedAccountId?: string;
  /** Creates a custom connection for this HTTPS URL instead of a server key. */
  customUrl?: string;
  displayName?: string;
  /** The name of an account the person adds beside another (CAN-6226). */
  label?: string;
  /**
   * The connection is new to this sign-in (an added account): when the
   * sign-in is cancelled or fails, it is removed from the account instead of
   * kept disconnected, so no copy of it is left in the list.
   */
  discardOnAbandon?: boolean;
  /** Extra upstream headers stored with a new custom connection. */
  headers?: Record<string, SecretValueInput>;
  /** The device server whose saved secrets the request keeps. */
  secretSource?: AccountMcpSecretSource;
  /** Target key; defaults to the server or custom URL plus configuration. */
  pendingKey?: string;
  /** Receives the message for a recognized failure the caller shows itself. */
  onFailure?: (message: string) => void;
  /**
   * The server registers no OAuth clients itself: the caller collects the
   * user's own app and retries. `clientSetup` is absent from older clouds.
   * Without this callback the refusal is reported like any other failure.
   */
  onOAuthClientRequired?: (clientSetup?: AccountMcpClientSetup) => void;
  /**
   * The server has several endpoints and the start named none the cloud
   * could keep (`endpoint_required`): the caller asks which one and retries.
   * Without this callback the refusal is reported like any other failure.
   */
  onEndpointRequired?: () => void;
  /**
   * Runs once the connection exists, before any browser sign-in settles. If it
   * throws, the new connection is disconnected before the failure surfaces.
   */
  onStarted?: (connection: AccountMcpConnectionSummary) => Promise<void>;
  /**
   * Undoes `onStarted` when the flow is cancelled after it resolved. Runs
   * before the connection is disconnected; its failures are swallowed.
   */
  onCancelled?: (connection: AccountMcpConnectionSummary) => Promise<void>;
  /** Runs once the connection reports connected, after any browser sign-in. */
  onConnected?: (connection: AccountMcpConnectionSummary) => Promise<void>;
  /**
   * Answers a browser sign-in with its one-shot page instead of opening the
   * default browser. Only a local window may ask; see `startAccountConnection`.
   */
  browser?: 'embedded';
  /**
   * Runs once a browser sign-in is waiting, with the embedded page when
   * {@link browser} asked for one. Never persist or log that URL.
   */
  onAuthorizing?: (embeddedUrl: string | undefined) => void;
  /**
   * Runs exactly once with how this call ended. `recovering` hands the flow
   * to {@link onOAuthClientRequired} or {@link onEndpointRequired}.
   */
  onOutcome?: (outcome: AccountMcpConnectOutcome) => void;
}
export type AccountMcpConnectOutcome =
  | { kind: 'connected'; connection: AccountMcpConnectionSummary }
  | { kind: 'cancelled' }
  | { kind: 'recovering' }
  | { kind: 'failed'; message: string | null };
export interface AccountMcpActions {
  /** Stops UI observation without disconnecting or removing credentials. */
  stopObserving: () => void;
  pending: ReadonlySet<string>;
  pendingCount: number;
  /** Initiating key of this connection's flow, including before ID binding. */
  pendingKeyForConnection: (
    connection: Pick<
      AccountMcpConnectionSummary,
      'id' | 'serverKey' | 'configId'
    >,
  ) => string | undefined;
  /** Matches the bound id, or its server/configuration while start is pending. */
  isConnectingConnection: (
    connection: Pick<
      AccountMcpConnectionSummary,
      'id' | 'serverKey' | 'configId'
    >,
  ) => boolean;
  error: string | null;
  /** Initiating target key for Connect, or canonical connection key. */
  errorKey: string | null;
  errorFor: (targetKey: string) => string | null;
  errorOperation: AccountMcpErrorOperation | null;
  /** The cloud's code behind {@link error}, kept out of the sentence. */
  errorCode: string | null;
  clearError: () => void;
  connect: (
    serverKey?: string,
    configId?: string,
    options?: AccountMcpConnectOptions,
  ) => Promise<AccountMcpConnectionErrorCode | undefined>;
  cancel: (targetKey: string, knownConnectionId?: string) => Promise<void>;
  disconnect: (
    id: string,
    onFailure?: (message: string) => void,
  ) => Promise<void>;
}

export function accountMcpConnectionKey(
  connection: Pick<AccountMcpConnectionSummary, 'id'>,
): string {
  return `connection:${connection.id}`;
}

export function accountMcpConfigurationKey(
  serverKey: string,
  configId = 'default',
): string {
  return `configuration:${JSON.stringify([serverKey, configId])}`;
}

export function accountMcpRowKey(row: McpServerIndexEntry): string | undefined {
  return row.accountConnection
    ? accountMcpConnectionKey(row.accountConnection)
    : row.curatedKey || customAccountMcpPromotable(row)
      ? row.id
      : undefined;
}

/**
 * A missing OAuth client or endpoint is recoverable: a caller that collects
 * it retries, so the refusal is handed to it rather than shown as a failure.
 * Without such a caller it is a failure like any other.
 */
function startRecovery(
  code: AccountMcpConnectionErrorCode | undefined,
  details: AccountMcpConnectionErrorDetails,
  options: AccountMcpConnectOptions,
): (() => void) | undefined {
  const { onOAuthClientRequired, onEndpointRequired } = options;
  if (code === 'oauth-client-required' && onOAuthClientRequired)
    return (): void => onOAuthClientRequired(details.clientSetup);
  if (
    code === 'connect-refused' &&
    details.serverCode === ACCOUNT_MCP_ENDPOINT_REQUIRED &&
    onEndpointRequired
  )
    return onEndpointRequired;
  return undefined;
}

export function useAccountMcpActions(
  refresh: () => Promise<void>,
): AccountMcpActions {
  const flows = useRef(new Map<string, PendingConnection>());
  const observationRevision = useRef(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<{
    message: string;
    code: string | null;
    key: string | null;
    connectionKey: string | null;
    operation: AccountMcpErrorOperation;
  } | null>(null);
  const setError = (
    message: string | null,
    code: string | null = null,
    key: string | null = null,
    operation: AccountMcpErrorOperation = 'connect',
    connectionKey: string | null = null,
  ): void =>
    setFailure(
      message === null
        ? null
        : { message, code, key, connectionKey, operation },
    );
  const updatePending = (): void => setPending(new Set(flows.current.keys()));
  const disconnect = async (
    id: string,
    onFailure?: (message: string) => void,
  ): Promise<void> => {
    const revision = observationRevision.current;
    setError(null);
    try {
      await window.mcpServers.disconnectAccountConnection(id);
      if (revision !== observationRevision.current) return;
      await refresh();
    } catch {
      if (revision === observationRevision.current) {
        const message = 'Could not disconnect. Try again.';
        setError(message, null, accountMcpConnectionKey({ id }), 'disconnect');
        onFailure?.(message);
      }
    }
  };
  const revoke = (flow: PendingConnection, id: string): Promise<void> =>
    flow.cancelled
      ? (async (): Promise<void> => {
          let failed = false;
          await disconnect(id, (): void => {
            failed = true;
          });
          if (failed) flow.releasePromise = undefined;
        })()
      : window.mcpServers.disconnectAccountConnection(id).catch((): void => {
          // A caller's own failure is what the abandoned start reports.
        });
  // An added account whose sign-in ended without connecting leaves no row
  // behind. A start that failed before naming its row (a browser that would
  // not open) finds it by its new configuration. A failed sign-in asks the
  // cloud to keep a row that connected meanwhile (a poll that failed after
  // the sign-in finished), which the cloud checks in the delete itself; a
  // cancelled one is removed, or at least signed out when the cloud can't.
  const discard = async (
    flow: PendingConnection,
    knownId: string | undefined,
  ): Promise<void> => {
    let id = knownId;
    if (id === undefined) {
      try {
        id = (await window.mcpServers.listAccountConnections()).find(
          (candidate): boolean =>
            candidate.serverKey === flow.serverKey &&
            candidate.configId === flow.configId,
        )?.id;
      } catch (error) {
        reportClientAppError(error);
      }
      if (id === undefined) return;
    }
    try {
      await window.mcpServers.removeAccountConnection(
        id,
        flow.cancelled ? undefined : { unlessConnected: true },
      );
    } catch (error) {
      reportClientAppError(error);
      if (flow.cancelled) await revoke(flow, id);
    }
  };
  // Share an in-flight/successful revocation; a failure must allow Retry.
  const release = async (flow: PendingConnection): Promise<void> => {
    const id = flow.id ?? flow.cancelledConnectionId;
    if (flow.discard) flow.releasePromise ??= discard(flow, id);
    else if (id) flow.releasePromise ??= revoke(flow, id);
    await flow.releasePromise;
  };
  const connect = async (
    serverKey?: string,
    configId = 'default',
    options: AccountMcpConnectOptions = {},
  ): Promise<AccountMcpConnectionErrorCode | undefined> => {
    const revision = observationRevision.current;
    const target = serverKey ?? options.customUrl;
    const key =
      options.pendingKey ??
      (target ? accountMcpConfigurationKey(target, configId) : undefined);
    let outcome: AccountMcpConnectOutcome | null = null;

    const report = (next: AccountMcpConnectOutcome): void => {
      if (outcome || flow.observing === false) return;
      outcome = next;
      options.onOutcome?.(next);
    };
    // Retry may be activated before the old polling call has observed Cancel.
    // Finish its disconnect before another start can own the same connection.
    const existing = (): PendingConnection | undefined =>
      (key ? flows.current.get(key) : undefined) ??
      (serverKey
        ? Array.from(flows.current.values()).find(
            (candidate): boolean =>
              candidate.serverKey === serverKey &&
              candidate.configId === configId,
          )
        : undefined);
    const previous = existing();
    if (previous?.cancelled) await previous.done;
    if (revision !== observationRevision.current) return undefined;
    if (!key || (!serverKey && !options.customUrl) || existing()) {
      options.onOutcome?.({ kind: 'failed', message: null });
      return undefined;
    }
    let finish: () => void = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const flow: PendingConnection = {
      cancelled: false,
      observing: true,
      done,
      serverKey,
      configId: configId ?? 'default',
      discard: options.discardOnAbandon === true,
    };
    // Every key this flow is registered under; a row can change key mid-flow.
    const keys = [key];
    flows.current.set(key, flow);
    updatePending();
    setError(null);
    let started: AccountMcpConnectionSummary | undefined;
    // A cancelled flow unbinds whatever onStarted bound before the connection
    // goes, so nothing is left routed to a disconnected connection.
    const rollBack = async (): Promise<undefined> => {
      if (started) {
        try {
          await options.onCancelled?.(started);
        } catch {
          // The connection still goes; the row keeps what it could.
        }
      }
      await release(flow);
      return undefined;
    };
    try {
      // Bind any credential in this request to the account it was captured
      // under (the dialog's account when one was open, else the account the
      // panel shows). A sign-in change in between is refused here, before any
      // secret leaves the renderer; main repeats the check as defense in depth.
      const currentAccountId = (await window.api?.loadCanopyCloudAccount?.())
        ?.account?.id;
      if (
        options.expectedAccountId !== undefined &&
        options.expectedAccountId !== currentAccountId
      )
        throw new AccountMcpConnectionError('account-changed');
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      const expectedAccountId = options.expectedAccountId ?? currentAccountId;
      const credentials = {
        configId,
        ...(options.label ? { label: options.label } : {}),
        ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
        ...(options.secretSource ? { secretSource: options.secretSource } : {}),
        ...(options.oauthClient ? { oauthClient: options.oauthClient } : {}),
        ...(expectedAccountId ? { expectedAccountId } : {}),
        ...(options.browser ? { browser: options.browser } : {}),
      };
      const customUrl = serverKey ? undefined : options.customUrl;
      // A browser sign-in answers with only its URL, and a new custom
      // connection's key is minted by the cloud, so the new row is found by
      // diffing the account's connections around the start.
      const knownIds = customUrl
        ? new Set(
            (await window.mcpServers.listAccountConnections()).map(
              (connection): string => connection.id,
            ),
          )
        : undefined;
      const request: StartAccountMcpConnectionRequest = serverKey
        ? {
            serverKey,
            ...(options.endpointUrl
              ? { endpointUrl: options.endpointUrl }
              : {}),
            ...credentials,
          }
        : {
            customUrl: customUrl ?? '',
            ...(options.displayName
              ? { displayName: options.displayName }
              : {}),
            ...(options.headers && Object.keys(options.headers).length > 0
              ? { headers: options.headers }
              : {}),
            ...credentials,
          };
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      const result = await window.mcpServers.startAccountConnection(request);
      if (!flow.observing) return undefined;
      if ('error' in result)
        throw new AccountMcpConnectionError(
          result.error.code,
          result.error.header,
          {
            ...(result.error.clientSetup
              ? { clientSetup: result.error.clientSetup }
              : {}),
            ...(result.error.serverCode
              ? { serverCode: result.error.serverCode }
              : {}),
            ...(result.error.desktopSignIn !== undefined
              ? { desktopSignIn: result.error.desktopSignIn }
              : {}),
          },
        );
      let connection: AccountMcpConnectionSummary | undefined;
      if ('connection' in result) connection = result.connection;
      else if (knownIds) {
        const created = (
          await window.mcpServers.listAccountConnections()
        ).filter(
          (candidate): boolean =>
            candidate.kind === 'CUSTOM' && !knownIds.has(candidate.id),
        );
        connection =
          created.find(
            (candidate): boolean =>
              candidate.displayName === options.displayName,
          ) ?? (created.length === 1 ? created[0] : undefined);
      } else {
        const index = await window.mcpServers.loadIndex();
        connection = index.servers.find(
          (row): boolean =>
            row.accountConnection?.serverKey === serverKey &&
            row.accountConnection?.configId === configId,
        )?.accountConnection;
      }
      if (!flow.observing) return undefined;
      if (!connection) throw new Error('Pending connection unavailable.');
      if ('authorizationUrl' in result && !flow.cancelled)
        options.onAuthorizing?.(result.embeddedUrl);
      flow.id = connection.id;
      // Keep the initiating surface and the bound connection as aliases of
      // this one flow, never of every configuration belonging to the server.
      const connectionKey = accountMcpConnectionKey(connection);
      if (!flows.current.has(connectionKey)) {
        flows.current.set(connectionKey, flow);
        keys.push(connectionKey);
        updatePending();
      }
      // Cancelled before the connection was known: bind nothing to it.
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      try {
        await options.onStarted?.(connection);
      } catch (startedError) {
        // Nothing is bound to the new connection; drop it so a retry does not
        // leave another one behind. The caller's failure is what is reported.
        await release(flow);
        throw startedError;
      }
      started = connection;
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      await refresh();
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      const settled =
        connection.status === 'PENDING'
          ? await window.mcpServers.awaitAccountConnection(connection.id)
          : connection;
      if (!flow.observing) return undefined;
      if (flow.cancelled) return await rollBack();
      if ('error' in settled)
        throw new AccountMcpConnectionError(
          settled.error.code,
          settled.error.header,
          settled.error.serverCode
            ? { serverCode: settled.error.serverCode }
            : {},
        );
      if (settled.status !== 'CONNECTED') {
        if (flow.discard) await release(flow);
        setError(
          'Connection needs attention. Connect again.',
          null,
          key,
          options.errorOperation,
          accountMcpConnectionKey(connection),
        );
        report({
          kind: 'failed',
          message: 'Connection needs attention. Connect again.',
        });
        return undefined;
      }
      await options.onConnected?.(settled);
      report({ kind: 'connected', connection: settled });
      return undefined;
    } catch (error) {
      if (!flow.observing) return undefined;
      if (flow.cancelled) await rollBack();
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      const header =
        error instanceof AccountMcpConnectionError ? error.header : undefined;
      const details =
        error instanceof AccountMcpConnectionError ? error.details : {};
      const known: AccountMcpConnectionErrorCode | undefined =
        code === 'connection-timeout' ||
        code === 'account-changed' ||
        code === 'oauth-client-required' ||
        code === 'connection-limit-reached' ||
        code === 'invalid-headers' ||
        code === 'connect-refused'
          ? code
          : undefined;
      const recover = startRecovery(known, details, options);
      if (recover) {
        if (flow.cancelled) report({ kind: 'cancelled' });
        else {
          report({ kind: 'recovering' });
          recover();
        }
        return known;
      }
      const serverCode =
        known === 'oauth-client-required'
          ? ACCOUNT_MCP_CLIENT_CREDENTIALS_REQUIRED
          : details.serverCode;
      // The account can't sign in to this server; it never asks for an
      // OAuth app, and says when adding it to this device signs in instead.
      const message =
        known === 'connect-refused' &&
        serverCode === ACCOUNT_MCP_SIGN_IN_UNAVAILABLE
          ? mcpSignInUnavailableMessage(
              details.desktopSignIn === true,
              'desktop',
            )
          : known === 'connect-refused' || known === 'oauth-client-required'
            ? mcpConnectErrorMessage(serverCode)
            : known
              ? new AccountMcpConnectionError(known, header).message
              : 'Could not connect. Try again.';
      if (known) options.onFailure?.(message);
      // A failed added account goes with its sign-in, unless the app signed
      // in to another account meanwhile: the connection isn't that one's.
      if (flow.discard && !flow.cancelled && known !== 'account-changed')
        await release(flow);
      if (!flow.cancelled)
        setError(
          message,
          serverCode ?? null,
          key,
          options.errorOperation,
          flow.id ? accountMcpConnectionKey({ id: flow.id }) : null,
        );
      report(
        flow.cancelled ? { kind: 'cancelled' } : { kind: 'failed', message },
      );
      return known;
    } finally {
      // Every early return above that ends a cancelled flow lands here.
      report(
        flow.cancelled
          ? { kind: 'cancelled' }
          : { kind: 'failed', message: null },
      );
      // Keep Retry behind the actual disconnect, including when polling
      // settles independently while cancellation is still in flight.
      await flow.releasePromise;
      for (const registered of keys)
        if (flows.current.get(registered) === flow)
          flows.current.delete(registered);
      if (flow.observing) updatePending();
      finish();
      if (flow.observing) await refresh();
    }
  };
  const cancel = async (
    targetKey: string,
    knownConnectionId?: string,
  ): Promise<void> => {
    const flow = flows.current.get(targetKey);
    if (!flow) return;
    flow.cancelled = true;
    flow.cancelledConnectionId ??= knownConnectionId;
    if (!flow.id) return;
    await release(flow);
  };
  const stopObserving = (): void => {
    observationRevision.current += 1;
    flows.current.forEach((flow): void => {
      flow.observing = false;
    });
    flows.current.clear();
    updatePending();
    setError(null);
  };
  const pendingKeyForConnection: AccountMcpActions['pendingKeyForConnection'] =
    (connection) =>
      Array.from(flows.current).find(([, flow]): boolean =>
        flow.id !== undefined
          ? flow.id === connection.id
          : flow.serverKey === connection.serverKey &&
            flow.configId === connection.configId,
      )?.[0];
  return {
    stopObserving,
    pending,
    pendingCount: new Set(flows.current.values()).size,
    pendingKeyForConnection,
    isConnectingConnection: (connection): boolean =>
      pendingKeyForConnection(connection) !== undefined,
    error: failure?.message ?? null,
    errorKey: failure?.key ?? null,
    errorFor: (targetKey): string | null =>
      failure?.key === targetKey || failure?.connectionKey === targetKey
        ? failure.message
        : null,
    errorOperation: failure?.operation ?? null,
    errorCode: failure?.code ?? null,
    clearError: (): void => setError(null),
    connect,
    cancel,
    disconnect,
  };
}
