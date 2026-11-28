import { normalizeCodexMaxConcurrentSubagents } from '@canopy/protocol/preferences';
import { isCodexConfig, type CodexConfig } from './codex-model-config';

export { normalizeCodexMaxConcurrentSubagents };

/** Apply desktop policy after provider config, preserving unrelated agent roles. */
export function applyCodexMultiAgentConfig(
  base: CodexConfig,
  options: { enabled?: boolean; maxConcurrentSubagents?: number | null },
): CodexConfig {
  const config = { ...base };
  if (typeof options.enabled === 'boolean') {
    // Mixed dotted/nested inputs must not override the desktop's choice.
    delete config['features.multi_agent'];
    delete config['features.multi_agent_v2'];
    delete config['agents.enabled'];
    config.features = {
      ...(isCodexConfig(config.features) ? config.features : {}),
      multi_agent: options.enabled,
      multi_agent_v2: options.enabled,
    };
    config.agents = {
      ...(isCodexConfig(config.agents) ? config.agents : {}),
      enabled: options.enabled,
    };
  }
  if (options.maxConcurrentSubagents !== undefined) {
    const agents = { ...(isCodexConfig(config.agents) ? config.agents : {}) };
    delete config['agents.max_threads'];
    delete config['agents.max_concurrent_threads_per_session'];
    delete agents.max_threads;
    delete agents.max_concurrent_threads_per_session;
    const limit = normalizeCodexMaxConcurrentSubagents(
      options.maxConcurrentSubagents,
    );
    if (limit !== null) agents.max_concurrent_threads_per_session = limit;
    if (Object.keys(agents).length > 0) config.agents = agents;
    else delete config.agents;
  }
  return config;
}
