import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  type ChatModel,
  type ClaudeModel,
  type CodexModel,
} from '../chat-models';
import type { McpHttpAuthHandler } from '../mcp-servers';
import { DEFAULT_SIDEBAR_WIDTH_PX } from '../ui-layout';
import type { ActivationQuietHours, ChatEnrichmentMode } from './types';

export const DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE: ChatEnrichmentMode =
  'replace';
export const DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE: ChatEnrichmentMode = 'hover';

export const DEFAULT_VOICE_DICTATION_ENABLED = true;
/** OS focus shortcut is opt-in: the checklist or Settings turns it on (CAN-1963). */
export const DEFAULT_GLOBAL_FOCUS_SHORTCUT_ENABLED = false;
export const DEFAULT_MAX_ACTIVE_CHAT_TURNS = 10;
export const DEFAULT_CLAUDE_MAX_TURNS = 500;
export const CLAUDE_MAX_TURNS_MIN = 1;
export const CLAUDE_MAX_TURNS_MAX = 9999;

/** Missing or invalid values retain the default; null explicitly removes the cap. */
export function normalizeClaudeMaxTurns(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CLAUDE_MAX_TURNS_MIN &&
    value <= CLAUDE_MAX_TURNS_MAX
    ? value
    : DEFAULT_CLAUDE_MAX_TURNS;
}
export const DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS = 5;
export const BYTES_PER_GIB = 1024 * 1024 * 1024;
export const DEFAULT_MEMORY_PRESSURE_GUARD_ENABLED = false;
export const DEFAULT_MEMORY_DIAGNOSTICS_ENABLED = false;
export const DEFAULT_BYPASS_CODEX_APP_SERVER_IDLE_TIMEOUT_UNDER_CRITICAL_PRESSURE = true;
export const DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES =
  2 * BYTES_PER_GIB;
export const DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES =
  4 * BYTES_PER_GIB;

/**
 * Unified sidebar width bounds, shared by the main-process preference
 * normalizer and the renderer store so the two cannot drift.
 *
 * `DEFAULT_SIDEBAR_WIDTH` was previously an alias for `SIDEBAR_MIN_WIDTH`,
 * which opened every new install at the narrowest supported width. It is now
 * deliberately clear of the floor. Raising it only affects installs with no
 * persisted `sidebarWidth`; 220 remains a legal width that users can drag back
 * to, so layout must still work there.
 */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
// Shared with the web rail through the protocol package so the two cannot drift.
export const DEFAULT_SIDEBAR_WIDTH = DEFAULT_SIDEBAR_WIDTH_PX;

export const DEFAULT_ACTIVATION_QUIET_HOURS: ActivationQuietHours = {
  enabled: true,
  startHour: 22,
  endHour: 8,
};

/**
 * Default HTTP MCP auth handler when no per-server override is set. Canopy
 * owns auth/proxy routing by default; users can opt individual servers into
 * provider-side handling.
 */
export const DEFAULT_MCP_HTTP_AUTH_HANDLER: McpHttpAuthHandler = 'canopy';

export const DEFAULT_OLLAMA_SERVER_PORT = 11534;

export const DEFAULT_MCP_PROXY_PORT = 37645;

export const DEFAULT_HIDE_ANTHROPIC_NAV = true;

export const DEFAULT_CLAUDE_SESSION_IDLE_TIMEOUT_MINUTES = 10;

export const DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES = 10;

/** @deprecated Use DEFAULT_CLAUDE_MODEL instead. Kept as alias during rollout. */
export const DEFAULT_MODEL: ClaudeModel = DEFAULT_CLAUDE_MODEL;
/** Gateway-routable fallback for Codex calls without native authentication. */
export const DEFAULT_CREDITS_CODEX_MODEL: CodexModel = 'gpt-6-luna';
/** Preferred chat description model; see desktop-shared `defaultSummaryModel`. */
export const DEFAULT_SUMMARY_MODEL: ChatModel = 'gpt-6-luna';
export const DEFAULT_HANDOFF_SUMMARY_MODEL: ChatModel = 'haiku';
/** Chat description default when the Codex model is not available (Sonnet 5.5). */
export const DEFAULT_SUMMARY_FALLBACK_MODEL: ChatModel = 'sonnet';
/** Preferred local memory model; see desktop-shared `defaultLocalMemoryModel`. */
export const DEFAULT_LOCAL_MEMORY_MODEL: ChatModel = 'gpt-6.1-sol';
/** Local memory default when the Codex model is not available (Opus 5.5). */
export const DEFAULT_LOCAL_MEMORY_FALLBACK_MODEL: ChatModel =
  DEFAULT_CLAUDE_MODEL;
export const DEFAULT_BRANCH_NAMING_MODEL: ChatModel = 'haiku';
export const DEFAULT_COMMIT_GENERATION_MODEL: ChatModel = 'sonnet';
export const DEFAULT_PR_GENERATION_MODEL: ChatModel = 'sonnet';
/**
 * Default Pipeline Advisor model. Typed as `ChatModel` (a string alias) so it
 * agrees with the `pipelineAdvisorModel` field on `PreferencesData`. The
 * backend rejects any non-Claude/non-Codex value (including Ollama models) and
 * substitutes this default at load time.
 */
export const DEFAULT_PIPELINE_ADVISOR_MODEL: ChatModel = DEFAULT_CODEX_MODEL;

/**
 * Default model used by the App Advisor (the local Canopy assistant). Typed
 * as `ChatModel` so it can be persisted in {@link PreferencesData} alongside
 * every other model preference. Aliased to {@link DEFAULT_CODEX_MODEL} so
 * Canopy's flagship Codex model is the default until the user changes it.
 */
export const DEFAULT_APP_ADVISOR_MODEL: ChatModel = DEFAULT_CODEX_MODEL;
export const DEFAULT_CRON_GENERATION_MODEL: ChatModel = DEFAULT_CODEX_MODEL;
export const DEFAULT_IF_COMMAND_GENERATION_MODEL: ChatModel =
  DEFAULT_CODEX_MODEL;
