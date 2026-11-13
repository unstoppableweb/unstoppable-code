// ---------------------------------------------------------------------------
// Agent model contracts.
//
// An "Agent model" is a reusable model preset that combines a friendly name, a
// stable custom model ID (`agent_model_*`), a concrete provider base model,
// appended system instructions, and auto-enabled plugins. Agent models are
// registry overlays: they appear wherever models are chosen but resolve at
// execution time to a real base model (see the registry helpers in
// `../types` — `resolveRuntimeModel`, `isAgentModel`, `initAgentModels`).
//
// IMPORTANT: imports from the large `../types` barrel must stay type-only. The
// protocol package is the runtime owner of the shared Agent model prefix.
// ---------------------------------------------------------------------------

import type { ChatModel } from './chat-models';
import type { ChatTabPluginSelections } from '../execution-types';
import {
  AGENT_DEFAULT_BASE_MODEL,
  AGENT_MODEL_PREFIX,
  formatAgentRouteModelId,
  isAgentDefaultBaseModel,
  parseAgentRouteModelId,
  type AgentShareScope,
  type SharedAgentDocument,
  type SharedAgentDetail,
  type SharedAgentPublicShareInfo,
  type ListSharedAgentsResponse,
} from '@canopy/protocol/agents';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageInvocationDismissal,
  PipelinePackageReadiness,
} from './pipeline';
import type { PipelinePackageRef } from '@canopy/protocol/pipelines';
import type { PipelinePackageSummary } from '@canopy/protocol/pipelines';
import type {
  PublicShareVersion,
  ShareOperationResult,
} from '@canopy/protocol/sharing';

export {
  AGENT_DEFAULT_BASE_MODEL,
  AGENT_MODEL_PREFIX,
  formatAgentRouteModelId,
  isAgentDefaultBaseModel,
  parseAgentRouteModelId,
};

/** Canonical Claude model for PR and commit-message helper defaults. */
export const DEFAULT_HELPER_MODEL: ChatModel = 'sonnet';

/**
 * Persisted app-data shape for a custom Agent model. The `id` is generated
 * once on create and is stable across renames (see {@link deriveAgentModelId}).
 */
export interface AgentModelDefinition {
  id: string;
  name: string;
  /** A provider model, or {@link AGENT_DEFAULT_BASE_MODEL} to inherit. */
  baseModel: ChatModel;
  instructions: string;
  pluginSelections: ChatTabPluginSelections;
  createdAt: string;
  updatedAt: string;
  remoteId?: string;
  /** Cloud account that owns the author-side remote link. */
  remoteAccountId?: string;
  /** Import-only provenance; sharing an authored Agent never sets this. */
  importedFromRemoteId?: string;
  /** Local content fingerprint captured at import, including resolved copy IDs/names. */
  importedContentHash?: string;
  /**
   * Local canonical hash over `{ id, name, baseModel, instructions,
   * pluginSelections }`, recomputed on every local mutation. Detects local
   * drift. NOT comparable to the server hash (different plugin representation —
   * see the shared Agent protocol document).
   */
  contentHash?: string;
  /**
   * Opaque server hash of the shared document from the last successful
   * share/import. Stored verbatim, never recomputed locally; used as
   * `expectedContentHash` and for import idempotency. Undefined until the Agent
   * is first shared or imported.
   */
  remoteContentHash?: string;
  /** Public-share provenance recorded only on Agents installed from a link. */
  publicShareExternalId?: string;
  /** Pinned server hash paired with {@link publicShareExternalId}. */
  publicShareContentHash?: string;
}

/**
 * Derived snapshot shape fed into the shared model registry. Adds computed
 * availability fields so the UI can render stale-base Agents disabled.
 */
export interface AgentModelRegistryEntry {
  id: string;
  name: string;
  baseModel: ChatModel;
  instructions: string;
  pluginSelections: ChatTabPluginSelections;
  createdAt: string;
  updatedAt: string;
  available: boolean;
  unavailableReason?: 'base_model_unavailable';
}

// ---------------------------------------------------------------------------
// ID derivation and collision helpers.
//
// Pure so both the renderer and the backend store (and the shared-import ID
// minting path) call the same implementation.
// ---------------------------------------------------------------------------

/**
 * Normalize arbitrary user input into a valid Agent model ID slug.
 *
 * Algorithm: trim → lowercase → replace each run of non-`[a-z0-9]` with `_` →
 * collapse repeated `_` → trim leading/trailing `_` → fallback slug `agent`.
 */
export function normalizeAgentModelSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'agent';
}

export function agentModelIdFromSlug(slug: string): string {
  return `${AGENT_MODEL_PREFIX}${slug}`;
}

export function deriveAgentModelSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'agent';
}

export function isValidAgentModelSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(slug);
}

/**
 * Derive a durable Agent model ID from a display name.
 *
 * @example
 * deriveAgentModelId('Code Reviewer')  === 'agent_model_code_reviewer'
 * deriveAgentModelId('  GPT-5 Pro! ')  === 'agent_model_gpt_5_pro'
 * deriveAgentModelId('!!!')            === 'agent_model_agent'
 */
export function deriveAgentModelId(name: string): string {
  return agentModelIdFromSlug(deriveAgentModelSlug(name));
}

/**
 * Resolve a candidate Agent model ID against a set of already-used IDs,
 * appending `_2`, `_3`, … until unique. Used by the backend store and by the
 * shared-import ID minting path.
 */
export function resolveAgentModelIdCollision(
  baseId: string,
  usedIds: Iterable<string>,
): string {
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds);
  if (!used.has(baseId)) {
    return baseId;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseId}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

// ---------------------------------------------------------------------------
// Local Agents API request/response types.
//
// These are the desktop-local IPC shapes. The shared-Agent request types are
// redeclared here WITHOUT `serverId` (the desktop app is bound to a single
// Canopy Cloud backend, so local IPC never carries server identity) — exactly
// as `types/skills.ts` redeclares the Skills requests. The `serverId`-carrying
// wire types live in `@canopy/protocol/agents`.
// ---------------------------------------------------------------------------

export interface SaveAgentModelRequest {
  /** Omit to create; include the existing stable ID to update in place. */
  id?: string;
  name: string;
  /** User-editable suffix after `agent_model_`; honored only on create. */
  modelIdSlug?: string;
  baseModel: ChatModel;
  instructions: string;
  pluginSelections: ChatTabPluginSelections;
}

export interface DeleteAgentModelRequest {
  id: string;
  /** Share-landing uninstall must preserve locally edited imported copies. */
  importedShare?: { remoteId: string; contentHash: string };
}

export interface ListAgentModelsResponse {
  agents: AgentModelDefinition[];
}

/**
 * Desktop-local request to import a shared Agent from the configured Canopy
 * Cloud backend into the local Agent store. `agentId` is the server-side
 * shared resource UUID.
 */
export interface ImportSharedAgentRequest {
  agentId: string;
  installMissing?: boolean;
  /** Exact Cloud snapshot already shown in the import review. */
  reviewedAgent?: SharedAgentDetail;
}

export interface AnalyzeAgentCapabilityPackageRequest {
  agentModelId: string;
  dismissedInvocations?: PipelinePackageInvocationDismissal[];
}

export interface CommitAgentCapabilityPackageRequest {
  analysisId: string;
  selectedOptionalResourceIds?: string[];
}

export interface CommitAgentCapabilityPackageResponse {
  capabilityPackage: PipelinePackageRef;
  committedPackageUploadId: string;
}

export interface ImportSharedAgentResponse {
  agent: AgentModelDefinition;
  requestedId: string;
  finalId: string;
  idChanged: boolean;
}

export interface SharedAgentImportReadiness {
  agent: SharedAgentDetail;
  matchedRefs: string[];
  unmatchedRefs: string[];
  requirements: PipelinePackageReadiness['requirements'];
}

/** Desktop-local request to list shared Agents (serverId-free). */
export interface ListSharedAgentsRequest {
  limit?: number;
  cursor?: string;
  query?: string;
  createdBy?: 'me' | 'anyone';
}

/** Desktop-local request to create a shared Agent (serverId-free). */
export interface CreateSharedAgentRequest {
  agent: SharedAgentDocument;
  shareScope?: AgentShareScope;
  teamId?: string;
  organizationId?: string;
  capabilityPackage?: PipelinePackageRef | null;
  committedPackageUploadId?: string;
}

/** Desktop-local request to update a shared Agent (serverId-free). */
export interface UpdateSharedAgentRequest {
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

/** Desktop-local request to delete a shared Agent (serverId-free). */
export interface DeleteSharedAgentRequest {
  agentId: string;
}

export interface DetectPublicAgentRequest {
  agent: SharedAgentDocument;
  externalId: string;
  contentHash: string;
  package?: PipelinePackageSummary;
}

export interface ImportPublicAgentRequest {
  agent: SharedAgentDocument;
  externalId: string;
  contentHash: string;
  package?: PipelinePackageSummary;
  installMissing?: boolean;
}

export interface UninstallPublicAgentRequest {
  agentId: string;
  externalId: string;
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Preload bridge surface (`window.agents`).
// ---------------------------------------------------------------------------

export interface AgentModelsAPI {
  // ---- Local Agent model CRUD -------------------------------------------
  list(): Promise<ListAgentModelsResponse>;
  get(id: string): Promise<AgentModelDefinition | null>;
  save(request: SaveAgentModelRequest): Promise<AgentModelDefinition>;
  delete(request: DeleteAgentModelRequest): Promise<void>;
  importShared(
    request: ImportSharedAgentRequest,
  ): Promise<ImportSharedAgentResponse>;
  inspectImport(agentId: string): Promise<SharedAgentImportReadiness>;
  analyzeCapabilityPackage(
    request: AnalyzeAgentCapabilityPackageRequest,
  ): Promise<PipelinePackageAnalysisSummary>;
  cancelCapabilityPackageAnalysis(analysisId: string): Promise<void>;
  commitCapabilityPackage(
    request: CommitAgentCapabilityPackageRequest,
  ): Promise<ShareOperationResult<CommitAgentCapabilityPackageResponse>>;
  detectPublic(
    request: DetectPublicAgentRequest,
  ): Promise<AgentModelDefinition | null>;
  inspectPublic(
    request: DetectPublicAgentRequest,
  ): Promise<PipelinePackageReadiness>;
  importPublic(
    request: ImportPublicAgentRequest,
  ): Promise<AgentModelDefinition>;
  uninstallPublic(request: UninstallPublicAgentRequest): Promise<void>;

  // ---- Shared (Canopy Cloud) Agent CRUD ---------------------------------
  //
  // Each handler proxies to the configured Canopy Cloud backend. Resolved
  // errors are surfaced via promise rejection; success responses contain the
  // parsed wire DTO. Create, update and package commit resolve a
  // `ShareOperationResult` instead so structured failures survive IPC.
  listShared(
    request: ListSharedAgentsRequest,
  ): Promise<ListSharedAgentsResponse>;
  getShared(agentId: string): Promise<SharedAgentDetail>;
  createShared(
    request: CreateSharedAgentRequest,
  ): Promise<ShareOperationResult<SharedAgentDetail>>;
  updateShared(
    request: UpdateSharedAgentRequest,
  ): Promise<ShareOperationResult<SharedAgentDetail>>;
  deleteShared(request: DeleteSharedAgentRequest): Promise<void>;
  publishPublicShare(agentId: string): Promise<SharedAgentPublicShareInfo>;
  revokePublicShare(agentId: string): Promise<void>;

  // ---- Local registry change notifications ------------------------------
  //
  // Fired by the main process after the local Agent store mutates so the
  // renderer can re-hydrate the model registry. Returns an unsubscribe handle.
  onChanged(callback: () => void): () => void;
}

// Re-export the shared-Agent wire shapes so renderer modules can import them
// from `@canopy/execution-engine/types/agent-models` rather than reaching
// directly into the protocol package.
export type {
  AgentShareActor,
  AgentShareOwner,
  AgentShareScope,
  ListSharedAgentsResponse,
  SharedAgentDetail,
  SharedAgentDocument,
  SharedAgentSummary,
  SharedAgentPublicShareInfo,
} from '@canopy/protocol/agents';

export {
  AGENT_SHARE_SCOPES,
  MAX_SHARED_AGENT_BYTES,
  SHARED_AGENT_API_VERSION,
} from '@canopy/protocol/agents';
