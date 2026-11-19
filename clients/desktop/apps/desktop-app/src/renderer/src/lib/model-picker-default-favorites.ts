/**
 * Favorites a first-run user starts with in the harness model picker, as
 * stored `harness::modelId` keys. Ids missing from the live catalog are
 * skipped, and the list is ignored once the user saves favorites (even an
 * empty list).
 */
export const DEFAULT_MODEL_PICKER_FAVORITES: readonly string[] = [
  'claude::claude-fable-5-1',
  'claude::opus[1m]',
  'codex::gpt-6.2-astra',
  'codex::gpt-6.2-sol',
  'codex::deepseek-v4-pro',
  'codex::kimi-k3',
  'codex::glm-5.3',
];
