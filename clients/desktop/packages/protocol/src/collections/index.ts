import { MARKETPLACE_PUBLIC_SHARE_PREFIXES } from '../marketplace';
import type { ResourceOwner } from '../resource-owner';
import { parseShareRemoteMetadata, type ShareRemoteMetadata } from '../sharing';
// ---------------------------------------------------------------------------
// Shared Collection API contracts.
//
// A "Collection" is the user-facing name for what was historically called a
// "Bundle": a named, locally-saved grouping of skill/plugin/MCP references
// that can be applied to a chat or shared through a Canopy Server.
//
// This module defines the wire shapes for:
//   - the Collection document persisted on the server (`SharedCollectionDocument`)
//   - the write-side variant that may embed inline custom-skill drafts
//   - the API request/response DTOs used by the desktop and web clients
//
// It also carries (at the bottom) the neutral local-Collection catalog
// shapes — index entries, item refs, and the full Collection config — shared
// with the web app. File envelopes and the preload `CollectionsAPI` live in
// `packages/desktop-shared/src/types/collections.ts`.
// ---------------------------------------------------------------------------

import type { SharedSkillDetail } from '../skills';
import type {
  ShareableClaudePluginRef,
  ShareableCodexPluginRef,
  ShareableSkillRef,
} from '../plugins';
import type { McpServerRef } from '../mcp-servers';
import type {
  PipelineDistributionMode,
  PipelinePackageRef,
  PipelinePackageSummary,
} from '../pipelines/package';

export const COLLECTION_SHARE_SCOPES = [
  'private',
  'team',
  'organization',
] as const;

export type CollectionShareScope = (typeof COLLECTION_SHARE_SCOPES)[number];

export const COLLECTION_SHARE_PATH_PREFIX =
  MARKETPLACE_PUBLIC_SHARE_PREFIXES.collection;

export function collectionSharePath(externalId: string): string {
  return `${COLLECTION_SHARE_PATH_PREFIX}/${externalId}`;
}

/**
 * Wire version of the shared-Collection API. Bump only on breaking shape
 * changes.
 */
export const SHARED_COLLECTION_API_VERSION = 1;

/**
 * Maximum number of raw bytes accepted by the shared-Collection API. Larger
 * payloads are rejected at the route boundary.
 */
export const MAX_SHARED_COLLECTION_BYTES = 1024 * 1024;

export const MCP_SHARE_BLOCKED_MESSAGE =
  'Collections with MCP server configs cannot be shared. Remove MCP servers before sharing.';

// ---------------------------------------------------------------------------
// Collection item contracts.
//
// A Collection item is one entry inside a Collection document. There are two
// flavours:
//
//   - external — a portable reference to a skill or plugin hosted
//     somewhere outside this Collection (built-in, GitHub, or marketplace).
//
//   - custom_skill — an embedded user-authored skill. On the write side this
//     can be a draft (`SharedCollectionCustomSkillDraftItem`) that references
//     an inline raw payload in the request; on the read side it always
//     resolves to a server-stored shared skill id and hash.
//
// Items can be marked `required: true` to indicate the importer must include
// them; the default is `false` (optional).
// ---------------------------------------------------------------------------

export interface SharedCollectionExternalSkillItem extends ShareableSkillRef {
  required?: boolean;
}

export type SharedCollectionExternalPluginItem = (
  | ShareableClaudePluginRef
  | ShareableCodexPluginRef
) & {
  required?: boolean;
};

/**
 * Write-side draft item carrying an inline custom-skill payload. The
 * `clientKey` matches the key on a `SharedCollectionCustomSkillPayload` so the
 * server can attach the resulting skill id to the persisted document.
 */
export interface SharedCollectionCustomSkillDraftItem {
  type: 'custom_skill';
  clientKey: string;
  skill_name: string;
  required?: boolean;
}

/**
 * Persisted / read-side custom-skill item. Once the server has stored the
 * inline payload it returns this shape, referencing the resulting shared
 * skill id and content hash.
 */
export interface SharedCollectionCustomSkillItem {
  type: 'custom_skill';
  skillId: string;
  skill_name: string;
  contentHash: string;
  required?: boolean;
}

export type SharedCollectionWriteItem =
  | SharedCollectionExternalSkillItem
  | SharedCollectionExternalPluginItem
  | SharedCollectionCustomSkillDraftItem
  | SharedCollectionCustomSkillItem;

export type SharedCollectionItem =
  | SharedCollectionExternalSkillItem
  | SharedCollectionExternalPluginItem
  | SharedCollectionCustomSkillItem;

/**
 * Document submitted by a client when creating/updating a shared Collection.
 * Drafts of inline custom skills are allowed; the server resolves them into
 * `SharedCollectionCustomSkillItem` entries on persist.
 */
export interface SharedCollectionWriteDocument {
  version: 1;
  name: string;
  description?: string;
  items: SharedCollectionWriteItem[];
}

/**
 * Document returned by the server when reading a shared Collection. All
 * inline drafts have been resolved.
 */
export interface SharedCollectionDocument {
  version: 1;
  name: string;
  description: string;
  items: SharedCollectionItem[];
}

/**
 * Inline payload for a single custom skill embedded in a write request. The
 * `clientKey` matches the draft item's `clientKey` so the server can pair
 * payloads to items.
 */
export interface SharedCollectionCustomSkillPayload {
  clientKey: string;
  name: string;
  rawSkill: string;
}

// ---------------------------------------------------------------------------
// Owner / DTO shapes.
// ---------------------------------------------------------------------------

export type CollectionShareOwner = ResourceOwner;

export interface CollectionShareActor {
  id: string;
  name: string | null;
  email: string | null;
}

export interface SharedCollectionItemCounts {
  skills: number;
  plugins: number;
  customSkills: number;
}

export interface SharedCollectionSummary {
  id: string;
  name: string;
  description: string;
  /** Stable SHA-256 hash of the canonical raw Collection document. */
  contentHash: string;
  itemCounts: SharedCollectionItemCounts;
  shareScope: CollectionShareScope;
  owner: CollectionShareOwner;
  createdBy: CollectionShareActor;
  createdAt: string;
  updatedAt: string;
  canUpdate: boolean;
  canDelete: boolean;
  publicShare?: SharedCollectionPublicShareInfo | null;
}

export interface SharedCollectionPublicShareInfo {
  externalId: string;
  pinnedContentHash: string;
  upToDate: boolean;
  sharePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishSharedCollectionPublicShareResponse {
  publicShare: SharedCollectionPublicShareInfo;
}

export interface SharedCollectionDetail extends SharedCollectionSummary {
  /** Raw Collection document bytes as the client posted them. */
  rawCollection: string;
  /** Parsed and validated Collection document. */
  collection: SharedCollectionDocument;
  /** Resolved inline custom skills referenced by `collection.items`. */
  customSkills: SharedSkillDetail[];
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
}

// ---------------------------------------------------------------------------
// Request DTOs.
// ---------------------------------------------------------------------------

export interface ListSharedCollectionsRequest {
  serverId: string;
  limit?: number;
  cursor?: string;
  query?: string;
  createdBy?: 'me' | 'anyone';
}

export interface ListSharedCollectionsResponse {
  collections: SharedCollectionSummary[];
  nextCursor?: string;
}

export interface CreateSharedCollectionRequest {
  serverId: string;
  /** Raw Collection document bytes; the server validates structure. */
  rawCollection: string;
  customSkills?: SharedCollectionCustomSkillPayload[];
  shareScope?: CollectionShareScope;
  teamId?: string;
  organizationId?: string;
  capabilityPackage?: PipelinePackageRef | null;
  committedPackageUploadId?: string;
}

export interface UpdateSharedCollectionRequest {
  serverId: string;
  collectionId: string;
  rawCollection: string;
  customSkills?: SharedCollectionCustomSkillPayload[];
  expectedContentHash?: string;
  shareScope?: CollectionShareScope;
  teamId?: string;
  organizationId?: string;
  capabilityPackage?: PipelinePackageRef | null;
  committedPackageUploadId?: string;
}

/** Preserve the exact submitted bytes used by the Collection content hash. */
export function serializeSharedCollectionForHash(
  rawCollection: string,
): string {
  return rawCollection;
}

export interface DeleteSharedCollectionRequest {
  serverId: string;
  collectionId: string;
}

// ---------------------------------------------------------------------------
// Validation helpers.
//
// These helpers are intentionally narrow: they validate structure only (no
// network IO, no filesystem) and throw on the first malformed field. The
// server uses them to reject bad documents; the desktop client uses them to
// catch issues before the IPC round-trip.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureString(field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Collection document field "${field}" must be a string`);
  }
  return value;
}

function ensureOptionalBoolean(
  field: string,
  value: unknown,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(
      `Collection document field "${field}" must be boolean when provided`,
    );
  }
  return value;
}

/**
 * Validate the structure of a parsed `SharedCollectionDocument`. Throws on
 * unknown versions, missing required fields, or malformed item shapes.
 *
 * This does NOT validate plugin-ref well-formedness (use
 * `normalizeShareablePluginRef` from `@canopy/protocol` for that); it only
 * confirms that the top-level envelope and item discriminators are sane.
 */
export function validateSharedCollectionDocument(
  raw: unknown,
): SharedCollectionDocument {
  if (!isRecord(raw)) {
    throw new Error('Collection document must be an object');
  }
  if (raw.version !== 1) {
    throw new Error(
      `Unsupported Collection document version: ${String(raw.version)}`,
    );
  }
  const name = ensureString('name', raw.name);
  const description = ensureString('description', raw.description);
  if (!Array.isArray(raw.items)) {
    throw new Error('Collection document field "items" must be an array');
  }
  const items: SharedCollectionItem[] = [];
  const rawItems = raw.items as readonly unknown[];
  for (let i = 0; i < rawItems.length; i += 1) {
    const item: unknown = rawItems[i];
    if (!isRecord(item)) {
      throw new Error(`Collection item #${i} must be an object`);
    }
    const required = ensureOptionalBoolean(
      `items[${i}].required`,
      item.required,
    );
    switch (item.type) {
      case 'skill': {
        if (!isRecord(item.source)) {
          throw new Error(`Collection item #${i} must have a source object`);
        }
        const skill_name = ensureString(
          `items[${i}].skill_name`,
          item.skill_name,
        );
        const sourceType = item.source.type;
        if (sourceType === 'builtin') {
          items.push({
            type: 'skill',
            source: {
              type: 'builtin',
              id: ensureString(`items[${i}].source.id`, item.source.id),
            },
            skill_name,
            ...(required !== undefined ? { required } : {}),
          });
        } else if (sourceType === 'github') {
          items.push({
            type: 'skill',
            source: {
              type: 'github',
              repo: ensureString(`items[${i}].source.repo`, item.source.repo),
            },
            skill_name,
            ...(required !== undefined ? { required } : {}),
          });
        } else {
          throw new Error(
            `Collection item #${i} has unknown source type: ${String(sourceType)}`,
          );
        }
        break;
      }
      case 'claude_plugin': {
        if (!isRecord(item.marketplace)) {
          throw new Error(
            `Collection item #${i} claude_plugin must reference a marketplace`,
          );
        }
        const marketplaceType = item.marketplace.type;
        const plugin_name = ensureString(
          `items[${i}].plugin_name`,
          item.plugin_name,
        );
        if (marketplaceType === 'github') {
          items.push({
            type: 'claude_plugin',
            marketplace: {
              type: 'github',
              repo: ensureString(
                `items[${i}].marketplace.repo`,
                item.marketplace.repo,
              ),
            },
            plugin_name,
            ...(required !== undefined ? { required } : {}),
          });
        } else if (marketplaceType === 'builtin') {
          items.push({
            type: 'claude_plugin',
            marketplace: {
              type: 'builtin',
              id: ensureString(
                `items[${i}].marketplace.id`,
                item.marketplace.id,
              ),
            },
            plugin_name,
            ...(required !== undefined ? { required } : {}),
          });
        } else {
          throw new Error(
            `Collection item #${i} claude_plugin has unknown marketplace type: ${String(marketplaceType)}`,
          );
        }
        break;
      }
      case 'codex_plugin': {
        if (!isRecord(item.marketplace)) {
          throw new Error(
            `Collection item #${i} codex_plugin must reference a marketplace`,
          );
        }
        const marketplaceType = item.marketplace.type;
        const plugin_name = ensureString(
          `items[${i}].plugin_name`,
          item.plugin_name,
        );
        if (marketplaceType === 'codex-builtin') {
          items.push({
            type: 'codex_plugin',
            marketplace: {
              type: 'codex-builtin',
              id: ensureString(
                `items[${i}].marketplace.id`,
                item.marketplace.id,
              ),
            },
            plugin_name,
            ...(required !== undefined ? { required } : {}),
          });
        } else {
          throw new Error(
            `Collection item #${i} codex_plugin has unknown marketplace type: ${String(marketplaceType)}`,
          );
        }
        break;
      }
      case 'custom_skill': {
        const skill_name = ensureString(
          `items[${i}].skill_name`,
          item.skill_name,
        );
        if (typeof item.skillId !== 'string' || item.skillId.length === 0) {
          throw new Error(
            `Collection item #${i} custom_skill must include a non-empty skillId`,
          );
        }
        if (
          typeof item.contentHash !== 'string' ||
          item.contentHash.length === 0
        ) {
          throw new Error(
            `Collection item #${i} custom_skill must include a non-empty contentHash`,
          );
        }
        items.push({
          type: 'custom_skill',
          skillId: item.skillId,
          contentHash: item.contentHash,
          skill_name,
          ...(required !== undefined ? { required } : {}),
        });
        break;
      }
      default:
        throw new Error(
          `Collection item #${i} has unknown type: ${String(item.type)}`,
        );
    }
  }
  return { version: 1, name, description, items };
}

// ---------------------------------------------------------------------------
// Neutral local-Collection catalog shapes.
//
// Browser-safe read/display contracts for locally saved Collections, hoisted
// from `packages/desktop-shared/src/types/collections.ts` (which re-exports
// them). These local refs address items by *installed identity*
// (`sourceId`/`marketplaceId` + name) and are distinct from the portable
// `ShareableSkillRef` / `ShareableClaudePluginRef` wire refs above, which
// address items by shareable source. File envelopes and the preload
// `CollectionsAPI` intentionally stay in desktop-shared.
// ---------------------------------------------------------------------------

/** Reference to an installed skill inside a Collection. */
export interface CollectionSkillRef {
  sourceId: string;
  skillName: string;
}

/** Reference to a marketplace plugin inside a Collection. */
export interface CollectionPluginRef {
  marketplaceId: string;
  pluginName: string;
}

/** Reference to an MCP server configuration inside a Collection. */
export type CollectionMcpRef = McpServerRef;

/** Index projection of CollectionConfig.sharedSource; never carries fetchedAt. */
export interface CollectionIndexSharedSource {
  remoteId: string;
  /** The share's content hash when this copy was added; absent on older scoped installs. */
  contentHash?: string;
  fromPublicShare?: boolean;
}

/** Sanitize optional provenance independently from the usable local row. */
export function parseCollectionIndexSharedSource(
  value: unknown,
): CollectionIndexSharedSource | undefined {
  if (
    !isRecord(value) ||
    typeof value.remoteId !== 'string' ||
    !value.remoteId.trim()
  )
    return undefined;
  return {
    remoteId: value.remoteId,
    ...(typeof value.contentHash === 'string' && value.contentHash.trim()
      ? { contentHash: value.contentHash }
      : {}),
    ...(typeof value.fromPublicShare === 'boolean'
      ? { fromPublicShare: value.fromPublicShare }
      : {}),
  };
}

/**
 * Summary entry stored in collections/index.json (sufficient for table
 * display).
 */
export interface CollectionIndexEntry {
  id: string;
  name: string;
  description: string;
  /**
   * When this local copy was first saved, in UTC (CAN-5239). Edits keep it;
   * absent on older entries and whenever the stored value is not a valid date.
   */
  createdAt?: string;
  updatedAt: string;
  /** Opaque local snapshot revision, absent on older hosts. */
  revision?: string;
  skillCount: number;
  pluginCount: number;
  mcpServerCount: number;
  /** True when the local Collection is bound to a current Cloud share. */
  hasExistingShare?: boolean;
  /** Author-side link to the Collection's current Cloud share. */
  remote?: ShareRemoteMetadata;
  /** Set when the Collection was added from a Cloud share. */
  sharedSource?: CollectionIndexSharedSource;
  /** Provenance existed even if an older/malformed projection cannot be read. Never infer created ownership. */
  hasSharedSource?: boolean;
  /** An unreadable legacy config could not establish local/shared ownership. */
  provenanceUnknown?: boolean;
}

/**
 * Full Collection configuration stored in
 * `collections/collection-<id>.json`.
 */
export interface CollectionConfig {
  /** Opaque local store revision. Echo when replacing an existing snapshot. */
  revision?: string;
  id: string;
  name: string;
  description: string;
  skills: CollectionSkillRef[];
  plugins: CollectionPluginRef[];
  mcpServers: CollectionMcpRef[];
  /**
   * First save of this local copy (CAN-5239). Absent when unknown: older
   * configs have none and a save never invents one.
   */
  createdAt?: string;
  updatedAt: string;
  /** Author-side link to this Collection's current cloud share. */
  remote?: ShareRemoteMetadata;
  /**
   * Provenance for Collections imported from Canopy Cloud. Legacy persisted
   * files may still include a `serverId`, but new singleton Cloud imports only
   * write the remote id and fetch timestamp.
   */
  sharedSource?: {
    remoteId: string;
    fetchedAt: string;
    /** Omitted on legacy/scoped imports. Public ids use the anonymous snapshot endpoint. */
    fromPublicShare?: boolean;
    /** The snapshot verified immediately before installing a Public collection. */
    contentHash?: string;
  };
}

export interface DuplicateLocalCollectionRequest {
  collectionId: string;
}

export interface ApplyCollectionUpdateRequest {
  collectionId: string;
  expectedRevision: string;
}

export interface ApplyCollectionUpdateResult {
  collection: CollectionConfig;
  /** Legacy documents do not represent MCP membership. */
  preservedLegacyMcpRefs: boolean;
  /** Package resources outside represented collection membership were not installed. */
  uninstalledResourceLabels?: string[];
  /** Existing local supporting files retained by the established importer. */
  keptLocalFiles?: string[];
}

/** Narrow, validated detail used for collection membership comparisons. */
export type SharedCollectionComparisonDetail = Pick<
  SharedCollectionDetail,
  'id' | 'contentHash' | 'collection'
>;

/** Structural validation of a complete local snapshot, including claimed metadata. */
export function isLocalCollectionConfig(
  value: unknown,
): value is CollectionConfig {
  const text = (field: unknown): field is string =>
    typeof field === 'string' && field.trim().length > 0;
  if (
    !isRecord(value) ||
    !text(value.id) ||
    !text(value.name) ||
    typeof value.description !== 'string' ||
    // CAN-5239: an unknown installed-copy date is absent, not incomplete.
    (value.createdAt !== undefined && !text(value.createdAt)) ||
    !text(value.updatedAt) ||
    (value.revision !== undefined && !text(value.revision)) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.plugins) ||
    !Array.isArray(value.mcpServers)
  )
    return false;
  if (
    !value.skills.every(
      (ref: unknown) =>
        isRecord(ref) && text(ref.sourceId) && text(ref.skillName),
    ) ||
    !value.plugins.every(
      (ref: unknown) =>
        isRecord(ref) && text(ref.marketplaceId) && text(ref.pluginName),
    ) ||
    !value.mcpServers.every(
      (ref: unknown) =>
        isRecord(ref) && text(ref.serverId) && text(ref.configId),
    )
  )
    return false;
  if (value.remote !== undefined && !parseShareRemoteMetadata(value.remote))
    return false;
  if (value.sharedSource !== undefined) {
    const source = value.sharedSource;
    if (
      !isRecord(source) ||
      !text(source.remoteId) ||
      !text(source.fetchedAt) ||
      (source.contentHash !== undefined && !text(source.contentHash)) ||
      (source.fromPublicShare !== undefined &&
        typeof source.fromPublicShare !== 'boolean')
    )
      return false;
  }
  return true;
}
