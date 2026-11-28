import { isSyntacticallyValidModelId } from '@canopy/protocol/models';
import {
  isBillingLane,
  normalizeStringArray,
  type BillingLane,
  type CodeGraphPreferences,
  type ModelDefaultsByProvider,
  type PreferencesData,
  type ProviderModelSelection,
} from '@canopy/protocol/preferences';
import {
  normalizeAgentModelConfig,
  type AgentModelConfig,
} from '@canopy/protocol/agent-model-config';
import type { AgentProviderType } from '@canopy/protocol/agent-providers';
import type { ChatModel } from '@canopy/protocol/chat-models';
import {
  normalizePersistedThinkingLevel,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';
import {
  APPROVAL_DEFAULT_SURFACES,
  FAIL_CLOSED_APPROVAL_MODE,
  createFailClosedApprovalDefaults,
  isApprovalMode,
  type ApprovalDefaults,
  type ApprovalMode,
} from '@canopy/protocol/approval-policy';
import { DEFAULT_PREFERENCES } from './defaults';
import { isRecord, normalizeBoolean } from './field-normalizers';
import { preferencesNormalizationEnvironment } from './normalization-environment';

/** Canonical id of a model the installed facts call available, or null. */
function resolveAvailableModel(model: unknown): ChatModel | null {
  if (typeof model !== 'string') return null;
  const facts = preferencesNormalizationEnvironment();
  return facts.status(model) === 'available'
    ? (facts.resolveKnownModel(model) ?? null)
    : null;
}

export function normalizeThinkingLevel(
  value: unknown,
  fallback: ThinkingLevel = 'high',
): ThinkingLevel {
  return normalizePersistedThinkingLevel(value, fallback);
}

export function normalizeOptionalThinkingLevel(
  value: unknown,
): ThinkingLevel | null {
  if (typeof value !== 'string') return null;
  const fallback: ThinkingLevel = 'off';
  const normalized = normalizeThinkingLevel(value, fallback);
  return normalized === fallback && value !== fallback ? null : normalized;
}

export type ModelSelectionValidation = 'runtime' | 'persisted';

function normalizeProviderModel(
  value: unknown,
  provider: AgentProviderType,
  validation: ModelSelectionValidation,
): ChatModel | null {
  if (validation === 'persisted') {
    return normalizePersistableModelSelection(value);
  }
  if (typeof value !== 'string') return null;
  const facts = preferencesNormalizationEnvironment();
  const model = facts.resolveKnownModel(value);
  if (!model) return null;
  if (provider === 'ollama') {
    return facts.modelSource(model) === 'ollama' && facts.ollamaEnabled()
      ? model
      : null;
  }
  if (facts.modelSource(model) === 'ai-gateway') return null;
  return facts.executionHarness(model) === provider ? model : null;
}

function normalizeAiCreditsModel(
  value: unknown,
  validation: ModelSelectionValidation,
): ChatModel | null {
  if (validation === 'persisted') {
    return normalizePersistableModelSelection(value);
  }
  if (typeof value !== 'string') return null;
  const facts = preferencesNormalizationEnvironment();
  const model = facts.resolveKnownModel(value);
  return model && facts.isGatewayRoutable(model) ? model : null;
}

function normalizeProviderSelection(
  value: unknown,
  provider: AgentProviderType,
  fallback: ProviderModelSelection,
  validation: ModelSelectionValidation,
): ProviderModelSelection {
  if (!isRecord(value)) return fallback;
  const model =
    normalizeProviderModel(value.model, provider, validation) ?? fallback.model;
  const thinkingLevel = normalizeThinkingLevel(
    value.thinkingLevel,
    fallback.thinkingLevel,
  );
  return { model, thinkingLevel };
}

function normalizeNullableOllamaSelection(
  value: unknown,
  validation: ModelSelectionValidation,
): ProviderModelSelection | null {
  if (!isRecord(value)) return null;
  const model = normalizeProviderModel(value.model, 'ollama', validation);
  if (!model) return null;
  const thinkingLevel = normalizeThinkingLevel(value.thinkingLevel, 'high');
  return { model, thinkingLevel };
}

function normalizeNullableAiCreditsSelection(
  value: unknown,
  validation: ModelSelectionValidation,
): ProviderModelSelection | null {
  if (!isRecord(value)) return null;
  const model = normalizeAiCreditsModel(value.model, validation);
  if (!model) return null;
  return {
    model,
    thinkingLevel: normalizeThinkingLevel(value.thinkingLevel, 'high'),
  };
}

function normalizeModelDefaultsByProvider(
  value: unknown,
  fallback: ModelDefaultsByProvider,
  validation: ModelSelectionValidation,
): ModelDefaultsByProvider {
  if (!isRecord(value)) {
    return {
      claude: { ...fallback.claude },
      codex: { ...fallback.codex },
      ollama: fallback.ollama ? { ...fallback.ollama } : null,
      aiCredits: fallback.aiCredits ? { ...fallback.aiCredits } : null,
    };
  }
  return {
    claude: normalizeProviderSelection(
      value.claude,
      'claude',
      fallback.claude,
      validation,
    ),
    codex: normalizeProviderSelection(
      value.codex,
      'codex',
      fallback.codex,
      validation,
    ),
    ollama: normalizeNullableOllamaSelection(value.ollama, validation),
    aiCredits: normalizeNullableAiCreditsSelection(value.aiCredits, validation),
  };
}

/**
 * Normalizes one persisted surface key.
 *
 * A key that is simply ABSENT never had a user choice, so it takes the product
 * default. A key that is PRESENT but malformed is corrupt persisted state, and
 * resolving corruption *upward* to Full Access would silently escalate a user
 * who had chosen Ask — so it fails closed instead (CAN-3055). Keeping these two
 * cases distinct is the whole point; do not collapse them back onto `fallback`.
 */
function normalizeApprovalDefaultKey(
  value: Record<string, unknown>,
  key: keyof ApprovalDefaults,
  fallback: ApprovalDefaults,
): ApprovalMode {
  const persisted = value[key];
  if (isApprovalMode(persisted)) {
    return persisted;
  }
  return persisted === undefined ? fallback[key] : FAIL_CLOSED_APPROVAL_MODE;
}

export function normalizeApprovalDefaults(
  value: unknown,
  fallback: ApprovalDefaults,
): ApprovalDefaults {
  if (value === undefined) {
    // Never persisted: no user choice was ever made, so take the product
    // default. This is the fresh-install path.
    return { ...fallback };
  }
  if (!isRecord(value)) {
    // Present but not even an object (`null`, a string, an array, a number):
    // corrupt persisted state, exactly like a malformed per-key value. Falling
    // back to the product default here would resolve corruption UPWARD to Full
    // Access and silently escalate a user who had chosen Ask (CAN-3055).
    return createFailClosedApprovalDefaults();
  }
  const normalized = { ...fallback };
  for (const surface of APPROVAL_DEFAULT_SURFACES) {
    normalized[surface] = normalizeApprovalDefaultKey(value, surface, fallback);
  }
  return normalized;
}

export function normalizeProviderModelConfigDefaults(
  value: unknown,
  legacyCodexFastModeDefaultEnabled: unknown,
): Partial<Record<AgentProviderType, AgentModelConfig>> {
  const result: Partial<Record<AgentProviderType, AgentModelConfig>> = {};
  const source = isRecord(value) ? value : {};
  const providers: AgentProviderType[] = ['claude', 'codex', 'ollama'];

  for (const provider of providers) {
    const normalized = normalizeAgentModelConfig(source[provider]);
    if (normalized) {
      result[provider] = normalized;
    }
  }

  const codexHasExplicitFastMode = typeof result.codex?.fastMode === 'boolean';
  if (
    !codexHasExplicitFastMode &&
    typeof legacyCodexFastModeDefaultEnabled === 'boolean'
  ) {
    result.codex = {
      ...(result.codex ?? {}),
      fastMode: legacyCodexFastModeDefaultEnabled,
    };
  } else if (!codexHasExplicitFastMode) {
    result.codex = {
      ...(result.codex ?? {}),
      fastMode:
        DEFAULT_PREFERENCES.providerModelConfigDefaults.codex?.fastMode ??
        false,
    };
  }

  return result;
}

export function normalizeDefaultProvider(
  value: unknown,
  byProvider: ModelDefaultsByProvider,
  fallback: AgentProviderType,
): AgentProviderType {
  const candidate =
    value === 'claude' || value === 'codex' || value === 'ollama'
      ? value
      : fallback;
  if (candidate === 'ollama' && byProvider.ollama === null) {
    return 'claude';
  }
  return candidate;
}

function isLaneScopeRecord(
  value: unknown,
): value is { chat?: unknown; worktree?: unknown } {
  // Arrays must NOT qualify. `typeof [] === 'object'`, so a corrupt
  // `lastResolvedDefaultLaneByScope: []` used to pass here and — now that an
  // empty-but-present map means "deliberate full erasure" — would be persisted
  // as one instead of falling through to the legacy-scalar migration, silently
  // discarding lane stickiness the file still carried.
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize the per-scope resolved-lane map, seeding each scope from the legacy
 * scope-agnostic `lastResolvedDefaultLane` so an existing preferences file
 * keeps its lane stickiness across the upgrade.
 *
 * The seed is a MIGRATION, so it only applies when the per-scope map is absent
 * (or unusable) entirely. Once the map exists, an absent slot is a deliberate
 * erasure — `default-model-lane-resolver.ts` drops a scope whose lane it
 * CONFIRMED unavailable, from every scope at once, while the scalar can survive
 * holding a different lane. Re-seeding from that scalar silently undid half the
 * erase on the very next normalize, resurrecting a lane the user no longer has.
 */
export function normalizeLastResolvedLaneByScope(
  raw: unknown,
  legacy: unknown,
): Pick<PreferencesData, 'lastResolvedDefaultLaneByScope'> {
  const hasScopeRecord = isLaneScopeRecord(raw);
  const scopes: { chat?: unknown; worktree?: unknown } = hasScopeRecord
    ? raw
    : {};
  const readScope = (key: 'chat' | 'worktree'): BillingLane | undefined => {
    const value = scopes[key];
    if (isBillingLane(value)) return value;
    // An ABSENT slot in a map that EXISTS is a deliberate erasure, not a gap to
    // migrate. A CORRUPT slot still falls through to the legacy seed below —
    // the resolver never writes one, so that can only come from a damaged file.
    if (hasScopeRecord && value === undefined) return undefined;
    return isBillingLane(legacy) ? legacy : undefined;
  };
  const chat = readScope('chat');
  const worktree = readScope('worktree');
  if (!chat && !worktree) {
    // A FULLY erased map must survive as an empty-but-present marker.
    // Normalization runs on the WRITE path too, so returning `{}` here dropped
    // the key before it ever reached disk — making a deliberate erasure
    // indistinguishable from "this file predates the map". The next read then
    // took the migration branch above and re-seeded BOTH scopes from the
    // surviving scalar, resurrecting the lane that was just erased.
    //
    // The scalar is usually cleared in the same atomic write
    // (`flushResolvedLanePersistence`), which hid this for the common case —
    // but not when the scalar holds a DIFFERENT lane than the one erased.
    return hasScopeRecord ? { lastResolvedDefaultLaneByScope: {} } : {};
  }
  return {
    lastResolvedDefaultLaneByScope: {
      ...(chat ? { chat } : {}),
      ...(worktree ? { worktree } : {}),
    },
  };
}

type PreferencesInput =
  | Partial<PreferencesData>
  | Record<string, unknown>
  | undefined;

interface NormalizedLayoutPreferences {
  worktreePanelPercent: number;
  activityPanelWidthPercent: number;
  kanbanWorktreePanelPercent: number;
  kanbanActivityPanelWidthPercent: number;
}

interface NormalizedProviderDefaults {
  defaultChatProvider: AgentProviderType;
  defaultChatModelByProvider: ModelDefaultsByProvider;
  defaultWorktreeProvider: AgentProviderType;
  defaultWorktreeModelByProvider: ModelDefaultsByProvider;
}

interface NormalizedRuntimeLimits {
  scriptTimeoutMinutes: number;
  auditRetentionDays: number;
  automationRunRetentionDays: number;
  codexAppServerIdleTimeoutMinutes: number;
  claudeSessionIdleTimeoutMinutes: number;
  maxActiveChatTurns: number | null;
  maxActivePipelineExecutions: number | null;
  memoryPressureGuardEnabled: boolean;
  bypassCodexAppServerIdleTimeoutUnderCriticalPressure: boolean;
  memoryPressureWarningThresholdBytes: number;
  memoryPressureCriticalThresholdBytes: number;
}

export function normalizePersistableModelSelection(
  model: unknown,
): string | null {
  return isSyntacticallyValidModelId(model)
    ? preferencesNormalizationEnvironment().resolveModelAlias(model)
    : null;
}

export function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: string,
  validation: ModelSelectionValidation,
): string;
export function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: null,
  validation: ModelSelectionValidation,
): string | null;
export function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: string | null,
  validation: ModelSelectionValidation,
): string | null;
export function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: string | null,
  validation: ModelSelectionValidation,
): string | null {
  return (
    (validation === 'persisted'
      ? normalizePersistableModelSelection(model)
      : resolveAvailableModel(model)) ?? fallback
  );
}

interface UserSelectedModelOptions {
  /**
   * Keep a chosen model that is not available right now instead of swapping
   * in the default. For features whose model choice is a data boundary (local
   * memory may be kept on a local model on purpose): their runs refuse an
   * unavailable model rather than send data to another provider.
   */
  keepUnavailableChoice?: boolean;
}

/**
 * A model preference the user may leave on its default. Persisted data keeps
 * the stored value as written. At runtime the model follows the
 * provider-aware default until the user picks one, so a default never names a
 * provider this install cannot run and later default changes reach it; a
 * chosen model that is no longer available falls back to the default too,
 * unless `keepUnavailableChoice` keeps it.
 */
export function normalizeUserSelectedModel(
  model: unknown,
  setByUser: unknown,
  defaults: { stored: string; providerAware: () => string },
  validation: ModelSelectionValidation,
  options: UserSelectedModelOptions = {},
): { model: string; setByUser: boolean } {
  if (validation === 'persisted') {
    const stored = normalizePersistableModelSelection(model);
    return stored === null
      ? { model: defaults.stored, setByUser: false }
      : { model: stored, setByUser: setByUser === true };
  }
  const selected =
    setByUser === true
      ? (resolveAvailableModel(model) ??
        (options.keepUnavailableChoice
          ? normalizePersistableModelSelection(model)
          : null))
      : null;
  return selected === null
    ? { model: defaults.providerAware(), setByUser: false }
    : { model: selected, setByUser: true };
}

/** Pipeline Advisor accepts every currently executable model. */
function normalizePersistablePipelineAdvisorModel(
  model: unknown,
  validation: ModelSelectionValidation,
): string | null {
  if (validation === 'persisted') {
    return normalizePersistableModelSelection(model);
  }
  if (typeof model !== 'string') return null;
  const facts = preferencesNormalizationEnvironment();
  const resolved = facts.resolveKnownModel(model);
  if (!resolved) return null;
  const harness = facts.executionHarness(resolved);
  return harness && harness !== 'cursor' ? resolved : null;
}

export function normalizePersistablePipelineAdvisorModelOrDefault(
  model: unknown,
  fallback: string,
  validation: ModelSelectionValidation,
): string {
  return (
    normalizePersistablePipelineAdvisorModel(model, validation) ?? fallback
  );
}

export function normalizeFiniteNumber(
  value: unknown,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeNullablePositiveInteger(
  value: unknown,
  fallback: number | null,
  max: number,
): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampNumber(Math.round(value), 1, max);
  }
  return fallback;
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampNumber(Math.round(value), 1, max);
  }
  return fallback;
}

export function normalizeCodeGraphPreferences(
  value: unknown,
): CodeGraphPreferences {
  const record = isRecord(value) ? value : undefined;
  const mode =
    record?.mode === 'disabled' || record?.mode === 'selected-workspaces'
      ? record.mode
      : 'enabled';
  const timeout = record?.generationTimeoutMinutes;
  return {
    mode,
    selectedWorkspaceIds: normalizeStringArray(record?.selectedWorkspaceIds),
    generationTimeoutMinutes:
      typeof timeout === 'number' &&
      Number.isFinite(timeout) &&
      Number.isInteger(timeout) &&
      timeout >= 1 &&
      timeout <= 1_440
        ? timeout
        : 30,
  };
}

export function normalizeLayoutPreferences(
  data: PreferencesInput,
): NormalizedLayoutPreferences {
  return {
    worktreePanelPercent: clampNumber(
      normalizeFiniteNumber(
        data?.worktreePanelPercent,
        DEFAULT_PREFERENCES.worktreePanelPercent,
      ),
      20,
      65,
    ),
    activityPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.activityPanelWidthPercent,
        DEFAULT_PREFERENCES.activityPanelWidthPercent,
      ),
      15,
      40,
    ),
    kanbanWorktreePanelPercent: clampNumber(
      normalizeFiniteNumber(
        data?.kanbanWorktreePanelPercent,
        DEFAULT_PREFERENCES.kanbanWorktreePanelPercent,
      ),
      20,
      65,
    ),
    kanbanActivityPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.kanbanActivityPanelWidthPercent,
        DEFAULT_PREFERENCES.kanbanActivityPanelWidthPercent,
      ),
      15,
      40,
    ),
  };
}

export function normalizeProviderDefaults(
  data: PreferencesInput,
  validation: ModelSelectionValidation,
): NormalizedProviderDefaults {
  const defaultChatModelByProvider = normalizeModelDefaultsByProvider(
    data?.defaultChatModelByProvider,
    DEFAULT_PREFERENCES.defaultChatModelByProvider,
    validation,
  );
  const defaultWorktreeModelByProvider = normalizeModelDefaultsByProvider(
    data?.defaultWorktreeModelByProvider,
    DEFAULT_PREFERENCES.defaultWorktreeModelByProvider,
    validation,
  );

  return {
    defaultChatProvider: normalizeDefaultProvider(
      data?.defaultChatProvider,
      defaultChatModelByProvider,
      DEFAULT_PREFERENCES.defaultChatProvider,
    ),
    defaultChatModelByProvider,
    defaultWorktreeProvider: normalizeDefaultProvider(
      data?.defaultWorktreeProvider,
      defaultWorktreeModelByProvider,
      DEFAULT_PREFERENCES.defaultWorktreeProvider,
    ),
    defaultWorktreeModelByProvider,
  };
}

export function normalizeRuntimeLimits(
  data: PreferencesInput,
): NormalizedRuntimeLimits {
  const scriptTimeoutRaw = data?.scriptTimeoutMinutes;
  const auditRetentionRaw = data?.auditRetentionDays;
  const automationRunRetentionRaw = data?.automationRunRetentionDays;
  const codexIdleTimeoutRaw = data?.codexAppServerIdleTimeoutMinutes;
  const claudeIdleTimeoutRaw = data?.claudeSessionIdleTimeoutMinutes;
  const maxMemoryThresholdBytes = 1024 * 1024 * 1024 * 1024;
  let memoryPressureWarningThresholdBytes = normalizePositiveInteger(
    data?.memoryPressureWarningThresholdBytes,
    DEFAULT_PREFERENCES.memoryPressureWarningThresholdBytes,
    maxMemoryThresholdBytes,
  );
  let memoryPressureCriticalThresholdBytes = normalizePositiveInteger(
    data?.memoryPressureCriticalThresholdBytes,
    DEFAULT_PREFERENCES.memoryPressureCriticalThresholdBytes,
    maxMemoryThresholdBytes,
  );
  if (
    memoryPressureCriticalThresholdBytes <= memoryPressureWarningThresholdBytes
  ) {
    memoryPressureWarningThresholdBytes =
      DEFAULT_PREFERENCES.memoryPressureWarningThresholdBytes;
    memoryPressureCriticalThresholdBytes =
      DEFAULT_PREFERENCES.memoryPressureCriticalThresholdBytes;
  }

  return {
    scriptTimeoutMinutes:
      typeof scriptTimeoutRaw === 'number' && Number.isFinite(scriptTimeoutRaw)
        ? clampNumber(Math.round(scriptTimeoutRaw), 1, 30)
        : DEFAULT_PREFERENCES.scriptTimeoutMinutes,
    auditRetentionDays:
      typeof auditRetentionRaw === 'number' &&
      Number.isFinite(auditRetentionRaw)
        ? clampNumber(Math.round(auditRetentionRaw), 1, 90)
        : DEFAULT_PREFERENCES.auditRetentionDays,
    automationRunRetentionDays:
      typeof automationRunRetentionRaw === 'number' &&
      Number.isFinite(automationRunRetentionRaw)
        ? clampNumber(Math.round(automationRunRetentionRaw), 1, 365)
        : (DEFAULT_PREFERENCES.automationRunRetentionDays ?? 90),
    codexAppServerIdleTimeoutMinutes:
      typeof codexIdleTimeoutRaw === 'number' &&
      Number.isFinite(codexIdleTimeoutRaw)
        ? clampNumber(Math.round(codexIdleTimeoutRaw), 1, 120)
        : DEFAULT_PREFERENCES.codexAppServerIdleTimeoutMinutes,
    claudeSessionIdleTimeoutMinutes:
      typeof claudeIdleTimeoutRaw === 'number' &&
      Number.isFinite(claudeIdleTimeoutRaw)
        ? clampNumber(Math.round(claudeIdleTimeoutRaw), 1, 120)
        : DEFAULT_PREFERENCES.claudeSessionIdleTimeoutMinutes,
    maxActiveChatTurns: normalizeNullablePositiveInteger(
      data?.maxActiveChatTurns,
      DEFAULT_PREFERENCES.maxActiveChatTurns,
      100,
    ),
    maxActivePipelineExecutions: normalizeNullablePositiveInteger(
      data?.maxActivePipelineExecutions,
      DEFAULT_PREFERENCES.maxActivePipelineExecutions,
      100,
    ),
    memoryPressureGuardEnabled: normalizeBoolean(
      data?.memoryPressureGuardEnabled,
      DEFAULT_PREFERENCES.memoryPressureGuardEnabled,
    ),
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure: normalizeBoolean(
      data?.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
      DEFAULT_PREFERENCES.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    ),
    memoryPressureWarningThresholdBytes,
    memoryPressureCriticalThresholdBytes,
  };
}
