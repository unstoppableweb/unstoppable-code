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

/** ACP is validated at the boundary; the browser never imports the SDK. */
export function antigravityModelsFromConfig(
  value: unknown,
): AntigravityModelEntry[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('Google did not return a model catalog.');
  const configs: unknown[] = value;
  const model = configs.map(record).find((option) => option.id === 'model');
  const thought = configs
    .map(record)
    .find((option) => option.id === 'thought_level');
  if (
    !model ||
    model.type !== 'select' ||
    !Array.isArray(model.options) ||
    model.options.length > 1000
  )
    throw new Error('Google did not return a model catalog.');
  const thoughtOptions: unknown[] = Array.isArray(thought?.options)
    ? thought.options
    : [];
  const levels = THINKING_LEVELS.filter((level) =>
    thoughtOptions.some((option) => record(option).value === level),
  );
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
      supportedThinkingLevels: [...levels],
    });
  }
  return entries;
}
