import type {
  CanopyOrganizationSummary,
  CanopyOrganizationRole,
  CanopyTeamSummary,
} from '../pipelines';
import { MEMORY_SEARCH_CAPABILITY } from '../memory';
import type { ModelLibraryAccess } from '../models/model-library-access';
import type {
  AiGatewayHarness,
  AiGatewayThinkingLevel,
  AiGatewayToolSchemaProfile,
} from '../ai-gateway-models';

/** The mirror accepts and serves global Agent Ledger scopes. */
export const LEDGER_GLOBAL_CAPABILITY = 'ledger-global-v1';

export const CANOPY_SERVER_CAPABILITIES = [
  'account-v1',
  'resource-context-v1',
  'pipelines-crud-v1',
  'organizations-v1',
  'teams-v1',
  'portal-v1',
  'skills-crud-v1',
  'plugins-crud-v1',
  'agents-crud-v1',
  'collections-crud-v1',
  'plans-crud-v1',
  'runs-crud-v1',
  // Two-way comments on shared runs (CAN-397). Deliberately separate from
  // `runs-crud-v1`: reusing that capability would wrongly imply comment
  // support on every already-deployed Canopy Cloud. Optional, so an older
  // server degrades to "no comments" instead of erroring.
  'run-comments-v1',
  // Team-scoped automation sharing (CAN-1581). Optional, so an older server
  // degrades to "no automation sharing" instead of erroring.
  'automations-crud-v1',
  // Publication of narrowed documents requires a reader that retains v3 requirements.
  'automations-target-requirements-v3',
  // Publication of v4 documents carrying an author-included run-condition
  // command (CAN-3959). Optional, so an older server degrades to "uncheck
  // the run condition to share" instead of a failed publish.
  'automations-run-condition-v4',
  // Publication of v5 documents whose pipelines travel in the capability
  // package (`packaged` refs and prompt `pipelineDependencies`). Optional, so
  // an older server degrades to sharing without pipeline dependencies.
  'automations-pipeline-dependencies-v5',
  // Publication of v6 documents with pipeline automation destinations
  // (CAN-4550). Optional; older servers keep accepting legacy `workspace`
  // pipeline targets only.
  'automations-pipeline-targets-v6',
  // Curated Automation Marketplace catalog. Optional for older servers.
  'automation-catalog-v1',
  'session-exports-v1',
  'shared-containers-v1',
  // Recoverable share removal (CAN-4052): the dismissed listing and the
  // restore route. Separate from `shared-containers-v1`, whose servers
  // hard-delete on dismiss. Optional, so an older server degrades to today's
  // irreversible remove instead of a restore the client cannot perform.
  'shared-container-dismissals-v1',
  // Organization projects (CAN-611): org-owned project catalog, instance
  // claims, and Personal catalog registration. Optional and minted per user
  // only while `canopy-shared-org-projects-enabled` evaluates true, so an
  // older server (or a user outside the rollout) degrades to "unavailable"
  // instead of erroring.
  'org-projects-v1',
  // Member-created organization Code projects. Separate from the catalog
  // capability so older servers keep the Cowork-only create flow.
  'org-member-code-projects-v1',
  // Verified reclaim of an expired setup claim (CAN-3129). Separate so an
  // older server, which would treat the reclaim as a fresh claim and could
  // revive a superseded instance, is never asked to reclaim.
  'org-project-reclaim-v1',
  'org-shared-multi-repo-v1',
  'llm-proxy-v1',
  'oauth-links-v1',
  'model-routing-v1',
  'mcp-proxy-v1',
  'mcp-connections-v1',
  // In-place edits of an account MCP connection (REG-3015). Optional, so an
  // older server degrades to "no editing" instead of erroring.
  'mcp-connections-v2',
  MEMORY_SEARCH_CAPABILITY,
  // Global (workflow) Agent Ledger scopes (CAN-4545): sync schema version 2
  // and version-2 mirror reads. Optional and the sole gate for global sync,
  // so a desktop holds global events locally against an older mirror instead
  // of marking them for repair.
  LEDGER_GLOBAL_CAPABILITY,
] as const;

export const REQUIRED_CANOPY_SERVER_CAPABILITIES = [
  'account-v1',
  'pipelines-crud-v1',
  'organizations-v1',
  'teams-v1',
] as const;

export type CanopyServerCapability =
  (typeof CANOPY_SERVER_CAPABILITIES)[number];
export type RequiredCanopyServerCapability =
  (typeof REQUIRED_CANOPY_SERVER_CAPABILITIES)[number];

export interface CanopyServerAccountInfo {
  /** Personal library access under this credential's targeting context. */
  modelLibrary?: ModelLibraryAccess;
  id: string;
  name: string;
  email: string;
  role: 'VIEWER' | 'DEVELOPER' | 'ADMIN';
  /**
   * Optional account avatar/profile picture URL (public GCS URL set on the web
   * app). Omitted from the wire payload when the user has no avatar.
   */
  image?: string;
}

export const ORG_ENFORCED_POLICY_KINDS = [
  'telemetry-sync',
  'model-policy',
  'model-gateway',
  'usage-data',
] as const;
export type OrgEnforcedPolicyKind = (typeof ORG_ENFORCED_POLICY_KINDS)[number];

/**
 * Per-scope flags on an enforced telemetry-sync policy. `summaries` was added
 * with the AI-summary split; it is optional so a policy minted by an older
 * server (which had summaries riding on `metadata`) parses cleanly, and an
 * older client that does not know the key simply ignores it.
 */
export interface TelemetryEnforcedScopeMap {
  transcripts: boolean;
  plans: boolean;
  metadata: boolean;
  /** Added with the summaries split. Absent on policies from older servers ⇒ unset. */
  summaries?: boolean;
}

// First policy kind. Future kinds add new members to the union below.
export interface TelemetrySyncEnforcedPolicy {
  kind: 'telemetry-sync';
  /**
   * Scopes the org REQUIRES at Organization visibility. Read by every client
   * version, including builds that predate `prohibitedScopes`.
   */
  scopes: TelemetryEnforcedScopeMap;
  /**
   * Scopes the org PROHIBITS for work owned by that organization, at any
   * visibility. Work owned by another organization or Personal is unaffected.
   * Present only when the org enforces its full data-sharing configuration
   * (`OrganizationConfig.enforceMemberDataSharing`). A scope is never
   * simultaneously required and prohibited — prohibition wins during
   * resolution, so the two maps are always disjoint.
   */
  prohibitedScopes?: TelemetryEnforcedScopeMap;
}

export interface ModelPolicyEnforcedPolicy {
  kind: 'model-policy';
  /** Model ids explicitly denied by an organization administrator. */
  blockedModelIds: string[];
  /** Catalog ids shown to the administrator at the most recent save. */
  reviewedModelIds: string[];
}

/** Hard wire bounds for org gateway configuration carried on account probes. */
export const MODEL_GATEWAY_MAX_MODELS = 100;
/**
 * Sanity bound on one discovery result. Discovery lists every model a gateway
 * offers; only the saved list is capped at {@link MODEL_GATEWAY_MAX_MODELS}.
 */
export const MODEL_GATEWAY_MAX_DISCOVERED_MODELS = 5000;
export const MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH = 64;
export const MODEL_GATEWAY_MAX_ID_LENGTH = 256;
export const MODEL_GATEWAY_MAX_LABEL_LENGTH = 256;
export const MODEL_GATEWAY_MAX_BASE_URL_LENGTH = 2048;

export interface ModelGatewayModel {
  /** Canopy selection id, unique inside the org catalog. */
  id: string;
  /** Exact provider/model slug sent to the customer gateway. */
  gatewayId: string;
  label: string;
  harness: AiGatewayHarness;
  contextWindow: number;
  supportedThinkingLevels: AiGatewayThinkingLevel[];
  toolSchemaProfile: AiGatewayToolSchemaProfile;
}

export interface ModelGatewayEnforcedPolicy {
  kind: 'model-gateway';
  displayName?: string;
  /** HTTPS origin/base path without a trailing slash. */
  baseUrl: string;
  models: ModelGatewayModel[];
  /** True makes the gateway a compliance boundary rather than an extra route. */
  enforced: boolean;
  /** Absent on older server payloads is normalized to true by desktop clients. */
  promptCachePassthrough: boolean;
}

/**
 * Usage-data flows an organization turns off for members while they work in
 * that organization on desktop. Independent of the data-sharing master switch,
 * and emitted only when at least one flag is true. Prohibitions only narrow:
 * `false` leaves the member's own choice in place. Clients read each flag as
 * `=== true` and ignore unknown keys, so a newer server can add flows.
 */
export interface UsageDataProhibitedFlows {
  productAnalytics: boolean;
  errorReports: boolean;
  sessionReplay: boolean;
  activeUseSignal: boolean;
  featureFlagIdentity: boolean;
}

export interface UsageDataEnforcedPolicy {
  kind: 'usage-data';
  prohibited: UsageDataProhibitedFlows;
}

export type CanopyOrgEnforcedPolicy =
  | TelemetrySyncEnforcedPolicy
  | ModelPolicyEnforcedPolicy
  | ModelGatewayEnforcedPolicy
  | UsageDataEnforcedPolicy;

// Enforced policies for one org the signed-in user belongs to.
export interface CanopyOrgEnforcedSettings {
  organizationId: string; // org externalId
  organizationName: string; // for consent + tooltip copy
  policies: CanopyOrgEnforcedPolicy[];
  /** A recognizable enforced gateway policy was present but unsafe to route. */
  modelGatewayEnforcementUnavailable?: true;
}

/**
 * Validate and canonicalize a gateway base URL before any host app appends its
 * provider-specific path. A terminal `/v1` is stripped so consumers can append
 * their required API version exactly once. Query strings and fragments are
 * rejected because string concatenation would otherwise place `/v1` inside the
 * wrong URL part.
 */
export function normalizeModelGatewayBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MODEL_GATEWAY_MAX_BASE_URL_LENGTH
  ) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return null;
    }
    const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/, '');
    const canonicalPath = pathWithoutTrailingSlash.replace(/\/v1$/, '');
    return `${url.origin}${canonicalPath}`;
  } catch {
    return null;
  }
}

/**
 * Billing state for one org the signed-in user belongs to (CAN-2311).
 *
 * A parallel array on the account response, exactly like
 * {@link CanopyOrgEnforcedSettings}, rather than new fields on
 * `CanopyOrganizationSummary`: that summary is shared with the pipelines API,
 * so widening it would push billing state onto an unrelated contract. Keying by
 * org externalId also keeps every gate PER-ORG — a member of one lapsed org and
 * one healthy org keeps full function through the healthy one.
 *
 * Optional on the wire: a server that predates this key simply omits it, and an
 * older client that does not know it ignores it. Absent ⇒ "not lapsed", so both
 * directions degrade to today's ungated behavior instead of locking users out.
 */
export interface CanopyOrgBillingState {
  organizationId: string; // org externalId
  organizationName: string; // for lapsed-state copy
  /**
   * Whether the org currently holds the `teams` billing capability. `false`
   * means the org has lapsed to Free and its org-backed features are gated.
   */
  teamsEntitled: boolean;
  /**
   * When the org's trial ended, if it is already in the past. Omitted when the
   * trial is still live or the end date is unknown. Every org has trialed, so a
   * present value here always means the trial genuinely ran and ended.
   */
  trialEndedAt?: string;
}

export interface CanopyAccountResponse {
  /** External ID of the personal organization, excluded from visible teams. */
  personalOrganizationId?: string;
  personalModelGateway?: {
    organizationId: string;
  } & ModelGatewayEnforcedPolicy;
  account: CanopyServerAccountInfo;
  capabilities: readonly string[];
  organizations: CanopyOrganizationSummary[];
  teams: CanopyTeamSummary[];
  enforcedSettings?: CanopyOrgEnforcedSettings[];
  /** Per-org billing state, keyed by org externalId. Absent ⇒ nothing lapsed. */
  orgBillingStates?: CanopyOrgBillingState[];
  /**
   * First organization eligible for organization-memory search.
   *
   * @deprecated Read `memorySearchOrganizationExternalIds`. Kept for desktops
   * that predate the list; always equals its first entry.
   */
  memorySearchOrganizationExternalId?: string;
  /**
   * Every organization the user may search with organization memory (CAN-3457).
   * Clients search only the organization that owns the work, and only when it
   * appears here; they never fall back to another entry. Absent means either no
   * organization is eligible or an older server that only sends the deprecated
   * single-org field.
   */
  memorySearchOrganizationExternalIds?: string[];
}

export interface CanopyServerWellKnownResponse {
  capabilities: readonly string[];
}

export interface CanopyOrganizationsResponse {
  data: CanopyOrganizationSummary[];
}

export interface CanopyTeamsResponse {
  data: CanopyTeamSummary[];
}

export interface CanopyServerStatus {
  authenticated: boolean;
  capabilities: string[];
  missingCapabilities: string[];
  account: CanopyServerAccountInfo | null;
  organizations: CanopyOrganizationSummary[];
  teams: CanopyTeamSummary[];
  enforcedSettings?: CanopyOrgEnforcedSettings[];
  /** Client-derived state: a missing policy snapshot cannot authorize consent. */
  telemetryEnforcementUnavailable?: boolean;
  /** Client-derived fail-closed state for an unusable enforced gateway. */
  modelGatewayEnforcementUnavailable?: boolean;
  /** Per-org billing state mirrored from the account response (CAN-2311). */
  orgBillingStates?: CanopyOrgBillingState[];
  error: string | null;
}

export interface ValidateCanopyServerRequest {
  baseUrl: string;
  apiKey?: string;
  serverId?: string;
}

/** Closed consent vocabulary. Callers submit a feature, never arbitrary scopes. */
export const DATA_SHARING_OPT_IN_FEATURES = [
  'feed-activity',
  'statistics',
  'member-profiles',
  'leaderboards',
  'implemented-plans',
  'organization-memory',
  'shared-projects',
] as const;
export type DataSharingOptInFeature =
  (typeof DATA_SHARING_OPT_IN_FEATURES)[number];
export function isDataSharingOptInFeature(
  value: unknown,
): value is DataSharingOptInFeature {
  return (
    typeof value === 'string' &&
    DATA_SHARING_OPT_IN_FEATURES.some((feature) => feature === value)
  );
}
export type ViewerDataSharingScopeStatus =
  | 'shared'
  | 'private'
  | 'prohibited'
  | 'unknown';
export interface ViewerDataSharingStatus {
  viewerUserId: string;
  scopes: Record<keyof TelemetryEnforcedScopeMap, ViewerDataSharingScopeStatus>;
}

/** Strict transport guard for viewer-only evidence. */
export function isViewerDataSharingStatus(
  value: unknown,
): value is ViewerDataSharingStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  if (
    !('viewerUserId' in value) ||
    typeof value.viewerUserId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.viewerUserId,
    )
  )
    return false;
  if (
    !('scopes' in value) ||
    typeof value.scopes !== 'object' ||
    value.scopes === null ||
    Array.isArray(value.scopes)
  )
    return false;
  const scopes = value.scopes;
  return ['metadata', 'plans', 'summaries', 'transcripts'].every((scope) => {
    const status: unknown = Reflect.get(scopes, scope);
    return (
      status === 'shared' ||
      status === 'private' ||
      status === 'prohibited' ||
      status === 'unknown'
    );
  });
}

/** Admin-only memory participation projection; identifiers are public UUIDs. */
export interface MemoryParticipationMember {
  userId: string;
  name: string | null;
  email: string;
  role: CanopyOrganizationRole;
  memoryEnabled: boolean;
  contributingRecently: boolean;
}
export function isMemoryParticipationMember(
  value: unknown,
): value is MemoryParticipationMember {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return (
    'userId' in value &&
    typeof value.userId === 'string' &&
    'name' in value &&
    (value.name === null || typeof value.name === 'string') &&
    'email' in value &&
    typeof value.email === 'string' &&
    'role' in value &&
    (value.role === 'OWNER' ||
      value.role === 'ADMIN' ||
      value.role === 'MEMBER') &&
    'memoryEnabled' in value &&
    typeof value.memoryEnabled === 'boolean' &&
    'contributingRecently' in value &&
    typeof value.contributingRecently === 'boolean'
  );
}
