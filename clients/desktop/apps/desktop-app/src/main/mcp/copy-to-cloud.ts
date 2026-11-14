import type {
  McpAccountConnectParams,
  McpAccountConnectResult,
} from '@canopy/protocol/canopy-core';
import {
  parseMcpExtraHeaders,
  type AccountMcpConnection,
} from '@canopy/protocol/mcp-servers';
import {
  AccountMcpConnectionError,
  type McpServerData,
  type StartAccountMcpConnectionRequest,
  type StartAccountMcpConnectionResponse,
} from '@canopy/execution-engine/types/mcp-servers';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  SecretsLeaveApproval,
  SecretsLeaveRequest,
} from './confirm-secrets-leave';
import { mcpServerStoredSecretSlots } from './server-secret-view';

/**
 * `core.integration.mcpAccount.connect` on the desktop core (CAN-6176 PR 4a,
 * D15 to D17): starts or reconnects an MCP account connection on Canopy Cloud
 * through the existing cloud start. With `fromDeviceServer`, the server this
 * desktop already has is copied: main resolves the slots the person agreed to
 * copy from the server's own stored secrets, and sends them only to that
 * server's own URL origin. The renderer names slots; it never holds values.
 *
 * What leaves this computer, and only on this call: the URL, display name and
 * config id; and for a copy, the consented headers and bearer token, to the
 * signed-in account's Canopy Cloud (`POST /api/v1/mcp-connections`), which
 * stores them encrypted for that account's own proxy. OAuth tokens, an OAuth
 * client secret and a command server's environment never do (D16, 3.7).
 *
 * Before any secret leaves, main asks the person itself with a native dialog
 * that names each secret, the destination origin and the cloud account
 * (`confirmSecretsLeave`). The renderer's consent screen comes first, but
 * only this answer lets a secret go, so a renderer can't consent for them,
 * and only to the account the dialog named: the start refuses to send under
 * any other.
 */

export interface CopyToCloudDeps {
  readonly accountEnabled: () => boolean;
  /** The device server as stored, values included; null when it is gone. */
  readonly readServer: (serverId: string) => Promise<McpServerData | null>;
  readonly start: (
    request: StartAccountMcpConnectionRequest,
  ) => Promise<StartAccountMcpConnectionResponse>;
  /**
   * A curated server as main's own catalog lists it: its name, its fixed
   * endpoint and the endpoints a person may choose. Null when the catalog
   * doesn't list it.
   */
  readonly curatedServer: (serverKey: string) => Promise<{
    name: string;
    url: string;
    urlOptions: readonly string[];
    /** The token endpoint the catalog pins for a supplied client secret. */
    tokenUrl?: string;
  } | null>;
  /**
   * Main's own native confirmation: the account, origin and secrets the
   * person agreed to, or null, and then nothing is sent.
   */
  readonly confirmSecretsLeave: (
    request: SecretsLeaveRequest,
  ) => Promise<SecretsLeaveApproval | null>;
}

const CODES = {
  invalidUrl: 'core.integration.mcpAccount.invalidUrl',
  invalidHeaders: 'core.integration.mcpAccount.invalidHeaders',
  oauthClientRequired: 'core.integration.mcpAccount.oauthClientRequired',
  connectRefused: 'core.integration.mcpAccount.connectRefused',
  connectionLimitReached: 'core.integration.mcpAccount.connectionLimitReached',
  busy: 'core.integration.mcpAccount.busy',
  accountDisabled: 'core.integration.mcpAccount.accountDisabled',
  accountChanged: 'core.integration.mcpAccount.accountChanged',
  secretSlotRefused: 'core.integration.mcpAccount.secretSlotRefused',
  consentDeclined: 'core.integration.mcpAccount.consentDeclined',
} as const;

function refused(
  kind: 'invalid_argument' | 'failed_precondition' | 'conflict',
  code: (typeof CODES)[keyof typeof CODES],
  message: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    code,
    message,
    retry:
      kind === 'conflict'
        ? { kind: 'after_refresh', resource: 'core.integration.mcpAccount' }
        : { kind: 'never' },
  });
}

function origin(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Whether two URLs are the same once parsed; null when either isn't one. */
function sameUrl(
  left: string | undefined,
  right: string | undefined,
): boolean | null {
  if (left === undefined || right === undefined) return null;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return null;
  }
}

/** The consented slots' values, as the cloud start takes them. */
async function resolveCopy(
  deps: CopyToCloudDeps,
  params: McpAccountConnectParams,
): Promise<{ headers?: Record<string, string>; bearerToken?: string }> {
  const copy = params.fromDeviceServer;
  if (copy === undefined) return {};
  // The secrets are the connection's own config's, never another's.
  if (copy.configId !== params.configId)
    throw refused(
      'invalid_argument',
      CODES.secretSlotRefused,
      'Copy secrets only from the configuration being connected.',
    );
  const server = await deps.readServer(copy.serverId);
  const config = server?.configs.find((item) => item.id === copy.configId);
  if (server === null || config === undefined)
    throw refused(
      'failed_precondition',
      CODES.secretSlotRefused,
      'This server or its configuration is no longer on this computer.',
    );
  const { definition } = server;
  // D15: a secret goes only to the URL it was saved for, path included.
  if (
    definition.type !== 'http' ||
    sameUrl(definition.url, params.customUrl) !== true
  )
    throw refused(
      'failed_precondition',
      CODES.secretSlotRefused,
      'This server no longer connects where its saved secrets were saved for. Check its URL.',
    );
  const stored = new Map(
    mcpServerStoredSecretSlots(server).map((slot) => [slot.slot, slot.value]),
  );
  const headers: Record<string, string> = {};
  let bearerToken: string | undefined;
  // The configuration's header wins over the definition's of the same name,
  // as the server's own requests send it, whatever order the slots came in.
  const ordered = [...new Set(copy.secretSlots)].sort(
    (left, right) =>
      Number(left.startsWith('config/')) - Number(right.startsWith('config/')),
  );
  for (const slot of ordered) {
    const value = stored.get(slot);
    const configSlot = `config/${copy.configId}/`;
    const header = slot.startsWith('definition/headers/')
      ? slot.slice('definition/headers/'.length)
      : slot.startsWith(`${configSlot}extraHeaders/`)
        ? slot.slice(`${configSlot}extraHeaders/`.length)
        : null;
    if (
      value === undefined ||
      (header === null && slot !== `${configSlot}authToken`)
    )
      throw refused(
        'failed_precondition',
        CODES.secretSlotRefused,
        'A saved secret changed or was removed. Reload and choose again.',
      );
    if (header === null) bearerToken = value;
    else {
      for (const name of Object.keys(headers))
        if (name.toLowerCase() === header.toLowerCase()) delete headers[name];
      headers[header] = value;
    }
  }
  if (Object.keys(headers).length === 0)
    return bearerToken === undefined ? {} : { bearerToken };
  if (parseMcpExtraHeaders(headers) === null)
    throw refused(
      'invalid_argument',
      CODES.invalidHeaders,
      "This server's saved headers can't be copied to your cloud account.",
    );
  return { headers, ...(bearerToken === undefined ? {} : { bearerToken }) };
}

const STATES = {
  PENDING: 'pending',
  CONNECTED: 'connected',
  REAUTH_REQUIRED: 'reauthRequired',
  DISCONNECTED: 'disconnected',
} as const;

function summary(connection: AccountMcpConnection): McpAccountConnectResult {
  return {
    connection: {
      connectionId: connection.id,
      serverKey: connection.serverKey,
      state: STATES[connection.status],
      ...(connection.hasExtraHeaders === undefined
        ? {}
        : { hasStoredHeaders: connection.hasExtraHeaders }),
    },
  };
}

/** The account start's typed failures as operation errors; never a value. */
function mapped(error: AccountMcpConnectionError): CanopyOperationError {
  switch (error.code) {
    case 'account-changed':
      return refused('conflict', CODES.accountChanged, error.message);
    case 'oauth-client-required':
      return refused(
        'failed_precondition',
        CODES.oauthClientRequired,
        error.message,
      );
    case 'connection-limit-reached':
      return new CanopyOperationError({
        kind: 'resource_exhausted',
        code: CODES.connectionLimitReached,
        message: error.message,
        retry: {
          kind: 'after_refresh',
          resource: 'core.integration.mcpAccount',
        },
      });
    case 'invalid-headers':
      return refused('invalid_argument', CODES.invalidHeaders, error.message);
    case 'invalid-url':
      return refused('invalid_argument', CODES.invalidUrl, error.message);
    case 'connect-refused':
      return error.details.serverCode === 'connection_busy'
        ? refused('conflict', CODES.busy, error.message)
        : refused('failed_precondition', CODES.connectRefused, error.message);
    default:
      return new CanopyOperationError({
        kind: 'unavailable',
        message: error.message,
        retry: { kind: 'never' },
      });
  }
}

/**
 * Where a secret-bearing connect sends its secrets, and the server's name, as
 * main's own records give them: a custom server's URL, or the endpoint the
 * cloud will use for a curated server. That is the chosen one (an option its
 * catalog lists), else its only option, else, with no options, its fixed URL.
 * The cloud never falls back to the fixed URL for a server with options, and
 * with several and none chosen it may keep one an earlier connection used, so
 * main can't name it then. The endpoint named is always sent as
 * `endpointUrl`: the cloud accepts only that exact URL, so a catalog that
 * changed since main read it refuses the start instead of storing the secret
 * elsewhere. Null when main can't name it.
 */
async function secretDestination(
  deps: CopyToCloudDeps,
  params: McpAccountConnectParams,
): Promise<SecretDestination | null> {
  const destination = await serverDestination(deps, params);
  if (destination === null || params.oauthClient?.clientSecret === undefined)
    return destination;
  // A client secret goes to the token endpoint the catalog pins, which can be
  // on another origin; a server with no pin can't take one at all.
  const tokenUrl = destination.tokenUrl;
  const tokenOrigin = origin(tokenUrl);
  return tokenUrl === undefined || tokenOrigin === null
    ? null
    : {
        ...destination,
        tokenEndpoint: tokenUrl,
        tokenEndpointOrigin: tokenOrigin,
      };
}

interface SecretDestination {
  readonly name: string;
  readonly origin: string;
  readonly endpointUrl?: string;
  readonly tokenUrl?: string;
  /** Where a client secret goes, and its origin as the dialog shows it. */
  readonly tokenEndpoint?: string;
  readonly tokenEndpointOrigin?: string;
}

async function serverDestination(
  deps: CopyToCloudDeps,
  params: McpAccountConnectParams,
): Promise<SecretDestination | null> {
  if (params.serverKey === undefined) {
    const custom = origin(params.customUrl);
    return custom === null
      ? null
      : { name: params.displayName ?? params.customUrl ?? '', origin: custom };
  }
  const curated = await deps.curatedServer(params.serverKey).catch(() => null);
  if (curated === null) return null;
  const pinned =
    curated.tokenUrl === undefined ? {} : { tokenUrl: curated.tokenUrl };
  const endpointUrl =
    params.endpointUrl ??
    (curated.urlOptions.length === 1 ? curated.urlOptions[0] : undefined);
  if (endpointUrl !== undefined) {
    // As the cloud's acceptsPinnedEndpoint: one of its options, or its fixed
    // URL when it has none.
    const accepted =
      curated.urlOptions.length > 0
        ? curated.urlOptions.includes(endpointUrl)
        : endpointUrl === curated.url;
    if (!accepted) return null;
    const chosen = origin(endpointUrl);
    return chosen === null
      ? null
      : { name: curated.name, origin: chosen, endpointUrl, ...pinned };
  }
  if (curated.urlOptions.length > 0) return null;
  const fixed = origin(curated.url);
  return fixed === null
    ? null
    : {
        name: curated.name,
        origin: fixed,
        endpointUrl: curated.url,
        ...pinned,
      };
}

/** The secrets a connect would send, and their names as the dialog shows them. */
async function outgoing(
  deps: CopyToCloudDeps,
  params: McpAccountConnectParams,
): Promise<{
  headers: Record<string, string> | undefined;
  bearerToken: string | undefined;
  secretNames: string[];
}> {
  const copied = await resolveCopy(deps, params);
  const headers = copied.headers ?? params.headers;
  const bearerToken = copied.bearerToken ?? params.bearerToken;
  return {
    headers,
    bearerToken,
    secretNames: [
      ...Object.keys(headers ?? {}).map((name) => `${name} header`),
      ...(bearerToken === undefined ? [] : ['bearer token']),
      ...(params.oauthClient?.clientSecret === undefined
        ? []
        : ['OAuth client secret']),
    ],
  };
}

const sameNames = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  [...left].sort().every((name, index) => name === [...right].sort()[index]);

export async function connectMcpAccount(
  deps: CopyToCloudDeps,
  params: McpAccountConnectParams,
): Promise<McpAccountConnectResult> {
  if (!deps.accountEnabled())
    throw refused(
      'failed_precondition',
      CODES.accountDisabled,
      'Cloud MCP connections are unavailable on this computer.',
    );
  let { headers, bearerToken, secretNames } = await outgoing(deps, params);
  let expectedAccountId = params.expectedAccountId;
  let endpointUrl = params.endpointUrl;
  let tokenEndpoint: string | undefined;
  if (secretNames.length > 0) {
    // The person must see where a secret goes, named from main's own
    // records: a custom server's URL, or a curated server's endpoint from
    // main's catalog. One whose destination can't be named never asks and
    // never leaves.
    const destination = await secretDestination(deps, params);
    if (destination === null)
      throw refused(
        'invalid_argument',
        CODES.invalidUrl,
        'Nothing was sent: this server’s destination couldn’t be confirmed.',
      );
    const destinationOrigin = destination.origin;
    const approved = await deps
      .confirmSecretsLeave({
        serverName: destination.name,
        secretNames,
        destinationOrigin,
        ...(destination.tokenEndpointOrigin === undefined
          ? {}
          : { tokenEndpointOrigin: destination.tokenEndpointOrigin }),
      })
      .catch(() => null);
    if (approved === null)
      throw new CanopyOperationError({
        kind: 'cancelled',
        code: CODES.consentDeclined,
        message: 'Nothing was sent: you didn’t confirm sending these secrets.',
        retry: { kind: 'never' },
      });
    if (
      expectedAccountId !== undefined &&
      expectedAccountId !== approved.accountId
    )
      throw refused(
        'conflict',
        CODES.accountChanged,
        'Nothing was sent: the cloud account changed. Try again.',
      );
    // Read what leaves again: a server edited while the person was asked
    // sends nothing unless it still goes where, and holds what, they saw.
    ({ headers, bearerToken, secretNames } = await outgoing(deps, params));
    const after = await secretDestination(deps, params);
    if (
      approved.destinationOrigin !== destinationOrigin ||
      approved.tokenEndpointOrigin !== destination.tokenEndpointOrigin ||
      after?.origin !== destinationOrigin ||
      after.endpointUrl !== destination.endpointUrl ||
      after.tokenEndpoint !== destination.tokenEndpoint ||
      !sameNames(approved.secretNames, secretNames)
    )
      throw refused(
        'conflict',
        CODES.secretSlotRefused,
        'Nothing was sent: this server changed while you were asked. Try again.',
      );
    // Secrets go only to the account the person agreed to in the dialog,
    // and only to the endpoint it showed.
    expectedAccountId = approved.accountId;
    endpointUrl = destination.endpointUrl;
    tokenEndpoint = destination.tokenEndpoint;
  }
  let response: StartAccountMcpConnectionResponse;
  try {
    response = await deps.start({
      ...(params.serverKey !== undefined
        ? {
            serverKey: params.serverKey,
            ...(endpointUrl === undefined ? {} : { endpointUrl }),
          }
        : {
            customUrl: params.customUrl ?? '',
            ...(params.displayName === undefined
              ? {}
              : { displayName: params.displayName }),
            ...(headers === undefined || Object.keys(headers).length === 0
              ? {}
              : { headers }),
          }),
      configId: params.configId,
      ...(bearerToken === undefined ? {} : { bearerToken }),
      ...(params.oauthClient === undefined
        ? {}
        : {
            oauthClient: {
              ...params.oauthClient,
              // The token endpoint the dialog showed for the client secret.
              ...(tokenEndpoint === undefined ? {} : { tokenEndpoint }),
            },
          }),
      ...(expectedAccountId === undefined ? {} : { expectedAccountId }),
    });
  } catch (error) {
    // A pinned curated endpoint the cloud no longer lists: its catalog
    // changed, and nothing was stored or sent.
    // The start adapter answers the cloud's invalid_url as a refused connect.
    const pinnedRefused =
      error instanceof AccountMcpConnectionError &&
      (error.code === 'invalid-url' ||
        (error.code === 'connect-refused' &&
          error.details.serverCode === 'invalid_url'));
    if (
      pinnedRefused &&
      params.serverKey !== undefined &&
      (endpointUrl !== undefined || tokenEndpoint !== undefined)
    )
      throw refused(
        'conflict',
        CODES.invalidUrl,
        'This server’s endpoints changed. Try again.',
      );
    if (error instanceof AccountMcpConnectionError) throw mapped(error);
    // Never forward or keep a raw failure: it could name what was sent. A
    // failure stays recorded under its key, so trying again is a new request.
    throw new CanopyOperationError({
      kind: 'unavailable',
      message: "Your cloud account couldn't be reached. Try again.",
      retry: { kind: 'never' },
    });
  }
  // D16: an OAuth server signs in on the cloud's own page, which the start
  // opened through an auth link for this account. No token is copied.
  return 'connection' in response
    ? summary(response.connection)
    : { authorizationUrl: response.authorizationUrl };
}
