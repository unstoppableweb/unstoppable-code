export { summarizeSharedContainerCapabilityPackage } from './package-summary';
export * from './capability-definitions';
import { isSafeCapabilityRelativePath } from '../capability-files';
import {
  isCapabilityPackageDigest,
  type CapabilityPackageRef,
} from '../pipelines/package';
// ---------------------------------------------------------------------------
import type { WorkspaceContext } from '../workspace-context';
import type { PortalChatMessage } from '../portal';
import type { WirePlanCommentThread } from '../plans';
import { isSafePortableRelativePath } from '../safe-relative-path';

// ---------------------------------------------------------------------------
// Shared-container API contracts (CAN-2544).
//
// This module is an environment-neutral wire boundary. It must remain free of
// Node, Electron, React, Prisma, and app-local imports.
// ---------------------------------------------------------------------------

/**
 * Shared-container API version.
 *
 * - v1: named-recipient VIEW grants, immutable revision metadata, and member
 *   discovery for code worktrees and Cowork Work Entries.
 */
export const SHARED_CONTAINERS_API_VERSION = 1;

export const SHARED_CONTAINER_TYPES = [
  'CODE_WORKTREE',
  'COWORK_WORK_ENTRY',
  'CLOUD_CHAT',
] as const;
export type SharedContainerType = (typeof SHARED_CONTAINER_TYPES)[number];

export const SHARED_CONTAINER_CAPABILITIES = ['VIEW', 'PROMPT'] as const;
export type SharedContainerCapability =
  (typeof SHARED_CONTAINER_CAPABILITIES)[number];

export const SHARED_CONTAINER_LINK_AUDIENCES = [
  'ANYONE',
  'ORGANIZATION',
] as const;
export type SharedContainerLinkAudience =
  (typeof SHARED_CONTAINER_LINK_AUDIENCES)[number];

export const SHARED_CONTAINER_LINK_PATH_PREFIX = '/share/view';
export const SHARED_CONTAINER_LINK_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function sharedContainerLinkPath(token: string): string {
  if (!SHARED_CONTAINER_LINK_TOKEN_PATTERN.test(token)) {
    throw new Error('Invalid shared-container link token');
  }
  return `${SHARED_CONTAINER_LINK_PATH_PREFIX}/${token}`;
}

export const MAX_SHARED_CONTAINER_MEMBER_SEARCH_QUERY_LENGTH = 256;
export const MAX_SHARED_CONTAINER_MEMBER_SEARCH_LIMIT = 50;
export const DEFAULT_SHARED_CONTAINER_LIST_LIMIT = 20;
export const MAX_SHARED_CONTAINER_LIST_LIMIT = 50;
export const MAX_SHARED_CONTAINER_CAPABILITIES =
  SHARED_CONTAINER_CAPABILITIES.length;
export const MAX_SHARED_CONTAINER_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const MAX_SHARED_CONTAINER_REVISION_BYTES = 500 * 1024 * 1024;
export const MAX_SHARED_CONTAINER_MATERIALIZED_BYTES =
  MAX_SHARED_CONTAINER_REVISION_BYTES;
export const MAX_SHARED_CONTAINER_MATERIALIZED_FILES = 1000;
export const MAX_SHARED_CONTAINER_REPOSITORIES = 20;
export const MAX_SHARED_CONTAINER_TITLE_LENGTH = 256;
/**
 * Characters a published run command's `name` may use.
 *
 * The name is the publisher's own script name, carried verbatim so the
 * recipient sees the label the publisher sees. Publishable scripts are no
 * longer limited to the `setup`/`launch` pair, and real `canopy.json` keys
 * carry spaces, parentheses, and dots ("Launch UD Mobile (Android Device)"),
 * so the identifier charset this used to enforce would have rejected most of
 * them.
 *
 * Widened rather than slugged because the name is a display label AND the key
 * the recipient's run request looks up in `run.commands`; a slug would have
 * shown the recipient something other than what the publisher ticked. It is
 * never a path: script-run log files go through `buildScriptRunFileStem`,
 * which lowercases, collapses everything outside `[a-z0-9]` to `-`, and
 * appends a digest. Control characters and newlines stay excluded.
 */
export const SHARED_CONTAINER_RUN_COMMAND_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 ()._-]{0,63}$/;

export const MAX_SHARED_CONTAINER_RUN_COMMANDS = 8;
export const MAX_SHARED_CONTAINER_RUN_COMMAND_LENGTH = 2048;
export const MAX_SHARED_CONTAINER_RUN_ENV_NAMES = 64;
export const MAX_SHARED_CONTAINER_RUN_ENV_NAME_LENGTH = 256;
// Publisher metadata is JSON, separate from the GCS-hosted artifact bytes.
// Bound it independently so the stage route never buffers arbitrary input.
export const MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES = 1024 * 1024;
export const MAX_SHARED_CONTAINER_COMMIT_REQUEST_BYTES = 1024;
export const MAX_SHARED_CONTAINER_DOWNLOAD_URLS_REQUEST_BYTES = 16 * 1024;
// Each staged artifact requires a remote IAM signBlob operation. Keep stage and
// download fan-out at the same per-request ceiling so neither can monopolize
// the quota shared with unrelated signed-URL features.
export const MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION = 200;
export const MAX_SHARED_CONTAINER_RETAINED_REVISIONS = 20;
// Each target requires a remote IAM signBlob operation. Keep one request well
// below the project-wide quota shared with unrelated signed-URL features.
export const MAX_SHARED_CONTAINER_DOWNLOAD_ARTIFACTS = 200;

export const SHARED_CONTAINER_CONTENT_REPRESENTATIONS = [
  'BLOB',
  'OPERATION_MANIFEST',
] as const;
export type SharedContainerContentRepresentation =
  (typeof SHARED_CONTAINER_CONTENT_REPRESENTATIONS)[number];

export const SHARED_CONTAINER_FILE_STATUSES = [
  'modified',
  'added',
  'deleted',
] as const;
export type SharedContainerFileStatus =
  (typeof SHARED_CONTAINER_FILE_STATUSES)[number];

/** One dirty or explicitly approved file in a code repository. */
export interface SharedContainerRevisionFile {
  /** Repository-relative user path. Never use this as an artifact path. */
  path: string;
  status: SharedContainerFileStatus;
  /** Content-addressed blob id. Omitted only for deletions. */
  artifactId?: string;
  /** Git file mode. Materializers preserve executable bits while sealing writes. */
  mode: string;
}

/**
 * Upper bound on the per-repository committed-file list (CAN-2551).
 *
 * Committed files are metadata only: their blobs already live in the
 * recipient's own clone, so this list never contributes materialized bytes.
 * It is still publisher-controlled input, so it carries its own ceiling
 * independent of {@link MAX_SHARED_CONTAINER_MATERIALIZED_FILES}.
 */
export const MAX_SHARED_CONTAINER_COMMITTED_FILES_PER_REPOSITORY = 2000;

/**
 * One file changed by the publisher's own commits, between the branch's merge
 * base and its `baseCommitSha`.
 *
 * Deliberately carries no `artifactId`: these blobs are reachable from the
 * recipient's Canopy-owned checkout of the same remote, so re-uploading them
 * would duplicate bytes the recipient can already fetch themselves.
 */
export interface SharedContainerRevisionCommittedFile {
  /** Repository-relative user path. Never use this as an artifact path. */
  path: string;
  status: SharedContainerFileStatus;
  /**
   * Publisher-computed numstat counts.
   *
   * Optional on the wire, but a publisher that can count always sends both.
   * Binary files and rename/copy rows are the cases where the numbers do not
   * describe what the recipient will actually render, so the publisher omits
   * them there rather than sending a `0`/`0` the viewer would have to
   * second-guess (CAN-2551).
   */
  insertions?: number;
  deletions?: number;
}

export const SHARED_CONTAINER_WITHHELD_FILE_REASONS = [
  'credential-shaped',
  'undisclosed-repo',
  'oversized',
  'symlink-escaping',
] as const;
export type SharedContainerWithheldFileReason =
  (typeof SHARED_CONTAINER_WITHHELD_FILE_REASONS)[number];

/** One explicitly approved file in a non-git Cowork workspace snapshot. */
export interface SharedContainerRevisionCoworkFile {
  /** Workspace-relative user path. Never use this as an artifact path. */
  path: string;
  status: SharedContainerFileStatus;
  /** Content-addressed blob id. Cowork publishers never emit deletions. */
  artifactId: string;
  /** Decimal plaintext byte length. */
  sizeBytes: string;
}

export interface SharedContainerRevisionRepository {
  repoId: string;
  repoName: string;
  /** Sanitized remote used for the recipient's Canopy-owned checkout. */
  remoteUrl: string;
  owner: string;
  repository: string;
  baseCommitSha: string;
  files: SharedContainerRevisionFile[];
  /**
   * Branch `baseCommitSha` was compared against when the publisher computed
   * {@link committedFiles}. Display metadata only; the recipient resolves
   * content through {@link mergeBaseSha}, never by name.
   */
  baseBranch?: string;
  /**
   * Merge base of the publisher's branch and its base branch. The recipient
   * fetches this one commit so committed diffs resolve locally.
   */
  mergeBaseSha?: string;
  /**
   * Files changed by the publisher's own commits (`mergeBaseSha..baseCommitSha`).
   *
   * Optional so a revision published before CAN-2551 still reads cleanly: an
   * absent list renders as an empty committed group, exactly the prior
   * behavior.
   */
  committedFiles?: SharedContainerRevisionCommittedFile[];
}

export interface SharedContainerRevisionSnapshot {
  /** Ordered content-addressed chunks of a deterministic single-commit bundle. */
  bundleArtifactIds: string[];
  treeFileCount: number;
  /** Decimal byte length of the materialized snapshot tree. */
  treeBytes: string;
}

export interface SharedContainerRevisionSnapshotRepository {
  repoId: string;
  repoName: string;
  source: 'snapshot';
  /** Parentless commit contained in the snapshot bundle. */
  baseCommitSha: string;
  snapshot: SharedContainerRevisionSnapshot;
  /** Overlay applied after materializing the snapshot commit. */
  files: SharedContainerRevisionFile[];
}

export interface SharedContainerRevisionWorkspaceItem {
  itemId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SharedContainerAttachmentPath {
  artifactId: string;
  displayName: string;
}

export interface SharedContainerRevisionRunCommand {
  name: string;
  command: string;
  repoId: string;
}

export interface SharedContainerRevisionRunConfig {
  commands: SharedContainerRevisionRunCommand[];
  requiredEnv: string[];
}

/**
 * Authenticated `container.json` payload for a recipient revision.
 *
 * Artifact paths are fixed by `docs/shared-container-revision-layout.md`; all
 * arbitrary user paths remain data in this object and are validated again at
 * the materialization boundary.
 */
export interface SharedContainerRevisionLayout {
  schemaVersion: 1;
  containerType: SharedContainerType;
  title: string;
  repositories: SharedContainerRevisionRepository[];
  /** Full Cowork snapshot. Empty for code worktrees. */
  files: SharedContainerRevisionCoworkFile[];
  notes: SharedContainerRevisionWorkspaceItem[];
  prompts: SharedContainerRevisionWorkspaceItem[];
  attachmentPaths: Record<string, SharedContainerAttachmentPath>;
  /** Omitted paths, disclosed without revealing their sensitive names. */
  withheldFileCount?: number;
  withheldFileReasons?: SharedContainerWithheldFileReason[];
  /** Publisher-selected run affordances. Omitted unless explicitly enabled. */
  run?: SharedContainerRevisionRunConfig;
}

/** Schema v2 is emitted only when at least one repository uses a snapshot source. */
export interface SharedContainerRevisionLayoutV2 extends Omit<
  SharedContainerRevisionLayout,
  'schemaVersion' | 'repositories'
> {
  schemaVersion: 2;
  repositories: Array<
    | SharedContainerRevisionRepository
    | SharedContainerRevisionSnapshotRepository
  >;
}

export const SHARED_CONTAINER_PUBLISHED_PANEL_KINDS = [
  'chat',
  'file',
  'file-diff',
  'browser',
  'file-explorer',
  'activity-section',
  'activity-card',
  'change-diagram',
] as const;
export type SharedContainerPublishedPanelKind =
  (typeof SHARED_CONTAINER_PUBLISHED_PANEL_KINDS)[number];

export type SharedContainerPublishedPanel =
  | { kind: 'chat'; chatId: string }
  | {
      kind: 'file' | 'file-diff';
      repoId: string;
      relativePath: string;
      viewMode?: 'raw' | 'rich' | 'diff';
    }
  | { kind: 'browser'; repoId: string; relativePath: string }
  /** A web page (`http:` or `https:`, including localhost). Schema v5 only. */
  | { kind: 'browser'; url: string }
  | { kind: 'activity-card'; sectionId: string }
  | {
      kind: 'file-explorer' | 'activity-section' | 'change-diagram';
    };

export type SharedContainerPublishedPanelNode =
  | {
      type: 'leaf';
      size: number;
      tabs: SharedContainerPublishedPanel[];
      activeTabIndex: number;
    }
  | {
      type: 'branch';
      size: number;
      children: SharedContainerPublishedPanelNode[];
    };

/**
 * Sanitized publisher layout. It contains no host paths or terminal tabs. Web
 * page URLs appear only in schema v5 revisions.
 */
export interface SharedContainerPublishedLayout {
  orientation: 0 | 1;
  root: SharedContainerPublishedPanelNode;
}

/**
 * Schema v3 adds the optional sanitized publisher panel layout. It accepts
 * both remote-backed and snapshot repositories so v1/v2 readers remain
 * unchanged and every layout-bearing revision has one unambiguous parser.
 */
export interface SharedContainerRevisionLayoutV3 extends Omit<
  SharedContainerRevisionLayoutV2,
  'schemaVersion'
> {
  schemaVersion: 3;
  layout?: SharedContainerPublishedLayout;
}

export type SharedContainerStartPage =
  | { kind: 'file'; repoId: string; relativePath: string }
  | { kind: 'url'; url: string };

/** Schema v4 adds a portable start page without changing v3 layout behavior. */
export interface SharedContainerRevisionLayoutV4 extends Omit<
  SharedContainerRevisionLayoutV3,
  'schemaVersion'
> {
  schemaVersion: 4;
  startPage?: SharedContainerStartPage;
}

/**
 * Schema v5 lets the layout carry web page browser panels. Publishers pick it
 * only when the layout has one, so older receivers ask for an update instead
 * of rejecting the revision.
 */
export interface SharedContainerRevisionLayoutV5 extends Omit<
  SharedContainerRevisionLayoutV4,
  'schemaVersion'
> {
  schemaVersion: 5;
}

export type AnySharedContainerRevisionLayout =
  | SharedContainerRevisionLayout
  | SharedContainerRevisionLayoutV2
  | SharedContainerRevisionLayoutV3
  | SharedContainerRevisionLayoutV4
  | SharedContainerRevisionLayoutV5;

/** The highest revision schema version this build reads. */
export const MAX_SUPPORTED_SHARED_CONTAINER_SCHEMA_VERSION = 5;

/** Whether a URL is a web page a receiver can open: `http:` or `https:`. */
export function isSharedContainerWebPageUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether a published layout has a web page panel, which needs schema v5. */
export function sharedContainerPublishedLayoutHasWebPage(
  layout: SharedContainerPublishedLayout | undefined,
): boolean {
  const visit = (node: SharedContainerPublishedPanelNode): boolean =>
    node.type === 'branch'
      ? node.children.some(visit)
      : node.tabs.some((panel) => panel.kind === 'browser' && 'url' in panel);
  return layout ? visit(layout.root) : false;
}

/** Presentation-safe chat artifact published independently from local state. */
export interface SharedContainerPublishedChat {
  schemaVersion: 1;
  chatId: string;
  title: string;
  createdAt: string;
  description?: string;
  messages: PortalChatMessage[];
}

/** Immutable local record describing the shared revision a fork came from. */
export interface SharedContainerForkProvenance {
  sourceContainerId: string;
  sourceRevisionId: string;
  /** Publication time from the guarded source revision; absent on legacy copies. */
  sourceRevisionCreatedAt?: string;
  sourceOwnerDisplayName: string;
  /** Owning organization of the source; absent for a personal container. */
  organizationId?: string;
  forkedAt: string;
}

export type SharedContainerForkDestination =
  | { kind: 'existing-workspace'; workspaceId: string }
  | {
      kind: 'new-workspace';
      owner: WorkspaceContext;
      parentDirectory?: string;
    };

export interface SharedContainerForkRequest {
  containerId: string;
  revisionId: string;
  /** Ownership hint; absent for a personal container shared directly. */
  organizationId?: string;
  sourceOwnerDisplayName: string;
  destination: SharedContainerForkDestination;
  /**
   * Digest of the capability package the fork confirmation disclosed for
   * `revisionId`. Making the copy is consent to install exactly this package:
   * main installs only when the pinned revision still carries this digest,
   * and never switches to a later revision. Absent when nothing was disclosed.
   */
  expectedPackageDigest?: string;
}

export interface SharedContainerForkResponse {
  containerType: SharedContainerType;
  projectId: string;
  worktreeId: string;
  warnings: string[];
  provenance: SharedContainerForkProvenance;
}

/** Stable expected refusals, returned as data across Electron and remote IPC. */
export type SharedContainerForkErrorCode =
  | 'invalid-destination'
  | 'owner-mismatch'
  | 'source-unavailable'
  | 'destination-unavailable'
  /** The member can't create projects in the owning organization now. */
  | 'organization-creation-unavailable'
  /** The member's private-project limit in the organization has been reached. */
  | 'organization-project-limit'
  /** The organization already has this share's project on this computer. */
  | 'organization-already-bound'
  /** The organization's project for the repository can't be used. */
  | 'organization-repository-inaccessible'
  /** A new organization copy isn't supported for this share's shape. */
  | 'organization-shape-unsupported'
  /** Creating or setting up the organization copy failed. */
  | 'organization-creation-failed';

export interface SharedContainerForkRefusal {
  ok: false;
  code: SharedContainerForkErrorCode;
  message: string;
}

export type SharedContainerForkResult =
  | SharedContainerForkResponse
  | SharedContainerForkRefusal;

/** Presentation-safe tracked-plan artifact published independently from local state. */
export interface SharedContainerPublishedPlan {
  schemaVersion: 1;
  planId: string;
  title: string;
  content: string;
  source: string;
  reviewStatus: string;
  createdAt: string;
  updatedAt: string;
  latestRevisionNumber: number;
  approvedAt?: string;
  dismissedAt?: string;
  lastEditSource?: string;
  sourceRepoId?: string;
  sourceFilePath?: string;
  commentThreads: WirePlanCommentThread[];
}

export interface SharedContainerArtifactDetail {
  artifactId: string;
  path: string;
  representation: SharedContainerContentRepresentation;
  /** SHA-256 of the plaintext bytes; recipients verify it after decryption. */
  hash: string;
  /** Decimal plaintext byte length, before artifact encryption. */
  objectSizeBytes: string;
}

export interface SharedContainerManifest {
  revisionId: string;
  parentRevisionId?: string;
  schemaVersion: number;
  artifacts: SharedContainerArtifactDetail[];
}

export type SharedContainerStageArtifact = SharedContainerArtifactDetail & {
  /** Reuse the matching artifact declaration and encrypted object from the parent. */
  carriedFromParentRevision?: true;
};

export interface SharedContainerStageRevisionRequest {
  /** Optional ownership hint. When present it must match the container row. */
  organizationId?: string;
  /** Low-sensitivity list label; never derived from chat content. */
  title: string;
  /** Caller-generated UUID used to replay an ambiguously successful stage. */
  idempotencyKey: string;
  sourceDeviceId: string;
  schemaVersion: number;
  parentRevisionId?: string;
  artifacts: SharedContainerStageArtifact[];
  capabilityPackage?: CapabilityPackageRef;
  committedPackageUploadId?: string;
  carryParentPackage?: true;
}

export interface SharedContainerUploadTarget {
  artifactId: string;
  target: {
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
  };
  key: SharedContainerArtifactKey;
}

export interface SharedContainerArtifactKey {
  scheme: 'AES_256_GCM_CHUNKED_V1';
  /** Base64-encoded 256-bit data-encryption key. */
  dataKey: string;
  /** Exact identity AAD that must be supplied to the artifact codec. */
  aad: string;
}

export interface SharedContainerStageRevisionResponse {
  stagingSessionId: string;
  revisionId: string;
  uploadTargets: SharedContainerUploadTarget[];
}

export interface SharedContainerCommitRevisionRequest {
  stagingSessionId: string;
}

export interface SharedContainerCommitRevisionResponse {
  revision: SharedContainerRevisionDetail;
}

export interface SharedContainerFetchRevisionResponse {
  revision: SharedContainerRevisionDetail;
}

export interface SharedContainerDownloadUrlsRequest {
  artifactIds: string[];
}

export interface SharedContainerDownloadTarget {
  artifactId: string;
  target: { url: string; expiresAt: string };
  key: SharedContainerArtifactKey;
}

export interface SharedContainerDownloadUrlsResponse {
  downloads: SharedContainerDownloadTarget[];
}

export const SHARED_CONTAINER_INSUFFICIENT_ROLE_ERROR_CODE =
  'insufficient-role' as const;
/**
 * An organization-owned cloud chat was shared into a different organization
 * (CAN-3458). Org-owned chats may be shared only into their owning
 * organization; Personal chats may be shared into any organization the owner
 * belongs to.
 */
export const SHARED_CONTAINER_CLOUD_CHAT_OWNER_ORGANIZATION_MISMATCH_ERROR_CODE =
  'cloud-chat-owner-organization-mismatch' as const;
export const SHARED_CONTAINER_BLOCKED_BY_ORG_BILLING_ERROR_CODE =
  'blocked-by-org-billing' as const;
export const SHARED_CONTAINER_EXTERNAL_SHARING_DISABLED_ERROR_CODE =
  'external-sharing-disabled' as const;
export const SHARED_CONTAINER_GRANT_NOT_FOUND_ERROR_CODE =
  'shared-container-grant-not-found' as const;
export const SHARED_CONTAINER_DISMISSAL_NOT_FOUND_ERROR_CODE =
  'shared-container-dismissal-not-found' as const;
export const SHARED_CONTAINER_STAGE_ALREADY_COMMITTED_ERROR_CODE =
  'shared-container-stage-already-committed' as const;
export const SHARED_CONTAINER_UPLOAD_TARGET_REFRESH_EXHAUSTED_ERROR_CODE =
  'shared-container-upload-target-refresh-exhausted' as const;
export const SHARED_CONTAINER_CLEANUP_IN_PROGRESS_ERROR_CODE =
  'shared-container-cleanup-in-progress' as const;
export const SHARED_CONTAINER_PACKAGE_UPLOAD_EXPIRED_ERROR_CODE =
  'shared_container_package_upload_expired' as const;
export const SHARED_CONTAINER_PARENT_PACKAGE_UNAVAILABLE_ERROR_CODE =
  'shared_container_parent_package_unavailable' as const;
export const SHARED_CONTAINER_ERROR_CODES = [
  SHARED_CONTAINER_INSUFFICIENT_ROLE_ERROR_CODE,
  SHARED_CONTAINER_BLOCKED_BY_ORG_BILLING_ERROR_CODE,
  SHARED_CONTAINER_EXTERNAL_SHARING_DISABLED_ERROR_CODE,
  SHARED_CONTAINER_GRANT_NOT_FOUND_ERROR_CODE,
  SHARED_CONTAINER_DISMISSAL_NOT_FOUND_ERROR_CODE,
  SHARED_CONTAINER_STAGE_ALREADY_COMMITTED_ERROR_CODE,
  SHARED_CONTAINER_UPLOAD_TARGET_REFRESH_EXHAUSTED_ERROR_CODE,
  SHARED_CONTAINER_CLEANUP_IN_PROGRESS_ERROR_CODE,
  SHARED_CONTAINER_PACKAGE_UPLOAD_EXPIRED_ERROR_CODE,
  SHARED_CONTAINER_PARENT_PACKAGE_UNAVAILABLE_ERROR_CODE,
  SHARED_CONTAINER_CLOUD_CHAT_OWNER_ORGANIZATION_MISMATCH_ERROR_CODE,
] as const;
export type SharedContainerErrorCode =
  (typeof SHARED_CONTAINER_ERROR_CODES)[number];

export type SharedContainerRecipientRequest =
  | { kind: 'member'; userId: string }
  | { kind: 'email'; email: string };

interface SharedContainerCreateRequestBase {
  organizationId?: string;
  worktreeId?: string;
  cloudChatId?: string;
  capabilities: SharedContainerCapability[];
}

/** `recipientUserId` is accepted only as a legacy alias for member recipients. */
export type SharedContainerCreateRequest = SharedContainerCreateRequestBase &
  (
    | { recipient: SharedContainerRecipientRequest; recipientUserId?: never }
    | { recipient?: never; recipientUserId: string }
  );

export interface SharedContainerOwnerSummary {
  userId: string;
  name: string;
  image?: string;
}

export interface SharedContainerRef {
  id: string;
  organizationId?: string;
  ownerUserId: string;
  owner: SharedContainerOwnerSummary;
  organizationName?: string;
  access: 'organization' | 'direct';
  worktreeId?: string;
  cloudChatId?: string;
  backend?: 'cloud' | 'desktop';
  containerType: SharedContainerType;
}

export interface SharedContainerSummary extends SharedContainerRef {
  /** Owner workspace display metadata for CLOUD_CHAT recipient grouping. */
  cloudWorkspace?: { id: string; name: string };
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Capabilities the *requesting caller* holds on this container, not the union
   * granted to everyone. An owner-side listing reports the capabilities of the
   * container type (`['VIEW']` for worktrees, `['VIEW', 'PROMPT']` for cloud
   * chats); a recipient listing reports that recipient's own grant. Read a
   * specific recipient's grant from {@link SharedContainerGrantSummary}.
   */
  capabilities: SharedContainerCapability[];
}

export interface SharedContainerCapabilityPackageCounts {
  skills: number;
  pipelines: number;
  agents: number;
  automations: number;
  hooks: number;
}

export interface SharedContainerRevisionPackage {
  digest: string;
  counts: SharedContainerCapabilityPackageCounts;
  executableFiles: string[];
}

/**
 * Executable disclosures are `resourceId/rootName/path`, so their bound is the
 * two 255-character segments plus the manifest's 1,024-character entry path.
 */
function isRevisionPackageExecutableFile(value: unknown): value is string {
  return isSafeCapabilityRelativePath(value, {
    maxPathLength: 255 + 1 + 255 + 1 + 1_024,
    maxSegmentLength: 255,
  });
}

export function isSharedContainerRevisionPackage(
  value: unknown,
): value is SharedContainerRevisionPackage {
  if (
    !isRecord(value) ||
    !isCapabilityPackageDigest(value.digest) ||
    !isRecord(value.counts)
  )
    return false;
  const counts = value.counts;
  return (
    ['skills', 'pipelines', 'agents', 'automations', 'hooks'].every(
      (key) => Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0,
    ) &&
    Array.isArray(value.executableFiles) &&
    value.executableFiles.every(isRevisionPackageExecutableFile)
  );
}

/** Package modes are mutually exclusive; carry is meaningful only with a parent. */
export function isSharedContainerPackageAttachment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.carryParentPackage !== undefined)
    return (
      value.carryParentPackage === true &&
      typeof value.parentRevisionId === 'string' &&
      value.parentRevisionId.length > 0 &&
      value.capabilityPackage === undefined &&
      value.committedPackageUploadId === undefined
    );
  if (
    value.capabilityPackage === undefined &&
    value.committedPackageUploadId === undefined
  )
    return true;
  return (
    isRecord(value.capabilityPackage) &&
    value.capabilityPackage.version === 1 &&
    isCapabilityPackageDigest(value.capabilityPackage.digest) &&
    typeof value.committedPackageUploadId === 'string'
  );
}

export interface SharedContainerRevisionDetail {
  package?: SharedContainerRevisionPackage;
  id: string;
  revision: number;
  schemaVersion: number;
  parentRevisionId?: string;
  actorUserId?: string;
  sourceDeviceId: string;
  artifactObjectKey: string;
  artifactHash: string;
  artifactSizeBytes: string;
  artifacts?: SharedContainerArtifactDetail[];
  artifactCount?: number;
  totalSizeBytes?: string;
  createdAt: string;
}

export interface SharedContainerDetail extends SharedContainerSummary {
  latestRevision?: SharedContainerRevisionDetail;
}

export interface SharedContainerMemberSummary {
  userId: string;
  name: string;
  image?: string;
}

export type SharedContainerGrantRecipient =
  | ({ kind: 'member' } & SharedContainerMemberSummary)
  | { kind: 'email'; email: string; status: 'invited' };

export interface SharedContainerGrantSummary {
  id: string;
  containerId: string;
  recipient: SharedContainerGrantRecipient;
  capabilities: SharedContainerCapability[];
  createdAt: string;
  updatedAt: string;
  via?: 'link';
  /**
   * Set when the recipient removed the share. The row is then a revoke-only
   * record of the removed grant: revoking it stops the recipient restoring.
   */
  dismissedAt?: string;
}

export interface SharedContainerLink {
  audience: SharedContainerLinkAudience;
  /** Server-returned web path. Callers project it onto the configured web origin. */
  url: string;
}

export interface SetSharedContainerLinkRequest {
  audience: SharedContainerLinkAudience;
}

/** Creates the first link and its owner container before any invite exists. */
export interface CreateSharedContainerLinkRequest extends SetSharedContainerLinkRequest {
  worktreeId: string;
  organizationId?: string;
}

export interface SharedContainerLinkContents {
  repositoryCount: number;
  repositoryNames: string[];
  chatCount: number;
  fileCount: number;
}

export type SharedContainerLinkState =
  | 'ready'
  | 'sign-in-required'
  | 'not-eligible';

export type SharedContainerLinkLanding =
  | { state: 'sign-in-required' }
  | { state: 'not-eligible' }
  | {
      state: 'ready';
      audience: SharedContainerLinkAudience;
      title: string;
      containerType: 'CODE_WORKTREE' | 'COWORK_WORK_ENTRY';
      owner: SharedContainerOwnerSummary;
      organizationName?: string;
      lastPublishedAt?: string;
      contents: SharedContainerLinkContents;
      eligible?: boolean;
      alreadyHasAccess?: boolean;
      /** Present only when the signed-in viewer already has access. */
      existingAccess?: SharedContainerRef;
    };

/** Bare claim response consumed by the desktop acceptance flow. */
export type SharedContainerLinkClaimResult = SharedContainerRef;

export interface CreateSharedContainerLinkResult {
  container: SharedContainerSummary;
  link: SharedContainerLink;
}

// ---------------------------------------------------------------------------
// Response envelopes (Canopy Server -> desktop/web).
//
// These are the exact JSON bodies the `api/v1/shared-containers/**` and
// `api/account/shared-containers/**` routes return, so a client never has to
// guess an envelope key. `GET .../revisions/latest` returns a bare
// {@link SharedContainerDetail}, and both `DELETE` operations return `204` with
// no body.
// ---------------------------------------------------------------------------

/** `GET /shared-containers/shared-by-me` and `.../shared-with-me`. */
export interface ListSharedContainersResponse {
  containers: SharedContainerSummary[];
  nextCursor: string | null;
}

/** A share its recipient removed and may still restore. */
export interface DismissedSharedContainerSummary extends SharedContainerSummary {
  dismissedAt: string;
}

/** `GET /shared-containers/dismissed`. */
export interface ListDismissedSharedContainersResponse {
  containers: DismissedSharedContainerSummary[];
  nextCursor: string | null;
}

/** `POST /shared-containers/{containerId}/restore`. */
export interface RestoreSharedContainerResponse {
  container: SharedContainerSummary;
}

/** `GET /shared-containers/members`. */
export interface SearchSharedContainerMembersResponse {
  members: SharedContainerMemberSummary[];
}

/** `GET /shared-containers/{containerId}/recipients` (owner only). */
export interface ListSharedContainerRecipientsResponse {
  recipients: SharedContainerGrantSummary[];
  nextCursor: string | null;
}

/** `POST /shared-containers` (`201`). */
export interface CreateSharedContainerGrantResponse {
  container: SharedContainerSummary;
  grant: SharedContainerGrantSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isUnsignedDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isSharedContainerForkProvenance(
  value: unknown,
): value is SharedContainerForkProvenance {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'sourceContainerId',
      'sourceRevisionId',
      'sourceRevisionCreatedAt',
      'sourceOwnerDisplayName',
      'organizationId',
      'forkedAt',
    ]) &&
    typeof value.sourceContainerId === 'string' &&
    value.sourceContainerId.length > 0 &&
    typeof value.sourceRevisionId === 'string' &&
    value.sourceRevisionId.length > 0 &&
    (value.sourceRevisionCreatedAt === undefined ||
      (typeof value.sourceRevisionCreatedAt === 'string' &&
        Number.isFinite(Date.parse(value.sourceRevisionCreatedAt)))) &&
    typeof value.sourceOwnerDisplayName === 'string' &&
    value.sourceOwnerDisplayName.length > 0 &&
    (value.organizationId === undefined ||
      (typeof value.organizationId === 'string' &&
        value.organizationId.length > 0)) &&
    typeof value.forkedAt === 'string' &&
    Number.isFinite(Date.parse(value.forkedAt))
  );
}

function isRevisionFile(value: unknown): value is SharedContainerRevisionFile {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['path', 'status', 'artifactId', 'mode'])) {
    return false;
  }
  if (
    typeof value.path !== 'string' ||
    value.path
      .normalize('NFC')
      .split('/')
      .some((segment) => segment.toLowerCase() === '.git') ||
    typeof value.status !== 'string' ||
    !includesString(SHARED_CONTAINER_FILE_STATUSES, value.status) ||
    typeof value.mode !== 'string'
  ) {
    return false;
  }
  return value.status === 'deleted'
    ? value.artifactId === undefined
    : typeof value.artifactId === 'string' && value.artifactId.length > 0;
}

function isOptionalDiffCount(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}

function isRevisionCommittedFile(
  value: unknown,
): value is SharedContainerRevisionCommittedFile {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['path', 'status', 'insertions', 'deletions']) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    // Committed paths never reach the filesystem — git contains them inside
    // `<sha>:<path>` — but they are still publisher-controlled input, and the
    // uncommitted half gets a `resolvePathBelowForRead`-shaped check at
    // materialize. Keep the fail-closed posture uniform rather than relying on
    // git's containment alone (CAN-2551).
    !value.path.startsWith('/') &&
    !value.path.includes('\\') &&
    !/^[A-Za-z]:/.test(value.path) &&
    !value.path
      .normalize('NFC')
      .split('/')
      .some(
        (segment) =>
          segment.toLowerCase() === '.git' ||
          segment === '.' ||
          segment === '..' ||
          segment.length === 0,
      ) &&
    typeof value.status === 'string' &&
    includesString(SHARED_CONTAINER_FILE_STATUSES, value.status) &&
    isOptionalDiffCount(value.insertions) &&
    isOptionalDiffCount(value.deletions)
  );
}

function isRevisionRepository(
  value: unknown,
): value is SharedContainerRevisionRepository {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'repoId',
      'repoName',
      'remoteUrl',
      'owner',
      'repository',
      'baseCommitSha',
      'files',
      'baseBranch',
      'mergeBaseSha',
      'committedFiles',
    ]) &&
    (value.baseBranch === undefined ||
      (typeof value.baseBranch === 'string' && value.baseBranch.length > 0)) &&
    (value.mergeBaseSha === undefined ||
      (typeof value.mergeBaseSha === 'string' &&
        /^[a-fA-F0-9]{40}$/.test(value.mergeBaseSha))) &&
    (value.committedFiles === undefined ||
      (Array.isArray(value.committedFiles) &&
        value.committedFiles.length <=
          MAX_SHARED_CONTAINER_COMMITTED_FILES_PER_REPOSITORY &&
        value.committedFiles.every(isRevisionCommittedFile))) &&
    typeof value.repoId === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(value.repoId) &&
    typeof value.repoName === 'string' &&
    value.repoName.length > 0 &&
    typeof value.remoteUrl === 'string' &&
    value.remoteUrl.length > 0 &&
    typeof value.owner === 'string' &&
    value.owner.length > 0 &&
    typeof value.repository === 'string' &&
    value.repository.length > 0 &&
    typeof value.baseCommitSha === 'string' &&
    /^[a-fA-F0-9]{40}$/.test(value.baseCommitSha) &&
    Array.isArray(value.files) &&
    value.files.every(isRevisionFile)
  );
}

function isRevisionSnapshotRepository(
  value: unknown,
): value is SharedContainerRevisionSnapshotRepository {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'repoId',
      'repoName',
      'source',
      'baseCommitSha',
      'snapshot',
      'files',
    ]) ||
    typeof value.repoId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value.repoId) ||
    typeof value.repoName !== 'string' ||
    value.repoName.length === 0 ||
    value.source !== 'snapshot' ||
    typeof value.baseCommitSha !== 'string' ||
    !/^[a-fA-F0-9]{40}$/.test(value.baseCommitSha) ||
    !isRecord(value.snapshot) ||
    !hasOnlyKeys(value.snapshot, [
      'bundleArtifactIds',
      'treeFileCount',
      'treeBytes',
    ]) ||
    !Array.isArray(value.snapshot.bundleArtifactIds) ||
    value.snapshot.bundleArtifactIds.length === 0 ||
    value.snapshot.bundleArtifactIds.length >
      MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION ||
    !value.snapshot.bundleArtifactIds.every(
      (artifactId) => typeof artifactId === 'string' && artifactId.length > 0,
    ) ||
    new Set(value.snapshot.bundleArtifactIds).size !==
      value.snapshot.bundleArtifactIds.length ||
    !Number.isInteger(value.snapshot.treeFileCount) ||
    (value.snapshot.treeFileCount as number) < 0 ||
    !isUnsignedDecimal(value.snapshot.treeBytes) ||
    !Array.isArray(value.files) ||
    !value.files.every(isRevisionFile)
  ) {
    return false;
  }
  return true;
}

function isRevisionCoworkFile(
  value: unknown,
): value is SharedContainerRevisionCoworkFile {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['path', 'status', 'artifactId', 'sizeBytes']) &&
    typeof value.path === 'string' &&
    typeof value.status === 'string' &&
    includesString(SHARED_CONTAINER_FILE_STATUSES, value.status) &&
    value.status !== 'deleted' &&
    typeof value.artifactId === 'string' &&
    value.artifactId.length > 0 &&
    isUnsignedDecimal(value.sizeBytes)
  );
}

function isWorkspaceItem(
  value: unknown,
): value is SharedContainerRevisionWorkspaceItem {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['itemId', 'title', 'createdAt', 'updatedAt']) &&
    typeof value.itemId === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(value.itemId) &&
    typeof value.title === 'string' &&
    (value.createdAt === undefined || typeof value.createdAt === 'string') &&
    (value.updatedAt === undefined || typeof value.updatedAt === 'string')
  );
}

function isAttachmentPath(
  value: unknown,
): value is SharedContainerAttachmentPath {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['artifactId', 'displayName']) &&
    typeof value.artifactId === 'string' &&
    typeof value.displayName === 'string'
  );
}

function isRevisionRunCommand(
  value: unknown,
): value is SharedContainerRevisionRunCommand {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'command', 'repoId']) &&
    typeof value.name === 'string' &&
    SHARED_CONTAINER_RUN_COMMAND_NAME_PATTERN.test(value.name) &&
    typeof value.command === 'string' &&
    value.command.length > 0 &&
    value.command.length <= MAX_SHARED_CONTAINER_RUN_COMMAND_LENGTH &&
    !/[\r\n]/.test(value.command) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001F\u007F]/.test(value.command) &&
    typeof value.repoId === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(value.repoId)
  );
}

function isRevisionRunConfig(
  value: unknown,
): value is SharedContainerRevisionRunConfig {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['commands', 'requiredEnv']) ||
    !Array.isArray(value.commands) ||
    value.commands.length > MAX_SHARED_CONTAINER_RUN_COMMANDS ||
    !value.commands.every(isRevisionRunCommand) ||
    new Set(value.commands.map((command) => command.name)).size !==
      value.commands.length ||
    !Array.isArray(value.requiredEnv) ||
    value.requiredEnv.length > MAX_SHARED_CONTAINER_RUN_ENV_NAMES ||
    !value.requiredEnv.every(
      (name) =>
        typeof name === 'string' &&
        name.length <= MAX_SHARED_CONTAINER_RUN_ENV_NAME_LENGTH &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    ) ||
    new Set(value.requiredEnv).size !== value.requiredEnv.length
  ) {
    return false;
  }
  return true;
}

function isPublishedPanel(value: unknown, allowWebPages: boolean): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'chat') {
    return (
      hasOnlyKeys(value, ['kind', 'chatId']) &&
      typeof value.chatId === 'string' &&
      value.chatId.length > 0
    );
  }
  if (value.kind === 'file' || value.kind === 'file-diff') {
    return (
      hasOnlyKeys(value, ['kind', 'repoId', 'relativePath', 'viewMode']) &&
      typeof value.repoId === 'string' &&
      /^[A-Za-z0-9_-]+$/.test(value.repoId) &&
      isSafePublishedRelativePath(value.relativePath) &&
      (value.viewMode === undefined ||
        value.viewMode === 'raw' ||
        value.viewMode === 'rich' ||
        value.viewMode === 'diff')
    );
  }
  if (value.kind === 'browser' && 'url' in value) {
    return (
      allowWebPages &&
      hasOnlyKeys(value, ['kind', 'url']) &&
      isSharedContainerWebPageUrl(value.url)
    );
  }
  if (value.kind === 'browser') {
    return (
      hasOnlyKeys(value, ['kind', 'repoId', 'relativePath']) &&
      typeof value.repoId === 'string' &&
      /^[A-Za-z0-9_-]+$/.test(value.repoId) &&
      isSafePublishedRelativePath(value.relativePath)
    );
  }
  if (value.kind === 'activity-card') {
    return (
      hasOnlyKeys(value, ['kind', 'sectionId']) &&
      typeof value.sectionId === 'string' &&
      value.sectionId.length > 0 &&
      value.sectionId.length <= 128
    );
  }
  return (
    (value.kind === 'file-explorer' ||
      value.kind === 'activity-section' ||
      value.kind === 'change-diagram') &&
    hasOnlyKeys(value, ['kind'])
  );
}

export function isSafePublishedRelativePath(value: unknown): value is string {
  return isSafePortableRelativePath(value);
}

function isSharedContainerStartPage(
  value: unknown,
): value is SharedContainerStartPage {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'file') {
    return (
      hasOnlyKeys(value, ['kind', 'repoId', 'relativePath']) &&
      typeof value.repoId === 'string' &&
      /^[A-Za-z0-9_-]+$/.test(value.repoId) &&
      isSafePublishedRelativePath(value.relativePath)
    );
  }
  return (
    value.kind === 'url' &&
    hasOnlyKeys(value, ['kind', 'url']) &&
    isSharedContainerWebPageUrl(value.url)
  );
}

function isPublishedPanelNode(
  value: unknown,
  allowWebPages: boolean,
  depth = 0,
): boolean {
  if (depth > 32 || !isRecord(value)) return false;
  if (
    typeof value.size !== 'number' ||
    !Number.isFinite(value.size) ||
    value.size < 0
  ) {
    return false;
  }
  if (value.type === 'leaf') {
    return (
      hasOnlyKeys(value, ['type', 'size', 'tabs', 'activeTabIndex']) &&
      Array.isArray(value.tabs) &&
      value.tabs.length <= 100 &&
      value.tabs.every((tab) => isPublishedPanel(tab, allowWebPages)) &&
      Number.isInteger(value.activeTabIndex) &&
      (value.tabs.length === 0
        ? value.activeTabIndex === 0
        : (value.activeTabIndex as number) >= 0 &&
          (value.activeTabIndex as number) < value.tabs.length)
    );
  }
  return (
    value.type === 'branch' &&
    hasOnlyKeys(value, ['type', 'size', 'children']) &&
    Array.isArray(value.children) &&
    value.children.length > 0 &&
    value.children.length <= 32 &&
    value.children.every((child) =>
      isPublishedPanelNode(child, allowWebPages, depth + 1),
    )
  );
}

/**
 * Validates a published layout. Web page browser panels are accepted only
 * with `allowWebPages`, which schema v5 sets.
 */
export function isSharedContainerPublishedLayout(
  value: unknown,
  options: { allowWebPages?: boolean } = {},
): value is SharedContainerPublishedLayout {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['orientation', 'root']) &&
    (value.orientation === 0 || value.orientation === 1) &&
    isPublishedPanelNode(value.root, options.allowWebPages === true)
  );
}

function isSharedContainerRevisionLayoutVersion(
  value: unknown,
  schemaVersion: 1 | 2 | 3 | 4 | 5,
): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'containerType',
      'title',
      'repositories',
      'files',
      'notes',
      'prompts',
      'attachmentPaths',
      'withheldFileCount',
      'withheldFileReasons',
      'run',
      ...(schemaVersion >= 3 ? ['layout'] : []),
      ...(schemaVersion >= 4 ? ['startPage'] : []),
    ]) ||
    value.schemaVersion !== schemaVersion ||
    typeof value.containerType !== 'string' ||
    !includesString(SHARED_CONTAINER_TYPES, value.containerType) ||
    typeof value.title !== 'string' ||
    value.title.trim().length === 0 ||
    value.title.length > MAX_SHARED_CONTAINER_TITLE_LENGTH ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > MAX_SHARED_CONTAINER_REPOSITORIES ||
    !value.repositories.every((repository) =>
      schemaVersion === 1
        ? isRevisionRepository(repository)
        : isRevisionRepository(repository) ||
          isRevisionSnapshotRepository(repository),
    ) ||
    !Array.isArray(value.files) ||
    !value.files.every(isRevisionCoworkFile) ||
    !Array.isArray(value.notes) ||
    !value.notes.every(isWorkspaceItem) ||
    !Array.isArray(value.prompts) ||
    !value.prompts.every(isWorkspaceItem) ||
    !isRecord(value.attachmentPaths) ||
    (value.withheldFileCount !== undefined &&
      (!Number.isInteger(value.withheldFileCount) ||
        (value.withheldFileCount as number) < 0)) ||
    (value.withheldFileReasons !== undefined &&
      (!Array.isArray(value.withheldFileReasons) ||
        !value.withheldFileReasons.every(
          (reason) =>
            typeof reason === 'string' &&
            includesString(SHARED_CONTAINER_WITHHELD_FILE_REASONS, reason),
        ))) ||
    (value.run !== undefined && !isRevisionRunConfig(value.run)) ||
    (schemaVersion >= 3 &&
      value.layout !== undefined &&
      !isSharedContainerPublishedLayout(value.layout, {
        allowWebPages: schemaVersion >= 5,
      })) ||
    (schemaVersion >= 4 &&
      value.startPage !== undefined &&
      !isSharedContainerStartPage(value.startPage))
  ) {
    return false;
  }
  const attachments = Object.values(value.attachmentPaths);
  if (!attachments.every(isAttachmentPath)) return false;
  const repositories = value.repositories as Array<
    | SharedContainerRevisionRepository
    | SharedContainerRevisionSnapshotRepository
  >;
  const hasSnapshotRepository = repositories.some(
    (repository) => 'source' in repository && repository.source === 'snapshot',
  );
  if (schemaVersion >= 4 && isRecord(value.startPage)) {
    const startPage = value.startPage;
    if (
      startPage.kind === 'file' &&
      !(
        (value.containerType === 'COWORK_WORK_ENTRY' &&
          startPage.repoId === 'workspace') ||
        (value.containerType === 'CODE_WORKTREE' &&
          repositories.some(
            (repository) => repository.repoId === startPage.repoId,
          ))
      )
    ) {
      return false;
    }
  }
  if (
    (schemaVersion === 1 && hasSnapshotRepository) ||
    (schemaVersion === 2 && !hasSnapshotRepository)
  ) {
    return false;
  }
  if (
    value.run !== undefined &&
    (value.containerType !== 'CODE_WORKTREE' ||
      value.run.commands.some(
        (command) =>
          !repositories.some(
            (repository) => repository.repoId === command.repoId,
          ),
      ))
  ) {
    return false;
  }
  if (
    (value.containerType === 'COWORK_WORK_ENTRY' &&
      value.repositories.length > 0) ||
    (value.containerType === 'CODE_WORKTREE' && value.files.length > 0)
  ) {
    return false;
  }
  const materializedFileCount =
    repositories.reduce((count, repository) => {
      if (!('source' in repository) || repository.source !== 'snapshot') {
        return count + repository.files.length;
      }
      const overlayDelta = repository.files.reduce(
        (delta, file) =>
          delta +
          (file.status === 'added' ? 1 : file.status === 'deleted' ? -1 : 0),
        0,
      );
      const repositoryFileCount =
        repository.snapshot.treeFileCount + overlayDelta;
      return repositoryFileCount < 0
        ? Number.POSITIVE_INFINITY
        : count + repositoryFileCount;
    }, 0) +
    value.files.length +
    value.notes.length +
    value.prompts.length +
    attachments.length;
  return materializedFileCount <= MAX_SHARED_CONTAINER_MATERIALIZED_FILES;
}

export function isSharedContainerRevisionLayout(
  value: unknown,
): value is SharedContainerRevisionLayout {
  return isSharedContainerRevisionLayoutVersion(value, 1);
}

export function isSharedContainerRevisionLayoutV2(
  value: unknown,
): value is SharedContainerRevisionLayoutV2 {
  return isSharedContainerRevisionLayoutVersion(value, 2);
}

export function isSharedContainerRevisionLayoutV3(
  value: unknown,
): value is SharedContainerRevisionLayoutV3 {
  return isSharedContainerRevisionLayoutVersion(value, 3);
}

export function isSharedContainerRevisionLayoutV4(
  value: unknown,
): value is SharedContainerRevisionLayoutV4 {
  return isSharedContainerRevisionLayoutVersion(value, 4);
}

export function isSharedContainerRevisionLayoutV5(
  value: unknown,
): value is SharedContainerRevisionLayoutV5 {
  return isSharedContainerRevisionLayoutVersion(value, 5);
}

/** Validates a `container.json` of any schema version this build reads. */
export function isAnySharedContainerRevisionLayout(
  value: unknown,
): value is AnySharedContainerRevisionLayout {
  return (
    isSharedContainerRevisionLayout(value) ||
    isSharedContainerRevisionLayoutV2(value) ||
    isSharedContainerRevisionLayoutV3(value) ||
    isSharedContainerRevisionLayoutV4(value) ||
    isSharedContainerRevisionLayoutV5(value)
  );
}

function isPublishedChatPart(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['kind', 'data', 'toolFamily']) &&
    typeof value.kind === 'string' &&
    value.kind.length > 0 &&
    value.kind.length <= 128 &&
    (value.toolFamily === undefined || typeof value.toolFamily === 'string')
  );
}

function isPublishedChatMessage(value: unknown): value is PortalChatMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'messageId',
      'chatId',
      'role',
      'status',
      'text',
      'parts',
      'createdAtMs',
      'updatedAtMs',
    ]) &&
    typeof value.messageId === 'string' &&
    typeof value.chatId === 'string' &&
    typeof value.role === 'string' &&
    includesString(['user', 'assistant', 'system'] as const, value.role) &&
    typeof value.status === 'string' &&
    includesString(
      ['streaming', 'complete', 'failed', 'cancelled'] as const,
      value.status,
    ) &&
    typeof value.text === 'string' &&
    (value.parts === undefined ||
      (Array.isArray(value.parts) && value.parts.every(isPublishedChatPart))) &&
    typeof value.createdAtMs === 'number' &&
    Number.isFinite(value.createdAtMs) &&
    (value.updatedAtMs === undefined ||
      (typeof value.updatedAtMs === 'number' &&
        Number.isFinite(value.updatedAtMs)))
  );
}

export function isSharedContainerPublishedChat(
  value: unknown,
): value is SharedContainerPublishedChat {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'schemaVersion',
      'chatId',
      'title',
      'createdAt',
      'description',
      'messages',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.chatId === 'string' &&
    value.chatId.length > 0 &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.description === undefined ||
      typeof value.description === 'string') &&
    Array.isArray(value.messages) &&
    value.messages.every(isPublishedChatMessage)
  );
}

function isPublishedPlanComment(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'author', 'remoteAuthor', 'body', 'createdAt']) &&
    typeof value.id === 'string' &&
    typeof value.author === 'string' &&
    includesString(['user', 'agent', 'remote'] as const, value.author) &&
    typeof value.body === 'string' &&
    typeof value.createdAt === 'string' &&
    ((value.author === 'remote' &&
      value.remoteAuthor !== undefined &&
      isRecord(value.remoteAuthor) &&
      hasOnlyKeys(value.remoteAuthor, ['userId', 'displayName']) &&
      typeof value.remoteAuthor.userId === 'string' &&
      (value.remoteAuthor.displayName === null ||
        typeof value.remoteAuthor.displayName === 'string')) ||
      (value.author !== 'remote' && value.remoteAuthor === undefined))
  );
}

function isPublishedPlanCommentAnchor(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'quote',
      'renderedText',
      'lineStart',
      'lineEnd',
      'planNodeId',
      'headingPath',
      'unanchored',
      'source',
      'diagramKind',
    ]) &&
    typeof value.quote === 'string' &&
    (value.renderedText === undefined ||
      typeof value.renderedText === 'string') &&
    (value.lineStart === undefined ||
      (Number.isSafeInteger(value.lineStart) &&
        (value.lineStart as number) >= 1)) &&
    (value.lineEnd === undefined ||
      (Number.isSafeInteger(value.lineEnd) &&
        (value.lineEnd as number) >= 1)) &&
    (value.planNodeId === undefined || typeof value.planNodeId === 'string') &&
    (value.headingPath === undefined ||
      (Array.isArray(value.headingPath) &&
        value.headingPath.every((item) => typeof item === 'string'))) &&
    (value.unanchored === undefined || typeof value.unanchored === 'boolean') &&
    (value.source === undefined ||
      value.source === 'document' ||
      value.source === 'diagram') &&
    (value.diagramKind === undefined ||
      value.diagramKind === 'sequence' ||
      value.diagramKind === 'logicDiff' ||
      value.diagramKind === 'dataModelDiff')
  );
}

function isPublishedPlanCommentThread(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'id',
      'status',
      'createdAt',
      'anchor',
      'anchorState',
      'comments',
    ]) &&
    typeof value.id === 'string' &&
    (value.status === 'open' || value.status === 'resolved') &&
    typeof value.createdAt === 'string' &&
    isPublishedPlanCommentAnchor(value.anchor) &&
    (value.anchorState === 'matched' || value.anchorState === 'outdated') &&
    Array.isArray(value.comments) &&
    value.comments.every(isPublishedPlanComment)
  );
}

export function isSharedContainerPublishedPlan(
  value: unknown,
): value is SharedContainerPublishedPlan {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'schemaVersion',
      'planId',
      'title',
      'content',
      'source',
      'reviewStatus',
      'createdAt',
      'updatedAt',
      'latestRevisionNumber',
      'approvedAt',
      'dismissedAt',
      'lastEditSource',
      'sourceRepoId',
      'sourceFilePath',
      'commentThreads',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.planId === 'string' &&
    value.planId.length > 0 &&
    typeof value.title === 'string' &&
    typeof value.content === 'string' &&
    typeof value.source === 'string' &&
    typeof value.reviewStatus === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    Number.isInteger(value.latestRevisionNumber) &&
    (value.approvedAt === undefined || typeof value.approvedAt === 'string') &&
    (value.dismissedAt === undefined ||
      typeof value.dismissedAt === 'string') &&
    (value.lastEditSource === undefined ||
      typeof value.lastEditSource === 'string') &&
    (value.sourceRepoId === undefined ||
      typeof value.sourceRepoId === 'string') &&
    (value.sourceFilePath === undefined ||
      typeof value.sourceFilePath === 'string') &&
    Array.isArray(value.commentThreads) &&
    value.commentThreads.every(isPublishedPlanCommentThread)
  );
}

function isArtifactDetail(
  value: unknown,
): value is SharedContainerArtifactDetail {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'artifactId',
      'path',
      'representation',
      'hash',
      'objectSizeBytes',
    ]) &&
    typeof value.artifactId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.representation === 'string' &&
    includesString(
      SHARED_CONTAINER_CONTENT_REPRESENTATIONS,
      value.representation,
    ) &&
    typeof value.hash === 'string' &&
    isUnsignedDecimal(value.objectSizeBytes)
  );
}

export function isSharedContainerManifest(
  value: unknown,
): value is SharedContainerManifest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'revisionId',
      'parentRevisionId',
      'schemaVersion',
      'artifacts',
    ]) &&
    typeof value.revisionId === 'string' &&
    value.revisionId.length > 0 &&
    (value.parentRevisionId === undefined ||
      (typeof value.parentRevisionId === 'string' &&
        value.parentRevisionId.length > 0)) &&
    typeof value.schemaVersion === 'number' &&
    Number.isInteger(value.schemaVersion) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isArtifactDetail)
  );
}

export function isSharedContainerCapabilitySet(
  value: unknown,
): value is SharedContainerCapability[] {
  return (
    isStringArray(value) &&
    value.length > 0 &&
    value.length <= MAX_SHARED_CONTAINER_CAPABILITIES &&
    new Set(value).size === value.length &&
    value.every((capability) =>
      includesString(SHARED_CONTAINER_CAPABILITIES, capability),
    )
  );
}

function isStageArtifact(
  value: unknown,
): value is SharedContainerStageArtifact {
  return (
    isRecord(value) &&
    typeof value.artifactId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.representation === 'string' &&
    includesString(
      SHARED_CONTAINER_CONTENT_REPRESENTATIONS,
      value.representation,
    ) &&
    typeof value.hash === 'string' &&
    typeof value.objectSizeBytes === 'string' &&
    (value.carriedFromParentRevision === undefined ||
      value.carriedFromParentRevision === true)
  );
}

/**
 * Shape gate for `POST .../revisions/stage`. Field *values* (UUID form, path
 * safety, quotas) are validated by the server and reported as 422; this guard
 * only establishes that the payload is structurally the declared request, so a
 * malformed `artifacts` element is a 400 rather than a crash.
 */
export function isSharedContainerStageRevisionRequest(
  value: unknown,
): value is SharedContainerStageRevisionRequest {
  return (
    isRecord(value) &&
    isSharedContainerPackageAttachment(value) &&
    (value.organizationId === undefined ||
      typeof value.organizationId === 'string') &&
    typeof value.title === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.sourceDeviceId === 'string' &&
    typeof value.schemaVersion === 'number' &&
    (value.parentRevisionId === undefined ||
      typeof value.parentRevisionId === 'string') &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isStageArtifact)
  );
}

export function isSharedContainerCreateRequest(
  value: unknown,
): value is SharedContainerCreateRequest {
  if (!isRecord(value)) return false;
  if (
    (value.worktreeId !== undefined && typeof value.worktreeId !== 'string') ||
    (value.cloudChatId !== undefined && typeof value.cloudChatId !== 'string')
  ) {
    return false;
  }
  const hasWorktree = typeof value.worktreeId === 'string';
  const hasCloudChat = typeof value.cloudChatId === 'string';
  const recipient = value.recipient;
  const hasCanonicalRecipient =
    isRecord(recipient) &&
    ((recipient.kind === 'member' && typeof recipient.userId === 'string') ||
      (recipient.kind === 'email' && typeof recipient.email === 'string'));
  const hasLegacyRecipient = typeof value.recipientUserId === 'string';
  return (
    (value.organizationId === undefined ||
      typeof value.organizationId === 'string') &&
    hasWorktree !== hasCloudChat &&
    hasCanonicalRecipient !== hasLegacyRecipient &&
    isSharedContainerCapabilitySet(value.capabilities)
  );
}

function includesString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

export function isSharedContainerRef(
  value: unknown,
): value is SharedContainerRef {
  if (!isRecord(value)) return false;
  if (
    (value.worktreeId !== undefined && typeof value.worktreeId !== 'string') ||
    (value.cloudChatId !== undefined && typeof value.cloudChatId !== 'string')
  ) {
    return false;
  }
  const hasWorktree = typeof value.worktreeId === 'string';
  const hasCloudChat = typeof value.cloudChatId === 'string';
  const isCloud = value.containerType === 'CLOUD_CHAT';
  return (
    typeof value.id === 'string' &&
    (value.organizationId === undefined ||
      typeof value.organizationId === 'string') &&
    typeof value.ownerUserId === 'string' &&
    isRecord(value.owner) &&
    typeof value.owner.userId === 'string' &&
    typeof value.owner.name === 'string' &&
    (value.owner.image === undefined ||
      typeof value.owner.image === 'string') &&
    (value.organizationName === undefined ||
      typeof value.organizationName === 'string') &&
    (value.access === 'organization' || value.access === 'direct') &&
    hasWorktree !== hasCloudChat &&
    isCloud === hasCloudChat &&
    typeof value.containerType === 'string' &&
    includesString(SHARED_CONTAINER_TYPES, value.containerType) &&
    (value.backend === undefined ||
      value.backend === (isCloud ? 'cloud' : 'desktop'))
  );
}

export function isSharedContainerSummary(
  value: unknown,
): value is SharedContainerSummary {
  const record = isRecord(value) ? value : null;
  return (
    isSharedContainerRef(value) &&
    record !== null &&
    typeof record.title === 'string' &&
    record.title.trim().length > 0 &&
    record.title.length <= MAX_SHARED_CONTAINER_TITLE_LENGTH &&
    typeof record.revision === 'number' &&
    Number.isInteger(record.revision) &&
    record.revision >= 0 &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    isSharedContainerCapabilitySet(record.capabilities) &&
    (record.cloudWorkspace === undefined ||
      (record.containerType === 'CLOUD_CHAT' &&
        isRecord(record.cloudWorkspace) &&
        typeof record.cloudWorkspace.id === 'string' &&
        record.cloudWorkspace.id.trim().length > 0 &&
        typeof record.cloudWorkspace.name === 'string' &&
        record.cloudWorkspace.name.trim().length > 0))
  );
}

export function isDismissedSharedContainerSummary(
  value: unknown,
): value is DismissedSharedContainerSummary {
  return (
    isSharedContainerSummary(value) &&
    isRecord(value) &&
    typeof value.dismissedAt === 'string' &&
    !Number.isNaN(Date.parse(value.dismissedAt))
  );
}

export function isListDismissedSharedContainersResponse(
  value: unknown,
): value is ListDismissedSharedContainersResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.containers) &&
    value.containers.every(isDismissedSharedContainerSummary) &&
    (value.nextCursor === null || typeof value.nextCursor === 'string')
  );
}

export function isRestoreSharedContainerResponse(
  value: unknown,
): value is RestoreSharedContainerResponse {
  return isRecord(value) && isSharedContainerSummary(value.container);
}

export function isSharedContainerDetail(
  value: unknown,
): value is SharedContainerDetail {
  const record = isRecord(value) ? value : null;
  return (
    isSharedContainerSummary(value) &&
    record !== null &&
    (record.latestRevision === undefined ||
      (isRecord(record.latestRevision) &&
        typeof record.latestRevision.id === 'string' &&
        typeof record.latestRevision.revision === 'number' &&
        Number.isInteger(record.latestRevision.revision) &&
        record.latestRevision.revision >= 0 &&
        record.latestRevision.revision === record.revision &&
        typeof record.latestRevision.schemaVersion === 'number' &&
        Number.isInteger(record.latestRevision.schemaVersion) &&
        record.latestRevision.schemaVersion >= 0 &&
        typeof record.latestRevision.sourceDeviceId === 'string' &&
        typeof record.latestRevision.artifactObjectKey === 'string' &&
        typeof record.latestRevision.artifactHash === 'string' &&
        typeof record.latestRevision.artifactSizeBytes === 'string' &&
        isUnsignedDecimal(record.latestRevision.artifactSizeBytes) &&
        typeof record.latestRevision.createdAt === 'string' &&
        (record.latestRevision.package === undefined ||
          isSharedContainerRevisionPackage(record.latestRevision.package)) &&
        (record.latestRevision.parentRevisionId === undefined ||
          typeof record.latestRevision.parentRevisionId === 'string') &&
        (record.latestRevision.actorUserId === undefined ||
          typeof record.latestRevision.actorUserId === 'string') &&
        (record.latestRevision.artifacts === undefined ||
          (Array.isArray(record.latestRevision.artifacts) &&
            record.latestRevision.artifacts.every(isArtifactDetail))) &&
        (record.latestRevision.artifactCount === undefined ||
          (typeof record.latestRevision.artifactCount === 'number' &&
            Number.isInteger(record.latestRevision.artifactCount) &&
            record.latestRevision.artifactCount >= 0 &&
            record.latestRevision.artifactCount <=
              MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION)) &&
        (record.latestRevision.totalSizeBytes === undefined ||
          isUnsignedDecimal(record.latestRevision.totalSizeBytes)) &&
        (record.latestRevision.artifacts === undefined ||
          record.latestRevision.artifactCount === undefined ||
          record.latestRevision.artifacts.length ===
            record.latestRevision.artifactCount)))
  );
}
