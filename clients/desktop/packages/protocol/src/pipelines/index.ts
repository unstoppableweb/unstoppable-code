import { MARKETPLACE_PUBLIC_SHARE_PREFIXES } from '../marketplace';
import type { ResourceOwner } from '../resource-owner';
import type { PublicShareVersion, ShareRemoteMetadata } from '../sharing';
export * from './dependencies';
export * from './package';
export * from './shared-pipeline-id';
export * from './public-pipeline-share-id';
export * from './packaged-pipeline-id';
import type {
  PipelineDistributionMode,
  PipelinePackageSummary,
} from './package';

export const API_PIPELINE_TRIGGER_TYPES = [
  'dispatch',
  'plan_ready',
  'task_ready',
  'workflow',
] as const;

/**
 * Trigger types a pipeline may declare to leave this machine: shares, curated
 * publication, capability packages and the Portal. `workflow` is readable and
 * runnable locally, but released desktops and web can't store it yet
 * (CAN-5782), so anything that carries a definition off this machine refuses
 * it.
 */
export const PORTABLE_PIPELINE_TRIGGER_TYPES = [
  'dispatch',
  'plan_ready',
  'task_ready',
] as const satisfies readonly ApiPipelineTriggerType[];

export type PortablePipelineTriggerType =
  (typeof PORTABLE_PIPELINE_TRIGGER_TYPES)[number];

export function isPortablePipelineTriggerType(
  value: string,
): value is PortablePipelineTriggerType {
  return PORTABLE_PIPELINE_TRIGGER_TYPES.some((type) => type === value);
}

/** The trigger types that may leave this machine, in their original order. */
export function portablePipelineTriggerTypes(
  types: readonly string[],
): PortablePipelineTriggerType[] {
  return types.filter(isPortablePipelineTriggerType);
}

/**
 * Whether a pipeline declares triggers but none that may leave this machine,
 * such as a pipeline whose only trigger is `workflow`.
 */
export function hasOnlyLocalPipelineTriggers(
  types: readonly string[] | undefined,
): boolean {
  return (
    types !== undefined &&
    types.length > 0 &&
    portablePipelineTriggerTypes(types).length === 0
  );
}

export type ApiPipelineTriggerType =
  (typeof API_PIPELINE_TRIGGER_TYPES)[number];
export type SharedPipelineTriggerType = ApiPipelineTriggerType;
export type PipelineTriggerType = ApiPipelineTriggerType;

export const PIPELINE_SHARE_SCOPES = [
  'private',
  'team',
  'organization',
] as const;

export type PipelineShareScope = (typeof PIPELINE_SHARE_SCOPES)[number];

/**
 * Canonical public path prefix for a shared pipeline.
 *
 * `/s/*` belongs to the e-commerce storefront's site search since CAN-2232,
 * when the `unstoppable.ai` apex moved to Canopy web and Canopy ceded that
 * segment. This prefix was briefly minted as `/s/pipelines` (CAN-2293) and is
 * corrected here: every new public share surface lives under `/share/*`.
 *
 * This constant is the single source of truth. Anything that needs this path
 * must DERIVE it from here rather than re-literalizing `/share/pipelines`.
 * Desktop consumes the server-provided `sharePath` opaquely and never
 * constructs it, so the rename requires no desktop change.
 *
 * There is deliberately NO `LEGACY_PIPELINE_SHARE_PATH_PREFIX`: `/s/pipelines`
 * never reached `main`, so no capability URLs of that shape were ever
 * distributed and there is nothing to preserve. Contrast
 * `LEGACY_SKILL_SHARE_PATH_PREFIX`, which did ship and therefore needs a
 * permanent redirect.
 *
 * See `docs/web-reserved-paths.md`.
 */
export const PIPELINE_SHARE_PATH_PREFIX =
  MARKETPLACE_PUBLIC_SHARE_PREFIXES.pipeline;

export function pipelineSharePath(pipelineExternalId: string): string {
  return `${PIPELINE_SHARE_PATH_PREFIX}/${pipelineExternalId}`;
}

export interface SharedPipelinePublicShareInfo {
  externalId: string;
  pinnedContentHash: string;
  upToDate: boolean;
  sharePath: string;
  createdAt: string;
  updatedAt: string;
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
}

/**
 * Pipeline/action execution scopes (cross-package source of truth).
 *
 * These describe *where* a pipeline or action is valid to run — distinct from
 * the Cloud sharing scope (`PIPELINE_SHARE_SCOPES`). `chat-project` is
 * intentionally excluded. Defined here in `@canopy/protocol` so `apps/web`,
 * `packages/protocol`, and `packages/desktop-shared` share one definition
 * without `apps/web`/`packages/protocol` importing `packages/desktop-shared`.
 */
export const PIPELINE_EXECUTION_SCOPES = [
  'global',
  'directory',
  'worktree',
] as const;

export type PipelineExecutionScope = (typeof PIPELINE_EXECUTION_SCOPES)[number];

/** Provenance of an editable local copy; never an instruction to auto-update. */
export interface CuratedPipelineOrigin {
  key: string;
  contentHash: string;
  revision: number;
  importedAt: string;
}

export interface PipelineIndexEntry {
  curatedOrigin?: CuratedPipelineOrigin;
  id: string;
  name: string;
  filename: string;
  description: string;
  icon: string;
  createdAt: string;
  updatedAt: string;
  triggerTypes?: PipelineTriggerType[];
  /** Number of declared pipeline steps, when the listing host loaded the definition. */
  stepCount?: number;
  /**
   * Normalized execution scopes for this pipeline. Optional in the index so UI
   * surfaces can filter without re-parsing every YAML file; consumers default
   * a missing value to `['directory']`. Named `scopes` (not `scope`/
   * `shareScope`) to avoid ambiguity with the Cloud sharing scope.
   * `PipelineInfo` inherits this field via `extends PipelineIndexEntry`.
   */
  scopes?: PipelineExecutionScope[];
  /** Author-side link to the pipeline's current cloud share. */
  remote?: ShareRemoteMetadata;
  /**
   * Revision of a user pipeline's document, raised by every save. Absent
   * means 0: the entry predates revisions or is bundled.
   */
  revision?: number;
}

/** CAN-5782: why a workflow page can have only one schedule. */
export const WORKFLOW_SINGLE_SCHEDULE_REASONS = [
  'orchestrator_prompt',
  'agent_grant',
  'installed_package',
] as const;

export type WorkflowSingleScheduleReason =
  (typeof WORKFLOW_SINGLE_SCHEDULE_REASONS)[number];

/** Where a schedule's `worktree_pipeline` run goes; mirrors the automation's. */
export type WorkflowScheduleTarget =
  | { kind: 'global' }
  | { kind: 'new_worktree' }
  | { kind: 'task'; taskId: string }
  | { kind: 'project' };

/**
 * CAN-5782: the run values of a workflow page's last schedule, kept when it
 * was removed, so the next schedule starts from them. A converted pipeline
 * declares no input defaults, so they are the only source.
 */
export interface WorkflowScheduleValues {
  inputs?: Record<string, string>;
  target?: WorkflowScheduleTarget;
  /** The project a project-bound schedule ran in, and its repository. */
  workspaceId?: string;
  repoId?: string;
  modelAliasPreferences?: Record<string, unknown>;
  pluginCollectionPreferences?: Record<string, unknown>;
}

/**
 * CAN-5782: what the Workflow page needs about a pipeline its schedules run,
 * present with zero schedules. Desktop-local: never sent off this machine.
 */
export interface PipelineWorkflowPageInfo {
  /** Present when the pipeline can have only one schedule. */
  singleSchedule?: { reason: WorkflowSingleScheduleReason };
  /** Present when the page has no schedules and kept the last one's values. */
  lastScheduleValues?: WorkflowScheduleValues;
}

/**
 * `'shared'` covers pipelines hosted on the singleton Canopy Cloud backend.
 * Shared pipelines do not have a stable on-disk path; their internal
 * `serverId`/`remoteId` pair is the canonical identity, and per-execution
 * caching writes a snapshot file into the execution directory at run time.
 */
export interface PipelineInfo extends PipelineIndexEntry {
  source: 'bundled' | 'user' | 'project' | 'shared' | 'curated';
  /** Managed catalog identity and currently advertised immutable revision. */
  curatedKey?: string;
  curatedContentHash?: string;
  curatedRevision?: number;
  readonly: boolean;
  filePath?: string;
  // Shared-pipeline metadata. All fields are populated together when
  // `source === 'shared'`, and are absent for every other source.
  /** Internal singleton Cloud source id. */
  serverId?: string;
  /** Display name of the Cloud source. */
  serverName?: string;
  /** Legacy origin of the configured backend, retained only for old state. */
  serverBaseUrl?: string;
  /** External UUID of the pipeline on Canopy Cloud. */
  remoteId?: string;
  /** Whether the current API user is allowed to edit this shared pipeline. */
  canUpdate?: boolean;
  /** Whether the current API user is allowed to delete this shared pipeline. */
  canDelete?: boolean;
  /**
   * Sharing/ownership scope of the shared pipeline. Optional because older
   * Canopy Cloud deployments (pre `organizations-v1` / `teams-v1`) may not return
   * this field; both sides must tolerate missing values.
   */
  shareScope?: PipelineShareScope;
  /**
   * Owner of the shared pipeline. Optional for the same backwards-compat
   * reason as `shareScope`.
   */
  owner?: PipelineShareOwner;
  /**
   * Who created the share. Populated with the other shared fields; absent on
   * older rows.
   */
  createdBy?: SharedPipelineSummary['createdBy'];
  publicShare?: SharedPipelinePublicShareInfo | null;
  /** Package mode returned with an authenticated shared-pipeline snapshot. */
  distributionMode?: PipelineDistributionMode;
  /**
   * CAN-5782: set on a user pipeline that is a workflow page (a live
   * automation owns it, or it was kept as one). Desktop-local projection.
   */
  workflowPage?: PipelineWorkflowPageInfo;
  /**
   * CAN-5782 phase 09: how many other workflow pages call this user pipeline
   * through a `builtin/run-pipeline` step whose child is fixed before a run.
   * Absent when none does. Desktop-local projection.
   */
  workflowCallers?: number;
}

/** Mirrors the web `OrganizationRole` enum: the caller's role in an org. */
export const CANOPY_ORGANIZATION_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;

export type CanopyOrganizationRole = (typeof CANOPY_ORGANIZATION_ROLES)[number];

export function isCanopyOrganizationRole(
  value: unknown,
): value is CanopyOrganizationRole {
  // `.some()` rather than `.includes()` so no cast is needed on the tuple.
  return (
    typeof value === 'string' &&
    CANOPY_ORGANIZATION_ROLES.some((role) => role === value)
  );
}

export interface CanopyOrganizationSummary {
  id: string;
  name: string;
  /** Personal promotion requires explicit selection on every desktop. */
  automaticPersonalProjectConversionExcluded?: boolean;
  /**
   * The authenticated caller's role in this organization (CAN-2940). Optional:
   * older Canopy Cloud deployments omit it, and it is never populated for
   * organizations embedded in a team summary. Consumers treat an absent role
   * as MEMBER; it gates admin-only entry points in the UI only, the server
   * re-checks the real membership on every operation.
   */
  role?: CanopyOrganizationRole;
  /** Public branding logo URL; older deployments omit it. */
  logoUrl?: string | null;
  /** Whether admins allow direct shared-container recipients outside the org. */
  allowExternalContainerSharing?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CanopyTeamSummary {
  id: string;
  name: string;
  organization: CanopyOrganizationSummary;
  createdAt: string;
  updatedAt: string;
}

/** Pipeline APIs retain their existing non-null names and richer team summary. */
export type PipelineOwnerApi =
  | (Extract<ResourceOwner, { type: 'user' | 'organization' }> & {
      name: string;
    })
  | (Extract<ResourceOwner, { type: 'team' }> & {
      name: string;
      organization: CanopyOrganizationSummary;
    });

export type PipelineShareOwner = PipelineOwnerApi;

export interface PipelineApiItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  version: string;
  triggerTypes: ApiPipelineTriggerType[];
  /**
   * Normalized pipeline execution scopes. Optional so older web deployments
   * that omit it stay compatible; consumers default missing values to
   * `['directory']`. Carried onto `SharedPipelineSummary` /
   * `SharedPipelineDetail` so shared/Cloud pipeline summaries can ferry scopes
   * between web and desktop.
   */
  scopes?: PipelineExecutionScope[];
  createdBy: { id: string; name: string };
  shareScope: PipelineShareScope;
  owner: PipelineOwnerApi;
  createdAt: string;
  updatedAt: string;
  canUpdate: boolean;
  canDelete: boolean;
  publicShare?: SharedPipelinePublicShareInfo | null;
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
}

export interface PipelineApiDetail extends PipelineApiItem {
  rawPipeline: string;
  contentHash: string;
}

export interface PipelineApiListResponse {
  data: PipelineApiItem[];
  nextCursor: string | null;
}

export interface PipelineApiListQuery {
  limit?: number;
  cursor?: string;
  q?: string;
  triggerType?: ApiPipelineTriggerType;
  createdBy?: string;
}

export interface PipelineApiCreateRequest {
  rawPipeline: string;
  shareScope?: PipelineShareScope;
  teamId?: string;
  organizationId?: string;
  distributionMode?: PipelineDistributionMode;
  committedPackageUploadId?: string;
}

export interface PipelineApiUpdateRequest {
  rawPipeline: string;
  expectedContentHash?: string;
  shareScope?: PipelineShareScope;
  teamId?: string;
  organizationId?: string;
  distributionMode?: PipelineDistributionMode;
  committedPackageUploadId?: string;
  /** Keep the current package pin when this client cannot analyze packages. */
  preservePackage?: boolean;
}

export type PipelineApiWriteRequest = PipelineApiCreateRequest;

export type SharedPipelineSummary = Omit<
  PipelineApiItem,
  'shareScope' | 'owner'
> & {
  shareScope?: PipelineShareScope;
  owner?: PipelineShareOwner;
};

export interface SharedPipelineDetail extends SharedPipelineSummary {
  rawPipeline: string;
  /** Stable hash of `rawPipeline`, used for conditional updates. */
  contentHash: string;
}

export interface ListSharedPipelinesRequest {
  serverId: string;
  limit?: number;
  cursor?: string;
  q?: string;
  triggerType?: SharedPipelineTriggerType;
  createdBy?: string;
}

export interface ListSharedPipelinesResponse {
  serverId: string;
  data: SharedPipelineSummary[];
  nextCursor: string | null;
}

export interface SharedPipelineGetRequest {
  serverId: string;
  remoteId: string;
}

export interface SharedPipelineWriteRequest {
  serverId: string;
  rawPipeline: string;
  shareScope?: PipelineShareScope;
  teamId?: string;
  organizationId?: string;
  distributionMode?: PipelineDistributionMode;
  committedPackageUploadId?: string;
  expectedContentHash?: string;
  revokePublicShare?: PublicShareVersion;
}

export interface SharedPipelineDeleteRequest {
  serverId: string;
  remoteId: string;
}

export interface PublishSharedPipelinePublicShareResponse {
  publicShare: SharedPipelinePublicShareInfo;
}

export interface ListSharedOrganizationsRequest {
  serverId: string;
  q?: string;
  limit?: number;
}

export interface ListSharedOrganizationsResponse {
  serverId: string;
  data: CanopyOrganizationSummary[];
}

export interface ListSharedTeamsRequest {
  /** Exact public team ID; filtered before the list limit. */
  id?: string;
  serverId: string;
  q?: string;
  limit?: number;
}

export interface ListSharedTeamsResponse {
  serverId: string;
  data: CanopyTeamSummary[];
}
