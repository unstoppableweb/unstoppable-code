import {
  applyCodexMultiAgentConfig,
  normalizeCodexMaxConcurrentSubagents,
} from '@canopy/execution-engine/lib/codex-multi-agent';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { type CodexConfig } from '@canopy/execution-engine/lib/codex-model-config';
import { CODEX_PROJECT_DOC_THREAD_CONFIG } from '../codex-runtime/thread-config';

/**
 * Project the desktop pipeline multi-agent preference into the thread-scoped
 * Codex configuration used by both Electron and CLI pipeline runners.
 *
 * The preference environment variable is absent for CLI-native executions
 * that were not launched or resumed by the desktop app. In that case Codex's
 * canonical feature configuration remains authoritative.
 */
export function buildCodexPipelineThreadConfig(
  environment: Record<string, string | undefined>,
  baseConfig?: CodexConfig,
): CodexConfig {
  const rawMultiAgentPreference = getBrandEnv(
    environment,
    'PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED',
  );
  const multiAgentEnabled =
    rawMultiAgentPreference === 'true'
      ? true
      : rawMultiAgentPreference === 'false'
        ? false
        : undefined;
  const rawLimit = getBrandEnv(
    environment,
    'PREF_CODEX_MAX_CONCURRENT_SUBAGENTS',
  );
  const config = applyCodexMultiAgentConfig(baseConfig ?? {}, {
    enabled: multiAgentEnabled,
    maxConcurrentSubagents:
      rawLimit === undefined
        ? undefined
        : normalizeCodexMaxConcurrentSubagents(Number(rawLimit)),
  });

  // Both runners send this config on start and resume alike.
  return { ...config, ...CODEX_PROJECT_DOC_THREAD_CONFIG };
}
