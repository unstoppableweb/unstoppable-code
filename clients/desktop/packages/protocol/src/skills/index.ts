import { MARKETPLACE_PUBLIC_SHARE_PREFIXES } from '../marketplace';
import type { ResourceOwner } from '../resource-owner';
import type { WorkspaceContext } from '../workspace-context';
import type { PublicShareVersion, ShareRemoteMetadata } from '../sharing';
// ---------------------------------------------------------------------------
// Shared custom-skill API contracts.
//
// These wire shapes are consumed by:
//   - The web Canopy Server route handlers for shared custom skills.
//   - The desktop main process when proxying skill share/import operations
//     through a configured Canopy Server.
//   - The desktop renderer (via the `window.skills` preload bridge) for
//     listing/searching/importing shared skills authored by other users.
//
// The shapes here are the canonical request/response payloads, plus (at the
// bottom of this module) the neutral local-skill catalog read shapes shared
// with the web app: installed/available skill rows, risk info, content
// responses, and update progress. Local-only concerns (filesystem paths, lock
// files, frontmatter parsing, custom-skill authoring requests, the preload
// `SkillsAPI`) live in `packages/desktop-shared/src/types/skills.ts`.
// ---------------------------------------------------------------------------

import type { ShareablePluginSource } from '../plugins';
import type {
  PipelineDistributionMode,
  PipelinePackageRef,
  PipelinePackageSummary,
} from '../pipelines/package';

/**
 * Visibility scope for a shared custom skill. The scope is decided at create
 * time and is mutable later only by changing the share scope explicitly.
 *
 * - `private` — visible to the author only.
 * - `team`    — visible to every member of the owning team.
 * - `organization` — visible to every member of the owning organization.
 */
export const SKILL_SHARE_SCOPES = ['private', 'team', 'organization'] as const;

export type SkillShareScope = (typeof SKILL_SHARE_SCOPES)[number];

/**
 * Wire version of the shared-skill API. Bump only on breaking shape changes.
 */
export const SHARED_SKILL_API_VERSION = 1;

/**
 * Maximum number of raw bytes accepted by the shared-skill API. Larger
 * payloads are rejected at the route boundary so the renderer / main process
 * never round-trip excessively large skills.
 */
export const MAX_SHARED_SKILL_BYTES = 1024 * 1024;

/**
 * Canonical public path prefix for a shared custom skill.
 *
 * Was `/s/skills`. Renamed for CAN-2232: the `unstoppable.ai` apex moves to
 * Canopy web, and the e-commerce storefront serves `/s/*` (site search) there,
 * so Canopy cedes that segment. `apps/web/next.config.ts` keeps a permanent
 * `redirects()` entry from the old shape — share links are capability URLs
 * already distributed out-of-band with no server-side inventory, so they can
 * never be rewritten at the source.
 *
 * Anything that needs this path must DERIVE it from here. Desktop consumes the
 * server-provided `sharePath` opaquely and never constructs it, so old
 * installed builds keep working for newly minted links.
 */
export const SKILL_SHARE_PATH_PREFIX = MARKETPLACE_PUBLIC_SHARE_PREFIXES.skill;

/**
 * The pre-CAN-2232 prefix. Still load-bearing, in three places:
 *
 * 1. `apps/web/next.config.ts` permanently redirects it to
 *    {@link SKILL_SHARE_PATH_PREFIX} (asserted against this constant by
 *    `apps/web/src/__tests__/next-config-redirects.test.ts`, since config files
 *    cannot import workspace packages).
 * 2. `apps/web/src/proxy.ts` keeps it anonymous-allowed, so a legacy share link
 *    is never bounced to /login regardless of whether the config redirect runs
 *    first.
 * 3. `apps/web/src/lib/storefront-redirect.ts` keeps it Canopy-claimed, so the
 *    apex storefront fallback does not swallow it into the storefront's
 *    `/s/*` site search.
 */
export const LEGACY_SKILL_SHARE_PATH_PREFIX = '/s/skills';

export function skillSharePath(skillExternalId: string): string {
  return `${SKILL_SHARE_PATH_PREFIX}/${skillExternalId}`;
}

// ---------------------------------------------------------------------------
// Owner / actor metadata.
// ---------------------------------------------------------------------------

export type SkillShareOwner = ResourceOwner;

export interface SkillShareActor {
  id: string;
  name: string | null;
  email: string | null;
}

// ---------------------------------------------------------------------------
// Response DTOs.
// ---------------------------------------------------------------------------

export interface SharedSkillPublicShareInfo {
  externalId: string;
  pinnedContentHash: string;
  upToDate: boolean;
  sharePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface SharedSkillSavedFromInfo {
  id: string;
  name: string | null;
  createdByName: string | null;
}

export interface SharedSkillSummary {
  id: string;
  name: string;
  description: string;
  /**
   * Stable content hash of the raw SKILL.md bytes, computed by the server
   * before storage. Used by clients to detect remote changes.
   */
  contentHash: string;
  shareScope: SkillShareScope;
  owner: SkillShareOwner;
  createdBy: SkillShareActor;
  createdAt: string;
  updatedAt: string;
  canUpdate: boolean;
  canDelete: boolean;
  publicShare: SharedSkillPublicShareInfo | null;
  savedFrom?: SharedSkillSavedFromInfo | null;
}

export interface SharedSkillDetail extends SharedSkillSummary {
  /**
   * Raw SKILL.md content as a UTF-8 string, untouched by the server. Clients
   * must persist this verbatim when importing.
   */
  rawSkill: string;
  /**
   * How much of the skill travels. `definition_only` is the original shape and
   * stays permanently supported: every share published before packaging
   * existed reads as one, and a recipient on an older build is served one.
   */
  distributionMode?: PipelineDistributionMode;
  /**
   * Capability package published alongside this skill, when one exists.
   *
   * Deliberately NOT part of the skill content: the server hashes `rawSkill`
   * verbatim and that hash has to round-trip, so the package is linked beside
   * the row rather than embedded in it.
   */
  package?: PipelinePackageSummary;
}

// ---------------------------------------------------------------------------
// Request DTOs.
// ---------------------------------------------------------------------------

export interface ListSharedSkillsRequest {
  serverId: string;
  limit?: number;
  cursor?: string;
  query?: string;
  createdBy?: 'me' | 'anyone';
}

export interface ListSharedSkillsResponse {
  skills: SharedSkillSummary[];
  nextCursor?: string;
}

export interface CreateSharedSkillRequest {
  serverId: string;
  /**
   * Raw SKILL.md content. The server hashes and persists this verbatim — it
   * must not be re-serialized or pre-parsed by clients.
   */
  rawSkill: string;
  shareScope?: SkillShareScope;
  teamId?: string;
  organizationId?: string;
  /** Package to link beside this skill. See {@link SharedSkillDetail.package}. */
  capabilityPackage?: PipelinePackageRef;
  /** Committed capability-package upload that authorizes the link. */
  committedPackageUploadId?: string;
}

export interface UpdateSharedSkillRequest {
  serverId: string;
  skillId: string;
  rawSkill: string;
  expectedContentHash?: string;
  shareScope?: SkillShareScope;
  teamId?: string;
  organizationId?: string;
  capabilityPackage?: PipelinePackageRef;
  committedPackageUploadId?: string;
  /** Keep the current package pin when this client cannot analyze packages. */
  preservePackage?: boolean;
  revokePublicShare?: PublicShareVersion;
  /**
   * Who the caller was told sees the copy. The cloud checks it under the
   * skill's row lock and answers 409 `audience_changed` when it differs;
   * omitted, the update keeps its old behaviour.
   */
  expectedAudience?: 'private' | 'public_link' | 'team' | 'organization';
}

export interface DeleteSharedSkillRequest {
  serverId: string;
  skillId: string;
}

export interface PublishSharedSkillPublicShareRequest {
  serverId: string;
  skillId: string;
}

export interface RevokeSharedSkillPublicShareRequest {
  serverId: string;
  skillId: string;
}

export interface PublishSharedSkillPublicShareResponse {
  publicShare: SharedSkillPublicShareInfo;
}

// ---------------------------------------------------------------------------
// Neutral local-skill catalog shapes.
//
// Browser-safe read/display contracts for the locally installed skill catalog,
// hoisted from `packages/desktop-shared/src/types/skills.ts` (which re-exports
// them). Filesystem-facing concerns (source metadata, lock files, authoring
// requests, the preload API) intentionally stay in desktop-shared.
// ---------------------------------------------------------------------------

// ---- Risk Assessment ----

export type SkillRiskLevel =
  | 'safe'
  | 'low'
  | 'medium'
  | 'high'
  | 'critical'
  | 'unknown';

export interface SkillRiskInfo {
  level: SkillRiskLevel;
  socketAlerts: number | null;
}

// ---- Available Skills (from a remote source, not yet installed) ----

export interface AvailableSkill {
  name: string;
  description: string;
  /** Relative path within the repo where SKILL.md was found */
  sourcePath: string;
}

// ---- Installed Skill Info (for renderer display) ----

export interface InstalledSkillInfo {
  name: string;
  sourceId: string;
  description: string;
  source: string;
  installedAt: string;
  updatedAt: string;
  updateAvailable: boolean;
  builtIn?: boolean;
  /** User-authored skill stored under the custom Canopy source. */
  custom?: boolean;
  /**
   * Portable source metadata used to serialize/match this skill against
   * shareable refs (e.g. in pipeline `plugin_collections` defaults and
   * `canopy.json` hook chat `plugins`). Undefined when the skill's source is
   * not portable (e.g. a local directory install).
   *
   * This is display/matching metadata only — it is never persisted into the
   * skill lock format.
   */
  shareableSource?: ShareablePluginSource;
  /** Author-side link to this local skill's current cloud share. */
  remote?: ShareRemoteMetadata;
  /**
   * Recipient-side origin: the authenticated share this custom skill was
   * installed from, read from its install receipt. Present only when
   * resource context enforcement is on.
   */
  installedFromShare?: SharedSkillInstallOrigin;
}

export interface SharedSkillInstallOrigin {
  /** The shared skill's id. */
  remoteId: string;
  /** Digest of the share's supporting-file package, once it installed. */
  packageDigest?: string;
  /** A durable update marker still needs a fresh review/reconciliation, even if hashes match. */
  replacementPending?: boolean;
  /**
   * Receipt-backed display metadata, never authorization. Optional for older
   * producers: legacy origins retain source navigation but cannot compare hashes.
   */
  shareScope?: SkillShareScope;
  ownerContext?: WorkspaceContext;
  /**
   * SHA-256 of the installed source's raw SKILL.md, not locally edited bytes.
   * Omitted when a legacy receipt's multiple aliases make that baseline ambiguous.
   */
  contentHash?: string;
  authorizedAt?: string;
  sharedByName?: string;
  /** Organization name, including the organization owning a team share. */
  ownerName?: string;
  teamName?: string;
}

// ---- Skill Content (for detail modal) ----

export interface SkillContentResponse {
  /** All frontmatter key-value pairs */
  frontmatter: Record<string, unknown>;
  /** Markdown body after the frontmatter block */
  body: string;
}

// ---- Catalog read payloads ----

export interface FetchAvailableSkillsResponse {
  source: string;
  skills: AvailableSkill[];
  riskInfo: Record<string, SkillRiskInfo>;
  hasMarketplace: boolean;
}

export type SkillUpdateProgressStatus = 'running' | 'complete' | 'error';

export interface SkillUpdateProgress {
  operation: 'check-updates';
  status: SkillUpdateProgressStatus;
  message: string;
  updateMap?: Record<string, boolean>;
}

export {
  extractSkillDependencies,
  parseStoredSkillDependencies,
  skillDependenciesToEnvironmentRequirements,
  type SkillDependency,
  type SkillDependencyExtractionOptions,
  type SkillDependencyKind,
} from './dependencies';
