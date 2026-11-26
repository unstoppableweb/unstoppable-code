/**
 * Organization projects wire contract (CAN-611, epic; DTOs per CAN-2944).
 *
 * A project (internally a "tracked workspace") is a durable definition owned
 * by exactly one user or organization. These shapes cross the desktop bearer
 * API and the organization admin routes. Every id is an external UUID; the
 * server never exposes internal ids. Environment-neutral: no React, Node,
 * Electron, or app imports.
 */

import type { WorkspaceContextOrganizationRole } from '../workspace-context';
export * from './shared-multi-repo';

/**
 * Manage organization project definitions and access: OWNER or ADMIN, matching
 * the web server's `canManageProjects` policy. This role fact does not replace
 * the server's live membership and grant checks.
 */
export function canManageOrganizationProjects(
  role: WorkspaceContextOrganizationRole,
): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function organizationProjectsPath(organizationId: string): string {
  return `/organization/${encodeURIComponent(organizationId)}/projects`;
}

export function organizationIntegrationsPath(organizationId: string): string {
  return `/organization/${encodeURIComponent(organizationId)}/settings?tab=integrations`;
}

/** Raw repository URL bound at the desktop IPC and Portal command boundaries. */
export const ORG_REPOSITORY_OWNER_URL_MAX_LENGTH = 2048;

export interface OrgRepositoryOwnerMatch {
  kind: 'organization';
  organizationId: string;
  organizationName: string;
  projectId: string;
  projectName: string;
  /** `owner/name` as shown on GitHub. */
  repositoryName: string;
}

/** No match, ambiguity, failure, or timeout: the lookup is advisory. */
export type OrgRepositoryOwnerLookup =
  | { kind: 'none' }
  | OrgRepositoryOwnerMatch;

/** Preserve the desktop boundary's acceptance semantics for lookup results. */
export function isOrgRepositoryOwnerLookup(
  value: unknown,
): value is OrgRepositoryOwnerLookup {
  if (!isRecordValue(value)) return false;
  if (value.kind === 'none') return true;
  return (
    value.kind === 'organization' &&
    typeof value.organizationId === 'string' &&
    typeof value.organizationName === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.projectName === 'string' &&
    typeof value.repositoryName === 'string'
  );
}

export const ORG_PROJECT_PREFERENCES = [
  'FOLLOW_DEFAULTS',
  'ADDED',
  'DISMISSED',
] as const;
export type OrgProjectPreference = (typeof ORG_PROJECT_PREFERENCES)[number];

export function isOrgProjectPreference(
  value: unknown,
): value is OrgProjectPreference {
  return (
    typeof value === 'string' &&
    ORG_PROJECT_PREFERENCES.some((preference) => preference === value)
  );
}

export type OrgProjectState = 'ACTIVE' | 'ARCHIVED' | 'DELETED';
export type OrgProjectKind = 'CODE' | 'COWORK';
export type OrgProjectPurpose = 'project' | 'default-chats';
export type OrgProjectVisibility = 'organization' | 'private';
export type OrgProjectLocation = 'LOCAL' | 'CLOUD';
/** How many repositories a definition has (CAN-3532). */
export type OrgProjectTopology = 'single-repo' | 'multi-repo';
export type OrgProjectRepositoryVerification =
  | 'VERIFIED'
  | 'STALE'
  | 'UNVERIFIED';

/** GitHub's repository visibility (CAN-3489). */
export type OrgProjectRepositoryVisibility = 'PUBLIC' | 'PRIVATE' | 'INTERNAL';

export interface OrgProjectRepository {
  provider: 'github';
  host: string;
  owner: string;
  name: string;
  /** Provider's immutable repository id (GitHub numeric id as a string). */
  providerRepoId: string | null;
  defaultBranch: string | null;
  verification: OrgProjectRepositoryVerification;
  /**
   * GitHub metadata the server copies from the organization's GitHub App
   * installation while seeding or refreshing (CAN-3489). Absent (or `null`)
   * until a refresh has read the repository, and for Personal projects.
   */
  description?: string | null;
  visibility?: OrgProjectRepositoryVisibility | null;
  /** When the repository last changed on GitHub (its latest push), ISO 8601. */
  updatedAt?: string | null;
}

export type OrgProjectInstanceState =
  | 'CLAIMED'
  | 'READY'
  | 'DETACHED'
  | 'ACCESS_REVOKED';

export interface OrgProjectCapabilities {
  /** Manage the definition and its grants (organization OWNER/ADMIN, or the Personal owner). */
  administer: boolean;
  /** Organization Cloud capacity/budget management; organization OWNER only. */
  manageCloud: boolean;
  /** Materialize and work in an ACTIVE project (an effective grant, or the Personal owner). */
  use: boolean;
}

export interface OrgProjectSummary {
  /** Absent on older servers; callers must leave inherited local state untouched. */
  privateMemory?: boolean;
  /** Definition external id. */
  id: string;
  /** Owning organization external id; `null` for a Personal definition. */
  organizationId: string | null;
  name: string;
  description: string | null;
  kind: OrgProjectKind;
  purpose: OrgProjectPurpose;
  visibility: OrgProjectVisibility;
  /** Created by a member for themselves rather than by an administrator or seeder. */
  memberOwned: boolean;
  location: OrgProjectLocation;
  /** The primary repository; `null` for repository-less definitions. */
  repository: OrgProjectRepository | null;
  /**
   * `multi-repo` for a definition with several repositories, such as a
   * member's converted multi-repo project (CAN-3532). Servers that predate the
   * field omit it, which means `single-repo`.
   */
  topology?: OrgProjectTopology;
  /** Complete ordered definition, additive for older peers. */
  repositories?: readonly OrgProjectRepository[];
  repositoryCount?: number;
  repositoriesComplete?: boolean;
  /** Unknown versions must not be used for multi-repository setup. */
  materializationVersion?: number;
  state: OrgProjectState;
  revision: number;
  authorizationVersion: number;
  /** OR over the caller's effective grants; always `true` for the Personal owner. */
  defaultListed: boolean;
  preference: OrgProjectPreference;
  /** Server-computed listing decision (plan chapter 02). */
  listed: boolean;
  capabilities: OrgProjectCapabilities;
  /** The caller's own instance on the requesting device, when known. */
  instance: { id: string; state: OrgProjectInstanceState } | null;
}

/**
 * Whether a device can set the project up from the catalog. A multi-repository
 * definition (CAN-3532) exists only as a member's multi-repo project converted
 * in place on the device that holds it; the catalog cannot clone it anywhere
 * else yet, so it never offers that setup.
 */
export function isOrgProjectCatalogSetupSupported(
  project: Pick<OrgProjectSummary, 'topology'> & Partial<OrgProjectSummary>,
): boolean {
  if (project.topology !== 'multi-repo') return true;
  return (
    project.organizationId !== null &&
    typeof project.organizationId === 'string' &&
    project.visibility === 'organization' &&
    project.memberOwned === false &&
    project.kind === 'CODE' &&
    project.location === 'LOCAL' &&
    project.purpose === 'project' &&
    hasCompleteOrgProjectRepositories(project)
  );
}

/** Validate the entire versioned materialization projection before any clone. */
export function hasCompleteOrgProjectRepositories(
  project: Partial<OrgProjectSummary>,
): boolean {
  const repositories = project.repositories;
  if (
    project.materializationVersion !== 1 ||
    project.repositoriesComplete !== true ||
    !Number.isSafeInteger(project.revision) ||
    (project.revision ?? 0) < 1 ||
    !repositories ||
    repositories.length < 1 ||
    repositories.length > 32 ||
    project.repositoryCount !== repositories.length ||
    !project.repository
  )
    return false;
  const ids = new Set<string>();
  const coordinates = new Set<string>();
  for (const repository of repositories) {
    if (
      !isOrgProjectRepository(repository) ||
      repository.host !== 'github.com' ||
      !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(repository.owner) ||
      !/^[a-z\d_.-]+$/i.test(repository.name) ||
      repository.name === '.' ||
      repository.name === '..' ||
      (repository.providerRepoId !== null &&
        !/^[1-9]\d*$/.test(repository.providerRepoId))
    )
      return false;
    const coordinate =
      `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();
    const id =
      repository.providerRepoId === null
        ? coordinate
        : `${repository.provider}:${repository.host}:${repository.providerRepoId}`;
    if (ids.has(id) || coordinates.has(coordinate)) return false;
    ids.add(id);
    coordinates.add(coordinate);
  }
  const primary = repositories[0];
  return (
    primary !== undefined &&
    primary.provider === project.repository.provider &&
    primary.host === project.repository.host &&
    primary.owner === project.repository.owner &&
    primary.name === project.repository.name &&
    primary.providerRepoId === project.repository.providerRepoId &&
    primary.defaultBranch === project.repository.defaultBranch
  );
}

export function isOrgProjectRepository(
  value: unknown,
): value is OrgProjectRepository {
  return (
    isRecordValue(value) &&
    value.provider === 'github' &&
    typeof value.host === 'string' &&
    typeof value.owner === 'string' &&
    typeof value.name === 'string' &&
    (value.providerRepoId === null ||
      typeof value.providerRepoId === 'string') &&
    (value.defaultBranch === null || typeof value.defaultBranch === 'string') &&
    (value.verification === 'VERIFIED' ||
      value.verification === 'STALE' ||
      value.verification === 'UNVERIFIED') &&
    hasValidRepositoryMetadata(value)
  );
}

/** A catalog row that should appear as a setup placeholder on this device. */
export function isOrgProjectPlaceholder(
  project: Pick<OrgProjectSummary, 'instance' | 'listed' | 'state'>,
): boolean {
  return (
    project.listed &&
    project.state === 'ACTIVE' &&
    project.instance?.state !== 'READY'
  );
}

/**
 * Who a grant is for. `organization` (CAN-3411) is the "everyone" grant: every
 * current member of the project's owning organization, evaluated from live
 * membership, so people who join later are included and people who leave are
 * not. It carries no id because the organization is the project owner, it is
 * at most one per project, and it is never listed by default.
 */
export type OrgProjectGrantPrincipal =
  | { type: 'user'; userId: string }
  | { type: 'team'; teamId: string }
  | { type: 'organization' };

export interface OrgProjectGrant {
  principal: OrgProjectGrantPrincipal;
  /** Always `false` for an `organization` principal. */
  defaultListed: boolean;
}

export interface OrgProjectDetail extends OrgProjectSummary {
  grants: OrgProjectGrant[];
  createdBy: { id: string; name: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface OrgProjectPage<T> {
  data: T[];
  /** Opaque digest of the page contents; changes when any row changes. */
  revision: string;
  nextCursor: string | null;
}

export type OrgProjectCatalogResponse = OrgProjectPage<OrgProjectSummary>;

/** Upper validation bounds (plan chapter 05). */
export const ORG_PROJECT_LIMITS = {
  nameLength: 256,
  descriptionLength: 1024,
  repositoriesPerCreate: 32,
  grantsPerProject: 500,
  catalogPageSize: 500,
} as const;

/** Member-created definitions per member and organization; archived count, deleted do not. */
export const MEMBER_ORG_PROJECT_LIMIT = 100;

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

export interface CreateOrgProjectRepositoryInput {
  /** Provider's immutable repository id; the server verifies it against the organization's installation when a verifier is configured. */
  providerRepoId: string;
  owner: string;
  name: string;
  defaultBranch?: string | null;
  /** Definition name; defaults to the repository name. */
  displayName?: string;
}

export interface CreateOrgProjectsRequest {
  privateMemory?: boolean;
  /** One single-repository definition is created per entry (at most 32). */
  repositories: CreateOrgProjectRepositoryInput[];
  /** Applied to every created definition. */
  grants: OrgProjectGrant[];
}

export interface CreateOrgProjectOutcome {
  providerRepoId: string;
  outcome: 'created' | 'exists' | 'error';
  project?: OrgProjectDetail;
  error?: string;
}

export interface CreateOrgProjectsResponse {
  results: CreateOrgProjectOutcome[];
}

export interface EnsureOrgDefaultChatsRequest {
  organizationId: string;
}

export type EnsureOrgDefaultChatsResponse = OrgProjectSummary;

export type CreateMemberOrgProjectRequest =
  | {
      organizationId: string;
      creationKey?: string;
      kind: 'COWORK';
      name: string;
      privateMemory?: boolean;
    }
  | {
      organizationId: string;
      creationKey?: string;
      kind: 'CODE';
      name: string;
      privateMemory?: boolean;
      repository: {
        host: 'github.com';
        owner: string;
        name: string;
      } | null;
    };

export type CreateMemberOrgProjectResponse = OrgProjectSummary;

/**
 * Body of `POST /api/v1/projects/member/multi-repo` (CAN-3532): the member's
 * private, multi-repository organization project for one of their Personal
 * multi-repo projects, which the desktop then binds in place. Idempotent per
 * member, organization and `localWorkspaceId`: a retry returns the same
 * definition.
 */
export interface CreateMemberMultiRepoOrgProjectRequest {
  privateMemory?: boolean;
  organizationId: string;
  /** Definition name; the local project's name. */
  name: string;
  /**
   * Opaque creation subject the server keys the member's receipt on; never a
   * path. Usually the multi-repo project's local workspace id, but not
   * necessarily one: a shared-container copy sends a subject derived from its
   * creation key (`shared-container-fork:<key>`, CAN-4856) so a retry replays
   * the same project while the local workspace gets an ordinary id.
   */
  localWorkspaceId: string;
  /**
   * For each repository of the local project, in its order, the organization
   * project whose repository it is: an ACTIVE, organization-visible,
   * single-repository local code project the member can use. The server
   * copies each one's repository and refuses anything else. Empty for a
   * project created from Add project (CAN-3546), whose repositories are added
   * afterwards in its settings.
   */
  repositoryProjectIds: string[];
}

export type CreateMemberMultiRepoOrgProjectResponse = OrgProjectSummary;

/**
 * Body of `PATCH /api/v1/projects/member/multi-repo/:projectId` (CAN-3546):
 * replace the repositories of the caller's own member multi-repo project
 * when its local project's repositories change in settings. The ids follow
 * the same rule as {@link CreateMemberMultiRepoOrgProjectRequest}; an empty
 * list leaves the project without repositories.
 */
export interface UpdateMemberMultiRepoOrgProjectRequest {
  repositoryProjectIds: string[];
}

export type UpdateMemberMultiRepoOrgProjectResponse = OrgProjectSummary;

/**
 * Body of `POST /api/v1/projects/repositories/refresh` (CAN-3489): a member
 * opening the desktop Add project dialog asks the server to re-read the
 * organization's repositories from GitHub through the seeding pass.
 */
export interface RefreshOrgProjectRepositoriesRequest {
  organizationId: string;
}

/**
 * `refreshed`: this request's refresh finished. `recent`: a refresh started
 * less than a minute ago, so none ran. `timed-out`: the refresh is still
 * running and its result is not in the catalog yet. `failed`: GitHub or the
 * write failed. `not-connected`: the organization has no active GitHub
 * connection, so there is nothing to read.
 */
export const ORG_PROJECT_REPOSITORY_REFRESH_STATUSES = [
  'refreshed',
  'recent',
  'timed-out',
  'failed',
  'not-connected',
] as const;
export type OrgProjectRepositoryRefreshStatus =
  (typeof ORG_PROJECT_REPOSITORY_REFRESH_STATUSES)[number];

export interface RefreshOrgProjectRepositoriesResponse {
  status: OrgProjectRepositoryRefreshStatus;
}

export interface UpdateOrgProjectRequest {
  privateMemory?: boolean;
  /** The revision the caller last saw; a mismatch is a 409. */
  revision: number;
  name?: string;
  description?: string | null;
}

export interface ReplaceOrgProjectGrantsRequest {
  authorizationVersion: number;
  grants: OrgProjectGrant[];
  /** Required the first time a private member project is shared. */
  confirmShare?: boolean;
}

export interface SetOrgProjectPreferenceRequest {
  preference: OrgProjectPreference;
}

export type OrgProjectLifecycleAction = 'archive' | 'restore' | 'delete';

export interface OrgProjectLifecycleRequest {
  revision: number;
  action: OrgProjectLifecycleAction;
}

/** The project after a lifecycle action. */
export interface OrgProjectLifecycleResult extends OrgProjectDetail {
  /**
   * After an archive, for an organization owner or admin: the organization's
   * shared connections the project used that no active project uses now, so
   * the page can offer to disconnect them (CAN-6253). Absent when there are
   * none, for other actions and for anyone else. An older server never sends
   * it, so the page offers nothing.
   */
  sharedConnectionsToDisconnect?: { id: string; name: string }[];
}

export interface ClaimOrgProjectInstanceRequest {
  materializationVersion?: 1;
  expectedDefinitionRevision?: number;
  /** Stable per actor and device; a replay with a different body is a 409. */
  idempotencyKey: string;
  /** The desktop's portal `clientDeviceId`. */
  deviceId: string;
  installationGeneration: number;
  /** Opaque local workspace id; never an absolute path. */
  localWorkspaceId: string;
  /**
   * Reclaim (CAN-3129, `org-project-reclaim-v1`): replace this device's own
   * claim whose lease lapsed before completion, for a checkout it already
   * promoted and bound. The server verifies that the named claim is still
   * the instance's current one and refuses (409) anything else — a detached
   * instance, a moved fence, another device or another workspace id — rather
   * than creating or reviving a claim.
   */
  reclaim?: OrgProjectReclaimTarget;
}

/** The lapsed claim a reclaim replaces, exactly as the claim returned it. */
export interface OrgProjectReclaimTarget {
  instanceId: string;
  operationId: string;
  fencingGeneration: number;
}

export interface ClaimOrgProjectInstanceResponse {
  project?: OrgProjectSummary;
  definitionRevision?: number;
  instanceId: string;
  operationId: string;
  /** Echoed back on completion so a stale attempt cannot finish a newer claim. */
  fencingGeneration: number;
  state: OrgProjectInstanceState;
  /**
   * The project's lifecycle event cursor when this answer was made (CAN-5189),
   * in the opaque format of `GET /api/v1/projects/{projectId}/events`: every
   * event after it happened after the claim was answered, so a device follows
   * the feed from here. Absent from servers that predate it.
   */
  eventsCursor?: string;
}

/**
 * What a claim refused with `409 conflict` names as its cause, in the error
 * body's `reason`. The code stays `conflict`, which shipped desktops branch
 * on. A client that acts differently on these causes reads the reason and
 * treats a conflict without a reason it knows as none of them.
 */
export const ORG_PROJECT_CLAIM_CONFLICT_REASONS = {
  /** The account already has as many active setups as it may. */
  instanceLimit: 'instance_limit',
  /** The account has recorded as many device setups of this project as it may. */
  projectInstanceLimit: 'project_instance_limit',
  /** The setup's claim has been joined under as many other keys as it may. */
  claimAliasLimit: 'claim_alias_limit',
  /** Another checkout of the same device installation holds the project's setup. */
  checkoutConflict: 'checkout_conflict',
  /** The key's claim was released or replaced; a claim under a new key may succeed. */
  claimInvalid: 'claim_invalid',
  /** The key was already used for a claim with a different body; a new key may succeed. */
  idempotencyMismatch: 'idempotency_mismatch',
} as const;
export type OrgProjectClaimConflictReason =
  (typeof ORG_PROJECT_CLAIM_CONFLICT_REASONS)[keyof typeof ORG_PROJECT_CLAIM_CONFLICT_REASONS];

export interface CompleteOrgProjectInstanceRequest {
  expectedDefinitionRevision?: number;
  operationId: string;
  fencingGeneration: number;
  outcome: 'ready' | 'failed';
  errorCode?: string;
}

export interface OrgProjectInstanceView {
  instanceId: string;
  state: OrgProjectInstanceState;
  readyAt: string | null;
}

/**
 * Body of `POST /api/v1/projects/:projectId/activity-transfer` and its
 * `/reverse` counterpart (CAN-3418): the converted checkout whose
 * already-uploaded Personal activity moves to the project's organization, or
 * returns to Personal.
 */
export interface OrgProjectActivityTransferRequest {
  /** Opaque local workspace id of the converted checkout; never a path. */
  localWorkspaceId: string;
  /**
   * Repair of activity filed under the wrong scope (CAN-3517): the kinds of
   * activity the member does not share with the organization. When the rows
   * that would move hold any of them, the move is refused
   * (`403 scope_prohibited`) and nothing changes. A conversion's move omits
   * it: the project's past activity moves with the project.
   */
  withheldKinds?: OrgProjectActivityKind[];
}

/** Activity kinds a member can withhold from a repair move (CAN-3517). */
export const ORG_PROJECT_ACTIVITY_KINDS = [
  'transcripts',
  'plans',
  'summaries',
] as const;
export type OrgProjectActivityKind =
  (typeof ORG_PROJECT_ACTIVITY_KINDS)[number];

/**
 * Body of `POST /api/v1/projects/personal/activity-return` (CAN-3517): a
 * Personal checkout (bound to no organization project) whose activity was
 * uploaded to an organization before CAN-3515. The member's organization rows
 * for that checkout return to Personal.
 */
export interface PersonalActivityReturnRequest {
  /** Opaque local workspace id of the Personal checkout; never a path. */
  localWorkspaceId: string;
}

/**
 * `returned` moved rows now; `nothing-to-return` means no organization holds
 * this member's activity for the checkout (or it was already returned).
 */
export type PersonalActivityReturnOutcome = 'returned' | 'nothing-to-return';

export interface PersonalActivityReturnResponse {
  outcome: PersonalActivityReturnOutcome;
  /** One recorded transfer per organization the activity returned from. */
  transferIds: string[];
  /** What the recorded transfers changed, summed; `null` when none. */
  counts: OrgProjectActivityTransferCounts | null;
}

/**
 * `moved`/`returned` changed ownership now. `already-moved` and
 * `nothing-to-return` are replays; `nothing-to-move` means the member uploaded
 * no Personal activity for this checkout.
 */
export type OrgProjectActivityTransferOutcome =
  | 'moved'
  | 'already-moved'
  | 'nothing-to-move'
  | 'returned'
  | 'nothing-to-return';

export interface OrgProjectActivityTransferCounts {
  worktrees: number;
  turns: number;
  plans: number;
  pullRequests: number;
  /** Personal pull requests the organization already held its own row for. */
  skippedPullRequests: number;
  pipelineRuns: number;
  /** Bodies re-encrypted from the historical owner-bound AAD. */
  rekeyedBodies: number;
}

export interface OrgProjectActivityTransferResponse {
  outcome: OrgProjectActivityTransferOutcome;
  /**
   * The recorded move; `null` when nothing was ever moved. When the
   * checkout's activity moved as two telemetry workspaces (its bare and its
   * private fallback id, CAN-3601), the bare id's move.
   */
  transferId: string | null;
  /**
   * What the recorded moves changed, summed; `null` when nothing was ever
   * moved.
   */
  counts: OrgProjectActivityTransferCounts | null;
}

/** Desktop-side setup lifecycle for one project on this device (CAN-2944). */
export type OrgProjectSetupState =
  | 'claiming'
  | 'materializing'
  | 'ready'
  | 'failed'
  | 'cancelled';

/** One progress report for a project setup; the latest report wins. */
export interface OrgProjectSetupProgress {
  errorCode?: string;
  projectId: string;
  /** Instance id once the claim succeeded; `null` while claiming or after failure. */
  instanceId: string | null;
  state: OrgProjectSetupState;
  /** Short status line for the UI; `null` when the state speaks for itself. */
  message: string | null;
  /** 0-100 when the current step reports progress; `null` otherwise. */
  percent: number | null;
  updatedAt: string;
}

/**
 * The catalog for one workspace context as a client holds it: every page
 * merged, keyed by the serialized context (`personal` or `org:<uuid>`).
 */
export interface OrgProjectCatalogSnapshot {
  context: string;
  /** First-page revision of the most recent fetch; not an ETag for merged pages. */
  revision: string;
  projects: OrgProjectSummary[];
  fetchedAt: string;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The optional GitHub metadata fields, when present, are well formed. */
function hasValidRepositoryMetadata(
  repository: Record<string, unknown>,
): boolean {
  const { description, visibility, updatedAt } = repository;
  return (
    (description === undefined ||
      description === null ||
      typeof description === 'string') &&
    (visibility === undefined ||
      visibility === null ||
      visibility === 'PUBLIC' ||
      visibility === 'PRIVATE' ||
      visibility === 'INTERNAL') &&
    (updatedAt === undefined ||
      updatedAt === null ||
      (typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))))
  );
}

export function isRefreshOrgProjectRepositoriesResponse(
  value: unknown,
): value is RefreshOrgProjectRepositoriesResponse {
  return (
    isRecordValue(value) &&
    ORG_PROJECT_REPOSITORY_REFRESH_STATUSES.some(
      (status) => status === value.status,
    )
  );
}

function validRepositoryProjection(value: Record<string, unknown>): boolean {
  if (
    !Array.isArray(value.repositories) ||
    !value.repositories.every(isOrgProjectRepository) ||
    typeof value.repositoryCount !== 'number' ||
    !Number.isSafeInteger(value.repositoryCount) ||
    value.repositoryCount < value.repositories.length ||
    typeof value.repositoriesComplete !== 'boolean' ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== 'number' ||
    value.revision < 1
  )
    return false;
  if (!value.repositoriesComplete) return true;
  if (value.repositoryCount !== value.repositories.length) return false;
  if (value.repositories.length === 0) return value.repository === null;
  if (!isOrgProjectRepository(value.repository)) return false;
  const first = value.repositories[0];
  if (
    !first ||
    first.host !== value.repository.host ||
    first.owner !== value.repository.owner ||
    first.name !== value.repository.name ||
    first.providerRepoId !== value.repository.providerRepoId ||
    first.defaultBranch !== value.repository.defaultBranch
  )
    return false;
  const identities = new Set<string>();
  const coordinates = new Set<string>();
  for (const repository of value.repositories) {
    const coordinate =
      `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();
    const id =
      `${repository.host}/${repository.providerRepoId ?? coordinate}`.toLowerCase();
    if (
      !repository.host ||
      !repository.owner ||
      !repository.name ||
      identities.has(id) ||
      coordinates.has(coordinate)
    )
      return false;
    identities.add(id);
    coordinates.add(coordinate);
  }
  return true;
}

/** Wire guard for one catalog row; tolerant of optional server additions. */
export function isOrgProjectSummary(
  value: unknown,
): value is OrgProjectSummary {
  if (!isRecordValue(value)) return false;
  return (
    (value.materializationVersion !== 1 || validRepositoryProjection(value)) &&
    typeof value.id === 'string' &&
    (value.organizationId === null ||
      typeof value.organizationId === 'string') &&
    typeof value.name === 'string' &&
    (value.description === null || typeof value.description === 'string') &&
    (value.kind === 'CODE' || value.kind === 'COWORK') &&
    (value.purpose === 'project' || value.purpose === 'default-chats') &&
    (value.visibility === 'organization' || value.visibility === 'private') &&
    typeof value.memberOwned === 'boolean' &&
    (value.location === 'LOCAL' || value.location === 'CLOUD') &&
    (value.repository === null ||
      (isRecordValue(value.repository) &&
        value.repository.provider === 'github' &&
        typeof value.repository.host === 'string' &&
        typeof value.repository.owner === 'string' &&
        typeof value.repository.name === 'string' &&
        (value.repository.providerRepoId === null ||
          typeof value.repository.providerRepoId === 'string') &&
        (value.repository.defaultBranch === null ||
          typeof value.repository.defaultBranch === 'string') &&
        (value.repository.verification === 'VERIFIED' ||
          value.repository.verification === 'STALE' ||
          value.repository.verification === 'UNVERIFIED') &&
        hasValidRepositoryMetadata(value.repository))) &&
    (value.topology === undefined ||
      value.topology === 'single-repo' ||
      value.topology === 'multi-repo') &&
    (value.repositories === undefined ||
      (Array.isArray(value.repositories) &&
        value.repositories.every(isOrgProjectRepository))) &&
    (value.repositoryCount === undefined ||
      (Number.isSafeInteger(value.repositoryCount) &&
        typeof value.repositoryCount === 'number' &&
        value.repositoryCount >= 0)) &&
    (value.repositoriesComplete === undefined ||
      typeof value.repositoriesComplete === 'boolean') &&
    (value.materializationVersion === undefined ||
      (typeof value.materializationVersion === 'number' &&
        Number.isSafeInteger(value.materializationVersion))) &&
    (value.privateMemory === undefined ||
      typeof value.privateMemory === 'boolean') &&
    (value.state === 'ACTIVE' || value.state === 'ARCHIVED') &&
    typeof value.revision === 'number' &&
    typeof value.authorizationVersion === 'number' &&
    typeof value.defaultListed === 'boolean' &&
    isOrgProjectPreference(value.preference) &&
    typeof value.listed === 'boolean' &&
    isRecordValue(value.capabilities) &&
    typeof value.capabilities.administer === 'boolean' &&
    typeof value.capabilities.use === 'boolean' &&
    typeof value.capabilities.manageCloud === 'boolean' &&
    (value.instance === null ||
      (isRecordValue(value.instance) &&
        typeof value.instance.id === 'string' &&
        (value.instance.state === 'CLAIMED' ||
          value.instance.state === 'READY' ||
          value.instance.state === 'DETACHED' ||
          value.instance.state === 'ACCESS_REVOKED')))
  );
}

/** Wire guard for a catalog page. */
export function isOrgProjectCatalogResponse(
  value: unknown,
): value is OrgProjectCatalogResponse {
  return (
    isRecordValue(value) &&
    Array.isArray(value.data) &&
    value.data.every(isOrgProjectSummary) &&
    typeof value.revision === 'string' &&
    (value.nextCursor === null || typeof value.nextCursor === 'string')
  );
}

/** Durable catalog metadata; these rows are not local workspaces. */
export type OrgProjectPlaceholderState =
  | 'ready-to-set-up'
  | 'choose-folder'
  | 'needs-github-access'
  | 'offline'
  | 'access-changed'
  /** Not a local code project, so there is nothing to materialize here. */
  | 'not-local';

export const ORG_PROJECT_PLACEHOLDER_LOCAL_ID_PREFIX = 'org-project:';

export function orgProjectPlaceholderLocalId(projectId: string): string {
  return `${ORG_PROJECT_PLACEHOLDER_LOCAL_ID_PREFIX}${projectId}`;
}

export function parseOrgProjectPlaceholderLocalId(
  localId: string,
): string | null {
  if (!localId.startsWith(ORG_PROJECT_PLACEHOLDER_LOCAL_ID_PREFIX)) return null;
  return localId.slice(ORG_PROJECT_PLACEHOLDER_LOCAL_ID_PREFIX.length) || null;
}

export function deriveOrgProjectPlaceholderState({
  snapshotError,
  project,
}: {
  snapshotError: 'unavailable' | 'offline' | 'access-changed' | null;
  project: Pick<
    OrgProjectSummary,
    'repository' | 'instance' | 'kind' | 'location' | 'memberOwned'
  >;
}): OrgProjectPlaceholderState {
  // Decided before anything else: a project that does not run on this machine
  // can never become ready here, whatever the catalog or GitHub say.
  if (
    project.location !== 'LOCAL' ||
    (project.kind !== 'CODE' && project.kind !== 'COWORK')
  )
    return 'not-local';
  if (snapshotError === 'offline') return 'offline';
  if (
    snapshotError === 'access-changed' ||
    project.instance?.state === 'ACCESS_REVOKED'
  )
    return 'access-changed';
  if (project.kind === 'COWORK') return 'ready-to-set-up';
  if (project.memberOwned) {
    return project.repository === null ? 'choose-folder' : 'ready-to-set-up';
  }
  if (project.repository?.verification !== 'VERIFIED')
    return 'needs-github-access';
  return 'ready-to-set-up';
}

/** Reject malformed progress at the IPC boundary. */
export function isOrgProjectSetupProgress(
  value: unknown,
): value is OrgProjectSetupProgress {
  return (
    isRecordValue(value) &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    (value.instanceId === null || typeof value.instanceId === 'string') &&
    ['claiming', 'materializing', 'ready', 'failed', 'cancelled'].some(
      (state) => state === value.state,
    ) &&
    (value.message === null || typeof value.message === 'string') &&
    (value.percent === null ||
      (typeof value.percent === 'number' &&
        Number.isFinite(value.percent) &&
        value.percent >= 0 &&
        value.percent <= 100)) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (value.errorCode === undefined || typeof value.errorCode === 'string')
  );
}

/** Shared catalog status copy across desktop and portal. */
export const ORG_PROJECT_STATE_TEXT: Record<
  OrgProjectPlaceholderState,
  string
> = {
  'ready-to-set-up': 'Ready to set up',
  'choose-folder': 'Choose the project folder',
  'needs-github-access': 'Needs GitHub access',
  offline: 'Offline',
  'access-changed': 'Access changed',
  'not-local': 'Runs in the cloud',
};

export function buildOrgProjectDeepLink(
  scheme: string,
  projectId: string,
  organizationId: string,
): string {
  if (/^[a-z][a-z0-9+.-]*$/.test(scheme) === false)
    throw new Error('Invalid desktop scheme');
  return `${scheme}://org-project/${encodeURIComponent(projectId)}?org=${encodeURIComponent(organizationId)}`;
}

/** Main has authorized and selected the context before this navigation event. */
export type OrgProjectDeepLinkOpenEvent =
  | { ok: false }
  | {
      ok: true;
      projectId: string;
      organizationId: string;
      workspaceId: string | null;
    };

/** Metadata-only personal catalog enrollment (CAN-2963). */
export interface PersonalCatalogRegistration {
  personalCatalogId: string;
  name: string;
  kind: OrgProjectKind;
  topology: 'SINGLE_REPO' | 'MULTI_REPO';
  location: 'LOCAL';
  repositories: Array<{ host: string; ownerLogin: string; repoName: string }>;
  deviceId: string;
  installationGeneration: number;
  localWorkspaceId: string;
  revision: number;
  /** Restore a removal tombstone only with its current revision and account generation. */
  restorePersonalCatalog?: boolean;
}

/**
 * Why moving a Personal project to one of the member's organizations was
 * refused. Every refusal leaves the project in Personal. Shared by the desktop
 * IPC result and the shared move dialog's copy.
 */
export type OrgProjectMoveErrorCode =
  /** The flag, a capability, or the organization's teams plan does not allow it. */
  | 'unavailable'
  | 'workspace-not-found'
  | 'workspace-unreadable'
  /** A default Chats space, or a project whose folder or kind cannot move. */
  | 'unsupported-workspace'
  /** The project already belongs to an organization. */
  | 'not-personal'
  /** The organization does not hold, or the member cannot use, the project's repository. */
  | 'repository-outside-organization'
  /** The checkout's Git remote could not be read. */
  | 'repository-unavailable'
  /** The member reached the cap on private organization projects. */
  | 'limit-reached'
  /** The organization's project is not active or not usable by this member. */
  | 'project-unavailable'
  /** Another project on this device is already bound to the organization's project. */
  | 'project-already-bound'
  /** A setup, conversion, or move of this project is already running. */
  | 'busy'
  | 'offline'
  | 'move-failed';
