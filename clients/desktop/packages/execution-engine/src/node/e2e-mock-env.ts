/**
 * Shared resolution of the UI-automation mock-LLM redirect for every Claude
 * SDK consumer (interactive chat sessions, one-shot summary helpers, the
 * Claude-compatible invocation resolver, and pipeline step subprocess env).
 * Centralizing the env triple keeps the redirect contract — trimming, the
 * `CANOPY_MOCK_API_KEY` bearer, and the exact `ANTHROPIC_*` keys — from
 * drifting between hand-rolled copies.
 *
 * The gate lives inside the function body: bundlers substitute the build-time
 * `__CANOPY_E2E__` constant, fold the branch away, and strip every mock
 * string literal from production builds, so a runtime env var can never
 * activate the redirect in a shipped app. The `typeof` guard keeps the
 * function safe in plain-Node contexts where the constant is not injected
 * (dev CLI via tsx, test subprocesses).
 */
export function resolveAnthropicMockEnvOverride():
  | Record<string, string>
  | undefined {
  if (typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__) {
    const baseUrl = process.env.CANOPY_MOCK_LLM_BASE_URL?.trim();
    if (baseUrl) {
      const apiKey = process.env.CANOPY_MOCK_API_KEY ?? 'mock';
      return {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_API_KEY: apiKey,
      };
    }
  }
  return undefined;
}

export interface CodexMockAppServerOverride {
  env: Record<string, string>;
  configArgs: string[];
}

/** E2E-only Codex app-server provider redirect without changing user state. */
export function resolveCodexMockAppServerOverride(
  nativeOpenAI = false,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CodexMockAppServerOverride | undefined {
  if (typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__) {
    // In-process callers still use the app's environment; daemon callers
    // carry the admitted launch's override, which wins over daemon globals.
    const effectiveEnvironment = { ...process.env, ...environment };
    // Routing acceptance tests keep control-plane fixtures but exercise the
    // normal credits broker instead of replacing prepareInvocation entirely.
    if (effectiveEnvironment.CANOPY_E2E_CODEX_REAL_ROUTING === '1')
      return undefined;
    const rawBaseUrl = effectiveEnvironment.CANOPY_MOCK_LLM_BASE_URL?.trim();
    if (rawBaseUrl) {
      const baseUrl = `${rawBaseUrl.replace(/\/+$/, '')}/v1`;
      if (nativeOpenAI) {
        // Keep the builtin OpenAI provider and its auth semantics. This
        // replaces transport only, after the real route has been selected;
        // it is lifecycle evidence, never native-profile qualification.
        return {
          env: {
            OPENAI_BASE_URL: baseUrl,
            OPENAI_API_KEY: effectiveEnvironment.CANOPY_MOCK_API_KEY ?? 'mock',
          },
          configArgs: [
            '-c',
            // Built-in provider IDs are reserved by the pinned Codex runtime.
            `openai_base_url=${JSON.stringify(baseUrl)}`,
          ],
        };
      }
      const providerId = 'canopy-mock';
      const overrides: Record<string, string> = {
        [`model_providers.${providerId}.name`]: 'Canopy Mock',
        [`model_providers.${providerId}.base_url`]: baseUrl,
        [`model_providers.${providerId}.wire_api`]: 'responses',
        [`model_providers.${providerId}.requires_openai_auth`]: 'false',
        [`model_providers.${providerId}.env_key`]: 'CANOPY_MOCK_API_KEY',
        model_provider: providerId,
      };
      return {
        env: {
          CANOPY_MOCK_API_KEY:
            effectiveEnvironment.CANOPY_MOCK_API_KEY ?? 'mock',
        },
        configArgs: Object.entries(overrides).flatMap(([key, value]) => [
          '-c',
          `${key}=${value}`,
        ]),
      };
    }
  }
  return undefined;
}

/** Forward a launch-specific transport seam only after native admission. */
export function resolvePipelineMockEnvOverride(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> | undefined {
  if (typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__) {
    const baseUrl = environment.CANOPY_MOCK_LLM_BASE_URL?.trim();
    if (baseUrl) {
      const apiKey = environment.CANOPY_MOCK_API_KEY ?? 'mock';
      return {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_API_KEY: apiKey,
        CANOPY_MOCK_LLM_BASE_URL: baseUrl,
        CANOPY_MOCK_API_KEY: apiKey,
        ...(environment.CANOPY_E2E_CODEX_REAL_ROUTING === '1' && {
          CANOPY_E2E_CODEX_REAL_ROUTING: '1',
        }),
      };
    }
  }
  return undefined;
}
