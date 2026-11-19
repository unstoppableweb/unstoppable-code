import { THINKING_LEVELS, type ThinkingLevel } from '../thinking/index';

export * from './backtest';

export const MODEL_ROUTING_MAX_BODY_BYTES = 64 * 1024;
export const MODEL_ROUTING_MAX_CANDIDATES = 12;
export const MODEL_ROUTING_MAX_RECENT_MESSAGES = 12;
export const MODEL_ROUTING_MAX_RECENT_CHARACTERS = 12_000;
export const MODEL_ROUTING_MAX_PROMPT_CHARACTERS = 8_000;
/** Upper bound on a reported conversation context, in tokens. */
export const MODEL_ROUTING_MAX_CONTEXT_TOKENS = 10_000_000;
/**
 * How long a provider prompt cache is assumed to stay warm after a turn.
 * Anthropic's default cache lifetime is five minutes; OpenAI's in-memory cache
 * lasts at least that long, so this is the conservative shared value.
 */
export const MODEL_ROUTING_CACHE_WARM_MS = 5 * 60_000;
/**
 * Switch-cost assumptions for one Auto turn: an agentic turn re-reads its
 * context on every model request after the first, and writes some output.
 * Deliberately round numbers; they only need to rank "switch" against "stay".
 */
export const MODEL_ROUTING_ASSUMED_REQUESTS_PER_TURN = 4;
export const MODEL_ROUTING_ASSUMED_OUTPUT_TOKENS_PER_TURN = 3_000;

export type ModelSelectionMode = 'manual' | 'auto';
export type ModelRoutingHarness = 'claude' | 'codex' | 'opencode';
export type ModelExecutionLane = 'provider_subscription' | 'ai_credits';

/**
 * Immutable pricing snapshot used for post-turn Auto comparisons. Rates are
 * the standard, non-regional per-token values published by the Vercel AI
 * Gateway `/v1/models` catalog on 2026-10-07. OpenAI models the gateway does
 * not list use the OpenAI API Standard rates served by the web OpenAI pricing
 * payload, fetched 2026-10-27. The three approved non-OpenAI additions use
 * Gateway rates fetched 2026-10-29, including Mercury 3 launch pricing.
 * GPT-6.2 Astra and Sol use the OpenAI API Standard rates fetched 2026-11-17.
 * Updating rates must change this revision so
 * persisted estimates retain their historical basis.
 */
export const MODEL_ROUTING_PRICING_REVISION =
  'gateway:2026-10-07+openai:2026-11-17+approved:2026-10-29' as const;

export interface ModelRoutingUsage {
  input: number;
  output: number;
  cacheReadInput: number;
  cacheCreationInput: number;
}

export type ModelRoutingUsagePrice =
  | {
      status: 'priced';
      costUsd: number;
      pricingRevision: typeof MODEL_ROUTING_PRICING_REVISION;
    }
  | { status: 'unpriced_model' };

interface ModelRoutingTokenRates {
  input: number;
  output: number;
  cacheReadInput: number;
  cacheCreationInput: number;
  longContext?: {
    thresholdExclusive: number;
    inputMultiplier: number;
    outputMultiplier: number;
    cacheReadMultiplier: number;
    cacheCreationMultiplier: number;
  };
}

const MODEL_ROUTING_STANDARD_TOKEN_RATES: Readonly<
  Record<string, ModelRoutingTokenRates>
> = {
  'anthropic/claude-fable-5.1': {
    input: 0.00001,
    output: 0.00005,
    cacheReadInput: 0.00000025,
    cacheCreationInput: 0.0000125,
  },
  'anthropic/claude-fable-5': {
    input: 0.00001,
    output: 0.00005,
    cacheReadInput: 0.000001,
    cacheCreationInput: 0.0000125,
  },
  'anthropic/claude-opus-5.5': {
    input: 0.000004,
    output: 0.00002,
    cacheReadInput: 0.0000002,
    cacheCreationInput: 0.000005,
  },
  'anthropic/claude-opus-5': {
    input: 0.000005,
    output: 0.000025,
    cacheReadInput: 0.0000005,
    cacheCreationInput: 0.00000625,
  },
  'anthropic/claude-sonnet-5.5': {
    input: 0.000002,
    output: 0.00001,
    cacheReadInput: 0.0000001,
    cacheCreationInput: 0.0000025,
  },
  'anthropic/claude-sonnet-5': {
    input: 0.000002,
    output: 0.00001,
    cacheReadInput: 0.0000002,
    cacheCreationInput: 0.0000025,
  },
  // Every token in a request above 100,000 input tokens bills at five times
  // the standard rate.
  'anthropic/claude-haiku-5.5': {
    input: 0.0000001,
    output: 0.0000005,
    cacheReadInput: 0.00000001,
    cacheCreationInput: 0.000000125,
    longContext: {
      thresholdExclusive: 100_000,
      inputMultiplier: 5,
      outputMultiplier: 5,
      cacheReadMultiplier: 5,
      cacheCreationMultiplier: 5,
    },
  },
  'anthropic/claude-haiku-4.5': {
    input: 0.000001,
    output: 0.000005,
    cacheReadInput: 0.0000001,
    cacheCreationInput: 0.00000125,
  },
  'anthropic/claude-opus-4.8': {
    input: 0.000005,
    output: 0.000025,
    cacheReadInput: 0.0000005,
    cacheCreationInput: 0.00000625,
  },
  'anthropic/claude-opus-4.7': {
    input: 0.000005,
    output: 0.000025,
    cacheReadInput: 0.0000005,
    cacheCreationInput: 0.00000625,
  },
  'anthropic/claude-opus-4.6': {
    input: 0.000005,
    output: 0.000025,
    cacheReadInput: 0.0000005,
    cacheCreationInput: 0.00000625,
  },
  'openai/gpt-6.2-astra': {
    input: 0.000008,
    output: 0.00004,
    cacheReadInput: 0.0000004,
    cacheCreationInput: 0.00001,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'openai/gpt-6.2-sol': {
    input: 0.000002,
    output: 0.00001,
    cacheReadInput: 0.0000001,
    cacheCreationInput: 0.0000025,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'openai/gpt-6-astra': {
    input: 0.00001,
    output: 0.00005,
    cacheReadInput: 0.000001,
    cacheCreationInput: 0.0000125,
    longContext: {
      thresholdExclusive: 272_001,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'openai/gpt-6.1-sol': {
    input: 0.000002,
    output: 0.00001,
    cacheReadInput: 0.0000001,
    cacheCreationInput: 0.0000025,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'moonshotai/kimi-k3.1-pro': {
    input: 0.000002,
    output: 0.00001,
    cacheReadInput: 0.0000002,
    cacheCreationInput: 0.000002,
  },
  'minimax/minimax-m3.1-flash': {
    input: 0.00000015,
    output: 0.0000006,
    cacheReadInput: 0.000000015,
    cacheCreationInput: 0.00000015,
  },
  // Launch discount; regular pricing is $0.20 input / $0.70 output per 1M.
  'inception/mercury-3': {
    input: 0.0000001,
    output: 0.00000035,
    cacheReadInput: 0.00000001,
    cacheCreationInput: 0.0000001,
  },
  'openai/gpt-6.1-terra': {
    input: 0.000001,
    output: 0.000005,
    cacheReadInput: 0.00000005,
    cacheCreationInput: 0.00000125,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'openai/gpt-6-sol': {
    input: 0.000002,
    output: 0.00001,
    cacheReadInput: 0.0000002,
    cacheCreationInput: 0.0000025,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'openai/gpt-6-luna': {
    input: 0.0000001,
    output: 0.0000005,
    cacheReadInput: 0.00000001,
    cacheCreationInput: 0.000000125,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'openai/gpt-5.6-sol': {
    input: 0.000004,
    output: 0.00002,
    cacheReadInput: 0.0000004,
    cacheCreationInput: 0.000005,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'openai/gpt-5.6-terra': {
    input: 0.000002,
    output: 0.000012,
    cacheReadInput: 0.0000002,
    cacheCreationInput: 0.0000025,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'openai/gpt-5.6-luna': {
    input: 0.0000002,
    output: 0.0000012,
    cacheReadInput: 0.00000002,
    cacheCreationInput: 0.00000025,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
  'openai/gpt-5.5': {
    input: 0.000005,
    output: 0.00003,
    cacheReadInput: 0.0000005,
    cacheCreationInput: 0.000005,
    longContext: {
      thresholdExclusive: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cacheReadMultiplier: 2,
      cacheCreationMultiplier: 2,
    },
  },
};

/**
 * Catalog models with no published per-token rate. Listing a model here
 * records that it is unpriced on purpose rather than missing from the table.
 */
const MODEL_ROUTING_UNPRICED_MODELS: ReadonlySet<string> = new Set([
  // OpenAI API pricing does not list GPT-5.3-Codex-Spark.
  'openai/gpt-5.3-codex-spark',
]);

const MODEL_ROUTING_PRICING_ALIASES: Readonly<Record<string, string>> = {
  'kimi-k3.1-pro': 'moonshotai/kimi-k3.1-pro',
  'minimax-m3.1-flash': 'minimax/minimax-m3.1-flash',
  'mercury-3': 'inception/mercury-3',
  'claude-fable-5-1': 'anthropic/claude-fable-5.1',
  'claude-fable-5.1': 'anthropic/claude-fable-5.1',
  'claude-fable-5': 'anthropic/claude-fable-5',
  'opus[1m]': 'anthropic/claude-opus-5.5',
  'claude-opus-5-5': 'anthropic/claude-opus-5.5',
  'claude-opus-5.5': 'anthropic/claude-opus-5.5',
  'claude-opus-5': 'anthropic/claude-opus-5',
  sonnet: 'anthropic/claude-sonnet-5.5',
  'claude-sonnet-5-5': 'anthropic/claude-sonnet-5.5',
  'claude-sonnet-5.5': 'anthropic/claude-sonnet-5.5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  haiku: 'anthropic/claude-haiku-5.5',
  'claude-haiku-5-5': 'anthropic/claude-haiku-5.5',
  'claude-haiku-5.5': 'anthropic/claude-haiku-5.5',
  'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',
  'claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
  'claude-haiku-4.5': 'anthropic/claude-haiku-4.5',
  'claude-opus-4-8': 'anthropic/claude-opus-4.8',
  'claude-opus-4.8': 'anthropic/claude-opus-4.8',
  'claude-opus-4-7': 'anthropic/claude-opus-4.7',
  'claude-opus-4.7': 'anthropic/claude-opus-4.7',
  'claude-opus-4-6': 'anthropic/claude-opus-4.6',
  'claude-opus-4.6': 'anthropic/claude-opus-4.6',
  'gpt-6.2-astra': 'openai/gpt-6.2-astra',
  'gpt-6.2-sol': 'openai/gpt-6.2-sol',
  'gpt-6-astra': 'openai/gpt-6-astra',
  'gpt-6.1-sol': 'openai/gpt-6.1-sol',
  'gpt-6.1-terra': 'openai/gpt-6.1-terra',
  'gpt-6-sol': 'openai/gpt-6-sol',
  'gpt-6-luna': 'openai/gpt-6-luna',
  'gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.3-codex-spark': 'openai/gpt-5.3-codex-spark',
};

/**
 * The canonical gateway id for a model id or one of its provider aliases
 * (`opus[1m]`, `claude-opus-5` → `anthropic/claude-opus-5`). Unknown ids are
 * returned unchanged.
 */
export function canonicalModelRoutingModelId(modelId: string): string {
  return MODEL_ROUTING_PRICING_ALIASES[modelId] ?? modelId;
}

function tokenRatesFor(modelId: string): ModelRoutingTokenRates | undefined {
  return MODEL_ROUTING_STANDARD_TOKEN_RATES[
    canonicalModelRoutingModelId(modelId)
  ];
}

export type ModelRoutingPricingCoverage = 'priced' | 'unpriced' | 'missing';

/**
 * Whether the rate table prices a model, deliberately leaves it unpriced, or
 * has no entry for it at all.
 */
export function modelRoutingPricingCoverage(
  modelId: string,
): ModelRoutingPricingCoverage {
  const canonical = canonicalModelRoutingModelId(modelId);
  if (MODEL_ROUTING_STANDARD_TOKEN_RATES[canonical] !== undefined) {
    return 'priced';
  }
  return MODEL_ROUTING_UNPRICED_MODELS.has(canonical) ? 'unpriced' : 'missing';
}

/** The current model's conversation, as the provider prompt cache sees it. */
export interface ModelRoutingCurrentContext {
  /** Tokens in the conversation the current model has cached. */
  tokens: number;
  /** Milliseconds since that conversation's last model activity. */
  idleMs: number;
}

/** True when the current model's prompt cache is likely still warm. */
export function isModelRoutingContextWarm(
  context: ModelRoutingCurrentContext | undefined,
): context is ModelRoutingCurrentContext {
  return (
    context !== undefined &&
    context.tokens > 0 &&
    context.idleMs <= MODEL_ROUTING_CACHE_WARM_MS
  );
}

/**
 * Whether switching from the current model to `selectedModelId` would cost
 * more than it saves on this turn, because the selected model has to re-read
 * the whole conversation without the current model's warm prompt cache.
 *
 * Switching to a model with a higher input rate is always allowed: moving up
 * is a capability decision, not a cost one. Unknown rates never block.
 */
export function shouldKeepCurrentModelForCache(input: {
  currentModelId?: string;
  selectedModelId: string;
  currentContext?: ModelRoutingCurrentContext;
}): boolean {
  const { currentModelId, selectedModelId, currentContext } = input;
  if (currentModelId === undefined || currentModelId === selectedModelId) {
    return false;
  }
  if (!isModelRoutingContextWarm(currentContext)) return false;
  const current = tokenRatesFor(currentModelId);
  const selected = tokenRatesFor(selectedModelId);
  if (!current || !selected || selected.input > current.input) return false;
  const context = currentContext.tokens;
  const switchPenaltyUsd =
    context * (selected.cacheCreationInput - current.cacheReadInput);
  const turnSavingsUsd =
    (MODEL_ROUTING_ASSUMED_REQUESTS_PER_TURN - 1) *
      context *
      (current.cacheReadInput - selected.cacheReadInput) +
    MODEL_ROUTING_ASSUMED_OUTPUT_TOKENS_PER_TURN *
      (current.output - selected.output);
  return switchPenaltyUsd > turnSavingsUsd;
}

/**
 * Usage to price the benchmark with. When Auto switched away from a warm
 * model, the selected model re-read `cacheMissContextTokens` uncached; staying
 * put would have read them from cache, so the benchmark prices them as cache
 * reads (taken from cache writes first, then uncached input).
 */
export function benchmarkModelRoutingUsage(
  usage: ModelRoutingUsage,
  cacheMissContextTokens: number | undefined,
): ModelRoutingUsage {
  const miss = Math.max(0, cacheMissContextTokens ?? 0);
  if (miss === 0) return usage;
  const fromCreation = Math.min(miss, Math.max(0, usage.cacheCreationInput));
  const uncached = Math.max(
    0,
    usage.input - usage.cacheReadInput - usage.cacheCreationInput,
  );
  const fromUncached = Math.min(miss - fromCreation, uncached);
  return {
    ...usage,
    cacheCreationInput: usage.cacheCreationInput - fromCreation,
    cacheReadInput: usage.cacheReadInput + fromCreation + fromUncached,
  };
}

/**
 * Every distinct long-context threshold, ascending. A request's input size
 * changes its price only where it crosses one of these.
 */
export const MODEL_ROUTING_LONG_CONTEXT_THRESHOLDS_TOKENS: readonly number[] =
  Array.from(
    new Set(
      Object.values(MODEL_ROUTING_STANDARD_TOKEN_RATES).flatMap((rates) =>
        rates.longContext ? [rates.longContext.thresholdExclusive] : [],
      ),
    ),
  ).sort((a, b) => a - b);

/**
 * A per-request input size that prices like every request exceeding exactly
 * the `band` lowest long-context thresholds. Use it to price usage summed over
 * requests that were grouped by band.
 */
export function modelRoutingLongContextBandInputTokens(band: number): number {
  const threshold = MODEL_ROUTING_LONG_CONTEXT_THRESHOLDS_TOKENS[band - 1];
  return threshold === undefined ? 0 : threshold + 1;
}

/**
 * Reprice one completed turn against a catalog model using identical usage.
 *
 * `longContextInputTokens` overrides the per-request input size used to pick
 * long-context rates. Pass it when `usage` is a sum over many turns, so the
 * summed input doesn't trip the threshold that each turn is judged against.
 */
export function priceModelRoutingUsage(
  modelId: string,
  usage: ModelRoutingUsage,
  options: { longContextInputTokens?: number } = {},
): ModelRoutingUsagePrice {
  const baseRates = tokenRatesFor(modelId);
  if (!baseRates) return { status: 'unpriced_model' };

  const input = Math.max(0, usage.input);
  const output = Math.max(0, usage.output);
  const cacheReadInput = Math.max(0, usage.cacheReadInput);
  const cacheCreationInput = Math.max(0, usage.cacheCreationInput);
  const uncachedInput = Math.max(
    0,
    input - cacheReadInput - cacheCreationInput,
  );
  const longContext = baseRates.longContext;
  const useLongContext =
    longContext !== undefined &&
    (options.longContextInputTokens ?? input) > longContext.thresholdExclusive;
  const inputMultiplier = useLongContext ? longContext.inputMultiplier : 1;
  const outputMultiplier = useLongContext ? longContext.outputMultiplier : 1;
  const cacheReadMultiplier = useLongContext
    ? longContext.cacheReadMultiplier
    : 1;
  const cacheCreationMultiplier = useLongContext
    ? longContext.cacheCreationMultiplier
    : 1;
  const costUsd =
    uncachedInput * baseRates.input * inputMultiplier +
    output * baseRates.output * outputMultiplier +
    cacheReadInput * baseRates.cacheReadInput * cacheReadMultiplier +
    cacheCreationInput * baseRates.cacheCreationInput * cacheCreationMultiplier;
  return {
    status: 'priced',
    costUsd: Number(costUsd.toFixed(12)),
    pricingRevision: MODEL_ROUTING_PRICING_REVISION,
  };
}

export interface AutoModelRoutingCandidate {
  modelId: string;
  label: string;
  description: string;
  harness: ModelRoutingHarness;
  executionLane: ModelExecutionLane;
  isDefault?: boolean;
}

export interface AutoModelRoutingRecentMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface AutoModelRoutingRequestV1 {
  schemaVersion: 1;
  requestId: string;
  surface: 'desktop' | 'cloud';
  currentModelId?: string;
  /** Size and age of the current model's conversation, for switch costs. */
  currentContext?: ModelRoutingCurrentContext;
  fallbackModelId: string;
  capturedHarness?: ModelRoutingHarness;
  executionLane: ModelExecutionLane;
  candidates: AutoModelRoutingCandidate[];
  state: {
    prompt: string;
    recentMessages: AutoModelRoutingRecentMessage[];
    attachmentCounts: {
      files: number;
      images: number;
      documents: number;
    };
    mode: {
      task: 'execute' | 'plan';
      approval?: 'ask' | 'auto' | 'full-access';
      proposal?: 'optional' | 'required';
      thinkingLevel?: ThinkingLevel;
      fast: boolean;
      workspace: 'single-repo' | 'multi-repo' | 'cowork' | 'cloud';
    };
  };
}

export type AutoModelRoutingFallbackReason =
  | 'unavailable'
  | 'timeout'
  | 'invalid_answer'
  | 'insufficient_credits'
  | 'policy_blocked'
  | 'no_eligible_models'
  | 'stale_candidates'
  | 'routing_in_progress';

export interface AutoModelRoutingResponseV1 {
  schemaVersion: 1;
  requestId: string;
  outcome: 'selected' | 'fallback';
  modelId: string;
  routingCostUsd?: number;
  routingCredits?: number;
  fallbackReason?: AutoModelRoutingFallbackReason;
}

export interface ModelRoutingSavingsV1 {
  status:
    | 'computed'
    | 'default_unavailable'
    | 'unpriced_model'
    | 'incomplete_usage'
    | 'incomparable_basis'
    | 'unresolved_routing_cost';
  pricingRevision?: string;
  selectedCostBasis?: 'gateway_actual' | 'api_equivalent';
  benchmarkEstimatedExecutionCostUsd?: number;
  selectedExecutionCostUsd?: number;
  actualWithAutoCostUsd?: number;
  netEstimatedSavingsUsd?: number;
}

export interface ModelRoutingAttributionV1 {
  schemaVersion: 1;
  selectionMode: 'auto';
  outcome: 'selected' | 'fallback';
  executionLane: ModelExecutionLane;
  benchmarkModelId?: string;
  selectedModelId: string;
  routingCostUsd?: number;
  routingCredits?: number;
  /**
   * Context the selected model re-read uncached because Auto switched away
   * from a warm model. The benchmark prices it as cache reads.
   */
  cacheMissContextTokens?: number;
  savings?: ModelRoutingSavingsV1;
}

export interface FinalizeModelRoutingSavingsInput {
  attribution: ModelRoutingAttributionV1;
  usageComplete: boolean;
  selectedExecutionCostUsd?: number;
  selectedCostBasis: 'gateway_actual' | 'api_equivalent';
  benchmark?:
    | { status: 'priced'; costUsd: number; pricingRevision: string }
    | { status: 'unpriced_model' | 'incomparable_basis' };
}

function roundedUsd(value: number): number {
  return Number(value.toFixed(12));
}

/** Complete bounded Auto savings only after authoritative usage is available. */
export function finalizeModelRoutingSavings(
  input: FinalizeModelRoutingSavingsInput,
): ModelRoutingAttributionV1 {
  let savings: ModelRoutingSavingsV1;
  if (input.attribution.benchmarkModelId === undefined) {
    savings = { status: 'default_unavailable' };
  } else if (input.attribution.routingCostUsd === undefined) {
    savings = { status: 'unresolved_routing_cost' };
  } else if (
    !input.usageComplete ||
    input.selectedExecutionCostUsd === undefined ||
    !Number.isFinite(input.selectedExecutionCostUsd)
  ) {
    savings = { status: 'incomplete_usage' };
  } else if (
    (input.attribution.executionLane === 'ai_credits' &&
      input.selectedCostBasis !== 'gateway_actual') ||
    (input.attribution.executionLane === 'provider_subscription' &&
      input.selectedCostBasis !== 'api_equivalent')
  ) {
    savings = { status: 'incomparable_basis' };
  } else if (input.benchmark === undefined) {
    savings = { status: 'unpriced_model' };
  } else if (input.benchmark.status !== 'priced') {
    savings = { status: input.benchmark.status };
  } else {
    const actualWithAutoCostUsd = roundedUsd(
      input.selectedExecutionCostUsd + input.attribution.routingCostUsd,
    );
    savings = {
      status: 'computed',
      pricingRevision: input.benchmark.pricingRevision,
      selectedCostBasis: input.selectedCostBasis,
      benchmarkEstimatedExecutionCostUsd: roundedUsd(input.benchmark.costUsd),
      selectedExecutionCostUsd: roundedUsd(input.selectedExecutionCostUsd),
      actualWithAutoCostUsd,
      netEstimatedSavingsUsd: roundedUsd(
        input.benchmark.costUsd - actualWithAutoCostUsd,
      ),
    };
  }
  return { ...input.attribution, savings };
}

export class ModelRoutingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRoutingValidationError';
  }
}

function fail(message: string): never {
  throw new ModelRoutingValidationError(message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${path}.${unknown} is not allowed`);
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    fail(`${path} is invalid`);
  }
  return value as T;
}

function boundedString(value: unknown, maximum: number, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum
  ) {
    fail(`${path} must contain between 1 and ${maximum} characters`);
  }
  return value;
}

const PATH_OR_URL =
  /(?:https?:\/\/|file:\/\/|(?:^|\s)(?:\/[A-Za-z]|[A-Za-z]:[\\/]|~\/))/i;

function safeCatalogString(
  value: unknown,
  maximum: number,
  path: string,
): string {
  const parsed = boundedString(value, maximum, path);
  if (PATH_OR_URL.test(parsed)) fail(`${path} must not contain a URL or path`);
  return parsed;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    fail(`${path} must be a non-negative integer`);
  }
  return value as number;
}

function parseCurrentContext(value: unknown): ModelRoutingCurrentContext {
  const context = record(value, 'currentContext');
  exactKeys(context, ['tokens', 'idleMs'], 'currentContext');
  const tokens = nonNegativeInteger(context.tokens, 'currentContext.tokens');
  if (tokens > MODEL_ROUTING_MAX_CONTEXT_TOKENS) {
    fail('currentContext.tokens is too large');
  }
  return {
    tokens,
    idleMs: nonNegativeInteger(context.idleMs, 'currentContext.idleMs'),
  };
}

export function truncateAutoModelRoutingRecentMessages(
  messages: readonly AutoModelRoutingRecentMessage[],
): AutoModelRoutingRecentMessage[] {
  const newest = messages.slice(-MODEL_ROUTING_MAX_RECENT_MESSAGES);
  const retained: AutoModelRoutingRecentMessage[] = [];
  let remaining = MODEL_ROUTING_MAX_RECENT_CHARACTERS;

  for (let index = newest.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = newest[index];
    if (message === undefined) continue;
    const text = message.text.slice(-remaining);
    if (text.length > 0) retained.unshift({ role: message.role, text });
    remaining -= text.length;
  }
  return retained;
}

export function parseAutoModelRoutingRequestV1(
  input: unknown,
  decodedBodyBytes?: number,
): AutoModelRoutingRequestV1 {
  if (
    decodedBodyBytes !== undefined &&
    decodedBodyBytes > MODEL_ROUTING_MAX_BODY_BYTES
  ) {
    fail('request body exceeds 64 KiB');
  }

  const root = record(input, 'request');
  exactKeys(
    root,
    [
      'schemaVersion',
      'requestId',
      'surface',
      'currentModelId',
      'currentContext',
      'fallbackModelId',
      'capturedHarness',
      'executionLane',
      'candidates',
      'state',
    ],
    'request',
  );
  if (root.schemaVersion !== 1) fail('schemaVersion must be 1');
  const requestId = boundedString(root.requestId, 128, 'requestId');
  const surface = enumValue(root.surface, ['desktop', 'cloud'], 'surface');
  const currentModelId =
    root.currentModelId === undefined
      ? undefined
      : safeCatalogString(root.currentModelId, 128, 'currentModelId');
  const currentContext =
    root.currentContext === undefined
      ? undefined
      : parseCurrentContext(root.currentContext);
  const fallbackModelId = safeCatalogString(
    root.fallbackModelId,
    128,
    'fallbackModelId',
  );
  const capturedHarness =
    root.capturedHarness === undefined
      ? undefined
      : enumValue(
          root.capturedHarness,
          ['claude', 'codex', 'opencode'],
          'capturedHarness',
        );
  const executionLane = enumValue(
    root.executionLane,
    ['provider_subscription', 'ai_credits'],
    'executionLane',
  );

  if (
    !Array.isArray(root.candidates) ||
    root.candidates.length < 1 ||
    root.candidates.length > MODEL_ROUTING_MAX_CANDIDATES
  ) {
    fail('candidates must contain between 1 and 12 entries');
  }
  const ids = new Set<string>();
  const defaults = new Map<ModelRoutingHarness, number>();
  const candidates = root.candidates.map((raw, index) => {
    const candidate = record(raw, `candidates[${index}]`);
    exactKeys(
      candidate,
      [
        'modelId',
        'label',
        'description',
        'harness',
        'executionLane',
        'isDefault',
      ],
      `candidates[${index}]`,
    );
    const modelId = safeCatalogString(
      candidate.modelId,
      128,
      'candidate.modelId',
    );
    if (ids.has(modelId)) fail('candidate model IDs must be unique');
    ids.add(modelId);
    const harness = enumValue(
      candidate.harness,
      ['claude', 'codex', 'opencode'],
      'candidate.harness',
    );
    const lane = enumValue(
      candidate.executionLane,
      ['provider_subscription', 'ai_credits'],
      'candidate.executionLane',
    );
    if (lane !== executionLane) fail('all candidates must match executionLane');
    if (capturedHarness && harness !== capturedHarness) {
      fail('all candidates must match capturedHarness');
    }
    if (
      harness === 'opencode' &&
      (surface !== 'desktop' ||
        executionLane !== 'ai_credits' ||
        capturedHarness !== 'opencode')
    ) {
      fail('OpenCode Auto requires a captured desktop AI Credits harness');
    }
    if (
      candidate.isDefault !== undefined &&
      typeof candidate.isDefault !== 'boolean'
    ) {
      fail('candidate.isDefault must be boolean');
    }
    if (candidate.isDefault) {
      const defaultCount = (defaults.get(harness) ?? 0) + 1;
      defaults.set(harness, defaultCount);
      if (defaultCount > 1) fail('at most one default is allowed per harness');
    }
    return {
      modelId,
      label: safeCatalogString(candidate.label, 80, 'candidate.label'),
      description: safeCatalogString(
        candidate.description,
        240,
        'candidate.description',
      ),
      harness,
      executionLane: lane,
      ...(candidate.isDefault === undefined
        ? {}
        : { isDefault: candidate.isDefault }),
    } satisfies AutoModelRoutingCandidate;
  });
  if (!ids.has(fallbackModelId))
    fail('fallbackModelId must identify a candidate');

  const state = record(root.state, 'state');
  exactKeys(
    state,
    ['prompt', 'recentMessages', 'attachmentCounts', 'mode'],
    'state',
  );
  const prompt = boundedString(
    state.prompt,
    MODEL_ROUTING_MAX_PROMPT_CHARACTERS,
    'prompt',
  );
  if (!Array.isArray(state.recentMessages))
    fail('recentMessages must be an array');
  const recentMessages = state.recentMessages.map((raw, index) => {
    const message = record(raw, `recentMessages[${index}]`);
    exactKeys(message, ['role', 'text'], `recentMessages[${index}]`);
    return {
      role: enumValue(
        message.role,
        ['user', 'assistant'],
        'recentMessages.role',
      ),
      text: boundedString(message.text, 12_000, 'recentMessages.text'),
    } satisfies AutoModelRoutingRecentMessage;
  });
  const attachmentCounts = record(state.attachmentCounts, 'attachmentCounts');
  exactKeys(
    attachmentCounts,
    ['files', 'images', 'documents'],
    'attachmentCounts',
  );
  const mode = record(state.mode, 'mode');
  exactKeys(
    mode,
    ['task', 'approval', 'proposal', 'thinkingLevel', 'fast', 'workspace'],
    'mode',
  );
  if (typeof mode.fast !== 'boolean') fail('mode.fast must be boolean');

  return {
    schemaVersion: 1,
    requestId,
    surface,
    ...(currentModelId === undefined ? {} : { currentModelId }),
    ...(currentContext === undefined ? {} : { currentContext }),
    fallbackModelId,
    ...(capturedHarness === undefined ? {} : { capturedHarness }),
    executionLane,
    candidates,
    state: {
      prompt,
      recentMessages: truncateAutoModelRoutingRecentMessages(recentMessages),
      attachmentCounts: {
        files: nonNegativeInteger(
          attachmentCounts.files,
          'attachmentCounts.files',
        ),
        images: nonNegativeInteger(
          attachmentCounts.images,
          'attachmentCounts.images',
        ),
        documents: nonNegativeInteger(
          attachmentCounts.documents,
          'attachmentCounts.documents',
        ),
      },
      mode: {
        task: enumValue(mode.task, ['execute', 'plan'], 'mode.task'),
        ...(mode.approval === undefined
          ? {}
          : {
              approval: enumValue(
                mode.approval,
                ['ask', 'auto', 'full-access'],
                'mode.approval',
              ),
            }),
        ...(mode.proposal === undefined
          ? {}
          : {
              proposal: enumValue(
                mode.proposal,
                ['optional', 'required'],
                'mode.proposal',
              ),
            }),
        ...(mode.thinkingLevel === undefined
          ? {}
          : {
              thinkingLevel: enumValue(
                mode.thinkingLevel,
                THINKING_LEVELS,
                'mode.thinkingLevel',
              ),
            }),
        fast: mode.fast,
        workspace: enumValue(
          mode.workspace,
          ['single-repo', 'multi-repo', 'cowork', 'cloud'],
          'mode.workspace',
        ),
      } as AutoModelRoutingRequestV1['state']['mode'],
    },
  };
}
