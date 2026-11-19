/**
 * Desktop inventory sync wire contract (CAN-2830).
 *
 * The desktop pushes its already-sanitized capability inventory — the exact
 * `Portal*ListResult` shapes the portal browse commands return today — to a
 * durable per-device store in the cloud, and the web portal reads those
 * documents instead of asking the paired desktop live. Remote Control stays
 * the path for mutations and for explicit catch-up.
 *
 * Design: docs/planning/2026-09-06-desktop-inventory-cloud-sync/design.md
 *
 * Environment-neutral: types, constants, and pure validation only. Hashing
 * (SHA-256 of {@link stableStringify}) is done by each host with its own
 * crypto; this module only defines the canonical serialization.
 */
import {
  REMOTE_CONTROL_CATALOG_RESULT_MAX_BYTES,
  type RemoteControlCollectionsListResult,
  type RemoteControlMcpListServersResult,
  type RemoteControlPipelineListResult,
  type RemoteControlPluginsListMarketplacesResult,
  type RemoteControlSkillsListResult,
} from '../remote-control/shell';
import type { InstalledItemSnapshot } from '../installed-items';
import { stableStringify } from '../lib/stable-stringify';

// ===========================================================================
// Kinds and scope keys
// ===========================================================================

/**
 * Every inventory kind the desktop syncs. Device-level kinds use
 * {@link DESKTOP_INVENTORY_DEVICE_SCOPE_KEY}; `pipelines` is keyed per
 * worktree (see {@link buildWorktreeInventoryScopeKey}) because project
 * pipelines are discovered from the worktree checkout.
 */
export const DESKTOP_INVENTORY_KINDS = [
  'marketplaces',
  'skills',
  'mcp_servers',
  'collections',
  'pipelines',
  'installed_items',
] as const;

export type DesktopInventoryKind = (typeof DESKTOP_INVENTORY_KINDS)[number];

const DESKTOP_INVENTORY_KINDS_SET: ReadonlySet<string> = new Set(
  DESKTOP_INVENTORY_KINDS,
);

export function isDesktopInventoryKind(
  value: unknown,
): value is DesktopInventoryKind {
  return typeof value === 'string' && DESKTOP_INVENTORY_KINDS_SET.has(value);
}

/** Scope key shared by every device-level (non-worktree) inventory kind. */
export const DESKTOP_INVENTORY_DEVICE_SCOPE_KEY = '';

const WORKTREE_SCOPE_KEY_SEPARATOR = ':';

/**
 * Scope key for a worktree-scoped document: `${workspaceLocalId}:${worktreeLocalId}`.
 * Both ids must be non-empty and must not contain the separator (Canopy ids
 * match `/^[a-z0-9][a-z0-9-]*$/`, so this only guards against misuse).
 */
export function buildWorktreeInventoryScopeKey(
  workspaceLocalId: string,
  worktreeLocalId: string,
): string {
  const parts = [
    ['workspaceLocalId', workspaceLocalId],
    ['worktreeLocalId', worktreeLocalId],
  ] as const;
  for (const [label, value] of parts) {
    if (value.length === 0) {
      throw new Error(`${label} must not be empty.`);
    }
    if (value.includes(WORKTREE_SCOPE_KEY_SEPARATOR)) {
      throw new Error(
        `${label} must not contain "${WORKTREE_SCOPE_KEY_SEPARATOR}".`,
      );
    }
  }
  return `${workspaceLocalId}${WORKTREE_SCOPE_KEY_SEPARATOR}${worktreeLocalId}`;
}

export interface WorktreeInventoryScope {
  workspaceLocalId: string;
  worktreeLocalId: string;
}

/** Inverse of {@link buildWorktreeInventoryScopeKey}; `null` when malformed. */
export function parseWorktreeInventoryScopeKey(
  scopeKey: string,
): WorktreeInventoryScope | null {
  const parts = scopeKey.split(WORKTREE_SCOPE_KEY_SEPARATOR);
  if (parts.length !== 2) return null;
  const [workspaceLocalId, worktreeLocalId] = parts;
  if (!workspaceLocalId || !worktreeLocalId) return null;
  return { workspaceLocalId, worktreeLocalId };
}

/**
 * Whether `scopeKey` is well-formed for `kind`: device-level kinds must use
 * {@link DESKTOP_INVENTORY_DEVICE_SCOPE_KEY}, `pipelines` must use a parseable
 * worktree scope key. Enforced for documents AND removals so a malformed
 * removal can never silently miss the row it meant to delete.
 */
export function isDesktopInventoryScopeKeyValid(
  kind: DesktopInventoryKind,
  scopeKey: string,
): boolean {
  if (scopeKey.length > MAX_DESKTOP_INVENTORY_SCOPE_KEY_LENGTH) return false;
  return kind === 'pipelines'
    ? parseWorktreeInventoryScopeKey(scopeKey) !== null
    : scopeKey === DESKTOP_INVENTORY_DEVICE_SCOPE_KEY;
}

// ===========================================================================
// Documents
// ===========================================================================

/**
 * Kind → payload. Each list kind is the existing portal list result shape;
 * `installed_items` is the desktop's installed-item status snapshot, which
 * carries ids, statuses and fixed notice copy only (no MCP environment
 * values, headers, tokens or local paths), so it syncs unredacted.
 */
export interface DesktopInventoryPayloadMap {
  marketplaces: RemoteControlPluginsListMarketplacesResult;
  skills: RemoteControlSkillsListResult;
  mcp_servers: RemoteControlMcpListServersResult;
  collections: RemoteControlCollectionsListResult;
  pipelines: RemoteControlPipelineListResult;
  installed_items: InstalledItemSnapshot;
}

/** The document shape for exactly one kind. */
export interface DesktopInventoryDocumentOf<K extends DesktopInventoryKind> {
  kind: K;
  scopeKey: string;
  contentHash: string;
  /** ISO-8601 time the desktop captured `payload`. */
  capturedAt: string;
  payload: DesktopInventoryPayloadMap[K];
}

/**
 * One synced inventory document. Identity is `(kind, scopeKey)` within a
 * device; `contentHash` is the lowercase hex SHA-256 of
 * `stableStringify(payload)` and lets both sides skip unchanged uploads.
 *
 * A discriminated union over the kinds by default, so `kind` and `payload`
 * can never be paired across kinds; pass a literal `K` to name one kind's
 * document.
 */
export type DesktopInventoryDocument<
  K extends DesktopInventoryKind = DesktopInventoryKind,
> = {
  [P in K]: DesktopInventoryDocumentOf<P>;
}[K];

/** Identity of a document to delete (e.g. a removed worktree's pipelines). */
export interface DesktopInventoryRemoval {
  kind: DesktopInventoryKind;
  scopeKey: string;
}

// ===========================================================================
// Limits
// ===========================================================================

/**
 * Per-document payload cap. Equal to the portal catalog result budget the
 * desktop already fits every list to, so a document that fits the live
 * command also fits the store.
 */
export const MAX_DESKTOP_INVENTORY_DOCUMENT_BYTES =
  REMOTE_CONTROL_CATALOG_RESULT_MAX_BYTES;

/** Hard cap on one sync request body, enforced by the server before parsing. */
export const MAX_DESKTOP_INVENTORY_REQUEST_BYTES = 4 * 1024 * 1024;

export const MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST = 50;
/**
 * Removals are cheap rows to name but each becomes a delete predicate, so
 * they are capped like documents. The desktop chunks larger diffs.
 */
export const MAX_DESKTOP_INVENTORY_REMOVALS_PER_REQUEST = 200;

/**
 * Durable-storage caps enforced by the server per account, so a caller
 * cannot grow the store without bound by varying device or scope ids. A
 * request that would create rows past either cap is rejected (409) and the
 * desktop drops it rather than retrying.
 */
export const MAX_DESKTOP_INVENTORY_DEVICES_PER_USER = 25;
export const MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_DEVICE = 1_000;

/**
 * Browser read bounds: one read returns at most this many documents and
 * stops appending once the serialized payloads pass this many bytes, so an
 * account with a large store cannot make one request materialize it all.
 * The response reports `truncated: true` when either bound cut the list.
 */
export const MAX_DESKTOP_INVENTORY_READ_DOCUMENTS = 200;
export const MAX_DESKTOP_INVENTORY_READ_BYTES = 8 * 1024 * 1024;

/** Matches the `VARCHAR(256)` columns the ids are stored in. */
export const MAX_DESKTOP_INVENTORY_CLIENT_DEVICE_ID_LENGTH = 256;
export const MAX_DESKTOP_INVENTORY_SCOPE_KEY_LENGTH = 256;
export const MAX_DESKTOP_INVENTORY_CLIENT_NAME_LENGTH = 256;

// ===========================================================================
// Requests and responses
// ===========================================================================

/** Body of `PUT /api/v1/[brandNamespace]/desktop-inventory/documents`. */
export interface DesktopInventorySyncRequest {
  clientDeviceId: string;
  /** Human-readable device label (hostname) for a future device picker. */
  clientName?: string;
  documents: DesktopInventoryDocument[];
  removals?: DesktopInventoryRemoval[];
}

/**
 * A document whose ENVELOPE has been validated by
 * {@link parseDesktopInventorySyncRequest}. The payload stays an opaque
 * object on purpose: the server stores it as-is and the reader applies the
 * per-kind structural guards, so this type never claims more than was
 * checked.
 */
export interface ParsedDesktopInventoryDocument {
  kind: DesktopInventoryKind;
  scopeKey: string;
  contentHash: string;
  capturedAt: string;
  payload: Record<string, unknown>;
}

/** {@link DesktopInventorySyncRequest} after validation: removals defaulted. */
export interface ParsedDesktopInventorySyncRequest extends Omit<
  DesktopInventorySyncRequest,
  'documents' | 'removals'
> {
  documents: ParsedDesktopInventoryDocument[];
  removals: DesktopInventoryRemoval[];
}

export interface DesktopInventorySyncAcceptedDocument {
  kind: DesktopInventoryKind;
  scopeKey: string;
  contentHash: string;
  /** True when the stored hash already matched and no row was rewritten. */
  unchanged: boolean;
}

export interface DesktopInventorySyncResponse {
  accepted: DesktopInventorySyncAcceptedDocument[];
  /** Number of rows deleted for `removals`. */
  removed: number;
}

/** One stored document's identity and hash, as the manifest lists them. */
export interface DesktopInventoryManifestEntry {
  kind: DesktopInventoryKind;
  scopeKey: string;
  contentHash: string;
}

/**
 * Response of `GET /api/v1/[brandNamespace]/desktop-inventory/documents`:
 * what the cloud currently holds for one device, so a desktop that
 * restarted or changed identity can seed its accepted-hash record and
 * compute removals against the store instead of against memory it lost.
 */
export interface DesktopInventoryManifestResponse {
  clientDeviceId: string;
  documents: DesktopInventoryManifestEntry[];
}

/**
 * Response of `DELETE /api/v1/[brandNamespace]/desktop-inventory/documents`:
 * how many of the caller's documents for one device were removed. The
 * desktop sends it when the user turns inventory sync off (CAN-5986). It is
 * idempotent, so a repeat call answers `deleted: 0`.
 */
export interface DesktopInventoryDeleteResponse {
  deleted: number;
}

/** Structural guard for {@link DesktopInventoryDeleteResponse}. */
export function isDesktopInventoryDeleteResponse(
  value: unknown,
): value is DesktopInventoryDeleteResponse {
  if (typeof value !== 'object' || value === null) return false;
  const deleted: unknown = Reflect.get(value, 'deleted');
  return (
    typeof deleted === 'number' && Number.isInteger(deleted) && deleted >= 0
  );
}

/** A device that has synced at least one document. */
export interface DesktopInventoryDeviceSummary {
  clientDeviceId: string;
  clientName?: string;
  /** ISO-8601 time of the most recent accepted document for this device. */
  lastSyncedAt: string;
}

/**
 * A stored document as the browser reads it. The payload is opaque on the
 * read side too: the server stores what it accepted, and the browser applies
 * the same per-kind structural guards it already uses for live portal
 * results, so a document that fails them degrades one page instead of being
 * trusted by type alone.
 */
export interface DesktopInventoryStoredDocument extends ParsedDesktopInventoryDocument {
  /** ISO-8601 time the server last accepted this document. */
  syncedAt: string;
}

/**
 * Response of `GET /api/account/desktop-inventory`. The older
 * `GET /api/v1/[brandNamespace]/portal/browser/inventory` returns the same
 * shape and retires with the Portal routes (CAN-5986).
 */
export interface DesktopInventoryReadResponse {
  /** `null` when the user has no synced device yet. */
  device: DesktopInventoryDeviceSummary | null;
  documents: DesktopInventoryStoredDocument[];
  /**
   * True when the read bounds ({@link MAX_DESKTOP_INVENTORY_READ_DOCUMENTS},
   * {@link MAX_DESKTOP_INVENTORY_READ_BYTES}) cut the list. Absent means
   * complete.
   */
  truncated?: boolean;
  /**
   * Opaque continuation, present only with `truncated`: pass it back as the
   * `cursor` query parameter to read the documents after the last one in
   * this response. Absent on a truncated response only when no document fit
   * at all.
   */
  nextCursor?: string;
}

// ===========================================================================
// Canonical serialization
// ===========================================================================

/**
 * Both the desktop and the server hash `stableStringify(payload)`, so a
 * payload rebuilt with keys in a different order never looks changed. The
 * implementation is shared with the plans contract (`../lib`).
 */
export { stableStringify };

// ===========================================================================
// Structural validation
// ===========================================================================

export type DesktopInventorySyncRequestParseResult =
  | { ok: true; request: ParsedDesktopInventorySyncRequest }
  | { ok: false; error: string };

type DocumentParseResult =
  | { ok: true; document: ParsedDesktopInventoryDocument }
  | { ok: false; error: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

/** Exactly what `Date#toISOString()` emits — no other parseable spellings. */
function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Validate the envelope of a sync request. Payloads are checked only for
 * being objects within the byte budget; the consumer applies the existing
 * per-kind structural guards when it reads a document, so a malformed
 * payload can degrade one page but never poison the store's shape.
 */
export function parseDesktopInventorySyncRequest(
  body: unknown,
): DesktopInventorySyncRequestParseResult {
  if (!isRecord(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  if (
    !isBoundedString(
      body.clientDeviceId,
      MAX_DESKTOP_INVENTORY_CLIENT_DEVICE_ID_LENGTH,
    )
  ) {
    return { ok: false, error: 'clientDeviceId is required.' };
  }
  const clientDeviceId = body.clientDeviceId;
  let clientName: string | undefined;
  if (body.clientName !== undefined) {
    if (
      !isBoundedString(
        body.clientName,
        MAX_DESKTOP_INVENTORY_CLIENT_NAME_LENGTH,
      )
    ) {
      return { ok: false, error: 'clientName is invalid.' };
    }
    clientName = body.clientName;
  }
  if (!Array.isArray(body.documents)) {
    return { ok: false, error: 'documents must be an array.' };
  }
  if (body.documents.length > MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST) {
    return {
      ok: false,
      error: `At most ${MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST} documents per request.`,
    };
  }
  const documents: ParsedDesktopInventoryDocument[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < body.documents.length; index += 1) {
    const candidate: unknown = body.documents[index];
    const parsed = parseDocument(candidate);
    if (!parsed.ok) {
      return { ok: false, error: `documents[${index}]: ${parsed.error}` };
    }
    const identity = `${parsed.document.kind} ${parsed.document.scopeKey}`;
    if (identities.has(identity)) {
      return {
        ok: false,
        error: `documents[${index}]: duplicate kind/scopeKey.`,
      };
    }
    identities.add(identity);
    documents.push(parsed.document);
  }
  const removals: DesktopInventoryRemoval[] = [];
  if (body.removals !== undefined) {
    if (!Array.isArray(body.removals)) {
      return { ok: false, error: 'removals must be an array.' };
    }
    if (body.removals.length > MAX_DESKTOP_INVENTORY_REMOVALS_PER_REQUEST) {
      return {
        ok: false,
        error: `At most ${MAX_DESKTOP_INVENTORY_REMOVALS_PER_REQUEST} removals per request.`,
      };
    }
    for (let index = 0; index < body.removals.length; index += 1) {
      const candidate: unknown = body.removals[index];
      if (
        !isRecord(candidate) ||
        !isDesktopInventoryKind(candidate.kind) ||
        typeof candidate.scopeKey !== 'string' ||
        !isDesktopInventoryScopeKeyValid(candidate.kind, candidate.scopeKey)
      ) {
        return { ok: false, error: `removals[${index}] is invalid.` };
      }
      // One unambiguous operation per identity: a removal may neither repeat
      // nor target a document the same request upserts.
      const identity = `${candidate.kind} ${candidate.scopeKey}`;
      if (identities.has(identity)) {
        return {
          ok: false,
          error: `removals[${index}]: duplicate or conflicting kind/scopeKey.`,
        };
      }
      identities.add(identity);
      removals.push({ kind: candidate.kind, scopeKey: candidate.scopeKey });
    }
  }
  const request: ParsedDesktopInventorySyncRequest = {
    clientDeviceId,
    ...(clientName !== undefined ? { clientName } : {}),
    documents,
    removals,
  };
  return { ok: true, request };
}

function parseDocument(candidate: unknown): DocumentParseResult {
  if (!isRecord(candidate)) {
    return { ok: false, error: 'must be an object.' };
  }
  const kind = candidate.kind;
  if (!isDesktopInventoryKind(kind)) {
    return { ok: false, error: 'unknown kind.' };
  }
  const scopeKey = candidate.scopeKey;
  if (
    typeof scopeKey !== 'string' ||
    !isDesktopInventoryScopeKeyValid(kind, scopeKey)
  ) {
    return { ok: false, error: `scopeKey is invalid for kind "${kind}".` };
  }
  const contentHash = candidate.contentHash;
  if (typeof contentHash !== 'string' || !SHA256_HEX.test(contentHash)) {
    return { ok: false, error: 'contentHash must be lowercase SHA-256 hex.' };
  }
  const capturedAt = candidate.capturedAt;
  if (typeof capturedAt !== 'string' || !isCanonicalIsoTimestamp(capturedAt)) {
    return {
      ok: false,
      error: 'capturedAt must be a canonical ISO-8601 UTC timestamp.',
    };
  }
  const payload = candidate.payload;
  if (!isRecord(payload)) {
    return { ok: false, error: 'payload must be an object.' };
  }
  if (
    utf8ByteLength(JSON.stringify(payload)) >
    MAX_DESKTOP_INVENTORY_DOCUMENT_BYTES
  ) {
    return { ok: false, error: 'payload exceeds the document budget.' };
  }
  return {
    ok: true,
    document: { kind, scopeKey, contentHash, capturedAt, payload },
  };
}
