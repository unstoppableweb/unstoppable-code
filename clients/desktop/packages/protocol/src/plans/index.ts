import type { ResourceOwner } from '../resource-owner';
// ---------------------------------------------------------------------------
// Shared Plan API contracts.
//
// A tracked plan can be shared to a Canopy Server so the cloud copy stays
// revised as the local plan changes. This module is the single source of truth
// for the wire shapes that cross the desktop ⇄ web boundary:
//   - the sanitized repository reference that travels with a shared plan
//   - the create/update request DTOs the desktop client posts
//   - the summary / detail response shapes the web API returns
//   - the canonical snapshot-hash input both sides hash identically
//   - the generated plan diagram artifact contracts (moved here so web can
//     type and validate `PlanDiagramArtifacts` without importing desktop-shared)
//   - the comment-thread wire shapes that round-trip desktop ⇄ server ⇄ web
//     (CAN-393), including remote teammate author identity
//
// Local-only concerns (filesystem layout, hidden state, the
// `TrackedPlanShareState` link metadata, and the renderer-only `staged` draft
// flag on a comment) live in `packages/desktop-shared/src/types.ts` and are NOT
// part of these DTOs.
//
// IMPORTANT: this module must stay dependency-free (no `node:crypto`, no
// filesystem, no network) so it is safe to import from the renderer, the
// desktop main process, and the web service alike. The SHA-256 call that
// turns `buildSharedPlanSnapshotInput(...)` output into a hash lives on each
// consuming side, never here.
// ---------------------------------------------------------------------------

// ===========================================================================
// Generated plan diagram artifact contracts.
//
// Renderer-agnostic schemas for generated plan diagram artifacts. Dependency
// free so the main process (generation), the renderer (rendering), and the
// web service (typing/validation) can all import them. Plan comment-thread wire
// shapes (CAN-393) live further down in this module so they round-trip across
// the same boundary; the renderer-only `staged` draft flag stays in
// desktop-shared.
// ===========================================================================

export const PLAN_DIAGRAM_SCHEMA_VERSION = 1 as const;

// --- Parsed plan graph (sequence diagram) ----------------------------------

export interface PlanAnchor {
  /** Heading path locating this node in the markdown, outermost first. */
  headingPath?: string[];
  /** Verbatim passage from the markdown locating this node. */
  quote?: string;
}

export type PlanGraphNodeKind = 'phase' | 'task';

export interface PlanGraphNode {
  /** Stable id; reused by comment structural anchors. */
  id: string;
  kind: PlanGraphNodeKind;
  title: string;
  /** Brief one-line description shown on the node. */
  description: string;
  /** Parent phase id for task nesting. */
  parentId?: string;
  planAnchor: PlanAnchor;
  /** Files this node references, when derivable. */
  files?: string[];
  /** Full detail shown when the node is clicked. */
  detail?: string;
}

export type PlanGraphEdgeKind = 'depends-on' | 'sequence';

export interface PlanGraphEdge {
  from: string;
  to: string;
  kind: PlanGraphEdgeKind;
}

export interface ParsedPlanGraph {
  schemaVersion: typeof PLAN_DIAGRAM_SCHEMA_VERSION;
  nodes: PlanGraphNode[];
  edges: PlanGraphEdge[];
}

// --- Logical current/planned/diff diagram ----------------------------------

export interface LogicNode {
  /** Stable across current/planned when the node is unchanged. */
  id: string;
  label: string;
  detail?: string;
  /** References ParsedPlanGraph node ids this logic derives from. */
  planNodeIds?: string[];
  files?: string[];
}

export interface LogicEdge {
  from: string;
  to: string;
  label?: string;
}

export interface LogicFlow {
  nodes: LogicNode[];
  edges: LogicEdge[];
}

export type LogicChangeType = 'added' | 'removed' | 'changed';

export interface LogicChange {
  nodeId: string;
  type: LogicChangeType;
  note?: string;
}

export interface LogicDiffDiagram {
  schemaVersion: typeof PLAN_DIAGRAM_SCHEMA_VERSION;
  /** The current behavior, before the plan is executed. */
  current: LogicFlow;
  /** The projected behavior once the plan is executed. */
  planned: LogicFlow;
  changes: LogicChange[];
}

// --- Data model current/planned/diff diagram -------------------------------

export type DataModelFieldKind =
  | 'primary'
  | 'foreign'
  | 'unique'
  | 'indexed'
  | 'regular';

export interface DataModelField {
  /**
   * Unique within the owning entity only (NOT global), and stable across
   * current/planned for the same field.
   */
  id: string;
  name: string;
  type?: string;
  nullable?: boolean;
  kind?: DataModelFieldKind;
  detail?: string;
}

export interface DataModelEntity {
  /** Globally unique, and stable across current/planned for the same entity. */
  id: string;
  name: string;
  kind?: 'table' | 'model' | 'collection' | 'entity';
  detail?: string;
  fields: DataModelField[];
  planNodeIds?: string[];
  files?: string[];
}

export type DataModelCardinality =
  | 'one-to-one'
  | 'one-to-many'
  | 'many-to-one'
  | 'many-to-many'
  | 'unknown';

export interface DataModelRelationship {
  id: string;
  from: string;
  to: string;
  label?: string;
  cardinality?: DataModelCardinality;
  detail?: string;
  fields?: string[];
}

export interface DataModelGraph {
  entities: DataModelEntity[];
  relationships: DataModelRelationship[];
}

export type DataModelChangeTarget = 'entity' | 'field' | 'relationship';
export type DataModelChangeType = 'added' | 'removed' | 'changed';

interface DataModelChangeBase {
  id: string;
  type: DataModelChangeType;
  note?: string;
}

export interface DataModelEntityChange extends DataModelChangeBase {
  target: 'entity';
  entityId: string;
}

/**
 * Field ids are unique only within an entity, so a field change MUST carry
 * its owning `entityId` as well as `fieldId`. Without `entityId`, a common
 * field id (`id`, `createdAt`) is ambiguous and could be highlighted on the
 * wrong entity.
 */
export interface DataModelFieldChange extends DataModelChangeBase {
  target: 'field';
  entityId: string;
  fieldId: string;
}

export interface DataModelRelationshipChange extends DataModelChangeBase {
  target: 'relationship';
  relationshipId: string;
}

// Discriminated on `target` so each variant requires exactly the ids it
// needs to be scoped unambiguously.
export type DataModelChange =
  | DataModelEntityChange
  | DataModelFieldChange
  | DataModelRelationshipChange;

export interface DataModelDiffDiagram {
  schemaVersion: typeof PLAN_DIAGRAM_SCHEMA_VERSION;
  current: DataModelGraph;
  planned: DataModelGraph;
  changes: DataModelChange[];
}

export interface DataModelDiffGenerationResult {
  schemaVersion: typeof PLAN_DIAGRAM_SCHEMA_VERSION;
  applicable: boolean;
  reason?: string;
  diagram?: DataModelDiffDiagram;
}

// --- Generated artifact envelope -------------------------------------------

export type PlanDiagramStatus =
  | 'pending'
  | 'generating'
  | 'ready'
  | 'stale'
  | 'error';

export interface PlanDiagramArtifact<T> {
  /** Payload; null until the first generation completes. */
  data: T | null;
  /** Revision of TrackedPlanData.content this was derived from. */
  derivedFromRevision: number;
  status: PlanDiagramStatus;
  generatedAt?: string;
  error?: string;
}

export interface PlanDiagramArtifacts {
  sequence?: PlanDiagramArtifact<ParsedPlanGraph>;
  logicDiff?: PlanDiagramArtifact<LogicDiffDiagram>;
  dataModelDiff?: PlanDiagramArtifact<DataModelDiffDiagram>;
}

// --- Shallow type guards (persistence/generation tolerance) -----------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DIAGRAM_STATUSES: readonly PlanDiagramStatus[] = [
  'pending',
  'generating',
  'ready',
  'stale',
  'error',
];

export function isPlanDiagramArtifacts(
  value: unknown,
): value is PlanDiagramArtifacts {
  if (!isRecord(value)) return false;
  for (const key of ['sequence', 'logicDiff', 'dataModelDiff'] as const) {
    const artifact = value[key];
    if (artifact === undefined) continue;
    if (!isRecord(artifact)) return false;
    if (
      typeof artifact.derivedFromRevision !== 'number' ||
      typeof artifact.status !== 'string' ||
      !DIAGRAM_STATUSES.some((s) => s === artifact.status) ||
      !('data' in artifact)
    ) {
      return false;
    }
  }
  return true;
}

export function isParsedPlanGraph(value: unknown): value is ParsedPlanGraph {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === PLAN_DIAGRAM_SCHEMA_VERSION &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

export function isLogicDiffDiagram(value: unknown): value is LogicDiffDiagram {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === PLAN_DIAGRAM_SCHEMA_VERSION &&
    isRecord(value.current) &&
    isRecord(value.planned) &&
    Array.isArray(value.changes)
  );
}

const DATA_MODEL_FIELD_KINDS: readonly DataModelFieldKind[] = [
  'primary',
  'foreign',
  'unique',
  'indexed',
  'regular',
];

const DATA_MODEL_ENTITY_KINDS = [
  'table',
  'model',
  'collection',
  'entity',
] as const;

const DATA_MODEL_CARDINALITIES: readonly DataModelCardinality[] = [
  'one-to-one',
  'one-to-many',
  'many-to-one',
  'many-to-many',
  'unknown',
];

const DATA_MODEL_CHANGE_TYPES: readonly DataModelChangeType[] = [
  'added',
  'removed',
  'changed',
];

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function isDataModelField(value: unknown): value is DataModelField {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isOptionalString(value.type) &&
    (value.nullable === undefined || typeof value.nullable === 'boolean') &&
    (value.kind === undefined ||
      DATA_MODEL_FIELD_KINDS.some((kind) => kind === value.kind)) &&
    isOptionalString(value.detail)
  );
}

function isDataModelEntity(value: unknown): value is DataModelEntity {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.kind === undefined ||
      DATA_MODEL_ENTITY_KINDS.some((kind) => kind === value.kind)) &&
    isOptionalString(value.detail) &&
    Array.isArray(value.fields) &&
    value.fields.every(isDataModelField) &&
    isOptionalStringArray(value.planNodeIds) &&
    isOptionalStringArray(value.files)
  );
}

function isDataModelRelationship(
  value: unknown,
): value is DataModelRelationship {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    isOptionalString(value.label) &&
    (value.cardinality === undefined ||
      DATA_MODEL_CARDINALITIES.some(
        (cardinality) => cardinality === value.cardinality,
      )) &&
    isOptionalString(value.detail) &&
    isOptionalStringArray(value.fields)
  );
}

function isDataModelGraph(value: unknown): value is DataModelGraph {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.entities) &&
    value.entities.every(isDataModelEntity) &&
    Array.isArray(value.relationships) &&
    value.relationships.every(isDataModelRelationship)
  );
}

function isDataModelChange(value: unknown): value is DataModelChange {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (!DATA_MODEL_CHANGE_TYPES.some((type) => type === value.type)) {
    return false;
  }
  if (!isOptionalString(value.note)) return false;

  if (value.target === 'entity') {
    return typeof value.entityId === 'string';
  }
  if (value.target === 'field') {
    return (
      typeof value.entityId === 'string' && typeof value.fieldId === 'string'
    );
  }
  if (value.target === 'relationship') {
    return typeof value.relationshipId === 'string';
  }
  return false;
}

export function isDataModelDiffDiagram(
  value: unknown,
): value is DataModelDiffDiagram {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === PLAN_DIAGRAM_SCHEMA_VERSION &&
    isDataModelGraph(value.current) &&
    isDataModelGraph(value.planned) &&
    Array.isArray(value.changes) &&
    value.changes.every(isDataModelChange)
  );
}

/**
 * Validates the generation wrapper, not the diagram. Accepts
 * `{ applicable: false }` with no `diagram` and only requires a valid
 * `DataModelDiffDiagram` when `applicable === true`.
 */
export function isDataModelDiffGenerationResult(
  value: unknown,
): value is DataModelDiffGenerationResult {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== PLAN_DIAGRAM_SCHEMA_VERSION) return false;
  if (typeof value.applicable !== 'boolean') return false;
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    return false;
  }
  if (value.applicable === true) {
    return isDataModelDiffDiagram(value.diagram);
  }
  return value.diagram === undefined || isRecord(value.diagram);
}

// ===========================================================================
// Shared-plan scope / version / byte-limit constants.
// ===========================================================================

export const PLAN_SHARE_SCOPES = ['private', 'team', 'organization'] as const;
export type PlanShareScope = (typeof PLAN_SHARE_SCOPES)[number];

/**
 * Wire version of the shared-plan API. Bump only on breaking shape changes.
 */
export const SHARED_PLAN_API_VERSION = 1;

/**
 * Maximum number of raw bytes of plan `content` accepted by the shared-plan
 * API. Larger payloads are rejected at the route boundary (Backend plan).
 */
export const MAX_SHARED_PLAN_CONTENT_BYTES = 1024 * 1024;

/**
 * Maximum number of raw bytes of serialized `diagrams` accepted by the
 * shared-plan API. Larger payloads are rejected at the route boundary.
 */
export const MAX_SHARED_PLAN_DIAGRAMS_BYTES = 5 * 1024 * 1024;

/**
 * Maximum number of repository refs accepted by the shared-plan API.
 */
export const MAX_SHARED_PLAN_REPOSITORIES = 100;

/**
 * Maximum UTF-8 byte length for each repository string field accepted by the
 * shared-plan API.
 */
export const MAX_SHARED_PLAN_REPOSITORY_FIELD_BYTES = 2048;

/**
 * Review status carried by a shared plan. Mirrors the local
 * `TrackedPlanReviewStatus` union without importing desktop-shared.
 */
export type SharedPlanReviewStatus = 'pending' | 'approved' | 'dismissed';

// ===========================================================================
// Sanitized repository reference.
//
// "Relevant repos" travel as sanitized refs — never local filesystem paths,
// and `remoteUrl` is credential-stripped before it leaves the process (per the
// Backend plan's repo-snapshot step).
// ===========================================================================

export interface SharedPlanRepositoryRef {
  repoId: string;
  repoName: string;
  /** Credential-stripped remote URL (no embedded userinfo/token); sanitized per the Backend plan's repo-snapshot step. */
  remoteUrl: string | null;
  branch: string | null;
  commitSha: string | null;
  defaultBranch: string | null;
}

// ===========================================================================
// Plan comment threads (CAN-393).
//
// Comment threads round-trip desktop → server → web and back. The wire shapes
// here are the single source of truth; the desktop renderer keeps a superset
// (`PlanComment` carries a local-only `staged` draft flag) defined in
// desktop-shared, which re-exports the anchor / status / author types below so
// neither side duplicates them.
//
// Comment threads have an independent lifecycle from plan content and are
// intentionally EXCLUDED from `buildSharedPlanSnapshotInput(...)`. The sync
// "skip when snapshot unchanged" short-circuit must never suppress a comment
// pull, so comments never feed the snapshot hash.
// ===========================================================================

/**
 * Who authored a plan comment.
 *   - `user`   — the plan owner, authored locally on their desktop.
 *   - `agent`  — the owner's coding agent (chat handoff reply).
 *   - `remote` — a teammate who authored from the web; carries `remoteAuthor`.
 */
export type PlanCommentAuthorKind = 'user' | 'agent' | 'remote';

/** Identity of a remote (web) comment author, so the owner sees who replied. */
export interface PlanCommentRemoteAuthor {
  /** Server user id of the teammate who authored the comment. */
  userId: string;
  /** Display name; null when the user can no longer be resolved. */
  displayName: string | null;
}

export interface PlanCommentAnchor {
  /**
   * Exact RAW markdown of the anchored block (including formatting such as
   * inline code, links, and list markers). This is the source-of-truth quote
   * used for anchor matching and for the chat handoff, so the agent's edit
   * `old_string` can match the real plan content.
   */
  quote: string;
  /**
   * The rendered (display) text the user actually selected — formatting
   * stripped. Used for the inline highlight and the comment-card preview; it
   * is NOT reliable for matching the raw plan content.
   */
  renderedText?: string;
  /** 1-based start line of the anchored block in the canonical plan content. */
  lineStart?: number;
  /** 1-based end line of the anchored block in the canonical plan content. */
  lineEnd?: number;
  /** Enclosing ParsedPlanGraph node id (structural fallback). */
  planNodeId?: string;
  headingPath?: string[];
  /**
   * True for a general comment that is NOT anchored to any plan passage. Such
   * threads have an empty `quote`, are never highlighted in the document, and
   * always stay `matched` (there is nothing to go outdated).
   */
  unanchored?: boolean;
  /**
   * Where the comment originated. Absent = 'document'. Drives the source icon
   * and the agent handoff format.
   */
  source?: 'document' | 'diagram';
  /** For diagram-node comments: which visualizer tab the node belongs to. */
  diagramKind?: 'sequence' | 'logicDiff' | 'dataModelDiff';
}

export type PlanCommentThreadStatus = 'open' | 'resolved';
export type PlanCommentAnchorState = 'matched' | 'outdated';

/** A single comment on the wire (no local-only draft state). */
export interface WirePlanComment {
  id: string;
  author: PlanCommentAuthorKind;
  /** Present (and required) when `author === 'remote'`. */
  remoteAuthor?: PlanCommentRemoteAuthor;
  body: string;
  createdAt: string;
}

/** A comment thread on the wire. */
export interface WirePlanCommentThread {
  id: string;
  status: PlanCommentThreadStatus;
  createdAt: string;
  anchor: PlanCommentAnchor;
  anchorState: PlanCommentAnchorState;
  comments: WirePlanComment[];
}

// ===========================================================================
// Request DTOs.
// ===========================================================================

export interface SharedPlanCreateRequest {
  clientLocalPlanId: string;
  workspaceLocalId: string;
  worktreeLocalId: string;
  title: string;
  content: string;
  source: string;
  reviewStatus: SharedPlanReviewStatus;
  localRevisionNumber: number;
  localCreatedAt: string;
  localUpdatedAt: string;
  diagrams?: PlanDiagramArtifacts;
  repositories: SharedPlanRepositoryRef[];
  snapshotHash: string;
  /**
   * Local comment threads the owner's desktop is pushing up. Excluded from
   * `snapshotHash`; the server merges these with web-authored threads rather
   * than replacing them wholesale.
   */
  commentThreads?: WirePlanCommentThread[];
  shareScope?: PlanShareScope;
  teamId?: string;
  organizationId?: string;
}

export interface SharedPlanUpdateRequest extends Omit<
  SharedPlanCreateRequest,
  'shareScope' | 'teamId' | 'organizationId'
> {
  expectedSnapshotHash: string;
}

/**
 * Serialize a JSON-only value with sorted object keys so value-equal objects
 * produce identical strings regardless of insertion order. Shared with the
 * desktop inventory sync contract; the implementation lives in `../lib`.
 */
export { stableStringify } from '../lib/stable-stringify';
export { derivePlanTitle } from './plan-title';

// ===========================================================================
// Owner / actor / response shapes.
// ===========================================================================

export type SharedPlanOwner = ResourceOwner;

export interface SharedPlanActor {
  id: string;
  name: string | null;
  email: string | null;
}

export interface SharedPlanSummary {
  id: string;
  title: string;
  /** Stable SHA-256 hash of the canonical plan content. */
  contentHash: string;
  /** Stable SHA-256 hash of the canonical serialized diagrams. */
  diagramsHash: string;
  /** Stable SHA-256 hash of `buildSharedPlanSnapshotInput(...)` output. */
  snapshotHash: string;
  localRevisionNumber: number;
  remoteRevisionNumber: number;
  repositories: SharedPlanRepositoryRef[];
  shareScope: PlanShareScope;
  owner: SharedPlanOwner;
  createdBy: SharedPlanActor;
  createdAt: string;
  updatedAt: string;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface SharedPlanDetail extends SharedPlanSummary {
  /** Full plan content as the client posted it. */
  content: string;
  /** Generated diagram artifacts, when present. */
  diagrams?: PlanDiagramArtifacts;
  /**
   * Comment threads on this plan, merged across the owner's local threads and
   * any web-authored teammate threads. Present (possibly empty) on detail
   * reads; remote-authored comments carry their `remoteAuthor` identity.
   */
  commentThreads: WirePlanCommentThread[];
}

/**
 * Answer of `DELETE .../plans/{planId}` (CAN-5904), where `planId` is the
 * shared plan's `id` (the desktop's stored `remoteId`). The web route
 * hard-deletes the shared plan, with its revisions and comment threads, and
 * answers a uniform 404 for missing and unauthorized plans; the desktop
 * client maps that 404 to `{ unshared: false }` (already gone).
 */
export interface SharedPlanUnshareResult {
  unshared: boolean;
}

// ===========================================================================
// Approved (telemetry) plan read shapes.
//
// These describe the read-only view of a synced telemetry `Plan` — the
// point-in-time snapshot that drives the `plan_approved` activity-feed card.
// This is a DIFFERENT entity from `SharedPlan` above: an approved plan has no
// comment threads and is never edited from the web, so the read shapes carry
// only display metadata plus the decrypted markdown body.
//
// `id` is the telemetry `Plan.externalId`. `content` is the decrypted markdown,
// and is the empty string when no body was synced or it could not be decrypted.
// ===========================================================================

export interface ApprovedPlanSummary {
  id: string;
  title: string;
  reviewStatus: string | null;
  planVersion: number | null;
  /** ISO timestamp the owner started implementing this plan. */
  implementationStartedAt: string;
  updatedAt: string;
}

/**
 * Identity of the member who authored an approved plan, used to render the
 * read-only viewer's byline. `name` is the display name (possibly empty for a
 * removed/unknown actor); `image` is the avatar URL when one exists.
 */
export interface ApprovedPlanAuthor {
  name: string;
  image: string | null;
}

export interface ApprovedPlanDetail extends ApprovedPlanSummary {
  /** Decrypted markdown body; empty string when absent / not decryptable. */
  content: string;
  /** The member who authored the plan, for the viewer's byline. */
  author: ApprovedPlanAuthor;
}

// ===========================================================================
// Canonical snapshot-hash input.
//
// The desktop sync client's "skip sync when the snapshot is unchanged"
// short-circuit (Backend plan) compares a locally computed `snapshotHash`
// against the server-returned value. Both sides MUST derive that hash from the
// exact same byte string, so the hash *input* is built here, once, and each
// side runs SHA-256 over the returned string.
// ===========================================================================

export interface SharedPlanSnapshotInput {
  contentHash: string;
  diagramsHash: string;
  repositoriesHash: string;
  title: string;
  source: string;
  reviewStatus: SharedPlanReviewStatus;
  localRevisionNumber: number;
}

/**
 * Returns the stable, key-ordered JSON string that each side runs SHA-256
 * over to compute a plan's `snapshotHash`. The key order is fixed by this
 * object literal so the byte string is identical regardless of the order in
 * which the caller populated `input`.
 *
 * Intentionally free of `node:crypto`: only the string assembly lives here;
 * the SHA-256 call stays on each consuming side (web service + desktop sync
 * client).
 */
export function buildSharedPlanSnapshotInput(
  input: SharedPlanSnapshotInput,
): string {
  return JSON.stringify({
    contentHash: input.contentHash,
    diagramsHash: input.diagramsHash,
    repositoriesHash: input.repositoriesHash,
    title: input.title,
    source: input.source,
    reviewStatus: input.reviewStatus,
    localRevisionNumber: input.localRevisionNumber,
  });
}
