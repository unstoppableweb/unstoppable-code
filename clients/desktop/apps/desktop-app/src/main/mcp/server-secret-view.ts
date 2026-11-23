import type {
  McpServerConfigData,
  McpServerData,
  McpServerDataView,
  McpServerDefinitionData,
  McpServerDefinitionView,
  McpServerFile,
  McpServerFileView,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  isStoredSecretValue,
  type SecretValueInput,
} from '@canopy/execution-engine/types/stored-secrets';
import {
  createStoredSecretResolver,
  StoredSecretError,
  type StoredSecretResolver,
  type StoredSecretSlot,
  toStoredSecretValue,
} from '../lib/stored-secrets';
import {
  controllerCredentialFreeUrl,
  mergeControllerUrl,
} from '../remote-control/host/controller-remote-urls';

/**
 * CAN-4411 F4: MCP server replies carry stored-secret references in place of
 * header, env var and extra-header values, `authToken` and
 * `oauth.clientSecret`. A kept value is honoured only inside the same server
 * and only while it would still go where it went when stored.
 *
 * Design: docs/planning/2026-11-02-can-4411-secret-replies/README.md
 */

function origin(url: string | undefined): string | null {
  if (url === undefined || url.trim().length === 0) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return url.trim();
  }
}

/** Where an HTTP server's headers, tokens and client secret are sent. */
function httpDestination<S>(definition: McpServerDefinitionData<S>): string {
  return JSON.stringify([
    'http',
    origin(definition.url),
    origin(definition.oauth?.authorizationUrl),
    origin(definition.oauth?.tokenUrl),
  ]);
}

/** What receives a command server configuration's environment. */
function commandDestination<S>(
  definition: McpServerDefinitionData<S>,
  config: Pick<McpServerConfigData<S>, 'extraArgs'>,
): string {
  return JSON.stringify([
    'command',
    definition.command ?? null,
    definition.args ?? [],
    config.extraArgs,
  ]);
}

function configDestination<S>(
  definition: McpServerDefinitionData<S>,
  config: Pick<McpServerConfigData<S>, 'extraArgs'>,
): string {
  return definition.type === 'command'
    ? commandDestination(definition, config)
    : httpDestination(definition);
}

/** The OAuth client secret's slot; it stays with the desktop OAuth client and is never redeemed (CAN-4125). */
export const MCP_OAUTH_CLIENT_SECRET_SLOT = 'definition/oauth/clientSecret';

const slots = {
  header: (name: string): string => `definition/headers/${name}`,
  clientSecret: MCP_OAUTH_CLIENT_SECRET_SLOT,
  envVar: (configId: string, key: string): string =>
    `config/${configId}/envVars/${key}`,
  extraHeader: (configId: string, name: string): string =>
    `config/${configId}/extraHeaders/${name}`,
  authToken: (configId: string): string => `config/${configId}/authToken`,
};

function mapRecord<A, B>(
  record: Record<string, A> | undefined,
  map: (key: string, value: A) => B,
): Record<string, B> | undefined {
  if (record === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, map(key, value)]),
  );
}

export function projectMcpServerData(server: McpServerData): McpServerDataView {
  const id = server.definition.id;
  const project = (slot: string, value: string): SecretValueInput =>
    toStoredSecretValue('mcp.server', id, slot, value);
  const { definition } = server;
  const headers = mapRecord(definition.headers, (name, value) =>
    project(slots.header(name), value),
  );
  const projectedDefinition: McpServerDefinitionView = {
    ...definition,
    ...(headers !== undefined ? { headers } : {}),
    ...(definition.oauth !== undefined
      ? {
          oauth: {
            ...definition.oauth,
            ...(definition.oauth.clientSecret !== undefined
              ? {
                  clientSecret: project(
                    slots.clientSecret,
                    definition.oauth.clientSecret,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
  return {
    definition: projectedDefinition,
    configs: server.configs.map((config) => ({
      ...config,
      envVars:
        mapRecord(config.envVars, (key, value) =>
          project(slots.envVar(config.id, key), value),
        ) ?? {},
      extraHeaders:
        mapRecord(config.extraHeaders, (name, value) =>
          project(slots.extraHeader(config.id, name), value),
        ) ?? {},
      ...(config.authToken !== undefined
        ? { authToken: project(slots.authToken(config.id), config.authToken) }
        : {}),
    })),
  };
}

export function projectMcpServerFile(file: McpServerFile): McpServerFileView {
  return { version: file.version, server: projectMcpServerData(file.server) };
}

function storedSlots(server: McpServerData): StoredSecretSlot[] {
  const { definition } = server;
  const result: StoredSecretSlot[] = [];
  const http = httpDestination(definition);
  for (const [name, value] of Object.entries(definition.headers ?? {}))
    result.push({ slot: slots.header(name), value, destination: http });
  if (definition.oauth?.clientSecret !== undefined)
    result.push({
      slot: slots.clientSecret,
      value: definition.oauth.clientSecret,
      destination: http,
    });
  for (const config of server.configs) {
    const destination = configDestination(definition, config);
    for (const [key, value] of Object.entries(config.envVars ?? {}))
      result.push({ slot: slots.envVar(config.id, key), value, destination });
    for (const [name, value] of Object.entries(config.extraHeaders ?? {}))
      result.push({
        slot: slots.extraHeader(config.id, name),
        value,
        destination,
      });
    if (config.authToken !== undefined)
      result.push({
        slot: slots.authToken(config.id),
        value: config.authToken,
        destination,
      });
  }
  return result;
}

/** Every stored-secret slot the server holds, with its value (CAN-4125's execution-secret owner). */
export function mcpServerStoredSecretSlots(
  server: McpServerData,
): StoredSecretSlot[] {
  return storedSlots(server);
}

/** Resolves kept values against the stored server; none may be kept without one. */
export function mcpServerSecretResolver(
  serverId: string,
  current: McpServerData | undefined,
): StoredSecretResolver {
  return createStoredSecretResolver(
    'mcp.server',
    serverId,
    current ? storedSlots(current) : [],
  );
}

function resolveRecord(
  record: Record<string, SecretValueInput> | undefined,
  resolver: StoredSecretResolver,
  destination: string,
): Record<string, string> | undefined {
  return mapRecord(record, (_key, value) =>
    resolver.resolve(value, destination),
  );
}

/**
 * Replaces every kept value in a save with the value `current` stores. Each
 * one must come from this server and still go to the destination it was
 * stored for: the same URL and OAuth endpoint origins for HTTP servers, the
 * same command, args and configuration args for command servers.
 */
export function resolveMcpServerInput(
  serverId: string,
  next: McpServerDataView,
  current: McpServerData | undefined,
): McpServerData {
  if (!Array.isArray(next.configs)) {
    throw new Error('Invalid server: configs must be an array');
  }
  const resolver = mcpServerSecretResolver(serverId, current);
  const { headers: headerInputs, oauth, ...definition } = next.definition;
  const http = httpDestination(next.definition);
  const headers = resolveRecord(headerInputs, resolver, http);
  const resolvedOAuth = (): McpServerDefinitionData['oauth'] => {
    if (oauth === undefined) return undefined;
    const { clientSecret, ...rest } = oauth;
    return clientSecret === undefined
      ? rest
      : { ...rest, clientSecret: resolver.resolve(clientSecret, http) };
  };
  const resolvedOAuthConfig = resolvedOAuth();
  return {
    definition: {
      ...definition,
      ...(headers !== undefined ? { headers } : {}),
      ...(resolvedOAuthConfig !== undefined
        ? { oauth: resolvedOAuthConfig }
        : {}),
    },
    configs: next.configs.map((config): McpServerConfigData => {
      const destination = configDestination(next.definition, config);
      const { envVars, extraHeaders, authToken, ...rest } = config;
      return {
        ...rest,
        envVars: resolveRecord(envVars, resolver, destination) ?? {},
        extraHeaders: resolveRecord(extraHeaders, resolver, destination) ?? {},
        ...(authToken !== undefined
          ? { authToken: resolver.resolve(authToken, destination) }
          : {}),
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Only a controller sees this: tell it where the change can be made.
export const CONTROLLER_SERVER_URL_CHANGED =
  "Couldn't save this server. Its saved URLs hold a credential, so change them on the computer you're controlling.";

/**
 * A save a remote-control controller sent (CAN-7082). The controller gets a
 * saved server's URL and OAuth endpoints without their credential parts, so
 * each one it sent back exactly as it got it keeps the value `current`
 * stores, byte for byte. One it changed is refused while the stored value
 * held a credential and the new one carries none of its own: the old
 * credential never goes to a new URL, and silently dropping it would break
 * the connection. A stored URL the controller got as `''` (it fails closed)
 * and left out of the save is kept: an edit form drops an empty field.
 */
export function mergeControllerServerUrls(
  next: McpServerDataView,
  current: McpServerData | undefined,
): McpServerDataView {
  const merge = (
    sent: string | undefined,
    stored: string | undefined,
  ): string | undefined => {
    if (stored === undefined) return sent;
    if (sent === undefined)
      return controllerCredentialFreeUrl(stored) === '' ? stored : undefined;
    const merged = mergeControllerUrl(sent, [stored]);
    if (merged.kind === 'changed')
      throw new StoredSecretError(
        'stored_secret_destination_changed',
        CONTROLLER_SERVER_URL_CHANGED,
      );
    return merged.kind === 'carry' ? merged.value : sent;
  };
  const { definition } = next;
  const stored = current?.definition;
  const url = merge(definition.url, stored?.url);
  const oauth =
    definition.oauth === undefined
      ? undefined
      : {
          ...definition.oauth,
          ...optionalField(
            'authorizationUrl',
            merge(
              definition.oauth.authorizationUrl,
              stored?.oauth?.authorizationUrl,
            ),
          ),
          ...optionalField(
            'tokenUrl',
            merge(definition.oauth.tokenUrl, stored?.oauth?.tokenUrl),
          ),
        };
  return {
    ...next,
    definition: {
      ...definition,
      ...optionalField('url', url),
      ...(oauth !== undefined ? { oauth } : {}),
    },
  };
}

function optionalField<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  const field: Partial<Record<K, string>> = {};
  if (value !== undefined) field[key] = value;
  return field;
}

/**
 * Moving a device server to the cloud account sends its headers and token,
 * which the renderer only holds as references. With `secretSource`, those
 * references resolve against that server, but only toward the server's own
 * URL origin; without it, a reference is refused by the request schemas.
 */
export function resolveAccountSecretInputs(
  raw: unknown,
  source: { server: McpServerData; destinationUrl: string | undefined },
): unknown {
  if (!isRecord(raw)) return raw;
  const request = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== 'secretSource'),
  );
  const { definition } = source.server;
  const destinationOrigin = origin(source.destinationUrl ?? definition.url);
  const resolver = mcpServerSecretResolver(definition.id, source.server);
  const resolve = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    if (
      definition.type !== 'http' ||
      destinationOrigin !== origin(definition.url)
    )
      throw new StoredSecretError(
        'stored_secret_destination_changed',
        'Re-enter saved secrets after changing where this server connects or what it runs.',
      );
    return resolver.resolve(
      isStoredSecretValue(value) ? value : { kind: 'stored-secret', ref: '' },
      httpDestination(definition),
    );
  };
  return {
    ...request,
    ...('headers' in request && isRecord(request.headers)
      ? {
          headers: Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [
              name,
              resolve(value),
            ]),
          ),
        }
      : {}),
    ...('bearerToken' in request
      ? { bearerToken: resolve(request.bearerToken) }
      : {}),
  };
}
