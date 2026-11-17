import { isSyntacticallyValidModelId } from './model-id';
import { THINKING_LEVELS, type ThinkingLevel } from '@canopy/protocol/thinking';

/** Models advertised by the signed-in personal Google account. */
export interface AntigravityModelEntry {
  id: string;
  rawModelId: string;
  label: string;
  supportedThinkingLevels: ThinkingLevel[];
}

const PREFIX = 'antigravity:';

export function toAntigravityModelId(raw: string): string {
  const id = `${PREFIX}${encodeURIComponent(raw)}`;
  if (!isSyntacticallyValidModelId(raw) || !isSyntacticallyValidModelId(id))
    throw new Error('Invalid Google model identifier.');
  return id;
}

export function getRawAntigravityModelId(id: string): string | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  try {
    const raw = decodeURIComponent(id.slice(PREFIX.length));
    return toAntigravityModelId(raw) === id ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function isAntigravityModel(value: unknown): value is string {
  return (
    typeof value === 'string' && getRawAntigravityModelId(value) !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** A select option's runtime-confirmed value and its declared choices. */
interface AntigravitySelect {
  currentValue: string | undefined;
  values: string[];
}

// Strict by design for the pinned 1.5.1 shape: flat select options. ACP also
// allows grouped options; check this parser when the runtime pin changes.
function antigravitySelect(
  value: unknown,
  id: string,
): AntigravitySelect | undefined {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('Google did not return session settings.');
  const options: unknown[] = value;
  const option = options.map(record).find((entry) => entry.id === id);
  if (!option) return undefined;
  if (
    option.type !== 'select' ||
    !Array.isArray(option.options) ||
    option.options.length > 1000
  )
    throw new Error('Google returned invalid session settings.');
  const choices: unknown[] = option.options;
  const values: string[] = [];
  for (const choice of choices) {
    const value = record(choice).value;
    if (typeof value !== 'string')
      throw new Error('Google returned invalid session settings.');
    values.push(value);
  }
  return {
    currentValue:
      typeof option.currentValue === 'string' ? option.currentValue : undefined,
    values,
  };
}

/**
 * The live state the runtime reports after a configuration change. Thinking
 * levels belong to the selected model: `undefined` means the model has no
 * thinking control, which differs from a control that lacks a level.
 */
export interface AntigravityLiveConfig {
  model: string | undefined;
  thinkingLevels: ThinkingLevel[] | undefined;
  thinkingLevel: string | undefined;
  mode: string | undefined;
  modes: string[];
}

export function antigravityLiveConfig(value: unknown): AntigravityLiveConfig {
  const model = antigravitySelect(value, 'model');
  if (!model) throw new Error('Google did not return session settings.');
  const thought = antigravitySelect(value, 'thought_level');
  const mode = antigravitySelect(value, 'mode');
  return {
    model: model.currentValue,
    thinkingLevels: thought
      ? THINKING_LEVELS.filter((level) => thought.values.includes(level))
      : undefined,
    thinkingLevel: thought?.currentValue,
    mode: mode?.currentValue,
    modes: mode?.values ?? [],
  };
}

/**
 * Lists the session's models. ACP is validated at the boundary; the browser
 * never imports the SDK. `supportedThinkingLevels` is always empty here,
 * which does not mean "no thinking control": levels come only from a
 * per-model probe or `antigravityLiveConfig`.
 */
export function antigravityModelsFromConfig(
  value: unknown,
): AntigravityModelEntry[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('Google did not return a model catalog.');
  const configs: unknown[] = value;
  const model = configs.map(record).find((option) => option.id === 'model');
  if (
    !model ||
    model.type !== 'select' ||
    !Array.isArray(model.options) ||
    model.options.length > 1000
  )
    throw new Error('Google did not return a model catalog.');
  const candidates: unknown[] = model.options;
  const seen = new Set<string>();
  const entries: AntigravityModelEntry[] = [];
  for (const candidate of candidates) {
    const option = record(candidate);
    if (typeof option.value !== 'string' || typeof option.name !== 'string')
      throw new Error('Google returned invalid model metadata.');
    // This integration initially exposes Google models on personal subscriptions.
    if (!option.value.startsWith('gemini-')) continue;
    const id = toAntigravityModelId(option.value);
    const label = option.name.trim();
    if (
      !label ||
      label.length > 256 ||
      Array.from(label).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      seen.has(id)
    )
      throw new Error('Google returned invalid model metadata.');
    seen.add(id);
    entries.push({
      id,
      rawModelId: option.value,
      label,
      // Thinking levels are per model. The session's thought_level option
      // describes only its current model, so callers fill this from a
      // per-model probe (`antigravityLiveConfig`) rather than copying it.
      supportedThinkingLevels: [],
    });
  }
  return entries;
}
