import type {
  FetchAvailableSkillsResponse,
  InstalledSkillInfo,
  ListSharedSkillsResponse,
  SharedSkillDetail,
  SharedSkillPublicShareInfo,
  SkillContentResponse,
  SkillShareScope,
  SkillUpdateProgress,
} from '@canopy/protocol/skills';
import type { PipelinePackageRef } from '@canopy/protocol/pipelines';
import type {
  PublicShareVersion,
  ShareOperationResult,
} from '@canopy/protocol/sharing';
import type { PublisherSkillSummary } from '@canopy/protocol';

import type {
  IPCResult,
  PipelinePackageAnalysisSummary,
  PipelinePackageInvocationDismissal,
  PipelinePackageReadiness,
} from '@canopy/execution-engine/types/pipeline';

/** A published listing plus this device's existing, context-visible install. */
export interface DesktopPublisherSkill extends PublisherSkillSummary {
  installedSkillName?: string;
  installedPackageDigest?: string;
}

/** Authorized source plus receipt identity, independent of readable inventory rows. */
export interface DesktopSharedSkillDetail extends SharedSkillDetail {
  /**
   * Present under scoped enforcement. Empty means a successful lookup found
   * no receipt; nonempty IDs may name missing files and require recovery.
   * Missing means receipt-aware detection is unsupported on this receiver.
   */
  installedCopyIds?: string[];
}

// Re-export the shared-skill wire shapes so renderer modules can import them
// from `@canopy/desktop-shared/types/skills` rather than reaching directly
// into the protocol package.
//
// NOTE: the request shapes (`ListSharedSkillsRequest`,
// `CreateSharedSkillRequest`, `UpdateSharedSkillRequest`,
// `DeleteSharedSkillRequest`) are redeclared locally below WITHOUT
// `serverId`. The desktop app is bound to a single Canopy Cloud backend so
// the local IPC layer must not carry server identity. The wire-side
// `serverId`-carrying types in `@canopy/protocol/skills` are unchanged and
// still describe the contract between desktop and Canopy Cloud (and `apps/web`).
//
// The neutral local-skill catalog shapes (`InstalledSkillInfo`,
// `AvailableSkill`, risk info, content/progress responses) also live in
// `@canopy/protocol/skills` and are re-exported here unchanged — do NOT
// redefine them locally. Only filesystem-facing concerns (source metadata,
// lock files, custom-skill authoring, the preload `SkillsAPI`) are declared
// in this file.
export type {
  AvailableSkill,
  FetchAvailableSkillsResponse,
  InstalledSkillInfo,
  ListSharedSkillsResponse,
  SharedSkillDetail,
  SharedSkillPublicShareInfo,
  SharedSkillSummary,
  SkillContentResponse,
  SkillRiskInfo,
  SkillRiskLevel,
  SkillShareOwner,
  SkillShareScope,
  SkillUpdateProgress,
  SkillUpdateProgressStatus,
} from '@canopy/protocol/skills';

/**
 * Desktop-local request to list shared skills from the configured Canopy
 * Cloud backend.
 */
export interface ListSharedSkillsRequest {
  limit?: number;
  cursor?: string;
  query?: string;
  createdBy?: 'me' | 'anyone';
}

/**
 * Desktop-local request to create a shared skill on the configured Canopy
 * Cloud backend.
 */
export interface CreateSharedSkillRequest {
  sourceSkillId?: string;
  /**
   * Raw SKILL.md content. The server hashes and persists this verbatim — it
   * must not be re-serialized or pre-parsed by clients.
   */
  rawSkill: string;
  shareScope?: SkillShareScope;
  teamId?: string;
  organizationId?: string;
  /**
   * Capability package published alongside this skill. Linked beside the row
   * rather than embedded, because the server hashes `rawSkill` verbatim and
   * that hash has to round-trip.
   */
  capabilityPackage?: PipelinePackageRef;
  /** Committed capability-package upload that authorizes the link. */
  committedPackageUploadId?: string;
  /**
   * SHA-256 hex of the SKILL.md the caller checked. The bytes sent must match
   * it, so a file edited after the check never uploads (CAN-6176).
   */
  expectedSourceSha256?: string;
}

/**
 * Desktop-local request to update a shared skill on the configured Canopy
 * Cloud backend.
 */
export interface UpdateSharedSkillRequest {
  /** Local source required when resource-context enforcement is enabled. */
  sourceSkillId?: string;
  skillId: string;
  rawSkill: string;
  expectedContentHash?: string;
  shareScope?: SkillShareScope;
  teamId?: string;
  organizationId?: string;
  capabilityPackage?: PipelinePackageRef;
  committedPackageUploadId?: string;
  preservePackage?: boolean;
  revokePublicShare?: PublicShareVersion;
  /** As on {@link CreateSharedSkillRequest}. */
  expectedSourceSha256?: string;
  /**
   * Who the person was told sees the copy; the cloud refuses the update
   * (409 `audience_changed`) when that is no longer so.
   */
  expectedAudience?: 'private' | 'public_link' | 'team' | 'organization';
}

/**
 * Desktop-local request to delete a shared skill on the configured Canopy
 * Cloud backend.
 */
export interface DeleteSharedSkillRequest {
  skillId: string;
}

export {
  MAX_SHARED_SKILL_BYTES,
  SHARED_SKILL_API_VERSION,
  SKILL_SHARE_SCOPES,
} from '@canopy/protocol/skills';

// ---- Source Metadata (source.json per source directory) ----

export interface SourceMetadata {
  type: string;
  sourceId: string;
  url: string;
  owner?: string;
  repo?: string;
}

// ---- Lock File (version tracking) ----

export interface SkillLockEntry {
  sourceId: string;
  source: string;
  sourceType: 'github' | 'local' | 'url';
  sourceUrl: string;
  /** Relative path in repo where SKILL.md was found */
  skillPath: string;
  /** GitHub tree SHA at time of install */
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
}

export interface SkillLockFile {
  version: 1 | 2;
  skills: Record<string, SkillLockEntry>;
}

// ---- Custom skill authoring ----

/**
 * One supporting file of a multi-file skill, addressed by its POSIX-style
 * path relative to the skill directory (e.g. `references/api.md`).
 */
export interface SkillEditableFile {
  path: string;
  /**
   * File content to write. When omitted the existing file at `path` is kept
   * as-is (used for binary/oversized files the editor cannot round-trip).
   */
  content?: string;
}

export interface SaveCustomSkillRequest {
  /** Sanitized identifier (kebab-case). Used as directory name. */
  name: string;
  /** One-line skill description for the frontmatter and skill list. */
  description: string;
  /** Markdown body (what follows the frontmatter block). */
  body: string;
  /** If provided and different from `name`, the existing directory is renamed. */
  originalName?: string;
  /**
   * Additional frontmatter key/value pairs to emit alongside name+description.
   * Keys must be non-empty and contain no whitespace; reserved keys
   * (`name`, `description`) are ignored. Empty values are dropped.
   */
  extraMetadata?: Record<string, string>;
  /**
   * Original JSON-safe YAML values retained by the custom-skill editor for
   * metadata rows the user did not change. This keeps booleans, numbers,
   * arrays, and nested objects typed across the renderer/main IPC boundary.
   */
  preservedMetadata?: Record<string, unknown>;
  /**
   * Full desired set of supporting files beside SKILL.md. When present the
   * skill directory is synced to exactly this set: listed files are written
   * and any other existing files (except SKILL.md) are deleted. When absent
   * (legacy callers, share/import flows) supporting files are left untouched.
   */
  files?: SkillEditableFile[];
}

// ---- Skill files (multi-file skills) ----

export interface SkillFilesResponse {
  /**
   * POSIX-style paths relative to the skill directory. `SKILL.md` is always
   * first when present; the rest are sorted alphabetically.
   */
  files: string[];
  /**
   * True when traversal stopped at a safety limit and `files` is therefore
   * only a preview, not an authoritative snapshot for destructive syncing.
   */
  truncated: boolean;
}

export interface SkillFileContentResponse {
  /** UTF-8 file content. Empty when `binary` is true. */
  content: string;
  /** True when the file exceeded the read limit and was cut off. */
  truncated: boolean;
  /** True when the file looks binary and content was not returned. */
  binary: boolean;
}

// ---- API Interface (used by preload) ----

/**
 * The public share a Marketplace or share-link import came from. A public
 * share has no owning team or organization, so with resource-context
 * enforcement on, main re-reads the share by this id to verify the origin
 * itself and refuses to install when its content no longer matches the hash
 * the recipient reviewed.
 */
export interface PublicShareSkillOrigin {
  externalId: string;
  contentHash: string;
  /**
   * Set for a custom skill pinned inside a Public collection. Such a skill has
   * no standalone share, so main re-reads this collection snapshot and takes
   * the skill's bytes from it; `externalId` is then the pinned skill's id.
   */
  collection?: { externalId: string; contentHash: string };
}

export interface WriteRawSkillRequest {
  /**
   * Requested local name. With resource-context enforcement on and a
   * `sourceRemoteId` or `publicShare` present, main resolves the name itself
   * from the source it re-reads, and the returned `skillName` is the one to
   * use; this value is then advisory.
   */
  skillName: string;
  rawSkill: string;
  /** Owned (team, organization, or private) skill the bytes were read from. */
  sourceRemoteId?: string;
  /** Public share the bytes were read from; ignored when `sourceRemoteId` is set. */
  publicShare?: PublicShareSkillOrigin;
  /**
   * The skill is a member of a team or organization collection being
   * imported. Its update emails come through the collection's subscription,
   * so the skill registers none of its own.
   */
  inCollection?: boolean;
  /** Explicit, reviewed replacement of one scoped, receipted custom copy. */
  replaceInstalled?: {
    skillName: string;
    /** Required SHA-256 of the exact local bytes reviewed, including local edits. */
    expectedLocalContentHash: string;
    /** Required SHA-256 of the authorized source bytes reviewed. */
    expectedSourceContentHash: string;
    /** Exact reviewed package digest. Omission means the source has NO package. */
    expectedSourcePackageDigest?: string;
  };
}

/** Stable reasons carried in rejected IPC error messages as `(reason)`. */
export type SkillWriteFailureCode =
  | 'replacement-unsupported'
  | 'invalid-replacement'
  | 'review-required'
  | 'missing-copy'
  | 'local-conflict'
  | 'source-conflict'
  | 'recovery-required';

export interface WriteRawSkillResult {
  skillId: string;
  skillName: string;
  /** Bytes and receipt committed; retry subscription bookkeeping without reinstalling. */
  subscriptionWarning?: 'subscription-update-failed';
}

export interface RecordSkillShareOriginRequest {
  localId: string;
  originExternalId: string;
  contentHash: string;
}

export interface SkillsAPI {
  listMarketplace(): Promise<DesktopPublisherSkill[]>;
  loadSkills(): Promise<IPCResult<InstalledSkillInfo[]>>;
  fetchAvailable(
    source: string,
  ): Promise<IPCResult<FetchAvailableSkillsResponse>>;
  installSkills(source: string, skillNames: string[]): Promise<IPCResult<void>>;
  removeSkill(sourceId: string, skillName: string): Promise<IPCResult<void>>;
  updateSkill(sourceId: string, skillName: string): Promise<IPCResult<void>>;
  checkUpdates(): Promise<IPCResult<Record<string, boolean>>>;
  onUpdateProgress(
    callback: (progress: SkillUpdateProgress) => void,
  ): () => void;
  /** Fires when an agent changes local skills in Electron main. */
  onChanged(callback: () => void): () => void;
  readContent(
    sourceId: string,
    skillName: string,
  ): Promise<IPCResult<SkillContentResponse>>;
  listFiles(
    sourceId: string,
    skillName: string,
  ): Promise<IPCResult<SkillFilesResponse>>;
  readFile(
    sourceId: string,
    skillName: string,
    filePath: string,
  ): Promise<IPCResult<SkillFileContentResponse>>;
  saveCustomSkill(
    payload: SaveCustomSkillRequest,
  ): Promise<IPCResult<{ name: string }>>;

  // -------------------------------------------------------------------------
  // Raw SKILL.md helpers used by the share/import flow.
  //
  // `readRawSkill` returns the exact SKILL.md bytes as a UTF-8 string — no
  // parsing, frontmatter normalization, or trimming. This is what the share
  // flow hashes and sends as `rawSkill`. The existing `readContent` API
  // returns parsed frontmatter/body and must not be used to build share
  // payloads.
  //
  // `writeRawSkill` writes the supplied `rawSkill` bytes verbatim to a new or
  // existing local custom-skill SKILL.md (resolving name collisions per the
  // backend's naming rules) and returns the resulting local id/name. It is
  // the canonical persistence path for shared-skill import; it must not
  // re-serialize or alter the content.
  // Under scoped enforcement main reloads authorized source bytes. Existing
  // receipts require explicit `replaceInstalled` review; replacement never
  // allocates another name. Protocol 8 gates this destructive request remotely.
  //
  // Raw reads support built-ins, `custom:app`, and lock-backed local-filesystem
  // installs. Writes remain confined to `custom:app`.
  // -------------------------------------------------------------------------
  readRawSkill(skillId: string): Promise<string>;
  writeRawSkill(input: WriteRawSkillRequest): Promise<WriteRawSkillResult>;

  // -------------------------------------------------------------------------
  // Shared (Canopy Cloud) skill CRUD.
  //
  // Each handler proxies to the configured Canopy Cloud backend. Resolved
  // errors are surfaced via promise rejection; success responses contain the
  // parsed wire DTO. Create, update and package commit resolve a
  // `ShareOperationResult` instead so structured failures survive IPC.
  // -------------------------------------------------------------------------
  listShared(
    request: ListSharedSkillsRequest,
  ): Promise<ListSharedSkillsResponse>;
  getShared(skillId: string): Promise<DesktopSharedSkillDetail>;
  createShared(
    request: CreateSharedSkillRequest,
  ): Promise<ShareOperationResult<SharedSkillDetail>>;
  updateShared(
    request: UpdateSharedSkillRequest,
  ): Promise<ShareOperationResult<SharedSkillDetail>>;
  deleteShared(request: DeleteSharedSkillRequest): Promise<void>;
  publishPublicShare(skillId: string): Promise<SharedSkillPublicShareInfo>;
  revokePublicShare(skillId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Capability package.
  //
  // Analyze what travels with this skill (its own folder, anything its
  // instructions invoke, and the MCP/plugin names they reference), then commit
  // the reviewed result and hand the returned ref to `createShared`/
  // `updateShared`. A skill with nothing extra to carry simply shares without
  // one, which is the definition-only path.
  // -------------------------------------------------------------------------
  analyzeCapabilityPackage(
    request: AnalyzeSkillCapabilityPackageRequest,
  ): Promise<PipelinePackageAnalysisSummary>;
  cancelCapabilityPackageAnalysis(analysisId: string): Promise<void>;
  commitCapabilityPackage(
    request: CommitSkillCapabilityPackageRequest,
  ): Promise<ShareOperationResult<CommitSkillCapabilityPackageResponse>>;
  /**
   * Copy a shared skill's packaged files into the local skill the import just
   * wrote, plus any skills it invokes. Call after `writeRawSkill`: the SKILL.md
   * bytes are the hashed source of truth and are never re-written from here.
   */
  installCapabilityPackage(
    request: InstallSkillCapabilityPackageRequest,
  ): Promise<InstallSkillCapabilityPackageResult>;
  /**
   * Whether this machine has the MCP servers and plugins a shared skill
   * names. Local only; shown to a recipient before they install.
   */
  getDependencyReadiness(
    request: SkillDependencyReadinessRequest,
  ): Promise<PipelinePackageReadiness>;
  recordShareOrigin(request: RecordSkillShareOriginRequest): Promise<void>;
}

export interface InstallSkillCapabilityPackageRequest {
  /** Server-side shared skill id, or the public share's external id. */
  remoteId: string;
  /** Local skill folder the SKILL.md bytes were already written to. */
  skillName: string;
  /** Root name the package used for the shared skill itself. */
  primaryRootName: string;
  packageRef: PipelinePackageRef;
  publicShare?: boolean;
}

export interface InstallSkillCapabilityPackageResult {
  /** False when different recipient supporting files were kept; retry remains available. */
  supportingFilesComplete?: boolean;
  /** Supporting files copied beside the imported skill's SKILL.md. */
  supportingFileCount: number;
  /**
   * Skills the shared one invokes, installed alongside it. `localName` differs
   * from `name` when the recipient already had a skill by that name.
   */
  installedDependencies: Array<{ name: string; localName: string }>;
  /**
   * Packaged resources the install could not turn into a local skill — plugin
   * skills, commands, and agents, which belong to a plugin rather than to the
   * skill library. They stay verified in the package cache and are named here
   * instead of being dropped silently.
   */
  uninstalledResourceLabels: string[];
  /**
   * Packaged files not written because the recipient already had a different
   * version at that path, as `<skill folder>/<path>`. The never-overwrite rule
   * keeps their copy; this is how the caller tells them. An existing file
   * identical to the packaged one is not listed.
   */
  keptLocalFiles: string[];
}

/** An MCP server or plugin a shared skill names in its instructions. */
export interface SkillDependencyRef {
  kind: 'mcp' | 'plugin';
  name: string;
}

export interface SkillDependencyReadinessRequest {
  dependencies: SkillDependencyRef[];
}

export interface AnalyzeSkillCapabilityPackageRequest {
  sourceId: string;
  skillName: string;
  /** Exact SKILL.md bytes, the same ones the share hashes. */
  rawSkill: string;
  worktree?: { projectId: string; worktreeId: string; repoId?: string };
  /** Tokens the author marked as not commands, echoed back by the analysis. */
  dismissedInvocations?: PipelinePackageInvocationDismissal[];
}

export interface CommitSkillCapabilityPackageRequest {
  analysisId: string;
  selectedOptionalResourceIds?: string[];
}

export interface CommitSkillCapabilityPackageResponse {
  capabilityPackage: PipelinePackageRef;
  committedPackageUploadId: string;
}
