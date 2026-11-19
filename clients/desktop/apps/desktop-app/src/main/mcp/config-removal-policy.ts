import { createHash } from 'node:crypto';
import {
  classifyIndexDocument,
  classifyServerDocument,
  isServerFileName,
  serializeIndexOutput,
  type DocumentRead,
  type IndexDocument,
} from './config-repository-format';

export type McpRemovalRefusal =
  | 'server_malformed'
  | 'server_unsupported'
  | 'server_unreadable'
  | 'index_malformed'
  | 'index_unsupported'
  | 'index_unreadable'
  | 'index_missing'
  | 'identity_mismatch'
  | 'previous_removal_pending'
  | 'state_changed';

export class McpRemovalRefusedError extends Error {
  constructor(readonly code: McpRemovalRefusal) {
    super(
      'The device MCP server could not be removed safely. Use Inspect removal, then explicitly preserve evidence and force removal.',
    );
    this.name = 'McpRemovalRefusedError';
  }
}

/** Internal only: the digest is not a public inspection token. */
export interface McpPreparedRemoval {
  readonly serverId: string;
  readonly configIds: readonly string[];
  readonly serverDigest: string | null;
  readonly indexText: string | null;
}

export function validateMcpRemovalId(id: string): void {
  if (!/^[a-f0-9-]{1,256}$/.test(id))
    throw new Error('Invalid device MCP server id.');
}

export function filteredMcpRemovalIndex(
  index: IndexDocument,
  id: string,
): string {
  return serializeIndexOutput({
    ...index.raw,
    servers: index.index.servers.filter((row) => row.id !== id),
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

/** No forgiving reads, normalization-based reconstruction or routing equality. */
export function prepareMcpRemoval(options: {
  serverId: string;
  server: DocumentRead;
  index: DocumentRead;
  /** Needed only when the shared index is absent. Includes the target file. */
  definitionNames: readonly string[];
}): McpPreparedRemoval {
  const { serverId } = options;
  validateMcpRemovalId(serverId);
  const server = classifyServerDocument(options.server, serverId);
  const index = classifyIndexDocument(options.index);
  if (server.kind !== 'absent' && server.kind !== 'valid')
    throw new McpRemovalRefusedError(`server_${server.kind}`);
  if (index.kind !== 'absent' && index.kind !== 'valid')
    throw new McpRemovalRefusedError(`index_${index.kind}`);
  if (index.kind === 'absent') {
    if (
      server.kind !== 'absent' ||
      options.definitionNames.some(isServerFileName)
    )
      throw new McpRemovalRefusedError('index_missing');
    return { serverId, configIds: [], serverDigest: null, indexText: null };
  }
  const entry = index.value.index.servers.find((row) => row.id === serverId);
  const configIds = entry?.configs.map((config) => config.id) ?? [];
  if (configIds.some((id) => !/^[a-f0-9-]{1,256}$/.test(id)))
    throw new McpRemovalRefusedError('identity_mismatch');
  // Index binding/routing metadata is authoritative independently of the file.
  // Only definition identity and config membership must agree. The missing-file
  // branch intentionally permits retry after unlink but failed index publication.
  if (
    server.kind === 'valid' &&
    (!entry ||
      !sameIds(
        configIds,
        server.value.file.server.configs.map((config) => config.id),
      ))
  )
    throw new McpRemovalRefusedError('identity_mismatch');
  return {
    serverId,
    configIds,
    serverDigest:
      'text' in options.server
        ? createHash('sha256').update(options.server.text).digest('hex')
        : null,
    indexText: filteredMcpRemovalIndex(index.value, serverId),
  };
}

/** Other-server rows may change; the target and its credential membership may not. */
export function assertMcpRemovalUnchanged(
  before: McpPreparedRemoval,
  after: McpPreparedRemoval,
): void {
  if (
    before.serverId !== after.serverId ||
    before.serverDigest !== after.serverDigest ||
    !sameIds(before.configIds, after.configIds)
  )
    throw new McpRemovalRefusedError('state_changed');
}
