// ---------------------------------------------------------------------------

import type { AiGatewayHarness } from '../ai-gateway-models';
// Browser-safe model catalog contract (CAN-1218).
//
// The desktop's model registry (`CLAUDE_MODELS` / `CODEX_MODELS` /
// `OLLAMA_MODELS` / `AGENT_MODELS` in `@canopy/desktop-shared`) is a set of
// runtime-mutable singletons hydrated from the host's package.json pins, live
// Ollama discovery, LaunchDarkly-gated entries, and custom Agent overlays — it
// is not a static literal that could simply be relocated. The web portal may
// not import `@canopy/desktop-shared`, so for the portal model picker to show
// the SAME models a connected desktop actually has, the desktop projects a
// lean, serializable snapshot of its catalog over the portal transport typed by
// the shapes in this module.
//
// This module is the single browser-safe catalog contract shared by the desktop
// projector and the web picker. It is re-exported through `@canopy/ui-shared`
// (`@canopy/ui-shared/lib`) so the web app imports the catalog contract without
// gaining a `@canopy/desktop-shared` dependency. It must remain pure: no Node,
// Electron, React, Prisma, Next, or app imports — only serializable types and
// pure helpers.
// ---------------------------------------------------------------------------

import {
  THINKING_UI_LEVELS,
  providerFallbackThinkingLevels,
  type ThinkingLevel,
  type ThinkingUiLevel,
} from '../thinking/index';

export * from './guest-model-access';
export * from './model-library-access';

/**
 * The concrete providers a projected catalog model can belong to. Mirrors the
 * desktop `AgentProviderType` and the wire `PortalChatAgentProviderType`; kept
 * as its own local union so this module has no cross-import into the portal
 * contract.
 */
export type AgentExecutionHarness =
  | AiGatewayHarness
  | 'cursor'
  | 'opencode'
  | 'copilot'
  | 'antigravity';

export type ModelCatalogProvider =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'opencode'
  | 'copilot'
  | 'antigravity'
  | 'unknown';

/** Source registry for grouping; separate from the effective harness. */
export type ModelCatalogSource =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'opencode'
  | 'copilot'
  | 'antigravity'
  | 'ai-gateway';

/**
 * Providers whose catalog rows the hosted surfaces enumerate. Intentionally
 * excludes `cursor`: it is never billable to credits, so this list is not
 * exhaustive over {@link ModelCatalogProvider}. Cursor rows are gated
 * separately — via `providerAvailability.cursor` on the Portal chat-summary
 * projection (`apps/desktop-app/src/main/services/chat-service.ts`), not
 * membership here — so this comment no longer claims Cursor is withheld
 * from the portal; it is offered there for worktree chats on a managed,
 * signed-in runtime (CAN-3624).
 */
export const MODEL_CATALOG_PROVIDERS: readonly ModelCatalogProvider[] = [
  'claude',
  'codex',
  'ollama',
];

/**
 * Discriminates a plain provider model from a custom Agent overlay. Agents
 * render in their own "Agents" section of the picker (matching desktop's
 * `AgentModelGroup`) and gate on their base model's availability.
 */
export type ModelCatalogOptionKind = 'model' | 'agent';

/**
 * Legacy UI-projected effort for older hosts' thinkingLevels field. Canonical
 * supportedThinkingLevels uses ThinkingLevel and can include Low. Retain this
 * narrower alias for provider-only UI helpers and version-skewed catalogs.
 */
export type ModelCatalogThinkingLevel = ThinkingUiLevel;

/** Ascending order of {@link ModelCatalogThinkingLevel}, weakest effort first. */
export const MODEL_CATALOG_THINKING_LEVELS: readonly ModelCatalogThinkingLevel[] =
  THINKING_UI_LEVELS;

/** Capabilities of one explicit per-chat runtime choice; source identity is unchanged. */
export interface ModelCatalogHarnessChoice {
  harness: AgentExecutionHarness;
  provider: ModelCatalogProvider;
  supportedThinkingLevels?: readonly ThinkingLevel[];
  contextWindow?: number;
  supportsImages?: boolean;
  supportsFastMode?: boolean;
  funding?: 'ai-credits' | 'org-gateway';
}

/**
 * One selectable row in the projected model catalog. The catalog is a flat
 * array (grouping into provider sections happens in the picker) so the browser
 * delta reducer can validate it with a single per-item validator and no `as`
 * casts.
 */
export interface ModelCatalogOption {
  /** Canonical registry model id (or Agent model id for `kind: 'agent'`). */
  id: string;
  /**
   * Another catalog row for the same model, reached through this exact runtime
   * ID. Presentation may merge them; dispatch must retain the chosen route's ID.
   * Omitted for distinct variants and when the host cannot establish identity.
   */
  canonicalModelId?: string;
  /** Human-readable display label (from `getModelDisplayName`). */
  label: string;
  /** Optional human-readable model summary. */
  description?: string;
  /** Place this row in the nested More menu for its model family. */
  showMoreOnly?: boolean;
  /**
   * Owning provider. For `kind: 'agent'` this is the Agent's base-model
   * provider, which is what the row's availability gates against — mirroring
   * desktop's `AgentModelGroup`, which evaluates the base model's provider.
   */
  provider: ModelCatalogProvider;
  /** Optional for backward compatibility with pre-source catalog payloads. */
  source?: ModelCatalogSource;
  /** Effective execution harness, primarily for AI Gateway rows. */
  harness?: AgentExecutionHarness;
  /** Omitted on older peers; never infer additional runtimes from a model name. */
  harnessChoices?: readonly ModelCatalogHarnessChoice[];
  /** Capabilities after resolving a per-chat choice. */
  supportsImages?: boolean;
  funding?: 'ai-credits' | 'org-gateway';
  /**
   * For an `org-gateway` row, the well-known gateway preset that serves it
   * (`openrouter`, `vercel`, …), recognized from the gateway's base URL, so a
   * picker can show that gateway's own icon. Absent for a custom gateway and
   * on older hosts; the picker then shows the generic gateway glyph.
   */
  gatewayPresetId?: string;
  /** True when this exact model has a host-declared Fast-mode route. */
  supportsFastMode?: boolean;
  /** `'model'` for a plain provider model, `'agent'` for a custom Agent. */
  kind: ModelCatalogOptionKind;
  /**
   * Whether the row is selectable on its own merits. Plain models are always
   * `true` (provider-level auth gating is applied separately from the projected
   * provider availability); custom Agents are `false` when their base model is
   * unavailable, matching desktop's greyed-out Agent rows.
   */
  available: boolean;
  /**
   * Server-derived model-library eligibility for the work owner. `locked`
   * means signing in or purchasing AI Credits unlocks the row; it is separate
   * from `available` and provider/policy restrictions, which a purchase does
   * not fix. Absent on hosts that do not gate (older servers, native models).
   */
  libraryEligibility?: 'available' | 'locked';
  /**
   * Presentation-only: this is the model the host runs when a turn carries NO
   * explicit override, so the picker displays it instead of an empty chip.
   * Displaying is not pinning — the host must keep sending no override, or a
   * later change to the default stops reaching the user.
   */
  isDefault?: boolean;
  /**
   * Tri-state thinking capability: absent = permanent provider-cycle fallback;
   * `[]` = chip hidden; non-empty = exactly the host's declared level set,
   * offered verbatim (design §9 A2: `off` appears only when the host declares
   * it — consumers must never inject levels the row does not carry).
   */
  supportedThinkingLevels?: readonly ThinkingLevel[];
  /** Model family identifier populated by family-aware hosts. */
  family?: string;
  /** Human-readable model family label. */
  familyLabel?: string;
  /** Model vendor identifier. */
  vendor?: string;
  /** Declared context-window size in tokens. */
  contextWindow?: number;
  /** Host-defined catalog sort order. */
  sortOrder?: number;
  /** Set for a greyed-out Agent whose base model is not registered. */
  unavailableReason?: 'base_model_unavailable';
  /**
   * Thinking efforts this model supports, ascending, always starting at `off`.
   *
   * Support is per-model registry data (package.json `supportedThinkingLevels`,
   * gateway metadata, Agent base-model inheritance) that the browser cannot
   * derive, which is why it rides along with the model row rather than being a
   * provider constant in the web bundle.
   *
   * **Omitted** means the connected desktop predates this field — clients must
   * fall back to their provider-level cycle rather than treating the model as
   * supporting nothing.
   */
  thinkingLevels?: ModelCatalogThinkingLevel[];
  /** True when the model can only run via AI Credits / gateway (extra charge). */
  extraChargeOnly?: boolean;
  /** Optional extra-charge explanation shown in the picker tooltip. */
  extraChargeMessage?: string;
}

/**
 * The desktop's projected model catalog: a flat, serializable list of every
 * model + custom Agent the connected desktop can currently offer. Projected on
 * `PortalChatSummaryEntity.availableModels`; consumed by the portal model
 * picker.
 *
 * Absence and emptiness carry different meanings, and clients that drop a
 * selection missing from the catalog must keep them apart:
 *
 * - `availableModels` **omitted** — nothing is known. The desktop skips
 *   building the catalog entirely when no portal client is active, and a
 *   client may simply not have hydrated a summary yet.
 * - `availableModels: []` — the desktop built the catalog and it is empty,
 *   normally because an org model policy blocked every remote model and no
 *   Ollama model is selectable. Treat as authoritative. (The one exception is
 *   the brief startup window before the model registry is initialized; a
 *   client that acts on emptiness should tolerate a spurious clear there.)
 */
export type ModelCatalog = ModelCatalogOption[];

/** Resolve capabilities for the explicitly chosen runtime without changing source identity. */
export function resolveModelCatalogHarnessChoice(
  option: ModelCatalogOption,
  harness: string | undefined,
): ModelCatalogOption {
  const choice = harness
    ? option.harnessChoices?.find((item) => item.harness === harness)
    : undefined;
  if (!choice) return option;
  return {
    ...option,
    provider: choice.provider,
    harness: choice.harness,
    ...(choice.funding ? { funding: choice.funding } : {}),
    ...(choice.supportedThinkingLevels !== undefined
      ? { supportedThinkingLevels: choice.supportedThinkingLevels }
      : {}),
    ...(choice.contextWindow !== undefined
      ? { contextWindow: choice.contextWindow }
      : {}),
    ...(choice.supportsImages !== undefined
      ? { supportsImages: choice.supportsImages }
      : {}),
    ...(choice.supportsFastMode !== undefined
      ? { supportsFastMode: choice.supportsFastMode }
      : {}),
  };
}

/**
 * Look up the thinking efforts the desktop projected for `modelId`.
 *
 * Returns `undefined` when the model is absent from the catalog or the desktop
 * projected no levels for it — both mean "no per-model data", and callers must
 * fall back to their provider-level cycle. An empty projected array is also
 * treated as no data: a model that supports nothing but `off` is not a shape
 * the registry produces, so an empty array is far more likely to be a
 * projection gap than an authoritative answer.
 */
export function getModelCatalogThinkingLevels(
  catalog: ModelCatalog | undefined,
  modelId: string | undefined,
): readonly ModelCatalogThinkingLevel[] | undefined {
  if (!catalog || !modelId) {
    return undefined;
  }
  const levels = catalog.find(
    (option) => option.id === modelId,
  )?.thinkingLevels;
  return levels && levels.length > 0 ? levels : undefined;
}

/**
 * Resolve the thinking efforts a composer should offer for `modelId` — the
 * single shared resolution for BOTH display and transmission, so the level a
 * user sees on the chip is exactly the level a send carries (CAN-2339).
 *
 * Resolution order (design §9 A2 tri-state):
 * 1. The selected row's canonical `supportedThinkingLevels`, verbatim —
 *    including the explicit empty "thinking unsupported" set. When `modelId`
 *    is absent the host-declared default row stands in, mirroring the picker.
 * 2. The legacy per-model `thinkingLevels` projected by version-skewed hosts
 *    (via {@link getModelCatalogThinkingLevels}).
 * 3. The permanent provider-cycle fallback for `providerHint`.
 */
export function resolveModelCatalogThinkingLevels(
  catalog: ModelCatalog | undefined,
  modelId: string | undefined,
  providerHint: string | undefined,
): readonly ThinkingLevel[] {
  const selected =
    catalog?.find((option) => option.id === modelId) ??
    (modelId === undefined
      ? catalog?.find((option) => option.isDefault === true)
      : undefined);
  const declared = selected
    ? resolveModelCatalogHarnessChoice(selected, providerHint)
        .supportedThinkingLevels
    : undefined;
  if (declared !== undefined) return declared;
  // When the default row stood in for an absent `modelId`, resolve the legacy
  // field against that row's id so it is not skipped for undefined.
  const legacy = getModelCatalogThinkingLevels(
    catalog,
    selected?.id ?? modelId,
  );
  if (legacy !== undefined) return legacy;
  return providerFallbackThinkingLevels(providerHint);
}

/**
 * Clamp `level` to the nearest supported effort at or below it, so a stored
 * value the active model does not support displays as a real tier instead of
 * disappearing. If no supported tier is at or below it, use the weakest
 * supported tier in canonical order (or `off` for an empty set).
 */
export function clampThinkingLevelToSupported(
  level: ModelCatalogThinkingLevel,
  supported: readonly ModelCatalogThinkingLevel[],
): ModelCatalogThinkingLevel {
  if (supported.includes(level)) {
    return level;
  }
  const ceiling = MODEL_CATALOG_THINKING_LEVELS.indexOf(level);
  for (let i = ceiling - 1; i >= 0; i -= 1) {
    const candidate = MODEL_CATALOG_THINKING_LEVELS[i];
    if (candidate && supported.includes(candidate)) {
      return candidate;
    }
  }
  return (
    MODEL_CATALOG_THINKING_LEVELS.find((candidate) =>
      supported.includes(candidate),
    ) ?? 'off'
  );
}

/**
 * Advance one step through `supported`, wrapping at the end. A `current` that
 * is not in the set (a stored level the active model does not support) is
 * clamped to a supported tier first, so the next press moves from the tier
 * the user can actually see rather than jumping back to the start.
 */
export function advanceThinkingLevelIn(
  current: ModelCatalogThinkingLevel,
  supported: readonly ModelCatalogThinkingLevel[],
): ModelCatalogThinkingLevel {
  if (supported.length === 0) {
    return 'off';
  }
  const ordered = MODEL_CATALOG_THINKING_LEVELS.filter((level) =>
    supported.includes(level),
  );
  const from = clampThinkingLevelToSupported(current, ordered);
  const index = ordered.indexOf(from);
  return ordered[(index + 1) % ordered.length] ?? 'off';
}

/**
 * Vendor ids whose display name is not simply their capitalized id. Vendors are
 * brand names, so their casing is theirs to set — `OpenAI`, not `Openai`.
 *
 * Keys also cover the `provider` ids (`claude`, `codex`) for hosts that choose
 * to vendor-label a harness id. The shared picker deliberately does NOT: rows
 * that declare no vendor share one neutral "Other models" section rather than
 * being filed under a vendor they never claimed, so those two keys are
 * unreached by it.
 */
const MODEL_VENDOR_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  claude: 'Anthropic',
  openai: 'OpenAI',
  codex: 'OpenAI',
  ollama: 'Ollama',
  deepseek: 'DeepSeek',
  moonshotai: 'Moonshot AI',
  zai: 'Z.ai',
  minimax: 'MiniMax',
  google: 'Google',
  meta: 'Meta',
  mistral: 'Mistral',
  xai: 'xAI',
  qwen: 'Qwen',
};

/**
 * Display label for a model vendor, used as the picker's group heading
 * (CAN-2701). An unmapped vendor is capitalized rather than rendered as a raw
 * id, so a newly added gateway vendor reads as a name on the day it ships and
 * only needs an entry above when its brand casing is irregular.
 */
export function getModelVendorLabel(vendor: string): string {
  const normalized = vendor.trim().toLowerCase();
  if (!normalized) return 'Other';
  // An own-property check, not a bare index: a plain object literal reaches
  // `Object.prototype`, so a vendor id of `constructor` or `__proto__` would
  // return a function or an object from a `string` signature — and the picker's
  // section sort then calls `.localeCompare` on it and throws.
  const known = Object.prototype.hasOwnProperty.call(
    MODEL_VENDOR_LABELS,
    normalized,
  )
    ? MODEL_VENDOR_LABELS[normalized]
    : undefined;
  if (known) return known;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Compact context-window label for the picker's detail layer — `1M`, `200K`
 * (CAN-2701). The figure is real information for some users, but it is not the
 * model's identity, so it belongs on hover rather than in the trigger.
 *
 * Returns `undefined` for anything that cannot be a real window (absent, zero,
 * negative, non-finite) so callers render nothing instead of `0` or `NaN`.
 * A trailing `.0` is dropped because it claims a precision the figure does not
 * have.
 */
export function formatModelContextWindow(
  tokens: number | undefined,
): string | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  const format = (value: number, unit: string): string => {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${unit}`;
  };
  if (tokens >= 1_000_000) return format(tokens / 1_000_000, 'M');
  if (tokens >= 1_000) return format(tokens / 1_000, 'K');
  return String(Math.round(tokens));
}

/**
 * Pure display label for a provider section header. Shared by the desktop
 * `getProviderLabel` and the web picker so both surfaces render identical
 * section titles.
 */
export function getModelCatalogProviderLabel(
  provider: ModelCatalogProvider,
): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'ollama':
      return 'Ollama';
    case 'cursor':
      return 'Cursor';
    case 'opencode':
      return 'OpenCode';
    case 'copilot':
      return 'GitHub Copilot';
    case 'antigravity':
      return 'Antigravity';
    case 'unknown':
      return 'Model';
  }
}
