import { isCodexSpeed, type CodexSpeed } from './automations';
import { isThinkingLevel, type ThinkingLevel } from './thinking';

/** What a person chooses; resolved per model and route at thread start. */
export type CodexContextWindowSetting =
  | 'model-default'
  | 'standard-pricing'
  | 'maximum'
  | number;

export interface AgentModelConfig {
  thinkingLevel?: ThinkingLevel;
  /**
   * Requested Codex speed; the source of truth when present. Canonical writes
   * pair it with the derived `fastMode` (see execution-engine
   * `lib/codex-speed.ts`).
   */
  speed?: CodexSpeed;
  /**
   * Legacy compatibility projection, always `speed === 'fast'` on canonical
   * writes and never `true` for `ultrafast`. Read only as a fallback when
   * `speed` is absent. An explicit boolean command without `speed` replaces
   * the speed (true → Fast, false → Regular).
   */
  fastMode?: boolean;
  /**
   * Requested Codex context window. Absent uses the provider default, then
   * the model's own window (execution-engine `lib/codex-context-window.ts`).
   */
  contextWindow?: CodexContextWindowSetting;
}

/** The smallest custom window Canopy sends. Codex itself sets none. */
export const CODEX_CONTEXT_WINDOW_FLOOR = 128_000;

export function isCodexContextWindowSetting(
  value: unknown,
): value is CodexContextWindowSetting {
  return (
    value === 'model-default' ||
    value === 'standard-pricing' ||
    value === 'maximum' ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= CODEX_CONTEXT_WINDOW_FLOOR)
  );
}

/** Legacy boolean projection of a speed: only Fast maps to `true`. */
export function codexSpeedFastMode(speed: CodexSpeed): boolean {
  return speed === 'fast';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeAgentModelConfig(
  value: unknown,
): AgentModelConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const config: AgentModelConfig = {};
  if (
    typeof value.thinkingLevel === 'string' &&
    isThinkingLevel(value.thinkingLevel)
  ) {
    config.thinkingLevel = value.thinkingLevel;
  }
  if (isCodexSpeed(value.speed)) {
    // A valid speed is authoritative; the boolean is re-derived so a
    // persisted Ultra fast record can never project `fastMode: true`.
    config.speed = value.speed;
    config.fastMode = codexSpeedFastMode(value.speed);
  } else if (typeof value.fastMode === 'boolean') {
    // Legacy read: an invalid or missing speed falls back to the boolean.
    config.fastMode = value.fastMode;
  }
  if (isCodexContextWindowSetting(value.contextWindow)) {
    config.contextWindow = value.contextWindow;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}
