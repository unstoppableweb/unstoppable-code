import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  OLLAMA_MODELS,
  clampThinkingLevelForModel,
  getEffectiveSupportedThinkingLevelsForModel,
  getProviderForModel,
  normalizeThinkingForProvider,
  requireProviderForModel,
  type ThinkingLevel,
} from '../types';

/**
 * Selection rules shared by {@link ModelThinkingPreferenceRow} and the App
 * Advisor actions that save the same model-and-thinking preferences, so both
 * paths accept the same models and thinking levels.
 */

/**
 * Whether a model is one of the Claude, Codex, or (when included) Ollama
 * options the preference row offers. Cursor options are offered only by rows
 * that opt in and depend on the live Cursor runtime, so callers check them.
 */
export function isNativeModelPreferenceOption(
  model: string,
  includeOllama: boolean,
): boolean {
  return (
    CLAUDE_MODELS.includes(model) ||
    CODEX_MODELS.includes(model) ||
    (includeOllama && OLLAMA_MODELS.includes(model))
  );
}

/** Thinking levels the preference row offers for an available model. */
export function getModelPreferenceThinkingLevels(
  model: string,
): readonly ThinkingLevel[] {
  // Preferences can retain a removed model id; Claude is only this row's
  // explicit display fallback.
  const provider = getProviderForModel(model) ?? 'claude';
  return getEffectiveSupportedThinkingLevelsForModel(model, false, provider);
}

/**
 * The thinking level saved with a newly chosen model: the saved level clamped
 * to what the model supports. A model with no thinking levels (Cursor) has
 * nothing to clamp into, so the saved level is kept and a later switch back to
 * Claude or Codex does not land on "off". The model must be registered.
 */
export function thinkingLevelForChosenModel(
  model: string,
  savedThinkingLevel: ThinkingLevel,
): ThinkingLevel {
  const provider = requireProviderForModel(model);
  return getEffectiveSupportedThinkingLevelsForModel(model, false, provider)
    .length === 0
    ? savedThinkingLevel
    : clampThinkingLevelForModel(
        normalizeThinkingForProvider(savedThinkingLevel, provider),
        model,
        provider,
      );
}
