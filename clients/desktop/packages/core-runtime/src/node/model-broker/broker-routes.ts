// Request shapes the loopback broker accepts for Claude and Codex harness
// children, shared by every route that sends their model traffic somewhere
// other than the native provider: AI Credits, organization gateways, and the
// account proxy.

/** Child placeholder; daemon routes also require a separate route capability. */
export const LOOPBACK_BROKER_AUTH_TOKEN = 'canopy-loopback-broker';

/** Daemon routes require a separate capability; the placeholder is not one. */
export const LOOPBACK_BROKER_SECRET_HEADER = 'x-canopy-broker-secret';
export const LOOPBACK_BROKER_SECRET_ENV = 'CANOPY_MODEL_BROKER_SECRET';

/** Claude SDK request headers a brokered route passes upstream. */
export const CLAUDE_BROKER_FORWARD_HEADERS = [
  'anthropic-beta',
  'anthropic-version',
  'user-agent',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
] as const;
export const CLAUDE_BROKER_ALLOWED_PATHS = [
  '/v1/messages',
  '/v1/messages/count_tokens',
] as const;
export const CLAUDE_BROKER_ALLOWED_QUERIES = ['beta=true'] as const;
export const CODEX_BROKER_ALLOWED_PATHS = ['/responses'] as const;

/**
 * The Cloud's managed-inference base URL for one harness. The Codex trailing
 * `/responses` is not redundant: the app-server appends its own `/responses`,
 * and the hosted route allowlists `.../openai/responses/responses`.
 */
export function buildAiCreditsProxyBaseUrl(
  cloudBaseUrl: string,
  harness: 'claude' | 'codex',
): string {
  const base = cloudBaseUrl.replace(/\/+$/, '');
  return harness === 'claude'
    ? `${base}/api/v1/llm-proxy/anthropic`
    : `${base}/api/v1/llm-proxy/openai/responses`;
}
