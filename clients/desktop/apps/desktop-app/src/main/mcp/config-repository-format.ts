import type {
  McpOAuthConfigData,
  McpServerConfigData,
  McpServerConfigSummary,
  McpServerCuratedMetadata,
  McpServerData,
  McpServerDefinitionData,
  McpServerFile,
  McpServerIndexEntry,
  McpServersIndexFile,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  isMcpServersIndexFile,
  normalizeCuratedMetadata,
  normalizeMcpServerFile,
} from '@canopy/execution-engine/types/mcp-servers';

type JsonObject = Record<string, unknown>;

export type McpConfigDocument = 'index' | 'server';
export type McpConfigUnusableState =
  | 'malformed'
  | 'unsupported'
  | 'unreadable'
  | 'orphaned';

const REFUSAL: Record<McpConfigUnusableState, string> = {
  malformed: 'is damaged',
  unsupported: 'uses an unsupported version',
  unreadable: 'could not be read',
  orphaned: 'is missing while server files remain',
};

/** Mutation refused because persisted state is unusable; nothing was written. */
export class McpConfigStateError extends Error {
  constructor(
    readonly document: McpConfigDocument,
    readonly state: McpConfigUnusableState,
    readonly detail: string,
  ) {
    super(
      `${document === 'index' ? 'The MCP server list' : 'The MCP server file'} ${REFUSAL[state]}, so it was not changed.`,
    );
    this.name = 'McpConfigStateError';
  }
}

export class McpConfigNotFoundError extends Error {
  constructor(readonly target: 'server' | 'config') {
    super(
      target === 'server'
        ? 'MCP server was not found.'
        : 'MCP configuration was not found.',
    );
    this.name = 'McpConfigNotFoundError';
  }
}

export class McpCuratedTransitionError extends Error {
  readonly code = 'curated_extensions_would_be_lost';

  constructor() {
    super(
      'This catalog change would discard saved data. Remove the device server explicitly, then add the replacement.',
    );
    this.name = 'McpCuratedTransitionError';
  }
}

export type DocumentRead = { text: string } | { error: unknown };

export async function readDocument(
  read: () => Promise<string>,
): Promise<DocumentRead> {
  try {
    return { text: await read() };
  } catch (error) {
    return { error };
  }
}

/** Only an ENOENT code proves absence; message text does not. */
export function isAbsentError(error: unknown): boolean {
  // Node filesystem errors can originate outside this realm (for example in
  // a VM host). Their code, not their prototype or message, proves absence.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** `server-<id>.json` per `lib/paths.ts`; excludes the catalog and tools cache. */
export function isServerFileName(name: string): boolean {
  return /^server-.+\.json$/.test(name);
}

export type Classified<T> =
  | { kind: 'absent' }
  | { kind: 'valid'; value: T }
  | { kind: Exclude<McpConfigUnusableState, 'orphaned'>; detail: string };

export interface IndexDocument {
  raw: JsonObject;
  index: McpServersIndexFile;
}

export interface ServerDocument {
  raw: JsonObject;
  file: McpServerFile;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(detail: string): Classified<never> {
  return { kind: 'malformed', detail };
}

function hasDuplicate(ids: string[]): boolean {
  return new Set(ids).size !== ids.length;
}

function parseEnvelope(read: DocumentRead): Classified<JsonObject> {
  if ('error' in read) {
    return isAbsentError(read.error)
      ? { kind: 'absent' }
      : {
          kind: 'unreadable',
          detail:
            read.error instanceof Error ? read.error.message : 'read failed',
        };
  }
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    return malformed('invalid JSON');
  }
  if (!isJsonObject(value)) return malformed('not a JSON object');
  if (value.version === 1) return { kind: 'valid', value };
  return typeof value.version === 'number'
    ? { kind: 'unsupported', detail: `version ${String(value.version)}` }
    : malformed('missing version');
}

const isOptional = (value: unknown, allowed: readonly unknown[]): boolean =>
  value === undefined || allowed.includes(value);

function indexEntryProblem(entry: McpServerIndexEntry): string | undefined {
  if (hasDuplicate(entry.configs.map((config) => config.id)))
    return `duplicate config ids for ${entry.id}`;
  if (
    !isOptional(entry.scope, ['device', 'account']) ||
    !isOptional(entry.authHandler, ['canopy', 'provider', 'account']) ||
    !['undefined', 'string'].includes(typeof entry.accountConnectionId) ||
    !['undefined', 'string'].includes(typeof entry.urlHost) ||
    !['undefined', 'string'].includes(typeof entry.urlScheme)
  )
    return `invalid routing fields for ${entry.id}`;
  return undefined;
}

/** The display fallback accepts legacy envelopes even when a row fails this check. */
export function isClassifiableIndexEntry(entry: unknown): boolean {
  const envelope: unknown = { version: 1, servers: [entry] };
  if (!isMcpServersIndexFile(envelope)) return false;
  const [row] = envelope.servers;
  return row !== undefined && indexEntryProblem(row) === undefined;
}

function indexProblem(value: JsonObject): string | undefined {
  if (!isMcpServersIndexFile(value)) return 'invalid server entries';
  if (hasDuplicate(value.servers.map((entry) => entry.id)))
    return 'duplicate server ids';
  for (const entry of value.servers) {
    const problem = indexEntryProblem(entry);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

export function classifyIndexDocument(
  read: DocumentRead,
): Classified<IndexDocument> {
  const parsed = parseEnvelope(read);
  if (parsed.kind !== 'valid') return parsed;
  const raw = parsed.value;
  const problem = indexProblem(raw);
  if (problem !== undefined || !isMcpServersIndexFile(raw))
    return malformed(problem ?? 'invalid server entries');
  return { kind: 'valid', value: { raw, index: raw } };
}

export function classifyServerDocument(
  read: DocumentRead,
  id: string,
): Classified<ServerDocument> {
  const parsed = parseEnvelope(read);
  if (parsed.kind !== 'valid') return parsed;
  let file: McpServerFile;
  try {
    file = normalizeMcpServerFile(parsed.value, id);
  } catch (error) {
    return malformed(error instanceof Error ? error.message : 'invalid server');
  }
  if (file.server.definition.id !== id) return malformed('identity mismatch');
  if (hasDuplicate(file.server.configs.map((config) => config.id)))
    return malformed('duplicate config ids');
  return { kind: 'valid', value: { raw: parsed.value, file } };
}

/** Absent state is `undefined`; any other unusable state refuses the mutation. */
export function requireMutableState<T>(
  document: McpConfigDocument,
  state: Classified<T>,
): T | undefined {
  if (state.kind === 'absent') return undefined;
  if (state.kind === 'valid') return state.value;
  throw new McpConfigStateError(document, state.kind, state.detail);
}

/** Validates exactly the bytes to be written with the strict reader. */
export function serializeServerOutput(
  value: JsonObject,
  id: string,
): { text: string; file: McpServerFile } {
  const text = JSON.stringify(value, null, 2);
  const state = classifyServerDocument({ text }, id);
  if (state.kind !== 'valid')
    throw new Error(
      `Invalid MCP server: ${state.kind === 'absent' ? 'empty' : state.detail}`,
    );
  return { text, file: state.value.file };
}

export function serializeIndexOutput(value: JsonObject): string {
  const text = JSON.stringify(value, null, 2);
  const state = classifyIndexDocument({ text });
  if (state.kind !== 'valid')
    throw new Error(
      `Invalid MCP server index: ${state.kind === 'absent' ? 'empty' : state.detail}`,
    );
  return text;
}

/** Every known field, checked exhaustively against its type at compile time. */
function knownFields<T>(fields: { [K in keyof T]-?: true }): Set<string> {
  return new Set(Object.keys(fields));
}

const INDEX_FILE_FIELDS = knownFields<McpServersIndexFile>({
  version: true,
  servers: true,
  accountConnectionsAvailable: true,
  accountConnectionsUnavailableReason: true,
});
const INDEX_ENTRY_FIELDS = knownFields<McpServerIndexEntry>({
  harnessCompatibility: true,
  // Served only; the record lives in its own file (CAN-6815).
  harnessInstalls: true,
  accountConnection: true,
  deviceCopies: true,
  scope: true,
  authHandler: true,
  accountConnectionId: true,
  id: true,
  name: true,
  description: true,
  type: true,
  configs: true,
  logoUrl: true,
  curatedKey: true,
  urlHost: true,
  urlScheme: true,
  createdAt: true,
  updatedAt: true,
});
const CONFIG_SUMMARY_FIELDS = knownFields<McpServerConfigSummary>({
  id: true,
  name: true,
  enabled: true,
});
const SERVER_FILE_FIELDS = knownFields<McpServerFile>({
  version: true,
  server: true,
});
const SERVER_FIELDS = knownFields<McpServerData>({
  definition: true,
  configs: true,
});
const DEFINITION_FIELDS = knownFields<McpServerDefinitionData>({
  id: true,
  name: true,
  description: true,
  type: true,
  command: true,
  args: true,
  url: true,
  headers: true,
  oauth: true,
  curated: true,
  httpAuthHandler: true,
  createdAt: true,
  updatedAt: true,
});
const OAUTH_FIELDS = knownFields<McpOAuthConfigData>({
  clientId: true,
  clientSecret: true,
  callbackPort: true,
  vendorRegisteredRedirect: true,
  authorizationUrl: true,
  tokenUrl: true,
  scopes: true,
  audience: true,
  usePkce: true,
});
const CURATED_FIELDS = knownFields<McpServerCuratedMetadata>({
  key: true,
  logoUrl: true,
  docsUrl: true,
  supportUrl: true,
  privacyPolicyUrl: true,
  authorName: true,
  authorUrl: true,
  requiresProviderAuth: true,
});
const CONFIG_FIELDS = knownFields<McpServerConfigData>({
  id: true,
  name: true,
  description: true,
  enabled: true,
  envVars: true,
  extraArgs: true,
  extraHeaders: true,
  authToken: true,
  createdAt: true,
  updatedAt: true,
});

/**
 * Unknown fields of a retained object. Known fields are always replaced by the
 * request, so omitted credentials, configs and cleared routing stay removed.
 */
function extensions(value: unknown, known: Set<string>): JsonObject {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );
}

function objectsById(value: unknown): Map<unknown, JsonObject> {
  const rows = Array.isArray(value) ? value.filter(isJsonObject) : [];
  return new Map(rows.map((row) => [row.id, row]));
}

function child(value: unknown, key: string): unknown {
  return isJsonObject(value) ? value[key] : undefined;
}

export function overlayServerDocument(
  current: JsonObject | undefined,
  server: McpServerData,
): JsonObject {
  const rawServer = child(current, 'server');
  const rawDefinition = child(rawServer, 'definition');
  const rawCurated = child(rawDefinition, 'curated');
  const rawConfigs = objectsById(child(rawServer, 'configs'));
  const { curated, oauth } = server.definition;
  const previousCurated = normalizeCuratedMetadata({
    type: 'http',
    ...(rawCurated === undefined ? {} : { curated: rawCurated }),
  });
  const nextCurated = normalizeCuratedMetadata(server.definition);
  const retainedCurated = previousCurated?.key === nextCurated?.key;
  const curatedExtensions = extensions(rawCurated, CURATED_FIELDS);
  if (!retainedCurated && Object.keys(curatedExtensions).length > 0)
    throw new McpCuratedTransitionError();
  const definition = {
    ...extensions(rawDefinition, DEFINITION_FIELDS),
    ...server.definition,
    ...(oauth
      ? {
          oauth: {
            ...extensions(child(rawDefinition, 'oauth'), OAUTH_FIELDS),
            ...oauth,
          },
        }
      : {}),
    ...(curated
      ? {
          curated: {
            ...(retainedCurated ? curatedExtensions : {}),
            ...curated,
          },
        }
      : {}),
  };
  const configs = server.configs.map((config) => ({
    ...extensions(rawConfigs.get(config.id), CONFIG_FIELDS),
    ...config,
  }));
  return {
    ...extensions(current, SERVER_FILE_FIELDS),
    version: 1,
    server: {
      ...extensions(rawServer, SERVER_FIELDS),
      definition,
      configs,
    },
  };
}

export function indexEnvelope(
  current: JsonObject | undefined,
  servers: unknown[],
): JsonObject {
  return { ...extensions(current, INDEX_FILE_FIELDS), version: 1, servers };
}

/** Replaces or appends one entry; other entries are written back unchanged. */
export function overlayIndexEntry(
  current: IndexDocument | undefined,
  entry: McpServerIndexEntry,
): JsonObject {
  const servers: unknown[] = current ? [...current.index.servers] : [];
  const position = servers.findIndex((row) => child(row, 'id') === entry.id);
  const previous = position < 0 ? undefined : servers[position];
  const previousConfigs = objectsById(child(previous, 'configs'));
  const next = {
    ...extensions(previous, INDEX_ENTRY_FIELDS),
    ...entry,
    configs: entry.configs.map((config) => ({
      ...extensions(previousConfigs.get(config.id), CONFIG_SUMMARY_FIELDS),
      ...config,
    })),
  };
  if (position < 0) servers.push(next);
  else servers[position] = next;
  return indexEnvelope(current?.raw, servers);
}
