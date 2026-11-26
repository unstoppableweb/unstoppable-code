import type { CodexSpeed } from './automations';
import type { ThinkingLevel } from './thinking';

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
