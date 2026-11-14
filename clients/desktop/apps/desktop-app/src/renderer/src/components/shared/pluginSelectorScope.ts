import type { PluginProviderSupport } from '@canopy/execution-engine/types/plugins';

/**
 * Provider scope for a plugin picker.
 *
 * - `claude`: the picker is bound to a Claude session. Only Claude-native
 *   plugins are selectable; Codex-only plugins disable with the
 *   `Only available for Codex` tooltip.
 * - `codex`: the picker is bound to a Codex session. Claude-only plugins
 *   render with the amber compatibility marker but remain selectable.
 * - `ollama`: today's Ollama sessions reuse the Claude resolver path;
 *   selection rules mirror `'claude'`. Codex-only plugins are disabled.
 * - `cursor`: the picker is bound to a local Cursor chat. Cursor loads the
 *   MCP servers a plugin or standalone connection declares, and the skills
 *   and commands the selection carries from the chat's private Cursor root,
 *   so every plugin, skill, and Collection row stays selectable.
 * - `mixed`: no provider preference. Every plugin row is enabled and the
 *   provider icons (with amber marker when applicable) are rendered for
 *   display purposes only.
 */
export type PluginSelectorProviderScope =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'copilot'
  | 'antigravity'
  | 'opencode'
  | 'mixed';

/**
 * Decide whether a plugin row is selectable under a given provider scope.
 *
 * Returns `null` when the row is fully supported; otherwise a string tooltip
 * explaining why the row should be marked `unsupported`.
 *
 * Selection rules (Phase F5):
 * - `codex`: allow plugins where `providerSupport.codex !== 'none'`
 *   (Codex-native or Claude-derived compatibility).
 * - `claude` / `ollama`: only Claude-native plugins are selectable.
 *   Ollama sessions today reuse the Claude resolver path, so this branch is
 *   intentionally shared. If a future Ollama-specific provider scope is
 *   introduced, give it its own branch — do not silently widen this case.
 * - `mixed` (and `undefined`): every row is enabled.
 */
export function getUnsupportedReason(
  support: PluginProviderSupport | undefined,
  scope: PluginSelectorProviderScope,
): string | null {
  if (!support) return null;
  if (
    scope === 'mixed' ||
    scope === 'cursor' ||
    scope === 'copilot' ||
    scope === 'opencode'
  )
    return null;
  if (scope === 'codex') {
    if (support.codex !== 'none') return null;
    return 'Only available for Claude';
  }
  // `claude` and `ollama` share the same rule: Claude-native required.
  if (support.claude === 'native') return null;
  return 'Only available for Codex';
}
