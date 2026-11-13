import type { AiGatewayModelEntry, GatewayRouteEntry } from './execution-types';
import { getRawCopilotModelId, isCopilotModel } from './lib/copilot-models';
import {
  cursorModelLabelParts,
  getRawCursorModelId,
  isCursorModel,
} from './lib/cursor-models';
import { getRawOpenCodeModelId, isOpenCodeModel } from './lib/opencode-models';
import {
  getEffectiveModelHarness as resolveEffectiveModelHarness,
  getHydratedModelHarnessAssignment as resolveHydratedModelHarnessAssignment,
  getModelHarnessSource as resolveHarnessSource,
} from './model-harnesses';
import {
  THINKING_LEVELS,
  clampModelThinkingLevel,
  isThinkingLevel,
  providerFallbackThinkingLevels,
} from './thinking';
import {
  AGENT_MODEL_PREFIX,
  isAgentDefaultBaseModel,
  parseAgentRouteModelId,
} from './types/agent-models';
import type { AgentModelRegistryEntry } from './types/agent-models';
import type { ChatModel } from './types/chat-models';
import type { CopilotModelEntry } from './types/copilot-models';
import type { CursorModelEntry } from './types/cursor-models';
import type {
  ModelHarness,
  ModelHarnessCatalog,
  ModelHarnessSource,
} from './types/model-harnesses';
import type { OpenCodeModelEntry } from './types/opencode-models';
import type { ThinkingLevel } from './types/thinking';
import type { AgentProviderType } from '@canopy/agent-transcript';
import type {
  AiGatewayHarness,
  AiGatewayModelFamily,
} from '@canopy/protocol/ai-gateway-models';
import type {
  ClientFeatureFlagKey,
  ClientFeatureFlagValues,
} from '@canopy/protocol/feature-flags';
import type {
  GatewayModelConfig,
  GatewayModelEntry,
} from '@canopy/protocol/llm-gateway';

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Claude models — loaded at runtime from package.json's "claude-code.models"
// array, mirroring the codex pattern.
// ---------------------------------------------------------------------------

export interface ConfiguredModelBillingMetadata {
  extraChargeOnly?: boolean;
  extraChargeMessage?: string;
}

export interface ConfiguredModelEntry extends ConfiguredModelBillingMetadata {
  id: string;
  label: string;
  family?: string;
  familyLabel?: string;
  vendor?: string;
  sortOrder?: number;
  description?: string;
  /** Place this entry in the nested More menu for its model family. */
  showMoreOnly?: boolean;
  /** Runtime scaffold. Native sections supply a section-specific default. */
  harness?: AiGatewayHarness;
  /** Whether this entry appears in selectable model catalogs. Defaults true. */
  selectable?: boolean;
  /** Exact package-owned AI Gateway pin used only for catalog matching. */
  gatewayId?: string;
  /** Exact Cursor base model ID used only with advertised runtime models. */
  cursorModelId?: string;
  /** Runtime gateway metadata attached by the validated catalog merge. */
  gateway?: GatewayModelConfig;
  featureFlag?: ClientFeatureFlagKey;
  contextWindow?: number;
  /**
   * Thinking settings this model supports, in ascending order of effort.
   * The set is exact — `off` must be listed when the model supports disabling
   * thinking. When omitted, the provider default applies (Claude/Ollama:
   * off…max, Codex: off…xhigh) — see
   * {@link getSupportedThinkingLevelsForModel}.
   */
  supportedThinkingLevels?: ThinkingLevel[];
}

/** Shape of a single entry in package.json → claude-code.models. */
export interface ClaudeModelEntry extends ConfiguredModelEntry {
  harness?: 'claude';
}

/**
 * ClaudeModel is a string — model IDs are defined in package.json, not in code.
 * Use {@link isClaudeModel} for runtime checks.
 */
export type ClaudeModel = string;

/** Mutable runtime list of claude model IDs — populated by {@link initClaudeModels}. */
export const CLAUDE_MODELS: string[] = [];

// ---------------------------------------------------------------------------
// Codex models — loaded at runtime from package.json's "codex.models" array.
// ---------------------------------------------------------------------------

/** Shape of a single entry in package.json → codex.models. */
export interface CodexModelEntry extends ConfiguredModelEntry {
  harness?: 'codex';
}

/** Mutable runtime list of codex model IDs — populated by {@link initCodexModels}. */
export const CODEX_MODELS: string[] = [];

/**
 * Codex models the signed-in ChatGPT account lists through `model/list` that
 * the package catalog does not (CAN-4716), populated by
 * {@link setCodexAccountModels}. A separate overlay like {@link AGENT_MODELS}:
 * {@link CODEX_MODELS} and `DEFAULT_CODEX_MODEL` never change, and re-running
 * any registry init keeps these. They have no gateway route, so they only ever
 * run on the native Codex lane.
 */
export const CODEX_ACCOUNT_MODELS: string[] = [];

/** Whether `resolved` is a Codex-harness model: catalog or account-only. */
function isCodexHarnessModelId(resolved: string): boolean {
  return (
    CODEX_MODELS.includes(resolved) || CODEX_ACCOUNT_MODELS.includes(resolved)
  );
}

/** Cursor catalog metadata is discovered lazily; persisted identity survives cold starts. */
export const CURSOR_MODELS: string[] = ['cursor-default'];

export const COPILOT_MODELS: string[] = [];

let copilotEntries: CopilotModelEntry[] = [];

export function initCopilotModels(entries: readonly CopilotModelEntry[]): void {
  _managedPickerMappings.delete('copilot');
  copilotEntries = entries
    .filter((entry) => isCopilotModel(entry.id))
    .map((entry) => ({
      ...entry,
      supportedThinkingLevels: [...entry.supportedThinkingLevels],
    }));
  COPILOT_MODELS.splice(
    0,
    COPILOT_MODELS.length,
    ...copilotEntries.map((entry) => entry.id),
  );
}

export function getCopilotModelEntries(): CopilotModelEntry[] {
  return copilotEntries.map((entry) => ({
    ...entry,
    supportedThinkingLevels: [...entry.supportedThinkingLevels],
  }));
}

export const OPENCODE_MODELS: string[] = [];

let opencodeEntries: OpenCodeModelEntry[] = [];

export function initOpenCodeModels(
  entries: readonly OpenCodeModelEntry[],
): void {
  _managedPickerMappings.delete('opencode');
  opencodeEntries = entries
    .filter((entry) => isOpenCodeModel(entry.id))
    .map((entry) => ({
      ...entry,
      supportedThinkingLevels: [...entry.supportedThinkingLevels],
    }));
  OPENCODE_MODELS.splice(
    0,
    OPENCODE_MODELS.length,
    ...opencodeEntries.map((entry) => entry.id),
  );
}

export function getOpenCodeModelEntries(): OpenCodeModelEntry[] {
  return opencodeEntries.map((entry) => ({
    ...entry,
    supportedThinkingLevels: [...entry.supportedThinkingLevels],
  }));
}

// Cursor discovery has its own lifecycle, independent of registry snapshots.
// Exact per-variant thinking support from the runtime's per-model listing.
const _cursorSupportedThinkingLevels = new Map<
  string,
  readonly ThinkingLevel[]
>();

let _cursorEntries: CursorModelEntry[] = [];

let _cursorMappings: Readonly<Record<string, string>> | undefined;

let _cursorLabels: ReadonlyMap<string, string> | undefined;

// Identity survives discovery failures and policy filtering; this catalog is
// metadata only and never grants execution availability.
const _pickerNativeCatalog: {
  claude: ClaudeModelEntry[];
  codex: CodexModelEntry[];
  gateway: ConfiguredModelEntry[];
} = { claude: [], codex: [], gateway: [] };

// Every Codex id the package catalog configures, including flag-gated,
// non-selectable and policy-filtered entries: never an account-only model.
const _configuredCodexCatalogIds = new Set<string>();

function normalizeCursorIdentity(id: string): string {
  return id.replace(/^(anthropic|openai)\//, '').replace(/\./g, '-');
}

function cursorIdentityMatches(
  raw: string,
  entry: ConfiguredModelEntry,
): boolean {
  const base = raw.replace(/\[[^\]]*\]$/, '');
  if (entry.cursorModelId) return base === entry.cursorModelId;
  return [entry.id, entry.gatewayId].some(
    (id) => id && normalizeCursorIdentity(id) === normalizeCursorIdentity(base),
  );
}

/** Preserve curated Cursor metadata across the host's registry projection. */
export function getConfiguredCursorModelId(model: string): string | undefined {
  return [..._pickerNativeCatalog.claude, ..._pickerNativeCatalog.codex].find(
    (entry) => entry.id === model,
  )?.cursorModelId;
}

function findCursorNativeEntry(
  model: string,
): ConfiguredModelEntry | undefined {
  const raw = getRawCursorModelId(model);
  if (!raw || model === 'cursor-default') return undefined;
  const matches = [
    ..._pickerNativeCatalog.claude,
    ..._pickerNativeCatalog.codex,
    ..._pickerNativeCatalog.gateway.filter((entry) => entry.cursorModelId),
  ].filter((entry) => cursorIdentityMatches(raw, entry));
  return matches.length === 1 ? matches[0] : undefined;
}

/** All persisted variants share the provider policy identity, even offline. */
export function getCursorModelPolicyIdentity(model: string): string {
  const entry = findCursorNativeEntry(model);
  return entry?.gatewayId ?? entry?.id ?? model;
}

export function getCursorModelEntries(): CursorModelEntry[] {
  return _cursorEntries.map((entry) => ({ ...entry }));
}

/** Match IDs, never labels. Prefer an advertised unconfigured variant for the
 * default; additional variants retain their exact IDs and separate labels. */
export function getCursorModelMappings(): Readonly<Record<string, string>> {
  if (_cursorMappings) return _cursorMappings;
  const mappings: Record<string, string> = {};
  const nativeEntries = [
    ..._pickerNativeCatalog.claude,
    ..._pickerNativeCatalog.codex,
    ..._pickerNativeCatalog.gateway.filter((entry) => entry.cursorModelId),
  ];
  for (const entry of nativeEntries) {
    const candidates = _cursorEntries.filter((model) =>
      cursorIdentityMatches(model.rawModelId, entry),
    );
    // Prefer the unconfigured runtime choice when it exists. Variant IDs remain
    // opaque and are never reconstructed from the mapping metadata.
    const selected =
      candidates.find(
        (model) =>
          !model.rawModelId.includes('[') || model.rawModelId.endsWith('[]'),
      ) ?? candidates[0];
    if (selected) mappings[entry.id] = selected.id;
  }
  // Native aliases that point at the same vendor identity are ambiguous too.
  for (const [id, cursorId] of Object.entries(mappings)) {
    if (
      Object.values(mappings).filter((value) => value === cursorId).length > 1
    ) {
      for (const duplicate of Object.keys(mappings))
        if (mappings[duplicate] === cursorId) delete mappings[duplicate];
      delete mappings[id];
    }
  }
  _cursorMappings = Object.freeze(mappings);
  return _cursorMappings;
}

export function getCanonicalCursorModel(model: string): string {
  const entry = findCursorNativeEntry(model);
  if (!entry) return model;
  // Additional live variants retain their labels/rows. Before discovery,
  // persisted selections still have a stable native identity and label.
  return !_cursorEntries.some((candidate) => candidate.id === model) ||
    getCursorModelMappings()[entry.id] === model
    ? entry.id
    : model;
}

/** Presentation equivalence only. Never resolve persisted execution IDs through this map. */
const _managedPickerMappings = new Map<
  'copilot' | 'opencode',
  {
    native: Readonly<Record<string, string>>;
    runtime: ReadonlyMap<string, string>;
  }
>();

function pickerModelIdentity(
  model: string,
  harness: 'copilot' | 'opencode',
): string | undefined {
  if (harness === 'copilot') return getRawCopilotModelId(model);
  const raw = getRawOpenCodeModelId(model);
  // Custom provider names do not establish equivalence with our catalog.
  if (
    !raw ||
    !/^(anthropic|openai|google|github-copilot|opencode|openrouter)\//.test(raw)
  )
    return undefined;
  return raw.slice(raw.indexOf('/') + 1);
}

/** One exact advertised route per native row and harness. Ambiguity stays separate. */
export function getModelPickerMappings(
  harness: 'cursor' | 'copilot' | 'opencode',
): Readonly<Record<string, string>> {
  if (harness === 'cursor') return getCursorModelMappings();
  const cached = _managedPickerMappings.get(harness);
  if (cached) return cached.native;
  const nativeEntries = [
    ..._pickerNativeCatalog.claude,
    ..._pickerNativeCatalog.codex,
    ..._pickerNativeCatalog.gateway,
  ];
  const entries = harness === 'copilot' ? copilotEntries : opencodeEntries;
  const candidates = new Map<string, string[]>();
  for (const model of entries) {
    const raw = pickerModelIdentity(model.id, harness);
    if (!raw) continue;
    const matches = nativeEntries.filter((entry) =>
      [entry.id, entry.gatewayId].some(
        (id) =>
          id && normalizeCursorIdentity(id) === normalizeCursorIdentity(raw),
      ),
    );
    if (matches.length !== 1) continue;
    const id = matches[0].id;
    candidates.set(id, [...(candidates.get(id) ?? []), model.id]);
  }
  const native: Record<string, string> = {};
  const runtime = new Map<string, string>();
  for (const [id, routes] of Array.from(candidates)) {
    if (routes.length !== 1) continue;
    native[id] = routes[0];
    runtime.set(routes[0], id);
  }
  const result = { native: Object.freeze(native), runtime };
  _managedPickerMappings.set(harness, result);
  return result.native;
}

export function getCanonicalPickerModel(model: string): string {
  const harness = isCopilotModel(model)
    ? 'copilot'
    : isOpenCodeModel(model)
      ? 'opencode'
      : undefined;
  if (!harness) return getCanonicalCursorModel(model);
  getModelPickerMappings(harness);
  return _managedPickerMappings.get(harness)?.runtime.get(model) ?? model;
}

/** Materialize a fresh chat default without reinterpreting saved runtime IDs. */
export function resolveDefaultChatModel(model: string): string {
  const assignment = resolveHydratedModelHarnessAssignment(
    model,
    _modelAliases,
  );
  return assignment?.harness === 'cursor'
    ? (getCursorModelMappings()[resolveModelAlias(model)] ?? model)
    : model;
}

export function initCursorModels(entries: CursorModelEntry[]): void {
  _cursorMappings = undefined;
  _managedPickerMappings.clear();
  _cursorLabels = undefined;
  _cursorEntries = entries
    .filter((entry) => isCursorModel(entry.id))
    .map((entry) => ({ ...entry }));
  _cursorSupportedThinkingLevels.clear();
  CURSOR_MODELS.splice(0, CURSOR_MODELS.length, 'cursor-default');
  for (const entry of _cursorEntries) {
    if (!CURSOR_MODELS.includes(entry.id)) CURSOR_MODELS.push(entry.id);
    if (entry.supportedThinkingLevels)
      _cursorSupportedThinkingLevels.set(entry.id, [
        ...entry.supportedThinkingLevels,
      ]);
  }
}

/**
 * Thinking support for a Cursor runtime identity. Support is exact per
 * advertised variant; a variant the listing never described, Auto, and a
 * cold start before discovery all hide the control rather than invent tiers.
 */
function getCursorSupportedThinkingLevels(
  cursorModel: string,
): readonly ThinkingLevel[] {
  return (
    _cursorSupportedThinkingLevels.get(cursorModel) ??
    DEFAULT_SUPPORTED_THINKING_LEVELS.cursor
  );
}

/** Mutable runtime list of API-only AI Gateway model IDs. */
export const AI_GATEWAY_MODELS: string[] = [];

// ---------------------------------------------------------------------------
// Ollama models — discovered at runtime from the local Ollama server.
// ---------------------------------------------------------------------------

/** Canonical prefix for Ollama model IDs within Canopy. */
export const OLLAMA_MODEL_PREFIX = 'ollama-';

export interface OllamaModelDetails {
  parentModel?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameterSize?: string;
  quantizationLevel?: string;
}

export interface OllamaShowMessageEntry {
  role: string;
  content: string;
  thinking?: string;
  toolName?: string;
}

export interface OllamaShowInfo {
  capabilities?: string[];
  license?: string;
  parameters?: string;
  template?: string;
  system?: string;
  messages?: OllamaShowMessageEntry[];
  modelInfoJson?: string;
  projectorInfoJson?: string;
  rawJson?: string;
}

/** Shape of a single Ollama model entry. */
export interface OllamaModelEntry {
  id: string;
  rawModelId: string;
  label: string;
  sizeBytes?: number;
  modifiedAt?: string;
  digest?: string;
  expiresAt?: string;
  sizeVramBytes?: number;
  details?: OllamaModelDetails;
  show?: OllamaShowInfo;
}

export const REQUIRED_OLLAMA_CAPABILITIES = ['completion', 'tools'] as const;

/** Mutable runtime list of ollama model IDs — populated by {@link initOllamaModels}. */
export const OLLAMA_MODELS: string[] = [];

/**
 * Mutable runtime list of custom Agent model IDs — populated by
 * {@link initAgentModels}. Agent models are registry overlays that resolve at
 * execution time to a real base model.
 */
export const AGENT_MODELS: string[] = [];

function createModelRegistryMap<Value>(): Record<string, Value> {
  const registry: Record<string, Value> = {};
  Object.setPrototypeOf(registry, null);
  return registry;
}

/** Runtime map of Agent model ID → derived registry entry. */
const _agentModels: Record<string, AgentModelRegistryEntry> =
  createModelRegistryMap();

/**
 * Registry entry for an Agent id, or for a chat route id that pins an
 * inheriting Agent to the base model resolved when its chat was instantiated.
 */
function lookupAgentModelEntry(
  model: string,
): AgentModelRegistryEntry | undefined {
  const direct = _agentModels[model];
  if (direct) return direct;
  const route = parseAgentRouteModelId(model);
  const agent = route ? _agentModels[route.agentId] : undefined;
  if (!route || !agent) return undefined;
  // Only an inheriting Agent takes its base from the route; a pinned Agent
  // keeps its own base whatever route id names it.
  if (!isAgentDefaultBaseModel(agent.baseModel)) return agent;
  const available = isBaseModelSelectableForAgent(route.baseModel);
  return {
    ...agent,
    baseModel: route.baseModel,
    available,
    ...(available
      ? {}
      : { unavailableReason: 'base_model_unavailable' as const }),
  };
}

/** Mutable runtime list of all known model IDs. */
export const ALL_MODELS: string[] = [];

/** Runtime map of model ID → display label. */
const _displayNames: Record<string, string> = createModelRegistryMap();

/** Runtime map of model ID → configured human-readable description. */
const _modelDescriptions: Record<string, string> = createModelRegistryMap();

/** Runtime map of model IDs placed in the nested family More menu. */
const _showMoreOnly: Record<string, true> = createModelRegistryMap();

/** Runtime map of model ID → configured context window. */
const _contextWindows: Record<string, number> = createModelRegistryMap();

/**
 * Runtime map of Codex model ID → listed context window. Codex reports its
 * effective window at runtime (95% of the listed one) and the usage meter
 * follows that report, so these only describe the model in pickers.
 */
const _listedContextWindows: Record<string, number> = createModelRegistryMap();

/** Runtime map of model ID → billing metadata shown in model pickers. */
const _billingMetadata: Record<string, ConfiguredModelBillingMetadata> =
  createModelRegistryMap();

/** Runtime map of model ID → configured supported thinking efforts. */
const _supportedThinkingLevels: Record<string, ThinkingLevel[]> =
  createModelRegistryMap();

/** Runtime map of model ID → LaunchDarkly flag gating the model. */
const _modelFeatureFlags: Record<string, ClientFeatureFlagKey> =
  createModelRegistryMap();

/** Runtime gateway routes, keyed by canonical package model id. */
const _gatewayModelEntries: Record<string, GatewayModelEntry> =
  createModelRegistryMap();

const _configuredGatewayIds: Record<string, string> = createModelRegistryMap();

export function getConfiguredGatewayId(model: string): string | undefined {
  return _configuredGatewayIds[resolveModelAlias(model)];
}

/** Runtime metadata for API-only gateway rows, keyed by canonical id. */
const _aiGatewayModels: Record<string, AiGatewayModelEntry> =
  createModelRegistryMap();

/**
 * Gateway-only models removed by a live catalog refresh. Keep a process-local
 * tombstone so a restored session cannot silently fall through to native
 * provider auth after its only valid route disappears.
 */
const _removedGatewayOnlyModelHarnesses: Record<string, AiGatewayHarness> =
  createModelRegistryMap();

/**
 * Runtime map of configured or legacy alias → canonical model ID.
 * Populated by {@link initModelAliases}. Example: "sonnet[1m]" → "sonnet".
 */
const _modelAliases: Record<string, string> = createModelRegistryMap();

/**
 * Resolve a model alias to its canonical model ID.
 * Returns the input unchanged if it is not a known alias.
 */
export function resolveModelAlias(model: string): string {
  return _modelAliases[model] ?? model;
}

/** Resolve aliases and return the canonical model ID only when it is registered. */
export function resolveKnownModel(model: string): ChatModel | undefined {
  const resolved = resolveModelAlias(model);
  const route = parseAgentRouteModelId(resolved);
  if (route) return _agentModels[route.agentId] ? resolved : undefined;
  return isCursorModel(resolved) ||
    isCopilotModel(resolved) ||
    isOpenCodeModel(resolved) ||
    ALL_MODELS.includes(resolved)
    ? resolved
    : undefined;
}

/** Return a shallow copy of the current alias map (for env-var propagation). */
export function getModelAliases(): Record<string, string> {
  return { ..._modelAliases };
}

/**
 * Resolve a normalized gateway route by canonical model id or a configured
 * alias.
 *
 */
export function getGatewayModelEntry(
  model: string,
): GatewayModelEntry | undefined {
  const direct = _gatewayModelEntries[model];
  const entry = direct ?? _gatewayModelEntries[resolveModelAlias(model)];
  return entry
    ? {
        ...entry,
        supportedThinkingLevels: [...entry.supportedThinkingLevels],
      }
    : undefined;
}

/**
 * True once the gateway route registry has been populated at all.
 *
 * Exists so callers can tell "this model has no gateway route" apart from "the
 * catalog has not loaded yet" — the registry starts EMPTY and is filled from
 * the model configuration broadcast, so `isGatewayRoutableModel` answers
 * `false` for every model during that window. Any UI that would take something
 * away from the user (hiding a purchase path, refusing a selection) on a
 * negative routability answer must gate on this first and fail open.
 */
export function hasGatewayModelRoutes(): boolean {
  return Object.keys(_gatewayModelEntries).length > 0;
}

/** Set by {@link initAiGatewayModels} when it receives a non-empty catalog. */
let _gatewayCatalogHydrated = false;

/**
 * True once the gateway catalog broadcast has been received at all.
 *
 * DISTINCT from {@link hasGatewayModelRoutes}, and the distinction decides
 * whether an org policy can fail closed. That helper answers "are there routes
 * RIGHT NOW", which is `false` in two completely different situations:
 *
 *  1. the catalog has not arrived yet (genuinely unknown — fail open), and
 *  2. the catalog arrived and an enforcing org policy filtered EVERY gateway
 *     route away (`applySnapshot` re-runs `initAiGatewayModels` with the
 *     policy-filtered lists, which can legitimately be empty).
 *
 * Case 2 is a SETTLED state, but a route-count gate reports it as "still
 * loading" forever — so a gateway-only candidate stays provisionally allowed
 * and a credits-only member of an enforcing org can be seeded onto a model the
 * org disallows, only failing at the main-process enforcement guard on send.
 *
 * This flag is sticky and keyed on the INPUT rather than the surviving routes,
 * so the unfiltered first call in `applySnapshot` records hydration and the
 * policy-filtered second call cannot un-record it. Gate POLICY and ROUTABILITY
 * decisions on this; keep using `hasGatewayModelRoutes()` only where the
 * question really is "does any route exist".
 *
 * An empty payload teaches nothing (preload swallows a failed read and the
 * renderer treats `[]` as present), so it leaves this false — matching
 * {@link hasHydratedModelRegistry}.
 */
export function hasHydratedGatewayCatalog(): boolean {
  return _gatewayCatalogHydrated;
}

/**
 * Restore the cold-catalog state.
 *
 * Stickiness is correct in production but makes suites order-dependent:
 * `initAiGatewayModels([], [])` is widely used as a "reset the catalog"
 * teardown, and it deliberately no longer clears hydration, so a cold-path test
 * declared after any hydrating test would silently exercise the hydrated branch.
 */
export function resetGatewayCatalogHydrationForTests(): void {
  _gatewayCatalogHydrated = false;
}

/** Set by {@link initClaudeModels} / {@link initCodexModels}. */
let _modelRegistryHydrated = false;

/**
 * True once a model registry has been initialized with at least one entry.
 *
 * DISTINCT from {@link hasGatewayModelRoutes}, and the distinction is
 * load-bearing. That helper answers "are there routes", which is `false` both
 * before the catalog loads AND for a legitimately loaded catalog whose gateway
 * routes were all filtered away — reachable when an org model policy blocks
 * every gateway-routable entry while leaving an allowed native-only model.
 * A "still loading" affordance keyed on the route count would wait forever in
 * that second case, for a route that can never arrive.
 *
 * So: gate LOADING states on this, and gate ROUTABILITY on
 * `isGatewayRoutableModel` / `hasGatewayModelRoutes`.
 *
 * An EMPTY init does not count. Preload wraps its model-config read in a bare
 * `catch {}` and the renderer treats `[]` as present, so `initClaudeModels([])`
 * is reachable on a failed read — and calling that "hydrated" would assert a
 * confident "no routes exist" built on nothing, sending a genuinely
 * credits-routable model down the native-only branch. An empty payload taught
 * us nothing, so it leaves this false and callers keep waiting.
 */
export function hasHydratedModelRegistry(): boolean {
  return _modelRegistryHydrated;
}

/** Return a defensive, serializable snapshot of every current gateway route. */
export function getGatewayModelEntries(): GatewayModelEntry[] {
  return Object.values(_gatewayModelEntries).map((entry) => ({
    ...entry,
    supportedThinkingLevels: [...entry.supportedThinkingLevels],
  }));
}

/** Return a defensive snapshot of every API-only gateway catalog row. */
export function getAiGatewayModelEntries(): AiGatewayModelEntry[] {
  return AI_GATEWAY_MODELS.flatMap((id) => {
    const entry = _aiGatewayModels[id];
    return entry
      ? [
          {
            ...entry,
            supportedThinkingLevels: [...entry.supportedThinkingLevels],
          },
        ]
      : [];
  });
}

/** Read one API-owned gateway row without inferring metadata from its ID. */
export function getAiGatewayModelEntry(
  model: string,
): AiGatewayModelEntry | undefined {
  const entry = _aiGatewayModels[model];
  return entry
    ? {
        ...entry,
        supportedThinkingLevels: [...entry.supportedThinkingLevels],
      }
    : undefined;
}

/** Return the prior harness for a gateway-only model removed during this run. */
export function getRemovedGatewayOnlyModelHarness(
  model: string,
): AiGatewayHarness | undefined {
  return (
    _removedGatewayOnlyModelHarnesses[model] ??
    _removedGatewayOnlyModelHarnesses[resolveModelAlias(model)]
  );
}

/**
 * Populate the model alias map from package.json's claude-code.modelAliases
 * and codex.modelAliases.
 * Must be called once at startup in each process (main, preload/renderer).
 */
export function initModelAliases(aliases: Record<string, string>): void {
  for (const k of Object.keys(_modelAliases)) {
    delete _modelAliases[k];
  }
  for (const [alias, canonical] of Object.entries(aliases)) {
    _modelAliases[alias] = canonical;
  }
}

/**
 * Discovered Cursor rows by label, computed once per catalog change. A distinct
 * vendor label shows as-is. Cursor's variant picker otherwise labels options
 * with the raw ID or its bare slug, so those rows use the native or API catalog
 * label, Cursor's catalog name, or the parameter-free slug, and any that share
 * a shown name gain their parameters (same model) or slug (different model).
 */
function getCursorEntryLabels(): ReadonlyMap<string, string> {
  if (_cursorLabels) return _cursorLabels;
  const rows = _cursorEntries.map((entry) => {
    const { base, qualifier } = cursorModelLabelParts(entry.rawModelId);
    const native = findCursorNativeEntry(entry.id)?.label;
    if (native && getCanonicalCursorModel(entry.id) !== entry.id)
      return { id: entry.id, name: native, base, qualifier, derived: false };
    if (entry.label && entry.label !== entry.rawModelId && entry.label !== base)
      return {
        id: entry.id,
        name: entry.label,
        base,
        qualifier,
        derived: false,
      };
    return {
      id: entry.id,
      name: native ?? entry.catalogName ?? base,
      base,
      qualifier,
      derived: true,
    };
  });
  const byName = new Map<string, typeof rows>();
  for (const row of rows)
    byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
  const labels = new Map<string, string>();
  for (const row of rows) {
    const others = row.derived
      ? (byName.get(row.name) ?? []).filter((other) => other !== row)
      : [];
    const detail = [
      ...(others.some((other) => other.base !== row.base) ? [row.base] : []),
      ...(row.qualifier && others.some((other) => other.base === row.base)
        ? [row.qualifier]
        : []),
    ];
    labels.set(
      row.id,
      detail.length > 0 ? `${row.name} (${detail.join(', ')})` : row.name,
    );
  }
  _cursorLabels = labels;
  return labels;
}

/** Return the human-readable label for a model, using a display-only ID fallback. */
export function getModelDisplayName(model: string): string {
  if (isOpenCodeModel(model))
    return (
      opencodeEntries.find((entry) => entry.id === model)?.label ??
      getRawOpenCodeModelId(model) ??
      model
    );
  if (isCopilotModel(model))
    return (
      copilotEntries.find((entry) => entry.id === model)?.label ??
      getRawCopilotModelId(model) ??
      model
    );
  if (isCursorModel(model)) {
    const canonical = getCanonicalCursorModel(model);
    if (canonical !== model)
      return (
        findCursorNativeEntry(model)?.label ?? getModelDisplayName(canonical)
      );
    const discovered = getCursorEntryLabels().get(model);
    if (discovered !== undefined) return discovered;
    if (model === 'cursor-default') return 'Cursor default';
    // A persisted selection before discovery has only its raw ID.
    const raw = getRawCursorModelId(model);
    if (!raw) return model;
    return (
      findCursorNativeEntry(model)?.label ?? cursorModelLabelParts(raw).base
    );
  }
  const agent = lookupAgentModelEntry(model);
  if (agent) {
    return agent.name;
  }
  const resolved = resolveModelAlias(model);
  return (
    _displayNames[resolved] ??
    (isOllamaModel(resolved) ? stripOllamaModelPrefix(resolved) : resolved)
  );
}

/** Return the configured human-readable description for a model, if present. */
export function getModelDescription(model: string): string | undefined {
  const agent = lookupAgentModelEntry(model);
  if (agent) {
    return agent.available ? getModelDescription(agent.baseModel) : undefined;
  }
  return _modelDescriptions[resolveModelAlias(model)];
}

/** Whether the picker should place a model in its family's nested More menu. */
export function getModelShowMoreOnly(model: string): boolean {
  if (lookupAgentModelEntry(model)) return false;
  return _showMoreOnly[resolveModelAlias(model)] === true;
}

/**
 * Return the vendor family for a model, if the AI Gateway catalog declares one.
 * Native models with no gateway route have no family.
 */
export function getModelFamily(
  model: string,
): AiGatewayModelFamily | undefined {
  const agent = lookupAgentModelEntry(model);
  if (agent) {
    return agent.available ? getModelFamily(agent.baseModel) : undefined;
  }
  // Read straight off the gateway entry rather than a parallel map, so the
  // family cannot drift from the entry it belongs to.
  return _gatewayModelEntries[resolveModelAlias(model)]?.family;
}

/** Return the configured context window for a model, if package metadata declares one. */
export function getModelContextWindow(model: string): number | undefined {
  if (isOpenCodeModel(model))
    return opencodeEntries.find((entry) => entry.id === model)?.contextWindow;
  if (isCopilotModel(model))
    return copilotEntries.find((entry) => entry.id === model)?.contextWindow;
  const agent = lookupAgentModelEntry(model);
  if (agent) {
    // Agent models inherit the base model's context window while available.
    return agent.available ? getModelContextWindow(agent.baseModel) : undefined;
  }

  if (typeof _contextWindows[model] === 'number') {
    return _contextWindows[model];
  }

  const resolved = resolveModelAlias(model);
  return _contextWindows[resolved];
}

/**
 * Return the context window a picker shows for the model: the configured one,
 * or for a Codex model the listed one, which the usage meter never reads.
 */
export function getListedModelContextWindow(model: string): number | undefined {
  const agent = lookupAgentModelEntry(model);
  if (agent) {
    return agent.available
      ? getListedModelContextWindow(agent.baseModel)
      : undefined;
  }
  return (
    getModelContextWindow(model) ??
    _listedContextWindows[model] ??
    _listedContextWindows[resolveModelAlias(model)]
  );
}

/**
 * Return the context window for the route that will execute the model. Native
 * sessions use package metadata; AI-Credits sessions use gateway metadata.
 */
export function getEffectiveModelContextWindow(
  model: string,
  aiCreditsRouted: boolean,
): number | undefined {
  const agent = lookupAgentModelEntry(model);
  if (agent) {
    return agent.available
      ? getEffectiveModelContextWindow(agent.baseModel, aiCreditsRouted)
      : undefined;
  }

  const resolved = resolveModelAlias(model);
  if (aiCreditsRouted) {
    const gatewayContextWindow = _gatewayModelEntries[resolved]?.contextWindow;
    if (typeof gatewayContextWindow === 'number') {
      return gatewayContextWindow;
    }
  }

  return _contextWindows[resolved];
}

/** Return billing metadata for a model when it should be surfaced in UI. */
export function getModelBillingMetadata(
  model: string,
): ConfiguredModelBillingMetadata | undefined {
  const agent = lookupAgentModelEntry(model);
  if (agent) {
    // Agent models inherit the base model's billing metadata while available.
    return agent.available
      ? getModelBillingMetadata(agent.baseModel)
      : undefined;
  }

  const resolved = resolveModelAlias(model);
  const metadata = _billingMetadata[resolved];
  if (!metadata?.extraChargeOnly) {
    return undefined;
  }
  return { ...metadata };
}

/**
 * The desktop's native canonical defaults retain the supported Low tier in
 * THINKING_LEVELS order. Model-aware controls use these capabilities; legacy
 * provider-only UI helpers keep their separate Low-to-Medium alias.
 */
function withCanonicalLow(
  levels: readonly ThinkingLevel[],
): readonly ThinkingLevel[] {
  return THINKING_LEVELS.filter(
    (level) => level === 'low' || levels.includes(level),
  );
}

/**
 * Provider-default supported thinking efforts for models without an explicit
 * package.json `supportedThinkingLevels` configuration. Codex omits
 * `max`/`ultra` and Claude omits `ultra`
 * so unconfigured models keep the historical Codex `max → xhigh` fallback.
 *
 * DERIVED from the protocol's `providerFallbackThinkingLevels` (CAN-2540) so
 * this table and the web/portal provider-cycle fallback cannot drift apart;
 * `packages/desktop-shared/src/__tests__/thinking.test.ts` pins the
 * equivalence.
 */
const DEFAULT_SUPPORTED_THINKING_LEVELS: Record<
  AgentProviderType,
  readonly ThinkingLevel[]
> = {
  claude: withCanonicalLow(providerFallbackThinkingLevels('claude')),
  codex: withCanonicalLow(providerFallbackThinkingLevels('codex')),
  ollama: withCanonicalLow(providerFallbackThinkingLevels('ollama')),
  cursor: [],
  copilot: [],
  opencode: [],
};

/**
 * Return the configured `supportedThinkingLevels` for a model id, if package
 * metadata declares one. Used by registry snapshot builders; most callers
 * want {@link getSupportedThinkingLevelsForModel} instead.
 */
export function getConfiguredSupportedThinkingLevels(
  model: string,
): ThinkingLevel[] | undefined {
  const resolved = resolveModelAlias(model);
  const configured = _supportedThinkingLevels[resolved];
  return configured === undefined ? undefined : [...configured];
}

/**
 * Return a copy of every configured model → supported-thinking-levels entry.
 * Used to propagate per-model thinking support into pipeline action
 * subprocesses via env (mirroring the model-ID/alias env propagation).
 */
export function getConfiguredSupportedThinkingLevelsMap(): Record<
  string,
  ThinkingLevel[]
> {
  const map: Record<string, ThinkingLevel[]> = createModelRegistryMap();
  for (const [id, levels] of Object.entries(_supportedThinkingLevels)) {
    map[id] = [...levels];
  }
  return map;
}

/**
 * Return the supported thinking efforts for the route that will execute the
 * model. Native sessions use package metadata; AI-Credits sessions prefer the
 * live gateway metadata attached to the same registry entry.
 */
export function getEffectiveSupportedThinkingLevelsForModel(
  model: string | undefined,
  aiCreditsRouted: boolean,
  providerFallback?: AgentProviderType,
  executionHarness?: ModelHarness,
): readonly ThinkingLevel[] {
  if (model) {
    const agent = lookupAgentModelEntry(model);
    if (agent) {
      return agent.available
        ? getEffectiveSupportedThinkingLevelsForModel(
            agent.baseModel,
            aiCreditsRouted,
            providerFallback,
            executionHarness,
          )
        : DEFAULT_SUPPORTED_THINKING_LEVELS[providerFallback ?? 'claude'];
    }
    const resolved = resolveModelAlias(model);
    // Cursor executes the advertised variant, never the native route, so a
    // Cursor identity (or a native model drafted on the Cursor harness) takes
    // the variant's discovered support ahead of package metadata.
    if (isCursorModel(resolved))
      return getCursorSupportedThinkingLevels(resolved);
    if (isOpenCodeModel(resolved))
      return (
        opencodeEntries.find((entry) => entry.id === resolved)
          ?.supportedThinkingLevels ?? []
      );
    if (executionHarness === 'opencode') return [];
    if (isCopilotModel(resolved))
      return (
        copilotEntries.find((entry) => entry.id === resolved)
          ?.supportedThinkingLevels ?? []
      );
    if (executionHarness === 'copilot') return [];
    if (executionHarness === 'cursor') {
      const variant = getCursorModelMappings()[resolved];
      return variant
        ? getCursorSupportedThinkingLevels(variant)
        : DEFAULT_SUPPORTED_THINKING_LEVELS.cursor;
    }
    if (aiCreditsRouted) {
      const gatewayLevels =
        _gatewayModelEntries[resolved]?.supportedThinkingLevels;
      if (gatewayLevels !== undefined) {
        return gatewayLevels;
      }
    }
    const configured = _supportedThinkingLevels[resolved];
    if (configured !== undefined) {
      return configured;
    }
    // Prefer an explicit provider hint for unregistered models. Provider
    // detection intentionally returns undefined when no registry owns the id.
    const provider =
      executionHarness ??
      (ALL_MODELS.includes(resolved)
        ? (getExecutionHarnessForModel(resolved) ??
          getProviderForModel(resolved))
        : (providerFallback ?? getProviderForModel(resolved)));
    // Thinking-level normalization intentionally retains its documented
    // Claude default when neither the registry nor the caller identifies a
    // provider. Runtime dispatch must use `requireProviderForModel` instead.
    return DEFAULT_SUPPORTED_THINKING_LEVELS[provider ?? 'claude'];
  }
  return DEFAULT_SUPPORTED_THINKING_LEVELS[providerFallback ?? 'claude'];
}

/**
 * Clamp a thinking level to the nearest supported level at or below it for a
 * model. This generalizes the historical Codex default `max → xhigh` fallback: any
 * unsupported level falls to the highest supported level below it (e.g.
 * `ultra → max` on Claude Haiku, `ultra → xhigh` on Codex models without an
 * Ultra tier, `max → xhigh` on Codex models that do not declare Max).
 * When no supported level is at or below the request, use the weakest
 * supported tier (e.g. `off → low` on a model that requires thinking).
 */
export function clampThinkingLevelForModel(
  level: ThinkingLevel,
  model: string | undefined,
  providerFallback?: AgentProviderType,
  aiCreditsRouted = false,
  supportedThinkingLevels?: readonly ThinkingLevel[],
): ThinkingLevel {
  const supported =
    supportedThinkingLevels ??
    getEffectiveSupportedThinkingLevelsForModel(
      model,
      aiCreditsRouted,
      providerFallback,
    );
  return clampModelThinkingLevel(level, supported);
}

/** Rebuild ALL_MODELS from all registries. */
function rebuildAllModels(): void {
  ALL_MODELS.length = 0;
  ALL_MODELS.push(
    ...CLAUDE_MODELS,
    ...CODEX_MODELS,
    ...CODEX_ACCOUNT_MODELS,
    ...AI_GATEWAY_MODELS,
    ...OLLAMA_MODELS,
    ...AGENT_MODELS,
  );
}

function syncBillingMetadata(entry: ConfiguredModelEntry): void {
  if (entry.extraChargeOnly) {
    _billingMetadata[entry.id] = {
      extraChargeOnly: true,
      ...(typeof entry.extraChargeMessage === 'string'
        ? { extraChargeMessage: entry.extraChargeMessage }
        : {}),
    };
    return;
  }

  delete _billingMetadata[entry.id];
}

function syncShowMoreOnly(entry: ConfiguredModelEntry): void {
  if (entry.showMoreOnly === true) {
    _showMoreOnly[entry.id] = true;
    return;
  }
  delete _showMoreOnly[entry.id];
}

function syncSupportedThinkingLevels(entry: ConfiguredModelEntry): void {
  if (!Array.isArray(entry.supportedThinkingLevels)) {
    delete _supportedThinkingLevels[entry.id];
    return;
  }
  _supportedThinkingLevels[entry.id] =
    entry.supportedThinkingLevels.filter(isThinkingLevel);
}

function syncModelFeatureFlag(entry: ConfiguredModelEntry): void {
  if (entry.featureFlag) {
    _modelFeatureFlags[entry.id] = entry.featureFlag;
    return;
  }

  delete _modelFeatureFlags[entry.id];
}

function isConfiguredModelEntryEnabled(
  entry: ConfiguredModelEntry,
  featureFlags?: Partial<ClientFeatureFlagValues>,
): boolean {
  return !entry.featureFlag || featureFlags?.[entry.featureFlag] === true;
}

/**
 * Return the LaunchDarkly flag that gates a model when this process initialized
 * model registries from raw package metadata. Snapshot consumers may strip this
 * marker before init, so `undefined` does not prove the model is ungated.
 */
export function getModelFeatureFlag(
  model: string,
): ClientFeatureFlagKey | undefined {
  const resolved = resolveModelAlias(model);
  return _modelFeatureFlags[resolved];
}

/**
 * Populate the claude model registry from package.json entries.
 * Must be called once at startup in each process (main, preload/renderer).
 * Policy-only filtering preserves the full catalog identity metadata.
 */
export function initClaudeModels(
  entries: ClaudeModelEntry[],
  featureFlags?: Partial<ClientFeatureFlagValues>,
  preserveCursorIdentity = false,
): void {
  _cursorMappings = undefined;
  _managedPickerMappings.clear();
  _cursorLabels = undefined;
  if (!preserveCursorIdentity)
    _pickerNativeCatalog.claude = entries
      .filter((entry) => isConfiguredModelEntryEnabled(entry, featureFlags))
      .map((entry) => ({ ...entry }));
  if (entries.length > 0) _modelRegistryHydrated = true;
  releaseCodexAccountModels(new Set(entries.map((entry) => entry.id)));
  for (const id of CLAUDE_MODELS) delete _configuredGatewayIds[id];
  // Remove stale claude display names (keep codex ones)
  const codexSet = new Set([
    ...CODEX_MODELS,
    ...CODEX_ACCOUNT_MODELS,
    ...AI_GATEWAY_MODELS,
  ]);
  for (const k of Object.keys(_displayNames)) {
    if (!codexSet.has(k)) {
      delete _displayNames[k];
    }
  }
  for (const k of Object.keys(_billingMetadata)) {
    if (!codexSet.has(k)) {
      delete _billingMetadata[k];
    }
  }
  for (const k of Object.keys(_modelFeatureFlags)) {
    if (!codexSet.has(k)) {
      delete _modelFeatureFlags[k];
    }
  }
  for (const k of Object.keys(_supportedThinkingLevels)) {
    if (!codexSet.has(k)) {
      delete _supportedThinkingLevels[k];
    }
  }
  for (const k of Object.keys(_modelDescriptions)) {
    if (!codexSet.has(k)) {
      delete _modelDescriptions[k];
    }
  }
  for (const k of Object.keys(_showMoreOnly)) {
    if (!codexSet.has(k)) delete _showMoreOnly[k];
  }

  for (const id of CLAUDE_MODELS) delete _contextWindows[id];
  CLAUDE_MODELS.length = 0;
  for (const entry of entries) {
    if (!isConfiguredModelEntryEnabled(entry, featureFlags)) {
      continue;
    }
    if (entry.gatewayId) _configuredGatewayIds[entry.id] = entry.gatewayId;
    if (entry.selectable === false) {
      continue;
    }
    CLAUDE_MODELS.push(entry.id);
    _displayNames[entry.id] = entry.label;
    if (typeof entry.description === 'string' && entry.description.length > 0) {
      _modelDescriptions[entry.id] = entry.description;
    } else {
      delete _modelDescriptions[entry.id];
    }
    if (typeof entry.contextWindow === 'number' && entry.contextWindow > 0) {
      _contextWindows[entry.id] = entry.contextWindow;
    }
    syncBillingMetadata(entry);
    syncShowMoreOnly(entry);
    syncModelFeatureFlag(entry);
    syncSupportedThinkingLevels(entry);
  }
  rebuildAllModels();
}

/**
 * A trailing context-window token on an incoming display label — the “1M” in
 * the Claude Code TUI's “Set model to Opus 5 1M”. Anchored and shape-specific
 * (digits, optional decimal, a single K/M unit) so it can only ever remove a
 * size token, never a real name part such as the “Turbo” in a hypothetical
 * “Opus 5 Turbo”.
 */
const CONTEXT_WINDOW_LABEL_SUFFIX = /\s+\d+(?:\.\d+)?[km]$/i;

/**
 * Resolve a configured Claude model id from the display label the Claude
 * Code TUI prints (e.g. `/model` stdout “Set model to Sonnet 5…”).
 * Accepts exact model ids too. Returns undefined when nothing matches so
 * callers never write an unconfigured model into tab state.
 *
 * CAN-2701: Canopy's own labels carry the model's identity and nothing else
 * (“Opus 5”), while the TUI still prints the context-window variant
 * (“Opus 5 1M”). The suffix is therefore tolerated on the INCOMING label only,
 * and only after an exact match has already failed — so a future registry that
 * genuinely ships two size variants keeps resolving each to itself.
 */
export function findClaudeModelByLabel(label: string): string | undefined {
  const trimmed = label.trim();
  if (!trimmed) return undefined;
  const resolved = resolveKnownModel(trimmed);
  if (resolved && CLAUDE_MODELS.includes(resolved)) return resolved;
  const normalized = trimmed.toLowerCase();
  const withoutContextWindow = normalized
    .replace(CONTEXT_WINDOW_LABEL_SUFFIX, '')
    .trim();
  for (const id of CLAUDE_MODELS) {
    if (id.toLowerCase() === normalized) return id;
    const display = _displayNames[id]?.toLowerCase();
    if (display && display === normalized) return id;
  }
  if (!withoutContextWindow || withoutContextWindow === normalized) {
    return undefined;
  }
  for (const id of CLAUDE_MODELS) {
    if (_displayNames[id]?.toLowerCase() === withoutContextWindow) return id;
  }
  return undefined;
}

/**
 * Populate the codex model registry from package.json entries.
 * Must be called once at startup in each process (main, preload/renderer).
 * Policy-only filtering preserves the full catalog identity metadata.
 */
export function initCodexModels(
  entries: CodexModelEntry[],
  featureFlags?: Partial<ClientFeatureFlagValues>,
  preserveCursorIdentity = false,
): void {
  _cursorMappings = undefined;
  _managedPickerMappings.clear();
  _cursorLabels = undefined;
  if (!preserveCursorIdentity) {
    _pickerNativeCatalog.codex = entries
      .filter((entry) => isConfiguredModelEntryEnabled(entry, featureFlags))
      .map((entry) => ({ ...entry }));
    _configuredCodexCatalogIds.clear();
    for (const entry of entries) _configuredCodexCatalogIds.add(entry.id);
  }
  releaseCodexAccountModels(_configuredCodexCatalogIds);
  if (entries.length > 0) _modelRegistryHydrated = true;
  for (const id of CODEX_MODELS) delete _configuredGatewayIds[id];
  for (const id of Object.keys(_listedContextWindows)) {
    delete _listedContextWindows[id];
  }
  // Remove stale codex display names (keep claude ones, and the account-only
  // Codex overlay, which `setCodexAccountModels` owns)
  const claudeSet = new Set([
    ...CLAUDE_MODELS,
    ...CODEX_ACCOUNT_MODELS,
    ...AI_GATEWAY_MODELS,
  ]);
  for (const k of Object.keys(_displayNames)) {
    if (!claudeSet.has(k)) {
      delete _displayNames[k];
    }
  }
  for (const k of Object.keys(_billingMetadata)) {
    if (!claudeSet.has(k)) {
      delete _billingMetadata[k];
    }
  }
  for (const k of Object.keys(_modelFeatureFlags)) {
    if (!claudeSet.has(k)) {
      delete _modelFeatureFlags[k];
    }
  }
  for (const k of Object.keys(_supportedThinkingLevels)) {
    if (!claudeSet.has(k)) {
      delete _supportedThinkingLevels[k];
    }
  }
  for (const k of Object.keys(_modelDescriptions)) {
    if (!claudeSet.has(k)) {
      delete _modelDescriptions[k];
    }
  }
  for (const k of Object.keys(_showMoreOnly)) {
    if (!claudeSet.has(k)) delete _showMoreOnly[k];
  }

  CODEX_MODELS.length = 0;
  for (const entry of entries) {
    if (!isConfiguredModelEntryEnabled(entry, featureFlags)) {
      continue;
    }
    if (entry.gatewayId) _configuredGatewayIds[entry.id] = entry.gatewayId;
    if (entry.selectable === false) {
      continue;
    }
    CODEX_MODELS.push(entry.id);
    _displayNames[entry.id] = entry.label;
    if (typeof entry.description === 'string' && entry.description.length > 0) {
      _modelDescriptions[entry.id] = entry.description;
    } else {
      delete _modelDescriptions[entry.id];
    }
    if (typeof entry.contextWindow === 'number' && entry.contextWindow > 0) {
      _listedContextWindows[entry.id] = entry.contextWindow;
    }
    syncBillingMetadata(entry);
    syncShowMoreOnly(entry);
    syncModelFeatureFlag(entry);
    syncSupportedThinkingLevels(entry);
  }
  rebuildAllModels();
}

/**
 * Atomically replace API-only rows and all current gateway routes. Native
 * registry initialization deliberately does not mutate this route table.
 */
export function initAiGatewayModels(
  entries: AiGatewayModelEntry[],
  routes: GatewayRouteEntry[],
  preserveCursorIdentity = false,
): void {
  _cursorMappings = undefined;
  _managedPickerMappings.clear();
  _cursorLabels = undefined;
  if (!preserveCursorIdentity) {
    _pickerNativeCatalog.gateway = entries
      .filter(
        (entry) =>
          !routes.some(
            (route) =>
              route.modelId === entry.id && route.origin === 'org-gateway',
          ),
      )
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        cursorModelId: entry.cursorModelId,
        gatewayId: routes.find((route) => route.modelId === entry.id)
          ?.gatewayId,
      }));
  }
  // Keyed on the INPUT, not on the routes that survive: `applySnapshot` calls
  // this twice, first with the raw catalog and then with the policy-filtered
  // one, and the filtered call can legitimately carry zero routes. Recording
  // hydration from the input means that settled-but-empty state is
  // distinguishable from a catalog that never arrived. Sticky by design.
  if (entries.length > 0 || routes.length > 0) _gatewayCatalogHydrated = true;
  const nextIds = new Set(entries.map((entry) => entry.id));
  releaseCodexAccountModels(nextIds);
  for (const id of AI_GATEWAY_MODELS) {
    if (nextIds.has(id)) continue;
    delete _displayNames[id];
    delete _contextWindows[id];
    delete _billingMetadata[id];
    delete _showMoreOnly[id];
    delete _supportedThinkingLevels[id];
    delete _aiGatewayModels[id];
  }

  const nextRouteIds = new Set(routes.map((route) => route.modelId));
  for (const [id, route] of Object.entries(_gatewayModelEntries)) {
    if (!nextRouteIds.has(id) && route.gatewayOnly) {
      _removedGatewayOnlyModelHarnesses[id] = route.recommendedHarness;
    }
  }
  for (const id of Object.keys(_gatewayModelEntries)) {
    delete _gatewayModelEntries[id];
  }
  for (const route of routes) {
    _gatewayModelEntries[route.modelId] = {
      ...route,
      supportedThinkingLevels: [...route.supportedThinkingLevels],
    };
    delete _removedGatewayOnlyModelHarnesses[route.modelId];
  }

  AI_GATEWAY_MODELS.length = 0;
  for (const entry of entries) {
    AI_GATEWAY_MODELS.push(entry.id);
    _aiGatewayModels[entry.id] = {
      ...entry,
      supportedThinkingLevels: [...entry.supportedThinkingLevels],
    };
    _displayNames[entry.id] = entry.label;
    _contextWindows[entry.id] = entry.contextWindow;
    syncBillingMetadata(entry);
    syncShowMoreOnly(entry);
    syncSupportedThinkingLevels(entry);
  }
  rebuildAllModels();
}

/**
 * Populate the ollama model registry from discovered entries.
 * Must be called once at startup in each process (main, preload/renderer).
 */
export function initOllamaModels(entries: OllamaModelEntry[]): void {
  // Remove stale ollama display names (keep claude + codex ones)
  const keepSet = new Set([
    ...CLAUDE_MODELS,
    ...CODEX_MODELS,
    ...CODEX_ACCOUNT_MODELS,
    ...AI_GATEWAY_MODELS,
  ]);
  for (const k of Object.keys(_displayNames)) {
    if (!keepSet.has(k)) {
      delete _displayNames[k];
    }
  }
  for (const k of Object.keys(_billingMetadata)) {
    if (!keepSet.has(k)) {
      delete _billingMetadata[k];
    }
  }
  for (const k of Object.keys(_showMoreOnly)) {
    if (!keepSet.has(k)) delete _showMoreOnly[k];
  }
  for (const k of Object.keys(_modelFeatureFlags)) {
    if (!keepSet.has(k)) {
      delete _modelFeatureFlags[k];
    }
  }

  OLLAMA_MODELS.length = 0;
  for (const entry of entries) {
    _displayNames[entry.id] = entry.label;
    if (isSupportedOllamaModelEntry(entry)) {
      OLLAMA_MODELS.push(entry.id);
    }
  }
  rebuildAllModels();
}

/** Test whether a model ID is an Ollama model. */
export function isOllamaModel(model?: string | null): model is string {
  return typeof model === 'string' && model.startsWith(OLLAMA_MODEL_PREFIX);
}

export function hasRequiredOllamaCapabilities(
  capabilities: readonly string[] | undefined,
): boolean {
  if (!capabilities || capabilities.length === 0) {
    return false;
  }

  const capabilitySet = new Set(capabilities);
  return REQUIRED_OLLAMA_CAPABILITIES.every((capability) =>
    capabilitySet.has(capability),
  );
}

export function isSupportedOllamaModelEntry(entry: OllamaModelEntry): boolean {
  return hasRequiredOllamaCapabilities(entry.show?.capabilities);
}

/** Strip the Ollama prefix to get the raw model name. */
export function stripOllamaModelPrefix(model: string): string {
  return isOllamaModel(model) ? model.slice(OLLAMA_MODEL_PREFIX.length) : model;
}

export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'opus[1m]';
export const DEFAULT_CODEX_MODEL: string = 'gpt-6.1-sol';

export function getProviderForModel(
  model: ChatModel,
): AgentProviderType | undefined {
  const agent = lookupAgentModelEntry(model);
  if (agent) {
    if (agent.available) {
      return getProviderForModel(agent.baseModel);
    }
    return undefined;
  }
  const resolved = resolveModelAlias(model);
  if (isCursorModel(resolved)) return 'cursor';
  if (isCopilotModel(resolved)) return 'copilot';
  if (isOpenCodeModel(resolved)) return 'opencode';
  if (isOllamaModel(resolved)) return 'ollama';
  if (CLAUDE_MODELS.includes(resolved)) return 'claude';
  if (isCodexHarnessModelId(resolved)) return 'codex';
  // Gateway models execute on their assigned harness: an EXPLICIT hydrated
  // user assignment wins, everything else follows the merged catalog
  // recommendation. A hydrated but non-overridden entry is a captured
  // default, not a user decision — letting it shadow the live catalog froze
  // recommendation updates and let a model absent from the catalog resolve a
  // provider instead of failing closed.
  const assignment = resolveHydratedModelHarnessAssignment(
    resolved,
    _modelAliases,
  );
  return assignment?.overridden &&
    (assignment.harness === 'claude' ||
      assignment.harness === 'codex' ||
      assignment.harness === 'opencode')
    ? assignment.harness
    : _gatewayModelEntries[resolved]?.recommendedHarness;
}

/** Resolve a model provider or reject an unknown/stale model explicitly. */
export function requireProviderForModel(model: ChatModel): AgentProviderType {
  const provider = getProviderForModel(model);
  if (!provider) {
    throw new Error(`Unknown model provider: ${model}`);
  }
  return provider;
}

export function getCurrentModelHarnessCatalog(): ModelHarnessCatalog {
  const agentBaseModels = Object.fromEntries(
    Object.entries(_agentModels).map(([id, entry]) => [id, entry.baseModel]),
  );
  return {
    claudeModels: CLAUDE_MODELS,
    codexModels:
      CODEX_ACCOUNT_MODELS.length > 0
        ? [...CODEX_MODELS, ...CODEX_ACCOUNT_MODELS]
        : CODEX_MODELS,
    cursorModels: CURSOR_MODELS,
    copilotModels: COPILOT_MODELS,
    opencodeModels: OPENCODE_MODELS,
    cursorModelMappings: getCursorModelMappings(),
    aiGatewayModels: getAiGatewayModelEntries(),
    ollamaModels: OLLAMA_MODELS,
    modelAliases: _modelAliases,
    agentBaseModels,
  };
}

/** Source ownership for billing/auth/lifecycle, independent from execution. */
export function getModelSource(
  model: ChatModel,
): ModelHarnessSource | undefined {
  return resolveHarnessSource(model, getCurrentModelHarnessCatalog());
}

/** Effective or captured execution harness. Unknown models fail closed. */
export function getExecutionHarnessForModel(
  model: ChatModel,
  capturedHarness?: ModelHarness,
): ModelHarness | undefined {
  if (capturedHarness) return capturedHarness;
  // Managed IDs already identify a concrete runtime. Fresh chat defaults are
  // materialized by resolveDefaultChatModel; a default change cannot reroute
  // an explicit choice or a persisted native chat.
  const resolved = resolveModelAlias(model);
  if (CLAUDE_MODELS.includes(resolved)) return 'claude';
  if (isCodexHarnessModelId(resolved)) return 'codex';
  const agentBaseModels = Object.fromEntries(
    Object.entries(_agentModels).map(([id, entry]) => [id, entry.baseModel]),
  );
  const harness =
    resolveHydratedModelHarnessAssignment(model, _modelAliases, agentBaseModels)
      ?.harness ??
    resolveEffectiveModelHarness(model, getCurrentModelHarnessCatalog());
  // As with native models, a Cursor default materializes as an opaque Cursor
  // ID for a fresh chat. A canonical gateway ID remains a gateway invocation.
  return harness === 'cursor' && _aiGatewayModels[resolved]
    ? _aiGatewayModels[resolved].recommendedHarness
    : harness;
}

/** Interactive draft overrides are supported only by gateway and local models.
 * Native model identity and billing stay unchanged by these choices.
 */
export function getChatHarnessOptions(
  model: ChatModel,
): readonly ModelHarness[] {
  const agentBaseModels = Object.fromEntries(
    Object.entries(_agentModels).map(([id, entry]) => [id, entry.baseModel]),
  );
  const assignment = resolveHydratedModelHarnessAssignment(
    model,
    _modelAliases,
    agentBaseModels,
  );
  if (assignment?.chatHarnesses) return assignment.chatHarnesses;
  const source = getModelSource(model);
  return source === 'ai-gateway' || source === 'ollama'
    ? ['claude', 'codex']
    : [];
}

/** Backward-compatible capture for a legacy chat that has already started. */
export function inferLegacyExecutionHarness(input: {
  model?: ChatModel;
  providerType?: AgentProviderType;
  hasStarted: boolean;
}): ModelHarness | undefined {
  if (!input.hasStarted) return undefined;
  if (input.providerType === 'opencode') return 'opencode';
  if (input.model) {
    const source = getModelSource(input.model);
    if (source === 'ollama') return 'claude';
    if (source === 'claude-managed') return 'claude';
    if (source === 'codex-managed') return 'codex';
    if (source === 'cursor-managed') return 'cursor';
    if (source === 'copilot-managed') return 'copilot';
    if (source === 'opencode-managed') return 'opencode';
    if (source === 'ai-gateway') {
      if (input.providerType === 'claude' || input.providerType === 'codex') {
        return input.providerType;
      }
      const canonical = resolveModelAlias(input.model);
      const runtimeModel =
        lookupAgentModelEntry(canonical)?.baseModel ?? canonical;
      const resolvedRuntimeModel = resolveModelAlias(runtimeModel);
      return (
        _gatewayModelEntries[resolvedRuntimeModel]?.recommendedHarness ??
        _removedGatewayOnlyModelHarnesses[resolvedRuntimeModel] ??
        getExecutionHarnessForModel(input.model)
      );
    }
  }
  if (input.providerType === 'copilot' || input.providerType === 'cursor')
    return input.providerType;
  return input.providerType === 'codex' ? 'codex' : 'claude';
}

export function isCodexModel(model: string): boolean {
  return isCodexHarnessModelId(resolveModelAlias(model));
}

/**
 * One `model/list` entry as {@link setCodexAccountModels} reads it. The
 * sanitized `CodexSpeedCatalogModel` satisfies this shape.
 */
export interface CodexAccountModelListEntry {
  id: string;
  model: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  reasoningEfforts?: readonly string[];
}

/** Codex `reasoningEffort` ids that differ from Canopy's thinking levels. */
const CODEX_REASONING_EFFORT_LEVELS: Readonly<Record<string, ThinkingLevel>> = {
  none: 'off',
  minimal: 'low',
};

function codexAccountThinkingLevels(
  efforts: readonly string[] | undefined,
): ThinkingLevel[] | undefined {
  if (!efforts) return undefined;
  const mapped = new Set<ThinkingLevel>();
  for (const effort of efforts) {
    const level = CODEX_REASONING_EFFORT_LEVELS[effort] ?? effort;
    if (isThinkingLevel(level)) mapped.add(level);
  }
  // Canopy's own order; an effort Canopy does not know is dropped.
  const levels = THINKING_LEVELS.filter((level) => mapped.has(level));
  return levels.length > 0 ? levels : undefined;
}

/**
 * Hand overlay ids a package registry now configures back to that registry,
 * whichever hydrated first. The registry writes their metadata itself, so it
 * is not deleted here. One-directional: an id a registry later stops
 * configuring returns to the overlay only on the next account catalog push.
 */
function releaseCodexAccountModels(owned: ReadonlySet<string>): void {
  for (let i = CODEX_ACCOUNT_MODELS.length - 1; i >= 0; i--) {
    if (owned.has(CODEX_ACCOUNT_MODELS[i])) CODEX_ACCOUNT_MODELS.splice(i, 1);
  }
}

function removeCodexAccountModelMetadata(): void {
  for (const id of CODEX_ACCOUNT_MODELS) {
    delete _displayNames[id];
    delete _supportedThinkingLevels[id];
  }
  CODEX_ACCOUNT_MODELS.length = 0;
}

/**
 * Register the signed-in account's Codex models that the package catalog does
 * not list, REPLACING any earlier set (CAN-4716).
 *
 * Hidden entries, and entries whose `id` or `model` the registry already
 * knows or the package catalog configures (even flag-gated, non-selectable or
 * policy-filtered), are skipped. Order is the account's `isDefault` model first, then
 * list order, deduplicated. Each registers under its `model` slug (what the
 * Codex runtime is asked to run) as a codex-managed, Codex-harness model with
 * no gateway route, labelled with its `displayName` and offering the thinking
 * levels its reasoning efforts map to (Codex defaults when it lists none).
 */
export function setCodexAccountModels(
  entries: readonly CodexAccountModelListEntry[],
): void {
  removeCodexAccountModelMetadata();
  rebuildAllModels();
  // Claude and gateway ids a policy re-init filtered out keep their configured
  // picker identity; they are never account-only either.
  const configuredElsewhere = new Set(
    [..._pickerNativeCatalog.claude, ..._pickerNativeCatalog.gateway].map(
      (entry) => entry.id,
    ),
  );
  const ordered = [
    ...entries.filter((entry) => entry.isDefault === true),
    ...entries.filter((entry) => entry.isDefault !== true),
  ];
  for (const entry of ordered) {
    if (entry.hidden === true) continue;
    const id = entry.model || entry.id;
    if (!id || CODEX_ACCOUNT_MODELS.includes(id)) continue;
    if (
      _configuredCodexCatalogIds.has(entry.id) ||
      _configuredCodexCatalogIds.has(entry.model) ||
      configuredElsewhere.has(entry.id) ||
      configuredElsewhere.has(entry.model) ||
      resolveKnownModel(entry.id) !== undefined ||
      resolveKnownModel(entry.model) !== undefined
    ) {
      continue;
    }
    CODEX_ACCOUNT_MODELS.push(id);
    _displayNames[id] = entry.displayName ?? id;
    const levels = codexAccountThinkingLevels(entry.reasoningEfforts);
    if (levels) _supportedThinkingLevels[id] = levels;
  }
  rebuildAllModels();
}

/** Drop every account-only Codex model, as on sign-out or account change. */
export function clearCodexAccountModels(): void {
  if (CODEX_ACCOUNT_MODELS.length === 0) return;
  removeCodexAccountModelMetadata();
  rebuildAllModels();
}

// ---------------------------------------------------------------------------
// Agent models — user-defined overlays over the provider registries.
//
// An Agent model (`agent_model_*`) pairs a real provider base model with
// appended instructions and merged plugins. It appears in pickers/pipeline
// options but NEVER reaches a provider SDK: callers unwrap it to `baseModel`
// via {@link resolveRuntimeModel} first. Stale-base Agents (whose base no
// longer resolves) are retained as `available: false` so the UI can render
// them disabled and still edit/delete them.
// ---------------------------------------------------------------------------

/** True iff a model ID has the Agent model shape (`agent_model_*`). */
export function isAgentModel(model?: string | null): model is string {
  return typeof model === 'string' && model.startsWith(AGENT_MODEL_PREFIX);
}

/** Return the derived Agent registry entry for an ID, or null when unknown. */
export function resolveAgentModelDefinition(
  model: string,
): AgentModelRegistryEntry | null {
  return lookupAgentModelEntry(model) ?? null;
}

/** True for a bare Agent id that runs on its destination's default model. */
export function isInheritingAgentModel(model: string): boolean {
  const agent = _agentModels[model];
  return agent !== undefined && isAgentDefaultBaseModel(agent.baseModel);
}

/**
 * Unwrap a model ID to the real base model that a provider SDK should receive.
 * For Agent models this always returns the declared `baseModel` (even when the
 * base is stale/unknown) so callers can produce an explicit stale-base error
 * rather than passing `agent_model_*` to a provider. For non-Agent models it
 * returns the canonical known model ID, or undefined when the ID is unknown.
 */
export function resolveRuntimeModel(model: string): ChatModel | undefined {
  const agent = lookupAgentModelEntry(model);
  if (agent) {
    return agent.baseModel;
  }
  return resolveKnownModel(model);
}

/**
 * True iff a model can serve as the base for a custom Agent: it must be a
 * known provider model or a valid persisted Cursor runtime identity, and must
 * NOT itself be an Agent model. Cursor discovery is transient; saved identities
 * remain configurable before discovery, while launch validates live support.
 */
export function isBaseModelSelectableForAgent(model: string): boolean {
  if (isAgentModel(model)) {
    return false;
  }
  const resolved = resolveModelAlias(model);
  return (
    CLAUDE_MODELS.includes(resolved) ||
    CODEX_MODELS.includes(resolved) ||
    isCursorModel(resolved) ||
    isCopilotModel(resolved) ||
    isOpenCodeModel(resolved) ||
    AI_GATEWAY_MODELS.includes(resolved) ||
    OLLAMA_MODELS.includes(resolved)
  );
}

/** Report whether a registered Agent model is currently usable. */
export function getAgentModelAvailability(model: string): {
  available: boolean;
  reason?: string;
} {
  const agent = lookupAgentModelEntry(model);
  if (!agent) {
    return { available: false, reason: 'not_found' };
  }
  return agent.available
    ? { available: true }
    : { available: false, reason: agent.unavailableReason };
}

/**
 * Load the Agent model overlay into the shared registry. Clears prior Agent
 * state first, then loads each entry. Structurally invalid entries are skipped
 * (missing/mis-prefixed ID, missing base model, or a base model that is itself
 * an Agent). Entries whose base model no longer resolves to a known provider
 * model are RETAINED with `available: false` so existing selections render
 * disabled and the Agents page can still edit/delete them.
 *
 * Base provider registries must be initialized first so availability resolves
 * correctly. Re-initializing Claude/Codex/Ollama preserves this overlay (it
 * lives entirely in `_agentModels` / {@link AGENT_MODELS}); {@link rebuildAllModels}
 * re-appends {@link AGENT_MODELS} on every registry rebuild.
 */
export function initAgentModels(entries: AgentModelRegistryEntry[]): void {
  for (const id of Object.keys(_agentModels)) {
    delete _agentModels[id];
  }
  AGENT_MODELS.length = 0;

  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !entry.id.startsWith(AGENT_MODEL_PREFIX)
    ) {
      continue;
    }
    if (typeof entry.baseModel !== 'string' || entry.baseModel.length === 0) {
      continue;
    }
    // A custom Agent cannot use another Agent as its base.
    if (isAgentModel(entry.baseModel)) {
      continue;
    }

    // An inheriting Agent is usable wherever its destination has a default;
    // the concrete route is judged once a chat materializes it.
    const available =
      isAgentDefaultBaseModel(entry.baseModel) ||
      isBaseModelSelectableForAgent(entry.baseModel);
    const normalized: AgentModelRegistryEntry = {
      id: entry.id,
      name: entry.name,
      baseModel: entry.baseModel,
      instructions: entry.instructions,
      pluginSelections: entry.pluginSelections,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      available,
      ...(available
        ? {}
        : { unavailableReason: 'base_model_unavailable' as const }),
    };
    _agentModels[entry.id] = normalized;
    AGENT_MODELS.push(entry.id);
  }

  rebuildAllModels();
}
