import { z } from 'zod';
import {
  MODEL_GATEWAY_MAX_ID_LENGTH,
  MODEL_GATEWAY_MAX_DISCOVERED_MODELS,
  MODEL_GATEWAY_MAX_LABEL_LENGTH,
  normalizeModelGatewayBaseUrl,
  type ModelGatewayModel,
} from '../canopy-server';
import { matchAiGatewayPreset } from './presets';

/** Largest `/v1/models` body either probe reads; large catalogs exceed 1 MiB. */
export const MODEL_GATEWAY_DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Headers for `GET {baseUrl}/v1/models`, given the normalized base URL.
 * Anthropic-format endpoints require `anthropic-version`; OpenAI-format
 * gateways such as OpenRouter answer it with a truncated Anthropic page, so
 * it is omitted for them.
 */
export function gatewayDiscoveryHeaders(
  baseUrl: string,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
  };
  if (matchAiGatewayPreset(baseUrl)?.discoveryFormat !== 'openai')
    headers['anthropic-version'] = '2023-06-01';
  return headers;
}

export const discoveredGatewayModelSchema = z.strictObject({
  id: z.string().min(1).max(MODEL_GATEWAY_MAX_ID_LENGTH),
  label: z.string().min(1).max(MODEL_GATEWAY_MAX_LABEL_LENGTH),
  contextWindow: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  anthropic: z.boolean(),
  /** Absent when the gateway doesn't say whether the weights are published. */
  openWeights: z.boolean().optional(),
});
export type DiscoveredGatewayModel = z.output<
  typeof discoveredGatewayModelSchema
>;
export const aiGatewayConnectionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('connected'),
    baseUrl: z.string(),
    models: z
      .array(discoveredGatewayModelSchema)
      .max(MODEL_GATEWAY_MAX_DISCOVERED_MODELS),
  }),
  z.strictObject({
    status: z.enum([
      'unauthorized',
      'unreachable',
      'invalid_url',
      'key_required',
    ]),
  }),
]);
export type AiGatewayConnectionResult = z.output<
  typeof aiGatewayConnectionResultSchema
>;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Whether the gateway says the model's weights are published: Requesty's
 * `open_weights`, Vercel's `open-weights` tag, or OpenRouter's Hugging Face
 * ID. Undefined when the row carries none of them (LiteLLM, custom).
 */
function openWeightsOf(row: Record<string, unknown>): boolean | undefined {
  if (typeof row.open_weights === 'boolean') return row.open_weights;
  if (Array.isArray(row.tags)) return row.tags.includes('open-weights');
  if ('hugging_face_id' in row)
    return (
      typeof row.hugging_face_id === 'string' &&
      row.hugging_face_id.trim().length > 0
    );
  return undefined;
}
function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= max
  );
}

// The non-chat types Vercel AI Gateway lists in `/v1/models`.
const NON_CHAT_MODEL_TYPES: ReadonlySet<string> = new Set([
  'embedding',
  'evaluation',
  'image',
  'realtime',
  'reranking',
  'speech',
  'transcription',
  'video',
]);

/** Provider metadata is untrusted data, never markup or agent instructions. */
export function parseGatewayModelList(
  value: unknown,
): DiscoveredGatewayModel[] {
  if (!record(value)) return [];
  const rows: unknown[] = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.models)
      ? value.models
      : [];
  const models: DiscoveredGatewayModel[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (!record(row)) continue;
    // Drop only types known not to chat; other gateways use their own type names for chat models.
    if (typeof row.type === 'string' && NON_CHAT_MODEL_TYPES.has(row.type))
      continue;
    const info = record(row.model_info) ? row.model_info : {};
    const id = row.id ?? row.model_name ?? row.name;
    if (!bounded(id, MODEL_GATEWAY_MAX_ID_LENGTH) || ids.has(id)) continue;
    const label = row.display_name ?? row.name ?? row.model_name ?? id;
    if (!bounded(label, MODEL_GATEWAY_MAX_LABEL_LENGTH)) continue;
    const rawContext =
      row.context_window ??
      row.context_length ??
      info.max_input_tokens ??
      info.max_tokens;
    const contextWindow =
      typeof rawContext === 'number' &&
      Number.isSafeInteger(rawContext) &&
      rawContext > 0
        ? rawContext
        : undefined;
    ids.add(id);
    const openWeights = openWeightsOf(row);
    models.push({
      id,
      label,
      contextWindow,
      anthropic:
        (row.type === 'model' && typeof row.display_name === 'string') ||
        /(^|[/.-])claude/i.test(id),
      ...(openWeights === undefined ? {} : { openWeights }),
    });
    // A sanity bound well past any catalog seen (Requesty lists ~755); the
    // 4 MiB body cap binds first. Rows past it are dropped silently.
    if (models.length === MODEL_GATEWAY_MAX_DISCOVERED_MODELS) break;
  }
  return models;
}

/** Preserve a configured model's ID and overrides when rediscovered. */
export function suggestGatewayModel(
  discovered: DiscoveredGatewayModel,
  existing: readonly ModelGatewayModel[],
  ownerId: string,
): ModelGatewayModel {
  const configured = existing.find(
    (model) => model.gatewayId === discovered.id,
  );
  if (configured) return configured;
  return suggestNewGatewayModel(
    discovered,
    new Set(existing.map((model) => model.id)),
    new Set(existing.map((model) => model.label.toLowerCase())),
    ownerId,
  );
}

/**
 * Suggested settings for each discovered model `existing` doesn't have yet,
 * with IDs and labels unique among themselves as well as `existing`. Linear
 * in the list, so a whole discovered catalog stays cheap.
 */
export function suggestNewGatewayModels(
  discovered: readonly DiscoveredGatewayModel[],
  existing: readonly ModelGatewayModel[],
  ownerId: string,
): ModelGatewayModel[] {
  const configured = new Set(existing.map((model) => model.gatewayId));
  const ids = new Set(existing.map((model) => model.id));
  const labels = new Set(existing.map((model) => model.label.toLowerCase()));
  const suggestions: ModelGatewayModel[] = [];
  for (const model of discovered) {
    if (configured.has(model.id)) continue;
    const suggestion = suggestNewGatewayModel(model, ids, labels, ownerId);
    ids.add(suggestion.id);
    labels.add(suggestion.label.toLowerCase());
    suggestions.push(suggestion);
  }
  return suggestions;
}

function suggestNewGatewayModel(
  discovered: DiscoveredGatewayModel,
  ids: ReadonlySet<string>,
  labels: ReadonlySet<string>,
  ownerId: string,
): ModelGatewayModel {
  const slug =
    discovered.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model';
  const prefix = `${ownerId}-`;
  const stem = `${prefix}${slug}`.slice(0, MODEL_GATEWAY_MAX_ID_LENGTH);
  let id = stem;
  let label = discovered.label;
  for (
    let suffix = 2;
    ids.has(id) || labels.has(label.toLowerCase());
    suffix++
  ) {
    const ending = `-${suffix}`;
    id = stem.slice(0, MODEL_GATEWAY_MAX_ID_LENGTH - ending.length) + ending;
    label =
      discovered.label.slice(
        0,
        MODEL_GATEWAY_MAX_LABEL_LENGTH - ending.length,
      ) + ending;
  }
  const harness =
    discovered.anthropic || /claude/i.test(discovered.id) ? 'claude' : 'codex';
  return {
    id,
    gatewayId: discovered.id,
    label,
    harness,
    contextWindow:
      discovered.contextWindow !== undefined &&
      Number.isSafeInteger(discovered.contextWindow) &&
      discovered.contextWindow > 0
        ? discovered.contextWindow
        : 200_000,
    supportedThinkingLevels:
      harness === 'claude'
        ? ['off', 'low', 'medium', 'high']
        : ['off', 'low', 'medium', 'high', 'xhigh'],
    toolSchemaProfile: 'standard',
  };
}
export function gatewayHostname(baseUrl: string): string {
  const normalized = normalizeModelGatewayBaseUrl(baseUrl);
  return normalized === null ? '' : new URL(normalized).hostname;
}
