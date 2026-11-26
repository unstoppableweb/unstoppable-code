/**
 * Ids that name the authority they belong to (CAN-7757). A task, chat or
 * project id is unique only on the authority that minted it, so every id
 * that leaves its authority is written `<authorityId>:<localId>`. The
 * authority id is the one an authority registry entry registers under:
 *
 * - `web-core:<localId>` for the web core's cloud chats (CAN-4185 D6);
 * - `computer-<deviceId>:<localId>` for a paired computer, named by its
 *   relay device id ({@link DEVICE_ID_PATTERN}), never by its display name.
 *
 * Ids on their own authority are never qualified, so local ids do not
 * change. A local id is never empty and never holds `:` or `/`: project and
 * worktree ids are slugs and chat ids are `chat-…`. That keeps a qualified id
 * a single segment of a `projectId/worktreeId` key, and stops one id from
 * being qualified twice. This module is the only parser of the prefix.
 */
import { DEVICE_ID_PATTERN } from './device-relay/device-id';

declare const AUTHORITY_QUALIFIED_ID: unique symbol;

/** An id that {@link parseAuthorityQualifiedId} reads back to its authority. */
export type AuthorityQualifiedId = string & {
  readonly [AUTHORITY_QUALIFIED_ID]: true;
};

export const WEB_CORE_AUTHORITY_ID = 'web-core';

const PAIRED_COMPUTER_AUTHORITY_PREFIX = 'computer-';

/** The authority a qualified id names. */
export type IdAuthority =
  | { readonly kind: 'web-core' }
  | { readonly kind: 'paired-computer'; readonly deviceId: string };

export interface ParsedAuthorityQualifiedId {
  readonly authority: IdAuthority;
  /** The authority's registry id: `web-core` or `computer-<deviceId>`. */
  readonly authorityId: string;
  /** The id as its own authority knows it. */
  readonly localId: string;
}

/** The registry id of an authority; it is also the id's prefix. */
export function authorityIdOf(authority: IdAuthority): string {
  return authority.kind === 'web-core'
    ? WEB_CORE_AUTHORITY_ID
    : `${PAIRED_COMPUTER_AUTHORITY_PREFIX}${authority.deviceId}`;
}

/** The authority a registry id names, or null for any other id. */
export function authorityOfId(authorityId: string): IdAuthority | null {
  if (authorityId === WEB_CORE_AUTHORITY_ID) return { kind: 'web-core' };
  if (!authorityId.startsWith(PAIRED_COMPUTER_AUTHORITY_PREFIX)) return null;
  const deviceId = authorityId.slice(PAIRED_COMPUTER_AUTHORITY_PREFIX.length);
  return DEVICE_ID_PATTERN.test(deviceId)
    ? { kind: 'paired-computer', deviceId }
    : null;
}

function isLocalId(localId: string): boolean {
  return localId.length > 0 && !/[:/]/.test(localId);
}

/** The authority and local id a qualified id names, or null for any other id. */
export function parseAuthorityQualifiedId(
  id: string,
): ParsedAuthorityQualifiedId | null {
  const separator = id.indexOf(':');
  if (separator < 0) return null;
  const authorityId = id.slice(0, separator);
  const authority = authorityOfId(authorityId);
  const localId = id.slice(separator + 1);
  if (authority === null || !isLocalId(localId)) return null;
  return { authority, authorityId, localId };
}

export function isAuthorityQualifiedId(id: string): id is AuthorityQualifiedId {
  return parseAuthorityQualifiedId(id) !== null;
}

/**
 * The id `localId` has outside its authority. Throws for a local id that
 * could not be read back: an empty one, or one that holds `:` or `/`.
 */
export function qualifyId(
  authority: IdAuthority,
  localId: string,
): AuthorityQualifiedId {
  const id = `${authorityIdOf(authority)}:${localId}`;
  if (!isLocalId(localId) || !isAuthorityQualifiedId(id))
    throw new RangeError('This id cannot be qualified with an authority.');
  return id;
}

/** Whether an id is qualified for a paired computer. */
export function isPairedComputerId(id: string): boolean {
  return (
    id.startsWith(PAIRED_COMPUTER_AUTHORITY_PREFIX) &&
    parseAuthorityQualifiedId(id)?.authority.kind === 'paired-computer'
  );
}

/** Fields that address a project, task or chat on the serving authority. */
const ADDRESS_FIELDS: ReadonlySet<string> = new Set([
  'projectId',
  'workspaceId',
  'worktreeId',
  'workEntryId',
  'taskId',
  'chatId',
  'tabId',
  'scopeId',
]);

/** Objects inside an IPC request that hold its address fields. */
const REQUEST_ADDRESS_CONTAINERS: ReadonlySet<string> = new Set([
  'scope',
  'target',
]);

/**
 * Keys of core operation parameters that hold addresses, as an object or a
 * list of them: `scope.workspaceId`, `advance[].worktreeId`,
 * `expectedRevisions[].resource.worktreeId`. Every other nested value, such
 * as a workflow's user-defined `inputs` or a recorded `outcome`, is opaque.
 */
const OPERATION_ADDRESS_CONTAINERS: ReadonlySet<string> = new Set([
  'scope',
  'targetScope',
  'target',
  'resource',
  'ref',
  'from',
  'to',
  'advance',
  'expectedRevisions',
  'files',
]);

/** How many containers deep {@link operationAddressesPairedComputer} looks. */
const OPERATION_ADDRESS_DEPTH = 3;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function namesPairedComputer(
  fields: Readonly<Record<string, unknown>>,
): boolean {
  for (const field of ADDRESS_FIELDS) {
    const value = fields[field];
    if (typeof value === 'string' && isPairedComputerId(value)) return true;
  }
  return false;
}

/**
 * Whether an IPC request object addresses a paired computer's project, task
 * or chat, in its address fields at the top level or in its `scope` or
 * `target`. Nothing else is read: saved preferences, message text and
 * free-form string arguments such as search queries may hold any text, and
 * a qualified id may be saved. Main serves only its own ids, which are never
 * qualified, so such a request is refused, never served as local.
 */
export function requestAddressesPairedComputer(request: unknown): boolean {
  if (!isRecord(request)) return false;
  if (namesPairedComputer(request)) return true;
  for (const container of REQUEST_ADDRESS_CONTAINERS) {
    const value = request[container];
    if (isRecord(value) && namesPairedComputer(value)) return true;
  }
  return false;
}

/**
 * Whether core operation parameters address a paired computer's project,
 * task or chat: an address field at the top level, or inside an address
 * container (see {@link OPERATION_ADDRESS_CONTAINERS}) or a list of them, up
 * to three containers deep. A core serves only its own ids, which are never
 * qualified.
 */
export function operationAddressesPairedComputer(params: unknown): boolean {
  return addressesWithin(params, OPERATION_ADDRESS_DEPTH);
}

function addressesWithin(value: unknown, depth: number): boolean {
  if (Array.isArray(value))
    return value.some((item) => addressesWithin(item, depth));
  if (!isRecord(value)) return false;
  if (namesPairedComputer(value)) return true;
  if (depth === 0) return false;
  for (const container of OPERATION_ADDRESS_CONTAINERS) {
    if (addressesWithin(value[container], depth - 1)) return true;
  }
  return false;
}
