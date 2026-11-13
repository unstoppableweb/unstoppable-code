import { MARKETPLACE_PUBLIC_SHARE_PREFIXES } from '../marketplace';
import type { ResourceOwner } from '../resource-owner';
import type { PublicShareVersion } from '../sharing';
// ---------------------------------------------------------------------------
// Shared custom-Agent API contracts.
//
// These wire shapes are consumed by:
//   - The web Canopy Server route handlers for shared custom Agents.
//   - The desktop main process when proxying Agent share/import operations
//     through a configured Canopy Server.
//   - The desktop renderer (via the `window.agents` preload bridge) for
//     listing/searching/importing shared Agents authored by other users.
//
// The shapes here are the canonical request/response payloads. Local-only
// concerns (registry overlay, ID derivation, persisted app-data shape) live in
// `packages/execution-engine/src/types/agent-models.ts`.
//
// Intentional divergence from Skills: a shared Skill ships the raw `SKILL.md`
// bytes as `rawSkill: string`. An Agent has no single canonical source file —
// it is composed of a base model, appended instructions, and portable plugin
// refs — so the canonical shared form is the structured
// {@link SharedAgentDocument}, carried on {@link SharedAgentDetail.agent}
// (where Skills put `rawSkill`). It is deliberately kept structured and must
// not be collapsed to a raw string to "match" Skills.
//
// This module must remain pure: no Node, Electron, React, Prisma, or app
// imports. It runs in the renderer, the main process, and the web app.
// ---------------------------------------------------------------------------

import { isShareablePluginRef, type ShareablePluginRef } from '../plugins';
import { normalizeShareablePluginRef } from '../plugins';
import type {
  PipelineDistributionMode,
  PipelinePackageRef,
  PipelinePackageSummary,
} from '../pipelines/package';

/**
 * Wire version of the shared-Agent API. Bump only on breaking shape changes.
 */
export const SHARED_AGENT_API_VERSION = 1;

/** Canonical public web path for shared Agent snapshots. */
export const AGENT_SHARE_PATH_PREFIX = MARKETPLACE_PUBLIC_SHARE_PREFIXES.agent;

export function agentSharePath(externalId: string): string {
  return `${AGENT_SHARE_PATH_PREFIX}/${externalId}`;
}

/**
 * Visibility scope for a shared custom Agent. The scope is decided at create
 * time and is mutable later only by changing the share scope explicitly.
 *
 * - `private` — visible to the author only.
 * - `team` — visible to every member of the owning team.
 * - `organization` — visible to every member of the owning organization.
 */
export const AGENT_SHARE_SCOPES = ['private', 'team', 'organization'] as const;

export type AgentShareScope = (typeof AGENT_SHARE_SCOPES)[number];

/**
 * Maximum number of serialized bytes accepted for a single shared Agent
 * document. Larger payloads are rejected at the route boundary so the renderer
 * / main process never round-trip excessively large Agents. Mirrors Skills'
 * `MAX_SHARED_SKILL_BYTES = 1 MiB`, sized down for the far smaller structured
 * Agent form.
 */
export const MAX_SHARED_AGENT_BYTES = 256 * 1024;

/** Maximum length (characters) of a shared Agent's friendly name. */
export const MAX_SHARED_AGENT_NAME_LENGTH = 200;

/** Maximum length (characters) of a shared Agent's portable model id. */
export const MAX_SHARED_AGENT_ID_LENGTH = 200;

/** Maximum serialized byte length of a shared Agent's appended instructions. */
export const MAX_SHARED_AGENT_INSTRUCTIONS_BYTES = 64 * 1024;

/**
 * Canonical prefix for portable Agent model IDs, e.g.
 * `agent_model_code_reviewer`.
 */
export const AGENT_MODEL_PREFIX = 'agent_model_';
/** @deprecated Use {@link AGENT_MODEL_PREFIX}. */
export const AGENT_MODEL_ID_PREFIX = AGENT_MODEL_PREFIX;
const AGENT_MODEL_ID_SLUG_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function isValidSharedAgentModelId(id: string): boolean {
  if (!id.startsWith(AGENT_MODEL_PREFIX)) {
    return false;
  }
  return AGENT_MODEL_ID_SLUG_PATTERN.test(id.slice(AGENT_MODEL_PREFIX.length));
}

/**
 * `baseModel` of an Agent that runs on its destination chat's Settings default
 * instead of a pinned provider model. Stored and shared verbatim, so share,
 * import and content hashes keep the inherited choice rather than the
 * author's concrete default.
 */
export const AGENT_DEFAULT_BASE_MODEL = 'default';

export function isAgentDefaultBaseModel(baseModel: string): boolean {
  return baseModel === AGENT_DEFAULT_BASE_MODEL;
}

/** User-facing name of an Agent's base model. */
export function describeAgentBaseModel(
  baseModel: string,
  modelLabel: (model: string) => string = (model) => model,
): string {
  return isAgentDefaultBaseModel(baseModel)
    ? 'Default model'
    : modelLabel(baseModel);
}

/**
 * Separates an Agent id from the concrete base model a chat resolved for it,
 * e.g. `agent_model_reviewer@gpt-6-luna`. Agent ids cannot contain `@`.
 */
export const AGENT_ROUTE_SEPARATOR = '@';

/**
 * Chat model id that retains the concrete route an inheriting Agent resolved
 * when the chat was instantiated, so later Settings changes cannot reroute it.
 */
export function formatAgentRouteModelId(
  agentId: string,
  baseModel: string,
): string {
  return `${agentId}${AGENT_ROUTE_SEPARATOR}${baseModel}`;
}

/** Split a {@link formatAgentRouteModelId} id; null for any other model id. */
export function parseAgentRouteModelId(
  model: string,
): { agentId: string; baseModel: string } | null {
  const separator = model.indexOf(AGENT_ROUTE_SEPARATOR);
  if (separator < 0) return null;
  const agentId = model.slice(0, separator);
  const baseModel = model.slice(separator + AGENT_ROUTE_SEPARATOR.length);
  if (
    !isValidSharedAgentModelId(agentId) ||
    baseModel.length === 0 ||
    baseModel.startsWith(AGENT_MODEL_PREFIX) ||
    isAgentDefaultBaseModel(baseModel)
  ) {
    return null;
  }
  return { agentId, baseModel };
}

/**
 * Whether a chat's model is the selection `selected` names. A Default-model
 * Agent is chosen by its bare id but stored as its pinned route.
 */
export function isSameModelSelection(
  model: string | undefined,
  selected: string,
): boolean {
  if (model === undefined) return false;
  return (
    model === selected || parseAgentRouteModelId(model)?.agentId === selected
  );
}

// ---------------------------------------------------------------------------
// Owner / actor metadata (mirrors the Skills convention).
// ---------------------------------------------------------------------------

export type AgentShareOwner = ResourceOwner;

export interface AgentShareActor {
  id: string;
  name: string | null;
  email: string | null;
}

// ---------------------------------------------------------------------------
// Canonical shared Agent document.
//
// This is the portable, structured representation of a custom Agent. Unlike a
// shared Skill (raw bytes), the Agent is composed of a base model, appended
// instructions, and a list of portable plugin refs. `ShareablePluginRef[]` is
// the ONLY representable plugin form, so local-only plugin selections that do
// not map to a shareable ref are blocked at the boundary rather than silently
// omitted.
// ---------------------------------------------------------------------------

export interface SharedAgentDocument {
  version: 1;
  /**
   * Portable Agent model ID, e.g. `agent_model_code_reviewer`. This is the
   * stable custom model ID, NOT the server-side shared resource UUID.
   */
  id: string;
  name: string;
  baseModel: string;
  instructions: string;
  plugins: ShareablePluginRef[];
}

// ---------------------------------------------------------------------------
// Response DTOs.
// ---------------------------------------------------------------------------

export interface SharedAgentPublicShareInfo {
  externalId: string;
  pinnedContentHash: string;
  upToDate: boolean;
  sharePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface SharedAgentSummary {
  /**
   * Server-side shared resource UUID (analogous to a shared Skill's `id` and
   * the `[agentId]` route param). This is NOT the portable Agent model ID —
   * see {@link SharedAgentDocument.id} for that.
   */
  id: string;
  name: string;
  /** Portable Agent model ID (`agent_model_*`); equals the document's `id`. */
  modelId: string;
  baseModel: string;
  instructionsPreview: string;
  /**
   * Stable content hash of the shared Agent document, computed by the server
   * before storage. Used by clients to detect remote changes. NOT comparable
   * to the desktop-local `contentHash` (different plugin representation).
   */
  contentHash: string;
  shareScope: AgentShareScope;
  owner: AgentShareOwner;
  createdAt: string;
  updatedAt: string;
  createdBy: AgentShareActor;
  canUpdate: boolean;
  canDelete: boolean;
  publicShare?: SharedAgentPublicShareInfo | null;
}

export interface SharedAgentDetail extends SharedAgentSummary {
  /** The full portable Agent document. Clients import this verbatim. */
  agent: SharedAgentDocument;
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
}

// ---------------------------------------------------------------------------
// Request DTOs (desktop/web → Canopy Server; carry `serverId`).
// ---------------------------------------------------------------------------

export interface ListSharedAgentsRequest {
  serverId: string;
  limit?: number;
  cursor?: string;
  query?: string;
  createdBy?: 'me' | 'anyone';
}

export interface ListSharedAgentsResponse {
  agents: SharedAgentSummary[];
  nextCursor?: string;
}

export interface GetSharedAgentRequest {
  serverId: string;
  /** Server-side shared resource UUID. */
  agentId: string;
}

export interface CreateSharedAgentRequest {
  serverId: string;
  agent: SharedAgentDocument;
  shareScope?: AgentShareScope;
  teamId?: string;
  organizationId?: string;
  capabilityPackage?: PipelinePackageRef | null;
  committedPackageUploadId?: string;
}

export interface UpdateSharedAgentRequest {
  serverId: string;
  /** Server-side shared resource UUID. */
  agentId: string;
  agent: SharedAgentDocument;
  expectedContentHash?: string;
  shareScope?: AgentShareScope;
  teamId?: string;
  organizationId?: string;
  capabilityPackage?: PipelinePackageRef | null;
  committedPackageUploadId?: string;
  revokePublicShare?: PublicShareVersion;
}

/** Canonical bytes hashed by the server and desktop package analyzer. */
export function serializeSharedAgentForHash(
  agent: SharedAgentDocument,
): string {
  return JSON.stringify({
    version: 1,
    id: agent.id,
    name: agent.name.trim(),
    baseModel: agent.baseModel,
    instructions: agent.instructions,
    plugins: agent.plugins.map((plugin) => normalizeShareablePluginRef(plugin)),
  } satisfies SharedAgentDocument);
}

export interface DeleteSharedAgentRequest {
  serverId: string;
  /** Server-side shared resource UUID. */
  agentId: string;
}

export interface PublishSharedAgentPublicShareResponse {
  publicShare: SharedAgentPublicShareInfo;
}

// ---------------------------------------------------------------------------
// Validation (part of the protocol contract).
//
// The document is the wire boundary between desktop and Canopy Cloud, so its
// invariants are enforced here rather than duplicated per consumer.
// ---------------------------------------------------------------------------

export type SharedAgentValidationResult =
  | { ok: true; document: SharedAgentDocument }
  | { ok: false; error: string };

/** UTF-8 byte length of a JSON-serialized value (browser + Node safe). */
export function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** True iff every entry is a structurally valid {@link ShareablePluginRef}. */
export function isShareableAgentPluginList(
  value: unknown,
): value is ShareablePluginRef[] {
  return (
    Array.isArray(value) && value.every((ref) => isShareablePluginRef(ref))
  );
}

/**
 * Validate an untrusted value as a {@link SharedAgentDocument}. Returns a
 * discriminated result rather than throwing so route handlers and the import
 * flow can surface an actionable error message.
 */
export function validateSharedAgentDocument(
  value: unknown,
): SharedAgentValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Agent document must be an object.' };
  }
  const doc = value as Record<string, unknown>;

  if (doc.version !== SHARED_AGENT_API_VERSION) {
    return {
      ok: false,
      error: `Unsupported shared Agent version; expected ${SHARED_AGENT_API_VERSION}.`,
    };
  }
  if (typeof doc.id !== 'string' || !isValidSharedAgentModelId(doc.id)) {
    return {
      ok: false,
      error: `Agent id must start with "${AGENT_MODEL_PREFIX}" and use a lowercase slug with letters, numbers, and single underscores.`,
    };
  }
  if (doc.id.length > MAX_SHARED_AGENT_ID_LENGTH) {
    return {
      ok: false,
      error: `Agent id exceeds ${MAX_SHARED_AGENT_ID_LENGTH} characters.`,
    };
  }
  if (typeof doc.name !== 'string' || doc.name.trim().length === 0) {
    return { ok: false, error: 'Agent name is required.' };
  }
  if (doc.name.length > MAX_SHARED_AGENT_NAME_LENGTH) {
    return {
      ok: false,
      error: `Agent name exceeds ${MAX_SHARED_AGENT_NAME_LENGTH} characters.`,
    };
  }
  if (typeof doc.baseModel !== 'string' || doc.baseModel.trim().length === 0) {
    return { ok: false, error: 'Agent baseModel is required.' };
  }
  if (doc.baseModel.startsWith(AGENT_MODEL_PREFIX)) {
    return {
      ok: false,
      error: 'Agent baseModel must be a provider model, not another Agent.',
    };
  }
  if (typeof doc.instructions !== 'string') {
    return { ok: false, error: 'Agent instructions must be a string.' };
  }
  if (
    serializedByteLength(doc.instructions) > MAX_SHARED_AGENT_INSTRUCTIONS_BYTES
  ) {
    return {
      ok: false,
      error: `Agent instructions exceed ${MAX_SHARED_AGENT_INSTRUCTIONS_BYTES} bytes.`,
    };
  }
  if (!isShareableAgentPluginList(doc.plugins)) {
    return {
      ok: false,
      error: 'Agent plugins must all be shareable plugin refs.',
    };
  }

  const document: SharedAgentDocument = {
    version: SHARED_AGENT_API_VERSION,
    id: doc.id,
    name: doc.name,
    baseModel: doc.baseModel,
    instructions: doc.instructions,
    plugins: doc.plugins,
  };

  if (serializedByteLength(document) > MAX_SHARED_AGENT_BYTES) {
    return {
      ok: false,
      error: `Shared Agent document exceeds ${MAX_SHARED_AGENT_BYTES} bytes.`,
    };
  }

  return { ok: true, document };
}

/** Non-throwing type guard for {@link SharedAgentDocument}. */
export function isSharedAgentDocument(
  value: unknown,
): value is SharedAgentDocument {
  return validateSharedAgentDocument(value).ok;
}
