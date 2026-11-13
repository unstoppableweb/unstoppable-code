import { normalizeModelGatewayBaseUrl } from '../canopy-server';

export type AiGatewayPresetId =
  | 'openrouter'
  | 'vercel'
  | 'requesty'
  | 'litellm';

/**
 * A well-known gateway offered as a one-click setup tile. Nothing stores the
 * preset: a saved gateway is recognized from its base URL alone.
 */
export interface AiGatewayPreset {
  readonly id: AiGatewayPresetId;
  readonly name: string;
  /** Shorter brand used in "Get a key from …" and failure copy; defaults to `name`. */
  readonly shortName?: string;
  /** Null when the user supplies the URL (self-hosted). */
  readonly baseUrl: string | null;
  readonly urlPlaceholder?: string;
  readonly keyUrl: string;
  /** Hostnames recognized as this gateway, including regional hosts. */
  readonly hosts: readonly string[];
  /** Normalized path that must match exactly: '/api' or ''. */
  readonly path: string;
  /** 'openai' gateways answer `anthropic-version` with a truncated Anthropic page. */
  readonly discoveryFormat: 'openai' | 'any';
  /** Exact gateway IDs preselected on first setup, intersected with discovery. */
  readonly suggestedModelIds: readonly string[];
}

// Suggested IDs were verified live on 2026-11-10: three tiers each from
// Claude and OpenAI. Luna has no 6.1 release yet. Refresh them when model
// generations change; a retired ID silently drops out of the intersection.
export const AI_GATEWAY_PRESETS: readonly AiGatewayPreset[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    keyUrl: 'https://openrouter.ai/settings/keys',
    hosts: ['openrouter.ai'],
    path: '/api',
    discoveryFormat: 'openai',
    suggestedModelIds: [
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-haiku-5.5',
      'openai/gpt-6.1-sol',
      'openai/gpt-6.1-terra',
      'openai/gpt-6-luna',
    ],
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    shortName: 'Vercel',
    baseUrl: 'https://ai-gateway.vercel.sh',
    keyUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys',
    hosts: ['ai-gateway.vercel.sh'],
    path: '',
    discoveryFormat: 'any',
    suggestedModelIds: [
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-haiku-5.5',
      'openai/gpt-6.1-sol',
      'openai/gpt-6.1-terra',
      'openai/gpt-6-luna',
    ],
  },
  {
    id: 'requesty',
    name: 'Requesty',
    baseUrl: 'https://router.requesty.ai',
    keyUrl: 'https://app.requesty.ai/api-keys',
    hosts: [
      'router.requesty.ai',
      'router.eu.requesty.ai',
      'router.us.requesty.ai',
      'router.ap.requesty.ai',
    ],
    path: '',
    discoveryFormat: 'any',
    suggestedModelIds: [
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-haiku-5-5',
      'openai/gpt-6.1-sol',
      'openai/gpt-6.1-terra',
      'openai/gpt-6-luna',
    ],
  },
  {
    id: 'litellm',
    name: 'LiteLLM',
    baseUrl: null,
    urlPlaceholder: 'https://litellm.example.com',
    keyUrl: 'https://docs.litellm.ai/docs/proxy/virtual_keys',
    hosts: [],
    path: '',
    discoveryFormat: 'any',
    suggestedModelIds: [],
  },
];

/**
 * Recognize a hosted preset from a base URL. Never throws and never rewrites
 * the URL; self-hosted presets have no hosts, so they never match.
 */
export function matchAiGatewayPreset(
  baseUrl: string | null | undefined,
): AiGatewayPreset | null {
  const normalized = normalizeModelGatewayBaseUrl(baseUrl);
  if (normalized === null) return null;
  const url = new URL(normalized);
  const path = url.pathname.replace(/\/+$/, '');
  return (
    AI_GATEWAY_PRESETS.find(
      (preset) => preset.hosts.includes(url.hostname) && preset.path === path,
    ) ?? null
  );
}
